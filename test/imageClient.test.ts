/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// imageClient.ts is vscode-free (provider + API key are resolved by the
// caller and passed in via ThemeImageGenerationOptions/ThemeImageConfig), so
// it can be required directly under plain `node --test` with no module stub.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateThemeImage } = require('../src/extension/imageClient') as typeof import('../src/extension/imageClient');

// project-plan pA-t5: prove imageClient's vscode-freedom is real, not an
// artifact of some OTHER file in this process having already stubbed
// require('vscode') (several test files, e.g. test/themeMigration.test.ts,
// monkeypatch Module._load to satisfy themeService.ts's `import * as vscode
// from 'vscode'`). This file registers no such stub. `node --test` runs each
// matched test file in its own child process, so that stub (if any existed
// here) could not leak in from another file either.
test('imageClient module has zero runtime dependency on vscode', () => {
  // Sanity check: no real 'vscode' package is installed (only @types/vscode
  // for compile-time types), so an unstubbed require('vscode') must fail in
  // this process. If this assertion ever stops failing, the "no stub
  // registered" premise below is no longer trustworthy.
  assert.throws(() => require('vscode'), /Cannot find module 'vscode'/);

  // Now load the COMPILED output of imageClient.ts directly (a fresh
  // require, bypassing this file's own cache) and confirm it loads cleanly
  // and exports a usable generateThemeImage -- proving imageClient itself
  // never reaches for 'vscode' at module-load time.
  const compiledPath = path.resolve(__dirname, '../src/extension/imageClient.js');
  const resolved = require.resolve(compiledPath);
  delete require.cache[resolved];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const freshModule = require(compiledPath) as typeof import('../src/extension/imageClient');
  assert.equal(typeof freshModule.generateThemeImage, 'function');
});

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

test('generateThemeImage (openai) resolves provider + apiKey from an injected ThemeImageConfig when options omit them', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;
  let capturedAuth: string | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    // options is empty -- no provider, no apiKey -- so both must come from
    // the injected config, exactly as a standalone host (its own secret
    // store, no vscode.secrets) would call this.
    await generateThemeImage('a test prompt', {}, { provider: 'openai', openaiApiKey: 'config-injected-openai-key' });
    assert.equal(capturedUrl, 'https://api.openai.com/v1/images/generations');
    assert.equal(capturedAuth, 'Bearer config-injected-openai-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage (gemini) resolves provider + apiKey from an injected ThemeImageConfig when options omit them', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;
  let capturedApiKeyHeader: string | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedApiKeyHeader = (init?.headers as Record<string, string> | undefined)?.['x-goog-api-key'];
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('fake-png').toString('base64') } }] } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await generateThemeImage('a test prompt', {}, { provider: 'gemini', geminiApiKey: 'config-injected-gemini-key' });
    assert.ok(capturedUrl?.startsWith('https://generativelanguage.googleapis.com/'));
    assert.equal(capturedApiKeyHeader, 'config-injected-gemini-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage: options.apiKey overrides config.openaiApiKey when both are present', async () => {
  const originalFetch = globalThis.fetch;
  let capturedAuth: string | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await generateThemeImage(
      'a test prompt',
      { provider: 'openai', apiKey: 'options-apikey-wins' },
      { provider: 'openai', openaiApiKey: 'config-key-should-be-ignored' },
    );
    assert.equal(capturedAuth, 'Bearer options-apikey-wins');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage: no apiKey in options or config or env throws a clear error naming the provider', async () => {
  const originalOpenAiEnv = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      generateThemeImage('a test prompt', { provider: 'openai' }, {}),
      /No OpenAI API key found/,
    );
  } finally {
    if (originalOpenAiEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiEnv;
  }
});

test('generateThemeImage (gemini) appends the no-text directive to the prompt sent to the API', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('fake-png').toString('base64') } }] } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await generateThemeImage('Cell 1 — CONTACT: ready stance', {
      provider: 'gemini',
      apiKey: 'test-key',
    });
    const sentText: string = capturedBody.contents[0].parts[0].text;
    assert.ok(sentText.startsWith('Cell 1 — CONTACT: ready stance'));
    assert.match(sentText, /must never appear as visible pixels/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateThemeImage (openai) prompt is sent verbatim, with no Gemini no-text directive appended', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await generateThemeImage('Cell 1 — CONTACT: ready stance', {
      provider: 'openai',
      apiKey: 'test-key',
    });
    assert.equal(capturedBody.prompt, 'Cell 1 — CONTACT: ready stance');
    assert.doesNotMatch(capturedBody.prompt, /must never appear as visible pixels/);
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
