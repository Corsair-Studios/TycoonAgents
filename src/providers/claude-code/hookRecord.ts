/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
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
  tier?: string;             // agent tier from .md frontmatter, e.g. "lead" (PreToolUse spawn only)
  parentId?: string;         // agentId on top of the active-agent stack at spawn time, if any
                              // (approximate — stack-based inference can misattribute concurrent spawns)
  delegationMode?: string;   // "flat" | "team_leads" — .claude/tycoon/execution.json's delegation_mode
                              // at the time this record was written (Team Lead Mode Phase 4: measurement).
                              // Absent on records from hook versions predating this field.
  sessionId?: string;        // Claude Code session id (hooks/tycoon-claude-hook.cjs: payload.session_id).
                              // Used to scope "this session" views (Delegation Health dual view). Absent on
                              // records from hook versions predating this field.
  at: number;                // epoch ms
}
