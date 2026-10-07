import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * jsdom test for the Routing screen's fixed vendor key rows: on Claude Code
 * and Codex hosts a bridged vendor shows read-only env names + set/unset +
 * Test connection (src/core/vendorKeys.ts via presets.vendorKeys); OpenCode
 * hosts and Custom endpoint slots keep the free-form name inputs. Also
 * asserts no key value ever appears in a webview message.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

const MAIN_JS_PATH = join(process.cwd(), 'media', 'main.js');

function scanElementIds(src: string): string[] {
  const ids = new Set<string>();
  const re = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) ids.add(m[1]);
  return [...ids];
}

function tagForId(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes('canvas') || lower.includes('stage')) return 'canvas';
  if (lower.includes('btn') || lower.includes('button')) return 'button';
  if (lower.includes('list') || lower.includes('panel') || lower.includes('dialog') || lower.includes('area')) {
    return 'div';
  }
  return 'div';
}

const RUNTIME_CREATED_IDS = new Set([
  'rebirth-announce',
  'rebirth-panel',
  'menu-edit-stage',
  'settings-modal-close',
  'stage-edit-panel',
  'routing-modal',
  'routing-backdrop',
  'routing-dialog',
  'routing-modal-close',
  'routing-modal-title',
  'routing-modal-body',
]);

function makeCtxStub(canvasEl: unknown): unknown {
  const gradient = { addColorStop() {} };
  const target: Record<string, unknown> = {
    canvas: canvasEl,
    measureText: () => ({ width: 0 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4),
    }),
    putImageData: () => {},
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({ setTransform() {} }),
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4),
    }),
  };
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return () => {};
    },
    set(t, prop: string, value) {
      t[prop] = value;
      return true;
    },
  });
}

function makeFakeImage(win: any) {
  return class FakeImage {
    _src = '';
    width = 64;
    height = 64;
    naturalWidth = 64;
    naturalHeight = 64;
    complete = false;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    set src(v: string) {
      this._src = v;
      this.complete = true;
      win.Promise.resolve().then(() => {
        if (typeof this.onload === 'function') this.onload();
      });
    }
    get src() {
      return this._src;
    }
    addEventListener(type: string, cb: () => void) {
      if (type === 'load') this.onload = cb;
      if (type === 'error') this.onerror = cb;
    }
    removeEventListener() {}
  };
}


async function bootMain() {
  const src = readFileSync(MAIN_JS_PATH, 'utf8');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://webview.local/',
  });
  const win: any = dom.window;
  const doc = win.document;

  const ids = scanElementIds(src);
  for (const id of ids) {
    if (RUNTIME_CREATED_IDS.has(id)) continue;
    if (doc.getElementById(id)) continue;
    const el = doc.createElement(tagForId(id));
    el.id = id;
    doc.body.appendChild(el);
  }
  let stage = doc.getElementById('stage');
  if (!stage || stage.tagName.toLowerCase() !== 'canvas') {
    if (stage) stage.remove();
    stage = doc.createElement('canvas');
    stage.id = 'stage';
    doc.body.appendChild(stage);
  }
  stage.width = 1066;
  stage.height = 760;

  const posted: any[] = [];
  let stateStore: any = {};
  win.acquireVsCodeApi = () => ({
    postMessage: (m: any) => posted.push(m),
    getState: () => stateStore,
    setState: (s: any) => {
      stateStore = s;
    },
  });

  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  win.Image = makeFakeImage(win);
  win.HTMLCanvasElement.prototype.getContext = function (this: any) {
    if (!this.__ctxStub) this.__ctxStub = makeCtxStub(this);
    return this.__ctxStub;
  };
  win.HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,iVBORw0KGgo=';
  };

  const errors: any[] = [];
  win.addEventListener('error', (e: any) => {
    errors.push(e && (e.error || e.message) ? e.error || e.message : e);
  });
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => {
    errors.push(err || msg);
  };

  function assertNoErrors(step: string) {
    assert.equal(errors.length, 0, `[${step}] main.js threw:\n${errors.map((e) => (e && e.stack) || String(e)).join('\n---\n')}`);
  }
  async function flush() {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }
  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  vm.runInContext(src, dom.getInternalVMContext(), { filename: 'media/main.js' });
  await flush();
  assertNoErrors('boot');

  return { win, doc, posted, dispatch, flush, assertNoErrors };
}


const SECRET = 'sk-never-in-a-message-123456';

function agent(id: string, backend: any) {
  return { id, name: id, description: id, backend, source: 'routing', provenance: 'routing', routeSource: 'routing' };
}

function payload(agents: any[]) {
  return {
    profile: null,
    path: '.claude/tycoon/routing.json',
    errors: [] as string[],
    uiMode: 'multi',
    harness: 'claude-code',
    multiProviderCheckboxVisible: true,
    multiProviderSetting: true,
    orchestrator: { id: 'orchestrator', backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' }, source: 'default' },
    agents,
    envProbe: { XAI_API_KEY: { env: false, stored: true }, XAI_BASE_URL: { env: false, stored: false } },
    presets: {
      vendors: ['anthropic', 'openai', 'google', 'xai'],
      models: [{ id: 'xai/grok-4.7', vendor: 'xai', costModelClass: 'metered', label: 'xai/grok-4.7' }],
      vendorKeys: [
        { id: 'xai', label: 'xAI', vendors: ['xai'], modelPrefix: 'xai/', auth: 'key', test: { server: 'openai-compatible', tool: 'chat' }, testModel: 'xai/grok-build-0.1',
          rows: [
            { env: 'XAI_API_KEY', kind: 'credential', label: 'API key', required: true },
            { env: 'XAI_BASE_URL', kind: 'endpoint', label: 'Base URL', required: false, defaultValue: 'https://api.x.ai/v1' },
          ] },
        { id: 'google', label: 'Google', vendors: ['google'], auth: 'signin', signIn: 'Antigravity', test: { server: 'gemini', tool: 'ping' },
          rows: [{ env: 'GEMINI_API_KEY', kind: 'credential', label: 'Gemini API key', required: false, note: 'Gemini CLI backend only' }] },
        { id: 'openai', label: 'OpenAI', vendors: ['openai'], auth: 'signin', signIn: 'Codex', test: null, rows: [] },
      ],
    },
    lastApplied: {},
  };
}

const XAI_AGENT = agent('grok-agent', { vendor: 'xai', transport: 'openai-compatible', model: 'xai/grok-4.7', costModelClass: 'metered', endpointEnv: 'MY_CUSTOM_URL', apiKeyEnv: 'MY_CUSTOM_KEY' });

function inputsIn(doc: any): any[] {
  const card = doc.querySelector('.routing-agent-card');
  return card ? Array.from(card.querySelectorAll('.routing-env-input')) : [];
}

async function render(harness: string, agents: any[]) {
  const ctx = await bootMain();
  (ctx.doc.getElementById('menu-routing') as any).click();
  await ctx.flush();
  ctx.dispatch({ type: 'settings', payload: { harness: { effective: harness } } });
  await ctx.flush();
  ctx.dispatch({ type: 'routing', payload: payload(agents) });
  await ctx.flush();
  ctx.assertNoErrors('routing render');
  return ctx;
}

for (const harness of ['claude-code', 'codex']) {
  test('slot editor on ' + harness + ': bridged key vendor shows fixed read-only rows, no name inputs', async () => {
    const { win, doc, posted, dispatch, flush, assertNoErrors } = await render(harness, [XAI_AGENT]);
    try {
      const block = doc.querySelector('.routing-vendor-keys[data-vendor-key-spec="xai"]') as any;
      assert.ok(block, 'expected the fixed vendor key block');
      assert.equal(inputsIn(doc).length, 0, 'no free-form env name inputs');
      assert.deepEqual(
        Array.from(block.querySelectorAll('.routing-env-fixed-name')).map((e: any) => e.textContent),
        ['XAI_API_KEY', 'XAI_BASE_URL']
      );
      assert.ok(!block.innerHTML.includes('MY_CUSTOM_KEY'), 'typed names are ignored on this host');
      assert.match(block.textContent, /Default: https:\/\/api\.x\.ai\/v1/);
      assert.match(block.querySelector('[data-env-name="XAI_API_KEY"] .routing-env-state').textContent, /stored by TycoonAgents/);
      assert.match(block.querySelector('[data-env-name="XAI_BASE_URL"] .routing-env-state').textContent, /not set \(default used\)/);
      assert.ok(block.querySelector('[data-env-name="XAI_API_KEY"] .routing-set-value-btn'), 'Set value button');
      assert.ok(block.querySelector('[data-env-name="XAI_API_KEY"] .routing-clear-value-btn'), 'Clear stored value button (a stored value exists)');
      assert.equal(block.querySelector('[data-env-name="XAI_BASE_URL"] .routing-clear-value-btn'), null);

      // Test connection posts the spec id + model, never a name or value.
      const btn = block.querySelector('.routing-keytest-btn') as any;
      assert.ok(btn, 'Test connection button');
      btn.click();
      await flush();
      const msg = posted.filter((m) => m && m.type === 'testVendorKey').pop();
      assert.deepEqual(JSON.parse(JSON.stringify(msg)), { type: 'testVendorKey', vendor: 'xai', model: 'xai/grok-4.7' });
      assert.equal((block.querySelector('.routing-keytest-btn') as any).disabled, true, 'disabled while pending');

      dispatch({ type: 'vendorKeyTestResult', payload: { vendor: 'xai', state: 'auth', message: 'Auth rejected: the provider refused this key.' } });
      await flush();
      const result = block.querySelector('.routing-keytest-result');
      assert.match(result.textContent, /Auth rejected/);
      assert.ok(result.classList.contains('routing-keytest-result--bad'));
      assert.equal((block.querySelector('.routing-keytest-btn') as any).disabled, false);

      dispatch({ type: 'vendorKeyTestResult', payload: { vendor: 'xai', state: 'ok', message: 'Connection works.' } });
      await flush();
      assert.ok(block.querySelector('.routing-keytest-result').classList.contains('routing-keytest-result--ok'));
      assertNoErrors('after test results');

      assert.ok(!JSON.stringify(posted).includes(SECRET), 'no key value in any posted message');
    } finally {
      win.close();
    }
  });
}

test('slot editor on claude-code: sign-in vendor says no key needed; Antigravity keeps an optional Gemini key row', async () => {
  const google = agent('gem', { vendor: 'google', transport: 'mcp', mcpServer: 'gemini', model: 'google/gemini-2.5-pro', costModelClass: 'metered' });
  const { win, doc } = await render('claude-code', [google]);
  try {
    const block = doc.querySelector('.routing-vendor-keys[data-vendor-key-spec="google"]') as any;
    assert.ok(block);
    assert.match(block.querySelector('.routing-signin-note').textContent, /Uses your Antigravity sign-in .* no key needed/);
    assert.deepEqual(Array.from(block.querySelectorAll('.routing-env-fixed-name')).map((e: any) => e.textContent), ['GEMINI_API_KEY']);
    assert.match(block.textContent, /Gemini CLI backend only/);
    assert.equal(inputsIn(doc).length, 0);
  } finally {
    win.close();
  }
});

test('slot editor on claude-code: sign-in vendor with no test and no rows shows only the note', async () => {
  const openai = agent('cx', { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'openai/gpt-5.6-sol', costModelClass: 'subscription' });
  const { win, doc } = await render('claude-code', [openai]);
  try {
    const block = doc.querySelector('.routing-vendor-keys[data-vendor-key-spec="openai"]') as any;
    assert.ok(block);
    assert.match(block.textContent, /Uses your Codex sign-in/);
    assert.equal(block.querySelectorAll('.routing-env-field').length, 0);
    assert.equal(block.querySelector('.routing-keytest-btn'), null, 'no Test button without a cheap real call');
  } finally {
    win.close();
  }
});

test('slot editor on opencode: free-form env name inputs stay', async () => {
  const { win, doc } = await render('opencode', [XAI_AGENT]);
  try {
    assert.equal(doc.querySelectorAll('.routing-vendor-keys').length, 0);
    const inputs = inputsIn(doc);
    assert.deepEqual(inputs.map((i) => i.value), ['MY_CUSTOM_URL', 'MY_CUSTOM_KEY']);
  } finally {
    win.close();
  }
});

test('slot editor on claude-code: Custom endpoint vendor keeps the free-form name inputs', async () => {
  const custom = agent('loc', { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'llama3', costModelClass: 'local', endpointEnv: 'OLLAMA_URL', apiKeyEnv: 'OLLAMA_KEY' });
  const { win, doc } = await render('claude-code', [custom]);
  try {
    assert.equal(doc.querySelectorAll('.routing-vendor-keys').length, 0);
    const inputs = inputsIn(doc);
    assert.deepEqual(inputs.map((i) => i.value), ['OLLAMA_URL', 'OLLAMA_KEY']);
  } finally {
    win.close();
  }
});
