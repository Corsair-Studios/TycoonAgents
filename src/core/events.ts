/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Normalized activity event stream (see docs/DESIGN.md section 6).
// Providers translate a tool's raw activity into these provider-agnostic events.
// The state model and renderer consume ONLY these types.

export type WorkerId = string;

/** What a worker is doing, mapped from a provider's raw tool activity. */
export type ActivityKind =
  | "survey" // read / search
  | "build"  // generic edit / in-progress work
  | "haul"   // file write / large operation
  | "wire"   // external / MCP / integration call
  | "shell"; // shell / command execution

// provider/sessionId (p22-t1): identity of the harness+session that produced
// this event, so two concurrently-live harnesses (e.g. Claude Code and
// OpenCode tailing the same activity.jsonl) can never complete, overwrite, or
// misattribute each other's workers. Both are OPTIONAL and additive — every
// existing call site (host/vscode/*, older provider records) keeps compiling
// unchanged. `provider` mirrors mappingRegistry's resolved provider id (e.g.
// "claude-code", "opencode"); DEFAULT_PROVIDER_ID when a record carries none.
// `sessionId` mirrors the source record's own session id when present;
// callers that have no session concept for an event may leave it undefined
// rather than inventing "" or "unknown" — mapHookRecord below documents its
// own choice where it does default.
export type NormalizedEvent =
  | { type: "SessionStart"; at: number; provider?: string; sessionId?: string }
  // SessionStop carries the orchestrator's per-turn token delta + model (from the
  // Stop hook's transcript read) so the orchestrator row shows real token usage.
  // cacheReadTokens is a SEPARATE bucket for cache-read tokens (priced at ~0.1x
  // the model's input rate, unlike billable `tokens`); undefined on records
  // written by hook versions predating this field.
  // delegationMode (Team Lead Mode Phase 4) is the .claude/tycoon/execution.json
  // "flat"|"team_leads" value the hook read at Stop time; undefined on records
  // written by hook versions predating this field.
  | { type: "SessionStop"; at: number; tokens?: number; cacheReadTokens?: number; model?: string; delegationMode?: string; provider?: string; sessionId?: string }
  // Identity-only registration: seeds an idle roster entry without marking it active.
  | { type: "WorkerRegistered"; at: number; workerId: WorkerId; name?: string; model?: string; description?: string; provider?: string; sessionId?: string }
  // parentId/tier are approximate hierarchy telemetry (Team Lead Mode Phase 3): parentId
  // is the spawning agent inferred from the hook's active-agent stack, tier mirrors the
  // spawned agent's .md frontmatter (e.g. "lead"). Both undefined outside Team Lead Mode.
  // delegationMode (Team Lead Mode Phase 4) is the delegation topology active at spawn
  // time ("flat"|"team_leads"); undefined on legacy records — treated as "flat" by
  // computeDelegationModeStats in core/state.ts.
  | { type: "WorkerSpawned"; at: number; workerId: WorkerId; role?: string; name?: string; model?: string; description?: string; parentId?: string; tier?: string; delegationMode?: string; vendor?: string; costModelClass?: "metered" | "subscription" | "local"; fallbackOf?: string; fallbackDepth?: number; fallbackIsDefault?: boolean; provider?: string; sessionId?: string }
  | {
      type: "WorkerActivity";
      at: number;
      workerId: WorkerId;
      kind: ActivityKind;
      detail?: string;
      model?: string; // full model id, e.g. from a generic mcp/openai-compatible backend match (p2-t2)
      vendor?: string; // backend vendor, e.g. "anthropic" | "openai" | "google" (p2-t2)
      costModelClass?: "metered" | "subscription" | "local"; // (p2-t2)
      provider?: string;
      sessionId?: string;
    }
  | { type: "TaskCompleted"; at: number; workerId: WorkerId; label?: string; provider?: string; sessionId?: string }
  // report: the subagent's final assistant-message text (capped, see
  // HookRecord.report in providers/claude-code/hookRecord.ts for the exact
  // truncation/fail-open contract). Undefined on legacy records or when the
  // transcript was unavailable — never an empty string standing in for that.
  // reportChars: the report's ORIGINAL (pre-truncation) length, present iff
  // report is — lets consumers tell a short report from a truncated one.
  | { type: "WorkerStopped"; at: number; workerId: WorkerId; tokens?: number; cacheReadTokens?: number; report?: string; reportChars?: number; provider?: string; sessionId?: string; usageReported?: boolean }
  | { type: "ProviderError"; at: number; workerId?: WorkerId; message: string; provider?: string; sessionId?: string };

export type EventSink = (event: NormalizedEvent) => void;
