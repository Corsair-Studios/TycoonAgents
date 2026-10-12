/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

export type ClaudeHookEventName = "UserPromptSubmit" | "PreToolUse" | "SubagentStop" | "Stop" | "ProviderError" | "StopFailure" | "CodexSandboxUnavailable";

/** One JSON line the hook script appends to the activity IPC file. Our contract, not Claude's raw schema. */
export interface HookRecord {
  event: ClaudeHookEventName;
  provider?: string;         // (p22-t1) harness id, e.g. "claude-code" | "opencode". Absent on
                              // records from hook versions predating multi-provider support —
                              // mapHookRecord defaults it to mappingRegistry's DEFAULT_PROVIDER_ID
                              // ("claude-code") in that case, matching mappingRegistry.resolveProviderId's
                              // own fallback so a legacy record's provider tag is never ambiguous.
  userPrompt?: boolean;      // UserPromptSubmit/Stop: set by the hooks on a person-initiated top-level prompt/turn (never a
                              // subagent or bridge child); the panel uses it for the harness-mismatch hint only.
  tool?: string;             // PreToolUse only, e.g. "Task", "Read", "mcp__server__tool"
  workerId?: string;         // resolved agent id (or session id fallback)
  tokens?: number;           // SubagentStop only: total tokens consumed by the subagent session
  ok?: boolean;              // SubagentStop (codex dispatcher): true on success, false on failure.
  usageReported?: boolean;   // SubagentStop only: true when `tokens` came from real vendor-reported
                              // usage counts (e.g. claude -p json's usage block, an OpenAI-compatible
                              // chat-completions response's usage field), false when the dispatch
                              // succeeded without any vendor-reported usage (tokens absent/estimated).
                              // Absent on records from hook versions predating this field — callers
                              // should treat absent as true for the native Claude Code path, where
                              // tokens have always been real transcript-derived counts.
  cacheReadTokens?: number;  // SubagentStop/Stop: cache-read tokens, tracked separately from `tokens`
                              // because they price at ~0.1x the model's input rate rather than full rate.
  model?: string;            // full model id resolved at spawn time, e.g. "claude-sonnet-4-6"
  vendor?: string;           // backend vendor from agentBackend.ts (e.g. "anthropic", "openai", "google")
                              // for a generic mcp/openai-compatible backend match (p2-t2). Absent on
                              // records from hook versions predating generic backend routing.
  costModelClass?: "metered" | "subscription" | "local"; // from agentBackend.ts's Backend.costModelClass,
                              // set alongside `vendor` (p2-t2). Absent on older records.
  agentDescription?: string; // description from agent .md frontmatter, if found
  description?: string;     // PreToolUse (Task) only: the SPAWN's own toolInput.description (the
                              // task brief text, e.g. "Review vendor-pure savings change") — distinct
                              // from agentDescription above, which is the agent's static .md frontmatter
                              // description. Mapped onto WorkerSpawned as `currentDescription` so the
                              // panel can show what THIS instance was actually asked to do.
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
  fallbackModel?: string;    // Cross-agent re-dispatch only: model of the chain slot that was re-dispatched to.
  fallbackIsDefault?: boolean; // p32-t2: true when the fallback resolved to the routing-level defaultFallback
                              // rather than the slot's own chain entry. Absent/false on pre-p32-t2 records.
  report?: string;           // SubagentStop only: the subagent's final assistant-message text, extracted
                              // from its transcript (lastAssistantTextFromTranscript in the hook script).
                              // p21-t8: capped at 600 chars (capReportText in the hook script) at a
                              // codepoint-safe boundary, with an appended " …[truncated N chars]" suffix
                              // when longer. This IS what the panel/standalone UI shows — there is no
                              // separate transient full-text path, the UI reads this field straight off
                              // the persisted record. OPTIONAL and absent (never an empty string) when the
                              // transcript was missing/unreadable or had no assistant prose to extract.
                              // Absent on records from hook versions predating this field.
  reportChars?: number;      // SubagentStop only: the ORIGINAL (pre-truncation) character length of the
                              // extracted report text, so a genuinely short report can be distinguished
                              // from one truncated to fit the 600-char cap. Present iff `report` is.
  spawnId?: string;          // PreToolUse (Task)/SubagentStop only: per-spawn instance id, generated at
                              // push time in the hook script (generateSpawnId) — distinct from Claude
                              // Code's own payload.agent_id, which binds lazily. Lets the panel track
                              // multiple concurrent live spawns of the SAME agentId separately instead
                              // of collapsing them into one card. Absent on records from hook versions
                              // predating this field.
  roleInferred?: boolean;    // PreToolUse (Task) only: true when workerId was resolved via keyword
                              // scoring (routingMethod "keyword" in the hook script) rather than an
                              // explicit agent name/subagent_type match — i.e. the spawn's subagent_type
                              // was a built-in (general-purpose/Explore) and the agent was guessed from
                              // description/prompt text. Absent/false otherwise.
  reason?: string;           // ProviderError only: short machine reason code, e.g. "specialist-unavailable"
                              // (hooks/codexRouting.cjs's resolveCodexSpecialist vendor gate). Combined with
                              // `workerId`/`model` by mapHookRecord into the NormalizedEvent's `message`.
  message?: string;          // ProviderError only: free-form message, used verbatim as the NormalizedEvent's
                              // `message` when present, else derived from `reason`/workerId/model.
  resetHint?: string;        // StopFailure (orchestrator) only: short human reset text, e.g. "resets 3pm"
  resetAt?: number;          // StopFailure (orchestrator) only: parsed reset instant (epoch ms), when parseable
  at: number;                // epoch ms
  // StopFailure (a turn killed by an API error) reuses workerId/spawnId/model/message/reason above:
  // workerId "orchestrator" = the main session itself hit the error (never a fallback trigger).
}
