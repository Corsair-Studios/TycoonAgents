/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Per-user, per-machine secret store for endpoint URLs / API keys entered in
// the Routing screen (p13-t6). Decision (user, 2026-09-04): these values
// must be stored ONLY per user, outside any project, so git can never see
// them — never written into routing.json, opencode.json, or any other
// project-tracked file.
//
// Directory: the SAME per-user app-data dir the standalone already uses
// (standalone/src/appData.mjs's resolveAppDataDir()) + "/secrets", so both
// the VS Code extension and the standalone host share one location. This
// module has NO `vscode` import (compiles to out/src/core/localEnvStore.js
// and is safe to require() from the standalone's vscode-free process and
// from hooks/openai-compatible-mcp.cjs, same posture as routingHostOps.ts).
//
// resolveStoreDir() mirrors standalone/src/appData.mjs's
// resolveAppDataDir() byte-for-byte (same override var, same per-OS
// branches) rather than importing it, because appData.mjs is an ESM .mjs
// module outside this package's TS compile graph. Both are kept
// deliberately tiny and are covered by tests that assert they agree.
//
// PRECEDENCE: env.TYCOON_STANDALONE_DATA_DIR (if non-empty) always wins, on
// every platform — matches appData.mjs exactly so a test/dev override
// applies to both hosts identically.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const APP_DIR_NAME = "TycoonAgents";
const APP_DIR_NAME_XDG = "tycoonagents";

export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ResolveStoreDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}

/** Mirrors standalone/src/appData.mjs's resolveAppDataDir() exactly, then appends "secrets". */
export function resolveStoreDir(opts: ResolveStoreDirOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? os.homedir();

  let appDataDir: string;
  if (typeof env.TYCOON_STANDALONE_DATA_DIR === "string" && env.TYCOON_STANDALONE_DATA_DIR.trim() !== "") {
    appDataDir = path.resolve(env.TYCOON_STANDALONE_DATA_DIR.trim());
  } else if (platform === "win32") {
    const base =
      typeof env.APPDATA === "string" && env.APPDATA.trim() !== "" ? env.APPDATA : path.join(homedir, "AppData", "Roaming");
    appDataDir = path.join(base, APP_DIR_NAME);
  } else if (platform === "darwin") {
    appDataDir = path.join(homedir, "Library", "Application Support", APP_DIR_NAME);
  } else {
    const base =
      typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim() !== ""
        ? env.XDG_DATA_HOME
        : path.join(homedir, ".local", "share");
    appDataDir = path.join(base, APP_DIR_NAME_XDG);
  }

  return path.join(appDataDir, "secrets");
}

function isValidName(name: string): boolean {
  return typeof name === "string" && ENV_NAME_PATTERN.test(name);
}

export interface LocalEnvStoreOptions extends ResolveStoreDirOptions {}

/** Absolute path a value for `name` would live at — never checks existence. */
export function filePath(name: string, opts: LocalEnvStoreOptions = {}): string | undefined {
  if (!isValidName(name)) return undefined;
  return path.join(resolveStoreDir(opts), name);
}

/** Read a stored value. Returns undefined for an invalid name, a missing file, or any read error — never throws. */
export function getValue(name: string, opts: LocalEnvStoreOptions = {}): string | undefined {
  const p = filePath(name, opts);
  if (!p) return undefined;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** True iff a value is currently stored for `name`. Never throws. */
export function hasValue(name: string, opts: LocalEnvStoreOptions = {}): boolean {
  const p = filePath(name, opts);
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Write a value for `name`, creating the store dir (mode 0o700) and file
 * (mode 0o600) as needed. Throws only for an invalid `name` — a caller bug,
 * never a runtime/webview-payload condition (the caller must validate
 * against ENV_NAME_PATTERN before ever reaching here, same posture as
 * routingHostOps.ts's probeEnv).
 */
export function setValue(name: string, value: string, opts: LocalEnvStoreOptions = {}): void {
  if (!isValidName(name)) {
    throw new Error(`localEnvStore: invalid env var name: ${JSON.stringify(name)}`);
  }
  const dir = resolveStoreDir(opts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, name);
  fs.writeFileSync(p, value, { encoding: "utf8", mode: 0o600 });
  try {
    // mkdirSync's `mode` is ignored on Windows and can be masked by umask
    // elsewhere — chmod explicitly so POSIX hosts always end up 0o600/0o700
    // regardless of umask.
    fs.chmodSync(p, 0o600);
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort on platforms without POSIX permission bits (win32).
  }
}

/** Remove a stored value. A no-op (never throws) when nothing is stored or the name is invalid. */
export function clearValue(name: string, opts: LocalEnvStoreOptions = {}): void {
  const p = filePath(name, opts);
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    // Missing file (or any other removal error) is not a caller-visible failure.
  }
}
