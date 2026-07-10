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
const {
  createReviewItems, objectRowsForItem, decorRowsForItem, buildReplacementPrompt,
  applyObjectBoardFrames, removeStaleBoardFrameKeys, mergeResumedReviewItems,
  boardBackgroundModeForProvider, resyncRenamedReviewItems, applyThemeItemNameChanges,
} = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

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
    // Legacy/off-count theme: only 12 objects. The v2 object pipeline requires
    // EXACTLY 22 (20 static + 2 animated) to build either board, so this
    // intentionally exercises the graceful-skip path (see the "off-count"
    // test below) rather than the normal two-board reconstruction.
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

  // Off-count rival boards still synthesize gracefully (createRivalBoardRows
  // accepts any positive roster count): 3 rivals pack into 1 board (up to 4/board).
  const rivalItems = result.filter((item) => item.kind === 'rival_atlas');
  assert.equal(rivalItems.length, 1, 'expected exactly one rival_atlas board for 3 rivals');
  assert.deepEqual(rivalItems.map((item) => item.id), ['rivals_01']);

  // The v2 object pipeline requires EXACTLY 22 objects (20 static + 2 animated)
  // to build either fixed-shape board (createObjectBoard1Rows/createObjectBoard2Rows
  // both throw on any other count). This manifest has 12, so BOTH object boards
  // are gracefully skipped by the surrounding try/catch rather than partially
  // degrading — unlike rivals, there is no partial/dynamic object board layout.
  const objectItems = result.filter((item) => item.kind === 'object_atlas');
  assert.equal(objectItems.length, 0, 'expected zero object_atlas boards for an off-count (12) object roster');

  // Everything else still gets synthesized.
  assert.ok(result.some((item) => item.kind === 'character_atlas'));
  assert.ok(result.some((item) => item.kind === 'environment'));
  assert.ok(result.some((item) => item.kind === 'expression_atlas'));
  assert.ok(result.some((item) => item.kind === 'achievement_atlas'));
});

// --- Regression: regeneration must prefer the CURRENT manifest/plan over stale
// saved review-item metadata (mirrors the already-fixed rivalRowsForItem). ---

/**
 * A manifest carrying the FULL v2 contract of 22 buildable objects: the first
 * OBJECT_STATIC_COUNT (20, indices 0-19) are static (board 1), and the last
 * OBJECT_ANIMATED_COUNT (2, indices 20-21) are the animated pair (board 2).
 */
function fullObjectManifest(): ThemeManifest {
  const manifest = legacyManifest();
  manifest.buildable_objects = Array.from({ length: 22 }, (_unused, index) => ({
    build_order: index,
    object_id: `object_${index}`,
    display_name: `Object ${index}`,
    sprite_asset: `frames.json#object_object_${index}`,
    anchor_coord: [0.5, 0.5] as [number, number],
    exclusion_radius: 32,
    work_units_required: 100,
  }));
  return manifest;
}

test('objectRowsForItem prefers the CURRENT manifest roster over stale saved object_rows', () => {
  const manifest = fullObjectManifest();
  // Simulate the roster having been edited (renamed) after the item's object_rows
  // were saved from a prior generation.
  manifest.buildable_objects = manifest.buildable_objects.map((object) => ({
    ...object,
    display_name: `New ${object.display_name}`,
  }));

  const staleObjectRows = [
    { kind: 'object_static' as const, object_id: 'object_0', display_name: 'STALE Object 0' },
  ];

  const rows = objectRowsForItem({ id: 'objects_01', object_rows: staleObjectRows }, manifest);

  assert.notDeepEqual(rows, staleObjectRows);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].kind, 'object_static');
  assert.equal(rows[0].kind === 'object_static' ? rows[0].display_name : undefined, 'New Object 0');
});

test('objectRowsForItem falls back to saved object_rows when the manifest object count does not match the 22-object contract', () => {
  const manifest = legacyManifest(); // only 12 buildable_objects — neither board can be reconstructed
  const staleObjectRows = [{ kind: 'crate' as const }];
  const rows = objectRowsForItem({ object_rows: staleObjectRows, object_specs: [] }, manifest);
  assert.deepEqual(rows, staleObjectRows);
});

// --- Regression: the v2 object pipeline always splits a full 22-object roster
// into exactly two FIXED-shape boards — board 1 (the first 20 objects, one
// static frame per cell) and board 2 (the last 2 objects, animated, plus the
// fixed poof/crate entries) — never a dynamic/partial split. ---

test('objectRowsForItem: a full 22-object roster gives board 1 the first 20 objects (all object_static) and board 2 the last 2 objects plus poof/crate', () => {
  const manifest = fullObjectManifest();

  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);
  assert.equal(board1.length, 20);
  assert.ok(board1.every((row) => row.kind === 'object_static'), 'board 1 must carry only static-object cells');
  assert.deepEqual(
    board1.map((row) => row.kind === 'object_static' ? row.object_id : row.kind),
    Array.from({ length: 20 }, (_unused, index) => `object_${index}`),
  );

  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest);
  assert.deepEqual(board2.map((row) => row.kind), ['object_anim', 'object_anim', 'poof', 'crate']);
  assert.deepEqual(
    board2.slice(0, 2).map((row) => row.kind === 'object_anim' ? row.object_id : row.kind),
    ['object_20', 'object_21'],
  );
});

test('applyObjectBoardFrames: board 1 writes one single-frame object_<id> key per cell', () => {
  const manifest = fullObjectManifest();
  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);

  const slots = Array.from({ length: 20 }, (_unused, slotIndex) => ({ slot_id: slotIndex, data: `cell_${slotIndex}` }));
  const frames: Record<string, string[]> = {};
  const keys = applyObjectBoardFrames(frames, slots, board1);

  assert.equal(keys.length, 20);
  assert.deepEqual(frames.object_object_0, ['cell_0']);
  assert.deepEqual(frames.object_object_19, ['cell_19']);
  assert.equal(frames.poof, undefined);
  assert.equal(frames.crate, undefined);
});

test('applyObjectBoardFrames: board 2 writes two 4-frame animated objects, a 7-frame poof (cells 9-15), and a 1-frame crate (cell 20) — cells 16-19 own no key', () => {
  const manifest = fullObjectManifest();
  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest); // [object_anim(20), object_anim(21), poof, crate]

  const slots = Array.from({ length: 20 }, (_unused, slotIndex) => ({ slot_id: slotIndex, data: `cell_${slotIndex}` }));
  const frames: Record<string, string[]> = {};
  const keys = applyObjectBoardFrames(frames, slots, board2);

  // Row 1 (cells 0-3): first animated object, 4 frames.
  assert.deepEqual(frames.object_object_20, ['cell_0', 'cell_1', 'cell_2', 'cell_3']);
  // Row 2 (cells 4-7): second animated object, 4 frames.
  assert.deepEqual(frames.object_object_21, ['cell_4', 'cell_5', 'cell_6', 'cell_7']);
  // Cells 8-14: the 7-frame poof, spanning the row 2/row 3 boundary.
  assert.deepEqual(frames.poof, ['cell_8', 'cell_9', 'cell_10', 'cell_11', 'cell_12', 'cell_13', 'cell_14']);
  // Cell 19 (the last cell): the single-frame crate.
  assert.deepEqual(frames.crate, ['cell_19']);
  // Cells 15-18 are blank padding — no frame key was written for them.
  assert.deepEqual(keys.sort(), ['crate', 'object_object_20', 'object_object_21', 'poof'].sort());
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

// --- Regression: reproduces a REAL production-shaped 22-object roster (cobra
// command) under the v2 fixed-two-board contract: board 1 = the first 20
// (all static), board 2 = the last 2 (animated) plus the fixed poof/crate
// entries. A resumed session must always prefer the freshly recomputed board
// over any stale saved object_rows/prompt/frame_keys. ---

const REAL_OBJECT_IDS: Array<{ object_id: string; display_name: string }> = [
  { object_id: 'mobile_command_center', display_name: 'Mobile Command Center' },
  { object_id: 'stealth_recon_drone', display_name: 'Stealth Recon Drone' },
  { object_id: 'high_voltage_energy_turret', display_name: 'High-Voltage Energy Turret' },
  { object_id: 'snake_pit_trap', display_name: 'Snake Pit Trap' },
  { object_id: 'armored_personnel_carrier', display_name: 'Armored Personnel Carrier' },
  { object_id: 'camouflage_netting', display_name: 'Camouflage Netting' },
  { object_id: 'explosive_charge_barrel', display_name: 'Explosive Charge Barrel' },
  { object_id: 'communication_relay_tower', display_name: 'Communication Relay Tower' },
  { object_id: 'missile_launcher_pod', display_name: 'Missile Launcher Pod' },
  { object_id: 'security_scanner_console', display_name: 'Security Scanner Console' },
  { object_id: 'cobra_heliport_platform', display_name: 'Cobra Heliport Platform' },
  { object_id: 'jungle_surveillance_camera', display_name: 'Jungle Surveillance Camera' },
  { object_id: 'supply_depot_crate_stack', display_name: 'Supply Depot Crate Stack' },
  { object_id: 'sandbag_bunker', display_name: 'Sandbag Bunker' },
  { object_id: 'watchtower_platform', display_name: 'Watchtower Platform' },
  { object_id: 'barbed_wire_fence', display_name: 'Barbed Wire Fence' },
  { object_id: 'field_hospital_tent', display_name: 'Field Hospital Tent' },
  { object_id: 'ammo_storage_locker', display_name: 'Ammo Storage Locker' },
  { object_id: 'vehicle_repair_bay', display_name: 'Vehicle Repair Bay' },
  { object_id: 'satellite_uplink_dish', display_name: 'Satellite Uplink Dish' },
  // Last 2 (indices 20-21): the ANIMATED pair on board 2.
  { object_id: 'rotating_radar_array', display_name: 'Rotating Radar Array' },
  { object_id: 'pulsing_reactor_core', display_name: 'Pulsing Reactor Core' },
];

function realThemedObjectManifest(): ThemeManifest {
  const manifest = legacyManifest();
  manifest.buildable_objects = REAL_OBJECT_IDS.map((object, index) => ({
    build_order: index,
    object_id: object.object_id,
    display_name: object.display_name,
    sprite_asset: `frames.json#object_${object.object_id}`,
    anchor_coord: [0.5, 0.5] as [number, number],
    exclusion_radius: 32,
    work_units_required: 100,
  }));
  return manifest;
}

test('objectRowsForItem: real 22-object cobra_command roster — board 1 carries the first 20 (static), board 2 carries the last 2 (animated) plus poof/crate', () => {
  const manifest = realThemedObjectManifest();

  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);
  assert.equal(board1.length, 20);
  assert.equal(board1[0].kind === 'object_static' ? board1[0].object_id : undefined, 'mobile_command_center');
  assert.equal(board1[19].kind === 'object_static' ? board1[19].object_id : undefined, 'satellite_uplink_dish');

  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest);
  assert.deepEqual(board2.map((row) => row.kind), ['object_anim', 'object_anim', 'poof', 'crate']);
  assert.equal(board2[0].kind === 'object_anim' ? board2[0].object_id : undefined, 'rotating_radar_array');
  assert.equal(board2[1].kind === 'object_anim' ? board2[1].object_id : undefined, 'pulsing_reactor_core');
});

test('mergeResumedReviewItems: object board 2 always recomputes fresh rows/prompt/frame_keys, never keeping a stale saved snapshot', () => {
  // Simulate a stale saved board 2 (e.g. saved before an object rename) that
  // still carries old object ids/prompt/frame_keys.
  const staleBoard2Rows = [
    { kind: 'object_anim' as const, object_id: 'OLD_radar', display_name: 'OLD Rotating Radar Array' },
    { kind: 'object_anim' as const, object_id: 'OLD_core', display_name: 'OLD Pulsing Reactor Core' },
    { kind: 'poof' as const },
    { kind: 'crate' as const },
  ];
  const savedItems = [
    {
      id: 'objects_02', filename: 'objects_02.png', label: 'stale', kind: 'object_atlas' as const,
      status: 'accepted' as const, prompt: 'STALE PROMPT', revision: 1,
      frame_keys: ['object_OLD_radar', 'object_OLD_core', 'poof', 'crate'],
      object_rows: staleBoard2Rows, updated_at: '2026-07-05T13:59:00.000Z',
    },
  ];

  const manifest = realThemedObjectManifest();
  const expectedItems = createReviewItems(minimalPlan(), manifest, 'gritty wasteland')
    .filter((item) => item.id === 'objects_02');

  const merged = mergeResumedReviewItems(expectedItems, savedItems);
  assert.equal(merged.length, 1);
  const mergedItem = merged[0];

  // The freshly recomputed board wins for rows/prompt/frame_keys...
  assert.deepEqual(
    mergedItem.object_rows?.map((row) => row.kind === 'object_anim' ? row.object_id : row.kind),
    ['rotating_radar_array', 'pulsing_reactor_core', 'poof', 'crate'],
  );
  assert.ok(!mergedItem.frame_keys.includes('object_OLD_radar'), 'resumed board 2 must not carry a stale object id');
  assert.notEqual(mergedItem.prompt, 'STALE PROMPT');

  // ...but review PROGRESS still comes from the saved document.
  assert.equal(mergedItem.status, 'accepted');
  assert.equal(mergedItem.revision, 1);
  assert.equal(mergedItem.updated_at, '2026-07-05T13:59:00.000Z');
});

test('mergeResumedReviewItems: an item with no saved counterpart (never generated before) uses the expected item as-is', () => {
  const manifest = realThemedObjectManifest();
  const expectedItems = createReviewItems(minimalPlan(), manifest, 'gritty wasteland')
    .filter((item) => item.id === 'objects_02');
  const merged = mergeResumedReviewItems(expectedItems, []);
  assert.deepEqual(merged, expectedItems);
});

test('removeStaleBoardFrameKeys: purges a key this item previously owned but no longer writes, without touching unrelated keys', () => {
  const frames: Record<string, string[]> = {
    poof: ['STALE_POOF'],
    crate: ['STALE_CRATE'],
    object_camouflage_netting: ['KEEP_ME'],
    object_missile_launcher_pod: ['owned by a different item, must survive'],
  };
  // This item previously wrote object_camouflage_netting/poof/crate; now it only
  // writes five real object keys (poof/crate moved to another board).
  removeStaleBoardFrameKeys(
    frames,
    ['object_camouflage_netting', 'object_explosive_charge_barrel', 'object_communication_relay_tower', 'poof', 'crate'],
    ['object_camouflage_netting', 'object_explosive_charge_barrel', 'object_communication_relay_tower', 'object_missile_launcher_pod', 'object_security_scanner_console'],
  );
  assert.equal(frames.poof, undefined);
  assert.equal(frames.crate, undefined);
  assert.deepEqual(frames.object_camouflage_netting, ['KEEP_ME']);
  assert.deepEqual(frames.object_missile_launcher_pod, ['owned by a different item, must survive']);
});

test('removeStaleBoardFrameKeys: no-op when there are no previous frame keys (first-ever generation)', () => {
  const frames: Record<string, string[]> = { poof: ['OWNED BY BOARD 3'] };
  removeStaleBoardFrameKeys(frames, undefined, ['object_cobra_heliport_platform']);
  assert.deepEqual(frames, { poof: ['OWNED BY BOARD 3'] });
  removeStaleBoardFrameKeys(frames, [], ['object_cobra_heliport_platform']);
  assert.deepEqual(frames, { poof: ['OWNED BY BOARD 3'] });
});

// --- Provider-aware sprite-board backgrounds: gpt-image-2 rejects
// background: "transparent" outright (API 400, verified 2026-07-08), so every
// provider currently keeps the legacy magenta chroma-key contract. The
// transparent-mode prompt builders below remain exercised directly since the
// plumbing is kept dormant, not removed. ---

test('boardBackgroundModeForProvider maps every provider (including openai) to magenta', () => {
  assert.equal(boardBackgroundModeForProvider('openai'), 'magenta');
  assert.equal(boardBackgroundModeForProvider('gemini'), 'magenta');
  assert.equal(boardBackgroundModeForProvider(undefined), 'magenta');
});

test('createReviewItems threads a transparent backgroundMode into every sprite-board prompt it builds', () => {
  const manifest = legacyManifest();
  const plan = minimalPlan();
  const items = createReviewItems(plan, manifest, plan.creative_direction, 'transparent');

  const spriteBoardItems = items.filter((item) => item.kind !== 'environment');
  assert.ok(spriteBoardItems.length > 0, 'expected at least one sprite-board item to check');
  for (const item of spriteBoardItems) {
    assert.doesNotMatch(item.prompt, /magenta/i, `${item.id} prompt must not mention magenta in transparent mode`);
    assert.doesNotMatch(item.prompt, /#FF00FF/i, `${item.id} prompt must not mention #FF00FF in transparent mode`);
    assert.match(item.prompt, /fully transparent \(alpha 0\)/i, `${item.id} prompt must carry the alpha directive`);
  }

  // The environment board has no magenta/transparent keying at all (out of scope).
  const environmentItem = items.find((item) => item.id === 'environment');
  assert.ok(environmentItem);
  assert.doesNotMatch(environmentItem!.prompt, /magenta/i);

  // Default call (no backgroundMode argument) keeps the legacy magenta contract.
  const defaultItems = createReviewItems(plan, manifest, plan.creative_direction);
  const defaultCharacterItem = defaultItems.find((item) => item.kind === 'character_atlas');
  assert.ok(defaultCharacterItem);
  assert.match(defaultCharacterItem!.prompt, /magenta/i);
});

test('buildReplacementPrompt threads a transparent backgroundMode through to the underlying builder', () => {
  const manifest = legacyManifest();
  const characterItem = {
    id: 'agent_0', filename: 'agent_0.png', label: 'Agent One', kind: 'character_atlas' as const,
    status: 'pending' as const, prompt: '', revision: 0, frame_keys: [], updated_at: '',
    subject: 'Agent One',
  };
  const magentaPrompt = buildReplacementPrompt(characterItem, 'gritty wasteland', manifest);
  assert.match(magentaPrompt, /magenta/i);

  const transparentPrompt = buildReplacementPrompt(characterItem, 'gritty wasteland', manifest, undefined, 'transparent');
  assert.doesNotMatch(transparentPrompt, /magenta/i);
  assert.doesNotMatch(transparentPrompt, /#FF00FF/i);
  assert.match(transparentPrompt, /fully transparent \(alpha 0\)/i);
});

// --- Regression: renaming a buildable object/decor/rival via the theme-review
// "Names" editor only ever touched the manifest (applyThemeItemNameChanges),
// on the theory that regeneration always rebuilds board rows/prompts fresh
// from the manifest. True for a full regenerate or a 'replace' retry
// (buildReplacementPrompt/objectRowsForItem etc.), but FALSE for 'retry' and
// 'augment' retries, which replay the SAVED item.prompt verbatim/appended (see
// selectThemeImageRetryPrompt in themeImageRetry.ts) — so without a resync,
// those two modes kept drawing the OLD name forever. resyncRenamedReviewItems
// is the fix: it rebuilds ONLY the boards a renamed row belongs to. ---

function savedReviewDocumentItems(manifest: ThemeManifest, plan: ThemePlan) {
  return createReviewItems(plan, manifest, plan.creative_direction).map((item, index) => ({
    ...item,
    status: 'accepted' as const,
    revision: index + 1,
    updated_at: `2026-01-01T00:0${index % 10}:00.000Z`,
  }));
}

test('resyncRenamedReviewItems rebuilds only object board 1 when a STATIC object (index < 20) is renamed, with the new name baked into its prompt', () => {
  const manifest = realThemedObjectManifest();
  const plan = minimalPlan();
  // Saved document reflects generation BEFORE the rename (old name baked into
  // board 1's prompt — camouflage_netting is index 5, a static object on board 1).
  const savedItems = savedReviewDocumentItems(manifest, plan);
  const savedBoard1 = savedItems.find((item) => item.id === 'objects_01')!;
  assert.match(savedBoard1.prompt, /Camouflage Netting/);

  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'camouflage_netting', name: 'Ghillie Netting' },
  ]);
  assert.equal(result.applied.length, 1);
  assert.equal(manifest.buildable_objects.find((o) => o.object_id === 'camouflage_netting')?.display_name, 'Ghillie Netting');

  const refreshed = resyncRenamedReviewItems({ items: savedItems }, manifest, plan, result.applied);

  // Only the board that actually carries the renamed row comes back.
  assert.deepEqual(refreshed.map((item) => item.id), ['objects_01']);
  const refreshedBoard1 = refreshed[0];
  assert.match(refreshedBoard1.prompt, /Ghillie Netting/);
  assert.doesNotMatch(refreshedBoard1.prompt, /Camouflage Netting/);

  // Review PROGRESS survives the resync untouched — a rename must never bounce
  // an accepted board back to pending.
  assert.equal(refreshedBoard1.status, savedBoard1.status);
  assert.equal(refreshedBoard1.revision, savedBoard1.revision);
  assert.equal(refreshedBoard1.updated_at, savedBoard1.updated_at);

  // The unaffected board (objects_02, and every non-object board) is simply
  // absent from the resync result — the caller only overwrites what's
  // returned here, so its saved prompt/rows are left byte-for-byte alone.
  assert.ok(!refreshed.some((item) => item.id === 'objects_02'));
});

test('resyncRenamedReviewItems rebuilds only object board 2 when an ANIMATED object (index >= 20) is renamed', () => {
  const manifest = realThemedObjectManifest();
  const plan = minimalPlan();
  // rotating_radar_array is index 20 — the first animated object, on board 2.
  const savedItems = savedReviewDocumentItems(manifest, plan);
  const savedBoard2 = savedItems.find((item) => item.id === 'objects_02')!;
  assert.match(savedBoard2.prompt, /Rotating Radar Array/);

  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'rotating_radar_array', name: 'Spinning Dish Array' },
  ]);
  assert.equal(result.applied.length, 1);

  const refreshed = resyncRenamedReviewItems({ items: savedItems }, manifest, plan, result.applied);
  assert.deepEqual(refreshed.map((item) => item.id), ['objects_02']);
  assert.match(refreshed[0].prompt, /Spinning Dish Array/);
  assert.doesNotMatch(refreshed[0].prompt, /Rotating Radar Array/);
  assert.ok(!refreshed.some((item) => item.id === 'objects_01'));
});

test('resyncRenamedReviewItems is a no-op for a character-only rename batch (that flow already has its own sync)', () => {
  const manifest = realThemedObjectManifest();
  const plan = minimalPlan();
  const savedItems = savedReviewDocumentItems(manifest, plan);

  const refreshed = resyncRenamedReviewItems(
    { items: savedItems },
    manifest,
    plan,
    [{ item_kind: 'character', id: 'agent_0', name: 'Vex' }],
  );

  assert.deepEqual(refreshed, []);
});

test('resyncRenamedReviewItems matches a rival rename by its stripped rival_rows id and refreshes that rival board', () => {
  const manifest = realThemedObjectManifest(); // 3 rivals -> a single rivals_01 board
  const plan = minimalPlan();
  const savedItems = savedReviewDocumentItems(manifest, plan);
  const savedRivalBoard = savedItems.find((item) => item.id === 'rivals_01')!;
  assert.match(savedRivalBoard.prompt, /Rival 0/);

  // applyThemeItemNameChanges accepts the stripped id form (see the
  // themeItemNames.test.ts regression coverage for this).
  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'rival', id: '0', name: 'Warden' },
  ]);
  assert.equal(result.applied.length, 1);

  const refreshed = resyncRenamedReviewItems({ items: savedItems }, manifest, plan, result.applied);
  assert.deepEqual(refreshed.map((item) => item.id), ['rivals_01']);
  assert.match(refreshed[0].prompt, /Warden/);
  assert.equal(refreshed[0].status, savedRivalBoard.status);
  assert.equal(refreshed[0].revision, savedRivalBoard.revision);
});
