import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeThemeManifest, buildDefaultBadges } from '../src/extension/themeMigration';
import { THEME_OBJECT_COUNT } from '../src/extension/themePlan';
import type { BuildableObject, ThemeManifest } from '../src/shared/types';

// themeService.ts does `import * as vscode from 'vscode'` at module scope (needed by
// other exports); applyThemeItemNameChanges itself never touches the vscode API, but
// Node can't resolve the 'vscode' module outside the real extension host. Stub the
// module loader so the require chain below resolves under plain `node --test` — same
// trick as test/themeItemNames.test.ts / test/reviewSynthesis.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyThemeItemNameChanges } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

/** Builds `count` real (non-placeholder) buildable objects with distinct ids/names. */
function realBuildableObjects(count: number): BuildableObject[] {
  const objects: BuildableObject[] = [];
  for (let i = 0; i < count; i++) {
    objects.push({
      build_order: i,
      object_id: `real_${i}`,
      display_name: `Real Object ${i}`,
      sprite_asset: `frames.json#object_real_${i}`,
      anchor_coord: [0.1 + i * 0.01, 0.2],
      exclusion_radius: 40,
      work_units_required: 50,
      anim_fps: 8,
      anim_loop: false,
    });
  }
  return objects;
}

function minimalManifest(overrides: Partial<ThemeManifest> = {}): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: 'legacy_theme',
    display_name: 'Legacy Theme',
    author: 'test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [1, 1], [0, 1], [0, 1]],
    },
    roster_agents: [],
    roster_rivals: [],
    buildable_objects: [],
    decor_objects: [],
    badges: [],
    ...overrides,
  };
}

test('upgrades a legacy manifest missing all fields: crate/poof/projectile assets, enemy_config, 9 decor_objects', () => {
  const { manifest, changed } = upgradeThemeManifest(minimalManifest());

  assert.equal(manifest.viewport.crate_asset, 'frames.json#crate');
  assert.equal(manifest.viewport.poof_asset, 'frames.json#poof');
  assert.equal(manifest.viewport.projectile_asset, 'frames.json#projectile');
  assert.deepEqual(manifest.viewport.enemy_config, { spawn_interval_seconds: 45, count_mode: 'random' });

  assert.equal(manifest.decor_objects.length, 9);
  const sittable = manifest.decor_objects.filter((d) => d.is_sittable);
  assert.equal(sittable.length, 4);
  const animated = manifest.decor_objects.filter((d) => d.anim_fps !== undefined);
  assert.equal(animated.length, 1);
  assert.equal(animated[0].anim_loop, true);

  // No two decor placeholders stack on the same anchor.
  const anchorKeys = manifest.decor_objects.map((d) => `${d.anchor_coord[0]},${d.anchor_coord[1]}`);
  assert.equal(new Set(anchorKeys).size, 9);

  assert.equal(manifest.badges.length, 25);

  assert.ok(changed.length >= 5, `expected at least 5 change entries, got ${changed.length}`);
  assert.ok(changed.some((c) => c.includes('crate_asset')));
  assert.ok(changed.some((c) => c.includes('enemy_config')));
  assert.ok(changed.some((c) => c.includes('decor_objects')));
});

test('upgrades a manifest with empty badges to the 25 default badges', () => {
  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ badges: [] }));

  assert.equal(manifest.badges.length, 25);
  assert.ok(manifest.badges.some((b) => b.trigger_type === 'OBJECTS_BUILT'));
  assert.ok(manifest.badges.some((b) => b.trigger_type === 'RIVALS_EVICTED'));
  assert.ok(manifest.badges.some((b) => b.trigger_type === 'TASKS_COMPLETED'));
  assert.ok(manifest.badges.some((b) => b.trigger_type === 'AGENTS_ACTIVE'));
  assert.ok(manifest.badges.some((b) => b.trigger_type === 'REBIRTH_COUNT'));
  assert.ok(manifest.badges.some((b) => b.trigger_type === 'OBJECTS_BUILT_POST_REBIRTH'));
  for (const badge of manifest.badges) {
    assert.match(badge.icon_asset, /^frames\.json#achievement_/);
  }
  assert.ok(changed.includes('badges'));
});

test('the 4 rebirth_* milestone badges and the 1 rebirth-gated badge exist with unique ids/names', () => {
  const { manifest } = upgradeThemeManifest(minimalManifest({ badges: [] }));

  const rebirth1 = manifest.badges.find((b) => b.badge_id === 'rebirth_1');
  const rebirth2 = manifest.badges.find((b) => b.badge_id === 'rebirth_2');
  const rebirth3 = manifest.badges.find((b) => b.badge_id === 'rebirth_3');
  const rebirth5 = manifest.badges.find((b) => b.badge_id === 'rebirth_5');
  const gated = manifest.badges.find((b) => b.badge_id === 'reborn_builder');

  assert.ok(rebirth1 && rebirth1.trigger_type === 'REBIRTH_COUNT' && rebirth1.threshold === 1);
  assert.ok(rebirth2 && rebirth2.trigger_type === 'REBIRTH_COUNT' && rebirth2.threshold === 2);
  assert.ok(rebirth3 && rebirth3.trigger_type === 'REBIRTH_COUNT' && rebirth3.threshold === 3);
  assert.ok(rebirth5 && rebirth5.trigger_type === 'REBIRTH_COUNT' && rebirth5.threshold === 5);
  assert.ok(rebirth5 && rebirth5.icon_asset === 'frames.json#achievement_24');
  assert.ok(gated && gated.trigger_type === 'OBJECTS_BUILT_POST_REBIRTH');

  const ids = manifest.badges.map((b) => b.badge_id);
  assert.equal(new Set(ids).size, ids.length, 'all badge_ids must be unique');
  const names = manifest.badges.map((b) => b.display_name);
  assert.equal(new Set(names).size, names.length, 'all display_names must be unique');
});

test('merges missing default badges into a pre-existing custom badge array, preserving the custom entry', () => {
  const existingBadges = [{
    badge_id: 'custom_badge',
    display_name: 'Custom Badge',
    description: 'A custom badge.',
    trigger_type: 'OBJECTS_BUILT' as const,
    threshold: 2,
    icon_asset: 'frames.json#achievement_9',
  }];

  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ badges: existingBadges }));

  // The custom badge is preserved at the front, all 25 defaults are appended.
  assert.equal(manifest.badges.length, 26);
  assert.deepEqual(manifest.badges[0], existingBadges[0]);
  assert.ok(manifest.badges.some((b) => b.badge_id === 'task_500'));
  assert.ok(changed.some((c) => c.includes('25 new default badges')));
});

const OLD_EIGHT_BADGES = [
  { badge_id: 'build_1', display_name: 'First Build', description: 'Build 1 object.', trigger_type: 'OBJECTS_BUILT' as const, threshold: 1, icon_asset: 'frames.json#achievement_1' },
  { badge_id: 'build_3', display_name: 'Builder', description: 'Build 3 objects.', trigger_type: 'OBJECTS_BUILT' as const, threshold: 3, icon_asset: 'frames.json#achievement_2' },
  { badge_id: 'build_6', display_name: 'Developer', description: 'Build 6 objects.', trigger_type: 'OBJECTS_BUILT' as const, threshold: 6, icon_asset: 'frames.json#achievement_3' },
  { badge_id: 'build_10', display_name: 'Master Builder', description: 'Build 10 objects.', trigger_type: 'OBJECTS_BUILT' as const, threshold: 10, icon_asset: 'frames.json#achievement_4' },
  { badge_id: 'evict_1', display_name: 'First Eviction', description: 'Evict 1 rival.', trigger_type: 'RIVALS_EVICTED' as const, threshold: 1, icon_asset: 'frames.json#achievement_5' },
  { badge_id: 'evict_5', display_name: 'Defender', description: 'Evict 5 rivals.', trigger_type: 'RIVALS_EVICTED' as const, threshold: 5, icon_asset: 'frames.json#achievement_6' },
  { badge_id: 'evict_10', display_name: 'Enforcer', description: 'Evict 10 rivals.', trigger_type: 'RIVALS_EVICTED' as const, threshold: 10, icon_asset: 'frames.json#achievement_7' },
  { badge_id: 'evict_20', display_name: 'Warlord', description: 'Evict 20 rivals.', trigger_type: 'RIVALS_EVICTED' as const, threshold: 20, icon_asset: 'frames.json#achievement_8' },
];

test('upgrades an existing 8-badge manifest (old default set) to the full 25, preserving all originals', () => {
  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ badges: [...OLD_EIGHT_BADGES] }));

  assert.equal(manifest.badges.length, 25);

  // All 8 originals are preserved, in order, at the front.
  for (let i = 0; i < OLD_EIGHT_BADGES.length; i++) {
    assert.deepEqual(manifest.badges[i], OLD_EIGHT_BADGES[i]);
  }

  // A couple of the new defaults are now present.
  assert.ok(manifest.badges.some((b) => b.badge_id === 'task_500'));
  assert.ok(manifest.badges.some((b) => b.badge_id === 'crew_6'));
  assert.ok(manifest.badges.some((b) => b.badge_id === 'rebirth_2'));

  assert.ok(changed.some((c) => c.includes('17 new default badges')));
});

test('buildDefaultBadges emits Full House (crew_6) at threshold 4 with the matching description', () => {
  const crew6 = buildDefaultBadges().find((b) => b.badge_id === 'crew_6');
  assert.ok(crew6, 'crew_6 badge must exist in the default roster');
  assert.equal(crew6!.display_name, 'Full House');
  assert.equal(crew6!.threshold, 4);
  assert.equal(crew6!.description, 'Have 4 agents active at once.');
  assert.equal(crew6!.trigger_type, 'AGENTS_ACTIVE');
});

test('an existing manifest carrying crew_6 at the old threshold 6 is migrated to 4, preserving unlock state', () => {
  const legacyCrew6 = {
    badge_id: 'crew_6',
    display_name: 'Full House',
    description: 'Have 6 agents active at once.',
    trigger_type: 'AGENTS_ACTIVE' as const,
    threshold: 6,
    icon_asset: 'frames.json#achievement_18',
  };
  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ badges: [...OLD_EIGHT_BADGES, legacyCrew6] }));

  const migrated = manifest.badges.find((b) => b.badge_id === 'crew_6');
  assert.ok(migrated, 'crew_6 must still be present after migration');
  assert.equal(migrated!.threshold, 4);
  assert.equal(migrated!.description, 'Have 4 agents active at once.');
  // badge_id and display_name are stable — unlock tracking (keyed by badge_id,
  // stored outside the manifest entirely) is untouched by this patch.
  assert.equal(migrated!.badge_id, 'crew_6');
  assert.equal(migrated!.display_name, 'Full House');
  assert.ok(changed.some((c) => c.includes('crew_6')));

  // Idempotent: a second pass makes no further crew_6 change.
  const second = upgradeThemeManifest(manifest);
  assert.ok(!second.changed.some((c) => c.includes('crew_6')));
  assert.equal(second.manifest.badges.find((b) => b.badge_id === 'crew_6')!.threshold, 4);
});

test('a manifest already carrying crew_6 at threshold 4 is left untouched by the migration', () => {
  const currentCrew6 = {
    badge_id: 'crew_6',
    display_name: 'Full House',
    description: 'Have 4 agents active at once.',
    trigger_type: 'AGENTS_ACTIVE' as const,
    threshold: 4,
    icon_asset: 'frames.json#achievement_18',
  };
  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ badges: [...OLD_EIGHT_BADGES, currentCrew6] }));

  assert.ok(!changed.some((c) => c.includes('crew_6')));
  assert.deepEqual(manifest.badges.find((b) => b.badge_id === 'crew_6'), currentCrew6);
});

test('all 25 default badge display_names are unique (guards name collisions)', () => {
  const { manifest } = upgradeThemeManifest(minimalManifest({ badges: [] }));
  const names = manifest.badges.map((b) => b.display_name);
  assert.equal(new Set(names).size, names.length, `duplicate display_name found among: ${names.join(', ')}`);
});

test('badge upgrade is idempotent: a second pass makes no further changes', () => {
  const first = upgradeThemeManifest(minimalManifest({ badges: [] }));
  const second = upgradeThemeManifest(first.manifest);

  assert.deepEqual(second.manifest.badges, first.manifest.badges);
  assert.ok(!second.changed.some((c) => c.includes('badges')));
});

test('upgrade is idempotent: a second pass makes no further changes', () => {
  const first = upgradeThemeManifest(minimalManifest());
  const second = upgradeThemeManifest(first.manifest);

  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(second.changed, []);
});

test('preserves existing fields: buildable_objects, roster_rivals, character_scale, and a populated decor_objects array', () => {
  const existingDecor = [{
    decor_id: 'seat_custom',
    display_name: 'Custom Seat',
    sprite_asset: 'frames.json#decor_seat_custom',
    anchor_coord: [0.4, 0.6] as [number, number],
    is_sittable: true,
    sit_anchor: [0, -0.03] as [number, number],
  }];

  const source = minimalManifest({
    buildable_objects: [{
      build_order: 0,
      object_id: 'rack',
      display_name: 'Weapon Rack',
      sprite_asset: 'frames.json#object_0',
      anchor_coord: [100, 200],
      exclusion_radius: 40,
      work_units_required: 10,
      anim_fps: 8,
      anim_loop: false,
    }],
    roster_rivals: [{ rival_id: 'rival_0', name: 'Rival One', atlas_asset: 'frames.json#rival_0' }],
    decor_objects: existingDecor,
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [1, 1], [0, 1], [0, 1]],
      character_scale: 1.25,
    },
  });

  const { manifest, changed } = upgradeThemeManifest(source);

  // The single existing buildable object is preserved exactly; the rest of the
  // array is padded up to the v2 object contract (THEME_OBJECT_COUNT) with
  // placeholders, so length grows but the original entry is untouched at index 0.
  assert.deepEqual(manifest.buildable_objects[0], source.buildable_objects[0]);
  assert.equal(manifest.buildable_objects.length, THEME_OBJECT_COUNT);
  assert.deepEqual(manifest.roster_rivals, source.roster_rivals);
  assert.equal(manifest.viewport.character_scale, 1.25);
  assert.deepEqual(manifest.decor_objects, existingDecor);
  assert.ok(!changed.some((c) => c.includes('decor_objects')));

  // Missing viewport asset fields are still backfilled even though decor was preserved.
  assert.equal(manifest.viewport.crate_asset, 'frames.json#crate');

  // The original manifest object passed in is untouched (deep copy, not mutation).
  assert.equal(source.viewport.crate_asset, undefined);
});

test('backfills anim_fps/anim_loop on buildable_objects missing them, leaves already-set objects untouched, and stays idempotent', () => {
  const source = minimalManifest({
    buildable_objects: [
      {
        build_order: 0,
        object_id: 'lathe',
        display_name: 'Lathe',
        sprite_asset: 'frames.json#object_lathe',
        anchor_coord: [0.3, 0.4],
        exclusion_radius: 32,
        work_units_required: 100,
      },
      {
        build_order: 1,
        object_id: 'forge',
        display_name: 'Forge',
        sprite_asset: 'frames.json#object_forge',
        anchor_coord: [0.6, 0.5],
        exclusion_radius: 32,
        work_units_required: 100,
        anim_fps: 12,
        anim_loop: false,
      },
    ],
  });

  const first = upgradeThemeManifest(source);

  assert.equal(first.manifest.buildable_objects[0].anim_fps, 5);
  assert.equal(first.manifest.buildable_objects[0].anim_loop, true);
  // Already-declared anim params are preserved exactly, not overwritten.
  assert.equal(first.manifest.buildable_objects[1].anim_fps, 12);
  assert.equal(first.manifest.buildable_objects[1].anim_loop, false);
  assert.ok(first.changed.some((c) => c.includes('buildable object anim params')));

  const second = upgradeThemeManifest(first.manifest);
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(second.changed, []);
});

test('pads a legacy manifest with 12 buildable_objects up to THEME_OBJECT_COUNT, preserving the originals', () => {
  const originals = realBuildableObjects(12);
  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ buildable_objects: originals }));

  assert.equal(manifest.buildable_objects.length, THEME_OBJECT_COUNT);

  // The first 12 real objects are preserved byte-for-byte (id + display_name).
  for (let i = 0; i < 12; i++) {
    assert.equal(manifest.buildable_objects[i].object_id, originals[i].object_id);
    assert.equal(manifest.buildable_objects[i].display_name, originals[i].display_name);
  }

  // First padded slot (index 12) is a real, renameable placeholder object.
  const first = manifest.buildable_objects[12];
  assert.equal(first.object_id, 'object_13');
  assert.equal(first.display_name, 'Object 13');
  assert.equal(first.build_order, 12);
  assert.equal(first.sprite_asset, 'frames.json#object_object_13');

  // Last slot (index 20) closes out the 21-object contract.
  assert.equal(manifest.buildable_objects[20].object_id, 'object_21');

  assert.ok(changed.some((c) => /Padded buildable_objects/.test(c)), `expected a "Padded buildable_objects" change entry, got: ${changed.join(' | ')}`);
});

test('buildable_objects padding is idempotent: a second pass adds nothing further', () => {
  const first = upgradeThemeManifest(minimalManifest({ buildable_objects: realBuildableObjects(12) }));
  const second = upgradeThemeManifest(first.manifest);

  assert.equal(second.manifest.buildable_objects.length, THEME_OBJECT_COUNT);
  assert.ok(!second.changed.some((c) => /Padded buildable_objects/.test(c)), `second pass must not re-pad, got: ${second.changed.join(' | ')}`);
});

test('a manifest already at THEME_OBJECT_COUNT buildable_objects is left untouched (no padding)', () => {
  const full = realBuildableObjects(THEME_OBJECT_COUNT);
  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ buildable_objects: full }));

  assert.equal(manifest.buildable_objects.length, THEME_OBJECT_COUNT);
  assert.deepEqual(manifest.buildable_objects, full);
  assert.ok(!changed.some((c) => /Padded/.test(c)), `healthy manifest must not report padding, got: ${changed.join(' | ')}`);
});

test('a manifest with MORE than THEME_OBJECT_COUNT buildable_objects is truncated down, preserving the originals in order', () => {
  const over = realBuildableObjects(THEME_OBJECT_COUNT + 5);
  const { manifest, changed } = upgradeThemeManifest(minimalManifest({ buildable_objects: over }));

  assert.equal(manifest.buildable_objects.length, THEME_OBJECT_COUNT);
  assert.deepEqual(manifest.buildable_objects, over.slice(0, THEME_OBJECT_COUNT));
  assert.ok(changed.some((c) => /Truncated buildable_objects/.test(c)), `expected a "Truncated buildable_objects" change entry, got: ${changed.join(' | ')}`);
});

test('buildable_objects truncation is idempotent: a second pass makes no further changes', () => {
  const first = upgradeThemeManifest(minimalManifest({ buildable_objects: realBuildableObjects(THEME_OBJECT_COUNT + 5) }));
  const second = upgradeThemeManifest(first.manifest);

  assert.equal(second.manifest.buildable_objects.length, THEME_OBJECT_COUNT);
  assert.deepEqual(second.manifest, first.manifest);
  assert.ok(!second.changed.some((c) => /Truncated/.test(c)), `second pass must not re-truncate, got: ${second.changed.join(' | ')}`);
});

test('INTEGRATION: a padded placeholder object cell is renameable via applyThemeItemNameChanges (the bug fixed)', () => {
  const { manifest: paddedManifest } = upgradeThemeManifest(minimalManifest({ buildable_objects: realBuildableObjects(12) }));

  const result = applyThemeItemNameChanges(paddedManifest, [
    { item_kind: 'object', id: 'object_13', name: 'Cobra Flight Deck' },
  ]);

  assert.deepEqual(result.rejected, [], `rename of a padded cell must not be rejected, got: ${JSON.stringify(result.rejected)}`);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0], { item_kind: 'object', id: 'object_13', name: 'Cobra Flight Deck' });

  const renamed = paddedManifest.buildable_objects.find((o) => o.object_id === 'object_13');
  assert.ok(renamed, 'object_13 must exist in the padded manifest');
  assert.equal(renamed!.display_name, 'Cobra Flight Deck');
});
