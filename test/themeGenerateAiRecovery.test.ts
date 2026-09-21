/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p84: webview coverage for two Tycoon Theme Builder Start-screen bugs.
//
// Bug A: "Generate with AI" (themeGenerateWithAiBtn) was disabled by
// runThemeGeneratePlan (media/src/main/010-modals-badges-rebirth.js) on
// every PLAN_THEME attempt, but only THEME_PLAN_READY re-enabled a button
// -- and only the legacy themeGenerateBtn, never themeGenerateWithAiBtn.
// THEME_PLAN_ERROR left it disabled forever after any failed attempt. This
// test proves "Generate with AI" is re-enabled (and clickable) after a
// THEME_PLAN_ERROR.
//
// Bug B: a THEME_PLAN_ERROR of kind "not_signed_in" appends a "Sign in"
// button into #theme-build-status; nothing cleared it once the user
// actually signed in. This test proves it is gone after a THEME_SERVICE_STATUS
// with signedIn:true.
//
// Runs against the BUILT media/main.js bundle (TYCOON_WEBVIEW_BUNDLE
// override, same pattern as test/themeBuilderEntryReset.test.ts) and must
// FAIL against the pre-p84 bundle, where "Generate with AI" stays disabled
// after THEME_PLAN_ERROR and the stale Sign-in button survives sign-in.
//
// Harness (bootThemePanelHarness) copied verbatim from
// test/themeBuilderEntryReset.test.ts.

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

test('Generate with AI stays clickable after a THEME_PLAN_ERROR (not permanently dead)', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    // Signed in with credits, so the click below runs the plan request
    // directly instead of opening the sign-in modal.
    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true, email: 'a@b.com', credits: 50 } });
    await new Promise((r) => setTimeout(r, 0));

    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Space Pirates';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const aiBtn = doc.getElementById('theme-generate-with-ai-btn');
    assert.ok(aiBtn, 'expected "Generate with AI" button to be created');
    assertVisible(aiBtn, '#theme-generate-with-ai-btn');
    assert.equal(aiBtn.hasAttribute('disabled'), false, 'must start enabled');

    aiBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(aiBtn.hasAttribute('disabled'), true, 'must disable while the PLAN_THEME request is in flight');

    // Backend was down: the request fails.
    h.dispatch({ type: 'THEME_PLAN_ERROR', payload: { kind: 'unavailable', message: 'Theme Service unavailable' } });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      aiBtn.hasAttribute('disabled'),
      false,
      'BUG: "Generate with AI" stayed disabled after THEME_PLAN_ERROR — permanently dead button',
    );
    assertVisible(aiBtn, '#theme-generate-with-ai-btn (after THEME_PLAN_ERROR)');

    // A second attempt must be possible.
    aiBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(aiBtn.hasAttribute('disabled'), true, 'second click must start a new in-flight request');
  } finally {
    h.win.close();
  }
});

test('a stale "Sign in" prompt in #theme-build-status is cleared once THEME_SERVICE_STATUS reports signedIn', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Space Pirates';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    // Signed out: an attempt fails with not_signed_in and leaves a "Sign in"
    // button in #theme-build-status.
    h.dispatch({ type: 'THEME_PLAN_ERROR', payload: { kind: 'not_signed_in', message: 'Sign in required' } });
    await new Promise((r) => setTimeout(r, 0));

    const buildStatus = doc.getElementById('theme-build-status');
    const staleSignInBtn = Array.from(buildStatus.querySelectorAll('button')).find(
      (b: any) => (b.textContent || '').trim() === 'Sign in',
    );
    assert.ok(staleSignInBtn, 'expected THEME_PLAN_ERROR not_signed_in to append a Sign in button');

    // User signs in.
    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true, email: 'a@b.com', credits: 50 } });
    await new Promise((r) => setTimeout(r, 0));

    const remainingSignInBtn = Array.from(buildStatus.querySelectorAll('button')).find(
      (b: any) => (b.textContent || '').trim() === 'Sign in',
    );
    assert.equal(
      remainingSignInBtn,
      undefined,
      'BUG: stale "Sign in" prompt in #theme-build-status survived signing in',
    );
  } finally {
    h.win.close();
  }
});
