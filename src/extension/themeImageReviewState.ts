import {
  legacyImageReviewPath,
  resolveThemeFileStore,
  themeDirectoryPath,
  themeReviewPath,
  type ThemeStorageRoot,
} from './themeFileStore';
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
 * v3 object pipeline: TWO fixed-shape 4x4 (16-cell) boards, keyed `objects_01`
 * (board 1) and `objects_02` (board 2) — see themeAssetPrompts.ts's
 * createObjectBoard1Rows / createObjectBoard2Rows.
 *   - Board 1's `object_rows` array is exactly 16 `object_static` entries, one
 *     per cell in row-major order (Cell 1..16), each a single-frame object.
 *   - Board 2's `object_rows` array is exactly 7 entries in this fixed order:
 *     [object_anim, object_anim, poof, object_static, object_static,
 *     object_static, crate]. `object_anim` #1 occupies row 1 (cells 1-4, 4
 *     frames) and #2 occupies row 2 (cells 5-8, 4 frames); `poof` occupies
 *     row 3 (cells 9-12, 4 frames); the three `object_static` entries occupy
 *     the first three cells of row 4 (cells 13-15, 1 frame each); `crate` is
 *     the single last cell (cell 16, 1 frame).
 */
export type ThemeObjectBoardRow =
  | {
      kind: 'object_static';
      object_id: string;
      display_name: string;
      motion_hint?: string;
      is_ranged_rack?: boolean;
      /** Concrete visual-appearance spec from the plan, threaded from ThemeObjectPromptSpec. */
      visual_description?: string;
    }
  | {
      kind: 'object_anim';
      object_id: string;
      display_name: string;
      motion_hint?: string;
      /** Concrete visual-appearance spec from the plan, threaded from ThemeObjectPromptSpec. */
      visual_description?: string;
    }
  | { kind: 'poof'; /** Concrete visual-appearance spec from plan.poof_description. */ visual_description?: string }
  | { kind: 'crate'; /** Concrete visual-appearance spec from plan.crate_description. */ visual_description?: string };

/**
 * One row of a 5x4 (20-cell) rival board. Each row is ONE enemy: cols 0-1 are a
 * 2-frame WALK cycle, cols 2-4 are a 3-frame ATTACK. A board carries up to four
 * such rows → four enemies; three boards cover all 12 rivals. Rival frames are
 * keyed `rival_<id>` (five frames each): [walk0, walk1, attack0, attack1, attack2].
 */
export type ThemeRivalBoardRow = {
  kind: 'rival';
  rival_id: string;
  display_name: string;
  /** Concrete visual-appearance spec from the plan, threaded from ThemeRivalPromptSpec. */
  visual_description?: string;
};

/**
 * One row of the 4x4 background-decor board. Rows 1-2 carry four single-frame
 * decor cells; row 3 carries one four-frame animated decor item; row 4 is the
 * ranged-weapon-fire projectile FX (four one-shot frames → frames['projectile']).
 */
export type ThemeDecorBoardRow =
  | { kind: 'seat'; decor_id: string; display_name: string; visual_description?: string }        // row 1 cell (single frame)
  | { kind: 'decor'; decor_id: string; display_name: string; visual_description?: string }       // row 2 cell (single frame)
  | { kind: 'decor_anim'; decor_id: string; display_name: string; visual_description?: string }  // row 3 item (four frames)
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
  /** Character boards only: current plan.character_descriptions[slot_id] text, for the review UI's Descriptions editor. */
  character_description?: string;
  /**
   * Character boards only (p58-t2): the slot's EXPLICIT, user-set
   * plan.character_body_plans[slot_id] — undefined when the user has never
   * set one for this slot. The review UI infers a display value client-side
   * (themeReviewDescriptionRows' inferBodyPlan) when this is undefined; never
   * populate this field with an inferred value.
   */
  body_plan?: 'biped' | 'quadruped';
  /** Object board 2 (objects_02) only: current plan.crate_description text, for the review UI's Descriptions editor. Required (crate is never renamed/removed), but may be blank. */
  crate_description?: string;
  /** Object board 2 (objects_02) only: current plan.poof_description text, for the review UI's Descriptions editor. Required (poof is never renamed/removed), but may be blank. */
  poof_description?: string;
  /** Background decor board only: current plan.projectile_description text, for the review UI's Descriptions editor. Required (the ranged projectile is never renamed/removed — see ThemeDecorBoardRow's `projectile` kind, which has no decor_id), but may be blank. */
  projectile_description?: string;
  object_specs?: Array<{ object_id: string; display_name: string }>;
  object_rows?: ThemeObjectBoardRow[];
  decor_rows?: ThemeDecorBoardRow[];
  rival_rows?: ThemeRivalBoardRow[];
  expression_names?: string[];
  /** Expression board only: positional (index === expression cell) appearance
   * text from plan.expression_descriptions, for the review UI's Descriptions
   * editor. Absent when the theme has no expression descriptions yet. */
  expression_descriptions?: string[];
  achievement_names?: string[];
  /** Achievement/badge board only: positional (index === badge slot) appearance
   * text from plan.achievement_descriptions, for the review UI's Descriptions
   * editor. Absent when the theme has no badge descriptions yet. */
  achievement_descriptions?: string[];
  generation_error?: ThemeImageGenerationError;
  /** Corsair Theme Service credit cost of the attempt that produced (or last failed to replace) this item's current image. Undefined until the item's first successful attempt via the Theme Service. */
  attemptCost?: number;
  /** Whether that last attempt was auto-refunded (provider_failed). */
  lastAttemptRefunded?: boolean;
  /** Distinct Theme Service error kind for the item's most recent failed attempt — see ThemeServiceErrorKind in core/themeServiceClient.ts. Cleared on the next successful attempt. */
  error_kind?: 'not_signed_in' | 'insufficient_credits' | 'content_blocked' | 'account_locked' | 'unavailable' | 'unreachable' | 'provider_failed' | 'rate_limited' | 'bad_request';
  /** p85: the backend's `code` field on a bad_request failure (e.g. "board_not_priced"), surfaced alongside error_kind so the UI can show a specific message instead of a generic one. */
  error_code?: string;
  /**
   * The Corsair Theme Service pricing key for this board (docs/theme-service-api.md's
   * `attemptCostByBoardType` — e.g. "roster_agent", "objects_01") — see
   * themeService.ts's boardTypeForItem, the single source of truth for this
   * mapping. Optional on the STORED document (legacy/resumed items may
   * predate this field); getThemeImageReview always backfills it onto the
   * live payload so the webview's cost line (pricing.attemptCostByBoardType[...])
   * can key off it instead of the unrelated review item.kind.
   */
  boardType?: string;
  updated_at: string;
}

/**
 * Durable, per-theme AI batch-generation run state (p80). Distinguishes an
 * interrupted AI generation (persisted "active" with no in-memory run after
 * a reload, or an explicit "stopped") from a manual upload, which never
 * touches this field — see panel.ts's MSG.GENERATE_THEME branch for the
 * write points and _postThemeImageReview for how it becomes
 * generation_resumable/generation_status on the wire.
 */
export type ThemeGenerationRunStatus = 'idle' | 'active' | 'stopped' | 'completed';

export interface ThemeGenerationRunState {
  status: ThemeGenerationRunStatus;
  updated_at: string;
}

export interface ThemeImageReviewDocument {
  version: 1;
  theme_id: string;
  display_name: string;
  items: ThemeImageReviewItem[];
  /** Absent is treated as "idle" (never started, or predates this field). */
  generation?: ThemeGenerationRunState;
}

/**
 * Per-theme_id promise queue serializing every read-modify-write of that
 * theme's review.json (review-fix HIGH finding, p80). Every function below
 * that loads the document, mutates it and writes it back MUST run its whole
 * load->mutate->write body through this, keyed by theme id — otherwise two
 * concurrent writers (e.g. an upload's upsertThemeImageReviewItem racing a
 * batch-generation setThemeGenerationStatus) can each load a stale copy and
 * the second write silently drops the first writer's change. Module-scoped:
 * both hosts run this compiled module as a single process-local instance
 * (the standalone bridge requires the SAME out/ file, not a copy), so the
 * queue covers every writer in that process.
 */
const reviewDocumentQueues = new Map<string, Promise<unknown>>();

function withThemeReviewDocumentLock<T>(themeId: string, task: () => Promise<T>): Promise<T> {
  const previous = reviewDocumentQueues.get(themeId) ?? Promise.resolve();
  const result = previous.then(task, task);
  // Never let a rejected task wedge the queue for later callers — only the
  // caller that issued this call sees the rejection.
  reviewDocumentQueues.set(themeId, result.then(() => undefined, () => undefined));
  return result;
}

export async function initializeThemeImageReviewDocument(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  displayName: string,
  items: Array<Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string }>,
): Promise<ThemeImageReviewDocument> {
  return withThemeReviewDocumentLock(themeId, async () => {
    const now = new Date().toISOString();
    const document: ThemeImageReviewDocument = {
      version: 1,
      theme_id: themeId,
      display_name: displayName,
      items: items.map((item) => ({ ...item, updated_at: item.updated_at ?? now })),
    };
    await writeReviewDocument(globalStorageUri, document);
    return document;
  });
}

export async function loadThemeImageReviewDocument(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<ThemeImageReviewDocument | undefined> {
  const store = resolveThemeFileStore(globalStorageUri);
  const candidates = [
    themeReviewPath(themeId),
    legacyImageReviewPath(themeId),
  ];
  for (const relativePath of candidates) {
    try {
      const bytes = await store.readFile(relativePath);
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
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string },
): Promise<ThemeImageReviewDocument> {
  return withThemeReviewDocumentLock(themeId, async () => {
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
  });
}

export async function setThemeImageReviewStatus(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  status: ThemeImageReviewStatus,
): Promise<ThemeImageReviewDocument | undefined> {
  return withThemeReviewDocumentLock(themeId, async () => {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (!document) return undefined;
    const item = document.items.find((candidate) => candidate.id === itemId);
    if (!item) return undefined;
    item.status = status;
    item.updated_at = new Date().toISOString();
    await writeReviewDocument(globalStorageUri, document);
    return document;
  });
}

export async function setThemeImageGenerationError(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  generationError: ThemeImageGenerationError,
): Promise<ThemeImageReviewDocument | undefined> {
  return withThemeReviewDocumentLock(themeId, async () => {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (!document) return undefined;
    const item = document.items.find((candidate) => candidate.id === itemId);
    if (!item) return undefined;
    item.status = 'pending';
    item.generation_error = generationError;
    item.updated_at = new Date().toISOString();
    await writeReviewDocument(globalStorageUri, document);
    return document;
  });
}

/** Records a Corsair Theme Service attempt failure's distinct error kind (p43-t1) — sibling of setThemeImageGenerationError, for THEME_SERVICE-originated failures rather than OpenAI moderation blocks. */
export async function setThemeImageReviewErrorKind(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  errorKind: NonNullable<ThemeImageReviewItem['error_kind']>,
  refunded?: boolean,
  attemptCost?: number,
  errorCode?: string,
): Promise<ThemeImageReviewDocument | undefined> {
  return withThemeReviewDocumentLock(themeId, async () => {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (!document) return undefined;
    const item = document.items.find((candidate) => candidate.id === itemId);
    if (!item) return undefined;
    item.status = 'pending';
    item.error_kind = errorKind;
    item.error_code = errorCode;
    if (refunded !== undefined) item.lastAttemptRefunded = refunded;
    if (attemptCost !== undefined) item.attemptCost = attemptCost;
    item.updated_at = new Date().toISOString();
    await writeReviewDocument(globalStorageUri, document);
    return document;
  });
}

/**
 * Records the durable AI batch-generation run status for a theme (p80).
 * Only the batch-generation start/resume/stop/finish points in panel.ts's
 * MSG.GENERATE_THEME branch (and its standalone mirror) call this — manual
 * uploads, saveThemePlan and single-board retry/regenerate never do.
 * Silently a no-op when the theme has no review document yet (nothing to
 * mark active before the first board is even planned).
 */
export async function setThemeGenerationStatus(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  status: ThemeGenerationRunStatus,
): Promise<ThemeImageReviewDocument | undefined> {
  return withThemeReviewDocumentLock(themeId, async () => {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (!document) return undefined;
    document.generation = { status, updated_at: new Date().toISOString() };
    await writeReviewDocument(globalStorageUri, document);
    return document;
  });
}

export async function acceptAllThemeImageReviewItems(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<ThemeImageReviewDocument | undefined> {
  return withThemeReviewDocumentLock(themeId, async () => {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (!document?.items.length) return undefined;
    const updatedAt = new Date().toISOString();
    for (const item of document.items) {
      item.status = 'accepted';
      item.updated_at = updatedAt;
    }
    await writeReviewDocument(globalStorageUri, document);
    return document;
  });
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
  globalStorageUri: ThemeStorageRoot,
  document: ThemeImageReviewDocument,
): Promise<void> {
  const store = resolveThemeFileStore(globalStorageUri);
  await store.mkdirp(themeDirectoryPath(document.theme_id));
  await store.writeFile(
    themeReviewPath(document.theme_id),
    Buffer.from(JSON.stringify(document, null, 2)),
  );
}
