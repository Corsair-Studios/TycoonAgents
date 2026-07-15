import * as vscode from 'vscode';
import type {
  AgentConfig,
  BuildableObject,
  EnemyConfig,
  RivalConfig,
  ThemeManifest,
  ViewportConfig,
} from '../shared/types';
import { expandThemePlan } from './translator';
import { buildDefaultBadges, upgradeThemeManifest } from './themeMigration';
import { validateThemeIntegrity } from './themeHealth';
import {
  boardBackgroundPaddingAdjective,
  buildAchievementAtlasPrompt,
  buildBackgroundDecorPrompt,
  buildCharacterAtlasPrompt,
  buildEmoteAtlasPrompt,
  buildEnvironmentPrompt,
  buildExpressionAtlasPrompt,
  buildObjectAtlasPrompt,
  CHARACTER_TARGET_CONTENT_HEIGHT,
  CHARACTER_TARGET_CONTENT_PERCENT,
  buildRivalAtlasPrompt,
  createDecorBoardRows,
  createObjectBoard1Rows,
  createObjectBoard2Rows,
  createRivalBoardRows,
  decorBoardFrameKeys,
  objectBoardFrameKeys,
  OBJECT_ANIMATED_COUNT,
  OBJECT_BOARD1_STATIC_COUNT,
  OBJECT_BOARD2_STATIC_COUNT,
  OBJECT_STATIC_COUNT,
  rivalBoardFrameKeys,
} from './themeAssetPrompts';
import type { BoardBackgroundMode, ThemeObjectPromptSpec, ThemeRivalPromptSpec } from './themeAssetPrompts';
import { generateThemeImage } from './imageClient';
import type { ThemeImageGenerationOptions } from './imageClient';
import {
  isUserCorrectableImageGenerationError,
  type ImageGenerationApiError,
} from './imageGenerationError';
import { sliceAndNormalizeAtlas } from './slicer';
import {
  optimizeSpriteBoard,
  optimizeSpriteBoardCanvas,
  resizeSpriteBoardCanvas,
} from './spriteBoardOptimizer';
import { recoverReviewImages } from './themeReviewImages';
import { createEnvironmentShapeGuide, normalizeEnvironmentImage } from './environmentAsset';
import {
  acceptAllThemeImageReviewItems,
  inferLegacyReviewItem,
  initializeThemeImageReviewDocument,
  loadThemeImageReviewDocument,
  setThemeImageGenerationError,
  setThemeImageReviewStatus,
  upsertThemeImageReviewItem,
} from './themeImageReviewState';
import type {
  ThemeDecorBoardRow,
  ThemeImageKind,
  ThemeImageReviewDocument,
  ThemeImageReviewItem,
  ThemeImageReviewStatus,
  ThemeObjectBoardRow,
  ThemeRivalBoardRow,
} from './themeImageReviewState';
import { isThemeGenerationItemComplete } from './themeGenerationState';
import { createThemeArchive, parseThemeArchive } from './themeArchive';
import type { ThemeArchiveContents } from './themeArchive';
import { summarizeThemeApproval } from './themeApproval';
import type { ThemeApprovalSummary } from './themeApproval';
import { selectThemeImageRetryPrompt } from './themeImageRetry';
import type { ThemeImageRetryMode } from './themeImageRetry';
import {
  ATLAS_CLIPS,
  normalizeThemePlan,
  THEME_ACHIEVEMENT_COUNT,
  THEME_EXPRESSION_COUNT,
  THEME_OBJECT_COUNT,
  themePlanCreativeDirection,
  themePlanToManifest,
  toSafeAssetId,
  uniqueIds,
} from './themePlan';
import type { ThemePlan } from './themePlan';
import {
  themeDirectoryUri,
  themeFramesUri,
  themeImagesDirectoryUri,
  themeManifestUri,
  themePlanUri,
  themesDirectoryUri,
  saveRawAtlas,
  themeRawImagesDirectoryUri,
} from './themeStorage';

/**
 * Best-effort persist of the RAW pre-slice atlas buffer alongside its normalized
 * review image. Enables a future re-slice-without-regenerate path; a failure here
 * must NEVER break generation, so we only log a `[raw-atlas]` warning.
 */
async function persistRawAtlas(
  globalStorageUri: vscode.Uri,
  themeId: string,
  filename: string,
  generated: Buffer,
): Promise<void> {
  try {
    await saveRawAtlas(globalStorageUri, themeId, filename, generated);
  } catch (err) {
    console.warn('TycoonAgents [raw-atlas]: failed to persist raw atlas', filename, err);
  }
}

export interface ThemeReviewImages {
  directoryUri: vscode.Uri;
  imageUris: vscode.Uri[];
  recovered: boolean;
}

export interface ThemeImageReviewEntry {
  item: ThemeImageReviewItem;
  imageUri?: vscode.Uri;
  generated: boolean;
}

export interface ThemeImageReview {
  theme_id: string;
  display_name: string;
  entries: ThemeImageReviewEntry[];
}

export interface ThemeImageReviewWaitOptions {
  requiresReplacement?: boolean;
}

type ThemeGenerationResult = { manifest: ThemeManifest; frames: Record<string, string[]> };
type WaitForThemeImageReview = (
  themeId: string,
  itemId: string,
  options?: ThemeImageReviewWaitOptions,
) => Promise<ThemeGenerationResult | void>;

/** Every independently-regenerable board of a theme. */
export type BoardKind =
  | 'environment'
  | 'agents'
  | 'enemy'
  | 'decor'
  | 'objects'
  | 'expressions'
  | 'achievements';

/**
 * Maps the image provider that will actually run generation to the sprite-board
 * background mode its prompts should request. All providers currently use the
 * legacy magenta chroma-key contract.
 *
 * 2026-07-08: gpt-image-2 rejects `background: "transparent"` outright (API
 * 400 "Transparent background is not supported for this model") — gpt-image-1
 * supported native alpha but gpt-image-2 dropped it. The transparent-background
 * plumbing (BoardBackgroundMode, the transparent prompt variants, and the
 * transparentBackground request option) is kept dormant rather than removed —
 * re-enable it here for a specific provider if a future model supports alpha.
 */
export function boardBackgroundModeForProvider(_provider: ThemeImageGenerationOptions['provider']): BoardBackgroundMode {
  return 'magenta';
}

/**
 * Layers the native-transparency request flag onto generation options for a
 * magenta/transparent-keyed sprite board call (agents, rivals, decor, objects,
 * expressions, achievements, and their retries). The environment board is
 * opaque scenery and must never set this — its own call sites build their
 * options separately and never pass through this helper.
 */
function spriteBoardOptions(
  options: ThemeImageGenerationOptions | undefined,
): ThemeImageGenerationOptions | undefined {
  if (!options) return options;
  return {
    ...options,
    transparentBackground: boardBackgroundModeForProvider(options.provider) === 'transparent',
  };
}

export async function planTheme(
  prompt: string,
  imageGenerationOptions?: ThemeImageGenerationOptions,
): Promise<ThemePlan> {
  return expandThemePlan(prompt, imageGenerationOptions);
}

export async function listThemes(
  globalStorageUri: vscode.Uri,
): Promise<Array<{ theme_id: string; display_name: string; size_bytes: number } & ThemeApprovalSummary>> {
  const results = new Map<string, { theme_id: string; display_name: string }>();
  try {
    const entries = await vscode.workspace.fs.readDirectory(themesDirectoryUri(globalStorageUri));
    for (const [themeId, kind] of entries) {
      if (kind !== vscode.FileType.Directory || !isThemeId(themeId)) continue;
      const manifest = await readJson<Partial<ThemeManifest>>(themeManifestUri(globalStorageUri, themeId));
      if (manifest) results.set(themeId, { theme_id: themeId, display_name: manifest.display_name ?? themeId });
    }
  } catch {
    // The themes directory is created on first generation.
  }

  // Preserve access to themes produced by versions that used flat storage.
  try {
    const entries = await vscode.workspace.fs.readDirectory(globalStorageUri);
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.File || !name.endsWith('_manifest.json')) continue;
      const themeId = name.replace(/_manifest\.json$/, '');
      if (results.has(themeId)) continue;
      const manifest = await readJson<Partial<ThemeManifest>>(vscode.Uri.joinPath(globalStorageUri, name));
      if (manifest) results.set(themeId, { theme_id: themeId, display_name: manifest.display_name ?? themeId });
    }
  } catch {
    // Global storage may not exist yet.
  }
  const sorted = [...results.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  return Promise.all(sorted.map(async (theme) => {
    const [approval, sizeBytes] = await Promise.all([
      getThemeApprovalSummary(globalStorageUri, theme.theme_id),
      getThemeDiskSize(globalStorageUri, theme.theme_id),
    ]);
    return { ...theme, ...approval, size_bytes: sizeBytes };
  }));
}

export interface ThemeUpgradeResult {
  theme_id: string;
  changed: string[];
}

/**
 * Scans every installed theme (modern per-directory storage under
 * `themes/<theme_id>/manifest.json`) and applies `upgradeThemeManifest` to
 * bring legacy manifests up to the current data contract. Missing art is
 * intentionally left alone here — the migration only fills in structural
 * fields (decor_objects, crate/poof/projectile assets, enemy_config); the
 * webview renders labeled placeholders for any asset that isn't generated.
 *
 * For each theme whose manifest actually changes, the original file is
 * backed up (non-destructively) alongside it before the upgraded manifest is
 * written back. A theme whose manifest is already current is still included
 * in the returned results with an empty `changed` list. A single bad
 * manifest never aborts the scan of the remaining themes.
 */
export async function upgradeInstalledThemes(
  globalStorageUri: vscode.Uri,
): Promise<ThemeUpgradeResult[]> {
  const results: ThemeUpgradeResult[] = [];

  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await vscode.workspace.fs.readDirectory(themesDirectoryUri(globalStorageUri));
  } catch {
    // The themes directory is created on first generation; nothing to upgrade.
    return results;
  }

  for (const [themeId, kind] of entries) {
    if (kind !== vscode.FileType.Directory || !isThemeId(themeId)) continue;
    try {
      const manifestUri = themeManifestUri(globalStorageUri, themeId);
      const raw = await vscode.workspace.fs.readFile(manifestUri);
      const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as ThemeManifest;
      const { manifest: upgraded, changed } = upgradeThemeManifest(manifest);
      results.push({ theme_id: themeId, changed });

      if (changed.length > 0) {
        const backupUri = vscode.Uri.joinPath(
          themeDirectoryUri(globalStorageUri, themeId),
          `manifest.json.${Date.now()}.bak`,
        );
        try {
          // Never clobber an existing backup with the same name.
          await vscode.workspace.fs.stat(backupUri);
        } catch {
          await vscode.workspace.fs.writeFile(backupUri, Buffer.from(raw));
        }
        await vscode.workspace.fs.writeFile(manifestUri, jsonBuffer(upgraded));
      }
    } catch (error) {
      console.error(`[TycoonAgents] Failed to upgrade theme "${themeId}":`, error);
    }
  }

  return results;
}

/**
 * Seed bundled starter themes into global storage on first run, so a freshly
 * installed plugin has at least one theme available out-of-box. Never
 * overwrites existing user themes. Best-effort: failures are swallowed.
 */
export async function seedBundledThemes(
  extensionUri: vscode.Uri,
  globalStorageUri: vscode.Uri,
): Promise<void> {
  try {
    const existing = await listThemes(globalStorageUri);
    if (existing.length > 0) return;

    await vscode.workspace.fs.createDirectory(globalStorageUri);

    const bundledThemesUri = vscode.Uri.joinPath(extensionUri, 'media', 'themes');
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(bundledThemesUri);
    } catch {
      return;
    }

    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) continue;
      const themeDirUri = vscode.Uri.joinPath(bundledThemesUri, name);
      const manifest = await readJson<Partial<ThemeManifest>>(
        vscode.Uri.joinPath(themeDirUri, 'manifest.json'),
      );
      if (!manifest?.theme_id) continue;

      try {
        const framesBytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(themeDirUri, 'frames.json'),
        );
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(globalStorageUri, `${manifest.theme_id}_manifest.json`),
          jsonBuffer(manifest),
        );
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(globalStorageUri, `${manifest.theme_id}_frames.json`),
          framesBytes,
        );
      } catch (error) {
        console.warn(`TycoonAgents: Could not seed bundled theme "${name}":`, error);
      }
    }
  } catch (error) {
    console.warn('TycoonAgents: Could not seed bundled themes:', error);
  }
}

export async function getThemeApprovalSummary(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<ThemeApprovalSummary> {
  if (!isThemeId(themeId)) return summarizeThemeApproval(undefined);
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  return summarizeThemeApproval(document?.items);
}

/** Delete a saved theme, including sidecars created by legacy releases. */
export async function deleteTheme(globalStorageUri: vscode.Uri, themeId: string): Promise<void> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const targets: Array<{ uri: vscode.Uri; recursive: boolean }> = [
    { uri: themeDirectoryUri(globalStorageUri, themeId), recursive: true },
    { uri: vscode.Uri.joinPath(globalStorageUri, `${themeId}_manifest.json`), recursive: false },
    { uri: vscode.Uri.joinPath(globalStorageUri, `${themeId}_frames.json`), recursive: false },
    { uri: vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`), recursive: false },
    { uri: vscode.Uri.joinPath(globalStorageUri, `${themeId}_review.json`), recursive: false },
    { uri: vscode.Uri.joinPath(globalStorageUri, `${themeId}_image_review.json`), recursive: false },
    { uri: vscode.Uri.joinPath(globalStorageUri, `${themeId}_images`), recursive: true },
  ];

  for (const target of targets) {
    try {
      await vscode.workspace.fs.delete(target.uri, { recursive: target.recursive, useTrash: false });
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code !== 'FileNotFound') throw error;
    }
  }
}

/** Package a saved theme and all of its retained assets into a portable zip. */
export async function exportThemeArchive(globalStorageUri: vscode.Uri, themeId: string): Promise<Uint8Array> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  const approval = await getThemeApprovalSummary(globalStorageUri, themeId);
  if (!approval.export_ready) {
    throw new Error(`Approve all theme images before exporting (${approval.accepted}/${approval.total} approved).`);
  }

  const files = new Map<string, Uint8Array>();
  await collectDirectoryFiles(themeDirectoryUri(globalStorageUri, themeId), '', files);

  // Normalize themes written by releases that predate per-theme directories.
  if (!files.has('manifest.json') || !files.has('frames.json')) {
    files.clear();
    const loaded = await loadTheme(globalStorageUri, themeId);
    if (!loaded) throw new Error('Theme not found.');
    files.set('manifest.json', jsonBuffer(loaded.manifest));
    files.set('frames.json', jsonBuffer(loaded.frames));
    await addFileIfPresent(files, 'plan.json', vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`));
    await addFileIfPresent(files, 'review.json', vscode.Uri.joinPath(globalStorageUri, `${themeId}_review.json`));
    await addFileIfPresent(files, 'review.json', vscode.Uri.joinPath(globalStorageUri, `${themeId}_image_review.json`));
    await collectDirectoryFiles(vscode.Uri.joinPath(globalStorageUri, `${themeId}_images`), 'images', files);
  }

  return createThemeArchive(files);
}

export function readThemeArchive(data: Uint8Array): ThemeArchiveContents {
  return parseThemeArchive(data);
}

/** Validate and install a theme archive. Existing themes require explicit replacement. */
export async function importThemeArchive(
  globalStorageUri: vscode.Uri,
  data: Uint8Array | ThemeArchiveContents,
  replace = false,
): Promise<{ theme_id: string; display_name: string; replaced: boolean }> {
  const archive = data instanceof Uint8Array ? parseThemeArchive(data) : data;
  const themesUri = themesDirectoryUri(globalStorageUri);
  const targetUri = themeDirectoryUri(globalStorageUri, archive.themeId);
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const stagingUri = vscode.Uri.joinPath(themesUri, `.import_${archive.themeId}_${nonce}`);
  const backupUri = vscode.Uri.joinPath(themesUri, `.backup_${archive.themeId}_${nonce}`);
  await vscode.workspace.fs.createDirectory(themesUri);

  const targetExists = await uriExists(targetUri);
  if (targetExists && !replace) throw new Error(`A theme with ID "${archive.themeId}" already exists.`);

  let backupCreated = false;
  try {
    for (const [relativePath, bytes] of archive.files) {
      const segments = relativePath.split('/');
      const fileUri = vscode.Uri.joinPath(stagingUri, ...segments);
      if (segments.length > 1) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(stagingUri, ...segments.slice(0, -1)));
      }
      await vscode.workspace.fs.writeFile(fileUri, bytes);
    }

    if (targetExists) {
      await vscode.workspace.fs.rename(targetUri, backupUri, { overwrite: false });
      backupCreated = true;
    }
    await vscode.workspace.fs.rename(stagingUri, targetUri, { overwrite: false });
    if (backupCreated) {
      try {
        await vscode.workspace.fs.delete(backupUri, { recursive: true, useTrash: false });
        backupCreated = false;
      } catch (error) {
        console.warn(`TycoonAgents: Imported ${archive.themeId}, but could not remove its backup:`, error);
      }
    }
  } catch (error) {
    if (backupCreated && !(await uriExists(targetUri))) {
      try {
        await vscode.workspace.fs.rename(backupUri, targetUri, { overwrite: false });
        backupCreated = false;
      } catch {
        // Preserve the backup directory for manual recovery if rollback itself fails.
      }
    }
    try {
      await vscode.workspace.fs.delete(stagingUri, { recursive: true, useTrash: false });
    } catch {
      // The staging directory may already have been renamed.
    }
    throw error;
  }

  return {
    theme_id: archive.themeId,
    display_name: archive.displayName,
    replaced: targetExists,
  };
}

function logThemeIntegrityIssues(themeId: string, manifest: ThemeManifest, frames: Record<string, string[]>): void {
  try {
    const issues = validateThemeIntegrity(manifest, frames);
    for (const issue of issues) {
      const logger = issue.severity === 'error' ? console.error : console.warn;
      logger(`[theme-health] TycoonAgents: ${themeId}: ${issue.message}`);
    }
  } catch (error) {
    console.warn(`[theme-health] TycoonAgents: failed to validate theme integrity for ${themeId}:`, error);
  }
}

export async function loadTheme(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  const modernManifest = await readJson<ThemeManifest>(themeManifestUri(globalStorageUri, themeId));
  const modernFrames = await readJson<Record<string, string[]>>(themeFramesUri(globalStorageUri, themeId));
  if (modernManifest && modernFrames) {
    const { manifest: upgradedModern } = upgradeThemeManifest(modernManifest);
    logThemeIntegrityIssues(themeId, upgradedModern, modernFrames);
    return { manifest: upgradedModern, frames: modernFrames };
  }

  const legacyManifest = await readJson<ThemeManifest>(
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_manifest.json`),
  );
  const legacyFrames = await readJson<Record<string, string[]>>(
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_frames.json`),
  );
  if (legacyManifest && legacyFrames) {
    const { manifest: upgradedLegacy } = upgradeThemeManifest(legacyManifest);
    logThemeIntegrityIssues(themeId, upgradedLegacy, legacyFrames);
    return { manifest: upgradedLegacy, frames: legacyFrames };
  }
  return undefined;
}

export async function saveThemeTuning(
  globalStorageUri: vscode.Uri,
  tuning: {
    theme_id: string;
    walkable_nav_polygon: [number, number][];
    character_scale: number;
    object_scale: number;
    character_scale_overrides: Record<string, number>;
    object_scale_overrides: Record<string, number>;
    object_anchor_overrides?: Record<string, [number, number]>;
    decor_anchor_overrides?: Record<string, [number, number]>;
    decor_flip_overrides?: Record<string, boolean>;
    object_flip_overrides?: Record<string, boolean>;
    decor_hidden?: string[];
    overall_scale?: number;
    enemy_config?: EnemyConfig;
    rival_scale?: number;
    rival_scale_overrides?: Record<string, number>;
    decor_scale?: number;
    decor_scale_overrides?: Record<string, number>;
  },
): Promise<boolean> {
  try {
    const loaded = await loadTheme(globalStorageUri, tuning.theme_id);
    if (!loaded) return false;
    const { manifest, frames } = loaded;
    manifest.viewport.walkable_nav_polygon = tuning.walkable_nav_polygon;
    manifest.viewport.character_scale = tuning.character_scale;
    manifest.viewport.object_scale = tuning.object_scale;
    manifest.viewport.character_scale_overrides = tuning.character_scale_overrides;
    manifest.viewport.object_scale_overrides = tuning.object_scale_overrides;
    // Position overrides set by the Stage Editor. Keep only well-formed
    // id -> [x, y] entries; the [-1,-1] sentinel (hidden decor) is preserved.
    const sanitizeAnchors = (raw: unknown): Record<string, [number, number]> | undefined => {
      if (!raw || typeof raw !== 'object') return undefined;
      const out: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) {
          out[k] = [Number(v[0]), Number(v[1])];
        }
      }
      return out;
    };
    const objAnchors = sanitizeAnchors(tuning.object_anchor_overrides);
    if (objAnchors) manifest.viewport.object_anchor_overrides = objAnchors;
    const decorAnchors = sanitizeAnchors(tuning.decor_anchor_overrides);
    if (decorAnchors) manifest.viewport.decor_anchor_overrides = decorAnchors;
    // Horizontal-flip overrides set by the Stage Editor. Keep only entries
    // that are strictly `true`; drop `false`/non-boolean values.
    const sanitizeFlips = (raw: unknown): Record<string, boolean> | undefined => {
      if (!raw || typeof raw !== 'object') return undefined;
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === true) out[k] = true;
      }
      return out;
    };
    const decorFlips = sanitizeFlips(tuning.decor_flip_overrides);
    if (decorFlips) manifest.viewport.decor_flip_overrides = decorFlips;
    const objFlips = sanitizeFlips(tuning.object_flip_overrides);
    if (objFlips) manifest.viewport.object_flip_overrides = objFlips;
    // Non-destructive HIDE list for decor, set by the Stage Editor's H hotkey
    // / Hide button. Keep only well-formed string ids.
    if (Array.isArray(tuning.decor_hidden)) {
      manifest.viewport.decor_hidden = tuning.decor_hidden.filter((id): id is string => typeof id === 'string');
    }
    if (tuning.overall_scale !== undefined) {
      const overall = Number(tuning.overall_scale);
      if (Number.isFinite(overall) && overall > 0) {
        manifest.viewport.overall_scale = overall;
      }
    }
    if (tuning.rival_scale !== undefined) {
      const rival = Number(tuning.rival_scale);
      if (Number.isFinite(rival) && rival > 0) {
        manifest.viewport.rival_scale = rival;
      }
    }
    if (tuning.rival_scale_overrides && typeof tuning.rival_scale_overrides === 'object') {
      manifest.viewport.rival_scale_overrides = tuning.rival_scale_overrides;
    }
    if (tuning.decor_scale !== undefined) {
      const decor = Number(tuning.decor_scale);
      if (Number.isFinite(decor) && decor > 0) {
        manifest.viewport.decor_scale = decor;
      }
    }
    if (tuning.decor_scale_overrides && typeof tuning.decor_scale_overrides === 'object') {
      manifest.viewport.decor_scale_overrides = tuning.decor_scale_overrides;
    }
    if (tuning.enemy_config && typeof tuning.enemy_config === 'object') {
      const sanitized: EnemyConfig = { ...manifest.viewport.enemy_config };
      const interval = Number(tuning.enemy_config.spawn_interval_seconds);
      if (Number.isFinite(interval) && interval > 0) {
        sanitized.spawn_interval_seconds = interval;
      }
      if (tuning.enemy_config.count_mode === 'all' || tuning.enemy_config.count_mode === 'random') {
        sanitized.count_mode = tuning.enemy_config.count_mode;
      }
      manifest.viewport.enemy_config = sanitized;
    }
    await writeThemeFiles(globalStorageUri, manifest, frames);
    return true;
  } catch {
    return false;
  }
}

export async function replaceThemeBackground(
  globalStorageUri: vscode.Uri,
  themeId: string,
  imageBytes: Uint8Array,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  try {
    const loaded = await loadTheme(globalStorageUri, themeId);
    if (!loaded) return undefined;
    const { manifest, frames } = loaded;
    frames["environment_background"] = [dataUri(Buffer.from(imageBytes))];
    await writeThemeFiles(globalStorageUri, manifest, frames);
    return { manifest, frames };
  } catch {
    return undefined;
  }
}

/**
 * Uploads a user-supplied image to replace a theme's review/manifest asset.
 *
 * Reuses the same item resolver as `retryThemeImage`/`normalizeThemeCharacterAtlas`:
 * the saved `ThemeImageReviewDocument` is loaded and the item's `kind` decides
 * whether the image is sliced as a multi-frame character/rival atlas or stored
 * as a single image (background/object/badge/etc.).
 */
export async function uploadThemeImage(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  imageBytes: Uint8Array,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  try {
    const loaded = await loadTheme(globalStorageUri, themeId);
    if (!loaded) return undefined;
    const { manifest, frames } = loaded;

    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    const item = document?.items.find((candidate) => candidate.id === itemId);
    const buffer = Buffer.from(imageBytes);
    let output: Buffer = buffer;
    let frameKeys = item?.frame_keys ?? [];

    if (item?.kind === 'character_atlas') {
      const characterAtlas = await processCharacterAtlas(buffer, manifest);
      output = characterAtlas.output;
      const spritePackage = characterAtlas.spritePackage;
      const frameKey = item.frame_keys[0] || item.id;
      frames[frameKey] = spritePackage.slots.map((slot) => slot.data);
      frameKeys = [frameKey];
    } else if (item?.kind === 'rival_atlas') {
      const rows = rivalRowsForItem(item, manifest);
      const rivalAtlas = await processRivalAtlas(buffer, manifest, rows);
      output = rivalAtlas.output;
      frameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
    } else if (item?.kind === 'object_atlas' && item.object_rows?.length) {
      const objectAtlas = await processObjectAtlas(buffer, manifest, item.object_rows);
      output = objectAtlas.output;
      frameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, item.object_rows);
    } else if (item?.kind === 'object_atlas') {
      output = await optimizeSpriteBoardCanvas(buffer, 4, 3);
      const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 3 });
      // Prefer the CURRENT manifest's object roster over the item's saved legacy
      // specs, so an upload against a theme whose roster changed slices/labels
      // frames against the current objects instead of a stale saved set.
      const manifestObjectSpecs = themeObjectSpecs(manifest).slice(0, 12);
      const specs = manifestObjectSpecs.length
        ? manifestObjectSpecs
        : (item.object_specs?.length ? item.object_specs : []);
      frameKeys = applyLegacyObjectFrames(frames, spritePackage.slots, specs);
    } else if (item?.kind === 'background_decor_atlas') {
      const rows = decorRowsForItem(item, manifest);
      const decorAtlas = await processDecorAtlas(buffer, manifest);
      output = decorAtlas.output;
      frameKeys = applyDecorBoardFrames(frames, decorAtlas.spritePackage.slots, rows);
      manifest.viewport.projectile_asset = 'frames.json#projectile';
    } else {
      const frameKey = item?.frame_keys[0] || itemId;
      frames[frameKey] = [dataUri(buffer)];
      frameKeys = [frameKey];
    }

    if (item && document) {
      const reviewDirectoryUri = themeImagesDirectoryUri(globalStorageUri, themeId);
      await vscode.workspace.fs.createDirectory(reviewDirectoryUri);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(reviewDirectoryUri, item.filename), output);
      // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
      await persistRawAtlas(globalStorageUri, themeId, item.filename, buffer);
      await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
        ...item,
        status: 'pending',
        generation_error: undefined,
        revision: item.revision + 1,
        frame_keys: frameKeys,
        updated_at: new Date().toISOString(),
      });
    }

    // Merge-safe write (see writeThemeFiles): scope the frames.json write to
    // just the keys this upload owns, so it can't revert a concurrently
    // in-flight board retry's already-saved frames for other keys.
    await writeThemeFiles(globalStorageUri, manifest, frames, [
      ...new Set([...frameKeys, ...(item?.frame_keys ?? [])]),
    ]);
    return { manifest, frames };
  } catch {
    return undefined;
  }
}

/**
 * Load the most recently modified theme (by manifest mtime), if any exist.
 * Used to auto-populate a freshly opened surface with the latest theme.
 */
export async function loadLatestTheme(
  globalStorageUri: vscode.Uri,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  const themes = await listThemes(globalStorageUri);
  let newestId: string | undefined;
  let newestMtime = -1;
  for (const theme of themes) {
    let mtime = 0;
    try {
      mtime = (await vscode.workspace.fs.stat(themeManifestUri(globalStorageUri, theme.theme_id))).mtime;
    } catch {
      try {
        mtime = (await vscode.workspace.fs.stat(
          vscode.Uri.joinPath(globalStorageUri, `${theme.theme_id}_manifest.json`),
        )).mtime;
      } catch {
        continue;
      }
    }
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newestId = theme.theme_id;
    }
  }
  return newestId ? loadTheme(globalStorageUri, newestId) : undefined;
}

async function loadThemeManifest(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<ThemeManifest | undefined> {
  return (await readJson<ThemeManifest>(themeManifestUri(globalStorageUri, themeId)))
    ?? (await readJson<ThemeManifest>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_manifest.json`)));
}

/**
 * Regenerating an existing theme must not clobber Stage Editor viewport tuning
 * the user has already dialed in. Carry forward each of these fields from the
 * OLD manifest's viewport onto the freshly generated one, but only when the old
 * value is present and the new manifest doesn't already carry an explicit value.
 * Mutates `newViewport` in place.
 */
function preserveViewportTuning(newViewport: ViewportConfig, oldViewport: ViewportConfig | undefined): void {
  if (!oldViewport) return;
  newViewport.character_scale = oldViewport.character_scale ?? newViewport.character_scale;
  newViewport.object_scale = oldViewport.object_scale ?? newViewport.object_scale;
  newViewport.character_scale_overrides = oldViewport.character_scale_overrides ?? newViewport.character_scale_overrides;
  newViewport.object_scale_overrides = oldViewport.object_scale_overrides ?? newViewport.object_scale_overrides;
  newViewport.object_anchor_overrides = oldViewport.object_anchor_overrides ?? newViewport.object_anchor_overrides;
  newViewport.decor_anchor_overrides = oldViewport.decor_anchor_overrides ?? newViewport.decor_anchor_overrides;
  newViewport.decor_flip_overrides = oldViewport.decor_flip_overrides ?? newViewport.decor_flip_overrides;
  newViewport.object_flip_overrides = oldViewport.object_flip_overrides ?? newViewport.object_flip_overrides;
  newViewport.decor_hidden = oldViewport.decor_hidden ?? newViewport.decor_hidden;
  newViewport.enemy_config = oldViewport.enemy_config ?? newViewport.enemy_config;
}

/** Return retained originals, reconstructing legacy review boards if needed. */
export async function ensureThemeReviewImages(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<ThemeReviewImages> {
  const directoryUri = themeImagesDirectoryUri(globalStorageUri, themeId);
  await vscode.workspace.fs.createDirectory(directoryUri);
  const existingImages = await listReviewImageUris(directoryUri);
  if (existingImages.length > 0) return { directoryUri, imageUris: existingImages, recovered: false };

  const legacyDirectoryUri = vscode.Uri.joinPath(globalStorageUri, `${themeId}_images`);
  try {
    const legacyImages = await listReviewImageUris(legacyDirectoryUri);
    if (legacyImages.length > 0) {
      return { directoryUri: legacyDirectoryUri, imageUris: legacyImages, recovered: false };
    }
  } catch {
    // No legacy review directory.
  }

  const loaded = await loadTheme(globalStorageUri, themeId);
  if (loaded) {
    try {
      const recoveredFiles = await recoverReviewImages(loaded.frames);
      for (const file of recoveredFiles) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directoryUri, file.filename), file.data);
      }
    } catch (err) {
      console.warn(`TycoonAgents: Could not recover review images for ${themeId}:`, err);
    }
  }
  return { directoryUri, imageUris: await listReviewImageUris(directoryUri), recovered: true };
}

/**
 * Merge a freshly-synthesized `expected` review item into its `saved` counterpart
 * for DISPLAY: keep the saved item's generation state (status / revision / updated_at /
 * generation_error / filename / image association) but refresh the STRUCTURAL per-slot
 * metadata that drives the inline Names editor + prompt (label + object_rows / object_specs /
 * rival_rows / decor_rows / achievement_names / expression_names) from `expected`, which is
 * built from the CURRENT manifest/plan. Without this, a theme generated before the v2 object
 * board shape (or before these row fields existed) keeps stale/absent rows on disk, so the
 * Names editor shows nothing for its object/rival/decor boards even though the current
 * manifest defines every slot. Each field is only overridden when `expected` actually
 * carries it (so a board kind that has no such field is never wiped). Exported for unit testing.
 */
export function refreshSavedReviewItemMetadata(
  saved: ThemeImageReviewItem,
  expected: Omit<ThemeImageReviewItem, 'updated_at'>,
): ThemeImageReviewItem {
  return {
    ...saved,
    label: expected.label,
    ...(expected.object_rows !== undefined ? { object_rows: expected.object_rows } : {}),
    ...(expected.object_specs !== undefined ? { object_specs: expected.object_specs } : {}),
    ...(expected.rival_rows !== undefined ? { rival_rows: expected.rival_rows } : {}),
    ...(expected.decor_rows !== undefined ? { decor_rows: expected.decor_rows } : {}),
    ...(expected.achievement_names !== undefined ? { achievement_names: expected.achievement_names } : {}),
    ...(expected.achievement_descriptions !== undefined ? { achievement_descriptions: expected.achievement_descriptions } : {}),
    ...(expected.expression_names !== undefined ? { expression_names: expected.expression_names } : {}),
    ...(expected.expression_descriptions !== undefined ? { expression_descriptions: expected.expression_descriptions } : {}),
  };
}

/**
 * Merge the freshly-synthesized `expected` board set (the CURRENT contract's
 * boards from createReviewItems) with the saved review items. Each expected
 * board keeps its saved generation state when a saved counterpart exists (via
 * refreshSavedReviewItemMetadata, which refreshes structural metadata without
 * downgrading status/revision/prompt), otherwise it becomes a pending
 * placeholder. Saved items whose id is NOT in the expected set are DROPPED:
 * they are orphans left over from a superseded board contract (e.g. an old
 * animated-objects board replaced by the v3 objects_02) and must never surface
 * as a stale review card.
 */
export function mergeExpectedReviewItems(
  expectedItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>>,
  savedItems: ThemeImageReviewItem[],
): ThemeImageReviewItem[] {
  return expectedItems.map((expected) => {
    const saved = savedItems.find((candidate) => candidate.id === expected.id);
    return saved
      ? refreshSavedReviewItemMetadata(saved, expected)
      : { ...expected, updated_at: new Date(0).toISOString() };
  });
}

export async function getThemeImageReview(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<ThemeImageReview> {
  const reviewImages = await ensureThemeReviewImages(globalStorageUri, themeId);
  const manifest = await loadThemeManifest(globalStorageUri, themeId);
  const displayName = manifest?.display_name ?? themeId;
  let document = await loadThemeImageReviewDocument(globalStorageUri, themeId);

  if (!document) {
    for (const imageUri of reviewImages.imageUris) {
      const filename = basename(imageUri);
      if (!filename) continue;
      const inferred = inferLegacyReviewItem(filename);
      if (inferred.kind === 'character_atlas' && manifest) matchLegacyCharacter(inferred, filename, manifest);
      document = await upsertThemeImageReviewItem(globalStorageUri, themeId, displayName, inferred);
    }
  }

  // Add the old emote board entry when reviewing a pre-plan theme. The old
  // buildable-objects entry is intentionally not synthesized: generated themes
  // already retain their static `objects` board or animated `objects_XX` boards.
  if (manifest && document) {
    if (!document.items.some((item) => item.id === 'emote_icons')
        && !document.items.some((item) => item.kind === 'expression_atlas')) {
      document = await upsertThemeImageReviewItem(globalStorageUri, themeId, displayName, {
        id: 'emote_icons',
        filename: 'emotes_atlas.png',
        label: 'Animated emotes',
        kind: 'emote_atlas',
        status: 'pending',
        prompt: '',
        revision: 0,
        frame_keys: [],
      });
    }
  }

  // Replace the saved review items with the FULL expected item set for this
  // theme's plan, so boards that were never generated still show up as
  // pending "placeholder" cards instead of being silently absent, AND boards
  // from a superseded contract no longer surface as stale cards. This is
  // display-time only: a saved item's generation STATE is preserved (never
  // downgraded to pending), but its per-slot row/name metadata is refreshed
  // from the current manifest/plan (see refreshSavedReviewItemMetadata) so the
  // Names editor reflects the live board shape; the on-disk review document is
  // left untouched. Only runs when a plan exists (so `expected` can be
  // synthesized) — plan-less legacy themes keep their saved items unchanged.
  let items = document?.items ?? [];
  if (manifest) {
    try {
      const savedPlan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
        ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
      if (savedPlan) {
        const plan = normalizeThemePlan(savedPlan, manifest.display_name);
        if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');
        const creativeDirection = themePlanCreativeDirection(plan);
        const expectedItems = createReviewItems(plan, manifest, creativeDirection);
        const savedItems = document?.items ?? [];
        // Show EXACTLY the current contract's boards. Saved boards whose id is
        // not in the current contract are dropped as orphans from a superseded
        // board contract, so no stale review card (e.g. an old animated-objects
        // board) lingers after the board layout changes.
        items = mergeExpectedReviewItems(expectedItems, savedItems);
      }
    } catch {
      // No usable saved plan for this theme (e.g. a very old theme, or a
      // mismatched/renamed plan) — fall back to saved items only.
    }
  }

  const imagesByFilename = new Map(reviewImages.imageUris.map((imageUri) => [basename(imageUri), imageUri]));
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  return {
    theme_id: themeId,
    display_name: document?.display_name ?? displayName,
    entries: items.map((item) => {
      const imageUri = imagesByFilename.get(item.filename);
      return {
        item,
        imageUri,
        generated: isThemeGenerationItemComplete(item, Boolean(imageUri), loadedTheme?.frames ?? {}),
      };
    }),
  };
}

export async function updateThemeImageReviewStatus(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  status: ThemeImageReviewStatus,
): Promise<ThemeImageReviewDocument | undefined> {
  return setThemeImageReviewStatus(globalStorageUri, themeId, itemId, status);
}

/** Rename one agent or rival without changing its stable frame key. */
export async function renameThemeCharacter(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  requestedName: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  const characterName = requestedName.trim().replace(/\s+/g, ' ');
  if (!characterName) throw new Error('Enter a character name.');
  if (characterName.length > 80) throw new Error('Character names must be 80 characters or fewer.');

  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) throw new Error('Review image metadata was not found.');
  if (item.kind !== 'character_atlas') throw new Error('Only character images can be renamed.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be renamed.');
  const { manifest, frames } = loadedTheme;
  const frameKey = item.frame_keys[0] || item.id;
  const agentMatch = /^agent_(\d+)$/.exec(frameKey);
  const agent = agentMatch
    ? manifest.roster_agents.find((candidate) => candidate.slot_id === Number(agentMatch[1]))
    : undefined;
  const rival = agent
    ? undefined
    : manifest.roster_rivals.find((candidate) => candidate.rival_id === frameKey || candidate.rival_id === item.id);
  const character = agent ?? rival;
  if (!character) throw new Error('The character linked to this image was not found.');

  const previousName = item.subject ?? item.label ?? character.name;
  character.name = characterName;
  item.label = characterName;
  item.subject = characterName;
  item.prompt = renameCharacterInPrompt(item.prompt, previousName, characterName);

  const plan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
    ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
  if (plan) {
    if (agent && Array.isArray(plan.characters)) {
      plan.characters[agent.slot_id] = characterName;
    } else if (rival && Array.isArray(plan.enemies)) {
      const rivalIndex = manifest.roster_rivals.indexOf(rival);
      if (rivalIndex >= 0) plan.enemies[rivalIndex] = characterName;
    }
    await vscode.workspace.fs.writeFile(themePlanUri(globalStorageUri, themeId), jsonBuffer(plan));
  }
  if (!item.prompt) {
    const direction = plan
      ? themePlanCreativeDirection(plan)
      : `Match the existing visual direction for ${manifest.display_name}.`;
    const description = agent
      ? (plan?.character_descriptions?.[agent.slot_id] ?? '').trim() || undefined
      : undefined;
    item.prompt = buildCharacterAtlasPrompt(direction, characterName, manifest.display_name, 'magenta', description);
  }

  await writeThemeFiles(globalStorageUri, manifest, frames);
  await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
    ...item,
    updated_at: new Date().toISOString(),
  });
  return { manifest, frames };
}

/** One row of the theme-review "Names" editor's batched Apply. */
export interface ThemeItemNameChange {
  item_kind: 'object' | 'decor' | 'character' | 'rival' | 'badge';
  id: string;
  name: string;
}

export interface ThemeItemNameChangeResult {
  applied: ThemeItemNameChange[];
  rejected: Array<{ item_kind: string; id: string; reason: string }>;
}

/**
 * Pure core of the theme-review "Names" editor's batched Apply: mutates
 * `manifest` in place, applying every valid change and collecting the rest as
 * rejections (unknown id, empty/whitespace name, name over 60 chars) without
 * touching the manifest for those. Kept manifest-only and side-effect-free
 * (no vscode/file IO) so it's directly unit-testable — mirrors the
 * "manifest wins" policy objectRowsForItem/decorRowsForItem/rivalRowsForItem
 * already enforce for board regeneration prompts: every regenerate mode
 * (including 'retry'/'augment', as of the retryThemeImage fresh-base rebuild —
 * see selectThemeImageRetryPrompt) now reconstructs board rows/prompt from the
 * CURRENT manifest at generation time. The caller (renameThemeItemsBatch)
 * still resyncs the saved review-item prompt/rows right after this runs (see
 * resyncRenamedReviewItems) so the on-disk prompt/rows reflect the rename
 * immediately, without waiting for the next retry. Exported for unit testing.
 */
export function applyThemeItemNameChanges(
  manifest: ThemeManifest,
  changes: ThemeItemNameChange[],
): ThemeItemNameChangeResult {
  const applied: ThemeItemNameChange[] = [];
  const rejected: Array<{ item_kind: string; id: string; reason: string }> = [];
  for (const change of changes) {
    const name = (change.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) {
      rejected.push({ item_kind: change.item_kind, id: change.id, reason: 'Name is empty.' });
      continue;
    }
    if (name.length > 60) {
      rejected.push({ item_kind: change.item_kind, id: change.id, reason: 'Name is longer than 60 characters.' });
      continue;
    }
    if (change.item_kind === 'object') {
      const object = manifest.buildable_objects?.find((candidate) => candidate.object_id === change.id);
      if (!object) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown object "${change.id}".` });
        continue;
      }
      object.display_name = name;
    } else if (change.item_kind === 'decor') {
      const decor = manifest.decor_objects?.find((candidate) => candidate.decor_id === change.id);
      if (!decor) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown decor item "${change.id}".` });
        continue;
      }
      decor.display_name = name;
    } else if (change.item_kind === 'character') {
      const agentMatch = /^agent_(\d+)$/.exec(change.id);
      const agent = agentMatch
        ? manifest.roster_agents?.find((candidate) => candidate.slot_id === Number(agentMatch[1]))
        : undefined;
      if (!agent) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown character "${change.id}".` });
        continue;
      }
      agent.name = name;
    } else if (change.item_kind === 'rival') {
      // rival_rows sent by the webview carry rival_id with the `rival_` prefix
      // STRIPPED (see themeRivalSpecs, which strips it so frame keys built as
      // `rival_<id>` don't double-prefix), but manifest.roster_rivals[].rival_id
      // keeps the full prefixed id (see themePlan.ts). Match either form so a
      // rename lands regardless of which shape the id arrives in.
      const rival = manifest.roster_rivals?.find((candidate) => (
        candidate.rival_id === change.id || candidate.rival_id === `rival_${change.id}`
      ));
      if (!rival) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown rival "${change.id}".` });
        continue;
      }
      rival.name = name;
    } else if (change.item_kind === 'badge') {
      // Badge slots are positional: rowId is `achievement_<index>` (see themeReviewNameRows).
      // manifest.badges carry the universal default labels; set this theme's badge label to the
      // themed name here, and mirror it into plan.achievements in resyncRenamedBoardPrompts (the
      // themed source of truth) so it survives reopen and the achievement-icon prompt.
      const badgeMatch = /^achievement_(\d+)$/.exec(change.id);
      const badgeIndex = badgeMatch ? Number(badgeMatch[1]) : -1;
      const badge = badgeIndex >= 0 ? manifest.badges?.[badgeIndex] : undefined;
      if (!badge) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown badge "${change.id}".` });
        continue;
      }
      badge.display_name = name;
    } else {
      rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown item kind "${change.item_kind}".` });
      continue;
    }
    applied.push({ item_kind: change.item_kind, id: change.id, name });
  }
  return { applied, rejected };
}

/**
 * Thin IO wrapper around applyThemeItemNameChanges: loads the theme once,
 * applies the whole batch, writes once. Rename affordance for the theme
 * review screen's per-board "Names" editor — buildable-object, decor, and
 * rival display names have no per-row image-review entry of their own; they
 * live inside a whole-board item's object_rows/decor_rows/rival_rows. Every
 * regenerate mode rebuilds its prompt fresh from the CURRENT manifest at
 * generation time (see buildReplacementPrompt and retryThemeImage's
 * freshBasePrompt), so a rename is picked up on the very next retry either
 * way — but this still calls resyncRenamedBoardPrompts after the manifest
 * write so the saved review-item prompt/rows reflect the rename immediately,
 * for anything that reads them before the next generation (e.g. the review
 * screen's "view prompt" display). Character changes mirror what
 * renameThemeCharacter does to the manifest (agent.name), but skip that
 * resync — the review screen's existing single-character rename flow
 * (RENAME_THEME_CHARACTER) still owns that fuller semantics for character
 * boards.
 */
export async function renameThemeItemsBatch(
  globalStorageUri: vscode.Uri,
  themeId: string,
  changes: ThemeItemNameChange[],
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]>; result: ThemeItemNameChangeResult }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  if (!changes.length) throw new Error('No name changes were provided.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be renamed.');
  const { manifest, frames } = loadedTheme;

  const result = applyThemeItemNameChanges(manifest, changes);
  if (result.applied.length) {
    await writeThemeFiles(globalStorageUri, manifest, frames);
    // Refresh the SAVED review-item prompt/rows for every board a renamed row
    // belongs to, so a later 'retry'/'augment' regeneration (which replays the
    // saved prompt verbatim/appended, not a fresh rebuild) draws the new name
    // instead of the one baked into the stale saved prompt. See
    // resyncRenamedReviewItems for the full rationale.
    await resyncRenamedBoardPrompts(globalStorageUri, themeId, manifest, result.applied);
  }
  return { manifest, frames, result };
}

/**
 * Restore every badge's canonical default TITLE (buildDefaultBadges
 * display_name, matched by badge_id) while PRESERVING any custom title the user
 * typed: before overwriting a changed title, if that badge has no appearance
 * description yet, the current custom title is moved into
 * plan.achievement_descriptions[idx] so it still drives the badge ART
 * (buildAchievementAtlasPrompt). This fixes the failure mode where a user typed
 * appearance text into the badge NAME (which both titled the badge AND drew its
 * art), breaking the titles. Reuses the rename path's persistence + resync
 * (writeThemeFiles + resyncRenamedBoardPrompts) so the achievement board
 * prompt/review refresh exactly as a batched badge rename would. Returns the
 * loaded manifest/frames plus the count of badges reset.
 */
/**
 * Pure core of resetThemeBadgeNames: mutates `manifest` (badge display_names)
 * and `plan` (achievements + achievement_descriptions) in place, restoring every
 * badge whose title drifted from its canonical default (buildDefaultBadges,
 * matched by badge_id) while PRESERVING the custom title by moving it into that
 * badge's appearance description — but only when the description is empty, so an
 * existing appearance spec is never clobbered. Side-effect-free (no IO) so it's
 * directly unit-testable. Returns the applied badge name changes (id
 * `achievement_<index>`) for the caller's resync; an empty array means every
 * badge was already at its canonical title (nothing to persist). Exported for
 * unit testing.
 */
export function applyBadgeNameReset(
  manifest: ThemeManifest,
  plan: ThemePlan,
): ThemeItemNameChange[] {
  const canonicalByBadgeId = new Map(buildDefaultBadges().map((badge) => [badge.badge_id, badge.display_name]));
  const applied: ThemeItemNameChange[] = [];
  const badges = manifest.badges ?? [];
  for (let idx = 0; idx < badges.length; idx += 1) {
    const badge = badges[idx];
    if (!badge) continue;
    const canonical = canonicalByBadgeId.get(badge.badge_id);
    // Only reset badges the user actually renamed away from their canonical title.
    if (!canonical || badge.display_name === canonical) continue;
    // Preserve the user's typed appearance text: only backfill the description
    // when it's empty, so a real description already present is never clobbered.
    const existing = (plan.achievement_descriptions?.[idx] ?? '').trim();
    if (!existing) {
      plan.achievement_descriptions = setPlanDescriptionAt(plan.achievement_descriptions, idx, badge.display_name);
    }
    badge.display_name = canonical;
    if (idx < plan.achievements.length) plan.achievements[idx] = canonical;
    applied.push({ item_kind: 'badge', id: `achievement_${idx}`, name: canonical });
  }
  return applied;
}

export async function resetThemeBadgeNames(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]>; changed: number }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be updated.');
  const { manifest, frames } = loadedTheme;

  const savedPlan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
    ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
  if (!savedPlan) throw new Error('This theme has no saved plan — badge names require plan.json.');
  const plan = normalizeThemePlan(savedPlan, manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');

  const applied = applyBadgeNameReset(manifest, plan);

  if (applied.length) {
    // Persist the plan (migrated appearance text + canonical achievements) BEFORE
    // the resync, which reloads plan.json from disk to rebuild the board prompt.
    await vscode.workspace.fs.writeFile(themePlanUri(globalStorageUri, themeId), jsonBuffer(plan));
    await writeThemeFiles(globalStorageUri, manifest, frames);
    await resyncRenamedBoardPrompts(globalStorageUri, themeId, manifest, applied);
  }
  return { manifest, frames, changed: applied.length };
}

/** One row of the theme-review "Descriptions" editor's batched Apply.
 * 'character' IS included (unlike the Names editor, which intentionally leaves
 * character boards to RENAME_THEME_CHARACTER). 'crate' and 'poof' address the
 * single required build-crate / build-poof rows (object board 2) —
 * description-only, id is not looked up against any roster (there is exactly one
 * of each per theme). 'badge' writes plan.achievement_descriptions[idx]
 * (positional, id `achievement_<index>`) — the badge's appearance field, kept
 * separate from its display-name/title. */
export interface ThemeItemDescriptionChange {
  item_kind: 'object' | 'decor' | 'character' | 'rival' | 'crate' | 'poof' | 'badge' | 'expression';
  id: string;
  description: string;
}

export interface ThemeItemDescriptionChangeResult {
  applied: ThemeItemDescriptionChange[];
  rejected: Array<{ item_kind: string; id: string; reason: string }>;
}

/** Pad `list` (or start a new array) so index `index` exists, then set it. Never
 * mutates the input array in place — callers assign the return value back onto
 * the plan field, keeping `plan` safe to hand to multiple call sites. */
function setPlanDescriptionAt(list: string[] | undefined, index: number, value: string): string[] {
  const arr = list ? [...list] : [];
  while (arr.length <= index) arr.push('');
  arr[index] = value;
  return arr;
}

/**
 * Pure core of the theme-review "Descriptions" editor's batched Apply: mutates
 * `plan` in place (never `manifest` — descriptions are prompt-layer text that
 * lives in plan.json's `character_descriptions` / `object_descriptions` /
 * `decor_descriptions` / `enemy_descriptions` arrays, or (for 'crate'/'poof')
 * the single `crate_description` / `poof_description` strings, NOT the shared
 * manifest contract; see applyThemeItemNameChanges for the contrasting
 * manifest-display-name path this deliberately does NOT follow). `manifest` is
 * read-only here, used only to resolve each row id to its positional index in
 * the matching plan array (object/decor/rival indices mirror
 * manifest.buildable_objects/decor_objects/roster_rivals order — see
 * themeObjectSpecs/themeDecorSpecs/themeRivalSpecs; character index is
 * the agent's slot_id, matching plan.character_descriptions[agent.slot_id] as read
 * in createReviewItems/buildCharacterAtlasPrompt).
 *
 * An empty (or whitespace-only) description is a valid, applied change — it CLEARS
 * that row's description, unlike applyThemeItemNameChanges which rejects an empty
 * name. Only an unknown id is rejected. Exported for unit testing.
 */
export function applyThemeItemDescriptionChanges(
  manifest: ThemeManifest,
  plan: ThemePlan,
  changes: ThemeItemDescriptionChange[],
): ThemeItemDescriptionChangeResult {
  const applied: ThemeItemDescriptionChange[] = [];
  const rejected: Array<{ item_kind: string; id: string; reason: string }> = [];
  for (const change of changes) {
    const description = (change.description ?? '').trim();
    if (change.item_kind === 'object') {
      const index = manifest.buildable_objects?.findIndex((candidate) => candidate.object_id === change.id) ?? -1;
      if (index < 0) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown object "${change.id}".` });
        continue;
      }
      plan.object_descriptions = setPlanDescriptionAt(plan.object_descriptions, index, description);
    } else if (change.item_kind === 'decor') {
      const index = manifest.decor_objects?.findIndex((candidate) => candidate.decor_id === change.id) ?? -1;
      if (index < 0) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown decor item "${change.id}".` });
        continue;
      }
      plan.decor_descriptions = setPlanDescriptionAt(plan.decor_descriptions, index, description);
    } else if (change.item_kind === 'rival') {
      // Same stripped/full rival_id matching as applyThemeItemNameChanges — the
      // webview's rival_rows carry the `rival_` prefix stripped (see themeRivalSpecs).
      const index = manifest.roster_rivals?.findIndex((candidate) => (
        candidate.rival_id === change.id || candidate.rival_id === `rival_${change.id}`
      )) ?? -1;
      if (index < 0) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown rival "${change.id}".` });
        continue;
      }
      plan.enemy_descriptions = setPlanDescriptionAt(plan.enemy_descriptions, index, description);
    } else if (change.item_kind === 'character') {
      const agentMatch = /^agent_(\d+)$/.exec(change.id);
      const slotId = agentMatch ? Number(agentMatch[1]) : -1;
      const agent = slotId >= 0 ? manifest.roster_agents?.find((candidate) => candidate.slot_id === slotId) : undefined;
      if (!agent) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown character "${change.id}".` });
        continue;
      }
      plan.character_descriptions = setPlanDescriptionAt(plan.character_descriptions, agent.slot_id, description);
    } else if (change.item_kind === 'badge') {
      // Badge/achievement descriptions are POSITIONAL: rowId is
      // `achievement_<index>` (see themeReviewDescriptionRows), aligning to
      // plan.achievement_descriptions[idx] / plan.achievements[idx]. Mirror the
      // object branch: pad the array to the badge index and set it.
      const badgeMatch = /^achievement_(\d+)$/.exec(change.id);
      const badgeIndex = badgeMatch ? Number(badgeMatch[1]) : -1;
      if (badgeIndex < 0 || badgeIndex >= THEME_ACHIEVEMENT_COUNT) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown badge "${change.id}".` });
        continue;
      }
      plan.achievement_descriptions = setPlanDescriptionAt(plan.achievement_descriptions, badgeIndex, description);
    } else if (change.item_kind === 'expression') {
      // Expression descriptions are POSITIONAL: rowId is `expression_<index>`
      // (see themeReviewDescriptionRows), aligning to
      // plan.expression_descriptions[idx] / plan.expressions[idx]. Mirror the
      // badge branch: pad the array to the expression index and set it. The
      // expression LABELS are fixed (FIXED_EXPRESSION_LABELS) and never edited;
      // only the per-cell appearance text lives here.
      const expressionMatch = /^expression_(\d+)$/.exec(change.id);
      const expressionIndex = expressionMatch ? Number(expressionMatch[1]) : -1;
      if (expressionIndex < 0 || expressionIndex >= THEME_EXPRESSION_COUNT) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown expression "${change.id}".` });
        continue;
      }
      plan.expression_descriptions = setPlanDescriptionAt(plan.expression_descriptions, expressionIndex, description);
    } else if (change.item_kind === 'crate') {
      // Single field, not an indexed array — exactly one crate per theme.
      plan.crate_description = description;
    } else if (change.item_kind === 'poof') {
      // Single field, not an indexed array — exactly one poof per theme.
      plan.poof_description = description;
    } else {
      const unknownKind = (change as { item_kind: string }).item_kind;
      rejected.push({ item_kind: unknownKind, id: change.id, reason: `Unknown item kind "${unknownKind}".` });
      continue;
    }
    applied.push({ item_kind: change.item_kind, id: change.id, description });
  }
  return { applied, rejected };
}

/**
 * Pure core of the description-driven prompt resync — the "Descriptions" editor's
 * counterpart to resyncRenamedReviewItems. Unlike renaming, a character description
 * edit has NO other sync path (RENAME_THEME_CHARACTER only handles the character's
 * NAME), so character_atlas boards are included here — the one difference from
 * resyncRenamedReviewItems's affected-board detection, which deliberately excludes
 * them. Exported for unit testing.
 */
export function resyncDescriptionReviewItems(
  document: Pick<ThemeImageReviewDocument, 'items'>,
  manifest: ThemeManifest,
  plan: ThemePlan,
  applied: ThemeItemDescriptionChange[],
): ThemeImageReviewItem[] {
  const affectedIds = new Set(applied.map((change) => change.id));
  if (!affectedIds.size) return [];
  // crate/poof descriptions are single plan fields (not row-indexed), so they
  // always affect the fixed 'objects_02' board rather than a specific row id.
  const crateOrPoofChanged = applied.some((change) => change.item_kind === 'crate' || change.item_kind === 'poof');
  // Badge descriptions are positional plan fields (achievement_<index>), so any
  // badge change affects the single fixed 'achievements' board rather than a
  // roster-matched row id.
  const badgeChanged = applied.some((change) => change.item_kind === 'badge');
  // Expression descriptions are positional plan fields (expression_<index>), so
  // any expression change affects the single fixed 'expressions' board rather
  // than a roster-matched row id (mirrors the badge/achievements case).
  const expressionChanged = applied.some((change) => change.item_kind === 'expression');

  const affectedBoardIds = new Set<string>();
  for (const item of document.items) {
    if (item.kind === 'object_atlas' && (item.object_rows?.some(
      (row) => (row.kind === 'object_static' || row.kind === 'object_anim') && affectedIds.has(row.object_id),
    ) || (crateOrPoofChanged && item.id === 'objects_02'))) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'background_decor_atlas' && item.decor_rows?.some(
      (row) => row.kind !== 'projectile' && affectedIds.has(row.decor_id),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'rival_atlas' && item.rival_rows?.some(
      (row) => affectedIds.has(row.rival_id) || affectedIds.has(`rival_${row.rival_id}`),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'character_atlas' && affectedIds.has(item.id)) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'achievement_atlas' && badgeChanged) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'expression_atlas' && expressionChanged) {
      affectedBoardIds.add(item.id);
    }
  }
  if (!affectedBoardIds.size) return [];

  const expectedItems = createReviewItems(
    plan,
    manifest,
    themePlanCreativeDirection(plan),
    boardBackgroundModeForProvider(undefined),
  ).filter((item) => affectedBoardIds.has(item.id));
  const savedItems = document.items.filter((item) => affectedBoardIds.has(item.id));

  return mergeResumedReviewItems(expectedItems, savedItems) as ThemeImageReviewItem[];
}

/**
 * Thin IO wrapper around applyThemeItemDescriptionChanges: loads the theme's
 * manifest (read-only, for id resolution) and its saved plan.json, applies the
 * batch, and writes ONLY the plan back — descriptions never touch the manifest
 * (contrast renameThemeItemsBatch, which writes the manifest). Mirrors the
 * badge-rename branch of resyncRenamedBoardPrompts (plan write + resync), never
 * the manifest-display-name path the rest of that function follows for object/
 * decor/character/rival renames.
 */
export async function updateThemeItemDescriptionsBatch(
  globalStorageUri: vscode.Uri,
  themeId: string,
  changes: ThemeItemDescriptionChange[],
): Promise<ThemeItemDescriptionChangeResult> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  if (!changes.length) throw new Error('No description changes were provided.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be updated.');
  const { manifest } = loadedTheme;

  const savedPlan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
    ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
  if (!savedPlan) throw new Error('This theme has no saved plan — descriptions require plan.json.');
  const plan = normalizeThemePlan(savedPlan, manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');

  const result = applyThemeItemDescriptionChanges(manifest, plan, changes);
  if (result.applied.length) {
    await vscode.workspace.fs.writeFile(themePlanUri(globalStorageUri, themeId), jsonBuffer(plan));
    try {
      const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
      if (document) {
        const refreshed = resyncDescriptionReviewItems(document, manifest, plan, result.applied);
        for (const item of refreshed) {
          await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, item);
        }
      }
    } catch (err) {
      console.warn('TycoonAgents: unable to resync review-board prompts after description change:', err);
    }
  }
  return result;
}

/** Regenerate one character board, then fit its frames to production scale. */
export async function normalizeThemeCharacterAtlas(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  imageGenerationOptions: ThemeImageGenerationOptions,
  onProgress?: (message: string) => void,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) throw new Error('Review image metadata was not found.');
  if (item.kind !== 'character_atlas') {
    throw new Error('Only character sprite boards can be size-normalized.');
  }

  // Match the padding language of the board that will actually be regenerated
  // (the merged 'augment' prompt appends these notes onto the ORIGINAL saved
  // prompt, so contradicting its background contract — e.g. demanding magenta
  // padding on a board originally baked transparent for OpenAI — would confuse
  // the model).
  const paddingAdjective = boardBackgroundPaddingAdjective(
    boardBackgroundModeForProvider(imageGenerationOptions.provider),
  );
  const notes = [
    'Regenerate this character sprite board at the universal production character scale.',
    'Use an exact 512 x 512 pixel generation canvas with the 5-column by 4-row layout from the original prompt.',
    `In every walking and neutral-standing cell, the complete character from head to feet must occupy exactly ${CHARACTER_TARGET_CONTENT_PERCENT}% of that cell height.`,
    `Override any earlier feet-on-edge guidance: leave visible ${paddingAdjective} padding above and below every sprite so no pixels touch or cross a horizontal row boundary.`,
    `Keep the complete fourth row, including every foot and piece of equipment, inside the canvas with ${paddingAdjective} padding below it.`,
    'Keep the same character identity, costume, colors, pixel-art style, poses, and cell order.',
  ].join(' ');

  return retryThemeImage(
    globalStorageUri,
    themeId,
    itemId,
    notes,
    'augment',
    { ...imageGenerationOptions, aspectRatio: '1:1' },
    onProgress,
  );
}

export async function approveAllThemeImages(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<ThemeImageReviewDocument> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  const review = await getThemeImageReview(globalStorageUri, themeId);
  if (!review.entries.length) throw new Error('This theme has no reviewable images.');
  const missingCount = review.entries.filter((entry) => !entry.imageUri).length;
  if (missingCount > 0) {
    throw new Error(`Wait for all theme images to finish before approving all (${missingCount} missing).`);
  }
  const document = await acceptAllThemeImageReviewItems(globalStorageUri, themeId);
  if (!document) throw new Error('This theme has no reviewable images.');
  return document;
}

export async function generateTheme(
  globalStorageUri: vscode.Uri,
  requestedPlan: ThemePlan | string,
  onProgress: (message: string) => void,
  isCancelled?: () => boolean,
  onReviewReady?: (themeId: string) => void,
  imageGenerationOptions?: ThemeImageGenerationOptions,
  waitForReview?: WaitForThemeImageReview,
): Promise<ThemeGenerationResult> {
  onProgress(typeof requestedPlan === 'string' ? 'Planning theme...' : 'Preparing theme...');
  const plan = normalizeThemePlan(
    typeof requestedPlan === 'string'
      ? await expandThemePlan(requestedPlan, imageGenerationOptions)
      : requestedPlan,
    typeof requestedPlan === 'string' ? requestedPlan : requestedPlan.display_name,
  );
  const themeId = plan.theme_id;
  const creativeDirection = themePlanCreativeDirection(plan);
  const suggestedManifest = themePlanToManifest(plan);
  const manifest: ThemeManifest = {
    manifest_version: '1.0.0',
    theme_id: themeId,
    display_name: plan.display_name,
    author: 'TycoonAgents Factory',
    viewport: suggestedManifest.viewport!,
    roster_agents: suggestedManifest.roster_agents!,
    roster_rivals: suggestedManifest.roster_rivals!,
    buildable_objects: suggestedManifest.buildable_objects!,
    decor_objects: suggestedManifest.decor_objects!,
    badges: buildDefaultBadges(),
  };
  const frames: Record<string, string[]> = {};
  const directoryUri = themeDirectoryUri(globalStorageUri, themeId);
  const reviewDirectoryUri = themeImagesDirectoryUri(globalStorageUri, themeId);
  await vscode.workspace.fs.createDirectory(directoryUri);
  await vscode.workspace.fs.createDirectory(reviewDirectoryUri);
  await vscode.workspace.fs.writeFile(themePlanUri(globalStorageUri, themeId), jsonBuffer(plan));

  // Regenerating an existing theme must not wipe out Stage Editor viewport
  // tuning the user already dialed in. A missing old manifest (brand-new
  // theme) is expected and must not fail generation.
  try {
    const oldManifest = await loadThemeManifest(globalStorageUri, themeId);
    if (oldManifest) preserveViewportTuning(manifest.viewport, oldManifest.viewport);
  } catch {
    // No existing manifest to preserve tuning from — proceed with the fresh one.
  }

  await writeThemeFiles(globalStorageUri, manifest, frames);

  const reviewItems = createReviewItems(
    plan,
    manifest,
    creativeDirection,
    boardBackgroundModeForProvider(imageGenerationOptions?.provider),
  );
  await initializeThemeImageReviewDocument(globalStorageUri, themeId, plan.display_name, reviewItems);
  onReviewReady?.(themeId);

  return continueThemeGeneration(
    globalStorageUri,
    plan,
    manifest,
    frames,
    reviewItems,
    onProgress,
    isCancelled,
    onReviewReady,
    imageGenerationOptions,
    waitForReview,
  );
}

/** Continue an interrupted theme without replacing images and decisions already on disk. */
export async function resumeThemeGeneration(
  globalStorageUri: vscode.Uri,
  themeId: string,
  onProgress: (message: string) => void,
  isCancelled?: () => boolean,
  onReviewReady?: (themeId: string) => void,
  imageGenerationOptions?: ThemeImageGenerationOptions,
  waitForReview?: WaitForThemeImageReview,
): Promise<ThemeGenerationResult> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  onProgress('Loading interrupted generation...');

  const savedPlan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
    ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  if (!savedPlan || !loadedTheme || !document) {
    throw new Error('This theme does not contain enough saved generation state to resume.');
  }

  const plan = normalizeThemePlan(savedPlan, loadedTheme.manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('The saved theme plan does not match this theme.');
  const expectedItems = createReviewItems(
    plan,
    loadedTheme.manifest,
    themePlanCreativeDirection(plan),
    boardBackgroundModeForProvider(imageGenerationOptions?.provider),
  );
  const reviewItems = mergeResumedReviewItems(expectedItems, document.items);

  // Repair any missing review rows while retaining statuses, prompts, revisions,
  // and timestamps for every item that survived the interrupted run.
  await initializeThemeImageReviewDocument(
    globalStorageUri,
    themeId,
    document.display_name,
    reviewItems,
  );
  onReviewReady?.(themeId);
  onProgress('Resuming unfinished image generations...');

  return continueThemeGeneration(
    globalStorageUri,
    plan,
    loadedTheme.manifest,
    loadedTheme.frames,
    reviewItems,
    onProgress,
    isCancelled,
    onReviewReady,
    imageGenerationOptions,
    waitForReview,
  );
}

async function continueThemeGeneration(
  globalStorageUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  reviewItems: Array<Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string }>,
  onProgress: (message: string) => void,
  isCancelled?: () => boolean,
  onReviewReady?: (themeId: string) => void,
  imageGenerationOptions?: ThemeImageGenerationOptions,
  waitForReview?: WaitForThemeImageReview,
): Promise<ThemeGenerationResult> {
  const themeId = plan.theme_id;
  const reviewDirectoryUri = themeImagesDirectoryUri(globalStorageUri, themeId);

  const agentBoardIds = new Set(buildBoardItems(plan, manifest, 'agents').map((candidate) => candidate.id));
  const agentItems = reviewItems.filter((item) => agentBoardIds.has(item.id));

  for (let index = 0; index < agentItems.length; index++) {
    throwIfCancelled(isCancelled);
    const item = agentItems[index];
    const name = item.subject ?? item.label;
    onProgress(`${name} (${index + 1}/${agentItems.length})`);
    await runNonFatalBoardStep(name, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri,
        themeId,
        plan.display_name,
        item,
        manifest,
        frames,
        onProgress,
        isCancelled,
        onReviewReady,
        waitForReview,
        () => generateAgentAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          item, imageGenerationOptions, onProgress,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const enemyBoardIds = new Set(buildBoardItems(plan, manifest, 'enemy').map((candidate) => candidate.id));
  const rivalItems = reviewItems.filter((item) => enemyBoardIds.has(item.id));
  for (let index = 0; index < rivalItems.length; index++) {
    throwIfCancelled(isCancelled);
    const rivalsItem = rivalItems[index];
    await runNonFatalBoardStep(rivalsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri, themeId, plan.display_name, rivalsItem, manifest, frames,
        onProgress, isCancelled, onReviewReady, waitForReview,
        () => generateRivalAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          rivalsItem, imageGenerationOptions, onProgress,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const environmentBoardIds = new Set(buildBoardItems(plan, manifest, 'environment').map((candidate) => candidate.id));
  const environmentItem = reviewItems.find((item) => environmentBoardIds.has(item.id))!;
  await runNonFatalBoardStep(environmentItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
    generateOrResumeThemeItem(
      globalStorageUri, themeId, plan.display_name, environmentItem, manifest, frames,
      onProgress, isCancelled, onReviewReady, waitForReview,
      () => generateEnvironmentAsset(
        globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
        environmentItem, imageGenerationOptions, onProgress,
      ),
    ),
  );

  throwIfCancelled(isCancelled);
  const decorBoardIds = new Set(buildBoardItems(plan, manifest, 'decor').map((candidate) => candidate.id));
  const decorItem = reviewItems.find((item) => decorBoardIds.has(item.id));
  if (decorItem) {
    await runNonFatalBoardStep(decorItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri, themeId, plan.display_name, decorItem, manifest, frames,
        onProgress, isCancelled, onReviewReady, waitForReview,
        () => generateDecorAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          decorItem, imageGenerationOptions, onProgress,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const objectBoardIds = new Set(buildBoardItems(plan, manifest, 'objects').map((candidate) => candidate.id));
  const objectItems = reviewItems.filter((item) => objectBoardIds.has(item.id));
  for (let index = 0; index < objectItems.length; index++) {
    throwIfCancelled(isCancelled);
    const objectsItem = objectItems[index];
    await runNonFatalBoardStep(objectsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri, themeId, plan.display_name, objectsItem, manifest, frames,
        onProgress, isCancelled, onReviewReady, waitForReview,
        () => generateObjectAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          objectsItem, imageGenerationOptions, onProgress, 21 + index,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const expressionsBoardIds = new Set(buildBoardItems(plan, manifest, 'expressions').map((candidate) => candidate.id));
  const expressionsItem = reviewItems.find((item) => expressionsBoardIds.has(item.id))!;
  await runNonFatalBoardStep(expressionsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
    generateOrResumeThemeItem(
      globalStorageUri, themeId, plan.display_name, expressionsItem, manifest, frames,
      onProgress, isCancelled, onReviewReady, waitForReview,
      () => generateExpressionAsset(
        globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
        expressionsItem, imageGenerationOptions, onProgress,
      ),
    ),
  );

  throwIfCancelled(isCancelled);
  const achievementsBoardIds = new Set(buildBoardItems(plan, manifest, 'achievements').map((candidate) => candidate.id));
  const achievementsItem = reviewItems.find((item) => achievementsBoardIds.has(item.id))!;
  await runNonFatalBoardStep(achievementsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
    generateOrResumeThemeItem(
      globalStorageUri, themeId, plan.display_name, achievementsItem, manifest, frames,
      onProgress, isCancelled, onReviewReady, waitForReview,
      () => generateAchievementAsset(
        globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
        achievementsItem, imageGenerationOptions, onProgress,
      ),
    ),
  );

  throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
  await writeThemeFiles(globalStorageUri, manifest, frames);
  throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
  return { manifest, frames };
}

/**
 * Regenerates a single board of an EXISTING theme (e.g. just the enemy
 * board) and merges only that board's frames into the theme's persisted
 * frames.json, leaving every other board untouched. Uses the same plan and
 * the same buildBoardItems selection as full generation, so the regenerated
 * board picks up current layout/prompt logic (e.g. a new enemy 2-walk/
 * 3-attack row layout) without requiring a full theme regen.
 */
export async function regenerateThemeBoard(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  themeId: string,
  board: BoardKind,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
  itemId?: string,
): Promise<void> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const savedPlan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
    ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
  if (!savedPlan) {
    throw new Error(`No saved plan was found for theme "${themeId}". Regenerate the full theme first.`);
  }

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error(`Theme "${themeId}" was not found.`);
  const { manifest, frames } = loadedTheme;
  const plan = normalizeThemePlan(savedPlan, manifest.display_name);

  let items = buildBoardItems(plan, manifest, board, boardBackgroundModeForProvider(options?.provider));
  if (itemId) {
    items = items.filter((candidate) => candidate.id === itemId);
    if (!items.length) throw new Error(`No regenerable image with id "${itemId}" was found on board "${board}".`);
  }
  if (!items.length) throw new Error(`No regenerable images were found for board "${board}".`);

  await vscode.workspace.fs.createDirectory(reviewDirectoryUri);

  for (let index = 0; index < items.length; index++) {
    throwIfCancelled(undefined, options?.signal);
    const item = items[index];
    onProgress(`${item.label} (${index + 1}/${items.length})`);
    switch (board) {
      case 'agents':
        await generateAgentAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'enemy':
        await generateRivalAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'environment':
        await generateEnvironmentAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'decor':
        await generateDecorAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'objects':
        await generateObjectAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress, index + 1,
        );
        break;
      case 'expressions':
        await generateExpressionAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'achievements':
        await generateAchievementAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      default:
        throw new Error(`Unsupported board type "${board}".`);
    }
  }

  throwIfCancelled(undefined, options?.signal);
  // Re-sync display names from the (normalized) plan so Edit Stage labels match
  // the regenerated art. themePlanToManifest assigns names by array index
  // (buildable_objects[i] <- plan.objects[i], decor_objects[i] <- plan.decor[i]);
  // mirror that exact positional mapping here. Guard length mismatches by only
  // syncing overlapping indices, and touch ONLY display_name so object_id /
  // decor_id / build_order / all other fields are preserved. Idempotent: a
  // no-op when names already match.
  if (board === 'objects' && manifest.buildable_objects) {
    const count = Math.min(manifest.buildable_objects.length, plan.objects.length);
    for (let i = 0; i < count; i++) {
      manifest.buildable_objects[i].display_name = plan.objects[i];
    }
  } else if (board === 'decor' && manifest.decor_objects) {
    const count = Math.min(manifest.decor_objects.length, plan.decor.length);
    for (let i = 0; i < count; i++) {
      manifest.decor_objects[i].display_name = plan.decor[i];
    }
  }
  await writeThemeFiles(globalStorageUri, manifest, frames);
  onProgress(`${board} board regenerated.`);
}

/**
 * Runs a single board-generation step without letting its failure abort the
 * rest of the pipeline. User cancellation (isCancelled() true or the abort
 * signal firing) is rethrown untouched so it still propagates. Any other
 * failure is logged via onProgress and swallowed, leaving that board's
 * manifest/frame entries absent so the webview falls back to a placeholder.
 */
async function runNonFatalBoardStep(
  label: string,
  onProgress: (message: string) => void,
  isCancelled: (() => boolean) | undefined,
  signal: AbortSignal | undefined,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (isCancelled?.() || signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    onProgress(`${label} failed and was skipped: ${message}`);
  }
}

/**
 * Slice a raw atlas `buffer` for `item` into `frames`/`manifest`, write the
 * normalized review image, keep the raw pre-slice atlas, and persist the theme
 * files. Shared by retryThemeImage (buffer from the image API) and
 * resliceThemeImageFromRaw (buffer read back from disk, no API call) so both
 * paths use IDENTICAL slicing + persist behavior. Row metadata is reconstructed
 * from the CURRENT manifest via the *RowsForItem helpers. Returns the normalized
 * output plus the frame keys the caller should record on the review item.
 */
async function applySlicedAtlasFromBuffer(
  globalStorageUri: vscode.Uri,
  themeId: string,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: ThemeImageReviewItem,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<{ output: Buffer; frameKeys: string[] }> {
  let output = buffer;
  let frameKeys = item.frame_keys;
  // Captured before any branch reassigns frameKeys, so it always reflects
  // this item's frame keys as of the START of this (possibly slow) operation.
  // Used below to scope the final frames.json write to just the keys this
  // operation actually owns — see the writeThemeFiles call at the bottom.
  const previousFrameKeys = item.frame_keys;

  if (item.kind === 'character_atlas') {
    const characterAtlas = await processCharacterAtlas(buffer, manifest);
    output = characterAtlas.output;
    const spritePackage = characterAtlas.spritePackage;
    const frameKey = item.frame_keys[0] || item.id;
    frames[frameKey] = spritePackage.slots.map((slot) => slot.data);
    frameKeys = [frameKey];
  } else if (item.kind === 'rival_atlas') {
    const rows = rivalRowsForItem(item, manifest);
    item.rival_rows = rows;
    const rivalAtlas = await processRivalAtlas(buffer, manifest, rows);
    output = rivalAtlas.output;
    frameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
    removeStaleBoardFrameKeys(frames, previousFrameKeys, frameKeys);
  } else if (item.kind === 'environment') {
    output = await normalizeEnvironmentImage(buffer);
    frames.environment_background = [dataUri(output)];
    manifest.viewport.background_asset = 'frames.json#environment_background';
    frameKeys = ['environment_background'];
  } else if (item.kind === 'object_atlas') {
    // Reconstruct object_rows from the CURRENT manifest as the primary source
    // (see objectRowsForItem) so a roster change (e.g. objects added/renamed)
    // regenerates the correct board instead of reusing stale saved object_rows.
    const rows = objectRowsForItem(item, manifest);
    item.object_rows = rows;
    const objectAtlas = await processObjectAtlas(buffer, manifest, rows);
    output = objectAtlas.output;
    frameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, rows);
    // Self-healing re-slice: if the roster shift means this board no longer owns
    // e.g. 'poof'/'crate' (they moved to a later board once the object count grew),
    // drop those stale keys from THIS board's own previous ownership so they don't
    // keep clobbering whatever board correctly owns them now — scoped strictly to
    // keys this item itself previously wrote, so other boards' keys are untouched
    // regardless of re-slice order.
    removeStaleBoardFrameKeys(frames, previousFrameKeys, frameKeys);
  } else if (item.kind === 'background_decor_atlas') {
    // Reconstruct decor_rows from the CURRENT manifest as the primary source
    // (see decorRowsForItem) so a decor roster change regenerates the correct
    // board instead of reusing stale saved decor_rows.
    const rows = decorRowsForItem(item, manifest);
    const decorAtlas = await processDecorAtlas(buffer, manifest);
    output = decorAtlas.output;
    frameKeys = applyDecorBoardFrames(frames, decorAtlas.spritePackage.slots, rows);
    manifest.viewport.projectile_asset = 'frames.json#projectile';
    item.decor_rows = rows;
  } else if (item.kind === 'expression_atlas') {
    output = await optimizeSpriteBoardCanvas(buffer, 4, 2);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 2 });
    frameKeys = applyExpressionFrames(frames, spritePackage.slots);
  } else if (item.kind === 'achievement_atlas') {
    output = await optimizeSpriteBoardCanvas(buffer, 5, 5);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 5, rows: 5 });
    frameKeys = applyAchievementFrames(frames, spritePackage.slots);
  } else {
    output = await optimizeSpriteBoard(buffer);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest);
    frameKeys = applyLegacyEmoteFrames(frames, spritePackage.slots);
  }

  throwIfCancelled(undefined, signal);
  const reviewDirectoryUri = themeImagesDirectoryUri(globalStorageUri, themeId);
  await vscode.workspace.fs.createDirectory(reviewDirectoryUri);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(reviewDirectoryUri, item.filename), output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  // (Harmless on the re-slice path: it re-saves the same bytes we just read.)
  await persistRawAtlas(globalStorageUri, themeId, item.filename, buffer);
  // Merge-safe write: retryThemeImage/resliceThemeImageFromRaw load frames.json
  // once at the START of this operation, then this function runs a slow
  // image-generation API call before reaching this write. If a DIFFERENT
  // board's retry loaded its own frames.json snapshot in between and finishes
  // (and writes) before this one does, a blind overwrite here would silently
  // revert that other board's frames back to the stale snapshot this call
  // started with — e.g. a background-decor regen's new art getting reverted by
  // a slower, later-finishing object-board regen. Scoping the write to just
  // the keys THIS item owns (its new frame keys plus any it just dropped)
  // avoids that lost-update race; every other key defers to disk.
  await writeThemeFiles(globalStorageUri, manifest, frames, [
    ...new Set([...frameKeys, ...previousFrameKeys]),
  ]);
  return { output, frameKeys };
}

/** Sliceable atlas kinds that can be re-sliced from a saved raw atlas. */
const RESLICEABLE_ATLAS_KINDS: ReadonlySet<ThemeImageKind> = new Set([
  'character_atlas',
  'rival_atlas',
  'object_atlas',
  'background_decor_atlas',
  'expression_atlas',
  'achievement_atlas',
] as ThemeImageKind[]);

/**
 * Re-run slicing for a board using the RAW atlas already saved to disk, WITHOUT
 * calling the image API. This lets slicing fixes apply to existing themes for
 * free. Environment boards are not sliced (they normalize a single image) and so
 * cannot be re-sliced. Returns the updated manifest+frames on success, or a
 * `reason` the caller can surface to the user on failure.
 */
export async function resliceThemeImageFromRaw(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
): Promise<{ ok: true; manifest: ThemeManifest; frames: Record<string, string[]> } | { ok: false; reason: string }> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) return { ok: false, reason: 'Item not found' };
  if (!RESLICEABLE_ATLAS_KINDS.has(item.kind)) {
    return { ok: false, reason: 'This board type cannot be re-sliced' };
  }
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) return { ok: false, reason: 'The saved theme is incomplete and cannot be re-sliced yet.' };

  const rawUri = vscode.Uri.joinPath(themeRawImagesDirectoryUri(globalStorageUri, themeId), item.filename);
  if (!(await uriExists(rawUri))) {
    return {
      ok: false,
      reason: 'No saved original to re-slice — regenerate this board once to enable re-slicing',
    };
  }
  const rawBuffer = Buffer.from(await vscode.workspace.fs.readFile(rawUri));

  const { manifest, frames } = loadedTheme;
  const { frameKeys } = await applySlicedAtlasFromBuffer(
    globalStorageUri,
    themeId,
    manifest,
    frames,
    item,
    rawBuffer,
  );
  await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
    ...item,
    status: 'pending',
    generation_error: undefined,
    revision: item.revision + 1,
    frame_keys: frameKeys,
    updated_at: new Date().toISOString(),
  });
  return { ok: true, manifest, frames };
}

/**
 * Load the theme's CURRENT plan.json (not a stale review-item snapshot) so
 * callers can rebuild a fresh prompt reflecting any plan/roster changes since
 * an item was first generated. Shared by retryThemeImage (the 'retry'/
 * 'augment' fresh-base prompt) and the image-review "current prompt" preview.
 * Falls back to undefined for legacy themes with no plan.json, or a plan
 * whose theme_id no longer matches (renamed/mismatched) — callers then fall
 * back to the item's stale saved prompt.
 */
export async function loadCurrentThemePlan(
  globalStorageUri: vscode.Uri,
  themeId: string,
  displayNameFallback: string,
): Promise<ThemePlan | undefined> {
  const savedPlan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
    ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
  const normalizedPlan = savedPlan ? normalizeThemePlan(savedPlan, displayNameFallback) : undefined;
  return normalizedPlan?.theme_id === themeId ? normalizedPlan : undefined;
}

export async function retryThemeImage(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  feedback: string,
  mode: ThemeImageRetryMode,
  imageGenerationOptions: ThemeImageGenerationOptions,
  onProgress?: (message: string) => void,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> }> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) throw new Error('Review image metadata was not found.');
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be retried yet.');
  const notes = feedback.trim();

  // Legacy themes (pre-animated boards) stored object-atlas items without
  // object_rows. Reconstruct a 5-row animated board so every object-atlas retry
  // takes the animated buildObjectAtlasPrompt / processObjectAtlas path.
  if (item.kind === 'object_atlas' && !item.object_rows?.length) {
    item.object_rows = reconstructObjectRows(item, loadedTheme.manifest);
  }

  // Prefer the CURRENT saved plan's expression/achievement names over the review
  // item's saved names, so a retry after the plan's roster changed re-bakes the
  // current set instead of the stale one. Missing/unparsable plan.json is
  // non-fatal: buildReplacementPrompt falls back to the item's saved names, then
  // generic defaults.
  const currentPlan = await loadCurrentThemePlan(globalStorageUri, themeId, loadedTheme.manifest.display_name);
  const backgroundMode = boardBackgroundModeForProvider(imageGenerationOptions.provider);

  // 'replace' explicitly swaps the theme's creative direction for the user's
  // typed notes — that is what "replace" means.
  const replacementPrompt = buildReplacementPrompt(item, notes, loadedTheme.manifest, currentPlan, backgroundMode);
  // 'retry'/'augment' instead reroll the CURRENT template + manifest while
  // keeping the theme's OWN creative direction (from plan.json), not the
  // retry notes — a "reroll the current contract" refresh, not a content
  // swap. This is what makes retry/augment pick up prompt-template fixes
  // (e.g. a margin rule added in a later release) that shipped after this
  // item was first generated, instead of forever replaying whatever template
  // was current back then (see selectThemeImageRetryPrompt for the full
  // rationale). Falls back to the stale saved prompt only when plan.json is
  // missing/mismatched (rare) — no worse than the old always-stale behavior.
  const freshBasePrompt = currentPlan
    ? buildReplacementPrompt(item, themePlanCreativeDirection(currentPlan), loadedTheme.manifest, currentPlan, backgroundMode)
    : item.prompt;
  const prompt = selectThemeImageRetryPrompt(freshBasePrompt, replacementPrompt, feedback, mode);
  onProgress?.(`Regenerating ${item.label}...`);

  let generated: Buffer;
  try {
    generated = item.kind === 'environment'
      ? await generateEnvironmentImage(prompt, imageGenerationOptions)
      : await generateThemeImage(prompt, spriteBoardOptions(imageGenerationOptions));
  } catch (error) {
    await recordUserCorrectableGenerationError(globalStorageUri, themeId, item.id, error);
    throw error;
  }
  throwIfCancelled(undefined, imageGenerationOptions.signal);
  const { manifest, frames } = loadedTheme;
  const { frameKeys } = await applySlicedAtlasFromBuffer(
    globalStorageUri,
    themeId,
    manifest,
    frames,
    item,
    generated,
    imageGenerationOptions.signal,
  );
  await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
    ...item,
    status: 'pending',
    generation_error: undefined,
    prompt,
    revision: item.revision + 1,
    frame_keys: frameKeys,
    updated_at: new Date().toISOString(),
  });
  onProgress?.(`${item.label} regenerated and ready for review.`);
  return { manifest, frames };
}

async function generateOrResumeThemeItem(
  globalStorageUri: vscode.Uri,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string },
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  onProgress: (message: string) => void,
  isCancelled: (() => boolean) | undefined,
  onReviewReady: ((themeId: string) => void) | undefined,
  waitForReview: WaitForThemeImageReview | undefined,
  generate: () => Promise<void>,
): Promise<void> {
  throwIfCancelled(isCancelled);
  const imageUri = vscode.Uri.joinPath(themeImagesDirectoryUri(globalStorageUri, themeId), item.filename);
  const complete = isThemeGenerationItemComplete(item, await uriExists(imageUri), frames);
  throwIfCancelled(isCancelled);

  // Completed items are the checkpoint. Resume advances directly to the first
  // unfinished item and never spends another provider request on earlier work.
  if (complete) return;

  // A safety-blocked item needs revised user direction, not an automatic replay
  // of the same request. Restore the same replacement gate used by a live run.
  if (item.generation_error) {
    const review = waitForReview?.(themeId, item.id, { requiresReplacement: true });
    onReviewReady?.(themeId);
    onProgress(`${item.label} still needs revised instructions before generation can continue.`);
    if (!review) throw new Error(`${item.label} needs revised instructions before generation can continue.`);
    const replacement = await review;
    if (!replacement) throw new Error(`${item.label} needs a generated replacement before generation can continue.`);
    applyThemeReplacement(manifest, frames, replacement);
    return;
  }

  await generateAndReviewThemeItem(
    globalStorageUri,
    themeId,
    displayName,
    item,
    manifest,
    frames,
    onProgress,
    onReviewReady,
    waitForReview,
    generate,
  );
}

async function generateAndReviewThemeItem(
  globalStorageUri: vscode.Uri,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  onProgress: (message: string) => void,
  onReviewReady: ((themeId: string) => void) | undefined,
  waitForReview: WaitForThemeImageReview | undefined,
  generate: () => Promise<void>,
): Promise<void> {
  try {
    await generate();
  } catch (error) {
    const recorded = await recordUserCorrectableGenerationError(
      globalStorageUri,
      themeId,
      item.id,
      error,
    );
    if (!recorded) throw error;

    const review = waitForReview?.(themeId, item.id, { requiresReplacement: true });
    onReviewReady?.(themeId);
    onProgress(`${item.label} was blocked by the image safety check. Revise its instructions and retry to continue.`);
    if (!review) throw error;
    const replacement = await review;
    if (!replacement) throw error;
    applyThemeReplacement(manifest, frames, replacement);
    return;
  }

  await reviewGeneratedImage(
    themeId,
    item,
    manifest,
    frames,
    onProgress,
    onReviewReady,
    waitForReview,
  );
}

async function recordUserCorrectableGenerationError(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
  error: unknown,
): Promise<boolean> {
  if (!isUserCorrectableImageGenerationError(error)) return false;
  const details = error as ImageGenerationApiError;
  await setThemeImageGenerationError(globalStorageUri, themeId, itemId, {
    provider: details.provider,
    code: details.code,
    message: details.message,
    request_id: details.requestId,
    moderation_stage: details.moderationDetails?.moderation_stage,
    categories: details.moderationDetails?.categories,
  });
  console.error('TycoonAgents: Image generation requires a revised request.', {
    themeId,
    itemId,
    status: details.status,
    code: details.code,
    requestId: details.requestId,
    moderationDetails: details.moderationDetails,
  });
  return true;
}

async function reviewGeneratedImage(
  themeId: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  onProgress: (message: string) => void,
  onReviewReady: ((themeId: string) => void) | undefined,
  waitForReview: WaitForThemeImageReview | undefined,
): Promise<void> {
  const review = waitForReview?.(themeId, item.id);
  onReviewReady?.(themeId);
  if (!review) return;

  onProgress(`${item.label} is ready. Keep it to continue.`);
  const replacement = await review;
  if (!replacement) return;
  applyThemeReplacement(manifest, frames, replacement);
}

function applyThemeReplacement(
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  replacement: ThemeGenerationResult,
): void {
  // A retry can replace the image while generation is paused. Carry that
  // updated theme state forward so the next generated asset cannot overwrite it.
  Object.assign(manifest, replacement.manifest);
  for (const key of Object.keys(frames)) delete frames[key];
  Object.assign(frames, replacement.frames);
}

function characterAtlasGrid(rebuildBoard = false) {
  const clipGroups = Object.values(ATLAS_CLIPS).map((clip) => clip.frames);
  // Melee's wind-up (frame 10, weapon coiled HIGH) and strike (frame 11, lunge LOW)
  // are DISTINCT poses; unioning them into one normalization bbox spans a tall
  // vertical range that trips the maxContentExtent cap and shrinks BOTH row-3 cells
  // below board scale. Normalize each melee cell to its OWN bbox (like the aim cells)
  // while keeping melee in registrationGroups for horizontal stability.
  const normalizationGroups = Object.entries(ATLAS_CLIPS)
    .filter(([name]) => name !== 'melee')
    .map(([, clip]) => clip.frames);
  return {
    columns: 5,
    rows: 4,
    // Walking and neutral-standing slots are stable body-height references.
    scaleReferenceSlots: [0, 1, 2, 3, 4, 16],
    targetContentHeight: CHARACTER_TARGET_CONTENT_HEIGHT,
    // Raised 120 -> 126 so characters fill ~92-98% of the 128px frame (less
    // downscaling of the 1024px source = sharper); still <= 128 so nothing clips.
    maxContentExtent: 126,
    // Group each animation CLIP's frames so they share one union bbox/crop/anchor,
    // mirroring the rival/object row grouping. Prevents walk/build/shoot/dance
    // frames jumping horizontally as pose mass shifts. Single-frame clips (idle,
    // point, etc.) become harmless 1-member groups. Melee is EXCLUDED here (each
    // of its cells normalizes to its own bbox) but stays in registrationGroups.
    normalizationGroups,
    // Every clip (walk, melee, build, shoot, dance, ...) plays in place, so any
    // drawn side-to-side drift across its frames is unwanted and gets canceled.
    registrationGroups: clipGroups,
    // A flowing cape trailing BELOW the feet would otherwise inflate the content
    // bbox and lift the figure; trim the thin below-feet drag so scale + anchor
    // key to the dense feet row instead of the sparse cape tip.
    feetAnchorMinWidthRatio: 0.2,
    // Character poses must all render at the same (board) height. A wide pose
    // (extended weapon/arms) would otherwise trip the width caps and shrink its
    // whole clip below board scale; clip the horizontal overflow at the frame
    // edge instead. Height caps stay in force so heads/feet are never clipped.
    clipWidthOverflow: true,
    rebuildBoard,
    squareReviewBoard: rebuildBoard,
  };
}

async function processCharacterAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  // Normalize from the provider's full-resolution output so undersized source
  // sprites retain as much detail as possible when fitted to the 128px cells.
  const normalized = await sliceAndNormalizeAtlas(generated, manifest, characterAtlasGrid(true));
  // The retained/reviewed character canvas is an exact 512x512 artifact.
  // Frames stay at 128x128 and are not re-sliced from this presentation board.
  const output = await resizeSpriteBoardCanvas(normalized.board!, 512, 512);
  return { output, spritePackage: normalized };
}

/**
 * Slice one of the two fixed 4x4 (16-cell) object boards.
 *   - Board 1 (all `object_static` rows, length OBJECT_BOARD1_STATIC_COUNT):
 *     each cell is an independent single-frame object, normalized on its own
 *     (no grouping/registration needed since there is nothing to keep in
 *     sync across frames).
 *   - Board 2 (`[object_anim, object_anim, poof, object_static,
 *     object_static, object_static, crate]`): row 1 (cells 0-3) and row 2
 *     (cells 4-7) are each a 4-frame animated-object group; cells 8-11 are
 *     the 4-frame poof group (row 3); cells 12-14 are the three single-frame
 *     static objects (the first three cells of row 4); cell 15 is the
 *     single-frame crate (the last cell of row 4). Only the two
 *     animated-object groups are horizontally registered — poof is a
 *     one-shot FX whose frames are meant to differ, and the static/crate
 *     cells are single-frame, so registering any of them is a no-op at best.
 */
async function processObjectAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
  rows: ThemeObjectBoardRow[],
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  const isBoard2 = rows.some((row) => row.kind === 'object_anim' || row.kind === 'poof' || row.kind === 'crate');
  if (isBoard2) {
    if (rows.length !== OBJECT_ANIMATED_COUNT + OBJECT_BOARD2_STATIC_COUNT + 2) {
      throw new Error('Object board 2 requires exactly two animated objects, one poof entry, three static objects, and one crate entry.');
    }
    const animGroups = [[0, 1, 2, 3], [4, 5, 6, 7]];
    const poofGroup = [8, 9, 10, 11];
    const staticGroups = [[12], [13], [14]];
    const crateGroup = [15];
    const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
      columns: 4,
      rows: 4,
      // Scale reference includes BOTH animated groups and the 3 new static
      // object cells (real buildable objects) — poof/crate are FX/props, not
      // objects, so they stay out of the reference set as before.
      scaleReferenceSlots: [...animGroups[0], ...animGroups[1], ...staticGroups.flat()],
      targetContentHeight: 104,
      maxContentExtent: 120,
      normalizationGroups: [...animGroups, poofGroup, ...staticGroups, crateGroup],
      registrationGroups: animGroups,
      // The 2 animated objects animate lighting/glow in place; brightness-based
      // registration gets fooled by the lighting change and bakes side-to-side
      // drift. Align by silhouette overlap only. Objects only — chars/rivals
      // keep RGB registration.
      registrationShapeOnly: true,
      // Never enlarge small drawn content beyond its native crop size — avoids
      // jagged nearest-neighbor upscaling when the image model draws an object
      // small in its cell.
      noUpscale: true,
    });
    const output = await optimizeSpriteBoardCanvas(generated, 4, 4);
    return { output, spritePackage };
  }
  if (rows.length !== OBJECT_BOARD1_STATIC_COUNT) {
    throw new Error(`Object board 1 requires exactly ${OBJECT_BOARD1_STATIC_COUNT} static-object cells.`);
  }
  const allSlots = Array.from({ length: OBJECT_BOARD1_STATIC_COUNT }, (_unused, index) => index);
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 4,
    rows: 4,
    scaleReferenceSlots: allSlots,
    targetContentHeight: 104,
    maxContentExtent: 120,
    normalizationGroups: allSlots.map((slot) => [slot]),
    // Never enlarge small drawn content beyond its native crop size — avoids
    // jagged nearest-neighbor upscaling when the image model draws an object
    // small in its cell.
    noUpscale: true,
  });
  const output = await optimizeSpriteBoardCanvas(generated, 4, 4);
  return { output, spritePackage };
}

/**
 * Slice a compact 5x4 rival board: each of the four ROWS is one enemy's 5-frame
 * mini-atlas ([walk0, walk1, walk2, attack0, attack1]). Group each row's five cells
 * so its frames share a common crop/anchor, mirroring the object-board approach.
 */
async function processRivalAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
  rows: ThemeRivalBoardRow[],
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  if (rows.length < 1 || rows.length > 4) throw new Error('Rival board carries one to four rows.');
  const rowGroups = Array.from({ length: rows.length }, (_row, rowIndex) =>
    Array.from({ length: 5 }, (_col, colIndex) => rowIndex * 5 + colIndex),
  );
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 5,
    rows: rows.length,
    scaleReferenceSlots: Array.from({ length: rows.length * 5 }, (_unused, cell) => cell),
    targetContentHeight: CHARACTER_TARGET_CONTENT_HEIGHT,
    // Raised 120 -> 126 so rivals fill ~92-98% of the 128px frame (less
    // downscaling of the 1024px source = sharper); still <= 128 so nothing clips.
    maxContentExtent: 126,
    normalizationGroups: rowGroups,
    // Each row's walk+attack frames are one rival animating in place, so any
    // drawn side-to-side drift across the row is unwanted and gets canceled.
    registrationGroups: rowGroups,
    // Same cape-drag guard as characters: trim thin below-feet content so scale +
    // bottom-justify anchor to the dense feet row, not a trailing cape tip.
    feetAnchorMinWidthRatio: 0.2,
  });
  const output = await optimizeSpriteBoardCanvas(generated, 5, rows.length);
  return { output, spritePackage };
}

async function processDecorAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  // 4x4 board: rows 1-2 are four single-frame cells each; rows 3-4 are each one
  // four-frame animation. Group the two animation rows so their frames share a
  // common crop/anchor, while every static cell is normalized on its own.
  const staticGroups = Array.from({ length: 8 }, (_unused, cell) => [cell]);
  const animGroups = [[8, 9, 10, 11], [12, 13, 14, 15]];
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 4,
    rows: 4,
    scaleReferenceSlots: Array.from({ length: 16 }, (_unused, cell) => cell),
    targetContentHeight: 104,
    maxContentExtent: 120,
    normalizationGroups: [...staticGroups, ...animGroups],
    // Only the loopable animated decor row (8-11) plays in place; the
    // projectile row (12-15) is a one-shot launch-to-impact whose frames are
    // meant to differ, so it is excluded from horizontal registration.
    registrationGroups: [animGroups[0]],
  });
  const output = await optimizeSpriteBoardCanvas(generated, 4, 4);
  return { output, spritePackage };
}

/**
 * Map the 16 sliced cells to their frame keys:
 *   row 1 cells 0-3   → four single-frame seats (`decor_<id>`),
 *   row 2 cells 4-7   → four single-frame decor (`decor_<id>`),
 *   row 3 cells 8-11  → one four-frame animated decor (`decor_<id>`),
 *   row 4 cells 12-15 → the ranged-weapon-fire projectile FX (`projectile`, four frames).
 */
function applyDecorBoardFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  rows: ThemeDecorBoardRow[],
): string[] {
  const keys: string[] = [];
  const seat = rows.filter((row) => row.kind === 'seat');
  const staticDecor = rows.filter((row) => row.kind === 'decor');
  const animated = rows.filter((row) => row.kind === 'decor_anim');
  const hasProjectile = rows.some((row) => row.kind === 'projectile');

  seat.forEach((row, index) => {
    const key = `decor_${row.decor_id}`;
    frames[key] = slots[index] ? [slots[index].data] : [];
    keys.push(key);
  });
  staticDecor.forEach((row, index) => {
    const key = `decor_${row.decor_id}`;
    frames[key] = slots[4 + index] ? [slots[4 + index].data] : [];
    keys.push(key);
  });
  animated.forEach((row, index) => {
    const key = `decor_${row.decor_id}`;
    const start = 8 + index * 4;
    frames[key] = slots.slice(start, start + 4).map((slot) => slot.data);
    keys.push(key);
  });
  if (hasProjectile) {
    // Row 4 (cells 12-15) is the one-shot projectile FX; keyed `projectile`.
    frames.projectile = slots.slice(12, 16).map((slot) => slot.data);
    keys.push('projectile');
  }
  return keys;
}

/** Regroup a flat decor-row list back into the 4x4 board's [seats, statics, [anim], [projectile]] shape. */
function decorRowsToBoard(rows: ThemeDecorBoardRow[]): ThemeDecorBoardRow[][] {
  const seats = rows.filter((row) => row.kind === 'seat');
  const statics = rows.filter((row) => row.kind === 'decor');
  const animated = rows.filter((row) => row.kind === 'decor_anim');
  const projectile = rows.find((row) => row.kind === 'projectile') ?? { kind: 'projectile' as const };
  return [seats, statics, [animated[0]], [projectile]];
}

function themeDecorSpecs(
  manifest: ThemeManifest,
  descriptions?: string[],
): Array<{ decor_id: string; display_name: string; visual_description?: string }> {
  return (manifest.decor_objects ?? []).slice(0, 9).map((decor, index) => {
    const description = (descriptions?.[index] ?? '').trim();
    return {
      decor_id: decor.decor_id,
      display_name: decor.display_name,
      ...(description ? { visual_description: description } : {}),
    };
  });
}

export function createReviewItems(
  plan: ThemePlan,
  manifest: ThemeManifest,
  creativeDirection: string,
  backgroundMode: BoardBackgroundMode = 'magenta',
): Array<Omit<ThemeImageReviewItem, 'updated_at'>> {
  const characterCreativeDirection = `Creative direction: ${plan.creative_direction}`;
  const characterItems = manifest.roster_agents.map((agent) => ({
    id: `agent_${agent.slot_id}`,
    filename: `agent_${String(agent.slot_id + 1).padStart(2, '0')}_${toSafeFileStem(agent.name)}.png`,
    label: agent.name,
    kind: 'character_atlas' as const,
    status: 'pending' as const,
    prompt: buildCharacterAtlasPrompt(
      characterCreativeDirection,
      agent.name,
      plan.display_name,
      backgroundMode,
      (plan.character_descriptions?.[agent.slot_id] ?? '').trim() || undefined,
    ),
    revision: 0,
    frame_keys: [`agent_${agent.slot_id}`],
    subject: agent.name,
    character_description: (plan.character_descriptions?.[agent.slot_id] ?? '').trim() || undefined,
  }));
  let enemyItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>> = [];
  try {
    const rivalBoards = createRivalBoardRows(themeRivalSpecs(manifest, plan.enemy_descriptions));
    enemyItems = rivalBoards.map((rows, index) => {
      const firstEnemy = index * rows.length + 1;
      const lastEnemy = firstEnemy + rows.length - 1;
      return {
        id: `rivals_${String(index + 1).padStart(2, '0')}`,
        filename: `rivals_${String(index + 1).padStart(2, '0')}.png`,
        label: `Rivals ${firstEnemy}–${lastEnemy}`,
        kind: 'rival_atlas' as const,
        status: 'pending' as const,
        prompt: buildRivalAtlasPrompt(creativeDirection, plan.display_name, rows, backgroundMode),
        revision: 0,
        frame_keys: rivalBoardFrameKeys(rows),
        rival_rows: rows,
      };
    });
  } catch (err) {
    console.warn('TycoonAgents: skipping rival board items in review synthesis:', err);
    enemyItems = [];
  }
  let objectItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>> = [];
  try {
    const objectSpecs = themeObjectSpecs(manifest, plan.object_motion_hints, plan.object_descriptions);
    const board1StaticSpecs = objectSpecs.slice(0, OBJECT_BOARD1_STATIC_COUNT);
    const board2StaticSpecs = objectSpecs.slice(OBJECT_BOARD1_STATIC_COUNT, OBJECT_STATIC_COUNT);
    const animatedSpecs = objectSpecs.slice(OBJECT_STATIC_COUNT, OBJECT_STATIC_COUNT + OBJECT_ANIMATED_COUNT);
    const board1Rows = createObjectBoard1Rows(board1StaticSpecs);
    const board2Rows = createObjectBoard2Rows(animatedSpecs, board2StaticSpecs, plan.poof_description, plan.crate_description);
    objectItems = [
      {
        id: 'objects_01',
        filename: 'objects_01.png',
        label: `Static objects 1–${OBJECT_BOARD1_STATIC_COUNT}`,
        kind: 'object_atlas' as const,
        status: 'pending' as const,
        prompt: buildObjectAtlasPrompt(creativeDirection, plan.display_name, board1Rows, backgroundMode),
        revision: 0,
        frame_keys: objectBoardFrameKeys(board1Rows),
        object_specs: board1StaticSpecs.map(({ object_id, display_name }) => ({ object_id, display_name })),
        object_rows: board1Rows,
      },
      {
        id: 'objects_02',
        filename: 'objects_02.png',
        label: `Objects ${OBJECT_BOARD1_STATIC_COUNT + 1}–${THEME_OBJECT_COUNT} (${OBJECT_BOARD2_STATIC_COUNT} static + ${OBJECT_ANIMATED_COUNT} animated) + build effects`,
        kind: 'object_atlas' as const,
        status: 'pending' as const,
        prompt: buildObjectAtlasPrompt(creativeDirection, plan.display_name, board2Rows, backgroundMode),
        revision: 0,
        frame_keys: objectBoardFrameKeys(board2Rows),
        object_specs: [...animatedSpecs, ...board2StaticSpecs].map(({ object_id, display_name }) => ({ object_id, display_name })),
        object_rows: board2Rows,
        crate_description: (plan.crate_description ?? '').trim() || undefined,
        poof_description: (plan.poof_description ?? '').trim() || undefined,
      },
    ];
  } catch (err) {
    console.warn('TycoonAgents: skipping object board items in review synthesis:', err);
    objectItems = [];
  }
  return [
    ...characterItems,
    ...enemyItems,
    {
      id: 'environment',
      filename: 'environment.png',
      label: 'Environment',
      kind: 'environment',
      status: 'pending',
      prompt: buildEnvironmentPrompt(creativeDirection, plan.display_name),
      revision: 0,
      frame_keys: ['environment_background'],
    },
    createDecorReviewItem(plan, manifest, creativeDirection, backgroundMode),
    ...objectItems,
    {
      id: 'expressions',
      filename: 'expressions.png',
      label: '8 expressions',
      kind: 'expression_atlas',
      status: 'pending',
      prompt: buildExpressionAtlasPrompt(
        creativeDirection,
        plan.display_name,
        plan.expressions,
        backgroundMode,
        plan.expression_descriptions,
      ),
      revision: 0,
      frame_keys: plan.expressions.map((_name, index) => `expression_${index}`),
      expression_names: plan.expressions,
      // Positional (index === expression cell) appearance text for the review
      // UI's Descriptions editor; may be absent (name-only prompt) — normalized
      // to a full-length array so each expression row always resolves cleanly.
      expression_descriptions: plan.expression_descriptions
        ? plan.expressions.map((_n, index) => plan.expression_descriptions?.[index] ?? '')
        : undefined,
    },
    {
      id: 'achievements',
      filename: 'achievements.png',
      label: '25 achievement badges',
      kind: 'achievement_atlas',
      status: 'pending',
      prompt: buildAchievementAtlasPrompt(
        creativeDirection,
        plan.display_name,
        plan.achievements,
        backgroundMode,
        plan.achievement_descriptions,
      ),
      revision: 0,
      frame_keys: plan.achievements.map((_name, index) => `achievement_${index}`),
      achievement_names: plan.achievements,
      // Positional (index === badge slot) appearance text for the review UI's
      // Descriptions editor; may be absent (name-only prompt) — normalized to
      // a full-length array so each badge row always resolves cleanly.
      achievement_descriptions: plan.achievement_descriptions
        ? plan.achievements.map((_n, index) => plan.achievement_descriptions?.[index] ?? '')
        : undefined,
    },
  ];
}

/**
 * Builds the review items for exactly one board type. Delegates to
 * createReviewItems — the single source of truth for prompts, filenames,
 * and frame-key/row metadata — so full theme generation and per-board
 * regeneration can never drift apart.
 */
export function buildBoardItems(
  plan: ThemePlan,
  manifest: ThemeManifest,
  board: BoardKind,
  backgroundMode: BoardBackgroundMode = 'magenta',
): Array<Omit<ThemeImageReviewItem, 'updated_at'>> {
  const creativeDirection = themePlanCreativeDirection(plan);
  const items = createReviewItems(plan, manifest, creativeDirection, backgroundMode);
  switch (board) {
    case 'agents':
      return items.filter((item) => item.kind === 'character_atlas');
    case 'enemy':
      return items.filter((item) => item.kind === 'rival_atlas');
    case 'environment':
      return items.filter((item) => item.id === 'environment');
    case 'decor':
      return items.filter((item) => item.id === 'background_decor');
    case 'objects':
      return items.filter((item) => item.kind === 'object_atlas');
    case 'expressions':
      return items.filter((item) => item.id === 'expressions');
    case 'achievements':
      return items.filter((item) => item.id === 'achievements');
    default:
      return [];
  }
}

function createDecorReviewItem(
  plan: ThemePlan,
  manifest: ThemeManifest,
  creativeDirection: string,
  backgroundMode: BoardBackgroundMode = 'magenta',
): Omit<ThemeImageReviewItem, 'updated_at'> {
  const specs = themeDecorSpecs(manifest, plan.decor_descriptions);
  const rows = createDecorBoardRows(specs);
  return {
    id: 'background_decor',
    filename: 'background_decor.png',
    label: 'Background decor',
    kind: 'background_decor_atlas',
    status: 'pending',
    prompt: buildBackgroundDecorPrompt(creativeDirection, plan.display_name, rows, backgroundMode),
    revision: 0,
    frame_keys: decorBoardFrameKeys(rows),
    decor_rows: rows.flat(),
  };
}

/** Generates one character sprite board (an "agents" board item). */
async function generateAgentAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  const generated = await generateThemeImage(item.prompt, spriteBoardOptions(options));
  throwIfCancelled(undefined, options?.signal);
  const { output, spritePackage } = await processCharacterAtlas(generated, manifest);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  const frameKey = item.frame_keys[0] ?? item.id;
  frames[frameKey] = spritePackage.slots.map((slot) => slot.data);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateEnvironmentAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('Environment (20/25)');
  const generated = await generateEnvironmentImage(item.prompt, options);
  throwIfCancelled(undefined, options?.signal);
  const output = await normalizeEnvironmentImage(generated);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, output);
  // Keep the raw pre-slice image so this board can be re-processed later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  frames.environment_background = [dataUri(output)];
  manifest.viewport.background_asset = 'frames.json#environment_background';
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateDecorAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('Background decor');
  const generated = await generateThemeImage(item.prompt, spriteBoardOptions(options));
  throwIfCancelled(undefined, options?.signal);
  const rows = decorRowsForItem(item, manifest);
  const decorAtlas = await processDecorAtlas(generated, manifest);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, decorAtlas.output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  applyDecorBoardFrames(frames, decorAtlas.spritePackage.slots, rows);
  manifest.viewport.projectile_asset = 'frames.json#projectile';
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateRivalAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress(item.label);
  const previousFrameKeys = await persistedFrameKeysFor(globalStorageUri, plan.theme_id, item.id);
  const generated = await generateThemeImage(item.prompt, spriteBoardOptions(options));
  throwIfCancelled(undefined, options?.signal);
  const rows = rivalRowsForItem(item, manifest);
  const rivalAtlas = await processRivalAtlas(generated, manifest, rows);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, rivalAtlas.output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  const newFrameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
  removeStaleBoardFrameKeys(frames, previousFrameKeys, newFrameKeys);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

/**
 * Rival rows for a rival-board item. Reconstructs them from the CURRENT manifest
 * roster by the board's index (parsed from `rivals_NN`) as the primary source, so
 * a roster that grew (e.g. 3->4 rivals) regenerates the correct count instead of
 * reusing a stale saved `rival_rows` — which would slice the board at the wrong
 * row count and drop the new rival's frames (placeholder + mis-sliced neighbors).
 * Falls back to the item's stored `rival_rows` only if reconstruction fails/empty.
 */
function rivalRowsForItem(
  item: Pick<ThemeImageReviewItem, 'id' | 'rival_rows'>,
  manifest: ThemeManifest,
  descriptions?: string[],
): ThemeRivalBoardRow[] {
  let boards: ThemeRivalBoardRow[][];
  try {
    boards = createRivalBoardRows(themeRivalSpecs(manifest, descriptions));
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct rival board rows:', err);
    return item.rival_rows?.length ? item.rival_rows : [];
  }
  const boardIndex = Math.max(0, (Number(/rivals_(\d+)/.exec(item.id)?.[1] ?? '1') || 1) - 1);
  const rows = boards[boardIndex] ?? boards[0] ?? [];
  return rows.length ? rows : (item.rival_rows?.length ? item.rival_rows : []);
}

/**
 * Object rows for an object-atlas item. Mirrors rivalRowsForItem, but the v3
 * object pipeline always has exactly TWO fixed-shape boards (unlike rivals,
 * whose board count scales with roster size): `objects_01` is
 * createObjectBoard1Rows(the first OBJECT_BOARD1_STATIC_COUNT specs) and
 * `objects_02` is createObjectBoard2Rows(the next OBJECT_ANIMATED_COUNT
 * specs, the last OBJECT_BOARD2_STATIC_COUNT specs).
 *
 * When a `plan` is supplied, its object roster (`plan.objects` /
 * `plan.object_motion_hints`, via themeObjectSpecsFromPlan) is tried FIRST —
 * mirroring buildReplacementPrompt's existing preference for
 * plan.expressions/plan.achievements over saved item names. normalizeThemePlan
 * always pads/trims `plan.objects` to THEME_OBJECT_COUNT (21) on load, so this
 * lets a LEGACY manifest still stuck at a pre-v3 buildable_objects count (which
 * makes the manifest-based reconstruction below throw, since
 * createObjectBoard1Rows/2Rows require an exact 16/(2+3) split) still resolve to
 * the CURRENT 2-board contract instead of falling through to a stale board.
 * Reconstructing from the CURRENT manifest is the next fallback (so a roster
 * rename/reorder regenerates the correct board content even with no plan).
 * Falls back to the item's stored `object_rows`, then to a lenient legacy
 * reconstruction, only if both the plan-based and manifest-based
 * reconstructions are empty, throw, or (for plan) unavailable. Exported for
 * unit testing.
 */
export function objectRowsForItem(
  item: Pick<ThemeImageReviewItem, 'object_specs' | 'object_rows'> & Partial<Pick<ThemeImageReviewItem, 'id'>>,
  manifest: ThemeManifest,
  plan?: Pick<ThemePlan, 'objects' | 'object_motion_hints' | 'object_descriptions' | 'crate_description' | 'poof_description'>,
  // Independent of `plan`/preferPlanObjects above: descriptions are PROMPT-ONLY
  // text, not row geometry, so they can safely be merged onto the manifest-driven
  // rows below even when the caller intentionally keeps row RECONSTRUCTION
  // manifest-based (to stay consistent with manifest-based slicing). Callers that
  // have a plan available on the real (non-display) retry path should still pass
  // its object_descriptions here even when they pass `undefined` for `plan` itself.
  descriptions?: string[],
  // Same independence as `descriptions` above, but for the single crate/poof
  // appearance specs (plan.poof_description / plan.crate_description). Used
  // only for board 2 (createObjectBoard2Rows ignores extra args for board 1).
  poofDescription?: string,
  crateDescription?: string,
): ThemeObjectBoardRow[] {
  const boardNumber = Number(/objects_(\d+)/.exec(item.id ?? '')?.[1] ?? '1') || 1;
  if (plan?.objects?.length) {
    try {
      const planSpecs = themeObjectSpecsFromPlan(plan);
      const rows = boardNumber >= 2
        ? createObjectBoard2Rows(
          planSpecs.slice(OBJECT_STATIC_COUNT, OBJECT_STATIC_COUNT + OBJECT_ANIMATED_COUNT),
          planSpecs.slice(OBJECT_BOARD1_STATIC_COUNT, OBJECT_STATIC_COUNT),
          plan.poof_description,
          plan.crate_description,
        )
        : createObjectBoard1Rows(planSpecs.slice(0, OBJECT_BOARD1_STATIC_COUNT));
      if (rows.length) return rows;
    } catch (err) {
      console.warn('TycoonAgents: unable to reconstruct object board rows from plan:', err);
    }
  }
  try {
    const objectSpecs = themeObjectSpecs(manifest, undefined, descriptions);
    const rows = boardNumber >= 2
      ? createObjectBoard2Rows(
        objectSpecs.slice(OBJECT_STATIC_COUNT, OBJECT_STATIC_COUNT + OBJECT_ANIMATED_COUNT),
        objectSpecs.slice(OBJECT_BOARD1_STATIC_COUNT, OBJECT_STATIC_COUNT),
        poofDescription,
        crateDescription,
      )
      : createObjectBoard1Rows(objectSpecs.slice(0, OBJECT_BOARD1_STATIC_COUNT));
    if (rows.length) return rows;
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct object board rows:', err);
  }
  if (item.object_rows?.length) return item.object_rows;
  try {
    const legacyRows = reconstructObjectRows(item, manifest);
    if (legacyRows.length) return legacyRows;
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct legacy object board rows:', err);
  }
  return item.object_rows?.length ? item.object_rows : [];
}

/**
 * Flattened decor rows for a background-decor-atlas item. Reconstructs from the
 * CURRENT manifest's decor roster (via createDecorBoardRows) as the primary
 * source, so a decor roster change regenerates the correct board instead of
 * reusing stale saved `decor_rows`. Falls back to the item's stored `decor_rows`
 * only if reconstruction is empty or throws (e.g. the manifest doesn't have
 * exactly 9 decor entries). Exported for unit testing.
 */
export function decorRowsForItem(
  item: Pick<ThemeImageReviewItem, 'decor_rows'>,
  manifest: ThemeManifest,
  descriptions?: string[],
): ThemeDecorBoardRow[] {
  try {
    const rows = createDecorBoardRows(themeDecorSpecs(manifest, descriptions)).flat();
    return rows.length ? rows : (item.decor_rows?.length ? item.decor_rows : []);
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct decor board rows:', err);
    return item.decor_rows?.length ? item.decor_rows : [];
  }
}

/**
 * Merge a resumed generation's freshly computed review items (`expected`, rebuilt
 * from the CURRENT plan/manifest) with whatever review document was saved before
 * the run was interrupted (`savedItems`). Preserves REVIEW PROGRESS from the saved
 * item — status/revision/updated_at/generation_error — but never lets a saved
 * item's board-row/prompt/frame-key metadata override the freshly computed
 * `expected` values. `expected` is rebuilt from the current plan/manifest every
 * resume, so if the object/rival/decor roster changed shape between the
 * interrupted run and this resume (e.g. the buildable-object count grew and
 * pushed poof/crate onto a later board), a naive `{ ...expected, ...saved }`
 * spread would silently let the OLD saved object_rows and prompt win — the next
 * `generateOrResumeThemeItem` call would then generate a board image using an
 * outdated roster shape, baking the wrong content (e.g. a real object rendered
 * where poof/crate belong) straight into the art itself, no slicing bug
 * required. This mirrors the manifest-wins policy already enforced by
 * objectRowsForItem/rivalRowsForItem for the re-slice path — this resume path
 * must enforce it too, since it runs BEFORE generation. Exported for unit testing.
 */
export function mergeResumedReviewItems(
  expectedItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>>,
  savedItems: ReadonlyArray<ThemeImageReviewItem>,
): Array<Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string }> {
  return expectedItems.map((expected) => {
    const saved = savedItems.find((item) => item.id === expected.id);
    if (!saved) return expected;
    return {
      ...expected,
      status: saved.status,
      revision: saved.revision,
      updated_at: saved.updated_at,
      generation_error: saved.generation_error,
    };
  });
}

/**
 * Pure core of the rename-driven prompt resync (the "Names" editor's batched
 * Apply, applyThemeItemNameChanges/renameThemeItemsBatch). Renaming only ever
 * touched the manifest. Every regenerate mode — including 'retry'/'augment'
 * since retryThemeImage's freshBasePrompt rebuild — now reconstructs board
 * rows/prompt from the CURRENT manifest at generation time (see
 * selectThemeImageRetryPrompt in themeImageRetry.ts), so a rename is always
 * picked up on the next retry regardless of mode. This resync exists so the
 * saved on-disk prompt/rows reflect the rename immediately, without waiting
 * for the next generation.
 *
 * Given the review document as it stood before the rename, the manifest AFTER
 * applyThemeItemNameChanges wrote the new names into it, the theme's plan, and
 * the batch of applied changes, returns the review items whose board needs a
 * freshly-rebuilt prompt/rows so 'retry' and 'augment' inherit the new names
 * automatically from here on.
 *
 * Scoped to only the object/decor/rival boards that actually CONTAIN a renamed
 * row — every other board, including character/agent boards (the existing
 * single-character rename flow, RENAME_THEME_CHARACTER, already owns that
 * fuller plan/prompt-text sync), is left byte-for-byte as saved. Reuses
 * createReviewItems — the single source of truth for board prompts/rows — plus
 * mergeResumedReviewItems' merge semantics, so status/revision/updated_at/
 * generation_error survive the resync untouched: a rename must never bounce an
 * accepted board back to pending. Exported for unit testing.
 */
export function resyncRenamedReviewItems(
  document: Pick<ThemeImageReviewDocument, 'items'>,
  manifest: ThemeManifest,
  plan: ThemePlan,
  applied: ThemeItemNameChange[],
): ThemeImageReviewItem[] {
  // Character renames already have their own fuller sync path; nothing else
  // to resync if only character rows changed.
  const affectedIds = new Set(
    applied.filter((change) => change.item_kind !== 'character').map((change) => change.id),
  );
  if (!affectedIds.size) return [];

  const affectedBoardIds = new Set<string>();
  for (const item of document.items) {
    if (item.kind === 'object_atlas' && item.object_rows?.some(
      (row) => (row.kind === 'object_static' || row.kind === 'object_anim') && affectedIds.has(row.object_id),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'background_decor_atlas' && item.decor_rows?.some(
      (row) => row.kind !== 'projectile' && affectedIds.has(row.decor_id),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'rival_atlas' && item.rival_rows?.some(
      // rival_rows carry the STRIPPED rival_id (see themeRivalSpecs); match either
      // form since applyThemeItemNameChanges accepts both (see its rival branch).
      (row) => affectedIds.has(row.rival_id) || affectedIds.has(`rival_${row.rival_id}`),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'achievement_atlas' && applied.some((change) => change.item_kind === 'badge')) {
      affectedBoardIds.add(item.id);
    }
  }
  if (!affectedBoardIds.size) return [];

  const expectedItems = createReviewItems(
    plan,
    manifest,
    themePlanCreativeDirection(plan),
    boardBackgroundModeForProvider(undefined),
  ).filter((item) => affectedBoardIds.has(item.id));
  const savedItems = document.items.filter((item) => affectedBoardIds.has(item.id));

  // Every expected item here has a saved counterpart by construction
  // (affectedBoardIds was derived from document.items), so the merge always
  // carries a real updated_at through.
  return mergeResumedReviewItems(expectedItems, savedItems) as ThemeImageReviewItem[];
}

/**
 * IO wrapper around resyncRenamedReviewItems: loads the saved review document
 * and plan, computes the refreshed items, and persists each one. Silently
 * no-ops (logs a warning) if the review document or plan can't be loaded —
 * the manifest rename itself already succeeded and must not be rolled back
 * just because the resync convenience couldn't run; the next full
 * regenerate/resume still self-heals via mergeResumedReviewItems.
 */
async function resyncRenamedBoardPrompts(
  globalStorageUri: vscode.Uri,
  themeId: string,
  manifest: ThemeManifest,
  applied: ThemeItemNameChange[],
): Promise<void> {
  if (!applied.some((change) => change.item_kind !== 'character')) return;
  try {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (!document) return;
    const savedPlan = (await readJson<ThemePlan>(themePlanUri(globalStorageUri, themeId)))
      ?? (await readJson<ThemePlan>(vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`)));
    if (!savedPlan) return;
    const plan = normalizeThemePlan(savedPlan, manifest.display_name);
    if (plan.theme_id !== themeId) return;

    // Badge (achievement) names are themed and live in plan.achievements — mirror the applied
    // badge renames into the plan and persist it so the achievement board rebuilds with the new
    // names (createReviewItems reads plan.achievements) and they survive theme reopen.
    const badgeChanges = applied.filter((change) => change.item_kind === 'badge');
    if (badgeChanges.length) {
      let planChanged = false;
      for (const change of badgeChanges) {
        const m = /^achievement_(\d+)$/.exec(change.id);
        const idx = m ? Number(m[1]) : -1;
        if (idx >= 0 && idx < plan.achievements.length) {
          plan.achievements[idx] = change.name;
          planChanged = true;
        }
      }
      if (planChanged) {
        await vscode.workspace.fs.writeFile(themePlanUri(globalStorageUri, themeId), jsonBuffer(plan));
      }
    }

    const refreshed = resyncRenamedReviewItems(document, manifest, plan, applied);
    for (const item of refreshed) {
      await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, item);
    }
  } catch (err) {
    console.warn('TycoonAgents: unable to resync review-board prompts after rename:', err);
  }
}

/**
 * Look up the frame_keys this item owned in the LAST PERSISTED review document
 * (on disk), as opposed to the freshly-built `item` passed to a generate*Asset
 * function — which, when built via buildBoardItems/createReviewItems, already
 * targets the NEW correct key set and so is useless as a "previous ownership"
 * baseline. Without reading the persisted keys, a plain regenerate (not just a
 * re-slice) of a board whose row shape shrank (e.g. it no longer carries
 * poof/crate) would never purge the stale keys it wrote under its old shape —
 * only a re-slice (which starts from the on-disk item) would. Returns undefined
 * if the item has no prior persisted record (first-ever generation).
 */
async function persistedFrameKeysFor(
  globalStorageUri: vscode.Uri,
  themeId: string,
  itemId: string,
): Promise<string[] | undefined> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  return document?.items.find((candidate) => candidate.id === itemId)?.frame_keys;
}

async function generateObjectAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
  progressIndex: number,
): Promise<void> {
  onProgress(`${item.label} (${progressIndex}/25)`);
  const previousFrameKeys = await persistedFrameKeysFor(globalStorageUri, plan.theme_id, item.id);
  const generated = await generateThemeImage(item.prompt, spriteBoardOptions(options));
  throwIfCancelled(undefined, options?.signal);
  if (!item.object_rows?.length) throw new Error(`${item.label} is missing object-board row metadata.`);
  const objectAtlas = await processObjectAtlas(generated, manifest, item.object_rows);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, objectAtlas.output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  const newFrameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, item.object_rows);
  // Self-healing regenerate: if this board's row shape shrank since it was last
  // PERSISTED (e.g. it no longer carries poof/crate because the roster grew and
  // pushed them onto a later board), drop the stale keys it used to own so they
  // can't keep clobbering the board that owns them now.
  removeStaleBoardFrameKeys(frames, previousFrameKeys, newFrameKeys);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateExpressionAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('8-expression sprite sheet (24/25)');
  const generated = await generateThemeImage(item.prompt, spriteBoardOptions(options));
  throwIfCancelled(undefined, options?.signal);
  const output = await optimizeSpriteBoardCanvas(generated, 4, 2);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 2 });
  throwIfCancelled(undefined, options?.signal);
  applyExpressionFrames(frames, spritePackage.slots);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateAchievementAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('25 achievement badges (25/25)');
  const generated = await generateThemeImage(item.prompt, spriteBoardOptions(options));
  throwIfCancelled(undefined, options?.signal);
  const output = await optimizeSpriteBoardCanvas(generated, 5, 5);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 5, rows: 5 });
  throwIfCancelled(undefined, options?.signal);
  applyAchievementFrames(frames, spritePackage.slots);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateEnvironmentImage(
  prompt: string,
  options?: ThemeImageGenerationOptions,
): Promise<Buffer> {
  const shapeGuide = await createEnvironmentShapeGuide();
  return generateThemeImage(prompt, {
    ...options,
    aspectRatio: '3:4',
    referenceImages: [{
      data: shapeGuide,
      mimeType: 'image/png',
      filename: 'environment_shape_guide.png',
    }],
  });
}

export function buildReplacementPrompt(
  item: ThemeImageReviewItem,
  creativeDirection: string,
  manifest: ThemeManifest,
  plan?: Pick<ThemePlan,
    | 'expressions' | 'achievements' | 'objects' | 'object_motion_hints'
    | 'character_descriptions' | 'object_descriptions' | 'decor_descriptions' | 'enemy_descriptions'
    | 'crate_description' | 'poof_description'
  >,
  backgroundMode: BoardBackgroundMode = 'magenta',
  // DISPLAY-ONLY opt-in. When true, the object board rebuilds its rows from the
  // CURRENT plan's 21-object roster (via objectRowsForItem's plan path) so the
  // "Copy/View prompt" surface always reflects the latest 2-board contract even
  // for a legacy off-count manifest. It MUST stay false for any caller whose
  // prompt actually feeds image GENERATION: object slicing
  // (applySlicedAtlasFromBuffer) is still manifest-based, so a plan-derived
  // prompt paired with manifest-based slicing would produce a mismatched retry
  // for a legacy object board. Only the panel's _postThemeImageReview display
  // loop sets this true.
  preferPlanObjects = false,
): string {
  if (item.kind === 'environment') return buildEnvironmentPrompt(creativeDirection, manifest.display_name);
  if (item.kind === 'object_atlas') {
    // Reconstruct from the CURRENT manifest (see objectRowsForItem), falling
    // back to the item's stale saved object_rows / legacy reconstruction — this
    // matches applySlicedAtlasFromBuffer's manifest-based slicing so a real
    // Retry stays consistent. Only the DISPLAY path (preferPlanObjects) also
    // tries the current plan's 21-object roster first, so "Copy/View prompt"
    // reflects the v3 contract even for a legacy off-count manifest.
    // `plan?.object_descriptions` (and the crate/poof descriptions below) are
    // passed unconditionally (independent of preferPlanObjects): descriptions
    // are prompt-only text, not row geometry, so a REAL retry can safely pick
    // up plan-authored appearance guidance on the manifest-driven rows
    // without disturbing manifest-based slicing consistency.
    const rows = objectRowsForItem(
      item,
      manifest,
      preferPlanObjects ? plan : undefined,
      plan?.object_descriptions,
      plan?.poof_description,
      plan?.crate_description,
    );
    return buildObjectAtlasPrompt(creativeDirection, manifest.display_name, rows, backgroundMode);
  }
  if (item.kind === 'background_decor_atlas') {
    // Reconstruct from the CURRENT manifest as the primary source (see
    // decorRowsForItem) so a decor roster change regenerates the correct board
    // instead of reusing stale saved decor_rows.
    const rows = decorRowsToBoard(decorRowsForItem(item, manifest, plan?.decor_descriptions));
    return buildBackgroundDecorPrompt(creativeDirection, manifest.display_name, rows, backgroundMode);
  }
  if (item.kind === 'expression_atlas') {
    // Prefer the CURRENT plan's expression names over the item's saved names,
    // falling back to the saved names, then generic defaults.
    const names = plan?.expressions?.length
      ? plan.expressions
      : (item.expression_names?.length ? item.expression_names : defaultNames('Expression', 8));
    return buildExpressionAtlasPrompt(creativeDirection, manifest.display_name, names, backgroundMode);
  }
  if (item.kind === 'achievement_atlas') {
    // Prefer the CURRENT plan's achievement names over the item's saved names,
    // falling back to the saved names, then generic defaults.
    const names = plan?.achievements?.length
      ? plan.achievements
      : (item.achievement_names?.length ? item.achievement_names : defaultNames('Achievement Badge', 25));
    return buildAchievementAtlasPrompt(creativeDirection, manifest.display_name, names, backgroundMode);
  }
  if (item.kind === 'emote_atlas') return buildEmoteAtlasPrompt(creativeDirection, manifest.display_name, backgroundMode);
  if (item.kind === 'rival_atlas') {
    const rows = rivalRowsForItem(item, manifest, plan?.enemy_descriptions);
    return buildRivalAtlasPrompt(creativeDirection, manifest.display_name, rows, backgroundMode);
  }
  const agentSlotId = agentSlotIdFromFrameKey(item.frame_keys[0] || item.id);
  const characterDescription = agentSlotId !== undefined
    ? (plan?.character_descriptions?.[agentSlotId] ?? '').trim() || undefined
    : undefined;
  return buildCharacterAtlasPrompt(
    creativeDirection,
    item.subject ?? item.label,
    manifest.display_name,
    backgroundMode,
    characterDescription,
  );
}

/** Extract the roster_agents slot_id from a character frame key like `agent_3`, or undefined if it doesn't match. */
function agentSlotIdFromFrameKey(frameKey: string): number | undefined {
  const match = /^agent_(\d+)$/.exec(frameKey);
  return match ? Number(match[1]) : undefined;
}

function renameCharacterInPrompt(prompt: string, previousName: string, characterName: string): string {
  if (!prompt || !previousName || previousName === characterName) return prompt;
  const quotedName = `"${previousName}"`;
  const index = prompt.indexOf(quotedName);
  if (index < 0) return '';
  return `${prompt.slice(0, index)}"${characterName}"${prompt.slice(index + quotedName.length)}`;
}

/**
 * Lenient legacy fallback for an object-atlas review item whose board can't be
 * reconstructed from the current manifest via createObjectBoard1Rows /
 * createObjectBoard2Rows (e.g. a manifest whose buildable_objects count
 * doesn't match the current 21-object / 16-static-plus-2-animated-plus-3-static
 * contract). Uses the item's stored object specs (falling back to the
 * manifest), padding with synthetic placeholders rather than throwing, so a
 * retry never crashes even against a malformed/legacy roster. `objects_02`
 * (or any board number >= 2) reconstructs board 2's [animA, animB, poof,
 * staticA, staticB, staticC, crate] shape from the LAST OBJECT_ANIMATED_COUNT
 * + OBJECT_BOARD2_STATIC_COUNT specs (animated pair first, in row order);
 * every other id reconstructs board 1's OBJECT_BOARD1_STATIC_COUNT static
 * cells from the first OBJECT_BOARD1_STATIC_COUNT specs.
 */
function reconstructObjectRows(
  item: Pick<ThemeImageReviewItem, 'object_specs'> & Partial<Pick<ThemeImageReviewItem, 'id'>>,
  manifest: ThemeManifest,
): ThemeObjectBoardRow[] {
  const boardNumber = Number(/objects_(\d+)/.exec(item.id ?? '')?.[1] ?? '1') || 1;
  const specs = (item.object_specs?.length ? item.object_specs : themeObjectSpecs(manifest))
    .map((spec) => ({ object_id: spec.object_id, display_name: spec.display_name }));
  if (boardNumber >= 2) {
    const animated = specs.slice(Math.max(0, specs.length - OBJECT_ANIMATED_COUNT));
    const animRows: ThemeObjectBoardRow[] = animated.map((spec) => ({ kind: 'object_anim' as const, ...spec }));
    while (animRows.length < OBJECT_ANIMATED_COUNT) {
      animRows.push({
        kind: 'object_anim' as const,
        object_id: `object_${animRows.length + 1}`,
        display_name: `Object ${animRows.length + 1}`,
      });
    }
    const boardTwoStatics = specs.slice(
      Math.max(0, specs.length - OBJECT_ANIMATED_COUNT - OBJECT_BOARD2_STATIC_COUNT),
      Math.max(0, specs.length - OBJECT_ANIMATED_COUNT),
    );
    const staticRows: ThemeObjectBoardRow[] = boardTwoStatics.map((spec) => ({ kind: 'object_static' as const, ...spec }));
    while (staticRows.length < OBJECT_BOARD2_STATIC_COUNT) {
      const n = OBJECT_BOARD1_STATIC_COUNT + staticRows.length + 1;
      staticRows.push({
        kind: 'object_static' as const,
        object_id: `object_${n}`,
        display_name: `Object ${n}`,
      });
    }
    return [
      ...animRows.slice(0, OBJECT_ANIMATED_COUNT),
      { kind: 'poof' },
      ...staticRows.slice(0, OBJECT_BOARD2_STATIC_COUNT),
      { kind: 'crate' },
    ];
  }
  const staticRows: ThemeObjectBoardRow[] = specs.slice(0, OBJECT_BOARD1_STATIC_COUNT).map((spec) => ({
    kind: 'object_static' as const,
    ...spec,
  }));
  while (staticRows.length < OBJECT_BOARD1_STATIC_COUNT) {
    staticRows.push({
      kind: 'object_static' as const,
      object_id: `object_${staticRows.length + 1}`,
      display_name: `Object ${staticRows.length + 1}`,
    });
  }
  return staticRows;
}

function themeObjectSpecs(
  manifest: ThemeManifest,
  motionHints?: string[],
  descriptions?: string[],
): ThemeObjectPromptSpec[] {
  const specs: ThemeObjectPromptSpec[] = manifest.buildable_objects
    .slice(0, THEME_OBJECT_COUNT)
    .map((object, index) => {
      // build_order 0 is the themed ranged-weapon rack (see themePlan.ts); it gets
      // dedicated rack visual guidance and ignores any planner motion hint.
      const isRangedRack = index === 0;
      const hint = !isRangedRack ? (motionHints?.[index] ?? '').trim() : '';
      const description = (descriptions?.[index] ?? '').trim();
      return {
        object_id: object.object_id,
        display_name: object.display_name,
        ...(isRangedRack ? { is_ranged_rack: true } : {}),
        ...(hint ? { motion_hint: hint } : {}),
        ...(description ? { visual_description: description } : {}),
      };
    });
  // Pad legacy / pre-v3 manifests (fewer than THEME_OBJECT_COUNT buildable_objects)
  // up to the fixed 21-slot v3 contract so board 1 always resolves its 16 static
  // cells and board 2 its 2 animated + 3 static cells. Without this, an existing
  // theme whose manifest still carries a pre-v3 object count makes
  // createObjectBoard1Rows/createObjectBoard2Rows and processObjectAtlas throw
  // "requires exactly 16 static-object cells" during review-item re-synthesis and
  // on Re-slice, blocking object replacement on existing themes. Placeholders
  // mirror reconstructObjectRows.
  while (specs.length < THEME_OBJECT_COUNT) {
    const n = specs.length + 1;
    specs.push({ object_id: `object_${n}`, display_name: `Object ${n}` });
  }
  return specs;
}

/**
 * Same shape as themeObjectSpecs, but sourced from a ThemePlan's `objects` /
 * `object_motion_hints` (rather than a ThemeManifest's `buildable_objects`).
 * Used by objectRowsForItem to prefer the CURRENT plan's roster over a
 * possibly-stale/off-count manifest. object_ids are derived with the same
 * uniqueIds(names, 'object') scheme themePlanToManifest uses when it actually
 * bakes a plan into a manifest, so ids here match what generation would
 * eventually assign. Index 0 is always the reserved ranged-weapon rack slot
 * (see reserveRangedWeaponRackSlot in themePlan.ts's normalizeThemePlan).
 */
function themeObjectSpecsFromPlan(
  plan: Pick<ThemePlan, 'objects' | 'object_motion_hints' | 'object_descriptions'>,
): ThemeObjectPromptSpec[] {
  const objects = plan.objects.slice(0, THEME_OBJECT_COUNT);
  const ids = uniqueIds(objects, 'object');
  return objects.map((displayName, index) => {
    const isRangedRack = index === 0;
    const hint = !isRangedRack ? (plan.object_motion_hints?.[index] ?? '').trim() : '';
    const description = (plan.object_descriptions?.[index] ?? '').trim();
    return {
      object_id: ids[index],
      display_name: displayName,
      ...(isRangedRack ? { is_ranged_rack: true } : {}),
      ...(hint ? { motion_hint: hint } : {}),
      ...(description ? { visual_description: description } : {}),
    };
  });
}

function themeRivalSpecs(manifest: ThemeManifest, descriptions?: string[]): ThemeRivalPromptSpec[] {
  return manifest.roster_rivals.map((rival, index) => {
    const description = (descriptions?.[index] ?? '').trim();
    return {
      // rival_id already carries the `rival_` prefix (see themePlan.ts); strip it so
      // frame keys built as `rival_<id>` don't double-prefix.
      rival_id: rival.rival_id.replace(/^rival_/, ''),
      display_name: rival.name,
      ...(description ? { visual_description: description } : {}),
    };
  });
}

/**
 * Map one 5x4 rival board's sliced cells to frame keys. Each row r → `rival_<id>`
 * holds that row's five cells (indices r*5 .. r*5+4) = [walk0, walk1, walk2, attack0, attack1].
 */
function applyRivalBoardFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  rows: ThemeRivalBoardRow[],
): string[] {
  const keys: string[] = [];
  rows.forEach((row, rowIndex) => {
    const key = `rival_${row.rival_id}`;
    frames[key] = slots.slice(rowIndex * 5, rowIndex * 5 + 5).map((slot) => slot.data);
    keys.push(key);
  });
  return keys;
}

/**
 * Writes one object board's frames into `frames`.
 *   - Board 1 (all `object_static` rows): cell i -> `object_<id>`, 1 frame.
 *   - Board 2 (`[object_anim, object_anim, poof, object_static,
 *     object_static, object_static, crate]`): row 1 (slots 0-3) and row 2
 *     (slots 4-7) -> `object_<id>`, 4 frames each; slots 8-11 -> `poof`, 4
 *     frames; slots 12-14 -> `object_<id>`, 1 frame each (the three row-4
 *     static objects); slot 15 -> `crate`, 1 frame.
 * Exported for unit testing multi-board mappings (see objectRowsForItem).
 */
export function applyObjectBoardFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  rows: ThemeObjectBoardRow[],
): string[] {
  const isBoard2 = rows.some((row) => row.kind === 'object_anim' || row.kind === 'poof' || row.kind === 'crate');
  const keys: string[] = [];
  const sliceData = (start: number, end: number) => slots.slice(start, end).map((slot) => slot.data);
  if (isBoard2) {
    const [rowA, rowB, poofRow, staticC, staticD, staticE, crateRow] = rows;
    if (rowA?.kind === 'object_anim') {
      const key = `object_${rowA.object_id}`;
      frames[key] = sliceData(0, 4);
      keys.push(key);
    }
    if (rowB?.kind === 'object_anim') {
      const key = `object_${rowB.object_id}`;
      frames[key] = sliceData(4, 8);
      keys.push(key);
    }
    if (poofRow?.kind === 'poof') {
      frames.poof = sliceData(8, 12);
      keys.push('poof');
    }
    ([[staticC, 12], [staticD, 13], [staticE, 14]] as const).forEach(([row, slotIndex]) => {
      if (row?.kind !== 'object_static') return;
      const key = `object_${row.object_id}`;
      const slot = slots[slotIndex];
      frames[key] = slot ? [slot.data] : [];
      keys.push(key);
    });
    if (crateRow?.kind === 'crate') {
      frames.crate = sliceData(15, 16);
      keys.push('crate');
    }
    return keys;
  }
  rows.forEach((row, index) => {
    if (row.kind !== 'object_static') return;
    const key = `object_${row.object_id}`;
    frames[key] = slots[index] ? [slots[index].data] : [];
    keys.push(key);
  });
  return keys;
}

/**
 * Delete any frame key a board USED TO write (per its previously saved
 * `frame_keys`) that it no longer writes after this (re)generation/re-slice
 * (`newFrameKeys`). This is what makes a re-slice self-healing regardless of
 * board-processing order: without it, a board whose row composition shrank
 * (e.g. it lost the 'poof'/'crate' rows because the object roster grew and
 * pushed them onto a later board) would leave its OLD 'poof'/'crate' values
 * sitting in frames.json forever, and if that same board is ever reprocessed
 * again for any reason, it would silently re-clobber whichever board now
 * legitimately owns those keys. Deletion is scoped strictly to keys THIS
 * item previously owned, so it can never remove another board's frames.
 * Exported for unit testing.
 */
export function removeStaleBoardFrameKeys(
  frames: Record<string, string[]>,
  previousFrameKeys: readonly string[] | undefined,
  newFrameKeys: readonly string[],
): void {
  if (!previousFrameKeys?.length) return;
  const stillOwned = new Set(newFrameKeys);
  for (const staleKey of previousFrameKeys) {
    if (!stillOwned.has(staleKey)) delete frames[staleKey];
  }
}

function applyLegacyObjectFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  objects: Array<{ object_id: string; display_name: string }>,
): string[] {
  return objects.slice(0, 12).map((object, index) => {
    const key = `object_${object.object_id}`;
    frames[key] = slots[index] ? [slots[index].data] : [];
    return key;
  });
}

function applyExpressionFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
): string[] {
  // No legacy 'emote_smile'/'emote_sleep'/'emote_idea'/'emote_team' alias here:
  // those strings are body-clip STATE labels used only by themeBuilder.ts /
  // theme-builder.js (current_emote -> point/sit/dance/signal clip selection),
  // never keys read out of the `frames` image map. Writing them here produced
  // dead frame-image entries nobody consumed. See the distinct expression-icon
  // bubble system (expression_0..7) vs. body point/signal clips note.
  return slots.slice(0, 8).map((slot, index) => {
    const key = `expression_${index}`;
    frames[key] = [slot.data];
    return key;
  });
}

function applyAchievementFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
): string[] {
  // The board is 5×5 = 25 cells, and all 25 default badges claim
  // achievement_0..24 (the rebirth_5 badge claims the formerly-spare cell 24).
  // Persist exactly the 25 claimed frames, upholding the "persist == claimed"
  // invariant so every drawn cell maps to a badge and Theme Health's orphan
  // pass stays clean.
  return slots.slice(0, 25).map((slot, index) => {
    const key = `achievement_${index}`;
    frames[key] = [slot.data];
    return key;
  });
}

function applyLegacyEmoteFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
): string[] {
  const keys = ['emote_smile', 'emote_sleep', 'emote_idea', 'emote_team'];
  keys.forEach((key, row) => {
    frames[key] = slots.slice(row * 5, row * 5 + 5).map((slot) => slot.data);
  });
  return keys;
}

async function markGenerated(
  globalStorageUri: vscode.Uri,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
): Promise<void> {
  await upsertThemeImageReviewItem(globalStorageUri, themeId, displayName, {
    ...item,
    status: 'pending',
    updated_at: new Date().toISOString(),
  });
}

/**
 * Writes manifest.json and frames.json for a theme.
 *
 * `ownedFrameKeys`, when provided, makes the frames.json write MERGE-SAFE: the
 * current on-disk frames.json is re-read immediately before writing, and only
 * the given keys are overlaid from `frames` onto that fresh copy (a key absent
 * from `frames` is deleted, matching removeStaleBoardFrameKeys semantics) —
 * every OTHER key defers to whatever is currently on disk instead of this
 * call's in-memory snapshot. This matters because board regeneration is slow
 * (an image-generation API call sits between the frames.json read and this
 * write), so several boards can be retried concurrently; each retry loads its
 * own frames.json snapshot before its slow call, and a blind overwrite here
 * would let a later-finishing retry silently revert an earlier, faster
 * retry's already-saved frames back to stale art.
 *
 * Omit `ownedFrameKeys` to keep the previous full-overwrite behavior, which
 * is still correct for callers where `frames` is the one continuously-updated
 * in-memory copy for the whole synchronous operation (e.g. the initial
 * full-theme generation pass, tuning/rename saves).
 */
/**
 * Pure merge step behind writeThemeFiles' merge-safe frames.json write (see
 * that function's doc comment for the full race it closes). Exported so the
 * merge algorithm itself can be unit-tested without mocking the vscode
 * filesystem API: given whatever is CURRENTLY on disk plus this operation's
 * in-memory `frames` and the keys it owns, returns the object that should be
 * written — every non-owned key comes from disk, every owned key comes from
 * `frames` (or is dropped if `frames` no longer has it, matching
 * removeStaleBoardFrameKeys semantics).
 */
export function mergeOwnedFrames(
  onDiskFrames: Record<string, string[]> | undefined,
  frames: Record<string, string[]>,
  ownedFrameKeys: readonly string[],
): Record<string, string[]> {
  const merged = { ...(onDiskFrames ?? frames) };
  for (const key of ownedFrameKeys) {
    if (key in frames) merged[key] = frames[key];
    else delete merged[key];
  }
  return merged;
}

async function writeThemeFiles(
  globalStorageUri: vscode.Uri,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  ownedFrameKeys?: readonly string[],
): Promise<void> {
  await vscode.workspace.fs.createDirectory(themeDirectoryUri(globalStorageUri, manifest.theme_id));
  await vscode.workspace.fs.writeFile(themeManifestUri(globalStorageUri, manifest.theme_id), jsonBuffer(manifest));

  let framesToWrite = frames;
  if (ownedFrameKeys) {
    const onDiskFrames = await readJson<Record<string, string[]>>(
      themeFramesUri(globalStorageUri, manifest.theme_id),
    );
    framesToWrite = mergeOwnedFrames(onDiskFrames, frames, ownedFrameKeys);
  }
  await vscode.workspace.fs.writeFile(themeFramesUri(globalStorageUri, manifest.theme_id), jsonBuffer(framesToWrite));
}

async function saveReviewImage(directoryUri: vscode.Uri, filename: string, data: Buffer): Promise<void> {
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directoryUri, filename), data);
}

async function listReviewImageUris(directoryUri: vscode.Uri): Promise<vscode.Uri[]> {
  const entries = await vscode.workspace.fs.readDirectory(directoryUri);
  return entries
    .filter(([name, kind]) => kind === vscode.FileType.File && /\.(?:png|jpe?g|webp)$/i.test(name))
    .map(([name]) => vscode.Uri.joinPath(directoryUri, name))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function collectDirectoryFiles(
  directoryUri: vscode.Uri,
  relativeDirectory: string,
  files: Map<string, Uint8Array>,
): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directoryUri);
  } catch {
    return;
  }
  for (const [name, kind] of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    const uri = vscode.Uri.joinPath(directoryUri, name);
    if (kind === vscode.FileType.Directory) {
      await collectDirectoryFiles(uri, relativePath, files);
    } else if (kind === vscode.FileType.File) {
      files.set(relativePath, await vscode.workspace.fs.readFile(uri));
    }
  }
}

async function addFileIfPresent(files: Map<string, Uint8Array>, path: string, uri: vscode.Uri): Promise<void> {
  try {
    files.set(path, await vscode.workspace.fs.readFile(uri));
  } catch {
    // Optional legacy sidecar is absent.
  }
}

async function getThemeDiskSize(globalStorageUri: vscode.Uri, themeId: string): Promise<number> {
  const targets = [
    themeDirectoryUri(globalStorageUri, themeId),
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_manifest.json`),
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_frames.json`),
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_plan.json`),
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_review.json`),
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_image_review.json`),
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_images`),
  ];
  const sizes = await Promise.all(targets.map(diskUsage));
  return sizes.reduce((total, size) => total + size, 0);
}

async function diskUsage(uri: vscode.Uri): Promise<number> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.File) return stat.size;
    if (stat.type !== vscode.FileType.Directory) return 0;
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const sizes = await Promise.all(entries.map(([name]) => diskUsage(vscode.Uri.joinPath(uri, name))));
    return sizes.reduce((total, size) => total + size, 0);
  } catch {
    return 0;
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function matchLegacyCharacter(item: ThemeImageReviewItem, filename: string, manifest: ThemeManifest): void {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/_recovered_atlas$|_atlas$/, '');
  const rival = manifest.roster_rivals.find((candidate) =>
    stem === candidate.rival_id || stem.startsWith(`${candidate.rival_id}_`),
  );
  if (rival) {
    item.id = rival.rival_id;
    item.frame_keys = [rival.rival_id];
    item.subject = rival.name;
    item.label = rival.name;
    return;
  }
  const agentMatch = /^(agent_(\d+))/.exec(stem);
  const agent = agentMatch
    ? manifest.roster_agents.find((candidate) => candidate.slot_id === Number(agentMatch[2]))
    : undefined;
  if (agent && agentMatch) {
    item.id = agentMatch[1];
    item.frame_keys = [agentMatch[1]];
    item.subject = agent.name;
    item.label = agent.name;
  }
}

async function readJson<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function throwIfCancelled(isCancelled?: () => boolean, signal?: AbortSignal): void {
  if (isCancelled?.() || signal?.aborted) throw new Error('Generation cancelled by user');
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? '';
}

function dataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2));
}

function toSafeFileStem(value: string): string {
  return toSafeAssetId(value) || 'image';
}

function isThemeId(value: string): boolean {
  return /^[a-z0-9_]+$/.test(value);
}

function defaultNames(label: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${label} ${index + 1}`);
}
