/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p67-t2: boundary contract test — proves the real webview's
// postThemeService() output (media/src/main/010-modals-badges-rebirth.js,
// flat { type, ...fields }) survives panel.ts's
// themeServiceMessagePayload(message) (panel.ts ~203-210, strips `type`)
// and validates against MSG_SCHEMAS.THEME_SERVICE_*
// (src/host/vscode/messages.ts ~877-895) exactly as panel.ts's dispatcher
// calls it at ~1921-1972: MSG_SCHEMAS[type].safeParse(themeServiceMessagePayload(message)).
//
// panel.ts does not export themeServiceMessagePayload, and this task may not
// edit panel.ts, so THEME_SERVICE_MESSAGE_PAYLOAD below replicates its exact
// one-line expression, and a source-snippet assertion (last test in this
// file) fails loudly if panel.ts's actual expression ever drifts from it.
//
// Harness follows test/themeServicePanel.test.ts's bootThemePanelHarness()
// (JSDOM + vm.runInContext against the built media/main.js bundle).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

import { MSG_SCHEMAS } from '../src/host/vscode/messages';

const MAIN_JS_PATH = join(process.cwd(), 'media', 'main.js');
const PANEL_TS_PATH = join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');

// Exact replica of panel.ts's themeServiceMessagePayload(message) (~203-210).
// Kept byte-for-byte in sync via the source-snippet assertion test below.
function themeServiceMessagePayload(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const { type: _type, ...rest } = message as Record<string, unknown>;
  return rest;
}

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
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(errors.length, 0, `main.js threw on boot:\n${errors.map(String).join('\n')}`);

  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  function panelBody(): any {
    return doc.getElementById('theme-service-panel-body');
  }

  function lastPosted(type?: string): any {
    for (let i = posted.length - 1; i >= 0; i--) {
      if (!type || posted[i].type === type) return posted[i];
    }
    return undefined;
  }

  function clickButtonByText(text: string): void {
    const body = panelBody();
    const els: any[] = Array.from(body.querySelectorAll('button, a'));
    const el = els.find((b) => (b.textContent || '').trim() === text || (b.textContent || '').includes(text));
    assert.ok(el, `expected a button/link with text including "${text}"`);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }

  return { win, doc, dom, dispatch, panelBody, posted, lastPosted, clickButtonByText };
}

function signedOutStatus(overrides: any = {}) {
  return { signedIn: false, ...overrides };
}

function signedInStatus(overrides: any = {}) {
  return {
    signedIn: true,
    email: 'dev@example.com',
    provider: 'email',
    credits: 40,
    pricing: {
      typicalTheme: { min: 8, max: 20, typical: 14 },
      packs: [{ id: 'starter45', credits: 45, priceCents: 499, currency: 'usd', label: 'Starter', bonusCredits: 0 }],
    },
    ...overrides,
  };
}

function themeBuilderOpened(payload: any) {
  return { type: 'THEME_BUILDER_OPENED', payload };
}

// ── Drive every THEME_SERVICE_* action and validate each posted message ────

test('boundary contract: every THEME_SERVICE_* message the real webview posts parses against MSG_SCHEMAS via themeServiceMessagePayload', async () => {
  const capturedByType = new Map<string, any>();

  // Each action gets its own fresh harness/panel state, so one state
  // machine's transition never leaves stale DOM for the next action.

  {
    const h = await bootThemePanelHarness();
    h.dispatch(themeBuilderOpened(signedOutStatus()));
    capturedByType.set('THEME_SERVICE_GET_STATUS', h.lastPosted('THEME_SERVICE_GET_STATUS'));
    h.win.close();
  }

  {
    const h = await bootThemePanelHarness();
    h.dispatch(themeBuilderOpened(signedOutStatus()));
    const emailInput = h.doc.getElementById('theme-service-email-input');
    emailInput.value = 'boundary@example.com';
    h.clickButtonByText('Send sign-in link');
    capturedByType.set('THEME_SERVICE_REQUEST_MAGIC_LINK', h.lastPosted('THEME_SERVICE_REQUEST_MAGIC_LINK'));

    const boxes: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-code-boxes input'));
    '123456'.split('').forEach((digit, i) => {
      boxes[i].value = digit;
    });
    h.clickButtonByText('Confirm code');
    capturedByType.set('THEME_SERVICE_VERIFY', h.lastPosted('THEME_SERVICE_VERIFY'));
    h.win.close();
  }

  {
    const h = await bootThemePanelHarness();
    h.dispatch(themeBuilderOpened(signedOutStatus()));
    h.clickButtonByText('Continue with Google');
    capturedByType.set('THEME_SERVICE_GOOGLE_START', h.lastPosted('THEME_SERVICE_GOOGLE_START'));

    const codeInput = h.doc.getElementById('theme-service-google-code');
    codeInput.value = 'pasted-code-123';
    h.clickButtonByText('Submit code');
    capturedByType.set('THEME_SERVICE_GOOGLE_COMPLETE', h.lastPosted('THEME_SERVICE_GOOGLE_COMPLETE'));
    h.win.close();
  }

  {
    const h = await bootThemePanelHarness();
    h.dispatch(themeBuilderOpened(signedOutStatus()));
    h.clickButtonByText('Continue with Google');
    h.dispatch({
      type: 'THEME_SERVICE_STATUS',
      payload: signedOutStatus({
        error: { kind: 'browser_open_failed', message: "couldn't open the browser for sign-in" },
        browserUrl: 'https://auth.example/authorize?code_challenge=abc',
      }),
    });
    h.clickButtonByText('Open the sign-in link');
    capturedByType.set('THEME_SERVICE_GOOGLE_OPEN', h.lastPosted('THEME_SERVICE_GOOGLE_OPEN'));
    h.win.close();
  }

  {
    const h = await bootThemePanelHarness();
    h.dispatch(themeBuilderOpened(signedInStatus()));
    h.clickButtonByText('Sign out');
    capturedByType.set('THEME_SERVICE_SIGN_OUT', h.lastPosted('THEME_SERVICE_SIGN_OUT'));
    h.win.close();
  }

  {
    const h = await bootThemePanelHarness();
    h.dispatch(themeBuilderOpened(signedInStatus()));
    const packButtons: any[] = Array.from(h.panelBody().querySelectorAll('.tsp-pack'));
    packButtons[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    capturedByType.set('THEME_SERVICE_BUY_CREDITS', h.lastPosted('THEME_SERVICE_BUY_CREDITS'));
    h.win.close();
  }

  {
    const h = await bootThemePanelHarness();
    h.dispatch(themeBuilderOpened(signedOutStatus({ showReferralField: true })));
    const referralInput: any = h.doc.getElementById('theme-service-referral-input');
    referralInput.value = 'PARTNER-9';
    referralInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    capturedByType.set('THEME_SERVICE_SET_REFERRAL_CODE', h.lastPosted('THEME_SERVICE_SET_REFERRAL_CODE'));
    h.win.close();
  }

  assert.ok(capturedByType.size >= 8, `expected all 8 THEME_SERVICE_* actions captured, got ${capturedByType.size}`);

  for (const [type, msg] of capturedByType) {
    assert.ok(msg, `expected a posted message of type ${type}`);
    assert.equal(msg.type, type);
    const schema = (MSG_SCHEMAS as any)[type];
    assert.ok(schema, `MSG_SCHEMAS.${type} must exist`);
    const payload = themeServiceMessagePayload(msg);
    const result = schema.safeParse(payload);
    assert.ok(
      result.success,
      `MSG_SCHEMAS.${type}.safeParse(themeServiceMessagePayload(msg)) must succeed for the real webview message ${JSON.stringify(msg)}; issues: ${
        result.success ? '' : JSON.stringify(result.error.issues)
      }`,
    );
  }

  // Negative check: the OLD (buggy) expression `msg.payload` must fail for
  // at least one of these captured messages, proving this test would have
  // caught the p67-t1 regression it guards against.
  const magicLink = capturedByType.get('THEME_SERVICE_REQUEST_MAGIC_LINK');
  const oldExpressionResult = MSG_SCHEMAS.THEME_SERVICE_REQUEST_MAGIC_LINK.safeParse((magicLink as any).payload);
  assert.equal(
    oldExpressionResult.success,
    false,
    'the pre-fix expression msg.payload must fail to parse a flat THEME_SERVICE_REQUEST_MAGIC_LINK message',
  );

  const buyCredits = capturedByType.get('THEME_SERVICE_BUY_CREDITS');
  const oldBuyResult = MSG_SCHEMAS.THEME_SERVICE_BUY_CREDITS.safeParse((buyCredits as any).payload);
  assert.equal(oldBuyResult.success, false, 'the pre-fix expression msg.payload must fail to parse a flat THEME_SERVICE_BUY_CREDITS message');
});

// ── Source-snippet guard: panel.ts must still use this exact expression ────

test('source guard: panel.ts still defines themeServiceMessagePayload with the exact stripped-type expression this test replicates', () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  const start = src.indexOf('function themeServiceMessagePayload(');
  assert.ok(start >= 0, 'panel.ts must still define themeServiceMessagePayload');
  const end = src.indexOf('\n}', start);
  const fn = src.slice(start, end + 2);
  assert.match(
    fn,
    /const\s*\{\s*type:\s*_type,\s*\.\.\.rest\s*\}\s*=\s*message\s*as\s*Record<string,\s*unknown>;/,
    'themeServiceMessagePayload must strip `type` via destructuring exactly as this test\'s replica does — update both together if this ever changes',
  );
  assert.match(fn, /return rest;/);

  // Also guard that every THEME_SERVICE_* dispatch branch still calls
  // safeParse(themeServiceMessagePayload(message)), not raw message.payload.
  const dispatchSection = src.slice(src.indexOf('MSG.THEME_SERVICE_GET_STATUS'), src.indexOf('THEME_SERVICE_SET_REFERRAL_CODE.safeParse') + 200);
  const themeServiceSafeParseCalls = dispatchSection.match(/MSG_SCHEMAS\.THEME_SERVICE_\w+\.safeParse\(themeServiceMessagePayload\(message\)\)/g) || [];
  assert.ok(themeServiceSafeParseCalls.length >= 8, `expected at least 8 THEME_SERVICE_* safeParse calls, found ${themeServiceSafeParseCalls.length}`);
  for (const call of themeServiceSafeParseCalls) {
    assert.match(
      call,
      /safeParse\(themeServiceMessagePayload\(message\)\)/,
      `every THEME_SERVICE_* safeParse call must wrap message in themeServiceMessagePayload(), got: ${call}`,
    );
  }
});
