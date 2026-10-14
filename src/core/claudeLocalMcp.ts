/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Claude Code "local scope" MCP registration. Host-agnostic (no `vscode`).
//
// A server the user installs from the TycoonAgents panel is registered the way
// `claude mcp add` registers one by default: per user, under
// ~/.claude.json -> projects["<project path>"].mcpServers. The user's install
// click is the consent, and Claude Code loads local-scope servers without a
// separate approval prompt (the VS Code extension never shows that prompt for
// .mcp.json servers). Nothing here writes enabledMcpjsonServers,
// enableAllProjectMcpServers or any approval list, and a server is only ever
// registered because the caller was asked to install it.
//
// Write path (docs/PATH-DISCOVERY.md): prefer Claude Code's own CLI
// (`claude mcp add-json|remove --scope local`, cwd = project). The binary is
// discovered via TYCOON_CLAUDE_BIN, then PATH, then the install locations, then
// the binary bundled in the Claude Code editor extension. With no usable CLI
// (or if it fails) the user's ~/.claude.json is edited directly, touching ONLY
// projects[<key>].mcpServers[<our ids>], with an atomic write and one retry when
// the file changed underneath us.
//
// Bridge scripts run from the installed extension's hooks directory, never from
// a project copy, so a repository cannot change what runs. Environment values in
// a registered config are the catalog's non-secret ones; credentials are only
// ever referenced by variable NAME and resolved by the server at run time.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { systemExe } from "./safeExec";
import { MCP_BRIDGE_HOOK_FILES, resolveHookInterpreter } from "../host/vscode/hookInstall";
import { findOnPosixLadder } from "../providers/codex/posixBinDiscovery";

export interface LocalMcpOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Home directory override (tests). */
  homedir?: string;
  /** File-exists probe (tests). */
  isFile?: (p: string) => boolean;
  readdir?: (dir: string) => string[];
  /** Resolved `claude` binary, or null to force the file fallback (tests). Undefined = discover. */
  binary?: string | null;
  /** Spawn seam for the CLI (tests). May be sync or async. */
  run?: (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => CliRunResult | Promise<CliRunResult>;
  /** CLI timeout override in ms (tests). */
  timeoutMs?: number;
  /** Pause before re-reading ~/.claude.json to confirm a write survived a running Claude Code (default 300; tests 0). */
  verifyDelayMs?: number;
}

export interface CliRunResult {
  status: number | null;
  error?: unknown;
  stderr?: string;
}

export interface LocalMcpWriteResult {
  ok: boolean;
  /** How the change was made when ok. */
  via?: "cli" | "file" | "unchanged";
  error?: string;
}

/** Server ids we are willing to pass to the CLI / write: no leading dash, no separators. */
const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLI_TIMEOUT_MS = 20000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function platformOf(o: LocalMcpOptions): NodeJS.Platform {
  return o.platform ?? process.platform;
}

function homeOf(o: LocalMcpOptions): string {
  if (o.homedir !== undefined) return o.homedir;
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

/** Claude Code's global config file: $CLAUDE_CONFIG_DIR/.claude.json when set, else ~/.claude.json. */
export function claudeConfigFilePath(o: LocalMcpOptions = {}): string {
  const dir = (o.env ?? process.env).CLAUDE_CONFIG_DIR;
  if (typeof dir === "string" && dir.trim() !== "") return path.join(dir, ".claude.json");
  return path.join(homeOf(o), ".claude.json");
}

/**
 * The key Claude Code uses under `projects` for a folder: the absolute path with
 * forward slashes and no trailing slash (e.g. "D:/ACode/TycoonAgents" on Windows).
 */
export function claudeProjectKey(root: string): string {
  const key = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return key === "" ? "/" : key;
}

function keyCompare(key: string, platform: NodeJS.Platform): string {
  const k = claudeProjectKey(key);
  return platform === "win32" ? k.toLowerCase() : k;
}

/** Every existing `projects` key that names `root` (Windows drive-letter case differs between launchers). */
function matchingProjectKeys(projects: Record<string, unknown>, root: string, platform: NodeJS.Platform): string[] {
  const want = keyCompare(root, platform);
  return Object.keys(projects).filter((k) => keyCompare(k, platform) === want);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface ParsedClaudeJson {
  file: string;
  mtimeMs: number;
  size: number;
  projects: Record<string, unknown>;
}
let readCache: ParsedClaudeJson | undefined;

function loadProjects(o: LocalMcpOptions): Record<string, unknown> {
  const file = claudeConfigFilePath(o);
  try {
    const st = fs.statSync(file);
    if (readCache && readCache.file === file && readCache.mtimeMs === st.mtimeMs && readCache.size === st.size) return readCache.projects;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const projects = isPlainObject(parsed) && isPlainObject(parsed.projects) ? parsed.projects : {};
    // A file modified moments ago may be rewritten again within the same mtime tick at the same size; only cache settled files.
    readCache = Date.now() - st.mtimeMs > 2000 ? { file, mtimeMs: st.mtimeMs, size: st.size, projects } : undefined;
    return projects;
  } catch {
    return {};
  }
}

/** The local-scope servers registered for `root` (union over drive-letter-case variants). Never throws. */
export function readLocalMcpServers(root: string, o: LocalMcpOptions = {}): Record<string, unknown> {
  const projects = loadProjects(o);
  const out: Record<string, unknown> = {};
  for (const key of matchingProjectKeys(projects, root, platformOf(o))) {
    const proj = projects[key];
    if (isPlainObject(proj) && isPlainObject(proj.mcpServers)) Object.assign(out, proj.mcpServers);
  }
  return out;
}

export function hasLocalMcpServer(root: string, id: string, o: LocalMcpOptions = {}): boolean {
  return Object.prototype.hasOwnProperty.call(readLocalMcpServers(root, o), id);
}

/** A parsed .mcp.json-shaped object with the local-scope servers merged over its mcpServers (local wins). */
export function withLocalMcpServers(config: Record<string, unknown>, root: string, o: LocalMcpOptions = {}): Record<string, unknown> {
  const local = readLocalMcpServers(root, o);
  if (Object.keys(local).length === 0) return config;
  const base = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  return { ...config, mcpServers: { ...base, ...local } };
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

function versionParts(name: string): number[] {
  const m = /claude-code-(\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1].split(".").map((n) => parseInt(n, 10) || 0) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Find the `claude` CLI. Order: TYCOON_CLAUDE_BIN, PATH, the native installer
 * locations, the binary bundled in the Claude Code editor extension (newest
 * version). `tried` lists what was probed, for error messages. Windows accepts
 * only a real .exe (a .cmd shim cannot be launched without a shell).
 */
export function discoverClaudeBinary(o: LocalMcpOptions = {}): { bin?: string; tried: string[] } {
  const env = o.env ?? process.env;
  const platform = platformOf(o);
  const win = platform === "win32";
  const isFile = o.isFile ?? defaultIsFile;
  const join = win ? path.win32.join : path.posix.join;
  const exe = win ? "claude.exe" : "claude";
  const tried: string[] = [];

  const override = env.TYCOON_CLAUDE_BIN;
  if (typeof override === "string" && override.trim() !== "") {
    // "none" skips the CLI entirely and edits the config file directly (tests, locked-down machines).
    if (override.trim().toLowerCase() === "none") return { tried: ["TYCOON_CLAUDE_BIN=none"] };
    tried.push("TYCOON_CLAUDE_BIN");
    if (isFile(override.trim())) return { bin: override.trim(), tried };
  }

  const pathVar = env.PATH ?? env.Path ?? "";
  tried.push("PATH");
  for (const dir of pathVar.split(win ? ";" : ":").filter((d) => d !== "")) {
    const candidate = join(dir.replace(/^"|"$/g, ""), exe);
    if (isFile(candidate)) return { bin: candidate, tried };
  }

  const home = homeOf(o);
  if (win) {
    if (home) {
      const native = join(home, ".local", "bin", exe);
      tried.push(native);
      if (isFile(native)) return { bin: native, tried };
    }
  } else {
    const found = findOnPosixLadder("claude", { platform, env, isFile });
    tried.push(...found.tried);
    if (found.bin) return { bin: found.bin, tried };
  }

  if (home) {
    const readdir = o.readdir ?? ((d: string) => fs.readdirSync(d));
    const candidates: Array<{ bin: string; v: number[] }> = [];
    for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf", ".vscode-oss"]) {
      const extRoot = join(home, editor, "extensions");
      let names: string[] = [];
      try {
        names = readdir(extRoot).filter((n) => /^anthropic\.claude-code-\d/i.test(n));
      } catch {
        continue;
      }
      for (const n of names) candidates.push({ bin: join(extRoot, n, "resources", "native-binary", exe), v: versionParts(n) });
    }
    candidates.sort((a, b) => compareVersions(b.v, a.v));
    tried.push("Claude Code editor extension (resources/native-binary)");
    for (const c of candidates) if (isFile(c.bin)) return { bin: c.bin, tried };
  }
  return { tried };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Kill a child and its descendants (taskkill /T on Windows via the absolute System32 path; never resolved from the project). */
function killTree(pid: number | undefined, platform: NodeJS.Platform, child: { kill: (sig?: NodeJS.Signals) => boolean }): void {
  try {
    const taskkill = platform === "win32" && pid ? systemExe("taskkill.exe", { platform }) : null;
    if (taskkill) {
      const k = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("error", () => { /* best effort */ });
      return;
    }
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

function makeDefaultRun(timeoutMs: number): (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<CliRunResult> {
  return (bin, args, cwd, env) =>
    new Promise<CliRunResult>((resolve) => {
      let settled = false;
      let stderr = "";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        resolve({ status: null, error: e });
        return;
      }
      const done = (r: CliRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => { if (stderr.length < 4000) stderr += d; });
      const timer = setTimeout(() => {
        killTree(child.pid, process.platform, child);
        done({ status: null, error: new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`), stderr });
      }, timeoutMs);
      child.on("error", (e) => done({ status: null, error: e, stderr }));
      child.on("close", (code) => done({ status: code, stderr }));
    });
}

function binaryFor(o: LocalMcpOptions): string | undefined {
  if (o.binary === null) return undefined;
  if (typeof o.binary === "string") return o.binary;
  return discoverClaudeBinary(o).bin;
}

async function runCli(bin: string, args: string[], root: string, o: LocalMcpOptions): Promise<{ ok: boolean; detail: string }> {
  try {
    const run = o.run ?? makeDefaultRun(o.timeoutMs ?? CLI_TIMEOUT_MS);
    const r = await run(bin, args, root, o.env ?? process.env);
    if (!r.error && r.status === 0) return { ok: true, detail: "" };
    return { ok: false, detail: r.error ? String(r.error) : (r.stderr ?? "").trim().slice(0, 200) || `exit ${String(r.status)}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/**
 * True when the JSON text holds an integer literal outside the safe-integer range
 * (JSON.parse would silently round it, so a round trip would corrupt the file).
 * Strings are skipped; only bare number tokens are examined.
 */
function hasUnsafeIntegerLiteral(raw: string): boolean {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < raw.length && /[0-9.eE+-]/.test(raw[j])) j++;
      const tok = raw.slice(i, j);
      if (/^-?\d+$/.test(tok)) {
        const n = BigInt(tok);
        if (n > limit || n < -limit) return true;
      }
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Apply `edit` to projects[<key>].mcpServers in ~/.claude.json for every key that
 * names `root` (creating the canonical key when `create` and none exists). Writes
 * only when something changed: atomic temp-file rename, the file re-read right
 * before the write, one retry if it changed in between. Nothing else in the file
 * is modified, and an unparseable file is left untouched.
 */
function editClaudeJson(root: string, edit: (servers: Record<string, unknown>) => void, create: boolean, o: LocalMcpOptions): LocalMcpWriteResult {
  const configured = claudeConfigFilePath(o);
  // A symlinked .claude.json stays a symlink: read and replace the real target.
  let file = configured;
  try {
    file = fs.realpathSync(configured);
  } catch {
    /* absent (or unresolvable): fall through with the configured path */
  }
  const platform = platformOf(o);
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = "{}";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: `Could not read ${path.basename(file)}: ${String(e)}` };
      if (!create) return { ok: true, via: "unchanged" };
    }
    if (hasUnsafeIntegerLiteral(raw)) return { ok: false, error: `${path.basename(file)} holds a number too large to rewrite safely, so it was left untouched. Use the claude CLI (claude mcp add-json --scope local) instead.` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      return { ok: false, error: `${path.basename(file)} is not valid JSON; it was left untouched.` };
    }
    if (!isPlainObject(parsed)) return { ok: false, error: `${path.basename(file)} is not a JSON object; it was left untouched.` };
    if (parsed.projects !== undefined && !isPlainObject(parsed.projects)) return { ok: false, error: `${path.basename(file)} has an unexpected "projects" value; it was left untouched.` };
    const projects: Record<string, unknown> = isPlainObject(parsed.projects) ? parsed.projects : {};
    let keys = matchingProjectKeys(projects, root, platform);
    if (keys.length === 0) {
      if (!create) return { ok: true, via: "unchanged" };
      keys = [claudeProjectKey(root)];
    }
    let changed = false;
    for (const key of keys) {
      const proj: Record<string, unknown> = isPlainObject(projects[key]) ? (projects[key] as Record<string, unknown>) : {};
      if (proj.mcpServers !== undefined && !isPlainObject(proj.mcpServers)) return { ok: false, error: `projects entry for this folder has an unexpected "mcpServers" value; ${path.basename(file)} was left untouched.` };
      const servers: Record<string, unknown> = isPlainObject(proj.mcpServers) ? proj.mcpServers : {};
      const before = JSON.stringify(servers);
      edit(servers);
      if (JSON.stringify(servers) !== before || projects[key] === undefined) {
        proj.mcpServers = servers;
        projects[key] = proj;
        changed = true;
      }
    }
    if (!changed) return { ok: true, via: "unchanged" };
    parsed.projects = projects;
    const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? "  ";
    const crlf = raw.includes("\r\n");
    const text = JSON.stringify(parsed, null, indent);
    const out = (crlf ? text.replace(/\n/g, "\r\n") : text) + (/\n$/.test(raw) ? (crlf ? "\r\n" : "\n") : "");
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== undefined && hasUnsafeIntegerLiteral(current)) return { ok: false, error: `${path.basename(file)} holds a number too large to rewrite safely, so it was left untouched. Use the claude CLI (claude mcp add-json --scope local) instead.` };
    if (current !== undefined && current !== raw) continue; // changed underneath us: re-read and retry once
    const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, out, { mode: 0o600 });
      fs.renameSync(tmp, file);
      readCache = undefined;
      return { ok: true, via: "file" };
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* temp may not exist */
      }
      return { ok: false, error: `Could not write ${path.basename(file)}: ${String(e)}` };
    }
  }
  return { ok: false, error: `${path.basename(file)} kept changing while it was being updated; try again.` };
}

/** Pause before re-reading the settings file: verifyDelayMs, else TYCOON_MCP_VERIFY_DELAY_MS (ms), else 300. */
function verifyDelayOf(o: LocalMcpOptions): number {
  if (typeof o.verifyDelayMs === "number") return o.verifyDelayMs;
  const v = Number((o.env ?? process.env).TYCOON_MCP_VERIFY_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 5000) : 300;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Re-read ~/.claude.json after a short pause (a running Claude Code may rewrite the
 * file from its in-memory copy right after our edit) and report whether `id` is
 * registered; with `exact`, whether it equals that config.
 */
async function entryPersisted(root: string, id: string, o: LocalMcpOptions, exact?: unknown): Promise<boolean> {
  await sleep(verifyDelayOf(o));
  readCache = undefined;
  const cur = readLocalMcpServers(root, o)[id];
  if (cur === undefined) return false;
  return exact === undefined ? true : JSON.stringify(cur) === JSON.stringify(exact);
}

/**
 * Register `config` as local-scope server `id` for the project at `root`
 * (CLI first, file fallback). Idempotent: an identical entry is left alone.
 * Never leaves the entry removed: when the replacement cannot be confirmed, the
 * previous entry is restored (CLI, then file) and re-checked.
 */
export async function registerLocalMcpServer(root: string, id: string, config: unknown, o: LocalMcpOptions = {}): Promise<LocalMcpWriteResult> {
  if (!SERVER_ID_RE.test(id)) return { ok: false, error: `"${id}" is not a valid MCP server name.` };
  if (!isPlainObject(config)) return { ok: false, error: `${id} has no usable configuration.` };
  const current = readLocalMcpServers(root, o)[id];
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(config)) return { ok: true, via: "unchanged" };
  const bin = binaryFor(o);
  let cliFailure = "";
  let failure = "";
  try {
    if (bin) {
      if (current !== undefined) await runCli(bin, ["mcp", "remove", id, "--scope", "local"], root, o);
      const r = await runCli(bin, ["mcp", "add-json", "--scope", "local", id, JSON.stringify(config)], root, o);
      readCache = undefined;
      if (r.ok && hasLocalMcpServer(root, id, o)) {
        // Mirror onto any other drive-letter-case variant of this project's key.
        editClaudeJson(root, (s) => { s[id] = config; }, false, o);
        if (await entryPersisted(root, id, o)) return { ok: true, via: "cli" };
        cliFailure = "the new entry did not persist (Claude Code may have rewritten its settings file)";
      } else {
        cliFailure = r.detail;
      }
    }
    {
      const f = editClaudeJson(root, (s) => { s[id] = config; }, true, o);
      if (f.ok && (await entryPersisted(root, id, o, config))) return { ok: true, via: "file" };
      if (f.ok) {
        // Clobbered by a running Claude Code: write once more, then confirm again.
        const f2 = editClaudeJson(root, (s) => { s[id] = config; }, true, o);
        if (f2.ok && (await entryPersisted(root, id, o, config))) return { ok: true, via: "file" };
        failure = "the new entry did not persist after a retry";
      } else {
        failure = f.error ?? "write failed";
      }
    }
  } catch (e) {
    failure = `unexpected error: ${String(e)}`;
  }
  let error = cliFailure ? `${failure} (claude CLI: ${cliFailure})` : failure;
  if (current !== undefined) {
    // The previous entry may have been removed before the add failed: always put it back.
    const restored = await restorePreviousLocalMcp(root, id, current, bin, o);
    error += restored ? " The previous entry was restored." : " The previous entry could not be restored; re-enable it from the panel.";
  }
  return { ok: false, error };
}

/** Rollback for a failed replace: re-register `previous` (CLI, then file) unless the entry is already back; verified. */
async function restorePreviousLocalMcp(root: string, id: string, previous: unknown, bin: string | undefined, o: LocalMcpOptions): Promise<boolean> {
  readCache = undefined;
  if (hasLocalMcpServer(root, id, o) && (await entryPersisted(root, id, o))) return true;
  if (bin) {
    const r = await runCli(bin, ["mcp", "add-json", "--scope", "local", id, JSON.stringify(previous)], root, o);
    readCache = undefined;
    if (r.ok && (await entryPersisted(root, id, o))) return true;
  }
  for (let i = 0; i < 2; i++) {
    const f = editClaudeJson(root, (s) => { s[id] = previous; }, true, o);
    if (f.ok && (await entryPersisted(root, id, o, previous))) return true;
  }
  return false;
}

export interface SafeReplaceResult {
  ok: boolean;
  /** "replaced" (new entry confirmed), "unchanged" (nothing matched / already new), "kept" (write failed, old entry intact), "missing" (neither entry is present). */
  outcome: "replaced" | "unchanged" | "kept" | "missing";
  error?: string;
}

/**
 * Replace local-scope entry `id` (which must currently equal `expectedOld`) with `next`
 * by ONE atomic edit of ~/.claude.json: the entry is never removed first, and only
 * entries equal to `expectedOld` are touched. After a pause the file is re-read; if a
 * running Claude Code clobbered the edit it is repeated once. Reports "missing" when
 * the entry is absent after that, so the caller can warn the user.
 */
export async function replaceLocalMcpEntrySafely(root: string, id: string, expectedOld: unknown, next: unknown, o: LocalMcpOptions = {}): Promise<SafeReplaceResult> {
  if (!SERVER_ID_RE.test(id)) return { ok: false, outcome: "kept", error: `"${id}" is not a valid MCP server name.` };
  if (!isPlainObject(next)) return { ok: false, outcome: "kept", error: `${id} has no usable configuration.` };
  const oldJson = JSON.stringify(expectedOld);
  const nextJson = JSON.stringify(next);
  const first = readLocalMcpServers(root, o)[id];
  if (first !== undefined && JSON.stringify(first) === nextJson) return { ok: true, outcome: "unchanged" };
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = editClaudeJson(
      root,
      (s) => {
        const have = s[id];
        // First pass: only the exact entry we read. Retry: also re-add when it vanished.
        if (have !== undefined ? JSON.stringify(have) === oldJson : attempt > 0) s[id] = next;
      },
      attempt > 0,
      o,
    );
    if (!f.ok) lastError = f.error ?? "write failed";
    if (await entryPersisted(root, id, o, next)) return { ok: true, outcome: "replaced" };
    if (readLocalMcpServers(root, o)[id] !== undefined && JSON.stringify(readLocalMcpServers(root, o)[id]) !== oldJson) {
      // Something else (the user, another tool) changed it meanwhile: leave it alone.
      return { ok: true, outcome: "unchanged" };
    }
  }
  const now = readLocalMcpServers(root, o)[id];
  if (now === undefined) return { ok: false, outcome: "missing", error: lastError || `${id} disappeared from the Claude settings file while it was being updated.` };
  return { ok: false, outcome: "kept", error: lastError || `${id} could not be updated; the existing entry was left as is.` };
}

/** Remove local-scope server `id` for the project at `root` (CLI first, file fallback). Absent is success. */
export async function removeLocalMcpServer(root: string, id: string, o: LocalMcpOptions = {}): Promise<LocalMcpWriteResult> {
  if (!SERVER_ID_RE.test(id)) return { ok: false, error: `"${id}" is not a valid MCP server name.` };
  if (!hasLocalMcpServer(root, id, o)) return { ok: true, via: "unchanged" };
  const bin = binaryFor(o);
  if (bin) {
    await runCli(bin, ["mcp", "remove", id, "--scope", "local"], root, o);
    readCache = undefined;
  }
  // Also sweeps other drive-letter-case variants (and does the whole job without a CLI).
  const f = editClaudeJson(root, (s) => { delete s[id]; }, false, o);
  if (!f.ok) return f;
  return { ok: true, via: bin ? "cli" : "file" };
}

// ---------------------------------------------------------------------------
// Config localisation (run bridge scripts from the installed extension)
// ---------------------------------------------------------------------------

const PROJECT_HOOK_ARG_RE = /(?:^|\/)\.claude\/hooks\/([^/]+)$/;

/** Forward-slash path of an installed bridge script. */
export function installedBridgeScript(hooksDir: string, file: string): string {
  return path.join(hooksDir, file).replace(/\\/g, "/");
}

/**
 * Point a finalised catalog config's `.claude/hooks/<bridge>` args (relative, or
 * absolute into a project's own copy) at the INSTALLED hooks directory, and use
 * the discovered node interpreter. Configs that reference no bridge script
 * (npx servers, http servers) come back unchanged. Fails when a referenced
 * script is missing from the install.
 */
export function localizeMcpConfig(config: unknown, hooksDir: string, o: LocalMcpOptions = {}): { ok: true; config: unknown } | { ok: false; error: string } {
  if (!isPlainObject(config)) return { ok: true, config };
  const isFile = o.isFile ?? defaultIsFile;
  const known = new Set<string>(MCP_BRIDGE_HOOK_FILES);
  let replaced = false;
  let error: string | undefined;
  const args = Array.isArray(config.args)
    ? config.args.map((a: unknown) => {
        if (typeof a !== "string") return a;
        const m = PROJECT_HOOK_ARG_RE.exec(a.replace(/\\/g, "/"));
        if (!m || !known.has(m[1])) return a;
        const target = installedBridgeScript(hooksDir, m[1]);
        if (!isFile(target)) {
          error = `${m[1]} is missing from the TycoonAgents install (${path.basename(path.dirname(hooksDir))}).`;
          return a;
        }
        replaced = true;
        return target;
      })
    : config.args;
  if (error !== undefined) return { ok: false, error };
  if (!replaced) return { ok: true, config };
  const out: Record<string, unknown> = { ...config, args };
  if (out.command === "node") {
    const { interpreter } = resolveHookInterpreter({ platform: platformOf(o) });
    out.command = interpreter;
  }
  return { ok: true, config: out };
}

/** Bundled operations a host hands to the shared installers. */
export interface LocalMcpOps {
  /** The installed extension's (or standalone install's) hooks directory. */
  hooksDir: string;
  has(root: string, id: string): boolean;
  /** The registered config for `id`, or undefined (used to tell a product's own entry from an unrelated one of the same name). */
  get?(root: string, id: string): unknown;
  set(root: string, id: string, config: unknown): Promise<LocalMcpWriteResult>;
  remove(root: string, id: string): Promise<LocalMcpWriteResult>;
}

export function createLocalMcpOps(hooksDir: string, o: LocalMcpOptions = {}): LocalMcpOps {
  return {
    hooksDir,
    has: (root, id) => hasLocalMcpServer(root, id, o),
    get: (root, id) => readLocalMcpServers(root, o)[id],
    set: (root, id, config) => registerLocalMcpServer(root, id, config, o),
    remove: (root, id) => removeLocalMcpServer(root, id, o),
  };
}
