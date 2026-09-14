// TycoonAgents standalone — coverage for GENERATE_THEME's fail-fast guard
// after p43-t1 rerouted the real themeService.ts pipeline's image
// generation through an injected ThemeImageGenerator seam
// (setThemeImageGenerator/currentThemeImageGenerator in
// out/src/extension/themeService.js) that only the VS Code extension host
// wires up (the Corsair Theme Service client). The standalone never calls
// setThemeImageGenerator, so every real generation attempt threw a
// `ThemeGenerationServiceError({kind:'unavailable'})` on its FIRST image and
// then hung FOREVER: generateAndReviewThemeItem's catch recorded the error
// and awaited waitForReview(..., {requiresReplacement: true}) for a
// replacement image nothing in standalone could ever supply — no operator,
// no review UI, no timeout. `npm run package`'s `npm run test:standalone`
// step hung indefinitely on this file as a result.
//
// This file used to drive the REAL PLAN -> GENERATE -> EDIT -> APPROVE ->
// EXPORT loop end-to-end against a mocked fetch (see git history for that
// version). Standalone theme-image-generation parity is tracked as plan
// p44; until that lands, handleGenerateTheme fails fast BEFORE entering the
// real pipeline (see themeGenerationMessages.mjs's handleGenerateTheme,
// right after requireApiKey), which this test now asserts directly instead
// of exercising a path standalone cannot complete. When p44 wires a real (or
// test-double) ThemeImageGenerator into the standalone, this file should be
// restored to the full authoring-loop coverage described above.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsThemeFileStore } from '../src/themeFileStoreFs.mjs';
import { configureThemeFileStore } from '../src/themeGenerationBridge.mjs';
import { handlePlanTheme, handleGenerateTheme, resetThemeGenerationStateForTests } from '../src/themeGenerationMessages.mjs';

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

function getThemeImageConfig() {
  return { provider: 'openai', openaiApiKey: 'test-key', geminiApiKey: undefined };
}

test('GENERATE_THEME fails fast with a clear message instead of hanging (standalone has no ThemeImageGenerator wired — plan p44)', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  t.after(() => {
    resetThemeGenerationStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A minimal, already-normalized plan shape is enough — GENERATE_THEME
  // must reject before ever touching the real generation pipeline, so no
  // fetch/network mocking is needed here at all.
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
  await handleGenerateTheme(store, fakeBroadcast(genCalls), getThemeImageConfig, {
    plan,
    pause_for_review: false,
    image_provider: 'openai',
  });

  assert.equal(callsOfType(genCalls, 'THEME_GENERATION_CANCELLED').length, 0, 'this is a config failure, not a cancellation');
  assert.equal(callsOfType(genCalls, 'THEME_REVIEW_READY').length, 0, 'must fail before any board is reviewed');
  assert.equal(callsOfType(genCalls, 'THEME_INITIALIZED').length, 0, 'must fail before a theme is initialized');
  const genError = callsOfType(genCalls, 'THEME_GENERATION_ERROR')[0];
  assert.ok(genError, 'THEME_GENERATION_ERROR broadcast');
  assert.match(
    genError.data.payload.message,
    /not wired in standalone/i,
    'error names the standalone-specific gap, not a generic failure',
  );

  // PLAN_THEME is unaffected by the guard — only GENERATE_THEME's image
  // pipeline is unwired — so it still requires (and reports the absence of)
  // a real network call; here it simply confirms handlePlanTheme was never
  // touched by this change by exercising its unrelated API-key validation
  // path deterministically (no fetch mock needed since a missing key fails
  // before any network call).
  const planCalls = [];
  await handlePlanTheme(store, fakeBroadcast(planCalls), () => ({ provider: 'openai', openaiApiKey: undefined }), {
    prompt: 'A cozy pixel-art bakery tycoon',
  });
  const planError = callsOfType(planCalls, 'THEME_PLAN_ERROR')[0];
  assert.ok(planError, 'THEME_PLAN_ERROR broadcast for a missing API key');
  assert.match(planError.data.payload.message, /No OpenAI API key/);
});
