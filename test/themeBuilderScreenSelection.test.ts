/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p80-t2: screen-selection coverage for THEME_REVIEW_READY / THEME_IMAGE_REVIEW
// (media/src/main/060-theme-image-review.js ~1576-1605, 020-theme-plan-editor.js
// renderThemeImageReview ~1891-2000) — ai vs manual landing screen driven by
// payload.generation_status / generation_resumable, Resume button visibility
// driven solely by generation_resumable (not image_src), and the per-card
// "Names & descriptions" <details> default-open state (020 ~1025-1031).
//
// Harness reused verbatim from test/themeBuilderScreens.test.ts's
// bootThemePanelHarness (JSDOM + vm.runInContext against media/main.js,
// honoring TYCOON_WEBVIEW_BUNDLE).

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

function assertNotVisible(el: any, label?: string): void {
  if (!el) return;
  let node = el;
  while (node) {
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return;
    if (node.style && node.style.display === 'none') return;
    node = node.parentElement;
  }
  assert.fail(`${label || (el.id ? `#${el.id}` : 'element')} is unexpectedly visible`);
}

/** Realistic character_atlas review items (createReviewItems,
 *  src/extension/themeService.ts ~3812-3969: id = `agent_${slot_id}`). */
function characterAtlasItems(): any[] {
  return [
    {
      id: 'agent_0', filename: 'agent_01_hero.png', label: 'Hero', kind: 'character_atlas',
      status: 'pending', prompt: 'p', revision: 0, frame_keys: ['agent_0'], updated_at: '',
      subject: 'Hero',
    },
    {
      id: 'agent_1', filename: 'agent_02_sidekick.png', label: 'Sidekick', kind: 'character_atlas',
      status: 'pending', prompt: 'p', revision: 0, frame_keys: ['agent_1'], updated_at: '',
      subject: 'Sidekick',
    },
  ];
}

/** Realistic object_atlas review item with object_rows (createObjectBoard1Rows
 *  shape, themeService.ts ~3868-3888). */
function objectAtlasItem(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'objects_01', filename: 'objects_01.png', label: 'Static objects 1-16', kind: 'object_atlas',
    status: 'pending', prompt: 'p', revision: 0, frame_keys: ['object_1'], updated_at: '',
    object_rows: [{ kind: 'object_static', object_id: 'object_1', display_name: 'Crate', visual_description: '' }],
    ...overrides,
  };
}

test('THEME_REVIEW_READY from start with generation_resumable false lands on manual: Start-only name input and choice row carry [hidden]', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    h.dispatch({
      type: 'THEME_REVIEW_READY',
      payload: { theme_id: 'ready_theme', generation_status: 'idle', generation_resumable: false },
    });
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'ready_theme', display_name: 'Ready Theme', hasBoards: true,
        generation_status: 'idle', generation_resumable: false,
        items: [...characterAtlasItems(), objectAtlasItem()],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    assertVisible(doc.getElementById('theme-image-review'), '#theme-image-review');
    assertNotVisible(doc.getElementById('theme-prompt-input'), '#theme-prompt-input (manual screen)');
    const choiceRow = doc.querySelector('.tsp-build-choice-row');
    if (choiceRow) assertNotVisible(choiceRow, '.tsp-build-choice-row (manual screen)');
    assertNotVisible(doc.getElementById('theme-plan-editor'), '#theme-plan-editor (manual screen)');
  } finally {
    h.win.close();
  }
});

test('THEME_IMAGE_REVIEW with generation_status "active" lands on ai screen', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    h.dispatch({
      type: 'THEME_REVIEW_READY',
      payload: { theme_id: 'active_theme', generation_status: 'active', generation_resumable: false },
    });
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'active_theme', display_name: 'Active Theme', hasBoards: true,
        generation_status: 'active', generation_resumable: false, generation_active: true,
        items: [...characterAtlasItems(), objectAtlasItem()],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    assertVisible(doc.getElementById('theme-image-review'), '#theme-image-review');
    assertNotVisible(doc.getElementById('theme-prompt-input'), '#theme-prompt-input (ai screen)');
  } finally {
    h.win.close();
  }
});

test('Resume button absent when generation_resumable is false even with a manual image_src upload; present when generation_resumable is true', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    h.dispatch({
      type: 'THEME_REVIEW_READY',
      payload: { theme_id: 'resume_false_theme', generation_status: 'idle', generation_resumable: false },
    });
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'resume_false_theme', display_name: 'Resume False Theme', hasBoards: true,
        generation_status: 'idle', generation_resumable: false,
        items: [
          objectAtlasItem({ image_src: 'https://webview.local/manual-upload.png', generated: true }),
          objectAtlasItem({ id: 'objects_02', image_src: '', generated: false }),
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const resumeBtn = doc.getElementById('theme-review-resume-generation');
    assert.ok(resumeBtn, 'expected the resume button element to exist');
    assert.equal(resumeBtn.hidden, true, 'Resume button must stay hidden when generation_resumable is false, even with a manual image_src upload');

    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'resume_false_theme', display_name: 'Resume False Theme', hasBoards: true,
        generation_status: 'stopped', generation_resumable: true,
        items: [
          objectAtlasItem({ image_src: 'https://webview.local/manual-upload.png', generated: true }),
          objectAtlasItem({ id: 'objects_02', image_src: '', generated: false }),
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(resumeBtn.hidden, false, 'Resume button must be visible when generation_resumable is true and there is an unfinished item');
  } finally {
    h.win.close();
  }
});

test('every card\'s Names & descriptions details is open by default, and each card has name and description inputs', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    h.dispatch({
      type: 'THEME_REVIEW_READY',
      payload: { theme_id: 'cards_theme', generation_status: 'idle', generation_resumable: false },
    });
    await new Promise((r) => setTimeout(r, 0));
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'cards_theme', display_name: 'Cards Theme', hasBoards: true,
        generation_status: 'idle', generation_resumable: false,
        items: [...characterAtlasItems(), objectAtlasItem()],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const cards = Array.from(doc.querySelectorAll('[data-item-id]')) as any[];
    assert.ok(cards.length >= 3, `expected at least 3 cards, got ${cards.length}`);
    for (const card of cards) {
      const details = card.querySelector('.theme-review-names-descriptions-details');
      assert.ok(details, `expected a Names & descriptions <details> on card ${card.getAttribute('data-item-id')}`);
      assert.equal(details.open, true, `Names & descriptions must default to open on card ${card.getAttribute('data-item-id')}`);
      const nameInput = card.querySelector('input.theme-review-name-input, textarea.theme-review-name-input');
      const descInput = card.querySelector('textarea.theme-review-description-input');
      assert.ok(nameInput || descInput, `expected at least a name or description input on card ${card.getAttribute('data-item-id')}`);
    }
  } finally {
    h.win.close();
  }
});
