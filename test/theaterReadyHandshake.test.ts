/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/*
 * Contract under test: src/extension/main.ts exports
 * `handleTheaterReady(deps: TheaterReadyDeps): Promise<void>`, called from
 * TheaterViewProvider's onDidReceiveMessage when msg.type === MSG.READY
 * (the Theater sidebar reuses the generic "ready" wire string -- no new
 * THEATER_READY constant was added) or the legacy 'THEME_REQUEST'.
 * TheaterViewProvider.resolveWebviewView no longer posts THEME_INITIALIZED
 * unconditionally.
 *
 * deps: { bundledThemesReady, getLastTheme, loadLatestTheme, post }.
 * handleTheaterReady: if getLastTheme() returns a cached theme, posts
 * THEME_INITIALIZED immediately (no wait); otherwise awaits
 * waitForBundledThemes(deps.bundledThemesReady) (src/host/vscode/themeReady.ts,
 * default bound THEME_SEED_WAIT_MS = 5000ms, not caller-injectable), then
 * loadLatestTheme() and posts THEME_INITIALIZED or MSG.THEME_NONE.
 *
 * media/theme-builder.js posts `{ type: "ready" }` after attaching its
 * window 'message' listener (media/theme-builder.js:788 addEventListener,
 * :818/:820 postMessage ready).
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const mainSrcPath = path.join(repoRoot, 'src', 'extension', 'main.ts');
const mainOutPath = path.join(repoRoot, 'out', 'src', 'extension', 'main.js');
const builderPath = path.join(repoRoot, 'media', 'theme-builder.js');

const mainSrc = fs.readFileSync(mainSrcPath, 'utf8');
const builderSrc = fs.readFileSync(builderPath, 'utf8');

const seamLanded = /export\s+async\s+function\s+handleTheaterReady\s*\(/.test(mainSrc)
  && fs.existsSync(mainOutPath);

/*
 * main.ts imports 'vscode', unresolvable outside the extension host. Stub the
 * module loader the same way test/bundledThemeDefault.test.ts does -- an
 * inert self-returning Proxy for anything the module touches at import time
 * (registerWebviewViewProvider, commands.registerCommand, etc.) that we don't
 * otherwise need for calling the exported handleTheaterReady function.
 */
function inertVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(t, prop) {
      if (prop === '__esModule') return true;
      if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
      if (!(prop in t)) t[prop] = new Proxy(function stub() {}, handler);
      return t[prop];
    },
    apply: () => new Proxy({}, handler),
    construct: () => new Proxy({}, handler),
  };
  return new Proxy({}, handler);
}

let seamModule: { handleTheaterReady: (deps: unknown) => Promise<void> } | undefined;
function loadSeam(): { handleTheaterReady: (deps: unknown) => Promise<void> } {
  if (seamModule) return seamModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const NodeModule = require('module');
  const originalLoad = NodeModule._load;
  NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return inertVscodeStub();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    seamModule = require(mainOutPath) as { handleTheaterReady: (deps: unknown) => Promise<void> };
  } finally {
    NodeModule._load = originalLoad;
  }
  return seamModule;
}

// --- structural tests (real source, no import needed) ----------------------

test('messages.ts READY constant ("ready") is unique among MSG values', () => {
  const messagesSrc = fs.readFileSync(
    path.join(repoRoot, 'src', 'host', 'vscode', 'messages.ts'),
    'utf8',
  );
  const msgBlockMatch = messagesSrc.match(/export const MSG = \{([\s\S]*?)\n\} as const;/);
  assert.ok(msgBlockMatch, 'could not locate MSG object literal in messages.ts');
  const values = [...msgBlockMatch![1].matchAll(/:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const occurrences = values.filter((v) => v === 'ready').length;
  assert.equal(occurrences, 1, `expected "ready" to appear exactly once among MSG values, found ${occurrences}`);
});

test('main.ts has no unconditional THEME_INITIALIZED post inside resolveWebviewView', () => {
  const resolveIdx = mainSrc.indexOf('resolveWebviewView(');
  const disposeIdx = mainSrc.indexOf('onDidDispose', resolveIdx);
  assert.ok(resolveIdx !== -1 && disposeIdx !== -1, 'could not locate resolveWebviewView method body');
  const body = mainSrc.slice(resolveIdx, disposeIdx);
  const iifeUnconditional = /void\s*\(async\s*\(\)\s*=>\s*\{[\s\S]*?broadcastTheme[\s\S]*?\}\)\(\);/.test(body);
  assert.equal(iifeUnconditional, false, 'resolveWebviewView still posts THEME_INITIALIZED unconditionally via an unguarded IIFE');
  // The gated path must exist: a branch on the ready message that calls the seam.
  assert.match(body, /msg\?\.type === MSG\.READY/, 'resolveWebviewView no longer gates on MSG.READY');
  assert.match(body, /handleTheaterReady\s*\(/, 'resolveWebviewView no longer calls handleTheaterReady');
});

test('Theater webview script posts "ready" after adding its message listener', () => {
  const listenerIdx = builderSrc.indexOf('addEventListener("message"');
  assert.ok(listenerIdx !== -1, 'theme-builder.js has no window message listener');
  const readyPostIdx = builderSrc.indexOf('type: "ready"', listenerIdx);
  assert.ok(readyPostIdx !== -1, 'theme-builder.js never posts { type: "ready" } after the listener');
  assert.ok(readyPostIdx > listenerIdx, 'ready message is posted before the message listener is attached');
});

// --- behavioral tests (require the compiled seam) --------------------------

test('ready before seed resolves: waits, then posts exactly one THEME_INITIALIZED', async (t) => {
  if (!seamLanded) {
    t.skip('seam not landed: handleTheaterReady missing from src/extension/main.ts or build output stale');
    return;
  }
  const { handleTheaterReady } = loadSeam();
  const posted: Array<{ type: string }> = [];
  let resolveSeed!: () => void;
  const seed = new Promise<void>((res) => { resolveSeed = res; });

  const p = handleTheaterReady({
    bundledThemesReady: seed,
    getLastTheme: () => undefined,
    loadLatestTheme: async () => ({ manifest: { id: 'x' }, frames: {} }),
    post: (m: { type: string }) => posted.push(m),
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(posted.length, 0, 'must not post before the seed resolves');

  resolveSeed();
  await p;

  assert.equal(posted.length, 1, 'expected exactly one post');
  assert.equal(posted[0].type, 'THEME_INITIALIZED');
});

test('seed never resolves: after the bounded timeout, a single no-theme message', async (t) => {
  if (!seamLanded) {
    t.skip('seam not landed: handleTheaterReady missing from src/extension/main.ts or build output stale');
    return;
  }
  const { handleTheaterReady } = loadSeam();
  const posted: Array<{ type: string }> = [];

  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = handleTheaterReady({
      bundledThemesReady: new Promise<void>(() => {}), // never resolves
      getLastTheme: () => undefined,
      loadLatestTheme: async () => undefined,
      post: (m: { type: string }) => posted.push(m),
    });
    // THEME_SEED_WAIT_MS default is 5000ms (themeReady.ts); fast-forward it.
    await t.mock.timers.tick(5000);
    await p;
  } finally {
    t.mock.timers.reset();
  }

  assert.equal(posted.length, 1, 'expected exactly one post after timeout');
  assert.equal(posted[0].type, 'THEME_NONE');
});

test('ready received twice: theme sent twice, second re-send still answered', async (t) => {
  if (!seamLanded) {
    t.skip('seam not landed: handleTheaterReady missing from src/extension/main.ts or build output stale');
    return;
  }
  const { handleTheaterReady } = loadSeam();
  const posted: Array<{ type: string }> = [];
  let loadCount = 0;
  let cached: { manifest: unknown; frames: unknown } | undefined;

  const deps = {
    bundledThemesReady: undefined,
    getLastTheme: () => cached,
    loadLatestTheme: async () => {
      loadCount += 1;
      return { manifest: { id: 'x' }, frames: {} };
    },
    post: (m: { type: string; payload?: unknown }) => {
      posted.push(m);
      if (m.type === 'THEME_INITIALIZED') {
        cached = (m.payload as { manifest: unknown; frames: unknown });
      }
    },
  };

  await handleTheaterReady(deps);
  await handleTheaterReady(deps);

  const themeMsgs = posted.filter((m) => m.type === 'THEME_INITIALIZED');
  assert.equal(themeMsgs.length, 2, 'second ready must still be answered with the theme');
  // Implementation caches via getLastTheme, so the disk load should not repeat.
  assert.equal(loadCount, 1, 'expected loadLatestTheme to be called once when the second ready hits the cache');
});
