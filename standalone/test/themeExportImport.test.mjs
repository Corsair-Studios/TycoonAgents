// TycoonAgents standalone — export/import archive round-trip tests
// (project-plan task pB-t3, covering the pB-t2 bridge in
// standalone/src/themeArchive.mjs).
//
// exportThemeArchiveFromStore()/importThemeArchiveToStore() are thin
// createRequire bridges into the COMPILED out/src/extension/themeArchiveOps.js
// (see themeArchive.mjs's module header) — the same vscode-free logic the
// real VS Code extension's Export/Import commands use. These tests drive
// the bridge functions directly against two independent
// createFsThemeFileStore-rooted temp dirs (never touching the VS Code
// extension or media/), proving:
//   - export excludes images/raw/* (the 0.0.371 rule) even when a raw image
//     is present on disk
//   - export requires every review item to be 'accepted' (export_ready gate)
//   - a full round trip (export from store A -> import into store B) lands
//     the manifest + a non-raw image, and the imported theme becomes
//     listable/selectable via the same themeMessages.mjs handlers the
//     server dispatches SELECT_THEME/LIST_THEMES to.
//
// Verifies the exported bytes with parseThemeArchive from the COMPILED
// out/src/extension/themeArchive.js (same zip format the real extension
// reads), not a re-implementation.
//
// Deterministic: one fs.mkdtempSync tmp dir per store, cleaned up in a
// `finally`. Node built-ins only, plus the same createRequire bridge into
// out/ the production standalone code already uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createFsThemeFileStore,
  themeManifestPath,
  themeFramesPath,
  themeReviewPath,
  themeImagesDirectoryPath,
  themeRawImagesDirectoryPath,
} from '../src/themeFileStoreFs.mjs';
import { exportThemeArchiveFromStore, importThemeArchiveToStore } from '../src/themeArchive.mjs';
import { MSG_WIRE, handleListThemes, handleSelectTheme } from '../src/themeMessages.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { parseThemeArchive } = require(path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeArchive.js'));

function mkTempRoot(prefix = 'tycoon-standalone-archive-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

/** A minimal but SCHEMA-VALID ThemeManifest — export/import round-trips
 * through parseThemeArchive's isThemeManifest() validation (repo root
 * src/extension/themeArchive.ts), which is far stricter than the
 * hand-rolled manifests themeMessages.test.mjs seeds for the list/select/
 * delete handlers (those never get parsed as a real ThemeManifest). Empty
 * roster/rival/object/badge arrays satisfy their `.every(...)` checks
 * trivially. */
function buildValidManifest(themeId, displayName) {
  return {
    manifest_version: '1',
    theme_id: themeId,
    display_name: displayName,
    author: 'Test Author',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'environment_background',
      walkable_nav_polygon: [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
    },
    roster_agents: [],
    roster_rivals: [],
    buildable_objects: [],
    badges: [],
  };
}

/** Seeds a theme that is fully EXPORT-READY: valid manifest, valid
 * frames.json, an all-`accepted` review.json (summarizeThemeApproval's
 * export_ready gate), a real non-raw image, and a real images/raw/ file —
 * the raw file exists specifically so the export-exclusion assertion is
 * non-vacuous (it proves the file was there and was deliberately left out,
 * not merely absent). */
async function seedExportReadyTheme(store, themeId, displayName) {
  const manifest = buildValidManifest(themeId, displayName);
  const frames = { environment_background: ['data:image/png;base64,AAAA'] };
  const reviewItems = [
    {
      id: 'environment',
      filename: 'environment.png',
      label: 'Environment',
      kind: 'environment',
      status: 'accepted',
      prompt: 'p',
      revision: 0,
      frame_keys: ['environment_background'],
      updated_at: new Date(0).toISOString(),
    },
  ];

  await store.writeFile(themeManifestPath(themeId), jsonBytes(manifest));
  await store.writeFile(themeFramesPath(themeId), jsonBytes(frames));
  await store.writeFile(
    themeReviewPath(themeId),
    jsonBytes({ version: 1, theme_id: themeId, display_name: displayName, items: reviewItems }),
  );
  await store.mkdirp(themeImagesDirectoryPath(themeId));
  await store.writeFile(`${themeImagesDirectoryPath(themeId)}/environment.png`, new Uint8Array([137, 80, 78, 71]));
  await store.mkdirp(themeRawImagesDirectoryPath(themeId));
  await store.writeFile(
    `${themeRawImagesDirectoryPath(themeId)}/environment_raw.png`,
    new Uint8Array([1, 2, 3, 4, 5]),
  );

  return { manifest, frames };
}

test('exportThemeArchiveFromStore: excludes images/raw/* even though the raw file exists on disk (0.0.371 rule)', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    await seedExportReadyTheme(store, 'export_raw_check', 'Export Raw Check');
    assert.equal(await store.exists(`${themeRawImagesDirectoryPath('export_raw_check')}/environment_raw.png`), true);

    const bytes = await exportThemeArchiveFromStore(store, 'export_raw_check');
    const archive = parseThemeArchive(bytes);

    assert.equal(archive.themeId, 'export_raw_check');
    const paths = [...archive.files.keys()];
    assert.ok(paths.includes('manifest.json'));
    assert.ok(paths.includes('frames.json'));
    assert.ok(paths.includes('images/environment.png'), 'the non-raw image must be included');
    assert.ok(
      paths.every((p) => p !== 'images/raw' && !p.startsWith('images/raw/')),
      `no images/raw/* entry may appear in the export; got: ${JSON.stringify(paths)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportThemeArchiveFromStore: rejects a theme with any non-accepted review item (export_ready gate)', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'not_ready_theme';
    const manifest = buildValidManifest(themeId, 'Not Ready');
    await store.writeFile(themeManifestPath(themeId), jsonBytes(manifest));
    await store.writeFile(themeFramesPath(themeId), jsonBytes({}));
    await store.writeFile(
      themeReviewPath(themeId),
      jsonBytes({
        version: 1,
        theme_id: themeId,
        display_name: 'Not Ready',
        items: [{ id: 'environment', status: 'pending' }],
      }),
    );

    await assert.rejects(
      () => exportThemeArchiveFromStore(store, themeId),
      /Approve all theme images/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('export -> import round trip: manifest + non-raw image land in a SECOND fresh store, theme becomes listable and selectable', async () => {
  const sourceRoot = mkTempRoot('tycoon-standalone-archive-src-');
  const targetRoot = mkTempRoot('tycoon-standalone-archive-dst-');
  try {
    const sourceStore = createFsThemeFileStore(sourceRoot);
    await seedExportReadyTheme(sourceStore, 'roundtrip_theme', 'Round Trip Theme');

    const bytes = await exportThemeArchiveFromStore(sourceStore, 'roundtrip_theme');

    // Import into a wholly separate, previously-empty store/root.
    const targetStore = createFsThemeFileStore(targetRoot);
    const result = await importThemeArchiveToStore(targetStore, bytes, false);
    assert.equal(result.theme_id, 'roundtrip_theme');
    assert.equal(result.display_name, 'Round Trip Theme');
    assert.equal(result.replaced, false);

    // Manifest + a non-raw image are present on disk in the target store;
    // no images/raw/ was ever sent, so none exists in the target either.
    assert.equal(await targetStore.exists(themeManifestPath('roundtrip_theme')), true);
    assert.equal(
      await targetStore.exists(`${themeImagesDirectoryPath('roundtrip_theme')}/environment.png`),
      true,
    );
    assert.equal(
      await targetStore.exists(`${themeRawImagesDirectoryPath('roundtrip_theme')}/environment_raw.png`),
      false,
    );

    // The imported theme is listable...
    const listCalls = [];
    await handleListThemes(targetStore, fakeBroadcast(listCalls));
    const listedIds = listCalls[0].data.payload.themes.map((t) => t.theme_id);
    assert.ok(listedIds.includes('roundtrip_theme'));

    // ...and selectable, via the exact same handlers server.mjs dispatches
    // LIST_THEMES/SELECT_THEME to.
    const selectCalls = [];
    await handleSelectTheme(targetStore, fakeBroadcast(selectCalls), 'roundtrip_theme');
    assert.equal(selectCalls[0].data.type, MSG_WIRE.THEME_INITIALIZED);
    assert.equal(selectCalls[0].data.payload.manifest.theme_id, 'roundtrip_theme');
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('importThemeArchiveToStore: importing into a store where the theme_id already exists throws unless replace=true', async () => {
  const root = mkTempRoot();
  try {
    const store = createFsThemeFileStore(root);
    await seedExportReadyTheme(store, 'dup_theme', 'Dup Theme');
    const bytes = await exportThemeArchiveFromStore(store, 'dup_theme');

    await assert.rejects(
      () => importThemeArchiveToStore(store, bytes, false),
      /already exists/,
    );

    // replace=true is allowed to overwrite it.
    const result = await importThemeArchiveToStore(store, bytes, true);
    assert.equal(result.theme_id, 'dup_theme');
    assert.equal(result.replaced, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
