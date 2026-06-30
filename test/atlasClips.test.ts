import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS_CLIPS } from '../src/extension/themePlan';

// 5-col x 4-row character atlas grid (src/extension/themePlan.ts).
// themePlan.ts does not currently export a named slot-count constant for this
// grid (THEME_CHARACTER_COUNT etc. are roster counts, not slot counts) — if it
// ever does, import that instead of redefining this here.
const SLOT_COUNT = 5 * 4;

const REQUIRED_CLIP_NAMES = [
  'walk',
  'idle',
  'sit',
  'melee',
  'build',
  'tool_idle',
  'shoot',
  'dance',
  'cheer',
  'point',
  'signal',
  'dodge',
];

test('ATLAS_CLIPS exposes exactly the required clip names', () => {
  const keys = Object.keys(ATLAS_CLIPS).sort();
  assert.deepEqual(keys, [...REQUIRED_CLIP_NAMES].sort());
  for (const name of REQUIRED_CLIP_NAMES) {
    assert.ok(name in ATLAS_CLIPS, `missing clip: ${name}`);
  }
});

test('every clip has a non-empty, in-bounds, duplicate-free frames array', () => {
  for (const [name, clip] of Object.entries(ATLAS_CLIPS)) {
    assert.ok(Array.isArray(clip.frames), `${name}.frames should be an array`);
    assert.ok(clip.frames.length > 0, `${name}.frames should be non-empty`);
    for (const frame of clip.frames) {
      assert.ok(Number.isInteger(frame), `${name} frame ${frame} should be an integer`);
      assert.ok(frame >= 0 && frame <= SLOT_COUNT - 1, `${name} frame ${frame} out of bounds [0, ${SLOT_COUNT - 1}]`);
    }
    assert.equal(
      new Set(clip.frames).size,
      clip.frames.length,
      `${name}.frames should not contain duplicate indices`,
    );
  }
});

test('every clip satisfies fps/loop/flippable/hold invariants', () => {
  for (const [name, clip] of Object.entries(ATLAS_CLIPS)) {
    assert.equal(typeof clip.loop, 'boolean', `${name}.loop should be boolean`);
    assert.equal(typeof clip.flippable, 'boolean', `${name}.flippable should be boolean`);
    assert.equal(typeof clip.fps, 'number', `${name}.fps should be a number`);
    assert.ok(clip.fps >= 0, `${name}.fps should be >= 0`);

    // Multi-frame clips are animated and must advance over time.
    if (clip.frames.length > 1) {
      assert.ok(clip.fps > 0, `${name} has multiple frames so fps should be > 0`);
    }

    // A clip explicitly marked as a held pose must be a single static frame.
    if (clip.hold === true) {
      assert.equal(clip.frames.length, 1, `${name}.hold is true so it should have exactly 1 frame`);
    }
  }
});

test('semantic anchors for key clips', () => {
  assert.equal(ATLAS_CLIPS.walk.flippable, true);
  assert.equal(ATLAS_CLIPS.walk.loop, true);
  assert.ok(ATLAS_CLIPS.walk.frames.length >= 2);
  assert.equal(ATLAS_CLIPS.shoot.flippable, true);
  assert.equal(ATLAS_CLIPS.dance.loop, true);
  assert.equal(ATLAS_CLIPS.sit.hold, true);
  assert.equal(ATLAS_CLIPS.idle.hold, true);
});

test('walk frames differ from stationary clip frames', () => {
  assert.notDeepEqual(ATLAS_CLIPS.walk.frames, ATLAS_CLIPS.idle.frames);
  assert.notDeepEqual(ATLAS_CLIPS.walk.frames, ATLAS_CLIPS.sit.frames);
});
