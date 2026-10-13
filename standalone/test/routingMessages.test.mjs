// TycoonAgents standalone — round-trip tests for the Routing panel messages
// (plan p13-t1/t2/t4): getRouting/saveRouting/clearRouting/probeEnv, driven
// through the REAL HTTP server exactly like server.test.mjs's getSettings
// test (POST /message + SSE /events collector), proving server.mjs's
// handleBrowserMessage cases actually reach src/core/routingHostOps.js
// (out/src/core/routingHostOps.js) and reply with the wire shapes
// docs/IPC-CONTRACT.md's Routing section documents.
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path);
// real ephemeral-port HTTP server via startServer(), same as server.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';

// Saving a routing profile that uses another provider registers its MCP server in the user's
// Claude config (local scope); keep these tests off the real ~/.claude.json and the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-claude-cfg-'));
process.env.TYCOON_CLAUDE_BIN = 'none';

/** Same collector as server.test.mjs's collectSseEvent — bounded so a
 * missing broadcast fails the test instead of hanging. */
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

/**
 * Stateful SSE collector: unlike collectSseEvent (which owns a fresh,
 * function-local buffer and so DISCARDS any bytes read past the event it
 * matched), this keeps its buffer across calls — needed whenever a single
 * handler call broadcasts two events back-to-back with no intervening
 * fetch() (routingSaved immediately followed by a fresh routing), since
 * those can legitimately arrive in the same underlying TCP chunk (mirrors
 * server.test.mjs's createSseCollector).
 */
function createSseCollector(reader) {
  let buffer = '';
  async function next(matchType, predicate = () => true, maxChunks = 100) {
    for (let i = 0; i < maxChunks; i++) {
      let sepIndex;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          const data = JSON.parse(dataLine.slice('data: '.length));
          if (data.type === matchType && predicate(data)) return data;
        }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString('utf8');
    }
    throw new Error(`createSseCollector.next: no matching "${matchType}" event seen within ${maxChunks} SSE reads`);
  }
  return { next };
}

function mkTempProject(prefix = 'tycoon-standalone-routing-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixtureAgent(projectRoot, filename, frontmatterLines) {
  const dir = path.join(projectRoot, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), `---\n${frontmatterLines.join('\n')}\n---\n\nBody.\n`, 'utf8');
}

test('POST /message {type: "getRouting"} -> broadcasts a "routing" reply with no profile and frontmatter/alias/default sources', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'alias-agent.md', ['name: alias-agent', 'model: haiku']);
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const routingPromise = collectSseEvent(reader, 'routing');

    const res = await fetch(`${runtime.url}/message`, { method: 'POST', headers: { 'X-Tycoon-Token': runtime.sessionToken }, body: JSON.stringify({ type: 'getRouting' }) });
    assert.equal(res.status, 202);

    const routing = await routingPromise;
    assert.equal(routing.payload.profile, null);
    assert.ok(Array.isArray(routing.payload.agents));
    const agent = routing.payload.agents.find((a) => a.id === 'alias-agent');
    assert.equal(agent.source, 'alias');
    assert.equal(agent.backend.model, 'anthropic/haiku');
    assert.ok(Array.isArray(routing.payload.presets.models));
    assert.ok(routing.payload.presets.vendors.includes('anthropic'));
    // p74-t3: the standalone host is always the "multi" Agents UI mode
    // (buildRoutingPayload in standalone/src/server.mjs) — it has no harness
    // concept of its own, so the single-provider-tier simplification never
    // applies and the multi-provider checkbox never shows.
    assert.equal(routing.payload.uiMode, 'multi');
    assert.equal(routing.payload.harness, 'standalone');
    assert.equal(routing.payload.multiProviderCheckboxVisible, false);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "saveRouting"} -> writes routing.json, replies routingSaved ok:true, then a fresh routing reply sourced "routing"', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    const profile = {
      version: 1,
      agents: {
        'coding-specialist': { vendor: 'anthropic', transport: 'claude-native', model: 'anthropic/opus', costModelClass: 'subscription' },
      },
    };
    // Flat on the message — matches media/main.js's actual
    // vscode.postMessage({ type: ROUTING_MSG.SAVE, profile }) shape and
    // panel.ts's MSG_SCHEMAS.SAVE_ROUTING.safeParse(message) (the whole
    // message, not message.payload).
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'saveRouting', profile }),
    });
    assert.equal(res.status, 202);

    const saved = await collector.next('routingSaved');
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.errors.length, 0);

    const written = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'routing.json'), 'utf8'));
    assert.deepEqual(written, profile);

    const routing = await collector.next('routing', (d) =>
      d.payload.agents.some((a) => a.id === 'coding-specialist' && a.source === 'routing'),
    );
    const agent = routing.payload.agents.find((a) => a.id === 'coding-specialist');
    assert.equal(agent.backend.model, 'anthropic/opus');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

// p25-t2: routing.json top-level defaultFallback round-trips through
// saveRouting (write) and getRouting (read), and lands on disk.
test('POST /message {type: "saveRouting"} with defaultFallback -> routing.json on disk and getRouting reply both carry it', async () => {
  const projectRoot = mkTempProject();
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    const defaultFallback = {
      vendor: 'openai',
      transport: 'openai-compatible',
      model: 'openai/gpt-5.4-mini',
      costModelClass: 'metered',
      endpointEnv: 'OPENAI_ENDPOINT',
    };
    const profile = { version: 1, agents: {}, defaultFallback };

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'saveRouting', profile }),
    });
    assert.equal(res.status, 202);

    const saved = await collector.next('routingSaved');
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const written = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'routing.json'), 'utf8'));
    assert.deepEqual(written.defaultFallback, defaultFallback);

    const routingAfterSave = await collector.next('routing');
    assert.deepEqual(routingAfterSave.payload.defaultFallback, defaultFallback);

    // Fresh getRouting confirms the read path independently of the save broadcast.
    const getRes = await fetch(`${runtime.url}/message`, { method: 'POST', headers: { 'X-Tycoon-Token': runtime.sessionToken }, body: JSON.stringify({ type: 'getRouting' }) });
    assert.equal(getRes.status, 202);
    const routing = await collector.next('routing', (d) => d.payload.defaultFallback !== undefined);
    assert.deepEqual(routing.payload.defaultFallback, defaultFallback);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "clearRouting"} -> deletes routing.json and replies with a fresh routing reply falling back to alias', async () => {
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const routingDir = path.join(projectRoot, '.claude', 'tycoon');
  fs.mkdirSync(routingDir, { recursive: true });
  fs.writeFileSync(
    path.join(routingDir, 'routing.json'),
    JSON.stringify({ version: 1, agents: { 'coding-specialist': { model: 'anthropic/opus', vendor: 'anthropic', transport: 'claude-native', costModelClass: 'subscription' } } }),
    'utf8',
  );

  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    const res = await fetch(`${runtime.url}/message`, { method: 'POST', headers: { 'X-Tycoon-Token': runtime.sessionToken }, body: JSON.stringify({ type: 'clearRouting' }) });
    assert.equal(res.status, 202);

    await collector.next('routingSaved');
    assert.equal(fs.existsSync(path.join(routingDir, 'routing.json')), false);

    const routing = await collector.next('routing', (d) =>
      d.payload.agents.some((a) => a.id === 'coding-specialist'),
    );
    const agent = routing.payload.agents.find((a) => a.id === 'coding-specialist');
    assert.equal(agent.source, 'alias');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "probeEnv"} -> replies envProbe with booleans only, dropping malformed names', async () => {
  const projectRoot = mkTempProject();
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const probePromise = collectSseEvent(reader, 'envProbe');

    // Flat, per MSG_SCHEMAS.PROBE_ENV.safeParse(message) — see saveRouting
    // note above.
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'probeEnv', names: ['PATH', 'not-a-valid-name'] }),
    });
    assert.equal(res.status, 202);

    const probe = await probePromise;
    assert.equal(typeof probe.payload.PATH, 'object');
    assert.equal(typeof probe.payload.PATH.env, 'boolean');
    assert.equal(typeof probe.payload.PATH.stored, 'boolean');
    assert.ok(!('not-a-valid-name' in probe.payload));
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "setLocalEnvValue"} with flat name/value (real wire shape) actually sets the value, not "invalid env var name"', async () => {
  // Regression test for the bug where server.mjs read payload.name/
  // payload.value (a THEME_MSG_WIRE-only wrapper) instead of the flat
  // message fields media/main.js actually posts, so every setLocalEnvValue
  // silently failed with 'invalid env var name: ""'.
  const projectRoot = mkTempProject();
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-appdata-'));
  // setLocalEnvValue's storage path (src/core/localEnvStore.ts's
  // resolveStoreDir) reads real process.env directly rather than the `env`
  // object threaded through startServer — mutate process.env for the
  // duration of this test (restored in `finally`) so the write lands in the
  // temp dir, never the real machine's app-data secrets store.
  const prevDataDir = process.env.TYCOON_STANDALONE_DATA_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = appDataDir;
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const probePromise = collectSseEvent(reader, 'envProbe');

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'setLocalEnvValue', name: 'OLLAMA_API_KEY', value: 'sk-test-value' }),
    });
    assert.equal(res.status, 202);

    const probe = await probePromise;
    assert.ok(probe.payload.OLLAMA_API_KEY, 'reply should carry an entry for the name actually set, not undefined');
    assert.equal(probe.payload.OLLAMA_API_KEY.stored, true, 'the value should have actually been stored, not dropped as an invalid empty name');
  } finally {
    controller.abort();
    await runtime.close();
    if (prevDataDir === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prevDataDir;
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
});

test('POST /message {type: "saveRouting"} with a custom-endpoint agent (flat wire shape) writes routing.json and resolves ollama-windows', async () => {
  // End-to-end reproduction of the reported scenario: Coding Specialist ->
  // Custom endpoint -> ollama-windows / qwen3.6:latest / local / env names /
  // one fallback entry, sent the way media/main.js actually posts it (flat
  // on the message).
  const projectRoot = mkTempProject();
  writeFixtureAgent(projectRoot, 'coding-specialist.md', ['name: coding-specialist', 'model: sonnet']);
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    const profile = {
      version: 1,
      agents: {
        'coding-specialist': {
          vendor: 'ollama-windows',
          transport: 'openai-compatible',
          model: 'qwen3.6:latest',
          costModelClass: 'local',
          endpointEnv: 'OLLAMA_BASE_URL',
          credentialEnv: 'OLLAMA_API_KEY',
          fallback: [{ vendor: 'opencode', model: 'opencode/big-pickle' }],
        },
      },
    };
    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken },
      body: JSON.stringify({ type: 'saveRouting', profile }),
    });
    assert.equal(res.status, 202);

    const saved = await collector.next('routingSaved');
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const written = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'routing.json'), 'utf8'));
    assert.deepEqual(written, profile);

    const routing = await collector.next('routing', (d) =>
      d.payload.agents.some((a) => a.id === 'coding-specialist' && a.source === 'routing'),
    );
    const agent = routing.payload.agents.find((a) => a.id === 'coding-specialist');
    assert.equal(agent.backend.vendor, 'ollama-windows');
    assert.equal(agent.backend.model, 'qwen3.6:latest');
  } finally {
    controller.abort();
    await runtime.close();
  }
});
