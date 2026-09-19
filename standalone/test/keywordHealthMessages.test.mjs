// TycoonAgents standalone — round-trip tests for the Agents screen's
// GET_KEYWORD_HEALTH / KEYWORD_HEALTH_FIX messages, driven through the REAL
// HTTP server (POST /message + SSE /events collector), same pattern as
// agentKeywordsAndRemoveAgent.test.mjs. Proves server.mjs's
// handleBrowserMessage cases for 'GET_KEYWORD_HEALTH' and
// 'KEYWORD_HEALTH_FIX' (standalone/src/server.mjs ~1295-1381) actually
// surface findings from a malformed agent-keywords.json and rewrite it with
// a .bak backup on fix_all.

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

function mkTempProject(prefix = 'tycoon-standalone-kwhealth-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixtureAgent(projectRoot, filename, frontmatterLines) {
  const dir = path.join(projectRoot, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), `---\n${frontmatterLines.join('\n')}\n---\n\nBody.\n`, 'utf8');
}

const PROSE_SENTENCE =
  'you write clean focused tested code and should be routed whenever the user mentions implementation work';

function writeMalformedKeywordsConfig(projectRoot) {
  const keywordsPath = path.join(projectRoot, '.claude', 'tycoon', 'agent-keywords.json');
  fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
  fs.writeFileSync(
    keywordsPath,
    JSON.stringify({
      fallback_agent: 'primary-agent',
      agents: { 'coding-specialist': { pattern: PROSE_SENTENCE } },
    }),
  );
  return keywordsPath;
}

test('POST /message {type: "GET_KEYWORD_HEALTH"} -> broadcasts KEYWORD_HEALTH with a prose_pattern finding for a malformed agent-keywords.json', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  writeMalformedKeywordsConfig(projectRoot);
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const healthPromise = collectSseEvent(reader, 'KEYWORD_HEALTH');

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'GET_KEYWORD_HEALTH' }),
    });
    assert.equal(res.status, 202);

    const health = await healthPromise;
    assert.ok(Array.isArray(health.findings), JSON.stringify(health));
    const finding = health.findings.find((f) => f.kind === 'prose_pattern' && f.agentId === 'coding-specialist');
    assert.ok(finding, `expected a prose_pattern finding, got: ${JSON.stringify(health.findings)}`);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "KEYWORD_HEALTH_FIX", action: "fix_all"} -> rewrites agent-keywords.json with a .bak backup and re-broadcasts a clean KEYWORD_HEALTH', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const keywordsPath = writeMalformedKeywordsConfig(projectRoot);
  const originalRaw = fs.readFileSync(keywordsPath, 'utf8');
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const healthPromise = collectSseEvent(reader, 'KEYWORD_HEALTH');

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'KEYWORD_HEALTH_FIX', action: 'fix_all' }),
    });
    assert.equal(res.status, 202);

    const health = await healthPromise;
    assert.ok(
      !health.findings.some((f) => f.kind === 'prose_pattern'),
      `fix_all should drop the prose finding, got: ${JSON.stringify(health.findings)}`,
    );

    const backupPath = `${keywordsPath}.bak`;
    assert.equal(fs.existsSync(backupPath), true, 'fix_all should leave a .bak beside agent-keywords.json');
    assert.equal(fs.readFileSync(backupPath, 'utf8'), originalRaw, '.bak should hold the pre-fix content');

    const rewritten = JSON.parse(fs.readFileSync(keywordsPath, 'utf8'));
    assert.notEqual(rewritten.agents['coding-specialist'].pattern, PROSE_SENTENCE, 'the prose pattern should have been rewritten');
  } finally {
    controller.abort();
    await runtime.close();
  }
});
