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
  assert.equal(plan.decor.length, 9);
  assert.equal(plan.expressions.length, 16);
  assert.equal(plan.achievements.length, 20);
});

test('object slot 0 is always a themed ranged weapon rack (build_order 0 convention)', () => {
  // Planner returned no suitable rack: slot 0 is coerced to a themed default,
  // and the planner's own first object is preserved (shifted into the free slots).
  const coerced = normalizeThemePlan({
    display_name: 'Neon Harbor',
    objects: ['Console', 'Crane', 'Generator'],
  });
  assert.equal(coerced.objects.length, 13);
  assert.equal(coerced.objects[0], 'Neon Harbor Ranged Weapon Rack');
  assert.equal(coerced.objects[1], 'Console');
  assert.equal(coerced.objects[2], 'Crane');

  // Planner already supplied a themed ranged weapon rack: keep its name verbatim.
  const kept = normalizeThemePlan({
    display_name: 'Neon Command',
    objects: ['Laser Rifle Rack', 'Control Tower', 'Radar Dish'],
  });
  assert.equal(kept.objects[0], 'Laser Rifle Rack');
  assert.equal(kept.objects[1], 'Control Tower');
  assert.equal(kept.objects.length, 13);

  // The rack becomes build_order 0 in the manifest, so runtime treats it as the ranged rack.
  const manifest = themePlanToManifest(kept);
  assert.equal(manifest.buildable_objects?.[0].build_order, 0);
  assert.equal(manifest.buildable_objects?.[0].display_name, 'Laser Rifle Rack');
  assert.equal(manifest.buildable_objects?.length, 13);
});

test('object motion hints stay aligned to objects across rack coercion', () => {
  // Planner had no rack: slot 0 is coerced, its own objects shift down, and hints
  // shift with them (rack gets an empty hint, planner objects keep their hints).
  const coerced = normalizeThemePlan({
    display_name: 'Neon Harbor',
    objects: ['Console', 'Crane', 'Generator'],
    object_motion_hints: ['screen flickers', 'arm swings', 'core pulses'],
  });
  assert.equal(coerced.objects[0], 'Neon Harbor Ranged Weapon Rack');
  assert.equal(coerced.objects[1], 'Console');
  assert.equal(coerced.object_motion_hints?.length, coerced.objects.length);
  assert.equal(coerced.object_motion_hints?.[0], ''); // rack has no planner hint
  assert.equal(coerced.object_motion_hints?.[1], 'screen flickers'); // aligned to Console
  assert.equal(coerced.object_motion_hints?.[2], 'arm swings'); // aligned to Crane

  // Planner supplied a rack: its hint stays on slot 0.
  const kept = normalizeThemePlan({
    display_name: 'Neon Harbor',
    objects: ['Laser Rifle Rack', 'Console'],
    object_motion_hints: ['status light pulses', 'screen flickers'],
  });
  assert.equal(kept.objects[0], 'Laser Rifle Rack');
  assert.equal(kept.object_motion_hints?.[0], 'status light pulses');
  assert.equal(kept.object_motion_hints?.[1], 'screen flickers');

  // No hints supplied → field is omitted.
  const noHints = normalizeThemePlan({ display_name: 'Neon Harbor', objects: ['Console'] });
  assert.equal(noHints.object_motion_hints, undefined);
});

test('theme plan emits 9 decor objects: 4 sittable seats, 4 static, 1 animated', () => {
  const manifest = themePlanToManifest(normalizeThemePlan({
    display_name: 'Cozy Tavern',
    decor: ['Oak Stool', 'Bench', 'High Chair', 'Bar Seat', 'Barrel', 'Keg', 'Sign', 'Lantern', 'Fireplace'],
  }));
  const decor = manifest.decor_objects ?? [];
  assert.equal(decor.length, 9);

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
  // Animated decor (index 8, the single row-3 item): looping animation metadata present.
  assert.equal(decor[8].anim_fps, 5);
  assert.equal(decor[8].anim_loop, true);
  assert.equal(decor[8].is_sittable, undefined);
  // decor_ids are unique, so frame keys never collide.
  assert.equal(new Set(decor.map((d) => d.decor_id)).size, 9);

  // Row 4 of the decor board is the ranged-fire projectile FX, wired into the viewport.
  assert.equal(manifest.viewport?.projectile_asset, 'frames.json#projectile');
});

test('theme plan creates 16 agents, 3 enemies, and 13 buildable objects', () => {
  const manifest = themePlanToManifest(normalizeThemePlan({ display_name: 'Clockwork' }));
  assert.equal(manifest.roster_agents?.length, 16);
  assert.equal(manifest.roster_rivals?.length, 3);
  assert.equal(manifest.buildable_objects?.length, 13);
  assert.match(manifest.roster_agents?.[0].atlas_asset ?? '', /^frames\.json#agent_0$/);
  assert.equal(manifest.viewport?.crate_asset, 'frames.json#crate');
  assert.equal(manifest.viewport?.poof_asset, 'frames.json#poof');
  assert.equal(manifest.viewport?.overall_scale, 1);
});
