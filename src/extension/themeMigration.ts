import type { DecorObject, EnemyConfig, ThemeBadge, ThemeManifest } from '../shared/types';

const DEFAULT_ENEMY_CONFIG: EnemyConfig = { spawn_interval_seconds: 45, count_mode: 'random' };

interface DecorSpec {
  decor_id: string;
  display_name: string;
  is_sittable?: boolean;
  sit_anchor?: [number, number];
  anim_fps?: number;
  anim_loop?: boolean;
}

/**
 * Deterministic, non-overlapping placement for the 9 default decor placeholders.
 * Row A (seats, index 0-3) and Row B (static decor, index 4-7) each spread 4
 * points evenly across x in [0.15, 0.85]; the single animated item sits between
 * the two rows on the centerline. No two indices ever produce the same anchor.
 */
function defaultDecorAnchor(index: number): [number, number] {
  const ROW_A_Y = 0.62;
  const ROW_B_Y = 0.78;
  const MID_Y = 0.7;
  const xForColumn = (col: number) => Number((0.15 + (col * (0.85 - 0.15)) / 3).toFixed(4));
  if (index < 4) return [xForColumn(index), ROW_A_Y];
  if (index < 8) return [xForColumn(index - 4), ROW_B_Y];
  return [0.5, MID_Y];
}

/**
 * Builds the fixed 9-entry decor placeholder roster:
 *   indices 0-3 → sittable seats
 *   indices 4-7 → static decor
 *   index 8     → looping animated decor
 * Mirrors the board layout used by themePlan.ts's buildDecorObjects, but is
 * kept self-contained here so migration has no dependency on the generation
 * pipeline and can be applied safely to any legacy manifest.
 */
function buildDefaultDecorObjects(): DecorObject[] {
  const specs: DecorSpec[] = [];
  for (let i = 1; i <= 4; i++) {
    specs.push({
      decor_id: `seat_${i}`,
      display_name: `Seat ${i}`,
      is_sittable: true,
      sit_anchor: [0, -0.03],
    });
  }
  for (let i = 1; i <= 4; i++) {
    specs.push({
      decor_id: `decor_${i}`,
      display_name: `Decor ${i}`,
    });
  }
  specs.push({
    decor_id: 'decor_anim_1',
    display_name: 'Animated Decor 1',
    anim_fps: 5,
    anim_loop: true,
  });

  return specs.map((spec, index) => {
    const decor: DecorObject = {
      decor_id: spec.decor_id,
      display_name: spec.display_name,
      sprite_asset: `frames.json#decor_${spec.decor_id}`,
      anchor_coord: defaultDecorAnchor(index),
    };
    if (spec.is_sittable) decor.is_sittable = true;
    if (spec.sit_anchor) decor.sit_anchor = spec.sit_anchor;
    if (spec.anim_fps !== undefined) decor.anim_fps = spec.anim_fps;
    if (spec.anim_loop !== undefined) decor.anim_loop = spec.anim_loop;
    return decor;
  });
}

/**
 * Builds the fixed 8-entry default badge roster (4 OBJECTS_BUILT, 4
 * RIVALS_EVICTED), reusing the achievement art board's frames
 * (achievement_0..achievement_7) as icons. Applied whenever a manifest has
 * no badges, so the badge UI always has content to render.
 */
export function buildDefaultBadges(): ThemeBadge[] {
  return [
    {
      badge_id: 'build_1',
      display_name: 'First Build',
      description: 'Complete your first build.',
      trigger_type: 'OBJECTS_BUILT',
      threshold: 1,
      icon_asset: 'frames.json#achievement_0',
    },
    {
      badge_id: 'build_3',
      display_name: 'Builder',
      description: 'Build 3 objects.',
      trigger_type: 'OBJECTS_BUILT',
      threshold: 3,
      icon_asset: 'frames.json#achievement_1',
    },
    {
      badge_id: 'build_6',
      display_name: 'Developer',
      description: 'Build 6 objects.',
      trigger_type: 'OBJECTS_BUILT',
      threshold: 6,
      icon_asset: 'frames.json#achievement_2',
    },
    {
      badge_id: 'build_10',
      display_name: 'Master Builder',
      description: 'Build 10 objects.',
      trigger_type: 'OBJECTS_BUILT',
      threshold: 10,
      icon_asset: 'frames.json#achievement_3',
    },
    {
      badge_id: 'evict_1',
      display_name: 'First Eviction',
      description: 'Evict your first rival.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 1,
      icon_asset: 'frames.json#achievement_4',
    },
    {
      badge_id: 'evict_5',
      display_name: 'Defender',
      description: 'Evict 5 rivals.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 5,
      icon_asset: 'frames.json#achievement_5',
    },
    {
      badge_id: 'evict_10',
      display_name: 'Enforcer',
      description: 'Evict 10 rivals.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 10,
      icon_asset: 'frames.json#achievement_6',
    },
    {
      badge_id: 'evict_20',
      display_name: 'Warlord',
      description: 'Evict 20 rivals.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 20,
      icon_asset: 'frames.json#achievement_7',
    },
  ];
}

/**
 * Upgrades a (possibly legacy) ThemeManifest to the current data contract in
 * place on a deep copy. Only fills fields that are missing; never touches
 * fields that already exist (buildable_objects, rosters, scales, anchor
 * overrides, non-empty decor_objects, etc.). Idempotent: calling this twice
 * on its own output returns an unchanged manifest and an empty `changed` list.
 */
export function upgradeThemeManifest(manifest: ThemeManifest): { manifest: ThemeManifest; changed: string[] } {
  const upgraded: ThemeManifest = JSON.parse(JSON.stringify(manifest));
  const changed: string[] = [];
  const viewport = upgraded.viewport;

  if (!viewport.crate_asset) {
    viewport.crate_asset = 'frames.json#crate';
    changed.push('Added viewport.crate_asset');
  }
  if (!viewport.poof_asset) {
    viewport.poof_asset = 'frames.json#poof';
    changed.push('Added viewport.poof_asset');
  }
  if (!viewport.projectile_asset) {
    viewport.projectile_asset = 'frames.json#projectile';
    changed.push('Added viewport.projectile_asset');
  }
  if (!viewport.enemy_config) {
    viewport.enemy_config = { ...DEFAULT_ENEMY_CONFIG };
    changed.push('Added viewport.enemy_config (spawn_interval_seconds=45, count_mode=random)');
  }

  if (!upgraded.decor_objects || upgraded.decor_objects.length === 0) {
    upgraded.decor_objects = buildDefaultDecorObjects();
    changed.push('Added 9 default decor_objects (4 seats, 4 static, 1 animated)');
  }

  if (!upgraded.badges || upgraded.badges.length === 0) {
    upgraded.badges = buildDefaultBadges();
    changed.push('badges');
  }

  if (Array.isArray(upgraded.buildable_objects)) {
    let touchedAnyBuildableObject = false;
    for (const obj of upgraded.buildable_objects) {
      if (typeof obj.anim_fps !== 'number') {
        obj.anim_fps = 5;
        obj.anim_loop = true;
        touchedAnyBuildableObject = true;
      }
    }
    if (touchedAnyBuildableObject) {
      changed.push('buildable object anim params');
    }
  }

  return { manifest: upgraded, changed };
}
