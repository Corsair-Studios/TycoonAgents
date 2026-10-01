// TycoonAgents standalone — coverage for hooks/openai-compatible-mcp.cjs,
// the zero-dependency MCP stdio server bridging Claude to any
// OpenAI-compatible chat-completions endpoint (see that file's header
// comment for the wire contract).
//
// Strategy: spawn the REAL .cjs as a child process (it has no exports — a
// standalone stdio server, invoked fresh per session, same as
// hooks/tycoon-claude-hook.cjs's own test technique) and drive it over
// stdin/stdout with real newline-delimited JSON-RPC messages: initialize ->
// tools/list -> tools/call. OPENAI_COMPAT_BASE_URL points at a real
// node:http mock server on an ephemeral port, so the chat tool's HTTP client
// path is exercised end-to-end, not mocked at the network layer.
//
// Node built-ins only (node:test, node:assert, node:child_process,
// node:http, node:path, node:url).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', '..', 'hooks', 'openai-compatible-mcp.cjs');

// An empty, per-test TYCOON_STANDALONE_DATA_DIR guarantees the hook's
// localEnvStore fallback (hooks/localEnvStore.js) finds nothing on disk,
// regardless of what the real machine has stored or has set as a real user
// env var (e.g. a developer's own XAI_API_KEY). Tests whose premise is "this
// var is absent" MUST use this — deleting the var from the child env alone
// is not enough once a local-store or real-user-env fallback exists.
function emptyStoreDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-openai-compat-test-store-'));
}

/** Starts a node:http mock OpenAI-compatible /v1/chat/completions endpoint on an ephemeral port. */
function startMockEndpoint(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Spawns the real MCP server child process with the given env, merged over
 * process.env. `env` may be a plain object of overrides (merged on top of
 * process.env) or a full pre-built env object (e.g. `{ ...process.env, ... }`
 * with keys already deleted) — passed through as-is so a caller's deletions
 * are never undone by re-spreading process.env after the fact.
 */
function spawnMcpServer(env, { merge = true } = {}) {
  const child = spawn(process.execPath, [HOOK_PATH], {
    env: merge ? { ...process.env, ...env } : env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  return { child, getStderr: () => Buffer.concat(stderrChunks).toString('utf8') };
}

/** Reads newline-delimited JSON-RPC/NDJSON lines from a child's stdout as they arrive, resolving each request's own line-reader on demand. */
function makeLineReader(child) {
  let buffer = '';
  const pending = [];
  const resolvers = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      if (resolvers.length > 0) {
        resolvers.shift()(line);
      } else {
        pending.push(line);
      }
    }
  });
  return function nextLine(timeoutMs = 5000) {
    if (pending.length > 0) return Promise.resolve(pending.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a line from the MCP server')), timeoutMs);
      resolvers.push((line) => { clearTimeout(timer); resolve(line); });
    });
  };
}

function send(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function initializeAndListTools(child, nextLine) {
  send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const initLine = JSON.parse(await nextLine());
  assert.equal(initLine.id, 1);
  assert.equal(initLine.result.protocolVersion, '2025-06-18');
  assert.equal(initLine.result.serverInfo.name, 'openai-compatible-mcp');

  send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

  send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listLine = JSON.parse(await nextLine());
  assert.equal(listLine.id, 2);
  assert.equal(listLine.result.tools.length, 1);
  assert.equal(listLine.result.tools[0].name, 'chat');
}

test('initialize -> tools/list -> tools/call chat returns text and usage from a real HTTP mock endpoint', async () => {
  let capturedRequest = null;
  const { server, baseUrl } = await startMockEndpoint((req, res, body) => {
    capturedRequest = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'hi back' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }));
  });

  const { child, getStderr } = spawnMcpServer({ OPENAI_COMPAT_BASE_URL: baseUrl });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);

    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'chat', arguments: { model: 'moonshot/kimi-k2', prompt: 'hello there' } },
    });

    const line1 = JSON.parse(await nextLine());
    const line2 = JSON.parse(await nextLine());
    // The JSON-RPC response and the belt-and-suspenders trailing NDJSON
    // usage line are both written to stdout; the JSON-RPC one carries an
    // "id" field, the NDJSON one does not — identify by that rather than
    // assuming a fixed order.
    const callLine = line1.id === 3 ? line1 : line2;
    const usageLine = line1.id === 3 ? line2 : line1;

    assert.equal(callLine.id, 3);
    assert.equal(callLine.result.isError, false, `expected no error, got: ${JSON.stringify(callLine.result)}`);
    assert.equal(callLine.result.content[0].type, 'text');
    assert.equal(callLine.result.structuredContent.summary, 'hi back');
    assert.deepEqual(callLine.result.structuredContent.usage, { input_tokens: 12, output_tokens: 5 });
    assert.deepEqual(usageLine, { usage: { input_tokens: 12, output_tokens: 5 } });

    assert.ok(capturedRequest, 'mock endpoint should have received the chat completion request');
    assert.equal(capturedRequest.model, 'moonshot/kimi-k2');
    assert.deepEqual(capturedRequest.messages, [{ role: 'user', content: 'hello there' }]);

    assert.equal(getStderr(), '', 'server must not write anything to stderr on a clean run');
  } finally {
    child.kill();
    await closeServer(server);
  }
});

test('missing OPENAI_COMPAT_BASE_URL returns isError with the env var name, no HTTP call made', async () => {
  const storeDir = emptyStoreDir();
  const env = { ...process.env, TYCOON_STANDALONE_DATA_DIR: storeDir };
  delete env.OPENAI_COMPAT_BASE_URL;
  delete env.OPENAI_COMPAT_API_KEY;
  const child = spawn(process.execPath, [HOOK_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);

    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'chat', arguments: { model: 'llama3', prompt: 'hello' } },
    });

    const callLine = JSON.parse(await nextLine());
    assert.equal(callLine.id, 3);
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /OPENAI_COMPAT_BASE_URL/);
  } finally {
    child.kill();
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// xAI Grok, via this same bridge (grok-reviewer agent), on a DEDICATED
// endpoint/key pair separate from the generic OPENAI_COMPAT_*. No real
// network call to api.x.ai is ever made here: XAI_BASE_URL (the explicit
// override for the xai/ vendor default) is set to the local mock endpoint,
// so this exercises the request shape (upstream model id with the "xai/"
// prefix stripped, Authorization header from XAI_API_KEY only) without
// touching a real host. The https://api.x.ai/v1 default itself is checked
// separately below by reading the source, not by executing it.
// ---------------------------------------------------------------------------

test('xai/ model: prefix is stripped for the upstream request, Authorization header built from XAI_API_KEY, key never logged', async () => {
  let capturedRequest = null;
  let capturedAuthHeader = null;
  const { server, baseUrl } = await startMockEndpoint((req, res, body) => {
    capturedAuthHeader = req.headers['authorization'] || null;
    capturedRequest = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'grok says hi' } }] }));
  });

  const env = { ...process.env, XAI_BASE_URL: baseUrl, XAI_API_KEY: 'fake-xai-test-key-not-real' };
  delete env.OPENAI_COMPAT_BASE_URL;
  delete env.OPENAI_COMPAT_API_KEY;
  const { child, getStderr } = spawnMcpServer(env, { merge: false });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);

    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'chat', arguments: { model: 'xai/grok-build-0.1', prompt: 'smoke test' } },
    });

    // Mock response carries no `usage`, so no trailing NDJSON usage line is
    // emitted (see the server's contract) — exactly one line comes back.
    const callLine = JSON.parse(await nextLine());
    assert.equal(callLine.id, 3);
    assert.equal(callLine.result.isError, false, `expected no error, got: ${JSON.stringify(callLine.result)}`);
    assert.equal(callLine.result.structuredContent.summary, 'grok says hi');

    assert.ok(capturedRequest, 'mock endpoint should have received the chat completion request');
    // The project's "xai/" disambiguation prefix must be stripped before
    // the model id reaches the upstream API — xAI rejects the prefixed id.
    assert.equal(capturedRequest.model, 'grok-build-0.1');
    assert.equal(capturedAuthHeader, 'Bearer fake-xai-test-key-not-real');

    const stderr = getStderr();
    assert.equal(stderr, '', 'server must not write anything to stderr on a clean run');
    assert.doesNotMatch(stderr, /fake-xai-test-key-not-real/, 'the API key must never be logged');
  } finally {
    child.kill();
    await closeServer(server);
  }
});

test('xai/ model with no XAI_API_KEY: fails with a clear error naming XAI_API_KEY, no HTTP call made, never falls back to OPENAI_COMPAT_API_KEY', async () => {
  const storeDir = emptyStoreDir();
  const env = {
    ...process.env,
    TYCOON_STANDALONE_DATA_DIR: storeDir,
    XAI_BASE_URL: 'http://127.0.0.1:1',
    OPENAI_COMPAT_API_KEY: 'kimi-key-must-not-be-used',
  };
  delete env.OPENAI_COMPAT_BASE_URL;
  delete env.XAI_API_KEY;
  const { child } = spawnMcpServer(env, { merge: false });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'chat', arguments: { model: 'xai/grok-build-0.1', prompt: 'hi' } },
    });
    const callLine = JSON.parse(await nextLine());
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /XAI_API_KEY/);
    assert.doesNotMatch(callLine.result.content[0].text, /kimi-key-must-not-be-used/);
  } finally {
    child.kill();
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test('xai/ request and a Kimi request stay on separate endpoints/keys even when both OPENAI_COMPAT_* and XAI_API_KEY are set', async () => {
  let kimiCapturedAuth = null;
  let kimiCapturedModel = null;
  const { server: kimiServer, baseUrl: kimiBaseUrl } = await startMockEndpoint((req, res, body) => {
    kimiCapturedAuth = req.headers['authorization'] || null;
    kimiCapturedModel = JSON.parse(body).model;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'kimi reply' } }] }));
  });
  let grokCapturedAuth = null;
  let grokCapturedModel = null;
  const { server: grokServer, baseUrl: grokBaseUrl } = await startMockEndpoint((req, res, body) => {
    grokCapturedAuth = req.headers['authorization'] || null;
    grokCapturedModel = JSON.parse(body).model;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'grok reply' } }] }));
  });

  const env = {
    ...process.env,
    OPENAI_COMPAT_BASE_URL: kimiBaseUrl,
    OPENAI_COMPAT_API_KEY: 'kimi-key',
    XAI_BASE_URL: grokBaseUrl,
    XAI_API_KEY: 'xai-key',
  };
  const { child } = spawnMcpServer(env);
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);

    send(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chat', arguments: { model: 'moonshot/kimi-k2', prompt: 'hi' } } });
    const kimiLine = JSON.parse(await nextLine());
    assert.equal(kimiLine.result.structuredContent.summary, 'kimi reply');
    assert.equal(kimiCapturedAuth, 'Bearer kimi-key');
    assert.equal(kimiCapturedModel, 'moonshot/kimi-k2');

    send(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'chat', arguments: { model: 'xai/grok-build-0.1', prompt: 'hi' } } });
    const grokLine = JSON.parse(await nextLine());
    assert.equal(grokLine.result.structuredContent.summary, 'grok reply');
    assert.equal(grokCapturedAuth, 'Bearer xai-key');
    assert.equal(grokCapturedModel, 'grok-build-0.1');
  } finally {
    child.kill();
    await closeServer(kimiServer);
    await closeServer(grokServer);
  }
});

test('VENDOR_DEFAULTS (source, not executed against the network) points xai/ models at XAI_BASE_URL / https://api.x.ai/v1 and XAI_API_KEY', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(HOOK_PATH, 'utf8');
  assert.match(src, /prefix:\s*"xai\/"/);
  assert.match(src, /baseUrlEnv:\s*"XAI_BASE_URL"/);
  assert.match(src, /defaultBaseUrl:\s*"https:\/\/api\.x\.ai\/v1"/);
  assert.match(src, /apiKeyEnv:\s*"XAI_API_KEY"/);
});
