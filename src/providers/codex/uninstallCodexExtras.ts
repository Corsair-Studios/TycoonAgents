/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// The project-side leftovers of a Codex hook install that the config.toml
// uninstall does not cover: the managed block in AGENTS.md and the Codex-only
// hook scripts copied into .claude/hooks/. Both removals are conservative:
// only what TycoonAgents wrote, and nothing another install still references.

import * as fs from "fs";
import * as path from "path";
import { MCP_BRIDGE_HOOK_FILES, bridgeFilesForConfig } from "../../host/vscode/hookInstall";

const CODEX_START_MARKER = "<!-- TYCOON-CODEX-MANAGED:START -->";
const CODEX_END_MARKER = "<!-- TYCOON-CODEX-MANAGED:END -->";

/** Hook scripts that exist for Codex (the dispatcher's rollout/routing helpers and the Codex MCP bridge). */
export const CODEX_ONLY_HOOK_FILES: readonly string[] = [
  "codex-app-server-mcp.cjs",
  "codex-mcp-launcher.cjs",
  "codexRollout.cjs",
  "codexRouting.cjs",
];

const OUR_HEADER = "TycoonAgents - https://x.com/thetrashbyrd";

export interface RemoveAgentsBlockResult {
  /** True when a managed block was found and removed. */
  removed: boolean;
  /** True when the file held nothing but our block and was deleted. */
  deleted: boolean;
}

/**
 * Remove every TYCOON-CODEX-MANAGED block from `<projectDir>/AGENTS.md`. Text
 * outside the markers is kept; only the blank line the block was appended
 * behind is tidied. If nothing but whitespace is left, the file held only our
 * block (no user text can be lost), so it is deleted.
 */
export function removeCodexManagedAgentsBlock(projectDir: string): RemoveAgentsBlockResult {
  const file = path.join(projectDir, "AGENTS.md");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { removed: false, deleted: false };
  }
  const result = stripCodexBlock(text);
  if (result === text) return { removed: false, deleted: false };
  if (result.trim() === "") {
    fs.unlinkSync(file);
    return { removed: true, deleted: true };
  }
  fs.writeFileSync(file, result, "utf8");
  return { removed: true, deleted: false };
}

/** Pure form of the AGENTS.md removal. Returns the same string when there is no complete marker pair. */
export function stripCodexBlock(text: string): string {
  let out = text;
  for (;;) {
    const start = out.indexOf(CODEX_START_MARKER);
    if (start === -1) return out;
    const end = out.indexOf(CODEX_END_MARKER, start);
    if (end === -1) return out;
    let before = out.slice(0, start);
    let after = out.slice(end + CODEX_END_MARKER.length);
    if (after.trim() === "") {
      before = before.replace(/(?:\r?\n)+$/, before.trim() === "" ? "" : before.includes("\r\n") ? "\r\n" : "\n");
      out = before;
    } else {
      // The block was appended behind a blank line; drop that one separator.
      if (before.endsWith("\r\n\r\n")) before = before.slice(0, -2);
      else if (before.endsWith("\n\n")) before = before.slice(0, -1);
      after = after.replace(/^\r?\n/, "");
      out = before + (before === "" ? after.replace(/^(?:\r?\n)+/, "") : after);
    }
  }
}

export interface RemoveHookCopiesOptions {
  projectDir: string;
  /** Path of our shipped copy of a hook file, if known (an identical copy counts as ours). */
  resolveSource?: (fileName: string) => string | undefined;
}

function looksLikeOurs(filePath: string, fileName: string, resolveSource?: (f: string) => string | undefined): boolean {
  let content: Buffer;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  if (content.subarray(0, 600).toString("utf8").includes(OUR_HEADER)) return true;
  const src = resolveSource?.(fileName);
  if (src === undefined) return false;
  try {
    return content.equals(fs.readFileSync(src));
  } catch {
    return false;
  }
}

/**
 * Bridge files a server config references under ANY `.claude/hooks/` path
 * (relative, absolute, or behind a `${...}` prefix such as
 * `${CLAUDE_PROJECT_DIR}`), plus the files they require.
 */
function referencedHookFiles(config: unknown): string[] {
  if (config === null || typeof config !== "object") return [];
  const cfg = config as Record<string, unknown>;
  const out = new Set<string>();
  for (const v of [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])]) {
    if (typeof v !== "string") continue;
    const m = /(?:^|\/)\.claude\/hooks\/([^/]+)$/.exec(v.replace(/\\/g, "/"));
    if (m) for (const f of bridgeFilesForConfig({ command: ".claude/hooks/" + m[1] })) out.add(f);
  }
  return [...out];
}

/** Bridge files still referenced by the project's .mcp.json or opencode.json servers, or required by a bridge still present in .claude/hooks. */
function stillNeededHookFiles(projectDir: string): Set<string> {
  const needed = new Set<string>();
  const readJson = (p: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return undefined;
    }
  };
  const mcp = readJson(path.join(projectDir, ".mcp.json")) as { mcpServers?: Record<string, unknown> } | undefined;
  for (const server of Object.values(mcp?.mcpServers ?? {})) {
    for (const f of referencedHookFiles(server)) needed.add(f);
  }
  const oc = readJson(path.join(projectDir, "opencode.json")) as { mcp?: Record<string, unknown> } | undefined;
  for (const server of Object.values(oc?.mcp ?? {})) {
    const command = (server as { command?: unknown } | null)?.command;
    if (Array.isArray(command)) {
      for (const f of referencedHookFiles({ command: command[0], args: command.slice(1) })) needed.add(f);
    }
  }
  // A bridge copy that stays (the dispatcher, Claude-host bridges) still requires its companions.
  const hooksDir = path.join(projectDir, ".claude", "hooks");
  for (const f of MCP_BRIDGE_HOOK_FILES) {
    if (CODEX_ONLY_HOOK_FILES.includes(f) || !fs.existsSync(path.join(hooksDir, f))) continue;
    for (const dep of bridgeFilesForConfig({ command: ".claude/hooks/" + f })) needed.add(dep);
  }
  return needed;
}

/**
 * Remove the Codex-only hook copies from `<projectDir>/.claude/hooks/`. A file
 * goes only when it is ours (carries our header or matches the shipped copy)
 * and no .mcp.json / opencode.json server still needs it. Returns the removed
 * file names.
 */
export function removeOrphanCodexHookCopies(options: RemoveHookCopiesOptions): string[] {
  const hooksDir = path.join(options.projectDir, ".claude", "hooks");
  const needed = stillNeededHookFiles(options.projectDir);
  const removed: string[] = [];
  for (const fileName of CODEX_ONLY_HOOK_FILES) {
    if (needed.has(fileName)) continue;
    const filePath = path.join(hooksDir, fileName);
    if (!fs.existsSync(filePath) || !looksLikeOurs(filePath, fileName, options.resolveSource)) continue;
    try {
      fs.unlinkSync(filePath);
      removed.push(fileName);
    } catch {
      /* in use or read-only: leave it */
    }
  }
  return removed;
}
