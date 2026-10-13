/**
 * Wording, key aliases, discovery, sanitizer and confirm text for MCP servers owned by a separately
 * installed product (catalog `providedBy`; today only uefn-bridge from Trashbyrd's Power Tools).
 *
 * Read-only by design: this module only stats and reads files (it never writes, copies or deletes
 * anything), and test/powerToolsIsolation.test.ts holds it to that.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const POWER_TOOLS_REPO_URL = "https://github.com/Corsair-Studios/trashbyrds-uefn-power-tools";
/** The server key Power Tools' own INSTALL.md tells users to add. This is the name we register under. */
export const POWER_TOOLS_SERVER_KEY = "powertools";
/** VS Code setting (under `tycoonagents.`) holding the Power Tools folder override. */
export const POWER_TOOLS_DIR_SETTING = "powerTools.dir";
/** Environment variable holding the Power Tools folder override. */
export const POWER_TOOLS_DIR_ENV = "TYCOON_POWER_TOOLS_DIR";
const SERVER_FILE = "uefn-server.mjs";

/** Shown on the MCP tab / pack row when no Power Tools entry exists and no Power Tools folder was found. */
export const POWER_TOOLS_MCP_MISSING =
  `Provided by Trashbyrd's Power Tools. No Power Tools folder (one containing ${SERVER_FILE}) was found next to your workspace, ` +
  `in its parent folders or in your home folder. Install Power Tools from ${POWER_TOOLS_REPO_URL}, or point TycoonAgents at it with ` +
  `the tycoonagents.${POWER_TOOLS_DIR_SETTING} setting or the ${POWER_TOOLS_DIR_ENV} environment variable, then click Enable MCP again.`;

/**
 * Server keys that count as the same catalog server. Power Tools' INSTALL.md uses "powertools";
 * "uefn-bridge" is the catalog id and the key older setups used. The first key is the preferred one.
 */
const KEY_ALIASES: Record<string, string[]> = {
  "uefn-bridge": [POWER_TOOLS_SERVER_KEY, "uefn-bridge"],
};

/** Every key under which catalog server `id` may be registered (just `[id]` for ordinary servers). */
export function providedMcpKeys(id: string): string[] {
  return KEY_ALIASES[id] ?? [id];
}

/** True for a stdio entry whose args launch Power Tools' `uefn-server.mjs` (what its INSTALL.md registers). */
export function isPowerToolsServerEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.command !== "string" || !Array.isArray(e.args)) return false;
  return e.args.some((a) => typeof a === "string" && /(^|[\\/])uefn-server\.mjs$/i.test(a));
}

/**
 * Whether `entry`, found under one of `id`'s keys, is the provided product's own server. Servers with a single key
 * are always theirs; for the aliased Power Tools server an entry that does not launch `uefn-server.mjs` is some
 * other server that happens to use the name, and is ignored for status and never removed.
 */
export function providedMcpEntryIsOurs(id: string, entry: unknown): boolean {
  return KEY_ALIASES[id] === undefined ? true : isPowerToolsServerEntry(entry);
}

/**
 * The key under which catalog server `id` is present in a parsed .mcp.json-shaped object (its `mcpServers`
 * map, or the object itself when it has none) and is the provided product's entry, or undefined.
 */
export function findProvidedMcpKey(config: unknown, id: string): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const c = config as Record<string, unknown>;
  const servers = c.mcpServers !== null && typeof c.mcpServers === "object" ? (c.mcpServers as Record<string, unknown>) : c;
  return providedMcpKeys(id).find((k) => Object.prototype.hasOwnProperty.call(servers, k) && providedMcpEntryIsOurs(id, servers[k]));
}

// ---------------------------------------------------------------------------
// Power Tools folder discovery (docs/PATH-DISCOVERY.md): override first, then content-based search.
//
// A repository the user opened can ship any folder it likes, so nothing at or under an open workspace folder is
// ever a candidate, and candidates are never ranked by anything the folder says about itself (version fields).
// Order is by where it was found: setting, env, then folders next to the workspace, then the home folder; within
// one of those, the most recently modified uefn-server.mjs.
// ---------------------------------------------------------------------------

export interface PowerToolsDiscoveryOptions {
  /** The primary workspace root. */
  root: string;
  /** Every open workspace folder (defaults to [root]); candidates at or under any of them are excluded. */
  workspaceFolders?: string[];
  /** Value of the tycoonagents.powerTools.dir setting, if any. */
  settingDir?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export type PowerToolsFound = {
  ok: true;
  dir: string;
  serverPath: string;
  version?: string;
  source: "setting" | "env" | "discovered";
  /** Every other folder found, in preference order. */
  others: string[];
  /** Why `dir` was chosen over `others` (empty when there was no choice). */
  reason: string;
};
export type PowerToolsDiscovery = PowerToolsFound | { ok: false; error: string };

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readText(p: string, max = 65536): string {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

const POWER_TOOLS_REPO_PATH_RE = /github\.com\/Corsair-Studios\/trashbyrds-uefn-power-tools/i;

/** Content test: `dir` holds uefn-server.mjs and an INSTALL.md or README.md that carries Power Tools' repository URL. */
export function inspectPowerToolsDir(dir: string): { version?: string; mtimeMs: number } | undefined {
  const server = path.join(dir, SERVER_FILE);
  if (!isFile(server)) return undefined;
  const identified = ["INSTALL.md", "README.md"].some((f) => POWER_TOOLS_REPO_PATH_RE.test(readText(path.join(dir, f))));
  if (!identified) return undefined;
  let version: string | undefined; // display only, never used to rank
  try {
    const pkg = JSON.parse(readText(path.join(dir, "package.json"))) as Record<string, unknown>;
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    /* no or unreadable package.json */
  }
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(server).mtimeMs;
  } catch {
    /* ignore */
  }
  return { version, mtimeMs };
}

const MAX_CHILDREN_PER_ROOT = 200;

function childDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_CHILDREN_PER_ROOT)
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function realKey(p: string): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync(r);
  } catch {
    /* not on disk: compare the resolved path */
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** True when `candidate` is `folder` or inside it (both compared by real path, so links cannot hide a folder). */
function isAtOrUnder(candidate: string, folder: string): boolean {
  const rel = path.relative(realKey(folder), realKey(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Search groups in preference order. Each lists folders whose direct children are candidates. */
function searchGroups(folders: string[], home: string): Array<{ label: string; bases: string[] }> {
  const near: string[] = [];
  for (const f of folders) near.push(path.dirname(path.resolve(f)), path.dirname(path.dirname(path.resolve(f))));
  const homeBases = home ? [home, path.join(home, "Documents"), path.join(home, "Downloads"), path.join(home, "Desktop")] : [];
  const dedupe = (list: string[]): string[] => {
    const seen = new Set<string>();
    return list.filter((b) => {
      const k = realKey(b);
      if (seen.has(k) || path.dirname(path.resolve(b)) === path.resolve(b)) return false; // duplicates and filesystem roots
      seen.add(k);
      return true;
    });
  };
  return [
    { label: "next to your workspace", bases: dedupe(near) },
    { label: "in your home folder", bases: dedupe(homeBases) },
  ];
}

/**
 * Locate a Power Tools checkout or release folder. An override (setting, then env) is used verbatim and an
 * invalid override is an explicit error, never a silent fall-through. Otherwise folders next to the workspace
 * come before the home folder and, inside each, the most recently modified uefn-server.mjs wins. Nothing at or
 * under an open workspace folder is considered. The others are returned so the UI can show every path.
 */
export function discoverPowerTools(o: PowerToolsDiscoveryOptions): PowerToolsDiscovery {
  const env = o.env ?? process.env;
  const overrides: Array<{ source: "setting" | "env"; raw: string; label: string }> = [];
  if (o.settingDir && o.settingDir.trim() !== "") {
    overrides.push({ source: "setting", raw: o.settingDir.trim(), label: `the tycoonagents.${POWER_TOOLS_DIR_SETTING} setting` });
  }
  const envDir = env[POWER_TOOLS_DIR_ENV];
  if (envDir && envDir.trim() !== "") {
    overrides.push({ source: "env", raw: envDir.trim(), label: `the ${POWER_TOOLS_DIR_ENV} environment variable` });
  }
  if (overrides.length > 0) {
    const { source, raw, label } = overrides[0];
    const dir = path.basename(raw).toLowerCase() === SERVER_FILE ? path.dirname(raw) : raw;
    if (!isFile(path.join(dir, SERVER_FILE))) {
      return { ok: false, error: `${label} points at ${raw}, which does not contain ${SERVER_FILE}. Fix or clear it, then click Enable MCP again.` };
    }
    const abs = path.resolve(dir);
    return { ok: true, dir: abs, serverPath: path.join(abs, SERVER_FILE), version: inspectPowerToolsDir(abs)?.version, source, others: [], reason: "" };
  }

  const home =
    o.homeDir ??
    (() => {
      try {
        return os.homedir();
      } catch {
        return "";
      }
    })();
  const folders = o.workspaceFolders && o.workspaceFolders.length > 0 ? o.workspaceFolders : [o.root];
  const groups = searchGroups(folders, home);
  const seen = new Set<string>();
  const ranked: Array<{ dir: string; version?: string; mtimeMs: number; label: string }> = [];
  for (const g of groups) {
    const inGroup: Array<{ dir: string; version?: string; mtimeMs: number; label: string }> = [];
    for (const base of g.bases) {
      for (const dir of childDirs(base)) {
        const key = realKey(dir);
        if (seen.has(key)) continue;
        seen.add(key);
        if (folders.some((f) => isAtOrUnder(dir, f))) continue; // a repository's own files are never trusted
        const info = inspectPowerToolsDir(dir);
        if (info) inGroup.push({ dir: path.resolve(dir), ...info, label: g.label });
      }
    }
    inGroup.sort((a, b) => b.mtimeMs - a.mtimeMs || a.dir.localeCompare(b.dir));
    ranked.push(...inGroup);
  }
  if (ranked.length === 0) {
    const looked = groups.flatMap((g) => g.bases);
    return {
      ok: false,
      error:
        `No Power Tools folder (one containing ${SERVER_FILE} plus Power Tools' INSTALL.md or README.md) was found outside your workspace. Looked in the folders directly inside: ${looked.join(", ") || "(no folders)"}. ` +
        `Install Power Tools from ${POWER_TOOLS_REPO_URL}, or set the tycoonagents.${POWER_TOOLS_DIR_SETTING} setting or the ${POWER_TOOLS_DIR_ENV} environment variable to the folder holding ${SERVER_FILE}, then click Enable MCP again.`,
    };
  }
  const best = ranked[0];
  const reason =
    ranked.length === 1
      ? ""
      : ranked.slice(1).some((r) => r.label !== best.label)
        ? `it is ${best.label}, which is searched before the other locations; among folders in one location the most recently modified ${SERVER_FILE} wins`
        : `its ${SERVER_FILE} is the most recently modified`;
  return {
    ok: true,
    dir: best.dir,
    serverPath: path.join(best.dir, SERVER_FILE),
    version: best.version,
    source: "discovered",
    others: ranked.slice(1).map((r) => r.dir),
    reason,
  };
}

/** The entry Power Tools' INSTALL.md describes: `node <abs path>/uefn-server.mjs`, no env (forward slashes, as it recommends). */
export function buildPowerToolsConfig(serverPath: string, nodeCommand: string): { command: string; args: string[] } {
  return { command: nodeCommand, args: [serverPath.replace(/\\/g, "/")] };
}

/** Paragraph for the confirm dialog: which Power Tools folder is used, where it came from, and every other one found. */
export function describePowerToolsChoice(d: PowerToolsFound): string {
  const from =
    d.source === "discovered" ? "found on this machine" : d.source === "setting" ? `from the tycoonagents.${POWER_TOOLS_DIR_SETTING} setting` : `from ${POWER_TOOLS_DIR_ENV}`;
  const lines = [`Using Power Tools${d.version ? ` ${d.version}` : ""} at ${d.dir} (${from}).`];
  if (d.others.length > 0) {
    lines.push(`Found ${d.others.length + 1} Power Tools folders:`);
    for (const p of [d.dir, ...d.others]) lines.push(`  ${p === d.dir ? "> " : "  "}${p}`);
    lines.push(`Using the first because ${d.reason}. To use another one, set tycoonagents.${POWER_TOOLS_DIR_SETTING}.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sanitizer and confirm text
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set(["command", "args", "env"]);
const MAX_CONFIG_CHARS = 2000;
const BLOCKED_ENV = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PYTHONPATH|PYTHONSTARTUP|PATH|COMSPEC|npm_config_.*)$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp("[\u0000-\u001f\u007f\u0085  ]");

export type ProvidedMcpSanitized =
  | { ok: true; config: { command: string; args?: string[]; env?: Record<string, string> } }
  | { ok: false; error: string };

/**
 * Reduce a server entry to the only shape we will register: stdio `command`, `args`, `env`.
 * Anything else (url/type/headers/cwd/unknown keys, control characters, code-loading env keys, oversize) is refused.
 */
export function sanitizeProvidedMcpEntry(id: string, raw: unknown): ProvidedMcpSanitized {
  const no = (why: string): ProvidedMcpSanitized => ({ ok: false, error: `The ${id} entry was not enabled: ${why}` });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return no("it is not an object.");
  const cfg = raw as Record<string, unknown>;
  if (cfg.url !== undefined && cfg.command !== undefined) return no("it has both url and command.");
  if (cfg.url !== undefined) return no("remote (url) servers are not supported here.");
  if (cfg.type !== undefined && cfg.type !== "stdio") return no(`type "${String(cfg.type)}" is not stdio.`);
  for (const k of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(k) && k !== "type") return no(`unsupported key "${k}" (only command, args and env are allowed).`);
  }
  if (typeof cfg.command !== "string" || cfg.command.trim() === "") return no("it has no command.");
  const out: { command: string; args?: string[]; env?: Record<string, string> } = { command: cfg.command };
  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args) || !cfg.args.every((a) => typeof a === "string")) return no("args must be a list of strings.");
    out.args = cfg.args as string[];
  }
  if (cfg.env !== undefined) {
    if (cfg.env === null || typeof cfg.env !== "object" || Array.isArray(cfg.env)) return no("env must be an object of strings.");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
      if (typeof v !== "string") return no(`env ${k} must be a string.`);
      if (BLOCKED_ENV.test(k)) return no(`env key ${k} changes how processes load code, so it is refused.`);
      env[k] = v;
    }
    out.env = env;
  }
  const strings = [out.command, ...(out.args ?? []), ...Object.entries(out.env ?? {}).flat()];
  if (strings.some((x) => CONTROL_RE.test(x))) return no("it contains control characters or newlines.");
  if (JSON.stringify(out, null, 2).length > MAX_CONFIG_CHARS) return no(`it is longer than ${MAX_CONFIG_CHARS} characters.`);
  return { ok: true, config: out };
}

/** Modal `detail` for Enable: exactly the JSON that will be registered, optionally preceded by an intro paragraph. */
export function providedMcpConfirmDetail(id: string, config: unknown, homepage?: string, intro?: string): string {
  return (
    `${intro ? `${intro}\n\n` : ""}Registers "${id}" for your Claude Code sessions, exactly as below:\n\n${JSON.stringify(config, null, 2)}` +
    `${homepage ? `\n\nSource: ${homepage}` : ""}\n\nOnly enable it if you recognise this command.`
  );
}
