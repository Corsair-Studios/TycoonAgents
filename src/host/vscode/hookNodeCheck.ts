import * as fs from "fs";
import { execFile, spawnSync } from "child_process";

/** PATH a Dock-launched macOS GUI app (and so Claude Code's hook shell) inherits. */
export const MINIMAL_POSIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const NODE_CHECK_TIMEOUT_MS = 2000;
const FAILURE_TTL_MS = 30_000;

export interface NodeCheckResult {
  ok: boolean;
  interpreter: string;
}

export interface NodeCheckOptions {
  platform?: NodeJS.Platform;
  fileExists?: (p: string) => boolean;
  /** Runs `file args` with the given env; returns the exit status. Default: spawnSync with a short timeout. */
  run?: (file: string, args: string[], env: Record<string, string>) => { status: number | null; error?: unknown };
  /** Async runner used by checkHookInterpreterAsync. Default: execFile with a timeout + SIGKILL. */
  runAsync?: (file: string, args: string[], env: Record<string, string>) => Promise<{ status: number | null; error?: unknown }>;
  cache?: Map<string, { result: NodeCheckResult; at: number }>;
  now?: () => number;
}

const defaultCache = new Map<string, { result: NodeCheckResult; at: number }>();

function defaultRun(file: string, args: string[], env: Record<string, string>): { status: number | null; error?: unknown } {
  const r = spawnSync(file, args, { env, timeout: NODE_CHECK_TIMEOUT_MS, killSignal: "SIGKILL", stdio: "ignore" });
  return { status: r.status, error: r.error };
}

function defaultRunAsync(file: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; error?: unknown }> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { env, timeout: NODE_CHECK_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true }, (err) => {
        if (!err) return resolve({ status: 0 });
        const code = (err as { code?: unknown }).code;
        resolve({ status: typeof code === "number" ? code : null, error: err });
      });
    } catch (e) {
      resolve({ status: null, error: e });
    }
  });
}

/** Cached verdict for `interpreter` if still valid (success: session; failure: 30s), else undefined. Never spawns. */
export function peekHookInterpreterCheck(interpreter: string, opts: NodeCheckOptions = {}): NodeCheckResult | undefined {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return { ok: true, interpreter };
  const hit = (opts.cache ?? defaultCache).get(interpreter);
  const now = (opts.now ?? Date.now)();
  return hit && (hit.result.ok || now - hit.at < FAILURE_TTL_MS) ? hit.result : undefined;
}

/** Non-blocking twin of {@link checkHookInterpreter}: same semantics and cache, but spawns asynchronously. */
export async function checkHookInterpreterAsync(interpreter: string, opts: NodeCheckOptions = {}): Promise<NodeCheckResult> {
  const cached = peekHookInterpreterCheck(interpreter, opts);
  if (cached) return cached;
  const cache = opts.cache ?? defaultCache;
  const now = (opts.now ?? Date.now)();
  const env = { PATH: MINIMAL_POSIX_PATH };
  const run = opts.runAsync ?? defaultRunAsync;
  let ok = false;
  try {
    if (interpreter === "node") {
      const r = await run("/bin/sh", ["-c", "node --version"], env);
      ok = !r.error && r.status === 0;
    } else if (interpreter.startsWith("/") && (opts.fileExists ?? ((p: string) => fs.existsSync(p)))(interpreter)) {
      const r = await run(interpreter, ["--version"], env);
      ok = !r.error && r.status === 0;
    }
  } catch {
    ok = false;
  }
  const result = { ok, interpreter };
  cache.set(interpreter, { result, at: now });
  return result;
}

/**
 * Can the hook's interpreter actually start under the minimal GUI PATH? An
 * absolute path is run directly; bare `node` is resolved by `/bin/sh` with
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin, the same way Claude Code's hook shell
 * would. Windows always passes (bare `node` works there). Successes are cached
 * for the session, failures for 30s so a fresh Node install is picked up.
 */
export function checkHookInterpreter(interpreter: string, opts: NodeCheckOptions = {}): NodeCheckResult {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return { ok: true, interpreter };
  const cache = opts.cache ?? defaultCache;
  const now = (opts.now ?? Date.now)();
  const hit = cache.get(interpreter);
  if (hit && (hit.result.ok || now - hit.at < FAILURE_TTL_MS)) return hit.result;

  const env = { PATH: MINIMAL_POSIX_PATH };
  const run = opts.run ?? defaultRun;
  let ok = false;
  try {
    if (interpreter === "node") {
      const r = run("/bin/sh", ["-c", "node --version"], env);
      ok = !r.error && r.status === 0;
    } else if (interpreter.startsWith("/") && (opts.fileExists ?? ((p: string) => fs.existsSync(p)))(interpreter)) {
      const r = run(interpreter, ["--version"], env);
      ok = !r.error && r.status === 0;
    }
  } catch {
    ok = false;
  }
  const result = { ok, interpreter };
  cache.set(interpreter, { result, at: now });
  return result;
}
