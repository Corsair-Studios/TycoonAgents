/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests for renderThemeServicePanel (media/src/main/010-modals-badges-rebirth.js
// ~1544-1803) across its seven view states, updateThemeBuilderCreditsChip
// (#theme-builder-credits-chip), and 060-theme-image-review.js's
// THEME_BUILDER_OPENED / THEME_SERVICE_STATUS message wiring (~1231).
//
// Follows test/webviewSmoke.test.ts's harness style (JSDOM + vm.runInContext
// against the built media/main.js bundle) trimmed to a standalone boot, same
// technique as bootObjScaleHarness() there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

const MAIN_JS_PATH = join(process.cwd(), 'media', 'main.js');
const MAIN_SRC_PATH = join(process.cwd(), 'media', 'src', 'main', '010-modals-badges-rebirth.js');

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

async function bootThemePanelHarness() {
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
  // Flush any microtasks main.js's boot schedules.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(errors.length, 0, `main.js threw on boot:\n${errors.map(String).join('\n')}`);

  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  function panelText(): string {
    const body = doc.getElementById('theme-service-panel-body');
    return body ? body.textContent : '';
  }

  function panelBody(): any {
    return doc.getElementById('theme-service-panel-body');
  }

  function chip(): any {
    return doc.getElementById('theme-builder-credits-chip');
  }

  function lastPosted(type?: string): any {
    for (let i = posted.length - 1; i >= 0; i--) {
      if (!type || posted[i].type === type) return posted[i];
    }
    return undefined;
  }

  function clickButtonByText(text: string): void {
    const body = panelBody();
    // Sign out / Cancel / Resend link render as <a class="tsp-link"> via
    // tspLink(), not <button>, so match both interactive element kinds.
    const els: any[] = Array.from(body.querySelectorAll('button, a'));
    const el = els.find((b) => (b.textContent || '').trim() === text || (b.textContent || '').includes(text));
    assert.ok(el, `expected a button/link with text including "${text}"`);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }

  return { win, doc, dom, dispatch, panelText, panelBody, chip, posted, lastPosted, clickButtonByText, errors };
}

// ── Fixture payloads ────────────────────────────────────────────────────────

const PRICING = {
  typicalTheme: { min: 8, max: 20 },
  packs: [
    { id: 'mini30', credits: 30, priceCents: 500, currency: 'usd' },
    { id: 'mega150', credits: 150, priceCents: 2000, currency: 'usd' },
  ],
};

function signedOutStatus(overrides: any = {}) {
  return { signedIn: false, ...overrides };
}

function signedInStatus(overrides: any = {}) {
  return {
    signedIn: true,
    email: 'dev@example.com',
    provider: 'email',
    credits: 40,
    pricing: PRICING,
    ...overrides,
  };
}

function themeBuilderOpened(payload: any) {
  return { type: 'THEME_BUILDER_OPENED', payload };
}

function themeServiceStatus(payload: any) {
  return { type: 'THEME_SERVICE_STATUS', payload };
}

// ── THEME_BUILDER_OPENED / THEME_SERVICE_STATUS wiring ─────────────────────

test('THEME_BUILDER_OPENED renders the status then posts THEME_SERVICE_GET_STATUS once', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.match(h.panelText(), /Generate a theme/);
  const getStatusPosts = h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS');
  assert.equal(getStatusPosts.length, 1, 'THEME_BUILDER_OPENED should post exactly one THEME_SERVICE_GET_STATUS');
  h.win.close();
});

test('THEME_SERVICE_STATUS re-renders the panel without posting another GET_STATUS', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  const countAfterOpen = h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length;
  h.dispatch(themeServiceStatus(signedInStatus()));
  assert.match(h.panelText(), /dev@example.com/);
  const countAfterStatus = h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length;
  assert.equal(countAfterStatus, countAfterOpen, 'THEME_SERVICE_STATUS must not itself trigger another GET_STATUS');
  h.win.close();
});

// ── State: signed-out ────────────────────────────────────────────────────────

test('signed-out state renders Google button + email form, and Continue with Google posts GOOGLE_START', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.match(h.panelText(), /Continue with Google/);
  const emailInput = h.doc.getElementById('theme-service-email-input');
  assert.ok(emailInput, 'email input should render');

  h.clickButtonByText('Continue with Google');
  const googleStart = h.lastPosted('THEME_SERVICE_GOOGLE_START');
  assert.ok(googleStart, 'clicking Continue with Google should post THEME_SERVICE_GOOGLE_START');
  h.win.close();
});

test('signed-out state: Send sign-in link posts REQUEST_MAGIC_LINK with the entered email', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  const emailInput = h.doc.getElementById('theme-service-email-input');
  emailInput.value = 'me@example.com';
  h.clickButtonByText('Send sign-in link');
  const magicLink = h.lastPosted('THEME_SERVICE_REQUEST_MAGIC_LINK');
  assert.ok(magicLink, 'clicking Send sign-in link should post THEME_SERVICE_REQUEST_MAGIC_LINK');
  assert.equal(magicLink.email, 'me@example.com');
  h.win.close();
});

// ── State: google-wait ───────────────────────────────────────────────────────

test('google-wait state renders paste-code field and posts GOOGLE_COMPLETE', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  assert.match(h.panelText(), /Finish signing in with Google/);
  const codeInput = h.doc.getElementById('theme-service-google-code');
  assert.ok(codeInput, 'paste-code input should render in google-wait state');
  codeInput.value = 'pasted-code-123';
  h.clickButtonByText('Submit code');
  const complete = h.lastPosted('THEME_SERVICE_GOOGLE_COMPLETE');
  assert.ok(complete, 'Submit code should post THEME_SERVICE_GOOGLE_COMPLETE');
  assert.equal(complete.code, 'pasted-code-123');
  h.win.close();
});

// ── State: email-code ────────────────────────────────────────────────────────

test('email-code state renders 6-digit entry and posts VERIFY with email+code', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  const emailInput = h.doc.getElementById('theme-service-email-input');
  emailInput.value = 'coder@example.com';
  h.clickButtonByText('Send sign-in link');
  assert.match(h.panelText(), /Check your email/);
  assert.match(h.panelText(), /coder@example.com/);

  const boxes: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-code-boxes input'));
  assert.equal(boxes.length, 6, 'email-code state should render six single-digit boxes');
  '123456'.split('').forEach((digit, i) => {
    boxes[i].value = digit;
  });
  h.clickButtonByText('Confirm code');
  const verify = h.lastPosted('THEME_SERVICE_VERIFY');
  assert.ok(verify, 'Confirm code should post THEME_SERVICE_VERIFY');
  assert.equal(verify.email, 'coder@example.com');
  assert.equal(verify.code, '123456');
  h.win.close();
});

// ── State: signed-in ─────────────────────────────────────────────────────────

test('signed-in state renders email/provider, Sign out, credits, guidance, packs, caveat, prompt tips, and posts SIGN_OUT/BUY_CREDITS', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));

  const text = h.panelText();
  assert.match(text, /dev@example.com/);
  assert.match(text, /Email/); // provider label
  assert.match(text, /Sign out/);
  assert.match(text, /40 credits/);
  assert.match(text, /8.{1,3}20 credits/); // guidance range, en/em-dash tolerant
  assert.match(text, /Results depend on your prompts/); // caveat
  assert.match(text, /Prompt tips/);

  const tipsLink = Array.from(h.panelBody().querySelectorAll('a')).find(
    (a: any) => (a.textContent || '').trim() === 'Prompt tips',
  ) as any;
  assert.ok(tipsLink, 'Prompt tips link should render');
  assert.match(tipsLink.getAttribute('href') || '', /#prompt-tips$/);

  const packButtons: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-pack'));
  assert.equal(packButtons.length, 2, 'both pricing packs should render as buttons');

  h.clickButtonByText('Sign out');
  const signOut = h.lastPosted('THEME_SERVICE_SIGN_OUT');
  assert.ok(signOut, 'Sign out should post THEME_SERVICE_SIGN_OUT');

  h.dispatch(themeServiceStatus(signedInStatus()));
  const packButtonsAfter: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-pack'));
  packButtonsAfter[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const buy = h.lastPosted('THEME_SERVICE_BUY_CREDITS');
  assert.ok(buy, 'clicking a pack should post THEME_SERVICE_BUY_CREDITS');
  assert.equal(buy.pack, 'mini30');
  h.win.close();
});

test('insufficient-credits branch warns and disables the generate button', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ credits: 3 })));
  const text = h.panelText();
  assert.match(text, /Not enough credits/);
  const disabledBtn: any = Array.from(h.panelBody().querySelectorAll('button')).find((b: any) =>
    (b.textContent || '').includes('need more credits'),
  );
  assert.ok(disabledBtn, 'a disabled "need more credits" button should render');
  assert.equal(disabledBtn.disabled, true);
  h.win.close();
});

// ── State: pending-checkout ──────────────────────────────────────────────────

test('pending-checkout state renders "I completed payment" and posts GET_STATUS', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ pendingCheckout: true })));
  assert.match(h.panelText(), /Waiting for your purchase to complete/);
  h.clickButtonByText('I completed payment, refresh balance');
  const status = h.lastPosted('THEME_SERVICE_GET_STATUS');
  assert.ok(status, '"I completed payment" should post THEME_SERVICE_GET_STATUS');
  h.win.close();
});

// ── State: unreachable ────────────────────────────────────────────────────────

test('unreachable state renders error + Retry, and Retry posts GET_STATUS', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(
    themeBuilderOpened(
      signedOutStatus({ error: { kind: 'unreachable', message: 'Theme Service unavailable — no credits were charged.' } }),
    ),
  );
  assert.match(h.panelText(), /unavailable/i);
  const countBefore = h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length;
  h.clickButtonByText('Retry');
  const countAfter = h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length;
  assert.equal(countAfter, countBefore + 1, 'Retry should post THEME_SERVICE_GET_STATUS');
  h.win.close();
});

// ── Chip ──────────────────────────────────────────────────────────────────────

test('#theme-builder-credits-chip is visible only when signed in with numeric credits, and reads "N credits"', async () => {
  const h = await bootThemePanelHarness();

  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.ok(h.chip().hasAttribute('hidden'), 'chip should be hidden when signed out');

  h.dispatch(themeServiceStatus(signedInStatus({ credits: 17 })));
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip should be visible when signed in with credits');
  assert.equal(h.chip().textContent, '17 credits');

  h.dispatch(themeServiceStatus(signedInStatus({ credits: undefined })));
  assert.ok(h.chip().hasAttribute('hidden'), 'chip should hide again if credits is not a number');
  h.win.close();
});

// ── No innerHTML for status text (source guard) ─────────────────────────────

test('renderThemeServicePanel and its helpers never use innerHTML for status text', () => {
  const src = readFileSync(MAIN_SRC_PATH, 'utf8');
  const start = src.indexOf('function renderThemeServiceSignedOut');
  const end = src.indexOf('function renderThemeServicePanel(status)');
  assert.ok(start >= 0 && end > start, 'could not locate the Theme Service panel render functions in source');
  const section = src.slice(start, end);
  assert.ok(!/\.innerHTML\s*=/.test(section), 'Theme Service panel render helpers must not assign innerHTML (use textContent/DOM nodes)');
});
