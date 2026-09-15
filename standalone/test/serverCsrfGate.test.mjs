// TycoonAgents standalone — CSRF/token gate tests (p49-t0).
//
// Exercises checkOriginAndToken() in standalone/src/server.mjs: every POST
// and GET /events must carry the in-memory sessionToken (X-Tycoon-Token
// header for POST, ?token= query for /events) or get 403 {error:"forbidden"}
// BEFORE any side effect; an Origin header that isn't this server's own
// origin is rejected even with a valid token; every response gets
// Access-Control-Allow-Origin pinned to the request's own origin (never
// "*") and X-Content-Type-Options: nosniff. Harness pattern follows
// standalone/test/teamSetupExport.test.mjs (temp project root,
// runtime.close in finally).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

function mkTempAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-csrf-'));
}

function seedFixtureProject(root) {
  const agentsDir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'coding-specialist.md'),
    '---\nname: Coding Specialist\n---\n\n# Coding Specialist\n\n## Role\nImplements things.\n',
    'utf8',
  );
}

async function withServer(fn) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-csrf-project-'));
  const appDataDir = mkTempAppData();
  seedFixtureProject(projectRoot);

  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
  });
  try {
    await fn({ runtime, projectRoot });
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
}

test('POST /message without token: 403 forbidden, no side effect', async () => {
  await withServer(async ({ runtime, projectRoot }) => {
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'EXPORT_TEAM_SETUP' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, { error: 'forbidden' });

    const manifestPath = path.join(projectRoot, '.claude', 'tycoon-team.json');
    assert.equal(fs.existsSync(manifestPath), false, 'manifest must NOT be written without a valid token');
  });
});

test('POST /message with the correct token: succeeds and writes the file', async () => {
  await withServer(async ({ runtime, projectRoot }) => {
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'EXPORT_TEAM_SETUP' }),
    });
    assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);

    // The write is dispatched async off the /message handler; poll briefly
    // for the file to appear rather than asserting on response timing.
    const manifestPath = path.join(projectRoot, '.claude', 'tycoon-team.json');
    let found = fs.existsSync(manifestPath);
    for (let i = 0; i < 50 && !found; i++) {
      await new Promise((r) => setTimeout(r, 20));
      found = fs.existsSync(manifestPath);
    }
    assert.ok(found, 'manifest file must exist on disk after a token-bearing POST');
  });
});

test('POST /theme-import without token: 403 forbidden', async () => {
  await withServer(async ({ runtime }) => {
    const res = await fetch(`${runtime.url}/theme-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: Buffer.from('not-a-real-zip'),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, { error: 'forbidden' });
  });
});

test('GET /events without token: 403 forbidden', async () => {
  await withServer(async ({ runtime }) => {
    const res = await fetch(`${runtime.url}/events`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, { error: 'forbidden' });
  });
});

test('GET /events with ?token=: 200 text/event-stream', async () => {
  await withServer(async ({ runtime }) => {
    const controller = new AbortController();
    try {
      const res = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      assert.ok(value && value.byteLength > 0, 'expected at least one chunk of SSE data');
    } finally {
      controller.abort();
    }
  });
});

test('POST /message with correct token but a foreign Origin: 403, no side effect', async () => {
  await withServer(async ({ runtime, projectRoot }) => {
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: {
        'X-Tycoon-Token': runtime.sessionToken,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ type: 'EXPORT_TEAM_SETUP' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, { error: 'forbidden' });

    const manifestPath = path.join(projectRoot, '.claude', 'tycoon-team.json');
    assert.equal(fs.existsSync(manifestPath), false, 'manifest must NOT be written when Origin mismatches');
  });
});

test('GET / succeeds without a token, carries the session token in meta, and sets security headers', async () => {
  await withServer(async ({ runtime }) => {
    const res = await fetch(`${runtime.url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = html.match(/<meta name="tycoon-token" content="([^"]+)"/);
    assert.ok(match, 'expected a tycoon-token meta tag in the page HTML');
    assert.equal(match[1], runtime.sessionToken);

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('A wrong token of the same length: 403 forbidden', async () => {
  await withServer(async ({ runtime }) => {
    const wrongToken = runtime.sessionToken
      .split('')
      .map((c) => (c === '0' ? '1' : '0'))
      .join('');
    assert.equal(wrongToken.length, runtime.sessionToken.length);
    assert.notEqual(wrongToken, runtime.sessionToken);

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': wrongToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'EXPORT_TEAM_SETUP' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, { error: 'forbidden' });
  });
});
