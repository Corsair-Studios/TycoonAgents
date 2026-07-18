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
  readPlanSafe,
  writePlan,
  projectPlanBackupFilePath,
} from "../src/host/vscode/projectPlan";
import type { ProjectPlan, PlanTask, PlanPhase } from "../src/shared/types";

/*
 * Covers the plan.json corruption fix: readPlanSafe(filePath) must NEVER
 * throw, resolving instead to {status:"missing"|"corrupt"|"ok"}. This is the
 * non-throwing counterpart to the existing throwing readPlan (see
 * test/projectPlan.test.ts), added so a corrupted plan.json can't crash
 * panel.ts's _postPlanState (src/host/vscode/panel.ts ~5459-5513).
 */

// ---------------------------------------------------------------------------
// Fixture: same shape as test/projectPlan.test.ts's fixture (2 phases, 3
// tasks) so this suite reads the same way as the rest of the plan tests.
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

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projectPlanReadSafe-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reproduces the real corruption bug: two adjacent objects in a compact JSON
 * array (`...task1...},{...task2...`) with the `},{` boundary dropped, so
 * they run together into invalid JSON (a stray `"id"` key immediately after
 * task1's last value, no comma/brace between them) instead of two separate
 * objects.
 */
function dropTaskBoundary(plan: ProjectPlan): string {
  const json = JSON.stringify(plan);
  const tasksIdx = json.indexOf('"tasks":[');
  assert.ok(tasksIdx > -1, "fixture JSON must contain a tasks array");
  const boundaryIdx = json.indexOf("},{", tasksIdx);
  assert.ok(boundaryIdx > -1, "fixture must have at least 2 adjacent task objects to corrupt");
  return json.slice(0, boundaryIdx) + json.slice(boundaryIdx + "},{".length);
}

// ---------------------------------------------------------------------------
// readPlanSafe
// ---------------------------------------------------------------------------

test("readPlanSafe: missing file -> status missing", () => {
  withTempDir((dir) => {
    const planPath = path.join(dir, "does-not-exist.json");
    let result;
    assert.doesNotThrow(() => {
      result = readPlanSafe(planPath);
    });
    assert.deepEqual(result, { status: "missing" });
  });
});

test("readPlanSafe: zero-byte/empty file -> status corrupt", () => {
  withTempDir((dir) => {
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(planPath, "");
    let result: ReturnType<typeof readPlanSafe> | undefined;
    assert.doesNotThrow(() => {
      result = readPlanSafe(planPath);
    });
    assert.equal(result?.status, "corrupt");
    if (result?.status === "corrupt") {
      assert.match(result.error, /empty/i);
    }
  });
});

test("readPlanSafe: whitespace-only file -> status corrupt (still treated as empty)", () => {
  withTempDir((dir) => {
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(planPath, "   \n\t  ");
    let result: ReturnType<typeof readPlanSafe> | undefined;
    assert.doesNotThrow(() => {
      result = readPlanSafe(planPath);
    });
    assert.equal(result?.status, "corrupt");
  });
});

test("readPlanSafe: malformed JSON (dropped },{ boundary between two tasks, the real bug) -> status corrupt", () => {
  withTempDir((dir) => {
    const planPath = path.join(dir, "plan.json");
    const corrupted = dropTaskBoundary(makeFixturePlan());
    // Sanity check the corruption actually produces invalid JSON, so this
    // test exercises readPlanSafe's catch path and not a no-op edit.
    assert.throws(() => JSON.parse(corrupted));
    fs.writeFileSync(planPath, corrupted);

    let result: ReturnType<typeof readPlanSafe> | undefined;
    assert.doesNotThrow(() => {
      result = readPlanSafe(planPath);
    });
    assert.equal(result?.status, "corrupt");
    if (result?.status === "corrupt") {
      assert.ok(result.error.length > 0, "corrupt result should carry a non-empty error message");
    }
  });
});

test("readPlanSafe: schema-invalid JSON (valid JSON, wrong shape) -> status corrupt", () => {
  withTempDir((dir) => {
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify({ foo: "bar", not: "a plan" }));

    let result: ReturnType<typeof readPlanSafe> | undefined;
    assert.doesNotThrow(() => {
      result = readPlanSafe(planPath);
    });
    assert.equal(result?.status, "corrupt");
  });
});

test("readPlanSafe: a task with an invalid status enum value -> status corrupt", () => {
  withTempDir((dir) => {
    const planPath = path.join(dir, "plan.json");
    const plan = makeFixturePlan();
    const malformed = {
      ...plan,
      tasks: [{ ...plan.tasks[0], status: "not_a_real_status" }, ...plan.tasks.slice(1)],
    };
    fs.writeFileSync(planPath, JSON.stringify(malformed));

    let result: ReturnType<typeof readPlanSafe> | undefined;
    assert.doesNotThrow(() => {
      result = readPlanSafe(planPath);
    });
    assert.equal(result?.status, "corrupt");
  });
});

test("readPlanSafe: a valid plan written by writePlan -> status ok, plan deep-equals", () => {
  withTempDir((dir) => {
    const planPath = path.join(dir, "plan.json");
    const plan = makeFixturePlan();
    writePlan(planPath, plan);

    let result: ReturnType<typeof readPlanSafe> | undefined;
    assert.doesNotThrow(() => {
      result = readPlanSafe(planPath);
    });
    assert.equal(result?.status, "ok");
    if (result?.status === "ok") {
      assert.deepEqual(result.plan, plan);
    }
  });
});

// ---------------------------------------------------------------------------
// projectPlanBackupFilePath
// ---------------------------------------------------------------------------

test("projectPlanBackupFilePath: returns <root>/.claude/tycoon/plan.json.bak (the plan path + .bak)", () => {
  withTempDir((dir) => {
    const expected = path.join(dir, ".claude", "tycoon", "plan.json") + ".bak";
    assert.equal(projectPlanBackupFilePath(dir), expected);
    assert.equal(projectPlanBackupFilePath(dir), path.join(dir, ".claude", "tycoon", "plan.json.bak"));
  });
});
