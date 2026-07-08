import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Regression test for the "objects/decor drawn with bottoms cut off" bug.
 *
 * Root cause: media/main.js draws the theme's fixed 533x751-native scene
 * (background + every agent/rival/object/decor/projectile mapped onto it)
 * at its NATURAL pixel size, top-anchored, with no fit-to-canvas scaling.
 * When the actual <canvas> backing store is shorter than the native 751px
 * tall footprint — e.g. the metrics-panel handlebar dragged tall, or a
 * narrow VS Code sidebar — everything positioned in the lower portion of
 * the native space (bgY + ny * bgH/walkableNativeH) maps to a canvas Y
 * beyond canvas.height, and the browser canvas silently omits pixels
 * outside its own bounds. Foreground decor/objects are hit hardest because
 * Stage Editor composition deliberately places big, scaled-up props low in
 * the native scene, while wandering agents only pass through that zone
 * transiently — which is exactly the asymmetry the user's screenshot showed
 * ("objects/decor cut off, characters look fine").
 *
 * The fix (media/main.js, `sceneFitScale`) computes a uniform <=1 factor
 * each frame from the actual canvas size vs. the theme's native footprint
 * and folds it into both the background rect (bgW/bgH, used by
 * nativeToCanvas for EVERY entity's position) and every entity's depthScale
 * (used for on-screen size), so the whole scene shrinks together with no
 * distortion and nothing is ever positioned beyond the canvas edge.
 *
 * This test boots main.js in a jsdom runtime (mirrors webviewSmoke.test.ts)
 * with a canvas MUCH shorter than the native 751px height, places a decor
 * item and a buildable object deep in the scene with large scale overrides
 * (mirroring a real theme's viewport.object_scale_overrides), renders
 * several frames, and asserts every recorded drawImage call's destination
 * rect stays within the canvas bounds — i.e. no sprite's foot-anchor (and
 * therefore no sprite's bottom) is ever pushed past canvas.height.
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
  if (lower.includes('list') || lower.includes('panel') || lower.includes('dialog') || lower.includes('area')) {
    return 'div';
  }
  return 'div';
}

const RUNTIME_CREATED_IDS = new Set([
  'rebirth-announce',
  'rebirth-panel',
  'menu-edit-stage',
  'settings-modal-close',
  'stage-edit-panel',
]);

interface DrawCall { dx: number; dy: number; dw: number; dh: number }

/** A 2D-context stub that records every drawImage(image, dx, dy, dw, dh) call. */
function makeRecordingCtxStub(canvasEl: unknown, calls: DrawCall[]): unknown {
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
    // Only the 5-arg (image, dx, dy, dw, dh) form is used for background/
    // sprite draws in main.js — record those; ignore other overloads.
    drawImage: (_img: unknown, dx: number, dy: number, dw: number, dh: number) => {
      if (typeof dw === 'number' && typeof dh === 'number') {
        calls.push({ dx, dy, dw, dh });
      }
    },
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

// Background is 533x751 native — the theme's real default footprint (see
// nav-polygon-coordinate-space: normalized 0..1 polygons convert to this
// canonical space). The test canvas below is deliberately much shorter.
// Sprite frames are the usual fixed 128x128 slicer output. The fake Image
// below distinguishes the two by src so the background reports its REAL
// (much taller) natural size — main.js reads naturalWidth/naturalHeight
// directly off the background image to compute bgW/bgH, so a fake that
// always reports 128x128 (as webviewSmoke.test.ts's does) would never
// reproduce the "background taller than canvas" scenario this bug needs.
const BG_NATIVE_W = 533;
const BG_NATIVE_H = 751;
const BG_PX = 'data:image/png;base64,BACKGROUND_MARKER';
const SPRITE_PX = 'data:image/png;base64,iVBORw0KGgo=';

function makeFakeImage(win: any) {
  return class FakeImage {
    _src = '';
    width = 128;
    height = 128;
    naturalWidth = 128;
    naturalHeight = 128;
    complete = false;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    set src(v: string) {
      this._src = v;
      this.complete = true;
      if (v === BG_PX) {
        this.width = BG_NATIVE_W;
        this.height = BG_NATIVE_H;
        this.naturalWidth = BG_NATIVE_W;
        this.naturalHeight = BG_NATIVE_H;
      } else {
        this.width = 128;
        this.height = 128;
        this.naturalWidth = 128;
        this.naturalHeight = 128;
      }
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

function frameArray(n: number): string[] {
  return Array.from({ length: n }, () => SPRITE_PX);
}

function buildThemePayload() {
  const manifest = {
    theme_id: 'fit_scale_theme',
    viewport: {
      native_width: 1280,
      native_height: 720,
      walkable_nav_polygon: [
        [0.05, 0.3],
        [0.95, 0.3],
        [0.95, 0.95],
        [0.05, 0.95],
      ],
      character_scale: 1,
      object_scale: 1,
      overall_scale: 1,
      rival_scale: 1,
      decor_scale: 1,
      // Mirrors a real theme's viewport.object_scale_overrides / decor_scale_overrides
      // where deep, foreground props are deliberately scaled up (2-3x) via Stage Editor.
      object_scale_overrides: { o_deep: 2.8 },
      decor_scale_overrides: { d_deep: 2.5 },
      // Both placed near the FRONT (large ny) of the nav polygon, mirroring a
      // Stage-Editor-composed scene where foreground props sit low in frame.
      object_anchor_overrides: { o_deep: [0.5, 0.93] },
      decor_anchor_overrides: { d_deep: [0.4, 0.9] },
      enemy_config: { spawn_interval_seconds: 45, count_mode: 'random' },
      crate_asset: 'frames.json#crate',
      poof_asset: 'frames.json#poof',
      projectile_asset: 'frames.json#projectile',
    },
    roster_agents: [{ slot_id: 'a1', name: 'Alpha' }],
    roster_rivals: [],
    buildable_objects: [
      { object_id: 'o_deep', display_name: 'Deep Rack', build_order: 0, anchor_coord: [0.5, 0.93] },
    ],
    decor_objects: [
      { decor_id: 'd_deep', display_name: 'Deep Bench', anchor_coord: [0.4, 0.9], is_sittable: false },
    ],
    badges: [],
  };

  const frames: Record<string, string[]> = {
    environment_background: [BG_PX],
    agent_a1: frameArray(20),
    object_o_deep: frameArray(4),
    decor_d_deep: frameArray(4),
    crate: frameArray(2),
    poof: frameArray(2),
    projectile: [SPRITE_PX],
  };

  return {
    type: 'THEME_INITIALIZED',
    payload: {
      theme_id: 'fit_scale_theme',
      manifest,
      frames,
      badges: [],
      unlocked_badge_ids: [],
    },
  };
}

test('deep-placed, scaled-up decor/objects never draw past canvas.height on a short stage panel', async () => {
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
  // Deliberately SHORT: well under the 751px native background height, as if
  // the metrics-panel handlebar were dragged tall or the sidebar is narrow.
  const CANVAS_W = BG_NATIVE_W;
  const CANVAS_H = 300;
  stage.width = CANVAS_W;
  stage.height = CANVAS_H;
  // jsdom canvases report clientWidth/clientHeight as 0 by default; main.js's
  // resize() reads clientWidth/clientHeight to (re)size the backing store, so
  // stub them to the dims we actually want rendered.
  Object.defineProperty(stage, 'clientWidth', { value: CANVAS_W, configurable: true });
  Object.defineProperty(stage, 'clientHeight', { value: CANVAS_H, configurable: true });

  const posted: any[] = [];
  let stateStore: any = {};
  win.acquireVsCodeApi = () => ({
    postMessage: (mmm: any) => posted.push(mmm),
    getState: () => stateStore,
    setState: (s: any) => { stateStore = s; },
  });

  const rafQueue: Array<(ts: number) => void> = [];
  win.requestAnimationFrame = (cb: (ts: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  win.cancelAnimationFrame = () => {};

  win.Image = makeFakeImage(win);

  const drawCalls: DrawCall[] = [];
  win.HTMLCanvasElement.prototype.getContext = function (this: any) {
    if (!this.__ctxStub) this.__ctxStub = makeRecordingCtxStub(this, drawCalls);
    return this.__ctxStub;
  };
  win.HTMLCanvasElement.prototype.toDataURL = function () {
    return SPRITE_PX;
  };

  const errors: any[] = [];
  win.addEventListener('error', (e: any) => {
    errors.push(e && (e.error || e.message) ? e.error || e.message : e);
  });
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => {
    errors.push(err || msg);
  };
  const onRejection = (r: any) => errors.push(r);
  process.on('unhandledRejection', onRejection);

  function tick(n: number) {
    for (let i = 0; i < n; i++) {
      const cbs = rafQueue.splice(0);
      for (const cb of cbs) {
        try {
          cb(i * 16);
        } catch (e) {
          errors.push(e);
        }
      }
    }
  }
  async function flush() {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent('message', { data }));
  }

  try {
    vm.runInContext(src, dom.getInternalVMContext(), { filename: 'media/main.js' });
    await flush();
    assert.equal(errors.length, 0, `boot threw: ${errors.map(String).join('; ')}`);

    dispatch(buildThemePayload());
    await flush();
    assert.equal(errors.length, 0, `theme init threw: ${errors.map(String).join('; ')}`);

    drawCalls.length = 0; // only inspect steady-state render frames
    tick(20);
    await flush();
    assert.equal(errors.length, 0, `render threw: ${errors.map(String).join('; ')}`);

    assert.ok(drawCalls.length > 0, 'expected at least one drawImage call across 20 rendered frames');

    // The core regression assertion: NOTHING drawn onto the stage — background,
    // agent, buildable object, or decor — may extend past the canvas's actual
    // bottom edge. Before the sceneFitScale fix, the 751px-tall background
    // (and everything positioned against it) drew unconditionally at native
    // size, so dy+dh regularly exceeded CANVAS_H (300) for the background
    // itself and for the deep-placed object/decor — exactly the "bottom cut
    // off" bug. A small epsilon absorbs sub-pixel rounding only.
    const EPS = 1;
    const offenders = drawCalls.filter((c) => c.dy + c.dh > CANVAS_H + EPS);
    assert.equal(
      offenders.length,
      0,
      `${offenders.length} of ${drawCalls.length} drawImage call(s) extended past canvas.height=${CANVAS_H}: ` +
        JSON.stringify(offenders.slice(0, 5)),
    );
  } finally {
    process.removeListener('unhandledRejection', onRejection);
    dom.window.close();
  }
});
