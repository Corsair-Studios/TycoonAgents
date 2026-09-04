import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Guards plan task p11-t2: collapsed <details> disclosure per Skills/Packs/MCP
 * entry in media/main.js (renderSkillsList/renderMcpList/renderPacksList).
 * Boots main.js in the same jsdom+node:vm harness as test/webviewSmoke.test.ts
 * (see that file for the element-skeleton/ctx-stub rationale), then dispatches
 * fake "skills"/"mcp"/"packs" catalog payloads and asserts:
 *  - each entry renders a closed-by-default details.catalog-details
 *  - the one-line summary is visible with the details collapsed
 *  - Expand all / Collapse all toggle every details in that list
 *  - open state persists across a state-shim getState()/setState() round trip
 *    (the same mechanism the panel already uses for other per-item UI state)
 */

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
    _src = '';
    width = 64;
    height = 64;
    naturalWidth = 64;
    naturalHeight = 64;
    complete = false;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    set src(v: string) {
      this._src = v;
      this.complete = true;
      win.Promise.resolve().then(() => {
        if (typeof this.onload === 'function') this.onload();
      });
    }
    get src() {
      return this._src;
    }
    addEventListener(type: string, cb: () => void) {
      if (type === 'load') this.onload = cb;
      if (type === 'error') this.onerror = cb;
    }
    removeEventListener() {}
  };
}

function buildSkillsPayload() {
  return {
    type: 'skills',
    skills: [
      {
        id: 'skill-one',
        name: 'Skill One',
        description:
          'This is the full long description of skill one. It explains a lot of extra detail that should stay hidden until expanded. And even more context here that pushes well past a single short summary sentence.',
        installed: false,
      },
      {
        id: 'skill-two',
        name: 'Skill Two',
        // Pre-populated authored summary — exercises the `item.summary ||
        // firstSentence(description)` contract's authored branch.
        summary: 'An authored one-line summary under 120 chars.',
        description: 'Full description for skill two goes here, much longer than the summary.',
        installed: true,
        thirdParty: true,
        source: 'https://example.com/skill-two',
      },
    ],
  };
}

function buildMcpPayload() {
  return {
    type: 'mcp',
    servers: [
      {
        id: 'mcp-one',
        name: 'MCP One',
        description: 'Full MCP server description with lots of extra detail about setup and behavior.',
        installed: false,
        requiresEnv: ['API_KEY'],
        docsUrl: 'https://example.com/docs',
      },
    ],
  };
}

function buildPacksPayload() {
  return {
    type: 'packs',
    packs: [
      {
        id: 'pack-one',
        name: 'Pack One',
        description: 'Full pack description explaining everything the pack bundles together.',
        has: { skill: true, mcp: false, agent: false },
        installed: { skill: false },
      },
    ],
  };
}

test('media/main.js: catalog disclosure (Skills/MCP/Packs)', async (t) => {
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

  // State shim: the exact vscode.getState()/setState() mechanism the panel
  // already uses elsewhere for per-item UI state (see main.js badge-unseen /
  // metrics-height / roster-order usages). Backed by a plain object here,
  // the same way the real standalone host backs it with localStorage.
  const posted: any[] = [];
  let stateStore: any = {};
  win.acquireVsCodeApi = () => ({
    postMessage: (mmm: any) => posted.push(mmm),
    getState: () => stateStore,
    setState: (s: any) => {
      stateStore = s;
    },
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
    return 'data:image/png;base64,iVBORw0KGgo=';
  };

  const errors: any[] = [];
  win.addEventListener('error', (e: any) => {
    errors.push(e && (e.error || e.message) ? e.error || e.message : e);
  });
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => {
    errors.push(err || msg);
  };

  function assertNoErrors(step: string) {
    assert.equal(errors.length, 0, `[${step}] main.js threw:\n${errors.map((e) => (e && e.stack) || String(e)).join('\n---\n')}`);
  }

  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  async function flush() {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }

  vm.runInContext(src, dom.getInternalVMContext(), { filename: 'media/main.js' });
  await flush();
  assertNoErrors('boot');

  await t.test('skills list: closed details, visible summary, badges/buttons on the header', async () => {
    dispatch(buildSkillsPayload());
    await flush();
    assertNoErrors('skills-dispatch');

    const list = doc.getElementById('skills-list');
    assert.ok(list, '#skills-list should exist');
    const detailsEls = [...list.querySelectorAll('details.catalog-details')];
    assert.equal(detailsEls.length, 2, 'both skill entries should render a details block');
    for (const d of detailsEls) {
      assert.equal(d.open, false, 'details must be collapsed by default');
    }

    const summaries = [...list.querySelectorAll('.catalog-summary')].map((el: any) => el.textContent);
    assert.ok(summaries[0] && summaries[0].length > 0, 'skill one should show a derived summary line');
    assert.equal(
      summaries[1],
      'An authored one-line summary under 120 chars.',
      'skill two should prefer the authored summary field over the derived one'
    );

    // Header row (button + badge) stays visible/present even though the
    // details is collapsed — it lives outside the <details> entirely.
    const rows = [...list.querySelectorAll('.skill-row')];
    const row2 = rows.find((r: any) => r.dataset.skillRowId === 'skill-two');
    assert.ok(row2, 'skill-two row should exist');
    assert.ok(row2.querySelector('.disclosure-tag'), 'Third-party badge should render on the header row');
    assert.ok(row2.querySelector('[data-remove-skill-id="skill-two"]'), 'installed skill shows a Remove button on the header');
  });

  await t.test('skills list: Expand all / Collapse all toggle every details and persist via state shim', async () => {
    const list = doc.getElementById('skills-list');
    const expandBtn = [...list.querySelectorAll('.catalog-expand-btn')].find(
      (b: any) => b.textContent === 'Expand all'
    );
    const collapseBtn = [...list.querySelectorAll('.catalog-expand-btn')].find(
      (b: any) => b.textContent === 'Collapse all'
    );
    assert.ok(expandBtn, 'Expand all button should exist');
    assert.ok(collapseBtn, 'Collapse all button should exist');

    expandBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    let detailsEls = [...list.querySelectorAll('details.catalog-details')];
    assert.ok(detailsEls.every((d: any) => d.open), 'Expand all should open every details');
    assert.ok(Object.keys(stateStore.catalogDisclosureOpen || {}).length >= 2, 'open state should be persisted to the state shim');

    // Re-render the list (simulating a fresh payload / panel reload) and
    // confirm the persisted state is restored.
    dispatch(buildSkillsPayload());
    await flush();
    detailsEls = [...list.querySelectorAll('details.catalog-details')];
    assert.ok(detailsEls.every((d: any) => d.open), 'reload/re-render should restore open state from persisted store');

    collapseBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    detailsEls = [...list.querySelectorAll('details.catalog-details')];
    assert.ok(detailsEls.every((d: any) => !d.open), 'Collapse all should close every details');
    const openMap = stateStore.catalogDisclosureOpen || {};
    assert.equal(
      Object.keys(openMap).filter((k) => k.startsWith('skill:')).length,
      0,
      'collapse all should clear the persisted open entries for these skill ids'
    );
    assertNoErrors('skills-expand-collapse');
  });

  await t.test('mcp list: closed details by default, docs/env content only inside details', async () => {
    dispatch(buildMcpPayload());
    await flush();
    assertNoErrors('mcp-dispatch');
    const list = doc.getElementById('mcp-list');
    assert.ok(list, '#mcp-list should exist');
    const details = list.querySelector('details.catalog-details');
    assert.ok(details, 'mcp entry should render a details block');
    assert.equal(details.open, false, 'mcp details must be collapsed by default');
    // Native <details> keeps its content in the DOM regardless of open state
    // (only the rendered box is hidden while closed) — assert the docs link
    // lives inside the details body, not on the always-visible header row.
    assert.ok(details.querySelector('.mcp-docs'), 'docs link should be present inside the details body');
    const header = list.querySelector('.catalog-header');
    assert.ok(header && !header.querySelector('.mcp-docs'), 'docs link must not leak onto the always-visible header row');
  });

  await t.test('packs list: closed details by default, chips stay on header', async () => {
    dispatch(buildPacksPayload());
    await flush();
    assertNoErrors('packs-dispatch');
    const list = doc.getElementById('packs-list');
    assert.ok(list, '#packs-list should exist');
    const row = list.querySelector('.skill-row');
    assert.ok(row, 'pack row should exist');
    assert.ok(row.querySelector('.pack-parts'), 'pack-parts chips should render on the header row');
    const details = row.querySelector('details.catalog-details');
    assert.ok(details, 'pack entry should render a details block');
    assert.equal(details.open, false, 'pack details must be collapsed by default');
  });

  win.close();
});
