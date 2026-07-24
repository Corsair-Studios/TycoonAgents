import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThemeManifest } from '../src/shared/types';

// themeService.ts does `import * as vscode from 'vscode'` at module scope (needed by
// other exports); applyThemeItemNameChanges itself never touches the vscode API, but
// Node can't resolve the 'vscode' module outside the real extension host. Stub the
// module loader so this file's require chain resolves under plain `node --test` — same
// trick as test/reviewSynthesis.test.ts.
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
const { applyThemeItemNameChanges, applyThemeObjectTurretFlag } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

function testManifest(): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: 'test_theme',
    display_name: 'Test Theme',
    author: 'test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    },
    roster_agents: [
      { slot_id: 0, name: 'Agent Zero', atlas_asset: 'frames.json#agent_0', preferred_idle_pose: 'pose_crossed' },
      { slot_id: 1, name: 'Agent One', atlas_asset: 'frames.json#agent_1', preferred_idle_pose: 'pose_down' },
    ],
    roster_rivals: [
      { rival_id: 'rival_0', name: 'Rival Zero', atlas_asset: 'frames.json#rival_0' },
    ],
    buildable_objects: [
      {
        build_order: 0,
        object_id: 'crate_01',
        display_name: 'Crate 01',
        sprite_asset: 'frames.json#object_crate_01',
        anchor_coord: [0, 0],
        exclusion_radius: 40,
        work_units_required: 10,
      },
    ],
    decor_objects: [
      {
        decor_id: 'seat_01',
        display_name: 'Seat 01',
        sprite_asset: 'frames.json#decor_seat_01',
        anchor_coord: [0.5, 0.5],
      },
    ],
    badges: [],
  };
}

test('applyThemeItemNameChanges applies object, decor, character, and rival renames in one batch', () => {
  const manifest = testManifest();
  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'crate_01', name: 'Supply Crate' },
    { item_kind: 'decor', id: 'seat_01', name: 'Camp Chair' },
    { item_kind: 'character', id: 'agent_0', name: 'Vex' },
    { item_kind: 'rival', id: 'rival_0', name: 'Warden' },
  ]);

  assert.equal(result.applied.length, 4);
  assert.equal(result.rejected.length, 0);
  assert.equal(manifest.buildable_objects[0].display_name, 'Supply Crate');
  assert.equal(manifest.decor_objects[0].display_name, 'Camp Chair');
  assert.equal(manifest.roster_agents[0].name, 'Vex');
  assert.equal(manifest.roster_agents[1].name, 'Agent One');
  assert.equal(manifest.roster_rivals[0].name, 'Warden');
});

test('applyThemeItemNameChanges rejects unknown ids without corrupting other applied changes', () => {
  const manifest = testManifest();
  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'crate_01', name: 'Supply Crate' },
    { item_kind: 'object', id: 'no_such_object', name: 'Ghost Crate' },
    { item_kind: 'character', id: 'agent_9', name: 'Nobody' },
  ]);

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].id, 'crate_01');
  assert.equal(result.rejected.length, 2);
  assert.deepEqual(result.rejected.map((r) => r.id).sort(), ['agent_9', 'no_such_object']);
  assert.equal(manifest.buildable_objects[0].display_name, 'Supply Crate');
  // The rest of the manifest is untouched by the rejected rows.
  assert.equal(manifest.roster_agents[0].name, 'Agent Zero');
  assert.equal(manifest.roster_agents[1].name, 'Agent One');
});

test('applyThemeItemNameChanges rejects empty/whitespace and over-60-character names', () => {
  const manifest = testManifest();
  const tooLong = 'x'.repeat(61);
  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'crate_01', name: '   ' },
    { item_kind: 'decor', id: 'seat_01', name: tooLong },
  ]);

  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.equal(manifest.buildable_objects[0].display_name, 'Crate 01');
  assert.equal(manifest.decor_objects[0].display_name, 'Seat 01');
});

test('applyThemeItemNameChanges trims and collapses internal whitespace', () => {
  const manifest = testManifest();
  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'crate_01', name: '  Supply   Crate  ' },
  ]);

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].name, 'Supply Crate');
  assert.equal(manifest.buildable_objects[0].display_name, 'Supply Crate');
});

// Regression test for the "renaming a rival always fails" bug: manifest
// roster_rivals[].rival_id keeps the `rival_` PREFIX (see themePlan.ts), but
// the webview's rival_rows carry that prefix STRIPPED (see themeRivalSpecs in
// themeService.ts, which strips it so frame keys built as `rival_<id>` don't
// double-prefix). The row id the webview actually posts is the stripped form
// ("roadblock"), not the manifest's full rival_id ("rival_roadblock").
test('applyThemeItemNameChanges renames a rival by its stripped rival_rows id, leaving rival_id/atlas_asset untouched', () => {
  const manifest = testManifest();
  manifest.roster_rivals = [
    { rival_id: 'rival_roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' },
  ];

  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'rival', id: 'roadblock', name: 'Gung Ho' },
  ]);

  assert.equal(result.rejected.length, 0);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].id, 'roadblock');
  assert.equal(manifest.roster_rivals[0].name, 'Gung Ho');
  // rival_id and atlas_asset are frame-key-linked identifiers, not display text —
  // a rename must never touch them.
  assert.equal(manifest.roster_rivals[0].rival_id, 'rival_roadblock');
  assert.equal(manifest.roster_rivals[0].atlas_asset, 'frames.json#rival_roadblock');
});

test('applyThemeItemNameChanges still matches a rival by its full (unstripped) rival_id', () => {
  const manifest = testManifest();
  manifest.roster_rivals = [
    { rival_id: 'rival_roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' },
  ];

  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'rival', id: 'rival_roadblock', name: 'Gung Ho' },
  ]);

  assert.equal(result.rejected.length, 0);
  assert.equal(manifest.roster_rivals[0].name, 'Gung Ho');
  assert.equal(manifest.roster_rivals[0].rival_id, 'rival_roadblock');
});

test('applyThemeItemNameChanges applies a mixed object + rival batch and reports an unknown-rival reason by id', () => {
  const manifest = testManifest();
  manifest.roster_rivals = [
    { rival_id: 'rival_roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' },
  ];

  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'crate_01', name: 'Supply Crate' },
    { item_kind: 'rival', id: 'roadblock', name: 'Gung Ho' },
    { item_kind: 'rival', id: 'ghost', name: 'Nobody' },
  ]);

  assert.equal(result.applied.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].id, 'ghost');
  assert.equal(result.rejected[0].reason, 'Unknown rival "ghost".');
  assert.equal(manifest.buildable_objects[0].display_name, 'Supply Crate');
  assert.equal(manifest.roster_rivals[0].name, 'Gung Ho');
});

// p2-t1: opt-in per-object is_turret flag (Phase 2 groundwork — marking only,
// nothing auto-fires yet). Mirrors applyThemeItemNameChanges's manifest-only,
// no-IO shape so it's directly unit-testable the same way.
test('applyThemeObjectTurretFlag sets is_turret on the matching object only, leaving other fields untouched', () => {
  const manifest = testManifest();
  manifest.buildable_objects.push({
    build_order: 1,
    object_id: 'windmill_01',
    display_name: 'Windmill 01',
    sprite_asset: 'frames.json#object_windmill_01',
    anchor_coord: [0.5, 0.5],
    exclusion_radius: 32,
    work_units_required: 100,
    anim_fps: 5,
    anim_loop: true,
  });

  const changed = applyThemeObjectTurretFlag(manifest, 'windmill_01', true);

  assert.equal(changed, true);
  assert.equal(manifest.buildable_objects[1].is_turret, true);
  // Untouched: the other object, and every other field on the flipped object.
  assert.equal(manifest.buildable_objects[0].is_turret, undefined);
  assert.equal(manifest.buildable_objects[1].display_name, 'Windmill 01');
  assert.equal(manifest.buildable_objects[1].anim_fps, 5);
  assert.equal(manifest.buildable_objects[1].anim_loop, true);
});

test('applyThemeObjectTurretFlag can clear a previously-set flag back to false', () => {
  const manifest = testManifest();
  manifest.buildable_objects[0].is_turret = true;

  const changed = applyThemeObjectTurretFlag(manifest, 'crate_01', false);

  assert.equal(changed, true);
  assert.equal(manifest.buildable_objects[0].is_turret, false);
});

test('applyThemeObjectTurretFlag is a no-op for an unknown object_id', () => {
  const manifest = testManifest();

  const changed = applyThemeObjectTurretFlag(manifest, 'no_such_object', true);

  assert.equal(changed, false);
  assert.equal(manifest.buildable_objects[0].is_turret, undefined);
  assert.equal(manifest.buildable_objects[0].display_name, 'Crate 01');
});
