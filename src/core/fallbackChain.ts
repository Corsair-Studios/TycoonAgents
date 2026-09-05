/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { RoutingSlot } from "./routingProfile";

// ---------------------------------------------------------------------------
// Plan p15-t1: shared fallback-chain resolver, consumed by BOTH hosts'
// wiring (hooks/tycoon-opencode-plugin.ts, hooks/tycoon-claude-hook.cjs).
//
// Architecture decision (already made, not re-litigated here): no hook can
// re-execute an agent on either host. "Fallback execution" is therefore
// split into (1) this pure resolver + per-session state, and (2) host wiring
// that detects a provider failure, records it, and injects an instruction
// telling the ORCHESTRATOR to re-dispatch the same task on the next chain
// entry (the model is rewritten on that re-dispatch only where the host
// exposes a mutable hook for it — see the two wiring files for how far each
// host's mechanism actually reaches).
//
// Zero dependencies; compiled by tsc to out/src/core/fallbackChain.js and
// copied into hooks/ by scripts/copy-hook-runtime.mjs (same pattern as
// delegationEnforcement.js / agentBackend.js) so both the VS Code extension
// build and the CommonJS Claude hook can require() it directly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// isProviderFailure: text patterns already documented/used, one place now.
//
// Sources (read, not duplicated):
//   - .claude/agents/codex-reviewer.md: "usage limit", "spend cap",
//     "out of credits", HTTP 401 / "Unauthorized"
//   - .claude/agents/gemini-reviewer.md: "quota", "rate limit",
//     "RESOURCE_EXHAUSTED", "401", "403", "Unauthorized"
//   - .claude/agents/kimi-reviewer.md: "OPENAI_COMPAT_BASE_URL" (base URL
//     not configured), "401", "403", "Unauthorized", "quota", "rate limit",
//     "ECONNREFUSED", "failed:"
//
// hooks/tycoon-claude-hook.cjs currently has NO provider-failure detection
// of its own (verified by reading the file — PostToolUse for mcp__* tools
// only records tool/model/vendor activity, never inspects the result body
// for failure). So there is nothing byte-identical to preserve there yet;
// the hook is wired to CALL this function (see hooks/tycoon-claude-hook.cjs
// PostToolUse addition), not to have a duplicate regex extracted out of it.
// ---------------------------------------------------------------------------
const PROVIDER_FAILURE_PATTERNS: RegExp[] = [
  /usage limit/i,
  /spend cap/i,
  /out of credits/i,
  /\bunauthorized\b/i,
  /\b401\b/,
  /\b403\b/,
  /\bquota\b/i,
  /rate limit/i,
  /RESOURCE_EXHAUSTED/i,
  /OPENAI_COMPAT_BASE_URL/,
  /ECONNREFUSED/i,
  /\bfailed:/i,
  /provider-unavailable/i,
  // p15-t1 attempt 5: OpenCode's own connection-failure wording, observed
  // live against a dead OLLAMA_BASE_URL (docs/opencode-probe-findings.md
  // "Remote VM smoke, attempt 5") — the task tool's error text and the
  // underlying session.error event both read "Cannot connect to API:
  // Unable to connect. Is the computer able to access the url?" with
  // error.name "APIError". None of the patterns above matched it.
  /cannot connect to api/i,
  /unable to connect/i,
  /\bAPIError\b/,
];

export function isProviderFailure(text: string | undefined | null): boolean {
  if (!text || typeof text !== "string") return false;
  return PROVIDER_FAILURE_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// resolveNextFallback: pure — given a slot's chain (RoutingSlot[], typically
// the failed slot's own `.fallback` array from routingProfile.ts) and how
// many attempts have already failed for this slotId, return which chain
// entry to try next.
// ---------------------------------------------------------------------------
export interface ResolveNextFallbackInput {
  slotId: string;
  chain: RoutingSlot[];
  attemptsSoFar: number;
}

export interface ResolveNextFallbackResult {
  slot: RoutingSlot | null;
  index: number;
  exhausted: boolean;
}

export function resolveNextFallback(input: ResolveNextFallbackInput): ResolveNextFallbackResult {
  const chain = Array.isArray(input.chain) ? input.chain : [];
  const index = input.attemptsSoFar;
  if (index < 0 || index >= chain.length) {
    return { slot: null, index, exhausted: true };
  }
  return { slot: chain[index], index, exhausted: false };
}

// ---------------------------------------------------------------------------
// FallbackState: per-session, per-slotId failure tracking. Bounded and
// evicted on session end, mirroring the bounded eviction pattern used by
// reviewGateByParentSession / pendingNudgesBySession in
// hooks/tycoon-opencode-plugin.ts (a Map capped at MAX_SESSIONS, oldest key
// evicted first) rather than introducing a new eviction strategy.
// ---------------------------------------------------------------------------
export interface FallbackRecord {
  attemptsSoFar: number;
  chain: RoutingSlot[];
  lastFailedModel?: string;
  lastReason?: string;
}

const MAX_TRACKED_SESSIONS = 200;

export class FallbackState {
  private bySession = new Map<string, Map<string, FallbackRecord>>();

  /** Record a failure for slotId in this session, advancing attemptsSoFar. */
  recordFailure(
    sessionId: string,
    slotId: string,
    chain: RoutingSlot[],
    failedModel?: string,
    reason?: string
  ): FallbackRecord {
    let perSlot = this.bySession.get(sessionId);
    if (!perSlot) {
      perSlot = new Map();
      this.bySession.set(sessionId, perSlot);
      while (this.bySession.size > MAX_TRACKED_SESSIONS) {
        const oldestKey = this.bySession.keys().next().value;
        if (oldestKey === undefined) break;
        this.bySession.delete(oldestKey);
      }
    }
    const existing = perSlot.get(slotId);
    const record: FallbackRecord = {
      attemptsSoFar: (existing?.attemptsSoFar ?? 0) + 1,
      chain,
      lastFailedModel: failedModel,
      lastReason: reason,
    };
    perSlot.set(slotId, record);
    return record;
  }

  /** Next model/vendor to dispatch on, or undefined if none tracked / exhausted. */
  getNext(sessionId: string, slotId: string): ResolveNextFallbackResult | undefined {
    const record = this.bySession.get(sessionId)?.get(slotId);
    if (!record) return undefined;
    return resolveNextFallback({ slotId, chain: record.chain, attemptsSoFar: record.attemptsSoFar - 1 });
  }

  getRecord(sessionId: string, slotId: string): FallbackRecord | undefined {
    return this.bySession.get(sessionId)?.get(slotId);
  }

  /** Clear all tracked failures for a session (call on session end/idle-root). */
  endSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  clear(): void {
    this.bySession.clear();
  }
}

// ---------------------------------------------------------------------------
// buildFallbackInstruction: text injected to the orchestrator (as an
// additionalContext / queued nudge, per host) telling it what to do next.
// ---------------------------------------------------------------------------
export interface BuildFallbackInstructionInput {
  workerId: string;
  failedProvider?: string;
  failedModel?: string;
  reason: string;
  result: ResolveNextFallbackResult;
  /** Total length of the fallback chain (for the "fallback N of M" text). */
  chainLength: number;
}

export function buildFallbackInstruction(input: BuildFallbackInstructionInput): string {
  const providerPart = input.failedProvider ? `${input.failedProvider}/` : "";
  const failedDesc = `${providerPart}${input.failedModel ?? "unknown model"}`;
  if (input.result.exhausted || !input.result.slot) {
    return (
      `agent ${input.workerId} failed on provider/model ${failedDesc}: ${input.reason}. ` +
      `All fallback options for this slot are exhausted — report the failure to the user instead of retrying again.`
    );
  }
  const nextModel = input.result.slot.model ?? "an unspecified fallback model";
  const position = input.result.index + 1; // 1-based position within the chain
  return (
    `agent ${input.workerId} failed on provider/model ${failedDesc}: ${input.reason}. ` +
    `Re-dispatch the same task to ${input.workerId}; it now runs on ${nextModel} ` +
    `(fallback ${position} of ${input.chainLength}).`
  );
}
