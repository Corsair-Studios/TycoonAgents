import type { ThemeDecorBoardRow, ThemeObjectBoardRow, ThemeRivalBoardRow } from './themeImageReviewState';
import type { BodyPlan } from '../core/bodyPlan';
import {
  assembleThemePrompt,
  boardBackgroundPaddingAdjective as coreBoardBackgroundPaddingAdjective,
  CHARACTER_TARGET_CONTENT_HEIGHT,
  CHARACTER_TARGET_CONTENT_PERCENT,
  PROMPT_TEMPLATE_VERSION,
  type PromptBoardBackgroundMode,
  type PromptRowSpec,
  type StructuredGenerateRequest,
} from '../core/themePromptTemplates';

export { CHARACTER_TARGET_CONTENT_HEIGHT, CHARACTER_TARGET_CONTENT_PERCENT };

/**
 * Board background fill mode. 'magenta' is the legacy #FF00FF chroma-key
 * contract (the only format Gemini/"nano banana" can produce, since it can't
 * emit alpha). 'transparent' asks for true alpha-0 pixels, used only when the
 * OpenAI provider (gpt-image-1/2, which supports native transparent
 * backgrounds) will run the generation. Defaults to 'magenta' everywhere so
 * existing callers and tests keep their current behavior unless they opt in.
 */
export type BoardBackgroundMode = PromptBoardBackgroundMode;

/**
 * Adjective phrase for "___ padding" used outside this module (themeService's
 * character-normalize retry notes), so freeform revision text stays
 * consistent with whichever background mode the original board was baked with.
 */
export function boardBackgroundPaddingAdjective(background: BoardBackgroundMode): string {
  return coreBoardBackgroundPaddingAdjective(background);
}

/** Base fields shared by every StructuredGenerateRequest built here (p59-t2 adapters). */
function baseRequest(creativeDirection: string, themeName: string, background: BoardBackgroundMode) {
  return {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    theme: { description: themeName, creativeDirection },
    themeName,
    options: { backgroundMode: background },
  } as const;
}

function toRowSpec(row: { display_name: string; visual_description?: string; motion_hint?: string; is_ranged_rack?: boolean }): PromptRowSpec {
  return {
    display_name: row.display_name,
    ...(row.visual_description ? { visual_description: row.visual_description } : {}),
    ...(row.motion_hint ? { motion_hint: row.motion_hint } : {}),
    ...(row.is_ranged_rack ? { is_ranged_rack: true } : {}),
  };
}

export interface ThemeRivalPromptSpec {
  rival_id: string;
  display_name: string;
  /** Concrete visual-appearance spec from the plan (silhouette, colors, materials, signature features). */
  visual_description?: string;
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
  /** Concrete visual-appearance spec from the plan (silhouette, colors, materials, signature features). */
  visual_description?: string;
}

export interface ThemeDecorPromptSpec {
  decor_id: string;
  display_name: string;
  /** Concrete visual-appearance spec from the plan (silhouette, colors, materials, signature features). */
  visual_description?: string;
}

/**
 * v3 object pipeline: exactly TWO fixed-shape 4x4 (16-cell) boards.
 *   - Board 1 ("objects_01"): OBJECT_BOARD1_STATIC_COUNT (16) single-frame
 *     static objects, one per cell in row-major order.
 *   - Board 2 ("objects_02"): OBJECT_ANIMATED_COUNT (2) animated objects (4
 *     frames each, rows 1-2), an OBJECT_POOF_FRAME_COUNT (4)-frame POOF (row
 *     3, cells 9-12), OBJECT_BOARD2_STATIC_COUNT (3) single-frame static
 *     objects (row 4, cells 13-15), and a 1-frame CRATE (cell 16).
 * Total buildable objects = OBJECT_STATIC_COUNT (19) + OBJECT_ANIMATED_COUNT
 * (2) = 21 (== THEME_OBJECT_COUNT in themePlan.ts). OBJECT_STATIC_COUNT ==
 * OBJECT_BOARD1_STATIC_COUNT + OBJECT_BOARD2_STATIC_COUNT (16 + 3 = 19).
 */
export const OBJECT_STATIC_COUNT = 19;
export const OBJECT_ANIMATED_COUNT = 2;
export const OBJECT_BOARD1_STATIC_COUNT = 16;
export const OBJECT_BOARD2_STATIC_COUNT = 3;
/** Frame count of the one-shot build-completion POOF FX (board 2, row 3 / cells 9-12). */
export const OBJECT_POOF_FRAME_COUNT = 4;

/** Board 1: OBJECT_BOARD1_STATIC_COUNT single-frame static objects, one per cell. */
export function createObjectBoard1Rows(objects: ThemeObjectPromptSpec[]): ThemeObjectBoardRow[] {
  if (objects.length !== OBJECT_BOARD1_STATIC_COUNT) {
    throw new Error(`Object board 1 requires exactly ${OBJECT_BOARD1_STATIC_COUNT} static objects.`);
  }
  return objects.map((object): ThemeObjectBoardRow => ({
    kind: 'object_static',
    object_id: object.object_id,
    display_name: object.display_name,
    ...(object.motion_hint ? { motion_hint: object.motion_hint } : {}),
    ...(object.is_ranged_rack ? { is_ranged_rack: true } : {}),
    ...(object.visual_description ? { visual_description: object.visual_description } : {}),
  }));
}

/**
 * Board 2: exactly OBJECT_ANIMATED_COUNT animated objects (rows 1-2, 4 frames
 * each), the fixed poof entry (row 3), OBJECT_BOARD2_STATIC_COUNT static
 * objects (the first 3 cells of row 4), and the fixed crate entry (the last
 * cell of row 4). The exact cell ranges are implicit in this fixed layout —
 * see buildObjectBoard2Prompt / processObjectAtlas / applyObjectBoardFrames.
 */
export function createObjectBoard2Rows(
  animatedObjects: ThemeObjectPromptSpec[],
  staticObjects: ThemeObjectPromptSpec[],
  // Optional single-string appearance specs for the fixed poof/crate cells
  // (plan.poof_description / plan.crate_description — see themePlan.ts).
  // Absent/undefined leaves those rows with no visual_description, so the
  // generated prompt is byte-identical to before this parameter existed.
  poofDescription?: string,
  crateDescription?: string,
): ThemeObjectBoardRow[] {
  if (animatedObjects.length !== OBJECT_ANIMATED_COUNT) {
    throw new Error(`Object board 2 requires exactly ${OBJECT_ANIMATED_COUNT} animated objects.`);
  }
  if (staticObjects.length !== OBJECT_BOARD2_STATIC_COUNT) {
    throw new Error(`Object board 2 requires exactly ${OBJECT_BOARD2_STATIC_COUNT} static objects.`);
  }
  const animRows = animatedObjects.map((object): ThemeObjectBoardRow => ({
    kind: 'object_anim',
    object_id: object.object_id,
    display_name: object.display_name,
    ...(object.motion_hint ? { motion_hint: object.motion_hint } : {}),
    ...(object.visual_description ? { visual_description: object.visual_description } : {}),
  }));
  const staticRows = staticObjects.map((object): ThemeObjectBoardRow => ({
    kind: 'object_static',
    object_id: object.object_id,
    display_name: object.display_name,
    ...(object.motion_hint ? { motion_hint: object.motion_hint } : {}),
    ...(object.is_ranged_rack ? { is_ranged_rack: true } : {}),
    ...(object.visual_description ? { visual_description: object.visual_description } : {}),
  }));
  const poofRow: ThemeObjectBoardRow = {
    kind: 'poof',
    ...(poofDescription?.trim() ? { visual_description: poofDescription.trim() } : {}),
  };
  const crateRow: ThemeObjectBoardRow = {
    kind: 'crate',
    ...(crateDescription?.trim() ? { visual_description: crateDescription.trim() } : {}),
  };
  return [...animRows, poofRow, ...staticRows, crateRow];
}

/**
 * Frame keys for either board's `object_rows` array: `object_static`/
 * `object_anim` entries map to `object_<id>`; `poof`/`crate` map to their own
 * fixed key name.
 */
export function objectBoardFrameKeys(rows: ThemeObjectBoardRow[]): string[] {
  return rows.map((row) => (
    row.kind === 'object_static' || row.kind === 'object_anim' ? `object_${row.object_id}` : row.kind
  ));
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
    ...(item.visual_description ? { visual_description: item.visual_description } : {}),
  }));
  const statics = decor.slice(4, 8).map((item): ThemeDecorBoardRow => ({
    kind: 'decor', decor_id: item.decor_id, display_name: item.display_name,
    ...(item.visual_description ? { visual_description: item.visual_description } : {}),
  }));
  const anim: ThemeDecorBoardRow = {
    kind: 'decor_anim', decor_id: decor[8].decor_id, display_name: decor[8].display_name,
    ...(decor[8].visual_description ? { visual_description: decor[8].visual_description } : {}),
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
      ...(rival.visual_description ? { visual_description: rival.visual_description } : {}),
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
  return assembleThemePrompt(buildRivalAtlasRequest(creativeDirection, themeName, rows, background)).prompt;
}

/** p59-t3: the StructuredGenerateRequest for a rival board, exposed so callers can send it to the v3.4 /api/generate endpoint directly instead of only its assembled prompt string. */
export function buildRivalAtlasRequest(
  creativeDirection: string,
  themeName: string,
  rows: ThemeRivalBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): StructuredGenerateRequest {
  if (rows.length < 1 || rows.length > RIVALS_PER_BOARD) {
    throw new Error('Rival boards carry one to four enemy rows.');
  }
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'rival_group',
    slot: rows.map(toRowSpec),
  };
}

export interface CharacterAtlasPromptOptions {
  /**
   * p58-t2: set only when a walk pose-guide reference image is actually
   * attached to this attempt (see themeService.ts's
   * attachWalkPoseGuideReference / poseGuides.ts's loadWalkPoseGuide).
   * Inserts the matching WALK_POSE_GUIDE_PARAGRAPHS entry
   * (src/core/walkPoseGuidePrompts.ts) into row 1's instructions. Absent (the
   * default) leaves row 1's text exactly as before.
   */
  walkPoseGuide?: BodyPlan;
}

export function buildCharacterAtlasPrompt(
  creativeDirection: string,
  characterName: string,
  themeName: string,
  background: BoardBackgroundMode = 'magenta',
  visualDescription?: string,
  options?: CharacterAtlasPromptOptions,
): string {
  const req = buildCharacterAtlasRequest(creativeDirection, characterName, themeName, background, visualDescription, options);
  return assembleThemePrompt(req, { walkPoseGuideAttached: options?.walkPoseGuide !== undefined }).prompt;
}

/** p59-t3: the StructuredGenerateRequest for a character atlas board. */
export function buildCharacterAtlasRequest(
  creativeDirection: string,
  characterName: string,
  themeName: string,
  background: BoardBackgroundMode = 'magenta',
  visualDescription?: string,
  options?: CharacterAtlasPromptOptions,
): StructuredGenerateRequest {
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'roster_agent',
    slot: {
      name: characterName,
      bodyPlan: options?.walkPoseGuide ?? 'biped',
      ...(visualDescription ? { description: visualDescription } : {}),
    },
  };
}

export function buildEnvironmentPrompt(
  creativeDirection: string,
  themeName: string,
): string {
  return assembleThemePrompt(buildEnvironmentRequest(creativeDirection, themeName)).prompt;
}

/** p59-t3: the StructuredGenerateRequest for the environment board. */
export function buildEnvironmentRequest(creativeDirection: string, themeName: string): StructuredGenerateRequest {
  return {
    ...baseRequest(creativeDirection, themeName, 'magenta'),
    boardType: 'environment',
  };
}

/**
 * Object board dispatcher: board 1's `object_rows` are all `object_static`
 * (20 single-frame cells); board 2's carry `object_anim`/`poof`/`crate`
 * entries. Both callers (createReviewItems / buildReplacementPrompt) already
 * know which board they are building from the reconstructed `rows`, so this
 * inspects the row shape rather than requiring a separate board-number param.
 */
export function buildObjectAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  rows: ThemeObjectBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): string {
  const isBoard2 = rows.some((row) => row.kind === 'object_anim' || row.kind === 'poof' || row.kind === 'crate');
  return isBoard2
    ? buildObjectBoard2Prompt(creativeDirection, themeName, rows, background)
    : buildObjectBoard1Prompt(creativeDirection, themeName, rows, background);
}

/** p59-t3: the StructuredGenerateRequest for either object board, dispatched the same way as {@link buildObjectAtlasPrompt}. */
export function buildObjectAtlasRequest(
  creativeDirection: string,
  themeName: string,
  rows: ThemeObjectBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): StructuredGenerateRequest {
  const isBoard2 = rows.some((row) => row.kind === 'object_anim' || row.kind === 'poof' || row.kind === 'crate');
  return isBoard2
    ? buildObjectBoard2Request(creativeDirection, themeName, rows, background)
    : buildObjectBoard1Request(creativeDirection, themeName, rows, background);
}

/**
 * Board 1 ("objects_01"): OBJECT_BOARD1_STATIC_COUNT (16) distinct STATIC
 * buildable objects, one per cell in row-major order (Cell 1..16) on a 4x4
 * grid. Each cell is a single, fully-built theme structure — no animation.
 */
export function buildObjectBoard1Prompt(
  creativeDirection: string,
  themeName: string,
  rows: ThemeObjectBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): string {
  return assembleThemePrompt(buildObjectBoard1Request(creativeDirection, themeName, rows, background)).prompt;
}

/** p59-t3: the StructuredGenerateRequest for object board 1. */
export function buildObjectBoard1Request(
  creativeDirection: string,
  themeName: string,
  rows: ThemeObjectBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): StructuredGenerateRequest {
  if (rows.length !== OBJECT_BOARD1_STATIC_COUNT) {
    throw new Error(`Object board 1 requires exactly ${OBJECT_BOARD1_STATIC_COUNT} static-object cells.`);
  }
  const items = rows.map((row) => {
    if (row.kind !== 'object_static') throw new Error('Object board 1 cells must all be static objects.');
    return toRowSpec(row);
  });
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'objects_01',
    slot: { items },
  };
}

/**
 * Board 2 ("objects_02"): a 4x4 grid mixing four roles — two animated objects
 * (row 1 = Cells 1-4, row 2 = Cells 5-8; 4 frames each, lights/highlights-only
 * motion), a 4-frame one-shot build-completion POOF filling row 3 (Cells
 * 9-12), OBJECT_BOARD2_STATIC_COUNT (3) static objects in the first three
 * cells of row 4 (Cells 13-15), and a single static CRATE in the final Cell 16.
 */
export function buildObjectBoard2Prompt(
  creativeDirection: string,
  themeName: string,
  rows: ThemeObjectBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): string {
  return assembleThemePrompt(buildObjectBoard2Request(creativeDirection, themeName, rows, background)).prompt;
}

/** p59-t3: the StructuredGenerateRequest for object board 2. */
export function buildObjectBoard2Request(
  creativeDirection: string,
  themeName: string,
  rows: ThemeObjectBoardRow[],
  background: BoardBackgroundMode = 'magenta',
): StructuredGenerateRequest {
  const [rowA, rowB, poofRow, staticC, staticD, staticE, crateRow] = rows;
  if (
    rows.length !== OBJECT_ANIMATED_COUNT + OBJECT_BOARD2_STATIC_COUNT + 2
    || rowA?.kind !== 'object_anim' || rowB?.kind !== 'object_anim'
    || poofRow?.kind !== 'poof'
    || staticC?.kind !== 'object_static' || staticD?.kind !== 'object_static' || staticE?.kind !== 'object_static'
    || crateRow?.kind !== 'crate'
  ) {
    throw new Error('Object board 2 requires exactly two animated objects, one poof entry, three static objects, and one crate entry.');
  }
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'objects_02',
    slot: {
      animated: [toRowSpec(rowA), toRowSpec(rowB)],
      static: [toRowSpec(staticC), toRowSpec(staticD), toRowSpec(staticE)],
      ...(poofRow.visual_description ? { poofDescription: poofRow.visual_description } : {}),
      ...(crateRow.visual_description ? { crateDescription: crateRow.visual_description } : {}),
    },
  };
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
  // Optional single-string appearance spec for the row-4 projectile FX
  // (plan.projectile_description — see themePlan.ts). Absent/undefined leaves
  // the row's prompt text byte-identical to before this parameter existed.
  projectileDescription?: string,
): string {
  return assembleThemePrompt(
    buildBackgroundDecorRequest(creativeDirection, themeName, rows, background, projectileDescription),
  ).prompt;
}

/** p59-t3: the StructuredGenerateRequest for the background-decor board. */
export function buildBackgroundDecorRequest(
  creativeDirection: string,
  themeName: string,
  rows: ThemeDecorBoardRow[][],
  background: BoardBackgroundMode = 'magenta',
  projectileDescription?: string,
): StructuredGenerateRequest {
  if (rows.length !== 4) throw new Error('Background decor boards require exactly four rows.');
  const [seatRow, staticRow, animRow3, projectileRow] = rows;
  if (seatRow.length !== 4 || staticRow.length !== 4 || animRow3.length !== 1
    || projectileRow.length !== 1 || projectileRow[0].kind !== 'projectile') {
    throw new Error('Background decor board layout must be 4 seats, 4 static decor, 1 animated decor, and 1 projectile FX row.');
  }
  const animDecor = animRow3[0];
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'background_decor',
    slot: {
      seats: seatRow.map((row) => toRowSpec(row as Extract<ThemeDecorBoardRow, { display_name: string }>)) as [PromptRowSpec, PromptRowSpec, PromptRowSpec, PromptRowSpec],
      statics: staticRow.map((row) => toRowSpec(row as Extract<ThemeDecorBoardRow, { display_name: string }>)) as [PromptRowSpec, PromptRowSpec, PromptRowSpec, PromptRowSpec],
      animated: toRowSpec(animDecor.kind === 'projectile' ? { display_name: '' } : animDecor),
      ...(projectileDescription ? { projectileDescription } : {}),
    },
  };
}

export function buildExpressionAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  expressions: string[],
  background: BoardBackgroundMode = 'magenta',
  descriptions?: string[],
): string {
  return assembleThemePrompt(
    buildExpressionAtlasRequest(creativeDirection, themeName, expressions, background, descriptions),
  ).prompt;
}

/** p59-t3: the StructuredGenerateRequest for the expression atlas board. */
export function buildExpressionAtlasRequest(
  creativeDirection: string,
  themeName: string,
  expressions: string[],
  background: BoardBackgroundMode = 'magenta',
  descriptions?: string[],
): StructuredGenerateRequest {
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'expressions',
    slot: { expressions, ...(descriptions ? { descriptions } : {}) },
  };
}

export function buildAchievementAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  achievements: string[],
  background: BoardBackgroundMode = 'magenta',
  descriptions?: string[],
): string {
  return assembleThemePrompt(
    buildAchievementAtlasRequest(creativeDirection, themeName, achievements, background, descriptions),
  ).prompt;
}

/** p59-t3: the StructuredGenerateRequest for the achievement atlas board. */
export function buildAchievementAtlasRequest(
  creativeDirection: string,
  themeName: string,
  achievements: string[],
  background: BoardBackgroundMode = 'magenta',
  descriptions?: string[],
): StructuredGenerateRequest {
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'achievements',
    slot: { achievements, ...(descriptions ? { descriptions } : {}) },
  };
}

/** Legacy four-emote animation prompt retained for retries of older themes. */
export function buildEmoteAtlasPrompt(
  creativeDirection: string,
  themeName: string,
  background: BoardBackgroundMode = 'magenta',
): string {
  return assembleThemePrompt(buildEmoteAtlasRequest(creativeDirection, themeName, background)).prompt;
}

/** p59-t3: the StructuredGenerateRequest for the emote atlas board. */
export function buildEmoteAtlasRequest(
  creativeDirection: string,
  themeName: string,
  background: BoardBackgroundMode = 'magenta',
): StructuredGenerateRequest {
  return {
    ...baseRequest(creativeDirection, themeName, background),
    boardType: 'emotes',
  };
}
