// TycoonAgents standalone — app data directory for durable state (p3-t2).
//
// Replaces vscode.ExtensionContext.globalStorageUri for the standalone host.
// The extension persists durable host-side state (e.g. active-agent stack,
// build progress) under VS Code's globalStorage specifically because webview
// `setState` is CLEARED ON UPDATE — see project memory "State survives
// update". The standalone has no VS Code and thus no globalStorageUri, so it
// needs its own OS-appropriate, persistent-across-restarts directory with
// the same durability guarantee. This module is that equivalent.
//
// CHOSEN DEFAULT LOCATIONS (documented per task brief):
//   win32  -> %APPDATA%\TycoonAgents
//             (falls back to <homedir>\AppData\Roaming\TycoonAgents if
//             APPDATA is unset, which is what APPDATA resolves to anyway on
//             a normal Windows install — this is just the belt-and-braces
//             path when the env var itself is missing, e.g. some CI images)
//   darwin -> <homedir>/Library/Application Support/TycoonAgents
//             (the standard macOS per-user app support location)
//   other  -> $XDG_DATA_HOME/tycoonagents, else <homedir>/.local/share/tycoonagents
//             (XDG Base Directory spec; lowercase dir name is the XDG/Linux
//             convention, matching e.g. ~/.local/share/nvim, ~/.local/share/pnpm)
//
// ENV OVERRIDE (wins on every platform, used by tests and anyone who wants
// an isolated/portable data dir): TYCOON_STANDALONE_DATA_DIR.
//
// PURITY: resolveAppDataDir() reads NOTHING from process.* directly — env,
// platform, and homedir are all injected parameters, exactly like
// projectRoots.mjs's resolveProjectRoots(). This makes per-OS path selection
// trivially unit-testable without touching the real OS or environment (see
// test/appData.test.mjs). Only createAppData()'s writeJson() touches
// process.platform directly, and only for the same Windows
// rename-over-existing-file quirk that hooks/tycoon-claude-hook.cjs's
// atomicWriteSync already works around — it is I/O, not path resolution.
//
// SIDE-EFFECT-FREE AT IMPORT: nothing in this module creates a directory or
// touches disk merely by being imported or by calling createAppData() — the
// data dir is created lazily, only inside writeJson(), on first actual write.
//
// Node built-ins only — standalone/package.json ships zero dependencies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Thrown for a caller-actionable app-data misuse: an invalid/unsafe file
 * name (path-traversal attempt) or a missing `dir`. Never thrown for a
 * missing or corrupt STATE FILE — those return the caller's fallback
 * instead (see readJson) because a crashed/half-written state file must
 * never crash the app. */
export class AppDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppDataError';
  }
}

const APP_DIR_NAME = 'TycoonAgents';
const APP_DIR_NAME_XDG = 'tycoonagents';

/**
 * Pure per-OS app-data directory resolution. Reads only the injected
 * `env`/`platform`/`homedir` — never `process.env`/`process.platform`/
 * `os.homedir()` directly — so tests can exercise every branch (including
 * platforms other than the one actually running the test) deterministically.
 *
 * PRECEDENCE: `env.TYCOON_STANDALONE_DATA_DIR` (if non-empty) always wins,
 * on every platform — the same "explicit override beats ambient default"
 * shape as projectRoots.mjs's CLI-arg-beats-env-var rule.
 *
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env] pass `process.env`,
 *   or a fake object in tests. Consulted for `TYCOON_STANDALONE_DATA_DIR`
 *   (all platforms), `APPDATA` (win32 only), and `XDG_DATA_HOME` (non-win32,
 *   non-darwin only).
 * @param {string} [opts.platform] pass `process.platform`, or a literal
 *   'win32' | 'darwin' | 'linux' (or any other string, treated as the XDG
 *   'other' branch) in tests.
 * @param {string} [opts.homedir] pass `os.homedir()`, or a fake path in
 *   tests. Used as the base for every non-override branch.
 * @returns {string} absolute directory path (not guaranteed to exist yet).
 */
export function resolveAppDataDir({ env = {}, platform = process.platform, homedir = os.homedir() } = {}) {
  if (typeof env.TYCOON_STANDALONE_DATA_DIR === 'string' && env.TYCOON_STANDALONE_DATA_DIR.trim() !== '') {
    return path.resolve(env.TYCOON_STANDALONE_DATA_DIR.trim());
  }

  if (platform === 'win32') {
    const base =
      typeof env.APPDATA === 'string' && env.APPDATA.trim() !== ''
        ? env.APPDATA
        : path.join(homedir, 'AppData', 'Roaming');
    return path.join(base, APP_DIR_NAME);
  }

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', APP_DIR_NAME);
  }

  // linux and anything else: XDG Base Directory spec.
  const base =
    typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim() !== ''
      ? env.XDG_DATA_HOME
      : path.join(homedir, '.local', 'share');
  return path.join(base, APP_DIR_NAME_XDG);
}

// Rejects any name that could escape `dir` (path separators, absolute
// paths, or a literal '..' segment) — the same posture as server.mjs's
// serveMediaFile() path-traversal guard for /media/<path>. Thrown, not
// swallowed: an unsafe name is a caller bug, not a runtime state problem.
function assertSafeFileName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AppDataError(`TycoonAgents standalone: invalid app-data file name: ${JSON.stringify(name)}`);
  }
  const segments = name.split(/[\\/]/);
  if (segments.length > 1 || path.isAbsolute(name) || segments.includes('..') || segments.includes('.')) {
    throw new AppDataError(
      `TycoonAgents standalone: app-data file name must be a bare file name with no path separators or ` +
        `"..": ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Creates a small JSON read/write API scoped to `dir`. Pure construction —
 * no I/O happens until `readJson`/`writeJson` is actually called.
 *
 * @param {object} opts
 * @param {string} opts.dir absolute (or cwd-relative, resolved via
 *   `path.resolve`) directory to scope this instance to — typically the
 *   result of `resolveAppDataDir(...)`.
 * @param {(err: unknown, info: { op: 'read' | 'parse' | 'write', name: string, filePath: string }) => void} [opts.onError]
 *   optional diagnostic hook, called (never thrown) when a read/parse/write
 *   fails for a reason other than "file doesn't exist yet". Defaults to a
 *   no-op so a corrupt state file never crashes the caller.
 * @returns {{
 *   dir: string,
 *   readJson: (name: string, fallback?: unknown) => unknown,
 *   writeJson: (name: string, value: unknown) => void,
 * }}
 * @throws {AppDataError} if `dir` is missing/empty, or if `readJson`/
 *   `writeJson` is called with an unsafe `name`.
 */
export function createAppData({ dir, onError } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new AppDataError('TycoonAgents standalone: createAppData requires a non-empty "dir".');
  }
  const resolvedDir = path.resolve(dir);
  const notify = typeof onError === 'function' ? onError : () => {};

  /**
   * Reads `<dir>/<name>` as JSON. Returns `fallback` — never throws — when
   * the file doesn't exist yet, or exists but is corrupt/unparseable JSON.
   * A missing file is silent (the normal "nothing written yet" case); a
   * corrupt file calls `onError` first so callers can log it, then still
   * returns `fallback` rather than crashing the app.
   */
  function readJson(name, fallback = null) {
    assertSafeFileName(name);
    const filePath = path.join(resolvedDir, name);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        notify(err, { op: 'read', name, filePath });
      }
      return fallback;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      notify(err, { op: 'parse', name, filePath });
      return fallback;
    }
  }

  /**
   * Writes `value` to `<dir>/<name>` as pretty-printed JSON, atomically
   * (write to a temp file, then rename over the target) so a crash mid-write
   * can never leave a half-written/corrupt file behind — the same pattern as
   * `atomicWriteSync` in hooks/tycoon-claude-hook.cjs. Creates `dir`
   * recursively on demand; never throws merely because `dir` didn't exist
   * yet.
   */
  function writeJson(name, value) {
    assertSafeFileName(name);
    fs.mkdirSync(resolvedDir, { recursive: true });
    const filePath = path.join(resolvedDir, name);
    const tmp = path.join(resolvedDir, `.${name}.${process.pid}.${Date.now()}.tmp`);
    const data = JSON.stringify(value, null, 2);

    fs.writeFileSync(tmp, data, 'utf8');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (process.platform === 'win32' && fs.existsSync(filePath)) {
          // Windows can refuse to rename over an existing file; clear it first.
          fs.unlinkSync(filePath);
        }
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        if (attempt === 2) {
          notify(err, { op: 'write', name, filePath });
          // Last resort: write directly (no longer atomic, but never silently
          // drop the write). Mirrors atomicWriteSync's own final fallback.
          fs.writeFileSync(filePath, data, 'utf8');
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* best-effort cleanup */
          }
          return;
        }
        // Brief spin before retry — same shape as atomicWriteSync's retry loop.
        const end = Date.now() + 25;
        while (Date.now() < end) {
          /* busy wait */
        }
      }
    }
  }

  return { dir: resolvedDir, readJson, writeJson };
}

/**
 * Convenience one-liner combining resolveAppDataDir() + createAppData()
 * against the REAL environment (reads process.env/process.platform/
 * os.homedir() by default) — the intended integration point for a future
 * caller (e.g. server.mjs) that wants the standalone's default persistent
 * state store without wiring the two calls together itself. Not used by any
 * existing file yet; provided so this module is a complete, drop-in
 * replacement for the extension's globalStorage pattern.
 *
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.platform]
 * @param {string} [opts.homedir]
 * @param {(err: unknown, info: object) => void} [opts.onError]
 */
export function createDefaultAppData({ env = process.env, platform = process.platform, homedir = os.homedir(), onError } = {}) {
  const dir = resolveAppDataDir({ env, platform, homedir });
  return createAppData({ dir, onError });
}
