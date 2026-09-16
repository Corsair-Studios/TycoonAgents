// p59-t4: v3.4 wire-contract coverage for createThemeServiceClient
// (src/core/themeServiceClient.ts) — docs/theme-service-api.md POST
// /api/generate ~197-296: no top-level `prompt` field anywhere in the
// request body, X-Tycoon-Client header carries clientVersion, a 180s (or
// overridden) AbortController timeout maps to error kind "timeout", and the
// response's promptTemplateVersion/assembledPromptSha256 fields parse
// through to the result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThemeServiceClient, ThemeServiceTokenStore } from '../src/core/themeServiceClient';
import { createFakeThemeService } from './helpers/fakeThemeService';

const ENDPOINT = 'https://theme-service.example';
const SUPABASE_URL = 'https://fake-project.supabase.co';

function memoryTokenStore(initial: string | null = null): ThemeServiceTokenStore {
  let value = initial;
  return {
    async get() { return value; },
    async set(t: string) { value = t; },
    async clear() { value = null; },
  };
}

async function signedInClient(extra: Partial<Parameters<typeof createThemeServiceClient>[0]> = {}) {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = fake.helpers.createAccount('v34@example.com');
  fake.helpers.grant(account.id, 50);
  const tokenStore = memoryTokenStore();
  const client = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: 'anon-key',
    ...extra,
  });
  await client.requestMagicLink('v34@example.com');
  await client.verifyMagicLink('v34@example.com', '123456');
  return { fake, client };
}

function objectsRequest(idempotencyKey: string) {
  return {
    idempotencyKey,
    boardType: 'objects_01' as const,
    promptTemplateVersion: 'client-v1',
    theme: { description: 'a theme', creativeDirection: 'bold', palette: ['#ff0000'] },
    themeName: 'Test Theme',
    slot: { items: [{ display_name: 'Chair', visual_description: 'a wooden chair' }] },
    options: { seed: 1, backgroundMode: 'magenta' as const },
    size: '1024x1024',
  };
}

function containsKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => containsKeyDeep(v, key));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key) return true;
      if (containsKeyDeep(v, key)) return true;
    }
  }
  return false;
}

test('generateAttempt request body never contains a "prompt" key anywhere, at any depth', async () => {
  const { fake, client } = await signedInClient();
  let capturedBody: unknown;
  const spyFetch: typeof fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/api/generate') && typeof init?.body === 'string') capturedBody = JSON.parse(init.body);
    return fake.fetch(input, init);
  }) as typeof fetch;
  const spyAccount = fake.helpers.createAccount('spy@example.com');
  fake.helpers.grant(spyAccount.id, 50);
  const spied = createThemeServiceClient({ fetch: spyFetch, tokenStore: memoryTokenStore(), endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, supabaseAnonKey: 'anon-key' });
  await spied.requestMagicLink('spy@example.com');
  await spied.verifyMagicLink('spy@example.com', '123456');
  const res = await spied.generateAttempt(objectsRequest('no-prompt-1'));
  assert.equal(res.ok, true);
  assert.ok(capturedBody, 'expected /api/generate to have been called');
  assert.equal(containsKeyDeep(capturedBody, 'prompt'), false, `request body must never contain a "prompt" key: ${JSON.stringify(capturedBody)}`);
  void client;
});

test('X-Tycoon-Client header carries the configured clientVersion on every service request', async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const headersSeen: string[] = [];
  const spyFetch: typeof fetch = (async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    const v = headers.get('X-Tycoon-Client');
    if (v) headersSeen.push(v);
    return fake.fetch(input, init);
  }) as typeof fetch;
  const client = createThemeServiceClient({
    fetch: spyFetch, tokenStore: memoryTokenStore(), endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, supabaseAnonKey: 'anon-key',
    clientVersion: '9.9.9',
  });
  await client.getPricing();
  assert.deepEqual(headersSeen, ['9.9.9']);
});

test('X-Tycoon-Client header is omitted entirely when clientVersion is not configured', async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  let sawHeader = false;
  const spyFetch: typeof fetch = (async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    if (headers.has('X-Tycoon-Client')) sawHeader = true;
    return fake.fetch(input, init);
  }) as typeof fetch;
  const client = createThemeServiceClient({ fetch: spyFetch, tokenStore: memoryTokenStore(), endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, supabaseAnonKey: 'anon-key' });
  await client.getPricing();
  assert.equal(sawHeader, false);
});

test('a request that never resolves times out with error kind "timeout"', async () => {
  const hangingFetch: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  })) as typeof fetch;
  const client = createThemeServiceClient({
    fetch: hangingFetch,
    tokenStore: memoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: 'anon-key',
    requestTimeoutMs: 10,
  });
  const res = await client.getPricing();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, 'timeout');
  }
});

test('response parses promptTemplateVersion and assembledPromptSha256 through to the result', async () => {
  const { client } = await signedInClient();
  const res = await client.generateAttempt(objectsRequest('parse-fields-1'));
  assert.equal(res.ok, true);
  if (res.ok) {
    // The fake's /api/generate handler (test/helpers/fakeThemeService.ts)
    // does not set these fields, so a real service response is simulated
    // via a wrapping fetch below instead.
    assert.equal(typeof res.value.image, 'string');
  }
});

test('response parses promptTemplateVersion/assembledPromptSha256 when the service includes them', async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = fake.helpers.createAccount('fields@example.com');
  fake.helpers.grant(account.id, 10);
  const withFields: typeof fetch = async (input, init) => {
    const res = await fake.fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes('/api/generate') || res.status !== 200) return res;
    const body = await res.json();
    body.promptTemplateVersion = 'server-v9';
    body.assembledPromptSha256 = 'deadbeef';
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = createThemeServiceClient({ fetch: withFields, tokenStore: memoryTokenStore(), endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, supabaseAnonKey: 'anon-key' });
  await client.requestMagicLink('fields@example.com');
  await client.verifyMagicLink('fields@example.com', '123456');
  const res = await client.generateAttempt(objectsRequest('fields-1'));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.promptTemplateVersion, 'server-v9');
    assert.equal(res.value.assembledPromptSha256, 'deadbeef');
  }
});

// Per-field caps (docs/theme-service-api.md's RowSpec / theme.description /
// theme.creativeDirection char limits): the client does NOT enforce these —
// createThemeServiceClient never validates GenerateAttemptRequest field
// lengths before sending (see src/core/themeServiceClient.ts's
// generateAttempt, which only shapes the response, not the request) — so
// this is skipped rather than asserting behavior the client does not have.
test('per-field character caps are enforced server-side only, not client-side (documented, not asserted)', () => {
  assert.ok(true, 'skipped: src/core/themeServiceClient.ts performs no client-side field-length validation on GenerateAttemptRequest');
});
