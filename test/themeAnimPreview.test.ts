/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests for the Theme Builder review "Preview animation" player
// (media/src/main/065-theme-anim-preview.js: buildThemeAnimPreviewSection,
// the shared rAF loop, themeAnimPreviewAdvanceFrame), the
// GET_THEME_ITEM_FRAMES wire contract (src/host/vscode/messages.ts), and the
// host frame handler (standalone/src/themeMessages.mjs's
// handleGetThemeItemFrames — the vscode-free twin of panel.ts's
// _postThemeItemFrames).
//
// The webview section runs 065's source directly in a small vm context (not
// the full media/main.js bundle) so ATLAS_CLIPS/RIVAL_CLIPS/OBJECT_CLIPS,
// document, requestAnimationFrame and loadDefringedFrame can be supplied as
// deterministic stand-ins/fakes — same "compile via tsc, run via node --test
// out/test/<file>.js" pattern as test/themeServicePanel.test.ts, but a
// narrower harness since 065 has no dependency on the rest of the IIFE
// besides those three globals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

import { pathToFileURL } from 'node:url';
import { ATLAS_CLIPS, RIVAL_CLIPS, OBJECT_CLIPS } from '../src/extension/themePlan';
import { MSG_SCHEMAS } from '../src/host/vscode/messages';

const SRC_PATH = join(process.cwd(), 'media', 'src', 'main', '065-theme-anim-preview.js');

// tsc (module: CommonJS) downlevels a plain `await import(...)` into
// `require()`, which cannot load a real ESM .mjs file — same workaround as
// test/themeServiceToken.test.ts's dynamicImport.
const dynamicImport: (specifier: string) => Promise<any> = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<any>;

async function loadThemeMessagesModule() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const mjsPath = path.join(repoRoot, 'standalone', 'src', 'themeMessages.mjs');
  return dynamicImport(pathToFileURL(mjsPath).href);
}

function bootAnimPreviewHarness() {
  const src = readFileSync(SRC_PATH, 'utf8');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://webview.local/',
  });
  const win: any = dom.window;
  const doc = win.document;

  const posted: any[] = [];
  const rafQueue: Array<(ts: number) => void> = [];

  win.HTMLCanvasElement.prototype.getContext = function () {
    return {
      imageSmoothingEnabled: false,
      clearRect() {},
      fillRect() {},
      drawImage() {},
      strokeRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
    };
  };

  const context = vm.createContext({
    document: doc,
    window: win,
    IntersectionObserver: undefined,
    requestAnimationFrame: (cb: (ts: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    vscode: {
      postMessage: (m: any) => posted.push(m),
    },
    // Fakes the stage's de-fringe loader: returns a synchronously "loaded"
    // image-like object keyed by src, so themeAnimPreviewDraw can read
    // naturalWidth/complete immediately without waiting on a real Image
    // decode (the anim preview never draws pixels in this test; only
    // frameIndex bookkeeping is asserted).
    loadDefringedFrame: (src: string) => ({
      src,
      complete: true,
      naturalWidth: 8,
      naturalHeight: 8,
    }),
    ATLAS_CLIPS,
    RIVAL_CLIPS,
    OBJECT_CLIPS,
    console,
  });
  vm.runInContext(src, context, { filename: '065-theme-anim-preview.js' });

  // themeAnimPreviewPlayers/themeAnimPreviewState are `const`, so — unlike
  // 065's `function` declarations — they never become properties of the
  // context object; they're only reachable by evaluating an expression in
  // this same vm context's lexical scope.
  function getPlayer(itemId: string): any {
    return vm.runInContext('themeAnimPreviewPlayers', context).get(itemId);
  }

  return { win, doc, context, posted, rafQueue, getPlayer };
}

function tickAll(rafQueue: Array<(ts: number) => void>, ts: number) {
  // The 065 loop re-queues itself every frame (requestAnimationFrame(step)
  // inside step), so draining the queue in place, snapshotting its length
  // first, runs exactly one animation frame across every registered player
  // without re-entering the callback it just scheduled for next time.
  const batch = rafQueue.splice(0, rafQueue.length);
  batch.forEach((cb) => cb(ts));
}

// ── buildThemeAnimPreviewSection: animated vs static boards ────────────────

test('renders the Preview animation section for animated boards only', () => {
  const { context } = bootAnimPreviewHarness();
  const build = context.buildThemeAnimPreviewSection;

  assert.ok(build({ id: 'c1', kind: 'character', display_name: 'Hero' }, 'theme1'), 'character boards are animated');
  assert.ok(build({ id: 'r1', kind: 'rival', display_name: 'Rival' }, 'theme1'), 'rival boards are animated');
  assert.ok(
    build({ id: 'o1', kind: 'object', display_name: 'Crate', anim_fps: 5 }, 'theme1'),
    'object boards with anim_fps > 0 are animated',
  );
  assert.ok(
    build({ id: 'd1', kind: 'decor', display_name: 'Fountain', anim_fps: 12 }, 'theme1'),
    'decor boards with anim_fps > 0 are animated',
  );

  assert.equal(build({ id: 'e1', kind: 'expression', display_name: 'Happy' }, 'theme1'), null);
  assert.equal(build({ id: 'b1', kind: 'badge', display_name: 'Badge' }, 'theme1'), null);
  assert.equal(build({ id: 'env1', kind: 'environment', display_name: 'Sky' }, 'theme1'), null);
  assert.equal(
    build({ id: 'o2', kind: 'object', display_name: 'Rock', anim_fps: 0 }, 'theme1'),
    null,
    'static objects (anim_fps 0/absent) do not render',
  );
  assert.equal(
    build({ id: 'o3', kind: 'object', display_name: 'Rock2' }, 'theme1'),
    null,
    'objects with no anim_fps at all do not render',
  );
});

// ── Opening a preview requests frames ───────────────────────────────────────

test('opening a preview posts GET_THEME_ITEM_FRAMES with the right themeId/itemId', () => {
  const { context, doc, posted } = bootAnimPreviewHarness();
  const item = { id: 'rival-7', kind: 'rival', display_name: 'Rival Seven', image_src: 'foo.png?revision=0' };
  const section = context.buildThemeAnimPreviewSection(item, 'theme-abc');
  doc.body.appendChild(section);

  const details = section.querySelector('details');
  assert.ok(details, 'section renders a <details>');
  details.open = true;
  details.dispatchEvent(new context.window.Event('toggle'));

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'GET_THEME_ITEM_FRAMES');
  // posted[0].payload is a vm-context object (a different realm's
  // Object.prototype) — compare fields directly rather than via
  // assert.deepEqual, which treats cross-realm plain objects as unequal.
  assert.equal(posted[0].payload.theme_id, 'theme-abc');
  assert.equal(posted[0].payload.item_id, 'rival-7');
});

// ── Frame stepping at clip fps, read from ATLAS_CLIPS/RIVAL_CLIPS ──────────

test('steps atlas walk clip frame indices at ATLAS_CLIPS.walk.fps', () => {
  const { context, doc, rafQueue, getPlayer } = bootAnimPreviewHarness();
  const item = { id: 'char-1', kind: 'character', display_name: 'Hero', image_src: 'a.png?revision=0' };
  const section = context.buildThemeAnimPreviewSection(item, 'theme1');
  doc.body.appendChild(section);
  const details = section.querySelector('details');
  details.open = true;
  details.dispatchEvent(new context.window.Event('toggle'));

  // Reply with frames for every ATLAS_CLIPS.walk frame index used (a single
  // key holding all poses, matching character-board storage per 065's own
  // comment at ~L384-385).
  const framesReply = { theme_id: 'theme1', item_id: 'char-1', frames: { char_1: Array.from({ length: 20 }, (_, i) => `frame${i}.png`) } };
  context.handleThemeItemFramesMessage(framesReply);

  const player = getPlayer('char-1');
  assert.ok(player);
  player.clipKey = 'walk';
  player.frameIndex = 0;
  player.elapsed = 0;
  player.open = true;
  player.visible = true;

  const walk = ATLAS_CLIPS.walk;
  const frameDur = 1 / walk.fps;
  const expected = walk.frames;

  // Prime themeAnimPreviewLastTs with a NONZERO timestamp: the loop treats
  // `themeAnimPreviewLastTs` falsy (i.e. still 0) as "first frame, no dt
  // yet" (`dt = themeAnimPreviewLastTs ? (ts - themeAnimPreviewLastTs) / 1000
  // : 0`), so priming at ts=0 would leave it falsy forever and every
  // subsequent tick would also compute dt=0.
  const PRIME_TS = 1;
  tickAll(rafQueue, PRIME_TS);
  let ts = PRIME_TS;
  for (let step = 1; step < expected.length; step++) {
    ts += frameDur * 1000;
    tickAll(rafQueue, ts);
    const seq = context.themeAnimPreviewClipSequence(walk);
    const idx = seq[player.frameIndex % seq.length];
    assert.equal(idx, expected[step % expected.length], `after step ${step}`);
  }
});

test('ping-pong order for the dance clip follows ATLAS_CLIPS.dance.frames forward then back', () => {
  const { context, doc, rafQueue, getPlayer } = bootAnimPreviewHarness();
  const item = { id: 'char-2', kind: 'character', display_name: 'Hero2', image_src: 'a.png?revision=0' };
  const section = context.buildThemeAnimPreviewSection(item, 'theme1');
  doc.body.appendChild(section);
  const details = section.querySelector('details');
  details.open = true;
  details.dispatchEvent(new context.window.Event('toggle'));
  context.handleThemeItemFramesMessage({
    theme_id: 'theme1',
    item_id: 'char-2',
    frames: { char_2: Array.from({ length: 20 }, (_, i) => `frame${i}.png`) },
  });

  const player = getPlayer('char-2');
  player.clipKey = 'dance';
  player.frameIndex = 0;
  player.elapsed = 0;
  player.open = true;
  player.visible = true;

  const dance = ATLAS_CLIPS.dance;
  assert.equal(dance.pingpong, true, 'precondition: dance is a pingpong clip');
  const seq = context.themeAnimPreviewClipSequence(dance);
  // Forward then back, excluding the two endpoints from the return trip —
  // e.g. frames [17,18,19] -> sequence [17,18,19,18].
  assert.deepEqual(seq, [...dance.frames, ...dance.frames.slice(1, -1).reverse()]);

  const frameDur = 1 / dance.fps;
  const observed = [seq[player.frameIndex % seq.length]];
  const PRIME_TS = 1; // see the walk-clip test's PRIME_TS comment
  tickAll(rafQueue, PRIME_TS);
  let ts = PRIME_TS;
  for (let i = 0; i < seq.length * 2; i++) {
    ts += frameDur * 1000;
    tickAll(rafQueue, ts);
    observed.push(seq[player.frameIndex % seq.length]);
  }
  // First len(seq) observed values after the prime tick must cycle through
  // seq in order (wrapping), confirming ping-pong playback (e.g. for
  // frames [17,18,19]: 17,18,19,18,17,18,19,18,...).
  for (let i = 0; i < seq.length; i++) {
    assert.equal(observed[i + 1], seq[(i + 1) % seq.length], `observed[${i + 1}]`);
  }
});

// ── MSG_SCHEMAS.GET_THEME_ITEM_FRAMES validation ────────────────────────────

test('MSG_SCHEMAS.GET_THEME_ITEM_FRAMES accepts a valid payload and rejects missing/invalid ids', () => {
  const schema = MSG_SCHEMAS.GET_THEME_ITEM_FRAMES;
  assert.ok(schema.safeParse({ theme_id: 't1', item_id: 'i1' }).success);
  assert.equal(schema.safeParse({ item_id: 'i1' }).success, false, 'missing theme_id must be rejected');
  assert.equal(schema.safeParse({ theme_id: 't1' }).success, false, 'missing item_id must be rejected');
  assert.equal(schema.safeParse({ theme_id: '', item_id: 'i1' }).success, false, 'empty theme_id must be rejected');
  assert.equal(schema.safeParse({ theme_id: 't1', item_id: '' }).success, false, 'empty item_id must be rejected');
  assert.equal(schema.safeParse({ theme_id: 1, item_id: 'i1' }).success, false, 'non-string theme_id must be rejected');
  assert.equal(schema.safeParse({}).success, false);
});

// ── Host handler: all frames per key, and the pending-frames finding ───────

function makeFakeStore(files: Record<string, unknown>) {
  return {
    async readFile(relPath: string) {
      const value = files[relPath];
      if (value === undefined) throw new Error(`ENOENT: ${relPath}`);
      return new TextEncoder().encode(JSON.stringify(value));
    },
  };
}

test('handleGetThemeItemFrames returns ALL frames per key for a multi-key (rivals) board, not just the first', async () => {
  const themeId = 'demo_theme';
  const framesJson = {
    rival_wolf: ['w0.png', 'w1.png', 'w2.png'],
    rival_bear: ['b0.png', 'b1.png'],
  };
  const reviewJson = {
    items: [{ id: 'rival-1', frame_keys: ['rival_wolf', 'rival_bear'] }],
  };
  const store = makeFakeStore({
    'themes/demo_theme/frames.json': framesJson,
    'themes/demo_theme/review.json': reviewJson,
  });

  const { handleGetThemeItemFrames } = await loadThemeMessagesModule();
  let posted: any;
  await handleGetThemeItemFrames(store, (_evt: string, data: any) => { posted = data; }, themeId, 'rival-1');

  assert.ok(posted, 'broadcast was called');
  assert.equal(posted.type, 'THEME_ITEM_FRAMES');
  assert.deepEqual(posted.payload.frames.rival_wolf, ['w0.png', 'w1.png', 'w2.png'], 'all 3 wolf frames returned, not just the first');
  assert.deepEqual(posted.payload.frames.rival_bear, ['b0.png', 'b1.png'], 'all 2 bear frames returned, not just the first');
});

// IMPORTANT — verifies the author's claim in themeMessages.mjs's
// handleGetThemeItemFrames doc comment (~L638-644) and panel.ts's
// _postThemeItemFrames doc comment (src/host/vscode/panel.ts:3659-3668):
// "pending (not-yet-approved) sliced frames are included automatically —
// approval only flips item status, not the stored frame data."
//
// Traced in src/extension/themeService.ts's retryThemeImage (~L3227-3237):
// applySlicedAtlasFromBuffer slices the freshly-generated attempt and writes
// the result into `frames` (the SAME object loadTheme/loadedTheme.frames
// holds) synchronously, in-memory, before retryThemeImage returns — and the
// merge/write path further down (through writeThemeFiles) persists
// frames.json for this attempt regardless of the review item's approval
// status. The item's `status` field lives in review.json, entirely separate
// from frames.json — nothing in retryThemeImage gates the frames.json write
// on a later "Keep"/approve action. So a handler that reads frames.json (as
// both handleGetThemeItemFrames and _postThemeItemFrames do) genuinely
// returns the newest sliced attempt's frames even while review.json still
// marks that item `pending`, confirming the claim rather than falsifying it.
test('a PENDING (not-yet-approved) item returns its newly-sliced frames, not stale prior-approved frames', async () => {
  const themeId = 'demo_theme';
  // frames.json already reflects the NEW retry attempt (this is what
  // retryThemeImage's in-memory `frames` write, then writeThemeFiles,
  // produces) even though review.json's item is still `pending`.
  const framesJson = {
    obj_lamp: ['lamp-new-0.png', 'lamp-new-1.png'],
  };
  const reviewJson = {
    items: [{ id: 'obj-1', frame_keys: ['obj_lamp'], status: 'pending' }],
  };
  const store = makeFakeStore({
    'themes/demo_theme/frames.json': framesJson,
    'themes/demo_theme/review.json': reviewJson,
  });

  const { handleGetThemeItemFrames } = await loadThemeMessagesModule();
  let posted: any;
  await handleGetThemeItemFrames(store, (_evt: string, data: any) => { posted = data; }, themeId, 'obj-1');

  assert.deepEqual(
    posted.payload.frames.obj_lamp,
    ['lamp-new-0.png', 'lamp-new-1.png'],
    'handler must return the newly-sliced (pending) attempt’s frames, since frames.json ' +
      'and review.json approval status are independent stores and retryThemeImage writes ' +
      'frames.json immediately, before any Keep/approve action',
  );
});
