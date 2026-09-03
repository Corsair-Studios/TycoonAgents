// TycoonAgents standalone — fs-backed ThemeFileStore adapter (project-plan
// task pA-t4).
//
// Node fs/promises-backed implementation of the vscode-free ThemeFileStore
// contract (src/extension/themeFileStore.ts), rooted at an arbitrary
// `rootDir` — for the standalone host this is the appData themes directory
// (`themeDataDir` returned by server.mjs's startServer(), i.e.
// `<appData.dir>/themes/..` — see appData.mjs). This is the standalone-side
// counterpart to src/extension/themeFileStoreVscode.ts; themeStorage.ts /
// themeService.ts (both under src/extension/, UNCHANGED by this task) can be
// pointed at either adapter interchangeably because both implement the same
// `ThemeFileStore` interface exported by src/extension/themeFileStore.ts.
//
// Behavioral parity with themeFileStoreVscode.ts's createVscodeThemeFileStore
// (read that file's JSDoc for the authoritative contract):
//   - exists() swallows ANY stat error and returns false — never throws.
//   - readFile()/stat()/readdir()/remove()/rename() let a missing-path error
//     propagate, but its `.code` is normalized to the literal string
//     'FileNotFound' (matching vscode.FileSystemError's `code` for a missing
//     path) so themeService.ts's existing `err.code === 'FileNotFound'`
//     catch site (themeService.ts:392) behaves identically regardless of
//     which adapter is injected. Node's own error otherwise passes through
//     unchanged (message, stack, other properties all intact).
//   - writeFile() creates parent directories first — vscode.workspace.fs's
//     writeFile does this implicitly; Node's fs.writeFile does not.
//   - mkdirp() is a `recursive: true` mkdir: succeeds silently if the
//     directory already exists, creates every missing ancestor, matching
//     vscode.workspace.fs.createDirectory.
//   - rename() defaults `overwrite: false`. Node's fs.rename always
//     overwrites unconditionally (no `overwrite` option exists), so when
//     `overwrite` is false this checks the destination first and throws
//     (code 'FileExists') if it's already there — vscode.workspace.fs.rename
//     does the equivalent check natively when `overwrite: false`.
//
// Path safety: every relativePath is resolved onto `rootDir` and MUST stay
// inside it (mirrors appData.mjs's assertSafeFileName / server.mjs's
// serveMediaFile path-traversal guard) — a `../`-escaping relativePath
// throws ThemeFileStoreError rather than touching anything outside the
// store's root.
//
// Node built-ins only (node:fs/promises, node:fs, node:path, node:module) —
// standalone/package.json ships zero dependencies.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root -> out/src/extension/themeFileStore.js
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const THEME_FILE_STORE_JS = path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeFileStore.js');

const require = createRequire(import.meta.url);

let _themeFileStoreModule;
function themeFileStoreModule() {
  if (!_themeFileStoreModule) {
    if (!fsSync.existsSync(THEME_FILE_STORE_JS)) {
      throw new Error(
        `[tycoonagents-standalone] themeFileStoreFs: out/src/extension/themeFileStore.js not found at ` +
          `${THEME_FILE_STORE_JS}. The compiled \`out/\` directory is missing or stale — run \`npx tsc -p .\` ` +
          'from the repo root first, then restart the standalone server.',
      );
    }
    _themeFileStoreModule = require(THEME_FILE_STORE_JS);
  }
  return _themeFileStoreModule;
}

// ── Re-exported relative-path builders ──────────────────────────────────
// The SINGLE source of truth for the themes/<id>/ on-disk layout lives in
// src/extension/themeFileStore.ts (compiled to the .js required above); these
// thin wrappers let standalone code (and this module's own tests) build the
// exact same relative paths without re-hardcoding the layout a second time.
// Lazily required (first call only), same posture as sharedLogic.mjs, so
// importing this module never throws just because `out/` hasn't been built
// yet — only calling one of these (or createFsThemeFileStore, which does not
// need them) does.
export function joinThemePath(...segments) {
  return themeFileStoreModule().joinThemePath(...segments);
}
export function themesDirectoryPath() {
  return themeFileStoreModule().themesDirectoryPath();
}
export function themeDirectoryPath(themeId) {
  return themeFileStoreModule().themeDirectoryPath(themeId);
}
export function themeManifestPath(themeId) {
  return themeFileStoreModule().themeManifestPath(themeId);
}
export function themeFramesPath(themeId) {
  return themeFileStoreModule().themeFramesPath(themeId);
}
export function themePlanPath(themeId) {
  return themeFileStoreModule().themePlanPath(themeId);
}
export function themeReviewPath(themeId) {
  return themeFileStoreModule().themeReviewPath(themeId);
}
export function themeImagesDirectoryPath(themeId) {
  return themeFileStoreModule().themeImagesDirectoryPath(themeId);
}
export function themeRawImagesDirectoryPath(themeId) {
  return themeFileStoreModule().themeRawImagesDirectoryPath(themeId);
}
export function legacyManifestPath(themeId) {
  return themeFileStoreModule().legacyManifestPath(themeId);
}
export function legacyFramesPath(themeId) {
  return themeFileStoreModule().legacyFramesPath(themeId);
}

// ── Errors ───────────────────────────────────────────────────────────────

/** Thrown for a caller-actionable misuse of the store: a missing/empty
 * `rootDir`, or a `relativePath` that would escape it. Never thrown for an
 * ordinary missing file/dir — those propagate as a normal Node error with
 * `.code === 'FileNotFound'` (see normalizeMissingError below), matching the
 * vscode adapter's contract that themeService.ts's catch sites rely on. */
export class ThemeFileStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThemeFileStoreError';
  }
}

function resolveWithin(rootDir, relativePath) {
  const segments = String(relativePath ?? '')
    .split('/')
    .filter((segment) => segment.length > 0);
  const resolved = segments.length ? path.join(rootDir, ...segments) : rootDir;
  const rel = path.relative(rootDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ThemeFileStoreError(
      `TycoonAgents standalone: relative path escapes the theme store root: ${JSON.stringify(relativePath)}`,
    );
  }
  return resolved;
}

function normalizeMissingError(err) {
  if (err && err.code === 'ENOENT') {
    // Mirror vscode.FileSystemError's `code` for a missing path so existing
    // `err.code === 'FileNotFound'` catch sites in themeService.ts work
    // unchanged against this adapter.
    err.code = 'FileNotFound';
  }
  return err;
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Node fs-backed ThemeFileStore, rooted at `rootDir`. Pure construction —
 * never touches disk merely by being called; `rootDir` itself is created
 * lazily by whichever method first needs it to exist (writeFile/mkdirp/
 * rename create ancestors on demand, matching the vscode adapter's implicit
 * parent-creation behavior).
 *
 * @param {string} rootDir absolute directory this store is scoped to
 *   (typically the standalone's appData `themes/` parent dir — see
 *   server.mjs's `themeDataDir` / `startServer()`).
 * @returns {import('../../src/extension/themeFileStore').ThemeFileStore}
 */
export function createFsThemeFileStore(rootDir) {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new ThemeFileStoreError('TycoonAgents standalone: createFsThemeFileStore requires a non-empty "rootDir".');
  }
  const root = path.resolve(rootDir);

  return {
    async readFile(relativePath) {
      const filePath = resolveWithin(root, relativePath);
      try {
        return await fs.readFile(filePath);
      } catch (err) {
        throw normalizeMissingError(err);
      }
    },

    async writeFile(relativePath, data) {
      const filePath = resolveWithin(root, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data);
    },

    async readdir(relativePath) {
      const dirPath = resolveWithin(root, relativePath);
      let entries;
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch (err) {
        throw normalizeMissingError(err);
      }
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },

    async mkdirp(relativePath) {
      const dirPath = resolveWithin(root, relativePath);
      await fs.mkdir(dirPath, { recursive: true });
    },

    async remove(relativePath, options) {
      const targetPath = resolveWithin(root, relativePath);
      try {
        await fs.rm(targetPath, { recursive: options?.recursive ?? false, force: false });
      } catch (err) {
        throw normalizeMissingError(err);
      }
    },

    async exists(relativePath) {
      try {
        await fs.stat(resolveWithin(root, relativePath));
        return true;
      } catch {
        return false;
      }
    },

    async stat(relativePath) {
      const targetPath = resolveWithin(root, relativePath);
      let info;
      try {
        info = await fs.stat(targetPath);
      } catch (err) {
        throw normalizeMissingError(err);
      }
      return {
        isDirectory: info.isDirectory(),
        isFile: info.isFile(),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    },

    async rename(fromRelativePath, toRelativePath, options) {
      const fromPath = resolveWithin(root, fromRelativePath);
      const toPath = resolveWithin(root, toRelativePath);
      const overwrite = options?.overwrite ?? false;
      if (!overwrite && fsSync.existsSync(toPath)) {
        const err = new Error(
          `TycoonAgents standalone: rename destination already exists and overwrite is false: ${toRelativePath}`,
        );
        err.code = 'FileExists';
        throw err;
      }
      await fs.mkdir(path.dirname(toPath), { recursive: true });
      try {
        await fs.rename(fromPath, toPath);
      } catch (err) {
        throw normalizeMissingError(err);
      }
    },

    // Optional ThemeFileHandle producer (project-plan task pC-t1 step 2) —
    // mirrors themeFileStoreVscode.ts's createVscodeThemeFileStore.resolveHandle
    // exactly, but returns a plain `{ path }` object instead of a vscode.Uri
    // (there is no vscode.Uri on the standalone path). themeService.ts's own
    // resolveFileHandle() only ever reads `.path` off whatever this returns
    // (see themeFileStore.ts's ThemeFileHandle JSDoc — Uri-specific members
    // like `.fsPath`/`.with()` are consumed only by the vscode-aware caller,
    // panel.ts, which is never in the standalone's call path), so this
    // narrower shape is sufficient for every vscode-free consumer
    // (ensureThemeReviewImages/listReviewImageUris/persistRawAtlas in
    // themeService.ts). resolveWithin-guarded like every other method here —
    // a `../`-escaping relativePath throws rather than resolving outside root
    // (resolveWithin still computes AND guards the path; only its returned
    // separator is reformatted below).
    //
    // SEPARATOR CONTRACT: vscode.Uri.path is ALWAYS POSIX ('/'), on every OS.
    // themeService.ts's basename() helper does `handle.path.split('/').pop()`
    // — on Windows, path.join (inside resolveWithin) returns backslashes, so
    // without normalizing here that split would return the WHOLE path
    // instead of just the filename. Converting native separators to '/'
    // keeps this handle's `.path` semantically identical to the vscode
    // adapter's, on every platform. This is display/parsing-only: nothing in
    // standalone/ does a native fs call with handle.path (all real I/O goes
    // through this store's own readFile/writeFile/etc. with the ORIGINAL
    // relativePath, never through a resolved handle).
    resolveHandle(relativePath) {
      return { path: resolveWithin(root, relativePath).split(path.sep).join('/') };
    },
  };
}
