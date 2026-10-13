/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Explicit, user-clicked "Approve TycoonAgents servers for this project".
// Host-agnostic (shared by src/host/vscode/panel.ts and standalone/src/server.mjs).
//
// Auto-approval stays forbidden: nothing here runs unless the user clicked and
// confirmed. The only file ever written is <root>/.claude/settings.local.json
// (never settings.json, never user-level settings, never
// enableAllProjectMcpServers). The set of servers is derived from what
// TycoonAgents itself installs - the bridge pack agents' MCP servers plus
// catalog entries vended by TycoonAgents (the dispatcher) - never a hand list,
// and third-party catalog servers are never included. The host re-validates
// every request against that set; the webview's list is not trusted.
// ---------------------------------------------------------------------------

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bridgeServerFor, BRIDGE_PACK_ID } from "./bridgeSetup";
import { GEMINI_BACKEND_ENV } from "./hostBridgeSettings";
import type { Backend } from "./agentBackend";
import { resolveConfigForPlatform, withDispatcherProjectDir } from "../host/vscode/mcpCatalog";
import { bridgeFilesForConfig, copyMcpBridgeHooks } from "../host/vscode/hookInstall";
import { withHookWrite } from "./hookWriteGate";

/** Catalog vendor string that marks TycoonAgents' own (non-third-party) MCP entries. */
const OWN_VENDOR = "TycoonAgents";

/** Our server id -> the MCP catalog entry TycoonAgents installs for it. */
export type TycoonServerDefs = Record<string, { id: string; config?: unknown; platforms?: unknown }>;

function bridgeAndOwnIds(packsCatalog: unknown, mcpCatalog: unknown): string[] {
  const ids = new Set<string>();
  if (Array.isArray(packsCatalog)) {
    for (const pack of packsCatalog) {
      if (!pack || typeof pack !== "object") continue;
      const p = pack as { id?: unknown; picker?: unknown; agents?: unknown };
      if (p.id !== BRIDGE_PACK_ID && p.picker !== "bridges") continue;
      if (!Array.isArray(p.agents)) continue;
      for (const a of p.agents) {
        const backend = a && typeof a === "object" ? (a as { backend?: unknown }).backend : undefined;
        if (!backend || typeof backend !== "object") continue;
        const server = bridgeServerFor(backend as Backend);
        if (server) ids.add(server);
      }
    }
  }
  if (Array.isArray(mcpCatalog)) {
    for (const e of mcpCatalog) {
      if (e && typeof e === "object" && (e as { vendor?: unknown }).vendor === OWN_VENDOR && typeof (e as { id?: unknown }).id === "string") {
        ids.add((e as { id: string }).id);
      }
    }
  }
  return [...ids].sort();
}

/** Servers TycoonAgents installs (bridge pack agents + TycoonAgents-vended catalog entries) with their catalog entries. */
export function tycoonServerDefs(packsCatalog: unknown, mcpCatalog: unknown): TycoonServerDefs {
  const out: TycoonServerDefs = {};
  if (!Array.isArray(mcpCatalog)) return out;
  for (const id of bridgeAndOwnIds(packsCatalog, mcpCatalog)) {
    const entry = mcpCatalog.find((e) => e && typeof e === "object" && (e as { id?: unknown }).id === id);
    if (entry) out[id] = entry as TycoonServerDefs[string];
  }
  return out;
}

/** Convenience: derive the defs from <mediaDir>/packs/catalog.json and <mediaDir>/mcp/catalog.json. */
export function tycoonServerDefsFromMedia(mediaDir: string): TycoonServerDefs {
  const read = (rel: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(path.join(mediaDir, rel), "utf8"));
    } catch {
      return [];
    }
  };
  return tycoonServerDefs(read(path.join("packs", "catalog.json")), read(path.join("mcp", "catalog.json")));
}

function normToken(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let t = v.trim();
  while (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
  return t.split("\\").join("/").replace(/^\.\//, "");
}

function normPathKey(v: unknown): string | null {
  const t = normToken(v);
  return t === null ? null : t.replace(/\/+$/, "").toLowerCase();
}

/**
 * True only when `entry` (from the project's .mcp.json) is exactly what
 * TycoonAgents itself would install for `id` in `root`: bare `node` launcher,
 * the catalog's args (our hook script, relative to the project or as an
 * absolute path inside <root>/.claude/hooks; separators and quoting
 * normalised), and an env limited to the catalog's values plus
 * TYCOON_PROJECT_DIR=<root>. Any other key, command or env var is foreign.
 */
export function mcpEntryMatchesOurs(
  root: string,
  id: string,
  entry: unknown,
  def: TycoonServerDefs[string] | undefined,
  platform: string = process.platform,
): boolean {
  if (!def || entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const resolved = resolveConfigForPlatform(def as never, platform);
  if (!resolved.ok) return false;
  const expected = withDispatcherProjectDir(id, resolved.config, root) as Record<string, unknown> | null;
  if (!expected || typeof expected !== "object" || JSON.stringify(expected).includes("${")) return false;
  const got = entry as Record<string, unknown>;
  for (const k of Object.keys(got)) if (k !== "command" && k !== "args" && k !== "env" && k !== "type") return false;
  if (got["type"] !== undefined && got["type"] !== "stdio") return false;
  const cmd = normPathKey(got["command"]);
  if (cmd !== "node" && cmd !== "node.exe") return false;
  const expArgs = Array.isArray(expected["args"]) ? (expected["args"] as unknown[]) : [];
  const gotArgs = got["args"];
  if (!Array.isArray(gotArgs) || gotArgs.length !== expArgs.length) return false;
  const rootNorm = normToken(root) ?? "";
  for (let i = 0; i < expArgs.length; i++) {
    const want = normToken(expArgs[i]);
    const have = normToken(gotArgs[i]);
    if (want === null || have === null) return false;
    if (have === want) continue;
    // Our hook scripts may also be written as an absolute path into the project's own copy.
    if (want.startsWith(".claude/hooks/") && have.toLowerCase() === `${rootNorm.replace(/\/+$/, "")}/${want}`.toLowerCase()) continue;
    return false;
  }
  const expEnv = expected["env"] && typeof expected["env"] === "object" ? (expected["env"] as Record<string, unknown>) : {};
  const gotEnv = got["env"] === undefined ? {} : got["env"];
  if (gotEnv === null || typeof gotEnv !== "object" || Array.isArray(gotEnv)) return false;
  const ge = gotEnv as Record<string, unknown>;
  for (const k of Object.keys(ge)) {
    if (Object.prototype.hasOwnProperty.call(expEnv, k)) continue;
    // The panel's Gemini backend setting writes this one value into the gemini server's env.
    if (id === "gemini" && k === GEMINI_BACKEND_ENV && (ge[k] === "agy" || ge[k] === "gemini")) continue;
    return false;
  }
  for (const [k, v] of Object.entries(expEnv)) {
    if (k === "TYCOON_PROJECT_DIR") {
      // The installer writes it; a hand-made entry may omit it, but if present it must be this project.
      if (ge[k] !== undefined && normPathKey(ge[k]) !== normPathKey(v)) return false;
    } else if (ge[k] !== v) return false;
  }
  return true;
}

export interface McpApprovalState {
  /** Our servers present in the project's .mcp.json whose command is exactly what TycoonAgents installs. */
  present: string[];
  /** Our ids present in .mcp.json with a different command: never approved ("not installed by TycoonAgents"). */
  foreign: string[];
  /** Our ids whose command matches but whose script or require closure differs from the installed TycoonAgents copy. */
  modified: string[];
  /** Set when a node launcher sits in the project folder (PATH hijack): nothing is approvable. */
  pathHijack: string | null;
  /** Sibling bridge entries that are foreign/modified and therefore block approving the dispatcher ("tycoon"). */
  dispatcherBlockedBy: string[];
  /** True when .claude/out exists in the project (a require fallback path): every server counts as modified. */
  outFallback: boolean;
  /** Approved ids (enabled or mcp__ allow rule) whose entry or scripts have changed since: offer one-click revocation. */
  changedApproved: string[];
  /** Present, not enabled, not disabled: the approve action covers these. */
  pending: string[];
  /** Present and disabled by the user in Claude Code; never re-approved. */
  rejected: string[];
  /** Our ids this action can remove (local enabledMcpjsonServers entries or mcp__<id> allow rules). */
  removable: string[];
  /** True when .claude/settings.local.json exists but cannot be merged safely. */
  localUnreadable: boolean;
  /** True when .claude or settings.local.json is a symlink/junction: nothing is written. */
  unsafeSettingsPath: boolean;
  /** True when ~/.claude.json or ~/.claude/settings.json exists but cannot be read: fail closed. */
  homeUnreadable: boolean;
}

/** Seams shared by every entry point; hosts supply resolveSrc, tests supply homeDir/platform. */
export interface ApprovalEnv {
  /** Locates the shipped copy of a hook file in the INSTALLED extension (the installer's own source). */
  resolveSrc: (fileName: string) => string | undefined;
  /** Same file in OTHER real installed TycoonAgents extensions on disk (outside the project); a copy identical to any of them is ours. */
  altSrcs?: (fileName: string) => string[];
  /** Home directory holding ~/.claude.json (defaults to os.homedir()). */
  homeDir?: string;
  /** process.platform override. */
  platform?: string;
}

interface JsonRead {
  exists: boolean;
  data: Record<string, unknown>;
  unreadable: boolean;
}

function readJsonObject(file: string): JsonRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, data: {}, unreadable: false };
    return { exists: true, data: {}, unreadable: true };
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { exists: true, data: parsed as Record<string, unknown>, unreadable: false };
    }
  } catch {
    /* fall through */
  }
  return { exists: true, data: {}, unreadable: true };
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const IS_WIN = (platform: string): boolean => platform === "win32";

function sameFsPath(a: string, b: string, platform: string): boolean {
  const n = (x: string): string => {
    const t = x.split("\\").join("/").replace(/\/+$/, "");
    return IS_WIN(platform) ? t.toLowerCase() : t;
  };
  return n(a) === n(b);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** A node launcher in the project folder would win the cwd-first PATH search on Windows. */
export function nodeLauncherInProject(root: string, platform: string = process.platform): string | null {
  // Windows resolves bare `node` through PATHEXT (.exe .cmd .bat .com .vbs .js .wsh .msc ...), so ANY
  // root file named node.<ext> (or `node`) can win the cwd-first search; POSIX only runs an exact `node`.
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const n of names.sort()) {
    const base = IS_WIN(platform) ? n.toLowerCase() : n;
    if (base === "node" || (IS_WIN(platform) && base.startsWith("node."))) return n;
  }
  return null;
}

/** True when `dir` is a real directory (not a symlink/junction) whose realpath is exactly `expected`. */
function isPlainDirAt(dir: string, expected: string, platform: string): boolean {
  const st = lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  try {
    return sameFsPath(fs.realpathSync(dir), expected, platform);
  } catch {
    return false;
  }
}

function realRoot(root: string): string | null {
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

function sha256(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

const COMMONJS_MARKER = { type: "commonjs" };

/** .claude/hooks/package.json must be a plain file holding exactly the CommonJS marker the installer writes. */
function commonJsMarkerOk(hooksDir: string): boolean {
  const file = path.join(hooksDir, "package.json");
  const st = lstatOrNull(file);
  if (!st || st.isSymbolicLink() || !st.isFile()) return false;
  const r = readJsonObject(file);
  return !r.unreadable && JSON.stringify(r.data) === JSON.stringify(COMMONJS_MARKER);
}

/**
 * Content check: the script our entry runs and its whole local require closure
 * (hookInstall's bridge closure) must be real files, directly inside
 * <root>/.claude/hooks (no symlinks/junctions, no path escapes), and
 * byte-identical (sha256) to the copy shipped in the installed extension.
 */
export function hookClosureMatchesInstalled(root: string, id: string, def: TycoonServerDefs[string], env: ApprovalEnv): boolean {
  const platform = env.platform ?? process.platform;
  const rr = realRoot(root);
  if (rr === null) return false;
  const resolved = resolveConfigForPlatform(def as never, platform);
  if (!resolved.ok) return false;
  const files = bridgeFilesForConfig(withDispatcherProjectDir(id, resolved.config, root));
  if (files.length === 0) return false;
  const claudeDir = path.join(root, ".claude");
  const hooksDir = path.join(claudeDir, "hooks");
  if (!isPlainDirAt(claudeDir, path.join(rr, ".claude"), platform)) return false;
  if (!isPlainDirAt(hooksDir, path.join(rr, ".claude", "hooks"), platform)) return false;
  const realHooks = path.join(rr, ".claude", "hooks");
  // A project-level .claude/out is a require fallback path for the shipped scripts: never trusted.
  if (lstatOrNull(path.join(claudeDir, "out")) !== null) return false;
  if (!commonJsMarkerOk(hooksDir)) return false;
  for (const f of files) {
    if (f.includes("/") || f.includes("\\")) return false;
    const dest = path.join(hooksDir, f);
    const st = lstatOrNull(dest);
    if (!st || st.isSymbolicLink() || !st.isFile()) return false;
    let real: string;
    try {
      real = fs.realpathSync(dest);
    } catch {
      return false;
    }
    if (!sameFsPath(path.dirname(real), realHooks, platform)) return false;
    const src = env.resolveSrc(f);
    if (!src) return false;
    const want = sha256(src);
    const have = sha256(dest);
    if (want === null || have === null) return false;
    if (want !== have) {
      const alt = (env.altSrcs?.(f) ?? []).map(sha256);
      if (!alt.includes(have)) return false;
    }
  }
  return true;
}

function presentIds(root: string, defs: TycoonServerDefs, env: ApprovalEnv): { present: string[]; foreign: string[]; modified: string[] } {
  const mcp = readJsonObject(path.join(root, ".mcp.json"));
  const servers = mcp.data["mcpServers"];
  const out = { present: [] as string[], foreign: [] as string[], modified: [] as string[] };
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return out;
  const have = servers as Record<string, unknown>;
  for (const id of Object.keys(defs).sort()) {
    if (!Object.prototype.hasOwnProperty.call(have, id)) continue;
    if (!mcpEntryMatchesOurs(root, id, have[id], defs[id], env.platform)) out.foreign.push(id);
    else if (!hookClosureMatchesInstalled(root, id, defs[id], env)) out.modified.push(id);
    else out.present.push(id);
  }
  return out;
}

/** The dispatcher ("tycoon") spawns the other bridge servers, so it is unapprovable while any sibling entry is foreign or modified. */
function dispatcherSiblingProblems(found: { present: string[]; foreign: string[]; modified: string[] }, defs: TycoonServerDefs): string[] {
  if (!Object.prototype.hasOwnProperty.call(defs, "tycoon") || !found.present.includes("tycoon")) return [];
  return [...found.foreign, ...found.modified].filter((id) => id !== "tycoon").sort();
}

/** Rejections recorded outside the project (read-only): ~/.claude.json projects[root] and ~/.claude/settings.json. */
function homeDisabled(root: string, env: ApprovalEnv): { ids: Set<string>; unreadable: boolean } {
  const platform = env.platform ?? process.platform;
  const home = env.homeDir ?? os.homedir();
  const ids = new Set<string>();
  let unreadable = false;
  const rr = realRoot(root);
  const cj = readJsonObject(path.join(home, ".claude.json"));
  if (cj.unreadable) unreadable = true;
  else {
    const projects = cj.data["projects"];
    if (projects && typeof projects === "object" && !Array.isArray(projects)) {
      for (const [key, val] of Object.entries(projects as Record<string, unknown>)) {
        let keyReal: string | null = null;
        try {
          keyReal = fs.realpathSync(key);
        } catch {
          keyReal = null;
        }
        const hit = sameFsPath(key, root, platform) || (rr !== null && (sameFsPath(key, rr, platform) || (keyReal !== null && sameFsPath(keyReal, rr, platform))));
        if (!hit) continue;
        if (val && typeof val === "object") for (const id of strArray((val as Record<string, unknown>)["disabledMcpjsonServers"])) ids.add(id);
      }
    }
  }
  const us = readJsonObject(path.join(home, ".claude", "settings.json"));
  if (us.unreadable) unreadable = true;
  else for (const id of strArray(us.data["disabledMcpjsonServers"])) ids.add(id);
  return { ids, unreadable };
}

/** True when .claude or settings.local.json is a symlink/junction (or .claude resolves elsewhere). */
function settingsPathUnsafe(root: string, platform: string): boolean {
  const claudeDir = path.join(root, ".claude");
  const cst = lstatOrNull(claudeDir);
  if (cst) {
    if (cst.isSymbolicLink()) return true;
    const rr = realRoot(root);
    if (rr === null || !isPlainDirAt(claudeDir, path.join(rr, ".claude"), platform)) return true;
  }
  const lst = lstatOrNull(path.join(claudeDir, "settings.local.json"));
  return lst !== null && (lst.isSymbolicLink() || !lst.isFile());
}

function localPath(root: string): string {
  return path.join(root, ".claude", "settings.local.json");
}

/** Pure read of the approval state. Writes nothing. */
export function computeMcpApprovalState(root: string, defs: TycoonServerDefs, env: ApprovalEnv): McpApprovalState {
  const platform = env.platform ?? process.platform;
  const found = presentIds(root, defs, env);
  const hijack = nodeLauncherInProject(root, platform);
  const home = homeDisabled(root, env);
  const unsafe = settingsPathUnsafe(root, platform);
  const siblingProblems = dispatcherSiblingProblems(found, defs);
  const present = hijack !== null ? [] : found.present.filter((id) => !(id === "tycoon" && siblingProblems.length > 0));
  const ours = Object.keys(defs).sort();
  const local = readJsonObject(localPath(root));
  const shared = readJsonObject(path.join(root, ".claude", "settings.json"));
  const enabled = new Set<string>();
  const disabled = new Set<string>(home.ids);
  for (const s of [local, shared]) {
    for (const id of strArray(s.data["enabledMcpjsonServers"])) enabled.add(id);
    for (const id of strArray(s.data["disabledMcpjsonServers"])) disabled.add(id);
  }
  const perms = local.data["permissions"];
  const allow = perms && typeof perms === "object" && !Array.isArray(perms) ? strArray((perms as Record<string, unknown>)["allow"]) : [];
  const localEnabled = strArray(local.data["enabledMcpjsonServers"]);
  const blocked = home.unreadable || unsafe;
  return {
    present,
    foreign: found.foreign,
    modified: found.modified,
    pathHijack: hijack,
    dispatcherBlockedBy: siblingProblems,
    outFallback: lstatOrNull(path.join(root, ".claude", "out")) !== null,
    changedApproved: ours.filter((id) => (localEnabled.includes(id) || allow.includes(`mcp__${id}`)) && (hijack !== null || !present.includes(id))),
    pending: blocked ? [] : present.filter((id) => !enabled.has(id) && !disabled.has(id)),
    rejected: present.filter((id) => disabled.has(id)),
    removable: ours.filter((id) => !found.foreign.includes(id)).filter((id) => localEnabled.includes(id) || allow.includes(`mcp__${id}`)),
    localUnreadable: local.unreadable,
    unsafeSettingsPath: unsafe,
    homeUnreadable: home.unreadable,
  };
}

/** Webview-facing subset of the state; undefined when there is nothing to show. */
export function approvalSliceFromState(st: McpApprovalState): Omit<McpApprovalState, "present"> | undefined {
  const { present: _present, ...slice } = st;
  void _present;
  const any = st.pending.length + st.foreign.length + st.modified.length + st.rejected.length + st.removable.length + st.changedApproved.length + st.dispatcherBlockedBy.length > 0 || st.outFallback;
  return any || st.pathHijack !== null || st.homeUnreadable || st.unsafeSettingsPath ? slice : undefined;
}

export interface McpApprovalResult {
  ok: boolean;
  /** Ids written (approve) or removed (remove). */
  ids: string[];
  error?: string;
}

function writeAtomic(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist */
    }
    throw e;
  }
}

/** Plain object accessor that refuses non-object shapes by returning null. */
function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> | null | undefined {
  const v = parent[key];
  if (v === undefined) return undefined;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/**
 * Approve our present, not-disabled servers in settings.local.json. `requested`
 * is the webview's list: every id must be ours, present and not disabled, or the
 * whole request is refused and nothing is written. When `requested` is omitted
 * all pending ids are approved. `allowTools` additionally adds `mcp__<id>`
 * permission allow rules for those same ids.
 */
export function approveTycoonMcpServers(
  root: string,
  defs: TycoonServerDefs,
  requested: string[] | undefined,
  allowTools: boolean,
  env: ApprovalEnv,
): McpApprovalResult {
  if (!root) return { ok: false, ids: [], error: "No workspace folder open" };
  // Re-run every check right here (hash, then write immediately): the webview's state may be stale.
  const state = computeMcpApprovalState(root, defs, env);
  if (state.pathHijack !== null) return { ok: false, ids: [], error: `A ${state.pathHijack} launcher sits in the project folder and would run instead of Node. Nothing was approved; remove it first.` };
  if (state.homeUnreadable) return { ok: false, ids: [], error: "Couldn't read your Claude Code settings (~/.claude.json), so rejections can't be checked. Nothing was changed." };
  if (state.unsafeSettingsPath) return { ok: false, ids: [], error: ".claude or .claude/settings.local.json is a symbolic link or junction. Nothing was changed." };
  let ids: string[];
  if (requested === undefined) {
    ids = state.pending;
  } else {
    ids = [...new Set(requested)];
    const allowed = new Set(state.present.filter((id) => !state.rejected.includes(id)));
    const bad = ids.filter((id) => !allowed.has(id));
    if (bad.length > 0) return { ok: false, ids: [], error: "Request refused: it named servers that are not unmodified TycoonAgents installs in this project's .mcp.json, or that you rejected in Claude Code. Nothing was changed." };
  }
  if (ids.length === 0) return { ok: false, ids: [], error: "No TycoonAgents servers need approval." };

  const file = localPath(root);
  const local = readJsonObject(file);
  if (local.unreadable) return { ok: false, ids: [], error: "Couldn't read .claude/settings.local.json - fix it and try again. Nothing was changed." };
  const next: Record<string, unknown> = { ...local.data };
  const rawEnabled = next["enabledMcpjsonServers"];
  if (rawEnabled !== undefined && !Array.isArray(rawEnabled)) {
    return { ok: false, ids: [], error: "enabledMcpjsonServers in .claude/settings.local.json is not a list. Nothing was changed." };
  }
  const enabled = Array.isArray(rawEnabled) ? [...rawEnabled] : [];
  for (const id of ids) if (!enabled.includes(id)) enabled.push(id);
  next["enabledMcpjsonServers"] = enabled;
  if (allowTools) {
    const perms = objectAt(next, "permissions");
    if (perms === null) return { ok: false, ids: [], error: "permissions in .claude/settings.local.json is not an object. Nothing was changed." };
    const permsNext: Record<string, unknown> = { ...(perms ?? {}) };
    const rawAllow = permsNext["allow"];
    if (rawAllow !== undefined && !Array.isArray(rawAllow)) {
      return { ok: false, ids: [], error: "permissions.allow in .claude/settings.local.json is not a list. Nothing was changed." };
    }
    const allow = Array.isArray(rawAllow) ? [...rawAllow] : [];
    for (const id of ids) if (!allow.includes(`mcp__${id}`)) allow.push(`mcp__${id}`);
    permsNext["allow"] = allow;
    next["permissions"] = permsNext;
  }
  try {
    writeAtomic(file, next);
  } catch (e) {
    return { ok: false, ids: [], error: `Could not write .claude/settings.local.json: ${String(e)}` };
  }
  return { ok: true, ids };
}

/** Remove only what approveTycoonMcpServers can add for our ids; everything else is left as is. */
function removeIdsFromLocal(root: string, ourSet: Set<string>): McpApprovalResult {
  const file = localPath(root);
  const local = readJsonObject(file);
  if (!local.exists) return { ok: true, ids: [] };
  if (local.unreadable) return { ok: false, ids: [], error: "Couldn't read .claude/settings.local.json - fix it and try again. Nothing was changed." };
  const next: Record<string, unknown> = { ...local.data };
  const removed = new Set<string>();
  const rawEnabled = next["enabledMcpjsonServers"];
  if (Array.isArray(rawEnabled)) {
    next["enabledMcpjsonServers"] = rawEnabled.filter((x) => {
      if (typeof x === "string" && ourSet.has(x)) {
        removed.add(x);
        return false;
      }
      return true;
    });
  }
  const perms = objectAt(next, "permissions");
  if (perms && Array.isArray(perms["allow"])) {
    const allow = (perms["allow"] as unknown[]).filter((x) => {
      if (typeof x === "string" && x.startsWith("mcp__") && ourSet.has(x.slice(5))) {
        removed.add(x.slice(5));
        return false;
      }
      return true;
    });
    next["permissions"] = { ...perms, allow };
  }
  if (removed.size === 0) return { ok: true, ids: [] };
  try {
    writeAtomic(file, next);
  } catch (e) {
    return { ok: false, ids: [], error: `Could not write .claude/settings.local.json: ${String(e)}` };
  }
  return { ok: true, ids: [...removed].sort() };
}

export function removeTycoonMcpApprovals(root: string, defs: TycoonServerDefs, env: ApprovalEnv): McpApprovalResult {
  if (!root) return { ok: false, ids: [], error: "No workspace folder open" };
  if (settingsPathUnsafe(root, env.platform ?? process.platform)) return { ok: false, ids: [], error: ".claude or .claude/settings.local.json is a symbolic link or junction. Nothing was changed." };
  const foreignIds = new Set(presentIds(root, defs, env).foreign);
  return removeIdsFromLocal(root, new Set(Object.keys(defs).filter((id) => !foreignIds.has(id))));
}

/** Revoke one id's approval (its enabledMcpjsonServers entry and its mcp__<id> allow rule) after its server changed. */
export function revokeTycoonMcpApproval(root: string, defs: TycoonServerDefs, id: string, env: ApprovalEnv): McpApprovalResult {
  if (!root) return { ok: false, ids: [], error: "No workspace folder open" };
  if (!Object.prototype.hasOwnProperty.call(defs, id)) return { ok: false, ids: [], error: "That is not a TycoonAgents server. Nothing was changed." };
  if (settingsPathUnsafe(root, env.platform ?? process.platform)) return { ok: false, ids: [], error: ".claude or .claude/settings.local.json is a symbolic link or junction. Nothing was changed." };
  return removeIdsFromLocal(root, new Set([id]));
}

/**
 * User-clicked repair for "modified copy": re-copies our hook files (the same
 * installer path as the MCP install) for the entries whose command is ours but
 * whose content differs. Refuses symlinked/junctioned .claude, .claude/hooks or
 * destination files so the copy can never write through a link.
 */
export function repairTycoonHookCopies(root: string, defs: TycoonServerDefs, env: ApprovalEnv): McpApprovalResult {
  return withHookWrite(() => repairTycoonHookCopiesUngated(root, defs, env));
}

function repairTycoonHookCopiesUngated(root: string, defs: TycoonServerDefs, env: ApprovalEnv): McpApprovalResult {
  if (!root) return { ok: false, ids: [], error: "No workspace folder open" };
  const platform = env.platform ?? process.platform;
  const rr = realRoot(root);
  const claudeDir = path.join(root, ".claude");
  const hooksDir = path.join(claudeDir, "hooks");
  const bad = (p: string): boolean => {
    const st = lstatOrNull(p);
    return st !== null && st.isSymbolicLink();
  };
  if (rr === null || bad(claudeDir) || bad(hooksDir) || (lstatOrNull(claudeDir) !== null && !isPlainDirAt(claudeDir, path.join(rr, ".claude"), platform)) || (lstatOrNull(hooksDir) !== null && !isPlainDirAt(hooksDir, path.join(rr, ".claude", "hooks"), platform))) {
    return { ok: false, ids: [], error: ".claude or .claude/hooks is a symbolic link or junction. Nothing was changed." };
  }
  const ids = presentIds(root, defs, env).modified;
  const fixed: string[] = [];
  for (const id of ids) {
    const resolved = resolveConfigForPlatform(defs[id] as never, platform);
    if (!resolved.ok) continue;
    const files = bridgeFilesForConfig(withDispatcherProjectDir(id, resolved.config, root));
    if (bad(path.join(hooksDir, "package.json"))) return { ok: false, ids: fixed, error: ".claude/hooks/package.json is a symbolic link. Nothing was changed." };
    if (files.some((f) => bad(path.join(hooksDir, f)))) return { ok: false, ids: fixed, error: `${id}: a hook file is a symbolic link. Nothing was changed for it.` };
    const errors: string[] = [];
    copyMcpBridgeHooks(root, resolved.config, env.resolveSrc, (m) => errors.push(m));
    if (errors.length > 0) return { ok: false, ids: fixed, error: errors.join(" ") };
    if (!commonJsMarkerOk(hooksDir)) {
      try {
        writeAtomic(path.join(hooksDir, "package.json"), COMMONJS_MARKER);
      } catch (e) {
        return { ok: false, ids: fixed, error: `Could not write .claude/hooks/package.json: ${String(e)}` };
      }
    }
    fixed.push(id);
  }
  return { ok: true, ids: fixed };
}

/**
 * Automatic safety revocation (runs regardless of the approve-button flag).
 * Revokes the approval (enabledMcpjsonServers entry + mcp__<id> allow rule, in
 * settings.local.json only) of every TycoonAgents id that is approved while its
 * entry is now modified, foreign, shadowed by .claude/out or a node launcher in
 * the project, or (for the dispatcher) blocked by a changed sibling. Third-party
 * servers are never touched: only ids in `defs` are considered. Refuses links.
 */
export function autoRevokeChangedApprovals(root: string, defs: TycoonServerDefs, env: ApprovalEnv, onlyIds?: ReadonlyArray<string>): McpApprovalResult {
  const found = findChangedApprovedIds(root, defs, env);
  if (!found.ok) return { ok: false, ids: [], error: found.error };
  const bad = onlyIds ? found.ids.filter((id) => onlyIds.includes(id)) : found.ids;
  if (bad.length === 0) return { ok: true, ids: [] };
  if (found.unsafeSettingsPath) return { ok: false, ids: [], error: ".claude or .claude/settings.local.json is a symbolic link or junction. Nothing was changed." };
  return removeIdsFromLocal(root, new Set(bad));
}

/** Read-only half of {@link autoRevokeChangedApprovals}: the approved ids that would be revoked right now. */
export function findChangedApprovedIds(
  root: string,
  defs: TycoonServerDefs,
  env: ApprovalEnv,
): { ok: true; ids: string[]; unsafeSettingsPath: boolean } | { ok: false; error: string } {
  if (!root) return { ok: true, ids: [], unsafeSettingsPath: false };
  let state: McpApprovalState;
  try {
    state = computeMcpApprovalState(root, defs, env);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const local = readJsonObject(localPath(root));
  if (!local.exists || local.unreadable) return { ok: true, ids: [], unsafeSettingsPath: false };
  const perms = objectAt(local.data, "permissions");
  const allow = perms ? strArray(perms["allow"]) : [];
  const approved = Object.keys(defs).filter((id) => strArray(local.data["enabledMcpjsonServers"]).includes(id) || allow.includes(`mcp__${id}`));
  const ids = approved.filter((id) => state.foreign.includes(id) || state.modified.includes(id) || state.outFallback || state.pathHijack !== null || (id === "tycoon" && state.dispatcherBlockedBy.length > 0));
  return { ok: true, ids, unsafeSettingsPath: state.unsafeSettingsPath };
}
