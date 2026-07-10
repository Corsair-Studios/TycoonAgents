import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OBJECT_CLIPS } from '../src/extension/themePlan';

test('object animation clips expose the four-frame idle, held crate, and seven-frame one-shot poof contracts', () => {
  assert.deepEqual(Object.keys(OBJECT_CLIPS).sort(), ['crate', 'object_idle', 'poof']);
  assert.deepEqual(OBJECT_CLIPS.object_idle, {
    frames: [0, 1, 2, 3], fps: 5, loop: true,
  });
  assert.deepEqual(OBJECT_CLIPS.crate, {
    frames: [0], fps: 0, loop: true, hold: true,
  });
  // v2 object pipeline: the poof FX on objects_02 (cells 9-15) is 7 frames.
  assert.deepEqual(OBJECT_CLIPS.poof, {
    frames: [0, 1, 2, 3, 4, 5, 6], fps: 12, loop: false,
  });
});
