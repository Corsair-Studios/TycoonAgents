// p59-t4: standalone bridge coverage — createThemeServiceHost
// (standalone/src/themeServiceHost.mjs) must thread `clientVersion` into the
// real createThemeServiceClient it builds, and that client's generateAttempt
// must send the v3.4 structured request with no top-level `prompt` key. Uses
// a stub fetch (no compiled fakeThemeService.js dependency) so this file has
// no build-order requirement beyond the standalone package itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createThemeServiceHost } from '../src/themeServiceHost.mjs';

function mkTempAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-v34-'));
}

function containsKeyDeep(value, key) {
  if (Array.isArray(value)) return value.some((v) => containsKeyDeep(v, key));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) return true;
      if (containsKeyDeep(v, key)) return true;
    }
  }
  return false;
}

test('createThemeServiceHost threads clientVersion + a prompt-free structured body to /api/generate', async (t) => {
  const appDataDir = mkTempAppData();
  t.after(() => fs.rmSync(appDataDir, { recursive: true, force: true }));

  const calls = [];
  const stubFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, headers, body: init?.body ? JSON.parse(init.body) : undefined });

    if (url.includes('/auth/v1/otp')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/auth/v1/verify')) {
      return new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/generate')) {
      return new Response(JSON.stringify({ image: 'data:image/png;base64,ZmFrZQ==', attemptCost: 1, credits: 9, refunded: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const host = createThemeServiceHost({
    appDataDir,
    fetch: stubFetch,
    endpoint: 'https://theme-service.example',
    supabaseUrl: 'https://fake-project.supabase.co',
    supabaseAnonKey: 'anon-key',
    clientVersion: 'standalone-4.5.6',
    postStatus: () => {},
    openExternal: () => {},
  });
  host.start();
  t.after(() => host.dispose());

  const client = host.getClient();
  await client.requestMagicLink('bridge@example.com');
  await client.verifyMagicLink('bridge@example.com', '123456');

  const res = await client.generateAttempt({
    idempotencyKey: 'bridge-1',
    boardType: 'objects_01',
    promptTemplateVersion: 'standalone-v1',
    theme: { description: 'a theme' },
    themeName: 'Bridge Theme',
    slot: { items: [{ display_name: 'Chair' }] },
    size: '1024x1024',
  });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));

  const generateCall = calls.find((c) => c.url.includes('/api/generate'));
  assert.ok(generateCall, 'expected a call to /api/generate');
  assert.equal(generateCall.headers.get('X-Tycoon-Client'), 'standalone-4.5.6');
  assert.equal(containsKeyDeep(generateCall.body, 'prompt'), false, `generate body must carry no "prompt" key: ${JSON.stringify(generateCall.body)}`);
  assert.equal(generateCall.body.boardType, 'objects_01');
  assert.equal(generateCall.body.themeName, 'Bridge Theme');
});
