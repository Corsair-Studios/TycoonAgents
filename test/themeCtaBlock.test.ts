/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression tests for p40-t1/p40-t2: the Themes page header's old
// theme-picker-actions/theme-api-key-row markup was replaced by
// `.theme-cta-block` (Theme Builder promoted to its own primary row, Import
// .zip demoted to a secondary row), and the API-key UI + its
// GET_THEME_IMAGE_SETTINGS/SAVE_THEME_IMAGE_SETTINGS postMessage traffic
// were removed entirely (src/host/vscode/panel.ts ~9375-9394,
// standalone/src/server.mjs ~3501-3520).
//
// Follows test/webviewSmoke.test.ts's harness style: JSDOM parsing for the
// static markup checks, and the shared bootObjScaleHarness()-style runtime
// boot (duplicated locally, trimmed to what this file needs) for the
// postMessage assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');

const PANEL_TS_PATH = join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');
const SERVER_MJS_PATH = join(process.cwd(), 'standalone', 'src', 'server.mjs');
const MAIN_JS_PATH = join(process.cwd(), 'media', 'main.js');

// Grab the <section id="theme-library-section">...</section> fragment out of
// a host source file's raw text (same "grep the template literal out of
// source" technique as test/standaloneHostHtml.test.ts, since neither
// buildHostHtml() nor panel.ts's HTML builder is exported for direct import).
function extractThemeLibrarySection(src: string, label: string): string {
  const start = src.indexOf('id="theme-library-section"');
  assert.ok(start >= 0, `${label} should contain id="theme-library-section"`);
  const sectionStart = src.lastIndexOf('<section', start);
  assert.ok(sectionStart >= 0, `${label}: could not find opening <section> before theme-library-section`);
  const end = src.indexOf('</section>', start);
  assert.ok(end >= 0, `${label}: could not find closing </section> after theme-library-section`);
  return src.slice(sectionStart, end + '</section>'.length);
}

function parseFragment(html: string): any {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

for (const [label, path] of [
  ['panel.ts', PANEL_TS_PATH],
  ['server.mjs', SERVER_MJS_PATH],
] as const) {
  test(`${label}: Theme Builder and Import .zip render in separate rows, Theme Builder carries the primary class`, () => {
    const src = readFileSync(path, 'utf8');
    const fragment = extractThemeLibrarySection(src, label);
    const doc = parseFragment(fragment);

    const ctaBlock = doc.querySelector('.theme-cta-block');
    assert.ok(ctaBlock, `${label}: .theme-cta-block should render`);

    const builderBtn = doc.getElementById('tab-theme-builder');
    assert.ok(builderBtn, `${label}: #tab-theme-builder should render`);
    const importBtn = doc.getElementById('theme-import-btn');
    assert.ok(importBtn, `${label}: #theme-import-btn should render`);

    const primaryRow = builderBtn!.closest('.theme-cta-primary-row');
    const secondaryRow = importBtn!.closest('.theme-cta-secondary-row');
    assert.ok(primaryRow, `${label}: Theme Builder button should sit inside .theme-cta-primary-row`);
    assert.ok(secondaryRow, `${label}: Import .zip button should sit inside .theme-cta-secondary-row`);
    assert.notEqual(
      primaryRow,
      secondaryRow,
      `${label}: Theme Builder and Import .zip should be in different parent row elements`,
    );

    assert.ok(
      builderBtn!.classList.contains('primary'),
      `${label}: Theme Builder button should carry the primary class`,
    );
    assert.ok(
      !importBtn!.classList.contains('primary'),
      `${label}: Import .zip button should not carry the primary class`,
    );

    const chip = doc.getElementById('theme-builder-credits-chip');
    assert.ok(chip, `${label}: #theme-builder-credits-chip should render`);
    assert.ok(chip!.hasAttribute('hidden'), `${label}: #theme-builder-credits-chip should start hidden`);
  });

  test(`${label}: no API-key elements render`, () => {
    const src = readFileSync(path, 'utf8');
    const fragment = extractThemeLibrarySection(src, label);
    const doc = parseFragment(fragment);

    for (const id of [
      'theme-api-key-input',
      'theme-api-key-label',
      'theme-api-key-save',
      'theme-api-key-status',
    ]) {
      assert.equal(doc.getElementById(id), null, `${label}: #${id} should not exist`);
    }
    assert.equal(
      doc.querySelector('.theme-api-key-row'),
      null,
      `${label}: .theme-api-key-row should not exist`,
    );
  });

  test(`${label}: template does not contain theme-api-key markup anywhere in the file`, () => {
    const src = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      src,
      /theme-api-key/i,
      `${label}: source should contain no theme-api-key references at all`,
    );
  });
}

test('media/main.js no longer references the removed API-key element ids or updateThemeApiKeyUi', () => {
  const src = readFileSync(MAIN_JS_PATH, 'utf8');
  for (const id of ['theme-api-key-input', 'theme-api-key-label', 'theme-api-key-save', 'theme-api-key-status']) {
    assert.doesNotMatch(
      src,
      new RegExp(id.replace(/-/g, '\\-')),
      `media/main.js should not reference #${id}`,
    );
  }
  assert.doesNotMatch(src, /updateThemeApiKeyUi/, 'media/main.js should not define/call updateThemeApiKeyUi');
});

// ── Runtime harness (trimmed copy of webviewSmoke.test.ts's bootObjScaleHarness) ──
// Boots media/main.js in a jsdom vm so real message-posting code paths run,
// then asserts the API-key settings messages are never posted.

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
  if (lower.includes('list') || lower.includes('panel') || lower.includes('dialog') || lower.includes('area')) {
    return 'div';
  }
  return 'div';
}

async function bootMinimalHarness() {
  const vm = require('node:vm');
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

  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  win.Image = class {
    set src(_v: string) {}
    addEventListener() {}
    removeEventListener() {}
  };

  win.HTMLCanvasElement.prototype.getContext = function (this: any) {
    return new Proxy(
      { canvas: this },
      { get: (t: any, p: string) => (p in t ? t[p] : () => {}), set: () => true },
    );
  };

  const errors: any[] = [];
  win.addEventListener('error', (e: any) => {
    errors.push(e && (e.error || e.message) ? e.error || e.message : e);
  });
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => errors.push(err || msg);

  vm.runInContext(src, dom.getInternalVMContext(), { filename: 'media/main.js' });

  async function flush() {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }
  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  await flush();
  return { win, doc, dispatch, flush, errors, posted };
}

test('opening the Theme Builder tab posts neither GET_THEME_IMAGE_SETTINGS nor SAVE_THEME_IMAGE_SETTINGS', async () => {
  const h = await bootMinimalHarness();
  try {
    const tabBtn = h.doc.getElementById('tab-theme-builder');
    assert.ok(tabBtn, '#tab-theme-builder should exist');
    tabBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const bad = h.posted.filter(
      (m: any) => m && (m.type === 'GET_THEME_IMAGE_SETTINGS' || m.type === 'SAVE_THEME_IMAGE_SETTINGS'),
    );
    assert.deepEqual(bad, [], `no image-settings messages should post; got: ${JSON.stringify(bad)}`);
  } finally {
    h.win.close();
  }
});

test('showing THEME_IMAGE_REVIEW posts neither GET_THEME_IMAGE_SETTINGS nor SAVE_THEME_IMAGE_SETTINGS', async () => {
  const h = await bootMinimalHarness();
  try {
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'smoke_theme',
        display_name: 'Smoke Theme',
        items: [
          {
            id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
            status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
          },
        ],
        creative_direction: '',
      },
    });
    await h.flush();

    const bad = h.posted.filter(
      (m: any) => m && (m.type === 'GET_THEME_IMAGE_SETTINGS' || m.type === 'SAVE_THEME_IMAGE_SETTINGS'),
    );
    assert.deepEqual(bad, [], `no image-settings messages should post; got: ${JSON.stringify(bad)}`);
  } finally {
    h.win.close();
  }
});
