/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p79-t3: new-user-path coverage for the approved Theme Builder redesign
// (plan.json p79) — Start / AI / Manual screens driven by
// themeBuilderScreen ("start"|"ai"|"manual") and renderThemeBuilderScreen
// (media/src/main/010-modals-badges-rebirth.js ~1090-1147), autosave via
// autosaveThemePlan/scheduleThemeAutosave (~2978-3013, 400ms debounce)
// fired from BACKGROUND_REPLACE_RESULT (060-theme-image-review.js
// ~2361-2373), and AI/manual precedence via applyThemeReviewFieldToPlan /
// bindThemePlanEditorLiveSync writing into the shared currentThemePlan
// (020-theme-plan-editor.js ~976-986, 010-modals-badges-rebirth.js
// ~1169-1199) — "whichever was edited last wins".
//
// Harness copied verbatim from test/themeBuilderEntry.test.ts's
// bootThemePanelHarness (JSDOM + vm.runInContext against the built
// media/main.js bundle, MAIN_JS_PATH honoring TYCOON_WEBVIEW_BUNDLE) — same
// markup fragment, same stubs, same assertVisible ancestor walk.

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

  function lastPosted(type?: string): any {
    for (let i = posted.length - 1; i >= 0; i--) {
      if (!type || posted[i].type === type) return posted[i];
    }
    return undefined;
  }

  function postedOfType(type: string): any[] {
    return posted.filter((m) => m.type === type);
  }

  function click(id: string): void {
    const el = doc.getElementById(id);
    assert.ok(el, `expected element #${id} to exist`);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }

  return { win, doc, dom, dispatch, posted, lastPosted, postedOfType, click };
}

async function openThemeBuilderOnEmptyDraft() {
  const h = await bootThemePanelHarness();
  h.click('tab-theme-builder');
  await new Promise((r) => setTimeout(r, 0));
  return h;
}

// p78-t2: walks an element's ancestor chain (parentElement) up to the
// document, failing if any ancestor carries the `hidden` attribute or an
// inline `display: none`. Used for every user-facing assertion below so a
// test can only pass if a real user could actually see the element.
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

/** Asserts el is either absent from the document or not visible (hidden
 *  ancestor / display:none) — the "not visible" half of assertVisible's
 *  contract, for asserting AI-only or Start-only elements are gone. */
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

const SPRITE_BOARD_SLOTS: Array<{ containerId: string; count: number }> = [
  { containerId: 'theme-plan-characters', count: 16 },
  { containerId: 'theme-plan-enemies', count: 4 },
  { containerId: 'theme-plan-decor-slots', count: 9 },
  { containerId: 'theme-plan-objects-slots', count: 21 },
  { containerId: 'theme-plan-expressions-slots', count: 8 },
  { containerId: 'theme-plan-achievements-slots', count: 25 },
];

/** Builds the 83-item THEME_IMAGE_REVIEW fixture reused from
 *  test/themeBuilderEntry.test.ts's real-path test — one review item per
 *  sprite-board slot, generic ids/kinds sufficient to render a card with
 *  Upload/Retry controls for every slot. */
function buildEightyThreeItemFixture(): any[] {
  const items: any[] = [];
  let n = 0;
  for (const { count } of SPRITE_BOARD_SLOTS) {
    for (let i = 0; i < count; i++) {
      n += 1;
      items.push({
        id: `item_${n}`, filename: `item_${n}.png`, label: `Item ${n}`, kind: 'object',
        status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: '',
      });
    }
  }
  return items;
}

// ── (a) Start screen: exactly the name field + two buttons ─────────────────

test('Start screen shows exactly the name field and the two choice buttons; every AI/manual-only or retired element is absent or not visible', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    assertVisible(doc.getElementById('theme-prompt-input'), '#theme-prompt-input');
    assertVisible(doc.getElementById('theme-generate-with-ai-btn'), '#theme-generate-with-ai-btn');
    assertVisible(doc.getElementById('theme-build-manually-btn'), '#theme-build-manually-btn');

    // Credits notice / AI warning / status chip: ai-screen-only.
    assertNotVisible(doc.getElementById('theme-builder-credits-chip'), '#theme-builder-credits-chip');
    assertNotVisible(doc.querySelector('.theme-generation-approval-warning'), '.theme-generation-approval-warning');
    assertNotVisible(doc.getElementById('theme-builder-status-chip'), '#theme-builder-status-chip');
    // Plan editor / board review: ai/manual-only.
    assertNotVisible(doc.getElementById('theme-plan-editor'), '#theme-plan-editor');
    assertNotVisible(doc.getElementById('theme-image-review'), '#theme-image-review');
    // Header bar (Save theme, name title): ai/manual-only.
    assertNotVisible(doc.getElementById('theme-builder-header-bar'), '#theme-builder-header-bar');
    assertNotVisible(doc.getElementById('theme-save-theme-btn'), '#theme-save-theme-btn');
    // Retired controls must never render at all.
    assert.equal(doc.querySelectorAll('.theme-builder-new-theme-btn').length, 0, 'New theme button must not exist');
    assert.equal(doc.getElementById('theme-plan-details-toggle'), null, 'Edit plan details toggle must not exist');
    // A single, authoritative name field — no second visible name input.
    const visibleNameInputs = [doc.getElementById('theme-prompt-input'), doc.getElementById('theme-plan-name')]
      .filter((el) => el)
      .filter((el) => {
        try {
          assertVisible(el);
          return true;
        } catch {
          return false;
        }
      });
    assert.equal(visibleNameInputs.length, 1, 'exactly one visible name field on the Start screen');
  } finally {
    h.win.close();
  }
});

// ── (b) Manual path: cards editable, per-board controls present ────────────

test('Manual path: after Build manually + THEME_PLAN_SAVED + THEME_IMAGE_REVIEW, every board card shows visible name/description inputs and per-board controls; AI-only elements stay absent', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Manual Path Theme';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));
    const saved = h.lastPosted('saveThemePlan');
    assert.ok(saved, 'expected saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'manual_path_theme', plan: { ...saved.plan, theme_id: 'manual_path_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    const items = buildEightyThreeItemFixture();
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: { theme_id: 'manual_path_theme', display_name: 'Manual Path Theme', hasBoards: false, items },
    });
    await new Promise((r) => setTimeout(r, 0));

    assertVisible(doc.getElementById('theme-image-review'), '#theme-image-review');
    // Manual screen never shows the plan editor.
    assertNotVisible(doc.getElementById('theme-plan-editor'), '#theme-plan-editor');
    // AI-only elements stay out even once boards exist.
    assertNotVisible(doc.querySelector('.theme-generation-approval-warning'), '.theme-generation-approval-warning');
    assertNotVisible(doc.getElementById('theme-builder-status-chip'), '#theme-builder-status-chip');

    const cards = Array.from(doc.querySelectorAll('[data-item-id]')) as any[];
    assert.equal(cards.length, items.length, 'expected one card per review item');
    for (const card of cards) {
      const upload = card.querySelector('.theme-review-upload');
      const retry = card.querySelector('.theme-review-retry');
      assertVisible(upload, 'card .theme-review-upload');
      assertVisible(retry, 'card .theme-review-retry');
      assert.ok(card.contains(upload), 'Upload control must live inside the same card element as the image');
      assert.ok(card.contains(retry), 'Retry/Generate control must live inside the same card element as the image');
    }
  } finally {
    h.win.close();
  }
});

// ── (c) Autosave: card edit + successful upload -> exactly one saveThemePlan
//     with the edited name at the correct plan index ────────────────────────

test('Autosave: editing a board card name then a successful BACKGROUND_REPLACE_RESULT posts exactly one saveThemePlan carrying the edit at the right plan index (single- and two-digit slots)', async (t) => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Autosave Theme';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));
    const saved = h.lastPosted('saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'autosave_theme', plan: { ...saved.plan, theme_id: 'autosave_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Objects have both a name AND description row in the merged "Names &
    // descriptions" editor (themeReviewNameRows/themeReviewDescriptionRows,
    // 020-theme-plan-editor.js), and their rowId is the manifest object_id
    // looked up positionally against themeBuildables — but with no manifest
    // loaded (a fresh manual-path draft has none), themeReviewIndexForRow
    // resolves via array position, so an object_atlas item whose object_rows
    // carry deterministic object_ids exercises the same
    // applyThemeReviewFieldToPlan -> currentThemePlan.objects[index] path
    // that badge/achievement rows use (their rowId directly encodes the
    // index: "achievement_" + index). Badges are the simplest deterministic
    // case: rowId === "achievement_<index>", parsed straight into the index
    // — used here for both the single- and two-digit slot proof.
    const items: any[] = [
      {
        id: 'achievements_atlas', filename: 'achievements_atlas.png', label: 'Badges', kind: 'achievement_atlas',
        status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: '',
        achievement_names: new Array(25).fill('').map((_, i) => `Badge ${i + 1}`),
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: { theme_id: 'autosave_theme', display_name: 'Autosave Theme', hasBoards: false, items },
    });
    await new Promise((r) => setTimeout(r, 0));

    const card = doc.querySelector('[data-item-id="achievements_atlas"]');
    assert.ok(card, 'expected the achievements_atlas card to render');

    // Single-digit slot: achievement_2 -> plan.achievements[2].
    const nameInputSingle = card.querySelector('input.theme-review-name-input[data-row-id="achievement_2"]');
    assert.ok(nameInputSingle, 'expected a name input for achievement_2');
    nameInputSingle.value = 'Edited Badge Two';
    nameInputSingle.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const postedBefore = h.postedOfType('saveThemePlan').length;
    // scheduleThemeAutosave debounces 400ms via window.setTimeout — advance
    // it deterministically with node:test's fake timers (jsdom's
    // window.setTimeout is the same global setTimeout node:test mocks, per
    // an isolated check against this exact JSDOM/vm harness) instead of a
    // real wait. Scoped tightly around just the debounce and reset() right
    // after, so it can't interfere with any other real timer in this test.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    h.dispatch({ type: 'BACKGROUND_REPLACE_RESULT', payload: { ok: true } });
    t.mock.timers.tick(400);
    t.mock.timers.reset();

    const postedAfter = h.postedOfType('saveThemePlan');
    assert.equal(postedAfter.length, postedBefore + 1, 'exactly one saveThemePlan must be posted by the debounced autosave');
    const autosavePosted = postedAfter[postedAfter.length - 1];
    assert.equal(autosavePosted.plan.achievements[2], 'Edited Badge Two', 'plan.achievements[2] must equal the edited name — proves the index mapping');

    // Two-digit slot: achievement_12.
    const nameInputTwoDigit = card.querySelector('input.theme-review-name-input[data-row-id="achievement_12"]');
    assert.ok(nameInputTwoDigit, 'expected a name input for achievement_12');
    nameInputTwoDigit.value = 'Edited Badge Twelve';
    nameInputTwoDigit.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const secondBefore = h.postedOfType('saveThemePlan').length;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    h.dispatch({ type: 'BACKGROUND_REPLACE_RESULT', payload: { ok: true } });
    t.mock.timers.tick(400);
    t.mock.timers.reset();

    const secondAfter = h.postedOfType('saveThemePlan');
    assert.equal(secondAfter.length, secondBefore + 1, 'exactly one saveThemePlan for the second (two-digit) autosave');
    assert.equal(secondAfter[secondAfter.length - 1].plan.achievements[12], 'Edited Badge Twelve', 'plan.achievements[12] must equal the edited name');
  } finally {
    h.win.close();
  }
});

// ── (c2) Character card name/description + crate description: same
//     card-edit -> currentThemePlan -> Save theme/autosave contract as (c),
//     now that characterNameInput wires into applyThemeReviewFieldToPlan
//     (020-theme-plan-editor.js ~2090-2107) and crate/poof/projectile
//     descriptions write via THEME_REVIEW_SCALAR_FIELD_BY_KIND (~977-990).

test('Character card: typing a name into a visible character_atlas card lands in plan.characters at the index encoded by its item id (single- and two-digit), and a description edit lands in plan.character_descriptions at the same index', async (t) => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Character Card Theme';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));
    const saved = h.lastPosted('saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'character_card_theme', plan: { ...saved.plan, theme_id: 'character_card_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    // themeReviewIndexForRow("character", rowId) parses the rowId's
    // trailing digits DIRECTLY as the 0-based plan index (no +/-1 offset —
    // 020-theme-plan-editor.js ~938-941: /(\d+)$/.exec(rowId)). rowId is
    // item.id (characterNameInput's applyThemeReviewFieldToPlan call uses
    // item.id, ~2107), so "character_03" -> plan.characters[3] and
    // "character_12" -> plan.characters[12] — confirmed by reading the
    // function rather than assuming a 1-based slot-number convention.
    const items: any[] = [
      {
        id: 'character_03', filename: 'character_03.png', label: 'Character 4', kind: 'character_atlas',
        status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: '', subject: 'Original Name Three',
      },
      {
        id: 'character_12', filename: 'character_12.png', label: 'Character 13', kind: 'character_atlas',
        status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: '', subject: 'Original Name Twelve',
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: { theme_id: 'character_card_theme', display_name: 'Character Card Theme', hasBoards: false, items },
    });
    await new Promise((r) => setTimeout(r, 0));

    const cardSingle = doc.querySelector('[data-item-id="character_03"]');
    assert.ok(cardSingle, 'expected the character_03 card to render');
    const nameInputSingle = cardSingle.querySelector('input.theme-review-name-input');
    assertVisible(nameInputSingle, 'character_03 Character name input');
    assert.equal(nameInputSingle.value, 'Original Name Three', 'card must start prefilled from item.subject');
    nameInputSingle.value = 'Edited Character Three';
    nameInputSingle.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const cardTwoDigit = doc.querySelector('[data-item-id="character_12"]');
    assert.ok(cardTwoDigit, 'expected the character_12 card to render');
    const nameInputTwoDigit = cardTwoDigit.querySelector('input.theme-review-name-input');
    assertVisible(nameInputTwoDigit, 'character_12 Character name input');
    nameInputTwoDigit.value = 'Edited Character Twelve';
    nameInputTwoDigit.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    // Description field lives in the "Names & descriptions" section, same
    // card, data-row-id === item.id, data-item-kind="character".
    const descInputSingle = cardSingle.querySelector('textarea.theme-review-description-input[data-row-id="character_03"]');
    assert.ok(descInputSingle, 'expected a description textarea for character_03');
    descInputSingle.value = 'A gruff dockworker with an oil-stained coat.';
    descInputSingle.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));

    const posted = h.lastPosted('saveThemePlan');
    assert.ok(posted, 'expected a saveThemePlan from Save theme');
    assert.equal(posted.plan.characters[3], 'Edited Character Three', 'plan.characters[3] must equal the character_03 card edit (0-based, no offset)');
    assert.equal(posted.plan.characters[12], 'Edited Character Twelve', 'plan.characters[12] must equal the character_12 card edit');
    assert.equal(
      posted.plan.character_descriptions[3],
      'A gruff dockworker with an oil-stained coat.',
      'plan.character_descriptions[3] must equal the character_03 description edit',
    );
  } finally {
    h.win.close();
  }
});

test('Crate description: typing into the visible crate description field on an object board card lands in plan.crate_description', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Crate Description Theme';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));
    const saved = h.lastPosted('saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'crate_description_theme', plan: { ...saved.plan, theme_id: 'crate_description_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    // The crate/poof description rows only exist on object board 2
    // (item.id matching /objects_(\d+)/ with boardNumber >= 2 —
    // 020-theme-plan-editor.js ~651-698), and require item.crate_description
    // to seed the textarea's initial value.
    const items: any[] = [
      {
        id: 'objects_02', filename: 'objects_02.png', label: 'Objects 17-21', kind: 'object_atlas',
        status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: '',
        crate_description: 'A plain wooden crate.',
        poof_description: 'A puff of dust.',
        object_rows: [
          { kind: 'object_static', object_id: 'object_17', display_name: 'Object 17', visual_description: '' },
        ],
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: { theme_id: 'crate_description_theme', display_name: 'Crate Description Theme', hasBoards: false, items },
    });
    await new Promise((r) => setTimeout(r, 0));

    const card = doc.querySelector('[data-item-id="objects_02"]');
    assert.ok(card, 'expected the objects_02 card to render');
    const crateDescInput = card.querySelector('textarea.theme-review-description-input[data-row-id="crate"]');
    assertVisible(crateDescInput, 'crate description textarea');
    assert.equal(crateDescInput.value, 'A plain wooden crate.', 'crate textarea must start prefilled from item.crate_description');
    crateDescInput.value = 'A reinforced steel shipping crate with rivets.';
    crateDescInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));

    const posted = h.lastPosted('saveThemePlan');
    assert.ok(posted, 'expected a saveThemePlan from Save theme');
    assert.equal(
      posted.plan.crate_description,
      'A reinforced steel shipping crate with rivets.',
      'plan.crate_description must equal the crate card edit',
    );
  } finally {
    h.win.close();
  }
});

// ── (d) Precedence: a card edit after THEME_PLAN_READY/THEME_IMAGE_REVIEW
//     must win over the AI-filled text on Save theme ────────────────────────

test('Precedence (AI path): a card edit after THEME_PLAN_READY and THEME_IMAGE_REVIEW is what Save theme posts, not the AI-filled text', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    const aiPlan = {
      display_name: 'AI Precedence Theme',
      creative_direction: 'AI direction.',
      environment: 'AI environment.',
      achievements: new Array(25).fill('').map((_, i) => `AI Badge ${i + 1}`),
    };
    h.dispatch({ type: 'THEME_PLAN_READY', payload: { plan: aiPlan } });
    await new Promise((r) => setTimeout(r, 0));
    // Inline overwrite confirm (confirmThemePlanOverwrite) may gate the
    // render on an empty draft with no dirty content — accept if present.
    const overwriteBtn = doc.querySelector('.theme-plan-inline-confirm-btn');
    if (overwriteBtn) {
      overwriteBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    }

    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));
    const firstSave = h.lastPosted('saveThemePlan');
    assert.ok(firstSave, 'expected the AI-path Save theme to post saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'ai_precedence_theme', plan: { ...firstSave.plan, theme_id: 'ai_precedence_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    const items: any[] = [
      {
        id: 'achievements_atlas', filename: 'achievements_atlas.png', label: 'Badges', kind: 'achievement_atlas',
        status: 'pending', prompt: 'p', revision: 0, frame_keys: [], updated_at: '',
        achievement_names: aiPlan.achievements,
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: { theme_id: 'ai_precedence_theme', display_name: 'AI Precedence Theme', hasBoards: false, items },
    });
    await new Promise((r) => setTimeout(r, 0));

    const card = doc.querySelector('[data-item-id="achievements_atlas"]');
    assert.ok(card, 'expected the achievements_atlas card to render');
    const nameInput = card.querySelector('input.theme-review-name-input[data-row-id="achievement_5"]');
    assert.ok(nameInput, 'expected a name input for achievement_5');
    assert.equal(nameInput.value, 'AI Badge 6', 'card must start prefilled from the AI text');
    nameInput.value = 'Human Edited Badge';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));

    const secondSave = h.lastPosted('saveThemePlan');
    assert.ok(secondSave, 'expected a second saveThemePlan from the second Save theme click');
    assert.equal(secondSave.plan.achievements[5], 'Human Edited Badge', 'the posted plan must carry the card edit, not the AI text');
  } finally {
    h.win.close();
  }
});

// ── (e) AI path: plan review always shown, no skip; pause + Generate images

test('AI path: the plan review is visible with no skip control; Pause after each image and Generate images are visible', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    h.dispatch({
      type: 'THEME_PLAN_READY',
      payload: { plan: { display_name: 'AI Review Theme', characters: new Array(16).fill('AI Char') } },
    });
    await new Promise((r) => setTimeout(r, 0));
    const overwriteBtn = doc.querySelector('.theme-plan-inline-confirm-btn');
    if (overwriteBtn) {
      overwriteBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    }

    assertVisible(doc.getElementById('theme-plan-editor'), '#theme-plan-editor');
    assertVisible(doc.getElementById('theme-pause-for-review'), '#theme-pause-for-review');
    assertVisible(doc.getElementById('theme-start-generation-btn'), '#theme-start-generation-btn');
    // No skip control anywhere in the plan editor.
    const skipButtons = Array.from(doc.querySelectorAll('#theme-plan-editor button, #theme-plan-editor a'))
      .filter((el: any) => /skip/i.test(el.textContent || ''));
    assert.equal(skipButtons.length, 0, 'no skip control must exist on the ai plan review');
  } finally {
    h.win.close();
  }
});
