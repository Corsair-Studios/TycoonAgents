// TycoonAgents standalone — HTTP route tests for the theme export/import
// endpoints in standalone/src/server.mjs (project-plan task pB-t3).
//
// serveThemeExport() (GET /theme-export/<theme_id>) and handleThemeImport()
// (POST /theme-import) were flagged by the pB-t1/pB-t2 independent reviews
// as having NO test coverage of their own — standalone/test/server.test.mjs
// covers startServer()'s other routes (/, /media, /events) and
// standalone/test/themeExportImport.test.mjs covers the underlying
// exportThemeArchiveFromStore()/importThemeArchiveToStore() bridge
// functions directly, but neither exercises the actual HTTP status-code
// mapping these two routes add on top (404 for a missing/invalid theme id,
// 200 + application/zip + Content-Disposition for a real export, 400 JSON
// for a malformed import body). This file closes that gap.
//
// Bootstraps a REAL standalone server on an ephemeral port (port 0), exactly
// like server.test.mjs, pointed at a temp TYCOON_STANDALONE_DATA_DIR, then
// issues real localhost HTTP requests via the global `fetch`. Themes are
// seeded directly on disk with createFsThemeFileStore(dataDir) — the SAME
// root startServer() itself uses for its module-level `themeStore` (see
// server.mjs's startServer(): `themeStore = createFsThemeFileStore(appData.dir)`,
// and appData.dir === path.resolve(dataDir) when TYCOON_STANDALONE_DATA_DIR
// is set — confirmed by server.test.mjs's own appData test).
//
// Deterministic: one fs.mkdtempSync project dir + one fs.mkdtempSync data
// dir per test, server always closed in a `finally`. Node built-ins only,
// plus the same createRequire bridge into the compiled out/ the production
// standalone code already uses (for parseThemeArchive, to verify exported
// zip bytes independently of the export bridge under test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import {
  createFsThemeFileStore,
  themeManifestPath,
  themeFramesPath,
  themeReviewPath,
  themeImagesDirectoryPath,
  themeRawImagesDirectoryPath,
} from '../src/themeFileStoreFs.mjs';
import { exportThemeArchiveFromStore } from '../src/themeArchive.mjs';
import { MSG_WIRE } from '../src/themeMessages.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { parseThemeArchive } = require(path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeArchive.js'));

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-themehttp-proj-'));
}
function mkTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-themehttp-data-'));
}
function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

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

/** Seeds a fully export-ready theme (valid manifest, all-accepted review,
 * a real non-raw image AND a real images/raw/ file so the raw-exclusion
 * assertion is non-vacuous) directly onto the same dataDir root the running
 * server's module-level themeStore reads from. */
async function seedExportReadyTheme(dataDir, themeId, displayName) {
  const store = createFsThemeFileStore(dataDir);
  const manifest = buildValidManifest(themeId, displayName);
  await store.writeFile(themeManifestPath(themeId), jsonBytes(manifest));
  await store.writeFile(themeFramesPath(themeId), jsonBytes({ environment_background: ['data:image/png;base64,AAAA'] }));
  await store.writeFile(
    themeReviewPath(themeId),
    jsonBytes({
      version: 1,
      theme_id: themeId,
      display_name: displayName,
      items: [
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
      ],
    }),
  );
  await store.mkdirp(themeImagesDirectoryPath(themeId));
  await store.writeFile(`${themeImagesDirectoryPath(themeId)}/environment.png`, new Uint8Array([137, 80, 78, 71]));
  await store.mkdirp(themeRawImagesDirectoryPath(themeId));
  await store.writeFile(`${themeRawImagesDirectoryPath(themeId)}/environment_raw.png`, new Uint8Array([9, 9, 9]));
  return store;
}

/** Reads SSE chunks off `reader` until it sees a `message` event whose JSON
 * `data.type` equals `matchType`, then returns that parsed data. Bounded by
 * `maxChunks` so a missing broadcast fails the test instead of hanging. */
async function collectSseEvent(reader, matchType, maxChunks = 50) {
  let buffer = '';
  for (let i = 0; i < maxChunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += Buffer.from(value).toString('utf8');
    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) {
        const data = JSON.parse(dataLine.slice('data: '.length));
        if (data.type === matchType) return data;
      }
    }
  }
  throw new Error(`collectSseEvent: no "${matchType}" event seen within ${maxChunks} SSE reads`);
}

test('GET /theme-export/<id>: 200, application/zip, Content-Disposition attachment; body excludes images/raw', async () => {
  const projectRoot = mkTempProject();
  const dataDir = mkTempDataDir();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  try {
    await seedExportReadyTheme(dataDir, 'http_export_theme', 'HTTP Export Theme');

    const res = await fetch(`${runtime.url}/theme-export/http_export_theme`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^application\/zip/);
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    assert.match(res.headers.get('content-disposition') || '', /http_export_theme\.zip/);

    const bytes = new Uint8Array(await res.arrayBuffer());
    const archive = parseThemeArchive(bytes);
    assert.equal(archive.themeId, 'http_export_theme');
    const paths = [...archive.files.keys()];
    assert.ok(paths.includes('images/environment.png'));
    assert.ok(
      paths.every((p) => p !== 'images/raw' && !p.startsWith('images/raw/')),
      `exported zip must exclude images/raw/*; got: ${JSON.stringify(paths)}`,
    );
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GET /theme-export/<missing-id>: 404', async () => {
  const projectRoot = mkTempProject();
  const dataDir = mkTempDataDir();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  try {
    const res = await fetch(`${runtime.url}/theme-export/totally_missing_theme`);
    assert.equal(res.status, 404);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GET /theme-export/<traversal-crafted-id>: rejected (404), never escapes the store dir', async () => {
  const projectRoot = mkTempProject();
  const dataDir = mkTempDataDir();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  try {
    await seedExportReadyTheme(dataDir, 'safe_theme', 'Safe Theme');

    // The theme id regex (`/^[a-z0-9_]+$/`) rejects '.', '/', and anything
    // decoded from a %2F-escaped slash outright, so a crafted id never even
    // reaches the filesystem lookup.
    const encodedTraversal = await fetch(`${runtime.url}/theme-export/..%2F..`);
    assert.equal(encodedTraversal.status, 404);

    const dottedId = await fetch(`${runtime.url}/theme-export/foo.bar`);
    assert.equal(dottedId.status, 404);

    // An UNENCODED '../../' segment is collapsed by the URL parser itself
    // (WHATWG double-dot normalization) before the route even matches
    // '/theme-export/', so it never reaches serveThemeExport at all — still
    // proves no escape, via a different mechanism (URL normalization rather
    // than the id regex).
    const unencodedTraversal = await fetch(`${runtime.url}/theme-export/../../etc/passwd`);
    assert.equal(unencodedTraversal.status, 404);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('POST /theme-import: valid archive -> 200 JSON {theme_id}, then appears in a real LIST_THEMES call over /message + /events', async () => {
  const projectRoot = mkTempProject();
  const dataDir = mkTempDataDir();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    // Build the archive to import from an INDEPENDENT source store/dir, not
    // the running server's own dataDir — proving the import is a genuine
    // "bring your own archive" upload, not just re-reading local disk.
    const sourceDir = mkTempDataDir();
    try {
      const sourceStore = createFsThemeFileStore(sourceDir);
      await seedExportReadyTheme(sourceDir, 'http_import_theme', 'HTTP Import Theme');
      const bytes = await exportThemeArchiveFromStore(sourceStore, 'http_import_theme');

      const importRes = await fetch(`${runtime.url}/theme-import`, {
        method: 'POST',
        body: Buffer.from(bytes),
      });
      assert.equal(importRes.status, 200);
      const importJson = await importRes.json();
      assert.equal(importJson.theme_id, 'http_import_theme');
      assert.equal(importJson.replaced, false);

      // Now drive a real LIST_THEMES round trip over the SSE channel: open
      // /events, POST {type: 'LIST_THEMES'} to /message, and wait for the
      // THEMES_LIST broadcast to include the just-imported theme.
      const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
      assert.equal(eventsRes.status, 200);
      const reader = eventsRes.body.getReader();
      const listPromise = collectSseEvent(reader, MSG_WIRE.THEMES_LIST);

      const messageRes = await fetch(`${runtime.url}/message`, {
        method: 'POST',
        body: JSON.stringify({ type: MSG_WIRE.LIST_THEMES }),
      });
      assert.equal(messageRes.status, 202);

      const themesListData = await listPromise;
      const ids = themesListData.payload.themes.map((t) => t.theme_id);
      assert.ok(ids.includes('http_import_theme'), `expected imported theme in LIST_THEMES; got: ${JSON.stringify(ids)}`);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  } finally {
    controller.abort();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('POST /theme-import: a non-zip garbage body -> 400 JSON { error }', async () => {
  const projectRoot = mkTempProject();
  const dataDir = mkTempDataDir();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  try {
    const res = await fetch(`${runtime.url}/theme-import`, {
      method: 'POST',
      body: 'this is definitely not a zip file',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(typeof json.error, 'string');
    assert.ok(json.error.length > 0);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// NOTE on the 413 MAX_THEME_IMPORT_BYTES (100 MB) cap: intentionally NOT
// exercised here. Actually streaming a >100 MB request body to a real HTTP
// server would make this test slow and memory-heavy for no behavioral
// payoff (the check itself is a single `totalBytes > MAX_THEME_IMPORT_BYTES`
// comparison in handleThemeImport's `req.on('data', ...)` handler in
// server.mjs), and per this task's constraints, production code is not to be
// made test-seams-friendly (e.g. an injectable byte limit) just to shrink
// that payload. Left uncovered by design.
