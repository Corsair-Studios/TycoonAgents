/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p81-t2: DOM-order and label coverage for the p81-t1 Tycoon Themes list row
// redesign (media/src/main/030-theme-picker-list.js renderThemesList,
// ~line 17-118, built into media/main.js). Runs against the BUILT bundle
// (TYCOON_WEBVIEW_BUNDLE override) so it exercises the real renderer, and
// must fail against the v0.0.646 bundle where rows put status text inline
// with the name and used "Review images"/"Export .zip" button labels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

const MAIN_JS_PATH = process.env.TYCOON_WEBVIEW_BUNDLE || join(process.cwd(), 'media', 'main.js');

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
  return 'div';
}

const RUNTIME_CREATED_IDS = new Set([
  'rebirth-announce',
  'rebirth-panel',
  'menu-edit-stage',
  'settings-modal-close',
  'stage-edit-panel',
  'theme-builder-shell-continue-help',
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
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = false;
    naturalWidth = 64;
    naturalHeight = 64;
    private _src = '';
    get src() {
      return this._src;
    }
    set src(v: string) {
      this._src = v;
      this.complete = true;
      win.setTimeout(() => {
        if (this.onload) this.onload();
      }, 0);
    }
  };
}

const MINIMAL_MARKUP = `
  <button id="tab-theme-builder" class="skill-btn primary theme-builder-launch">Tycoon Theme Builder</button>
  <div id="theme-picker-list" role="tabpanel">
    <div id="theme-picker-grid"></div>
  </div>
  <div id="theme-builder-panel" role="tabpanel" hidden>
    <button id="tab-theme-picker" class="skill-btn">&larr; Back to themes</button>
    <div id="theme-builder-root"></div>
  </div>
`;

async function bootHarness() {
  const src = readFileSync(MAIN_JS_PATH, 'utf8');
  const dom = new JSDOM(`<!doctype html><html><body>${MINIMAL_MARKUP}</body></html>`, {
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

  win.acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => ({}),
    setState: () => {},
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
    return 'data:image/png;base64,AA==';
  };

  const errors: any[] = [];
  win.addEventListener('error', (e: any) => {
    errors.push(e && (e.error || e.message) ? e.error || e.message : e);
  });
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => errors.push(err || msg);

  vm.runInContext(src, dom.getInternalVMContext(), { filename: 'media/main.js' });
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(errors.length, 0, `main.js threw on boot:\n${errors.map(String).join('\n')}`);

  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  return { win, doc, dispatch };
}

const TWO_THEME_LIST = [
  {
    theme_id: 'theme_a',
    display_name: 'A Very Long Theme Name That Should Not Push The Status Text Around',
    export_ready: false,
    accepted: 2,
    total: 4,
    size_bytes: 2048,
  },
  {
    theme_id: 'theme_b',
    display_name: 'Ready Theme',
    export_ready: true,
    accepted: 4,
    total: 4,
    size_bytes: 4096,
  },
];

test('each theme row has .theme-picker-name before .theme-picker-meta in DOM order, with status/badge inside .theme-picker-meta', async () => {
  const h = await bootHarness();
  try {
    const { doc } = h;
    h.dispatch({ type: 'THEMES_LIST', payload: { themes: TWO_THEME_LIST } });
    await new Promise((r) => setTimeout(r, 0));

    const rows = doc.querySelectorAll('.theme-picker-row');
    assert.equal(rows.length, 2, 'expected two rendered theme rows');

    for (const row of Array.from(rows) as any[]) {
      const nameEl = row.querySelector('.theme-picker-name');
      const metaEl = row.querySelector('.theme-picker-meta');
      assert.ok(nameEl, 'expected .theme-picker-name in each row');
      assert.ok(metaEl, 'expected .theme-picker-meta in each row');

      // DOM-order check: name precedes meta among all descendants of the row.
      const walker = doc.createTreeWalker(row, 1 /* NodeFilter.SHOW_ELEMENT */);
      let sawName = false;
      let sawMeta = false;
      let nameFirst: boolean | null = null;
      let node = walker.nextNode();
      while (node) {
        if (!sawName && node === nameEl) sawName = true;
        if (!sawMeta && node === metaEl) {
          sawMeta = true;
          nameFirst = sawName;
        }
        node = walker.nextNode();
      }
      assert.equal(nameFirst, true, '.theme-picker-name must precede .theme-picker-meta in DOM order');

      // Status text (approval label) lives inside .theme-picker-meta, not
      // .theme-picker-name.
      assert.match(
        metaEl.textContent || '',
        /approved|Ready to export|Review required/,
        '.theme-picker-meta must contain the status text',
      );
      assert.equal(
        /approved|Ready to export|Review required/.test(nameEl.textContent || ''),
        false,
        '.theme-picker-name must not contain status text',
      );
    }

    // The ready theme (theme_b) is export_ready — its meta shows "Ready to export".
    const readyRow = Array.from(rows).find((r: any) => (r.querySelector('.theme-picker-name')?.textContent || '') === 'Ready Theme') as any;
    assert.ok(readyRow, 'expected to find the Ready Theme row');
    assert.match(readyRow.querySelector('.theme-picker-meta').textContent, /Ready to export/);
  } finally {
    h.win.close();
  }
});

test('a SELECTED badge, when present, lives inside .theme-picker-meta after the name', async () => {
  const h = await bootHarness();
  try {
    const { doc, win } = h;
    h.dispatch({ type: 'THEMES_LIST', payload: { themes: TWO_THEME_LIST } });
    await new Promise((r) => setTimeout(r, 0));

    // Select theme_a via its row's select button, then re-render happens
    // internally (renderThemesList(lastThemesList) inside the click handler).
    const rows = doc.querySelectorAll('.theme-picker-row');
    const selectBtn = rows[0].querySelector('.theme-picker-select');
    assert.ok(selectBtn, 'expected the theme-picker-select button');
    selectBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const updatedRows = doc.querySelectorAll('.theme-picker-row');
    const selectedRow = Array.from(updatedRows).find((r: any) => r.classList.contains('theme-picker-row--selected')) as any;
    assert.ok(selectedRow, 'expected a row with theme-picker-row--selected');

    const badge = selectedRow.querySelector('.theme-selected-badge');
    assert.ok(badge, 'expected a .theme-selected-badge');
    const metaEl = selectedRow.querySelector('.theme-picker-meta');
    assert.ok(metaEl.contains(badge), '.theme-selected-badge must live inside .theme-picker-meta');
    assert.equal((badge.textContent || '').trim(), 'Selected');
  } finally {
    h.win.close();
  }
});

test('list row buttons are labelled exactly "Review" and "Export" with full-meaning aria-labels', async () => {
  const h = await bootHarness();
  try {
    const { doc } = h;
    h.dispatch({ type: 'THEMES_LIST', payload: { themes: TWO_THEME_LIST } });
    await new Promise((r) => setTimeout(r, 0));

    const rows = doc.querySelectorAll('.theme-picker-row');
    for (const row of Array.from(rows) as any[]) {
      const buttons = Array.from(row.querySelectorAll('button')) as any[];
      const reviewBtn = buttons.find((b) => (b.textContent || '').trim() === 'Review');
      const exportBtn = buttons.find((b) => (b.textContent || '').trim() === 'Export');
      assert.ok(reviewBtn, 'expected a button with exact text "Review"');
      assert.ok(exportBtn, 'expected a button with exact text "Export"');
      assert.equal(reviewBtn.getAttribute('aria-label'), 'Review images');
      assert.equal(exportBtn.getAttribute('aria-label'), 'Export .zip');
    }
  } finally {
    h.win.close();
  }
});
