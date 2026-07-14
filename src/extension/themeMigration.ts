import type { DecorObject, EnemyConfig, ThemeBadge, ThemeManifest } from '../shared/types';
import { THEME_OBJECT_COUNT } from './themePlan';

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
 * Builds the fixed 24-entry default badge roster (5 OBJECTS_BUILT, 8
 * RIVALS_EVICTED, 5 TASKS_COMPLETED, 2 AGENTS_ACTIVE, 3 REBIRTH_COUNT, 1
 * OBJECTS_BUILT_POST_REBIRTH), each mapped to its OWN cell on the 5×5=25-cell
 * achievement art board (achievement_0..achievement_23). Every one of the 24
 * badges has a UNIQUE icon; slot achievement_24 is left spare for a future 5th
 * rebirth badge. Applied whenever a manifest has no badges, so the badge UI
 * always has content to render. (Legacy 20-cell themes lack achievement_20..24
 * until regenerated; the badge panel degrades a missing icon frame to a generic
 * placeholder rather than throwing.)
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
    {
      badge_id: 'task_1',
      display_name: 'Getting Started',
      description: 'Complete your first task.',
      trigger_type: 'TASKS_COMPLETED',
      threshold: 1,
      icon_asset: 'frames.json#achievement_8',
    },
    {
      badge_id: 'task_10',
      display_name: 'Warmed Up',
      description: 'Complete 10 tasks.',
      trigger_type: 'TASKS_COMPLETED',
      threshold: 10,
      icon_asset: 'frames.json#achievement_9',
    },
    {
      badge_id: 'task_50',
      display_name: 'In the Zone',
      description: 'Complete 50 tasks.',
      trigger_type: 'TASKS_COMPLETED',
      threshold: 50,
      icon_asset: 'frames.json#achievement_10',
    },
    {
      badge_id: 'task_150',
      display_name: 'Grind Master',
      description: 'Complete 150 tasks.',
      trigger_type: 'TASKS_COMPLETED',
      threshold: 150,
      icon_asset: 'frames.json#achievement_11',
    },
    {
      badge_id: 'task_500',
      display_name: 'Unstoppable',
      description: 'Complete 500 tasks.',
      trigger_type: 'TASKS_COMPLETED',
      threshold: 500,
      icon_asset: 'frames.json#achievement_12',
    },
    {
      badge_id: 'evict_35',
      display_name: 'Turf War',
      description: 'Evict 35 rivals.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 35,
      icon_asset: 'frames.json#achievement_13',
    },
    {
      badge_id: 'evict_50',
      display_name: 'Overlord',
      description: 'Evict 50 rivals.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 50,
      icon_asset: 'frames.json#achievement_14',
    },
    {
      badge_id: 'evict_75',
      display_name: 'Kingpin',
      description: 'Evict 75 rivals.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 75,
      icon_asset: 'frames.json#achievement_15',
    },
    {
      badge_id: 'evict_100',
      display_name: 'Undisputed',
      description: 'Evict 100 rivals.',
      trigger_type: 'RIVALS_EVICTED',
      threshold: 100,
      icon_asset: 'frames.json#achievement_16',
    },
    {
      badge_id: 'crew_3',
      display_name: 'Small Crew',
      description: 'Have 3 agents active at once.',
      trigger_type: 'AGENTS_ACTIVE',
      threshold: 3,
      icon_asset: 'frames.json#achievement_17',
    },
    {
      badge_id: 'crew_6',
      display_name: 'Full House',
      description: 'Have 6 agents active at once.',
      trigger_type: 'AGENTS_ACTIVE',
      threshold: 6,
      icon_asset: 'frames.json#achievement_18',
    },
    {
      badge_id: 'build_13',
      display_name: 'Property Tycoon',
      description: 'Build 13 objects.',
      trigger_type: 'OBJECTS_BUILT',
      threshold: 13,
      icon_asset: 'frames.json#achievement_19',
    },
    {
      badge_id: 'rebirth_1',
      display_name: 'Reborn',
      description: 'Rebirth once. This badge is permanent — it survives every future Rebirth.',
      trigger_type: 'REBIRTH_COUNT',
      threshold: 1,
      icon_asset: 'frames.json#achievement_20',
    },
    {
      badge_id: 'rebirth_2',
      display_name: 'Twice Reborn',
      description: 'Rebirth twice. This badge is permanent — it survives every future Rebirth.',
      trigger_type: 'REBIRTH_COUNT',
      threshold: 2,
      icon_asset: 'frames.json#achievement_21',
    },
    {
      badge_id: 'rebirth_3',
      display_name: 'Transcendent',
      description: 'Rebirth three times. This badge is permanent — it survives every future Rebirth.',
      trigger_type: 'REBIRTH_COUNT',
      threshold: 3,
      icon_asset: 'frames.json#achievement_22',
    },
    {
      badge_id: 'reborn_builder',
      display_name: 'New Game+',
      description: 'After at least one Rebirth, build 10 objects in a single cycle.',
      trigger_type: 'OBJECTS_BUILT_POST_REBIRTH',
      threshold: 10,
      icon_asset: 'frames.json#achievement_23',
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
  } else {
    const existingIds = new Set(upgraded.badges.map((b) => b.badge_id));
    const missing = buildDefaultBadges().filter((b) => !existingIds.has(b.badge_id));
    if (missing.length > 0) {
      upgraded.badges = [...upgraded.badges, ...missing];
      changed.push(`Added ${missing.length} new default badges`);
    }
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

  // Pad/truncate buildable_objects to the v3 contract count (THEME_OBJECT_COUNT =
  // 21: 16 static on board 1 + 3 static + 2 animated on board 2) so every theme
  // has a REAL, renameable/regenerate-able entry for EVERY board cell — neither
  // more nor fewer. Without padding, renaming a cell beyond the saved object
  // count is rejected ("Unknown object object_N"); without truncation, a
  // manifest carrying MORE than the contract count (e.g. downgraded from a
  // future/larger contract) would leave orphaned trailing objects with no board
  // cell to render into. Placeholder ids mirror themeObjectSpecs' `object_<n>`
  // scheme (1-based) so board rows, frame keys, and rename line up; objects are
  // art-less until the object board is regenerated (the runtime safely skips
  // objects with no frames). Idempotent: once the array is at the contract
  // count, neither branch does anything.
  if (Array.isArray(upgraded.buildable_objects) && upgraded.buildable_objects.length > THEME_OBJECT_COUNT) {
    const before = upgraded.buildable_objects.length;
    upgraded.buildable_objects = upgraded.buildable_objects.slice(0, THEME_OBJECT_COUNT);
    changed.push(`Truncated buildable_objects ${before} -> ${THEME_OBJECT_COUNT}`);
  }
  if (Array.isArray(upgraded.buildable_objects) && upgraded.buildable_objects.length < THEME_OBJECT_COUNT) {
    const padStart = upgraded.buildable_objects.length;
    while (upgraded.buildable_objects.length < THEME_OBJECT_COUNT) {
      const index = upgraded.buildable_objects.length;
      const objectId = `object_${index + 1}`;
      upgraded.buildable_objects.push({
        build_order: index,
        object_id: objectId,
        display_name: `Object ${index + 1}`,
        sprite_asset: `frames.json#object_${objectId}`,
        anchor_coord: [0.5, 0.5],
        exclusion_radius: 32,
        work_units_required: 100,
        anim_fps: 5,
        anim_loop: true,
      });
    }
    changed.push(`Padded buildable_objects ${padStart} -> ${THEME_OBJECT_COUNT}`);
  }

  return { manifest: upgraded, changed };
}
