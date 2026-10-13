// Standalone saveRouting -> routingServerSetup (Multi-LLM in Agents): the save reply goes out
// first, then routingServerSetup carries { registered, failed, newChatHint }. The Codex harness
// registers nothing. getPacks no longer lists the hidden multi-llm catalog entry.
// Never touches the real ~/.claude.json or `claude` binary (temp CLAUDE_CONFIG_DIR, TYCOON_CLAUDE_BIN=none).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-claude-cfg-'));
process.env.TYCOON_CLAUDE_BIN = 'none';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Records every SSE event in order so ordering can be asserted. */
function createRecorder(reader) {
  const events = [];
  let buffer = '';
  let closed = false;
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString('utf8');
        let i;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
          waiters.splice(0).forEach((w) => w());
        }
      }
    } catch { /* aborted */ }
    closed = true;
    waiters.splice(0).forEach((w) => w());
  })();
  async function waitFor(type, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      const idx = events.findIndex((e) => e.type === type);
      if (idx !== -1) return idx;
      if (closed || Date.now() > end) throw new Error(`no "${type}" event; saw ${events.map((e) => e.type).join(',')}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  }
  return { events, waitFor };
}

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-routing-setup-'));
}

async function saveRouting(runtime, profile) {
  const res = await fetch(`${runtime.url}/message`, {
    method: 'POST',
    headers: { 'X-Tycoon-Token': runtime.sessionToken },
    body: JSON.stringify({ type: 'saveRouting', profile }),
  });
  assert.equal(res.status, 202);
}

const foreignProfile = {
  version: 1,
  agents: { 'coding-specialist': { vendor: 'openai', transport: 'mcp', model: 'openai/gpt-x', costModelClass: 'subscription' } },
};

test('saveRouting with a foreign-vendor slot: routingSaved precedes routingServerSetup, which carries { registered, failed, newChatHint }', async () => {
  const projectRoot = mkProject();
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const rec = createRecorder(eventsRes.body.getReader());
    await saveRouting(runtime, foreignProfile);
    const setupIdx = await rec.waitFor('routingServerSetup');
    const savedIdx = rec.events.findIndex((e) => e.type === 'routingSaved');
    assert.ok(savedIdx !== -1, 'routingSaved was sent');
    assert.ok(savedIdx < setupIdx, `routingSaved (${savedIdx}) must come before routingServerSetup (${setupIdx})`);
    assert.equal(rec.events[savedIdx].ok, true);
    const setup = rec.events[setupIdx];
    assert.ok(Array.isArray(setup.registered), 'registered is an array');
    assert.ok(Array.isArray(setup.failed), 'failed is an array');
    assert.equal(typeof setup.newChatHint, 'boolean');
    // The codex server was attempted: it is in exactly one of the two lists.
    const inRegistered = setup.registered.includes('codex');
    const inFailed = setup.failed.some((f) => f.server === 'codex' && typeof f.error === 'string');
    assert.ok(inRegistered !== inFailed, `codex must be registered or failed: ${JSON.stringify(setup)}`);
    if (setup.registered.length === 0) assert.equal(setup.newChatHint, false, 'no hint without a registration');
    // A re-save with the same profile registers nothing new (unchanged slot).
    const before = rec.events.filter((e) => e.type === 'routingServerSetup').length;
    await saveRouting(runtime, foreignProfile);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(rec.events.filter((e) => e.type === 'routingServerSetup').length, before, 'unchanged slot does not re-register');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('saveRouting on the Codex harness registers nothing (no routingServerSetup, no .mcp.json)', async () => {
  const projectRoot = mkProject();
  const prev = process.env.TYCOON_PROVIDER;
  process.env.TYCOON_PROVIDER = 'codex';
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0', TYCOON_PROVIDER: 'codex' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const rec = createRecorder(eventsRes.body.getReader());
    await saveRouting(runtime, foreignProfile);
    await rec.waitFor('routingSaved');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(rec.events.some((e) => e.type === 'routingServerSetup'), false, 'no routingServerSetup on Codex');
    assert.equal(fs.existsSync(path.join(projectRoot, '.mcp.json')), false, 'no .mcp.json written');
  } finally {
    if (prev === undefined) delete process.env.TYCOON_PROVIDER; else process.env.TYCOON_PROVIDER = prev;
    controller.abort();
    await runtime.close();
  }
});

test('getPacks (standalone) no longer lists multi-llm; the catalog entry stays hidden', async () => {
  const projectRoot = mkProject();
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'media', 'packs', 'catalog.json'), 'utf8'));
    assert.equal(catalog.find((p) => p.id === 'multi-llm').hidden, true);
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const rec = createRecorder(eventsRes.body.getReader());
    await fetch(`${runtime.url}/message`, { method: 'POST', headers: { 'X-Tycoon-Token': runtime.sessionToken }, body: JSON.stringify({ type: 'getPacks' }) });
    const idx = await rec.waitFor('packs');
    const packs = rec.events[idx].packs;
    assert.equal(packs.some((p) => p.id === 'multi-llm'), false);
    assert.equal(packs.length, catalog.filter((p) => !p.hidden).length);
  } finally {
    controller.abort();
    await runtime.close();
  }
});
