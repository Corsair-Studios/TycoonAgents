// TycoonAgents standalone — round-trip test for the Agents screen's
// openAgentFile message (provenance-line "Open" link on a hand-written-
// backend agent). Proves server.mjs's 'openAgentFile' case in
// handleBrowserMessage refuses an unsafe id via the same isSafeAgentId guard
// removeAgent uses, without ever spawning a child process. Same
// real-HTTP-server pattern as agentKeywordsAndRemoveAgent.test.mjs.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { startServer } from '../src/server.mjs';

function mkTempProject(prefix = 'tycoon-standalone-openagentfile-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixtureAgent(projectRoot, filename, frontmatterLines) {
  const dir = path.join(projectRoot, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), `---\n${frontmatterLines.join('\n')}\n---\n\nBody.\n`, 'utf8');
}

test('POST /message {type: "openAgentFile"} with an unsafe id -> refused, no child process spawned', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const spawnMock = mock.method(childProcess, 'spawn', () => {
    throw new Error('spawn should not have been called for an unsafe id');
  });
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  try {
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'openAgentFile', id: '../../etc/passwd' }),
    });
    assert.equal(res.status, 202);
    // Give the fire-and-forget handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(spawnMock.mock.callCount(), 0, 'spawn must not be called for a rejected id');
  } finally {
    spawnMock.mock.restore();
    await runtime.close();
  }
});

test('POST /message {type: "openAgentFile"} with a missing agent file -> refused, no child process spawned', async () => {
  const projectRoot = mkTempProject();
  const spawnMock = mock.method(childProcess, 'spawn', () => {
    throw new Error('spawn should not have been called for a missing file');
  });
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  try {
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'openAgentFile', id: 'no-such-agent' }),
    });
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(spawnMock.mock.callCount(), 0, 'spawn must not be called when the agent file does not exist');
  } finally {
    spawnMock.mock.restore();
    await runtime.close();
  }
});
