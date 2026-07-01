import type { ThemeDecorBoardRow, ThemeObjectBoardRow } from './themeImageReviewState';

export interface ThemeObjectPromptSpec {
  object_id: string;
  display_name: string;
}

export interface ThemeDecorPromptSpec {
  decor_id: string;
  display_name: string;
}

export function createObjectBoardRows(objects: ThemeObjectPromptSpec[]): ThemeObjectBoardRow[][] {
  if (objects.length !== 13) throw new Error('Animated object generation requires exactly 13 objects.');
  const asRows = (items: ThemeObjectPromptSpec[]): ThemeObjectBoardRow[] => items.map((object) => ({
    kind: 'object',
    object_id: object.object_id,
    display_name: object.display_name,
  }));
  return [
    asRows(objects.slice(0, 5)),
    asRows(objects.slice(5, 10)),
    [...asRows(objects.slice(10, 13)), { kind: 'poof' }, { kind: 'crate' }],
  ];
}

export function objectBoardFrameKeys(rows: ThemeObjectBoardRow[]): string[] {
  return rows.map((row) => row.kind === 'object' ? `object_${row.object_id}` : row.kind);
}

/**
 * Map the 10 decor specs onto the 4x4 background-decor board's four row-groups:
 *   row 1 → four single-frame seats,
 *   row 2 → four single-frame static decor,
 *   row 3 → one four-frame animated decor,
 *   row 4 → one four-frame animated decor.
 * Returns one array per row so the slicer knows each row's kind/ids.
 */
export function createDecorBoardRows(decor: ThemeDecorPromptSpec[]): ThemeDecorBoardRow[][] {
  if (decor.length !== 10) throw new Error('Background decor generation requires exactly 10 decor items.');
  const seats = decor.slice(0, 4).map((item): ThemeDecorBoardRow => ({
    kind: 'seat', decor_id: item.decor_id, display_name: item.display_name,
  }));
  const statics = decor.slice(4, 8).map((item): ThemeDecorBoardRow => ({
    kind: 'decor', decor_id: item.decor_id, display_name: item.display_name,
  }));
  const anim = decor.slice(8, 10).map((item): ThemeDecorBoardRow => ({
    kind: 'decor_anim', decor_id: item.decor_id, display_name: item.display_name,
  }));
  return [seats, statics, [anim[0]], [anim[1]]];
}

/** Frame keys for a single decor board row (all decor rows use `decor_<id>`). */
export function decorBoardFrameKeys(rows: ThemeDecorBoardRow[][]): string[] {
  return rows.flat().map((row) => `decor_${row.decor_id}`);
}

/**
 * Production character scale calibrated from the approved Cobra Commander,
 * Destro, and Baroness boards (101px, 104px, and 107px median reference
 * heights respectively). Their combined median is 104px in a 128px frame.
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
  if (rows.length !== 5) throw new Error('Animated object boards require exactly five rows.');
  const rowLines = rows.map((row, index) => {
    if (row.kind === 'object') {
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
    'Treat the five rows as five visually equal logical bands; the production slicer distributes remainder pixels across row boundaries.',
    'Each row contains the four sequential animation frames of exactly one listed item:',
    ...rowLines,
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
 * Rows 3 and 4 = one animated decor item each across four loopable frames.
 */
export function buildBackgroundDecorPrompt(
  creativeDirection: string,
  themeName: string,
  rows: ThemeDecorBoardRow[][],
): string {
  if (rows.length !== 4) throw new Error('Background decor boards require exactly four rows.');
  const [seatRow, staticRow, animRow3, animRow4] = rows;
  if (seatRow.length !== 4 || staticRow.length !== 4 || animRow3.length !== 1 || animRow4.length !== 1) {
    throw new Error('Background decor board layout must be 4 seats, 4 static decor, and 2 animated items.');
  }
  const cellList = (items: ThemeDecorBoardRow[], startCell: number): string[] =>
    items.map((item, index) => `  Cell ${startCell + index}: ${item.display_name}`);
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
    `  Item: ${animRow3[0].display_name}`,
    'All four cells show the SAME item from one fixed camera; change only subtly moving or glowing parts.',
    'Cell 12 must flow seamlessly back to cell 9. Keep the body stationary and the motion subtle.',
    '',
    'Row 4 (Cells 13-16): ONE animated decor item shown as FOUR sequential loopable frames left to right.',
    `  Item: ${animRow4[0].display_name}`,
    'All four cells show the SAME item from one fixed camera; change only subtly moving or glowing parts.',
    'Cell 16 must flow seamlessly back to cell 13. Keep the body stationary and the motion subtle.',
    '',
    'Every cell holds exactly one subject fully inside its own cell with generous magenta padding; nothing crosses a cell boundary.',
    'Center each item with its lowest contact point near the cell bottom. Keep a consistent isometric camera, lighting, and scale.',
    'Do not draw characters, people, UI, captions, letters, numbers, or grid lines. No object may straddle two cells.',
    'Use crisp retro pixel art. Every unused pixel must be flat solid #FF00FF magenta.',
    '',
    `Creative direction: ${creativeDirection}`,
  ].join('\n');
}

/** Compatibility prompt for retrying themes authored with the legacy 4x3 static board. */
export function buildLegacyObjectAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  objects: ThemeObjectPromptSpec[],
): string {
  const cells = objects.slice(0, 12).map((object, index) =>
    `Cell ${index + 1}: ${object.display_name}`,
  );
  return [
    `Create one object sprite sheet for the "${themeName}" theme.`,
    boardContract(4, 3),
    'Place exactly one finished, recognizable object in each cell, in row-major order:',
    ...cells,
    'Use the same isometric camera, lighting direction, rendering style, and relative scale across all 12 objects.',
    'Center each object in its cell and place its lowest contact point on the cell bottom edge.',
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
