// TycoonAgents standalone — unit tests for themeFileStoreFs.mjs (pA-t4).
//
// Round-trips a manifest + plan object through createFsThemeFileStore(),
// exercising the themes/<id>/ layout via the SAME relative-path builders
// (themeManifestPath/themePlanPath, re-exported from
// out/src/extension/themeFileStore.js) that src/extension/themeService.ts
// uses, so this proves the adapter is layout-compatible rather than merely
// self-consistent. Also exercises mkdirp/readdir/exists/remove.
//
// Deterministic: every test uses its own fs.mkdtempSync tmp dir, cleaned up
// in a `finally`. Node built-ins only (node:test, node:assert, node:fs,
// node:os, node:path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFsThemeFileStore,
  ThemeFileStoreError,
  themeManifestPath,
  themePlanPath,
  themeImagesDirectoryPath,
  themeRawImagesDirectoryPath,
} from '../src/themeFileStoreFs.mjs';

function mkTempDir(prefix = 'tycoon-standalone-themefilestore-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function readJson(store, relativePath) {
  const bytes = await store.readFile(relativePath);
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

test('createFsThemeFileStore: round-trips a manifest + plan through the themes/<id>/ layout', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'castle_theme';
    const manifest = { id: themeId, name: 'Castle Theme', objects: ['torch', 'banner'] };
    const plan = { id: themeId, creative_direction: 'medieval stone castle', characters: [{ name: 'King' }] };

    await store.writeFile(themeManifestPath(themeId), jsonBytes(manifest));
    await store.writeFile(themePlanPath(themeId), jsonBytes(plan));

    assert.deepEqual(await readJson(store, themeManifestPath(themeId)), manifest);
    assert.deepEqual(await readJson(store, themePlanPath(themeId)), plan);

    // Files actually landed at the expected on-disk layout, not just
    // somewhere the store happens to remember.
    assert.equal(fs.existsSync(path.join(root, 'themes', themeId, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'themes', themeId, 'plan.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: writeFile creates parent directories on demand', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'nested_theme';
    const rawImagePath = `${themeRawImagesDirectoryPath(themeId)}/object_01.png`;
    await store.writeFile(rawImagePath, new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(Array.from(await store.readFile(rawImagePath)), [1, 2, 3, 4]);
    assert.equal(fs.existsSync(path.join(root, 'themes', themeId, 'images', 'raw', 'object_01.png')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: mkdirp + readdir list written entries', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'dir_theme';
    await store.mkdirp(themeImagesDirectoryPath(themeId));
    await store.writeFile(`${themeImagesDirectoryPath(themeId)}/a.png`, jsonBytes('a'));
    await store.writeFile(`${themeImagesDirectoryPath(themeId)}/b.png`, jsonBytes('b'));

    const entries = await store.readdir(themeImagesDirectoryPath(themeId));
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['a.png', 'b.png']);
    assert.ok(entries.every((e) => e.isFile && !e.isDirectory));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: exists() is true after write, false for a never-written path, and never throws', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'exists_theme';
    await store.writeFile(themeManifestPath(themeId), jsonBytes({ id: themeId }));

    assert.equal(await store.exists(themeManifestPath(themeId)), true);
    assert.equal(await store.exists(themePlanPath(themeId)), false);
    assert.equal(await store.exists('themes/does/not/exist/at/all.json'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: readFile/stat on a missing path throw with code FileNotFound', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'missing_theme';

    await assert.rejects(() => store.readFile(themeManifestPath(themeId)), (err) => err.code === 'FileNotFound');
    await assert.rejects(() => store.stat(themeManifestPath(themeId)), (err) => err.code === 'FileNotFound');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: stat reports isFile/isDirectory/size/mtimeMs', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'stat_theme';
    const bytes = jsonBytes({ id: themeId, extra: 'padding-for-size' });
    await store.writeFile(themeManifestPath(themeId), bytes);

    const fileStat = await store.stat(themeManifestPath(themeId));
    assert.equal(fileStat.isFile, true);
    assert.equal(fileStat.isDirectory, false);
    assert.equal(fileStat.size, bytes.length);
    assert.equal(typeof fileStat.mtimeMs, 'number');
    assert.ok(fileStat.mtimeMs > 0);

    const dirStat = await store.stat(themeImagesDirectoryPath(themeId).split('/').slice(0, 2).join('/'));
    assert.equal(dirStat.isDirectory, true);
    assert.equal(dirStat.isFile, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: remove deletes a file, and a non-recursive remove on a non-empty dir throws', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'remove_theme';
    await store.writeFile(themeManifestPath(themeId), jsonBytes({ id: themeId }));
    assert.equal(await store.exists(themeManifestPath(themeId)), true);

    await store.remove(themeManifestPath(themeId));
    assert.equal(await store.exists(themeManifestPath(themeId)), false);

    // Directory still has plan.json-less content? No — write one so the dir
    // is non-empty, then a non-recursive remove of the dir must throw.
    await store.writeFile(themePlanPath(themeId), jsonBytes({ id: themeId }));
    await assert.rejects(() => store.remove(`themes/${themeId}`));

    // Recursive remove succeeds and clears the theme directory.
    await store.remove(`themes/${themeId}`, { recursive: true });
    assert.equal(await store.exists(`themes/${themeId}`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: rename moves a file, and refuses to overwrite by default', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    const themeId = 'rename_theme';
    const fromPath = themeManifestPath(themeId);
    const toPath = `themes/${themeId}/manifest.renamed.json`;

    await store.writeFile(fromPath, jsonBytes({ id: themeId, step: 1 }));
    await store.rename(fromPath, toPath);
    assert.equal(await store.exists(fromPath), false);
    assert.deepEqual(await readJson(store, toPath), { id: themeId, step: 1 });

    // Default overwrite:false must refuse a destination that already exists.
    await store.writeFile(fromPath, jsonBytes({ id: themeId, step: 2 }));
    await assert.rejects(() => store.rename(fromPath, toPath), (err) => err.code === 'FileExists');

    // overwrite:true explicitly allowed.
    await store.rename(fromPath, toPath, { overwrite: true });
    assert.deepEqual(await readJson(store, toPath), { id: themeId, step: 2 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: rejects a relativePath that escapes rootDir', async () => {
  const root = mkTempDir();
  try {
    const store = createFsThemeFileStore(root);
    await assert.rejects(() => store.readFile('../escape.json'), ThemeFileStoreError);
    await assert.rejects(() => store.writeFile('../../escape.json', jsonBytes({})), ThemeFileStoreError);
    assert.equal(fs.existsSync(path.resolve(root, '..', 'escape.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFsThemeFileStore: throws ThemeFileStoreError when constructed without a rootDir', () => {
  assert.throws(() => createFsThemeFileStore(''), ThemeFileStoreError);
  assert.throws(() => createFsThemeFileStore(undefined), ThemeFileStoreError);
});
