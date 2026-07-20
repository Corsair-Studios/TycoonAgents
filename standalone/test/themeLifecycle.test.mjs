// TycoonAgents standalone — end-to-end list -> select -> delete -> list
// lifecycle test for the Phase B non-AI theme operations (project-plan task
// pB-t3).
//
// standalone/test/themeMessages.test.mjs already unit-tests each handler in
// standalone/src/themeMessages.mjs in isolation, including the delete
// handler's OWN broadcast payload (which already carries an updated
// `themes` array). What it does NOT exercise is a genuinely SEPARATE,
// subsequent handleListThemes() call made after a delete — proving the
// on-disk state (not just the delete call's own response) reflects the
// removal, and that deleting one theme leaves an unrelated sibling theme
// untouched. This file closes that gap.
//
// Deterministic: one fs.mkdtempSync tmp dir per test, cleaned up in a
// `finally`. Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsThemeFileStore, themeManifestPath, themeFramesPath } from '../src/themeFileStoreFs.mjs';
import { MSG_WIRE, handleListThemes, handleSelectTheme, handleDeleteTheme } from '../src/themeMessages.mjs';

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-lifecycle-'));
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

async function seedTheme(store, themeId, displayName) {
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
}

test('lifecycle: list -> select -> delete -> a SEPARATE subsequent list call omits the deleted theme and keeps its sibling', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    await seedTheme(store, 'castle_kingdom', 'Castle Kingdom');
    await seedTheme(store, 'neon_dojo', 'Neon Dojo');

    // 1. LIST_THEMES sees both.
    const listCalls1 = [];
    await handleListThemes(store, fakeBroadcast(listCalls1));
    const ids1 = listCalls1[0].data.payload.themes.map((t) => t.theme_id).sort();
    assert.deepEqual(ids1, ['castle_kingdom', 'neon_dojo']);

    // 2. SELECT_THEME returns the THEME_INITIALIZED shape for one of them.
    const selectCalls = [];
    await handleSelectTheme(store, fakeBroadcast(selectCalls), 'castle_kingdom');
    assert.equal(selectCalls[0].data.type, MSG_WIRE.THEME_INITIALIZED);
    assert.equal(selectCalls[0].data.payload.manifest.theme_id, 'castle_kingdom');

    // 3. DELETE_THEME removes it from disk.
    const deleteCalls = [];
    await handleDeleteTheme(store, fakeBroadcast(deleteCalls), 'castle_kingdom');
    assert.equal(deleteCalls[0].data.payload.deleted_theme_id, 'castle_kingdom');

    // 4. A genuinely SEPARATE, later LIST_THEMES call (not the delete call's
    // own broadcast) must omit the deleted theme and still list its sibling.
    const listCalls2 = [];
    await handleListThemes(store, fakeBroadcast(listCalls2));
    const ids2 = listCalls2[0].data.payload.themes.map((t) => t.theme_id);
    assert.deepEqual(ids2, ['neon_dojo']);

    // And selecting the deleted theme now 404s (Theme not found), while the
    // sibling still selects fine.
    const reselectDeleted = [];
    await handleSelectTheme(store, fakeBroadcast(reselectDeleted), 'castle_kingdom');
    assert.equal(reselectDeleted[0].data.type, MSG_WIRE.THEME_GENERATION_ERROR);

    const reselectSibling = [];
    await handleSelectTheme(store, fakeBroadcast(reselectSibling), 'neon_dojo');
    assert.equal(reselectSibling[0].data.type, MSG_WIRE.THEME_INITIALIZED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
