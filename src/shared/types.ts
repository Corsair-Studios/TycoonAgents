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
  // Per-buildable horizontal-flip overrides set in the Stage Editor. Keyed by
  // BuildableObject.object_id -> true when that object's built art is mirrored
  // horizontally. Absent/false = not flipped. Survives regeneration. Buildables
  // are never sittable, so this never interacts with seat-alignment math.
  object_flip_overrides?: Record<string, boolean>;
  overall_scale?: number;
  projectile_asset?: string;
  enemy_config?: EnemyConfig;
  rival_scale?: number;
  rival_scale_overrides?: Record<string, number>;
  decor_scale?: number;
  decor_scale_overrides?: Record<string, number>;
  // Non-destructive Stage-Editor HIDE list for decor, set in Edit Stage.
  // Array of DecorObject.decor_id values currently hidden from normal play.
  // Distinct from the decor_anchor_overrides [-1,-1] sentinel: hidden decor
  // here keeps its live position/scale — it's purely a visibility toggle.
  // Absent/empty = nothing hidden. Survives art regeneration.
  decor_hidden?: string[];
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
  // Opt-in designer flag: marks this object as a turret once built. Absent/false
  // for every existing theme (byte-for-byte unaffected). Phase 2 groundwork only
  // — setting this does not make anything fire yet; it's a runtime signal for a
  // later auto-fire feature to consume. Only meaningful on the 2 animated
  // objects (see the review screen's "Acts as turret" checkbox), but the field
  // itself carries no such restriction at the type level.
  is_turret?: boolean;
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
  // REBIRTH_COUNT: threshold compares against lifetime rebirthCount (never wiped).
  // OBJECTS_BUILT_POST_REBIRTH: like OBJECTS_BUILT, but only counts once rebirthCount >= 1
  // (i.e. earnable only after at least one Rebirth); wipes on rebirth like a normal badge.
  trigger_type: 'OBJECTS_BUILT' | 'RIVALS_EVICTED' | 'TASKS_COMPLETED' | 'AGENTS_ACTIVE'
    | 'REBIRTH_COUNT' | 'OBJECTS_BUILT_POST_REBIRTH';
  threshold: number;
  icon_asset: string;
}

/**
 * Runtime list of every valid ThemeBadge trigger_type, single-sourced for
 * validation (e.g. themeArchive import checks). `satisfies` guarantees each
 * array element is a member of the union; the exhaustiveness guard below
 * guarantees no union member is missing from the array — so the union and
 * this list can never drift in either direction.
 */
export const BADGE_TRIGGER_TYPES = [
  'OBJECTS_BUILT',
  'RIVALS_EVICTED',
  'TASKS_COMPLETED',
  'AGENTS_ACTIVE',
  'REBIRTH_COUNT',
  'OBJECTS_BUILT_POST_REBIRTH',
] as const satisfies readonly ThemeBadge['trigger_type'][];

// Compile-time exhaustiveness guard: resolves to `true` only when every
// ThemeBadge['trigger_type'] union member appears in BADGE_TRIGGER_TYPES;
// otherwise it resolves to `never` and the assignment fails to compile.
type _BadgeTriggerTypesExhaustive =
  ThemeBadge['trigger_type'] extends (typeof BADGE_TRIGGER_TYPES)[number] ? true : never;
const _badgeTriggerTypesExhaustive: _BadgeTriggerTypesExhaustive = true;
void _badgeTriggerTypesExhaustive;

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
  // Opt-in: 'v2' means row-1 character-atlas slots 2-4 hold the new
  // idle_rare/stand_back poses instead of legacy walk frames 3-5. Absent on
  // themes generated before this field existed. See themeHasFreedFrames in
  // src/extension/themePlan.ts.
  freed_frames?: string;
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

// ============================================================================
// PROJECT PLAN (optional, opt-in): PHASES containing TASKS, approved/retried
// by the user. A skill built separately drives execution; the extension only
// defines the data model, pure state-transition logic, and plan.json I/O —
// zero runtime AI calls happen here. See src/host/vscode/projectPlan.ts.
// ============================================================================

export type PlanTaskStatus =
  | 'pending'
  | 'active'
  | 'verifying'
  | 'done'
  | 'needs_fix'
  | 'skipped'
  | 'blocked';

export type PlanTaskApproval = 'pending' | 'approved' | 'retry';

export interface PlanTask {
  id: string;
  phaseId: string;
  title: string;
  detail: string;
  agents?: string[];
  acceptanceCriteria: string[];
  dependsOn?: string[];
  status: PlanTaskStatus;
  verifyAttempts: number;
  approval?: PlanTaskApproval;
  notes?: string;
}

export interface PlanPhase {
  id: string;
  num: number;
  name: string;
  goal: string;
  gate: 'pending' | 'approved';
  taskIds: string[];
  /** ISO timestamp set when the gate transitions to "approved". */
  approvedAt?: string;
}

export interface ProjectPlan {
  version: number;
  title: string;
  phases: PlanPhase[];
  tasks: PlanTask[];
  currentPhaseId: string | null;
  currentTaskId: string | null;
}

// ---------------------------------------------------------------------------
// Routing panel (plan p13-t1/t2/t4) — wire-shape mirror of
// src/core/routingHostOps.ts's RoutingView/Backend/RoutingSlot types for
// hosts/webviews that want a plain data-only contract without importing
// core (which pulls in fs/child_process). Keep in sync with
// routingHostOps.ts and docs/IPC-CONTRACT.md's Routing section by hand —
// this file intentionally stays dependency-free.
// ---------------------------------------------------------------------------

export type RoutingTransport = 'claude-native' | 'mcp' | 'openai-compatible';
export type RoutingCostModelClass = 'metered' | 'subscription' | 'local';
export type RoutingSource = 'routing' | 'frontmatter' | 'alias' | 'default';

export interface RoutingBackend {
  vendor: string;
  transport: RoutingTransport;
  mcpServer?: string;
  tools?: string[];
  model: string;
  costModelClass: RoutingCostModelClass;
  endpointEnv?: string;
  apiKeyEnv?: string;
}

export interface RoutingSlot {
  vendor?: string;
  transport?: RoutingTransport;
  mcpServer?: string;
  tools?: string[];
  model?: string;
  costModelClass?: RoutingCostModelClass;
  endpointEnv?: string;
  credentialEnv?: string;
  fallback?: RoutingSlot[];
}

export interface RoutingProfile {
  version: 1;
  orchestrator?: RoutingSlot;
  agents: Record<string, RoutingSlot>;
  defaults?: Partial<RoutingSlot>;
}

export interface RoutingAgentEntry {
  id: string;
  name: string;
  description?: string;
  backend: RoutingBackend;
  source: RoutingSource;
}

export interface RoutingOrchestratorEntry {
  id: string;
  backend: RoutingBackend;
  source: RoutingSource;
}

export interface RoutingModelPreset {
  id: string;
  vendor: string;
  costModelClass: RoutingCostModelClass;
  label: string;
}

export interface RoutingViewPayload {
  profile: RoutingProfile | null;
  path: string;
  errors: string[];
  orchestrator: RoutingOrchestratorEntry;
  agents: RoutingAgentEntry[];
  envProbe: Record<string, boolean>;
  presets: { vendors: string[]; models: RoutingModelPreset[] };
  lastApplied: { claude?: string; opencode?: string };
}
