/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p77-t3: webview coverage for the p77 Theme Builder entry paths —
// openThemeBuilderPlanEditorTab's session check + enterNewThemeDraftMode
// (media/src/main/010-modals-badges-rebirth.js ~1556-1583), the
// #theme-build-choice-row Generate with AI / Build manually buttons
// (~2265-2335), submitDraftThemePlan / updateThemeDraftUi /
// clearThemeBuilderDraftState (~2658-2816), and the "Edit plan details"
// disclosure (~2727-2780), plus THEME_PLAN_SAVED/THEME_INITIALIZED hasBoards
// handling in 060-theme-image-review.js (~1510-1750).
//
// Harness copied verbatim from test/themeNewDraft.test.ts's
// bootThemePanelHarness (JSDOM + vm.runInContext against the built
// media/main.js bundle) — same markup fragment, same stubs.

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

  function click(id: string): void {
    const el = doc.getElementById(id);
    assert.ok(el, `expected element #${id} to exist`);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }

  return { win, doc, dom, dispatch, posted, lastPosted, click };
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
// test can only pass if a real user could actually see the element — the
// p77 bug (validation/name field written into a still-hidden container)
// would have failed this check.
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

const SPRITE_BOARD_SLOTS: Array<{ containerId: string; count: number }> = [
  { containerId: 'theme-plan-characters', count: 16 },
  { containerId: 'theme-plan-enemies', count: 4 },
  { containerId: 'theme-plan-decor-slots', count: 9 },
  { containerId: 'theme-plan-objects-slots', count: 21 },
  { containerId: 'theme-plan-expressions-slots', count: 8 },
  { containerId: 'theme-plan-achievements-slots', count: 25 },
];

// ── Entry path: tab click renders the choice row ────────────────────────────

// p79-t3: rewritten for the approved Start screen — exactly the name field
// and the Generate with AI / Build manually choice row are visible; the
// plan editor (ai-only) stays hidden until an AI plan lands.
test('clicking the Theme Builder tab renders the Start screen: name field plus Generate with AI / Build manually, plan editor hidden', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    assertVisible(doc.getElementById('theme-prompt-input'), '#theme-prompt-input');
    assertVisible(doc.getElementById('theme-build-choice-row'), '#theme-build-choice-row');
    assertVisible(doc.getElementById('theme-generate-with-ai-btn'), '#theme-generate-with-ai-btn');
    assertVisible(doc.getElementById('theme-build-manually-btn'), '#theme-build-manually-btn');

    const planEditor = doc.getElementById('theme-plan-editor');
    assert.ok(planEditor.hasAttribute('hidden'), 'plan editor must stay hidden on the Start screen');
    assert.equal(doc.getElementById('theme-plan-name').value, '', 'draft name field must start empty');
  } finally {
    h.win.close();
  }
});

test('the shell "Back to builder" button reaches the same draft entry point', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    // Force the sign-in shell open via a signed-out "Generate with AI" click.
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));
    h.click('theme-generate-with-ai-btn');
    await new Promise((r) => setTimeout(r, 0));

    const shellModal = doc.getElementById('theme-builder-shell-modal');
    assert.ok(shellModal, 'expected the sign-in shell modal to exist');
    const backToBuilderBtn = doc.getElementById('theme-builder-shell-continue');
    assert.ok(backToBuilderBtn, 'expected the "Back to builder" button');
    assert.equal((backToBuilderBtn.textContent || '').trim(), 'Back to builder');

    backToBuilderBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    // p79-t3: the draft entry point is now the Start screen — name field
    // plus the choice row, not the (ai-only) plan editor.
    assertVisible(doc.getElementById('theme-prompt-input'), '#theme-prompt-input');
    assertVisible(doc.getElementById('theme-build-choice-row'), '#theme-build-choice-row');
    assert.ok(doc.getElementById('theme-plan-editor').hasAttribute('hidden'), 'plan editor must stay hidden on the Start screen reached via Back to builder');
  } finally {
    h.win.close();
  }
});

// ── Build manually validation ───────────────────────────────────────────────

test('Build manually with an empty name shows a validation message and posts nothing', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const preCount = h.posted.length;
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(h.posted.length, preCount, 'no message should be posted on validation failure');
    // p78-t2: the real handler writes into #theme-build-choice-validation,
    // which lives inside #theme-build-choice-row (outside the hidden
    // #theme-plan-editor) — writing into the old #theme-plan-validation
    // gave the user no feedback at all, since that container can be hidden.
    const validation = doc.getElementById('theme-build-choice-validation');
    assert.ok((validation.textContent || '').length > 0, 'expected a validation message');
    assertVisible(validation, '#theme-build-choice-validation');
  } finally {
    h.win.close();
  }
});

test('Build manually with a name posts saveThemePlan with that display_name and empty slots', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    // p78-t2: type into the visible #theme-prompt-input only — never set
    // #theme-plan-name directly. That hidden duplicate is what the p77
    // tests typed into, which is exactly why they missed the real bug.
    const promptInput = doc.getElementById('theme-prompt-input');
    promptInput.value = 'Manual Draft Theme';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));

    const posted = h.lastPosted('saveThemePlan');
    assert.ok(posted, 'expected a saveThemePlan message');
    assert.equal(posted.plan.display_name, 'Manual Draft Theme');
    assert.ok(Array.isArray(posted.plan.characters), 'expected an empty-slot characters array');
    assert.ok(
      posted.plan.characters.every((c: string) => !c || c.trim() === ''),
      'Build manually must post empty (unfilled) slots',
    );
  } finally {
    h.win.close();
  }
});

// p79-t3: rewritten for the approved layout — the manual screen goes
// straight to the board grid, never the plan editor (that's ai-only). Type
// into #theme-prompt-input only, click #theme-build-manually-btn, follow
// through THEME_PLAN_SAVED and THEME_IMAGE_REVIEW, asserting every
// user-facing element is actually visible (no hidden ancestor) at each step.
test('Build manually real user path: typed name posts, board grid becomes visible (never the plan editor), then per-board Upload/Generate controls appear', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const promptInput = doc.getElementById('theme-prompt-input');
    assertVisible(promptInput, '#theme-prompt-input');
    promptInput.value = 'Star Trek';
    promptInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const buildManuallyBtn = doc.getElementById('theme-build-manually-btn');
    assertVisible(buildManuallyBtn, '#theme-build-manually-btn');
    buildManuallyBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const posted = h.lastPosted('saveThemePlan');
    assert.ok(posted, 'expected a saveThemePlan message from the visible-field path');
    assert.equal(posted.plan.display_name, 'Star Trek', 'display_name must equal what the user typed into #theme-prompt-input');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'star_trek', plan: { ...posted.plan, theme_id: 'star_trek' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    // p79-t3: the manual screen never shows the plan editor — the board
    // grid is reached directly.
    const planEditor = doc.getElementById('theme-plan-editor');
    assert.ok(planEditor.hasAttribute('hidden'), 'plan editor must stay hidden on the manual screen');

    // Build a THEME_IMAGE_REVIEW item per sprite-board slot so the per-board
    // Upload/Generate controls can be asserted for real board coverage.
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
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: { theme_id: 'star_trek', display_name: 'Star Trek', hasBoards: false, items },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reviewSection = doc.getElementById('theme-image-review');
    assertVisible(reviewSection, '#theme-image-review');
    const uploadBtns = doc.querySelectorAll('.theme-review-upload');
    const generateBtns = doc.querySelectorAll('.theme-review-retry');
    assert.equal(uploadBtns.length, items.length, 'expected one Upload control per board item');
    assert.equal(generateBtns.length, items.length, 'expected one Generate/Retry control per board item');
    for (const btn of Array.from(uploadBtns) as any[]) assertVisible(btn, '.theme-review-upload');
    for (const btn of Array.from(generateBtns) as any[]) assertVisible(btn, '.theme-review-retry');
  } finally {
    h.win.close();
  }
});

// p78-t2: a theme selected earlier (hasBoards:true) must not leak into a
// freshly opened new-theme draft — #theme-build-actions must stay hidden.
test('#theme-build-actions stays hidden when opening the builder for a new theme, even after a previous theme had boards', async () => {
  const h = await bootThemePanelHarness();
  try {
    const { doc } = h;

    h.dispatch({
      type: 'THEME_INITIALIZED',
      payload: {
        manifest: { theme_id: 'theme_a', display_name: 'Theme A' },
        frames: { environment_background: ['data:image/png;base64,AA=='] },
        hasBoards: true,
        boardCount: 1,
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Open the builder fresh (new-theme draft entry), as a user would from
    // the tab, not from "Review images" on theme A.
    h.click('tab-theme-builder');
    await new Promise((r) => setTimeout(r, 0));

    const buildActions = doc.getElementById('theme-build-actions');
    assert.ok(buildActions.hasAttribute('hidden'), '#theme-build-actions must be hidden for a fresh new-theme draft');
  } finally {
    h.win.close();
  }
});

// ── THEME_PLAN_SAVED hasBoards gating ───────────────────────────────────────

test('THEME_PLAN_SAVED with hasBoards:false keeps #theme-build-actions hidden and shows the board grid', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const nameInput = doc.getElementById('theme-plan-name');
    nameInput.value = 'Boardless Theme';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));
    const firstSave = h.lastPosted('saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'boardless_theme', plan: { ...firstSave.plan, theme_id: 'boardless_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(doc.getElementById('theme-build-actions').hasAttribute('hidden'), '#theme-build-actions must stay hidden with hasBoards:false');
    assert.ok(!doc.getElementById('theme-image-review').hasAttribute('hidden'), 'board grid (image review) must be shown');
  } finally {
    h.win.close();
  }
});

// p79-t3: "Review generated images" / #theme-build-actions is retired —
// renderThemeBuilderScreen always keeps it hidden; the board grid is reached
// directly on both the ai and manual screens (010-modals-badges-rebirth.js
// ~1140-1141).
test('#theme-build-actions stays permanently hidden even after THEME_INITIALIZED reports hasBoards:true for the current draft', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const nameInput = doc.getElementById('theme-plan-name');
    nameInput.value = 'Boarded Theme';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));
    const firstSave = h.lastPosted('saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'boarded_theme', plan: { ...firstSave.plan, theme_id: 'boarded_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(doc.getElementById('theme-build-actions').hasAttribute('hidden'));

    h.dispatch({
      type: 'THEME_INITIALIZED',
      payload: {
        manifest: { theme_id: 'boarded_theme', display_name: 'Boarded Theme' },
        frames: { environment_background: ['data:image/png;base64,AA=='] },
        hasBoards: true,
        boardCount: 1,
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(doc.getElementById('theme-build-actions').hasAttribute('hidden'), '#theme-build-actions must stay hidden — the board grid is reached directly, not through this retired control');
  } finally {
    h.win.close();
  }
});

test('THEME_INITIALIZED for a different theme_id clears draft state (a later Build manually posts theme_id undefined)', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const nameInput = doc.getElementById('theme-plan-name');
    nameInput.value = 'Original Draft';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-save-theme-btn');
    await new Promise((r) => setTimeout(r, 0));
    const firstSave = h.lastPosted('saveThemePlan');
    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'original_draft', plan: { ...firstSave.plan, theme_id: 'original_draft' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.lastPosted('saveThemePlan').theme_id, undefined);

    // A THEME_INITIALIZED for a DIFFERENT theme_id must clear the draft.
    h.dispatch({
      type: 'THEME_INITIALIZED',
      payload: {
        manifest: { theme_id: 'some_other_theme', display_name: 'Some Other Theme' },
        frames: { environment_background: ['data:image/png;base64,AA=='] },
        hasBoards: true,
        boardCount: 1,
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const nameInput2 = doc.getElementById('theme-plan-name');
    nameInput2.value = 'Fresh Manual Name';
    nameInput2.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));

    const secondSave = h.lastPosted('saveThemePlan');
    assert.ok(secondSave, 'expected a saveThemePlan after clearing the draft');
    assert.ok(secondSave.theme_id === undefined || secondSave.theme_id === null, 'draft theme_id must have been cleared by the unrelated THEME_INITIALIZED');
  } finally {
    h.win.close();
  }
});

// ── Per-board generate, signed out (020-theme-plan-editor.js ~2195-2209) ───
// Item fixture shape (id/filename/label/kind/status/prompt/revision/
// frame_keys/updated_at, no image_src) reused from
// test/webviewSmoke.test.ts's THEME_IMAGE_REVIEW pending-item tests.

test('a per-board generate click while signed out opens the sign-in shell and posts nothing; signing in fires the retry exactly once', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    const nameInput = doc.getElementById('theme-plan-name');
    nameInput.value = 'Board Retry Theme';
    nameInput.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.click('theme-build-manually-btn');
    await new Promise((r) => setTimeout(r, 0));
    const saved = h.lastPosted('saveThemePlan');

    h.dispatch({
      type: 'THEME_PLAN_SAVED',
      payload: { theme_id: 'board_retry_theme', plan: { ...saved.plan, theme_id: 'board_retry_theme' }, hasBoards: false, boardCount: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));

    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'board_retry_theme',
        display_name: 'Board Retry Theme',
        hasBoards: false,
        items: [
          {
            id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
            status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const retryBtn = doc.querySelector('.theme-review-retry');
    assert.ok(retryBtn, 'expected a per-board generate/retry button to render');

    const preCount = h.posted.filter((m: any) => m.type === 'RETRY_THEME_IMAGE').length;
    retryBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const shellModal = doc.getElementById('theme-builder-shell-modal');
    assert.ok(shellModal && !shellModal.hasAttribute('hidden'), 'signed-out click must unhide the sign-in shell modal');
    assert.equal(
      h.posted.filter((m: any) => m.type === 'RETRY_THEME_IMAGE').length,
      preCount,
      'no RETRY_THEME_IMAGE should be posted while signed out',
    );

    h.dispatch({ type: 'THEME_SERVICE_STATUS', payload: { signedIn: true } });
    await new Promise((r) => setTimeout(r, 0));

    const retryMessages = h.posted.filter((m: any) => m.type === 'RETRY_THEME_IMAGE');
    assert.equal(retryMessages.length, preCount + 1, 'signing in must fire the deferred retry exactly once');
    assert.equal(retryMessages[retryMessages.length - 1].payload.theme_id, 'board_retry_theme');
    assert.equal(retryMessages[retryMessages.length - 1].payload.item_id, 'environment');
  } finally {
    h.win.close();
  }
});

// ── "Edit plan details" disclosure ──────────────────────────────────────────

test('the "Edit plan details" disclosure is collapsed by default in a fresh draft, and expands after THEME_PLAN_READY', async () => {
  const h = await openThemeBuilderOnEmptyDraft();
  try {
    const { doc } = h;

    // p79-t1: the "Edit plan details" disclosure is retired — the plan
    // review is always fully expanded on the ai screen (never collapsed
    // behind a toggle), and the manual screen never shows plan fields at
    // all. buildThemePlanDetailsDisclosure/setThemePlanDetailsDisclosureOpen
    // are now no-ops, so the toggle element must never be created.
    assert.equal(doc.getElementById('theme-plan-details-toggle'), null, '#theme-plan-details-toggle must no longer be created');

    h.dispatch({
      type: 'THEME_PLAN_READY',
      payload: { plan: { display_name: 'AI Plan', characters: new Array(16).fill('AI Char') } },
    });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(doc.getElementById('theme-plan-details-toggle'), null, '#theme-plan-details-toggle must still not exist after an AI plan lands');
    // The ai screen shows the plan review fully expanded with no disclosure.
    assertVisible(doc.getElementById('theme-plan-editor'), '#theme-plan-editor');
  } finally {
    h.win.close();
  }
});
