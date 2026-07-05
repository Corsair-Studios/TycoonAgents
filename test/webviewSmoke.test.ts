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

    // ── Step 7: agent-activity state update ─────────────────────────────────────
    await t.test('7. state update drives HUD/character path', async () => {
      dispatch(buildStatePayload());
      tick(5);
      await flush();
      const tbody = doc.getElementById('metrics-tbody');
      assert.ok(tbody && tbody.children.length > 0, 'metrics table should render agent rows');
      assertNoErrors('state-update');
    });
  } finally {
    process.removeListener('unhandledRejection', onRejection);
    dom.window.close();
  }
});
