/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHookRecord, toolToActivityKind } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";

const T = 1700000000000;

// ---------------------------------------------------------------------------
// Return-type contract: mapHookRecord always returns NormalizedEvent[]
// ---------------------------------------------------------------------------

test("UserPromptSubmit -> [SessionStart] (length 1)", () => {
  const record: HookRecord = { event: "UserPromptSubmit", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events), "result must be an array");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "SessionStart");
  assert.equal(events[0].at, T);
});

test("Stop -> [SessionStop] (length 1)", () => {
  const record: HookRecord = { event: "Stop", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "SessionStop");
  assert.equal(events[0].at, T);
});

// ---------------------------------------------------------------------------
// SubagentStop → [TaskCompleted, WorkerStopped] — order matters
// ---------------------------------------------------------------------------

test("SubagentStop -> array of length 2", () => {
  const record: HookRecord = { event: "SubagentStop", workerId: "agent-1", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 2);
});

test("SubagentStop -> TaskCompleted FIRST, WorkerStopped SECOND", () => {
  const record: HookRecord = { event: "SubagentStop", workerId: "agent-1", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "TaskCompleted");
  assert.equal(events[1].type, "WorkerStopped");
});

test("SubagentStop TaskCompleted carries correct workerId", () => {
  const record: HookRecord = { event: "SubagentStop", workerId: "agent-1", at: T };
  const events = mapHookRecord(record);
  const tc = events[0];
  assert.equal(tc.type, "TaskCompleted");
  if (tc.type === "TaskCompleted") {
    assert.equal(tc.workerId, "agent-1");
  }
});

test("SubagentStop WorkerStopped carries correct workerId", () => {
  const record: HookRecord = { event: "SubagentStop", workerId: "agent-1", at: T };
  const events = mapHookRecord(record);
  const ws = events[1];
  assert.equal(ws.type, "WorkerStopped");
  if (ws.type === "WorkerStopped") {
    assert.equal(ws.workerId, "agent-1");
  }
});

test("SubagentStop with no workerId falls back to 'orchestrator' on both events", () => {
  const record: HookRecord = { event: "SubagentStop", at: T };
  const events = mapHookRecord(record);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "TaskCompleted");
  assert.equal(events[1].type, "WorkerStopped");
  if (events[0].type === "TaskCompleted") {
    assert.equal(events[0].workerId, "orchestrator");
  }
  if (events[1].type === "WorkerStopped") {
    assert.equal(events[1].workerId, "orchestrator");
  }
});

test("SubagentStop with tokens propagates tokens to WorkerStopped", () => {
  const record: HookRecord = { event: "SubagentStop", workerId: "agent-2", tokens: 3500, at: T };
  const events = mapHookRecord(record);
  const ws = events[1];
  assert.equal(ws.type, "WorkerStopped");
  if (ws.type === "WorkerStopped") {
    assert.equal(ws.tokens, 3500);
  }
});

test("SubagentStop without tokens emits WorkerStopped with no tokens field", () => {
  const record: HookRecord = { event: "SubagentStop", workerId: "agent-3", at: T };
  const events = mapHookRecord(record);
  const ws = events[1];
  assert.equal(ws.type, "WorkerStopped");
  if (ws.type === "WorkerStopped") {
    assert.equal(ws.tokens, undefined);
  }
});

// ---------------------------------------------------------------------------
// PreToolUse Task/Agent → [WorkerSpawned, TaskCompleted{workerId:"orchestrator"}]
// ---------------------------------------------------------------------------

test("PreToolUse Task -> array of length 2", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Task", workerId: "sess-1", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 2);
});

test("PreToolUse Task -> WorkerSpawned FIRST with role 'Task'", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Task", workerId: "sess-1", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].role, "Task");
    assert.equal(events[0].workerId, "sess-1");
  }
});

test("PreToolUse Task -> trailing TaskCompleted with workerId 'orchestrator'", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Task", workerId: "sess-1", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[1].type, "TaskCompleted");
  if (events[1].type === "TaskCompleted") {
    assert.equal(events[1].workerId, "orchestrator");
  }
});

test("PreToolUse Agent -> array of length 2 with WorkerSpawned then TaskCompleted", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Agent", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "WorkerSpawned");
  assert.equal(events[1].type, "TaskCompleted");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].role, "Agent");
  }
  if (events[1].type === "TaskCompleted") {
    assert.equal(events[1].workerId, "orchestrator");
  }
});

// ---------------------------------------------------------------------------
// PreToolUse Skill → [WorkerSpawned] ONLY (NO trailing TaskCompleted)
// ---------------------------------------------------------------------------

test("PreToolUse Skill -> array of length 1 (no TaskCompleted)", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Skill", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 1, "Skill spawn must NOT emit a trailing TaskCompleted");
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].role, "Skill");
  }
});

// ---------------------------------------------------------------------------
// PreToolUse non-spawn tool → [WorkerActivity]
// ---------------------------------------------------------------------------

test("PreToolUse Read -> [WorkerActivity survey] (length 1)", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Read", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WorkerActivity");
  if (events[0].type === "WorkerActivity") {
    assert.equal(events[0].kind, "survey");
    assert.equal(events[0].detail, "Read");
  }
});

test("PreToolUse Write -> [WorkerActivity haul]", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Write", at: T };
  const events = mapHookRecord(record);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WorkerActivity");
  if (events[0].type === "WorkerActivity") {
    assert.equal(events[0].kind, "haul");
  }
});

test("PreToolUse Edit -> [WorkerActivity build]", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Edit", at: T };
  const events = mapHookRecord(record);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WorkerActivity");
  if (events[0].type === "WorkerActivity") {
    assert.equal(events[0].kind, "build");
  }
});

test("PreToolUse Bash -> [WorkerActivity shell]", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Bash", at: T };
  const events = mapHookRecord(record);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WorkerActivity");
  if (events[0].type === "WorkerActivity") {
    assert.equal(events[0].kind, "shell");
  }
});

test("PreToolUse mcp__x__y -> [WorkerActivity wire]", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "mcp__x__y", at: T };
  const events = mapHookRecord(record);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WorkerActivity");
  if (events[0].type === "WorkerActivity") {
    assert.equal(events[0].kind, "wire");
  }
});

// ---------------------------------------------------------------------------
// Unmapped / edge cases → []
// ---------------------------------------------------------------------------

test("PreToolUse with no tool -> [] (empty array)", () => {
  const record: HookRecord = { event: "PreToolUse", at: T };
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 0);
});

test("unmapped event -> [] (empty array)", () => {
  // Cast to bypass TypeScript to simulate an unknown event type from a future hook version.
  const record = { event: "SomeFutureEvent", at: T } as unknown as HookRecord;
  const events = mapHookRecord(record);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// Model and agentDescription propagation
// ---------------------------------------------------------------------------

test("PreToolUse Task with model and agentDescription -> WorkerSpawned propagates both", () => {
  const record: HookRecord = {
    event: "PreToolUse",
    tool: "Task",
    workerId: "coding-specialist",
    model: "claude-sonnet-4-6",
    agentDescription: "Writes and edits TypeScript source code",
    at: T,
  };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].model, "claude-sonnet-4-6");
    assert.equal(events[0].description, "Writes and edits TypeScript source code");
    assert.equal(events[0].workerId, "coding-specialist");
  }
});

test("PreToolUse Task without model or agentDescription -> WorkerSpawned has no model/description", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Task", workerId: "sess-2", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].model, undefined);
    assert.equal(events[0].description, undefined);
  }
});

// ---------------------------------------------------------------------------
// parentId/tier propagation (Team Lead Mode Phase 3: hierarchy telemetry)
// ---------------------------------------------------------------------------

test("PreToolUse Task with parentId and tier -> WorkerSpawned propagates both", () => {
  const record: HookRecord = {
    event: "PreToolUse",
    tool: "Task",
    workerId: "coding-specialist",
    parentId: "build-lead",
    tier: "lead",
    at: T,
  };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].parentId, "build-lead");
    assert.equal(events[0].tier, "lead");
  }
});

test("PreToolUse Task without parentId/tier -> WorkerSpawned has undefined parentId/tier (legacy hook record)", () => {
  // Simulates a record written by an OLD hook version that predates parentId/tier.
  const record: HookRecord = { event: "PreToolUse", tool: "Task", workerId: "sess-3", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].parentId, undefined);
    assert.equal(events[0].tier, undefined);
  }
});

// ---------------------------------------------------------------------------
// delegationMode propagation (Team Lead Mode Phase 4: measurement)
// ---------------------------------------------------------------------------

test("PreToolUse Task with delegationMode -> WorkerSpawned propagates it", () => {
  const record: HookRecord = {
    event: "PreToolUse",
    tool: "Task",
    workerId: "coding-specialist",
    delegationMode: "team_leads",
    at: T,
  };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].delegationMode, "team_leads");
  }
});

test("PreToolUse Skill with delegationMode -> WorkerSpawned propagates it", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Skill", delegationMode: "flat", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].delegationMode, "flat");
  }
});

test("Stop with delegationMode -> SessionStop propagates it", () => {
  const record: HookRecord = { event: "Stop", delegationMode: "team_leads", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "SessionStop");
  if (events[0].type === "SessionStop") {
    assert.equal(events[0].delegationMode, "team_leads");
  }
});

test("PreToolUse Task without delegationMode -> WorkerSpawned has undefined delegationMode (legacy hook record)", () => {
  // Simulates a record written by a hook version predating Phase 4.
  const record: HookRecord = { event: "PreToolUse", tool: "Task", workerId: "sess-5", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "WorkerSpawned");
  if (events[0].type === "WorkerSpawned") {
    assert.equal(events[0].delegationMode, undefined);
  }
});

test("Stop without delegationMode -> SessionStop has undefined delegationMode (legacy hook record)", () => {
  const record: HookRecord = { event: "Stop", at: T };
  const events = mapHookRecord(record);
  assert.equal(events[0].type, "SessionStop");
  if (events[0].type === "SessionStop") {
    assert.equal(events[0].delegationMode, undefined);
  }
});

test("mapHookRecord never throws on a record with unexpected extra fields (forward-compat)", () => {
  const record = {
    event: "PreToolUse",
    tool: "Task",
    workerId: "sess-4",
    parentId: "build-lead",
    tier: "lead",
    someFutureField: { nested: true },
    at: T,
  } as unknown as HookRecord;
  assert.doesNotThrow(() => mapHookRecord(record));
});

// ---------------------------------------------------------------------------
// toolToActivityKind direct tests (unchanged)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UUID workerId scrubbing → remapped to "orchestrator"
// ---------------------------------------------------------------------------

test("UUID workerId is remapped to 'orchestrator'", () => {
  const record: HookRecord = {
    event: "SubagentStop",
    workerId: "80cc5964-b3dd-48eb-af81-08506c2e1ea2",
    at: T,
  };
  const events = mapHookRecord(record);
  assert.equal(events.length, 2);
  if (events[0].type === "TaskCompleted") {
    assert.equal(events[0].workerId, "orchestrator");
  }
  if (events[1].type === "WorkerStopped") {
    assert.equal(events[1].workerId, "orchestrator");
  }
});

test("toolToActivityKind: Grep -> survey", () => {
  assert.equal(toolToActivityKind("Grep"), "survey");
});

test("toolToActivityKind: Glob -> survey", () => {
  assert.equal(toolToActivityKind("Glob"), "survey");
});

test("toolToActivityKind: MultiEdit -> build", () => {
  assert.equal(toolToActivityKind("MultiEdit"), "build");
});

test("toolToActivityKind: NotebookEdit -> build", () => {
  assert.equal(toolToActivityKind("NotebookEdit"), "build");
});

test("toolToActivityKind: PowerShell -> shell", () => {
  assert.equal(toolToActivityKind("PowerShell"), "shell");
});

test("toolToActivityKind: mcp__server__tool -> wire", () => {
  assert.equal(toolToActivityKind("mcp__server__tool"), "wire");
});

test("toolToActivityKind: unknown tool -> build (default)", () => {
  assert.equal(toolToActivityKind("SomeFutureTool"), "build");
});
