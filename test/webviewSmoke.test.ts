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

// ── Per-badge "unseen" dot fixture ──────────────────────────────────────────
// A slimmed-down THEME_INITIALIZED payload (3 badges, one agent, one rival,
// one buildable, no decor) parameterized by theme_id + which badge ids are
// already unlocked — used to drive the baseline-then-diff dot logic in
// main.js (badgeUnseenByTheme/badgeKnownByTheme, ~874-990, ~7924-7955) across
// multiple loads of the same theme and across different themes.
//
// `opts` is additive/backward-compatible: every existing call site (Step 14,
// 15) omits it and gets the exact prior behavior (badge ids a/b/c, threshold
// 1 on all three, a default zeroed rebirth_state). Step 16 uses it to (a)
// give a second theme its OWN badge ids/names (proving no id/name reuse with
// theme "rA"), (b) push the TASKS_COMPLETED badge's threshold well above any
// leftover state.completedTasks from earlier subtests (rebirthBaseline.tasks
// is intentionally NOT reset per-theme — see main.js ~8014 — so a threshold
// of 1 there would spuriously auto-unlock from a prior subtest's counter),
// and (c) pass an explicit rebirth_state (or null) instead of the default.
function buildBadgeDotThemePayload(
  themeId: string,
  unlockedIds: string[],
  opts: {
    badgeIds?: [string, string, string];
    badgeNames?: [string, string, string];
    taskThreshold?: number;
    rebirthState?: any;
  } = {}
) {
  const ids = opts.badgeIds || ['a', 'b', 'c'];
  const names = opts.badgeNames || ['Alpha Badge', 'Bravo Badge', 'Charlie Badge'];
  const taskThreshold = typeof opts.taskThreshold === 'number' ? opts.taskThreshold : 1;
  const manifest = {
    theme_id: themeId,
    viewport: {
      native_width: 1280,
      native_height: 720,
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
    roster_agents: [{ slot_id: 'a1', name: 'Alpha' }],
    roster_rivals: [{ rival_id: 'r1', name: 'Rival One' }],
    buildable_objects: [
      { object_id: 'o1', display_name: 'Rack', build_order: 0, anchor_coord: [0.5, 0.5] },
    ],
    decor_objects: [],
    badges: [
      { badge_id: ids[0], display_name: names[0], trigger_type: 'OBJECTS_BUILT', threshold: 1, icon_asset: 'frames.json#achievement_1' },
      { badge_id: ids[1], display_name: names[1], trigger_type: 'RIVALS_EVICTED', threshold: 1, icon_asset: 'frames.json#achievement_2' },
      { badge_id: ids[2], display_name: names[2], trigger_type: 'TASKS_COMPLETED', threshold: taskThreshold, icon_asset: 'frames.json#achievement_3' },
    ],
  };
  const frames: Record<string, string[]> = {
    environment_background: [PX],
    agent_a1: frameArray(20),
    rival_r1: frameArray(20),
    object_o1: frameArray(4),
    achievement_1: [PX],
    achievement_2: [PX],
    achievement_3: [PX],
    crate: frameArray(2),
    poof: frameArray(2),
    projectile: [PX],
  };
  const rebirthState = opts.rebirthState !== undefined ? opts.rebirthState : {
    // Explicit, isolated rebirth_state — real hosts always scope rebirth
    // progress per theme_id. Without this, main.js's THEME_INITIALIZED
    // handler falls back to the single non-theme-scoped local
    // vscode.getState().rebirth blob, which by this point in the boot
    // sequence carries live gameplay counters (cycleObjectsBuilt/
    // cycleRivalsEvicted) accumulated by earlier subtests against a
    // DIFFERENT theme — leaking cross-theme and quietly auto-unlocking
    // badges here that this fixture never intends to unlock.
    count: 0,
    baseline: { built: 0, evicted: 0, tasks: 0 },
    required: [],
    unlocked: [],
    cycleBuilt: 0,
    cycleEvicted: 0,
    rackInsertIndex: null,
    rangedUnlocked: false,
  };
  return {
    type: 'THEME_INITIALIZED',
    payload: {
      theme_id: themeId,
      manifest,
      frames,
      badges: manifest.badges,
      unlocked_badge_ids: unlockedIds,
      rebirth_state: rebirthState,
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

// A state payload for the Delegation tab's "Coordination (not delegated
// work)" section vs. the Metrics tab's orchestrator row: both read the SAME
// agentMetrics entry (id: "orchestrator") out of the module-scoped
// `lastMetrics` main.js sets once in renderMetrics() (~L13148-13149) and
// never recomputes a second way for the Delegation tab (see
// renderDelegationStats ~L13365-13366, orch.taskCount). orchestratorTaskCount
// is deliberately distinct from every other number in the fixture (16 tasks,
// 500 tokens, 20 delegations) so a test asserting "same number both places"
// can't pass by coincidence. A non-orchestrator agent with tokens>0 is
// included so delegationStatsHasData is true and the Coordination section
// actually renders (renderDelegationStats bails out early otherwise).
function buildOrchestratorTaskCountStatePayload(orchestratorTaskCount: number) {
  const agentMetrics = [
    {
      id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus',
      tokens: 500, activeMs: 30000, taskCount: orchestratorTaskCount, delegations: 20,
    },
    {
      id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet',
      tokens: 4000, activeMs: 90000, taskCount: 5, mcpCount: 1, lastActivityAt: Date.now(),
    },
  ];
  return {
    type: 'state',
    state: {
      sessionActive: true,
      completedTasks: 5,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {},
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

// A state payload where a NON-orchestrator agent is first in agentMetrics
// and "orchestrator" is second — exercises the orchIdx > 0 branch of the
// scene-local reorder guard in media/main.js's render loop (~12181-12186):
//   const orchIdx = agentList.findIndex((a) => a && a.id === "orchestrator");
//   if (orchIdx > 0) { sceneAgentList = [agentList[orchIdx], ...] }
// Every other fixture in this file either omits "orchestrator" entirely or
// (buildTeamStatePayload) puts it at index 0, so orchIdx is always <= 0
// elsewhere and the rebuild branch itself is otherwise never hit by a render
// tick. Minimal: just the two ids needed to make orchIdx === 1.
function buildOrchestratorNotFirstStatePayload() {
  const agentMetrics = [
    { id: 'build-lead', name: 'Build Lead', status: 'active', model: 'opus', tier: 'lead', tokens: 800, activeMs: 40000 },
    { id: 'orchestrator', name: 'Orchestrator', status: 'idle', tokens: 500, activeMs: 30000 },
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
  let stateStore: any = {};
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

  // Rebirth count now lives SOLELY in the host-persisted SAVE_REBIRTH_STATE
  // post (media/main.js persistRebirth(), ~1480) — the local unscoped
  // vscode.getState().rebirth blob was removed. Read the count back from the
  // most recent posted SAVE_REBIRTH_STATE message instead of local state.
  function lastRebirthStateCount(): number {
    for (let i = posted.length - 1; i >= 0; i--) {
      const m = posted[i];
      if (m && m.type === 'SAVE_REBIRTH_STATE') {
        return (m.payload && m.payload.state && typeof m.payload.state.count === 'number')
          ? m.payload.state.count
          : 0;
      }
    }
    return 0;
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

    // ── Step 3b: document.hidden pauses + resumes the render loop ──────────────
    // render() (media/main.js ~12178-12201) early-returns before any
    // simulation/draw work when document.hidden is true, but still calls
    // requestAnimationFrame(render) so the rAF chain keeps re-scheduling
    // itself and resumes on its own once the tab/panel becomes visible again
    // (wasHiddenLastFrame flag + lastFrameTime baseline reset on the first
    // visible frame back). jsdom's Document.prototype.hidden is a configurable
    // accessor, so an own-property override on `doc` shadows it cleanly and is
    // restored the same way afterward.
    await t.test('3b. document.hidden pauses the render loop and resumes cleanly when visible again', () => {
      Object.defineProperty(doc, 'hidden', { configurable: true, get: () => true });
      try {
        tick(5);
        assertNoErrors('render-hidden-pause');
        assert.ok(rafQueue.length > 0, 'render() must keep re-scheduling itself while hidden (no missed rAF chain)');
      } finally {
        Object.defineProperty(doc, 'hidden', { configurable: true, get: () => false });
      }
      // Resume path: first visible frame resets the delta-time baseline, then
      // normal frames should render without throwing.
      tick(10);
      assertNoErrors('render-resume-after-hidden');
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
      const prevCount = lastRebirthStateCount();
      const panel = doc.getElementById('rebirth-panel');
      assert.ok(panel, 'rebirth-panel should have been created by renderBadgePanel');
      // Rebirth button is the enabled (not disabled) .rebirth-btn — required
      // badges (rolled by rollRebirthRequirement() from themeBadges, since
      // buildThemePayload() sends no rebirth_state) are all already unlocked
      // via unlocked_badge_ids.
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
      // doRebirth() also calls persistRebirth(), which posts the incremented
      // count host-side via SAVE_REBIRTH_STATE — read it back from `posted`.
      tick(10);
      const newCount = lastRebirthStateCount();
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

    // ── Step 8: Team Lead Mode hierarchy telemetry — FLAT rendering ─────────────
    // The lead/worker nesting (expand/collapse rollup row) was intentionally
    // retired: renderMetrics now renders every agent in state.agentMetrics as
    // its own equal top-level row, in array order, regardless of tier/parentId
    // (see main.js ~9385-9394). This asserts the new flat contract: leads AND
    // workers all render as their own row, nobody is hidden inside a collapsed
    // group, and none of the retired nesting markup (chevron/child-row/
    // aggregate tag) is ever produced.
    await t.test('8. flat metrics table: every agent (lead and worker) renders as its own top-level row', async () => {
      dispatch(buildTeamStatePayload());
      tick(5);
      await flush();
      assertNoErrors('team-rollup-dispatch');

      const tbody = doc.getElementById('metrics-tbody');
      assert.ok(tbody, 'metrics-tbody should exist');

      // No retired nesting markup anywhere: no chevron, no indented child
      // rows, no collapsed-aggregate tag.
      assert.equal(tbody.querySelector('.team-chevron'), null, 'no chevron in the flat design');
      assert.equal(tbody.querySelectorAll('tr.metrics-row--child').length, 0, 'no nested child rows in the flat design');
      assert.equal(tbody.querySelector('.team-tag'), null, 'no aggregate tag in the flat design');

      // Every agentMetrics entry (orchestrator, build-lead, coding-specialist,
      // ux-ui-designer) renders as its own top-level <tr>, in array order —
      // nobody is hidden, nobody is merged into an aggregate. Footer rollup
      // rows (per-vendor / per-cost-class totals etc., added by commit
      // 52311fc's buildMetricsRollup) are appended into the SAME #metrics-tbody
      // after the agent rows and are tagged with the "metrics-footer-row"
      // class (see appendFooterRow in renderMetricsTable) — exclude them here
      // so this stays an assertion about agent rows only.
      const allRows = [...tbody.querySelectorAll('tr')];
      const footerRows = allRows.filter((r: any) => r.classList.contains('metrics-footer-row'));
      const rows = allRows.filter((r: any) => !r.classList.contains('metrics-footer-row'));
      assert.equal(rows.length, 4, 'all 4 agents (lead + workers + orchestrator) should render as top-level rows');
      const names = rows.map((r: any) => r.querySelector('td.col-name').textContent);
      assert.deepEqual(
        names,
        ['Orchestrator', 'Build Lead', 'Coding Specialist', 'UX UI Designer'],
        'rows preserve agentMetrics order with no grouping by lead'
      );

      // Positive assertion on the footer: buildTeamStatePayload's 4 agents
      // all carry no `vendor` field, so buildMetricsRollup's byVendor bucket
      // collapses them into a single "unknown" vendor total row — exactly
      // one distinct vendor in this fixture, exactly one per-vendor footer
      // row. Vendor rows are distinguished from per-cost-class footer rows
      // (both can read "unknown total —" since the class bucket is ALSO
      // "unknown" here) by their distinct `title` tooltip text set in
      // appendFooterRow's per-vendor call (media/main.js renderMetricsTable).
      const vendorFooterRows = footerRows.filter((r: any) => {
        const cell = r.querySelector('td');
        return cell && (cell.title || '').includes('belongs to this vendor');
      });
      assert.equal(
        vendorFooterRows.length,
        1,
        'exactly one per-vendor footer row for the single distinct vendor ("unknown") present in the fixture'
      );

      // The lead's own row shows only ITS OWN tokens (800), never a rollup
      // sum of its team — rollup aggregation was retired along with nesting.
      const leadRow = rows.find((r: any) => r.querySelector('td.col-name').textContent === 'Build Lead');
      assert.ok(leadRow, 'Build Lead row should exist');
      const leadTokensCell = leadRow.querySelector('td.col-tokens');
      assert.ok(leadTokensCell, 'lead row should have a tokens cell');
      assert.equal(leadTokensCell.textContent, '800', "lead row shows its own tokens only, no team rollup sum");
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

    // ── Step 9b: scene reorder — orchestrator NOT first in agentMetrics ────────
    // Guards the scene-local reorder in media/main.js's render loop
    // (~12181-12186): when "orchestrator" is present but not at index 0, the
    // draw path rebuilds sceneAgentList with it moved to the front. That
    // branch (orchIdx > 0) is otherwise never exercised by a render tick in
    // this file, so this is a smoke check only — it does not (and cannot,
    // canvas output isn't inspectable) assert which avatar/seat each agent
    // gets, only that the reorder + everything downstream of it in the draw
    // loop (enemy spawn/conga update, agentCharMap pruning, per-agent
    // placement) completes without throwing.
    await t.test('9b. scene render does not throw when orchestrator is not first in agentMetrics', async () => {
      dispatch(buildOrchestratorNotFirstStatePayload());
      tick(10);
      await flush();
      assertNoErrors('scene-orchestrator-not-first');
    });

    // ── Step 9c: dazed-on-damage cosmetic state machine (uncommitted) ──────────
    // Guards the new "dazed on damage" fields/consts in media/main.js:
    // charEntry.dazePhase / dazeTimeLeft / dazeReentryCd (~12551-12558) and
    // DAZE_EXPR_INDEX / DAZE_SEATED_RECOVER_SEC / DAZE_SAFETY_MAX_SEC /
    // DAZE_REENTRY_COOLDOWN_SEC (~5322-5328). The per-frame bookkeeping
    // (reentry-cd decay ~12580, the isActive-drops-daze override ~12581-
    // 12584, the extinguish/wander gating on dazePhase ~13011/13193) runs for
    // every rendered agent every frame regardless of whether a hit/daze
    // trigger has actually fired, so driving many render ticks with a mix of
    // active + idle agents (theme + roster already loaded since step 2)
    // exercises that bookkeeping continuously. media/main.js is not
    // typechecked (see main-js-not-typechecked-runtime-scope-risk), so this
    // is the guard against an out-of-scope identifier in the new code
    // surfacing as a thrown ReferenceError. Cannot assert the actual dazed
    // visual state — canvas output isn't inspectable and triggering a real
    // hit needs enemies/combat RNG — so this is a smoke check only, mirroring
    // 9b's scope.
    await t.test('9c. render loop with active+idle agents does not throw with dazed-on-damage bookkeeping running', async () => {
      dispatch(buildStatePayload());
      tick(40);
      await flush();
      assertNoErrors('dazed-bookkeeping-render');
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

    // ── Step 10b: Settings "Delegation Health" section removed ──────────────
    // The Settings panel used to render a "Delegation Health" section reading
    // directSearches/directReads/directEdits/delegations off
    // lastSettings.delegationHealth — the same tool-call-count attribution
    // that was removed from the Delegation tab (webviewSmoke step "the
    // retired tool-call-count section is gone", ~L1716) because the
    // underlying counts are unreliable (unlocked shared active-agent stack
    // misattributes concurrent siblings' calls to the orchestrator) and
    // conflate tool calls with tasks. Dispatch a settings payload with a
    // fully populated (non-zero) delegationHealth to prove the section stays
    // gone even when the host still sends the data.
    await t.test('10b. settings: retired "Delegation Health" tool-call-count section does not render', async () => {
      dispatch({
        type: 'settings',
        payload: {
          hook: { installed: true, lastActivityAt: null },
          agents: [],
          delegation_mode: 'team_leads',
          delegationHealth: {
            directSearches: 12,
            directReads: 3,
            directEdits: 7,
            delegations: 40,
            tokens: 123456,
            session: { directSearches: 4, directReads: 1, directEdits: 2, delegations: 10, tokens: 4321 },
          },
          hookHealth: { healthy: true, issueCount: 0 },
          contextBudget: null,
        },
      });
      await flush();
      const setupConfig = doc.getElementById('setup-config');
      const dhHeadings = [...setupConfig.querySelectorAll('.settings-heading')].filter(
        (h: any) => (h.textContent || '').trim() === 'Delegation Health'
      );
      assert.equal(dhHeadings.length, 0, 'the retired "Delegation Health" section must not render');
      const bodyText = setupConfig.textContent || '';
      assert.ok(!bodyText.includes('Direct searches (Grep/Glob)'), 'no direct-search tool-call count should render');
      assert.ok(!bodyText.includes('Direct edits:'), 'no direct-edit tool-call count should render');
      assert.ok(!bodyText.includes('Direct file reads:'), 'no direct-read tool-call count should render');
      assert.ok(!bodyText.includes('Copy delegation tip'), 'the retired copy-delegation-tip button must not render');
      assertNoErrors('settings-delegation-health-removed');
    });

    // ── Step 10c: Harness selection dropdown (p13-t7) ────────────────────────
    // "Which tool runs your agents?" — renders a <select> bound to
    // harness.effective, disabled with a hint when harness.source is
    // "env"/"setting" (a higher-precedence layer already decides it), and
    // shows "Restart to apply" whenever harness.mismatch is true — driven
    // purely off the payload, not off any prior setHarness round-trip in
    // this window (audit fix: a stale/hand-edited execution.json must show
    // the hint on first render too).
    await t.test('10c. harness dropdown: renders, reflects effective, disables on override, shows restart hint on mismatch', async () => {
      const baseSettings = {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
      };

      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'opencode',
            source: 'execution',
            fileValue: 'opencode',
            running: 'opencode',
            mismatch: false,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'opencode', label: 'OpenCode' },
            ],
            requiresRestart: false,
          },
        },
      });
      await flush();
      const setupConfig = doc.getElementById('setup-config');
      const select = setupConfig.querySelector('#settings-harness-select') as any;
      assert.ok(select, 'harness <select> should render');
      assert.equal(select.value, 'opencode', 'select must reflect harness.effective');
      assert.equal(select.disabled, false, 'not overridden -> select must be enabled');
      assert.ok(!(setupConfig.textContent || '').includes('Restart to apply'), 'no mismatch -> no restart hint');

      // Overridden by env: disabled with the TYCOON_PROVIDER hint.
      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'claude-code',
            source: 'env',
            fileValue: 'opencode',
            running: 'claude-code',
            mismatch: false,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'opencode', label: 'OpenCode' },
            ],
            requiresRestart: false,
          },
        },
      });
      await flush();
      const envSelect = doc.getElementById('setup-config').querySelector('#settings-harness-select') as any;
      assert.equal(envSelect.disabled, true, 'source "env" -> select must be disabled');
      assert.ok(
        (doc.getElementById('setup-config').textContent || '').includes('Overridden by TYCOON_PROVIDER'),
        'must show the TYCOON_PROVIDER override hint'
      );

      // Mismatch (running differs from effective, no override): restart hint shows.
      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'opencode',
            source: 'execution',
            fileValue: 'opencode',
            running: 'claude-code',
            mismatch: true,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'opencode', label: 'OpenCode' },
            ],
            requiresRestart: true,
          },
        },
      });
      await flush();
      const mismatchConfig = doc.getElementById('setup-config');
      assert.equal(
        (mismatchConfig.querySelector('#settings-harness-select') as any).disabled,
        false,
        'mismatch alone (no env/setting override) must not disable the select'
      );
      assert.ok(
        (mismatchConfig.textContent || '').includes('Restart to apply'),
        'harness.mismatch true must show the restart hint on this render, with no prior setHarness in this session'
      );
      assertNoErrors('harness-dropdown');
    });

    // ── Step 11: Archived Plans section (0.0.340+) ───────────────────────────
    // PLAN_STATE now carries archivedPlans; the webview must render a
    // titled, read-only section listing each entry when non-empty, and
    // render NOTHING (no section at all) when the array is empty.
    await t.test('11. archived plans: section renders on non-empty, absent on empty', async () => {
      dispatch({
        type: 'PLAN_STATE',
        enabled: true,
        plan: null,
        archivedPlans: [
          {
            id: 'archived-1',
            title: 'First <Plan> & "Co"',
            phaseCount: 3,
            taskCount: 10,
            doneCount: 9,
            skippedCount: 1,
            archivedAt: Date.parse('2026-01-05T12:00:00Z'),
          },
          {
            id: 'archived-2',
            title: 'Second Plan',
            phaseCount: 5,
            taskCount: 16,
            doneCount: 16,
            skippedCount: 0,
            archivedAt: Date.parse('2026-02-10T08:30:00Z'),
          },
        ],
      });
      tick(2);
      await flush();
      assertNoErrors('archived-plans-nonempty');

      const body = doc.getElementById('project-plan-body');
      assert.ok(body, 'project-plan-body should exist');
      const section = body.querySelector('.plan-archived-section');
      assert.ok(section, 'Archived Plans section should render when archivedPlans is non-empty');
      const heading = section.querySelector('.plan-archived-heading');
      assert.equal(heading && heading.textContent, 'Archived Plans');
      const rows = section.querySelectorAll('.plan-archived-row');
      assert.equal(rows.length, 2, 'both archived entries should render');
      const titles = [...rows].map((r: any) => r.querySelector('.plan-archived-title').textContent);
      assert.deepEqual(titles, ['First <Plan> & "Co"', 'Second Plan'], 'titles render via textContent (safe with < & " chars) in received order');
      const metas = [...rows].map((r: any) => r.querySelector('.plan-archived-meta').textContent);
      assert.ok(metas[0].includes('3 phases'), 'summary should include phase count');
      assert.ok(metas[0].includes('10 tasks'), 'summary should include task count');
      assert.ok(metas[0].includes('9 done'), 'summary should include done count');
      assert.ok(metas[0].includes('1 skipped'), 'skipped clause included when skippedCount > 0');
      assert.ok(!metas[1].includes('skipped'), 'skipped clause omitted when skippedCount === 0');
      // No raw "<" survived into the DOM as markup — the row has exactly one
      // child element carrying the title text, proving textContent (not
      // innerHTML) was used.
      assert.equal(rows[0].querySelector('.plan-archived-title').children.length, 0);

      // Empty archivedPlans -> section must be entirely absent.
      dispatch({ type: 'PLAN_STATE', enabled: true, plan: null, archivedPlans: [] });
      tick(2);
      await flush();
      assertNoErrors('archived-plans-empty');
      assert.equal(
        doc.getElementById('project-plan-body').querySelector('.plan-archived-section'),
        null,
        'Archived Plans section must be absent when archivedPlans is empty'
      );

      // Defensive: a PLAN_STATE with archivedPlans omitted entirely (e.g. a
      // standalone host) must default to [] and must not throw.
      dispatch({ type: 'PLAN_STATE', enabled: true, plan: null });
      tick(2);
      await flush();
      assertNoErrors('archived-plans-omitted-field');
      assert.equal(
        doc.getElementById('project-plan-body').querySelector('.plan-archived-section'),
        null,
        'Archived Plans section must be absent when archivedPlans is omitted from the message'
      );
    });
    // ── Step 12: corrupt-plan card (plan.json corruption fix) ───────────────
    // PLAN_STATE now carries planReadable/planError/hasBackup. When
    // planReadable === false, renderProjectPlanSection() must render
    // .plan-corrupt-card INSTEAD OF any .plan-task-card — see main.js
    // buildProjectPlanCorruptCard() (~342) and the currentPlanReadable===false
    // branch in renderProjectPlanSection() (~398). The section is enabled the
    // same way step 11 enables it: PLAN_STATE.enabled === true.
    await t.test('12. corrupt plan.json: renders a corrupt card instead of task cards, with/without a restore button', async () => {
      // 12a. Corrupt + a backup exists -> corrupt card + restore button, no task cards.
      dispatch({
        type: 'PLAN_STATE',
        enabled: true,
        plan: null,
        planReadable: false,
        planError: 'bad json',
        hasBackup: true,
      });
      tick(2);
      await flush();
      assertNoErrors('plan-corrupt-with-backup');

      const body = doc.getElementById('project-plan-body');
      assert.ok(body, 'project-plan-body should exist');
      const corruptCard = body.querySelector('.plan-corrupt-card');
      assert.ok(corruptCard, '.plan-corrupt-card should render when planReadable is false');
      const restoreBtn = corruptCard.querySelector('.plan-corrupt-restore-btn');
      assert.ok(restoreBtn, 'a restore button should render when hasBackup is true');
      assert.equal(body.querySelector('.plan-task-card'), null, 'no task card should render in the corrupt state');

      restoreBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const restoreMsg = [...posted].reverse().find((m: any) => m.type === 'RESTORE_PLAN_BACKUP');
      assert.ok(restoreMsg, 'clicking Restore last good should post RESTORE_PLAN_BACKUP');
      assertNoErrors('plan-corrupt-restore-click');

      // 12b. Corrupt + no backup -> corrupt card, no restore button, still no task cards.
      dispatch({
        type: 'PLAN_STATE',
        enabled: true,
        plan: null,
        planReadable: false,
        planError: 'bad json',
        hasBackup: false,
      });
      tick(2);
      await flush();
      assertNoErrors('plan-corrupt-no-backup');
      const corruptCard2 = body.querySelector('.plan-corrupt-card');
      assert.ok(corruptCard2, '.plan-corrupt-card should still render with hasBackup false');
      assert.equal(
        corruptCard2.querySelector('.plan-corrupt-restore-btn'),
        null,
        'no restore button should render when hasBackup is false'
      );
      assert.equal(body.querySelector('.plan-task-card'), null, 'no task card should render in the corrupt state');

      // 12c. A normal readable plan (planReadable omitted, back-compat default
      // true) with real phases/tasks -> corrupt card gone, task cards render.
      dispatch({
        type: 'PLAN_STATE',
        enabled: true,
        plan: {
          version: 1,
          title: 'Readable Plan',
          phases: [
            { id: 'phase-a', num: 1, name: 'Phase A', goal: 'Get A done', gate: 'pending', taskIds: ['task-1'] },
          ],
          tasks: [
            {
              id: 'task-1',
              phaseId: 'phase-a',
              title: 'Task One',
              detail: 'detail',
              acceptanceCriteria: ['works'],
              status: 'active',
              verifyAttempts: 0,
            },
          ],
          currentPhaseId: 'phase-a',
          currentTaskId: 'task-1',
        },
      });
      tick(2);
      await flush();
      assertNoErrors('plan-readable-again');
      assert.equal(
        body.querySelector('.plan-corrupt-card'),
        null,
        'the corrupt card must be gone once the plan is readable again'
      );
      const taskCards = body.querySelectorAll('.plan-task-card');
      assert.equal(taskCards.length, 1, 'the readable plan\'s task card should render');
    });

    // ── Step 13: plan-stall-note (0.0.346-ish) ──────────────────────────────
    // isPlanStalled() (main.js) is true only when the plan is enabled+readable,
    // has an active task, AND state.lastActivityAt is a stale number (older
    // than STALL_MS = 5min). buildProjectPlanTaskCard appends a
    // .plan-stall-note on the active task's card without removing its
    // Retry/Skip actions. Each PLAN_STATE dispatch re-renders the section, so
    // driving state -> PLAN_STATE (in that order) exercises the real path
    // without needing to wait on the 1s re-render ticker.
    await t.test('13. plan-stall-note: appears only when lastActivityAt is stale, never removes task actions', async () => {
      const stallPlan = {
        version: 1,
        title: 'Stall Plan',
        phases: [
          { id: 'phase-s', num: 1, name: 'Phase S', goal: 'Get S done', gate: 'pending', taskIds: ['task-s'] },
        ],
        tasks: [
          {
            id: 'task-s',
            phaseId: 'phase-s',
            title: 'Task S',
            detail: 'detail',
            acceptanceCriteria: ['works'],
            status: 'active',
            verifyAttempts: 0,
          },
        ],
        currentPhaseId: 'phase-s',
        currentTaskId: 'task-s',
      };

      // 13a. Stale lastActivityAt (6 min ago, past the 5 min STALL_MS) + an
      // active task -> the stall note renders, and Retry/Skip remain.
      dispatch({
        type: 'state',
        state: {
          sessionActive: true,
          completedTasks: 0,
          workers: {},
          agentMetrics: [],
          lastActivityAt: Date.now() - 6 * 60 * 1000,
        },
      });
      dispatch({ type: 'PLAN_STATE', enabled: true, plan: stallPlan });
      tick(2);
      await flush();
      assertNoErrors('plan-stall-stale');

      const planBody = doc.getElementById('project-plan-body');
      assert.ok(planBody, 'project-plan-body should exist');
      const staleCard = planBody.querySelector('.plan-task-card[data-task-id="task-s"]');
      assert.ok(staleCard, 'the active task card should render');
      assert.ok(
        staleCard.querySelector('.plan-stall-note'),
        'a stale lastActivityAt with an active task should render a .plan-stall-note'
      );
      const staleActions = staleCard.querySelectorAll('.plan-task-actions button');
      assert.ok(
        staleActions.length > 0,
        'the stall note must be additive: Retry/Skip actions must still be present'
      );

      // 13b. Recent lastActivityAt (now) + the same active plan -> no stall note.
      dispatch({
        type: 'state',
        state: {
          sessionActive: true,
          completedTasks: 0,
          workers: {},
          agentMetrics: [],
          lastActivityAt: Date.now(),
        },
      });
      dispatch({ type: 'PLAN_STATE', enabled: true, plan: stallPlan });
      tick(2);
      await flush();
      assertNoErrors('plan-stall-recent');
      const recentCard = doc.getElementById('project-plan-body').querySelector('.plan-task-card[data-task-id="task-s"]');
      assert.ok(recentCard, 'the active task card should still render');
      assert.equal(
        recentCard.querySelector('.plan-stall-note'),
        null,
        'a recent lastActivityAt must not render a stall note'
      );

      // 13c. lastActivityAt omitted entirely (undefined) + the same active
      // plan -> no stall note (back-compat with a host/version that doesn't
      // send it yet).
      dispatch({
        type: 'state',
        state: {
          sessionActive: true,
          completedTasks: 0,
          workers: {},
          agentMetrics: [],
        },
      });
      dispatch({ type: 'PLAN_STATE', enabled: true, plan: stallPlan });
      tick(2);
      await flush();
      assertNoErrors('plan-stall-omitted');
      const omittedCard = doc.getElementById('project-plan-body').querySelector('.plan-task-card[data-task-id="task-s"]');
      assert.ok(omittedCard, 'the active task card should still render');
      assert.equal(
        omittedCard.querySelector('.plan-stall-note'),
        null,
        'an omitted lastActivityAt must not render a stall note (back-compat)'
      );
    });

    // ── Step 14: per-achievement "unseen" red-dot (0.0.346+) ─────────────────
    // badgeUnseenByTheme/badgeKnownByTheme (keyed by currentBadgeThemeId) drive
    // a .badge-card-dot appended to an unlocked .badge-card whose badge_id is
    // in the working set unseenBadgeIds. THEME_INITIALIZED baselines
    // knownBadgeIds = unlockedBadgeIds on a theme's FIRST-ever load (so
    // already-unlocked badges never retroactively grow a dot — main.js
    // ~7924-7946); a SUBSEQUENT load of a KNOWN theme diffs the freshly-seeded
    // unlocked ids against the saved baseline and adds newly-unlocked ids to
    // unseenBadgeIds. Opening the badge menu (badge-hud-btn click, ~915-929)
    // renders the panel FIRST (so dots earned since the last open are visible
    // for this viewing) THEN clears unseenBadgeIds for currentBadgeThemeId —
    // so dots show once, then are gone next open.
    await t.test('14. per-badge unseen dot: baseline / new unlock / cleared-on-open / per-theme isolation', async () => {
      const hudBtn = doc.getElementById('badge-hud-btn');
      assert.ok(hudBtn, 'badge-hud-btn should exist');
      const list = doc.getElementById('badge-list');
      assert.ok(list, 'badge-list should exist');

      function cardByName(name: string) {
        return [...list.querySelectorAll('.badge-card')].find(
          (c: any) => ((c.querySelector('.badge-card-name') || {}).textContent || '') === name
        );
      }

      // 14a. Baseline: first-ever load of theme "t1" with 2 of its 3 badges
      // already unlocked -> those badges must NOT retroactively show a dot.
      dispatch(buildBadgeDotThemePayload('t1', ['a', 'b']));
      tick(2);
      await flush();
      assertNoErrors('badge-dot-t1-baseline-load');
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.ok(list.children.length > 0, 'badge-list should render badge cards for t1');
      assert.equal(
        list.querySelectorAll('.badge-card-dot').length,
        0,
        'no retroactive dots on first load of already-unlocked badges'
      );
      assertNoErrors('badge-dot-t1-baseline-open');

      // 14b. A subsequent load of the SAME known theme "t1" that newly
      // unlocks badge "c" -> exactly one dot, on badge c's own card only.
      dispatch(buildBadgeDotThemePayload('t1', ['a', 'b', 'c']));
      tick(2);
      await flush();
      assertNoErrors('badge-dot-t1-new-unlock-load');
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const dotsAfterUnlock = list.querySelectorAll('.badge-card-dot');
      assert.equal(dotsAfterUnlock.length, 1, 'exactly one unseen dot for the newly unlocked badge');
      const cardA = cardByName('Alpha Badge');
      const cardB = cardByName('Bravo Badge');
      const cardC = cardByName('Charlie Badge');
      assert.ok(cardC, "badge c's card should render");
      assert.ok(cardC!.querySelector('.badge-card-dot'), "the dot must be on badge c's own card");
      assert.equal(cardA && cardA.querySelector('.badge-card-dot'), null, 'baseline badge a must not carry a dot');
      assert.equal(cardB && cardB.querySelector('.badge-card-dot'), null, 'baseline badge b must not carry a dot');
      assertNoErrors('badge-dot-t1-new-unlock-open');

      // 14c. Cleared on open: the click above already rendered-then-cleared
      // the unseen set (see the badge-hud click handler ordering). Re-opening
      // (re-render via the same open path) must show zero dots now.
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.equal(
        list.querySelectorAll('.badge-card-dot').length,
        0,
        'dots must be cleared after the viewing that showed them'
      );
      assertNoErrors('badge-dot-t1-cleared-on-open');

      // 14d. Per-theme isolation: first-ever load of a DIFFERENT theme "t2"
      // (one badge already unlocked) must show zero dots, and must not leak
      // any unseen-dot state carried over from "t1".
      dispatch(buildBadgeDotThemePayload('t2', ['a']));
      tick(2);
      await flush();
      assertNoErrors('badge-dot-t2-baseline-load');
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.equal(
        list.querySelectorAll('.badge-card-dot').length,
        0,
        't2 first load must show zero dots and must not inherit t1 unseen state'
      );
      assertNoErrors('badge-dot-t2-baseline-open');
    });

    // ── Step 15: per-badge dot survives a SHRINK then a re-earn (bugfix) ─────
    // Reviewer-caught defect: the known/unseen reconciliation in
    // updateBadgeHud() used to run ONLY inside the `count > badgeHudLastCount`
    // growth guard (main.js ~957), so when unlockedBadgeIds SHRINKS —
    // doRebirth() filters it down to rebirth_* ids (~1557), handleMetricsReset
    // zeroes it (~9961) — knownBadgeIds stayed stale/oversized and a badge
    // re-earned after the shrink never lit a dot again. Fixed by moving the
    // reconciliation out of the growth guard so it runs on every call
    // (~973-1001), resyncing knownBadgeIds DOWN too. Proven here via the REAL
    // runtime rebirth path (not a THEME_INITIALIZED reload, which resyncs
    // known on its own and would mask the defect): baseline-load t1 with
    // a/b/c unlocked+seen, shrink via the actual Rebirth button flow, then
    // re-earn "c" via the runtime TASKS_COMPLETED unlock path (a "state"
    // message bumping completedTasks, picked up by updateBadgeUnlocks() every
    // draw frame, ~13613).
    await t.test('15. per-badge dot re-lights after a rebirth shrink + re-earn', async () => {
      const hudBtn = doc.getElementById('badge-hud-btn');
      assert.ok(hudBtn, 'badge-hud-btn should exist');
      const list = doc.getElementById('badge-list');
      assert.ok(list, 'badge-list should exist');

      function cardByName(name: string) {
        return [...list.querySelectorAll('.badge-card')].find(
          (c: any) => ((c.querySelector('.badge-card-name') || {}).textContent || '') === name
        );
      }

      // 15a. Baseline-load t1 with all three badges unlocked (already known
      // from Step 14) and clear any dot by opening the menu once — a clean,
      // fully-seen starting point.
      dispatch(buildBadgeDotThemePayload('t1', ['a', 'b', 'c']));
      tick(2);
      await flush();
      assertNoErrors('badge-shrink-t1-reload');
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.equal(
        list.querySelectorAll('.badge-card-dot').length,
        0,
        'no dot before the shrink (a/b/c already known/seen)'
      );

      // 15b. SHRINK via the real runtime rebirth path (Rebirth -> Confirm).
      // requiredRebirthBadgeIds always resolves to all of a/b/c here: t1's
      // tier pool never matches this fixture's badge ids, so
      // rollRebirthRequirement() falls back to the theme's full badge pool,
      // and n = min(3, pool.length) = 3 picks all of them.
      const panel = doc.getElementById('rebirth-panel');
      assert.ok(panel, 'rebirth-panel should exist');
      const rebirthBtn = panel.querySelector('.rebirth-btn:not([disabled])');
      assert.ok(rebirthBtn, 'rebirth button should be enabled (a/b/c all unlocked)');
      rebirthBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const confirmBtn = [...panel.querySelectorAll('.rebirth-btn')].find(
        (b: any) => (b.textContent || '').trim() === 'Confirm'
      );
      assert.ok(confirmBtn, 'Confirm button should appear after clicking Rebirth');
      confirmBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      tick(5);
      await flush();
      assertNoErrors('badge-shrink-rebirth');
      // None of a/b/c are "rebirth_"-prefixed, so doRebirth() wipes all three
      // back to locked.
      const cardCAfterShrink = cardByName('Charlie Badge');
      assert.ok(cardCAfterShrink, "badge c's card should still render");
      assert.ok(
        cardCAfterShrink!.classList.contains('badge-card--locked'),
        'badge c should be locked again after the rebirth shrink'
      );

      // 15c. RE-EARN "c" via the runtime unlock path: bump state.completedTasks
      // past c's TASKS_COMPLETED threshold (1). updateBadgeUnlocks() runs every
      // draw frame and calls updateBadgeHud() when it unlocks a badge.
      dispatch({
        type: 'state',
        state: { sessionActive: true, completedTasks: 1, workers: {}, agentMetrics: [] },
      });
      tick(5);
      await flush();
      assertNoErrors('badge-shrink-reearn');

      // 15d. Opening the menu again must show badge c unlocked WITH a dot —
      // proof the fix resynced knownBadgeIds down on the shrink, so this
      // re-earn is correctly treated as genuinely new (pre-fix, c would have
      // stayed in the stale knownBadgeIds and never grown a dot again).
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const cardCReearned = cardByName('Charlie Badge');
      assert.ok(cardCReearned, "badge c's card should render");
      assert.ok(
        cardCReearned!.classList.contains('badge-card--unlocked'),
        'badge c should be unlocked again after the re-earn'
      );
      assert.ok(
        cardCReearned!.querySelector('.badge-card-dot'),
        'badge c re-earned after a shrink must show its dot again (the reviewer-caught defect)'
      );
      assertNoErrors('badge-shrink-reearn-open');
    });

    // ── Step 16: rebirth count + badges scoped per-theme (no cross-theme leak) ─
    // Regression coverage for the fix removing the unscoped
    // vscode.getState().rebirth fallback (main.js persistRebirth()/
    // THEME_INITIALIZED handler, ~1462-1501 / ~7965-8007): rebirth count and
    // unlocked badges must come SOLELY from the HOST's per-theme
    // rebirth_state/unlocked_badge_ids on each THEME_INITIALIZED, never carry
    // over from a previously loaded theme. renderRebirthPanel() only repaints
    // on the badges-menu OPEN (not on THEME_INITIALIZED itself), so every
    // assertion below follows a badge-hud-btn click.
    await t.test('16. rebirth count + badges scoped per-theme (no cross-theme leak)', async () => {
      const hudBtn = doc.getElementById('badge-hud-btn');
      assert.ok(hudBtn, 'badge-hud-btn should exist');
      const list = doc.getElementById('badge-list');
      assert.ok(list, 'badge-list should exist');
      const rebirthPanel = doc.getElementById('rebirth-panel');
      assert.ok(rebirthPanel, 'rebirth-panel should exist');

      function cardByName(name: string) {
        return [...list.querySelectorAll('.badge-card')].find(
          (c: any) => ((c.querySelector('.badge-card-name') || {}).textContent || '') === name
        );
      }
      // title.textContent is "Rebirth ×N" followed by an appended "ⓘ" info
      // span (see renderRebirthPanel, ~1684-1693), so match by prefix.
      function rebirthTitleStartsWith(prefix: string): boolean {
        const title = rebirthPanel.querySelector('.rebirth-title');
        return !!title && (title.textContent || '').indexOf(prefix) === 0;
      }

      // rA and rB deliberately SHARE badge id "s1" (position 3, a
      // TASKS_COMPLETED trigger) — real themes all draw from ONE badge-id
      // catalog (buildDefaultBadges), so a disjoint-id fixture would only
      // ever exercise "renderBadgePanel skips ids absent from the current
      // theme's own catalog," never the actual collision the leak produced:
      // the SAME id showing unlocked in a theme that never unlocked it.
      // threshold 1000 keeps it from spuriously auto-unlocking off leftover
      // state.completedTasks (Step 15c left it at 1, and rebirthBaseline.tasks
      // is deliberately NOT reset per theme — main.js ~8014).
      const rAUnlocked = ['a', 'b', 's1'];
      const rARebirthState = {
        count: 3,
        baseline: { built: 0, evicted: 0, tasks: 0 },
        required: [],
        unlocked: [],
        cycleBuilt: 0,
        cycleEvicted: 0,
        rackInsertIndex: null,
        rangedUnlocked: false,
      };

      // 16a. Load theme "rA": all 3 of its badges (incl. the shared "s1")
      // unlocked, rebirth count 3.
      dispatch(buildBadgeDotThemePayload('rA', rAUnlocked, {
        badgeIds: ['a', 'b', 's1'],
        badgeNames: ['Alpha Badge', 'Bravo Badge', 'Sierra Badge'],
        taskThreshold: 1000,
        rebirthState: rARebirthState,
      }));
      tick(2);
      await flush();
      assertNoErrors('rebirth-scope-rA-load');
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.ok(rebirthTitleStartsWith('Rebirth ×3'), 'rA rebirth title should reflect count 3');
      const rACardA = cardByName('Alpha Badge');
      const rACardB = cardByName('Bravo Badge');
      const rACardS1 = cardByName('Sierra Badge');
      assert.ok(rACardA && rACardA.classList.contains('badge-card--unlocked'), 'rA badge a should be unlocked');
      assert.ok(rACardB && rACardB.classList.contains('badge-card--unlocked'), 'rA badge b should be unlocked');
      assert.ok(rACardS1 && rACardS1.classList.contains('badge-card--unlocked'), 'rA badge s1 should be unlocked');
      assertNoErrors('rebirth-scope-rA-open');

      // 16b. Switch to a FRESH theme "rB": ids x/y are distinct from rA, but
      // the 3rd badge id is the SAME "s1" as rA's — present in rB's catalog
      // (so it renders) but absent from rB's own unlocked_badge_ids (so it
      // must render LOCKED). This is the realistic same-id collision: before
      // the fix, the unscoped vscode.getState().rebirth fallback would have
      // carried rA's unlockedBadgeIds (incl. "s1") into rB, showing it
      // unlocked here. taskThreshold 1000 keeps rB's own "s1" from
      // spuriously auto-unlocking off leftover state.completedTasks.
      dispatch(buildBadgeDotThemePayload('rB', ['x'], {
        badgeIds: ['x', 'y', 's1'],
        badgeNames: ['Xray Badge', 'Yankee Badge', 'Sierra Badge'],
        taskThreshold: 1000,
        rebirthState: null,
      }));
      tick(2);
      await flush();
      assertNoErrors('rebirth-scope-rB-load');
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.ok(rebirthTitleStartsWith('Rebirth ×0'), 'a fresh theme with rebirth_state: null must start at count 0');
      assert.ok(!cardByName('Alpha Badge'), "rA's badge a must not appear in rB's badge list");
      assert.ok(!cardByName('Bravo Badge'), "rA's badge b must not appear in rB's badge list");
      const rBCardX = cardByName('Xray Badge');
      assert.ok(rBCardX && rBCardX.classList.contains('badge-card--unlocked'), 'rB badge x should be unlocked (its own unlock)');
      const rBCardS1 = cardByName('Sierra Badge');
      assert.ok(rBCardS1, "shared badge id s1 should render in rB's badge list (same catalog id as rA)");
      assert.ok(!rBCardS1.classList.contains('badge-card--unlocked'), 'rB badge s1 must NOT be unlocked — rA unlocking it must not leak into rB');
      assert.ok(rBCardS1.classList.contains('badge-card--locked'), 'rB badge s1 should render as locked');
      assertNoErrors('rebirth-scope-rB-open');

      // 16c. Switch BACK to "rA" with its saved rebirth_state (count 3) and
      // unlocked badges — both must be restored, proving rA's state was
      // neither leaked into rB nor clobbered by it.
      dispatch(buildBadgeDotThemePayload('rA', rAUnlocked, {
        badgeIds: ['a', 'b', 's1'],
        badgeNames: ['Alpha Badge', 'Bravo Badge', 'Sierra Badge'],
        taskThreshold: 1000,
        rebirthState: rARebirthState,
      }));
      tick(2);
      await flush();
      assertNoErrors('rebirth-scope-rA-restore-load');
      hudBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.ok(rebirthTitleStartsWith('Rebirth ×3'), 'rA rebirth count 3 should be restored on switch-back');
      const rACardA2 = cardByName('Alpha Badge');
      const rACardB2 = cardByName('Bravo Badge');
      const rACardS1_2 = cardByName('Sierra Badge');
      assert.ok(rACardA2 && rACardA2.classList.contains('badge-card--unlocked'), 'rA badge a should be restored unlocked');
      assert.ok(rACardB2 && rACardB2.classList.contains('badge-card--unlocked'), 'rA badge b should be restored unlocked');
      assert.ok(rACardS1_2 && rACardS1_2.classList.contains('badge-card--unlocked'), 'rA badge s1 should be restored unlocked (rB must not have clobbered it)');
      assertNoErrors('rebirth-scope-rA-restore-open');
    });
    // ── Step 17: rebirth tier pool sliding window (badge-gate difficulty ramp) ─
    // rebirthTierPool(count) (main.js ~4837) selects a SLIDING-WINDOW pool for
    // rollRebirthRequirement() based on rebirthCount: EARLY (count<=2), MID
    // (count<=5), LATE (count>=6) — each tier is its OWN bounded pool, so the
    // easiest badges drop out as rebirthCount climbs instead of accumulating.
    // rebirthTierPool/REBIRTH_TIER_* live inside main.js's bare `(function(){
    // ... })()` IIFE with no exported hook (confirmed: no window.__TEST__ or
    // similar), so this drives the OBSERVABLE behavior instead: dispatch
    // THEME_INITIALIZED with rebirth_state.count set and required: [] (always
    // invalid, since length 0 fails requiredStillValid -> the restore path
    // calls rollRebirthRequirement() unconditionally, main.js ~8243-8245),
    // then read the freshly picked ids back from the SAVE_REBIRTH_STATE
    // message persistRebirth() posts synchronously right after (~1480-1501,
    // invoked at ~8250). dispatch()'s message handler has no awaits before
    // that post, so no flush() is needed between rolls.
    //
    // Picks are random (Math.random, deliberately unstubbed) so each count is
    // rolled many times and the UNION of everything ever picked is checked:
    // forbidden ids can structurally never appear (rollRebirthRequirement
    // only samples from the tier pool intersected with themeBadges), and
    // allowed ids are near-certain (odds of total non-appearance are ~1e-13
    // or smaller at ITER=120 for every pool size used here) to show up at
    // least once across the sample.
    await t.test('17. rebirth tier pool: sliding window gates badges by rebirthCount', async () => {
      const ALL_BADGE_IDS = [
        'build_1', 'build_3', 'build_6', 'build_10', 'build_13',
        'evict_1', 'evict_5', 'evict_10', 'evict_20', 'evict_35', 'evict_50', 'evict_75', 'evict_100',
        'task_1', 'task_10', 'task_50', 'task_150', 'task_500',
        'crew_3', 'crew_6',
        'reborn_builder',
        'rebirth_1', 'rebirth_2', 'rebirth_3', 'rebirth_5',
      ];

      function buildTierThemePayload(themeId: string, count: number) {
        const manifest = {
          theme_id: themeId,
          viewport: {
            native_width: 1280,
            native_height: 720,
            walkable_nav_polygon: [[0.1, 0.6], [0.9, 0.6], [0.9, 0.95], [0.1, 0.95]],
            character_scale: 1, object_scale: 1, overall_scale: 1, rival_scale: 1, decor_scale: 1,
            enemy_config: { spawn_interval_seconds: 45, count_mode: 'random' },
            crate_asset: 'frames.json#crate', poof_asset: 'frames.json#poof', projectile_asset: 'frames.json#projectile',
          },
          roster_agents: [{ slot_id: 'a1', name: 'Alpha' }],
          roster_rivals: [{ rival_id: 'r1', name: 'Rival One' }],
          buildable_objects: [{ object_id: 'o1', display_name: 'Rack', build_order: 0, anchor_coord: [0.5, 0.5] }],
          decor_objects: [],
          badges: ALL_BADGE_IDS.map((id) => ({
            badge_id: id, display_name: id, trigger_type: 'OBJECTS_BUILT', threshold: 1,
            icon_asset: 'frames.json#achievement_1',
          })),
        };
        const frames: Record<string, string[]> = {
          environment_background: [PX],
          agent_a1: frameArray(4),
          rival_r1: frameArray(4),
          object_o1: frameArray(4),
          achievement_1: [PX],
          crate: frameArray(2),
          poof: frameArray(2),
          projectile: [PX],
        };
        return {
          type: 'THEME_INITIALIZED',
          payload: {
            theme_id: themeId,
            manifest,
            frames,
            badges: manifest.badges,
            unlocked_badge_ids: [],
            rebirth_state: {
              count,
              baseline: { built: 0, evicted: 0, tasks: 0 },
              required: [], // always invalid -> forces a reroll on every dispatch
              unlocked: [],
              cycleBuilt: 0,
              cycleEvicted: 0,
              rackInsertIndex: null,
              rangedUnlocked: false,
            },
          },
        };
      }

      function lastRequiredIds(): string[] {
        for (let i = posted.length - 1; i >= 0; i--) {
          const m = posted[i];
          if (m && m.type === 'SAVE_REBIRTH_STATE') {
            return Array.isArray(m.payload?.state?.required) ? m.payload.state.required.slice() : [];
          }
        }
        return [];
      }

      const ITER = 120;

      // Roll `iterations` times at the given rebirthCount and return the
      // union of every badge id ever picked.
      async function rollUnion(themeId: string, count: number, iterations: number): Promise<Set<string>> {
        const union = new Set<string>();
        for (let i = 0; i < iterations; i++) {
          dispatch(buildTierThemePayload(themeId, count));
          for (const id of lastRequiredIds()) union.add(id);
        }
        tick(2);
        await flush();
        assertNoErrors(`rebirth-tier-pool-${themeId}-${count}`);
        return union;
      }

      function assertPool(union: Set<string>, label: string, included: string[], excluded: string[]) {
        for (const id of included) {
          assert.ok(union.has(id), `${label}: expected ${id} to be drawable (seen across ${ITER} rolls)`);
        }
        for (const id of excluded) {
          assert.ok(!union.has(id), `${label}: ${id} must never be drawn`);
        }
      }

      const REBIRTH_MILESTONE_IDS = ['rebirth_1', 'rebirth_2', 'rebirth_3', 'rebirth_5'];

      // ── EARLY: rebirthCount 0 and 2 (gates rebirths 1-3) ────────────────────
      for (const count of [0, 2]) {
        const union = await rollUnion('tier_early', count, ITER);
        assertPool(union, `EARLY(count=${count})`,
          ['build_10', 'evict_75', 'task_50'],
          ['build_13', 'evict_100', 'task_150', 'task_500', 'reborn_builder', ...REBIRTH_MILESTONE_IDS]
        );
      }

      // ── MID: rebirthCount 3 and 5 (gates rebirths 4-6) — the sliding window
      // drops the easiest EARLY badges as it climbs.
      for (const count of [3, 5]) {
        const union = await rollUnion('tier_mid', count, ITER);
        assertPool(union, `MID(count=${count})`,
          ['evict_100', 'task_150'],
          [
            'task_500',
            'build_1', 'build_3', 'evict_1', 'evict_5', 'evict_10', 'task_1', 'task_10',
            ...REBIRTH_MILESTONE_IDS,
          ]
        );
      }

      // ── LATE: rebirthCount 6 and 20 (gates rebirths 7+) — only the hardest
      // per-cycle badges remain.
      for (const count of [6, 20]) {
        const union = await rollUnion('tier_late', count, ITER);
        assertPool(union, `LATE(count=${count})`,
          ['task_500'],
          [
            'build_1', 'build_3', 'build_6',
            'evict_1', 'evict_5', 'evict_10', 'evict_20', 'evict_35',
            'task_1', 'task_10', 'task_50',
            ...REBIRTH_MILESTONE_IDS,
          ]
        );
      }
    });

    // ── Step 18: Delegation tab reports the orchestrator in TASKS, sourced
    // from the same value the Metrics tab uses ────────────────────────────
    // The Delegation tab used to have a separate "Orchestrator direct tool
    // use" section reporting hook-attributed Grep/Read/Edit CALL counts
    // (an unreliable, differently-scoped number from taskCount). That
    // section was removed and folded into "Coordination (not delegated
    // work)", which already reads orch.taskCount off the same lastMetrics
    // array the Metrics tab's orchestrator row (tasksTd, the "16*" cell)
    // reads. This guards both halves of that contract: the two numbers
    // can't be observed to disagree, and the retired tool-call-count UI
    // (heading text, leak classes) is gone for good.
    await t.test('18. Delegation tab "Coordination" orchestrator task count matches the Metrics tab orchestrator row', async () => {
      dispatch(buildOrchestratorTaskCountStatePayload(16));
      tick(5);
      await flush();
      assertNoErrors('orchestrator-task-count-state');

      // Metrics tab: orchestrator row's tasks cell is "<taskCount>*".
      const tbody = doc.getElementById('metrics-tbody');
      assert.ok(tbody, 'metrics-tbody should exist');
      const rows = [...tbody.querySelectorAll('tr')];
      const orchRow = rows.find((r: any) => r.querySelector('td.col-name')?.textContent === 'Orchestrator');
      assert.ok(orchRow, 'an Orchestrator row should render in the Metrics tab');
      const metricsTasksText = orchRow.querySelector('td.col-tasks').textContent;
      assert.equal(metricsTasksText, '16*', 'Metrics tab orchestrator row should show taskCount with the asterisk cue');

      // Delegation tab: the Coordination section states the same task count.
      const delegationBody = doc.getElementById('delegation-stats');
      assert.ok(delegationBody, 'delegation-stats should exist');
      const headings = [...delegationBody.querySelectorAll('.delegation-stats-heading')];
      const coordHeading = headings.find((h: any) => (h.textContent || '').trim() === 'Coordination (not delegated work)');
      assert.ok(coordHeading, 'a Coordination (not delegated work) heading should render');
      const coordLine = coordHeading.nextElementSibling;
      assert.ok(coordLine, 'the Coordination heading should be followed by its stats row');
      assert.match(coordLine.textContent, /\b16 tasks\b/, 'Coordination line should state 16 tasks');

      // Both figures parse to the SAME integer — proves a single source,
      // not two independently-maintained numbers that happen to agree here.
      const metricsTaskCount = parseInt(metricsTasksText, 10);
      const coordTaskMatch = /(\d+) tasks?/.exec(coordLine.textContent);
      assert.ok(coordTaskMatch, 'Coordination line should contain a "<N> task(s)" figure');
      assert.equal(parseInt(coordTaskMatch[1], 10), metricsTaskCount, 'Delegation tab and Metrics tab orchestrator task counts must never disagree');

      // The retired tool-call-count section is gone: no heading, no leak
      // status classes anywhere in the Delegation tab.
      const retiredHeading = headings.find((h: any) => (h.textContent || '').trim() === 'Orchestrator direct tool use');
      assert.equal(retiredHeading, undefined, 'the retired "Orchestrator direct tool use" (tool-call-count) section must not render');
      assert.equal(delegationBody.querySelector('.delegation-leak-ok'), null, 'no leak-ok class should render');
      assert.equal(delegationBody.querySelector('.delegation-leak-warn'), null, 'no leak-warn class should render');

      // The coordination-cost caption still reads correctly in task units.
      const caption = [...delegationBody.querySelectorAll('.delegation-stats-caption')].find(
        (c: any) => (c.textContent || '').includes('Zero tasks')
      );
      assert.ok(caption, 'the "Zero tasks ≠ zero tokens" caption should still render');
      assertNoErrors('orchestrator-task-count-render');
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

function buildObjScaleThemePayload(objectScale: number, overrides: Record<string, number>, objectIds: string[], rebirthCount = 0) {
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
      // Peeked by main.js (~7551) BEFORE buildSeededQueue runs to decide
      // whether the first buildable (the "rack") is included in the queue.
      // Default 0 preserves prior behavior for callers that omit this.
      rebirth_state: { count: rebirthCount },
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
  return { win, doc, dispatch, tick, flush, drawLog, errors, posted };
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
  //
  // This lone object is themeBuildables[0] — the "weapons rack" — which
  // buildSeededQueue excludes from the buildable queue until the player's
  // first rebirth (see main.js ~4468/7551). Seed rebirth_state.count = 1 so
  // the rack is buildable and an active crate is actually drawn each frame;
  // rebirth status is orthogonal to what this test asserts (crate ignores
  // per-object override but tracks the global object-scale slider).
  const runs: Record<string, number> = {};
  for (const [label, objectScale, overrides] of [
    ['globalOnly', 2, {}],
    ['withBigOverride', 2, { o1: 3 }], // legacy-absolute override, same global
    ['halfGlobal', 1, {}],
  ] as [string, number, Record<string, number>][]) {
    const h = await bootObjScaleHarness();
    h.dispatch(buildObjScaleThemePayload(objectScale, overrides, ['o1'], 1));
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

// ── H hides only DECOR via true canvas hover/drag targeting: buildable is a
// no-op ──────────────────────────────────────────────────────────────────
// The Edit-Stage H handler's target resolution (main.js ~6298-6321) is
// dragObjectId/dragObjectType (top priority) -> hoverSceneObjType/Id -> a
// HARDCODED "decor" fallback (unlike F, H has NO editFlipTargetKind branch —
// see the code comment there). That means the #se-obj/#se-decor dropdown
// steps above (6b/6c) can only ever drive H's decor-fallback tier; they can
// never make H resolve kind==="buildable". Reaching the buildable branch (and
// proving it's a no-op) requires the real DRAG tier: dragObjectId/
// dragObjectType, set directly by the canvas mousedown hit-test
// (sceneObjectAt), mirroring the F-flip step's fixture/postMessage/keydown
// pattern but driving the target through the canvas instead of a select.
//
// The fixture places o1 (buildable) and d1 (decor) at distinct anchor_coord
// positions, each paired with a decoy at a different anchor so
// themeBuildables/themeDecor don't trip the "all anchors equal -> auto
// slot-home" branch (main.js ~8462-8481 / ~8498-8524), which would otherwise
// replace the literal anchor_coord placement with an unpredictable
// auto-distributed slot. The walkable polygon is the (normalized) near-full
// canvas, so clampToPolygon/clampToSceneBounds are no-ops and each object's
// native position is exactly anchor_coord * walkableNativeW/H; nativeToCanvas
// then simplifies to bgX + anchor_coord[0]*bgW (walkableNativeW cancels).
// bgW/bgH are the fake 64x64 background image (sceneFitScale clamps to 1 on
// this harness's 1066x760 canvas), so bgX = floor((1066-64)/2) = 501.
test('H hides a dragged decor via true hover/drag targeting, but is a no-op while dragging a buildable', async () => {
  const h = await bootObjScaleHarness();
  h.dispatch({
    type: 'THEME_INITIALIZED',
    payload: {
      theme_id: 'h_target_fixture',
      manifest: {
        theme_id: 'h_target_fixture',
        viewport: {
          native_width: 1280,
          native_height: 720,
          walkable_nav_polygon: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]],
          crate_asset: 'frames.json#crate',
          poof_asset: 'frames.json#poof',
        },
        roster_agents: [],
        roster_rivals: [],
        buildable_objects: [
          { object_id: 'o1', display_name: 'Rack', build_order: 0, anchor_coord: [0.15, 0.5] },
          { object_id: 'o1b', display_name: 'Decoy', build_order: 1, anchor_coord: [0.5, 0.15] },
        ],
        decor_objects: [
          { decor_id: 'd1', display_name: 'Statue', anchor_coord: [0.85, 0.5] },
          { decor_id: 'd1b', display_name: 'Decoy', anchor_coord: [0.5, 0.85] },
        ],
        badges: [],
      },
      frames: {
        environment_background: ['data:h-target-fixture,bg'],
        crate: ['data:h-target-fixture,crate', 'data:h-target-fixture,crate'],
        poof: ['data:h-target-fixture,crate', 'data:h-target-fixture,crate'],
        object_o1: ['data:h-target-fixture,o1'],
        object_o1b: ['data:h-target-fixture,o1b'],
        decor_d1: ['data:h-target-fixture,d1'],
        decor_d1b: ['data:h-target-fixture,d1b'],
      },
      badges: [],
      unlocked_badge_ids: [],
      rebirth_state: { count: 1 },
    },
  });
  await h.flush();
  h.tick(3);
  assert.equal(h.errors.length, 0, `boot threw: ${h.errors.map(String).join('; ')}`);

  const editBtn = h.doc.getElementById('menu-edit-stage');
  assert.ok(editBtn, 'menu-edit-stage should have been injected');
  editBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  h.tick(1);

  const canvasEl = h.doc.getElementById('stage');
  const bgX = 501, bgY = 0, bgW = 64, bgH = 64;
  const buildableXY = [bgX + 0.15 * bgW, bgY + 0.5 * bgH]; // o1's exact drawn center
  const decorXY = [bgX + 0.85 * bgW, bgY + 0.5 * bgH]; // d1's exact drawn center

  // Drag o1 (buildable) and press H mid-drag: dragObjectId/dragObjectType
  // resolve kind==="buildable", which the H handler only ever acts on
  // `if (kind === "decor" && id)` — so this must be a strict no-op.
  canvasEl.dispatchEvent(
    new h.win.MouseEvent('mousedown', { bubbles: true, clientX: buildableXY[0], clientY: buildableXY[1] })
  );
  h.win.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
  h.win.dispatchEvent(new h.win.MouseEvent('mouseup', { bubbles: true }));

  const saveBtn = h.doc.getElementById('se-save');
  assert.ok(saveBtn, 'se-save button should exist');
  saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const afterBuildable = [...h.posted].reverse().find((m: any) => m.type === 'SAVE_STAGE_TUNING');
  assert.ok(afterBuildable, 'a SAVE_STAGE_TUNING message should have been posted');
  assert.ok(
    !Array.isArray(afterBuildable.payload.decor_hidden) || afterBuildable.payload.decor_hidden.length === 0,
    'H while dragging a buildable must not hide anything'
  );

  // Now drag d1 (decor) and press H mid-drag: dragObjectType/dragObjectId
  // resolve kind==="decor", so this DOES hide it.
  canvasEl.dispatchEvent(
    new h.win.MouseEvent('mousedown', { bubbles: true, clientX: decorXY[0], clientY: decorXY[1] })
  );
  h.win.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
  h.win.dispatchEvent(new h.win.MouseEvent('mouseup', { bubbles: true }));

  saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const afterDecor = [...h.posted].reverse().find((m: any) => m.type === 'SAVE_STAGE_TUNING');
  assert.ok(afterDecor, 'a second SAVE_STAGE_TUNING message should have been posted');
  assert.ok(
    Array.isArray(afterDecor.payload.decor_hidden) && afterDecor.payload.decor_hidden.includes('d1'),
    'H while dragging decor d1 should hide it'
  );

  // Press H again on the same drag/target -> un-hides it (mirrors 6c's undo
  // check), proving the toggle and the observable both work symmetrically.
  canvasEl.dispatchEvent(
    new h.win.MouseEvent('mousedown', { bubbles: true, clientX: decorXY[0], clientY: decorXY[1] })
  );
  h.win.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
  h.win.dispatchEvent(new h.win.MouseEvent('mouseup', { bubbles: true }));
  saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
  const afterUnhide = [...h.posted].reverse().find((m: any) => m.type === 'SAVE_STAGE_TUNING');
  assert.ok(afterUnhide, 'a third SAVE_STAGE_TUNING message should have been posted');
  assert.ok(
    !Array.isArray(afterUnhide.payload.decor_hidden) || !afterUnhide.payload.decor_hidden.includes('d1'),
    'pressing H again on d1 should un-hide it'
  );

  assert.equal(h.errors.length, 0, `hover/drag H-hotkey path threw: ${h.errors.map(String).join('; ')}`);
  h.win.close();
});

// ── Theme-plan generation form: per-slot name+description editors ──────────
// The Objects/Expressions/Achievement-badges fields on the theme-GENERATION
// form (pre-generation) changed from free-text comma textareas to per-slot
// name+description editors (renderPlanSlotsWithDesc, main.js ~2339), wired
// into renderThemePlan (~2399-2428) for objects (21 rows, slot 0 carries a
// weapons-rack lockedNote), expressions (8 rows, nameReadOnly, labels from
// THEME_PLAN_FIXED_EXPRESSION_LABELS ~2316), and achievements (25 rows). The
// render entry point is the "THEME_PLAN_READY" message handler (~7733-7738),
// which calls renderThemePlan(msg.payload.plan) — same as a real host
// response to PLAN_THEME. collectEditedThemePlan() (~2460) has no exported
// hook, so it's exercised indirectly via the real UI path: clicking
// #theme-start-generation-btn (~2542) calls it and, on success, posts
// GENERATE_THEME with the collected plan; on a thrown validation error it
// writes the message into #theme-plan-validation and posts nothing — mirrors
// how this file already asserts on posted SAVE_STAGE_TUNING/RESTORE_PLAN_
// BACKUP messages rather than reaching into main.js's private closures.
//
// bootObjScaleHarness() is reused here (not the giant Step 1-16 boot above):
// its scanElementIds()/tagForId() skeleton already stubs every id main.js
// calls getElementById() on, including all the theme-plan-* containers and
// the crate/poof textareas, so no bespoke DOM injection is needed.
const THEME_PLAN_EXPRESSION_LABELS = [
  'Love', 'Idea / discovery spark', 'Anger', 'Team action / rally',
  'Thumbs up', 'Music', 'Sleep / low-energy zzz', 'Dazed / hit',
];

function buildFullThemePlan(overrides: Record<string, any> = {}) {
  const base = {
    display_name: 'Neon Grove',
    creative_direction: 'Solarpunk playground with glowing flora',
    environment: 'A bioluminescent greenhouse city',
    characters: Array.from({ length: 16 }, (_, i) => `Char ${i + 1}`),
    character_descriptions: Array.from({ length: 16 }, (_, i) => `Char ${i + 1} appearance`),
    enemies: Array.from({ length: 4 }, (_, i) => `Enemy ${i + 1}`),
    enemy_descriptions: Array.from({ length: 4 }, (_, i) => `Enemy ${i + 1} appearance`),
    enemy_attack_styles: Array.from({ length: 4 }, () => 'melee'),
    decor: Array.from({ length: 9 }, (_, i) => `Decor ${i + 1}`),
    decor_descriptions: Array.from({ length: 9 }, (_, i) => `Decor ${i + 1} appearance`),
    objects: Array.from({ length: 21 }, (_, i) => `Object ${i + 1}`),
    object_descriptions: Array.from({ length: 21 }, (_, i) => `Object ${i + 1} appearance`),
    crate_description: 'A glowing seed pod crate',
    poof_description: 'A puff of spores',
    expressions: THEME_PLAN_EXPRESSION_LABELS.slice(),
    expression_descriptions: Array.from({ length: 8 }, (_, i) => `Expression ${i + 1} appearance`),
    achievements: Array.from({ length: 25 }, (_, i) => `Achievement ${i + 1}`),
    achievement_descriptions: Array.from({ length: 25 }, (_, i) => `Achievement ${i + 1} appearance`),
  };
  return { ...base, ...overrides };
}

function dispatchThemePlanReady(h: any, plan: Record<string, any>) {
  h.dispatch({ type: 'THEME_PLAN_READY', payload: { plan } });
}

test('theme-plan generation form: renders 21/8/25 per-slot rows, expression names read-only, object slot 0 carries the locked note', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan());
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const objectsContainer = h.doc.getElementById('theme-plan-objects-slots');
    const expressionsContainer = h.doc.getElementById('theme-plan-expressions-slots');
    const achievementsContainer = h.doc.getElementById('theme-plan-achievements-slots');
    assert.ok(objectsContainer, 'theme-plan-objects-slots should exist');
    assert.ok(expressionsContainer, 'theme-plan-expressions-slots should exist');
    assert.ok(achievementsContainer, 'theme-plan-achievements-slots should exist');

    const objectRows = objectsContainer.querySelectorAll('.theme-plan-slot-row');
    const expressionRows = expressionsContainer.querySelectorAll('.theme-plan-slot-row');
    const achievementRows = achievementsContainer.querySelectorAll('.theme-plan-slot-row');
    assert.equal(objectRows.length, 21, 'objects should render 21 per-slot rows');
    assert.equal(expressionRows.length, 8, 'expressions should render 8 per-slot rows');
    assert.equal(achievementRows.length, 25, 'achievements should render 25 per-slot rows');

    // Expression rows are name-READ-ONLY: renderPlanSlotsWithDesc's
    // nameReadOnly branch renders a plain <span class="theme-plan-slot-
    // name-readonly"> with NO data-plan-field attribute at all (only the
    // editable <input> branch sets data-plan-field="name") — so the
    // read-only element is found by its class, not by [data-plan-field].
    const expr0Name = expressionRows[0].querySelector('.theme-plan-slot-name-readonly');
    assert.ok(expr0Name, 'expression row 0 should show a read-only name span');
    assert.equal(expr0Name.tagName, 'SPAN', 'expression slot name should render as a read-only span');
    assert.equal(expr0Name.textContent, 'Love', 'expression slot 0 should show the fixed label "Love"');
    assert.equal(
      expressionRows[0].querySelector('input[data-plan-field="name"]'),
      null,
      'no editable name input should exist anywhere in a read-only expression row'
    );

    // Object slot 0 (index 0) shows the weapons-rack locked note; other slots don't.
    const objRow0Note = objectRows[0].querySelector('.theme-plan-slot-note');
    assert.ok(objRow0Note, 'object slot 0 should show a locked note');
    assert.match(objRow0Note.textContent || '', /weapons rack/i, 'object slot 0 note should mention the weapons rack');
    const objRow1Note = objectRows[1].querySelector('.theme-plan-slot-note');
    assert.equal(objRow1Note, null, 'object slot 1 should NOT show a locked note');
    const objRow20Note = objectRows[20].querySelector('.theme-plan-slot-note');
    assert.equal(objRow20Note, null, 'the last object slot should NOT show a locked note');
  } finally {
    h.win.close();
  }
});

test('theme-plan generation form: objects editor shows an Animated context line on the LAST 2 object slots only', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan());
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const objectsContainer = h.doc.getElementById('theme-plan-objects-slots');
    const objectRows = objectsContainer.querySelectorAll('.theme-plan-slot-row');
    assert.equal(objectRows.length, 21, 'objects should render 21 per-slot rows');

    // THEME_PLAN_OBJECT_COUNT - 2 = index 19: the last two slots (19 and 20 of
    // 21) get the 4-frame idle-loop call-out; an early slot (index 5) must not.
    const row5Ctx = objectRows[5].querySelector('.theme-plan-slot-context');
    assert.equal(row5Ctx, null, 'an early object slot (index 5) should NOT show the Animated context line');

    const row19Ctx = objectRows[19].querySelector('.theme-plan-slot-context');
    const row20Ctx = objectRows[20].querySelector('.theme-plan-slot-context');
    assert.ok(row19Ctx, 'object slot index 19 (the 20th of 21) should show a context line');
    assert.ok(row20Ctx, 'object slot index 20 (the last of 21) should show a context line');
    assert.match(row19Ctx.textContent || '', /Animated/i, 'slot 19 context should mention "Animated"');
    assert.match(row20Ctx.textContent || '', /Animated/i, 'slot 20 context should mention "Animated"');
    assert.match(row19Ctx.textContent || '', /4-frame idle loop/i, 'slot 19 context should mention the 4-frame idle loop');
    assert.match(row20Ctx.textContent || '', /4-frame idle loop/i, 'slot 20 context should mention the 4-frame idle loop');
  } finally {
    // try/finally (not a trailing call) so a failed assertion above still
    // closes the jsdom window — main.js schedules a real (unstubbed)
    // window.setInterval for the project-plan re-render ticker, and an
    // unclosed window leaves it firing forever, hanging the whole `node
    // --test` process well past this one test's failure.
    h.win.close();
  }
});

test('theme-plan generation form: collectEditedThemePlan (via Start generation) round-trips edited slots and posts full-count arrays', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan());
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const objectsContainer = h.doc.getElementById('theme-plan-objects-slots');
    const achievementsContainer = h.doc.getElementById('theme-plan-achievements-slots');
    const expressionsContainer = h.doc.getElementById('theme-plan-expressions-slots');

    // Edit a couple of rows in each per-slot editor plus the crate/poof
    // textareas, then read them back out of the posted GENERATE_THEME payload
    // to prove collectPlanSlotsWithDesc/collectEditedThemePlan read live DOM
    // state at the right index, not just the original THEME_PLAN_READY values.
    const objRow5 = objectsContainer.querySelectorAll('.theme-plan-slot-row')[5];
    (objRow5.querySelector('input[data-plan-field="name"]') as any).value = 'Edited Object Six';
    (objRow5.querySelector('[data-plan-field="desc"]') as any).value = 'Edited object six appearance';

    const achRow10 = achievementsContainer.querySelectorAll('.theme-plan-slot-row')[10];
    (achRow10.querySelector('input[data-plan-field="name"]') as any).value = 'Edited Achievement Eleven';
    (achRow10.querySelector('[data-plan-field="desc"]') as any).value = 'Edited achievement eleven appearance';

    const exprRow2Desc = expressionsContainer.querySelectorAll('.theme-plan-slot-row')[2].querySelector('[data-plan-field="desc"]');
    (exprRow2Desc as any).value = 'Edited expression three appearance';

    (h.doc.getElementById('theme-plan-crate-desc') as any).value = 'Edited crate description';
    (h.doc.getElementById('theme-plan-poof-desc') as any).value = 'Edited poof description';

    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    assert.equal(h.errors.length, 0, `Start-generation click threw: ${h.errors.map(String).join('; ')}`);

    const genMsg = [...h.posted].reverse().find((m: any) => m.type === 'GENERATE_THEME');
    assert.ok(genMsg, 'a valid plan should post GENERATE_THEME');
    const plan = genMsg.payload.plan;

    assert.equal(plan.objects.length, 21, 'collected objects should have 21 entries');
    assert.equal(plan.object_descriptions.length, 21, 'collected object_descriptions should have 21 entries');
    assert.equal(plan.objects[5], 'Edited Object Six', 'edited object name should round-trip at its index');
    assert.equal(plan.object_descriptions[5], 'Edited object six appearance', 'edited object description should round-trip at its index');

    // plan.expressions is built inside main.js's own vm-executed realm
    // (THEME_PLAN_FIXED_EXPRESSION_LABELS.slice()), so it's a different
    // Array constructor/prototype than an array literal in this test file —
    // assert.deepEqual (this file imports 'node:assert/strict', where
    // deepEqual aliases to deepStrictEqual) fails on that prototype mismatch
    // even though the string contents are identical. Compare length + each
    // primitive element instead, which is realm-agnostic.
    assert.equal(plan.expressions.length, 8, 'expressions must always have 8 entries');
    THEME_PLAN_EXPRESSION_LABELS.forEach((label, i) => {
      assert.equal(plan.expressions[i], label, `expressions[${i}] must always be the fixed label "${label}"`);
    });
    assert.equal(plan.expression_descriptions.length, 8, 'collected expression_descriptions should have 8 entries');
    assert.equal(plan.expression_descriptions[2], 'Edited expression three appearance', 'edited expression description should round-trip at its index');

    assert.equal(plan.achievements.length, 25, 'collected achievements should have 25 entries');
    assert.equal(plan.achievement_descriptions.length, 25, 'collected achievement_descriptions should have 25 entries');
    assert.equal(plan.achievements[10], 'Edited Achievement Eleven', 'edited achievement name should round-trip at its index');
    assert.equal(plan.achievement_descriptions[10], 'Edited achievement eleven appearance', 'edited achievement description should round-trip at its index');

    assert.equal(plan.crate_description, 'Edited crate description', 'edited crate description should round-trip');
    assert.equal(plan.poof_description, 'Edited poof description', 'edited poof description should round-trip');
  } finally {
    h.win.close();
  }
});

test('theme-plan generation form: projectile description field renders from plan.projectile_description and an edit round-trips via Start generation without dropping other fields', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan({ projectile_description: 'A crackling blue energy bolt' }));
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const projectileField = h.doc.getElementById('theme-plan-projectile-desc') as any;
    assert.ok(projectileField, 'theme-plan-projectile-desc should exist');
    assert.equal(
      projectileField.value,
      'A crackling blue energy bolt',
      'projectile description field should populate from plan.projectile_description'
    );

    projectileField.value = 'Edited projectile description';

    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    assert.equal(h.errors.length, 0, `Start-generation click threw: ${h.errors.map(String).join('; ')}`);

    const genMsg = [...h.posted].reverse().find((m: any) => m.type === 'GENERATE_THEME');
    assert.ok(genMsg, 'a valid plan should post GENERATE_THEME');
    const plan = genMsg.payload.plan;
    assert.equal(plan.projectile_description, 'Edited projectile description', 'edited projectile description should round-trip');
    // Sibling single-string fields and full-count arrays must not be dropped
    // by the collectEditedThemePlan spread/override.
    assert.equal(plan.crate_description, 'A glowing seed pod crate', 'crate description should be unaffected');
    assert.equal(plan.poof_description, 'A puff of spores', 'poof description should be unaffected');
    assert.equal(plan.objects.length, 21, 'objects should still have 21 entries');
    assert.equal(plan.object_descriptions.length, 21, 'object_descriptions should still have 21 entries');
  } finally {
    h.win.close();
  }
});

test('theme-plan generation form: an empty object name blocks generation with the current 21-count error, not the stale 13/16 count', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan());
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const objectsContainer = h.doc.getElementById('theme-plan-objects-slots');
    const objRow3 = objectsContainer.querySelectorAll('.theme-plan-slot-row')[3];
    (objRow3.querySelector('input[data-plan-field="name"]') as any).value = '';

    const generateCountBefore = h.posted.filter((m: any) => m.type === 'GENERATE_THEME').length;
    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    assert.equal(h.errors.length, 0, `Start-generation click threw: ${h.errors.map(String).join('; ')}`);

    const generateCountAfter = h.posted.filter((m: any) => m.type === 'GENERATE_THEME').length;
    assert.equal(generateCountAfter, generateCountBefore, 'no GENERATE_THEME should be posted when an object name is empty');

    const validationEl = h.doc.getElementById('theme-plan-validation');
    assert.ok(validationEl, 'theme-plan-validation should exist');
    assert.match(
      validationEl.textContent || '',
      /Objects needs all 21 named slots \(currently 20\)/,
      'validation message should use the current 21-slot count'
    );
    assert.doesNotMatch(
      validationEl.textContent || '',
      /\b(13|16)\b/,
      'validation message must not show the stale comma-count 13/16 figures'
    );
  } finally {
    h.win.close();
  }
});

// ── Theme-plan generation form: characters/enemies/decor parity ────────────
// Follow-up to the objects/expressions/achievements editors above: the same
// renderPlanSlotsWithDesc/collectPlanSlotsWithDesc machinery now also drives
// characters (16, editable name+desc), enemies (4, editable name+desc plus a
// melee/ranged attack-style <select>), and decor (9, editable name+desc,
// brand-new container #theme-plan-decor-slots — main.js ~1917/2443).

test('theme-plan generation form: characters/enemies/decor render 16/4/9 per-slot rows with attack-style + context-line parity', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan({
      enemy_attack_styles: ['melee', 'melee', 'ranged', 'melee'],
    }));
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const charactersContainer = h.doc.getElementById('theme-plan-characters');
    const enemiesContainer = h.doc.getElementById('theme-plan-enemies');
    const decorContainer = h.doc.getElementById('theme-plan-decor-slots');
    assert.ok(charactersContainer, 'theme-plan-characters should exist');
    assert.ok(enemiesContainer, 'theme-plan-enemies should exist');
    assert.ok(decorContainer, 'theme-plan-decor-slots should exist');

    const characterRows = charactersContainer.querySelectorAll('.theme-plan-slot-row');
    const enemyRows = enemiesContainer.querySelectorAll('.theme-plan-slot-row');
    const decorRows = decorContainer.querySelectorAll('.theme-plan-slot-row');
    assert.equal(characterRows.length, 16, 'characters should render 16 per-slot rows');
    assert.equal(enemyRows.length, 4, 'enemies should render 4 per-slot rows');
    assert.equal(decorRows.length, 9, 'decor should render 9 per-slot rows');

    characterRows.forEach((row: Element, i: number) => {
      const nameInput = row.querySelector('input[data-plan-field="name"]');
      const descTextarea = row.querySelector('textarea[data-plan-field="desc"]');
      assert.ok(nameInput, `character row ${i} should have a name input`);
      assert.ok(descTextarea, `character row ${i} should have a desc textarea`);
    });

    enemyRows.forEach((row: Element, i: number) => {
      const attackSelect = row.querySelector('select[data-plan-field="attack"]') as any;
      assert.ok(attackSelect, `enemy row ${i} should have an attack select`);
      const expected = i === 2 ? 'ranged' : 'melee';
      assert.equal(attackSelect.value, expected, `enemy row ${i} attack select should preselect "${expected}"`);
    });

    // Slot 0 is the leader's throne, 1-3 are the remaining seats, 4-7 are
    // static decor, and 8 is the single animated item (THEME_PLAN_DECOR_
    // SEAT_COUNT=4 / STATIC_COUNT=4, main.js ~2443-2453).
    const decor0Ctx = decorRows[0].querySelector('.theme-plan-slot-context');
    assert.ok(decor0Ctx, 'decor slot 0 should show a context line');
    assert.match(decor0Ctx.textContent || '', /Seat/, 'decor slot 0 context should mention "Seat"');
    assert.match(decor0Ctx.textContent || '', /Leader/, 'decor slot 0 context should mention "Leader"');
    const decor4Ctx = decorRows[4].querySelector('.theme-plan-slot-context');
    assert.ok(decor4Ctx, 'decor slot 4 should show a context line');
    assert.match(decor4Ctx.textContent || '', /Static decor/, 'decor slot 4 (first static) context should read "Static decor"');
    const decor8Ctx = decorRows[8].querySelector('.theme-plan-slot-context');
    assert.ok(decor8Ctx, 'decor slot 8 should show a context line');
    assert.match(decor8Ctx.textContent || '', /Animated/, 'decor slot 8 (last, animated) context should mention "Animated"');
  } finally {
    h.win.close();
  }
});

test('theme-plan generation form: characters/enemies/decor round-trip via Start generation without dropping other plan fields', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan({ object_motion_hints: ['drift-slow', 'bob'] }));
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const charactersContainer = h.doc.getElementById('theme-plan-characters');
    const enemiesContainer = h.doc.getElementById('theme-plan-enemies');
    const decorContainer = h.doc.getElementById('theme-plan-decor-slots');

    const charRow7 = charactersContainer.querySelectorAll('.theme-plan-slot-row')[7];
    (charRow7.querySelector('input[data-plan-field="name"]') as any).value = 'Edited Character Eight';
    (charRow7.querySelector('[data-plan-field="desc"]') as any).value = 'Edited character eight appearance';

    const enemyRow1 = enemiesContainer.querySelectorAll('.theme-plan-slot-row')[1];
    (enemyRow1.querySelector('input[data-plan-field="name"]') as any).value = 'Edited Enemy Two';
    (enemyRow1.querySelector('[data-plan-field="desc"]') as any).value = 'Edited enemy two appearance';
    const enemyAttackSelect = enemyRow1.querySelector('select[data-plan-field="attack"]') as any;
    enemyAttackSelect.value = 'ranged';
    enemyAttackSelect.dispatchEvent(new h.win.Event('change', { bubbles: true }));

    const decorRow4 = decorContainer.querySelectorAll('.theme-plan-slot-row')[4];
    (decorRow4.querySelector('input[data-plan-field="name"]') as any).value = 'Edited Decor Five';
    (decorRow4.querySelector('[data-plan-field="desc"]') as any).value = 'Edited decor five appearance';

    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    assert.equal(h.errors.length, 0, `Start-generation click threw: ${h.errors.map(String).join('; ')}`);

    const genMsg = [...h.posted].reverse().find((m: any) => m.type === 'GENERATE_THEME');
    assert.ok(genMsg, 'a valid plan should post GENERATE_THEME');
    const plan = genMsg.payload.plan;

    assert.equal(plan.characters.length, 16, 'collected characters should have 16 entries');
    assert.equal(plan.character_descriptions.length, 16, 'collected character_descriptions should have 16 entries');
    assert.equal(plan.characters[7], 'Edited Character Eight', 'edited character name should round-trip at its index');
    assert.equal(plan.character_descriptions[7], 'Edited character eight appearance', 'edited character description should round-trip at its index');

    assert.equal(plan.enemies.length, 4, 'collected enemies should have 4 entries');
    assert.equal(plan.enemy_descriptions.length, 4, 'collected enemy_descriptions should have 4 entries');
    assert.equal(plan.enemy_attack_styles.length, 4, 'collected enemy_attack_styles should have 4 entries');
    assert.equal(plan.enemies[1], 'Edited Enemy Two', 'edited enemy name should round-trip at its index');
    assert.equal(plan.enemy_descriptions[1], 'Edited enemy two appearance', 'edited enemy description should round-trip at its index');
    assert.equal(plan.enemy_attack_styles[1], 'ranged', 'edited enemy attack style should round-trip at its index');

    assert.equal(plan.decor.length, 9, 'collected decor should have 9 entries');
    assert.equal(plan.decor_descriptions.length, 9, 'collected decor_descriptions should have 9 entries');
    assert.equal(plan.decor[4], 'Edited Decor Five', 'edited decor name should round-trip at its index');
    assert.equal(plan.decor_descriptions[4], 'Edited decor five appearance', 'edited decor description should round-trip at its index');

    // collectEditedThemePlan spreads ...currentThemePlan before overriding
    // only the fields it explicitly collects (main.js ~2559-2580), so an
    // unrelated pre-existing plan field, and an untouched form field like
    // environment, must survive the round-trip rather than being dropped.
    assert.deepEqual(plan.object_motion_hints, ['drift-slow', 'bob'], 'unrelated pre-existing plan fields must not be dropped');
    assert.equal(plan.environment, 'A bioluminescent greenhouse city', 'environment field must survive the round-trip');
  } finally {
    h.win.close();
  }
});

test('theme-plan generation form: an empty character name blocks generation with a 16-count error', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan());
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const charactersContainer = h.doc.getElementById('theme-plan-characters');
    const charRow9 = charactersContainer.querySelectorAll('.theme-plan-slot-row')[9];
    (charRow9.querySelector('input[data-plan-field="name"]') as any).value = '';

    const generateCountBefore = h.posted.filter((m: any) => m.type === 'GENERATE_THEME').length;
    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    assert.equal(h.errors.length, 0, `Start-generation click threw: ${h.errors.map(String).join('; ')}`);

    const generateCountAfter = h.posted.filter((m: any) => m.type === 'GENERATE_THEME').length;
    assert.equal(generateCountAfter, generateCountBefore, 'no GENERATE_THEME should be posted when a character name is empty');

    const validationEl = h.doc.getElementById('theme-plan-validation');
    assert.ok(validationEl, 'theme-plan-validation should exist');
    assert.match(
      validationEl.textContent || '',
      /Characters needs all 16 filled slots \(currently 15\)/,
      'validation message should use the 16-slot character count'
    );
  } finally {
    h.win.close();
  }
});

test('theme-plan generation form: an empty decor name blocks generation with a 9-count error', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchThemePlanReady(h, buildFullThemePlan());
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_PLAN_READY threw: ${h.errors.map(String).join('; ')}`);

    const decorContainer = h.doc.getElementById('theme-plan-decor-slots');
    const decorRow2 = decorContainer.querySelectorAll('.theme-plan-slot-row')[2];
    (decorRow2.querySelector('input[data-plan-field="name"]') as any).value = '';

    const generateCountBefore = h.posted.filter((m: any) => m.type === 'GENERATE_THEME').length;
    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    assert.equal(h.errors.length, 0, `Start-generation click threw: ${h.errors.map(String).join('; ')}`);

    const generateCountAfter = h.posted.filter((m: any) => m.type === 'GENERATE_THEME').length;
    assert.equal(generateCountAfter, generateCountBefore, 'no GENERATE_THEME should be posted when a decor name is empty');

    const validationEl = h.doc.getElementById('theme-plan-validation');
    assert.ok(validationEl, 'theme-plan-validation should exist');
    assert.match(
      validationEl.textContent || '',
      /Decor needs all 9 named slots \(currently 8\)/,
      'validation message should use the 9-slot decor count'
    );
  } finally {
    h.win.close();
  }
});

// ── Creative Direction editor (post-generation) + removed "Advanced" mode UI ──
// New in this release: buildThemeReviewCreativeDirectionSection renders once,
// as a dedicated ALWAYS-VISIBLE panel at the TOP of the review list — the
// first child of #theme-image-review-list, appended before any board card —
// sourced from THEME_IMAGE_REVIEW's `creative_direction` field (see
// src/host/vscode/panel.ts's THEME_IMAGE_REVIEW payload +
// themeService.updateThemeCreativeDirection). It is no longer nested inside
// the environment/background board card. Saving posts
// SET_THEME_CREATIVE_DIRECTION, handled by applyThemeCreativeDirectionResult
// on the THEME_CREATIVE_DIRECTION_RESULT reply. At the same time, the
// per-board "Advanced — write the full prompt myself" custom-mode <select>
// plus the read-only "View generation prompt" / "Copy prompt" block were
// removed from the retry row entirely — the single Retry/Generate button now
// computes mode itself (retry/augment, or 'custom' only for a blocked item's
// recovery flow).
test('THEME_IMAGE_REVIEW: renders the Creative Direction editor prefilled from the payload, and the removed Advanced/mode-select UI is gone', async () => {
  const h = await bootObjScaleHarness();
  try {
    const items = [
      {
        id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
        status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
      },
      {
        id: 'objects_01', filename: 'objects_01.png', label: 'Objects 1', kind: 'object_atlas',
        status: 'pending', prompt: 'A base objects prompt.', revision: 0, frame_keys: [], updated_at: '',
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'smoke_theme',
        display_name: 'Smoke Theme',
        items,
        creative_direction: 'a moody neon skyline over a rain-slicked outpost',
      },
    });
    h.tick(2);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_IMAGE_REVIEW threw: ${h.errors.map(String).join('; ')}`);

    const list = h.doc.getElementById('theme-image-review-list');
    assert.ok(list, 'theme-image-review-list should exist');

    // (1) Creative Direction editor renders as a dedicated panel at the TOP
    // of the review list — the first child, before any board card — and is
    // prefilled from the payload.
    const firstChild = list.firstElementChild;
    assert.ok(firstChild, 'theme-image-review-list should have a first child');
    assert.ok(
      firstChild.classList.contains('theme-review-creative-direction-panel'),
      'the Creative Direction panel should be the first child of theme-image-review-list'
    );
    const textarea = list.querySelector('.theme-review-creative-direction-input');
    assert.ok(textarea, 'Creative Direction textarea should render at the top of the review list');
    assert.equal(textarea.value, 'a moody neon skyline over a rain-slicked outpost');
    // It must be immediately visible, not tucked inside a collapsed
    // <details> — unlike the old environment-card placement.
    assert.equal(textarea.closest('details'), null, 'the Creative Direction editor should not be nested inside a collapsible <details>');
    const saveBtn = list.querySelector('.theme-review-creative-direction-save');
    assert.ok(saveBtn, 'Save creative direction button should render');

    // Only ONE Creative Direction editor across the whole list — it renders
    // exactly once regardless of item count/kind, never once per board.
    assert.equal(
      list.querySelectorAll('.theme-review-creative-direction-input').length,
      1,
      'exactly one Creative Direction editor should render, not one per board'
    );

    // Saving posts SET_THEME_CREATIVE_DIRECTION with the theme id + trimmed text.
    saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    const posted = [...h.posted].reverse().find((m: any) => m.type === 'SET_THEME_CREATIVE_DIRECTION');
    assert.ok(posted, 'clicking Save should post SET_THEME_CREATIVE_DIRECTION');
    // Compare fields individually rather than via assert.deepEqual on the
    // whole object: `posted` is a message object constructed inside the
    // jsdom vm context (a different V8 realm), whose Object.prototype is not
    // reference-equal to this file's — deepStrictEqual's prototype check
    // fails on that even when every own-property value is identical.
    assert.equal(posted.payload.theme_id, 'smoke_theme');
    assert.equal(posted.payload.creative_direction, 'a moody neon skyline over a rain-slicked outpost');
    assert.equal(Object.keys(posted.payload).length, 2, 'payload should carry only theme_id + creative_direction');

    // The THEME_CREATIVE_DIRECTION_RESULT reply re-enables the editor and
    // shows a confirmation, without throwing.
    h.dispatch({
      type: 'THEME_CREATIVE_DIRECTION_RESULT',
      payload: { ok: true, theme_id: 'smoke_theme', creative_direction: 'a moody neon skyline over a rain-slicked outpost' },
    });
    h.tick(1);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_CREATIVE_DIRECTION_RESULT threw: ${h.errors.map(String).join('; ')}`);
    assert.equal(saveBtn.disabled, false, 'Save button should re-enable after the result reply');

    // (2) The removed "Advanced — write the full prompt myself" mode UI is gone.
    const listText = list.textContent || '';
    assert.doesNotMatch(listText, /write the full prompt myself/i);
    assert.doesNotMatch(listText, /View generation prompt/i);
    assert.doesNotMatch(listText, /Copy prompt/i);
    assert.equal(list.querySelectorAll('select').length, 0, 'no <select> (the removed per-board mode dropdown) should render in the review list');

    assert.equal(h.errors.length, 0, `errors after the full flow: ${h.errors.map(String).join('; ')}`);
  } finally {
    h.win.close();
  }
});

// ── Review "Names & descriptions" editor: projectile description row ────────
// New: the background_decor board's post-generation review editor
// (themeReviewDescriptionRows in media/main.js) now carries a describe-only
// "Ranged projectile (required)" row — like crate/poof on object board 2, it
// has no decor_id and is never renamed, only described (plan.projectile_description,
// see applyThemeItemDescriptionChanges' 'projectile' branch in
// src/extension/themeService.ts). This exercises the actual DOM row build
// (buildThemeReviewNamesDescriptionsSection) rather than just the pure
// row-builder, since no existing test yet drives that editor's rendering.
test('THEME_IMAGE_REVIEW: background_decor board renders a prefilled "Ranged projectile" description row, and editing + Apply posts SET_THEME_ITEM_DESCRIPTIONS with an item_kind:"projectile" change', async () => {
  const h = await bootObjScaleHarness();
  try {
    const items = [
      {
        id: 'background_decor', filename: 'background_decor.png', label: 'Background decor', kind: 'background_decor_atlas',
        status: 'pending', prompt: 'A base decor prompt.', revision: 0, frame_keys: [], updated_at: '',
        decor_rows: [],
        projectile_description: 'A crackling blue energy bolt',
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'smoke_theme',
        display_name: 'Smoke Theme',
        items,
        creative_direction: 'a moody neon skyline over a rain-slicked outpost',
      },
    });
    h.tick(2);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_IMAGE_REVIEW threw: ${h.errors.map(String).join('; ')}`);

    const list = h.doc.getElementById('theme-image-review-list');
    assert.ok(list, 'theme-image-review-list should exist');

    // (1) The row renders, labeled "Ranged projectile (required)", prefilled
    // from item.projectile_description.
    const textarea = list.querySelector('textarea[data-item-kind="projectile"]');
    assert.ok(textarea, 'a description textarea for item_kind "projectile" should render');
    assert.equal(textarea.dataset.rowId, 'projectile');
    assert.equal(textarea.value, 'A crackling blue energy bolt', 'the textarea should be prefilled from item.projectile_description');
    const rowEl = textarea.closest('.theme-review-names-descriptions-row');
    assert.ok(rowEl, 'the textarea should sit inside a names-descriptions row');
    const labelEl = rowEl.querySelector('.theme-review-names-descriptions-label');
    assert.ok(labelEl, 'the row should have a label');
    assert.equal(labelEl.textContent, 'Ranged projectile (required)');

    // (2) Editing the textarea and clicking Apply posts SET_THEME_ITEM_DESCRIPTIONS
    // with a change entry for item_kind "projectile".
    textarea.value = 'A rewritten violet plasma bolt.';
    textarea.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const applyBtn = list.querySelector('.theme-review-names-descriptions-apply');
    assert.ok(applyBtn, 'the Apply button should render');
    assert.equal(applyBtn.disabled, false, 'Apply should be enabled once the projectile description is dirty');
    applyBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

    const posted = [...h.posted].reverse().find((m: any) => m.type === 'SET_THEME_ITEM_DESCRIPTIONS');
    assert.ok(posted, 'clicking Apply should post SET_THEME_ITEM_DESCRIPTIONS');
    // Per-field asserts (not deepEqual) — posted is constructed inside the
    // jsdom vm realm, whose Object/Array prototypes are not reference-equal
    // to this file's, so deepStrictEqual's prototype check fails spuriously.
    assert.equal(posted.payload.theme_id, 'smoke_theme');
    assert.equal(posted.payload.board_id, 'background_decor');
    const change = posted.payload.changes.find((c: any) => c.item_kind === 'projectile');
    assert.ok(change, 'the posted changes should include a projectile entry');
    assert.equal(change.id, 'projectile');
    assert.equal(change.description, 'A rewritten violet plasma bolt.');

    assert.equal(h.errors.length, 0, `errors after the full flow: ${h.errors.map(String).join('; ')}`);
  } finally {
    h.win.close();
  }
});

// ── Metrics tab Session/All-time scope toggle (0.0.528) ─────────────────────
// panel.ts's static HTML for the toggle radios lives at ~L8981-8990 inside
// _getHtmlForWebview's template literal (id="metrics-scope-toggle", two
// .model-radio labels) with the caption div (#metrics-scope-caption) right
// after at ~L8991, and the #metrics-col-tokens <th> at ~L9001. Since feedback
// issue #26, that header's visible textContent is the fixed short form
// "Tokens*" in both scopes; the scope-dependent explanation moved to the
// `title` and `aria-label` attributes (media/main.js ~L338-347). All of the
// actual scope SWITCHING behavior these tests exercise — updateMetricsScopeUI(),
// currentScopeMetrics(), setMetricsScope() — lives in media/main.js
// (~L299-374), which is what these tests boot and drive.
test('Metrics tab scope toggle: default scope is "all" on first render, before any state is ever received', async () => {
  const h = await bootObjScaleHarness();
  try {
    // No dispatch yet — main.js's own module-init call to updateMetricsScopeUI()
    // (media/main.js ~374) must already reflect metricsScope's "all" default.
    const allEl = h.doc.getElementById('metrics-scope-all');
    const sessionEl = h.doc.getElementById('metrics-scope-session');
    assert.ok(allEl && sessionEl, 'both scope radios should exist in the skeleton');
    assert.equal(allEl.checked, true, 'the "All time" radio must be checked by default');
    assert.ok(!sessionEl.checked, 'the "This session" radio must NOT be checked by default');
    const tokensHeader = h.doc.getElementById('metrics-col-tokens');
    assert.ok(tokensHeader, 'the tokens column header should exist');
    assert.equal(tokensHeader.textContent, 'Tokens*', 'header text is now the short "Tokens*" form in both scopes');
    assert.equal(
      tokensHeader.title,
      'Tokens used all time. Total tokens this agent has used since the last metrics reset (all time).',
      'default title must explain the "all time" scope'
    );
    assert.equal(
      tokensHeader.getAttribute('aria-label'),
      'Tokens used all time',
      'default aria-label must state the "all time" scope'
    );
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);
  } finally {
    h.win.close();
  }
});

test('Metrics tab scope toggle: token column header and scope caption change between "This session" and "All time", both non-empty', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        workers: {},
        agentMetrics: [{ id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', tokens: 3500, activeMs: 60000 }],
      },
      sessionMetrics: {
        available: true,
        sessionId: 'S2',
        agentMetrics: [{ id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', tokens: 2500, activeMs: 40000 }],
      },
    });
    await h.flush();
    assert.equal(h.errors.length, 0, `post-dispatch errors: ${h.errors.map(String).join('; ')}`);

    const tokensHeader = h.doc.getElementById('metrics-col-tokens');
    const caption = h.doc.getElementById('metrics-scope-caption');
    const allEl = h.doc.getElementById('metrics-scope-all');
    const sessionEl = h.doc.getElementById('metrics-scope-session');

    // Still "all" (default) right after this dispatch — nobody toggled yet.
    // Visible textContent is now the scope-invariant "Tokens*" short form, so
    // scope is pinned via the title/aria-label instead (the tooltip the
    // asterisk points to).
    assert.equal(tokensHeader.textContent, 'Tokens*');
    assert.match(tokensHeader.title, /all time/i, 'title must explain the "all time" scope');
    assert.equal(tokensHeader.getAttribute('aria-label'), 'Tokens used all time');
    assert.ok(caption.textContent && caption.textContent.length > 0, 'caption must be non-empty while scope is "all"');
    assert.match(caption.textContent, /all time/i);

    // Switch to "This session" the same way a user click would: check the
    // radio, then fire the 'change' event main.js listens for (media/main.js
    // ~L363-367).
    sessionEl.checked = true;
    sessionEl.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();
    assert.equal(h.errors.length, 0, `errors after switching to session scope: ${h.errors.map(String).join('; ')}`);

    assert.equal(tokensHeader.textContent, 'Tokens*', 'header text stays the short "Tokens*" form after switching scope');
    assert.match(
      tokensHeader.title,
      /this session/i,
      'title must switch to explain the "this session" scope when "This session" is selected'
    );
    assert.equal(
      tokensHeader.getAttribute('aria-label'),
      'Tokens used this session',
      'aria-label must switch when "This session" is selected'
    );
    assert.ok(caption.textContent && caption.textContent.length > 0, 'caption must be non-empty while scope is "session"');
    assert.match(caption.textContent, /this session/i);
    assert.match(caption.textContent, /S2/, 'the session caption should state the actual sessionId');

    // Switch back to "All time".
    allEl.checked = true;
    allEl.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();
    assert.equal(tokensHeader.textContent, 'Tokens*', 'header text stays the short "Tokens*" form after switching back');
    assert.match(tokensHeader.title, /all time/i, 'title must switch back to explain the "all time" scope');
    assert.equal(
      tokensHeader.getAttribute('aria-label'),
      'Tokens used all time',
      'aria-label must switch back when "All time" is selected'
    );
    assert.ok(caption.textContent && caption.textContent.length > 0, 'caption must be non-empty again after switching back to "all"');
    assert.match(caption.textContent, /all time/i);
    assert.equal(h.errors.length, 0, `errors after switching back to all-time scope: ${h.errors.map(String).join('; ')}`);
  } finally {
    h.win.close();
  }
});

test('Delegation tab caption states its figures are all-time, with no Session/All-time toggle of its own', async () => {
  const h = await bootObjScaleHarness();
  try {
    // A non-orchestrator agent with tokens > 0 makes delegationStatsHasData
    // true (media/main.js renderDelegationStats, ~L13416-13419), which is
    // what gates the Delegation tab button being offered at all.
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        workers: {},
        agentMetrics: [{ id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', tokens: 4000, activeMs: 90000, taskCount: 2 }],
      },
    });
    await h.flush();
    assert.equal(h.errors.length, 0, `post-dispatch errors: ${h.errors.map(String).join('; ')}`);

    const delegationTabBtn = h.doc.getElementById('delegation-tab-btn');
    assert.ok(delegationTabBtn, 'the Delegation tab button should exist');
    delegationTabBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();
    assert.equal(h.errors.length, 0, `errors after opening the Delegation tab: ${h.errors.map(String).join('; ')}`);

    const delegationBody = h.doc.getElementById('delegation-stats');
    assert.ok(delegationBody, 'delegation-stats body should exist');
    const scopeCaption = delegationBody.querySelector('.delegation-stats-caption');
    assert.ok(scopeCaption, 'the Delegation tab must render a scope caption');
    assert.ok(scopeCaption.textContent && scopeCaption.textContent.length > 0, 'the caption must be non-empty');
    assert.match(scopeCaption.textContent, /all time/i, 'the caption must state its figures are all-time');
    assert.doesNotMatch(
      (scopeCaption.textContent || '').toLowerCase(),
      /this session only/,
      'the Delegation tab has no session/all-time toggle of its own -- its caption must not claim to be session-scoped'
    );
  } finally {
    h.win.close();
  }
});

// Delegation compliance line ("Orchestrator ran N% of tool calls directly").
// toolCompliance rides as a SIBLING of `state` on the posted message (see
// panel.ts's _postStateUpdate: `{ type: MSG.STATE, state, ..., toolCompliance }`),
// matching how sessionMetrics/delegationHealth are already attached — so
// every dispatch below sets it at the top level, not nested under `state`.
function dispatchDelegationCompliancePayload(h: any, toolCompliance: unknown) {
  h.dispatch({
    type: 'state',
    state: {
      sessionActive: true,
      completedTasks: 1,
      workers: {},
      // A non-orchestrator agent with tokens > 0 so delegationStatsHasData is
      // true and the Delegation tab actually renders (see the "all-time
      // caption" test above for the same gating requirement).
      agentMetrics: [{ id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', tokens: 4000, activeMs: 90000, taskCount: 2 }],
    },
    toolCompliance,
  });
}

function openDelegationTab(h: any) {
  const delegationTabBtn = h.doc.getElementById('delegation-tab-btn');
  assert.ok(delegationTabBtn, 'the Delegation tab button should exist');
  delegationTabBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
}

test('Delegation compliance: 60% direct share renders the red/bad line and the sub-caption', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchDelegationCompliancePayload(h, { orchestratorDirectCalls: 60, workerToolCalls: 40 });
    await h.flush();
    assert.equal(h.errors.length, 0, `post-dispatch errors: ${h.errors.map(String).join('; ')}`);
    openDelegationTab(h);
    await h.flush();

    const delegationBody = h.doc.getElementById('delegation-stats');
    const line = delegationBody.querySelector('.delegation-compliance-line');
    assert.ok(line, 'the compliance line must render (100 total calls >= 20 threshold)');
    assert.match(line.textContent, /Orchestrator ran 60% of tool calls directly \(60 of 100\)\./);
    assert.ok(line.classList.contains('hook-bad'), 'over 50% must use the red/bad style');
    assert.ok(!line.classList.contains('hook-warn'), 'must not ALSO carry the yellow/warn style');

    const caption = [...delegationBody.querySelectorAll('.delegation-stats-caption')].find((c: any) =>
      /doctrine and keyword routing/i.test(c.textContent || '')
    );
    assert.ok(caption, 'the high-share sub-caption must render below the bad/warn line');
  } finally {
    h.win.close();
  }
});

test('Delegation compliance: 10% direct share renders without warn/bad class and without the sub-caption', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchDelegationCompliancePayload(h, { orchestratorDirectCalls: 10, workerToolCalls: 90 });
    await h.flush();
    openDelegationTab(h);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const delegationBody = h.doc.getElementById('delegation-stats');
    const line = delegationBody.querySelector('.delegation-compliance-line');
    assert.ok(line, 'the compliance line must render (100 total calls >= 20 threshold)');
    assert.match(line.textContent, /Orchestrator ran 10% of tool calls directly \(10 of 100\)\./);
    assert.ok(!line.classList.contains('hook-warn'), 'under 25% must not carry the yellow/warn style');
    assert.ok(!line.classList.contains('hook-bad'), 'under 25% must not carry the red/bad style');

    const caption = [...delegationBody.querySelectorAll('.delegation-stats-caption')].find((c: any) =>
      /doctrine and keyword routing/i.test(c.textContent || '')
    );
    assert.ok(!caption, 'the sub-caption must be absent below the compliance threshold');
  } finally {
    h.win.close();
  }
});

test('Delegation compliance: fewer than 20 total calls -> the line is absent entirely', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchDelegationCompliancePayload(h, { orchestratorDirectCalls: 15, workerToolCalls: 4 }); // 19 total
    await h.flush();
    openDelegationTab(h);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const delegationBody = h.doc.getElementById('delegation-stats');
    const line = delegationBody.querySelector('.delegation-compliance-line');
    assert.ok(!line, '19 total calls is below the 20-call noise threshold -- nothing should render');
  } finally {
    h.win.close();
  }
});

test('Delegation compliance: zero totals (or toolCompliance absent) -> nothing renders, no NaN anywhere in the panel', async () => {
  const h = await bootObjScaleHarness();
  try {
    dispatchDelegationCompliancePayload(h, { orchestratorDirectCalls: 0, workerToolCalls: 0 });
    await h.flush();
    openDelegationTab(h);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    let delegationBody = h.doc.getElementById('delegation-stats');
    let line = delegationBody.querySelector('.delegation-compliance-line');
    assert.ok(!line, 'zero total calls -> no compliance line');
    assert.doesNotMatch(delegationBody.innerHTML, /NaN/, 'panel HTML must never contain a literal NaN');

    // toolCompliance omitted entirely (undefined) -- same as panel.ts's
    // "no project folder open" case -- must also render nothing, not throw.
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        workers: {},
        agentMetrics: [{ id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', tokens: 4000, activeMs: 90000, taskCount: 2 }],
      },
    });
    await h.flush();
    assert.equal(h.errors.length, 0, `errors after omitted toolCompliance: ${h.errors.map(String).join('; ')}`);

    delegationBody = h.doc.getElementById('delegation-stats');
    line = delegationBody.querySelector('.delegation-compliance-line');
    assert.ok(!line, 'toolCompliance undefined -> no compliance line, no crash');
    assert.doesNotMatch(delegationBody.innerHTML, /NaN/, 'panel HTML must never contain a literal NaN');
  } finally {
    h.win.close();
  }
});
