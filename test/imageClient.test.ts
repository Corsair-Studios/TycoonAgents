/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// imageClient.ts is vscode-free (provider + API key are resolved by the
// caller and passed in via ThemeImageGenerationOptions/ThemeImageConfig), so
// it can be required directly under plain `node --test` with no module stub.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateThemeImage } = require('../src/extension/imageClient') as typeof import('../src/extension/imageClient');

/** Fetch stand-in that never resolves on its own but rejects (like real fetch) when its signal aborts. */
function neverResolvingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
      // Otherwise: hang forever, simulating a stalled upstream.
    });
  }) as typeof fetch;
}

test('generateThemeImage (openai) watchdog rejects a hung request with a clear timeout error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = neverResolvingFetch();
  try {
    await assert.rejects(
      generateThemeImage('a test prompt', {
        provider: 'openai',
        apiKey: 'test-key',
        watchdogMs: 25,
      }),
      /OpenAI GPT Image request timed out after/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage (gemini) watchdog rejects a hung request with a clear timeout error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = neverResolvingFetch();
  try {
    await assert.rejects(
      generateThemeImage('a test prompt', {
        provider: 'gemini',
        apiKey: 'test-key',
        watchdogMs: 25,
      }),
      /Gemini Image request timed out after/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage (openai) requests background:"transparent" when transparentBackground is set', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await generateThemeImage('a test prompt', {
      provider: 'openai',
      apiKey: 'test-key',
      transparentBackground: true,
    });
    assert.equal(capturedBody.background, 'transparent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage (openai) defaults to background:"opaque" when transparentBackground is unset (e.g. the environment board)', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await generateThemeImage('a test prompt', {
      provider: 'openai',
      apiKey: 'test-key',
    });
    assert.equal(capturedBody.background, 'opaque');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage watchdog timer does not fire after a request settles normally', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'boom' } }), {
      status: 500,
    })) as typeof fetch;
  try {
    // A fast, normal (if erroring) response should resolve/reject well before
    // the watchdog — proving the timer is cleared on completion rather than
    // left dangling (which the test runner's open-handle detection would
    // otherwise flag).
    await assert.rejects(
      generateThemeImage('a test prompt', {
        provider: 'openai',
        apiKey: 'test-key',
        watchdogMs: 5_000,
      })
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
