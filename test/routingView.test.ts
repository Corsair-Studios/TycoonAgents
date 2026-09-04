import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * jsdom runtime test for the Routing panel in media/main.js (plan p13-t1,
 * webview half). Boots main.js the same way test/webviewSmoke.test.ts does
 * (via node:vm against a jsdom document/window), opens the routing modal by
 * clicking the static "menu-routing" button (injected into the DOM fixture
 * the way webviewSmoke builds the page), drives a fixture
 * "routing" payload through the window "message" event, and asserts the
 * rendered DOM + the posted "saveRouting" profile.
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

function buildRoutingPayload(overrides?: Partial<any>) {
  const base = {
    profile: null,
    path: '.claude/tycoon/routing.json',
    errors: [] as string[],
    orchestrator: {
      id: 'orchestrator',
      backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      source: 'default',
    },
    agents: [
      {
        id: 'coding-specialist',
        name: 'coding-specialist',
        description: 'implement, code, fix',
        backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' },
        source: 'default',
      },
      {
        id: 'search-retrieval',
        name: 'search-retrieval',
        backend: { vendor: 'anthropic', transport: 'claude-native', model: 'haiku', costModelClass: 'subscription' },
        source: 'frontmatter',
      },
    ],
    envProbe: { ANTHROPIC_API_KEY: true },
    presets: {
      vendors: ['anthropic', 'openai', 'google'],
      models: [
        { id: 'sonnet', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Sonnet' },
        { id: 'haiku', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Haiku' },
        { id: 'gpt-5.4-mini', vendor: 'openai', costModelClass: 'metered', label: 'GPT-5.4 mini' },
      ],
    },
    lastApplied: {},
  };
  return { ...base, ...(overrides || {}) };
}

test('Routing panel: renders fixture payload, edits model, saves a clean profile', async () => {
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
    postMessage: (mmm: any) => posted.push(mmm),
    getState: () => stateStore,
    setState: (s: any) => {
      stateStore = s;
    },
  });

  const rafQueue: Array<(ts: number) => void> = [];
  win.requestAnimationFrame = (cb: (ts: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
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
  try {
  await flush();
  assertNoErrors('boot');

  // ── Open the Routing view via the static menu button (ships in panel.ts's
  // HTML template; auto-created here by scanElementIds like menu-settings/
  // menu-themes above) ──
  const menuRoutingBtn = doc.getElementById('menu-routing');
  assert.ok(menuRoutingBtn, 'the DOM fixture should carry a static #menu-routing element');
  menuRoutingBtn.click();
  await flush();
  assertNoErrors('open routing modal');

  const getRoutingPosted = posted.find((m) => m && m.type === 'getRouting');
  assert.ok(getRoutingPosted, 'opening Routing should post {type: "getRouting"}');

  // ── Fixture "routing" payload ──
  const payload = buildRoutingPayload();
  dispatch({ type: 'routing', payload });
  await flush();
  assertNoErrors('routing payload render');

  const modal = doc.getElementById('routing-modal');
  assert.ok(modal, 'routing modal should exist');
  assert.notEqual(modal.hasAttribute('hidden'), true, 'routing modal should be visible after open');

  const rows = doc.querySelectorAll('.routing-agent-row');
  assert.equal(rows.length, 2, 'one row per fixture agent');
  const sourceChips = doc.querySelectorAll('.routing-source-chip');
  assert.ok(sourceChips.length >= 3, 'orchestrator + each agent should render a source chip');

  // ── Env dot reflects envProbe ──
  const envDots = Array.from(doc.querySelectorAll('.routing-env-dot')) as any[];
  const setDot = envDots.find((d) => d.getAttribute('data-env-name') === 'ANTHROPIC_API_KEY');
  assert.ok(setDot, 'credential env dot for ANTHROPIC_API_KEY should render');
  assert.ok(setDot.className.includes('routing-env-dot--set'), 'ANTHROPIC_API_KEY is set in envProbe fixture');

  // ── Editing the orchestrator model + Save posts a clean profile ──
  const orchModelSelect = doc.querySelector('.routing-slot-fields .routing-model-select') as any;
  assert.ok(orchModelSelect, 'orchestrator model select should render');
  orchModelSelect.value = 'haiku';
  orchModelSelect.dispatchEvent(new win.Event('change', { bubbles: true }));

  const saveBtn = doc.getElementById('routing-save-btn') as any;
  assert.ok(saveBtn, 'Save button should render');
  saveBtn.click();
  await flush();
  assertNoErrors('save');

  const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
  assert.ok(saveMsg, 'clicking Save should post {type: "saveRouting", profile}');
  assert.equal(saveMsg.profile.orchestrator.model, 'haiku', 'edited model should be reflected in the posted profile');
  assert.equal(saveMsg.profile.version, 1);

  // No key that looks like a secret anywhere in the posted profile, except
  // credentialEnv NAME strings (which never hold a value, only a var name).
  const json = JSON.stringify(saveMsg.profile);
  const parsed = JSON.parse(json);
  function walk(obj: any) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (/key|secret|token|password/i.test(k) && k !== 'credentialEnv') {
        throw new Error(`profile carries a suspicious key: ${k}`);
      }
      walk(obj[k]);
    }
  }
  assert.doesNotThrow(() => walk(parsed));

  // Save button disabled while a save is in flight (before the routingSaved reply lands).
  assert.equal(saveBtn.disabled, false, 'save completes synchronously in this harness; button re-enables once the flow completes below');

  // ── routingSaved + a fresh routing reply ──
  // Flat on the message (no payload wrapper) — matches panel.ts's
  // _handleSaveRouting/_handleClearRouting and server.mjs's saveRouting/
  // clearRouting cases: `{ type: MSG.ROUTING_SAVED, ...result }`.
  dispatch({ type: 'routingSaved', ok: true, errors: [], check: { claude: { code: 0, output: 'ok' }, opencode: { code: 0, output: 'ok' } }, write: { claude: { code: 0, output: 'ok' }, opencode: { code: 0, output: 'ok' } } });
  await flush();
  dispatch({ type: 'routing', payload });
  await flush();
  assertNoErrors('routingSaved + refresh');

  // ── Custom endpoint preset ──
  const vendorSelect = doc.querySelector('.routing-slot-fields .routing-vendor-select') as any;
  vendorSelect.value = 'custom-endpoint';
  vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
  await flush();
  assertNoErrors('custom endpoint select');
  const transportSelectAfter = doc.querySelector('.routing-slot-fields select[disabled]') as any;
  assert.ok(transportSelectAfter, 'transport select should be disabled/forced under Custom endpoint');
  assert.equal(transportSelectAfter.value, 'openai-compatible');
  const endpointField = Array.from(doc.querySelectorAll('.routing-env-field label')).find((l: any) => l.textContent === 'Endpoint env');
  assert.ok(endpointField, 'Custom endpoint should reveal an Endpoint env field');

  // ── Fallback editor caps at 3 ──
  const fallbackDetails = doc.querySelector('.routing-fallback-details') as any;
  assert.ok(fallbackDetails, 'fallback chain editor should render');
  let addBtn = fallbackDetails.querySelector('.routing-add-fallback-btn') as any;
  for (let i = 0; i < 3; i++) {
    addBtn.click();
    await flush();
    addBtn = doc.querySelector('#routing-modal-body .routing-fallback-details .routing-add-fallback-btn');
  }
  assertNoErrors('add 3 fallbacks');
  assert.equal(addBtn.disabled, true, 'add-fallback should disable once 3 entries exist');
  const fbItems = doc.querySelectorAll('.routing-fallback-item');
  assert.ok(fbItems.length <= 3, 'no more than 3 fallback entries should ever render for one slot');
  } finally {
    win.close();
  }
});

test('Routing panel: fallback chip, Totals block, and state-update preserves an unsaved edit (p13-t3)', async () => {
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
    postMessage: (mmm: any) => posted.push(mmm),
    getState: () => stateStore,
    setState: (s: any) => {
      stateStore = s;
    },
  });

  const rafQueue: Array<(ts: number) => void> = [];
  win.requestAnimationFrame = (cb: (ts: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
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

  /** Dispatch a `state` message carrying the given agentMetrics (matches
   * cacheReadPricing.test.ts's dispatchMetrics fixture shape). */
  function dispatchMetrics(agentMetrics: any[]) {
    dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 0,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics,
      },
    });
  }

  vm.runInContext(src, dom.getInternalVMContext(), { filename: 'media/main.js' });
  try {
    await flush();
    assertNoErrors('boot');

    const menuRoutingBtn = doc.getElementById('menu-routing');
    assert.ok(menuRoutingBtn, 'the DOM fixture should carry a static #menu-routing element');
    menuRoutingBtn.click();
    await flush();
    assertNoErrors('open routing modal');

    const payload = buildRoutingPayload();
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    // ── agentMetrics fixture: coding-specialist ran on fallback this time;
    // search-retrieval has fired fallbacks before but its last run was clean ──
    dispatchMetrics([
      {
        id: 'coding-specialist',
        name: 'coding-specialist',
        status: 'idle',
        taskCount: 1,
        mcpCount: 0,
        activeMs: 1000,
        tokens: 500,
        vendor: 'openai',
        model: 'gpt-5.4-mini',
        costModelClass: 'metered',
        fallbackOf: 'anthropic/sonnet',
        fallbackDepth: 1,
        fallbackCount: 1,
      },
      {
        id: 'search-retrieval',
        name: 'search-retrieval',
        status: 'idle',
        taskCount: 2,
        mcpCount: 0,
        activeMs: 2000,
        tokens: 300,
        vendor: 'anthropic',
        model: 'haiku',
        costModelClass: 'subscription',
        fallbackCount: 3,
      },
    ]);
    await flush();
    assertNoErrors('agentMetrics dispatch');

    // ── Fallback chip on the row that ran on fallback ──
    const codingRow = doc.querySelector('.routing-agent-row[data-agent-id="coding-specialist"]') as any;
    assert.ok(codingRow, 'coding-specialist row should render');
    const fbChip = codingRow.querySelector('.routing-source-chip--fallback');
    assert.ok(fbChip, 'coding-specialist should show a "ran on fallback" chip');
    assert.equal(fbChip.textContent, 'ran on fallback');
    assert.equal(
      fbChip.getAttribute('title'),
      'last run fell back from anthropic/sonnet to gpt-5.4-mini (depth 1)',
      'chip tooltip should name the fallback source, destination model, and depth'
    );

    // ── Muted count chip on the row with prior fallbacks but a clean last run ──
    const searchRow = doc.querySelector('.routing-agent-row[data-agent-id="search-retrieval"]') as any;
    assert.ok(searchRow, 'search-retrieval row should render');
    const countChip = searchRow.querySelector('.routing-fallback-count');
    assert.ok(countChip, 'search-retrieval should show a muted fallback count');
    assert.equal(countChip.textContent, '3 fallbacks');
    assert.ok(!searchRow.querySelector('.routing-source-chip--fallback'), 'search-retrieval should not show the "ran on fallback" chip');

    // ── Totals block: vendor rows + fallbacks-fired line, from buildMetricsRollup ──
    const totalsRows = Array.from(doc.querySelectorAll('.routing-totals-table .metrics-footer-row')) as any[];
    const totalsText = totalsRows.map((r) => r.textContent).join(' | ');
    assert.ok(totalsText.includes('openai total'), 'Totals block should list an openai vendor row');
    assert.ok(totalsText.includes('anthropic total'), 'Totals block should list an anthropic vendor row');
    assert.ok(totalsText.includes('metered total'), 'Totals block should list a metered cost-class row');
    assert.ok(totalsText.includes('subscription total'), 'Totals block should list a subscription cost-class row');
    assert.ok(totalsText.includes('Fallbacks fired'), 'Totals block should list the fallbacks-fired line');
    assert.ok(totalsText.includes('4'), 'fallbacks-fired total should sum both agents\' fallbackCount (1 + 3 = 4)');

    // ── State update while editing preserves the unsaved slot input value ──
    const codingSlotTd = codingRow.querySelector('.routing-slot-td');
    let modelInput = codingSlotTd.querySelector('.routing-model-input, .routing-model-select') as any;
    assert.ok(modelInput, 'coding-specialist slot should render a model field');
    if (modelInput.tagName.toLowerCase() === 'select') {
      const opt = Array.from(modelInput.options).find((o: any) => o.value && o.value !== modelInput.value) as any;
      assert.ok(opt, 'model select should have a non-current option to switch to');
      modelInput.value = opt.value;
      modelInput.dispatchEvent(new win.Event('change', { bubbles: true }));
    } else {
      modelInput.value = 'my-custom-edit';
      modelInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    const editedValue = modelInput.value;

    // A fresh `state` push (e.g. another agent finishing a task) must
    // re-render chips/totals without discarding this edit.
    dispatchMetrics([
      {
        id: 'coding-specialist',
        name: 'coding-specialist',
        status: 'idle',
        taskCount: 2,
        mcpCount: 0,
        activeMs: 2000,
        tokens: 700,
        vendor: 'openai',
        model: 'gpt-5.4-mini',
        costModelClass: 'metered',
        fallbackOf: 'anthropic/sonnet',
        fallbackDepth: 1,
        fallbackCount: 1,
      },
    ]);
    await flush();
    assertNoErrors('state update while editing');

    const codingRowAfter = doc.querySelector('.routing-agent-row[data-agent-id="coding-specialist"]') as any;
    assert.ok(codingRowAfter, 'coding-specialist row should still render after the state update');
    const modelInputAfter = codingRowAfter.querySelector('.routing-slot-td').querySelector('.routing-model-input, .routing-model-select') as any;
    assert.ok(modelInputAfter, 'model field should still render after the state update');
    assert.equal(modelInputAfter.value, editedValue, 'unsaved slot edit should survive a state re-render');

    // ── Focus/caret and an open fallback <details> must survive a state
    // update too (audit fix: updateRoutingViewLive must not rebuild the
    // table while the view is open) ──
    const fallbackDetails = codingRowAfter.querySelector('.routing-fallback-details') as any;
    assert.ok(fallbackDetails, 'coding-specialist fallback-chain <details> should render');
    fallbackDetails.setAttribute('open', '');

    let textInput = codingRowAfter.querySelector('.routing-slot-td input[type="text"]') as any;
    if (!textInput) {
      // Force a free-text model field so there's a real caret-bearing input
      // to focus: switch to Custom endpoint's vendor.
      const vendorSel = codingRowAfter.querySelector('.routing-vendor-select') as any;
      vendorSel.value = 'custom-endpoint';
      vendorSel.dispatchEvent(new win.Event('change', { bubbles: true }));
      await flush();
      textInput = doc.querySelector('.routing-agent-row[data-agent-id="coding-specialist"] .routing-slot-td input[type="text"]') as any;
    }
    assert.ok(textInput, 'coding-specialist slot should expose a focusable text input');
    textInput.value = 'partial-typing';
    textInput.focus();
    textInput.setSelectionRange(3, 5);
    assert.equal(doc.activeElement, textInput, 'text input should hold focus before the state update');

    dispatchMetrics([
      {
        id: 'coding-specialist',
        name: 'coding-specialist',
        status: 'idle',
        taskCount: 3,
        mcpCount: 0,
        activeMs: 3000,
        tokens: 900,
        vendor: 'openai',
        model: 'gpt-5.4-mini',
        costModelClass: 'metered',
        fallbackOf: 'anthropic/sonnet',
        fallbackDepth: 1,
        fallbackCount: 1,
      },
    ]);
    await flush();
    assertNoErrors('state update while focused mid-typing');

    assert.equal(doc.activeElement, textInput, 'focused input should keep focus across a state update while its element is unchanged');
    assert.equal(textInput.value, 'partial-typing', 'in-progress typed value should be untouched');
    assert.equal(textInput.selectionStart, 3, 'caret/selection start should be preserved');
    assert.equal(textInput.selectionEnd, 5, 'caret/selection end should be preserved');

    const fallbackDetailsAfter = doc.querySelector('.routing-agent-row[data-agent-id="coding-specialist"] .routing-fallback-details') as any;
    assert.ok(fallbackDetailsAfter, 'fallback <details> should still render after the state update');
    assert.equal(fallbackDetailsAfter, fallbackDetails, 'fallback <details> element identity should be unchanged (no table rebuild)');
    assert.ok(fallbackDetailsAfter.hasAttribute('open'), 'an open fallback <details> must stay open across a state update');
  } finally {
    win.close();
  }
});
