import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHiddenSelectors, isVisible } from './helpers/cssVisibility';

/*
 * Regression test for the v0.0.647 Metrics-tab bug (commit 09396c8):
 * #metrics-table's visibility was switched from an inline style to
 * `class="metrics-table-hidden"` + `.metrics-table-hidden { display: none }`
 * in media/style.css, but renderMetricsTable() (media/src/main/080-packs-events.js)
 * only ever cleared `tableEl.style.display`, which cannot override a class
 * rule — the table stayed hidden forever. JSDOM ignores CSS entirely, so the
 * existing metrics tests (which only check #metrics-tbody's children) stayed
 * green through that whole regression.
 *
 * This test:
 *   1. Boots media/main.js (the real webview bundle) inside a jsdom runtime,
 *      using the REAL static markup for the Metrics tab lifted straight out
 *      of src/host/vscode/panel.ts's _getHtmlForWebview() template — not a
 *      synthetic generic <div>, so whatever class/attribute panel.ts puts on
 *      #metrics-table is exactly what gets tested against style.css.
 *   2. Dispatches an agentMetrics state update (same fixture shape as
 *      test/webviewSmoke.test.ts's buildStatePayload()).
 *   3. Uses the CSS-aware isVisible() helper (test/helpers/cssVisibility.ts)
 *      to assert #metrics-table is actually visible and #metrics-tbody has
 *      rows — catching exactly the "hidden via class, JS only touched
 *      style.display" failure mode.
 *
 * Env overrides (all default to the current tree; see "proof against
 * v0.0.647" below for how they're used):
 *   TYCOON_WEBVIEW_BUNDLE  -> path to media/main.js
 *   TYCOON_PANEL_TS_PATH   -> path to src/host/vscode/panel.ts
 *   TYCOON_WEBVIEW_CSS     -> path to media/style.css (read by cssVisibility.ts)
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

const MAIN_JS_PATH = process.env.TYCOON_WEBVIEW_BUNDLE || join(process.cwd(), 'media', 'main.js');
const PANEL_TS_PATH = process.env.TYCOON_PANEL_TS_PATH || join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');

/**
 * Pull the real static Metrics-tab markup (scope toggle, #metrics-empty,
 * #metrics-table incl. whatever class/attributes it currently carries) out
 * of panel.ts's _getHtmlForWebview() template literal.
 */
function extractMetricsBodyMarkup(panelTsPath: string): string {
  const src = readFileSync(panelTsPath, 'utf8');
  const re = /<div id="metrics-body">[\s\S]*?<\/table>\s*<\/div>/;
  const m = re.exec(src);
  assert.ok(m, `could not find #metrics-body markup in ${panelTsPath}`);
  return m![0];
}

function buildStatePayload() {
  const agentMetrics = [
    { id: 'a1', name: 'Alpha', status: 'active', model: 'sonnet', tokens: 1200, activeMs: 60000, lastActivityAt: Date.now() },
    { id: 'a2', name: 'Bravo', status: 'idle', model: 'haiku', tokens: 300, activeMs: 20000, lastActivityAt: Date.now() - 1000 },
  ];
  return {
    type: 'state',
    state: {
      sessionActive: true,
      completedTasks: 2,
      idleFreezeMs: 180000,
      workers: {},
      agentMetrics,
    },
  };
}

// Generic id -> element scaffold, same technique as webviewSmoke.test.ts,
// used for every id main.js reads EXCEPT the Metrics-tab ids, which come
// from the real extracted markup instead.
function scanElementIds(src: string): string[] {
  const ids = new Set<string>();
  const re = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) ids.add(m[1]);
  return [...ids];
}

test('Metrics tab: #metrics-table becomes visible (CSS-aware) after an agentMetrics state update', async () => {
  const mainSrc = readFileSync(MAIN_JS_PATH, 'utf8');
  const metricsMarkup = extractMetricsBodyMarkup(PANEL_TS_PATH);

  const dom = new JSDOM(
    `<!doctype html><html><body>${metricsMarkup}</body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://webview.local/' }
  );
  const win: any = dom.window;
  const doc = win.document;

  // Fill in every other id main.js expects, generically — this test only
  // cares about the Metrics-tab elements, which already exist from the real
  // markup above and must NOT be clobbered.
  for (const id of scanElementIds(mainSrc)) {
    if (doc.getElementById(id)) continue;
    const el = doc.createElement(id.toLowerCase().includes('stage') || id.toLowerCase().includes('canvas') ? 'canvas' : 'div');
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

  let stateStore: any = {};
  win.acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => stateStore,
    setState: (s: any) => { stateStore = s; },
  });

  const rafQueue: Array<(ts: number) => void> = [];
  win.requestAnimationFrame = (cb: (ts: number) => void) => { rafQueue.push(cb); return rafQueue.length; };
  win.cancelAnimationFrame = () => {};
  win.Image = class {
    onload: any = null;
    src = '';
    set onerror(_v: any) {}
  };
  win.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, { get: () => () => {} });
  };
  win.HTMLCanvasElement.prototype.toDataURL = () => '';

  const errors: any[] = [];
  win.addEventListener('error', (e: any) => errors.push(e && (e.error || e.message) ? e.error || e.message : e));
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => errors.push(err || msg);

  vm.runInContext(mainSrc, dom.getInternalVMContext(), { filename: 'media/main.js' });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  function tick(n: number) {
    for (let i = 0; i < n; i++) {
      const cbs = rafQueue.splice(0);
      for (const cb of cbs) {
        try { cb(16 * (i + 1)); } catch (e) { errors.push(e); }
      }
    }
  }
  tick(3);

  win.dispatchEvent(new win.MessageEvent('message', { data: buildStatePayload() }));
  tick(5);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(errors.length, 0, `main.js threw:\n${errors.map((e) => (e && e.stack) || String(e)).join('\n---\n')}`);

  const tableEl = doc.getElementById('metrics-table');
  const tbodyEl = doc.getElementById('metrics-tbody');
  assert.ok(tableEl, '#metrics-table should exist (from the real panel.ts markup)');
  assert.ok(tbodyEl, '#metrics-tbody should exist');
  assert.ok(tbodyEl!.children.length > 0, '#metrics-tbody should have agent rows after the state update');

  const hiddenSelectors = parseHiddenSelectors();
  assert.ok(
    isVisible(tableEl as any, hiddenSelectors),
    '#metrics-table should be CSS-visible after renderMetricsTable() runs with agent data ' +
    '(this is the exact v0.0.647 regression: a class rule stayed applied because only ' +
    'style.display was cleared)'
  );

  win.close();
});
