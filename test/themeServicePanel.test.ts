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
  assert.match(text, /A typical theme takes about 14 credits; a careful run about 8, heavy retries up to 20\./); // guidance sentence
  assert.match(text, /Results depend on your prompts/); // caveat
  assert.match(text, /Prompt tips/);

  const tipsLink = Array.from(h.panelBody().querySelectorAll('a')).find(
    (a: any) => (a.textContent || '').trim() === 'Prompt tips',
  ) as any;
  assert.ok(tipsLink, 'Prompt tips link should render');
  assert.match(tipsLink.getAttribute('href') || '', /#prompt-tips$/);

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

// ── Shell modal layering + always-visible click feedback (bug fix, 0.0.611) ──

test('clicking #tab-theme-builder opens the shell modal immediately with a Connecting… body, before THEME_BUILDER_OPENED arrives', async () => {
  const h = await bootThemePanelHarness();
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  // The harness stubs every getElementById id as a bare <div> (it doesn't
  // replicate panel.ts/server.mjs's `hidden` attribute on the real modal
  // markup), so start it hidden explicitly, matching production markup.
  shell.setAttribute('hidden', '');

  h.doc.getElementById('tab-theme-builder').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  assert.ok(!shell.hasAttribute('hidden'), 'shell modal must be visible immediately on click, before any host reply');
  assert.match(h.panelText(), /Connecting/, 'panel body should show a Connecting… placeholder immediately on click');
  assert.ok(h.posted.some((p) => p.type === 'OPEN_THEME_BUILDER'), 'click should still post OPEN_THEME_BUILDER');

  h.dispatch(themeBuilderOpened(signedOutStatus()));
  assert.match(h.panelText(), /Generate a theme/, 'THEME_BUILDER_OPENED should replace the Connecting… placeholder with the real status');
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
  const input = h.doc.getElementById('theme-prompt-input');
  input.value = 'a cozy forest theme';
  h.doc.getElementById('theme-generate-btn').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
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
  assert.equal(notice.textContent, 'Attempt failed, 2 credit(s) refunded');
  const retryBtn = h.doc.querySelector('[data-item-id="env1"] .theme-review-retry');
  assert.ok(retryBtn && !retryBtn.disabled, 'Retry must remain available after a refund');
  h.win.close();
});

test('provider_failed without a refund flag still renders the refunded notice', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 3,
    items: [baseReviewItem({ error_kind: 'provider_failed', attemptCost: 1 })],
  }));
  const notice = attemptNotice(h);
  assert.ok(notice.classList.contains('theme-attempt-refunded'));
  assert.equal(notice.textContent, 'Attempt failed, 1 credit(s) refunded');
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

test('not_signed_in notice button opens the Theme Builder shell and posts OPEN_THEME_BUILDER', async () => {
  const h = await bootThemePanelHarness();
  const shell = h.doc.getElementById('theme-builder-shell-modal');
  shell.setAttribute('hidden', '');
  h.dispatch(themeImageReview({
    theme_id: 't1',
    creditsSpent: 0,
    items: [baseReviewItem({ error_kind: 'not_signed_in' })],
  }));
  const notice = attemptNotice(h);
  const btn = notice.querySelector('button');
  assert.ok(btn, 'expected an action button on the not_signed_in notice');
  btn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  assert.ok(!shell.hasAttribute('hidden'), 'clicking the notice button should open the Theme Builder shell');
  assert.ok(h.posted.some((p: any) => p.type === 'OPEN_THEME_BUILDER'), 'clicking should post OPEN_THEME_BUILDER');
  h.win.close();
});

// ── content_blocked / account_locked notices (p46-t3) ──

test('content_blocked renders the blocked notice with an Acceptable use link, and keeps Retry enabled', async () => {
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
  assert.match(link.getAttribute('href'), /README\.md#acceptable-use/);
  const retryBtn = h.doc.querySelector('[data-item-id="env1"] .theme-review-retry');
  assert.ok(retryBtn && !retryBtn.disabled, 'Retry must stay enabled so the user can edit the prompt');
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

test('locked status disables the Buy credits button', async () => {
  const h = await bootThemePanelHarness();
  h.dispatch(themeBuilderOpened(signedInStatus({ locked: true, strikes: 3 })));
  const buyBtn: any = Array.from(h.panelBody().querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === 'Buy credits',
  );
  assert.ok(buyBtn, 'expected a Buy credits button');
  assert.equal(buyBtn.disabled, true);
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
