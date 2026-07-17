// TycoonAgents standalone — unit/integration tests for server.mjs's
// startServer() seam (p4-t1).
//
// startServer() is the exact function standalone/src/cli.mjs's `watch`
// command drives (see that file's runWatchCommand()) — these tests exercise
// it directly against a real fixture project and a real (ephemeral-port)
// http server, proving:
//   - it actually serves the host page + real media assets end-to-end
//   - relative project-dir args resolve against the CALLER-PROVIDED cwd,
//     never a hardcoded repo path (the p3-t1-review footgun this task fixed)
//   - a bad project dir still throws ProjectRootError (server.mjs's prior
//     contract, unchanged)
//   - a port already in use surfaces a clean ServerStartError, not a raw
//     EADDRINUSE stack trace
//   - close() actually releases the port (no dangling listener)
//
// Every server is started on port 0 (OS-assigned, collision-free) and
// closed in a `finally` so no server outlives its test.
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path);
// uses the global `fetch` (stable in the Node 18+ this package targets — see
// package.json engines) to talk to the real server, not a mocked transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ServerStartError } from '../src/server.mjs';
import { ProjectRootError } from '../src/projectRoots.mjs';

function mkTempProject(prefix = 'tycoon-standalone-server-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixtureActivity(projectRoot, records) {
  const dir = path.join(projectRoot, '.claude', 'tycoon');
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'activity.jsonl'), lines, 'utf8');
}

test('startServer: serves the host page and real media assets end-to-end (ephemeral port)', async () => {
  const projectRoot = mkTempProject();
  writeFixtureActivity(projectRoot, [
    { event: 'UserPromptSubmit', at: Date.now(), sessionId: 'sess-server-test-1' },
  ]);

  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  try {
    assert.equal(runtime.primary.root, path.resolve(projectRoot));
    assert.ok(runtime.port > 0, 'must report the real OS-assigned port, not 0');
    assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const pageRes = await fetch(`${runtime.url}/`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.match(html, /TycoonAgents/);
    assert.match(html, /acquireVsCodeApi/);

    const mediaRes = await fetch(`${runtime.url}/media/main.js`);
    assert.equal(mediaRes.status, 200, 'must serve the real repo media/main.js in place');
  } finally {
    await runtime.close();
  }
});

test('startServer: /events is a live SSE stream that responds immediately', async () => {
  const projectRoot = mkTempProject();
  writeFixtureActivity(projectRoot, [
    { event: 'UserPromptSubmit', at: Date.now(), sessionId: 'sess-server-test-2' },
    { event: 'PreToolUse', tool: 'Task', workerId: 'coding-specialist', model: 'claude-sonnet-5', at: Date.now() + 1, sessionId: 'sess-server-test-2' },
    { event: 'SubagentStop', workerId: 'coding-specialist', tokens: 99, at: Date.now() + 2, sessionId: 'sess-server-test-2' },
  ]);

  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const res = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const reader = res.body.getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false);
    const text = Buffer.from(value).toString('utf8');
    assert.ok(text.length > 0, 'first SSE chunk must be non-empty');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('startServer: relative project dir resolves against the PROVIDED cwd, not a hardcoded repo path (p3-t1-review fix)', async () => {
  const outerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-cwd-outer-'));
  try {
    const projectRoot = path.join(outerTemp, 'my-project');
    fs.mkdirSync(projectRoot);

    // Relative arg '.' with cwd explicitly set to outerTemp/my-project must
    // resolve to that exact directory — proving startServer threads `cwd`
    // through to resolveProjectRoots() rather than defaulting to REPO_ROOT
    // (server.mjs's own `npm start` main() is the ONLY caller allowed to
    // default cwd to REPO_ROOT; every other caller, including this one and
    // cli.mjs's watch command, must pass its own real cwd explicitly).
    const runtime = await startServer({
      argv: ['.'],
      env: { TYCOON_STANDALONE_PORT: '0' },
      cwd: projectRoot,
    });
    try {
      assert.equal(runtime.primary.root, path.resolve(projectRoot));
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(outerTemp, { recursive: true, force: true });
  }
});

test('startServer: a bad project directory throws ProjectRootError (unchanged contract)', async () => {
  const cwd = mkTempProject();
  const missing = path.join(os.tmpdir(), 'tycoon-standalone-server-test-missing-' + Date.now());
  await assert.rejects(
    () => startServer({ argv: [missing], env: { TYCOON_STANDALONE_PORT: '0' }, cwd }),
    ProjectRootError,
  );
});

test('startServer: a port already in use surfaces a clean ServerStartError, not a raw EADDRINUSE stack', async () => {
  const projectRoot = mkTempProject();
  const first = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  try {
    await assert.rejects(
      () =>
        startServer({
          argv: [projectRoot],
          env: { TYCOON_STANDALONE_PORT: String(first.port) },
          cwd: projectRoot,
        }),
      (err) => {
        assert.ok(err instanceof ServerStartError, `expected ServerStartError, got ${err}`);
        assert.match(err.message, /already in use/i);
        assert.ok(err.message.includes(String(first.port)), 'message should name the offending port');
        return true;
      },
    );
  } finally {
    await first.close();
  }
});

test('startServer: close() actually releases the port (can rebind immediately after)', async () => {
  const projectRoot = mkTempProject();
  const first = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const boundPort = first.port;
  await first.close();

  // Rebinding the exact same port right after close() must succeed — proves
  // close() actually released the listener instead of leaving it dangling.
  const second = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: String(boundPort) },
    cwd: projectRoot,
  });
  try {
    assert.equal(second.port, boundPort);
  } finally {
    await second.close();
  }
});
