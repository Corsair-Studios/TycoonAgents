import type {
  AgentConfig,
  BuildableObject,
  RivalConfig,
  ThemeManifest,
  ViewportConfig,
} from '../shared/types';

export const THEME_CHARACTER_COUNT = 16;
export const THEME_ENEMY_COUNT = 3;
export const THEME_OBJECT_COUNT = 13;
export const THEME_EXPRESSION_COUNT = 16;
export const THEME_ACHIEVEMENT_COUNT = 20;

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
  sit: { frames: [15], fps: 0, loop: true, flippable: false, hold: true },
  melee: { frames: [5, 6, 7, 8], fps: 12, loop: false, flippable: true },
  build: { frames: [5, 6, 7, 8], fps: 6, loop: true, flippable: true },
  tool_idle: { frames: [9], fps: 0, loop: true, flippable: true, hold: true },
  shoot: { frames: [10, 11], fps: 8, loop: false, flippable: true, pingpong: true },
  dance: { frames: [17, 18], fps: 6, loop: true, flippable: false, pingpong: true },
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

export interface ThemePlan {
  version: 1;
  theme_id: string;
  display_name: string;
  creative_direction: string;
  characters: string[];
  environment: string;
  objects: string[];
  enemies: string[];
  expressions: string[];
  achievements: string[];
}

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
  return {
    version: 1,
    theme_id: themeId,
    display_name: displayName,
    creative_direction: cleanValue(input.creative_direction)
      || `A cohesive game-art interpretation of ${displayName}.`,
    characters: normalizeNames(input.characters, THEME_CHARACTER_COUNT, 'Character'),
    environment: cleanValue(input.environment)
      || `A playable isometric environment inspired by ${displayName}.`,
    objects: normalizeNames(input.objects, THEME_OBJECT_COUNT, 'Object'),
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
  }));
  const viewport: ViewportConfig = {
    native_width: 1280,
    native_height: 720,
    background_asset: 'frames.json#environment_background',
    crate_asset: 'frames.json#crate',
    poof_asset: 'frames.json#poof',
    walkable_nav_polygon: WALKABLE_NAV_POLYGON,
    enemy_config: { spawn_interval_seconds: 45, count_mode: 'random' },
  };
  return {
    display_name: plan.display_name,
    roster_agents: rosterAgents,
    roster_rivals: rosterRivals,
    buildable_objects: buildableObjects,
    viewport,
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
