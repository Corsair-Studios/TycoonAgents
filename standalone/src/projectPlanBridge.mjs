// TycoonAgents standalone — vscode-free bridge onto the REAL Project Plan
// (phase/task) data layer (project-plan task pC-t2, RESTORE_PLAN_BACKUP).
//
// WHY THIS EXISTS: src/host/vscode/projectPlan.ts defines the Project Plan
// feature's pure data model + plan.json/plan.json.bak file I/O
// (readPlanSafe/writePlan/projectPlanFilePath/projectPlanBackupFilePath/
// archivePlanIfComplete/readArchivedPlans). It imports only node:crypto,
// node:fs, node:path, and zod — NO 'vscode' — so its compiled output
// (out/src/host/vscode/projectPlan.js) is require()-able from a bare Node
// process exactly like themeService.js (see themeGenerationBridge.mjs's
// header for the same pattern). This module requires it directly; no
// duplicated plan-file logic exists here.
//
// NOTE: MSG.RESTORE_PLAN_BACKUP is grouped with the theme review-editor
// messages in the pC-t2 task brief as a "recovery" message, but it is NOT
// theme-related — reading src/host/vscode/panel.ts confirmed its handler
// operates on `<projectRoot>/.claude/tycoon/plan.json`(.bak), the Project
// Plan (phase/task) feature's own file, never a theme's plan.json under the
// theme store. See standalone/src/projectPlanMessages.mjs for the handler
// that uses this bridge.
//
// Same lazy-createRequire posture as every other bridge in this dir:
// importing this .mjs file never touches 'out/' or throws — only calling one
// of the exported functions does, and only the FIRST call pays the require()
// cost.
//
// Node built-ins only. No 'vscode' import, direct or transitive.

import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root -> out/src/host/vscode/projectPlan.js
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_PLAN_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'projectPlan.js');

const require = createRequire(import.meta.url);

let _projectPlanModule;
function projectPlanModule() {
  if (!_projectPlanModule) {
    if (!fsSync.existsSync(PROJECT_PLAN_JS)) {
      throw new Error(
        `[tycoonagents-standalone] projectPlanBridge: out/src/host/vscode/projectPlan.js not found at ` +
          `${PROJECT_PLAN_JS}. The compiled \`out/\` directory is missing or stale — run \`npx tsc -p .\` from ` +
          'the repo root first, then restart the standalone server.',
      );
    }
    _projectPlanModule = require(PROJECT_PLAN_JS);
  }
  return _projectPlanModule;
}

/** Non-throwing read of `<root>/.claude/tycoon/plan.json` — see
 * projectPlan.ts's ReadPlanResult ({status:'ok'|'missing'|'corrupt'}). */
export function readPlanSafe(planPath) {
  return projectPlanModule().readPlanSafe(planPath);
}

/** `<root>/.claude/tycoon/plan.json`. NOT exported by projectPlan.ts (it is a
 * local, unexported helper in panel.ts) — reimplemented here verbatim
 * (`path.join(root, ".claude", "tycoon", "plan.json")`, confirmed by reading
 * panel.ts) since it is pure path-joining with no vscode dependency. */
export function projectPlanFilePath(root) {
  return path.join(root, '.claude', 'tycoon', 'plan.json');
}

/** `<root>/.claude/tycoon/plan.json.bak`. */
export function projectPlanBackupFilePath(root) {
  return projectPlanModule().projectPlanBackupFilePath(root);
}

/** Hardened, rotating, shrink-guarded plan.json.bak writer — see
 * projectPlan.ts's writePlanBackup doc comment for full behavior. Call ONLY
 * with an already-parsed/validated `plan` (never raw unvalidated bytes). */
export function writePlanBackup(root, plan, logger) {
  return projectPlanModule().writePlanBackup(root, plan, logger);
}

/** Snapshots the current on-disk plan.json (even if unparsable) before
 * RESTORE_PLAN_BACKUP overwrites it with .bak. Keeps at most 3 snapshots. */
export function writePreRestoreSnapshot(root, planPath, logger) {
  return projectPlanModule().writePreRestoreSnapshot(root, planPath, logger);
}

/** Archives a complete-and-approved plan snapshot (idempotent, no-op otherwise). */
export function archivePlanIfComplete(root, plan) {
  return projectPlanModule().archivePlanIfComplete(root, plan);
}

/** Sets `phaseId`'s gate to `"approved"` (+`approvedAt`) and advances
 * `currentPhaseId` — see projectPlan.ts's approvePhase doc comment. Pure;
 * does not touch disk. */
export function approvePhase(plan, phaseId) {
  return projectPlanModule().approvePhase(plan, phaseId);
}

/** Writes `plan` to `planPath` (plan.json). Call `writePlanBackup` alongside
 * this on the SAME plan for the standard backup-on-write pattern. */
export function writePlan(planPath, plan) {
  return projectPlanModule().writePlan(planPath, plan);
}

/** `<root>/.claude/tycoon/gate-events.jsonl` append-only writer — mirrors
 * panel.ts's MSG.APPROVE_PHASE branch. Creates the file/dir if missing,
 * never truncates, and swallows+logs write failures (never throws). */
export function appendGateEvent(root, event, logger) {
  return projectPlanModule().appendGateEvent(root, event, logger);
}

/** Every archived plan snapshot under `<root>/.claude/tycoon/plans/`, newest-first. */
export function readArchivedPlans(root) {
  return projectPlanModule().readArchivedPlans(root);
}
