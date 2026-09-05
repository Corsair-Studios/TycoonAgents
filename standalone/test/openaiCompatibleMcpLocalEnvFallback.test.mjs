// TycoonAgents standalone — p13-t6 bridge fallback test: hooks/openai-compatible-mcp.cjs
// must resolve OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY from process.env
// first, falling back to the per-user localEnvStore (src/core/localEnvStore.ts,
// compiled to out/src/core/localEnvStore.js) only when the env var is unset.
// Exercises the real hook process (stdio JSON-RPC) against a local mock
// OpenAI-compatible HTTP server, with values ONLY in the store (no env vars
// set at all), proving the fallback path actually reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'hooks', 'openai-compatible-mcp.cjs');
const LOCAL_ENV_STORE_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'localEnvStore.js');

function scriptExists(p) {
  return fs.existsSync(p);
}

function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        server.lastAuth = req.headers['authorization'];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function sendRpc(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function collectRpcResponses(child) {
  const responses = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        responses.push(JSON.parse(line));
      } catch {
        // non-JSON NDJSON usage line — ignore for response matching
      }
    }
  });
  return responses;
}

function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test(
  'openai-compatible-mcp.cjs falls back to localEnvStore when OPENAI_COMPAT_BASE_URL/API_KEY are unset',
  { skip: !scriptExists(HOOK_PATH) && 'hook script not present', todo: !scriptExists(LOCAL_ENV_STORE_JS) && 'compiled localEnvStore.js not built (run tsc -p . first)' },
  async () => {
    const storeAppDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-openai-compat-fallback-'));
    const { setValue } = await import(`file://${LOCAL_ENV_STORE_JS.replace(/\\/g, '/')}`);
    setValue('OPENAI_COMPAT_BASE_URL', 'http://__placeholder__', { env: { TYCOON_STANDALONE_DATA_DIR: storeAppDataDir } });
    setValue('OPENAI_COMPAT_API_KEY', 'stored-secret-key', { env: { TYCOON_STANDALONE_DATA_DIR: storeAppDataDir } });

    const upstream = await startMockUpstream();
    const realBaseUrl = `http://127.0.0.1:${upstream.address().port}`;
    // Overwrite the stored base URL now that we know the mock server's port
    // (can't know it before starting the server).
    setValue('OPENAI_COMPAT_BASE_URL', realBaseUrl, { env: { TYCOON_STANDALONE_DATA_DIR: storeAppDataDir } });

    // Also drop a same-directory copy of localEnvStore.js next to a fake
    // hooks dir so the hook's own candidate-path resolution (hooks/localEnvStore.js)
    // is exercised too, matching how copy-hook-runtime.mjs ships it in the real VSIX.
    const fakeHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-fake-hooks-'));
    fs.copyFileSync(LOCAL_ENV_STORE_JS, path.join(fakeHooksDir, 'localEnvStore.js'));
    fs.copyFileSync(HOOK_PATH, path.join(fakeHooksDir, 'openai-compatible-mcp.cjs'));

    const child = spawn(process.execPath, [path.join(fakeHooksDir, 'openai-compatible-mcp.cjs')], {
      env: { ...process.env, TYCOON_STANDALONE_DATA_DIR: storeAppDataDir, OPENAI_COMPAT_BASE_URL: '', OPENAI_COMPAT_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = collectRpcResponses(child);

    try {
      sendRpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
      await waitFor(() => responses.find((r) => r.id === 1));

      sendRpc(child, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'chat', arguments: { model: 'test-model', prompt: 'ping' } },
      });
      const callResult = await waitFor(() => responses.find((r) => r.id === 2));

      assert.equal(callResult.result.isError, undefined, `expected success, got: ${JSON.stringify(callResult.result)}`);
      assert.equal(callResult.result.content[0].text, 'pong');
      assert.equal(upstream.lastAuth, 'Bearer stored-secret-key', 'the stored API key must reach the upstream Authorization header');
    } finally {
      child.kill();
      upstream.close();
      fs.rmSync(storeAppDataDir, { recursive: true, force: true });
      fs.rmSync(fakeHooksDir, { recursive: true, force: true });
    }
  },
);
