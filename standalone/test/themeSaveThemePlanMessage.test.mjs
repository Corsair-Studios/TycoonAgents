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

  const listedIndex = calls.findIndex((c) => c.data?.type === 'THEMES_LIST');
  const savedIndex = calls.findIndex((c) => c.data?.type === 'THEME_PLAN_SAVED');
  assert.ok(listedIndex > savedIndex, 'THEMES_LIST must broadcast after THEME_PLAN_SAVED');
  const themes = calls[listedIndex].data.payload.themes;
  assert.ok(themes.some((theme) => theme.theme_id === themeId));

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
