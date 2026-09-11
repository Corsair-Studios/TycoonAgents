// TycoonAgents standalone — round-trip tests for the harness-selection
// Settings messages (plan p13-t7): getSettings carries `harness`, and
// setHarness writes .claude/tycoon/execution.json and re-broadcasts
// `settings`. Driven through the REAL HTTP server (POST /message + SSE
// /events), same technique as routingMessages.test.mjs.

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

function mkTempProject(prefix = 'tycoon-standalone-harness-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('POST /message {type: "getSettings"} -> settings.harness reports claude-code/default with no signals set', async () => {
  const projectRoot = mkTempProject();
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const settingsPromise = collectSseEvent(reader, 'settings');

    const res = await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'getSettings' }) });
    assert.equal(res.status, 202);

    const settings = await settingsPromise;
    assert.ok(settings.payload.harness);
    assert.equal(settings.payload.harness.effective, 'claude-code');
    assert.equal(settings.payload.harness.source, 'default');
    assert.deepEqual(settings.payload.harness.options, [
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'opencode', label: 'OpenCode (Experimental)' },
      { id: 'codex', label: 'Codex (Experimental)' },
    ]);
    // Nothing has changed since startup -> running (startupProviderId)
    // matches effective, so no mismatch/restart hint.
    assert.equal(settings.payload.harness.running, 'claude-code');
    assert.equal(settings.payload.harness.mismatch, false);
    assert.equal(settings.payload.harness.requiresRestart, false);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "setHarness", provider: "opencode"} -> writes execution.json and re-broadcasts settings sourced "execution"', async () => {
  const projectRoot = mkTempProject();
  const runtime = await startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0' }, cwd: projectRoot });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'setHarness', provider: 'opencode' }),
    });
    assert.equal(res.status, 202);

    const settings = await collector.next('settings', (d) => d.payload.harness && d.payload.harness.effective === 'opencode');
    assert.equal(settings.payload.harness.source, 'execution');
    assert.equal(settings.payload.harness.fileValue, 'opencode');
    // The standalone never live-swaps: `running` stays whatever
    // startupProviderId resolved to at process start (claude-code, since no
    // signal was present then), so writing opencode now must report a
    // mismatch and the restart hint.
    assert.equal(settings.payload.harness.running, 'claude-code');
    assert.equal(settings.payload.harness.mismatch, true);
    assert.equal(settings.payload.harness.requiresRestart, true);

    const written = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'execution.json'), 'utf8'),
    );
    assert.equal(written.provider, 'opencode');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('a server started with TYCOON_PROVIDER set reports harness.source "env" regardless of setHarness', async () => {
  const projectRoot = mkTempProject();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_PROVIDER: 'claude-code' },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  const prevEnv = process.env.TYCOON_PROVIDER;
  process.env.TYCOON_PROVIDER = 'claude-code';
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    const res = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'setHarness', provider: 'opencode' }),
    });
    assert.equal(res.status, 202);

    const settings = await collector.next('settings');
    assert.equal(settings.payload.harness.source, 'env');
    assert.equal(settings.payload.harness.effective, 'claude-code');
    // Started with TYCOON_PROVIDER=claude-code -> startupProviderId is
    // claude-code too, matching the env-forced effective value: no mismatch.
    assert.equal(settings.payload.harness.running, 'claude-code');
    assert.equal(settings.payload.harness.mismatch, false);
    assert.equal(settings.payload.harness.requiresRestart, false);
  } finally {
    controller.abort();
    await runtime.close();
    if (prevEnv === undefined) delete process.env.TYCOON_PROVIDER;
    else process.env.TYCOON_PROVIDER = prevEnv;
  }
});

// ---------------------------------------------------------------------
// p23-t11: installCodexHooks/uninstallCodexHooks/installCodexDispatcher/
// uninstallCodexDispatcher, mirroring panel.ts's handlers. Real temp
// CODEX_HOME + project dir, started with TYCOON_PROVIDER=codex so
// harness.effective stays 'codex' throughout.
// ---------------------------------------------------------------------

test('installCodexHooks/uninstallCodexHooks: install sets the config.toml marker and flips codexHooksInstalled true; uninstall restores byte-identical and flips it back', async () => {
  const projectRoot = mkTempProject();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-codexhome-'));
  const prevCodexHome = process.env.CODEX_HOME;
  const prevProvider = process.env.TYCOON_PROVIDER;
  process.env.CODEX_HOME = codexHome;
  process.env.TYCOON_PROVIDER = 'codex';
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_PROVIDER: 'codex' },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    const getRes = await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'getSettings' }) });
    assert.equal(getRes.status, 202);
    let settings = await collector.next('settings');
    assert.equal(settings.payload.harness.effective, 'codex');
    assert.equal(settings.payload.harness.codexHooksInstalled, false);

    const installRes = await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'installCodexHooks' }) });
    assert.equal(installRes.status, 202);
    settings = await collector.next('settings', (d) => d.payload.harness && d.payload.harness.codexHooksInstalled === true);
    assert.equal(settings.payload.harness.codexHooksInstalled, true);

    const configTomlPath = path.join(codexHome, 'config.toml');
    const afterInstall = fs.readFileSync(configTomlPath, 'utf8');
    assert.match(afterInstall, /tycoon-codex-hook: managed notify entry/);
    const hooksJsonPath = path.join(projectRoot, '.codex', 'hooks.json');
    assert.equal(fs.existsSync(hooksJsonPath), true);

    const uninstallRes = await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'uninstallCodexHooks' }) });
    assert.equal(uninstallRes.status, 202);
    settings = await collector.next('settings', (d) => d.payload.harness && d.payload.harness.codexHooksInstalled === false);
    assert.equal(settings.payload.harness.codexHooksInstalled, false);

    const afterUninstall = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf8') : '';
    assert.doesNotMatch(afterUninstall, /tycoon-codex-hook: managed notify entry/);
    assert.equal(fs.existsSync(hooksJsonPath), false, 'our own hooks.json (no foreign content) is removed on uninstall');
  } finally {
    controller.abort();
    await runtime.close();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevProvider === undefined) delete process.env.TYCOON_PROVIDER;
    else process.env.TYCOON_PROVIDER = prevProvider;
  }
});

test('installCodexDispatcher/uninstallCodexDispatcher: install sets the dispatcher marker and flips codexDispatcherInstalled true; uninstall clears it', async () => {
  const projectRoot = mkTempProject();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-codexhome-'));
  const prevCodexHome = process.env.CODEX_HOME;
  const prevProvider = process.env.TYCOON_PROVIDER;
  process.env.CODEX_HOME = codexHome;
  process.env.TYCOON_PROVIDER = 'codex';
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_PROVIDER: 'codex' },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const collector = createSseCollector(eventsRes.body.getReader());

    await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'getSettings' }) });
    let settings = await collector.next('settings');
    assert.equal(settings.payload.harness.codexDispatcherInstalled, false);

    await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'installCodexDispatcher' }) });
    settings = await collector.next('settings', (d) => d.payload.harness && d.payload.harness.codexDispatcherInstalled === true);
    assert.equal(settings.payload.harness.codexDispatcherInstalled, true);

    await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'uninstallCodexDispatcher' }) });
    settings = await collector.next('settings', (d) => d.payload.harness && d.payload.harness.codexDispatcherInstalled === false);
    assert.equal(settings.payload.harness.codexDispatcherInstalled, false);
  } finally {
    controller.abort();
    await runtime.close();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevProvider === undefined) delete process.env.TYCOON_PROVIDER;
    else process.env.TYCOON_PROVIDER = prevProvider;
  }
});
