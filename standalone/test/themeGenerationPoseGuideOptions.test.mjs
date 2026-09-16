// TycoonAgents standalone — p58-t2 review fix coverage: GENERATE_THEME and
// RETRY_THEME_IMAGE must thread `extensionRoot` and `attachWalkPoseGuide`
// into the ThemeImageGenerationOptions object handed to the theme
// generation bridge (genBridge.generateTheme / genBridge.retryThemeImage),
// or the walk-pose-guide attachment (src/extension/poseGuides.ts) silently
// never fires on the standalone host. Stubs the bridge via
// __setThemeGenerationBridgeForTests (see themeGenerationMessages.mjs) so
// this only exercises this module's own option-building, not the real
// Theme Service / image pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsThemeFileStore } from '../src/themeFileStoreFs.mjs';
import { configureThemeFileStore } from '../src/themeGenerationBridge.mjs';
import {
  handleGenerateTheme,
  handleRetryThemeImage,
  resetThemeGenerationStateForTests,
  __setThemeGenerationBridgeForTests,
} from '../src/themeGenerationMessages.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-posefoptions-'));
}

function fakeBroadcast() {
  return () => {};
}

test('GENERATE_THEME passes extensionRoot + attachWalkPoseGuide through to genBridge.generateTheme', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  let capturedOptions;
  __setThemeGenerationBridgeForTests({
    generateTheme: async (_store, _plan, _onProgress, _isCancelled, _onReviewReady, imageOptions) => {
      capturedOptions = imageOptions;
      return { manifest: {}, frames: {} };
    },
  });

  t.after(() => {
    __setThemeGenerationBridgeForTests(null);
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

  await handleGenerateTheme(store, fakeBroadcast(), { plan, pause_for_review: false }, {
    attachWalkPoseGuide: false,
  });

  assert.ok(capturedOptions, 'genBridge.generateTheme should have been called');
  assert.equal(typeof capturedOptions.extensionRoot, 'string');
  assert.ok(capturedOptions.extensionRoot.length > 0);
  assert.equal(capturedOptions.attachWalkPoseGuide, false);
});

test('GENERATE_THEME defaults attachWalkPoseGuide to true when hostOptions omits it', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  let capturedOptions;
  __setThemeGenerationBridgeForTests({
    generateTheme: async (_store, _plan, _onProgress, _isCancelled, _onReviewReady, imageOptions) => {
      capturedOptions = imageOptions;
      return { manifest: {}, frames: {} };
    },
  });

  t.after(() => {
    __setThemeGenerationBridgeForTests(null);
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

  await handleGenerateTheme(store, fakeBroadcast(), { plan, pause_for_review: false });

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.attachWalkPoseGuide, true);
});

test('RETRY_THEME_IMAGE passes extensionRoot + attachWalkPoseGuide through to genBridge.retryThemeImage', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  let capturedOptions;
  __setThemeGenerationBridgeForTests({
    retryThemeImage: async (..._args) => {
      // imageOptions is threaded through as one of the trailing args in the
      // real bridge signature; the stub captures whichever object among the
      // call args carries our two marker fields, so this test stays
      // resilient to argument-order details owned by the core worker's side
      // of the contract.
      capturedOptions = _args.find(
        (a) => a && typeof a === 'object' && ('extensionRoot' in a || 'attachWalkPoseGuide' in a),
      );
      return {};
    },
    sanitizeRetryNotes: (s) => ({ notes: s, trimmed: false }),
  });

  t.after(() => {
    __setThemeGenerationBridgeForTests(null);
    resetThemeGenerationStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await handleRetryThemeImage(
    store,
    fakeBroadcast(),
    { theme_id: 'sometheme', item_id: 'agent_0', mode: 'augment', feedback: '' },
    { attachWalkPoseGuide: false },
  );

  assert.ok(capturedOptions, 'genBridge.retryThemeImage should have received an options object');
  assert.equal(typeof capturedOptions.extensionRoot, 'string');
  assert.ok(capturedOptions.extensionRoot.length > 0);
  assert.equal(capturedOptions.attachWalkPoseGuide, false);
});
