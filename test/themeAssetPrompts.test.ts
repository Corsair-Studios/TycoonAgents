import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAchievementAtlasPrompt,
  buildBackgroundDecorPrompt,
  buildCharacterAtlasPrompt,
  buildEnvironmentPrompt,
  buildExpressionAtlasPrompt,
  buildObjectAtlasPrompt,
  CHARACTER_TARGET_CONTENT_HEIGHT,
  CHARACTER_TARGET_CONTENT_PERCENT,
  buildRivalAtlasPrompt,
  createDecorBoardRows,
  createObjectBoardRows,
  createRivalBoardRows,
  decorBoardFrameKeys,
  objectBoardFrameKeys,
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

test('createRivalBoardRows rejects a roster that is not exactly 12', () => {
  assert.throws(() => createRivalBoardRows(rivalSpecs().slice(0, 11)));
});

test('rivalBoardFrameKeys yields one rival_<id> key per enemy row', () => {
  const boards = createRivalBoardRows(rivalSpecs());
  assert.deepEqual(rivalBoardFrameKeys(boards[0]), ['rival_r_1', 'rival_r_2', 'rival_r_3', 'rival_r_4']);
});

test('rival prompt is a 5x4 compact board with 3-frame walk + 2-frame attack per enemy row', () => {
  const boards = createRivalBoardRows(rivalSpecs());
  const prompt = buildRivalAtlasPrompt('gritty wasteland', 'Rust Valley', boards[0]);
  assert.match(prompt, /512 x 512 pixels \(1:1\)/i);
  assert.match(prompt, /5-column by 4-row logical grid with 20 visually equal cells/i);
  assert.match(prompt, /3-frame side-view WALK cycle/i);
  assert.match(prompt, /2-frame ATTACK/i);
  assert.match(prompt, /Row 1 \(Cells 1-5\): the enemy \*\*"Rival 1"\*\*/i);
  assert.match(prompt, /Row 4 \(Cells 16-20\): the enemy \*\*"Rival 4"\*\*/i);
  assert.match(prompt, /flips? cleanly/i);
});

test('character prompt enforces the production sprite-board mime contracts', () => {
  const prompt = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid');
  assert.match(prompt, /EXACT SAME character[\s\S]*\*\*"Nova"\*\* from the \*\*Night Grid\*\* theme/i);
  assert.match(prompt, /exact \*\*5-column by 4-row grid\*\* containing \*\*20 equal-sized cells\*\*/i);
  assert.match(prompt, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(prompt, /TOOL HANDLING ANIMATION[\s\S]*tool always swings through empty magenta space/i);
  assert.match(prompt, /INVISIBLE CHAIR CONTRACT \(ABSOLUTE\)[\s\S]*support is completely invisible/i);
  assert.match(prompt, /EMPTY TARGET CONTRACT \(HIGHEST PRIORITY\)[\s\S]*No construction result/i);
  assert.match(prompt, /playful, non-graphic, non-contact actions/i);
  assert.equal(CHARACTER_TARGET_CONTENT_HEIGHT, 104);
  assert.equal(CHARACTER_TARGET_CONTENT_PERCENT, 81.25);
  assert.match(prompt, /complete character from head to feet occupies exactly 81\.25% of the cell height/i);
  assert.match(prompt, /81\.25% against each individual cell/i);
  assert.match(prompt, /below 78% or above 85%.*incorrect result/i);
  assert.match(prompt, /Do not leave oversized magenta margins/i);
  assert.match(prompt, /visible magenta gutter at every horizontal row boundary/i);
  assert.match(prompt, /safety padding below both feet/i);
  assert.doesNotMatch(prompt, /Melee strike|Ranged fire/i);
  assert.match(prompt, /solid \*\*#FF00FF\*\*/i);
  assert.match(prompt, /Theme: Night Grid[\s\S]*neon cyberpunk/i);
  assert.doesNotMatch(prompt, /Circuit Broker|Cyberpunk 2049/i);
  assert.doesNotMatch(prompt, /place\/build object|inspect finished work/i);
});

test('environment prompt treats the reference as an opaque geometry guide', () => {
  const prompt = buildEnvironmentPrompt('neon cyberpunk', 'Night Grid');
  assert.match(prompt, /OPAQUE GEOMETRY GUIDE/);
  assert.match(prompt, /OUTSIDE THE ASSET.*cyan \(#00FFFF\)/i);
  assert.match(prompt, /exact outer hexagonal stage silhouette/i);
  assert.match(prompt, /No characters/i);
});

test('aggregate prompts define animated object rows, 16 expressions, and 20 badges', () => {
  const objects = buildObjectAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 5 }, (_unused, index) => ({
      kind: 'object' as const,
      object_id: `object_${index + 1}`,
      display_name: `Object ${index + 1}`,
    })),
  );
  assert.match(objects, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(objects, /exact 4-column by 5-row logical grid with 20 visually equal cells/i);
  assert.match(objects, /Row 5: OBJECT — Object 5/i);
  assert.match(objects, /four sequential animation frames/i);
  assert.match(objects, /do not hold or duplicate frames/i);

  const finalObjects = buildObjectAtlasPrompt('industrial', 'Factory', [
    ...Array.from({ length: 3 }, (_unused, index) => ({
      kind: 'object' as const,
      object_id: `object_${index + 11}`,
      display_name: `Object ${index + 11}`,
    })),
    { kind: 'poof' as const },
    { kind: 'crate' as const },
  ]);
  assert.match(finalObjects, /Row 4: POOF/i);
  assert.match(finalObjects, /Row 5: CRATE/i);
  assert.match(finalObjects, /Cells 2–4 must remain entirely flat magenta/i);

  const expressions = buildExpressionAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 16 }, (_unused, index) => `Expression ${index + 1}`),
  );
  assert.match(expressions, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(expressions, /exact 4-column by 4-row logical grid with 16 visually equal cells/i);
  assert.match(expressions, /Cell 16: Expression 16/);

  const achievements = buildAchievementAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 20 }, (_unused, index) => `Badge ${index + 1}`),
  );
  assert.match(achievements, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(achievements, /exact 5-column by 4-row logical grid with 20 visually equal cells/i);
  assert.match(achievements, /Cell 20: Badge 20/);
  assert.match(achievements, /do not include unlock requirements/i);
});

test('object prompt emits explicit ranged-rack guidance and per-object motion hints', () => {
  const prompt = buildObjectAtlasPrompt('sci-fi', 'Orbital', [
    { kind: 'object' as const, object_id: 'rack', display_name: 'Laser Rifle Rack', is_ranged_rack: true },
    { kind: 'object' as const, object_id: 'radar', display_name: 'Radar Dish', motion_hint: 'radar dish slowly rotates' },
    { kind: 'object' as const, object_id: 'core', display_name: 'Reactor Core' },
    { kind: 'poof' as const },
    { kind: 'crate' as const },
  ]);
  // Rack row (row 1) gets the dedicated ranged-weapon guidance, not the generic default.
  assert.match(prompt, /Row 1: OBJECT — Laser Rifle Rack — a wall- or floor-mounted rack\/stand displaying several themed RANGED weapons/i);
  assert.match(prompt, /clearly readable as ranged weapons — NOT a crate, shelf, or melee weapons/i);
  // Per-object motion hint is threaded verbatim for a non-rack row.
  assert.match(prompt, /Row 2: OBJECT — Radar Dish — radar dish slowly rotates/i);
  // Missing hint falls back to the generic default.
  assert.match(prompt, /Row 3: OBJECT — Reactor Core — invent one subtle functional motion/i);
});

test('createObjectBoardRows carries is_ranged_rack and motion_hint onto the object rows', () => {
  const rows = createObjectBoardRows(Array.from({ length: 13 }, (_unused, index) => ({
    object_id: `object_${index + 1}`,
    display_name: `Object ${index + 1}`,
    ...(index === 0 ? { is_ranged_rack: true } : {}),
    ...(index === 1 ? { motion_hint: 'gently hums' } : {}),
  })));
  const rackRow = rows[0][0];
  assert.equal(rackRow.kind, 'object');
  assert.equal(rackRow.kind === 'object' ? rackRow.is_ranged_rack : undefined, true);
  const hintRow = rows[0][1];
  assert.equal(hintRow.kind === 'object' ? hintRow.motion_hint : undefined, 'gently hums');
});

test('13 objects pack into three full boards with build effects in the final two rows', () => {
  const rows = createObjectBoardRows(Array.from({ length: 13 }, (_unused, index) => ({
    object_id: `object_${index + 1}`,
    display_name: `Object ${index + 1}`,
  })));
  assert.deepEqual(rows.map((board) => board.length), [5, 5, 5]);
  assert.deepEqual(rows.map((board) => board.map((row) => row.kind)), [
    ['object', 'object', 'object', 'object', 'object'],
    ['object', 'object', 'object', 'object', 'object'],
    ['object', 'object', 'object', 'poof', 'crate'],
  ]);
  assert.deepEqual(objectBoardFrameKeys(rows[2]), [
    'object_object_11', 'object_object_12', 'object_object_13', 'poof', 'crate',
  ]);
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
  assert.match(prompt, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(prompt, /exact 4-column by 4-row logical grid with 16 visually equal cells/i);
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
  assert.match(prompt, /Creative direction: cozy tavern/i);
});
