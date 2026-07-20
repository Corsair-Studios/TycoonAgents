// TycoonAgents standalone — unit tests for the 5 theme review-EDITOR message
// handlers added in themeGenerationMessages.mjs (project-plan task pC-t2):
// SET_THEME_ITEM_NAMES / SET_THEME_ITEM_DESCRIPTIONS /
// SET_THEME_CREATIVE_DIRECTION / RENAME_THEME_CHARACTER /
// APPROVE_ALL_THEME_IMAGES.
//
// Each handler is driven directly (the same function server.mjs's
// handleBrowserMessage() dispatches to), against a real fs-backed
// createFsThemeFileStore-rooted temp dir wired through
// themeGenerationBridge.mjs's configureThemeFileStore() into the REAL
// out/src/extension/themeService.js — same posture as
// themeFramesWriteMutex.test.ts and themeResumeResliceRecovery.test.ts (real
// pipeline, no mocked generation logic). Persistence is verified by a FRESH
// re-read off disk after each handler call, not by trusting the broadcast
// payload alone — this is the pC-t2 acceptance criterion.
//
// Deterministic: every test uses its own fs.mkdtempSync tmp dir, cleaned up
// in a `finally`. No network. Node built-ins only (node:test, node:assert,
// node:fs, node:os, node:path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFsThemeFileStore,
  themeManifestPath,
  themeFramesPath,
  themePlanPath,
  themeReviewPath,
  themeImagesDirectoryPath,
} from '../src/themeFileStoreFs.mjs';
import { configureThemeFileStore } from '../src/themeGenerationBridge.mjs';
import {
  handleSetThemeItemNames,
  handleSetThemeItemDescriptions,
  handleSetThemeCreativeDirection,
  handleRenameThemeCharacter,
  handleApproveAllThemeImages,
  resetThemeGenerationStateForTests,
} from '../src/themeGenerationMessages.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-editor-'));
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

async function readJson(store, relativePath) {
  return JSON.parse(Buffer.from(await store.readFile(relativePath)).toString('utf8'));
}

/** Seeds a theme with a character (agent_0), a buildable object, and a
 * plan.json — enough for the Names/Descriptions/Creative-Direction/Rename
 * handlers, all of which require a saved plan.json to load. */
async function seedEditorTheme(store, themeId) {
  const manifest = {
    theme_id: themeId,
    display_name: 'Castle Theme',
    roster_agents: [{ slot_id: 0, name: 'Old Hero' }],
    roster_rivals: [],
    buildable_objects: [{ object_id: 'obj_wall', display_name: 'Wall' }],
    decor_objects: [],
    badges: [],
    viewport: {},
  };
  const frames = { agent_0: ['data:image/png;base64,AA=='] };
  const plan = { theme_id: themeId, display_name: 'Castle Theme', creative_direction: 'original direction' };
  await store.writeFile(themeManifestPath(themeId), jsonBytes(manifest));
  await store.writeFile(themeFramesPath(themeId), jsonBytes(frames));
  await store.writeFile(themePlanPath(themeId), jsonBytes(plan));
  await store.writeFile(
    themeReviewPath(themeId),
    jsonBytes({
      version: 1,
      theme_id: themeId,
      display_name: 'Castle Theme',
      items: [
        {
          id: 'agent_0', filename: 'agent_0_atlas.png', label: 'Old Hero', kind: 'character_atlas',
          status: 'pending', prompt: 'p', revision: 0, frame_keys: ['agent_0'], subject: 'Old Hero',
          updated_at: new Date(0).toISOString(),
        },
      ],
    }),
  );
}

test('handleSetThemeItemNames: renames a manifest object and persists it to disk (fresh re-read)', async (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  await seedEditorTheme(store, 'castle_kingdom');

  const calls = [];
  await handleSetThemeItemNames(store, fakeBroadcast(calls), {
    theme_id: 'castle_kingdom',
    board_id: 'objects_01',
    changes: [{ item_kind: 'object', id: 'obj_wall', name: 'Stone Wall' }],
  });

  const result = calls.find((c) => c.data.type === 'THEME_ITEM_NAMES_RESULT');
  assert.ok(result, 'THEME_ITEM_NAMES_RESULT broadcast');
  assert.equal(result.data.payload.ok, true);
  assert.equal(result.data.payload.applied.length, 1);
  assert.equal(result.data.payload.theme_id, 'castle_kingdom');
  assert.ok(calls.some((c) => c.data.type === 'THEME_INITIALIZED'), 'THEME_INITIALIZED reposted after an applied rename');

  const manifest = await readJson(store, themeManifestPath('castle_kingdom'));
  assert.equal(manifest.buildable_objects[0].display_name, 'Stone Wall');
});

test('handleSetThemeItemNames: an unknown object id is rejected, ok:false, nothing written', async (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  await seedEditorTheme(store, 'castle_kingdom');

  const calls = [];
  await handleSetThemeItemNames(store, fakeBroadcast(calls), {
    theme_id: 'castle_kingdom',
    changes: [{ item_kind: 'object', id: 'does_not_exist', name: 'Ghost' }],
  });

  const result = calls.find((c) => c.data.type === 'THEME_ITEM_NAMES_RESULT');
  assert.equal(result.data.payload.ok, false);
  assert.equal(result.data.payload.rejected.length, 1);
  const manifest = await readJson(store, themeManifestPath('castle_kingdom'));
  assert.equal(manifest.buildable_objects[0].display_name, 'Wall', 'unchanged');
});

test('handleSetThemeItemDescriptions: a "projectile" item_kind change persists to plan.json (single field, no manifest lookup)', async (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  await seedEditorTheme(store, 'castle_kingdom');

  const calls = [];
  await handleSetThemeItemDescriptions(store, fakeBroadcast(calls), {
    theme_id: 'castle_kingdom',
    board_id: 'background_decor',
    changes: [{ item_kind: 'projectile', id: 'projectile', description: 'a flaming arrow' }],
  });

  const result = calls.find((c) => c.data.type === 'THEME_ITEM_DESCRIPTIONS_RESULT');
  assert.ok(result, 'THEME_ITEM_DESCRIPTIONS_RESULT broadcast');
  assert.equal(result.data.payload.ok, true);
  assert.equal(result.data.payload.applied[0].item_kind, 'projectile');
  assert.equal(calls.some((c) => c.data.type === 'THEME_INITIALIZED'), false, 'descriptions never touch the manifest');

  const plan = await readJson(store, themePlanPath('castle_kingdom'));
  assert.equal(plan.projectile_description, 'a flaming arrow');
});

test('handleSetThemeCreativeDirection: overwrites plan.creative_direction and persists it', async (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  await seedEditorTheme(store, 'castle_kingdom');

  const calls = [];
  await handleSetThemeCreativeDirection(store, fakeBroadcast(calls), {
    theme_id: 'castle_kingdom',
    creative_direction: 'a darker, gothic castle mood',
  });

  const result = calls.find((c) => c.data.type === 'THEME_CREATIVE_DIRECTION_RESULT');
  assert.ok(result, 'THEME_CREATIVE_DIRECTION_RESULT broadcast');
  assert.equal(result.data.payload.ok, true);
  assert.equal(result.data.payload.creative_direction, 'a darker, gothic castle mood');

  const plan = await readJson(store, themePlanPath('castle_kingdom'));
  assert.equal(plan.creative_direction, 'a darker, gothic castle mood');
});

test('handleSetThemeCreativeDirection: an empty (post-trim) direction is rejected without writing', async (t) => {
  const root = mkTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  await seedEditorTheme(store, 'castle_kingdom');

  const calls = [];
  await handleSetThemeCreativeDirection(store, fakeBroadcast(calls), {
    theme_id: 'castle_kingdom',
    creative_direction: '   ',
  });

  const result = calls.find((c) => c.data.type === 'THEME_CREATIVE_DIRECTION_RESULT');
  assert.equal(result.data.payload.ok, false);
  const plan = await readJson(store, themePlanPath('castle_kingdom'));
  assert.equal(plan.creative_direction, 'original direction', 'unchanged');
});

test('handleRenameThemeCharacter: renames the agent in the manifest and persists it', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    resetThemeGenerationStateForTests();
  });
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  await seedEditorTheme(store, 'castle_kingdom');

  const calls = [];
  await handleRenameThemeCharacter(store, fakeBroadcast(calls), {
    theme_id: 'castle_kingdom',
    item_id: 'agent_0',
    name: 'Sir Reginald',
  });

  const finalState = calls.filter((c) => c.data.type === 'THEME_CHARACTER_RENAME_STATE').pop();
  assert.ok(finalState, 'THEME_CHARACTER_RENAME_STATE broadcast');
  assert.equal(finalState.data.payload.error, undefined, JSON.stringify(finalState.data.payload));
  assert.equal(finalState.data.payload.busy, false);
  assert.ok(calls.some((c) => c.data.type === 'THEME_INITIALIZED'), 'THEME_INITIALIZED reposted (no active gate)');

  const manifest = await readJson(store, themeManifestPath('castle_kingdom'));
  assert.equal(manifest.roster_agents[0].name, 'Sir Reginald');
});

test('handleApproveAllThemeImages: every review item flips to accepted and THEMES_LIST is reposted', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    resetThemeGenerationStateForTests();
  });
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  const themeId = 'no_plan_theme';
  // Deliberately NO plan.json: getThemeImageReview only merges in the full
  // expected-board contract when a saved plan exists (see themeService.ts) —
  // without one, review entries are exactly the saved review.json items plus
  // the always-synthesized 'emote_icons' fallback (see next line's image).
  const manifest = {
    theme_id: themeId, display_name: 'Simple Theme',
    roster_agents: [], roster_rivals: [], buildable_objects: [], decor_objects: [], viewport: {},
  };
  await store.writeFile(themeManifestPath(themeId), jsonBytes(manifest));
  await store.writeFile(themeFramesPath(themeId), jsonBytes({ environment_background: ['data:image/png;base64,AA=='] }));
  await store.writeFile(themeReviewPath(themeId), jsonBytes({
    version: 1, theme_id: themeId, display_name: 'Simple Theme',
    items: [
      { id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment', status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: new Date(0).toISOString() },
    ],
  }));
  await store.mkdirp(themeImagesDirectoryPath(themeId));
  await store.writeFile(`${themeImagesDirectoryPath(themeId)}/environment.png`, new Uint8Array([1, 2, 3]));
  // getThemeImageReview always synthesizes an 'emote_icons' fallback item
  // when no expression_atlas/emote_icons item is saved — its image must
  // exist too, or approveAllThemeImages throws "N missing".
  await store.writeFile(`${themeImagesDirectoryPath(themeId)}/emotes_atlas.png`, new Uint8Array([1, 2, 3]));

  const calls = [];
  await handleApproveAllThemeImages(store, fakeBroadcast(calls), { theme_id: themeId });

  assert.equal(calls.some((c) => c.data.type === 'THEME_APPROVE_ALL_RESULT'), false, 'no error result expected');
  assert.ok(calls.some((c) => c.data.type === 'THEMES_LIST'), 'THEMES_LIST reposted');
  assert.ok(calls.some((c) => c.data.type === 'THEME_IMAGE_REVIEW'), 'review reposted');

  const review = await readJson(store, themeReviewPath(themeId));
  assert.ok(review.items.length > 0);
  for (const item of review.items) {
    assert.equal(item.status, 'accepted', `item ${item.id} should be accepted`);
  }
});

test('handleApproveAllThemeImages: an unknown theme_id broadcasts THEME_APPROVE_ALL_RESULT with an error, never throws', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    resetThemeGenerationStateForTests();
  });
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  const calls = [];
  await handleApproveAllThemeImages(store, fakeBroadcast(calls), { theme_id: 'ghost_theme' });

  const result = calls.find((c) => c.data.type === 'THEME_APPROVE_ALL_RESULT');
  assert.ok(result, 'THEME_APPROVE_ALL_RESULT broadcast');
  assert.ok(result.data.payload.error);
});
