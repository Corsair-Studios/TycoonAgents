/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "node:fs";
import { z } from "zod";
import type { PlanPhase, PlanTask, ProjectPlan } from "../../shared/types";

/**
 * Optional "Project Plan" feature: a plan of PHASES, each holding TASKS, that
 * the user approves/retries. This module defines ONLY the data model
 * validation, pure state-transition logic, and plan.json file I/O — a skill
 * built separately drives execution. Zero runtime AI calls happen here.
 *
 * The pure transition helpers below (nextRunnableTask, applyTaskResult,
 * approvePhase, overrideTask, isPhaseComplete) intentionally take no fs/vscode
 * imports so they stay unit-testable in isolation; only {@link readPlan} and
 * {@link writePlan} touch the filesystem.
 */

const PlanTaskStatusSchema = z.enum([
  "pending",
  "active",
  "verifying",
  "done",
  "needs_fix",
  "skipped",
  "blocked",
]);

const PlanTaskApprovalSchema = z.enum(["pending", "approved", "retry"]);

const PlanTaskSchema = z.object({
  id: z.string().min(1),
  phaseId: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  agents: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(z.string()).optional(),
  status: PlanTaskStatusSchema,
  verifyAttempts: z.number(),
  approval: PlanTaskApprovalSchema.optional(),
  notes: z.string().optional(),
});

const PlanPhaseSchema = z.object({
  id: z.string().min(1),
  num: z.number(),
  name: z.string(),
  goal: z.string(),
  gate: z.enum(["pending", "approved"]),
  taskIds: z.array(z.string()),
});

/** Zod schema mirroring {@link ProjectPlan} in src/shared/types.ts. */
export const ProjectPlanSchema = z.object({
  version: z.number(),
  title: z.string(),
  phases: z.array(PlanPhaseSchema),
  tasks: z.array(PlanTaskSchema),
  currentPhaseId: z.string().nullable(),
  currentTaskId: z.string().nullable(),
});

/** Parse+validate an unknown value as a {@link ProjectPlan}. Throws on invalid input. */
export function parseProjectPlan(raw: unknown): ProjectPlan {
  return ProjectPlanSchema.parse(raw) as ProjectPlan;
}

// ============================================================================
// Pure state-transition helpers (no fs, no vscode imports)
// ============================================================================

/**
 * A phase is runnable only if every EARLIER phase (lower `num`) has its gate
 * `"approved"`. The phase containing `phaseId` itself does not need to be
 * approved yet — approval gates progression PAST a phase, not into it.
 */
function isPhaseUnblocked(plan: ProjectPlan, phaseId: string): boolean {
  const phase = plan.phases.find((p) => p.id === phaseId);
  if (!phase) return false;
  return plan.phases.every((p) => p.num >= phase.num || p.gate === "approved");
}

/**
 * First task whose status is `"pending"`, whose `dependsOn` are all
 * `"done"`/`"skipped"`, and whose phase is not blocked by an earlier
 * unapproved phase gate. Returns `null` if no task currently qualifies.
 */
export function nextRunnableTask(plan: ProjectPlan): PlanTask | null {
  for (const task of plan.tasks) {
    if (task.status !== "pending") continue;
    if (!isPhaseUnblocked(plan, task.phaseId)) continue;
    const deps = task.dependsOn ?? [];
    const depsSatisfied = deps.every((depId) => {
      const dep = plan.tasks.find((t) => t.id === depId);
      return dep !== undefined && (dep.status === "done" || dep.status === "skipped");
    });
    if (!depsSatisfied) continue;
    return task;
  }
  return null;
}

/**
 * Apply a verification result to a task, returning a NEW plan (immutable
 * update). Passing sets the task `"done"`. Failing increments
 * `verifyAttempts`; while under `retryLimit` the task goes back to
 * `"active"` for a retry, and once the limit is reached it becomes
 * `"needs_fix"` for human intervention.
 */
export function applyTaskResult(
  plan: ProjectPlan,
  taskId: string,
  passed: boolean,
  retryLimit = 2
): ProjectPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      if (task.id !== taskId) return task;
      if (passed) {
        return { ...task, status: "done" };
      }
      const verifyAttempts = task.verifyAttempts + 1;
      return {
        ...task,
        verifyAttempts,
        status: verifyAttempts < retryLimit ? "active" : "needs_fix",
      };
    }),
  };
}

/**
 * Set `phaseId`'s gate to `"approved"` and advance `currentPhaseId` to the
 * next phase (by ascending `num`) that isn't itself already approved. If no
 * such phase exists, `currentPhaseId` becomes `null`.
 */
export function approvePhase(plan: ProjectPlan, phaseId: string): ProjectPlan {
  const phases: PlanPhase[] = plan.phases.map((p) =>
    p.id === phaseId ? { ...p, gate: "approved" as const } : p
  );
  const approvedNum = phases.find((p) => p.id === phaseId)?.num;
  const next =
    approvedNum === undefined
      ? undefined
      : phases
          .filter((p) => p.gate !== "approved" && p.num > approvedNum)
          .sort((a, b) => a.num - b.num)[0];
  return {
    ...plan,
    phases,
    currentPhaseId: next ? next.id : null,
  };
}

/**
 * Human override of a single task's status:
 * - `"approve"` -> `"done"`
 * - `"retry"` -> `"active"`, `verifyAttempts` reset to 0
 * - `"skip"` -> `"skipped"`
 */
export function overrideTask(
  plan: ProjectPlan,
  taskId: string,
  action: "approve" | "retry" | "skip"
): ProjectPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      if (task.id !== taskId) return task;
      switch (action) {
        case "approve":
          return { ...task, status: "done", approval: "approved" as const };
        case "retry":
          return { ...task, status: "active", verifyAttempts: 0, approval: "retry" as const };
        case "skip":
          return { ...task, status: "skipped" };
      }
    }),
  };
}

/** True when every task belonging to `phaseId` is `"done"` or `"skipped"`. */
export function isPhaseComplete(plan: ProjectPlan, phaseId: string): boolean {
  const phase = plan.phases.find((p) => p.id === phaseId);
  if (!phase) return false;
  return phase.taskIds.every((taskId) => {
    const task = plan.tasks.find((t) => t.id === taskId);
    return task !== undefined && (task.status === "done" || task.status === "skipped");
  });
}

// ============================================================================
// File I/O (node fs only)
// ============================================================================

/**
 * Read and validate a plan.json at `planPath`. Returns `null` if the file
 * does not exist. Throws if the file exists but fails JSON parsing or schema
 * validation.
 */
export function readPlan(planPath: string): ProjectPlan | null {
  if (!fs.existsSync(planPath)) return null;
  const raw = fs.readFileSync(planPath, "utf8");
  return parseProjectPlan(JSON.parse(raw));
}

/** Write `plan` to `planPath` as pretty-printed JSON. */
export function writePlan(planPath: string, plan: ProjectPlan): void {
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
}
