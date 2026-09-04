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
// `this._panel.webview.postMessage(...)`. Only RESTORE_PLAN_BACKUP is wired
// from server.mjs today — REQUEST_PLAN/APPROVE_PHASE/OVERRIDE_TASK/
// SET_PROJECT_PLAN_ENABLED are out of this task's scope and remain
// unhandled (server.mjs's default case logs them) until a later task adds
// full Project Plan routing to the standalone.
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
      try {
        fs.copyFileSync(planPath, backupPath);
      } catch (err) {
        console.warn('[tycoonagents-standalone] failed to write plan.json.bak backup:', err);
      }
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
      fs.copyFileSync(backupPath, planBridge.projectPlanFilePath(root));
    }
  } catch (err) {
    console.error('[tycoonagents-standalone] RESTORE_PLAN_BACKUP failed:', err);
  }
  postPlanState(root, broadcast);
}
