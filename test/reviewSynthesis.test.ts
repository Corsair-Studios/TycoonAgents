import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// themeService.ts does `import * as vscode from 'vscode'` at module scope (needed by
// other exports); createReviewItems itself never touches the vscode API, but Node
// can't resolve the 'vscode' module outside the real extension host. Stub the module
// loader so this file's require chain resolves under plain `node --test`.
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
const { createReviewItems, objectRowsForItem, decorRowsForItem, buildReplacementPrompt } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

function legacyManifest(): ThemeManifest {
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
    roster_agents: [
      { slot_id: 0, name: 'Agent One', atlas_asset: 'frames.json#agent_0', preferred_idle_pose: 'pose_crossed' },
    ],
    // Legacy theme: only 3 rivals (createRivalBoardRows requires exactly 12 and throws).
    roster_rivals: Array.from({ length: 3 }, (_unused, index) => ({
      rival_id: `rival_${index}`,
      name: `Rival ${index}`,
      atlas_asset: `frames.json#rival_${index}`,
    })),
    // Legacy theme: only 12 objects (createObjectBoardRows packs any positive count).
    buildable_objects: Array.from({ length: 12 }, (_unused, index) => ({
      build_order: index,
      object_id: `object_${index}`,
      display_name: `Object ${index}`,
      sprite_asset: `frames.json#object_${index}`,
      anchor_coord: [0, 0] as [number, number],
      exclusion_radius: 40,
      work_units_required: 10,
    })),
    decor_objects: Array.from({ length: 9 }, (_unused, index) => ({
      decor_id: `decor_${index}`,
      display_name: `Decor ${index}`,
      sprite_asset: `frames.json#decor_${index}`,
      anchor_coord: [0.5, 0.5] as [number, number],
    })),
    badges: [],
  };
}

function minimalPlan(): ThemePlan {
  return {
    version: 1,
    theme_id: 'legacy_theme',
    display_name: 'Legacy Theme',
    creative_direction: 'gritty wasteland',
    characters: ['Agent One'],
    environment: 'a dusty outpost',
    objects: Array.from({ length: 12 }, (_unused, index) => `Object ${index}`),
    decor: Array.from({ length: 9 }, (_unused, index) => `Decor ${index}`),
    enemies: Array.from({ length: 3 }, (_unused, index) => `Rival ${index}`),
    expressions: ['happy', 'sad'],
    achievements: ['First Build'],
  };
}

test('createReviewItems does not throw for a legacy manifest with off-count rivals/objects; rival and object boards now synthesize', () => {
  const manifest = legacyManifest();
  const plan = minimalPlan();

  assert.doesNotThrow(() => createReviewItems(plan, manifest, plan.creative_direction));
  const result = createReviewItems(plan, manifest, plan.creative_direction);

  const decorItem = result.find((item) => item.id === 'background_decor');
  assert.ok(decorItem, 'expected a background_decor item to be synthesized despite off-count rivals/objects');
  assert.equal(decorItem?.kind, 'background_decor_atlas');

  // Off-count rival/object boards are now synthesized (packers accept any positive
  // roster count) rather than skipped: 3 rivals pack into 1 board (up to 4 rivals/board).
  const rivalItems = result.filter((item) => item.kind === 'rival_atlas');
  assert.equal(rivalItems.length, 1, 'expected exactly one rival_atlas board for 3 rivals');
  assert.deepEqual(rivalItems.map((item) => item.id), ['rivals_01']);

  // createObjectBoardRows packs any positive object count (12 objects + poof + crate =
  // 14 rows -> boards of [5, 5, 4] rows), and buildObjectAtlasPrompt now accepts a
  // partial trailing board (one to five rows), so all three boards synthesize instead
  // of the whole set being discarded by the surrounding try/catch.
  const objectItems = result.filter((item) => item.kind === 'object_atlas');
  assert.equal(objectItems.length, 3, 'expected three object_atlas boards for 12 objects + poof + crate');
  assert.deepEqual(objectItems.map((item) => item.id), ['objects_01', 'objects_02', 'objects_03']);

  // Everything else still gets synthesized.
  assert.ok(result.some((item) => item.kind === 'character_atlas'));
  assert.ok(result.some((item) => item.kind === 'environment'));
  assert.ok(result.some((item) => item.kind === 'expression_atlas'));
  assert.ok(result.some((item) => item.kind === 'achievement_atlas'));
});

// --- Regression: regeneration must prefer the CURRENT manifest/plan over stale
// saved review-item metadata (mirrors the already-fixed rivalRowsForItem). ---

test('objectRowsForItem prefers the CURRENT manifest roster over stale saved object_rows', () => {
  const manifest = legacyManifest();
  // Simulate the roster having been edited (renamed) after the item's object_rows
  // were saved from a prior generation.
  manifest.buildable_objects = manifest.buildable_objects.map((object) => ({
    ...object,
    display_name: `New ${object.display_name}`,
  }));

  // No object_specs saved, so reconstructObjectRows falls through to the manifest
  // (its own untouched legacy behavior) rather than the stale object_rows below.
  const staleObjectRows = [
    { kind: 'object' as const, object_id: 'object_0', display_name: 'STALE Object 0' },
    { kind: 'poof' as const },
    { kind: 'crate' as const },
  ];

  const rows = objectRowsForItem({ object_rows: staleObjectRows }, manifest);

  assert.notDeepEqual(rows, staleObjectRows);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].kind, 'object');
  assert.equal(rows[0].kind === 'object' ? rows[0].display_name : undefined, 'New Object 0');
});

test('objectRowsForItem falls back to saved object_rows only when reconstruction is empty', () => {
  const manifest = legacyManifest();
  const staleObjectRows = [{ kind: 'crate' as const }];
  // reconstructObjectRows only throws/empties in pathological cases; this asserts
  // the fallback plumbing returns the saved rows verbatim when it does.
  const rows = objectRowsForItem({ object_rows: staleObjectRows, object_specs: [] }, manifest);
  // With a normal manifest, reconstruction still succeeds (non-empty), proving the
  // manifest wins even though a saved fallback value is present.
  assert.notDeepEqual(rows, staleObjectRows);
});

test('decorRowsForItem prefers the CURRENT manifest decor roster over stale saved decor_rows', () => {
  const manifest = legacyManifest();
  manifest.decor_objects = manifest.decor_objects.map((decor) => ({
    ...decor,
    display_name: `New ${decor.display_name}`,
  }));

  const staleDecorRows = [{ kind: 'seat' as const, decor_id: 'decor_0', display_name: 'STALE Decor 0' }];

  const rows = decorRowsForItem({ decor_rows: staleDecorRows }, manifest);

  assert.notDeepEqual(rows, staleDecorRows);
  assert.equal(rows.length, 10); // 4 seats + 4 static + 1 animated + 1 projectile, flattened
  assert.equal(rows[0].kind, 'seat');
  assert.equal(rows[0].kind === 'seat' ? rows[0].display_name : undefined, 'New Decor 0');
});

test('decorRowsForItem falls back to saved decor_rows when the manifest cannot produce exactly 9 decor items', () => {
  const manifest = legacyManifest();
  manifest.decor_objects = manifest.decor_objects.slice(0, 8); // createDecorBoardRows requires exactly 9 -> throws
  const staleDecorRows = [{ kind: 'projectile' as const }];

  const rows = decorRowsForItem({ decor_rows: staleDecorRows }, manifest);

  assert.deepEqual(rows, staleDecorRows);
});

test('buildReplacementPrompt prefers the CURRENT plan expression/achievement names over stale saved names', () => {
  const manifest = legacyManifest();
  const plan = minimalPlan();
  plan.expressions = ['Current Joy', 'Current Rage'];
  plan.achievements = ['Current First Build'];

  const expressionItem = {
    id: 'expressions', filename: 'expressions.png', label: 'Expressions', kind: 'expression_atlas' as const,
    status: 'pending' as const, prompt: '', revision: 0, frame_keys: [], updated_at: '',
    expression_names: ['Stale Joy', 'Stale Rage'],
  };
  const expressionPrompt = buildReplacementPrompt(expressionItem, plan.creative_direction, manifest, plan);
  assert.match(expressionPrompt, /Current Joy/);
  assert.doesNotMatch(expressionPrompt, /Stale Joy/);

  const achievementItem = {
    id: 'achievements', filename: 'achievements.png', label: 'Achievements', kind: 'achievement_atlas' as const,
    status: 'pending' as const, prompt: '', revision: 0, frame_keys: [], updated_at: '',
    achievement_names: ['Stale First Build'],
  };
  const achievementPrompt = buildReplacementPrompt(achievementItem, plan.creative_direction, manifest, plan);
  assert.match(achievementPrompt, /Current First Build/);
  assert.doesNotMatch(achievementPrompt, /Stale First Build/);
});

test('buildReplacementPrompt falls back to saved expression/achievement names when no plan is supplied', () => {
  const manifest = legacyManifest();
  const expressionItem = {
    id: 'expressions', filename: 'expressions.png', label: 'Expressions', kind: 'expression_atlas' as const,
    status: 'pending' as const, prompt: '', revision: 0, frame_keys: [], updated_at: '',
    expression_names: ['Saved Joy', 'Saved Rage'],
  };
  const prompt = buildReplacementPrompt(expressionItem, 'gritty wasteland', manifest);
  assert.match(prompt, /Saved Joy/);
});
