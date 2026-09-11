// TycoonAgents standalone — Project Plan (phase/task) RESTORE_PLAN_BACKUP
// message handler (project-plan task pC-t2).
//
// SCOPE NOTE: the pC-t2 task brief lists MSG.RESTORE_PLAN_BACKUP alongside
// the theme review-editor messages under a shared "recovery" label, but it
// is a wholly separate, pre-existing feature — the optional Project Plan
// (phase/task approval loop, `.claude/tycoon/plan.json`), not a theme's own
// plan.json under the theme store. Confirmed by reading
// src/host/vscode/panel.ts: MSG.RESTORE_PLAN_BACKUP's only handler there
// copies `<root>/.claude/tycoon/plan.json.bak` back over
// `<root>/.claude/tycoon/plan.json` (via projectPlanFilePath/
// projectPlanBackupFilePath) and reposts PLAN_STATE from `_postPlanState` —
// no theme_id, no ThemeFileStore, no themeService involved anywhere in that
// path. This module is therefore a sibling of, not part of,
// themeGenerationMessages.mjs.
//
// `root` is the standalone's PRIMARY project root (server.mjs's
// `startServer()` resolved `primary.root` — see that module's
// MULTI-DIR SEMANTICS comment), the standalone's analog of panel.ts's
// `_projectRoot()`.
//
// Mirrors panel.ts's `_postPlanState()`/MSG.RESTORE_PLAN_BACKUP branch
// line-for-line, substituting broadcast('message', {...}) for
// `this._panel.webview.postMessage(...)`. Wired from server.mjs: REQUEST_PLAN
// (1249), APPROVE_PHASE (1256), SET_PROJECT_PLAN_ENABLED (1282), and
// RESTORE_PLAN_BACKUP via `case THEME_MSG_WIRE.RESTORE_PLAN_BACKUP` (773,
// calling handleRestorePlanBackup at 775). Only OVERRIDE_TASK is unhandled
// (default case logs it) until a later task adds it.
//
// Node built-ins only. No 'vscode' import, direct or transitive (see
// projectPlanBridge.mjs's header for the load-time guarantee this relies on).

import fs from 'node:fs';
import path from 'node:path';
import * as planBridge from './projectPlanBridge.mjs';
import { MSG_WIRE } from './themeMessages.mjs';

/** `<root>/.claude/tycoon/execution.json`'s `projectPlanEnabled` flag.
 * Mirrors panel.ts's `readProjectPlanEnabled` verbatim — that function is a
 * local, unexported helper in panel.ts (not part of projectPlan.ts's
 * bridgeable surface), so it is reimplemented here (missing file/dir/field
 * all default to `false`, matching the doc comment on the original). */
function readProjectPlanEnabled(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.claude', 'tycoon', 'execution.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && parsed.projectPlanEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Pure computation of the PLAN_STATE payload (no broadcast) — mirrors
 * panel.ts's `_postPlanState()` exactly (same enabled/missing/ok/corrupt
 * branches, same plan.json -> plan.json.bak backup-on-good-read, same
 * archivePlanIfComplete call, same PLAN_STATE payload shape). Exported
 * separately from `postPlanState` so server.mjs's boot-handshake replay
 * (buildBootHandshakeMessages(), sent to every NEW /events connection) can
 * compute the SAME live payload a REQUEST_PLAN round-trip would, instead of
 * a hardcoded stale stub.
 */
export function computePlanState(root) {
  try {
    if (!root || root === '' || !readProjectPlanEnabled(root)) {
      return { type: MSG_WIRE.PLAN_STATE, enabled: false, plan: null, archivedPlans: [], planReadable: true, hasBackup: false };
    }

    const planPath = planBridge.projectPlanFilePath(root);
    const backupPath = planBridge.projectPlanBackupFilePath(root);
    const result = planBridge.readPlanSafe(planPath);

    if (result.status === 'ok') {
      planBridge.archivePlanIfComplete(root, result.plan);
      planBridge.writePlanBackup(root, result.plan, console);
      const archivedPlans = planBridge.readArchivedPlans(root);
      return {
        type: MSG_WIRE.PLAN_STATE,
        enabled: true,
        plan: result.plan,
        archivedPlans,
        planReadable: true,
        hasBackup: fs.existsSync(backupPath),
      };
    }

    if (result.status === 'corrupt') {
      console.warn('[tycoonagents-standalone] plan.json is corrupt, leaving it untouched:', result.error);
    }
    const archivedPlans = planBridge.readArchivedPlans(root);
    return {
      type: MSG_WIRE.PLAN_STATE,
      enabled: true,
      plan: null,
      archivedPlans,
      planReadable: result.status !== 'corrupt',
      ...(result.status === 'corrupt' ? { planError: result.error } : {}),
      hasBackup: fs.existsSync(backupPath),
    };
  } catch (err) {
    console.error('[tycoonagents-standalone] computePlanState failed unexpectedly:', err);
    return { type: MSG_WIRE.PLAN_STATE, enabled: false, plan: null, archivedPlans: [], planReadable: true, hasBackup: false };
  }
}

/** Broadcasts `computePlanState(root)` as a `message` SSE event — mirrors
 * panel.ts's `_postPlanState()` posting side. */
export function postPlanState(root, broadcast) {
  broadcast('message', computePlanState(root));
}

/** Mirrors panel.ts's MSG.APPROVE_PHASE branch (panel.ts ~2623-2673): reads
 * plan.json, sets `phaseId`'s gate to "approved" (+approvedAt), writes
 * plan.json + plan.json.bak, archives if complete, appends one gate-event
 * line with source:"standalone", then reposts fresh PLAN_STATE either way.
 * Unknown/missing phaseId, disabled feature, or an unreadable plan are
 * no-ops that just repost PLAN_STATE (matching panel.ts's early returns). */
export function handleApprovePhase(root, phaseId, broadcast) {
  if (!root || root === '' || typeof phaseId !== 'string' || phaseId === '' || !readProjectPlanEnabled(root)) {
    postPlanState(root, broadcast);
    return;
  }
  try {
    const planPath = planBridge.projectPlanFilePath(root);
    const result = planBridge.readPlanSafe(planPath);
    if (result.status !== 'ok') {
      if (result.status === 'corrupt') {
        console.warn('[tycoonagents-standalone] APPROVE_PHASE aborted, plan.json is corrupt (left untouched):', result.error);
      }
      postPlanState(root, broadcast);
      return;
    }
    const phase = result.plan.phases.find((p) => p.id === phaseId);
    if (!phase) {
      console.warn('[tycoonagents-standalone] APPROVE_PHASE: unknown phaseId', phaseId);
      postPlanState(root, broadcast);
      return;
    }
    const updatedPlan = planBridge.approvePhase(result.plan, phaseId);
    planBridge.writePlan(planPath, updatedPlan);
    planBridge.writePlanBackup(root, updatedPlan, console);
    planBridge.archivePlanIfComplete(root, updatedPlan);
    planBridge.appendGateEvent(
      root,
      {
        ts: new Date().toISOString(),
        phaseId: phase.id,
        phaseNum: phase.num,
        name: phase.name,
        gate: 'approved',
        source: 'standalone',
      },
      console,
    );
  } catch (err) {
    console.error('[tycoonagents-standalone] APPROVE_PHASE failed:', err);
  }
  postPlanState(root, broadcast);
}

/** Mirrors panel.ts's MSG.RESTORE_PLAN_BACKUP branch: best-effort copy
 * plan.json.bak -> plan.json (no-op if there's no backup or no root), then
 * repost fresh PLAN_STATE either way. */
export function handleRestorePlanBackup(root, broadcast) {
  if (!root || root === '') {
    postPlanState(root, broadcast);
    return;
  }
  try {
    const backupPath = planBridge.projectPlanBackupFilePath(root);
    if (fs.existsSync(backupPath)) {
      // No text field on the PLAN_STATE wire shape to surface this on — logged only.
      planBridge.writePreRestoreSnapshot(root, planBridge.projectPlanFilePath(root));
      fs.copyFileSync(backupPath, planBridge.projectPlanFilePath(root));
    }
  } catch (err) {
    console.error('[tycoonagents-standalone] RESTORE_PLAN_BACKUP failed:', err);
  }
  postPlanState(root, broadcast);
}
