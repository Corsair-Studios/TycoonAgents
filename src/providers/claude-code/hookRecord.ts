/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

export type ClaudeHookEventName = "UserPromptSubmit" | "PreToolUse" | "SubagentStop" | "Stop";

/** One JSON line the hook script appends to the activity IPC file. Our contract, not Claude's raw schema. */
export interface HookRecord {
  event: ClaudeHookEventName;
  tool?: string;             // PreToolUse only, e.g. "Task", "Read", "mcp__server__tool"
  workerId?: string;         // resolved agent id (or session id fallback)
  tokens?: number;           // SubagentStop only: total tokens consumed by the subagent session
  model?: string;            // full model id resolved at spawn time, e.g. "claude-sonnet-4-6"
  agentDescription?: string; // description from agent .md frontmatter, if found
  at: number;                // epoch ms
}
