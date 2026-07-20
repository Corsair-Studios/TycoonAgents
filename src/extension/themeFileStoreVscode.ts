/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from 'vscode';
import type {
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
  };
}

let configuredStore: ThemeFileStore | undefined;

/**
 * Inject the ThemeFileStore that themeStorage.ts/themeService.ts should use
 * for ALL theme file I/O from now on. The extension host (panel.ts) calls
 * this exactly once, right after it resolves its `globalStorageUri`,
 * constructing the store via `createVscodeThemeFileStore` above.
 *
 * Until this is called (e.g. in the existing unit tests, which exercise
 * themeService.ts functions directly against a temp directory + a stubbed
 * 'vscode' module), `resolveThemeFileStore` transparently falls back to
 * constructing a fresh vscode-backed adapter per call from whatever
 * `globalStorageUri` that call was given — preserving prior behavior with
 * zero call-site changes.
 */
export function configureThemeFileStore(store: ThemeFileStore): void {
  configuredStore = store;
}

/** Test-only escape hatch: clear an explicitly configured store. */
export function resetThemeFileStoreForTests(): void {
  configuredStore = undefined;
}

/**
 * Resolve the ThemeFileStore themeStorage.ts/themeService.ts should use for
 * a call carrying `globalStorageUri`. Prefers the store injected via
 * `configureThemeFileStore`; falls back to a fresh vscode-backed adapter
 * rooted at `globalStorageUri` otherwise.
 */
export function resolveThemeFileStore(globalStorageUri: vscode.Uri): ThemeFileStore {
  return configuredStore ?? createVscodeThemeFileStore(globalStorageUri);
}
