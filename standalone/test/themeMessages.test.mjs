// TycoonAgents standalone — unit tests for themeMessages.mjs's 4 non-AI
// theme message handlers (project-plan task pB-t1 acceptance criteria).
//
// Seeds a theme directly on disk (manifest.json + frames.json under a
// createFsThemeFileStore-rooted temp dir, same on-disk shape server.mjs's
// startServer() wires up via appData.dir), then drives the handler
// functions directly (the same functions handleBrowserMessage() in
// server.mjs dispatches to) and asserts the broadcast() payloads match
// media/main.js's expected wire shapes (THEMES_LIST / THEME_INITIALIZED /
// THEME_GENERATION_ERROR / DELETE via THEMES_LIST / THEME_IMAGE_REVIEW).
//
// Deterministic: every test uses its own fs.mkdtempSync tmp dir, cleaned up
// in a `finally`. Node built-ins only (node:test, node:assert, node:fs,
// node:os, node:path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsThemeFileStore, themeManifestPath, themeFramesPath, themeReviewPath, themeImagesDirectoryPath } from '../src/themeFileStoreFs.mjs';
import {
  MSG_WIRE,
  handleListThemes,
  handleSelectTheme,
  handleDeleteTheme,
  handleGetThemeImageReview,
} from '../src/themeMessages.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-thememsg-'));
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

async function seedTheme(store, themeId, { displayName = 'Castle Theme', reviewItems } = {}) {
  const manifest = {
    theme_id: themeId,
    display_name: displayName,
    roster_agents: [],
    roster_rivals: [],
    buildable_objects: [],
    decor_objects: [],
    viewport: {},
  };
  const frames = { environment_background: ['data:image/png;base64,AA=='] };
  await store.writeFile(themeManifestPath(themeId), jsonBytes(manifest));
  await store.writeFile(themeFramesPath(themeId), jsonBytes(frames));
  if (reviewItems) {
    await store.writeFile(
      themeReviewPath(themeId),
      jsonBytes({ version: 1, theme_id: themeId, display_name: displayName, items: reviewItems }),
    );
  }
  return { manifest, frames };
}

test('handleListThemes: LIST_THEMES broadcasts THEMES_LIST with a seeded theme (theme_id/display_name/size_bytes/approval fields)', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    await seedTheme(store, 'castle_kingdom');

    const calls = [];
    await handleListThemes(store, fakeBroadcast(calls));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventName, 'message');
    assert.equal(calls[0].data.type, MSG_WIRE.THEMES_LIST);
    const { themes } = calls[0].data.payload;
    assert.equal(themes.length, 1);
    assert.equal(themes[0].theme_id, 'castle_kingdom');
    assert.equal(themes[0].display_name, 'Castle Theme');
    assert.equal(typeof themes[0].size_bytes, 'number');
    assert.ok(themes[0].size_bytes > 0, 'size_bytes must reflect the real written manifest+frames bytes');
    // No review.json written -> summarizeThemeApproval([]) shape.
    assert.equal(themes[0].total, 0);
    assert.equal(themes[0].accepted, 0);
    assert.equal(themes[0].export_ready, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleListThemes: an empty store (no themes/ dir yet) broadcasts THEMES_LIST with an empty array, never throws', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    const calls = [];
    await handleListThemes(store, fakeBroadcast(calls));
    assert.deepEqual(calls[0].data.payload.themes, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleSelectTheme: SELECT_THEME broadcasts THEME_INITIALIZED with manifest+frames and safe-default progress fields', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    const { manifest, frames } = await seedTheme(store, 'neon_dojo', { displayName: 'Neon Dojo' });

    const calls = [];
    await handleSelectTheme(store, fakeBroadcast(calls), 'neon_dojo');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.type, MSG_WIRE.THEME_INITIALIZED);
    const payload = calls[0].data.payload;
    assert.deepEqual(payload.manifest, manifest);
    assert.deepEqual(payload.frames, frames);
    assert.equal(payload.is_editor_mode, false);
    assert.deepEqual(payload.unlocked_badge_ids, []);
    assert.equal(payload.rebirth_state, null);
    assert.equal(payload.savedBuildProgress, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleSelectTheme: an unknown theme_id broadcasts THEME_GENERATION_ERROR ("Theme not found."), never throws', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    const calls = [];
    await handleSelectTheme(store, fakeBroadcast(calls), 'does_not_exist');
    assert.equal(calls[0].data.type, MSG_WIRE.THEME_GENERATION_ERROR);
    assert.equal(calls[0].data.payload.message, 'Theme not found.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleDeleteTheme: removes the theme directory and broadcasts THEMES_LIST with deleted_theme_id set, theme gone from the list', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    await seedTheme(store, 'to_delete');
    assert.equal(await store.exists(themeManifestPath('to_delete')), true);

    const calls = [];
    await handleDeleteTheme(store, fakeBroadcast(calls), 'to_delete');

    assert.equal(calls[0].data.type, MSG_WIRE.THEMES_LIST);
    assert.equal(calls[0].data.payload.deleted_theme_id, 'to_delete');
    assert.equal(calls[0].data.payload.delete_error, undefined);
    assert.deepEqual(calls[0].data.payload.themes, []);
    assert.equal(await store.exists(themeManifestPath('to_delete')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleDeleteTheme: an unknown theme_id broadcasts THEMES_LIST with delete_error set and no deleted_theme_id', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    const calls = [];
    await handleDeleteTheme(store, fakeBroadcast(calls), 'ghost_theme');
    assert.equal(calls[0].data.type, MSG_WIRE.THEMES_LIST);
    assert.equal(calls[0].data.payload.deleted_theme_id, undefined);
    assert.ok(calls[0].data.payload.delete_error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleGetThemeImageReview: broadcasts THEME_IMAGE_REVIEW with an image_src for a generated item and empty image_src for an ungenerated one', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'review_theme';
    await seedTheme(store, themeId, {
      displayName: 'Review Theme',
      reviewItems: [
        {
          id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
          status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: new Date(0).toISOString(),
        },
        {
          id: 'agent_0', filename: 'agent_0_atlas.png', label: 'Hero', kind: 'character_atlas',
          status: 'pending', prompt: 'p', revision: 0, frame_keys: ['agent_0'], updated_at: new Date(0).toISOString(),
        },
      ],
    });
    // Only the environment image actually exists on disk.
    await store.mkdirp(themeImagesDirectoryPath(themeId));
    await store.writeFile(`${themeImagesDirectoryPath(themeId)}/environment.png`, new Uint8Array([1, 2, 3]));

    const calls = [];
    await handleGetThemeImageReview(store, fakeBroadcast(calls), themeId);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.type, MSG_WIRE.THEME_IMAGE_REVIEW);
    const payload = calls[0].data.payload;
    assert.equal(payload.theme_id, themeId);
    assert.equal(payload.display_name, 'Review Theme');
    assert.equal(payload.items.length, 2);

    const envItem = payload.items.find((item) => item.id === 'environment');
    assert.ok(envItem.image_src.startsWith(`/theme-images/${themeId}/environment.png`));
    assert.equal(envItem.generated, true, 'environment has an image and zero frame_keys required');

    const agentItem = payload.items.find((item) => item.id === 'agent_0');
    assert.equal(agentItem.image_src, '', 'no file on disk for agent_0_atlas.png -> empty image_src');
    assert.equal(agentItem.generated, false, 'no image on disk -> not generated, regardless of frames.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleGetThemeImageReview: a theme with no review.json yet broadcasts an empty items array, never throws', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    await seedTheme(store, 'no_review_yet');
    const calls = [];
    await handleGetThemeImageReview(store, fakeBroadcast(calls), 'no_review_yet');
    assert.equal(calls[0].data.type, MSG_WIRE.THEME_IMAGE_REVIEW);
    assert.deepEqual(calls[0].data.payload.items, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
