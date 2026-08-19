/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Bounded cross-model consensus protocol (Phase 5, task p5-t1): Claude and
 * Codex exchange structured positions on a question until they agree or a
 * hard round cap trips. This is NOT the foreignReview.ts review gate — that
 * module bounds a fix-and-recheck cycle to one round over a completed
 * change; this module bounds a genuine two-party DEBATE over a question,
 * for as many rounds as {@link CONSENSUS_MAX_ROUNDS} allows, and reuses
 * foreignReview.ts's safety-argument and injected-caller patterns rather
 * than duplicating them.
 *
 * Load-bearing constraint carried from docs/provider-contract.md and
 * docs/codex-mcp-probe-findings.md Section 2: Codex session state lives
 * only inside one running `codex mcp-server` process. A `codex-reply`
 * against a `threadId` from an exited process fails in ~1ms with
 * `"Session not found for thread_id: ..."`. That failure is a PROVIDER
 * FAILURE, not a disagreement and not convergence — see
 * {@link ConsensusOutcome} and {@link isSessionNotFoundText}. This module
 * never retries a dead session into a fresh one and pretends continuity
 * held; doing so would silently restart the debate with amnesia on one
 * side, which is exactly the failure mode the contract calls out.
 *
 * This module owns four things:
 *  1. {@link CONSENSUS_MAX_ROUNDS} — the ONE named constant every round-cap
 *     check in this module (and any caller) must reference. Fixed in
 *     source, not read from config/env, so it cannot be silently disabled
 *     at runtime — matching the project's "review is bounded, never
 *     open-ended" doctrine (CLAUDE.md's "Review pass (enabled)" section)
 *     and mirroring ForeignReviewGate's structural two-round bound in
 *     foreignReview.ts.
 *  2. {@link buildConsensusRoundParams} — builds the `codex`/`codex-reply`
 *     MCP params for one round, with {@link CODEX_REVIEW_SAFETY_ARGS}-style
 *     safety arguments baked in via foreignReview.ts's own builders, so a
 *     consensus round can never omit `sandbox: "read-only"` /
 *     `approval-policy: "never"`. Round 1 uses a fresh `codex` call; every
 *     round after that uses `codex-reply` against the persisted `threadId`
 *     from round 1, sending only the new rebuttal text — never the full
 *     history again — which is both the efficiency win and the reason a
 *     dead session must be detected rather than silently patched over.
 *  3. {@link positionsMatch} / {@link runConsensusExchange} — deterministic
 *     convergence detection and the structurally-bounded round loop. See
 *     each function's doc comment for the termination and comparison
 *     rationale.
 *  4. {@link ConsensusRoundCost} / costModelClass handling — see the doc
 *     comment above {@link ConsensusRoundCost} for how the media/main.js
 *     webview-scope duplicate problem is handled.
 *
 * Like foreignReview.ts, this module is I/O-free: it never itself calls
 * the `codex` MCP tool. The actual call is an injected async function
 * ({@link ConsensusCaller}), so a caller (p5-t2's tests, or the real
 * orchestrator wiring) can drive the exchange without a live Codex process.
 */

import {
  buildCodexReviewParams,
  buildCodexReviewReplyParams,
  type CodexReviewParams,
  type CodexReviewReplyParams,
} from "./foreignReview";

/**
 * Hard cap on the number of rounds a single consensus exchange may run.
 * This is the ONE named constant every round-cap check in this module (and
 * any caller) references — do not duplicate this value as a literal
 * anywhere else. Fixed in source deliberately: a runtime-adjustable cap
 * (env var, settings.json, config file) could be silently raised or
 * disabled, and this project's review doctrine (CLAUDE.md's "Review pass
 * (enabled)" section, and ForeignReviewGate's structural two-round bound in
 * foreignReview.ts) is explicit that model exchanges must be bounded, never
 * open-ended, in a way a caller cannot quietly loosen.
 *
 * Value chosen as 4: enough for a genuine back-and-forth (initial position,
 * one rebuttal each way, one final check) to reach or fail convergence
 * without approaching an open-ended loop. It is not derived from
 * measurement — it is a deliberate small ceiling, same spirit as
 * ForeignReviewGate's fixed two-round bound one file over.
 */
export const CONSENSUS_MAX_ROUNDS = 4;

/**
 * Stance values a structured position can carry. Deliberately small and
 * closed — convergence detection (see {@link positionsMatch}) is an exact
 * comparison on this field, so the set of possible values must be a fixed
 * enum, not free text, or "exact comparison" would be meaningless.
 */
export const CONSENSUS_STANCES = ["agree", "disagree", "abstain"] as const;

/** One of the values in {@link CONSENSUS_STANCES}. */
export type ConsensusStance = (typeof CONSENSUS_STANCES)[number];

/**
 * A small, structured position one side takes in one round. `stance` is the
 * ONLY field convergence detection compares (see {@link positionsMatch}) —
 * `rationale` is carried through every outcome for a human to read, but it
 * is never itself compared, fuzzy-matched, or judged, because doing so
 * would make termination probabilistic instead of provable.
 */
export interface ConsensusPosition {
  stance: ConsensusStance;
  rationale: string;
}

/**
 * Parses one side's reply text into a {@link ConsensusPosition}. Mirrors
 * foreignReview.ts's `parseCodexVerdict`: a structured `key: value` line
 * scan against a fixed field set, never a heuristic scan of free-form
 * prose. Returns `undefined` (not a guessed default) when `stance:` is
 * missing or outside {@link CONSENSUS_STANCES} — an unparseable reply must
 * never be silently treated as "agree" or "disagree", either of which
 * would fabricate a position neither side actually took.
 */
export function parseConsensusPosition(replyText: string): ConsensusPosition | undefined {
  const lines = replyText.split(/\r?\n/);
  let stance: string | undefined;
  let rationale = "";
  for (const line of lines) {
    const m = /^\s*([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === "stance") stance = value;
    else if (key === "rationale") rationale = value;
  }
  if (!stance || !(CONSENSUS_STANCES as readonly string[]).includes(stance)) {
    return undefined;
  }
  return { stance: stance as ConsensusStance, rationale };
}

/**
 * Deterministic, exact-field convergence check: two positions are
 * "converged" iff their `stance` fields are strictly equal. `rationale` is
 * never compared. This is the whole point of the deterministic-convergence
 * requirement (p5-t1 acceptance criterion 5): termination must be provable
 * by inspection of one enum field, not the output of a similarity score or
 * an LLM judgment call, which would make the protocol's bound probabilistic
 * rather than structural. An `"abstain"` stance on either side never counts
 * as convergence with anything, including another `"abstain"` — abstaining
 * is "no position taken," and two absences of a position is not agreement.
 */
export function positionsMatch(a: ConsensusPosition, b: ConsensusPosition): boolean {
  if (a.stance === "abstain" || b.stance === "abstain") return false;
  return a.stance === b.stance;
}

/**
 * Billing-model classification for one round's Codex call. This
 * DELIBERATELY mirrors the four-value taxonomy defined by `costModelClass`
 * at media/main.js:13716 (metered | subscription | local | unknown, per
 * docs/provider-contract.md section 4 / p3-t1) rather than importing it —
 * media/main.js is webview-scope JavaScript with no module boundary this
 * extension-host TypeScript file can import across, so a real shared import
 * is not available here.
 *
 * Decision: this module does NOT re-implement the model-id-to-class
 * classification logic (the string-matching in media/main.js's
 * `costModelClass`). Re-implementing that matching here would create a
 * second copy of the same heuristic that can silently drift from the
 * webview's (e.g. if a new Anthropic or GPT family ships and only one copy
 * is updated). Instead, this module records the RAW model id per round
 * (`ConsensusRoundCost.modelId`) alongside a `costModelClass` field the
 * CALLER supplies (the orchestrator, which already has access to the
 * webview-side classifier via the panel's existing message-passing, or the
 * extension-host caller can shell out to the same taxonomy by keeping its
 * own copy in lockstep deliberately, same as media/main.js's own header
 * comment above `costModelClass` instructs for `modelFamily`). This keeps
 * exactly one authoritative classifier (media/main.js:13716) and treats
 * this module as a consumer of its output, not a second implementation —
 * the safest way to avoid a silently-diverging duplicate.
 */
export const COST_MODEL_CLASSES = ["metered", "subscription", "local", "unknown"] as const;

/** One of the values in {@link COST_MODEL_CLASSES}, matching media/main.js:13716's `costModelClass`. */
export type CostModelClass = (typeof COST_MODEL_CLASSES)[number];

/**
 * Cost record for exactly one round. `costModelClass` must be supplied by
 * the caller (see the module-level doc comment above
 * {@link COST_MODEL_CLASSES} for why this module does not classify it
 * itself) — never defaulted to `"unknown"` silently inside this module,
 * since that would hide a caller bug (forgetting to classify) behind a
 * value that looks like a legitimate "genuinely unrecognized model"
 * result.
 */
export interface ConsensusRoundCost {
  round: number;
  side: "claude" | "codex";
  modelId: string;
  costModelClass: CostModelClass;
}

/** One completed round of the exchange: the position taken and its cost record. */
export interface ConsensusRoundResult {
  round: number;
  claudePosition: ConsensusPosition;
  codexPosition: ConsensusPosition;
  costs: ConsensusRoundCost[];
}

/**
 * Terminal outcome of a consensus exchange. A discriminated union on
 * `status` so a caller can never accidentally read `agreedStance` off a
 * `no-agreement` or `provider-failure` result. Four distinct kinds:
 *  - `"agreed"` — both sides' positions converged (see {@link positionsMatch})
 *    on some round at or before {@link CONSENSUS_MAX_ROUNDS}.
 *  - `"no-agreement"` — the cap was hit ({@link CONSENSUS_MAX_ROUNDS} rounds
 *    completed) WITHOUT convergence. This is a legitimate, expected
 *    outcome ("these two models did not agree"), not an error and not a
 *    default to either side's final position — callers must not treat
 *    `rounds[rounds.length - 1].claudePosition` as "the answer" just
 *    because it's the last one recorded.
 *  - `"provider-failure"` — a round's Codex call failed for a reason other
 *    than disagreement: most importantly a dead session (`codex-reply`
 *    against a `threadId` from an exited `codex mcp-server` process,
 *    detected via {@link isSessionNotFoundText}), but also any other
 *    `isError:true` response the injected caller surfaces. This is its own
 *    terminal state, distinct from both `agreed` and `no-agreement` — a
 *    provider failure means the debate could not run to a real verdict at
 *    all, which is a different fact from "it ran and they disagreed."
 *  - `"unparseable"` — a reply's text did not parse into a
 *    {@link ConsensusPosition} (see {@link parseConsensusPosition}). Kept
 *    distinct from `provider-failure` because the provider call itself
 *    succeeded; the reply just didn't match the documented shape. Treated
 *    identically to `provider-failure` by any caller that only cares
 *    "did we get a real verdict" (same posture as foreignReview.ts's
 *    `unparseable`/`provider-unavailable` handling), but kept separately
 *    tagged so a caller that wants to distinguish "Codex is down" from
 *    "Codex answered but not in the expected shape" still can.
 */
export type ConsensusOutcome =
  | { status: "agreed"; stance: ConsensusStance; round: number; rounds: ConsensusRoundResult[] }
  | { status: "no-agreement"; rounds: ConsensusRoundResult[] }
  | { status: "provider-failure"; round: number; providerError: string; rounds: ConsensusRoundResult[] }
  | { status: "unparseable"; round: number; side: "claude" | "codex"; rawText: string; rounds: ConsensusRoundResult[] };

/** Substring Codex uses for a dead-session failure — see docs/provider-contract.md section 2. */
const SESSION_NOT_FOUND_SUBSTRING = "session not found";

/**
 * True iff `text` matches Codex's dead-session failure text ("Session not
 * found for thread_id: ..."), per docs/provider-contract.md section 2 and
 * docs/codex-mcp-probe-findings.md section 2, Attempt A. Case-insensitive
 * substring match, mirroring foreignReview.ts/codex-reviewer.md's own
 * text-pattern-matching approach to Codex's `isError:true` plain-text
 * shape (there is no structured error code to switch on instead — see the
 * provider contract's failure-taxonomy section).
 */
export function isSessionNotFoundText(text: string): boolean {
  return text.toLowerCase().includes(SESSION_NOT_FOUND_SUBSTRING);
}

/** Raw result the injected caller returns for one Codex round. */
export interface ConsensusCallResult {
  /** Present and used when the call succeeded (isError was falsy). */
  content?: string;
  /** The threadId to persist for subsequent codex-reply calls (round 1 only; codex-reply echoes it back too). */
  threadId?: string;
  /** True when Codex returned isError:true — content is then the raw error text, not a position. */
  isError?: boolean;
}

/**
 * The injected call function: takes the params this module builds
 * ({@link CodexReviewParams} for round 1, {@link CodexReviewReplyParams} for
 * rounds 2+) and returns the raw result. Kept as a plain async function
 * (never a class or an object with hidden state) so p5-t2 can pass a stub
 * with canned responses per round, with no live `codex` MCP call, no
 * vscode/fs/child_process import, matching foreignReview.ts's
 * side-effect-free/injectable design.
 */
export type ConsensusCaller = (params: CodexReviewParams | CodexReviewReplyParams) => Promise<ConsensusCallResult>;

/** One side's move for one round, supplied by the orchestrator driving the exchange. */
export interface ConsensusRoundInput {
  /** Claude's structured position for this round (the orchestrator already has this — it's Claude's own reasoning). */
  claudePosition: ConsensusPosition;
  /** The prompt text sent to Codex this round — round 1's opening question, or a rebuttal referencing Claude's new position. */
  codexPrompt: string;
  /** costModelClass for Claude's side this round — see the module-level doc comment on why this is caller-supplied. */
  claudeCostModelClass: CostModelClass;
  /** The model id actually used for Claude's side this round (e.g. from the orchestrator's active model config). */
  claudeModelId: string;
  /** costModelClass for Codex's side this round. Codex is `"subscription"` per docs/provider-contract.md section 4 in the common case, but caller-supplied rather than hardcoded so a future non-subscription Codex deployment (or a different foreign model reusing this module) isn't silently misclassified. */
  codexCostModelClass: CostModelClass;
}

/**
 * Builds the MCP params for one round's Codex call: a fresh `codex` call
 * (via {@link buildCodexReviewParams}) for round 1, or a `codex-reply`
 * against the persisted `threadId` (via {@link buildCodexReviewReplyParams})
 * for every round after that — never re-sending full history, only the new
 * prompt text for that round. Delegating to foreignReview.ts's builders
 * (rather than constructing params inline here) is what makes omitting the
 * `sandbox: "read-only"` / `approval-policy: "never"` safety arguments
 * structurally impossible for a consensus round, same guarantee
 * foreignReview.ts already provides for the review gate — there is exactly
 * one place in the codebase that builds Codex call params, and every
 * caller (review gate or consensus exchange) goes through it.
 */
export function buildConsensusRoundParams(
  round: number,
  prompt: string,
  threadId: string | undefined,
): CodexReviewParams | CodexReviewReplyParams {
  if (round === 1 || !threadId) {
    return buildCodexReviewParams(prompt);
  }
  return buildCodexReviewReplyParams(threadId, prompt);
}

/**
 * Runs the bounded consensus exchange. Structurally bounded by a `for`
 * loop over `CONSENSUS_MAX_ROUNDS` (rather than a `while` with a break
 * condition) so the round cap is enforced by the loop's own structure —
 * the loop body physically cannot execute a `CONSENSUS_MAX_ROUNDS + 1`th
 * iteration, regardless of what `roundInputs` or `call` return. This is
 * the same reasoning ForeignReviewGate uses for its internal round counter
 * in foreignReview.ts, applied at the loop-construct level instead of an
 * object's internal counter.
 *
 * `roundInputs` supplies exactly one {@link ConsensusRoundInput} per
 * round the loop actually executes — the orchestrator computes Claude's
 * position and the next Codex prompt outside this function (this module
 * has no opinion on how Claude forms a position; it only runs the bounded
 * exchange and detects convergence/failure). `call` is the injected
 * Codex-call function; see {@link ConsensusCaller}.
 *
 * Termination is checked after EVERY round via {@link positionsMatch} —
 * as soon as `claudePosition.stance` and `codexPosition.stance` are
 * exactly equal (and neither is `"abstain"`), the function returns
 * `{status: "agreed", ...}` immediately without consuming further rounds
 * from `roundInputs`. If the loop completes all `CONSENSUS_MAX_ROUNDS`
 * rounds without convergence, it returns `{status: "no-agreement", ...}`
 * — never a default to either side's last position.
 *
 * A dead session (`isSessionNotFoundText` on an `isError` result) or any
 * other provider error immediately returns `{status: "provider-failure",
 * ...}` for that round; it is never retried into a fresh session, which
 * would silently discard Codex's prior-round context while pretending
 * continuity held.
 */
export async function runConsensusExchange(
  roundInputs: ConsensusRoundInput[],
  call: ConsensusCaller,
): Promise<ConsensusOutcome> {
  const rounds: ConsensusRoundResult[] = [];
  let threadId: string | undefined;

  for (let i = 0; i < CONSENSUS_MAX_ROUNDS; i++) {
    const input = roundInputs[i];
    if (!input) break; // orchestrator ran out of rounds to offer; not a cap issue.
    const round = i + 1;

    const params = buildConsensusRoundParams(round, input.codexPrompt, threadId);
    // Two distinct failure paths, both terminal as "provider-failure": a
    // protocol-level failure (the call resolves normally but the result
    // carries isError:true, e.g. Codex's own "Session not found for
    // thread_id" text) is handled below via `result.isError`; a
    // transport-level failure (the injected caller itself THROWS — a real
    // MCP stdio client does this on process death, a broken pipe, or any
    // other transport error, which is a distinct and likely failure mode
    // from a well-formed isError response) is caught here so it resolves
    // to the same explicit outcome instead of propagating as an unhandled
    // rejection out of this function.
    let result: ConsensusCallResult;
    try {
      result = await call(params);
    } catch (err) {
      const providerError = err instanceof Error ? err.message : String(err);
      return { status: "provider-failure", round, providerError, rounds };
    }

    if (result.isError) {
      const errorText = result.content ?? "";
      return { status: "provider-failure", round, providerError: errorText, rounds };
    }
    if (result.threadId) {
      threadId = result.threadId;
    }

    const codexPosition = parseConsensusPosition(result.content ?? "");
    if (!codexPosition) {
      return { status: "unparseable", round, side: "codex", rawText: result.content ?? "", rounds };
    }

    const costs: ConsensusRoundCost[] = [
      { round, side: "claude", modelId: input.claudeModelId, costModelClass: input.claudeCostModelClass },
      { round, side: "codex", modelId: "codex", costModelClass: input.codexCostModelClass },
    ];
    const roundResult: ConsensusRoundResult = {
      round,
      claudePosition: input.claudePosition,
      codexPosition,
      costs,
    };
    rounds.push(roundResult);

    if (positionsMatch(input.claudePosition, codexPosition)) {
      return { status: "agreed", stance: input.claudePosition.stance, round, rounds };
    }
  }

  return { status: "no-agreement", rounds };
}
