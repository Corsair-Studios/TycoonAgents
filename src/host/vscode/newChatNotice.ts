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

/** True when `<root>/.claude/agents` exists as a directory. */
export function agentsDirExists(root: string): boolean {
  try {
    return fs.statSync(path.join(root, ".claude", "agents")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Claude Code's file watcher only covers agent directories that existed when the
 * session started, so a brand-new `.claude/agents` needs a window reload; new files
 * in an existing directory only need a new chat.
 */
export const RELOAD_WINDOW_COMMAND = "workbench.action.reloadWindow";
export const RELOAD_WINDOW_LABEL = "Reload Window";

export interface ClaudeSetupNotice {
  kind: "reload" | "new-chat";
  message: string;
  /** Button label; present only for the reload case. */
  button?: string;
  /** Command the button runs; present only for the reload case. */
  command?: string;
  /** Short line for the panel setup status. */
  statusLine: string;
}

/** Notice for a Claude Code first-run setup, or undefined when nothing new was written. */
export function claudeSetupNotice(
  dirExistedBefore: boolean,
  before: readonly string[],
  after: readonly string[],
): ClaudeSetupNotice | undefined {
  if (!agentFilesAdded(before, after)) return undefined;
  if (!dirExistedBefore) {
    return {
      kind: "reload",
      message: "TycoonAgents is set up. Reload the window so Claude Code loads your new agents.",
      button: RELOAD_WINDOW_LABEL,
      command: RELOAD_WINDOW_COMMAND,
      statusLine: "Reload the window (Developer: Reload Window) to load your agents.",
    };
  }
  return {
    kind: "new-chat",
    message: "New agents added. Start a new Claude chat to use them.",
    statusLine: "Start a new Claude chat to use your new agents.",
  };
}

/** The notice text for a harness. */
export function newChatNoticeText(harness: NewChatHarness): string {
  return harness === "codex"
    ? "TycoonAgents is set up. Start a new Codex session to use your agents — sessions that were already open can't see them."
    : "TycoonAgents is set up. Start a new Claude chat to use your agents — chats that were already open can't see them.";
}
