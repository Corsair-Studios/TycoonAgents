/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Vscode-free theme export/import archive operations (project-plan task
 * pB-t2, "Standalone theme host: export/import"). Extracted out of
 * themeService.ts so BOTH the VS Code extension and the standalone Node host
 * can reuse the exact same zip logic (themeArchive.ts's fflate-based
 * createThemeArchive/parseThemeArchive) via a `ThemeFileStore`, without ever
 * loading a module that `import * as vscode from 'vscode'`s.
 *
 * This module (and everything it imports) MUST NOT import 'vscode', directly
 * or transitively. themeService.ts's exportThemeArchive()/importThemeArchive()
 * are now thin wrappers: resolve a ThemeFileStore from a vscode.Uri, then
 * delegate to exportThemeArchiveFromStore()/importThemeArchiveToStore() here
 * — same exported signatures, identical behavior, so panel.ts and every other
 * existing call site is unaffected.
 *
 * The standalone host requires the COMPILED out/src/extension/themeArchiveOps.js
 * via the same createRequire bridge pattern themeFileStoreFs.mjs already
 * established (see standalone/src/themeArchive.mjs).
 */

import type { ThemeManifest } from '../shared/types';
import { createThemeArchive, parseThemeArchive } from './themeArchive';
import type { ThemeArchiveContents } from './themeArchive';
import type { ThemeFileStore, ThemeFileStoreEntry } from './themeFileStore';
import {
  joinThemePath,
  legacyFramesPath,
  legacyImageReviewPath,
  legacyImagesDirectoryPath,
  legacyManifestPath,
  legacyPlanPath,
  legacyReviewPath,
  themeDirectoryPath,
  themeFramesPath,
  themeManifestPath,
  themeReviewPath,
  themesDirectoryPath,
} from './themeFileStore';
import { upgradeThemeManifest } from './themeMigration';
import { validateThemeIntegrity } from './themeHealth';
import { summarizeThemeApproval } from './themeApproval';
import type { ThemeApprovalSummary } from './themeApproval';
import { withoutRedundantBuildableObjectsItem } from './themeGenerationState';

function isThemeId(value: string): boolean {
  return /^[a-z0-9_]+$/.test(value);
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2));
}

async function readJson<T>(store: ThemeFileStore, relativePath: string): Promise<T | undefined> {
  try {
    const bytes = await store.readFile(relativePath);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

async function addFileIfPresent(
  store: ThemeFileStore,
  files: Map<string, Uint8Array>,
  path: string,
  relativePath: string,
): Promise<void> {
  try {
    files.set(path, await store.readFile(relativePath));
  } catch {
    // Optional legacy sidecar is absent.
  }
}

/**
 * Recursively collects every file under `directoryPath` into `files`, keyed
 * by its path relative to the theme root. Moved verbatim from themeService.ts
 * (formerly module-private there) — PRESERVES the 0.0.371 `images/raw/`
 * exclusion exactly: raw pre-slice atlas buffers back the resume-reslice
 * recovery path and must never be part of a portable export.
 */
async function collectDirectoryFiles(
  store: ThemeFileStore,
  directoryPath: string,
  relativeDirectory: string,
  files: Map<string, Uint8Array>,
): Promise<void> {
  let entries: ThemeFileStoreEntry[];
  try {
    entries = await store.readdir(directoryPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (relativePath === 'images/raw' || relativePath.startsWith('images/raw/')) {
      continue;
    }
    const path = `${directoryPath}/${entry.name}`;
    if (entry.isDirectory) {
      await collectDirectoryFiles(store, path, relativePath, files);
    } else if (entry.isFile) {
      files.set(relativePath, await store.readFile(path));
    }
  }
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

/**
 * Store-based equivalent of themeService.ts's loadTheme(), used only by the
 * pre-per-theme-directory legacy-normalize fallback in
 * exportThemeArchiveFromStore() below.
 */
async function loadThemeFromStore(
  store: ThemeFileStore,
  themeId: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  const modernManifest = await readJson<ThemeManifest>(store, themeManifestPath(themeId));
  const modernFrames = await readJson<Record<string, string[]>>(store, themeFramesPath(themeId));
  if (modernManifest && modernFrames) {
    const { manifest: upgradedModern } = upgradeThemeManifest(modernManifest);
    logThemeIntegrityIssues(themeId, upgradedModern, modernFrames);
    return { manifest: upgradedModern, frames: modernFrames };
  }

  const legacyManifest = await readJson<ThemeManifest>(store, legacyManifestPath(themeId));
  const legacyFrames = await readJson<Record<string, string[]>>(store, legacyFramesPath(themeId));
  if (legacyManifest && legacyFrames) {
    const { manifest: upgradedLegacy } = upgradeThemeManifest(legacyManifest);
    logThemeIntegrityIssues(themeId, upgradedLegacy, legacyFrames);
    return { manifest: upgradedLegacy, frames: legacyFrames };
  }
  return undefined;
}

/**
 * Store-based equivalent of themeImageReviewState.ts's
 * loadThemeImageReviewDocument(), used only to compute export approval.
 * Checks the same two candidate locations (modern per-theme review.json,
 * then the legacy flat-storage sidecar) as the vscode-backed original.
 */
async function loadThemeImageReviewDocumentFromStore(
  store: ThemeFileStore,
  themeId: string,
): Promise<{ items: Array<{ status?: unknown }> } | undefined> {
  const candidates = [themeReviewPath(themeId), legacyImageReviewPath(themeId)];
  for (const relativePath of candidates) {
    const parsed = await readJson<{ version?: number; theme_id?: string; items?: Array<{ status?: unknown }> }>(
      store,
      relativePath,
    );
    if (parsed?.version === 1 && parsed.theme_id === themeId && Array.isArray(parsed.items)) {
      const items = withoutRedundantBuildableObjectsItem(
        parsed.items as Array<{ id: string; status?: unknown }>,
      );
      return { items };
    }
  }
  return undefined;
}

async function getThemeApprovalSummaryFromStore(
  store: ThemeFileStore,
  themeId: string,
): Promise<ThemeApprovalSummary> {
  if (!isThemeId(themeId)) return summarizeThemeApproval(undefined);
  const document = await loadThemeImageReviewDocumentFromStore(store, themeId);
  return summarizeThemeApproval(document?.items);
}

/**
 * Package a saved theme and all of its retained assets into a portable zip.
 * Store-based counterpart of themeService.ts's exportThemeArchive() — same
 * logic, parameterized on a ThemeFileStore instead of a vscode.Uri.
 */
export async function exportThemeArchiveFromStore(store: ThemeFileStore, themeId: string): Promise<Uint8Array> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  const approval = await getThemeApprovalSummaryFromStore(store, themeId);
  if (!approval.export_ready) {
    throw new Error(`Approve all theme images before exporting (${approval.accepted}/${approval.total} approved).`);
  }

  const files = new Map<string, Uint8Array>();
  await collectDirectoryFiles(store, themeDirectoryPath(themeId), '', files);

  // Normalize themes written by releases that predate per-theme directories.
  if (!files.has('manifest.json') || !files.has('frames.json')) {
    files.clear();
    const loaded = await loadThemeFromStore(store, themeId);
    if (!loaded) throw new Error('Theme not found.');
    files.set('manifest.json', jsonBuffer(loaded.manifest));
    files.set('frames.json', jsonBuffer(loaded.frames));
    await addFileIfPresent(store, files, 'plan.json', legacyPlanPath(themeId));
    await addFileIfPresent(store, files, 'review.json', legacyReviewPath(themeId));
    await addFileIfPresent(store, files, 'review.json', legacyImageReviewPath(themeId));
    await collectDirectoryFiles(store, legacyImagesDirectoryPath(themeId), 'images', files);
  }

  return createThemeArchive(files);
}

/**
 * Validate and install a theme archive. Existing themes require explicit
 * replacement. Store-based counterpart of themeService.ts's
 * importThemeArchive() — same logic, parameterized on a ThemeFileStore
 * instead of a vscode.Uri.
 */
export async function importThemeArchiveToStore(
  store: ThemeFileStore,
  data: Uint8Array | ThemeArchiveContents,
  replace = false,
): Promise<{ theme_id: string; display_name: string; replaced: boolean }> {
  const archive = data instanceof Uint8Array ? parseThemeArchive(data) : data;
  const themesPath = themesDirectoryPath();
  const targetPath = themeDirectoryPath(archive.themeId);
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const stagingPath = joinThemePath(themesPath, `.import_${archive.themeId}_${nonce}`);
  const backupPath = joinThemePath(themesPath, `.backup_${archive.themeId}_${nonce}`);
  await store.mkdirp(themesPath);

  const targetExists = await store.exists(targetPath);
  if (targetExists && !replace) throw new Error(`A theme with ID "${archive.themeId}" already exists.`);

  let backupCreated = false;
  try {
    for (const [relativePath, bytes] of archive.files) {
      const segments = relativePath.split('/');
      const filePath = joinThemePath(stagingPath, ...segments);
      if (segments.length > 1) {
        await store.mkdirp(joinThemePath(stagingPath, ...segments.slice(0, -1)));
      }
      await store.writeFile(filePath, bytes);
    }

    if (targetExists) {
      await store.rename(targetPath, backupPath, { overwrite: false });
      backupCreated = true;
    }
    await store.rename(stagingPath, targetPath, { overwrite: false });
    if (backupCreated) {
      try {
        await store.remove(backupPath, { recursive: true });
        backupCreated = false;
      } catch (error) {
        console.warn(`TycoonAgents: Imported ${archive.themeId}, but could not remove its backup:`, error);
      }
    }
  } catch (error) {
    if (backupCreated && !(await store.exists(targetPath))) {
      try {
        await store.rename(backupPath, targetPath, { overwrite: false });
        backupCreated = false;
      } catch {
        // Preserve the backup directory for manual recovery if rollback itself fails.
      }
    }
    try {
      await store.remove(stagingPath, { recursive: true });
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
