/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Orchestration/routing wiring for the "foreign review" path: the
 * `codex-reviewer` agent (.claude/agents/codex-reviewer.md), which asks
 * OpenAI's Codex for an adversarial, cross-vendor second opinion on a
 * completed change, ALONGSIDE (not instead of) the existing `uefn-auditor`/
 * `reviewer` gate rendered by {@link renderReviewSection} in
 * delegationDoctrine.ts. That existing path is untouched by this module —
 * this is an additive, alternate reviewer with its own single-pass gate.
 *
 * This module owns three things:
 *  1. {@link buildCodexReviewParams} — constructs the `codex` MCP tool call
 *     params, with the mandatory safety arguments (`sandbox: "read-only"`,
 *     `approval-policy: "never"`) baked in at the ONE place that builds
 *     params, so no caller can omit them. See codex-reviewer.md and
 *     media/mcp/catalog.json:132-146 for why this can't be trusted to the
 *     server's `-c` launch-time defaults: those are startup defaults only,
 *     not a ceiling, and per-call arguments can override them.
 *  2. {@link parseCodexVerdict} — parses the codex-reviewer agent's
 *     structured verdict text (defined in codex-reviewer.md) into a typed
 *     {@link CodexVerdict}, never free-form prose scraping.
 *  3. {@link ForeignReviewGate} — a small state machine that bounds the
 *     fix-and-recheck cycle to exactly ONE round, structurally, mirroring
 *     the existing uefn-auditor doctrine's "single review gate, not an
 *     open-ended loop" shape (see CLAUDE.md's "Review pass (enabled)"
 *     section) without modifying that doctrine or its rendering.
 *
 * This module never itself calls the `codex` MCP tool or spawns a Task —
 * invocation is the orchestrator's job (it calls the `codex-reviewer` agent
 * via the Task tool, using the params this module builds, and feeds the
 * agent's report text back into {@link parseCodexVerdict}). Keeping this
 * module a pure, side-effect-free library (no vscode/fs/child_process
 * imports) is what makes it unit-testable without a live Codex call.
 */

/** Verdict values the `codex-reviewer` agent's structured report can carry. */
export const CODEX_VERDICTS = ["approve", "changes-requested", "provider-unavailable"] as const;

/** One of the values in {@link CODEX_VERDICTS}. */
export type CodexVerdictKind = (typeof CODEX_VERDICTS)[number];

/** Severity values a single finding can carry. */
export const CODEX_FINDING_SEVERITIES = ["blocker", "major", "minor"] as const;

/** One of the values in {@link CODEX_FINDING_SEVERITIES}. */
export type CodexFindingSeverity = (typeof CODEX_FINDING_SEVERITIES)[number];

/** One finding from a `changes-requested` verdict. */
export interface CodexFinding {
  file: string;
  /** Line number, or a range as written by the agent (e.g. "42" or "40-45"). */
  line: string;
  severity: CodexFindingSeverity;
  summary: string;
}

/**
 * Typed result of parsing the codex-reviewer agent's report. This is a
 * discriminated union on `kind` so a caller can never accidentally read
 * `findings` off a `provider-unavailable` result or `providerError` off an
 * `approve` result — the TypeScript compiler enforces the branch.
 */
export type CodexVerdict =
  | { kind: "approve"; summary: string }
  | { kind: "changes-requested"; summary: string; findings: CodexFinding[] }
  | { kind: "provider-unavailable"; providerError: string }
  /**
   * The agent's report text did not match the structured shape at all
   * (missing/garbled `verdict:` line, or a `verdict:` value outside
   * {@link CODEX_VERDICTS}). This is deliberately its OWN kind rather than
   * being folded into `provider-unavailable`, but every caller in this
   * module treats it identically to `provider-unavailable`: "no valid
   * review was obtained" is the only safe reading of unparseable output.
   * It must never be treated as an approval (that would silently ship an
   * unreviewed change) and never as changes-requested (that would block
   * indefinitely on a formatting glitch rather than surfacing that the
   * review itself failed). See {@link parseCodexVerdict} for the rationale
   * and {@link ForeignReviewGate.recordVerdict} for how it's handled.
   */
  | { kind: "unparseable"; rawText: string };

/**
 * Mandatory safety arguments for every `codex` / `codex-reply` MCP tool
 * call made by the `codex-reviewer` agent. These MUST be passed explicitly
 * on every call — the catalog's `-c` launch flags
 * (media/mcp/catalog.json:132-146) only set the server's startup defaults,
 * not a ceiling, and the tool's own per-call arguments can override them.
 */
export interface CodexReviewSafetyArgs {
  sandbox: "read-only";
  "approval-policy": "never";
}

/** The one, structurally-fixed set of safety arguments — see {@link CodexReviewSafetyArgs}. */
const CODEX_REVIEW_SAFETY_ARGS: CodexReviewSafetyArgs = {
  sandbox: "read-only",
  "approval-policy": "never",
};

/** Params for a NEW Codex review session (the `codex` MCP tool). */
export interface CodexReviewParams extends CodexReviewSafetyArgs {
  prompt: string;
}

/** Params for continuing an existing Codex session in the same turn (the `codex-reply` MCP tool). */
export interface CodexReviewReplyParams extends CodexReviewSafetyArgs {
  threadId: string;
  prompt: string;
}

/**
 * Builds the params for a NEW `codex` tool call reviewing `changeDescription`
 * (the diff/summary of the completed change to review). This is the ONE
 * place safety arguments are set — every caller goes through this function
 * (or {@link buildCodexReviewReplyParams}) rather than constructing the
 * params object inline, which is what makes omitting `sandbox`/
 * `approval-policy` structurally impossible rather than a convention a
 * caller could forget. p4-t3 can assert on the returned object's
 * `sandbox`/`approval-policy` fields directly, without a live Codex call.
 *
 * `changeDescription` must not be empty — an empty prompt would ask Codex
 * to review nothing, so this throws rather than silently sending a
 * degenerate review request.
 */
export function buildCodexReviewParams(changeDescription: string): CodexReviewParams {
  if (!changeDescription.trim()) {
    throw new Error("buildCodexReviewParams: changeDescription must not be empty");
  }
  return { ...CODEX_REVIEW_SAFETY_ARGS, prompt: changeDescription };
}

/**
 * Builds the params for a `codex-reply` call continuing thread `threadId`
 * within the SAME turn (Codex sessions do not survive server-process
 * restart — see codex-reviewer.md — so callers must never reuse a
 * `threadId` from a prior run/turn). Same safety-argument guarantee as
 * {@link buildCodexReviewParams}.
 */
export function buildCodexReviewReplyParams(threadId: string, prompt: string): CodexReviewReplyParams {
  if (!threadId.trim()) {
    throw new Error("buildCodexReviewReplyParams: threadId must not be empty");
  }
  if (!prompt.trim()) {
    throw new Error("buildCodexReviewReplyParams: prompt must not be empty");
  }
  return { ...CODEX_REVIEW_SAFETY_ARGS, threadId, prompt };
}

/** Matches a top-level `key: value` line, tolerant of leading whitespace. */
function matchField(line: string, key: string): string | undefined {
  const m = /^\s*([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line);
  if (!m || m[1] !== key) return undefined;
  return m[2].trim();
}

/**
 * Parses the codex-reviewer agent's structured report text (the shape
 * defined in codex-reviewer.md's "Structured verdict shape" section) into a
 * typed {@link CodexVerdict}. This is a structured-field parse (line-based
 * `key: value` / list matching against the documented shape), not a
 * heuristic scan of free-form prose: it looks for the exact `verdict:`,
 * `summary:`, `findings:`, and `provider_error:` fields the agent is
 * instructed to emit and nothing else.
 *
 * Unparseable-input decision: if `verdict:` is missing, unreadable, or set
 * to a value outside {@link CODEX_VERDICTS}, this returns
 * `{ kind: "unparseable", rawText }` rather than guessing. Per the task's
 * mandate, unparseable output is NOT an approval (that would silently ship
 * an unreviewed change) — it is treated the same as `provider-unavailable`
 * by every consumer in this module ({@link ForeignReviewGate}), because the
 * safest reading of "the reviewer's output doesn't parse" is identical to
 * "no valid review was obtained": we don't know what Codex actually found,
 * so we can neither pass nor block on it, and must say so rather than
 * inventing a verdict.
 */
export function parseCodexVerdict(reportText: string): CodexVerdict {
  const lines = reportText.split(/\r?\n/);

  let verdict: string | undefined;
  let summary = "";
  let providerError: string | undefined;
  const findings: CodexFinding[] = [];

  let current: Partial<CodexFinding> | undefined;
  const flushFinding = () => {
    if (
      current &&
      typeof current.file === "string" &&
      typeof current.line === "string" &&
      typeof current.summary === "string" &&
      current.severity &&
      (CODEX_FINDING_SEVERITIES as readonly string[]).includes(current.severity)
    ) {
      findings.push(current as CodexFinding);
    }
    current = undefined;
  };

  for (const rawLine of lines) {
    const listItem = /^\s*-\s*file\s*:\s*(.*)$/.exec(rawLine);
    if (listItem) {
      flushFinding();
      current = { file: listItem[1].trim() };
      continue;
    }
    if (current) {
      const lineField = matchField(rawLine, "line");
      if (lineField !== undefined) {
        current.line = lineField;
        continue;
      }
      const severityField = matchField(rawLine, "severity");
      if (severityField !== undefined) {
        current.severity = severityField as CodexFindingSeverity;
        continue;
      }
      const summaryField = matchField(rawLine, "summary");
      if (summaryField !== undefined) {
        current.summary = summaryField;
        continue;
      }
    }

    const verdictField = matchField(rawLine, "verdict");
    if (verdictField !== undefined) {
      flushFinding();
      verdict = verdictField;
      continue;
    }
    const summaryField = matchField(rawLine, "summary");
    if (summaryField !== undefined && !current) {
      summary = summaryField;
      continue;
    }
    const providerErrorField = matchField(rawLine, "provider_error");
    if (providerErrorField !== undefined) {
      providerError = providerErrorField;
      continue;
    }
  }
  flushFinding();

  if (verdict === "approve") {
    return { kind: "approve", summary };
  }
  if (verdict === "changes-requested") {
    return { kind: "changes-requested", summary, findings };
  }
  if (verdict === "provider-unavailable") {
    return { kind: "provider-unavailable", providerError: providerError ?? "" };
  }
  return { kind: "unparseable", rawText: reportText };
}

/** Outcome {@link ForeignReviewGate} exposes to its caller after each verdict is recorded. */
export type ForeignReviewOutcome =
  | { status: "approved"; summary: string }
  | { status: "changes-requested"; summary: string; findings: CodexFinding[]; round: 1 | 2 }
  | { status: "gate-closed-unresolved"; summary: string; findings: CodexFinding[] }
  | { status: "provider-unavailable"; providerError: string };

/**
 * Bounds the codex-reviewer fix-and-recheck cycle to EXACTLY ONE round,
 * structurally — mirroring the existing uefn-auditor doctrine's single
 * review gate (CLAUDE.md's "Review pass (enabled)" section) without
 * touching that doctrine's rendering or behavior. An internal round
 * counter (not a convention the orchestrator could ignore) makes a third
 * cycle impossible: {@link recordVerdict} throws if called a third time.
 *
 * Usage: construct one gate per change under review. Call
 * `recordVerdict(parseCodexVerdict(reportText))` after the first review; if
 * the outcome is `changes-requested`, the orchestrator sends the findings
 * back to the ORIGINAL specialist (never to codex-reviewer itself — see
 * the class doc's self-certification note) for exactly one fix round, then
 * calls `recordVerdict` again with the recheck's verdict. That second call
 * always yields a terminal outcome (`approved`, `gate-closed-unresolved`,
 * or `provider-unavailable`) and the gate accepts no further verdicts.
 *
 * Self-certification invariant: this gate has no notion of "author" and
 * performs no authorship check itself, because the invariant is already
 * enforced upstream and structurally, not by this class: codex-reviewer.md
 * declares the agent's Codex calls read-only (`sandbox: "read-only"`,
 * `approval-policy: "never"`, enforced by {@link buildCodexReviewParams}/
 * {@link buildCodexReviewReplyParams}), so the reviewer is physically
 * unable to author or edit the change it reviews — there is no code path
 * here that could hand codex-reviewer a change to author and then also
 * accept its review of that same change.
 */
export class ForeignReviewGate {
  private round = 0;
  private closed = false;

  /**
   * Records one verdict and returns the outcome for the caller to act on.
   * Throws if called after the gate has already reached a terminal state
   * (approved, gate-closed-unresolved, or provider-unavailable) or after
   * two rounds have already been recorded — this is the structural bound
   * that makes a third cycle impossible rather than merely discouraged.
   */
  recordVerdict(verdict: CodexVerdict): ForeignReviewOutcome {
    if (this.closed) {
      throw new Error("ForeignReviewGate: recordVerdict called after the gate was already closed");
    }
    if (this.round >= 2) {
      throw new Error("ForeignReviewGate: recordVerdict called a third time; the gate allows at most two rounds");
    }
    this.round += 1;

    // Unparseable output is treated identically to provider-unavailable —
    // see parseCodexVerdict's doc comment for the rationale. Both close the
    // gate: neither is a verdict we can act on, so there is nothing a
    // second round could resolve.
    if (verdict.kind === "provider-unavailable" || verdict.kind === "unparseable") {
      this.closed = true;
      const providerError = verdict.kind === "provider-unavailable" ? verdict.providerError : verdict.rawText;
      return { status: "provider-unavailable", providerError };
    }

    if (verdict.kind === "approve") {
      this.closed = true;
      return { status: "approved", summary: verdict.summary };
    }

    // changes-requested
    if (this.round === 1) {
      // First round: one fix-and-recheck cycle is authorized. The gate
      // stays open for exactly one more recordVerdict call.
      return { status: "changes-requested", summary: verdict.summary, findings: verdict.findings, round: 1 };
    }

    // Second round still changes-requested: the single gate is exhausted.
    // Report the outcome rather than cycling further.
    this.closed = true;
    return { status: "gate-closed-unresolved", summary: verdict.summary, findings: verdict.findings };
  }

  /** True once the gate has reached a terminal outcome and will accept no further verdicts. */
  isClosed(): boolean {
    return this.closed;
  }
}
