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
  // Created at boot only when absent (010-modals-badges-rebirth.js
  // themeBuilderShellContinue relabel); pre-creating an empty stand-in via
  // scanElementIds would make the script think it already exists and skip
  // filling in its text.
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

async function bootThemePanelHarness(preSeed?: (win: any) => void) {
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

  if (preSeed) preSeed(win);
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

  // p93: sticky topbar "Back to themes" button and credits pill.
  function backBtn(): any {
    return doc.getElementById('tab-theme-picker');
  }

  function creditsPill(): any {
    return doc.getElementById('theme-builder-credits-pill');
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

  return { win, doc, dom, dispatch, panelText, panelBody, chip, backBtn, creditsPill, posted, lastPosted, clickButtonByText, errors };
}

// ── Fixture payloads ────────────────────────────────────────────────────────

const PRICING = {
  typicalTheme: { min: 8, max: 20, typical: 14 },
  packs: [
    { id: 'starter45', credits: 45, priceCents: 499, currency: 'usd', label: 'Starter', bonusCredits: 0 },
    { id: 'theme100', credits: 100, priceCents: 999, currency: 'usd', label: 'Theme', bonusCredits: 10 },
    { id: 'bundle205', credits: 205, priceCents: 1999, currency: 'usd', label: 'Bundle', bonusCredits: 25 },
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

// p87: simulates the host's THEME_SERVICE_GOOGLE_OPENED reply once
// openExternal settles for a GOOGLE_START — moves the webview off its
// "Contacting sign-in service…" loading state.
function googleOpened(overrides: any = {}) {
  return { type: 'THEME_SERVICE_GOOGLE_OPENED', payload: { ok: true, ...overrides } };
}

// ── THEME_BUILDER_OPENED / THEME_SERVICE_STATUS wiring ─────────────────────

test('THEME_BUILDER_OPENED renders the status and posts no THEME_SERVICE_GET_STATUS (p75-t2: host already refreshes in background)', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.match(h.panelText(), /Generate a theme/);
  const getStatusPosts = h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS');
  assert.equal(getStatusPosts.length, 0, 'THEME_BUILDER_OPENED must not post the now-redundant THEME_SERVICE_GET_STATUS');
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

// Review fix: a double click on the same button node (before the
// google-wait re-render removes it) must post THEME_SERVICE_GOOGLE_START
// exactly once.
test('double-clicking Continue with Google posts THEME_SERVICE_GOOGLE_START exactly once', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  const body = h.panelBody();
  const btn = Array.from(body.querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === 'Continue with Google',
  ) as any;
  assert.ok(btn, 'Continue with Google button should render');
  btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const starts = h.posted.filter((p: any) => p.type === 'THEME_SERVICE_GOOGLE_START');
  assert.equal(starts.length, 1, 'a double click must post exactly one THEME_SERVICE_GOOGLE_START');
  h.win.close();
});

// A deliberate Cancel then a fresh Sign in click must still work (the guard
// must not survive a Cancel).
test('Cancel from google-wait then Sign in again posts a second THEME_SERVICE_GOOGLE_START', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  assert.equal(h.posted.filter((p: any) => p.type === 'THEME_SERVICE_GOOGLE_START').length, 1);
  h.clickButtonByText('Cancel');
  h.clickButtonByText('Continue with Google');
  const starts = h.posted.filter((p: any) => p.type === 'THEME_SERVICE_GOOGLE_START');
  assert.equal(starts.length, 2, 'a restart after Cancel must post a new THEME_SERVICE_GOOGLE_START');
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

test('signed-out state: "Service: <host>" line renders only when status.endpointHost is set (p64-t2)', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus({ endpointHost: 'override.example.com' })));
  assert.match(h.panelText(), /Service: override\.example\.com/);
  h.win.close();
});

test('signed-out state: "Service:" line absent when status.endpointHost is unset', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.ok(!/Service:/.test(h.panelText()), 'no endpointHost means no Service line');
  h.win.close();
});

// ── p92: hasStoredSession-gated soft state (transient error, session fine) ──

test('p92: stored session + timeout shows waking text with Retry, no Sign in anywhere, and a later ok status restores the normal signed-in view', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ credits: 40 })));
  h.dispatch(themeServiceStatus({
    signedIn: undefined,
    hasStoredSession: true,
    pendingCheckout: false,
    error: { kind: 'timeout', message: 'timed out' },
  }));
  assert.match(h.panelText(), /waking up/i);
  assert.ok(!/Sign in/.test(h.panelText()), 'no Sign in text should appear anywhere in the panel body');
  const retry: any = Array.from(h.panelBody().querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === 'Retry',
  );
  assert.ok(retry, 'expected a Retry button');
  const statusChip = h.doc.getElementById('theme-builder-status-chip');
  if (statusChip) assert.ok(!/Sign in/.test(statusChip.textContent || ''), 'the header status chip must not offer Sign in either');

  h.dispatch(themeServiceStatus(signedInStatus({ credits: 42 })));
  assert.match(h.panelText(), /dev@example\.com/);
  assert.ok(!/Sign in/.test(h.panelText()));
  assert.equal(h.chip().textContent, '42 credits');
  h.win.close();
});

test('p92: no stored session + timeout shows Sign in', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.dispatch(themeServiceStatus({
    signedIn: undefined,
    hasStoredSession: false,
    pendingCheckout: false,
    error: { kind: 'timeout', message: 'timed out' },
  }));
  assert.match(h.panelText(), /Sign in/);
  h.win.close();
});

test('p92: definitive signed-out status shows Sign in regardless of hasStoredSession', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus({ hasStoredSession: true })));
  assert.match(h.panelText(), /Continue with Google/);
  h.win.close();
});

// ── State: google-contacting (p87) ──────────────────────────────────────────

test('Continue with Google immediately shows "Contacting sign-in service…" before GOOGLE_OPENED arrives', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  assert.match(h.panelText(), /Contacting sign-in service…/);
  assert.ok(!/Finish signing in with Google/.test(h.panelText()));
  h.win.close();
});

test('GOOGLE_OPENED ok:true transitions from contacting to the google-wait view', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  assert.match(h.panelText(), /Contacting sign-in service…/);
  h.dispatch(googleOpened());
  assert.match(h.panelText(), /Finish signing in with Google/);
  h.win.close();
});

test('GOOGLE_OPENED ok:false shows a Retry button with the error message, still in the contacting view', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  h.dispatch(googleOpened({ ok: false, error: { kind: 'browser_open_failed', message: "couldn't open the browser for sign-in" } }));
  assert.match(h.panelText(), /couldn't open the browser for sign-in/);
  const retry: any = Array.from(h.panelBody().querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === 'Retry',
  );
  assert.ok(retry, 'expected a Retry button after a failed GOOGLE_OPENED');
  h.win.close();
});

test('no GOOGLE_OPENED within 30s shows "Couldn\'t reach the sign-in service" with Retry', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));

  const originalSetTimeout = h.win.setTimeout.bind(h.win);
  let contactingTimeoutCb: (() => void) | null = null;
  let contactingTimeoutMs: number | null = null;
  h.win.setTimeout = (cb: () => void, ms: number) => {
    if (ms === 30000) {
      contactingTimeoutCb = cb;
      contactingTimeoutMs = ms;
    }
    return originalSetTimeout(cb, ms);
  };
  try {
    h.clickButtonByText('Continue with Google');
  } finally {
    h.win.setTimeout = originalSetTimeout;
  }
  assert.equal(contactingTimeoutMs, 30000, 'expected a 30s contacting timeout to be scheduled');
  assert.ok(contactingTimeoutCb, 'expected the 30s timeout callback to be captured');
  (contactingTimeoutCb as unknown as () => void)();

  assert.match(h.panelText(), /Couldn't reach the sign-in service/);
  const retry: any = Array.from(h.panelBody().querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === 'Retry',
  );
  assert.ok(retry, 'expected a Retry button after the 30s timeout');

  // A GOOGLE_OPENED arriving late (after the timeout already fired and
  // moved the view state) must be ignored, not silently re-open google-wait.
  h.dispatch(googleOpened());
  assert.match(h.panelText(), /Couldn't reach the sign-in service/, 'a stale late GOOGLE_OPENED must not override the timeout state');
  h.win.close();
});

test('double-click guard: a second click while contacting still posts THEME_SERVICE_GOOGLE_START exactly once', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  const body = h.panelBody();
  const btn = Array.from(body.querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === 'Continue with Google',
  ) as any;
  btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const starts = h.posted.filter((p: any) => p.type === 'THEME_SERVICE_GOOGLE_START');
  assert.equal(starts.length, 1, 'a double click during contacting must post exactly one THEME_SERVICE_GOOGLE_START');
  h.win.close();
});

// ── State: google-wait ───────────────────────────────────────────────────────

test('google-wait state renders paste-code field and posts GOOGLE_COMPLETE', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  h.dispatch(googleOpened());
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
  assert.match(text, /A typical theme takes about 14 credits; a careful run about 8, heavy retries up to 20\./); // guidance sentence
  assert.match(text, /Results depend on your prompts/); // caveat
  assert.match(text, /Prompt tips/);

  const tipsLink = Array.from(h.panelBody().querySelectorAll('a')).find(
    (a: any) => (a.textContent || '').trim() === 'Prompt tips',
  ) as any;
  assert.ok(tipsLink, 'Prompt tips link should render');
  tipsLink.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(
    h.posted.some((p: any) => p.type === 'OPEN_HANDBOOK' && p.page === 'ch-06.html' && p.anchor === 'prompt-tips'),
    'Prompt tips should open the handbook at the prompt-tips section',
  );

  const packButtons: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-pack'));
  assert.equal(packButtons.length, 3, 'all pricing packs should render as buttons');

  const starterCard = packButtons[0];
  assert.match(starterCard.querySelector('.tsp-pack-label')?.textContent || '', /Starter/);
  assert.equal((starterCard.querySelector('b')?.textContent || '').trim(), '45');
  assert.match(starterCard.textContent || '', /\$4\.99/);
  assert.equal(starterCard.querySelector('.tsp-pack-badge'), null, 'no bonusCredits should render no badge');
  assert.equal(starterCard.querySelector('.tsp-pack-chip'), null, 'starter is not best value');

  const themeCard = packButtons[1];
  assert.match(themeCard.querySelector('.tsp-pack-label')?.textContent || '', /Theme/);
  assert.equal((themeCard.querySelector('b')?.textContent || '').trim(), '100');
  assert.match(themeCard.textContent || '', /\$9\.99/);
  assert.match(themeCard.querySelector('.tsp-pack-badge')?.textContent || '', /\+11% credits/);
  assert.equal(themeCard.querySelector('.tsp-pack-chip'), null, 'theme100 is not best value');

  const bundleCard = packButtons[2];
  assert.match(bundleCard.querySelector('.tsp-pack-label')?.textContent || '', /Bundle/);
  assert.equal((bundleCard.querySelector('b')?.textContent || '').trim(), '205');
  assert.match(bundleCard.textContent || '', /\$19\.99/);
  assert.match(bundleCard.querySelector('.tsp-pack-badge')?.textContent || '', /\+14% credits/);
  assert.match(bundleCard.querySelector('.tsp-pack-chip')?.textContent || '', /Best value/);

  h.clickButtonByText('Sign out');
  const signOut = h.lastPosted('THEME_SERVICE_SIGN_OUT');
  assert.ok(signOut, 'Sign out should post THEME_SERVICE_SIGN_OUT');

  h.dispatch(themeServiceStatus(signedInStatus()));
  const packButtonsAfter: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-pack'));
  packButtonsAfter[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const buy = h.lastPosted('THEME_SERVICE_BUY_CREDITS');
  assert.ok(buy, 'clicking a pack should post THEME_SERVICE_BUY_CREDITS');
  assert.equal(buy.pack, 'starter45');
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

test('typical-credits sentence falls back to a min-to-max phrasing when typical is absent', async () => {
  const h = await bootThemePanelHarness();
  const pricingNoTypical = { ...PRICING, typicalTheme: { min: 8, max: 20 } };
  h.dispatch(themeBuilderOpened(signedInStatus({ pricing: pricingNoTypical })));
  const text = h.panelText();
  assert.match(text, /A typical theme takes 8 to 20 credits\./);
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

test('unreachable state renders error + Retry, and Retry posts requestThemeServiceStatus (p75-t1)', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(
    themeBuilderOpened(
      signedOutStatus({ error: { kind: 'unreachable', message: 'Theme Service unavailable — no credits were charged.' } }),
    ),
  );
  assert.match(h.panelText(), /unavailable/i);
  const countBefore = h.posted.filter((p) => p.type === 'requestThemeServiceStatus').length;
  h.clickButtonByText('Retry');
  const countAfter = h.posted.filter((p) => p.type === 'requestThemeServiceStatus').length;
  assert.equal(countAfter, countBefore + 1, 'Retry should post requestThemeServiceStatus, not the old THEME_SERVICE_GET_STATUS');
  assert.equal(h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length, 0, 'Retry must not also post the old GET_STATUS wire message');
  h.win.close();
});

// v0.0.661 bug fix: an "internal"/"unavailable" status with signedIn OMITTED
// (unknown, not a known sign-out — see themeServiceHost.ts buildStatus) used
// to render Retry only, stranding a real signed-in user's transient failure
// with no path forward and no sign-in control anywhere in the Theme Builder.
test('unreachable/internal state with signedIn unknown also renders a Sign in action that posts THEME_SERVICE_GOOGLE_START', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened({ error: { kind: 'internal', message: 'Theme Service unavailable. No credits were charged.' } }));
  assert.match(h.panelText(), /unavailable/i);
  h.clickButtonByText('Sign in');
  const googleStart = h.lastPosted('THEME_SERVICE_GOOGLE_START');
  assert.ok(googleStart, 'the limbo screen\'s Sign in action should post THEME_SERVICE_GOOGLE_START directly');
  h.win.close();
});

// A DEFINITIVE signed-in status must never show the limbo Sign in button.
test('unreachable state with signedIn:true does not render a Sign in action', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ error: { kind: 'unavailable', message: 'Theme Service unavailable (503). No credits were charged.' }, credits: undefined })));
  assert.throws(() => h.clickButtonByText('Sign in'), /expected a button\/link/i);
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

  // p87: an unfetchable balance while still signed in never hides the chip
  // outright anymore — it falls back to the last cached balance (with an
  // explanatory title) instead of disappearing.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: undefined })));
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip should stay visible, showing the cached balance, when credits is unfetchable');
  assert.equal(h.chip().textContent, '17 credits');
  // p94: an unfetchable-balance state is still "retry mode" (see below) —
  // the chip keeps the pre-existing informative title/click-to-retry
  // affordance here rather than opening the store.
  assert.match(h.chip().title, /last known balance/i);
  h.win.close();
});

test('#theme-builder-credits-chip shows an explicit placeholder when signed in with no fetchable balance and no cache', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus(signedInStatus({ credits: undefined })));
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip should stay visible with a placeholder rather than hide');
  assert.equal(h.chip().textContent, '— credits');
  assert.match(h.chip().title, /could not fetch/i);
  h.win.close();
});

// p94: the CTA-row chip does nothing today — it must open the same
// buy-credits shell modal the sticky topbar pill opens (reusing
// openThemeBuilderShellModal), with real button semantics.
test('p94: #theme-builder-credits-chip opens the buy-credits shell modal on click, with button role/tabindex', async () => {
  const h = await bootThemePanelHarness();
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 17 })));

  const chip = h.chip();
  assert.equal(chip.getAttribute('role'), 'button');
  assert.equal(chip.getAttribute('tabindex'), '0');
  assert.equal(chip.style.cursor, 'pointer');

  chip.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.ok(!shell.hasAttribute('hidden'), 'clicking the chip should open the buy-credits shell modal');
  h.win.close();
});

test('p94: #theme-builder-credits-chip opens the buy-credits shell modal on Enter and Space', async () => {
  const h = await bootThemePanelHarness();
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 17 })));

  const chip = h.chip();
  chip.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.ok(!shell.hasAttribute('hidden'), 'Enter on the chip should open the buy-credits shell modal');

  shell.setAttribute('hidden', '');
  chip.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  assert.ok(!shell.hasAttribute('hidden'), 'Space on the chip should open the buy-credits shell modal');
  h.win.close();
});

test('p89: signed-in-no-credits placeholder caches signedIn so a later error status keeps the chip visible', async () => {
  const h = await bootThemePanelHarness();

  // First: signed in but no numeric credits yet (e.g. account refetch still
  // resolving) — chip shows the "— credits" placeholder.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: undefined })));
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip should be visible with the placeholder');
  assert.equal(h.chip().textContent, '— credits');

  // Then: an error/unknown status arrives with signedIn not carried (timeout
  // style). Without the p89 fix writing the cache above, this status has
  // nothing to fall back to and the chip would hide outright.
  h.dispatch(
    themeServiceStatus(
      signedInStatus({ signedIn: undefined, credits: undefined, error: { kind: 'timeout', message: 'timed out' } }),
    ),
  );
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip must stay visible on a later error status, not disappear');
  h.win.close();
});

// ── p93: sticky topbar back button + credits pill ──────────────────────────

test('p93: #tab-theme-picker is a small button (no full-width class) inside the sticky #theme-builder-topbar row', async () => {
  const h = await bootThemePanelHarness();
  const back = h.backBtn();
  assert.ok(back, 'expected #tab-theme-picker to exist');
  assert.equal(back.className.split(/\s+/).includes('primary'), false, 'Back to themes must not carry a full-width/primary class');
  // JSDOM here synthesizes flat elements per id (see scanElementIds above),
  // so real DOM nesting isn't observable through the harness — check the
  // source markup directly for the sticky topbar wrapper instead.
  const panelSrc = readFileSync(join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts'), 'utf8');
  assert.match(
    panelSrc,
    /<div id="theme-builder-topbar"[^>]*>\s*<button id="tab-theme-picker"[\s\S]{0,160}<button id="theme-builder-credits-pill"/,
    'expected #tab-theme-picker and #theme-builder-credits-pill inside #theme-builder-topbar in panel.ts',
  );
  h.win.close();
});

test('p93: #theme-builder-credits-pill mirrors #theme-builder-credits-chip and stays in sync across status updates', async () => {
  const h = await bootThemePanelHarness();

  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.ok(h.creditsPill().hasAttribute('hidden'), 'pill should be hidden when signed out, like the chip');
  assert.equal(h.creditsPill().hasAttribute('hidden'), h.chip().hasAttribute('hidden'));

  h.dispatch(themeServiceStatus(signedInStatus({ credits: 46 })));
  assert.ok(!h.creditsPill().hasAttribute('hidden'));
  assert.equal(h.creditsPill().textContent, '46 credits');
  assert.equal(h.creditsPill().textContent, h.chip().textContent, 'pill and chip must show the same balance');
  assert.equal(h.creditsPill().getAttribute('aria-label'), '46 credits remaining — buy more');

  h.dispatch(themeServiceStatus(signedInStatus({ credits: undefined })));
  assert.equal(h.creditsPill().textContent, h.chip().textContent, 'pill must stay in sync on the unfetchable-balance fallback too');
  h.win.close();
});

test('p93: clicking the credits pill opens the buy-credits shell (openThemeBuilderShellModal), reusing the existing action', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 46 })));

  const shell = h.doc.getElementById('theme-builder-shell-modal');
  assert.ok(shell, 'expected #theme-builder-shell-modal to exist');
  // The JSDOM harness synthesizes bare elements (no `hidden` by default —
  // see scanElementIds above); set it explicitly to match production markup.
  shell.setAttribute('hidden', '');

  h.creditsPill().dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.ok(!shell.hasAttribute('hidden'), 'clicking the pill must open the same buy-credits shell modal used elsewhere');
  h.win.close();
});

test('p89 fix: a signed-in-no-credits status does not wipe a previously cached numeric balance', async () => {
  const h = await bootThemePanelHarness();

  // First: a numeric balance arrives and is cached.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 500 })));
  assert.equal(h.chip().textContent, '500 credits');

  // Then: signed in but credits is unfetchable — without preserving the
  // cached numeric credits, writeCachedThemeServiceStatus would overwrite
  // the cache's 500 with undefined here.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: undefined })));
  assert.equal(h.chip().textContent, '500 credits', 'should still show the last known balance');

  // Finally: an error status with signedIn not carried falls back to the
  // cache — it must still find the 500, not the wiped-out placeholder.
  h.dispatch(
    themeServiceStatus(
      signedInStatus({ signedIn: undefined, credits: undefined, error: { kind: 'timeout', message: 'timed out' } }),
    ),
  );
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip must stay visible on the later error status');
  assert.equal(h.chip().textContent, '500 credits', 'must still show 500, not the placeholder');
  h.win.close();
});

// ── Chip pending-timeout fallback (testing-specialist addition) ────────────
// Installs a controllable fake setTimeout/clearTimeout on the JSDOM window
// AFTER boot (armThemeCreditsChipPendingTimeout calls window.setTimeout at
// invocation time, not at parse time, so a post-boot override is picked up).
// This avoids any real waiting for the 15000ms fallback.
function installFakeChipTimer(h: any) {
  const scheduled: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  h.win.setTimeout = (fn: () => void, ms: number) => {
    const id = nextId++;
    scheduled.push({ id, fn, ms });
    return id;
  };
  h.win.clearTimeout = (id: number) => {
    const idx = scheduled.findIndex((s) => s.id === id);
    if (idx >= 0) scheduled.splice(idx, 1);
  };
  return {
    pendingCount: () => scheduled.length,
    fire: () => {
      const s = scheduled.shift();
      assert.ok(s, 'expected a scheduled timer to fire');
      assert.equal(s!.ms, 15000, 'chip fallback timer should be armed for 15000ms');
      s!.fn();
    },
  };
}

test('chip: a pending stub with no follow-up falls back after 15000ms to "— credits" with a retry title when nothing is cached', async () => {
  const h = await bootThemePanelHarness();
  const ft = installFakeChipTimer(h);
  h.dispatch(themeBuilderOpened(signedOutStatus({ pending: true })));
  assert.equal(h.chip().textContent, '…');
  assert.equal(ft.pendingCount(), 1, 'the pending timeout should be armed once');
  ft.fire();
  assert.equal(h.chip().textContent, '— credits');
  assert.match(h.chip().title, /couldn't load your balance.*retry/i);
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip must never be hidden in the fallback state');
  h.win.close();
});

test('chip: a pending stub shows the cached numeric balance immediately when one is cached (no "…" flash, no fallback timer armed)', async () => {
  const h = await bootThemePanelHarness();
  // Prime the cache with a real signed-in status carrying credits.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 500 })));
  assert.equal(h.chip().textContent, '500 credits');

  const ft = installFakeChipTimer(h);
  h.dispatch(themeBuilderOpened(signedOutStatus({ pending: true })));
  // updateThemeBuilderCreditsChip's pending branch returns the cached balance
  // immediately when one exists (before the "…"/armThemeCreditsChipPendingTimeout
  // path), so no fallback timer is armed in this case.
  assert.equal(h.chip().textContent, '500 credits');
  assert.equal(ft.pendingCount(), 0, 'no fallback timer should be armed when a cached balance is shown immediately');
  assert.ok(!h.chip().hasAttribute('hidden'));
  h.win.close();
});

test('chip: a real status arriving before 15s cancels the pending fallback timer', async () => {
  const h = await bootThemePanelHarness();
  const ft = installFakeChipTimer(h);
  h.dispatch(themeBuilderOpened(signedOutStatus({ pending: true })));
  assert.equal(ft.pendingCount(), 1);
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 42 })));
  assert.equal(ft.pendingCount(), 0, 'a terminal status must clear the armed fallback timer');
  assert.equal(h.chip().textContent, '42 credits');
  h.win.close();
});

test('chip: clicking it in the fallback state posts requestThemeServiceStatus', async () => {
  const h = await bootThemePanelHarness();
  const ft = installFakeChipTimer(h);
  h.dispatch(themeBuilderOpened(signedOutStatus({ pending: true })));
  ft.fire();
  assert.equal(h.chip().textContent, '— credits');
  const countBefore = h.posted.filter((p: any) => p.type === 'requestThemeServiceStatus').length;
  h.chip().dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const countAfter = h.posted.filter((p: any) => p.type === 'requestThemeServiceStatus').length;
  assert.equal(countAfter, countBefore + 1, 'clicking the fallback chip should post requestThemeServiceStatus');
  h.win.close();
});

// p91-t3: while a chip-triggered refresh is still in flight, further clicks
// must not fire another requestThemeServiceStatus — only the next terminal
// status (or the pending-timeout fallback itself) re-arms the click.
test('chip: a second click while a retry is still in flight is ignored, until the next status arrives', async () => {
  const h = await bootThemePanelHarness();
  const ft = installFakeChipTimer(h);
  h.dispatch(themeBuilderOpened(signedOutStatus({ pending: true })));
  ft.fire();
  assert.equal(h.chip().textContent, '— credits');

  function requestCount(): number {
    return h.posted.filter((p: any) => p.type === 'requestThemeServiceStatus').length;
  }

  // main.js also fires one requestThemeServiceStatus() at boot, so compare
  // deltas from here rather than an absolute count.
  const countBeforeClick = requestCount();
  h.chip().dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.equal(requestCount(), countBeforeClick + 1, 'the first click should post a request');

  // Clicking again before any response lands must not post a second request.
  h.chip().dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  h.chip().dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.equal(requestCount(), countBeforeClick + 1, 'clicks while a retry is in flight must be ignored');

  // A real credits status arriving clears the in-flight flag and takes the
  // chip out of retry mode (p94) — a click now opens the buy-credits shell
  // instead of posting another status request.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 9 })));
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');
  h.chip().dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.equal(requestCount(), countBeforeClick + 1, 'a click once a real balance is known must not post another status request');
  assert.ok(!shell.hasAttribute('hidden'), 'that click should instead open the buy-credits shell modal');
  h.win.close();
});

// p91-t3: closing the sign-in shell modal must cancel the 15s pending-fallback
// clock so it can't fire against a chip nobody is looking at (or a later
// dialog open that re-arms it while the old timer is still ticking).
test('closing the theme-builder sign-in shell clears the pending-fallback timer', async () => {
  const h = await bootThemePanelHarness();
  const ft = installFakeChipTimer(h);
  h.dispatch(themeBuilderOpened(signedOutStatus({ pending: true })));
  assert.equal(ft.pendingCount(), 1, 'the pending timeout should be armed');

  const closeBtn = h.doc.getElementById('theme-builder-shell-close');
  assert.ok(closeBtn, 'expected #theme-builder-shell-close to exist');
  closeBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.equal(ft.pendingCount(), 0, 'closing the shell modal must clear the armed fallback timer');
  h.win.close();
});

// #2 concern (fixed, p91-t2): the host's buildStatus catch now omits
// signedIn (see test/themeServiceHost.test.ts "p2 concern") instead of
// hardcoding false on a throw, so the webview must keep showing the cached
// balance rather than treating this as a confirmed sign-out.
test('p2 concern: signed-in credits:500 then a host throw (signedIn:undefined) keeps the cached 500, not signed-out', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 500 })));
  assert.equal(h.chip().textContent, '500 credits');

  // Mirrors the host's actual buildStatus catch payload after the review fix:
  // { pendingCheckout, error: { kind: "internal", ... } } — signedIn omitted,
  // kind "internal" (not "unavailable") so it's never mistaken for a cold
  // Theme Service backend.
  h.dispatch(themeServiceStatus({ signedIn: undefined, error: { kind: 'internal', message: 'Theme Service unavailable.' } }));

  assert.ok(!h.chip().hasAttribute('hidden'), 'chip must stay visible, not hide as signed-out');
  assert.equal(h.chip().textContent, '500 credits', 'chip must keep showing the cached balance, not wipe it');
  h.win.close();
});

// ── Root-cause regression: shared themeServiceStatus must never regress to
// "unknown" while a background refresh is in flight (media/src/main/
// 010-modals-badges-rebirth.js renderThemeServicePanel/mergeThemeServiceStatus) ──

test('a genuine {pending:true} stub (no signedIn field, as the host actually sends it) does not wipe the cached balance', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 500 })));
  assert.equal(h.chip().textContent, '500 credits');

  // Real host pending stub carries only {pending:true} — no signedIn field.
  h.dispatch(themeServiceStatus({ pending: true }));
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip must stay visible during an in-flight refresh');
  assert.equal(h.chip().textContent, '500 credits', 'chip must keep the last-known balance, not blank/hide');
  h.win.close();
});

test('cached balance is sent to the review page before the fetch resolves: THEME_SERVICE_STATUS then a pending stub then THEME_IMAGE_REVIEW still shows Balance', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 77 })));
  // A background refresh kicks off (e.g. Theme Builder reopened) — the
  // host's transient stub arrives before the slow /me call resolves.
  h.dispatch(themeServiceStatus({ pending: true }));

  h.dispatch({
    type: 'THEME_IMAGE_REVIEW',
    payload: {
      theme_id: 'smoke_theme',
      display_name: 'Smoke Theme',
      creditsSpent: 3,
      items: [
        {
          id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
          status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
        },
      ],
      creative_direction: '',
    },
  });

  const costLine = h.doc.querySelector('.theme-attempt-cost');
  assert.ok(costLine, 'the AI plan review page should render a .theme-attempt-cost line');
  assert.match(costLine!.textContent, /Balance 77 credits/, 'the review page must keep showing the last-known balance while a refresh is in flight');
  h.win.close();
});

test('a last-known balance cached in localStorage from a prior session is visible on the review page immediately at boot, before any THEME_SERVICE_STATUS arrives', async () => {
  const h = await bootThemePanelHarness((win) => {
    win.localStorage.setItem(
      'tycoonagents.themeServiceStatusCache',
      JSON.stringify({ signedIn: true, credits: 250 }),
    );
  });

  // No THEME_SERVICE_STATUS/THEME_BUILDER_OPENED dispatched yet — only the
  // cache-seeded state and the review payload.
  h.dispatch({
    type: 'THEME_IMAGE_REVIEW',
    payload: {
      theme_id: 'smoke_theme',
      display_name: 'Smoke Theme',
      creditsSpent: 0,
      items: [
        {
          id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
          status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
        },
      ],
      creative_direction: '',
    },
  });

  assert.equal(h.chip().textContent, '250 credits', 'header chip should show the cached balance immediately at boot');
  const costLine = h.doc.querySelector('.theme-attempt-cost');
  assert.ok(costLine, 'the AI plan review page should render a .theme-attempt-cost line');
  assert.match(costLine!.textContent, /Balance 250 credits/, 'the review page should show the cached balance immediately at boot, before any fetch resolves');
  h.win.close();
});

// ── Follow-up fix: header chip must never go HIDDEN except on a definitive
// sign-out, and must prefer the host's durable cachedCredits field when the
// per-viewer localStorage cache has nothing (empty/cleared storage) ────────

test('follow-up: a transient error status with no signedIn and no cache of any kind never hides the chip (shows "…" instead)', async () => {
  const h = await bootThemePanelHarness();
  // No prior signed-in status, no localStorage cache seeded — this is the
  // exact combination that used to hide the chip outright.
  h.dispatch(themeServiceStatus({ error: { kind: 'timeout', message: 'timed out' } }));
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip must never hide on a transient status, even with nothing cached');
  assert.equal(h.chip().textContent, '…');
  h.win.close();
});

test('follow-up: a transient error status carrying the host\'s cachedCredits shows that balance instead of hiding, with no localStorage cache present', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus({ error: { kind: 'waking', message: 'Checking your Theme Service status…' }, cachedCredits: 88 }));
  assert.ok(!h.chip().hasAttribute('hidden'), 'chip must show the host-cached balance, not hide');
  assert.equal(h.chip().textContent, '88 credits');
  h.win.close();
});

test('follow-up: getCachedOrPendingStatus-shaped stub (pending:true, cachedCredits from host) shows the balance immediately, no "…" flash', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened({ pending: true, cachedCredits: 310 }));
  assert.ok(!h.chip().hasAttribute('hidden'));
  assert.equal(h.chip().textContent, '310 credits');
  h.win.close();
});

test('follow-up: review page balance line falls back to the host\'s cachedCredits when localStorage has nothing cached', async () => {
  const h = await bootThemePanelHarness();
  // Only the host-side cachedCredits field is available — no prior
  // THEME_SERVICE_STATUS with a live number, no localStorage cache.
  h.dispatch(themeServiceStatus({ pending: true, cachedCredits: 61 }));

  h.dispatch({
    type: 'THEME_IMAGE_REVIEW',
    payload: {
      theme_id: 'smoke_theme',
      display_name: 'Smoke Theme',
      creditsSpent: 0,
      items: [
        {
          id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
          status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
        },
      ],
      creative_direction: '',
    },
  });

  const costLine = h.doc.querySelector('.theme-attempt-cost');
  assert.ok(costLine, 'the AI plan review page should render a .theme-attempt-cost line');
  assert.match(costLine!.textContent, /Balance 61 credits/, 'the review page should fall back to the host cachedCredits field');
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

// ── Builder-first Theme Builder tab (p75-t3): no shell modal on tab click ────

test('clicking #tab-theme-builder opens the plan editor directly (no shell modal, no Connecting…) and posts OPEN_THEME_BUILDER', async () => {
  const h = await bootThemePanelHarness();
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  // The harness stubs every getElementById id as a bare <div> (it doesn't
  // replicate panel.ts/server.mjs's `hidden` attribute on the real modal
  // markup), so start it hidden explicitly, matching production markup.
  shell.setAttribute('hidden', '');
  const themeBuilderPanel = h.doc.getElementById('theme-builder-panel');
  themeBuilderPanel.setAttribute('hidden', '');
  const themePickerList = h.doc.getElementById('theme-picker-list');
  themePickerList.removeAttribute('hidden');

  h.doc.getElementById('tab-theme-builder').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.ok(shell.hasAttribute('hidden'), 'the sign-in shell modal must stay closed on a plain tab click');
  assert.ok(!themeBuilderPanel.hasAttribute('hidden'), 'the plan editor panel must be shown immediately on tab click');
  assert.ok(h.posted.some((p) => p.type === 'OPEN_THEME_BUILDER'), 'click should still post OPEN_THEME_BUILDER');

  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.match(h.panelText(), /Generate a theme/, 'THEME_BUILDER_OPENED should still drive the status/credits chip once it arrives');
  h.win.close();
});

test('THEME_BUILDER_OPENED after a tab click (signed-out, then pending:true) leaves the shell modal hidden and posts no THEME_SERVICE_GET_STATUS', async () => {
  const h = await bootThemePanelHarness();
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');
  const themeBuilderPanel = h.doc.getElementById('theme-builder-panel');
  themeBuilderPanel.setAttribute('hidden', '');
  const themePickerList = h.doc.getElementById('theme-picker-list');
  themePickerList.removeAttribute('hidden');

  h.doc.getElementById('tab-theme-builder').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.ok(shell.hasAttribute('hidden'), 'the shell modal must stay closed on the tab click itself');

  const countBefore = h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length;

  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.ok(shell.hasAttribute('hidden'), 'THEME_BUILDER_OPENED (signed-out) must not open the shell modal');
  assert.equal(
    h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length,
    countBefore,
    'THEME_BUILDER_OPENED must not post THEME_SERVICE_GET_STATUS',
  );

  h.dispatch(themeBuilderOpened(signedOutStatus({ pending: true })));
  assert.ok(shell.hasAttribute('hidden'), 'THEME_BUILDER_OPENED (pending:true) must not open the shell modal');
  assert.equal(
    h.posted.filter((p) => p.type === 'THEME_SERVICE_GET_STATUS').length,
    countBefore,
    'THEME_BUILDER_OPENED with pending:true must not post THEME_SERVICE_GET_STATUS either',
  );
  h.win.close();
});

test('#theme-builder-shell-modal has a higher z-index than #themes-modal so it layers above it', () => {
  const css = readFileSync(join(process.cwd(), 'media', 'style.css'), 'utf8');

  function zIndexOf(selector: string): number {
    const ruleStart = css.indexOf(selector + ' {');
    assert.ok(ruleStart >= 0, `could not find CSS rule for ${selector}`);
    const ruleEnd = css.indexOf('}', ruleStart);
    const rule = css.slice(ruleStart, ruleEnd);
    const m = /z-index:\s*(\d+)/.exec(rule);
    assert.ok(m, `${selector} rule has no z-index declaration`);
    return Number(m![1]);
  }

  const shellZ = zIndexOf('#theme-builder-shell-modal');
  const themesZ = zIndexOf('#themes-modal');
  assert.ok(shellZ > themesZ, `expected #theme-builder-shell-modal z-index (${shellZ}) to exceed #themes-modal z-index (${themesZ})`);
});

// ── Provider/model/quality selectors removed (bug fix, 0.0.611; p43 will remove image_provider entirely) ──

test('the image provider/model/quality selects are gone from the webview bundle, replaced by a Corsair-credits note', () => {
  const bundle = readFileSync(MAIN_JS_PATH, 'utf8');
  assert.ok(!bundle.includes('theme-image-provider'), 'theme-image-provider select must be removed');
  assert.ok(!bundle.includes('theme-image-model'), 'theme-image-model select must be removed');
  assert.ok(!bundle.includes('theme-image-quality'), 'theme-image-quality select must be removed');
  assert.ok(!bundle.includes('SET_THEME_IMAGE_PREFERENCE'), 'SET_THEME_IMAGE_PREFERENCE must no longer be posted');
});

test('PLAN_THEME still sends a default image_provider silently even with no provider UI', async () => {
  const h = await bootThemePanelHarness();
  // p75-t2: #theme-generate-btn is retired (class tsp-hidden-retired) and now
  // routes through the same signed-in gate as "Generate with AI" — sign in
  // first so the click fires PLAN_THEME directly instead of opening the
  // sign-in modal.
  h.dispatch(themeBuilderOpened(signedInStatus()));
  const input = h.doc.getElementById('theme-prompt-input');
  input.value = 'a cozy forest theme';
  const generateBtn = h.doc.getElementById('theme-generate-btn');
  assert.ok(generateBtn.classList.contains('tsp-hidden-retired'), 'theme-generate-btn should be retired/hidden');
  generateBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');
  assert.ok(plan, 'expected a PLAN_THEME message');
  assert.equal(plan.payload.image_provider, 'openai', 'image_provider should still default silently to "openai"');
  h.win.close();
});

// ── Per-attempt cost line + refund/error states in the image review (p43-t2/p43-t3) ──

function baseReviewItem(overrides: any = {}) {
  return {
    id: 'env1',
    kind: 'environment',
    label: 'Environment',
    status: 'pending',
    revision: 1,
    generated: true,
    image_src: 'data:image/png;base64,AA==',
    ...overrides,
  };
}

function themeImageReview(payload: any) {
  return { type: 'THEME_IMAGE_REVIEW', payload };
}

function attemptCostLine(h: any, itemId = 'env1'): string {
  const card = h.doc.querySelector(`[data-item-id="${itemId}"]`);
  assert.ok(card, `expected a review card for item ${itemId}`);
  const line = card.querySelector('.theme-attempt-cost');
  assert.ok(line, 'expected a .theme-attempt-cost line');
  return line.textContent;
}

function attemptNotice(h: any, itemId = 'env1'): any {
  const card = h.doc.querySelector(`[data-item-id="${itemId}"]`);
  assert.ok(card, `expected a review card for item ${itemId}`);
  return card.querySelector('.theme-attempt-notice');
}

test('cost line shows per-attempt cost, running total and balance', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({
    credits: 12,
    pricing: { ...PRICING, attemptCostByBoardType: { environment: 1 } },
  })));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    display_name: 'Forest',
    creditsSpent: 7,
    items: [baseReviewItem({ attemptCost: 1, boardType: 'environment' })],
  }));
  const text = attemptCostLine(h);
  assert.match(text, /This attempt costs 1 credits/);
  assert.match(text, /Spent on this theme so far: 7 credits/);
  assert.match(text, /Balance 12 credits/);
  h.win.close();
});

test('cost line resolves pricing by the item\'s service boardType, not its kind', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({
    credits: 12,
    pricing: { ...PRICING, attemptCostByBoardType: { objects_02: 2 } },
  })));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 7,
    items: [baseReviewItem({ attemptCost: 2, boardType: 'objects_02' })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const line = card.querySelector('.theme-attempt-cost');
  assert.match(line.textContent, /This attempt costs 2 credits/);
  assert.ok(!line.hasAttribute('title'), 'a known boardType price must not be marked as an estimate');
  h.win.close();
});

test('cost line falls back to the estimate when the item has no boardType', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({
    credits: 12,
    pricing: { ...PRICING, attemptCostByBoardType: { objects_02: 2 } },
  })));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 7,
    items: [baseReviewItem({ attemptCost: 1 })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const line = card.querySelector('.theme-attempt-cost');
  assert.match(line.textContent, /This attempt costs 1 credits/);
  assert.equal(line.getAttribute('title'), 'estimate');
  h.win.close();
});

test('cost line omits balance when not signed in and falls back to an estimated cost', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem()],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const line = card.querySelector('.theme-attempt-cost');
  assert.match(line.textContent, /This attempt costs 1 credits/);
  assert.ok(!/Balance/.test(line.textContent), 'balance segment should be omitted when not signed in');
  assert.equal(line.getAttribute('title'), 'estimate');
  h.win.close();
});

test('cost line updates without reload when a fresh THEME_SERVICE_STATUS arrives', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({
    credits: 12,
    pricing: { ...PRICING, attemptCostByBoardType: { environment: 1 } },
  })));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 7,
    items: [baseReviewItem({ attemptCost: 1 })],
  }));
  assert.match(attemptCostLine(h), /Spent on this theme so far: 7 credits/);

  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 8,
    items: [baseReviewItem({ attemptCost: 1 })],
  }));
  assert.match(attemptCostLine(h), /Spent on this theme so far: 8 credits/);

  h.dispatch(themeServiceStatus(signedInStatus({
    credits: 20,
    pricing: { ...PRICING, attemptCostByBoardType: { environment: 1 } },
  })));
  assert.match(attemptCostLine(h), /Balance 20 credits/, 'THEME_SERVICE_STATUS alone should re-render the review cards');
  h.win.close();
});

test('lastAttemptRefunded shows the refunded notice and keeps Retry available', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 3,
    items: [baseReviewItem({ lastAttemptRefunded: true, attemptCost: 2, image_src: undefined, generated: false })],
  }));
  const notice = attemptNotice(h);
  assert.ok(notice.classList.contains('theme-attempt-refunded'));
  assert.equal(notice.textContent, 'Attempt failed, 2 credits refunded');
  const retryBtn = h.doc.querySelector('[data-item-id="env1"] .theme-review-retry');
  assert.ok(retryBtn && !retryBtn.disabled, 'Retry must remain available after a refund');
  h.win.close();
});

test('provider_failed without a refund flag renders neutral wording, not a refund claim', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 3,
    items: [baseReviewItem({ error_kind: 'provider_failed', attemptCost: 1 })],
  }));
  const notice = attemptNotice(h);
  assert.ok(!notice.classList.contains('theme-attempt-refunded'));
  assert.equal(notice.textContent, 'Attempt failed — check your balance');
  h.win.close();
});

test('provider_failed with refunded:false says the user was not refunded', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 3,
    items: [baseReviewItem({ error_kind: 'provider_failed', lastAttemptRefunded: false, attemptCost: 3 })],
  }));
  const notice = attemptNotice(h);
  assert.ok(!notice.classList.contains('theme-attempt-refunded'));
  assert.equal(notice.textContent, 'Attempt failed — you were not refunded for this attempt; check your balance');
  h.win.close();
});

test('refunded notice uses the quoted board cost, not a stale attemptCost', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({
    credits: 12,
    pricing: { ...PRICING, attemptCostByBoardType: { character_sheet: 3 } },
  })));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ boardType: 'character_sheet', error_kind: 'provider_failed', lastAttemptRefunded: true, attemptCost: 1 })],
  }));
  assert.equal(attemptNotice(h).textContent, 'Attempt failed, 3 credits refunded');
  h.win.close();
});

test('refunded notice never invents an amount when none is known', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'provider_failed', lastAttemptRefunded: true, attemptCost: 0 })],
  }));
  assert.equal(attemptNotice(h).textContent, 'Attempt failed, your credits were refunded');
  h.win.close();
});

const ERROR_KIND_CASES: Array<[string, string, string]> = [
  ['not_signed_in', 'theme-attempt-signin', 'Sign in from the Theme Builder to generate'],
  ['insufficient_credits', 'theme-attempt-credits', 'Not enough credits'],
  ['unavailable', 'theme-attempt-unavailable', 'Theme Service unavailable — no credits were charged'],
  ['unreachable', 'theme-attempt-unavailable', 'Theme Service unavailable — no credits were charged'],
  ['rate_limited', 'theme-attempt-ratelimited', 'Too many requests, try again shortly'],
];

for (const [errorKind, cls, expectedText] of ERROR_KIND_CASES) {
  test(`error_kind ${errorKind} renders its distinct notice`, async () => {
    const h = await bootThemePanelHarness();
    h.dispatch(themeImageReview({
      theme_id: 't1',
      creditsSpent: 0,
      items: [baseReviewItem({ error_kind: errorKind })],
    }));
    const notice = attemptNotice(h);
    assert.ok(notice.classList.contains(cls), `expected class ${cls}, got ${notice.className}`);
    assert.ok(
      notice.textContent.startsWith(expectedText),
      `expected notice text to start with "${expectedText}", got "${notice.textContent}"`,
    );
    h.win.close();
  });
}

// Follow-up fix: the stale attempt-status notice must never stay visible
// once a new attempt starts — clicking Retry clears it immediately (no
// waiting on the host's RETRY_THEME_IMAGE round trip), so "Generating..."
// never shows alongside a previous attempt's error.
test('follow-up: clicking Retry immediately clears a stale error notice, before any host response', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'unavailable', image_src: undefined, generated: false })],
  }));
  assert.ok(attemptNotice(h), 'expected the unavailable notice to render first');

  const retryBtn = h.doc.querySelector('[data-item-id="env1"] .theme-review-retry');
  assert.ok(retryBtn, 'expected a Retry button');
  retryBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.equal(retryBtn.textContent, 'Generating...');
  assert.equal(attemptNotice(h), null, 'the stale notice must be gone the instant Retry is clicked, not left showing next to "Generating..."');
  h.win.close();
});

test('not_signed_in notice button (openThemeBuilderFromReview) opens the plan editor tab and posts OPEN_THEME_BUILDER without opening the shell modal (p75)', async () => {
  const h = await bootThemePanelHarness();
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');
  const themeBuilderPanel = h.doc.getElementById('theme-builder-panel');
  themeBuilderPanel.setAttribute('hidden', '');
  const themePickerList = h.doc.getElementById('theme-picker-list');
  themePickerList.removeAttribute('hidden');

  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'not_signed_in' })],
  }));
  const notice = attemptNotice(h);
  const btn = notice.querySelector('button');
  assert.ok(btn, 'expected an action button on the not_signed_in notice');
  btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.ok(shell.hasAttribute('hidden'), 'openThemeBuilderFromReview must not open the sign-in shell modal (p75)');
  assert.ok(!themeBuilderPanel.hasAttribute('hidden'), 'openThemeBuilderFromReview must open the plan editor panel directly');
  assert.ok(h.posted.some((p: any) => p.type === 'OPEN_THEME_BUILDER'), 'clicking should post OPEN_THEME_BUILDER');
  h.win.close();
});

// ── content_blocked / account_locked notices (p46-t3) ──

test('content_blocked with no categories/fields (old backend) renders the generic notice, and the Acceptable use link opens the handbook', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'content_blocked', attemptCost: 0 })],
  }));
  const notice = attemptNotice(h);
  assert.ok(notice.classList.contains('theme-attempt-contentblocked'));
  assert.ok(
    notice.textContent.startsWith('This prompt was blocked by content screening. No credit was spent.'),
    `unexpected notice text: ${notice.textContent}`,
  );
  const link = notice.querySelector('a');
  assert.ok(link, 'expected an Acceptable use link');
  assert.equal(link.textContent, 'Acceptable use');
  link.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(
    h.posted.some((p: any) => p.type === 'OPEN_HANDBOOK' && p.page === 'ch-08.html' && p.anchor === 'content-screening'),
    'clicking Acceptable use should post OPEN_HANDBOOK for the content-screening section',
  );
  const retryBtn = h.doc.querySelector('[data-item-id="env1"] .theme-review-retry');
  assert.ok(retryBtn && !retryBtn.disabled, 'Retry must stay enabled so the user can edit the prompt');
  h.win.close();
});

// p97 review fix: a generation_error.message that is just the bare
// error_kind enum string (an older/thinner backend shape) must never render
// as a raw code in red under Generate/Retry, duplicating the friendly
// .theme-attempt-notice already shown for that same error_kind.
test('a bare error-code generation_error.message is suppressed when a friendly notice already covers that error_kind', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      error_kind: 'content_blocked',
      attemptCost: 0,
      generation_error: { message: 'content_blocked' },
    })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  assert.ok(card, 'expected a review card for env1');
  assert.equal(
    card.querySelector('.theme-review-generation-error'),
    null,
    'the raw-code generation_error box must not render when the friendly notice already covers it',
  );
  const notice = attemptNotice(h);
  assert.ok(notice, 'the friendly .theme-attempt-notice must still render');
  assert.ok(notice.classList.contains('theme-attempt-contentblocked'));
  assert.ok(!card.textContent.includes('"content_blocked"'), 'the bare error code must never appear as visible text');
  h.win.close();
});

test('an unmapped generation_error with no matching friendly error_kind still renders its own message (legacy shape)', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      generation_error: { message: 'Some legacy provider failure text.', request_id: 'req-123' },
    })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const box = card.querySelector('.theme-review-generation-error');
  assert.ok(box, 'a generation_error with no covering error_kind must still render its own notice');
  assert.ok(box.textContent.includes('Some legacy provider failure text.'));
  h.win.close();
});

test('content_blocked with categories/fields names what was flagged, mapping a slot[i] path to its rival row name', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      error_kind: 'content_blocked',
      attemptCost: 0,
      error_categories: ['illicit'],
      error_fields: ['slot[0].visual_description'],
      rival_rows: [{ kind: 'rival', rival_id: 'r1', display_name: 'Sana Qi' }],
    })],
  }));
  const notice = attemptNotice(h);
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    "Blocked by content screening (illicit content): Sana Qi's description. No credit was spent. Rephrase it and retry.",
  );
  h.win.close();
});

test('content_blocked maps a slot.items[i] path to its object row name', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      error_kind: 'content_blocked',
      attemptCost: 0,
      error_categories: ['violence'],
      error_fields: ['slot.items[1].display_name'],
      object_rows: [{ display_name: 'Chair' }, { display_name: 'Crate' }],
    })],
  }));
  const notice = attemptNotice(h);
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    "Blocked by content screening (violence): Crate's description. No credit was spent. Rephrase it and retry.",
  );
  h.win.close();
});

test('content_blocked falls back to a generic field label for an unrecognized path', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      error_kind: 'content_blocked',
      attemptCost: 0,
      error_categories: ['hate'],
      error_fields: ['input.prompt'],
    })],
  }));
  const notice = attemptNotice(h);
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    'Blocked by content screening (hate): the request. No credit was spent. Rephrase it and retry.',
  );
  h.win.close();
});

test('content_blocked with a likeness category (no reason/fields, per the backend contract) renders the generic notice', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    // The likeness path returns only { error: "content_blocked", category: "likeness" } —
    // no `categories` array and no `fields` — so this must not be mistaken
    // for the categories/fields shape.
    items: [baseReviewItem({ error_kind: 'content_blocked', attemptCost: 0 })],
  }));
  const notice = attemptNotice(h);
  assert.ok(
    notice.textContent.startsWith('This prompt was blocked by content screening. No credit was spent.'),
    `unexpected notice text: ${notice.textContent}`,
  );
  h.win.close();
});

test('content_blocked with lastAttemptRefunded:true says the credits were refunded', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({
    credits: 12,
    pricing: { ...PRICING, attemptCostByBoardType: { character_sheet: 2 } },
  })));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      boardType: 'character_sheet',
      error_kind: 'content_blocked',
      lastAttemptRefunded: true,
      attemptCost: 0,
      error_categories: ['likeness'],
    })],
  }));
  const notice = attemptNotice(h);
  assert.ok(!notice.classList.contains('theme-attempt-unavailable'));
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    "Blocked by the image provider's content policy (a real person's likeness). Your 2 credits were refunded. Rephrase it and retry.",
  );
  assert.ok(notice.querySelector('a.tsp-link'), 'Acceptable use link stays');
  h.win.close();
});

test('content_blocked with lastAttemptRefunded:false says the refund did not go through', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 2,
    items: [baseReviewItem({
      error_kind: 'content_blocked',
      lastAttemptRefunded: false,
      attemptCost: 0,
      error_categories: ['likeness'],
    })],
  }));
  const notice = attemptNotice(h);
  assert.ok(notice.classList.contains('theme-attempt-unavailable'));
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    "Blocked by the image provider's content policy (a real person's likeness). This attempt was charged and the refund did not go through — check your balance. Rephrase it and retry.",
  );
  h.win.close();
});

test('content_blocked with no refunded flag (pre-screen) still says no credit was spent', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'content_blocked', attemptCost: 0, error_categories: ['likeness'] })],
  }));
  const notice = attemptNotice(h);
  assert.ok(notice.classList.contains('theme-attempt-contentblocked'));
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    "Blocked by content screening (a real person's likeness). No credit was spent. Rephrase it and retry.",
  );
  h.win.close();
});

test('content_blocked with a category but no fields (likeness/IP precheck shape) still names the category', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    // p94: the likeness/IP precheck returns { error: "content_blocked",
    // category: "likeness" | "ip" } with no `fields` — themeServiceClient.ts
    // folds the singular `category` into error_categories, so this item
    // arrives with error_categories set but error_fields empty/absent. The
    // notice must still name the category rather than falling all the way
    // back to the generic copy.
    items: [baseReviewItem({
      error_kind: 'content_blocked',
      attemptCost: 0,
      error_categories: ['likeness'],
      rival_rows: [{ kind: 'rival', rival_id: 'r1', display_name: 'Sana Qi' }],
    })],
  }));
  const notice = attemptNotice(h);
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    "Blocked by content screening (a real person's likeness). No credit was spent. Rephrase it and retry.",
  );
  h.win.close();
});

test('content_blocked names theme.creativeDirection with a fixed label', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      error_kind: 'content_blocked',
      attemptCost: 0,
      error_categories: ['self-harm/intent'],
      error_fields: ['theme.creativeDirection'],
    })],
  }));
  const notice = attemptNotice(h);
  assert.equal(
    notice.textContent.replace(/\s+Acceptable use$/, ''),
    "Blocked by content screening (self-harm): the theme's creative direction. No credit was spent. Rephrase it and retry.",
  );
  h.win.close();
});

test('account_locked renders the locked notice and disables Retry and Re-derive descriptions', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    creative_direction: 'a direction',
    descriptionsStale: true,
    items: [baseReviewItem({ error_kind: 'account_locked', attemptCost: 0 })],
  }));
  const notice = attemptNotice(h);
  assert.ok(notice.classList.contains('theme-attempt-accountlocked'));
  assert.equal(
    notice.textContent,
    'Your account is locked for repeated content-policy violations. Generation is disabled. Contact us through Submit Feedback to request an unlock.',
  );
  const retryBtn = h.doc.querySelector('[data-item-id="env1"] .theme-review-retry');
  assert.ok(retryBtn && retryBtn.disabled, 'Retry must be disabled when the account is locked');
  const rederiveBtn = h.doc.querySelector('.theme-review-rederive-descriptions');
  assert.ok(rederiveBtn && rederiveBtn.disabled, 'Re-derive descriptions must be disabled when the account is locked');
  h.win.close();
});

test('blocked and locked zero-cost attempts do not change the shown creditsSpent total', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({
    credits: 5,
    pricing: { ...PRICING, attemptCostByBoardType: { environment: 1 } },
  })));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 3,
    items: [baseReviewItem({ error_kind: 'content_blocked', attemptCost: 0, lastAttemptRefunded: false })],
  }));
  assert.match(attemptCostLine(h), /Spent on this theme so far: 3 credits/);
  h.win.close();
});

// ── strikes warning / locked Buy-credits (p46-t5) ───────────────────────────

test('one recent strike renders the singular strikes-warning line', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ strikes: 1, locked: false })));
  const line = h.panelBody().querySelector('.tsp-strikes-notice');
  assert.ok(line, 'expected a strikes-notice line');
  assert.equal(line.textContent, '1 recent content-policy strike. 3 locks the account.');
  h.win.close();
});

test('two recent strikes render the plural strikes-warning line', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ strikes: 2, locked: false })));
  const line = h.panelBody().querySelector('.tsp-strikes-notice');
  assert.ok(line, 'expected a strikes-notice line');
  assert.equal(line.textContent, '2 recent content-policy strikes. 3 locks the account.');
  h.win.close();
});

test('strikes-warning line is absent when strikes is 0 and when the account is locked', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ strikes: 0, locked: false })));
  assert.equal(h.panelBody().querySelector('.tsp-strikes-notice'), null, 'no strikes line at 0 strikes');
  h.dispatch(themeServiceStatus(signedInStatus({ strikes: 2, locked: true })));
  assert.equal(h.panelBody().querySelector('.tsp-strikes-notice'), null, 'locked state shows the lock notice, not the strikes line');
  h.win.close();
});

test('locked status disables every pack card', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ locked: true, strikes: 3 })));
  const packButtons: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-pack'));
  assert.ok(packButtons.length > 0, 'expected pack cards');
  for (const btn of packButtons) assert.equal(btn.disabled, true);
  h.win.close();
});

// ── p95: "Buy credits" is a heading, not a button; pack cards are the menu ──

test('"Buy credits" is a heading, not a button element', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  const buyBtn = Array.from(h.panelBody().querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === 'Buy credits',
  );
  assert.equal(buyBtn, undefined, '"Buy credits" must not be a button element');
  const heading = Array.from(h.panelBody().querySelectorAll('h3')).find(
    (el: any) => (el.textContent || '').trim() === 'Buy credits',
  );
  assert.ok(heading, 'expected a "Buy credits" heading');
  h.win.close();
});

test('pack cards are always visible and keyboard-activatable buttons', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  const packButtons: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-pack'));
  assert.ok(packButtons.length >= 3, 'expected all pack cards to be visible without extra interaction');
  for (const btn of packButtons) {
    assert.equal(btn.tagName, 'BUTTON', 'each pack card must be a real <button> for native keyboard access');
    assert.equal(btn.type, 'button');
    assert.notEqual(btn.tabIndex, -1);
  }
  packButtons[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.ok(h.lastPosted('THEME_SERVICE_BUY_CREDITS'), 'clicking a pack card must still post THEME_SERVICE_BUY_CREDITS');
  h.win.close();
});

// ── p95: account ID line ─────────────────────────────────────────────────

test('account ID line shows a truncated id with a copy button that copies the full id', async () => {
  const h = await bootThemePanelHarness();
  const userId = '98cc8dd7-1234-4abc-9def-abcdef123456';
  let copied: string | undefined;
  (h.win.navigator as any).clipboard = { writeText: (text: string) => { copied = text; return Promise.resolve(); } };
  h.dispatch(themeBuilderOpened(signedInStatus({ userId })));
  const row = h.panelBody().querySelector('.tsp-account-id-row');
  assert.ok(row, 'expected an account ID row');
  assert.match(row.textContent, /Account ID: 98cc8dd7/);
  const copyBtn = row.querySelector('button');
  assert.ok(copyBtn, 'expected a copy button');
  copyBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  assert.equal(copied, userId, 'clicking copy should copy the full account id');
  h.win.close();
});

test('account ID line is hidden when the id is unknown', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ userId: undefined })));
  assert.equal(h.panelBody().querySelector('.tsp-account-id-row'), null, 'no account ID row when userId is unknown');
  h.win.close();
});

// ── p95: Prompt tips opens the handbook ──────────────────────────────────

test('Prompt tips link posts OPEN_HANDBOOK for the prompt-tips section', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  const link = Array.from(h.panelBody().querySelectorAll('a')).find(
    (a: any) => (a.textContent || '').trim() === 'Prompt tips',
  ) as any;
  assert.ok(link, 'expected a Prompt tips link');
  link.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(
    h.posted.some((p: any) => p.type === 'OPEN_HANDBOOK' && p.page === 'ch-06.html' && p.anchor === 'prompt-tips'),
    'clicking Prompt tips should post OPEN_HANDBOOK for the prompt-tips section',
  );
  h.win.close();
});

// ── Referral code field (p62-t3, media/src/main/010-modals-badges-rebirth.js ~1723) ──

test('referral code field is rendered when showReferralField is true, absent when false', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus({ showReferralField: true })));
  assert.ok(h.doc.getElementById('theme-service-referral-input'), 'expected the referral input when showReferralField is true');

  h.dispatch(themeServiceStatus(signedOutStatus({ showReferralField: false })));
  assert.equal(h.doc.getElementById('theme-service-referral-input'), null, 'referral input must be absent when showReferralField is false');
  h.win.close();
});

test('referralCodePrefill lands in the input value via property assignment, never innerHTML, and is not executed as markup', async () => {
  const h = await bootThemePanelHarness();
  const malicious = '<img src=x>';
  h.dispatch(themeBuilderOpened(signedOutStatus({ showReferralField: true, referralCodePrefill: malicious })));
  const input: any = h.doc.getElementById('theme-service-referral-input');
  assert.ok(input, 'expected the referral input');
  // Assigning to .value never parses markup; confirm the raw string round-trips
  // as plain text and no <img> element was created anywhere in the panel body.
  assert.equal(input.value, malicious);
  assert.equal(h.panelBody().querySelector('img'), null, 'prefill must never be parsed as HTML');
  h.win.close();
});

test('typing in the referral field posts THEME_SERVICE_SET_REFERRAL_CODE with the trimmed value', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus({ showReferralField: true })));
  const input: any = h.doc.getElementById('theme-service-referral-input');
  input.value = '  PARTNER-9  ';
  input.dispatchEvent(new h.win.Event('input', { bubbles: true }));
  const posted = h.lastPosted('THEME_SERVICE_SET_REFERRAL_CODE');
  assert.ok(posted, 'expected a THEME_SERVICE_SET_REFERRAL_CODE message');
  assert.equal(posted.code, 'PARTNER-9');
  h.win.close();
});

// ── google-wait: error notice + buttons + 90s nudge (p65-t4) ───────────────

test('google-wait state with a browser_open_failed error renders the error notice, "Open the sign-in link" and "Copy link" buttons, and Open posts GOOGLE_OPEN', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  h.dispatch(googleOpened());
  h.dispatch(
    themeServiceStatus(
      signedOutStatus({ error: { kind: 'browser_open_failed', message: "couldn't open the browser for sign-in" }, browserUrl: 'https://auth.example/authorize?code_challenge=abc' }),
    ),
  );
  assert.match(h.panelText(), /couldn't open the browser for sign-in/);
  assert.match(h.panelText(), /Open the sign-in link/);
  assert.match(h.panelText(), /Copy link/);
  h.clickButtonByText('Open the sign-in link');
  const opened = h.lastPosted('THEME_SERVICE_GOOGLE_OPEN');
  assert.ok(opened, 'clicking "Open the sign-in link" should post THEME_SERVICE_GOOGLE_OPEN');
  h.win.close();
});

test('google-wait state without an error renders no error notice and no Open/Copy buttons, but always renders Cancel', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  h.dispatch(googleOpened());
  assert.match(h.panelText(), /Waiting…/);
  assert.ok(!/Open the sign-in link/.test(h.panelText()));
  assert.ok(!/Copy link/.test(h.panelText()));
  const cancel: any = Array.from(h.panelBody().querySelectorAll('a')).find((a: any) => (a.textContent || '').trim() === 'Cancel');
  assert.ok(cancel, 'expected a Cancel link in google-wait state');
  h.win.close();
});

test('google-wait state: the 90s nudge notice appears after the wait timer fires, using the page\'s own fake-timer-driven re-render', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));

  // Intercept window.setTimeout right before the click so we capture the
  // exact 90000ms callback renderThemeServiceSignedOut's Google handler
  // schedules, and can fire it deterministically instead of waiting 90s of
  // real time.
  const originalSetTimeout = h.win.setTimeout.bind(h.win);
  const originalDateNow = h.win.Date.now.bind(h.win.Date);
  let capturedCb: (() => void) | null = null;
  let capturedMs: number | null = null;
  h.win.setTimeout = (cb: () => void, ms: number) => {
    capturedCb = cb;
    capturedMs = ms;
    return 1;
  };
  try {
    h.clickButtonByText('Continue with Google');
    h.dispatch(googleOpened());
  } finally {
    h.win.setTimeout = originalSetTimeout;
  }
  assert.equal(capturedMs, 90000, 'expected the google-wait nudge timer to be scheduled for 90000ms');
  assert.ok(!/Still waiting/.test(h.panelText()), 'nudge notice must not appear before the timer fires');

  assert.ok(capturedCb, 'expected a captured setTimeout callback');
  // The nudge notice is gated on `Date.now() - startedAt >= 90000`, not a
  // timer-tick count, so advance the clock the module reads from too.
  h.win.Date.now = () => originalDateNow() + 90000;
  try {
    (capturedCb as unknown as () => void)();
    assert.match(h.panelText(), /Still waiting\. Open the link again or paste the code\./);
  } finally {
    h.win.Date.now = originalDateNow;
  }
  h.win.close();
});

// ── "Continue without signing in" relabel + help line (p65-t3) ─────────────

test('theme-builder-shell-continue is relabeled "Back to builder" (p75-t2) with a help line naming what upload-only vs AI needs', async () => {
  const h = await bootThemePanelHarness();
  const continueBtn = h.doc.getElementById('theme-builder-shell-continue');
  assert.ok(continueBtn, 'expected the theme-builder-shell-continue element');
  assert.equal(continueBtn.textContent, 'Back to builder');
  const help = h.doc.getElementById('theme-builder-shell-continue-help');
  assert.ok(help, 'expected a help paragraph next to the relabeled button');
  assert.match(help.textContent, /upload your own images/i);
  assert.match(help.textContent, /AI planning and generation need an account/i);
  h.win.close();
});

// ── THEME_PLAN_ERROR kind not_signed_in (p65-t3, 060-theme-image-review.js) ──

test('THEME_PLAN_ERROR with kind not_signed_in renders a Sign in button in theme-build-status instead of raw error text', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch({ type: 'THEME_PLAN_ERROR', payload: { kind: 'not_signed_in', message: 'not signed in' } });
  const status = h.doc.getElementById('theme-build-status');
  assert.ok(status, 'expected the theme-build-status element');
  assert.match(status.textContent, /Sign in to plan a theme with AI\./);
  const signInBtn: any = Array.from(status.querySelectorAll('button')).find((b: any) => (b.textContent || '').trim() === 'Sign in');
  assert.ok(signInBtn, 'expected a Sign in button inside theme-build-status');
  assert.ok(!/not signed in/.test(status.textContent), 'raw error message must not be shown for kind not_signed_in');
  h.win.close();
});

test('THEME_PLAN_ERROR with a different kind falls back to raw "Error: <message>" text, no Sign in button', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch({ type: 'THEME_PLAN_ERROR', payload: { kind: 'server_error', message: 'boom' } });
  const status = h.doc.getElementById('theme-build-status');
  assert.ok(status);
  assert.match(status.textContent, /Error: boom/);
  const signInBtn = Array.from(status.querySelectorAll('button')).find((b: any) => (b.textContent || '').trim() === 'Sign in');
  assert.equal(signInBtn, undefined, 'no Sign in button for a non-not_signed_in error kind');
  h.win.close();
});

// ── "Generate with AI" signed-in gate + builder status chip (p75-t2/t3) ────

function setPrompt(h: any, text: string): void {
  const input: any = h.doc.getElementById('theme-prompt-input');
  input.value = text;
}

test('Generate with AI signed out opens the shell modal and does not post PLAN_THEME', async () => {
  const h = await bootThemePanelHarness();
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.ok(!shell.hasAttribute('hidden'), 'the sign-in shell modal should open');
  assert.equal(h.lastPosted('PLAN_THEME'), undefined, 'PLAN_THEME must not be posted while signed out');
  h.win.close();
});

test('a subsequent signedIn status posts PLAN_THEME exactly once and closes the modal', async () => {
  const h = await bootThemePanelHarness();
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.ok(!shell.hasAttribute('hidden'));

  h.dispatch(themeServiceStatus(signedInStatus()));
  assert.equal(h.posted.filter((p: any) => p.type === 'PLAN_THEME').length, 1, 'PLAN_THEME should post exactly once');
  assert.ok(shell.hasAttribute('hidden'), 'the modal should close once the pending intent fires');

  // A later signedIn status must not re-fire the now-cleared intent.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 41 })));
  assert.equal(h.posted.filter((p: any) => p.type === 'PLAN_THEME').length, 1, 'PLAN_THEME must not post again on a later status');
  h.win.close();
});

test('cancelling the modal ("Back to builder") clears the pending intent — a later signedIn status posts nothing', async () => {
  const h = await bootThemePanelHarness();
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  h.doc.getElementById('theme-builder-shell-continue').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  h.dispatch(themeServiceStatus(signedInStatus()));
  assert.equal(h.lastPosted('PLAN_THEME'), undefined, 'cancelling the modal must clear the pending intent so no later status fires it');
  h.win.close();
});

test('Generate with AI signed in posts PLAN_THEME directly, no modal', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.ok(shell.hasAttribute('hidden'), 'the shell modal must not open when already signed in');
  const plan = h.lastPosted('PLAN_THEME');
  assert.ok(plan, 'expected PLAN_THEME to post directly');
  h.win.close();
});

// ── Generate with AI loading state (p90) ────────────────────────────────

test('Generate with AI shows the dedicated loading state and hides the choice row/name field/Back, clearing on THEME_PLAN_READY', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(loading, 'expected a #theme-plan-loading element');
  assert.ok(!loading.hasAttribute('hidden'), 'loading state should be visible while PLAN_THEME is in flight');
  assert.ok(loading.textContent.includes('AI is filling the theme slots'));
  assert.ok(loading.textContent.includes('Please stand by. This can take several minutes to finish.'));
  assert.ok(h.doc.getElementById('theme-build-choice-row').hasAttribute('hidden'), 'choice buttons must be hidden while loading');
  assert.ok(h.doc.getElementById('theme-prompt-container').hasAttribute('hidden'), 'name field must be hidden while loading');
  assert.ok(h.doc.getElementById('tab-theme-picker').hasAttribute('hidden'), 'Back to themes must be hidden while loading');

  const plan = h.lastPosted('PLAN_THEME');
  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: { name: 'a cozy forest theme' } } });

  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear on THEME_PLAN_READY');
  h.win.close();
});

test('Generate with AI loading state clears on THEME_PLAN_ERROR and returns to the Start screen with the error shown', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(!loading.hasAttribute('hidden'));

  const plan = h.lastPosted('PLAN_THEME');
  h.dispatch({
    type: 'THEME_PLAN_ERROR',
    payload: { requestId: plan.payload.requestId, kind: 'provider_failed', message: 'provider_failed', refunded: true },
  });

  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear on THEME_PLAN_ERROR');
  assert.ok(!h.doc.getElementById('theme-build-choice-row').hasAttribute('hidden'), 'choice buttons must return on error');
  assert.ok(!h.doc.getElementById('theme-prompt-container').hasAttribute('hidden'), 'name field must return on error');
  assert.ok(!h.doc.getElementById('tab-theme-picker').hasAttribute('hidden'), 'Back to themes must return on error');
  const validation = h.doc.getElementById('theme-build-choice-validation');
  assert.ok(validation.textContent.includes('Any credit charged is refunded.'));
  h.win.close();
});

// v0.0.657 bug fix trace: a client-side planTimeoutMs abort (src/core/
// themeServiceClient.ts serviceRequest) surfaces as kind: 'timeout' with no
// `refunded` field (panel.ts only sends `refunded` when
// isThemePlanServiceError(err).refunded is defined, and a bare
// ThemeServiceError from a timeout never sets it) — this is exactly the
// THEME_PLAN_ERROR shape panel.ts posts for it. The backend may have kept
// running and charged the credit after the client gave up, so the wording
// must say the request timed out WITHOUT claiming a refund happened.
test('Generate with AI: a client-side plan timeout (kind timeout, no refunded field) shows visible "timed out" error text, never a silent revert, and never claims a refund', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(!loading.hasAttribute('hidden'));

  const plan = h.lastPosted('PLAN_THEME');
  h.dispatch({
    type: 'THEME_PLAN_ERROR',
    payload: {
      requestId: plan.payload.requestId,
      kind: 'timeout',
      message: 'ThemePlanServiceError: request timed out after 600000ms',
      // no `refunded` field — a client-side abort has no server refund status.
    },
  });

  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear on a timeout THEME_PLAN_ERROR');
  const validation = h.doc.getElementById('theme-build-choice-validation');
  assert.ok(validation && validation.textContent.trim().length > 0, 'a timeout must show visible error text, not silence');
  assert.match(validation.textContent, /timed out/i, 'error text must say the request timed out');
  assert.ok(!/refunded/i.test(validation.textContent), 'must not claim a refund that a client-side timeout has no way to confirm');
  const status = h.doc.getElementById('theme-build-status');
  assert.match(status.textContent, /timed out/i);
  assert.ok(!/refunded/i.test(status.textContent));
  h.win.close();
});

// v0.0.657 bug fix: the real user flow — type a theme name on the Start
// screen (which syncs into the hidden #theme-plan-name duplicate — see the
// themePromptInput/themePlanName sync listener), click Generate with AI,
// then the plan arrives. themePlanFieldsHaveContent() previously counted
// that just-typed name as "hand-edited content", tripping
// confirmThemePlanOverwrite's inline confirm — which rendered into
// #theme-plan-validation, inside #theme-plan-editor, still hidden while on
// the Start screen. Net effect: loading clears, no plan, no confirm, no
// error — exactly the reported silent revert.
test('Generate with AI: typing a theme name before clicking Generate with AI does not swallow the READY plan (typed name alone must not trigger the overwrite confirm)', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  // Open the builder tab first (real flow: the user is on the Start screen,
  // #theme-plan-editor already hidden by openThemeBuilderPlanEditorTab's
  // renderThemeBuilderScreen, before they ever click Generate with AI) — a
  // bare THEME_BUILDER_OPENED dispatch alone never calls
  // renderThemeBuilderScreen, so skipping this step would leave
  // #theme-plan-editor's hidden state undetermined and mask the bug.
  h.doc.getElementById('tab-theme-builder').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const nameInput: any = h.doc.getElementById('theme-prompt-input');
  nameInput.value = 'Roman Empire';
  // Real typing fires 'input', which is what syncs #theme-prompt-input into
  // the hidden #theme-plan-name duplicate — setPrompt() alone (used by the
  // other tests) sets .value without an event and would silently mask this
  // bug, since themePlanName would stay empty.
  nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');
  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: { display_name: 'Roman Empire' } } });

  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear');
  const planEditor = h.doc.getElementById('theme-plan-editor');
  const planEditorVisible = planEditor && !planEditor.hasAttribute('hidden');
  const choiceValidation = h.doc.getElementById('theme-build-choice-validation');
  const visibleConfirmOnScreen = choiceValidation && choiceValidation.textContent.trim().length > 0
    && !h.doc.getElementById('theme-build-choice-row').hasAttribute('hidden');
  assert.ok(
    planEditorVisible || visibleConfirmOnScreen,
    'the plan review must render, or a visible confirm prompt must be on the current (Start) screen — neither may be silently dropped',
  );
  // A bare typed name (no other hand-edited content) must not require
  // confirmation at all — the plan review should render directly.
  assert.ok(planEditorVisible, 'a typed name alone must not trigger the overwrite confirm — the plan should render directly');
  h.win.close();
});

// Review fix (v0.0.657): a genuinely hand-edited plan slot (not just the
// name) must trip the inline confirm, and the confirm's Overwrite/Keep-mine
// buttons must survive on screen — a prior bug had the handler clear
// #theme-build-choice-validation in the same tick right after writing them.
test('Generate with AI: a hand-edited plan slot triggers a visible Overwrite/Keep-mine confirm on the Start screen; Overwrite applies the plan, Keep mine shows the discard note', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  h.doc.getElementById('tab-theme-builder').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  // Hand-edit a plan-editor slot (the empty draft template is already
  // rendered on tab entry) so themePlanFieldsHaveContent has real content
  // to protect, beyond the name field.
  const direction: any = h.doc.getElementById('theme-plan-direction');
  assert.ok(direction, 'expected the empty draft plan template to be rendered on tab entry');
  direction.value = 'My own hand-typed art direction';
  direction.dispatchEvent(new h.win.Event('input', { bubbles: true }));

  const nameInput: any = h.doc.getElementById('theme-prompt-input');
  nameInput.value = 'Roman Empire';
  nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');
  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: { display_name: 'Roman Empire' } } });

  const choiceValidation = h.doc.getElementById('theme-build-choice-validation');
  const choiceRow = h.doc.getElementById('theme-build-choice-row');
  assert.ok(!choiceRow.hasAttribute('hidden'), 'the confirm must be on the visible Start screen');
  const overwriteBtn = (Array.from(choiceValidation.querySelectorAll('button')) as any[]).find((b: any) => (b.textContent || '').trim() === 'Overwrite');
  const keepBtn = (Array.from(choiceValidation.querySelectorAll('button')) as any[]).find((b: any) => (b.textContent || '').trim() === 'Keep mine');
  assert.ok(overwriteBtn, 'expected a visible Overwrite button');
  assert.ok(keepBtn, 'expected a visible Keep mine button');

  overwriteBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const planEditor = h.doc.getElementById('theme-plan-editor');
  assert.ok(!planEditor.hasAttribute('hidden'), 'Overwrite must render the plan review');
  h.win.close();
});

test('Generate with AI: "Keep mine" on the overwrite confirm shows a visible discard note naming the used credit', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  h.doc.getElementById('tab-theme-builder').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  const direction: any = h.doc.getElementById('theme-plan-direction');
  direction.value = 'My own hand-typed art direction';
  direction.dispatchEvent(new h.win.Event('input', { bubbles: true }));

  const nameInput: any = h.doc.getElementById('theme-prompt-input');
  nameInput.value = 'Roman Empire';
  nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');
  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: { display_name: 'Roman Empire' } } });

  const choiceValidation = h.doc.getElementById('theme-build-choice-validation');
  const keepBtn = (Array.from(choiceValidation.querySelectorAll('button')) as any[]).find((b: any) => (b.textContent || '').trim() === 'Keep mine');
  keepBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.match(choiceValidation.textContent, /Kept your edits; the AI plan was discarded \(the credit was used\)\./);
  const planEditor = h.doc.getElementById('theme-plan-editor');
  assert.ok(planEditor.hasAttribute('hidden'), 'Keep mine must not apply the AI plan');
  h.win.close();
});

// v0.0.657 bug fix: exercise the try/catch safety net itself — force the
// apply path (confirmThemePlanOverwrite -> renderThemePlan) to throw and
// confirm the handler surfaces it instead of silently reverting.
test('Generate with AI: an apply-path exception on THEME_PLAN_READY shows a visible error, clears loading, re-enables Generate with AI, and promises no refund', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');
  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(!loading.hasAttribute('hidden'));

  // A plan whose display_name getter throws mid-render — renderThemePlan
  // reads plan.display_name first, so this reliably fires inside the try.
  const throwingPlan = new Proxy(
    {},
    {
      get(target: any, prop: string) {
        if (prop === 'display_name') throw new Error('boom-from-test');
        return target[prop];
      },
    },
  );
  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: throwingPlan } });

  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear even when the apply path throws');
  const genBtn = h.doc.getElementById('theme-generate-with-ai-btn');
  assert.ok(!genBtn.hasAttribute('disabled'), 'Generate with AI must be re-enabled');
  assert.ok(!h.doc.getElementById('theme-build-choice-row').hasAttribute('hidden'), 'must return to the Start screen, not stay stuck');
  const validation = h.doc.getElementById('theme-build-choice-validation');
  assert.ok(validation && validation.textContent.trim().length > 0, 'must show visible error text, not silence');
  assert.match(validation.textContent, /couldn't be shown/i);
  assert.match(validation.textContent, /boom-from-test/);
  assert.ok(!/was refunded|has been refunded/i.test(validation.textContent), 'must not promise a refund it cannot confirm');
  const status = h.doc.getElementById('theme-build-status');
  assert.match(status.textContent, /couldn't be shown/i);
  h.win.close();
});

// v0.0.657 bug fix probe: the actual production plan's exact slot counts —
// objects=22 (one over THEME_OBJECT_COUNT's 21), achievements=25,
// expressions=8, characters=16, decor=9, enemies=4 — with every optional
// *_descriptions/attack-style/hint/environment/crate/poof/projectile field
// populated (non-null) to matching lengths. Run through the webview
// THEME_PLAN_READY path to check for a throw on a name array longer than
// its fixed slot count, or a descriptions array the same (mismatched)
// length as its name array.
test('Generate with AI: exact production slot counts (objects=22, one over the 21-slot contract) render without throwing', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');

  const objects = Array.from({ length: 22 }, (_, i) => `Object ${i + 1}`);
  const exactCountsPlan = {
    display_name: 'Cozy Forest',
    creative_direction: 'Warm, hand-painted forest palette.',
    environment: 'A dense, glowing forest clearing.',
    characters: Array.from({ length: 16 }, (_, i) => `Character ${i + 1}`),
    character_descriptions: Array.from({ length: 16 }, (_, i) => `Character ${i + 1} desc`),
    objects,
    object_motion_hints: objects.map((_, i) => `hint ${i + 1}`),
    object_descriptions: objects.map((_, i) => `Object ${i + 1} desc`),
    crate_description: 'A wooden crate.',
    poof_description: 'A leafy poof.',
    projectile_description: 'A glowing seed.',
    decor: Array.from({ length: 9 }, (_, i) => `Decor ${i + 1}`),
    decor_descriptions: Array.from({ length: 9 }, (_, i) => `Decor ${i + 1} desc`),
    enemies: Array.from({ length: 4 }, (_, i) => `Enemy ${i + 1}`),
    enemy_attack_styles: ['melee', 'ranged', 'melee', 'ranged'],
    enemy_descriptions: Array.from({ length: 4 }, (_, i) => `Enemy ${i + 1} desc`),
    expressions: ['Love', 'Idea', 'Anger', 'Team', 'Thumbs up', 'Music', 'Sleep', 'Dazed'],
    expression_descriptions: Array.from({ length: 8 }, (_, i) => `Expression ${i + 1} desc`),
    achievements: Array.from({ length: 25 }, (_, i) => `Achievement ${i + 1}`),
    achievement_descriptions: Array.from({ length: 25 }, (_, i) => `Achievement ${i + 1} desc`),
  };

  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: exactCountsPlan } });

  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear');
  const planEditor = h.doc.getElementById('theme-plan-editor');
  assert.ok(planEditor && !planEditor.hasAttribute('hidden'), 'the AI plan review must render — nothing threw on these exact production counts');
  h.win.close();
});

// v0.0.657 bug fix trace: the host pushes a THEME_SERVICE_STATUS with the
// decremented credit balance once /api/plan debits (before the plan itself
// finishes generating) — reproduce that exact mid-flight sequence and
// confirm it does not reset the in-flight request or drop the eventual
// THEME_PLAN_READY.
test('Generate with AI: a THEME_SERVICE_STATUS credit-debit push arriving mid-request does not reset the builder or drop the eventual THEME_PLAN_READY', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ credits: 48 })));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');
  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(!loading.hasAttribute('hidden'), 'loading state should be visible while PLAN_THEME is in flight');

  // The credit-debit status push — same requestId's request is still in flight.
  h.dispatch(themeServiceStatus(signedInStatus({ credits: 47 })));

  assert.ok(!loading.hasAttribute('hidden'), 'a mid-flight status push must not clear the loading state or reset the builder to Start');
  assert.equal(h.lastPosted('PLAN_THEME'), plan, 'a mid-flight status push must not fire a second PLAN_THEME request');

  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: { display_name: 'Cozy Forest' } } });

  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear once the original request\'s READY arrives');
  const planEditor = h.doc.getElementById('theme-plan-editor');
  assert.ok(planEditor && !planEditor.hasAttribute('hidden'), 'the AI plan review must render — the READY reply must not have been dropped as stale');
  h.win.close();
});

// v0.0.657 bug fix regression: strict json_schema plan responses (backend
// ac82350) return every optional field as an explicit `null` instead of
// omitting it — *_descriptions arrays, enemy_attack_styles,
// object_motion_hints, environment, crate/poof/projectile_description. The
// plan review (confirmThemePlanOverwrite -> renderThemePlan) must still
// render instead of throwing and silently reverting to the Start screen.
test('Generate with AI: a plan payload with populated name arrays but every optional field null renders the plan review, not a silent revert', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus()));
  setPrompt(h, 'a cozy forest theme');
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');

  h.doc.getElementById('theme-generate-with-ai-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const plan = h.lastPosted('PLAN_THEME');

  const nullOptionalPlan = {
    display_name: 'Cozy Forest',
    creative_direction: 'Warm, hand-painted forest palette.',
    characters: Array.from({ length: 16 }, (_, i) => `Character ${i + 1}`),
    character_descriptions: null,
    environment: null,
    objects: Array.from({ length: 21 }, (_, i) => `Object ${i + 1}`),
    object_motion_hints: null,
    object_descriptions: null,
    crate_description: null,
    poof_description: null,
    projectile_description: null,
    decor: Array.from({ length: 9 }, (_, i) => `Decor ${i + 1}`),
    decor_descriptions: null,
    enemies: Array.from({ length: 4 }, (_, i) => `Enemy ${i + 1}`),
    enemy_attack_styles: null,
    enemy_descriptions: null,
    expressions: ['Love', 'Idea', 'Anger', 'Team', 'Thumbs up', 'Music', 'Sleep', 'Dazed'],
    expression_descriptions: null,
    achievements: Array.from({ length: 25 }, (_, i) => `Achievement ${i + 1}`),
    achievement_descriptions: null,
  };

  h.dispatch({ type: 'THEME_PLAN_READY', payload: { requestId: plan.payload.requestId, plan: nullOptionalPlan } });

  const loading = h.doc.getElementById('theme-plan-loading');
  assert.ok(loading.hasAttribute('hidden'), 'loading state must clear');
  const planEditor = h.doc.getElementById('theme-plan-editor');
  assert.ok(planEditor && !planEditor.hasAttribute('hidden'), 'the AI plan review must render, not silently revert to Start');
  const validation = h.doc.getElementById('theme-build-choice-validation');
  assert.ok(!validation || !/couldn't be shown/.test(validation.textContent || ''), 'must not have hit the apply-path safety-net error');
  h.win.close();
});

test('#theme-generate-btn carries class tsp-hidden-retired', async () => {
  const h = await bootThemePanelHarness();
  assert.ok(h.doc.getElementById('theme-generate-btn').classList.contains('tsp-hidden-retired'));
  h.win.close();
});

test('builder status chip: waking/unavailable/signed-in text, and Retry posts requestThemeServiceStatus', async () => {
  const h = await bootThemePanelHarness();
  const chip = () => h.doc.getElementById('theme-builder-status-chip');

  h.dispatch(themeBuilderOpened(signedOutStatus({ error: { kind: 'waking', message: 'The theme service is starting up. This can take about a minute.' } })));
  assert.match(chip().textContent, /Starting service/);

  h.dispatch(themeServiceStatus(signedOutStatus({ error: { kind: 'unavailable', message: 'Theme Service unavailable. No credits were charged.' } })));
  assert.match(chip().textContent, /Service unavailable/);

  const countBefore = h.posted.filter((p: any) => p.type === 'requestThemeServiceStatus').length;
  const retryLink: any = Array.from(chip().querySelectorAll('a')).find((a: any) => (a.textContent || '').trim() === 'Retry');
  assert.ok(retryLink, 'expected a Retry link in the chip');
  retryLink.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.equal(
    h.posted.filter((p: any) => p.type === 'requestThemeServiceStatus').length,
    countBefore + 1,
    'chip Retry should post requestThemeServiceStatus',
  );

  h.dispatch(themeServiceStatus(signedInStatus({ email: 'dev@example.com', credits: 12 })));
  assert.match(chip().textContent, /dev@example\.com/);
  assert.match(chip().textContent, /12 credits/);
  h.win.close();
});

test('leaving the theme builder tab posts THEME_BUILDER_CLOSED exactly once', async () => {
  const h = await bootThemePanelHarness();
  h.doc.getElementById('tab-theme-builder').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const countAfterOpen = h.posted.filter((p: any) => p.type === 'THEME_BUILDER_CLOSED').length;
  assert.equal(countAfterOpen, 0, 'no THEME_BUILDER_CLOSED while the builder tab is open');

  h.doc.getElementById('tab-theme-picker').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.equal(h.posted.filter((p: any) => p.type === 'THEME_BUILDER_CLOSED').length, 1, 'leaving the builder tab should post THEME_BUILDER_CLOSED once');

  // Leaving again without re-opening the builder must not post a second time.
  h.doc.getElementById('tab-theme-picker').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.equal(h.posted.filter((p: any) => p.type === 'THEME_BUILDER_CLOSED').length, 1, 'a second leave without reopening must not double-post');
  h.win.close();
});

// ── Environment board description editor (environment_description) ──

test('the Environment card renders a description textarea seeded from environment_description', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ environment_description: 'a dusty neon outpost' })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  assert.ok(card, 'expected the environment board card');
  const textarea = card.querySelector('.theme-review-description-input[data-row-id="environment"]');
  assert.ok(textarea, 'expected the environment description textarea');
  assert.equal(textarea.value, 'a dusty neon outpost');
  assert.equal(textarea.dataset.itemKind, 'environment');
  h.win.close();
});

test('editing the Environment description and clicking Apply posts SET_THEME_ITEM_DESCRIPTIONS with item_kind environment', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ environment_description: 'a dusty outpost' })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const textarea = card.querySelector('.theme-review-description-input[data-row-id="environment"]');
  textarea.value = 'a moody neon skyline';
  textarea.dispatchEvent(new h.win.Event('input', { bubbles: true }));

  const applyBtn = card.querySelector('.theme-review-names-descriptions-apply');
  assert.ok(applyBtn, 'expected the shared Apply button');
  assert.equal(applyBtn.disabled, false, 'Apply should be enabled once the description is dirty');
  applyBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  const sent = h.posted.find((p: any) => p.type === 'SET_THEME_ITEM_DESCRIPTIONS');
  assert.ok(sent, 'expected a SET_THEME_ITEM_DESCRIPTIONS message');
  assert.equal(sent.payload.theme_id, 't1');
  const change = sent.payload.changes.find((c: any) => c.item_kind === 'environment');
  assert.ok(change, 'expected an environment change entry');
  assert.equal(change.id, 'environment');
  assert.equal(change.description, 'a moody neon skyline');
  h.win.close();
});

// ── Per-kind description length cap: 'environment' gets 900, others keep 400 ──

test('an 850-char environment description has no over-limit note and posts on Apply', async () => {
  const h = await bootThemePanelHarness();
  const longDesc = 'x'.repeat(850);
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ environment_description: longDesc })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const textarea = card.querySelector('.theme-review-description-input[data-row-id="environment"]');
  assert.equal(textarea.maxLength, 900, 'environment textarea should cap at 900, not 400');
  assert.equal(textarea.value, longDesc);
  const overLengthNote = Array.from(card.querySelectorAll('.theme-review-error'))
    .find((el: any) => /over the .*-character limit/.test(el.textContent || ''));
  assert.ok(!overLengthNote, '850 chars is under the 900 cap — no over-limit note expected');
  h.win.close();
});

test('a 950-char seeded environment description shows a visible over-limit note instead of a silent drop', async () => {
  const h = await bootThemePanelHarness();
  const tooLong = 'x'.repeat(950);
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ environment_description: tooLong })],
  }));
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const overLengthNote = Array.from(card.querySelectorAll('.theme-review-error'))
    .find((el: any) => /over the 900-character limit/.test(el.textContent || ''));
  assert.ok(overLengthNote, 'expected a visible over-limit note for a 950-char seeded environment description');
  h.win.close();
});

test('a schema-rejected SET_THEME_ITEM_DESCRIPTIONS reply (error) surfaces a visible "Save failed" status, not a silent drop', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ environment_description: 'a dusty outpost' })],
  }));
  h.dispatch({
    type: 'THEME_ITEM_DESCRIPTIONS_RESULT',
    payload: { ok: false, theme_id: 't1', board_id: 'env1', error: 'One or more descriptions are invalid (e.g. too long) and were not saved.' },
  });
  const card = h.doc.querySelector('[data-item-id="env1"]');
  const statusEl = card.querySelector('.theme-review-names-descriptions-status');
  assert.ok(statusEl, 'expected the names/descriptions status element');
  assert.match(statusEl.textContent, /Save failed/);
  assert.ok(statusEl.classList.contains('theme-review-error'));
  h.win.close();
});

// ── v0.0.661 stuck-sign-in bug repro (real host log sequence) ──────────────
// Root cause was in src/core/themeServiceClient.ts's doRefreshSession /
// serviceRequest, not this webview: a transient refresh failure right after
// a cold-start-adjacent sign-in cleared the just-stored valid session and
// was reported as a definitive not_signed_in, which this panel correctly
// (by its own contract) renders as signed-out. These tests confirm the
// panel itself does the right thing once given a genuine signedIn:true
// status in each leg of that sequence, so a regression here can't hide
// behind the client-side fix alone.
test('a transient timeout status followed by a signed-in ok status switches to the signed-in view (v0.0.661 log repro, leg 1)', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus({ error: { kind: 'timeout', message: 'timed out' } }));
  h.dispatch(themeServiceStatus(signedInStatus()));
  assert.match(h.panelText(), /dev@example\.com/);
  assert.ok(!/Sign in/.test(h.panelText()), 'no Sign in control should remain once signedIn:true arrives');
  assert.equal(h.chip().textContent, '40 credits');
  h.win.close();
});

test('google-wait followed by the completeGoogle ok status switches to the signed-in view (v0.0.661 log repro, leg 2)', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedOutStatus()));
  h.clickButtonByText('Continue with Google');
  h.dispatch(googleOpened());
  assert.match(h.panelText(), /Finish signing in with Google/);
  h.dispatch(themeServiceStatus({ signedIn: false, pendingCheckout: false, browserUrl: 'https://x/auth' }));
  assert.match(h.panelText(), /Finish signing in with Google/, 'the browserUrl status must not leave google-wait early');
  h.dispatch(themeServiceStatus(signedInStatus()));
  assert.match(h.panelText(), /dev@example\.com/);
  assert.ok(!/Sign in/.test(h.panelText()));
  assert.equal(h.chip().textContent, '40 credits');
  h.win.close();
});

// Follow-up to the v0.0.661 investigation: item.error_kind "not_signed_in"
// is PERSISTED to disk (themeImageReviewState.ts's setThemeImageReviewErrorKind)
// from an earlier failed attempt and is only cleared by a later successful
// attempt on that item — never by signing back in. A fresh THEME_IMAGE_REVIEW
// payload carrying that stale field (a reload, reopening the review, or any
// host resend after sign-in) must not reintroduce the "Sign in" card while
// the live status is genuinely signed in.
test('a stale persisted not_signed_in item error is ignored once a signed-in status is known', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeServiceStatus(signedInStatus()));
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'not_signed_in' })],
  }));
  const notice = attemptNotice(h);
  assert.ok(!notice || !notice.classList.contains('theme-attempt-signin'),
    'a stale persisted not_signed_in error must not render the Sign in notice while signed in');
  assert.ok(!/Sign in from the Theme Builder/.test(h.doc.body.textContent || ''));
  h.win.close();
});

// Review follow-up: the review card must drop a stale not_signed_in prompt
// the moment a signed-in status arrives, even with NO fresh THEME_IMAGE_REVIEW
// resend — 060-theme-image-review.js's THEME_SERVICE_STATUS handler already
// re-renders lastThemeImageReviewPayload unconditionally on every status
// (not just when signedIn is true), so sanitizeStaleNotSignedInItems
// (020-theme-plan-editor.js's renderThemeImageReview) picks up the newly
// live signedIn:true on that same re-render.
test('a review rendered with a stale not_signed_in card drops the Sign in prompt once a signed-in status arrives, with no THEME_IMAGE_REVIEW resend', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'not_signed_in' })],
  }));
  const noticeBefore = attemptNotice(h);
  assert.ok(noticeBefore && noticeBefore.classList.contains('theme-attempt-signin'),
    'sanity: the stale card must render the Sign in notice before sign-in arrives');

  const reviewPostsBefore = h.posted.filter((p: any) => p.type === 'GET_THEME_IMAGE_REVIEW').length;
  h.dispatch(themeServiceStatus(signedInStatus()));
  const reviewPostsAfter = h.posted.filter((p: any) => p.type === 'GET_THEME_IMAGE_REVIEW').length;
  assert.equal(reviewPostsAfter, reviewPostsBefore, 'the card must update from the status push alone, without requesting a resend');

  const noticeAfter = attemptNotice(h);
  assert.ok(!noticeAfter || !noticeAfter.classList.contains('theme-attempt-signin'),
    'the Sign in notice must be gone once a signed-in status arrives');
  h.win.close();
});

// Bug fix: a bad_request failure duplicated "The Theme Service rejected this
// request. No credits were charged." twice on one card — once from
// buildThemeAttemptStatusNotice's .theme-attempt-notice above Generate/Retry
// (020-theme-plan-editor.js ~2064), and again as raw text in
// .theme-review-retry-status below it, set from THEME_IMAGE_RETRY_STATE's
// bare payload.error (060-theme-image-review.js's THEME_IMAGE_RETRY_STATE
// handler). The host always sends a fresh THEME_IMAGE_REVIEW just before
// that message, so the friendly notice already covers it; the retry-status
// echo must now be suppressed whenever the item's error_kind already has one.
test('a bad_request retry failure renders exactly one error message, including the error code', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({
      error_kind: 'bad_request',
      error_code: 'slot.achievements:max_count',
      generation_error: { message: 'bad_request' },
    })],
  }));
  h.dispatch({
    type: 'THEME_IMAGE_RETRY_STATE',
    payload: {
      item_id: 'env1',
      busy: false,
      error: 'The Theme Service rejected this request. No credits were charged.',
    },
  });

  const card = h.doc.querySelector('[data-item-id="env1"]');
  assert.ok(card, 'expected a review card for env1');

  const notice = attemptNotice(h);
  assert.ok(notice && notice.classList.contains('theme-attempt-badrequest'),
    'expected the friendly bad_request notice above the button');
  assert.match(notice.textContent, /slot\.achievements:max_count/, 'notice must include the server error code detail');

  const rejectedEls = Array.from(card.querySelectorAll('*')).filter(
    (el: any) => el.children.length === 0 && /rejected this request/.test(el.textContent || ''),
  );
  assert.equal(rejectedEls.length, 1, `expected exactly one error message element, found ${rejectedEls.length}`);

  const statusEl = card.querySelector('.theme-review-retry-status');
  assert.ok(statusEl, 'expected the retry-status element');
  assert.equal(statusEl.textContent, '', 'the retry-status echo must be suppressed once the friendly notice covers this error_kind');
  h.win.close();
});

test('rate_limited, unavailable and content_blocked each still render exactly one error message', async () => {
  const h = await bootThemePanelHarness();

  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ id: 'env1', error_kind: 'rate_limited' })],
  }));
  h.dispatch({
    type: 'THEME_IMAGE_RETRY_STATE',
    payload: { item_id: 'env1', busy: false, error: 'Too many requests, try again shortly' },
  });
  let card = h.doc.querySelector('[data-item-id="env1"]');
  let msgEls = Array.from(card.querySelectorAll('.theme-attempt-notice, .theme-review-retry-status'))
    .filter((el: any) => (el.textContent || '').trim() !== '');
  assert.equal(msgEls.length, 1, 'rate_limited should render exactly one message element');

  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ id: 'env1', error_kind: 'unavailable' })],
  }));
  h.dispatch({
    type: 'THEME_IMAGE_RETRY_STATE',
    payload: { item_id: 'env1', busy: false, error: 'Theme Service unavailable — no credits were charged' },
  });
  card = h.doc.querySelector('[data-item-id="env1"]');
  msgEls = Array.from(card.querySelectorAll('.theme-attempt-notice, .theme-review-retry-status'))
    .filter((el: any) => (el.textContent || '').trim() !== '');
  assert.equal(msgEls.length, 1, 'unavailable should render exactly one message element');

  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ id: 'env1', error_kind: 'content_blocked' })],
  }));
  h.dispatch({
    type: 'THEME_IMAGE_RETRY_STATE',
    payload: { item_id: 'env1', busy: false, error: 'This prompt was blocked by content screening. No credit was spent.' },
  });
  card = h.doc.querySelector('[data-item-id="env1"]');
  msgEls = Array.from(card.querySelectorAll('.theme-attempt-notice, .theme-review-retry-status'))
    .filter((el: any) => (el.textContent || '').trim() !== '');
  assert.equal(msgEls.length, 1, 'content_blocked should render exactly one message element');

  h.win.close();
});
