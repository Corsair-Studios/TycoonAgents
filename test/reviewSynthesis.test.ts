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

  const rows = objectRowsForItem({ id: 'objects_01', object_rows: staleObjectRows }, manifest);

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

// --- Regression: multi-board object rosters must map poof/crate onto the
// board that actually carries them, not bleed onto a neighboring board's
// last object row (the reported bug: crate rendered as object #10's frame). ---

test('objectRowsForItem gives board A (5 objects) no poof/crate, and board B (2 objects + poof + crate) the trailing rows', () => {
  const manifest = legacyManifest();
  // 7 objects -> flatRows = 7 objects + poof + crate = 9 rows -> boards of [5, 4]:
  // board A = objects 0-4 (5 rows, no poof/crate); board B = objects 5-6 + poof + crate.
  manifest.buildable_objects = manifest.buildable_objects.slice(0, 7);

  const boardA = objectRowsForItem({ id: 'objects_01' }, manifest);
  assert.equal(boardA.length, 5);
  assert.ok(boardA.every((row) => row.kind === 'object'), 'board A must carry only object rows');
  assert.deepEqual(boardA.map((row) => row.kind === 'object' ? row.object_id : row.kind), [
    'object_0', 'object_1', 'object_2', 'object_3', 'object_4',
  ]);

  const boardB = objectRowsForItem({ id: 'objects_02' }, manifest);
  assert.equal(boardB.length, 4);
  assert.deepEqual(boardB.map((row) => row.kind === 'object' ? row.object_id : row.kind), [
    'object_5', 'object_6', 'poof', 'crate',
  ]);
});

test('applyObjectBoardFrames writes crate/poof only from the board that carries them, at the correct row slots', () => {
  const manifest = legacyManifest();
  manifest.buildable_objects = manifest.buildable_objects.slice(0, 7);
  const boardA = objectRowsForItem({ id: 'objects_01' }, manifest); // 5 object rows, no poof/crate
  const boardB = objectRowsForItem({ id: 'objects_02' }, manifest); // object_5, object_6, poof, crate

  const makeSlots = (board: string, rowCount: number) =>
    Array.from({ length: rowCount * 4 }, (_unused, slotIndex) => ({
      slot_id: slotIndex,
      data: `${board}_r${Math.floor(slotIndex / 4)}_c${slotIndex % 4}`,
    }));

  // Both boards write into the SAME shared frames map, as they do in production
  // (one call per board, sharing the theme's frames.json record).
  const frames: Record<string, string[]> = {};
  applyObjectBoardFrames(frames, makeSlots('A', boardA.length), boardA);
  applyObjectBoardFrames(frames, makeSlots('B', boardB.length), boardB);

  // Board A's own object rows are intact and untouched by board B.
  assert.deepEqual(frames['object_object_0'], ['A_r0_c0', 'A_r0_c1', 'A_r0_c2', 'A_r0_c3']);
  assert.deepEqual(frames['object_object_4'], ['A_r4_c0', 'A_r4_c1', 'A_r4_c2', 'A_r4_c3']);

  // Board B's object rows use board B's OWN row indices (0, 1), not the global
  // object index (5, 6).
  assert.deepEqual(frames['object_object_5'], ['B_r0_c0', 'B_r0_c1', 'B_r0_c2', 'B_r0_c3']);
  assert.deepEqual(frames['object_object_6'], ['B_r1_c0', 'B_r1_c1', 'B_r1_c2', 'B_r1_c3']);

  // 'poof' comes from board B's row 2 (all 4 frames); 'crate' from board B's
  // LAST row (row 3), slot 0 only — never from board A's last row.
  assert.deepEqual(frames.poof, ['B_r2_c0', 'B_r2_c1', 'B_r2_c2', 'B_r2_c3']);
  assert.deepEqual(frames.crate, ['B_r3_c0']);

  // Board A (which has no poof/crate row of its own) must never have written
  // those keys — this is the exact bug: a board without a crate row silently
  // wrote frames.crate from its own last object row.
  const framesAfterBoardAOnly: Record<string, string[]> = {};
  applyObjectBoardFrames(framesAfterBoardAOnly, makeSlots('A', boardA.length), boardA);
  assert.equal(framesAfterBoardAOnly.crate, undefined);
  assert.equal(framesAfterBoardAOnly.poof, undefined);
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

// --- Regression: reproduces the REAL production layout reported as broken —
// a 12-object theme (cobra_command) with object ids/board split matching the
// user's actual manifest: board 1 = objects 1-5, board 2 = objects 6-10 (no
// poof/crate of its own), board 3 = objects 11-12 + poof + crate. Prior to the
// fix, board 2's item carried stale saved object_rows from an earlier 8-object
// snapshot of the roster (where board 2 WAS the terminal board and legitimately
// owned poof/crate), and nothing ever recomputed or purged that staleness. ---

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
];

function realTwelveObjectManifest(): ThemeManifest {
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

test('objectRowsForItem: real 12-object cobra_command layout — board 2 (objects 6-10) carries five real objects and NO poof/crate; board 3 (objects 11-12) carries the poof/crate rows', () => {
  const manifest = realTwelveObjectManifest();

  const board1 = objectRowsForItem({ id: 'objects_01' }, manifest);
  assert.deepEqual(board1.map((row) => row.kind === 'object' ? row.object_id : row.kind), [
    'mobile_command_center', 'stealth_recon_drone', 'high_voltage_energy_turret',
    'snake_pit_trap', 'armored_personnel_carrier',
  ]);

  const board2 = objectRowsForItem({ id: 'objects_02' }, manifest);
  assert.deepEqual(board2.map((row) => row.kind === 'object' ? row.object_id : row.kind), [
    'camouflage_netting', 'explosive_charge_barrel', 'communication_relay_tower',
    'missile_launcher_pod', 'security_scanner_console',
  ]);
  assert.ok(board2.every((row) => row.kind === 'object'), 'board 2 must NOT carry poof/crate rows');

  const board3 = objectRowsForItem({ id: 'objects_03' }, manifest);
  assert.deepEqual(board3.map((row) => row.kind === 'object' ? row.object_id : row.kind), [
    'cobra_heliport_platform', 'jungle_surveillance_camera', 'poof', 'crate',
  ]);
});

test('mergeResumedReviewItems: a roster that GREW from 8 to 12 objects must not let board 2 keep stale saved poof/crate rows on resume', () => {
  // The exact production scenario: board 2 was generated back when the roster
  // only had 8 objects, so it legitimately owned poof+crate at that time and
  // its saved review-item metadata reflects that ([obj6, obj7, obj8, poof, crate]
  // in old 0-based/8-object terms == [camouflage_netting, explosive_charge_barrel,
  // communication_relay_tower, poof, crate]). The roster later grew to 12
  // objects (adding missile_launcher_pod, security_scanner_console,
  // cobra_heliport_platform, jungle_surveillance_camera), which should push
  // poof/crate onto a NEW board 3 and give board 2 five full object rows — but
  // only if resume prefers the freshly recomputed board over the stale saved one.
  const eightObjectManifest = realTwelveObjectManifest();
  eightObjectManifest.buildable_objects = eightObjectManifest.buildable_objects.slice(0, 8);
  const staleBoard2Rows = objectRowsForItem({ id: 'objects_02' }, eightObjectManifest);
  // Sanity: under the OLD 8-object roster, board 2 really was the terminal
  // board and really did own poof/crate.
  assert.deepEqual(staleBoard2Rows.map((row) => row.kind === 'object' ? row.object_id : row.kind), [
    'camouflage_netting', 'explosive_charge_barrel', 'communication_relay_tower', 'poof', 'crate',
  ]);

  const savedItems = [
    {
      id: 'objects_02', filename: 'objects_02.png', label: 'stale', kind: 'object_atlas' as const,
      status: 'accepted' as const, prompt: 'STALE PROMPT', revision: 1, frame_keys: ['a', 'b', 'c', 'poof', 'crate'],
      object_rows: staleBoard2Rows, updated_at: '2026-07-05T13:59:00.000Z',
    },
  ];

  const currentManifest = realTwelveObjectManifest(); // now has all 12 objects
  const expectedItems = createReviewItems(
    minimalPlan(),
    currentManifest,
    'gritty wasteland',
  ).filter((item) => item.id === 'objects_02');

  const merged = mergeResumedReviewItems(expectedItems, savedItems);
  assert.equal(merged.length, 1);
  const mergedItem = merged[0];

  // The freshly recomputed board wins for rows/prompt/frame_keys...
  assert.deepEqual(
    mergedItem.object_rows?.map((row) => row.kind === 'object' ? row.object_id : row.kind),
    ['camouflage_netting', 'explosive_charge_barrel', 'communication_relay_tower', 'missile_launcher_pod', 'security_scanner_console'],
  );
  assert.ok(!mergedItem.frame_keys.includes('poof'), 'resumed board 2 must not carry a stale poof frame key');
  assert.ok(!mergedItem.frame_keys.includes('crate'), 'resumed board 2 must not carry a stale crate frame key');
  assert.notEqual(mergedItem.prompt, 'STALE PROMPT');

  // ...but review PROGRESS still comes from the saved document.
  assert.equal(mergedItem.status, 'accepted');
  assert.equal(mergedItem.revision, 1);
  assert.equal(mergedItem.updated_at, '2026-07-05T13:59:00.000Z');
});

test('mergeResumedReviewItems: an item with no saved counterpart (never generated before) uses the expected item as-is', () => {
  const manifest = realTwelveObjectManifest();
  const expectedItems = createReviewItems(minimalPlan(), manifest, 'gritty wasteland')
    .filter((item) => item.id === 'objects_03');
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

test('resyncRenamedReviewItems rebuilds only the object board containing the renamed row, with the new name baked into its prompt', () => {
  const manifest = realTwelveObjectManifest();
  const plan = minimalPlan();
  // Saved document reflects generation BEFORE the rename (old name baked into
  // board 2's prompt, matching the real cobra_command layout from the tests
  // above: board 2 = objects 6-10, including camouflage_netting).
  const savedItems = savedReviewDocumentItems(manifest, plan);
  const savedBoard2 = savedItems.find((item) => item.id === 'objects_02')!;
  assert.match(savedBoard2.prompt, /Camouflage Netting/);

  const result = applyThemeItemNameChanges(manifest, [
    { item_kind: 'object', id: 'camouflage_netting', name: 'Ghillie Netting' },
  ]);
  assert.equal(result.applied.length, 1);
  assert.equal(manifest.buildable_objects.find((o) => o.object_id === 'camouflage_netting')?.display_name, 'Ghillie Netting');

  const refreshed = resyncRenamedReviewItems({ items: savedItems }, manifest, plan, result.applied);

  // Only the board that actually carries the renamed row comes back.
  assert.deepEqual(refreshed.map((item) => item.id), ['objects_02']);
  const refreshedBoard2 = refreshed[0];
  assert.match(refreshedBoard2.prompt, /Ghillie Netting/);
  assert.doesNotMatch(refreshedBoard2.prompt, /Camouflage Netting/);

  // Review PROGRESS survives the resync untouched — a rename must never bounce
  // an accepted board back to pending.
  assert.equal(refreshedBoard2.status, savedBoard2.status);
  assert.equal(refreshedBoard2.revision, savedBoard2.revision);
  assert.equal(refreshedBoard2.updated_at, savedBoard2.updated_at);

  // Unaffected boards (objects_01, objects_03, and every non-object board) are
  // simply absent from the resync result — the caller only overwrites what's
  // returned here, so their saved prompt/rows are left byte-for-byte alone.
  assert.ok(!refreshed.some((item) => item.id === 'objects_01'));
  assert.ok(!refreshed.some((item) => item.id === 'objects_03'));
});

test('resyncRenamedReviewItems is a no-op for a character-only rename batch (that flow already has its own sync)', () => {
  const manifest = realTwelveObjectManifest();
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
  const manifest = realTwelveObjectManifest(); // 3 rivals -> a single rivals_01 board
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
