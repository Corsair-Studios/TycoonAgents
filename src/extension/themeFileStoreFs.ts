/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ThemeFileStore,
  ThemeFileStoreEntry,
  ThemeFileStoreRemoveOptions,
  ThemeFileStoreRenameOptions,
  ThemeFileStoreStat,
} from './themeFileStore';

/**
 * Node `fs/promises`-backed ThemeFileStore, rooted at a plain local
 * filesystem path. Same shape as the ad-hoc `createFsThemeFileStore` helper
 * duplicated across test/bundledThemeDefault.test.ts,
 * test/themeDiskSizeRawExclusion.test.ts and
 * test/themeResumeResliceRecovery.test.ts — this is the one production
 * implementation those tests' local copies mirror.
 *
 * Exists because `vscode.workspace.fs` proxies every call through the
 * extension host's RPC channel to the renderer process, which for a
 * multi-megabyte file (e.g. a bundled theme's frames.json) can take upwards
 * of ten seconds per read. When the storage root resolves to a real local
 * path (`file:` or `vscode-userdata:` scheme — see
 * themeFileStoreVscode.ts's createVscodeThemeFileStore, which selects this
 * store for those schemes), reading straight off disk via Node avoids that
 * IPC entirely and keeps first-load theme reads well under a second.
 */
export function createFsThemeFileStore(root: string): ThemeFileStore {
  const resolve = (relativePath: string): string =>
    path.join(root, ...relativePath.split('/').filter((segment) => segment.length > 0));

  return {
    async readFile(relativePath) {
      return fsp.readFile(resolve(relativePath));
    },
    async writeFile(relativePath, data) {
      const target = resolve(relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
    },
    async readdir(relativePath): Promise<ThemeFileStoreEntry[]> {
      const entries = await fsp.readdir(resolve(relativePath), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },
    async mkdirp(relativePath) {
      await fsp.mkdir(resolve(relativePath), { recursive: true });
    },
    async remove(relativePath, options?: ThemeFileStoreRemoveOptions) {
      await fsp.rm(resolve(relativePath), { recursive: options?.recursive ?? false, force: true });
    },
    async exists(relativePath) {
      try {
        await fsp.access(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async stat(relativePath): Promise<ThemeFileStoreStat> {
      const s = await fsp.stat(resolve(relativePath));
      return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
    },
    async rename(fromRelativePath, toRelativePath, options?: ThemeFileStoreRenameOptions) {
      await fsp.rename(resolve(fromRelativePath), resolve(toRelativePath));
      void options;
    },
    resolveHandle(relativePath) {
      return { path: resolve(relativePath).split(path.sep).join('/') };
    },
  };
}
