// TycoonAgents standalone — relay conversion parity (saveRouting -> scripts/apply-routing-profile.mjs --relay).
// The standalone host shares src/core/routingHostOps.js with the VS Code host, so a Save of a bridged
// foreign-provider slot must turn the agent into a managed relay, and an Anthropic Save must restore it exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-claude-cfg-'));
process.env.TYCOON_CLAUDE_BIN = 'none';

const ORIGINAL = '---\nname: coding-specialist\ndescription: "Implements code."\nmodel: sonnet\ndisallowedTools: Agent\n---\n\n# Coding Specialist\n\n## Role\nImplements code.\n';

async function saveAndWait(runtime, reader, profile) {
  let buffer = '';
  const res = await fetch(`${runtime.url}/message`, { method: 'POST', headers: { 'X-Tycoon-Token': runtime.sessionToken }, body: JSON.stringify({ type: 'saveRouting', profile }) });
  assert.equal(res.status, 202);
  for (let i = 0; i < 100; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += Buffer.from(value).toString('utf8');
    const m = /"type":"routingSaved"[^\n]*/.exec(buffer);
    if (m) {
      const line = buffer.split('\n\n').find((c) => c.includes('"type":"routingSaved"'));
      return JSON.parse(line.split('\n').find((l) => l.startsWith('data: ')).slice(6));
    }
  }
  throw new Error('no routingSaved event');
}

test('standalone saveRouting relays a codex-routed agent and restores it on an Anthropic Save', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-relay-'));
  const file = path.join(projectRoot, '.claude', 'agents', 'coding-specialist.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ORIGINAL, 'utf8');
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const codex = { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', tools: ['codex', 'codex-reply'], model: 'openai/gpt-6.1-sol', costModelClass: 'subscription' };
    const saved = await saveAndWait(runtime, reader, { version: 1, agents: { 'coding-specialist': codex } });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const relayed = fs.readFileSync(file, 'utf8');
    assert.match(relayed, /^tycoon_relay: codex$/m);
    assert.match(relayed, /^tycoon_relay_original_model: sonnet$/m);
    assert.match(relayed, /^model: haiku$/m);
    assert.ok(relayed.includes('## Relay (managed by TycoonAgents)'));
    assert.ok(relayed.includes('mcp__codex__codex'));
    assert.ok(relayed.includes('<!-- tycoon:relay-original:begin -->\n\n# Coding Specialist\n\n## Role\nImplements code.\n\n<!-- tycoon:relay-original:end -->'));

    const back = await saveAndWait(runtime, reader, { version: 1, agents: { 'coding-specialist': { vendor: 'anthropic', transport: 'claude-native', model: 'anthropic/sonnet', costModelClass: 'subscription' } } });
    assert.equal(back.ok, true, JSON.stringify(back));
    const restored = fs.readFileSync(file, 'utf8');
    assert.ok(!restored.includes('tycoon_relay'));
    assert.ok(!restored.includes('tycoon:relay'));
    assert.match(restored, /^model: sonnet$/m);
    assert.ok(restored.endsWith('\n---\n\n# Coding Specialist\n\n## Role\nImplements code.\n'), 'body restored byte-identical');
  } finally {
    controller.abort();
    await runtime.close();
  }
});
