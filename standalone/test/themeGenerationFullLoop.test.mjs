// TycoonAgents standalone — smoke coverage for p44-t2, which wired
// PLAN_THEME/GENERATE_THEME through the Corsair Theme Service
// (themeGenerationBridge.mjs's wireThemeServiceGeneration, installed by
// server.mjs's startServer() right after themeServiceHostInstance is
// created). This file previously asserted the p44-parity fail-fast guard
// ("not wired in standalone yet") that handlePlanTheme/handleGenerateTheme
// threw before this task — that guard is gone now that both routes call
// through to setThemeImageGenerator/setThemePlanRequester like panel.ts
// does. This test only asserts the handlers no longer produce that
// standalone-specific gap message — it does not stand up a fake Theme
// Service client end-to-end (that's p44-t4, owned by testing-specialist).
// With no ThemeImageGenerator/ThemePlanRequester wired at all (neither
// handler here calls wireThemeServiceGeneration), themeService.ts's/
// translator.ts's own "not configured"/`ThemeGenerationServiceError`/
// `ThemePlanServiceError` still fires — that's a DIFFERENT failure than the
// standalone-specific guard this file used to assert, so the assertion
// below only checks the old message is gone, not that generation succeeds.
//
// GENERATE_THEME's first board-image failure (unwired -> `kind:
// 'unavailable'`) makes generateAndReviewThemeItem's catch await
// waitForReview(..., {requiresReplacement: true}) for a replacement no
// operator can ever supply — same shape as the hang this file used to
// guard against, just one level down the stack now. Cancelling
// (CANCEL_THEME_GENERATION) immediately resolves that wait via the abort
// signal, so the test below fires the cancel synchronously right after
// starting generation rather than awaiting the call outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsThemeFileStore } from '../src/themeFileStoreFs.mjs';
import { configureThemeFileStore } from '../src/themeGenerationBridge.mjs';
import {
  handlePlanTheme,
  handleGenerateTheme,
  handleCancelThemeGeneration,
  resetThemeGenerationStateForTests,
} from '../src/themeGenerationMessages.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-fullloop-'));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

function callsOfType(calls, type) {
  return calls.filter((c) => c.data?.type === type);
}

test('GENERATE_THEME/PLAN_THEME no longer fail with the retired "not wired in standalone" guard', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  t.after(() => {
    resetThemeGenerationStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const plan = {
    display_name: 'Cozy Pixel Bakery',
    creative_direction: 'warm pastel bakery vibes',
    environment: 'a cozy isometric bakery interior',
    characters: [],
    objects: [],
    decor: [],
    enemies: [],
    expressions: [],
    achievements: [],
  };

  const genCalls = [];
  const genPromise = handleGenerateTheme(store, fakeBroadcast(genCalls), { plan, pause_for_review: false });
  // Fires before the pipeline's first await point resolves (see module
  // header) — cancels rather than hangs on the unwired review gate.
  handleCancelThemeGeneration(fakeBroadcast(genCalls));
  await genPromise;
  const genMessages = [...callsOfType(genCalls, 'THEME_GENERATION_ERROR'), ...callsOfType(genCalls, 'THEME_GENERATION_CANCELLED')];
  assert.ok(genMessages.length > 0, 'GENERATE_THEME must terminate (error or cancelled), never hang');
  for (const msg of genMessages) {
    assert.doesNotMatch(
      msg.data.payload.message,
      /not wired in standalone/i,
      'the p44-parity fail-fast guard must be gone — GENERATE_THEME now calls through to themeService.ts',
    );
  }

  const planCalls = [];
  await handlePlanTheme(store, fakeBroadcast(planCalls), { prompt: 'A cozy pixel-art bakery tycoon' });
  const planError = callsOfType(planCalls, 'THEME_PLAN_ERROR')[0];
  assert.ok(planError, 'THEME_PLAN_ERROR broadcast');
  assert.doesNotMatch(
    planError.data.payload.message,
    /not wired in standalone/i,
    'the p44-parity fail-fast guard must be gone — PLAN_THEME now calls through to translator.ts',
  );
});
