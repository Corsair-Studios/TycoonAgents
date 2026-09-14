// Synced copy of ATLAS_CLIPS from src/extension/themePlan.ts.
// This file is plain JS (not part of the TS build) so it can be loaded
// directly by index.html via a <script> tag with no bundler, and also via
// Node `require()` from test/animationLabClips.test.ts.
//
// IMPORTANT: if ATLAS_CLIPS changes in src/extension/themePlan.ts, update
// this file to match — test/animationLabClips.test.ts asserts deep equality
// between the two and will fail on drift.

const ATLAS_CLIPS = {
  // EXPERIMENT (reversible): capped to CHARACTER_WALK_FRAME_CAP=2 frames —
  // mirrors src/extension/themePlan.ts's ATLAS_CLIPS.walk (parity-tested).
  walk: { frames: [0, 1, 2, 3], fps: 10, loop: true, flippable: true },
  idle: { frames: [16], fps: 0, loop: true, flippable: false, hold: true },
  sit: { frames: [15], fps: 0, loop: true, flippable: true, hold: true },
  melee: { frames: [10, 11], fps: 12, loop: false, flippable: true },
  build: { frames: [5, 6, 7, 8], fps: 6, loop: true, flippable: true },
  tool_idle: { frames: [9], fps: 0, loop: true, flippable: true, hold: true },
  shoot: { frames: [12, 13], fps: 3, loop: true, flippable: true, pingpong: false },
  dance: { frames: [17, 18, 19], fps: 6, loop: true, flippable: false, pingpong: true },
  cheer: { frames: [19], fps: 0, loop: true, flippable: false, hold: true },
  point: { frames: [9], fps: 0, loop: true, flippable: true, hold: true },
  signal: { frames: [19], fps: 0, loop: true, flippable: false, hold: true },
  block: { frames: [14], fps: 6, loop: false, flippable: true },
  // Freed row-1 frames (formerly walk cells 3-5), mirrors themePlan.ts.
  idle_rare: { frames: [2, 3], fps: 2, loop: true, flippable: true },
  stand_back: { frames: [4], fps: 0, loop: true, flippable: false, hold: true },
};

if (typeof window !== 'undefined') {
  window.ATLAS_CLIPS = ATLAS_CLIPS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ATLAS_CLIPS };
}
