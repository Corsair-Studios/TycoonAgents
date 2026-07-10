import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAchievementAtlasPrompt,
  buildBackgroundDecorPrompt,
  buildCharacterAtlasPrompt,
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
  OBJECT_POOF_FRAME_COUNT,
  OBJECT_STATIC_COUNT,
  rivalBoardFrameKeys,
  RIVALS_PER_BOARD,
} from '../src/extension/themeAssetPrompts';

/** No magenta wording of any kind should survive in a 'transparent'-mode prompt. */
function assertNoMagenta(prompt: string): void {
  assert.doesNotMatch(prompt, /magenta/i);
  assert.doesNotMatch(prompt, /#FF00FF/i);
}

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
  assert.match(prompt, /2-frame side-view WALK cycle/i);
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
  assert.equal(CHARACTER_TARGET_CONTENT_HEIGHT, 104);
  assert.equal(CHARACTER_TARGET_CONTENT_PERCENT, 72);
  assert.match(prompt, /complete character from head to feet occupies exactly 72% of the cell height/i);
  assert.match(prompt, /72% against each individual cell/i);
  assert.match(prompt, /below 68% or above 76%.*incorrect result/i);
  assert.match(prompt, /Do not leave oversized magenta margins/i);
  assert.match(prompt, /visible magenta gutter at every horizontal row boundary/i);
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

test('aggregate prompts define the two-board object layout, 7 expressions, and 20 badges', () => {
  const board1Rows = createObjectBoard1Rows(staticObjectSpecs(OBJECT_STATIC_COUNT));
  const objects = buildObjectAtlasPrompt('industrial', 'Factory', board1Rows);
  assert.match(objects, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(objects, /4-column by 5-row grid of 20 equal cells/i);
  assert.match(objects, /Cell 20: Object 20/i);
  assert.match(objects, /20 distinct STATIC buildable objects/i);
  assert.match(objects, /never touch the cell's bottom edge/i);
  assert.match(objects, /fills about 75% of its cell's height/i);
  assert.match(objects, /unbroken gutter along EVERY horizontal row boundary/i);
  assert.match(objects, /2:1 pixel-art isometric interior view/i);
  assert.match(objects, /front CORNER \(not a flat face\) pointing toward the viewer/i);
  assert.match(objects, /naturally TALL object.*must be SCALED DOWN to fit entirely inside the cell/i);

  const board2Rows = createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT));
  const board2 = buildObjectAtlasPrompt('industrial', 'Factory', board2Rows);
  assert.match(board2, /4-column by 5-row grid of 20 equal cells/i);
  assert.match(board2, /Row 1 \(Cells 1-4\).*Animated Object 1/i);
  assert.match(board2, /Row 2 \(Cells 5-8\).*Animated Object 2/i);
  assert.match(board2, /Cells 9-15.*SEVEN-frame one-shot build-completion POOF/i);
  assert.match(board2, /Cells 16-19.*EMPTY/i);
  assert.match(board2, /Cell 20.*CRATE/i);
  assert.match(board2, new RegExp(`${OBJECT_POOF_FRAME_COUNT}-frame one-shot reveal`, 'i'));

  const expressions = buildExpressionAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 7 }, (_unused, index) => `Expression ${index + 1}`),
  );
  assert.match(expressions, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(expressions, /4-column by 2-row grid of 8 equal cells/i);
  assert.match(expressions, /Cell 7: Expression 7/);

  const achievements = buildAchievementAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 20 }, (_unused, index) => `Badge ${index + 1}`),
  );
  assert.match(achievements, /outer image canvas is one perfect SQUARE \(1:1 aspect ratio\)/i);
  assert.match(achievements, /5-column by 4-row grid of 20 equal cells/i);
  assert.match(achievements, /Cell 20: Badge 20/);
  assert.match(achievements, /do not include unlock requirements/i);
});

test('object board 1 prompt emits explicit ranged-rack guidance for cell 1 and generic guidance elsewhere', () => {
  const specs = staticObjectSpecs(OBJECT_STATIC_COUNT);
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

test('object board 1 prompt requires exactly OBJECT_STATIC_COUNT cells', () => {
  assert.throws(
    () => buildObjectAtlasPrompt('industrial', 'Factory', createObjectBoard1Rows(staticObjectSpecs(OBJECT_STATIC_COUNT)).slice(0, 5)),
    /exactly 20 static-object cells/,
  );
});

test('object board 2 prompt threads per-object motion hints and falls back to the generic default', () => {
  const rows = createObjectBoard2Rows([
    { object_id: 'radar', display_name: 'Radar Dish', motion_hint: 'radar dish slowly rotates' },
    { object_id: 'core', display_name: 'Reactor Core' },
  ]);
  const prompt = buildObjectAtlasPrompt('sci-fi', 'Orbital', rows);
  assert.match(prompt, /Row 1 \(Cells 1-4\): the four sequential animation frames of ONE object — Radar Dish — radar dish slowly rotates/i);
  assert.match(prompt, /Row 2 \(Cells 5-8\): the four sequential animation frames of a SECOND object — Reactor Core — invent one subtle functional motion/i);
  // The shared lights/highlights-only animation constraint is reused for BOTH rows.
  assert.equal((prompt.match(/Permitted animation is limited STRICTLY to lights and subtle highlights/gi) ?? []).length, 2);
});

test('createObjectBoard1Rows carries is_ranged_rack and motion_hint onto the object cells, and requires exactly OBJECT_STATIC_COUNT objects', () => {
  const specs = staticObjectSpecs(OBJECT_STATIC_COUNT).map((spec, index) => ({
    ...spec,
    ...(index === 0 ? { is_ranged_rack: true } : {}),
    ...(index === 1 ? { motion_hint: 'gently hums' } : {}),
  }));
  const rows = createObjectBoard1Rows(specs);
  assert.equal(rows.length, OBJECT_STATIC_COUNT);
  assert.ok(rows.every((row) => row.kind === 'object_static'));
  const rackRow = rows[0];
  assert.equal(rackRow.kind === 'object_static' ? rackRow.is_ranged_rack : undefined, true);
  const hintRow = rows[1];
  assert.equal(hintRow.kind === 'object_static' ? hintRow.motion_hint : undefined, 'gently hums');

  assert.throws(() => createObjectBoard1Rows(staticObjectSpecs(19)), /exactly 20 static objects/);
  assert.throws(() => createObjectBoard1Rows(staticObjectSpecs(21)), /exactly 20 static objects/);
});

test('createObjectBoard2Rows returns [animA, animB, poof, crate] and requires exactly OBJECT_ANIMATED_COUNT animated objects', () => {
  const rows = createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT));
  assert.deepEqual(rows.map((row) => row.kind), ['object_anim', 'object_anim', 'poof', 'crate']);
  assert.deepEqual(objectBoardFrameKeys(rows), ['object_anim_1', 'object_anim_2', 'poof', 'crate']);

  assert.throws(() => createObjectBoard2Rows(animatedObjectSpecs(1)), /exactly 2 animated objects/);
  assert.throws(() => createObjectBoard2Rows(animatedObjectSpecs(3)), /exactly 2 animated objects/);
});

test('objectBoardFrameKeys yields one object_<id> key per cell for board 1 (20 static objects)', () => {
  const rows = createObjectBoard1Rows(staticObjectSpecs(OBJECT_STATIC_COUNT));
  const keys = objectBoardFrameKeys(rows);
  assert.equal(keys.length, OBJECT_STATIC_COUNT);
  assert.deepEqual(keys.slice(0, 3), ['object_object_1', 'object_object_2', 'object_object_3']);
  assert.equal(keys[keys.length - 1], 'object_object_20');
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
  assert.match(prompt, /Creative direction: cozy tavern/i);
});

// --- 'transparent' background mode (OpenAI native alpha) ---------------------
// Every builder defaults to 'magenta' so the assertions above stay valid
// unchanged. Passing 'transparent' must swap every magenta directive for an
// equivalent alpha-transparency directive, and leave zero "magenta"/#FF00FF
// mentions anywhere in the prompt.

test('character prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const prompt = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid', 'transparent');
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
  assert.match(prompt, /tool always swings through empty transparent space/i);
  assert.match(prompt, /Do not leave oversized transparent margins/i);
  assert.match(prompt, /visible transparent gutter at every horizontal row boundary/i);
});

test('rival prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const boards = createRivalBoardRows(rivalSpecs());
  const prompt = buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', boards[0], 'transparent');
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
  assert.match(prompt, /swings\/lunges through empty transparent space/i);
});

test('object board 1 prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const rows = createObjectBoard1Rows(staticObjectSpecs(OBJECT_STATIC_COUNT));
  const prompt = buildObjectAtlasPrompt('industrial', 'Factory', rows, 'transparent');
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
});

test('object board 2 prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const rows = createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT));
  const prompt = buildObjectAtlasPrompt('industrial', 'Factory', rows, 'transparent');
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
});

test('background decor prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const prompt = buildBackgroundDecorPrompt('cozy tavern', 'Tavern', createDecorBoardRows(decorSpecs()), 'transparent');
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
  assert.match(prompt, /NO anti-aliasing/i);
  assert.doesNotMatch(prompt, /never tint any subject pixel with the background magenta/i);
});

test('expression prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const prompt = buildExpressionAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 7 }, (_unused, index) => `Expression ${index + 1}`),
    'transparent',
  );
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
  assert.match(prompt, /fully transparent background/i);
});

test('achievement prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const prompt = buildAchievementAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 20 }, (_unused, index) => `Badge ${index + 1}`),
    'transparent',
  );
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
});

test('emote prompt in transparent mode has an alpha directive and zero magenta mentions', () => {
  const prompt = buildEmoteAtlasPrompt('industrial', 'Factory', 'transparent');
  assertNoMagenta(prompt);
  assert.match(prompt, /fully transparent \(alpha 0\)/i);
});

test('environment prompt is unaffected by background mode (it has no chroma keying)', () => {
  // buildEnvironmentPrompt never accepted a background-mode parameter, by design:
  // the environment board uses a cyan silhouette guide, not magenta/transparent
  // sprite keying, so it is out of scope for this feature.
  const prompt = buildEnvironmentPrompt('neon cyberpunk', 'Night Grid');
  assert.match(prompt, /cyan \(#00FFFF\)/i);
  assert.doesNotMatch(prompt, /magenta/i);
});
