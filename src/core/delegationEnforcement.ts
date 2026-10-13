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

// ---------------------------------------------------------------------------
// Keyword-based agent matching (mirrors tycoon-claude-hook.cjs's
// matchAgentFromKeywords exactly).
// ---------------------------------------------------------------------------

export interface AgentKeywordsConfig {
  fallback_agent?: string;
  agents?: Record<string, { pattern?: string }>;
}

export interface KeywordMatch {
  agentId: string;
  matchedKeyword: string;
}

function isBadKeywordSegment(seg: string): boolean {
  return seg.includes("**") || seg.length > 80 || seg.split(/\s+/).filter(Boolean).length > 6;
}

export function matchAgentFromKeywords(
  searchText: string,
  keywordsConfig: AgentKeywordsConfig | null | undefined
): KeywordMatch | null {
  if (!keywordsConfig || !keywordsConfig.agents) return null;
  const words = new Set(
    searchText
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
  let bestAgent: string | null = null;
  let bestScore = 0;
  let bestKeyword = "";
  for (const [agentId, cfg] of Object.entries(keywordsConfig.agents)) {
    if (!cfg || typeof cfg.pattern !== "string" || !cfg.pattern) continue;
    if (cfg.pattern.trim() === "") continue;
    let score = 0;
    let firstMatch = "";
    for (const kw of cfg.pattern.split("|")) {
      const norm = kw.toLowerCase().trim();
      if (!norm || isBadKeywordSegment(norm)) continue;
      if (words.has(norm)) {
        score++;
        if (!firstMatch) firstMatch = kw;
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

// ---------------------------------------------------------------------------
// Direct-tool-call compliance decision (orchestrator-only). Mirrors
// tycoon-claude-hook.cjs's computeComplianceNudge, but as a PURE function:
// the read-counter is passed in/out instead of touched on disk, so callers
// (the hook, the plugin, and tests) own persistence themselves.
// ---------------------------------------------------------------------------

export type ToolCallAction = "allow" | "nudge" | "deny";

export interface ToolCallDecision {
  action: ToolCallAction;
  message?: string;
  /** Present only for a Read decision: the counter value to persist for the
   *  rest of this turn (mirrors readOrchestratorTurnReads/writeOrchestratorTurnReads). */
  nextReadCount?: number;
}

/** Inputs for {@link resolveEditTargetAgent}: the project's installed agent ids, whether it is a Verse/UEFN project, and its configured fallback agent. */
export interface EditTargetInputs {
  agentIds: readonly string[];
  hasVerseProject: boolean;
  fallbackAgent?: string;
}

/**
 * Which specialist the "File changes belong to a specialist" nudge names:
 * coding-specialist when installed; else verse-expert in a Verse/UEFN project
 * that has it; else the project's `fallback_agent` (default primary-agent).
 * The Claude hook mirrors this ladder (computeComplianceNudge).
 */
export function resolveEditTargetAgent(inputs: EditTargetInputs): string {
  if (inputs.agentIds.includes("coding-specialist")) return "coding-specialist";
  if (inputs.hasVerseProject && inputs.agentIds.includes("verse-expert")) return "verse-expert";
  return inputs.fallbackAgent || "primary-agent";
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
export function decideDirectToolCall(toolName: string, readCountSoFar: number, editTarget: string = "coding-specialist"): ToolCallDecision {
  if (toolName === "Grep" || toolName === "Glob") {
    return {
      action: "nudge",
      message: `${toolName} ran directly on the orchestrator. Searches belong to search-retrieval (Haiku) — cheaper, and the work stays visible in the delegation view.`,
    };
  }
  if (toolName === "Edit" || toolName === "Write") {
    return {
      action: "nudge",
      message: `${toolName} ran directly on the orchestrator. File changes belong to a specialist (${editTarget}) — the orchestrator coordinates, it does not implement.`,
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

// ---------------------------------------------------------------------------
// Leaf-worker spawn guard. Mirrors tycoon-claude-hook.cjs's inline guard in
// its PreToolUse/isSpawn branch (~line 1183 onward): a worker that is not the
// orchestrator and not a team-lead (tier: lead, only meaningful in
// team_leads mode) must never spawn a further sub-agent.
// ---------------------------------------------------------------------------

export interface SpawnGuardContext {
  /** Non-empty only when this call originates inside a spawned sub-agent
   *  (absent/empty means "this is the orchestrator itself" — never denied). */
  spawnerAgentId: string;
  /** The spawner's own agent/subagent type, used to look up its tier. */
  spawnerAgentType: string;
  delegationMode: "flat" | "team_leads" | string;
  /** True when spawnerAgentType's frontmatter declares `tier: lead` — only
   *  consulted in team_leads mode, matching the hook's own gate. */
  spawnerIsLead: boolean;
}

export const LEAF_WORKER_DENY_MESSAGE =
  "Blocked: you are a leaf worker — workers do not spawn sub-agents. Do the work yourself with your own tools, chunked into bounded sequential calls if it is long (see your brief). This block is structural (TycoonAgents leaf-worker rule).";

export function decideSpawn(ctx: SpawnGuardContext): ToolCallDecision {
  if (!ctx.spawnerAgentId) return { action: "allow" }; // orchestrator — never denied
  const spawnerIsLead = ctx.delegationMode === "team_leads" && ctx.spawnerIsLead;
  if (spawnerIsLead) return { action: "allow" };
  return { action: "deny", message: LEAF_WORKER_DENY_MESSAGE };
}

// ---------------------------------------------------------------------------
// Single review-gate (uefn-auditor pass). Mirrors CLAUDE.md's "Review pass"
// doctrine: after a specialist task, ONE review round; if changes are
// requested, ONE fix-and-recheck round; then report regardless of outcome —
// never an open-ended loop. This is state-machine bookkeeping, not I/O: the
// caller (orchestrator hook/plugin) persists ReviewGateState and calls
// advanceReviewGate on each transition.
// ---------------------------------------------------------------------------

export type ReviewGateStatus =
  | "awaiting_review" // specialist task done, review not yet run
  | "changes_requested" // uefn-auditor asked for a fix (fix round not yet done)
  | "approved" // uefn-auditor approved — done
  | "done_after_one_round"; // one fix-and-recheck round completed regardless of outcome — stop cycling

export interface ReviewGateState {
  status: ReviewGateStatus;
  /** Number of review passes already run for this task. Caps at 2 (initial
   *  review + one recheck) per the single-gate doctrine. */
  reviewsRun: number;
}

export function startReviewGate(): ReviewGateState {
  return { status: "awaiting_review", reviewsRun: 0 };
}

/**
 * Advance the review-gate state machine given the auditor's verdict.
 * approved=true at any point -> "approved" (terminal).
 * approved=false on the FIRST review -> "changes_requested" (one fix round allowed).
 * approved=false on the SECOND review (after the fix round) -> "done_after_one_round"
 *   (terminal — report the outcome, do not cycle further, per the single-pass doctrine).
 */
export function advanceReviewGate(state: ReviewGateState, approved: boolean): ReviewGateState {
  const reviewsRun = state.reviewsRun + 1;
  if (approved) return { status: "approved", reviewsRun };
  if (reviewsRun >= 2) return { status: "done_after_one_round", reviewsRun };
  return { status: "changes_requested", reviewsRun };
}

export function isReviewGateTerminal(state: ReviewGateState): boolean {
  return state.status === "approved" || state.status === "done_after_one_round";
}

// ---------------------------------------------------------------------------
// decideToolCall: single entry point unifying the three decisions above into
// one exported, unit-testable function, per the brief's acceptance criteria
// ("export the pure decision functions ... so they are unit-testable without
// OpenCode"). Hosts call the more specific functions directly when they
// already know which case applies (spawn vs. direct-tool); this wrapper
// exists for callers/tests that want one dispatch point.
// ---------------------------------------------------------------------------

export interface ToolCallContext {
  toolName: string;
  isSpawnTool: boolean;
  /** Orchestrator-only fields — ignored when a spawn/worker context applies. */
  readCountSoFar?: number;
  spawn?: SpawnGuardContext;
}

export function decideToolCall(ctx: ToolCallContext): ToolCallDecision {
  if (ctx.isSpawnTool && ctx.spawn) {
    return decideSpawn(ctx.spawn);
  }
  return decideDirectToolCall(ctx.toolName, ctx.readCountSoFar ?? 0);
}
