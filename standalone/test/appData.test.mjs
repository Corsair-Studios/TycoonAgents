// TycoonAgents standalone — unit tests for appData.mjs (p3-t2).
//
// Two things are tested:
//   1. resolveAppDataDir() — pure path selection, exercised with INJECTED
//      env/platform/homedir so every OS branch is deterministic regardless
//      of which OS actually runs the test (mirrors projectRoots.test.mjs).
//   2. createAppData() — real filesystem I/O against a temp dir, proving
//      round-trip persistence (including "survives a fresh instance",
//      i.e. survives a restart), missing/corrupt-file safety, path-traversal
//      rejection, and lazy dir creation.
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAppDataDir, createAppData, createDefaultAppData, AppDataError } from '../src/appData.mjs';

function mkTempDir(prefix = 'tycoon-standalone-appdata-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── resolveAppDataDir: pure resolution ──────────────────────────────────

test('resolveAppDataDir: TYCOON_STANDALONE_DATA_DIR env override wins on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) {
    const dir = resolveAppDataDir({
      env: { TYCOON_STANDALONE_DATA_DIR: '/override/path', APPDATA: 'C:\\Should\\Not\\Win', XDG_DATA_HOME: '/should/not/win' },
      platform,
      homedir: '/home/whoever',
    });
    assert.equal(dir, path.resolve('/override/path'));
  }
});

test('resolveAppDataDir: win32 uses APPDATA when set', () => {
  const dir = resolveAppDataDir({
    env: { APPDATA: 'C:\\Users\\fake\\AppData\\Roaming' },
    platform: 'win32',
    homedir: 'C:\\Users\\fake',
  });
  assert.equal(dir, path.join('C:\\Users\\fake\\AppData\\Roaming', 'TycoonAgents'));
});

test('resolveAppDataDir: win32 falls back to <homedir>\\AppData\\Roaming when APPDATA is unset', () => {
  const dir = resolveAppDataDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\fake' });
  assert.equal(dir, path.join('C:\\Users\\fake', 'AppData', 'Roaming', 'TycoonAgents'));
});

test('resolveAppDataDir: darwin uses ~/Library/Application Support/TycoonAgents', () => {
  const dir = resolveAppDataDir({ env: {}, platform: 'darwin', homedir: '/Users/fake' });
  assert.equal(dir, path.join('/Users/fake', 'Library', 'Application Support', 'TycoonAgents'));
});

test('resolveAppDataDir: linux uses XDG_DATA_HOME when set', () => {
  const dir = resolveAppDataDir({ env: { XDG_DATA_HOME: '/home/fake/.data' }, platform: 'linux', homedir: '/home/fake' });
  assert.equal(dir, path.join('/home/fake/.data', 'tycoonagents'));
});

test('resolveAppDataDir: linux falls back to ~/.local/share/tycoonagents when XDG_DATA_HOME is unset', () => {
  const dir = resolveAppDataDir({ env: {}, platform: 'linux', homedir: '/home/fake' });
  assert.equal(dir, path.join('/home/fake', '.local', 'share', 'tycoonagents'));
});

// ── createAppData: real filesystem round-trip ───────────────────────────

test('createAppData: writeJson then readJson round-trips the value', () => {
  const dir = mkTempDir();
  try {
    const store = createAppData({ dir });
    store.writeJson('state.json', { count: 42, nested: { ok: true } });
    assert.deepEqual(store.readJson('state.json'), { count: 42, nested: { ok: true } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createAppData: value persists across a FRESH instance pointed at the same dir (survives restart)', () => {
  const dir = mkTempDir();
  try {
    createAppData({ dir }).writeJson('state.json', { survived: true, n: 7 });
    // Brand new instance, same dir — simulates process restart.
    const reopened = createAppData({ dir });
    assert.deepEqual(reopened.readJson('state.json'), { survived: true, n: 7 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createAppData: readJson returns fallback (no throw) when the file is missing', () => {
  const dir = mkTempDir();
  try {
    const store = createAppData({ dir });
    assert.equal(store.readJson('does-not-exist.json', 'FALLBACK'), 'FALLBACK');
    assert.deepEqual(store.readJson('does-not-exist.json', { a: 1 }), { a: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createAppData: readJson returns fallback (no throw) when the file is corrupt/unparseable', () => {
  const dir = mkTempDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not valid json!!', 'utf8');
    let errorSeen = null;
    const store = createAppData({
      dir,
      onError: (err, info) => {
        errorSeen = info;
      },
    });
    assert.equal(store.readJson('corrupt.json', 'FALLBACK'), 'FALLBACK');
    assert.ok(errorSeen, 'onError should have been called for the corrupt file');
    assert.equal(errorSeen.op, 'parse');
    assert.equal(errorSeen.name, 'corrupt.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createAppData: readJson/writeJson reject a path-traversal name', () => {
  const dir = mkTempDir();
  try {
    const store = createAppData({ dir });
    for (const badName of ['../evil.json', 'a/b.json', 'a\\b.json', '/etc/passwd', '..']) {
      assert.throws(() => store.readJson(badName, null), AppDataError, `readJson should reject "${badName}"`);
      assert.throws(() => store.writeJson(badName, { x: 1 }), AppDataError, `writeJson should reject "${badName}"`);
    }
    // The traversal attempt must not have escaped the scoped dir.
    assert.equal(fs.existsSync(path.resolve(dir, '..', 'evil.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createAppData: dir is created lazily on first write, not on construction', () => {
  const parent = mkTempDir();
  const dir = path.join(parent, 'nested', 'appdata');
  try {
    const store = createAppData({ dir });
    assert.equal(fs.existsSync(dir), false, 'dir must not exist yet merely from createAppData()');
    store.writeJson('state.json', { hello: 'world' });
    assert.equal(fs.existsSync(dir), true, 'dir must exist after the first write');
    assert.deepEqual(store.readJson('state.json'), { hello: 'world' });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('createAppData: readJson on an existing-but-empty dir does not create the dir or throw', () => {
  const parent = mkTempDir();
  const dir = path.join(parent, 'never-written');
  try {
    const store = createAppData({ dir });
    assert.equal(store.readJson('state.json', 'FALLBACK'), 'FALLBACK');
    assert.equal(fs.existsSync(dir), false, 'a pure read must not create the dir');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('createAppData: throws AppDataError when constructed without a dir', () => {
  assert.throws(() => createAppData({}), AppDataError);
  assert.throws(() => createAppData({ dir: '' }), AppDataError);
});

test('createDefaultAppData: resolves against the real environment and is usable end-to-end', () => {
  // Smoke test only — proves the convenience wrapper wires resolveAppDataDir
  // + createAppData together correctly, using the env-override escape hatch
  // so it never touches the real OS default location.
  const dir = mkTempDir();
  try {
    const store = createDefaultAppData({ env: { TYCOON_STANDALONE_DATA_DIR: dir } });
    assert.equal(store.dir, path.resolve(dir));
    store.writeJson('smoke.json', { ok: true });
    assert.deepEqual(store.readJson('smoke.json'), { ok: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
