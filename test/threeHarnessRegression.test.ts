/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// End-to-end regression for plan task p22-t7: provider switching among all
// three harnesses (claude-code, opencode, codex), concurrent ingestion from
// two providers tailing ONE shared activity.jsonl, a fixture-driven
// simulation of what the ready-test skill checks under codex, and a ledger
// check that codex subscription tokens land in the "subscription" cost
// class. See docs/codex-harness-findings.md's "Manual live run" section for
// the live-Codex step this suite cannot execute (no interactive host).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeStateFromRecords, applyEvent, initialWorldState } from "../src/core/state";
import "../src/providers/registerAllMappers";
import { createProvider } from "../src/host/vscode/providerFactory";
import { OpenCodeProvider } from "../src/providers/opencode";
import { CodexProvider } from "../src/providers/codex";
import { ClaudeCodeProvider } from "../src/providers/claude-code";
import { PROVIDER_IDS } from "../src/core/providerSelection";
import type { NormalizedEvent } from "../src/core/events";

const T = 1700000000000;

function setupFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-three-harness-"));
  const file = join(dir, "activity.jsonl");
  writeFileSync(file, "", "utf8");
  return { dir, file };
}

function toLines(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

async function drainUntil(events: NormalizedEvent[], count: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// 1. Provider switching among all three (createProvider returns the right
//    class per id, and every id in PROVIDER_IDS is constructible).
// ---------------------------------------------------------------------------

test("(switch) createProvider returns the correct class for every PROVIDER_IDS entry", () => {
  const file = join(tmpdir(), "activity.jsonl");
  for (const id of PROVIDER_IDS) {
    const provider = createProvider(id, file);
    assert.equal(provider.id, id, `provider constructed for "${id}" should report id "${id}"`);
  }
  assert.ok(createProvider("claude-code", file) instanceof ClaudeCodeProvider);
  assert.ok(createProvider("opencode", file) instanceof OpenCodeProvider);
  assert.ok(createProvider("codex", file) instanceof CodexProvider);
});

// ---------------------------------------------------------------------------
// 2. Concurrent event ingestion from two providers into ONE shared
//    activity.jsonl. This is the regression test for the known drain() bug:
//    written FIRST so it fails against the pre-fix code (each provider's
//    drain() dispatched tryMapRecord on every line regardless of the
//    record's own `provider` tag, so two providers tailing the same file
//    double-emitted every record). After the fix (skip lines whose
//    provider !== this.id, default DEFAULT_PROVIDER_ID), each provider
//    emits ONLY its own records.
// ---------------------------------------------------------------------------

test("(concurrent) OpenCodeProvider and CodexProvider tailing the SAME file each emit only their own records", async () => {
  const { dir, file } = setupFile();
  try {
    const ocEvents: NormalizedEvent[] = [];
    const cxEvents: NormalizedEvent[] = [];
    const oc = new OpenCodeProvider({ activityFile: file, pollIntervalMs: 20 });
    const cx = new CodexProvider({ activityFile: file, pollIntervalMs: 20 });
    oc.start((e) => ocEvents.push(e));
    cx.start((e) => cxEvents.push(e));

    const mixed = [
      { event: "UserPromptSubmit", provider: "opencode", sessionId: "S-OC", at: T },
      { event: "UserPromptSubmit", provider: "codex", sessionId: "S-CX", at: T + 1 },
      { event: "SubagentStop", provider: "opencode", workerId: "oc-worker", tokens: 10, sessionId: "S-OC", at: T + 2 },
      { event: "SubagentStop", provider: "codex", workerId: "cx-worker", tokens: 20, sessionId: "S-CX", at: T + 3 },
    ];
    appendFileSync(file, toLines(mixed), "utf8");

    // 2 opencode lines -> UserPromptSubmit(1) + SubagentStop(2: TaskCompleted+WorkerStopped) = 3 events
    await drainUntil(ocEvents, 3);
    await drainUntil(cxEvents, 3);

    oc.stop();
    cx.stop();

    assert.equal(ocEvents.length, 3, "opencode provider should emit exactly its own 3 events, not the codex lines too");
    assert.equal(cxEvents.length, 3, "codex provider should emit exactly its own 3 events, not the opencode lines too");
    assert.ok(ocEvents.every((e) => e.provider === "opencode" || e.provider === undefined), "no codex-tagged event leaked into opencode's stream");
    assert.ok(cxEvents.every((e) => e.provider === "codex" || e.provider === undefined), "no opencode-tagged event leaked into codex's stream");

    // Downstream: replaying the same shared file through computeStateFromRecords
    // (which uses tryMapRecord directly, not a single-provider drain) must still
    // produce independent roster entries for both workers with correct token counts.
    const state = computeStateFromRecords(mixed as any);
    const ocMetric = state.agentMetrics.find((m) => m.id === "oc-worker");
    const cxMetric = state.agentMetrics.find((m) => m.id === "cx-worker");
    assert.equal(ocMetric?.tokens, 10);
    assert.equal(cxMetric?.tokens, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Ready-test-under-codex simulation. The live ready test cannot be run
//    from this leaf worker (no interactive host, no live Codex binary) — see
//    docs/codex-harness-findings.md's "Manual live run" section for the
//    documented manual step. This is a FIXTURE-DRIVEN SIMULATION of what
//    the ready-test skill actually checks per docs (SKILL.md step 6/7):
//    every roster (non-lead) agent produces a WorkerSpawned/WorkerStopped
//    pair attributed to provider "codex".
// ---------------------------------------------------------------------------

test("(ready-test-sim) every roster agent produces a codex-attributed WorkerSpawned/WorkerStopped pair", () => {
  const roster = ["coding-specialist", "search-retrieval", "testing-specialist", "ux-ui-designer", "vscode-integration", "workspace-monitor"];
  const records = roster.flatMap((agentId, i) => [
    { event: "PreToolUse", tool: "Task", provider: "codex", workerId: agentId, agentDescription: agentId, sessionId: "READY", at: T + i * 10 },
    { event: "SubagentStop", provider: "codex", workerId: agentId, tokens: 5, sessionId: "READY", at: T + i * 10 + 1 },
  ]);
  const state = computeStateFromRecords(records as any, "READY");
  for (const agentId of roster) {
    const metric = state.agentMetrics.find((m) => m.id === agentId);
    assert.ok(metric, `${agentId} should have a roster entry from its codex-attributed spawn/stop pair`);
    // WorkerStopped sets status back to "idle" (not "done" — see
    // src/core/state.ts's WorkerStopped case), so completion is verified by
    // taskCount instead (SubagentStop -> TaskCompleted + WorkerStopped).
    assert.equal(metric!.status, "idle", `${agentId} should be idle again after its WorkerStopped under codex`);
    assert.equal(metric!.taskCount, 1, `${agentId} should have one completed task recorded under codex`);
  }
});

// ---------------------------------------------------------------------------
// 4. Ledger check: a codex-tagged WorkerSpawned for codex-reviewer with
//    costModelClass "subscription" lands in the subscription class in the
//    resulting metrics (per .claude/agents/codex-reviewer.md: vendor openai,
//    subscription billing).
// ---------------------------------------------------------------------------

test("(ledger) codex-reviewer WorkerSpawned with costModelClass 'subscription' lands in the subscription class", () => {
  const spawnEvent: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T,
    workerId: "codex-reviewer",
    vendor: "openai",
    costModelClass: "subscription",
    provider: "codex",
    sessionId: "S-LEDGER",
  };
  let state = initialWorldState();
  state = applyEvent(state, spawnEvent);
  const metric = state.agentMetrics.find((m) => m.id === "codex-reviewer");
  assert.ok(metric, "codex-reviewer metric should exist after WorkerSpawned");
  assert.equal(metric!.vendor, "openai");
  assert.equal(metric!.costModelClass, "subscription", "codex-reviewer's subscription tokens must land in the subscription cost class, not metered/local");

  // Also exercise via computeStateFromRecords (the raw-record path a real
  // hook write would take) using a PreToolUse Task record, mirroring how
  // vendor/costModelClass ride on hook records per opencodeProvider.test.ts.
  const raw = [
    {
      event: "PreToolUse",
      tool: "Read",
      provider: "codex",
      workerId: "codex-reviewer",
      vendor: "openai",
      costModelClass: "subscription",
      sessionId: "S-LEDGER-2",
      at: T,
    },
  ];
  const state2 = computeStateFromRecords(raw as any, "S-LEDGER-2");
  const metric2 = state2.agentMetrics.find((m) => m.id === "codex-reviewer");
  assert.equal(metric2?.costModelClass, "subscription");
});

// ---------------------------------------------------------------------------
// 5. No-regression guard: plain single-provider claude-code and opencode
//    flows (unaffected by the drain() fix, since only the SAME provider's
//    own lines are dispatched) still map end-to-end.
// ---------------------------------------------------------------------------

test("(no-regression) single-provider opencode drain still emits its own records unfiltered by anything else", async () => {
  const { dir, file } = setupFile();
  try {
    const oc = new OpenCodeProvider({ activityFile: file, pollIntervalMs: 20 });
    const events: NormalizedEvent[] = [];
    oc.start((e) => events.push(e));
    appendFileSync(file, toLines([{ event: "UserPromptSubmit", provider: "opencode", sessionId: "S", at: T }]), "utf8");
    await drainUntil(events, 1);
    oc.stop();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "SessionStart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(no-regression) single-provider codex drain still emits its own records unfiltered by anything else", async () => {
  const { dir, file } = setupFile();
  try {
    const cx = new CodexProvider({ activityFile: file, pollIntervalMs: 20 });
    const events: NormalizedEvent[] = [];
    cx.start((e) => events.push(e));
    appendFileSync(file, toLines([{ event: "UserPromptSubmit", provider: "codex", sessionId: "S", at: T }]), "utf8");
    await drainUntil(events, 1);
    cx.stop();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "SessionStart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Plan task p22-t9: ClaudeCodeProvider tailing a file shared with
//    opencode and codex lines must emit only claude-code (or untagged
//    legacy) records, mirroring the fix in opencode/index.ts and
//    codex/index.ts.
// ---------------------------------------------------------------------------

test("(concurrent) ClaudeCodeProvider tailing a file mixed with opencode/codex lines emits only its own + untagged records", async () => {
  const { dir, file } = setupFile();
  try {
    const ccEvents: NormalizedEvent[] = [];
    const cc = new ClaudeCodeProvider({ activityFile: file, pollIntervalMs: 20 });
    cc.start((e) => ccEvents.push(e));

    const mixed = [
      { event: "UserPromptSubmit", provider: "claude-code", sessionId: "S-CC", at: T },
      { event: "UserPromptSubmit", provider: "opencode", sessionId: "S-OC", at: T + 1 },
      { event: "UserPromptSubmit", provider: "codex", sessionId: "S-CX", at: T + 2 },
      { event: "SubagentStop", provider: "claude-code", workerId: "cc-worker", tokens: 5, sessionId: "S-CC", at: T + 3 },
      { event: "SubagentStop", provider: "opencode", workerId: "oc-worker", tokens: 10, sessionId: "S-OC", at: T + 4 },
      // Untagged legacy line: no provider field must still map as claude-code.
      { event: "UserPromptSubmit", sessionId: "S-LEGACY", at: T + 5 },
    ];
    appendFileSync(file, toLines(mixed), "utf8");

    // 2 claude-code lines -> UserPromptSubmit(1) + SubagentStop(2) = 3 events,
    // plus 1 untagged legacy line -> UserPromptSubmit(1) = 4 events total.
    await drainUntil(ccEvents, 4);
    cc.stop();

    assert.equal(ccEvents.length, 4, "claude-code provider should emit exactly its own 3 events plus the 1 untagged legacy event, not the opencode/codex lines too");
    assert.ok(
      ccEvents.every((e) => e.provider === "claude-code" || e.provider === undefined),
      "no opencode- or codex-tagged event leaked into claude-code's stream"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Plan task p23-t7: full three-provider coexistence. All three providers
//    tail ONE shared activity.jsonl at once, interleaved with untagged
//    legacy lines and a dispatcher-written codex record (Task PreToolUse
//    with a parentId, mirroring hooks/tycoon-dispatcher-mcp.cjs's shape).
//    Each provider must emit exactly its own records; untagged lines land
//    only under claude-code (per its DEFAULT_PROVIDER_ID fallback).
// ---------------------------------------------------------------------------

test("(coexistence) claude-code, opencode, and codex tailing ONE shared file each emit exactly their own records, no duplicates", async () => {
  const { dir, file } = setupFile();
  try {
    const ccEvents: NormalizedEvent[] = [];
    const ocEvents: NormalizedEvent[] = [];
    const cxEvents: NormalizedEvent[] = [];
    const cc = new ClaudeCodeProvider({ activityFile: file, pollIntervalMs: 20 });
    const oc = new OpenCodeProvider({ activityFile: file, pollIntervalMs: 20 });
    const cx = new CodexProvider({ activityFile: file, pollIntervalMs: 20 });
    cc.start((e) => ccEvents.push(e));
    oc.start((e) => ocEvents.push(e));
    cx.start((e) => cxEvents.push(e));

    const mixed = [
      { event: "UserPromptSubmit", provider: "claude-code", sessionId: "S-CC", at: T },
      { event: "UserPromptSubmit", provider: "opencode", sessionId: "S-OC", at: T + 1 },
      { event: "UserPromptSubmit", provider: "codex", sessionId: "S-CX", at: T + 2 },
      // Untagged legacy line (no provider field) -> must land ONLY under claude-code.
      { event: "UserPromptSubmit", sessionId: "S-LEGACY", at: T + 3 },
      { event: "SubagentStop", provider: "claude-code", workerId: "cc-worker", tokens: 5, sessionId: "S-CC", at: T + 4 },
      { event: "SubagentStop", provider: "opencode", workerId: "oc-worker", tokens: 10, sessionId: "S-OC", at: T + 5 },
      // A dispatcher-written codex record, mirroring hooks/tycoon-dispatcher-mcp.cjs's
      // Task PreToolUse shape (workerId/agentDescription/provider:"codex"/parentId).
      {
        event: "PreToolUse",
        tool: "Task",
        provider: "codex",
        workerId: "codex-reviewer",
        agentDescription: "codex-reviewer",
        parentId: "S-CX",
        sessionId: "S-CX",
        at: T + 6,
      },
      { event: "SubagentStop", provider: "codex", workerId: "codex-reviewer", tokens: 20, sessionId: "S-CX", at: T + 7 },
    ];
    appendFileSync(file, toLines(mixed), "utf8");

    // claude-code: 1 own UserPromptSubmit + 1 untagged legacy UserPromptSubmit
    // + 1 own SubagentStop (TaskCompleted+WorkerStopped=2) = 4 events.
    await drainUntil(ccEvents, 4);
    // opencode: 1 UserPromptSubmit + 1 SubagentStop (2 events) = 3 events.
    await drainUntil(ocEvents, 3);
    // codex: 1 UserPromptSubmit + 1 PreToolUse Task (WorkerSpawned) + 1 SubagentStop (2 events) = 4 events.
    await drainUntil(cxEvents, 4);

    cc.stop();
    oc.stop();
    cx.stop();

    assert.equal(ccEvents.length, 4, "claude-code should emit exactly its own 3 events plus the 1 untagged legacy event");
    assert.equal(ocEvents.length, 3, "opencode should emit exactly its own 3 events");
    assert.equal(cxEvents.length, 4, "codex should emit exactly its own 4 events");

    assert.ok(
      ccEvents.every((e) => e.provider === "claude-code" || e.provider === undefined),
      "no opencode/codex-tagged event leaked into claude-code's stream",
    );
    assert.ok(
      ocEvents.every((e) => e.provider === "opencode"),
      "no claude-code/codex-tagged (or untagged) event leaked into opencode's stream",
    );
    assert.ok(
      cxEvents.every((e) => e.provider === "codex"),
      "no claude-code/opencode-tagged (or untagged) event leaked into codex's stream",
    );

    // No duplicates: total events across all three providers equals the sum
    // of what each was expected to emit, not more.
    assert.equal(ccEvents.length + ocEvents.length + cxEvents.length, 11);

    // Downstream state: replaying the whole mixed file must produce
    // independent roster entries for all three workers with correct tokens,
    // and the dispatcher-style Task PreToolUse must have registered
    // codex-reviewer's spawn (so its SubagentStop resolves to taskCount 1).
    const state = computeStateFromRecords(mixed as any);
    const ccMetric = state.agentMetrics.find((m) => m.id === "cc-worker");
    const ocMetric = state.agentMetrics.find((m) => m.id === "oc-worker");
    const cxMetric = state.agentMetrics.find((m) => m.id === "codex-reviewer");
    assert.equal(ccMetric?.tokens, 5);
    assert.equal(ocMetric?.tokens, 10);
    assert.equal(cxMetric?.tokens, 20);
    assert.equal(cxMetric?.taskCount, 1, "codex-reviewer's dispatcher-written spawn + stop should register one completed task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
