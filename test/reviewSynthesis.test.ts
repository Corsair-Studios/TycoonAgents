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
  refreshSavedReviewItemMetadata,
} = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeThemePlan } = require('../src/extension/themePlan') as typeof import('../src/extension/themePlan');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  OBJECT_ANIMATED_COUNT, OBJECT_BOARD1_STATIC_COUNT, OBJECT_BOARD2_STATIC_COUNT,
} = require('../src/extension/themeAssetPrompts') as typeof import('../src/extension/themeAssetPrompts');

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
    // Legacy/off-count theme: only 12 objects. The v3 object pipeline requires
    // EXACTLY 21 (16 static on board 1 + 3 static + 2 animated on board 2) to
    // build either board, so this intentionally exercises the graceful-skip
    // path (see the "off-count" test below) rather than the normal two-board
    // reconstruction.
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

  // The v3 object pipeline now PADS a legacy/off-count manifest's
  // buildable_objects up to the fixed 21-object contract (16 static on board 1
  // + 3 static + 2 animated on board 2), so BOTH fixed-shape boards synthesize
  // even for a 12-object legacy roster instead of being skipped by the
  // surrounding try/catch.
  const objectItems = result.filter((item) => item.kind === 'object_atlas');
  assert.equal(objectItems.length, 2, 'expected two object_atlas boards for a padded off-count (12) object roster');
  assert.deepEqual(objectItems.map((item) => item.id), ['objects_01', 'objects_02']);

  // Everything else still gets synthesized.
  assert.ok(result.some((item) => item.kind === 'character_atlas'));
  assert.ok(result.some((item) => item.kind === 'environment'));
  assert.ok(result.some((item) => item.kind === 'expression_atlas'));
  assert.ok(result.some((item) => item.kind === 'achievement_atlas'));
});

// --- Regression: regeneration must prefer the CURRENT manifest/plan over stale
// saved review-item metadata (mirrors the already-fixed rivalRowsForItem). ---

/**
 * A manifest carrying the FULL v3 contract of 21 buildable objects: the first
 * OBJECT_BOARD1_STATIC_COUNT (16, indices 0-15) are static (board 1), the next
 * OBJECT_BOARD2_STATIC_COUNT (3, indices 16-18) are static (board 2 row 4),
 * and the last OBJECT_ANIMATED_COUNT (2, indices 19-20) are the animated pair
 * (board 2 rows 1-2).
 */
function fullObjectManifest(): ThemeManifest {
  const manifest = legacyManifest();
  manifest.buildable_objects = Array.from({ length: 21 }, (_unused, index) => ({
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
  assert.equal(rows.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.equal(rows[0].kind, 'object_static');
  assert.equal(rows[0].kind === 'object_static' ? rows[0].display_name : undefined, 'New Object 0');
});

test('objectRowsForItem PADS a legacy off-count manifest up to the 21-object contract instead of falling back to saved object_rows', () => {
  const manifest = legacyManifest(); // only 12 buildable_objects — pre-v3 count
  const staleObjectRows = [{ kind: 'crate' as const }];
  // Board 1 (default id) now reconstructs from the padded manifest (12 real
  // specs + placeholders) rather than returning the stale saved rows.
  const rows = objectRowsForItem({ object_rows: staleObjectRows, object_specs: [] }, manifest);
  assert.notDeepEqual(rows, staleObjectRows);
  assert.equal(rows.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.ok(rows.every((row) => row.kind === 'object_static'), 'padded board 1 must be all object_static');
});

// --- Regression: the v3 object pipeline always splits a full 21-object roster
// into exactly two FIXED-shape boards — board 1 (the first 16 objects, one
// static frame per cell) and board 2 (the last 2 objects, animated, plus 3
// more static objects, plus the fixed poof/crate entries) — never a
// dynamic/partial split. ---

test('objectRowsForItem: a full 21-object roster gives board 1 the first 16 objects (all object_static) and board 2 the last 2 (animated) plus 3 static plus poof/crate', () => {
  const manifest = fullObjectManifest();

  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);
  assert.equal(board1.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.ok(board1.every((row) => row.kind === 'object_static'), 'board 1 must carry only static-object cells');
  assert.deepEqual(
    board1.map((row) => row.kind === 'object_static' ? row.object_id : row.kind),
    Array.from({ length: OBJECT_BOARD1_STATIC_COUNT }, (_unused, index) => `object_${index}`),
  );

  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest);
  assert.deepEqual(
    board2.map((row) => row.kind),
    ['object_anim', 'object_anim', 'poof', 'object_static', 'object_static', 'object_static', 'crate'],
  );
  assert.deepEqual(
    board2.slice(0, 2).map((row) => row.kind === 'object_anim' ? row.object_id : row.kind),
    ['object_19', 'object_20'],
  );
  assert.deepEqual(
    board2.slice(3, 6).map((row) => row.kind === 'object_static' ? row.object_id : row.kind),
    ['object_16', 'object_17', 'object_18'],
  );
});

// --- Regression: the v3 object pipeline now PADS a legacy manifest whose
// buildable_objects count is BELOW the 21-object contract (themeObjectSpecs
// fills the tail with `object_<n>` placeholder specs), so both fixed-shape
// boards reconstruct instead of throwing / falling back to stale rows. ---

function legacy13Manifest(): ThemeManifest {
  const manifest = legacyManifest();
  manifest.buildable_objects = Array.from({ length: 13 }, (_unused, index) => ({
    build_order: index,
    object_id: `legacy_obj_${index}`,
    display_name: `Legacy Object ${index}`,
    sprite_asset: `frames.json#legacy_obj_${index}`,
    anchor_coord: [0, 0] as [number, number],
    exclusion_radius: 40,
    work_units_required: 10,
  }));
  return manifest;
}

test('objectRowsForItem: a legacy 13-object manifest PADS board 1 to 16 static rows — 13 real object_ids then 3 placeholders (object_14..object_16)', () => {
  const manifest = legacy13Manifest();
  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest); // NO plan arg

  assert.equal(board1.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.ok(board1.every((row) => row.kind === 'object_static'), 'every board-1 row must be object_static');

  const ids = board1.map((row) => (row.kind === 'object_static' ? row.object_id : row.kind));
  // The first 13 rows carry the manifest's real object_ids.
  assert.deepEqual(ids.slice(0, 13), Array.from({ length: 13 }, (_unused, index) => `legacy_obj_${index}`));
  // The remaining 3 are synthetic placeholders padded up to the 16-static board-1 contract.
  assert.deepEqual(ids.slice(13), ['object_14', 'object_15', 'object_16']);
});

test('objectRowsForItem: a legacy 13-object manifest still yields board 2 as [object_anim, object_anim, poof, object_static, object_static, object_static, crate]', () => {
  const manifest = legacy13Manifest();
  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest); // NO plan arg

  assert.equal(board2.length, OBJECT_ANIMATED_COUNT + OBJECT_BOARD2_STATIC_COUNT + 2);
  assert.deepEqual(
    board2.map((row) => row.kind),
    ['object_anim', 'object_anim', 'poof', 'object_static', 'object_static', 'object_static', 'crate'],
  );
  // Padded placeholders continue the object_14.. sequence past board 1's 3 (object_14-16):
  // board 2's 3 statics are object_17-19, the animated pair is object_20-21.
  assert.deepEqual(
    board2.slice(3, 6).map((row) => row.kind === 'object_static' ? row.object_id : row.kind),
    ['object_17', 'object_18', 'object_19'],
  );
  assert.deepEqual(
    board2.slice(0, 2).map((row) => row.kind === 'object_anim' ? row.object_id : row.kind),
    ['object_20', 'object_21'],
  );
});

test('objectRowsForItem: a healthy 21-object manifest still yields 16 static rows for board 1 (padding leaves the full-roster path unchanged)', () => {
  const manifest = fullObjectManifest();
  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);
  assert.equal(board1.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.ok(board1.every((row) => row.kind === 'object_static'));
});

test('applyObjectBoardFrames: board 1 writes one single-frame object_<id> key per cell', () => {
  const manifest = fullObjectManifest();
  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);

  const slots = Array.from({ length: OBJECT_BOARD1_STATIC_COUNT }, (_unused, slotIndex) => ({ slot_id: slotIndex, data: `cell_${slotIndex}` }));
  const frames: Record<string, string[]> = {};
  const keys = applyObjectBoardFrames(frames, slots, board1);

  assert.equal(keys.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.deepEqual(frames.object_object_0, ['cell_0']);
  assert.deepEqual(frames.object_object_15, ['cell_15']);
  assert.equal(frames.poof, undefined);
  assert.equal(frames.crate, undefined);
});

test('applyObjectBoardFrames: board 2 writes two 4-frame animated objects, a 4-frame poof (cells 9-12), three 1-frame static objects (cells 13-15), and a 1-frame crate (cell 16)', () => {
  const manifest = fullObjectManifest();
  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest); // [object_anim(19), object_anim(20), poof, static(16), static(17), static(18), crate]

  const slots = Array.from({ length: 16 }, (_unused, slotIndex) => ({ slot_id: slotIndex, data: `cell_${slotIndex}` }));
  const frames: Record<string, string[]> = {};
  const keys = applyObjectBoardFrames(frames, slots, board2);

  // Row 1 (cells 0-3): first animated object, 4 frames.
  assert.deepEqual(frames.object_object_19, ['cell_0', 'cell_1', 'cell_2', 'cell_3']);
  // Row 2 (cells 4-7): second animated object, 4 frames.
  assert.deepEqual(frames.object_object_20, ['cell_4', 'cell_5', 'cell_6', 'cell_7']);
  // Cells 8-11 (row 3): the 4-frame poof.
  assert.deepEqual(frames.poof, ['cell_8', 'cell_9', 'cell_10', 'cell_11']);
  // Cells 12-14 (the first three cells of row 4): three single-frame static objects.
  assert.deepEqual(frames.object_object_16, ['cell_12']);
  assert.deepEqual(frames.object_object_17, ['cell_13']);
  assert.deepEqual(frames.object_object_18, ['cell_14']);
  // Cell 15 (the last cell): the single-frame crate.
  assert.deepEqual(frames.crate, ['cell_15']);
  assert.deepEqual(
    keys.sort(),
    ['crate', 'object_object_16', 'object_object_17', 'object_object_18', 'object_object_19', 'object_object_20', 'poof'].sort(),
  );
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

test('buildReplacementPrompt: objects_01 rebuilds the NEW 16-static-object board from the CURRENT plan even when the manifest is still a LEGACY off-count roster', () => {
  // Legacy manifest stuck at the pre-v3 object count (12 buildable_objects) —
  // createObjectBoard1Rows/2Rows both throw on anything but an exact
  // 16/(2+3) split, so the manifest-based reconstruction inside
  // objectRowsForItem cannot succeed here.
  const manifest = legacyManifest();

  // A CURRENT plan, normalized the same way loadCurrentThemePlan normalizes
  // every saved plan.json on load: normalizeThemePlan always pads/reserves
  // `objects` to THEME_OBJECT_COUNT (21), regardless of the manifest's stale
  // count.
  const plan = normalizeThemePlan({
    ...minimalPlan(),
    objects: Array.from({ length: 20 }, (_unused, index) => `Current Object ${index}`),
  });
  assert.equal(plan.objects.length, 21);

  // Simulate the item's saved data from BEFORE the 2-board rework: an old
  // animated-board shape that must never leak into the rebuilt prompt now
  // that a normalized plan is available.
  const staleObjectRows = Array.from({ length: 5 }, (_unused, index) => ({
    kind: 'object_anim' as const,
    object_id: `stale_anim_${index}`,
    display_name: `STALE Old Animated Object ${index}`,
  }));
  const item = {
    id: 'objects_01', filename: 'objects_01.png', label: 'Objects 1', kind: 'object_atlas' as const,
    status: 'pending' as const, prompt: 'STALE ORIGINAL PROMPT TEXT', revision: 0, frame_keys: [], updated_at: '',
    object_rows: staleObjectRows,
  };

  // DISPLAY path (preferPlanObjects=true, the panel's _postThemeImageReview
  // currentPrompt computation): rebuild board 1 from the CURRENT plan.
  const displayPrompt = buildReplacementPrompt(
    item, plan.creative_direction, manifest, plan, 'magenta', true,
  );

  // NEW board-1 (16 single-frame STATIC objects) language, not the stale
  // 5-animated board and not the item's stale saved prompt text.
  assert.match(displayPrompt, /Create one static buildable-object sprite board/);
  assert.match(displayPrompt, /16 distinct STATIC buildable objects/);
  assert.doesNotMatch(displayPrompt, /STALE/);

  // RETRY-GENERATION path (default preferPlanObjects=false): the plan is IGNORED
  // for object rows, so board 1 rebuilds from the CURRENT manifest — which the
  // v3 pipeline now PADS up to the 21-object contract for a legacy off-count
  // roster. The item's stale saved object_rows are therefore never used, and
  // the padded manifest yields a valid board-1 prompt (no throw), keeping Retry
  // consistent with the manifest-based slicing it pairs with.
  const retryPrompt = buildReplacementPrompt(item, plan.creative_direction, manifest, plan);
  assert.match(retryPrompt, /Create one static buildable-object sprite board/);
  assert.match(retryPrompt, /16 distinct STATIC buildable objects/);
  assert.doesNotMatch(retryPrompt, /STALE/);
});

// --- Regression: reproduces a REAL production-shaped 21-object roster (cobra
// command) under the v3 fixed-two-board contract: board 1 = the first 16
// (all static), board 2 = the last 2 (animated) plus 3 more static objects
// plus the fixed poof/crate entries. A resumed session must always prefer the
// freshly recomputed board over any stale saved object_rows/prompt/frame_keys. ---

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
  // Board 1 ends here — indices 0-15 (16 static objects).
  // Board 2's 3 static objects (indices 16-18, row 4 cells 13-15).
  { object_id: 'field_hospital_tent', display_name: 'Field Hospital Tent' },
  { object_id: 'ammo_storage_locker', display_name: 'Ammo Storage Locker' },
  { object_id: 'vehicle_repair_bay', display_name: 'Vehicle Repair Bay' },
  // Last 2 (indices 19-20): the ANIMATED pair on board 2 (rows 1-2).
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

test('objectRowsForItem: real 21-object cobra_command roster — board 1 carries the first 16 (static), board 2 carries the last 2 (animated) plus 3 static plus poof/crate', () => {
  const manifest = realThemedObjectManifest();

  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);
  assert.equal(board1.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.equal(board1[0].kind === 'object_static' ? board1[0].object_id : undefined, 'mobile_command_center');
  assert.equal(board1[15].kind === 'object_static' ? board1[15].object_id : undefined, 'barbed_wire_fence');

  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest);
  assert.deepEqual(
    board2.map((row) => row.kind),
    ['object_anim', 'object_anim', 'poof', 'object_static', 'object_static', 'object_static', 'crate'],
  );
  assert.equal(board2[0].kind === 'object_anim' ? board2[0].object_id : undefined, 'rotating_radar_array');
  assert.equal(board2[1].kind === 'object_anim' ? board2[1].object_id : undefined, 'pulsing_reactor_core');
  assert.deepEqual(
    board2.slice(3, 6).map((row) => row.kind === 'object_static' ? row.object_id : undefined),
    ['field_hospital_tent', 'ammo_storage_locker', 'vehicle_repair_bay'],
  );
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
    ['rotating_radar_array', 'pulsing_reactor_core', 'poof', 'object_static', 'object_static', 'object_static', 'crate'],
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

test('resyncRenamedReviewItems rebuilds only object board 1 when a STATIC object (index < 16) is renamed, with the new name baked into its prompt', () => {
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

test('resyncRenamedReviewItems rebuilds only object board 2 when an ANIMATED object (index >= 19) is renamed', () => {
  const manifest = realThemedObjectManifest();
  const plan = minimalPlan();
  // rotating_radar_array is index 19 — the first animated object, on board 2.
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

// --- Regression: per-slot rename of the 20 ACHIEVEMENT BADGES. A badge change
// carries item_kind 'badge' with a positional id `achievement_<index>` and
// renames manifest.badges[index].display_name; the resync then rebuilds the
// achievement_atlas board so its achievement_names reflect the CURRENT plan. ---

/** A manifest carrying the full 20-badge roster the per-slot rename operates on. */
function badge20Manifest(): ThemeManifest {
  const manifest = legacyManifest();
  manifest.badges = Array.from({ length: 20 }, (_unused, index) => ({
    badge_id: `badge_${index}`,
    display_name: `Badge ${index}`,
    description: `Badge ${index} description`,
    trigger_type: 'OBJECTS_BUILT' as const,
    threshold: index + 1,
    icon_asset: `frames.json#achievement_${index}`,
  }));
  return manifest;
}

/** A plan with a full 20-entry achievements list so `achievement_<index>` slots exist. */
function plan20(): ThemePlan {
  return {
    ...minimalPlan(),
    achievements: Array.from({ length: 20 }, (_unused, index) => `Badge ${index}`),
  };
}

test('applyThemeItemNameChanges badge — happy path sets manifest.badges[index].display_name and returns the change in applied', () => {
  const manifest = badge20Manifest();
  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'badge', id: 'achievement_3', name: 'Themed Badge D' },
  ]);

  assert.equal(manifest.badges[3].display_name, 'Themed Badge D');
  assert.deepEqual(result.applied, [{ item_kind: 'badge', id: 'achievement_3', name: 'Themed Badge D' }]);
  assert.equal(result.rejected.length, 0);
  // No collateral: neighbouring badge slots are untouched.
  assert.equal(manifest.badges[2].display_name, 'Badge 2');
  assert.equal(manifest.badges[4].display_name, 'Badge 4');
});

test('applyThemeItemNameChanges badge — out-of-range and garbage ids are rejected with an "Unknown badge" reason and leave the manifest unchanged', () => {
  const manifest = badge20Manifest();
  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'badge', id: 'achievement_99', name: 'Way Out Of Range' },
    { item_kind: 'badge', id: 'not_a_badge', name: 'Garbage Id' },
  ]);

  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.deepEqual(result.rejected.map((entry) => entry.id).sort(), ['achievement_99', 'not_a_badge']);
  for (const entry of result.rejected) {
    assert.equal(entry.item_kind, 'badge');
    assert.match(entry.reason, /Unknown badge/);
  }
  // Manifest badges are byte-for-byte the defaults — nothing was written.
  assert.deepEqual(manifest.badges.map((badge) => badge.display_name), plan20().achievements);
});

test('resyncRenamedReviewItems badge — rebuilds ONLY the achievement board, with achievement_names reflecting the CURRENT plan; unaffected boards are absent', () => {
  const manifest = badge20Manifest();
  // Saved review document was generated BEFORE the rename: the achievement
  // board still bakes the old slot-3 name.
  const planBefore = plan20();
  const savedItems = savedReviewDocumentItems(manifest, planBefore);
  const savedAchievements = savedItems.find((item) => item.id === 'achievements')!;
  assert.equal(savedAchievements.kind, 'achievement_atlas');
  assert.equal(savedAchievements.achievement_names?.[3], 'Badge 3');
  // The document also carries unrelated boards (e.g. object board 1) that must
  // stay out of the resync result.
  assert.ok(savedItems.some((item) => item.id === 'objects_01'));

  // Simulate the plan write-back (resyncRenamedBoardPrompts mirrors the badge
  // rename into plan.achievements before calling the pure resync).
  const planAfter = plan20();
  planAfter.achievements[3] = 'Themed Badge D';

  const refreshed = resyncRenamedReviewItems(
    { items: savedItems },
    manifest,
    planAfter,
    [{ item_kind: 'badge', id: 'achievement_3', name: 'Themed Badge D' }],
  );

  // Only the achievement board comes back, and it carries the new name.
  assert.deepEqual(refreshed.map((item) => item.id), ['achievements']);
  const refreshedAchievements = refreshed[0];
  assert.equal(refreshedAchievements.achievement_names?.[3], 'Themed Badge D');
  // Review PROGRESS survives the resync untouched.
  assert.equal(refreshedAchievements.status, savedAchievements.status);
  assert.equal(refreshedAchievements.revision, savedAchievements.revision);
  // Unaffected boards (object/rival/decor/etc.) are simply not returned.
  assert.ok(!refreshed.some((item) => item.id === 'objects_01'));
});

test('resyncRenamedReviewItems no badge — a non-badge, non-matching change leaves the achievement board out of the result', () => {
  const manifest = badge20Manifest();
  const plan = plan20();
  const savedItems = savedReviewDocumentItems(manifest, plan);

  const refreshed = resyncRenamedReviewItems(
    { items: savedItems },
    manifest,
    plan,
    // An object rename for an id that no board's rows contain: nothing to resync.
    [{ item_kind: 'object', id: 'nonexistent_object', name: 'Ghost' }],
  );

  // An empty result means no board (including the achievement board) was resynced.
  assert.deepEqual(refreshed, []);
});

// --- refreshSavedReviewItemMetadata: for-DISPLAY merge that folds the
// freshly-synthesized `expected` item's structural metadata (label +
// object_rows/object_specs/rival_rows/decor_rows/achievement_names/
// expression_names) onto a SAVED item WITHOUT disturbing its generation state
// (status/revision/updated_at/prompt/etc.). Purpose: existing themes whose
// saved object item predates the v3 `object_rows` must still show the inline
// Names editor, because the current-manifest-derived expected.object_rows now
// refreshes onto the item. ---

function sixteen(prefix: string) {
  return Array.from({ length: 16 }, (_unused, index) => ({
    kind: 'object_static' as const,
    object_id: `obj_${index}`,
    display_name: `${prefix} ${index + 1}`,
  }));
}

test('refreshSavedReviewItemMetadata: refreshes a saved object item that is MISSING object_rows (existing pre-v3 theme) while preserving its generation state', () => {
  const saved = {
    id: 'objects_01', filename: 'objects_01.png', label: 'stale label', kind: 'object_atlas' as const,
    status: 'accepted' as const, prompt: 'ORIGINAL SAVED PROMPT', revision: 3, frame_keys: ['object_obj_0'],
    updated_at: '2026-03-14T09:26:53.000Z',
    // NOTE: intentionally NO object_rows — this is the pre-v3 saved shape.
  };
  const expectedRows = Array.from({ length: 16 }, (_unused, index) => ({
    kind: 'object_static' as const, object_id: `obj_${index}`, display_name: `Object ${index + 1}`,
  }));
  const expected = {
    id: 'objects_01', filename: 'objects_01.png', label: 'Static objects 1–16', kind: 'object_atlas' as const,
    status: 'pending' as const, prompt: 'FRESH EXPECTED PROMPT', revision: 0, frame_keys: [],
    object_rows: expectedRows,
  };

  const merged = refreshSavedReviewItemMetadata(saved, expected);

  // Structural metadata comes from `expected`.
  assert.equal(merged.object_rows?.length, 16);
  assert.deepEqual(merged.object_rows, expectedRows);
  assert.equal(merged.label, 'Static objects 1–16');
  // Generation state stays from `saved`.
  assert.equal(merged.status, 'accepted');
  assert.equal(merged.revision, 3);
  assert.equal(merged.updated_at, '2026-03-14T09:26:53.000Z');
  assert.equal(merged.prompt, 'ORIGINAL SAVED PROMPT');
  assert.deepEqual(merged.frame_keys, ['object_obj_0']);
});

test('refreshSavedReviewItemMetadata: OVERRIDES a stale short object_rows array with the fresh 16-row expected array', () => {
  const saved = {
    id: 'objects_01', filename: 'objects_01.png', label: 'label', kind: 'object_atlas' as const,
    status: 'accepted' as const, prompt: 'p', revision: 2, frame_keys: [], updated_at: '2026-02-02T00:00:00.000Z',
    object_rows: sixteen('STALE').slice(0, 5), // old/short: only 5 rows
  };
  const freshRows = sixteen('Fresh');
  const expected = {
    id: 'objects_01', filename: 'objects_01.png', label: 'Static objects 1–16', kind: 'object_atlas' as const,
    status: 'pending' as const, prompt: 'x', revision: 0, frame_keys: [],
    object_rows: freshRows,
  };

  const merged = refreshSavedReviewItemMetadata(saved, expected);
  assert.equal(merged.object_rows?.length, 16);
  assert.deepEqual(merged.object_rows, freshRows);
});

test('refreshSavedReviewItemMetadata: does NOT wipe a saved field the expected item lacks (expected has no object_rows)', () => {
  const savedDecorRows = [
    { kind: 'seat' as const, decor_id: 'decor_0', display_name: 'Saved Bench' },
    { kind: 'projectile' as const },
  ];
  const saved = {
    id: 'background_decor', filename: 'background_decor.png', label: 'Decor', kind: 'background_decor_atlas' as const,
    status: 'accepted' as const, prompt: 'SAVED DECOR PROMPT', revision: 4, frame_keys: [],
    updated_at: '2026-04-01T12:00:00.000Z',
    decor_rows: savedDecorRows,
    // NOTE: no object_rows on the saved item either.
  };
  const freshDecorRows = [
    { kind: 'seat' as const, decor_id: 'decor_0', display_name: 'Fresh Bench' },
    { kind: 'projectile' as const },
  ];
  const expected = {
    id: 'background_decor', filename: 'background_decor.png', label: 'Decor', kind: 'background_decor_atlas' as const,
    status: 'pending' as const, prompt: 'x', revision: 0, frame_keys: [],
    decor_rows: freshDecorRows,
    // expected deliberately carries NO object_rows.
  };

  const merged = refreshSavedReviewItemMetadata(saved, expected);
  // decor_rows refreshed from expected...
  assert.deepEqual(merged.decor_rows, freshDecorRows);
  // ...but object_rows must remain undefined (expected never carried it, so it wasn't set).
  assert.equal(merged.object_rows, undefined);
  // A non-structural field is preserved unchanged from saved.
  assert.equal(merged.prompt, 'SAVED DECOR PROMPT');
});

test('refreshSavedReviewItemMetadata: refreshes achievement_names from expected onto the saved achievement board', () => {
  const oldNames = Array.from({ length: 20 }, (_unused, index) => `Old Badge ${index}`);
  const newNames = Array.from({ length: 20 }, (_unused, index) => `Themed Badge ${index}`);
  const saved = {
    id: 'achievements', filename: 'achievements.png', label: 'Achievements', kind: 'achievement_atlas' as const,
    status: 'accepted' as const, prompt: 'SAVED ACH PROMPT', revision: 7, frame_keys: [],
    updated_at: '2026-05-05T05:05:05.000Z',
    achievement_names: oldNames,
  };
  const expected = {
    id: 'achievements', filename: 'achievements.png', label: 'Achievements', kind: 'achievement_atlas' as const,
    status: 'pending' as const, prompt: 'x', revision: 0, frame_keys: [],
    achievement_names: newNames,
  };

  const merged = refreshSavedReviewItemMetadata(saved, expected);
  assert.deepEqual(merged.achievement_names, newNames);
  assert.equal(merged.achievement_names?.length, 20);
  // Generation state preserved.
  assert.equal(merged.status, 'accepted');
  assert.equal(merged.revision, 7);
  assert.equal(merged.updated_at, '2026-05-05T05:05:05.000Z');
});
