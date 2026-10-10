// TycoonAgents standalone — unit tests for cli.mjs (p3-t3 install-hook
// dispatch + p4-t1 watch command).
//
// Covers what's purely/safely testable per this task's brief: pure arg
// parsing (parseWatchArgs), command dispatch (unknown/help/missing-arg
// error paths, all of which return fast without starting anything), and one
// full happy-path run of runWatchCommand() against a real ephemeral-port
// server that is deterministically stopped via an AbortSignal instead of a
// real OS SIGINT/SIGTERM (which are process-global and would leak across
// other tests in this same process). No test spawns a real browser —
// openInBrowser() is never invoked in these tests (every watch invocation
// below passes '--no-open' or TYCOON_STANDALONE_NO_OPEN=1).
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, runWatchCommand, parseWatchArgs } from '../src/cli.mjs';

function mkTempDir(prefix = 'tycoon-standalone-cli-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── parseWatchArgs: pure ────────────────────────────────────────────────

test('parseWatchArgs: positional args become dirs, in order', () => {
  assert.deepEqual(parseWatchArgs(['./a', '../b']), { dirs: ['./a', '../b'], noOpen: false });
});

test('parseWatchArgs: --no-open is recognized and excluded from dirs', () => {
  assert.deepEqual(parseWatchArgs(['./a', '--no-open']), { dirs: ['./a'], noOpen: true });
  assert.deepEqual(parseWatchArgs(['--no-open', './a']), { dirs: ['./a'], noOpen: true });
});

test('parseWatchArgs: no args yields empty dirs and noOpen false', () => {
  assert.deepEqual(parseWatchArgs([]), { dirs: [], noOpen: false });
});

test('parseWatchArgs: unknown flags are ignored, not treated as dirs', () => {
  assert.deepEqual(parseWatchArgs(['--bogus-flag', './a']), { dirs: ['./a'], noOpen: false });
});

// ── runCli: dispatch table ──────────────────────────────────────────────

test('runCli: no command prints usage and exits 1', async () => {
  assert.equal(await runCli([]), 1);
});

test('runCli: help/-h/--help exit 0', async () => {
  assert.equal(await runCli(['help']), 0);
  assert.equal(await runCli(['-h']), 0);
  assert.equal(await runCli(['--help']), 0);
});

test('runCli: unknown command exits 1', async () => {
  assert.equal(await runCli(['bogus-command']), 1);
});

test('runCli: install-hook with no <dir> exits 1', async () => {
  assert.equal(await runCli(['install-hook']), 1);
});

test('runCli: watch with a nonexistent dir exits 1 cleanly (does not hang, does not throw)', async () => {
  const missing = path.join(os.tmpdir(), 'tycoon-standalone-cli-test-missing-' + Date.now());
  const code = await runCli(['watch', missing, '--no-open']);
  assert.equal(code, 1);
});

test('runCli: install-hook --opencode prints coming-soon, exits 1, writes nothing', async () => {
  const dir = mkTempDir();
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    assert.equal(await runCli(['install-hook', dir, '--opencode']), 1);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((m) => /OpenCode support is coming soon\./.test(m)));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('runCli: help lists claude-code|codex and no --opencode', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await runCli([]);
  } finally {
    console.error = orig;
  }
  const text = errs.join('\n');
  assert.match(text, /claude-code\|codex/);
  assert.doesNotMatch(text, /--opencode/);
});

// ── runWatchCommand: full happy path against a real ephemeral server ────

test('runWatchCommand: starts a real server, then cleanly stops via AbortSignal (no real SIGINT/SIGTERM used)', async () => {
  const projectRoot = mkTempDir();
  const tycoonDir = path.join(projectRoot, '.claude', 'tycoon');
  fs.mkdirSync(tycoonDir, { recursive: true });
  fs.writeFileSync(
    path.join(tycoonDir, 'activity.jsonl'),
    JSON.stringify({ event: 'UserPromptSubmit', at: Date.now(), sessionId: 'sess-cli-watch-test' }) + '\n',
    'utf8',
  );

  const env = { ...process.env, TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_NO_OPEN: '1' };
  const controller = new AbortController();

  const watchPromise = runWatchCommand([projectRoot, '--no-open'], {
    env,
    cwd: projectRoot,
    signal: controller.signal,
  });

  // Give the server a moment to actually bind before asking it to stop —
  // runWatchCommand only returns once startServer() has resolved (the
  // `await startServer(...)` inside it), so as soon as that internal await
  // settles the server is already listening; there's no fixed-window race
  // to poll around here, but a short yield keeps this from immediately
  // aborting before startServer's internal listen() has had a scheduler
  // turn.
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();

  const code = await watchPromise;
  assert.equal(code, 0);
});

test('runWatchCommand: bad project dir returns 1 without hanging (no signal ever needed)', async () => {
  const missing = path.join(os.tmpdir(), 'tycoon-standalone-cli-test-missing-2-' + Date.now());
  const code = await runWatchCommand([missing, '--no-open'], {
    env: { ...process.env, TYCOON_STANDALONE_PORT: '0' },
    cwd: process.cwd(),
  });
  assert.equal(code, 1);
});
