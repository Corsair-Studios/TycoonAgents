/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * "Start a new chat" notice. Claude Code (and Codex) load the agent list when a
 * chat/session starts, so a chat opened before setup wrote `.claude/agents/*.md`
 * never sees the new agents. The notice fires only when setup actually wrote a
 * NEW agent file, never on a no-op heal or reinstall.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type NewChatHarness = "claude-code" | "codex";

/** Agent file names currently in `<root>/.claude/agents`; empty when the folder is missing. */
export function listAgentFiles(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, ".claude", "agents")).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/** True when `after` holds an agent file that `before` lacked. */
export function agentFilesAdded(before: readonly string[], after: readonly string[]): boolean {
  const had = new Set(before);
  return after.some((f) => !had.has(f));
}

/** The notice text for a harness. */
export function newChatNoticeText(harness: NewChatHarness): string {
  return harness === "codex"
    ? "TycoonAgents is set up. Start a new Codex session to use your agents — sessions that were already open can't see them."
    : "TycoonAgents is set up. Start a new Claude chat to use your agents — chats that were already open can't see them.";
}
