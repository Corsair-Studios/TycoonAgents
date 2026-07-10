import * as vscode from 'vscode';
import { themeDirectoryUri, themeReviewUri } from './themeStorage';
import { withoutRedundantBuildableObjectsItem } from './themeGenerationState';

export type ThemeImageKind =
  | 'character_atlas'
  | 'rival_atlas'
  | 'environment'
  | 'object_atlas'
  | 'background_decor_atlas'
  | 'expression_atlas'
  | 'achievement_atlas'
  | 'emote_atlas';
export type ThemeImageReviewStatus = 'pending' | 'accepted' | 'rejected';

export interface ThemeImageGenerationError {
  provider: 'openai';
  code?: string;
  message: string;
  request_id?: string;
  moderation_stage?: string;
  categories?: string[];
}

/**
 * v2 object pipeline: TWO fixed-shape 4x5 (20-cell) boards, keyed `objects_01`
 * (board 1) and `objects_02` (board 2) — see themeAssetPrompts.ts's
 * createObjectBoard1Rows / createObjectBoard2Rows.
 *   - Board 1's `object_rows` array is exactly 20 `object_static` entries, one
 *     per cell in row-major order (Cell 1..20), each a single-frame object.
 *   - Board 2's `object_rows` array is exactly 4 entries in this fixed order:
 *     [object_anim, object_anim, poof, crate]. `object_anim` #1 occupies row 1
 *     (cells 1-4, 4 frames) and #2 occupies row 2 (cells 5-8, 4 frames); `poof`
 *     occupies cells 9-15 (7 frames, spanning row 3 and the first three cells of
 *     row 4); cells 16-19 are unused blank padding; `crate` is the single last
 *     cell (cell 20, 1 frame).
 */
export type ThemeObjectBoardRow =
  | { kind: 'object_static'; object_id: string; display_name: string; motion_hint?: string; is_ranged_rack?: boolean }
  | { kind: 'object_anim'; object_id: string; display_name: string; motion_hint?: string }
  | { kind: 'poof' }
  | { kind: 'crate' };

/**
 * One row of a 5x4 (20-cell) rival board. Each row is ONE enemy: cols 0-1 are a
 * 2-frame WALK cycle, cols 2-4 are a 3-frame ATTACK. A board carries up to four
 * such rows → four enemies; three boards cover all 12 rivals. Rival frames are
 * keyed `rival_<id>` (five frames each): [walk0, walk1, attack0, attack1, attack2].
 */
export type ThemeRivalBoardRow = { kind: 'rival'; rival_id: string; display_name: string };

/**
 * One row of the 4x4 background-decor board. Rows 1-2 carry four single-frame
 * decor cells; row 3 carries one four-frame animated decor item; row 4 is the
 * ranged-weapon-fire projectile FX (four one-shot frames → frames['projectile']).
 */
export type ThemeDecorBoardRow =
  | { kind: 'seat'; decor_id: string; display_name: string }        // row 1 cell (single frame)
  | { kind: 'decor'; decor_id: string; display_name: string }       // row 2 cell (single frame)
  | { kind: 'decor_anim'; decor_id: string; display_name: string }  // row 3 item (four frames)
  | { kind: 'projectile' };                                         // row 4 ranged-fire FX (four frames)

export interface ThemeImageReviewItem {
  id: string;
  filename: string;
  label: string;
  kind: ThemeImageKind;
  status: ThemeImageReviewStatus;
  prompt: string;
  revision: number;
  frame_keys: string[];
  subject?: string;
  object_specs?: Array<{ object_id: string; display_name: string }>;
  object_rows?: ThemeObjectBoardRow[];
  decor_rows?: ThemeDecorBoardRow[];
  rival_rows?: ThemeRivalBoardRow[];
  expression_names?: string[];
  achievement_names?: string[];
  generation_error?: ThemeImageGenerationError;
  updated_at: string;
}

export interface ThemeImageReviewDocument {
  version: 1;
  theme_id: string;
  display_name: string;
  items: ThemeImageReviewItem[];
}

export async function initializeThemeImageReviewDocument(
  globalStorageUri: vscode.Uri,
  themeId: string,
  displayName: string,
  items: Array<Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string }>,
): Promise<ThemeImageReviewDocument> {
  const now = new Date().toISOString();
  const document: ThemeImageReviewDocument = {
    version: 1,
    theme_id: themeId,
    display_name: displayName,
    items: items.map((item) => ({ ...item, updated_at: item.updated_at ?? now })),
  };
  await writeReviewDocument(globalStorageUri, document);
  return document;
}

export async function loadThemeImageReviewDocument(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<ThemeImageReviewDocument | undefined> {
  const candidates = [
    themeReviewUri(globalStorageUri, themeId),
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_image_review.json`),
  ];
  for (const uri of candidates) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as ThemeImageReviewDocument;
      if (parsed?.version === 1 && parsed.theme_id === themeId && Array.isArray(parsed.items)) {
        parsed.items = withoutRedundantBuildableObjectsItem(parsed.items);
        return parsed;
      }
    } catch {
      // Try the legacy flat-storage location next.
    }
  }
  return undefined;
}

export async function upsertThemeImageReviewItem(
  globalStorageUri: vscode.Uri,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string },
): Promise<ThemeImageReviewDocument> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId) ?? {
    version: 1 as const,
    theme_id: themeId,
    display_name: displayName,
    items: [],
  };
  document.display_name = displayName;
  const nextItem: ThemeImageReviewItem = {
    ...item,
    updated_at: item.updated_at ?? new Date().toISOString(),
  };
  const index = document.items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) document.items[index] = nextItem;
  else document.items.push(nextItem);
  await writeReviewDocument(globalStorageUri, document);
  return document;
}

export async function setThemeImageReviewStatus(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  status: ThemeImageReviewStatus,
): Promise<ThemeImageReviewDocument | undefined> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  if (!document) return undefined;
  const item = document.items.find((candidate) => candidate.id === itemId);
  if (!item) return undefined;
  item.status = status;
  item.updated_at = new Date().toISOString();
  await writeReviewDocument(globalStorageUri, document);
  return document;
}

export async function setThemeImageGenerationError(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  generationError: ThemeImageGenerationError,
): Promise<ThemeImageReviewDocument | undefined> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  if (!document) return undefined;
  const item = document.items.find((candidate) => candidate.id === itemId);
  if (!item) return undefined;
  item.status = 'pending';
  item.generation_error = generationError;
  item.updated_at = new Date().toISOString();
  await writeReviewDocument(globalStorageUri, document);
  return document;
}

export async function acceptAllThemeImageReviewItems(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<ThemeImageReviewDocument | undefined> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  if (!document?.items.length) return undefined;
  const updatedAt = new Date().toISOString();
  for (const item of document.items) {
    item.status = 'accepted';
    item.updated_at = updatedAt;
  }
  await writeReviewDocument(globalStorageUri, document);
  return document;
}

export function inferLegacyReviewItem(filename: string): ThemeImageReviewItem {
  const stem = filename.replace(/\.[^.]+$/, '');
  const now = new Date(0).toISOString();
  if (stem === 'environment_background') {
    return reviewItem('environment_background', filename, 'Environment background', 'environment', ['environment_background'], now);
  }
  if (stem === 'objects_atlas') {
    return reviewItem('buildable_objects', filename, 'Buildable objects', 'object_atlas', [], now);
  }
  if (stem === 'emotes_atlas') {
    return reviewItem('emote_icons', filename, 'Animated emotes', 'emote_atlas', [], now);
  }
  if (stem === 'expressions') {
    return reviewItem('expressions', filename, 'Expressions', 'expression_atlas', [], now);
  }
  if (stem === 'achievements') {
    return reviewItem('achievements', filename, 'Achievement badges', 'achievement_atlas', [], now);
  }
  const id = stem.replace(/_recovered_atlas$|_atlas$/, '');
  return reviewItem(id, filename, humanize(id), 'character_atlas', [inferCharacterFrameKey(id)], now);
}

function reviewItem(
  id: string,
  filename: string,
  label: string,
  kind: ThemeImageKind,
  frameKeys: string[],
  updatedAt: string,
): ThemeImageReviewItem {
  return {
    id,
    filename,
    label,
    kind,
    status: 'pending',
    prompt: '',
    revision: 0,
    frame_keys: frameKeys,
    updated_at: updatedAt,
  };
}

function inferCharacterFrameKey(id: string): string {
  const agentMatch = /^(agent_\d+)/.exec(id);
  if (agentMatch) return agentMatch[1];
  const rivalMatch = /^(rival_[a-z0-9_]+)/.exec(id);
  return rivalMatch?.[1] ?? id;
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function writeReviewDocument(
  globalStorageUri: vscode.Uri,
  document: ThemeImageReviewDocument,
): Promise<void> {
  await vscode.workspace.fs.createDirectory(themeDirectoryUri(globalStorageUri, document.theme_id));
  await vscode.workspace.fs.writeFile(
    themeReviewUri(globalStorageUri, document.theme_id),
    Buffer.from(JSON.stringify(document, null, 2)),
  );
}
