// TycoonAgents standalone — activityWatcher.mjs transient-fs-error resilience.
//
// Regression coverage for the bug where a Windows atomic tmp-then-rename
// write (hooks/tycoon-claude-hook.cjs's atomicWriteSync, or the VS Code
// host's equivalent) briefly makes active-agent.json unreadable and
// activityWatcher.mjs's poll threw EPERM/EBUSY/ENOENT straight into
// stateFeed.mjs's onError, which only logs — the watcher itself must keep
// polling and must keep surfacing the LAST known state, never tear down.
//
// Node built-ins only (node:test, node:assert, node:fs); stubs
// fs.readFileSync directly (the module under test calls it unqualified via
// its `import fs from 'node:fs'` default import, so patching the property on
// that same live object is visible to it) rather than mocking the module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityWatcher } from '../src/activityWatcher.mjs';

function mkTmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-activitywatcher-'));
  fs.mkdirSync(path.join(root, '.claude', 'tycoon'), { recursive: true });
  return root;
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

test('activityWatcher survives a transient EPERM reading active-agent.json and keeps polling', async () => {
  const root = mkTmpProject();
  const activeAgentPath = path.join(root, '.claude', 'tycoon', 'active-agent.json');
  const finalState = { version: 1, agentId: 'agent-2', timestamp: Date.now(), stack: ['agent-2'] };
  fs.writeFileSync(activeAgentPath, JSON.stringify(finalState));

  const realReadFileSync = fs.readFileSync;
  let throwOnce = true;
  fs.readFileSync = function patched(...args) {
    if (throwOnce && String(args[0]) === activeAgentPath) {
      throwOnce = false;
      const err = new Error('EPERM: operation not permitted, open ' + activeAgentPath);
      err.code = 'EPERM';
      throw err;
    }
    return realReadFileSync.apply(fs, args);
  };

  const seenStates = [];
  const errors = [];
  let watcher;
  try {
    watcher = createActivityWatcher(root, {
      pollIntervalMs: 30,
      onActiveAgent: (state) => seenStates.push(state),
      onError: (err) => errors.push(err),
    });

    const ok = await waitFor(() => seenStates.some((s) => s && s.agentId === 'agent-2'));
    assert.equal(ok, true, 'watcher should recover and surface active-agent.json state after a transient EPERM');
    // Never surfaced null (cleared state) because of the transient failure.
    assert.equal(seenStates.some((s) => s === null), false);
    assert.equal(throwOnce, false, 'the stub should have fired at least once');
  } finally {
    if (watcher) watcher.close();
    fs.readFileSync = realReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activityWatcher rate-limits onError for repeated transient failures instead of logging every tick', async () => {
  const root = mkTmpProject();
  const activeAgentPath = path.join(root, '.claude', 'tycoon', 'active-agent.json');
  fs.writeFileSync(activeAgentPath, JSON.stringify({ version: 1, stack: [] }));

  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function alwaysThrows(...args) {
    if (String(args[0]) === activeAgentPath) {
      const err = new Error('EBUSY: resource busy or locked, open ' + activeAgentPath);
      err.code = 'EBUSY';
      throw err;
    }
    return realReadFileSync.apply(fs, args);
  };

  const errors = [];
  let watcher;
  try {
    watcher = createActivityWatcher(root, {
      pollIntervalMs: 15,
      onActiveAgent: () => {},
      onError: (err) => errors.push(err),
    });

    // Let many poll ticks elapse (well beyond the retry-per-tick count) —
    // logging must stay far below one entry per tick.
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(errors.length <= 2, `expected rate-limited logging, got ${errors.length} onError calls`);
  } finally {
    if (watcher) watcher.close();
    fs.readFileSync = realReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
