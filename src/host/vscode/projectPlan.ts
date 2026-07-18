/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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

/**
 * One row of the "Archived Plans" list the panel shows. Deliberately a
 * lightweight summary (not the full {@link ProjectPlan}) — the webview lists
 * many archived plans at once and doesn't need per-task detail.
 */
export const ArchivedPlanSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  phaseCount: z.number(),
  taskCount: z.number(),
  doneCount: z.number(),
  skippedCount: z.number(),
  archivedAt: z.number(),
});

export type ArchivedPlanSummary = z.infer<typeof ArchivedPlanSummarySchema>;

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
 *
 * Prefer {@link readPlanSafe} at any call site that must not crash on a
 * corrupted plan.json (e.g. a dropped `},{` boundary between two hand/skill-
 * edited task objects) — this function is kept for callers that intentionally
 * want the throw-on-invalid behavior.
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

/** Result of {@link readPlanSafe}: a discriminated-by-`status` read outcome that never throws. */
export type ReadPlanResult =
  | { status: "ok"; plan: ProjectPlan }
  | { status: "missing" }
  | { status: "corrupt"; error: string };

/**
 * Non-throwing counterpart to {@link readPlan}. Reuses the same parse/
 * validate logic, but wraps it so a corrupted plan.json (invalid JSON,
 * truncated/merged objects, or a schema mismatch) can never propagate an
 * uncaught exception into a caller like `_postPlanState` — instead it's
 * reported as `{status:"corrupt"}` so the caller can surface it to the user
 * and leave the on-disk file untouched.
 *
 * - Missing file -> `{status:"missing"}` (the normal no-plan-yet state).
 * - Empty/malformed JSON or Zod-schema-invalid -> `{status:"corrupt", error}`.
 * - Valid -> `{status:"ok", plan}`.
 */
export function readPlanSafe(filePath: string): ReadPlanResult {
  try {
    if (!fs.existsSync(filePath)) return { status: "missing" };
    const raw = fs.readFileSync(filePath, "utf8");
    if (raw.trim() === "") return { status: "corrupt", error: "plan.json is empty" };
    const plan = parseProjectPlan(JSON.parse(raw));
    return { status: "ok", plan };
  } catch (err) {
    return { status: "corrupt", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Backup path for a plan.json: `<planPath>.bak`, written on every good read (see `_postPlanState`). */
export function projectPlanBackupFilePath(root: string): string {
  return path.join(root, ".claude", "tycoon", "plan.json.bak");
}

// ============================================================================
// Completed-plan archive (pure predicate/fingerprint + fs I/O)
// ============================================================================

/**
 * `true` iff the plan is BOTH complete AND fully approved: at least one
 * phase exists, every phase's `gate` is `"approved"`, and every task's
 * `status` is `"done"` or `"skipped"`. Either condition failing (an
 * unapproved gate, or an in-flight task) means the plan is not archivable
 * yet.
 */
export function isPlanCompleteApproved(plan: ProjectPlan): boolean {
  if (plan.phases.length === 0) return false;
  if (plan.tasks.length === 0) return false;
  const allGatesApproved = plan.phases.every((p) => p.gate === "approved");
  const allTasksSettled = plan.tasks.every((t) => t.status === "done" || t.status === "skipped");
  return allGatesApproved && allTasksSettled;
}

/**
 * Deterministically stringify `value` with object keys sorted, so two
 * structurally-equal objects with differently-ordered keys produce identical
 * output. Array order is preserved (order is meaningful there).
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(",");
  return `{${body}}`;
}

/**
 * Stable content hash of `plan`: a 12-hex-char prefix of the SHA-1 of the
 * plan canonically stringified (sorted object keys). Same plan content ->
 * same fingerprint regardless of key order; any content change -> a
 * different fingerprint. Used as the archive filename/id so re-archiving the
 * same completed plan is a no-op (see {@link archivePlanIfComplete}).
 */
export function planFingerprint(plan: ProjectPlan): string {
  return crypto.createHash("sha1").update(canonicalStringify(plan)).digest("hex").slice(0, 12);
}

/** Directory holding archived-plan snapshots: `<root>/.claude/tycoon/plans/`. */
export function projectPlanArchiveDir(root: string): string {
  return path.join(root, ".claude", "tycoon", "plans");
}

/**
 * If `plan` is complete-and-approved (see {@link isPlanCompleteApproved}),
 * archive a verbatim snapshot of it to `<archiveDir>/plan-<fingerprint>.json`
 * — UNLESS a file with that exact fingerprint already exists, in which case
 * this is a no-op (idempotent: calling this repeatedly for the same
 * completed plan content never creates more than one file). The plan is
 * written byte-for-byte as JSON with no extra fields, so the archived file's
 * own content still hashes to the same fingerprint; "archived at" time is
 * derived from the file's mtime on read (see {@link readArchivedPlans}),
 * never embedded in the snapshot itself.
 *
 * Never throws — this runs inside `_postPlanState` on every plan.json
 * change, and a filesystem hiccup here must not break posting plan state to
 * the webview. Returns the archive fingerprint/id when the plan is
 * complete-approved (whether newly archived or already archived), or `null`
 * when the plan isn't archivable or an error occurred.
 */
export function archivePlanIfComplete(root: string, plan: ProjectPlan): string | null {
  try {
    if (!isPlanCompleteApproved(plan)) return null;
    const fingerprint = planFingerprint(plan);
    const dir = projectPlanArchiveDir(root);
    const target = path.join(dir, `plan-${fingerprint}.json`);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, JSON.stringify(plan, null, 2));
    }
    return fingerprint;
  } catch (err) {
    console.error("TycoonAgents: archivePlanIfComplete failed:", err);
    return null;
  }
}

/**
 * Read every archived plan snapshot under `<root>/.claude/tycoon/plans/` and
 * summarize each as an {@link ArchivedPlanSummary}, sorted newest-first by
 * `archivedAt` (the archive file's mtime). A malformed/non-plan `.json` file
 * is skipped rather than throwing, so one corrupt archive can't take down
 * the whole list. A missing/empty directory returns `[]`.
 */
export function readArchivedPlans(root: string): ArchivedPlanSummary[] {
  const dir = projectPlanArchiveDir(root);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const summaries: ArchivedPlanSummary[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const plan = parseProjectPlan(JSON.parse(raw));
      const stat = fs.statSync(filePath);
      const idFromName = /^plan-([0-9a-f]+)\.json$/.exec(entry)?.[1];
      summaries.push({
        id: idFromName ?? planFingerprint(plan),
        title: plan.title,
        phaseCount: plan.phases.length,
        taskCount: plan.tasks.length,
        doneCount: plan.tasks.filter((t) => t.status === "done").length,
        skippedCount: plan.tasks.filter((t) => t.status === "skipped").length,
        archivedAt: stat.mtimeMs,
      });
    } catch {
      // Malformed/non-plan file — skip it, don't let one bad file break the list.
      continue;
    }
  }

  summaries.sort((a, b) => b.archivedAt - a.archivedAt);
  return summaries;
}
