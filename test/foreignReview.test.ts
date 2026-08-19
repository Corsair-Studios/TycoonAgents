/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the foreign-review wiring (src/host/vscode/foreignReview.ts):
// param construction safety args, verdict parsing, and the single-pass
// ForeignReviewGate. This module is a pure library (no vscode/fs/child_process
// imports), so every test here is pure-function testing — no live Codex call,
// no network, no real binary, no timers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexReviewParams,
  buildCodexReviewReplyParams,
  parseCodexVerdict,
  ForeignReviewGate,
} from "../src/host/vscode/foreignReview";

// ---------------------------------------------------------------------------
// buildCodexReviewParams / buildCodexReviewReplyParams — safety args
// ---------------------------------------------------------------------------

test("buildCodexReviewParams carries sandbox:read-only and approval-policy:never", () => {
  const params = buildCodexReviewParams("review this diff");
  assert.equal(params.sandbox, "read-only");
  assert.equal(params["approval-policy"], "never");
  assert.equal(params.prompt, "review this diff");
});

test("buildCodexReviewReplyParams carries sandbox:read-only and approval-policy:never", () => {
  const params = buildCodexReviewReplyParams("thread-123", "please recheck");
  assert.equal(params.sandbox, "read-only");
  assert.equal(params["approval-policy"], "never");
  assert.equal(params.threadId, "thread-123");
  assert.equal(params.prompt, "please recheck");
});

test("buildCodexReviewParams throws on empty changeDescription", () => {
  assert.throws(() => buildCodexReviewParams(""));
  assert.throws(() => buildCodexReviewParams("   "));
});

test("buildCodexReviewReplyParams throws on empty threadId or prompt", () => {
  assert.throws(() => buildCodexReviewReplyParams("", "prompt"));
  assert.throws(() => buildCodexReviewReplyParams("thread-1", ""));
});

// ---------------------------------------------------------------------------
// parseCodexVerdict
// ---------------------------------------------------------------------------

test("parseCodexVerdict parses an approve verdict", () => {
  const verdict = parseCodexVerdict(["verdict: approve", "summary: looks good"].join("\n"));
  assert.equal(verdict.kind, "approve");
  assert.equal(verdict.kind === "approve" && verdict.summary, "looks good");
});

test("parseCodexVerdict extracts findings with file/line/severity from a well-formed changes-requested verdict", () => {
  const text = [
    "verdict: changes-requested",
    "summary: two issues found",
    "findings:",
    "  - file: src/foo.ts",
    "    line: 42",
    "    severity: blocker",
    "    summary: null deref on missing input",
    "  - file: src/bar.ts",
    "    line: 10-15",
    "    severity: minor",
    "    summary: unused variable",
  ].join("\n");
  const verdict = parseCodexVerdict(text);
  assert.equal(verdict.kind, "changes-requested");
  if (verdict.kind !== "changes-requested") return;
  assert.equal(verdict.summary, "two issues found");
  assert.equal(verdict.findings.length, 2);
  assert.deepEqual(verdict.findings[0], {
    file: "src/foo.ts",
    line: "42",
    severity: "blocker",
    summary: "null deref on missing input",
  });
  assert.deepEqual(verdict.findings[1], {
    file: "src/bar.ts",
    line: "10-15",
    severity: "minor",
    summary: "unused variable",
  });
});

test("parseCodexVerdict parses a provider-unavailable verdict with provider_error", () => {
  const text = ["verdict: provider-unavailable", "provider_error: usage limit exceeded"].join("\n");
  const verdict = parseCodexVerdict(text);
  assert.equal(verdict.kind, "provider-unavailable");
  assert.equal(verdict.kind === "provider-unavailable" && verdict.providerError, "usage limit exceeded");
});

test("parseCodexVerdict does not mistake provider-unavailable for an approval", () => {
  const verdict = parseCodexVerdict("verdict: provider-unavailable\nprovider_error: 401 Unauthorized");
  assert.notEqual(verdict.kind, "approve");
});

test("parseCodexVerdict returns unparseable for garbled/missing verdict line", () => {
  const noVerdict = parseCodexVerdict("this is not a structured report at all");
  assert.equal(noVerdict.kind, "unparseable");
  assert.equal(noVerdict.kind === "unparseable" && noVerdict.rawText, "this is not a structured report at all");

  const badVerdict = parseCodexVerdict("verdict: maybe\nsummary: unsure");
  assert.equal(badVerdict.kind, "unparseable");
});

test("parseCodexVerdict does not mistake unparseable input for an approval", () => {
  const verdict = parseCodexVerdict("garbage text with no verdict field");
  assert.notEqual(verdict.kind, "approve");
});

// ---------------------------------------------------------------------------
// ForeignReviewGate
// ---------------------------------------------------------------------------

test("ForeignReviewGate: approve verdict short-circuits with no fix cycle and closes the gate", () => {
  const gate = new ForeignReviewGate();
  const outcome = gate.recordVerdict({ kind: "approve", summary: "clean" });
  assert.equal(outcome.status, "approved");
  assert.equal(gate.isClosed(), true);
  // No fix-and-recheck cycle is authorized after an approval: a further
  // recordVerdict call must throw rather than silently starting a round.
  assert.throws(() => gate.recordVerdict({ kind: "approve", summary: "clean again" }));
});

test("ForeignReviewGate: one changes-requested verdict triggers exactly one fix-and-recheck cycle", () => {
  const gate = new ForeignReviewGate();
  const firstFindings = [{ file: "a.ts", line: "1", severity: "major" as const, summary: "bug" }];
  const first = gate.recordVerdict({ kind: "changes-requested", summary: "fix it", findings: firstFindings });
  assert.equal(first.status, "changes-requested");
  assert.equal(first.status === "changes-requested" && first.round, 1);
  assert.equal(gate.isClosed(), false);
});

test("ForeignReviewGate: a second changes-requested verdict closes the gate unresolved and blocks a third cycle", () => {
  const gate = new ForeignReviewGate();
  const findings = [{ file: "a.ts", line: "1", severity: "major" as const, summary: "bug" }];
  const first = gate.recordVerdict({ kind: "changes-requested", summary: "fix it", findings });
  assert.equal(first.status, "changes-requested");

  const second = gate.recordVerdict({ kind: "changes-requested", summary: "still broken", findings });
  assert.equal(second.status, "gate-closed-unresolved");
  assert.equal(gate.isClosed(), true);

  // Third cycle is never authorized: recordVerdict throws once the gate is
  // closed, structurally preventing an unbounded fix-and-recheck loop.
  assert.throws(() => gate.recordVerdict({ kind: "changes-requested", summary: "third try", findings }));
});

test("ForeignReviewGate: recordVerdict throws on a third call even without checking isClosed first", () => {
  const gate = new ForeignReviewGate();
  const findings = [{ file: "a.ts", line: "1", severity: "minor" as const, summary: "nit" }];
  gate.recordVerdict({ kind: "changes-requested", summary: "round 1", findings });
  gate.recordVerdict({ kind: "changes-requested", summary: "round 2", findings });
  assert.throws(
    () => gate.recordVerdict({ kind: "approve", summary: "late approval" }),
    /third time|already closed/
  );
});

test("ForeignReviewGate: provider-unavailable closes the gate and does not report status approved", () => {
  const gate = new ForeignReviewGate();
  const outcome = gate.recordVerdict({ kind: "provider-unavailable", providerError: "out of quota" });
  assert.equal(outcome.status, "provider-unavailable");
  assert.notEqual(outcome.status as string, "approved");
  assert.equal(gate.isClosed(), true);
  assert.throws(() => gate.recordVerdict({ kind: "approve", summary: "retry" }));
});

test("ForeignReviewGate: unparseable verdict closes the gate as provider-unavailable, not approved", () => {
  const gate = new ForeignReviewGate();
  const outcome = gate.recordVerdict({ kind: "unparseable", rawText: "garbled output" });
  assert.equal(outcome.status, "provider-unavailable");
  assert.notEqual(outcome.status as string, "approved");
  assert.equal(gate.isClosed(), true);
});

// ---------------------------------------------------------------------------
// Exactly-one-invocation-per-change: simulated call-counting harness
// ---------------------------------------------------------------------------
// This module never calls the codex MCP tool itself (invocation is the
// orchestrator's job), so "exactly one invocation" is pinned by simulating
// the orchestrator's call pattern against a counting stub and asserting the
// gate's outcome is what actually governs whether a second call happens.

test("exactly one review invocation for an approved change (no fix cycle, no second call)", () => {
  let invocationCount = 0;
  const gate = new ForeignReviewGate();

  function invokeReview(): void {
    invocationCount += 1;
  }

  invokeReview();
  const outcome = gate.recordVerdict({ kind: "approve", summary: "clean" });
  if (outcome.status === "changes-requested") {
    invokeReview();
  }

  assert.equal(invocationCount, 1);
});

test("changes-requested drives exactly one recheck invocation, never a third", () => {
  let invocationCount = 0;
  const gate = new ForeignReviewGate();
  const findings = [{ file: "a.ts", line: "1", severity: "major" as const, summary: "bug" }];

  function invokeReview(): void {
    invocationCount += 1;
  }

  // Round 1
  invokeReview();
  let outcome = gate.recordVerdict({ kind: "changes-requested", summary: "fix it", findings });
  assert.equal(outcome.status, "changes-requested");

  // The orchestrator sends findings back for exactly one fix, then rechecks.
  if (outcome.status === "changes-requested") {
    invokeReview();
    outcome = gate.recordVerdict({ kind: "approve", summary: "fixed now" });
  }

  assert.equal(invocationCount, 2);
  assert.equal(outcome.status, "approved");
  assert.equal(gate.isClosed(), true);

  // A well-behaved orchestrator checks isClosed() before invoking again; the
  // gate itself also throws if recordVerdict is called a third time.
  assert.equal(gate.isClosed(), true);
  assert.throws(() => gate.recordVerdict({ kind: "changes-requested", summary: "should not happen", findings }));
});
