import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeThemeManifest } from '../src/extension/themeMigration';
import type { ThemeManifest } from '../src/shared/types';

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

  assert.ok(changed.length >= 5, `expected at least 5 change entries, got ${changed.length}`);
  assert.ok(changed.some((c) => c.includes('crate_asset')));
  assert.ok(changed.some((c) => c.includes('enemy_config')));
  assert.ok(changed.some((c) => c.includes('decor_objects')));
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

  assert.deepEqual(manifest.buildable_objects, source.buildable_objects);
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
