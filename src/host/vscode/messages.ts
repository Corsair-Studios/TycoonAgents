/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { z } from "zod";
import { ProjectPlanSchema } from "./projectPlan";

/**
 * Single source of truth for the webview<->host `message.type` wire strings
 * used by `src/host/vscode/panel.ts` and `media/main.js`. This is a pure
 * refactor of literals that already existed scattered across panel.ts's
 * `onDidReceiveMessage` dispatcher — every value here MUST stay byte-identical
 * to what shipped before, because `media/main.js` (an untyped, non-bundled
 * browser file) still matches these strings by hand and cannot import this
 * module. Do not rename values; only add to this file when a new wire
 * message is introduced.
 *
 * Keys are SCREAMING_CASE regardless of the wire string's own casing (several
 * legacy inbound/outbound messages use camelCase on the wire, e.g. "getSkills",
 * "skillInstalled" — those are intentional and must not be "fixed").
 */
export const MSG = {
  // ---- lifecycle / state -------------------------------------------------
  READY: "ready",
  STATE: "state",

  // ---- theme: stage tuning / background / manual image upload ------------
  SAVE_STAGE_TUNING: "SAVE_STAGE_TUNING",
  STAGE_TUNING_SAVED: "STAGE_TUNING_SAVED",
  REPLACE_BACKGROUND: "REPLACE_BACKGROUND",
  BACKGROUND_REPLACE_RESULT: "BACKGROUND_REPLACE_RESULT",
  UPLOAD_THEME_IMAGE: "UPLOAD_THEME_IMAGE",

  // ---- skills catalog ------------------------------------------------------
  GET_SKILLS: "getSkills",
  SKILLS: "skills",
  INSTALL_SKILL: "installSkill",
  SKILL_INSTALLED: "skillInstalled",
  REMOVE_SKILL: "removeSkill",
  SKILL_REMOVED: "skillRemoved",

  // ---- MCP catalog -----------------------------------------------------
  GET_MCP: "getMcp",
  MCP: "mcp",
  INSTALL_MCP: "installMcp",
  MCP_INSTALLED: "mcpInstalled",
  REMOVE_MCP: "removeMcp",
  MCP_REMOVED: "mcpRemoved",

  // ---- install / settings / doctor ---------------------------------------
  CHECK_INSTALL: "checkInstall",
  INSTALL_STATE: "installState",
  INSTALL_HOOKS: "installHooks",
  GET_SETTINGS: "getSettings",
  SETTINGS: "settings",
  SETTINGS_UPDATED: "settingsUpdated",
  SET_AGENT_MODEL: "setAgentModel",
  SET_DELEGATION_MODE: "setDelegationMode",
  SET_AGENT_KEYWORDS: "setAgentKeywords",
  REMOVE_AGENT: "removeAgent",
  AGENT_REMOVED: "agentRemoved",
  REPAIR_HOOK: "repairHook",
  RESET_METRICS: "resetMetrics",
  METRICS_RESET: "metricsReset",
  RUN_DOCTOR: "runDoctor",
  DOCTOR_REPORT: "doctorReport",
  APPLY_DOCTOR_FIX: "applyDoctorFix",
  DOCTOR_FIX_DONE: "doctorFixDone",

  // ---- packs catalog -----------------------------------------------------
  GET_PACKS: "getPacks",
  PACKS: "packs",
  INSTALL_PACK: "installPack",
  PACK_INSTALLED: "packInstalled",
  REMOVE_PACK: "removePack",
  PACK_REMOVED: "packRemoved",

  // ---- misc clipboard / doc actions --------------------------------------
  COPY_NUDGE: "copyNudge",
  COPY_PROMPT: "copyPrompt",
  DESIGN_DOC_ACTION: "designDocAction",
  DESIGN_DOC_DONE: "designDocDone",

  // ---- engine / UEFN -------------------------------------------------------
  GET_ENGINE_STATUS: "getEngineStatus",
  ENGINE_STATUS: "engineStatus",
  SETUP_UEFN_PROJECT: "setupUefnProject",
  UEFN_SETUP_DONE: "uefnSetupDone",

  // ---- theme image provider settings -------------------------------------
  GET_THEME_IMAGE_SETTINGS: "GET_THEME_IMAGE_SETTINGS",
  SAVE_THEME_IMAGE_SETTINGS: "SAVE_THEME_IMAGE_SETTINGS",
  THEME_IMAGE_SETTINGS: "THEME_IMAGE_SETTINGS",

  // ---- theme library: list / export / upgrade / import / delete / select ---
  LIST_THEMES: "LIST_THEMES",
  THEMES_LIST: "THEMES_LIST",
  EXPORT_THEME: "EXPORT_THEME",
  THEME_EXPORT_RESULT: "THEME_EXPORT_RESULT",
  UPGRADE_THEMES: "UPGRADE_THEMES",
  UPGRADE_THEMES_DONE: "UPGRADE_THEMES_DONE",
  IMPORT_THEME: "IMPORT_THEME",
  THEME_IMPORT_RESULT: "THEME_IMPORT_RESULT",
  DELETE_THEME: "DELETE_THEME",
  SELECT_THEME: "SELECT_THEME",
  THEME_INITIALIZED: "THEME_INITIALIZED",
  THEME_NONE: "THEME_NONE",

  // ---- badges / rebirth persistence --------------------------------------
  BADGE_UNLOCKED: "BADGE_UNLOCKED",
  SAVE_REBIRTH_STATE: "SAVE_REBIRTH_STATE",
  REBIRTH_RESET_BADGES: "REBIRTH_RESET_BADGES",

  // ---- build progress persistence ------------------------------------------
  SAVE_BUILD_PROGRESS: "saveBuildProgress",

  // ---- theme image review / retry / reslice / normalize / rename ---------
  OPEN_THEME_IMAGES: "OPEN_THEME_IMAGES",
  GET_THEME_IMAGE_REVIEW: "GET_THEME_IMAGE_REVIEW",
  THEME_IMAGE_REVIEW: "THEME_IMAGE_REVIEW",
  SET_THEME_IMAGE_REVIEW_STATUS: "SET_THEME_IMAGE_REVIEW_STATUS",
  APPROVE_ALL_THEME_IMAGES: "APPROVE_ALL_THEME_IMAGES",
  THEME_APPROVE_ALL_RESULT: "THEME_APPROVE_ALL_RESULT",
  RENAME_THEME_CHARACTER: "RENAME_THEME_CHARACTER",
  THEME_CHARACTER_RENAME_STATE: "THEME_CHARACTER_RENAME_STATE",
  SET_THEME_ITEM_NAMES: "SET_THEME_ITEM_NAMES",
  THEME_ITEM_NAMES_RESULT: "THEME_ITEM_NAMES_RESULT",
  NORMALIZE_THEME_CHARACTER: "NORMALIZE_THEME_CHARACTER",
  THEME_CHARACTER_NORMALIZE_STATE: "THEME_CHARACTER_NORMALIZE_STATE",
  RETRY_THEME_IMAGE: "RETRY_THEME_IMAGE",
  THEME_IMAGE_RETRY_STATE: "THEME_IMAGE_RETRY_STATE",
  RESLICE_THEME_IMAGE: "RESLICE_THEME_IMAGE",

  // ---- theme planning / generation ----------------------------------------
  PLAN_THEME: "PLAN_THEME",
  THEME_PLAN_READY: "THEME_PLAN_READY",
  THEME_PLAN_ERROR: "THEME_PLAN_ERROR",
  SET_THEME_PAUSE_FOR_REVIEW: "SET_THEME_PAUSE_FOR_REVIEW",
  CANCEL_THEME_GENERATION: "CANCEL_THEME_GENERATION",
  THEME_GENERATION_CANCELLED: "THEME_GENERATION_CANCELLED",
  GENERATE_THEME: "GENERATE_THEME",
  THEME_GENERATION_PROGRESS: "THEME_GENERATION_PROGRESS",
  THEME_GENERATION_ERROR: "THEME_GENERATION_ERROR",
  THEME_REVIEW_READY: "THEME_REVIEW_READY",
  REGENERATE_BOARD: "REGENERATE_BOARD",
  BOARD_REGENERATED: "BOARD_REGENERATED",
  RUN_THEME_HEALTH_CHECK: "RUN_THEME_HEALTH_CHECK",
  THEME_HEALTH_CHECK_RESULT: "THEME_HEALTH_CHECK_RESULT",

  // ---- project plan (optional): phase/task approval loop -------------------
  APPROVE_PHASE: "APPROVE_PHASE",
  OVERRIDE_TASK: "OVERRIDE_TASK",
  REQUEST_PLAN: "REQUEST_PLAN",
  PLAN_STATE: "PLAN_STATE",
  SET_PROJECT_PLAN_ENABLED: "SET_PROJECT_PLAN_ENABLED",
} as const;

/** Union of every wire string this module knows about (either direction). */
export type MsgType = (typeof MSG)[keyof typeof MSG];

/**
 * Runtime validation for the MUTATING host-message handlers only (increment 1
 * of typed webview IPC — see docs/plan for scope). Read-only getters
 * (getSkills, getMcp, getSettings, checkInstall, getPacks, getEngineStatus,
 * LIST_THEMES, GET_THEME_IMAGE_REVIEW, ...) are intentionally NOT covered
 * here; they don't write/delete anything so a malformed payload can't corrupt
 * state.
 *
 * Every schema is "permissive but shaped": required fields are typed, unknown
 * extra fields are tolerated via `.passthrough()` so the payload can grow
 * without a lockstep change here. Handlers call `.safeParse()` and fall back
 * to that handler's existing error-reply pattern (or a console.error + no-op
 * where the dispatcher already silently drops malformed input today) — a
 * validation failure must never throw across the dispatcher.
 */
export const MSG_SCHEMAS = {
  // ---- install / remove: skill, agent, pack -------------------------------
  // (dispatcher reads `message.id` directly, not a nested `.payload`)
  ID_ONLY: z.object({ id: z.string().min(1) }).passthrough(),

  INSTALL_PACK: z
    .object({
      id: z.string().min(1),
      thirdParty: z.boolean().optional(),
      disclosures: z
        .array(
          z
            .object({
              label: z.string().optional(),
              vendor: z.string().optional(),
              package: z.string().optional(),
              homepage: z.string().optional(),
              network: z.boolean().optional(),
              dataNote: z.string().optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),

  // ---- settings: agent model / keywords / delegation mode -----------------
  SET_AGENT_MODEL: z
    .object({ id: z.string().min(1), model: z.string().min(1) })
    .passthrough(),

  SET_AGENT_KEYWORDS: z
    .object({ id: z.string().min(1), pattern: z.string() })
    .passthrough(),

  SET_DELEGATION_MODE: z
    .object({ delegation_mode: z.string().optional() })
    .passthrough(),

  // ---- theme: stage tuning / background / manual image upload -------------
  SAVE_STAGE_TUNING: z
    .object({
      theme_id: z.string().min(1),
      walkable_nav_polygon: z.array(z.tuple([z.number(), z.number()])),
      character_scale: z.number(),
      object_scale: z.number(),
      character_scale_overrides: z.record(z.number()),
      object_scale_overrides: z.record(z.number()),
      // Per-buildable/per-decor horizontal-flip overrides set by the Stage
      // Editor's F hotkey. Optional/passthrough-compatible so older webview
      // builds that don't send them still validate.
      object_flip_overrides: z.record(z.boolean()).optional(),
      decor_flip_overrides: z.record(z.boolean()).optional(),
      // Non-destructive Stage-Editor HIDE list for decor, set by the H
      // hotkey / Hide button. Optional so older webview builds that don't
      // send it still validate.
      decor_hidden: z.array(z.string()).optional(),
    })
    .passthrough(),

  REPLACE_BACKGROUND: z.object({ theme_id: z.string().min(1) }).passthrough(),

  UPLOAD_THEME_IMAGE: z
    .object({ theme_id: z.string().min(1), item_id: z.string().min(1) })
    .passthrough(),

  // ---- theme library: delete -----------------------------------------------
  DELETE_THEME: z.object({ theme_id: z.string().min(1) }).passthrough(),

  // ---- badges / rebirth persistence ----------------------------------------
  BADGE_UNLOCKED: z
    .object({ theme_id: z.string().min(1), badge_id: z.string().min(1) })
    .passthrough(),

  SAVE_REBIRTH_STATE: z
    .object({
      theme_id: z.string().min(1),
      state: z
        .object({
          count: z.number(),
          baseline: z
            .object({
              built: z.number(),
              evicted: z.number(),
              tasks: z.number(),
            })
            .passthrough(),
          required: z.array(z.string()),
          cycleBuilt: z.number().optional(),
          cycleEvicted: z.number().optional(),
        })
        .passthrough(),
    })
    .passthrough(),

  REBIRTH_RESET_BADGES: z.object({ theme_id: z.string().min(1) }).passthrough(),

  // ---- build progress persistence ------------------------------------------
  SAVE_BUILD_PROGRESS: z
    .object({
      themeId: z.string().min(1),
      builtCount: z.number().int().nonnegative(),
    })
    .passthrough(),

  // ---- theme character / stage item rename ---------------------------------
  RENAME_THEME_CHARACTER: z
    .object({
      theme_id: z.string().min(1),
      item_id: z.string().min(1),
      name: z.string().optional(),
    })
    .passthrough(),

  // Batched rename from the theme review screen's per-board "Names" editor —
  // one message per board carries every row's change so the host loads/writes
  // the theme once instead of once per row.
  SET_THEME_ITEM_NAMES: z
    .object({
      theme_id: z.string().min(1),
      board_id: z.string().min(1).optional(),
      changes: z
        .array(
          z
            .object({
              item_kind: z.enum(['object', 'decor', 'character', 'rival']),
              id: z.string().min(1),
              name: z.string().min(1).max(60),
            })
            .passthrough(),
        )
        .min(1),
    })
    .passthrough(),

  // ---- theme image retry ---------------------------------------------------
  RETRY_THEME_IMAGE: z
    .object({
      theme_id: z.string().min(1),
      item_id: z.string().min(1),
      feedback: z.string().optional(),
      mode: z.string().optional(),
      image_provider: z.string().optional(),
      character_name: z.string().optional(),
    })
    .passthrough(),

  // ---- project plan (optional): phase/task approval loop -------------------
  APPROVE_PHASE: z.object({ phaseId: z.string().min(1) }).passthrough(),

  OVERRIDE_TASK: z
    .object({
      taskId: z.string().min(1),
      action: z.enum(["approve", "retry", "skip"]),
    })
    .passthrough(),

  REQUEST_PLAN: z.object({}).passthrough(),

  // `enabled` mirrors the projectPlanEnabled toggle so the webview always
  // knows whether to show the Project Plan section, even when `plan` is
  // null (feature off, or on with no plan.json yet).
  PLAN_STATE: z
    .object({ plan: ProjectPlanSchema.nullable(), enabled: z.boolean() })
    .passthrough(),

  SET_PROJECT_PLAN_ENABLED: z.object({ enabled: z.boolean() }).passthrough(),
} as const;
