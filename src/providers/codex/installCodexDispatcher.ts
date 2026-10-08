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
import { resolveCodexHome, type ResolveCodexHomeEnv } from "./installCodexHooks";
import { collapseBlankRunAt, detectEol, scanTomlLines, type TomlLine } from "./tomlScan";

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
  /** Absolute node executable path written into the command. Defaults to process.execPath. */
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
  const merged = mergeDispatcherIntoConfigToml(existing, {
    nodePath: options.nodePath ?? process.execPath,
    serverScriptPath: options.serverScriptPath,
  });
  fs.writeFileSync(configTomlPath, merged.text, "utf8");
  return { configTomlPath, ...(merged.warnings ? { warnings: merged.warnings } : {}) };
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
  if (stripped !== existing) fs.writeFileSync(configTomlPath, stripped, "utf8");
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
