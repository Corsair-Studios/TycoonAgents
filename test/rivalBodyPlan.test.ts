// Per-rival body plan (two-legged / four-legged): effective-plan inference,
// plan round-trip + backward compatibility, the prompt's per-row statements,
// the Descriptions-editor change path, and per-row slicer normalization.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';
import { normalizeThemePlan } from '../src/extension/themePlan';
import { sliceAndNormalizeAtlas } from '../src/extension/slicer';
import { buildRivalAtlasPrompt, buildRivalAtlasRequest } from '../src/extension/themeAssetPrompts';
import type { ThemeRivalBoardRow } from '../src/extension/themeImageReviewState';

// themeService.ts imports 'vscode' at module scope; stub it like the other
// themeService test files so the require chain resolves under node --test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in target)) target[prop] = new Proxy(function stub() {}, handler);
      return target[prop];
    },
    apply() { return new Proxy({}, handler); },
    construct() { return new Proxy({}, handler); },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const service = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
const { createReviewItems, effectiveRivalBodyPlan, applyThemeItemDescriptionChanges, processRivalAtlas } = service;

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
    ],
    roster_rivals: [
      { rival_id: 'rival_goon', name: 'Rustbolt Goon', atlas_asset: 'frames.json#rival_goon' },
      { rival_id: 'rival_hound', name: 'Clockwork Hound', atlas_asset: 'frames.json#rival_hound' },
      { rival_id: 'rival_sentry', name: 'Steam Sentry', atlas_asset: 'frames.json#rival_sentry' },
    ],
    buildable_objects: [],
    decor_objects: Array.from({ length: 9 }, (_unused, index) => ({
      decor_id: `decor_${index + 1}`,
      display_name: `Decor ${index + 1}`,
      sprite_asset: `frames.json#decor_${index + 1}`,
      anchor_coord: [0.5, 0.5],
    })),
    badges: [],
  } as unknown as ThemeManifest;
}

function testPlan(overrides: Partial<ThemePlan> = {}): ThemePlan {
  return {
    version: 1,
    theme_id: 'test_theme',
    display_name: 'Test Theme',
    creative_direction: 'gritty outpost',
    characters: ['Agent Zero'],
    environment: 'a dusty outpost',
    objects: [],
    decor: Array.from({ length: 9 }, (_unused, index) => `Decor ${index + 1}`),
    enemies: ['Rustbolt Goon', 'Clockwork Hound', 'Steam Sentry'],
    expressions: ['happy'],
    achievements: ['First Build'],
    ...overrides,
  };
}

function rivalItem(plan: ThemePlan) {
  const item = createReviewItems(plan, testManifest(), plan.creative_direction, 'magenta')
    .find((candidate) => candidate.kind === 'rival_atlas');
  assert.ok(item);
  return item;
}

test('effectiveRivalBodyPlan: explicit wins, else infers from name + description, else two-legged', () => {
  assert.equal(effectiveRivalBodyPlan('quadruped', 'Goon', 'a tall robot'), 'quadruped');
  assert.equal(effectiveRivalBodyPlan('biped', 'Hound', 'a mechanical dog'), 'biped');
  assert.equal(effectiveRivalBodyPlan(undefined, 'Clockwork Hound', 'a mechanical guard dog'), 'quadruped');
  assert.equal(effectiveRivalBodyPlan(undefined, 'Brass Panther Cat', undefined), 'quadruped');
  assert.equal(effectiveRivalBodyPlan(undefined, 'Steam Sentry', 'a hissing steam-powered guard'), 'biped');
  assert.equal(effectiveRivalBodyPlan(undefined, 'Steam Sentry', undefined), 'biped');
});

test('plan without enemy_body_plans (legacy) means auto: rows carry inferred/biped values', () => {
  const plan = testPlan({ enemy_descriptions: ['a rusty scrap-metal thug', 'a mechanical guard dog', 'a hissing guard'] });
  assert.equal(plan.enemy_body_plans, undefined);
  const item = rivalItem(plan);
  assert.deepEqual(item.rival_rows!.map((row) => row.body_plan), ['biped', 'quadruped', 'biped']);
  assert.deepEqual(item.rival_rows!.map((row) => row.explicit_body_plan), [undefined, undefined, undefined]);
});

test('normalizeThemePlan keeps enemy_body_plans aligned with enemies and drops the array when nothing is set', () => {
  const kept = normalizeThemePlan({
    enemies: ['A', '', 'B', 'C'],
    enemy_body_plans: ['quadruped', 'biped', 'auto', 'biped'] as never,
  });
  // The blank enemy is dropped together with its entry, so values stay attached to their enemy.
  assert.deepEqual(kept.enemy_body_plans?.slice(0, 3), ['quadruped', undefined, 'biped']);
  const none = normalizeThemePlan({ enemies: ['A', 'B'], enemy_body_plans: ['auto', 'x'] as never });
  assert.equal(none.enemy_body_plans, undefined);
  const missing = normalizeThemePlan({ enemies: ['A', 'B'] });
  assert.equal(missing.enemy_body_plans, undefined);
});

test('explicit enemy_body_plans wins over inference and is exposed as explicit_body_plan', () => {
  const plan = testPlan({
    enemy_descriptions: ['a rusty scrap-metal thug', 'a mechanical guard dog', 'a hissing guard'],
    enemy_body_plans: ['quadruped', 'biped', undefined],
  });
  const rows = rivalItem(plan).rival_rows!;
  assert.deepEqual(rows.map((row) => row.body_plan), ['quadruped', 'biped', 'biped']);
  assert.deepEqual(rows.map((row) => row.explicit_body_plan), ['quadruped', 'biped', undefined]);
});

test('prompt carries the four-legged rules only when a row is four-legged, and states each row body', () => {
  const plainPrompt = rivalItem(testPlan()).prompt;
  assert.doesNotMatch(plainPrompt, /FOUR-LEGGED RIVAL ROWS/);
  assert.doesNotMatch(plainPrompt, /Body:/);
  assert.doesNotMatch(plainPrompt, /central 60%/);

  const mixedPrompt = rivalItem(testPlan({ enemy_body_plans: [undefined, 'quadruped', undefined] })).prompt;
  assert.match(mixedPrompt, /# FOUR-LEGGED RIVAL ROWS/);
  assert.match(mixedPrompt, /Row 2 is FOUR-LEGGED/);
  assert.match(mixedPrompt, /central 60% of the cell WIDTH/);
  assert.match(mixedPrompt, /gutter of at least 20% of the cell width/);
  assert.match(mixedPrompt, /never rears up or stands on its hind legs/);
  const rowLines = mixedPrompt.split('\n').filter((line) => /^Row \d \(Cells/.test(line));
  assert.equal(rowLines.length, 3);
  assert.match(rowLines[0], /Body: two-legged\.$/);
  assert.match(rowLines[1], /Body: FOUR-LEGGED/);
  assert.match(rowLines[2], /Body: two-legged\.$/);
});

test('biped-only board text is identical whether body_plan is absent or explicitly biped', () => {
  const base: ThemeRivalBoardRow[] = [
    { kind: 'rival', rival_id: 'a', display_name: 'A', visual_description: 'thing' },
    { kind: 'rival', rival_id: 'b', display_name: 'B' },
  ];
  const tagged = base.map((row) => ({ ...row, body_plan: 'biped' as const }));
  assert.equal(
    buildRivalAtlasPrompt('dir', 'Theme', tagged),
    buildRivalAtlasPrompt('dir', 'Theme', base),
  );
});

test('structured request sends body_plan only for four-legged rows', () => {
  const rows: ThemeRivalBoardRow[] = [
    { kind: 'rival', rival_id: 'a', display_name: 'A', body_plan: 'biped' },
    { kind: 'rival', rival_id: 'b', display_name: 'B', body_plan: 'quadruped' },
  ];
  const request = buildRivalAtlasRequest('dir', 'Theme', rows);
  assert.equal(request.boardType, 'rival_group');
  const slot = request.slot as Array<{ body_plan?: string }>;
  assert.equal('body_plan' in slot[0], false);
  assert.equal(slot[1].body_plan, 'quadruped');
});

test('applyThemeItemDescriptionChanges sets, leaves untouched, and resets a rival body plan', () => {
  const manifest = testManifest();
  const plan = testPlan();
  const set = applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'rival', id: 'hound', description: 'a dog', body_plan: 'quadruped' },
  ]);
  assert.equal(set.rejected.length, 0);
  assert.deepEqual(plan.enemy_body_plans, [undefined, 'quadruped']);

  // A description-only change (no body_plan key) leaves the stored value alone.
  applyThemeItemDescriptionChanges(manifest, plan, [{ item_kind: 'rival', id: 'hound', description: 'a dog again' }]);
  assert.equal(plan.enemy_body_plans?.[1], 'quadruped');

  // Reset to auto arrives as a present-but-undefined body_plan.
  applyThemeItemDescriptionChanges(manifest, plan, [
    { item_kind: 'rival', id: 'hound', description: 'a dog again', body_plan: undefined },
  ]);
  assert.equal(plan.enemy_body_plans?.[1], undefined);
});

// ---- slicer ---------------------------------------------------------------

const CELL = 100;
const INK = 0x1950a0ff;

function paint(atlas: Jimp, x: number, y: number, w: number, h: number): void {
  atlas.scan(x, y, w, h, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(INK, idx);
  });
}

/** Two rows, five columns; every cell holds a block `blockW` x `blockH`, horizontally centered. */
async function twoRowAtlas(blockW: number, blockH: number): Promise<Buffer> {
  const atlas = new Jimp(CELL * 5, CELL * 2, 0xff00ffff);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 5; col++) {
      paint(atlas, col * CELL + Math.floor((CELL - blockW) / 2), row * CELL + 10, blockW, blockH);
    }
  }
  return atlas.getBufferAsync(Jimp.MIME_PNG);
}

async function frameWidth(dataUri: string): Promise<number> {
  const image = await Jimp.read(Buffer.from(dataUri.split(',')[1], 'base64'));
  let minX = 128;
  let maxX = -1;
  image.scan(0, 0, 128, 128, function (x, _y, idx) {
    if (this.bitmap.data[idx + 3] > 0) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  });
  return maxX - minX + 1;
}

test('processRivalAtlas: a four-legged row is width-fit while a two-legged row on the same board keeps its usual fit', async () => {
  // 40 wide x 30 tall blocks: the height fit (118/30) is capped by the 120px
  // width cap (3x -> 120 wide); the width fit (118/40) lands on 118 wide.
  const buffer = await twoRowAtlas(40, 30);
  const rows: ThemeRivalBoardRow[] = [
    { kind: 'rival', rival_id: 'a', display_name: 'A', body_plan: 'biped' },
    { kind: 'rival', rival_id: 'b', display_name: 'B', body_plan: 'quadruped' },
  ];
  const mixed = await processRivalAtlas(buffer, testManifest(), rows);
  const allBiped = await processRivalAtlas(buffer, testManifest(), rows.map((row) => ({ ...row, body_plan: 'biped' as const })));

  assert.equal(await frameWidth(mixed.spritePackage.slots[5].data), 118, 'four-legged row fitted to the 118px width target');
  assert.equal(await frameWidth(allBiped.spritePackage.slots[5].data), 120, 'two-legged fit keeps the height-fit result');
  // The two-legged row is unaffected by its four-legged neighbor.
  assert.equal(mixed.spritePackage.slots[0].data, allBiped.spritePackage.slots[0].data);
});

test('sliceAndNormalizeAtlas without rowScaleOverrides is unchanged: empty overrides equal none', async () => {
  const buffer = await twoRowAtlas(60, 40);
  const grid = { columns: 5, rows: 2, targetContentHeight: 118, maxContentExtent: 120 };
  const plain = await sliceAndNormalizeAtlas(buffer, {}, grid);
  const emptyOverrides = await sliceAndNormalizeAtlas(buffer, {} as Partial<ThemeManifest>, { ...grid, rowScaleOverrides: [] });
  assert.deepEqual(plain.slots.map((slot) => slot.data), emptyOverrides.slots.map((slot) => slot.data));
});
