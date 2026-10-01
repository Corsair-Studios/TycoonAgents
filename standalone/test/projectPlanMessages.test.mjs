// TycoonAgents standalone — unit tests for projectPlanMessages.mjs's
// RESTORE_PLAN_BACKUP handler (project-plan task pC-t2).
//
// SCOPE NOTE (see projectPlanMessages.mjs's header for the full rationale):
// MSG.RESTORE_PLAN_BACKUP is grouped with the theme review-editor messages
// in the pC-t2 task brief as a "recovery" message, but reading
// src/host/vscode/panel.ts confirmed it is the UNRELATED Project Plan
// (phase/task approval loop) feature's own recovery path — it operates on
// `<root>/.claude/tycoon/plan.json`(.bak) via projectPlanFilePath/
// projectPlanBackupFilePath, never a theme's plan.json under the theme
// store. These tests therefore seed a plain `<root>/.claude/tycoon/` tree,
// not a ThemeFileStore.
//
// Deterministic: every test uses its own fs.mkdtempSync tmp dir, cleaned up
// via t.after(). No network. Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRestorePlanBackup, handleApprovePhase, postPlanState } from '../src/projectPlanMessages.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-planrestore-'));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

function seedTycoonDir(root, { enabled = true } = {}) {
  const dir = path.join(root, '.claude', 'tycoon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'execution.json'), JSON.stringify({ projectPlanEnabled: enabled }));
  return dir;
}

const GOOD_PLAN = { version: 1, title: 'Good Plan', phases: [], tasks: [], currentPhaseId: null, currentTaskId: null };

test('handleRestorePlanBackup: restores plan.json from plan.json.bak after a corrupt read, and the write survives a fresh re-read', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = seedTycoonDir(root);
  fs.writeFileSync(path.join(dir, 'plan.json.bak'), JSON.stringify(GOOD_PLAN, null, 2));
  fs.writeFileSync(path.join(dir, 'plan.json'), '{ this is not valid json');

  const calls = [];
  handleRestorePlanBackup(root, fakeBroadcast(calls));

  const planState = calls.find((c) => c.data.type === 'PLAN_STATE');
  assert.ok(planState, 'PLAN_STATE broadcast');
  assert.equal(planState.data.enabled, true);
  assert.equal(planState.data.planReadable, true);
  assert.ok(planState.data.plan, 'plan present after restore');
  assert.equal(planState.data.plan.title, 'Good Plan');

  // Fresh re-read off disk (not the broadcast payload) — the pC-t2 acceptance bar.
  const restored = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  assert.equal(restored.title, 'Good Plan');
});

test('handleRestorePlanBackup: saves a pre-restore snapshot of the original plan.json bytes before overwriting', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = seedTycoonDir(root);
  fs.writeFileSync(path.join(dir, 'plan.json.bak'), JSON.stringify(GOOD_PLAN, null, 2));
  const originalBytes = '{ this is not valid json';
  fs.writeFileSync(path.join(dir, 'plan.json'), originalBytes);

  handleRestorePlanBackup(root, fakeBroadcast([]));

  const snapshots = fs.readdirSync(dir).filter((f) => f.startsWith('plan.json.pre-restore-'));
  assert.equal(snapshots.length, 1, 'exactly one pre-restore snapshot written');
  const snapshotContent = fs.readFileSync(path.join(dir, snapshots[0]), 'utf8');
  assert.equal(snapshotContent, originalBytes, 'snapshot holds the original (corrupt) bytes verbatim');
});

test('handleRestorePlanBackup: no .bak file present is a no-op (plan.json left untouched), still reposts PLAN_STATE', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = seedTycoonDir(root);
  fs.writeFileSync(path.join(dir, 'plan.json'), '{ still corrupt');

  const calls = [];
  handleRestorePlanBackup(root, fakeBroadcast(calls));

  const planState = calls.find((c) => c.data.type === 'PLAN_STATE');
  assert.ok(planState);
  assert.equal(planState.data.planReadable, false, 'still corrupt, no backup to restore from');
  assert.equal(planState.data.hasBackup, false);
  const stillThere = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8');
  assert.equal(stillThere, '{ still corrupt', 'untouched');
});

test('handleRestorePlanBackup: an empty root broadcasts the disabled/no-root PLAN_STATE shape, never throws', (t) => {
  const calls = [];
  handleRestorePlanBackup('', fakeBroadcast(calls));
  const planState = calls.find((c) => c.data.type === 'PLAN_STATE');
  assert.deepEqual(planState.data, {
    type: 'PLAN_STATE',
    enabled: false,
    plan: null,
    archivedPlans: [],
    planReadable: true,
    hasBackup: false,
  });
});

test('postPlanState: explicit projectPlanEnabled:false reports enabled:false with a null plan (feature off)', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedTycoonDir(root, { enabled: false });

  const calls = [];
  postPlanState(root, fakeBroadcast(calls));
  const planState = calls.find((c) => c.data.type === 'PLAN_STATE');
  assert.equal(planState.data.enabled, false);
  assert.equal(planState.data.plan, null);
});

test('postPlanState: projectPlanEnabled absent (never touched) defaults ON and reports enabled:true', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // No execution.json at all, and one with the key missing.
  const calls = [];
  postPlanState(root, fakeBroadcast(calls));
  assert.equal(calls.find((c) => c.data.type === 'PLAN_STATE').data.enabled, true);

  const dir = path.join(root, '.claude', 'tycoon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'execution.json'), JSON.stringify({ delegation_mode: 'flat' }));
  const calls2 = [];
  postPlanState(root, fakeBroadcast(calls2));
  assert.equal(calls2.find((c) => c.data.type === 'PLAN_STATE').data.enabled, true);
});

test('postPlanState: a good plan.json read backs it up to plan.json.bak (best-effort side effect)', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = seedTycoonDir(root);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(GOOD_PLAN, null, 2));
  assert.equal(fs.existsSync(path.join(dir, 'plan.json.bak')), false, 'no .bak yet');

  const calls = [];
  postPlanState(root, fakeBroadcast(calls));

  const planState = calls.find((c) => c.data.type === 'PLAN_STATE');
  assert.equal(planState.data.enabled, true);
  assert.equal(planState.data.plan.title, 'Good Plan');
  assert.equal(planState.data.hasBackup, true);
  assert.ok(fs.existsSync(path.join(dir, 'plan.json.bak')), '.bak written on a good read');
});

const PLAN_WITH_PHASE = {
  version: 1,
  title: 'Gated Plan',
  phases: [{ id: 'p1', num: 1, name: 'Phase One', goal: 'do stuff', gate: 'pending', taskIds: [] }],
  tasks: [],
  currentPhaseId: 'p1',
  currentTaskId: null,
};

test('handleApprovePhase: sets the gate to approved with approvedAt, writes plan.json + .bak, appends one gate-event line, reposts PLAN_STATE', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = seedTycoonDir(root);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN_WITH_PHASE, null, 2));

  const calls = [];
  handleApprovePhase(root, 'p1', fakeBroadcast(calls));

  const planState = calls.find((c) => c.data.type === 'PLAN_STATE');
  assert.ok(planState);
  const phase = planState.data.plan.phases.find((p) => p.id === 'p1');
  assert.equal(phase.gate, 'approved');
  assert.ok(phase.approvedAt, 'approvedAt set');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  assert.equal(onDisk.phases[0].gate, 'approved');
  assert.ok(fs.existsSync(path.join(dir, 'plan.json.bak')), '.bak written');

  const eventsPath = path.join(dir, 'gate-events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one event line');
  const event = JSON.parse(lines[0]);
  assert.equal(event.type, 'gate');
  assert.equal(event.phaseId, 'p1');
  assert.equal(event.phaseNum, 1);
  assert.equal(event.name, 'Phase One');
  assert.equal(event.gate, 'approved');
  assert.equal(event.source, 'standalone');
  assert.ok(event.ts);
});

test('handleApprovePhase: unknown phaseId is a no-op (plan.json untouched), still reposts PLAN_STATE', (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = seedTycoonDir(root);
  const original = JSON.stringify(PLAN_WITH_PHASE, null, 2);
  fs.writeFileSync(path.join(dir, 'plan.json'), original);

  const calls = [];
  handleApprovePhase(root, 'does-not-exist', fakeBroadcast(calls));

  const planState = calls.find((c) => c.data.type === 'PLAN_STATE');
  assert.ok(planState);
  assert.equal(planState.data.plan.phases[0].gate, 'pending', 'unchanged');

  const onDiskRaw = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8');
  assert.equal(onDiskRaw, original, 'plan.json bytes untouched');
  assert.equal(fs.existsSync(path.join(dir, 'gate-events.jsonl')), false, 'no event appended');
});
