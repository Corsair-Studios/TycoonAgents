// ============================================================================
// PROJECT THEME TYCOON: SHIFT-LEFT IMMUTABLE DATA CONTRACT
// WARNING: DO NOT MODIFY THIS FILE WITHOUT EXPLICIT HUMAN APPROVAL.
// ============================================================================

export type AnimationState = 
  | 'walk' 
  | 'build' 
  | 'melee_attack' 
  | 'ranged_attack' 
  | 'sit' 
  | 'pose_crossed' 
  | 'pose_down' 
  | 'pose_up' 
  | 'dance';

export interface EnemyConfig {
  spawn_interval_seconds?: number; // default 45
  count_mode?: 'all' | 'random';   // default 'random'
}

export interface ViewportConfig {
  native_width: number;
  native_height: number;
  background_asset: string;
  crate_asset?: string;
  poof_asset?: string;
  walkable_nav_polygon: [number, number][]; // Array of 6 coordinate pairs
  character_scale?: number;
  object_scale?: number;
  character_scale_overrides?: Record<string, number>;
  object_scale_overrides?: Record<string, number>;
  // Per-buildable position overrides set in the Stage Editor. Keyed by
  // BuildableObject.object_id -> normalized [x,y] in 0..1 scene space (same
  // space as walkable_nav_polygon). Survives art regeneration.
  object_anchor_overrides?: Record<string, [number, number]>;
  // Per-decor position overrides set in the Stage Editor. Keyed by
  // DecorObject.decor_id -> normalized [x,y] in 0..1. The sentinel [-1,-1]
  // marks that decor as hidden/removed.
  decor_anchor_overrides?: Record<string, [number, number]>;
  // Per-decor horizontal-flip overrides set in the Stage Editor. Keyed by
  // DecorObject.decor_id -> true when that decor (and any character seated in it)
  // is mirrored horizontally. Absent/false = not flipped. Survives regeneration.
  decor_flip_overrides?: Record<string, boolean>;
  overall_scale?: number;
  projectile_asset?: string;
  enemy_config?: EnemyConfig;
  rival_scale?: number;
  rival_scale_overrides?: Record<string, number>;
}

export interface AgentConfig {
  slot_id: number;
  name: string;
  atlas_asset: string;
  preferred_idle_pose: 'pose_crossed' | 'pose_down' | 'pose_up';
}

export interface RivalConfig {
  rival_id: string;
  name: string;
  atlas_asset: string;
  // Planner-classified combat style. Absent = legacy/unclassified theme,
  // treated as 'melee' at render time (never spawns a ranged projectile).
  attack_style?: 'melee' | 'ranged';
}

export interface BuildableObject {
  build_order: number;
  object_id: string;
  display_name: string;
  sprite_asset: string;
  anchor_coord: [number, number]; // [X, Y] pixel coordinates
  exclusion_radius: number;       // Pixels for pathfinding offset
  work_units_required: number;
  anim_fps?: number;
  anim_loop?: boolean;
}

export interface DecorObject {
  decor_id: string;
  display_name: string;
  sprite_asset: string;            // "frames.json#decor_<decor_id>" — array of 1 (static) or 4 (animated) data-URIs
  anchor_coord: [number, number];  // normalized 0..1 placement in the scene
  is_sittable?: boolean;           // true for the row-1 seats
  sit_anchor?: [number, number];   // normalized SCENE-SPACE offset from anchor_coord where a seated character's base sits (default ~[0,-0.03])
  anim_fps?: number;               // present for animated decor (rows 3-4)
  anim_loop?: boolean;
}

export interface ThemeBadge {
  badge_id: string;
  display_name: string;
  description: string;
  trigger_type: 'OBJECTS_BUILT' | 'RIVALS_EVICTED';
  threshold: number;
  icon_asset: string;
}

// Master Schema exported by the Factory and read by the Theater
export interface ThemeManifest {
  manifest_version: string;
  theme_id: string;
  display_name: string;
  author: string;
  viewport: ViewportConfig;
  roster_agents: AgentConfig[];
  roster_rivals: RivalConfig[];
  buildable_objects: BuildableObject[];
  decor_objects: DecorObject[];
  badges: ThemeBadge[];
}

// Runtime Telemetry State updated by local file/process watchers
export interface WorldState {
  current_mode: 'MODE_CONSTRUCT' | 'MODE_EVICT' | 'MODE_IDLE';
  active_build_target_id: string | null;
  build_progress_units: number; // Current work completed on active target
  active_rivals: Array<{
    instance_id: string;
    rival_id: string;
    coord: [number, number];
    resolve: number; // HP
  }>;
}
