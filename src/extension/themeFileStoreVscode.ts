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
import { log } from '../host/vscode/log';

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
/**
 * Schemes whose `vscode.Uri` maps 1:1 onto a real local filesystem path via
 * `.fsPath` — `file:` always, and `vscode-userdata:` too on desktop (used
 * for globalStorage/extension-storage roots; only diverges from `file:` in
 * remote/sandboxed scenarios). For these, `createFsThemeFileStore` (Node
 * `fs/promises`) is used instead of `vscode.workspace.fs`, which proxies
 * every call through the extension host's RPC channel and can take upwards
 * of ten seconds for a multi-megabyte read (e.g. a theme's frames.json).
 */
const LOCAL_FS_SCHEMES = new Set(['file', 'vscode-userdata']);

export function createVscodeThemeFileStore(root: vscode.Uri): ThemeFileStore {
  if (LOCAL_FS_SCHEMES.has(root.scheme)) {
    log(
      `themeFileStoreVscode.createVscodeThemeFileStore: selected fs-backed store (scheme=${root.scheme} fsPath=${root.fsPath}) — local path, avoiding vscode.workspace.fs RPC overhead`,
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFsThemeFileStore } = require('./themeFileStoreFs') as typeof import('./themeFileStoreFs');
    const fsStore = createFsThemeFileStore(root.fsPath);
    return {
      ...fsStore,
      // Callers that need a displayable/webview-convertible location (e.g.
      // panel.ts's asWebviewUri for review images) still need a real
      // vscode.Uri, not the fs store's plain-object handle.
      resolveHandle(relativePath: string): ThemeFileHandle {
        const segments = relativePath.split('/').filter((segment) => segment.length > 0);
        return segments.length ? vscode.Uri.joinPath(root, ...segments) : root;
      },
    };
  }
  log(
    `themeFileStoreVscode.createVscodeThemeFileStore: selected vscode.workspace.fs-backed store (scheme=${root.scheme}) — non-local scheme, no faster path available`,
  );

  const resolve = (relativePath: string): vscode.Uri => {
    const segments = relativePath.split('/').filter((segment) => segment.length > 0);
    return segments.length ? vscode.Uri.joinPath(root, ...segments) : root;
  };

  return {
    async readFile(relativePath) {
      const uri = resolve(relativePath);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        log(`themeFileStoreVscode.readFile: uri=${uri.toString()} bytes=${bytes.byteLength}`);
        return bytes;
      } catch (error) {
        // FileNotFound is the EXPECTED outcome of every optional-lookup probe
        // (review.json / <id>_image_review.json on a theme's first load, a
        // modern manifest that only exists in the legacy flat layout, etc.) —
        // themeService.ts's call sites already catch and fall back on it.
        // Logging it at the same level as a real failure drowns the Output
        // channel in expected noise on every first load, so it's skipped here;
        // any other error still logs.
        if ((error as { code?: string } | undefined)?.code !== 'FileNotFound') {
          log(`themeFileStoreVscode.readFile: FAILED uri=${uri.toString()} error=${String(error)}`);
        }
        throw error;
      }
    },
    async writeFile(relativePath, data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await vscode.workspace.fs.writeFile(resolve(relativePath), bytes);
    },
    async readdir(relativePath): Promise<ThemeFileStoreEntry[]> {
      const uri = resolve(relativePath);
      try {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        log(
          `themeFileStoreVscode.readdir: uri=${uri.toString()} entries=[${entries.map(([name]) => name).join(', ')}]`,
        );
        return entries.map(([name, kind]) => ({
          name,
          isDirectory: kind === vscode.FileType.Directory,
          isFile: kind === vscode.FileType.File,
        }));
      } catch (error) {
        log(`themeFileStoreVscode.readdir: FAILED uri=${uri.toString()} error=${String(error)}`);
        throw error;
      }
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
