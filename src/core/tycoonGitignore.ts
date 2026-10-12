/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Keeps per-user GENERATED TycoonAgents files out of git. One managed block in
// <root>/.gitignore, written only when the project is a git repo (a .git entry
// exists), never creating a .gitignore for a non-git folder, never removing a
// user line, idempotent. Shared project files (plan.json, plans/, routing.json,
// agent-keywords.json, execution.json, team-setup-applied.json, skills, agents,
// CLAUDE.md, .mcp.json, settings.json) are deliberately NOT listed.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { MCP_BRIDGE_HOOK_FILES, RUNTIME_HOOK_FILES } from "../host/vscode/hookInstall";

export const GITIGNORE_BEGIN = "# >>> TycoonAgents generated files (managed block, safe to keep) >>>";
export const GITIGNORE_END = "# <<< TycoonAgents generated files <<<";

/** Generated runtime state under .claude/tycoon/ (per user/machine; the rest is shared on purpose). */
const TYCOON_STATE_FILES: ReadonlyArray<string> = [
  "activity.jsonl",
  "hook-last-event.json",
  "hooks-changed.json",
  "hook-slots.json",
  "active-agent.json",
  "active-agent.json.lock",
  "active-agent-codex.json",
  "gate-events.jsonl",
  "gate-events.cursor",
  "gate-events.codex.cursor",
  "orchestrator-token-state.json",
  "orchestrator-turn-reads.json",
  "pack-staging.json",
  "routing.resolved.json",
  "routing-applied.json",
  "codex-agents.toml.generated",
  "package.json",
];

/** The exact ignore lines, in order. */
export function tycoonGitignoreEntries(): string[] {
  const hookCopies = [...new Set(MCP_BRIDGE_HOOK_FILES)].sort().map((f) => `.claude/hooks/${f}`);
  const runtime = [...new Set(RUNTIME_HOOK_FILES)].map((f) => `.claude/tycoon/${f}`);
  const state = TYCOON_STATE_FILES.map((f) => `.claude/tycoon/${f}`);
  return [...hookCopies, ...runtime, ...state, ".claude/tycoon/*.bak", ".claude/tycoon/*.bak.*"];
}

export function renderTycoonGitignoreBlock(): string {
  return [GITIGNORE_BEGIN, ...tycoonGitignoreEntries(), GITIGNORE_END].join("\n");
}

export type GitignoreOutcome = "no-git" | "unchanged" | "written" | "error";

/** Ensure the managed block exists and is current. Never throws. */
export function ensureTycoonGitignore(root: string): GitignoreOutcome {
  try {
    if (!root || !fs.existsSync(path.join(root, ".git"))) return "no-git";
    const file = path.join(root, ".gitignore");
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) return "error";
    const existing = st ? fs.readFileSync(file, "utf8") : "";
    const block = renderTycoonGitignoreBlock();
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    const b = existing.indexOf(GITIGNORE_BEGIN);
    const e = b === -1 ? -1 : existing.indexOf(GITIGNORE_END, b);
    let next: string;
    if (b !== -1 && e !== -1) {
      const end = e + GITIGNORE_END.length;
      next = existing.slice(0, b) + block.split("\n").join(eol) + existing.slice(end);
    } else {
      const sep = existing.length === 0 ? "" : (existing.endsWith("\n") ? eol : eol + eol);
      next = existing + sep + block.split("\n").join(eol) + eol;
    }
    if (next === existing) return "unchanged";
    fs.writeFileSync(file, next);
    return "written";
  } catch {
    return "error";
  }
}
