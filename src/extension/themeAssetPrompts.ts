import type { ThemeDecorBoardRow, ThemeObjectBoardRow, ThemeRivalBoardRow } from './themeImageReviewState';

/**
 * Board background fill mode. 'magenta' is the legacy #FF00FF chroma-key
 * contract (the only format Gemini/"nano banana" can produce, since it can't
 * emit alpha). 'transparent' asks for true alpha-0 pixels, used only when the
 * OpenAI provider (gpt-image-1/2, which supports native transparent
 * backgrounds) will run the generation. Defaults to 'magenta' everywhere so
 * existing callers and tests keep their current behavior unless they opt in.
 */
export type BoardBackgroundMode = 'magenta' | 'transparent';

/**
 * The strong closing "every unused pixel" directive shared by the rival and
 * background-decor board prompts (character/boardContract use their own
 * slightly different phrasing to match surrounding markdown/emphasis).
 */
function finalUnusedPixelSentence(background: BoardBackgroundMode): string {
  return background === 'transparent'
    ? 'Every unused pixel must be fully transparent (alpha 0). Do not paint any background color, checkerboard pattern, or solid fill in unused areas.'
    : 'Every unused pixel must be flat solid #FF00FF magenta.';
}

/**
 * Adjective phrase for "___ padding" used outside this module (themeService's
 * character-normalize retry notes), so freeform revision text stays
 * consistent with whichever background mode the original board was baked with.
 */
export function boardBackgroundPaddingAdjective(background: BoardBackgroundMode): string {
  return background === 'transparent' ? 'fully transparent' : 'solid-magenta';
}

export interface ThemeRivalPromptSpec {
  rival_id: string;
  display_name: string;
}

export interface ThemeObjectPromptSpec {
  object_id: string;
  display_name: string;
  /** Short per-object idle-motion phrase supplied by the planner (e.g. "radar dish slowly rotates"). */
  motion_hint?: string;
  /**
   * Build_order 0 is the themed ranged-weapon rack (see themePlan.ts). When true,
   * the object row emits explicit rack visual guidance instead of the generic template.
   */
  is_ranged_rack?: boolean;
}

export interface ThemeDecorPromptSpec {
  decor_id: string;
  display_name: string;
}

/** Number of rows packed onto one 4x5 animated-object board. */
export const OBJECT_ROWS_PER_BOARD = 5;

export function createObjectBoardRows(objects: ThemeObjectPromptSpec[]): ThemeObjectBoardRow[][] {
  if (objects.length < 1) throw new Error('Object generation requires at least one object.');
  const asRows = (items: ThemeObjectPromptSpec[]): ThemeObjectBoardRow[] => items.map((object) => ({
    kind: 'object',
    object_id: object.object_id,
    display_name: object.display_name,
    ...(object.motion_hint ? { motion_hint: object.motion_hint } : {}),
    ...(object.is_ranged_rack ? { is_ranged_rack: true } : {}),
  }));
  const flatRows: ThemeObjectBoardRow[] = [...asRows(objects), { kind: 'poof' }, { kind: 'crate' }];
  const boards: ThemeObjectBoardRow[][] = [];
  for (let start = 0; start < flatRows.length; start += OBJECT_ROWS_PER_BOARD) {
    boards.push(flatRows.slice(start, start + OBJECT_ROWS_PER_BOARD));
  }
  return boards;
}

export function objectBoardFrameKeys(rows: ThemeObjectBoardRow[]): string[] {
  return rows.map((row) => row.kind === 'object' ? `object_${row.object_id}` : row.kind);
}

/**
 * Map the 9 decor specs onto the 4x4 background-decor board's four row-groups:
 *   row 1 → four single-frame seats,
 *   row 2 → four single-frame static decor,
 *   row 3 → one four-frame animated decor,
 *   row 4 → the ranged-weapon-fire projectile FX (four one-shot frames; not decor).
 * Returns one array per row so the slicer knows each row's kind/ids.
 */
export function createDecorBoardRows(decor: ThemeDecorPromptSpec[]): ThemeDecorBoardRow[][] {
  if (decor.length !== 9) throw new Error('Background decor generation requires exactly 9 decor items.');
  const seats = decor.slice(0, 4).map((item): ThemeDecorBoardRow => ({
    kind: 'seat', decor_id: item.decor_id, display_name: item.display_name,
  }));
  const statics = decor.slice(4, 8).map((item): ThemeDecorBoardRow => ({
    kind: 'decor', decor_id: item.decor_id, display_name: item.display_name,
  }));
  const anim: ThemeDecorBoardRow = {
    kind: 'decor_anim', decor_id: decor[8].decor_id, display_name: decor[8].display_name,
  };
  const projectile: ThemeDecorBoardRow = { kind: 'projectile' };
  return [seats, statics, [anim], [projectile]];
}

/**
 * Frame keys for the decor board rows: decor cells use `decor_<id>`; the row-4
 * projectile FX uses the fixed `projectile` key.
 */
export function decorBoardFrameKeys(rows: ThemeDecorBoardRow[][]): string[] {
  return rows.flat().map((row) => row.kind === 'projectile' ? 'projectile' : `decor_${row.decor_id}`);
}

/** Number of enemy rows packed onto one 5x4 rival board (one enemy per row). */
export const RIVALS_PER_BOARD = 4;

/**
 * Pack rivals onto 5x4 boards, up to four rivals per board (ceil(N/4) boards; each ROW is one
 * enemy: cols 0-2 = 3-frame walk, cols 3-4 = 2-frame attack). Returns one array of
 * up to four rival rows per board.
 */
export function createRivalBoardRows(rivals: ThemeRivalPromptSpec[]): ThemeRivalBoardRow[][] {
  if (rivals.length < 1) throw new Error('Rival generation requires at least one rival.');
  const boards: ThemeRivalBoardRow[][] = [];
  for (let start = 0; start < rivals.length; start += RIVALS_PER_BOARD) {
    boards.push(rivals.slice(start, start + RIVALS_PER_BOARD).map((rival): ThemeRivalBoardRow => ({
      kind: 'rival',
      rival_id: rival.rival_id,
      display_name: rival.display_name,
    })));
  }
  return boards;
}

/** Frame keys for one rival board's rows: each enemy row → `rival_<id>` (five frames). */
export function rivalBoardFrameKeys(rows: ThemeRivalBoardRow[]): string[] {
  return rows.map((row) => `rival_${row.rival_id}`);
}

/**
 * Compact rival board: a 5-column x 4-row grid (20 cells) packing up to FOUR enemies,
 * one per ROW. Cols 1-2 are a 2-frame side-view WALK cycle; cols 3-5 are a 3-frame ATTACK.
 * Enemies only need WALK + ATTACK, so a full 20-cell character atlas would be wasteful.
 */
export function buildRivalAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  rows: ThemeRivalBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): string {
  if (rows.length < 1 || rows.length > RIVALS_PER_BOARD) {
    throw new Error('Rival boards carry one to four enemy rows.');
  }
  const rowLines = rows.map((row, index) =>
    `Row ${index + 1} (Cells ${index * 5 + 1}-${index * 5 + 5}): the enemy **"${row.display_name}"** from the "${themeName}" theme.`,
  );
  const spaceWord = background === 'transparent' ? 'transparent' : 'magenta';
  return [
    `Create one compact rival (enemy) sprite board for the "${themeName}" theme.`,
    boardContract(5, rows.length, background),
    `Each of the ${rows.length} ROWS is ONE distinct named enemy, shown as a 5-frame mini-atlas:`,
    '  Cells 1-2 of the row: a 2-frame side-view WALK cycle (cell 1 = contact pose, cell 2 = passing/opposite pose) that loops seamlessly cell 2 back to cell 1 — same enemy, only the limbs move.',
    '  Cells 3-5 of the row: a 3-frame ATTACK — cell 3 is the wind-up/anticipation, cell 4 is the strike/lunge (peak), cell 5 is the recovery/settle.',
    ...rowLines,
    '',
    'Keep each enemy identical across its own five cells: identical face, body, costume, colors, equipment, rendering style, and pixel scale — change only the pose.',
    'The first frame of each row (the walk-contact pose in cell 1) defines that enemy\'s horizontal center, ground-contact baseline, and overall body scale. Every later frame in the same row keeps that same horizontal center, the same feet baseline, and the same overall body scale. Limbs, pose, and expression may change freely between frames, but the whole body must never slide, re-center, or change size across the row — walking and running are animated IN PLACE, exactly as the game itself moves the sprite across the screen. An enemy that drifts, re-centers, or changes scale between frames of the same row is an incorrect result.',
    'Use one consistent side / three-quarter camera for every enemy so the walk and attack read clearly and the sprite flips cleanly left-to-right.',
    `The attack is a playful, non-graphic, non-contact motion suitable for a general-audience video game: the enemy swings/lunges through empty ${spaceWord} space and never touches another subject.`,
    'On ranged-attack frames, do NOT draw any muzzle flash, gunfire, muzzle smoke, tracer, projectile, spark, or weapon-discharge effect. Show only the enemy\'s firing pose and recoil — the projectile is rendered separately by the game, so a drawn flash is wrong and must be omitted.',
    `The ENTIRE weapon — including any melee blade, sword, swing arc, gun barrel, or muzzle — must stay fully INSIDE the enemy's own cell with clear ${spaceWord} padding on every side. No part of the weapon, blade, swing arc, or effect may extend to the cell edge or cross into an adjacent cell in ANY frame, including the strike/lunge peak (cell 4). If a swing would reach the cell boundary, shorten or angle it so it stays within the cell.`,
    `Center each enemy in its cell with its feet just above the cell bottom (leave a thin strip of empty ${spaceWord} background below the feet — never touching the cell's bottom edge) and generous ${spaceWord} padding; nothing crosses a cell boundary.`,
    `Use crisp retro pixel art. ${finalUnusedPixelSentence(background)}`,
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

/**
 * Production character scale calibrated from the approved reference character
 * boards (101px, 104px, and 107px median reference heights respectively).
 * Their combined median is 104px in a 128px frame.
 *
 * These two constants describe two different stages of the same pipeline and are
 * deliberately NOT equal:
 *   - CHARACTER_TARGET_CONTENT_PERCENT is the generation-time target sent to the
 *     image model (the prompt below). It is kept comfortably below 100% so a
 *     generated character has headroom and never clips at the cell edge.
 *   - CHARACTER_TARGET_CONTENT_HEIGHT is the slicer-time normalization target: once
 *     a board comes back, the production slicer uniformly rescales every
 *     character's content up to this pixel height inside the 128px cell.
 * Do not change either value without re-checking this relationship: PERCENT must
 * stay comfortably below (HEIGHT / 128) * 100, otherwise the generation target would
 * exceed — or leave no headroom under — the slicer's normalization target.
 */
export const CHARACTER_TARGET_CONTENT_HEIGHT = 104;
export const CHARACTER_TARGET_CONTENT_PERCENT = 72;

function boardContract(columns: number, rows: number, background: BoardBackgroundMode = 'magenta'): string {
  // Geometry is stated in canvas FRACTIONS, not absolute pixels: image models
  // return whatever resolution the API grants (e.g. 1024x1024), so any pixel
  // number we state is a lie at generation time and gets ignored or, worse,
  // followed at the wrong scale. Fractions stay true at every resolution.
  const shapePhrase = columns === rows
    ? 'a perfect square'
    : columns < rows
      ? `wider than it is tall (about ${(rows / columns).toFixed(2)}:1)`
      : `taller than it is wide (about ${(columns / rows).toFixed(2)}:1)`;
  return [
    'The outer image canvas is one perfect SQUARE (1:1 aspect ratio). Do not crop or change the canvas aspect ratio.',
    `Divide the full canvas into an exact ${columns}-column by ${rows}-row grid of ${columns * rows} equal cells: every cell is exactly 1/${columns} of the canvas width wide and 1/${rows} of the canvas height tall.`,
    `Each cell is ${shapePhrase}; compose every subject to fit that cell shape.`,
    'Keep every subject fully inside its own cell with clear empty padding on ALL FOUR sides — top, bottom, left, and right. The subject must never touch or cross any cell edge; anything drawn past a cell boundary is sliced off flat by the game, so a subject that touches its cell\'s bottom edge is an incorrect result.',
    'Do not draw grid lines, labels, numbers, captions, borders, scenery, shadows, or extra subjects.',
    'Do NOT draw any box, frame, border, panel, card, plate, rounded rectangle, colored backdrop, vignette, sticker outline, or containing shape around or behind ANY subject. Each subject sits directly on the flat background with nothing framing, enclosing, or backing it. The background is ONE single uniform color filling the ENTIRE canvas edge to edge — identical behind every subject and in all padding — never a per-subject colored tile or panel.',
    background === 'transparent'
      ? 'Paint every unused pixel fully transparent (alpha 0) — no texture, gradient, or background fill of any kind.'
      : 'Paint every unused pixel solid #FF00FF magenta with no texture or gradient.',
    background === 'transparent'
      ? 'Render every subject with crisp, hard pixel-art edges: NO anti-aliasing, feathering, glow, or soft blending where the subject meets the background. Every edge pixel is either fully subject-colored or fully transparent — never a blend. Give each subject a clean solid dark outline.'
      : 'Render every subject with crisp, hard pixel-art edges: NO anti-aliasing, feathering, glow, or soft blending where the subject meets the background. Every edge pixel is either fully subject-colored or fully background — never a blend. Give each subject a clean solid dark outline, and never tint any subject pixel with the background magenta.',
  ].join('\n');
}

export function buildCharacterAtlasPrompt(
  creativeDirection: string,
  characterName: string,
  themeName: string,
  background: BoardBackgroundMode = 'magenta',
): string {
  const spaceWord = background === 'transparent' ? 'transparent' : 'magenta';
  return [
    'Create one production sprite board, not a poster, illustration, concept sheet, or character lineup.',
    '',
    'The outer image canvas is one perfect SQUARE (1:1 aspect ratio). Do not crop the canvas to the 5:4 grid bounds.',
    'Inside that square canvas is an exact **5-column by 4-row grid** containing **20 equal-sized cells**.',
    '',
    'Every character must remain completely inside its own cell with generous empty padding on all sides. Nothing may cross cell boundaries.',
    '',
    'Do NOT draw:',
    '',
    '* grid lines',
    '* labels',
    '* numbers',
    '* captions',
    '* borders',
    '* scenery',
    '* backgrounds',
    '* floor shadows',
    '* props that are not explicitly requested',
    '* additional characters',
    '* UI elements',
    '* speech bubbles',
    '',
    background === 'transparent'
      ? 'Every unused pixel on the canvas must be fully transparent (alpha 0) — no gradients, lighting, texture, fog, reflections, scenery, background color, or environmental effects.'
      : 'Every unused pixel on the canvas must be a perfectly flat solid **#FF00FF** magenta with no gradients, lighting, texture, fog, reflections, scenery, or environmental effects.',
    '',
    'Do NOT draw any box, frame, border, panel, card, plate, rounded rectangle, colored backdrop, vignette, sticker outline, or containing shape around or behind any character. Each character stands directly on the flat background with nothing framing, enclosing, or backing it — the background is ONE single uniform color/transparency filling the ENTIRE canvas edge to edge, identical behind every character and in all padding.',
    '',
    'Every cell contains the EXACT SAME character:',
    '',
    `**"${characterName}"** from the **${themeName}** theme.`,
    '',
    'Maintain absolute consistency across all 20 frames:',
    '',
    '* identical face',
    '* identical hairstyle',
    '* identical body proportions',
    '* identical costume',
    '* identical colors',
    '* identical equipment',
    '* identical rendering style',
    '* identical pixel scale',
    '* identical viewing angle',
    '',
    '# UNIVERSAL CHARACTER SCALE (STRICT)',
    '',
    'Character scale is a hard production-layout requirement, not a suggestion.',
    'Use the same camera distance and character scale used for every other character board in this theme.',
    `In walking and neutral-standing cells, the complete character from head to feet occupies exactly ${CHARACTER_TARGET_CONTENT_PERCENT}% of the cell height.`,
    `Measure that ${CHARACTER_TARGET_CONTENT_PERCENT}% against each individual cell, never against the full canvas.`,
    'A standing character below 68% or above 76% of its cell height is an incorrect result.',
    `Reserve the remaining approximately 28% as ${background === 'transparent' ? 'fully transparent' : 'solid-magenta'} safety padding split above the head and below the feet.`,
    `Keep a visible ${spaceWord} gutter at every horizontal row boundary and below the entire fourth row.`,
    `Do not leave oversized ${spaceWord} margins around a small character.`,
    'Do not zoom in or out based on the character costume, body type, equipment, or pose.',
    'Seated and action poses must preserve the same body scale as the standing poses; only the pose may change.',
    '',
    'Center the character horizontally within every cell.',
    '',
    `Standing poses must share a consistent baseline inside each cell, with visible ${spaceWord} safety padding below both feet.`,
    '',
    'Render as crisp retro pixel art using a consistent three-quarter / isometric viewpoint.',
    '',
    '---',
    '',
    '# CELL CONTRACT (STRICT)',
    '',
    'Follow this exact order.',
    '',
    '## Row 1 (Cells 1-5)',
    '',
    'Walk contact',
    '',
    'Walk passing',
    '',
    'Opposite contact',
    '',
    'Opposite passing',
    '',
    'Walk recovery',
    '',
    'Empty hands and no equipment.',
    '',
    '---',
    '',
    '## Row 2 (Cells 6-10)',
    '',
    'TOOL HANDLING ANIMATION',
    '',
    'Ready stance.',
    '',
    'Wind-up.',
    '',
    'Forward swing.',
    '',
    'Follow-through.',
    '',
    'Inspect handheld tool.',
    '',
    'This is NOT a construction scene.',
    '',
    'The character is only demonstrating tool use.',
    '',
    'The tool never touches anything visible.',
    '',
    `The tool always swings through empty ${spaceWord} space.`,
    '',
    '---',
    '',
    '## Row 3 (Cells 11-15)',
    '',
    'COMBAT SEQUENCE',
    '',
    'HARD RULE: this character never mixes melee and ranged in one frame. MELEE frames must show a bare fist or melee weapon (such as a blade or baton) and NO firearm or ranged weapon anywhere on the body. RANGED frames must show the firearm or ranged weapon and NO melee weapon and no punch or kick. Each frame is exactly ONE combat modality.',
    '',
    'Melee wind-up: coiled back for a melee attack (fist/elbow or a handheld melee weapon such as a blade or baton drawn back and loaded), weight on the back foot. No firearm anywhere.',
    '',
    'Melee strike: the melee attack at full forward extension (a committed punch, kick, or melee-weapon swing landing), weight driving through. No firearm anywhere.',
    '',
    'Ranged aim: raising a ranged weapon (firearm or energy weapon) and sighting along it at an unseen off-screen target, arms extended and steady. No melee weapon.',
    '',
    'Ranged fire: firing the ranged weapon — show body recoil and follow-through only. No melee weapon.',
    '',
    'Defensive block or dodge: a defensive beat — a braced raised guard/block, or dodging with a sharp sidestep or lean.',
    '',
    'These are playful, non-graphic, non-contact actions suitable for a general-audience video game. They show movement only and never depict contact with another subject.',
    '',
    'Do NOT draw a muzzle flash, gunfire, muzzle smoke, tracer, projectile, energy blast, spark, or discharge effect on the ranged-fire frame — show body recoil/follow-through only; the projectile is composited separately by the game.',
    '',
    `Keep the entire tool or weapon (barrel, blade, swing arc, muzzle) fully inside the character's cell with ${spaceWord} padding; it must never reach the cell edge or cross into an adjacent frame, including the melee-strike and ranged-fire frames.`,
    '',
    '---',
    '',
    '## Row 4 (Cells 16-20)',
    '',
    'Invisible-chair seated idle.',
    '',
    'Neutral standing idle.',
    '',
    'Dance step A.',
    '',
    'Dance step B.',
    '',
    'Victory pose.',
    '',
    '---',
    '',
    '# INVISIBLE CHAIR CONTRACT (ABSOLUTE)',
    '',
    'The seated pose is a MIME pose.',
    '',
    'The character must appear to be sitting on an invisible chair.',
    '',
    'The seated character faces to the right (screen-right), body and head oriented toward the right edge of the cell.',
    '',
    'The invisible chair is NOT drawn.',
    '',
    'The hips remain elevated above the floor exactly as though seated on a normal chair.',
    '',
    'The thighs are approximately horizontal.',
    '',
    'The knees are bent approximately 90 degrees.',
    '',
    'The lower legs point downward.',
    '',
    'The torso remains upright.',
    '',
    'The feet remain planted beneath the knees.',
    '',
    'The character is NOT sitting on the floor.',
    '',
    'The character is NOT kneeling.',
    '',
    'The character is NOT crouching.',
    '',
    'The character is NOT squatting.',
    '',
    'The character is NOT cross-legged.',
    '',
    'The character is NOT reclining.',
    '',
    'Do NOT draw:',
    '',
    '* chair',
    '* bench',
    '* stool',
    '* crate',
    '* rock',
    '* cushion',
    '* furniture',
    '* platform',
    '* box',
    '* seat',
    '* support object',
    '',
    'The support is completely invisible.',
    '',
    '---',
    '',
    '# MIME TOOL CONTRACT (ABSOLUTE)',
    '',
    'Construction animations are pantomimes.',
    '',
    'The character behaves exactly like a stage mime.',
    '',
    'Everything the tool interacts with is invisible.',
    '',
    'The animation represents body movement only.',
    '',
    'The construction target will be composited later during game development.',
    '',
    'Nothing may appear where the tool strikes.',
    '',
    '---',
    '',
    '# EMPTY TARGET CONTRACT (HIGHEST PRIORITY)',
    '',
    'The tool MUST NEVER contact any visible object.',
    '',
    'There is NOTHING in front of the tool.',
    '',
    'Do NOT draw:',
    '',
    '* walls',
    '* floors',
    '* beams',
    '* pipes',
    '* machinery',
    '* generators',
    '* robots',
    '* crates',
    '* barrels',
    '* workbenches',
    '* desks',
    '* tables',
    '* chairs',
    '* scaffolding',
    '* ladders',
    '* consoles',
    '* computers',
    '* monitors',
    '* holograms',
    '* blueprints',
    '* control panels',
    '* terminals',
    '* vehicles',
    '* rocks',
    '* trees',
    '* dirt',
    '* construction materials',
    '* repair targets',
    '* welding targets',
    '* partially completed objects',
    '* completed objects',
    '* anything being built',
    '',
    'If an object would normally exist, omit it completely.',
    '',
    background === 'transparent'
      ? 'The tool must terminate in empty fully-transparent space.'
      : 'The tool must terminate in empty #FF00FF magenta space.',
    '',
    'No visible object may ever touch the tool.',
    '',
    'No impact target.',
    '',
    'No construction result.',
    '',
    'No object interaction.',
    '',
    '---',
    '',
    '# ANIMATION RULES',
    '',
    'One complete character per cell.',
    '',
    'No duplicate characters.',
    '',
    'No detached limbs.',
    '',
    'No cropped body parts.',
    '',
    'No cropped equipment.',
    '',
    'No effects crossing into adjacent cells.',
    '',
    'Every frame must function as an independent animation sprite.',
    '',
    'Within each row, the first cell defines that character\'s horizontal center, ground-contact baseline, and overall body scale.',
    '',
    'Every later cell in that same row keeps the same horizontal center, the same feet baseline, and the same overall body scale.',
    '',
    'Limbs, pose, and facial expression may change freely from cell to cell within a row.',
    '',
    'The whole body must never slide sideways, re-center, or change size across a row.',
    '',
    'Walking and running are animated IN PLACE — the game itself moves the sprite across the screen.',
    '',
    'A character that slides, re-centers, or changes size between cells of the same row is an incorrect result.',
    '',
    '---',
    '',
    '# CREATIVE DIRECTION',
    '',
    `Theme: ${themeName}.`,
    '',
    creativeDirection,
    '',
    'Use dramatic lighting while preserving clean sprite readability.',
    '',
    'Maintain strong silhouettes suitable for game animation.',
    '',
    'Although the theme may imply a detailed environment, **do not render any part of the environment.**',
    '',
    'Characters only.',
    '',
    background === 'transparent'
      ? 'Every unused pixel remains fully transparent (alpha 0). Do not paint any background color.'
      : 'Every unused pixel remains solid **#FF00FF** magenta.',
  ].join('\n');
}

export function buildEnvironmentPrompt(
  creativeDirection: string,
  themeName: string,
): string {
  return [
    `Create a single isometric game-stage environment for the "${themeName}" theme.`,
    'The attached image is an OPAQUE GEOMETRY GUIDE, not an art-style reference.',
    'Preserve its portrait aspect ratio and exact outer hexagonal stage silhouette.',
    'The cyan region means OUTSIDE THE ASSET and must remain flat solid cyan (#00FFFF).',
    'Replace the purple/gray stage region with themed floor and rear-wall artwork, filling it all the way to the silhouette edges.',
    'Preserve a large, uncluttered, navigable floor in the center and lower portion. Put structural detail mainly at the rear/top edges.',
    'No characters, vehicles, UI, HUD, captions, logos, floating text, or square city-map composition.',
    'Do not extend scenery into the cyan area and do not change the silhouette.',
    'The final pipeline will chroma-key the outside region and enforce the silhouette mask.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

/** Five item rows on a 4x5 animated-object board. */
export function buildObjectAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  rows: ThemeObjectBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): string {
  if (rows.length < 1 || rows.length > 5) throw new Error('Object board carries one to five rows.');
  const rowLines = rows.map((row, index) => {
    if (row.kind === 'object') {
      if (row.is_ranged_rack) {
        return `Row ${index + 1}: OBJECT — ${row.display_name} — a wall- or floor-mounted rack/stand displaying several themed RANGED weapons (rifles, launchers, or bows appropriate to the setting), clearly readable as ranged weapons — NOT a crate, shelf, or melee weapons; subtle idle motion (a status light pulse or faint weapon gleam)`;
      }
      const motion = row.motion_hint
        ?? 'invent one subtle functional motion or light cycle that reads clearly across four loopable phases';
      return `Row ${index + 1}: OBJECT — ${row.display_name} — ${motion}`;
    }
    if (row.kind === 'poof') return `Row ${index + 1}: POOF — use the one-shot reveal rules below`;
    return `Row ${index + 1}: CRATE — use the static crate rules below`;
  });
  const hasPoof = rows.some((row) => row.kind === 'poof');
  const hasCrate = rows.some((row) => row.kind === 'crate');
  return [
    `Create one animated object sprite sheet for the "${themeName}" theme.`,
    boardContract(4, rows.length, background),
    `Treat the grid as ${rows.length} visually equal logical row bands stacked to fill the entire 512px canvas height; the production slicer distributes remainder pixels across row boundaries.`,
    `Each of the ${rows.length} ROWS contains the four sequential animation frames of exactly one listed item:`,
    ...rowLines,
    '',
    'OBJECT ROWS: all four cells show the same finished object from one fixed three-quarter/isometric camera.',
    'Keep the object body, contact point, scale, colors, and lighting identical. Change only moving or glowing parts.',
    'The object BODY MUST NOT move, shift, translate, rotate, resize, or reposition between the four frames. Every structural/body pixel stays in the EXACT same location in all four cells.',
    'Only lights, glows, screens, indicator lights, and the brightness or color of subtle highlights may change between frames — NO moving, rotating, or shifting parts of any kind (internal or external). The silhouette and footprint are pixel-identical across all four frames.',
    'Do NOT bob, sway, breathe, scale, or drift the object. Treat frames 1-4 as the identical object photographed from a locked camera, changing only its lights/color.',
    'The FIRST cell of an animation row defines the subject\'s exact position, outline, and footprint. Treat every later cell in that row as a near-copy of the first frame, redrawn with only small internal details changed.',
    'Across the frames of an animation row, the subject must stay locked in the identical position within each cell: same horizontal center, same baseline, same overall footprint. Animate through internal motion only (glow, flicker, moving parts, small secondary details) — never by shifting, sliding, or re-centering the whole subject between frames. The animation must be subtle: at least 95% of the subject\'s pixels stay identical from frame to frame, and its outline/silhouette is pixel-identical across the whole row. The animation is an EXTREMELY subtle ambient accent, not a focal point: at a glance the object should appear static, with motion only visible on close inspection. Use low-contrast changes — a faint glow swell, a dim blinking indicator, a slight flicker — never large flashing areas, strong color swings, fast motion, or high-contrast changes that pull the eye. A subject that shifts, slides, or sways side-to-side between frames is an incorrect result. An animation bold enough to draw attention away from the characters is an incorrect result.',
    'These are inanimate objects. The subject\'s width must be identical in every frame of the row — the leftmost and rightmost pixels of the subject stay in the same columns across all frames. Permitted animation is limited STRICTLY to lights and subtle highlights: emissive elements, glows, screens, and indicator lights may brighten, dim, flicker, or shift color, and existing highlights may subtly change brightness or hue. NOTHING structural moves — no rotating, tilting, wobbling, breathing, sliding, or resizing of the object or ANY of its parts, internal or external; the shape, outline, silhouette, position, footprint, and every structural pixel are pixel-identical in every frame. A subject whose width grows or shrinks between frames is an incorrect result.',
    'Every cell must be a distinct real generated frame; do not hold or duplicate frames.',
    'Make cell 4 flow seamlessly back to cell 1. Keep motion subtle and the body stationary.',
    'Center each object with its lowest contact point just above the cell bottom, leaving a clear strip of empty background (about 5% of the cell height) beneath it — the object must never touch the cell\'s bottom edge, or its base will be sliced off flat. Preserve relative scale across every board.',
    'Size every object to a strict height budget: it fills about 75% of its cell\'s height — a subject taller than 80% of its cell height is an incorrect result.',
    'When the board is complete, a continuous visible strip of empty background must separate every row and every column — check the finished image for an unbroken gutter along EVERY horizontal row boundary; any subject touching that gutter is drawn too large and is an incorrect result.',
    'A naturally TALL object (an antenna, tower, rack, mounted screen, or any top-heavy subject) must be SCALED DOWN to fit entirely inside the cell with its top and bottom margins intact — never stretch it to fill the cell height, and never let it reach the top or bottom edge to preserve height. Prefer a smaller, fully-contained object over a taller one that crowds or touches a boundary; compact staging beats height. A tall object that touches or crosses any cell edge is an incorrect result.',
    ...(hasPoof ? [
      '',
      'POOF ROW: a four-frame one-shot reveal, centered and large enough to cover a full object.',
      'Cell 1 begins as a small low smoke puff; cell 2 grows outward; cell 3 is full and opaque;',
      'cell 4 dissipates into faint wisps. Use neutral light-grey/white smoke with a subtle theme-color tint.',
    ] : []),
    ...(hasCrate ? [
      '',
      background === 'transparent'
        ? 'CRATE ROW: draw one closed themed shipping crate in cell 1. Cells 2–4 must remain entirely transparent.'
        : 'CRATE ROW: draw one closed themed shipping crate in cell 1. Cells 2–4 must remain entirely flat magenta.',
      'The crate is one static ready-to-build frame.',
    ] : []),
    '',
    'Use crisp retro pixel art with consistent viewpoint, lighting, rendering style, and camera distance.',
    'CAMERA (applies to every object identically, and MUST match the room/background it sits in): a classic 2:1 pixel-art isometric interior view — vertical lines stay perfectly vertical, all horizontal surfaces (tops, bases, panels, treads) recede along a shallow 2:1 diagonal (about 27 degrees), viewer looking down at about 30 degrees. Orient every object in three-quarter view with a front CORNER (not a flat face) pointing toward the viewer, so exactly two sides are visible and its top/base reads as a 2:1 diamond — the same way the room\'s floor and walls recede. Never draw an object flat-on, front-elevation, or in side-profile with a single face square to the camera — an object whose perspective does not match the room\'s isometric angle is an incorrect result.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

/**
 * Background-decor board: a 4x4 grid.
 * Row 1 = four distinct SITTABLE seats. Row 2 = four static scenery items.
 * Row 3 = one animated decor item across four loopable frames.
 * Row 4 = the themed ranged-weapon-fire projectile FX across four one-shot frames.
 */
export function buildBackgroundDecorPrompt(
  creativeDirection: string,
  themeName: string,
  rows: ThemeDecorBoardRow[][],
  background: BoardBackgroundMode = 'magenta',
): string {
  if (rows.length !== 4) throw new Error('Background decor boards require exactly four rows.');
  const [seatRow, staticRow, animRow3, projectileRow] = rows;
  if (seatRow.length !== 4 || staticRow.length !== 4 || animRow3.length !== 1
    || projectileRow.length !== 1 || projectileRow[0].kind !== 'projectile') {
    throw new Error('Background decor board layout must be 4 seats, 4 static decor, 1 animated decor, and 1 projectile FX row.');
  }
  const animDecor = animRow3[0];
  const animName = animDecor.kind === 'projectile' ? '' : animDecor.display_name;
  const cellList = (items: ThemeDecorBoardRow[], startCell: number): string[] =>
    items.map((item, index) => `  Cell ${startCell + index}: ${item.kind === 'projectile' ? 'projectile FX' : item.display_name}`);
  const spaceWord = background === 'transparent' ? 'transparent' : 'magenta';
  return [
    `Create one background-decor sprite board for the "${themeName}" theme.`,
    boardContract(4, 4, background),
    'The 16 cells form four rows. Each row has a distinct role described below.',
    '',
    'Row 1 (Cells 1-4): FOUR distinct STATIC SITTABLE SEATS.',
    'Each cell holds one themed piece of seating that a game character will visibly sit ON later.',
    'Draw a clear, readable seat surface (the seating furniture only) with an obvious place to sit.',
    'Every seat FACES RIGHT: draw it in side/three-quarter view with the seat opening and front of the chair pointing to the RIGHT, so a character (who faces right) sits facing right. The backrest is on the LEFT side of the seat.',
    'These are single static frames — no animation, one distinct seat per cell:',
    ...cellList(seatRow, 1),
    '',
    'Row 2 (Cells 5-8): FOUR distinct STATIC decor / scenery props, one per cell, single static frame each:',
    ...cellList(staticRow, 5),
    '',
    'Row 3 (Cells 9-12): ONE animated decor item shown as FOUR sequential loopable frames left to right.',
    `  Item: ${animName}`,
    'All four cells show the SAME item from one fixed camera; change only lights and subtle highlights — never moving, rotating, or shifting parts.',
    'Cell 12 must flow seamlessly back to cell 9. Keep the body stationary and the motion subtle.',
    'Cell 9 is the first frame of this animation row and defines the subject\'s exact position, outline, and footprint. Treat cells 10-12 as a near-copy of the first frame, redrawn with only small internal details changed.',
    'Across the frames of an animation row, the subject must stay locked in the identical position within each cell: same horizontal center, same baseline, same overall footprint. Animate through internal motion only (glow, flicker, moving parts, small secondary details) — never by shifting, sliding, or re-centering the whole subject between frames. The animation must be subtle: at least 95% of the subject\'s pixels stay identical from frame to frame, and its outline/silhouette is pixel-identical across the whole row. The animation is an EXTREMELY subtle ambient accent, not a focal point: at a glance the object should appear static, with motion only visible on close inspection. Use low-contrast changes — a faint glow swell, a dim blinking indicator, a slight flicker — never large flashing areas, strong color swings, fast motion, or high-contrast changes that pull the eye. A subject that shifts, slides, or sways side-to-side between frames is an incorrect result. An animation bold enough to draw attention away from the characters is an incorrect result.',
    'This is an inanimate object. The subject\'s width must be identical in every frame of the row — the leftmost and rightmost pixels of the subject stay in the same columns across all frames. Permitted animation is limited STRICTLY to lights and subtle highlights: emissive elements, glows, screens, and indicator lights may brighten, dim, flicker, or shift color, and existing highlights may subtly change brightness or hue. NOTHING structural moves — no rotating, tilting, wobbling, breathing, sliding, or resizing of the object or ANY of its parts, internal or external; the shape, outline, silhouette, position, footprint, and every structural pixel are pixel-identical in every frame. A subject whose width grows or shrinks between frames is an incorrect result.',
    '',
    'Row 4 (Cells 13-16): the themed RANGED-WEAPON-FIRE projectile shown as FOUR sequential ONE-SHOT frames left to right (a launch-to-impact sequence, NOT a loop).',
    `  Match this theme's ranged weapon: a bullet/tracer, an energy laser bolt, a plasma blast, an arrow/bolt, a rocket, or whatever fits "${themeName}".`,
    '  Cell 13: the SHOT / MUZZLE FIRE at launch — a bright muzzle flash or launch burst with the projectile just emerging.',
    `  Cell 14: the projectile IN FLIGHT — the bolt/bullet/arrow travelling through empty ${spaceWord} space with a motion trail.`,
    '  Cell 15: the projectile HITTING THE TARGET — the moment of contact/impact (sparks or a flash at the strike point).',
    '  Cell 16: the BLAST / IMPACT effect — an expanding burst, explosion, or scatter as the hit resolves.',
    '  Keep a consistent projectile identity, color, and camera across all four frames; this is a one-shot FX, not a decor item.',
    `  Do NOT draw the weapon, the shooter, or the target object — only the fire, the flying projectile, and its impact burst in empty ${spaceWord} space.`,
    '  Cell 13 defines the projectile\'s exact cell center. Treat cells 14-16 as the same projectile still anchored to that same cell center — only its shape, rotation, and glow may change in place as it travels and impacts.',
    '  The projectile and its effects must stay locked to the same cell center across all four frames — it may rotate or pulse in place, but its overall footprint/diameter stays constant across frames (no growing or shrinking), and it must never shift, slide, or re-center within the cell. A projectile that drifts off-center or grows or shrinks between frames is an incorrect result.',
    '',
    `Every cell holds exactly one subject fully inside its own cell with generous ${spaceWord} padding; nothing crosses a cell boundary.`,
    'Center each item with its lowest contact point just above the cell bottom, leaving a clear strip of empty background (about 5% of the cell height) beneath it — the item must never touch the cell\'s bottom edge, or its base will be sliced off flat. Keep a consistent isometric camera, lighting, and scale.',
    'CAMERA (applies to every item identically): a classic 2:1 pixel-art isometric interior view — vertical lines stay perfectly vertical, horizontal surfaces and wall tops recede along a shallow 2:1 diagonal (about 27 degrees), viewer looking down at about 30 degrees. Wall-hung items (banners, signs, screens, mounted lights) hang on an ANGLED wall plane in that same projection: their top edge recedes along the 2:1 diagonal exactly like the room\'s walls. Never draw any item flat-on / front-facing — an item whose perspective does not match the room\'s isometric angle is an incorrect result.',
    `Size every item to a strict height budget: it fills about 75% of its cell's height — an item taller than 80% of its cell height is an incorrect result.`,
    `When the board is complete, a continuous visible strip of empty ${spaceWord} must separate every row and every column — check the finished image for an unbroken ${spaceWord} gutter along EVERY horizontal row boundary; any item touching that gutter is drawn too large and is an incorrect result.`,
    'A naturally TALL item (a banner, tower, rack, standing screen, or any top-heavy subject) must be SCALED DOWN to fit entirely inside its cell with the required top and bottom margins intact — never stretch it to fill the cell height, and never let it reach a cell edge to preserve height. Prefer a smaller, fully-contained item over a taller one that crowds or touches a boundary; compact staging beats height. A tall item that touches or crosses any cell edge is an incorrect result.',
    'Do not draw characters, people, UI, captions, letters, numbers, or grid lines. No object may straddle two cells.',
    `Use crisp retro pixel art. ${finalUnusedPixelSentence(background)}`,
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

export function buildExpressionAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  expressions: string[],
  background: BoardBackgroundMode = 'magenta',
): string {
  const cells = expressions.slice(0, 16).map((expression, index) =>
    `Cell ${index + 1}: ${expression}`,
  );
  return [
    `Create one expression-icon sprite sheet for the "${themeName}" theme.`,
    boardContract(4, 4, background),
    'Draw exactly one bold, readable, icon-only expression in each cell, in row-major order:',
    ...cells,
    'Use a consistent speech-bubble icon style. Do not draw full characters.',
    'Do NOT draw the theme character, any character, any face, head, eyes, mouth, hair, or portrait. These are NOT facial expressions on a character.',
    'Each cell is a GENERIC symbolic emote ICON — a simple emoji/pictogram style symbol (e.g. shapes, objects, marks such as a heart, spark/idea star, sweat drop, exclamation, gear, zzz) that reads at a glance inside a speech bubble.',
    background === 'transparent'
      ? 'Flat, bold, high-contrast icon art on a fully transparent background; centered in its cell.'
      : 'Flat, bold, high-contrast icon art on solid magenta; centered in its cell.',
    'No words, letters, numbers, or punctuation glyphs.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

export function buildAchievementAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  achievements: string[],
  background: BoardBackgroundMode = 'magenta',
): string {
  const cells = achievements.slice(0, 20).map((achievement, index) =>
    `Cell ${index + 1}: ${achievement}`,
  );
  return [
    `Create one achievement-badge sprite sheet for the "${themeName}" theme.`,
    boardContract(5, 4, background),
    'Draw exactly one distinct, polished badge emblem in each cell, in row-major order:',
    ...cells,
    'Keep a consistent badge silhouette and rendering system while making every central emblem distinct.',
    'These are visual badge concepts only. Do not include unlock requirements, words, letters, or numbers.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

/** Legacy four-emote animation prompt retained for retries of older themes. */
export function buildEmoteAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  background: BoardBackgroundMode = 'magenta',
): string {
  return [
    `Create one animated emote-icon sprite board for the "${themeName}" theme.`,
    boardContract(5, 4, background),
    'Each row is one emote animation with five left-to-right frames.',
    'Row 1: happy celebration / smile, five-frame animation.',
    'Row 2: sleep / low-energy Z state, five-frame animation.',
    'Row 3: idea / discovery / build insight, five-frame animation.',
    'Row 4: team action / rally, five-frame animation.',
    'Draw icon-only speech-bubble contents, not full characters. Keep one centered icon in each cell.',
    'No words, letters, numbers, or punctuation glyphs.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}
