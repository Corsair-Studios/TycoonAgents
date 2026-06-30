import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeThemePlan,
  themePlanToManifest,
} from '../src/extension/themePlan';

test('theme plan normalizes every editable slot to the required count', () => {
  const plan = normalizeThemePlan({
    display_name: 'Neon Harbor',
    characters: ['Dockmaster'],
    enemies: ['Data Pirate'],
    objects: ['Console'],
    expressions: ['Delighted'],
    achievements: ['First Light'],
  });
  assert.equal(plan.theme_id, 'neon_harbor');
  assert.equal(plan.characters.length, 16);
  assert.equal(plan.enemies.length, 3);
  assert.equal(plan.objects.length, 12);
  assert.equal(plan.expressions.length, 16);
  assert.equal(plan.achievements.length, 20);
});

test('theme plan creates 16 agents, 3 enemies, and 12 buildable objects', () => {
  const manifest = themePlanToManifest(normalizeThemePlan({ display_name: 'Clockwork' }));
  assert.equal(manifest.roster_agents?.length, 16);
  assert.equal(manifest.roster_rivals?.length, 3);
  assert.equal(manifest.buildable_objects?.length, 12);
  assert.match(manifest.roster_agents?.[0].atlas_asset ?? '', /^frames\.json#agent_0$/);
});
