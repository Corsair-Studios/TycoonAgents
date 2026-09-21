// TycoonAgents standalone — p76-t3 coverage for SAVE_THEME_PLAN over the
// websocket-equivalent message path: standalone/src/themeGenerationMessages.mjs's
// handleSaveThemePlan (thin pass-through to the real saveThemePlan via
// themeGenerationBridge.mjs's bridge().saveThemePlan) writes theme files into
// a temp fs-backed store and broadcasts THEME_PLAN_SAVED then THEMES_LIST.
// Extends themeGenerationFullLoop.test.mjs's fsThemeFileStore + fakeBroadcast
// pattern. No network: saveThemePlan itself makes no fetch/generation calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsThemeFileStore } from '../src/themeFileStoreFs.mjs';
import { configureThemeFileStore } from '../src/themeGenerationBridge.mjs';
import {
  handleSaveThemePlan,
  resetThemeGenerationStateForTests,
} from '../src/themeGenerationMessages.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-saveplan-'));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

function callsOfType(calls, type) {
  return calls.filter((c) => c.data?.type === type);
}

const plan = {
  display_name: 'Standalone Draft Theme',
  creative_direction: 'Simple flat vector style.',
  environment: 'A quiet workshop.',
  characters: ['Builder'],
  objects: ['Wrench'],
  decor: ['Crate'],
  enemies: ['Rust Golem'],
};

test('SAVE_THEME_PLAN writes theme files under the configured store and broadcasts THEME_PLAN_SAVED then THEMES_LIST', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  t.after(() => {
    resetThemeGenerationStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const calls = [];
  await handleSaveThemePlan(store, fakeBroadcast(calls), { plan });

  const saved = callsOfType(calls, 'THEME_PLAN_SAVED');
  assert.equal(saved.length, 1, 'expected exactly one THEME_PLAN_SAVED broadcast');
  const themeId = saved[0].data.payload.theme_id;
  assert.equal(themeId, 'standalone_draft_theme');
  assert.equal(saved[0].data.payload.plan.characters.length, 16);
  // p77-t3: a freshly saved plan (no frames.json boards written yet) must
  // report hasBoards:false/boardCount:0 (themeBoardCountsFromStore).
  assert.equal(saved[0].data.payload.hasBoards, false);
  assert.equal(saved[0].data.payload.boardCount, 0);

  const listedIndex = calls.findIndex((c) => c.data?.type === 'THEMES_LIST');
  const savedIndex = calls.findIndex((c) => c.data?.type === 'THEME_PLAN_SAVED');
  assert.ok(listedIndex > savedIndex, 'THEMES_LIST must broadcast after THEME_PLAN_SAVED');
  const themes = calls[listedIndex].data.payload.themes;
  const listedTheme = themes.find((theme) => theme.theme_id === themeId);
  assert.ok(listedTheme, 'expected the saved theme in THEMES_LIST');
  assert.equal(listedTheme.hasBoards, false, 'THEMES_LIST entries must carry hasBoards');
  assert.equal(listedTheme.boardCount, 0, 'THEMES_LIST entries must carry boardCount');

  // Real files landed under the configured fs store's root.
  const planPath = path.join(root, 'themes', themeId, 'plan.json');
  const manifestPath = path.join(root, 'themes', themeId, 'manifest.json');
  const framesPath = path.join(root, 'themes', themeId, 'frames.json');
  const reviewPath = path.join(root, 'themes', themeId, 'review.json');
  for (const p of [planPath, manifestPath, framesPath, reviewPath]) {
    assert.ok(fs.existsSync(p), `expected ${p} to exist`);
  }
  const writtenPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.equal(writtenPlan.display_name, 'Standalone Draft Theme');
});

// p79-t3: parity with test/themeSavePlanReviewRepost.test.ts's host
// assertion — panel.ts's SAVE_THEME_PLAN branch and this standalone
// handler both re-post THEME_IMAGE_REVIEW after THEMES_LIST on a re-save
// (~286-290), so the builder's board grid refreshes labels after Save
// theme / the autosave-after-upload cycle.
test('re-saving an existing theme broadcasts a third message, THEME_IMAGE_REVIEW, after THEMES_LIST', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  t.after(() => {
    resetThemeGenerationStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const calls = [];
  await handleSaveThemePlan(store, fakeBroadcast(calls), { plan, theme_id: 'standalone_draft_theme' });
  const themeId = callsOfType(calls, 'THEME_PLAN_SAVED')[0].data.payload.theme_id;

  const secondCalls = [];
  const updatedPlan = { ...plan, display_name: 'Standalone Draft Theme Renamed' };
  await handleSaveThemePlan(store, fakeBroadcast(secondCalls), { plan: updatedPlan, theme_id: themeId });

  assert.equal(secondCalls.length, 3, 'expected exactly THEME_PLAN_SAVED, THEMES_LIST, THEME_IMAGE_REVIEW');
  assert.equal(secondCalls[0].data.type, 'THEME_PLAN_SAVED');
  assert.equal(secondCalls[1].data.type, 'THEMES_LIST');
  assert.equal(secondCalls[2].data.type, 'THEME_IMAGE_REVIEW');
  assert.equal(secondCalls[2].data.payload.theme_id, themeId);
});

test('SAVE_THEME_PLAN with no plan broadcasts THEME_GENERATION_ERROR and writes nothing', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  t.after(() => {
    resetThemeGenerationStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const calls = [];
  await handleSaveThemePlan(store, fakeBroadcast(calls), {});

  const errors = callsOfType(calls, 'THEME_GENERATION_ERROR');
  assert.equal(errors.length, 1);
  assert.equal(callsOfType(calls, 'THEME_PLAN_SAVED').length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'themes')), 'no themes directory should be created on failure');
});
