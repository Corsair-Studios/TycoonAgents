import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoutingView } from '../src/core/routingHostOps';

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

/**
 * p31-t2: the "Default fallback" section now renders above Orchestrator
 * (docs/design/slot-editor-redesign.md), so a bare `.routing-slot-fields`
 * (or `.routing-vendor-select`/`.routing-model-select`/etc.) query no
 * longer reliably hits the orchestrator's own fields — it may hit the
 * Default fallback slot's instead. Scope to the section whose <h2> reads
 * "Orchestrator" (buildSection) rather than relying on document order.
 */
function orchestratorSection(doc: any) {
  const heading = Array.from(doc.querySelectorAll('h2.settings-heading')).find(
    (h: any) => h.textContent === 'Orchestrator'
  ) as any;
  const section = heading && heading.closest('section');
  if (!section) throw new Error('Orchestrator section (h2.settings-heading) not found');
  return section;
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

  // p20-t2: full density is now keyed on harness.effective === 'opencode',
  // not the old routing.visible toggle -- these fixtures exercise the full
  // (OpenCode) editable routing table, so declare that harness.
  dispatch({ type: 'settings', payload: { harness: { effective: 'opencode' } } });
  await flush();

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

  // ── Fixed header/footer around a single scroll region (defect fix): the
  // scrollbar must span ONLY the middle content — #routing-dialog is a
  // column flex container with the header first, #routing-modal-body (the
  // sole overflow-y:auto element) in the middle, and the footer
  // .routing-actions-row last, both outside the scroll container. ──
  const dialog = doc.getElementById('routing-dialog');
  assert.ok(dialog, '#routing-dialog should exist');
  const scrollContainer = doc.getElementById('routing-modal-body');
  assert.ok(scrollContainer, '#routing-modal-body (the scroll container) should exist');
  const header = doc.getElementById('routing-modal-header');
  assert.ok(header, '#routing-modal-header should exist');
  assert.ok(header.classList.contains('routing-modal-header'), 'header should carry the .routing-modal-header class');
  assert.equal(
    dialog.firstElementChild,
    header,
    '#routing-modal-header must be the first child of #routing-dialog (fixed at top, outside the scroll container)'
  );
  assert.ok(header.contains(doc.getElementById('routing-modal-title')), 'header should contain the title');
  assert.ok(header.contains(doc.getElementById('routing-modal-close')), 'header should contain the close button');

  const footer = dialog.lastElementChild as any;
  assert.ok(footer, '#routing-dialog should have a last child (the fixed footer)');
  assert.ok(footer.classList.contains('routing-actions-row'), 'the fixed footer must carry .routing-actions-row');
  assert.notEqual(footer, scrollContainer, 'the footer must not be the scroll container');
  assert.notEqual(footer, header, 'the footer must not be the header');
  ['routing-save-btn', 'routing-revert-btn', 'routing-clear-btn'].forEach((id) => {
    const btn = doc.getElementById(id);
    assert.ok(btn, `#${id} should render`);
    assert.ok(footer.contains(btn), `#${id} should live in the fixed footer, not the scrolling body`);
    assert.ok(!scrollContainer.contains(btn), `#${id} must not be inside the scroll container`);
  });

  const css = readFileSync(join(process.cwd(), 'media', 'style.css'), 'utf8');
  assert.match(
    css,
    /#routing-modal-body\s*\{[^}]*overflow-y:\s*auto;/,
    '#routing-modal-body should be the overflow-y: auto scroll container'
  );
  // Only #routing-modal-body may declare overflow-y: auto/scroll — the
  // scrollbar must never span the header/footer.
  const overflowYRuleRe = /([.#][\w-]+)\s*\{[^}]*overflow-y:\s*(auto|scroll)/g;
  let overflowMatch: RegExpExecArray | null;
  const overflowYSelectors: string[] = [];
  while ((overflowMatch = overflowYRuleRe.exec(css)) !== null) overflowYSelectors.push(overflowMatch[1]);
  assert.deepEqual(
    overflowYSelectors.filter((s) => s.indexOf('routing') !== -1),
    ['#routing-modal-body'],
    'only #routing-modal-body should declare overflow-y: auto/scroll in the routing panel'
  );
  assert.match(
    css,
    /#routing-modal-body\s*\{[^}]*padding:\s*0;/,
    '#routing-modal-body (the scroll container) should carry zero padding — horizontal padding moves to #routing-modal-content so the scrollbar sits flush against the dialog edge'
  );
  assert.match(
    css,
    /#routing-modal-content\s*\{[^}]*padding:\s*[^;]*32px[^;]*;/,
    '#routing-modal-content (the inner wrapper) should carry the horizontal padding'
  );
  assert.doesNotMatch(
    css,
    /\.routing-modal-header\s*\{[^}]*position:\s*sticky/,
    '.routing-modal-header no longer needs position: sticky — it is a fixed dialog sibling of the scroll container, not inside it'
  );
  assert.doesNotMatch(
    css,
    /\.routing-actions-row\s*\{[^}]*position:\s*sticky/,
    '.routing-actions-row no longer needs position: sticky — it is a fixed footer, not inside the scroll container'
  );

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
  const orchModelSelect = orchestratorSection(doc).querySelector('.routing-model-select') as any;
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

  // Save button lives in the fixed footer (created once, never recreated by
  // renderRoutingModal) so this same reference reflects disabled-while-
  // saving state directly: still disabled here since routingSaved hasn't
  // landed yet.
  assert.equal(saveBtn.disabled, true, 'Save button should stay disabled while a save is in flight');

  // ── routingSaved + a fresh routing reply ──
  // Flat on the message (no payload wrapper) — matches panel.ts's
  // _handleSaveRouting/_handleClearRouting and server.mjs's saveRouting/
  // clearRouting cases: `{ type: MSG.ROUTING_SAVED, ...result }`.
  dispatch({ type: 'routingSaved', ok: true, errors: [], check: { claude: { code: 0, output: 'ok' }, opencode: { code: 0, output: 'ok' } }, write: { claude: { code: 0, output: 'ok' }, opencode: { code: 0, output: 'ok' } } });
  await flush();
  assert.equal(saveBtn.disabled, false, 'Save button should re-enable once the routingSaved reply lands');
  dispatch({ type: 'routing', payload });
  await flush();
  assertNoErrors('routingSaved + refresh');

  // ── Custom endpoint preset ──
  const vendorSelect = orchestratorSection(doc).querySelector('.routing-vendor-select') as any;
  vendorSelect.value = 'custom-endpoint';
  vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
  await flush();
  assertNoErrors('custom endpoint select');
  const transportSelectAfter = doc.querySelector('.routing-slot-fields select[disabled]') as any;
  assert.ok(transportSelectAfter, 'transport select should be disabled/forced under Custom endpoint');
  assert.equal(transportSelectAfter.value, 'openai-compatible');
  const endpointField = Array.from(doc.querySelectorAll('.routing-env-field label')).find((l: any) => l.textContent === 'Endpoint URL env');
  assert.ok(endpointField, 'Custom endpoint should reveal an Endpoint URL env field');

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

    // p20-t2: full density is keyed on harness.effective === 'opencode'.
    dispatch({ type: 'settings', payload: { harness: { effective: 'opencode' } } });
    await flush();

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
    assert.ok(totalsText.includes('metered (API) total'), 'Totals block should list a metered cost-class row');
    assert.ok(totalsText.includes('subscription total'), 'Totals block should list a subscription cost-class row');
    assert.ok(totalsText.includes('Fallbacks fired'), 'Totals block should list the fallbacks-fired line');
    assert.ok(totalsText.includes('4'), 'fallbacks-fired total should sum both agents\' fallbackCount (1 + 3 = 4)');

    // ── State update while editing preserves the unsaved slot input value ──
    const codingSlotTd = codingRow.querySelector('.routing-slot-td');
    const modelInput = codingSlotTd.querySelector('.routing-model-input, .routing-model-select') as any;
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
    const fallbackDetails = doc.querySelector('.routing-agent-fallback-row[data-agent-id="coding-specialist"] .routing-fallback-details') as any;
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

    const fallbackDetailsAfter = doc.querySelector('.routing-agent-fallback-row[data-agent-id="coding-specialist"] .routing-fallback-details') as any;
    assert.ok(fallbackDetailsAfter, 'fallback <details> should still render after the state update');
    assert.equal(fallbackDetailsAfter, fallbackDetails, 'fallback <details> element identity should be unchanged (no table rebuild)');
    assert.ok(fallbackDetailsAfter.hasAttribute('open'), 'an open fallback <details> must stay open across a state update');
  } finally {
    win.close();
  }
});

// ---------------------------------------------------------------------------
// Layering (p13 audit fix): the hamburger menu popover and every modal
// (Routing included) must paint above the bottom "AGENT METRICS" panel
// (#metrics-panel), never sliced off under it. #metrics-panel itself carries
// no z-index (default/auto, unpositioned) so any positioned popover/modal
// automatically out-ranks it; this test pins the numbers so a future edit
// can't silently drop #menu-popover/#routing-modal back below it.
// ---------------------------------------------------------------------------

function cssRuleBlock(css: string, selector: string): string {
  // Matches the selector as its own line (start of line, optional
  // leading/trailing whitespace, optional trailing comma for a
  // multi-selector rule like "#uefn-modal,\n#feedback-modal {").
  // (?![\w-]) after the selector name avoids matching a longer selector that
  // merely starts with the same text (e.g. "#routing-modal" must not match
  // the "#routing-modal[hidden]" rule that precedes it in the file).
  const re = new RegExp('^' + selector.replace(/[.#]/g, '\\$&') + '(?![\\w\\-\\[:.])[,\\s\\S]*?\\{', 'm');
  const m = re.exec(css);
  assert.ok(m, `expected to find a "${selector}" rule in style.css`);
  const braceOpen = css.indexOf('{', (m as RegExpExecArray).index);
  const braceClose = css.indexOf('}', braceOpen);
  return css.slice(braceOpen + 1, braceClose);
}

function zIndexOf(css: string, selector: string): number {
  const block = cssRuleBlock(css, selector);
  const m = block.match(/z-index\s*:\s*(-?\d+)/);
  return m ? Number(m[1]) : 0; // no declared z-index -> default stacking (0/auto)
}

test('Layering: #menu-popover and #routing-modal sit above #metrics-panel', () => {
  const css = readFileSync(join(process.cwd(), 'media', 'style.css'), 'utf8');

  const metricsZ = zIndexOf(css, '#metrics-panel');
  const popoverZ = zIndexOf(css, '#menu-popover');
  const routingModalZ = zIndexOf(css, '#routing-modal');
  const uefnModalZ = zIndexOf(css, '#uefn-modal');

  assert.ok(popoverZ > metricsZ, `#menu-popover z-index (${popoverZ}) must be greater than #metrics-panel's (${metricsZ})`);
  assert.ok(routingModalZ > metricsZ, `#routing-modal z-index (${routingModalZ}) must be greater than #metrics-panel's (${metricsZ})`);
  assert.ok(uefnModalZ > metricsZ, `#uefn-modal z-index (${uefnModalZ}) must be greater than #metrics-panel's (${metricsZ})`);

  // The popover's DOM parent must be #app (not #stage-area), matching
  // panel.ts's markup — living inside #stage-area's clipped/positioned
  // stacking context is what originally trapped its z-index below
  // #metrics-panel (a later, unrelated sibling of #stage-area inside #app)
  // no matter how high the number went (issue #27).
  const panelTs = readFileSync(join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts'), 'utf8');
  const appIdx = panelTs.indexOf('id="app"');
  const popoverIdx = panelTs.indexOf('id="menu-popover"');
  const stageAreaIdx = panelTs.indexOf('id="stage-area"');
  assert.ok(appIdx !== -1 && popoverIdx !== -1 && stageAreaIdx !== -1, 'panel.ts should declare #app, #menu-popover and #stage-area');
  assert.ok(popoverIdx > appIdx && popoverIdx < stageAreaIdx, '#menu-popover must be a direct #app child declared before #stage-area, not nested inside it');
});

test('Routing panel: real buildRoutingView payload — every agent row select equals payload backend vendor/transport (bug repro)', async () => {
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
    setState: (s: any) => { stateStore = s; },
  });

  win.requestAnimationFrame = (cb: any) => { return 1; };
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

    const menuRoutingBtn = doc.getElementById('menu-routing');
    menuRoutingBtn.click();
    await flush();

    // p20-t2: full density is keyed on harness.effective === 'opencode'.
    dispatch({ type: 'settings', payload: { harness: { effective: 'opencode' } } });
    await flush();

    // Real payload straight from the host implementation, against this
    // repo's own .claude/agents — the same shape panel.ts/server.mjs post.
    const payload: any = buildRoutingView({ root: process.cwd(), env: process.env as any });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('real routing payload render');

    for (const a of payload.agents) {
      if (a.id === 'orchestrator' || (payload.orchestrator && a.id === payload.orchestrator.id)) {
        // The orchestrator is not rendered as a `.routing-agent-row` card
        // (see isOrchestratorRosterEntry in 100-slot-editor-settings.js) —
        // it's configured by the dedicated "Orchestrator" settings-section
        // instead (100-slot-editor-settings.js ~1413-1428). That section's
        // read-only "Session model" card ([data-agent-row="orchestrator"])
        // only renders once a "settings" payload names the orchestrator
        // agent, which this test's dispatch doesn't send — but the
        // full-density slot editor (keyed on harness.effective ===
        // 'opencode', set above) always renders in that section regardless,
        // so locate it via its "Orchestrator" <h2> heading instead of the
        // read-only card, and assert its selects match the payload backend.
        const orchHeading = Array.from(doc.querySelectorAll('.settings-heading')).find(
          (h: any) => h.textContent === 'Orchestrator'
        ) as any;
        assert.ok(orchHeading, `orchestrator section heading should render; body dump:\\n${doc.body.outerHTML}`);
        const orchSection = orchHeading.closest('.settings-section');
        assert.ok(orchSection, 'orchestrator heading should sit in a settings-section');
        const vendorSel = orchSection!.querySelector('.routing-vendor-select') as any;
        const transportSel = vendorSel
          ? (Array.from(orchSection!.querySelectorAll('select')).find(
              (s: any) => s !== vendorSel && !s.className.includes('routing-model-select') && s.getAttribute('data-field-key') !== 'gemini.backend'
            ) as any)
          : null;
        assert.ok(vendorSel, `orchestrator section dump:
${orchSection!.outerHTML}`);
        assert.ok(transportSel, `orchestrator section dump:
${orchSection!.outerHTML}`);
        assert.equal(vendorSel.value, a.backend.vendor, `orchestrator: vendor select should equal payload backend.vendor`);
        assert.equal(transportSel.value, a.backend.transport, `orchestrator: transport select should equal payload backend.transport`);
        continue;
      }
      const row = doc.querySelector(`.routing-agent-row[data-agent-id="${a.id}"]`);
      assert.ok(row, `row should render for agent ${a.id}`);
      const vendorSel = row.querySelector('.routing-vendor-select') as any;
      const transportSel = Array.from(row.querySelectorAll('select')).find(
        (s: any) => s !== vendorSel && !s.className.includes('routing-model-select') && s.getAttribute('data-field-key') !== 'gemini.backend'
      ) as any;
      assert.ok(vendorSel, `vendor select should render for ${a.id}`);
      assert.ok(transportSel, `transport select should render for ${a.id}`);
      assert.equal(vendorSel.value, a.backend.vendor, `${a.id}: vendor select should equal payload backend.vendor`);
      assert.equal(transportSel.value, a.backend.transport, `${a.id}: transport select should equal payload backend.transport`);
    }
  } finally {
    win.close();
  }
});

// ---------------------------------------------------------------------------
// p13-t6 (webview half): env status {env, stored} shape, Set/Clear local
// value flow, and the bare-boolean back-compat path.
// ---------------------------------------------------------------------------

async function bootRoutingModal() {
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

  win.requestAnimationFrame = (cb: any) => 1;
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

  const menuRoutingBtn = doc.getElementById('menu-routing');
  menuRoutingBtn.click();
  await flush();
  assertNoErrors('open routing modal');

  // p20-t2: full density is keyed on harness.effective === 'opencode'.
  dispatch({ type: 'settings', payload: { harness: { effective: 'opencode' } } });
  await flush();

  return { win, doc, posted, dispatch, flush, assertNoErrors };
}

test('Routing panel: {env, stored} probe reply renders stored state + Clear button', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({ envProbe: { ANTHROPIC_API_KEY: { env: false, stored: true } } });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const field = doc.querySelector('.routing-env-field[data-env-name="ANTHROPIC_API_KEY"]') as any;
    assert.ok(field, 'credential env field should render for ANTHROPIC_API_KEY');
    const dot = field.querySelector('.routing-env-dot');
    assert.ok(dot.className.includes('routing-env-dot--stored'), 'stored:true, env:false should render the stored dot state');
    assert.equal(dot.title, 'stored locally on this machine');
    const clearBtn = field.querySelector('.routing-clear-value-btn');
    assert.ok(clearBtn, '"Clear stored value" button should render when stored is true');

    // A fresh probe reply with {env:false, stored:false} should drop the button.
    dispatch({ type: 'envProbe', payload: { ANTHROPIC_API_KEY: { env: false, stored: false } } });
    await flush();
    const fieldAfter = doc.querySelector('.routing-env-field[data-env-name="ANTHROPIC_API_KEY"]') as any;
    assert.ok(!fieldAfter.querySelector('.routing-clear-value-btn'), 'Clear button should disappear once stored is false');
    assert.ok(fieldAfter.querySelector('.routing-env-dot').className.includes('routing-env-dot--unset'));
  } finally {
    win.close();
  }
});

test('Routing panel: bare-boolean envProbe (back-compat) still renders set/unset', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({ envProbe: { ANTHROPIC_API_KEY: true } });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render (bare boolean)');

    const field = doc.querySelector('.routing-env-field[data-env-name="ANTHROPIC_API_KEY"]') as any;
    assert.ok(field, 'credential env field should render');
    const dot = field.querySelector('.routing-env-dot');
    assert.ok(dot.className.includes('routing-env-dot--set'), 'bare boolean true should be treated as {env:true, stored:false}');
    assert.ok(!field.querySelector('.routing-clear-value-btn'), 'a bare-boolean true must not be treated as stored');
  } finally {
    win.close();
  }
});

test('Routing panel: Set value flow posts setLocalEnvValue and never leaves the value in the DOM', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({ envProbe: { ANTHROPIC_API_KEY: { env: false, stored: false } } });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const field = doc.querySelector('.routing-env-field[data-env-name="ANTHROPIC_API_KEY"]') as any;
    assert.ok(field, 'credential env field should render');
    const setBtn = field.querySelector('.routing-set-value-btn') as any;
    assert.ok(setBtn, 'Set value… button should render');
    assert.equal(setBtn.disabled, false, 'Set value should be enabled for a valid env name');
    setBtn.click();
    await flush();

    const inlineInput = field.querySelector('.routing-set-value-input') as any;
    assert.ok(inlineInput, 'an inline value input should appear');
    assert.equal(inlineInput.type, 'password', 'credential field Set value input should be type=password');
    inlineInput.value = 'sk-super-secret-value';

    const saveBtn = Array.from(field.querySelectorAll('.routing-set-value-inline button')).find(
      (b: any) => b.textContent === 'Save'
    ) as any;
    assert.ok(saveBtn, 'Save button should render in the inline editor');
    saveBtn.click();
    await flush();
    assertNoErrors('save local value');

    const setMsg = posted.filter((m) => m && m.type === 'setLocalEnvValue').pop();
    assert.ok(setMsg, 'Save should post {type: "setLocalEnvValue"}');
    assert.equal(setMsg.name, 'ANTHROPIC_API_KEY');
    assert.equal(setMsg.value, 'sk-super-secret-value');

    // The input must be gone from the DOM, and no element anywhere should
    // still carry the typed secret.
    assert.ok(!field.querySelector('.routing-set-value-input'), 'the password input should be removed after save');
    const bodyHtml = doc.getElementById('routing-modal-body').innerHTML;
    assert.ok(!bodyHtml.includes('sk-super-secret-value'), 'the typed value must not remain anywhere in the routing modal DOM');

    // A subsequent envProbe reply marking it stored should show the Clear button.
    dispatch({ type: 'envProbe', payload: { ANTHROPIC_API_KEY: { env: false, stored: true } } });
    await flush();
    const fieldAfter = doc.querySelector('.routing-env-field[data-env-name="ANTHROPIC_API_KEY"]') as any;
    assert.ok(fieldAfter.querySelector('.routing-clear-value-btn'), 'Clear stored value should appear once the host confirms stored:true');

    fieldAfter.querySelector('.routing-clear-value-btn').click();
    await flush();
    const clearMsg = posted.filter((m) => m && m.type === 'clearLocalEnvValue').pop();
    assert.ok(clearMsg, 'Clear should post {type: "clearLocalEnvValue"}');
    assert.equal(clearMsg.name, 'ANTHROPIC_API_KEY');
  } finally {
    win.close();
  }
});

test('Routing panel: Endpoint env Set value input is plain text, not password', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload();
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    // Switch orchestrator to Custom endpoint to reveal the Endpoint env field.
    const vendorSelect = doc.querySelector('.routing-slot-fields .routing-vendor-select') as any;
    vendorSelect.value = 'custom-endpoint';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('custom endpoint select');

    const endpointLabel = Array.from(doc.querySelectorAll('.routing-env-field label')).find(
      (l: any) => l.textContent === 'Endpoint URL env'
    ) as any;
    assert.ok(endpointLabel, 'Endpoint URL env field should render under Custom endpoint');
    const endpointField = endpointLabel.closest('.routing-env-field');
    const endpointNameInput = endpointField.querySelector('.routing-env-input') as any;
    endpointNameInput.value = 'MY_ENDPOINT';
    endpointNameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();

    const setBtn = endpointField.querySelector('.routing-set-value-btn') as any;
    assert.ok(setBtn, 'Endpoint env Set value… button should render');
    setBtn.click();
    await flush();
    const inlineInput = endpointField.querySelector('.routing-set-value-input') as any;
    assert.ok(inlineInput, 'endpoint inline input should appear');
    assert.equal(inlineInput.type, 'text', 'endpoint env value is a URL, not a secret — should render as type=text');
  } finally {
    win.close();
  }
});

test('Routing panel: Custom endpoint provider name field sets slot.vendor and round-trips', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload();
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    // ── Choose Custom endpoint, type a provider name ──
    const vendorSelect = orchestratorSection(doc).querySelector('.routing-vendor-select') as any;
    vendorSelect.value = 'custom-endpoint';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('custom endpoint select');

    const nameInput = orchestratorSection(doc).querySelector('.routing-vendor-name-input') as any;
    assert.ok(nameInput, 'Custom endpoint should reveal a Provider name input');
    nameInput.value = 'ollama-windows';
    nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();
    const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(saveMsg, 'Save should post a saveRouting message');
    assert.equal(saveMsg.profile.orchestrator.vendor, 'ollama-windows', 'typed provider name should become slot.vendor');
    assert.equal(saveMsg.profile.orchestrator.transport, 'openai-compatible', 'transport should stay forced to openai-compatible under Custom endpoint');

    dispatch({ type: 'routingSaved', ok: true, errors: [], check: {}, write: {} });
    await flush();

    // ── Re-open with a payload whose orchestrator vendor is a saved, non-
    // preset id (e.g. a previously-configured custom endpoint) — that vendor
    // must now render as a plain selectable option (never dropped/blank),
    // per the "vendor select lists every vendor found on the current
    // payload's agents/orchestrator" fix. ──
    const reopenPayload = buildRoutingPayload({
      orchestrator: {
        id: 'orchestrator',
        backend: { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'llama3', costModelClass: 'local' },
        source: 'file',
      },
    });
    dispatch({ type: 'routing', payload: reopenPayload });
    await flush();
    assertNoErrors('reopen with a payload-declared vendor');

    const vendorSelectAfter = orchestratorSection(doc).querySelector('.routing-vendor-select') as any;
    assert.equal(vendorSelectAfter.value, 'ollama-windows', 'a vendor already present on the payload should be selectable directly, not dropped into Custom endpoint');
    const optionValues = Array.from(vendorSelectAfter.options).map((o: any) => o.value);
    assert.ok(optionValues.includes('ollama-windows'), 'ollama-windows should be a real <option> in the vendor select');

    // ── A genuinely never-seen vendor still goes through the Custom
    // endpoint flow, and blurring an empty provider name defaults to
    // "custom-endpoint" ──
    vendorSelectAfter.value = 'custom-endpoint';
    vendorSelectAfter.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    const nameInputAfter = orchestratorSection(doc).querySelector('.routing-vendor-name-input') as any;
    assert.ok(nameInputAfter, 'Provider name input should render under Custom endpoint');
    nameInputAfter.value = '';
    nameInputAfter.dispatchEvent(new win.Event('input', { bubbles: true }));
    nameInputAfter.dispatchEvent(new win.Event('blur', { bubbles: true }));
    await flush();
    assert.equal(nameInputAfter.value, 'custom-endpoint', 'blurring an empty provider name should default to custom-endpoint');
  } finally {
    win.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 1: opencode vendor preset + vendor-select completeness
// ---------------------------------------------------------------------------

test('Routing panel: opencode vendor is present in the vendor select with big-pickle in the model list', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      presets: {
        vendors: ['anthropic', 'openai', 'google', 'opencode'],
        models: [
          { id: 'sonnet', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Sonnet' },
          { id: 'opencode/big-pickle', vendor: 'opencode', costModelClass: 'subscription', label: 'opencode/big-pickle (Zen, free)' },
        ],
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const vendorSelect = doc.querySelector('.routing-slot-fields .routing-vendor-select') as any;
    const vendorOptionValues = Array.from(vendorSelect.options).map((o: any) => o.value);
    assert.ok(vendorOptionValues.includes('opencode'), 'opencode should be a selectable vendor');

    vendorSelect.value = 'opencode';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('select opencode vendor');

    // The prior model ("sonnet") doesn't match any opencode-vendor preset,
    // so the field falls back to free-text with a "Choose from list" link —
    // click it to get back to the preset select.
    const backToPreset = doc.querySelector('.routing-slot-fields .routing-inline-link-btn') as any;
    assert.ok(backToPreset, '"Choose from list" link should render once the current model no longer matches a preset');
    backToPreset.click();
    await flush();
    assertNoErrors('choose from list after opencode vendor switch');

    const modelSelect = doc.querySelector('.routing-slot-fields .routing-model-select') as any;
    assert.ok(modelSelect, 'a model select should render for the opencode vendor');
    const modelOptionValues = Array.from(modelSelect.options).map((o: any) => o.value);
    assert.ok(modelOptionValues.includes('opencode/big-pickle'), 'opencode/big-pickle should be a model option once opencode is selected');
  } finally {
    win.close();
  }
});

test('Routing panel: a payload agent with vendor "ollama-windows" makes that vendor selectable', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      agents: [
        {
          id: 'coding-specialist',
          name: 'coding-specialist',
          backend: { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'llama3', costModelClass: 'local' },
          source: 'file',
        },
      ],
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const agentRow = doc.querySelector('.routing-agent-row[data-agent-id="coding-specialist"]') as any;
    assert.ok(agentRow, 'coding-specialist row should render');
    const vendorSelect = agentRow.querySelector('.routing-vendor-select') as any;
    assert.equal(vendorSelect.value, 'ollama-windows', 'the agent\'s own vendor should render as itself, not Custom endpoint');
    const optionValues = Array.from(vendorSelect.options).map((o: any) => o.value);
    assert.ok(optionValues.includes('ollama-windows'), 'ollama-windows should be a real <option> in this agent\'s vendor select');

    // The orchestrator's own (unrelated) vendor select must also offer
    // ollama-windows now that it appears anywhere on the payload.
    const orchVendorSelect = doc.querySelector('#routing-modal-body .routing-slot-fields .routing-vendor-select') as any;
    const orchOptionValues = Array.from(orchVendorSelect.options).map((o: any) => o.value);
    assert.ok(orchOptionValues.includes('ollama-windows'), 'ollama-windows should be offered on every slot\'s vendor select, not just the agent that uses it');
  } finally {
    win.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 2: fallback <details> stays open across a structural re-render
// ---------------------------------------------------------------------------

test('Routing panel: an open fallback <details> stays open after a model select change inside it', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      agents: [
        {
          id: 'coding-specialist',
          name: 'coding-specialist',
          backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' },
          source: 'default',
        },
      ],
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const fbRow = doc.querySelector('.routing-agent-fallback-row[data-agent-id="coding-specialist"]') as any;
    const details = fbRow.querySelector('.routing-fallback-details') as any;
    assert.ok(details, 'fallback-chain details should render');

    // Add one fallback entry first (a structural change) so there's a model
    // select inside the details to edit.
    details.open = true;
    const addBtn = details.querySelector('.routing-add-fallback-btn') as any;
    addBtn.click();
    await flush();
    assertNoErrors('add fallback entry');

    const detailsAfterAdd = doc.querySelector('.routing-agent-fallback-row[data-agent-id="coding-specialist"] .routing-fallback-details') as any;
    assert.ok(detailsAfterAdd.open, 'fallback details should stay open right after adding an entry');

    detailsAfterAdd.open = true;
    const fallbackModelSelect = detailsAfterAdd.querySelector('.routing-fallback-list .routing-model-select') as any;
    assert.ok(fallbackModelSelect, 'the new fallback entry should expose a model select');
    const otherOpt = Array.from(fallbackModelSelect.options).find((o: any) => o.value && o.value !== fallbackModelSelect.value) as any;
    assert.ok(otherOpt, 'model select should have another option to switch to');
    fallbackModelSelect.value = otherOpt.value;
    fallbackModelSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('change fallback model select');

    const detailsAfterModelChange = doc.querySelector('.routing-agent-fallback-row[data-agent-id="coding-specialist"] .routing-fallback-details') as any;
    assert.ok(detailsAfterModelChange.open, 'fallback details must stay open after a model select change inside it');
  } finally {
    win.close();
  }
});

test('Routing panel: switching an agent to Custom vendor keeps its open fallback details open', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      agents: [
        {
          id: 'coding-specialist',
          name: 'coding-specialist',
          backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' },
          source: 'default',
        },
      ],
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const details = doc.querySelector('.routing-agent-fallback-row[data-agent-id="coding-specialist"] .routing-fallback-details') as any;
    details.open = true;

    const agentRow = doc.querySelector('.routing-agent-row[data-agent-id="coding-specialist"]') as any;
    const vendorSelect = agentRow.querySelector('.routing-vendor-select') as any;
    vendorSelect.value = 'custom-endpoint';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('switch coding-specialist vendor to Custom endpoint');

    const agentRowAfter = doc.querySelector('.routing-agent-row[data-agent-id="coding-specialist"]') as any;
    const nameInput = agentRowAfter.querySelector('.routing-vendor-name-input') as any;
    assert.ok(nameInput, 'Provider name field should appear once vendor is set to Custom endpoint');

    const detailsAfter = doc.querySelector('.routing-agent-fallback-row[data-agent-id="coding-specialist"] .routing-fallback-details') as any;
    assert.ok(detailsAfter, 'this agent\'s fallback details should still render');
    assert.ok(detailsAfter.open, 'this agent\'s fallback details should stay open across the vendor -> Custom endpoint re-render');
  } finally {
    win.close();
  }
});

test('Routing panel: reported scenario — Coding Specialist Custom endpoint, env names, Set value, one fallback -> saveRouting posts the full profile', async () => {
  // End-to-end reproduction of the reported bug: Custom endpoint -> provider
  // name ollama-windows, model qwen3.6:latest, cost class local, endpoint
  // env OLLAMA_BASE_URL + Set value, credential env OLLAMA_API_KEY + Set
  // value, one fallback entry, then Save. Asserts the Set value flow posts
  // the name actually typed (not stale/empty) and Save posts the whole
  // assembled profile.
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      presets: {
        vendors: ['anthropic', 'opencode'],
        models: [{ id: 'opencode/big-pickle', vendor: 'opencode', label: 'big pickle' }],
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const card = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const vendorSelect = card.querySelector('.routing-vendor-select') as any;
    vendorSelect.value = 'custom-endpoint';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const card2 = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const nameInput = card2.querySelector('.routing-vendor-name-input') as any;
    nameInput.value = 'ollama-windows';
    nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();

    const modelInput = card2.querySelector('.routing-model-input') as any;
    modelInput.value = 'qwen3.6:latest';
    modelInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();

    const costSel = card2.querySelector('select[data-field-key="agent:coding-specialist.costModelClass"]') as any;
    costSel.value = 'local';
    costSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const endpointLabel = Array.from(card2.querySelectorAll('.routing-env-field label')).find((l: any) => l.textContent === 'Endpoint URL env') as any;
    const endpointField = endpointLabel.closest('.routing-env-field');
    const endpointInput = endpointField.querySelector('.routing-env-input') as any;
    endpointInput.value = 'OLLAMA_BASE_URL';
    endpointInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();
    const endpointSetBtn = endpointField.querySelector('.routing-set-value-btn') as any;
    assert.equal(endpointSetBtn.disabled, false, 'Endpoint env Set value should be enabled for a freshly typed valid name');
    endpointSetBtn.click();
    await flush();
    const endpointInline = endpointField.querySelector('.routing-set-value-input') as any;
    endpointInline.value = 'http://localhost:11434';
    (Array.from(endpointField.querySelectorAll('.routing-set-value-inline button')).find((b: any) => b.textContent === 'Save') as any).click();
    await flush();

    const credLabel = Array.from(card2.querySelectorAll('.routing-env-field label')).find((l: any) => l.textContent === 'API key env') as any;
    const credField = credLabel.closest('.routing-env-field');
    const credInput = credField.querySelector('.routing-env-input') as any;
    credInput.value = 'OLLAMA_API_KEY';
    credInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();
    const credSetBtn = credField.querySelector('.routing-set-value-btn') as any;
    assert.equal(credSetBtn.disabled, false, 'Credential env Set value should be enabled for a freshly typed valid name');
    credSetBtn.click();
    await flush();
    const credInline = credField.querySelector('.routing-set-value-input') as any;
    credInline.value = 'sk-xxx';
    (Array.from(credField.querySelectorAll('.routing-set-value-inline button')).find((b: any) => b.textContent === 'Save') as any).click();
    await flush();
    assertNoErrors('Set value flow for endpoint + credential env');

    const setMsgs = posted.filter((m) => m && m.type === 'setLocalEnvValue');
    assert.equal(setMsgs.length, 2, 'both Set value clicks should post setLocalEnvValue');
    assert.deepEqual(setMsgs.map((m) => m.name).sort(), ['OLLAMA_API_KEY', 'OLLAMA_BASE_URL'], 'the posted names must be the ones actually typed, never empty/stale');

    const details = card2.closest('.routing-agent-card').querySelector('.routing-fallback-details') as any;
    (details.querySelector('.routing-add-fallback-btn') as any).click();
    await flush();

    const cardAfter = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const fbVendorSel = cardAfter.querySelector('.routing-fallback-item .routing-vendor-select') as any;
    fbVendorSel.value = 'opencode';
    fbVendorSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    const cardAfter2 = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const fbModelSel = cardAfter2.querySelector('.routing-fallback-item .routing-model-select') as any;
    fbModelSel.value = 'opencode/big-pickle';
    fbModelSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();
    assertNoErrors('Save the custom-endpoint profile');

    const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(saveMsg, 'Save should post a saveRouting message');
    const agentProfile = saveMsg.profile.agents['coding-specialist'];
    assert.equal(agentProfile.vendor, 'ollama-windows');
    assert.equal(agentProfile.model, 'ollama-windows/qwen3.6:latest', 'a custom/openai-compatible model with no "/" must be assembled as vendor/model at save time');
    assert.equal(agentProfile.costModelClass, 'local');
    assert.equal(agentProfile.endpointEnv, 'OLLAMA_BASE_URL');
    assert.equal(agentProfile.credentialEnv, 'OLLAMA_API_KEY');
    assert.equal(agentProfile.fallback.length, 1);
    assert.equal(agentProfile.fallback[0].vendor, 'opencode');
    assert.equal(agentProfile.fallback[0].model, 'opencode/big-pickle');
    assert.deepEqual(Object.keys(saveMsg.profile.agents), ['coding-specialist'], 'only the edited agent should be materialized into the profile (sparse save)');
    assert.equal(saveMsg.profile.orchestrator, undefined, 'the untouched orchestrator must not be written to the profile');
  } finally {
    win.close();
  }
});

test('Routing panel: sparse save — untouched agents and orchestrator are omitted, a previously-routed agent stays included', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    // search-retrieval already has an explicit routing.json entry (matches
    // its own frontmatter/default values byte-for-byte); coding-specialist
    // has no profile entry and gets edited; orchestrator is untouched.
    const payload = buildRoutingPayload({
      profile: {
        version: 1,
        agents: {
          'search-retrieval': { vendor: 'anthropic', transport: 'claude-native', model: 'haiku', costModelClass: 'subscription' },
        },
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const card = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const costSel = card.querySelector('select[data-field-key="agent:coding-specialist.costModelClass"]') as any;
    costSel.value = 'local';
    costSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();
    assertNoErrors('save');

    const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(saveMsg, 'Save should post a saveRouting message');
    assert.deepEqual(
      Object.keys(saveMsg.profile.agents).sort(),
      ['coding-specialist', 'search-retrieval'],
      'the edited agent and the already-routed agent are kept; the untouched one is not materialized'
    );
    assert.equal(saveMsg.profile.orchestrator, undefined, 'an untouched orchestrator must never be written');
  } finally {
    win.close();
  }
});

test('Routing panel: re-opening a saved profile and saving without edits round-trips byte-identically', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const savedAgentSlot = {
      vendor: 'ollama-windows',
      transport: 'openai-compatible',
      model: 'ollama-windows/qwen3.6:latest',
      costModelClass: 'local',
      endpointEnv: 'OLLAMA_BASE_URL',
      credentialEnv: 'OLLAMA_API_KEY',
      fallback: [{ vendor: 'opencode', transport: 'claude-native', model: 'opencode/big-pickle', costModelClass: 'subscription' }],
    };
    const payload = buildRoutingPayload({
      profile: { version: 1, agents: { 'coding-specialist': savedAgentSlot } },
      agents: [
        {
          id: 'coding-specialist',
          name: 'coding-specialist',
          description: 'implement, code, fix',
          backend: { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'ollama-windows/qwen3.6:latest', costModelClass: 'local', endpointEnv: 'OLLAMA_BASE_URL', apiKeyEnv: 'OLLAMA_API_KEY' },
          source: 'routing',
        },
        {
          id: 'search-retrieval',
          name: 'search-retrieval',
          backend: { vendor: 'anthropic', transport: 'claude-native', model: 'haiku', costModelClass: 'subscription' },
          source: 'frontmatter',
        },
      ],
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();
    assertNoErrors('save with no edits');

    const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(saveMsg, 'Save should post a saveRouting message');
    // deepEqual (assert/strict) fails cross-realm array/object literals
    // (main.js runs inside a vm context, a different realm from this test
    // file) even when structurally identical — compare via JSON instead.
    assert.equal(
      JSON.stringify(saveMsg.profile.agents['coding-specialist']),
      JSON.stringify(savedAgentSlot),
      'a no-op re-save of a loaded profile must round-trip byte-identically'
    );
    assert.deepEqual(Object.keys(saveMsg.profile.agents), ['coding-specialist'], 'the untouched search-retrieval row must not be materialized');
  } finally {
    win.close();
  }
});

test('Routing panel: editing a previously-routed agent back to its frontmatter values keeps it in the profile', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    // coding-specialist has an explicit routing.json entry pointing at a
    // custom vendor; the user dials it back to match its own frontmatter
    // default (anthropic/sonnet, subscription) — rule (a) says it stays in
    // the profile since it was already present, even though it now equals
    // the resolved-backend shape.
    const payload = buildRoutingPayload({
      profile: {
        version: 1,
        agents: {
          'coding-specialist': { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'ollama-windows/qwen3.6:latest', costModelClass: 'local', endpointEnv: 'OLLAMA_BASE_URL', credentialEnv: 'OLLAMA_API_KEY' },
        },
      },
      agents: [
        {
          id: 'coding-specialist',
          name: 'coding-specialist',
          description: 'implement, code, fix',
          backend: { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'ollama-windows/qwen3.6:latest', costModelClass: 'local', endpointEnv: 'OLLAMA_BASE_URL', apiKeyEnv: 'OLLAMA_API_KEY' },
          source: 'routing',
        },
      ],
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const card = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const vendorSelect = card.querySelector('.routing-vendor-select') as any;
    vendorSelect.value = 'anthropic';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    let card2 = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const transportSelect = card2.querySelector('select[data-field-key="agent:coding-specialist.transport"]') as any;
    transportSelect.value = 'claude-native';
    transportSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    card2 = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]') as any;
    const costSel = card2.querySelector('select[data-field-key="agent:coding-specialist.costModelClass"]') as any;
    costSel.value = 'subscription';
    costSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();
    assertNoErrors('save reverted-to-frontmatter values');

    const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(saveMsg, 'Save should post a saveRouting message');
    assert.ok(saveMsg.profile.agents['coding-specialist'], 'a previously-routed agent stays in the profile even once its values match the resolved backend again');
  } finally {
    win.close();
  }
});

test('Routing panel: routingSaved ok:false shows a visible error banner and keeps the user\'s draft (no silent revert)', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload();
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const vendorSelect = doc.querySelector('.routing-slot-fields .routing-vendor-select') as any;
    vendorSelect.value = 'custom-endpoint';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const nameInput = doc.querySelector('.routing-slot-fields .routing-vendor-name-input') as any;
    nameInput.value = 'ollama-windows';
    nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush();

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();

    dispatch({ type: 'routingSaved', ok: false, errors: ['routing profile is missing or not an object (got undefined)'], check: {}, write: {} });
    await flush();
    assertNoErrors('routingSaved ok:false');

    const banner = doc.querySelector('.routing-error-banner');
    assert.ok(banner, 'a visible error banner should render when routingSaved.ok is false');
    assert.ok(banner.textContent.includes('missing or not an object'), 'the banner should surface the host-reported error text');

    // The host then re-pushes its unchanged-on-disk "routing" view, as it
    // always does after a saveRouting reply — this must NOT wipe out the
    // user's still-unsaved "ollama-windows" edit.
    dispatch({ type: 'routing', payload: buildRoutingPayload() });
    await flush();
    assertNoErrors('post-failure routing re-push');

    const vendorSelectAfter = doc.querySelector('.routing-slot-fields .routing-vendor-select') as any;
    assert.equal(vendorSelectAfter.value, 'custom-endpoint', 'the draft must survive the post-failure routing re-push, not revert to the disk-resolved vendor');
    const nameInputAfter = doc.querySelector('.routing-slot-fields .routing-vendor-name-input') as any;
    assert.equal(nameInputAfter.value, 'ollama-windows', 'the typed provider name must survive too');
  } finally {
    win.close();
  }
});

test('Routing panel: failed save -> close -> reopen -> a fresh routing payload rebuilds the draft (suppression does not leak across sessions)', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload();
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const vendorSelect = orchestratorSection(doc).querySelector('.routing-vendor-select') as any;
    vendorSelect.value = 'custom-endpoint';
    vendorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();

    dispatch({ type: 'routingSaved', ok: false, errors: ['routing profile is missing or not an object (got undefined)'], check: {}, write: {} });
    await flush();
    assertNoErrors('routingSaved ok:false');

    // Close the modal, then reopen it — this must clear the
    // routingSuppressNextRebuild flag so it does not swallow the fresh
    // getRouting reply's routing payload below.
    (doc.getElementById('routing-modal-close') as any).click();
    await flush();
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    assertNoErrors('close + reopen routing modal');

    const reopenPayload = buildRoutingPayload({
      orchestrator: {
        id: 'orchestrator',
        backend: { vendor: 'openai', transport: 'claude-native', model: 'gpt-5.4-mini', costModelClass: 'metered' },
        source: 'file',
      },
    });
    dispatch({ type: 'routing', payload: reopenPayload });
    await flush();
    assertNoErrors('fresh routing payload after reopen');

    const vendorSelectAfter = orchestratorSection(doc).querySelector('.routing-vendor-select') as any;
    assert.equal(vendorSelectAfter.value, 'openai', 'the fresh routing payload must rebuild the draft, not be suppressed by the stale prior-session failure flag');
  } finally {
    win.close();
  }
});

test('Routing panel: picking a preset model sets cost class from the preset, in place', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      orchestrator: {
        id: 'orchestrator',
        backend: { vendor: 'opencode', transport: 'claude-native', model: '', costModelClass: 'metered' },
        source: 'default',
      },
      presets: {
        vendors: ['anthropic', 'opencode'],
        models: [{ id: 'opencode/big-pickle', vendor: 'opencode', costModelClass: 'subscription', label: 'big pickle' }],
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const modelSelect = orchestratorSection(doc).querySelector('.routing-model-select') as any;
    assert.ok(modelSelect, 'orchestrator model select should render');
    const costSelect = doc.querySelector('.routing-slot-fields select[data-field-key="orchestrator.costModelClass"]') as any;
    assert.equal(costSelect.value, 'metered', 'starts at the fixture cost class');

    modelSelect.value = 'opencode/big-pickle';
    modelSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('select big-pickle preset');

    assert.equal(costSelect.value, 'subscription', 'selecting the big-pickle preset should update cost class in place');
    assert.equal(
      orchestratorSection(doc).querySelector('.routing-model-select'),
      modelSelect,
      'the fix must update the existing cost class select in place, not rebuild the whole slot'
    );

    // Manual override sticks...
    costSelect.value = 'local';
    costSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assert.equal(costSelect.value, 'local', 'manual cost class change should be respected');

    // ...until the same preset is re-selected, which re-applies its class.
    modelSelect.value = '';
    modelSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    modelSelect.value = 'opencode/big-pickle';
    modelSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assert.equal(costSelect.value, 'subscription', 're-selecting the preset re-applies its cost class over the manual override');
  } finally {
    win.close();
  }
});

test('Routing panel: openai-compatible slot renders Endpoint URL env before API key env', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      orchestrator: {
        id: 'orchestrator',
        backend: { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'qwen3.6:latest', costModelClass: 'local', endpointEnv: 'OLLAMA_BASE_URL', credentialEnv: 'OLLAMA_API_KEY' },
        source: 'default',
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    // p27-t3: for a foreign-endpoint (non-native-vendor) slot, buildSlotEditorFields'
    // vendor..MCP-server field block (including the env fields asserted here) now
    // renders inside a <details class="routing-connection-details"> instead of as
    // direct children of .routing-slot-fields — see docs/design/slot-editor-redesign.md
    // section 2/10.1. The fields themselves, their order, and their content are unchanged.
    const outerSlot = orchestratorSection(doc).querySelector('.routing-slot-fields') as any;
    const connDetails = outerSlot.querySelector(':scope > .routing-connection-details') as any;
    assert.ok(connDetails, 'foreign-endpoint slot should render a Connection <details>');
    const labels = Array.from(connDetails.querySelectorAll(':scope > .routing-env-field label')).map((l: any) => l.textContent);
    assert.deepEqual(labels, ['Endpoint URL env', 'API key env'], 'endpoint field must render before the credential field, both relabeled');

    const inputs = Array.from(connDetails.querySelectorAll(':scope > .routing-env-field .routing-env-input')) as any[];
    inputs.forEach((inp) => assert.equal(inp.placeholder, 'env var NAME, never the value'));

    const note = connDetails.querySelector(':scope > .routing-env-note') as any;
    assert.equal(
      note.textContent,
      'Names here; the values are stored per user in the TycoonAgents app-data folder, never in this project.'
    );
  } finally {
    win.close();
  }
});

test('Routing panel: a new fallback entry starts with transport claude-native, not inherited from the parent', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      orchestrator: {
        id: 'orchestrator',
        backend: { vendor: 'ollama-windows', transport: 'openai-compatible', model: 'qwen3.6:latest', costModelClass: 'local', endpointEnv: 'OLLAMA_BASE_URL', credentialEnv: 'OLLAMA_API_KEY' },
        source: 'default',
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const addBtn = doc.querySelector('.routing-add-fallback-btn') as any;
    assert.ok(addBtn, '+ Add fallback button should render for the orchestrator');
    addBtn.click();
    await flush();
    assertNoErrors('add fallback');

    const fallbackTransportSel = doc.querySelector('.routing-fallback-item select[data-field-key$=".fallback[0].transport"]') as any;
    assert.ok(fallbackTransportSel, 'the new fallback entry should render its own transport select');
    assert.equal(fallbackTransportSel.value, 'claude-native', 'a fresh fallback entry must start claude-native, not the openai-compatible parent transport');
  } finally {
    win.close();
  }
});

test('Routing panel: switching a fallback vendor away from Custom endpoint resets transport to claude-native', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      presets: {
        vendors: ['anthropic', 'openai', 'opencode'],
        models: [
          { id: 'sonnet', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Sonnet' },
          { id: 'opencode/big-pickle', vendor: 'opencode', costModelClass: 'subscription', label: 'opencode/big-pickle (Zen, free)' },
        ],
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render');

    const addBtn = doc.querySelector('.routing-add-fallback-btn') as any;
    addBtn.click();
    await flush();

    // Switch the new fallback entry to Custom endpoint first (openai-compatible)...
    const fbVendorSel = doc.querySelector('.routing-fallback-item .routing-vendor-select') as any;
    fbVendorSel.value = 'custom-endpoint';
    fbVendorSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('fallback custom endpoint select');

    let fbTransportSel = doc.querySelector('.routing-fallback-item select[data-field-key$=".fallback[0].transport"]') as any;
    assert.equal(fbTransportSel.value, 'openai-compatible', 'Custom endpoint should force openai-compatible');

    // ...then switch it to the "opencode" preset vendor. Transport must reset
    // to claude-native rather than leaking the stale openai-compatible value
    // (the reported defect: opencode / opencode/big-pickle saved with
    // transport still "openai-compatible").
    const fbVendorSelAfter = doc.querySelector('.routing-fallback-item .routing-vendor-select') as any;
    fbVendorSelAfter.value = 'opencode';
    fbVendorSelAfter.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    assertNoErrors('fallback vendor switch to opencode');

    fbTransportSel = doc.querySelector('.routing-fallback-item select[data-field-key$=".fallback[0].transport"]') as any;
    assert.equal(fbTransportSel.value, 'claude-native', 'switching to a non-custom preset vendor must reset transport to claude-native');

    const fbModelSel = doc.querySelector('.routing-fallback-item .routing-model-select') as any;
    fbModelSel.value = 'opencode/big-pickle';
    fbModelSel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();
    const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(saveMsg, 'Save should post a saveRouting message');
    const savedFallback = saveMsg.profile.orchestrator.fallback[0];
    assert.equal(savedFallback.vendor, 'opencode');
    assert.equal(savedFallback.transport, 'claude-native', 'saved fallback entry must not carry a stray openai-compatible transport');
    assert.equal(savedFallback.model, 'opencode/big-pickle');
  } finally {
    win.close();
  }
});

test('Routing panel: save-time coercion resets a stray openai-compatible transport on a preset vendor with no endpoint env, and notes it on the dirty marker', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootRoutingModal();
  try {
    const payload = buildRoutingPayload({
      profile: {
        version: 1,
        agents: {
          'coding-specialist': { vendor: 'opencode', transport: 'openai-compatible', model: 'opencode/big-pickle', costModelClass: 'subscription' },
        },
      },
      presets: {
        vendors: ['anthropic', 'openai', 'google', 'opencode'],
        models: [
          { id: 'sonnet', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Sonnet' },
          { id: 'opencode/big-pickle', vendor: 'opencode', costModelClass: 'subscription', label: 'opencode/big-pickle (Zen, free)' },
        ],
      },
    });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render (pre-corrupted profile)');

    const dirtyMarker = doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"] .routing-source-chip--dirty') as any;
    assert.ok(dirtyMarker, 'a stray-transport slot already present in the profile should render as dirty');
    assert.ok(
      dirtyMarker.title && dirtyMarker.title.includes('claude-native'),
      'the dirty marker tooltip should explain the transport coercion'
    );

    const saveBtn = doc.getElementById('routing-save-btn') as any;
    saveBtn.click();
    await flush();
    const saveMsg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(saveMsg, 'Save should post a saveRouting message');
    const saved = saveMsg.profile.agents['coding-specialist'];
    assert.equal(saved.transport, 'claude-native', 'a non-custom vendor with no endpointEnv must never save as openai-compatible');
    assert.equal(saved.vendor, 'opencode');
  } finally {
    win.close();
  }
});
