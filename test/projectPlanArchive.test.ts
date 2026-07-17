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
  isPlanCompleteApproved,
  planFingerprint,
  projectPlanArchiveDir,
  archivePlanIfComplete,
  readArchivedPlans,
} from "../src/host/vscode/projectPlan";
import type { ProjectPlan, PlanTask, PlanPhase } from "../src/shared/types";

// ---------------------------------------------------------------------------
// Fixture: same shape as test/projectPlan.test.ts's fixture (2 phases, 3
// tasks) so archive tests read the same way as the rest of the plan suite.
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

function makeCompleteApprovedPlan(): ProjectPlan {
  const phaseA: PlanPhase = {
    id: "phase-a",
    num: 1,
    name: "Phase A",
    goal: "Get A done",
    gate: "approved",
    taskIds: ["task-1", "task-2"],
  };
  const phaseB: PlanPhase = {
    id: "phase-b",
    num: 2,
    name: "Phase B",
    goal: "Get B done",
    gate: "approved",
    taskIds: ["task-3"],
  };
  const task1 = makeTask({ id: "task-1", phaseId: "phase-a", status: "done" });
  const task2 = makeTask({ id: "task-2", phaseId: "phase-a", status: "skipped" });
  const task3 = makeTask({ id: "task-3", phaseId: "phase-b", status: "done" });
  return {
    version: 1,
    title: "Fixture Plan",
    phases: [phaseA, phaseB],
    tasks: [task1, task2, task3],
    currentPhaseId: null,
    currentTaskId: null,
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projectPlanArchive-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// isPlanCompleteApproved
// ---------------------------------------------------------------------------

test("isPlanCompleteApproved: all phases approved + all tasks done/skipped -> true", () => {
  assert.equal(isPlanCompleteApproved(makeCompleteApprovedPlan()), true);
});

test("isPlanCompleteApproved: one phase still pending -> false", () => {
  const plan = makeCompleteApprovedPlan();
  plan.phases[1].gate = "pending";
  assert.equal(isPlanCompleteApproved(plan), false);
});

test("isPlanCompleteApproved: one task still active -> false", () => {
  const plan = makeCompleteApprovedPlan();
  plan.tasks[0].status = "active";
  assert.equal(isPlanCompleteApproved(plan), false);
});

test("isPlanCompleteApproved: a skipped task (all phases approved) is still complete-approved", () => {
  const plan = makeCompleteApprovedPlan();
  assert.equal(plan.tasks.some((t) => t.status === "skipped"), true);
  assert.equal(isPlanCompleteApproved(plan), true);
});

test("isPlanCompleteApproved: empty phases -> false", () => {
  const plan = makeCompleteApprovedPlan();
  plan.phases = [];
  assert.equal(isPlanCompleteApproved(plan), false);
});

test("isPlanCompleteApproved: phases all approved but zero tasks -> false (and archives no file)", () => {
  const plan = makeCompleteApprovedPlan();
  plan.tasks = [];
  assert.equal(isPlanCompleteApproved(plan), false);
  withTempDir((root) => {
    const result = archivePlanIfComplete(root, plan);
    assert.equal(result, null);
    assert.equal(fs.existsSync(projectPlanArchiveDir(root)), false);
  });
});

// ---------------------------------------------------------------------------
// planFingerprint
// ---------------------------------------------------------------------------

test("planFingerprint: same plan content -> same fingerprint", () => {
  const plan = makeCompleteApprovedPlan();
  assert.equal(planFingerprint(plan), planFingerprint(makeCompleteApprovedPlan()));
});

test("planFingerprint: key-reordered-but-equal plan -> same fingerprint", () => {
  const plan = makeCompleteApprovedPlan();
  const reordered = {
    currentTaskId: plan.currentTaskId,
    currentPhaseId: plan.currentPhaseId,
    tasks: plan.tasks.map((t) => ({ ...t })).reverse().reverse(), // same array order, rebuilt objects
    phases: [...plan.phases].reverse().reverse(),
    title: plan.title,
    version: plan.version,
  } as unknown as ProjectPlan;
  // Rebuild each task/phase object with reversed key insertion order too.
  reordered.tasks = plan.tasks.map((t) => {
    const entries = Object.entries(t).reverse();
    return Object.fromEntries(entries) as unknown as PlanTask;
  });
  reordered.phases = plan.phases.map((p) => {
    const entries = Object.entries(p).reverse();
    return Object.fromEntries(entries) as unknown as PlanPhase;
  });
  assert.equal(planFingerprint(reordered), planFingerprint(plan));
});

test("planFingerprint: a changed field -> different fingerprint", () => {
  const plan = makeCompleteApprovedPlan();
  const changed = { ...plan, title: "Different Title" };
  assert.notEqual(planFingerprint(changed), planFingerprint(plan));
});

// ---------------------------------------------------------------------------
// archivePlanIfComplete
// ---------------------------------------------------------------------------

test("archivePlanIfComplete: calling twice on the same completed plan creates exactly one file", () => {
  withTempDir((root) => {
    const plan = makeCompleteApprovedPlan();
    const first = archivePlanIfComplete(root, plan);
    const second = archivePlanIfComplete(root, plan);
    assert.notEqual(first, null);
    assert.equal(first, second);
    const files = fs.readdirSync(projectPlanArchiveDir(root));
    assert.deepEqual(files, [`plan-${first}.json`]);
  });
});

test("archivePlanIfComplete: an incomplete plan creates no archive file/dir", () => {
  withTempDir((root) => {
    const plan = makeCompleteApprovedPlan();
    plan.tasks[0].status = "active";
    const result = archivePlanIfComplete(root, plan);
    assert.equal(result, null);
    assert.equal(fs.existsSync(projectPlanArchiveDir(root)), false);
  });
});

test("archivePlanIfComplete: archived file content is byte-verbatim plan JSON (fingerprint round-trips)", () => {
  withTempDir((root) => {
    const plan = makeCompleteApprovedPlan();
    const fp = archivePlanIfComplete(root, plan);
    assert.notEqual(fp, null);
    const raw = fs.readFileSync(path.join(projectPlanArchiveDir(root), `plan-${fp}.json`), "utf8");
    assert.equal(planFingerprint(JSON.parse(raw)), fp);
  });
});

// ---------------------------------------------------------------------------
// readArchivedPlans
// ---------------------------------------------------------------------------

test("readArchivedPlans: missing archive dir returns []", () => {
  withTempDir((root) => {
    assert.deepEqual(readArchivedPlans(root), []);
  });
});

test("readArchivedPlans: returns correct summaries sorted newest-first", () => {
  withTempDir((root) => {
    const planA = { ...makeCompleteApprovedPlan(), title: "Plan A" };
    archivePlanIfComplete(root, planA);

    // Force a distinct mtime ordering: bump the clock forward for the
    // second archive so "newest first" has an unambiguous winner even on
    // filesystems with coarse mtime resolution.
    const dir = projectPlanArchiveDir(root);
    const fpA = planFingerprint(planA);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, `plan-${fpA}.json`), past, past);

    const planB = { ...makeCompleteApprovedPlan(), title: "Plan B" };
    archivePlanIfComplete(root, planB);

    const summaries = readArchivedPlans(root);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].title, "Plan B");
    assert.equal(summaries[1].title, "Plan A");
    assert.ok(summaries[0].archivedAt >= summaries[1].archivedAt);

    const summaryB = summaries[0];
    assert.equal(summaryB.phaseCount, 2);
    assert.equal(summaryB.taskCount, 3);
    assert.equal(summaryB.doneCount, 2);
    assert.equal(summaryB.skippedCount, 1);
    assert.equal(summaryB.id, planFingerprint(planB));
  });
});

test("readArchivedPlans: skips a malformed .json file without throwing", () => {
  withTempDir((root) => {
    const plan = makeCompleteApprovedPlan();
    archivePlanIfComplete(root, plan);
    const dir = projectPlanArchiveDir(root);
    fs.writeFileSync(path.join(dir, "plan-garbage.json"), "{ not valid json");

    const summaries = readArchivedPlans(root);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].title, plan.title);
  });
});

test("readArchivedPlans: empty archive dir (created, no files) returns []", () => {
  withTempDir((root) => {
    fs.mkdirSync(projectPlanArchiveDir(root), { recursive: true });
    assert.deepEqual(readArchivedPlans(root), []);
  });
});
