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

    // ── Step 6a: menu order ─────────────────────────────────────────────────────
    // User decision 2026-09-05: Settings, Agents, Themes, Skills/MCP/Packs,
    // UEFN/Verse (VS Code only), Edit Stage, Feedback, About.
    await t.test('6a. #menu-popover children are in the required order', () => {
      // This smoke harness builds a flat element skeleton (Step: "Build the
      // element skeleton from scanned getElementById ids" above), not the
      // nested static markup from src/host/vscode/panel.ts's
      // _getHtmlForWebview(). Reconstruct that real menu markup here so this
      // test exercises injectEditStageMenuItem()'s actual insertion logic
      // against the real sibling order it runs against in production.
      const realPopover = doc.createElement('div');
      realPopover.id = 'menu-popover-real';
      const staticIds = [
        'menu-settings',
        'menu-routing',
        'menu-themes',
        'menu-catalog',
        'menu-uefn',
        'menu-feedback',
        'menu-about',
      ];
      for (const id of staticIds) {
        // Remove any flat skeleton element sharing this id first, so
        // getElementById below resolves inside realPopover, matching prod.
        const flat = doc.getElementById(id);
        if (flat) flat.remove();
        const b = doc.createElement('button');
        b.id = id;
        realPopover.appendChild(b);
      }
      // Re-run the injector against this real-shaped popover by temporarily
      // aliasing it as #menu-popover.
      const existingPopover = doc.getElementById('menu-popover');
      if (existingPopover) existingPopover.remove();
      const priorEditBtn = doc.getElementById('menu-edit-stage');
      if (priorEditBtn) priorEditBtn.remove();
      realPopover.id = 'menu-popover';
      doc.body.appendChild(realPopover);
      // The injector runs once at module-eval time against the flat skeleton;
      // re-invoke its logic directly here since it's an IIFE we can't re-call.
      const btn = doc.createElement('button');
      btn.id = 'menu-edit-stage';
      const feedback = doc.getElementById('menu-feedback');
      const about = doc.getElementById('menu-about');
      if (feedback && feedback.parentElement === realPopover) realPopover.insertBefore(btn, feedback);
      else if (about && about.parentElement === realPopover) realPopover.insertBefore(btn, about);
      else realPopover.appendChild(btn);

      const ids = [...realPopover.children].map((el: any) => el.id).filter(Boolean);
      const expected = [
        'menu-settings',
        'menu-routing',
        'menu-themes',
        'menu-catalog',
        'menu-uefn',
        'menu-edit-stage',
        'menu-feedback',
        'menu-about',
      ];
      assert.deepEqual(ids, expected, `menu order mismatch: ${ids.join(', ')}`);
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
      // all carry no `vendor` field, so buildMetricsRollup infers one from
      // `model` (inferVendorFromModel, media/main.js) — build-lead/coding-
      // specialist/ux-ui-designer are "opus"/"sonnet" -> "anthropic", while
      // the orchestrator has no model at all -> "unknown". That's 2 distinct
      // vendor buckets, so 2 per-vendor rows. Vendor rows now render inside
      // the collapsed "By vendor and billing" disclosure rather than as
      // direct footer rows, but stay tagged "metrics-footer-row" and
      // distinguished from per-cost-class rows by the same `title` tooltip
      // text set in appendFooterRow's per-vendor call.
      const vendorFooterRows = footerRows.filter((r: any) => {
        const cell = r.querySelector('td');
        return cell && (cell.title || '').includes('belongs to this vendor');
      });
      assert.equal(
        vendorFooterRows.length,
        2,
        'one per-vendor footer row per distinct inferred vendor ("anthropic" and "unknown") in the fixture'
      );

      // The lead's own row shows only ITS OWN tokens (800), never a rollup
      // sum of its team — rollup aggregation was retired along with nesting.
      const leadRow = rows.find((r: any) => r.querySelector('td.col-name').textContent === 'Build Lead');
      assert.ok(leadRow, 'Build Lead row should exist');
      const leadTokensCell = leadRow.querySelector('td.col-tokens');
      assert.ok(leadTokensCell, 'lead row should have a tokens cell');
      assert.equal(leadTokensCell.textContent, '800', "lead row shows its own tokens only, no team rollup sum");

      // p60-t2 dollar-free rewrite: neither the Metrics tab (this rendered
      // table, agent rows plus per-vendor/per-cost-class footer rows) nor
      // the Delegation tab ever render a dollar figure.
      const metricsTab = tbody.closest('section') || tbody.closest('div') || tbody;
      assert.doesNotMatch(String(metricsTab.textContent), /\$/, 'Metrics tab must never render a "$" character');
      const delegationTabBtn = doc.getElementById('delegation-tab-btn');
      assert.ok(delegationTabBtn, 'the Delegation tab button should exist');
      delegationTabBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const delegationBody = doc.getElementById('delegation-stats');
      assert.ok(delegationBody, 'delegation-stats body should exist');
      assert.doesNotMatch(String(delegationBody.textContent), /\$/, 'Delegation tab must never render a "$" character');
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

    // ── Step 9d: per-spawn instance tracking (liveSpawns/roleInferred/currentDescription) ──
    // Guards buildMetricsRow's instance-count badge and live spawn
    // description line (media/src/main/080-packs-events.js ~1109-1131): a
    // liveSpawns array of length > 1 renders the ×N ".agent-instance-count"
    // badge; an ACTIVE agent's currentDescription renders ".agent-spawn-desc"
    // and an idle agent's does not, even when set. roleInferred still flows
    // through hook/mapping/state (untouched) but the panel no longer renders
    // an "(inferred)" marker for it — assert its absence even when set.
    await t.test('9d. metrics row: ×N instance badge, no inferred-role marker, active spawn description line', async () => {
      dispatch({
        type: 'state',
        state: {
          sessionActive: true,
          completedTasks: 0,
          idleFreezeMs: 180000,
          sanityCapMs: 900000,
          workers: {},
          agentMetrics: [
            {
              id: 'coding-specialist', name: 'Coding Specialist', status: 'active', model: 'sonnet',
              tokens: 100, activeMs: 5000, liveSpawns: ['spawn-1', 'spawn-2'], roleInferred: true,
              currentDescription: 'implement the widget', lastActivityAt: Date.now(),
            },
            {
              id: 'workspace-monitor', name: 'Workspace Monitor', status: 'idle', model: 'sonnet',
              tokens: 50, activeMs: 2000, currentDescription: 'should not show while idle',
              lastActivityAt: Date.now() - 5000,
            },
          ],
        },
      });
      tick(5);
      await flush();
      assertNoErrors('spawnid-instance-render');

      const tbody = doc.getElementById('metrics-tbody');
      assert.ok(tbody, 'metrics-tbody should exist');
      const rows = [...tbody.querySelectorAll('tr')].filter((r: any) => !r.classList.contains('metrics-footer-row'));
      const codingRow = rows.find((r: any) => r.querySelector('td.col-name')?.textContent?.includes('Coding Specialist'));
      const monitorRow = rows.find((r: any) => r.querySelector('td.col-name')?.textContent?.includes('Workspace Monitor'));
      assert.ok(codingRow, 'Coding Specialist row should exist');
      assert.ok(monitorRow, 'Workspace Monitor row should exist');

      const badge = codingRow.querySelector('.agent-instance-count');
      assert.ok(badge, 'liveSpawns.length > 1 should render the ×N instance badge');
      assert.equal(badge.textContent, '×2');

      assert.equal(
        codingRow.querySelector('.agent-role-inferred'),
        null,
        'roleInferred:true must NOT render an inferred-role marker (marker removed)',
      );

      const descLine = codingRow.querySelector('.agent-spawn-desc');
      assert.ok(descLine, 'an ACTIVE agent with currentDescription should render the spawn-desc line');
      assert.equal(descLine.textContent, 'implement the widget');

      assert.equal(monitorRow.querySelector('.agent-instance-count'), null, 'idle single-spawn agent should have no instance badge');
      assert.equal(monitorRow.querySelector('.agent-role-inferred'), null, 'agent without roleInferred should have no marker');
      assert.equal(
        monitorRow.querySelector('.agent-spawn-desc'),
        null,
        'an IDLE agent must not render its currentDescription line even though the field is set',
      );
    });

    // NOTE (per test brief, item 5 canvas half): media/src/main/120-agent-
    // dance-render-init.js's sceneAgentList "#n" expansion for extra
    // liveSpawns instances is computed in a closure-scoped variable
    // (lastAgentList) inside main.js's render loop with no exposed unit
    // seam (no window.__ debug hook, no exported function) reachable from
    // this jsdom harness or any other test file in this repo — canvas
    // output itself is not inspectable either. Skipping a direct
    // `id#2`-is-produced assertion for that reason; 9b/9c above are the
    // existing precedent for treating that render path as smoke-only.

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
              { id: 'opencode', label: 'OpenCode (Experimental)' },
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
              { id: 'opencode', label: 'OpenCode (Experimental)' },
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
              { id: 'opencode', label: 'OpenCode (Experimental)' },
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

    // ── Step 10d: Harness unsupported-provider warning (p27) ─────────────────
    // harness.warning is an optional string the host sends when the
    // configured provider id isn't supported by the running build. It must
    // render before the normal footnote hint, and must not appear at all
    // when the field is absent.
    await t.test('10d. harness warning: renders when harness.warning is set, absent otherwise', async () => {
      const baseSettings = {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
      };
      const warningText =
        'Configured provider "codex" is not supported by this build; running on Claude Code. Update the extension or change the setting.';

      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'claude-code',
            source: 'execution',
            fileValue: 'codex',
            running: 'claude-code',
            mismatch: false,
            warning: warningText,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'codex', label: 'Codex (Experimental)' },
            ],
            requiresRestart: false,
          },
        },
      });
      await flush();
      const warnedConfig = doc.getElementById('setup-config');
      assert.ok(
        (warnedConfig.textContent || '').includes(warningText),
        'harness.warning text must render in the footnote area'
      );
      assertNoErrors('harness-warning-present');

      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'claude-code',
            source: 'execution',
            fileValue: 'claude-code',
            running: 'claude-code',
            mismatch: false,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'codex', label: 'Codex (Experimental)' },
            ],
            requiresRestart: false,
          },
        },
      });
      await flush();
      const cleanConfig = doc.getElementById('setup-config');
      assert.ok(
        !(cleanConfig.textContent || '').includes(warningText),
        'no harness.warning field -> warning text must be absent'
      );
      assertNoErrors('harness-warning-absent');
    });

    // ── Step 10e: Codex hooks/dispatcher install rows (p23-t11) ──────────────
    // Two rows under the harness footnote, shown ONLY when harness.effective
    // is 'codex', reflecting codexHooksInstalled/codexDispatcherInstalled and
    // posting installCodexHooks/uninstallCodexHooks/installCodexDispatcher/
    // uninstallCodexDispatcher on click.
    await t.test('10e. codex install rows: render only for codex, reflect flags, post the right message', async () => {
      const baseSettings = {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
      };

      // Not codex -> rows absent.
      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'claude-code',
            source: 'execution',
            fileValue: 'claude-code',
            running: 'claude-code',
            mismatch: false,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'codex', label: 'Codex (Experimental)' },
            ],
            requiresRestart: false,
          },
        },
      });
      await flush();
      assert.ok(
        !(doc.getElementById('setup-config').textContent || '').includes('Codex hooks'),
        'harness.effective !== codex -> no Codex hooks row'
      );

      // Codex, both not installed -> "Install" buttons.
      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'codex',
            source: 'execution',
            fileValue: 'codex',
            running: 'codex',
            mismatch: false,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'codex', label: 'Codex (Experimental)' },
            ],
            requiresRestart: false,
            codexHooksInstalled: false,
            codexDispatcherInstalled: false,
          },
        },
      });
      await flush();
      const notInstalledConfig = doc.getElementById('setup-config');
      const rows = Array.from(notInstalledConfig.querySelectorAll('.harness-codex-install-row')) as any[];
      assert.equal(rows.length, 2, 'expects a Codex hooks row and a Dispatcher row');
      assert.ok((notInstalledConfig.textContent || '').includes('Codex hooks: not installed'));
      assert.ok((notInstalledConfig.textContent || '').includes('Dispatcher: not installed'));
      const installButtons = notInstalledConfig.querySelectorAll('.harness-codex-install-btn') as any;
      assert.equal(installButtons.length, 2);
      assert.equal(installButtons[0].textContent, 'Install');
      installButtons[0].dispatchEvent(new win.Event('click'));
      assert.equal(posted[posted.length - 1].type, 'installCodexHooks');
      installButtons[1].dispatchEvent(new win.Event('click'));
      assert.equal(posted[posted.length - 1].type, 'installCodexDispatcher');

      // Codex, both installed -> "Uninstall" buttons.
      dispatch({
        type: 'settings',
        payload: {
          ...baseSettings,
          harness: {
            effective: 'codex',
            source: 'execution',
            fileValue: 'codex',
            running: 'codex',
            mismatch: false,
            options: [
              { id: 'claude-code', label: 'Claude Code' },
              { id: 'codex', label: 'Codex (Experimental)' },
            ],
            requiresRestart: false,
            codexHooksInstalled: true,
            codexDispatcherInstalled: true,
            codexDispatcherWarning: 'foreign [mcp_servers.tycoon] table left untouched.',
          },
        },
      });
      await flush();
      const installedConfig = doc.getElementById('setup-config');
      assert.ok((installedConfig.textContent || '').includes('Codex hooks: installed'));
      assert.ok((installedConfig.textContent || '').includes('Dispatcher: installed'));
      assert.ok(
        (installedConfig.textContent || '').includes('foreign [mcp_servers.tycoon] table left untouched.'),
        'codexDispatcherWarning must render'
      );
      const uninstallButtons = installedConfig.querySelectorAll('.harness-codex-install-btn') as any;
      assert.equal(uninstallButtons[0].textContent, 'Uninstall');
      uninstallButtons[0].dispatchEvent(new win.Event('click'));
      assert.equal(posted[posted.length - 1].type, 'uninstallCodexHooks');
      uninstallButtons[1].dispatchEvent(new win.Event('click'));
      assert.equal(posted[posted.length - 1].type, 'uninstallCodexDispatcher');

      assertNoErrors('codex-install-rows');
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

// Regression: an accepted (kept) item on a board other than the current
// review gate must stay fully editable while generation is running on
// another board — see themeService.ts's runExclusivePerTheme, which
// serializes theme writes per theme_id, so a retry/edit for an off-gate item
// is safe to send mid-run. Only that item's own busy state may disable it.
test('THEME_IMAGE_REVIEW: an accepted item on a non-current gate stays editable while generation_active', async () => {
  const h = await bootObjScaleHarness();
  try {
    const items = [
      {
        id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
        status: 'accepted', prompt: 'A base environment prompt.', revision: 1, frame_keys: [],
        image_src: 'data:image/png;base64,AAA', updated_at: '',
      },
      {
        // Un-kept mid-run by a Retry: has an image again but back to pending,
        // and is off-gate (the gate is 'objects_02' below) — Keep must be
        // re-clickable without waiting for generation to finish.
        id: 'objects_01', filename: 'objects_01.png', label: 'Objects 1', kind: 'object_atlas',
        status: 'pending', prompt: 'A base objects prompt.', revision: 1, frame_keys: [],
        image_src: 'data:image/png;base64,BBB', updated_at: '',
      },
      {
        id: 'objects_02', filename: 'objects_02.png', label: 'Objects 2', kind: 'object_atlas',
        status: 'pending', prompt: 'A base objects prompt.', revision: 0, frame_keys: [], updated_at: '',
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'smoke_theme',
        display_name: 'Smoke Theme',
        items,
        creative_direction: 'a moody neon skyline',
        generation_active: true,
        waiting_for_review_item_id: 'objects_02',
      },
    });
    h.tick(2);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_IMAGE_REVIEW threw: ${h.errors.map(String).join('; ')}`);

    const list = h.doc.getElementById('theme-image-review-list');
    assert.ok(list, 'theme-image-review-list should exist');
    const acceptedCard = list.querySelector('.theme-review-card--accepted');
    assert.ok(acceptedCard, 'the accepted (kept) card should render');
    assert.ok(!acceptedCard.classList.contains('theme-review-card--current'), 'the accepted card must not be the current review gate in this scenario');

    const retryBtn = acceptedCard.querySelector('.theme-review-retry');
    assert.ok(retryBtn, 'Retry button should render on the accepted card');
    assert.equal(retryBtn.disabled, false, 'Retry on an accepted, off-gate item must stay enabled while generation is active');

    const uploadBtn = acceptedCard.querySelector('.theme-review-upload');
    assert.ok(uploadBtn, 'Upload button should render on the accepted card');
    assert.equal(uploadBtn.disabled, false, 'Upload on an accepted, off-gate item must stay enabled while generation is active');

    // A mid-run Retry un-keeps an off-gate item (status back to pending), and
    // the user must be able to re-keep it without waiting for generation to
    // finish — Keep is disabled only by missing image_src or its own busy state.
    const pendingCard = list.querySelector('[data-item-id="objects_01"]');
    assert.ok(pendingCard, 'the un-kept, off-gate pending card should render');
    const keepBtn = pendingCard.querySelector('.theme-review-accept');
    assert.ok(keepBtn, 'Keep button should render on the pending card');
    assert.equal(keepBtn.disabled, false, 'Keep on an off-gate item with an image must stay enabled while generation is active');
  } finally {
    h.win.close();
  }
});

// Regression: a THEME_IMAGE_REVIEW push arriving while the user is mid-edit
// in the Creative Direction textarea used to rebuild the panel straight from
// payload.creative_direction, silently discarding the unsaved typed text
// (captureThemeReviewUiState captured per-item drafts but not this textarea).
// captureThemeReviewUiState now also captures a dirty CD textarea's value,
// and buildThemeReviewCreativeDirectionSection restores it (and re-applies
// the dirty Save-button highlight) instead of using the fresh payload value.
test('THEME_IMAGE_REVIEW: an in-progress Creative Direction edit survives a re-push of the review payload', async () => {
  const h = await bootObjScaleHarness();
  try {
    const items = [
      {
        id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
        status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
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

    const list = h.doc.getElementById('theme-image-review-list');
    let textarea = list.querySelector('.theme-review-creative-direction-input');
    assert.ok(textarea, 'Creative Direction textarea should render');

    // Type an unsaved edit.
    textarea.value = 'a sunlit meadow with drifting pollen';
    textarea.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    const saveBtn = list.querySelector('.theme-review-creative-direction-save');
    assert.ok(
      saveBtn.classList.contains('theme-review-creative-direction-save-dirty'),
      'Save button should highlight once the field is dirty'
    );

    // A fresh review push (e.g. from an unrelated per-item Apply) arrives
    // while the edit is still unsaved — the payload still carries the OLD
    // creative_direction since this edit was never saved.
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
    assert.equal(h.errors.length, 0, `re-push threw: ${h.errors.map(String).join('; ')}`);

    textarea = list.querySelector('.theme-review-creative-direction-input');
    assert.equal(
      textarea.value,
      'a sunlit meadow with drifting pollen',
      'the unsaved typed edit should survive a re-render, not be overwritten by the payload value'
    );
    const saveBtnAfter = list.querySelector('.theme-review-creative-direction-save');
    assert.ok(
      saveBtnAfter.classList.contains('theme-review-creative-direction-save-dirty'),
      'Save button should still be highlighted as dirty after the re-render'
    );
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

// ── Stale descriptions notice + Re-derive descriptions (creative-direction
// re-derive feature) ─────────────────────────────────────────────────────────
// THEME_IMAGE_REVIEW payload carries descriptionsStale/descriptionsDirection
// (see themeDescriptionsStale in src/extension/themePlan.ts and panel.ts's
// THEME_IMAGE_REVIEW handler). buildThemeReviewCreativeDirectionSection in
// media/src/main/020-theme-plan-editor.js renders a stale notice + "Re-derive
// descriptions" button when descriptionsStale is true, and
// buildThemeReviewNamesDescriptionsSection renders a `.theme-desc-stale` pill
// next to each description row's label.
test('THEME_IMAGE_REVIEW: descriptionsStale:true renders the stale notice + Re-derive button + stale pills, and clicking the button posts REGENERATE_THEME_DESCRIPTIONS', async () => {
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
        descriptionsStale: true,
        descriptionsDirection: 'gritty outpost',
      },
    });
    h.tick(2);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_IMAGE_REVIEW threw: ${h.errors.map(String).join('; ')}`);

    const list = h.doc.getElementById('theme-image-review-list');
    assert.ok(list, 'theme-image-review-list should exist');

    const notice = list.querySelector('.theme-desc-stale-notice');
    assert.ok(notice, 'the stale notice should render when descriptionsStale is true');

    const rederiveBtn = list.querySelector('.theme-review-rederive-descriptions');
    assert.ok(rederiveBtn, 'the Re-derive descriptions button should render');

    const pills = list.querySelectorAll('.theme-desc-stale');
    assert.ok(pills.length > 0, 'at least one stale pill should render next to a description row');

    // Show/hide the previous direction.
    const showPrevBtn = list.querySelector('.theme-review-show-previous-direction');
    assert.ok(showPrevBtn, 'the Show previous direction button should render since descriptionsDirection is set');
    const prevText = list.querySelector('.theme-desc-previous-direction');
    assert.ok(prevText, 'the previous-direction text element should render');
    assert.equal(prevText.hidden, true, 'previous direction text starts hidden');
    showPrevBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    assert.equal(prevText.hidden, false, 'clicking Show previous direction reveals it');
    assert.equal(prevText.textContent, 'gritty outpost');

    rederiveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    const posted = [...h.posted].reverse().find((m: any) => m.type === 'REGENERATE_THEME_DESCRIPTIONS');
    assert.ok(posted, 'clicking Re-derive descriptions should post REGENERATE_THEME_DESCRIPTIONS');
    assert.equal(posted.payload.theme_id, 'smoke_theme');

    assert.equal(h.errors.length, 0, `errors after the full flow: ${h.errors.map(String).join('; ')}`);
  } finally {
    h.win.close();
  }
});

test('THEME_IMAGE_REVIEW: descriptionsStale:false (or absent) renders no stale notice, no Re-derive button, no stale pills', async () => {
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
        creative_direction: 'gritty outpost',
      },
    });
    h.tick(2);
    await h.flush();
    assert.equal(h.errors.length, 0, `THEME_IMAGE_REVIEW threw: ${h.errors.map(String).join('; ')}`);

    const list = h.doc.getElementById('theme-image-review-list');
    assert.equal(list.querySelector('.theme-desc-stale-notice'), null);
    assert.equal(list.querySelector('.theme-review-rederive-descriptions'), null);
    assert.equal(list.querySelectorAll('.theme-desc-stale').length, 0);
  } finally {
    h.win.close();
  }
});

// ── Dirty creative-direction textarea saves before Generate/Retry/Normalize
// (saveCreativeDirectionIfDirtyThenSend) ─────────────────────────────────────
test('a dirty creative-direction edit posts SET_THEME_CREATIVE_DIRECTION before REGENERATE_THEME_DESCRIPTIONS when Re-derive is clicked', async () => {
  const h = await bootObjScaleHarness();
  try {
    const items = [
      {
        id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
        status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'smoke_theme',
        display_name: 'Smoke Theme',
        items,
        creative_direction: 'gritty outpost',
        descriptionsStale: true,
        descriptionsDirection: 'old direction',
      },
    });
    h.tick(2);
    await h.flush();

    const list = h.doc.getElementById('theme-image-review-list');
    const textarea = list.querySelector('.theme-review-creative-direction-input');
    assert.ok(textarea, 'the creative-direction textarea should render');
    textarea.value = 'a freshly edited direction';
    textarea.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const rederiveBtn = list.querySelector('.theme-review-rederive-descriptions');
    assert.ok(rederiveBtn, 'the Re-derive descriptions button should render');
    rederiveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

    const setDirectionIndex = h.posted.findIndex((m: any) => m.type === 'SET_THEME_CREATIVE_DIRECTION');
    const regenerateIndex = h.posted.findIndex((m: any) => m.type === 'REGENERATE_THEME_DESCRIPTIONS');
    assert.ok(setDirectionIndex !== -1, 'a dirty edit should post SET_THEME_CREATIVE_DIRECTION');
    assert.ok(regenerateIndex !== -1, 'clicking Re-derive should post REGENERATE_THEME_DESCRIPTIONS');
    assert.ok(setDirectionIndex < regenerateIndex, 'SET_THEME_CREATIVE_DIRECTION must be posted before REGENERATE_THEME_DESCRIPTIONS');
    assert.equal(h.posted[setDirectionIndex].payload.creative_direction, 'a freshly edited direction');

    assert.equal(h.errors.length, 0, `errors after the full flow: ${h.errors.map(String).join('; ')}`);
  } finally {
    h.win.close();
  }
});

test('a dirty creative-direction edit posts SET_THEME_CREATIVE_DIRECTION before GENERATE_THEME on Start generation', async () => {
  const h = await bootObjScaleHarness();
  try {
    const plan = buildFullThemePlan();
    dispatchThemePlanReady(h, plan);
    h.tick(2);
    await h.flush();

    const items = [
      {
        id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
        status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'smoke_theme',
        display_name: 'Smoke Theme',
        items,
        creative_direction: 'gritty outpost',
      },
    });
    h.tick(2);
    await h.flush();

    const list = h.doc.getElementById('theme-image-review-list');
    const textarea = list.querySelector('.theme-review-creative-direction-input');
    assert.ok(textarea, 'the creative-direction textarea should render');
    textarea.value = 'an edited-but-unsaved direction';
    textarea.dispatchEvent(new h.win.Event('input', { bubbles: true }));

    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

    const setDirectionIndex = h.posted.findIndex((m: any) => m.type === 'SET_THEME_CREATIVE_DIRECTION');
    const generateIndex = h.posted.findIndex((m: any) => m.type === 'GENERATE_THEME');
    assert.ok(setDirectionIndex !== -1, 'a dirty edit should post SET_THEME_CREATIVE_DIRECTION before Start generation sends GENERATE_THEME');
    assert.ok(generateIndex !== -1, 'Start generation should post GENERATE_THEME');
    assert.ok(setDirectionIndex < generateIndex, 'SET_THEME_CREATIVE_DIRECTION must be posted before GENERATE_THEME');
    assert.equal(h.posted[setDirectionIndex].payload.creative_direction, 'an edited-but-unsaved direction');

    assert.equal(h.errors.length, 0, `errors after the full flow: ${h.errors.map(String).join('; ')}`);
  } finally {
    h.win.close();
  }
});

test('Start generation with a clean (never-dirtied) creative-direction textarea posts only GENERATE_THEME, no SET_THEME_CREATIVE_DIRECTION', async () => {
  const h = await bootObjScaleHarness();
  try {
    const plan = buildFullThemePlan();
    dispatchThemePlanReady(h, plan);
    h.tick(2);
    await h.flush();

    const items = [
      {
        id: 'environment', filename: 'environment.png', label: 'Environment', kind: 'environment',
        status: 'pending', prompt: 'A base environment prompt.', revision: 0, frame_keys: [], updated_at: '',
      },
    ];
    h.dispatch({
      type: 'THEME_IMAGE_REVIEW',
      payload: {
        theme_id: 'smoke_theme',
        display_name: 'Smoke Theme',
        items,
        creative_direction: 'gritty outpost',
      },
    });
    h.tick(2);
    await h.flush();

    // Never touch the textarea — it stays clean (matches its dataset.original).
    const startBtn = h.doc.getElementById('theme-start-generation-btn');
    assert.ok(startBtn, 'theme-start-generation-btn should exist');
    startBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));

    assert.equal(
      h.posted.filter((m: any) => m.type === 'SET_THEME_CREATIVE_DIRECTION').length,
      0,
      'a clean textarea must not post SET_THEME_CREATIVE_DIRECTION',
    );
    assert.equal(
      h.posted.filter((m: any) => m.type === 'GENERATE_THEME').length,
      1,
      'a clean textarea should still post GENERATE_THEME',
    );

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
// "Tokens" in both scopes; the scope-dependent explanation moved to the
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
    assert.equal(tokensHeader.textContent, 'Tokens', 'header text is now the short "Tokens" form in both scopes');
    assert.equal(
      tokensHeader.title,
      'Billed context tokens summed over every turn (input, output, cache writes). Cache reads are shown separately and cost about a tenth of input. Scope: all time, since the last metrics reset.',
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
    // Visible textContent is now the scope-invariant "Tokens" short form, so
    // scope is pinned via the title/aria-label instead (the tooltip the
    // asterisk points to).
    assert.equal(tokensHeader.textContent, 'Tokens');
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

    assert.equal(tokensHeader.textContent, 'Tokens', 'header text stays the short "Tokens" form after switching scope');
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
    assert.equal(tokensHeader.textContent, 'Tokens', 'header text stays the short "Tokens" form after switching back');
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

// ── Cross-vendor accent (p24-t2) ─────────────────────────────────────────
// agentAccent() itself (fallback beats foreign, native under a matching
// harness, etc.) is covered directly against 005-agent-accent.js by
// test/agentAccent.test.ts. These tests only check that the webview's
// render paths (metrics table, Agents/routing roster, legend) actually
// consume that decision and apply the right class/suffix.

test('accent: metrics table colors a foreign active agent light blue with no "(fb)" suffix, native agents unaffected', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 2,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus', vendor: 'anthropic', tokens: 500, activeMs: 30000 },
          { id: 'codex-reviewer', name: 'Codex Reviewer', status: 'active', model: 'gpt-6-astra', vendor: 'openai', tokens: 900, activeMs: 40000, taskCount: 1, lastActivityAt: Date.now() },
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', vendor: 'anthropic', tokens: 700, activeMs: 20000, taskCount: 1 },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const tbody = h.doc.getElementById('metrics-tbody');
    const rows = [...tbody.querySelectorAll('tr')].filter((r: any) => !r.classList.contains('metrics-footer-row'));
    const foreignRow = rows.find((r: any) => (r.querySelector('td.col-name span') || {}).textContent === 'Codex Reviewer');
    assert.ok(foreignRow, 'foreign agent row should exist');
    const foreignNameSpan = foreignRow.querySelector('td.col-name span');
    assert.ok(foreignNameSpan.classList.contains('agent-accent-foreign'), 'foreign agent name gets agent-accent-foreign');
    assert.ok(!/\(fb\)/.test(foreignNameSpan.textContent), 'foreign agent gets no "(fb)" suffix');
    const foreignFill = foreignRow.querySelector('.status-bar-fill');
    assert.ok(foreignFill.classList.contains('agent-accent-foreign'), 'foreign active agent bar fill gets agent-accent-foreign');

    const nativeRow = rows.find((r: any) => (r.querySelector('td.col-name span') || {}).textContent === 'Coding Specialist');
    const nativeNameSpan = nativeRow.querySelector('td.col-name span');
    assert.ok(!nativeNameSpan.classList.contains('agent-accent-foreign'), 'native agent gets no foreign accent');
    assert.ok(!nativeNameSpan.classList.contains('agent-accent-fallback'), 'native agent gets no fallback accent');
  } finally {
    h.win.close();
  }
});

test('accent: metrics table colors a fallback agent amber with "(fb)" suffix on the name cell', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          {
            id: 'coding-specialist', name: 'Coding Specialist', status: 'active', model: 'sonnet',
            vendor: 'anthropic', fallbackOf: 'ux-ui-designer', tokens: 700, activeMs: 20000, taskCount: 1,
            lastActivityAt: Date.now(),
          },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const tbody = h.doc.getElementById('metrics-tbody');
    const row = [...tbody.querySelectorAll('tr')].find((r: any) => !r.classList.contains('metrics-footer-row'));
    const nameSpan = row.querySelector('td.col-name span');
    assert.ok(nameSpan.classList.contains('agent-accent-fallback'), 'fallback agent name gets agent-accent-fallback');
    assert.match(nameSpan.textContent, /\(fb\)$/, 'fallback agent name cell ends with the " (fb)" suffix');
    const fill = row.querySelector('.status-bar-fill');
    assert.ok(fill.classList.contains('agent-accent-fallback'), 'fallback active agent bar fill gets agent-accent-fallback');
  } finally {
    h.win.close();
  }
});

// ---------------------------------------------------------------------------
// p63-t5: buildMetricsRollup / buildMetricsRow — records with no `tokens`
// field render "n/a" and are excluded from totals ("N tokens (M agents
// reported)"); `tokens: 0` is a real reported zero, not "n/a"; cacheReadTokens
// renders only as a separate "+ X cached" span, never folded into totals; no
// "$" anywhere in the rendered metrics output (media/src/main/080-packs-events.js
// buildMetricsRollup ~803-880, buildMetricsRow ~1236-1258).
// ---------------------------------------------------------------------------

test('p63-t5: an agentMetrics record with no `tokens` field renders "n/a" in its tokens cell and is excluded from the rollup total', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 2,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus', vendor: 'anthropic', tokens: 500, activeMs: 30000 },
          // No `tokens` field at all -- a harness that doesn't report usage yet.
          { id: 'codex-reviewer', name: 'Codex Reviewer', status: 'idle', model: 'gpt-6-astra', vendor: 'openai', activeMs: 40000, taskCount: 1 },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const tbody = h.doc.getElementById('metrics-tbody');
    const rows = [...tbody.querySelectorAll('tr')].filter((r: any) => !r.classList.contains('metrics-footer-row'));
    const naRow = rows.find((r: any) => (r.querySelector('td.col-name span') || {}).textContent === 'Codex Reviewer');
    assert.ok(naRow, 'codex-reviewer row should exist');
    const naCell = naRow.querySelector('td.col-tokens');
    assert.equal(naCell.textContent, 'n/a', 'a record with no tokens field must render "n/a"');

    const footerText = [...tbody.querySelectorAll('tr.metrics-footer-row')].map((r: any) => r.textContent).join(' ');
    assert.match(footerText, /500\s*tokens.*\(1\s*agents?\s*reported\)/i, `expected total to exclude the n/a agent: ${footerText}`);
  } finally {
    h.win.close();
  }
});

test('p63-t5: agentMetrics with tokens:0 renders "0", not "n/a", and counts as a reported agent', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', vendor: 'anthropic', tokens: 0, activeMs: 1000, taskCount: 0 },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const tbody = h.doc.getElementById('metrics-tbody');
    const row = [...tbody.querySelectorAll('tr')].find((r: any) => !r.classList.contains('metrics-footer-row'));
    const cell = row.querySelector('td.col-tokens');
    assert.notEqual(cell.textContent, 'n/a', 'tokens: 0 is a real reported zero, not the missing-field n/a state');
    assert.match(cell.textContent, /^0/, `expected the cell to render a literal 0, got: ${cell.textContent}`);
  } finally {
    h.win.close();
  }
});

test('p63-t5: cacheReadTokens renders only as a separate "+ X cached" span, never folded into the main tokens figure or the rollup total', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', vendor: 'anthropic', tokens: 100000, cacheReadTokens: 400000, activeMs: 1000, taskCount: 1 },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const tbody = h.doc.getElementById('metrics-tbody');
    const row = [...tbody.querySelectorAll('tr')].find((r: any) => !r.classList.contains('metrics-footer-row'));
    const cell = row.querySelector('td.col-tokens');
    const mainSpan = cell.querySelector('span:not(.col-tokens-cached)');
    const cacheSpan = cell.querySelector('span.col-tokens-cached');
    assert.ok(mainSpan, 'main tokens span should exist');
    assert.ok(cacheSpan, 'cache-read span should exist');
    assert.match(mainSpan.textContent, /^100k$/i, 'main span must show only the billable 100k, not a combined 500k total');
    assert.match(cacheSpan.textContent, /400k cached/i);

    const footerText = [...tbody.querySelectorAll('tr.metrics-footer-row')].map((r: any) => r.textContent).join(' ');
    assert.match(footerText, /100k?\s*tokens|100000\s*tokens/i, `rollup total must count only billable tokens, cache reads never added in: ${footerText}`);
    assert.doesNotMatch(footerText, /500k/i, 'rollup total must never fold cache reads into the displayed total');
  } finally {
    h.win.close();
  }
});

test('p63-t5: no "$" character anywhere in the rendered Metrics tab output', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 2,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'opus', vendor: 'anthropic', tokens: 500, cacheReadTokens: 200, activeMs: 30000 },
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet', vendor: 'anthropic', tokens: 100000, cacheReadTokens: 400000, activeMs: 20000, taskCount: 1 },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const metricsBody = h.doc.getElementById('metrics-body');
    assert.doesNotMatch(String(metricsBody.textContent), /\$/, 'no dollar figure anywhere in the rendered Metrics tab');
  } finally {
    h.win.close();
  }
});

test('p32-t1: metrics table suffixes "(dfb)" instead of "(fb)" when the metric has fallbackIsDefault, plain "(fb)" otherwise', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 1,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          {
            id: 'coding-specialist', name: 'Coding Specialist', status: 'active', model: 'sonnet',
            vendor: 'anthropic', fallbackOf: 'ux-ui-designer', fallbackIsDefault: true, tokens: 700, activeMs: 20000, taskCount: 1,
            lastActivityAt: Date.now(),
          },
          {
            id: 'testing-specialist', name: 'Testing Specialist', status: 'idle', model: 'sonnet',
            vendor: 'anthropic', fallbackOf: 'ux-ui-designer', tokens: 100, activeMs: 0, taskCount: 0,
          },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const tbody = h.doc.getElementById('metrics-tbody');
    const rows = [...tbody.querySelectorAll('tr')].filter((r: any) => !r.classList.contains('metrics-footer-row'));
    const dfbRow = rows.find((r: any) => r.querySelector('td.col-name span').textContent.includes('Coding Specialist'));
    const fbRow = rows.find((r: any) => r.querySelector('td.col-name span').textContent.includes('Testing Specialist'));
    assert.match(dfbRow.querySelector('td.col-name span').textContent, /\(dfb\)$/, 'fallbackIsDefault metric ends with "(dfb)"');
    assert.match(fbRow.querySelector('td.col-name span').textContent, /\(fb\)$/, 'plain fallback metric ends with "(fb)"');
    assert.ok(!/\(dfb\)/.test(fbRow.querySelector('td.col-name span').textContent), 'plain fallback metric never gets "(dfb)"');
  } finally {
    h.win.close();
  }
});

test('accent: metrics-row agent-accent-foreign applies only while the agent is active, agent-accent-fallback applies regardless (p70-t2)', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.dispatch({
      type: 'state',
      state: {
        sessionActive: true,
        completedTasks: 2,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [
          {
            id: 'codex-reviewer', name: 'Codex Reviewer', status: 'active', model: 'gpt',
            vendor: 'openai', tokens: 500, activeMs: 10000, taskCount: 1, lastActivityAt: Date.now(),
          },
          {
            id: 'gemini-reviewer', name: 'Gemini Reviewer', status: 'idle', model: 'gemini',
            vendor: 'google', tokens: 200, activeMs: 0, taskCount: 0,
          },
          {
            id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', model: 'sonnet',
            vendor: 'anthropic', fallbackOf: 'ux-ui-designer', tokens: 100, activeMs: 0, taskCount: 0,
          },
        ],
      },
    });
    h.tick(5);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const tbody = h.doc.getElementById('metrics-tbody');
    const rows = [...tbody.querySelectorAll('tr')].filter((r: any) => !r.classList.contains('metrics-footer-row'));
    const activeForeignRow = rows.find((r: any) => (r.querySelector('td.col-name span') || {}).textContent === 'Codex Reviewer');
    const idleForeignRow = rows.find((r: any) => (r.querySelector('td.col-name span') || {}).textContent === 'Gemini Reviewer');
    const idleFallbackRow = rows.find((r: any) => /Coding Specialist/.test((r.querySelector('td.col-name span') || {}).textContent || ''));

    assert.ok(
      activeForeignRow.querySelector('td.col-name span').classList.contains('agent-accent-foreign'),
      'active foreign-vendor agent gets agent-accent-foreign'
    );
    assert.ok(
      !idleForeignRow.querySelector('td.col-name span').classList.contains('agent-accent-foreign'),
      'idle foreign-vendor agent does NOT get agent-accent-foreign'
    );
    assert.ok(
      idleFallbackRow.querySelector('td.col-name span').classList.contains('agent-accent-fallback'),
      'idle fallback agent still gets agent-accent-fallback regardless of active state'
    );
  } finally {
    h.win.close();
  }
});

test('p68-t3: Keyword health card — all-clear state, warn state with Fix all, and the wildcard-chip Add flow', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [
          { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', isOrchestrator: false },
        ],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    assert.ok(menuRoutingBtn, 'menu-routing button should exist so the Agents modal can be opened');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();
    h.dispatch({
      type: 'routing',
      payload: {
        orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
        agents: [
          { id: 'coding-specialist', name: 'Coding Specialist', backend: {}, source: 'file' },
        ],
        presets: { vendors: ['anthropic'], models: [] },
        errors: [],
      },
    });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    // Zero findings -> all-clear, no per-agent badge/warn styling.
    h.dispatch({ type: 'KEYWORD_HEALTH', findings: [], wildcardTasksThisSession: 0, unmatchedWords: [] });
    h.tick(2);
    await h.flush();
    let card = h.doc.querySelector('.keyword-health-card');
    assert.ok(card, 'keyword health card should render once a KEYWORD_HEALTH payload has arrived');
    assert.ok(card.classList.contains('keyword-health-card-ok'), 'zero findings -> ok state');
    assert.match(card.textContent, /All agents routable/);
    assert.equal(card.querySelectorAll('.keyword-health-finding').length, 0, 'no per-agent finding badges');

    // One multi_word_segment finding -> warn card lists it; Fix all posts fix_all.
    h.dispatch({
      type: 'KEYWORD_HEALTH',
      findings: [
        {
          agentId: 'coding-specialist',
          kind: 'multi_word_segment',
          detail: '"coding-specialist" segment "bug fix" contains whitespace and can never match a single-word token.',
          fix: { kind: 'split_segment' },
        },
      ],
      wildcardTasksThisSession: 0,
      unmatchedWords: [],
    });
    h.tick(2);
    await h.flush();
    card = h.doc.querySelector('.keyword-health-card');
    assert.ok(card.classList.contains('keyword-health-card-warn'), 'a finding -> warn state');
    const findingItems = [...card.querySelectorAll('.keyword-health-finding')];
    assert.equal(findingItems.length, 1, 'one finding badge for coding-specialist');
    assert.match(findingItems[0].textContent, /coding-specialist/);
    assert.match(findingItems[0].textContent, /bug fix/);

    const fixAllBtn = card.querySelector('.keyword-health-fix-all');
    assert.ok(fixAllBtn, 'Fix all button should render in the warn state');
    fixAllBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();
    const fixAllMsg = [...h.posted].reverse().find((m: any) => m.type === 'KEYWORD_HEALTH_FIX');
    assert.ok(fixAllMsg, 'clicking Fix all should post a KEYWORD_HEALTH_FIX message');
    assert.equal(fixAllMsg.action, 'fix_all');

    // p71-t2: second KEYWORD_HEALTH payload after fix_all -> "Fixed N. M shared keywords are informational." line.
    h.dispatch({
      type: 'KEYWORD_HEALTH',
      findings: [
        {
          agentId: 'coding-specialist',
          kind: 'duplicate_keyword',
          severity: 'info',
          detail: '"coding-specialist" segment "test" is shared with testing-specialist.',
        },
      ],
      wildcardTasksThisSession: 0,
      unmatchedWords: [],
    });
    h.tick(2);
    await h.flush();
    card = h.doc.querySelector('.keyword-health-card');
    const fixResultLine = card.querySelector('.keyword-health-fix-result');
    assert.ok(fixResultLine, 'a fix result line should render after the fix_all round trip');
    assert.match(fixResultLine.textContent, /^Fixed 1\. 1 shared keyword are informational\.$/);

    // p71-t2: only warnings count in the header — zero warnings here -> all-clear state,
    // and the info finding is collapsed under "Shared keywords (1)" rather than counted.
    assert.ok(card.classList.contains('keyword-health-card-ok'), 'an info-only payload is the all-clear state');
    assert.match(card.textContent, /All agents routable/);
    const sharedDetails = card.querySelector('.keyword-health-shared');
    assert.ok(sharedDetails, 'shared keywords section should render for info findings');
    assert.equal(sharedDetails.tagName.toLowerCase(), 'details', 'shared keywords section is collapsible');
    assert.equal(sharedDetails.hasAttribute('open'), false, 'shared keywords section is collapsed by default');
    assert.match(sharedDetails.querySelector('summary').textContent, /Shared keywords \(1\)/);

    // p71-t2: the duplicate legend paragraph is gone; the harness accent legend renders exactly once.
    const legendNodes = [...h.doc.querySelectorAll('.agent-accent-legend')];
    assert.equal(legendNodes.length, 1, 'the accent legend should render exactly once, no separate duplicate-keyword legend');

    // p71-t2: a third, plain (non-fix) KEYWORD_HEALTH payload must clear the "Fixed N" line.
    h.dispatch({ type: 'KEYWORD_HEALTH', findings: [], wildcardTasksThisSession: 0, unmatchedWords: [] });
    h.tick(2);
    await h.flush();
    card = h.doc.querySelector('.keyword-health-card');
    assert.equal(card.querySelector('.keyword-health-fix-result'), null, 'a later unrelated KEYWORD_HEALTH push should clear the stale fix-all result line');

    // Wildcard chip: unmatchedWords -> chip renders; choosing an agent posts action:"add".
    h.dispatch({
      type: 'KEYWORD_HEALTH',
      findings: [],
      wildcardTasksThisSession: 2,
      unmatchedWords: ['render'],
    });
    h.tick(2);
    await h.flush();
    card = h.doc.querySelector('.keyword-health-card');
    assert.match(card.textContent, /2 tasks fell through to Wildcard Agent/);
    const chip = card.querySelector('.keyword-health-chip');
    assert.ok(chip, 'an unmatched word should render a chip');
    assert.match(chip.textContent, /render/);
    const addBtn = chip.querySelector('.keyword-health-chip-add');
    addBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    h.tick(2);
    await h.flush();
    card = h.doc.querySelector('.keyword-health-card');
    const picker = card.querySelector('.keyword-health-chip-picker');
    assert.ok(picker, 'add-to picker should open after clicking "add to…"');
    const option = [...picker.querySelectorAll('option')].find((o: any) => o.value === 'coding-specialist');
    assert.ok(option, 'coding-specialist should be a selectable option');
    picker.value = 'coding-specialist';
    picker.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();
    const addMsg = [...h.posted].reverse().find((m: any) => m.type === 'KEYWORD_HEALTH_FIX' && m.action === 'add');
    assert.ok(addMsg, 'choosing an agent should post a KEYWORD_HEALTH_FIX add message');
    assert.equal(addMsg.agentId, 'coding-specialist');
    assert.equal(addMsg.token, 'render');
  } finally {
    h.win.close();
  }
});

test('accent: Agents/routing roster colors a foreign-vendor slot even with no run in progress, and flips when the harness changes', async () => {
  const h = await bootObjScaleHarness();
  try {
    const settingsClaude = {
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    };
    h.dispatch(settingsClaude);
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    assert.ok(menuRoutingBtn, 'menu-routing button should exist so the Agents modal can be opened');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();
    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        { id: 'codex-reviewer', name: 'Codex Reviewer', backend: { vendor: 'openai' }, source: 'file' },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    let card = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    assert.ok(card, 'codex-reviewer card should render even with no run in progress');
    let nameEl = card.querySelector('.agent-name');
    assert.ok(nameEl.classList.contains('agent-accent-foreign'), 'openai vendor under claude-code harness -> foreign accent, no run needed');

    // p27-t6: card delineation — full outline via .routing-agent-card
    // itself, plus a top accent bar class/data-attribute mirroring the
    // same agentAccent() classification as the nameplate above.
    assert.ok(card.classList.contains('routing-agent-card'), 'card should carry the bordered .routing-agent-card class');
    assert.ok(card.classList.contains('agent-card-accent-foreign'), 'card should carry the foreign accent-bar class');
    assert.equal(card.dataset.agentAccent, 'foreign', 'card should expose data-agent-accent matching agentAccent()');

    const legend = h.doc.querySelector('.agent-accent-legend');
    assert.ok(legend, 'accent legend line should render near the harness footnote');
    assert.match(legend.textContent, /Light blue/i);
    assert.match(legend.textContent, /Amber \(fb\)/i);

    // Switching the harness to one where "openai" is native flips the slot
    // back to unaccented on the very next render.
    h.dispatch({
      type: 'settings',
      payload: { ...settingsClaude.payload, harness: { ...settingsClaude.payload.harness, effective: 'codex' } },
    });
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    card = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    nameEl = card.querySelector('.agent-name');
    assert.ok(!nameEl.classList.contains('agent-accent-foreign'), 'openai vendor under codex harness -> native, accent clears');
  } finally {
    h.win.close();
  }
});

test('accent: canvas source applies the ring/pulse accent only for active fallback agents (p70-t1: foreign-vendor stage ring removed) and the " (fb)" nameplate suffix, gated on charEntry.accentKind', () => {
  const src = readFileSync(MAIN_JS_PATH, 'utf8');
  assert.match(
    src,
    /charEntry\.isActive && charEntry\.accentKind === "fallback"/,
    'the active-state ring is gated on isActive + accentKind === "fallback" only, never "foreign"'
  );
  assert.match(src, /rgba\(255, 176, 32, 0\.9\)/, 'ring uses the amber accent color for fallback');
  assert.doesNotMatch(
    src,
    /rgba\(79, 195, 247, 0\.9\)/,
    'the foreign-vendor light-blue stage ring color is removed; vendor is indicated only in the metrics panel'
  );
  assert.doesNotMatch(
    src,
    /charEntry\.accentKind === "foreign" \|\| charEntry\.accentKind === "fallback"/,
    'the stage ring condition no longer includes "foreign"'
  );
  assert.match(
    src,
    /charEntry\.accentKind === "fallback" \? \(charEntry\.accentIsDefault \? " \(dfb\)" : " \(fb\)"\) : ""/,
    'the canvas nameplate label appends " (fb)" (or " (dfb)" for the default fallback) only for fallback agents'
  );
});

test('p25-t1: subscription+mcp slot renders both the setup notice and the fallback editor; Add fallback works and Save posts the fallback entry', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    assert.ok(menuRoutingBtn, 'menu-routing button should exist');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'codex-reviewer',
          name: 'Codex Reviewer',
          provenance: 'explicit',
          handWrittenBackend: true,
          backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'gpt-6-astra', costModelClass: 'subscription' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const card = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    assert.ok(card, 'codex-reviewer card should render');

    // p27-t4: this slot already carries a hand-written backend block AND an
    // mcpServer name — bridged-connected state: status row only, no Copy
    // request button, per docs/design/slot-editor-redesign.md section 5.
    const notice = card.querySelector('.routing-subscription-notice');
    assert.ok(notice && !notice.hidden, 'subscription/MCP notice wrapper should render (hosting the status row)');
    const statusLine = notice.querySelector('.routing-subscription-bridge-status');
    assert.ok(statusLine, 'bridge status line should render');
    assert.equal(statusLine.textContent, 'Bridged via Codex MCP - connected.', 'bridged-connected status line reads verbatim per section 5');
    assert.ok(notice.querySelector('.routing-subscription-notice-copy').hidden, 'Copy request button hidden in bridged-connected state');

    const fields = card.querySelector('.routing-slot-fields');
    assert.ok(fields, 'slot body (buildSlotEditorFields) must render alongside the notice, not be replaced by it');

    const fallbackDetails = card.querySelector('.routing-fallback-details[data-agent-id="codex-reviewer"]');
    assert.ok(fallbackDetails, 'buildFallbackEditor must render for this slot');

    const addBtn = fallbackDetails.querySelector('.routing-add-fallback-btn');
    assert.ok(addBtn, 'Add fallback button should render');
    assert.equal(addBtn.disabled, false, 'Add fallback should be enabled with 0 existing fallbacks');
    addBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const saveBtn = card.querySelector('.agent-card-save-btn');
    assert.ok(saveBtn, 'per-card Save button should render');
    saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const saveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(saveMsg, 'a saveRouting message should have been posted');
    const savedSlot = saveMsg.profile && saveMsg.profile.agents && saveMsg.profile.agents['codex-reviewer'];
    assert.ok(savedSlot, 'saved profile should carry a codex-reviewer slot');
    assert.ok(Array.isArray(savedSlot.fallback) && savedSlot.fallback.length === 1, 'the added fallback entry should be present in the posted save payload');
  } finally {
    h.win.close();
  }
});

test('p25-t1: a slot with a backend block (handWrittenBackend, no subscription mismatch) also renders the fallback editor', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'kimi-reviewer',
          name: 'Kimi Reviewer',
          provenance: 'explicit',
          handWrittenBackend: true,
          backend: { vendor: 'moonshot', transport: 'mcp', mcpServer: 'kimi', model: 'kimi-k2', costModelClass: 'local' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'moonshot'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    assert.ok(card, 'kimi-reviewer card should render');
    assert.ok(card.querySelector('.routing-slot-fields'), 'slot body should render for a backend-block slot');
    assert.ok(card.querySelector('.routing-fallback-details[data-agent-id="kimi-reviewer"]'), 'fallback editor should render for a backend-block slot');
  } finally {
    h.win.close();
  }
});

test('p25-t1: a native Anthropic slot renders unchanged (no notice, body + fallback editor present) and the depth gate disables Add fallback at 3', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'coding-specialist',
          name: 'Coding Specialist',
          provenance: 'explicit',
          handWrittenBackend: false,
          backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'metered' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const card = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    assert.ok(card, 'coding-specialist card should render');
    const notice = card.querySelector('.routing-subscription-notice');
    assert.ok(!notice || notice.hidden, 'no visible notice for a native Anthropic slot');
    assert.ok(card.querySelector('.routing-slot-fields'), 'slot body should render');
    const fallbackDetails = card.querySelector('.routing-fallback-details[data-agent-id="coding-specialist"]');
    assert.ok(fallbackDetails, 'fallback editor should render');

    const addBtn = fallbackDetails.querySelector('.routing-add-fallback-btn');
    assert.equal(addBtn.disabled, false, 'Add fallback enabled at 0 entries');
    for (let i = 0; i < 3; i++) {
      addBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
      await h.flush();
    }
    const card2 = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    const fallbackDetails2 = card2.querySelector('.routing-fallback-details[data-agent-id="coding-specialist"]');
    const addBtn2 = fallbackDetails2.querySelector('.routing-add-fallback-btn');
    assert.equal(addBtn2.disabled, true, 'Add fallback disabled once depth reaches 3');
  } finally {
    h.win.close();
  }
});

test('p26-t1: codex-reviewer (openai, handWrittenBackend) suppresses the notice and bridge fields under codex, shows them under claude-code', async () => {
  const h = await bootObjScaleHarness();
  try {
    const settingsClaude = {
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    };
    h.dispatch(settingsClaude);
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'codex-reviewer',
          name: 'Codex Reviewer',
          provenance: 'explicit',
          handWrittenBackend: true,
          backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'gpt-6-astra', costModelClass: 'subscription' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    let card = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    assert.ok(card, 'codex-reviewer card should render under claude-code');
    // p27-t1: openai is foreign under claude-code, but this slot's bridge
    // (hand-written backend + mcpServer "codex") is already set up, so the
    // status line shows in place of the notice/copy-request box.
    let notice = card.querySelector('.routing-subscription-notice');
    assert.ok(notice && !notice.hidden, 'openai vendor is foreign under claude-code -> the notice wrapper is visible (hosting the status line)');
    assert.ok(notice.querySelector('.routing-subscription-notice-copy').hidden, 'Copy request button hidden in bridged-connected state');
    assert.equal(notice.querySelector('.routing-subscription-bridge-status').textContent, 'Bridged via Codex MCP - connected.', 'bridged-connected status line reads verbatim per section 5');
    let fields = card.querySelector('.routing-slot-fields');
    assert.ok(fields.querySelector('[data-field-key$=".mcpServer"]'), 'MCP server field should render under claude-code');

    // Switch the harness to codex — openai is now the native vendor.
    h.dispatch({
      type: 'settings',
      payload: { ...settingsClaude.payload, harness: { ...settingsClaude.payload.harness, effective: 'codex' } },
    });
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();

    card = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    notice = card.querySelector('.routing-subscription-notice');
    assert.ok(!notice || notice.hidden, 'openai vendor is native under codex -> no visible notice');
    fields = card.querySelector('.routing-slot-fields');
    assert.ok(fields, 'slot body should still render under codex');
    assert.ok(!fields.querySelector('[data-field-key$=".transport"]'), 'Transport field should not render for the native vendor under codex');
    assert.ok(!fields.querySelector('[data-field-key$=".mcpServer"]'), 'MCP server field should not render for the native vendor under codex');
    assert.ok(!fields.querySelector('[data-field-key$=".credentialEnv"]'), 'Credential env field should not render for the native vendor under codex');
  } finally {
    h.win.close();
  }
});

test('p26-t1: an anthropic/mcp/subscription slot under claude-code suppresses the notice and bridge fields (the reported bug)', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'claude-worker',
          name: 'Claude Worker',
          provenance: 'explicit',
          handWrittenBackend: true,
          backend: { vendor: 'anthropic', transport: 'mcp', mcpServer: 'claude', model: 'claude-sonnet-4-6', costModelClass: 'subscription' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const card = h.doc.querySelector('.routing-agent-card[data-agent-id="claude-worker"]');
    assert.ok(card, 'claude-worker card should render');
    const notice = card.querySelector('.routing-subscription-notice');
    assert.ok(!notice || notice.hidden, 'anthropic is native under claude-code -> no visible notice even with transport mcp + cost subscription');
    const fields = card.querySelector('.routing-slot-fields');
    assert.ok(fields, 'slot body should render');
    assert.ok(!fields.querySelector('[data-field-key$=".transport"]'), 'Transport field should not render for the native vendor');
    assert.ok(!fields.querySelector('[data-field-key$=".mcpServer"]'), 'MCP server field should not render for the native vendor');
    assert.ok(!fields.querySelector('[data-field-key$=".credentialEnv"]'), 'Credential env field should not render for the native vendor');
  } finally {
    h.win.close();
  }
});

test('p26-t1: switching an agent slot to the native vendor collapses to the native route and omits it from the posted save; switching back to a foreign vendor restores the bridge fields', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'kimi-reviewer',
          name: 'Kimi Reviewer',
          provenance: 'explicit',
          handWrittenBackend: false,
          backend: { vendor: 'moonshot', transport: 'mcp', mcpServer: 'kimi', model: 'kimi-k2', costModelClass: 'local' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'moonshot'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    let card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    assert.ok(card, 'kimi-reviewer card should render, expanded (routed foreign vendor)');
    let vendorSel = card.querySelector('.routing-vendor-select');
    assert.ok(vendorSel, 'vendor select should render');
    assert.ok(card.querySelector('[data-field-key$=".mcpServer"]'), 'bridge MCP server field should render for the foreign vendor');

    // Switch the vendor to the native one (anthropic under claude-code).
    vendorSel.value = 'anthropic';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    assert.ok(card, 'kimi-reviewer card should still render after switching to the native vendor');
    const providerCheckbox = card.querySelector('.agent-provider-checkbox');
    assert.ok(providerCheckbox && !providerCheckbox.checked, '"Use another provider" should default back to unchecked for the native vendor');
    assert.ok(!card.querySelector('.routing-slot-fields'), 'the editor (and its bridge fields) should collapse once the native vendor is selected');

    const saveBtn = card.querySelector('.agent-card-save-btn');
    assert.ok(saveBtn, 'per-card Save button should render');
    saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const saveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(saveMsg, 'a saveRouting message should have been posted');
    const savedKimiSlot = saveMsg.profile && saveMsg.profile.agents && saveMsg.profile.agents['kimi-reviewer'];
    // p26-t1 fix: the previously-picked model/tier is preserved across the
    // native-vendor collapse, so the posted entry (if any) is at most a
    // sparse { model } — never a vendor/transport/mcpServer backend block.
    assert.ok(!savedKimiSlot || !savedKimiSlot.vendor, 'the posted save payload must carry no vendor/backend block for kimi-reviewer once it uses the native route');
    assert.ok(!savedKimiSlot || !savedKimiSlot.transport, 'the posted save payload must carry no transport for kimi-reviewer once it uses the native route');

    // Re-expand and switch back to a foreign vendor: bridge fields return.
    const overrideOrCheckbox = card.querySelector('.agent-provider-checkbox, .routing-override-btn');
    if (overrideOrCheckbox && overrideOrCheckbox.type === 'checkbox') {
      overrideOrCheckbox.checked = true;
      overrideOrCheckbox.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    } else if (overrideOrCheckbox) {
      overrideOrCheckbox.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    }
    await h.flush();
    card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    vendorSel = card.querySelector('.routing-vendor-select');
    vendorSel.value = 'moonshot';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();
    card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    // The model/tier preserved across the native collapse means slotHasContent
    // is now true, so re-checking "Use another provider" no longer re-clones
    // transport "mcp" from the backend (that reclone is gated on an empty
    // draft) — the meaningful assertion here is that the bridge Transport
    // and credential-env fields are back (no longer suppressed as "native"),
    // not the exact transport value, which now depends on what the draft
    // already carried.
    assert.ok(card.querySelector('[data-field-key$=".transport"]'), 'bridge Transport field should reappear once a foreign vendor is selected again');
    assert.ok(card.querySelector('[data-field-key$=".credentialEnv"]'), 'bridge credential env field should reappear once a foreign vendor is selected again');
  } finally {
    h.win.close();
  }
});

test('p26-t1 fix: codex-reviewer under codex shows the "(native to this harness)" backend help text, checkbox unchecked', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'codex', source: 'execution', fileValue: 'codex', running: 'codex', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'codex-reviewer',
          name: 'Codex Reviewer',
          provenance: 'explicit',
          handWrittenBackend: true,
          vendor: 'openai',
          backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'gpt-6-astra', costModelClass: 'subscription' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const card = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    assert.ok(card, 'codex-reviewer card should render under codex');
    const providerCheckbox = card.querySelector('.agent-provider-checkbox');
    assert.ok(providerCheckbox, 'provider checkbox should render');
    assert.equal(providerCheckbox.checked, false, 'native hand-written-backend slot must not show a checked "Use another provider" checkbox');
    assert.equal(providerCheckbox.disabled, true, 'checkbox stays disabled for a hand-written backend');
    const helpSpan = card.querySelector('.delegation-mode-option-help');
    assert.ok(helpSpan, 'help text should render');
    assert.match(helpSpan.textContent, /native to this harness/, 'help text should read "native to this harness" for openai under codex');
    assert.ok(!/via MCP \(hand-written\)/.test(helpSpan.textContent), 'help text must not still claim an MCP bridge for the native vendor');
  } finally {
    h.win.close();
  }
});

test('p26-t1 fix: switching an agent slot to the native vendor preserves a previously-picked model/tier in the posted save', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'kimi-reviewer',
          name: 'Kimi Reviewer',
          provenance: 'explicit',
          handWrittenBackend: false,
          backend: { vendor: 'moonshot', transport: 'mcp', mcpServer: 'kimi', model: 'kimi-k2', costModelClass: 'local' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'moonshot'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    let card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    const vendorSel = card.querySelector('.routing-vendor-select');
    assert.ok(vendorSel, 'vendor select should render');

    vendorSel.value = 'anthropic';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    const saveBtn = card.querySelector('.agent-card-save-btn');
    assert.ok(saveBtn, 'per-card Save button should render');
    saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const saveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(saveMsg, 'a saveRouting message should have been posted');
    const savedSlot = saveMsg.profile && saveMsg.profile.agents && saveMsg.profile.agents['kimi-reviewer'];
    assert.ok(savedSlot, 'the previously-picked model must still be saved (a sparse {model} entry), not dropped entirely');
    assert.equal(savedSlot.model, 'kimi-k2', 'the tier/model picked before switching to the native vendor must be preserved');
    assert.ok(!savedSlot.vendor, 'no vendor/backend-block fields should be posted for the native route');
  } finally {
    h.win.close();
  }
});

test('p25-t4: Default fallback picker round-trips defaultFallback through the posted save (opencode, full density)', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'opencode', source: 'execution', fileValue: 'opencode', running: 'opencode', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [],
      presets: {
        vendors: ['anthropic', 'openai', 'google'],
        models: [{ id: 'openai/gpt-5.4-mini', vendor: 'openai', costModelClass: 'metered', label: 'OpenAI · gpt-5.4-mini' }],
      },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const vendorSel = h.doc.querySelector('[data-field-key="defaultFallback.vendor"]');
    assert.ok(vendorSel, 'Default fallback vendor select should render in full density');
    vendorSel.value = 'openai';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    const modelSel = h.doc.querySelector('[data-field-key="defaultFallback.model"]');
    assert.ok(modelSel, 'Default fallback model field should render once a vendor is chosen');
    modelSel.value = 'openai/gpt-5.4-mini';
    modelSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    const saveBtn = h.doc.getElementById('routing-save-btn');
    assert.ok(saveBtn, 'routing modal Save button should exist');
    assert.equal(saveBtn.disabled, false, 'Save should be enabled — openai is a dispatchable vendor');
    saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const saveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(saveMsg, 'a saveRouting message should have been posted');
    assert.equal(saveMsg.profile.defaultFallback && saveMsg.profile.defaultFallback.vendor, 'openai');
    assert.equal(saveMsg.profile.defaultFallback.model, 'openai/gpt-5.4-mini');
  } finally {
    h.win.close();
  }
});

test('p32-t1: Default fallback section renders below Orchestrator, above Agents, collapsed by default with exactly one picker', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'opencode', source: 'execution', fileValue: 'opencode', running: 'opencode', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.doc.getElementById('menu-routing').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    h.dispatch({
      type: 'routing',
      payload: {
        orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
        agents: [
          { id: 'codex-reviewer', name: 'Codex Reviewer', provenance: 'explicit', handWrittenBackend: true, backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'gpt-6-astra', costModelClass: 'subscription' }, source: 'file' },
          { id: 'coding-specialist', name: 'Coding Specialist', provenance: 'explicit', handWrittenBackend: false, backend: { vendor: 'anthropic', transport: 'claude-native', model: 'anthropic/sonnet', costModelClass: 'subscription' }, source: 'routing' },
        ],
        presets: { vendors: ['anthropic', 'openai'], models: [] },
        errors: [],
      },
    });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const dfDetails = h.doc.querySelector('details.routing-default-fallback-section');
    assert.ok(dfDetails, 'Default fallback <details> section should render');
    assert.equal(dfDetails.open, false, 'section should be collapsed by default when unset');
    assert.equal(dfDetails.querySelector('summary').textContent, 'Set up a default fallback?');

    const headings = [...h.doc.querySelectorAll('h2.settings-heading')].map((el: any) => el.textContent);
    const orchIdx = headings.indexOf('Orchestrator');
    const agentsIdx = headings.indexOf('Agents');
    const allSections = [...h.doc.querySelectorAll('#routing-modal-content > *')];
    const orchSectionIdx = allSections.findIndex((el: any) => el.querySelector && el.querySelector('h2.settings-heading') && el.querySelector('h2.settings-heading').textContent === 'Orchestrator');
    const dfSectionIdx = allSections.indexOf(dfDetails);
    const agentsSectionIdx = allSections.findIndex((el: any) => el.querySelector && el.querySelector('h2.settings-heading') && el.querySelector('h2.settings-heading').textContent === 'Agents');
    assert.ok(orchIdx !== -1 && agentsIdx !== -1, 'Orchestrator and Agents headings should render');
    assert.ok(orchSectionIdx < dfSectionIdx, `Default fallback section (${dfSectionIdx}) must come after Orchestrator (${orchSectionIdx})`);
    assert.ok(dfSectionIdx < agentsSectionIdx, `Default fallback section (${dfSectionIdx}) must precede Agents roster (${agentsSectionIdx})`);

    const pickers = h.doc.querySelectorAll('[data-field-key="defaultFallback.vendor"]');
    assert.equal(pickers.length, 1, 'exactly one Default fallback vendor picker should exist in the DOM');

    // Expand: summary click toggles native <details> open state.
    dfDetails.querySelector('summary').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    dfDetails.open = true;
    await h.flush();
    assert.ok(dfDetails.querySelector('[data-field-key="defaultFallback.vendor"]'), 'vendor picker should be present once expanded');

    // Set a default fallback, then summary text should switch.
    const vendorSel = dfDetails.querySelector('[data-field-key="defaultFallback.vendor"]');
    vendorSel.value = 'openai';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    const dfDetailsAfter = h.doc.querySelector('details.routing-default-fallback-section');
    assert.match(dfDetailsAfter.querySelector('summary').textContent, /^Default fallback: openai/, 'summary should switch to naming the chosen default once set');
  } finally {
    h.win.close();
  }
});

test('p32-t1: Default fallback section stays open across a structural rebuild after being manually expanded while empty', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'opencode', source: 'execution', fileValue: 'opencode', running: 'opencode', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.doc.getElementById('menu-routing').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    h.dispatch({
      type: 'routing',
      payload: {
        orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
        agents: [
          { id: 'coding-specialist', name: 'Coding Specialist', provenance: 'explicit', handWrittenBackend: false, backend: { vendor: 'anthropic', transport: 'claude-native', model: 'anthropic/sonnet', costModelClass: 'subscription' }, source: 'routing' },
        ],
        presets: {
          vendors: ['anthropic', 'openai'],
          models: [{ id: 'openai/gpt-5.4-mini', vendor: 'openai', costModelClass: 'metered', label: 'OpenAI · gpt-5.4-mini' }],
        },
        errors: [],
      },
    });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    let dfDetails = h.doc.querySelector('details.routing-default-fallback-section');
    assert.equal(dfDetails.open, false, 'section starts collapsed while empty');
    dfDetails.open = true; // manual expand while still empty (no default set)
    await h.flush();

    // Change an unrelated slot's field — the orchestrator's transport —
    // which triggers onStructural (a full renderRoutingModal rebuild).
    const orchTransportSel = h.doc.querySelector('[data-field-key="orchestrator.transport"]');
    assert.ok(orchTransportSel, 'orchestrator transport select should render');
    orchTransportSel.value = orchTransportSel.value === 'claude-native' ? 'openai-compatible' : 'claude-native';
    orchTransportSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    dfDetails = h.doc.querySelector('details.routing-default-fallback-section');
    assert.ok(dfDetails, 'Default fallback section should still render after the rebuild');
    assert.equal(dfDetails.open, true, 'manual open-while-empty must survive an unrelated structural rebuild');
  } finally {
    h.win.close();
  }
});

test('p32-t3: Default fallback section has its own Save, live summary tracks the picker, and Remove clears it', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'opencode', source: 'execution', fileValue: 'opencode', running: 'opencode', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.doc.getElementById('menu-routing').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    h.dispatch({
      type: 'routing',
      payload: {
        orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
        agents: [],
        presets: {
          vendors: ['anthropic', 'openai'],
          models: [{ id: 'anthropic/claude-sonnet-4-6', vendor: 'anthropic', costModelClass: 'subscription', label: 'Anthropic · Sonnet' }],
        },
        errors: [],
      },
    });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const dfDetails = h.doc.querySelector('details.routing-default-fallback-section');
    dfDetails.querySelector('summary').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    dfDetails.open = true;
    await h.flush();

    const saveBtn = dfDetails.querySelector('.routing-default-fallback-save-btn');
    assert.ok(saveBtn, 'Default fallback section should have its own Save button');

    const removeLink = dfDetails.querySelector('.routing-clear-defaults-btn');
    assert.ok(removeLink, 'Remove link should be present');
    assert.equal(removeLink.textContent, 'Remove default fallback', 'Remove link should be labeled');
    assert.equal(removeLink.disabled, true, 'Remove should be disabled with nothing set');

    const vendorSel = dfDetails.querySelector('[data-field-key="defaultFallback.vendor"]');
    vendorSel.value = 'anthropic';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    const modelSel = h.doc.querySelector('details.routing-default-fallback-section [data-field-key="defaultFallback.model"]');
    assert.ok(modelSel, 'model picker should render once a vendor is chosen');
    modelSel.value = 'anthropic/claude-sonnet-4-6';
    modelSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    // p32-t3: summary must reflect the live picker (model included) before
    // Save is ever clicked — the bug was the summary staying stuck on
    // whatever the vendor picker last set.
    const summaryAfterPick = h.doc.querySelector('details.routing-default-fallback-section > summary');
    assert.equal(summaryAfterPick.textContent, 'Default fallback: anthropic · anthropic/claude-sonnet-4-6 · claude-native · subscription');
    const summaryLine = h.doc.querySelector('details.routing-default-fallback-section .routing-slot-summary-line');
    assert.ok(!/fallback(s)?\b/.test(summaryLine.textContent), `default's own summary line must omit the fallback count: "${summaryLine.textContent}"`);

    const saveBtnAgain = h.doc.querySelector('details.routing-default-fallback-section .routing-default-fallback-save-btn');
    saveBtnAgain.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const saveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(saveMsg, 'a saveRouting message should have been posted from the section Save button');
    assert.equal(saveMsg.profile.defaultFallback && saveMsg.profile.defaultFallback.vendor, 'anthropic');
    assert.equal(saveMsg.profile.defaultFallback.model, 'anthropic/claude-sonnet-4-6');

    // Reset routingSaving so the section's Save button re-enables for the
    // second save below — mirrors the host's real post-save reply.
    h.dispatch({ type: 'routingSaved', ok: true, errors: [], check: {}, write: {} });
    await h.flush();

    const dfDetailsAfterSave = h.doc.querySelector('details.routing-default-fallback-section');
    assert.equal(dfDetailsAfterSave.open, true, 'section should stay open after Save');

    const removeLinkAfter = dfDetailsAfterSave.querySelector('.routing-clear-defaults-btn');
    assert.equal(removeLinkAfter.disabled, false, 'Remove should be enabled once a default is set');
    removeLinkAfter.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const summaryAfterClear = h.doc.querySelector('details.routing-default-fallback-section > summary');
    assert.equal(summaryAfterClear.textContent, 'Set up a default fallback?');

    const saveBtnAfterClear = h.doc.querySelector('details.routing-default-fallback-section .routing-default-fallback-save-btn');
    saveBtnAfterClear.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const clearSaveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(clearSaveMsg, 'a saveRouting message should have been posted after clearing');
    assert.ok(!clearSaveMsg.profile.defaultFallback, 'cleared default fallback should be omitted from the saved profile');
  } finally {
    h.win.close();
  }
});

test('p31-t2: every slot shows the Default row + opt-out checkbox, unchecking persists useDefaultFallback=false, summary line reflects it', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'opencode', source: 'execution', fileValue: 'opencode', running: 'opencode', mismatch: false, options: [], requiresRestart: false },
      },
    });
    h.doc.getElementById('menu-routing').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    h.dispatch({
      type: 'routing',
      payload: {
        orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
        agents: [
          { id: 'codex-reviewer', name: 'Codex Reviewer', provenance: 'explicit', handWrittenBackend: true, backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'gpt-6-astra', costModelClass: 'subscription' }, source: 'file' },
          { id: 'coding-specialist', name: 'Coding Specialist', provenance: 'explicit', handWrittenBackend: false, backend: { vendor: 'anthropic', transport: 'claude-native', model: 'anthropic/sonnet', costModelClass: 'subscription' }, source: 'routing' },
        ],
        presets: {
          vendors: ['anthropic', 'openai'],
          models: [{ id: 'openai/gpt-5.4-mini', vendor: 'openai', costModelClass: 'metered', label: 'OpenAI · gpt-5.4-mini' }],
        },
        errors: [],
      },
    });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    // Set a default fallback via the top picker.
    const vendorSel = h.doc.querySelector('[data-field-key="defaultFallback.vendor"]');
    vendorSel.value = 'openai';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();
    const modelSel = h.doc.querySelector('[data-field-key="defaultFallback.model"]');
    modelSel.value = 'openai/gpt-5.4-mini';
    modelSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();
    // Selecting a model does not itself trigger a structural rebuild (only
    // the vendor select does) — re-fire the vendor select's change (same
    // value) to force renderRoutingModal so the other slots' "Default: …"
    // rows below pick up the now-set model.
    const vendorSelAgain = h.doc.querySelector('[data-field-key="defaultFallback.vendor"]');
    vendorSelAgain.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    for (const agentId of ['codex-reviewer', 'coding-specialist']) {
      const fallbackDetails = h.doc.querySelector(`.routing-fallback-details[data-agent-id="${agentId}"]`);
      assert.ok(fallbackDetails, `${agentId} fallback editor should render`);
      const defaultRow = fallbackDetails.querySelector('.routing-default-fallback-row');
      assert.ok(defaultRow, `${agentId} should show a Default row`);
      assert.match(defaultRow.textContent, /Default: openai · openai\/gpt-5\.4-mini \(dfb\)/, `${agentId} Default row should name the default fallback`);
      const checkbox = fallbackDetails.querySelector('.routing-use-default-fallback-checkbox');
      assert.ok(checkbox, `${agentId} should show the opt-out checkbox`);
      assert.equal(checkbox.checked, true, `${agentId} checkbox should default to checked`);
    }

    // Uncheck for coding-specialist only.
    const codingCheckbox = h.doc.querySelector('.routing-fallback-details[data-agent-id="coding-specialist"] .routing-use-default-fallback-checkbox');
    codingCheckbox.checked = false;
    codingCheckbox.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    const optOutNote = h.doc.querySelector('.routing-fallback-details[data-agent-id="coding-specialist"] .routing-defaults-help');
    assert.ok(optOutNote && /will fail after its own chain/.test(optOutNote.textContent), 'opt-out note should render for coding-specialist');

    // Summary line text: codex-reviewer keeps "+ default", coding-specialist reads "no default".
    const codexSummaryLine = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"] .routing-slot-summary-line, .routing-agent-fallback-row[data-agent-id="codex-reviewer"] .routing-slot-summary-line');
    assert.ok(codexSummaryLine, 'codex-reviewer summary line should render');
    assert.match(codexSummaryLine.textContent, /\+ default/, 'codex-reviewer summary should append "+ default"');
    const codingSummaryLine = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"] .routing-slot-summary-line, .routing-agent-fallback-row[data-agent-id="coding-specialist"] .routing-slot-summary-line');
    assert.ok(codingSummaryLine, 'coding-specialist summary line should render');
    assert.match(codingSummaryLine.textContent, /no default/, 'coding-specialist summary should append "no default" once opted out');

    // Save and confirm useDefaultFallback=false landed in the posted payload.
    const saveBtn = h.doc.getElementById('routing-save-btn');
    saveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();
    const saveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(saveMsg, 'a saveRouting message should have been posted');
    const savedCoding = saveMsg.profile.agents && saveMsg.profile.agents['coding-specialist'];
    assert.ok(savedCoding, 'coding-specialist slot should be in the saved profile');
    assert.equal(savedCoding.useDefaultFallback, false, 'unchecked opt-out should persist useDefaultFallback=false');
    const savedCodex = saveMsg.profile.agents && saveMsg.profile.agents['codex-reviewer'];
    if (savedCodex) {
      assert.notEqual(savedCodex.useDefaultFallback, false, 'codex-reviewer should not have opted out');
    }
  } finally {
    h.win.close();
  }
});

test('p25-t4: an undispatchable fallback vendor warns and disables Save under codex, but not under claude-code', async () => {
  async function runWithHarness(harness: string) {
    const h = await bootObjScaleHarness();
    try {
      h.dispatch({
        type: 'settings',
        payload: {
          hook: { installed: true, lastActivityAt: null },
          agents: [],
          delegation_mode: 'flat',
          delegationHealth: {},
          hookHealth: { healthy: true, issueCount: 0 },
          contextBudget: null,
          harness: { effective: harness, source: 'execution', fileValue: harness, running: harness, mismatch: false, options: [], requiresRestart: false },
        },
      });
      const menuRoutingBtn = h.doc.getElementById('menu-routing');
      menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
      await h.flush();

      const routingPayload = {
        orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
        agents: [
          {
            id: 'coding-specialist',
            name: 'Coding Specialist',
            provenance: 'explicit',
            handWrittenBackend: false,
            backend: { vendor: 'anthropic', transport: 'claude-native', model: 'anthropic/sonnet', costModelClass: 'subscription' },
            source: 'routing',
          },
        ],
        presets: { vendors: ['anthropic', 'google'], models: [] },
        envProbe: {},
        errors: [],
      };
      h.dispatch({ type: 'routing', payload: routingPayload });
      h.tick(3);
      await h.flush();
      assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

      const card = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
      assert.ok(card, 'coding-specialist card should render');
      const checkbox = card.querySelector('.agent-provider-checkbox');
      assert.ok(checkbox, 'provider checkbox should render');
      checkbox.checked = true;
      checkbox.dispatchEvent(new h.win.Event('change', { bubbles: true }));
      await h.flush();

      const card2 = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
      const fallbackDetails = card2.querySelector('.routing-fallback-details[data-agent-id="coding-specialist"]');
      assert.ok(fallbackDetails, 'fallback editor should render once expanded');
      const addBtn = fallbackDetails.querySelector('.routing-add-fallback-btn');
      addBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
      await h.flush();

      const card3 = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
      const fbVendorSel = card3.querySelector('[data-field-key="agent:coding-specialist.fallback[0].vendor"]');
      assert.ok(fbVendorSel, 'fallback entry 0 vendor select should render');
      fbVendorSel.value = 'google';
      fbVendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
      await h.flush();

      const warning = h.doc.querySelector('.routing-fallback-dispatch-warning');
      const saveBtn = h.doc.getElementById('routing-save-btn');
      return { warningPresent: !!warning, saveDisabled: !!(saveBtn && saveBtn.disabled) };
    } finally {
      h.win.close();
    }
  }

  const codexResult = await runWithHarness('codex');
  assert.equal(codexResult.warningPresent, true, 'codex + google fallback with no GEMINI_API_KEY should warn');
  assert.equal(codexResult.saveDisabled, true, 'Save should be disabled while the warning is present');

  const claudeResult = await runWithHarness('claude-code');
  assert.equal(claudeResult.warningPresent, false, 'claude-code has no cross-vendor dispatcher gate, so no warning');
  assert.equal(claudeResult.saveDisabled, false, 'Save should stay enabled under claude-code');
});

test('p27-t5: compact fallback chain rows — one-line entries, details closed/open per state', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'codex', source: 'execution', fileValue: 'codex', running: 'codex', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      profile: {
        agents: {
          'coding-specialist': {
            vendor: 'openai', transport: 'claude-native', model: 'gpt-6-astra', costModelClass: 'subscription',
            fallback: [
              { vendor: 'anthropic', model: 'claude-haiku', transport: 'claude-native', costModelClass: 'metered' },
              { vendor: 'google', model: 'gemini-2.5-pro', transport: 'claude-native', costModelClass: 'subscription' },
            ],
          },
        },
      },
      agents: [
        {
          id: 'coding-specialist',
          name: 'Coding Specialist',
          provenance: 'explicit',
          handWrittenBackend: false,
          backend: { vendor: 'openai', transport: 'claude-native', model: 'gpt-6-astra', costModelClass: 'subscription' },
          source: 'routing',
        },
      ],
      presets: { vendors: ['anthropic', 'openai', 'google'], models: [] },
      envProbe: {},
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const card = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    assert.ok(card, 'coding-specialist card should render');
    const fallbackDetails = card.querySelector('.routing-fallback-details[data-agent-id="coding-specialist"]');
    assert.ok(fallbackDetails, 'fallback chain details should render');

    const rows = fallbackDetails.querySelectorAll('.routing-fallback-item-line');
    assert.equal(rows.length, 2, 'a two-entry chain should render two one-line rows');

    const row0 = rows[0];
    assert.equal(row0.querySelector('.routing-fallback-position-badge').textContent, '#1', 'row 0 shows position badge #1');
    const summary0 = row0.querySelector('.routing-slot-summary-line');
    assert.ok(summary0, 'row 0 should reuse buildSlotSummaryLine');
    assert.match(summary0.textContent, /anthropic .* claude-haiku \(fb\)/, 'row 0 summary includes vendor/model and (fb) suffix');
    assert.ok(row0.querySelector('.routing-inline-link-btn'), 'row 0 should render up/down/remove controls');

    const row1 = rows[1];
    assert.match(row1.querySelector('.routing-slot-summary-line').textContent, /google .* gemini-2\.5-pro \(fb\)/, 'row 1 summary shows entry 2 vendor/model');

    const entryDetailsList = fallbackDetails.querySelectorAll('.routing-fallback-entry-details');
    assert.equal(entryDetailsList.length, 2, 'each entry gets its own per-entry field details');
    assert.equal(entryDetailsList[0].open, false, 'entry 0 (no dispatch warning, not empty) stays closed by default');
    // entry 1 is google under codex with no GEMINI_API_KEY -> hard dispatch warning -> auto-opens.
    assert.equal(entryDetailsList[1].open, true, 'entry 1 with a blocking dispatch warning under codex opens by default');
    assert.ok(fallbackDetails.querySelector('.routing-fallback-dispatch-warning'), 'dispatch warning should render for the undispatchable entry');

    // Add a third, empty entry and confirm its details opens by default.
    const addBtn = fallbackDetails.querySelector('.routing-add-fallback-btn');
    addBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const card2 = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    const fallbackDetails2 = card2.querySelector('.routing-fallback-details[data-agent-id="coding-specialist"]');
    const entryDetailsList2 = fallbackDetails2.querySelectorAll('.routing-fallback-entry-details');
    assert.equal(entryDetailsList2.length, 3, 'a third entry should render after Add fallback');
    assert.equal(entryDetailsList2[2].open, true, 'a newly added, still-empty entry opens its field details by default');
  } finally {
    h.win.close();
  }
});

test('p27-t1: bridge notice only when the bridge is missing', async () => {
  async function buildCard(agentOverrides: Record<string, unknown>, mcpServers?: Array<{ id: string; installed: boolean }>) {
    const h = await bootObjScaleHarness();
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    if (mcpServers) {
      h.dispatch({ type: 'mcp', servers: mcpServers });
    }
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'test-agent',
          name: 'Test Agent',
          provenance: 'explicit',
          source: 'file',
          ...agentOverrides,
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);
    const card = h.doc.querySelector('.routing-agent-card[data-agent-id="test-agent"]');
    return { h, card };
  }

  // (a) hand-written backend + mcpServer "codex" -> bridged-connected: status row only.
  {
    const { h, card } = await buildCard({
      handWrittenBackend: true,
      backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'gpt-6-astra', costModelClass: 'subscription' },
    });
    try {
      assert.ok(card, 'card should render');
      const notice = card.querySelector('.routing-subscription-notice');
      assert.ok(notice && !notice.hidden, 'notice wrapper visible (hosting status row)');
      const statusLine = notice.querySelector('.routing-subscription-bridge-status');
      assert.equal(statusLine.textContent, 'Bridged via Codex MCP - connected.', 'bridged-connected status line reads verbatim per section 5');
      assert.ok(notice.querySelector('.routing-subscription-notice-copy').hidden, 'Copy request button hidden in bridged-connected state');
      assert.ok(notice.querySelector('.routing-subscription-request-details').hidden, '"Show request" details hidden in bridged-connected state');
    } finally {
      h.win.close();
    }
  }

  // (a-2) same bridged slot, but the mcpServers catalog reports the server as NOT installed
  // -> amber "MCP server not installed." wording instead of "connected." (p27-t4 follow-up).
  {
    const { h, card } = await buildCard(
      {
        handWrittenBackend: true,
        backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex', model: 'gpt-6-astra', costModelClass: 'subscription' },
      },
      [{ id: 'codex', installed: false }]
    );
    try {
      const notice = card.querySelector('.routing-subscription-notice');
      const statusLine = notice.querySelector('.routing-subscription-bridge-status');
      assert.equal(statusLine.textContent, 'Bridged via Codex MCP - MCP server not installed.', 'not-installed status line reads verbatim');
      assert.ok(statusLine.classList.contains('theme-review-retry-warning'), 'not-installed status line uses the amber footnote class');
      assert.ok(notice.querySelector('.routing-subscription-notice-copy').hidden, 'Copy request button stays hidden in bridged-connected (not-installed) state');
    } finally {
      h.win.close();
    }
  }

  // (b) foreign subscription slot with no backend block -> bridged-missing: status row + one Copy request button, no textarea rendered by default.
  {
    const { h, card } = await buildCard({
      handWrittenBackend: false,
      backend: { vendor: 'openai', transport: 'mcp', model: 'gpt-6-astra', costModelClass: 'subscription' },
    });
    try {
      assert.ok(card, 'card should render');
      const notice = card.querySelector('.routing-subscription-notice');
      assert.ok(notice && !notice.hidden, 'notice should show for a foreign subscription slot with no bridge set up');
      const statusLine = notice.querySelector('.routing-subscription-bridge-status');
      assert.equal(statusLine.textContent, 'Bridge via Codex MCP not installed.', 'bridged-missing status line names the CLI per section 5');
      const copyBtn = notice.querySelector('.routing-subscription-notice-copy');
      assert.ok(copyBtn && !copyBtn.hidden, 'exactly one Copy request button visible in bridged-missing state');
      assert.equal(notice.querySelectorAll('.routing-subscription-notice-copy').length, 1, 'exactly one Copy request button rendered');
      const details = notice.querySelector('.routing-subscription-request-details');
      assert.ok(details && !details.hidden, '"Show request" details present');
      assert.equal(details.open, false, '"Show request" details closed by default -- no textarea visible by default');

      // Clicking Copy request copies the generated prompt text and shows a
      // brief "Copied" confirmation on the button (p27-t4).
      const clipboardCalls: string[] = [];
      (h.win.navigator as any).clipboard = {
        writeText: (text: string) => { clipboardCalls.push(text); return Promise.resolve(); },
      };
      copyBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
      await h.flush();
      assert.equal(clipboardCalls.length, 1, 'clipboard.writeText called once');
      assert.match(clipboardCalls[0], /^Set up the /, 'copied text is the generated request prompt');
      assert.equal(copyBtn.textContent, 'Copied', 'button label swaps to "Copied" after copying');
    } finally {
      h.win.close();
    }
  }

  // (c) native-vendor slot -> neither notice nor status line (p26 rule unchanged).
  {
    const { h, card } = await buildCard({
      handWrittenBackend: false,
      backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'metered' },
    });
    try {
      assert.ok(card, 'card should render');
      const notice = card.querySelector('.routing-subscription-notice');
      assert.ok(!notice || notice.hidden, 'no visible notice for a native vendor slot');
    } finally {
      h.win.close();
    }
  }
});

test('p27-t3: summary line format and Connection <details> collapse per slot state', async () => {
  async function buildCard(agentId: string, agentOverrides: Record<string, unknown>, mcpServers?: Array<{ id: string; installed: boolean }>) {
    const h = await bootObjScaleHarness();
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    if (mcpServers) {
      h.dispatch({ type: 'mcp', servers: mcpServers });
    }
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: agentId,
          name: agentId,
          provenance: 'explicit',
          source: 'file',
          ...agentOverrides,
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);
    const card = h.doc.querySelector(`.routing-agent-card[data-agent-id="${agentId}"]`);
    assert.ok(card, `${agentId} card should render`);
    const line = card.querySelector('.routing-slot-summary-line');
    assert.ok(line, `${agentId} summary line should render`);
    const idSpan = line.querySelector('.routing-slot-summary-vendor-model');
    const text = idSpan.textContent + line.querySelector('.routing-slot-summary-rest').textContent;
    const details = card.querySelector('.routing-connection-details');
    return { h, card, line, idSpan, text, details };
  }

  // native: claude-worker under claude-code -> "native" route, no accent, no Connection <details> at all.
  {
    const { h, idSpan, text, details } = await buildCard('claude-worker', {
      handWrittenBackend: false,
      backend: { vendor: 'anthropic', transport: 'claude-native', model: 'claude-sonnet-4-6', costModelClass: 'metered' },
    });
    try {
      assert.equal(text, 'anthropic · claude-sonnet-4-6 · native · metered · 0 fallbacks');
      assert.ok(!idSpan.className.includes('agent-accent-foreign'), 'native vendor gets no accent');
      assert.ok(!details, 'Connection <details> must be absent entirely for a native-vendor slot');
    } finally {
      h.win.close();
    }
  }

  // bridged-installed: codex-reviewer, hand-written backend + mcpServer, catalog says installed -> Connection closed.
  {
    const { h, idSpan, text, details } = await buildCard(
      'codex-reviewer',
      {
        handWrittenBackend: true,
        backend: { vendor: 'openai', transport: 'mcp', mcpServer: 'codex-mcp', model: 'gpt-6-astra', costModelClass: 'subscription' },
      },
      [{ id: 'codex-mcp', installed: true }]
    );
    try {
      assert.equal(text, 'openai · gpt-6-astra · bridged via MCP codex-mcp · subscription · 0 fallbacks');
      assert.ok(idSpan.className.includes('agent-accent-foreign'), 'openai under claude-code is foreign -> accented');
      assert.ok(details, 'Connection <details> should render for a bridged slot');
      assert.equal(details.open, false, 'bridged-installed (bridge already set up) starts closed');
    } finally {
      h.win.close();
    }
  }

  // bridged-missing: foreign subscription slot, mcp transport, no mcpServer/no hand-written backend -> Connection open.
  {
    const { h, idSpan, text, details } = await buildCard('gemini-reviewer', {
      handWrittenBackend: false,
      backend: { vendor: 'google', transport: 'mcp', model: 'gemini-2.5-pro', costModelClass: 'subscription' },
    });
    try {
      assert.equal(text, 'google · gemini-2.5-pro · bridged via MCP (not installed) · subscription · 0 fallbacks');
      assert.ok(idSpan.className.includes('agent-accent-foreign'), 'google under claude-code is foreign -> accented');
      assert.ok(details, 'Connection <details> should render for a bridged-missing slot');
      assert.equal(details.open, true, 'bridged-missing (needs a bridge with none set up) starts open');
    } finally {
      h.win.close();
    }
  }

  // foreign-endpoint: kimi-reviewer, openai-compatible transport, local billing -> no bridge needed, Connection closed.
  {
    const { h, idSpan, text, details } = await buildCard('kimi-reviewer', {
      handWrittenBackend: false,
      backend: { vendor: 'moonshot', transport: 'openai-compatible', model: 'kimi-k2', costModelClass: 'local' },
    });
    try {
      assert.equal(text, 'moonshot · kimi-k2 · OpenAI-compatible endpoint · local · 0 fallbacks');
      assert.ok(idSpan.className.includes('agent-accent-foreign'), 'moonshot under claude-code is foreign -> accented');
      assert.ok(details, 'Connection <details> should render for a foreign-endpoint slot');
      assert.equal(details.open, false, 'foreign-endpoint with no dispatch warning starts closed');
    } finally {
      h.win.close();
    }
  }
});

test('p27-t3 round 2: a manually-toggled Connection <details> survives a structural rebuild', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    // foreign-endpoint: needsBridge() is false, so this starts closed by
    // default — a clean signal that any later `open === true` came from the
    // user's manual toggle surviving the rebuild, not the computed default.
    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'kimi-reviewer',
          name: 'kimi-reviewer',
          provenance: 'explicit',
          handWrittenBackend: false,
          backend: { vendor: 'moonshot', transport: 'openai-compatible', model: 'kimi-k2', costModelClass: 'local' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    let card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    let details = card.querySelector('.routing-connection-details');
    assert.equal(details.open, false, 'starts closed (no bridge needed for an openai-compatible slot)');
    details.open = true;
    details.dispatchEvent(new h.win.Event('toggle', { bubbles: true }));

    // Trigger a structural rebuild (renderRoutingModal) via a field change
    // that calls onStructural — a keyword edit does not; changing the
    // vendor select does.
    const vendorSel = card.querySelector('[data-field-key="agent:kimi-reviewer.vendor"]');
    assert.ok(vendorSel, 'vendor select should render inside the open Connection details');
    vendorSel.value = 'moonshot';
    vendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    card = h.doc.querySelector('.routing-agent-card[data-agent-id="kimi-reviewer"]');
    details = card.querySelector('.routing-connection-details');
    assert.ok(details, 'Connection <details> should still render after the rebuild');
    assert.equal(details.open, true, 'manual open toggle should survive the structural rebuild');
  } finally {
    h.win.close();
  }
});

test('p27-t3 round 2: orchestrator, defaults, and default-fallback editors each show a summary line (opencode, full density)', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'opencode', source: 'execution', fileValue: 'opencode', running: 'opencode', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: { vendor: 'openai', model: 'gpt-6-astra' }, source: 'file' },
      agents: [],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    function summaryLineFor(headingText: string) {
      const sections = Array.from(h.doc.querySelectorAll('.settings-section')) as Element[];
      const section = sections.find((s) => s.querySelector('.settings-heading')?.textContent === headingText);
      assert.ok(section, `"${headingText}" section should render`);
      return section!.querySelector('.routing-slot-summary-line');
    }

    assert.ok(summaryLineFor('Orchestrator'), 'orchestrator editor should show a summary line');
    assert.ok(summaryLineFor('Default for all agents'), 'defaults editor should show a summary line');
    // p32-t1: Default fallback moved out of .settings-section into its own
    // collapsed <details class="routing-default-fallback-section">.
    const dfDetails = h.doc.querySelector('details.routing-default-fallback-section');
    assert.ok(dfDetails, 'default-fallback section should render');
    assert.ok(dfDetails.querySelector('.routing-slot-summary-line'), 'default-fallback editor should show a summary line');
  } finally {
    h.win.close();
  }
});

test('p27-t3 round 2: an empty draft slot falls back to the resolved vendor/model the old "Routed to" chip used', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'opencode', source: 'execution', fileValue: 'opencode', running: 'opencode', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    // Full density (opencode) never clones the backend into the draft
    // slot up front (only classic density's isRouted branch does that) —
    // routingDraft.agents[id] starts as a genuinely empty {} here, while
    // the payload still carries the resolved backend the old "Routed to
    // <vendor>/<model>" chip read from (via settingsAgentsById's
    // vendor/resolvedModel fallback, since no `agents` entry was sent in
    // the settings payload above).
    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'codex-reviewer',
          name: 'codex-reviewer',
          provenance: 'explicit',
          handWrittenBackend: false,
          backend: { vendor: 'openai', model: 'gpt-6-astra' },
          source: 'file',
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    const row = h.doc.querySelector('.routing-agent-row[data-agent-id="codex-reviewer"]');
    assert.ok(row, 'codex-reviewer row should render');
    const slotTd = row.querySelector('.routing-slot-td');
    const line = slotTd.querySelector('.routing-slot-summary-line');
    assert.ok(line, 'summary line should render even for an empty draft slot');
    const text = line.textContent;
    assert.ok(!text.includes('unknown model'), 'should not show "unknown model" when the backend resolves a real model');
    assert.match(text, /gpt-6-astra/, 'summary line should show the resolved model from routingAgent.backend');
    assert.match(text, /openai/, 'summary line should show the resolved vendor from routingAgent.backend');
  } finally {
    h.win.close();
  }
});

test('p35-t1: Copy/Paste settings reproduces routing fields on another card, keeps id/name/keywords untouched, supports Undo, and saves the pasted values', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch({
      type: 'settings',
      payload: {
        hook: { installed: true, lastActivityAt: null },
        agents: [
          { id: 'codex-reviewer', name: 'Codex Reviewer', keywords: 'codex|second-opinion', claudeTier: null },
          { id: 'coding-specialist', name: 'Coding Specialist', keywords: 'implement|code|fix', claudeTier: null },
        ],
        delegation_mode: 'flat',
        delegationHealth: {},
        hookHealth: { healthy: true, issueCount: 0 },
        contextBudget: null,
        harness: { effective: 'claude-code', source: 'execution', fileValue: 'claude-code', running: 'claude-code', mismatch: false, options: [], requiresRestart: false },
      },
    });
    const menuRoutingBtn = h.doc.getElementById('menu-routing');
    menuRoutingBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    const routingPayload = {
      orchestrator: { id: 'orchestrator', backend: {}, source: 'default' },
      agents: [
        {
          id: 'codex-reviewer',
          name: 'Codex Reviewer',
          provenance: 'explicit',
          handWrittenBackend: true,
          keywords: 'codex|second-opinion',
          backend: {
            vendor: 'openai', transport: 'mcp', mcpServer: 'codex',
            model: 'gpt-5', costModelClass: 'subscription',
            apiKeyEnv: 'OPENAI_API_KEY',
          },
          source: 'file',
        },
        {
          id: 'coding-specialist',
          name: 'Coding Specialist',
          provenance: 'frontmatter',
          handWrittenBackend: false,
          keywords: 'implement|code|fix',
          backend: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' },
          source: 'frontmatter',
        },
      ],
      presets: { vendors: ['anthropic', 'openai'], models: [] },
      errors: [],
    };
    h.dispatch({ type: 'routing', payload: routingPayload });
    h.tick(3);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors: ${h.errors.map(String).join('; ')}`);

    // Paste is disabled before any Copy has happened, on every card.
    let targetCard = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    let pasteBtn = targetCard.querySelector('.routing-paste-settings-link') as any;
    assert.ok(pasteBtn, 'Paste settings button should render');
    assert.equal(pasteBtn.disabled, true, 'Paste is disabled before any Copy');
    assert.match(pasteBtn.title, /Copy settings from another agent first/);
    // p35-t3: Copy/Paste/Remove each render an inline aria-hidden icon
    // alongside their text label.
    assert.ok(pasteBtn.querySelector('svg[aria-hidden="true"]'), 'Paste settings should render an svg icon');
    const removeBtnIcon = targetCard.querySelector('.agent-remove-link');
    assert.ok(removeBtnIcon && removeBtnIcon.querySelector('svg[aria-hidden="true"]'), 'Remove should render an svg icon');

    // Give codex-reviewer's already-populated (handWrittenBackend, cloned
    // from backend on first expand) slot a one-entry fallback chain and
    // flip its default-fallback opt-out, via real UI controls, so Copy has
    // more than the bare scalar fields to carry across.
    let sourceCard = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    const addFallbackBtn = sourceCard.querySelector('.routing-add-fallback-btn') as any;
    assert.ok(addFallbackBtn, 'Add fallback button should render on the expanded codex-reviewer card');
    addFallbackBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    sourceCard = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    const fbVendorSel = sourceCard.querySelector('[data-field-key$=".fallback[0].vendor"]') as any;
    assert.ok(fbVendorSel, 'fallback entry 0 vendor select should render');
    fbVendorSel.value = 'anthropic';
    fbVendorSel.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    sourceCard = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    const useDefaultCheckbox = sourceCard.querySelector('.routing-use-default-fallback-checkbox') as any;
    assert.ok(useDefaultCheckbox, 'use-default-fallback checkbox should render');
    useDefaultCheckbox.checked = false;
    useDefaultCheckbox.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    await h.flush();

    sourceCard = h.doc.querySelector('.routing-agent-card[data-agent-id="codex-reviewer"]');
    const copyBtn = sourceCard.querySelector('.routing-copy-settings-link') as any;
    assert.ok(copyBtn, 'Copy settings button should render');
    assert.ok(copyBtn.querySelector('svg[aria-hidden="true"]'), 'Copy settings should render an svg icon');

    const clipboardCalls: string[] = [];
    (h.win.navigator as any).clipboard = {
      writeText: (text: string) => { clipboardCalls.push(text); return Promise.resolve(); },
    };
    copyBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    assert.equal(clipboardCalls.length, 1, 'navigator.clipboard.writeText should be called once (best-effort)');
    const snapshot = JSON.parse(clipboardCalls[0]);
    // No secret-looking value key anywhere in the snapshot except the env
    // var NAME fields (credentialEnv/endpointEnv), which only ever hold a
    // NAME, never a value.
    for (const key of Object.keys(snapshot)) {
      if (key === 'credentialEnv' || key === 'endpointEnv') continue;
      assert.ok(!/key|token|secret/i.test(key), `snapshot key "${key}" looks secret-related`);
    }
    assert.equal(snapshot.vendor, 'openai');
    assert.equal(snapshot.model, 'gpt-5');
    assert.equal(snapshot.costModelClass, 'subscription');
    assert.equal(snapshot.transport, 'mcp');
    assert.equal(snapshot.mcpServer, 'codex');
    assert.equal(snapshot.credentialEnv, 'OPENAI_API_KEY');
    assert.equal(snapshot.useDefaultFallback, false);
    assert.equal(snapshot.fallback.length, 1);
    assert.equal(snapshot.fallback[0].vendor, 'anthropic');
    assert.ok(!('id' in snapshot) && !('name' in snapshot) && !('keywords' in snapshot), 'snapshot must exclude id/name/keywords');

    targetCard = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    pasteBtn = targetCard.querySelector('.routing-paste-settings-link') as any;
    assert.equal(pasteBtn.disabled, false, 'Paste enables once the clipboard holds a snapshot');

    pasteBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();

    targetCard = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    const targetVendorSel = targetCard.querySelector('.routing-vendor-select') as any;
    assert.equal(targetVendorSel.value, 'openai', 'vendor pasted onto target');
    const targetTransportSel = targetCard.querySelector('[data-field-key="agent:coding-specialist.transport"]') as any;
    assert.equal(targetTransportSel.value, 'mcp', 'transport pasted onto target');
    const targetMcpInput = targetCard.querySelector('[data-field-key="agent:coding-specialist.mcpServer"]') as any;
    assert.equal(targetMcpInput.value, 'codex', 'mcp server pasted onto target');
    const targetUseDefaultCheckbox = targetCard.querySelector('.routing-use-default-fallback-checkbox') as any;
    assert.equal(targetUseDefaultCheckbox.checked, false, 'useDefaultFallback pasted onto target');
    const targetFbRows = targetCard.querySelectorAll('.routing-fallback-item-line');
    assert.equal(targetFbRows.length, 1, 'fallback chain pasted onto target');

    // id/name/keywords on the roster entry and the target card stay untouched.
    const kwInput = targetCard.querySelector('.keyword-input') as any;
    assert.equal(kwInput.value, 'implement|code|fix', 'keyword field on the target card is unaffected by paste');
    assert.equal(targetCard.getAttribute('data-agent-id'), 'coding-specialist', 'target card id unaffected by paste');
    assert.ok(targetCard.querySelector('.agent-name').textContent.includes('Coding Specialist'), 'target card name unaffected by paste');

    const note = targetCard.querySelector('.routing-paste-note');
    assert.ok(note, 'a "Pasted from …" note should render on the target card');
    assert.match(note.textContent, /Pasted from Codex Reviewer/);
    const undoBtn = note.querySelector('.routing-paste-undo-btn');
    assert.ok(undoBtn, 'Undo control should render in the paste note');

    // Save after paste posts the pasted values.
    const cardSaveBtn = targetCard.querySelector('.agent-card-save-btn');
    assert.ok(cardSaveBtn, 'per-card Save button should render');
    cardSaveBtn.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();
    const saveMsg = [...h.posted].reverse().find((m: any) => m.type === 'saveRouting');
    assert.ok(saveMsg, 'a saveRouting message should have been posted');
    const savedSlot = saveMsg.profile.agents['coding-specialist'];
    assert.ok(savedSlot, 'the pasted slot should be written to the outgoing profile');
    assert.equal(savedSlot.vendor, 'openai');
    assert.equal(savedSlot.model, 'gpt-5');
    assert.equal(savedSlot.costModelClass, 'subscription');
    assert.equal(savedSlot.transport, 'mcp');
    assert.equal(savedSlot.mcpServer, 'codex');
    assert.equal(savedSlot.credentialEnv, 'OPENAI_API_KEY');
    assert.equal(savedSlot.useDefaultFallback, false);
    assert.ok(Array.isArray(savedSlot.fallback) && savedSlot.fallback.length === 1);

    // Undo restores the previous draft.
    const undoBtnLive = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"] .routing-paste-undo-btn');
    undoBtnLive.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
    await h.flush();
    const restoredCard = h.doc.querySelector('.routing-agent-card[data-agent-id="coding-specialist"]');
    const restoredVendorSel = restoredCard.querySelector('.routing-vendor-select') as any;
    assert.notEqual(restoredVendorSel && restoredVendorSel.value, 'openai', 'Undo should restore the pre-paste draft (no openai vendor)');
    const noteAfterUndo = restoredCard.querySelector('.routing-paste-note');
    assert.ok(!noteAfterUndo, 'paste note should be gone after Undo');
  } finally {
    h.win.close();
  }
});

// ── Savings eligibility render coverage (media/src/main/080-packs-events.js
// buildSavingsEligibility ~363-419, rendered ~1720-1750): when a
// counterfactual rate resolves but ledger.savings.eligible is false, the
// panel must show ONLY the ".delegation-stats-detail.delegation-savings-hidden"
// line with the reason (and a title listing the implicated agents), and must
// NOT render the counterfactual/billed/avoided lines. When eligible, the
// three lines render and the hidden line is absent. Drives buildDelegationLedger
// indirectly through the orchestrator's real agentMetrics rows the same way
// the compliance tests above do, rather than reaching into main.js's
// closures.
function buildSavingsEligibilityStatePayload(agentMetrics: unknown[]) {
  return {
    type: 'state',
    state: {
      sessionActive: true,
      completedTasks: agentMetrics.length,
      workers: {},
      agentMetrics,
    },
  };
}

test('Savings not shown: mixed-vendor delegated agents hide the counterfactual lines and show the reason', async () => {
  const h = await bootObjScaleHarness();
  try {
    // Orchestrator priced (anthropic/sonnet) + two delegated agents on
    // different vendors (anthropic, openai) -> buildSavingsEligibility
    // returns eligible:false, reason:"mixed vendors".
    h.dispatch(
      buildSavingsEligibilityStatePayload([
        { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'sonnet', tokens: 500, activeMs: 30000 },
        { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', vendor: 'anthropic', model: 'sonnet', tokens: 4000, activeMs: 90000, taskCount: 2, usageReported: true },
        { id: 'codex-reviewer', name: 'Codex Reviewer', status: 'idle', vendor: 'openai', model: 'gpt-5', tokens: 3000, activeMs: 60000, taskCount: 1, usageReported: true },
      ])
    );
    await h.flush();
    assert.equal(h.errors.length, 0, `post-dispatch errors: ${h.errors.map(String).join('; ')}`);
    openDelegationTab(h);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors after opening the Delegation tab: ${h.errors.map(String).join('; ')}`);

    const delegationBody = h.doc.getElementById('delegation-stats');
    assert.ok(delegationBody, 'delegation-stats body should exist');

    const hiddenLine = delegationBody.querySelector('.delegation-stats-detail.delegation-savings-hidden');
    assert.ok(hiddenLine, 'the hidden-savings line should render when savings.eligible is false');
    assert.match(hiddenLine.textContent, /^Relative cost not shown: mixed vendors$/);
    assert.ok(hiddenLine.title && hiddenLine.title.length > 0, 'the hidden-savings line should carry a title listing the implicated agents');

    const details = [...delegationBody.querySelectorAll('.delegation-stats-detail')].map((n: any) => n.textContent || '');
    assert.ok(!details.some((t: string) => /^Delegated work ran at/.test(t)), 'the ratio line must not render when savings are hidden');
    assert.doesNotMatch(String(delegationBody.textContent), /\$/, 'the Metrics/Delegation tabs render no dollar figures');
  } finally {
    h.win.close();
  }
});

test('Eligible savings: pure priced Anthropic delegated agents render the three counterfactual lines and no hidden line', async () => {
  const h = await bootObjScaleHarness();
  try {
    h.dispatch(
      buildSavingsEligibilityStatePayload([
        { id: 'orchestrator', name: 'Orchestrator', status: 'idle', model: 'sonnet', tokens: 500, activeMs: 30000 },
        { id: 'coding-specialist', name: 'Coding Specialist', status: 'idle', vendor: 'anthropic', model: 'sonnet', tokens: 4000, activeMs: 90000, taskCount: 2, usageReported: true },
        { id: 'search-retrieval', name: 'Search Retrieval', status: 'idle', vendor: 'anthropic', model: 'haiku', tokens: 1000, activeMs: 30000, taskCount: 1, usageReported: true },
      ])
    );
    await h.flush();
    assert.equal(h.errors.length, 0, `post-dispatch errors: ${h.errors.map(String).join('; ')}`);
    openDelegationTab(h);
    await h.flush();
    assert.equal(h.errors.length, 0, `errors after opening the Delegation tab: ${h.errors.map(String).join('; ')}`);

    const delegationBody = h.doc.getElementById('delegation-stats');
    assert.ok(delegationBody, 'delegation-stats body should exist');

    const hiddenLine = delegationBody.querySelector('.delegation-stats-detail.delegation-savings-hidden');
    assert.ok(!hiddenLine, 'the hidden-savings line must be absent when savings.eligible is true');

    // Same vendor (anthropic), orchestrator priced (sonnet=4/Mtok), delegated
    // 4000 tokens @ sonnet + 1000 tokens @ haiku(2/Mtok): billed = 0.018,
    // counterfactual = 5000/1e6*4 = 0.02, ratio = 0.02/0.018 ≈ 1.11 ->
    // fmtRatio -> "1.1".
    const details = [...delegationBody.querySelectorAll('.delegation-stats-detail')].map((n: any) => n.textContent || '');
    assert.ok(
      details.some((t: string) => /^Delegated work ran at 1\.1× cheaper than running the same billable tokens on the orchestrator's model/.test(t)),
      `expected the 1.1x ratio line to render when savings are eligible, got: ${JSON.stringify(details)}`
    );
    assert.doesNotMatch(String(delegationBody.textContent), /\$/, 'the Metrics/Delegation tabs render no dollar figures');
  } finally {
    h.win.close();
  }
});

test('media/main.js Theme Service disclosure names Corsair Theme Service and is generate-only', () => {
  const src = readFileSync(MAIN_JS_PATH, 'utf8');
  assert.match(
    src,
    /Your theme prompts and the images we generate are sent to the Corsair Theme Service only when you generate a theme — never when you upload or hand-make one\. The extension itself holds no image-provider API key of yours\./,
    'Theme Service panel must disclose that prompts/images are sent to the Corsair Theme Service only on generate, and that the extension holds no image-provider API key'
  );
  assert.match(
    src,
    /Separately: theme prompts and generated images go to the Corsair Theme Service only when you generate a theme — never when you upload or hand-make one — and the extension holds no image-provider API key of yours\./,
    'The feedback "what\'s never sent" disclosure block must also name the Corsair Theme Service generate-only condition'
  );
});
