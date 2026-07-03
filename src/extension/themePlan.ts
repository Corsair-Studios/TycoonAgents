import type {
  AgentConfig,
  BuildableObject,
  DecorObject,
  RivalConfig,
  ThemeManifest,
  ViewportConfig,
} from '../shared/types';

export const THEME_CHARACTER_COUNT = 16;
export const THEME_ENEMY_COUNT = 12;
export const THEME_OBJECT_COUNT = 13;
export const THEME_EXPRESSION_COUNT = 16;
export const THEME_ACHIEVEMENT_COUNT = 20;
export const THEME_DECOR_COUNT = 9;

export type ClipName = 'walk'|'idle'|'sit'|'melee'|'build'|'tool_idle'|'shoot'|'dance'|'cheer'|'point'|'signal'|'dodge';

export interface AtlasClip {
  frames: number[];    // 1+ slot indices into the 20-cell character atlas
  fps: number;         // >0 for animated clips; 0 for a held single-frame pose
  loop: boolean;
  flippable: boolean;  // may be horizontally mirrored to face the other way
  pingpong?: boolean;  // optional: play forward then reverse
  hold?: boolean;       // optional: single static frame (frames.length===1)
}

export const ATLAS_CLIPS: Record<ClipName, AtlasClip> = {
  walk: { frames: [0, 1, 2, 3, 4], fps: 10, loop: true, flippable: true },
  idle: { frames: [16], fps: 0, loop: true, flippable: false, hold: true },
  sit: { frames: [15], fps: 0, loop: true, flippable: true, hold: true },
  melee: { frames: [5, 6, 7, 8], fps: 12, loop: false, flippable: true },
  build: { frames: [5, 6, 7, 8], fps: 6, loop: true, flippable: true },
  tool_idle: { frames: [9], fps: 0, loop: true, flippable: true, hold: true },
  shoot: { frames: [10, 11], fps: 8, loop: false, flippable: true, pingpong: true },
  dance: { frames: [17, 18, 19], fps: 6, loop: true, flippable: false, pingpong: true },
  cheer: { frames: [19], fps: 0, loop: true, flippable: false, hold: true },
  point: { frames: [12], fps: 0, loop: true, flippable: true, hold: true },
  signal: { frames: [13], fps: 0, loop: true, flippable: false, hold: true },
  dodge: { frames: [14], fps: 0, loop: false, flippable: true, hold: true },
};

export type ObjectClipName = 'object_idle' | 'crate' | 'poof';

export interface ObjectClip {
  frames: number[];
  fps: number;
  loop: boolean;
  hold?: boolean;
}

export const OBJECT_CLIPS: Record<ObjectClipName, ObjectClip> = {
  object_idle: { frames: [0, 1, 2, 3], fps: 5, loop: true },
  crate: { frames: [0], fps: 0, loop: true, hold: true },
  poof: { frames: [0, 1, 2, 3], fps: 12, loop: false },
};

export type RivalClipName = 'walk' | 'attack';

/**
 * Compact rival (enemy) clips. Enemies only need WALK + ATTACK, so each rival is
 * a 5-frame atlas — 2 walk frames (indices 0-1) + 3 attack frames (indices 2-4) —
 * packed 4 rivals per 5x4 board (each ROW = one enemy, cols 0-1 walk, cols 2-4 attack).
 *
 * IMPORTANT: this object is duplicated byte-for-byte in media/main.js (const RIVAL_CLIPS).
 * A parity test (test/mainPanelRivalClips.test.ts) fails if the two copies drift.
 */
export const RIVAL_CLIPS: Record<RivalClipName, AtlasClip> = {
  walk: { frames: [0, 1], fps: 8, loop: true, flippable: true },
  attack: { frames: [2, 3, 4], fps: 8, loop: false, flippable: true },
};

export interface ThemePlan {
  version: 1;
  theme_id: string;
  display_name: string;
  creative_direction: string;
  characters: string[];
  environment: string;
  objects: string[];
  /**
   * Optional per-object idle-motion phrases (same length/order as `objects`).
   * Threaded into each object row's motion_hint at prompt time; the ranged-weapon
   * rack (index 0) uses its own special rack guidance regardless of this value.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  object_motion_hints?: string[];
  decor: string[];
  enemies: string[];
  expressions: string[];
  achievements: string[];
}

/**
 * Background Decor board layout: a 4x4 (16-cell) sprite board.
 * - Row 1 (cells 0-3): four static sittable seats (single frame each).
 * - Row 2 (cells 4-7): four static scenery/decor items (single frame each).
 * - Row 3 (cells 8-11): one animated decor item across four loopable frames.
 * - Row 4 (cells 12-15): the ranged-weapon-fire projectile FX (four one-shot frames),
 *   sliced into frames['projectile'] — NOT a decor object.
 * Total = 9 decor items (4 seats + 4 static + 1 animated); row 4 is FX, not decor.
 */
export const DECOR_BOARD_LAYOUT = {
  columns: 4,
  rows: 4,
  seatCount: 4,
  staticDecorCount: 4,
  animatedItemCount: 1,
  animFps: 5,
} as const;

/** Normalized scene-space offset from a seat's anchor where a seated character's base sits. */
export const DECOR_SEAT_SIT_ANCHOR: [number, number] = [0, -0.03];

const WALKABLE_NAV_POLYGON: [number, number][] = [
  [0.50, 0.15],
  [0.88, 0.38],
  [0.88, 0.82],
  [0.50, 0.95],
  [0.12, 0.82],
  [0.12, 0.38],
];

export function normalizeThemePlan(input: Partial<ThemePlan>, fallbackName = 'Custom Theme'): ThemePlan {
  const displayName = cleanValue(input.display_name) || cleanValue(fallbackName) || 'Custom Theme';
  const themeId = toSafeThemeId(input.theme_id || displayName);
  const { objects, objectMotionHints } = reserveRangedWeaponRackSlot(
    input.objects,
    displayName,
    input.object_motion_hints,
  );
  return {
    version: 1,
    theme_id: themeId,
    display_name: displayName,
    creative_direction: cleanValue(input.creative_direction)
      || `A cohesive game-art interpretation of ${displayName}.`,
    characters: normalizeNames(input.characters, THEME_CHARACTER_COUNT, 'Character'),
    environment: cleanValue(input.environment)
      || `A playable isometric environment inspired by ${displayName}.`,
    objects,
    object_motion_hints: objectMotionHints,
    decor: normalizeNames(input.decor, THEME_DECOR_COUNT, 'Decor'),
    enemies: normalizeNames(input.enemies, THEME_ENEMY_COUNT, 'Enemy'),
    expressions: normalizeNames(input.expressions, THEME_EXPRESSION_COUNT, 'Expression'),
    achievements: normalizeNames(input.achievements, THEME_ACHIEVEMENT_COUNT, 'Achievement Badge'),
  };
}

export function themePlanCreativeDirection(plan: ThemePlan): string {
  return [
    `Theme: ${plan.display_name}`,
    `Creative direction: ${plan.creative_direction}`,
    `Environment direction: ${plan.environment}`,
  ].join('\n');
}

export function themePlanToManifest(plan: ThemePlan): Partial<ThemeManifest> {
  const rosterAgents: AgentConfig[] = plan.characters.map((name, slotId) => ({
    slot_id: slotId,
    name,
    atlas_asset: `frames.json#agent_${slotId}`,
    preferred_idle_pose: 'pose_crossed',
  }));
  const rivalIds = uniqueIds(
    plan.enemies.map((name) => toSafeAssetId(name).replace(/^(?:rival|enemy)_/, '')),
    'enemy',
  );
  const rosterRivals: RivalConfig[] = plan.enemies.map((name, index) => ({
    rival_id: `rival_${rivalIds[index]}`,
    name,
    atlas_asset: `frames.json#rival_${rivalIds[index]}`,
  }));
  const objectIds = uniqueIds(plan.objects, 'object');
  const buildableObjects: BuildableObject[] = plan.objects.map((displayName, index) => ({
    build_order: index,
    object_id: objectIds[index],
    display_name: displayName,
    sprite_asset: `frames.json#object_${objectIds[index]}`,
    anchor_coord: [0.5, 0.5],
    exclusion_radius: 32,
    work_units_required: 100,
    anim_fps: 5,
    anim_loop: true,
  }));
  const decorObjects = buildDecorObjects(plan.decor);
  const viewport: ViewportConfig = {
    native_width: 1280,
    native_height: 720,
    background_asset: 'frames.json#environment_background',
    crate_asset: 'frames.json#crate',
    poof_asset: 'frames.json#poof',
    projectile_asset: 'frames.json#projectile',
    walkable_nav_polygon: WALKABLE_NAV_POLYGON,
    overall_scale: 1,
    enemy_config: { spawn_interval_seconds: 45, count_mode: 'random' },
  };
  return {
    display_name: plan.display_name,
    roster_agents: rosterAgents,
    roster_rivals: rosterRivals,
    buildable_objects: buildableObjects,
    decor_objects: decorObjects,
    viewport,
  };
}

/**
 * Emit the fixed 9-entry decor roster in board order:
 *   indices 0-3  → sittable seats (row 1, single-frame static)
 *   indices 4-7  → static decor    (row 2, single-frame static)
 *   index 8      → animated decor  (row 3, four loopable frames)
 * Row 4 of the board is the ranged-weapon-fire projectile FX (not a decor object).
 * decor_ids are deterministic: seats prefixed "seat", the rest "decor",
 * de-duplicated together so no two frame keys collide.
 */
export function buildDecorObjects(names: string[]): DecorObject[] {
  const { seatCount, staticDecorCount, animFps } = DECOR_BOARD_LAYOUT;
  const decorIds = uniqueIds(
    names.map((name, index) => index < seatCount ? `seat_${toSafeAssetId(name)}` : `decor_${toSafeAssetId(name)}`),
    'decor',
  );
  return names.map((displayName, index) => {
    const decorId = decorIds[index];
    const isSeat = index < seatCount;
    const isAnimated = index >= seatCount + staticDecorCount;
    const decor: DecorObject = {
      decor_id: decorId,
      display_name: displayName,
      sprite_asset: `frames.json#decor_${decorId}`,
      anchor_coord: [0.5, 0.5],
    };
    if (isSeat) {
      decor.is_sittable = true;
      decor.sit_anchor = [DECOR_SEAT_SIT_ANCHOR[0], DECOR_SEAT_SIT_ANCHOR[1]];
    }
    if (isAnimated) {
      decor.anim_fps = animFps;
      decor.anim_loop = true;
    }
    return decor;
  });
}

export function toSafeThemeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'custom_theme';
}

export function toSafeAssetId(value: string): string {
  return toSafeThemeId(value) || 'asset';
}

/**
 * Slot 0 of the objects list is a load-bearing convention: the buildable object
 * with build_order === 0 is treated at runtime as the "ranged weapon rack" — once
 * built, every character upgrades from melee to ranged combat. Therefore the FIRST
 * object of every theme MUST be a themed rack of ranged weapons (laser rifles, missiles,
 * crossbows, etc.), regardless of theme. This reserves slot 0 for that rack while the
 * remaining 12 slots come from the plan, keeping the total at THEME_OBJECT_COUNT (13).
 */
function reserveRangedWeaponRackSlot(
  values: unknown,
  displayName: string,
  motionHints?: unknown,
): { objects: string[]; objectMotionHints?: string[] } {
  const rawSource = (Array.isArray(values) ? values : []).map((value) => cleanValue(value));
  const rawHints = Array.isArray(motionHints) ? motionHints.map((value) => cleanValue(value)) : [];
  // Pair each name with its planner-supplied motion hint before filtering blanks,
  // so hints stay aligned to their object even after empty names are dropped.
  const paired = rawSource
    .map((name, index) => ({ name, hint: rawHints[index] ?? '' }))
    .filter((entry) => entry.name.length > 0);

  const first = paired[0]?.name ?? '';
  // Keep the planner's first name if it already reads as a ranged weapon rack and
  // consume it as slot 0; otherwise coerce slot 0 to a themed default and keep the
  // planner's own objects (including its first) among the 12 remaining free slots.
  const hasRack = looksLikeRangedWeaponRack(first);
  const rack = hasRack ? first : `${displayName} Ranged Weapon Rack`;
  const rackHint = hasRack ? paired[0]?.hint ?? '' : '';
  const rest = hasRack ? paired.slice(1) : paired;

  const restNames = normalizeNames(rest.map((entry) => entry.name), THEME_OBJECT_COUNT - 1, 'Object');
  const objects = [rack, ...restNames].slice(0, THEME_OBJECT_COUNT);
  // Align hints to the final object list: rack hint first, then the rest's hints
  // in order, padded with empty strings so index i maps to objects[i].
  const hints = [rackHint, ...rest.map((entry) => entry.hint)].slice(0, THEME_OBJECT_COUNT);
  while (hints.length < objects.length) hints.push('');
  const hasAnyHint = hints.some((hint) => hint.length > 0);
  return { objects, objectMotionHints: hasAnyHint ? hints : undefined };
}

/** Heuristic: does a name describe a rack/rack-like store of RANGED weapons? */
function looksLikeRangedWeaponRack(name: string): boolean {
  const text = name.toLowerCase();
  const isRack = /\b(rack|stand|armory|armoury|locker|cache|arsenal|shelf|rangefinder)\b/.test(text)
    || /\bweapon(s)?\s+(rack|stand|shelf|locker)\b/.test(text);
  const isRanged = /\b(ranged|rifle|blaster|laser|plasma|gun|guns|missile|rocket|bow|crossbow|cannon|dart|slingshot|shooter|firearm|musket|bolt|arrow)\b/.test(text);
  return isRack && isRanged;
}

function normalizeNames(values: unknown, count: number, fallbackLabel: string): string[] {
  const source = Array.isArray(values) ? values : [];
  const result = source
    .map((value) => cleanValue(value))
    .filter((value) => value.length > 0)
    .slice(0, count);
  while (result.length < count) result.push(`${fallbackLabel} ${result.length + 1}`);
  return result;
}

function uniqueIds(names: string[], fallback: string): string[] {
  const used = new Set<string>();
  return names.map((name, index) => {
    const base = toSafeAssetId(name) || `${fallback}_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    return candidate;
  });
}

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}
