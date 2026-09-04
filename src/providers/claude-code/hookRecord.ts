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
  cacheReadTokens?: number;  // SubagentStop/Stop: cache-read tokens, tracked separately from `tokens`
                              // because they price at ~0.1x the model's input rate rather than full rate.
  model?: string;            // full model id resolved at spawn time, e.g. "claude-sonnet-4-6"
  vendor?: string;           // backend vendor from agentBackend.ts (e.g. "anthropic", "openai", "google")
                              // for a generic mcp/openai-compatible backend match (p2-t2). Absent on
                              // records from hook versions predating generic backend routing.
  costModelClass?: "metered" | "subscription" | "local"; // from agentBackend.ts's Backend.costModelClass,
                              // set alongside `vendor` (p2-t2). Absent on older records.
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
  fallbackOf?: string;       // PreToolUse Task/SubagentStop only: originally assigned slot id (agent id) when
                              // this dispatch is a fallback re-dispatch, per FallbackState (src/core/fallbackChain.ts).
                              // Absent (never present as any falsy value) on non-fallback records.
  fallbackDepth?: number;    // 1-based index into the fallback chain for this dispatch. Present iff fallbackOf is.
  report?: string;           // SubagentStop only: the subagent's final assistant-message text, extracted
                              // from its transcript (lastAssistantTextFromTranscript in the hook script).
                              // Capped at ~2000 chars with an explicit "… [truncated]" suffix when longer;
                              // OPTIONAL and absent (never an empty string) when the transcript was
                              // missing/unreadable or had no assistant prose to extract. Absent on records
                              // from hook versions predating this field.
  at: number;                // epoch ms
}
