import * as vscode from 'vscode';
import type { AgentConfig, BuildableObject, RivalConfig, ThemeManifest } from '../shared/types';
import { expandThemePlan } from './translator';
import {
  buildAchievementAtlasPrompt,
  buildCharacterAtlasPrompt,
  buildEmoteAtlasPrompt,
  buildEnvironmentPrompt,
  buildExpressionAtlasPrompt,
  buildObjectAtlasPrompt,
  CHARACTER_TARGET_CONTENT_HEIGHT,
  CHARACTER_TARGET_CONTENT_PERCENT,
} from './themeAssetPrompts';
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
  ThemeImageReviewDocument,
  ThemeImageReviewItem,
  ThemeImageReviewStatus,
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
  // buildable-objects entry is intentionally not synthesized: current themes
  // already contain the complete 12-object board as `objects`.
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
    badges: [],
  };
  const frames: Record<string, string[]> = {};
  const directoryUri = themeDirectoryUri(globalStorageUri, themeId);
  const reviewDirectoryUri = themeImagesDirectoryUri(globalStorageUri, themeId);
  await vscode.workspace.fs.createDirectory(directoryUri);
  await vscode.workspace.fs.createDirectory(reviewDirectoryUri);
  await vscode.workspace.fs.writeFile(themePlanUri(globalStorageUri, themeId), jsonBuffer(plan));
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

  const characterEntries = manifest.roster_agents.map((agent) => ({
    itemId: `agent_${agent.slot_id}`,
    frameKey: `agent_${agent.slot_id}`,
    name: agent.name,
  }));
  const enemyEntries = manifest.roster_rivals.map((enemy) => ({
    itemId: enemy.rival_id,
    frameKey: enemy.rival_id,
    name: enemy.name,
  }));
  const people = [...characterEntries, ...enemyEntries];

  for (let index = 0; index < people.length; index++) {
    throwIfCancelled(isCancelled);
    const entry = people[index];
    onProgress(`${entry.name} (${index + 1}/${people.length})`);
    const item = reviewItems.find((candidate) => candidate.id === entry.itemId)!;
    await generateOrResumeThemeItem(
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
    );
  }

  throwIfCancelled(isCancelled);
  const environmentItem = reviewItems.find((item) => item.id === 'environment')!;
  await generateOrResumeThemeItem(
    globalStorageUri, themeId, plan.display_name, environmentItem, manifest, frames,
    onProgress, isCancelled, onReviewReady, waitForReview,
    () => generateEnvironmentAsset(
      globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
      environmentItem, imageGenerationOptions, onProgress,
    ),
  );

  throwIfCancelled(isCancelled);
  const objectsItem = reviewItems.find((item) => item.id === 'objects')!;
  await generateOrResumeThemeItem(
    globalStorageUri, themeId, plan.display_name, objectsItem, manifest, frames,
    onProgress, isCancelled, onReviewReady, waitForReview,
    () => generateObjectAsset(
      globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
      objectsItem, imageGenerationOptions, onProgress,
    ),
  );

  throwIfCancelled(isCancelled);
  const expressionsItem = reviewItems.find((item) => item.id === 'expressions')!;
  await generateOrResumeThemeItem(
    globalStorageUri, themeId, plan.display_name, expressionsItem, manifest, frames,
    onProgress, isCancelled, onReviewReady, waitForReview,
    () => generateExpressionAsset(
      globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
      expressionsItem, imageGenerationOptions, onProgress,
    ),
  );

  throwIfCancelled(isCancelled);
  const achievementsItem = reviewItems.find((item) => item.id === 'achievements')!;
  await generateOrResumeThemeItem(
    globalStorageUri, themeId, plan.display_name, achievementsItem, manifest, frames,
    onProgress, isCancelled, onReviewReady, waitForReview,
    () => generateAchievementAsset(
      globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
      achievementsItem, imageGenerationOptions, onProgress,
    ),
  );

  throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
  await writeThemeFiles(globalStorageUri, manifest, frames);
  throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
  return { manifest, frames };
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
  } else if (item.kind === 'environment') {
    output = await normalizeEnvironmentImage(generated);
    frames.environment_background = [dataUri(output)];
    manifest.viewport.background_asset = 'frames.json#environment_background';
    frameKeys = ['environment_background'];
  } else if (item.kind === 'object_atlas') {
    output = await optimizeSpriteBoardCanvas(generated, 4, 3);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 3 });
    const specs = item.object_specs?.length ? item.object_specs : themeObjectSpecs(manifest);
    frameKeys = applyObjectFrames(frames, spritePackage.slots, specs);
    item.object_specs = specs;
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
  const enemyItems = manifest.roster_rivals.map((enemy, index) => ({
    id: enemy.rival_id,
    filename: `enemy_${String(index + 1).padStart(2, '0')}_${toSafeFileStem(enemy.name)}.png`,
    label: enemy.name,
    kind: 'character_atlas' as const,
    status: 'pending' as const,
    prompt: buildCharacterAtlasPrompt(characterCreativeDirection, enemy.name, plan.display_name),
    revision: 0,
    frame_keys: [enemy.rival_id],
    subject: enemy.name,
  }));
  const objectSpecs = themeObjectSpecs(manifest);
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
    {
      id: 'objects',
      filename: 'objects.png',
      label: '12 objects',
      kind: 'object_atlas',
      status: 'pending',
      prompt: buildObjectAtlasPrompt(creativeDirection, plan.display_name, objectSpecs),
      revision: 0,
      frame_keys: objectSpecs.map((object) => `object_${object.object_id}`),
      object_specs: objectSpecs,
    },
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
  onProgress('Environment (20/23)');
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

async function generateObjectAsset(
  globalStorageUri: vscode.Uri,
  reviewDirectoryUri: vscode.Uri,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('12-object sprite sheet (21/23)');
  const generated = await generateThemeImage(item.prompt, options);
  throwIfCancelled(undefined, options?.signal);
  const output = await optimizeSpriteBoardCanvas(generated, 4, 3);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(reviewDirectoryUri, item.filename, output);
  const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 3 });
  throwIfCancelled(undefined, options?.signal);
  applyObjectFrames(frames, spritePackage.slots, item.object_specs ?? []);
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
  onProgress('16-expression sprite sheet (22/23)');
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
  onProgress('20 achievement badges (23/23)');
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
    return buildObjectAtlasPrompt(
      creativeDirection,
      manifest.display_name,
      item.object_specs?.length ? item.object_specs : themeObjectSpecs(manifest),
    );
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

function themeObjectSpecs(manifest: ThemeManifest): Array<{ object_id: string; display_name: string }> {
  return manifest.buildable_objects.slice(0, 12).map((object) => ({
    object_id: object.object_id,
    display_name: object.display_name,
  }));
}

function applyObjectFrames(
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
