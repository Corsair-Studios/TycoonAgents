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
const { createReviewItems } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

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
