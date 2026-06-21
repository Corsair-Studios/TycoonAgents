/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import { applyEvent, initialWorldState } from "../src/core/state";
import type { WorldState } from "../src/core/state";

const T = 1700000000000;

function fold(records: HookRecord[]): WorldState {
  let state = initialWorldState();
  for (const record of records) {
    const event = mapHookRecord(record);
    if (event) {
      state = applyEvent(state, event);
    }
  }
  return state;
}

test("SessionStart sets sessionActive true", () => {
  const state = fold([{ event: "UserPromptSubmit", at: T }]);
  assert.equal(state.sessionActive, true);
});

test("SessionStop sets sessionActive false", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "Stop", at: T + 1000 },
  ]);
  assert.equal(state.sessionActive, false);
});

test("WorkerSpawned adds worker in 'arrive' state", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-1", at: T + 100 },
  ]);
  assert.ok(state.workers["w-1"] !== undefined, "worker w-1 should exist");
  assert.equal(state.workers["w-1"].state, "arrive");
  assert.equal(state.workers["w-1"].role, "Task");
});

test("WorkerActivity survey sets worker state to 'survey'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-2", at: T + 100 },
    { event: "PreToolUse", tool: "Read", workerId: "w-2", at: T + 200 },
  ]);
  assert.equal(state.workers["w-2"].state, "survey");
});

test("WorkerActivity build sets worker state to 'build'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-3", at: T + 100 },
    { event: "PreToolUse", tool: "Edit", workerId: "w-3", at: T + 200 },
  ]);
  assert.equal(state.workers["w-3"].state, "build");
});

test("WorkerActivity haul sets worker state to 'haul'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-4", at: T + 100 },
    { event: "PreToolUse", tool: "Write", workerId: "w-4", at: T + 200 },
  ]);
  assert.equal(state.workers["w-4"].state, "haul");
});

test("WorkerStopped sets worker state to 'leave'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-5", at: T + 100 },
    { event: "SubagentStop", workerId: "w-5", at: T + 300 },
  ]);
  assert.equal(state.workers["w-5"].state, "leave");
});

test("Multiple workers can coexist independently", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-a", at: T + 100 },
    { event: "PreToolUse", tool: "Task", workerId: "w-b", at: T + 110 },
    { event: "PreToolUse", tool: "Read", workerId: "w-a", at: T + 200 },
    { event: "PreToolUse", tool: "Edit", workerId: "w-b", at: T + 210 },
  ]);
  assert.equal(state.workers["w-a"].state, "survey");
  assert.equal(state.workers["w-b"].state, "build");
});

test("wire (mcp__) activity maps through ACTIVITY_TO_STATE to 'build'", () => {
  // wire -> "build" via ACTIVITY_TO_STATE in state.ts
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-6", at: T + 100 },
    { event: "PreToolUse", tool: "mcp__some__tool", workerId: "w-6", at: T + 200 },
  ]);
  // wire maps to "build" per ACTIVITY_TO_STATE in state.ts
  assert.equal(state.workers["w-6"].state, "build");
});

test("initialWorldState has no workers and sessionActive false", () => {
  const state = initialWorldState();
  assert.equal(state.sessionActive, false);
  assert.deepEqual(state.workers, {});
  assert.equal(state.completedTasks, 0);
});

test("WorkerActivity on unknown workerId leaves state unchanged", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    // no spawn, so worker doesn't exist
    { event: "PreToolUse", tool: "Read", workerId: "ghost", at: T + 200 },
  ]);
  assert.equal(state.workers["ghost"], undefined);
});
