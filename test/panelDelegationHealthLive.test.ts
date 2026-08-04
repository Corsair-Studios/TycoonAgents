/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initialWorldState, applyEvent, computeStateFromRecords } from "../src/core/state";
import type { MetricsWorldState, AgentMetric } from "../src/core/state";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import { MSG } from "../src/host/vscode/messages";

// Regression coverage for the v0.0.516 Delegation tab bug: the "Orchestrator
// direct tool use" meter showed "0 — all work delegated" while the SAME
// panel's Metrics tab (and the Delegation tab's own Coordination section)
// showed real, live-updating task/MCP counts for the orchestrator. A headless
// repro against the real project activity.jsonl during this investigation
// proved the underlying aggregator (mapHookRecord -> applyEvent /
// computeStateFromRecords) was never broken — it correctly produced non-zero,
// correctly-split counts. The actual bug: `delegationHealth` was computed
// ONLY inside panel.ts's `_handleGetSettings`, invoked exclusively by
// explicit user action (opening Settings, a settings mutation) — never on
// the continuous `runtime.onChange` push that drives every other number on
// the same tab. So the meter froze at whatever it read the one time Settings
// happened to be opened (commonly 0/0/0, since that's often before the
// orchestrator has made any direct tool call yet).
//
// Review-gate follow-up (this file, second pass): the FIRST version of this
// fix threw an unbounded cost into that hot path — every runtime.onChange
// tick (throttled to at most once per 4s, but not bounded in HOW MUCH work
// each of those recomputes did) did a blocking full-file readFileSync +
// full replay of activity.jsonl. Measured on this repo's real ~7.3MB /
// ~51k-record log: ~104-116ms of synchronous main-thread block, every 4
// seconds, for the life of an open panel, with no rotation and a
// monotonically growing file. _computeSessionDelegationHealth was rewritten
// to be incremental: it stat()s the file and (a) returns the cached result
// with ZERO reads if size+mtime are unchanged (the common case — the log is
// idle between tool calls most of the time), (b) reads ONLY the bytes
// appended since the last call and folds them into a cached running
// MetricsWorldState if the file grew, or (c) resets and does a fresh
// from-scratch read if the file shrank/was replaced (rotation, deletion, a
// different project). The byte-range reader
// (_readActivityRecordsSince) mirrors ClaudeCodeProvider.drain()'s existing
// trailing-partial-line handling: it never advances its offset past an
// unterminated line, so a record flushed mid-write by a concurrently-running
// hook is safely re-read whole next time, never dropped or corrupted.
//
// Also added here (review-gate ask #2): a test asserting the actual MSG.STATE
// payload posted to the webview carries delegationHealth — the earlier test
// suite only exercised the helper methods directly, so reverting just the
// `delegationHealth: {...}` line in the onChange push (the actual shipped
// regression) left every one of those tests green. _postStateUpdate was
// extracted as a named, directly-testable seam specifically to close that
// gap.
//
// These tests exercise the REAL production methods (via TycoonPanel.prototype,
// same technique as test/panelReviewAgentId.test.ts and
// test/panelAgentFileInstall.test.ts) — not a reimplementation — plus the
// underlying aggregator directly, including a concurrent-subagent case that
// pins how the aggregator keeps concurrently-active agents' counters
// separated (GIVEN correctly-tagged workerIds in the records — see this
// file's trailing comment on the hook-level attribution race, which is a
// separate, unresolved issue reported but not fixed here).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

const T = 1700000000000;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panelDelegationHealthLive-"));
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  return root;
}

function activityPathFor(root: string): string {
  return path.join(root, ".claude", "tycoon", "activity.jsonl");
}

function writeActivity(root: string, records: HookRecord[]): void {
  fs.writeFileSync(activityPathFor(root), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function appendActivity(root: string, records: HookRecord[]): void {
  fs.appendFileSync(activityPathFor(root), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callCumulative(state: MetricsWorldState): any {
  return (TycoonPanel.prototype as any)._computeCumulativeDelegationHealth.call({}, state);
}

// `_readActivityRecordsSince`/`_sessionHealthResult` touch only their own
// params (plus fs/path) — no other `this.*` — so a bare object carrying just
// the methods + cache fields _computeSessionDelegationHealth /
// _sessionDelegationHealthThrottled actually dereference via `this.` is
// enough to invoke the real production methods. Reused ACROSS multiple calls
// in a single test (rather than recreated per call) wherever a test needs to
// observe the cache/incremental behavior across calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakePanel(): any {
  return {
    _readActivityRecordsSince: (TycoonPanel.prototype as any)._readActivityRecordsSince,
    _sessionHealthResult: (TycoonPanel.prototype as any)._sessionHealthResult,
    _computeSessionDelegationHealth: (TycoonPanel.prototype as any)._computeSessionDelegationHealth,
    _sessionHealthCache: undefined,
    _cachedSessionDelegationHealth: undefined,
    _cachedSessionDelegationHealthAt: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callSessionHealth(root: string): any {
  return (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(makeFakePanel(), root);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callThrottled(fakePanel: any, root: string): any {
  return (TycoonPanel.prototype as any)._sessionDelegationHealthThrottled.call(fakePanel, root);
}

// ---------------------------------------------------------------------------
// _computeCumulativeDelegationHealth: cheap, in-memory (no disk I/O) — sent
// with EVERY runtime.onChange push, which is what closes the staleness gap.
// ---------------------------------------------------------------------------

test("_computeCumulativeDelegationHealth: reads the orchestrator's real counters straight off live state.agentMetrics", () => {
  let state = initialWorldState();
  state = applyEvent(state, { type: "WorkerActivity", at: T, workerId: "orchestrator", kind: "survey", detail: "Grep" });
  state = applyEvent(state, { type: "WorkerActivity", at: T + 1, workerId: "orchestrator", kind: "survey", detail: "Read" });
  state = applyEvent(state, { type: "WorkerActivity", at: T + 2, workerId: "orchestrator", kind: "build", detail: "Edit" });
  state = applyEvent(state, { type: "WorkerActivity", at: T + 3, workerId: "orchestrator", kind: "haul", detail: "Write" });
  const health = callCumulative(state);
  assert.equal(health.directSearches, 1, "Grep counts as a direct (forbidden) search");
  assert.equal(health.directReads, 1, "Read counts as a direct read");
  assert.equal(health.directEdits, 2, "Edit (build) + Write (haul) both count as direct edits");
});

test("_computeCumulativeDelegationHealth: no orchestrator metric yet -> all zeros, not a crash", () => {
  const state = initialWorldState();
  const health = callCumulative(state);
  assert.deepEqual(health, { directSearches: 0, directReads: 0, directEdits: 0, delegations: 0, tokens: 0 });
});

test("_computeCumulativeDelegationHealth: only credits the orchestrator, not a subagent doing the same work", () => {
  let state = initialWorldState();
  state = applyEvent(state, { type: "WorkerActivity", at: T, workerId: "coding-specialist", kind: "survey", detail: "Grep" });
  state = applyEvent(state, { type: "WorkerActivity", at: T + 1, workerId: "coding-specialist", kind: "build", detail: "Edit" });
  const health = callCumulative(state);
  assert.equal(health.directSearches, 0, "a subagent's Grep must not count toward the orchestrator's direct-tool-use meter");
  assert.equal(health.directEdits, 0);
});

// ---------------------------------------------------------------------------
// _computeSessionDelegationHealth: correctness, through the REAL aggregator
// (mapHookRecord -> applyEvent). Non-zero, correctly-split counts prove the
// aggregator itself was never the bug — the gap was purely in when/whether
// this result reached the webview.
// ---------------------------------------------------------------------------

test("_computeSessionDelegationHealth: orchestrator Grep/Glob/Read/Edit/Write with a real sessionId -> non-zero, correctly split counts", () => {
  const root = tmpRoot();
  writeActivity(root, [
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T },
    { event: "PreToolUse", tool: "Glob", workerId: "orchestrator", sessionId: "S1", at: T + 1 },
    { event: "PreToolUse", tool: "Read", workerId: "orchestrator", sessionId: "S1", at: T + 2 },
    { event: "PreToolUse", tool: "Edit", workerId: "orchestrator", sessionId: "S1", at: T + 3 },
    { event: "PreToolUse", tool: "Write", workerId: "orchestrator", sessionId: "S1", at: T + 4 },
  ]);
  const result = callSessionHealth(root);
  assert.ok(result, "a sessionId is present -> a result must come back, not undefined");
  assert.equal(result.sessionId, "S1");
  assert.equal(result.health.directSearches, 2, "Grep + Glob");
  assert.equal(result.health.directReads, 1);
  assert.equal(result.health.directEdits, 2, "Edit + Write");
});

test("_computeSessionDelegationHealth: no record ever carries a sessionId -> undefined, not fabricated zeros", () => {
  const root = tmpRoot();
  writeActivity(root, [{ event: "PreToolUse", tool: "Grep", workerId: "orchestrator", at: T }]);
  const result = callSessionHealth(root);
  assert.equal(
    result,
    undefined,
    "no sessionId anywhere in the log -> undefined so the webview falls back to cumulative, never a fake zero"
  );
});

test("_computeSessionDelegationHealth: missing activity.jsonl -> undefined, does not throw", () => {
  const root = tmpRoot(); // .claude/tycoon exists but no activity.jsonl written
  assert.doesNotThrow(() => callSessionHealth(root));
  assert.equal(callSessionHealth(root), undefined);
});

// ---------------------------------------------------------------------------
// Incremental path: cost proportional to NEW data, not total data.
// ---------------------------------------------------------------------------

test("_computeSessionDelegationHealth: second call reads ONLY the appended bytes, not a full re-read from offset 0", () => {
  const root = tmpRoot();
  writeActivity(root, [{ event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T }]);
  const fakePanel = makeFakePanel();

  // Spy on the byte-range reader to capture exactly what range each call requests.
  const calls: Array<{ fromOffset: number; uptoSize: number }> = [];
  const realReadSince = fakePanel._readActivityRecordsSince;
  fakePanel._readActivityRecordsSince = function (this: unknown, activityPath: string, fromOffset: number, uptoSize: number) {
    calls.push({ fromOffset, uptoSize });
    return realReadSince.call(this, activityPath, fromOffset, uptoSize);
  };

  const first = (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.ok(first);
  assert.equal(first.health.directSearches, 1);
  assert.equal(calls.length, 1, "cold start -> exactly one read");
  assert.equal(calls[0].fromOffset, 0, "no cache yet -> the first call necessarily reads from the start");
  const firstCallSize = calls[0].uptoSize;
  assert.ok(firstCallSize > 0);

  appendActivity(root, [
    { event: "PreToolUse", tool: "Glob", workerId: "orchestrator", sessionId: "S1", at: T + 1 },
    { event: "PreToolUse", tool: "Edit", workerId: "orchestrator", sessionId: "S1", at: T + 2 },
  ]);

  const second = (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.ok(second);
  assert.equal(second.health.directSearches, 2, "Grep (from the first read) + Glob (appended)");
  assert.equal(second.health.directEdits, 1, "Edit (appended)");
  assert.equal(calls.length, 2, "second call must also go through the byte-range reader (not skip the read entirely)");
  assert.equal(
    calls[1].fromOffset,
    firstCallSize,
    "second call must start reading from where the FIRST call left off — proof this is NOT a full re-read from 0"
  );
  assert.ok(calls[1].uptoSize > calls[1].fromOffset, "must have read some new bytes");
});

test("_computeSessionDelegationHealth: an UNCHANGED file (size+mtime identical) triggers zero reads on the second call", () => {
  const root = tmpRoot();
  writeActivity(root, [{ event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T }]);
  const fakePanel = makeFakePanel();
  const calls: unknown[] = [];
  const realReadSince = fakePanel._readActivityRecordsSince;
  fakePanel._readActivityRecordsSince = function (this: unknown, ...args: unknown[]) {
    calls.push(args);
    return realReadSince.apply(this, args as [string, number, number]);
  };

  (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.equal(calls.length, 1);
  const second = (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.equal(calls.length, 1, "nothing appended -> the byte-range reader must not be invoked again");
  assert.equal(second.health.directSearches, 1, "still the correct cached result");
});

test("_computeSessionDelegationHealth: file shrinking (rotation/replacement) falls back to a clean full read, not stale/merged garbage", () => {
  const root = tmpRoot();
  writeActivity(root, [
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T },
    { event: "PreToolUse", tool: "Glob", workerId: "orchestrator", sessionId: "S1", at: T + 1 },
    { event: "PreToolUse", tool: "Edit", workerId: "orchestrator", sessionId: "S1", at: T + 2 },
  ]);
  const fakePanel = makeFakePanel();
  const primed = (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.ok(primed);
  assert.equal(primed.health.directSearches, 2);
  assert.equal(primed.health.directEdits, 1);

  // Simulate rotation/replacement: a SMALLER file belonging to a DIFFERENT session.
  writeActivity(root, [{ event: "PreToolUse", tool: "Read", workerId: "orchestrator", sessionId: "S2", at: T + 100 }]);

  const afterRotation = (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.ok(afterRotation);
  assert.equal(afterRotation.sessionId, "S2", "must pick up the NEW session, not stay stuck on S1");
  assert.equal(afterRotation.health.directSearches, 0, "must NOT carry over S1's counts");
  assert.equal(afterRotation.health.directReads, 1, "must reflect only the new (smaller) file's content");
  assert.equal(afterRotation.health.directEdits, 0);
});

test("_computeSessionDelegationHealth: a session boundary mid-stream resets the running counters without re-reading anything already on disk", () => {
  const root = tmpRoot();
  writeActivity(root, [
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T },
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T + 1 },
  ]);
  const fakePanel = makeFakePanel();
  const primed = (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.equal(primed.sessionId, "S1");
  assert.equal(primed.health.directSearches, 2);

  // A NEW session starts (appended, file still grows — not a rotation).
  appendActivity(root, [{ event: "PreToolUse", tool: "Read", workerId: "orchestrator", sessionId: "S2", at: T + 10 }]);
  const afterBoundary = (TycoonPanel.prototype as any)._computeSessionDelegationHealth.call(fakePanel, root);
  assert.equal(afterBoundary.sessionId, "S2");
  assert.equal(afterBoundary.health.directSearches, 0, "S1's Greps must not bleed into S2's counters");
  assert.equal(afterBoundary.health.directReads, 1);
});

// ---------------------------------------------------------------------------
// Concurrent subagents: pin that the AGGREGATOR keeps concurrently-active
// agents' counters properly separated, GIVEN correctly-tagged workerIds in
// the records.
// ---------------------------------------------------------------------------

const CONCURRENT_RECORDS: HookRecord[] = [
  // orchestrator's own direct Grep before delegating
  { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T },
  // two agents spawned "in parallel" (both pushed before either stops)
  { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S1", at: T + 1 },
  { event: "PreToolUse", tool: "Task", workerId: "testing-specialist", sessionId: "S1", at: T + 2 },
  // interleaved tool activity from both, correctly tagged
  { event: "PreToolUse", tool: "Edit", workerId: "coding-specialist", sessionId: "S1", at: T + 3 },
  { event: "PreToolUse", tool: "Read", workerId: "testing-specialist", sessionId: "S1", at: T + 4 },
  { event: "PreToolUse", tool: "Edit", workerId: "testing-specialist", sessionId: "S1", at: T + 5 },
  { event: "PreToolUse", tool: "Read", workerId: "coding-specialist", sessionId: "S1", at: T + 6 },
  { event: "SubagentStop", workerId: "coding-specialist", tokens: 1000, sessionId: "S1", at: T + 7 },
  { event: "SubagentStop", workerId: "testing-specialist", tokens: 2000, sessionId: "S1", at: T + 8 },
  // orchestrator does one more direct call after both subagents finished
  { event: "PreToolUse", tool: "Edit", workerId: "orchestrator", sessionId: "S1", at: T + 9 },
];

test("_computeSessionDelegationHealth: orchestrator's counts exclude concurrent subagents' interleaved activity", () => {
  const root = tmpRoot();
  writeActivity(root, CONCURRENT_RECORDS);
  const result = callSessionHealth(root);
  assert.ok(result);
  assert.equal(result.health.directSearches, 1, "only the orchestrator's own Grep");
  assert.equal(result.health.directEdits, 1, "only the orchestrator's own Edit — not either subagent's Edit");
});

test("computeStateFromRecords: concurrent subagents' direct tool counts land on their OWN agentMetrics entry, not conflated with each other or the orchestrator", () => {
  const state = computeStateFromRecords(CONCURRENT_RECORDS, "S1");
  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  const coder = state.agentMetrics.find((m) => m.id === "coding-specialist");
  const tester = state.agentMetrics.find((m) => m.id === "testing-specialist");
  assert.ok(orch && coder && tester, "all three agents must have their own agentMetrics entry");
  assert.equal(orch!.directSearches, 1);
  assert.equal(orch!.directEdits, 1);
  assert.equal(coder!.directEdits, 1, "coding-specialist's own Edit");
  assert.equal(coder!.directReads, 1, "coding-specialist's own Read");
  assert.equal(tester!.directEdits, 1, "testing-specialist's own Edit");
  assert.equal(tester!.directReads, 1, "testing-specialist's own Read");
  assert.equal(coder!.tokens, 1000, "coding-specialist's own SubagentStop tokens, not summed with testing-specialist's");
  assert.equal(tester!.tokens, 2000);
});

// ---------------------------------------------------------------------------
// _sessionDelegationHealthThrottled: throttles recompute ATTEMPTS on the hot
// runtime.onChange path.
// ---------------------------------------------------------------------------

test("_sessionDelegationHealthThrottled: returns a cached value within the throttle window, even if the file changed underneath it", () => {
  const root = tmpRoot();
  writeActivity(root, [{ event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T }]);
  const fakePanel = makeFakePanel();
  const first = callThrottled(fakePanel, root);
  assert.ok(first);
  assert.equal(first.directSearches, 1);

  // Mutate the file — a fresh (unthrottled) read would now see 2 searches.
  writeActivity(root, [
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T },
    { event: "PreToolUse", tool: "Glob", workerId: "orchestrator", sessionId: "S1", at: T + 1 },
  ]);
  const second = callThrottled(fakePanel, root);
  assert.equal(second.directSearches, 1, "still the CACHED value — the throttle window has not elapsed");
});

test("_sessionDelegationHealthThrottled: recomputes once the throttle window has elapsed", () => {
  const root = tmpRoot();
  writeActivity(root, [{ event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T }]);
  const fakePanel = makeFakePanel();
  callThrottled(fakePanel, root); // prime the cache
  writeActivity(root, [
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T },
    { event: "PreToolUse", tool: "Glob", workerId: "orchestrator", sessionId: "S1", at: T + 1 },
  ]);
  // Force the cache to look stale without sleeping in the test.
  const throttleMs = (TycoonPanel as unknown as { SESSION_HEALTH_THROTTLE_MS: number }).SESSION_HEALTH_THROTTLE_MS;
  fakePanel._cachedSessionDelegationHealthAt = Date.now() - (throttleMs + 1);
  const refreshed = callThrottled(fakePanel, root);
  assert.equal(refreshed.directSearches, 2, "throttle window elapsed -> a fresh read must reflect the updated file");
});

// ---------------------------------------------------------------------------
// _postStateUpdate: the actual regression that shipped. The panel posts
// MSG.STATE on every runtime.onChange tick; the bug (and this fix) live in
// whether that specific payload carries delegationHealth. Testing the
// helpers alone (above) does NOT pin this — reverting just the
// `delegationHealth: {...}` line inside _postStateUpdate leaves every test
// above green, since none of them inspect what actually gets posted.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakePanelForPostState(root: string): { fake: any; posted: any[] } {
  const posted: unknown[] = [];
  const fake = {
    _panel: { webview: { postMessage: (msg: unknown) => { posted.push(msg); } } },
    _projectRoot: () => root,
    // Identity stubs: this test is about delegationHealth, not the
    // state-transform pipeline (covered elsewhere) — see makeFakePanel's
    // doc comment for the same "bind only what's dereferenced" approach.
    _stampRosterModels: (s: unknown) => s,
    _applyTimeAdjustments: (s: unknown) => s,
    _computeCumulativeDelegationHealth: (TycoonPanel.prototype as any)._computeCumulativeDelegationHealth,
    _sessionDelegationHealthThrottled: (TycoonPanel.prototype as any)._sessionDelegationHealthThrottled,
    _computeSessionDelegationHealth: (TycoonPanel.prototype as any)._computeSessionDelegationHealth,
    _readActivityRecordsSince: (TycoonPanel.prototype as any)._readActivityRecordsSince,
    _sessionHealthResult: (TycoonPanel.prototype as any)._sessionHealthResult,
    _sessionHealthCache: undefined,
    _cachedSessionDelegationHealth: undefined,
    _cachedSessionDelegationHealthAt: 0,
  };
  return { fake, posted };
}

test("_postStateUpdate: the posted MSG.STATE payload carries a populated delegationHealth field", () => {
  const root = tmpRoot();
  writeActivity(root, [{ event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T }]);

  let state = initialWorldState();
  state = applyEvent(state, { type: "WorkerActivity", at: T, workerId: "orchestrator", kind: "survey", detail: "Grep" });

  const { fake, posted } = makeFakePanelForPostState(root);
  (TycoonPanel.prototype as any)._postStateUpdate.call(fake, state);

  assert.equal(posted.length, 1, "exactly one postMessage call");
  const msg = posted[0] as any;
  assert.equal(msg.type, MSG.STATE);
  assert.ok(msg.delegationHealth && typeof msg.delegationHealth === "object", "delegationHealth must be present on the STATE payload");
  assert.equal(msg.delegationHealth.directSearches, 1, "must reflect the live cumulative count, not be omitted/hardcoded");
  assert.ok(msg.delegationHealth.session, "the session-scoped sub-object must also be populated from the activity log");
  assert.equal(msg.delegationHealth.session.directSearches, 1);
});

test("_postStateUpdate: with no activity.jsonl at all, delegationHealth is still present (cumulative populated, session undefined) — never silently dropped", () => {
  const root = tmpRoot(); // no activity.jsonl written
  let state = initialWorldState();
  state = applyEvent(state, { type: "WorkerActivity", at: T, workerId: "orchestrator", kind: "build", detail: "Edit" });

  const { fake, posted } = makeFakePanelForPostState(root);
  (TycoonPanel.prototype as any)._postStateUpdate.call(fake, state);

  const msg = posted[0] as any;
  assert.ok(msg.delegationHealth, "delegationHealth key must exist even with no activity log on disk");
  assert.equal(msg.delegationHealth.directEdits, 1, "cumulative (in-memory) counts are independent of the activity log");
  assert.equal(msg.delegationHealth.session, undefined, "no session data available -> undefined, not a fabricated zero");
});

// ---------------------------------------------------------------------------
// 0.0.528: `sessionMetrics` — the MSG.STATE field the Metrics tab's
// Session/All-time scope toggle reads. Same regression class as
// delegationHealth above: the helpers can be individually correct while the
// actual posted payload silently omits/misshapes the field, so these assert
// directly on what _postStateUpdate posts.
// ---------------------------------------------------------------------------

test("_postStateUpdate: sessionMetrics is added as its own top-level field; the cumulative `state` field's agentMetrics shape is untouched", () => {
  const root = tmpRoot();
  writeActivity(root, [{ event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T }]);

  let state = initialWorldState();
  state = applyEvent(state, { type: "WorkerActivity", at: T, workerId: "orchestrator", kind: "survey", detail: "Grep" });
  // Snapshot via shallow-copying each entry (not a JSON round-trip): AgentMetric
  // entries carry own properties explicitly set to `undefined` (e.g. `model`,
  // `parentId`, `tier`), which JSON.stringify silently drops, which would make
  // this snapshot look "changed" against the live object even though nothing
  // touched it -- a false failure, not a real one.
  const agentMetricsBefore = state.agentMetrics.map((m) => ({ ...m }));

  const { fake, posted } = makeFakePanelForPostState(root);
  (TycoonPanel.prototype as any)._postStateUpdate.call(fake, state);

  const msg = posted[0] as any;
  assert.equal(msg.type, MSG.STATE);
  assert.ok("sessionMetrics" in msg, "sessionMetrics must be a top-level field on the STATE payload");
  assert.ok(msg.state && !("sessionMetrics" in msg.state), "sessionMetrics must be a SIBLING of state, never merged into it");
  assert.deepEqual(
    msg.state.agentMetrics,
    agentMetricsBefore,
    "the pre-existing cumulative state.agentMetrics must be byte-for-byte unchanged by the addition of sessionMetrics"
  );
});

test("_postStateUpdate: no project folder open -> sessionMetrics is {available:false, reason:<non-empty>}, never an empty metrics array", () => {
  let state = initialWorldState();
  state = applyEvent(state, { type: "WorkerActivity", at: T, workerId: "orchestrator", kind: "survey", detail: "Grep" });

  const { fake, posted } = makeFakePanelForPostState(""); // root === "" -> no project folder
  (TycoonPanel.prototype as any)._postStateUpdate.call(fake, state);

  const msg = posted[0] as any;
  assert.equal(msg.sessionMetrics.available, false);
  assert.equal(typeof msg.sessionMetrics.reason, "string");
  assert.ok(msg.sessionMetrics.reason.length > 0, "reason must be a non-empty string -- a silent unavailable state is as bad as fabricated zeros");
  assert.equal((msg.sessionMetrics as any).agentMetrics, undefined, "unavailable must not also carry an (empty or otherwise) agentMetrics array");
});

test("_postStateUpdate: a project folder with no recorded activity yet -> sessionMetrics unavailable with its own non-empty reason", () => {
  const root = tmpRoot(); // .claude/tycoon exists but no activity.jsonl written
  let state = initialWorldState();

  const { fake, posted } = makeFakePanelForPostState(root);
  (TycoonPanel.prototype as any)._postStateUpdate.call(fake, state);

  const msg = posted[0] as any;
  assert.equal(msg.sessionMetrics.available, false);
  assert.ok(typeof msg.sessionMetrics.reason === "string" && msg.sessionMetrics.reason.length > 0, "reason must be a non-empty string");
});

test("_postStateUpdate: sessionMetrics reflects ONLY the current session's tokens while the cumulative state.agentMetrics field covers every session", () => {
  const root = tmpRoot();
  // Two distinct sessions in the log: S1 finishes with 1000 tokens, then S2
  // starts and finishes with 2500 tokens for the SAME agent id. The session-
  // boundary-reset behavior pinned by the "_computeSessionDelegationHealth: a
  // session boundary mid-stream..." test above means a fresh (cold) read of
  // this file scopes to S2 (the LAST/current session) only.
  const allRecords: HookRecord[] = [
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S1", at: T },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 1000, sessionId: "S1", at: T + 1 },
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S2", at: T + 100 },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 2500, sessionId: "S2", at: T + 101 },
  ];
  writeActivity(root, allRecords);

  // The cumulative `state` argument mirrors what runtime.getState() produces
  // in production: every record ever recorded, both sessions folded in.
  const cumulativeState = computeStateFromRecords(allRecords, undefined);
  const cumulativeCoder = cumulativeState.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(cumulativeCoder, "sanity: coding-specialist should be in the cumulative fixture");
  assert.equal(cumulativeCoder!.tokens, 3500, "sanity: cumulative fixture sums both sessions' SubagentStop tokens (1000 + 2500)");

  const { fake, posted } = makeFakePanelForPostState(root);
  (TycoonPanel.prototype as any)._postStateUpdate.call(fake, cumulativeState);

  const msg = posted[0] as any;
  assert.ok(msg.sessionMetrics.available, "two sessionIds are present in the log -> sessionMetrics must be available");
  assert.equal(msg.sessionMetrics.sessionId, "S2", "must scope to the CURRENT (last) session, not the first one seen");

  const sessionCoder = (msg.sessionMetrics.agentMetrics as AgentMetric[]).find((m) => m.id === "coding-specialist");
  assert.ok(sessionCoder, "coding-specialist must appear in the session-scoped agentMetrics");
  assert.equal(sessionCoder!.tokens, 2500, "session scope must cover ONLY S2's tokens, not S1's");

  const postedCumulativeCoder = (msg.state.agentMetrics as AgentMetric[]).find((m) => m.id === "coding-specialist");
  assert.ok(postedCumulativeCoder);
  assert.equal(postedCumulativeCoder!.tokens, 3500, "the posted cumulative state.agentMetrics must still cover BOTH sessions");

  assert.notEqual(
    sessionCoder!.tokens,
    postedCumulativeCoder!.tokens,
    "session-scoped and cumulative totals must genuinely differ here -- if they were equal this test would pass trivially and prove nothing"
  );
});

// ---------------------------------------------------------------------------
// 0.0.531 fix, panel-level half: hooks/tycoon-claude-hook.cjs now stamps
// sessionId onto SubagentStop and Stop records (see
// test/tycoonClaudeHookSpawn.test.ts). This section pins what
// _computeSessionDelegationHealth does with that: SubagentStop's
// taskCount/tokens now fold into session scope, a record missing sessionId
// inherits the already-known session (or is skipped if none is known yet),
// a genuine session boundary still resets state, and none of this touches
// the unrelated cumulative path.
// ---------------------------------------------------------------------------

test("_computeSessionDelegationHealth: SubagentStop's taskCount and tokens land in session scope with the exact reported numbers", () => {
  const root = tmpRoot();
  writeActivity(root, [
    { event: "UserPromptSubmit", sessionId: "S-task", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S-task", at: T + 1 },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 4200, sessionId: "S-task", at: T + 2 },
  ]);
  const result = callSessionHealth(root);
  assert.ok(result);
  const coder = result.agentMetrics.find((m: AgentMetric) => m.id === "coding-specialist");
  assert.ok(coder, "coding-specialist must appear in the session-scoped agentMetrics");
  assert.equal(coder!.taskCount, 1, "SubagentStop's TaskCompleted must be counted -- was 0 before the fix");
  assert.equal(coder!.tokens, 4200, "SubagentStop's tokens must be folded in -- was 0 before the fix (exact figure, not just > 0)");
});

test("_computeSessionDelegationHealth: a record with NO sessionId AFTER a session id is already known inherits into that session", () => {
  const root = tmpRoot();
  writeActivity(root, [
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T },
    // No sessionId here -- mirrors a pre-fix Stop/SubagentStop row written
    // AFTER the session is already established. Must inherit "S1", not be dropped.
    { event: "PreToolUse", tool: "Edit", workerId: "orchestrator", at: T + 1 },
  ]);
  const result = callSessionHealth(root);
  assert.ok(result);
  assert.equal(result.sessionId, "S1");
  assert.equal(result.health.directSearches, 1, "Grep, tagged with S1");
  assert.equal(result.health.directEdits, 1, "Edit with no sessionId must inherit S1 and be counted, not dropped");
});

test("_computeSessionDelegationHealth: a record with NO sessionId BEFORE any session id is known is skipped, not inherited backward", () => {
  const root = tmpRoot();
  writeActivity(root, [
    // No sessionId, and no session established yet -- nothing to inherit into.
    { event: "PreToolUse", tool: "Edit", workerId: "orchestrator", at: T },
    { event: "PreToolUse", tool: "Grep", workerId: "orchestrator", sessionId: "S1", at: T + 1 },
  ]);
  const result = callSessionHealth(root);
  assert.ok(result);
  assert.equal(result.sessionId, "S1");
  assert.equal(result.health.directEdits, 0, "the sessionId-less Edit precedes any known session and must be skipped");
  assert.equal(result.health.directSearches, 1, "Grep, tagged with S1, is counted");
});

test("_computeSessionDelegationHealth: a genuine session boundary (different non-empty sessionId) still resets -- prior session's tokens do not leak forward", () => {
  const root = tmpRoot();
  writeActivity(root, [
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S1", at: T },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 999, sessionId: "S1", at: T + 1 },
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S2", at: T + 2 },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 111, sessionId: "S2", at: T + 3 },
  ]);
  const result = callSessionHealth(root);
  assert.ok(result);
  assert.equal(result.sessionId, "S2");
  const coder = result.agentMetrics.find((m: AgentMetric) => m.id === "coding-specialist");
  assert.ok(coder);
  assert.equal(coder!.tokens, 111, "S1's 999 tokens must not leak into S2's total (would be 1110 if leaked)");
  assert.equal(result.health.tokens, 111, "the aggregate session health.tokens must also exclude S1's 999");
});

test("computeStateFromRecords (cumulative path): the same two-session log's all-time total is unaffected by the session-path fix -- sums BOTH sessions", () => {
  const allRecords: HookRecord[] = [
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S1", at: T },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 999, sessionId: "S1", at: T + 1 },
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", sessionId: "S2", at: T + 2 },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 111, sessionId: "S2", at: T + 3 },
  ];
  const cumulativeState = computeStateFromRecords(allRecords, undefined);
  const coder = cumulativeState.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(coder);
  assert.equal(coder!.tokens, 1110, "cumulative/all-time must sum both sessions (999 + 111) -- proof only the session path moved");
});

// ---------------------------------------------------------------------------
// 0.0.531 fix, THE headline regression: before the fix, Stop never carried
// sessionId, so panel.ts's old unconditional "no sessionId -> skip" loop
// dropped every Stop record from session scope. SessionStop therefore never
// fired for the orchestrator, its workStartAt was never cleared, and each
// SUBSEQUENT turn's SessionStart credited a stale, uncleared stretch to
// activeMs instead of the new fix's clean per-turn finalize. Over many turns
// this is unbounded: each turn boundary adds ~idleFreezeMs worth of phantom
// credit regardless of how short the turn's real work was, which is how a
// real activity.jsonl (many turns since project inception) reached the
// reported ~7811 minutes for 0 real hours of matching work.
//
// This test constructs one session, 6 turns, each with exactly 60s of real
// work (SessionStart -> PreToolUse 30s in -> Stop 60s in), separated by 1
// hour idle gaps -- so total REAL elapsed work is exactly 6 * 60s = 360000ms
// (6 min). Stop records omit sessionId (the exact pre-hook-fix shape) so the
// CURRENT (fixed) panel.ts code path must inherit them into the session.
//
// The buggy comparison value is produced by re-running the same records
// through the OLD unconditional-skip loop (no inheritance) using the real,
// unmodified mapHookRecord/applyEvent/initialWorldState reducers -- only the
// outer skip-vs-inherit loop differs, so the arithmetic is the genuine old
// algorithm, not a guess.
// ---------------------------------------------------------------------------

/**
 * Reproduces the PRE-FIX outer loop from _computeSessionDelegationHealth:
 * a record with no sessionId is unconditionally skipped, never inherited
 * into the current session, regardless of whether a session is already
 * known. Uses the real, unmodified reducer (mapHookRecord/applyEvent) --
 * only this outer scoping loop is the old (buggy) shape.
 */
function foldOldBuggySessionState(records: HookRecord[]): MetricsWorldState {
  let workingState: MetricsWorldState = initialWorldState();
  let workingSessionId: string | undefined;
  for (const record of records) {
    const sid = record.sessionId;
    if (sid === undefined || sid === "") continue; // OLD bug: unconditional skip, no inheritance
    if (workingSessionId === undefined) {
      workingSessionId = sid;
    } else if (sid !== workingSessionId) {
      workingState = initialWorldState();
      workingSessionId = sid;
    }
    for (const event of mapHookRecord(record)) {
      workingState = applyEvent(workingState, event);
    }
  }
  return workingState;
}

test("_computeSessionDelegationHealth: activeMs across 6 turns is bounded by real elapsed work (360000ms), not the ~1050000ms the old skip-only fold produced", () => {
  const SID = "S-compound";
  const HOUR = 3600000;
  const records: HookRecord[] = [];
  let turnStart = T;
  for (let i = 0; i < 6; i++) {
    records.push({ event: "UserPromptSubmit", sessionId: SID, at: turnStart });
    records.push({ event: "PreToolUse", tool: "Read", workerId: "orchestrator", sessionId: SID, at: turnStart + 30000 });
    // Stop omits sessionId -- the exact pre-hook-fix shape this regression guards against.
    records.push({ event: "Stop", at: turnStart + 60000 });
    turnStart = turnStart + 60000 + HOUR; // 1 hour idle gap before the next turn
  }

  const root = tmpRoot();
  writeActivity(root, records);
  const fixed = callSessionHealth(root);
  assert.ok(fixed, "6 turns all tagged with SID (directly or by inheritance) -- a session must be identified");
  const fixedOrch = fixed.agentMetrics.find((m: AgentMetric) => m.id === "orchestrator");
  assert.ok(fixedOrch);

  const buggyState = foldOldBuggySessionState(records);
  const buggyOrch = buggyState.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(buggyOrch);

  const REAL_ELAPSED_WORK_MS = 6 * 60000; // 360000ms = 6 minutes of actual turn spans
  const OLD_BUGGY_ACTIVE_MS = 1050000; // 17.5 minutes -- computed by the same old-loop arithmetic above

  assert.equal(fixedOrch!.activeMs, REAL_ELAPSED_WORK_MS, "fixed path: activeMs must equal exactly the real elapsed work across all 6 turns");
  assert.equal(buggyOrch!.activeMs, OLD_BUGGY_ACTIVE_MS, "sanity: the old skip-only loop reproduces the known-buggy figure");
  assert.notEqual(
    fixedOrch!.activeMs,
    buggyOrch!.activeMs,
    "fixed and buggy totals must genuinely differ (360000ms vs 1050000ms) -- a trivially-equal test would prove nothing"
  );
  assert.ok(
    fixedOrch!.activeMs <= REAL_ELAPSED_WORK_MS,
    "fixed activeMs must never exceed the real elapsed work span -- it must not compound stale, uncleared stretches like the old bug did"
  );
});

// ---------------------------------------------------------------------------
// NOT covered here, by design: whether hooks/tycoon-claude-hook.cjs tags
// concurrent subagents' PreToolUse records with the CORRECT workerId in the
// first place. That hook reads a single shared LIFO stack
// (.claude/tycoon/active-agent.json) via peekActiveAgent — an UNLOCKED read
// (only push/pop take the file lock) that returns whichever agent is
// currently on TOP, with no way to tell which concurrently-running agent's
// own hook process is asking. Two agents spawned in parallel (an explicitly
// supported pattern in this repo's CLAUDE.md "Team Patterns") can push
// interleaved entries; any tool call in flight during that interleaving may
// be attributed to the wrong sibling, and a peek that races a concurrent
// push/pop can read a torn/empty stack and fall back to "orchestrator" for
// what was really a subagent's call. This is a distinct issue from the
// display bug these tests target (that one was pure UI staleness; this one
// is potential MISATTRIBUTION in the source records) — reported, not fixed,
// as part of this investigation.
