/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { z } from "zod";
import { ArchivedPlanSummarySchema, ProjectPlanSchema } from "./projectPlan";

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
  // Setup wizard Step 2 (Optionals): opt-in append of TycoonAgents runtime
  // state/log artifact paths (.claude/tycoon/, session journal) into the
  // workspace ignore file(s) — .gitignore always, plus .p4ignore too on a
  // detected UEFN/Perforce project (see panel.ts _handleAddGitignoreEntries).
  // No payload — the host owns the canonical entry list so the wizard can't
  // be tricked into ignoring arbitrary paths.
  ADD_GITIGNORE: "addGitignoreEntries",
  // Setup wizard Step 2 (Optionals) / Settings: opt-in removal of a legacy
  // managed block from CLAUDE.md — config carried over from a prior setup
  // (another Claude Code project's generator, or a previous plugin) or
  // currently written by another tool (see legacyDoctrine.ts). Requires the
  // `namespace` of the specific detected block to remove; the host strips
  // only that marker-delimited region. This button is the user's explicit
  // confirm, never an auto-delete on install. Re-posts INSTALL_STATE on
  // completion so the webview updates.
  REMOVE_MANAGED_BLOCK: "removeManagedBlock",
  GET_SETTINGS: "getSettings",
  SETTINGS: "settings",
  SETTINGS_UPDATED: "settingsUpdated",
  SET_AGENT_MODEL: "setAgentModel",
  SET_DELEGATION_MODE: "setDelegationMode",
  // Sibling of SET_DELEGATION_MODE: the optional "Review pass" toggle
  // composes with either delegation_mode rather than being a third mode.
  SET_REVIEW_ENABLED: "setReviewEnabled",
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
  // "Generate diagnostic report" (bug-report): host gathers already-computed
  // health signals, builds a SANITIZED Markdown report (diagnosticReport.ts),
  // writes it to .claude/tycoon/, opens it for review, and copies it to the
  // clipboard. No payload — purely a confirm-click trigger, same shape as
  // REPAIR_HOOK/REMOVE_MANAGED_BLOCK. No network, no runtime AI.
  GENERATE_DIAGNOSTIC: "generateDiagnostic",

  // ---- Feedback pipeline (docs/FEEDBACK-PIPELINE-SPEC.md) -----------------
  // SUBMIT_FEEDBACK builds a PREVIEW ONLY — no network call is made in
  // response to it. The host replies with FEEDBACK_PREVIEW carrying the
  // byte-exact JSON body it will POST later, keyed by `ticketId` (the host
  // retains that exact string so the preview can never drift from what's
  // actually sent). Only CONFIRM_FEEDBACK_SEND, echoing that `ticketId`,
  // triggers the real network POST; an unknown/expired `ticketId` fails safe
  // (no send, FEEDBACK_RESULT with ok:false).
  SUBMIT_FEEDBACK: "submitFeedback",
  FEEDBACK_PREVIEW: "feedbackPreview",
  CONFIRM_FEEDBACK_SEND: "confirmFeedbackSend",
  FEEDBACK_RESULT: "feedbackResult",

  // ---- Path Health diagnostics (src/host/vscode/pathHealth.ts) -----------
  // SET_PATH_OVERRIDE/CLEAR_PATH_OVERRIDE write/clear one key in
  // `.claude/tycoon/uefn-paths.json` (validated to exist on disk before
  // accepting a SET). REFRESH_PATH_HEALTH re-runs the probe and re-pushes
  // INSTALL_STATE (which now carries `pathHealth`/`verseExtensionState`
  // alongside the existing uefn* fields — see panel.ts _handleCheckInstall).
  // COPY_PATH_DIAGNOSTIC mirrors COPY_NUDGE's clipboard-write pattern but the
  // text is built host-side (fresh probe + Verse extension state) rather
  // than webview-side, since building it needs real filesystem access.
  SET_PATH_OVERRIDE: "setPathOverride",
  CLEAR_PATH_OVERRIDE: "clearPathOverride",
  // Reply to SET_PATH_OVERRIDE/CLEAR_PATH_OVERRIDE: `{ key, ok, error? }`.
  // `ok: false` carries a human-readable `error` (e.g. "nothing exists at
  // that path") the webview can show inline rather than a silent no-op.
  PATH_OVERRIDE_RESULT: "pathOverrideResult",
  REFRESH_PATH_HEALTH: "refreshPathHealth",
  COPY_PATH_DIAGNOSTIC: "copyPathDiagnostic",

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
  // Bottom-left "book" icon — opens the shipped static handbook
  // (media/handbook/index.html) in the user's default OS browser via
  // vscode.env.openExternal. No payload.
  OPEN_HANDBOOK: "OPEN_HANDBOOK",
  DESIGN_DOC_ACTION: "designDocAction",
  DESIGN_DOC_DONE: "designDocDone",
  PROJECT_PLAN_ACTION: "projectPlanAction",
  PROJECT_PLAN_DONE: "projectPlanDone",

  // ---- engine / UEFN -------------------------------------------------------
  GET_ENGINE_STATUS: "getEngineStatus",
  ENGINE_STATUS: "engineStatus",
  SETUP_UEFN_PROJECT: "setupUefnProject",
  UEFN_SETUP_DONE: "uefnSetupDone",

  // ---- theme image provider settings -------------------------------------
  GET_THEME_IMAGE_SETTINGS: "GET_THEME_IMAGE_SETTINGS",
  SAVE_THEME_IMAGE_SETTINGS: "SAVE_THEME_IMAGE_SETTINGS",
  THEME_IMAGE_SETTINGS: "THEME_IMAGE_SETTINGS",
  // Preference-only persistence (provider + model, no api_key) fired on
  // dropdown `change` so a selection survives panel close/reopen without
  // requiring a Save click. See saveThemeImagePreference in
  // extension/themeImageSettings.ts. No reply message — the webview already
  // reflects the change locally.
  SET_THEME_IMAGE_PREFERENCE: "SET_THEME_IMAGE_PREFERENCE",

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
  // Sent instead of THEME_INITIALIZED when the user cancels the
  // theme-switch warning modal — lets the webview revert its optimistic
  // "selected" highlight back to the theme that's still actually loaded.
  THEME_SELECT_ABORTED: "THEME_SELECT_ABORTED",

  // ---- badges / rebirth persistence --------------------------------------
  BADGE_UNLOCKED: "BADGE_UNLOCKED",
  SAVE_REBIRTH_STATE: "SAVE_REBIRTH_STATE",
  REBIRTH_RESET_BADGES: "REBIRTH_RESET_BADGES",

  // ---- build progress persistence ------------------------------------------
  SAVE_BUILD_PROGRESS: "saveBuildProgress",

  // ---- roster order persistence ---------------------------------------------
  // Character roster order (drag-reorder in the "Character roster order"
  // modal section, including which character occupies Seat 1 / leader — see
  // main.js isLeaderEntry, which derives leader-ness purely from index 0).
  SAVE_ROSTER_ORDER: "saveRosterOrder",

  // ---- theme image review / retry / reslice / normalize / rename ---------
  OPEN_THEME_IMAGES: "OPEN_THEME_IMAGES",
  REVEAL_THEME_IMAGE: "REVEAL_THEME_IMAGE",
  GET_THEME_IMAGE_REVIEW: "GET_THEME_IMAGE_REVIEW",
  THEME_IMAGE_REVIEW: "THEME_IMAGE_REVIEW",
  SET_THEME_IMAGE_REVIEW_STATUS: "SET_THEME_IMAGE_REVIEW_STATUS",
  APPROVE_ALL_THEME_IMAGES: "APPROVE_ALL_THEME_IMAGES",
  THEME_APPROVE_ALL_RESULT: "THEME_APPROVE_ALL_RESULT",
  RENAME_THEME_CHARACTER: "RENAME_THEME_CHARACTER",
  THEME_CHARACTER_RENAME_STATE: "THEME_CHARACTER_RENAME_STATE",
  SET_THEME_ITEM_NAMES: "SET_THEME_ITEM_NAMES",
  THEME_ITEM_NAMES_RESULT: "THEME_ITEM_NAMES_RESULT",
  SET_THEME_ITEM_DESCRIPTIONS: "SET_THEME_ITEM_DESCRIPTIONS",
  THEME_ITEM_DESCRIPTIONS_RESULT: "THEME_ITEM_DESCRIPTIONS_RESULT",
  // Single-object, non-batched sibling of SET_THEME_ITEM_NAMES: the theme
  // review screen's per-animated-object "Acts as turret" checkbox (Phase 2
  // groundwork — see BuildableObject.is_turret in shared/types.ts and
  // applyThemeObjectTurretFlag in themeService.ts). No *_RESULT reply; the
  // host reposts THEME_INITIALIZED on success so the webview's live
  // turretObjectIds set refreshes.
  SET_THEME_OBJECT_TURRET: "SET_THEME_OBJECT_TURRET",
  // Post-generation editor for the whole-theme art seed (ThemePlan.creative_direction —
  // themePlanCreativeDirection() threads it into every board's image prompt). Unlike
  // SET_THEME_ITEM_DESCRIPTIONS, this is a single string, not a per-row batch, and it
  // lives in the theme review screen's background/environment board card. No resync of
  // saved review prompts is needed on save — retries always rebuild the prompt fresh
  // from the current plan at retry time (see selectThemeImageRetryPrompt's freshBasePrompt).
  SET_THEME_CREATIVE_DIRECTION: "SET_THEME_CREATIVE_DIRECTION",
  THEME_CREATIVE_DIRECTION_RESULT: "THEME_CREATIVE_DIRECTION_RESULT",
  RESET_THEME_BADGE_NAMES: "RESET_THEME_BADGE_NAMES",
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
  // Inbound: user asks the host to restore plan.json from plan.json.bak
  // after a corrupted-plan read (see readPlanSafe / _postPlanState in
  // panel.ts). No-ops (and reposts current state) when no backup exists.
  RESTORE_PLAN_BACKUP: "RESTORE_PLAN_BACKUP",
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

  // Sibling of SET_DELEGATION_MODE — the optional Review-pass toggle, on by
  // default (see delegationDoctrine.ts's ExecutionConfig.reviewEnabled).
  SET_REVIEW_ENABLED: z.object({ enabled: z.boolean() }).passthrough(),

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

  // Right-click "Open file location" on a review board — reveal its saved image
  // file in the OS file explorer. Read-only (no mutation) but validated so a
  // malformed payload is dropped rather than reaching the reveal call.
  REVEAL_THEME_IMAGE: z
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

  // ---- roster order persistence ---------------------------------------------
  SAVE_ROSTER_ORDER: z
    .object({
      themeId: z.string().min(1),
      rosterOrder: z.array(z.string()).max(64),
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
              item_kind: z.enum(['object', 'decor', 'character', 'rival', 'badge']),
              id: z.string().min(1),
              name: z.string().min(1).max(60),
            })
            .passthrough(),
        )
        .min(1),
    })
    .passthrough(),

  // Batched description edit from the theme review screen's per-board
  // "Descriptions" editor — mirrors SET_THEME_ITEM_NAMES, but descriptions live
  // in plan.json (character_descriptions/object_descriptions/decor_descriptions/
  // enemy_descriptions/crate_description/poof_description/achievement_descriptions),
  // never the manifest. 'badge' rows write plan.achievement_descriptions[idx]
  // (positional, id `achievement_<index>`) — the badge's appearance field, kept
  // separate from its display-name/title (see applyThemeItemDescriptionChanges).
  // description ALLOWS an empty string — that clears the row's description —
  // unlike name, which requires min(1). 'crate', 'poof', and 'projectile' are
  // single required rows (crate/poof on object board 2, projectile on the
  // background decor board) — description-only, deliberately absent from
  // SET_THEME_ITEM_NAMES since none of the three is ever renamed or removed.
  SET_THEME_ITEM_DESCRIPTIONS: z
    .object({
      theme_id: z.string().min(1),
      board_id: z.string().min(1).optional(),
      changes: z
        .array(
          z
            .object({
              item_kind: z.enum(['object', 'decor', 'character', 'rival', 'crate', 'poof', 'projectile', 'badge', 'expression']),
              id: z.string().min(1),
              description: z.string().max(400),
            })
            .passthrough(),
        )
        .min(1),
    })
    .passthrough(),

  // Theme review screen's per-animated-object "Acts as turret" checkbox.
  // Single object, single boolean — deliberately NOT folded into
  // SET_THEME_ITEM_NAMES/SET_THEME_ITEM_DESCRIPTIONS's batched-changes shape
  // since it's always exactly one field on one row, fired immediately on
  // checkbox change rather than staged behind an Apply button.
  SET_THEME_OBJECT_TURRET: z
    .object({
      theme_id: z.string().min(1),
      object_id: z.string().min(1),
      is_turret: z.boolean(),
    })
    .passthrough(),

  // Post-generation Creative Direction editor (theme review screen). A single
  // trimmed string overwriting plan.creative_direction — see MSG.SET_THEME_CREATIVE_DIRECTION.
  SET_THEME_CREATIVE_DIRECTION: z
    .object({
      theme_id: z.string().min(1),
      creative_direction: z.string(),
    })
    .passthrough(),

  // Restore every badge's canonical default TITLE (buildDefaultBadges display_name),
  // moving any current custom title into that badge's appearance-description field
  // first (plan.achievement_descriptions) so the user's typed appearance text is
  // preserved. Host shows a modal confirm before proceeding. Payload: theme_id.
  RESET_THEME_BADGE_NAMES: z
    .object({
      theme_id: z.string().min(1),
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

  // No required fields — host computes the fixed artifact-path list itself.
  ADD_GITIGNORE: z.object({}).passthrough(),

  // `namespace` identifies WHICH detected managed block to strip — the host
  // never guesses; this message is the user's confirm-click trigger for one
  // specific block surfaced by detectForeignManagedBlocks.
  REMOVE_MANAGED_BLOCK: z.object({ namespace: z.string().min(1) }).passthrough(),

  // No required fields — the host gathers every input itself; this message
  // is purely the user's confirm-click trigger from Settings.
  GENERATE_DIAGNOSTIC: z.object({}).passthrough(),

  // ---- Feedback pipeline ----------------------------------------------------
  // Preview-only build request — see MSG.SUBMIT_FEEDBACK above. No network
  // call happens as a direct result of this message.
  SUBMIT_FEEDBACK: z
    .object({
      category: z.enum(["bug", "idea", "question", "other"]),
      userDescription: z.string().min(1).max(4000),
      includeDiagnostics: z.boolean(),
      contact: z.string().max(500).optional(),
    })
    .passthrough(),
  // The ONLY message that triggers the actual POST — see MSG.CONFIRM_FEEDBACK_SEND above.
  CONFIRM_FEEDBACK_SEND: z.object({ ticketId: z.string().min(1) }).passthrough(),

  // ---- Path Health diagnostics --------------------------------------------
  // `key` is validated against PATH_OVERRIDE_KEYS host-side (isPathOverrideKey)
  // rather than a zod enum here, so a new override key added to pathHealth.ts
  // doesn't require touching this schema too.
  SET_PATH_OVERRIDE: z.object({ key: z.string().min(1), path: z.string().min(1) }).passthrough(),
  CLEAR_PATH_OVERRIDE: z.object({ key: z.string().min(1) }).passthrough(),
  REFRESH_PATH_HEALTH: z.object({}).passthrough(),
  COPY_PATH_DIAGNOSTIC: z.object({}).passthrough(),

  // `enabled` mirrors the projectPlanEnabled toggle so the webview always
  // knows whether to show the Project Plan section, even when `plan` is
  // null (feature off, or on with no plan.json yet). `archivedPlans`
  // (0.0.340+) lists every completed-and-approved plan snapshot archived
  // under .claude/tycoon/plans/ — the webview only shows an "Archived
  // Plans" section when this array is non-empty; always `[]`, never
  // omitted, when disabled/no-root.
  //
  // planReadable/planError/hasBackup are OPTIONAL additions for the
  // corrupted-plan.json case (a dropped `},{` boundary between two task
  // objects, etc — see readPlanSafe in projectPlan.ts): `planReadable`
  // defaults true and is only ever `false` when plan.json exists but failed
  // to parse/validate; `planError` carries a short message in that case;
  // `hasBackup` reports whether `.claude/tycoon/plan.json.bak` exists so the
  // webview can offer a restore action. Optional (not required) to stay
  // backward compatible with any code constructing this payload literally.
  PLAN_STATE: z
    .object({
      plan: ProjectPlanSchema.nullable(),
      enabled: z.boolean(),
      archivedPlans: z.array(ArchivedPlanSummarySchema),
      planReadable: z.boolean().optional(),
      planError: z.string().optional(),
      hasBackup: z.boolean().optional(),
    })
    .passthrough(),

  SET_PROJECT_PLAN_ENABLED: z.object({ enabled: z.boolean() }).passthrough(),
  RESTORE_PLAN_BACKUP: z.object({}).passthrough(),
} as const;
