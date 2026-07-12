import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// themeService.ts does `import * as vscode from 'vscode'` at module scope (needed by
// other exports); applyThemeItemDescriptionChanges/resyncDescriptionReviewItems
// themselves never touch the vscode API, but Node can't resolve the 'vscode' module
// outside the real extension host. Stub the module loader so this file's require
// chain resolves under plain `node --test` — same trick as themeItemNames.test.ts.
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
const {
  applyThemeItemDescriptionChanges, resyncDescriptionReviewItems, createReviewItems,
} = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

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
      { rival_id: 'rival_roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' },
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
      {
        build_order: 1,
        object_id: 'watchtower',
        display_name: 'Watchtower',
        sprite_asset: 'frames.json#object_watchtower',
        anchor_coord: [0, 0],
        exclusion_radius: 40,
        work_units_required: 10,
      },
    ],
    // createDecorBoardRows (via createReviewItems -> createDecorReviewItem)
    // requires EXACTLY 9 decor items — unlike buildable_objects, decor is not
    // self-padding — so this fixture carries the full 9-entry board contract
    // (4 seats + 4 static + 1 animated, see DECOR_BOARD_LAYOUT).
    decor_objects: [
      { decor_id: 'seat_01', display_name: 'Seat 01', sprite_asset: 'frames.json#decor_seat_01', anchor_coord: [0.5, 0.5] },
      { decor_id: 'lantern', display_name: 'Lantern', sprite_asset: 'frames.json#decor_lantern', anchor_coord: [0.5, 0.5] },
      { decor_id: 'seat_03', display_name: 'Seat 03', sprite_asset: 'frames.json#decor_seat_03', anchor_coord: [0.5, 0.5] },
      { decor_id: 'seat_04', display_name: 'Seat 04', sprite_asset: 'frames.json#decor_seat_04', anchor_coord: [0.5, 0.5] },
      { decor_id: 'barrel', display_name: 'Barrel', sprite_asset: 'frames.json#decor_barrel', anchor_coord: [0.5, 0.5] },
      { decor_id: 'banner', display_name: 'Banner', sprite_asset: 'frames.json#decor_banner', anchor_coord: [0.5, 0.5] },
      { decor_id: 'crate_stack', display_name: 'Crate Stack', sprite_asset: 'frames.json#decor_crate_stack', anchor_coord: [0.5, 0.5] },
      { decor_id: 'signpost', display_name: 'Signpost', sprite_asset: 'frames.json#decor_signpost', anchor_coord: [0.5, 0.5] },
      { decor_id: 'campfire', display_name: 'Campfire', sprite_asset: 'frames.json#decor_campfire', anchor_coord: [0.5, 0.5] },
    ],
    badges: [],
  };
}

function testPlan(): ThemePlan {
  return {
    version: 1,
    theme_id: 'test_theme',
    display_name: 'Test Theme',
    creative_direction: 'gritty outpost',
    characters: ['Agent Zero', 'Agent One'],
    environment: 'a dusty outpost',
    objects: ['Crate 01', 'Watchtower'],
    decor: ['Seat 01', 'Lantern', 'Seat 03', 'Seat 04', 'Barrel', 'Banner', 'Crate Stack', 'Signpost', 'Campfire'],
    enemies: ['Roadblock'],
    expressions: ['happy', 'sad'],
    achievements: ['First Build'],
  };
}

test('applyThemeItemDescriptionChanges writes object/decor/character/rival descriptions into the correct plan array + index', () => {
  const manifest = testManifest();
  const plan = testPlan();
  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'object', id: 'watchtower', description: 'A tall wooden tower with a rusted searchlight.' },
    { item_kind: 'decor', id: 'lantern', description: 'A flickering oil lantern on a hook.' },
    { item_kind: 'character', id: 'agent_1', description: 'Lanky scout in a patched duster coat.' },
    { item_kind: 'rival', id: 'roadblock', description: 'Hulking brute wielding a riot shield.' },
  ]);

  assert.equal(result.applied.length, 4);
  assert.equal(result.rejected.length, 0);

  // object_id 'watchtower' is index 1 in manifest.buildable_objects.
  assert.deepEqual(plan.object_descriptions, ['', 'A tall wooden tower with a rusted searchlight.']);
  // decor_id 'lantern' is index 1 in manifest.decor_objects.
  assert.deepEqual(plan.decor_descriptions, ['', 'A flickering oil lantern on a hook.']);
  // character 'agent_1' -> agent.slot_id 1.
  assert.deepEqual(plan.character_descriptions, ['', 'Lanky scout in a patched duster coat.']);
  // rival 'roadblock' is index 0 in manifest.roster_rivals.
  assert.deepEqual(plan.enemy_descriptions, ['Hulking brute wielding a riot shield.']);
});

test('applyThemeItemDescriptionChanges inits and pads a previously-absent plan array up to the changed index', () => {
  const manifest = testManifest();
  const plan = testPlan();
  assert.equal(plan.object_descriptions, undefined);

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'object', id: 'watchtower', description: 'Tall lookout tower.' },
  ]);

  assert.equal(result.applied.length, 1);
  assert.deepEqual(plan.object_descriptions, ['', 'Tall lookout tower.']);
});

test('applyThemeItemDescriptionChanges preserves an existing array\'s other entries when padding is not needed', () => {
  const manifest = testManifest();
  const plan = testPlan();
  plan.object_descriptions = ['Sturdy supply crate.', ''];

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'object', id: 'watchtower', description: 'Tall lookout tower.' },
  ]);

  assert.equal(result.applied.length, 1);
  assert.deepEqual(plan.object_descriptions, ['Sturdy supply crate.', 'Tall lookout tower.']);
});

test('applyThemeItemDescriptionChanges trims surrounding whitespace', () => {
  const manifest = testManifest();
  const plan = testPlan();

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'decor', id: 'seat_01', description: '   A weathered camp chair.   ' },
  ]);

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].description, 'A weathered camp chair.');
  // Only index 0 (seat_01) was touched, so the array is padded only to length 1.
  assert.deepEqual(plan.decor_descriptions, ['A weathered camp chair.']);
});

test('applyThemeItemDescriptionChanges applies an empty description as a valid CLEAR, not a rejection', () => {
  const manifest = testManifest();
  const plan = testPlan();
  plan.decor_descriptions = ['A weathered camp chair.', ''];

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'decor', id: 'seat_01', description: '   ' },
  ]);

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].description, '');
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(plan.decor_descriptions, ['', '']);
});

test('applyThemeItemDescriptionChanges rejects an unknown id without corrupting other applied changes or the plan', () => {
  const manifest = testManifest();
  const plan = testPlan();

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'object', id: 'crate_01', description: 'Supply crate.' },
    { item_kind: 'object', id: 'no_such_object', description: 'Ghost crate.' },
    { item_kind: 'character', id: 'agent_9', description: 'Nobody.' },
    { item_kind: 'rival', id: 'ghost', description: 'Nobody.' },
  ]);

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].id, 'crate_01');
  assert.equal(result.rejected.length, 3);
  assert.deepEqual(
    result.rejected.map((r) => r.id).sort(),
    ['agent_9', 'ghost', 'no_such_object'],
  );
  // Only index 0 (crate_01) applied, so the array is padded only to length 1.
  assert.deepEqual(plan.object_descriptions, ['Supply crate.']);
  assert.equal(plan.character_descriptions, undefined);
  assert.equal(plan.enemy_descriptions, undefined);

  // The manifest itself is never touched by a description change.
  assert.equal(manifest.buildable_objects[0].display_name, 'Crate 01');
  assert.equal(manifest.roster_agents[0].name, 'Agent Zero');
});

test('applyThemeItemDescriptionChanges matches a rival by its stripped rival_rows id (rival_id keeps the prefix)', () => {
  const manifest = testManifest();
  const plan = testPlan();

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'rival', id: 'roadblock', description: 'Wears riot armor.' },
  ]);

  assert.equal(result.rejected.length, 0);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(plan.enemy_descriptions, ['Wears riot armor.']);
  // rival_id itself is untouched (descriptions never touch the manifest).
  assert.equal(manifest.roster_rivals[0].rival_id, 'rival_roadblock');
});

// --- resyncDescriptionReviewItems: rebuilds only the affected board(s), and —
// unlike resyncRenamedReviewItems — a CHARACTER description change DOES get its
// own board resynced (character description edits have no other sync path). ---

function savedReviewDocumentItems(manifest: ThemeManifest, plan: ThemePlan) {
  return createReviewItems(plan, manifest, plan.creative_direction).map((item, index) => ({
    ...item,
    status: 'accepted' as const,
    revision: index + 1,
    updated_at: `2026-01-01T00:0${index % 10}:00.000Z`,
  }));
}

test('resyncDescriptionReviewItems rebuilds only the object board carrying the changed row, with the new description baked into its prompt', () => {
  const manifest = testManifest();
  const plan = testPlan();
  const savedItems = savedReviewDocumentItems(manifest, plan);
  const savedBoard = savedItems.find((item) => item.id === 'objects_01')!;
  assert.doesNotMatch(savedBoard.prompt, /rusted searchlight/);

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'object', id: 'watchtower', description: 'A tall wooden tower with a rusted searchlight.' },
  ]);
  assert.equal(result.applied.length, 1);

  const refreshed = resyncDescriptionReviewItems({ items: savedItems }, manifest, plan, result.applied);
  assert.deepEqual(refreshed.map((item) => item.id), ['objects_01']);
  assert.match(refreshed[0].prompt, /rusted searchlight/);

  // Review progress survives the resync untouched.
  assert.equal(refreshed[0].status, savedBoard.status);
  assert.equal(refreshed[0].revision, savedBoard.revision);
  assert.equal(refreshed[0].updated_at, savedBoard.updated_at);
});

test('resyncDescriptionReviewItems rebuilds the CHARACTER board when its description changes — no other sync path exists for this', () => {
  const manifest = testManifest();
  const plan = testPlan();
  const savedItems = savedReviewDocumentItems(manifest, plan);
  const savedBoard = savedItems.find((item) => item.id === 'agent_1')!;
  assert.doesNotMatch(savedBoard.prompt, /patched duster coat/);

  const result = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'character', id: 'agent_1', description: 'Lanky scout in a patched duster coat.' },
  ]);
  assert.equal(result.applied.length, 1);

  const refreshed = resyncDescriptionReviewItems({ items: savedItems }, manifest, plan, result.applied);
  assert.deepEqual(refreshed.map((item) => item.id), ['agent_1']);
  assert.match(refreshed[0].prompt, /patched duster coat/);
  assert.equal(refreshed[0].status, savedBoard.status);
  assert.equal(refreshed[0].revision, savedBoard.revision);

  // The other agent board is untouched/absent from the resync result.
  assert.ok(!refreshed.some((item) => item.id === 'agent_0'));
});

test('resyncDescriptionReviewItems is a no-op when no board carries any of the applied changes\' ids', () => {
  const manifest = testManifest();
  const plan = testPlan();
  const savedItems = savedReviewDocumentItems(manifest, plan);

  const refreshed = resyncDescriptionReviewItems(
    { items: savedItems },
    manifest,
    plan,
    [{ item_kind: 'object', id: 'no_such_object', description: 'Ghost crate.' }],
  );

  assert.deepEqual(refreshed, []);
});
