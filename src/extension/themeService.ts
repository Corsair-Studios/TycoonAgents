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
import {
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
  createObjectBoardRows,
  createRivalBoardRows,
  decorBoardFrameKeys,
  objectBoardFrameKeys,
  rivalBoardFrameKeys,
} from './themeAssetPrompts';
import type { ThemeObjectPromptSpec, ThemeRivalPromptSpec } from './themeAssetPrompts';
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
  normalizeThemePlan,
  themePlanCreativeDirection,
  themePlanToManifest,
  toSafeAssetId,
} from './themePlan';
import type { ThemePlan } from './themePlan';
import {
  themeDirectoryUri,
  themeFramesUri,
  themeImagesDirectoryUri,
  themeManifestUri,
  themePlanUri,
  themesDirectoryUri,
} from './themeStorage';

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

export async function loadTheme(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  const modernManifest = await readJson<ThemeManifest>(themeManifestUri(globalStorageUri, themeId));
  const modernFrames = await readJson<Record<string, string[]>>(themeFramesUri(globalStorageUri, themeId));
  if (modernManifest && modernFrames) return { manifest: modernManifest, frames: modernFrames };

  const legacyManifest = await readJson<ThemeManifest>(
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_manifest.json`),
  );
  const legacyFrames = await readJson<Record<string, string[]>>(
    vscode.Uri.joinPath(globalStorageUri, `${themeId}_frames.json`),
  );
  return legacyManifest && legacyFrames ? { manifest: legacyManifest, frames: legacyFrames } : undefined;
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
    overall_scale?: number;
    enemy_config?: EnemyConfig;
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
    if (tuning.overall_scale !== undefined) {
      const overall = Number(tuning.overall_scale);
      if (Number.isFinite(overall) && overall > 0) {
        manifest.viewport.overall_scale = overall;
      }
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
      const rivalAtlas = await processRivalAtlas(buffer, manifest);
      output = rivalAtlas.output;
      frameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
    } else if (item?.kind === 'object_atlas' && item.object_rows?.length) {
      const objectAtlas = await processObjectAtlas(buffer, manifest, item.object_rows);
      output = objectAtlas.output;
      frameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, item.object_rows);
    } else if (item?.kind === 'object_atlas') {
      output = await optimizeSpriteBoardCanvas(buffer, 4, 3);
      const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 3 });
      const specs = item.object_specs?.length ? item.object_specs : themeObjectSpecs(manifest).slice(0, 12);
      frameKeys = applyLegacyObjectFrames(frames, spritePackage.slots, specs);
    } else if (item?.kind === 'background_decor_atlas') {
      const rows = item.decor_rows?.length ? item.decor_rows : createDecorBoardRows(themeDecorSpecs(manifest)).flat();
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
      await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
        ...item,
        status: 'pending',
        generation_error: undefined,
        revision: item.revision + 1,
        frame_keys: frameKeys,
        updated_at: new Date().toISOString(),
      });
    }

    await writeThemeFiles(globalStorageUri, manifest, frames);
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

  const imagesByFilename = new Map(reviewImages.imageUris.map((imageUri) => [basename(imageUri), imageUri]));
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  return {
    theme_id: themeId,
    display_name: document?.display_name ?? displayName,
    entries: (document?.items ?? []).map((item) => {
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
    item.prompt = buildCharacterAtlasPrompt(direction, characterName, manifest.display_name);
  }

  await writeThemeFiles(globalStorageUri, manifest, frames);
  await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
    ...item,
    updated_at: new Date().toISOString(),
  });
  return { manifest, frames };
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

  const notes = [
    'Regenerate this character sprite board at the universal production character scale.',
    'Use an exact 512 x 512 pixel generation canvas with the 5-column by 4-row layout from the original prompt.',
    `In every walking and neutral-standing cell, the complete character from head to feet must occupy exactly ${CHARACTER_TARGET_CONTENT_PERCENT}% of that cell height.`,
    'Override any earlier feet-on-edge guidance: leave visible solid-magenta padding above and below every sprite so no pixels touch or cross a horizontal row boundary.',
    'Keep the complete fourth row, including every foot and piece of equipment, inside the canvas with solid-magenta padding below it.',
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
    badges: [],
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

  const reviewItems = createReviewItems(plan, manifest, creativeDirection);
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
  );
  const reviewItems = expectedItems.map((expected) => {
    const saved = document.items.find((item) => item.id === expected.id);
    return saved ? { ...expected, ...saved } : expected;
  });

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

  const people = manifest.roster_agents.map((agent) => ({
    itemId: `agent_${agent.slot_id}`,
    frameKey: `agent_${agent.slot_id}`,
    name: agent.name,
  }));

  for (let index = 0; index < people.length; index++) {
    throwIfCancelled(isCancelled);
    const entry = people[index];
    onProgress(`${entry.name} (${index + 1}/${people.length})`);
    const item = reviewItems.find((candidate) => candidate.id === entry.itemId)!;
    await runNonFatalBoardStep(entry.name, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
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
        async () => {
          const generated = await generateThemeImage(item.prompt, imageGenerationOptions);
          throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
          const { output, spritePackage } = await processCharacterAtlas(generated, manifest);
          throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
          await saveReviewImage(reviewDirectoryUri, item.filename, output);
          throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
          frames[entry.frameKey] = spritePackage.slots.map((slot) => slot.data);
          await markGenerated(globalStorageUri, themeId, plan.display_name, item);
          await writeThemeFiles(globalStorageUri, manifest, frames);
        },
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const rivalItems = reviewItems.filter((item) => item.kind === 'rival_atlas');
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
  const environmentItem = reviewItems.find((item) => item.id === 'environment')!;
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
  const decorItem = reviewItems.find((item) => item.id === 'background_decor');
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
  const objectItems = reviewItems.filter((item) => item.kind === 'object_atlas');
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
  const expressionsItem = reviewItems.find((item) => item.id === 'expressions')!;
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
  const achievementsItem = reviewItems.find((item) => item.id === 'achievements')!;
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

  const replacementPrompt = buildReplacementPrompt(item, notes, loadedTheme.manifest);
  const prompt = selectThemeImageRetryPrompt(item.prompt, replacementPrompt, feedback, mode);
  onProgress?.(`Regenerating ${item.label}...`);

  let generated: Buffer;
  try {
    generated = item.kind === 'environment'
      ? await generateEnvironmentImage(prompt, imageGenerationOptions)
      : await generateThemeImage(prompt, imageGenerationOptions);
  } catch (error) {
    await recordUserCorrectableGenerationError(globalStorageUri, themeId, item.id, error);
    throw error;
  }
  throwIfCancelled(undefined, imageGenerationOptions.signal);
  const { manifest, frames } = loadedTheme;
  let output = generated;
  let frameKeys = item.frame_keys;

  if (item.kind === 'character_atlas') {
    const characterAtlas = await processCharacterAtlas(generated, manifest);
    output = characterAtlas.output;
    const spritePackage = characterAtlas.spritePackage;
    const frameKey = item.frame_keys[0] || item.id;
    frames[frameKey] = spritePackage.slots.map((slot) => slot.data);
    frameKeys = [frameKey];
  } else if (item.kind === 'rival_atlas') {
    const rows = rivalRowsForItem(item, manifest);
    item.rival_rows = rows;
    const rivalAtlas = await processRivalAtlas(generated, manifest);
    output = rivalAtlas.output;
    frameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
  } else if (item.kind === 'environment') {
    output = await normalizeEnvironmentImage(generated);
    frames.environment_background = [dataUri(output)];
    manifest.viewport.background_asset = 'frames.json#environment_background';
    frameKeys = ['environment_background'];
  } else if (item.kind === 'object_atlas') {
    // retryThemeImage reconstructs object_rows for legacy items, so retries
    // always use the animated object-board path.
    const rows = item.object_rows?.length ? item.object_rows : reconstructObjectRows(item, manifest);
    item.object_rows = rows;
    const objectAtlas = await processObjectAtlas(generated, manifest, rows);
    output = objectAtlas.output;
    frameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, rows);
  } else if (item.kind === 'background_decor_atlas') {
    const rows = item.decor_rows?.length ? item.decor_rows : createDecorBoardRows(themeDecorSpecs(manifest)).flat();
    const decorAtlas = await processDecorAtlas(generated, manifest);
    output = decorAtlas.output;
    frameKeys = applyDecorBoardFrames(frames, decorAtlas.spritePackage.slots, rows);
    manifest.viewport.projectile_asset = 'frames.json#projectile';
    item.decor_rows = rows;
  } else if (item.kind === 'expression_atlas') {
    output = await optimizeSpriteBoardCanvas(generated, 4, 4);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 4 });
    frameKeys = applyExpressionFrames(frames, spritePackage.slots);
  } else if (item.kind === 'achievement_atlas') {
    output = await optimizeSpriteBoardCanvas(generated, 5, 4);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest);
    frameKeys = applyAchievementFrames(frames, spritePackage.slots);
  } else {
    output = await optimizeSpriteBoard(generated);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest);
    frameKeys = applyLegacyEmoteFrames(frames, spritePackage.slots);
  }

  throwIfCancelled(undefined, imageGenerationOptions.signal);
  const reviewDirectoryUri = themeImagesDirectoryUri(globalStorageUri, themeId);
  await vscode.workspace.fs.createDirectory(reviewDirectoryUri);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(reviewDirectoryUri, item.filename), output);
  await writeThemeFiles(globalStorageUri, manifest, frames);
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
  return {
    columns: 5,
    rows: 4,
    // Walking and neutral-standing slots are stable body-height references.
    scaleReferenceSlots: [0, 1, 2, 3, 4, 16],
    targetContentHeight: CHARACTER_TARGET_CONTENT_HEIGHT,
    maxContentExtent: 120,
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

async function processObjectAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
  rows: ThemeObjectBoardRow[],
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  if (rows.length !== 5) throw new Error('Animated object boards require exactly five rows.');
  const rowSlots = rows.map((_row, rowIndex) =>
    Array.from({ length: 4 }, (_unused, columnIndex) => rowIndex * 4 + columnIndex),
  );
  const objectSlots = rows.flatMap((row, rowIndex) => row.kind === 'object' ? rowSlots[rowIndex] : []);
  // Slice the provider output before optimizing the retained review image. This
  // avoids re-slicing a 512px square whose five logical rows cannot all have an
  // identical integer height. Each animation row shares one crop and anchor.
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 4,
    rows: 5,
    scaleReferenceSlots: objectSlots,
    targetContentHeight: 104,
    maxContentExtent: 120,
    normalizationGroups: rowSlots,
  });
  const output = await optimizeSpriteBoardCanvas(generated, 4, 5);
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
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  const rowGroups = Array.from({ length: 4 }, (_row, rowIndex) =>
    Array.from({ length: 5 }, (_col, colIndex) => rowIndex * 5 + colIndex),
  );
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 5,
    rows: 4,
    scaleReferenceSlots: Array.from({ length: 20 }, (_unused, cell) => cell),
    targetContentHeight: CHARACTER_TARGET_CONTENT_HEIGHT,
    maxContentExtent: 120,
    normalizationGroups: rowGroups,
  });
  const output = await optimizeSpriteBoardCanvas(generated, 5, 4);
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

function themeDecorSpecs(manifest: ThemeManifest): Array<{ decor_id: string; display_name: string }> {
  return (manifest.decor_objects ?? []).slice(0, 9).map((decor) => ({
    decor_id: decor.decor_id,
    display_name: decor.display_name,
  }));
}

function createReviewItems(
  plan: ThemePlan,
  manifest: ThemeManifest,
  creativeDirection: string,
): Array<Omit<ThemeImageReviewItem, 'updated_at'>> {
  const characterCreativeDirection = `Creative direction: ${plan.creative_direction}`;
  const characterItems = manifest.roster_agents.map((agent) => ({
    id: `agent_${agent.slot_id}`,
    filename: `agent_${String(agent.slot_id + 1).padStart(2, '0')}_${toSafeFileStem(agent.name)}.png`,
    label: agent.name,
    kind: 'character_atlas' as const,
    status: 'pending' as const,
    prompt: buildCharacterAtlasPrompt(characterCreativeDirection, agent.name, plan.display_name),
    revision: 0,
    frame_keys: [`agent_${agent.slot_id}`],
    subject: agent.name,
  }));
  const rivalBoards = createRivalBoardRows(themeRivalSpecs(manifest));
  const enemyItems = rivalBoards.map((rows, index) => {
    const firstEnemy = index * rows.length + 1;
    const lastEnemy = firstEnemy + rows.length - 1;
    return {
      id: `rivals_${String(index + 1).padStart(2, '0')}`,
      filename: `rivals_${String(index + 1).padStart(2, '0')}.png`,
      label: `Rivals ${firstEnemy}–${lastEnemy}`,
      kind: 'rival_atlas' as const,
      status: 'pending' as const,
      prompt: buildRivalAtlasPrompt(creativeDirection, plan.display_name, rows),
      revision: 0,
      frame_keys: rivalBoardFrameKeys(rows),
      rival_rows: rows,
    };
  });
  const objectSpecs = themeObjectSpecs(manifest, plan.object_motion_hints);
  const objectItems = createObjectBoardRows(objectSpecs).map((rows, index) => {
    const objectRows = rows.filter((row): row is Extract<ThemeObjectBoardRow, { kind: 'object' }> => row.kind === 'object');
    const firstObject = index * 5 + 1;
    const lastObject = firstObject + objectRows.length - 1;
    return {
      id: `objects_${String(index + 1).padStart(2, '0')}`,
      filename: `objects_${String(index + 1).padStart(2, '0')}.png`,
      label: index === 2
        ? `Animated objects ${firstObject}–${lastObject} + build effects`
        : `Animated objects ${firstObject}–${lastObject}`,
      kind: 'object_atlas' as const,
      status: 'pending' as const,
      prompt: buildObjectAtlasPrompt(creativeDirection, plan.display_name, rows),
      revision: 0,
      frame_keys: objectBoardFrameKeys(rows),
      object_specs: objectRows.map(({ object_id, display_name }) => ({ object_id, display_name })),
      object_rows: rows,
    };
  });
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
    createDecorReviewItem(plan, manifest, creativeDirection),
    ...objectItems,
    {
      id: 'expressions',
      filename: 'expressions.png',
      label: '16 expressions',
      kind: 'expression_atlas',
      status: 'pending',
      prompt: buildExpressionAtlasPrompt(creativeDirection, plan.display_name, plan.expressions),
      revision: 0,
      frame_keys: plan.expressions.map((_name, index) => `expression_${index}`),
      expression_names: plan.expressions,
    },
    {
      id: 'achievements',
      filename: 'achievements.png',
      label: '20 achievement badges',
      kind: 'achievement_atlas',
      status: 'pending',
      prompt: buildAchievementAtlasPrompt(creativeDirection, plan.display_name, plan.achievements),
      revision: 0,
      frame_keys: plan.achievements.map((_name, index) => `achievement_${index}`),
      achievement_names: plan.achievements,
    },
  ];
}

function createDecorReviewItem(
  plan: ThemePlan,
  manifest: ThemeManifest,
  creativeDirection: string,
): Omit<ThemeImageReviewItem, 'updated_at'> {
  const specs = themeDecorSpecs(manifest);
  const rows = createDecorBoardRows(specs);
  return {
    id: 'background_decor',
    filename: 'background_decor.png',
    label: 'Background decor',
    kind: 'background_decor_atlas',
    status: 'pending',
    prompt: buildBackgroundDecorPrompt(creativeDirection, plan.display_name, rows),
    revision: 0,
    frame_keys: decorBoardFrameKeys(rows),
    decor_rows: rows.flat(),
  };
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
  const generated = await generateThemeImage(item.prompt, options);
  throwIfCancelled(undefined, options?.signal);
  const rows = item.decor_rows?.length ? item.decor_rows : createDecorBoardRows(themeDecorSpecs(manifest)).flat();
  const decorAtlas = await processDecorAtlas(generated, manifest);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, decorAtlas.output);
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
  const generated = await generateThemeImage(item.prompt, options);
  throwIfCancelled(undefined, options?.signal);
  const rows = rivalRowsForItem(item, manifest);
  const rivalAtlas = await processRivalAtlas(generated, manifest);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, rivalAtlas.output);
  throwIfCancelled(undefined, options?.signal);
  applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

/**
 * Rival rows for a rival-board item. Uses the item's stored `rival_rows` when present,
 * otherwise reconstructs them from the manifest roster by the board's index (parsed
 * from `rivals_NN`), so retries/uploads of older items still resolve four enemies.
 */
function rivalRowsForItem(
  item: Pick<ThemeImageReviewItem, 'id' | 'rival_rows'>,
  manifest: ThemeManifest,
): ThemeRivalBoardRow[] {
  if (item.rival_rows?.length) return item.rival_rows;
  const boards = createRivalBoardRows(themeRivalSpecs(manifest));
  const boardIndex = Math.max(0, (Number(/rivals_(\d+)/.exec(item.id)?.[1] ?? '1') || 1) - 1);
  return boards[boardIndex] ?? boards[0];
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
  const generated = await generateThemeImage(item.prompt, options);
  throwIfCancelled(undefined, options?.signal);
  if (!item.object_rows?.length) throw new Error(`${item.label} is missing object-board row metadata.`);
  const objectAtlas = await processObjectAtlas(generated, manifest, item.object_rows);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, objectAtlas.output);
  throwIfCancelled(undefined, options?.signal);
  applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, item.object_rows);
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
  onProgress('16-expression sprite sheet (24/25)');
  const generated = await generateThemeImage(item.prompt, options);
  throwIfCancelled(undefined, options?.signal);
  const output = await optimizeSpriteBoardCanvas(generated, 4, 4);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, output);
  const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 4 });
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
  onProgress('20 achievement badges (25/25)');
  const generated = await generateThemeImage(item.prompt, options);
  throwIfCancelled(undefined, options?.signal);
  const output = await optimizeSpriteBoardCanvas(generated, 5, 4);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, output);
  const spritePackage = await sliceAndNormalizeAtlas(output, manifest);
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

function buildReplacementPrompt(
  item: ThemeImageReviewItem,
  creativeDirection: string,
  manifest: ThemeManifest,
): string {
  if (item.kind === 'environment') return buildEnvironmentPrompt(creativeDirection, manifest.display_name);
  if (item.kind === 'object_atlas') {
    // retryThemeImage guarantees object_rows is populated (reconstructed for
    // legacy items), so object-atlas retries always use the animated board path.
    const rows = item.object_rows?.length
      ? item.object_rows
      : reconstructObjectRows(item, manifest);
    return buildObjectAtlasPrompt(creativeDirection, manifest.display_name, rows);
  }
  if (item.kind === 'background_decor_atlas') {
    const rows = item.decor_rows?.length
      ? decorRowsToBoard(item.decor_rows)
      : createDecorBoardRows(themeDecorSpecs(manifest));
    return buildBackgroundDecorPrompt(creativeDirection, manifest.display_name, rows);
  }
  if (item.kind === 'expression_atlas') {
    return buildExpressionAtlasPrompt(creativeDirection, manifest.display_name, item.expression_names ?? defaultNames('Expression', 16));
  }
  if (item.kind === 'achievement_atlas') {
    return buildAchievementAtlasPrompt(creativeDirection, manifest.display_name, item.achievement_names ?? defaultNames('Achievement Badge', 20));
  }
  if (item.kind === 'emote_atlas') return buildEmoteAtlasPrompt(creativeDirection, manifest.display_name);
  return buildCharacterAtlasPrompt(creativeDirection, item.subject ?? item.label, manifest.display_name);
}

function renameCharacterInPrompt(prompt: string, previousName: string, characterName: string): string {
  if (!prompt || !previousName || previousName === characterName) return prompt;
  const quotedName = `"${previousName}"`;
  const index = prompt.indexOf(quotedName);
  if (index < 0) return '';
  return `${prompt.slice(0, index)}"${characterName}"${prompt.slice(index + quotedName.length)}`;
}

/**
 * Reconstruct a 5-row animated object board for a legacy object-atlas review item
 * that predates animated boards (no object_rows). Uses the item's stored object
 * specs (falling back to the manifest) so retries always take the animated path.
 * Layout: up to 3 object rows, then a poof row and a crate row, padded to 5 rows.
 */
function reconstructObjectRows(
  item: Pick<ThemeImageReviewItem, 'object_specs'>,
  manifest: ThemeManifest,
): ThemeObjectBoardRow[] {
  const specs = item.object_specs?.length
    ? item.object_specs
    : themeObjectSpecs(manifest).slice(0, 3);
  const objectRows: ThemeObjectBoardRow[] = specs.slice(0, 3).map((spec) => ({
    kind: 'object' as const,
    object_id: spec.object_id,
    display_name: spec.display_name,
  }));
  const rows: ThemeObjectBoardRow[] = [...objectRows, { kind: 'poof' }, { kind: 'crate' }];
  while (rows.length < 5) rows.push({ kind: 'crate' });
  return rows.slice(0, 5);
}

function themeObjectSpecs(
  manifest: ThemeManifest,
  motionHints?: string[],
): ThemeObjectPromptSpec[] {
  return manifest.buildable_objects.slice(0, 13).map((object, index) => {
    // build_order 0 is the themed ranged-weapon rack (see themePlan.ts); it gets
    // dedicated rack visual guidance and ignores any planner motion hint.
    const isRangedRack = index === 0;
    const hint = !isRangedRack ? (motionHints?.[index] ?? '').trim() : '';
    return {
      object_id: object.object_id,
      display_name: object.display_name,
      ...(isRangedRack ? { is_ranged_rack: true } : {}),
      ...(hint ? { motion_hint: hint } : {}),
    };
  });
}

function themeRivalSpecs(manifest: ThemeManifest): ThemeRivalPromptSpec[] {
  return manifest.roster_rivals.map((rival) => ({
    // rival_id already carries the `rival_` prefix (see themePlan.ts); strip it so
    // frame keys built as `rival_<id>` don't double-prefix.
    rival_id: rival.rival_id.replace(/^rival_/, ''),
    display_name: rival.name,
  }));
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

function applyObjectBoardFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  rows: ThemeObjectBoardRow[],
): string[] {
  const keys: string[] = [];
  rows.forEach((row, rowIndex) => {
    const rowFrames = slots.slice(rowIndex * 4, rowIndex * 4 + 4).map((slot) => slot.data);
    const key = row.kind === 'object' ? `object_${row.object_id}` : row.kind;
    frames[key] = row.kind === 'crate' ? rowFrames.slice(0, 1) : rowFrames;
    keys.push(key);
  });
  return keys;
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
  const keys = slots.slice(0, 16).map((slot, index) => {
    const key = `expression_${index}`;
    frames[key] = [slot.data];
    return key;
  });
  const legacyAliases = ['emote_smile', 'emote_sleep', 'emote_idea', 'emote_team'];
  legacyAliases.forEach((key, index) => {
    if (slots[index]) frames[key] = [slots[index].data];
  });
  return keys;
}

function applyAchievementFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
): string[] {
  return slots.slice(0, 20).map((slot, index) => {
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

async function writeThemeFiles(
  globalStorageUri: vscode.Uri,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
): Promise<void> {
  await vscode.workspace.fs.createDirectory(themeDirectoryUri(globalStorageUri, manifest.theme_id));
  await vscode.workspace.fs.writeFile(themeManifestUri(globalStorageUri, manifest.theme_id), jsonBuffer(manifest));
  await vscode.workspace.fs.writeFile(themeFramesUri(globalStorageUri, manifest.theme_id), jsonBuffer(frames));
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
