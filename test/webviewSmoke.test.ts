import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * RUNTIME smoke test for the webview script media/main.js.
 *
 * media/main.js is a ~7900-line untyped browser IIFE with a canvas render loop.
 * The static `check:webview` guardrail (scripts/check-webview.mjs) only catches
 * undefined-identifier / TDZ crashes via tsc. It CANNOT catch per-frame helper
 * blowups, bad property/method calls, null derefs, or message->state->render
 * integration bugs that only surface when the script actually executes.
 *
 * This test boots main.js inside a jsdom fake DOM (via node:vm so its bare
 * `acquireVsCodeApi`/`window`/`document`/`requestAnimationFrame`/`Image`
 * globals resolve against the fake environment), drives the representative
 * paths a real webview hits (theme load, ~30 render frames, badge dialog,
 * rebirth prestige, edit-stage hit-test, agent-activity update), and asserts
 * NOTHING throws.
 *
 * DEV-ONLY: jsdom is a devDependency and this file is excluded from the VSIX
 * (.vscodeignore drops test/** and out/**\/*.test.js).
 *
 * Path resolution mirrors test/webviewAtlasClips.test.ts: `npm test` runs from
 * the repo root, so media/main.js is read relative to process.cwd().
 */

// jsdom ships no bundled .d.ts and we deliberately avoid adding @types/jsdom.
// require() is typed to return `any` (@types/node), so this stays TS-clean
// under strict mode without a declaration file.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

const MAIN_JS_PATH = join(process.cwd(), 'media', 'main.js');

// ── Element-skeleton auto-generation ────────────────────────────────────────
// Scan main.js for every getElementById("X") literal and create a stub element
// for each, choosing a tag by an id-name hint. This keeps the skeleton
// low-maintenance: new ids main.js reads are picked up automatically.
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
  if (
    lower.includes('list') ||
    lower.includes('panel') ||
    lower.includes('dialog') ||
    lower.includes('area')
  ) {
    return 'div';
  }
  return 'div';
}

// Ids that main.js creates itself at runtime — leaving them OUT of the
// skeleton lets the real code paths (that check-then-create) run faithfully,
// and avoids duplicate-id ambiguity when we click/query them.
const RUNTIME_CREATED_IDS = new Set([
  'rebirth-announce',
  'rebirth-panel',
  'menu-edit-stage',
  'settings-modal-close',
  'stage-edit-panel',
]);

// ── Fake 2D canvas context ──────────────────────────────────────────────────
// A robust no-op context: every method is a no-op, settable props are accepted,
// and the handful of methods whose RETURN value main.js reads give sane stubs.
// Optional `drawLog`: when provided, every ctx.drawImage(...) call's raw args
// are pushed onto it — lets a test assert on drawn sizes (dWidth/dHeight)
// without exposing any of main.js's internal closures. Unused by the main
// boot test below (only the object-scale composition test opts in).
function makeCtxStub(canvasEl: unknown, drawLog?: unknown[][]): unknown {
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
  if (drawLog) {
    target.drawImage = (...args: unknown[]) => {
      drawLog.push(args);
    };
  }
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      // Any unstubbed method → no-op function.
      return () => {};
    },
    set(t, prop: string, value) {
      t[prop] = value; // accept fillStyle/strokeStyle/font/globalAlpha/etc.
      return true;
    },
  });
}

// ── Fake Image ──────────────────────────────────────────────────────────────
// Setting .src marks the image complete immediately (so themeLoadProgress
// counts it as loaded) and fires onload on the next microtask so main.js's
// preload/defringe path resolves.
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
      this.naturalWidth = 64;
      this.naturalHeight = 64;
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

// ── Theme fixture ───────────────────────────────────────────────────────────
// A minimal-but-sufficient THEME_INITIALIZED payload: a manifest with rosters,
// buildables, decor, badges + a frames map keyed the way main.js expects
// ("agent_<slot_id>", "rival_<rival_id>", "object_<object_id>",
// "decor_<decor_id>", "achievement_<n>", "environment_background", ...).
const PX = 'data:image/png;base64,iVBORw0KGgo=';
function frameArray(n: number): string[] {
  return Array.from({ length: n }, () => PX);
}

const BADGE_IDS = ['badge_a', 'badge_b', 'badge_c'];

function buildThemePayload() {
  const manifest = {
    theme_id: 'smoke_theme',
    viewport: {
      native_width: 1280,
      native_height: 720,
      // NORMALIZED 0..1 polygon (main.js converts to canonical native space).
      walkable_nav_polygon: [
        [0.1, 0.6],
        [0.9, 0.6],
        [0.9, 0.95],
        [0.1, 0.95],
      ],
      character_scale: 1,
      object_scale: 1,
      overall_scale: 1,
      rival_scale: 1,
      decor_scale: 1,
      enemy_config: { spawn_interval_seconds: 45, count_mode: 'random' },
      crate_asset: 'frames.json#crate',
      poof_asset: 'frames.json#poof',
      projectile_asset: 'frames.json#projectile',
    },
    roster_agents: [
      { slot_id: 'a1', name: 'Alpha' },
      { slot_id: 'a2', name: 'Bravo' },
    ],
    roster_rivals: [{ rival_id: 'r1', name: 'Rival One' }],
    buildable_objects: [
      { object_id: 'o1', display_name: 'Rack', build_order: 0, anchor_coord: [0.5, 0.5] },
      { object_id: 'o2', display_name: 'Crate', build_order: 1, anchor_coord: [0.5, 0.5] },
    ],
    decor_objects: [
      {
        decor_id: 'd1',
        display_name: 'Bench',
        anchor_coord: [0.5, 0.5],
        is_sittable: true,
        sit_anchor: [0, 0],
        anim_fps: 6,
        anim_loop: true,
      },
    ],
    badges: [
      { badge_id: 'badge_a', display_name: 'Builder', trigger_type: 'OBJECTS_BUILT', threshold: 1, icon_asset: 'frames.json#achievement_1' },
      { badge_id: 'badge_b', display_name: 'Bouncer', trigger_type: 'RIVALS_EVICTED', threshold: 1, icon_asset: 'frames.json#achievement_2' },
      { badge_id: 'badge_c', display_name: 'Closer', trigger_type: 'TASKS_COMPLETED', threshold: 1, icon_asset: 'frames.json#achievement_3' },
    ],
  };

  const frames: Record<string, string[]> = {
    environment_background: [PX],
    agent_a1: frameArray(20),
    agent_a2: frameArray(20),
    rival_r1: frameArray(20),
    object_o1: frameArray(4),
    object_o2: frameArray(4),
    decor_d1: frameArray(4),
    achievement_1: [PX],
    achievement_2: [PX],
    achievement_3: [PX],
    crate: frameArray(2),
    poof: frameArray(2),
    projectile: [PX],
  };

  return {
    type: 'THEME_INITIALIZED',
    payload: {
      theme_id: 'smoke_theme',
      manifest,
      frames,
      badges: manifest.badges,
      unlocked_badge_ids: [...BADGE_IDS],
    },
  };
}

// A representative state / agent-activity update.
function buildStatePayload() {
  const agentMetrics = [
    { id: 'a1', name: 'Alpha', status: 'active', model: 'sonnet', tokens: 1200, activeMs: 60000, lastActivityAt: Date.now() },
    { id: 'a2', name: 'Bravo', status: 'idle', model: 'haiku', tokens: 300, activeMs: 20000, lastActivityAt: Date.now() - 1000 },
    { id: 'a3', name: 'Charlie', status: 'active', model: 'opus', tokens: 5000, activeMs: 120000, lastActivityAt: Date.now() },
  ];
  return {
    type: 'state',
    state: {
      sessionActive: true,
      completedTasks: 3,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {
        a1: { id: 'a1', role: 'builder', state: 'build' },
        a2: { id: 'a2', role: 'hauler', state: 'walk' },
      },
      agentMetrics,
    },
  };
}

// A state payload exercising Team Lead Mode hierarchy telemetry (Phase 3):
// one lead (tier: "lead") with two workers attributed via parentId.
function buildTeamStatePayload() {
  const agentMetrics = [
    { id: 'orchestrator', name: 'Orchestrator', status: 'idle', tokens: 500, activeMs: 30000 },
    {
      id: 'build-lead', name: 'Build Lead', status: 'active', model: 'opus', tier: 'lead',
      tokens: 800, activeMs: 40000, taskCount: 1, mcpCount: 0, lastActivityAt: Date.now(),
    },
    {
      id: 'coding-specialist', name: 'Coding Specialist', status: 'active', model: 'sonnet',
      parentId: 'build-lead', tokens: 4000, activeMs: 90000, taskCount: 2, mcpCount: 1,
      lastActivityAt: Date.now(),
    },
    {
      id: 'ux-ui-designer', name: 'UX UI Designer', status: 'idle', model: 'sonnet',
      parentId: 'build-lead', tokens: 1500, activeMs: 50000, taskCount: 1, mcpCount: 0,
      lastActivityAt: Date.now() - 5000,
    },
  ];
  return {
    type: 'state',
    state: {
      sessionActive: true,
      completedTasks: 4,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {},
      agentMetrics,
    },
  };
}

test('media/main.js boots + drives without throwing in a jsdom runtime', async (t) => {
  const src = readFileSync(MAIN_JS_PATH, 'utf8');

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://webview.local/',
  });
  const win: any = dom.window;
  const doc = win.document;

  // Build the element skeleton from scanned getElementById ids.
  const ids = scanElementIds(src);
  for (const id of ids) {
    if (RUNTIME_CREATED_IDS.has(id)) continue;
    if (doc.getElementById(id)) continue;
    const el = doc.createElement(tagForId(id));
    el.id = id;
    doc.body.appendChild(el);
  }
  // Guarantee the render-loop target #stage is a real <canvas> with real dims.
  let stage = doc.getElementById('stage');
  if (!stage || stage.tagName.toLowerCase() !== 'canvas') {
    if (stage) stage.remove();
    stage = doc.createElement('canvas');
    stage.id = 'stage';
    doc.body.appendChild(stage);
  }
  stage.width = 1066;
  stage.height = 760;

  // ── Install stubbed globals on the context BEFORE running main.js ──────────
  const posted: any[] = [];
  let stateStore: any = {
    // Seed rebirth so the 3 required badges are already satisfied for step 5.
    rebirth: {
      count: 0,
      baseline: { built: 0, evicted: 0, tasks: 0 },
      required: [...BADGE_IDS],
      unlocked: [...BADGE_IDS],
    },
  };
  win.acquireVsCodeApi = () => ({
    postMessage: (mmm: any) => {
      posted.push(mmm);
    },
    getState: () => stateStore,
    setState: (s: any) => {
      stateStore = s;
    },
  });

  // rAF queue driven by tick().
  const rafQueue: Array<(ts: number) => void> = [];
  win.requestAnimationFrame = (cb: (ts: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  win.cancelAnimationFrame = () => {};

  win.Image = makeFakeImage(win);

  // Robust no-op 2D context for every canvas.
  win.HTMLCanvasElement.prototype.getContext = function (this: any) {
    if (!this.__ctxStub) this.__ctxStub = makeCtxStub(this);
    return this.__ctxStub;
  };
  win.HTMLCanvasElement.prototype.toDataURL = function () {
    return PX;
  };

  // ── Error trap ────────────────────────────────────────────────────────────
  const errors: any[] = [];
  win.addEventListener('error', (e: any) => {
    errors.push(e && (e.error || e.message) ? e.error || e.message : e);
  });
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => {
    errors.push(err || msg);
  };
  const onRejection = (r: any) => errors.push(r);
  process.on('unhandledRejection', onRejection);

  function fmt(list: any[]): string {
    return list
      .map((e) => (e && e.stack ? e.stack : String(e)))
      .join('\n---\n');
  }
  function assertNoErrors(step: string) {
    assert.equal(errors.length, 0, `[${step}] main.js threw:\n${fmt(errors)}`);
  }

  let rafTs = 0;
  function tick(n: number) {
    for (let i = 0; i < n; i++) {
      const cbs = rafQueue.splice(0);
      rafTs += 16;
      for (const cb of cbs) {
        try {
          cb(rafTs);
        } catch (e) {
          errors.push(e);
        }
      }
    }
  }

  // Flush microtasks (image onload chains) + jsdom timers.
  async function flush() {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  try {
    // ── Step 1: Boot ─────────────────────────────────────────────────────────
    await t.test('1. boots without throwing', async () => {
      vm.runInContext(src, dom.getInternalVMContext(), { filename: 'media/main.js' });
      await flush();
      assertNoErrors('boot');
      assert.ok(rafQueue.length > 0, 'main.js should schedule an initial render frame');
    });

    // ── Step 2: THEME_INITIALIZED ──────────────────────────────────────────────
    await t.test('2. THEME_INITIALIZED loads a theme', async () => {
      dispatch(buildThemePayload());
      await flush();
      assertNoErrors('theme-initialized');
    });

    // ── Step 3: Render loop ─────────────────────────────────────────────────────
    await t.test('3. render ~30 frames with theme loaded', async () => {
      tick(30);
      await flush();
      assertNoErrors('render-30-frames');
    });

    // ── Step 4: Badge dialog ────────────────────────────────────────────────────
    await t.test('4. badge dialog opens + renders badges', () => {
      const btn = doc.getElementById('badge-hud-btn');
      assert.ok(btn, 'badge-hud-btn should exist');
      btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const list = doc.getElementById('badge-list');
      assert.ok(list && list.children.length > 0, 'badge-list should render badge cards');
      assertNoErrors('badge-dialog');
    });

    // ── Step 5: Rebirth prestige ────────────────────────────────────────────────
    await t.test('5. rebirth: confirm flow fires celebration', () => {
      const prevCount = (stateStore.rebirth && stateStore.rebirth.count) || 0;
      const panel = doc.getElementById('rebirth-panel');
      assert.ok(panel, 'rebirth-panel should have been created by renderBadgePanel');
      // Rebirth button is the enabled (not disabled) .rebirth-btn — required
      // badges were seeded unlocked via getState().rebirth + unlocked_badge_ids.
      const rebirthBtn = panel.querySelector('.rebirth-btn:not([disabled])');
      assert.ok(rebirthBtn, 'an enabled Rebirth button should be present (required badges unlocked)');
      rebirthBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      // Two-step confirm: a Confirm button now exists.
      const confirmBtn = [...panel.querySelectorAll('.rebirth-btn')].find(
        (b: any) => (b.textContent || '').trim() === 'Confirm'
      );
      assert.ok(confirmBtn, 'Confirm button should appear after clicking Rebirth');
      confirmBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      // doRebirth() -> celebrateRebirth(): confetti + #rebirth-announce append.
      tick(10);
      const newCount = (stateStore.rebirth && stateStore.rebirth.count) || 0;
      assert.equal(newCount, prevCount + 1, 'rebirth count should increment');
      assert.ok(doc.getElementById('rebirth-announce'), '#rebirth-announce should be appended');
      assertNoErrors('rebirth');
    });

    // ── Step 6: Edit-stage hit-test ─────────────────────────────────────────────
    await t.test('6. edit-stage mode + canvas mousedown hit-test', () => {
      const editBtn = doc.getElementById('menu-edit-stage');
      assert.ok(editBtn, 'menu-edit-stage should have been injected');
      editBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const canvasEl = doc.getElementById('stage');
      canvasEl.dispatchEvent(
        new win.MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 400 })
      );
      canvasEl.dispatchEvent(
        new win.MouseEvent('mouseup', { bubbles: true, clientX: 500, clientY: 400 })
      );
      tick(3);
      assertNoErrors('edit-stage');
    });

    // ── Step 6b: F-flip hotkey ───────────────────────────────────────────────────
    // F flips whatever the per-object/per-decor override dropdown currently
    // targets (the same "current item" the scale sliders act on). Selecting
    // 'o1' via #se-obj, then pressing F, should toggle object_flip_overrides.o1
    // in the next SAVE_STAGE_TUNING payload; pressing F again should undo it.
    await t.test('6b. F flips the Edit-Stage object selection and persists it', () => {
      const objSelect = doc.getElementById('se-obj');
      assert.ok(objSelect, 'se-obj select should exist');
      objSelect.value = 'o1';
      objSelect.dispatchEvent(new win.Event('change', { bubbles: true }));

      win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }));
      const saveBtn = doc.getElementById('se-save');
      assert.ok(saveBtn, 'se-save button should exist');
      saveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

      const firstSave = [...posted].reverse().find((m: any) => m.type === 'SAVE_STAGE_TUNING');
      assert.ok(firstSave, 'a SAVE_STAGE_TUNING message should have been posted');
      assert.equal(
        firstSave.payload.object_flip_overrides && firstSave.payload.object_flip_overrides.o1,
        true,
        'F should flip the selected object (o1)'
      );

      // Press F again on the same selection -> toggles the flip back off.
      win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }));
      saveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const secondSave = [...posted].reverse().find((m: any) => m.type === 'SAVE_STAGE_TUNING');
      assert.ok(secondSave, 'a second SAVE_STAGE_TUNING message should have been posted');
      assert.equal(
        !!(secondSave.payload.object_flip_overrides && secondSave.payload.object_flip_overrides.o1),
        false,
        'pressing F again should un-flip o1'
      );
      assertNoErrors('flip-hotkey');
    });

    // ── Step 6c: H-hide hotkey ───────────────────────────────────────────────────
    // H toggles the non-destructive hide state of whatever the per-decor
    // override dropdown currently targets (mirrors the F-flip test above).
    // Selecting 'd1' via #se-decor, then pressing H, should add 'd1' to
    // decor_hidden in the next SAVE_STAGE_TUNING payload; pressing H again
    // should remove it.
    await t.test('6c. H hides the Edit-Stage decor selection and persists it', () => {
      const decorSelect = doc.getElementById('se-decor');
      assert.ok(decorSelect, 'se-decor select should exist');
      decorSelect.value = 'd1';
      decorSelect.dispatchEvent(new win.Event('change', { bubbles: true }));

      win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
      const saveBtn = doc.getElementById('se-save');
      assert.ok(saveBtn, 'se-save button should exist');
      saveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

      const firstSave = [...posted].reverse().find((m: any) => m.type === 'SAVE_STAGE_TUNING');
      assert.ok(firstSave, 'a SAVE_STAGE_TUNING message should have been posted');
      assert.ok(
        Array.isArray(firstSave.payload.decor_hidden) && firstSave.payload.decor_hidden.includes('d1'),
        'H should hide the selected decor (d1)'
      );
      assert.equal(
        doc.getElementById('se-decor-hide').textContent,
        'Unhide',
        'the Hide button should now read Unhide'
      );

      // Press H again on the same selection -> un-hides it.
      win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
      saveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const secondSave = [...posted].reverse().find((m: any) => m.type === 'SAVE_STAGE_TUNING');
      assert.ok(secondSave, 'a second SAVE_STAGE_TUNING message should have been posted');
      assert.ok(
        !Array.isArray(secondSave.payload.decor_hidden) || !secondSave.payload.decor_hidden.includes('d1'),
        'pressing H again should un-hide d1'
      );
      assert.equal(
        doc.getElementById('se-decor-hide').textContent,
        'Hide',
        'the Hide button should read Hide again'
      );
      assertNoErrors('hide-hotkey');
    });

    // ── Step 7: agent-activity state update ─────────────────────────────────────
    await t.test('7. state update drives HUD/character path', async () => {
      dispatch(buildStatePayload());
      tick(5);
      await flush();
      const tbody = doc.getElementById('metrics-tbody');
      assert.ok(tbody && tbody.children.length > 0, 'metrics table should render agent rows');
      assertNoErrors('state-update');
    });

    // ── Step 8: Team Lead Mode hierarchy telemetry (Phase 3) ────────────────────
    await t.test('8. team rollup: lead row expands to nested workers, collapses to an aggregate', async () => {
      dispatch(buildTeamStatePayload());
      tick(5);
      await flush();
      assertNoErrors('team-rollup-dispatch');

      const tbody = doc.getElementById('metrics-tbody');
      assert.ok(tbody, 'metrics-tbody should exist');

      // Expanded by default: a chevron on the lead row, an indented worker row.
      const chevron = tbody.querySelector('.team-chevron');
      assert.ok(chevron, 'lead row should render a chevron when it has visible children');
      assert.equal(chevron.getAttribute('aria-expanded'), 'true', 'default state is expanded');
      const childRows = tbody.querySelectorAll('tr.metrics-row--child');
      assert.equal(childRows.length, 2, 'both workers should render nested under the lead');
      assert.equal(tbody.querySelector('.team-tag'), null, 'no aggregate tag while expanded');

      // Collapse: click the chevron.
      chevron.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assertNoErrors('team-rollup-collapse-click');

      const collapsedChevron = tbody.querySelector('.team-chevron');
      assert.ok(collapsedChevron, 'chevron should still be present after collapsing');
      assert.equal(collapsedChevron.getAttribute('aria-expanded'), 'false');
      assert.equal(tbody.querySelectorAll('tr.metrics-row--child').length, 0, 'workers hidden while collapsed');
      const tag = tbody.querySelector('.team-tag');
      assert.ok(tag, 'collapsed lead row should carry a team-aggregate tag');

      // Aggregate tokens column = lead(800) + coding-specialist(4000) + ux-ui-designer(1500) = 6300.
      const leadRow = collapsedChevron.closest('tr');
      const tokensCell = leadRow && leadRow.querySelector('td.col-tokens');
      assert.ok(tokensCell, 'lead row should have a tokens cell');
      assert.equal(tokensCell.textContent, '6.3k', 'collapsed row should show summed team tokens');

      // Re-expand: state persists across a fresh render (webview-state-backed).
      collapsedChevron.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assertNoErrors('team-rollup-reexpand-click');
      assert.equal(tbody.querySelectorAll('tr.metrics-row--child').length, 2, 'workers reappear after re-expanding');
    });

    // ── Step 9: flat projects (no leads) render exactly as before ───────────────
    await t.test('9. no leads present -> zero visual change (no chevrons/tags anywhere)', async () => {
      dispatch(buildStatePayload());
      tick(5);
      await flush();
      const tbody = doc.getElementById('metrics-tbody');
      assert.ok(tbody, 'metrics-tbody should exist');
      assert.equal(tbody.querySelectorAll('.team-chevron').length, 0, 'no chevrons without any tier:lead entries');
      assert.equal(tbody.querySelectorAll('.team-tag').length, 0, 'no team tags without any tier:lead entries');
      assertNoErrors('flat-state-unchanged');
    });

    // ── Step 10: pre-install delegation chooser visibility (Phase 2 bugfix) ──────
    // The install-screen #delegation-mode-group must be hidden on every
    // installState path EXCEPT installed === false (fresh install), and the
    // Settings render must contribute exactly ONE "Delegation style" section —
    // never a duplicate of the install-screen block.
    await t.test('10. delegation chooser: shown only when not installed; settings has one section', async () => {
      const group = doc.getElementById('delegation-mode-group');
      assert.ok(group, 'delegation-mode-group should exist');

      // Installed project (the reload case): chooser hidden.
      dispatch({ type: 'installState', installed: true });
      assert.ok(group.hasAttribute('hidden'), 'installed === true must hide the pre-install chooser');

      // Fresh install: chooser shown.
      dispatch({ type: 'installState', installed: false });
      assert.ok(!group.hasAttribute('hidden'), 'installed === false must show the pre-install chooser');

      // Install kicked off (busy): chooser hidden again.
      dispatch({ type: 'installState', busy: true });
      assert.ok(group.hasAttribute('hidden'), 'busy must hide the pre-install chooser');

      // Back to installed, then render Settings: exactly one "Delegation
      // style" section, inside #setup-config — and the static chooser stays hidden.
      dispatch({ type: 'installState', installed: true });
      dispatch({
        type: 'settings',
        payload: {
          hook: { installed: true, lastActivityAt: null },
          agents: [],
          delegation_mode: 'team_leads',
          delegationHealth: {},
          hookHealth: { healthy: true, issueCount: 0 },
          contextBudget: null,
        },
      });
      await flush();
      assert.ok(group.hasAttribute('hidden'), 'settings view must not resurface the pre-install chooser');
      const setupConfig = doc.getElementById('setup-config');
      const headings = [...setupConfig.querySelectorAll('.settings-heading')].filter(
        (h: any) => (h.textContent || '').trim() === 'Delegation style'
      );
      assert.equal(headings.length, 1, 'settings must render exactly one Delegation style section');
      const checked = setupConfig.querySelector('input[name="settings-delegation-mode"]:checked');
      assert.ok(checked, 'a delegation-mode radio should be checked');
      assert.equal(checked.value, 'team_leads', 'radio selection must reflect the payload mode');
      assertNoErrors('delegation-chooser-visibility');
    });
  } finally {
    process.removeListener('unhandledRejection', onRejection);
    dom.window.close();
  }
});

// ── Object-scale composition regression (crate constant-size + global slider
// multiplying per-object overrides instead of being replaced by them) ───────
//
// effectiveObjScale/crateSize live inside main.js's closure with no exported
// hook, so these two bugs are asserted the same way the rest of this file
// asserts behavior: boot main.js for real, drive it through actual message
// dispatch / DOM events, and read back what it actually drew via ctx.drawImage
// call args (dWidth) — recorded through makeCtxStub's optional drawLog.
//
// Distinct Image `src` values per sprite key let a test tell a crate draw
// apart from a buildable-object-art draw in the recorded call log.
const OBJ_SCALE_PX = {
  bg: 'data:obj-scale-fixture,bg',
  crate: 'data:obj-scale-fixture,crate',
  o1: 'data:obj-scale-fixture,o1',
  o2: 'data:obj-scale-fixture,o2',
};

function buildObjScaleThemePayload(objectScale: number, overrides: Record<string, number>, objectIds: string[]) {
  const buildable_objects = objectIds.map((id, i) => ({
    object_id: id,
    display_name: id,
    build_order: i,
    anchor_coord: [0.5, 0.5],
  }));
  const frames: Record<string, string[]> = {
    environment_background: [OBJ_SCALE_PX.bg],
    crate: [OBJ_SCALE_PX.crate, OBJ_SCALE_PX.crate],
    poof: [OBJ_SCALE_PX.crate, OBJ_SCALE_PX.crate],
  };
  for (const id of objectIds) frames[`object_${id}`] = [(OBJ_SCALE_PX as any)[id]];
  return {
    type: 'THEME_INITIALIZED',
    payload: {
      theme_id: 'obj_scale_fixture',
      manifest: {
        theme_id: 'obj_scale_fixture',
        viewport: {
          native_width: 1280,
          native_height: 720,
          walkable_nav_polygon: [[0.1, 0.6], [0.9, 0.6], [0.9, 0.95], [0.1, 0.95]],
          object_scale: objectScale,
          object_scale_overrides: overrides,
          crate_asset: 'frames.json#crate',
          poof_asset: 'frames.json#poof',
        },
        roster_agents: [],
        roster_rivals: [],
        buildable_objects,
        decor_objects: [],
        badges: [],
      },
      frames,
      badges: [],
      unlocked_badge_ids: [],
    },
  };
}

// Minimal boot harness (no agent-roster / rebirth wiring needed here) that
// records every ctx.drawImage call's dWidth so a test can inspect drawn
// sprite sizes without reaching into main.js's private closures.
async function bootObjScaleHarness() {
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

  win.acquireVsCodeApi = () => ({
    postMessage: () => {},
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

  const drawLog: unknown[][] = [];
  win.HTMLCanvasElement.prototype.getContext = function (this: any) {
    if (!this.__ctxStub) this.__ctxStub = makeCtxStub(this, drawLog);
    return this.__ctxStub;
  };
  win.HTMLCanvasElement.prototype.toDataURL = function () {
    return OBJ_SCALE_PX.bg;
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
  let rafTs = 0;
  function tick(n: number) {
    for (let i = 0; i < n; i++) {
      const cbs = rafQueue.splice(0);
      rafTs += 16;
      for (const cb of cbs) {
        try {
          cb(rafTs);
        } catch (e) {
          errors.push(e);
        }
      }
    }
  }
  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  await flush();
  return { win, doc, dispatch, tick, flush, drawLog, errors };
}

// Last drawImage call whose image src matches `src`, or undefined. main.js
// calls ctx.drawImage(img, dx, dy, dWidth, dHeight) everywhere relevant here.
function lastDrawWidth(drawLog: unknown[][], src: string): number | undefined {
  for (let i = drawLog.length - 1; i >= 0; i--) {
    const args = drawLog[i] as any[];
    if (args[0] && args[0].src === src) return args[3] as number;
  }
  return undefined;
}

// Count of drawImage calls in a drawLog SLICE (see slice()) whose image src
// matches `src`. Used to tell a per-frame render draw (recurs every tick)
// apart from the one-time image-preload/defringe pass (main.js samples each
// decoded sprite once via an offscreen canvas), which also calls drawImage
// and would otherwise be indistinguishable from a "real" render by src alone.
function countDraws(drawLog: unknown[][], src: string): number {
  let n = 0;
  for (const args of drawLog as any[][]) {
    if (args[0] && args[0].src === src) n++;
  }
  return n;
}

test('crate size ignores the target object\'s per-object scale override', async () => {
  // Single buildable object -> it is unambiguously buildQueue[0] (active),
  // so every frame draws the crate, never the final object art. Same
  // anchor_coord + canvas size across runs => identical depthScale, so crate
  // width is directly comparable between runs.
  const runs: Record<string, number> = {};
  for (const [label, objectScale, overrides] of [
    ['globalOnly', 2, {}],
    ['withBigOverride', 2, { o1: 3 }], // legacy-absolute override, same global
    ['halfGlobal', 1, {}],
  ] as [string, number, Record<string, number>][]) {
    const h = await bootObjScaleHarness();
    h.dispatch(buildObjScaleThemePayload(objectScale, overrides, ['o1']));
    await h.flush();
    h.tick(3);
    assert.equal(h.errors.length, 0, `[${label}] threw: ${h.errors.map(String).join('; ')}`);
    const w = lastDrawWidth(h.drawLog, OBJ_SCALE_PX.crate);
    assert.ok(typeof w === 'number' && w > 0, `[${label}] crate should have been drawn`);
    runs[label] = w as number;
    h.win.close();
  }
  assert.equal(
    runs.globalOnly,
    runs.withBigOverride,
    `crate width must ignore the per-object override (global-only=${runs.globalOnly}, with 3x override=${runs.withBigOverride})`
  );
  assert.ok(
    Math.abs(runs.globalOnly - 2 * runs.halfGlobal) <= 1,
    `crate width must still track the GLOBAL object-scale slider (global=2 -> ${runs.globalOnly}, global=1 -> ${runs.halfGlobal})`
  );
});

test('global "Object scale" slider visibly scales an object that already has a per-object override', async () => {
  // Two objects: whichever the seeded build queue picks first renders as the
  // crate (active) every frame; the other is "unbuilt" and, once edit-stage
  // mode is entered, falls through to idle-art rendering at
  // effectiveObjScale every frame. This test doesn't hardcode which is which
  // — it identifies the per-frame-drawn "idle" object from a drawLog SLICE
  // covering only the edit-stage-mode ticks: the image-preload/defringe pass
  // draws each object's art exactly ONCE (during initial load, before this
  // slice), so within the slice the truly-idle object is the one with
  // draws > 0 and the active (crate-only) object has draws === 0 for its
  // own object_ art.
  const h = await bootObjScaleHarness();
  h.dispatch(buildObjScaleThemePayload(1, { o1: 2, o2: 0.5 }, ['o1', 'o2']));
  await h.flush();
  h.tick(2);
  assert.equal(h.errors.length, 0, `boot threw: ${h.errors.map(String).join('; ')}`);

  const editBtn = h.doc.getElementById('menu-edit-stage');
  assert.ok(editBtn, 'menu-edit-stage should have been injected');
  editBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const markerA = h.drawLog.length;
  h.tick(2);
  const sliceAB = h.drawLog.slice(markerA);

  const o1Draws = countDraws(sliceAB, OBJ_SCALE_PX.o1);
  const o2Draws = countDraws(sliceAB, OBJ_SCALE_PX.o2);
  assert.ok(
    (o1Draws > 0) !== (o2Draws > 0),
    `exactly one object should render idle art per-frame in edit-stage mode (o1Draws=${o1Draws}, o2Draws=${o2Draws})`
  );
  const idleSrc = o1Draws > 0 ? OBJ_SCALE_PX.o1 : OBJ_SCALE_PX.o2;

  const crateW1 = lastDrawWidth(sliceAB, OBJ_SCALE_PX.crate);
  const idleW1 = lastDrawWidth(sliceAB, idleSrc);
  assert.ok(typeof crateW1 === 'number' && crateW1 > 0, 'crate should be drawn at global=1');
  assert.ok(typeof idleW1 === 'number' && idleW1 > 0, 'the non-active object should render idle art in edit-stage mode');

  // Simulate the real user drag: move the global "Object scale" slider.
  const os = h.doc.getElementById('se-os');
  assert.ok(os, 'se-os (global object-scale slider) should exist');
  os.value = '2';
  os.dispatchEvent(new h.win.Event('input', { bubbles: true }));
  const markerB = h.drawLog.length;
  h.tick(2);
  const sliceBC = h.drawLog.slice(markerB);

  const crateW2 = lastDrawWidth(sliceBC, OBJ_SCALE_PX.crate);
  const idleW2 = lastDrawWidth(sliceBC, idleSrc);
  assert.ok(typeof crateW2 === 'number', 'crate should still be drawn after the global slider moves');
  assert.ok(typeof idleW2 === 'number', 'idle object should still be drawn after the global slider moves');
  const crateRatio = (crateW2 as number) / (crateW1 as number);
  const idleRatio = (idleW2 as number) / (idleW1 as number);
  assert.ok(
    Math.abs(crateRatio - 2) < 0.15,
    `crate width should ~double when the global slider doubles (ratio=${crateRatio})`
  );
  // This is the actual regression: previously an object WITH an override
  // ignored the global slider entirely (ratio would stay ~1.0).
  assert.ok(
    Math.abs(idleRatio - 2) < 0.15,
    `overridden object's width should ~double when the global slider doubles, proving the ` +
    `global slider is no longer replaced by the per-object override (ratio=${idleRatio})`
  );
  h.win.close();
});

// ── Decor-scale composition regression (identical bug/fix to the object-scale
// one above, applied to effectiveDecorScale/themeDecorScale/
// themeDecorScaleOverrides): a per-decor override used to REPLACE the global
// "Decor scale" slider outright, so any decor item WITH an override ignored
// the global slider — reported as "the scale-decor slider only affects a
// couple of items." Unlike buildable objects, decor renders every frame
// unconditionally (no build-queue/edit-stage gating), so this test doesn't
// need the idle-vs-active distinction the object-scale test above does.
const DECOR_SCALE_PX = {
  bg: 'data:decor-scale-fixture,bg',
  d1: 'data:decor-scale-fixture,d1',
  d2: 'data:decor-scale-fixture,d2',
};

function buildDecorScaleThemePayload(decorScale: number, overrides: Record<string, number>, decorIds: string[]) {
  const decor_objects = decorIds.map((id, i) => ({
    decor_id: id,
    display_name: id,
    anchor_coord: [0.2 + i * 0.15, 0.7],
  }));
  const frames: Record<string, string[]> = {
    environment_background: [DECOR_SCALE_PX.bg],
  };
  for (const id of decorIds) frames[`decor_${id}`] = [(DECOR_SCALE_PX as any)[id]];
  return {
    type: 'THEME_INITIALIZED',
    payload: {
      theme_id: 'decor_scale_fixture',
      manifest: {
        theme_id: 'decor_scale_fixture',
        viewport: {
          native_width: 1280,
          native_height: 720,
          walkable_nav_polygon: [[0.1, 0.6], [0.9, 0.6], [0.9, 0.95], [0.1, 0.95]],
          decor_scale: decorScale,
          decor_scale_overrides: overrides,
        },
        roster_agents: [],
        roster_rivals: [],
        buildable_objects: [],
        decor_objects,
        badges: [],
      },
      frames,
      badges: [],
      unlocked_badge_ids: [],
    },
  };
}

test('global "Decor scale" slider visibly scales decor items that already have a per-decor override', async () => {
  const h = await bootObjScaleHarness();
  // d1 has a 2x override, d2 has a 0.5x override — both should still track
  // the global slider under the fixed (multiplicative) composition.
  h.dispatch(buildDecorScaleThemePayload(1, { d1: 2, d2: 0.5 }, ['d1', 'd2']));
  await h.flush();
  h.tick(3);
  assert.equal(h.errors.length, 0, `boot threw: ${h.errors.map(String).join('; ')}`);

  const w1d1 = lastDrawWidth(h.drawLog, DECOR_SCALE_PX.d1);
  const w1d2 = lastDrawWidth(h.drawLog, DECOR_SCALE_PX.d2);
  assert.ok(typeof w1d1 === 'number' && w1d1 > 0, 'd1 should be drawn at global=1');
  assert.ok(typeof w1d2 === 'number' && w1d2 > 0, 'd2 should be drawn at global=1');

  // Enter Edit Stage (needed only to get the se-ds global-slider element into
  // the DOM — decor itself already renders every frame regardless of mode).
  const editBtn = h.doc.getElementById('menu-edit-stage');
  assert.ok(editBtn, 'menu-edit-stage should have been injected');
  editBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  h.tick(1);

  // Simulate the real user drag: move the global "Decor scale" slider.
  const ds = h.doc.getElementById('se-ds');
  assert.ok(ds, 'se-ds (global decor-scale slider) should exist');
  ds.value = '2';
  ds.dispatchEvent(new h.win.Event('input', { bubbles: true }));
  const marker = h.drawLog.length;
  h.tick(2);
  const slice = h.drawLog.slice(marker);
  assert.equal(h.errors.length, 0, `slider drive threw: ${h.errors.map(String).join('; ')}`);

  const w2d1 = lastDrawWidth(slice, DECOR_SCALE_PX.d1);
  const w2d2 = lastDrawWidth(slice, DECOR_SCALE_PX.d2);
  assert.ok(typeof w2d1 === 'number', 'd1 should still be drawn after the global slider moves');
  assert.ok(typeof w2d2 === 'number', 'd2 should still be drawn after the global slider moves');

  const ratio1 = (w2d1 as number) / (w1d1 as number);
  const ratio2 = (w2d2 as number) / (w1d2 as number);
  // This is the actual regression: previously decor WITH an override ignored
  // the global slider entirely (ratio would stay ~1.0).
  assert.ok(
    Math.abs(ratio1 - 2) < 0.15,
    `d1 (2x override) width should ~double when the global slider doubles (ratio=${ratio1})`
  );
  assert.ok(
    Math.abs(ratio2 - 2) < 0.15,
    `d2 (0.5x override) width should ~double when the global slider doubles (ratio=${ratio2})`
  );
  h.win.close();
});

// ── Non-destructive decor HIDE: skipped in normal play ─────────────────────
// H (or the Hide button) toggles themeDecorHidden without touching the
// decor's placement/scale (see toggleDecorHidden in main.js). Confirms the
// render-time consequence: once hidden and Edit Stage is exited (back to
// normal-play draw rules), the decor's sprite stops being drawn each frame.
test('H-hidden decor is not drawn in normal play (non-destructive hide)', async () => {
  const h = await bootObjScaleHarness();
  h.dispatch(buildDecorScaleThemePayload(1, {}, ['d1']));
  await h.flush();
  h.tick(3);
  assert.equal(h.errors.length, 0, `boot threw: ${h.errors.map(String).join('; ')}`);

  const preHideDraws = countDraws(h.drawLog, DECOR_SCALE_PX.d1);
  assert.ok(preHideDraws > 0, 'd1 should be drawn before being hidden');

  // Enter Edit Stage, select d1, press H to hide it, then Done back out to
  // normal-play mode.
  const editBtn = h.doc.getElementById('menu-edit-stage');
  assert.ok(editBtn, 'menu-edit-stage should have been injected');
  editBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  h.tick(1);

  const decorSelect = h.doc.getElementById('se-decor');
  assert.ok(decorSelect, 'se-decor select should exist');
  decorSelect.value = 'd1';
  decorSelect.dispatchEvent(new h.win.Event('change', { bubbles: true }));
  h.win.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));

  const doneBtn = h.doc.getElementById('se-done');
  assert.ok(doneBtn, 'se-done button should exist');
  doneBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

  const marker = h.drawLog.length;
  h.tick(3);
  const slice = h.drawLog.slice(marker);
  assert.equal(h.errors.length, 0, `post-hide render threw: ${h.errors.map(String).join('; ')}`);
  assert.equal(
    countDraws(slice, DECOR_SCALE_PX.d1),
    0,
    'a hidden decor must not be drawn during normal play'
  );
  h.win.close();
});
