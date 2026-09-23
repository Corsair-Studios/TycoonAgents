import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThemePlan, themeDescriptionsStale } from '../src/extension/themePlan';
import type { ThemePlan } from '../src/extension/themePlan';

function basePlan(overrides: Partial<ThemePlan> = {}): ThemePlan {
  return {
    version: 1,
    theme_id: 'test_theme',
    display_name: 'Test Theme',
    creative_direction: 'gritty outpost',
    characters: ['Agent Zero'],
    environment: 'a dusty outpost',
    objects: ['Crate 01'],
    decor: ['Seat 01'],
    enemies: ['Roadblock'],
    expressions: ['happy'],
    achievements: ['First Build'],
    ...overrides,
  };
}

test('themeDescriptionsStale: legacy plan with no descriptions_direction field is never stale', () => {
  const plan = basePlan({ character_descriptions: ['a red robot'] });
  assert.equal('descriptions_direction' in plan, false);
  assert.equal(themeDescriptionsStale(plan), false);
});

test('themeDescriptionsStale: descriptions_direction set but no descriptions exist yet is not stale', () => {
  const plan = basePlan({ descriptions_direction: 'a different direction' });
  assert.equal(themeDescriptionsStale(plan), false);
});

test('themeDescriptionsStale: descriptions exist and descriptions_direction matches current direction (trimmed) is not stale', () => {
  const plan = basePlan({
    creative_direction: '  gritty outpost  ',
    descriptions_direction: 'gritty outpost',
    character_descriptions: ['a red robot'],
  });
  assert.equal(themeDescriptionsStale(plan), false);
});

test('themeDescriptionsStale: descriptions exist and descriptions_direction differs from current direction is stale', () => {
  const plan = basePlan({
    creative_direction: 'a moody neon skyline',
    descriptions_direction: 'gritty outpost',
    character_descriptions: ['a red robot'],
  });
  assert.equal(themeDescriptionsStale(plan), true);
});

test('themeDescriptionsStale: single-string description fields (crate/poof/projectile) alone count as "descriptions exist"', () => {
  const plan = basePlan({
    creative_direction: 'a moody neon skyline',
    descriptions_direction: 'gritty outpost',
    crate_description: 'a rusty crate',
  });
  assert.equal(themeDescriptionsStale(plan), true);
});

// themeDescriptionsStale keys entirely off creative_direction vs
// descriptions_direction plus whether ANY *_descriptions array/single-string
// field is populated (see themePlan.ts's hasAnyDescriptions check, which does
// NOT include plan.environment). Editing plan.environment alone never
// touches creative_direction or descriptions_direction, so it cannot flip
// staleness by itself — this documents that as the current, apparently
// intended behavior (the "stale" pill is about the CREATIVE DIRECTION going
// out of sync with generated descriptions, not about the environment text
// specifically).
test('themeDescriptionsStale: editing plan.environment alone does not flip staleness when not already stale', () => {
  const plan = basePlan({
    descriptions_direction: 'gritty outpost',
    character_descriptions: ['a red robot'],
  });
  assert.equal(themeDescriptionsStale(plan), false, 'matching direction should not be stale before the environment edit');
  plan.environment = 'a completely different neon skyline';
  assert.equal(themeDescriptionsStale(plan), false, 'editing plan.environment alone must not flip staleness');
});

test('themeDescriptionsStale: editing plan.environment alone does not clear an already-stale state either', () => {
  const plan = basePlan({
    creative_direction: 'a moody neon skyline',
    descriptions_direction: 'gritty outpost',
    character_descriptions: ['a red robot'],
  });
  assert.equal(themeDescriptionsStale(plan), true, 'test setup: direction mismatch should be stale');
  plan.environment = 'yet another environment description';
  assert.equal(themeDescriptionsStale(plan), true, 'editing plan.environment alone must not clear staleness either');
});

test('normalizeThemePlan carries descriptions_direction and previous_descriptions through unchanged', () => {
  const previous_descriptions = { character_descriptions: ['old spec'] };
  const plan = normalizeThemePlan({
    display_name: 'Neon Harbor',
    creative_direction: 'neon',
    descriptions_direction: '  neon  ',
    previous_descriptions,
  });
  assert.equal(plan.descriptions_direction, 'neon');
  assert.deepEqual(plan.previous_descriptions, previous_descriptions);
});

test('normalizeThemePlan drops an empty/whitespace-only descriptions_direction to undefined', () => {
  const plan = normalizeThemePlan({
    display_name: 'Neon Harbor',
    descriptions_direction: '   ',
  });
  assert.equal(plan.descriptions_direction, undefined);
});

test('normalizeThemePlan leaves descriptions_direction undefined when the input never had the field (legacy plan)', () => {
  const plan = normalizeThemePlan({
    display_name: 'Neon Harbor',
  });
  assert.equal(plan.descriptions_direction, undefined);
  assert.equal(themeDescriptionsStale(plan), false);
});
