import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * jsdom smoke test for Multi-LLM in Agents: the Agents modal shows "Add an agent from another
 * provider" in multi mode on Claude Code, hides it in single mode and on OpenCode; the Packs list
 * has no Multi-LLM row; panel getPacks filters the hidden bridge catalog entry.
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


const PICKER = {
  type: 'providerAgents',
  packId: 'multi-llm',
  picker: {
    models: [
      { agentId: 'codex-reviewer', label: 'Codex Reviewer (OpenAI)', installed: false, setup: { server: 'codex', serverState: 'missing', keyState: 'signin', env: [], needsSetup: true, reasons: [] } },
      { agentId: 'gemini-reviewer', label: 'Gemini Reviewer (Google)', installed: true, setup: { server: 'gemini', serverState: 'installed', keyState: 'ok', env: [], needsSetup: false, reasons: [] } },
    ],
    others: [],
    dispatcherHost: false,
    endpointNameHint: 'OLLAMA_BASE_URL',
  },
};

function routingPayload(uiMode: 'single' | 'multi') {
  return {
    profile: null,
    path: '.claude/tycoon/routing.json',
    errors: [] as string[],
    uiMode,
    harness: 'claude-code',
    multiProviderSetting: uiMode === 'multi',
    multiProviderCheckboxVisible: true,
    singleProvider: { vendor: 'anthropic', tiers: [{ id: 'sonnet', label: 'Sonnet', model: 'sonnet' }] },
    orchestrator: { id: 'orchestrator', backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' }, source: 'default' },
    agents: [
      { id: 'coding-specialist', name: 'coding-specialist', model: 'sonnet', description: 'implement, code', backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' }, source: 'default' },
    ],
    envProbe: {},
    presets: { vendors: ['anthropic', 'openai'], models: [{ id: 'sonnet', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Sonnet' }] },
    lastApplied: {},
  };
}

async function openAgents(uiMode: 'single' | 'multi', harness: string) {
  const h = await bootMain();
  (h.doc.getElementById('menu-routing') as any).click();
  await h.flush();
  h.dispatch({ type: 'settings', payload: { harness: { effective: harness } } });
  h.dispatch(PICKER);
  h.dispatch({ type: 'routing', payload: routingPayload(uiMode) });
  await h.flush();
  h.assertNoErrors('agents render ' + uiMode + '/' + harness);
  return h;
}

test('Agents modal (multi mode, Claude Code) shows "Add an agent from another provider"', async () => {
  const h = await openAgents('multi', 'claude-code');
  try {
    const section = h.doc.querySelector('[data-provider-agents]');
    assert.ok(section, 'provider agents section present');
    assert.ok((section!.textContent || '').includes('Add an agent from another provider'));
    const toggle = h.doc.querySelector('[data-provider-agents-toggle]') as any;
    assert.ok(toggle, 'toggle button present');
    toggle.click();
    await h.flush();
    assert.ok(h.doc.querySelector('[data-bridge-picker="multi-llm"]'), 'picker opens');
    assert.ok(h.doc.querySelector('[data-bridge-agent="codex-reviewer"]'), 'codex row listed');
    assert.ok(h.doc.querySelector('[data-bridge-install="multi-llm"]'), 'Add selected button listed');
  } finally {
    h.win.close();
  }
});

test('Agents modal hides the provider section in single mode', async () => {
  const h = await openAgents('single', 'claude-code');
  try {
    assert.equal(h.doc.querySelector('[data-provider-agents]'), null);
    assert.ok(!(h.doc.body.textContent || '').includes('Add an agent from another provider'));
  } finally {
    h.win.close();
  }
});

test('Agents modal hides the provider section on OpenCode (even in multi mode)', async () => {
  const h = await openAgents('multi', 'opencode');
  try {
    assert.equal(h.doc.querySelector('[data-provider-agents]'), null);
    assert.ok(!(h.doc.body.textContent || '').includes('Add an agent from another provider'));
  } finally {
    h.win.close();
  }
});

test('Packs list renders no Multi-LLM row for the host-filtered catalog', async () => {
  const h = await bootMain();
  try {
    const catalog: any[] = JSON.parse(readFileSync(join(process.cwd(), 'media', 'packs', 'catalog.json'), 'utf8'));
    const visible = catalog.filter((p) => !(p && p.hidden === true));
    assert.ok(catalog.some((p) => p.id === 'multi-llm' && p.hidden === true), 'catalog keeps multi-llm hidden');
    const packs = visible.map((p) => ({
      id: p.id, name: p.name, description: p.description, summary: p.summary || 's',
      has: { skill: false, mcp: !!p.mcp, agent: Array.isArray(p.agents) && p.agents.length > 0 },
      installed: { skill: false, mcp: false, agent: false },
      skills: [], commands: [], agents: (p.agents || []).map((a: any) => ({ id: a.id, name: a.name || a.id })), disclosures: [], thirdParty: false,
    }));
    h.dispatch({ type: 'packs', packs });
    await h.flush();
    const list = h.doc.getElementById('packs-list');
    assert.ok(list && list.children.length > 0, 'packs rendered');
    assert.equal(list!.querySelector('[data-pack-id="multi-llm"]'), null);
    assert.equal(list!.querySelector('[data-remove-pack-id="multi-llm"]'), null);
    assert.ok(!/Multi-LLM/i.test(list!.textContent || ''), 'no Multi-LLM text in the Packs list');
  } finally {
    h.win.close();
  }
});

test('panel _handleGetPacks and standalone buildPacksPayload filter hidden catalog entries', () => {
  const panel = readFileSync(join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts'), 'utf8');
  const server = readFileSync(join(process.cwd(), 'standalone', 'src', 'server.mjs'), 'utf8');
  assert.match(panel, /\.filter\(\(p\) => !\(p && p\.hidden === true\)\)/);
  assert.match(server, /\.filter\(\(p\) => !\(p && p\.hidden === true\)\)/);
});
