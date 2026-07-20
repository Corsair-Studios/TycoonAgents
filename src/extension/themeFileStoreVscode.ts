/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from 'vscode';
import type {
  ThemeFileHandle,
  ThemeFileStore,
  ThemeFileStoreEntry,
  ThemeFileStoreRemoveOptions,
  ThemeFileStoreRenameOptions,
  ThemeFileStoreStat,
} from './themeFileStore';

/**
 * vscode.workspace.fs-backed ThemeFileStore, rooted at `root` (the
 * extension's `globalStorageUri`). Every method resolves its relative path
 * onto `root` via `vscode.Uri.joinPath` — identical to how
 * themeStorage.ts's existing Uri-returning path builders already resolve
 * theme paths — so on-disk locations are byte-identical to before this
 * refactor. Errors (e.g. vscode's `FileSystemError` with `code ===
 * 'FileNotFound'`) are intentionally left to propagate unchanged, since
 * themeService.ts's existing try/catch call sites depend on that exact shape.
 */
export function createVscodeThemeFileStore(root: vscode.Uri): ThemeFileStore {
  const resolve = (relativePath: string): vscode.Uri => {
    const segments = relativePath.split('/').filter((segment) => segment.length > 0);
    return segments.length ? vscode.Uri.joinPath(root, ...segments) : root;
  };

  return {
    async readFile(relativePath) {
      return vscode.workspace.fs.readFile(resolve(relativePath));
    },
    async writeFile(relativePath, data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await vscode.workspace.fs.writeFile(resolve(relativePath), bytes);
    },
    async readdir(relativePath): Promise<ThemeFileStoreEntry[]> {
      const entries = await vscode.workspace.fs.readDirectory(resolve(relativePath));
      return entries.map(([name, kind]) => ({
        name,
        isDirectory: kind === vscode.FileType.Directory,
        isFile: kind === vscode.FileType.File,
      }));
    },
    async mkdirp(relativePath) {
      await vscode.workspace.fs.createDirectory(resolve(relativePath));
    },
    async remove(relativePath, options?: ThemeFileStoreRemoveOptions) {
      await vscode.workspace.fs.delete(resolve(relativePath), {
        recursive: options?.recursive ?? false,
        useTrash: false,
      });
    },
    async exists(relativePath) {
      try {
        await vscode.workspace.fs.stat(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async stat(relativePath): Promise<ThemeFileStoreStat> {
      const stat = await vscode.workspace.fs.stat(resolve(relativePath));
      return {
        isDirectory: stat.type === vscode.FileType.Directory,
        isFile: stat.type === vscode.FileType.File,
        size: stat.size,
        mtimeMs: stat.mtime,
      };
    },
    async rename(fromRelativePath, toRelativePath, options?: ThemeFileStoreRenameOptions) {
      await vscode.workspace.fs.rename(resolve(fromRelativePath), resolve(toRelativePath), {
        overwrite: options?.overwrite ?? false,
      });
    },
    resolveHandle(relativePath): ThemeFileHandle {
      return resolve(relativePath);
    },
  };
}

// The configured-store registry (`configureThemeFileStore` /
// `resolveThemeFileStore` / `resetThemeFileStoreForTests`) now lives in
// themeFileStore.ts (vscode-free), so themeService.ts can import the
// resolver without pulling in 'vscode' at load time (project-plan task
// pC-t1). This module keeps ONLY the vscode adapter construction above;
// themeFileStore.ts's resolveThemeFileStore lazily `require`s this module by
// name when it needs to build the default fallback adapter.
