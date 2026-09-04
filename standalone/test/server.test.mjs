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
import { startServer, ServerStartError, getThemeImageConfig, seedBundledThemesIntoStore } from '../src/server.mjs';
import { ProjectRootError } from '../src/projectRoots.mjs';
import { createFsThemeFileStore } from '../src/themeFileStoreFs.mjs';
import { themesDirectoryPath } from '../src/themeFileStoreFs.mjs';
import { listThemesFromStore } from '../src/themeMessages.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// standalone/test -> standalone -> repo root (same derivation server.mjs uses).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads SSE chunks off `reader` until it sees a `message` event whose JSON
 * `data.type` equals `matchType`, then returns that parsed data. Bounded by
 * `maxChunks` so a missing broadcast fails the test instead of hanging
 * (same pattern as themeExportImportHttp.test.mjs's collectSseEvent). */
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
 * Stateful SSE event reader: unlike collectSseEvent/collectSseEventMatching
 * (each of which owns a fresh, function-local `buffer` and so silently
 * DISCARDS any bytes read past the event they matched), this keeps its
 * buffer across calls to `.next()`. Needed whenever a single handler call
 * broadcasts TWO events back-to-back with no intervening `fetch()` POST
 * (e.g. `settingsUpdated` immediately followed by a fresh `settings`
 * broadcast) — those two events can legitimately arrive in the SAME
 * underlying TCP chunk, and a plain collectSseEvent call for the first one
 * would throw away the second one's already-buffered bytes, leaving a
 * later collectSseEvent call for it hanging until its own maxChunks budget
 * times out. Existing tests that chain multiple collectSseEvent calls on
 * one reader avoid this by always issuing a NEW POST /message between
 * calls (a real network round trip reliably separates the flushes); use
 * this collector instead whenever that's not the case.
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

/**
 * Like collectSseEvent, but keeps reading past same-`matchType` events that
 * don't satisfy `predicate` instead of returning the first one. Needed for
 * boot-handshake-replayed types (PLAN_STATE, OFFLOAD_OFFER_STATE) that
 * `initialMessageProviders`/`sseClients` (server.mjs module-level state
 * shared by every startServer() instance in ONE test process) can also
 * emit for a DIFFERENT, concurrently-running test's server, onto a client
 * that only asked for THIS test's connection — see server.mjs's own
 * per-connection boot-handshake replay loop. Filtering on content, not just
 * type, makes these assertions correct regardless of that cross-talk.
 */
async function collectSseEventMatching(reader, matchType, predicate, maxChunks = 100) {
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
        if (data.type === matchType && predicate(data)) return data;
      }
    }
  }
  throw new Error(`collectSseEventMatching: no matching "${matchType}" event seen within ${maxChunks} SSE reads`);
}

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

// ── App data + theme image config (pA-t3) ──────────────────────────────────

test('startServer: resolves appData + themeDataDir honoring TYCOON_STANDALONE_DATA_DIR', async () => {
  const projectRoot = mkTempProject();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-appdata-'));
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  try {
    assert.equal(runtime.appData.dir, path.resolve(dataDir));
    assert.equal(runtime.themeDataDir, path.join(path.resolve(dataDir), 'themes'));
    // Config shape matches ThemeImageConfig; no keys set -> defaults to
    // provider only, no key properties present.
    const config = runtime.getThemeImageConfig();
    assert.deepEqual(config, { provider: 'openai', geminiModel: '', openaiModel: '', openaiQuality: '' });
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('startServer: getThemeImageConfig() picks up TYCOON_OPENAI_API_KEY / TYCOON_GEMINI_API_KEY / TYCOON_THEME_IMAGE_PROVIDER', async () => {
  const projectRoot = mkTempProject();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-appdata-'));
  const runtime = await startServer({
    argv: [projectRoot],
    env: {
      TYCOON_STANDALONE_PORT: '0',
      TYCOON_STANDALONE_DATA_DIR: dataDir,
      TYCOON_THEME_IMAGE_PROVIDER: 'gemini',
      TYCOON_OPENAI_API_KEY: 'sk-test-openai',
      TYCOON_GEMINI_API_KEY: 'test-gemini-key',
    },
    cwd: projectRoot,
  });
  try {
    const config = runtime.getThemeImageConfig();
    assert.deepEqual(config, {
      provider: 'gemini',
      openaiApiKey: 'sk-test-openai',
      geminiApiKey: 'test-gemini-key',
      geminiModel: '',
      openaiModel: '',
      openaiQuality: '',
    });
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('getThemeImageConfig: standalone unit calls (no server) default provider to openai, omit unset keys', () => {
  assert.deepEqual(getThemeImageConfig({ env: {} }), { provider: 'openai', geminiModel: '', openaiModel: '', openaiQuality: '' });
  assert.deepEqual(getThemeImageConfig({ env: { TYCOON_THEME_IMAGE_PROVIDER: 'gemini' } }), { provider: 'gemini', geminiModel: '', openaiModel: '', openaiQuality: '' });
  // Unrecognized provider values fall back to 'openai', same as the
  // extension's normalizeThemeImageProvider().
  assert.deepEqual(getThemeImageConfig({ env: { TYCOON_THEME_IMAGE_PROVIDER: 'bogus' } }), { provider: 'openai', geminiModel: '', openaiModel: '', openaiQuality: '' });
  assert.deepEqual(getThemeImageConfig({ env: { TYCOON_OPENAI_API_KEY: 'abc' } }), {
    provider: 'openai',
    openaiApiKey: 'abc',
    geminiModel: '',
    openaiModel: '',
    openaiQuality: '',
  });
});

test('getThemeImageConfig: env overrides an appData-persisted provider', () => {
  const fakeAppData = { readJson: () => ({ provider: 'gemini' }) };
  // No env provider set -> falls back to the persisted 'gemini'.
  assert.deepEqual(getThemeImageConfig({ env: {}, appData: fakeAppData }), { provider: 'gemini', geminiModel: '', openaiModel: '', openaiQuality: '' });
  // Explicit env provider always wins over the persisted value.
  assert.deepEqual(getThemeImageConfig({ env: { TYCOON_THEME_IMAGE_PROVIDER: 'openai' }, appData: fakeAppData }), {
    provider: 'openai',
    geminiModel: '',
    openaiModel: '',
    openaiQuality: '',
  });
});

test('getThemeImageConfig: TYCOON_OPENAI_IMAGE_QUALITY env var is picked up as the RAW candidate (unresolved)', () => {
  // getThemeImageConfig() stores the raw candidate; resolveImageQuality()
  // validation happens in callers (handleSaveThemeImageSettings / buildImageOptions).
  assert.deepEqual(getThemeImageConfig({ env: { TYCOON_OPENAI_IMAGE_QUALITY: 'high' } }), {
    provider: 'openai',
    geminiModel: '',
    openaiModel: '',
    openaiQuality: 'high',
  });
});

test('getThemeImageConfig: persisted openaiQuality wins over TYCOON_OPENAI_IMAGE_QUALITY env fallback', () => {
  const fakeAppData = { readJson: () => ({ openaiQuality: 'low' }) };
  assert.deepEqual(
    getThemeImageConfig({ env: { TYCOON_OPENAI_IMAGE_QUALITY: 'high' }, appData: fakeAppData }),
    { provider: 'openai', geminiModel: '', openaiModel: '', openaiQuality: 'low' },
  );
});

// ── Browser boot handshake (checkInstall / ready) ───────────────────────────
// media/main.js's boot sequence (~main.js:10935-10971) fires "ready" then
// "checkInstall" (plus getPacks/getEngineStatus/REQUEST_PLAN/
// REQUEST_OFFLOAD_OFFER_STATE) before its first paint. These used to fall
// through handleBrowserMessage()'s default case and log
// "/message (unhandled)", leaving the panel stuck on "Checking
// installation..." and the theme stage waiting out its 15s pending-fallback
// timer (theme state stays "pending" -> falls back to "none").

test('POST /message {type: "checkInstall"} -> broadcasts an "installState" reply', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body.getReader();
    const installStatePromise = collectSseEvent(reader, 'installState');

    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'checkInstall' }),
    });
    assert.equal(messageRes.status, 202);

    const installState = await installStatePromise;
    assert.equal(installState.installed, true);
    assert.equal(installState.uefnBridgeSetUp, false);
    assert.deepEqual(installState.pathHealth, []);
    assert.equal(installState.pathOverridesFilePath, null);
    assert.equal(installState.pathOverridesFileExists, false);
    assert.equal(installState.uefnInstalled, false);
    assert.equal(installState.verseExtensionState.state, 'not-installed');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "getSkills"} -> broadcasts a "skills" reply built from media/skills/catalog.json', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const skillsPromise = collectSseEvent(reader, 'skills');

    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'getSkills' }),
    });
    assert.equal(messageRes.status, 202);

    const skills = await skillsPromise;
    assert.ok(Array.isArray(skills.skills));
    assert.ok(skills.skills.length > 0, 'expected the real bundled skills catalog, not an empty stub');
    assert.ok(skills.skills.every((s) => typeof s.id === 'string' && typeof s.installed === 'boolean'));
    assert.ok(
      skills.skills.every((s) => typeof s.summary === 'string' && s.summary.length > 0 && s.summary.length <= 120),
      'every skill payload item must carry a non-empty summary <= 120 chars',
    );
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "getMcp"} -> broadcasts a "mcp" reply built from media/mcp/catalog.json', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const mcpPromise = collectSseEvent(reader, 'mcp');

    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'getMcp' }),
    });
    assert.equal(messageRes.status, 202);

    const mcp = await mcpPromise;
    assert.ok(Array.isArray(mcp.servers));
    assert.ok(mcp.servers.length > 0, 'expected the real bundled MCP catalog, not an empty stub');
    assert.ok(mcp.servers.every((s) => typeof s.id === 'string' && typeof s.installed === 'boolean'));
    assert.ok(
      mcp.servers.every((s) => typeof s.summary === 'string' && s.summary.length > 0 && s.summary.length <= 120),
      'every mcp payload item must carry a non-empty summary <= 120 chars',
    );
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "getPacks"} -> lists every catalog pack with installed flags computed against a temp project', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'media', 'packs', 'catalog.json'), 'utf8'));

    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const packsPromise = collectSseEvent(reader, 'packs');
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'getPacks' }),
    });
    assert.equal(messageRes.status, 202);

    const packs = await packsPromise;
    assert.ok(Array.isArray(packs.packs));
    assert.equal(packs.packs.length, catalog.length, 'every catalog pack must be listed');
    assert.ok(
      packs.packs.every((p) => typeof p.summary === 'string' && p.summary.length > 0 && p.summary.length <= 120),
      'every pack payload item must carry a non-empty summary <= 120 chars',
    );
    const multiLlm = packs.packs.find((p) => p.id === 'multi-llm');
    assert.ok(multiLlm, 'multi-llm pack must be present');
    assert.equal(multiLlm.installed.agent, false, 'no agent files exist yet in the fresh temp project');
    assert.deepEqual(multiLlm.agents.map((a) => a.id).sort(), ['claude-worker', 'codex-reviewer', 'gemini-reviewer', 'kimi-reviewer']);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "installPack", id: "multi-llm"} -> writes byte-identical agent markdown and getPacks then reports installed', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'media', 'packs', 'catalog.json'), 'utf8'));
    const pack = catalog.find((p) => p.id === 'multi-llm');
    const { buildAgentMarkdown } = require('../../out/src/host/vscode/packCatalog.js');

    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const installedPromise = collectSseEvent(reader, 'packInstalled');
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'installPack', id: 'multi-llm', thirdParty: false, disclosures: [] }),
    });
    assert.equal(messageRes.status, 202);

    const installed = await installedPromise;
    assert.equal(installed.ok, true, `install must succeed: ${installed.error}`);

    for (const agent of pack.agents) {
      const written = fs.readFileSync(path.join(projectRoot, '.claude', 'agents', `${agent.id}.md`), 'utf8');
      const expected = buildAgentMarkdown(agent, 'multi-llm');
      assert.equal(written, expected, `${agent.id}.md must be byte-identical to buildAgentMarkdown's output`);
    }

    const packsPromise = collectSseEvent(reader, 'packs');
    const getPacksRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'getPacks' }),
    });
    assert.equal(getPacksRes.status, 202);
    const packs = await packsPromise;
    const multiLlm = packs.packs.find((p) => p.id === 'multi-llm');
    assert.equal(multiLlm.installed.agent, true, 'getPacks must report the pack as installed after installPack');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('server.mjs and packCatalog.js load without ever requiring the "vscode" module', () => {
  const Module = require('module');
  const orig = Module._load;
  let sawVscode = false;
  Module._load = function patchedLoad(request, ...args) {
    if (request === 'vscode') sawVscode = true;
    return orig.call(this, request, ...args);
  };
  try {
    delete require.cache[require.resolve('../../out/src/host/vscode/packCatalog.js')];
    require('../../out/src/host/vscode/packCatalog.js');
  } finally {
    Module._load = orig;
  }
  assert.equal(sawVscode, false, 'packCatalog.js must load standalone, without importing "vscode"');
});

test('POST /message {type: "ready"} -> broadcasts THEME_INITIALIZED for the auto-seeded bundled theme on a fresh store', async () => {
  // startServer() now seeds the bundled default theme into an empty store
  // (seedBundledThemesIntoStore(), awaited before the server starts
  // accepting connections) so a fresh standalone install never falls back
  // to THEME_NONE / the blue-green fallback stripes. A brand-new, isolated
  // TYCOON_STANDALONE_DATA_DIR is exactly that "empty store" case.
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body.getReader();
    // Higher maxChunks than the 50 default: THEME_INITIALIZED's payload
    // carries the full seeded theme manifest+frames JSON, which is large
    // enough that the underlying TCP stream can split it across many more
    // `reader.read()` chunks than the boot-handshake's small JSON replies
    // ahead of it in the same SSE stream.
    const themeInitializedPromise = collectSseEvent(reader, 'THEME_INITIALIZED', 500);

    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'ready' }),
    });
    assert.equal(messageRes.status, 202);

    const themeInitialized = await themeInitializedPromise;
    assert.equal(themeInitialized.payload.manifest.theme_id, 'survivors_vs_zombies');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "getSettings"} -> broadcasts a "settings" reply that unblocks "Loading settings…"', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body.getReader();
    const settingsPromise = collectSseEvent(reader, 'settings');

    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'getSettings' }),
    });
    assert.equal(messageRes.status, 202);

    const settings = await settingsPromise;
    assert.ok(settings.payload, 'settings reply must carry a non-null payload (renderSettings() only shows ' +
      '"Loading settings…" while lastSettings is null/undefined)');
    assert.equal(settings.payload.hook.installed, true);
    assert.ok(Array.isArray(settings.payload.agents));
    assert.equal(settings.payload.delegation_mode, 'flat');
    assert.equal(settings.payload.reviewEnabled, true);
    assert.deepEqual(settings.payload.foreignManagedBlocks, []);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

// ── Full simulated browser boot sequence ────────────────────────────────────
// media/main.js's actual boot order (main.js:10948-10971): "ready" then
// checkInstall/getPacks/getEngineStatus/REQUEST_PLAN/
// REQUEST_OFFLOAD_OFFER_STATE, fired back-to-back BEFORE the browser's own
// EventSource connection is guaranteed to have registered server-side (see
// buildBootHandshakeMessages()'s doc comment in server.mjs for the exact
// race). This test connects to /events, posts every boot message in main.js's
// order, and asserts every one of them gets its reply.
test('simulated browser boot sequence: every boot-handshake message gets a reply', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body.getReader();

    const expected = [
      ['ready', 'THEME_INITIALIZED'],
      ['checkInstall', 'installState'],
      ['getPacks', 'packs'],
      ['getEngineStatus', 'engineStatus'],
      ['REQUEST_PLAN', 'PLAN_STATE'],
      ['REQUEST_OFFLOAD_OFFER_STATE', 'OFFLOAD_OFFER_STATE'],
    ];
    const wantedTypes = new Set(expected.map(([, replyType]) => replyType));

    for (const [type] of expected) {
      const res = await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type }) });
      assert.equal(res.status, 202, `POST /message {type: "${type}"} should 202`);
    }

    // A single sequential read loop (concurrent collectSseEvent calls would
    // race reads on the same stream reader) collecting every wanted reply
    // type, in whatever order they actually arrive.
    const seen = new Map();
    let buffer = '';
    for (let i = 0; i < 500 && seen.size < wantedTypes.size; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString('utf8');
      let sepIndex;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.slice('data: '.length));
        if (wantedTypes.has(data.type) && !seen.has(data.type)) seen.set(data.type, data);
      }
    }

    for (const [type, replyType] of expected) {
      assert.ok(seen.has(replyType), `expected a "${replyType}" reply for "${type}" boot message`);
    }
  } finally {
    controller.abort();
    await runtime.close();
  }
});

// ── Theme boot on plain /events connect (no "ready" POST) ──────────────────
// Regression coverage: buildBootHandshakeMessages()'s installState/packs/
// engineStatus/PLAN_STATE/OFFLOAD_OFFER_STATE all replay on every new
// /events connection via registerInitialMessageProvider (synchronous), but
// the theme boot (handleReadyThemeBoot, THEME_INITIALIZED/THEME_NONE) used
// to fire ONLY from the 'ready' POST case — dropped if that POST raced
// ahead of the SSE handshake registering. These assert the /events handler
// itself now delivers the theme boot to each newly-connected client,
// independent of any 'ready' POST ever arriving.
test('/events connect (no "ready" POST): THEME_INITIALIZED arrives when the store already has a theme', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    // startServer() awaits seedBundledThemesIntoStore() before accepting
    // connections, so the store already has the bundled default theme —
    // no 'ready' POST is sent here.
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body.getReader();
    // THEME_INITIALIZED carries the full manifest+frames payload (frames.json
    // includes base64 sprite data), which streams across far more than the
    // default 50 SSE reads — bump the budget so this doesn't flake on a slow
    // socket.
    const initialized = await collectSseEvent(reader, 'THEME_INITIALIZED', 500);
    assert.ok(initialized.payload && initialized.payload.manifest, 'THEME_INITIALIZED must carry a manifest');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

// Regression coverage for the Themes pop-up (media/main.js's menuThemesBtn/
// tabThemePicker handlers post {type:'LIST_THEMES'} and render msg.payload.
// themes, reading theme_id/display_name/export_ready/total/accepted — see
// renderThemesList() ~main.js:5239). This asserts the SAME store the board
// boots THEME_INITIALIZED from (handleReadyThemeBoot, both driven by
// listThemesFromStore()) also answers an explicit LIST_THEMES round trip
// with that theme, in the shape the dialog needs, once the store already
// has a modern per-directory theme on disk (manifest.json + frames.json)
// — the survivors_vs_zombies bundled-seed layout described in the bug
// report.
test('POST /message LIST_THEMES: THEMES_LIST lists a store theme with the fields the Themes dialog renders', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    // startServer() awaits seedBundledThemesIntoStore() before accepting
    // connections, so a fresh store already has survivors_vs_zombies seeded
    // in the modern per-directory layout (manifest.json/frames.json) —
    // exactly the on-disk shape the bug report describes.
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body.getReader();
    // Drain the boot-time THEME_INITIALIZED first so it isn't mistaken for
    // the THEMES_LIST reply below.
    await collectSseEvent(reader, 'THEME_INITIALIZED', 500);

    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'LIST_THEMES' }),
    });
    assert.equal(messageRes.status, 202);

    const list = await collectSseEvent(reader, 'THEMES_LIST', 50);
    assert.ok(Array.isArray(list.payload && list.payload.themes), 'THEMES_LIST payload.themes must be an array');
    const entry = list.payload.themes.find((t) => t.theme_id === 'survivors_vs_zombies');
    assert.ok(entry, 'survivors_vs_zombies must be listed');
    assert.equal(entry.display_name, 'Survivors vs Zombies');
    assert.equal(typeof entry.export_ready, 'boolean');
    assert.equal(typeof entry.total, 'number');
    assert.equal(typeof entry.accepted, 'number');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('/events connect (no "ready" POST): THEME_NONE arrives when the store is empty', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    // Force a genuinely empty store: startServer() always seeds the
    // bundled default theme into a fresh store before accepting
    // connections (seedBundledThemesIntoStore() only skips when a theme
    // already exists), so remove what it just seeded from disk before
    // connecting — handleReadyThemeBoot() re-lists the store fresh on
    // every /events connection, so this reproduces an empty-store client.
    fs.rmSync(path.join(dataDir, themesDirectoryPath()), { recursive: true, force: true });

    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body.getReader();
    const none = await collectSseEvent(reader, 'THEME_NONE');
    assert.deepEqual(none.payload, {});
  } finally {
    controller.abort();
    await runtime.close();
  }
});

// ── seedBundledThemesIntoStore() — user-theme-wins seeding ──────────────────
test('seedBundledThemesIntoStore: an empty theme store gets the bundled default theme seeded', async () => {
  const storeRoot = path.join(mkTempProject(), 'themestore');
  const store = createFsThemeFileStore(storeRoot);

  const before = await listThemesFromStore(store);
  assert.deepEqual(before, []);

  await seedBundledThemesIntoStore(store);

  const after = await listThemesFromStore(store);
  assert.equal(after.length, 1);
  assert.equal(after[0].theme_id, 'survivors_vs_zombies');
});

test('seedBundledThemesIntoStore: a store with an existing (user) theme is left untouched', async () => {
  const storeRoot = path.join(mkTempProject(), 'themestore');
  const store = createFsThemeFileStore(storeRoot);

  // A pre-existing theme, distinct from the bundled one, simulating a user's
  // own theme already present — the seed must never add to or overwrite it.
  await store.writeFile('themes/my_custom_theme/manifest.json', JSON.stringify({
    theme_id: 'my_custom_theme',
    display_name: 'My Custom Theme',
  }));
  await store.writeFile('themes/my_custom_theme/frames.json', JSON.stringify({}));

  await seedBundledThemesIntoStore(store);

  const after = await listThemesFromStore(store);
  assert.equal(after.length, 1, 'seeding must not add the bundled theme alongside an existing user theme');
  assert.equal(after[0].theme_id, 'my_custom_theme');
});

// ── Submit feedback (p9-t1) ──────────────────────────────────────────────
test('POST /message {type: "submitFeedback"} -> feedbackPreview carries the v1 payload plus provider + host: "standalone"', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const previewPromise = collectSseEvent(reader, 'feedbackPreview');

    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'submitFeedback',
        category: 'bug',
        userDescription: 'the theme picker is broken',
        includeDiagnostics: false,
        contact: '',
      }),
    });
    assert.equal(messageRes.status, 202);

    const preview = await previewPromise;
    assert.ok(preview.ticketId, 'preview must carry a ticketId');
    assert.equal(typeof preview.payloadJson, 'string');
    const payload = JSON.parse(preview.payloadJson);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.ticketId, preview.ticketId);
    assert.equal(payload.category, 'bug');
    assert.equal(payload.userDescription, 'the theme picker is broken');
    assert.equal(payload.hostAppName, 'standalone');
    assert.equal(payload.provider, 'claude-code');
    assert.equal(payload.host, 'standalone');
    assert.ok(!('diagnosticMarkdown' in payload), 'no diagnostic report generator wired up yet');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "confirmFeedbackSend"} -> posts the retained body (with provider + host) and replies feedbackResult ok:true', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  let capturedUrl = null;
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const previewPromise = collectSseEvent(reader, 'feedbackPreview');
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'submitFeedback',
        category: 'idea',
        userDescription: 'add a dark mode',
        includeDiagnostics: false,
      }),
    });
    const preview = await previewPromise;

    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://feedback.corsairstudios.com')) {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return originalFetch(url, init);
    };

    const resultPromise = collectSseEvent(reader, 'feedbackResult');
    const confirmRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'confirmFeedbackSend', ticketId: preview.ticketId }),
    });
    assert.equal(confirmRes.status, 202);

    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(result.ticketId, preview.ticketId);
    assert.equal(capturedUrl, 'https://feedback.corsairstudios.com/submit');
    assert.equal(capturedBody.provider, 'claude-code');
    assert.equal(capturedBody.host, 'standalone');
    assert.equal(capturedBody.ticketId, preview.ticketId);
  } finally {
    globalThis.fetch = originalFetch;
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "confirmFeedbackSend"} -> network failure replies feedbackResult ok:false and retains the ticket for retry', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const previewPromise = collectSseEvent(reader, 'feedbackPreview');
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'submitFeedback', category: 'other', userDescription: 'x', includeDiagnostics: false }),
    });
    const preview = await previewPromise;

    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://feedback.corsairstudios.com')) {
        throw new Error('network unreachable');
      }
      return originalFetch(url, init);
    };

    const resultPromise = collectSseEvent(reader, 'feedbackResult');
    const confirmRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'confirmFeedbackSend', ticketId: preview.ticketId }),
    });
    assert.equal(confirmRes.status, 202);

    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.equal(result.ticketId, preview.ticketId);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);

    // Retry: the ticket must still be retained after a failed send.
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://feedback.corsairstudios.com')) {
        return { ok: true, status: 200 };
      }
      return originalFetch(url, init);
    };
    const retryResultPromise = collectSseEvent(reader, 'feedbackResult');
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'confirmFeedbackSend', ticketId: preview.ticketId }),
    });
    const retryResult = await retryResultPromise;
    assert.equal(retryResult.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    controller.abort();
    await runtime.close();
  }
});

// ── p9-t6: Settings write handlers, PLAN_STATE, OFFLOAD_OFFER_STATE, skill repair ──

test('POST /message {type: "setDelegationMode", delegation_mode: "team_leads"} -> persists execution.json, installs LEAD_AGENTS, replies settingsUpdated + fresh settings', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    // A single setDelegationMode handler call broadcasts settingsUpdated
    // then a fresh settings — both can land in the SAME SSE chunk, so a
    // persistent-buffer collector is required (see createSseCollector's doc
    // comment) rather than two independent collectSseEvent calls.
    const sse = createSseCollector(reader);
    const updatedPromise = sse.next('settingsUpdated');
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'setDelegationMode', delegation_mode: 'team_leads' }),
    });
    assert.equal(messageRes.status, 202);
    const updated = await updatedPromise;
    assert.equal(updated.ok, true);
    assert.equal(updated.field, 'delegationMode');
    assert.equal(updated.delegation_mode, 'team_leads');

    const execCfg = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'execution.json'), 'utf8'));
    assert.equal(execCfg.delegation_mode, 'team_leads');

    const { LEAD_AGENTS } = require('../../out/src/host/vscode/packCatalog.js');
    for (const a of LEAD_AGENTS) {
      assert.ok(fs.existsSync(path.join(projectRoot, '.claude', 'agents', `${a.id}.md`)), `${a.id}.md must be installed`);
    }

    const settings = await sse.next('settings');
    assert.equal(settings.payload.delegation_mode, 'team_leads');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "setReviewEnabled", enabled: false} -> persists execution.json and removes REVIEWER_AGENTS', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();

    const enabledPromise = collectSseEvent(reader, 'settingsUpdated');
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'setReviewEnabled', enabled: true }),
    });
    await enabledPromise;
    const { REVIEWER_AGENTS } = require('../../out/src/host/vscode/packCatalog.js');
    for (const a of REVIEWER_AGENTS) {
      assert.ok(fs.existsSync(path.join(projectRoot, '.claude', 'agents', `${a.id}.md`)));
    }

    const disabledPromise = collectSseEvent(reader, 'settingsUpdated');
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'setReviewEnabled', enabled: false }),
    });
    assert.equal(messageRes.status, 202);
    const disabled = await disabledPromise;
    assert.equal(disabled.ok, true);
    assert.equal(disabled.reviewEnabled, false);

    const execCfg = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'execution.json'), 'utf8'));
    assert.equal(execCfg.reviewEnabled, false);
    for (const a of REVIEWER_AGENTS) {
      assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'agents', `${a.id}.md`)), false, `${a.id}.md must be removed`);
    }
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "setSessionJournalEntries", entries: 99} -> clamps to 5, persists, and updates CLAUDE.md delegation section', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const updatedPromise = collectSseEvent(reader, 'settingsUpdated');
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'setSessionJournalEntries', entries: 99 }),
    });
    assert.equal(messageRes.status, 202);
    const updated = await updatedPromise;
    assert.equal(updated.ok, true);
    assert.equal(updated.sessionJournalEntries, 5, 'must clamp to the max of 5');

    const execCfg = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'execution.json'), 'utf8'));
    assert.equal(execCfg.sessionJournalEntries, 5);

    const claudeMd = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /tycoon:delegation/);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "SET_PROJECT_PLAN_ENABLED", enabled: true} -> persists projectPlanEnabled, installs the skill, and replies PLAN_STATE', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    // Match on enabled:true AND plan:null specifically (not just type)
    // because server.mjs's `initialMessageProviders`/`sseClients` are
    // module-level state shared by every startServer() instance in this
    // ONE test process — a concurrently-running test's own PLAN_STATE
    // broadcast can otherwise be mistaken for this toggle's own reply. See
    // collectSseEventMatching's doc comment.
    const planStatePromise = collectSseEventMatching(reader, 'PLAN_STATE', (d) => d.enabled === true && d.plan === null);
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'SET_PROJECT_PLAN_ENABLED', enabled: true }),
    });
    assert.equal(messageRes.status, 202);
    const planState = await planStatePromise;
    assert.equal(planState.enabled, true);
    assert.equal(planState.plan, null, 'no plan.json written yet');

    const execCfg = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'tycoon', 'execution.json'), 'utf8'));
    assert.equal(execCfg.projectPlanEnabled, true);

    const skillDest = path.join(projectRoot, '.claude', 'skills', 'project-plan');
    assert.ok(fs.existsSync(skillDest) && fs.readdirSync(skillDest).length > 0, 'project-plan skill must be staged');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('REQUEST_PLAN reflects a real .claude/tycoon/plan.json fixture (phases/tasks/gate) once enabled', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  fs.mkdirSync(path.join(projectRoot, '.claude', 'tycoon'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.claude', 'tycoon', 'execution.json'),
    JSON.stringify({ projectPlanEnabled: true }),
  );
  const fixturePlan = {
    version: 1,
    title: 'Test plan',
    phases: [
      {
        id: 'p1',
        num: 1,
        name: 'Phase one',
        goal: 'Test goal',
        gate: 'pending',
        taskIds: ['p1-t1'],
      },
    ],
    tasks: [
      {
        id: 'p1-t1',
        phaseId: 'p1',
        title: 'Task one',
        detail: 'Do the thing',
        acceptanceCriteria: ['it works'],
        status: 'pending',
        verifyAttempts: 0,
      },
    ],
    currentPhaseId: 'p1',
    currentTaskId: 'p1-t1',
  };
  fs.writeFileSync(path.join(projectRoot, '.claude', 'tycoon', 'plan.json'), JSON.stringify(fixturePlan, null, 2));

  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    // Match on the fixture's own title (not just type/enabled) — see
    // collectSseEventMatching's doc comment on cross-talk from concurrently
    // running tests sharing server.mjs's module-level SSE state.
    const planStatePromise = collectSseEventMatching(reader, 'PLAN_STATE', (d) => d.plan && d.plan.title === 'Test plan');
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'REQUEST_PLAN' }),
    });
    assert.equal(messageRes.status, 202);
    const planState = await planStatePromise;
    assert.equal(planState.enabled, true);
    assert.equal(planState.planReadable, true);
    assert.ok(planState.plan, 'plan must be present');
    assert.equal(planState.plan.title, 'Test plan');
    assert.equal(planState.plan.phases[0].id, 'p1');
    assert.equal(planState.plan.tasks[0].id, 'p1-t1');
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('POST /message {type: "projectPlanAction"} -> re-stages media/skills/project-plan and replies projectPlanDone {ok:true}', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const donePromise = collectSseEvent(reader, 'projectPlanDone');
    const messageRes = await fetch(`${runtime.url}/message`, {
      method: 'POST',
      body: JSON.stringify({ type: 'projectPlanAction' }),
    });
    assert.equal(messageRes.status, 202);
    const done = await donePromise;
    assert.equal(done.ok, true, `repair must succeed: ${done.error}`);

    const srcDir = path.join(REPO_ROOT, 'media', 'skills', 'project-plan');
    const destDir = path.join(projectRoot, '.claude', 'skills', 'project-plan');
    const srcFiles = fs.readdirSync(srcDir).filter((f) => fs.statSync(path.join(srcDir, f)).isFile());
    for (const f of srcFiles) {
      assert.equal(
        fs.readFileSync(path.join(destDir, f), 'utf8'),
        fs.readFileSync(path.join(srcDir, f), 'utf8'),
        `${f} must be byte-identical after repair`,
      );
    }
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('REQUEST_OFFLOAD_OFFER_STATE reflects execution.json flags and .mcp.json codex entry (fails closed when absent)', async () => {
  const projectRoot = mkTempProject();
  const dataDir = path.join(mkTempProject(), 'appdata');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: dataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();

    // Drain the boot-handshake's own unconditional OFFLOAD_OFFER_STATE
    // replay (sent to every new /events connection) before the explicit
    // REQUEST below — otherwise its reply queues up as a second unread
    // event and the LATER collectSseEvent call (after the .mcp.json/
    // execution.json writes) would consume this stale leftover instead of
    // the fresh one its own REQUEST produced.
    const bootOffer = await collectSseEvent(reader, 'OFFLOAD_OFFER_STATE');
    assert.equal(bootOffer.dismissed, false);
    assert.equal(bootOffer.accepted, false);
    assert.equal(bootOffer.providerAvailable, false);

    const offerPromise1 = collectSseEvent(reader, 'OFFLOAD_OFFER_STATE');
    await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'REQUEST_OFFLOAD_OFFER_STATE' }) });
    const offer1 = await offerPromise1;
    assert.equal(offer1.dismissed, false);
    assert.equal(offer1.accepted, false);
    assert.equal(offer1.providerAvailable, false);

    fs.writeFileSync(
      path.join(projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { codex: { command: 'codex', args: ['mcp-server'] } } }),
    );
    fs.mkdirSync(path.join(projectRoot, '.claude', 'tycoon'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.claude', 'tycoon', 'execution.json'),
      JSON.stringify({ offloadOfferDismissed: true, offloadOfferAccepted: true }),
    );

    // Match on all three flags together (not just type) — see
    // collectSseEventMatching's doc comment on cross-talk from concurrently
    // running tests sharing server.mjs's module-level SSE state.
    const offerPromise2 = collectSseEventMatching(
      reader,
      'OFFLOAD_OFFER_STATE',
      (d) => d.dismissed === true && d.accepted === true && d.providerAvailable === true,
    );
    await fetch(`${runtime.url}/message`, { method: 'POST', body: JSON.stringify({ type: 'REQUEST_OFFLOAD_OFFER_STATE' }) });
    const offer2 = await offerPromise2;
    assert.equal(offer2.dismissed, true);
    assert.equal(offer2.accepted, true);
    assert.equal(offer2.providerAvailable, true);
  } finally {
    controller.abort();
    await runtime.close();
  }
});
