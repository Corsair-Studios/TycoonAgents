/*
 * Regression: after a Codex-backed hand-written agent (Artist, `codex exec`)
 * ran, the Metrics tab painted the Orchestrator light blue, labelled every
 * Claude agent "API", and lit Claude agents blue. A vendor stamped onto the
 * orchestrator row by a (mis)attributed foreign/MCP call became the
 * orchestrator's vendor for every "foreign to orchestrator" decision.
 * Claude Code harness: the orchestrator is the Claude baseline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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


import { applyEvent } from '../src/core/state';
import { mapHookRecord } from '../src/providers/claude-code/mapHookRecord';
import { computeStateFromRecords } from '../src/core/state';

test('state: an MCP/foreign call attributed to the orchestrator never stamps a vendor on it; a worker still gets its own', () => {
  const state = computeStateFromRecords([
    { event: 'PreToolUse', tool: 'mcp__codex__codex', workerId: 'orchestrator', vendor: 'openai', costModelClass: 'subscription', sessionId: 'S', at: 1700000000000 },
    { event: 'PreToolUse', tool: 'mcp__codex__codex', workerId: 'codex-reviewer', vendor: 'openai', costModelClass: 'subscription', sessionId: 'S', at: 1700000000001 },
  ] as any);
  const orch = state.agentMetrics.find((m) => m.id === 'orchestrator')!;
  assert.equal(orch.vendor, undefined);
  assert.equal(orch.costModelClass, undefined);
  assert.equal(orch.mcpCount, 1, 'the call is still counted');
  assert.equal(state.agentMetrics.find((m) => m.id === 'codex-reviewer')!.vendor, 'openai');
  void applyEvent; void mapHookRecord;
});

function claudeSettings() {
  const sa = (id: string, name: string) => ({ id, name, model: 'sonnet', keywords: 'x', claudeTier: 'sonnet', resolvedModel: 'sonnet', vendor: 'anthropic', costModelClass: 'metered', harnessDefault: null });
  return {
    harness: { effective: 'claude-code' },
    agents: [
      { id: 'orchestrator', name: 'Orchestrator', isOrchestrator: true, model: null, keywords: '' },
      sa('coding-specialist', 'Coding Specialist'),
      sa('ux-ui-designer', 'UX/UI Designer'),
      { ...sa('artist', 'Artist'), handWrittenBackend: false },
    ],
    delegation_mode: 'direct', delegationHealth: {}, hookHealth: { healthy: true, issueCount: 0 }, contextBudget: null,
  };
}

test('Claude Code: stamped orchestrator vendor does not make Claude agents "API" or light blue; only the agent with its own foreign call in flight is blue', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    dispatch({ type: 'settings', payload: claudeSettings() });
    const now = Date.now();
    dispatch({
      type: 'state',
      state: {
        sessionActive: true, completedTasks: 1, idleFreezeMs: 180000, workers: {},
        agentMetrics: [
          // The user's state: orchestrator row carries a stamped openai vendor and is active with a foreign call.
          { id: 'orchestrator', name: 'Orchestrator', status: 'active', model: 'opus', vendor: 'openai', costModelClass: 'subscription', tokens: 1000, activeMs: 10, taskCount: 0, mcpCount: 21, workStartAt: now, lastActivityAt: now,
            inFlightCalls: [{ id: 'o1', tool: 'Bash', at: now, foreign: { vendor: 'openai', cli: 'codex', model: 'gpt-6.1-terra' } }] },
          // Claude agents idle, with a stale activity-stamped vendor on the row.
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', vendor: 'openai', tokens: 5000, activeMs: 100, taskCount: 3 },
          { id: 'ux-ui-designer', name: 'UX/UI Designer', status: 'active', model: 'sonnet', vendor: 'openai', tokens: 2000, activeMs: 100, taskCount: 1, workStartAt: now, lastActivityAt: now },
          { id: 'artist', name: 'Artist', status: 'active', model: 'sonnet', tokens: 100, activeMs: 10, taskCount: 26, mcpCount: 48, foreignCliCalls: 48, workStartAt: now, lastActivityAt: now,
            inFlightCalls: [{ id: 'a1', tool: 'Bash', at: now, foreign: { vendor: 'openai', cli: 'codex', model: 'gpt-6.1-terra' } }] },
        ],
      },
    });
    await flush();
    assertNoErrors('metrics render');
    const rows = [...doc.querySelectorAll('#metrics-tbody tr')];
    const row = (re: RegExp) => rows.find((r: any) => re.test(r.querySelector('.col-name')?.textContent || '')) as any;
    const blue = (r: any) => /agent-accent-foreign/.test(String(r.querySelector('.col-name span').className));
    assert.equal(blue(row(/^Orchestrator/)), false, 'orchestrator stays the baseline');
    assert.equal(blue(row(/^Coding Specialist/)), false);
    assert.equal(blue(row(/^UX\/UI Designer/)), false, 'a Claude agent is not blue because its row carries a stamped vendor');
    assert.equal(blue(row(/^Artist/)), true, 'Artist is blue while its own codex call runs');
    const pill = (r: any) => String(r.querySelector('.status-bar-label').textContent);
    const tip = (r: any) => String(r.querySelector('.status-bar-track').title);
    // The pill is the model family only; billing and the price comparison live in the tooltip.
    assert.equal(pill(row(/^Orchestrator/)), 'Opus');
    assert.equal(pill(row(/^Coding Specialist/)), 'Sonnet');
    assert.doesNotMatch(pill(row(/^Coding Specialist/)), /API|Sub|cheaper|OpenAI|Anthropic/, 'no company or billing text in the pill');
    const codingTip = tip(row(/^Coding Specialist/)).split('\n');
    assert.deepEqual(codingTip.slice(0, 2), ['sonnet', 'API (pay per use)'], 'Claude billing, not the stale openai stamp');
    assert.match(codingTip[2], /^About .*× cheaper per token than the orchestrator's model at published list prices\. Estimate only; prices change\.$/);
    assert.doesNotMatch(tip(row(/^UX\/UI Designer/)), /Subscription|gpt|via /, 'a stale stamp must not leak into the tooltip');
    // Artist (Sonnet) shells out to Codex: while the call runs the pill names the model it reported.
    assert.equal(pill(row(/^Artist/)), 'Terra');
    const artistTip = tip(row(/^Artist/)).split('\n');
    assert.equal(artistTip[0], 'gpt-6.1-terra');
    assert.equal(artistTip[1], 'Subscription');
    assert.ok(artistTip.includes('via Codex CLI · gpt-6.1-terra'));
    assert.ok(!artistTip.some((l) => /cheaper|pricier/.test(l)), 'no price comparison for a foreign model');
    assert.equal(row(/^Artist/).querySelector('.agent-foreign-cli'), null, 'the via line moved into the tooltip');
    // Call finished: the artist goes back to its configured model and notes the CLI model it uses.
    dispatch({
      type: 'state',
      state: {
        sessionActive: true, completedTasks: 1, idleFreezeMs: 180000, workers: {},
        agentMetrics: [
          { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus', tokens: 1000, activeMs: 10, taskCount: 0 },
          { id: 'artist', name: 'Artist', status: 'idle', model: 'sonnet', tokens: 100, activeMs: 10, taskCount: 26, foreignCliCalls: 48,
            lastForeignCli: { vendor: 'openai', cli: 'codex', model: 'gpt-6.1-terra' } },
        ],
      },
    });
    await flush();
    const idleRows = [...doc.querySelectorAll('#metrics-tbody tr')];
    const idleArtist = idleRows.find((r: any) => /^Artist/.test(r.querySelector('.col-name')?.textContent || '')) as any;
    assert.equal(pill(idleArtist), 'Sonnet');
    assert.ok(tip(idleArtist).split('\n').includes('Uses Terra via Codex CLI (gpt-6.1-terra)'));
    assert.equal(/agent-accent-foreign/.test(String(idleArtist.querySelector('.col-name span').className)), false);
  } finally {
    win.close();
  }
});

test('Claude worker with a Settings entry (empty vendor) ignores a stale stamped vendor: no light blue, Claude model name', async () => {
  const { win, doc, dispatch, flush, assertNoErrors } = await bootMain();
  try {
    const settings: any = claudeSettings();
    settings.agents[1] = { ...settings.agents[1], vendor: '', costModelClass: undefined };
    dispatch({ type: 'settings', payload: settings });
    const now = Date.now();
    dispatch({
      type: 'state',
      state: {
        sessionActive: true, completedTasks: 1, idleFreezeMs: 180000, workers: {},
        agentMetrics: [
          { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus', tokens: 1000, activeMs: 10, taskCount: 0 },
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'active', model: 'sonnet', vendor: 'openai', costModelClass: 'subscription', tokens: 5000, activeMs: 100, taskCount: 3, workStartAt: now, lastActivityAt: now },
        ],
      },
    });
    await flush();
    assertNoErrors('render');
    const r = [...doc.querySelectorAll('#metrics-tbody tr')].find((x: any) => /^Coding Specialist/.test(x.querySelector('.col-name')?.textContent || '')) as any;
    assert.equal(/agent-accent-foreign/.test(String(r.querySelector('.col-name span').className)), false);
    assert.equal(r.querySelector('.status-bar-fill.agent-accent-foreign'), null);
    assert.equal(r.querySelector('.status-bar-label').textContent, 'Sonnet');
  } finally {
    win.close();
  }
});
