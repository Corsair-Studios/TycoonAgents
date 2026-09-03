import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAmbientPoseState,
  onWalkEnded,
  clearAmbientPoses,
  onActiveChanged,
  updateIdleRare,
  STAND_BACK_CHANCE,
  IDLE_RARE_CHANCE,
  IDLE_RARE_MINUTE_SECONDS,
  IDLE_RARE_DURATION_SECONDS,
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

test('flag off: stand_back and idle_rare never trigger, regardless of rng', () => {
  const alwaysHit = () => 0; // would trigger every gated roll if the flag were on
  for (let i = 0; i < 2000; i++) {
    const state = createAmbientPoseState();
    onWalkEnded(state, false, false, alwaysHit);
    assert.equal(state.standingBack, false);
    const idleState = createAmbientPoseState();
    const fired = updateIdleRare(idleState, false, false, true, IDLE_RARE_MINUTE_SECONDS, alwaysHit);
    assert.equal(fired, false);
    assert.equal(idleState.idleRareActive, false);
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
  assert.equal(state.idleRareActive, false);
  assert.equal(state.idleRareElapsed, 0);
  assert.equal(state.idleMinuteTimer, 0);
});

test('idle_rare never fires while active', () => {
  const rng = () => 0; // guaranteed hit if it were allowed to roll
  for (let i = 0; i < 100; i++) {
    const state = createAmbientPoseState();
    const fired = updateIdleRare(state, true, true, false, IDLE_RARE_MINUTE_SECONDS, rng);
    assert.equal(fired, false);
    assert.equal(state.idleRareActive, false);
  }
});

test('idle_rare rolls at most once per idle minute and respects IDLE_RARE_CHANCE', () => {
  const state = createAmbientPoseState();
  const missRng = () => 1; // never wins the 0.05 roll
  // Under a minute: never rolls yet.
  let fired = updateIdleRare(state, false, true, true, IDLE_RARE_MINUTE_SECONDS - 1, missRng);
  assert.equal(fired, false);
  // Crossing the minute boundary triggers exactly one roll (miss here).
  fired = updateIdleRare(state, false, true, true, 1, missRng);
  assert.equal(fired, false);
  assert.equal(state.idleRareActive, false);
});

test('idle_rare plays exactly one full two-frame pass then returns to idle', () => {
  const state = createAmbientPoseState();
  const hitRng = () => 0; // always wins the roll
  // Cross the per-minute threshold to start the one-shot.
  let active = updateIdleRare(state, false, true, true, IDLE_RARE_MINUTE_SECONDS, hitRng);
  assert.equal(active, true);
  assert.equal(state.idleRareActive, true);
  // First frame hold (~0.5s of the 1.0s total pass): still playing.
  active = updateIdleRare(state, false, true, true, IDLE_RARE_DURATION_SECONDS / 2, hitRng);
  assert.equal(active, true);
  // Second half completes the pass: falls back to idle.
  active = updateIdleRare(state, false, true, true, IDLE_RARE_DURATION_SECONDS / 2, hitRng);
  assert.equal(active, false);
  assert.equal(state.idleRareActive, false);
});
