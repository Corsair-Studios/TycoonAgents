/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../src/host/vscode/runtime";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";

const T = 1700000000000;

// A fixed sequence standing in for one full activity.jsonl replay: a session
// start, a Task spawn for "coding-specialist", one SubagentStop (completes a
// task + finalizes tokens), and a Stop for the orchestrator.
const RECORDS: HookRecord[] = [
  { event: "UserPromptSubmit", at: T },
  { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", at: T + 100 },
  { event: "SubagentStop", workerId: "coding-specialist", tokens: 500, at: T + 600 },
  { event: "Stop", workerId: "orchestrator", tokens: 200, model: "claude-opus-4-6", at: T + 900 },
];

/** Replay RECORDS into `runtime` via mapHookRecord, mirroring ClaudeCodeProvider's ingest path. */
function replay(runtime: Runtime): void {
  for (const record of RECORDS) {
    for (const event of mapHookRecord(record)) {
      runtime.ingest(event);
    }
  }
}

test("Runtime.reset(): fresh replay after reset matches a single fresh replay (no doubling)", () => {
  // (a) First full replay, capture baseline counts.
  const runtimeA = new Runtime();
  replay(runtimeA);
  const baselineCoder = runtimeA.getState().agentMetrics.find((m) => m.id === "coding-specialist");
  const baselineOrch = runtimeA.getState().agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(baselineCoder, "coding-specialist metric must exist after first replay");
  assert.ok(baselineOrch, "orchestrator metric must exist after first replay");
  assert.equal(baselineCoder!.taskCount, 1);
  assert.equal(baselineCoder!.tokens, 500);
  assert.equal(baselineOrch!.tokens, 200);

  // (b) Simulate panel close/reopen: reset(), re-seed a WorkerRegistered (as
  // extension.ts does before creating a fresh ClaudeCodeProvider), then replay
  // the SAME sequence again on the SAME Runtime instance (object identity
  // preserved -- this is what TycoonPanel holds a reference to).
  runtimeA.reset();
  runtimeA.ingest({
    type: "WorkerRegistered",
    at: Date.now(),
    workerId: "coding-specialist",
    name: "Coding Specialist",
  });
  replay(runtimeA);

  const afterResetCoder = runtimeA.getState().agentMetrics.find((m) => m.id === "coding-specialist");
  const afterResetOrch = runtimeA.getState().agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(afterResetCoder);
  assert.ok(afterResetOrch);

  // Counts after reset+replay must EQUAL the single-replay baseline, not double.
  assert.equal(afterResetCoder!.taskCount, baselineCoder!.taskCount, "taskCount must equal baseline, not double");
  assert.equal(afterResetCoder!.tokens, baselineCoder!.tokens, "tokens must equal baseline, not double");
  assert.equal(afterResetOrch!.tokens, baselineOrch!.tokens, "orchestrator tokens must equal baseline, not double");
});

test("Runtime.reset(): preserves object identity (same Runtime instance, state replaced in place)", () => {
  const runtime = new Runtime();
  replay(runtime);
  assert.notEqual(runtime.getState().agentMetrics.length, 0, "state should be populated before reset");

  runtime.reset();

  assert.deepEqual(runtime.getState().agentMetrics, [], "agentMetrics must be empty immediately after reset");
  assert.equal(runtime.getState().sessionActive, false);
  assert.equal(runtime.getState().completedTasks, 0);
});

test("Runtime.reset(): notifies onChange listeners", () => {
  const runtime = new Runtime();
  replay(runtime);

  let notified = false;
  runtime.onChange((s) => {
    notified = true;
    assert.deepEqual(s.agentMetrics, [], "listener should observe the reset (empty) state");
  });

  runtime.reset();
  assert.equal(notified, true, "reset() must notify subscribed listeners");
});

test("REGRESSION (documents the bug): replaying WITHOUT reset() doubles counts", () => {
  // This is the old, buggy behavior: re-ingesting the same activity.jsonl
  // records into a still-populated Runtime (no reset in between) doubles
  // every accumulated counter. This test exists to catch a future regression
  // that removes the reset() call from extension.ts's panel-reopen path.
  const runtime = new Runtime();
  replay(runtime);
  const once = runtime.getState().agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(once);
  const onceTaskCount = once!.taskCount;
  const onceTokens = once!.tokens;

  // Replay again WITHOUT calling reset() -- simulates the pre-fix extension.ts.
  replay(runtime);
  const twice = runtime.getState().agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(twice);
  assert.equal(twice!.taskCount, onceTaskCount * 2, "without reset, taskCount doubles on a second replay");
  assert.equal(twice!.tokens, onceTokens * 2, "without reset, tokens double on a second replay");
});
