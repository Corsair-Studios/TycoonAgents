import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeThemePlan,
  themePlanToManifest,
  FIXED_EXPRESSION_LABELS,
  themeHasFreedFrames,
} from '../src/extension/themePlan';
import type { ThemePlan } from '../src/extension/themePlan';

test('themeHasFreedFrames is true only for freed_frames: "v2"', () => {
  assert.equal(themeHasFreedFrames({ freed_frames: 'v2' }), true);
  assert.equal(themeHasFreedFrames({ freed_frames: 'v1' }), false);
  assert.equal(themeHasFreedFrames({}), false);
  assert.equal(themeHasFreedFrames(undefined), false);
  assert.equal(themeHasFreedFrames(null), false);
});

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
  assert.equal(plan.enemies.length, 4);
  assert.equal(plan.objects.length, 21);
  assert.equal(plan.decor.length, 9);
  assert.equal(plan.expressions.length, 8);
  assert.equal(plan.expressions[7], 'Dazed / hit');
  assert.equal(plan.achievements.length, 25);
});

// v0.0.657 bug fix regression: strict json_schema plan responses (backend
// ac82350) return optional fields as explicit `null` (present key, null
// value) instead of omitting them. normalizeThemePlan must not throw and
// must produce a plan with no lingering nulls.
test('theme plan normalizes cleanly when every optional field is explicitly null (strict json_schema shape)', () => {
  const plan = normalizeThemePlan({
    display_name: 'Neon Harbor',
    creative_direction: undefined,
    characters: ['Dockmaster'],
    character_descriptions: null as unknown as undefined,
    environment: null as unknown as undefined,
    objects: ['Console'],
    object_motion_hints: null as unknown as undefined,
    object_descriptions: null as unknown as undefined,
    crate_description: null as unknown as undefined,
    poof_description: null as unknown as undefined,
    projectile_description: null as unknown as undefined,
    decor: ['Seat'],
    decor_descriptions: null as unknown as undefined,
    enemies: ['Data Pirate'],
    enemy_attack_styles: null as unknown as undefined,
    enemy_descriptions: null as unknown as undefined,
    expressions: ['Delighted'],
    expression_descriptions: null as unknown as undefined,
    achievements: ['First Light'],
    achievement_descriptions: null as unknown as undefined,
  });
  assert.equal(plan.characters.length, 16);
  assert.equal(plan.objects.length, 21);
  assert.equal(plan.decor.length, 9);
  assert.equal(plan.enemies.length, 4);
  assert.equal(plan.achievements.length, 25);
  assert.equal(typeof plan.environment, 'string');
  assert.equal(plan.crate_description, undefined);
});

test('normalizeThemePlan does not throw on the exact production counts (objects=22, one over the 21-slot contract)', () => {
  const objects = Array.from({ length: 22 }, (_, i) => `Object ${i + 1}`);
  const plan = normalizeThemePlan({
    display_name: 'Cozy Forest',
    characters: Array.from({ length: 16 }, (_, i) => `Character ${i + 1}`),
    objects,
    object_descriptions: objects.map((_, i) => `Object ${i + 1} desc`),
    decor: Array.from({ length: 9 }, (_, i) => `Decor ${i + 1}`),
    enemies: Array.from({ length: 4 }, (_, i) => `Enemy ${i + 1}`),
    expressions: Array.from({ length: 8 }, (_, i) => `Expression ${i + 1}`),
    achievements: Array.from({ length: 25 }, (_, i) => `Achievement ${i + 1}`),
  });
  assert.equal(plan.objects.length, 21);
  assert.equal(plan.object_descriptions?.length, 21);
});

test('FIXED_EXPRESSION_LABELS carries the 8-icon expression contract, ending in "Dazed / hit"', () => {
  assert.equal(FIXED_EXPRESSION_LABELS.length, 8);
  assert.deepEqual(FIXED_EXPRESSION_LABELS, [
    'Love',
    'Idea / discovery spark',
    'Anger',
    'Team action / rally',
    'Thumbs up',
    'Music',
    'Sleep / low-energy zzz',
    'Dazed / hit',
  ]);
});

test('object slot 0 is always a themed ranged weapon rack (build_order 0 convention)', () => {
  // Planner returned no suitable rack: slot 0 is coerced to a themed default,
  // and the planner's own first object is preserved (shifted into the free slots).
  const coerced = normalizeThemePlan({
    display_name: 'Neon Harbor',
    objects: ['Console', 'Crane', 'Generator'],
  });
  assert.equal(coerced.objects.length, 21);
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
  assert.equal(kept.objects.length, 21);

  // The rack becomes build_order 0 in the manifest, so runtime treats it as the ranged rack.
  const manifest = themePlanToManifest(kept);
  assert.equal(manifest.buildable_objects?.[0].build_order, 0);
  assert.equal(manifest.buildable_objects?.[0].display_name, 'Laser Rifle Rack');
  assert.equal(manifest.buildable_objects?.length, 21);
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

test('a plan missing decor entries pads by slot role: seats, static decor, then the animated slot', () => {
  // Only 2 of 9 decor entries supplied; the remaining 7 must be padded by the
  // slot's fixed board role (mirrors buildDefaultDecorObjects in
  // themeMigration.ts), NOT one generic "Decor N" label for every slot.
  const plan = normalizeThemePlan({
    display_name: 'Sparse Decor',
    decor: ['Oak Stool', 'Bench'],
  });
  assert.equal(plan.decor.length, 9);
  assert.equal(plan.decor[0], 'Oak Stool');
  assert.equal(plan.decor[1], 'Bench');
  // Padded seats (indices 2-3, the remainder of the 0-3 seat row).
  assert.equal(plan.decor[2], 'Seat 3');
  assert.equal(plan.decor[3], 'Seat 4');
  // Padded static decor (indices 4-7).
  assert.equal(plan.decor[4], 'Decor 1');
  assert.equal(plan.decor[5], 'Decor 2');
  assert.equal(plan.decor[6], 'Decor 3');
  assert.equal(plan.decor[7], 'Decor 4');
  // Padded animated decor (index 8) matches buildDefaultDecorObjects exactly.
  assert.equal(plan.decor[8], 'Animated Decor 1');
});

test('a plan with zero decor entries pads all 9 slots by role', () => {
  const plan = normalizeThemePlan({ display_name: 'Empty Decor' });
  assert.equal(plan.decor.length, 9);
  for (let i = 0; i < 4; i++) assert.equal(plan.decor[i], `Seat ${i + 1}`);
  for (let i = 4; i < 8; i++) assert.equal(plan.decor[i], `Decor ${i - 3}`);
  assert.equal(plan.decor[8], 'Animated Decor 1');
});

test('theme plan creates 16 agents, 4 enemies, and 21 buildable objects', () => {
  const manifest = themePlanToManifest(normalizeThemePlan({ display_name: 'Clockwork' }));
  assert.equal(manifest.roster_agents?.length, 16);
  assert.equal(manifest.roster_rivals?.length, 4);
  assert.equal(manifest.buildable_objects?.length, 21);
  assert.match(manifest.roster_agents?.[0].atlas_asset ?? '', /^frames\.json#agent_0$/);
  assert.equal(manifest.viewport?.crate_asset, 'frames.json#crate');
  assert.equal(manifest.viewport?.poof_asset, 'frames.json#poof');
  assert.equal(manifest.viewport?.overall_scale, 1);
});

// --- Per-rival melee/ranged attack style -----------------------------------
//
// translator.ts's private `coerceAttackStyle` helper is not exported and
// `expandThemePlan` requires a live vscode module + network fetch that this
// node:test harness cannot provide, so its coercion contract (lowercase,
// only 'melee'/'ranged' pass through, everything else incl. garbage/number/
// null/missing -> undefined, NEVER 'ranged') is instead validated through
// `normalizeThemePlan`'s equivalent internal `normalizeAttackStyle`, which
// shares the exact same contract and is reachable via this public API.

test('enemy_attack_styles values normalize case-insensitively; garbage/empty strings become undefined, never "ranged"', () => {
  const plan = normalizeThemePlan({
    display_name: 'Style Test',
    enemies: ['Alpha', 'Beta', 'Gamma', 'Delta'],
    enemy_attack_styles: ['MELEE', 'Ranged', 'bogus', ''] as unknown as ThemePlan['enemy_attack_styles'],
  });
  assert.equal(plan.enemy_attack_styles?.[0], 'melee');
  assert.equal(plan.enemy_attack_styles?.[1], 'ranged');
  assert.equal(plan.enemy_attack_styles?.[2], undefined);
  assert.notEqual(plan.enemy_attack_styles?.[2], 'ranged');
  assert.equal(plan.enemy_attack_styles?.[3], undefined);
});

test('non-string enemy_attack_styles entries (number, null) and an omitted styles array all normalize to undefined, never "ranged"', () => {
  const withNonStrings = normalizeThemePlan({
    display_name: 'Style Test 2',
    enemies: ['Alpha', 'Beta', 'Gamma', 'Delta'],
    enemy_attack_styles: [42, null, 'melee', undefined] as unknown as ThemePlan['enemy_attack_styles'],
  });
  assert.equal(withNonStrings.enemy_attack_styles?.[0], undefined);
  assert.notEqual(withNonStrings.enemy_attack_styles?.[0], 'ranged');
  assert.equal(withNonStrings.enemy_attack_styles?.[1], undefined);
  assert.equal(withNonStrings.enemy_attack_styles?.[2], 'melee');
  assert.equal(withNonStrings.enemy_attack_styles?.[3], undefined);

  const withoutStylesField = normalizeThemePlan({
    display_name: 'Style Test 3',
    enemies: ['Alpha', 'Beta', 'Gamma', 'Delta'],
  });
  assert.equal(withoutStylesField.enemy_attack_styles, undefined);
});

test('themePlanToManifest threads enemy_attack_styles onto roster_rivals by index, omitting the field when unclassified', () => {
  const plan = normalizeThemePlan({
    display_name: 'Skirmish',
    enemies: ['Grunt', 'Sniper', 'Brute', 'Marksman'],
    enemy_attack_styles: ['melee', 'ranged', undefined, 'ranged'],
  });
  const manifest = themePlanToManifest(plan);
  const rivals = manifest.roster_rivals ?? [];
  assert.equal(rivals.length, 4);
  assert.equal(rivals[0].attack_style, 'melee');
  assert.equal(rivals[1].attack_style, 'ranged');
  assert.equal(rivals[2].attack_style, undefined);
  assert.equal('attack_style' in rivals[2], false);
  assert.equal(rivals[3].attack_style, 'ranged');
});

test('roster_rivals omit attack_style entirely when the plan has no enemy_attack_styles (legacy default applies at render)', () => {
  const plan = normalizeThemePlan({
    display_name: 'Legacy Set',
    enemies: ['Alpha', 'Beta', 'Gamma', 'Delta'],
  });
  const manifest = themePlanToManifest(plan);
  const rivals = manifest.roster_rivals ?? [];
  assert.equal(rivals.length, 4);
  for (const rival of rivals) {
    assert.equal(rival.attack_style, undefined);
    assert.equal('attack_style' in rival, false);
  }
});

test('enemy_attack_styles stays paired to its own enemy across blank-name filtering (index alignment survives)', () => {
  // Blank entry at index 1 is dropped by normalizeEnemies; if pairing happened
  // AFTER filtering (a reindexing bug) Brute would inherit the dropped blank's
  // 'ranged' style instead of its own 'melee' (originally at index 2).
  const plan = normalizeThemePlan({
    display_name: 'Alignment Test',
    enemies: ['Grunt', '', 'Brute'],
    enemy_attack_styles: ['melee', 'ranged', 'melee'],
  });
  assert.equal(plan.enemies[0], 'Grunt');
  assert.equal(plan.enemies[1], 'Brute'); // blank dropped, Brute shifts up to index 1
  assert.equal(plan.enemies.length, 4);
  assert.equal(plan.enemy_attack_styles?.[0], 'melee'); // Grunt keeps its own style
  assert.equal(plan.enemy_attack_styles?.[1], 'melee'); // Brute keeps ITS OWN style, not the dropped blank's 'ranged'
  assert.equal(plan.enemy_attack_styles?.[2], undefined); // padded fallback enemy, no style
  assert.equal(plan.enemy_attack_styles?.[3], undefined);
});

// --- Per-item visual descriptions (character/object/decor/enemy) -----------
//
// alignDescriptions() (themePlan.ts, private) pairs each raw name with its
// raw description BEFORE blank-name filtering/padding, mirroring the
// enemy_attack_styles / object_motion_hints pairing pattern above. It is not
// exported, so its contract is validated through normalizeThemePlan, the
// same way enemy_attack_styles' internal normalizeAttackStyle is validated.

test('character_descriptions align to characters, pad missing with empty string, and omit entirely when absent', () => {
  const withDescriptions = normalizeThemePlan({
    display_name: 'Neon Harbor',
    characters: ['Dockmaster', 'Scrap Runner'],
    character_descriptions: ['A grizzled dockworker in a weathered coat', 'A wiry scavenger with a jury-rigged jetpack'],
  });
  assert.equal(withDescriptions.characters.length, 16);
  assert.equal(withDescriptions.character_descriptions?.length, 16);
  assert.equal(withDescriptions.character_descriptions?.[0], 'A grizzled dockworker in a weathered coat');
  assert.equal(withDescriptions.character_descriptions?.[1], 'A wiry scavenger with a jury-rigged jetpack');
  // Padded fallback characters (2-15) get an empty description, never a stale/misaligned one.
  for (let i = 2; i < 16; i++) assert.equal(withDescriptions.character_descriptions?.[i], '');

  // No description array supplied at all -> field stays fully undefined, never throws.
  const withoutDescriptions = normalizeThemePlan({
    display_name: 'Neon Harbor',
    characters: ['Dockmaster'],
  });
  assert.equal(withoutDescriptions.character_descriptions, undefined);
});

test('character_descriptions stays paired to its own character across blank-name filtering (index alignment survives)', () => {
  const plan = normalizeThemePlan({
    display_name: 'Alignment Test',
    characters: ['Grunt', '', 'Brute'],
    character_descriptions: ['grunt desc', 'orphaned desc', 'brute desc'],
  });
  assert.equal(plan.characters[0], 'Grunt');
  assert.equal(plan.characters[1], 'Brute'); // blank dropped, Brute shifts up to index 1
  assert.equal(plan.character_descriptions?.[0], 'grunt desc'); // Grunt keeps its own description
  assert.equal(plan.character_descriptions?.[1], 'brute desc'); // Brute keeps ITS OWN description, not the dropped blank's
});

test('character_descriptions omit the field entirely when every supplied description is blank/whitespace', () => {
  const plan = normalizeThemePlan({
    display_name: 'Blank Descriptions',
    characters: ['A', 'B'],
    character_descriptions: ['   ', ''],
  });
  assert.equal(plan.character_descriptions, undefined);
});

test('decor_descriptions align to the 9-slot decor board and pad missing slots with empty string', () => {
  const plan = normalizeThemePlan({
    display_name: 'Cozy Tavern',
    decor: ['Oak Stool', 'Bench'],
    decor_descriptions: ['A rustic wooden stool', 'A long oak bench'],
  });
  assert.equal(plan.decor.length, 9);
  assert.equal(plan.decor_descriptions?.length, 9);
  assert.equal(plan.decor_descriptions?.[0], 'A rustic wooden stool');
  assert.equal(plan.decor_descriptions?.[1], 'A long oak bench');
  for (let i = 2; i < 9; i++) assert.equal(plan.decor_descriptions?.[i], '');
});

test('object_descriptions stay aligned to objects across ranged-weapon-rack slot-0 coercion', () => {
  // Planner had no rack: slot 0 is coerced to the themed default and gets a
  // non-empty fallback description (not the planner's); the planner's own
  // objects shift down and keep their own descriptions.
  const coerced = normalizeThemePlan({
    display_name: 'Neon Harbor',
    objects: ['Console', 'Crane', 'Generator'],
    object_descriptions: ['a flickering terminal', 'a yellow gantry crane', 'a humming reactor core'],
  });
  assert.equal(coerced.objects[0], 'Neon Harbor Ranged Weapon Rack');
  // Coerced rack has no planner description, so it gets the deterministic
  // default rack description — never empty.
  assert.match(coerced.object_descriptions?.[0] ?? '', /rack|stand/i);
  assert.match(coerced.object_descriptions?.[0] ?? '', /ranged/i);
  assert.equal(coerced.objects[1], 'Console');
  assert.equal(coerced.object_descriptions?.[1], 'a flickering terminal');
  assert.equal(coerced.objects[2], 'Crane');
  assert.equal(coerced.object_descriptions?.[2], 'a yellow gantry crane');
  assert.equal(coerced.object_descriptions?.length, 21);
  // Every one of the 21 slots is non-empty, including the padded fallback
  // slots beyond what the planner supplied.
  for (const description of coerced.object_descriptions ?? []) {
    assert.ok(description.length > 0);
  }

  // Planner already supplied a rack: its own description stays on slot 0.
  const kept = normalizeThemePlan({
    display_name: 'Neon Command',
    objects: ['Laser Rifle Rack', 'Control Tower'],
    object_descriptions: ['a wall rack of glowing rifles', 'a tall radar tower'],
  });
  assert.equal(kept.objects[0], 'Laser Rifle Rack');
  assert.equal(kept.object_descriptions?.[0], 'a wall rack of glowing rifles');
  assert.equal(kept.objects[1], 'Control Tower');
  assert.equal(kept.object_descriptions?.[1], 'a tall radar tower');

  // No descriptions supplied at all -> field is now ALWAYS a defined,
  // 21-length array of non-empty fallback descriptions (never undefined).
  const none = normalizeThemePlan({ display_name: 'Neon Harbor', objects: ['Console'] });
  assert.equal(none.object_descriptions?.length, 21);
  for (const description of none.object_descriptions ?? []) {
    assert.ok(description.length > 0);
  }
});

test('object_descriptions: undercount (20 names + 20 descriptions) still yields 21 non-empty entries', () => {
  const objectNames = Array.from({ length: 20 }, (_, i) => `Object ${i + 1}`);
  const objectDescriptions = objectNames.map((name) => `${name} description`);
  const plan = normalizeThemePlan({
    display_name: 'Undercount Theme',
    objects: objectNames,
    object_descriptions: objectDescriptions,
  });
  assert.equal(plan.objects.length, 21);
  assert.equal(plan.object_descriptions?.length, 21);
  for (const description of plan.object_descriptions ?? []) {
    assert.ok(description.length > 0);
  }
});

test('object_descriptions: first object is not a rack and no descriptions supplied -> coerced rack slot 0 gets non-empty default rack wording', () => {
  const plan = normalizeThemePlan({
    display_name: 'Frost Peak',
    objects: ['Bench', 'Lantern'],
  });
  assert.equal(plan.objects[0], 'Frost Peak Ranged Weapon Rack');
  const rackDescription = plan.object_descriptions?.[0] ?? '';
  assert.ok(rackDescription.length > 0);
  assert.match(rackDescription, /rack|stand/i);
  assert.match(rackDescription, /ranged/i);
});

test('object_descriptions: a normal full 21+21 supply passes through unchanged at each index (no fallback clobbering)', () => {
  const objectNames = ['Themed Ranged Weapon Rack', ...Array.from({ length: 20 }, (_, i) => `Object ${i + 1}`)];
  const objectDescriptions = objectNames.map((name) => `${name} real description`);
  const plan = normalizeThemePlan({
    display_name: 'Full Supply Theme',
    objects: objectNames,
    object_descriptions: objectDescriptions,
  });
  assert.equal(plan.objects.length, 21);
  assert.equal(plan.object_descriptions?.length, 21);
  plan.object_descriptions?.forEach((description, index) => {
    assert.equal(description, objectDescriptions[index]);
  });
});

test('enemy_descriptions stay paired to their own enemy across blank-name filtering, and omit when absent', () => {
  const plan = normalizeThemePlan({
    display_name: 'Alignment Test',
    enemies: ['Grunt', '', 'Brute'],
    enemy_descriptions: ['grunt desc', 'orphaned desc', 'brute desc'],
  });
  assert.equal(plan.enemies[0], 'Grunt');
  assert.equal(plan.enemies[1], 'Brute'); // blank dropped, Brute shifts up to index 1
  assert.equal(plan.enemy_descriptions?.[0], 'grunt desc');
  assert.equal(plan.enemy_descriptions?.[1], 'brute desc'); // Brute keeps ITS OWN description
  assert.equal(plan.enemy_descriptions?.length, 4);

  const none = normalizeThemePlan({ display_name: 'No Descriptions', enemies: ['Alpha'] });
  assert.equal(none.enemy_descriptions, undefined);
});

test('a plan JSON that omits every *_descriptions array entirely never throws and leaves each field undefined, except object_descriptions which always defaults to 21 non-empty fallbacks', () => {
  const plan = normalizeThemePlan({
    display_name: 'No Descriptions Anywhere',
    characters: ['A'],
    objects: ['Console'],
    decor: ['Stool'],
    enemies: ['Grunt'],
  });
  assert.equal(plan.character_descriptions, undefined);
  // object_descriptions is the exception: reserveRangedWeaponRackSlot always
  // fills all 21 slots with a non-empty fallback, so this is never undefined.
  assert.equal(plan.object_descriptions?.length, 21);
  for (const description of plan.object_descriptions ?? []) {
    assert.ok(description.length > 0);
  }
  assert.equal(plan.decor_descriptions, undefined);
  assert.equal(plan.enemy_descriptions, undefined);
  assert.equal(plan.expression_descriptions, undefined);
  assert.equal(plan.achievement_descriptions, undefined);
});

// --- Single-string projectile_description (mirrors crate_description /
// poof_description: a single string, not a per-slot array, since there is
// exactly one ranged-combat projectile FX per theme) -------------------------

test('projectile_description is trimmed/cleaned when supplied, and undefined when absent or blank', () => {
  const withDescription = normalizeThemePlan({
    display_name: 'Neon Harbor',
    projectile_description: '  a blue laser bolt  ',
  });
  assert.equal(withDescription.projectile_description, 'a blue laser bolt');

  const absent = normalizeThemePlan({ display_name: 'Neon Harbor' });
  assert.equal(absent.projectile_description, undefined);

  const blank = normalizeThemePlan({ display_name: 'Neon Harbor', projectile_description: '   ' });
  assert.equal(blank.projectile_description, undefined);
});
