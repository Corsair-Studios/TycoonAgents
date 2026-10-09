import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * jsdom runtime test for the single-provider Agents view (plan p74-t3).
 * Boots media/main.js the same way test/webviewSmoke.test.ts and
 * test/routingView.test.ts do (via node:vm against a jsdom document/window),
 * opens the routing modal by clicking the static "menu-routing" button, and
 * drives fixture "routing"/"settings" payloads carrying payload.uiMode
 * "single" through the window "message" event. Asserts the rendered
 * .model-radio-group radios (media/src/main/100-slot-editor-settings.js
 * buildSingleProviderRadioGroup), the mismatch note, that the vendor select
 * is absent, the multi-mode fallback when uiMode is omitted, and the
 * Settings screen's "I use more than one AI provider" checkbox
 * (multiProviderPayload = lastRoutingPayload).
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

function buildSingleProviderPayload() {
  return {
    vendor: 'anthropic',
    tiers: [
      { id: 'fable', label: 'Fable', model: 'claude-fable-5' },
      { id: 'opus', label: 'Opus', model: 'opus' },
      { id: 'sonnet', label: 'Sonnet', model: 'sonnet' },
      { id: 'haiku', label: 'Haiku', model: 'haiku' },
    ],
  };
}

function buildRoutingPayload(overrides?: Partial<any>) {
  const base: any = {
    profile: null,
    path: '.claude/tycoon/routing.json',
    errors: [] as string[],
    uiMode: 'single',
    harness: 'claude-code',
    multiProviderSetting: false,
    multiProviderCheckboxVisible: true,
    singleProvider: buildSingleProviderPayload(),
    orchestrator: {
      id: 'orchestrator',
      backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      source: 'default',
    },
    agents: [
      {
        id: 'coding-specialist',
        name: 'coding-specialist',
        model: 'sonnet',
        description: 'implement, code, fix',
        backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' },
        source: 'default',
      },
      {
        id: 'search-retrieval',
        name: 'search-retrieval',
        model: 'anthropic/gpt-mystery-9000',
        backend: { vendor: 'anthropic', transport: 'claude-native', model: 'anthropic/gpt-mystery-9000', costModelClass: 'subscription' },
        source: 'frontmatter',
      },
    ],
    envProbe: { ANTHROPIC_API_KEY: true },
    presets: {
      vendors: ['anthropic', 'openai', 'google'],
      models: [
        { id: 'sonnet', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Sonnet' },
        { id: 'haiku', vendor: 'anthropic', costModelClass: 'subscription', label: 'Claude Haiku' },
      ],
    },
    lastApplied: {},
  };
  return { ...base, ...(overrides || {}) };
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

function codexRoutingPayload() {
  const p = buildRoutingPayload({
    harness: 'codex',
    singleProvider: {
      vendor: 'openai',
      tiers: [
        { id: 'sol', label: 'Sol', model: 'openai/gpt-5.6-sol' },
        { id: 'astra', label: 'Astra', model: 'openai/gpt-6-astra' },
      ],
    },
  });
  const claudeBackend = (model: string) => ({ vendor: 'anthropic', transport: 'claude-native', model, costModelClass: 'subscription' });
  p.agents = [
    { id: 'coding-specialist', name: 'coding-specialist', backend: claudeBackend('sonnet'), source: 'default', provenance: 'frontmatter' },
    { id: 'search-retrieval', name: 'search-retrieval', backend: claudeBackend('haiku'), source: 'default', provenance: 'frontmatter' },
    { id: 'big-thinker', name: 'big-thinker', backend: claudeBackend('opus'), source: 'default', provenance: 'frontmatter' },
    { id: 'picked', name: 'picked', backend: { vendor: 'openai', transport: 'claude-native', model: 'openai/gpt-6-astra', costModelClass: 'subscription' }, source: 'routing', provenance: 'explicit' },
  ];
  return p;
}

function codexSettingsPayload() {
  const hd = (model: string, label: string, effort?: string) => ({ vendor: 'openai', model, ...(effort ? { effort } : {}), label, source: 'harness-default' });
  const base = { vendor: 'openai', costModelClass: 'subscription' };
  return {
    harness: { effective: 'codex' },
    agents: [
      { id: 'orchestrator', name: 'Orchestrator', isOrchestrator: true, model: null, keywords: '' },
      { id: 'coding-specialist', name: 'Coding Specialist', model: 'sonnet', keywords: 'code', claudeTier: 'sonnet', resolvedModel: 'sonnet', ...base, harnessDefault: hd('gpt-5.6-sol', 'Sol') },
      { id: 'search-retrieval', name: 'Search Retrieval', model: 'haiku', keywords: 'find', claudeTier: 'haiku', resolvedModel: 'haiku', ...base, harnessDefault: hd('gpt-5.6-sol', 'Sol low', 'low') },
      { id: 'big-thinker', name: 'Big Thinker', model: 'opus', keywords: 'think', claudeTier: 'opus', resolvedModel: 'opus', ...base, harnessDefault: hd('gpt-6-astra', 'Astra') },
      { id: 'picked', name: 'Picked', model: 'openai/gpt-6-astra', keywords: 'x', claudeTier: null, resolvedModel: 'openai/gpt-6-astra', ...base, harnessDefault: null },
    ],
    delegation_mode: 'direct',
    delegationHealth: {},
    hookHealth: { healthy: true, issueCount: 0 },
    contextBudget: null,
  };
}

test('Codex harness (single view): agents without a choice pre-select the effective model and label it as the harness default', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: codexSettingsPayload() });
    await flush();
    dispatch({ type: 'routing', payload: codexRoutingPayload() });
    await flush();
    assertNoErrors('codex single render');

    const checkedFor = (id: string) =>
      (doc.querySelector(`[data-agent-id="${id}"] input[type="radio"]:checked`) as any)?.value;
    assert.equal(checkedFor('coding-specialist'), 'sol');
    assert.equal(checkedFor('search-retrieval'), 'sol');
    assert.equal(checkedFor('big-thinker'), 'astra');
    assert.equal(checkedFor('picked'), 'astra');

    const noteText = (id: string) =>
      (doc.querySelector(`[data-agent-id="${id}"] .single-provider-default-note`) as any)?.textContent;
    assert.equal(noteText('coding-specialist'), 'Harness default: Sol');
    assert.equal(noteText('search-retrieval'), 'Harness default: Sol low');
    assert.equal(noteText('big-thinker'), 'Harness default: Astra');
    assert.equal(noteText('picked'), undefined, 'an explicit choice is not labelled as a harness default');
    assert.equal(doc.querySelectorAll('.single-provider-mismatch-note').length, 0, 'no mismatch note on Codex defaults');
    assert.equal(posted.filter((m) => m && (m.type === 'setAgentModel' || m.type === 'saveRouting')).length, 0, 'rendering writes nothing');
  } finally {
    win.close();
  }
});

test('Codex harness (multi view): default agents show a Harness default chip instead of Claude tier radios', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: codexSettingsPayload() });
    await flush();
    const routing: any = codexRoutingPayload();
    routing.uiMode = 'multi';
    delete routing.singleProvider;
    dispatch({ type: 'routing', payload: routing });
    await flush();
    assertNoErrors('codex multi render');
    const chip = doc.querySelector('[data-agent-id="search-retrieval"] .agent-harness-default-chip') as any;
    assert.ok(chip, 'expected the harness default chip');
    assert.equal(chip.textContent, 'Harness default: Sol low');
    assert.equal(doc.querySelector('[data-agent-id="picked"] .agent-harness-default-chip'), null);
  } finally {
    win.close();
  }
});

test('Claude harness (single view): no harness default label, Claude radios unchanged', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: { harness: { effective: 'claude-code' } } });
    await flush();
    dispatch({ type: 'routing', payload: buildRoutingPayload() });
    await flush();
    assertNoErrors('claude single render');
    assert.equal(doc.querySelectorAll('.single-provider-default-note').length, 0);
    assert.ok(doc.querySelector('input[type="radio"][value="sonnet"]:checked'));
  } finally {
    win.close();
  }
});

test('Codex harness (metrics): default agents show Sol/Astra with OpenAI quota; orchestrator tokens read n/a', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    dispatch({ type: 'settings', payload: codexSettingsPayload() });
    dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus', rosterModel: 'opus', tokens: 0, activeMs: 0, taskCount: 0 },
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', tokens: 5000, activeMs: 100, taskCount: 1 },
          { id: 'search-retrieval', name: 'Search Retrieval', status: 'idle', model: 'haiku', tokens: 3000, activeMs: 100, taskCount: 1 },
          { id: 'big-thinker', name: 'Big Thinker', status: 'idle', model: 'opus', tokens: 2000, activeMs: 100, taskCount: 1 },
        ],
      },
    });
    await flush();
    const btn = doc.getElementById('delegation-tab-btn') as any;
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await flush();
    assertNoErrors('codex metrics render');
    const body = doc.getElementById('delegation-stats') as any;
    const rows = [...body.querySelectorAll('.delegation-agent-table tbody tr')];
    const cell = (name: string) => (rows.find((r: any) => r.querySelector('.col-name')?.textContent === name) as any)?.querySelector('.col-model')?.textContent;
    assert.equal(cell('Coding Specialist'), 'Sol (OpenAI, quota)');
    assert.equal(cell('Search Retrieval'), 'Sol low (OpenAI, quota)');
    assert.equal(cell('Big Thinker'), 'Astra (OpenAI, quota)');

    const metricRows = [...doc.querySelectorAll('#metrics-tbody tr')];
    const orchRow = metricRows.find((r: any) => r.querySelector('.col-tokens') && /Orchestrator/i.test(r.textContent)) as any;
    assert.ok(orchRow, 'expected an orchestrator metrics row');
    assert.equal(orchRow.querySelector('.col-tokens').textContent, 'n/a');

    // Hover tooltip on the metrics row shows the harness default, not the agent file's Claude tier.
    const csRow = metricRows.find((r: any) => /Coding Specialist/.test(r.textContent)) as any;
    assert.ok(csRow, 'expected a Coding Specialist metrics row');
    const csTitle = csRow.querySelector('.col-name').title as string;
    assert.match(csTitle, /Coding Specialist — Sol/);
    assert.doesNotMatch(csTitle, /Sonnet/);
  } finally {
    win.close();
  }
});

test('Codex harness (single view): clicking the selected harness-default radio saves an explicit choice; no double save on a normal change', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: codexSettingsPayload() });
    await flush();
    dispatch({ type: 'routing', payload: codexRoutingPayload() });
    await flush();
    const sol = doc.querySelector('[data-agent-id="coding-specialist"] input[type="radio"][value="sol"]') as any;
    assert.ok(sol.checked);
    sol.click();
    await flush();
    assertNoErrors('click default radio');
    const saves = posted.filter((m) => m && m.type === 'setAgentModel' && m.id === 'coding-specialist');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].model, 'openai/gpt-5.6-sol');

    posted.length = 0;
    const astra = doc.querySelector('[data-agent-id="coding-specialist"] input[type="radio"][value="astra"]') as any;
    astra.click();
    await flush();
    assert.equal(posted.filter((m) => m && m.type === 'setAgentModel' && m.id === 'coding-specialist').length, 1);
  } finally {
    win.close();
  }
});

test('Bridge wrapper (Mistral Reviewer) tooltip shows the backend model: bare on Codex, with the relay noted on Claude Code', async () => {
  for (const harness of ['codex', 'claude-code'] as const) {
    const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
    try {
      const settings: any = codexSettingsPayload();
      settings.harness = { effective: harness };
      settings.agents.push({
        id: 'mistral-reviewer', name: 'Mistral Reviewer', model: 'haiku', keywords: 'review', claudeTier: 'haiku',
        resolvedModel: 'mistral/mistral-large-latest', vendor: 'mistral', costModelClass: 'metered',
        handWrittenBackend: true, harnessDefault: null,
      });
      dispatch({ type: 'settings', payload: settings });
      dispatch({
        type: 'state',
        state: {
          sessionActive: true, completedTasks: 1, idleFreezeMs: 180000, sanityCapMs: 900000, workers: {},
          agentMetrics: [
            { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus', rosterModel: 'opus', tokens: 0, activeMs: 0, taskCount: 0 },
            { id: 'mistral-reviewer', name: 'Mistral Reviewer', status: 'idle', model: 'haiku', tokens: 100, activeMs: 10, taskCount: 1 },
          ],
        },
      });
      await flush();
      assertNoErrors('bridge tooltip ' + harness);
      const row = [...doc.querySelectorAll('#metrics-tbody tr')].find((r: any) => /Mistral Reviewer/.test(r.textContent)) as any;
      assert.ok(row, 'expected the Mistral Reviewer row');
      const title = row.querySelector('.col-name').title as string;
      if (harness === 'codex') {
        assert.match(title, /Mistral Reviewer — mistral-large-latest(\n|$)/);
        assert.doesNotMatch(title, /Haiku/);
      } else {
        assert.match(title, /mistral-large-latest \(via Haiku relay\)/);
      }
    } finally {
      win.close();
    }
  }
});

test('Saving routing: fixed-endpoint vendor fallbacks (xai/mistral) are written as openai-compatible, anthropic fallbacks unchanged', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: { harness: { effective: 'claude-code' } } });
    await flush();
    const routing: any = buildRoutingPayload({ uiMode: 'multi', singleProvider: undefined });
    routing.profile = {
      agents: {
        'coding-specialist': {
          vendor: 'anthropic', model: 'sonnet',
          fallback: [
            { vendor: 'xai', transport: 'claude-native', model: 'xai/grok-build-0.1', costModelClass: 'metered' },
            { vendor: 'mistral', transport: 'claude-native', model: 'mistral/mistral-large-latest' },
            { vendor: 'anthropic', transport: 'claude-native', model: 'haiku' },
          ],
        },
      },
    };
    dispatch({ type: 'routing', payload: routing });
    await flush();
    const row = doc.querySelector('[data-agent-id="coding-specialist"]') as any;
    assert.ok(row, 'agent row renders');
    (doc.getElementById('routing-save-btn') as any).click();
    await flush();
    assertNoErrors('save fallbacks');
    const msg = posted.filter((m) => m && m.type === 'saveRouting').pop();
    assert.ok(msg, 'save posted');
    const fb = msg.profile.agents['coding-specialist'].fallback;
    assert.equal(fb[0].vendor, 'xai');
    assert.equal(fb[0].transport, 'openai-compatible');
    assert.equal(fb[0].model, 'xai/grok-build-0.1');
    assert.equal(fb[1].transport, 'openai-compatible');
    assert.equal(fb[2].transport, 'claude-native');
  } finally {
    win.close();
  }
});

test('Gemini Reviewer slot: Codex shows dispatcher route + GEMINI_API_KEY, no .mcp.json/bridge/Antigravity notices; Claude Code unchanged', async () => {
  for (const harness of ['codex', 'claude-code'] as const) {
    const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
    try {
      (doc.getElementById('menu-routing') as any).click();
      await flush();
      dispatch({ type: 'settings', payload: { harness: { effective: harness } } });
      await flush();
      const routing: any = buildRoutingPayload({ uiMode: 'multi', singleProvider: undefined, harness });
      routing.bridge = { mcpServers: [], gemini: { serverPresent: false, value: 'agy' } };
      routing.presets.vendors = ['anthropic', 'openai', 'google'];
      routing.presets.models = [{ id: 'gemini-3.5-flash', vendor: 'google', costModelClass: 'metered', label: 'Gemini 3.5 Flash' }];
      routing.presets.vendorKeys = [{ id: 'google', label: 'Google', vendors: ['google'], auth: 'key', rows: [{ env: 'GEMINI_API_KEY', label: 'Gemini API key', kind: 'credential', required: true }], test: true }];
      routing.agents = [{
        id: 'gemini-reviewer', name: 'gemini-reviewer', source: 'frontmatter', provenance: 'frontmatter', handWrittenBackend: true,
        backend: { vendor: 'google', transport: 'mcp', mcpServer: 'gemini', model: 'gemini-3.5-flash', costModelClass: 'metered' },
      }];
      dispatch({ type: 'routing', payload: routing });
      await flush();
      assertNoErrors('gemini slot ' + harness);
      const card = doc.querySelector('[data-agent-id="gemini-reviewer"]') as any;
      assert.ok(card, 'gemini reviewer card renders');
      const text = (card.textContent || '') as string;
      if (harness === 'codex') {
        assert.doesNotMatch(text, /not in \.mcp\.json|No "gemini" server|set by Antigravity/);
        assert.equal((card.querySelector('.routing-subscription-notice') as any).hidden, true, 'bridge notice (and Copy request) hidden on Codex');
        assert.match(text, /Connection: TycoonAgents dispatcher/);
        assert.match(text, /Backend: Google via TycoonAgents dispatcher/);
        assert.doesNotMatch(text, /via MCP/);
        assert.match(text, /GEMINI_API_KEY/);
        assert.match(text, /Gemini uses GEMINI_API_KEY; Antigravity sign-in isn't supported here yet/);
      } else {
        assert.match(text, /not in \.mcp\.json|Bridge via|Gemini 3\.5 Flash/);
      }
    } finally {
      win.close();
    }
  }
});
