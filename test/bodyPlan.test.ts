import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferBodyPlan } from '../src/core/bodyPlan';

test('inferBodyPlan detects a singular quadruped keyword', () => {
  assert.equal(inferBodyPlan('a loyal dog companion'), 'quadruped');
});

test('inferBodyPlan detects a plural quadruped keyword case-insensitively', () => {
  assert.equal(inferBodyPlan('Cats of the guild'), 'quadruped');
});

test('inferBodyPlan defaults to biped for a human description', () => {
  assert.equal(inferBodyPlan('a knight in armor'), 'biped');
});

test('inferBodyPlan does not false-positive on a substring (word boundary)', () => {
  assert.equal(inferBodyPlan('catapult operator'), 'biped');
});

test('inferBodyPlan detects the "four-legged" phrase', () => {
  assert.equal(inferBodyPlan('four-legged robot'), 'quadruped');
});

test('inferBodyPlan defaults to biped for an empty/undefined description', () => {
  assert.equal(inferBodyPlan(''), 'biped');
  assert.equal(inferBodyPlan(undefined), 'biped');
});
