import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceCharacterAnimation,
  createCharacterAnimation,
  currentCharacterSlot,
  setCharacterAction,
} from '../src/webview/animationPlayback';

test('walk advances at its clip fps and loops', () => {
  // walk is capped to 2 frames (CHARACTER_WALK_FRAME_CAP experiment, see
  // src/extension/themePlan.ts ATLAS_CLIPS.walk) so the loop wraps every
  // 0.2s at this clip's 10fps instead of every 0.5s.
  const state = createCharacterAnimation('walk');
  advanceCharacterAnimation(state, 0.1);
  assert.equal(currentCharacterSlot(state), 1);
  advanceCharacterAnimation(state, 0.1);
  assert.equal(currentCharacterSlot(state), 0);
});

test('held clips stay on their only frame', () => {
  const state = createCharacterAnimation('idle');
  advanceCharacterAnimation(state, 10);
  assert.equal(currentCharacterSlot(state), 16);
  assert.equal(state.frameIndex, 0);
});

test('looping pingpong clips bounce at both ends', () => {
  const state = createCharacterAnimation('dance');
  advanceCharacterAnimation(state, 1 / 6);
  assert.equal(currentCharacterSlot(state), 18);
  advanceCharacterAnimation(state, 1 / 6);
  assert.equal(currentCharacterSlot(state), 19);
  advanceCharacterAnimation(state, 1 / 6);
  assert.equal(currentCharacterSlot(state), 18);
  advanceCharacterAnimation(state, 1 / 6);
  assert.equal(currentCharacterSlot(state), 17);
});

test('one-shot clips settle on their final frame', () => {
  const state = createCharacterAnimation('melee');
  advanceCharacterAnimation(state, 1);
  assert.equal(currentCharacterSlot(state), 11);
  assert.equal(state.completed, true);
  advanceCharacterAnimation(state, 1);
  assert.equal(currentCharacterSlot(state), 11);
});

test('changing actions resets playback state', () => {
  const state = createCharacterAnimation('walk');
  advanceCharacterAnimation(state, 0.3);
  setCharacterAction(state, 'shoot');
  assert.deepEqual(state, {
    action: 'shoot',
    frameIndex: 0,
    direction: 1,
    elapsedSeconds: 0,
    completed: false,
  });
});
