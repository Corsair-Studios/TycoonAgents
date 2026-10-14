/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Installer for the tycoon-dispatcher MCP server registration (plan p23-t2).
// Merges a `[mcp_servers.tycoon]` table into CODEX_HOME/config.toml so Codex
// launches hooks/tycoon-dispatcher-mcp.cjs as an MCP server. Unlike the
// `notify` top-level key handled by installCodexHooks.ts, `[mcp_servers.tycoon]`
// IS a table itself, so it must be appended AFTER all existing content
// (never spliced before the first table header) and must never split an
// existing table's body. See docs/codex-cross-vendor-bridge.md Option A.
//
// No secret values are written to config.toml: only
// TYCOON_CODEX_DISPATCHER_CONFIGURED goes into the managed `env` map.
// CLAUDE_CLI_*/OPENAI_COMPAT_* secrets are read by the server itself from
// the process environment it is launched with.

import * as fs from "fs";
import * as path from "path";
import { resolveCodexHome, samePath, isNewerExtensionPath, type ResolveCodexHomeEnv } from "./installCodexHooks";
import { allVendorKeyEnvNames, customEndpointNameProblem, customKeyNameProblem } from "../../core/vendorKeys";
import { hasValue as localEnvHasValue } from "../../core/localEnvStore";
import { NODE_NOT_FOUND_WARNING, isBareNodeCommand, resolveNodeBinary } from "./resolveNodeBinary";
import { writeFileAtomic, collapseBlankRunAt, detectEol, scanTomlLines, type TomlLine } from "./tomlScan";

/** Marker delimiting the block this installer owns inside config.toml, so uninstall removes only its own lines. */
const DISPATCHER_MARKER_START = "# tycoon-dispatcher: managed mcp server (do not edit by hand)";
const DISPATCHER_MARKER_END = "# tycoon-dispatcher: end managed mcp server";

/** The TOML table header our managed block owns. Used to detect a foreign (non-managed) table of the same name. */
const DISPATCHER_TABLE_HEADER = "[mcp_servers.tycoon]";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(items: string[]): string {
  return "[" + items.map((s) => tomlString(s)).join(", ") + "]";
}

function tomlInlineEnvTable(env: Record<string, string>): string {
  const entries = Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return "{ " + entries.join(", ") + " }";
}

export interface BuildDispatcherBlockOptions {
  nodePath: string;
  serverScriptPath: string;
  /** Env var NAMES Codex should forward to the server; defaults to dispatcherEnvVarNames(). */
  envVarNames?: string[];
}

/**
 * Names the dispatcher and its adapters read besides vendor keys. Codex starts
 * stdio MCP servers with a filtered environment, so each must be listed in
 * `env_vars` to reach the server. Names only, never values.
 */
const DISPATCHER_STATIC_ENV_NAMES = [
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "XDG_DATA_HOME",
  "CLAUDE_CLI_BIN",
  "CLAUDE_CLI_CWD",
  "CLAUDE_CLI_MODEL",
  "CLAUDE_CLI_PERMISSION_MODE",
  "CLAUDE_CONFIG_DIR",
  "CODEX_BINARY_PATH",
  "CODEX_CLI_PATH",
  "CODEX_HOME",
  "CODEX_REASONING_EFFORT",
  "GEMINI_MCP_BACKEND",
  "GEMINI_MODEL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_TIMEOUT_MS",
  "TYCOON_NODE_PATH",
  "TYCOON_AGY_PATH",
  "TYCOON_GEMINI_MCP_CMD",
  "TYCOON_GEMINI_MCP_ARGS",
];

export interface DispatcherEnvNameOptions {
  env?: Record<string, string | undefined>;
  /** Whether the per-user local env store holds a value for `name`. */
  hasStored?: (name: string, env: Record<string, string | undefined>) => boolean;
}

interface CustomEnvPair {
  endpointEnv?: string;
  credentialEnv?: string;
}

function collectCustomEnvPairs(node: unknown, out: CustomEnvPair[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectCustomEnvPairs(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const endpointEnv = typeof obj.endpointEnv === "string" ? obj.endpointEnv : undefined;
  const credentialEnv = typeof obj.credentialEnv === "string" ? obj.credentialEnv : undefined;
  if (endpointEnv !== undefined || credentialEnv !== undefined) out.push({ endpointEnv, credentialEnv });
  for (const value of Object.values(obj)) collectCustomEnvPairs(value, out, depth + 1);
}

/** Variable names declared in any env block of the project's .mcp.json (repo-controlled). */
function declaredMcpEnvNames(projectDir: string): Set<string> {
  const names = new Set<string>();
  try {
    const raw = fs.readFileSync(path.join(projectDir, ".mcp.json"), "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> } | null;
    const servers = (parsed && parsed.mcpServers) || (parsed as Record<string, unknown> | null) || {};
    for (const entry of Object.values(servers)) {
      const e = entry as { env?: unknown } | null;
      if (e && typeof e === "object" && e.env && typeof e.env === "object") {
        for (const k of Object.keys(e.env as object)) names.add(k);
      }
    }
  } catch {
    /* no or invalid .mcp.json: nothing declared */
  }
  return names;
}

/**
 * Sorted env var names to forward: the fixed vendor key/URL names and the
 * static names above, plus custom-endpoint names from the project's
 * routing.json. A committed routing.json must not be able to pull arbitrary
 * credentials out of the machine environment, so a project-derived name is
 * forwarded only when its endpointEnv is user-set (process env or the
 * per-user store) and is not declared in the project's .mcp.json; a
 * credentialEnv additionally needs that paired endpointEnv and must pass the
 * custom-key name rules (denied names are never forwarded).
 */
export function dispatcherEnvVarNames(projectDir?: string, options: DispatcherEnvNameOptions = {}): string[] {
  const names = new Set<string>([...allVendorKeyEnvNames(), ...DISPATCHER_STATIC_ENV_NAMES]);
  if (projectDir) {
    const env = options.env ?? process.env;
    const hasStored = options.hasStored ?? ((n: string, e: Record<string, string | undefined>) => localEnvHasValue(n, { env: e }));
    try {
      const raw = fs.readFileSync(path.join(projectDir, ".claude", "tycoon", "routing.json"), "utf8");
      const pairs: CustomEnvPair[] = [];
      collectCustomEnvPairs(JSON.parse(raw), pairs);
      const declared = declaredMcpEnvNames(projectDir);
      const userSet = (n: string): boolean => (typeof env[n] === "string" && env[n] !== "") || hasStored(n, env);
      for (const { endpointEnv, credentialEnv } of pairs) {
        if (endpointEnv === undefined || customEndpointNameProblem(endpointEnv) !== undefined) continue;
        if (declared.has(endpointEnv) || !userSet(endpointEnv)) continue;
        names.add(endpointEnv);
        if (credentialEnv !== undefined && customKeyNameProblem(credentialEnv, undefined, endpointEnv) === undefined) {
          names.add(credentialEnv);
        }
      }
    } catch {
      /* no readable routing.json: base names only */
    }
  }
  return Array.from(names).sort();
}

const MAX_FORWARDED_ENV_NAMES = 200;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The `env_vars` names in the managed block, if any. */
export function readManagedEnvVars(text: string): string[] {
  const stripped = stripManagedRegion(text, true);
  if (!stripped) return [];
  const m = /^[ \t]*env_vars[ \t]*=[ \t]*(\[[^\r\n]*\])/m.exec(text.slice(stripped.start, stripped.end));
  if (!m) return [];
  try {
    const parsed: unknown = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string" && ENV_NAME_RE.test(n)) : [];
  } catch {
    return [];
  }
}

/**
 * Union of the names already written and the ones expected now, so two
 * windows with different projects don't keep rewriting each other's custom
 * names. Capped: base names always stay; newly expected custom names win over
 * older ones.
 */
export function unionEnvVarNames(existing: string[], expected: string[]): string[] {
  const base = new Set<string>([...allVendorKeyEnvNames(), ...DISPATCHER_STATIC_ENV_NAMES]);
  const expectedCustom = expected.filter((n) => !base.has(n));
  const expectedSet = new Set(expected);
  const olderCustom = existing.filter((n) => !base.has(n) && !expectedSet.has(n));
  const room = Math.max(0, MAX_FORWARDED_ENV_NAMES - base.size);
  const customs = Array.from(new Set([...expectedCustom, ...olderCustom])).slice(0, room);
  return Array.from(new Set([...base, ...customs])).sort();
}

/** Build the managed `[mcp_servers.tycoon]` block text (without surrounding blank-line separators). */
export function buildDispatcherBlock(options: BuildDispatcherBlockOptions): string {
  // No TYCOON_PROJECT_DIR: config.toml is user-level (machine-wide), so a
  // project path here would pin every Codex session to the last installer's
  // project. The dispatcher resolves the project per call instead.
  const env = {
    TYCOON_CODEX_DISPATCHER_CONFIGURED: "1",
  };
  return [
    DISPATCHER_MARKER_START,
    DISPATCHER_TABLE_HEADER,
    `command = ${tomlString(options.nodePath)}`,
    `args = ${tomlStringArray([options.serverScriptPath])}`,
    `env = ${tomlInlineEnvTable(env)}`,
    `env_vars = ${tomlStringArray(Array.from(new Set(options.envVarNames ?? dispatcherEnvVarNames())).sort())}`,
    DISPATCHER_MARKER_END,
  ].join("\n");
}

const DISPATCHER_SCRIPT_BASENAME = "tycoon-dispatcher-mcp.cjs";
const TYCOON_TABLE_NAME = "mcp_servers.tycoon";
const TYCOON_TOOLS_PREFIX = "mcp_servers.tycoon.tools.";

function isTycoonTableName(name: string): boolean {
  return name === TYCOON_TABLE_NAME || name.startsWith(TYCOON_TABLE_NAME + ".");
}

/**
 * Copy of `text[from, to)` (line offsets) without any `[mcp_servers.tycoon]` /
 * `[mcp_servers.tycoon.*]` table (a table runs until the next real header
 * line). `keepTools` keeps `[mcp_servers.tycoon.tools.*]`, the user's tool
 * approvals. Also drops the lines listed in `dropLines`.
 */
function dropTycoonTables(
  text: string,
  lines: TomlLine[],
  firstLine: number,
  lastLine: number,
  keepTools: boolean,
  dropLines: ReadonlySet<number>,
): string {
  let dropping = false;
  let out = "";
  for (let li = firstLine; li <= lastLine; li++) {
    const line = lines[li];
    if (line.header) {
      dropping = isTycoonTableName(line.header.name) && !(keepTools && line.header.name.startsWith(TYCOON_TOOLS_PREFIX));
    }
    if (!dropping && !dropLines.has(li)) out += text.slice(line.start, line.next);
  }
  return out;
}

interface StrippedRegion {
  text: string;
  /** True when nothing but our own tables and marker lines sat between the markers. */
  regionEmpty: boolean;
  /** Offset where the region began, and the end of the end-marker line's content. */
  start: number;
  end: number;
}

/**
 * Codex rewrites config.toml and may reorder tables, leaving other servers'
 * tables between our two marker comments. So removal is table-scoped: inside
 * the marker pair, drop only the marker lines and our `mcp_servers.tycoon`
 * tables; every other line stays byte-for-byte. Returns undefined when there
 * is no marker pair.
 */
function stripManagedRegion(text: string, keepTools: boolean): StrippedRegion | undefined {
  const lines = scanTomlLines(text);
  const isMarker = (l: TomlLine, marker: string): boolean => !l.cont && text.slice(l.start, l.end).trim() === marker;
  const startLi = lines.findIndex((l) => isMarker(l, DISPATCHER_MARKER_START));
  if (startLi === -1) return undefined;
  let endLi = -1;
  for (let li = startLi + 1; li < lines.length; li++) {
    if (isMarker(lines[li], DISPATCHER_MARKER_END)) {
      endLi = li;
      break;
    }
  }
  if (endLi === -1) return undefined;
  const start = lines[startLi].start;
  const end = lines[endLi].end;
  const kept = dropTycoonTables(text, lines, startLi, endLi, keepTools, new Set([startLi, endLi]));
  if (kept.trim() === "") return { text: text.slice(0, start) + text.slice(end), regionEmpty: true, start, end };
  return { text: text.slice(0, start) + kept + text.slice(lines[endLi].next), regionEmpty: false, start, end };
}

export interface MergeDispatcherResult {
  text: string;
  warnings?: string[];
}

/**
 * Merge the managed `[mcp_servers.tycoon]` block into an existing
 * config.toml's text content (or create fresh content if `existing` is
 * undefined). Idempotent: replaces a prior managed block wholesale rather
 * than duplicating it. The block is ALWAYS appended after all existing
 * content — the opposite placement rule from mergeNotifyIntoConfigToml,
 * because this block IS a table and inserting it earlier could annex
 * following bare keys/tables into it, or split an existing table's body if
 * inserted mid-table. If a foreign `[mcp_servers.tycoon]` table exists
 * outside our markers, the file is left untouched (aside from stripping our
 * own stale managed block, if any) and a warning is returned. A table that
 * runs our dispatcher script is treated as ours and rewritten. The file's
 * line ending (LF or CRLF) is kept.
 */
export function mergeDispatcherIntoConfigToml(
  existing: string | undefined,
  options: BuildDispatcherBlockOptions,
): MergeDispatcherResult {
  const text = existing ?? "";
  const eol = detectEol(text);
  const block = buildDispatcherBlock(options).split("\n").join(eol);

  const stripped = stripManagedRegion(text, true);
  let working = text;
  if (stripped) {
    working = stripped.regionEmpty ? collapseBlankRunAt(stripped.text, stripped.start, eol) : stripped.text;
  }
  let changed = stripped !== undefined;

  const lines = scanTomlLines(working);
  const mainLi = lines.findIndex((l) => l.header !== undefined && !l.header.array && l.header.name === TYCOON_TABLE_NAME);
  if (mainLi !== -1) {
    let endLi = lines.length - 1;
    for (let li = mainLi + 1; li < lines.length; li++) {
      const h = lines[li].header;
      if (h && !(h.name.startsWith(TYCOON_TABLE_NAME + ".") && !h.array)) {
        endLi = li - 1;
        break;
      }
    }
    const regionText = working.slice(lines[mainLi].start, lines[endLi].next);
    if (regionText.includes(DISPATCHER_SCRIPT_BASENAME)) {
      // Our own table sitting outside the markers (e.g. stale path): drop it
      // and append the managed block with current values instead.
      const before = working.slice(0, lines[mainLi].start);
      const rest = dropTycoonTables(working, lines, mainLi, endLi, true, new Set());
      working = collapseBlankRunAt(before + rest + working.slice(lines[endLi].next), before.length, eol);
      changed = true;
    } else {
      return {
        text: working,
        warnings: [
          "config.toml already has a [mcp_servers.tycoon] table outside the tycoon-dispatcher managed block; left it untouched.",
        ],
      };
    }
  }

  const t = changed && working.trim() !== "" ? working.replace(/\s+$/, "") + eol : working;
  const isEffectivelyEmpty = t.trim() === "";
  const separator = !isEffectivelyEmpty && !t.endsWith("\n") ? eol : "";
  const blank = !isEffectivelyEmpty ? eol : "";
  const prefix = isEffectivelyEmpty ? "" : t;
  return { text: `${prefix}${separator}${blank}${block}${eol}` };
}

/**
 * Remove the managed dispatcher block from config.toml text. Only the marker
 * lines and our own tables go; other tables that ended up between the markers
 * stay. Returns the SAME string reference when there was nothing to remove.
 */
export function removeDispatcherFromConfigToml(existing: string): string {
  const withoutBlock = removeManagedDispatcherBlock(existing);
  const lines = scanTomlLines(withoutBlock);
  const tycoonLi = lines.findIndex((l) => l.header !== undefined && isTycoonTableName(l.header.name));
  if (tycoonLi === -1) return withoutBlock;
  // The `mcp_servers.tycoon` namespace is ours: Codex may have moved the main
  // table or its tools.* approvals outside the markers, so remove every such
  // table. A main table the user wrote themselves (no marker block, no
  // reference to our script) is left alone.
  const mainLi = lines.findIndex((l) => l.header !== undefined && !l.header.array && l.header.name === TYCOON_TABLE_NAME);
  const hadBlock = withoutBlock !== existing;
  if (mainLi !== -1 && !hadBlock) {
    let endLi = lines.length - 1;
    for (let li = mainLi + 1; li < lines.length; li++) {
      const h = lines[li].header;
      if (h && !isTycoonTableName(h.name)) {
        endLi = li - 1;
        break;
      }
    }
    if (!withoutBlock.slice(lines[mainLi].start, lines[endLi].next).includes(DISPATCHER_SCRIPT_BASENAME)) return withoutBlock;
  }
  const cleaned = dropTycoonTables(withoutBlock, lines, 0, lines.length - 1, false, new Set());
  const lastHeader = [...lines].reverse().find((l) => l.header !== undefined);
  // Our table ran to the end of the file: drop the blank lines that separated it.
  if (lastHeader?.header && isTycoonTableName(lastHeader.header.name)) {
    return cleaned.trim() === "" ? "" : cleaned.replace(/(?:\r?\n)*$/, detectEol(cleaned));
  }
  return cleaned;
}

function removeManagedDispatcherBlock(existing: string): string {
  const stripped = stripManagedRegion(existing, false);
  if (!stripped) return existing;
  if (!stripped.regionEmpty) return stripped.text;
  const eol = detectEol(existing);
  const beforeRaw = existing.slice(0, stripped.start);
  const afterRaw = existing.slice(stripped.end);
  // Our block is always appended after all other content, separated by a
  // blank line, so `after` is normally empty (aside from a trailing
  // newline) — strip it entirely rather than normalizing it to one newline
  // the way a mid-file removal would, or we'd leave a stray trailing blank line.
  const isEndOfFile = afterRaw.trim() === "";
  const before = beforeRaw.replace(/(?:\r?\n)+$/, eol);
  if (isEndOfFile) {
    return before === "" ? "" : before;
  }
  const after = afterRaw.replace(/^(?:\r?\n)+/, eol);
  const combined = before + after;
  return before === "" ? combined.replace(/^\r?\n/, "") : combined;
}

export interface InstallCodexDispatcherOptions {
  projectDir: string;
  env: ResolveCodexHomeEnv;
  platform?: NodeJS.Platform;
  /** Absolute path to hooks/tycoon-dispatcher-mcp.cjs. */
  serverScriptPath: string;
  /** Absolute node executable path written into the command. Defaults to resolveNodeBinary() (never the VS Code binary). */
  nodePath?: string;
}

export interface InstallCodexDispatcherResult {
  configTomlPath: string;
  warnings?: string[];
}

/**
 * Registers the tycoon-dispatcher MCP server in CODEX_HOME/config.toml.
 * Idempotent re-install replaces the managed block in place; a foreign
 * `[mcp_servers.tycoon]` table blocks the write and returns a warning
 * instead of overwriting it.
 */
export function installCodexDispatcher(options: InstallCodexDispatcherOptions): InstallCodexDispatcherResult {
  const { codexHome } = resolveCodexHome({ env: options.env, platform: options.platform });
  fs.mkdirSync(codexHome, { recursive: true });
  const configTomlPath = path.join(codexHome, "config.toml");
  const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, "utf8") : undefined;
  const nodePath = options.nodePath ?? resolveNodeBinary();
  // Never downgrade: keep an existing script path from a newer extension that still exists.
  let serverScriptPath = options.serverScriptPath;
  const existingScript = existing !== undefined ? readManagedScriptPath(existing) : undefined;
  if (existingScript !== undefined && isNewerExtensionPath(existingScript, serverScriptPath) && fs.existsSync(existingScript)) {
    serverScriptPath = existingScript;
  }
  const merged = mergeDispatcherIntoConfigToml(existing, {
    nodePath,
    serverScriptPath,
    envVarNames: unionEnvVarNames(readManagedEnvVars(existing ?? ""), dispatcherEnvVarNames(options.projectDir, { env: options.env })),
  });
  if (merged.text !== existing) writeFileAtomic(configTomlPath, merged.text);
  const warnings = [...(merged.warnings ?? []), ...(isBareNodeCommand(nodePath) ? [NODE_NOT_FOUND_WARNING] : [])];
  return { configTomlPath, ...(warnings.length ? { warnings } : {}) };
}

export interface UninstallCodexDispatcherOptions {
  env: ResolveCodexHomeEnv;
  platform?: NodeJS.Platform;
}

/** Removes only the managed dispatcher block from config.toml, leaving the rest byte-identical. */
export function uninstallCodexDispatcher(options: UninstallCodexDispatcherOptions): void {
  const { codexHome } = resolveCodexHome({ env: options.env, platform: options.platform });
  const configTomlPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configTomlPath)) return;
  const existing = fs.readFileSync(configTomlPath, "utf8");
  const stripped = removeDispatcherFromConfigToml(existing);
  if (stripped !== existing) writeFileAtomic(configTomlPath, stripped);
}

/**
 * Bounded, never-throwing check for whether config.toml carries the managed
 * dispatcher marker. Reads at most one file; any error (missing CODEX_HOME,
 * unreadable file, etc.) returns false rather than throwing. Used by
 * hooks/tycoon-codex-hook.cjs as the second signal (alongside
 * TYCOON_CODEX_DISPATCHER_CONFIGURED env) since the notify hook inherits
 * Codex's environment, not the MCP server's.
 */
export function isDispatcherMarkerInConfigToml(env: ResolveCodexHomeEnv, platform?: NodeJS.Platform): boolean {
  try {
    const { codexHome } = resolveCodexHome({ env, platform });
    const configTomlPath = path.join(codexHome, "config.toml");
    if (!fs.existsSync(configTomlPath)) return false;
    const text = fs.readFileSync(configTomlPath, "utf8");
    return text.includes(DISPATCHER_MARKER_START);
  } catch {
    return false;
  }
}

export const CODEX_DISPATCHER_STALE_MESSAGE =
  "The Codex dispatcher entry points at an old or missing TycoonAgents file, so Codex can't start it. Install again to update it.";

/** `tycoonagents.tycoonagents-<version>` folder name inside an install path, if any. */
function extensionVersionDir(p: string): string | undefined {
  const m = /[\\/](tycoonagents\.tycoonagents-[^\\/]+)[\\/]/i.exec(p);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Classify the managed dispatcher block against the script path this host
 * would install now. "none": no managed block (never installed, or only a
 * foreign table); "installed": block present and usable; "stale": the block's
 * script is missing on disk, or lives in a different TycoonAgents extension
 * version folder than the current one. A differing path that still exists and
 * is not a versioned extension folder (e.g. a standalone checkout) is left
 * alone so two hosts don't keep overwriting each other.
 */
export function detectCodexDispatcherState(
  text: string,
  currentScriptPath: string,
  fileExists: (p: string) => boolean = fs.existsSync,
  expectedEnvVars: string[] = dispatcherEnvVarNames(),
): "none" | "installed" | "stale" {
  const stripped = stripManagedRegion(text, true);
  if (!stripped) return "none";
  const region = text.slice(stripped.start, stripped.end);
  const m = /^[ \t]*args[ \t]*=[ \t]*(\[[^\r\n]*\])/m.exec(region);
  if (!m) return "stale";
  let args: unknown;
  try {
    args = JSON.parse(m[1]);
  } catch {
    return "stale";
  }
  const script = Array.isArray(args) && typeof args[0] === "string" ? args[0] : undefined;
  if (script === undefined) return "stale";
  // Codex filters the environment of stdio servers; a block that doesn't list
  // every env_vars name we expect can't see the user's keys, so refresh it.
  const ev = /^[ \t]*env_vars[ \t]*=[ \t]*(\[[^\r\n]*\])/m.exec(region);
  let forwarded: unknown;
  try {
    forwarded = ev ? JSON.parse(ev[1]) : undefined;
  } catch {
    forwarded = undefined;
  }
  if (!Array.isArray(forwarded) || !expectedEnvVars.every((n) => forwarded.includes(n))) return "stale";
  if (samePath(script, currentScriptPath)) return fileExists(script) ? "installed" : "stale";
  if (!fileExists(script)) return "stale";
  const oldDir = extensionVersionDir(script);
  const curDir = extensionVersionDir(currentScriptPath);
  // A newer extension version's path belongs to another window; leave it.
  if (isNewerExtensionPath(script, currentScriptPath)) return "installed";
  // The current script is in the stable launcher folder (no version in its path): an entry still in a versioned extension folder moves there once.
  if (oldDir !== undefined && curDir === undefined) return "stale";
  return oldDir !== undefined && curDir !== undefined && oldDir !== curDir ? "stale" : "installed";
}

/** Script path (first args element) of the managed dispatcher block, if parseable. */
function readManagedScriptPath(text: string): string | undefined {
  const stripped = stripManagedRegion(text, true);
  if (!stripped) return undefined;
  const m = /^[ \t]*args[ \t]*=[ \t]*(\[[^\r\n]*\])/m.exec(text.slice(stripped.start, stripped.end));
  if (!m) return undefined;
  try {
    const args: unknown = JSON.parse(m[1]);
    return Array.isArray(args) && typeof args[0] === "string" ? args[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Bounded, never-throwing config.toml read + detectCodexDispatcherState. */
export function readCodexDispatcherState(
  env: ResolveCodexHomeEnv,
  platform: NodeJS.Platform | undefined,
  currentScriptPath: string,
  projectDir?: string,
  expectedEnvVars?: string[],
): "none" | "installed" | "stale" {
  try {
    const { codexHome } = resolveCodexHome({ env, platform });
    const configTomlPath = path.join(codexHome, "config.toml");
    if (!fs.existsSync(configTomlPath)) return "none";
    return detectCodexDispatcherState(
      fs.readFileSync(configTomlPath, "utf8"),
      currentScriptPath,
      fs.existsSync,
      expectedEnvVars ?? dispatcherEnvVarNames(projectDir),
    );
  } catch {
    return "none";
  }
}
