// TycoonAgents standalone — round-trip tests for the Agents screen's
// setAgentKeywords/removeAgent messages, driven through the REAL HTTP
// server (POST /message + SSE /events collector), same pattern as
// routingMessages.test.mjs. Proves server.mjs's handleBrowserMessage cases
// for 'setAgentKeywords' and 'removeAgent' (previously missing) actually
// write .claude/tycoon/agent-keywords.json / delete .claude/agents/<id>.md
// and reply the shapes media/main.js expects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';

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

function mkTempProject(prefix = 'tycoon-standalone-agentkw-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixtureAgent(projectRoot, filename, frontmatterLines) {
  const dir = path.join(projectRoot, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), `---\n${frontmatterLines.join('\n')}\n---\n\nBody.\n`, 'utf8');
}

test('POST /message {type: "setAgentKeywords"} -> writes the pattern into agent-keywords.json and replies settingsUpdated ok:true', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const updatedPromise = collectSseEvent(reader, 'settingsUpdated');

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'setAgentKeywords', id: 'coding-specialist', pattern: 'implement|refactor' }),
    });
    assert.equal(res.status, 202);

    const updated = await updatedPromise;
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.id, 'coding-specialist');
    assert.equal(updated.field, 'keywords');

    const cfg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'agent-keywords.json'), 'utf8'),
    );
    assert.equal(cfg.agents['coding-specialist'].pattern, 'implement|refactor');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "removeAgent"} -> deletes the agent file, strips its keyword entry, and replies agentRemoved ok:true', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const keywordsPath = path.join(projectRoot, '.claude', 'tycoon', 'agent-keywords.json');
  fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
  fs.writeFileSync(
    keywordsPath,
    JSON.stringify({ fallback_agent: 'primary-agent', agents: { 'coding-specialist': { pattern: 'implement' } } }),
  );
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const removedPromise = collectSseEvent(reader, 'agentRemoved');

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'removeAgent', id: 'coding-specialist' }),
    });
    assert.equal(res.status, 202);

    const removed = await removedPromise;
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.id, 'coding-specialist');

    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'agents', 'coding-specialist.md')), false);
    const cfg = JSON.parse(fs.readFileSync(keywordsPath, 'utf8'));
    assert.equal('coding-specialist' in cfg.agents, false);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "removeAgent"} with an unsafe id -> refuses, replies agentRemoved ok:false, no file touched', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const removedPromise = collectSseEvent(reader, 'agentRemoved');

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'removeAgent', id: '../../etc/passwd' }),
    });
    assert.equal(res.status, 202);

    const removed = await removedPromise;
    assert.equal(removed.ok, false, JSON.stringify(removed));

    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'agents', 'coding-specialist.md')), true);
  } finally {
    controller.abort();
    await runtime.close();
  }
});
