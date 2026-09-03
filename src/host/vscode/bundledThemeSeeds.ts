/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from 'vscode';
import type { ThemeManifest } from '../../shared/types';
import { listThemes } from '../../extension/themeService';
import {
  legacyFramesPath,
  legacyManifestPath,
  resolveThemeFileStore,
  type ThemeStorageRoot,
} from '../../extension/themeFileStore';
import { log } from './log';

/**
 * Relocated out of src/extension/themeService.ts (project-plan task pC-t1):
 * this is the ONLY themeService caller that ever needed a SECOND vscode.Uri
 * root (`extensionUri`, for reading the extension's own shipped
 * `media/themes/*` resources) alongside the theme-storage root, and it reads
 * those bundled assets via raw `vscode.workspace.fs` calls rather than
 * through a ThemeFileStore. Keeping it here (extension-host-only, allowed to
 * import 'vscode') is what lets themeService.ts itself become fully
 * vscode-free and require-able from a bare Node process. Behavior,
 * on-disk layout (legacy flat `<theme_id>_manifest.json` / `_frames.json`
 * naming), and call site (src/host/vscode/extension.ts) are unchanged.
 */

export interface SeedResult {
  seeded: string[];
  skipped: string[];
}

/**
 * Seed bundled starter themes into global storage on first run, so a freshly
 * installed plugin has at least one theme available out-of-box. Also seeds
 * any bundled theme added in a later release that an existing user's global
 * storage doesn't yet have (per-theme presence check, NOT a list-empty
 * check). Never overwrites an existing theme dir. Never throws: every
 * failure is caught, logged, and the theme id (when known) is recorded in
 * `skipped`.
 */
export async function seedBundledThemes(
  extensionUri: vscode.Uri,
  globalStorageUri: ThemeStorageRoot,
): Promise<SeedResult> {
  const result: SeedResult = { seeded: [], skipped: [] };
  const startedAt = Date.now();
  try {
    const existing = new Set((await listThemes(globalStorageUri)).map((t) => t.theme_id));

    // Bundled seed themes are read from the extension's own shipped resources
    // (extensionUri), a different root than the theme storage this refactor
    // scopes to — that read stays a direct vscode call. The WRITE side (into
    // theme storage, legacy flat naming) goes through the store.
    const store = resolveThemeFileStore(globalStorageUri);
    await store.mkdirp('');

    const bundledThemesUri = vscode.Uri.joinPath(extensionUri, 'media', 'themes');
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(bundledThemesUri);
    } catch {
      return result;
    }

    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) continue;
      const themeDirUri = vscode.Uri.joinPath(bundledThemesUri, name);
      let manifest: Partial<ThemeManifest> | undefined;
      try {
        const manifestBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(themeDirUri, 'manifest.json'));
        manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as Partial<ThemeManifest>;
      } catch {
        continue;
      }
      const themeId = manifest?.theme_id;
      if (!themeId) continue;

      if (existing.has(themeId)) {
        result.skipped.push(themeId);
        continue;
      }

      try {
        const framesBytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(themeDirUri, 'frames.json'),
        );
        await store.writeFile(legacyManifestPath(themeId), Buffer.from(JSON.stringify(manifest, null, 2)));
        await store.writeFile(legacyFramesPath(themeId), framesBytes);
        result.seeded.push(themeId);
      } catch (error) {
        console.warn(`TycoonAgents: Could not seed bundled theme "${name}":`, error);
        result.skipped.push(themeId);
      }
    }
  } catch (error) {
    console.warn('TycoonAgents: Could not seed bundled themes:', error);
    log(`seedBundledThemes: FAILED root=${String(globalStorageUri)} error=${String(error)}`);
  }
  log(
    `seedBundledThemes: root=${String(globalStorageUri)} seeded=[${result.seeded.join(', ')}] skipped=[${result.skipped.join(', ')}] durationMs=${Date.now() - startedAt}`,
  );
  return result;
}
