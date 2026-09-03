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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', '..', 'hooks', 'openai-compatible-mcp.cjs');

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

/** Spawns the real MCP server child process with the given env. */
function spawnMcpServer(env) {
  const child = spawn(process.execPath, [HOOK_PATH], {
    env: { ...process.env, ...env },
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
    assert.equal(callLine.result.isError, undefined, `expected no error, got: ${JSON.stringify(callLine.result)}`);
    assert.equal(callLine.result.content[0].type, 'text');
    assert.equal(callLine.result.content[0].text, 'hi back');
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
  const env = { ...process.env };
  delete env.OPENAI_COMPAT_BASE_URL;
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
  }
});
