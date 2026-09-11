"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FallbackState = exports.MAX_FALLBACK_DEPTH = void 0;
exports.isProviderFailure = isProviderFailure;
exports.resolveNextFallback = resolveNextFallback;
exports.buildFallbackInstruction = buildFallbackInstruction;
// Mirrors routingProfile.ts's MAX_FALLBACK_DEPTH (also exported there for
// validateSlot's own depth check). Duplicated as a literal, not imported,
// because this module must stay zero-dependency (no fs/path pulled in via
// routingProfile.ts) — it is require()'d directly by the CommonJS hooks
// without routingProfile.js alongside it. Keep both values in sync by hand.
exports.MAX_FALLBACK_DEPTH = 3;
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
const PROVIDER_FAILURE_PATTERNS = [
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
function isProviderFailure(text) {
    if (!text || typeof text !== "string")
        return false;
    return PROVIDER_FAILURE_PATTERNS.some((re) => re.test(text));
}
function isSameSlot(a, b) {
    if (!a || !b)
        return false;
    return a.vendor === b.vendor && a.model === b.model && a.transport === b.transport;
}
function resolveNextFallback(input) {
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
        if (index >= exports.MAX_FALLBACK_DEPTH) {
            return {
                slot: null,
                index,
                exhausted: true,
                reason: `defaultFallback would exceed MAX_FALLBACK_DEPTH (${exports.MAX_FALLBACK_DEPTH})`,
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
const MAX_TRACKED_SESSIONS = 200;
class FallbackState {
    constructor() {
        this.bySession = new Map();
    }
    /** Record a failure for slotId in this session, advancing attemptsSoFar. */
    recordFailure(sessionId, slotId, chain, failedModel, reason) {
        let perSlot = this.bySession.get(sessionId);
        if (!perSlot) {
            perSlot = new Map();
            this.bySession.set(sessionId, perSlot);
            while (this.bySession.size > MAX_TRACKED_SESSIONS) {
                const oldestKey = this.bySession.keys().next().value;
                if (oldestKey === undefined)
                    break;
                this.bySession.delete(oldestKey);
            }
        }
        const existing = perSlot.get(slotId);
        const record = {
            attemptsSoFar: (existing?.attemptsSoFar ?? 0) + 1,
            chain,
            lastFailedModel: failedModel,
            lastReason: reason,
        };
        perSlot.set(slotId, record);
        return record;
    }
    /** Next model/vendor to dispatch on, or undefined if none tracked / exhausted. */
    getNext(sessionId, slotId) {
        const record = this.bySession.get(sessionId)?.get(slotId);
        if (!record)
            return undefined;
        return resolveNextFallback({ slotId, chain: record.chain, attemptsSoFar: record.attemptsSoFar - 1 });
    }
    getRecord(sessionId, slotId) {
        return this.bySession.get(sessionId)?.get(slotId);
    }
    /** Clear all tracked failures for a session (call on session end/idle-root). */
    endSession(sessionId) {
        this.bySession.delete(sessionId);
    }
    clear() {
        this.bySession.clear();
    }
}
exports.FallbackState = FallbackState;
function buildFallbackInstruction(input) {
    const providerPart = input.failedProvider ? `${input.failedProvider}/` : "";
    const failedDesc = `${providerPart}${input.failedModel ?? "unknown model"}`;
    if (input.result.exhausted || !input.result.slot) {
        return (`agent ${input.workerId} failed on provider/model ${failedDesc}: ${input.reason}. ` +
            `All fallback options for this slot are exhausted — report the failure to the user instead of retrying again.`);
    }
    const nextModel = input.result.slot.model ?? "an unspecified fallback model";
    const position = input.result.index + 1; // 1-based position within the chain
    return (`agent ${input.workerId} failed on provider/model ${failedDesc}: ${input.reason}. ` +
        `Re-dispatch the same task to ${input.workerId}; it now runs on ${nextModel} ` +
        `(fallback ${position} of ${input.chainLength}).`);
}
