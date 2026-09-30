import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAchievementAtlasPrompt,
  buildBackgroundDecorPrompt,
  buildCharacterAtlasPrompt,
  buildCharacterAtlasRequest,
  buildEmoteAtlasPrompt,
  buildEnvironmentPrompt,
  buildExpressionAtlasPrompt,
  buildObjectAtlasPrompt,
  CHARACTER_TARGET_CONTENT_HEIGHT,
  CHARACTER_TARGET_CONTENT_PERCENT,
  buildRivalAtlasPrompt,
  createDecorBoardRows,
  createObjectBoard1Rows,
  createObjectBoard2Rows,
  createRivalBoardRows,
  decorBoardFrameKeys,
  objectBoardFrameKeys,
  OBJECT_ANIMATED_COUNT,
  OBJECT_BOARD1_STATIC_COUNT,
  OBJECT_BOARD2_STATIC_COUNT,
  OBJECT_POOF_FRAME_COUNT,
  rivalBoardFrameKeys,
  RIVALS_PER_BOARD,
} from '../src/extension/themeAssetPrompts';

function decorSpecs() {
  return Array.from({ length: 9 }, (_unused, index) => ({
    decor_id: `d_${index + 1}`,
    display_name: `Decor ${index + 1}`,
  }));
}

function rivalSpecs() {
  return Array.from({ length: 12 }, (_unused, index) => ({
    rival_id: `r_${index + 1}`,
    display_name: `Rival ${index + 1}`,
  }));
}

test('rivals pack 4-per-board across 3 boards (12 enemies)', () => {
  assert.equal(RIVALS_PER_BOARD, 4);
  const boards = createRivalBoardRows(rivalSpecs());
  assert.equal(boards.length, 3);
  for (const board of boards) {
    assert.equal(board.length, 4);
    for (const row of board) assert.equal(row.kind, 'rival');
  }
  // Every rival id appears exactly once, board-order.
  const ids = boards.flat().map((row) => row.rival_id);
  assert.deepEqual(ids, rivalSpecs().map((r) => r.rival_id));
  assert.equal(new Set(ids).size, 12);
});

test('createRivalBoardRows supports any positive roster size, not just exactly 12', () => {
  assert.throws(() => createRivalBoardRows([]), /at least one rival/);

  // 3 rivals (e.g. cobra_command) -> a single board with exactly 3 rows.
  const threeRivals = Array.from({ length: 3 }, (_unused, index) => ({
    rival_id: `r_${index + 1}`,
    display_name: `Rival ${index + 1}`,
  }));
  const threeBoards = createRivalBoardRows(threeRivals);
  assert.equal(threeBoards.length, 1);
  assert.equal(threeBoards[0].length, 3);
  assert.deepEqual(threeBoards[0].map((row) => row.rival_id), ['r_1', 'r_2', 'r_3']);

  // 12 rivals -> still 3 full boards of 4.
  const twelveBoards = createRivalBoardRows(rivalSpecs());
  assert.equal(twelveBoards.length, 3);
  for (const board of twelveBoards) assert.equal(board.length, 4);
});

test('rivalBoardFrameKeys yields one rival_<id> key per enemy row', () => {
  const boards = createRivalBoardRows(rivalSpecs());
  assert.deepEqual(rivalBoardFrameKeys(boards[0]), ['rival_r_1', 'rival_r_2', 'rival_r_3', 'rival_r_4']);
});

test('rival prompt is a 5x4 compact board with 2-frame walk + 3-frame attack per enemy row', () => {
  const boards = createRivalBoardRows(rivalSpecs());
  const prompt = buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', boards[0]);
  assert.match(prompt, /one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(prompt, /5-column by 4-row grid of 20 equal cells/i);
  assert.match(prompt, /one complete, seamless two-frame locomotion cycle/i);
  assert.match(prompt, /Cell 2 — Opposite contact/i);
  assert.match(prompt, /Do not duplicate cell 1 as cell 2/i);
  assert.match(prompt, /3-frame ATTACK/i);
  assert.match(prompt, /Row 1 \(Cells 1-5\): the enemy \*\*"Rival 1"\*\*/i);
  assert.match(prompt, /Row 4 \(Cells 16-20\): the enemy \*\*"Rival 4"\*\*/i);
  assert.match(prompt, /flips? cleanly/i);
  assert.match(prompt, /1\/5 of the canvas width wide and 1\/4 of the canvas height tall/i);
  assert.match(prompt, /taller than it is wide \(about 1\.25:1\)/i);
  assert.match(prompt, /animated IN PLACE/i);
  assert.match(prompt, /same horizontal center.*same feet baseline.*same overall body scale/i);
  assert.match(prompt, /drifts, re-centers, or changes scale.*incorrect result/i);
});

test('rival prompt states an explicit numeric width+height silhouette budget and minimum gutter', () => {
  const boards = createRivalBoardRows(rivalSpecs());
  const prompt = buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', boards[0]);
  assert.match(prompt, /RIVAL SILHOUETTE BUDGET \(STRICT — WIDTH AND HEIGHT\)/i);
  assert.match(prompt, /stays within the central 70% of the cell in BOTH width and height/i);
  assert.match(prompt, /clear (transparent|magenta) gutter of at least 15% of the cell size on every side/i);
  assert.match(prompt, /curl appendages, limbs, tentacles, and weapons INWARD/i);
  assert.match(prompt, /No part of the enemy, in any frame, may touch or cross a cell edge/i);
});

test('rival prompt scales its board contract and row count to a partial (3-row) board', () => {
  const threeRivals = rivalSpecs().slice(0, 3);
  const boards = createRivalBoardRows(threeRivals);
  const prompt = buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', boards[0]);
  assert.match(prompt, /5-column by 3-row grid of 15 equal cells/i);
  assert.match(prompt, /Each of the 3 ROWS is ONE distinct named enemy/i);
});

test('character prompt enforces the production sprite-board mime contracts', () => {
  const prompt = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid');
  assert.match(prompt, /EXACT SAME character[\s\S]*\*\*"Nova"\*\* from the \*\*Night Grid\*\* theme/i);
  assert.match(prompt, /exact \*\*5-column by 4-row grid\*\* containing \*\*20 equal-sized cells\*\*/i);
  assert.match(prompt, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(prompt, /TOOL HANDLING ANIMATION[\s\S]*tool always swings through empty magenta space/i);
  assert.match(prompt, /INVISIBLE CHAIR CONTRACT \(ABSOLUTE\)[\s\S]*support is completely invisible/i);
  assert.match(prompt, /EMPTY TARGET CONTRACT \(HIGHEST PRIORITY\)[\s\S]*No construction result/i);
  assert.match(prompt, /playful, non-graphic, non-contact actions/i);
  assert.equal(CHARACTER_TARGET_CONTENT_HEIGHT, 118);
});

test('character prompt row 1 cells 1-4 describe a four-frame walk cycle, cell 5 stays the back view', () => {
  const prompt = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid');
  assert.match(
    prompt,
    /one complete, seamless locomotion cycle, arranged in playback order/i,
  );
  assert.match(prompt, /Frame 3 — Opposite contact/i);
  assert.match(prompt, /Do not duplicate the first frame as the fourth frame/i);
  assert.match(
    prompt,
    /the same character standing still, seen from directly behind, back to the viewer/i,
  );
  assert.doesNotMatch(prompt, /impatient idle/i);
  assert.doesNotMatch(prompt, /Cell 3 — CONTACT, foot B forward/i);
  assert.doesNotMatch(prompt, /Cell 4 — PASSING/i);
  assert.doesNotMatch(prompt, /Cell 5 — RECOVERY/i);
  assert.equal(CHARACTER_TARGET_CONTENT_PERCENT, 72);
  assert.match(prompt, /complete character from head to feet occupies exactly 72% of the cell height/i);
  assert.match(prompt, /72% against each individual cell/i);
  assert.match(prompt, /below 68% or above 76%.*incorrect result/i);
  assert.match(prompt, /Do not leave oversized magenta margins/i);
  assert.match(prompt, /visible magenta gutter at every horizontal row boundary/i);
  // Hardening: uniform scale, horizontal containment, and an explicit no-border directive.
  assert.match(prompt, /UNIFORM SCALE \(ALL 20 CELLS\)[\s\S]*head-to-feet height must be IDENTICAL/i);
  assert.match(prompt, /HORIZONTAL CONTAINMENT \(ALL 20 CELLS\)[\s\S]*margin on BOTH the left AND the right/i);
  assert.match(prompt, /NO BORDERS OR GRID ARTIFACTS \(ABSOLUTE\)[\s\S]*runs edge to edge with NO framing of any kind/i);
  assert.match(prompt, /safety padding below both feet/i);
  assert.match(prompt, /Melee strike[\s\S]*Ranged fire/i);
  assert.match(prompt, /never mixes melee and ranged in one frame/i);
  assert.match(prompt, /No firearm anywhere/i);
  assert.match(prompt, /No melee weapon/i);
  assert.match(prompt, /solid \*\*#FF00FF\*\*/i);
  assert.match(prompt, /Theme: Night Grid[\s\S]*neon cyberpunk/i);
  assert.doesNotMatch(prompt, /Circuit Broker|Cyberpunk 2049/i);
  assert.doesNotMatch(prompt, /place\/build object|inspect finished work/i);
  assert.match(prompt, /animated IN PLACE/i);
  assert.match(prompt, /same horizontal center, the same feet baseline, and the same overall body scale/i);
  assert.match(prompt, /slides, re-centers, or changes size.*incorrect result/i);
});

test('CHARACTER_TARGET_CONTENT_PERCENT stays comfortably below the slicer normalization headroom', () => {
  // Prompt-side generation target must stay below the slicer-side normalization target
  // (expressed as a percentage of the 128px cell) so generations retain clipping headroom.
  assert.ok(
    CHARACTER_TARGET_CONTENT_PERCENT < (CHARACTER_TARGET_CONTENT_HEIGHT / 128) * 100,
    'CHARACTER_TARGET_CONTENT_PERCENT must stay below (CHARACTER_TARGET_CONTENT_HEIGHT / 128) * 100',
  );
});

test('environment prompt treats the reference as an opaque geometry guide', () => {
  const prompt = buildEnvironmentPrompt('neon cyberpunk', 'Night Grid');
  assert.match(prompt, /OPAQUE GEOMETRY GUIDE/);
  assert.match(prompt, /OUTSIDE THE ASSET.*cyan \(#00FFFF\)/i);
  assert.match(prompt, /exact outer hexagonal stage silhouette/i);
  assert.match(prompt, /No characters/i);
});

test('environment prompt bans floor clutter (empty-floor rule) and any silhouette outline (no-boundary-line rule), with theme + creative direction interpolated', () => {
  const prompt = buildEnvironmentPrompt('neon cyberpunk', 'Night Grid');

  // CAMERA — pins the environment's isometric angle to match the object/decor sprites.
  assert.match(prompt, /CAMERA — match the object and decor sprites EXACTLY/i);
  assert.match(prompt, /2:1 pixel-art isometric/i);
  assert.match(prompt, /about 25 degrees/i);
  assert.match(prompt, /about 30 degrees/i);
  assert.match(prompt, /lower-LEFT to upper-RIGHT/i);

  // CRITICAL — keep the floor empty.
  assert.match(prompt, /CRITICAL — keep the floor empty/i);
  assert.match(prompt, /RESERVED WALKABLE AREA/i);
  assert.match(prompt, /MUST be completely empty/i);
  assert.match(prompt, /fountains/i);
  assert.match(prompt, /lamp posts/i);
  assert.match(prompt, /ONLY along the REAR wall.*far left and right perimeter/i);

  // CRITICAL — no overhang into the floor.
  assert.match(prompt, /CRITICAL — no overhang into the floor/i);
  assert.match(prompt, /CLEAR MARGIN on all sides/i);
  assert.match(prompt, /must NOT overhang, lean, spill, drape/i);
  assert.match(prompt, /open floor must be a clean, unobstructed edge/i);

  // CRITICAL — no boundary line.
  assert.match(prompt, /CRITICAL — no boundary line/i);
  assert.match(prompt, /outline, border, rim/i);
  assert.match(prompt, /zero cyan or light-blue pixels/i);

  // CRITICAL — bare NEAR (front-left/front-right) corners of the hexagonal stage.
  assert.match(prompt, /NEAR corners/);
  assert.match(prompt, /bare stone/i);
  assert.match(prompt, /front point/i);
  assert.match(prompt, /front-left and front-right/i);
  assert.match(prompt, /COMPLETELY EMPTY walkable ground/i);
  assert.match(prompt, /REAR wall/);

  // themeName + creativeDirection are still interpolated, with the
  // direction opening the prompt as a governing block rather than trailing.
  assert.match(prompt, /"Night Grid" theme\./);
  assert.match(prompt, /^Art direction \(governs everything below\): neon cyberpunk/);
});

function staticObjectSpecs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    object_id: `object_${index + 1}`,
    display_name: `Object ${index + 1}`,
  }));
}

function animatedObjectSpecs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    object_id: `anim_${index + 1}`,
    display_name: `Animated Object ${index + 1}`,
  }));
}

function board2StaticObjectSpecs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    object_id: `board2_static_${index + 1}`,
    display_name: `Board2 Static ${index + 1}`,
  }));
}

test('aggregate prompts define the two-board object layout, 8 expressions, and 20 badges', () => {
  const board1Rows = createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT));
  const objects = buildObjectAtlasPrompt('industrial', 'Factory', board1Rows);
  assert.match(objects, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(objects, /4-column by 4-row grid of 16 equal cells/i);
  assert.match(objects, /Cell 16: Object 16/i);
  assert.match(objects, /16 distinct STATIC buildable objects/i);
  assert.match(objects, /never touch the cell's bottom edge/i);
  assert.match(objects, /fills about 75% of its cell's height/i);
  assert.match(objects, /unbroken gutter along EVERY horizontal row boundary/i);
  assert.match(objects, /2:1 pixel-art isometric interior view/i);
  assert.match(objects, /front CORNER \(not a flat face\) pointing toward the viewer/i);
  assert.match(objects, /naturally TALL object.*must be SCALED DOWN to fit entirely inside the cell/i);
  assert.match(objects, /about 25 degrees/i);
  assert.match(objects, /bottom-LEFT corner sits LOWER on the canvas than its bottom-RIGHT corner/i);

  const board2Rows = createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT));
  const board2 = buildObjectAtlasPrompt('industrial', 'Factory', board2Rows);
  assert.match(board2, /4-column by 4-row grid of 16 equal cells/i);
  assert.match(board2, /Row 1 \(Cells 1-4\).*Animated Object 1/i);
  assert.match(board2, /Row 2 \(Cells 5-8\).*Animated Object 2/i);
  assert.match(board2, /Cells 9-12.*FOUR-frame one-shot build-completion POOF/i);
  assert.match(board2, /Row 4 \(Cells 13-15\).*three distinct STATIC buildable objects/i);
  assert.match(board2, /Cell 13: Board2 Static 1/i);
  assert.match(board2, /Cell 16.*CRATE/i);
  assert.match(board2, new RegExp(`${OBJECT_POOF_FRAME_COUNT}-frame one-shot reveal`, 'i'));

  const expressions = buildExpressionAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 8 }, (_unused, index) => `Expression ${index + 1}`),
  );
  assert.match(expressions, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(expressions, /4-column by 2-row grid of 8 equal cells/i);
  assert.match(expressions, /Cell 8: Expression 8/);
  assert.match(expressions, /Cell 8 \("Dazed \/ hit"\)/i);
  // A user description on Cell 8 must be followed instead of forcing the default stars motif.
  assert.match(expressions, /do NOT fall back to stars or a swirl/i);
  assert.match(expressions, /When a description IS given, follow that description instead/i);
  // A user-supplied per-cell description is authoritative for the icon's style/theme flavor.
  assert.match(expressions, /authoritative for the icon's STYLE and theme flavor/i);
  // ...but icons must never become faces/characters (they render very small).
  assert.match(expressions, /These are ICONS, NOT characters/i);
  assert.match(expressions, /Do NOT draw any face/i);

  const achievements = buildAchievementAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 25 }, (_unused, index) => `Badge ${index + 1}`),
  );
  assert.match(achievements, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(achievements, /5-column by 5-row grid of 25 equal cells/i);
  assert.match(achievements, /Cell 25: Badge 25/);
  assert.match(achievements, /do not include unlock requirements/i);
});

test('object board prompts carry the no-overhang cell-containment rule on both boards (encroachment fix)', () => {
  const board1 = buildObjectAtlasPrompt('industrial', 'Factory', createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT)));
  const board2 = buildObjectAtlasPrompt(
    'industrial',
    'Factory',
    createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT)),
  );
  for (const prompt of [board1, board2]) {
    assert.match(prompt, /never touch or cross any cell edge/i);
    assert.match(prompt, /extend into a neighboring cell/i);
    assert.match(prompt, /draw it SMALLER to fit/i);
  }
});

test('environment and object board prompts share the same isometric camera angle tokens (no silent drift)', () => {
  const environment = buildEnvironmentPrompt('industrial', 'Factory');
  const objects = buildObjectAtlasPrompt('industrial', 'Factory', createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT)));

  for (const prompt of [environment, objects]) {
    assert.ok(prompt.includes('2:1'), 'expected "2:1" isometric ratio in prompt');
    assert.ok(prompt.includes('25 degrees'), 'expected "25 degrees" ground-recede angle in prompt');
    assert.ok(prompt.includes('30 degrees'), 'expected "30 degrees" viewer-down angle in prompt');
  }
});

test('achievement prompt injects per-badge appearance descriptions when provided', () => {
  const names = Array.from({ length: 25 }, (_unused, index) => `Badge ${index + 1}`);
  const descriptions = new Array(25).fill('');
  descriptions[0] = 'a gold laurel wreath around a crossed hammer';
  descriptions[24] = 'a shattered obsidian star';
  const prompt = buildAchievementAtlasPrompt('industrial', 'Factory', names, 'magenta', descriptions);
  // Cell with a description carries "<name> — <description>"; blank ones stay name-only.
  assert.match(prompt, /Cell 1: Badge 1 — a gold laurel wreath around a crossed hammer/);
  assert.match(prompt, /Cell 25: Badge 25 — a shattered obsidian star/);
  assert.match(prompt, /Cell 2: Badge 2\n/);
});

test('expression prompt injects per-cell appearance descriptions when provided, name-only when absent', () => {
  const names = Array.from({ length: 8 }, (_unused, index) => `Expression ${index + 1}`);
  const descriptions = new Array(8).fill('');
  descriptions[0] = 'a pulsing neon heart';
  descriptions[7] = 'a cluster of swirling stars';
  const prompt = buildExpressionAtlasPrompt('industrial', 'Factory', names, 'magenta', descriptions);
  // Cell with a description carries "<label> — <description>"; blank ones stay label-only.
  assert.match(prompt, /Cell 1: Expression 1 — a pulsing neon heart/);
  assert.match(prompt, /Cell 8: Expression 8 — a cluster of swirling stars/);
  assert.match(prompt, /Cell 2: Expression 2\n/);
  // Byte-identical to the no-description prompt when descriptions is omitted.
  const noDesc = buildExpressionAtlasPrompt('industrial', 'Factory', names, 'magenta');
  const allBlank = buildExpressionAtlasPrompt('industrial', 'Factory', names, 'magenta', new Array(8).fill(''));
  assert.equal(allBlank, noDesc);
});

test('object board 1 prompt emits explicit ranged-rack guidance for cell 1 and generic guidance elsewhere', () => {
  const specs = staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT);
  const rows = createObjectBoard1Rows([
    { ...specs[0], object_id: 'rack', display_name: 'Laser Rifle Rack', is_ranged_rack: true },
    ...specs.slice(1),
  ]);
  const prompt = buildObjectAtlasPrompt('sci-fi', 'Orbital', rows);
  // Cell 1 (the rack, build_order 0) gets the dedicated ranged-weapon guidance.
  assert.match(prompt, /Cell 1: Laser Rifle Rack — a wall- or floor-mounted rack\/stand displaying several themed RANGED weapons/i);
  assert.match(prompt, /clearly readable as ranged weapons — NOT a crate, shelf, or melee weapons/i);
  // Every other cell gets the generic static-object guidance.
  assert.match(prompt, /Cell 2: Object 2 — one complete, fully-built theme structure\/prop/i);
});

test('object board 1 prompt requires exactly OBJECT_BOARD1_STATIC_COUNT cells', () => {
  assert.throws(
    () => buildObjectAtlasPrompt('industrial', 'Factory', createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT)).slice(0, 5)),
    /exactly 16 static-object cells/,
  );
});

test('object board 2 prompt threads per-object motion hints and falls back to the generic default', () => {
  const rows = createObjectBoard2Rows(
    [
      { object_id: 'radar', display_name: 'Radar Dish', motion_hint: 'radar dish slowly rotates' },
      { object_id: 'core', display_name: 'Reactor Core' },
    ],
    board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT),
  );
  const prompt = buildObjectAtlasPrompt('sci-fi', 'Orbital', rows);
  assert.match(prompt, /Row 1 \(Cells 1-4\): the four sequential animation frames of ONE object — Radar Dish — radar dish slowly rotates/i);
  assert.match(prompt, /Row 2 \(Cells 5-8\): the four sequential animation frames of a SECOND object — Reactor Core — invent one subtle functional motion/i);
  // The shared lights/highlights-only animation constraint is reused for BOTH rows.
  assert.equal((prompt.match(/Permitted animation is limited STRICTLY to lights and subtle highlights/gi) ?? []).length, 2);
});

test('createObjectBoard1Rows carries is_ranged_rack and motion_hint onto the object cells, and requires exactly OBJECT_BOARD1_STATIC_COUNT objects', () => {
  const specs = staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT).map((spec, index) => ({
    ...spec,
    ...(index === 0 ? { is_ranged_rack: true } : {}),
    ...(index === 1 ? { motion_hint: 'gently hums' } : {}),
  }));
  const rows = createObjectBoard1Rows(specs);
  assert.equal(rows.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.ok(rows.every((row) => row.kind === 'object_static'));
  const rackRow = rows[0];
  assert.equal(rackRow.kind === 'object_static' ? rackRow.is_ranged_rack : undefined, true);
  const hintRow = rows[1];
  assert.equal(hintRow.kind === 'object_static' ? hintRow.motion_hint : undefined, 'gently hums');

  assert.throws(() => createObjectBoard1Rows(staticObjectSpecs(15)), /exactly 16 static objects/);
  assert.throws(() => createObjectBoard1Rows(staticObjectSpecs(17)), /exactly 16 static objects/);
});

test('createObjectBoard2Rows returns [animA, animB, poof, staticA, staticB, staticC, crate] and requires exactly OBJECT_ANIMATED_COUNT animated + OBJECT_BOARD2_STATIC_COUNT static objects', () => {
  const rows = createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT));
  assert.deepEqual(rows.map((row) => row.kind), ['object_anim', 'object_anim', 'poof', 'object_static', 'object_static', 'object_static', 'crate']);
  assert.deepEqual(objectBoardFrameKeys(rows), [
    'object_anim_1', 'object_anim_2', 'poof',
    'object_board2_static_1', 'object_board2_static_2', 'object_board2_static_3',
    'crate',
  ]);

  assert.throws(() => createObjectBoard2Rows(animatedObjectSpecs(1), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT)), /exactly 2 animated objects/);
  assert.throws(() => createObjectBoard2Rows(animatedObjectSpecs(3), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT)), /exactly 2 animated objects/);
  assert.throws(() => createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(2)), /exactly 3 static objects/);
  assert.throws(() => createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(4)), /exactly 3 static objects/);
});

test('createObjectBoard2Rows sets visual_description on the poof/crate rows only when supplied', () => {
  const withDescriptions = createObjectBoard2Rows(
    animatedObjectSpecs(OBJECT_ANIMATED_COUNT),
    board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT),
    'a small puff of glittering violet smoke',
    'a reinforced steel crate with hazard stripes',
  );
  const poofRow = withDescriptions.find((row) => row.kind === 'poof');
  const crateRow = withDescriptions.find((row) => row.kind === 'crate');
  assert.equal(poofRow?.kind === 'poof' ? poofRow.visual_description : undefined, 'a small puff of glittering violet smoke');
  assert.equal(crateRow?.kind === 'crate' ? crateRow.visual_description : undefined, 'a reinforced steel crate with hazard stripes');

  // Whitespace-only descriptions are treated as absent, same as every other visual_description field.
  const blank = createObjectBoard2Rows(
    animatedObjectSpecs(OBJECT_ANIMATED_COUNT),
    board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT),
    '   ',
    '',
  );
  const blankPoofRow = blank.find((row) => row.kind === 'poof');
  const blankCrateRow = blank.find((row) => row.kind === 'crate');
  assert.equal(blankPoofRow?.kind === 'poof' ? blankPoofRow.visual_description : undefined, undefined);
  assert.equal(blankCrateRow?.kind === 'crate' ? blankCrateRow.visual_description : undefined, undefined);

  // Omitted entirely -> no visual_description field on either row (existing 2-arg callers unaffected).
  const withoutDescriptions = createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT));
  const noDescPoofRow = withoutDescriptions.find((row) => row.kind === 'poof');
  const noDescCrateRow = withoutDescriptions.find((row) => row.kind === 'crate');
  assert.equal(noDescPoofRow?.kind === 'poof' ? noDescPoofRow.visual_description : undefined, undefined);
  assert.equal(noDescCrateRow?.kind === 'crate' ? noDescCrateRow.visual_description : undefined, undefined);
});

test('object board 2 prompt injects the crate/poof descriptions when present, and is byte-identical to the no-description prompt when absent', () => {
  const rowsWithoutDescriptions = createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT));
  const baselinePrompt = buildObjectAtlasPrompt('industrial', 'Factory', rowsWithoutDescriptions);

  // Explicitly passing `undefined` for both is the same as omitting them — byte-identical.
  const rowsExplicitUndefined = createObjectBoard2Rows(
    animatedObjectSpecs(OBJECT_ANIMATED_COUNT),
    board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT),
    undefined,
    undefined,
  );
  assert.equal(buildObjectAtlasPrompt('industrial', 'Factory', rowsExplicitUndefined), baselinePrompt);

  const rowsWithDescriptions = createObjectBoard2Rows(
    animatedObjectSpecs(OBJECT_ANIMATED_COUNT),
    board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT),
    'a small puff of glittering violet smoke',
    'a reinforced steel crate with hazard stripes',
  );
  const promptWithDescriptions = buildObjectAtlasPrompt('industrial', 'Factory', rowsWithDescriptions);
  assert.match(promptWithDescriptions, /FOUR-frame one-shot build-completion POOF[\s\S]*a small puff of glittering violet smoke/i);
  assert.match(promptWithDescriptions, /Appearance — depict this exact design: a small puff of glittering violet smoke/i);
  assert.match(promptWithDescriptions, /draw one closed themed shipping crate[\s\S]*a reinforced steel crate with hazard stripes/i);
  assert.match(promptWithDescriptions, /Appearance — depict this exact design: a reinforced steel crate with hazard stripes/i);
  assert.notEqual(promptWithDescriptions, baselinePrompt);
});

test('objectBoardFrameKeys yields one object_<id> key per cell for board 1 (16 static objects)', () => {
  const rows = createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT));
  const keys = objectBoardFrameKeys(rows);
  assert.equal(keys.length, OBJECT_BOARD1_STATIC_COUNT);
  assert.deepEqual(keys.slice(0, 3), ['object_object_1', 'object_object_2', 'object_object_3']);
  assert.equal(keys[keys.length - 1], 'object_object_16');
});

test('createDecorBoardRows maps 9 decor items onto the 4x4 seat/decor/anim/projectile layout', () => {
  const rows = createDecorBoardRows(decorSpecs());
  assert.deepEqual(rows.map((row) => row.length), [4, 4, 1, 1]);
  assert.deepEqual(rows.map((row) => row.map((cell) => cell.kind)), [
    ['seat', 'seat', 'seat', 'seat'],
    ['decor', 'decor', 'decor', 'decor'],
    ['decor_anim'],
    ['projectile'],
  ]);
  assert.deepEqual(decorBoardFrameKeys(rows), [
    'decor_d_1', 'decor_d_2', 'decor_d_3', 'decor_d_4',
    'decor_d_5', 'decor_d_6', 'decor_d_7', 'decor_d_8',
    'decor_d_9', 'projectile',
  ]);
  assert.throws(() => createDecorBoardRows(decorSpecs().slice(0, 8)), /exactly 9 decor items/);
});

test('background decor prompt describes seats, static decor, one animated row, and a ranged-fire projectile row', () => {
  const prompt = buildBackgroundDecorPrompt('cozy tavern', 'Tavern', createDecorBoardRows(decorSpecs()));
  assert.match(prompt, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(prompt, /4-column by 4-row grid of 16 equal cells/i);
  assert.match(prompt, /Each cell is a perfect square/i);
  assert.match(prompt, /never touch the cell's bottom edge/i);
  assert.match(prompt, /fills about 75% of its cell's height/i);
  assert.match(prompt, /unbroken magenta gutter along EVERY horizontal row boundary/i);
  assert.match(prompt, /2:1 pixel-art isometric interior view/i);
  assert.match(prompt, /hang on an ANGLED wall plane/i);
  assert.match(prompt, /naturally TALL item.*must be SCALED DOWN to fit entirely inside its cell/i);
  assert.match(prompt, /about 25 degrees/i);
  assert.match(prompt, /bottom-LEFT corner sits LOWER on the canvas than its bottom-RIGHT corner/i);
  assert.match(prompt, /Row 1 \(Cells 1-4\): FOUR distinct STATIC SITTABLE SEATS/i);
  assert.match(prompt, /character will visibly sit ON/i);
  assert.match(prompt, /Row 2 \(Cells 5-8\): FOUR distinct STATIC decor/i);
  assert.match(prompt, /Row 3 \(Cells 9-12\): ONE animated decor item shown as FOUR sequential loopable frames/i);
  assert.match(prompt, /Row 4 \(Cells 13-16\): the themed RANGED-WEAPON-FIRE projectile shown as FOUR sequential ONE-SHOT frames/i);
  assert.match(prompt, /Cell 13: the SHOT \/ MUZZLE FIRE at launch/i);
  assert.match(prompt, /Cell 14: the projectile IN FLIGHT/i);
  assert.match(prompt, /Cell 15: the projectile HITTING THE TARGET/i);
  assert.match(prompt, /Cell 16: the BLAST \/ IMPACT effect/i);
  assert.match(prompt, /Cell 1: Decor 1[\s\S]*Cell 8: Decor 8/i);
  assert.match(prompt, /solid #FF00FF magenta/i);
  assert.match(prompt, /NO anti-aliasing/i);
  assert.match(prompt, /never tint any subject pixel with the background magenta/i);
  assert.match(prompt, /locked in the identical position/i);
  assert.match(prompt, /locked to the same cell center/i);
  assert.match(prompt, /near-copy of the first frame/i);
  assert.match(prompt, /at least 95% of the subject's pixels stay identical/i);
  assert.match(prompt, /ambient accent/i);
  assert.match(prompt, /same projectile still anchored to that same cell center/i);
  assert.match(prompt, /width must be identical in every frame/i);
  assert.match(prompt, /footprint\/diameter stays constant across frames/i);
  assert.match(prompt, /^Art direction \(governs everything below\): cozy tavern/i);
});

// --- magenta is the only background -------------------------------------------
// No prompt builder may ever ask for a transparent / alpha background.

function assertMagentaOnly(prompt: string): void {
  assert.match(prompt, /#FF00FF/i);
  assert.doesNotMatch(prompt, /transparen/i);
  assert.doesNotMatch(prompt, /alpha/i);
}

test('no sprite-board prompt asks for a transparent or alpha background', () => {
  const boards = createRivalBoardRows(rivalSpecs());
  assertMagentaOnly(buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid'));
  assertMagentaOnly(buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', boards[0]));
  assertMagentaOnly(buildObjectAtlasPrompt('industrial', 'Factory', createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT))));
  assertMagentaOnly(buildObjectAtlasPrompt('industrial', 'Factory', createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT))));
  assertMagentaOnly(buildBackgroundDecorPrompt('cozy tavern', 'Tavern', createDecorBoardRows(decorSpecs())));
  assertMagentaOnly(buildExpressionAtlasPrompt('industrial', 'Factory', Array.from({ length: 7 }, (_unused, index) => `Expression ${index + 1}`)));
  assertMagentaOnly(buildAchievementAtlasPrompt('industrial', 'Factory', Array.from({ length: 20 }, (_unused, index) => `Badge ${index + 1}`)));
  assertMagentaOnly(buildEmoteAtlasPrompt('industrial', 'Factory'));
});

test('environment prompt is unaffected by background mode (it has no chroma keying)', () => {
  // buildEnvironmentPrompt never accepted a background-mode parameter, by design:
  // the environment board uses a cyan silhouette guide, not magenta/transparent
  // sprite keying, so it is out of scope for this feature.
  const prompt = buildEnvironmentPrompt('neon cyberpunk', 'Night Grid');
  assert.match(prompt, /cyan \(#00FFFF\)/i);
  assert.doesNotMatch(prompt, /magenta/i);
});

// --- Per-item visual descriptions --------------------------------------------
//
// Each builder appends a description when its row/param carries a non-empty
// visual_description, and must stay BYTE-IDENTICAL to a no-description call
// when it's absent, empty, or explicitly undefined.

test('buildCharacterAtlasPrompt injects an Appearance line only when a visual description is supplied, and stays byte-identical without one', () => {
  const baseline = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid');
  const omittedParam = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid', 'magenta');
  const explicitUndefined = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid', 'magenta', undefined);
  const emptyString = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid', 'magenta', '');
  assert.equal(omittedParam, baseline);
  assert.equal(explicitUndefined, baseline);
  assert.equal(emptyString, baseline);
  assert.doesNotMatch(baseline, /Appearance — depict this exact design/);

  const withDescription = buildCharacterAtlasPrompt(
    'neon cyberpunk', 'Nova', 'Night Grid', 'magenta',
    'A chrome humanoid with glowing blue circuitry seams',
  );
  assert.match(withDescription, /Appearance — depict this exact design: A chrome humanoid with glowing blue circuitry seams/);
  assert.notEqual(withDescription, baseline);
});

test('buildCharacterAtlasRequest strips a leading name from visual_description so the wire body and local prompt preview agree', () => {
  const req = buildCharacterAtlasRequest(
    'neon cyberpunk', 'Nova', 'Night Grid', 'magenta',
    'Nova: a chrome humanoid with glowing blue circuitry seams',
  );
  assert.equal(req.boardType, 'roster_agent');
  if (req.boardType !== 'roster_agent') throw new Error('expected roster_agent boardType');
  assert.equal(req.slot.description, 'A chrome humanoid with glowing blue circuitry seams');

  const prompt = buildCharacterAtlasPrompt(
    'neon cyberpunk', 'Nova', 'Night Grid', 'magenta',
    'Nova: a chrome humanoid with glowing blue circuitry seams',
  );
  assert.match(prompt, /Appearance — depict this exact design: A chrome humanoid with glowing blue circuitry seams/);
  assert.doesNotMatch(prompt, /Nova: a chrome humanoid/);
});

test('buildRivalAtlasPrompt appends an Appearance line per-row when visual_description is present, and stays byte-identical without one', () => {
  const baselineRows = createRivalBoardRows(rivalSpecs()); // no visual_description on any spec
  const baseline = buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', baselineRows[0]);

  // An explicit empty-string description is dropped by createRivalBoardRows's spread
  // guard, so the row shape (and the resulting prompt) must match the baseline exactly.
  const emptyDescRows = createRivalBoardRows(
    rivalSpecs().map((spec, index) => (index === 0 ? { ...spec, visual_description: '' } : spec)),
  );
  assert.equal(buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', emptyDescRows[0]), baseline);

  const describedRows = createRivalBoardRows(
    rivalSpecs().map((spec, index) => (index === 0 ? { ...spec, visual_description: 'A menacing red-eyed scrap drone' } : spec)),
  );
  const described = buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', describedRows[0]);
  assert.match(described, /Appearance — depict this exact design: A menacing red-eyed scrap drone/);
  assert.doesNotMatch(baseline, /Appearance — depict this exact design/);
});

test('buildObjectBoard1Prompt appends the visual description carried by a row built via createObjectBoard1Rows, byte-identical without one', () => {
  const baselineRows = createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT));
  const baseline = buildObjectAtlasPrompt('sci-fi', 'Orbital', baselineRows);

  const emptyDescRows = createObjectBoard1Rows(
    staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT).map((spec, index) => (index === 0 ? { ...spec, visual_description: '' } : spec)),
  );
  assert.equal(buildObjectAtlasPrompt('sci-fi', 'Orbital', emptyDescRows), baseline);

  const describedRows = createObjectBoard1Rows(
    staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT).map((spec, index) => (index === 0
      ? { ...spec, visual_description: 'A rugged steel weapon locker with amber warning lights' }
      : spec)),
  );
  const described = buildObjectAtlasPrompt('sci-fi', 'Orbital', describedRows);
  const describedLine = described.split('\n').find((line) => line.startsWith('Cell 1: '));
  assert.ok(describedLine, 'Cell 1 line must be present');
  assert.ok(describedLine?.endsWith(' — A rugged steel weapon locker with amber warning lights'));
  assert.doesNotMatch(baseline, /A rugged steel weapon locker/);
});

test('buildObjectBoard1Prompt appends the visual description to the ranged-rack cell too', () => {
  const specs = staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT);
  const rows = createObjectBoard1Rows([
    {
      ...specs[0],
      object_id: 'rack',
      display_name: 'Laser Rifle Rack',
      is_ranged_rack: true,
      visual_description: 'Wall-mounted chrome rack holding three glowing laser rifles',
    },
    ...specs.slice(1),
  ]);
  const prompt = buildObjectAtlasPrompt('sci-fi', 'Orbital', rows);
  const rackLine = prompt.split('\n').find((line) => line.startsWith('Cell 1: Laser Rifle Rack'));
  assert.ok(rackLine, 'Cell 1 rack line must be present');
  assert.ok(rackLine?.endsWith(' — Wall-mounted chrome rack holding three glowing laser rifles'));
});

test('buildBackgroundDecorPrompt appends visual descriptions to seat and animated decor cells, byte-identical without them', () => {
  const baseline = buildBackgroundDecorPrompt('cozy tavern', 'Tavern', createDecorBoardRows(decorSpecs()));

  const emptyDescSpecs = decorSpecs().map((spec, index) => (
    index === 0 || index === 8 ? { ...spec, visual_description: '' } : spec
  ));
  assert.equal(
    buildBackgroundDecorPrompt('cozy tavern', 'Tavern', createDecorBoardRows(emptyDescSpecs)),
    baseline,
  );

  const describedSpecs = decorSpecs().map((spec, index) => {
    if (index === 0) return { ...spec, visual_description: 'A weathered oak stool with a worn leather cushion' };
    if (index === 8) return { ...spec, visual_description: 'A slow-turning ceiling fan with brass blades' };
    return spec;
  });
  const described = buildBackgroundDecorPrompt('cozy tavern', 'Tavern', createDecorBoardRows(describedSpecs));
  const seatLine = described.split('\n').find((line) => line.trim().startsWith('Cell 1: Decor 1'));
  const animLine = described.split('\n').find((line) => line.trim().startsWith('Item: Decor 9'));
  assert.ok(seatLine, 'Cell 1 seat line must be present');
  assert.ok(seatLine?.endsWith(' — A weathered oak stool with a worn leather cushion'));
  assert.ok(animLine, 'animated decor Item line must be present');
  assert.ok(animLine?.endsWith(' — A slow-turning ceiling fan with brass blades'));
  assert.doesNotMatch(baseline, /A weathered oak stool/);
  assert.doesNotMatch(baseline, /A slow-turning ceiling fan/);
});

test('buildBackgroundDecorPrompt appends an Appearance line to the projectile row when projectileDescription is supplied, byte-identical without it', () => {
  const rows = createDecorBoardRows(decorSpecs());
  const baseline = buildBackgroundDecorPrompt('cozy tavern', 'Tavern', rows);
  const omittedParam = buildBackgroundDecorPrompt('cozy tavern', 'Tavern', rows, 'magenta');
  const explicitUndefined = buildBackgroundDecorPrompt('cozy tavern', 'Tavern', rows, 'magenta', undefined);
  assert.equal(omittedParam, baseline);
  assert.equal(explicitUndefined, baseline);
  assert.doesNotMatch(baseline, /Appearance — depict this exact design/);
  // Row 4 (the projectile FX) is present regardless of whether a description was supplied.
  assert.match(baseline, /Row 4 \(Cells 13-16\): the themed RANGED-WEAPON-FIRE projectile/i);

  const described = buildBackgroundDecorPrompt(
    'cozy tavern', 'Tavern', rows, 'magenta',
    'a crackling blue energy bolt with a trailing spark tail',
  );
  assert.match(described, /Appearance — depict this exact design: a crackling blue energy bolt with a trailing spark tail/);
  assert.match(described, /Row 4 \(Cells 13-16\): the themed RANGED-WEAPON-FIRE projectile/i);
  assert.doesNotMatch(baseline, /a crackling blue energy bolt/);
  assert.notEqual(described, baseline);
});
