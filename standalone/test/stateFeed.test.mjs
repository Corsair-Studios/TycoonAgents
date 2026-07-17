// TycoonAgents standalone — automated contract test for stateFeed.mjs (p2-t3).
//
// Drives createStateFeed() against a REAL fixture .claude/tycoon/activity.jsonl
// (real HookRecord shapes — see src/providers/claude-code/hookRecord.ts:
// { event, tool?, workerId?, tokens?, model?, agentDescription?, tier?,
// parentId?, delegationMode?, sessionId?, at }) written into an OS-temp
// project dir, and asserts the emitted { type, state } message matches the
// exact contract src/host/vscode/panel.ts posts for MSG.STATE (see
// stateFeed.mjs's module header) — SSE event name "message", payload
// { type: "state", state }, with state.modeStats attached the same way
// panel.ts's _withModeStats does (computeDelegationModeStats(state.agentMetrics)).
//
// Requires `npx tsc -p .` (run from the repo root) to have produced
// out/src/core/state.js and out/src/providers/claude-code/mapHookRecord.js
// first — sharedLogic.mjs throws an actionable error otherwise (see its
// requireCompiled()).
//
// Plain ESM, run via `node --test test/` from standalone/ (see
// standalone/package.json's "test" script) — deliberately NOT part of the
// root tsc/CommonJS-compiled test suite: out/test/*.js is CommonJS
// (tsconfig.json's module: "CommonJS") and cannot require() an ESM .mjs
// module, and TS down-levels a dynamic import() into a require() under
// CommonJS too, so this suite must live and run standalone. See this task's
// brief for the full rationale — this is an accepted, expected deviation
// from "tests live under root test/".
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path) —
// no new dependencies, consistent with standalone/package.json shipping zero
// deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateFeed } from '../src/stateFeed.mjs';

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-test-'));
}

function tycoonPaths(projectRoot) {
  const dir = path.join(projectRoot, '.claude', 'tycoon');
  return { dir, activityPath: path.join(dir, 'activity.jsonl') };
}

function writeFixture(projectRoot, records) {
  const { dir, activityPath } = tycoonPaths(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(activityPath, lines, 'utf8');
}

function appendFixture(projectRoot, records) {
  const { activityPath } = tycoonPaths(projectRoot);
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(activityPath, lines, 'utf8');
}

function rmTempProject(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

// Bounded poll wait — no real network, no unbounded wall-clock reliance.
// activityWatcher.mjs polls every 250ms by default; 5s / 50ms give ample
// margin without hanging the suite on a genuine regression.
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

const BASE_T = 1700000000000; // fixed epoch ms so fixtures are deterministic

test('createStateFeed: fixture backlog produces a real MSG.STATE-shaped broadcast', async () => {
  const projectRoot = mkTempProject();
  try {
    writeFixture(projectRoot, [
      { event: 'UserPromptSubmit', at: BASE_T, sessionId: 'sess-1' },
      {
        event: 'PreToolUse',
        tool: 'Task',
        workerId: 'coding-specialist',
        model: 'claude-sonnet-5',
        agentDescription: 'Implements features',
        tier: 'worker',
        delegationMode: 'flat',
        at: BASE_T + 1000,
        sessionId: 'sess-1',
      },
      {
        event: 'SubagentStop',
        workerId: 'coding-specialist',
        tokens: 1234,
        at: BASE_T + 5000,
        sessionId: 'sess-1',
      },
    ]);

    const calls = [];
    const feed = createStateFeed({ projectRoot, broadcast: fakeBroadcast(calls) });
    try {
      await waitFor(() => calls.length > 0);

      const last = calls[calls.length - 1];
      assert.equal(last.eventName, 'message');
      assert.equal(last.data.type, 'state');
      assert.ok(last.data.state && typeof last.data.state === 'object');

      const { state } = last.data;
      assert.ok(Array.isArray(state.agentMetrics));
      const ids = state.agentMetrics.map((m) => m.id);
      assert.ok(ids.includes('coding-specialist'), `expected coding-specialist in ${JSON.stringify(ids)}`);
      assert.ok(ids.includes('orchestrator'), `expected orchestrator in ${JSON.stringify(ids)}`);

      const codingAgent = state.agentMetrics.find((m) => m.id === 'coding-specialist');
      assert.equal(codingAgent.tokens, 1234);
      assert.equal(codingAgent.model, 'claude-sonnet-5');

      assert.ok(Array.isArray(state.modeStats), 'state.modeStats must be attached, mirroring _withModeStats');
    } finally {
      feed.close();
    }
  } finally {
    rmTempProject(projectRoot);
  }
});

test('createStateFeed: a live append updates the broadcast and RETAINS previously-seen agents', async () => {
  const projectRoot = mkTempProject();
  try {
    writeFixture(projectRoot, [
      { event: 'UserPromptSubmit', at: BASE_T, sessionId: 'sess-2' },
      {
        event: 'PreToolUse',
        tool: 'Task',
        workerId: 'coding-specialist',
        model: 'claude-sonnet-5',
        at: BASE_T + 1000,
        sessionId: 'sess-2',
      },
      { event: 'SubagentStop', workerId: 'coding-specialist', tokens: 500, at: BASE_T + 2000, sessionId: 'sess-2' },
    ]);

    const calls = [];
    const feed = createStateFeed({ projectRoot, broadcast: fakeBroadcast(calls) });
    try {
      await waitFor(() => calls.length > 0);
      const initialIds = calls[calls.length - 1].data.state.agentMetrics.map((m) => m.id);
      assert.ok(initialIds.includes('coding-specialist'));

      const callsBeforeAppend = calls.length;
      appendFixture(projectRoot, [
        {
          event: 'PreToolUse',
          tool: 'Task',
          workerId: 'testing-specialist',
          model: 'claude-sonnet-5',
          at: BASE_T + 3000,
          sessionId: 'sess-2',
        },
      ]);

      await waitFor(() => calls.length > callsBeforeAppend);
      const updatedIds = calls[calls.length - 1].data.state.agentMetrics.map((m) => m.id);
      assert.ok(updatedIds.includes('testing-specialist'), 'new agent from live append must appear');
      assert.ok(
        updatedIds.includes('coding-specialist'),
        'previously-seen agent must be retained (accumulator semantics)',
      );
    } finally {
      feed.close();
    }
  } finally {
    rmTempProject(projectRoot);
  }
});

test('createStateFeed: getStateMessage() gives a late-connecting client real state, not a blank board', async () => {
  const projectRoot = mkTempProject();
  try {
    writeFixture(projectRoot, [
      { event: 'UserPromptSubmit', at: BASE_T, sessionId: 'sess-3' },
      {
        event: 'PreToolUse',
        tool: 'Task',
        workerId: 'ux-ui-designer',
        model: 'claude-sonnet-5',
        at: BASE_T + 1000,
        sessionId: 'sess-3',
      },
      { event: 'SubagentStop', workerId: 'ux-ui-designer', tokens: 42, at: BASE_T + 2000, sessionId: 'sess-3' },
    ]);

    const calls = [];
    const feed = createStateFeed({ projectRoot, broadcast: fakeBroadcast(calls) });
    try {
      await waitFor(() => calls.length > 0);

      // Simulate a browser tab connecting AFTER the backlog has already been
      // processed — server.mjs's /events handler calls getStateMessage() via
      // registerInitialMessageProvider for exactly this case.
      const msg = feed.getStateMessage();
      assert.equal(msg.type, 'state');
      assert.ok(msg.state, 'late client must see real state, not null');
      const ids = msg.state.agentMetrics.map((m) => m.id);
      assert.ok(ids.includes('ux-ui-designer'));
    } finally {
      feed.close();
    }
  } finally {
    rmTempProject(projectRoot);
  }
});

test('createStateFeed: an empty project (no .claude/tycoon) does not throw and yields a renderable non-null state', async () => {
  const projectRoot = mkTempProject();
  try {
    // Deliberately do NOT create .claude/tycoon/activity.jsonl.
    const calls = [];
    let feed;
    assert.doesNotThrow(() => {
      feed = createStateFeed({ projectRoot, broadcast: fakeBroadcast(calls) });
    });
    try {
      const msg = feed.getStateMessage();
      assert.equal(msg.type, 'state');
      assert.ok(msg.state && typeof msg.state === 'object', 'must be a renderable non-null state');
      assert.equal(msg.state.sessionActive, false);
      assert.ok(Array.isArray(msg.state.agentMetrics));
      assert.equal(msg.state.agentMetrics.length, 0);
    } finally {
      feed.close();
    }
  } finally {
    rmTempProject(projectRoot);
  }
});
