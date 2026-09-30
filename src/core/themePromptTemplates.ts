import type { BodyPlan } from './bodyPlan';
import { WALK_POSE_GUIDE_PARAGRAPHS } from './walkPoseGuidePrompts';

/**
 * p59-t2: dependency-free prompt-assembly module the backend repo copies
 * verbatim to build the same model prompt server-side (see
 * docs/theme-service-api.md v3.4, POST /api/generate). Zero imports outside
 * this directory except BodyPlan (a plain string-union type) and
 * walkPoseGuidePrompts.ts, itself dependency-free. No vscode, fs, path, or
 * other Node builtins.
 *
 * src/extension/themeAssetPrompts.ts is a thin adapter over this module: its
 * existing builder functions keep their signatures, map their in-memory
 * arguments to a StructuredGenerateRequest, and call assembleThemePrompt so
 * the actual prompt text lives in exactly one place.
 */
export const PROMPT_TEMPLATE_VERSION = '2026-09-29.1';

/** See BoardBackgroundMode in themeAssetPrompts.ts (re-declared here to stay import-free). */
export type PromptBoardBackgroundMode = 'magenta' | 'transparent';

export interface PromptThemeSpec {
  description: string;
  creativeDirection?: string;
  palette?: string[];
}

export interface PromptRowSpec {
  display_name: string;
  visual_description?: string;
  motion_hint?: string;
  is_ranged_rack?: boolean;
}

export interface PromptObjectBoard2Slot {
  animated: [PromptRowSpec, PromptRowSpec];
  static: [PromptRowSpec, PromptRowSpec, PromptRowSpec];
  poofDescription?: string;
  crateDescription?: string;
}

export interface PromptDecorBoardSlot {
  seats: [PromptRowSpec, PromptRowSpec, PromptRowSpec, PromptRowSpec];
  statics: [PromptRowSpec, PromptRowSpec, PromptRowSpec, PromptRowSpec];
  animated: PromptRowSpec;
  projectileDescription?: string;
}

export interface PromptExpressionSlot {
  expressions: string[];
  descriptions?: string[];
}

export interface PromptAchievementSlot {
  achievements: string[];
  descriptions?: string[];
}

export interface PromptRosterAgentSlot {
  name: string;
  description?: string;
  bodyPlan: BodyPlan;
}

export type PromptSlot =
  | { boardType: 'roster_agent'; slot: PromptRosterAgentSlot }
  | { boardType: 'rival_group'; slot: PromptRowSpec[] }
  | { boardType: 'objects_01'; slot: { items: PromptRowSpec[] } }
  | { boardType: 'objects_02'; slot: PromptObjectBoard2Slot }
  | { boardType: 'expressions'; slot: PromptExpressionSlot }
  | { boardType: 'achievements'; slot: PromptAchievementSlot }
  | { boardType: 'environment'; slot?: Record<string, never> }
  | { boardType: 'background_decor'; slot: PromptDecorBoardSlot }
  | { boardType: 'emotes'; slot?: Record<string, never> };

export type StructuredGenerateRequest = {
  promptTemplateVersion: string;
  theme: PromptThemeSpec;
  userReferenceImages?: string[];
  options?: {
    seed?: number;
    retryOf?: string;
    /** Not part of the v3.4 wire contract; carried so the shared builder can
     * reproduce the extension's magenta/transparent chroma-key modes. Flag
     * for the contract owner — see report. */
    backgroundMode?: PromptBoardBackgroundMode;
    /**
     * Free-text revision notes for a retry's 'augment'/'custom' modes, max
     * 600 chars (docs/theme-service-api.md options). assembleThemePrompt
     * appends it to the assembled prompt exactly where the pre-v3.4
     * client-side "REVISION NOTES — correct the previous result:" wrapper
     * used to append user feedback, so output is unchanged for the same
     * inputs.
     */
    retryNotes?: string;
  };
  /** themeName is required by every builder below but not named in the v3.4
   * slot table (it rides on `theme.description` server-side); the extension
   * still needs it as a distinct field, so it is carried alongside theme. */
  themeName: string;
} & PromptSlot;

/**
 * Adjective phrase for "___ padding" used outside board-prompt assembly
 * (themeService's character-normalize retry notes), so freeform revision
 * text stays consistent with whichever background mode the original board
 * was baked with.
 */
export function boardBackgroundPaddingAdjective(background: PromptBoardBackgroundMode): string {
  return background === 'transparent' ? 'fully transparent' : 'solid-magenta';
}

function finalUnusedPixelSentence(background: PromptBoardBackgroundMode): string {
  return background === 'transparent'
    ? 'Every unused pixel must be fully transparent (alpha 0). Do not paint any background color, checkerboard pattern, or solid fill in unused areas.'
    : 'Every unused pixel must be flat solid #FF00FF magenta.';
}

function creativeDirectionHeader(creativeDirection: string): string {
  return `Art direction (governs everything below): ${creativeDirection}`;
}

function boardContract(columns: number, rows: number, background: PromptBoardBackgroundMode = 'magenta'): string {
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

/** See CHARACTER_TARGET_CONTENT_HEIGHT/PERCENT doc comment history in the pre-p59-t2
 * themeAssetPrompts.ts — kept here as the single source, re-exported there. */
export const CHARACTER_TARGET_CONTENT_HEIGHT = 118;
export const CHARACTER_TARGET_CONTENT_PERCENT = 72;

/**
 * Four-legged characters (cats, dogs, etc.) are drawn from a portrait-cell
 * atlas (5 cols x 4 rows on a 1024 canvas => ~205x256 cells) but their bodies
 * are as wide as tall or wider once tail and mid-stride legs are included, so
 * the height-based CHARACTER_TARGET_CONTENT_PERCENT rule (which leaves no
 * width margin) lets tails/strides cross into the neighboring cell. Mirrors
 * RIVAL_TARGET_CONTENT_PERCENT/RIVAL_MIN_GUTTER_PERCENT above but as the sole
 * budget for four-legged bodies (replaces the height rule, not additive to
 * it) and used only for the 'quadruped' BodyPlan.
 */
export const CHARACTER_QUADRUPED_TARGET_CONTENT_PERCENT = 70;
export const CHARACTER_QUADRUPED_MIN_GUTTER_PERCENT = 15;

/**
 * Slicer-side (src/extension/themeService.ts characterAtlasGrid) mirror of
 * CHARACTER_TARGET_CONTENT_HEIGHT, but sized by WIDTH for four-legged
 * characters: a quadruped's body reads wide rather than tall, so fitting it
 * to CHARACTER_TARGET_CONTENT_HEIGHT alone leaves it looking small next to a
 * biped at the same body height. Same target magnitude as
 * CHARACTER_TARGET_CONTENT_HEIGHT so a cat/dog keeps a similar presence in
 * the 128x128 frame.
 */
export const CHARACTER_QUADRUPED_TARGET_CONTENT_WIDTH = 118;

/**
 * Rivals have wide appendages (limbs, tentacles, weapons, particle trails) that
 * characters don't, so their silhouette budget is enforced on BOTH axes, not
 * just height, and is tighter than the character budget to leave those parts
 * room to move without crossing a cell edge. Single source for both the prompt
 * wording and any future slicer-side cross-check.
 */
export const RIVAL_TARGET_CONTENT_PERCENT = 70;
export const RIVAL_MIN_GUTTER_PERCENT = 15;

function objectRowAnimationConstraintLines(rowLabel: string): string[] {
  return [
    `${rowLabel}: all four cells show the same finished object from one fixed three-quarter/isometric camera.`,
    'Keep the object body, contact point, scale, colors, and lighting identical. Change only moving or glowing parts.',
    'The object BODY MUST NOT move, shift, translate, rotate, resize, or reposition between the four frames. Every structural/body pixel stays in the EXACT same location in all four cells.',
    'Only lights, glows, screens, indicator lights, and the brightness or color of subtle highlights may change between frames — NO moving, rotating, or shifting parts of any kind (internal or external). The silhouette and footprint are pixel-identical across all four frames.',
    'Do NOT bob, sway, breathe, scale, or drift the object. Treat these four cells as the identical object photographed from a locked camera, changing only its lights/color.',
    'The FIRST cell of this row defines the subject\'s exact position, outline, and footprint. Treat every later cell in the row as a near-copy of the first frame, redrawn with only small internal details changed.',
    'Across the frames of this row, the subject must stay locked in the identical position within each cell: same horizontal center, same baseline, same overall footprint. Animate through internal motion only (glow, flicker, moving parts, small secondary details) — never by shifting, sliding, or re-centering the whole subject between frames. The animation must be subtle: at least 95% of the subject\'s pixels stay identical from frame to frame, and its outline/silhouette is pixel-identical across the whole row. The animation is an EXTREMELY subtle ambient accent, not a focal point: at a glance the object should appear static, with motion only visible on close inspection. Use low-contrast changes — a faint glow swell, a dim blinking indicator, a slight flicker — never large flashing areas, strong color swings, fast motion, or high-contrast changes that pull the eye. A subject that shifts, slides, or sways side-to-side between frames is an incorrect result. An animation bold enough to draw attention away from the characters is an incorrect result.',
    'This is an inanimate object. The subject\'s width must be identical in every frame of the row — the leftmost and rightmost pixels of the subject stay in the same columns across all frames. Permitted animation is limited STRICTLY to lights and subtle highlights: emissive elements, glows, screens, and indicator lights may brighten, dim, flicker, or shift color, and existing highlights may subtly change brightness or hue. NOTHING structural moves — no rotating, tilting, wobbling, breathing, sliding, or resizing of the object or ANY of its parts, internal or external; the shape, outline, silhouette, position, footprint, and every structural pixel are pixel-identical in every frame. A subject whose width grows or shrinks between frames is an incorrect result.',
    'Every cell in this row must be a distinct real generated frame; do not hold or duplicate frames.',
    'Make the row\'s last cell flow seamlessly back to its first cell. Keep motion subtle and the body stationary.',
  ];
}

function objectSizingAndCameraLines(): string[] {
  return [
    'Keep every object fully inside its own cell with clear empty margin on ALL FOUR sides — top, bottom, left, and right. No object may touch or cross any cell edge or extend into a neighboring cell. If an object would be too wide to fit with left/right margin, draw it SMALLER to fit — never let it span into the adjacent cell. Keep objects at a consistent, uniform size.',
    'Center each object with its lowest contact point just above the cell bottom, leaving a clear strip of empty background (about 5% of the cell height) beneath it — the object must never touch the cell\'s bottom edge, or its base will be sliced off flat. Preserve relative scale across the whole board.',
    'Size every object to a strict height budget: it fills about 75% of its cell\'s height — a subject taller than 80% of its cell height is an incorrect result.',
    'When the board is complete, a continuous visible strip of empty background must separate every row and every column — check the finished image for an unbroken gutter along EVERY horizontal row boundary; any subject touching that gutter is drawn too large and is an incorrect result.',
    'A naturally TALL object (an antenna, tower, rack, mounted screen, or any top-heavy subject) must be SCALED DOWN to fit entirely inside the cell with its top and bottom margins intact — never stretch it to fill the cell height, and never let it reach the top or bottom edge to preserve height. Prefer a smaller, fully-contained object over a taller one that crowds or touches a boundary; compact staging beats height. A tall object that touches or crosses any cell edge is an incorrect result.',
    'Use crisp retro pixel art with consistent viewpoint, lighting, rendering style, and camera distance.',
    'CAMERA (applies to every object identically, and MUST match the room/background it sits in): a classic 2:1 pixel-art isometric interior view — vertical lines stay perfectly vertical, all horizontal surfaces (tops, bases, panels, treads) recede along a shallow 2:1 diagonal (about 25 degrees), viewer looking down at about 30 degrees. Orient every object in three-quarter view with a front CORNER (not a flat face) pointing toward the viewer, so exactly two sides are visible and its top/base reads as a 2:1 diamond — the same way the room\'s floor and walls recede. Never draw an object flat-on, front-elevation, or in side-profile with a single face square to the camera — an object whose perspective does not match the room\'s isometric angle is an incorrect result.',
    'ISOMETRIC DIRECTION — identical on EVERY cell: the ground baseline rises from lower-LEFT to upper-RIGHT, so each object\'s bottom-LEFT corner sits LOWER on the canvas than its bottom-RIGHT corner (about a 25-degree tilt) — we view each object from its front-left, with the right side receding back and upward. Never mirror or flip this tilt; keep the same 25-degree left-down / right-up orientation on all cells so every prop shares one perspective and light direction.',
    'FACING — identical on EVERY object: orient every object that has a discernible front so its FRONT points toward the LEFT edge of the cell. Vehicles point their nose / cab / cockpit / prow / main gun-barrel to the LEFT; structures and devices present their main face or screen toward the LEFT. Every directional object faces the SAME way — LEFT. NEVER mirror, flip, or rotate any object to face right, and do not vary facing for visual variety. Radially symmetric objects (spheres, upright racks, crates) need no particular facing.',
  ];
}

function buildRivalAtlas(
  creativeDirection: string,
  themeName: string,
  rows: PromptRowSpec[],
  background: PromptBoardBackgroundMode,
): string {
  const rowLines = rows.map((row, index) =>
    `Row ${index + 1} (Cells ${index * 5 + 1}-${index * 5 + 5}): the enemy **"${row.display_name}"** from the "${themeName}" theme.`
    + (row.visual_description ? ` Appearance — depict this exact design: ${row.visual_description}` : ''),
  );
  const spaceWord = background === 'transparent' ? 'transparent' : 'magenta';
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create one compact rival (enemy) sprite board for the "${themeName}" theme.`,
    boardContract(5, rows.length, background),
    `Each of the ${rows.length} ROWS is ONE distinct named enemy, shown as a 5-frame mini-atlas:`,
    '  Cells 1 and 2 of each row form one complete, seamless two-frame locomotion cycle, arranged in playback order and looping cell 2 back to cell 1. Animate the enemy moving in place, facing right in a consistent side view.',
    '',
    '  Choose the gait appropriate to its anatomy: For a two-legged enemy, use a natural walk with alternating feet and opposing arm swings, if it has arms. For a four-legged enemy, use a gentle trot in which diagonal pairs move together: near-side front with far-side hind, and far-side front with near-side hind.',
    '',
    '  Cell 1 — First contact: The first foot or diagonal pair reaches forward and contacts the ground. The opposite foot or pair trails behind, finishing its push-off. Use a comfortable, short stride.',
    '',
    '  Cell 2 — Opposite contact: Reverse the roles from cell 1. The opposite foot or diagonal pair now reaches forward and contacts the ground, while the first trails behind and finishes pushing off. The two cells must show the legs swapped, never the same leg forward twice.',
    '',
    '  Consistency and anatomy: Keep character design, proportions, facing direction, camera, scale, and ground line identical between the two cells. Keep the torso centered, allowing only a subtle, consistent rise and fall. Bend all joints according to the enemy\'s anatomy. Supporting feet make firm ground contact; trailing feet finish their push-off. Distinguish near-side and far-side limbs clearly. Maintain equal strides and balanced weight so the loop reads as continuous stepping, not gliding. Do not duplicate cell 1 as cell 2.',
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
    '# RIVAL SILHOUETTE BUDGET (STRICT — WIDTH AND HEIGHT)',
    `In EVERY frame, the entire silhouette — body, legs, claws, tentacles, antennae, orbs, particle trails, and weapon — stays within the central ${RIVAL_TARGET_CONTENT_PERCENT}% of the cell in BOTH width and height, measured against that individual cell, never the full canvas.`,
    `Keep a clear ${spaceWord} gutter of at least ${RIVAL_MIN_GUTTER_PERCENT}% of the cell size on every side — top, bottom, left, and right — in every frame.`,
    'Keep poses compact: curl appendages, limbs, tentacles, and weapons INWARD toward the body rather than extending them outward, so a wind-up or strike pose stays inside the same budget as the walk cycle.',
    'No part of the enemy, in any frame, may touch or cross a cell edge. A frame where any part reaches the gutter or the cell boundary is an incorrect result.',
    `Use crisp retro pixel art. ${finalUnusedPixelSentence(background)}`,
  ].join('\n');
}

function buildCharacterAtlas(
  creativeDirection: string,
  characterName: string,
  themeName: string,
  background: PromptBoardBackgroundMode,
  visualDescription: string | undefined,
  walkPoseGuide: BodyPlan | undefined,
  bodyPlan: BodyPlan,
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
    `NO BORDERS OR GRID ARTIFACTS (ABSOLUTE): the sheet contains ONLY the 20 character sprites on one flat ${background === 'transparent' ? 'fully transparent' : 'solid-#FF00FF-magenta'} background. Do NOT draw an outer border or frame around the sheet, cell outlines, grid lines, gutter dividers, selection boxes or rectangles around any sprite, numbering, labels, or text, drop shadows outside the figure, or any backdrop other than that single flat ${spaceWord} background. The ${spaceWord} background runs edge to edge with NO framing of any kind.`,
    '',
    'Every cell contains the EXACT SAME character:',
    '',
    `**"${characterName}"** from the **${themeName}** theme.`,
    '',
    ...(visualDescription
      ? [`Appearance — depict this exact design: ${visualDescription}`, '']
      : []),
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
    ...(bodyPlan === 'quadruped'
      ? [
        `For a four-legged body, the complete silhouette — including tail, ears, whiskers, and fully extended legs mid-stride — stays within the central 60% of the cell WIDTH in every frame, replacing the head-to-feet height rule used for two-legged characters.`,
        `Measure that 60% against each individual cell's width, never against the full canvas.`,
        `Keep a clear ${spaceWord} gutter of at least 20% of the cell width on the LEFT and RIGHT of the body in every frame. This applies equally to the leftmost and rightmost columns: the gutter between the body and the outer edge of the canvas is required too, so tails in column 1 must not touch the left edge of the image.`,
        'Keep strides compact and keep the tail curled or held close to the body rather than fully extended, so a mid-stride walking pose stays inside the same width budget as the standing pose.',
        'No part of the body — including tail, ears, whiskers, and legs — may touch or cross a cell edge in any frame. A frame where any part reaches the gutter or the cell boundary is an incorrect result.',
      ]
      : [
        `In walking and neutral-standing cells, the complete character from head to feet occupies exactly ${CHARACTER_TARGET_CONTENT_PERCENT}% of the cell height.`,
        `Measure that ${CHARACTER_TARGET_CONTENT_PERCENT}% against each individual cell, never against the full canvas.`,
        'A standing character below 68% or above 76% of its cell height is an incorrect result.',
        `Reserve the remaining approximately 28% as ${background === 'transparent' ? 'fully transparent' : 'solid-magenta'} safety padding split above the head and below the feet.`,
      ]),
    `Keep a visible ${spaceWord} gutter at every horizontal row boundary and below the entire fourth row.`,
    `Do not leave oversized ${spaceWord} margins around a small character.`,
    'Do not zoom in or out based on the character costume, body type, equipment, or pose.',
    'Seated and action poses must preserve the same body scale as the standing poses; only the pose may change.',
    'UNIFORM SCALE (ALL 20 CELLS): the character head-to-feet height must be IDENTICAL in every one of the 20 cells — measure the same body height per cell across the walk, tool, combat, and celebration rows alike. Never enlarge an action, combat, or celebration pose relative to the walk row. A held weapon or an extended arm is accommodated by keeping the WHOLE figure inside the cell, never by drawing the character bigger.',
    'The bottom-row celebration poses (dance and victory) must keep both HANDS at or below SHOULDER height — never thrown above the head. Drawn this way the tallest point of every pose is the head, exactly like a standing pose, so each figure fits inside its cell at the SAME body scale with the same head-top padding.',
    'NEVER let any pixel cross the TOP edge of its cell — with special force on the entire fourth (bottom) row. If a pose would still cross the top boundary, lower the arms and hands further; do NOT fix it by shrinking one figure, which would make that character look smaller than the others.',
    '',
    'Center the character horizontally within every cell.',
    '',
    `HORIZONTAL CONTAINMENT (ALL 20 CELLS): every pose — including held weapons, the arms-extended ranged-aim pose, and the committed melee strike — must sit fully inside its cell with a clear ${spaceWord} margin on BOTH the left AND the right. Keep that same horizontal safe margin on every cell. No weapon, limb, swing arc, or effect may touch or cross a cell's left or right edge or bleed into a neighboring cell. If an aim or strike would reach an edge, angle it more downward or pull the whole figure in — never widen past the margin and never enlarge the figure.`,
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
    '## Row 1 (Cells 1-5) — WALK cycle (Cells 1-4) and back view (Cell 5)',
    '',
    ...(walkPoseGuide ? [WALK_POSE_GUIDE_PARAGRAPHS[walkPoseGuide], ''] : []),
    'All five cells are drawn in the SAME three-quarter / isometric viewpoint as the rest of the board (do NOT switch to a flat side view), with the SAME character, costume, colors, and camera throughout.',
    '',
    'The first four frames of the animation sprite board form one complete, seamless locomotion cycle, arranged in playback order. Animate the creature moving in place, facing right in a consistent side view.',
    '',
    'Choose the gait appropriate to its anatomy: For a two-legged creature, use a natural walk with alternating feet and opposing arm swings, if it has arms. For a four-legged creature, use a gentle trot in which diagonal pairs move together: near-side front with far-side hind, and far-side front with near-side hind.',
    '',
    'Frame 1 — First contact: The first foot or diagonal pair reaches forward and contacts the ground. The opposite foot or pair trails behind, finishing its push-off. Use a comfortable, short stride.',
    '',
    'Frame 2 — First passing pose: The supporting leg or pair moves beneath the body as the body’s weight passes over it. The opposite leg or pair bends and swings forward beneath the body, with paws or feet visibly lifted clear of the ground.',
    '',
    'Frame 3 — Opposite contact: Reverse the roles from frame 1. The opposite foot or diagonal pair now reaches forward and contacts the ground, while the first trails behind and finishes pushing off.',
    '',
    'Frame 4 — Opposite passing pose: Reverse the roles from frame 2. The new supporting leg or pair carries the weight beneath the body while the first bends and swings forward, ready to return seamlessly to frame 1.',
    '',
    'Consistency and anatomy: Keep character design, proportions, facing direction, camera, scale, and ground line identical. Keep the torso centered, allowing only a subtle, consistent rise and fall. Bend all joints according to the creature’s anatomy. Supporting feet make firm ground contact; swinging feet clear the ground. Distinguish near-side and far-side limbs clearly. Maintain equal strides, balanced weight, and continuous movement through frames 1 → 2 → 3 → 4 → 1. Do not duplicate the first frame as the fourth frame.',
    '',
    'Cell 5 — the same character standing still, seen from directly behind, back to the viewer. Same costume, colors, and proportions as the rest of the row, just turned around; no legs mid-stride, no walking.',
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
    'TOP CONTAINMENT (row 2): keep the topmost point of the tool at or below the head throughout the wind-up, forward swing, and follow-through -- the tool arcs FORWARD and DOWNWARD, never raised straight overhead. The entire figure AND the tool must stay inside the cell with clear padding above the highest point; if a swing would push the tool past the top edge of the cell, lower the arc. Never let the tool or any pixel cross the top boundary of the cell.',
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
    'Bottom-row reminder: in the dance and victory cells keep both HANDS at or below shoulder height (fists pumped, elbows bent — NOT overhead) so the whole figure fits its cell just like a standing pose, with clear padding above the head. Do not raise arms above the head, and do not shrink the figure.',
    '',
    'Invisible-chair seated idle.',
    '',
    'Neutral standing idle.',
    '',
    'Dance step A: a lively dance beat — weight shifted onto one leg with the opposite knee raised slightly; both fists pumped to about SHOULDER height (elbows bent), hands never above the head.',
    '',
    'Dance step B: the opposite beat — weight and raised knee swapped to the other side, fists swung to shoulder height on that side; hands stay at or below shoulder height.',
    '',
    'Victory pose: a triumphant celebration — chin up, both fists clenched and raised only to SHOULDER / upper-chest height with elbows bent at the sides (NOT thrown overhead), so the head stays the highest point and the whole figure fits the cell.',
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

function buildEnvironment(creativeDirection: string, themeName: string): string {
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create a single isometric game-stage environment for the "${themeName}" theme.`,
    'CAMERA — match the object and decor sprites EXACTLY: a classic 2:1 pixel-art isometric view. Vertical structures (walls, towers, posts, doors) stay perfectly vertical; all horizontal surfaces — especially the open ground/floor, plus ledges and wall tops — recede along a shallow 2:1 diagonal of about 25 degrees, with the viewer looking down at about 30 degrees. The open floor MUST read as a single flat 2:1 isometric plane at exactly this angle. ISOMETRIC DIRECTION — identical to the objects: the ground baseline rises from lower-LEFT to upper-RIGHT (the floor\'s left side sits lower on the canvas than its right side, about a 25-degree tilt), so objects standing on the floor sit flush and share the floor\'s angle. Do not use a steeper 3D/architectural perspective, a head-on flat elevation, or any other camera — only this 2:1 isometric.',
    'The attached image is an OPAQUE GEOMETRY GUIDE, not an art-style reference.',
    'Preserve its portrait aspect ratio and exact outer hexagonal stage silhouette.',
    'The cyan region means OUTSIDE THE ASSET and must remain flat solid cyan (#00FFFF).',
    'Replace the purple/gray stage region with themed floor and rear-wall artwork, filling it all the way to the silhouette edges.',
    'CRITICAL — keep the floor empty: the entire central and front (lower) portion of the stage floor is a RESERVED WALKABLE AREA and MUST be completely empty — bare, flat, themed ground only. Do NOT place ANY objects on the floor: no fountains, wells, statues, market stalls, tents, stands, crates, barrels, benches, chairs, tables, rugs, trees, bushes, plants, flowers, lamp posts, signposts, or freestanding decoration of any kind. Put ALL structures, scenery, foliage, and decorative detail ONLY along the REAR wall (top) and the far left and right perimeter edges — never out on the open floor. Think of an empty courtyard or plaza with detail only around its back and side walls; the game engine places every object and decoration on the open floor at runtime.',
    'CRITICAL — no overhang into the floor: the open floor must keep a CLEAR MARGIN on all sides: every piece of perimeter decoration must sit flush against the rear wall or the REAR portion of the extreme left and right edges (where they meet the back wall) and must NOT overhang, lean, spill, drape, or extend inward over the open floor. No foliage, branches, leaves, flowers, bushes, trees, awnings, tents, market stalls, banners, cloth, or any prop may cross over or hang above the central walkable area. The boundary of the open floor must be a clean, unobstructed edge; when in doubt, push decoration further back toward the walls, never forward toward the floor.',
    'CRITICAL — the walkable floor\'s FRONT and SIDE edges must be bare: the open walkable floor must extend cleanly all the way to its front and side edges. The two NEAR corners closest to the viewer (front-left and front-right, near the bottom point) and the entire FRONT half of the floor\'s perimeter must be COMPLETELY EMPTY walkable ground — absolutely no fences, railings, gates, iron rails, low walls, posts, planters, flower beds, hedges, bushes, barrels, crates, or any decorative object placed there or lining those edges. Decoration and props belong ONLY along the REAR wall at the back of the stage. The left and right side edges may carry decoration ONLY in their REAR portion where they meet the back wall; from the middle of the stage forward to the front point the floor edge must be bare stone. Never frame, line, border, or fence the front or near corners of the walkable area — those corners must read as open, unobstructed floor.',
    'CRITICAL — no boundary line: do NOT draw any outline, border, rim, edge stroke, frame, or glow along the stage silhouette, in cyan, blue, or ANY color. The themed floor and wall art must fill the stage all the way to the silhouette edges and bleed slightly past them, meeting the cyan area in a clean hard edge with no seam and no colored line. There must be zero cyan or light-blue pixels anywhere inside the stage region.',
    'No seats or benches. Walls and flooring should match the angles of the background shape edges.',
    'No characters, vehicles, UI, HUD, captions, logos, floating text, or square city-map composition.',
    'Do not extend scenery into the cyan area and do not change the silhouette.',
    'The final pipeline will chroma-key the outside region and enforce the silhouette mask.',
  ].join('\n');
}

function buildObjectBoard1(
  creativeDirection: string,
  themeName: string,
  rows: PromptRowSpec[],
  background: PromptBoardBackgroundMode,
): string {
  const cellLines = rows.map((row, index) => {
    if (row.is_ranged_rack) {
      return `Cell ${index + 1}: ${row.display_name} — a wall- or floor-mounted rack/stand displaying several themed RANGED weapons (rifles, launchers, or bows appropriate to the setting), clearly readable as ranged weapons — NOT a crate, shelf, or melee weapons.`
        + (row.visual_description ? ` — ${row.visual_description}` : '');
    }
    return `Cell ${index + 1}: ${row.display_name} — one complete, fully-built theme structure/prop.`
      + (row.visual_description ? ` — ${row.visual_description}` : '');
  });
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create one static buildable-object sprite board for the "${themeName}" theme.`,
    boardContract(4, 4, background),
    `${rows.length} distinct STATIC buildable objects, one per cell in row-major order (Cell 1 through Cell ${rows.length}), each a fully-built theme structure:`,
    ...cellLines,
    '',
    'Each cell shows exactly ONE finished, fully-built object as a single static frame — no animation, no motion, no partial construction. Every object is complete and ready to use.',
    'Draw every object LARGE within its cell: fill most of the cell with only a small, uniform margin on all sides, and keep the same consistent visual size across all 16 cells — no object may be left small or floating in a sea of empty background.',
    ...objectSizingAndCameraLines(),
  ].join('\n');
}

function buildObjectBoard2(
  creativeDirection: string,
  themeName: string,
  slot: PromptObjectBoard2Slot,
  background: PromptBoardBackgroundMode,
): string {
  const [rowA, rowB] = slot.animated;
  const [staticC, staticD, staticE] = slot.static;
  const motionA = rowA.motion_hint
    ?? 'invent one subtle functional motion or light cycle that reads clearly across four loopable phases';
  const motionB = rowB.motion_hint
    ?? 'invent one subtle functional motion or light cycle that reads clearly across four loopable phases';
  const staticCells = [staticC, staticD, staticE].map((row, index) => (
    `Cell ${13 + index}: ${row.display_name} — one complete, fully-built theme structure/prop.`
      + (row.visual_description ? ` — ${row.visual_description}` : '')
  ));
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create one animated-object + build-effects sprite board for the "${themeName}" theme.`,
    boardContract(4, 4, background),
    'The 16 cells (4 columns x 4 rows, row-major) carry FOUR distinct roles:',
    `Row 1 (Cells 1-4): the four sequential animation frames of ONE object — ${rowA.display_name} — ${motionA}`
      + (rowA.visual_description ? ` — ${rowA.visual_description}` : ''),
    `Row 2 (Cells 5-8): the four sequential animation frames of a SECOND object — ${rowB.display_name} — ${motionB}`
      + (rowB.visual_description ? ` — ${rowB.visual_description}` : ''),
    'Row 3 (Cells 9-12): a FOUR-frame one-shot build-completion POOF — use the POOF rules below.',
    'Row 4 (Cells 13-15): three distinct STATIC buildable objects, one complete fully-built theme structure/prop per cell, no animation:',
    ...staticCells,
    'Cell 16 (the final cell of row 4): a single static build CRATE — use the CRATE rules below.',
    '',
    ...objectRowAnimationConstraintLines('Row 1 (Cells 1-4)'),
    '',
    ...objectRowAnimationConstraintLines('Row 2 (Cells 5-8)'),
    '',
    'POOF (Cells 9-12): a 4-frame one-shot reveal, centered and large enough to cover a full object, progressing smoothly from a small puff to a full burst to dissipation:'
      + (slot.poofDescription?.trim() ? ` Appearance — depict this exact design: ${slot.poofDescription.trim()}` : ''),
    'Cell 9 begins as a small low smoke puff.',
    'Cell 10 grows the puff outward toward a full, opaque burst.',
    'Cell 11 is the full, opaque burst.',
    'Cell 12 dissipates the burst smoothly into faint wisps.',
    'Use neutral light-grey/white smoke with a subtle theme-color tint. Every cell must be a distinct real generated frame; do not hold or duplicate frames. Keep the puff centered on the same point across all four frames.',
    '',
    'CRATE (Cell 16): draw one closed themed shipping crate. The crate is one static ready-to-build frame.'
      + (slot.crateDescription?.trim() ? ` Appearance — depict this exact design: ${slot.crateDescription.trim()}` : ''),
    ...objectSizingAndCameraLines(),
  ].join('\n');
}

function buildBackgroundDecor(
  creativeDirection: string,
  themeName: string,
  slot: PromptDecorBoardSlot,
  background: PromptBoardBackgroundMode,
): string {
  const { seats, statics, animated } = slot;
  const cellList = (items: PromptRowSpec[], startCell: number): string[] =>
    items.map((item, index) => {
      const base = `  Cell ${startCell + index}: ${item.display_name}`;
      return item.visual_description ? `${base} — ${item.visual_description}` : base;
    });
  const spaceWord = background === 'transparent' ? 'transparent' : 'magenta';
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create one background-decor sprite board for the "${themeName}" theme.`,
    boardContract(4, 4, background),
    'The 16 cells form four rows. Each row has a distinct role described below.',
    '',
    'Row 1 (Cells 1-4): FOUR distinct STATIC SITTABLE SEATS.',
    'Each cell holds one themed piece of seating that a game character will visibly sit ON later.',
    'Draw a clear, readable seat surface (the seating furniture only) with an obvious place to sit.',
    'Every seat FACES RIGHT: draw it in side/three-quarter view with the seat opening and front of the chair pointing to the RIGHT, so a character (who faces right) sits facing right. The backrest is on the LEFT side of the seat.',
    'These are single static frames — no animation, one distinct seat per cell:',
    ...cellList(seats, 1),
    '',
    'Row 2 (Cells 5-8): FOUR distinct STATIC decor / scenery props, one per cell, single static frame each:',
    ...cellList(statics, 5),
    '',
    'Row 3 (Cells 9-12): ONE animated decor item shown as FOUR sequential loopable frames left to right.',
    `  Item: ${animated.display_name}${animated.visual_description ? ` — ${animated.visual_description}` : ''}`,
    'All four cells show the SAME item from one fixed camera; change only lights and subtle highlights — never moving, rotating, or shifting parts.',
    'Cell 12 must flow seamlessly back to cell 9. Keep the body stationary and the motion subtle.',
    'Cell 9 is the first frame of this animation row and defines the subject\'s exact position, outline, and footprint. Treat cells 10-12 as a near-copy of the first frame, redrawn with only small internal details changed.',
    'Across the frames of an animation row, the subject must stay locked in the identical position within each cell: same horizontal center, same baseline, same overall footprint. Animate through internal motion only (glow, flicker, moving parts, small secondary details) — never by shifting, sliding, or re-centering the whole subject between frames. The animation must be subtle: at least 95% of the subject\'s pixels stay identical from frame to frame, and its outline/silhouette is pixel-identical across the whole row. The animation is an EXTREMELY subtle ambient accent, not a focal point: at a glance the object should appear static, with motion only visible on close inspection. Use low-contrast changes — a faint glow swell, a dim blinking indicator, a slight flicker — never large flashing areas, strong color swings, fast motion, or high-contrast changes that pull the eye. A subject that shifts, slides, or sways side-to-side between frames is an incorrect result. An animation bold enough to draw attention away from the characters is an incorrect result.',
    'This is an inanimate object. The subject\'s width must be identical in every frame of the row — the leftmost and rightmost pixels of the subject stay in the same columns across all frames. Permitted animation is limited STRICTLY to lights and subtle highlights: emissive elements, glows, screens, and indicator lights may brighten, dim, flicker, or shift color, and existing highlights may subtly change brightness or hue. NOTHING structural moves — no rotating, tilting, wobbling, breathing, sliding, or resizing of the object or ANY of its parts, internal or external; the shape, outline, silhouette, position, footprint, and every structural pixel are pixel-identical in every frame. A subject whose width grows or shrinks between frames is an incorrect result.',
    '',
    'Row 4 (Cells 13-16): the themed RANGED-WEAPON-FIRE projectile shown as FOUR sequential ONE-SHOT frames left to right (a launch-to-impact sequence, NOT a loop).',
    `  Match this theme's ranged weapon: a bullet/tracer, an energy laser bolt, a plasma blast, an arrow/bolt, a rocket, or whatever fits "${themeName}".`
      + (slot.projectileDescription ? ` Appearance — depict this exact design: ${slot.projectileDescription}` : ''),
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
    'CAMERA (applies to every item identically): a classic 2:1 pixel-art isometric interior view — vertical lines stay perfectly vertical, horizontal surfaces and wall tops recede along a shallow 2:1 diagonal (about 25 degrees), viewer looking down at about 30 degrees. Wall-hung items (banners, signs, screens, mounted lights) hang on an ANGLED wall plane in that same projection: their top edge recedes along the 2:1 diagonal exactly like the room\'s walls. Never draw any item flat-on / front-facing — an item whose perspective does not match the room\'s isometric angle is an incorrect result.',
    'ISOMETRIC DIRECTION for FREESTANDING / floor-standing items (seats and floor-standing decor) — identical on EVERY cell and consistent with the object boards: the ground baseline rises from lower-LEFT to upper-RIGHT, so each item\'s bottom-LEFT corner sits LOWER on the canvas than its bottom-RIGHT corner (about a 25-degree tilt) — we view each item from its front-left, with the right side receding back and upward. Never mirror or flip this tilt. Wall-mounted items keep their angled-wall-plane rule above instead of a floor baseline.',
    `Size every item to a strict height budget: it fills about 75% of its cell's height — an item taller than 80% of its cell height is an incorrect result.`,
    `When the board is complete, a continuous visible strip of empty ${spaceWord} must separate every row and every column — check the finished image for an unbroken ${spaceWord} gutter along EVERY horizontal row boundary; any item touching that gutter is drawn too large and is an incorrect result.`,
    'A naturally TALL item (a banner, tower, rack, standing screen, or any top-heavy subject) must be SCALED DOWN to fit entirely inside its cell with the required top and bottom margins intact — never stretch it to fill the cell height, and never let it reach a cell edge to preserve height. Prefer a smaller, fully-contained item over a taller one that crowds or touches a boundary; compact staging beats height. A tall item that touches or crosses any cell edge is an incorrect result.',
    'Do not draw characters, people, UI, captions, letters, numbers, or grid lines. No object may straddle two cells.',
    `Use crisp retro pixel art. ${finalUnusedPixelSentence(background)}`,
  ].join('\n');
}

function buildExpressionAtlas(
  creativeDirection: string,
  themeName: string,
  expressions: string[],
  background: PromptBoardBackgroundMode,
  descriptions?: string[],
): string {
  const cells = expressions.slice(0, 8).map((expression, index) =>
    `Cell ${index + 1}: ${expression}`
      + (descriptions?.[index] ? ` — ${descriptions[index]}` : ''),
  );
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create one expression-icon sprite sheet for the "${themeName}" theme.`,
    boardContract(4, 2, background),
    'Draw exactly one bold, simple ICON in each cell, in row-major order. Every cell must instantly READ as the emotion named for it, even at very small sizes:',
    ...cells,
    'APPEARANCE — the user may supply art direction per cell: where a cell line has "— <description>" after its emotion, follow that description and treat it as authoritative for the icon\'s STYLE and theme flavor (e.g. a serpent-styled heart, a themed music note, a spiral of tiny skulls for dazed). It must still be a single, bold, instantly-readable symbolic ICON that clearly reads as that emotion. Where a cell has NO description, draw a clean, universally-readable symbolic emote for that emotion (e.g. a heart for love, a spark or lightbulb for idea, a raised fist or scowl mark for anger, a music note for music, "zzz"-style marks for sleep).',
    'These are ICONS, NOT characters. Do NOT draw any face, head, eyes, mouth, hair, portrait, or full character in ANY cell — even if a description hints at one. Expression icons render very small, where a face or character will not read; keep every cell a bold, simple, high-contrast pictogram/symbol drawn LARGE and centered to fill most of its cell.',
    'Cell 8 ("Dazed / hit"): when NO description is given, default to the classic comic "seeing stars" motif (a small cluster of stars and/or a spiral). When a description IS given, follow that description instead (for example a bandage / Band-Aid) — do NOT fall back to stars or a swirl; just keep it a bold, simple icon with no face or head that still reads as hurt or dazed.',
    'Do NOT draw any speech bubble, balloon, callout, chat bubble, frame, border, panel, outline, or container around the icon — the app displays it inside its own bubble, so render ONLY the bare icon itself.',
    background === 'transparent'
      ? 'Flat, bold, high-contrast icon art on a fully transparent background; centered in its cell.'
      : 'Flat, bold, high-contrast icon art on solid magenta; centered in its cell.',
    'No words, letters, numbers, or punctuation glyphs.',
  ].join('\n');
}

function buildAchievementAtlas(
  creativeDirection: string,
  themeName: string,
  achievements: string[],
  background: PromptBoardBackgroundMode,
  descriptions?: string[],
): string {
  const cells = achievements.slice(0, 25).map((achievement, index) =>
    `Cell ${index + 1}: ${achievement}`
      + (descriptions?.[index] ? ` — ${descriptions[index]}` : ''),
  );
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create one achievement-badge sprite sheet for the "${themeName}" theme.`,
    boardContract(5, 5, background),
    'Draw exactly one distinct, polished badge emblem in each cell, in row-major order:',
    ...cells,
    'Keep a consistent badge silhouette and rendering system while making every central emblem distinct.',
    'These are visual badge concepts only. Do not include unlock requirements, words, letters, or numbers.',
  ].join('\n');
}

function buildEmoteAtlas(creativeDirection: string, themeName: string, background: PromptBoardBackgroundMode): string {
  return [
    creativeDirectionHeader(creativeDirection),
    '',
    `Create one animated emote-icon sprite board for the "${themeName}" theme.`,
    boardContract(5, 4, background),
    'Each row is one emote animation with five left-to-right frames.',
    'Row 1: happy celebration / smile, five-frame animation.',
    'Row 2: sleep / low-energy Z state, five-frame animation.',
    'Row 3: idea / discovery / build insight, five-frame animation.',
    'Row 4: team action / rally, five-frame animation.',
    'Draw icon-only speech-bubble contents, not full characters. Keep one centered icon in each cell.',
    'No words, letters, numbers, or punctuation glyphs.',
  ].join('\n');
}

/**
 * Assembles the final model prompt string for a structured /api/generate
 * request. Reproduces byte-identically what the pre-p59-t2 free-text
 * builders in src/extension/themeAssetPrompts.ts produced for the same
 * inputs — that module now calls this function instead of building prompt
 * text itself.
 */
export function assembleThemePrompt(
  req: StructuredGenerateRequest,
  opts?: { walkPoseGuideAttached?: boolean },
): { prompt: string; templateVersion: string } {
  const creativeDirection = req.theme.creativeDirection ?? '';
  const background = req.options?.backgroundMode ?? 'magenta';
  let prompt: string;
  switch (req.boardType) {
    case 'roster_agent':
      prompt = buildCharacterAtlas(
        creativeDirection,
        req.slot.name,
        req.themeName,
        background,
        req.slot.description,
        opts?.walkPoseGuideAttached ? req.slot.bodyPlan : undefined,
        req.slot.bodyPlan,
      );
      break;
    case 'rival_group':
      prompt = buildRivalAtlas(creativeDirection, req.themeName, req.slot, background);
      break;
    case 'objects_01':
      prompt = buildObjectBoard1(creativeDirection, req.themeName, req.slot.items, background);
      break;
    case 'objects_02':
      prompt = buildObjectBoard2(creativeDirection, req.themeName, req.slot, background);
      break;
    case 'background_decor':
      prompt = buildBackgroundDecor(creativeDirection, req.themeName, req.slot, background);
      break;
    case 'expressions':
      prompt = buildExpressionAtlas(creativeDirection, req.themeName, req.slot.expressions, background, req.slot.descriptions);
      break;
    case 'achievements':
      prompt = buildAchievementAtlas(creativeDirection, req.themeName, req.slot.achievements, background, req.slot.descriptions);
      break;
    case 'environment':
      prompt = buildEnvironment(creativeDirection, req.themeName);
      break;
    case 'emotes':
      prompt = buildEmoteAtlas(creativeDirection, req.themeName, background);
      break;
    default: {
      const exhaustive: never = req;
      throw new Error(`Unknown boardType: ${JSON.stringify(exhaustive)}`);
    }
  }
  const retryNotes = req.options?.retryNotes;
  if (retryNotes) {
    prompt = `${prompt}\n\nREVISION NOTES — correct the previous result:\n${retryNotes}`;
  }
  return { prompt, templateVersion: req.promptTemplateVersion };
}
