import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateThemeIntegrity } from '../src/extension/themeHealth';
import type { ThemeManifest } from '../src/shared/types';

function minimalManifest(overrides: Partial<ThemeManifest> = {}): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: 'test_theme',
    display_name: 'Test Theme',
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

function baseFrames(): Record<string, string[]> {
  const frames: Record<string, string[]> = {};
  for (let i = 0; i < 20; i++) frames[`achievement_${i}`] = ['data:img'];
  for (let i = 0; i < 16; i++) frames[`expression_${i}`] = ['data:img'];
  return frames;
}

test('clean theme with matching roster and frames produces no issues', () => {
  const manifest = minimalManifest({
    roster_agents: [{ slot_id: 1, name: 'Alice', atlas_asset: 'frames.json#character_1', preferred_idle_pose: 'pose_down' }],
    roster_rivals: [{ rival_id: 'roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' }],
    buildable_objects: [
      {
        build_order: 1,
        object_id: 'crate1',
        display_name: 'Crate',
        sprite_asset: 'frames.json#object_crate1',
        anchor_coord: [0, 0],
        exclusion_radius: 10,
        work_units_required: 5,
      },
    ],
    decor_objects: [
      {
        decor_id: 'plant',
        display_name: 'Plant',
        sprite_asset: 'frames.json#decor_plant',
        anchor_coord: [0.5, 0.5],
      },
    ],
  });
  const frames = {
    ...baseFrames(),
    character_1: ['data:img'],
    rival_roadblock: ['data:img'],
    object_crate1: ['data:img'],
    decor_plant: ['data:img'],
  };

  const issues = validateThemeIntegrity(manifest, frames);
  assert.deepEqual(issues, []);
});

test('a rival in roster_rivals missing its frames key produces a missing_frames error naming the rival', () => {
  const manifest = minimalManifest({
    roster_rivals: [
      { rival_id: 'roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' },
      { rival_id: 'ghost', name: 'Ghost', atlas_asset: 'frames.json#rival_ghost' },
    ],
  });
  const frames = {
    ...baseFrames(),
    rival_roadblock: ['data:img'],
    // rival_ghost intentionally absent
  };

  const issues = validateThemeIntegrity(manifest, frames);
  const missing = issues.filter((i) => i.kind === 'missing_frames');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'error');
  assert.equal(missing[0].key, 'rival_ghost');
  assert.match(missing[0].message, /Ghost/);
  assert.match(missing[0].message, /rival_ghost/);
});

test('an empty frames array produces an empty_frames warning', () => {
  const manifest = minimalManifest({
    roster_rivals: [{ rival_id: 'roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' }],
  });
  const frames = {
    ...baseFrames(),
    rival_roadblock: [],
  };

  const issues = validateThemeIntegrity(manifest, frames);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'empty_frames');
  assert.equal(issues[0].severity, 'warning');
  assert.equal(issues[0].key, 'rival_roadblock');
});

test('an orphan object_zzz frames key with no roster entry produces an orphan_frames warning', () => {
  const manifest = minimalManifest();
  const frames = {
    ...baseFrames(),
    object_zzz: ['data:img'],
  };

  const issues = validateThemeIntegrity(manifest, frames);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'orphan_frames');
  assert.equal(issues[0].severity, 'warning');
  assert.equal(issues[0].key, 'object_zzz');
});

test('regression: a rival whose id already carries the rival_ prefix is not double-prefixed', () => {
  // rival_id "rival_scarlett" + atlas_asset "frames.json#rival_scarlett" with a
  // matching frames key must yield ZERO issues. Previously the validator derived
  // "rival_rival_scarlett" → a false missing_frames AND a false orphan_frames.
  const manifest = minimalManifest({
    roster_rivals: [
      { rival_id: 'rival_scarlett', name: 'Scarlett', atlas_asset: 'frames.json#rival_scarlett' },
    ],
  });
  const frames = {
    ...baseFrames(),
    rival_scarlett: ['data:img'],
  };

  const issues = validateThemeIntegrity(manifest, frames);
  assert.deepEqual(issues, []);
});

test('regression: an agent whose atlas_asset key matches a present frames key yields no issue', () => {
  const manifest = minimalManifest({
    roster_agents: [
      { slot_id: 7, name: 'Nova', atlas_asset: 'frames.json#character_nova', preferred_idle_pose: 'pose_down' },
    ],
  });
  const frames = {
    ...baseFrames(),
    character_nova: ['data:img'],
  };

  const issues = validateThemeIntegrity(manifest, frames);
  assert.deepEqual(issues, []);
});

test('a roster entry whose asset key is genuinely absent from frames still errors', () => {
  const manifest = minimalManifest({
    roster_rivals: [
      { rival_id: 'rival_scarlett', name: 'Scarlett', atlas_asset: 'frames.json#rival_scarlett' },
    ],
  });
  const frames = { ...baseFrames() }; // rival_scarlett absent

  const issues = validateThemeIntegrity(manifest, frames);
  const missing = issues.filter((i) => i.kind === 'missing_frames');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].key, 'rival_scarlett');
  assert.match(missing[0].message, /Scarlett/);
});

test('achievement_ and expression_ frame keys are never flagged as orphans', () => {
  const manifest = minimalManifest();
  const frames = baseFrames();

  const issues = validateThemeIntegrity(manifest, frames);
  assert.deepEqual(issues, []);
});

test('undefined roster arrays (older manifests) do not throw and are treated as empty', () => {
  const manifest = minimalManifest();
  delete (manifest as Partial<ThemeManifest>).roster_agents;
  delete (manifest as Partial<ThemeManifest>).roster_rivals;
  delete (manifest as Partial<ThemeManifest>).buildable_objects;
  delete (manifest as Partial<ThemeManifest>).decor_objects;

  const frames = baseFrames();

  assert.doesNotThrow(() => validateThemeIntegrity(manifest, frames));
  const issues = validateThemeIntegrity(manifest, frames);
  assert.deepEqual(issues, []);
});
