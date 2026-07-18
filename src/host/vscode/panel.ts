/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Runtime } from "./runtime";
import { computeDelegationModeStats, computeStateFromRecords } from "../../core/state";
import type { HookRecord } from "../../providers/claude-code/hookRecord";
import {
  shortFromModelId,
  modelIdFromShort,
  setFrontmatterModel,
  setKeywordPattern,
  removeKeywordPattern,
  isSafeAgentId,
} from "./agentConfig";
import { loadAgentRoster } from "../../providers/claude-code/agentRoster";
import { mergeMcpServer, hasMcpServer, removeMcpServer } from "./mcpCatalog";
import { buildAgentMarkdown, agentMarkdownTier, agentMarkdownHasTycoonMarker, LEAD_AGENTS, REVIEWER_AGENTS, workerAgentsForProject, UEFN_CONFLICT_AGENT_IDS, conflictingUefnAgents, type PackAgent } from "./packCatalog";
import {
  seedMissingAgentKeywords,
  parseAgentKeywords,
  reconcileAgentKeywords,
  migrateSupersededKeywords,
} from "./agentKeywordDefaults";
import {
  renderDelegationDoctrine,
  upsertDelegationSection,
  readExecutionConfig,
  writeExecutionConfig,
  type DelegationMode,
  type DoctrineRosterAgent,
} from "./delegationDoctrine";
import { renderCodeRules, upsertCodeRulesSection } from "./codeRulesDoctrine";
import { detectForeignManagedBlocks, stripManagedBlock } from "./legacyDoctrine";
import { detectUefnProject } from "./uefnDetect";
import { buildContextBudget } from "./contextBudget";
import { computeEngineChips, mcpEntryForEngine, type EngineChip } from "./engineDetect";
import { nativeWindowsUserDataPath } from "./revealUri";
import {
  approveAllThemeImages,
  boardBackgroundModeForProvider,
  buildReplacementPrompt,
  deleteTheme,
  ensureThemeReviewImages,
  exportThemeArchive,
  getThemeImageReview,
  importThemeArchive,
  listThemes,
  loadCurrentThemePlan,
  loadTheme,
  loadLatestTheme,
  normalizeThemeCharacterAtlas,
  planTheme,
  readThemeArchive,
  regenerateThemeBoard,
  renameThemeCharacter,
  renameThemeItemsBatch,
  resetThemeBadgeNames,
  replaceThemeBackground,
  resliceThemeImageFromRaw,
  retryThemeImage,
  resumeThemeGeneration,
  saveThemeTuning,
  updateThemeImageReviewStatus,
  updateThemeItemDescriptionsBatch,
  upgradeInstalledThemes,
  uploadThemeImage,
  generateTheme as generateThemeService,
} from "../../extension/themeService";
import { sanitizeRetryNotes } from "../../extension/themeImageRetry";
import type { ThemeImageRetryMode } from "../../extension/themeImageRetry";
import { themePlanCreativeDirection } from "../../extension/themePlan";
import type { ThemePlan } from "../../extension/themePlan";
import type {
  BoardKind,
  ThemeImageReviewWaitOptions,
  ThemeItemDescriptionChange,
  ThemeItemNameChange,
} from "../../extension/themeService";
import type { ThemeManifest } from "../../shared/types";
import { themeImagesDirectoryUri, themeRawImagesDirectoryUri } from "../../extension/themeStorage";
import { validateThemeIntegrity } from "../../extension/themeHealth";
import {
  getConfiguredThemeImageProvider,
  getThemeImageConfigurationStatus,
  resolveThemeImageSettings,
  saveThemeImageSettings,
} from "../../extension/themeImageSettings";
import { MSG, MSG_SCHEMAS } from "./messages";
import {
  readPlanSafe,
  writePlan,
  approvePhase,
  overrideTask,
  archivePlanIfComplete,
  readArchivedPlans,
  projectPlanBackupFilePath,
} from "./projectPlan";
import { buildDiagnosticReport, type DiagnosticReportInput } from "./diagnosticReport";

/**
 * Persisted per-theme rebirth (prestige) state, stored host-side in
 * rebirth-state.json keyed by theme_id. Mirrors the webview's rebirth blob so
 * the requirement survives webview disposal/reload.
 */
interface RebirthPersist {
  count: number;
  baseline: { built: number; evicted: number; tasks: number };
  required: string[];
  /** DURABLE per-cycle badge counters (persist across reload; reset on rebirth). */
  cycleBuilt?: number;
  cycleEvicted?: number;
  rackInsertIndex?: number;
  rangedUnlocked?: boolean;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import {
  mergeTycoonHooks,
  cleanupForeignHookArtifacts,
  findLegacyHookCommands,
  LEGACY_STATE_FILE_NAMES,
} from "./hookInstall";
export { mergeTycoonHooks } from "./hookInstall";
import { diagnose, DoctorFinding, DoctorInput, findForeignHooks, repairSettings } from "./hookDoctor";
import {
  projectScopeKey,
  readCompositeWithMigration,
  writeComposite,
  removeProjectThemeEntry,
  removeLegacyThemeEntry,
  removeThemeEverywhere,
  shouldWarnOnThemeSwitch,
  resolveProjectRoot,
} from "./progressScope";

/**
 * Optional "Project Plan" feature (opt-in, default OFF): resolve
 * `.claude/tycoon/plan.json` and read/write the `projectPlanEnabled` flag
 * inside `.claude/tycoon/execution.json` — the SAME file
 * `delegationDoctrine.ts`'s `readExecutionConfig`/`writeExecutionConfig`
 * store `delegation_mode` in. These read/write the raw JSON directly
 * (instead of going through that module's typed `ExecutionConfig` shape) so
 * this feature stays additive without touching delegationDoctrine.ts.
 */
function projectPlanFilePath(root: string): string {
  return path.join(root, ".claude", "tycoon", "plan.json");
}

function projectPlanExecutionConfigPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "execution.json");
}

/** Read the opt-in flag; missing file/dir/field all default to `false`. */
function readProjectPlanEnabled(root: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectPlanExecutionConfigPath(root), "utf8"));
    return parsed !== null && typeof parsed === "object" && parsed.projectPlanEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Persist the opt-in flag, preserving any other fields (e.g.
 * `delegation_mode`) already on disk via a read-modify-write merge.
 * `delegationDoctrine.ts`'s `writeExecutionConfig` does the same merge in
 * the other direction, so either writer preserves the other's keys.
 */
function writeProjectPlanEnabled(root: string, enabled: boolean): void {
  const configPath = projectPlanExecutionConfigPath(root);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed !== null && typeof parsed === "object") existing = parsed as Record<string, unknown>;
  } catch {
    /* missing/invalid => start fresh */
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...existing, projectPlanEnabled: enabled }, null, 2));
}

/** Singleton webview panel that renders the TycoonAgents visualization. */
export class TycoonPanel {
  public static currentPanel: TycoonPanel | undefined;
  private static readonly viewType = "tycoonagents";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _runtime: Runtime;
  private readonly _globalStorageUri: vscode.Uri;
  private readonly _secrets: vscode.SecretStorage;
  private _disposables: vscode.Disposable[] = [];
  private _runtimeDisposable: { dispose(): void } | undefined;
  private _enginePollInterval: NodeJS.Timeout | undefined;
  /** Cached "connected" results for HTTP-probeable engine MCP entries (e.g. unreal-engine-mcp), keyed by engine id. */
  private _engineProbeCache: Map<string, boolean> = new Map();
  /** Engine ids with an in-flight probe fetch — guards against stacking probes across poll ticks. */
  private _engineProbeInFlight: Set<string> = new Set();
  /**
   * Watches `.claude/tycoon/plan.json` and `.claude/tycoon/execution.json`
   * (for the `projectPlanEnabled` flag) so the Project Plan panel reflects
   * on-disk edits LIVE — the `project-plan` skill rewrites plan.json
   * continuously during execution, and the panel previously only requested
   * plan state once at webview boot (see `_postPlanState`). `undefined`
   * when there's no workspace root to scope a `RelativePattern` to.
   */
  private _planWatcher: vscode.FileSystemWatcher | undefined;
  /** Coalesces bursts of rapid on-disk writes (the skill can rewrite plan.json many times in quick succession) into a single PLAN_STATE post. */
  private _planWatcherDebounce: NodeJS.Timeout | undefined;
  private _themeGenerationActive = false;
  /**
   * theme_id of the theme most recently sent to the webview via
   * THEME_INITIALIZED (set inside `_buildThemeInitPayload`, which every
   * THEME_INITIALIZED post funnels through). Used to know the "currently
   * loaded" theme for the theme-switch warning and the scoped stats reset —
   * this panel doesn't otherwise track active theme state host-side.
   */
  private _currentThemeId: string | undefined;
  private _themeGenerationAbortController: AbortController | undefined;
  private _themeGenerationGateRetryActive = false;
  private _themePauseForReview = true;
  private _themeGenerationReviewGate: {
    themeId: string;
    itemId: string;
    requiresReplacement: boolean;
    generatedReplacementReady: boolean;
    replacement?: Awaited<ReturnType<typeof retryThemeImage>>;
    accept(): void;
    cancel(): void;
  } | undefined;

  public static createOrShow(
    extensionUri: vscode.Uri,
    runtime: Runtime,
    globalStorageUri: vscode.Uri,
    secrets: vscode.SecretStorage,
  ): TycoonPanel {
    // Dock beside the editor (ViewColumn.Two) so we never cover the active
    // Claude Code session in column One.
    const column = vscode.ViewColumn.Two;

    if (TycoonPanel.currentPanel) {
      TycoonPanel.currentPanel._panel.reveal(column, /* preserveFocus */ true);
      return TycoonPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      TycoonPanel.viewType,
      "TycoonAgents",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        // Keep the webview alive when hidden so state/animation don't reset.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media"), globalStorageUri],
      }
    );

    TycoonPanel.currentPanel = new TycoonPanel(panel, extensionUri, runtime, globalStorageUri, secrets);
    return TycoonPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    runtime: Runtime,
    globalStorageUri: vscode.Uri,
    secrets: vscode.SecretStorage,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._runtime = runtime;
    this._globalStorageUri = globalStorageUri;
    this._secrets = secrets;

    // Auto-heal the CLAUDE.md delegation doctrine once per panel open (see
    // _ensureDelegationDoctrineCurrent doc comment) — fixes 0% delegation on
    // projects upgraded from a version that predates the doctrine.
    this._ensureDelegationDoctrineCurrent();

    // Auto-heal a missing project-appropriate worker roster once per panel
    // open (see _ensureWorkerAgentsInstalled doc comment) — fixes
    // search-retrieval (and, for non-UEFN projects, coding-specialist +
    // ux-ui-designer) never being installed, which left delegated work with
    // no matching agent file to route to. Runs BEFORE
    // _ensureAgentKeywordsSeeded so any newly created worker files get their
    // keyword routing seeded in this same panel-load cycle.
    this._ensureWorkerAgentsInstalled();

    // Auto-heal missing/empty agent-keywords.json entries once per panel
    // open (see _ensureAgentKeywordsSeeded doc comment) — fixes inert
    // `kw1|kw2|kw3` placeholders on projects whose roster was never
    // registered for keyword routing.
    this._ensureAgentKeywordsSeeded();

    // Auto-heal a stale on-disk hook script once per panel open (see
    // _ensureHookScriptFresh doc comment) — fixes a project's
    // tycoon-claude-hook.cjs never picking up an extension update because
    // it previously only ever refreshed on an explicit "Install hooks"
    // click.
    this._ensureHookScriptFresh();

    // Auto-heal a stale on-disk project-plan skill once per panel open (see
    // _ensureProjectPlanSkillFresh doc comment) — fixes the skill drifting
    // out of date on a project where Project Plan is enabled but the skill
    // was only ever copied once at install time.
    this._ensureProjectPlanSkillFresh();

    this._update();

    // Subscribe to runtime state changes
    this._runtimeDisposable = runtime.onChange((state) => {
      void this._panel.webview.postMessage({ type: MSG.STATE, state: this._applyTimeAdjustments(state) });
    });

    // Start the engine-status poller (fires immediately, then every 10 s).
    this._pollEngineStatus();
    this._enginePollInterval = setInterval(() => this._pollEngineStatus(), 10000);

    // Watch plan.json + execution.json so the Project Plan section updates
    // live as the project-plan skill rewrites plan.json during execution
    // (see _postPlanState / _setupPlanWatcher doc comments).
    this._setupPlanWatcher();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message: {
        type: string;
        id?: string;
        model?: string;
        pattern?: string;
        delegation_mode?: string;
        enabled?: boolean;
        thirdParty?: boolean;
        disclosures?: Array<{
          label?: string;
          vendor?: string;
          package?: string;
          homepage?: string;
          network?: boolean;
          dataNote?: string;
        }>;
      }) => {
        if (message.type === MSG.READY) {
          void this._panel.webview.postMessage({ type: MSG.STATE, state: this._applyTimeAdjustments(runtime.getState()) });
          // Auto-load the latest theme so the main panel shows the real
          // characters + environment on open (mirrors the Theater view).
          void (async () => {
            const t = await loadLatestTheme(this._globalStorageUri);
            if (t) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(t.manifest, t.frames, false),
              });
            } else {
              // No theme on disk yet (fresh install) — tell the webview
              // explicitly so its boot loader can hand off to the no-theme
              // placeholder scene immediately instead of idling out its
              // stage-loading timeout.
              void this._panel.webview.postMessage({ type: MSG.THEME_NONE });
            }
          })();
        } else if (message.type === MSG.SAVE_STAGE_TUNING) {
          const rawStageTuning = (message as any).payload;
          const parsedStageTuning = MSG_SCHEMAS.SAVE_STAGE_TUNING.safeParse(rawStageTuning);
          if (!parsedStageTuning.success) {
            void this._panel.webview.postMessage({
              type: MSG.STAGE_TUNING_SAVED,
              payload: { ok: false, theme_id: rawStageTuning?.theme_id },
            });
            return;
          }
          const p = parsedStageTuning.data;
          const ok = await saveThemeTuning(this._globalStorageUri, p);
          void this._panel.webview.postMessage({ type: MSG.STAGE_TUNING_SAVED, payload: { ok, theme_id: p.theme_id } });
        } else if (message.type === MSG.REPLACE_BACKGROUND) {
          const parsedReplaceBg = MSG_SCHEMAS.REPLACE_BACKGROUND.safeParse((message as any).payload);
          if (!parsedReplaceBg.success) {
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: false } });
            return;
          }
          const themeId = parsedReplaceBg.data.theme_id;
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "Use as background",
            filters: { Images: ["png", "jpg", "jpeg", "webp"] },
          });
          if (!picked || picked.length === 0) {
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: false, cancelled: true } });
            return;
          }
          const bytes = await vscode.workspace.fs.readFile(picked[0]);
          const updated = await replaceThemeBackground(this._globalStorageUri, themeId, bytes);
          if (updated) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_INITIALIZED,
              payload: await this._buildThemeInitPayload(updated.manifest, updated.frames, false),
            });
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: true } });
          } else {
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: false } });
          }
        } else if (message.type === MSG.UPLOAD_THEME_IMAGE) {
          const parsedUploadImage = MSG_SCHEMAS.UPLOAD_THEME_IMAGE.safeParse((message as any).payload);
          if (!parsedUploadImage.success) {
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: false } });
            return;
          }
          const { theme_id, item_id } = parsedUploadImage.data;
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { Images: ["png", "jpg", "jpeg", "webp"] },
          });
          if (!picked || picked.length === 0) {
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: false, cancelled: true } });
            return;
          }
          const bytes = await vscode.workspace.fs.readFile(picked[0]);
          const result = await uploadThemeImage(this._globalStorageUri, theme_id, item_id, bytes);
          if (result) {
            await this._postThemeImageReview(theme_id);
            void this._panel.webview.postMessage({
              type: MSG.THEME_INITIALIZED,
              payload: await this._buildThemeInitPayload(result.manifest, result.frames, true),
            });
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: true } });
          } else {
            void this._panel.webview.postMessage({ type: MSG.BACKGROUND_REPLACE_RESULT, payload: { ok: false } });
          }
        } else if (message.type === MSG.GET_SKILLS) {
          this._handleGetSkills();
        } else if (message.type === MSG.INSTALL_SKILL) {
          const parsedInstallSkill = MSG_SCHEMAS.ID_ONLY.safeParse(message);
          if (parsedInstallSkill.success) {
            this._handleInstallSkill(parsedInstallSkill.data.id);
          } else {
            console.error("TycoonAgents: installSkill payload rejected:", parsedInstallSkill.error.message);
          }
        } else if (message.type === MSG.REMOVE_SKILL) {
          const parsedRemoveSkill = MSG_SCHEMAS.ID_ONLY.safeParse(message);
          if (parsedRemoveSkill.success) {
            await this._handleRemoveSkill(parsedRemoveSkill.data.id);
          } else {
            console.error("TycoonAgents: removeSkill payload rejected:", parsedRemoveSkill.error.message);
          }
        } else if (message.type === MSG.GET_MCP) {
          this._handleGetMcp();
        } else if (message.type === MSG.INSTALL_MCP) {
          if (message.id !== undefined) {
            await this._handleInstallMcp(message.id, message.thirdParty === true);
          }
        } else if (message.type === MSG.REMOVE_MCP) {
          if (message.id !== undefined) {
            await this._handleRemoveMcp(message.id);
          }
        } else if (message.type === MSG.CHECK_INSTALL) {
          this._handleCheckInstall();
        } else if (message.type === MSG.ADD_GITIGNORE) {
          const parsedAddGitignore = MSG_SCHEMAS.ADD_GITIGNORE.safeParse(message);
          if (parsedAddGitignore.success) {
            this._handleAddGitignoreEntries();
          } else {
            console.error("TycoonAgents: addGitignoreEntries payload rejected:", parsedAddGitignore.error.message);
          }
        } else if (message.type === MSG.REMOVE_MANAGED_BLOCK) {
          const parsedRemoveManagedBlock = MSG_SCHEMAS.REMOVE_MANAGED_BLOCK.safeParse(message);
          if (parsedRemoveManagedBlock.success) {
            this._handleRemoveManagedBlock(parsedRemoveManagedBlock.data.namespace);
          } else {
            console.error(
              "TycoonAgents: removeManagedBlock payload rejected:",
              parsedRemoveManagedBlock.error.message
            );
          }
        } else if (message.type === MSG.INSTALL_HOOKS) {
          // SET_DELEGATION_MODE and INSTALL_HOOKS share the same
          // { delegation_mode?: string } shape.
          const parsedInstallHooks = MSG_SCHEMAS.SET_DELEGATION_MODE.safeParse(message);
          if (parsedInstallHooks.success) {
            this._handleInstallHooks(this._coerceDelegationMode(parsedInstallHooks.data.delegation_mode));
          } else {
            console.error("TycoonAgents: installHooks payload rejected:", parsedInstallHooks.error.message);
          }
        } else if (message.type === MSG.GET_SETTINGS) {
          this._handleGetSettings();
        } else if (message.type === MSG.SET_AGENT_MODEL) {
          const parsedSetAgentModel = MSG_SCHEMAS.SET_AGENT_MODEL.safeParse(message);
          if (parsedSetAgentModel.success) {
            this._handleSetAgentModel(parsedSetAgentModel.data.id, parsedSetAgentModel.data.model);
          } else {
            console.error("TycoonAgents: setAgentModel payload rejected:", parsedSetAgentModel.error.message);
          }
        } else if (message.type === MSG.SET_DELEGATION_MODE) {
          const parsedSetDelegationMode = MSG_SCHEMAS.SET_DELEGATION_MODE.safeParse(message);
          if (parsedSetDelegationMode.success) {
            this._handleSetDelegationMode(parsedSetDelegationMode.data.delegation_mode);
          } else {
            console.error("TycoonAgents: setDelegationMode payload rejected:", parsedSetDelegationMode.error.message);
          }
        } else if (message.type === MSG.SET_REVIEW_ENABLED) {
          const parsedSetReviewEnabled = MSG_SCHEMAS.SET_REVIEW_ENABLED.safeParse(message);
          if (parsedSetReviewEnabled.success) {
            this._handleSetReviewEnabled(parsedSetReviewEnabled.data.enabled);
          } else {
            console.error("TycoonAgents: setReviewEnabled payload rejected:", parsedSetReviewEnabled.error.message);
          }
        } else if (message.type === MSG.SET_AGENT_KEYWORDS) {
          const parsedSetAgentKeywords = MSG_SCHEMAS.SET_AGENT_KEYWORDS.safeParse(message);
          if (parsedSetAgentKeywords.success) {
            this._handleSetAgentKeywords(parsedSetAgentKeywords.data.id, parsedSetAgentKeywords.data.pattern);
          } else {
            console.error("TycoonAgents: setAgentKeywords payload rejected:", parsedSetAgentKeywords.error.message);
          }
        } else if (message.type === MSG.REMOVE_AGENT) {
          const parsedRemoveAgent = MSG_SCHEMAS.ID_ONLY.safeParse(message);
          if (parsedRemoveAgent.success) {
            await this._handleRemoveAgent(parsedRemoveAgent.data.id);
          } else {
            console.error("TycoonAgents: removeAgent payload rejected:", parsedRemoveAgent.error.message);
          }
        } else if (message.type === MSG.REPAIR_HOOK) {
          // Repair only fixes the hook registration — it must not silently
          // revert an existing team_leads project back to flat, so it reuses
          // whatever mode is already on disk rather than defaulting.
          const root = this._projectRoot();
          const currentMode =
            root !== "" ? readExecutionConfig(path.join(root, ".claude")).delegation_mode : "flat";
          this._handleInstallHooks(currentMode);
          this._handleGetSettings();
        } else if (message.type === MSG.GENERATE_DIAGNOSTIC) {
          const parsedGenerateDiagnostic = MSG_SCHEMAS.GENERATE_DIAGNOSTIC.safeParse(message);
          if (parsedGenerateDiagnostic.success) {
            await this._handleGenerateDiagnostic();
          } else {
            console.error(
              "TycoonAgents: generateDiagnostic payload rejected:",
              parsedGenerateDiagnostic.error.message
            );
          }
        } else if (message.type === MSG.RESET_METRICS) {
          void this._handleResetMetrics();
        } else if (message.type === MSG.GET_PACKS) {
          this._handleGetPacks();
        } else if (message.type === MSG.INSTALL_PACK) {
          const parsedInstallPack = MSG_SCHEMAS.INSTALL_PACK.safeParse(message);
          if (parsedInstallPack.success) {
            await this._handleInstallPack(
              parsedInstallPack.data.id,
              parsedInstallPack.data.thirdParty === true,
              parsedInstallPack.data.disclosures,
            );
          } else {
            console.error("TycoonAgents: installPack payload rejected:", parsedInstallPack.error.message);
          }
        } else if (message.type === MSG.REMOVE_PACK) {
          const parsedRemovePack = MSG_SCHEMAS.ID_ONLY.safeParse(message);
          if (parsedRemovePack.success) {
            await this._handleRemovePack(parsedRemovePack.data.id);
          } else {
            console.error("TycoonAgents: removePack payload rejected:", parsedRemovePack.error.message);
          }
        } else if (message.type === MSG.COPY_NUDGE) {
          const text = String((message as any).text ?? "");
          if (text !== "") {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage("Delegation tip copied to clipboard.");
          }
        } else if (message.type === MSG.COPY_PROMPT) {
          const t = String((message as any).text ?? "");
          if (t) {
            await vscode.env.clipboard.writeText(t);
            vscode.window.showInformationMessage("Prompt copied — paste it into Claude Code to run it.");
          }
        } else if (message.type === MSG.GET_ENGINE_STATUS) {
          this._pollEngineStatus();
        } else if (message.type === MSG.SETUP_UEFN_PROJECT) {
          void this._handleSetupUefnProject();
        } else if (message.type === MSG.RUN_DOCTOR) {
          this._handleRunDoctor();
        } else if (message.type === MSG.APPLY_DOCTOR_FIX) {
          void this._handleApplyDoctorFix((message as any).removeForeign === true);
        } else if (message.type === MSG.DESIGN_DOC_ACTION) {
          await this._handleDesignDocAction((message as any).mode);
        } else if (message.type === MSG.PROJECT_PLAN_ACTION) {
          await this._handleInstallProjectPlanSkill();
        } else if (message.type === MSG.GET_THEME_IMAGE_SETTINGS) {
          const providers = await getThemeImageConfigurationStatus(this._secrets);
          void this._panel.webview.postMessage({
            type: MSG.THEME_IMAGE_SETTINGS,
            payload: { provider: await getConfiguredThemeImageProvider(this._secrets), providers },
          });
        } else if (message.type === MSG.SAVE_THEME_IMAGE_SETTINGS) {
          const payload = (message as any).payload as { provider?: string; api_key?: string } | undefined;
          try {
            const provider = await saveThemeImageSettings(
              this._secrets,
              payload?.provider,
              payload?.api_key,
            );
            const providers = await getThemeImageConfigurationStatus(this._secrets);
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_SETTINGS,
              payload: { provider, providers, saved: true },
            });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_SETTINGS,
              payload: { error: String(err) },
            });
          }
        } else if (message.type === MSG.LIST_THEMES) {
          const themes = await listThemes(this._globalStorageUri);
          void this._panel.webview.postMessage({ type: MSG.THEMES_LIST, payload: { themes } });
        } else if (message.type === MSG.EXPORT_THEME) {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          try {
            if (this._themeGenerationActive) {
              throw new Error("Stop the active theme generation before exporting a theme.");
            }
            const theme = (await listThemes(this._globalStorageUri))
              .find((candidate) => candidate.theme_id === themeId);
            if (!theme) throw new Error("Theme not found.");
            if (!theme.export_ready) {
              throw new Error(`Approve all theme images before exporting (${theme.accepted}/${theme.total} approved).`);
            }

            const destination = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(os.homedir(), `${themeId}.zip`)),
              filters: { "Theme archives": ["zip"] },
              saveLabel: "Export theme",
              title: `Export ${theme.display_name}`,
            });
            if (!destination) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_EXPORT_RESULT,
                payload: { theme_id: themeId, cancelled: true },
              });
              return;
            }

            await vscode.workspace.fs.writeFile(destination, await exportThemeArchive(this._globalStorageUri, themeId));
            void this._panel.webview.postMessage({
              type: MSG.THEME_EXPORT_RESULT,
              payload: { theme_id: themeId, display_name: theme.display_name },
            });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_EXPORT_RESULT,
              payload: { theme_id: themeId, error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.UPGRADE_THEMES) {
          try {
            const results = await upgradeInstalledThemes(this._globalStorageUri);
            let summary: string;
            if (results.length === 0) {
              summary = "No installed themes found.";
            } else {
              const upgraded = results.filter((r) => r.changed.length > 0);
              const upToDateCount = results.length - upgraded.length;
              if (upgraded.length === 0) {
                summary = `All ${results.length} installed theme(s) are already up to date.`;
              } else {
                const detail = upgraded
                  .map((r) => `${r.theme_id} (${r.changed.length} update${r.changed.length === 1 ? "" : "s"})`)
                  .join(", ");
                const upToDateSuffix = upToDateCount > 0 ? ` ${upToDateCount} already current.` : "";
                summary = `Upgraded ${upgraded.length} of ${results.length} theme(s): ${detail}.${upToDateSuffix}`;
              }
            }
            void vscode.window.showInformationMessage(summary);
            void this._panel.webview.postMessage({ type: MSG.UPGRADE_THEMES_DONE, payload: { summary } });
            const themes = await listThemes(this._globalStorageUri);
            void this._panel.webview.postMessage({ type: MSG.THEMES_LIST, payload: { themes } });
          } catch (err) {
            const summary = `Theme upgrade failed: ${errorMessage(err)}`;
            void vscode.window.showErrorMessage(`TycoonAgents: ${summary}`);
            void this._panel.webview.postMessage({ type: MSG.UPGRADE_THEMES_DONE, payload: { summary, error: errorMessage(err) } });
          }
        } else if (message.type === MSG.IMPORT_THEME) {
          try {
            if (this._themeGenerationActive) {
              throw new Error("Stop the active theme generation before importing a theme.");
            }
            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: false,
              filters: { "Theme archives": ["zip"] },
              openLabel: "Import theme",
              title: "Import a TycoonAgents theme",
            });
            if (!picked?.[0]) {
              void this._panel.webview.postMessage({ type: MSG.THEME_IMPORT_RESULT, payload: { cancelled: true } });
              return;
            }

            const archive = readThemeArchive(await vscode.workspace.fs.readFile(picked[0]));
            const existing = (await listThemes(this._globalStorageUri))
              .find((candidate) => candidate.theme_id === archive.themeId);
            let replace = false;
            if (existing) {
              const answer = await vscode.window.showWarningMessage(
                `A theme named "${existing.display_name}" already uses ID "${archive.themeId}". Replace it?`,
                {
                  modal: true,
                  detail: "The imported theme will replace the existing theme and its saved images.",
                },
                "Replace",
              );
              if (answer !== "Replace") {
                void this._panel.webview.postMessage({ type: MSG.THEME_IMPORT_RESULT, payload: { cancelled: true } });
                return;
              }
              replace = true;
            }

            const imported = await importThemeArchive(this._globalStorageUri, archive, replace);
            const themes = await listThemes(this._globalStorageUri);
            void this._panel.webview.postMessage({ type: MSG.THEMES_LIST, payload: { themes } });
            void this._panel.webview.postMessage({ type: MSG.THEME_IMPORT_RESULT, payload: imported });
            // Activate the imported theme so the webview loads/applies its
            // saved manifest.viewport (scales, anchors, nav polygon, flips,
            // hidden, replaced background) instead of leaving the previously
            // active theme on screen.
            await this._activateTheme(imported.theme_id);
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMPORT_RESULT,
              payload: { error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.DELETE_THEME) {
          const parsedDeleteTheme = MSG_SCHEMAS.DELETE_THEME.safeParse((message as any).payload);
          // Falls through to the existing "Theme not found" error path below
          // when the payload is malformed, same as the prior untyped default.
          const themeId = parsedDeleteTheme.success ? parsedDeleteTheme.data.theme_id : "";
          let deletedThemeId: string | undefined;
          let deleteError: string | undefined;
          try {
            if (this._themeGenerationActive) {
              throw new Error("Stop the active theme generation before deleting a theme.");
            }

            const savedThemes = await listThemes(this._globalStorageUri);
            const theme = savedThemes.find((candidate) => candidate.theme_id === themeId);
            if (!theme) throw new Error("Theme not found.");

            // VS Code webviews cannot reliably display window.confirm. Keep
            // the destructive gate in the extension host so the user always
            // gets a native modal before anything is removed from disk.
            const answer = await vscode.window.showWarningMessage(
              `Are you sure you want to delete "${theme.display_name}"?`,
              {
                modal: true,
                detail: "This permanently removes the theme and all of its saved images from this computer. This cannot be undone.",
              },
              "Delete",
            );
            if (answer !== "Delete") {
              void this._panel.webview.postMessage({
                type: MSG.THEMES_LIST,
                payload: { themes: savedThemes },
              });
              return;
            }

            await deleteTheme(this._globalStorageUri, themeId);
            await this._removeThemeBadgeUnlocks(themeId);
            await this._removeThemeRebirthState(themeId);
            await this._removeThemeBuildProgress(themeId);
            deletedThemeId = themeId;
          } catch (err) {
            deleteError = String(err);
          }
          const themes = await listThemes(this._globalStorageUri);
          void this._panel.webview.postMessage({
            type: MSG.THEMES_LIST,
            payload: {
              themes,
              deleted_theme_id: deletedThemeId,
              delete_error: deleteError,
            },
          });
        } else if (message.type === MSG.BADGE_UNLOCKED) {
          try {
            const parsedBadge = MSG_SCHEMAS.BADGE_UNLOCKED.safeParse((message as any).payload);
            if (parsedBadge.success) {
              await this.addUnlockedBadge(parsedBadge.data.theme_id, parsedBadge.data.badge_id);
            }
          } catch (err) {
            console.error("TycoonAgents: Could not persist badge unlock:", err);
          }
        } else if (message.type === MSG.SAVE_REBIRTH_STATE) {
          try {
            const parsedRebirth = MSG_SCHEMAS.SAVE_REBIRTH_STATE.safeParse((message as any).payload);
            if (parsedRebirth.success) {
              await this.saveRebirthState(parsedRebirth.data.theme_id, parsedRebirth.data.state as RebirthPersist);
            }
          } catch (err) {
            console.error("TycoonAgents: Could not persist rebirth state:", err);
          }
        } else if (message.type === MSG.REBIRTH_RESET_BADGES) {
          try {
            const parsedResetBadges = MSG_SCHEMAS.REBIRTH_RESET_BADGES.safeParse((message as any).payload);
            if (parsedResetBadges.success) {
              // Durably clear the now-reset badge unlocks (except rebirth_*
              // milestone badges, which persist) so the host doesn't re-send
              // stale unlocks on the next theme init (un-resetting the
              // rebirth). Mirrors doRebirth() clearing webview unlockedBadgeIds.
              await this._resetThemeBadgeUnlocksForRebirth(parsedResetBadges.data.theme_id);
            }
          } catch (err) {
            console.error("TycoonAgents: Could not reset rebirth badges:", err);
          }
        } else if (message.type === MSG.SAVE_BUILD_PROGRESS) {
          try {
            const parsedBuildProgress = MSG_SCHEMAS.SAVE_BUILD_PROGRESS.safeParse((message as any).payload);
            if (parsedBuildProgress.success) {
              await this.saveBuildProgress(parsedBuildProgress.data.themeId, parsedBuildProgress.data.builtCount);
            }
          } catch (err) {
            console.error("TycoonAgents: Could not persist build progress:", err);
          }
        } else if (message.type === MSG.SELECT_THEME) {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const targetThemeId = payload?.theme_id ?? "";
          const previousThemeId = this._currentThemeId;

          // Warn before switching AWAY from a theme that already has
          // unlocked badges in THIS project — each theme's progress is
          // tracked independently, so switching starts the target theme
          // fresh (its own saved progress, if any, comes back untouched).
          if (previousThemeId && previousThemeId !== targetThemeId) {
            const previousBadgeCount = (await this.getUnlockedBadges(previousThemeId)).length;
            if (shouldWarnOnThemeSwitch(previousThemeId, targetThemeId, previousBadgeCount)) {
              const themes = await listThemes(this._globalStorageUri);
              const targetName = themes.find((th) => th.theme_id === targetThemeId)?.display_name ?? targetThemeId;
              const previousName = themes.find((th) => th.theme_id === previousThemeId)?.display_name ?? previousThemeId;
              const answer = await vscode.window.showWarningMessage(
                `Switching to "${targetName}". Each theme tracks its own badges — it starts fresh here. Your "${previousName}" progress (${previousBadgeCount} badges) is saved and comes back when you switch to it again.`,
                { modal: true },
                "Switch theme",
              );
              if (answer !== "Switch theme") {
                void this._panel.webview.postMessage({
                  type: MSG.THEME_SELECT_ABORTED,
                  payload: { theme_id: previousThemeId },
                });
                return;
              }
            }
          }

          await this._activateTheme(targetThemeId);
        } else if (message.type === MSG.OPEN_THEME_IMAGES) {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId)) {
            void vscode.window.showErrorMessage("TycoonAgents: Invalid theme ID.");
          } else {
            let reviewImages;
            try {
              reviewImages = await ensureThemeReviewImages(this._globalStorageUri, themeId);
            } catch (err) {
              console.error("TycoonAgents: Could not prepare generated images:", err);
              void vscode.window.showErrorMessage("TycoonAgents could not prepare the generated images folder.");
              return;
            }

            if (reviewImages.imageUris.length === 0) {
              void vscode.window.showInformationMessage(
                "No review images are available yet. If generation is still running, try again after its first image completes.",
              );
              return;
            }

            try {
              // Reveal a real image so Explorer opens its containing folder.
              // On desktop Windows, normalize vscode-userdata explicitly to
              // avoid handing the custom URI scheme to the OS protocol picker.
              const imageUri = reviewImages.imageUris[0];
              const nativePath = nativeWindowsUserDataPath(imageUri.scheme, imageUri.path);
              const revealUri = nativePath ? vscode.Uri.file(nativePath) : imageUri;
              await vscode.commands.executeCommand("revealFileInOS", revealUri);
            } catch (err) {
              console.error("TycoonAgents: Could not reveal generated images:", err);
              const displayPath = reviewImages.directoryUri.scheme === "file"
                ? reviewImages.directoryUri.fsPath
                : reviewImages.directoryUri.toString(true);
              void vscode.window.showErrorMessage(
                `TycoonAgents could not open the folder. Images are saved at: ${displayPath}`,
              );
            }
          }
        } else if (message.type === MSG.REVEAL_THEME_IMAGE) {
          // Right-click "Open file location" on a review board — reveal its
          // saved image file in the OS explorer. Fully guarded: a missing
          // item/file surfaces an info message rather than throwing.
          const parsedReveal = MSG_SCHEMAS.REVEAL_THEME_IMAGE.safeParse((message as any).payload);
          if (!parsedReveal.success) return;
          const themeId = parsedReveal.data.theme_id;
          const itemId = parsedReveal.data.item_id;
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          try {
            const review = await getThemeImageReview(this._globalStorageUri, themeId);
            const entry = review.entries.find((candidate) => candidate.item.id === itemId);
            const filename = entry?.item.filename;
            if (!filename) {
              void vscode.window.showInformationMessage(
                "TycoonAgents: This board has no saved image file yet.",
              );
              return;
            }
            const imageUri = vscode.Uri.joinPath(
              themeImagesDirectoryUri(this._globalStorageUri, themeId),
              filename,
            );
            try {
              await vscode.workspace.fs.stat(imageUri);
            } catch {
              void vscode.window.showInformationMessage(
                "TycoonAgents: The image file for this board was not found on disk.",
              );
              return;
            }
            const nativePath = nativeWindowsUserDataPath(imageUri.scheme, imageUri.path);
            const revealUri = nativePath ? vscode.Uri.file(nativePath) : imageUri;
            await vscode.commands.executeCommand("revealFileInOS", revealUri);
          } catch (err) {
            console.error("TycoonAgents: Could not reveal theme image:", err);
            void vscode.window.showInformationMessage(
              "TycoonAgents could not open the file location for this board.",
            );
          }
        } else if (message.type === MSG.GET_THEME_IMAGE_REVIEW) {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          if (/^[a-z0-9_]+$/.test(themeId)) {
            await this._postThemeImageReview(themeId);
          }
        } else if (message.type === MSG.SET_THEME_IMAGE_REVIEW_STATUS) {
          const payload = (message as any).payload as {
            theme_id?: string;
            item_id?: string;
            status?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const itemId = payload?.item_id ?? "";
          const status = payload?.status;
          if (/^[a-z0-9_]+$/.test(themeId)
              && /^[a-z0-9_-]+$/.test(itemId)
              && (status === "accepted" || status === "rejected" || status === "pending")) {
            const gate = this._themeGenerationReviewGate;
            const isCurrentGate = gate?.themeId === themeId && gate.itemId === itemId;
            if (isCurrentGate && this._themeGenerationGateRetryActive) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_IMAGE_RETRY_STATE,
                payload: { item_id: itemId, busy: true, message: "Wait for the replacement to finish before keeping it." },
              });
              return;
            }
            const document = await updateThemeImageReviewStatus(this._globalStorageUri, themeId, itemId, status);
            if (document && status === "accepted" && isCurrentGate) gate.accept();
            await this._postThemeImageReview(themeId);
          }
        } else if (message.type === MSG.APPROVE_ALL_THEME_IMAGES) {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          try {
            if (this._themeGenerationActive) {
              throw new Error("Wait for theme generation to finish before approving all images.");
            }
            await approveAllThemeImages(this._globalStorageUri, themeId);
            await this._postThemeImageReview(themeId);
            const themes = await listThemes(this._globalStorageUri);
            void this._panel.webview.postMessage({ type: MSG.THEMES_LIST, payload: { themes } });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_APPROVE_ALL_RESULT,
              payload: { theme_id: themeId, error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.RENAME_THEME_CHARACTER) {
          const parsedRenameCharacter = MSG_SCHEMAS.RENAME_THEME_CHARACTER.safeParse((message as any).payload);
          if (!parsedRenameCharacter.success) return;
          const payload = parsedRenameCharacter.data;
          const themeId = payload.theme_id;
          const itemId = payload.item_id;
          if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
          const activeGate = this._themeGenerationReviewGate;
          const renamingActiveGate = this._themeGenerationActive
            && activeGate?.themeId === themeId
            && activeGate.itemId === itemId;
          if (this._themeGenerationActive && !renamingActiveGate) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_RENAME_STATE,
              payload: { item_id: itemId, error: "Only the character currently waiting for review can be renamed." },
            });
            return;
          }
          if (renamingActiveGate && this._themeGenerationGateRetryActive) return;
          if (renamingActiveGate) this._themeGenerationGateRetryActive = true;
          try {
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_RENAME_STATE,
              payload: { item_id: itemId, busy: true, message: "Saving character name..." },
            });
            const result = await renameThemeCharacter(
              this._globalStorageUri,
              themeId,
              itemId,
              payload?.name ?? "",
            );
            if (renamingActiveGate
                && this._themeGenerationReviewGate?.themeId === themeId
                && this._themeGenerationReviewGate.itemId === itemId) {
              this._themeGenerationReviewGate.replacement = result;
            }
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_RENAME_STATE,
              payload: { item_id: itemId, busy: false, message: "Character name saved." },
            });
            if (!renamingActiveGate) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(result.manifest, result.frames, true),
              });
            }
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_RENAME_STATE,
              payload: { item_id: itemId, busy: false, error: errorMessage(err) },
            });
          } finally {
            if (renamingActiveGate) this._themeGenerationGateRetryActive = false;
          }
        } else if (message.type === MSG.SET_THEME_ITEM_NAMES) {
          const parsedNames = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse((message as any).payload);
          if (!parsedNames.success) return;
          const payload = parsedNames.data;
          const themeId = payload.theme_id;
          const boardId = payload.board_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          try {
            const { manifest, frames, result } = await renameThemeItemsBatch(
              this._globalStorageUri,
              themeId,
              payload.changes as ThemeItemNameChange[],
            );
            if (result.applied.length) {
              // renameThemeItemsBatch also resyncs the affected boards' saved
              // review-item prompt/rows (see resyncRenamedReviewItems). Post the
              // refreshed review BEFORE the result/state message below (same
              // ordering as RENAME_THEME_CHARACTER) so the Names editor's
              // confirmation status lands on the freshly-rebuilt card instead of
              // one about to be replaced.
              await this._postThemeImageReview(themeId);
            }
            void this._panel.webview.postMessage({
              type: MSG.THEME_ITEM_NAMES_RESULT,
              payload: {
                ok: result.rejected.length === 0,
                theme_id: themeId,
                board_id: boardId,
                applied: result.applied,
                rejected: result.rejected,
              },
            });
            if (result.applied.length) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(manifest, frames, true),
              });
            }
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_ITEM_NAMES_RESULT,
              payload: { ok: false, theme_id: themeId, board_id: boardId, error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.SET_THEME_ITEM_DESCRIPTIONS) {
          const parsedDescriptions = MSG_SCHEMAS.SET_THEME_ITEM_DESCRIPTIONS.safeParse((message as any).payload);
          if (!parsedDescriptions.success) return;
          const payload = parsedDescriptions.data;
          const themeId = payload.theme_id;
          const boardId = payload.board_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          try {
            const result = await updateThemeItemDescriptionsBatch(
              this._globalStorageUri,
              themeId,
              payload.changes as ThemeItemDescriptionChange[],
            );
            if (result.applied.length) {
              // updateThemeItemDescriptionsBatch also resyncs the affected boards'
              // saved review-item prompt/rows (see resyncDescriptionReviewItems).
              // Post the refreshed review BEFORE the result message below (same
              // ordering as SET_THEME_ITEM_NAMES) so the Descriptions editor's
              // confirmation status lands on the freshly-rebuilt card instead of
              // one about to be replaced.
              await this._postThemeImageReview(themeId);
            }
            void this._panel.webview.postMessage({
              type: MSG.THEME_ITEM_DESCRIPTIONS_RESULT,
              payload: {
                ok: result.rejected.length === 0,
                theme_id: themeId,
                board_id: boardId,
                applied: result.applied,
                rejected: result.rejected,
              },
            });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_ITEM_DESCRIPTIONS_RESULT,
              payload: { ok: false, theme_id: themeId, board_id: boardId, error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.RESET_THEME_BADGE_NAMES) {
          const parsedReset = MSG_SCHEMAS.RESET_THEME_BADGE_NAMES.safeParse((message as any).payload);
          if (!parsedReset.success) return;
          const themeId = parsedReset.data.theme_id;
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          // VS Code webviews cannot reliably display window.confirm — keep the
          // gate host-side so the user always sees a native modal before badge
          // titles are rewritten. Post a fresh review afterward either way so
          // the webview's transient "Resetting…" button state clears.
          const answer = await vscode.window.showWarningMessage(
            "Reset all badge names to their defaults?",
            {
              modal: true,
              detail: "This restores every badge's default title. Any custom title you typed is moved into that badge's appearance description (so the badge art keeps it) — nothing you wrote is lost.",
            },
            "Reset names",
          );
          if (answer !== "Reset names") {
            await this._postThemeImageReview(themeId);
            return;
          }
          try {
            const { manifest, frames, changed } = await resetThemeBadgeNames(this._globalStorageUri, themeId);
            await this._postThemeImageReview(themeId);
            if (changed > 0) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(manifest, frames, true),
              });
            }
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_ITEM_NAMES_RESULT,
              payload: { ok: false, theme_id: themeId, board_id: "achievements", error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.NORMALIZE_THEME_CHARACTER) {
          const payload = (message as any).payload as {
            theme_id?: string;
            item_id?: string;
            image_provider?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const itemId = payload?.item_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
          const activeGate = this._themeGenerationReviewGate;
          const normalizingDuringActiveGeneration = this._themeGenerationActive
            && activeGate?.themeId === themeId
            && activeGate.itemId === itemId;
          if (this._themeGenerationActive && !normalizingDuringActiveGeneration) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_NORMALIZE_STATE,
              payload: {
                item_id: itemId,
                error: "Only the character currently waiting for review can be normalized.",
              },
            });
            return;
          }
          if (normalizingDuringActiveGeneration && this._themeGenerationGateRetryActive) return;
          if (normalizingDuringActiveGeneration) this._themeGenerationGateRetryActive = true;
          try {
            const imageSettings = await resolveThemeImageSettings(this._secrets, payload?.image_provider);
            if (!imageSettings.apiKey) throw new Error("The selected image provider has no saved API key.");
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_NORMALIZE_STATE,
              payload: { item_id: itemId, busy: true, message: "Regenerating at the standard character scale..." },
            });
            const result = await normalizeThemeCharacterAtlas(
              this._globalStorageUri,
              themeId,
              itemId,
              {
                provider: imageSettings.provider,
                apiKey: imageSettings.apiKey,
                signal: normalizingDuringActiveGeneration ? this._themeGenerationAbortController?.signal : undefined,
              },
              (message) => void this._panel.webview.postMessage({
                type: MSG.THEME_CHARACTER_NORMALIZE_STATE,
                payload: { item_id: itemId, busy: true, message },
              }),
            );
            if (normalizingDuringActiveGeneration
                && this._themeGenerationReviewGate?.themeId === themeId
                && this._themeGenerationReviewGate.itemId === itemId) {
              this._themeGenerationReviewGate.replacement = result;
              this._themeGenerationReviewGate.generatedReplacementReady = true;
            }
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_NORMALIZE_STATE,
              payload: { item_id: itemId, busy: false, message: "Regenerated and normalized character ready for review." },
            });
            if (!normalizingDuringActiveGeneration) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(result.manifest, result.frames, true),
              });
            }
          } catch (err) {
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_NORMALIZE_STATE,
              payload: { item_id: itemId, busy: false, error: errorMessage(err) },
            });
          } finally {
            if (normalizingDuringActiveGeneration) this._themeGenerationGateRetryActive = false;
          }
        } else if (message.type === MSG.RETRY_THEME_IMAGE) {
          const parsedRetryImage = MSG_SCHEMAS.RETRY_THEME_IMAGE.safeParse((message as any).payload);
          if (!parsedRetryImage.success) return;
          const payload = parsedRetryImage.data;
          const themeId = payload.theme_id;
          const itemId = payload.item_id;
          if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
          const activeGate = this._themeGenerationReviewGate;
          const retryingDuringActiveGeneration = this._themeGenerationActive
            && activeGate?.themeId === themeId
            && activeGate.itemId === itemId;
          if (this._themeGenerationActive && !retryingDuringActiveGeneration) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_RETRY_STATE,
              payload: {
                item_id: itemId,
                error: "Wait until this image reaches the review step before generating a replacement.",
              },
            });
            return;
          }
          if (retryingDuringActiveGeneration && this._themeGenerationGateRetryActive) return;
          if (retryingDuringActiveGeneration) this._themeGenerationGateRetryActive = true;
          try {
            const imageSettings = await resolveThemeImageSettings(this._secrets, payload?.image_provider);
            if (!imageSettings.apiKey) throw new Error("The selected image provider has no saved API key.");
            const retryMode: ThemeImageRetryMode = payload?.mode === "replace"
              ? "replace"
              : payload?.mode === "retry"
                ? "retry"
                : payload?.mode === "custom"
                  ? "custom"
                  : "augment";
            // Only user-authored notes for 'replace'/'augment' feed into the next
            // prompt's creative direction — 'retry' reuses the saved prompt verbatim
            // and ignores feedback, so it is exempt from this guard. 'custom' is the
            // power-user escape hatch: the notes ARE the whole prompt, so the
            // sanitizer (which guards against pasted full prompts) must NOT run —
            // a full pasted prompt is exactly what this mode expects.
            let retryFeedback = payload?.feedback ?? "";
            let retryNotesTrimmed = false;
            if (retryMode === "custom") {
              if (!retryFeedback.trim()) throw new Error("Custom mode needs a prompt.");
            } else if (retryMode !== "retry") {
              const sanitized = sanitizeRetryNotes(payload?.feedback ?? "");
              retryFeedback = sanitized.notes;
              retryNotesTrimmed = sanitized.trimmed;
            }
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_RETRY_STATE,
              payload: {
                item_id: itemId,
                busy: true,
                message: "Generating replacement...",
                ...(retryNotesTrimmed
                  ? {
                    warning: "Your notes looked like a full prompt — only the creative-direction section was used. "
                      + "Row items come from the theme's object list.",
                  }
                  : {}),
              },
            });
            if (payload?.character_name?.trim()) {
              const renamed = await renameThemeCharacter(
                this._globalStorageUri,
                themeId,
                itemId,
                payload.character_name,
              );
              if (retryingDuringActiveGeneration
                  && this._themeGenerationReviewGate?.themeId === themeId) {
                this._themeGenerationReviewGate.replacement = renamed;
              }
            }
            const result = await retryThemeImage(
              this._globalStorageUri,
              themeId,
              itemId,
              retryFeedback,
              retryMode,
              {
                provider: imageSettings.provider,
                apiKey: imageSettings.apiKey,
                signal: retryingDuringActiveGeneration ? this._themeGenerationAbortController?.signal : undefined,
              },
              (message) => void this._panel.webview.postMessage({
                type: MSG.THEME_IMAGE_RETRY_STATE,
                payload: { item_id: itemId, busy: true, message },
              }),
            );
            if (retryingDuringActiveGeneration
                && this._themeGenerationReviewGate?.themeId === themeId) {
              this._themeGenerationReviewGate.replacement = result;
              if (this._themeGenerationReviewGate.itemId === itemId) {
                this._themeGenerationReviewGate.generatedReplacementReady = true;
              }
            }
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_RETRY_STATE,
              payload: { item_id: itemId, busy: false, message: "Replacement ready for review." },
            });
            if (!retryingDuringActiveGeneration) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(result.manifest, result.frames, true),
              });
            }
          } catch (err) {
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_RETRY_STATE,
              payload: { item_id: itemId, busy: false, error: errorMessage(err) },
            });
          } finally {
            if (retryingDuringActiveGeneration) {
              this._themeGenerationGateRetryActive = false;
              if (!this._themePauseForReview
                  && this._themeGenerationReviewGate?.themeId === themeId) {
                this._themeGenerationReviewGate.accept();
              }
            }
          }
        } else if (message.type === MSG.RESLICE_THEME_IMAGE) {
          const payload = (message as any).payload as {
            theme_id?: string;
            item_id?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const itemId = payload?.item_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
          if (this._themeGenerationActive) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_RETRY_STATE,
              payload: {
                item_id: itemId,
                error: "Wait until theme generation finishes before re-slicing a board.",
              },
            });
            return;
          }
          try {
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_RETRY_STATE,
              payload: { item_id: itemId, busy: true, message: "Re-slicing from saved original..." },
            });
            const result = await resliceThemeImageFromRaw(this._globalStorageUri, themeId, itemId);
            if (!result.ok) {
              await this._postThemeImageReview(themeId);
              void this._panel.webview.postMessage({
                type: MSG.THEME_IMAGE_RETRY_STATE,
                payload: { item_id: itemId, busy: false, error: result.reason },
              });
            } else {
              await this._postThemeImageReview(themeId);
              void this._panel.webview.postMessage({
                type: MSG.THEME_IMAGE_RETRY_STATE,
                payload: { item_id: itemId, busy: false, message: "Re-sliced and ready for review." },
              });
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(result.manifest, result.frames, true),
              });
            }
          } catch (err) {
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: MSG.THEME_IMAGE_RETRY_STATE,
              payload: { item_id: itemId, busy: false, error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.PLAN_THEME) {
          const payload = (message as any).payload as { prompt?: string; image_provider?: string } | undefined;
          try {
            if (this._themeGenerationActive) throw new Error("Wait for the current theme generation to finish before planning another theme.");
            const prompt = payload?.prompt?.trim() ?? "";
            if (!prompt) throw new Error("Enter a theme name or description first.");
            const imageSettings = await resolveThemeImageSettings(this._secrets, payload?.image_provider);
            if (!imageSettings.apiKey) {
              const label = imageSettings.provider === "openai" ? "OpenAI" : "Google Gemini";
              throw new Error(`No ${label} API key found. Add and save one above the theme prompt.`);
            }
            const plan = await planTheme(prompt, {
              provider: imageSettings.provider,
              apiKey: imageSettings.apiKey,
            });
            void this._panel.webview.postMessage({ type: MSG.THEME_PLAN_READY, payload: { plan } });
          } catch (err) {
            void this._panel.webview.postMessage({ type: MSG.THEME_PLAN_ERROR, payload: { message: String(err) } });
          }
        } else if (message.type === MSG.SET_THEME_PAUSE_FOR_REVIEW) {
          const payload = (message as any).payload as { pause_for_review?: boolean } | undefined;
          if (typeof payload?.pause_for_review !== "boolean") return;
          this._themePauseForReview = payload.pause_for_review;
          if (!this._themePauseForReview
              && this._themeGenerationReviewGate
              && !this._themeGenerationGateRetryActive) {
            this._themeGenerationReviewGate.accept();
          }
        } else if (message.type === MSG.CANCEL_THEME_GENERATION) {
          const controller = this._themeGenerationAbortController;
          if (this._themeGenerationActive && controller && !controller.signal.aborted) {
            controller.abort();
            void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_PROGRESS,
              payload: { message: "Stopping generation..." },
            });
          }
        } else if (message.type === MSG.GENERATE_THEME) {
          const payload = (message as any).payload as {
            plan?: ThemePlan;
            resume_theme_id?: string;
            image_provider?: string;
            pause_for_review?: boolean;
          } | undefined;
          if (this._themeGenerationActive) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_ERROR,
              payload: { message: "A theme generation is already running." },
            });
            return;
          }
          let generatedThemeId = "";
          const abortController = new AbortController();
          this._themeGenerationAbortController = abortController;
          this._themeGenerationActive = true;
          try {
            const resumeThemeId = payload?.resume_theme_id ?? "";
            const plan = payload?.plan;
            if (!plan && !resumeThemeId) {
              throw new Error("Create and review the theme plan before generating images.");
            }
            if (resumeThemeId) generatedThemeId = resumeThemeId;
            this._themePauseForReview = payload?.pause_for_review !== false;
            const imageSettings = await resolveThemeImageSettings(
              this._secrets,
              payload?.image_provider,
            );
            if (!imageSettings.apiKey) {
              const label = imageSettings.provider === "openai" ? "OpenAI" : "Google Gemini";
              throw new Error(`No ${label} API key found. Add and save one above the theme prompt.`);
            }
            const onProgress = (msg: string) => void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_PROGRESS,
              payload: { message: msg },
            });
            const onReviewReady = (themeId: string) => {
              generatedThemeId = themeId;
              void this._panel.webview.postMessage({ type: MSG.THEME_REVIEW_READY, payload: { theme_id: themeId } });
            };
            const imageOptions = {
              provider: imageSettings.provider,
              apiKey: imageSettings.apiKey,
              signal: abortController.signal,
            };
            const waitForReview = async (themeId: string, itemId: string, reviewOptions?: ThemeImageReviewWaitOptions) => (
              this._themePauseForReview || reviewOptions?.requiresReplacement
                ? this._waitForThemeImageAcceptance(
                    themeId,
                    itemId,
                    abortController.signal,
                    reviewOptions,
                  )
                : undefined
            );
            const r = resumeThemeId
              ? await resumeThemeGeneration(
                  this._globalStorageUri,
                  resumeThemeId,
                  onProgress,
                  () => abortController.signal.aborted,
                  onReviewReady,
                  imageOptions,
                  waitForReview,
                )
              : await generateThemeService(
                  this._globalStorageUri,
                  plan!,
                  onProgress,
                  () => abortController.signal.aborted,
                  onReviewReady,
                  imageOptions,
                  waitForReview,
                );
            void this._panel.webview.postMessage({
              type: MSG.THEME_INITIALIZED,
              payload: await this._buildThemeInitPayload(r.manifest, r.frames, true),
            });
          } catch (err) {
            if (abortController.signal.aborted) {
              void this._panel.webview.postMessage({
                type: MSG.THEME_GENERATION_CANCELLED,
                payload: {
                  theme_id: generatedThemeId,
                  message: "Generation stopped. Completed images were retained; resume whenever you're ready.",
                },
              });
            } else {
              void this._panel.webview.postMessage({ type: MSG.THEME_GENERATION_ERROR, payload: { message: String(err) } });
            }
          } finally {
            this._themeGenerationActive = false;
            this._themeGenerationGateRetryActive = false;
            if (this._themeGenerationAbortController === abortController) {
              this._themeGenerationAbortController = undefined;
            }
            if (generatedThemeId) await this._postThemeImageReview(generatedThemeId);
          }
        } else if (message.type === MSG.REGENERATE_BOARD) {
          const payload = (message as any).payload as {
            theme_id?: string;
            board?: BoardKind;
            image_provider?: string;
            item_id?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const board = payload?.board;
          const itemId = payload?.item_id;
          try {
            if (this._themeGenerationActive) {
              throw new Error("Wait for the current theme generation to finish before regenerating a board.");
            }
            if (!themeId) throw new Error("No theme was specified for board regeneration.");
            if (!board) throw new Error("No board was specified for regeneration.");
            const imageSettings = await resolveThemeImageSettings(this._secrets, payload?.image_provider);
            if (!imageSettings.apiKey) {
              const label = imageSettings.provider === "openai" ? "OpenAI" : "Google Gemini";
              throw new Error(`No ${label} API key found. Add and save one above the theme prompt.`);
            }
            const onProgress = (msg: string) => void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_PROGRESS,
              payload: { message: msg },
            });
            const imageOptions = {
              provider: imageSettings.provider,
              apiKey: imageSettings.apiKey,
            };
            await regenerateThemeBoard(
              this._globalStorageUri,
              themeImagesDirectoryUri(this._globalStorageUri, themeId),
              themeId,
              board,
              imageOptions,
              onProgress,
              itemId,
            );
            void this._panel.webview.postMessage({
              type: MSG.BOARD_REGENERATED,
              payload: { theme_id: themeId, board, item_id: itemId, ok: true },
            });
          } catch (err) {
            console.error("TycoonAgents: Board regeneration failed:", err);
            void this._panel.webview.postMessage({
              type: MSG.BOARD_REGENERATED,
              payload: { theme_id: themeId, board, item_id: itemId, ok: false, error: String(err) },
            });
          } finally {
            if (themeId) await this._postThemeImageReview(themeId);
          }
        } else if (message.type === MSG.RUN_THEME_HEALTH_CHECK) {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          try {
            if (!themeId) throw new Error("No theme was specified for the health check.");
            const t = await loadTheme(this._globalStorageUri, themeId);
            if (!t) throw new Error("Theme not found.");
            const issues = validateThemeIntegrity(t.manifest, t.frames);
            void this._panel.webview.postMessage({
              type: MSG.THEME_HEALTH_CHECK_RESULT,
              payload: { theme_id: themeId, issues },
            });
          } catch (err) {
            console.error("TycoonAgents: Theme health check failed:", err);
            void this._panel.webview.postMessage({
              type: MSG.THEME_HEALTH_CHECK_RESULT,
              payload: {
                theme_id: themeId,
                issues: [{ severity: "error", kind: "check_failed", entity: "", key: "", message: String(err) }],
                error: String(err),
              },
            });
          }
        } else if (message.type === MSG.REQUEST_PLAN) {
          // Optional "Project Plan" feature — opt-in via projectPlanEnabled
          // in execution.json (default OFF). Disabled/no-workspace both
          // resolve to a null plan (and enabled:false) so the webview can
          // no-op cleanly and hide the section.
          this._postPlanState();
        } else if (message.type === MSG.APPROVE_PHASE) {
          const root = this._projectRoot();
          if (root === "" || !readProjectPlanEnabled(root)) {
            void this._panel.webview.postMessage({
              type: MSG.PLAN_STATE,
              enabled: false,
              plan: null,
              archivedPlans: [],
              planReadable: true,
              hasBackup: false,
            });
            return;
          }
          const parsedApprovePhase = MSG_SCHEMAS.APPROVE_PHASE.safeParse(message);
          if (!parsedApprovePhase.success) {
            console.error("TycoonAgents: APPROVE_PHASE payload rejected:", parsedApprovePhase.error.message);
            return;
          }
          const planPath = projectPlanFilePath(root);
          const readApprovePhase = readPlanSafe(planPath);
          if (readApprovePhase.status !== "ok") {
            if (readApprovePhase.status === "corrupt") {
              console.warn(
                "TycoonAgents: APPROVE_PHASE aborted, plan.json is corrupt (left untouched):",
                readApprovePhase.error
              );
            }
            this._postPlanState();
            return;
          }
          const updatedPlan = approvePhase(readApprovePhase.plan, parsedApprovePhase.data.phaseId);
          writePlan(planPath, updatedPlan);
          archivePlanIfComplete(root, updatedPlan);
          void this._panel.webview.postMessage({
            type: MSG.PLAN_STATE,
            enabled: true,
            plan: updatedPlan,
            archivedPlans: readArchivedPlans(root),
            planReadable: true,
            hasBackup: fs.existsSync(projectPlanBackupFilePath(root)),
          });
        } else if (message.type === MSG.OVERRIDE_TASK) {
          const root = this._projectRoot();
          if (root === "" || !readProjectPlanEnabled(root)) {
            void this._panel.webview.postMessage({
              type: MSG.PLAN_STATE,
              enabled: false,
              plan: null,
              archivedPlans: [],
              planReadable: true,
              hasBackup: false,
            });
            return;
          }
          const parsedOverrideTask = MSG_SCHEMAS.OVERRIDE_TASK.safeParse(message);
          if (!parsedOverrideTask.success) {
            console.error("TycoonAgents: OVERRIDE_TASK payload rejected:", parsedOverrideTask.error.message);
            return;
          }
          const planPath = projectPlanFilePath(root);
          const readOverrideTask = readPlanSafe(planPath);
          if (readOverrideTask.status !== "ok") {
            if (readOverrideTask.status === "corrupt") {
              console.warn(
                "TycoonAgents: OVERRIDE_TASK aborted, plan.json is corrupt (left untouched):",
                readOverrideTask.error
              );
            }
            this._postPlanState();
            return;
          }
          const updatedPlan = overrideTask(
            readOverrideTask.plan,
            parsedOverrideTask.data.taskId,
            parsedOverrideTask.data.action
          );
          writePlan(planPath, updatedPlan);
          archivePlanIfComplete(root, updatedPlan);
          void this._panel.webview.postMessage({
            type: MSG.PLAN_STATE,
            enabled: true,
            plan: updatedPlan,
            archivedPlans: readArchivedPlans(root),
            planReadable: true,
            hasBackup: fs.existsSync(projectPlanBackupFilePath(root)),
          });
        } else if (message.type === MSG.SET_PROJECT_PLAN_ENABLED) {
          // Settings-screen toggle: persist the opt-in flag, then re-post
          // PLAN_STATE with the fresh enabled value so the webview can show
          // or hide the Project Plan section immediately.
          const parsedSetPlanEnabled = MSG_SCHEMAS.SET_PROJECT_PLAN_ENABLED.safeParse(message);
          if (!parsedSetPlanEnabled.success) {
            console.error("TycoonAgents: SET_PROJECT_PLAN_ENABLED payload rejected:", parsedSetPlanEnabled.error.message);
            return;
          }
          const root = this._projectRoot();
          if (root === "") {
            void this._panel.webview.postMessage({
              type: MSG.PLAN_STATE,
              enabled: false,
              plan: null,
              archivedPlans: [],
              planReadable: true,
              hasBackup: false,
            });
            return;
          }
          writeProjectPlanEnabled(root, parsedSetPlanEnabled.data.enabled);
          if (parsedSetPlanEnabled.data.enabled === true) {
            // Enabling the checkbox implicitly (re)installs the skill so the
            // feature is never left inert — best-effort, silent (no popup),
            // since this is a side effect of flipping a toggle, not an
            // explicit user action on the install button.
            this._installProjectPlanSkill(root);
          }
          // _postPlanState recomputes enabled/plan/archivedPlans (plus
          // planReadable/hasBackup) via readPlanSafe, so this reuses the same
          // never-throws path instead of calling readPlan directly here.
          this._postPlanState();
        } else if (message.type === MSG.RESTORE_PLAN_BACKUP) {
          // User-triggered recovery from a corrupted plan.json: copy
          // plan.json.bak (last known-good read, see _postPlanState) back
          // over plan.json, then repost fresh state. No-ops silently if
          // there's no backup to restore from.
          const root = this._projectRoot();
          if (root === "") {
            this._postPlanState();
            return;
          }
          try {
            const backupPath = projectPlanBackupFilePath(root);
            if (fs.existsSync(backupPath)) {
              fs.copyFileSync(backupPath, projectPlanFilePath(root));
            }
          } catch (err) {
            console.error("TycoonAgents: RESTORE_PLAN_BACKUP failed:", err);
          }
          this._postPlanState();
        }
      },
      null,
      this._disposables
    );

    // Clean up on panel dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // --- Badge unlock persistence -------------------------------------
  // Per-theme unlocked badge ids, persisted to a JSON file at the root of
  // globalStorage (this panel only has access to globalStorageUri, not an
  // ExtensionContext/Memento, so file-based persistence is used).
  private _badgeUnlocksUri(): vscode.Uri {
    return vscode.Uri.joinPath(this._globalStorageUri, "badge-unlocks.json");
  }

  private async _readBadgeUnlocksStore(): Promise<Record<string, string[]>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._badgeUnlocksUri());
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async _writeBadgeUnlocksStore(store: Record<string, string[]>): Promise<void> {
    try {
      await vscode.workspace.fs.writeFile(
        this._badgeUnlocksUri(),
        Buffer.from(JSON.stringify(store, null, 2), "utf8"),
      );
    } catch (err) {
      console.error("TycoonAgents: Could not save badge unlocks:", err);
    }
  }

  /**
   * Stable per-workspace scope id (see progressScope.ts). All three durable
   * stores (badge-unlocks / rebirth-state / build-progress) are keyed by
   * `${scopeKey}|${themeId}` so progress no longer leaks across projects that
   * happen to load the same theme_id out of shared globalStorage.
   */
  private _projectScopeKey(): string {
    return projectScopeKey(this._projectRoot());
  }

  private async getUnlockedBadges(themeId: string | undefined): Promise<string[]> {
    if (!themeId) return [];
    const store = await this._readBadgeUnlocksStore();
    const { value, store: migratedStore, migrated } = readCompositeWithMigration(
      store,
      this._projectScopeKey(),
      themeId,
    );
    if (migrated) await this._writeBadgeUnlocksStore(migratedStore);
    return Array.isArray(value) ? value : [];
  }

  private async addUnlockedBadge(themeId: string, badgeId: string): Promise<void> {
    if (!themeId || !badgeId) return;
    const scopeKey = this._projectScopeKey();
    const store = await this._readBadgeUnlocksStore();
    const { value, store: migratedStore } = readCompositeWithMigration(store, scopeKey, themeId);
    const existing = Array.isArray(value) ? value : [];
    if (!existing.includes(badgeId)) {
      await this._writeBadgeUnlocksStore(writeComposite(migratedStore, scopeKey, themeId, [...existing, badgeId]));
    } else if (migratedStore !== store) {
      await this._writeBadgeUnlocksStore(migratedStore);
    }
  }

  /**
   * Fully removes a theme's badge unlocks (legacy key + every project's
   * composite key) — used when the theme itself is deleted from disk, which
   * removes it for every workspace, not just the current one.
   */
  private async _removeThemeBadgeUnlocks(themeId: string): Promise<void> {
    if (!themeId) return;
    const store = await this._readBadgeUnlocksStore();
    const next = removeThemeEverywhere(store, themeId);
    if (next !== store) await this._writeBadgeUnlocksStore(next);
  }

  /**
   * On Rebirth, wipe the CURRENT project's persisted badge unlocks for this
   * theme EXCEPT badge_ids starting with "rebirth_" — those mark permanent
   * prestige milestones (rebirth_1/2/3) and must survive every future
   * Rebirth. Mirrors the webview's doRebirth() local unlockedBadgeIds
   * filtering. A full wipe (including rebirth_* badges) still happens via
   * the scoped stats reset (_handleResetMetrics).
   */
  private async _resetThemeBadgeUnlocksForRebirth(themeId: string): Promise<void> {
    if (!themeId) return;
    const scopeKey = this._projectScopeKey();
    const store = await this._readBadgeUnlocksStore();
    const { value, store: migratedStore } = readCompositeWithMigration(store, scopeKey, themeId);
    const existing = Array.isArray(value) ? value : [];
    const kept = existing.filter((id) => typeof id === "string" && id.startsWith("rebirth_"));
    const next = kept.length > 0
      ? writeComposite(migratedStore, scopeKey, themeId, kept)
      : removeProjectThemeEntry(migratedStore, scopeKey, themeId);
    await this._writeBadgeUnlocksStore(next);
  }

  // --- Rebirth (prestige) persistence -------------------------------
  // Per-theme rebirth state, persisted host-side so the rebirth requirement
  // (requiredRebirthBadgeIds) survives webview disposal/reload. Previously
  // rebirth lived only in the webview's vscode.setState() blob, which is lost
  // when the webview is torn down — causing the requirement to re-roll on every
  // reload. Mirrors the badge-unlock persistence above (file-based, since this
  // panel only has globalStorageUri, not an ExtensionContext/Memento).
  private _rebirthStateUri(): vscode.Uri {
    return vscode.Uri.joinPath(this._globalStorageUri, "rebirth-state.json");
  }

  private async _readRebirthStore(): Promise<Record<string, RebirthPersist>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._rebirthStateUri());
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async _writeRebirthStore(store: Record<string, RebirthPersist>): Promise<void> {
    try {
      await vscode.workspace.fs.writeFile(
        this._rebirthStateUri(),
        Buffer.from(JSON.stringify(store, null, 2), "utf8"),
      );
    } catch (err) {
      console.error("TycoonAgents: Could not save rebirth state:", err);
    }
  }

  private async getRebirthState(themeId: string | undefined): Promise<RebirthPersist | null> {
    if (!themeId) return null;
    const store = await this._readRebirthStore();
    const { value, store: migratedStore, migrated } = readCompositeWithMigration(
      store,
      this._projectScopeKey(),
      themeId,
    );
    if (migrated) await this._writeRebirthStore(migratedStore);
    return value && typeof value === "object" ? value : null;
  }

  private async saveRebirthState(themeId: string, state: RebirthPersist): Promise<void> {
    if (!themeId || !state || typeof state !== "object") return;
    const store = await this._readRebirthStore();
    await this._writeRebirthStore(writeComposite(store, this._projectScopeKey(), themeId, state));
  }

  /**
   * Fully removes a theme's rebirth state (legacy key + every project's
   * composite key) — used when the theme itself is deleted from disk.
   */
  private async _removeThemeRebirthState(themeId: string): Promise<void> {
    if (!themeId) return;
    const store = await this._readRebirthStore();
    const next = removeThemeEverywhere(store, themeId);
    if (next !== store) await this._writeRebirthStore(next);
  }

  // --- Build progress persistence -------------------------------------
  // Per-theme buildable-object "built" count, persisted host-side so it
  // survives webview disposal/reload and VSIX updates. Previously this
  // lived only in the webview's in-memory buildBuiltCount, which reset to
  // 0 on every theme load. Mirrors the badge-unlock / rebirth-state
  // persistence above (file-based, since this panel only has
  // globalStorageUri, not an ExtensionContext/Memento).
  private _buildProgressUri(): vscode.Uri {
    return vscode.Uri.joinPath(this._globalStorageUri, "build-progress.json");
  }

  private async _readBuildProgressStore(): Promise<Record<string, number>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._buildProgressUri());
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async _writeBuildProgressStore(store: Record<string, number>): Promise<void> {
    try {
      await vscode.workspace.fs.writeFile(
        this._buildProgressUri(),
        Buffer.from(JSON.stringify(store, null, 2), "utf8"),
      );
    } catch (err) {
      console.error("TycoonAgents: Could not save build progress:", err);
    }
  }

  private async getBuildProgress(themeId: string | undefined): Promise<number> {
    if (!themeId) return 0;
    const store = await this._readBuildProgressStore();
    const { value, store: migratedStore, migrated } = readCompositeWithMigration(
      store,
      this._projectScopeKey(),
      themeId,
    );
    if (migrated) await this._writeBuildProgressStore(migratedStore);
    return typeof value === "number" && value >= 0 ? value : 0;
  }

  private async saveBuildProgress(themeId: string, builtCount: number): Promise<void> {
    if (!themeId) return;
    const clamped = Math.max(0, Math.trunc(builtCount));
    const store = await this._readBuildProgressStore();
    await this._writeBuildProgressStore(writeComposite(store, this._projectScopeKey(), themeId, clamped));
  }

  /**
   * Fully removes a theme's build progress (legacy key + every project's
   * composite key) — used when the theme itself is deleted from disk.
   */
  private async _removeThemeBuildProgress(themeId: string): Promise<void> {
    if (!themeId) return;
    const store = await this._readBuildProgressStore();
    const next = removeThemeEverywhere(store, themeId);
    if (next !== store) await this._writeBuildProgressStore(next);
  }

  /**
   * Builds a THEME_INITIALIZED payload, seeding persisted badge unlocks.
   * Also latches `_currentThemeId` — every THEME_INITIALIZED post funnels
   * through here, so this is the single place the host learns/updates which
   * theme is "currently loaded" (used by the theme-switch warning and the
   * scoped stats reset).
   */
  private async _buildThemeInitPayload(
    manifest: ThemeManifest,
    frames: Record<string, string[]>,
    isEditorMode: boolean,
  ): Promise<{
    manifest: ThemeManifest;
    frames: Record<string, string[]>;
    is_editor_mode: boolean;
    unlocked_badge_ids: string[];
    rebirth_state: RebirthPersist | null;
    savedBuildProgress: number;
  }> {
    this._currentThemeId = manifest?.theme_id;
    return {
      manifest,
      frames,
      is_editor_mode: isEditorMode,
      unlocked_badge_ids: await this.getUnlockedBadges(manifest?.theme_id),
      rebirth_state: await this.getRebirthState(manifest?.theme_id),
      savedBuildProgress: await this.getBuildProgress(manifest?.theme_id),
    };
  }

  /**
   * Loads `themeId` and posts THEME_INITIALIZED so the webview activates it
   * (applying its saved manifest.viewport — scales, anchors, nav polygon,
   * flips, hidden, replaced background). Posts THEME_GENERATION_ERROR and
   * returns false if the theme can't be loaded. Shared by SELECT_THEME and
   * the post-import activation in IMPORT_THEME.
   */
  private async _activateTheme(themeId: string): Promise<boolean> {
    const t = await loadTheme(this._globalStorageUri, themeId);
    if (t) {
      void this._panel.webview.postMessage({
        type: MSG.THEME_INITIALIZED,
        payload: await this._buildThemeInitPayload(t.manifest, t.frames, false),
      });
      return true;
    }
    void this._panel.webview.postMessage({ type: MSG.THEME_GENERATION_ERROR, payload: { message: "Theme not found." } });
    return false;
  }

  /** True iff a file/directory exists at `uri` (best-effort stat). */
  private async _uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async _postThemeImageReview(themeId: string): Promise<void> {
    try {
      const review = await getThemeImageReview(this._globalStorageUri, themeId);
      const rawDirectoryUri = themeRawImagesDirectoryUri(this._globalStorageUri, themeId);
      // Compute the prompt a retry would build RIGHT NOW (current template +
      // manifest + plan), so "View/Copy prompt" doesn't just show the stale
      // prompt saved at original generation (item.prompt). Mirrors the
      // fresh-base prompt retryThemeImage computes for 'retry'/'augment'.
      // Loaded once per post, not per item, since it requires disk reads;
      // the per-item buildReplacementPrompt call itself is pure string work.
      const loadedTheme = await loadTheme(this._globalStorageUri, themeId);
      const currentPlan = loadedTheme
        ? await loadCurrentThemePlan(this._globalStorageUri, themeId, loadedTheme.manifest.display_name)
        : undefined;
      const backgroundMode = boardBackgroundModeForProvider(await getConfiguredThemeImageProvider(this._secrets));
      const creativeDirection = currentPlan ? themePlanCreativeDirection(currentPlan) : undefined;
      const items = await Promise.all(review.entries.map(async ({ item, imageUri, generated }) => {
        let currentPrompt: string | undefined;
        if (loadedTheme && currentPlan && creativeDirection !== undefined) {
          try {
            // preferPlanObjects=true: DISPLAY-only. The "View/Copy prompt"
            // surface should reflect the CURRENT plan's 21-object v3 board even
            // for a legacy off-count manifest. Retry-generation callers leave
            // this false so their prompt stays consistent with manifest-based
            // slicing (see buildReplacementPrompt).
            currentPrompt = buildReplacementPrompt(item, creativeDirection, loadedTheme.manifest, currentPlan, backgroundMode, true);
          } catch {
            currentPrompt = undefined;
          }
        }
        return {
          ...item,
          currentPrompt,
          generated,
          // Only sliced atlas boards can be re-sliced; environment boards normalize a
          // single image, so they never carry a re-sliceable raw atlas.
          has_raw_atlas: item.kind === "environment"
            ? false
            : await this._uriExists(vscode.Uri.joinPath(rawDirectoryUri, item.filename)),
          image_src: imageUri
            ? this._panel.webview.asWebviewUri(
                imageUri.with({ query: `revision=${item.revision}&updated=${encodeURIComponent(item.updated_at)}` }),
              ).toString()
            : "",
        };
      }));
      void this._panel.webview.postMessage({
        type: MSG.THEME_IMAGE_REVIEW,
        payload: {
          theme_id: review.theme_id,
          display_name: review.display_name,
          generation_active: this._themeGenerationActive,
          pause_for_review: this._themePauseForReview,
          waiting_for_review_item_id: this._themeGenerationReviewGate?.themeId === themeId
            ? this._themeGenerationReviewGate.itemId
            : undefined,
          items,
        },
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.THEME_IMAGE_REVIEW,
        payload: { theme_id: themeId, items: [], error: String(err) },
      });
    }
  }

  private _waitForThemeImageAcceptance(
    themeId: string,
    itemId: string,
    signal: AbortSignal,
    options?: ThemeImageReviewWaitOptions,
  ): Promise<Awaited<ReturnType<typeof retryThemeImage>> | undefined> {
    this._themeGenerationReviewGate?.cancel();
    if (signal.aborted) return Promise.reject(new Error("Generation cancelled by user"));

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (this._themeGenerationReviewGate === gate) this._themeGenerationReviewGate = undefined;
        return true;
      };
      const accept = () => {
        if (gate.requiresReplacement && !gate.generatedReplacementReady) return;
        if (cleanup()) resolve(gate.replacement);
      };
      const cancel = () => {
        if (cleanup()) reject(new Error("Generation cancelled by user"));
      };
      const gate = {
        themeId,
        itemId,
        requiresReplacement: Boolean(options?.requiresReplacement),
        generatedReplacementReady: false,
        accept,
        cancel,
      } as {
        themeId: string;
        itemId: string;
        requiresReplacement: boolean;
        generatedReplacementReady: boolean;
        replacement?: Awaited<ReturnType<typeof retryThemeImage>>;
        accept(): void;
        cancel(): void;
      };
      this._themeGenerationReviewGate = gate;
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private _handleGetSkills(): void {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const projectRoot = this._projectRoot();
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
        mcpNote?: string;
        thirdParty?: boolean;
        source?: string;
      }>;
      const skills = catalog.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        mcpNote: entry.mcpNote,
        thirdParty: entry.thirdParty,
        source: entry.source,
        installed:
          projectRoot !== "" &&
          fs.existsSync(path.join(projectRoot, ".claude", "skills", entry.id)),
      }));
      void this._panel.webview.postMessage({ type: MSG.SKILLS, skills });
    } catch (e) {
      void this._panel.webview.postMessage({ type: MSG.SKILLS, skills: [], error: String(e) });
    }
  }

  private _handleInstallSkill(id: string): void {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const projectRoot = this._projectRoot();

    let catalog: Array<{ id: string; name: string; description: string }>;
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
      }>;
    } catch (e) {
      void this._panel.webview.postMessage({
        type: MSG.SKILL_INSTALLED,
        id,
        ok: false,
        error: String(e),
      });
      return;
    }

    const known = catalog.some((entry) => entry.id === id);
    if (!known) {
      void this._panel.webview.postMessage({
        type: MSG.SKILL_INSTALLED,
        id,
        ok: false,
        error: "Unknown skill",
      });
      return;
    }

    if (projectRoot === "") {
      void this._panel.webview.postMessage({
        type: MSG.SKILL_INSTALLED,
        id,
        ok: false,
        error: "No workspace folder open",
      });
      return;
    }

    const target = path.join(projectRoot, ".claude", "skills", id);
    if (fs.existsSync(target)) {
      void this._panel.webview.postMessage({ type: MSG.SKILL_INSTALLED, id, ok: true, alreadyExisted: true });
      return;
    }

    try {
      const src = path.join(this._extensionUri.fsPath, "media", "skills", id);
      fs.mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });
      fs.cpSync(src, target, { recursive: true });
      void this._panel.webview.postMessage({ type: MSG.SKILL_INSTALLED, id, ok: true, alreadyExisted: false });
    } catch (e) {
      void this._panel.webview.postMessage({
        type: MSG.SKILL_INSTALLED,
        id,
        ok: false,
        error: String(e),
      });
    }
  }

  /**
   * Remove an installed skill from the project's `.claude/skills/<id>`.
   * Mirrors `_handleInstallSkill`: validates the id against the bundled
   * catalog, then gates the destructive delete behind a native modal (VS Code
   * webviews cannot reliably show window.confirm). Refreshes the webview's
   * skills list on success. Responds with `{ type:"skillRemoved", id, ok }`.
   */
  private async _handleRemoveSkill(id: string): Promise<void> {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const root = this._projectRoot();

    let catalog: Array<{ id: string; name: string; description: string }>;
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
      }>;
    } catch (e) {
      void this._panel.webview.postMessage({ type: MSG.SKILL_REMOVED, id, ok: false, error: String(e) });
      return;
    }

    const entry = catalog.find((c) => c.id === id);
    if (entry === undefined) {
      void this._panel.webview.postMessage({ type: MSG.SKILL_REMOVED, id, ok: false, error: "Unknown skill" });
      return;
    }

    if (root === "") {
      void this._panel.webview.postMessage({ type: MSG.SKILL_REMOVED, id, ok: false, error: "No workspace folder open" });
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Remove the '${entry.name}' skill?`,
      { modal: true, detail: `This deletes .claude/skills/${id} from your project.` },
      "Remove"
    );
    if (answer !== "Remove") {
      void this._panel.webview.postMessage({ type: MSG.SKILL_REMOVED, id, ok: false, cancelled: true });
      return;
    }

    try {
      const target = path.join(root, ".claude", "skills", id);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      void this._panel.webview.postMessage({ type: MSG.SKILL_REMOVED, id, ok: true });
      this._handleGetSkills();
    } catch (e) {
      void this._panel.webview.postMessage({ type: MSG.SKILL_REMOVED, id, ok: false, error: String(e) });
    }
  }

  /** Load and parse the bundled MCP catalog. Throws on read/parse failure. */
  private _loadMcpCatalog(): Array<{
    id: string;
    name: string;
    description: string;
    requiresEnv?: boolean;
    note?: string;
    docsUrl?: string;
    thirdParty?: boolean;
    vendor?: string;
    package?: string;
    homepage?: string;
    network?: string;
    dataNote?: string;
    needsSetup?: boolean;
    config: unknown;
  }> {
    const catalogPath = path.join(
      this._extensionUri.fsPath,
      "media",
      "mcp",
      "catalog.json"
    );
    return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  }

  /** Tolerantly read+parse a project's .mcp.json, defaulting to {}. */
  private _readMcpConfig(mcpPath: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* missing/invalid => default {} */
    }
    return {};
  }

  /**
   * Resolve the `uefn-bridge` server entry from a parsed `.mcp.json` config
   * (top-level or nested under `mcpServers`) — the single source of truth
   * both `_computeEngineStatus` (live engine ladder) and `_handleCheckInstall`
   * (setup wizard's `uefnBridgeSetUp` flag) key off of, so the two paths can
   * never disagree about whether UEFN setup already ran.
   */
  private _uefnBridgeEntry(mcpConfig: Record<string, unknown>): Record<string, unknown> | undefined {
    const servers = (mcpConfig["mcpServers"] ?? mcpConfig) as Record<string, unknown>;
    return servers["uefn-bridge"] as Record<string, unknown> | undefined;
  }

  /** Post the MCP server catalog with per-entry installed status. */
  private _handleGetMcp(): void {
    let catalog;
    try {
      catalog = this._loadMcpCatalog();
    } catch (e) {
      void this._panel.webview.postMessage({
        type: MSG.MCP,
        servers: [],
        error: String(e),
      });
      return;
    }

    const root = this._projectRoot();
    const parsed =
      root === "" ? {} : this._readMcpConfig(path.join(root, ".mcp.json"));

    const servers = catalog.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      installed: hasMcpServer(parsed, e.id),
      requiresEnv: e.requiresEnv,
      note: e.note,
      docsUrl: e.docsUrl,
      thirdParty: e.thirdParty,
      vendor: e.vendor,
      package: e.package,
      homepage: e.homepage,
      network: e.network,
      dataNote: e.dataNote,
      needsSetup: e.needsSetup,
    }));
    void this._panel.webview.postMessage({ type: MSG.MCP, servers });
  }

  /** Build the modal-confirm body for a third-party MCP server install. */
  private _buildMcpConfirmMessage(entry: {
    name: string;
    vendor?: string;
    package?: string;
    network?: string;
    dataNote?: string;
    homepage?: string;
  }): string {
    const lines: string[] = [];
    lines.push(`Install ${entry.name || "this server"}?`);
    lines.push("");
    lines.push("This installs third-party software that runs on your machine.");
    if (entry.vendor) lines.push(`Vendor: ${entry.vendor}`);
    if (entry.package) lines.push(`Runs: ${entry.package}`);
    if (entry.network) {
      lines.push(`Sends data externally: ${entry.dataNote || "contacts an external service."}`);
    } else if (entry.dataNote) {
      lines.push(`Local only: ${entry.dataNote}`);
    }
    if (entry.homepage) lines.push(`Source: ${entry.homepage}`);
    lines.push("");
    lines.push("Check your organization's policy before continuing.");
    return lines.join("\n");
  }

  /** Merge a catalog MCP server's config into the project's .mcp.json. */
  private async _handleInstallMcp(id: string, _thirdParty = false): Promise<void> {
    try {
      let catalog;
      try {
        catalog = this._loadMcpCatalog();
      } catch (e) {
        void this._panel.webview.postMessage({
          type: MSG.MCP_INSTALLED,
          id,
          ok: false,
          error: String(e),
        });
        return;
      }

      const entry = catalog.find((e) => e.id === id);
      if (entry === undefined) {
        void this._panel.webview.postMessage({
          type: MSG.MCP_INSTALLED,
          id,
          ok: false,
          error: "Unknown server",
        });
        return;
      }

      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({
          type: MSG.MCP_INSTALLED,
          id,
          ok: false,
          error: "No workspace folder open",
        });
        return;
      }

      // Host-side confirmation gate for genuinely third-party servers. The
      // authoritative source is the catalog entry's thirdParty flag (not the
      // webview payload). window.confirm is unreliable in VS Code webviews, so
      // we prompt here with a native modal - same pattern as pack install.
      if (entry.thirdParty) {
        const answer = await vscode.window.showWarningMessage(
          this._buildMcpConfirmMessage(entry),
          { modal: true },
          "Install"
        );
        if (answer !== "Install") {
          void this._panel.webview.postMessage({
            type: MSG.MCP_INSTALLED,
            id,
            ok: false,
            cancelled: true,
          });
          return;
        }
      }

      const mcpPath = path.join(root, ".mcp.json");
      const existing = this._readMcpConfig(mcpPath);

      if (hasMcpServer(existing, id)) {
        void this._panel.webview.postMessage({
          type: MSG.MCP_INSTALLED,
          id,
          ok: true,
          alreadyExisted: true,
        });
        return;
      }

      const merged = mergeMcpServer(existing, id, this._resolveConfigTokens(entry.config));
      fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
      void this._panel.webview.postMessage({
        type: MSG.MCP_INSTALLED,
        id,
        ok: true,
        alreadyExisted: false,
      });
    } catch (e) {
      void this._panel.webview.postMessage({
        type: MSG.MCP_INSTALLED,
        id,
        ok: false,
        error: String(e),
      });
    }
  }

  /**
   * Remove an MCP server from the project's `.mcp.json`. Mirrors
   * `_handleInstallMcp`: validates the id against the bundled catalog, gates
   * the change behind a native modal, then reads `.mcp.json` tolerantly,
   * deletes `mcpServers[id]` via the pure `removeMcpServer` helper, and writes
   * the file back (retaining the `{ mcpServers: {} }` shape when empty).
   * Responds with `{ type:"mcpRemoved", id, ok }`.
   */
  private async _handleRemoveMcp(id: string): Promise<void> {
    try {
      let catalog;
      try {
        catalog = this._loadMcpCatalog();
      } catch (e) {
        void this._panel.webview.postMessage({ type: MSG.MCP_REMOVED, id, ok: false, error: String(e) });
        return;
      }

      const entry = catalog.find((e) => e.id === id);
      if (entry === undefined) {
        void this._panel.webview.postMessage({ type: MSG.MCP_REMOVED, id, ok: false, error: "Unknown server" });
        return;
      }

      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({ type: MSG.MCP_REMOVED, id, ok: false, error: "No workspace folder open" });
        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `Remove the '${entry.name}' MCP server?`,
        { modal: true, detail: `This removes "${id}" from .mcp.json in your project.` },
        "Remove"
      );
      if (answer !== "Remove") {
        void this._panel.webview.postMessage({ type: MSG.MCP_REMOVED, id, ok: false, cancelled: true });
        return;
      }

      const mcpPath = path.join(root, ".mcp.json");
      const existing = this._readMcpConfig(mcpPath);
      const updated = removeMcpServer(existing, id);
      fs.writeFileSync(mcpPath, JSON.stringify(updated, null, 2));
      void this._panel.webview.postMessage({ type: MSG.MCP_REMOVED, id, ok: true });
      this._handleGetMcp();
    } catch (e) {
      void this._panel.webview.postMessage({ type: MSG.MCP_REMOVED, id, ok: false, error: String(e) });
    }
  }

  /**
   * Build the third-party disclosure list for a pack from the MCP catalog.
   * Only genuinely third-party MCP servers (thirdParty: true) are disclosed -
   * bundled/local servers (e.g. uefn-bridge) must NOT trigger the confirm gate.
   * Shared by _handleGetPacks (display) and _handleInstallPack (host confirm).
   */
  private _buildPackDisclosures(pack: any, mcpCatalog: any[]): any[] {
    const disclosures: any[] = [];
    if (pack && pack.mcp) {
      const m = mcpCatalog.find((x) => x.id === pack.mcp);
      if (m && m.thirdParty) {
        disclosures.push({ label: m.name, vendor: m.vendor, package: m.package, homepage: m.homepage, network: m.network, dataNote: m.dataNote });
      }
    }
    return disclosures;
  }

  private _handleGetPacks(): void {
    try {
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      let mcpCatalog: any[] = [];
      try { mcpCatalog = this._loadMcpCatalog(); } catch { mcpCatalog = []; }
      // Load the skills catalog once to resolve display names for bundled skills.
      let skillNames: Record<string, string> = {};
      try {
        const skillsCatalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
        const skillsCatalog: any[] = JSON.parse(fs.readFileSync(skillsCatalogPath, "utf8"));
        for (const s of skillsCatalog) {
          if (s && typeof s.id === "string") { skillNames[s.id] = typeof s.name === "string" ? s.name : s.id; }
        }
      } catch { skillNames = {}; }
      const root = this._projectRoot();
      const mcpConfig = root === "" ? {} : this._readMcpConfig(path.join(root, ".mcp.json"));
      const skillInstalled = (id: string): boolean =>
        root !== "" && fs.existsSync(path.join(root, ".claude", "skills", id));
      const result = packs.map((pack: any) => {
        const disclosures = this._buildPackDisclosures(pack, mcpCatalog);
        const packSkills: string[] = Array.isArray(pack.skills) ? pack.skills : [];
        const skills = packSkills.map((id: string) => ({
          id,
          name: skillNames[id] ?? id,
          installed: skillInstalled(id),
        }));
        return {
          id: pack.id,
          name: pack.name,
          description: pack.description,
          has: { skill: packSkills.length > 0, mcp: !!pack.mcp, agent: true },
          installed: {
            skill: packSkills.length > 0 && packSkills.every((id: string) => skillInstalled(id)),
            mcp: pack.mcp ? hasMcpServer(mcpConfig, pack.mcp) : false,
            agent: (() => {
              const packAgents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
              return root !== "" && packAgents.length > 0 && packAgents.every((a: any) => fs.existsSync(path.join(root, ".claude", "agents", `${a.id}.md`)));
            })(),
          },
          skills,
          thirdParty: disclosures.length > 0,
          disclosures,
        };
      });
      this._panel.webview.postMessage({ type: MSG.PACKS, packs: result });
    } catch (e) {
      this._panel.webview.postMessage({ type: MSG.PACKS, packs: [], error: String(e) });
    }
  }

  /** Build the modal-confirm body listing a pack's third-party sources. */
  private _buildPackConfirmMessage(packName: string, disclosures: any[], stagesPythonBridge = false): string {
    const networked = disclosures.filter((d) => d && d.network);
    const lines: string[] = [];
    lines.push(`Install ${packName || "this pack"}?`);
    lines.push("");
    lines.push("This installs third-party software that runs on your machine:");
    if (stagesPythonBridge) {
      lines.push("It also stages the Python bridge into Content/Python - no manual Python setup needed.");
    }
    for (const d of disclosures) {
      const who = [d.label, d.vendor].filter(Boolean).join(" - ");
      lines.push(`- ${who}${d.package ? ` - runs ${d.package}` : ""}`);
      if (d.network) {
        lines.push(`    Sends data externally: ${d.dataNote || "contacts an external service."}`);
      } else if (d.dataNote) {
        lines.push(`    Local only: ${d.dataNote}`);
      }
      if (d.homepage) lines.push(`    Source: ${d.homepage}`);
    }
    lines.push("");
    lines.push(networked.length
      ? "One or more components send data to external services. Check your organization's policy before continuing."
      : "Check your organization's policy before continuing.");
    return lines.join("\n");
  }

  /**
   * Install a pack; when it provides the UEFN bridge, also auto-stages the
   * Python side (see `_stageUefnBridgeAllTargets`) so the user never has to
   * paste Python manually. Returns the staging result so `_handleSetupUefnProject`
   * can reuse it for its own `uefnSetupDone` summary without staging twice;
   * `undefined` when this pack didn't stage anything.
   */
  private async _handleInstallPack(
    id: string,
    thirdParty = false,
    passedDisclosures?: any[]
  ): Promise<{
    bridgeStatus: "staged" | "exists";
    engineFound: boolean;
    locations: Array<{
      label: string; dir: string;
      staged: number; updated: number; unchanged: number; error?: string;
    }>;
  } | undefined> {
    try {
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      const pack = packs.find((p: any) => p.id === id);
      if (!pack) {
        this._panel.webview.postMessage({ type: MSG.PACK_INSTALLED, id, ok: false, error: "Unknown pack" });
        return;
      }
      const root = this._projectRoot();
      if (root === "") {
        this._panel.webview.postMessage({ type: MSG.PACK_INSTALLED, id, ok: false, error: "No workspace folder open" });
        return;
      }

      // Host-side confirmation gate for third-party packs. window.confirm is
      // unreliable inside VS Code webviews (can silently return false), so we
      // confirm here with a native modal - same pattern as the Hook Doctor's
      // foreign-hook removal. Recompute disclosures authoritatively rather than
      // trusting the webview payload (defense-in-depth); fall back to passed
      // values if the catalog can't be loaded.
      let mcpCatalog: any[] = [];
      try { mcpCatalog = this._loadMcpCatalog(); } catch { mcpCatalog = []; }
      const disclosures = mcpCatalog.length > 0
        ? this._buildPackDisclosures(pack, mcpCatalog)
        : (Array.isArray(passedDisclosures) ? passedDisclosures : []);
      const stagesPythonBridge = pack.mcp === "uefn-bridge" || pack.id === "uefn";

      // UEFN-pack-only conflict gate: this pack ships its own Verse
      // specialists (uefn-auditor, verse-expert) that route the same task
      // keywords as the generic reviewer/coding-specialist agents. Leaving
      // both installed means routing is ambiguous — or worse, Verse work
      // silently lands on an agent with no Verse knowledge. Compute the
      // conflict BEFORE the confirm modal so the user is warned up front;
      // strictly gated on pack.id === "uefn" so no other pack is affected.
      const uefnConflictIds: string[] = pack.id === "uefn"
        ? conflictingUefnAgents(
            UEFN_CONFLICT_AGENT_IDS.filter((cid) => fs.existsSync(path.join(root, ".claude", "agents", `${cid}.md`)))
          )
        : [];

      const needsConfirm = ((thirdParty || disclosures.length > 0) && disclosures.length > 0) || uefnConflictIds.length > 0;
      if (needsConfirm) {
        const conflictWarning = uefnConflictIds.length > 0
          ? "\n\n" +
            `WARNING: This project already has ${uefnConflictIds.map((cid) => `${cid}.md`).join(" and ")}. ` +
            `Installing the UEFN pack will REMOVE ${uefnConflictIds.length > 1 ? "these agents" : "this agent"} ` +
            `(backed up to ${uefnConflictIds.map((cid) => `${cid}.md.bak`).join(" and ")} first, nothing is lost) ` +
            "and replace them with uefn-auditor (the Verse auditor) and verse-expert (the Verse coder), " +
            "so task routing goes to the correct Verse-specialist agents instead of the generic ones."
          : "";
        const answer = await vscode.window.showWarningMessage(
          this._buildPackConfirmMessage(pack.name, disclosures, stagesPythonBridge) + conflictWarning,
          { modal: true },
          "Install"
        );
        if (answer !== "Install") {
          // User dismissed the modal - clear the webview's "installing..." state.
          this._panel.webview.postMessage({ type: MSG.PACK_INSTALLED, id, ok: false, cancelled: true });
          return;
        }
      }

      // User confirmed (or no confirm was needed) - now safe to remove the
      // conflicting generic agent files. Back up each to <id>.md.bak (never
      // clobbering a prior backup) before deleting, so nothing is ever
      // permanently lost. Per-file try/catch: one failure must not block the
      // rest of the removals or abort the pack install itself. Re-seed the
      // keyword table immediately after so the removed agents' phantom
      // entries don't linger even for one panel reload.
      if (uefnConflictIds.length > 0) {
        for (const conflictId of uefnConflictIds) {
          try {
            const conflictPath = path.join(root, ".claude", "agents", `${conflictId}.md`);
            if (fs.existsSync(conflictPath)) {
              const backupPath = `${conflictPath}.bak`;
              if (!fs.existsSync(backupPath)) {
                fs.copyFileSync(conflictPath, backupPath);
              }
              fs.unlinkSync(conflictPath);
            }
          } catch {
            /* best-effort: one conflicting agent's removal failure must not
               block the rest of the removals or the pack install itself */
          }
        }
        this._ensureAgentKeywordsSeeded();
      }

      const results: Record<string, any> = {};
      const packSkills: string[] = Array.isArray(pack.skills) ? pack.skills : [];
      if (packSkills.length > 0) {
        const skillResults: Array<{ id: string; status: "installed" | "exists" }> = [];
        for (const skillId of packSkills) {
          const target = path.join(root, ".claude", "skills", skillId);
          if (fs.existsSync(target)) {
            skillResults.push({ id: skillId, status: "exists" });
          } else {
            const src = path.join(this._extensionUri.fsPath, "media", "skills", skillId);
            fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
            fs.cpSync(src, target, { recursive: true });
            skillResults.push({ id: skillId, status: "installed" });
          }
        }
        results.skills = skillResults;
      }
      if (pack.mcp) {
        // Reuse the catalog loaded above; reload if the earlier (tolerant) load failed.
        const catalog = mcpCatalog.length > 0 ? mcpCatalog : this._loadMcpCatalog();
        const entry = catalog.find((x: any) => x.id === pack.mcp);
        if (entry === undefined) {
          throw new Error(`MCP catalog entry not found for id: ${pack.mcp}`);
        }
        const mcpPath = path.join(root, ".mcp.json");
        const existing = this._readMcpConfig(mcpPath);
        if (hasMcpServer(existing, pack.mcp)) {
          results.mcp = "exists";
        } else {
          const merged = mergeMcpServer(existing, pack.mcp, this._resolveConfigTokens(entry.config));
          fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
          results.mcp = "installed";
        }
      }
      const agents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
      // Install (or refresh) every agent file this pack ships. Unlike the
      // old "skip if it already exists" behavior, install now always ends
      // with OUR current generated content on disk for a pack-owned agent:
      //   - no file yet                              -> write ours, "created"
      //   - file carries our tycoon_pack marker       -> overwrite in place,
      //                                                  "refreshed" (or
      //                                                  "unchanged" if the
      //                                                  bytes already match)
      //   - file exists but has no marker (legacy/foreign, e.g. an old
      //     hand-authored or pre-marker agent file) -> back it up to
      //     `<id>.md.bak` (never overwriting a prior backup) before writing
      //     ours, "replaced-legacy". The original content is preserved on
      //     disk, never deleted.
      // Each file is handled in its own try/catch so one failure doesn't
      // abort the rest of the loop.
      const agentResults: Array<{ id: string; status: "created" | "refreshed" | "unchanged" | "replaced-legacy" | "error"; error?: string }> = [];
      let cfg = this._readKeywordsConfig(root);
      for (const a of agents) {
        try {
          const agentsDir = path.join(root, ".claude", "agents");
          const agentPath = path.join(agentsDir, `${a.id}.md`);
          const generated = buildAgentMarkdown(a, pack.id);
          if (!fs.existsSync(agentPath)) {
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(agentPath, generated);
            agentResults.push({ id: a.id, status: "created" });
          } else {
            const existingContent = fs.readFileSync(agentPath, "utf8");
            if (agentMarkdownHasTycoonMarker(existingContent)) {
              if (existingContent === generated) {
                agentResults.push({ id: a.id, status: "unchanged" });
              } else {
                fs.writeFileSync(agentPath, generated);
                agentResults.push({ id: a.id, status: "refreshed" });
              }
            } else {
              const backupPath = `${agentPath}.bak`;
              if (!fs.existsSync(backupPath)) {
                fs.writeFileSync(backupPath, existingContent);
              }
              fs.writeFileSync(agentPath, generated);
              agentResults.push({ id: a.id, status: "replaced-legacy" });
            }
          }
        } catch (e) {
          agentResults.push({ id: a.id, status: "error", error: String(e) });
        }
        cfg = setKeywordPattern(cfg, a.id, a.keywords);
        this._runtime.ingest({ type: "WorkerRegistered", at: Date.now(), workerId: a.id, name: a.name, model: a.model, description: a.role });
      }
      results.agents = agentResults;
      const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
      fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
      fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));

      // Auto-stage the Python bridge when (and only when) this pack provides
      // the UEFN bridge - never for godot/unity/other packs. Staging is an
      // idempotent file copy (see _stageBridgeTo), so re-running install is
      // safe. This is the single staging call site for pack installs;
      // _handleSetupUefnProject reuses this method's return value instead of
      // staging again.
      let bridgeStaging:
        | { bridgeStatus: "staged" | "exists"; engineFound: boolean; locations: Array<{ label: string; dir: string; staged: number; updated: number; unchanged: number; error?: string }> }
        | undefined;
      if (pack.mcp === "uefn-bridge" || pack.id === "uefn") {
        try {
          bridgeStaging = this._stageUefnBridgeAllTargets(root);
          void vscode.window.showInformationMessage(
            "UEFN bridge installed into Content/Python. Reopen your UEFN project in the editor to activate it."
          );
        } catch {
          /* best-effort: pack install itself still succeeded even if staging failed */
        }
      }

      this._panel.webview.postMessage({ type: MSG.PACK_INSTALLED, id, ok: true, results });
      return bridgeStaging;
    } catch (e) {
      this._panel.webview.postMessage({ type: MSG.PACK_INSTALLED, id, ok: false, error: String(e) });
      return undefined;
    }
  }

  /**
   * Remove an installed pack: its skills, MCP server, and agent files.
   * Mirrors `_handleInstallPack` but in reverse. Skills and the MCP server are
   * SHARED components — before deleting one, we check whether ANOTHER pack in
   * the catalog also lists that same id and still has any of its components
   * installed; if so we SKIP the delete so we don't break that pack. Agents are
   * pack-specific and are always removed (file + agent-keywords.json entry).
   * Gated behind a native modal. Responds with
   * `{ type:"packRemoved", id, ok, results:{skills, mcp, agents} }`.
   */
  private async _handleRemovePack(id: string): Promise<void> {
    try {
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      const pack = packs.find((p: any) => p.id === id);
      if (!pack) {
        this._panel.webview.postMessage({ type: MSG.PACK_REMOVED, id, ok: false, error: "Unknown pack" });
        return;
      }
      const root = this._projectRoot();
      if (root === "") {
        this._panel.webview.postMessage({ type: MSG.PACK_REMOVED, id, ok: false, error: "No workspace folder open" });
        return;
      }

      const packSkills: string[] = Array.isArray(pack.skills) ? pack.skills : [];
      const packAgents: any[] = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
      const packMcp: string | undefined = pack.mcp || undefined;

      // Build the confirmation summary.
      const parts: string[] = [];
      parts.push(`${packSkills.length} ${packSkills.length === 1 ? "skill" : "skills"}`);
      if (packMcp) parts.push("1 MCP server");
      parts.push(`${packAgents.length} ${packAgents.length === 1 ? "agent" : "agents"}`);
      const answer = await vscode.window.showWarningMessage(
        `Remove '${pack.name}'?`,
        { modal: true, detail: `This removes ${parts.join(", ")} from your project.` },
        "Remove"
      );
      if (answer !== "Remove") {
        this._panel.webview.postMessage({ type: MSG.PACK_REMOVED, id, ok: false, cancelled: true });
        return;
      }

      // Shared-component guard: is `componentId` (a skill or MCP id) still
      // claimed by ANOTHER pack that is at least partially installed? Such a
      // pack "still installed" if any of its skills/mcp/agents exist on disk.
      const skillOnDisk = (sid: string): boolean =>
        fs.existsSync(path.join(root, ".claude", "skills", sid));
      const agentOnDisk = (aid: string): boolean =>
        fs.existsSync(path.join(root, ".claude", "agents", `${aid}.md`));
      const mcpConfigNow = (): Record<string, unknown> => this._readMcpConfig(path.join(root, ".mcp.json"));
      const packStillInstalled = (p: any): boolean => {
        const sk: string[] = Array.isArray(p.skills) ? p.skills : [];
        const ag: any[] = Array.isArray(p.agents) ? p.agents : (p.agent ? [p.agent] : []);
        if (sk.some((s) => skillOnDisk(s))) return true;
        if (p.mcp && hasMcpServer(mcpConfigNow(), p.mcp)) return true;
        if (ag.some((a) => agentOnDisk(a.id))) return true;
        return false;
      };
      const sharedByOtherPack = (predicate: (p: any) => boolean): boolean =>
        packs.some((p: any) => p.id !== id && predicate(p) && packStillInstalled(p));

      const results: Record<string, any> = {};

      // Skills.
      const skillResults: Array<{ id: string; status: "removed" | "kept-shared" | "absent" }> = [];
      for (const skillId of packSkills) {
        const target = path.join(root, ".claude", "skills", skillId);
        if (!fs.existsSync(target)) {
          skillResults.push({ id: skillId, status: "absent" });
          continue;
        }
        const shared = sharedByOtherPack((p) => Array.isArray(p.skills) && p.skills.includes(skillId));
        if (shared) {
          skillResults.push({ id: skillId, status: "kept-shared" });
        } else {
          fs.rmSync(target, { recursive: true, force: true });
          skillResults.push({ id: skillId, status: "removed" });
        }
      }
      results.skills = skillResults;

      // MCP server.
      if (packMcp) {
        const mcpPath = path.join(root, ".mcp.json");
        const existing = this._readMcpConfig(mcpPath);
        if (!hasMcpServer(existing, packMcp)) {
          results.mcp = "absent";
        } else if (sharedByOtherPack((p) => p.mcp === packMcp)) {
          results.mcp = "kept-shared";
        } else {
          const updated = removeMcpServer(existing, packMcp);
          fs.writeFileSync(mcpPath, JSON.stringify(updated, null, 2));
          results.mcp = "removed";
        }
      }

      // Agents (pack-specific — always removed).
      const agentResults: Array<{ id: string; status: "removed" | "absent" }> = [];
      let cfg = this._readKeywordsConfig(root);
      for (const a of packAgents) {
        const agentPath = path.join(root, ".claude", "agents", `${a.id}.md`);
        if (fs.existsSync(agentPath)) {
          fs.unlinkSync(agentPath);
          agentResults.push({ id: a.id, status: "removed" });
        } else {
          agentResults.push({ id: a.id, status: "absent" });
        }
        if (cfg && typeof cfg.agents === "object" && cfg.agents !== null && a.id in cfg.agents) {
          const nextAgents = { ...cfg.agents };
          delete nextAgents[a.id];
          cfg = { ...cfg, agents: nextAgents };
        }
      }
      results.agents = agentResults;
      const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
      try {
        fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
        fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
      } catch {
        /* best-effort: keywords file is non-critical for removal */
      }

      this._panel.webview.postMessage({ type: MSG.PACK_REMOVED, id, ok: true, results });
      // Refresh installed state the same way install paths do.
      this._handleGetPacks();
      this._handleGetSkills();
      this._handleGetMcp();
    } catch (e) {
      this._panel.webview.postMessage({ type: MSG.PACK_REMOVED, id, ok: false, error: String(e) });
    }
  }

  private async _handleSetupUefnProject(): Promise<void> {
    try {
      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({ type: MSG.UEFN_SETUP_DONE, ok: false, error: "No workspace folder open" });
        return;
      }
      // Install the uefn pack (reuses _handleInstallPack logic via _installPackById).
      // We call _handleInstallPack directly; it posts packInstalled - but we also need
      // to handle the bridge staging and post uefnSetupDone. So we factor pack install
      // inline here to capture the result synchronously.
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      const pack = packs.find((p: any) => p.id === "uefn");
      if (!pack) {
        void this._panel.webview.postMessage({ type: MSG.UEFN_SETUP_DONE, ok: false, error: "UEFN pack not found in catalog" });
        return;
      }
      // Reuse the existing pack-install logic by calling _handleInstallPack("uefn").
      // That method posts its own packInstalled message AND stages the Python bridge
      // into every location UEFN may load Python from (see _stageUefnBridgeAllTargets;
      // CRUCIAL: UEFN loads the bridge from the Fortnite ENGINE install's
      // FortniteGame/Content/Python, which wins on sys.path over the project's own
      // Content/Python, so both are staged). We await it here (unlike a fire-and-forget
      // call) specifically to reuse its staging result below, so we don't stage a
      // second time. UEFN is not third-party, so no confirm modal is shown.
      const staged = await this._handleInstallPack("uefn");

      const bridgeStatus: "staged" | "exists" = staged?.bridgeStatus ?? "exists";
      const engineFound = staged?.engineFound ?? false;
      const locations = staged?.locations ?? [];

      void this._panel.webview.postMessage({
        type: MSG.UEFN_SETUP_DONE,
        ok: true,
        results: { pack: "uefn", bridge: bridgeStatus, engineFound, locations },
      });
    } catch (e) {
      void this._panel.webview.postMessage({ type: MSG.UEFN_SETUP_DONE, ok: false, error: String(e) });
    }
  }

  /**
   * Copy every bridge file from `bridgeDir` into `pyDest`, except the Node MCP
   * server (`uefn-server.mjs`), which does not belong in UEFN's Content/Python.
   * A file is written only when absent or when its content differs, so tool
   * updates land without needlessly rewriting unchanged files. Creates pyDest.
   */
  private _stageBridgeTo(
    bridgeDir: string,
    pyDest: string
  ): { staged: number; updated: number; unchanged: number } {
    fs.mkdirSync(pyDest, { recursive: true });
    let staged = 0;
    let updated = 0;
    let unchanged = 0;
    for (const name of fs.readdirSync(bridgeDir)) {
      if (name === "uefn-server.mjs") continue;
      if (name === "__pycache__") continue;
      if (name.endsWith(".pyc") || name.endsWith(".pyo")) continue;
      const srcPath = path.join(bridgeDir, name);
      if (!fs.statSync(srcPath).isFile()) continue;
      const destPath = path.join(pyDest, name);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        staged++;
      } else if (!fs.readFileSync(srcPath).equals(fs.readFileSync(destPath))) {
        fs.copyFileSync(srcPath, destPath);
        updated++;
      } else {
        unchanged++;
      }
    }
    return { staged, updated, unchanged };
  }

  /**
   * Discover the Fortnite engine `FortniteGame/Content/Python` director(ies)
   * that UEFN actually loads bridge modules from. Resolves the install via the
   * Epic Games Launcher manifests (authoritative), falling back to common
   * default install locations across drives. Returns only paths whose parent
   * `FortniteGame/Content` exists (the Python subdir is created on stage).
   */
  private _findFortnitePythonDirs(): string[] {
    const found = new Set<string>();
    const addFromInstall = (installLoc: string): void => {
      if (!installLoc) return;
      const contentBase = path.join(installLoc, "FortniteGame", "Content");
      try {
        if (fs.existsSync(contentBase)) {
          found.add(path.join(contentBase, "Python"));
        }
      } catch {
        /* ignore inaccessible path */
      }
    };

    // 1) Epic Games Launcher manifests list every installed app's location.
    try {
      const programData = process.env.ProgramData || "C:\\ProgramData";
      const manifestsDir = path.join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
      if (fs.existsSync(manifestsDir)) {
        for (const f of fs.readdirSync(manifestsDir)) {
          if (!f.toLowerCase().endsWith(".item")) continue;
          try {
            const m = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), "utf8"));
            const label = String(m.DisplayName || m.AppName || m.MandatoryAppFolderName || "");
            const loc = String(m.InstallLocation || "");
            if (loc && /fortnite/i.test(`${label} ${loc}`)) {
              addFromInstall(loc);
            }
          } catch {
            /* skip malformed manifest */
          }
        }
      }
    } catch {
      /* manifests unavailable — fall through to defaults */
    }

    // 2) Fallback: common default install locations.
    if (found.size === 0) {
      for (const drive of ["C:", "D:", "E:", "F:"]) {
        addFromInstall(path.join(`${drive}\\`, "Program Files", "Epic Games", "Fortnite"));
      }
    }

    return [...found];
  }

  /**
   * Stage the Python bridge + Power Tools suite into every location UEFN may
   * load Python from (the project's own Content/Python, plus every
   * discovered Fortnite engine Python dir — see _findFortnitePythonDirs for
   * why both are needed). Single source of truth for staging so it runs
   * exactly once per user action: `_handleInstallPack` calls this when the
   * installed pack provides the UEFN bridge (auto-stage on install), and
   * `_handleSetupUefnProject` reuses `_handleInstallPack`'s result instead of
   * staging a second time.
   */
  private _stageUefnBridgeAllTargets(root: string): {
    bridgeStatus: "staged" | "exists";
    engineFound: boolean;
    locations: Array<{
      label: string; dir: string;
      staged: number; updated: number; unchanged: number; error?: string;
    }>;
  } {
    const bridgeDir = path.join(this._extensionUri.fsPath, "media", "uefn-bridge");
    const targets: Array<{ label: string; dir: string }> = [
      { label: "project", dir: path.join(root, "Content", "Python") },
    ];
    for (const engineDir of this._findFortnitePythonDirs()) {
      targets.push({ label: "engine", dir: engineDir });
    }

    const locations: Array<{
      label: string; dir: string;
      staged: number; updated: number; unchanged: number; error?: string;
    }> = [];
    let totalWritten = 0;
    let engineFound = false;
    for (const t of targets) {
      if (t.label === "engine") engineFound = true;
      try {
        const r = this._stageBridgeTo(bridgeDir, t.dir);
        locations.push({ label: t.label, dir: t.dir, ...r });
        totalWritten += r.staged + r.updated;
      } catch (e) {
        locations.push({ label: t.label, dir: t.dir, staged: 0, updated: 0, unchanged: 0, error: String(e) });
      }
    }
    const bridgeStatus: "staged" | "exists" = totalWritten > 0 ? "staged" : "exists";
    return { bridgeStatus, engineFound, locations };
  }

  /**
   * Whether the Python bridge file is staged into the project's own
   * Content/Python — the "project" target `_stageUefnBridgeAllTargets`
   * always writes to. Used to harden `uefnBridgeSetUp` (see
   * `_handleCheckInstall`) so a bare `.mcp.json` uefn-bridge entry, with no
   * Python actually staged, is no longer reported as "set up".
   */
  private _uefnBridgePythonStaged(root: string): boolean {
    try {
      return fs.existsSync(path.join(root, "Content", "Python", "uefn_bridge.py"));
    } catch {
      return false;
    }
  }

  private async _handleDesignDocAction(mode: string): Promise<void> {
    const root = this._projectRoot();
    if (!root) {
      vscode.window.showWarningMessage("No project root — open a folder first.");
      return;
    }
    const src = path.join(this._extensionUri.fsPath, "media", "skills", "design-doc");
    const dest = path.join(root, ".claude", "skills", "design-doc");
    try {
      fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    } catch (e) {
      vscode.window.showErrorMessage("Failed to install design-doc skill: " + String(e));
      void this._panel.webview.postMessage({ type: MSG.DESIGN_DOC_DONE, mode, ok: false, error: String(e) });
      return;
    }
    const prompt = mode === "review"
      ? "Use the design-doc skill (.claude/skills/design-doc) to review the design document(s) in ./design-docs/. Convert each .docx to text with the skill's converter (design-doc-cli.mjs docx2md), read them, summarize what the project is meant to be, flag mismatches with what's currently built, and recommend which TycoonAgents packs/agents to install."
      : "Use the design-doc skill (.claude/skills/design-doc) to analyze this project and generate a design document — a Game Design Document (GDD) if this is a game, otherwise a Product Requirements Document (PRD). Save it as a .docx in ./design-docs/ using the skill's bundled converter (design-doc-cli.mjs md2docx). Base it on what's actually built so I can review and correct it.";
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(
      "Design-doc skill installed and the " + (mode === "review" ? "review" : "generate") + " prompt was copied to your clipboard — paste it into Claude Code to run it."
    );
    void this._panel.webview.postMessage({ type: MSG.DESIGN_DOC_DONE, mode, ok: true });
  }

  /**
   * Copy the shipped `media/skills/project-plan/` tree into
   * `<root>/.claude/skills/project-plan`, creating any file that's absent
   * and refreshing any file whose content differs from the shipped source
   * (read-and-compare, never a blind overwrite) — this directory is 100%
   * ours (unlike the tiered agent `.md` files), so no ownership/tier check
   * is needed. Each file's copy is independently try/catched (logged via
   * `console.error`) so one bad file never aborts the rest, and this method
   * never throws outward — callers may run it as a best-effort side effect
   * (e.g. from the checkbox handler) as well as from the explicit
   * "Reinstall / Repair skill" button.
   *
   * Returns `true` iff the destination directory exists and is non-empty
   * after the operation (used only for the button's success/failure UI
   * feedback).
   */
  private _installProjectPlanSkill(root: string): boolean {
    const src = path.join(this._extensionUri.fsPath, "media", "skills", "project-plan");
    const dest = path.join(root, ".claude", "skills", "project-plan");

    const copyRecursive = (srcDir: string, destDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true });
      } catch (e) {
        console.error("TycoonAgents: _installProjectPlanSkill failed to read", srcDir, e);
        return;
      }
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          copyRecursive(srcPath, destPath);
          continue;
        }
        try {
          const srcContent = fs.readFileSync(srcPath, "utf8");
          let destContent: string | undefined;
          try {
            destContent = fs.readFileSync(destPath, "utf8");
          } catch {
            destContent = undefined;
          }
          if (destContent === srcContent) continue; // already current
          fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(destPath, srcContent);
        } catch (e) {
          console.error("TycoonAgents: _installProjectPlanSkill failed to copy", srcPath, e);
        }
      }
    };

    try {
      copyRecursive(src, dest);
    } catch (e) {
      console.error("TycoonAgents: _installProjectPlanSkill failed:", e);
    }

    try {
      return fs.existsSync(dest) && fs.readdirSync(dest).length > 0;
    } catch {
      return false;
    }
  }

  private async _handleInstallProjectPlanSkill(): Promise<void> {
    const root = this._projectRoot();
    if (!root) {
      vscode.window.showWarningMessage("No project root — open a folder first.");
      return;
    }
    let ok: boolean;
    try {
      ok = this._installProjectPlanSkill(root);
    } catch (e) {
      vscode.window.showErrorMessage("Failed to install project-plan skill: " + String(e));
      void this._panel.webview.postMessage({ type: MSG.PROJECT_PLAN_DONE, ok: false, error: String(e) });
      return;
    }
    if (!ok) {
      vscode.window.showErrorMessage("Failed to install project-plan skill: destination is empty after copy.");
      void this._panel.webview.postMessage({ type: MSG.PROJECT_PLAN_DONE, ok: false, error: "destination empty after copy" });
      return;
    }
    const prompt = "Use the project-plan skill (.claude/skills/project-plan) to decompose the design doc / goals for this project into an approvable plan of phases and tasks with human gate checkpoints.";
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(
      "Project-plan skill installed and its starter prompt was copied to your clipboard."
    );
    void this._panel.webview.postMessage({ type: MSG.PROJECT_PLAN_DONE, ok: true });
  }

  /**
   * Deep-clone `config` and replace every occurrence of the literal token
   * `${EXTENSION_DIR}` in any string value (recursively through objects/arrays)
   * with the extension's real install path (`this._extensionUri.fsPath`).
   * Called at install time so catalog entries with bundled servers resolve correctly.
   */
  private _resolveConfigTokens(config: unknown): unknown {
    const token = "${EXTENSION_DIR}";
    const replacement = this._extensionUri.fsPath;
    const resolve = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value.split(token).join(replacement);
      }
      if (Array.isArray(value)) {
        return value.map(resolve);
      }
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = resolve(v);
        }
        return out;
      }
      return value;
    };
    return resolve(config);
  }

  /**
   * Apply persisted time adjustments from `.claude/tycoon/time-adjustments.json`.
   * Returns a shallow-cloned state with `activeMs` offsets applied to matching agents.
   * Tolerant: missing file, invalid JSON, or non-object => no adjustment.
   */
  private _applyTimeAdjustments(state: any): any {
    try {
      const root = this._projectRoot();
      if (root === "") {
        return this._withModeStats(state);
      }
      const adjPath = path.join(root, ".claude", "tycoon", "time-adjustments.json");
      let adjustments: Record<string, number> = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(adjPath, "utf8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          adjustments = parsed as Record<string, number>;
        }
      } catch {
        /* missing or invalid => no adjustments */
      }
      if (Object.keys(adjustments).length === 0) {
        return this._withModeStats(state);
      }

      const applyToMetrics = (metrics: any): any => {
        if (!Array.isArray(metrics)) {
          return metrics;
        }
        return metrics.map((metric: any) => {
          if (metric === null || typeof metric !== "object") {
            return metric;
          }
          const id: unknown = metric.id;
          if (typeof id !== "string" || !(id in adjustments)) {
            return metric;
          }
          const deltaMs = adjustments[id];
          if (typeof deltaMs !== "number") {
            return metric;
          }
          return { ...metric, activeMs: Math.max(0, (metric.activeMs ?? 0) + deltaMs) };
        });
      };

      const cloned: any = { ...state };
      if (Array.isArray(cloned.agentMetrics)) {
        cloned.agentMetrics = applyToMetrics(cloned.agentMetrics);
      }
      if (Array.isArray(cloned._agentMetricsInternal)) {
        cloned._agentMetricsInternal = applyToMetrics(cloned._agentMetricsInternal);
      }
      return this._withModeStats(cloned);
    } catch {
      return state;
    }
  }

  /**
   * Attach `modeStats` (Team Lead Mode Phase 4: measurement) computed from
   * the final agentMetrics list — per-delegation-mode completed tasks,
   * tokens, active time, and lead coordination overhead. Computed fresh on
   * every state push (cheap: a single pass over agentMetrics) so it reflects
   * any time-adjustment corrections already applied above. Never throws:
   * falls back to returning `state` unmodified (webview guards on absence).
   */
  private _withModeStats(state: any): any {
    try {
      if (state === null || typeof state !== "object" || !Array.isArray(state.agentMetrics)) {
        return state;
      }
      return { ...state, modeStats: computeDelegationModeStats(state.agentMetrics) };
    } catch {
      return state;
    }
  }

  /**
   * Resolve the project root, matching extension.ts. Workspace-first: the
   * open workspace folder is the only per-window source of truth for "which
   * project this panel belongs to." CLAUDE_PROJECT_DIR is a process-wide env
   * var (shared by every window), so it is honored only as a match against
   * an open folder, or as a last-resort fallback when no folder is open —
   * never allowed to override a differing open workspace. See
   * resolveProjectRoot() in progressScope.ts for the precedence logic.
   */
  private _projectRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    const paths = folders ? folders.map((f) => f.uri.fsPath) : [];
    return resolveProjectRoot(paths, process.env["CLAUDE_PROJECT_DIR"]);
  }

  /** True if any hook command in the given settings file references our hook. */
  private _settingsReferencesHook(settingsPath: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      return false; // missing file or parse error => not found
    }
    const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
    if (hooks === undefined || hooks === null || typeof hooks !== "object") {
      return false;
    }
    for (const eventKey of Object.keys(hooks)) {
      const entries = (hooks as Record<string, unknown>)[eventKey];
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        const inner = (entry as { hooks?: unknown } | null)?.hooks;
        if (!Array.isArray(inner)) {
          continue;
        }
        for (const h of inner) {
          const cmd = (h as { command?: unknown } | null)?.command;
          if (typeof cmd === "string" && cmd.includes("tycoon-claude-hook.cjs")) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * True if TycoonAgents' hook is wired into either settings file for
   * `root`. Shared by `_handleCheckInstall` (Hook Health / setup screen) and
   * `_ensureDelegationDoctrineCurrent` (the auto-heal consent proxy — never
   * touch CLAUDE.md on a project that hasn't opted into TycoonAgents).
   */
  private _hooksInstalledForRoot(root: string): boolean {
    return (
      this._settingsReferencesHook(path.join(root, ".claude", "settings.local.json")) ||
      this._settingsReferencesHook(path.join(root, ".claude", "settings.json"))
    );
  }

  private _handleCheckInstall(): void {
    const root = this._projectRoot();
    const installed = root !== "" && this._hooksInstalledForRoot(root);
    const uefn = root !== "" ? detectUefnProject(root) : { detected: false, signals: [], uefnInstalled: false };
    // Non-UEFN engine chips (godot/unity/unreal/roblox/blender) for the setup
    // wizard's Optionals step to pre-check matching skill chips against. No
    // .mcp.json probing here (unlike _computeEngineStatus's live ladder) —
    // this only needs to know whether a project of that kind is present.
    const engineChips = root !== "" ? computeEngineChips(root, null) : [];
    // Whether UEFN setup already ran — requires BOTH the `.mcp.json`
    // uefn-bridge entry (_uefnBridgeEntry, also used by _computeEngineStatus's
    // live ladder) AND the Python bridge actually staged into the project's
    // Content/Python (_uefnBridgePythonStaged). An mcp entry alone is not
    // enough to call it "set up" — lets the setup wizard stop re-prompting
    // "set up UEFN" only once it's genuinely done (see media/main.js's
    // installState handler / the uefnDetected trigger, and
    // renderSetupOptionals's UEFN section).
    const mcpConfig = root !== "" ? this._readMcpConfig(path.join(root, ".mcp.json")) : {};
    const uefnBridgeSetUp =
      root !== "" && Boolean(this._uefnBridgeEntry(mcpConfig)) && this._uefnBridgePythonStaged(root);
    // Detect any non-tycoon managed CLAUDE.md block — legacy config carried
    // over from a prior setup, or a currently-installed other tool's own
    // block (see legacyDoctrine.ts detectForeignManagedBlocks). Every entry
    // here is opt-in removable via the Setup Wizard Step-2 / Settings
    // "Remove" row (MSG.REMOVE_MANAGED_BLOCK), never auto-removed.
    let foreignManagedBlocks: { namespace: string; lines: number }[] = [];
    if (root !== "") {
      try {
        const claudeMdContent = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
        foreignManagedBlocks = detectForeignManagedBlocks(claudeMdContent);
      } catch {
        // No CLAUDE.md yet -> nothing to detect.
      }
    }
    void this._panel.webview.postMessage({
      type: MSG.INSTALL_STATE,
      installed,
      uefnDetected: uefn.detected,
      uefnSignals: uefn.signals,
      uefnBridgeSetUp,
      engineChips,
      foreignManagedBlocks,
    });
  }

  /**
   * Idempotently append `entries` (under `header`) to the ignore file at
   * `filePath`, creating it if absent. Shared by `.gitignore` and
   * `.p4ignore` writes — both use the same line-based ignore syntax, so one
   * append routine covers both. Returns true iff at least one entry was
   * actually written (false when everything was already present, or on
   * write failure) so callers can gate one-time follow-up notices on a real
   * write rather than a no-op re-run.
   */
  private _appendIgnoreEntries(filePath: string, header: string, entries: string[]): boolean {
    let existing = "";
    try {
      existing = fs.readFileSync(filePath, "utf8");
    } catch {
      existing = "";
    }

    const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = entries.filter((e) => !existingLines.has(e));
    if (missing.length === 0) {
      return false; // already fully present — idempotent no-op
    }

    const blockLines = existingLines.has(header) ? missing : [header, ...missing];
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const spacer = existing.length > 0 ? "\n" : "";
    const block = prefix + spacer + blockLines.join("\n") + "\n";

    try {
      fs.appendFileSync(filePath, block);
      return true;
    } catch {
      /* best-effort convenience action; no user-facing error surface wired for this optional step */
      return false;
    }
  }

  /**
   * Setup wizard Step 2 (Optionals): idempotently append TycoonAgents runtime
   * state/log artifact paths to the workspace ignore file(s) (creating them
   * if absent). Opt-in only — fired when the user checks "Add tycoon logs to
   * ignore file" and clicks Done (see media/main.js renderSetupOptionals).
   * The entry list is fixed here, not payload-driven, so the wizard can
   * never be used to ignore arbitrary paths. Never touches CLAUDE.md,
   * .mcp.json, source, or committed skills — only the generated
   * `.claude/tycoon/` state dir and the rolling session journal.
   *
   * UEFN projects use Perforce, which does NOT honor `.gitignore` — it reads
   * `.p4ignore` instead. So on a UEFN project (per {@link detectUefnProject})
   * this writes BOTH `.gitignore` (some UEFN projects also use git) AND
   * `.p4ignore` with the identical entries; on a non-UEFN project it writes
   * only `.gitignore`. After a real `.p4ignore` write we surface a one-time
   * note that Perforce only honors it once `P4IGNORE` is configured.
   */
  private _handleAddGitignoreEntries(): void {
    const root = this._projectRoot();
    if (root === "") return;

    const header = "# TycoonAgents runtime artifacts";
    const entries = [".claude/tycoon/", ".claude/session-journal.json"];

    this._appendIgnoreEntries(path.join(root, ".gitignore"), header, entries);

    const uefn = detectUefnProject(root);
    if (uefn.detected) {
      const wroteP4ignore = this._appendIgnoreEntries(path.join(root, ".p4ignore"), header, entries);
      if (wroteP4ignore) {
        vscode.window.showInformationMessage(
          "TycoonAgents added .p4ignore entries for this UEFN/Perforce project. " +
            "Perforce only honors .p4ignore once P4IGNORE is configured — run `p4 set P4IGNORE=.p4ignore` " +
            "(or set the P4IGNORE environment variable) to enable it."
        );
      }
    }
  }

  /**
   * Strip the given `namespace`'s managed block out of the workspace's
   * CLAUDE.md (see legacyDoctrine.ts) — the user's explicit confirm-click
   * on a "Remove legacy config block" row (Setup Wizard Step-2 or Settings),
   * never an auto-delete on install. `namespace` must be one the user was
   * actually shown (surfaced via detectForeignManagedBlocks), so this only
   * ever removes a block the user saw and chose to remove. Idempotent: a
   * no-op when that namespace's markers aren't present. Touches ONLY the
   * delimited region (plus the seam blank-line collapse) — never deletes
   * agent `.md` files. Re-runs `_handleCheckInstall` afterward so the
   * webview re-renders with the block gone from `foreignManagedBlocks`
   * (Setup Wizard Step-2), AND `_handleGetSettings` (same pattern
   * MSG.REPAIR_HOOK uses) so the Settings screen's "Hook health" row
   * refreshes too and the Remove row disappears without a manual reload.
   */
  private _handleRemoveManagedBlock(namespace: string): void {
    const root = this._projectRoot();
    if (root === "") return;

    const claudeMdPath = path.join(root, "CLAUDE.md");
    try {
      const existing = fs.readFileSync(claudeMdPath, "utf8");
      const { content, removed } = stripManagedBlock(existing, namespace);
      if (removed) {
        fs.writeFileSync(claudeMdPath, content);
      }
    } catch {
      // No CLAUDE.md -> nothing to strip; fall through to re-check so the
      // webview still settles.
    }

    this._handleCheckInstall();
    this._handleGetSettings();
  }

  /** Coerce an untrusted `delegation_mode` message field to a valid mode, defaulting to "flat". */
  private _coerceDelegationMode(raw: string | undefined): DelegationMode {
    return raw === "team_leads" ? "team_leads" : "flat";
  }

  /**
   * Auto-heal: refresh the managed CLAUDE.md delegation-doctrine (+ code
   * rules) section once per panel open. The doctrine is normally only
   * written by explicit Install Hooks / Repair Hook / Set-delegation-mode /
   * Set-review actions — it's never refreshed on a VSIX upgrade. A project
   * that installed TycoonAgents before the doctrine existed (added 0.0.173)
   * has a CLAUDE.md with no managed section at all, so the orchestrator
   * never delegates (0% delegation) even after upgrading to a version that
   * ships the doctrine.
   *
   * GATE: only touches CLAUDE.md when TycoonAgents hooks are already
   * installed for this project ({@link _hooksInstalledForRoot} — the same
   * signal `_handleCheckInstall`/Hook Health use) — that's the consent
   * proxy so a project that never opted into TycoonAgents is never touched.
   * Reads `delegation_mode`/`reviewEnabled` from execution.json via the
   * same `readExecutionConfig` the mode/review handlers use (falling back
   * to its own defaults — Direct/"flat" + reviewEnabled true — when
   * execution.json is absent). Writes ONLY when the freshly-rendered
   * section actually differs from what's on disk (marker-scoped upsert —
   * text outside the markers is untouched); does not reinstall hooks.
   * Wrapped in try/catch so a failure here can never break panel
   * construction/rendering.
   */
  private _ensureDelegationDoctrineCurrent(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!this._hooksInstalledForRoot(root)) return;

      const claudeDir = path.join(root, ".claude");
      const { delegation_mode, reviewEnabled } = readExecutionConfig(claudeDir);

      const claudeMdPath = path.join(root, "CLAUDE.md");
      let existingClaudeMd: string | null = null;
      try {
        existingClaudeMd = fs.readFileSync(claudeMdPath, "utf8");
      } catch {
        existingClaudeMd = null;
      }

      const updated = this._buildClaudeMdDoctrine(existingClaudeMd, delegation_mode, reviewEnabled ?? true, root);
      if (existingClaudeMd !== null && updated === existingClaudeMd) return; // already current — no write, no notice

      fs.writeFileSync(claudeMdPath, updated);
      vscode.window.showInformationMessage("Refreshed delegation instructions in CLAUDE.md for this version.");
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal a missing project-appropriate worker roster once per panel
   * open. Previously `search-retrieval` (and, for non-UEFN projects,
   * `coding-specialist` + `ux-ui-designer`) had no install path outside a
   * fresh `_handleInstallHooks` run, so a project that opted into
   * TycoonAgents before this fix — or whose worker files were deleted —
   * never got them, and delegated search/implementation work silently fell
   * back to the synthetic fallback agent. Delegates the actual file-write
   * decision to `_installWorkerAgents`, which is strictly create-if-absent
   * (never overwrites a user's own or a UEFN pack's same-named agent).
   *
   * GATE: only runs when TycoonAgents hooks are already installed for this
   * project ({@link _hooksInstalledForRoot} — the same consent proxy
   * `_ensureAgentKeywordsSeeded` and `_ensureDelegationDoctrineCurrent`
   * use), so a project that hasn't opted into TycoonAgents is never
   * touched. Runs BEFORE `_ensureAgentKeywordsSeeded` in the constructor so
   * any worker file created here gets its keyword routing seeded in the
   * same panel-load cycle. Wrapped in try/catch so a failure here can never
   * break panel construction/rendering.
   */
  private _ensureWorkerAgentsInstalled(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!this._hooksInstalledForRoot(root)) return;
      this._installWorkerAgents(root);
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal: non-destructively reconcile `agent-keywords.json` against
   * the CURRENT `.claude/agents/*.md` roster on every panel open.
   *
   * Two problems this fixes, neither of which the old seed-only pass
   * handled:
   * - PHANTOMS: a config entry whose agent file was deleted/renamed stays
   *   in the table forever, can still win a keyword match, and routes to a
   *   file that no longer exists — a silent routing failure. Handled by
   *   {@link reconcileAgentKeywords}, which drops any config id with no
   *   matching agent file.
   * - WRONG SEED SOURCE: a missing entry was previously always seeded from
   *   the hardcoded `DEFAULT_AGENT_KEYWORDS` table, even when the agent's
   *   own `.md` body already declares real keywords under
   *   `## Keywords (for task routing)`. `reconcileAgentKeywords` now reads
   *   that body via {@link parseAgentKeywords} and prefers it.
   *
   * `seedMissingAgentKeywords` still runs afterward, unchanged, to fill any
   * entry that is PRESENT but EMPTY (its original job — e.g. an
   * intentionally-blanked entry from an old install) using
   * `DEFAULT_AGENT_KEYWORDS`. Reconcile deliberately never touches a
   * present-but-empty entry (that would count as "overwriting an existing
   * entry"), so the two passes are complementary, not overlapping.
   *
   * GATE: only runs when TycoonAgents hooks are already installed for this
   * project ({@link _hooksInstalledForRoot} — the same consent proxy
   * `_ensureDelegationDoctrineCurrent` uses), so a project that hasn't
   * opted into TycoonAgents is never touched. Never overwrites a non-empty
   * existing pattern (a user's own customization always wins) and never
   * writes when nothing changed. Wrapped in try/catch so a failure here can
   * never break panel construction/rendering.
   */
  private _ensureAgentKeywordsSeeded(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!this._hooksInstalledForRoot(root)) return;

      const agentsDir = path.join(root, ".claude", "agents");
      let files: string[];
      try {
        files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
      } catch {
        return; // no agents dir -> nothing to reconcile
      }
      if (files.length === 0) return;

      const agents = files.map((file) => {
        const id = file.replace(/\.md$/, "");
        let content = "";
        try {
          content = fs.readFileSync(path.join(agentsDir, file), "utf8");
        } catch {
          content = "";
        }
        return { id, keywords: parseAgentKeywords(content) };
      });

      let cfg = this._readKeywordsConfig(root);
      const { config: reconciled, dropped, added } = reconcileAgentKeywords(cfg, agents);
      cfg = reconciled;

      const { config: seeded, changed: seedChanged } = seedMissingAgentKeywords(
        cfg,
        agents.map((a) => a.id)
      );
      cfg = seeded;

      // Bump only PROVABLY-stale fossilized defaults (e.g. an older
      // quality-lead/reviewer pattern) forward — never touches a user's
      // customization (see migrateSupersededKeywords doc comment). Runs
      // last so it only ever sees entries the reconcile/seed passes above
      // left alone (both of those already refuse to overwrite anything).
      const { config: migrated, changed: migrateChanged } = migrateSupersededKeywords(cfg);
      cfg = migrated;

      if (dropped.length === 0 && added.length === 0 && !seedChanged && !migrateChanged) return;

      const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
      fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
      fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal: refresh `.claude/tycoon/tycoon-claude-hook.cjs` from the
   * extension's currently-bundled copy on every panel open.
   *
   * WHY: `_handleInstallHooks` (the only other writer of this file) only
   * runs on an explicit "Install hooks"/"Repair" click — updating the
   * extension itself never touches an already-installed project's on-disk
   * hook script. A real project ended up running the current extension
   * against a stale hook file missing newer code because of exactly this
   * gap. This closes it the same way `_ensureDelegationDoctrineCurrent`
   * closes the equivalent gap for CLAUDE.md.
   *
   * Rules:
   * - Never creates the file — if `dest` doesn't already exist, the
   *   project hasn't opted into TycoonAgents' hooks (or is mid-setup) and
   *   is left untouched, same opt-in guarantee `_ensureAgentKeywordsSeeded`
   *   preserves via `_hooksInstalledForRoot`.
   * - Only overwrites when the bundled source differs from what's on
   *   disk — an already-current file is left alone (no-op write, no
   *   mtime churn). The hook script is a single opaque bundled file with
   *   no supported user-editable region (unlike the CLAUDE.md doctrine
   *   section, which is template-rendered/reconciled), so "differs from
   *   bundled" is always treated as staleness to refresh forward.
   * - Wrapped in try/catch so a failure here can never break panel
   *   construction/rendering.
   */
  private _ensureHookScriptFresh(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;

      const dest = path.join(root, ".claude", "tycoon", "tycoon-claude-hook.cjs");
      if (!fs.existsSync(dest)) return; // never auto-create — opt-in preserved

      const src = vscode.Uri.joinPath(
        this._extensionUri,
        "hooks",
        "tycoon-claude-hook.cjs"
      ).fsPath;

      const srcContent = fs.readFileSync(src, "utf8");
      const destContent = fs.readFileSync(dest, "utf8");
      if (srcContent === destContent) return; // already current

      fs.writeFileSync(dest, srcContent);
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal a stale `.claude/skills/project-plan` directory once per panel
   * open, but ONLY when the opt-in `projectPlanEnabled` flag is already set
   * — mirrors `_ensureHookScriptFresh`'s "never auto-create, only refresh
   * what's already opted in" posture, except here the skill directory MAY
   * be created (via `_installProjectPlanSkill`) because enabling the
   * checkbox is itself the opt-in signal; a project that never enabled
   * Project Plan is left untouched.
   */
  private _ensureProjectPlanSkillFresh(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!readProjectPlanEnabled(root)) return;
      this._installProjectPlanSkill(root);
    } catch (e) {
      console.error("TycoonAgents: _ensureProjectPlanSkillFresh failed:", e);
    }
  }

  /**
   * Build the "Specialist roster" rows for the CLAUDE.md delegation doctrine
   * from the project's ACTUAL delegation targets, never a hardcoded list —
   * this avoids two failure modes: a hardcoded roster that assumes a fixed
   * agent set a given project may not have, and, by construction, dangling
   * agent names with no corresponding file.
   *
   * Source of truth:
   * - The id set comes ONLY from `.claude/agents/*.md` files present (via
   *   {@link loadAgentRoster}, reused rather than reimplemented) — every row
   *   is keyed on a real FILE id, so a name can never dangle.
   * - Each row's "Task types" column prefers the agent's routing pattern
   *   from `.claude/tycoon/agent-keywords.json` (pipe-delimited keywords,
   *   rendered comma-separated); falls back to the agent's `## Role`
   *   description, then a generic placeholder, when no keywords entry
   *   exists yet.
   *
   * The orchestrator, the fallback/`primary-agent`, and any `tier: lead` /
   * `tier: reviewer` agent are excluded — those already have their own
   * doctrine sections (Direct/Team-Leads framing, Review pass) rather than
   * being a "delegate to X" roster row. Returns `[]` (triggering
   * `renderDelegationDoctrine`'s hardcoded default) when the agents
   * directory is missing/empty — a bare install still gets sensible
   * defaults.
   */
  private _buildDoctrineRoster(root: string): DoctrineRosterAgent[] {
    const agentsDir = path.join(root, ".claude", "agents");
    const rosterFiles = loadAgentRoster(agentsDir);
    if (rosterFiles.length === 0) return [];

    const keywordsConfig = this._readKeywordsConfig(root);
    const keywordAgents: Record<string, any> =
      keywordsConfig && typeof keywordsConfig.agents === "object" && keywordsConfig.agents !== null
        ? keywordsConfig.agents
        : {};

    const EXCLUDED_IDS = new Set(["orchestrator", "primary-agent"]);

    const rows: DoctrineRosterAgent[] = [];
    for (const agent of rosterFiles) {
      if (EXCLUDED_IDS.has(agent.id)) continue;

      let tier: string | undefined;
      try {
        tier = agentMarkdownTier(fs.readFileSync(path.join(agentsDir, `${agent.id}.md`), "utf8"));
      } catch {
        tier = undefined;
      }
      if (tier === "lead" || tier === "reviewer") continue;

      const entry = keywordAgents[agent.id];
      const pattern: string = entry && typeof entry.pattern === "string" ? entry.pattern.trim() : "";
      const taskTypes =
        pattern !== ""
          ? pattern
              .split("|")
              .map((s: string) => s.trim())
              .filter(Boolean)
              .join(", ")
          : agent.description ?? "General tasks";

      rows.push({ id: agent.id, taskTypes });
    }

    return rows;
  }

  /**
   * Build the full managed CLAUDE.md doctrine content (delegation section +
   * code rules section) for a given mode/reviewEnabled, splicing into
   * `existingContent`. Shared by `_handleInstallHooks` (the reference write
   * path) and `_ensureDelegationDoctrineCurrent` (auto-heal) so both
   * produce IDENTICAL output for the same inputs — auto-heal never drifts
   * from what a fresh Install/Repair would write.
   *
   * `root` drives two project-aware pieces: the dynamic Specialist roster
   * (see `_buildDoctrineRoster`) and, via `detectUefnProject`, whether the
   * code-rules table renders the UEFN/Verse variant instead of the generic
   * web/TS one (see `renderCodeRules`'s `uefn` param).
   */
  private _buildClaudeMdDoctrine(
    existingContent: string | null,
    mode: DelegationMode,
    reviewEnabled: boolean,
    root: string
  ): string {
    const roster = this._buildDoctrineRoster(root);
    const isUefn = detectUefnProject(root).detected;
    const withDelegation = upsertDelegationSection(
      existingContent,
      renderDelegationDoctrine(mode, reviewEnabled, roster)
    );
    return upsertCodeRulesSection(withDelegation, renderCodeRules(isUefn));
  }

  private _handleInstallHooks(delegationMode: DelegationMode = "flat"): void {
    void this._panel.webview.postMessage({ type: MSG.INSTALL_STATE, busy: true });
    try {
      const root = this._projectRoot();
      if (root === "") {
        throw new Error("No workspace folder open");
      }

      // 1. Ensure .claude/tycoon exists.
      const claudeDir = path.join(root, ".claude");
      const tycoonDir = path.join(claudeDir, "tycoon");
      fs.mkdirSync(tycoonDir, { recursive: true });

      // 1b. Strip any leftover artifacts from a foreign/legacy agent-hook
      // system (stale lock, stuck stack, root-level state files, and hook
      // commands wired into our own event slots) BEFORE we read/merge
      // settings below, so our hooks are guaranteed to land on a clean base.
      cleanupForeignHookArtifacts(claudeDir);

      // 2. Copy the bundled hook into the project.
      const src = vscode.Uri.joinPath(
        this._extensionUri,
        "hooks",
        "tycoon-claude-hook.cjs"
      ).fsPath;
      const dest = path.join(tycoonDir, "tycoon-claude-hook.cjs");
      fs.copyFileSync(src, dest);

      // 3. Relative hook command (Claude Code runs hooks with cwd = project root).
      const hookCommand = this._buildHookCommand();

      // 4. Read existing settings.local.json (default {} if missing/empty/invalid).
      const settingsPath = path.join(root, ".claude", "settings.local.json");
      let existing: Record<string, unknown> = {};
      try {
        const raw = fs.readFileSync(settingsPath, "utf8").trim();
        if (raw !== "") {
          const parsed = JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object") {
            existing = parsed as Record<string, unknown>;
          }
        }
      } catch {
        /* missing/invalid => default {} */
      }

      // 5. Merge our hooks (pure helper).
      const merged = mergeTycoonHooks(existing, hookCommand);

      // 6. Write merged settings.
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

      // 6b. Backfill routing keywords for any already-present hand-authored
      // agent (see _ensureAgentKeywordsSeeded) so a fresh install populates
      // keyword routing immediately rather than waiting for a panel reopen.
      // Must run AFTER step 6 — its hooks-installed gate reads the settings
      // file just written above. Best-effort — internally try/caught, never
      // fails the hook install.
      this._ensureAgentKeywordsSeeded();

      // 7. Team Lead Mode (Phase 1) wiring — same `.claude` dir the hook install
      // just wrote into. A CLAUDE.md write failure is a USER-OWNED-file risk,
      // so it's caught independently and reported without failing the
      // (already-successful) hook install.
      // Review pass is on by default (execution.json's reviewEnabled)
      // whenever a project is freshly installed/repaired — the setup
      // screen's checkbox is checked by default and, when the user
      // unchecks it, the webview follows this installHooks message with a
      // SET_REVIEW_ENABLED(false) that turns it back off.
      const reviewEnabled = true;
      let claudeMdError: string | undefined;
      try {
        // 7a. Persist the chosen mode + the default Review-pass state.
        writeExecutionConfig(claudeDir, { delegation_mode: delegationMode, reviewEnabled });

        // 7c/7d. Lead agent files + keyword routing — only written for
        // team_leads. Flat mode leaves any previously-installed lead files
        // alone (Phase 2 handles removal on downgrade via setDelegationMode).
        if (delegationMode === "team_leads") {
          this._installLeadAgents(root);
        }

        // 7d2. Project-appropriate worker roster — always search-retrieval;
        // for non-UEFN projects also coding-specialist + ux-ui-designer.
        // Never overwrites an existing file (see _installWorkerAgents).
        this._installWorkerAgents(root);

        // 7e. Reviewer agent file + keyword routing — installed by default,
        // regardless of delegation_mode (the Review pass composes with
        // either base mode), but skipped for UEFN projects: the UEFN pack
        // brings its own uefn-auditor verification gate, and our reviewer
        // would conflict with it.
        if (reviewEnabled && !detectUefnProject(root).detected && !this._isUefnPackInstalled(root)) {
          this._installReviewerAgent(root);
        }
      } catch (err) {
        claudeMdError = String(err);
      }

      // 7b. Upsert the delegation doctrine + code rules into the
      // workspace's CLAUDE.md (shared builder — see _buildClaudeMdDoctrine
      // — so this and the auto-heal path in _ensureDelegationDoctrineCurrent
      // always produce identical output for the same inputs). Wrapped
      // separately so a failure here (user-owned file) never fails the hook
      // install itself.
      try {
        const claudeMdPath = path.join(root, "CLAUDE.md");
        let existingClaudeMd: string | null = null;
        try {
          existingClaudeMd = fs.readFileSync(claudeMdPath, "utf8");
        } catch {
          existingClaudeMd = null;
        }
        const updated = this._buildClaudeMdDoctrine(existingClaudeMd, delegationMode, reviewEnabled, root);
        fs.writeFileSync(claudeMdPath, updated);
      } catch (err) {
        claudeMdError = claudeMdError ?? String(err);
      }

      // 8. Success.
      void this._panel.webview.postMessage({
        type: MSG.INSTALL_STATE,
        installed: true,
        delegation_mode: delegationMode,
        ...(claudeMdError !== undefined ? { claudeMdError } : {}),
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.INSTALL_STATE,
        installed: false,
        error: String(err),
      });
    }
  }

  /**
   * Write a roster of `PackAgent` `.md` files and register their keyword
   * routing in `agent-keywords.json`. Shared, mode-agnostic install path:
   * `_installLeadAgents` applies it to `LEAD_AGENTS` (team_leads),
   * `_installReviewerAgent` applies it to `REVIEWER_AGENTS` (the
   * Review-pass toggle) — either can install regardless of the other's
   * state.
   *
   * Per agent:
   *  - no existing file -> create it.
   *  - existing file whose frontmatter `tier:` (via {@link
   *    agentMarkdownTier}) matches `a.tier` -> it's OURS, safe to refresh
   *    in place so fixes to `buildAgentMarkdown` (e.g. the `name`/
   *    `description` frontmatter Claude Code requires to register a
   *    subagent) reach a project that already has a stale copy on disk.
   *    Only rewritten when the generated content actually differs, so a
   *    reinstall/Repair on an already-current project is a no-op (no
   *    churn).
   *  - existing file whose tier does NOT match (absent, or a different
   *    tier) -> a user's own file, or a foreign/legacy same-named agent;
   *    left byte-untouched, mirroring `_removeAgentFiles`'s "never touch a
   *    file we can't prove is ours" rule.
   *
   * Keyword routing is always (re)written for every agent in the roster,
   * same as before.
   */
  private _installAgentFiles(root: string, agentsToInstall: PackAgent[]): void {
    let cfg = this._readKeywordsConfig(root);
    for (const a of agentsToInstall) {
      const agentPath = path.join(root, ".claude", "agents", `${a.id}.md`);
      try {
        if (!fs.existsSync(agentPath)) {
          fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
          fs.writeFileSync(agentPath, buildAgentMarkdown(a));
        } else {
          const existing = fs.readFileSync(agentPath, "utf8");
          let existingTier: string | undefined;
          try {
            existingTier = agentMarkdownTier(existing);
          } catch {
            existingTier = undefined;
          }
          if (existingTier === a.tier) {
            const desired = buildAgentMarkdown(a);
            if (existing !== desired) {
              fs.writeFileSync(agentPath, desired);
            }
          }
          // else: foreign/legacy same-named file — never overwritten.
        }
      } catch {
        /* best-effort per-file; keyword routing still proceeds below */
      }
      cfg = setKeywordPattern(cfg, a.id, a.keywords);
    }
    const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
    fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
    fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
  }

  /**
   * Remove a roster of `PackAgent` `.md` files and their keyword routing
   * entries. A `.md` file is only deleted when its frontmatter `tier:`
   * matches `expectedTier` (via {@link agentMarkdownTier}) — a user's own
   * file that happens to share an id like `build-lead.md` or `reviewer.md`
   * but wasn't written by TycoonAgents is never touched. The
   * `agent-keywords.json` routing entries are always safe to strip by id
   * (that file is TycoonAgents-managed, not user-authored). Shared,
   * mode-agnostic removal path: `_removeLeadAgents` applies it to
   * `LEAD_AGENTS` with `expectedTier: "lead"`, `_removeReviewerAgent`
   * applies it to `REVIEWER_AGENTS` with `expectedTier: "reviewer"`.
   * Idempotent: safe to call when the files/entries are already absent.
   */
  private _removeAgentFiles(root: string, agentsToRemove: PackAgent[], expectedTier: string): void {
    for (const a of agentsToRemove) {
      const agentPath = path.join(root, ".claude", "agents", `${a.id}.md`);
      if (fs.existsSync(agentPath)) {
        let tier: string | undefined;
        try {
          tier = agentMarkdownTier(fs.readFileSync(agentPath, "utf8"));
        } catch {
          tier = undefined;
        }
        if (tier === expectedTier) {
          try {
            fs.unlinkSync(agentPath);
          } catch {
            /* best-effort */
          }
        }
      }
    }

    let cfg = this._readKeywordsConfig(root);
    for (const a of agentsToRemove) {
      cfg = removeKeywordPattern(cfg, a.id);
    }
    const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
    try {
      fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
      fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
    } catch {
      /* best-effort: keywords file is non-critical for removal */
    }
  }

  /**
   * Install the `LEAD_AGENTS` `.md` files. Shared by `_handleInstallHooks`
   * (team_leads chosen at install) and `_handleSetDelegationMode`
   * (switching to team_leads later in Settings).
   */
  private _installLeadAgents(root: string): void {
    this._installAgentFiles(root, LEAD_AGENTS);
  }

  /**
   * Remove the `LEAD_AGENTS` `.md` files when downgrading a project out of
   * team_leads mode.
   */
  private _removeLeadAgents(root: string): void {
    this._removeAgentFiles(root, LEAD_AGENTS, "lead");
  }

  /**
   * True when the UEFN pack is installed in this project. There is no
   * separate installed-packs registry in `.claude/tycoon/execution.json`
   * (see `ExecutionConfig` in delegationDoctrine.ts — it only tracks
   * `delegation_mode`/`reviewEnabled`), so the agent-file signal is
   * authoritative: the UEFN pack's marker agent `uefn-auditor.md` exists on
   * disk AND carries the `tycoon_pack: uefn` provenance marker
   * `_handleInstallPack` stamps into every agent file it writes.
   *
   * WHY THIS EXISTS: `_installWorkerAgents` previously used only
   * `detectUefnProject(root).detected` (Verse *content* in the project) to
   * decide the worker roster. A project that just had its
   * `coding-specialist.md` removed by the UEFN conflict gate (see
   * `_handleInstallPack`) but has no Verse content on disk YET would fall
   * back to `detected === false`, and `_installWorkerAgents` would silently
   * re-create `coding-specialist.md` on the next panel load — undoing the
   * conflict gate's removal. Consulting pack-installed state directly
   * closes that gap.
   */
  private _isUefnPackInstalled(root: string): boolean {
    try {
      const markerPath = path.join(root, ".claude", "agents", "uefn-auditor.md");
      if (!fs.existsSync(markerPath)) return false;
      return agentMarkdownHasTycoonMarker(fs.readFileSync(markerPath, "utf8"));
    } catch {
      return false;
    }
  }

  /**
   * Install the project-appropriate worker roster (see
   * `workerAgentsForProject`): always `search-retrieval`; for non-UEFN
   * projects also `coding-specialist` and `ux-ui-designer`. Unlike
   * `_installAgentFiles` (which refreshes a file it recognizes as its own
   * via a matching `tier:`), this is strictly create-if-absent — it NEVER
   * overwrites an existing `.claude/agents/<id>.md`, whether that file is a
   * user's own customization, a hand-authored dogfood copy, or a UEFN
   * pack's same-named agent. Each file's create is independently
   * try/caught so one failure never blocks the rest, and the method itself
   * never throws.
   */
  private _installWorkerAgents(root: string): void {
    try {
      const isUefn = detectUefnProject(root).detected || this._isUefnPackInstalled(root);
      const agents = workerAgentsForProject(isUefn);
      const agentsDir = path.join(root, ".claude", "agents");
      for (const a of agents) {
        try {
          const agentPath = path.join(agentsDir, `${a.id}.md`);
          if (!fs.existsSync(agentPath)) {
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(agentPath, buildAgentMarkdown(a));
          }
        } catch {
          /* best-effort per-file; never blocks the rest of the roster */
        }
      }
    } catch {
      /* best-effort roster install — this method must never throw. */
    }
  }

  /**
   * Install the `REVIEWER_AGENTS` `.md` file(s). Runs regardless of the
   * project's `delegation_mode` — the Review pass composes with either
   * base mode. Called from `_handleInstallHooks` (Review on by default at
   * fresh install) and `_handleSetReviewEnabled` (toggled on in Settings).
   */
  private _installReviewerAgent(root: string): void {
    this._installAgentFiles(root, REVIEWER_AGENTS);
  }

  /**
   * Remove the `REVIEWER_AGENTS` `.md` file(s) when the Review pass is
   * turned off via `_handleSetReviewEnabled`.
   */
  private _removeReviewerAgent(root: string): void {
    this._removeAgentFiles(root, REVIEWER_AGENTS, "reviewer");
  }

  /**
   * Switch the project's delegation mode (Team Lead Mode, Phase 2). Mirrors
   * `_handleInstallHooks`'s Phase 1 wiring: persists `execution.json`,
   * installs/removes the lead agent files + keyword routing, and upserts
   * the managed `CLAUDE.md` doctrine section. Idempotent in both
   * directions — applying the mode that's already active is a no-op that
   * still replies success so the UI settles. The `CLAUDE.md` write is a
   * user-owned-file risk, so (like install) it's isolated in its own
   * try/catch and reported via `claudeMdError` without failing the mode
   * switch itself.
   */
  private _handleSetDelegationMode(rawMode: string | undefined): void {
    const mode = this._coerceDelegationMode(rawMode);
    const root = this._projectRoot();
    if (root === "") {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id: "delegation-mode",
        field: "delegationMode",
        error: "No workspace folder open",
      });
      return;
    }

    try {
      const claudeDir = path.join(root, ".claude");
      writeExecutionConfig(claudeDir, { delegation_mode: mode });
      if (mode === "team_leads") {
        this._installLeadAgents(root);
      } else {
        this._removeLeadAgents(root);
      }
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id: "delegation-mode",
        field: "delegationMode",
        error: String(err),
      });
      return;
    }

    // Doctrine composes delegation_mode with the (unrelated) reviewEnabled
    // toggle — re-read the merged execution.json so a mode switch never
    // silently resets the Review-pass section on/off.
    const reviewEnabled = readExecutionConfig(path.join(root, ".claude")).reviewEnabled ?? true;

    let claudeMdError: string | undefined;
    try {
      const claudeMdPath = path.join(root, "CLAUDE.md");
      let existingClaudeMd: string | null = null;
      try {
        existingClaudeMd = fs.readFileSync(claudeMdPath, "utf8");
      } catch {
        existingClaudeMd = null;
      }
      const updated = upsertDelegationSection(
        existingClaudeMd,
        renderDelegationDoctrine(mode, reviewEnabled, this._buildDoctrineRoster(root))
      );
      fs.writeFileSync(claudeMdPath, updated);
    } catch (err) {
      claudeMdError = String(err);
    }

    void this._panel.webview.postMessage({
      type: MSG.SETTINGS_UPDATED,
      ok: true,
      id: "delegation-mode",
      field: "delegationMode",
      delegation_mode: mode,
      ...(claudeMdError !== undefined ? { claudeMdError } : {}),
    });
  }

  /**
   * Toggle the optional "Review pass" (on by default). Mirrors
   * `_handleSetDelegationMode`'s wiring exactly, but for the orthogonal
   * `reviewEnabled` flag: persists `execution.json` (merge-safe — does not
   * touch `delegation_mode`), installs/removes the `reviewer` agent file,
   * and upserts the managed `CLAUDE.md` doctrine section using whatever
   * `delegation_mode` is already on disk. Works regardless of base mode.
   */
  private _handleSetReviewEnabled(enabled: boolean): void {
    const root = this._projectRoot();
    if (root === "") {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id: "review-enabled",
        field: "reviewEnabled",
        error: "No workspace folder open",
      });
      return;
    }

    try {
      const claudeDir = path.join(root, ".claude");
      writeExecutionConfig(claudeDir, { reviewEnabled: enabled });
      if (enabled) {
        this._installReviewerAgent(root);
      } else {
        this._removeReviewerAgent(root);
      }
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id: "review-enabled",
        field: "reviewEnabled",
        error: String(err),
      });
      return;
    }

    const mode = readExecutionConfig(path.join(root, ".claude")).delegation_mode;

    let claudeMdError: string | undefined;
    try {
      const claudeMdPath = path.join(root, "CLAUDE.md");
      let existingClaudeMd: string | null = null;
      try {
        existingClaudeMd = fs.readFileSync(claudeMdPath, "utf8");
      } catch {
        existingClaudeMd = null;
      }
      const updated = upsertDelegationSection(
        existingClaudeMd,
        renderDelegationDoctrine(mode, enabled, this._buildDoctrineRoster(root))
      );
      fs.writeFileSync(claudeMdPath, updated);
    } catch (err) {
      claudeMdError = String(err);
    }

    void this._panel.webview.postMessage({
      type: MSG.SETTINGS_UPDATED,
      ok: true,
      id: "review-enabled",
      field: "reviewEnabled",
      reviewEnabled: enabled,
      ...(claudeMdError !== undefined ? { claudeMdError } : {}),
    });
  }

  /** Read the agent-keywords config (tolerant), returning a default on failure. */
  private _readKeywordsConfig(root: string): Record<string, any> {
    const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(keywordsPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, any>;
      }
    } catch {
      /* missing/invalid => default */
    }
    return { fallback_agent: "primary-agent", agents: {} };
  }

  /** True if either project settings file references our hook. */
  private _hookInstalled(root: string): boolean {
    return (
      root !== "" &&
      (this._settingsReferencesHook(
        path.join(root, ".claude", "settings.local.json")
      ) ||
        this._settingsReferencesHook(
          path.join(root, ".claude", "settings.json")
        ))
    );
  }

  /** Post the current settings snapshot (hook + per-agent model/keywords). */
  private _handleGetSettings(): void {
    const root = this._projectRoot();
    const agentsDir = path.join(root, ".claude", "agents");

    const keywordsConfig = this._readKeywordsConfig(root);
    const keywordAgents =
      keywordsConfig &&
      typeof keywordsConfig.agents === "object" &&
      keywordsConfig.agents !== null
        ? keywordsConfig.agents
        : {};

    const agents = loadAgentRoster(agentsDir).map((agent) => {
      const entry = keywordAgents[agent.id];
      const keywords =
        entry && typeof entry.pattern === "string" ? entry.pattern : "";
      return {
        id: agent.id,
        name: agent.name,
        model: shortFromModelId(agent.model) ?? null,
        isOrchestrator: agent.id === "orchestrator",
        keywords,
      };
    });

    let lastActivityAt: number | null = null;
    try {
      lastActivityAt = fs.statSync(
        path.join(root, ".claude", "tycoon", "activity.jsonl")
      ).mtimeMs;
    } catch {
      lastActivityAt = null;
    }

    // Build delegationHealth from orchestrator metric
    const state = this._runtime.getState();
    const orchMetric = Array.isArray(state.agentMetrics)
      ? state.agentMetrics.find((m: any) => m.id === "orchestrator")
      : undefined;
    const directSearches: number = orchMetric?.directSearches ?? 0;
    const directReads: number = orchMetric?.directReads ?? 0;
    const directEdits: number = orchMetric?.directEdits ?? 0;
    const delegations: number = orchMetric?.delegations ?? 0;
    const warnThreshold: number =
      vscode.workspace.getConfiguration("tycoonagents").get<number>("delegationWarnThreshold", 5);
    const cumulativeTokens: number = Array.isArray(state.agentMetrics)
      ? state.agentMetrics.reduce((sum: number, m: any) => sum + (m?.tokens ?? 0), 0)
      : 0;

    // "This session" scoping: rebuild state from activity.jsonl records filtered
    // to the current session id, via the SAME reducer path the live runtime
    // uses (computeStateFromRecords -> mapHookRecord -> applyEvent). Additive to
    // the cumulative fields above, which remain unchanged (back-compat).
    const activityRecords = this._readActivityRecords(root);
    const currentSessionId = this._currentSessionId(activityRecords);
    let sessionHealth:
      | { directSearches: number; directReads: number; directEdits: number; delegations: number; tokens: number }
      | undefined;
    if (currentSessionId !== undefined) {
      const sessionState = computeStateFromRecords(activityRecords, currentSessionId);
      const sessionOrchMetric = sessionState.agentMetrics.find((m) => m.id === "orchestrator");
      sessionHealth = {
        directSearches: sessionOrchMetric?.directSearches ?? 0,
        directReads: sessionOrchMetric?.directReads ?? 0,
        directEdits: sessionOrchMetric?.directEdits ?? 0,
        delegations: sessionOrchMetric?.delegations ?? 0,
        tokens: sessionState.agentMetrics.reduce((sum, m) => sum + (m.tokens ?? 0), 0),
      };
    }

    // Run hook diagnostic to compute hookHealth for the settings panel
    const { findings } = this._diagnoseHooks();
    const issueCount = findings.filter((f) => f.severity !== "ok").length;
    const hookHealth = { healthy: issueCount === 0, issueCount };

    // Build context budget (CLAUDE.md + agent .md files)
    let contextBudget;
    try {
      let claudeMdContent: string | null = null;
      try {
        claudeMdContent = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      } catch {
        claudeMdContent = null;
      }
      const agentEntries: Array<{ name: string; content: string }> = [];
      try {
        const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
        for (const fname of agentFiles) {
          try {
            const content = fs.readFileSync(path.join(agentsDir, fname), "utf8");
            agentEntries.push({ name: fname, content });
          } catch {
            /* skip unreadable */
          }
        }
      } catch {
        /* agentsDir missing => empty */
      }
      contextBudget = buildContextBudget(claudeMdContent, agentEntries);
    } catch {
      contextBudget = buildContextBudget(null, []);
    }

    const execCfg =
      root !== "" ? readExecutionConfig(path.join(root, ".claude")) : { delegation_mode: "flat" as const, reviewEnabled: true };
    const delegation_mode = execCfg.delegation_mode;
    const reviewEnabled = execCfg.reviewEnabled ?? true;

    // Generic foreign-managed-block detection — same read/compute
    // _handleCheckInstall does, duplicated here (rather than shared) so the
    // Settings screen (renderSettings' Hook health / Context budget
    // sections) can surface it without depending on a CHECK_INSTALL
    // round-trip having run first. See legacyDoctrine.ts.
    let foreignManagedBlocks: { namespace: string; lines: number }[] = [];
    if (root !== "") {
      try {
        const claudeMdContent = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
        foreignManagedBlocks = detectForeignManagedBlocks(claudeMdContent);
      } catch {
        // No CLAUDE.md yet -> nothing to detect.
      }
    }

    void this._panel.webview.postMessage({
      type: MSG.SETTINGS,
      payload: {
        hook: { installed: this._hookInstalled(root), lastActivityAt },
        agents,
        delegation_mode,
        reviewEnabled,
        delegationHealth: {
          directSearches,
          directReads,
          directEdits,
          delegations,
          warnThreshold,
          tokens: cumulativeTokens,
          session: sessionHealth,
          sessionId: currentSessionId,
        },
        hookHealth,
        contextBudget,
        foreignManagedBlocks,
      },
    });
  }

  /** Write the chosen model into an agent's markdown frontmatter. */
  private _handleSetAgentModel(id: string, model: string): void {
    if (!isSafeAgentId(id)) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id,
        field: "model",
        error: "invalid agent id",
      });
      return;
    }
    const fullId = modelIdFromShort(model);
    if (fullId === undefined) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id,
        field: "model",
        error: "unknown model",
      });
      return;
    }
    try {
      const root = this._projectRoot();
      const filePath = path.join(root, ".claude", "agents", `${id}.md`);
      const content = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, setFrontmatterModel(content, fullId));
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: true,
        id,
        field: "model",
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id,
        field: "model",
        error: String(err),
      });
    }
  }

  /**
   * Remove a single agent: delete its `.claude/agents/<id>.md` file and its
   * `agent-keywords.json` routing entry, gated behind a native modal confirm.
   * The orchestrator/coordinator is the core session-model agent and cannot be
   * removed. Refreshes the settings/roster on success so the webview re-renders
   * without the removed agent. Mirrors the agent-removal + confirm pattern in
   * `_handleRemovePack`.
   */
  private async _handleRemoveAgent(id: string): Promise<void> {
    if (!isSafeAgentId(id)) {
      void this._panel.webview.postMessage({
        type: MSG.AGENT_REMOVED,
        id,
        ok: false,
        error: "invalid agent id",
      });
      return;
    }
    // The orchestrator is the core session-model agent — never removable.
    if (id === "orchestrator") {
      void this._panel.webview.postMessage({
        type: MSG.AGENT_REMOVED,
        id,
        ok: false,
        error: "core agent cannot be removed",
      });
      return;
    }
    try {
      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({
          type: MSG.AGENT_REMOVED,
          id,
          ok: false,
          error: "No workspace folder open",
        });
        return;
      }

      // Resolve a friendly display name for the confirmation dialog.
      const agentsDir = path.join(root, ".claude", "agents");
      const rosterEntry = loadAgentRoster(agentsDir).find((a) => a.id === id);
      const displayName = rosterEntry?.name ?? id;

      const answer = await vscode.window.showWarningMessage(
        `Remove the '${displayName}' agent?`,
        {
          modal: true,
          detail: `This deletes .claude/agents/${id}.md and its keyword routing.`,
        },
        "Remove"
      );
      if (answer !== "Remove") {
        void this._panel.webview.postMessage({
          type: MSG.AGENT_REMOVED,
          id,
          ok: false,
          cancelled: true,
        });
        return;
      }

      // Delete the agent markdown file (guard existence).
      const agentPath = path.join(agentsDir, `${id}.md`);
      if (fs.existsSync(agentPath)) {
        fs.unlinkSync(agentPath);
      }

      // Remove the agent's routing entry from agent-keywords.json — reuse the
      // exact keyword-removal logic from _handleRemovePack.
      let cfg = this._readKeywordsConfig(root);
      if (cfg && typeof cfg.agents === "object" && cfg.agents !== null && id in cfg.agents) {
        const nextAgents = { ...cfg.agents };
        delete nextAgents[id];
        cfg = { ...cfg, agents: nextAgents };
      }
      const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
      try {
        fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
        fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
      } catch {
        /* best-effort: keywords file is non-critical for removal */
      }

      this._panel.webview.postMessage({ type: MSG.AGENT_REMOVED, id, ok: true });
      // Refresh the settings/roster the same way setAgentModel-driven changes do.
      this._handleGetSettings();
    } catch (e) {
      void this._panel.webview.postMessage({
        type: MSG.AGENT_REMOVED,
        id,
        ok: false,
        error: String(e),
      });
    }
  }

  /** Write the routing pattern for an agent into agent-keywords.json. */
  private _handleSetAgentKeywords(id: string, pattern: string): void {
    try {
      const root = this._projectRoot();
      const keywordsPath = path.join(
        root,
        ".claude",
        "tycoon",
        "agent-keywords.json"
      );
      const config = this._readKeywordsConfig(root);
      const updated = setKeywordPattern(config, id, pattern);
      fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
      fs.writeFileSync(keywordsPath, JSON.stringify(updated, null, 2));
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: true,
        id,
        field: "keywords",
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id,
        field: "keywords",
        error: String(err),
      });
    }
  }

  /**
   * Truncate the (session-global) activity log, reset runtime state,
   * re-seed the roster, and — if a theme is currently loaded — clear ONLY
   * that theme's badge/rebirth/build-progress entries for THIS project
   * (composite `${scopeKey}|${themeId}` keys). Other themes and other
   * projects' entries for the SAME theme are left untouched.
   */
  private async _handleResetMetrics(): Promise<void> {
    // Confirmation now happens in-panel (webview modal) before this message
    // is ever sent — see showResetConfirmModal() in media/main.js. By the
    // time we get here the reset is already user-approved; run it directly.
    const themeId = this._currentThemeId;
    try {
      const root = this._projectRoot();
      const activityPath = path.join(
        root,
        ".claude",
        "tycoon",
        "activity.jsonl"
      );
      fs.writeFileSync(activityPath, "");

      this._runtime.reset();

      // Scoped wipe: only the CURRENT project's entries for the CURRENTLY
      // LOADED theme are removed from each store — other themes (and this
      // same theme in other projects) survive untouched. No active theme
      // (e.g. panel opened but nothing loaded yet) => nothing to scope, so
      // this step is a no-op and only the activity log / runtime reset.
      if (themeId) {
        const scopeKey = this._projectScopeKey();
        const [badgeStore, rebirthStore, buildStore] = await Promise.all([
          this._readBadgeUnlocksStore(),
          this._readRebirthStore(),
          this._readBuildProgressStore(),
        ]);
        // Composite removal is authoritative (migration is gone). ALSO strip
        // the legacy plain-themeId entry so stale pre-scoping global data
        // can't linger or reappear.
        const badgeLegacy = removeLegacyThemeEntry(removeProjectThemeEntry(badgeStore, scopeKey, themeId), themeId);
        const rebirthLegacy = removeLegacyThemeEntry(removeProjectThemeEntry(rebirthStore, scopeKey, themeId), themeId);
        const buildLegacy = removeLegacyThemeEntry(removeProjectThemeEntry(buildStore, scopeKey, themeId), themeId);
        await Promise.all([
          this._writeBadgeUnlocksStore(badgeLegacy.store),
          this._writeRebirthStore(rebirthLegacy.store),
          this._writeBuildProgressStore(buildLegacy.store),
        ]);
      }

      // Re-seed the full installed-agent roster (mirrors extension.ts).
      const agentsDir = path.join(root, ".claude", "agents");
      for (const agent of loadAgentRoster(agentsDir)) {
        const displayName =
          agent.id === "search-retrieval"
            ? agent.name.replace(/ Agent$/, "")
            : agent.name;
        this._runtime.ingest({
          type: "WorkerRegistered",
          at: Date.now(),
          workerId: agent.id,
          name: displayName,
          ...(agent.model !== undefined ? { model: agent.model } : {}),
          ...(agent.description !== undefined
            ? { description: agent.description }
            : {}),
        });
      }

      void this._panel.webview.postMessage({ type: MSG.METRICS_RESET, ok: true });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.METRICS_RESET,
        ok: false,
        error: String(err),
      });
    }
  }

  private _buildHookCommand(): string {
    return `node ".claude/tycoon/tycoon-claude-hook.cjs"`;
  }

  private _readSettingsTolerant(settingsPath: string): any | null {
    try {
      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (raw !== "") {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object") {
          return parsed;
        }
      }
    } catch {
      /* missing/invalid => null */
    }
    return null;
  }

  /**
   * Read-only scan for leftover foreign/legacy agent-hook artifacts: known
   * root-level state files (see LEGACY_STATE_FILE_NAMES) plus any
   * `agent-activity-*.json` files, and legacy hook commands still wired into
   * our own event slots in `localSettings`/`sharedSettings`. Does not mutate
   * anything — {@link cleanupForeignHookArtifacts} is the fix path.
   */
  private _detectLegacyArtifacts(
    claudeDir: string,
    localSettings: any | null,
    sharedSettings: any | null
  ): { leftoverFiles: string[]; hookCommands: string[] } {
    const leftoverFiles: string[] = [];
    for (const name of LEGACY_STATE_FILE_NAMES) {
      if (fs.existsSync(path.join(claudeDir, name))) {
        leftoverFiles.push(name);
      }
    }
    try {
      if (fs.existsSync(claudeDir)) {
        for (const entry of fs.readdirSync(claudeDir)) {
          if (/^agent-activity-.*\.json$/.test(entry)) {
            leftoverFiles.push(entry);
          }
        }
      }
    } catch {
      /* best-effort */
    }
    const hookCommands = [
      ...findLegacyHookCommands(localSettings),
      ...findLegacyHookCommands(sharedSettings),
    ];
    return { leftoverFiles, hookCommands };
  }

  /**
   * Reads the operational-health signals Hook Doctor needs but `diagnose()`
   * itself can't see (it stays fs-free/pure for unit testing): the age of
   * `active-agent.json.lock`, the current shape of `active-agent.json`, and
   * a tail of recent `activity.jsonl` records.
   */
  private _readOperationalHealth(claudeDir: string): {
    lockFileAgeMs?: number;
    activeAgentState?: { stack: unknown[]; agentId: string; timestampMs?: number } | null;
    activityTailLines?: string[];
  } {
    const tycoonDir = path.join(claudeDir, "tycoon");

    let lockFileAgeMs: number | undefined;
    try {
      const stat = fs.statSync(path.join(tycoonDir, "active-agent.json.lock"));
      lockFileAgeMs = Date.now() - stat.mtimeMs;
    } catch {
      /* lock absent -> check skipped */
    }

    let activeAgentState: { stack: unknown[]; agentId: string; timestampMs?: number } | null = null;
    try {
      const raw = fs.readFileSync(path.join(tycoonDir, "active-agent.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        activeAgentState = {
          stack: Array.isArray(parsed.stack) ? parsed.stack : [],
          agentId: typeof parsed.agentId === "string" ? parsed.agentId : "none",
          timestampMs: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined,
        };
      }
    } catch {
      /* file absent/invalid -> check skipped */
    }

    let activityTailLines: string[] | undefined;
    try {
      const raw = fs.readFileSync(path.join(tycoonDir, "activity.jsonl"), "utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      activityTailLines = lines.slice(-5);
    } catch {
      /* file absent -> check skipped */
    }

    return { lockFileAgeMs, activeAgentState, activityTailLines };
  }

  /**
   * Reads and parses the FULL `.claude/tycoon/activity.jsonl` for `root` into
   * an ordered HookRecord[] (oldest first), skipping blank/unparseable lines.
   * Used by the Delegation Health dual view (session-scoped vs. cumulative
   * rebuild via computeStateFromRecords) — unlike _readOperationalHealth's
   * activityTailLines (last 5 raw lines, for Hook Doctor display), this reads
   * every record so a session-scoped replay is complete.
   */
  private _readActivityRecords(root: string): HookRecord[] {
    const records: HookRecord[] = [];
    try {
      const raw = fs.readFileSync(
        path.join(root, ".claude", "tycoon", "activity.jsonl"),
        "utf8"
      );
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            records.push(parsed as HookRecord);
          }
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* activity.jsonl absent -> no records */
    }
    return records;
  }

  /**
   * The CURRENT session id: the `sessionId` carried on the LAST record (by
   * file order) that has one. Undefined if no record carries a sessionId
   * (empty log, or every record predates the hook writing sessionId).
   */
  private _currentSessionId(records: HookRecord[]): string | undefined {
    for (let i = records.length - 1; i >= 0; i--) {
      const sid = records[i]?.sessionId;
      if (typeof sid === "string" && sid !== "") return sid;
    }
    return undefined;
  }

  /** Assembles a full DoctorInput (settings + operational health) from disk for `root`. */
  private _gatherDoctorInput(root: string): DoctorInput {
    const claudeDir = path.join(root, ".claude");
    const localSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.local.json"));
    const sharedSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.json"));
    const currentHookCommand = this._buildHookCommand();
    const hookScriptExists = fs.existsSync(path.join(claudeDir, "tycoon", "tycoon-claude-hook.cjs"));
    const legacyArtifacts = this._detectLegacyArtifacts(claudeDir, localSettings, sharedSettings);
    const { lockFileAgeMs, activeAgentState, activityTailLines } = this._readOperationalHealth(claudeDir);
    return {
      localSettings,
      sharedSettings,
      currentHookCommand,
      hookScriptExists,
      legacyArtifacts,
      lockFileAgeMs,
      activeAgentState,
      activityTailLines,
    };
  }

  private _diagnoseHooks(): { findings: DoctorFinding[]; foreign: string[] } {
    const root = this._projectRoot();
    if (root === "") {
      return { findings: [], foreign: [] };
    }
    const input = this._gatherDoctorInput(root);
    const findings = diagnose(input);
    const foreign = findForeignHooks(input.localSettings, input.sharedSettings);
    return { findings, foreign };
  }

  private _handleRunDoctor(): void {
    const root = this._projectRoot();
    if (root === "") {
      void this._panel.webview.postMessage({ type: MSG.DOCTOR_REPORT, findings: [], foreign: [], error: "No workspace folder open" });
      return;
    }
    const { findings, foreign } = this._diagnoseHooks();
    void this._panel.webview.postMessage({ type: MSG.DOCTOR_REPORT, findings, foreign });
  }

  /**
   * "Troubleshoot & Fix": first strips leftover foreign/legacy agent-hook
   * artifacts (stale lock, stuck stack, root-level state files, legacy hook
   * commands on our events — the same reset `cleanupForeignHookArtifacts`
   * performs at install time), then runs the existing settings repair
   * (missing/stale/duplicate/split slots, optional foreign-command removal),
   * then re-diagnoses from the now-fixed on-disk state.
   */
  private async _handleApplyDoctorFix(removeForeign: boolean): Promise<void> {
    try {
      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({ type: MSG.DOCTOR_FIX_DONE, ok: false, error: "No workspace folder open" });
        return;
      }
      const claudeDir = path.join(root, ".claude");
      const currentHookCommand = this._buildHookCommand();

      const cleanup = cleanupForeignHookArtifacts(claudeDir);

      const localSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.local.json"));
      const sharedSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.json"));
      const foreignCommands = findForeignHooks(localSettings, sharedSettings);
      if (removeForeign && foreignCommands.length > 0) {
        const answer = await vscode.window.showWarningMessage(
          "The following hook commands will be permanently removed:\n\n" + foreignCommands.join("\n"),
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }
      }
      const { settings, changes } = repairSettings(localSettings, currentHookCommand, { removeForeign, foreignCommands: removeForeign ? foreignCommands : undefined });
      fs.writeFileSync(path.join(claudeDir, "settings.local.json"), JSON.stringify(settings, null, 2));

      const input = this._gatherDoctorInput(root);
      const findings = diagnose(input);
      const foreign = findForeignHooks(input.localSettings, input.sharedSettings);
      void this._panel.webview.postMessage({
        type: MSG.DOCTOR_FIX_DONE,
        ok: true,
        changes: [...cleanup.changes, ...changes],
        findings,
        foreign,
      });
    } catch (err) {
      void this._panel.webview.postMessage({ type: MSG.DOCTOR_FIX_DONE, ok: false, error: String(err) });
    }
  }

  /**
   * "Generate diagnostic report": gather every health signal this panel
   * already computes elsewhere (hook health, delegation/review mode,
   * doctrine health, context budget, roster consistency, engine/UEFN
   * status), hand them to the PURE `buildDiagnosticReport` (diagnosticReport.ts)
   * which returns a sanitized Markdown string, then write/open/copy it.
   *
   * NO network, NO runtime AI — this only reads state already on disk or in
   * memory. The report itself is sanitized (absolute paths -> placeholders,
   * obvious secrets redacted) by `buildDiagnosticReport`'s final `sanitize`
   * pass; nothing here needs to scrub the Markdown a second time.
   */
  private async _handleGenerateDiagnostic(): Promise<void> {
    const root = this._projectRoot();
    if (root === "") {
      void vscode.window.showWarningMessage("TycoonAgents: No project root — open a folder first.");
      return;
    }
    try {
      const agentsDir = path.join(root, ".claude", "agents");

      // ---- environment -----------------------------------------------------
      let extensionVersion: string | null = null;
      try {
        const pkgRaw = fs.readFileSync(path.join(this._extensionUri.fsPath, "package.json"), "utf8");
        extensionVersion = JSON.parse(pkgRaw).version || null;
      } catch {
        extensionVersion = null;
      }
      const hostAppHost = (vscode.env as unknown as { appHost?: string }).appHost;

      // ---- hook health --------------------------------------------------
      let lastActivityAt: number | null = null;
      try {
        lastActivityAt = fs.statSync(path.join(root, ".claude", "tycoon", "activity.jsonl")).mtimeMs;
      } catch {
        lastActivityAt = null;
      }
      const { findings } = this._diagnoseHooks();
      const issueCount = findings.filter((f) => f.severity !== "ok").length;

      // ---- delegation + review -------------------------------------------
      const execCfg = readExecutionConfig(path.join(root, ".claude"));

      // ---- doctrine health (CLAUDE.md) ------------------------------------
      let foreignManagedBlocks: { namespace: string; lines: number }[] = [];
      let claudeMdContent: string | null = null;
      try {
        claudeMdContent = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
        foreignManagedBlocks = detectForeignManagedBlocks(claudeMdContent);
      } catch {
        claudeMdContent = null;
      }

      // ---- context budget ---------------------------------------------------
      let contextBudget;
      try {
        const agentEntries: Array<{ name: string; content: string }> = [];
        try {
          const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
          for (const fname of agentFiles) {
            try {
              agentEntries.push({ name: fname, content: fs.readFileSync(path.join(agentsDir, fname), "utf8") });
            } catch {
              /* skip unreadable */
            }
          }
        } catch {
          /* agentsDir missing => empty */
        }
        contextBudget = buildContextBudget(claudeMdContent, agentEntries);
      } catch {
        contextBudget = buildContextBudget(null, []);
      }

      // ---- roster consistency: dangling keyword refs / keyword-less agents --
      const rosterAgents = loadAgentRoster(agentsDir);
      const agentIds = rosterAgents.map((a) => a.id);
      const keywordsConfig = this._readKeywordsConfig(root);
      const keywordAgents: Record<string, any> =
        keywordsConfig && typeof keywordsConfig.agents === "object" && keywordsConfig.agents !== null
          ? keywordsConfig.agents
          : {};
      const keywordIds = Object.keys(keywordAgents);
      // Reuse the same pure reconcile logic `_ensureAgentKeywordsSeeded` writes
      // with, in preview (read-only) form, so the diagnostic's drift report can
      // never disagree with what a reconcile would actually do. `dropped` is
      // every phantom config key with no matching agent file (bullet a);
      // `added` is every agent file reconcile would give a fresh entry to,
      // using its BODY `## Keywords` (via parseAgentKeywords) when declared,
      // else DEFAULT_AGENT_KEYWORDS — this is what makes an empty json
      // pattern NOT automatically "keyword-less" when the body already has a
      // usable pattern pending its next auto-heal.
      const reconcileAgents = rosterAgents.map((a) => {
        let content = "";
        try {
          content = fs.readFileSync(path.join(agentsDir, `${a.id}.md`), "utf8");
        } catch {
          content = "";
        }
        return { id: a.id, keywords: parseAgentKeywords(content) };
      });
      const { dropped: danglingKeywordRefs, added: agentsPendingReconcile } = reconcileAgentKeywords(
        keywordsConfig,
        reconcileAgents
      );
      // Bullet (b): agent files with genuinely no way to route by keyword —
      // json pattern is empty/absent AND reconcile has nothing to fill it
      // with either (no body `## Keywords`, no known default).
      const agentsWithNoKeywords = agentIds.filter((id) => {
        const entry = keywordAgents[id];
        const pattern = entry && typeof entry.pattern === "string" ? entry.pattern.trim() : "";
        if (pattern !== "") return false;
        if (agentsPendingReconcile.includes(id)) return false; // reconcile would fix this
        return true;
      });

      // ---- engines / UEFN / MCP servers --------------------------------------
      const mcpConfig = this._readMcpConfig(path.join(root, ".mcp.json"));
      const engineChips = computeEngineChips(root, mcpConfig, (engineId) => this._engineProbeCache.get(engineId));
      const uefn = detectUefnProject(root);
      const bridgeSetUp = Boolean(this._uefnBridgeEntry(mcpConfig));
      const servers = (mcpConfig as any)?.mcpServers ?? mcpConfig;
      const mcpServerIds = servers && typeof servers === "object" ? Object.keys(servers) : [];

      const reportInput: DiagnosticReportInput = {
        timestamp: new Date().toISOString(),
        roots: { projectRoot: root, homeDir: os.homedir(), extensionDir: this._extensionUri.fsPath },
        extensionVersion,
        platform: process.platform,
        hostAppName: vscode.env.appName,
        hostAppHost,
        hook: { installed: this._hookInstalled(root), lastActivityAt },
        hookHealth: { healthy: issueCount === 0, issueCount },
        delegation: { mode: execCfg.delegation_mode, reviewEnabled: execCfg.reviewEnabled ?? true },
        doctrine: { foreignBlocks: foreignManagedBlocks },
        contextBudget,
        roster: { agentIds, keywordIds, danglingKeywordRefs, agentsWithNoKeywords, agentsPendingReconcile },
        engines: {
          chips: engineChips,
          uefn: { detected: uefn.detected, signals: uefn.signals, uefnInstalled: uefn.uefnInstalled, bridgeSetUp },
          mcpServerIds,
        },
      };

      const report = buildDiagnosticReport(reportInput);

      const filenameSafeTimestamp = reportInput.timestamp.replace(/[:.]/g, "-");
      const outDir = path.join(root, ".claude", "tycoon");
      const outPath = path.join(outDir, `diagnostic-report-${filenameSafeTimestamp}.md`);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, report, "utf8");

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
      await vscode.window.showTextDocument(doc, { preview: false });

      await vscode.env.clipboard.writeText(report);
      void vscode.window.showInformationMessage(
        "Diagnostic report generated + copied to clipboard — review it, then send it to the maintainer."
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`TycoonAgents: Could not generate diagnostic report: ${errorMessage(err)}`);
    }
  }

  /**
   * Kick off (or skip, if one is already in flight) a short HTTP probe for
   * `engineId`'s MCP url. Never throws or rejects outward — the poll loop
   * only ever reads the cached result via `_engineProbeCache`. Any response
   * (even 4xx/5xx) counts as "connected"; a network error or the ~1s
   * AbortController timeout counts as "offline".
   */
  private _kickEngineProbe(engineId: string, url: string): void {
    if (this._engineProbeInFlight.has(engineId)) {
      return;
    }
    this._engineProbeInFlight.add(engineId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    fetch(url, { signal: controller.signal })
      .then(() => {
        this._engineProbeCache.set(engineId, true);
      })
      .catch(() => {
        this._engineProbeCache.set(engineId, false);
      })
      .finally(() => {
        clearTimeout(timer);
        this._engineProbeInFlight.delete(engineId);
      });
  }

  /**
   * Compute status chips for every relevant game engine: the live UEFN
   * heartbeat chip (unchanged special case) plus the union of project
   * detection, pack-install detection, and `.mcp.json` entries for Godot,
   * Unity, Unreal, Roblox, and Blender (see engineDetect.ts). Returns [] if
   * no engines are relevant, so the webview shows nothing.
   */
  private _computeEngineStatus(): EngineChip[] {
    const root = this._projectRoot();
    if (root === "") {
      return [];
    }
    const mcpPath = path.join(root, ".mcp.json");
    let mcpConfig: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        mcpConfig = parsed as Record<string, unknown>;
      }
    } catch {
      mcpConfig = {};
    }

    // Kick off (cheap, guarded) probes for any HTTP-based engine MCP entry
    // before reading the cache, so results converge within a couple of polls.
    for (const engineId of ["godot", "unity", "unreal", "roblox", "blender"]) {
      const entry = mcpEntryForEngine(mcpConfig, engineId);
      if (entry?.isHttp && entry.url) {
        this._kickEngineProbe(engineId, entry.url);
      }
    }
    const otherChips = computeEngineChips(root, mcpConfig, (engineId) => this._engineProbeCache.get(engineId));

    const bridgeEntry = this._uefnBridgeEntry(mcpConfig);
    if (!bridgeEntry) {
      return otherChips;
    }

    // Resolve the bridge directory from env config or default temp location.
    let bridgeDir: string;
    try {
      const envBlock = bridgeEntry["env"] as Record<string, unknown> | undefined;
      const configured = envBlock?.["UEFN_BRIDGE_DIR"];
      bridgeDir =
        typeof configured === "string" && configured !== ""
          ? configured
          : path.join(os.tmpdir(), "uefn_bridge");
    } catch {
      bridgeDir = path.join(os.tmpdir(), "uefn_bridge");
    }

    let chipState: "connected" | "offline" = "offline";
    let detail =
      "UEFN bridge installed. Reopen your UEFN project in the editor to activate it - it starts automatically on project load. Enable the Python Editor Script Plugin if prompted.";
    try {
      const heartbeatPath = path.join(bridgeDir, "heartbeat.json");
      const stat = fs.statSync(heartbeatPath);
      if (Date.now() - stat.mtimeMs < 15000) {
        chipState = "connected";
        detail = "UEFN bridge connected - agents can use the uefn_* MCP tools.";
      }
    } catch {
      /* file missing or unreadable => offline */
    }

    return [{ id: "uefn", label: "UEFN", state: chipState, detail }, ...otherChips];
  }

  /** Poll engine status and push a `engineStatus` message to the webview. */
  private _pollEngineStatus(): void {
    const chips = this._computeEngineStatus();
    void this._panel.webview.postMessage({ type: MSG.ENGINE_STATUS, chips });
  }

  /**
   * Compute current Project Plan state (enabled flag + parsed plan, same
   * rules as the opt-in gate everywhere else in this feature) and post it
   * to the webview as PLAN_STATE. Shared by the REQUEST_PLAN handler (fires
   * once at webview boot) and the plan file watcher (fires on every
   * subsequent on-disk change), so both paths compute state identically.
   *
   * 0.0.340+: also auto-archives a snapshot when the plan is complete AND
   * fully approved (see `archivePlanIfComplete` — idempotent, keyed by a
   * content fingerprint so re-posting the same completed plan never creates
   * duplicate archive files), then reads back every archived plan summary
   * so the webview can render an "Archived Plans" section. Because this
   * archiving happens INSIDE _postPlanState, the plan.json write that makes
   * a plan complete-approved is picked up automatically via
   * `_setupPlanWatcher`'s existing debounced repost — no separate watcher
   * on plans/ is needed.
   *
   * Bug fix: this used to call the throwing `readPlan` with no try/catch, so
   * a corrupted plan.json (e.g. a dropped `},{` boundary between two task
   * objects — invalid JSON) threw UNCAUGHT here and the webview never
   * received a fresh PLAN_STATE, leaving it rendering stale state
   * indefinitely (a finished task frozen "active" forever). This now reads
   * via `readPlanSafe`, which never throws:
   *  - "ok": post `plan` as before, AND copy plan.json -> plan.json.bak as a
   *    last-known-good backup (best-effort, only on a good read).
   *  - "missing": post `plan: null`, `planReadable: true` — the normal
   *    no-plan-yet state, not corruption.
   *  - "corrupt": post `plan: null`, `planReadable: false`, `planError`, and
   *    `hasBackup` so the webview can offer a restore (see
   *    MSG.RESTORE_PLAN_BACKUP). plan.json itself is left untouched.
   * The whole body is wrapped so a filesystem hiccup anywhere in here can
   * never crash the panel.
   */
  private _postPlanState(): void {
    try {
      const root = this._projectRoot();
      if (root === "" || !readProjectPlanEnabled(root)) {
        void this._panel.webview.postMessage({
          type: MSG.PLAN_STATE,
          enabled: false,
          plan: null,
          archivedPlans: [],
          planReadable: true,
          hasBackup: false,
        });
        return;
      }

      const planPath = projectPlanFilePath(root);
      const backupPath = projectPlanBackupFilePath(root);
      const result = readPlanSafe(planPath);

      if (result.status === "ok") {
        archivePlanIfComplete(root, result.plan);
        try {
          fs.copyFileSync(planPath, backupPath);
        } catch (err) {
          console.warn("TycoonAgents: failed to write plan.json.bak backup:", err);
        }
        const archivedPlans = readArchivedPlans(root);
        void this._panel.webview.postMessage({
          type: MSG.PLAN_STATE,
          enabled: true,
          plan: result.plan,
          archivedPlans,
          planReadable: true,
          hasBackup: fs.existsSync(backupPath),
        });
        return;
      }

      if (result.status === "corrupt") {
        console.warn("TycoonAgents: plan.json is corrupt, leaving it untouched:", result.error);
      }
      const archivedPlans = readArchivedPlans(root);
      void this._panel.webview.postMessage({
        type: MSG.PLAN_STATE,
        enabled: true,
        plan: null,
        archivedPlans,
        planReadable: result.status !== "corrupt",
        ...(result.status === "corrupt" ? { planError: result.error } : {}),
        hasBackup: fs.existsSync(backupPath),
      });
    } catch (err) {
      console.error("TycoonAgents: _postPlanState failed unexpectedly:", err);
    }
  }

  /**
   * Watch `.claude/tycoon/plan.json` and `.claude/tycoon/execution.json`
   * (the `projectPlanEnabled` flag lives there) so the Project Plan section
   * stays LIVE without requiring the panel to be reloaded. The project-plan
   * skill rewrites plan.json continuously while executing; before this, the
   * webview only ever requested plan state once at boot (MSG.REQUEST_PLAN),
   * so any write after that point was invisible until reload.
   *
   * No-ops when there's no workspace root to scope a RelativePattern to —
   * `_postPlanState` already resolves that case to enabled:false/null, and
   * re-resolving root on every future workspace-folder change is out of
   * scope for this fix (matches the rest of the Project Plan feature, which
   * also snapshots root per-call rather than tracking folder changes).
   */
  private _setupPlanWatcher(): void {
    const root = this._projectRoot();
    if (root === "") return;

    const pattern = new vscode.RelativePattern(root, ".claude/tycoon/{plan,execution}.json");
    this._planWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    // The skill can rewrite plan.json many times in quick succession during
    // execution (per-task-completion writes); debounce to one PLAN_STATE
    // post per burst instead of spamming the webview.
    const scheduleRepost = (): void => {
      if (this._planWatcherDebounce !== undefined) clearTimeout(this._planWatcherDebounce);
      this._planWatcherDebounce = setTimeout(() => {
        this._planWatcherDebounce = undefined;
        this._postPlanState();
      }, 150);
    };

    this._planWatcher.onDidChange(scheduleRepost, null, this._disposables);
    this._planWatcher.onDidCreate(scheduleRepost, null, this._disposables);
    // Deletion (e.g. plan.json removed) should also resolve cleanly back to
    // the empty state rather than leaving the webview showing stale data;
    // _postPlanState already reads via readPlanSafe, which resolves a
    // missing file to {status:"missing"} (plan: null), so this reuses the
    // same path.
    this._planWatcher.onDidDelete(scheduleRepost, null, this._disposables);
    this._disposables.push(this._planWatcher);
  }

  public dispose(): void {
    TycoonPanel.currentPanel = undefined;
    this._themeGenerationAbortController?.abort();
    this._themeGenerationAbortController = undefined;
    if (this._enginePollInterval !== undefined) {
      clearInterval(this._enginePollInterval);
      this._enginePollInterval = undefined;
    }
    if (this._planWatcherDebounce !== undefined) {
      clearTimeout(this._planWatcherDebounce);
      this._planWatcherDebounce = undefined;
    }
    this._runtimeDisposable?.dispose();
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  private _update(): void {
    const webview = this._panel.webview;
    this._panel.title = "TycoonAgents";
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    let version = "";
    try {
      const pkgRaw = fs.readFileSync(
        path.join(this._extensionUri.fsPath, "package.json"),
        "utf8"
      );
      version = JSON.parse(pkgRaw).version || "";
    } catch {
      /* version stays empty if package.json can't be read */
    }

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "style.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" nonce="${nonce}" />
  <title>TycoonAgents</title>
</head>
<body>
  <!-- Boot loader: full-viewport overlay painted as part of the INITIAL HTML
       (styled by media/style.css, which is a render-blocking <link> above)
       so it is on screen before media/main.js has even parsed, let alone
       before the theme payload/art arrives. media/main.js drives its
       progress/visibility off real boot milestones; see the "Boot loader
       overlay" block near the top of that file. Sits above #app but below
       #setup-view so the onboarding/install card always wins if it needs
       to show (see showSetup()). -->
  <div id="boot-loader" role="status" aria-live="polite">
    <div class="boot-loader-glow" aria-hidden="true"></div>
    <div class="boot-loader-inner">
      <div class="boot-loader-title">TycoonAgents</div>
      <div class="boot-loader-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="boot-loader-track">
        <div id="boot-loader-fill" class="boot-loader-fill"></div>
      </div>
      <div id="boot-loader-label" class="boot-loader-label">Starting&hellip;</div>
    </div>
  </div>

  <!-- Canvas kept in DOM so existing render loop does not crash; hidden via CSS -->
  <canvas id="stage"></canvas>

  <!-- App shell: stage on top, resize handle, metrics panel on bottom -->
  <div id="app">

    <!-- Stage area: placeholder for future characters / background -->
    <div id="stage-area">
      <!-- Hamburger menu: scaffold for future panel controls -->
      <button id="menu-btn" aria-label="Open menu" aria-expanded="false" aria-haspopup="true">&#9776;</button>
      <div id="menu-popover" role="menu" hidden>
        <button class="menu-item" role="menuitem" id="menu-catalog">Skills / MCP / Packs</button>
        <button class="menu-item" role="menuitem" id="menu-settings">Settings</button>
        <button class="menu-item" role="menuitem" id="menu-themes">Themes</button>
        <button class="menu-item" role="menuitem" id="menu-about">About</button>
        ${version ? `<div class="menu-version" role="presentation">v${version}</div>` : ""}
      </div>
      <!-- Badge HUD: lower-right gold medallion, shown/updated by media/main.js -->
      <button id="badge-hud-btn" class="badge-hud" hidden aria-label="Badges" title="Badges — click to view your unlocked badges">
        <svg class="badge-hud-svg" viewBox="0 0 52 52" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="badgeHudGoldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#fff2c2" />
              <stop offset="40%" stop-color="#ffb020" />
              <stop offset="100%" stop-color="#8a4d06" />
            </linearGradient>
            <linearGradient id="badgeHudRibbonGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#7a1c26" />
              <stop offset="100%" stop-color="#4a1017" />
            </linearGradient>
            <clipPath id="badgeHudDiscClip">
              <circle cx="26" cy="21" r="17" />
            </clipPath>
          </defs>
          <path class="badge-hud-ribbon" d="M19 23 L13 50 L26 41 L39 50 L33 23 Z" fill="url(#badgeHudRibbonGrad)" stroke="#141418" stroke-width="1.5" stroke-linejoin="round" />
          <circle class="badge-hud-disc" cx="26" cy="21" r="17" fill="url(#badgeHudGoldGrad)" stroke="#141418" stroke-width="2.5" />
          <circle class="badge-hud-disc-rim" cx="26" cy="21" r="12.5" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1" />
          <g clip-path="url(#badgeHudDiscClip)">
            <path class="badge-hud-shine" d="M12 15 A17 17 0 0 1 34 7 L26 21 Z" fill="rgba(255,255,255,0.4)" />
          </g>
        </svg>
        <span class="badge-hud-count">0</span>
        <span class="badge-hud-dot" aria-hidden="true"></span>
      </button>
    </div>

    <!-- Resize handle: drag to split stage vs metrics panel -->
    <div id="resize-handle" role="separator" aria-label="Drag to resize panels">
      <span class="resize-grip"></span>
    </div>

    <!-- Metrics panel -->
    <div id="metrics-panel">
      <div id="metrics-header">
        <span class="header-dot"></span>
        <span class="header-title">Tycoon Agents &mdash; Agent Metrics</span>
      </div>
      <!-- Tab bar: switches between Metrics and the optional Project Plan
           view. Hidden entirely unless PLAN_STATE reports enabled:true (see
           updateMetricsTabsUI() in media/main.js) so nothing new shows for
           projects that haven't opted in. -->
      <div id="metrics-tabs" class="metrics-tabs" role="tablist" hidden>
        <button id="metrics-tab-btn" class="metrics-tab-btn" type="button" role="tab" aria-selected="true" aria-controls="metrics-body">Metrics</button>
        <button id="plan-tab-btn" class="metrics-tab-btn" type="button" role="tab" aria-selected="false" aria-controls="project-plan-body">Project Plan</button>
      </div>
      <div id="metrics-body">
        <div id="metrics-empty">No agents yet &mdash; start a session to see activity.</div>
        <table id="metrics-table" style="display:none">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Tokens/min</th>
              <th class="col-tasks">Tasks</th>
              <th class="col-mcp">MCP</th>
              <th class="col-time">Time</th>
              <th class="col-tokens">Tokens</th>
            </tr>
          </thead>
          <tbody id="metrics-tbody"></tbody>
        </table>
        <!-- Delegation stats (Team Lead Mode Phase 4: measurement) — populated
             by renderDelegationStats() in media/main.js from state.modeStats.
             Hidden by default; shown only when at least one mode has data. -->
        <div id="delegation-stats" hidden></div>
      </div>
      <!-- Project Plan (optional feature, opt-in via Settings): tab content
           hosted next to Metrics inside the same panel. Hidden unless
           PLAN_STATE reports enabled:true; rebuilt by
           renderProjectPlanSection() in media/main.js. -->
      <div id="project-plan-body" class="project-plan-body" hidden></div>
    </div>

  </div><!-- /#app -->

  <!-- Setup / onboarding overlay (styled + toggled by media/main.js) -->
  <div id="setup-view">
    <div id="setup-card">
      <h1>TycoonAgents</h1>
      <p id="setup-status">Checking installation&hellip;</p>
      <p id="setup-error" hidden></p>
      <!-- Pre-install delegation chooser: hidden by default; main.js reveals
           it ONLY when checkInstall reports hooks not installed. Installed
           projects use the "Delegation style" section renderSettings() builds
           inside #setup-config instead — never both at once. -->
      <div id="delegation-mode-group" class="delegation-mode-group" hidden>
        <div class="delegation-mode-title">Delegation style</div>
        <label class="delegation-mode-option">
          <input type="radio" name="delegation-mode" id="delegation-mode-flat" value="flat" checked>
          <span class="delegation-mode-option-body">
            <span class="delegation-mode-option-label">Direct (recommended for most projects)</span>
            <span class="delegation-mode-option-help">The orchestrator briefs specialist workers directly &mdash; it does the reviewing itself. Lowest coordination cost; best for focused fixes.</span>
          </span>
        </label>
        <label class="delegation-mode-option">
          <input type="radio" name="delegation-mode" id="delegation-mode-team-leads" value="team_leads">
          <span class="delegation-mode-option-body">
            <span class="delegation-mode-option-label">Team Leads</span>
            <span class="delegation-mode-option-help">Adds persistent lead agents that manage domain teams (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a coordination hop. Pays off on large builds from design docs &mdash; many features across many files &mdash; where it reduces orchestrator context churn, re-briefing, and mid-build context loss. If you mostly do focused fixes, stay Direct.</span>
          </span>
        </label>
        <label class="delegation-mode-option review-pass-option">
          <input type="checkbox" id="review-pass-checkbox" checked>
          <span class="delegation-mode-option-body">
            <span class="delegation-mode-option-label">Review pass (optional, on by default)</span>
            <span class="delegation-mode-option-help">Routes each significant change through a reviewer agent before it's marked done. Catches bugs and regressions early; roughly 20-40% more tokens on non-trivial tasks. Turn off for speed/lowest cost.</span>
          </span>
        </label>
        <p class="delegation-mode-footnote">You can change this anytime in Settings. Switching updates this project's agent roster and delegation instructions.</p>
      </div>
      <button id="install-hooks-btn" hidden>Install hooks</button>
      <div id="setup-config" hidden><!-- Phase 2: agent model settings --></div>
      <button id="setup-back-btn" hidden>Back</button>
    </div>
  </div>

  <!-- Skills modal overlay -->
  <div id="skills-modal" role="dialog" aria-modal="true" aria-label="Catalog" hidden>
    <div id="skills-backdrop"></div>
    <div id="skills-dialog">
      <button id="skills-modal-close" aria-label="Close dialog">&times;</button>
      <div class="catalog-tabs" role="tablist">
        <button id="tab-packs" class="catalog-tab" role="tab" aria-selected="false">Packs</button>
        <button id="tab-skills" class="catalog-tab catalog-tab--active" role="tab" aria-selected="true">Skills</button>
        <button id="tab-mcp" class="catalog-tab" role="tab" aria-selected="false">MCP servers</button>
      </div>
      <div id="packs-list" role="tabpanel" hidden></div>
      <div id="skills-list" role="tabpanel"></div>
      <div id="skills-footer">
        <a id="skills-more-link" href="https://github.com/anthropics/skills" target="_blank" rel="noopener noreferrer">Get more skills &rarr; Claude Agent Skills marketplace</a>
      </div>
      <div id="mcp-list" role="tabpanel" hidden></div>
    </div>
  </div>

  <!-- About modal overlay -->
  <div id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title" hidden>
    <div id="about-backdrop"></div>
    <div id="about-dialog">
      <button id="modal-close" aria-label="Close dialog">&times;</button>
      <h2 id="about-modal-title">TycoonAgents</h2>
      <p>Created by Scott McClellan</p>
      <p>
        <a href="https://x.com/thetrashbyrd" target="_blank" rel="noopener noreferrer">@thetrashbyrd</a>
      </p>
      <p>
        <a href="https://github.com/Corsair-Studios/TycoonAgents" target="_blank" rel="noopener noreferrer">GitHub repository</a>
      </p>
    </div>
  </div>

  <!-- Badge modal overlay: lists all of the current theme's badges -->
  <div id="badge-modal" role="dialog" aria-modal="true" aria-labelledby="badge-modal-title" hidden>
    <div id="badge-backdrop"></div>
    <div id="badge-dialog">
      <button id="badge-modal-close" aria-label="Close dialog">&times;</button>
      <h2 id="badge-modal-title">Badges</h2>
      <div id="badge-list"></div>
    </div>
  </div>

  <!-- Themes modal overlay -->
  <div id="themes-modal" role="dialog" aria-modal="true" aria-label="Themes" hidden>
    <div id="themes-backdrop"></div>
    <div id="themes-dialog">
      <button id="themes-modal-close" aria-label="Close dialog">&times;</button>
      <div id="themes-scroll">
      <div id="theme-picker-list" role="tabpanel">
        <section id="theme-library-section" class="theme-library-section">
          <h2 style="margin: 0 0 16px;">Themes</h2>
          <div id="theme-picker-grid" style="display: flex; flex-direction: column; gap: 8px;"></div>
          <div id="theme-picker-status" class="theme-picker-status" role="status" aria-live="polite"></div>
          <div class="theme-picker-actions">
            <button id="theme-import-btn" class="skill-btn">Import .zip</button>
            <button id="tab-theme-builder" class="skill-btn theme-builder-launch">Theme Builder</button>
          </div>
          <p class="theme-library-caption">Add a theme &mdash; build one with AI or import a shared .zip.</p>
        </section>
        <section id="theme-selected-section" class="theme-selected-section" hidden>
          <h3 id="theme-selected-heading" class="theme-selected-heading">Selected theme</h3>
          <div id="theme-selected-roster"></div>
        </section>
      </div>
      <div id="theme-builder-panel" role="tabpanel" hidden>
        <button id="tab-theme-picker" class="skill-btn" style="margin-bottom: 16px;">&larr; Back to themes</button>
        <div id="theme-image-settings" class="theme-image-settings">
          <div class="theme-image-settings-heading">Image generation</div>
          <div class="theme-image-settings-row">
            <label for="theme-image-provider">Image provider</label>
            <select id="theme-image-provider">
              <option value="openai">OpenAI (GPT Image 2)</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>
          <div class="theme-image-settings-row theme-api-key-row">
            <label for="theme-api-key-input" id="theme-api-key-label">Google Gemini API key</label>
            <input
              type="password"
              id="theme-api-key-input"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste a key to save securely"
            />
            <button id="theme-api-key-save" class="skill-btn theme-api-key-save-btn">Save</button>
          </div>
          <div id="theme-api-key-status" class="theme-api-key-status" role="status"></div>
        </div>
        <label class="theme-generation-approval-toggle theme-generation-approval-toggle--top" for="theme-pause-for-review">
          <input id="theme-pause-for-review" type="checkbox" checked />
          <span>
            Pause after each image for approval
            <small>Change this any time. Turning it off resumes a paused generation.</small>
          </span>
        </label>
        <p class="theme-generation-approval-warning" style="margin: 6px 0 0; padding: 8px 10px; border-left: 3px solid #d9a441; background: rgba(217, 164, 65, 0.12); border-radius: 4px; font-size: 12px; line-height: 1.4;">
          &#9888; AI image generation isn't perfect &mdash; expect to regenerate some images and do a little manual cleanup (use Retry, Upload, or edit the prompt).
        </p>
        <div id="theme-prompt-container" class="theme-prompt-container">
          <input type="text" id="theme-prompt-input" placeholder="Name or describe a new theme" />
          <button id="theme-generate-btn" class="skill-btn">Plan theme</button>
        </div>
        <section id="theme-plan-editor" class="theme-plan-editor" hidden>
          <div class="theme-plan-header">
            <div>
              <h3>Review the theme plan</h3>
              <p>AI filled every slot. Edit anything you want before image generation begins.</p>
            </div>
            <span class="theme-plan-count">25 reviewable images</span>
          </div>
          <label class="theme-plan-field theme-plan-field--primary">
            <span>Theme name</span>
            <input id="theme-plan-name" type="text" />
          </label>
          <label class="theme-plan-field">
            <span>Creative direction</span>
            <textarea id="theme-plan-direction" rows="3"></textarea>
          </label>
          <fieldset class="theme-plan-group">
            <legend>Characters <span>16 individual sprite boards</span></legend>
            <div id="theme-plan-characters" class="theme-plan-slot-grid theme-plan-slot-grid--characters"></div>
          </fieldset>
          <label class="theme-plan-field">
            <span>Environment <small>1 image</small></span>
            <textarea id="theme-plan-environment" rows="3"></textarea>
          </label>
          <fieldset class="theme-plan-group">
            <legend>Enemies <span>4 individual enemy rows &middot; 1 sprite board</span></legend>
            <div id="theme-plan-enemies" class="theme-plan-slot-grid"></div>
          </fieldset>
          <label class="theme-plan-field">
            <span>Objects <small>21 objects, comma separated · 2 sprite sheets</small></span>
            <textarea id="theme-plan-objects" rows="3"></textarea>
          </label>
          <label class="theme-plan-field">
            <span>Expressions <small>7 expressions, comma separated · 1 sprite sheet</small></span>
            <textarea id="theme-plan-expressions" rows="3"></textarea>
          </label>
          <label class="theme-plan-field">
            <span>Achievement badges <small>25 designs, comma separated · 1 sprite sheet</small></span>
            <textarea id="theme-plan-achievements" rows="3"></textarea>
          </label>
          <div class="theme-plan-footer">
            <div id="theme-plan-validation" class="theme-plan-validation" role="status"></div>
            <button id="theme-start-generation-btn" class="skill-btn">Generate images</button>
          </div>
        </section>
        <div id="theme-build-status" style="margin-bottom: 12px; font-style: italic; min-height: 20px; color: var(--vscode-descriptionForeground);"></div>
        <div id="theme-build-actions" hidden style="margin-bottom: 12px;">
          <button id="theme-review-images-btn" class="skill-btn">Review generated images</button>
        </div>
        <section id="theme-image-review" class="theme-image-review" hidden>
          <div class="theme-image-review-header">
            <div>
              <h3 id="theme-image-review-title">Generated images</h3>
              <div id="theme-image-review-summary" class="theme-image-review-summary"></div>
            </div>
            <div class="theme-image-review-header-actions">
              <button id="theme-review-resume-generation" class="skill-btn" hidden>Resume generation</button>
              <button id="theme-review-stop-generation" class="skill-btn" hidden>Stop generation</button>
              <button id="theme-approve-all" class="skill-btn">Approve all</button>
              <button id="theme-open-images-folder" class="skill-btn">Open folder</button>
              <button id="theme-health-check-btn" class="skill-btn">Check theme health</button>
            </div>
          </div>
          <div id="theme-health-results" class="theme-health-results" hidden></div>
          <div id="theme-image-review-list" class="theme-image-review-list"></div>
        </section>
        <div id="theme-builder-root"></div>
      </div>
      </div>
      <div id="themes-footer">
        <button id="themes-footer-close" class="skill-btn theme-footer-close">Close</button>
      </div>
    </div>
  </div>

  <div id="theme-image-lightbox" role="dialog" aria-modal="true" aria-labelledby="theme-image-lightbox-title" hidden>
    <div id="theme-image-lightbox-backdrop"></div>
    <div id="theme-image-lightbox-dialog">
      <div class="theme-image-lightbox-header">
        <h3 id="theme-image-lightbox-title">Full-size image</h3>
        <button id="theme-image-lightbox-close" aria-label="Close full-size image">&times;</button>
      </div>
      <div class="theme-image-lightbox-viewport">
        <img id="theme-image-lightbox-image" alt="" />
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'theme-builder.js'))}"></script>
</body>
</html>`;
  }
}
