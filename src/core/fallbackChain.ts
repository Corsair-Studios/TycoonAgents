/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { RoutingSlot } from "./routingProfile";

// Mirrors routingProfile.ts's MAX_FALLBACK_DEPTH (also exported there for
// validateSlot's own depth check). Duplicated as a literal, not imported,
// because this module must stay zero-dependency (no fs/path pulled in via
// routingProfile.ts) — it is require()'d directly by the CommonJS hooks
// without routingProfile.js alongside it. Keep both values in sync by hand.
export const MAX_FALLBACK_DEPTH = 3;

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
  // Provider limit wordings (kept phrase-specific, never a bare "429" or
  // "overloaded", because the OpenCode host also scans successful task
  // output). Kinds match hooks/bridge-result.cjs classifyProviderError:
  // Claude Code "You've hit your weekly/session/monthly spend limit",
  // Codex "You've hit your usage limit" (quota).
  /you'?ve (?:hit|reached) your [\w -]{0,30}limit/i,
  // Anthropic API: spend/usage caps (quota), 429/529 error types.
  /enforced_spend_limit|reached your (?:api )?usage limits?|regain access on/i,
  /rate_limit_(?:error|exceeded|reached)|acceleration_limit|rate limit exceeded/i,
  /overloaded_error|engine_overloaded|repeated 529|\b529 overloaded/i,
  // OpenAI / Kimi / Qwen quota codes, Gemini's 429 wording.
  /insufficient_quota|exceeded_current_quota|resource has been exhausted/i,
  /\btoo many requests\b|sending requests too quickly/i,
  /\bThrottling(?:\.\w+)?:|"code"\s*:\s*"Throttling/,
  // Billing: Anthropic credit balance, OpenRouter 402, DashScope Arrearage.
  /billing_error|credit balance is (?:too )?low|insufficient credits|\b402 payment required|\bArrearage\b/i,
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
  /** p25-t2: routing.json's top-level `defaultFallback` (see
   *  routingProfile.ts). Used ONLY when `chain` is undefined/empty — a
   *  slot with its own explicit `fallback` (even a one-entry chain) is left
   *  completely unchanged. An empty `fallback: []` is treated the same as
   *  "no chain" and also falls back to `defaultFallback` by design. */
  defaultFallback?: RoutingSlot;
  /** p25-t3: the slot that just failed (vendor+model+transport). Any chain
   *  entry — including `defaultFallback` — that resolves to the exact same
   *  vendor+model+transport is skipped, so a default equal to the failing
   *  slot is never retried in a self-loop. */
  failingSlot?: Pick<RoutingSlot, "vendor" | "model" | "transport">;
  /** p31-t1: per-slot switch — routing.json's `RoutingSlot.useDefaultFallback`.
   *  Defaults to true (same as the field being absent on the slot itself)
   *  so existing callers that never pass this keep today's behavior. Set
   *  false to skip `defaultFallback` entirely for this slot, even once its
   *  own `chain` is exhausted. */
  useDefaultFallback?: boolean;
}

export interface ResolveNextFallbackResult {
  slot: RoutingSlot | null;
  index: number;
  exhausted: boolean;
  /** p32-t2: true when `slot` came from `defaultFallback` (the routing-level
   *  default) rather than the slot's own explicit `chain`. False when `slot`
   *  came from the chain, and false/absent when `slot` is null. */
  isDefault?: boolean;
  /** Set only when `exhausted` is true AND a defaultFallback existed but
   *  was declined — explains why (useDefaultFallback:false, no
   *  defaultFallback configured, depth cap reached, or the default
   *  duplicates an already-attempted slot). Never set on a successful
   *  resolution or on a plain "nothing configured at all" exhaustion. */
  reason?: string;
}

function isSameSlot(
  a: Pick<RoutingSlot, "vendor" | "model" | "transport"> | undefined,
  b: Pick<RoutingSlot, "vendor" | "model" | "transport"> | undefined
): boolean {
  if (!a || !b) return false;
  return a.vendor === b.vendor && a.model === b.model && a.transport === b.transport;
}

export function resolveNextFallback(input: ResolveNextFallbackInput): ResolveNextFallbackResult {
  const chain = Array.isArray(input.chain) ? input.chain : [];
  const index = input.attemptsSoFar;

  // 1) Walk the explicit chain first, unchanged from before p31-t1: an
  //    author-written `fallback` array is positionally indexed by
  //    attemptsSoFar across successive calls, so nothing here filters it.
  if (index >= 0 && index < chain.length) {
    return { slot: chain[index], index, exhausted: false, isDefault: false };
  }

  // 2) p31-t1: the explicit chain is exhausted (or was empty/absent to
  //    start with) — fall through to the profile's top-level
  //    `defaultFallback`, once, unless the slot opted out.
  if (index === chain.length) {
    const useDefault = input.useDefaultFallback !== false;
    if (!useDefault) {
      return { slot: null, index, exhausted: true, reason: "useDefaultFallback is false for this slot" };
    }
    if (!input.defaultFallback) {
      return { slot: null, index, exhausted: true, reason: "no defaultFallback configured on the profile" };
    }
    // Overall depth stays capped by MAX_FALLBACK_DEPTH — the default counts
    // as one more step. If the explicit chain already used up the full
    // depth (index === MAX_FALLBACK_DEPTH), the default does not fire.
    if (index >= MAX_FALLBACK_DEPTH) {
      return {
        slot: null,
        index,
        exhausted: true,
        reason: `defaultFallback would exceed MAX_FALLBACK_DEPTH (${MAX_FALLBACK_DEPTH})`,
      };
    }
    // p25-t3 self-loop guard, generalized: skip a defaultFallback equal to
    // the slot that just failed, or to any chain entry already attempted
    // (i.e. any member of the now-exhausted explicit chain).
    const duplicatesFailingSlot = isSameSlot(input.defaultFallback, input.failingSlot);
    const duplicatesChainEntry = chain.some((entry) => isSameSlot(input.defaultFallback, entry));
    if (duplicatesFailingSlot || duplicatesChainEntry) {
      return {
        slot: null,
        index,
        exhausted: true,
        reason: "defaultFallback duplicates the failing slot or an already-attempted chain entry",
      };
    }
    return { slot: input.defaultFallback, index, exhausted: false, isDefault: true };
  }

  // 3) Anything past the (possible) default-fallback slot, or a negative
  //    index, is simply exhausted.
  return { slot: null, index, exhausted: true };
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
  // Last-resort wording (p99-t2): no hook can re-run an agent on another
  // provider, and an agent bound directly to its own MCP server will call
  // that same server again. Agents that route through the TycoonAgents
  // dispatcher's delegate tool fall back in-process and never reach this text.
  return (
    `agent ${input.workerId} failed on provider/model ${failedDesc}: ${input.reason}. ` +
    `Re-dispatch the same task to ${input.workerId}; the next provider in its fallback chain is ${nextModel} ` +
    `(fallback ${position} of ${input.chainLength}). ` +
    `This only takes effect if ${input.workerId} reaches that provider through the TycoonAgents dispatcher (mcp__tycoon__delegate); ` +
    `an agent bound directly to its own MCP server calls the same provider again, so if it fails the same way, report the failure instead of retrying.`
  );
}
