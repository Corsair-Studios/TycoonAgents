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

test('Agents view (single-provider): uiMode "single" renders per-agent radios and no vendor select', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    const menuRoutingBtn = doc.getElementById('menu-routing') as any;
    menuRoutingBtn.click();
    await flush();

    dispatch({ type: 'settings', payload: { harness: { effective: 'claude-code' } } });
    await flush();

    const payload = buildRoutingPayload();
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render (single mode)');

    const groups = doc.querySelectorAll('.model-radio-group');
    assert.ok(groups.length > 0, 'expected at least one .model-radio-group in single mode');
    assert.equal(doc.querySelectorAll('.routing-vendor-select').length, 0, 'no vendor select should render in single mode');

    // coding-specialist's model "sonnet" matches the "sonnet" tier -> checked.
    const codingCard = doc.querySelector('[data-agent-id="coding-specialist"]') as any;
    assert.ok(codingCard, 'expected a coding-specialist agent card');
  } finally {
    win.close();
  }
});

test('Agents view (single-provider): checked radio matches the agent\'s current model', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: { harness: { effective: 'claude-code' } } });
    await flush();
    dispatch({ type: 'routing', payload: buildRoutingPayload() });
    await flush();
    assertNoErrors('routing payload render');

    const sonnetRadio = doc.querySelector('input[type="radio"][value="sonnet"]:checked') as any;
    assert.ok(sonnetRadio, 'the sonnet tier radio for coding-specialist should be checked');
  } finally {
    win.close();
  }
});

test('Agents view (single-provider): clicking a radio posts setAgentModel with the tier\'s model', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: { harness: { effective: 'claude-code' } } });
    await flush();
    dispatch({ type: 'routing', payload: buildRoutingPayload() });
    await flush();
    assertNoErrors('routing payload render');

    const haikuRadio = doc.querySelector('input[type="radio"][value="haiku"]') as any;
    assert.ok(haikuRadio, 'expected a haiku-tier radio');
    haikuRadio.checked = true;
    haikuRadio.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();

    const setModelMsg = posted.filter((m) => m && m.type === 'setAgentModel').pop();
    assert.ok(setModelMsg, 'expected a setAgentModel message to be posted');
    assert.equal(setModelMsg.model, 'haiku');
  } finally {
    win.close();
  }
});

test('Agents view (single-provider): an unmatched model shows the mismatch note with no checked radio in that group', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    dispatch({ type: 'settings', payload: { harness: { effective: 'claude-code' } } });
    await flush();
    dispatch({ type: 'routing', payload: buildRoutingPayload() });
    await flush();
    assertNoErrors('routing payload render');

    const searchCard = doc.querySelector('[data-agent-id="search-retrieval"]') as any;
    assert.ok(searchCard, 'expected a search-retrieval agent card');
    const note = searchCard.querySelector('.single-provider-mismatch-note');
    assert.ok(note, 'expected the single-provider mismatch note for an unmatched model');
    assert.match(note.textContent, /Uses anthropic\/gpt-mystery-9000/);
    assert.match(note.textContent, /turn on multi-provider in Settings/);

    const checkedInGroup = searchCard.querySelector('.model-radio-group input[type="radio"]:checked');
    assert.equal(checkedInGroup, null, 'no radio should be checked for an unmatched model');
  } finally {
    win.close();
  }
});

test('Agents view: a payload without uiMode renders the multi-provider UI (vendor select present, no single-provider mismatch note)', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    (doc.getElementById('menu-routing') as any).click();
    await flush();
    // opencode density gives us the full editor with vendor selects.
    dispatch({ type: 'settings', payload: { harness: { effective: 'opencode' } } });
    await flush();

    const payload = buildRoutingPayload({ uiMode: undefined, singleProvider: undefined });
    dispatch({ type: 'routing', payload });
    await flush();
    assertNoErrors('routing payload render (multi fallback)');

    assert.ok(doc.querySelectorAll('.routing-vendor-select').length > 0, 'expected vendor selects in multi mode');
    assert.equal(doc.querySelectorAll('.single-provider-mismatch-note').length, 0, 'no single-provider mismatch note should render in multi mode');
  } finally {
    win.close();
  }
});

test('Settings screen: the multi-provider checkbox renders only when multiProviderCheckboxVisible, and toggling posts setAgentsMultiProvider', async () => {
  const { win, doc, posted, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    // Push a routing payload first (lastRoutingPayload is what the Settings
    // screen's checkbox visibility reads), then a settings payload to
    // trigger renderSettings().
    dispatch({ type: 'routing', payload: buildRoutingPayload({ multiProviderCheckboxVisible: true, multiProviderSetting: false }) });
    await flush();
    dispatch({ type: 'settings', payload: { harness: { effective: 'claude-code' }, agents: [] } });
    await flush();
    assertNoErrors('settings render (checkbox visible)');

    const checkbox = doc.querySelector('.settings-multi-provider-checkbox') as any;
    assert.ok(checkbox, 'expected the multi-provider checkbox to render when multiProviderCheckboxVisible is true');
    assert.equal(checkbox.checked, false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new win.Event('change', { bubbles: true }));
    await flush();
    const toggleMsg = posted.filter((m) => m && m.type === 'setAgentsMultiProvider').pop();
    assert.ok(toggleMsg, 'expected a setAgentsMultiProvider message to be posted');
    assert.equal(toggleMsg.value, true);
  } finally {
    win.close();
  }
});

test('Settings screen: the multi-provider checkbox is absent when multiProviderCheckboxVisible is false', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    dispatch({ type: 'routing', payload: buildRoutingPayload({ multiProviderCheckboxVisible: false }) });
    await flush();
    dispatch({ type: 'settings', payload: { harness: { effective: 'opencode' }, agents: [] } });
    await flush();
    assertNoErrors('settings render (checkbox hidden, opencode)');

    assert.equal(doc.querySelectorAll('.settings-multi-provider-checkbox').length, 0, 'checkbox should not render when multiProviderCheckboxVisible is false');
  } finally {
    win.close();
  }
});
