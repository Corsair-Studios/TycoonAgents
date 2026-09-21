/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p81-t2: webview coverage for the p81-t1 fix — the Tycoon Theme Builder
// button (tabThemeBuilder, media/src/main/010-modals-badges-rebirth.js
// ~2362-2377) always calls openThemeBuilderPlanEditorTab({forceStart: true})
// (~1678-1745), which must land on the Start screen with an empty name
// unless a generation is running (themeGenerationRunning), even after the
// user has just reviewed an existing theme's boards via that theme's list
// row "Review" button (media/src/main/030-theme-picker-list.js). This test
// runs against the BUILT media/main.js bundle (TYCOON_WEBVIEW_BUNDLE
// override, same as test/themeBuilderEntry.test.ts) and must fail against
// the v0.0.646 bundle, where the builder button preserved whatever
// draft/review state (including reviewThemeId) was already showing.
//
// Harness (bootThemePanelHarness, assertVisible, click/dispatch/lastPosted)
// copied verbatim from test/themeBuilderEntry.test.ts.

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

const THEME_BUILDER_MARKUP = `
  <button id="tab-theme-builder" class="skill-btn primary theme-builder-launch">Tycoon Theme Builder</button>
  <span id="theme-builder-credits-chip" class="theme-credits-chip" hidden></span>
  <div id="theme-picker-list" role="tabpanel">
    <div id="theme-picker-grid"></div>
  </div>
  <div id="theme-builder-panel" role="tabpanel" hidden>
    <button id="tab-theme-picker" class="skill-btn">&larr; Back to themes</button>
    <div id="theme-prompt-container" class="theme-prompt-container">
      <input type="text" id="theme-prompt-input" placeholder="Name or describe a new theme" />
      <button id="theme-generate-btn" class="skill-btn">Plan theme</button>
    </div>
    <section id="theme-plan-editor" class="theme-plan-editor" hidden>
      <div class="theme-plan-header">
        <div><h3>Review the theme plan</h3></div>
      </div>
      <label class="theme-plan-field theme-plan-field--primary">
        <span>Theme name</span>
        <input id="theme-plan-name" type="text" />
      </label>
      <label class="theme-plan-field">
        <span>Creative direction</span>
        <textarea id="theme-plan-direction" rows="3"></textarea>
      </label>
      <fieldset class="theme-plan-group">
        <div id="theme-plan-characters" class="theme-plan-slots"></div>
      </fieldset>
      <label class="theme-plan-field">
        <span>Environment</span>
        <textarea id="theme-plan-environment" rows="3"></textarea>
      </label>
      <fieldset class="theme-plan-group">
        <div id="theme-plan-enemies" class="theme-plan-slots"></div>
      </fieldset>
      <fieldset class="theme-plan-group">
        <div id="theme-plan-objects-slots" class="theme-plan-slots"></div>
        <label class="theme-plan-field theme-plan-field--sub">
          <span>Crate</span>
          <textarea id="theme-plan-crate-desc" rows="2"></textarea>
        </label>
        <label class="theme-plan-field theme-plan-field--sub">
          <span>Poof effect</span>
          <textarea id="theme-plan-poof-desc" rows="2"></textarea>
        </label>
        <label class="theme-plan-field theme-plan-field--sub">
          <span>Ranged projectile</span>
          <textarea id="theme-plan-projectile-desc" rows="2"></textarea>
        </label>
      </fieldset>
      <fieldset class="theme-plan-group">
        <div id="theme-plan-decor-slots" class="theme-plan-slots"></div>
      </fieldset>
      <fieldset class="theme-plan-group">
        <div id="theme-plan-expressions-slots" class="theme-plan-slots"></div>
      </fieldset>
      <fieldset class="theme-plan-group">
        <div id="theme-plan-achievements-slots" class="theme-plan-slots"></div>
      </fieldset>
      <div class="theme-plan-footer">
        <div id="theme-plan-validation" class="theme-plan-validation" role="status"></div>
        <div class="theme-plan-footer-actions">
          <label for="theme-pause-for-review">
            <input id="theme-pause-for-review" type="checkbox" checked />
          </label>
          <button id="theme-start-generation-btn" class="skill-btn">Generate images</button>
        </div>
      </div>
    </section>
    <div id="theme-build-status"></div>
    <div id="theme-build-actions" hidden>
      <button id="theme-review-images-btn" class="skill-btn">Review generated images</button>
    </div>
    <section id="theme-image-review" class="theme-image-review" hidden>
      <div class="theme-image-review-header">
        <div>
          <h3 id="theme-image-review-title">Generated images</h3>
          <div id="theme-image-review-summary" class="theme-image-review-summary"></div>
        </div>
        <div class="theme-image-review-header-actions">
          <button id="theme-review-resume-generation" class="skill-btn" hidden>Resume generation</button>
          <button id="theme-review-stop-generation" class="skill-btn" hidden>Stop generation</button>
          <button id="theme-approve-all" class="skill-btn">Approve all</button>
          <button id="theme-open-images-folder" class="skill-btn">Open folder</button>
          <button id="theme-health-check-btn" class="skill-btn">Check theme health</button>
        </div>
      </div>
      <div id="theme-health-results" class="theme-health-results" hidden></div>
      <div id="theme-image-review-list" class="theme-image-review-list"></div>
    </section>
    <div id="theme-builder-root"></div>
  </div>
`;

async function bootThemePanelHarness() {
  const src = readFileSync(MAIN_JS_PATH, 'utf8');
  const dom = new JSDOM(`<!doctype html><html><body>${THEME_BUILDER_MARKUP}</body></html>`, {
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
  win.acquireVsCodeApi = () => ({
    postMessage: (m: any) => {
      posted.push(m);
    },
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

  function lastPosted(type?: string): any {
    for (let i = posted.length - 1; i >= 0; i--) {
      if (!type || posted[i].type === type) return posted[i];
    }
    return undefined;
  }

  function click(id: string): void {
    const el = doc.getElementById(id);
    assert.ok(el, `expected element #${id} to exist`);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }

  return { win, doc, dom, dispatch, posted, lastPosted, click };
}

// p78-t2: walks an element's ancestor chain (parentElement) up to the
// document, failing if any ancestor carries the `hidden` attribute or an
// inline `display: none`.
function assertVisible(el: any, label?: string): void {
  const what = label || (el && el.id ? `#${el.id}` : 'element');
  assert.ok(el, `expected ${what} to exist`);
  let node = el;
  while (node) {
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) {
      assert.fail(`${what} is not visible: ancestor <${node.tagName}${node.id ? ` #${node.id}` : ''}> has [hidden]`);
    }
    if (node.style && node.style.display === 'none') {
      assert.fail(`${what} is not visible: ancestor <${node.tagName}${node.id ? ` #${node.id}` : ''}> has display:none`);
    }
    node = node.parentElement;
  }
}

function assertNotVisible(el: any, label?: string): void {
  const what = label || (el && el.id ? `#${el.id}` : 'element');
  assert.ok(el, `expected ${what} to exist`);
  let node = el;
  while (node) {
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return;
    if (node.style && node.style.display === 'none') return;
    node = node.parentElement;
  }
  assert.fail(`${what} was expected to be hidden but has no hidden ancestor`);
}

const ONE_THEME_LIST = [
  {
    theme_id: 'theme_a',
    display_name: 'Car Showroom Collector',
    export_ready: false,
    accepted: 1,
    total: 4,
    size_bytes: 1024,
  },
];

test('reviewing theme A, going Back to themes, then clicking the builder button lands on Start with an empty name and no board grid', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.dispatch({ type: 'THEMES_LIST', payload: { themes: ONE_THEME_LIST } });
    await new Promise((r) => setTimeout(r, 0));

    // Click theme A's "Review" button (list row rendered by renderThemesList).
    const rows = doc.querySelectorAll('.theme-picker-row');
    assert.equal(rows.length, 1, 'expected exactly one rendered theme row');
    const reviewBtn = Array.from(rows[0].querySelectorAll('button')).find(
      (b: any) => (b.textContent || '').trim() === 'Review',
    ) as any;
    assert.ok(reviewBtn, 'expected a "Review" button on theme A\'s row');
    reviewBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    // Host would normally answer GET_THEME_IMAGE_REVIEW; simulate its reply
    // so theme A's boards are actually visible before navigating away.
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'theme_a',
        display_name: 'Car Showroom Collector',
        hasBoards: true,
        items: [
          { id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment', status: 'accepted', prompt: 'p', revision: 0, frame_keys: [], updated_at: '' },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    assertVisible(doc.getElementById('theme-image-review'), '#theme-image-review (theme A boards)');
    assert.match(doc.getElementById('theme-image-review-title').textContent || '', /Car Showroom Collector/);

    // Back to themes.
    h.click('tab-theme-picker');
    await new Promise((r) => setTimeout(r, 0));

    // Now the entry point under test: the Tycoon Theme Builder button.
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    // Start screen: name field empty and visible.
    const promptInput = doc.getElementById('theme-prompt-input');
    assertVisible(promptInput, '#theme-prompt-input');
    assert.equal(promptInput.value, '', 'name input must be empty on a fresh Start screen');

    // Board grid hidden.
    assertNotVisible(doc.getElementById('theme-image-review'), '#theme-image-review must be hidden on Start');

    // No header title showing theme A's name (the header bar is hidden on Start).
    assertNotVisible(doc.getElementById('theme-builder-header-bar'), '#theme-builder-header-bar must be hidden on Start');
  } finally {
    h.win.close();
  }
});

test('with a generation running, the Tycoon Theme Builder button keeps that run visible instead of resetting to Start', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Gen Theme';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));
    const saved = h.lastPosted('saveThemePlan');
    assert.ok(saved, 'expected saveThemePlan to start the draft');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'gen_theme', plan: { ...saved.plan, theme_id: 'gen_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Simulate an in-progress AI batch generation for this draft.
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'gen_theme',
        display_name: 'Gen Theme',
        hasBoards: false,
        generation_active: true,
        items: [
          { id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment', status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: '' },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    assertVisible(doc.getElementById('theme-image-review'), '#theme-image-review must be visible while generation is running');

    // Back to themes, then the builder button again.
    h.click('tab-theme-picker');
    await new Promise((r) => setTimeout(r, 0));
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    // The run must still be visible — not reset to an empty Start screen.
    assertVisible(doc.getElementById('theme-image-review'), '#theme-image-review must stay visible: an active run must not be lost');
  } finally {
    h.win.close();
  }
});

test('Review on a list row still opens that theme\'s boards', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.dispatch({ type: 'THEMES_LIST', payload: { themes: ONE_THEME_LIST } });
    await new Promise((r) => setTimeout(r, 0));

    const rows = doc.querySelectorAll('.theme-picker-row');
    const reviewBtn = Array.from(rows[0].querySelectorAll('button')).find(
      (b: any) => (b.textContent || '').trim() === 'Review',
    ) as any;
    reviewBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const getReview = h.lastPosted('GET_THEME_IMAGE_REVIEW');
    assert.ok(getReview, 'expected GET_THEME_IMAGE_REVIEW to be posted');
    assert.equal(getReview.payload.theme_id, 'theme_a');
    assertVisible(doc.getElementById('theme-builder-panel'), '#theme-builder-panel');
  } finally {
    h.win.close();
  }
});
