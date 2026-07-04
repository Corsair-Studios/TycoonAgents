import type { ThemeDecorBoardRow, ThemeObjectBoardRow, ThemeRivalBoardRow } from './themeImageReviewState';

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
): string {
  if (rows.length < 1 || rows.length > RIVALS_PER_BOARD) {
    throw new Error('Rival boards carry one to four enemy rows.');
  }
  const rowLines = rows.map((row, index) =>
    `Row ${index + 1} (Cells ${index * 5 + 1}-${index * 5 + 5}): the enemy **"${row.display_name}"** from the "${themeName}" theme.`,
  );
  return [
    `Create one compact rival (enemy) sprite board for the "${themeName}" theme.`,
    boardContract(5, 4),
    'Each of the (up to) four ROWS is ONE distinct named enemy, shown as a 5-frame mini-atlas:',
    '  Cells 1-2 of the row: a 2-frame side-view WALK cycle (cell 1 = contact pose, cell 2 = passing/opposite pose) that loops seamlessly cell 2 back to cell 1 — same enemy, only the limbs move.',
    '  Cells 3-5 of the row: a 3-frame ATTACK — cell 3 is the wind-up/anticipation, cell 4 is the strike/lunge (peak), cell 5 is the recovery/settle.',
    ...rowLines,
    '',
    'Keep each enemy identical across its own five cells: identical face, body, costume, colors, equipment, rendering style, and pixel scale — change only the pose.',
    'Use one consistent side / three-quarter camera for every enemy so the walk and attack read clearly and the sprite flips cleanly left-to-right.',
    'The attack is a playful, non-graphic, non-contact motion suitable for a general-audience video game: the enemy swings/lunges through empty magenta space and never touches another subject.',
    'Center each enemy in its cell with its feet near the cell bottom and generous magenta padding; nothing crosses a cell boundary.',
    'Use crisp retro pixel art. Every unused pixel must be flat solid #FF00FF magenta.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

/**
 * Production character scale calibrated from the approved reference character
 * boards (101px, 104px, and 107px median reference heights respectively).
 * Their combined median is 104px in a 128px frame.
 */
export const CHARACTER_TARGET_CONTENT_HEIGHT = 104;
export const CHARACTER_TARGET_CONTENT_PERCENT = 81.25;

function boardContract(columns: number, rows: number): string {
  return [
    'The outer image canvas is exactly **512 x 512 pixels (1:1)**. Do not crop or change the canvas aspect ratio.',
    `Inside that square canvas is an exact ${columns}-column by ${rows}-row logical grid with ${columns * rows} visually equal cells.`,
    'Keep every subject fully inside its own cell with generous empty padding; nothing may cross a cell boundary.',
    'Do not draw grid lines, labels, numbers, captions, borders, scenery, shadows, or extra subjects.',
    'Paint every unused pixel solid #FF00FF magenta with no texture or gradient.',
  ].join('\n');
}

export function buildCharacterAtlasPrompt(
  creativeDirection: string,
  characterName: string,
  themeName: string,
): string {
  return [
    'Create one production sprite board, not a poster, illustration, concept sheet, or character lineup.',
    '',
    'The outer image canvas is exactly **512 x 512 pixels (1:1)**. Do not crop the canvas to the 5:4 grid bounds.',
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
    'Every unused pixel on the canvas must be a perfectly flat solid **#FF00FF** magenta with no gradients, lighting, texture, fog, reflections, scenery, or environmental effects.',
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
    'A standing character below 78% or above 85% of its cell height is an incorrect result.',
    'Reserve the remaining approximately 19% as solid-magenta safety padding split above the head and below the feet.',
    'Keep a visible magenta gutter at every horizontal row boundary and below the entire fourth row.',
    'Do not leave oversized magenta margins around a small character.',
    'Do not zoom in or out based on the character costume, body type, equipment, or pose.',
    'Seated and action poses must preserve the same body scale as the standing poses; only the pose may change.',
    '',
    'Center the character horizontally within every cell.',
    '',
    'Standing poses must share a consistent baseline inside each cell, with visible magenta safety padding below both feet.',
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
    'The tool always swings through empty magenta space.',
    '',
    '---',
    '',
    '## Row 3 (Cells 11-15)',
    '',
    'Raising a ranged tool or energy source to aim at an unseen target.',
    '',
    'Releasing the ranged attack with visible recoil or follow-through.',
    '',
    'Empty-hand pointing pose.',
    '',
    'Team signal gesture.',
    '',
    'Defensive sidestep or dodge.',
    '',
    'These are playful, non-graphic, non-contact actions suitable for a general-audience video game. They show movement only and never depict contact with another subject.',
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
    'The tool must terminate in empty #FF00FF magenta space.',
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
    'Every unused pixel remains solid **#FF00FF** magenta.',
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
    boardContract(4, 5),
    'Treat the grid as five visually equal logical row bands; the production slicer distributes remainder pixels across row boundaries.',
    'Each of the (up to) five ROWS contains the four sequential animation frames of exactly one listed item:',
    ...rowLines,
    ...(rows.length < 5 ? [
      `Rows ${rows.length + 1}-5 are unused: leave their entire grid bands flat solid #FF00FF magenta with no content.`,
    ] : []),
    '',
    'OBJECT ROWS: all four cells show the same finished object from one fixed three-quarter/isometric camera.',
    'Keep the object body, contact point, scale, colors, and lighting identical. Change only moving or glowing parts.',
    'Every cell must be a distinct real generated frame; do not hold or duplicate frames.',
    'Make cell 4 flow seamlessly back to cell 1. Keep motion subtle and the body stationary.',
    'Center each object with its lowest contact point near the cell bottom. Preserve relative scale across every board.',
    ...(hasPoof ? [
      '',
      'POOF ROW: a four-frame one-shot reveal, centered and large enough to cover a full object.',
      'Cell 1 begins as a small low smoke puff; cell 2 grows outward; cell 3 is full and opaque;',
      'cell 4 dissipates into faint wisps. Use neutral light-grey/white smoke with a subtle theme-color tint.',
    ] : []),
    ...(hasCrate ? [
      '',
      'CRATE ROW: draw one closed themed shipping crate in cell 1. Cells 2–4 must remain entirely flat magenta.',
      'The crate is one static ready-to-build frame.',
    ] : []),
    '',
    'Use crisp retro pixel art with consistent viewpoint, lighting, rendering style, and camera distance.',
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
  return [
    `Create one background-decor sprite board for the "${themeName}" theme.`,
    boardContract(4, 4),
    'The 16 cells form four rows. Each row has a distinct role described below.',
    '',
    'Row 1 (Cells 1-4): FOUR distinct STATIC SITTABLE SEATS.',
    'Each cell holds one themed piece of seating that a game character will visibly sit ON later.',
    'Draw a clear, readable seat surface (the seating furniture only) with an obvious place to sit.',
    'These are single static frames — no animation, one distinct seat per cell:',
    ...cellList(seatRow, 1),
    '',
    'Row 2 (Cells 5-8): FOUR distinct STATIC decor / scenery props, one per cell, single static frame each:',
    ...cellList(staticRow, 5),
    '',
    'Row 3 (Cells 9-12): ONE animated decor item shown as FOUR sequential loopable frames left to right.',
    `  Item: ${animName}`,
    'All four cells show the SAME item from one fixed camera; change only subtly moving or glowing parts.',
    'Cell 12 must flow seamlessly back to cell 9. Keep the body stationary and the motion subtle.',
    '',
    'Row 4 (Cells 13-16): the themed RANGED-WEAPON-FIRE projectile shown as FOUR sequential ONE-SHOT frames left to right (a launch-to-impact sequence, NOT a loop).',
    `  Match this theme's ranged weapon: a bullet/tracer, an energy laser bolt, a plasma blast, an arrow/bolt, a rocket, or whatever fits "${themeName}".`,
    '  Cell 13: the SHOT / MUZZLE FIRE at launch — a bright muzzle flash or launch burst with the projectile just emerging.',
    '  Cell 14: the projectile IN FLIGHT — the bolt/bullet/arrow travelling through empty magenta space with a motion trail.',
    '  Cell 15: the projectile HITTING THE TARGET — the moment of contact/impact (sparks or a flash at the strike point).',
    '  Cell 16: the BLAST / IMPACT effect — an expanding burst, explosion, or scatter as the hit resolves.',
    '  Keep a consistent projectile identity, color, and camera across all four frames; this is a one-shot FX, not a decor item.',
    '  Do NOT draw the weapon, the shooter, or the target object — only the fire, the flying projectile, and its impact burst in empty magenta space.',
    '',
    'Every cell holds exactly one subject fully inside its own cell with generous magenta padding; nothing crosses a cell boundary.',
    'Center each item with its lowest contact point near the cell bottom. Keep a consistent isometric camera, lighting, and scale.',
    'Do not draw characters, people, UI, captions, letters, numbers, or grid lines. No object may straddle two cells.',
    'Use crisp retro pixel art. Every unused pixel must be flat solid #FF00FF magenta.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

export function buildExpressionAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  expressions: string[],
): string {
  const cells = expressions.slice(0, 16).map((expression, index) =>
    `Cell ${index + 1}: ${expression}`,
  );
  return [
    `Create one expression-icon sprite sheet for the "${themeName}" theme.`,
    boardContract(4, 4),
    'Draw exactly one bold, readable, icon-only expression in each cell, in row-major order:',
    ...cells,
    'Use a consistent speech-bubble icon style. Do not draw full characters.',
    'No words, letters, numbers, or punctuation glyphs.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

export function buildAchievementAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  achievements: string[],
): string {
  const cells = achievements.slice(0, 20).map((achievement, index) =>
    `Cell ${index + 1}: ${achievement}`,
  );
  return [
    `Create one achievement-badge sprite sheet for the "${themeName}" theme.`,
    boardContract(5, 4),
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
): string {
  return [
    `Create one animated emote-icon sprite board for the "${themeName}" theme.`,
    boardContract(5, 4),
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
