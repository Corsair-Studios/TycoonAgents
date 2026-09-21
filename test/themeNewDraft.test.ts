/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p76-t3: webview coverage for the manual new-theme draft flow
// (media/src/main/010-modals-badges-rebirth.js's enterNewThemeDraftMode /
// buildEmptyThemePlan / Save theme + New theme buttons, and
// 060-theme-image-review.js's THEME_PLAN_SAVED / THEME_PLAN_READY handling).
// Harness copied from test/themeServicePanel.test.ts's bootThemePanelHarness
// (JSDOM + vm.runInContext against the built media/main.js bundle).

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

// Real markup fragment for the theme-builder panel (src/host/vscode/panel.ts
// ~10055-10163), trimmed to what this flow needs: the tab buttons, the
// hidden/visible attributes on theme-plan-editor / theme-image-review /
// theme-builder-panel / theme-picker-list as they really start, and the
// `.theme-plan-header` / `.theme-plan-footer-actions` containers the Save
// theme / New theme buttons are appended into by class selector (not id).
const THEME_BUILDER_MARKUP = `
  <button id="tab-theme-builder" class="skill-btn primary theme-builder-launch">Tycoon Theme Builder</button>
  <span id="theme-builder-credits-chip" class="theme-credits-chip" hidden></span>
  <div id="theme-picker-list" role="tabpanel"></div>
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

async function openThemeBuilderOnEmptyDraft() {
  const h = await bootThemePanelHarness();
  h.click('tab-theme-builder');
  await new Promise((r) => setTimeout(r, 0));
  return h;
}

// ── Blank-draft render on open ──────────────────────────────────────────────

// p79-t3: rewritten for the approved Start screen — the plan editor (with
// its 83 fixed slot rows) is an ai-screen-only surface, built once an
// AI-generated plan lands (THEME_PLAN_READY). A fresh, no-plan open of the
// Theme Builder tab lands on Start: name field + choice row, plan editor and
// board review both hidden. Slot-row counts are covered by the ai-path
// test in test/themeBuilderScreens.test.ts (dispatches THEME_PLAN_READY).
test('clicking the Theme Builder tab with no plan renders the Start screen: plan editor and board review both hidden', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    assert.ok(doc.getElementById('theme-plan-editor').hasAttribute('hidden'), 'plan editor must stay hidden on the Start screen');

    const nameInput = doc.getElementById('theme-plan-name');
    assert.ok(nameInput, 'theme-plan-name field must exist');
    assert.equal((nameInput.value || ''), '');

    // Review generated images stays hidden before anything is saved.
    const review = doc.getElementById('theme-image-review');
    assert.ok(review.hasAttribute('hidden'), 'theme-image-review must be hidden before the first save');
  } finally {
    h.win.close();
  }
});

// ── Save theme flow ──────────────────────────────────────────────────────

function fillFirstSlot(doc: any, containerId: string, value: string) {
  const container = doc.getElementById(containerId);
  const input = container.querySelector('.theme-plan-slot-row input[type="text"]');
  assert.ok(input, `expected a text input in #${containerId}`);
  input.value = value;
  input.dispatchEvent(new (input.ownerDocument.defaultView as any).Event('input', { bubbles: true }));
}

test('typing values then clicking Save theme posts saveThemePlan with those values and no theme_id', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const nameInput = doc.getElementById('theme-plan-name');
    nameInput.value = 'My Hand-Built Theme';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const directionInput = doc.getElementById('theme-plan-direction');
    if (directionInput) {
      directionInput.value = 'Bright cartoon style.';
      directionInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    }

    fillFirstSlot(doc, 'theme-plan-characters', 'Captain Byrd');

    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));

    const posted = h.lastPosted('saveThemePlan');
    assert.ok(posted, 'expected a saveThemePlan message to be posted');
    assert.equal(posted.plan.display_name, 'My Hand-Built Theme');
    assert.equal(posted.plan.characters[0], 'Captain Byrd');
    assert.ok(posted.theme_id === undefined || posted.theme_id === null, `theme_id must be null/undefined on first save, got ${JSON.stringify(posted.theme_id)}`);
  } finally {
    h.win.close();
  }
});

test('THEME_PLAN_SAVED sets the draft id, a second Save posts the returned theme_id, and reveals the review section bound to it', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const nameInput = doc.getElementById('theme-plan-name');
    nameInput.value = 'Second Save Theme';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));
    const firstSave = h.lastPosted('saveThemePlan');
    assert.ok(firstSave.theme_id === undefined || firstSave.theme_id === null);

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'second_save_theme', plan: { ...firstSave.plan, theme_id: 'second_save_theme' } },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Review section reveals bound to the saved id.
    const review = doc.getElementById('theme-image-review');
    assert.ok(!review.hasAttribute('hidden'), 'theme-image-review must be revealed after THEME_PLAN_SAVED');
    const reviewGet = h.lastPosted('GET_THEME_IMAGE_REVIEW');
    assert.ok(reviewGet, 'expected GET_THEME_IMAGE_REVIEW to be posted after save');
    assert.equal(reviewGet.payload.theme_id, 'second_save_theme');

    // A second Save theme click must carry the assigned theme_id forward.
    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));
    const secondSave = h.lastPosted('saveThemePlan');
    assert.equal(secondSave.theme_id, 'second_save_theme', 'second save must reuse the theme_id THEME_PLAN_SAVED returned');
  } finally {
    h.win.close();
  }
});

// ── THEME_PLAN_READY overwrite confirm ──────────────────────────────────────

test('THEME_PLAN_READY with typed content shows an inline confirm and does not overwrite until confirmed', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const nameInput = doc.getElementById('theme-plan-name');
    nameInput.value = 'Typed By Hand';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    h.dispatch({
      type: 'THEME_PLAN_READY',
      payload: { plan: { display_name: 'AI Generated Name', characters: new Array(16).fill('AI Char') } },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Not yet overwritten.
    assert.equal(doc.getElementById('theme-plan-name').value, 'Typed By Hand');
    const validation = doc.getElementById('theme-plan-validation');
    assert.ok(validation && (validation.textContent || '').length > 0, 'expected an inline confirm message');
    const overwriteBtn = Array.from(validation.querySelectorAll('button')).find((b: any) => (b.textContent || '').trim() === 'Overwrite') as any;
    assert.ok(overwriteBtn, 'expected an Overwrite button in the inline confirm');

    overwriteBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(doc.getElementById('theme-plan-name').value, 'AI Generated Name', 'confirming Overwrite must apply the AI plan');
  } finally {
    h.win.close();
  }
});

test('THEME_PLAN_READY with empty fields fills directly with no confirm', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    h.dispatch({
      type: 'THEME_PLAN_READY',
      payload: { plan: { display_name: 'Direct Fill Name', characters: new Array(16).fill('AI Char') } },
    });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(doc.getElementById('theme-plan-name').value, 'Direct Fill Name');
    const validation = doc.getElementById('theme-plan-validation');
    assert.equal((validation.textContent || '').trim(), '', 'no confirm prompt expected when nothing was typed');
  } finally {
    h.win.close();
  }
});
