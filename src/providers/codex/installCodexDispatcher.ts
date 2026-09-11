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
// No secret values are written to config.toml: only TYCOON_PROJECT_DIR and
// TYCOON_CODEX_DISPATCHER_CONFIGURED go into the managed `env` map.
// CLAUDE_CLI_*/OPENAI_COMPAT_* secrets are read by the server itself from
// the process environment it is launched with.

import * as fs from "fs";
import * as path from "path";
import { resolveCodexHome, type ResolveCodexHomeEnv } from "./installCodexHooks";

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
  projectDir: string;
}

/** Build the managed `[mcp_servers.tycoon]` block text (without surrounding blank-line separators). */
export function buildDispatcherBlock(options: BuildDispatcherBlockOptions): string {
  const env = {
    TYCOON_PROJECT_DIR: options.projectDir,
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

/**
 * Find the byte index of a foreign (non-managed) `[mcp_servers.tycoon]`
 * table header line in `textWithoutManagedBlock` — i.e. one that exists
 * outside our own marker pair. Matches the header line exactly (ignoring
 * surrounding whitespace), which is sufficient to detect a real conflicting
 * table since TOML table headers must appear at the start of a line.
 */
function findForeignDispatcherTableIndex(textWithoutManagedBlock: string): number {
  const re = /^[ \t]*\[mcp_servers\.tycoon\][ \t]*$/m;
  const m = re.exec(textWithoutManagedBlock);
  return m ? m.index : -1;
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
 * own stale managed block, if any) and a warning is returned.
 */
export function mergeDispatcherIntoConfigToml(
  existing: string | undefined,
  options: BuildDispatcherBlockOptions,
): MergeDispatcherResult {
  const block = buildDispatcherBlock(options);
  const text = existing ?? "";

  const startIdx = text.indexOf(DISPATCHER_MARKER_START);
  const endIdx = text.indexOf(DISPATCHER_MARKER_END);
  const hasManagedBlock = startIdx !== -1 && endIdx !== -1 && endIdx > startIdx;

  const withoutManaged = hasManagedBlock
    ? text.slice(0, startIdx) + text.slice(endIdx + DISPATCHER_MARKER_END.length)
    : text;

  const warnings: string[] = [];
  const foreignIdx = findForeignDispatcherTableIndex(withoutManaged);
  if (foreignIdx !== -1) {
    warnings.push(
      "config.toml already has a [mcp_servers.tycoon] table outside the tycoon-dispatcher managed block; left it untouched.",
    );
    const cleaned = withoutManaged.replace(/\n{3,}/g, "\n\n");
    return { text: cleaned, warnings };
  }

  const t = withoutManaged;
  const isEffectivelyEmpty = t.trim() === "";
  const separator = !isEffectivelyEmpty && !t.endsWith("\n") ? "\n" : "";
  const blank = !isEffectivelyEmpty ? "\n" : "";
  const prefix = isEffectivelyEmpty ? "" : t;
  return { text: `${prefix}${separator}${blank}${block}\n`, warnings: warnings.length ? warnings : undefined };
}

/** Remove exactly the managed dispatcher block (and nothing else) from config.toml text. Returns the SAME string reference when there was nothing to remove. */
export function removeDispatcherFromConfigToml(existing: string): string {
  const startIdx = existing.indexOf(DISPATCHER_MARKER_START);
  const endIdx = existing.indexOf(DISPATCHER_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return existing;
  const beforeRaw = existing.slice(0, startIdx);
  const afterRaw = existing.slice(endIdx + DISPATCHER_MARKER_END.length);
  // Our block is always appended after all other content, separated by a
  // blank line, so `after` is normally empty (aside from a trailing
  // newline) — strip it entirely rather than normalizing it to "\n" the
  // way a mid-file removal would, or we'd leave a stray trailing blank line.
  const isEndOfFile = afterRaw.trim() === "";
  const before = beforeRaw.replace(/\n+$/, "\n");
  if (isEndOfFile) {
    return before === "" ? "" : before;
  }
  const after = afterRaw.replace(/^\n+/, "\n");
  const combined = (before + after).replace(/\n{3,}/g, "\n\n");
  return before === "" ? combined.replace(/^\n/, "") : combined;
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
    projectDir: options.projectDir,
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
