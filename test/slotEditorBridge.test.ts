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

// p101-t2/t4/t5/t6: webview behaviour for the Gemini backend control, the
// derived connection line, Billing label, Codex model list, the read-only
// "Set outside the panel" box and the fallback chain host notes / MCP server
// warnings.

function agent(id: string, backend: any) {
  return { id, name: id, description: id, backend, source: 'routing', provenance: 'routing', routeSource: 'routing' };
}

function bridge(over: any = {}) {
  return {
    mcpJsonPresent: true,
    mcpServers: ['codex', 'gemini', 'tycoon'],
    gemini: { serverPresent: true, value: 'agy', source: 'default' },
    externalSettings: [
      { name: 'TYCOON_BRIDGE_TIMEOUT_MS', value: '180000', source: 'default', note: 'Shared bridge timeout.', where: 'Edit mcpServers.gemini.env in .mcp.json.' },
      { name: 'CODEX_MCP_TIMEOUT_MS', value: '900000', source: 'mcp-json', server: 'codex', note: 'Codex per-call timeout.', where: 'Edit mcpServers.codex.env in .mcp.json.' },
      { name: 'TYCOON_AGY_PATH', value: 'C:/tools/agy.exe', source: 'environment', note: 'agy location.', where: 'Set the user env var.' },
    ],
    ...over,
  };
}

function payload(agents: any[], harness: string, br: any = bridge()) {
  return {
    profile: null,
    path: '.claude/tycoon/routing.json',
    errors: [] as string[],
    uiMode: 'multi',
    harness,
    multiProviderCheckboxVisible: true,
    multiProviderSetting: true,
    orchestrator: { id: 'orchestrator', backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' }, source: 'default' },
    agents,
    envProbe: {},
    bridge: br,
    presets: {
      vendors: ['anthropic', 'openai', 'google'],
      models: [
        { id: 'google/gemini-2.5-pro', vendor: 'google', costModelClass: 'metered', label: 'google/gemini-2.5-pro' },
        { id: 'openai/gpt-5.6-sol', vendor: 'openai', costModelClass: 'subscription', label: 'Sol (openai/gpt-5.6-sol)' },
        { id: 'openai/gpt-6-astra', vendor: 'openai', costModelClass: 'subscription', label: 'Astra (openai/gpt-6-astra)' },
      ],
      vendorKeys: [
        { id: 'google', label: 'Google', vendors: ['google'], auth: 'signin', signIn: 'Antigravity', test: null,
          rows: [{ env: 'GEMINI_API_KEY', kind: 'credential', label: 'Gemini API key', required: false }] },
      ],
    },
    lastApplied: {},
  };
}

async function render(harness: string, agents: any[], br?: any) {
  const ctx = await bootMain();
  (ctx.doc.getElementById('menu-routing') as any).click();
  await ctx.flush();
  ctx.dispatch({ type: 'settings', payload: { harness: { effective: harness } } });
  await ctx.flush();
  ctx.dispatch({ type: 'routing', payload: payload(agents, harness, br) });
  await ctx.flush();
  ctx.assertNoErrors('routing render');
  return ctx;
}

function cardOf(doc: any, id: string): any {
  return doc.querySelector('.routing-agent-card[data-agent-id="' + id + '"]');
}

const GEMINI_AGENT = agent('gem', { vendor: 'google', transport: 'mcp', mcpServer: 'gemini', model: 'google/gemini-2.5-pro', costModelClass: 'metered' });

test('gemini slot on agy: model is read-only Antigravity text, key row hidden, backend select shows Antigravity', async () => {
  const { win, doc } = await render('claude-code', [GEMINI_AGENT]);
  try {
    const ro = cardOf(doc, 'gem').querySelector('.routing-model-readonly') as any;
    assert.ok(ro, 'read-only model line');
    assert.equal(ro.textContent, 'Gemini 3.5 Flash \u2014 set by Antigravity');
    assert.equal(cardOf(doc, 'gem').querySelector('.routing-model-select'), null, 'no model picker on agy');
    assert.equal(doc.querySelector('.routing-vendor-keys[data-vendor-key-spec="google"]'), null, 'no key row on agy');
    const sel = doc.querySelector('[data-field-key="gemini.backend"]') as any;
    assert.equal(sel.value, 'agy');
    assert.match(doc.querySelector('.routing-gemini-backend-note').textContent, /reload MCP servers/);
  } finally {
    win.close();
  }
});

test('gemini slot on the Gemini CLI backend: real gemini-* picker and GEMINI_API_KEY row', async () => {
  const br = bridge({ gemini: { serverPresent: true, value: 'gemini', source: 'mcp-json' } });
  const { win, doc } = await render('claude-code', [GEMINI_AGENT], br);
  try {
    assert.equal(cardOf(doc, 'gem').querySelector('.routing-model-readonly'), null);
    const picker = cardOf(doc, 'gem').querySelector('.routing-model-select') as any;
    assert.ok(picker, 'model picker');
    const values = Array.from(picker.options).map((o: any) => o.value);
    assert.ok(values.includes('google/gemini-2.5-pro'));
    assert.ok(!values.some((v: string) => v && v !== '__custom__' && !/gemini-/.test(v)), 'only gemini-* options');
    assert.ok(doc.querySelector('.routing-vendor-keys[data-vendor-key-spec="google"] [data-env-name="GEMINI_API_KEY"]'));
    assert.equal((doc.querySelector('[data-field-key="gemini.backend"]') as any).value, 'gemini');
  } finally {
    win.close();
  }
});

test('changing the Gemini backend posts only { type, value }; control is disabled with no gemini server', async () => {
  const { win, doc, posted, flush } = await render('claude-code', [GEMINI_AGENT]);
  try {
    const sel = doc.querySelector('[data-field-key="gemini.backend"]') as any;
    sel.value = 'gemini';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    const msg = posted.filter((m) => m && m.type === 'setGeminiBackend').pop();
    assert.deepEqual(JSON.parse(JSON.stringify(msg)), { type: 'setGeminiBackend', value: 'gemini' });
  } finally {
    win.close();
  }
  const noServer = await render('claude-code', [GEMINI_AGENT], bridge({ mcpServers: ['codex'], gemini: { serverPresent: false, value: 'agy', source: 'default' } }));
  try {
    assert.equal((noServer.doc.querySelector('[data-field-key="gemini.backend"]') as any).disabled, true);
    assert.match(noServer.doc.querySelector('.routing-gemini-backend-note').textContent, /No "gemini" server in \.mcp\.json/);
  } finally {
    noServer.win.close();
  }
});

for (const harness of ['claude-code', 'codex']) {
  test('slot editor on ' + harness + ': transport is a derived read-only line, Billing label replaces Cost class', async () => {
    const { win, doc } = await render(harness, [GEMINI_AGENT]);
    try {
      const card = cardOf(doc, 'gem');
      assert.equal(card.querySelector('[data-field-key$=".transport"]'), null, 'no Transport select');
      assert.equal(card.querySelector('.routing-connection-line').textContent, 'Connection: via gemini bridge');
      const labels = Array.from(card.querySelectorAll('.routing-field-row label')).map((l: any) => l.textContent);
      assert.ok(labels.includes('Billing label'));
      assert.ok(!labels.includes('Cost class'));
      assert.ok(!labels.includes('Transport'));
      assert.match(card.querySelector('.routing-billing-hint').textContent, /Informational; on OpenCode it also controls the Claude subscription lock/);
    } finally {
      win.close();
    }
  });
}

test('typing an MCP server name derives the connection line and transport; clearing returns to native', async () => {
  const plain = agent('plain', { vendor: 'xai', transport: 'claude-native', model: 'xai/grok-4.7', costModelClass: 'metered' });
  const { win, doc, flush } = await render('claude-code', [plain]);
  try {
    const line = () => (cardOf(doc, 'plain').querySelector('.routing-connection-line') as any).textContent;
    assert.equal(line(), 'Connection: native xai (no bridge)');
    const input = cardOf(doc, 'plain').querySelector('[data-field-key$=".mcpServer"]') as any;
    assert.ok(input, 'MCP server field is editable on this host');
    input.value = 'codex';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();
    assert.equal(line(), 'Connection: via codex bridge');
    input.value = '';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();
    assert.equal(line(), 'Connection: native xai (no bridge)');
  } finally {
    win.close();
  }
});

test('opencode keeps the editable Transport select', async () => {
  const { win, doc } = await render('opencode', [GEMINI_AGENT]);
  try {
    assert.ok(cardOf(doc, 'gem').querySelector('[data-field-key$=".transport"]'), 'Transport select stays on OpenCode');
    assert.equal(cardOf(doc, 'gem').querySelector('.routing-connection-line'), null);
  } finally {
    win.close();
  }
});

test('codex model picker offers Sol and Astra plus Custom...', async () => {
  const cx = agent('cx', { vendor: 'openai', transport: 'claude-native', model: 'openai/gpt-5.6-sol', costModelClass: 'subscription' });
  const { win, doc } = await render('claude-code', [cx]);
  try {
    const picker = cardOf(doc, 'cx').querySelector('.routing-model-select') as any;
    const values = Array.from(picker.options).map((o: any) => o.value);
    assert.ok(values.includes('openai/gpt-5.6-sol') && values.includes('openai/gpt-6-astra') && values.includes('__custom__'), values.join(','));
  } finally {
    win.close();
  }
});

test('"Set outside the panel" box lists value + source, collapsed, read-only', async () => {
  const { win, doc } = await render('claude-code', [GEMINI_AGENT]);
  try {
    const box = doc.querySelector('details.routing-external-settings') as any;
    assert.ok(box, 'box rendered');
    assert.equal(box.open, false, 'collapsed by default');
    assert.match(box.querySelector('summary').textContent, /Set outside the panel \(3\)/);
    const rows = Array.from(box.querySelectorAll('.routing-external-row')) as any[];
    assert.deepEqual(rows.map((r) => r.getAttribute('data-env-name')), ['TYCOON_BRIDGE_TIMEOUT_MS', 'CODEX_MCP_TIMEOUT_MS', 'TYCOON_AGY_PATH']);
    assert.match(rows[0].textContent, /180000.*default/);
    assert.match(rows[1].textContent, /900000.*\.mcp\.json codex env/);
    assert.match(rows[2].textContent, /VS Code environment \(MCP servers usually inherit it\)/);
    assert.equal(box.querySelectorAll('input, select, button').length, 0, 'read-only: no controls');
  } finally {
    win.close();
  }
});

async function addFallback(ctx: any, agentId: string, vendor: string, mcp?: string) {
  const card = ctx.doc.querySelector('.routing-agent-card[data-agent-id="' + agentId + '"]');
  const checkbox = card.querySelector('.agent-provider-checkbox');
  if (checkbox && !checkbox.checked) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    await ctx.flush();
  }
  const details = ctx.doc.querySelector('.routing-fallback-details[data-agent-id="' + agentId + '"]');
  details.querySelector('.routing-add-fallback-btn').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true }));
  await ctx.flush();
  const vsel = ctx.doc.querySelector('[data-field-key="agent:' + agentId + '.fallback[0].vendor"]');
  vsel.value = vendor;
  vsel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  await ctx.flush();
  if (mcp) {
    const input = ctx.doc.querySelector('[data-field-key="agent:' + agentId + '.fallback[0].mcpServer"]');
    input.value = mcp;
    input.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    await ctx.flush();
  }
}

const BASE_AGENT = agent('worker', { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'metered' });

test('fallback chain host notes per harness', async () => {
  const expected: Record<string, RegExp> = {
    'claude-code': /^Full fallback \(dispatcher \+ hook\)$/,
    opencode: /^Best-effort: switches model string$/,
    codex: /only vendors with a dispatcher adapter/,
  };
  for (const harness of Object.keys(expected)) {
    const ctx = await render(harness, [BASE_AGENT]);
    try {
      const card = ctx.doc.querySelector('.routing-agent-card[data-agent-id="worker"]') as any;
      const cb = card.querySelector('.agent-provider-checkbox');
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
        await ctx.flush();
      }
      const note = ctx.doc.querySelector('.routing-fallback-details[data-agent-id="worker"] .routing-fallback-host-note') as any;
      assert.ok(note, harness + ' has a host note');
      assert.match(note.textContent, expected[harness]);
    } finally {
      ctx.win.close();
    }
  }
});

test('codex host shows a non-blocking skip warning for a Google fallback', async () => {
  const ctx = await render('codex', [BASE_AGENT]);
  try {
    ctx.dispatch({ type: 'envProbe', payload: { GEMINI_API_KEY: { env: true, stored: false } } });
    await addFallback(ctx, 'worker', 'google');
    const warning = ctx.doc.querySelector('.routing-fallback-dispatch-warning') as any;
    assert.ok(warning, 'warning present');
    assert.match(warning.textContent, /Google fallbacks are skipped on the Codex host; the chain moves to the next entry/);
    assert.equal((ctx.doc.getElementById('routing-save-btn') as any).disabled, false, 'never blocks save');
  } finally {
    ctx.win.close();
  }
});

test('a fallback whose mcpServer is missing from .mcp.json shows a warning naming the server', async () => {
  const ctx = await render('claude-code', [BASE_AGENT]);
  try {
    await addFallback(ctx, 'worker', 'openai', 'nonexistent-bridge');
    const warn = ctx.doc.querySelector('.routing-fallback-item .routing-mcp-server-warning') as any;
    assert.ok(warn, 'warning rendered');
    assert.match(warn.textContent, /"nonexistent-bridge" is not in \.mcp\.json/);
  } finally {
    ctx.win.close();
  }
  const ok = await render('claude-code', [BASE_AGENT]);
  try {
    await addFallback(ok, 'worker', 'openai', 'codex');
    assert.equal(ok.doc.querySelector('.routing-mcp-server-warning'), null, 'present server: no warning');
  } finally {
    ok.win.close();
  }
});
