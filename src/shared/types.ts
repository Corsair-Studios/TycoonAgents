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
  enemy_config?: EnemyConfig;
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
