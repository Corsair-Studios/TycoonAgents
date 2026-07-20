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

/**
 * Seed bundled starter themes into global storage on first run, so a freshly
 * installed plugin has at least one theme available out-of-box. Never
 * overwrites existing user themes. Best-effort: failures are swallowed.
 */
export async function seedBundledThemes(
  extensionUri: vscode.Uri,
  globalStorageUri: ThemeStorageRoot,
): Promise<void> {
  try {
    const existing = await listThemes(globalStorageUri);
    if (existing.length > 0) return;

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
      return;
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
      if (!manifest?.theme_id) continue;

      try {
        const framesBytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(themeDirUri, 'frames.json'),
        );
        await store.writeFile(legacyManifestPath(manifest.theme_id), Buffer.from(JSON.stringify(manifest, null, 2)));
        await store.writeFile(legacyFramesPath(manifest.theme_id), framesBytes);
      } catch (error) {
        console.warn(`TycoonAgents: Could not seed bundled theme "${name}":`, error);
      }
    }
  } catch (error) {
    console.warn('TycoonAgents: Could not seed bundled themes:', error);
  }
}
