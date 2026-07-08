/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// imageClient.ts does `import * as vscode from 'vscode'` at module scope
// (needed for the extension-settings fallback path); the watchdog tests below
// always pass an explicit provider + apiKey so that path is never exercised,
// but Node can't resolve the 'vscode' module outside the real extension host.
// Stub the module loader so this file's require chain resolves under plain
// `node --test` — same pattern used in test/reviewSynthesis.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

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
