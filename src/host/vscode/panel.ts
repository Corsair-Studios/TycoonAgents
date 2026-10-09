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
import { waitForBundledThemes } from "./themeReady";
import { log } from "./log";
import { openExternalUrl } from "./openExternalUrl";
import { computeDelegationModeStats, applyEvent, initialWorldState, codexSandboxWarning } from "../../core/state";
import type { MetricsWorldState, AgentMetric } from "../../core/state";
import type { HookRecord } from "../../providers/claude-code/hookRecord";
import { mapHookRecord } from "../../providers/claude-code";
// Ensures every provider's mapper (claude-code, opencode) is registered into
// mappingRegistry regardless of which provider this host is configured to
// run, since activity.jsonl can carry records from more than one provider.
import "../../providers/registerAllMappers";
import {
  shortFromModelId,
  modelIdFromShort,
  setFrontmatterModel,
  setKeywordPattern,
  removeKeywordPattern,
  isSafeAgentId,
} from "./agentConfig";
import { loadAgentRoster } from "../../providers/claude-code/agentRoster";
import { mergeMcpServer, hasMcpServer, removeMcpServer, resolveConfigForPlatform, withDispatcherProjectDir, type McpPlatformsEntry } from "./mcpCatalog";
import { discoverCodexBinary, CodexDiscoveryError } from "../../providers/codex/codexDiscovery";
import {
  installCodexHooks,
  uninstallCodexHooks,
  resolveCodexHome,
  detectCodexNotifyState,
  codexHookStatus,
  CODEX_HOOK_STATUS_LABELS,
  type CodexHookStatus,
  CODEX_NOTIFY_BLOCKED_MESSAGE,
  CODEX_NOTIFY_STALE_MESSAGE,
  type CodexNotifyState,
} from "../../providers/codex/installCodexHooks";
import { resolveNodeBinary } from "../../providers/codex/resolveNodeBinary";
import { installCodexDispatcher, uninstallCodexDispatcher, isDispatcherMarkerInConfigToml, readCodexDispatcherState, CODEX_DISPATCHER_STALE_MESSAGE } from "../../providers/codex/installCodexDispatcher";
import { catalogSummary } from "../../shared/catalogSummary";
import { buildAgentMarkdown, agentMarkdownTier, agentMarkdownHasTycoonMarker, workerAgentFingerprintMatches, resyncAgentRoleSection, resyncAgentDisciplineSection, resyncAgentFrontmatterFields, healForeignWrapperModel, FOREIGN_LLM_AGENTS, LEAD_AGENTS, REVIEWER_AGENTS, workerAgentsForProject, UEFN_CONFLICT_AGENT_IDS, conflictingUefnAgents, type PackAgent } from "./packCatalog";
import {
  seedMissingAgentKeywords,
  parseAgentKeywords,
  reconcileAgentKeywords,
  migrateSupersededKeywords,
} from "./agentKeywordDefaults";
import { computeKeywordHealth, normalizeAgentKeywords, computeWildcardStats } from "../../core/keywordHealth";
import {
  renderDelegationDoctrine,
  upsertDelegationSection,
  readExecutionConfig,
  writeExecutionConfig,
  formatVendorModelLabel,
  type DelegationMode,
  type DoctrineRosterAgent,
} from "./delegationDoctrine";
import { readAgentFrontmatter, parseAgentBackend } from "../../core/agentBackend";
import {
  describeProviderSelection,
  writeProviderSelection,
  writeUseMultipleLlms,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderSelectionDescription,
} from "../../core/providerSelection";
import { readClaudeSubscriptionOptIn, shouldSkipPackAgentForClaudeSubscription, claudeSubscriptionBlockedMessage } from "../../core/claudeSubscriptionBridge";
import { runVendorKeyTest, runCustomEndpointTest, cancelAllVendorKeyTests, type VendorKeyTestResult } from "../../core/vendorKeyTest";
import { setGeminiBackend } from "../../core/hostBridgeSettings";
import { buildRoutingView, saveRoutingProfile, clearRoutingProfile, probeEnv, setLocalEnvValue, clearLocalEnvValue, setClaudeSubscriptionOptIn, computeNeedsDefaultRoute, runCodexConfigGenerator } from "../../core/routingHostOps";
import { resolveAgentsUiMode, singleProviderTiers } from "../../core/agentsUiMode";
import { describeAgentRoutes, describeRoutingVisibility, overrideAgentToClaudeTier, clearAgentRoute, type RoutingVisibility, type ClaudeTier } from "../../core/agentSettingsRoute";
import { REFERRAL_CODE_PATTERN } from "../../core/themeServiceClient";
import { exportTeamSetup, applyTeamSetupHost, buildTeamReadinessHost, getTeamSetupDriftHost } from "./teamSetupHost";
import { renderCodeRules, upsertCodeRulesSection } from "./codeRulesDoctrine";
import { detectForeignManagedBlocks, stripManagedBlock } from "./legacyDoctrine";
import { detectUefnProject } from "./uefnDetect";
import { describeFsError } from "./fsErrors";
import { createThemeServiceHost, type ThemeServiceHost, type ThemeServiceHostStatus } from "./themeServiceHost";
import { createVsCodeThemeServiceDeviceState } from "./themeServiceDeviceState";
import { createVsCodeThemeServiceCreditsCache } from "./themeServiceCreditsCache";
import {
  probePathHealth,
  detectVerseExtensionState,
  writeUefnPathOverride,
  buildPathDiagnosticText,
  isPathOverrideKey,
} from "./pathHealth";
import { buildContextBudget } from "./contextBudget";
import { computeEngineChips, mcpEntryForEngine, type EngineChip } from "./engineDetect";
import { nativeWindowsUserDataPath } from "./revealUri";
import {
  approveAllThemeImages,
  boardBackgroundModeForProvider,
  buildReplacementPrompt,
  createServiceImageGenerator,
  deleteTheme,
  ensureThemeReviewImages,
  exportThemeArchive,
  getThemeImageReview,
  importThemeArchive,
  isThemeGenerationServiceError,
  listThemes,
  acceptedFrameKeysForHealthCheck,
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
  setThemeObjectTurret,
  replaceThemeBackground,
  resliceThemeImageFromRaw,
  retryThemeImage,
  resumeThemeGeneration,
  saveThemePlan,
  saveThemeTuning,
  setThemeAttemptCostResolver,
  setThemeImageGenerator,
  setThemePromptMismatchNotifier,
  updateThemeCreativeDirection,
  regenerateThemeDescriptions,
  updateThemeImageReviewStatus,
  updateThemeItemDescriptionsBatch,
  upgradeInstalledThemes,
  uploadThemeImage,
  generateTheme as generateThemeService,
  themeBoardCountsFromFrames,
  getThemeBoardCounts,
  setThemeGenerationStatus,
} from "../../extension/themeService";
import { sanitizeRetryNotes } from "../../extension/themeImageRetry";
import { isTransientThemeImageReviewErrorKind } from "../../extension/themeImageReviewState";
import { THEME_SERVICE_HOST_SESSION_ID } from "../../extension/themeServiceHostSession";
import type { ThemeImageRetryMode } from "../../extension/themeImageRetry";
import { themePlanCreativeDirection, themeDescriptionsStale } from "../../extension/themePlan";
import type { ThemePlan } from "../../extension/themePlan";
import type {
  BoardKind,
  ThemeImageReviewWaitOptions,
  ThemeItemDescriptionChange,
  ThemeItemNameChange,
} from "../../extension/themeService";
import type { ThemeManifest } from "../../shared/types";
import { themeImagesDirectoryUri, themeRawImagesDirectoryUri } from "../../extension/themeStorage";
import { configureThemeFileStore } from "../../extension/themeFileStore";
import { createVscodeThemeFileStore } from "../../extension/themeFileStoreVscode";
import { validateThemeIntegrity } from "../../extension/themeHealth";
// Every direct-provider theme-image-settings helper (provider/model/quality
// getters+setters, the API-key resolver, the module that held them) is
// removed (p43-t1 retired the direct-provider image settings UI; p43-t7
// finished the job — PLAN_THEME and REGENERATE_THEME_DESCRIPTIONS now route
// their TEXT calls through the Theme Service's POST /api/plan via
// translator.ts's ThemePlanRequester seam, same as image generation — see
// docs/theme-service-api.md's "Plan / description generation" section).
import { createServicePlanRequester, setThemePlanRequester, isThemePlanServiceError } from "../../extension/translator";
import { MSG, MSG_SCHEMAS } from "./messages";
import {
  readPlanSafe,
  writePlan,
  approvePhase,
  overrideTask,
  archivePlanIfComplete,
  readArchivedPlans,
  projectPlanBackupFilePath,
  writePlanBackup,
  writePreRestoreSnapshot,
  appendGateEvent,
} from "./projectPlan";
import { buildDiagnosticReport, type DiagnosticReportInput, type SanitizeRoots } from "./diagnosticReport";
import {
  buildFeedbackPayload,
  buildFeedbackContext,
  postFeedback,
  FEEDBACK_ENDPOINT,
  FALLBACK_FORM_URL,
  type FeedbackFetch,
} from "./feedbackSubmit";

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

/**
 * p68-t1 review fix: write `content` atomically — a temp file in the SAME
 * directory (so the rename is same-filesystem, never cross-device) followed
 * by `fs.renameSync` over `filePath`. Avoids a reader (e.g. a concurrent
 * panel/standalone read of agent-keywords.json) ever observing a
 * partially-written file. Caller is responsible for any `.bak` backup
 * first; this only makes the final write itself atomic.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

/**
 * p66-t1 review fix: a thrown openExternal/handler error's `.message` can
 * echo the Google sign-in URL it was given (which carries a PKCE
 * code_challenge) — never logged or posted verbatim on the openExternal
 * paths. Only a fixed message plus the error's constructor name.
 */
function scrubOpenExternalError(error: unknown): string {
  const ctor = error instanceof Error ? error.constructor.name : typeof error;
  return `couldn't open the browser for sign-in (${ctor})`;
}

// p67-t1: the webview's postThemeService() posts a flat message
// ({ type, ...fields }), not { type, payload }. Extract everything but
// `type` so THEME_SERVICE_* schema parses see the fields the webview
// actually sent instead of always seeing `undefined`.
function themeServiceMessagePayload(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const { type: _type, ...rest } = message as Record<string, unknown>;
  return rest;
}

function logThemeServiceRejection(type: string, error: { issues: Array<{ path: (string | number)[]; code: string }> }): void {
  const summary = error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
  log(`panel: ${type} rejected: ${summary}`);
}

import {
  mergeTycoonHooks,
  mergeManagedSubagentDepthEnv,
  migrateLegacyHookMatchers,
  addMissingAutoHealSlots,
  cleanupForeignHookArtifacts,
  findLegacyHookCommands,
  LEGACY_STATE_FILE_NAMES,
  syncRuntimeFile,
  MCP_BRIDGE_HOOK_FILES,
  ensureCommonJsMarker,
  healInstalledHookCopies,
  copyMcpBridgeHooks,
  enableMcpJsonServerInSettings,
  buildAbsoluteHookCommand,
  migrateRelativeHookCommand,
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
 * Optional "Project Plan" feature (default ON, uncheck to disable): resolve
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

/**
 * Read the Project Plan flag. Default ON: a missing file/dir/field (a user who
 * never touched the setting) reads as `true`; only an explicit `false`
 * written by the checkbox turns it off.
 */
function readProjectPlanEnabled(root: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectPlanExecutionConfigPath(root), "utf8"));
    if (parsed !== null && typeof parsed === "object") return parsed.projectPlanEnabled !== false;
    return true;
  } catch {
    return true;
  }
}

/** True when execution.json carries an explicit `projectPlanEnabled` value. */
function projectPlanFlagIsExplicit(root: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectPlanExecutionConfigPath(root), "utf8"));
    return parsed !== null && typeof parsed === "object" && typeof parsed.projectPlanEnabled === "boolean";
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

/**
 * Seed the opt-in `projectPlanEnabled` flag at fresh-install/repair time,
 * mirroring the `reviewEnabled` default-on-install precedent in
 * `_handleInstallHooks`: Project Plan is ON by default for a project that
 * has never explicitly chosen a value, but an existing EXPLICIT choice
 * (true or false, e.g. a user who unchecked it) is always preserved.
 *
 * Distinguishes "key absent" from "key present and false" by inspecting
 * the raw parsed JSON directly — `readProjectPlanEnabled` can't make that
 * distinction, since it coerces both cases to `false`.
 */
export function seedProjectPlanEnabledDefault(root: string): void {
  const configPath = projectPlanExecutionConfigPath(root);
  let priorExplicit: boolean | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && "projectPlanEnabled" in parsed) {
      priorExplicit = parsed.projectPlanEnabled === true;
    }
  } catch {
    /* missing/invalid file => no prior explicit value */
  }
  writeProjectPlanEnabled(root, priorExplicit !== undefined ? priorExplicit : true);
}

/**
 * Comprehensive list of Claude Code / dev-tool artifacts that must stay out
 * of UEFN revision control on a UEFN project. UEFN's native Revision
 * Control (URC) reads ONLY a root-level `.urcignore` — it does not honor
 * `.gitignore`. Perforce (some UEFN projects still use `p4` directly) reads
 * `.p4ignore`. Both files get this same comprehensive list so URC-native and
 * URC-via-Perforce agree; `.gitignore` keeps its own minimal, separate list
 * (see `_handleAddGitignoreEntries`) because non-UEFN git users often WANT
 * to commit CLAUDE.md/.claude.
 *
 * UEFN projects nest a second Unreal project root under `Content/` (the
 * Fortnite content folder is itself scanned/ignored independently by URC in
 * some configurations), so every root-level pattern is duplicated with a
 * `Content/` prefix to cover that nested root too.
 *
 * On top of the targeted names above, the list also carries broad extension
 * globs (`*.json`, `*.md`, `*.jsonl`, `*.mjs`, `*.cjs`, and `*.py` above) — a
 * real UEFN project's shipped assets are `.uasset`/`.umap`, so any loose
 * json/md/jsonl/cjs/mjs/py file at the project root is a dev-tool artifact,
 * not game content. URC reliably honors extension globs (and, being
 * unanchored, they already match inside `Content/` too, so — like `*.cjs` —
 * they need no separate `Content/`-prefixed duplicate); the targeted names
 * remain as belt-and-braces for tools that write those exact filenames.
 *
 * UEFN gameplay itself is authored in Verse, never Python — the UEFN
 * project's Python folder holds the TycoonAgents UEFN Power Tools bridge (`media/uefn-bridge/*.py`),
 * a per-developer editor-tooling install staged there by this extension, not
 * game content. Each teammate installs their own copy from their own VSIX, the
 * staged files bake in machine-specific paths, and shipping them into a
 * Fortnite project's revision control carries needless island-moderation
 * risk. `*.py` covers the bridge scripts themselves; the UEFN project's
 * Python folder and `Python/` (for workspace roots that already sit at
 * `Content/`) catch the
 * rest of the staged footprint that isn't a bare `.py` file — the launcher
 * icon, `__pycache__/`, `.pyc`, and the runtime `bridge_sync_status.json`.
 */
const UEFN_URC_IGNORE_ENTRIES: string[] = [
  ".claude/",
  "CLAUDE.md",
  ".mcp.json",
  "*.cjs",
  ".agents/",
  ".codex/",
  "AGENTS.md",
  "Content/.claude/",
  "Content/CLAUDE.md",
  "Content/.mcp.json",
  "Content/.agents/",
  "Content/.codex/",
  "Content/AGENTS.md",
  "*.json",
  "*.md",
  "*.jsonl",
  "*.mjs",
  "*.py",
  "*.bak",
  "Content/Python/",
  "Python/",
];

/**
 * The three ignore-file basenames this feature can write. Cross-referenced
 * into EVERY ignore file we write (see `_handleAddGitignoreEntries`) so
 * installing one never leaves it — or a sibling ignore file — queued for
 * ADD into whichever VCS reads it. Field evidence: a fresh UEFN install
 * showed `.gitignore`, `.mcp.json`, `.p4ignore`, `.urcignore`, and
 * `CLAUDE.md` all marked "A" (add) in Unreal Revision Control — the ignore
 * files were not excluding each other, or the tooling files beside them.
 * Listing a file's own name in its own entries is harmless (VCS tools
 * ignore self-references) so this list is used unconditionally rather than
 * branching per target.
 */
const IGNORE_FILE_NAMES: string[] = [".gitignore", ".p4ignore", ".urcignore"];

/**
 * TycoonAgents/Claude Code tooling artifacts to additionally keep out of
 * the URC-side ignore files (`.p4ignore`, `.urcignore`) — dev tooling,
 * never island content. Deliberately NOT written to `.gitignore`: a git
 * user may legitimately want `CLAUDE.md`/`.claude` versioned in git, but
 * shipping them into a Fortnite island's Perforce/URC history carries
 * needless island-moderation risk and is never wanted.
 */
const URC_TOOLING_EXTRAS: string[] = [".mcp.json", "CLAUDE.md", ".claude/"];

/**
 * Bounds for `_feedbackTicketBodies` (see field doc): at most this many
 * retained ticket bodies (each up to ~64KB) survive at once — plenty for a
 * user filling out/retrying a feedback ticket, nowhere near enough to be a
 * meaningful memory concern even at the panel's lifetime scale.
 */
const FEEDBACK_TICKET_MAX_ENTRIES = 5;
/** Retained ticket bodies older than this are pruned on the next SUBMIT_FEEDBACK, regardless of count. */
const FEEDBACK_TICKET_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * p33-t2: the exact H1 heading and description/role text `primary-agent.md`
 * carried before the "Fallback Agent" -> "Wildcard Agent" rename. Pinned
 * here as literal strings (not derived from the current `REGULAR_AGENTS`
 * catalog entry) so `_installWorkerAgents`'s refresh-if-still-default check
 * keeps working after this rename ships, and so any FUTURE rename of this
 * agent must add its own new pair rather than silently comparing the
 * current default against itself.
 */
const PRIMARY_AGENT_OLD_DEFAULT_H1 = "Fallback Agent";
const PRIMARY_AGENT_OLD_DEFAULT_DESCRIPTION =
  "The catch-all worker that receives tasks when none of the specialist agents' keywords matched. Its presence in the work log is a signal that the orchestrator should refine its keyword routing.";

/**
 * Two content anchors carried by every known phrasing of the old default
 * description — the literal frontmatter `description:` string above, AND
 * the even-older pre-frontmatter `## Role` prose (e.g. "You are the
 * Fallback Agent — the catch-all worker that receives tasks when none of
 * the specialist agents' keywords matched. Your presence in the work log
 * is a signal that the orchestrator should refine its keyword routing.").
 * Both phrasings share these two clauses verbatim (case aside), so a
 * substring check on them is a content-over-name-match that survives the
 * "You are the X — " preamble and the Its/Your pronoun swap the older
 * prose form uses. Lowercased once here to keep call sites cheap.
 */
const PRIMARY_AGENT_OLD_DEFAULT_DESCRIPTION_ANCHORS = [
  "catch-all worker that receives tasks when none of the specialist agents' keywords matched",
  "is a signal that the orchestrator should refine its keyword routing",
].map((s) => s.toLowerCase());

/**
 * Tolerant check for whether `existing` (a `primary-agent.md`'s full text)
 * is still the stock "Fallback Agent" default nobody has customized.
 * Tolerant on purpose (p33-t2 follow-up): trims whitespace and ignores
 * case throughout, accepts a description that STARTS WITH the old default
 * (so a file with an appended sentence still refreshes), and — since some
 * already-installed files predate the `description:` frontmatter field
 * entirely — falls back to the prose under `## Role` as the description
 * source when no frontmatter `description:` line is present, matched via
 * the content anchors above rather than an exact string.
 */
function primaryAgentIsStockDefault(existing: string): boolean {
  const h1Match = /^#\s*(.+?)\s*$/m.exec(existing);
  if (h1Match === null || h1Match[1].trim().toLowerCase() !== PRIMARY_AGENT_OLD_DEFAULT_H1.toLowerCase()) {
    return false;
  }

  const descMatch = /^description:\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(existing);
  if (descMatch !== null) {
    let frontmatterDesc: string;
    try {
      frontmatterDesc = JSON.parse(`"${descMatch[1]}"`);
    } catch {
      frontmatterDesc = descMatch[1];
    }
    const normalized = frontmatterDesc.trim().toLowerCase();
    const oldDefault = PRIMARY_AGENT_OLD_DEFAULT_DESCRIPTION.trim().toLowerCase();
    return normalized === oldDefault || normalized.startsWith(oldDefault);
  }

  // No frontmatter `description:` field at all -> fall back to the `## Role`
  // section's prose (the pre-frontmatter-description file shape) and match
  // on content anchors instead of an exact string.
  const roleMatch = /^##\s*Role\s*$\r?\n+([^\n]+(?:\r?\n[^\n#][^\n]*)*)/m.exec(existing);
  if (roleMatch === null) return false;
  const roleText = roleMatch[1].trim().toLowerCase();
  return PRIMARY_AGENT_OLD_DEFAULT_DESCRIPTION_ANCHORS.every((anchor) => roleText.includes(anchor));
}

/**
 * Evidence-based detection of which ignore file(s) the Setup Wizard's
 * "Add Tycoon logs to ignore file" checkbox should target — content
 * signals only, never a guessed VCS (Path & Environment Discovery: an
 * override always wins, multiple independent signals, never one guess).
 * `effRoot` is the caller-resolved UEFN-effective root (see
 * `_uefnEffectiveRoot`) — `.p4ignore`/`.urcignore` live there, while
 * `.git`/`.gitignore` are always checked at the plain `root`.
 *   - `.gitignore`: a `.git` directory exists at `root`, OR a `.gitignore`
 *     file already exists there.
 *   - `.p4ignore`: a `.p4ignore` or `.p4config` file already exists at
 *     `effRoot`, the `P4CONFIG` env var is set, OR the project is a
 *     detected UEFN project (UEFN's usual Perforce pairing).
 *   - `.urcignore`: a `.urcignore` file already exists at `effRoot`, OR
 *     the project is a detected UEFN project (URC is UEFN's own revision
 *     control) — matching `_handleAddGitignoreEntries`'s existing "UEFN
 *     project with no markers still gets .urcignore + .p4ignore" behavior.
 * Returns `[]` when nothing was detected; callers must never write into a
 * git-less, non-UEFN project on a guess. Every fs probe fails open (a
 * missing path is just "no signal", never a thrown error). Module-level
 * (not a class method) so it stays callable with a bare receiver, matching
 * `resolveProgramDataRoot` below and `_findFortniteEngineBridgeDir`'s use
 * in `test/panelEngineBridgePush.test.ts` — existing gitignore-handler
 * tests (`test/panelUrcIgnore.test.ts`) invoke `_handleAddGitignoreEntries`
 * against a minimal stub receiver, and a module-level helper keeps that
 * working without the stub needing to grow another bound method.
 */
function detectIgnoreTargets(root: string, effRoot: string, uefnDetected: boolean): string[] {
  let hasGit = false;
  try {
    hasGit = fs.existsSync(path.join(root, ".git")) || fs.existsSync(path.join(root, ".gitignore"));
  } catch {
    hasGit = false;
  }

  let hasP4 = false;
  try {
    hasP4 =
      fs.existsSync(path.join(effRoot, ".p4ignore")) ||
      fs.existsSync(path.join(effRoot, ".p4config")) ||
      Boolean(process.env.P4CONFIG) ||
      uefnDetected;
  } catch {
    hasP4 = uefnDetected;
  }

  let hasUrc = false;
  try {
    hasUrc = fs.existsSync(path.join(effRoot, ".urcignore")) || uefnDetected;
  } catch {
    hasUrc = uefnDetected;
  }

  const targets: string[] = [];
  if (hasUrc) targets.push(".urcignore");
  if (hasP4) targets.push(".p4ignore");
  if (hasGit) targets.push(".gitignore");
  return targets;
}

/**
 * Probe every fixed drive letter actually present on the machine (not a
 * hardcoded `C:`-`F:` guess). Bounded to the 24 non-floppy letters `C:`-`Z:`
 * (`A:`/`B:` skipped — legacy floppy letters can trigger a slow OS-level
 * probe on old systems and are never a real install target); each check is
 * a single cheap `fs.existsSync` stat on a drive root, so the whole probe is
 * at most 24 fast synchronous stats and never blocks the extension host for
 * longer than that.
 */
function enumerateFixedDrives(): string[] {
  const drives: string[] = [];
  for (const code of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    try {
      if (fs.existsSync(`${code}:\\`)) {
        drives.push(`${code}:`);
      }
    } catch {
      /* inaccessible or errored drive letter, skip */
    }
  }
  return drives;
}

/**
 * Reads the `tycoonagents.provider` VS Code setting, but only when it has
 * been EXPLICITLY set (global, workspace, or workspace-folder scope) —
 * never the package.json-declared default. `getConfiguration().get()`
 * always returns a value once package.json declares a default (here,
 * "claude-code"), which made describeProviderSelection/resolveProviderId
 * believe the setting had been overridden on every install, permanently
 * masking execution.json and disabling the harness dropdown. `inspect()`
 * separates the default from an actual user-set value, so this returns
 * undefined unless someone actually set it.
 */
export function readExplicitProviderSetting(
  cfg: Pick<ReturnType<typeof vscode.workspace.getConfiguration>, "inspect">,
): string | undefined {
  const inspected = cfg.inspect<string>("provider");
  if (!inspected) return undefined;
  return inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue;
}

/** Singleton webview panel that renders the TycoonAgents visualization. */
// The bounded seed wait lives in themeReady.ts so src/extension/main.ts (the
// Theater sidebar) can share it without importing this module. Re-exported
// here because existing callers/tests import it from panel.ts.
export { THEME_SEED_WAIT_MS, waitForBundledThemes } from "./themeReady";

export class TycoonPanel {
  public static currentPanel: TycoonPanel | undefined;
  private static readonly viewType = "tycoonagents";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _runtime: Runtime;
  private readonly _globalStorageUri: vscode.Uri;

  /**
   * The activation-time bundled-theme seed promise (see extension.ts's
   * `bundledThemesReady`), injected rather than imported so panel.ts stays
   * free of a circular import back into extension.ts. Undefined in tests /
   * callers that don't seed — treated as "nothing to wait for".
   */
  private readonly _bundledThemesReady: Promise<unknown> | undefined;
  private readonly _secrets: vscode.SecretStorage;
  /**
   * p13-t7: optional live-swap hook wired in by extension.ts's openCmd.
   * When present, `_handleSetHarness` calls it after writing the new
   * provider id to execution.json; a `true` return means the running
   * Provider was disposed and replaced without a reload (requiresRestart:
   * false in the next SETTINGS payload). Undefined/false means the change
   * only takes effect on the extension's next activation.
   */
  private _providerSwap: ((id: ProviderId) => boolean) | undefined;
  /** Reports which provider id is ACTUALLY running right now (wired in
   * alongside _providerSwap) — separate from the file/setting/env-derived
   * `effective` value, which can move independently (e.g. a hand-edited
   * execution.json, or a swap that failed and left the old one running).
   * `_buildHarnessSettings` diffs the two into `mismatch`/`requiresRestart`
   * on every SETTINGS build, not just right after a swap in this window. */
  private _getRunningProviderId: (() => ProviderId | undefined) | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _runtimeDisposable: { dispose(): void } | undefined;
  /** p42-t1: Theme Service auth/balance/checkout host, owns its own polling
   * and the in-memory Google PKCE code verifier. Disposed in dispose(). */
  private readonly _themeServiceHost: ThemeServiceHost;
  /** Review fix (v0.0.661): defense-in-depth against a duplicate
   * Google-sign-in-start message (the webview has its own guard, but a
   * stray duplicate — e.g. one queued before that guard's own re-render
   * lands — must not open a second browser tab). Tracks
   * whether a handleGoogleStart() call is currently in flight and when it
   * started; a duplicate is dropped only while one is still in flight and
   * within 30s, so a deliberate restart after Cancel (which always finds
   * the prior call already resolved) is never blocked. */
  private _themeServiceGoogleStartInFlight = false;
  private _themeServiceGoogleStartInFlightSince = 0;
  private _enginePollInterval: NodeJS.Timeout | undefined;
  /** Set in dispose(): in-flight vendor key tests are killed and never post to a closed webview. */
  private _disposed = false;
  /**
   * Incremental read state for the session-scoped delegationHealth rebuild
   * (see _computeSessionDelegationHealth). Cost is proportional to bytes
   * APPENDED since the last read, not the total file size: `offset` only
   * ever advances past confirmed-complete lines (a record flushed mid-write
   * is safely re-read next time, mirroring
   * ClaudeCodeProvider.drain()'s trailing-partial-line handling), and
   * `state` is the running MetricsWorldState folded from every record seen
   * so far that belongs to `sessionId` (reset on a session boundary or a
   * file shrink/replacement — see _computeSessionDelegationHealth).
   * `size`/`mtimeMs` are the file's stat() at the time `offset`/`state` were
   * last updated, so a completely idle log (unchanged size+mtime) short-
   * circuits to zero disk reads.
   */
  private _sessionHealthCache:
    | {
        size: number;
        mtimeMs: number;
        offset: number;
        sessionId: string | undefined;
        state: MetricsWorldState;
      }
    | undefined;
  /**
   * Last value handed back by _sessionDelegationHealthThrottled — the
   * throttle's "return the cached value between recomputes" contract is
   * separate from _sessionHealthCache's incremental-read bookkeeping above
   * (a throttled caller may skip calling _computeSessionDelegationHealth at
   * all for up to SESSION_HEALTH_THROTTLE_MS, even though that method itself
   * is now cheap when idle). `_cachedSessionDelegationHealthAt` of 0 means
   * "never computed". `sessionId`/`agentMetrics` (0.0.528) ride along on the
   * same cached value/throttle window — they come from the same underlying
   * _computeSessionDelegationHealth() call, so caching them separately would
   * just be a second throttle over the same data.
   */
  private _cachedSessionDelegationHealth:
    | {
        directSearches: number;
        directReads: number;
        directEdits: number;
        delegations: number;
        tokens: number;
        sessionId: string;
        agentMetrics: AgentMetric[];
      }
    | undefined;
  private _cachedSessionDelegationHealthAt = 0;
  /** Minimum interval between session-scoped delegationHealth recompute ATTEMPTS on the live runtime.onChange path (a stat() rate limit; each attempt itself is now cheap when the log hasn't grown, see _sessionHealthCache). */
  private static readonly SESSION_HEALTH_THROTTLE_MS = 4000;
  /**
   * Incremental read state for the ALL-TIME (never session-reset, unlike
   * _sessionHealthCache) delegation-compliance tally: how many direct
   * PreToolUse calls (Read/Grep/Glob/Edit/Write/Bash) the orchestrator made
   * itself vs. every other workerId. Mirrors _sessionHealthCache's
   * byte-offset/idle-shortcut shape exactly (see _computeToolCompliance) but
   * folds records into two running counters instead of a MetricsWorldState —
   * the orchestrator/worker split is a raw tool-set membership test on
   * `record.tool`, not something the AgentMetric reducer tracks (it never
   * counts Bash/PowerShell at all — those map to ActivityKind "shell", which
   * applyEvent's WorkerActivity case does not add to directEdits). This is
   * DELIBERATELY a second incremental cache rather than folded into
   * _sessionHealthCache's loop: that cache resets on every session boundary
   * (by design, for session-scoped delegationHealth), which would make an
   * all-time compliance counter wrong every time a new session starts.
   */
  private _toolComplianceCache:
    | { size: number; mtimeMs: number; offset: number; orchestratorDirectCalls: number; workerToolCalls: number }
    | undefined;
  private _cachedToolCompliance: { orchestratorDirectCalls: number; workerToolCalls: number } | undefined;
  private _cachedToolComplianceAt = 0;
  /** Tool names counted toward the delegation-compliance meter (Delegation tab). Matches CLAUDE.md's "must delegate" set: Bash included even though the AgentMetric reducer's directEdits does not track it. */
  private static readonly TOOL_COMPLIANCE_TOOLS = new Set<string>(["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
  /** Cached "connected" results for HTTP-probeable engine MCP entries (e.g. unreal-engine-mcp), keyed by engine id. */
  private _engineProbeCache: Map<string, boolean> = new Map();
  /**
   * Result of the once-per-panel-open leftover foreign/legacy agent-hook
   * artifact scan (see `_detectLegacyArtifactsOnLoad`), computed in the
   * constructor and delivered as `MSG.LEGACY_ARTIFACTS_DETECTED` once
   * `MSG.READY` arrives (a postMessage sent before the webview's listener
   * attaches is silently lost). `null` when nothing was found, no workspace
   * root was open, or the scan threw.
   */
  private _pendingLegacyArtifactsNotice: { artifactCount: number; foreignHookCount: number } | null = null;
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
   * theme_id of the AI batch generation currently in flight when
   * `_themeGenerationActive` is true (p80). Set as soon as the theme id is
   * known (immediately for a resume, on THEME_REVIEW_READY for a fresh
   * generation) and cleared in the GENERATE_THEME handler's `finally`.
   * Lets `_postThemeImageReview` tell "this session's own in-memory run"
   * apart from a persisted "active" status left over from a different
   * session/theme or an extension restart mid-run (generation_resumable).
   */
  private _themeGenerationThemeId: string | undefined;
  /**
   * theme_id of the theme most recently sent to the webview via
   * THEME_INITIALIZED (set inside `_buildThemeInitPayload`, which every
   * THEME_INITIALIZED post funnels through). Used to know the "currently
   * loaded" theme for the theme-switch warning and the scoped stats reset —
   * this panel doesn't otherwise track active theme state host-side.
   */
  private _currentThemeId: string | undefined;
  /**
   * Theme id offered in the most recent CONFIRM_THEME_SWITCH prompt, or
   * undefined when no confirmation is outstanding. SELECT_THEME_CONFIRMED
   * must match this before activating (see handler below) — otherwise a
   * stale or mismatched confirm message could silently activate a theme
   * that was never actually offered for confirmation. Cleared on
   * activation and superseded by any new SELECT_THEME (a second theme
   * click supersedes the first offer).
   */
  private _pendingThemeSwitchId: string | undefined;
  private _themeGenerationAbortController: AbortController | undefined;
  /**
   * ticketId -> { body, storedAt } for the exact JSON body string built by
   * SUBMIT_FEEDBACK and shown to the user as the preview. CONFIRM_FEEDBACK_SEND
   * looks up the entry for the ticketId it echoes back — the bytes POSTed
   * are always byte-identical to what was previewed. The entry is deleted
   * ONLY on a successful send (so a succeeded ticket can't be resent /
   * double-filed); a failed send RETAINS the entry so the webview's "Retry
   * Send" button can resend the same ticketId. An unknown/expired ticketId
   * is a safe no-op (see _handleConfirmFeedbackSend). Bounded by
   * FEEDBACK_TICKET_MAX_ENTRIES/FEEDBACK_TICKET_MAX_AGE_MS (pruned in
   * _pruneFeedbackTickets, called on every new SUBMIT_FEEDBACK) and cleared
   * entirely in dispose() so nothing survives a panel close.
   */
  private _feedbackTicketBodies = new Map<string, { body: string; storedAt: number }>();
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
  /**
   * Cache of agent id -> authoritative `model:` string parsed from
   * `.claude/agents/*.md` frontmatter via `loadAgentRoster`. Populated
   * lazily by `_getRosterModelMap` and invalidated whenever the on-disk
   * roster can change (worker-agent install, agent removal, metrics reset)
   * so a stale model never gets stamped onto outgoing state.
   */
  private _rosterModelCache: Map<string, string> | undefined;

  /** p13-t7: wires the live-swap callback in from extension.ts (avoids a
   * circular import between extension.ts and panel.ts — extension.ts already
   * imports TycoonPanel, so panel.ts cannot import back from it). */
  public setProviderSwap(fn: (id: ProviderId) => boolean, getRunning: () => ProviderId | undefined): void {
    this._providerSwap = fn;
    this._getRunningProviderId = getRunning;
  }

  /**
   * p42-t1: registered once by extension.ts's activate() via
   * `vscode.window.registerUriHandler`, for the `vscode://<publisher>.<name>/
   * theme-service-auth?code=...` Google sign-in deep link. Forwards to
   * whichever panel is currently open — there is at most one
   * (TycoonPanel.currentPanel) — and is a no-op if none is open (the pasted-
   * code fallback in the webview covers that case).
   */
  public static handleUriCallback(uri: vscode.Uri): void {
    // Trust boundary: VS Code dispatches vscode:// URIs to the extension whose
    // publisher.name matches the URI's authority, so the OS/VS Code has
    // already confirmed this callback is addressed to us — authority is not
    // re-checked here.
    // p62-t2: vscode://<publisher>.<name>/sign-in?ref=CODE — deep-link
    // pre-fill only (never applied until sign-in completes). Registered
    // beside /theme-service-auth in the same URI handler (extension.ts);
    // no separate package.json contribution is needed for either path.
    if (uri.path === "/sign-in") {
      const ref = new URLSearchParams(uri.query).get("ref");
      if (ref && REFERRAL_CODE_PATTERN.test(ref)) {
        TycoonPanel.currentPanel?._themeServiceHost.handleSetReferralCode(ref);
      }
      return;
    }
    if (uri.path !== "/theme-service-auth") return;
    // p83-t1: parse both the PKCE `?code=` query and the implicit-flow
    // `#access_token=...&refresh_token=...` fragment — VS Code's Uri
    // exposes the fragment separately from the query, and a Supabase
    // implicit-flow redirect carries its tokens there, never in the query.
    const query = new URLSearchParams(uri.query);
    const fragment = new URLSearchParams(uri.fragment);
    const code = query.get("code") ?? undefined;
    const accessToken = fragment.get("access_token") ?? undefined;
    const refreshToken = fragment.get("refresh_token") ?? undefined;
    const expiresInRaw = fragment.get("expires_in");
    const expiresIn = expiresInRaw ? Number(expiresInRaw) : undefined;
    const errorCode = query.get("error") ?? fragment.get("error") ?? undefined;

    const host = TycoonPanel.currentPanel?._themeServiceHost;
    // Captured BEFORE forwarding to the host below, since a successful
    // code-branch completion clears this flag as part of the same call.
    const wasPending = Boolean(host && host.hasPendingGoogleSignIn());
    if (host) {
      // p83-t1: every callback is forwarded so the host can record what
      // arrived — parameter NAMES only, via the existing output channel
      // helper it already holds — regardless of whether anything here is
      // usable. This function itself never records anything.
      void host.handleUriCallback({
        code,
        accessToken,
        refreshToken,
        expiresIn,
        errorCode,
        queryParamNames: Array.from(query.keys()),
        fragmentParamNames: Array.from(fragment.keys()),
      });
    }
    if (!code) return;
    // p72-t1: a callback can land in a window/editor other than the one
    // that started sign-in (e.g. the browser reopened stable VS Code while
    // sign-in began in Antigravity/Insiders/a fork) — or in this same
    // window after the pending verifier was already consumed/cleared. In
    // either case there's nothing here to complete, so offer the code for
    // the user to paste into the Theme Builder where sign-in actually
    // started, instead of a bare "not signed in" error. Never recorded.
    if (wasPending) return;
    void vscode.window
      .showInformationMessage(
        "Sign-in code received. Paste it into the Theme Builder of the IDE where you started sign-in to finish signing in.",
        "Copy code",
      )
      .then((selection) => {
        if (selection === "Copy code") {
          void vscode.env.clipboard.writeText(code);
        }
      });
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    runtime: Runtime,
    globalStorageUri: vscode.Uri,
    secrets: vscode.SecretStorage,
    bundledThemesReady?: Promise<unknown>,
    globalState?: vscode.Memento,
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

    TycoonPanel.currentPanel = new TycoonPanel(
      panel,
      extensionUri,
      runtime,
      globalStorageUri,
      secrets,
      bundledThemesReady,
      globalState,
    );
    return TycoonPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    runtime: Runtime,
    globalStorageUri: vscode.Uri,
    secrets: vscode.SecretStorage,
    bundledThemesReady?: Promise<unknown>,
    globalState?: vscode.Memento,
  ) {
    this._panel = panel;
    this._bundledThemesReady = bundledThemesReady;
    this._extensionUri = extensionUri;
    this._runtime = runtime;
    this._globalStorageUri = globalStorageUri;
    this._secrets = secrets;

    this._themeServiceHost = createThemeServiceHost({
      secrets,
      // p72-t1: the running host's own scheme (vscode.env.uriScheme), so the
      // Google deep-link redirect reopens THIS editor/fork instead of
      // always vscode://. Falls back to "vscode" inside the host when empty.
      uriScheme: vscode.env.uriScheme,
      openExternal: async (url) => {
        // p66-t1: a well-formed URI is required (throws instead of silently
        // no-op'ing on a malformed one) — the result is logged as a boolean
        // only, never the URL itself (it can carry a PKCE code_challenge or
        // a Stripe checkout fragment, never logged in full). A thrown error
        // is scrubbed by the caller (themeServiceHost.ts) before it's
        // logged or posted.
        // p67-t3: vscode.Uri.parse's re-encoding can mangle a Stripe
        // Checkout URL's `#fidk...` fragment or the Supabase authorize
        // URL's query, so openExternalUrl compares the round-trip and falls
        // back to a detached platform-opener spawn when it changed.
        return openExternalUrl(url, (msg) => log(`panel: ${msg}`));
      },
      postStatus: (status: ThemeServiceHostStatus) => {
        void this._panel.webview.postMessage({ type: MSG.THEME_SERVICE_STATUS, payload: status });
      },
      postGoogleOpened: (result) => this._postThemeServiceGoogleOpened(result),
      log,
      clientVersion: this._currentExtensionVersion() ?? undefined,
      // p64-t1: raw setting value; validated/normalized inside
      // createThemeServiceHost via resolveThemeServiceEndpoint. Invalid
      // values fall back to production with one logged warning.
      endpointOverride: vscode.workspace.getConfiguration("tycoonagents").get<string>("themeService.endpoint"),
      // p62-t2: undefined (not a fake Memento) when the caller omits
      // globalState — the host then simply never shows the referral field
      // rather than risking a wrong per-device "first sign-in" guess.
      deviceState: globalState ? createVsCodeThemeServiceDeviceState(globalState) : undefined,
      // Follow-up fix: durable last-known-balance cache backed by
      // globalState — survives a webview reload/private window/restart,
      // unlike the webview's own localStorage. Omitted (no fallback) when
      // globalState itself isn't available, same posture as deviceState.
      creditsCache: globalState ? createVsCodeThemeServiceCreditsCache(globalState) : undefined,
    });
    this._themeServiceHost.start();
    // Route every board-image generation attempt through this panel's
    // ThemeServiceHost client (p43-t1) — the same authenticated instance
    // status/checkout already use, so a generation call reuses the current
    // session and refresh-in-flight coordination rather than building a
    // second client.
    setThemeImageGenerator(createServiceImageGenerator(this._themeServiceHost.getClient(), {
      begin: () => this._themeServiceHost?.beginAttempt(),
      credits: (credits, token) => this._themeServiceHost?.applyCreditsFromAttempt(credits, token),
    }));
    setThemeAttemptCostResolver((boardType) => this._themeServiceHost?.getQuotedAttemptCost(boardType));
    // p59-t3: surfaces generateBoardImage's local-vs-service prompt-template
    // drift notice (sha256 mismatch) as a one-way webview message.
    setThemePromptMismatchNotifier((message, templateVersion) => {
      void this._panel.webview.postMessage({
        type: MSG.THEME_PROMPT_MISMATCH,
        payload: templateVersion ? { message, templateVersion } : { message },
      });
    });
    // Same wiring for theme planning/description-regeneration text calls
    // (p43-t7) — reuses the same authenticated client/session as image
    // generation and status/checkout above.
    setThemePlanRequester(createServicePlanRequester(this._themeServiceHost.getClient()));
    // Refresh status whenever the panel becomes visible again (tab
    // switch/restore) — cheap (one getStatus call) and keeps a stale
    // signed-out/balance view from lingering after e.g. completing sign-in
    // in the browser and switching back.
    this._panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) {
          void this._themeServiceHost.handleGetStatus();
        }
      },
      null,
      this._disposables,
    );

    // Inject the vscode-backed ThemeFileStore (project-plan task pA-t1) once,
    // so themeStorage.ts/themeService.ts do all theme file I/O through it
    // instead of calling vscode.workspace.fs directly. Constructed here (the
    // one place globalStorageUri is first resolved) and reused for the life
    // of this panel.
    configureThemeFileStore(createVscodeThemeFileStore(globalStorageUri));

    // Auto-heal the CLAUDE.md delegation doctrine once per panel open (see
    // _ensureDelegationDoctrineCurrent doc comment) — fixes 0% delegation on
    // projects upgraded from a version that predates the doctrine.
    this._ensureDelegationDoctrineCurrent();

    // Auto-heal a missing project-appropriate worker roster once per panel
    // open (see _ensureWorkerAgentsInstalled doc comment) — fixes
    // search-retrieval, primary-agent (the Wildcard Agent), and (for
    // non-UEFN projects) coding-specialist + ux-ui-designer never being
    // installed, which left delegated work (and keyword-unmatched work) with
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

    // Auto-heal a stale settings.local.json hook matcher once per panel
    // open (see _ensureHookMatchersFresh doc comment) — closes the gap
    // _ensureHookScriptFresh does NOT cover: it refreshes the hook SCRIPT
    // file but never touched the settings.local.json matcher strings, so a
    // project installed before a matcher change (e.g. PreToolUse's MCP
    // matcher going from bare "mcp__" to anchored "mcp__.*") stayed on the
    // old matcher forever unless the user clicked "Install hooks"/"Repair"
    // again.
    this._ensureHookMatchersFresh();
    this._ensureHookCommandAbsolute();

    // Detect (never auto-fix) leftover foreign/legacy agent-hook artifacts
    // once per panel open — cheap read-only scan (see
    // _detectLegacyArtifactsOnLoad), so a project that's accumulated
    // orphaned agent-activity-*.json spool files and/or foreign hook
    // commands surfaces that to the user without them having to open Hook
    // Doctor. Result is stashed and delivered once MSG.READY arrives, below
    // — removal stays a user action via Hook Doctor's existing fix path.
    this._pendingLegacyArtifactsNotice = this._detectLegacyArtifactsOnLoad();

    // Auto-heal a stale on-disk project-plan skill once per panel open (see
    // _ensureProjectPlanSkillFresh doc comment) — fixes the skill drifting
    // out of date on a project where Project Plan is enabled but the skill
    // was only ever copied once at install time.
    this._ensureProjectPlanSkillFresh();

    // Auto-heal the always-on core skills (tycoon-ready-test,
    // tycoon-diagnose) once per panel open for any project that has already
    // run Install/Repair — see _ensureCoreSkillsFresh doc comment. Unlike
    // project-plan these ship unconditionally, no opt-in flag.
    this._ensureCoreSkillsFresh();

    // Auto-heal stale pack content (skills, commands, agent .md files) for
    // every pack this project already has installed, once per panel open
    // when the running extension version differs from the version stamped
    // into `.claude/tycoon/pack-staging.json` the last time this ran (see
    // _ensureInstalledPacksFresh doc comment) — fixes an extension UPDATE
    // never reaching an already-installed project's `.claude/skills/**`
    // and `.claude/agents/*.md` content, which previously only ever
    // refreshed on an explicit "Install pack" click (and even then, only
    // for genuinely new files — see _stageSkillTree). Runs after the other
    // auto-heals above so it sees their results (e.g. a freshly-created
    // worker roster) in the same load cycle.
    this._ensureInstalledPacksFresh();

    // Repoint our own Codex notify hook / dispatcher entries after an
    // extension update moved the versioned install folder (see
    // _ensureCodexInstallsCurrent). No-op unless Codex is the harness and
    // we installed those entries before.
    this._ensureCodexInstallsCurrent();

    this._update();

    // Subscribe to runtime state changes
    this._runtimeDisposable = runtime.onChange((state) => {
      this._postStateUpdate(state);
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
          // Same delegationHealth-carrying push as runtime.onChange (see
          // _postStateUpdate) — the very first paint after the panel opens
          // should already have live counts, not wait for the next runtime
          // mutation (which may be a while on an idle session).
          this._postStateUpdate(runtime.getState());
          // Deliver the once-per-panel-open leftover-artifact notice (see
          // _detectLegacyArtifactsOnLoad + the constructor call site) now
          // that the webview's message listener is actually attached — a
          // postMessage sent before READY would be silently lost. Harmless
          // no-op for a webview build that doesn't listen for this message
          // yet. Not resent on subsequent READY pings within the same panel
          // life (cleared after the first delivery).
          if (this._pendingLegacyArtifactsNotice) {
            void this._panel.webview.postMessage({
              type: MSG.LEGACY_ARTIFACTS_DETECTED,
              artifactCount: this._pendingLegacyArtifactsNotice.artifactCount,
              foreignHookCount: this._pendingLegacyArtifactsNotice.foreignHookCount,
            });
            this._pendingLegacyArtifactsNotice = null;
          }
          // Auto-load the latest theme so the main panel shows the real
          // characters + environment on open (mirrors the Theater view).
          void (async () => {
            // A fresh install seeds media/themes/* into global storage during
            // activation; that seed is async and used to race this first load,
            // making the panel show the no-theme placeholder even though a
            // bundled theme was about to appear. Wait for it — bounded, so a
            // hung seed can never freeze the panel.
            await waitForBundledThemes(this._bundledThemesReady);
            const diagThemes = await listThemes(this._globalStorageUri).catch((error) => {
              log(`panel first-load: listThemes threw: ${String(error)}`);
              return [];
            });
            log(
              `panel first-load: listThemes root=${String(this._globalStorageUri)} count=${diagThemes.length} ids=[${diagThemes.map((th) => th.theme_id).join(", ")}]`,
            );
            const t = await loadLatestTheme(this._globalStorageUri);
            log(`panel first-load: loadLatestTheme -> ${t ? t.manifest.theme_id : "undefined"}`);
            if (t) {
              const payload = await this._buildThemeInitPayload(t.manifest, t.frames, false);
              const frames = (payload as any)?.frames;
              const frameKeys = frames && typeof frames === "object" ? Object.keys(frames) : [];
              const envBg = frames && typeof frames === "object" ? frames["environment_background"] : undefined;
              const envBgFirst = Array.isArray(envBg) ? envBg[0] : undefined;
              log(
                `panel first-load: sending THEME_INITIALIZED theme_id=${t.manifest.theme_id} frameKeyCount=${frameKeys.length} hasEnvBg=${Boolean(envBgFirst)} envBgPrefix=${typeof envBgFirst === "string" ? envBgFirst.slice(0, 30) : "n/a"}`,
              );
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload,
              });
            } else {
              // No theme on disk yet (fresh install) — tell the webview
              // explicitly so its boot loader can hand off to the no-theme
              // placeholder scene immediately instead of idling out its
              // stage-loading timeout.
              log("panel first-load: sending THEME_NONE (no theme found)");
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
          let result: Awaited<ReturnType<typeof uploadThemeImage>>;
          try {
            result = await uploadThemeImage(this._globalStorageUri, theme_id, item_id, bytes);
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.BACKGROUND_REPLACE_RESULT,
              payload: { ok: false, error: err instanceof Error ? err.message : String(err) },
            });
            return;
          }
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
        } else if (message.type === MSG.GET_ROUTING) {
          this._handleGetRouting();
        } else if (message.type === MSG.SAVE_ROUTING) {
          const parsedSaveRouting = MSG_SCHEMAS.SAVE_ROUTING.safeParse(message);
          if (parsedSaveRouting.success) {
            this._handleSaveRouting(parsedSaveRouting.data.profile);
          } else {
            console.error("TycoonAgents: saveRouting payload rejected:", parsedSaveRouting.error.message);
          }
        } else if (message.type === MSG.CLEAR_ROUTING) {
          this._handleClearRouting();
        } else if (message.type === MSG.PROBE_ENV) {
          const parsedProbeEnv = MSG_SCHEMAS.PROBE_ENV.safeParse(message);
          if (parsedProbeEnv.success) {
            this._handleProbeEnv(parsedProbeEnv.data.names);
          } else {
            console.error("TycoonAgents: probeEnv payload rejected:", parsedProbeEnv.error.message);
          }
        } else if (message.type === MSG.SET_LOCAL_ENV_VALUE) {
          const parsedSetLocalEnvValue = MSG_SCHEMAS.SET_LOCAL_ENV_VALUE.safeParse(message);
          if (parsedSetLocalEnvValue.success) {
            this._handleSetLocalEnvValue(parsedSetLocalEnvValue.data.name, parsedSetLocalEnvValue.data.value);
          } else {
            console.error("TycoonAgents: setLocalEnvValue payload rejected:", parsedSetLocalEnvValue.error.message);
          }
        } else if (message.type === MSG.CLEAR_LOCAL_ENV_VALUE) {
          const parsedClearLocalEnvValue = MSG_SCHEMAS.CLEAR_LOCAL_ENV_VALUE.safeParse(message);
          if (parsedClearLocalEnvValue.success) {
            this._handleClearLocalEnvValue(parsedClearLocalEnvValue.data.name);
          } else {
            console.error("TycoonAgents: clearLocalEnvValue payload rejected:", parsedClearLocalEnvValue.error.message);
          }
        } else if (message.type === MSG.TEST_VENDOR_KEY) {
          const parsedTestVendorKey = MSG_SCHEMAS.TEST_VENDOR_KEY.safeParse(message);
          if (parsedTestVendorKey.success) {
            if (parsedTestVendorKey.data.vendor === "custom") {
              // Custom endpoint row: slot id + variable NAMES only; URL/key are resolved host-side.
              const m = message as Record<string, unknown>;
              void this._handleTestCustomEndpoint({
                slotId: typeof m["slot"] === "string" ? m["slot"] : "",
                endpointEnv: typeof m["endpointEnv"] === "string" ? m["endpointEnv"] : "",
                apiKeyEnv: typeof m["apiKeyEnv"] === "string" ? m["apiKeyEnv"] : undefined,
                slotVendor: typeof m["slotVendor"] === "string" ? m["slotVendor"] : undefined,
                model: parsedTestVendorKey.data.model,
              });
            } else {
              void this._handleTestVendorKey(parsedTestVendorKey.data.vendor, parsedTestVendorKey.data.model);
            }
          } else {
            console.error("TycoonAgents: testVendorKey payload rejected:", parsedTestVendorKey.error.message);
          }
        } else if (message.type === MSG.SET_GEMINI_BACKEND) {
          const parsedSetGeminiBackend = MSG_SCHEMAS.SET_GEMINI_BACKEND.safeParse(message);
          if (parsedSetGeminiBackend.success) {
            this._handleSetGeminiBackend(parsedSetGeminiBackend.data.value);
          } else {
            console.error("TycoonAgents: setGeminiBackend payload rejected:", parsedSetGeminiBackend.error.message);
          }
        } else if (message.type === MSG.GET_SETTINGS) {
          this._handleGetSettings();
        } else if (message.type === MSG.SET_AGENT_MODEL) {
          const parsedSetAgentModel = MSG_SCHEMAS.SET_AGENT_MODEL.safeParse(message);
          if (parsedSetAgentModel.success) {
            void this._handleSetAgentModel(parsedSetAgentModel.data.id, parsedSetAgentModel.data.model);
          } else {
            console.error("TycoonAgents: setAgentModel payload rejected:", parsedSetAgentModel.error.message);
          }
        } else if (message.type === MSG.SET_HARNESS) {
          const parsedSetHarness = MSG_SCHEMAS.SET_HARNESS.safeParse(message);
          if (parsedSetHarness.success) {
            this._handleSetHarness(parsedSetHarness.data.provider);
          } else {
            console.error("TycoonAgents: setHarness payload rejected:", parsedSetHarness.error.message);
          }
        } else if (message.type === MSG.INSTALL_CODEX_HOOKS) {
          this._handleInstallCodexHooks();
        } else if (message.type === MSG.UNINSTALL_CODEX_HOOKS) {
          this._handleUninstallCodexHooks();
        } else if (message.type === MSG.INSTALL_CODEX_DISPATCHER) {
          this._handleInstallCodexDispatcher();
        } else if (message.type === MSG.UNINSTALL_CODEX_DISPATCHER) {
          this._handleUninstallCodexDispatcher();
        } else if (message.type === MSG.SET_USE_MULTIPLE_LLMS) {
          const parsedSetUseMultipleLlms = MSG_SCHEMAS.SET_USE_MULTIPLE_LLMS.safeParse(message);
          if (parsedSetUseMultipleLlms.success) {
            this._handleSetUseMultipleLlms(parsedSetUseMultipleLlms.data.value);
          } else {
            console.error("TycoonAgents: setUseMultipleLlms payload rejected:", parsedSetUseMultipleLlms.error.message);
          }
        } else if (message.type === MSG.SET_AGENTS_MULTI_PROVIDER) {
          const parsedSetAgentsMultiProvider = MSG_SCHEMAS.SET_AGENTS_MULTI_PROVIDER.safeParse(message);
          if (parsedSetAgentsMultiProvider.success) {
            void this._handleSetAgentsMultiProvider(parsedSetAgentsMultiProvider.data.value);
          } else {
            console.error("TycoonAgents: setAgentsMultiProvider payload rejected:", parsedSetAgentsMultiProvider.error.message);
          }
        } else if (message.type === MSG.SET_CLAUDE_SUBSCRIPTION_OPT_IN) {
          const parsedClaudeSubOptIn = MSG_SCHEMAS.SET_CLAUDE_SUBSCRIPTION_OPT_IN.safeParse(message);
          if (parsedClaudeSubOptIn.success) {
            try {
              setClaudeSubscriptionOptIn(parsedClaudeSubOptIn.data.value);
            } catch (err) {
              console.error("TycoonAgents: setClaudeSubscriptionOptIn failed:", err instanceof Error ? err.message : err);
            }
            this._handleGetRouting();
          } else {
            console.error("TycoonAgents: setClaudeSubscriptionOptIn payload rejected:", parsedClaudeSubOptIn.error.message);
          }
        } else if (message.type === MSG.CLEAR_AGENT_ROUTE) {
          const parsedClearAgentRoute = MSG_SCHEMAS.CLEAR_AGENT_ROUTE.safeParse(message);
          if (parsedClearAgentRoute.success) {
            void this._handleClearAgentRoute(parsedClearAgentRoute.data.agentId);
          } else {
            console.error("TycoonAgents: clearAgentRoute payload rejected:", parsedClearAgentRoute.error.message);
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
        } else if (message.type === MSG.SET_SESSION_JOURNAL_ENTRIES) {
          const parsedSetSessionJournalEntries = MSG_SCHEMAS.SET_SESSION_JOURNAL_ENTRIES.safeParse(message);
          if (parsedSetSessionJournalEntries.success) {
            this._handleSetSessionJournalEntries(parsedSetSessionJournalEntries.data.entries);
          } else {
            console.error(
              "TycoonAgents: setSessionJournalEntries payload rejected:",
              parsedSetSessionJournalEntries.error.message
            );
          }
        } else if (message.type === MSG.SET_AGENT_KEYWORDS) {
          const parsedSetAgentKeywords = MSG_SCHEMAS.SET_AGENT_KEYWORDS.safeParse(message);
          if (parsedSetAgentKeywords.success) {
            this._handleSetAgentKeywords(parsedSetAgentKeywords.data.id, parsedSetAgentKeywords.data.pattern);
          } else {
            console.error("TycoonAgents: setAgentKeywords payload rejected:", parsedSetAgentKeywords.error.message);
          }
        } else if (message.type === MSG.GET_KEYWORD_HEALTH) {
          this._postKeywordHealth();
        } else if (message.type === MSG.KEYWORD_HEALTH_FIX) {
          const parsedKeywordHealthFix = MSG_SCHEMAS.KEYWORD_HEALTH_FIX.safeParse(message);
          if (parsedKeywordHealthFix.success) {
            this._handleKeywordHealthFix(parsedKeywordHealthFix.data);
          } else {
            console.error("TycoonAgents: KEYWORD_HEALTH_FIX payload rejected:", parsedKeywordHealthFix.error.message);
          }
        } else if (message.type === MSG.REMOVE_AGENT) {
          const parsedRemoveAgent = MSG_SCHEMAS.ID_ONLY.safeParse(message);
          if (parsedRemoveAgent.success) {
            await this._handleRemoveAgent(parsedRemoveAgent.data.id);
          } else {
            console.error("TycoonAgents: removeAgent payload rejected:", parsedRemoveAgent.error.message);
          }
        } else if (message.type === MSG.OPEN_AGENT_FILE) {
          const parsedOpenAgentFile = MSG_SCHEMAS.ID_ONLY.safeParse(message);
          if (parsedOpenAgentFile.success) {
            await this._handleOpenAgentFile(parsedOpenAgentFile.data.id);
          } else {
            console.error("TycoonAgents: openAgentFile payload rejected:", parsedOpenAgentFile.error.message);
          }
        } else if (message.type === MSG.OPEN_AGENT_KEYWORDS_FILE) {
          await this._handleOpenAgentKeywordsFile();
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
        } else if (message.type === MSG.SUBMIT_FEEDBACK) {
          const parsedSubmitFeedback = MSG_SCHEMAS.SUBMIT_FEEDBACK.safeParse(message);
          if (parsedSubmitFeedback.success) {
            this._handleSubmitFeedback(parsedSubmitFeedback.data);
          } else {
            console.error("TycoonAgents: submitFeedback payload rejected:", parsedSubmitFeedback.error.message);
          }
        } else if (message.type === MSG.CONFIRM_FEEDBACK_SEND) {
          const parsedConfirmFeedbackSend = MSG_SCHEMAS.CONFIRM_FEEDBACK_SEND.safeParse(message);
          if (parsedConfirmFeedbackSend.success) {
            await this._handleConfirmFeedbackSend(parsedConfirmFeedbackSend.data.ticketId);
          } else {
            console.error(
              "TycoonAgents: confirmFeedbackSend payload rejected:",
              parsedConfirmFeedbackSend.error.message
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
        } else if (message.type === MSG.SET_PATH_OVERRIDE) {
          const parsedSetPathOverride = MSG_SCHEMAS.SET_PATH_OVERRIDE.safeParse(message);
          if (parsedSetPathOverride.success) {
            await this._handleSetPathOverride(parsedSetPathOverride.data.key, parsedSetPathOverride.data.path);
          } else {
            console.error("TycoonAgents: setPathOverride payload rejected:", parsedSetPathOverride.error.message);
          }
        } else if (message.type === MSG.CLEAR_PATH_OVERRIDE) {
          const parsedClearPathOverride = MSG_SCHEMAS.CLEAR_PATH_OVERRIDE.safeParse(message);
          if (parsedClearPathOverride.success) {
            await this._handleClearPathOverride(parsedClearPathOverride.data.key);
          } else {
            console.error("TycoonAgents: clearPathOverride payload rejected:", parsedClearPathOverride.error.message);
          }
        } else if (message.type === MSG.REFRESH_PATH_HEALTH) {
          const parsedRefreshPathHealth = MSG_SCHEMAS.REFRESH_PATH_HEALTH.safeParse(message);
          if (parsedRefreshPathHealth.success) {
            this._handleCheckInstall();
          } else {
            console.error("TycoonAgents: refreshPathHealth payload rejected:", parsedRefreshPathHealth.error.message);
          }
        } else if (message.type === MSG.COPY_PATH_DIAGNOSTIC) {
          const parsedCopyPathDiagnostic = MSG_SCHEMAS.COPY_PATH_DIAGNOSTIC.safeParse(message);
          if (parsedCopyPathDiagnostic.success) {
            await this._handleCopyPathDiagnostic();
          } else {
            console.error("TycoonAgents: copyPathDiagnostic payload rejected:", parsedCopyPathDiagnostic.error.message);
          }
        } else if (message.type === MSG.OPEN_HANDBOOK) {
          const parsedOpenHandbook = MSG_SCHEMAS.OPEN_HANDBOOK.safeParse(message);
          if (parsedOpenHandbook.success) {
            void this._handleOpenHandbook(parsedOpenHandbook.data.page, parsedOpenHandbook.data.anchor);
          } else {
            console.error("TycoonAgents: openHandbook payload rejected:", parsedOpenHandbook.error.message);
            void this._handleOpenHandbook();
          }
        } else if (message.type === MSG.GET_ENGINE_STATUS) {
          this._pollEngineStatus();
        } else if (message.type === MSG.RUN_DOCTOR) {
          this._handleRunDoctor();
        } else if (message.type === MSG.APPLY_DOCTOR_FIX) {
          const parsedApplyDoctorFix = MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse(message);
          if (parsedApplyDoctorFix.success) {
            void this._handleApplyDoctorFix(parsedApplyDoctorFix.data.removeForeign);
          } else {
            console.error("TycoonAgents: applyDoctorFix payload rejected:", parsedApplyDoctorFix.error.message);
          }
        } else if (message.type === MSG.DESIGN_DOC_ACTION) {
          await this._handleDesignDocAction((message as any).mode);
        } else if (message.type === MSG.EXPORT_TEAM_SETUP) {
          this._handleExportTeamSetup();
        } else if (message.type === MSG.APPLY_TEAM_SETUP) {
          this._handleApplyTeamSetup();
        } else if (message.type === MSG.CHECK_TEAM_READINESS) {
          void this._handleCheckTeamReadiness((message as any).payload as { probeReachability?: boolean } | undefined);
        } else if (message.type === MSG.GET_TEAM_SETUP_DRIFT) {
          this._handleGetTeamSetupDrift();
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
            await this._removeThemeRosterOrder(themeId);
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
        } else if (message.type === MSG.SAVE_ROSTER_ORDER) {
          try {
            const parsedRosterOrder = MSG_SCHEMAS.SAVE_ROSTER_ORDER.safeParse((message as any).payload);
            if (parsedRosterOrder.success) {
              await this.saveRosterOrder(parsedRosterOrder.data.themeId, parsedRosterOrder.data.rosterOrder);
            }
          } catch (err) {
            console.error("TycoonAgents: Could not persist roster order:", err);
          }
        } else if (message.type === MSG.SELECT_THEME) {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const targetThemeId = payload?.theme_id ?? "";
          const previousThemeId = this._currentThemeId;

          // Warn before switching AWAY from a theme that already has
          // unlocked badges in THIS project — each theme's progress is
          // tracked independently, so switching starts the target theme
          // fresh (its own saved progress, if any, comes back untouched).
          // The host still owns this decision (it's the only side with the
          // persisted per-project badge counts) but no longer shows its own
          // confirm dialog for it (issue #28) — that would double-prompt
          // the user on top of the webview's in-panel modal. Instead it
          // asks the webview to confirm via CONFIRM_THEME_SWITCH and does
          // NOT activate the theme yet; activation only happens if the
          // webview posts back SELECT_THEME_CONFIRMED (below).
          // A new SELECT_THEME supersedes any confirmation previously
          // offered — a second theme click invalidates the first offer, so
          // a stale SELECT_THEME_CONFIRMED for it can no longer fire.
          this._pendingThemeSwitchId = undefined;

          if (previousThemeId && previousThemeId !== targetThemeId) {
            const previousBadgeCount = (await this.getUnlockedBadges(previousThemeId)).length;
            if (shouldWarnOnThemeSwitch(previousThemeId, targetThemeId, previousBadgeCount)) {
              const themes = await listThemes(this._globalStorageUri);
              const targetName = themes.find((th) => th.theme_id === targetThemeId)?.display_name ?? targetThemeId;
              const previousName = themes.find((th) => th.theme_id === previousThemeId)?.display_name ?? previousThemeId;
              this._pendingThemeSwitchId = targetThemeId;
              void this._panel.webview.postMessage({
                type: MSG.CONFIRM_THEME_SWITCH,
                payload: { targetThemeId, targetName, previousThemeId, previousName, previousBadgeCount },
              });
              return;
            }
          }

          await this._activateTheme(targetThemeId);
        } else if (message.type === MSG.SELECT_THEME_CONFIRMED) {
          // Webview confirmed the in-panel theme-switch modal (issue #28) —
          // proceed exactly as the no-warning-needed path of MSG.SELECT_THEME
          // above does. No re-check of shouldWarnOnThemeSwitch here: the
          // webview already showed the warning and the user already agreed
          // to it for this specific target. Only activate if this matches
          // the theme actually offered via CONFIRM_THEME_SWITCH — a
          // mismatched or unsolicited confirm (nothing pending, or a stale
          // confirm superseded by a later SELECT_THEME) is ignored rather
          // than silently activating an unintended theme.
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const targetThemeId = payload?.theme_id ?? "";
          if (!this._pendingThemeSwitchId || targetThemeId !== this._pendingThemeSwitchId) {
            console.warn(
              `TycoonAgents: Ignoring SELECT_THEME_CONFIRMED for "${targetThemeId}" — no matching pending theme switch (expected "${this._pendingThemeSwitchId ?? "none"}").`,
            );
            return;
          }
          this._pendingThemeSwitchId = undefined;
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
              // themeService.ts's ThemeFileHandle is a narrower structural type
              // (pC-t1 vscode decoupling); the extension's configured
              // ThemeFileStore always hands back real vscode.Uri instances.
              const imageUri = reviewImages.imageUris[0] as unknown as vscode.Uri;
              const nativePath = nativeWindowsUserDataPath(imageUri.scheme, imageUri.path);
              const revealUri = nativePath ? vscode.Uri.file(nativePath) : imageUri;
              await vscode.commands.executeCommand("revealFileInOS", revealUri);
            } catch (err) {
              console.error("TycoonAgents: Could not reveal generated images:", err);
              const directoryUri = reviewImages.directoryUri as unknown as vscode.Uri;
              const displayPath = directoryUri.scheme === "file"
                ? directoryUri.fsPath
                : directoryUri.toString(true);
              void vscode.window.showErrorMessage(
                `TycoonAgents could not open the folder. Images are saved at: ${displayPath}`,
              );
            }
          }
        } else if (message.type === MSG.OPEN_THEME_BUILDER) {
          // p40-t3: webview -> host, no payload. The webview opens the Theme
          // Builder panel shell only after this reply. p42-t1: signedIn/
          // email/credits/pricing now come from a real Theme Service status
          // check instead of the old hardcoded { signedIn: false }.
          const parsedOpen = MSG_SCHEMAS.OPEN_THEME_BUILDER.safeParse((message as any).payload);
          if (!parsedOpen.success) return;
          // p75-t1: never await a network fetch before this first post — reply
          // immediately with the last cached snapshot (or a pending stub), then
          // refresh in the background and post THEME_SERVICE_STATUS when it
          // resolves (with "waking"/retry-backoff while the backend is asleep).
          const openStatus = this._themeServiceHost.getCachedOrPendingStatus();
          void this._panel.webview.postMessage({ type: MSG.THEME_BUILDER_OPENED, payload: openStatus });
          this._themeServiceHost.refreshStatusInBackground();
        } else if (message.type === MSG.THEME_BUILDER_CLOSED) {
          const parsedClosed = MSG_SCHEMAS.THEME_BUILDER_CLOSED.safeParse((message as any).payload);
          if (!parsedClosed.success) return;
          this._themeServiceHost.cancelBackgroundStatusRetry();
        } else if (message.type === MSG.REQUEST_THEME_SERVICE_STATUS) {
          const parsedReq = MSG_SCHEMAS.REQUEST_THEME_SERVICE_STATUS.safeParse((message as any).payload);
          if (!parsedReq.success) return;
          this._themeServiceHost.refreshStatusInBackground();
        } else if (message.type === MSG.THEME_SERVICE_GET_STATUS) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_GET_STATUS.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          await this._themeServiceHost.handleGetStatus();
        } else if (message.type === MSG.THEME_SERVICE_REQUEST_MAGIC_LINK) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_REQUEST_MAGIC_LINK.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          await this._themeServiceHost.handleRequestMagicLink(parsed.data.email);
        } else if (message.type === MSG.THEME_SERVICE_VERIFY) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_VERIFY.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          await this._themeServiceHost.handleVerify(parsed.data.email, parsed.data.code);
        } else if (message.type === MSG.THEME_SERVICE_GOOGLE_START) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_GOOGLE_START.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          const nowMs = Date.now();
          if (this._themeServiceGoogleStartInFlight && nowMs - this._themeServiceGoogleStartInFlightSince < 30_000) {
            log("panel: GOOGLE_START dropped (already in flight)");
            return;
          }
          this._themeServiceGoogleStartInFlight = true;
          this._themeServiceGoogleStartInFlightSince = nowMs;
          try {
            await this._themeServiceHost.handleGoogleStart();
          } catch (err) {
            log(`panel: THEME_SERVICE_GOOGLE_START handler threw: ${scrubOpenExternalError(err)}`);
            void this._panel.webview.postMessage({
              type: MSG.THEME_SERVICE_STATUS,
              payload: { signedIn: false, error: { kind: "browser_open_failed", message: scrubOpenExternalError(err) } },
            });
          } finally {
            this._themeServiceGoogleStartInFlight = false;
          }
        } else if (message.type === MSG.THEME_SERVICE_GOOGLE_COMPLETE) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_GOOGLE_COMPLETE.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          await this._themeServiceHost.handleGoogleComplete(parsed.data.code);
        } else if (message.type === MSG.THEME_SERVICE_GOOGLE_OPEN) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_GOOGLE_OPEN.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          // The payload's `url` (if any) is advisory only — the host always
          // re-opens the URL it stored from the matching handleGoogleStart.
          try {
            await this._themeServiceHost.handleGoogleOpen();
          } catch (err) {
            log(`panel: THEME_SERVICE_GOOGLE_OPEN handler threw: ${scrubOpenExternalError(err)}`);
            void this._panel.webview.postMessage({
              type: MSG.THEME_SERVICE_STATUS,
              payload: { signedIn: false, error: { kind: "browser_open_failed", message: scrubOpenExternalError(err) } },
            });
          }
          // p87: posts MSG.THEME_SERVICE_GOOGLE_OPENED — see
          // _postThemeServiceGoogleOpened below, wired as
          // createThemeServiceHost's postGoogleOpened option.
        } else if (message.type === MSG.THEME_SERVICE_SIGN_OUT) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_SIGN_OUT.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          await this._themeServiceHost.handleSignOut();
        } else if (message.type === MSG.THEME_SERVICE_BUY_CREDITS) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_BUY_CREDITS.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          await this._themeServiceHost.handleBuyCredits(parsed.data.pack);
        } else if (message.type === MSG.THEME_SERVICE_SET_REFERRAL_CODE) {
          const parsed = MSG_SCHEMAS.THEME_SERVICE_SET_REFERRAL_CODE.safeParse(themeServiceMessagePayload(message));
          if (!parsed.success) { logThemeServiceRejection(message.type, parsed.error); return; }
          this._themeServiceHost.handleSetReferralCode(parsed.data.code);
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
        } else if (message.type === MSG.GET_THEME_ITEM_FRAMES) {
          const parsed = MSG_SCHEMAS.GET_THEME_ITEM_FRAMES.safeParse((message as any).payload);
          if (parsed.success) {
            const { theme_id: themeId, item_id: itemId } = parsed.data;
            if (/^[a-z0-9_]+$/.test(themeId) && /^[a-z0-9_-]+$/.test(itemId)) {
              await this._postThemeItemFrames(themeId, itemId);
            }
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
          if (!parsedDescriptions.success) {
            // Previously a silent drop (webview never learns the Apply failed —
            // e.g. an over-length description, see the schema's per-kind max).
            // Reply with a THEME_ITEM_DESCRIPTIONS_RESULT error instead so the
            // Descriptions editor can surface a visible message.
            const rawThemeId = (message as any).payload?.theme_id;
            void this._panel.webview.postMessage({
              type: MSG.THEME_ITEM_DESCRIPTIONS_RESULT,
              payload: {
                ok: false,
                theme_id: typeof rawThemeId === "string" ? rawThemeId : "",
                board_id: (message as any).payload?.board_id ?? "",
                error: "One or more descriptions are invalid (e.g. too long) and were not saved.",
              },
            });
            return;
          }
          const payload = parsedDescriptions.data;
          const themeId = payload.theme_id;
          const boardId = payload.board_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          // p58-t2: whether a change entry carries a `body_plan` key at all is
          // meaningful (present-but-undefined means "Reset to auto"; absent
          // means "not touched" — see ThemeItemDescriptionChange's doc
          // comment), and zod's `.optional()` can't be trusted to preserve
          // that distinction through parsing. Check presence against the RAW
          // payload instead of the zod-validated one.
          const rawChanges = ((message as any).payload?.changes ?? []) as unknown[];
          const changes: ThemeItemDescriptionChange[] = payload.changes.map((change, index) => {
            const raw = rawChanges[index] as Record<string, unknown> | undefined;
            const out: ThemeItemDescriptionChange = {
              item_kind: change.item_kind,
              id: change.id,
              description: change.description,
            };
            if (raw && Object.prototype.hasOwnProperty.call(raw, "body_plan")) {
              out.body_plan = change.body_plan;
            }
            return out;
          });
          try {
            const result = await updateThemeItemDescriptionsBatch(
              this._globalStorageUri,
              themeId,
              changes,
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
        } else if (message.type === MSG.SET_THEME_OBJECT_TURRET) {
          // Sibling of SET_THEME_ITEM_NAMES above, but single-field/single-object
          // and fire-and-forget: no *_RESULT reply, no review resync (is_turret
          // never appears in an image prompt). Non-throwing like every handler
          // in this dispatcher — a failed write here must never crash the
          // extension host, it's Phase 2 groundwork, not a critical path.
          const parsedTurret = MSG_SCHEMAS.SET_THEME_OBJECT_TURRET.safeParse((message as any).payload);
          if (!parsedTurret.success) return;
          const payload = parsedTurret.data;
          const themeId = payload.theme_id;
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          try {
            const { manifest, frames, changed } = await setThemeObjectTurret(
              this._globalStorageUri,
              themeId,
              payload.object_id,
              payload.is_turret,
            );
            if (changed) {
              // Repost so the webview's live turretObjectIds Set (rebuilt from
              // the manifest at THEME_INITIALIZED, see media/main.js) refreshes
              // immediately — that Set is the only thing Phase 2 needs to read.
              void this._panel.webview.postMessage({
                type: MSG.THEME_INITIALIZED,
                payload: await this._buildThemeInitPayload(manifest, frames, true),
              });
            }
          } catch (err) {
            console.error("SET_THEME_OBJECT_TURRET failed:", errorMessage(err));
          }
        } else if (message.type === MSG.SET_THEME_CREATIVE_DIRECTION) {
          const parsedDirection = MSG_SCHEMAS.SET_THEME_CREATIVE_DIRECTION.safeParse((message as any).payload);
          if (!parsedDirection.success) return;
          const { theme_id: themeId, creative_direction: creativeDirection } = parsedDirection.data;
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          try {
            const result = await updateThemeCreativeDirection(this._globalStorageUri, themeId, creativeDirection);
            // No review resync here — retries always rebuild their prompt fresh
            // from the current plan at retry time, so there is no saved review
            // item to refresh (contrast SET_THEME_ITEM_DESCRIPTIONS above).
            void this._panel.webview.postMessage({
              type: MSG.THEME_CREATIVE_DIRECTION_RESULT,
              payload: { ...result, theme_id: themeId },
            });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_CREATIVE_DIRECTION_RESULT,
              payload: { ok: false, theme_id: themeId, error: errorMessage(err) },
            });
          }
        } else if (message.type === MSG.REGENERATE_THEME_DESCRIPTIONS) {
          const parsedRegenerate = MSG_SCHEMAS.REGENERATE_THEME_DESCRIPTIONS.safeParse((message as any).payload);
          if (!parsedRegenerate.success) return;
          const themeId = parsedRegenerate.data.theme_id;
          if (!/^[a-z0-9_]+$/.test(themeId)) return;
          try {
            await regenerateThemeDescriptions(this._globalStorageUri, themeId, {});
            // Same ordering as SET_THEME_ITEM_DESCRIPTIONS: refresh the review
            // payload (now carrying the new descriptions and a cleared
            // descriptionsStale flag) BEFORE the *_RESULT reply.
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: MSG.THEME_DESCRIPTIONS_REGENERATE_RESULT,
              payload: { ok: true, theme_id: themeId },
            });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_DESCRIPTIONS_REGENERATE_RESULT,
              payload: { ok: false, theme_id: themeId, error: errorMessage(err) },
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
            void this._panel.webview.postMessage({
              type: MSG.THEME_CHARACTER_NORMALIZE_STATE,
              payload: { item_id: itemId, busy: true, message: "Regenerating at the standard character scale..." },
            });
            const result = await normalizeThemeCharacterAtlas(
              this._globalStorageUri,
              themeId,
              itemId,
              {
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
                signal: retryingDuringActiveGeneration ? this._themeGenerationAbortController?.signal : undefined,
              },
              (message) => void this._panel.webview.postMessage({
                type: MSG.THEME_IMAGE_RETRY_STATE,
                payload: { item_id: itemId, busy: true, message },
              }),
              // Per-frame regeneration (feedback #18): absent/empty is the
              // regression guarantee — retryThemeImage treats that identically
              // to a full-board replace, unchanged from before this field
              // existed.
              payload.slots,
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
            // Rejections from the Theme Service (kind/status/backend code)
            // previously left no host-side trace — this is a bare 400 the
            // backend rejects before its own attempt log line, so this was
            // the only place the reason could ever surface. No user content
            // (prompt/theme text) is included, only the error's own fields.
            if (isThemeGenerationServiceError(err)) {
              log(`theme image generate/retry rejected: kind=${err.kind} status=${err.status ?? "unknown"} code=${err.code ?? "none"}`);
            } else {
              log(`theme image generate/retry failed: ${err instanceof Error ? err.constructor.name : typeof err}`);
            }
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
          const payload = (message as any).payload as { prompt?: string; image_provider?: string; requestId?: number } | undefined;
          // p86: echoed back on THEME_PLAN_READY/THEME_PLAN_ERROR so the
          // webview can drop a reply for a request it has since superseded
          // (a new PLAN_THEME, or the draft being cleared) instead of
          // overwriting the plan currently on screen with a stale one.
          const requestId = payload?.requestId;
          try {
            if (this._themeGenerationActive) throw new Error("Wait for the current theme generation to finish before planning another theme.");
            const prompt = payload?.prompt?.trim() ?? "";
            if (!prompt) throw new Error("Enter a theme name or description first.");
            // payload.image_provider is unused now — planning routes through
            // the Theme Service (p43-t7), not a user-chosen text provider.
            // p85: log start + outcome (names/codes only, never prompt text,
            // tokens, or emails) — previously a PLAN_THEME failure logged
            // nothing at all on the host, making "Generate with AI does
            // nothing" unreproducible from host output.
            console.log("TycoonAgents: PLAN_THEME request starting.");
            const plan = await planTheme(prompt, {});
            console.log("TycoonAgents: PLAN_THEME request succeeded.");
            void this._panel.webview.postMessage({
              type: MSG.THEME_PLAN_READY,
              payload: { plan, ...(requestId !== undefined ? { requestId } : {}) },
            });
          } catch (err) {
            // p65-t3: carry the Theme Service error kind (e.g. "not_signed_in")
            // through so the webview can render a Sign in affordance instead
            // of raw error text — see ThemePlanServiceError in translator.ts.
            const kind = isThemePlanServiceError(err) ? err.kind : undefined;
            // p86: surface refunded so the webview can say so instead of a
            // bare "Error: ..." when the backend refunded a charged credit
            // (provider failure / incomplete AI output).
            const refunded = isThemePlanServiceError(err) ? err.refunded : undefined;
            console.error("TycoonAgents: PLAN_THEME request failed.", { kind: kind ?? "unknown" });
            void this._panel.webview.postMessage({
              type: MSG.THEME_PLAN_ERROR,
              payload: {
                message: String(err),
                ...(kind ? { kind } : {}),
                ...(refunded !== undefined ? { refunded } : {}),
                ...(requestId !== undefined ? { requestId } : {}),
              },
            });
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
            if (resumeThemeId) {
              generatedThemeId = resumeThemeId;
              this._themeGenerationThemeId = resumeThemeId;
              // Awaited: serialized through themeImageReviewState.ts's
              // per-theme write queue, but still awaited here so this status
              // write is definitely ENQUEUED (and, in practice, landed)
              // before generation proceeds to its first item upsert.
              await setThemeGenerationStatus(this._globalStorageUri, resumeThemeId, "active");
            }
            this._themePauseForReview = payload?.pause_for_review !== false;
            const onProgress = (msg: string) => void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_PROGRESS,
              payload: { message: msg },
            });
            const onReviewReady = async (themeId: string) => {
              generatedThemeId = themeId;
              this._themeGenerationThemeId = themeId;
              // Awaited for the same reason as the resume path above; the
              // caller (generateThemeService/resumeThemeGeneration) invokes
              // this fire-and-forget (`onReviewReady?.(themeId)`) and never
              // awaits it itself, but the per-theme write queue still
              // guarantees this write is ordered before any upsert this
              // handler's own subsequent awaits trigger.
              await setThemeGenerationStatus(this._globalStorageUri, themeId, "active");
              void this._panel.webview.postMessage({ type: MSG.THEME_REVIEW_READY, payload: { theme_id: themeId } });
            };
            const imageOptions = {
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
            if (generatedThemeId) await setThemeGenerationStatus(this._globalStorageUri, generatedThemeId, "completed");
            void this._panel.webview.postMessage({
              type: MSG.THEME_INITIALIZED,
              payload: await this._buildThemeInitPayload(r.manifest, r.frames, true),
            });
          } catch (err) {
            if (generatedThemeId) await setThemeGenerationStatus(this._globalStorageUri, generatedThemeId, "stopped");
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
            this._themeGenerationThemeId = undefined;
            if (this._themeGenerationAbortController === abortController) {
              this._themeGenerationAbortController = undefined;
            }
            if (generatedThemeId) await this._postThemeImageReview(generatedThemeId);
          }
        } else if (message.type === MSG.SAVE_THEME_PLAN) {
          const parsedSavePlan = MSG_SCHEMAS.SAVE_THEME_PLAN.safeParse(themeServiceMessagePayload(message));
          if (!parsedSavePlan.success) {
            logThemeServiceRejection(MSG.SAVE_THEME_PLAN, parsedSavePlan.error);
            void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_ERROR,
              payload: { message: "Invalid theme plan." },
            });
            return;
          }
          try {
            const { theme_id, plan } = await saveThemePlan(
              this._globalStorageUri,
              parsedSavePlan.data.plan as Partial<ThemePlan>,
              parsedSavePlan.data.theme_id,
            );
            const savedBoardCounts = await getThemeBoardCounts(this._globalStorageUri, theme_id);
            void this._panel.webview.postMessage({
              type: MSG.THEME_PLAN_SAVED,
              payload: { theme_id, plan, ...savedBoardCounts },
            });
            const themes = await listThemes(this._globalStorageUri);
            void this._panel.webview.postMessage({ type: MSG.THEMES_LIST, payload: { themes } });
            // p79-t2: re-saving an existing theme's plan (including the
            // redesigned builder's autosave-after-every-upload) can change
            // board display labels/prompts in review.json — re-post
            // THEME_IMAGE_REVIEW so the board grid re-renders with them.
            await this._postThemeImageReview(theme_id);
          } catch (err) {
            void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_ERROR,
              payload: { message: errorMessage(err) },
            });
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
            const onProgress = (msg: string) => void this._panel.webview.postMessage({
              type: MSG.THEME_GENERATION_PROGRESS,
              payload: { message: msg },
            });
            const imageOptions = {};
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
            // Generation-aware gating: a "no frames" issue should only fire for a
            // board the user has actually ACCEPTED in review — a board still
            // pending/rejected mid-generation legitimately has no frames yet.
            // acceptedFrameKeysForHealthCheck (themeService.ts) sources each
            // accepted board's keys from the CURRENT plan's EXPECTED board
            // contract rather than the accepted item's own saved frame_keys field:
            // a legacy pre-review theme's inferred review item persists
            // frame_keys: [] for every non-character board, so reading the saved
            // field would silently exclude accepted object/expression/badge
            // boards from the set and reintroduce the 0.0.384
            // accepted-but-frameless bug for exactly that population. It is
            // read-only (never persists anything) as a health-check side effect.
            const acceptedFrameKeys = await acceptedFrameKeysForHealthCheck(this._globalStorageUri, themeId);
            const issues = validateThemeIntegrity(t.manifest, t.frames, { acceptedFrameKeys });
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
          const approvedPhase = updatedPlan.phases.find((p) => p.id === parsedApprovePhase.data.phaseId);
          if (approvedPhase) {
            appendGateEvent(root, {
              ts: new Date().toISOString(),
              phaseId: approvedPhase.id,
              phaseNum: approvedPhase.num,
              name: approvedPhase.name,
              gate: "approved",
              source: "panel",
            });
          }
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
            // explicit user action on the install button. Still logged on
            // failure (never silently swallowed) — no stamp tracks this
            // skill's freshness, so a failure here simply means the next
            // panel open / toggle retries the copy.
            const enableResult = this._installProjectPlanSkill(root);
            if (!enableResult.ok && enableResult.failed.length > 0) {
              console.error(
                "TycoonAgents: project-plan skill install (via enable toggle) had failures:",
                enableResult.failed
              );
            }
          }
          // Re-render the managed CLAUDE.md doctrine so the "Project Plan
          // routing" section appears/disappears immediately on toggle,
          // rather than waiting for the next _ensureDelegationDoctrineCurrent
          // auto-heal on panel reopen. Gated on hooks being installed for
          // this root (same consent proxy _ensureDelegationDoctrineCurrent
          // uses) — best-effort, never blocks PLAN_STATE below.
          if (this._hooksInstalledForRoot(root)) {
            try {
              const claudeDir = path.join(root, ".claude");
              const { delegation_mode, reviewEnabled, sessionJournalEntries } = readExecutionConfig(claudeDir);
              const claudeMdPath = path.join(root, "CLAUDE.md");
              let existingClaudeMd: string | null = null;
              try {
                existingClaudeMd = fs.readFileSync(claudeMdPath, "utf8");
              } catch {
                existingClaudeMd = null;
              }
              const updated = this._buildClaudeMdDoctrine(
                existingClaudeMd,
                delegation_mode,
                reviewEnabled ?? true,
                root,
                sessionJournalEntries ?? 3
              );
              if (existingClaudeMd === null || updated !== existingClaudeMd) {
                fs.writeFileSync(claudeMdPath, updated);
              }
            } catch (err) {
              console.error("TycoonAgents: CLAUDE.md refresh after Project Plan toggle failed:", err);
            }
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
              // MSG.PLAN_STATE has no text field to surface this on (see
              // messages.ts's PLAN_STATE schema) — logged only.
              writePreRestoreSnapshot(root, projectPlanFilePath(root));
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

    // p74-t1: re-post the Agents payload (MSG.ROUTING) when the
    // multiProvider setting changes from OUTSIDE the panel (e.g. the VS
    // Code Settings UI), so an already-open Agents screen flips modes
    // without needing a manual refresh.
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("tycoonagents.agents.multiProvider")) {
          this._handleGetRouting();
        }
      })
    );
  }

  // --- Theme Service Google sign-in loading state (p87) -------------------
  /**
   * Posts MSG.THEME_SERVICE_GOOGLE_OPENED to the webview once
   * handleGoogleStart's openExternal settles (success or failure), or
   * handleGoogleStart itself fails before reaching it — wired as
   * createThemeServiceHost's postGoogleOpened option. Never carries token
   * material.
   */
  private _postThemeServiceGoogleOpened(result: { ok: boolean; error?: { kind: string; message: string } }): void {
    void this._panel.webview.postMessage({ type: MSG.THEME_SERVICE_GOOGLE_OPENED, payload: result });
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

  // --- Roster order persistence -----------------------------------------
  // Per-theme character roster order (drag-reorder in the "Character roster
  // order" modal section, including Seat-1 leader assignment — leader-ness
  // is derived purely from rosterOrder[0] in the webview, see main.js
  // isLeaderEntry). Previously this lived ONLY in vscode.setState, which is
  // wiped on a full VS Code reload. Mirrors the build-progress persistence
  // above exactly (file-based, composite-keyed by project+theme).
  private _rosterOrderUri(): vscode.Uri {
    return vscode.Uri.joinPath(this._globalStorageUri, "roster-order.json");
  }

  private async _readRosterOrderStore(): Promise<Record<string, string[]>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._rosterOrderUri());
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async _writeRosterOrderStore(store: Record<string, string[]>): Promise<void> {
    try {
      await vscode.workspace.fs.writeFile(
        this._rosterOrderUri(),
        Buffer.from(JSON.stringify(store, null, 2), "utf8"),
      );
    } catch (err) {
      console.error("TycoonAgents: Could not save roster order:", err);
    }
  }

  private async getRosterOrder(themeId: string | undefined): Promise<string[] | null> {
    if (!themeId) return null;
    const store = await this._readRosterOrderStore();
    const { value, store: migratedStore, migrated } = readCompositeWithMigration(
      store,
      this._projectScopeKey(),
      themeId,
    );
    if (migrated) await this._writeRosterOrderStore(migratedStore);
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : null;
  }

  private async saveRosterOrder(themeId: string, order: unknown): Promise<void> {
    if (!themeId) return;
    // Sanitize: array of strings only, capped to a sane length — mirrors
    // saveBuildProgress's clamp of its own payload before it ever touches disk.
    const sanitized = (Array.isArray(order) ? order : [])
      .filter((id): id is string => typeof id === "string")
      .slice(0, 64);
    const store = await this._readRosterOrderStore();
    await this._writeRosterOrderStore(writeComposite(store, this._projectScopeKey(), themeId, sanitized));
  }

  /**
   * Fully removes a theme's saved roster order (legacy key + every project's
   * composite key) — used when the theme itself is deleted from disk.
   */
  private async _removeThemeRosterOrder(themeId: string): Promise<void> {
    if (!themeId) return;
    const store = await this._readRosterOrderStore();
    const next = removeThemeEverywhere(store, themeId);
    if (next !== store) await this._writeRosterOrderStore(next);
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
    savedRosterOrder: string[] | null;
    hasBoards: boolean;
    boardCount: number;
  }> {
    this._currentThemeId = manifest?.theme_id;
    const boardCounts = themeBoardCountsFromFrames(frames);
    return {
      manifest,
      frames,
      is_editor_mode: isEditorMode,
      unlocked_badge_ids: await this.getUnlockedBadges(manifest?.theme_id),
      rebirth_state: await this.getRebirthState(manifest?.theme_id),
      savedBuildProgress: await this.getBuildProgress(manifest?.theme_id),
      savedRosterOrder: await this.getRosterOrder(manifest?.theme_id),
      ...boardCounts,
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

  /**
   * Theme Builder review animation preview (leaf task, see media 020/060):
   * THEME_IMAGE_REVIEW only ships the FIRST frame per key for multi-key
   * boards (rivals/objects/decor), so the preview asks for the rest
   * on-demand. Reads the same `loadedTheme.frames` map
   * `_postThemeImageReview`'s frame_slots reads (frame_slots comment above,
   * ~L3744), which is why pending (not-yet-approved) sliced frames come
   * through automatically: loadTheme's frames map always reflects the
   * latest stored slice for a key, approved or not — approval only flips
   * item status, it doesn't move frame data.
   */
  private async _postThemeItemFrames(themeId: string, itemId: string): Promise<void> {
    try {
      const review = await getThemeImageReview(this._globalStorageUri, themeId);
      const loadedTheme = await loadTheme(this._globalStorageUri, themeId);
      const entry = review?.entries?.find((e) => e.item.id === itemId);
      const keys = entry?.item.frame_keys ?? [];
      const frames: Record<string, string[]> = {};
      for (const key of keys) {
        frames[key] = (loadedTheme?.frames?.[key] ?? []).map((data) => data ?? "");
      }
      void this._panel.webview.postMessage({
        type: MSG.THEME_ITEM_FRAMES,
        payload: { theme_id: themeId, item_id: itemId, frames },
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.THEME_ITEM_FRAMES,
        payload: { theme_id: themeId, item_id: itemId, frames: {}, error: String(err) },
      });
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
      const backgroundMode = boardBackgroundModeForProvider();
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
          // Bug fix (v0.0.661 follow-up): error_kind:"not_signed_in" is
          // persisted to disk per item (setThemeImageReviewErrorKind) from
          // an earlier failed attempt and is only ever cleared by a later
          // successful attempt on that item — never by signing back in. A
          // definitively signed-in cached status means it is stale, so it
          // must not reach the webview and reintroduce a "Sign in" card the
          // user has already resolved.
          // Review fix (session-stamp, replacing the earlier per-instance
          // Set gate — that gate missed a fresh first-time generation
          // failure: generateAndReviewThemeItem posts no THEME_IMAGE_REVIEW
          // before its own failure, so that failure's FIRST post already
          // carried a live error and the Set wrongly dropped it): a
          // TRANSIENT error_kind (unavailable/unreachable/rate_limited/
          // provider_failed — see isTransientThemeImageReviewErrorKind's
          // doc comment) is dropped only when its item.error_session is
          // MISSING or differs from THEME_SERVICE_HOST_SESSION_ID (this
          // run's id, set once at module load — src/extension/themeServiceHostSession.ts).
          // Every transient error_kind write (setThemeImageReviewErrorKind,
          // called from recordUserCorrectableGenerationError — covers both
          // a fresh generation failure and a retry failure) stamps the
          // CURRENT id, so a failure recorded THIS run always matches and is
          // shown with its real message; one left over from an earlier
          // process (a genuine reload/restart, new id each activation)
          // never matches and is dropped. Durable kinds are unaffected.
          error_kind: item.error_kind === "not_signed_in" && this._themeServiceHost.getCachedOrPendingStatus().signedIn === true
            ? undefined
            : (isTransientThemeImageReviewErrorKind(item.error_kind) && item.error_session !== THEME_SERVICE_HOST_SESSION_ID)
              ? undefined
              : item.error_kind,
          currentPrompt,
          generated,
          // Only sliced atlas boards can be re-sliced; environment boards normalize a
          // single image, so they never carry a re-sliceable raw atlas.
          has_raw_atlas: item.kind === "environment"
            ? false
            : await this._uriExists(vscode.Uri.joinPath(rawDirectoryUri, item.filename)),
          // Per-frame regeneration (feedback #18): normally one entry per
          // frame_keys[i], using that key's first stored image as the
          // representative thumbnail (a clip key like "rival_x" holds several
          // animation frames under one key — the whole clip is the
          // addressable "slot" server-side, so one thumbnail per key is
          // enough for the picker UI). Absent/empty frames for a key render
          // as no thumbnail; the webview shows those as blank. Meaningful for
          // sliced atlas boards with >1 key — environment/single-key boards
          // with only one stored frame still get a 1-entry array, which the
          // webview simply won't render a picker for (see
          // renderThemeReviewFrameGrid).
          //
          // Character boards are the one exception: they own exactly ONE
          // frame_keys entry, but that single key's stored array holds all
          // 16 poses (see themeService.ts's character_atlas branch of
          // applySlicedAtlasFromBuffer). Emitting one key-level entry there
          // would always yield a 1-entry array and the grid would never show
          // (slots.length < 2 gate in buildThemeReviewFrameGrid) — so for
          // this shape, enumerate WITHIN-key frames instead: one entry per
          // stored pose, each carrying the same `key` plus its own `index`
          // into that key's array. `index` is 0/omitted for the normal
          // one-entry-per-key case so multi-key boards are unaffected, and
          // retryThemeImage below distinguishes the two shapes the same way
          // (single key, multiple stored frames) rather than trusting a flag
          // from the client.
          frame_slots: (() => {
            const keys = item.frame_keys ?? [];
            if (keys.length === 1) {
              const soleKeyFrames = loadedTheme?.frames?.[keys[0]] ?? [];
              if (soleKeyFrames.length > 1) {
                return soleKeyFrames.map((data, index) => ({ key: keys[0], index, data: data ?? "" }));
              }
            }
            return keys.map((key) => ({
              key,
              data: loadedTheme?.frames?.[key]?.[0] ?? "",
            }));
          })(),
          image_src: imageUri
            ? this._panel.webview.asWebviewUri(
                // See the ThemeFileHandle note above: the extension's store
                // always hands back real vscode.Uri instances here.
                (imageUri as unknown as vscode.Uri).with({
                  query: `revision=${item.revision}&updated=${encodeURIComponent(item.updated_at)}`,
                }),
              ).toString()
            : "",
        };
      }));
      // p80: a persisted "active" run with no matching in-memory run means
      // the extension closed mid-generation — treat it as interrupted, same
      // as an explicit "stopped", PROVIDED at least one board is still
      // unfinished (an interrupted run whose last board just happened to
      // finish first isn't resumable — there's nothing left to resume).
      const generationStatus = review.generation?.status ?? "idle";
      const inMemoryRunForThisTheme = this._themeGenerationActive && this._themeGenerationThemeId === themeId;
      const hasUnfinishedItem = items.some((item) => !item.generated);
      const generationResumable = (
        generationStatus === "stopped" || (generationStatus === "active" && !inMemoryRunForThisTheme)
      ) && hasUnfinishedItem;
      void this._panel.webview.postMessage({
        type: MSG.THEME_IMAGE_REVIEW,
        payload: {
          theme_id: review.theme_id,
          display_name: review.display_name,
          generation_active: this._themeGenerationActive,
          generation_status: generationStatus,
          generation_resumable: generationResumable,
          pause_for_review: this._themePauseForReview,
          waiting_for_review_item_id: this._themeGenerationReviewGate?.themeId === themeId
            ? this._themeGenerationReviewGate.itemId
            : undefined,
          // Prefills the post-generation "Creative Direction" editor on the
          // environment/background board card (see buildThemeReviewCreativeDirectionSection
          // in media/main.js). Sourced from the same currentPlan this function
          // already loads for currentPrompt, so it's always the freshest saved value.
          creative_direction: currentPlan?.creative_direction,
          // Lets the webview show a stale-descriptions marker + re-derive
          // button (media/main.js) when the direction has been edited since
          // descriptions were last (re)generated — see themeDescriptionsStale.
          descriptionsStale: currentPlan ? themeDescriptionsStale(currentPlan) : false,
          descriptionsDirection: currentPlan?.descriptions_direction,
          creditsSpent: review.creditsSpent,
          items,
          ...themeBoardCountsFromFrames(loadedTheme?.frames),
        },
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.THEME_IMAGE_REVIEW,
        payload: { theme_id: themeId, items: [], error: String(err), hasBoards: false, boardCount: 0 },
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
        summary?: string;
        mcpNote?: string;
        thirdParty?: boolean;
        source?: string;
      }>;
      const skills = catalog.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        summary: catalogSummary(entry),
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
    summary?: string;
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
    platforms?: McpPlatformsEntry["platforms"];
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
      summary: catalogSummary(e),
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

      const platformConfig = resolveConfigForPlatform(entry, process.platform);
      if (!platformConfig.ok) {
        void this._panel.webview.postMessage({
          type: MSG.MCP_INSTALLED,
          id,
          ok: false,
          error: platformConfig.error,
        });
        return;
      }
      const resolvedConfig = this._resolveConfigTokens(platformConfig.config);
      if (/<[^<>]*>/.test(JSON.stringify(resolvedConfig))) {
        void this._panel.webview.postMessage({
          type: MSG.MCP_INSTALLED,
          id,
          ok: false,
          error:
            `${id} is provided by Trashbyrd's Power Tools — install it separately and add the entry to your own ` +
            ".mcp.json; see .mcp.json.example.",
        });
        return;
      }

      const finalConfig = withDispatcherProjectDir(id, this._resolveCodexBinaryForInstall(id, resolvedConfig), root);
      const merged = mergeMcpServer(existing, id, finalConfig);
      fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
      this._copyBridgeHooksForMcp(root, finalConfig);
      // Auto-approve the newly-added server so `claude mcp list` doesn't
      // leave it "Pending approval" (which times out non-interactive
      // sessions) — see enableMcpJsonServerInSettings (hookInstall.ts).
      enableMcpJsonServerInSettings(path.join(root, ".claude"), id);
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
        const packCommands: string[] = Array.isArray(pack.commands) ? pack.commands : [];
        const packAgents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
        const skills = packSkills.map((id: string) => ({
          id,
          name: skillNames[id] ?? id,
          installed: skillInstalled(id),
        }));
        // Name lookup regardless of thirdParty status (disclosures above only
        // cover third-party servers) - the Setup Wizard's package checkbox
        // list (media/main.js renderSetupOptionals/describePackageInstalls)
        // shows "MCP server: <name>" for bundled/local servers too (e.g.
        // uefn-bridge), so the transparency isn't limited to disclosed ones.
        const mcpEntry = pack.mcp ? mcpCatalog.find((x: any) => x.id === pack.mcp) : undefined;
        return {
          id: pack.id,
          name: pack.name,
          description: pack.description,
          summary: catalogSummary(pack),
          has: { skill: packSkills.length > 0, mcp: !!pack.mcp, agent: true },
          installed: {
            skill: packSkills.length > 0 && packSkills.every((id: string) => skillInstalled(id)),
            mcp: pack.mcp ? hasMcpServer(mcpConfig, pack.mcp) : false,
            agent: (() => {
              return root !== "" && packAgents.length > 0 && packAgents.every((a: any) => fs.existsSync(path.join(root, ".claude", "agents", `${a.id}.md`)));
            })(),
          },
          skills,
          // Slash commands, agent identities, and MCP server name - all
          // sourced straight from the catalog entry so the onboarding "what
          // it installs" copy (media/main.js describePackageInstalls) never
          // hardcodes per-pack prose and stays correct as packs change.
          commands: packCommands,
          agents: packAgents.map((a: any) => ({ id: a.id, name: a.name })),
          mcpName: mcpEntry ? (mcpEntry.name ?? pack.mcp) : undefined,
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
  private _buildPackConfirmMessage(packName: string, disclosures: any[]): string {
    const networked = disclosures.filter((d) => d && d.network);
    const lines: string[] = [];
    lines.push(`Install ${packName || "this pack"}?`);
    lines.push("");
    lines.push("This installs third-party software that runs on your machine:");
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
   * Install (or refresh) every Claude Code slash command a pack ships (a
   * pack's optional `commands` catalog array — generic across ALL packs,
   * not UEFN-specific; driven purely by whatever ids a pack's `commands`
   * array lists). Mirrors the skills-install step immediately above it in
   * `_handleInstallPack`: one file per id, copied from
   * `media/commands/<id>.md` into `<root>/.claude/commands/<id>.md`. A file
   * is written only when absent or when its content differs from the
   * shipped source (content-diff, same convention `_stageSkillTree` and
   * `_stageBridgeTo` use) — previously this skipped re-copying forever once
   * the destination file existed at all, the same write-once bug
   * `_stageSkillTree`'s doc comment describes for skills, so a shipped
   * command's content could never reach an already-installed project on
   * either an explicit reinstall or `_ensureInstalledPacksFresh`'s
   * panel-open auto-heal (which calls this same method). Each id is
   * handled in its own try/catch so one failure (e.g. a missing shipped
   * source file) can't abort the rest of the commands, or the rest of the
   * pack install that called this.
   */
  private _installPackCommands(
    root: string,
    packCommands: string[]
  ): Array<{ id: string; status: "installed" | "updated" | "unchanged" | "error"; error?: string }> {
    const results: Array<{ id: string; status: "installed" | "updated" | "unchanged" | "error"; error?: string }> = [];
    for (const commandId of packCommands) {
      try {
        const target = path.join(root, ".claude", "commands", `${commandId}.md`);
        const src = path.join(this._extensionUri.fsPath, "media", "commands", `${commandId}.md`);
        const srcContent = fs.readFileSync(src, "utf8");
        let destContent: string | undefined;
        try {
          destContent = fs.readFileSync(target, "utf8");
        } catch {
          destContent = undefined;
        }
        if (destContent === undefined) {
          fs.mkdirSync(path.join(root, ".claude", "commands"), { recursive: true });
          fs.writeFileSync(target, srcContent);
          results.push({ id: commandId, status: "installed" });
        } else if (destContent !== srcContent) {
          fs.writeFileSync(target, srcContent);
          results.push({ id: commandId, status: "updated" });
        } else {
          results.push({ id: commandId, status: "unchanged" });
        }
      } catch (e) {
        results.push({ id: commandId, status: "error", error: String(e) });
      }
    }
    return results;
  }

  /** Install a pack: its skills, commands, MCP server, and agent files. */
  private async _handleInstallPack(
    id: string,
    thirdParty = false,
    passedDisclosures?: any[]
  ): Promise<void> {
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
          this._buildPackConfirmMessage(pack.name, disclosures) + conflictWarning,
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
        // Content-diff copy (see _stageSkillTree) rather than the old
        // "the target directory exists at all -> skip forever" check — that
        // check made a skill directory a WRITE-ONCE artifact: once
        // `.claude/skills/<skillId>` existed, no later re-install (explicit
        // click here, or the panel-open auto-heal in
        // _ensureInstalledPacksFresh, which calls the same helper) ever
        // re-copied newer files the shipped skill had grown since. Status is
        // now per-file-outcome: "installed" if any new file was written,
        // "updated" if any existing file's content changed, else
        // "unchanged". `_stageSkillTree` never throws — a per-file failure
        // comes back in `failed` (see its doc comment) rather than a swallowed
        // console.error, so it's surfaced here as `error` naming every
        // failing path rather than a silently-honest-looking status.
        const skillResults: Array<{ id: string; status: "installed" | "updated" | "unchanged"; error?: string }> = [];
        for (const skillId of packSkills) {
          try {
            const { staged, updated, failed } = this._stageSkillTree(skillId, root);
            skillResults.push({
              id: skillId,
              status: staged > 0 ? "installed" : updated > 0 ? "updated" : "unchanged",
              ...(failed.length > 0
                ? { error: failed.map((f) => `${f.path}: ${f.error}`).join("; ") }
                : {}),
            });
          } catch (e) {
            skillResults.push({ id: skillId, status: "unchanged", error: String(e) });
          }
        }
        results.skills = skillResults;
      }
      const packCommands: string[] = Array.isArray(pack.commands) ? pack.commands : [];
      if (packCommands.length > 0) {
        results.commands = this._installPackCommands(root, packCommands);
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
          const platformConfig = resolveConfigForPlatform(entry, process.platform);
          const resolvedConfig = platformConfig.ok ? this._resolveConfigTokens(platformConfig.config) : undefined;
          if (!platformConfig.ok) {
            results.mcp = { status: "skipped", error: platformConfig.error };
          } else if (/<[^<>]*>/.test(JSON.stringify(resolvedConfig))) {
            results.mcp = {
              status: "skipped",
              error:
                `${pack.mcp} is provided by Trashbyrd's Power Tools — install it separately and add the entry to ` +
                "your own .mcp.json; see .mcp.json.example.",
            };
          } else {
            const finalConfig = withDispatcherProjectDir(pack.mcp, this._resolveCodexBinaryForInstall(pack.mcp, resolvedConfig), root);
            const merged = mergeMcpServer(existing, pack.mcp, finalConfig);
            fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
            this._copyBridgeHooksForMcp(root, finalConfig);
            // Auto-approve so `claude mcp list` doesn't leave the pack's
            // server "Pending approval" for non-interactive sessions.
            enableMcpJsonServerInSettings(path.join(root, ".claude"), pack.mcp);
            results.mcp = "installed";
          }
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
      const agentResults: Array<{ id: string; status: "created" | "refreshed" | "unchanged" | "replaced-legacy" | "skipped" | "error"; error?: string }> = [];
      let cfg = this._readKeywordsConfig(root);
      const packHarness = this._resolveEffectiveHarness(root);
      const packClaudeOptIn = readClaudeSubscriptionOptIn();
      for (const a of agents) {
        if (shouldSkipPackAgentForClaudeSubscription(packHarness, packClaudeOptIn, a.backend)) {
          agentResults.push({ id: a.id, status: "skipped", error: claudeSubscriptionBlockedMessage(`skipped: ${a.name || a.id}`) });
          continue;
        }
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
            } else if (workerAgentFingerprintMatches(existingContent, a)) {
              // No tycoon_pack marker (predates it, or predates `name:`/
              // `description:`/a valid `model:` alias entirely), but the
              // `model:` alias + exact `## Keywords (for task routing)` body
              // fingerprint it as ours — repair frontmatter only, preserving
              // the rest byte-for-byte, rather than backing up and replacing
              // the whole file as the true-foreign branch below does.
              const repaired = resyncAgentFrontmatterFields(existingContent, a);
              if (repaired !== null) {
                fs.writeFileSync(agentPath, repaired);
                agentResults.push({ id: a.id, status: "refreshed" });
              } else {
                agentResults.push({ id: a.id, status: "unchanged" });
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

      this._panel.webview.postMessage({ type: MSG.PACK_INSTALLED, id, ok: true, results });
      return;
    } catch (e) {
      this._panel.webview.postMessage({ type: MSG.PACK_INSTALLED, id, ok: false, error: String(e) });
      return;
    }
  }

  /**
   * Remove an installed pack: its skills, commands, MCP server, and agent
   * files. Mirrors `_handleInstallPack` but in reverse. Skills, commands, and
   * the MCP server are SHARED components — before deleting one, we check
   * whether ANOTHER pack in the catalog also lists that same id and still has
   * any of its components installed; if so we SKIP the delete so we don't
   * break that pack. Agents are pack-specific and are always removed (file +
   * agent-keywords.json entry). Gated behind a native modal. Responds with
   * `{ type:"packRemoved", id, ok, results:{skills, commands, mcp, agents} }`.
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
      const packCommands: string[] = Array.isArray(pack.commands) ? pack.commands : [];
      const packAgents: any[] = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
      const packMcp: string | undefined = pack.mcp || undefined;

      // Build the confirmation summary.
      const parts: string[] = [];
      parts.push(`${packSkills.length} ${packSkills.length === 1 ? "skill" : "skills"}`);
      if (packCommands.length > 0) {
        parts.push(`${packCommands.length} ${packCommands.length === 1 ? "command" : "commands"}`);
      }
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
      const commandOnDisk = (cid: string): boolean =>
        fs.existsSync(path.join(root, ".claude", "commands", `${cid}.md`));
      const agentOnDisk = (aid: string): boolean =>
        fs.existsSync(path.join(root, ".claude", "agents", `${aid}.md`));
      const mcpConfigNow = (): Record<string, unknown> => this._readMcpConfig(path.join(root, ".mcp.json"));
      const packStillInstalled = (p: any): boolean => {
        const sk: string[] = Array.isArray(p.skills) ? p.skills : [];
        const cm: string[] = Array.isArray(p.commands) ? p.commands : [];
        const ag: any[] = Array.isArray(p.agents) ? p.agents : (p.agent ? [p.agent] : []);
        if (sk.some((s) => skillOnDisk(s))) return true;
        if (cm.some((c) => commandOnDisk(c))) return true;
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

      // Commands (generic — driven by whatever ids the pack's `commands`
      // array lists; mirrors the skills removal above exactly).
      const commandResults: Array<{ id: string; status: "removed" | "kept-shared" | "absent" }> = [];
      for (const commandId of packCommands) {
        const target = path.join(root, ".claude", "commands", `${commandId}.md`);
        if (!fs.existsSync(target)) {
          commandResults.push({ id: commandId, status: "absent" });
          continue;
        }
        const shared = sharedByOtherPack((p) => Array.isArray(p.commands) && p.commands.includes(commandId));
        if (shared) {
          commandResults.push({ id: commandId, status: "kept-shared" });
        } else {
          fs.rmSync(target, { force: true });
          commandResults.push({ id: commandId, status: "removed" });
        }
      }
      results.commands = commandResults;

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
   * (e.g. from the checkbox handler and the panel-open auto-heal).
   *
   * Returns per-file failures explicitly (mirroring `_stageBridgeTo`'s
   * honesty) instead of collapsing them into a single "does the destination
   * directory exist and have SOMETHING in it" boolean — that check used to
   * read a partial copy (e.g. 3 of 5 files landed, 2 failed) as full
   * success. `ok` is true only when the destination is non-empty AND no
   * file failed to copy this run; callers must surface `failed` (path +
   * `describeFsError`-classified error) rather than treating `ok: false`
   * with an empty `failed` list (destination genuinely empty/missing) the
   * same as a partial-copy failure.
   */
  private _installProjectPlanSkill(root: string): { ok: boolean; failed: { path: string; error: string }[] } {
    const src = path.join(this._extensionUri.fsPath, "media", "skills", "project-plan");
    const dest = path.join(root, ".claude", "skills", "project-plan");
    const failed: { path: string; error: string }[] = [];

    const copyRecursive = (srcDir: string, destDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true });
      } catch (e) {
        console.error("TycoonAgents: _installProjectPlanSkill failed to read", srcDir, e);
        failed.push({ path: srcDir, error: describeFsError(e, srcDir) });
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
          failed.push({ path: destPath, error: describeFsError(e, destPath) });
        }
      }
    };

    try {
      copyRecursive(src, dest);
    } catch (e) {
      console.error("TycoonAgents: _installProjectPlanSkill failed:", e);
      failed.push({ path: dest, error: describeFsError(e, dest) });
    }

    let destOk: boolean;
    try {
      destOk = fs.existsSync(dest) && fs.readdirSync(dest).length > 0;
    } catch {
      destOk = false;
    }

    return { ok: destOk && failed.length === 0, failed };
  }

  /**
   * Copy `media/skills/<skillId>` into `<root>/.claude/skills/<skillId>`,
   * recursively, generalizing `_installProjectPlanSkill`'s copy logic (see
   * its doc comment) to any skill id shipped by any pack. A file is written
   * only when absent or when its content differs byte-for-byte from the
   * shipped source (binary compare, matching `_stageBridgeTo`'s convention)
   * — never a blind overwrite. `__pycache__` and `.pyc`/`.pyo` files are
   * skipped, same exclusions `_stageBridgeTo` applies to the Python bridge.
   *
   * Two callers share this one implementation: `_handleInstallPack`'s
   * explicit skill-install step, and `_ensureInstalledPacksFresh`'s
   * panel-open auto-heal. Previously `_handleInstallPack` used a coarse
   * `fs.existsSync(target)` check on the WHOLE skill directory — once
   * `.claude/skills/<skillId>` existed at all, it was treated as fully
   * installed forever, so a later release that added files to a skill (e.g.
   * `verse_lsp_check.py`) or updated an existing one (e.g.
   * `verse-common-errors.md`) never reached an already-installed project,
   * on either an explicit reinstall or an extension update. This method is
   * the fix for both call sites at once.
   *
   * Returns per-outcome counts so callers can report install vs. update vs.
   * no-op. Never creates `dest`'s parent unless there is at least one file
   * to write (mirrors `_installProjectPlanSkill`).
   *
   * Also returns `failed` — every file/dir that could not be read or
   * written, as `{ path, error }` (error classified via `describeFsError`,
   * so a masked-long-path failure names itself). Previously a per-file copy
   * failure was only `console.error`'d and swallowed, so a caller checking
   * "destination exists && has >=1 entry" (or, for the auto-heal caller,
   * simply "did this throw") could read a PARTIAL copy as full success.
   * Never throws — a read/copy failure is captured into `failed` instead.
   */
  private _stageSkillTree(
    skillId: string,
    root: string
  ): { staged: number; updated: number; unchanged: number; failed: { path: string; error: string }[] } {
    const src = path.join(this._extensionUri.fsPath, "media", "skills", skillId);
    const dest = path.join(root, ".claude", "skills", skillId);
    let staged = 0;
    let updated = 0;
    let unchanged = 0;
    const failed: { path: string; error: string }[] = [];

    const copyRecursive = (srcDir: string, destDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true });
      } catch (e) {
        console.error("TycoonAgents: _stageSkillTree failed to read", srcDir, e);
        failed.push({ path: srcDir, error: describeFsError(e, srcDir) });
        return;
      }
      for (const entry of entries) {
        if (entry.name === "__pycache__") continue;
        if (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          copyRecursive(srcPath, destPath);
          continue;
        }
        try {
          const srcBuf = fs.readFileSync(srcPath);
          let same = false;
          let destExists = true;
          try {
            same = srcBuf.equals(fs.readFileSync(destPath));
          } catch {
            destExists = false;
          }
          if (!destExists) {
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(srcPath, destPath);
            staged++;
          } else if (!same) {
            fs.copyFileSync(srcPath, destPath);
            updated++;
          } else {
            unchanged++;
          }
        } catch (e) {
          console.error("TycoonAgents: _stageSkillTree failed to copy", srcPath, e);
          failed.push({ path: destPath, error: describeFsError(e, destPath) });
        }
      }
    };

    copyRecursive(src, dest);
    return { staged, updated, unchanged, failed };
  }

  /**
   * Export team setup (p48-t3): assemble the roster/routing/skills/mcp/
   * delegation state via teamSetupHost.exportTeamSetup() and write
   * .claude/tycoon-team.json. Wire shape mirrors the standalone's
   * EXPORT_TEAM_SETUP handler exactly: { ok, path?, error? }, never an env
   * var value or absolute path.
   */
  private _handleExportTeamSetup(): void {
    const root = this._projectRoot();
    if (!root) {
      void this._panel.webview.postMessage({
        type: MSG.TEAM_SETUP_EXPORTED,
        payload: { ok: false, error: "No project root — open a folder first." },
      });
      return;
    }
    const result = exportTeamSetup({
      root,
      env: process.env,
      version: this._currentExtensionVersion() ?? "0.0.0",
      harness: this._resolveEffectiveHarness(root),
    });
    void this._panel.webview.postMessage({ type: MSG.TEAM_SETUP_EXPORTED, payload: result });
  }

  /**
   * Apply team setup (p49-t1): read .claude/tycoon-team.json and re-run
   * installers via teamSetupHost.applyTeamSetupHost() (bound over the pure
   * src/core/teamSetupApply.ts orchestrator). `hookSourceDir` points at the
   * extension's bundled `hooks/` dir so the portable hook installer can sync
   * tycoon-claude-hook.cjs + companions the same way `_handleInstallHooks`
   * does. No opencode-config installer exists in this codebase yet, and MCP
   * catalog apply is intentionally left unbound — a catalog entry's
   * `thirdParty` confirmation is a modal, interactive gate
   * (`_handleInstallMcp`) that Apply must never silently bypass — so both
   * report as "skipped" with a detail explaining why.
   */
  private _handleApplyTeamSetup(): void {
    const root = this._projectRoot();
    if (!root) {
      void this._panel.webview.postMessage({
        type: MSG.TEAM_SETUP_APPLIED,
        payload: { ok: false, changed: false, steps: [], missingAgents: [], error: "No project root — open a folder first." },
      });
      return;
    }
    const execCfg = readExecutionConfig(path.join(root, ".claude"));
    const hookSourceDir = vscode.Uri.joinPath(this._extensionUri, "hooks").fsPath;
    const result = applyTeamSetupHost({
      root,
      env: process.env,
      version: this._currentExtensionVersion() ?? "0.0.0",
      hookSourceDir,
      delegationMode: this._coerceDelegationMode(execCfg.delegation_mode) === "team_leads" ? "team_leads" : "flat",
      regenerateOpencodeConfig: null,
      applyMcp: null,
    });
    void this._panel.webview.postMessage({ type: MSG.TEAM_SETUP_APPLIED, payload: result });
  }

  /**
   * Readiness report (p50-t2): reads .claude/tycoon-team.json and builds a
   * TeamReadinessReport via teamSetupHost.buildTeamReadinessHost(). Reply
   * shape { ok, report?, text?, error? } mirrors EXPORT/APPLY handlers.
   */
  private async _handleCheckTeamReadiness(payload: { probeReachability?: boolean } | undefined): Promise<void> {
    const root = this._projectRoot();
    if (!root) {
      void this._panel.webview.postMessage({
        type: MSG.TEAM_READINESS_REPORT,
        payload: { ok: false, error: "No project root — open a folder first." },
      });
      return;
    }
    const result = await buildTeamReadinessHost({
      root,
      env: process.env,
      probeReachability: !!payload?.probeReachability,
    });
    void this._panel.webview.postMessage({ type: MSG.TEAM_READINESS_REPORT, payload: result });
  }

  /**
   * Drift check (p50-t2): compares the manifest's exportedAt against the
   * applied stamp's exportedAt via teamSetupHost.getTeamSetupDriftHost().
   */
  private _handleGetTeamSetupDrift(): void {
    const root = this._projectRoot();
    if (!root) {
      void this._panel.webview.postMessage({
        type: MSG.TEAM_SETUP_DRIFT,
        payload: { hasManifest: false, rosterChanged: false, routingChanged: false, drift: false },
      });
      return;
    }
    const result = getTeamSetupDriftHost(root);
    void this._panel.webview.postMessage({ type: MSG.TEAM_SETUP_DRIFT, payload: result });
  }

  /**
   * Deep-clone `config` and replace `${EXTENSION_DIR}` in any string value
   * (recursively through objects/arrays) with the extension's real install
   * path (`this._extensionUri.fsPath`). Called at install time so catalog
   * entries with bundled servers resolve correctly.
   *
   * Any string a token was actually substituted into is additionally
   * normalized to forward slashes (`\` -> `/`). Scoped to strings that
   * actually contained the token: this substitution only ever produces a
   * FILESYSTEM PATH, never an arbitrary command arg/env value that might
   * legitimately contain a literal backslash — a string with no token
   * occurrence is returned completely untouched.
   */
  /**
   * For the `codex` MCP catalog entry only: if the resolved config's
   * `command` is still the bare literal `"codex"` (i.e. no user override
   * already substituted something else), try to replace it with the
   * absolute path discovered by discoverCodexBinary() — e.g. the Codex CLI
   * bundled inside the OpenAI ChatGPT VS Code extension, which is not on
   * PATH. This makes MCP launch work even when `codex` isn't a shell
   * command, without changing behavior for any other server id. Fail-open:
   * if discovery itself finds `codex` already resolves via PATH, or throws
   * (nothing found anywhere), the original config is returned unchanged and
   * the failure is only logged — install must never be blocked on this.
   */
  private _resolveCodexBinaryForInstall(id: string, config: unknown): unknown {
    if (id !== "codex" || config === null || typeof config !== "object") {
      return config;
    }
    const cfg = config as Record<string, unknown>;
    if (cfg.command !== "codex") {
      return config;
    }
    try {
      const resolved = discoverCodexBinary();
      if (resolved === "codex") {
        // Already resolves via PATH — nothing to substitute.
        return config;
      }
      return { ...cfg, command: resolved };
    } catch (e) {
      const message = e instanceof CodexDiscoveryError ? e.message : String(e);
      console.warn(
        `TycoonAgents: could not discover the Codex CLI binary; installing the MCP entry with command "codex" as-is. ${message}`
      );
      return config;
    }
  }

  /** Project-relative MCP entries launch `.claude/hooks/<file>`; make sure those copies exist. */
  private _copyBridgeHooksForMcp(root: string, config: unknown): void {
    copyMcpBridgeHooks(
      root,
      config,
      (fileName) => {
        const hooksPath = vscode.Uri.joinPath(this._extensionUri, "hooks", fileName).fsPath;
        if (fs.existsSync(hooksPath)) return hooksPath;
        const outPath = vscode.Uri.joinPath(this._extensionUri, "out", "src", "core", fileName).fsPath;
        return fs.existsSync(outPath) ? outPath : undefined;
      },
      (m) => console.warn(m),
    );
  }

  private _resolveConfigTokens(config: unknown): unknown {
    const EXTENSION_TOKEN = "${EXTENSION_DIR}";

    const resolve = (value: unknown): unknown => {
      if (typeof value === "string") {
        let out = value;
        let substituted = false;
        if (out.includes(EXTENSION_TOKEN)) {
          out = out.split(EXTENSION_TOKEN).join(this._extensionUri.fsPath);
          substituted = true;
        }
        return substituted ? out.replace(/\\/g, "/") : out;
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
  /**
   * Build (and cache) the authoritative agent id -> model map from
   * `.claude/agents/*.md` frontmatter via `loadAgentRoster`. This is the
   * single source of truth for "what model does this agent run" — outgoing
   * metrics state must be stamped from here rather than trusting whatever
   * model string a hook event happened to report (the hook has no roster
   * access and previously fabricated a "sonnet" fallback for unrecognized
   * agent ids). Returns an empty, uncached map when there's no resolvable
   * project root so a later call retries once a root becomes available.
   */
  private _getRosterModelMap(): Map<string, string> {
    if (this._rosterModelCache) {
      return this._rosterModelCache;
    }
    const root = this._projectRoot();
    if (root === "") {
      return new Map();
    }
    const map = new Map<string, string>();
    for (const agent of loadAgentRoster(path.join(root, ".claude", "agents"))) {
      if (agent.model) {
        map.set(agent.id, agent.model);
      }
    }
    this._rosterModelCache = map;
    return map;
  }

  /**
   * Overwrite each `agentMetrics` entry's `model` field with the
   * authoritative roster value from `_getRosterModelMap`, so the metrics
   * panel's tooltip and "vs. orch." badge always reflect what
   * `.claude/agents/<id>.md` actually declares rather than a value a hook
   * event may have fabricated. `model` answers "what tier is this agent
   * CONFIGURED to use" and drives cost attribution — it must stay
   * roster-authoritative.
   *
   * Before overwriting, the incoming `model` (the hook-observed resolved
   * model id, e.g. "claude-opus-5" — see hookRecord.ts) is preserved
   * verbatim on a separate `observedModel` field, answering the different
   * question "what model actually ran". The webview uses `observedModel`
   * ONLY to parse a display version number, and only after validating it
   * (untrusted, hook-sourced) and confirming its family agrees with the
   * roster `model` — see prettyModel() in media/main.js.
   *
   * Never mutates `state` or its nested arrays — only entries whose fields
   * actually change are cloned; entries with no roster match and no
   * observed model keep the same object reference.
   *
   * EXCEPTION — the orchestrator ("id === 'orchestrator'"): unlike every
   * subagent, the orchestrator has no user-facing model selector anywhere
   * in settings; `.claude/agents/orchestrator.md`'s `model:` frontmatter is
   * advisory documentation, not a configured choice. So for that one entry
   * `model` is left as the hook-observed value (never overwritten by the
   * roster) — this is what cost-fallback code (media/main.js's
   * modelPricePerMtok(orch.model)) and any other "what actually ran"
   * consumer should read. The SAME value is also mirrored onto
   * `observedModel`, matching every subagent entry's shape, so display
   * code has one consistent field to read hook-observed data from. The
   * roster/frontmatter value — still needed by anything that wants "what's
   * configured" — is carried on `rosterModel`. Display call sites in
   * media/main.js must pass `rosterModel` as prettyModel's first
   * (trusted-config) argument and `observedModel`/`model` as the second
   * (untrusted, validated) argument for the orchestrator — never the
   * reverse, or an unvalidated hook string can render raw. Subagent
   * stamping below is unchanged.
   */
  private _stampRosterModels(state: any): any {
    if (state === null || typeof state !== "object" || !Array.isArray(state.agentMetrics)) {
      return { ...state };
    }
    const map = this._getRosterModelMap();
    return {
      ...state,
      agentMetrics: state.agentMetrics.map((m: any) => {
        if (m === null || typeof m !== "object" || typeof m.id !== "string") {
          return m;
        }
        const rm = map.get(m.id);
        const observed = typeof m.model === "string" && m.model.trim() !== "" ? m.model : undefined;
        if (!rm && observed === undefined) {
          return m;
        }
        if (m.id === "orchestrator") {
          // Orchestrator model is detected, not configured — keep the
          // hook-observed value in `model` (so display/cost-fallback read
          // the real thing), mirror it onto `observedModel` (same shape as
          // every subagent entry, so display code has one field to
          // validate untrusted data from), and expose the roster/
          // frontmatter value under `rosterModel` for anything that still
          // wants "what's configured".
          if (!rm && observed === undefined) {
            return m;
          }
          return {
            ...m,
            ...(rm ? { rosterModel: rm } : {}),
            ...(observed !== undefined ? { observedModel: observed } : {}),
          };
        }
        return {
          ...m,
          ...(rm ? { model: rm } : {}),
          ...(observed !== undefined ? { observedModel: observed } : {}),
        };
      }),
    };
  }

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

  /** Effective harness for `root`; claude-code on any resolution failure. */
  private _effectiveHarness(root: string): ProviderId {
    try {
      const settingValue = readExplicitProviderSetting(vscode.workspace.getConfiguration("tycoonagents"));
      return describeProviderSelection({ settingValue, cwd: root }).effective;
    } catch {
      return "claude-code";
    }
  }

  /** Codex harness only: hook status, label and health for the Settings "Hook health" box. */
  private _codexHookSettingsSlice(): { status: CodexHookStatus; label: string; healthy: boolean } {
    const status = codexHookStatus(this._detectCodexNotifyState());
    return { status, label: CODEX_HOOK_STATUS_LABELS[status], healthy: status === "installed" };
  }

  private _handleCheckInstall(): void {
    const root = this._projectRoot();
    const harness = root !== "" ? this._effectiveHarness(root) : "claude-code";
    // Codex doesn't use .claude/settings.local.json, so its "installed" signal
    // is the Codex notify hook instead (dispatcher optional).
    const installed =
      root !== "" &&
      (harness === "codex"
        ? this._codexHookSettingsSlice().status === "installed"
        : this._hooksInstalledForRoot(root));
    const uefn = root !== "" ? detectUefnProject(root) : { detected: false, signals: [], uefnInstalled: false };
    // Non-UEFN engine chips (godot/unity/unreal/roblox/blender) for the setup
    // wizard's Optionals step to pre-check matching skill chips against. No
    // .mcp.json probing here (unlike _computeEngineStatus's live ladder) —
    // this only needs to know whether a project of that kind is present.
    const engineChips = root !== "" ? computeEngineChips(root, null) : [];
    // Whether UEFN setup already ran — requires the `.mcp.json` uefn-bridge
    // entry (_uefnBridgeEntry, also used by _computeEngineStatus's live
    // ladder). Lets the setup wizard stop re-prompting "set up UEFN" once
    // the MCP server is registered (see media/main.js's installState
    // handler / the uefnDetected trigger, and renderSetupOptionals's UEFN
    // section).
    const mcpConfig = root !== "" ? this._readMcpConfig(path.join(root, ".mcp.json")) : {};
    const uefnBridgeSetUp = root !== "" && Boolean(this._uefnBridgeEntry(mcpConfig));
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
    // Path Health (see src/host/vscode/pathHealth.ts): probes every required
    // UEFN/Verse path through the override->env->auto-detect->NOT FOUND
    // ladder, plus the three-state Verse extension check. Piggybacked onto
    // this same INSTALL_STATE push (like uefnBridgeSetUp above) rather than
    // a separate round trip — SET_PATH_OVERRIDE/CLEAR_PATH_OVERRIDE/
    // REFRESH_PATH_HEALTH all re-invoke this method to push fresh results.
    const pathHealthReport = root !== "" ? probePathHealth(path.join(root, ".claude")) : null;
    const verseExt = vscode.extensions.getExtension("epicgames.verse");
    const verseExtensionState = detectVerseExtensionState({
      liveExtensionFound: verseExt !== undefined,
      liveExtensionVersion: (verseExt?.packageJSON?.version as string | undefined) ?? null,
    });
    // Evidence-based ignore-file targets for the Setup Wizard's "Add Tycoon
    // logs to ignore file" checkbox (see detectIgnoreTargets) — never a
    // guessed VCS. Piggybacks on this same INSTALL_STATE push.
    const ignoreTargets = root !== "" ? detectIgnoreTargets(root, root, uefn.detected) : [];
    void this._panel.webview.postMessage({
      type: MSG.INSTALL_STATE,
      installed,
      harness,
      uefnDetected: uefn.detected,
      uefnSignals: uefn.signals,
      ignoreTargets,
      // Machine-level signal (distinct from uefnDetected's project-file
      // signals): true when %LOCALAPPDATA%/UnrealEditorFortnite exists, i.e.
      // UEFN itself is installed on this machine. Consumed by the Setup
      // Wizard Step-2 package checkbox list (media/main.js
      // renderSetupOptionals) to pre-check the UEFN row — every other row
      // defaults unchecked. Piggybacks on this existing INSTALL_STATE push
      // rather than adding a second message round-trip.
      uefnInstalled: uefn.uefnInstalled,
      uefnBridgeSetUp,
      engineChips,
      foreignManagedBlocks,
      pathHealth: pathHealthReport?.entries ?? [],
      pathOverridesFilePath: pathHealthReport?.overridesFilePath ?? null,
      pathOverridesFileExists: pathHealthReport?.overridesFileExists ?? false,
      verseExtensionState,
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
   * this writes to the targets `_detectIgnoreTargets` actually found evidence
   * for — `.gitignore` only when a `.git` dir (or existing `.gitignore`) is
   * present, `.p4ignore` only on an existing Perforce marker or a detected
   * UEFN project, `.urcignore` only on an existing marker or a detected UEFN
   * project. It never writes `.gitignore` into a git-less project, and never
   * guesses a VCS that isn't there. After a real `.p4ignore` write we surface
   * a one-time note that Perforce only honors it once `P4IGNORE` is
   * configured.
   *
   * Every file written also cross-references the OTHER two ignore filenames
   * (see {@link IGNORE_FILE_NAMES}) — an ignore file must never leave itself
   * or its siblings queued for ADD into whichever VCS reads it. The two
   * URC-side files (`.p4ignore`, `.urcignore`) additionally keep this
   * extension's own tooling artifacts ({@link URC_TOOLING_EXTRAS} —
   * `.mcp.json`, `CLAUDE.md`, `.claude/`) out of Perforce/URC; `.gitignore`
   * deliberately does NOT get those three, since a git user may legitimately
   * want CLAUDE.md/.claude versioned in git.
   *
   * UEFN projects ALSO get the comprehensive {@link UEFN_URC_IGNORE_ENTRIES}
   * list written to BOTH `.urcignore` (UEFN's native Revision Control, which
   * reads only the root `.urcignore` — never `.gitignore`) and `.p4ignore`
   * (so URC-native and URC-via-Perforce agree). This comprehensive list is
   * UEFN-only (broader UEFN-specific patterns, Content/-anchored
   * duplicates) and layered ON TOP of the base + cross-reference + tooling
   * entries above, not a replacement for them.
   */
  private _handleAddGitignoreEntries(): void {
    const root = this._projectRoot();
    if (root === "") return;

    const uefn = detectUefnProject(root);
    const effRoot = root;
    const targets = detectIgnoreTargets(root, effRoot, uefn.detected);
    if (targets.length === 0) return; // no VCS/ignore-file evidence — never guess

    const header = "# TycoonAgents runtime artifacts";
    const baseEntries = [".claude/tycoon/", ".claude/session-journal.json", ...IGNORE_FILE_NAMES];
    const urcSideEntries = [...baseEntries, ...URC_TOOLING_EXTRAS];

    if (targets.includes(".gitignore")) {
      this._appendIgnoreEntries(path.join(root, ".gitignore"), header, baseEntries);
    }

    let wroteP4ignore = false;
    if (targets.includes(".p4ignore")) {
      wroteP4ignore = this._appendIgnoreEntries(path.join(effRoot, ".p4ignore"), header, urcSideEntries);
    }
    if (targets.includes(".urcignore")) {
      this._appendIgnoreEntries(path.join(effRoot, ".urcignore"), header, urcSideEntries);
    }

    if (uefn.detected) {
      const urcHeader = "# TycoonAgents / Claude Code dev-tool artifacts (keep out of revision control)";
      if (targets.includes(".urcignore")) {
        this._appendIgnoreEntries(path.join(effRoot, ".urcignore"), urcHeader, UEFN_URC_IGNORE_ENTRIES);
      }
      if (targets.includes(".p4ignore")) {
        const wroteP4Urc = this._appendIgnoreEntries(path.join(effRoot, ".p4ignore"), urcHeader, UEFN_URC_IGNORE_ENTRIES);
        wroteP4ignore = wroteP4ignore || wroteP4Urc;
      }
    }

    if (wroteP4ignore) {
      vscode.window.showInformationMessage(
        "TycoonAgents added .p4ignore entries for this UEFN/Perforce project. " +
          "Perforce only honors .p4ignore once P4IGNORE is configured — run `p4 set P4IGNORE=.p4ignore` " +
          "(or set the P4IGNORE environment variable) to enable it."
      );
    }
  }

  /**
   * Bottom-left "book" icon in the webview — opens the shipped user
   * handbook (media/handbook/index.html, a static multi-page doc bundled
   * inside the extension) in the user's default OS browser via
   * `vscode.env.openExternal`. Resolved from `this._extensionUri` so it
   * works from any install location. `page` optionally names a chapter
   * file (e.g. "ch-08.html") in place of the index, and `anchor` an
   * in-page id (e.g. "content-screening") appended as a URL fragment so
   * the browser scrolls straight to that section. Both are optional; with
   * neither, this opens the index as before. Callers MUST validate `page`/
   * `anchor` against MSG_SCHEMAS.OPEN_HANDBOOK before calling this (the
   * message handler does); this method additionally re-checks the resolved
   * path stays inside media/handbook before ever calling openExternal, and
   * falls back to the plain index on anything unexpected. A
   * failed/unsupported open is logged and swallowed rather than surfaced to
   * the user, matching this file's other non-throwing handlers (e.g.
   * `_handleAddGitignoreEntries`).
   */
  private async _handleOpenHandbook(page?: string, anchor?: string): Promise<void> {
    try {
      const handbookDirUri = vscode.Uri.joinPath(this._extensionUri, "media", "handbook");
      let handbookUri = vscode.Uri.joinPath(handbookDirUri, page || "index.html");
      // Defense in depth: MSG_SCHEMAS.OPEN_HANDBOOK already constrains `page`
      // to the shipped filename shape, but re-check the RESOLVED path stays
      // inside media/handbook before ever calling openExternal — belt and
      // suspenders against joinPath normalizing something unexpected.
      const dirPath = handbookDirUri.fsPath.replace(/[\\/]+$/, "");
      const resolvedPath = handbookUri.fsPath;
      if (handbookUri.scheme !== handbookDirUri.scheme || (resolvedPath !== dirPath && !resolvedPath.startsWith(dirPath + path.sep))) {
        console.warn("TycoonAgents: openHandbook resolved outside media/handbook; opening the index instead.");
        handbookUri = vscode.Uri.joinPath(handbookDirUri, "index.html");
        anchor = undefined;
      }
      if (anchor) handbookUri = handbookUri.with({ fragment: anchor });
      await vscode.env.openExternal(handbookUri);
    } catch (err) {
      console.error("TycoonAgents: Could not open the handbook:", err);
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
   * (Setup Wizard Step-2), AND `_handleGetSettings` so the Settings screen's
   * "Hook health" row refreshes too and the Remove row disappears without a
   * manual reload.
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
      const { delegation_mode, reviewEnabled, sessionJournalEntries } = readExecutionConfig(claudeDir);

      const claudeMdPath = path.join(root, "CLAUDE.md");
      let existingClaudeMd: string | null = null;
      try {
        existingClaudeMd = fs.readFileSync(claudeMdPath, "utf8");
      } catch {
        existingClaudeMd = null;
      }

      const updated = this._buildClaudeMdDoctrine(
        existingClaudeMd,
        delegation_mode,
        reviewEnabled ?? true,
        root,
        sessionJournalEntries ?? 3
      );
      if (existingClaudeMd !== null && updated === existingClaudeMd) return; // already current — no write, no notice

      fs.writeFileSync(claudeMdPath, updated);
      vscode.window.showInformationMessage("Refreshed delegation instructions in CLAUDE.md for this version.");
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal a missing project-appropriate worker roster once per panel
   * open. Previously `search-retrieval`, `primary-agent` (the Fallback
   * Agent), and (for non-UEFN projects) `coding-specialist` +
   * `ux-ui-designer` had no install path outside a fresh
   * `_handleInstallHooks` run, so a project that opted into TycoonAgents
   * before this fix — or whose worker files were deleted — never got them,
   * and delegated search/implementation work (and keyword-unmatched work,
   * absent a real `primary-agent.md`) silently fell back to the
   * orchestrator doing it directly. This is the self-heal rail for a
   * project installed at an EARLIER version (e.g. one with only
   * coding-specialist/reviewer/search-retrieval/ux-ui-designer on disk and
   * no Wildcard Agent) — it runs every panel open, not just on a fresh
   * install. Delegates the actual file-write decision to
   * `_installWorkerAgents`, which is strictly create-if-absent (never
   * overwrites a user's own or a UEFN pack's same-named agent).
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
    // The on-disk roster may change below (new worker files created,
    // role-text resynced) — drop the cached model map so the next stamp
    // rereads it rather than serving stale/missing entries.
    this._rosterModelCache = undefined;
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!this._hooksInstalledForRoot(root)) return;
      this._installWorkerAgents(root);
      this._ensureWorkerAgentRoleTextCurrent(root);
      this._healForeignWrapperModels(root);
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal: an agent file with a non-anthropic `backend:` block must keep a
   * Claude alias as its top-level `model:`. A vendor id there (written by an
   * older routing save) makes Claude Code 404 before the agent starts. Best
   * effort; logs each repair.
   */
  private _healForeignWrapperModels(root: string): void {
    try {
      const agentsDir = path.join(root, ".claude", "agents");
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith(".md")) continue;
        try {
          const id = file.slice(0, -3);
          const filePath = path.join(agentsDir, file);
          const content = fs.readFileSync(filePath, "utf8");
          const catalog = FOREIGN_LLM_AGENTS.find((x) => x.id === id);
          const healed = healForeignWrapperModel(content, catalog?.model);
          if (healed === null) continue;
          fs.writeFileSync(filePath, healed.content);
          this._rosterModelCache = undefined;
          console.warn(`TycoonAgents: restored wrapper model for ${id}: ${healed.from} -> ${healed.to}`);
        } catch {
          /* best-effort per file */
        }
      }
    } catch {
      /* no agents dir or unreadable — nothing to heal */
    }
  }

  /**
   * Auto-heal: resync the `## Role` section text of already-installed
   * worker agent files against the CURRENT `role:` strings in
   * `packCatalog.ts`'s `REGULAR_AGENTS`/`workerAgentsForProject`. Editing
   * `role:` there only affects markdown generated from that point forward —
   * `_installWorkerAgents` is strictly create-if-absent (see its doc
   * comment), so an edited role string never reaches a `.claude/agents/*.md`
   * file that already exists on disk. Without this, a role-text fix in
   * source ships in the VSIX but silently never applies to any project that
   * installed TycoonAgents before that release.
   *
   * IDENTIFYING "OURS": most already-installed worker files predate
   * `buildAgentMarkdown` ever being passed a `packId` (that only started
   * with `_installWorkerAgents`'s "worker" packId, added alongside this
   * method), so they carry no `tycoon_pack` marker. `agentMarkdownHasTycoonMarker`
   * alone would therefore only ever match brand-new files, missing exactly
   * the existing-user files this method exists to fix — so a file is also
   * treated as ours when `workerAgentFingerprintMatches` matches on
   * `model:` + the exact `## Keywords (for task routing)` body, a
   * fingerprint a user is very unlikely to have hand-authored identically.
   *
   * Like `_ensureDelegationDoctrineCurrent`, this is idempotent and
   * best-effort: gated on `_hooksInstalledForRoot` as the consent proxy,
   * writes only when `resyncAgentRoleSection` returns genuinely different
   * content, skips files that don't exist yet (creation is
   * `_installWorkerAgents`'s job) or whose Role-section shape isn't
   * recognized, and is wrapped in try/catch per-file and overall so a
   * failure here can never break panel construction/rendering.
   */
  private _ensureWorkerAgentRoleTextCurrent(root: string): void {
    try {
      const isUefn = detectUefnProject(root).detected || this._isUefnPackInstalled(root);
      const agents = workerAgentsForProject(isUefn);
      const agentsDir = path.join(root, ".claude", "agents");
      for (const a of agents) {
        try {
          const agentPath = path.join(agentsDir, `${a.id}.md`);
          let content: string;
          try {
            content = fs.readFileSync(agentPath, "utf8");
          } catch {
            continue; // not installed yet — _installWorkerAgents handles creation
          }
          const managed = agentMarkdownHasTycoonMarker(content) || workerAgentFingerprintMatches(content, a);
          if (!managed) continue; // never touch a file we can't positively identify as ours
          // Frontmatter repair: an install predating the `name`/`description`
          // fields Claude Code requires to register a custom subagent (or
          // carrying a vendor-prefixed `model:` id) never fixes itself, since
          // this method otherwise only ever touches the Role/discipline
          // sections below the frontmatter. Body text is untouched.
          const frontmatterUpdated = resyncAgentFrontmatterFields(content, a);
          let next = frontmatterUpdated === null ? content : frontmatterUpdated;
          const roleUpdated = resyncAgentRoleSection(next, a.role);
          next = roleUpdated === null ? next : roleUpdated;
          // Workers/reviewers are LEAVES — keep the "## Working discipline"
          // section current too (added/updated in the same read-modify-write).
          // The orchestrator is the only delegator, so it never carries it.
          if (a.id !== "orchestrator") {
            next = resyncAgentDisciplineSection(next);
          }
          if (next === content) continue; // already current (or unrecognized shape with nothing to change)
          fs.writeFileSync(agentPath, next);
        } catch {
          /* best-effort per-file; never blocks the rest of the roster */
        }
      }
    } catch {
      /* best-effort auto-heal — must never break the panel. */
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

      // Heal older installs (stale bridge/runtime copies, missing CommonJS
      // marker) before the early returns below. Existing files only.
      try {
        const resolveSrc = (fileName: string): string | undefined => {
          const hooksPath = vscode.Uri.joinPath(this._extensionUri, "hooks", fileName).fsPath;
          if (fs.existsSync(hooksPath)) return hooksPath;
          const outPath = vscode.Uri.joinPath(this._extensionUri, "out", "src", "core", fileName).fsPath;
          return fs.existsSync(outPath) ? outPath : undefined;
        };
        healInstalledHookCopies(root, resolveSrc, (m) => console.warn(m));
      } catch (err) {
        console.warn("TycoonAgents: hook copy heal failed:", err);
      }

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
   * Auto-heal: upgrade a project's `.claude/settings.local.json` hook
   * matcher(s) that still carry a legacy value TycoonAgents used to write
   * (see `LEGACY_MATCHER_ALIASES` in hookInstall.ts) to the current value,
   * once per panel open.
   *
   * WHY: `_ensureHookScriptFresh` (above) refreshes the on-disk hook SCRIPT
   * on every panel open, but nothing previously refreshed the settings
   * ENTRIES that point at it — a project installed before a matcher
   * changed (e.g. PreToolUse's MCP-tool matcher going from bare "mcp__" to
   * the anchored "mcp__.*" Claude Code's docs recommend) stayed on the old
   * matcher indefinitely unless the user re-ran "Install hooks"/"Repair"
   * (which calls `mergeTycoonHooks`, which performs this same rename).
   * This closes that gap for panel-open the same way `_ensureHookScriptFresh`
   * closes it for the script file.
   *
   * Delegates the actual matcher logic to `migrateLegacyHookMatchers`
   * (pure, unit-tested in hookInstall.test.ts): it only ever renames an
   * entry whose matcher is a KNOWN legacy value AND whose hooks are
   * entirely ours — any user-customized entry (different matcher,
   * different command, or any non-ours hook mixed in) is left completely
   * alone, and nothing here ever adds a missing hook slot (that stays
   * `_handleInstallHooks`'s job, an explicit user action).
   *
   * Rules mirror `_ensureHookScriptFresh`:
   * - Never creates settings.local.json — a project with no such file has
   *   nothing to heal and is left untouched (opt-in preserved).
   * - Only writes back when something actually changed (no mtime churn on
   *   an already-current project).
   * - Wrapped in try/catch so a failure here can never break panel
   *   construction/rendering.
   */
  private _ensureHookMatchersFresh(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;

      const settingsPath = path.join(root, ".claude", "settings.local.json");
      if (!fs.existsSync(settingsPath)) return; // nothing installed -> nothing to heal

      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (raw === "") return;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return;

      const migrated = migrateLegacyHookMatchers(parsed as Record<string, unknown>);
      // Also add hook slots introduced after the project was installed (e.g.
      // StopFailure) — only when our hook is already registered.
      const healed = addMissingAutoHealSlots(migrated.settings);
      if (!migrated.changed && !healed.changed) return; // already current -> no write, no mtime churn

      fs.writeFileSync(settingsPath, JSON.stringify(healed.settings, null, 2));
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal: rewrite a project's `.claude/settings.local.json` Tycoon
   * hook command(s) from the old project-relative form
   * (`node .claude/tycoon/tycoon-claude-hook.cjs`, either slash style) to
   * the current absolute form, once per panel open.
   *
   * WHY: the relative command silently stops firing the moment a session's
   * cwd leaves the project root (see buildAbsoluteHookCommand's doc
   * comment) — a real-world incident traced activity.jsonl going dead
   * partway through a session to exactly this. Every already-installed
   * project needs this rewrite without the user having to know to run
   * "Troubleshoot & Fix"; mirrors `_ensureHookMatchersFresh` above.
   *
   * Delegates the actual rewrite to `migrateRelativeHookCommand` (pure,
   * unit-tested in hookInstall.test.ts): it touches ONLY entries whose
   * command is exactly the old relative form — every other entry, and
   * every non-hooks top-level key, is left byte-for-byte untouched.
   *
   * Rules mirror `_ensureHookMatchersFresh`:
   * - Only settings.local.json (never settings.json — shared/team file,
   *   never auto-rewritten).
   * - Never creates the file — nothing installed means nothing to heal.
   * - Backs up to `settings.local.json.bak` before writing, but never
   *   overwrites an existing backup (matches `_handleApplyDoctorFix`'s
   *   backup-before-repair convention).
   * - Only writes back / logs when something actually changed.
   * - Logs one line via `log()` with no paths (matches this file's other
   *   auto-heal logging).
   * - Wrapped in try/catch so a failure here can never break panel
   *   construction/rendering.
   */
  private _ensureHookCommandAbsolute(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;

      const settingsPath = path.join(root, ".claude", "settings.local.json");
      if (!fs.existsSync(settingsPath)) return; // nothing installed -> nothing to heal

      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (raw === "") return;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return;

      const absoluteHookCommand = this._buildHookCommand(root);
      const { settings, changed } = migrateRelativeHookCommand(parsed as Record<string, unknown>, absoluteHookCommand);
      if (!changed) return; // already absolute (or nothing to migrate) -> no write, no mtime churn

      const backupPath = `${settingsPath}.bak`;
      try {
        if (!fs.existsSync(backupPath)) {
          fs.writeFileSync(backupPath, fs.readFileSync(settingsPath));
        }
      } catch {
        /* best-effort backup; never block the migration itself */
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      log("panel: migrated relative Tycoon hook command(s) to absolute form");
    } catch {
      // Best-effort auto-heal — a failure here must never break the panel.
    }
  }

  /**
   * Auto-heal `.claude/skills/project-plan` once per panel open whenever
   * Project Plan is enabled (default ON; only an explicit `false` disables).
   * `_installProjectPlanSkill` content-diffs every shipped file, so a MISSING,
   * OUTDATED, or edited/truncated file is restored — this is why the old
   * "Reinstall / Repair skill" button was removed. A project with no explicit
   * flag AND no TycoonAgents hooks installed is left untouched.
   */
  private _ensureProjectPlanSkillFresh(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!readProjectPlanEnabled(root)) return;
      // Default-on means an untouched project reads as enabled; don't create
      // .claude/skills in a project that never ran TycoonAgents' Install/Repair.
      if (!projectPlanFlagIsExplicit(root) && !this._hooksInstalledForRoot(root)) return;
      const result = this._installProjectPlanSkill(root);
      // No staleness stamp guards this call (it re-runs, cheaply, on every
      // panel open) so there is nothing to keep "stale" for a retry — the
      // retry already happens automatically next panel open. Still log a
      // failure explicitly (never silently swallowed) so it's visible in
      // the extension's console/output channel rather than only inferable
      // from the skill directory being stuck out of date.
      if (!result.ok && result.failed.length > 0) {
        console.error("TycoonAgents: _ensureProjectPlanSkillFresh had copy failures:", result.failed);
      }
    } catch (e) {
      console.error("TycoonAgents: _ensureProjectPlanSkillFresh failed:", e);
    }
  }

  /** Core skill ids shipped with every install, unconditionally (no pack
   * membership, no opt-in checkbox) — unlike `project-plan`, which only
   * lands when the Project Plan feature is enabled. Shared by
   * `_ensureCoreSkillsFresh` (panel-open auto-heal) and `_handleInstallHooks`
   * (explicit Install/Repair). */
  private static readonly CORE_SKILL_IDS: readonly string[] = ["tycoon-ready-test", "tycoon-diagnose"];

  /**
   * Stage the always-on core skills (`tycoon-ready-test`, `tycoon-diagnose`)
   * into `.claude/skills/<id>` via `_stageSkillTree`'s content-diff copy —
   * same convention `_ensureProjectPlanSkillFresh` uses, except these two
   * ship on EVERY install (no `projectPlanEnabled`-style opt-in flag), so
   * the only gate is `_hooksInstalledForRoot` as the consent proxy: a
   * project that never ran TycoonAgents' own Install/Repair is left
   * untouched, but any project that has is kept current on every panel
   * open (extension update, or a locally-drifted copy). Never throws.
   */
  private _ensureCoreSkillsFresh(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!this._hooksInstalledForRoot(root)) return;
      for (const skillId of TycoonPanel.CORE_SKILL_IDS) {
        const { failed } = this._stageSkillTree(skillId, root);
        if (failed.length > 0) {
          console.error(`TycoonAgents: _ensureCoreSkillsFresh had copy failures for ${skillId}:`, failed);
        }
      }
    } catch (e) {
      console.error("TycoonAgents: _ensureCoreSkillsFresh failed:", e);
    }
  }

  /** The running extension's own `package.json` version, or `null` if it can't be read. Shared by `_handleGenerateDiagnostic` and `_ensureInstalledPacksFresh`. */
  private _currentExtensionVersion(): string | null {
    try {
      const pkgRaw = fs.readFileSync(path.join(this._extensionUri.fsPath, "package.json"), "utf8");
      return JSON.parse(pkgRaw).version || null;
    } catch {
      return null;
    }
  }

  /**
   * Auto-heal: re-stage every capability pack this project ALREADY has
   * installed, once per panel open when the extension version has changed
   * since the last time this ran.
   *
   * THE BUG THIS FIXES: nothing in this codebase previously re-ran ANY part
   * of pack install on an extension update. `_handleInstallPack` (skills,
   * commands, `.mcp.json` entry, agent `.md` files) only ever runs on an
   * explicit "Install pack" click — contrast with the hook script and the
   * project-plan skill, which already have their own panel-open auto-heal
   * (`_ensureHookScriptFresh`, `_ensureProjectPlanSkillFresh`). On top of
   * that gap, `_handleInstallPack`'s skill step used to skip re-copying
   * entirely once `.claude/skills/<skillId>` existed at all (see
   * `_stageSkillTree`'s doc comment) — so even re-clicking "Install pack"
   * on an already-installed pack didn't pick up new/changed skill files.
   * Confirmed on a real project: `.claude/skills/uefn/` was missing
   * `verse_lsp_check.py`, `verse_project_check.py`, and `verse_lint.py`
   * (all added in later releases), `verse-common-errors.md` was frozen at
   * v4.0.0 while the shipped copy had moved to v4.7.0, and
   * `.claude/agents/verse-expert.md` / `uefn-auditor.md` predated any
   * mention of `verse_lsp_check` — despite the extension itself being
   * current.
   *
   * STAMP: `.claude/tycoon/pack-staging.json` (`{ version, packs: {
   * [packId]: version } }`) records the extension version that last
   * re-staged this project. Compared against `_currentExtensionVersion()`
   * on every panel open; an exact match short-circuits immediately (no
   * filesystem tree walk) so this is a cheap no-op on an already-current
   * project. A missing/unparsable stamp is treated as "stale" (never as
   * "nothing to do") so a project that predates this method's existence
   * still gets re-staged once. `packs[packId] = currentVersion` claims ONLY
   * that this pack's skill/agent files were re-staged successfully.
   *
   * "ALREADY HAS" DETECTION — never installs a pack the user did not
   * choose: a pack counts as installed only if its first agent's
   * `.claude/agents/<id>.md` file exists AND carries the `tycoon_pack:
   * <packId>` provenance marker (`agentMarkdownHasTycoonMarker`) — the same
   * signal `_isUefnPackInstalled` already uses for the UEFN pack,
   * generalized here to every pack in `media/packs/catalog.json`. A pack
   * with no marker file present is left completely untouched.
   *
   * CONTENT-DIFF, NOT BLIND OVERWRITE: skills go through `_stageSkillTree`
   * (write only if absent or content differs from the shipped source, byte
   * for byte). Agent `.md` files are refreshed only when the file already
   * carries the `tycoon_pack` marker (i.e. it's already recognized as ours)
   * AND the freshly-generated content differs from what's on disk — this
   * is the exact rule `_handleInstallPack` already applies to a
   * marker-bearing agent file, reused here rather than reinvented. Neither
   * path distinguishes a deliberate user edit from ordinary staleness — no
   * file in this tree currently tracks that distinction (see
   * `_ensureHookScriptFresh`, which has the identical "differs from
   * bundled = refresh forward" posture); inventing a different contract
   * for just this one method would be inconsistent, not safer.
   *
   * GATE: only runs when TycoonAgents hooks are installed for this project
   * (`_hooksInstalledForRoot`, the same consent proxy every other auto-heal
   * in this file uses). Idempotent and safe to run on every panel load.
   * Wrapped in try/catch so a failure here can never break panel
   * construction/rendering — but unlike most other auto-heals, a failure
   * that leaves pack content stale is surfaced with a warning toast rather
   * than swallowed: this repo has a documented history of tools silently
   * returning success shapes when discovery/staging actually failed, and a
   * user must never be told (by omission) that a tool exists when their
   * project doesn't have it.
   */
  private _ensureInstalledPacksFresh(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      if (!this._hooksInstalledForRoot(root)) return;

      const currentVersion = this._currentExtensionVersion();
      if (currentVersion === null) return; // can't stamp reliably without a known version

      const stampPath = path.join(root, ".claude", "tycoon", "pack-staging.json");
      let stamp: { version?: string; packs?: Record<string, string> } = {};
      try {
        stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
      } catch {
        stamp = {};
      }
      if (stamp.version === currentVersion) return; // already re-staged for this version

      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      let packs: any[];
      try {
        packs = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      } catch (e) {
        console.error("TycoonAgents: _ensureInstalledPacksFresh could not read pack catalog:", e);
        void vscode.window.showWarningMessage(
          "TycoonAgents: could not read the shipped pack catalog, so installed pack content (skills, agents) could not be checked for updates. Restart the editor; if this persists, reinstall the extension."
        );
        return;
      }

      const restaged: string[] = [];
      const failed: string[] = [];
      const packStamp: Record<string, string> = { ...(stamp.packs ?? {}) };

      for (const pack of packs) {
        try {
          const markerAgent = Array.isArray(pack.agents) && pack.agents.length > 0 ? pack.agents[0] : pack.agent;
          if (!markerAgent) continue;
          let markerContent: string;
          try {
            markerContent = fs.readFileSync(path.join(root, ".claude", "agents", `${markerAgent.id}.md`), "utf8");
          } catch {
            continue; // this pack is not installed in this project — never install uninvited
          }
          if (!agentMarkdownHasTycoonMarker(markerContent)) continue; // same id, but not ours — never touch

          let ok = true;

          const packSkills: string[] = Array.isArray(pack.skills) ? pack.skills : [];
          for (const skillId of packSkills) {
            try {
              // `_stageSkillTree` never throws on a per-file copy failure —
              // it reports `failed` instead (see its doc comment). This was
              // the actual bug: `ok` only ever flipped false on a THROWN
              // exception, so a real partial-copy failure (e.g. a locked
              // file, a too-long path) here was invisible — the pack still
              // landed in `restaged` and `packStamp[pack.id]` was stamped to
              // the current version below, meaning the NEXT panel open
              // would see the stamp match and never retry the failed file.
              const { failed } = this._stageSkillTree(skillId, root);
              if (failed.length > 0) {
                ok = false;
                console.error(
                  `TycoonAgents: failed to re-stage skill "${skillId}" for pack "${pack.id}":`,
                  failed
                );
              }
            } catch (e) {
              ok = false;
              console.error(`TycoonAgents: failed to re-stage skill "${skillId}" for pack "${pack.id}":`, e);
            }
          }

          const packCommands: string[] = Array.isArray(pack.commands) ? pack.commands : [];
          if (packCommands.length > 0) {
            try {
              this._installPackCommands(root, packCommands);
            } catch (e) {
              ok = false;
              console.error(`TycoonAgents: failed to re-stage commands for pack "${pack.id}":`, e);
            }
          }

          const agents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
          for (const a of agents) {
            if (a.backend && a.backend.mcpServer === "claude-cli") {
              let skip = false;
              try {
                skip = shouldSkipPackAgentForClaudeSubscription(this._resolveEffectiveHarness(root), readClaudeSubscriptionOptIn(), a.backend);
              } catch { /* harness unresolvable: never block the heal */ }
              if (skip) continue;
            }
            try {
              const agentPath = path.join(root, ".claude", "agents", `${a.id}.md`);
              let existingContent: string;
              try {
                existingContent = fs.readFileSync(agentPath, "utf8");
              } catch {
                continue; // never install an agent the user doesn't already have
              }
              if (!agentMarkdownHasTycoonMarker(existingContent)) continue; // not ours — never touch
              const generated = buildAgentMarkdown(a, pack.id);
              if (existingContent !== generated) {
                fs.writeFileSync(agentPath, generated);
              }
            } catch (e) {
              ok = false;
              console.error(`TycoonAgents: failed to re-stage agent "${a.id}" for pack "${pack.id}":`, e);
            }
          }

          if (ok) {
            restaged.push(pack.id);
            packStamp[pack.id] = currentVersion;
          } else {
            failed.push(pack.id);
          }
        } catch (e) {
          failed.push(pack.id);
          console.error(`TycoonAgents: failed to re-stage pack "${pack.id}":`, e);
        }
      }

      try {
        fs.mkdirSync(path.dirname(stampPath), { recursive: true });
        // Only advance the TOP-LEVEL `version` (the field that gates the
        // early-return at the top of this method) when EVERY pack this run
        // touched fully succeeded. This was the actual bug behind "a failed
        // stage must remain stale so the next panel open retries": the old
        // code always wrote `version: currentVersion` here regardless of
        // `failed`, so on the very next panel open the top gate
        // (`stamp.version === currentVersion`) matched and the WHOLE method
        // returned immediately — the failed pack's skill/agent files were
        // never retried again until the extension's version itself changed.
        // Keeping the OLD (or absent) version on any failure leaves the
        // mismatch in place so this method runs again, and retries, on the
        // next panel open. Per-pack `packStamp[pack.id]` entries for packs
        // that DID succeed this run are still recorded (used by the
        // `uefn-bridge` verified-value logic above) — only the gating field
        // is held back.
        const stampBody: { version?: string; packs: Record<string, string> } = { packs: packStamp };
        if (failed.length === 0) {
          stampBody.version = currentVersion;
        } else if (stamp.version !== undefined) {
          stampBody.version = stamp.version;
        }
        fs.writeFileSync(stampPath, JSON.stringify(stampBody, null, 2));
      } catch (e) {
        console.error("TycoonAgents: failed to write pack-staging.json stamp:", e);
      }

      if (restaged.length > 0) {
        console.log(`TycoonAgents: re-staged installed pack content (${restaged.join(", ")}) to v${currentVersion}.`);
      }
      if (failed.length > 0) {
        void vscode.window.showWarningMessage(
          `TycoonAgents: could not fully re-stage pack content for: ${failed.join(", ")}. Some skill or agent files may be OUT OF DATE for this project — check the extension's console log, or use "Remove pack" then reinstall from the Packs panel.`
        );
      }
    } catch (e) {
      console.error("TycoonAgents: _ensureInstalledPacksFresh failed:", e);
      void vscode.window.showWarningMessage(
        "TycoonAgents: could not check installed pack content for updates — skills or agent files for this project may be OUT OF DATE. See the extension's console log."
      );
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

      let agentText: string | undefined;
      try {
        agentText = fs.readFileSync(path.join(agentsDir, `${agent.id}.md`), "utf8");
      } catch {
        agentText = undefined;
      }

      let tier: string | undefined;
      try {
        tier = agentText !== undefined ? agentMarkdownTier(agentText) : undefined;
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

      // vendorLabel: read this agent's `backend:` frontmatter (if any) and
      // format it via formatVendorModelLabel so the roster's "Vendor /
      // model" column reflects the ACTUAL backend (e.g. codex-reviewer ->
      // "OpenAI · openai/gpt-5.4-mini (subscription)") instead of always
      // falling back to delegationDoctrine.ts's claude-native default. A
      // malformed/missing backend block must never throw here — it just
      // means this row falls back to the default label same as before.
      let vendorLabel: string | undefined;
      try {
        if (agentText !== undefined) {
          const frontmatter = readAgentFrontmatter(agentText);
          const backend = parseAgentBackend(frontmatter);
          vendorLabel = formatVendorModelLabel(backend);
        }
      } catch {
        vendorLabel = undefined;
      }

      rows.push({ id: agent.id, taskTypes, vendorLabel });
    }

    return rows;
  }

  /**
   * Resolve which agent actually covers the "Review pass" doctrine section:
   * `reviewer` when its `.md` file is installed, else `uefn-auditor` when
   * installed AND this project is detected as UEFN (a UEFN project's Verse
   * Auditor), else `undefined` when neither applies. MUST be computed from
   * the FULL installed agent set (via {@link loadAgentRoster}, same as
   * `_buildDoctrineRoster`) rather than from `_buildDoctrineRoster`'s own
   * `rows` output — that output has `tier: "reviewer"` agents deliberately
   * excluded (see its doc comment), so `reviewer` can never be proven
   * installed from `rows` alone. The UEFN check (via {@link
   * detectUefnProject}) prevents a non-UEFN project that merely has the
   * UEFN pack installed from being routed to `uefn-auditor` for review.
   * Passed as `renderDelegationDoctrine`'s `reviewAgentId` argument so the
   * "Review pass" section names the real installed agent instead of falling
   * back to a generic phrase whenever `reviewer` is installed on a
   * non-UEFN project.
   */
  private _resolveReviewAgentId(root: string): string | undefined {
    const agentsDir = path.join(root, ".claude", "agents");
    const rosterFiles = loadAgentRoster(agentsDir);
    const hasId = (id: string) => rosterFiles.some((a) => a.id === id);
    if (hasId("reviewer")) return "reviewer";
    if (hasId("uefn-auditor") && detectUefnProject(root).detected) return "uefn-auditor";
    return undefined;
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
    root: string,
    sessionJournalEntries = 3
  ): string {
    const roster = this._buildDoctrineRoster(root);
    const isUefn = detectUefnProject(root).detected;
    const reviewAgentId = this._resolveReviewAgentId(root);
    // projectPlanEnabled is read fresh from execution.json (via panel.ts's
    // own readProjectPlanEnabled) rather than threaded in as a param — this
    // builder already has `root` in scope, and every call site here shares
    // the same file the toggle handler writes, so a direct read keeps this
    // in sync without touching every caller's signature.
    const projectPlanEnabled = readProjectPlanEnabled(root);
    const withDelegation = upsertDelegationSection(
      existingContent,
      renderDelegationDoctrine(mode, reviewEnabled, roster, reviewAgentId, sessionJournalEntries, projectPlanEnabled)
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

      // Codex harness: the first-run "Install hooks" button installs the Codex
      // notify hook (CODEX_HOME/config.toml + .codex/hooks.json), never the
      // Claude hooks, and leaves everything else in place.
      if (this._effectiveHarness(root) === "codex") {
        this._handleInstallCodexHooks();
        const slice = this._codexHookSettingsSlice();
        void this._panel.webview.postMessage({
          type: MSG.INSTALL_STATE,
          installed: slice.status === "installed",
          harness: "codex",
          delegation_mode: delegationMode,
          ...(slice.status === "installed"
            ? {}
            : { error: this._codexHooksWarningField().codexHooksWarning ?? slice.label }),
        });
        return;
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
      const hookSyncStatus = syncRuntimeFile(src, dest);
      if (hookSyncStatus === "refreshed") {
        console.log(`TycoonAgents: refreshed ${dest}`);
      }

      // 2b. Copy the compiled agentBackend/modelAliases modules next to the
      // hook so it can require() them for generic backend-aware routing
      // (p2-t2). Best-effort: if out/ hasn't been built (dev checkout that
      // hasn't run tsc, or a packaged VSIX missing them for any reason), the
      // hook's own require() falls back to its legacy hardcoded behavior —
      // never throw here.
      try {
        // Packaged installs ship these next to tycoon-claude-hook.cjs in
        // hooks/ (see scripts/copy-hook-runtime.mjs, run by both `npm run
        // build` and vscode:prepublish). A dev checkout that hasn't built
        // yet won't have hooks/ populated, so fall back to the raw tsc
        // output under out/src/core.
        const resolveRuntimeFile = (fileName: string): string | undefined => {
          const hooksPath = vscode.Uri.joinPath(this._extensionUri, "hooks", fileName).fsPath;
          if (fs.existsSync(hooksPath)) {
            return hooksPath;
          }
          const outPath = vscode.Uri.joinPath(
            this._extensionUri,
            "out",
            "src",
            "core",
            fileName
          ).fsPath;
          return fs.existsSync(outPath) ? outPath : undefined;
        };
        const agentBackendSrc = resolveRuntimeFile("agentBackend.js");
        const modelAliasesSrc = resolveRuntimeFile("modelAliases.js");
        const delegationEnforcementSrc = resolveRuntimeFile("delegationEnforcement.js");
        // fallbackChain.js is lazy-required at runtime by tycoon-claude-hook.cjs's
        // PostToolUse/Task fallback branch — must ship alongside delegationEnforcement.js
        // or that branch silently no-ops in VS Code installs (the require() is
        // wrapped in try/catch, so its absence fails open, never throws).
        const fallbackChainSrc = resolveRuntimeFile("fallbackChain.js");
        const syncCompanion = (srcPath: string | undefined, fileName: string): void => {
          if (!srcPath) return;
          const status = syncRuntimeFile(srcPath, path.join(tycoonDir, fileName));
          if (status === "refreshed") {
            console.log(`TycoonAgents: refreshed ${path.join(tycoonDir, fileName)}`);
          }
        };
        syncCompanion(agentBackendSrc, "agentBackend.js");
        syncCompanion(modelAliasesSrc, "modelAliases.js");
        syncCompanion(delegationEnforcementSrc, "delegationEnforcement.js");
        syncCompanion(fallbackChainSrc, "fallbackChain.js");
        // p99-t1: structured bridge-status parser required by the hook.
        syncCompanion(resolveRuntimeFile("bridge-result.cjs"), "bridge-result.cjs");
        ensureCommonJsMarker(tycoonDir);
      } catch {
        /* best-effort; hook falls back to legacy behavior when absent */
      }

      // 2c. Copy the MCP bridge scripts (codex-mcp-launcher.cjs,
      // codex-app-server-mcp.cjs) into .claude/hooks/ so .mcp.json entries
      // can reference them with a project-relative path instead of an
      // extension-install-dependent ${EXTENSION_DIR} token — see
      // MCP_BRIDGE_HOOK_FILES in hookInstall.ts. Best-effort: a packaged
      // install missing hooks/ for any reason must not break hook install.
      try {
        const hooksDestDir = path.join(claudeDir, "hooks");
        for (const fileName of MCP_BRIDGE_HOOK_FILES) {
          const bridgeSrc = vscode.Uri.joinPath(this._extensionUri, "hooks", fileName).fsPath;
          if (fs.existsSync(bridgeSrc)) {
            fs.mkdirSync(hooksDestDir, { recursive: true });
            syncRuntimeFile(bridgeSrc, path.join(hooksDestDir, fileName));
          }
        }
        if (fs.existsSync(hooksDestDir)) ensureCommonJsMarker(hooksDestDir);
      } catch {
        /* best-effort; MCP bridge entries simply won't resolve if absent */
      }

      // 3. Absolute hook command — see _buildHookCommand's doc comment for why
      // a project-relative command is unsafe (a mid-session cwd change breaks it).
      const hookCommand = this._buildHookCommand(root);

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
      const mergedHooks = mergeTycoonHooks(existing, hookCommand);

      // 5b. Belt-and-braces: cap the harness's own subagent nesting depth
      // (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH) so even a guard bug in the
      // PreToolUse hook can't let spawning nest deeper than this mode
      // intends. "1" for flat/direct (orchestrator -> worker), "2" for
      // team_leads (orchestrator -> lead -> worker). Only ever written when
      // the key is absent — see mergeManagedSubagentDepthEnv's doc comment
      // for why an existing value (user-set or ours) is never overwritten,
      // including on a later mode switch.
      const merged = mergeManagedSubagentDepthEnv(
        mergedHooks,
        delegationMode === "team_leads" ? "2" : "1"
      );

      // 6. Write merged settings.
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

      // 6b. (Backfill routing keywords for any already-present hand-authored
      // agent moved to after step 7's agent-file installs below — see the
      // call right before step 8. Running it here, before
      // _installWorkerAgents/_installLeadAgents/_installReviewerAgent write
      // their .md files, meant a brand-new project's just-created worker
      // roster didn't exist on disk yet when this seed pass read
      // `.claude/agents/*.md`, so those agents got no agent-keywords.json
      // entry and the panel rendered their Keywords field as the empty
      // "kw1|kw2|kw3" placeholder until the next panel open re-ran the
      // constructor's own _ensureAgentKeywordsSeeded call and finally saw
      // the full roster. The reviewer agent was unaffected because
      // _installAgentFiles/_installReviewerAgent calls setKeywordPattern
      // directly as part of writing its file, independent of this pass.)

      // 6c. Stage the always-on core skills (tycoon-ready-test,
      // tycoon-diagnose) — same content-diff copy _ensureCoreSkillsFresh
      // uses on later panel opens, run here too so a fresh Install/Repair
      // has them immediately rather than waiting for the next panel open.
      // Best-effort: a failure here must never fail the (already-successful)
      // hook install.
      for (const skillId of TycoonPanel.CORE_SKILL_IDS) {
        try {
          const { failed } = this._stageSkillTree(skillId, root);
          if (failed.length > 0) {
            console.error(`TycoonAgents: _handleInstallHooks core skill stage failed for ${skillId}:`, failed);
          }
        } catch (e) {
          console.error(`TycoonAgents: _handleInstallHooks core skill stage threw for ${skillId}:`, e);
        }
      }

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

        // 7a2. Optional "Project Plan" feature is on by default for a
        // fresh install/repair — same precedent as reviewEnabled above —
        // but an existing user's explicit prior choice (on OR off) is
        // preserved. Runs after writeExecutionConfig (that write already
        // merges rather than overwrites execution.json, but this ordering
        // keeps the two writes independent regardless).
        seedProjectPlanEnabledDefault(root);

        // 7a3. When Project Plan is enabled (freshly seeded true, or an
        // existing user's prior on choice preserved by the seed above),
        // land the project-plan skill (and the design-doc skill it
        // consumes for milestone-plan templates) in this SAME install pass
        // instead of waiting for the next panel-open auto-heal
        // (_ensureProjectPlanSkillFresh) — previously a fresh install left
        // `.claude/skills/project-plan` missing until that next activation
        // (observed ~2min gap). Both copies are content-diff (never
        // overwrite a user-edited SKILL.md); failures are logged, never
        // thrown, matching this method's other best-effort install steps.
        if (readProjectPlanEnabled(root)) {
          const planResult = this._installProjectPlanSkill(root);
          if (!planResult.ok && planResult.failed.length > 0) {
            console.error("TycoonAgents: _handleInstallHooks project-plan skill copy failures:", planResult.failed);
          }
          const designDocResult = this._stageSkillTree("design-doc", root);
          if (designDocResult.failed.length > 0) {
            console.error("TycoonAgents: _handleInstallHooks design-doc skill copy failures:", designDocResult.failed);
          }
        }

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
        // sessionJournalEntries is untouched by the writeExecutionConfig call
        // above (merge-safe) — read it back rather than assuming a fresh
        // install's default of 0, so a repair run never resets an existing
        // user's session-journal choice.
        const sessionJournalEntries = readExecutionConfig(claudeDir).sessionJournalEntries ?? 3;
        const updated = this._buildClaudeMdDoctrine(
          existingClaudeMd,
          delegationMode,
          reviewEnabled,
          root,
          sessionJournalEntries
        );
        fs.writeFileSync(claudeMdPath, updated);
      } catch (err) {
        claudeMdError = claudeMdError ?? String(err);
      }

      // 7f. Backfill routing keywords for the roster now fully on disk (see
      // the comment where step 6b used to call this, above) — runs after
      // every agent-file install (7c/7d2/7e) so a fresh install's
      // agent-keywords.json entries cover the whole roster on the very
      // first render, not just whatever existed before this install ran.
      // Best-effort — internally try/caught, never fails the hook install.
      this._ensureAgentKeywordsSeeded();

      // 7g. Re-run the panel-open auto-heal for the project-plan skill in
      // this same activation, so any staleness/heal logic added there later
      // also applies to a fresh install/repair, not just the next panel
      // open. Cheap no-op when the feature is off or the skill is already
      // current (see 7a3 above and _ensureProjectPlanSkillFresh).
      this._ensureProjectPlanSkillFresh();

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
          } else if (workerAgentFingerprintMatches(existing, a)) {
            // Old-format file predating the `tier:` line (and possibly the
            // `name:`/`description:` fields, or carrying a vendor-prefixed
            // `model:`) so `agentMarkdownTier` can't match — but its
            // `model:` alias + exact `## Keywords (for task routing)` body
            // still fingerprint it as ours. Repair frontmatter only; never
            // fully regenerate here, since a genuine foreign file could in
            // principle fingerprint-match on those two signals alone and a
            // tier mismatch is otherwise our only "not ours" signal for it.
            const repaired = resyncAgentFrontmatterFields(existing, a);
            if (repaired !== null) {
              fs.writeFileSync(agentPath, repaired);
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
   * `workerAgentsForProject`): always `search-retrieval` and `primary-agent`
   * (the Wildcard Agent — the id must match the `fallback_agent` default,
   * see `_readKeywordsConfig`'s fallback return value); for non-UEFN projects also
   * `coding-specialist` and `ux-ui-designer`. Called both from
   * `_ensureWorkerAgentsInstalled` (panel-open auto-heal, gated on
   * `_hooksInstalledForRoot`) and from `_handleInstallHooks` (explicit
   * Install/Repair), so both a fresh install and an upgraded older project
   * end up with the Wildcard Agent on disk. Unlike
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
            fs.writeFileSync(agentPath, buildAgentMarkdown(a, "worker"));
          } else if (a.id === "primary-agent") {
            // p33-t2 narrow refresh: an existing primary-agent.md that
            // still carries BOTH the old default H1 heading and the old
            // default description/role line is a stock file nobody has
            // customized — rewrite it to the current template so the
            // "Fallback Agent" -> "Wildcard Agent" rename reaches already
            // installed projects. Anything else (a different H1, a
            // different description, or a mix) is left byte-for-byte
            // untouched — that mismatch is the signal a user edited it.
            // The old strings are pinned as constants here (not derived
            // from the current catalog) so a FUTURE rename of this agent
            // must explicitly decide what counts as "old default" rather
            // than silently matching itself.
            try {
              const existing = fs.readFileSync(agentPath, "utf8");
              if (primaryAgentIsStockDefault(existing)) {
                fs.writeFileSync(agentPath, buildAgentMarkdown(a, "worker"));
              }
            } catch {
              /* best-effort; leave the file alone on any read/parse error */
            }
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
    // and sessionJournalEntries settings — re-read the merged execution.json
    // so a mode switch never silently resets the Review-pass or Session
    // Journal sections on/off.
    const execCfgForMode = readExecutionConfig(path.join(root, ".claude"));
    const reviewEnabled = execCfgForMode.reviewEnabled ?? true;
    const sessionJournalEntries = execCfgForMode.sessionJournalEntries ?? 3;

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
        renderDelegationDoctrine(
          mode,
          reviewEnabled,
          this._buildDoctrineRoster(root),
          this._resolveReviewAgentId(root),
          sessionJournalEntries,
          readProjectPlanEnabled(root)
        )
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

    const execCfgForReview = readExecutionConfig(path.join(root, ".claude"));
    const mode = execCfgForReview.delegation_mode;
    // Read back the current sessionJournalEntries so toggling Review pass
    // never silently strips the (unrelated) Session Journal section.
    const sessionJournalEntries = execCfgForReview.sessionJournalEntries ?? 3;

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
        renderDelegationDoctrine(
          mode,
          enabled,
          this._buildDoctrineRoster(root),
          this._resolveReviewAgentId(root),
          sessionJournalEntries,
          readProjectPlanEnabled(root)
        )
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

  /**
   * Set how many prompt/summary entries the session journal
   * (`.claude/session-journal.json`) retains (0 disables it). Mirrors
   * `_handleSetReviewEnabled`'s wiring exactly, but for the orthogonal
   * `sessionJournalEntries` count: persists `execution.json` (merge-safe),
   * re-renders the managed CLAUDE.md doctrine section via the same
   * direct `upsertDelegationSection(renderDelegationDoctrine(...))` call
   * `_handleSetReviewEnabled` uses (not `_buildClaudeMdDoctrine`, which is
   * the separate shared builder used by the install/auto-heal paths), and
   * — when enabling — ensures the journal file is gitignored, since it
   * stores raw user prompts that routinely contain pasted secrets and
   * absolute paths.
   */
  private _handleSetSessionJournalEntries(entries: number): void {
    const root = this._projectRoot();
    if (root === "") {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id: "session-journal-entries",
        field: "sessionJournalEntries",
        error: "No workspace folder open",
      });
      return;
    }

    // Defensive clamp to an integer 0-5, even though MSG_SCHEMAS already
    // validated this — belt and braces against a future caller that
    // bypasses the schema.
    const clamped = Math.min(5, Math.max(0, Math.trunc(entries)));

    try {
      const claudeDir = path.join(root, ".claude");
      writeExecutionConfig(claudeDir, { sessionJournalEntries: clamped });

      // The journal stores raw user prompts (routinely containing pasted
      // secrets and absolute paths) — never let it land in version control.
      // Only written when enabling, and only into an already-git-tracked
      // project (never guess a VCS that isn't there — same gate
      // `detectIgnoreTargets` applies for `.gitignore`).
      if (clamped > 0) {
        const hasGit =
          fs.existsSync(path.join(root, ".git")) || fs.existsSync(path.join(root, ".gitignore"));
        if (hasGit) {
          this._appendIgnoreEntries(path.join(root, ".gitignore"), "# TycoonAgents runtime artifacts", [
            ".claude/session-journal.json",
          ]);
        }
      }
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id: "session-journal-entries",
        field: "sessionJournalEntries",
        error: String(err),
      });
      return;
    }

    const mode = readExecutionConfig(path.join(root, ".claude")).delegation_mode;
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
        renderDelegationDoctrine(
          mode,
          reviewEnabled,
          this._buildDoctrineRoster(root),
          this._resolveReviewAgentId(root),
          clamped,
          readProjectPlanEnabled(root)
        )
      );
      fs.writeFileSync(claudeMdPath, updated);
    } catch (err) {
      claudeMdError = String(err);
    }

    void this._panel.webview.postMessage({
      type: MSG.SETTINGS_UPDATED,
      ok: true,
      id: "session-journal-entries",
      field: "sessionJournalEntries",
      sessionJournalEntries: clamped,
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

  /**
   * Post a fresh MSG.STATE to the webview, WITH a live delegationHealth
   * payload attached (see _computeCumulativeDelegationHealth /
   * _sessionDelegationHealthThrottled doc comments). Shared by
   * runtime.onChange (every state mutation) and the READY handler (first
   * paint after the panel opens), so both paths post the same shape.
   *
   * Extracted to its own testable method specifically so the regression this
   * closes — the Delegation tab's "Orchestrator direct tool use" meter
   * freezing at whatever it read the one time Settings happened to be
   * opened, while every other number on the tab kept updating live — has a
   * seam a test can assert against directly (capture what gets posted and
   * check `delegationHealth` is present/populated), rather than only
   * exercising the helper methods in isolation. See
   * test/panelDelegationHealthLive.test.ts's "_postStateUpdate" tests: they
   * would have failed if just the `delegationHealth: {...}` line here had
   * been dropped/reverted, which the earlier (helpers-only) test suite would
   * NOT have caught.
   *
   * 0.0.528: also attaches `sessionMetrics` — the SAME session-scoped
   * `agentMetrics` array `session` (above) already carries, promoted to its
   * own top-level field so the Metrics tab can render a full per-agent table
   * scoped to "this session" (Tasks/MCP/Time/Tokens columns), not just the
   * orchestrator's narrow direct-tool-use counters `delegationHealth.session`
   * exposes. `state`/`delegationHealth` (the cumulative fields) are
   * UNCHANGED — `sessionMetrics` is purely additive so nothing that already
   * consumes this payload changes behavior.
   *
   * Also attaches `toolCompliance` (orchestratorDirectCalls/workerToolCalls,
   * ALL-TIME — see _computeToolCompliance) for the Delegation tab's
   * compliance line. Undefined when there's no project folder open or no
   * activity.jsonl yet; the webview renders nothing in that case rather than
   * a fabricated 0%.
   */
  private _postStateUpdate(state: MetricsWorldState): void {
    const root = this._projectRoot();
    const cumulative = this._computeCumulativeDelegationHealth(state);
    const session = root !== "" ? this._sessionDelegationHealthThrottled(root) : undefined;
    const toolCompliance = root !== "" ? this._toolComplianceThrottled(root) : undefined;
    // sessionMetrics: the current session's agentMetrics, stamped with roster
    // models the same way cumulative `state.agentMetrics` is (so the webview
    // can render session rows through the exact same code path as cumulative
    // ones). Built inline (not a separate helper) so this stays within the
    // set of `this.*` members _postStateUpdate already depends on. Two
    // honest "unavailable" cases — the webview's scope toggle must render the
    // REASON, never a fabricated "0 tokens this session":
    //   - no project folder open (`root === ""`) — nothing to scope to.
    //   - no activity.jsonl yet, or it carries no sessionId yet (session ===
    //     undefined) — the current session hasn't produced a taggable record.
    const sessionMetrics:
      | { available: true; sessionId: string; agentMetrics: AgentMetric[] }
      | { available: false; reason: string } =
      root === ""
        ? { available: false, reason: "No project folder is open." }
        : session === undefined
          ? { available: false, reason: "This session hasn't recorded any activity yet." }
          : {
              available: true,
              sessionId: session.sessionId,
              agentMetrics: this._stampRosterModels({ agentMetrics: session.agentMetrics }).agentMetrics,
            };
    void this._panel.webview.postMessage({
      type: MSG.STATE,
      state: this._stampRosterModels(this._applyTimeAdjustments(state)),
      delegationHealth: { ...cumulative, session },
      sessionMetrics,
      toolCompliance,
    });
  }

  /**
   * Cheap, in-memory cumulative delegationHealth fields for the orchestrator,
   * derived from the live runtime state's agentMetrics — no disk I/O, safe to
   * call on every runtime.onChange tick. Mirrors the per-record increments
   * mapHookRecord/applyEvent already did when the events were ingested, so
   * this is just a read of already-computed state, not a rebuild.
   */
  private _computeCumulativeDelegationHealth(
    state: MetricsWorldState
  ): { directSearches: number; directReads: number; directEdits: number; delegations: number; tokens: number } {
    const orchMetric = Array.isArray(state.agentMetrics)
      ? state.agentMetrics.find((m) => m.id === "orchestrator")
      : undefined;
    return {
      directSearches: orchMetric?.directSearches ?? 0,
      directReads: orchMetric?.directReads ?? 0,
      directEdits: orchMetric?.directEdits ?? 0,
      delegations: orchMetric?.delegations ?? 0,
      tokens: Array.isArray(state.agentMetrics)
        ? state.agentMetrics.reduce((sum, m) => sum + (m?.tokens ?? 0), 0)
        : 0,
    };
  }

  /**
   * Read only the COMPLETE lines appended to `activityPath` in the byte range
   * [fromOffset, uptoSize) — mirrors ClaudeCodeProvider.drain()'s trailing-
   * partial-line handling: only the range up to the LAST confirmed newline is
   * parsed, and `newOffset` never advances past it. A record flushed
   * mid-write (half-written when this reads it) is therefore left
   * unconsumed and safely re-read whole on the next call, never dropped or
   * corrupted. `newOffset` equals `fromOffset` if no complete line resolved
   * this call (e.g. the entire appended chunk is one still-unterminated
   * line).
   */
  private _readActivityRecordsSince(
    activityPath: string,
    fromOffset: number,
    uptoSize: number
  ): { records: HookRecord[]; newOffset: number } {
    if (uptoSize <= fromOffset) return { records: [], newOffset: fromOffset };
    const length = uptoSize - fromOffset;
    const fd = fs.openSync(activityPath, "r");
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, fromOffset);
    } finally {
      fs.closeSync(fd);
    }
    // Search the raw buffer for 0x0A before decoding so the offset stays
    // byte-accurate across multi-byte UTF-8 sequences that might straddle
    // this chunk's end.
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) return { records: [], newOffset: fromOffset };
    const complete = buffer.subarray(0, lastNewline);
    const newOffset = fromOffset + lastNewline + 1;
    const records: HookRecord[] = [];
    for (const line of complete.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") records.push(parsed as HookRecord);
      } catch {
        /* skip malformed line */
      }
    }
    return { records, newOffset };
  }

  /**
   * Build the delegationHealth payload shape from a working state + the
   * session id it's scoped to (undefined session id -> undefined result,
   * matching "no session data yet"). `agentMetrics` is added as a sibling of
   * `health` (0.0.528, per-agent session-scoped Metrics tab support): the
   * incremental session rebuild already produces a full MetricsWorldState
   * (see _computeSessionDelegationHealth's doc comment) with a per-agent
   * `agentMetrics` array — `health` only ever read the orchestrator's slice
   * of it plus a cross-agent token sum, so surfacing the whole array here is
   * a read of already-computed data, not new folding work.
   */
  private _sessionHealthResult(
    state: MetricsWorldState,
    sessionId: string | undefined
  ): {
    sessionId: string;
    health: { directSearches: number; directReads: number; directEdits: number; delegations: number; tokens: number };
    agentMetrics: AgentMetric[];
  } | undefined {
    if (sessionId === undefined) return undefined;
    const orchMetric = state.agentMetrics.find((m) => m.id === "orchestrator");
    return {
      sessionId,
      health: {
        directSearches: orchMetric?.directSearches ?? 0,
        directReads: orchMetric?.directReads ?? 0,
        directEdits: orchMetric?.directEdits ?? 0,
        delegations: orchMetric?.delegations ?? 0,
        tokens: state.agentMetrics.reduce((sum, m) => sum + (m.tokens ?? 0), 0),
      },
      agentMetrics: state.agentMetrics,
    };
  }

  /**
   * Session-scoped delegationHealth: the orchestrator's direct-tool-use
   * counters for the CURRENT session id, via the same reducer path the live
   * runtime uses (mapHookRecord -> applyEvent). Cost is proportional to
   * bytes APPENDED since the last call, not the total activity.jsonl size —
   * see _sessionHealthCache's doc comment. Three cases, checked via a single
   * fs.statSync (no read at all unless the file actually changed):
   *   (a) size+mtime unchanged since last call -> return the cached result,
   *       zero bytes read. The log is idle between tool calls most of the
   *       time, so this is the common case.
   *   (b) file grew -> read ONLY the newly appended bytes (from the stored
   *       offset) and fold them into the cached running state. A session
   *       boundary (a new sessionId appears) resets the running state to
   *       start clean for the new session, without re-reading anything
   *       already on disk.
   *   (c) file shrank (rotation, deletion+recreation, or a different
   *       project's log now at this path) -> the cache is invalidated and
   *       this falls through to a full read from offset 0, same as a cold
   *       start.
   * The very first call ever (no cache yet) necessarily reads the whole file
   * once — there is nothing to diff against — but every call after that is
   * O(delta), not O(total). _handleGetSettings calls this directly (rare,
   * user-triggered); the live runtime.onChange path goes through the
   * additional call-frequency throttle in _sessionDelegationHealthThrottled.
   */
  private _computeSessionDelegationHealth(
    root: string
  ): {
    sessionId: string;
    health: { directSearches: number; directReads: number; directEdits: number; delegations: number; tokens: number };
    agentMetrics: AgentMetric[];
  } | undefined {
    const activityPath = path.join(root, ".claude", "tycoon", "activity.jsonl");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(activityPath);
    } catch {
      // File missing (not yet created, or this root has none) -> nothing to
      // report. Drop any stale cache too, so a file that later appears (or a
      // different project root on a later call) starts clean.
      this._sessionHealthCache = undefined;
      return undefined;
    }

    const cache = this._sessionHealthCache;
    if (cache !== undefined && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
      // (a) Idle: nothing appended since last time -> zero disk reads.
      return this._sessionHealthResult(cache.state, cache.sessionId);
    }

    // (c) Shrank/replaced (or no cache yet, i.e. the very first call): reset
    // and treat as a from-scratch read of the whole file. Mirrors
    // ClaudeCodeProvider.drain()'s own "size < offset -> truncated/rotated"
    // detection.
    const shrankOrReplaced = cache === undefined || stat.size < cache.size;
    let workingState: MetricsWorldState = shrankOrReplaced ? initialWorldState() : cache!.state;
    let workingSessionId: string | undefined = shrankOrReplaced ? undefined : cache!.sessionId;
    const fromOffset = shrankOrReplaced ? 0 : cache!.offset;

    // (b) Read only [fromOffset, stat.size) — the full file on a cold/reset
    // start, or just the appended tail otherwise.
    const { records, newOffset } = this._readActivityRecordsSince(activityPath, fromOffset, stat.size);
    for (const record of records) {
      const sid = record.sessionId;
      if (sid === undefined || sid === "") {
        // No sessionId on this record (older SubagentStop/Stop rows predate
        // the fix that stamps them; some other event kind may still omit it).
        // The log is append-only and chronological, so an unstamped record
        // belongs to whichever session was already active when it was
        // written -> inherit workingSessionId and let it contribute below.
        // If no session has been identified yet, there is nothing to
        // inherit into: the record precedes any known session and is
        // skipped, same as before this fix.
        if (workingSessionId === undefined) continue;
      } else if (workingSessionId === undefined) {
        workingSessionId = sid;
      } else if (sid !== workingSessionId) {
        // Session boundary: everything folded so far belonged to the
        // PREVIOUS session — start clean for the new one. No re-read needed;
        // records before this point correctly don't count toward either the
        // old session (they're behind us) or the new one (they predate it).
        workingState = initialWorldState();
        workingSessionId = sid;
      }
      for (const event of mapHookRecord(record)) {
        workingState = applyEvent(workingState, event);
      }
    }

    this._sessionHealthCache = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset: newOffset,
      sessionId: workingSessionId,
      state: workingState,
    };

    return this._sessionHealthResult(workingState, workingSessionId);
  }

  /**
   * Throttled wrapper around _computeSessionDelegationHealth for the hot
   * runtime.onChange path: recomputes at most once per
   * SESSION_HEALTH_THROTTLE_MS, returning the cached value between
   * recomputes (undefined until the first successful compute, or if the
   * activity log carries no session id yet).
   *
   * `sessionId`/`agentMetrics` (0.0.528) are folded in alongside the
   * pre-existing `health` fields rather than fetched via a second throttled
   * call — both come from the SAME _computeSessionDelegationHealth() result,
   * so this stays one stat()-rate-limited recompute per tick, not two. This
   * is what feeds the Metrics tab's "This session" scope (see
   * _postStateUpdate's `sessionMetrics` field).
   */
  private _sessionDelegationHealthThrottled(
    root: string
  ):
    | {
        directSearches: number;
        directReads: number;
        directEdits: number;
        delegations: number;
        tokens: number;
        sessionId: string;
        agentMetrics: AgentMetric[];
      }
    | undefined {
    const now = Date.now();
    if (
      this._cachedSessionDelegationHealthAt === 0 ||
      now - this._cachedSessionDelegationHealthAt >= TycoonPanel.SESSION_HEALTH_THROTTLE_MS
    ) {
      const result = this._computeSessionDelegationHealth(root);
      this._cachedSessionDelegationHealth = result
        ? { ...result.health, sessionId: result.sessionId, agentMetrics: result.agentMetrics }
        : undefined;
      this._cachedSessionDelegationHealthAt = now;
    }
    return this._cachedSessionDelegationHealth;
  }

  /**
   * ALL-TIME delegation-compliance tally: how many PreToolUse records for a
   * tool in TOOL_COMPLIANCE_TOOLS (Read/Grep/Glob/Edit/Write/Bash) were made
   * directly by `workerId === "orchestrator"` (or an omitted workerId, which
   * mapHookRecord treats identically — see hookRecord.ts) vs. by any other
   * workerId. A UUID-format workerId is a legacy/malformed record, same skip
   * mapHookRecord applies elsewhere — see this method's UUID_RE note.
   *
   * Unlike _computeSessionDelegationHealth, this NEVER resets on a session
   * boundary — the Delegation tab's compliance line is deliberately all-time
   * (matching every other figure on that tab; see its
   * "All figures below are all time" caption in media/main.js). It otherwise
   * mirrors that method's incremental-read shape exactly: idle (unchanged
   * size+mtime) short-circuits to zero reads, growth reads only the
   * newly-appended bytes via _readActivityRecordsSince, and a shrink/replace
   * (rotation, deletion+recreation, different project root) falls back to a
   * clean full read from offset 0.
   */
  private _computeToolCompliance(
    root: string
  ): { orchestratorDirectCalls: number; workerToolCalls: number } | undefined {
    const activityPath = path.join(root, ".claude", "tycoon", "activity.jsonl");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(activityPath);
    } catch {
      this._toolComplianceCache = undefined;
      return undefined;
    }

    const cache = this._toolComplianceCache;
    if (cache !== undefined && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
      return { orchestratorDirectCalls: cache.orchestratorDirectCalls, workerToolCalls: cache.workerToolCalls };
    }

    const shrankOrReplaced = cache === undefined || stat.size < cache.size;
    let orchestratorDirectCalls = shrankOrReplaced ? 0 : cache!.orchestratorDirectCalls;
    let workerToolCalls = shrankOrReplaced ? 0 : cache!.workerToolCalls;
    const fromOffset = shrankOrReplaced ? 0 : cache!.offset;

    const { records, newOffset } = this._readActivityRecordsSince(activityPath, fromOffset, stat.size);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const record of records) {
      if (record.event !== "PreToolUse") continue;
      if (!record.tool || !TycoonPanel.TOOL_COMPLIANCE_TOOLS.has(record.tool)) continue;
      // Mirrors mapHookRecord's own UUID-workerId skip (legacy/malformed
      // record from an old hook version) so this tally never over-credits
      // "orchestrator" the same way that reducer avoids doing.
      if (record.workerId !== undefined && UUID_RE.test(record.workerId)) continue;
      const workerId = record.workerId ?? "orchestrator";
      if (workerId === "orchestrator") orchestratorDirectCalls++;
      else workerToolCalls++;
    }

    this._toolComplianceCache = { size: stat.size, mtimeMs: stat.mtimeMs, offset: newOffset, orchestratorDirectCalls, workerToolCalls };
    return { orchestratorDirectCalls, workerToolCalls };
  }

  /**
   * Throttled wrapper around _computeToolCompliance for the hot
   * runtime.onChange path — same SESSION_HEALTH_THROTTLE_MS cadence and
   * "return cached value between recomputes" contract as
   * _sessionDelegationHealthThrottled, kept as an independent throttle
   * timestamp since the two caches (session-scoped vs. all-time) rebuild on
   * different triggers (session boundaries vs. never).
   */
  private _toolComplianceThrottled(root: string): { orchestratorDirectCalls: number; workerToolCalls: number } | undefined {
    const now = Date.now();
    if (
      this._cachedToolComplianceAt === 0 ||
      now - this._cachedToolComplianceAt >= TycoonPanel.SESSION_HEALTH_THROTTLE_MS
    ) {
      this._cachedToolCompliance = this._computeToolCompliance(root);
      this._cachedToolComplianceAt = now;
    }
    return this._cachedToolCompliance;
  }

  /**
   * Post the current routing view (see src/core/routingHostOps.ts's
   * RoutingView), plus the Agents screen's UI-mode fields (p74-t1):
   * `uiMode`, `harness`, `multiProviderSetting`,
   * `multiProviderCheckboxVisible`, and — only in single mode —
   * `singleProvider`. VS Code is never the "standalone" harness, so the
   * checkbox is hidden only for opencode here (see agentsUiMode.ts).
   */
  private _handleGetRouting(): void {
    const root = this._projectRoot();
    const view = buildRoutingView({ root, env: process.env });
    const harness = this._resolveEffectiveHarness(root);
    const multiProviderSetting = !!vscode.workspace
      .getConfiguration("tycoonagents")
      .get("agents.multiProvider", false);
    const uiMode = resolveAgentsUiMode({ harness, multiProvider: multiProviderSetting });
    const payload: Record<string, unknown> = {
      ...view,
      uiMode,
      harness,
      multiProviderSetting,
      multiProviderCheckboxVisible: harness.toLowerCase() !== "opencode",
    };
    if (uiMode === "single") {
      payload.singleProvider = singleProviderTiers(harness);
    }
    void this._panel.webview.postMessage({ type: MSG.ROUTING, payload });
  }

  /** Handles MSG.SET_AGENTS_MULTI_PROVIDER (p74-t1): writes the
   *  `tycoonagents.agents.multiProvider` setting at Global scope (per user,
   *  not per workspace — matches the setting's package.json "application"
   *  scope), then re-posts a fresh MSG.ROUTING so the Agents screen's
   *  uiMode flips immediately. */
  private async _handleSetAgentsMultiProvider(value: boolean): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration("tycoonagents")
        .update("agents.multiProvider", value, vscode.ConfigurationTarget.Global);
    } catch (err) {
      console.error("TycoonAgents: setAgentsMultiProvider failed:", err instanceof Error ? err.message : err);
    }
    this._handleGetRouting();
  }

  /**
   * Validate + write a new routing profile, run both generators, then
   * re-post a fresh MSG.ROUTING (mirrors _handleSetAgentModel's re-post
   * pattern). scriptsDir is this extension's own install root — the
   * generator scripts live at `<extensionPath>/scripts/*.mjs`.
   */
  private _handleSaveRouting(profile: unknown): void {
    const root = this._projectRoot();
    const effectiveHarness = this._resolveEffectiveHarness(root);
    const result = saveRoutingProfile({ root, profile, scriptsDir: this._extensionUri.fsPath, effectiveHarness });
    void this._panel.webview.postMessage({ type: MSG.ROUTING_SAVED, ...result });
    this._handleGetRouting();
  }

  /** Shared effective-harness resolution for saveRoutingProfile callers
   *  (p20-t1) — same describeProviderSelection call _buildRoutingVisibility
   *  and _buildHarnessSettings already make, falling back to "claude-code"
   *  on any error so a save is never blocked by an unrelated failure here. */
  private _resolveEffectiveHarness(root: string): string {
    const settingValue = readExplicitProviderSetting(vscode.workspace.getConfiguration("tycoonagents"));
    try {
      return describeProviderSelection({ settingValue, cwd: root }).effective;
    } catch {
      return "claude-code";
    }
  }

  /** Handles MSG.CLEAR_AGENT_ROUTE (p20-t1): removes one agent's explicit
   *  routing.json entry, then re-posts SETTINGS + ROUTING like
   *  _handleSetAgentModel does. */
  private async _handleClearAgentRoute(agentId: string): Promise<void> {
    if (!isSafeAgentId(agentId)) {
      console.error(`TycoonAgents: clearAgentRoute rejected unsafe agent id "${agentId}".`);
      return;
    }
    const root = this._projectRoot();
    try {
      const result = await clearAgentRoute(root, agentId, { scriptsDir: this._extensionUri.fsPath });
      if (result.handled && !result.ok) {
        console.error("TycoonAgents: clearAgentRoute failed:", result.errors.join("; "));
      }
      this._rosterModelCache = undefined;
    } catch (err) {
      console.error("TycoonAgents: clearAgentRoute failed:", err instanceof Error ? err.message : err);
    }
    this._handleGetSettings();
    this._handleGetRouting();
  }

  /** Delete routing.json and rerun both generators, then re-post a fresh MSG.ROUTING. */
  private _handleClearRouting(): void {
    const root = this._projectRoot();
    const result = clearRoutingProfile({ root, scriptsDir: this._extensionUri.fsPath });
    void this._panel.webview.postMessage({ type: MSG.ROUTING_SAVED, ...result });
    this._handleGetRouting();
  }

  /** Boolean-only env-var presence probe (never a value) for the Routing screen's credential indicators. */
  private _handleProbeEnv(names: string[]): void {
    const result = probeEnv(names, process.env);
    void this._panel.webview.postMessage({ type: MSG.ENV_PROBE, payload: result });
  }

  /**
   * Store a per-user, outside-any-project value for `name` (p13-t6) and
   * reply with a fresh envProbe entry for just that name — the value
   * itself is NEVER echoed back or logged.
   */
  private _handleSetLocalEnvValue(name: string, value: string): void {
    try {
      const entry = setLocalEnvValue(name, value, process.env);
      void this._panel.webview.postMessage({ type: MSG.ENV_PROBE, payload: { [name]: entry } });
    } catch (err) {
      console.error("TycoonAgents: setLocalEnvValue failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Clear a per-user stored value for `name` (p13-t6) and reply with a fresh envProbe entry. */
  private _handleClearLocalEnvValue(name: string): void {
    try {
      const entry = clearLocalEnvValue(name, process.env);
      void this._panel.webview.postMessage({ type: MSG.ENV_PROBE, payload: { [name]: entry } });
    } catch (err) {
      console.error("TycoonAgents: clearLocalEnvValue failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * "Test connection" for a fixed vendor key row: runs the vendor's bridge
   * (src/core/vendorKeyTest.ts) and posts only { vendor, state, message } —
   * never a key value.
   */
  private async _handleTestVendorKey(vendorId: string, model: string | undefined): Promise<void> {
    let payload: VendorKeyTestResult;
    try {
      payload = await runVendorKeyTest({
        vendorId,
        model,
        projectRoot: this._projectRoot(),
        hooksDir: path.join(this._extensionUri.fsPath, "hooks"),
      });
    } catch (err) {
      console.error("TycoonAgents: testVendorKey failed:", err instanceof Error ? err.message : err);
      payload = { vendor: vendorId, state: "error", message: "The test call failed." };
    }
    if (this._disposed) return;
    void this._panel.webview.postMessage({ type: MSG.VENDOR_KEY_TEST_RESULT, payload });
  }

  /**
   * "Test connection" for a Custom endpoint slot row: direct cheapest call to
   * the base URL named by the slot's endpointEnv (src/core/vendorKeyTest.ts
   * runCustomEndpointTest). The webview sends only the slot id and variable
   * NAMES; both are validated host-side. Posts { vendor, state, message }.
   */
  private async _handleTestCustomEndpoint(req: { slotId: string; endpointEnv: string; apiKeyEnv?: string; slotVendor?: string; model?: string }): Promise<void> {
    let payload: VendorKeyTestResult;
    try {
      payload = await runCustomEndpointTest({
        slotId: req.slotId.slice(0, 120),
        endpointEnv: req.endpointEnv.slice(0, 80),
        apiKeyEnv: req.apiKeyEnv ? req.apiKeyEnv.slice(0, 80) : undefined,
        vendor: req.slotVendor ? req.slotVendor.slice(0, 80) : undefined,
        model: req.model,
        projectRoot: this._projectRoot(),
      });
    } catch (err) {
      console.error("TycoonAgents: testCustomEndpoint failed:", err instanceof Error ? err.message : err);
      payload = { vendor: `custom:${req.slotId.slice(0, 120)}`, state: "error", message: "The test call failed." };
    }
    if (this._disposed) return;
    void this._panel.webview.postMessage({ type: MSG.VENDOR_KEY_TEST_RESULT, payload });
  }

  /**
   * p101-t2: writes GEMINI_MCP_BACKEND into the gemini server's env in the
   * project .mcp.json (src/core/hostBridgeSettings.ts; nothing else in the
   * file changes), replies { ok, error? }, then re-posts MSG.ROUTING.
   */
  private _handleSetGeminiBackend(value: "agy" | "gemini"): void {
    const result = setGeminiBackend(this._projectRoot(), value);
    void this._panel.webview.postMessage({ type: MSG.SET_GEMINI_BACKEND_RESULT, payload: result });
    this._handleGetRouting();
  }

  /** Post the current settings snapshot (hook + per-agent model/keywords). */
  private _handleGetSettings(): void {
    const root = this._projectRoot();
    const agentsDir = path.join(root, ".claude", "agents");

    // p68-t1: Agents screen open -> recompute keyword health alongside settings.
    this._postKeywordHealth();

    const keywordsConfig = this._readKeywordsConfig(root);
    const keywordAgents =
      keywordsConfig &&
      typeof keywordsConfig.agents === "object" &&
      keywordsConfig.agents !== null
        ? keywordsConfig.agents
        : {};

    // p18-t1: route-derived fields (resolvedModel/vendor/costModelClass/
    // claudeTier/routeSource/handWrittenBackend), keyed by agent id, from the
    // SAME shared helper the standalone server uses so both hosts agree.
    const agentRoutes = describeAgentRoutes(root, { harness: this._resolveEffectiveHarness(root) });

    const agents = loadAgentRoster(agentsDir).map((agent) => {
      const entry = keywordAgents[agent.id];
      const keywords =
        entry && typeof entry.pattern === "string" ? entry.pattern : "";
      const route = agentRoutes[agent.id];
      return {
        id: agent.id,
        name: agent.name,
        // `model` reflects the RESOLVED route's Claude tier (falling back to
        // the roster's raw frontmatter for an agent buildRoutingView didn't
        // see) so the Settings radios track routing.json overrides, not just
        // frontmatter.
        model: route?.claudeTier ?? shortFromModelId(agent.model) ?? null,
        isOrchestrator: agent.id === "orchestrator",
        keywords,
        resolvedModel: route?.resolvedModel ?? null,
        vendor: route?.vendor ?? null,
        costModelClass: route?.costModelClass ?? null,
        claudeTier: route?.claudeTier ?? null,
        routeSource: route?.routeSource ?? "frontmatter",
        handWrittenBackend: route?.handWrittenBackend ?? false,
        harnessDefault: route?.harnessDefault ?? null,
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

    // Build delegationHealth from orchestrator metric. Shared with the live
    // runtime.onChange push (see _computeCumulativeDelegationHealth /
    // _computeSessionDelegationHealth doc comments) so both paths report the
    // same numbers computed the same way — this handler just isn't throttled
    // since it only runs on explicit user action, not a hot loop.
    const state = this._runtime.getState();
    const { directSearches, directReads, directEdits, delegations, tokens: cumulativeTokens } =
      this._computeCumulativeDelegationHealth(state);

    // "This session" scoping: the current session id's counters, via the
    // SAME reducer path the live runtime uses (mapHookRecord -> applyEvent),
    // read incrementally (see _computeSessionDelegationHealth). Additive to
    // the cumulative fields above, which remain unchanged (back-compat).
    const sessionResult = this._computeSessionDelegationHealth(root);
    const sessionHealth = sessionResult?.health;
    const currentSessionId = sessionResult?.sessionId;

    // Run hook diagnostic to compute hookHealth for the settings panel
    const { findings } = this._diagnoseHooks();
    const issueCount = findings.filter((f) => f.severity !== "ok").length;
    // Codex harness: report the Codex notify hook, not the Claude hooks.
    const codexSlice = this._effectiveHarness(root) === "codex" ? this._codexHookSettingsSlice() : undefined;
    const hookHealth = codexSlice
      ? { healthy: codexSlice.healthy, issueCount: codexSlice.healthy ? 0 : 1, harness: "codex", status: codexSlice.status, label: codexSlice.label }
      : { healthy: issueCount === 0, issueCount };

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
    const sessionJournalEntries = execCfg.sessionJournalEntries ?? 3;

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
        hook: codexSlice
          ? { installed: codexSlice.status === "installed", lastActivityAt, harness: "codex", status: codexSlice.status, label: codexSlice.label }
          : { installed: this._hookInstalled(root), lastActivityAt },
        agents,
        delegation_mode,
        reviewEnabled,
        sessionJournalEntries,
        delegationHealth: {
          directSearches,
          directReads,
          directEdits,
          delegations,
          tokens: cumulativeTokens,
          session: sessionHealth,
          sessionId: currentSessionId,
        },
        hookHealth,
        contextBudget,
        foreignManagedBlocks,
        harness: this._buildHarnessSettings(root),
        routing: this._buildRoutingVisibility(root),
      },
    });
  }

  /** Builds the `routing` slice of the SETTINGS payload (p18-t1): whether
   * the Routing screen should surface itself, and why. Uses the same
   * describeProviderSelection call `_buildHarnessSettings` already makes to
   * find the effective harness, so the two slices never disagree. */
  private _buildRoutingVisibility(root: string): RoutingVisibility {
    const effectiveHarness = this._resolveEffectiveHarness(root);
    try {
      return describeRoutingVisibility(root, effectiveHarness);
    } catch {
      return { visible: false, reason: "hidden", useMultipleLlms: false, profileActive: false, routedAgentCount: 0 };
    }
  }

  /** Builds the `harness` slice of the SETTINGS payload (p13-t7): which
   * Provider ("claude-code" | "opencode") is effective, what layer decided
   * it, and whether a change can apply live. */
  private _buildHarnessSettings(root: string): {
    effective: ProviderId;
    source: "env" | "setting" | "execution" | "default";
    fileValue: ProviderId | undefined;
    running: ProviderId | undefined;
    mismatch: boolean;
    options: { id: ProviderId; label: string }[];
    requiresRestart: boolean;
    needsDefaultRoute: boolean;
    warning?: string;
    codexHooksInstalled?: boolean;
    codexDispatcherInstalled?: boolean;
    codexHooksWarning?: string;
    codexDispatcherWarning?: string;
    codexAgentsMdWarning?: string;
    codexSandboxWarning?: string;
  } {
    const settingValue = readExplicitProviderSetting(vscode.workspace.getConfiguration("tycoonagents"));
    let description: ProviderSelectionDescription;
    let warning: string | undefined;
    try {
      description = describeProviderSelection({ settingValue, cwd: root });
    } catch (err) {
      console.error("TycoonAgents: describeProviderSelection failed, falling back to claude-code:", err instanceof Error ? err.message : err);
      warning = err instanceof Error
        ? `${err.message} Running on Claude Code. Update the extension or change the setting.`
        : "Configured provider is not supported by this build; running on Claude Code. Update the extension or change the setting.";
      description = { effective: "claude-code", source: "default", fileValue: undefined };
    }
    // Undefined only before any provider has ever started in this window
    // (no _getRunningProviderId wired yet) — treat that as "matches", since
    // there's nothing running to conflict with `effective` yet.
    const running = this._getRunningProviderId?.();
    const mismatch = running !== undefined && running !== description.effective;
    // p17-t4: nudge toward the Routing view's "Default for all agents" card
    // when OpenCode is effective and at least one agent is riding bare
    // frontmatter with no routing.json defaults to fall back on. Computed
    // via the shared routingHostOps helper (also used by the standalone
    // server) so both hosts agree on the condition. Never throws — an
    // unreadable/missing agents dir just yields an empty view, which
    // computeNeedsDefaultRoute treats as "nothing to nudge about".
    let needsDefaultRoute = false;
    try {
      const view = buildRoutingView({ root, env: process.env });
      needsDefaultRoute = computeNeedsDefaultRoute(description.effective, view);
    } catch {
      needsDefaultRoute = false;
    }
    // p23-t11: hook/dispatcher install-state flags, computed only when Codex
    // is the effective harness (cheap booleans elsewhere would just read as
    // stale/irrelevant noise for a provider not in use).
    const codexExtra =
      description.effective === "codex"
        ? {
            codexHooksInstalled: this._detectCodexHooksInstalled(root),
            codexDispatcherInstalled: this._detectCodexDispatcherInstalled(),
            ...this._codexHooksWarningField(),
            ...this._codexDispatcherWarningField(),
            ...this._codexSandboxWarningField(),
            ...(this._codexAgentsMdWarning !== undefined ? { codexAgentsMdWarning: this._codexAgentsMdWarning } : {}),
          }
        : {};
    return {
      ...description,
      running,
      mismatch,
      options: [
        { id: "claude-code", label: "Claude Code" },
        { id: "opencode", label: "OpenCode (Experimental)" },
        { id: "codex", label: "Codex (Experimental)" },
      ],
      requiresRestart: mismatch,
      needsDefaultRoute,
      ...(warning !== undefined ? { warning } : {}),
      ...codexExtra,
    };
  }

  /** Handles MSG.SET_HARNESS: writes the chosen provider id into
   * .claude/tycoon/execution.json (the lowest-precedence, file-backed
   * layer — env/setting still win if present), attempts a live swap via
   * `_providerSwap` when wired in, then re-posts SETTINGS either way. The
   * re-posted payload's `running`/`mismatch` (via `_getRunningProviderId`)
   * reflect the swap's real outcome — no separate flag to keep in sync. */
  private _handleSetHarness(providerId: string): void {
    if (!(PROVIDER_IDS as readonly string[]).includes(providerId)) {
      console.error(`TycoonAgents: setHarness rejected unknown provider id "${providerId}".`);
      return;
    }
    const root = this._projectRoot();
    try {
      writeProviderSelection(root, providerId);
    } catch (err) {
      console.error("TycoonAgents: writeProviderSelection failed:", err instanceof Error ? err.message : err);
      return;
    }
    if (this._providerSwap) {
      try {
        this._providerSwap(providerId as ProviderId);
      } catch (err) {
        console.error("TycoonAgents: live provider swap failed:", err instanceof Error ? err.message : err);
      }
    }
    // Trigger (b) of the codex-doctrine-gap follow-up: switching the
    // provider TO codex refreshes AGENTS.md's Codex block right away, so
    // Codex sessions get the delegation doctrine without waiting for a
    // Routing save or a hook install. Switching AWAY from codex leaves the
    // block in place on purpose (see runCodexConfigGenerator's own doc
    // comment) — it's inert under another harness and removing it on every
    // switch would just make it reappear/disappear noisily.
    if (providerId === "codex") {
      try {
        this._runCodexConfigGenerator(root);
      } catch (err) {
        console.error("TycoonAgents: runCodexConfigGenerator (setHarness) failed:", err instanceof Error ? err.message : err);
      }
    }
    if (providerId === "codex") this._ensureCodexInstallsCurrent();
    this._handleGetSettings();
    // The Agents screen shows harness-default models (Codex), so refresh the
    // routing/uiMode payload too. Display only — no defaults are written.
    this._handleGetRouting();
  }

  // p23-t11: markers mirrored from installCodexHooks.ts's private
  // TOML_MARKER_START / HOOKS_JSON_MARKER_DESCRIPTION constants (not
  // exported — that file is owned by another task and must not be edited
  // here). Keep these two strings byte-identical to that file's if it
  // changes.
  private static readonly CODEX_HOOK_TOML_MARKER =
    "# tycoon-codex-hook: managed notify entry (do not edit by hand)";
  private static readonly CODEX_HOOKS_JSON_MARKER_DESCRIPTION =
    "tycoon-codex-hook: managed by TycoonAgents (do not edit by hand)";

  /** Extension-root copies of the Codex hook/dispatcher scripts (shipped
   * under hooks/, same posture as tycoon-claude-hook.cjs — see
   * _handleInstallHooks step 2). Never the repo's own hooks/ directory at
   * runtime; the extension ships its own copy. */
  private _codexHookScriptPath(): string {
    return vscode.Uri.joinPath(this._extensionUri, "hooks", "tycoon-codex-hook.cjs").fsPath;
  }
  private _codexDispatcherScriptPath(): string {
    return vscode.Uri.joinPath(this._extensionUri, "hooks", "tycoon-dispatcher-mcp.cjs").fsPath;
  }

  /** Bounded, never-throwing detection of whether the Codex notify hook is
   * installed: either CODEX_HOME/config.toml carries the managed marker, or
   * the project's .codex/hooks.json carries our marker description. */
  private _detectCodexHooksInstalled(root: string): boolean {
    try {
      const { codexHome } = resolveCodexHome({ env: process.env, platform: process.platform });
      const configTomlPath = path.join(codexHome, "config.toml");
      const hasToml =
        fs.existsSync(configTomlPath) &&
        fs.readFileSync(configTomlPath, "utf8").includes(TycoonPanel.CODEX_HOOK_TOML_MARKER);
      let hasHooksJson = false;
      if (root !== "") {
        const hooksJsonPath = path.join(root, ".codex", "hooks.json");
        if (fs.existsSync(hooksJsonPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
            hasHooksJson =
              parsed !== null &&
              typeof parsed === "object" &&
              (parsed as Record<string, unknown>).description === TycoonPanel.CODEX_HOOKS_JSON_MARKER_DESCRIPTION;
          } catch {
            hasHooksJson = false;
          }
        }
      }
      const state = this._detectCodexNotifyState();
      if (state === "blocked" || state === "stale-wrapped" || state === "stale-installed" || state === "wrapper-missing") {
        return false;
      }
      return hasToml || hasHooksJson || state === "wrapped";
    } catch {
      return false;
    }
  }

  /** Bounded, never-throwing read of how config.toml routes Codex's notify. */
  private _detectCodexNotifyState(): CodexNotifyState {
    try {
      const { codexHome } = resolveCodexHome({ env: process.env, platform: process.platform });
      const configTomlPath = path.join(codexHome, "config.toml");
      if (!fs.existsSync(configTomlPath)) return "none";
      return detectCodexNotifyState(
        fs.readFileSync(configTomlPath, "utf8"),
        this._codexHookScriptPath(),
        resolveNodeBinary(),
      );
    } catch {
      return "none";
    }
  }

  /** Warning shown beside "Codex hooks" when another tool owns the notify setting. */
  private _codexNotifyStateWarning(): string | undefined {
    const state = this._detectCodexNotifyState();
    if (state === "blocked") return CODEX_NOTIFY_BLOCKED_MESSAGE;
    if (state === "stale-wrapped" || state === "stale-installed") return CODEX_NOTIFY_STALE_MESSAGE;
    return undefined;
  }

  /** Bounded, never-throwing detection of whether the tycoon-dispatcher MCP
   * server entry is installed in CODEX_HOME/config.toml. Delegates to the
   * installer module's own exported check so the marker string is never
   * duplicated here. */
  private _detectCodexDispatcherInstalled(): boolean {
    try {
      if (!isDispatcherMarkerInConfigToml(process.env, process.platform)) return false;
      // An out-of-date entry reads as not installed, like the hooks row.
      return this._codexDispatcherState() !== "stale";
    } catch {
      return false;
    }
  }

  /** Managed dispatcher entry vs the script path this extension would install now. */
  private _codexDispatcherState(): "none" | "installed" | "stale" {
    try {
      return readCodexDispatcherState(process.env, process.platform, this._codexDispatcherScriptPath(), this._projectRoot() || undefined);
    } catch {
      return "none";
    }
  }

  private _codexDispatcherWarningField(): { codexDispatcherWarning?: string } {
    if (this._codexDispatcherState() === "stale") return { codexDispatcherWarning: CODEX_DISPATCHER_STALE_MESSAGE };
    return this._codexDispatcherWarnings && this._codexDispatcherWarnings.length > 0
      ? { codexDispatcherWarning: this._codexDispatcherWarnings.join(" ") }
      : {};
  }

  /** Warning while Codex's Windows sandbox is down (see core/state.ts codexSandboxWarning). Display only. */
  private _codexSandboxWarningField(): { codexSandboxWarning?: string } {
    try {
      const text = codexSandboxWarning(this._runtime?.getState());
      return text !== undefined ? { codexSandboxWarning: text } : {};
    } catch {
      return {};
    }
  }

  /**
   * An extension update moves the versioned install folder
   * (...\extensions\tycoonagents.tycoonagents-<version>\hooks\...), so the
   * paths we wrote into CODEX_HOME/config.toml point at a folder that is gone
   * and Codex silently stops reporting. When Codex is the harness, re-run the
   * hook install if the notify entry is stale and the dispatcher install if
   * its entry points at another version folder or a missing file. Only
   * entries we installed before are touched (stale-* states and the managed
   * dispatcher marker); a user who never installed gets nothing. Failures
   * surface through the existing warning fields.
   */
  private _ensureCodexInstallsCurrent(): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;
      const settingValue = readExplicitProviderSetting(vscode.workspace.getConfiguration("tycoonagents"));
      if (describeProviderSelection({ settingValue, cwd: root }).effective !== "codex") return;

      const hookState = this._detectCodexNotifyState();
      if (hookState === "stale-installed" || hookState === "stale-wrapped") {
        try {
          const result = installCodexHooks({
            projectDir: root,
            env: process.env,
            platform: process.platform,
            hookScriptPath: this._codexHookScriptPath(),
          });
          this._codexHookWarnings = result.warnings;
        } catch (err) {
          this._codexHookWarnings = [err instanceof Error ? err.message : String(err)];
        }
      }

      if (this._codexDispatcherState() === "stale") {
        try {
          const result = installCodexDispatcher({
            projectDir: root,
            env: process.env,
            platform: process.platform,
            serverScriptPath: this._codexDispatcherScriptPath(),
          });
          this._codexDispatcherWarnings = result.warnings;
        } catch (err) {
          this._codexDispatcherWarnings = [err instanceof Error ? err.message : String(err)];
        }
      }
    } catch {
      /* never block panel open or a harness switch on a repoint failure */
    }
  }

  private _codexHooksWarningField(): { codexHooksWarning?: string } {
    const stateWarning = this._codexNotifyStateWarning();
    if (stateWarning !== undefined) return { codexHooksWarning: stateWarning };
    return this._codexHookWarnings && this._codexHookWarnings.length > 0
      ? { codexHooksWarning: this._codexHookWarnings.join(" ") }
      : {};
  }

  private _codexHookWarnings?: string[];
  private _codexDispatcherWarnings?: string[];
  private _codexAgentsMdWarning?: string;

  /** Codex-doctrine-gap follow-up: runs scripts/generate-codex-config.mjs
   *  (AGENTS.md's TYCOON-CODEX-MANAGED block + codex-agents.toml.generated)
   *  for `root`, resolving the script from this extension's own install
   *  root exactly like _handleSaveRouting resolves the claude/opencode
   *  pair. Never throws: a failure is stashed in _codexAgentsMdWarning
   *  (surfaced via SETTINGS' harness.codexAgentsMdWarning, same pattern as
   *  codexHooksWarning) rather than blocking whichever trigger called this
   *  — installing hooks, switching provider to codex, or saving routing
   *  must never hard-fail just because the doctrine refresh did. */
  private _runCodexConfigGenerator(root: string): void {
    if (root === "") return;
    try {
      const result = runCodexConfigGenerator(root, this._extensionUri.fsPath);
      this._codexAgentsMdWarning =
        result.code === 0 ? undefined : `Couldn't update AGENTS.md for Codex: ${result.output || "unknown error"}`;
    } catch (err) {
      this._codexAgentsMdWarning = `Couldn't update AGENTS.md for Codex: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Handles MSG.INSTALL_CODEX_HOOKS: installs the Codex notify hook
   * (CODEX_HOME/config.toml + project .codex/hooks.json), then re-posts
   * SETTINGS so harness.codexHooksInstalled and any installer warnings
   * (folded into harness.codexHooksWarning) refresh immediately. */
  private _handleInstallCodexHooks(): void {
    const root = this._projectRoot();
    if (root === "") {
      console.error("TycoonAgents: installCodexHooks rejected — no workspace folder open.");
      return;
    }
    try {
      const result = installCodexHooks({
        projectDir: root,
        env: process.env,
        platform: process.platform,
        hookScriptPath: this._codexHookScriptPath(),
      });
      this._codexHookWarnings = result.warnings;
    } catch (err) {
      console.error("TycoonAgents: installCodexHooks failed:", err instanceof Error ? err.message : err);
      this._codexHookWarnings = [err instanceof Error ? err.message : String(err)];
    }
    // Trigger (a) of the codex-doctrine-gap follow-up: installing Codex
    // hooks from the panel is the first moment a project commits to Codex,
    // so refresh AGENTS.md's Codex block / codex-agents.toml.generated
    // right alongside the hook install (idempotent — safe to re-run).
    try {
      this._runCodexConfigGenerator(root);
    } catch (err) {
      console.error("TycoonAgents: runCodexConfigGenerator (installCodexHooks) failed:", err instanceof Error ? err.message : err);
    }
    this._handleGetSettings();
  }

  /** Handles MSG.UNINSTALL_CODEX_HOOKS: removes only what installCodexHooks
   * added (marker-scoped), then re-posts SETTINGS. */
  private _handleUninstallCodexHooks(): void {
    const root = this._projectRoot();
    if (root === "") {
      console.error("TycoonAgents: uninstallCodexHooks rejected — no workspace folder open.");
      return;
    }
    try {
      const result = uninstallCodexHooks({ projectDir: root, env: process.env, platform: process.platform });
      this._codexHookWarnings = result.warnings;
    } catch (err) {
      console.error("TycoonAgents: uninstallCodexHooks failed:", err instanceof Error ? err.message : err);
    }
    this._handleGetSettings();
  }

  /** Handles MSG.INSTALL_CODEX_DISPATCHER: registers the tycoon-dispatcher
   * MCP server entry in CODEX_HOME/config.toml, then re-posts SETTINGS. */
  private _handleInstallCodexDispatcher(): void {
    const root = this._projectRoot();
    if (root === "") {
      console.error("TycoonAgents: installCodexDispatcher rejected — no workspace folder open.");
      return;
    }
    try {
      const result = installCodexDispatcher({
        projectDir: root,
        env: process.env,
        platform: process.platform,
        serverScriptPath: this._codexDispatcherScriptPath(),
      });
      this._codexDispatcherWarnings = result.warnings;
    } catch (err) {
      console.error("TycoonAgents: installCodexDispatcher failed:", err instanceof Error ? err.message : err);
      this._codexDispatcherWarnings = [err instanceof Error ? err.message : String(err)];
    }
    this._handleGetSettings();
  }

  /** Handles MSG.UNINSTALL_CODEX_DISPATCHER: removes only the managed
   * dispatcher block from config.toml, then re-posts SETTINGS. */
  private _handleUninstallCodexDispatcher(): void {
    try {
      uninstallCodexDispatcher({ env: process.env, platform: process.platform });
      this._codexDispatcherWarnings = undefined;
    } catch (err) {
      console.error("TycoonAgents: uninstallCodexDispatcher failed:", err instanceof Error ? err.message : err);
    }
    this._handleGetSettings();
  }

  /** Handles MSG.SET_USE_MULTIPLE_LLMS (p18-t1): persists the toggle in
   * execution.json, then re-posts SETTINGS so `routing.visible` reflects it
   * immediately. Never touches routing.json — hiding the Routing screen
   * again must never delete the saved profile. */
  private _handleSetUseMultipleLlms(value: boolean): void {
    const root = this._projectRoot();
    try {
      writeUseMultipleLlms(root, value);
    } catch (err) {
      console.error("TycoonAgents: writeUseMultipleLlms failed:", err instanceof Error ? err.message : err);
    }
    this._handleGetSettings();
  }

  /**
   * Write the chosen model. p18-t1: for an agent whose route is not pure
   * frontmatter (routing.json resolved it, explicitly or via defaults), the
   * click must win over that route — overrideAgentToClaudeTier writes an
   * explicit routing.json entry instead. Only when that returns
   * handled:false (frontmatter-only agent, or unknown agent id) does this
   * fall back to the original setFrontmatterModel write.
   */
  private async _handleSetAgentModel(id: string, model: string): Promise<void> {
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
      const override = await overrideAgentToClaudeTier(root, id, model as ClaudeTier, { scriptsDir: this._extensionUri.fsPath });
      if (override.handled) {
        this._rosterModelCache = undefined;
        void this._panel.webview.postMessage({
          type: MSG.SETTINGS_UPDATED,
          ok: override.ok,
          id,
          field: "model",
          ...(override.ok ? {} : { error: override.errors.join("; ") }),
        });
        this._handleGetSettings();
        return;
      }
    } catch (err) {
      console.error("TycoonAgents: overrideAgentToClaudeTier failed, falling back to frontmatter:", err instanceof Error ? err.message : err);
    }
    try {
      const root = this._projectRoot();
      const filePath = path.join(root, ".claude", "agents", `${id}.md`);
      const content = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, setFrontmatterModel(content, fullId));
      // The roster model map (_getRosterModelMap) is cached and re-stamps
      // every subsequent activity-driven STATE push (_stampRosterModels) —
      // without invalidating it here, the next hook event overwrites the
      // panel's displayed model with the stale pre-change value, making a
      // just-applied change appear to silently revert once the agent runs
      // again. Every other roster-mutating handler (_handleRemoveAgent,
      // _handleResetMetrics) already invalidates this cache; this one must
      // too.
      this._rosterModelCache = undefined;
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: true,
        id,
        field: "model",
      });
      // Re-post the fresh settings/roster immediately so the panel reflects
      // the change without requiring a reopen (mirrors _handleRemoveAgent's
      // post-mutation refresh).
      this._handleGetSettings();
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
   * Open `.claude/agents/<id>.md` in the editor — the "Open" link on the
   * hand-written-backend provenance line (media/src/main/100-slot-editor-
   * settings.js). Same id guard as `_handleRemoveAgent`; missing file or no
   * workspace root is logged and ignored (no user-facing error message —
   * this is a convenience link, not a mutating action).
   */
  private async _handleOpenAgentFile(id: string): Promise<void> {
    if (!isSafeAgentId(id)) {
      console.error("TycoonAgents: openAgentFile rejected invalid id:", id);
      return;
    }
    const root = this._projectRoot();
    if (root === "") {
      console.error("TycoonAgents: openAgentFile: no workspace folder open");
      return;
    }
    const agentPath = path.join(root, ".claude", "agents", `${id}.md`);
    if (!fs.existsSync(agentPath)) {
      console.error("TycoonAgents: openAgentFile: file not found:", agentPath);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(agentPath);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      console.error("TycoonAgents: openAgentFile: failed to open:", err);
    }
  }

  /**
   * p68-t1: Keyword health card's "Open" link — opens
   * `.claude/tycoon/agent-keywords.json`. Same shape as
   * `_handleOpenAgentFile`: creates nothing when the file is missing, just
   * posts a one-line notice (SETTINGS_UPDATED, ok:false) instead.
   */
  private async _handleOpenAgentKeywordsFile(): Promise<void> {
    const root = this._projectRoot();
    if (root === "") {
      console.error("TycoonAgents: openAgentKeywordsFile: no workspace folder open");
      return;
    }
    const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
    if (!fs.existsSync(keywordsPath)) {
      void this._panel.webview.postMessage({
        type: MSG.SETTINGS_UPDATED,
        ok: false,
        id: "agent-keywords-file",
        field: "keywords",
        error: "agent-keywords.json does not exist yet.",
      });
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(keywordsPath);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      console.error("TycoonAgents: openAgentKeywordsFile: failed to open:", err);
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
    // Removing an agent file changes the on-disk roster the model cache is
    // built from — invalidate so the next stamp rereads it.
    this._rosterModelCache = undefined;
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
   * p68-t1: compute keyword-routing findings + wildcard/session stats via
   * src/core/keywordHealth.ts and post MSG.KEYWORD_HEALTH. Called on
   * Agents-screen open (`_handleGetSettings`) and on-demand
   * (`MSG.GET_KEYWORD_HEALTH`). Best-effort — a read/parse failure posts an
   * empty result rather than throwing.
   */
  private _postKeywordHealth(): void {
    const root = this._projectRoot();
    if (root === "") return;

    const agentsDir = path.join(root, ".claude", "agents");
    let agentIds: string[] = [];
    try {
      agentIds = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
    } catch {
      agentIds = [];
    }
    const agents = agentIds.map((id) => {
      let content = "";
      try {
        content = fs.readFileSync(path.join(agentsDir, `${id}.md`), "utf8");
      } catch {
        content = "";
      }
      return { id, keywords: parseAgentKeywords(content) };
    });

    const config = this._readKeywordsConfig(root);
    const findings = computeKeywordHealth(agents, config);

    // Known tokens across every configured agent's pattern, for the
    // unmatched-word signal below.
    const knownTokens = new Set<string>();
    const configAgents: Record<string, any> =
      config && typeof config.agents === "object" && config.agents !== null ? config.agents : {};
    for (const entry of Object.values(configAgents)) {
      const pattern = entry && typeof (entry as any).pattern === "string" ? (entry as any).pattern : "";
      for (const seg of pattern.split("|")) {
        const t = seg.trim().toLowerCase();
        if (t !== "") knownTokens.add(t);
      }
    }

    const session = this._sessionDelegationHealthThrottled(root);
    let wildcardTasksThisSession = 0;
    let unmatchedWords: string[] = [];
    if (session?.sessionId) {
      try {
        const raw = fs.readFileSync(path.join(root, ".claude", "tycoon", "activity.jsonl"), "utf8");
        const records = raw
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => {
            try {
              return JSON.parse(l) as {
                event?: string;
                workerId?: string;
                routingMethod?: string;
                sessionId?: string;
                description?: string;
                agentDescription?: string;
              };
            } catch {
              return null;
            }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null && r.sessionId === session.sessionId);
        const stats = computeWildcardStats(records, knownTokens);
        wildcardTasksThisSession = stats.wildcardTasksThisSession;
        unmatchedWords = stats.unmatchedWords;
      } catch {
        /* activity.jsonl missing/unreadable -> zeros */
      }
    }

    void this._panel.webview.postMessage({
      type: MSG.KEYWORD_HEALTH,
      findings,
      wildcardTasksThisSession,
      unmatchedWords,
    });
  }

  /**
   * p68-t1: apply the keyword-health fixer. `fix_all` runs
   * normalizeAgentKeywords() over the current roster/config; `add` appends
   * one token to one agent's existing pattern (empty-pattern case falls back
   * to just that token). Writes agent-keywords.json atomically with a
   * `.bak` (like other config writes — see `_installAgentFiles`), then
   * re-posts KEYWORD_HEALTH either way.
   */
  private _handleKeywordHealthFix(
    payload: { action: "fix_all" } | { action: "add"; agentId: string; token: string }
  ): void {
    try {
      const root = this._projectRoot();
      if (root === "") return;

      const agentsDir = path.join(root, ".claude", "agents");
      let agentIds: string[] = [];
      try {
        agentIds = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
      } catch {
        agentIds = [];
      }

      // Review fix: an "add" whose agentId isn't in the current roster (agent
      // files on disk) is rejected outright rather than silently creating a
      // routing entry for an id that doesn't exist — log without the
      // (untrusted) values and re-post the CURRENT (unchanged) health.
      if (payload.action === "add" && !agentIds.includes(payload.agentId)) {
        console.error("TycoonAgents: keyword add rejected (agentId not in current roster)");
        this._postKeywordHealth();
        return;
      }

      const agents = agentIds.map((id) => {
        let content = "";
        try {
          content = fs.readFileSync(path.join(agentsDir, `${id}.md`), "utf8");
        } catch {
          content = "";
        }
        return { id, keywords: parseAgentKeywords(content) };
      });

      let config = this._readKeywordsConfig(root);
      let changed = false;

      if (payload.action === "fix_all") {
        const result = normalizeAgentKeywords(config, agents);
        config = result.config;
        changed = result.changed;
      } else {
        config = setKeywordPattern(
          config,
          payload.agentId,
          this._appendKeywordToken(config, payload.agentId, payload.token)
        );
        changed = true;
      }

      if (changed) {
        const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
        fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
        try {
          const existing = fs.readFileSync(keywordsPath, "utf8");
          fs.writeFileSync(`${keywordsPath}.bak`, existing);
        } catch {
          /* no existing file to back up -> first write */
        }
        atomicWriteFileSync(keywordsPath, JSON.stringify(config, null, 2));
      }
    } catch (err) {
      console.error("TycoonAgents: KEYWORD_HEALTH_FIX failed:", err);
    }
    this._postKeywordHealth();
  }

  /** Helper for the "add" fix action: append `token` to `agentId`'s existing pattern (deduped). */
  private _appendKeywordToken(config: Record<string, any>, agentId: string, token: string): string {
    const agentsMap: Record<string, any> =
      config && typeof config.agents === "object" && config.agents !== null ? config.agents : {};
    const entry = agentsMap[agentId];
    const existing = entry && typeof entry.pattern === "string" ? entry.pattern : "";
    const segments = existing
      .split("|")
      .map((s: string) => s.trim())
      .filter((s: string) => s !== "");
    const clean = token.trim();
    if (clean !== "" && !segments.some((s: string) => s.toLowerCase() === clean.toLowerCase())) {
      segments.push(clean);
    }
    return segments.join("|");
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
    // A metrics reset can precede/accompany roster changes elsewhere in a
    // session — invalidate the cached model map defensively.
    this._rosterModelCache = undefined;
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

      this._runtime.ingest({ type: "RosterSeeded", at: Date.now() });

      void this._panel.webview.postMessage({ type: MSG.METRICS_RESET, ok: true });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: MSG.METRICS_RESET,
        ok: false,
        error: String(err),
      });
    }
  }

  /**
   * Builds the hook command as an ABSOLUTE, quoted path, e.g.
   * `node "<projectRoot>/.claude/tycoon/tycoon-claude-hook.cjs"`.
   *
   * A project-relative command (`node .claude/tycoon/tycoon-claude-hook.cjs`)
   * was used through 0.0.664 on the assumption that Claude Code always runs
   * hooks with cwd = project root. Field evidence
   * (docs: hook-cwd-relative-command-incident) showed that assumption is
   * false: once the SESSION's cwd changes — e.g. an agent `cd`s into a
   * subfolder mid-session — Claude Code launches the hook with that new cwd,
   * `node` can no longer resolve the relative script path, and the hook
   * fails to even start, silently, for the rest of the session (no error
   * surfaces anywhere the user would see it; activity.jsonl just stops
   * growing). An absolute path removes the dependency on cwd entirely, and
   * matches the pattern the standalone installer already uses
   * (`standalone/src/installHook.mjs`'s `node "${hookScriptPath}"`).
   *
   * Quoting handles a project path containing spaces on every platform this
   * targets: double quotes around the whole path work identically for
   * `node` under POSIX sh/bash AND under Windows cmd.exe (VS Code's default
   * hook launcher on win32) — there is no reliance on `$VAR`-style shell
   * expansion (which cmd.exe does not perform) or on any particular shell
   * being present, so no CLAUDE_PROJECT_DIR-based form is used here even
   * though the hook script itself also honors that env var internally as a
   * belt-and-braces fallback (see hooks/tycoon-claude-hook.cjs's
   * findProjectRootFallback).
   *
   * `root` is this panel's resolved project root (same value already used
   * to build settingsPath/claudeDir at the call site) — NOT
   * `process.cwd()`, so this is correct even if the extension host's own
   * cwd differs from the workspace. isOurHookCommand() still matches this
   * (and the legacy relative form) by filename substring, so an existing
   * entry of either form is replaced in place, not duplicated.
   *
   * Delegates to the pure, unit-tested `buildAbsoluteHookCommand` in
   * hookInstall.ts (shared with teamSetupHost.ts) — this method only
   * exists so panel.ts's other private call sites don't need to import it
   * directly.
   */
  private _buildHookCommand(root: string): string {
    return buildAbsoluteHookCommand(root);
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
   * Once-per-panel-open wrapper around {@link _detectLegacyArtifacts} for the
   * passive load-time notice (see the constructor call site and the
   * `MSG.READY` handler that delivers `MSG.LEGACY_ARTIFACTS_DETECTED`).
   * Read-only: reuses the same directory scan Hook Doctor's "Run Doctor"
   * button runs, mutates nothing, and never throws — a missing workspace
   * root or any scan failure both resolve to `null` so the caller can skip
   * sending anything.
   */
  private _detectLegacyArtifactsOnLoad(): { artifactCount: number; foreignHookCount: number } | null {
    try {
      const root = this._projectRoot();
      if (root === "") {
        return null;
      }
      const claudeDir = path.join(root, ".claude");
      const localSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.local.json"));
      const sharedSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.json"));
      const { leftoverFiles, hookCommands } = this._detectLegacyArtifacts(claudeDir, localSettings, sharedSettings);
      if (leftoverFiles.length === 0 && hookCommands.length === 0) {
        return null;
      }
      return { artifactCount: leftoverFiles.length, foreignHookCount: hookCommands.length };
    } catch {
      return null;
    }
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

  /** Assembles a full DoctorInput (settings + operational health) from disk for `root`. */
  private _gatherDoctorInput(root: string): DoctorInput {
    const claudeDir = path.join(root, ".claude");
    const localSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.local.json"));
    const sharedSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.json"));
    const currentHookCommand = this._buildHookCommand(root);
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
   *
   * `removeForeign` genuinely gates BOTH strip paths, not just
   * `repairSettings`'s: it's threaded into
   * `cleanupForeignHookArtifacts(claudeDir, { removeForeignCommands })` so
   * unchecking "Remove foreign hooks" also skips step 1's predecessor-harness
   * command strip (previously that step ran unconditionally BEFORE this flag
   * was even consulted, which meant unchecking the box did nothing for those
   * commands). The confirmation dialog's command list is computed from a
   * read taken BEFORE either strip path runs, so it always reflects what's
   * about to be removed rather than — as before — settings already mutated
   * by the (formerly unconditional) cleanup call. Orphaned
   * `agent-activity-*.json` files are deleted unconditionally either way;
   * that cleanup was never part of the "remove hooks" choice.
   */
  private async _handleApplyDoctorFix(removeForeign: boolean): Promise<void> {
    try {
      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({ type: MSG.DOCTOR_FIX_DONE, ok: false, error: "No workspace folder open" });
        return;
      }
      const claudeDir = path.join(root, ".claude");
      const currentHookCommand = this._buildHookCommand(root);

      // Pre-strip read: what WOULD be removed if the user confirms. Two
      // distinct "foreign command" concepts feed the confirmation list —
      // findLegacyHookCommands (predecessor-harness basenames; what
      // cleanupForeignHookArtifacts' step 1 strips) and findForeignHooks
      // (broader "any non-Tycoon command on our events"; what
      // repairSettings' removeForeign strips) — unioned + de-duped so the
      // dialog names everything that's actually about to disappear.
      const preLocalSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.local.json"));
      const preSharedSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.json"));
      const legacyHookCommands = [
        ...findLegacyHookCommands(preLocalSettings),
        ...findLegacyHookCommands(preSharedSettings),
      ];
      const foreignHooksPreview = findForeignHooks(preLocalSettings, preSharedSettings);
      const commandsToRemove = Array.from(new Set([...legacyHookCommands, ...foreignHooksPreview]));

      if (removeForeign && commandsToRemove.length > 0) {
        const answer = await vscode.window.showWarningMessage(
          "The following hook commands will be permanently removed:\n\n" + commandsToRemove.join("\n"),
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }
      }

      const cleanup = cleanupForeignHookArtifacts(claudeDir, { removeForeignCommands: removeForeign });

      const localSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.local.json"));
      const sharedSettings = this._readSettingsTolerant(path.join(claudeDir, "settings.json"));
      const foreignCommands = findForeignHooks(localSettings, sharedSettings);
      const { settings, changes } = repairSettings(localSettings, currentHookCommand, { removeForeign, foreignCommands: removeForeign ? foreignCommands : undefined });
      const settingsLocalPath = path.join(claudeDir, "settings.local.json");
      // Back up before any repair write (including the relative->absolute
      // hook-command migration folded into repairSettings' stale-path fix),
      // same pattern as _installAgentFiles's <id>.md.bak / keywordsPath.bak —
      // never overwrites a prior backup from earlier in this same run, so
      // the FIRST fix attempt's pre-state is always recoverable.
      try {
        if (fs.existsSync(settingsLocalPath) && !fs.existsSync(`${settingsLocalPath}.bak`)) {
          fs.writeFileSync(`${settingsLocalPath}.bak`, fs.readFileSync(settingsLocalPath));
        }
      } catch {
        /* best-effort backup; never block the repair itself */
      }
      fs.writeFileSync(settingsLocalPath, JSON.stringify(settings, null, 2));

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
      const reportInput = this._buildDiagnosticReportInput(root);
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
   * Gather step shared by `_handleGenerateDiagnostic` and the feedback
   * pipeline's "include diagnostics" checkbox (`_handleSubmitFeedback`):
   * assembles every health signal this panel already computes elsewhere
   * (hook health, delegation/review mode, doctrine health, context budget,
   * roster consistency, engine/UEFN status) into a `DiagnosticReportInput`
   * for the PURE `buildDiagnosticReport` (diagnosticReport.ts). Extracted
   * from `_handleGenerateDiagnostic` so both callers build the identical
   * input from the identical live signals — no drift between what the
   * standalone diagnostic report shows and what a feedback ticket's embedded
   * diagnostics show. NO network, NO runtime AI — only reads state already
   * on disk or in memory.
   */
  private _buildDiagnosticReportInput(root: string): DiagnosticReportInput {
      const agentsDir = path.join(root, ".claude", "agents");

      // ---- environment -----------------------------------------------------
      const extensionVersion = this._currentExtensionVersion();
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
        uriScheme: vscode.env.uriScheme,
        themeServiceEndpointHost: this._themeServiceHost.getEffectiveEndpointHost() ?? null,
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

      return reportInput;
  }

  /**
   * SUBMIT_FEEDBACK handler (docs/FEEDBACK-PIPELINE-SPEC.md §5) — builds the
   * exact v1 payload and replies with a PREVIEW only. NO network call
   * happens here; this is the "before Send" step the spec makes mandatory
   * (§5, §7). `userDescription`/`contact` are sanitized inside
   * `buildFeedbackPayload` using the same `roots` `_buildDiagnosticReportInput`
   * already assembles; `diagnosticMarkdown` reuses that same gather step so
   * a feedback ticket's embedded diagnostics never disagree with the
   * standalone "Generate diagnostic report" output. The exact JSON body
   * string built here is retained in `_feedbackTicketBodies` keyed by
   * `ticketId` so CONFIRM_FEEDBACK_SEND posts byte-identical bytes to what
   * was previewed.
   */
  private _handleSubmitFeedback(input: {
    category: "bug" | "idea" | "question" | "other";
    userDescription: string;
    includeDiagnostics: boolean;
    contact?: string;
  }): void {
    const root = this._projectRoot();
    try {
      const reportInput = root !== "" ? this._buildDiagnosticReportInput(root) : null;
      const roots: SanitizeRoots = reportInput?.roots ?? {
        projectRoot: root || null,
        homeDir: os.homedir(),
        extensionDir: this._extensionUri.fsPath,
      };
      const diagnosticMarkdown =
        input.includeDiagnostics && reportInput ? buildDiagnosticReport(reportInput) : undefined;

      const context =
        root !== ""
          ? buildFeedbackContext(root, { host: "vscode", effectiveHarness: this._resolveEffectiveHarness(root), running: null })
          : undefined;

      const payload = buildFeedbackPayload(
        {
          category: input.category,
          userDescription: input.userDescription,
          contact: input.contact,
          diagnosticMarkdown,
        },
        {
          roots,
          extensionVersion: this._currentExtensionVersion(),
          platform: process.platform,
          hostAppName: vscode.env.appName,
          context,
        }
      );

      const bodyString = JSON.stringify(payload, null, 2);
      this._pruneFeedbackTickets();
      this._feedbackTicketBodies.set(payload.ticketId, { body: bodyString, storedAt: Date.now() });
      void this._panel.webview.postMessage({
        type: MSG.FEEDBACK_PREVIEW,
        ticketId: payload.ticketId,
        payloadJson: bodyString,
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`TycoonAgents: Could not build feedback preview: ${errorMessage(err)}`);
    }
  }

  /**
   * Bound `_feedbackTicketBodies` before inserting a new entry: drop
   * anything older than FEEDBACK_TICKET_MAX_AGE_MS, then — if still over
   * FEEDBACK_TICKET_MAX_ENTRIES — evict the oldest (by `storedAt`) until
   * back at the cap. Called from `_handleSubmitFeedback` only; the
   * failure-retains-entry path in `_handleConfirmFeedbackSend` never adds a
   * new key, so it can't itself cause growth.
   */
  private _pruneFeedbackTickets(): void {
    const now = Date.now();
    for (const [id, entry] of this._feedbackTicketBodies) {
      if (now - entry.storedAt > FEEDBACK_TICKET_MAX_AGE_MS) {
        this._feedbackTicketBodies.delete(id);
      }
    }
    while (this._feedbackTicketBodies.size >= FEEDBACK_TICKET_MAX_ENTRIES) {
      const oldestId = this._feedbackTicketBodies.keys().next().value;
      if (oldestId === undefined) break;
      this._feedbackTicketBodies.delete(oldestId);
    }
  }

  /**
   * CONFIRM_FEEDBACK_SEND handler — the ONLY message that triggers the real
   * network POST (spec §5 step 5). Looks up (without consuming) the
   * retained body for `ticketId`; an unknown/expired id fails safe — no
   * network call, FEEDBACK_RESULT with ok:false. The entry is deleted ONLY
   * on a successful send, so a succeeded ticket can't be resent /
   * double-filed. On failure (timeout, network error, non-2xx) the entry is
   * RETAINED (so the webview's "Retry Send" can resend the same ticketId),
   * the full payload JSON is copied to the clipboard so no submission is
   * silently lost (spec §5 step 7), and the user is told to retry later.
   * Never throws outward.
   */
  private async _handleConfirmFeedbackSend(ticketId: string): Promise<void> {
    const entry = this._feedbackTicketBodies.get(ticketId);
    const bodyString = entry?.body;
    if (bodyString === undefined) {
      void this._panel.webview.postMessage({
        type: MSG.FEEDBACK_RESULT,
        ok: false,
        ticketId,
        error: "This feedback preview has expired — please rebuild it and try again.",
      });
      return;
    }
    try {
      const fetchImpl = fetch as unknown as FeedbackFetch;
      const result = await postFeedback(bodyString, FEEDBACK_ENDPOINT, fetchImpl);
      if (result.ok) {
        // Single-use only on success — a succeeded ticket must never be
        // resendable (would double-file the GitHub issue). Failure paths
        // below deliberately do NOT delete, so the same ticketId can retry.
        this._feedbackTicketBodies.delete(ticketId);
        void this._panel.webview.postMessage({ type: MSG.FEEDBACK_RESULT, ok: true, ticketId });
        void vscode.window.showInformationMessage(`TycoonAgents: Feedback submitted — ticket ${ticketId}.`);
        return;
      }
      await vscode.env.clipboard.writeText(bodyString);
      void this._panel.webview.postMessage({
        type: MSG.FEEDBACK_RESULT,
        ok: false,
        ticketId,
        error: result.error,
      });
      void vscode.window
        .showErrorMessage(
          `TycoonAgents: Feedback submission failed (${result.error ?? "unknown error"}). ` +
            `Ticket copied to your clipboard — retry, or use the fallback form: ${FALLBACK_FORM_URL}`,
          "Open form"
        )
        .then((selection) => {
          if (selection === "Open form") void vscode.env.openExternal(vscode.Uri.parse(FALLBACK_FORM_URL));
        });
    } catch (err) {
      const message = errorMessage(err);
      try {
        await vscode.env.clipboard.writeText(bodyString);
      } catch {
        /* best-effort — still report the failure below */
      }
      void this._panel.webview.postMessage({ type: MSG.FEEDBACK_RESULT, ok: false, ticketId, error: message });
      void vscode.window
        .showErrorMessage(
          `TycoonAgents: Feedback submission failed (${message}). ` +
            `Ticket copied to your clipboard — retry, or use the fallback form: ${FALLBACK_FORM_URL}`,
          "Open form"
        )
        .then((selection) => {
          if (selection === "Open form") void vscode.env.openExternal(vscode.Uri.parse(FALLBACK_FORM_URL));
        });
    }
  }

  /**
   * Set a single Path Health override in `.claude/tycoon/uefn-paths.json`
   * (see pathHealth.ts). Validates the given path actually exists on disk
   * BEFORE accepting it — an override pointing at nothing is worse than no
   * override, since it would silently outrank the auto-discovery ladder with
   * a value that still doesn't work. Rejects with a clear reason via
   * PATH_OVERRIDE_RESULT rather than writing a bad value. On success,
   * re-runs `_handleCheckInstall` so the webview gets a fresh probe
   * reflecting the new override immediately.
   */
  private async _handleSetPathOverride(key: string, rawPath: string): Promise<void> {
    const root = this._projectRoot();
    if (root === "") {
      void vscode.window.showWarningMessage("TycoonAgents: No project root — open a folder first.");
      return;
    }
    if (!isPathOverrideKey(key)) {
      void this._panel.webview.postMessage({
        type: MSG.PATH_OVERRIDE_RESULT,
        key,
        ok: false,
        error: `Unknown override key: "${key}".`,
      });
      return;
    }
    const trimmed = rawPath.trim();
    let exists = false;
    try {
      exists = trimmed !== "" && fs.existsSync(trimmed);
    } catch {
      exists = false;
    }
    if (!exists) {
      void this._panel.webview.postMessage({
        type: MSG.PATH_OVERRIDE_RESULT,
        key,
        ok: false,
        error: `Nothing exists at "${trimmed}" — set an override to a path that actually exists on this machine.`,
      });
      return;
    }
    const result = writeUefnPathOverride(path.join(root, ".claude"), key, trimmed);
    void this._panel.webview.postMessage({ type: MSG.PATH_OVERRIDE_RESULT, key, ok: result.ok, error: result.error });
    if (result.ok) {
      this._handleCheckInstall();
    } else {
      void vscode.window.showErrorMessage(`TycoonAgents: Could not save path override: ${result.error}`);
    }
  }

  /** Clear a single Path Health override (see `_handleSetPathOverride`). No existence check needed — clearing always succeeds unless the write itself fails. */
  private async _handleClearPathOverride(key: string): Promise<void> {
    const root = this._projectRoot();
    if (root === "") {
      void vscode.window.showWarningMessage("TycoonAgents: No project root — open a folder first.");
      return;
    }
    if (!isPathOverrideKey(key)) {
      void this._panel.webview.postMessage({
        type: MSG.PATH_OVERRIDE_RESULT,
        key,
        ok: false,
        error: `Unknown override key: "${key}".`,
      });
      return;
    }
    const result = writeUefnPathOverride(path.join(root, ".claude"), key, null);
    void this._panel.webview.postMessage({ type: MSG.PATH_OVERRIDE_RESULT, key, ok: result.ok, error: result.error });
    if (result.ok) {
      this._handleCheckInstall();
    } else {
      void vscode.window.showErrorMessage(`TycoonAgents: Could not clear path override: ${result.error}`);
    }
  }

  /**
   * Build the paste-to-Claude Path Health diagnostic text (pathHealth.ts's
   * `buildPathDiagnosticText`) from a fresh probe + Verse extension check,
   * and copy it to the clipboard — the same interaction shape as COPY_NUDGE
   * (panel.ts's `copyNudge` handler above), but built host-side since it
   * needs real filesystem probing that the webview can't do itself.
   */
  private async _handleCopyPathDiagnostic(): Promise<void> {
    const root = this._projectRoot();
    if (root === "") {
      void vscode.window.showWarningMessage("TycoonAgents: No project root — open a folder first.");
      return;
    }
    try {
      const report = probePathHealth(path.join(root, ".claude"));
      const verseExt = vscode.extensions.getExtension("epicgames.verse");
      const verseState = detectVerseExtensionState({
        liveExtensionFound: verseExt !== undefined,
        liveExtensionVersion: (verseExt?.packageJSON?.version as string | undefined) ?? null,
      });
      // Deliberately NOT routed through diagnosticReport.ts's sanitize().
      // That report is built for PUBLIC sharing and strips absolute paths on
      // purpose; this text is the opposite — the user pastes it into their
      // OWN Claude Code session so Claude can fix THEIR paths, so it must
      // keep the real paths to be useful. Do not "fix" this by adding
      // sanitize() here; see buildPathDiagnosticText's own doc comment.
      // Recognizes both key names this product has written for the UEFN MCP
      // server over time so the node/PATH note below only
      // appears when there's actually an entry it could be relevant to.
      const mcpConfigForDiagnostic = this._readMcpConfig(path.join(root, ".mcp.json"));
      const mcpUefnEntryConfigured =
        hasMcpServer(mcpConfigForDiagnostic, "uefn-bridge") || hasMcpServer(mcpConfigForDiagnostic, "uefn");
      const text = buildPathDiagnosticText(report, verseState, {
        platform: process.platform,
        mcpUefnEntryConfigured,
      });
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(
        "Path diagnostic copied to clipboard — paste it into Claude Code to fix any path issues.",
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`TycoonAgents: Could not build path diagnostic: ${errorMessage(err)}`);
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
        writePlanBackup(root, result.plan, console);
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
    this._disposed = true;
    cancelAllVendorKeyTests();
    TycoonPanel.currentPanel = undefined;
    this._themeGenerationAbortController?.abort();
    this._themeGenerationAbortController = undefined;
    this._feedbackTicketBodies.clear();
    if (this._enginePollInterval !== undefined) {
      clearInterval(this._enginePollInterval);
      this._enginePollInterval = undefined;
    }
    if (this._planWatcherDebounce !== undefined) {
      clearTimeout(this._planWatcherDebounce);
      this._planWatcherDebounce = undefined;
    }
    this._themeServiceHost.dispose();
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
    // Bundled (theme-independent) disco-ball sprite for the disco-party
    // easter egg — ships with the extension under media/sprites/, unlike
    // theme art which is generated per-theme into globalStorage. Injected as
    // a data attribute on #app (below) rather than a postMessage round-trip,
    // matching how styleUri/scriptUri are plain HTML-injected URIs.
    const discoBallUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "sprites", "disco_ball.png")
    );

    // Boot-loader logo (media/handbook/tycoonagents_logo_sm.png) — served via
    // the same webview.cspSource img-src the other media URIs use.
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "handbook", "tycoonagents_logo_sm.png")
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
      <img class="boot-loader-logo" src="${logoUri}" alt="" width="112" height="112" decoding="async" />
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
  <div id="app" data-disco-ball-uri="${discoBallUri}">

    <!-- Hamburger menu: scaffold for future panel controls. Direct child of
         #app (NOT #stage-area) on purpose: #stage-area is position:relative
         plus overflow:hidden, which creates its own stacking context, so no
         z-index on the button/popover could ever out-rank #metrics-panel (a
         later, unrelated sibling of #stage-area inside #app) — the popover
         was getting sliced off under the metrics panel. #app is the
         positioning context for both (position:fixed; inset:0), and
         #stage-area is #app's first child with no offset before it, so
         top/right stay pixel-identical here to when this lived inside
         #stage-area. See #menu-btn/#menu-popover in media/style.css. -->
    <button id="menu-btn" aria-label="Open menu" aria-expanded="false" aria-haspopup="true">&#9776;</button>
    <div id="menu-popover" role="menu" hidden>
      <button class="menu-item" role="menuitem" id="menu-settings">Settings</button>
      <button class="menu-item" role="menuitem" id="menu-routing">Agents</button>
      <button class="menu-item" role="menuitem" id="menu-themes">Tycoon Themes</button>
      <button class="menu-item" role="menuitem" id="menu-catalog">Skills / MCP / Packs</button>
      <button class="menu-item" role="menuitem" id="menu-uefn">UEFN / Verse</button>
      <button class="menu-item" role="menuitem" id="menu-feedback">Feedback</button>
      <button class="menu-item" role="menuitem" id="menu-about">About</button>
      ${version ? `<div class="menu-version" role="presentation">v${version}</div>` : ""}
    </div>

    <!-- Stage area: placeholder for future characters / background -->
    <div id="stage-area">
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
      <!-- Rebirth trophy row: SIBLING of #badge-hud-btn (never a child — a
           child would inherit .badge-hud's positioning context, which is
           where .badge-hud-dot's top/right offsets live). One bare gold cup
           per completed rebirth, immediately left of the badge medal;
           rendered by updateTrophyRow() in media/main.js from the
           module-scope rebirthCount. The gradient the cups share lives in
           this hidden defs-only sprite (referenced via fill:url(#...) from
           each cup) so the cup markup itself only needs to live in ONE
           place (media/main.js's TROPHY_CUP_SVG). -->
      <svg width="0" height="0" class="svg-abs-hidden" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="trophyCupGoldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ffe9a8" />
            <stop offset="50%" stop-color="#ffb020" />
            <stop offset="100%" stop-color="#8a4d06" />
          </linearGradient>
        </defs>
      </svg>
      <div id="trophy-row" class="trophy-row"></div>
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
        <button id="delegation-tab-btn" class="metrics-tab-btn" type="button" role="tab" aria-selected="false" aria-controls="delegation-stats">Delegation</button>
      </div>
      <div id="metrics-body">
        <!-- Scope toggle: "This session" vs "All time" — reuses the
             .model-radio-group/.model-radio idiom from the Settings screen's
             per-agent model picker (see agentsSection in media/main.js)
             rather than inventing a new control. Defaults to "All time"
             (input[value=all] checked) so existing behavior/numbers are
             preserved on upgrade — see updateMetricsScopeUI() in
             media/main.js, which also disables the "This session" option
             (with a title explaining why, never silent zeros) when
             sessionMetrics.available is false. #metrics-scope-caption states
             the active scope in words at all times, not just via which radio
             is checked. -->
        <div id="metrics-scope-toggle" class="model-radio-group metrics-scope-toggle" role="radiogroup" aria-label="Metrics time range">
          <label class="model-radio">
            <input type="radio" name="metrics-scope" id="metrics-scope-session" value="session">
            <span>This session</span>
          </label>
          <label class="model-radio">
            <input type="radio" name="metrics-scope" id="metrics-scope-all" value="all" checked>
            <span>All time</span>
          </label>
        </div>
        <div id="metrics-scope-caption" class="delegation-stats-caption"></div>
        <div id="metrics-empty">No agents yet &mdash; start a session to see activity.</div>
        <table id="metrics-table" hidden>
          <thead>
            <tr>
              <th title="The agent doing the work. The orchestrator delegates; the specialists do the work.">Agent</th>
              <th title="How much cheaper (or pricier) this agent's model is, per token, than the orchestrator's — e.g. 5× cheaper. A dimensionless ratio, not a bill. The bar behind it shows tasks completed, relative to the agent with the most.">Tokens/min</th>
              <th class="col-tasks" title="Tasks completed BY this agent — work it actually finished, not tasks merely routed to it. The orchestrator's cell (marked *) shows the tasks it completed itself; hover it to see how many it dispatched to other agents.">Tasks</th>
              <th class="col-mcp" title="How many MCP tool calls this agent has made.">MCP</th>
              <th class="col-time" title="Active time this agent has spent working.">Time</th>
              <th class="col-tokens" id="metrics-col-tokens" title="Billed context tokens summed over every turn (input, output, cache writes). Cache reads are shown separately and cost about a tenth of input.">Tokens (all time)</th>
            </tr>
          </thead>
          <tbody id="metrics-tbody"></tbody>
        </table>
      </div>
      <!-- Delegation tab (full-width sibling tab panel, promoted out of
           #metrics-body): populated by renderDelegationStats() in
           media/main.js from state.modeStats + the last agentMetrics/
           delegationHealth payloads. Hidden unless it is the active tab AND
           has data (see updateMetricsTabsUI()/renderDelegationStats()). -->
      <div id="delegation-stats" class="delegation-stats-body" hidden></div>
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
      <h1>TycoonAgents™</h1>
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
      <img id="about-logo" src="${logoUri}" alt="TycoonAgents" width="100" height="100" decoding="async" />
      <h2 id="about-modal-title">TycoonAgents™</h2>
      <p>Created by Scott McClellan</p>
      <p>
        <a href="https://x.com/thetrashbyrd" target="_blank" rel="noopener noreferrer">@thetrashbyrd</a>
      </p>
      <p>
        <a href="https://corsairstudios.com" target="_blank" rel="noopener noreferrer">corsairstudios.com</a>
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
  <div id="themes-modal" role="dialog" aria-modal="true" aria-label="Tycoon Themes" hidden>
    <div id="themes-backdrop"></div>
    <div id="themes-dialog">
      <button id="themes-modal-close" aria-label="Close dialog">&times;</button>
      <div id="themes-scroll">
      <div id="theme-picker-list" role="tabpanel">
        <section id="theme-library-section" class="theme-library-section">
          <h2 class="theme-library-heading">Tycoon Themes</h2>
          <div id="theme-picker-grid" class="theme-picker-grid-list"></div>
          <div id="theme-picker-status" class="theme-picker-status" role="status" aria-live="polite"></div>
          <div class="theme-cta-block">
            <div class="theme-cta-primary-row">
              <div class="theme-cta-primary-row-top">
                <button id="tab-theme-builder" class="skill-btn primary theme-builder-launch">Tycoon Theme Builder</button>
                <span id="theme-builder-credits-chip" class="theme-credits-chip" hidden></span>
              </div>
              <p class="theme-cta-value">Generate a full sprite theme from a description.</p>
            </div>
            <div class="theme-cta-secondary-row">
              <button id="theme-import-btn" class="skill-btn secondary-info">Import .zip</button>
              <span class="theme-cta-secondary-note">free, works offline</span>
            </div>
          </div>
        </section>
        <section id="theme-selected-section" class="theme-selected-section" hidden>
          <h3 id="theme-selected-heading" class="theme-selected-heading">Selected theme</h3>
          <div id="theme-selected-roster"></div>
        </section>
      </div>
      <div id="theme-builder-panel" role="tabpanel" hidden>
        <div id="theme-builder-topbar" class="theme-builder-topbar">
          <button id="tab-theme-picker" class="skill-btn">&larr; Back to themes</button>
          <button id="theme-builder-credits-pill" class="theme-credits-pill" type="button" hidden></button>
        </div>
        <div id="theme-image-settings" class="theme-image-settings">
          <div class="theme-image-settings-heading">Image generation</div>
          <p class="theme-image-settings-note muted">Image generation runs through your Corsair credits. Sign in from the Theme Builder to see your balance.</p>
        </div>
        <p class="theme-generation-approval-warning">
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
            <div id="theme-plan-characters" class="theme-plan-slots"></div>
          </fieldset>
          <label class="theme-plan-field">
            <span>Environment <small>1 image</small></span>
            <textarea id="theme-plan-environment" rows="3"></textarea>
          </label>
          <fieldset class="theme-plan-group">
            <legend>Enemies <span>4 individual enemy rows &middot; 1 sprite board</span></legend>
            <div id="theme-plan-enemies" class="theme-plan-slots"></div>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Objects <span>21 objects &middot; 2 sprite sheets</span></legend>
            <div id="theme-plan-objects-slots" class="theme-plan-slots"></div>
            <label class="theme-plan-field theme-plan-field--sub">
              <span>Crate <small>fixed object &middot; appearance only</small></span>
              <textarea id="theme-plan-crate-desc" rows="2" placeholder="Appearance / description (optional)"></textarea>
            </label>
            <label class="theme-plan-field theme-plan-field--sub">
              <span>Poof effect <small>fixed object &middot; appearance only</small></span>
              <textarea id="theme-plan-poof-desc" rows="2" placeholder="Appearance / description (optional)"></textarea>
            </label>
            <label class="theme-plan-field theme-plan-field--sub">
              <span>Ranged projectile <small>fixed object &middot; appearance only &middot; animates muzzle &rarr; flight &rarr; impact &rarr; blast</small></span>
              <textarea id="theme-plan-projectile-desc" rows="2" placeholder="Appearance / description for the ranged combat projectile (optional)"></textarea>
            </label>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Decor <span>9 items &middot; 1 sprite board</span></legend>
            <p class="theme-plan-group-note">Decor: slots 1-4 are sittable seats (seat 1 is the leader's throne), 5-8 are static props, 9 is animated.</p>
            <div id="theme-plan-decor-slots" class="theme-plan-slots"></div>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Expressions <span>8 fixed slots &middot; 1 sprite sheet</span></legend>
            <p class="theme-plan-group-note">Expression slots are fixed (gameplay maps events by position) &mdash; you can restyle each one's look, not its meaning.</p>
            <div id="theme-plan-expressions-slots" class="theme-plan-slots"></div>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Achievement badges <span>25 designs &middot; 1 sprite sheet</span></legend>
            <p class="theme-plan-group-note">Each badge's unlock trigger and threshold are fixed per slot &mdash; you can rename and restyle, but not change what unlocks it.</p>
            <div id="theme-plan-achievements-slots" class="theme-plan-slots"></div>
          </fieldset>
          <div class="theme-plan-footer">
            <div id="theme-plan-validation" class="theme-plan-validation" role="status"></div>
            <div class="theme-plan-footer-actions">
              <label class="theme-generation-approval-toggle theme-generation-approval-toggle--footer" for="theme-pause-for-review">
                <input id="theme-pause-for-review" type="checkbox" checked />
                <span>
                  Pause after each image for approval
                  <small>Change this any time. Turning it off resumes a paused generation.</small>
                </span>
              </label>
              <button id="theme-start-generation-btn" class="skill-btn">Generate images</button>
            </div>
          </div>
        </section>
        <div id="theme-build-status"></div>
        <div id="theme-build-actions" hidden>
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

  <!-- Theme Builder panel shell (p40-t3): opened by OPEN_THEME_BUILDER / THEME_BUILDER_OPENED.
       theme-service-panel-body is an empty placeholder p42 fills in; "Continue to builder"
       reaches the existing plan-editor tab (theme-builder-panel inside themes-modal) so
       current users lose no functionality. -->
  <div id="theme-builder-shell-modal" role="dialog" aria-modal="true" aria-labelledby="theme-builder-shell-title" hidden>
    <div id="theme-builder-shell-backdrop"></div>
    <div id="theme-builder-shell-dialog">
      <button id="theme-builder-shell-close" aria-label="Close dialog">&times;</button>
      <h2 id="theme-builder-shell-title">Tycoon Theme Builder</h2>
      <div id="theme-service-panel-body"></div>
      <div class="theme-builder-shell-footer">
        <button id="theme-builder-shell-continue" class="skill-btn primary">Continue to builder</button>
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

  <!-- UEFN / Verse modal overlay: houses the "Path Health" section moved out
       of Settings (see buildPathHealthSection() in media/main.js). Uses the
       shared .settings-subpage-* modal classes (see #feedback-modal below)
       rather than #about-modal's per-id styling, since these two are the
       first "subpage" modals split out of the Settings screen. -->
  <div id="uefn-modal" role="dialog" aria-modal="true" aria-labelledby="uefn-modal-title" hidden>
    <div id="uefn-backdrop" class="settings-subpage-backdrop"></div>
    <div id="uefn-dialog" class="settings-subpage-dialog">
      <button id="uefn-modal-close" class="settings-subpage-close" aria-label="Close dialog">&times;</button>
      <h2 id="uefn-modal-title" class="settings-subpage-title">UEFN / Verse</h2>
      <div id="uefn-modal-body" class="settings-subpage-body"></div>
    </div>
  </div>

  <!-- Feedback modal overlay: houses the "Submit feedback" section moved out
       of Settings (see the feedback-section builder in media/main.js). -->
  <div id="feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-modal-title" hidden>
    <div id="feedback-backdrop" class="settings-subpage-backdrop"></div>
    <div id="feedback-dialog" class="settings-subpage-dialog">
      <button id="feedback-modal-close" class="settings-subpage-close" aria-label="Close dialog">&times;</button>
      <h2 id="feedback-modal-title" class="settings-subpage-title">Feedback</h2>
      <div id="feedback-modal-body" class="settings-subpage-body"></div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'theme-builder.js'))}"></script>
</body>
</html>`;
  }
}
