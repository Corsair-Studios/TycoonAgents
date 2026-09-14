import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAmbientPoseState,
  onWalkEnded,
  clearAmbientPoses,
  onActiveChanged,
  STAND_BACK_CHANCE,
} from '../src/webview/animationPlayback';

// Deterministic sequence RNG for seeded trials.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

test('flag off: stand_back never triggers, regardless of rng', () => {
  const alwaysHit = () => 0; // would trigger every gated roll if the flag were on
  for (let i = 0; i < 2000; i++) {
    const state = createAmbientPoseState();
    onWalkEnded(state, false, false, alwaysHit);
    assert.equal(state.standingBack, false);
  }
});

test('stand_back never chosen while active, even with flag on and a guaranteed-hit rng', () => {
  const alwaysHit = () => 0;
  for (let i = 0; i < 2000; i++) {
    const state = createAmbientPoseState();
    onWalkEnded(state, true, true, alwaysHit);
    assert.equal(state.standingBack, false);
  }
});

test('stand_back frequency after walk-end is within +/-0.05 of 0.25 over 2000 seeded trials', () => {
  const rng = seededRng(12345);
  let hits = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i++) {
    const state = createAmbientPoseState();
    onWalkEnded(state, false, true, rng);
    if (state.standingBack) hits++;
  }
  const observed = hits / trials;
  assert.ok(
    Math.abs(observed - STAND_BACK_CHANCE) <= 0.05,
    `observed ${observed} not within 0.05 of ${STAND_BACK_CHANCE}`,
  );
});

test('walk restarting (or any state change) clears a held stand_back', () => {
  const state = createAmbientPoseState();
  onWalkEnded(state, false, true, () => 0);
  assert.equal(state.standingBack, true);
  clearAmbientPoses(state);
  assert.equal(state.standingBack, false);
});

test('latched stand_back is cleared when activity starts without a walk', () => {
  const state = createAmbientPoseState();
  onWalkEnded(state, false, true, () => 0);
  assert.equal(state.standingBack, true);
  onActiveChanged(state, true);
  assert.equal(state.standingBack, false);
});
