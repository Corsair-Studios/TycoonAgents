import type {
  AgentConfig,
  BuildableObject,
  DecorObject,
  RivalConfig,
  ThemeManifest,
  ViewportConfig,
} from '../shared/types';

export const THEME_CHARACTER_COUNT = 16;
export const THEME_ENEMY_COUNT = 4; // one full enemy board of RIVALS_PER_BOARD (4)
export const THEME_OBJECT_COUNT = 21;
export const THEME_EXPRESSION_COUNT = 8;
/**
 * All 8 cells of the expression board are PINNED to a fixed universal
 * meaning (see applyFixedExpressionLabels) so the runtime can reliably map
 * gameplay events to them regardless of what the LLM would otherwise name
 * them. This is the full expression contract now — no theme-flavor cells
 * remain. Order matters: index == expression_N frame key, and the runtime
 * (media/main.js) depends on this exact pin order.
 */
export const FIXED_EXPRESSION_LABELS = [
  'Love',
  'Idea / discovery spark',
  'Anger',
  'Team action / rally',
  'Thumbs up',
  'Music',
  'Sleep / low-energy zzz',
  'Dazed / hit',
] as const;
export const THEME_ACHIEVEMENT_COUNT = 25;
export const THEME_DECOR_COUNT = 9;

/**
 * Strip a LEADING occurrence of `name` from `description` (case-insensitive),
 * so a generated visual description doesn't repeat the slot's own display
 * name (redundant for a visual spec, invites text rendering, and would feed
 * a bare name into the likeness precheck). Matches the full name first, then
 * the name with any trailing parenthetical dropped (e.g. "Marek Drills
 * (heavy-builder)" also matches a description starting "Marek Drills:"), each
 * followed by a word boundary (so "Robot" does not match "Robotic arm…"),
 * then one separator: ":", "–", "—", "," or "." with optional surrounding
 * whitespace, or "-" which requires whitespace on BOTH sides (" - ") so a
 * hyphenated compound like "Torch-lit sconce" is left alone for name
 * "Torch". Only a PREFIX match is stripped — the same name appearing
 * mid-text is left alone. If stripping would leave the description empty,
 * the original is returned unchanged. The first letter of the result is
 * capitalized.
 */
export function stripLeadingName(name: string, description: string): string {
  const cleanedName = typeof name === 'string' ? name.trim() : '';
  const cleanedDesc = typeof description === 'string' ? description.trim() : '';
  if (!cleanedName || !cleanedDesc) return description;

  const withoutParen = cleanedName.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const candidates = [cleanedName, withoutParen].filter(
    (candidate, index, arr) => candidate.length > 0 && arr.indexOf(candidate) === index,
  );
  // Longest candidate first so the full name is preferred over its
  // parenthetical-stripped variant when both would match.
  candidates.sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\b(?:\\s*[:–—,.]\\s*|\\s+-\\s+)`, 'i');
    const match = cleanedDesc.match(re);
    if (match) {
      const rest = cleanedDesc.slice(match[0].length).trim();
      if (rest.length > 0) {
        return rest.charAt(0).toUpperCase() + rest.slice(1);
      }
    }
  }
  return description;
}

export type ClipName = 'walk'|'idle'|'sit'|'melee'|'build'|'tool_idle'|'shoot'|'dance'|'cheer'|'point'|'signal'|'block'|'stand_back';

export interface AtlasClip {
  frames: number[];    // 1+ slot indices into the 20-cell character atlas
  fps: number;         // >0 for animated clips; 0 for a held single-frame pose
  loop: boolean;
  flippable: boolean;  // may be horizontally mirrored to face the other way
  pingpong?: boolean;  // optional: play forward then reverse
  hold?: boolean;       // optional: single static frame (frames.length===1)
}

// Row-1 cells 1-4 of the character atlas are a four-frame walk cycle
// (see buildCharacterAtlasPrompt in themeAssetPrompts.ts); cell 5 stays the
// back view. Mirror any change here in media/main.js's ATLAS_CLIPS.
export const ATLAS_CLIPS: Record<ClipName, AtlasClip> = {
  walk: { frames: [0, 1, 2, 3], fps: 10, loop: true, flippable: true },
  idle: { frames: [16], fps: 0, loop: true, flippable: false, hold: true },
  sit: { frames: [15], fps: 0, loop: true, flippable: true, hold: true },
  melee: { frames: [10, 11], fps: 12, loop: false, flippable: true },
  build: { frames: [5, 6, 7, 8], fps: 6, loop: true, flippable: true },
  tool_idle: { frames: [9], fps: 0, loop: true, flippable: true, hold: true },
  shoot: { frames: [12, 13], fps: 3, loop: true, flippable: true, pingpong: false },
  dance: { frames: [17, 18, 19], fps: 6, loop: true, flippable: false, pingpong: true },
  cheer: { frames: [19], fps: 0, loop: true, flippable: false, hold: true },
  point: { frames: [9], fps: 0, loop: true, flippable: true, hold: true },
  signal: { frames: [19], fps: 0, loop: true, flippable: false, hold: true },
  // Idle ambient combat: brief block/flinch hit-reaction pose. Frame 14 is the
  // block clip's OWN dedicated dodge/flinch frame (no longer part of the melee
  // clip), played as a one-shot emote override — see media/main.js
  // playEmote(entry, "block", ...). Purely cosmetic, no gameplay effect.
  block: { frames: [14], fps: 6, loop: false, flippable: true },
  // Cell 5 (back view). Only played when the active theme's manifest
  // carries freed_frames: 'v2' (see themeHasFreedFrames) — themes generated
  // before this change never play it.
  stand_back: { frames: [4], fps: 0, loop: true, flippable: false, hold: true },
};

// Manifest opt-in gating the "stand_back" pose (row-1 cell 5, back view).
// Absent or any other value means "never play stand_back" for that theme.
// The row-1 idle_rare clip (formerly gated on this same flag) was removed;
// this function still parses the field harmlessly for old manifests.
export function themeHasFreedFrames(manifest: Pick<ThemeManifest, 'freed_frames'> | { freed_frames?: string } | null | undefined): boolean {
  return !!manifest && manifest.freed_frames === 'v2';
}

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
  // 4-frame one-shot build-completion puff (v3 object pipeline, objects_02
  // board row 3 / cells 9-12): small puff -> full burst -> dissipate.
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
  /**
   * Optional per-character concrete visual-appearance spec (same length/order as
   * `characters`): silhouette/form, primary + accent colors, materials/finish,
   * and 1-2 signature identifying features. Threaded into buildCharacterAtlasPrompt
   * so the image model depicts a specific design instead of guessing from the name.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  character_descriptions?: string[];
  /**
   * Optional per-character explicit body plan (same length/order as
   * `characters`, positional — index === slot_id). Undefined at an index
   * means the user has not set it for that slot; the effective body plan is
   * then inferred from character_descriptions[index] via
   * src/core/bodyPlan.ts's inferBodyPlan. A user-set value here is never
   * overwritten by the heuristic. Internal plan field only — NOT part of the
   * immutable shared/types contract.
   */
  character_body_plans?: Array<'biped' | 'quadruped' | undefined>;
  environment: string;
  objects: string[];
  /**
   * Optional per-object idle-motion phrases (same length/order as `objects`).
   * Threaded into each object row's motion_hint at prompt time; the ranged-weapon
   * rack (index 0) uses its own special rack guidance regardless of this value.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  object_motion_hints?: string[];
  /**
   * Optional per-object concrete visual-appearance spec (same length/order as
   * `objects`). See `character_descriptions` for the shape/intent.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  object_descriptions?: string[];
  /**
   * Optional concrete visual-appearance spec for the single build CRATE that
   * appears while an object is under construction (object board 2 / objects_02,
   * cell 16 — see buildObjectBoard2Prompt). A single string, not an array: there
   * is exactly ONE crate per theme, unlike character/object/decor/enemy
   * descriptions which are per-slot arrays. The crate is REQUIRED for every
   * theme (never renamed/removed) — only its appearance is editable.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  crate_description?: string;
  /**
   * Optional concrete visual-appearance spec for the single build-completion
   * POOF effect (object board 2 / objects_02, cells 9-12 — see
   * buildObjectBoard2Prompt). A single string, not an array — see
   * `crate_description` for the shape/intent; the poof is likewise REQUIRED
   * and never renamed/removed, only its appearance is editable.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  poof_description?: string;
  /**
   * Optional concrete visual-appearance spec for the single ranged-combat
   * PROJECTILE FX (background decor board row 4 — see buildBackgroundDecorPrompt).
   * A single string, not an array — see `crate_description` for the shape/intent;
   * the projectile is likewise REQUIRED for every theme (never removed, since
   * ranged combat always fires it) and never renamed, only its appearance is
   * editable. Its 4 frames are muzzle-fire, in-flight, hit, and blast.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  projectile_description?: string;
  decor: string[];
  /**
   * Optional per-decor concrete visual-appearance spec (same length/order as
   * `decor`). See `character_descriptions` for the shape/intent.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  decor_descriptions?: string[];
  enemies: string[];
  /**
   * Optional per-enemy combat classification (same length/order as `enemies`).
   * Entries are 'melee' | 'ranged' | absent (unclassified — treated as melee
   * at render time). Threaded into RivalConfig.attack_style in themePlanToManifest.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  enemy_attack_styles?: Array<'melee' | 'ranged' | undefined>;
  /**
   * Optional per-enemy concrete visual-appearance spec (same length/order as
   * `enemies`). See `character_descriptions` for the shape/intent.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  enemy_descriptions?: string[];
  expressions: string[];
  /**
   * Optional per-expression concrete visual-appearance spec. Like
   * `achievement_descriptions`, this is POSITIONAL: index i aligns to expression
   * cell i (0..THEME_EXPRESSION_COUNT-1), matching plan.expressions[i] /
   * FIXED_EXPRESSION_LABELS[i]. Threaded into buildExpressionAtlasPrompt so a
   * cell's ART can be steered by appearance text while its LABEL stays a fixed
   * semantic hook. Internal plan field only — NOT part of the immutable
   * shared/types contract.
   */
  expression_descriptions?: string[];
  achievements: string[];
  /**
   * Optional per-achievement/badge concrete visual-appearance spec. Unlike the
   * name-filtered object/decor/enemy description arrays, this is POSITIONAL:
   * index i aligns to achievement/badge slot i (0..THEME_ACHIEVEMENT_COUNT-1),
   * matching plan.achievements[i] / manifest.badges[i]. Threaded into
   * buildAchievementAtlasPrompt so a badge's ART is driven by this appearance
   * text instead of overloading its display name/title. Introduced so the badge
   * NAME can stay a clean title while appearance lives in its own field.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  achievement_descriptions?: string[];
  /**
   * The trimmed `creative_direction` text that was in effect the last time
   * every `*_descriptions` array was (re)generated. Compared against the
   * CURRENT `creative_direction` by `themeDescriptionsStale` to detect when
   * a user has edited the direction but not yet re-derived descriptions from
   * it. Undefined on legacy plans (pre-dating this field) or plans that have
   * never had descriptions generated — both are treated as "not stale".
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  descriptions_direction?: string;
  /**
   * One-level undo snapshot of the per-slot `*_descriptions` arrays as they
   * stood immediately before the most recent REGENERATE_THEME_DESCRIPTIONS
   * re-derive. Absent until a re-derive has happened at least once.
   * Internal plan field only — NOT part of the immutable shared/types contract.
   */
  previous_descriptions?: {
    character_descriptions?: string[];
    object_descriptions?: string[];
    crate_description?: string;
    poof_description?: string;
    projectile_description?: string;
    decor_descriptions?: string[];
    enemy_descriptions?: string[];
    expression_descriptions?: string[];
    achievement_descriptions?: string[];
  };
}

/**
 * True only when this plan HAS generated descriptions AND those descriptions
 * were generated under a creative_direction that differs from the plan's
 * current creative_direction (both compared trimmed). A plan that has never
 * recorded `descriptions_direction` (legacy plan, or one whose descriptions
 * were never (re)generated through a direction-aware path) is never stale —
 * there is nothing to compare against.
 */
export function themeDescriptionsStale(plan: ThemePlan): boolean {
  if (plan.descriptions_direction === undefined) return false;
  const hasAnyDescriptions = Boolean(
    plan.character_descriptions?.length
    || plan.object_descriptions?.length
    || plan.decor_descriptions?.length
    || plan.enemy_descriptions?.length
    || plan.expression_descriptions?.length
    || plan.achievement_descriptions?.length
    || plan.crate_description
    || plan.poof_description
    || plan.projectile_description,
  );
  if (!hasAnyDescriptions) return false;
  return plan.descriptions_direction.trim() !== plan.creative_direction.trim();
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
  const { objects, objectMotionHints, objectDescriptions } = reserveRangedWeaponRackSlot(
    input.objects,
    displayName,
    input.object_motion_hints,
    input.object_descriptions,
  );
  const { enemies, enemyAttackStyles, enemyDescriptions } = normalizeEnemies(
    input.enemies,
    input.enemy_attack_styles,
    input.enemy_descriptions,
  );
  const characters = normalizeNames(input.characters, THEME_CHARACTER_COUNT, 'Character');
  const decor = normalizeDecorNames(input.decor);
  const achievements = normalizeNames(input.achievements, THEME_ACHIEVEMENT_COUNT, 'Achievement Badge');
  return {
    version: 1,
    theme_id: themeId,
    display_name: displayName,
    creative_direction: cleanValue(input.creative_direction)
      || `A cohesive game-art interpretation of ${displayName}.`,
    characters,
    character_descriptions: alignDescriptions(input.characters, input.character_descriptions, characters),
    character_body_plans: normalizeCharacterBodyPlans(input.character_body_plans, characters.length),
    environment: cleanValue(input.environment)
      || `A playable isometric environment inspired by ${displayName}.`,
    objects,
    object_motion_hints: objectMotionHints,
    object_descriptions: objectDescriptions,
    crate_description: cleanValue(input.crate_description) || undefined,
    poof_description: cleanValue(input.poof_description) || undefined,
    projectile_description: cleanValue(input.projectile_description) || undefined,
    decor,
    decor_descriptions: alignDescriptions(input.decor, input.decor_descriptions, decor),
    enemies,
    enemy_attack_styles: enemyAttackStyles,
    enemy_descriptions: enemyDescriptions,
    expressions: applyFixedExpressionLabels(
      normalizeNames(input.expressions, THEME_EXPRESSION_COUNT, 'Expression'),
    ),
    expression_descriptions: normalizePositionalDescriptions(
      input.expression_descriptions, THEME_EXPRESSION_COUNT, [...FIXED_EXPRESSION_LABELS],
    ),
    achievements,
    achievement_descriptions: normalizeAchievementDescriptions(input.achievement_descriptions, achievements),
    descriptions_direction: cleanValue(input.descriptions_direction) || undefined,
    previous_descriptions: input.previous_descriptions,
  };
}

/**
 * Achievement/badge descriptions are POSITIONAL (index === badge slot), not
 * name-filtered like object/decor/enemy descriptions — so align them 1:1 by
 * index, padding/truncating to THEME_ACHIEVEMENT_COUNT. Returns undefined when
 * there is no description data at all (callers fall back to name-only prompts).
 */
function normalizeAchievementDescriptions(rawExtra: unknown, names: string[]): string[] | undefined {
  return normalizePositionalDescriptions(rawExtra, THEME_ACHIEVEMENT_COUNT, names);
}

/**
 * Positional (index === slot) description normalizer shared by the badge and
 * expression boards: pad/truncate `rawExtra` to exactly `count` entries, each a
 * trimmed string ('' where absent), with any leading occurrence of that same
 * index's `names` entry stripped (see stripLeadingName). Returns undefined
 * when there is no description data at all so callers fall back to name-only
 * prompts.
 */
function normalizePositionalDescriptions(rawExtra: unknown, count: number, names: string[]): string[] | undefined {
  if (!Array.isArray(rawExtra) || rawExtra.length === 0) return undefined;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = rawExtra[i];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    out.push(stripLeadingName(names[i] ?? '', trimmed));
  }
  return out;
}

/**
 * Positional per-slot body-plan normalizer (index === slot_id, same length as
 * `characters`): pads/truncates to `count` entries, keeping only the literal
 * 'biped'/'quadruped' values and dropping anything else to undefined (unset).
 * Returns undefined when there is no body-plan data at all, so callers fall
 * back to inferBodyPlan-only behavior.
 */
function normalizeCharacterBodyPlans(
  rawExtra: unknown,
  count: number,
): Array<'biped' | 'quadruped' | undefined> | undefined {
  if (!Array.isArray(rawExtra) || rawExtra.length === 0) return undefined;
  const out: Array<'biped' | 'quadruped' | undefined> = [];
  for (let i = 0; i < count; i += 1) {
    const value = rawExtra[i];
    out.push(value === 'biped' || value === 'quadruped' ? value : undefined);
  }
  return out.some((value) => value !== undefined) ? out : undefined;
}

/**
 * Pair a raw name array with a parallel raw "extra" array (a visual
 * description, in practice) using the SAME blank-filtering order that
 * `normalizeNames`/`normalizeDecorNames` apply to `rawNames` itself, then
 * align the surviving extras 1:1 with `normalizedNames` (which is already
 * padded/truncated to its fixed count). Padded/fallback entries (added
 * because the planner supplied fewer names than required) get '' — never a
 * misaligned description carried over from an unrelated name. Returns
 * undefined when there is no extra data at all, so callers can fall back to
 * current (no-description) behavior cleanly.
 */
function alignDescriptions(
  rawNames: unknown,
  rawExtra: unknown,
  normalizedNames: string[],
): string[] | undefined {
  if (!Array.isArray(rawExtra) || rawExtra.length === 0) return undefined;
  const names = Array.isArray(rawNames) ? rawNames.map((value) => cleanValue(value)) : [];
  const extras = rawExtra.map((value) => cleanValue(value));
  const paired = names
    .map((name, index) => ({ name, extra: extras[index] ?? '' }))
    .filter((entry) => entry.name.length > 0);
  const aligned = normalizedNames.map((name, index) => stripLeadingName(name, paired[index]?.extra ?? ''));
  return aligned.some((description) => description.length > 0) ? aligned : undefined;
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
  const rosterRivals: RivalConfig[] = plan.enemies.map((name, index) => {
    const style = plan.enemy_attack_styles?.[index];
    return {
      rival_id: `rival_${rivalIds[index]}`,
      name,
      atlas_asset: `frames.json#rival_${rivalIds[index]}`,
      // Omit the field entirely when unknown so the render layer's legacy
      // default (melee — no projectile) applies; never default to 'ranged'.
      ...(style === 'melee' || style === 'ranged' ? { attack_style: style } : {}),
    };
  });
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
    // Opt-in Phase 2 groundwork: every newly-generated manifest carries this
    // explicit default-off flag; the theme review screen's per-object toggle
    // is the only thing that ever flips it to true.
    is_turret: false,
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

/**
 * Reverse of themePlanToManifest: build a MINIMAL Partial<ThemePlan> seed from
 * an already-saved manifest, for themes created before plan.json existed (see
 * updateThemeItemDescriptionsBatch in themeService.ts). Pulls only what the
 * manifest actually carries — display names, character/enemy/object/decor/
 * badge names, theme_id — and invents nothing else; every other ThemePlan
 * field (creative_direction, environment, descriptions, etc.) is left absent
 * so normalizeThemePlan(...) fills its own defaults/fallbacks exactly as it
 * would for any other under-specified plan. Caller is expected to pass this
 * straight into normalizeThemePlan.
 */
export function manifestToPlanSeed(manifest: ThemeManifest): Partial<ThemePlan> {
  return {
    theme_id: manifest.theme_id,
    display_name: manifest.display_name,
    characters: manifest.roster_agents
      .slice()
      .sort((a, b) => a.slot_id - b.slot_id)
      .map((agent) => agent.name),
    objects: manifest.buildable_objects
      .slice()
      .sort((a, b) => a.build_order - b.build_order)
      .map((object) => object.display_name),
    decor: manifest.decor_objects.map((decor) => decor.display_name),
    enemies: manifest.roster_rivals.map((rival) => rival.name),
    achievements: manifest.badges.map((badge) => badge.display_name),
  };
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
 * remaining 20 slots come from the plan, keeping the total at THEME_OBJECT_COUNT (21:
 * 19 static objects [16 on board 1 + 3 on board 2], plus the 2 animated objects on
 * board 2 — see themeAssetPrompts.ts's OBJECT_STATIC_COUNT / OBJECT_ANIMATED_COUNT).
 */
function reserveRangedWeaponRackSlot(
  values: unknown,
  displayName: string,
  motionHints?: unknown,
  descriptions?: unknown,
): { objects: string[]; objectMotionHints?: string[]; objectDescriptions?: string[] } {
  const rawSource = (Array.isArray(values) ? values : []).map((value) => cleanValue(value));
  const rawHints = Array.isArray(motionHints) ? motionHints.map((value) => cleanValue(value)) : [];
  const rawDescriptions = Array.isArray(descriptions) ? descriptions.map((value) => cleanValue(value)) : [];
  // Pair each name with its planner-supplied motion hint and description before
  // filtering blanks, so both stay aligned to their object even after empty
  // names are dropped.
  const paired = rawSource
    .map((name, index) => ({ name, hint: rawHints[index] ?? '', description: rawDescriptions[index] ?? '' }))
    .filter((entry) => entry.name.length > 0);

  const first = paired[0]?.name ?? '';
  // Keep the planner's first name if it already reads as a ranged weapon rack and
  // consume it as slot 0; otherwise coerce slot 0 to a themed default and keep the
  // planner's own objects (including its first) among the 12 remaining free slots.
  const hasRack = looksLikeRangedWeaponRack(first);
  const rack = hasRack ? first : `${displayName} Ranged Weapon Rack`;
  const rackHint = hasRack ? paired[0]?.hint ?? '' : '';
  // The auto-coerced default rack (planner didn't supply one) still needs a
  // concrete, non-empty visual spec — otherwise the rack slot would render
  // description-less even though it's a mandatory, load-bearing slot.
  const rackDescription = hasRack
    ? paired[0]?.description ?? ''
    : buildDefaultRackDescription(displayName);
  const rest = hasRack ? paired.slice(1) : paired;

  const restNames = normalizeNames(rest.map((entry) => entry.name), THEME_OBJECT_COUNT - 1, 'Object');
  const objects = [rack, ...restNames].slice(0, THEME_OBJECT_COUNT);
  // Align hints/descriptions to the final object list: rack value first, then the
  // rest's values in order, padded with empty strings so index i maps to objects[i].
  const hints = [rackHint, ...rest.map((entry) => entry.hint)].slice(0, THEME_OBJECT_COUNT);
  while (hints.length < objects.length) hints.push('');
  const descriptionsAligned = [rackDescription, ...rest.map((entry) => entry.description)]
    .slice(0, THEME_OBJECT_COUNT)
    .map((description, index) => stripLeadingName(objects[index] ?? '', description));
  while (descriptionsAligned.length < objects.length) descriptionsAligned.push('');
  const hasAnyHint = hints.some((hint) => hint.length > 0);
  // Every one of the 21 final slots (including any planner-padded fallback-named
  // slot) must end with a NON-EMPTY description so the per-slot editor never shows
  // a blank object: fill any still-empty slot with a concise deterministic fallback
  // derived from that slot's own object name.
  const filledDescriptions = descriptionsAligned.map((description, index) => (
    description.length > 0 ? description : `${objects[index]}, styled to match the theme.`
  ));
  return {
    objects,
    objectMotionHints: hasAnyHint ? hints : undefined,
    objectDescriptions: filledDescriptions,
  };
}

/**
 * Concrete, non-empty default visual spec for the ranged-weapon rack when the
 * planner didn't supply one that already reads as a rack (see
 * looksLikeRangedWeaponRack). Keeps the rack slot (0) from ever rendering
 * description-less, without a network round-trip.
 */
function buildDefaultRackDescription(displayName: string): string {
  return `A wall-mounted rack or stand displaying a set of ${displayName}-themed ranged weapons, `
    + "built and finished to match the pack's overall art style, materials, and color palette.";
}

/** Heuristic: does a name describe a rack/rack-like store of RANGED weapons? */
function looksLikeRangedWeaponRack(name: string): boolean {
  const text = name.toLowerCase();
  const isRack = /\b(rack|stand|armory|armoury|locker|cache|arsenal|shelf|rangefinder)\b/.test(text)
    || /\bweapon(s)?\s+(rack|stand|shelf|locker)\b/.test(text);
  const isRanged = /\b(ranged|rifle|blaster|laser|plasma|gun|guns|missile|rocket|bow|crossbow|cannon|dart|slingshot|shooter|firearm|musket|bolt|arrow)\b/.test(text);
  return isRack && isRanged;
}

/**
 * Normalize the `enemies` list to THEME_ENEMY_COUNT entries while keeping an
 * optional parallel `enemy_attack_styles` array aligned by index. Mirrors the
 * pairing approach in reserveRangedWeaponRackSlot: pair name+style BEFORE
 * filtering blank names, so a planner-supplied style stays attached to its
 * enemy even if earlier blank entries are dropped. Padded fallback enemies
 * (added when the planner supplied fewer than THEME_ENEMY_COUNT) get no style
 * (undefined) — render-time default is melee.
 */
function normalizeEnemies(
  values: unknown,
  styles: unknown,
  descriptions?: unknown,
): {
  enemies: string[];
  enemyAttackStyles?: Array<'melee' | 'ranged' | undefined>;
  enemyDescriptions?: string[];
} {
  const rawNames = Array.isArray(values) ? values : [];
  const rawStyles = Array.isArray(styles) ? styles : [];
  const rawDescriptions = Array.isArray(descriptions) ? descriptions.map((value) => cleanValue(value)) : [];
  const paired = rawNames
    .map((value, index) => ({
      name: cleanValue(value),
      style: normalizeAttackStyle(rawStyles[index]),
      description: rawDescriptions[index] ?? '',
    }))
    .filter((entry) => entry.name.length > 0);

  const enemies = normalizeNames(paired.map((entry) => entry.name), THEME_ENEMY_COUNT, 'Enemy');
  const stylesAligned = paired.map((entry) => entry.style).slice(0, THEME_ENEMY_COUNT);
  while (stylesAligned.length < enemies.length) stylesAligned.push(undefined);
  const hasAnyStyle = stylesAligned.some((style) => style !== undefined);
  const descriptionsAligned = paired.map((entry) => entry.description).slice(0, THEME_ENEMY_COUNT)
    .map((description, index) => stripLeadingName(enemies[index] ?? '', description));
  while (descriptionsAligned.length < enemies.length) descriptionsAligned.push('');
  const hasAnyDescription = descriptionsAligned.some((description) => description.length > 0);
  return {
    enemies,
    enemyAttackStyles: hasAnyStyle ? stylesAligned : undefined,
    enemyDescriptions: hasAnyDescription ? descriptionsAligned : undefined,
  };
}

function normalizeAttackStyle(value: unknown): 'melee' | 'ranged' | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  return lowered === 'melee' || lowered === 'ranged' ? lowered : undefined;
}

/**
 * Normalize the `decor` list to THEME_DECOR_COUNT (9) entries, padding any
 * missing slots by their fixed board role rather than one generic label.
 * Mirrors buildDefaultDecorObjects in themeMigration.ts exactly, so a
 * planner-padded slot and a migration-padded legacy slot always agree:
 *   indices 0-3 -> "Seat N" (N = index+1, the sittable row)
 *   indices 4-7 -> "Decor N" (N = index-3, the static row)
 *   index 8     -> "Animated Decor 1" (the single looping item)
 */
function normalizeDecorNames(values: unknown): string[] {
  const source = Array.isArray(values) ? values : [];
  const result = source
    .map((value) => cleanValue(value))
    .filter((value) => value.length > 0)
    .slice(0, THEME_DECOR_COUNT);
  while (result.length < THEME_DECOR_COUNT) {
    const index = result.length;
    if (index < 4) result.push(`Seat ${index + 1}`);
    else if (index < 8) result.push(`Decor ${index - 3}`);
    else result.push('Animated Decor 1');
  }
  return result;
}

/**
 * Overwrite cells 0-3 of an already-length-normalized expressions array with
 * the FIXED_EXPRESSION_LABELS contract, dropping whatever flavor names the
 * LLM (or a fallback) produced for those slots. Cells 4-15 (theme flavor)
 * pass through unchanged. Length stays THEME_EXPRESSION_COUNT.
 */
function applyFixedExpressionLabels(expressions: string[]): string[] {
  const result = expressions.slice();
  FIXED_EXPRESSION_LABELS.forEach((label, index) => {
    result[index] = label;
  });
  return result;
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

export function uniqueIds(names: string[], fallback: string): string[] {
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
