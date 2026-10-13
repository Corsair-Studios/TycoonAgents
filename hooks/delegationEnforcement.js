"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Shared, pure delegation-enforcement decision logic used by BOTH
 * hooks/tycoon-claude-hook.cjs (Claude Code) and hooks/tycoon-opencode-plugin.ts
 * (OpenCode), so routing/enforcement behavior stays effective regardless of
 * which host is running. Zero I/O, zero dependencies — every function here
 * takes plain data in and returns plain data out, so it is unit-testable
 * without either host present (see decideToolCall/decideSpawn/
 * matchAgentFromKeywords below).
 *
 * This module is the SOURCE OF TRUTH for the matching/decision algorithms.
 * hooks/tycoon-claude-hook.cjs keeps its own inline copies for these
 * algorithms (it is a standalone zero-dep .cjs shipped independently of
 * out/, and must keep working even when out/ hasn't been built) — the hook
 * and this module are kept in lockstep by parity tests under test/ asserting
 * byte-identical outputs for the same inputs. Compiled by tsc to
 * out/src/core/delegationEnforcement.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEAF_WORKER_DENY_MESSAGE = void 0;
exports.matchAgentFromKeywords = matchAgentFromKeywords;
exports.decideDirectToolCall = decideDirectToolCall;
exports.decideSpawn = decideSpawn;
exports.startReviewGate = startReviewGate;
exports.advanceReviewGate = advanceReviewGate;
exports.isReviewGateTerminal = isReviewGateTerminal;
exports.decideToolCall = decideToolCall;
function isBadKeywordSegment(seg) {
    return seg.includes("**") || seg.length > 80 || seg.split(/\s+/).filter(Boolean).length > 6;
}
function matchAgentFromKeywords(searchText, keywordsConfig) {
    if (!keywordsConfig || !keywordsConfig.agents)
        return null;
    const words = new Set(searchText
        .toLowerCase()
        .replace(/[^a-z0-9]/g, " ")
        .split(/\s+/)
        .filter(Boolean));
    let bestAgent = null;
    let bestScore = 0;
    let bestKeyword = "";
    for (const [agentId, cfg] of Object.entries(keywordsConfig.agents)) {
        if (!cfg || typeof cfg.pattern !== "string" || !cfg.pattern)
            continue;
        if (cfg.pattern.trim() === "")
            continue;
        let score = 0;
        let firstMatch = "";
        for (const kw of cfg.pattern.split("|")) {
            const norm = kw.toLowerCase().trim();
            if (!norm || isBadKeywordSegment(norm))
                continue;
            if (words.has(norm)) {
                score++;
                if (!firstMatch)
                    firstMatch = kw;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestAgent = agentId;
            bestKeyword = firstMatch;
        }
    }
    return bestScore > 0 && bestAgent ? { agentId: bestAgent, matchedKeyword: bestKeyword } : null;
}
/**
 * Decide what should happen when a DIRECT (non-delegated) tool call is made
 * by the orchestrator itself (never called for a spawned worker — workers
 * are leaves and are supposed to call these tools directly).
 *
 * This is advisory ("nudge"), matching tycoon-claude-hook.cjs's own
 * computeComplianceNudge: Grep/Glob/Edit/Write always nudge, Read nudges only
 * from the 3rd direct read in a turn onward (readCountSoFar is the count
 * BEFORE this call; the function returns the incremented count to persist).
 * Never returns "deny" — Claude Code enforcement here is a warning, not a
 * block; a host that wants to enforce harder can escalate "nudge" to "deny"
 * itself.
 */
function decideDirectToolCall(toolName, readCountSoFar) {
    if (toolName === "Grep" || toolName === "Glob") {
        return {
            action: "nudge",
            message: `${toolName} ran directly on the orchestrator. Searches belong to search-retrieval (Haiku) — cheaper, and the work stays visible in the delegation view.`,
        };
    }
    if (toolName === "Edit" || toolName === "Write") {
        return {
            action: "nudge",
            message: `${toolName} ran directly on the orchestrator. File changes belong to a specialist (coding-specialist) — the orchestrator coordinates, it does not implement.`,
        };
    }
    if (toolName === "Read") {
        const nextCount = readCountSoFar + 1;
        if (nextCount >= 3) {
            return {
                action: "nudge",
                message: `That is ${nextCount} direct reads this turn — this is becoming a survey, not a known-path lookup. Multi-file reading belongs to search-retrieval (Haiku).`,
                nextReadCount: nextCount,
            };
        }
        return { action: "allow", nextReadCount: nextCount };
    }
    return { action: "allow" };
}
exports.LEAF_WORKER_DENY_MESSAGE = "Blocked: you are a leaf worker — workers do not spawn sub-agents. Do the work yourself with your own tools, chunked into bounded sequential calls if it is long (see your brief). This block is structural (TycoonAgents leaf-worker rule).";
function decideSpawn(ctx) {
    if (!ctx.spawnerAgentId)
        return { action: "allow" }; // orchestrator — never denied
    const spawnerIsLead = ctx.delegationMode === "team_leads" && ctx.spawnerIsLead;
    if (spawnerIsLead)
        return { action: "allow" };
    return { action: "deny", message: exports.LEAF_WORKER_DENY_MESSAGE };
}
function startReviewGate() {
    return { status: "awaiting_review", reviewsRun: 0 };
}
/**
 * Advance the review-gate state machine given the auditor's verdict.
 * approved=true at any point -> "approved" (terminal).
 * approved=false on the FIRST review -> "changes_requested" (one fix round allowed).
 * approved=false on the SECOND review (after the fix round) -> "done_after_one_round"
 *   (terminal — report the outcome, do not cycle further, per the single-pass doctrine).
 */
function advanceReviewGate(state, approved) {
    const reviewsRun = state.reviewsRun + 1;
    if (approved)
        return { status: "approved", reviewsRun };
    if (reviewsRun >= 2)
        return { status: "done_after_one_round", reviewsRun };
    return { status: "changes_requested", reviewsRun };
}
function isReviewGateTerminal(state) {
    return state.status === "approved" || state.status === "done_after_one_round";
}
function decideToolCall(ctx) {
    if (ctx.isSpawnTool && ctx.spawn) {
        return decideSpawn(ctx.spawn);
    }
    return decideDirectToolCall(ctx.toolName, ctx.readCountSoFar ?? 0);
}
