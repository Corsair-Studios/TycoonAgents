import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThemeGenerationItemComplete,
  withoutRedundantBuildableObjectsItem,
} from '../src/extension/themeGenerationState';

test('removes the redundant legacy buildable objects item from current review documents', () => {
  const items = withoutRedundantBuildableObjectsItem([
    { id: 'agent_0' },
    { id: 'objects' },
    { id: 'buildable_objects' },
  ]);
  assert.deepEqual(items.map((item) => item.id), ['agent_0', 'objects']);
});

test('keeps the buildable objects item in a genuinely legacy review document', () => {
  const items = withoutRedundantBuildableObjectsItem([{ id: 'buildable_objects' }]);
  assert.deepEqual(items.map((item) => item.id), ['buildable_objects']);
});

test('removes the redundant legacy item when animated object boards are present', () => {
  const items = withoutRedundantBuildableObjectsItem([
    { id: 'objects_01' },
    { id: 'objects_02' },
    { id: 'objects_03' },
    { id: 'buildable_objects' },
  ]);
  assert.deepEqual(items.map((item) => item.id), ['objects_01', 'objects_02', 'objects_03']);
});

test('resume completion requires the retained image and every generated frame', () => {
  const item = { id: 'objects', frame_keys: ['object_a', 'object_b'] };
  assert.equal(isThemeGenerationItemComplete(item, false, {
    object_a: ['a'],
    object_b: ['b'],
  }), false);
  assert.equal(isThemeGenerationItemComplete(item, true, { object_a: ['a'] }), false);
  assert.equal(isThemeGenerationItemComplete(item, true, {
    object_a: ['a'],
    object_b: ['b'],
  }), true);
});
