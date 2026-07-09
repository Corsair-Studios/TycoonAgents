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
import {
  ProjectPlanSchema,
  parseProjectPlan,
  nextRunnableTask,
  applyTaskResult,
  approvePhase,
  overrideTask,
  isPhaseComplete,
  readPlan,
  writePlan,
} from "../src/host/vscode/projectPlan";
import type { ProjectPlan, PlanTask, PlanPhase } from "../src/shared/types";

// ---------------------------------------------------------------------------
// Fixture: 2 phases, 3 tasks with a cross-task dependency and a
// cross-phase gate to exercise.
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<PlanTask> & Pick<PlanTask, "id" | "phaseId">): PlanTask {
  return {
    title: overrides.title ?? overrides.id,
    detail: "detail",
    acceptanceCriteria: ["works"],
    status: "pending",
    verifyAttempts: 0,
    ...overrides,
  };
}

function makeFixturePlan(): ProjectPlan {
  const phaseA: PlanPhase = {
    id: "phase-a",
    num: 1,
    name: "Phase A",
    goal: "Get A done",
    gate: "pending",
    taskIds: ["task-1", "task-2"],
  };
  const phaseB: PlanPhase = {
    id: "phase-b",
    num: 2,
    name: "Phase B",
    goal: "Get B done",
    gate: "pending",
    taskIds: ["task-3"],
  };
  const task1 = makeTask({ id: "task-1", phaseId: "phase-a" });
  const task2 = makeTask({ id: "task-2", phaseId: "phase-a", dependsOn: ["task-1"] });
  const task3 = makeTask({ id: "task-3", phaseId: "phase-b" });
  return {
    version: 1,
    title: "Fixture Plan",
    phases: [phaseA, phaseB],
    tasks: [task1, task2, task3],
    currentPhaseId: "phase-a",
    currentTaskId: "task-1",
  };
}

// ---------------------------------------------------------------------------
// parseProjectPlan / ProjectPlanSchema
// ---------------------------------------------------------------------------

test("parseProjectPlan: a valid plan parses without throwing and round-trips fields", () => {
  const plan = makeFixturePlan();
  const parsed = parseProjectPlan(plan);
  assert.deepEqual(parsed, plan);
});

test("ProjectPlanSchema: valid plan passes .safeParse", () => {
  const plan = makeFixturePlan();
  const result = ProjectPlanSchema.safeParse(plan);
  assert.equal(result.success, true);
});

test("parseProjectPlan: throws when a required field is missing", () => {
  const plan = makeFixturePlan();
  const malformed = { ...plan, tasks: [{ ...plan.tasks[0] }] };
  // Drop a required field from the single task.
  delete (malformed.tasks[0] as Record<string, unknown>).acceptanceCriteria;
  assert.throws(() => parseProjectPlan(malformed));
});

test("parseProjectPlan: throws when a task status is not a valid enum value", () => {
  const plan = makeFixturePlan();
  const malformed = {
    ...plan,
    tasks: [{ ...plan.tasks[0], status: "not_a_real_status" }, ...plan.tasks.slice(1)],
  };
  assert.throws(() => parseProjectPlan(malformed));
});

// ---------------------------------------------------------------------------
// nextRunnableTask
// ---------------------------------------------------------------------------

test("nextRunnableTask: returns the first pending task whose deps are satisfied", () => {
  const plan = makeFixturePlan();
  const next = nextRunnableTask(plan);
  assert.ok(next);
  assert.equal(next?.id, "task-1");
});

test("nextRunnableTask: returns null when the only pending task's dependsOn isn't done", () => {
  const plan = makeFixturePlan();
  // task-1 done would unlock task-2, but here task-1 is merely "active" (not
  // done/skipped), so task-2's dependency is unsatisfied and task-1 itself is
  // no longer "pending" -> nothing runnable.
  const withActiveTask1: ProjectPlan = {
    ...plan,
    tasks: plan.tasks.map((t) => (t.id === "task-1" ? { ...t, status: "active" as const } : t)),
  };
  const next = nextRunnableTask(withActiveTask1);
  assert.equal(next, null);
});

test("nextRunnableTask: a later-phase task is not returned until all earlier phases are gate-approved", () => {
  const plan = makeFixturePlan();
  // Complete phase A's tasks but do NOT approve the phase gate yet.
  const phaseADone: ProjectPlan = {
    ...plan,
    tasks: plan.tasks.map((t) =>
      t.phaseId === "phase-a" ? { ...t, status: "done" as const } : t
    ),
  };
  assert.equal(nextRunnableTask(phaseADone), null, "phase B task must stay blocked until gate approval");

  const phaseAApproved = approvePhase(phaseADone, "phase-a");
  const next = nextRunnableTask(phaseAApproved);
  assert.equal(next?.id, "task-3", "phase B task becomes runnable once phase A is approved");
});

// ---------------------------------------------------------------------------
// applyTaskResult
// ---------------------------------------------------------------------------

test("applyTaskResult: passed sets task status to done", () => {
  const plan = makeFixturePlan();
  const out = applyTaskResult(plan, "task-1", true);
  const task = out.tasks.find((t) => t.id === "task-1");
  assert.equal(task?.status, "done");
});

test("applyTaskResult: failed under retryLimit increments attempts and goes back to active", () => {
  const plan = makeFixturePlan();
  const out = applyTaskResult(plan, "task-1", false, 2);
  const task = out.tasks.find((t) => t.id === "task-1");
  assert.equal(task?.verifyAttempts, 1);
  assert.equal(task?.status, "active");
});

test("applyTaskResult: failed at retryLimit becomes needs_fix", () => {
  const plan = makeFixturePlan();
  const onceFailed = applyTaskResult(plan, "task-1", false, 2);
  const twiceFailed = applyTaskResult(onceFailed, "task-1", false, 2);
  const task = twiceFailed.tasks.find((t) => t.id === "task-1");
  assert.equal(task?.verifyAttempts, 2);
  assert.equal(task?.status, "needs_fix");
});

test("applyTaskResult: does not mutate the input plan (immutable update)", () => {
  const plan = makeFixturePlan();
  const snapshot = JSON.parse(JSON.stringify(plan));
  applyTaskResult(plan, "task-1", true);
  applyTaskResult(plan, "task-2", false, 2);
  assert.deepEqual(plan, snapshot, "original plan object must be unchanged after calls");
});

// ---------------------------------------------------------------------------
// approvePhase
// ---------------------------------------------------------------------------

test("approvePhase: sets the target phase's gate to approved", () => {
  const plan = makeFixturePlan();
  const out = approvePhase(plan, "phase-a");
  const phase = out.phases.find((p) => p.id === "phase-a");
  assert.equal(phase?.gate, "approved");
});

test("approvePhase: unblocks the next phase's tasks in nextRunnableTask", () => {
  const plan = makeFixturePlan();
  const phaseADone: ProjectPlan = {
    ...plan,
    tasks: plan.tasks.map((t) =>
      t.phaseId === "phase-a" ? { ...t, status: "done" as const } : t
    ),
  };
  assert.equal(nextRunnableTask(phaseADone), null);
  const approved = approvePhase(phaseADone, "phase-a");
  assert.equal(nextRunnableTask(approved)?.id, "task-3");
});

test("approvePhase: does not mutate the input plan", () => {
  const plan = makeFixturePlan();
  const snapshot = JSON.parse(JSON.stringify(plan));
  approvePhase(plan, "phase-a");
  assert.deepEqual(plan, snapshot);
});

// ---------------------------------------------------------------------------
// overrideTask
// ---------------------------------------------------------------------------

test('overrideTask: "approve" sets status to done', () => {
  const plan = makeFixturePlan();
  const out = overrideTask(plan, "task-1", "approve");
  assert.equal(out.tasks.find((t) => t.id === "task-1")?.status, "done");
});

test('overrideTask: "skip" sets status to skipped', () => {
  const plan = makeFixturePlan();
  const out = overrideTask(plan, "task-1", "skip");
  assert.equal(out.tasks.find((t) => t.id === "task-1")?.status, "skipped");
});

test('overrideTask: "retry" sets status to active and resets verifyAttempts to 0', () => {
  const plan = makeFixturePlan();
  const failedTwice = applyTaskResult(applyTaskResult(plan, "task-1", false, 2), "task-1", false, 2);
  assert.equal(failedTwice.tasks.find((t) => t.id === "task-1")?.verifyAttempts, 2);

  const out = overrideTask(failedTwice, "task-1", "retry");
  const task = out.tasks.find((t) => t.id === "task-1");
  assert.equal(task?.status, "active");
  assert.equal(task?.verifyAttempts, 0);
});

test("overrideTask: does not mutate the input plan", () => {
  const plan = makeFixturePlan();
  const snapshot = JSON.parse(JSON.stringify(plan));
  overrideTask(plan, "task-1", "approve");
  assert.deepEqual(plan, snapshot);
});

// ---------------------------------------------------------------------------
// isPhaseComplete
// ---------------------------------------------------------------------------

test("isPhaseComplete: false while any task in the phase is not done/skipped", () => {
  const plan = makeFixturePlan();
  assert.equal(isPhaseComplete(plan, "phase-a"), false);
});

test("isPhaseComplete: true once all tasks in the phase are done or skipped", () => {
  const plan = makeFixturePlan();
  const out = overrideTask(overrideTask(plan, "task-1", "approve"), "task-2", "skip");
  assert.equal(isPhaseComplete(out, "phase-a"), true);
  // Phase B still has its lone pending task.
  assert.equal(isPhaseComplete(out, "phase-b"), false);
});

// ---------------------------------------------------------------------------
// readPlan / writePlan
// ---------------------------------------------------------------------------

test("writePlan then readPlan round-trips an equal plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projectPlan-"));
  try {
    const planPath = path.join(dir, "plan.json");
    const plan = makeFixturePlan();
    writePlan(planPath, plan);
    const readBack = readPlan(planPath);
    assert.deepEqual(readBack, plan);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readPlan on a missing path returns null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projectPlan-"));
  try {
    const missingPath = path.join(dir, "does-not-exist.json");
    assert.equal(readPlan(missingPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
