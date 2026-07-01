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
  assert.equal(plan.objects.length, 13);
  assert.equal(plan.decor.length, 10);
  assert.equal(plan.expressions.length, 16);
  assert.equal(plan.achievements.length, 20);
});

test('theme plan emits 10 decor objects: 4 sittable seats, 4 static, 2 animated', () => {
  const manifest = themePlanToManifest(normalizeThemePlan({
    display_name: 'Cozy Tavern',
    decor: ['Oak Stool', 'Bench', 'High Chair', 'Bar Seat', 'Barrel', 'Keg', 'Sign', 'Lantern', 'Fireplace', 'Fountain'],
  }));
  const decor = manifest.decor_objects ?? [];
  assert.equal(decor.length, 10);

  // Seats (0-3) are sittable with a default sit anchor and a single-frame sprite key.
  for (let i = 0; i < 4; i++) {
    assert.equal(decor[i].is_sittable, true);
    assert.deepEqual(decor[i].sit_anchor, [0, -0.03]);
    assert.equal(decor[i].anim_fps, undefined);
    assert.match(decor[i].sprite_asset, /^frames\.json#decor_seat_/);
  }
  // Static decor (4-7): not sittable, not animated.
  for (let i = 4; i < 8; i++) {
    assert.equal(decor[i].is_sittable, undefined);
    assert.equal(decor[i].anim_fps, undefined);
    assert.match(decor[i].sprite_asset, /^frames\.json#decor_decor_/);
  }
  // Animated decor (8-9): looping animation metadata present.
  for (let i = 8; i < 10; i++) {
    assert.equal(decor[i].anim_fps, 5);
    assert.equal(decor[i].anim_loop, true);
    assert.equal(decor[i].is_sittable, undefined);
  }
  // decor_ids are unique, so frame keys never collide.
  assert.equal(new Set(decor.map((d) => d.decor_id)).size, 10);
});

test('theme plan creates 16 agents, 3 enemies, and 13 buildable objects', () => {
  const manifest = themePlanToManifest(normalizeThemePlan({ display_name: 'Clockwork' }));
  assert.equal(manifest.roster_agents?.length, 16);
  assert.equal(manifest.roster_rivals?.length, 3);
  assert.equal(manifest.buildable_objects?.length, 13);
  assert.match(manifest.roster_agents?.[0].atlas_asset ?? '', /^frames\.json#agent_0$/);
  assert.equal(manifest.viewport?.crate_asset, 'frames.json#crate');
  assert.equal(manifest.viewport?.poof_asset, 'frames.json#poof');
});
