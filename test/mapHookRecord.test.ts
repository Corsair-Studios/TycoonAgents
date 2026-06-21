/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHookRecord, toolToActivityKind } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";

const T = 1700000000000;

test("UserPromptSubmit -> SessionStart", () => {
  const record: HookRecord = { event: "UserPromptSubmit", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "SessionStart");
  assert.equal(event!.at, T);
});

test("Stop -> SessionStop", () => {
  const record: HookRecord = { event: "Stop", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "SessionStop");
  assert.equal(event!.at, T);
});

test("SubagentStop -> WorkerStopped with workerId", () => {
  const record: HookRecord = { event: "SubagentStop", workerId: "agent-1", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerStopped");
  if (event!.type === "WorkerStopped") {
    assert.equal(event.workerId, "agent-1");
  }
});

test("SubagentStop with no workerId falls back to 'orchestrator'", () => {
  const record: HookRecord = { event: "SubagentStop", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerStopped");
  if (event!.type === "WorkerStopped") {
    assert.equal(event.workerId, "orchestrator");
  }
});

test("PreToolUse Task -> WorkerSpawned with role 'Task'", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Task", workerId: "sess-1", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerSpawned");
  if (event!.type === "WorkerSpawned") {
    assert.equal(event.role, "Task");
    assert.equal(event.workerId, "sess-1");
  }
});

test("PreToolUse Agent -> WorkerSpawned with role 'Agent'", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Agent", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerSpawned");
  if (event!.type === "WorkerSpawned") {
    assert.equal(event.role, "Agent");
  }
});

test("PreToolUse Skill -> WorkerSpawned with role 'Skill'", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Skill", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerSpawned");
  if (event!.type === "WorkerSpawned") {
    assert.equal(event.role, "Skill");
  }
});

test("PreToolUse Read -> WorkerActivity survey", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Read", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerActivity");
  if (event!.type === "WorkerActivity") {
    assert.equal(event.kind, "survey");
    assert.equal(event.detail, "Read");
  }
});

test("PreToolUse Write -> WorkerActivity haul", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Write", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerActivity");
  if (event!.type === "WorkerActivity") {
    assert.equal(event.kind, "haul");
  }
});

test("PreToolUse Edit -> WorkerActivity build", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Edit", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerActivity");
  if (event!.type === "WorkerActivity") {
    assert.equal(event.kind, "build");
  }
});

test("PreToolUse Bash -> WorkerActivity shell", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "Bash", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerActivity");
  if (event!.type === "WorkerActivity") {
    assert.equal(event.kind, "shell");
  }
});

test("PreToolUse mcp__x__y -> WorkerActivity wire", () => {
  const record: HookRecord = { event: "PreToolUse", tool: "mcp__x__y", at: T };
  const event = mapHookRecord(record);
  assert.ok(event !== null);
  assert.equal(event!.type, "WorkerActivity");
  if (event!.type === "WorkerActivity") {
    assert.equal(event.kind, "wire");
  }
});

test("PreToolUse with no tool -> null", () => {
  const record: HookRecord = { event: "PreToolUse", at: T };
  const event = mapHookRecord(record);
  assert.equal(event, null);
});

// toolToActivityKind direct tests
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
