/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Stable, version-independent launcher directory for the bridge scripts that
// Claude local-scope MCP entries (and the Codex dispatcher entry) run.
//
// Why: entries used to point into the VERSIONED extension folder
// (.../tycoonagents.tycoonagents-0.0.743/hooks/...), so every update forced a
// rewrite of ~/.claude.json while Claude Code was running, and a failed rewrite
// lost the user's server. Entries now point at one per-user directory that no
// update moves.
//
// Location: <home>/.tycoonagents/bin, home = an injected homedir (tests) else
// os.homedir(). There is deliberately NO environment-variable override: anything
// the process environment can change, a repository can change too
// (.claude/settings*.json env), and this folder decides which scripts are trusted.
// Failure is explicit: the error lists the home candidates tried.
//
// Copying is a separate act from trusting. Only the extension's activation (or the
// standalone's startup), using the extension's own install folder, copies files; and
// only when that folder's package.json is TycoonAgents'. Unless a target home is
// injected, installStableBridges does nothing under a test runner that has not
// sandboxed the home folder (TYCOON_TEST_HOME_SANDBOX=1, set by the repo's runners),
// and TYCOON_SKIP_BRIDGE_INSTALL=1 disables copying. Both can only DISABLE copying.
//
// Contents: the whole MCP_BRIDGE_HOOK_FILES closure plus the CommonJS marker.
// Writes are atomic (random temp file + rename), content-hash verified, and skipped
// when the bytes already match. A version stamp (prerelease aware) stops an older
// editor overwriting a newer one's files; on an equal version only MISSING files are
// filled in, so two editors on the same version never ping-pong.
// ---------------------------------------------------------------------------

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MCP_BRIDGE_HOOK_FILES } from "../host/vscode/hookInstall";

export const STABLE_STAMP_FILE = "tycoon-bridge-stamp.json";

export interface StableDirOptions {
  platform?: NodeJS.Platform;
  /** Home directory override (tests). */
  homedir?: string;
}

export interface StableDirResolution {
  dir?: string;
  tried: string[];
  error?: string;
}

/** The trusted stable folder (no I/O, no environment variables). */
export function resolveStableBridgeDir(o: StableDirOptions = {}): StableDirResolution {
  const tried: string[] = [];
  let home = o.homedir;
  if (home === undefined) {
    tried.push("os.homedir()");
    try { home = os.homedir(); } catch { home = undefined; }
  } else {
    tried.push("homedir option");
  }
  if (typeof home === "string" && home.trim() !== "") {
    return { dir: path.join(home.trim(), ".tycoonagents", "bin").replace(/\\/g, "/"), tried };
  }
  return { tried, error: `Could not find a home folder for the TycoonAgents launcher directory (tried ${tried.join(", ")}).` };
}

function norm(p: string, platform: NodeJS.Platform): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? n.toLowerCase() : n;
}

/** Lexical check: `scriptPath` is a direct child of the stable directory. */
export function isInStableBridgeDir(scriptPath: string, o: StableDirOptions = {}): boolean {
  const r = resolveStableBridgeDir(o);
  if (!r.dir) return false;
  const platform = o.platform ?? process.platform;
  const s = scriptPath.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  if (i <= 0) return false;
  return norm(s.slice(0, i), platform) === norm(r.dir, platform);
}

/**
 * Strict check for a trust decision: lexically inside the stable directory, the
 * directory itself is not a link, and the file is a regular file (no symlink or
 * junction) whose real location is that directory's real location.
 */
export function isTrustedStableScript(scriptPath: string, o: StableDirOptions = {}): boolean {
  if (!isInStableBridgeDir(scriptPath, o)) return false;
  const r = resolveStableBridgeDir(o);
  const platform = o.platform ?? process.platform;
  try {
    if (fs.lstatSync(r.dir as string).isSymbolicLink()) return false;
    const st = fs.lstatSync(scriptPath);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    const dirReal = fs.realpathSync(r.dir as string);
    const fileReal = fs.realpathSync(scriptPath);
    return norm(fileReal, platform) === norm(path.join(dirReal, path.basename(scriptPath)), platform);
  } catch {
    return false;
  }
}

interface ParsedVersion {
  nums: number[];
  pre: string[];
}

function parseVersion(v: string): ParsedVersion {
  const m = /^\s*v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  return m ? { nums: m[1].split(".").map(Number), pre: m[2] ? m[2].split(".") : [] } : { nums: [], pre: [] };
}

/** Negative when a < b. A release outranks its own prerelease (1.0.0 > 1.0.0-beta.1). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Write `data` to `dest` atomically and verify the bytes by hash. Throws on failure. */
function writeAtomicVerified(dest: string, data: Buffer): void {
  const tmp = `${dest}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o644, flag: "wx" });
    try {
      fs.renameSync(tmp, dest);
    } catch {
      // Windows can refuse a rename over a file a process has open; one retry after a beat.
      const until = Date.now() + 50;
      while (Date.now() < until) { /* brief spin */ }
      fs.renameSync(tmp, dest);
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
    throw e;
  }
  if (sha256(fs.readFileSync(dest)) !== sha256(data)) throw new Error(`${path.basename(dest)} did not match after writing`);
}

export type StableInstallStatus = "installed" | "current" | "newer" | "skipped" | "error";

export interface StableInstallResult {
  status: StableInstallStatus;
  /** The stable directory (set unless it could not be resolved). */
  dir?: string;
  written: string[];
  errors: string[];
}

export interface StableInstallOptions extends StableDirOptions {
  /** Required for a copy into the REAL home: the extension's activation / the standalone's startup. */
  fromActivation?: boolean;
  /** Override the version stamp (tests); default is the source package.json version. */
  version?: string;
}

/** The source must be the TycoonAgents install: <src>/../package.json is ours. Returns its version. */
function verifiedSourceVersion(srcHooksDir: string): { version?: string; error?: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(srcHooksDir, "..", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "tycoonagents") return { error: `${srcHooksDir} is not a TycoonAgents install folder.` };
    if (typeof pkg.version !== "string") return { error: `No version in ${path.join(srcHooksDir, "..", "package.json")}.` };
    return { version: pkg.version };
  } catch {
    return { error: `Could not read ${path.join(srcHooksDir, "..", "package.json")}.` };
  }
}

function readStamp(dir: string): string | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, STABLE_STAMP_FILE), "utf8")) as { version?: unknown };
    return typeof s.version === "string" ? s.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy the bridge closure from the installed extension's hooks folder (callers pass
 * only their own install path: context.extensionPath / the standalone root) into the
 * stable directory. Never downgrades (stamp newer -> "newer"); on an EQUAL version only
 * missing files are filled in. Does nothing ("skipped") unless a target home was
 * injected or `fromActivation` is set, and never under an unsandboxed test runner.
 * Never throws.
 */
export function installStableBridges(srcHooksDir: string, o: StableInstallOptions = {}): StableInstallResult {
  const res: StableInstallResult = { status: "current", written: [], errors: [] };
  if (o.homedir === undefined) {
    const blocked = process.env.TYCOON_SKIP_BRIDGE_INSTALL === "1" || (!!process.env.NODE_TEST_CONTEXT && process.env.TYCOON_TEST_HOME_SANDBOX !== "1");
    if (!o.fromActivation || blocked) {
      res.status = "skipped";
      return res;
    }
  }
  const r = resolveStableBridgeDir(o);
  if (!r.dir) {
    res.status = "error";
    res.errors.push(r.error ?? "Could not resolve the TycoonAgents launcher directory.");
    return res;
  }
  const dir = r.dir;
  res.dir = dir;
  const src = verifiedSourceVersion(srcHooksDir);
  if (!src.version) {
    res.status = "error";
    res.errors.push(src.error ?? "Unverified source.");
    return res;
  }
  const version = o.version ?? src.version;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("the launcher folder is a link");
  } catch (e) {
    res.status = "error";
    res.errors.push(`Could not use ${dir}: ${String(e)}`);
    return res;
  }
  const stamped = readStamp(dir);
  const cmp = stamped === undefined ? -1 : compareVersions(stamped, version);
  if (cmp > 0) {
    res.status = "newer";
    return res;
  }
  const fillOnly = cmp === 0;
  let sawSource = false;
  for (const file of MCP_BRIDGE_HOOK_FILES) {
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(srcHooksDir, file));
    } catch {
      continue; // e.g. localEnvStore.js when not built
    }
    sawSource = true;
    const dest = path.join(dir, file);
    try {
      let same = false;
      let exists = false;
      try {
        const cur = fs.lstatSync(dest);
        exists = true;
        same = cur.isFile() && !cur.isSymbolicLink() && sha256(fs.readFileSync(dest)) === sha256(data);
        if (cur.isSymbolicLink()) {
          fs.unlinkSync(dest);
          exists = false;
        }
      } catch {
        same = false;
      }
      if (same || (fillOnly && exists)) continue;
      writeAtomicVerified(dest, data);
      res.written.push(file);
    } catch (e) {
      res.errors.push(`${file}: ${String(e)}`);
    }
  }
  if (!sawSource) res.errors.push(`No bridge scripts found in ${srcHooksDir}.`);
  try {
    const marker = path.join(dir, "package.json");
    if (!fs.existsSync(marker)) {
      writeAtomicVerified(marker, Buffer.from(JSON.stringify({ type: "commonjs" }, null, 2) + "\n", "utf8"));
      res.written.push("package.json");
    }
  } catch (e) {
    res.errors.push(`package.json: ${String(e)}`);
  }
  if (res.errors.length === 0 && stamped !== version) {
    try {
      writeAtomicVerified(path.join(dir, STABLE_STAMP_FILE), Buffer.from(JSON.stringify({ version }, null, 2) + "\n", "utf8"));
    } catch (e) {
      res.errors.push(`${STABLE_STAMP_FILE}: ${String(e)}`);
    }
  }
  res.status = res.errors.length > 0 ? "error" : res.written.length > 0 ? "installed" : "current";
  return res;
}
