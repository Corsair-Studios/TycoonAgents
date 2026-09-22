/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p86: webview coverage for the stale-plan-overwrite bug — a slow
// THEME_PLAN_READY/THEME_PLAN_ERROR reply for an EARLIER PLAN_THEME request
// (e.g. the user typed "monkeys", got impatient, cleared the draft and typed
// "Ghouls") must never land after a newer request has started or the draft
// was cleared. media/src/main/010-modals-badges-rebirth.js's
// runThemeGeneratePlan now stamps every PLAN_THEME with a monotonic
// requestId, echoed back by the host; 060-theme-image-review.js's
// THEME_PLAN_READY/ERROR handlers drop any reply whose requestId doesn't
// match the latest.
//
// Also covers the credits chip: it must show a cached/pending indicator
// immediately rather than sitting blank on first open (updateThemeBuilderCreditsChip).
//
// Runs against the BUILT media/main.js bundle (TYCOON_WEBVIEW_BUNDLE
// override) and must FAIL against the pre-p86 bundle, where THEME_PLAN_READY
// has no requestId to check and always overwrites the currently-rendered
// plan.
//
// Harness (bootThemePanelHarness) copied verbatim from
// test/themeGenerateAiRecovery.test.ts.

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

  function click(id: string): void {
    const el = doc.getElementById(id);
    assert.ok(el, `expected element #${id} to exist`);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }

  return { win, doc, dom, dispatch, posted, click };
}

test('a stale THEME_PLAN_READY (superseded PLAN_THEME request) does not overwrite the newer plan on screen', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true, email: 'a@b.com', credits: 50 } });
    await new Promise((r) => setTimeout(r, 0));

    const promptInput: any = doc.getElementById('theme-prompt-input');
    promptInput.value = 'monkeys';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const aiBtn: any = doc.getElementById('theme-generate-with-ai-btn');
    aiBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const firstPost = h.posted.filter((m) => m.type === 'PLAN_THEME').pop();
    assert.ok(firstPost, 'expected a PLAN_THEME message to be posted');
    assert.equal(typeof firstPost.payload.requestId, 'number', 'PLAN_THEME payload must carry a numeric requestId');

    // User gets impatient, clears the draft (Back to themes), then starts a
    // brand-new theme "Ghouls" — a second PLAN_THEME with a NEWER requestId.
    h.click('tab-theme-picker');
    await new Promise((r) => setTimeout(r, 0));
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    const promptInput2: any = doc.getElementById('theme-prompt-input');
    promptInput2.value = 'Ghouls';
    promptInput2.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    const aiBtn2: any = doc.getElementById('theme-generate-with-ai-btn');
    aiBtn2.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const secondPost = h.posted.filter((m) => m.type === 'PLAN_THEME').pop();
    assert.ok(secondPost, 'expected a second PLAN_THEME message');
    assert.notEqual(secondPost.payload.requestId, firstPost.payload.requestId, 'the second request must get a NEW requestId');

    // The slow "monkeys" reply finally lands, carrying the OLD requestId.
    h.dispatch({
      type: 'THEME_PLAN_READY',
      payload: {
        requestId: firstPost.payload.requestId,
        plan: { display_name: 'monkeys', creative_direction: 'Stale monkey theme.' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const nameField: any = doc.getElementById('theme-plan-name');
    assert.notEqual(
      nameField.value,
      'monkeys',
      'BUG: a stale THEME_PLAN_READY for a superseded request overwrote the plan currently on screen',
    );

    // The genuine "Ghouls" reply lands with the CURRENT requestId and must apply.
    h.dispatch({
      type: 'THEME_PLAN_READY',
      payload: {
        requestId: secondPost.payload.requestId,
        plan: { display_name: 'Ghouls', creative_direction: 'A spooky ghoul theme.' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(nameField.value, 'Ghouls', 'the current request\'s THEME_PLAN_READY must apply');
  } finally {
    h.win.close();
  }
});

test('a stale THEME_PLAN_ERROR (superseded PLAN_THEME request) does not clobber the in-flight status of a newer request', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true, email: 'a@b.com', credits: 50 } });
    await new Promise((r) => setTimeout(r, 0));

    const promptInput: any = doc.getElementById('theme-prompt-input');
    promptInput.value = 'monkeys';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    const aiBtn: any = doc.getElementById('theme-generate-with-ai-btn');
    aiBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const firstPost = h.posted.filter((m) => m.type === 'PLAN_THEME').pop();

    promptInput.value = 'Ghouls';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    aiBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(aiBtn.hasAttribute('disabled'), true, 'second (current) request must be in flight');

    // The stale "monkeys" failure lands after the newer request started.
    h.dispatch({
      type: 'THEME_PLAN_ERROR',
      payload: { requestId: firstPost.payload.requestId, message: 'stale failure', kind: 'unavailable' },
    });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      aiBtn.hasAttribute('disabled'),
      true,
      'BUG: a stale THEME_PLAN_ERROR re-enabled the button while the CURRENT request is still in flight',
    );
  } finally {
    h.win.close();
  }
});

test('the credits chip is never left blank/hidden while THEME_SERVICE_STATUS is still pending', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    const chip: any = doc.getElementById('theme-builder-credits-chip');

    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({ type: 'THEME_BUILDER_OPENED', payload: { signedIn: false, pending: true } });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      chip.hasAttribute('hidden'),
      false,
      'BUG: credits chip stayed hidden while the initial status is still pending',
    );
  } finally {
    h.win.close();
  }
});

// p87: opening the Tycoon Themes modal itself must (a) request fresh status
// every time, and (b) never leave the credits chip fully hidden for a
// signed-in user just because the status reply carried an error/no credits
// (e.g. a Render cold-start timeout) instead of a clean signedIn+credits
// payload. Must FAIL against the pre-p87 bundle, where updateThemeBuilderCreditsChip
// hid the chip outright whenever status.credits wasn't a number, and the
// menu-themes click handler never posted requestThemeServiceStatus.
test('opening Tycoon Themes requests fresh status and the credits chip stays visible for a signed-in user with 48 credits', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    const chip: any = doc.getElementById('theme-builder-credits-chip');

    h.posted.length = 0;
    h.click('menu-themes');
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(
      h.posted.some((m) => m.type === 'requestThemeServiceStatus'),
      'BUG: opening the Tycoon Themes modal did not request fresh Theme Service status',
    );

    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true, email: 'a@b.com', credits: 48 } });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(chip.hasAttribute('hidden'), false, 'chip must be visible for a signed-in user with credits');
    assert.equal(chip.textContent, '48 credits');
  } finally {
    h.win.close();
  }
});

test('credits chip falls back to cached balance (never hides) when a later status errors out for a signed-in user', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    const chip: any = doc.getElementById('theme-builder-credits-chip');

    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true, email: 'a@b.com', credits: 48 } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(chip.textContent, '48 credits');

    // A later status reply errors (cold-start timeout) but is still for the
    // signed-in user (signedIn carried true, credits omitted).
    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true, error: { kind: 'waking', message: 'Waking up…' } } });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      chip.hasAttribute('hidden'),
      false,
      'BUG: credits chip hid instead of falling back to the last cached balance on an error status',
    );
    assert.equal(chip.textContent, '48 credits', 'must show the last known cached balance');
  } finally {
    h.win.close();
  }
});
