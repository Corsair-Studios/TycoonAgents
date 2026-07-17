// TycoonAgents standalone — unit tests for projectRoots.mjs (p3-t1).
//
// Pure-function tests: resolveProjectRoots() takes argv/env/cwd as plain
// data (no process.env/process.argv/process.cwd() reads inside it), so
// these run with zero live server, zero real environment mutation, and zero
// timers — fast and deterministic, unlike stateFeed.test.mjs's polling
// waits.
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectRoots, ProjectRootError } from '../src/projectRoots.mjs';

function mkTempDir(prefix = 'tycoon-standalone-projectroots-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveProjectRoots: explicit CLI arg wins over env var (precedence rule)', () => {
  const argDir = mkTempDir();
  const envDir = mkTempDir();
  try {
    const { source, roots } = resolveProjectRoots({
      argv: [argDir],
      env: { TYCOON_STANDALONE_PROJECT_ROOT: envDir },
      cwd: mkTempDir(),
    });
    assert.equal(source, 'argv');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].root, path.resolve(argDir));
  } finally {
    fs.rmSync(argDir, { recursive: true, force: true });
    fs.rmSync(envDir, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: env var wins over cwd default when no CLI arg is given', () => {
  const envDir = mkTempDir();
  const cwdDir = mkTempDir();
  try {
    const { source, roots } = resolveProjectRoots({
      argv: [],
      env: { TYCOON_STANDALONE_PROJECT_ROOT: envDir },
      cwd: cwdDir,
    });
    assert.equal(source, 'env');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].root, path.resolve(envDir));
  } finally {
    fs.rmSync(envDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: falls back to cwd when neither argv nor env is set', () => {
  const cwdDir = mkTempDir();
  try {
    const { source, roots } = resolveProjectRoots({ argv: [], env: {}, cwd: cwdDir });
    assert.equal(source, 'cwd');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].root, path.resolve(cwdDir));
  } finally {
    fs.rmSync(cwdDir, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: an ambient env var never overrides an explicit CLI arg, even a stale/wrong one (regression guard)', () => {
  // Mirrors the exact historical bug this precedence rule exists to prevent
  // (see projectRoots.mjs module header): a process-wide env var must never
  // silently win over something the caller explicitly typed.
  const explicitDir = mkTempDir();
  const staleEnvDir = mkTempDir();
  try {
    const { roots } = resolveProjectRoots({
      argv: [explicitDir],
      env: { TYCOON_STANDALONE_PROJECT_ROOT: staleEnvDir },
      cwd: process.cwd(),
    });
    assert.equal(roots.length, 1);
    assert.equal(roots[0].root, path.resolve(explicitDir));
    assert.notEqual(roots[0].root, path.resolve(staleEnvDir));
  } finally {
    fs.rmSync(explicitDir, { recursive: true, force: true });
    fs.rmSync(staleEnvDir, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: multiple CLI args resolve to multiple roots, in order', () => {
  const dirA = mkTempDir();
  const dirB = mkTempDir();
  try {
    const { source, roots } = resolveProjectRoots({ argv: [dirA, dirB], env: {}, cwd: process.cwd() });
    assert.equal(source, 'argv');
    assert.equal(roots.length, 2);
    assert.equal(roots[0].root, path.resolve(dirA));
    assert.equal(roots[1].root, path.resolve(dirB));
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: comma-separated env var also resolves to multiple roots', () => {
  const dirA = mkTempDir();
  const dirB = mkTempDir();
  try {
    const { source, roots } = resolveProjectRoots({
      argv: [],
      env: { TYCOON_STANDALONE_PROJECT_ROOT: `${dirA},${dirB}` },
      cwd: process.cwd(),
    });
    assert.equal(source, 'env');
    assert.equal(roots.length, 2);
    assert.equal(roots[0].root, path.resolve(dirA));
    assert.equal(roots[1].root, path.resolve(dirB));
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: a nonexistent directory throws a ProjectRootError naming the path', () => {
  const missing = path.join(os.tmpdir(), 'tycoon-standalone-does-not-exist-' + Date.now());
  assert.throws(
    () => resolveProjectRoots({ argv: [missing], env: {}, cwd: process.cwd() }),
    (err) => {
      assert.ok(err instanceof ProjectRootError, 'must throw ProjectRootError');
      assert.match(err.message, /not found/i);
      assert.ok(err.message.includes(missing), 'message must name the offending path');
      return true;
    },
  );
});

test('resolveProjectRoots: a file instead of a directory throws a ProjectRootError', () => {
  const dir = mkTempDir();
  const filePath = path.join(dir, 'not-a-directory.txt');
  fs.writeFileSync(filePath, 'hello', 'utf8');
  try {
    assert.throws(
      () => resolveProjectRoots({ argv: [filePath], env: {}, cwd: process.cwd() }),
      (err) => {
        assert.ok(err instanceof ProjectRootError, 'must throw ProjectRootError');
        assert.match(err.message, /not a directory/i);
        assert.ok(err.message.includes(filePath), 'message must name the offending path');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: an existing directory with no .claude/tycoon yet is VALID, not an error', () => {
  const dir = mkTempDir();
  try {
    const { roots } = resolveProjectRoots({ argv: [dir], env: {}, cwd: process.cwd() });
    assert.equal(roots.length, 1);
    assert.equal(roots[0].root, path.resolve(dir));
    assert.equal(roots[0].hasTycoonDir, false);
    assert.equal(roots[0].tycoonDir, path.join(path.resolve(dir), '.claude', 'tycoon'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: an existing directory WITH .claude/tycoon reports hasTycoonDir true', () => {
  const dir = mkTempDir();
  const tycoonDir = path.join(dir, '.claude', 'tycoon');
  fs.mkdirSync(tycoonDir, { recursive: true });
  try {
    const { roots } = resolveProjectRoots({ argv: [dir], env: {}, cwd: process.cwd() });
    assert.equal(roots[0].hasTycoonDir, true);
    assert.equal(roots[0].tycoonDir, tycoonDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProjectRoots: one bad dir among several throws (fails fast, does not silently drop it)', () => {
  const good = mkTempDir();
  const missing = path.join(os.tmpdir(), 'tycoon-standalone-does-not-exist-2-' + Date.now());
  try {
    assert.throws(
      () => resolveProjectRoots({ argv: [good, missing], env: {}, cwd: process.cwd() }),
      ProjectRootError,
    );
  } finally {
    fs.rmSync(good, { recursive: true, force: true });
  }
});
