// TycoonAgents standalone — loopback-by-default, remote-mode auth, and
// Host/Origin (DNS-rebinding) tests for standalone/src/server.mjs.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ServerStartError, isLoopbackHost } from '../src/server.mjs';

function seed(root) {
  const agentsDir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'coding-specialist.md'),
    '---\nname: Coding Specialist\n---\n\n# Coding Specialist\n\n## Role\nImplements things.\n',
    'utf8',
  );
}

async function withServer(extraEnv, fn) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-remote-project-'));
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-remote-data-'));
  seed(projectRoot);
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir, ...extraEnv },
    cwd: projectRoot,
  });
  try {
    await fn(runtime);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
}

function raw(runtime, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: runtime.port, method, path: pathname, headers: { host: `127.0.0.1:${runtime.port}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const REMOTE_ENV = { TYCOON_STANDALONE_HOST: '0.0.0.0', TYCOON_STANDALONE_ALLOW_REMOTE: '1' };
const LONG_TOKEN = 'a'.repeat(40);
const json = { 'Content-Type': 'application/json' };

test('isLoopbackHost classification', () => {
  for (const h of ['127.0.0.1', '127.5.5.5', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '127.999.1.1', '127.0.256.1']) assert.equal(isLoopbackHost(h), false, h);
});

test('non-loopback host without ALLOW_REMOTE refuses to start', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-remote-refuse-'));
  seed(projectRoot);
  try {
    await assert.rejects(
      startServer({ argv: [projectRoot], env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_HOST: '0.0.0.0' }, cwd: projectRoot }),
      (err) => err instanceof ServerStartError && /ALLOW_REMOTE/.test(err.message),
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('remote mode rejects a short TYCOON_STANDALONE_TOKEN', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-remote-short-'));
  seed(projectRoot);
  try {
    await assert.rejects(
      startServer({
        argv: [projectRoot],
        env: { TYCOON_STANDALONE_PORT: '0', ...REMOTE_ENV, TYCOON_STANDALONE_TOKEN: 'short' },
        cwd: projectRoot,
      }),
      ServerStartError,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('remote mode: homepage has no token; protected endpoints need the access token', async () => {
  await withServer({ ...REMOTE_ENV, TYCOON_STANDALONE_TOKEN: LONG_TOKEN }, async (rt) => {
    const home = await raw(rt);
    assert.equal(home.status, 200);
    assert.ok(!home.body.includes(LONG_TOKEN));
    assert.ok(!home.body.includes(rt.sessionToken));
    assert.ok(!home.body.includes('tycoon-token'));
    assert.match(home.body, /name="token"/);

    const post = (headers) =>
      raw(rt, { method: 'POST', pathname: '/message', headers: { ...json, ...headers }, body: JSON.stringify({ type: 'noop' }) });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post({ 'X-Tycoon-Token': rt.sessionToken })).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${LONG_TOKEN}` })).status, 202);

    assert.equal((await raw(rt, { pathname: '/events' })).status, 401);
    assert.equal((await raw(rt, { pathname: '/media/style.css' })).status, 401);
  });
});

test('remote mode: generated token is exposed to the handle and works', async () => {
  await withServer(REMOTE_ENV, async (rt) => {
    assert.match(rt.accessToken, /^[0-9a-f]{64}$/);
    const res = await raw(rt, { pathname: '/media/style.css', headers: { Authorization: `Bearer ${rt.accessToken}` } });
    assert.equal(res.status, 200);
  });
});

test('remote mode: login sets an HttpOnly cookie; cookie POST needs Origin', async () => {
  await withServer({ ...REMOTE_ENV, TYCOON_STANDALONE_TOKEN: LONG_TOKEN }, async (rt) => {
    const origin = `http://127.0.0.1:${rt.port}`;
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const noOrigin = await raw(rt, { method: 'POST', pathname: '/login', headers: form, body: `token=${LONG_TOKEN}` });
    assert.equal(noOrigin.status, 403);
    const bad = await raw(rt, { method: 'POST', pathname: '/login', headers: { ...form, Origin: origin }, body: 'token=nope' });
    assert.equal(bad.status, 401);
    const ok = await raw(rt, { method: 'POST', pathname: '/login', headers: { ...form, Origin: origin }, body: `token=${LONG_TOKEN}` });
    assert.equal(ok.status, 303);
    const cookie = ok.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const cookieHeader = cookie.split(';')[0];

    const home = await raw(rt, { headers: { Cookie: cookieHeader } });
    assert.equal(home.status, 200);
    assert.ok(!home.body.includes(LONG_TOKEN));
    assert.ok(!home.body.includes('name="token"'));

    const body = JSON.stringify({ type: 'noop' });
    const noOriginPost = await raw(rt, { method: 'POST', pathname: '/message', headers: { ...json, Cookie: cookieHeader }, body });
    assert.equal(noOriginPost.status, 403, 'cookie auth without Origin must be rejected');
    const withOrigin = await raw(rt, { method: 'POST', pathname: '/message', headers: { ...json, Cookie: cookieHeader, Origin: origin }, body });
    assert.equal(withOrigin.status, 202);
    const badOrigin = await raw(rt, { method: 'POST', pathname: '/message', headers: { ...json, Cookie: cookieHeader, Origin: 'http://evil.example' }, body });
    assert.equal(badOrigin.status, 403);
  });
});

test('remote mode: wrong tokens are throttled but the right token always works', async () => {
  await withServer({ ...REMOTE_ENV, TYCOON_STANDALONE_TOKEN: LONG_TOKEN }, async (rt) => {
    for (let i = 0; i < 10; i++) {
      await raw(rt, { pathname: '/events', headers: { Authorization: 'Bearer wrong' } });
    }
    const blocked = await raw(rt, { pathname: '/events', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(blocked.status, 429);
    const good = await raw(rt, { pathname: '/media/style.css', headers: { Authorization: `Bearer ${LONG_TOKEN}` } });
    assert.equal(good.status, 200, 'valid token must succeed while the address is throttled');
    const after = await raw(rt, { pathname: '/events', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(after.status, 401, 'a successful auth clears the failure count');
  });
});

async function loginCookie(rt) {
  const origin = `http://127.0.0.1:${rt.port}`;
  const ok = await raw(rt, {
    method: 'POST', pathname: '/login',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: `token=${LONG_TOKEN}`,
  });
  assert.equal(ok.status, 303);
  return ok.headers['set-cookie'][0];
}

test('remote mode: session cookie is an opaque id, not the token, and survives use', async () => {
  await withServer({ ...REMOTE_ENV, TYCOON_STANDALONE_TOKEN: LONG_TOKEN }, async (rt) => {
    const cookie = await loginCookie(rt);
    const [name, value] = cookie.split(';')[0].split('=');
    assert.equal(name, `tycoon_session_${rt.port}`);
    assert.notEqual(value, LONG_TOKEN);
    assert.ok(!cookie.includes(LONG_TOKEN));
    assert.match(cookie, /Max-Age=\d+/);
    assert.doesNotMatch(cookie, /Secure/);
    const header = cookie.split(';')[0];
    for (let i = 0; i < 3; i++) assert.equal((await raw(rt, { pathname: '/media/style.css', headers: { Cookie: header } })).status, 200);
    // Presenting the raw token as the cookie value is not accepted.
    const forged = await raw(rt, { pathname: '/media/style.css', headers: { Cookie: `${name}=${LONG_TOKEN}` } });
    assert.equal(forged.status, 401);
  });
});

test('remote mode: expired session is rejected', async () => {
  await withServer({ ...REMOTE_ENV, TYCOON_STANDALONE_TOKEN: LONG_TOKEN }, async (rt) => {
    const header = (await loginCookie(rt)).split(';')[0];
    assert.equal((await raw(rt, { pathname: '/media/style.css', headers: { Cookie: header } })).status, 200);
    const realNow = Date.now;
    const spy = mock.method(Date, 'now', () => realNow() + 13 * 60 * 60 * 1000);
    try {
      assert.equal((await raw(rt, { pathname: '/media/style.css', headers: { Cookie: header } })).status, 401);
    } finally {
      spy.mock.restore();
    }
  });
});

test('TYCOON_STANDALONE_SECURE_COOKIE=1 adds Secure', async () => {
  await withServer({ ...REMOTE_ENV, TYCOON_STANDALONE_TOKEN: LONG_TOKEN, TYCOON_STANDALONE_SECURE_COOKIE: '1' }, async (rt) => {
    assert.match(await loginCookie(rt), /; Secure/);
  });
});

test('malformed Host and request URL return 400 and the server keeps serving', async () => {
  await withServer({}, async (rt) => {
    assert.equal((await raw(rt, { headers: { host: 'a b' } })).status, 400);
    const noHost = await new Promise((resolve, reject) => {
      const sock = net.connect(rt.port, '127.0.0.1', () => sock.write('GET / HTTP/1.0\r\n\r\n'));
      let data = '';
      sock.on('data', (c) => (data += c));
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(noHost, /^HTTP\/1\.1 400/);
    assert.equal((await raw(rt, { pathname: '//' })).status < 500, true);
    assert.equal((await raw(rt, { pathname: 'http://[bad' })).status, 400);
    assert.equal((await raw(rt)).status, 200);
  });
});

test('Host header rebinding is rejected on loopback; allowed names pass', async () => {
  await withServer({}, async (rt) => {
    assert.equal((await raw(rt, { headers: { host: `evil.example:${rt.port}` } })).status, 403);
    assert.equal((await raw(rt, { headers: { host: 'evil.example' } })).status, 403);
    for (const h of [`localhost:${rt.port}`, `127.0.0.1:${rt.port}`, `[::1]:${rt.port}`]) {
      assert.equal((await raw(rt, { headers: { host: h } })).status, 200, h);
    }
  });
});

test('TYCOON_STANDALONE_ALLOWED_HOSTS adds explicit names', async () => {
  await withServer({ TYCOON_STANDALONE_ALLOWED_HOSTS: 'tycoon.internal' }, async (rt) => {
    assert.equal((await raw(rt, { headers: { host: `tycoon.internal:${rt.port}` } })).status, 200);
  });
});

test('Origin mismatch is rejected on loopback; normal UI flow unchanged', async () => {
  await withServer({}, async (rt) => {
    const body = JSON.stringify({ type: 'noop' });
    const evil = await raw(rt, {
      method: 'POST', pathname: '/message', body,
      headers: { ...json, 'X-Tycoon-Token': rt.sessionToken, Origin: 'http://evil.example' },
    });
    assert.equal(evil.status, 403);

    const home = await raw(rt);
    assert.equal(home.status, 200);
    assert.ok(home.body.includes(rt.sessionToken), 'loopback homepage still embeds the session token');

    const ok = await raw(rt, {
      method: 'POST', pathname: '/message', body,
      headers: { ...json, 'X-Tycoon-Token': rt.sessionToken, Origin: `http://127.0.0.1:${rt.port}` },
    });
    assert.equal(ok.status, 202);
  });
});
