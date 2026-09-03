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

test('handleGetThemeImageReview: a theme with no review.json and a manifest whose rosters cannot satisfy the board contract (empty rosters -> createReviewItems throws, e.g. decor requires exactly 9 items) falls back to an empty items array, never throws', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    await seedTheme(store, 'no_review_yet');
    const calls = [];
    await handleGetThemeImageReview(store, fakeBroadcast(calls), 'no_review_yet');
    assert.equal(calls[0].data.type, MSG_WIRE.THEME_IMAGE_REVIEW);
    assert.deepEqual(calls[0].data.payload.items, []);
    // Recovery failed (degenerate manifest) so nothing is persisted -- unlike
    // the bundled-theme test below, which has a real roster and succeeds.
    assert.equal(await store.exists(themeReviewPath('no_review_yet')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// p9-t4: the bundled sample theme ships manifest.json + frames.json only (no
// review.json / images/) — this is the exact shape ensureThemeReviewImages
// recovers on the VS Code host, and recoverThemeReviewBoards (themeMessages.mjs)
// must converge on the same on-disk state: review.json + one composed PNG per
// board group under images/, board items carrying image_src + frame_slots.
test('handleGetThemeImageReview (bundled survivors_vs_zombies theme, manifest+frames only): recovers board items with image_src + frame_slots, writes review.json + PNGs, and caches on a second call', async () => {
  const root = mkTempRoot();
  try {
    const bundledDir = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '..', '..', 'media', 'themes', 'survivors_vs_zombies',
    );
    const bundledManifest = JSON.parse(fs.readFileSync(path.join(bundledDir, 'manifest.json'), 'utf8'));
    const bundledFramesBytes = fs.readFileSync(path.join(bundledDir, 'frames.json'));

    const store = createFsThemeFileStore(root);
    const themeId = bundledManifest.theme_id;
    await store.writeFile(themeManifestPath(themeId), jsonBytes(bundledManifest));
    await store.writeFile(themeFramesPath(themeId), bundledFramesBytes);

    assert.equal(await store.exists(themeReviewPath(themeId)), false, 'sanity: no review.json before recovery');

    const firstCalls = [];
    await handleGetThemeImageReview(store, fakeBroadcast(firstCalls), themeId);
    assert.equal(firstCalls.length, 1);
    assert.equal(firstCalls[0].data.type, MSG_WIRE.THEME_IMAGE_REVIEW);
    const firstItems = firstCalls[0].data.payload.items;
    assert.ok(firstItems.length > 0);

    const environmentItem = firstItems.find((item) => item.id === 'environment');
    assert.ok(environmentItem, 'environment board must be present');
    assert.ok(environmentItem.image_src.startsWith(`/theme-images/${themeId}/environment.png`));
    assert.ok(Array.isArray(environmentItem.frame_slots) && environmentItem.frame_slots.length > 0);

    const generatedWithImage = firstItems.filter((item) => item.image_src);
    assert.ok(generatedWithImage.length > 0, 'at least one board must have composed a PNG from the bundled frames');
    for (const item of generatedWithImage) {
      assert.ok(Array.isArray(item.frame_slots), `${item.id} must carry frame_slots`);
    }

    assert.equal(await store.exists(themeReviewPath(themeId)), true, 'recovery must persist review.json');
    const imagesDir = themeImagesDirectoryPath(themeId);
    assert.equal(await store.exists(`${imagesDir}/environment.png`), true, 'recovery must write the environment PNG');

    // Second call: review.json now exists, so no re-recovery -- the SAME
    // cached record (persisted item set) is read back.
    const secondCalls = [];
    await handleGetThemeImageReview(store, fakeBroadcast(secondCalls), themeId);
    const secondItems = secondCalls[0].data.payload.items;
    assert.deepEqual(
      secondItems.map((item) => item.id).sort(),
      firstItems.map((item) => item.id).sort(),
      'second call must read the same cached review.json record',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// p9-t2: guards the bug report that the standalone stage draws red-square/"?"
// fallbacks for rivals and emotes. Investigation found the ACTUAL renderer is
// media/main.js (src/webview/themeBuilder.ts's frameCache/atlas_asset code,
// cited in the original report, is dead/unused — grep for "crimson" or
// "drawnFromAtlas" in media/main.js returns nothing). media/main.js is
// unmodified between hosts and driven entirely by THEME_INITIALIZED's
// manifest+frames payload, so this test asserts THAT payload, produced by
// handleSelectTheme() exactly as server.mjs's seedBundledThemesIntoStore()
// writes it from media/themes/survivors_vs_zombies/{manifest,frames}.json,
// has a frames[] entry for every atlas_asset the bundled manifest's roster
// arrays reference (roster_agents, roster_rivals, buildable_objects,
// decor_objects) — covering the rival_* and expression_* keys the bug
// report called out. It passed against the real bundled theme, confirming
// the standalone's payload is already complete; the visual bug, if still
// reproducible, is client-side (media/main.js) and out of this file's scope.
test('handleSelectTheme (bundled survivors_vs_zombies theme): every roster atlas_asset resolves to a non-empty frames[] entry', async () => {
  const root = mkTempRoot();
  try {
    const bundledDir = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '..', '..', 'media', 'themes', 'survivors_vs_zombies',
    );
    const bundledManifest = JSON.parse(fs.readFileSync(path.join(bundledDir, 'manifest.json'), 'utf8'));
    const bundledFramesBytes = fs.readFileSync(path.join(bundledDir, 'frames.json'));

    const store = createFsThemeFileStore(root);
    const themeId = bundledManifest.theme_id;
    await store.writeFile(themeManifestPath(themeId), jsonBytes(bundledManifest));
    await store.writeFile(themeFramesPath(themeId), bundledFramesBytes);

    const calls = [];
    await handleSelectTheme(store, fakeBroadcast(calls), themeId);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.type, MSG_WIRE.THEME_INITIALIZED);
    const { manifest, frames } = calls[0].data.payload;

    const refs = new Set();
    for (const group of ['roster_agents', 'roster_rivals', 'buildable_objects', 'decor_objects']) {
      for (const item of manifest[group] ?? []) {
        if (item.atlas_asset) refs.add(item.atlas_asset);
      }
    }
    assert.ok(refs.size > 0, 'sanity: the bundled manifest must reference at least one atlas_asset');

    const missing = [];
    for (const ref of refs) {
      const key = ref.split('#')[1];
      if (!Array.isArray(frames[key]) || frames[key].length === 0) missing.push(ref);
    }
    assert.deepEqual(missing, [], `atlas_asset(s) with no usable frames[] entry in THEME_INITIALIZED payload: ${missing.join(', ')}`);

    // Emote/expression frames (rendered via "expression_<0..7>" keys, not a
    // manifest roster array — see media/main.js's showExpression) must also
    // be present so the head-bubble never falls back to a bare "?" glyph.
    for (let i = 0; i < 8; i++) {
      const key = `expression_${i}`;
      assert.ok(Array.isArray(frames[key]) && frames[key].length > 0, `missing frames for ${key}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// p9-t4: GET_THEME_IMAGE_REVIEW on the bundled theme, once its review.json
// carries the board-shaped contract produced by the VS Code host's recovery
// path (src/extension/themeService.ts's ensureThemeReviewImages +
// src/extension/themeBoardRecovery.ts's composeRecoveredBoardImages — one
// magenta sprite-sheet board per character/rival/object/decor group, keyed
// by the SAME ids/filenames/frame_keys createReviewItems synthesizes), must
// surface those board items intact: correct image_src for a populated
// board, frame_keys preserved verbatim, and no item dropped or renamed.
//
// NOTE (scope): this exercises handleGetThemeImageReview's existing
// review.json + on-disk-image contract using the REAL bundled manifest's
// first character slot for realism; it does not itself drive
// ensureThemeReviewImages (a themeService.ts / vscode-host function this
// vscode-free .mjs test cannot import) or assert on `frame_slots` — that
// field is only ever added by the VS Code host's panel.ts
// (_postThemeImageReview), never by this file's handleGetThemeImageReview,
// which is a pre-existing gap outside this fix's owned files. Likewise,
// seedBundledThemesIntoStore (standalone/src/server.mjs) never seeds a
// review.json for the bundled theme today, so this test seeds one directly
// to prove the WIRE CONTRACT is compatible; wiring the standalone host to
// actually run board-recovery is tracked as an open issue, not fixed here.
test('handleGetThemeImageReview (bundled survivors_vs_zombies theme): a board-shaped review item (character board, real roster slot) round-trips with image_src set and frame_keys intact', async () => {
  const root = mkTempRoot();
  try {
    const bundledDir = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '..', '..', 'media', 'themes', 'survivors_vs_zombies',
    );
    const bundledManifest = JSON.parse(fs.readFileSync(path.join(bundledDir, 'manifest.json'), 'utf8'));
    const bundledFramesBytes = fs.readFileSync(path.join(bundledDir, 'frames.json'));
    const bundledFrames = JSON.parse(bundledFramesBytes.toString('utf8'));
    const themeId = bundledManifest.theme_id;
    const firstAgent = bundledManifest.roster_agents[0];
    assert.ok(firstAgent, 'sanity: bundled manifest must have at least one roster agent');
    const agentKey = firstAgent.atlas_asset.split('#')[1];
    assert.ok(Array.isArray(bundledFrames[agentKey]) && bundledFrames[agentKey].length > 0, 'sanity: agent frames present');

    const store = createFsThemeFileStore(root);
    await store.writeFile(themeManifestPath(themeId), jsonBytes(bundledManifest));
    await store.writeFile(themeFramesPath(themeId), bundledFramesBytes);

    const characterItem = {
      id: `agent_${firstAgent.slot_id}`,
      filename: `agent_${String(firstAgent.slot_id + 1).padStart(2, '0')}_${firstAgent.name}.png`,
      label: firstAgent.name,
      kind: 'character_atlas',
      status: 'pending',
      prompt: '',
      revision: 0,
      frame_keys: [agentKey],
      updated_at: new Date(0).toISOString(),
    };
    await store.writeFile(
      themeReviewPath(themeId),
      jsonBytes({ version: 1, theme_id: themeId, display_name: bundledManifest.display_name, items: [characterItem] }),
    );
    // Simulates the composed board PNG ensureThemeReviewImages/
    // composeRecoveredBoardImages would have written at this exact filename.
    await store.mkdirp(themeImagesDirectoryPath(themeId));
    await store.writeFile(`${themeImagesDirectoryPath(themeId)}/${characterItem.filename}`, new Uint8Array([1, 2, 3]));

    const calls = [];
    await handleGetThemeImageReview(store, fakeBroadcast(calls), themeId);

    assert.equal(calls.length, 1);
    const payload = calls[0].data.payload;
    assert.equal(payload.items.length, 1);
    const outItem = payload.items[0];
    assert.equal(outItem.id, characterItem.id);
    assert.equal(outItem.kind, 'character_atlas');
    assert.deepEqual(outItem.frame_keys, [agentKey]);
    assert.ok(outItem.image_src.startsWith(`/theme-images/${themeId}/${encodeURIComponent(characterItem.filename)}`));
    assert.equal(outItem.generated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
