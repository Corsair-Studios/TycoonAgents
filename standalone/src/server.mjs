#!/usr/bin/env node
// TycoonAgents standalone server.
//
// Runs the TycoonAgents live agent visualization outside VS Code by serving
// a plain HTML host page that boots the UNMODIFIED media/main.js + media/
// style.css in place from the repo's media/ directory (single source of
// truth — never copied into standalone/).
//
// Routes:
//   GET  /              host page (DOM scaffold main.js expects + the real
//                        acquireVsCodeApi() shim: postMessage -> POST
//                        /message, SSE /events -> window 'message', and
//                        getState/setState -> localStorage — see the block
//                        comment above buildHostHtml() below)
//   GET  /media/<path>  static passthrough into the repo's media/ dir
//                        (path-traversal guarded)
//   GET  /events         SSE stream (server -> browser); connected clients
//                        are tracked so later tasks can broadcast() to them
//   POST /message        browser -> server message intake (JSON body);
//                        logged/dispatched — later tasks fill in real
//                        handling (wiring into the same message handling
//                        src/host/vscode/panel.ts's webview.onDidReceiveMessage
//                        does)
//
// MVP constraint: Node built-in modules only (http, fs, path, url) — no
// third-party dependencies (ws/express/electron etc.) until a later task
// introduces them deliberately.
//
// stateFeed.mjs (wired in main() below) watches the resolved primary
// project root's .claude/tycoon/activity.jsonl via activityWatcher.mjs and
// broadcast()s MSG.STATE-shaped { type: "state", state } messages over
// /events as "message" SSE events — see stateFeed.mjs's module header for
// the full panel.ts-parity contract. Which project root(s) are watched is
// resolved by projectRoots.mjs's resolveProjectRoots() (CLI arg(s) > env var
// > cwd default; see that module and the MULTI-DIR SEMANTICS comment on
// main() below) — this replaces vscode.workspace.workspaceFolders for the
// standalone host.
//
// Later tasks will add:
//   - a watcher over the rest of .claude/tycoon/*.json (plan.json,
//     active-agent.json UI-facing bits beyond state, etc.)
//
// The `npx tycoonagents-standalone` CLI wrapper (p4-t1) is cli.mjs's `watch`
// command, which drives this module's exported startServer() — see that
// function's doc comment below for the seam contract.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createStateFeed } from './stateFeed.mjs';
import { resolveProjectRoots, ProjectRootError } from './projectRoots.mjs';
import { createDefaultAppData } from './appData.mjs';
import {
  createFsThemeFileStore,
  themeImagesDirectoryPath,
  themeManifestPath,
  themeFramesPath,
  legacyManifestPath,
} from './themeFileStoreFs.mjs';
import {
  MSG_WIRE as THEME_MSG_WIRE,
  handleListThemes,
  handleSelectTheme,
  handleDeleteTheme,
  handleGetThemeImageReview,
  handleGetThemeItemFrames,
  listThemesFromStore,
  addUnlockedBadgeStandalone,
  saveRebirthStateStandalone,
} from './themeMessages.mjs';
import { exportThemeArchiveFromStore, importThemeArchiveToStore } from './themeArchive.mjs';
import { configureThemeFileStore, wireThemeServiceGeneration } from './themeGenerationBridge.mjs';
import {
  handlePlanTheme,
  handleGenerateTheme,
  handleRetryThemeImage,
  handleResliceThemeImage,
  handleNormalizeThemeCharacter,
  handleSetThemeImageReviewStatus,
  handleSetThemePauseForReview,
  handleCancelThemeGeneration,
  handleSetThemeItemNames,
  handleSetThemeItemDescriptions,
  handleSetThemeCreativeDirection,
  handleRegenerateThemeDescriptions,
  handleRenameThemeCharacter,
  handleApproveAllThemeImages,
  handleSaveThemePlan,
} from './themeGenerationMessages.mjs';
import { handleRestorePlanBackup, handleApprovePhase, postPlanState, computePlanState } from './projectPlanMessages.mjs';
import { handleExportTeamSetupStandalone, handleApplyTeamSetupStandalone, handleCheckTeamReadinessStandalone, handleGetTeamSetupDriftStandalone } from './teamSetupMessages.mjs';
import { resolveProviderId, getFeedbackEndpoint, buildFeedbackPayload, buildFeedbackContext, postFeedback } from './sharedLogic.mjs';
import { createThemeServiceHost } from './themeServiceHost.mjs';

// p40-t3: OPEN_THEME_BUILDER (webview->host, no payload) / THEME_BUILDER_OPENED
// (host->webview, { signedIn }) wire strings — must stay byte-identical to
// src/host/vscode/messages.ts's MSG.OPEN_THEME_BUILDER / MSG.THEME_BUILDER_OPENED.
const OPEN_THEME_BUILDER_WIRE = 'OPEN_THEME_BUILDER';
const THEME_BUILDER_OPENED_WIRE = 'THEME_BUILDER_OPENED';
// p75-t1: THEME_BUILDER_CLOSED / REQUEST_THEME_SERVICE_STATUS — must stay
// byte-identical to src/host/vscode/messages.ts's MSG.THEME_BUILDER_CLOSED /
// MSG.REQUEST_THEME_SERVICE_STATUS.
const THEME_BUILDER_CLOSED_WIRE = 'THEME_BUILDER_CLOSED';
const REQUEST_THEME_SERVICE_STATUS_WIRE = 'requestThemeServiceStatus';

// p44-t1: THEME_SERVICE_* wire strings — must stay byte-identical to
// src/host/vscode/messages.ts's MSG.THEME_SERVICE_*.
const THEME_SERVICE_GET_STATUS_WIRE = 'THEME_SERVICE_GET_STATUS';
const THEME_SERVICE_REQUEST_MAGIC_LINK_WIRE = 'THEME_SERVICE_REQUEST_MAGIC_LINK';
const THEME_SERVICE_VERIFY_WIRE = 'THEME_SERVICE_VERIFY';
const THEME_SERVICE_GOOGLE_START_WIRE = 'THEME_SERVICE_GOOGLE_START';
const THEME_SERVICE_GOOGLE_COMPLETE_WIRE = 'THEME_SERVICE_GOOGLE_COMPLETE';
const THEME_SERVICE_GOOGLE_OPEN_WIRE = 'THEME_SERVICE_GOOGLE_OPEN';
const THEME_SERVICE_SIGN_OUT_WIRE = 'THEME_SERVICE_SIGN_OUT';
const THEME_SERVICE_BUY_CREDITS_WIRE = 'THEME_SERVICE_BUY_CREDITS';
const THEME_SERVICE_SET_REFERRAL_CODE_WIRE = 'THEME_SERVICE_SET_REFERRAL_CODE';
const THEME_SERVICE_STATUS_WIRE = 'THEME_SERVICE_STATUS';

// Set inside startServer() (like themeStore/primaryProjectRoot below) so a
// fresh startServer() call — e.g. a test harness — always points the
// dispatch cases below at the CURRENT call's host, never a stale prior
// instance's. Never logged, never included in a broadcast payload directly
// (only postStatus's ThemeServiceHostStatus-shaped output is broadcast).
let themeServiceHostInstance;

// p49-t0: CSRF hardening. Minted fresh inside startServer() (never at module
// load, so a second startServer() call in the same process — e.g. a test
// harness — always gets its OWN token, never a stale prior instance's, same
// posture as themeStore/themeServiceHostInstance above). In-memory only:
// never logged, never written to disk. requestListener()'s
// checkOriginAndToken() below reads this module-level var on every request,
// so it always sees the CURRENT server instance's token.
let sessionToken = '';

// p49-t0 review fix: allowed Origins, derived from the REAL bound port
// (server.address().port, set once listen() resolves — see startServer()
// below) rather than trusted from the client-supplied Host header, which an
// attacker fully controls. Exactly two origins are ever valid for a given
// bound port: 127.0.0.1 and localhost.
let allowedOrigins = new Set();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MEDIA_DIR = path.join(REPO_ROOT, 'media');

const PORT = Number(process.env.TYCOON_STANDALONE_PORT) || 4173;
const HOST = process.env.TYCOON_STANDALONE_HOST || '127.0.0.1';

const requireCompiledModule = createRequire(import.meta.url);

// ── Pack-catalog compiled bridges (out/src/host/vscode/{packCatalog,mcpCatalog,agentConfig}.js) ──
// These three compiled modules are pure (no `import "vscode"` anywhere in
// their own or transitive imports — packCatalog.ts only pulls in
// src/core/agentBackend.ts -> modelAliases.ts; mcpCatalog.ts and
// agentConfig.ts import nothing) so, like imageModelsModule() above, they
// are safe to require() directly from the standalone's vscode-free process.
// Used by buildPacksPayload()/handleInstallPack() below to mirror panel.ts's
// _handleGetPacks/_handleInstallPack exactly (same generated agent markdown,
// same MCP merge semantics, same keyword-table shape) instead of
// reimplementing them.
const PACK_CATALOG_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'packCatalog.js');
const MCP_CATALOG_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'mcpCatalog.js');
const AGENT_CONFIG_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'agentConfig.js');
// Pure helper shared with panel.ts's _handleGetSkills/_handleGetPacks/_handleGetMcp —
// derives the `summary` field on skills/packs/MCP payload items (authored
// `summary` field wins, else first sentence of `description`). No `vscode`
// import in its own or transitive dependencies.
const CATALOG_SUMMARY_JS = path.join(REPO_ROOT, 'out', 'src', 'shared', 'catalogSummary.js');
// Codex CLI binary discovery (src/providers/codex/codexDiscovery.ts) — reused
// here so the standalone's pack-mcp install path substitutes a discovered
// absolute path for the codex MCP server's `command` the same way panel.ts
// does, instead of reimplementing the discovery ladder.
const CODEX_DISCOVERY_JS = path.join(REPO_ROOT, 'out', 'src', 'providers', 'codex', 'codexDiscovery.js');
// p68-t1: keyword-routing health model + fixer (pure) and its
// parseAgentKeywords body-section reader — shared with panel.ts so the two
// hosts' KEYWORD_HEALTH payload can never disagree.
const KEYWORD_HEALTH_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'keywordHealth.js');
const AGENT_KEYWORD_DEFAULTS_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'agentKeywordDefaults.js');

function requireCompiledOrThrow(jsPath, label) {
  if (!fs.existsSync(jsPath)) {
    throw new Error(
      `[tycoonagents-standalone] ${label}: ${jsPath} not found. The compiled \`out/\` directory is missing or ` +
        'stale — run `npx tsc -p .` from the repo root first, then restart the standalone server.',
    );
  }
  return requireCompiledModule(jsPath);
}

let _packCatalogModule;
function packCatalogModule() {
  if (!_packCatalogModule) _packCatalogModule = requireCompiledOrThrow(PACK_CATALOG_JS, 'packCatalog');
  return _packCatalogModule;
}
let _mcpCatalogModule;
function mcpCatalogModule() {
  if (!_mcpCatalogModule) _mcpCatalogModule = requireCompiledOrThrow(MCP_CATALOG_JS, 'mcpCatalog');
  return _mcpCatalogModule;
}
let _agentConfigModule;
function agentConfigModule() {
  if (!_agentConfigModule) _agentConfigModule = requireCompiledOrThrow(AGENT_CONFIG_JS, 'agentConfig');
  return _agentConfigModule;
}
let _catalogSummaryModule;
function catalogSummaryModule() {
  if (!_catalogSummaryModule) _catalogSummaryModule = requireCompiledOrThrow(CATALOG_SUMMARY_JS, 'catalogSummary');
  return _catalogSummaryModule;
}
let _codexDiscoveryModule;
function codexDiscoveryModule() {
  if (!_codexDiscoveryModule) _codexDiscoveryModule = requireCompiledOrThrow(CODEX_DISCOVERY_JS, 'codexDiscovery');
  return _codexDiscoveryModule;
}
let _keywordHealthModule;
function keywordHealthModule() {
  if (!_keywordHealthModule) _keywordHealthModule = requireCompiledOrThrow(KEYWORD_HEALTH_JS, 'keywordHealth');
  return _keywordHealthModule;
}
let _agentKeywordDefaultsModule;
function agentKeywordDefaultsModule() {
  if (!_agentKeywordDefaultsModule) {
    _agentKeywordDefaultsModule = requireCompiledOrThrow(AGENT_KEYWORD_DEFAULTS_JS, 'agentKeywordDefaults');
  }
  return _agentKeywordDefaultsModule;
}

/**
 * Mirrors panel.ts's _resolveCodexBinaryForInstall: for the `codex` MCP
 * catalog entry only, if the resolved config's `command` is still the bare
 * literal "codex", try substituting the absolute path discoverCodexBinary()
 * finds (e.g. the Codex CLI bundled inside the OpenAI ChatGPT VS Code
 * extension, not on PATH). Fail-open — any discovery failure just logs a
 * warning and returns the config unchanged; install must never be blocked
 * on this.
 */
function resolveCodexBinaryForInstallStandalone(id, config) {
  if (id !== 'codex' || config === null || typeof config !== 'object' || config.command !== 'codex') {
    return config;
  }
  try {
    const { discoverCodexBinary } = codexDiscoveryModule();
    const resolved = discoverCodexBinary();
    if (resolved === 'codex') return config;
    return { ...config, command: resolved };
  } catch (e) {
    console.warn(
      `[tycoonagents-standalone] could not discover the Codex CLI binary; installing the MCP entry with command "codex" as-is. ${e && e.message ? e.message : String(e)}`,
    );
    return config;
  }
}

// ── Delegation-doctrine / Project-Plan-toggle side-effect bridges ──────────
// Same "pure, no vscode import" posture as the four modules above — used by
// the Settings write handlers (setDelegationMode/setReviewEnabled/
// setSessionJournalEntries/SET_PROJECT_PLAN_ENABLED) below to replicate
// panel.ts's persistence + CLAUDE.md doctrine + lead/reviewer agent
// install/remove side effects byte-for-byte against the SAME
// .claude/tycoon/execution.json file the VS Code host reads/writes.
const DELEGATION_DOCTRINE_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'delegationDoctrine.js');
const UEFN_DETECT_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'uefnDetect.js');
const CODE_RULES_DOCTRINE_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'codeRulesDoctrine.js');
const AGENT_ROSTER_JS = path.join(REPO_ROOT, 'out', 'src', 'providers', 'claude-code', 'agentRoster.js');
const AGENT_BACKEND_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'agentBackend.js');
// Routing panel (p13-t1/t2/t4) host-agnostic bridge — same "pure, no vscode
// import" posture as the modules above. scriptsDir for both generators is
// REPO_ROOT itself (this process already resolves it at startup), matching
// panel.ts's use of context.extensionPath as ITS install root.
const ROUTING_HOST_OPS_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'routingHostOps.js');
const PROVIDER_SELECTION_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'providerSelection.js');
let _providerSelectionModule;
function providerSelectionModule() {
  if (!_providerSelectionModule) _providerSelectionModule = requireCompiledOrThrow(PROVIDER_SELECTION_JS, 'providerSelection');
  return _providerSelectionModule;
}

// p23-t11: Codex hook/dispatcher installers (leaf modules under
// src/providers/codex/ — same "pure, no vscode import" posture as the
// modules above).
const INSTALL_CODEX_HOOKS_JS = path.join(REPO_ROOT, 'out', 'src', 'providers', 'codex', 'installCodexHooks.js');
const INSTALL_CODEX_DISPATCHER_JS = path.join(REPO_ROOT, 'out', 'src', 'providers', 'codex', 'installCodexDispatcher.js');
let _installCodexHooksModule;
function installCodexHooksModule() {
  if (!_installCodexHooksModule) _installCodexHooksModule = requireCompiledOrThrow(INSTALL_CODEX_HOOKS_JS, 'installCodexHooks');
  return _installCodexHooksModule;
}
let _installCodexDispatcherModule;
function installCodexDispatcherModule() {
  if (!_installCodexDispatcherModule) _installCodexDispatcherModule = requireCompiledOrThrow(INSTALL_CODEX_DISPATCHER_JS, 'installCodexDispatcher');
  return _installCodexDispatcherModule;
}
// Extension-parity script paths: the standalone process's own copies under
// REPO_ROOT/hooks/ (same files panel.ts ships in the .vsix's hooks/ dir).
const CODEX_HOOK_SCRIPT_PATH = path.join(REPO_ROOT, 'hooks', 'tycoon-codex-hook.cjs');
const CODEX_DISPATCHER_SCRIPT_PATH = path.join(REPO_ROOT, 'hooks', 'tycoon-dispatcher-mcp.cjs');
// Markers mirrored from installCodexHooks.ts's private TOML_MARKER_START /
// HOOKS_JSON_MARKER_DESCRIPTION constants (not exported — that file must
// not be edited here). Keep byte-identical to that file's.
const CODEX_HOOK_TOML_MARKER = '# tycoon-codex-hook: managed notify entry (do not edit by hand)';
const CODEX_HOOKS_JSON_MARKER_DESCRIPTION = 'tycoon-codex-hook: managed by TycoonAgents (do not edit by hand)';
let _lastCodexHookWarnings;
let _lastCodexDispatcherWarnings;
let _lastCodexAgentsMdWarning;

/** Standalone analog of panel.ts's _detectCodexHooksInstalled. */
function detectCodexHooksInstalledStandalone(root) {
  try {
    const { resolveCodexHome } = installCodexHooksModule();
    const { codexHome } = resolveCodexHome({ env: process.env, platform: process.platform });
    const configTomlPath = path.join(codexHome, 'config.toml');
    const hasToml = fs.existsSync(configTomlPath) && fs.readFileSync(configTomlPath, 'utf8').includes(CODEX_HOOK_TOML_MARKER);
    let hasHooksJson = false;
    if (root) {
      const hooksJsonPath = path.join(root, '.codex', 'hooks.json');
      if (fs.existsSync(hooksJsonPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
          hasHooksJson = parsed && typeof parsed === 'object' && parsed.description === CODEX_HOOKS_JSON_MARKER_DESCRIPTION;
        } catch {
          hasHooksJson = false;
        }
      }
    }
    return hasToml || hasHooksJson;
  } catch {
    return false;
  }
}

/** Standalone analog of panel.ts's _detectCodexDispatcherInstalled. */
function detectCodexDispatcherInstalledStandalone() {
  try {
    const { isDispatcherMarkerInConfigToml } = installCodexDispatcherModule();
    return isDispatcherMarkerInConfigToml(process.env, process.platform);
  } catch {
    return false;
  }
}

let _routingHostOpsModule;
function routingHostOpsModule() {
  if (!_routingHostOpsModule) _routingHostOpsModule = requireCompiledOrThrow(ROUTING_HOST_OPS_JS, 'routingHostOps');
  return _routingHostOpsModule;
}

/**
 * Codex-doctrine-gap follow-up: standalone analog of panel.ts's
 * `_runCodexConfigGenerator`. Resolves scripts/generate-codex-config.mjs
 * from REPO_ROOT (the same scriptsDir saveRoutingProfile/clearRoutingProfile
 * already use for this project) and runs it for `root`. Never throws —
 * stashes a failure in `_lastCodexAgentsMdWarning`, surfaced by
 * buildStandaloneHarnessSettings exactly like `_lastCodexHookWarnings`.
 */
function runCodexConfigGeneratorStandalone(root) {
  if (!root) return;
  try {
    const { runCodexConfigGenerator } = routingHostOpsModule();
    const result = runCodexConfigGenerator(root, REPO_ROOT);
    _lastCodexAgentsMdWarning =
      result.code === 0 ? undefined : `Couldn't update AGENTS.md for Codex: ${result.output || 'unknown error'}`;
  } catch (err) {
    _lastCodexAgentsMdWarning = `Couldn't update AGENTS.md for Codex: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Standalone analog of panel.ts's _handleGetRouting payload build (p74-t1).
 * The standalone host has no harness of its own — it is always "multi" and
 * never shows the multiProvider checkbox (see agentsUiMode.ts's
 * resolveAgentsUiMode, which also treats harness "standalone" as multi).
 */
function buildRoutingPayload(root) {
  const { buildRoutingView } = routingHostOpsModule();
  const view = buildRoutingView({ root, env: process.env });
  return {
    ...view,
    uiMode: 'multi',
    harness: 'standalone',
    multiProviderSetting: true,
    multiProviderCheckboxVisible: false,
  };
}

let _delegationDoctrineModule;
function delegationDoctrineModule() {
  if (!_delegationDoctrineModule) _delegationDoctrineModule = requireCompiledOrThrow(DELEGATION_DOCTRINE_JS, 'delegationDoctrine');
  return _delegationDoctrineModule;
}
let _uefnDetectModule;
function uefnDetectModule() {
  if (!_uefnDetectModule) _uefnDetectModule = requireCompiledOrThrow(UEFN_DETECT_JS, 'uefnDetect');
  return _uefnDetectModule;
}
let _codeRulesDoctrineModule;
function codeRulesDoctrineModule() {
  if (!_codeRulesDoctrineModule) _codeRulesDoctrineModule = requireCompiledOrThrow(CODE_RULES_DOCTRINE_JS, 'codeRulesDoctrine');
  return _codeRulesDoctrineModule;
}
let _agentRosterModule;
function agentRosterModule() {
  if (!_agentRosterModule) _agentRosterModule = requireCompiledOrThrow(AGENT_ROSTER_JS, 'agentRoster');
  return _agentRosterModule;
}
let _agentBackendModule;
function agentBackendModule() {
  if (!_agentBackendModule) _agentBackendModule = requireCompiledOrThrow(AGENT_BACKEND_JS, 'agentBackend');
  return _agentBackendModule;
}

// p18-t1: shared route-aware Settings helper (describeAgentRoutes/
// describeRoutingVisibility/overrideAgentToClaudeTier) — same "pure, no
// vscode import" posture as the modules above.
const AGENT_SETTINGS_ROUTE_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'agentSettingsRoute.js');
let _agentSettingsRouteModule;
function agentSettingsRouteModule() {
  if (!_agentSettingsRouteModule) _agentSettingsRouteModule = requireCompiledOrThrow(AGENT_SETTINGS_ROUTE_JS, 'agentSettingsRoute');
  return _agentSettingsRouteModule;
}

// ── MIME map (media/ only ships a handful of extensions today) ─────────────
const MIME_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── SSE client registry ─────────────────────────────────────────────────────
// Later tasks (file watchers over .claude/tycoon/*.json etc.) will call
// broadcast() to push events to every connected browser tab. Exported so
// test harnesses can drive it directly without a real file-watcher wired up
// yet; eventName "message" is what the host page's acquireVsCodeApi() shim
// listens for and re-dispatches as a window 'message' event (see
// buildHostHtml() below).
const sseClients = new Set();

export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ── Initial-message catch-up for late-connecting clients ───────────────────
// broadcast() only reaches clients ALREADY connected at the time it's
// called. A browser tab that connects to /events after e.g. stateFeed.mjs
// has already computed real state from existing activity.jsonl backlog
// would otherwise sit on a blank board until the next live write triggers a
// broadcast — which could be a long time into an already-running session.
// Providers registered here are called once per new /events connection
// (this new client only — never re-broadcast to already-connected clients,
// which already have this state or something newer) and any messages they
// return are replayed to just that client before live SSE traffic begins.
/** @type {Array<() => Array<{ eventName: string, data: object }> | undefined>} */
let initialMessageProviders = [];

export function registerInitialMessageProvider(fn) {
  if (typeof fn !== 'function') return () => {};
  initialMessageProviders.push(fn);
  return () => {
    initialMessageProviders = initialMessageProviders.filter((f) => f !== fn);
  };
}

function writeSseEvent(res, eventName, data) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── /message dispatch hook point ────────────────────────────────────────────
// Dispatches the 4 non-AI theme messages (project-plan task pB-t1) — see
// themeMessages.mjs's module header for why those are REIMPLEMENTED against
// the vscode-free ThemeFileStore rather than importing themeService.ts
// directly (themeService.ts/themeStorage.ts/themeImageReviewState.ts all
// `import vscode` at load time). Everything else still just logs; later
// tasks wire in the remaining (AI-touching) message handling
// src/host/vscode/panel.ts's webview.onDidReceiveMessage does.
//
// `themeStore` is set by startServer() below (rooted at that call's
// appData.dir — see the pB-t1 CRITICAL note on startServer()'s theme-store
// wiring). A message that arrives before any startServer() call has run
// (should not happen in practice; only a defensive guard) is logged and
// dropped rather than throwing.
let themeStore;

// `primaryProjectRoot` is set by startServer() below to the resolved primary
// project root (`primary.root` — see the MULTI-DIR SEMANTICS comment on
// startServer()), the standalone's analog of panel.ts's `_projectRoot()`.
// Used ONLY by the Project Plan (phase/task) RESTORE_PLAN_BACKUP handler
// (projectPlanMessages.mjs) — an unrelated feature to theme generation that
// happens to be dispatched from this same switch (see that module's header
// for why). Never touched by any theme handler.
let primaryProjectRoot;

// `startupProviderId` is set by startServer() below to whichever provider id
// resolveProviderId() picked AT STARTUP (env/setting/execution.json at that
// moment) — the standalone never reconstructs a Provider mid-process (see
// buildStandaloneHarnessSettings's "no live swap" note), so this is the
// actual running selection for the harness settings' `running` field, kept
// separate from `effective` (recomputed fresh on every getSettings/setHarness
// so the UI can show a pending file change even though it hasn't taken
// effect yet). Falls back to 'claude-code' if resolution throws (e.g. a
// corrupt execution.json) so startup itself never fails over this.
let startupProviderId = 'claude-code';

// ── Feedback ("Submit feedback") retained-ticket store ──────────────────
// Mirrors panel.ts's `_feedbackTicketBodies` (private class field): a
// SUBMIT_FEEDBACK preview stores the exact JSON body string here keyed by
// ticketId so a later CONFIRM_FEEDBACK_SEND posts byte-identical bytes to
// what was previewed. Module-level (not per-startServer-call) is fine here —
// same posture panel.ts takes with a single long-lived Map for the process's
// lifetime; tests that call startServer() multiple times use fresh ticketIds
// (crypto.randomUUID()) so no cross-test collision is possible.
const _feedbackTicketBodies = new Map();
const FEEDBACK_TICKET_MAX_ENTRIES = 50;
const FEEDBACK_TICKET_MAX_AGE_MS = 30 * 60 * 1000;

function _pruneFeedbackTickets() {
  const now = Date.now();
  for (const [id, entry] of _feedbackTicketBodies) {
    if (now - entry.storedAt > FEEDBACK_TICKET_MAX_AGE_MS) {
      _feedbackTicketBodies.delete(id);
    }
  }
  while (_feedbackTicketBodies.size >= FEEDBACK_TICKET_MAX_ENTRIES) {
    const oldestId = _feedbackTicketBodies.keys().next().value;
    if (oldestId === undefined) break;
    _feedbackTicketBodies.delete(oldestId);
  }
}

// `themeImageAppData` is set by startServer() below to THAT call's own
// appData handle — BADGE_UNLOCKED/SAVE_REBIRTH_STATE persistence (and
// SELECT_THEME/handleReadyThemeBoot) read/write through it. Same
// per-call-instance posture as the other module-level theme state: a fresh
// startServer() call always overwrites this.
let themeImageAppData;

/**
 * Standalone analog of panel.ts's _handleCheckInstall (~line 4662-4730): the
 * standalone host has no VS Code extension host, workspace folder, or
 * bundled Verse extension to probe, so every VS-Code-only signal reports its
 * safe "not applicable"/off default rather than guessing. `installed: true`
 * is correct here because the standalone CLI itself IS the "hooks
 * installed" runtime — there is no separate install step to gate on.
 * Factored out of the 'checkInstall' case so buildBootHandshakeMessages()
 * (the initial-message-provider catch-up path, registered in startServer())
 * can compute the identical payload for a client that connects to /events
 * AFTER a 'checkInstall' POST already raced past — see that function's doc
 * comment for why this duplication would otherwise be a real, observed bug.
 */
function buildInstallStatePayload() {
  return {
    type: 'installState',
    installed: true,
    uefnDetected: false,
    uefnSignals: [],
    ignoreTargets: [],
    uefnInstalled: false,
    uefnBridgeSetUp: false,
    engineChips: [],
    foreignManagedBlocks: [],
    pathHealth: [],
    pathOverridesFilePath: null,
    pathOverridesFileExists: false,
    // Mirrors detectVerseExtensionState()'s "not found" shape exactly
    // (src/host/vscode/pathHealth.ts ~line 701-710) — there is no editor
    // extension host in the standalone to probe, so this is never anything
    // but the "not-installed" verdict.
    verseExtensionState: {
      state: 'not-installed',
      enabledVersion: null,
      versionsFound: [],
      multipleVersions: false,
      message:
        "Epic's Verse extension check is not applicable in the TycoonAgents standalone server (no editor extension host to probe).",
    },
  };
}

/**
 * The full boot-handshake reply set media/main.js posts for at load
 * (checkInstall/getPacks/getEngineStatus/REQUEST_PLAN/
 * REQUEST_OFFLOAD_OFFER_STATE — main.js:10948-10971), computed fresh so it
 * can be registered as an initial-message-provider (see
 * registerInitialMessageProvider, and its call site in startServer()).
 *
 * WHY this exists in addition to the individual /message case handlers
 * above: main.js calls `acquireVsCodeApi()` (which opens the `EventSource`
 * SSE connection) synchronously at module top, then runs the REST of its
 * ~17k-line top-level script body before reaching the `ready`/`checkInstall`
 * posts near the bottom (main.js:10948-10971) — so in practice the SSE
 * handshake is usually well underway first. But `EventSource`'s underlying
 * HTTP connection and each `fetch('/message', ...)` POST are two INDEPENDENT
 * requests with no ordering guarantee between them (slow/contended
 * localhost socket accept, event-loop scheduling, etc.), and `broadcast()`
 * only writes to `sseClients` already registered at the moment it's called —
 * it does not buffer or retry. A `checkInstall` (or the other four) that
 * arrives at the server before the GET /events handler has added this tab's
 * response to `sseClients` is silently dropped forever, and the client has
 * no retry: the boot overlay is then stuck on "Checking installation…"
 * permanently (the exact previously-reported bug — the "installState" reply
 * existed but the client that needed it never received it). Registering
 * this as an initial-message provider means every NEW /events connection
 * gets the full boot-handshake reply set unconditionally and immediately on
 * connect, independent of whether the corresponding /message POST already
 * raced past — so the overlay dismisses even in the race-losing case, and
 * the individual case handlers above remain correct/idempotent no-ops for
 * any LATER re-request (e.g. Settings' own checkInstall+getSettings).
 */
function buildBootHandshakeMessages() {
  return [
    { eventName: 'message', data: buildInstallStatePayload() },
    { eventName: 'message', data: buildPacksPayload() },
    { eventName: 'message', data: { type: 'engineStatus', chips: [] } },
    { eventName: 'message', data: computePlanState(primaryProjectRoot) },
    { eventName: 'message', data: computeOffloadOfferState(primaryProjectRoot) },
  ];
}

/**
 * Standalone analog of src/host/vscode/bundledThemeSeeds.ts's
 * seedBundledThemes() — that function is extension-host-only (imports
 * 'vscode' directly for both the extensionUri read side and the
 * ThemeManifest type), so it cannot be require()'d from the standalone's
 * vscode-free Node process the way sharedLogic.mjs reaches into compiled
 * `out/`. Reimplemented here against the SAME source assets
 * (`media/themes/<id>/{manifest.json,frames.json}`, MEDIA_DIR already
 * resolves this — see the module header) and the standalone's own fs-backed
 * ThemeFileStore, writing the MODERN per-theme-directory layout
 * (themeManifestPath/themeFramesPath) rather than bundledThemeSeeds.ts's
 * legacy flat naming, since listThemesFromStore() (themeMessages.mjs)
 * documents that "the standalone never writes that [legacy] layout".
 *
 * User-theme-wins rule (unchanged from the VS Code host): only seeds when
 * the store currently has ZERO themes — never overwrites or supplements an
 * existing theme, bundled or user-created. This is checked via
 * listThemesFromStore(store), so a user's own theme(s) already present
 * (any theme_id, not just the bundled one) skips seeding entirely. Without
 * this, handleReadyThemeBoot() finds nothing on a fresh standalone appData
 * dir and posts THEME_NONE, which renders the blue/green THEME_NONE
 * fallback stripes instead of a real theme.
 *
 * Never throws: every failure (missing media/themes, bad JSON, write
 * failure) is caught and logged — a seeding failure must never crash
 * startServer() or block the boot handshake.
 */
export async function seedBundledThemesIntoStore(store) {
  try {
    const existing = await listThemesFromStore(store);
    if (existing.length > 0) {
      console.log(
        `[tycoonagents-standalone] theme store already has ${existing.length} theme(s) — skipping bundled-theme seed.`,
      );
      return;
    }

    const bundledThemesDir = path.join(MEDIA_DIR, 'themes');
    let entries;
    try {
      entries = fs.readdirSync(bundledThemesDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[tycoonagents-standalone] no bundled themes dir at ${bundledThemesDir}:`, err);
      return;
    }

    const seeded = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const themeDir = path.join(bundledThemesDir, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(themeDir, 'manifest.json'), 'utf8'));
      } catch {
        continue; // not a theme dir (no manifest.json) — skip silently
      }
      const themeId = manifest && manifest.theme_id;
      if (!themeId) continue;
      try {
        const frames = fs.readFileSync(path.join(themeDir, 'frames.json'));
        await store.writeFile(themeManifestPath(themeId), Buffer.from(JSON.stringify(manifest, null, 2)));
        await store.writeFile(themeFramesPath(themeId), frames);
        seeded.push(themeId);
      } catch (err) {
        console.warn(`[tycoonagents-standalone] could not seed bundled theme "${themeId}":`, err);
      }
    }
    console.log(`[tycoonagents-standalone] seeded bundled theme(s): [${seeded.join(', ')}]`);
  } catch (err) {
    console.error('[tycoonagents-standalone] seedBundledThemesIntoStore failed:', err);
  }
}

function handleBrowserMessage(msg) {
  if (!msg || typeof msg.type !== 'string') {
    console.log('[tycoonagents-standalone] /message: malformed payload, dropping:', JSON.stringify(msg));
    return;
  }
  if (!themeStore) {
    console.log('[tycoonagents-standalone] /message:', JSON.stringify(msg), '(no theme store configured yet)');
    return;
  }
  const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
  // p67-t1: the webview's postThemeService() posts THEME_SERVICE_* messages
  // flat ({ type, ...fields }), not { type, payload }, so `payload` above is
  // always {} for them. Read those fields off msg itself instead.
  const themeServicePayload = msg && typeof msg === 'object' ? msg : {};
  switch (msg.type) {
    case THEME_MSG_WIRE.LIST_THEMES:
      handleListThemes(themeStore, broadcast).catch((err) => {
        console.error('[tycoonagents-standalone] LIST_THEMES failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SELECT_THEME:
      handleSelectTheme(themeStore, broadcast, payload.theme_id, {
        appData: themeImageAppData,
        projectRoot: primaryProjectRoot,
      }).catch((err) => {
        console.error('[tycoonagents-standalone] SELECT_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.DELETE_THEME:
      handleDeleteTheme(themeStore, broadcast, payload.theme_id).catch((err) => {
        console.error('[tycoonagents-standalone] DELETE_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.GET_THEME_IMAGE_REVIEW:
      handleGetThemeImageReview(themeStore, broadcast, payload.theme_id).catch((err) => {
        console.error('[tycoonagents-standalone] GET_THEME_IMAGE_REVIEW failed:', err);
      });
      break;
    case THEME_MSG_WIRE.GET_THEME_ITEM_FRAMES:
      handleGetThemeItemFrames(themeStore, broadcast, payload.theme_id, payload.item_id).catch((err) => {
        console.error('[tycoonagents-standalone] GET_THEME_ITEM_FRAMES failed:', err);
      });
      break;
    // ── Theme GENERATION messages (pC-t1 step 2) — drive the REAL
    // themeService.ts pipeline via themeGenerationBridge.mjs. Fire-and-forget
    // like every other case here: progress/results stream back over SSE
    // (broadcast) rather than blocking this POST /message response, which is
    // essential for GENERATE_THEME/RETRY_THEME_IMAGE/NORMALIZE_THEME_CHARACTER
    // since those can run for a long time (real image-generation API calls).
    case THEME_MSG_WIRE.PLAN_THEME:
      handlePlanTheme(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] PLAN_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.GENERATE_THEME:
      handleGenerateTheme(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] GENERATE_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SAVE_THEME_PLAN:
      // p76-t1: flat message (like the THEME_SERVICE_* family) — use
      // themeServicePayload (the whole msg minus nothing, same posture as
      // THEME_SERVICE_GET_STATUS etc.), not `payload` (msg.payload).
      handleSaveThemePlan(themeStore, broadcast, themeServicePayload).catch((err) => {
        console.error('[tycoonagents-standalone] SAVE_THEME_PLAN failed:', err);
      });
      break;
    case THEME_MSG_WIRE.RETRY_THEME_IMAGE:
      handleRetryThemeImage(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] RETRY_THEME_IMAGE failed:', err);
      });
      break;
    case THEME_MSG_WIRE.RESLICE_THEME_IMAGE:
      handleResliceThemeImage(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] RESLICE_THEME_IMAGE failed:', err);
      });
      break;
    case THEME_MSG_WIRE.NORMALIZE_THEME_CHARACTER:
      handleNormalizeThemeCharacter(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] NORMALIZE_THEME_CHARACTER failed:', err);
      });
      break;
    // Minimal support messages the generation gate needs — see
    // themeGenerationMessages.mjs's module header for why these are wired
    // alongside the five primary generation messages above.
    case THEME_MSG_WIRE.SET_THEME_IMAGE_REVIEW_STATUS:
      handleSetThemeImageReviewStatus(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_IMAGE_REVIEW_STATUS failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SET_THEME_PAUSE_FOR_REVIEW:
      handleSetThemePauseForReview(payload);
      break;
    case THEME_MSG_WIRE.CANCEL_THEME_GENERATION:
      handleCancelThemeGeneration(broadcast);
      break;
    // ── Badge unlock / rebirth persistence (p9-t6 scope addition) ───────
    // Standalone analogs of panel.ts's BADGE_UNLOCKED (~line 1509,
    // addUnlockedBadge) and SAVE_REBIRTH_STATE (~line 1518,
    // saveRebirthState) handlers — persisted through the SAME appData
    // handle SELECT_THEME/handleReadyThemeBoot read from (themeImageAppData),
    // scoped to (primaryProjectRoot, theme_id) via progressScope.js. No
    // reply is expected by media/main.js for either message.
    case 'BADGE_UNLOCKED':
      try {
        addUnlockedBadgeStandalone(themeImageAppData, primaryProjectRoot, payload.theme_id, payload.badge_id);
      } catch (err) {
        console.error('[tycoonagents-standalone] BADGE_UNLOCKED failed:', err);
      }
      break;
    case 'SAVE_REBIRTH_STATE':
      try {
        saveRebirthStateStandalone(themeImageAppData, primaryProjectRoot, payload.theme_id, payload.state);
      } catch (err) {
        console.error('[tycoonagents-standalone] SAVE_REBIRTH_STATE failed:', err);
      }
      break;
    // ── Theme review-EDITOR + recovery messages (pC-t2) ─────────────────
    case THEME_MSG_WIRE.SET_THEME_ITEM_NAMES:
      handleSetThemeItemNames(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_ITEM_NAMES failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SET_THEME_ITEM_DESCRIPTIONS:
      handleSetThemeItemDescriptions(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_ITEM_DESCRIPTIONS failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SET_THEME_CREATIVE_DIRECTION:
      handleSetThemeCreativeDirection(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_CREATIVE_DIRECTION failed:', err);
      });
      break;
    case THEME_MSG_WIRE.REGENERATE_THEME_DESCRIPTIONS:
      handleRegenerateThemeDescriptions(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] REGENERATE_THEME_DESCRIPTIONS failed:', err);
      });
      break;
    case THEME_MSG_WIRE.RENAME_THEME_CHARACTER:
      handleRenameThemeCharacter(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] RENAME_THEME_CHARACTER failed:', err);
      });
      break;
    case THEME_MSG_WIRE.APPROVE_ALL_THEME_IMAGES:
      handleApproveAllThemeImages(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] APPROVE_ALL_THEME_IMAGES failed:', err);
      });
      break;
    // RESTORE_PLAN_BACKUP is the unrelated Project Plan (phase/task) feature
    // (see projectPlanMessages.mjs's header) — synchronous, no theme store
    // involved, keyed off primaryProjectRoot instead of a theme_id payload.
    case THEME_MSG_WIRE.RESTORE_PLAN_BACKUP:
      try {
        handleRestorePlanBackup(primaryProjectRoot, broadcast);
      } catch (err) {
        console.error('[tycoonagents-standalone] RESTORE_PLAN_BACKUP failed:', err);
      }
      break;
    // GET/SAVE_THEME_IMAGE_SETTINGS (direct-provider API-key/model/quality
    // settings) were removed in p44-t2: media/main.js already documents
    // (its THEME_IMAGE_SETTINGS handler comment) that these are no longer
    // posted from the webview, and panel.ts has zero references to either —
    // both hosts now route generation entirely through the Corsair Theme
    // Service, which owns provider/model selection.
    // ── Boot-time handshake (media/main.js's boot sequence, ~main.js:10935-
    // 10971: "ready" then checkInstall/getPacks/getEngineStatus/
    // REQUEST_PLAN/REQUEST_OFFLOAD_OFFER_STATE fired back-to-back before the
    // webview's first paint). Every reply here uses the SAME broadcast()
    // fire-and-forget pattern every other case in this switch uses (there is
    // no per-request reply channel — POST /message always 202s immediately;
    // real replies always arrive over the /events SSE stream) and matches
    // media/main.js's Boolean()/Array.isArray()-guarded field reads, so a
    // minimal/standalone-appropriate payload here never throws client-side.
    // Previously these all fell through to the `default` "(unhandled)" log
    // below, which left the panel stuck on "Checking installation..." and
    // the theme stage waiting out its 15s pending-fallback timer.
    case 'ready':
      // Mirrors panel.ts's MSG.READY handler (src/host/vscode/panel.ts
      // ~line 905-963): resolve the theme-stage wait immediately by posting
      // THEME_INITIALIZED for an existing theme, or THEME_NONE otherwise —
      // never leave the client to hit its own 15s "pending" fallback.
      handleReadyThemeBoot(themeStore, broadcast).catch((err) => {
        console.error('[tycoonagents-standalone] ready (theme boot) failed:', err);
        broadcast('message', { type: THEME_MSG_WIRE.THEME_NONE, payload: {} });
      });
      break;
    case 'checkInstall':
      // Standalone analog of panel.ts's _handleCheckInstall (~line 4662-
      // 4730). See buildInstallStatePayload() below for field-by-field
      // rationale.
      broadcast('message', buildInstallStatePayload());
      break;
    case 'getPacks':
      // Standalone analog of panel.ts's _handleGetPacks (~line 3626-3686) —
      // see buildPacksPayload() below.
      broadcast('message', buildPacksPayload());
      break;
    case 'installPack':
      // Standalone analog of panel.ts's _handleInstallPack (~line 3768-
      // 3982) — see handleInstallPack() below for what is/isn't replicated.
      handleInstallPack(msg);
      break;
    case 'getRouting':
      // Standalone analog of panel.ts's _handleGetRouting.
      try {
        const view = buildRoutingPayload(primaryProjectRoot || process.cwd());
        broadcast('message', { type: 'routing', payload: view });
      } catch (err) {
        console.error('[tycoonagents-standalone] getRouting failed:', err);
      }
      break;
    case 'saveRouting':
      // Standalone analog of panel.ts's _handleSaveRouting. media/main.js
      // posts { type, profile } flat on the message (matching panel.ts's
      // MSG_SCHEMAS.SAVE_ROUTING.safeParse(message) shape) — NOT nested
      // under `payload` (that wrapper is for the THEME_MSG_WIRE cases
      // above). Reading payload.profile here silently saved `undefined`.
      try {
        const { saveRoutingProfile } = routingHostOpsModule();
        const root = primaryProjectRoot || process.cwd();
        const effectiveHarness = resolveEffectiveHarness(root);
        const result = saveRoutingProfile({ root, profile: msg.profile, scriptsDir: REPO_ROOT, effectiveHarness });
        broadcast('message', { type: 'routingSaved', ...result });
        broadcast('message', { type: 'routing', payload: buildRoutingPayload(root) });
      } catch (err) {
        console.error('[tycoonagents-standalone] saveRouting failed:', err);
      }
      break;
    case 'clearRouting':
      // Standalone analog of panel.ts's _handleClearRouting.
      try {
        const { clearRoutingProfile } = routingHostOpsModule();
        const root = primaryProjectRoot || process.cwd();
        const result = clearRoutingProfile({ root, scriptsDir: REPO_ROOT });
        broadcast('message', { type: 'routingSaved', ...result });
        broadcast('message', { type: 'routing', payload: buildRoutingPayload(root) });
      } catch (err) {
        console.error('[tycoonagents-standalone] clearRouting failed:', err);
      }
      break;
    case 'probeEnv':
      // Standalone analog of panel.ts's _handleProbeEnv. media/main.js posts
      // { type, names } flat (MSG_SCHEMAS.PROBE_ENV.safeParse(message)) —
      // not payload.names.
      try {
        const { probeEnv } = routingHostOpsModule();
        const names = Array.isArray(msg.names) ? msg.names : [];
        broadcast('message', { type: 'envProbe', payload: probeEnv(names, process.env) });
      } catch (err) {
        console.error('[tycoonagents-standalone] probeEnv failed:', err);
      }
      break;
    case 'setLocalEnvValue':
      // Standalone analog of panel.ts's _handleSetLocalEnvValue (p13-t6).
      // The value is never logged or broadcast — only the resulting
      // envProbe entry for `name`. media/main.js posts { type, name, value }
      // flat (MSG_SCHEMAS.SET_LOCAL_ENV_VALUE.safeParse(message)) — not
      // nested under payload.
      try {
        const { setLocalEnvValue } = routingHostOpsModule();
        const entry = setLocalEnvValue(String(msg.name || ''), String(msg.value ?? ''), process.env);
        broadcast('message', { type: 'envProbe', payload: { [msg.name]: entry } });
      } catch (err) {
        console.error('[tycoonagents-standalone] setLocalEnvValue failed:', err instanceof Error ? err.message : err);
      }
      break;
    case 'clearLocalEnvValue':
      // Standalone analog of panel.ts's _handleClearLocalEnvValue (p13-t6).
      // Flat { type, name } — see setLocalEnvValue note above.
      try {
        const { clearLocalEnvValue } = routingHostOpsModule();
        const entry = clearLocalEnvValue(String(msg.name || ''), process.env);
        broadcast('message', { type: 'envProbe', payload: { [msg.name]: entry } });
      } catch (err) {
        console.error('[tycoonagents-standalone] clearLocalEnvValue failed:', err instanceof Error ? err.message : err);
      }
      break;
    case 'setHarness': {
      // Standalone analog of panel.ts's _handleSetHarness (p13-t7). Writes
      // the `provider` key into execution.json when TYCOON_PROVIDER isn't
      // already forcing a value (matches describeProviderSelection's
      // precedence — writing while env wins would silently do nothing
      // useful, so we still write but the reply's harness.source stays
      // 'env' and the UI keeps the dropdown disabled either way); no live
      // swap exists for the standalone watcher, so requiresRestart is
      // always true (see buildStandaloneHarnessSettings).
      const root = primaryProjectRoot;
      if (!root) {
        console.error('[tycoonagents-standalone] setHarness: no project root resolved');
        break;
      }
      try {
        const { writeProviderSelection } = providerSelectionModule();
        writeProviderSelection(root, String(msg.provider || ''));
      } catch (err) {
        console.error('[tycoonagents-standalone] setHarness failed:', err instanceof Error ? err.message : err);
      }
      // Trigger (b) of the codex-doctrine-gap follow-up: switching TO codex
      // refreshes AGENTS.md's Codex block right away (standalone analog of
      // panel.ts's _handleSetHarness). Switching away leaves the block in
      // place on purpose — see runCodexConfigGenerator's doc comment.
      if (String(msg.provider || '') === 'codex') {
        runCodexConfigGeneratorStandalone(root);
      }
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      break;
    }
    case 'installCodexHooks': {
      const root = primaryProjectRoot;
      if (!root) {
        console.error('[tycoonagents-standalone] installCodexHooks: no project root resolved');
        break;
      }
      try {
        const { installCodexHooks } = installCodexHooksModule();
        const result = installCodexHooks({
          projectDir: root,
          env: process.env,
          platform: process.platform,
          hookScriptPath: CODEX_HOOK_SCRIPT_PATH,
        });
        _lastCodexHookWarnings = result.warnings;
      } catch (err) {
        console.error('[tycoonagents-standalone] installCodexHooks failed:', err instanceof Error ? err.message : err);
        _lastCodexHookWarnings = [err instanceof Error ? err.message : String(err)];
      }
      // Trigger (a) of the codex-doctrine-gap follow-up (standalone analog
      // of panel.ts's _handleInstallCodexHooks).
      runCodexConfigGeneratorStandalone(root);
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      break;
    }
    case 'uninstallCodexHooks': {
      const root = primaryProjectRoot;
      if (!root) {
        console.error('[tycoonagents-standalone] uninstallCodexHooks: no project root resolved');
        break;
      }
      try {
        const { uninstallCodexHooks } = installCodexHooksModule();
        uninstallCodexHooks({ projectDir: root, env: process.env, platform: process.platform });
        _lastCodexHookWarnings = undefined;
      } catch (err) {
        console.error('[tycoonagents-standalone] uninstallCodexHooks failed:', err instanceof Error ? err.message : err);
      }
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      break;
    }
    case 'installCodexDispatcher': {
      const root = primaryProjectRoot;
      if (!root) {
        console.error('[tycoonagents-standalone] installCodexDispatcher: no project root resolved');
        break;
      }
      try {
        const { installCodexDispatcher } = installCodexDispatcherModule();
        const result = installCodexDispatcher({
          projectDir: root,
          env: process.env,
          platform: process.platform,
          serverScriptPath: CODEX_DISPATCHER_SCRIPT_PATH,
        });
        _lastCodexDispatcherWarnings = result.warnings;
      } catch (err) {
        console.error('[tycoonagents-standalone] installCodexDispatcher failed:', err instanceof Error ? err.message : err);
        _lastCodexDispatcherWarnings = [err instanceof Error ? err.message : String(err)];
      }
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      break;
    }
    case 'uninstallCodexDispatcher': {
      try {
        const { uninstallCodexDispatcher } = installCodexDispatcherModule();
        uninstallCodexDispatcher({ env: process.env, platform: process.platform });
        _lastCodexDispatcherWarnings = undefined;
      } catch (err) {
        console.error('[tycoonagents-standalone] uninstallCodexDispatcher failed:', err instanceof Error ? err.message : err);
      }
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      break;
    }
    case 'setUseMultipleLlms': {
      // Standalone analog of panel.ts's _handleSetUseMultipleLlms (p18-t1).
      // Never touches routing.json — hiding the Routing screen again must
      // never delete the saved profile.
      const root = primaryProjectRoot;
      if (!root) {
        console.error('[tycoonagents-standalone] setUseMultipleLlms: no project root resolved');
        break;
      }
      try {
        const { writeUseMultipleLlms } = providerSelectionModule();
        writeUseMultipleLlms(root, Boolean(msg.value));
      } catch (err) {
        console.error('[tycoonagents-standalone] setUseMultipleLlms failed:', err instanceof Error ? err.message : err);
      }
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      break;
    }
    case 'setAgentModel': {
      // Standalone analog of panel.ts's _handleSetAgentModel (p18-t1): for
      // an agent whose route is not pure frontmatter, overrideAgentToClaudeTier
      // writes an explicit routing.json entry instead of frontmatter, so the
      // click wins over routing.json's own default/explicit route. Falls
      // back to the original setFrontmatterModel write when that returns
      // handled:false (frontmatter-only agent, or unknown agent id).
      const root = primaryProjectRoot;
      const id = String(msg.id || '');
      const model = String(msg.model || '');
      if (!root) {
        console.error('[tycoonagents-standalone] setAgentModel: no project root resolved');
        break;
      }
      (async () => {
        const { isSafeAgentId, modelIdFromShort, setFrontmatterModel } = agentConfigModule();
        if (!isSafeAgentId(id)) {
          broadcast('message', { type: 'settingsUpdated', ok: false, id, field: 'model', error: 'invalid agent id' });
          return;
        }
        const fullId = modelIdFromShort(model);
        if (fullId === undefined) {
          broadcast('message', { type: 'settingsUpdated', ok: false, id, field: 'model', error: 'unknown model' });
          return;
        }
        try {
          const { overrideAgentToClaudeTier } = agentSettingsRouteModule();
          const override = await overrideAgentToClaudeTier(root, id, model, { scriptsDir: REPO_ROOT });
          if (override.handled) {
            broadcast('message', {
              type: 'settingsUpdated',
              ok: override.ok,
              id,
              field: 'model',
              ...(override.ok ? {} : { error: override.errors.join('; ') }),
            });
            broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
            return;
          }
        } catch (err) {
          console.error('[tycoonagents-standalone] overrideAgentToClaudeTier failed, falling back to frontmatter:', err instanceof Error ? err.message : err);
        }
        try {
          const filePath = path.join(root, '.claude', 'agents', `${id}.md`);
          const content = fs.readFileSync(filePath, 'utf8');
          fs.writeFileSync(filePath, setFrontmatterModel(content, fullId));
          broadcast('message', { type: 'settingsUpdated', ok: true, id, field: 'model' });
          broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
        } catch (err) {
          broadcast('message', { type: 'settingsUpdated', ok: false, id, field: 'model', error: String(err) });
        }
      })();
      break;
    }
    case 'clearAgentRoute': {
      // Standalone analog of panel.ts's _handleClearAgentRoute (p20-t1):
      // removes one agent's explicit routing.json entry, then re-posts
      // settings + routing like setAgentModel does.
      const root = primaryProjectRoot;
      const id = String(msg.agentId || '');
      if (!root) {
        console.error('[tycoonagents-standalone] clearAgentRoute: no project root resolved');
        break;
      }
      (async () => {
        const { isSafeAgentId } = agentConfigModule();
        if (!isSafeAgentId(id)) {
          console.error(`[tycoonagents-standalone] clearAgentRoute rejected unsafe agent id "${id}".`);
          return;
        }
        try {
          const { clearAgentRoute } = agentSettingsRouteModule();
          const result = await clearAgentRoute(root, id, { scriptsDir: REPO_ROOT });
          if (result.handled && !result.ok) {
            console.error('[tycoonagents-standalone] clearAgentRoute failed:', result.errors.join('; '));
          }
        } catch (err) {
          console.error('[tycoonagents-standalone] clearAgentRoute failed:', err instanceof Error ? err.message : err);
        }
        broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
        try {
          broadcast('message', { type: 'routing', payload: buildRoutingPayload(root) });
        } catch (err) {
          console.error('[tycoonagents-standalone] clearAgentRoute routing re-post failed:', err instanceof Error ? err.message : err);
        }
      })();
      break;
    }
    case 'setAgentKeywords': {
      // Standalone analog of panel.ts's _handleSetAgentKeywords (~line
      // 7493-7521). media/main.js posts { type, id, pattern } flat
      // (matches panel.ts's MSG_SCHEMAS.SET_AGENT_KEYWORDS.safeParse(message)
      // shape) — write the pattern into agent-keywords.json via the same
      // compiled agentConfig.js helper the VS Code host and installAgentFiles
      // use, then reply settingsUpdated the way setAgentModel does.
      const root = primaryProjectRoot;
      const id = String(msg.id || '');
      const pattern = String(msg.pattern ?? '');
      if (!root) {
        console.error('[tycoonagents-standalone] setAgentKeywords: no project root resolved');
        break;
      }
      try {
        const { setKeywordPattern } = agentConfigModule();
        const cfg = readKeywordsConfigStandalone(root);
        const updated = setKeywordPattern(cfg, id, pattern);
        const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
        fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
        fs.writeFileSync(keywordsPath, JSON.stringify(updated, null, 2));
        broadcast('message', { type: 'settingsUpdated', ok: true, id, field: 'keywords' });
      } catch (err) {
        broadcast('message', { type: 'settingsUpdated', ok: false, id, field: 'keywords', error: String(err) });
      }
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      break;
    }
    case 'removeAgent': {
      // Standalone analog of panel.ts's _handleRemoveAgent (~line 7399-
      // 7482): delete .claude/agents/<id>.md and its agent-keywords.json
      // routing entry. No native confirm dialog exists in the standalone
      // host (the webview's own confirm UI gates the click before this
      // message is ever posted), and orchestrator/coordinator agents are
      // refused the same way panel.ts refuses removing "orchestrator".
      const root = primaryProjectRoot;
      const id = String(msg.id || '');
      if (!root) {
        console.error('[tycoonagents-standalone] removeAgent: no project root resolved');
        break;
      }
      try {
        const { isSafeAgentId } = agentConfigModule();
        if (!isSafeAgentId(id)) {
          broadcast('message', { type: 'agentRemoved', id, ok: false, error: 'invalid agent id' });
          break;
        }
        if (id === 'orchestrator' || id === 'coordinator') {
          broadcast('message', { type: 'agentRemoved', id, ok: false, error: 'core agent cannot be removed' });
          break;
        }
        const agentPath = path.join(root, '.claude', 'agents', `${id}.md`);
        if (fs.existsSync(agentPath)) {
          fs.unlinkSync(agentPath);
        }
        const { removeKeywordPattern } = agentConfigModule();
        const cfg = readKeywordsConfigStandalone(root);
        const updated = removeKeywordPattern(cfg, id);
        const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
        fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
        fs.writeFileSync(keywordsPath, JSON.stringify(updated, null, 2));
        broadcast('message', { type: 'agentRemoved', id, ok: true });
      } catch (err) {
        broadcast('message', { type: 'agentRemoved', id, ok: false, error: String(err) });
        break;
      }
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      try {
        broadcast('message', { type: 'routing', payload: buildRoutingPayload(root) });
      } catch (err) {
        console.error('[tycoonagents-standalone] removeAgent routing re-post failed:', err instanceof Error ? err.message : err);
      }
      break;
    }
    case 'openAgentFile': {
      // Standalone analog of panel.ts's _handleOpenAgentFile: no in-browser
      // text editor exists here, so this reveals .claude/agents/<id>.md in
      // the OS file manager instead of opening it in an editor tab.
      const root = primaryProjectRoot;
      const id = String(msg.id || '');
      if (!root) {
        console.error('[tycoonagents-standalone] openAgentFile: no project root resolved');
        break;
      }
      try {
        const { isSafeAgentId } = agentConfigModule();
        if (!isSafeAgentId(id)) {
          console.error('[tycoonagents-standalone] openAgentFile: invalid agent id:', id);
          break;
        }
        const agentPath = path.join(root, '.claude', 'agents', `${id}.md`);
        if (!fs.existsSync(agentPath)) {
          console.error('[tycoonagents-standalone] openAgentFile: file not found:', agentPath);
          break;
        }
        const { spawn } = requireCompiledModule('node:child_process');
        if (process.platform === 'win32') {
          spawn('explorer', [`/select,${agentPath}`], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', ['-R', agentPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [path.dirname(agentPath)], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch (err) {
        console.error('[tycoonagents-standalone] openAgentFile failed:', err instanceof Error ? err.message : err);
      }
      break;
    }
    case 'OPEN_AGENT_KEYWORDS_FILE': {
      // Standalone analog of panel.ts's _handleOpenAgentKeywordsFile: no
      // in-browser editor exists here, so broadcast a small notice with the
      // relative path instead of opening a document.
      const root = primaryProjectRoot;
      if (!root) {
        console.error('[tycoonagents-standalone] OPEN_AGENT_KEYWORDS_FILE: no project root resolved');
        break;
      }
      const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
      const relPath = path.relative(root, keywordsPath);
      if (!fs.existsSync(keywordsPath)) {
        broadcast('message', {
          type: 'settingsUpdated',
          ok: false,
          id: 'agent-keywords-file',
          field: 'keywords',
          error: `${relPath} does not exist yet.`,
        });
        break;
      }
      broadcast('message', {
        type: 'settingsUpdated',
        ok: true,
        id: 'agent-keywords-file',
        field: 'keywordsFileNotice',
        path: relPath,
      });
      break;
    }
    case 'getSettings':
      // Standalone analog of panel.ts's _handleGetSettings (~line 6783-
      // 6909). main.js's renderSettings() (media/main.js:16239) only shows
      // "Loading settings…" while `lastSettings` is null/undefined — any
      // object unblocks it, and every field it reads is `||`/Array.isArray/
      // Boolean-guarded, so a minimal-but-honest standalone payload (no
      // roster mutation UI, no context-budget scan) is safe here. This case
      // was previously MISSING entirely, so getSettings fell through to the
      // `default` "(unhandled)" log below and the Settings screen never
      // resolved out of "Loading settings…".
      broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
      if (primaryProjectRoot) {
        try {
          broadcast('message', { type: 'KEYWORD_HEALTH', ...buildKeywordHealthPayload(primaryProjectRoot) });
        } catch (err) {
          console.error('[tycoonagents-standalone] getSettings KEYWORD_HEALTH failed:', err instanceof Error ? err.message : err);
        }
      }
      break;
    case 'GET_KEYWORD_HEALTH': {
      // p68-t1: on-demand recompute, standalone analog of panel.ts's
      // _postKeywordHealth via MSG.GET_KEYWORD_HEALTH.
      const root = primaryProjectRoot;
      if (!root) break;
      try {
        broadcast('message', { type: 'KEYWORD_HEALTH', ...buildKeywordHealthPayload(root) });
      } catch (err) {
        console.error('[tycoonagents-standalone] GET_KEYWORD_HEALTH failed:', err instanceof Error ? err.message : err);
      }
      break;
    }
    case 'KEYWORD_HEALTH_FIX': {
      // p68-t1: standalone analog of panel.ts's _handleKeywordHealthFix.
      // Flat envelope: { action: "fix_all" } | { action: "add", agentId, token }.
      const root = primaryProjectRoot;
      if (!root) break;
      try {
        const agentsDir = path.join(root, '.claude', 'agents');
        let agentIds = [];
        try {
          agentIds = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
        } catch {
          agentIds = [];
        }
        const { parseAgentKeywords } = agentKeywordDefaultsModule();
        const { normalizeAgentKeywords } = keywordHealthModule();
        const { setKeywordPattern } = agentConfigModule();
        const agents = agentIds.map((id) => {
          let content = '';
          try {
            content = fs.readFileSync(path.join(agentsDir, `${id}.md`), 'utf8');
          } catch {
            content = '';
          }
          return { id, keywords: parseAgentKeywords(content) };
        });

        let config = readKeywordsConfigStandalone(root);
        let changed = false;

        if (msg.action === 'fix_all') {
          const result = normalizeAgentKeywords(config, agents);
          config = result.config;
          changed = result.changed;
        } else if (msg.action === 'add') {
          // Review fix: mirror messages.ts's KEYWORD_HEALTH_FIX zod schema
          // (token /^[a-z0-9_-]{1,40}$/, agentId /^[a-z0-9-]{1,64}$/) and
          // panel.ts's roster check — reject and log without values.
          const agentId = String(msg.agentId || '');
          const token = String(msg.token || '');
          const validShape = /^[a-z0-9-]{1,64}$/.test(agentId) && /^[a-z0-9_-]{1,40}$/.test(token);
          if (!validShape || !agentIds.includes(agentId)) {
            console.error('[tycoonagents-standalone] keyword add rejected (invalid shape or agentId not in current roster)');
            broadcast('message', { type: 'KEYWORD_HEALTH', ...buildKeywordHealthPayload(root) });
            break;
          }
          const agentsMap = config && typeof config.agents === 'object' && config.agents !== null ? config.agents : {};
          const entry = agentsMap[agentId];
          const existing = entry && typeof entry.pattern === 'string' ? entry.pattern : '';
          const segments = existing.split('|').map((s) => s.trim()).filter((s) => s !== '');
          if (!segments.some((s) => s.toLowerCase() === token.toLowerCase())) segments.push(token);
          config = setKeywordPattern(config, agentId, segments.join('|'));
          changed = true;
        }

        if (changed) {
          const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
          fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
          try {
            const existingRaw = fs.readFileSync(keywordsPath, 'utf8');
            fs.writeFileSync(`${keywordsPath}.bak`, existingRaw);
          } catch {
            /* no existing file to back up -> first write */
          }
          atomicWriteFileSyncStandalone(keywordsPath, JSON.stringify(config, null, 2));
        }
      } catch (err) {
        console.error('[tycoonagents-standalone] KEYWORD_HEALTH_FIX failed:', err instanceof Error ? err.message : err);
      }
      try {
        broadcast('message', { type: 'KEYWORD_HEALTH', ...buildKeywordHealthPayload(root) });
      } catch (err) {
        console.error('[tycoonagents-standalone] KEYWORD_HEALTH_FIX re-post failed:', err instanceof Error ? err.message : err);
      }
      break;
    }
    case 'getEngineStatus':
      // main.js's "engineStatus" handler: renderEngineChips(Array.isArray(msg.chips) ? msg.chips : []).
      broadcast('message', { type: 'engineStatus', chips: [] });
      break;
    case OPEN_THEME_BUILDER_WIRE:
      // Standalone analog of panel.ts's MSG.OPEN_THEME_BUILDER branch
      // (p40-t3/p44-t1/p75-t1) — never awaits a network fetch: replies
      // immediately with the cached/pending snapshot, then refreshes in the
      // background (with "waking"/retry-backoff while the backend is asleep).
      if (themeServiceHostInstance) {
        broadcast('message', { type: THEME_BUILDER_OPENED_WIRE, payload: themeServiceHostInstance.getCachedOrPendingStatus() });
        themeServiceHostInstance.refreshStatusInBackground();
      } else {
        broadcast('message', { type: THEME_BUILDER_OPENED_WIRE, payload: { signedIn: false } });
      }
      break;
    case THEME_BUILDER_CLOSED_WIRE:
      if (themeServiceHostInstance) themeServiceHostInstance.cancelBackgroundStatusRetry();
      break;
    case REQUEST_THEME_SERVICE_STATUS_WIRE:
      if (themeServiceHostInstance) themeServiceHostInstance.refreshStatusInBackground();
      break;
    case THEME_SERVICE_GET_STATUS_WIRE:
      if (themeServiceHostInstance) void themeServiceHostInstance.handleGetStatus();
      break;
    case THEME_SERVICE_REQUEST_MAGIC_LINK_WIRE: {
      const email = String(themeServicePayload.email || '');
      if (!email) { console.log(`[tycoonagents-standalone] panel: ${THEME_SERVICE_REQUEST_MAGIC_LINK_WIRE} rejected: email:too_small`); break; }
      if (themeServiceHostInstance) void themeServiceHostInstance.handleRequestMagicLink(email);
      break;
    }
    case THEME_SERVICE_VERIFY_WIRE: {
      const email = String(themeServicePayload.email || '');
      const code = String(themeServicePayload.code || '');
      if (!email || !code) { console.log(`[tycoonagents-standalone] panel: ${THEME_SERVICE_VERIFY_WIRE} rejected: ${!email ? 'email' : 'code'}:too_small`); break; }
      if (themeServiceHostInstance) void themeServiceHostInstance.handleVerify(email, code);
      break;
    }
    case THEME_SERVICE_GOOGLE_START_WIRE:
      if (themeServiceHostInstance) {
        void themeServiceHostInstance.handleGoogleStart().catch((err) => {
          console.log(`[tycoonagents-standalone] THEME_SERVICE_GOOGLE_START handler threw: ${scrubOpenExternalError(err)}`);
          broadcast('message', {
            type: THEME_SERVICE_STATUS_WIRE,
            payload: { signedIn: false, error: { kind: 'browser_open_failed', message: scrubOpenExternalError(err) } },
          });
        });
      }
      break;
    case THEME_SERVICE_GOOGLE_COMPLETE_WIRE:
      if (themeServiceHostInstance) void themeServiceHostInstance.handleGoogleComplete(themeServicePayload.code ? String(themeServicePayload.code) : undefined);
      break;
    case THEME_SERVICE_GOOGLE_OPEN_WIRE:
      // themeServicePayload.url (if any) is advisory only — handleGoogleOpen
      // re-opens only the URL it stored from THEME_SERVICE_GOOGLE_START.
      if (themeServiceHostInstance) {
        void themeServiceHostInstance.handleGoogleOpen().catch((err) => {
          console.log(`[tycoonagents-standalone] THEME_SERVICE_GOOGLE_OPEN handler threw: ${scrubOpenExternalError(err)}`);
          broadcast('message', {
            type: THEME_SERVICE_STATUS_WIRE,
            payload: { signedIn: false, error: { kind: 'browser_open_failed', message: scrubOpenExternalError(err) } },
          });
        });
      }
      break;
    case THEME_SERVICE_SIGN_OUT_WIRE:
      if (themeServiceHostInstance) void themeServiceHostInstance.handleSignOut();
      break;
    case THEME_SERVICE_BUY_CREDITS_WIRE: {
      const pack = String(themeServicePayload.pack || '');
      if (!pack) { console.log(`[tycoonagents-standalone] panel: ${THEME_SERVICE_BUY_CREDITS_WIRE} rejected: pack:too_small`); break; }
      if (themeServiceHostInstance) void themeServiceHostInstance.handleBuyCredits(pack);
      break;
    }
    case THEME_SERVICE_SET_REFERRAL_CODE_WIRE:
      if (themeServiceHostInstance) themeServiceHostInstance.handleSetReferralCode(themeServicePayload.code ? String(themeServicePayload.code) : undefined);
      break;
    case 'getSkills':
      // Standalone analog of panel.ts's _handleGetSkills (~line 3184-3211).
      // media/skills/catalog.json is a plain file read (no vscode APIs
      // involved) so, unlike getPacks/getEngineStatus above, the real
      // catalog is returned here rather than an honest-empty stub. main.js's
      // renderSkillsList (media/main.js:12837) reads msg.skills/msg.error the
      // same way regardless of host.
      broadcast('message', buildSkillsPayload());
      break;
    case 'getMcp':
      // Standalone analog of panel.ts's _handleGetMcp (~line 3384-3418).
      // media/mcp/catalog.json is likewise a plain file read; installed
      // status is computed against the primary project's .mcp.json exactly
      // like panel.ts's hasMcpServer() check.
      broadcast('message', buildMcpPayload());
      break;
    case 'REQUEST_PLAN':
      // Standalone analog of panel.ts's _postPlanState (~line 8029) — reuses
      // projectPlanMessages.mjs's postPlanState (already wired for
      // RESTORE_PLAN_BACKUP below), which reads the REAL
      // .claude/tycoon/plan.json via the compiled projectPlan.js bridge.
      postPlanState(primaryProjectRoot, broadcast);
      break;
    case 'APPROVE_PHASE':
      // Standalone analog of panel.ts's MSG.APPROVE_PHASE branch (~line
      // 2623) — projectPlanMessages.mjs's handleApprovePhase sets the gate
      // to "approved", writes plan.json + .bak, archives if complete, and
      // appends a gate-events.jsonl line with source:"standalone".
      handleApprovePhase(primaryProjectRoot, msg.phaseId, broadcast);
      break;
    case 'REQUEST_OFFLOAD_OFFER_STATE':
      // Standalone analog of panel.ts's _postOffloadOfferState (~line 8152).
      handlePostOffloadOfferState();
      break;
    case 'setDelegationMode':
      // Standalone analog of panel.ts's _handleSetDelegationMode (~line
      // 6112).
      handleSetDelegationModeStandalone(msg.delegation_mode);
      break;
    case 'setReviewEnabled':
      // Standalone analog of panel.ts's _handleSetReviewEnabled (~line
      // 6196).
      handleSetReviewEnabledStandalone(Boolean(msg.enabled));
      break;
    case 'setSessionJournalEntries':
      // Standalone analog of panel.ts's _handleSetSessionJournalEntries
      // (~line 6282).
      handleSetSessionJournalEntriesStandalone(Number(msg.entries));
      break;
    case 'SET_PROJECT_PLAN_ENABLED':
      // Standalone analog of panel.ts's MSG.SET_PROJECT_PLAN_ENABLED branch
      // (~line 2575).
      handleSetProjectPlanEnabledStandalone(Boolean(msg.enabled));
      break;
    case 'EXPORT_TEAM_SETUP': {
      // Standalone analog of panel.ts's _handleExportTeamSetup (p48-t3) —
      // assembles roster/routing/skills/mcp/delegation state and writes
      // .claude/tycoon-team.json via the shared, compiled teamSetupHost.js.
      const result = handleExportTeamSetupStandalone({
        requireCompiledOrThrow,
        repoRoot: REPO_ROOT,
        projectRoot: primaryProjectRoot,
        version: readRepoVersion(),
        harness: resolveEffectiveHarness(primaryProjectRoot || process.cwd()),
      });
      broadcast('message', { type: 'TEAM_SETUP_EXPORTED', payload: result });
      break;
    }
    case 'APPLY_TEAM_SETUP': {
      // Standalone analog of panel.ts's _handleApplyTeamSetup (p49-t1) —
      // re-runs installers from .claude/tycoon-team.json via the shared,
      // compiled teamSetupHost.js's applyTeamSetupHost().
      let delegationMode = 'flat';
      try {
        if (primaryProjectRoot) {
          const { readExecutionConfig } = delegationDoctrineModule();
          delegationMode = readExecutionConfig(path.join(primaryProjectRoot, '.claude')).delegation_mode === 'team_leads'
            ? 'team_leads'
            : 'flat';
        }
      } catch (err) {
        console.error('[tycoonagents-standalone] APPLY_TEAM_SETUP: readExecutionConfig failed:', err);
      }
      const result = handleApplyTeamSetupStandalone({
        requireCompiledOrThrow,
        repoRoot: REPO_ROOT,
        projectRoot: primaryProjectRoot,
        version: readRepoVersion(),
        delegationMode,
      });
      broadcast('message', { type: 'TEAM_SETUP_APPLIED', payload: result });
      break;
    }
    case 'CHECK_TEAM_READINESS': {
      // Standalone analog of panel.ts's _handleCheckTeamReadiness (p50-t2) —
      // builds a TeamReadinessReport from .claude/tycoon-team.json via the
      // shared, compiled teamSetupHost.js's buildTeamReadinessHost().
      handleCheckTeamReadinessStandalone({
        requireCompiledOrThrow,
        repoRoot: REPO_ROOT,
        projectRoot: primaryProjectRoot,
        probeReachability: !!payload.probeReachability,
      })
        .then((result) => broadcast('message', { type: 'TEAM_READINESS_REPORT', payload: result }))
        .catch((err) => {
          console.error('[tycoonagents-standalone] CHECK_TEAM_READINESS failed:', err);
          broadcast('message', { type: 'TEAM_READINESS_REPORT', payload: { ok: false, error: 'internal error' } });
        });
      break;
    }
    case 'GET_TEAM_SETUP_DRIFT': {
      // Standalone analog of panel.ts's _handleGetTeamSetupDrift (p50-t2).
      const result = handleGetTeamSetupDriftStandalone({
        requireCompiledOrThrow,
        repoRoot: REPO_ROOT,
        projectRoot: primaryProjectRoot,
      });
      broadcast('message', { type: 'TEAM_SETUP_DRIFT', payload: result });
      break;
    }
    // ── Submit feedback (spec: docs/FEEDBACK-PIPELINE-SPEC.md §5) ────────
    // Standalone analog of panel.ts's _handleSubmitFeedback /
    // _handleConfirmFeedbackSend (~line 7630, ~7702): same two-step
    // preview-then-send flow, same MSG.FEEDBACK_PREVIEW/FEEDBACK_RESULT
    // reply types media/main.js already expects (handleFeedbackPreview/
    // handleFeedbackResult, main.js:12507-12509), so main.js's feedback
    // wiring runs completely unmodified. `includeDiagnostics` is accepted
    // but never attaches a diagnosticMarkdown — the standalone has no
    // diagnostic-report generator wired up yet (out of scope for this
    // task); an honest ticket with no diagnostics block is safer than a
    // fabricated one. Every reply uses the same fire-and-forget
    // broadcast('message', ...) pattern as every other case in this switch.
    case 'submitFeedback':
      // NOTE: unlike THEME_MSG_WIRE cases above, main.js posts these fields
      // directly on the message object (vscode.postMessage({ type:
      // "submitFeedback", category, userDescription, ... })), not nested
      // under `payload` — read from `msg`, not `payload`, here.
      handleSubmitFeedback(broadcast, msg).catch((err) => {
        console.error('[tycoonagents-standalone] submitFeedback failed:', err);
      });
      break;
    case 'confirmFeedbackSend':
      handleConfirmFeedbackSend(broadcast, msg.ticketId).catch((err) => {
        console.error('[tycoonagents-standalone] confirmFeedbackSend failed:', err);
      });
      break;
    default:
      console.log('[tycoonagents-standalone] /message (unhandled):', JSON.stringify(msg));
  }
}

/**
 * SUBMIT_FEEDBACK handler — builds the exact v1 payload (adding a
 * `provider` field from resolveProviderId() and `host: "standalone"`, which
 * panel.ts's VS Code payload does not carry) and replies with a PREVIEW
 * only; no network call happens here. The body string is retained (see
 * _feedbackTicketBodies above) keyed by ticketId so CONFIRM_FEEDBACK_SEND
 * posts byte-identical bytes to what was previewed. Never throws outward —
 * `msg`'s payload is whatever the browser sent (a plain object, guarded
 * upstream in handleBrowserMessage), so a bad/missing field here degrades
 * to an honest error reply rather than crashing the server.
 */
async function handleSubmitFeedback(broadcastFn, msg) {
  const payload = msg;
  try {
    const category = ['bug', 'idea', 'question', 'other'].includes(payload.category)
      ? payload.category
      : 'other';
    const provider = resolveProviderId({ projectDir: primaryProjectRoot || process.cwd(), env: process.env });

    let context;
    if (primaryProjectRoot) {
      try {
        context = buildFeedbackContext(primaryProjectRoot, {
          host: 'standalone',
          effectiveHarness: provider,
          running: startupProviderId ?? null,
        });
      } catch (err) {
        console.error('[tycoonagents-standalone] buildFeedbackContext failed:', err instanceof Error ? err.message : err);
      }
    }

    const basePayload = buildFeedbackPayload(
      {
        category,
        userDescription: typeof payload.userDescription === 'string' ? payload.userDescription : '',
        contact: typeof payload.contact === 'string' ? payload.contact : '',
        // No diagnosticMarkdown: standalone has no diagnostic-report
        // generator wired up yet regardless of `includeDiagnostics`.
      },
      {
        roots: { projectRoot: primaryProjectRoot || null, homeDir: os.homedir(), extensionDir: REPO_ROOT },
        extensionVersion: readRepoVersion(),
        platform: process.platform,
        hostAppName: 'standalone',
        context,
      },
    );
    // `provider` kept for backward compatibility; `host`/`harness`/`routing`/
    // `agents` now come from the shared buildFeedbackContext() builder above
    // (spec addendum 2026-09-06) via basePayload.
    const fullPayload = { ...basePayload, provider, host: basePayload.host ?? 'standalone' };

    const bodyString = JSON.stringify(fullPayload, null, 2);
    _pruneFeedbackTickets();
    _feedbackTicketBodies.set(fullPayload.ticketId, { body: bodyString, storedAt: Date.now() });
    broadcastFn('message', { type: 'feedbackPreview', ticketId: fullPayload.ticketId, payloadJson: bodyString });
  } catch (err) {
    console.error('[tycoonagents-standalone] could not build feedback preview:', err);
  }
}

/**
 * CONFIRM_FEEDBACK_SEND handler — the ONLY message that triggers the real
 * network POST. Looks up the retained body for ticketId; an unknown/expired
 * id fails safe (feedbackResult ok:false, no network call). On success the
 * entry is deleted (single-use, matching panel.ts) so a succeeded ticket
 * can never be resent. On failure (timeout, network error, non-2xx) the
 * entry is RETAINED so the webview's "Retry Send" can resend the same
 * ticketId — main.js already renders the fallback URL text itself
 * (handleFeedbackResult, main.js:16022-16024: "...use the fallback form:
 * https://feedback.corsairstudios.com"), so the reply here only needs
 * ok:false + error; no browser-open / fallback-URL message type is needed.
 * Never throws outward.
 */
async function handleConfirmFeedbackSend(broadcastFn, ticketId) {
  const entry = _feedbackTicketBodies.get(ticketId);
  const bodyString = entry?.body;
  if (bodyString === undefined) {
    broadcastFn('message', {
      type: 'feedbackResult',
      ok: false,
      ticketId,
      error: 'This feedback preview has expired — please rebuild it and try again.',
    });
    return;
  }
  try {
    const result = await postFeedback(bodyString, getFeedbackEndpoint(), fetch);
    if (result.ok) {
      _feedbackTicketBodies.delete(ticketId);
      broadcastFn('message', { type: 'feedbackResult', ok: true, ticketId });
      return;
    }
    broadcastFn('message', { type: 'feedbackResult', ok: false, ticketId, error: result.error });
  } catch (err) {
    // postFeedback() is documented never to throw, but guard anyway — a
    // thrown error here must still resolve to an honest feedbackResult
    // reply, never an unhandled rejection that leaves the browser hanging.
    broadcastFn('message', {
      type: 'feedbackResult',
      ok: false,
      ticketId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * p66-t1 review fix: a thrown Google sign-in handler error's `.message` can
 * echo the authorize URL (which carries a PKCE code_challenge) — never
 * logged or broadcast verbatim on the openExternal paths. Only a fixed
 * message plus the error's constructor name.
 */
function scrubOpenExternalError(err) {
  const ctor = err instanceof Error ? err.constructor.name : typeof err;
  return `couldn't open the browser for sign-in (${ctor})`;
}

/** Reads `<repo>/package.json`'s `version` field; `'unknown'` if unreadable — matches buildFeedbackPayload()'s own `ctx.extensionVersion ?? 'unknown'` fallback. */
function readRepoVersion() {
  try {
    const pkgRaw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    return JSON.parse(pkgRaw).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Standalone analog of panel.ts's _handleGetSkills (~line 3184-3211).
 * media/skills/catalog.json entries: { id, name, description, mcpNote?,
 * thirdParty?, source? }. `installed` mirrors panel.ts exactly: true when the
 * primary project has a `.claude/skills/<id>` directory.
 */
function buildSkillsPayload() {
  const catalogPath = path.join(MEDIA_DIR, 'skills', 'catalog.json');
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const { catalogSummary } = catalogSummaryModule();
    const skills = catalog.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      summary: catalogSummary(entry),
      mcpNote: entry.mcpNote,
      thirdParty: entry.thirdParty,
      source: entry.source,
      installed:
        !!primaryProjectRoot &&
        fs.existsSync(path.join(primaryProjectRoot, '.claude', 'skills', entry.id)),
    }));
    return { type: 'skills', skills };
  } catch (err) {
    return { type: 'skills', skills: [], error: String(err) };
  }
}

/**
 * Standalone analog of panel.ts's _handleGetMcp (~line 3384-3418) +
 * _loadMcpCatalog/_readMcpConfig/hasMcpServer (src/host/vscode/mcpCatalog.ts).
 * `installed` is true when the primary project's `.mcp.json` has a
 * `mcpServers[id]` entry.
 */
function buildMcpPayload() {
  const catalogPath = path.join(MEDIA_DIR, 'mcp', 'catalog.json');
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    return { type: 'mcp', servers: [], error: String(err) };
  }

  let mcpConfig = {};
  if (primaryProjectRoot) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(primaryProjectRoot, '.mcp.json'), 'utf8'),
      );
      if (parsed !== null && typeof parsed === 'object') mcpConfig = parsed;
    } catch {
      /* missing/invalid => default {} — mirrors panel.ts's _readMcpConfig */
    }
  }
  const servers = mcpConfig.mcpServers;
  const hasMcpServer = (id) =>
    servers !== null && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, id);
  const { catalogSummary } = catalogSummaryModule();

  return {
    type: 'mcp',
    servers: catalog.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      summary: catalogSummary(e),
      installed: hasMcpServer(e.id),
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
    })),
  };
}

/**
 * Standalone analog of panel.ts's _handleGetPacks (src/host/vscode/panel.ts
 * ~line 3626-3686) and its _buildPackDisclosures helper. Reads the same
 * three catalogs (media/packs/catalog.json, media/mcp/catalog.json,
 * media/skills/catalog.json) and computes `installed`/`disclosures` against
 * `primaryProjectRoot` exactly like the VS Code host does. Returns the same
 * per-pack shape main.js's renderPacksList/describePackageInstalls expect.
 */
function buildPacksPayload() {
  const packsPath = path.join(MEDIA_DIR, 'packs', 'catalog.json');
  let packs;
  try {
    packs = JSON.parse(fs.readFileSync(packsPath, 'utf8'));
  } catch (err) {
    return { type: 'packs', packs: [], error: String(err) };
  }
  let mcpCatalog = [];
  try {
    mcpCatalog = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'mcp', 'catalog.json'), 'utf8'));
  } catch {
    mcpCatalog = [];
  }
  const skillNames = {};
  try {
    const skillsCatalog = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'skills', 'catalog.json'), 'utf8'));
    for (const s of skillsCatalog) {
      if (s && typeof s.id === 'string') skillNames[s.id] = typeof s.name === 'string' ? s.name : s.id;
    }
  } catch {
    /* skillNames stays {} */
  }
  const root = primaryProjectRoot || '';
  let mcpConfig = {};
  if (root) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
      if (parsed !== null && typeof parsed === 'object') mcpConfig = parsed;
    } catch {
      /* missing/invalid => default {} */
    }
  }
  const { hasMcpServer } = mcpCatalogModule();
  const skillInstalled = (id) => !!root && fs.existsSync(path.join(root, '.claude', 'skills', id));
  const agentInstalled = (id) => !!root && fs.existsSync(path.join(root, '.claude', 'agents', `${id}.md`));

  const result = packs.map((pack) => {
    const disclosures = [];
    if (pack && pack.mcp) {
      const m = mcpCatalog.find((x) => x.id === pack.mcp);
      if (m && m.thirdParty) {
        disclosures.push({ label: m.name, vendor: m.vendor, package: m.package, homepage: m.homepage, network: m.network, dataNote: m.dataNote });
      }
    }
    const packSkills = Array.isArray(pack.skills) ? pack.skills : [];
    const packCommands = Array.isArray(pack.commands) ? pack.commands : [];
    const packAgents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
    const skills = packSkills.map((id) => ({ id, name: skillNames[id] ?? id, installed: skillInstalled(id) }));
    const mcpEntry = pack.mcp ? mcpCatalog.find((x) => x.id === pack.mcp) : undefined;
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      summary: catalogSummaryModule().catalogSummary(pack),
      has: { skill: packSkills.length > 0, mcp: !!pack.mcp, agent: true },
      installed: {
        skill: packSkills.length > 0 && packSkills.every((id) => skillInstalled(id)),
        mcp: pack.mcp ? hasMcpServer(mcpConfig, pack.mcp) : false,
        agent: root !== '' && packAgents.length > 0 && packAgents.every((a) => agentInstalled(a.id)),
      },
      skills,
      commands: packCommands,
      agents: packAgents.map((a) => ({ id: a.id, name: a.name })),
      mcpName: mcpEntry ? (mcpEntry.name ?? pack.mcp) : undefined,
      thirdParty: disclosures.length > 0,
      disclosures,
    };
  });
  return { type: 'packs', packs: result };
}

/**
 * Standalone analog of panel.ts's `_stageSkillTree` (~line 4284-4340):
 * content-diff recursive copy from media/skills/<skillId> into
 * `<root>/.claude/skills/<skillId>`. Never throws — per-file failures are
 * collected into `failed` instead.
 */
function stageSkillTreeStandalone(skillId, root) {
  const src = path.join(MEDIA_DIR, 'skills', skillId);
  const dest = path.join(root, '.claude', 'skills', skillId);
  let staged = 0;
  let updated = 0;
  let unchanged = 0;
  const failed = [];
  const copyRecursive = (srcDir, destDir) => {
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch (e) {
      failed.push({ path: srcDir, error: String(e) });
      return;
    }
    for (const entry of entries) {
      if (entry.name === '__pycache__') continue;
      if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) continue;
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
        failed.push({ path: destPath, error: String(e) });
      }
    }
  };
  copyRecursive(src, dest);
  return { staged, updated, unchanged, failed };
}

/**
 * Standalone analog of panel.ts's `_installPackCommands` (~line 3734-3763):
 * content-diff copy of media/commands/<id>.md into
 * `<root>/.claude/commands/<id>.md`.
 */
function installPackCommandsStandalone(root, packCommands) {
  const results = [];
  for (const commandId of packCommands) {
    try {
      const target = path.join(root, '.claude', 'commands', `${commandId}.md`);
      const src = path.join(MEDIA_DIR, 'commands', `${commandId}.md`);
      const srcContent = fs.readFileSync(src, 'utf8');
      let destContent;
      try {
        destContent = fs.readFileSync(target, 'utf8');
      } catch {
        destContent = undefined;
      }
      if (destContent === undefined) {
        fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
        fs.writeFileSync(target, srcContent);
        results.push({ id: commandId, status: 'installed' });
      } else if (destContent !== srcContent) {
        fs.writeFileSync(target, srcContent);
        results.push({ id: commandId, status: 'updated' });
      } else {
        results.push({ id: commandId, status: 'unchanged' });
      }
    } catch (e) {
      results.push({ id: commandId, status: 'error', error: String(e) });
    }
  }
  return results;
}

/**
 * Standalone analog of panel.ts's `_readKeywordsConfig` (~line 6362-6373).
 */
function readKeywordsConfigStandalone(root) {
  const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(keywordsPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    /* missing/invalid => default */
  }
  return { fallback_agent: 'primary-agent', agents: {} };
}

/**
 * p68-t1 review fix: standalone analog of panel.ts's `atomicWriteFileSync` —
 * write to a temp file in the same directory, then rename over the target,
 * so a concurrent reader never observes a partially-written
 * agent-keywords.json.
 */
function atomicWriteFileSyncStandalone(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Standalone analog of panel.ts's `_postKeywordHealth` (p68-t1): reads
 * `.claude/agents/*.md` + agent-keywords.json, runs computeKeywordHealth,
 * and this session's wildcard/unmatched-word stats via activity.jsonl
 * filtered to the current sessionId. Returns the KEYWORD_HEALTH payload
 * shape directly (no broadcast — callers broadcast it).
 */
function buildKeywordHealthPayload(root) {
  const agentsDir = path.join(root, '.claude', 'agents');
  let agentIds = [];
  try {
    agentIds = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    agentIds = [];
  }
  const { parseAgentKeywords } = agentKeywordDefaultsModule();
  const { computeKeywordHealth, computeWildcardStats } = keywordHealthModule();
  const agents = agentIds.map((id) => {
    let content = '';
    try {
      content = fs.readFileSync(path.join(agentsDir, `${id}.md`), 'utf8');
    } catch {
      content = '';
    }
    return { id, keywords: parseAgentKeywords(content) };
  });

  const config = readKeywordsConfigStandalone(root);
  const findings = computeKeywordHealth(agents, config);

  const knownTokens = new Set();
  const configAgents = config && typeof config.agents === 'object' && config.agents !== null ? config.agents : {};
  for (const entry of Object.values(configAgents)) {
    const pattern = entry && typeof entry.pattern === 'string' ? entry.pattern : '';
    for (const seg of pattern.split('|')) {
      const t = seg.trim().toLowerCase();
      if (t !== '') knownTokens.add(t);
    }
  }

  let wildcardTasksThisSession = 0;
  let unmatchedWords = [];
  try {
    const raw = fs.readFileSync(path.join(root, '.claude', 'tycoon', 'activity.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const records = [];
    let sessionId;
    for (let i = lines.length - 1; i >= 0 && sessionId === undefined; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
      } catch {
        /* skip malformed line */
      }
    }
    if (sessionId !== undefined) {
      for (const l of lines) {
        try {
          const rec = JSON.parse(l);
          if (rec && rec.sessionId === sessionId) records.push(rec);
        } catch {
          /* skip malformed line */
        }
      }
      const stats = computeWildcardStats(records, knownTokens);
      wildcardTasksThisSession = stats.wildcardTasksThisSession;
      unmatchedWords = stats.unmatchedWords;
    }
  } catch {
    /* activity.jsonl missing/unreadable -> zeros */
  }

  return { findings, wildcardTasksThisSession, unmatchedWords };
}

/**
 * Standalone analog of panel.ts's `_resolveConfigTokens` (~line 4391-4406):
 * substitutes the `${EXTENSION_DIR}` token an MCP catalog entry's config may
 * contain with the repo root (the standalone's analog of the extension's
 * install directory — media/ is served straight out of REPO_ROOT/media, see
 * MEDIA_DIR above), forward-slashing the result the same way.
 */
function resolveConfigTokensStandalone(config) {
  const EXTENSION_TOKEN = '${EXTENSION_DIR}';
  const resolve = (value) => {
    if (typeof value === 'string') {
      let out = value;
      let substituted = false;
      if (out.includes(EXTENSION_TOKEN)) {
        out = out.split(EXTENSION_TOKEN).join(REPO_ROOT);
        substituted = true;
      }
      return substituted ? out.replace(/\\/g, '/') : out;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v);
      return out;
    }
    return value;
  };
  return resolve(config);
}

/**
 * Standalone analog of panel.ts's `_handleInstallPack` (~line 3768-3982).
 * Installs a pack's skills, commands, MCP server entry, and agent files
 * against `primaryProjectRoot`, using the SAME compiled pure helpers panel.ts
 * uses (buildAgentMarkdown/agentMarkdownHasTycoonMarker from packCatalog.js,
 * mergeMcpServer/hasMcpServer from mcpCatalog.js, setKeywordPattern from
 * agentConfig.js) so a standalone install produces byte-identical agent
 * files and MCP config to a VS Code install.
 *
 * NOT replicated (require the VS Code extension host, no equivalent exists
 * in a headless server — these are documented no-ops rather than silent
 * omissions):
 *   - the native third-party-disclosure confirm modal (`thirdParty`/
 *     `disclosures` payload fields are accepted but ignored — a headless
 *     server has no interactive confirm channel, so install proceeds
 *     directly, same as passing `thirdParty:false` would in the VS Code host)
 *   - the UEFN generic-agent-conflict warning + auto-removal
 *     (uefnConflictIds / conflictingUefnAgents) — left for a future task if
 *     the standalone ever ships the UEFN pack's conflict UX.
 */
function handleInstallPack(payload) {
  const id = payload && payload.id;
  try {
    const packsPath = path.join(MEDIA_DIR, 'packs', 'catalog.json');
    const packs = JSON.parse(fs.readFileSync(packsPath, 'utf8'));
    const pack = packs.find((p) => p.id === id);
    if (!pack) {
      broadcast('message', { type: 'packInstalled', id, ok: false, error: 'Unknown pack' });
      return;
    }
    const root = primaryProjectRoot;
    if (!root) {
      broadcast('message', { type: 'packInstalled', id, ok: false, error: 'No project root resolved' });
      return;
    }

    const results = {};
    const packSkills = Array.isArray(pack.skills) ? pack.skills : [];
    if (packSkills.length > 0) {
      results.skills = packSkills.map((skillId) => {
        try {
          const { staged, updated, failed } = stageSkillTreeStandalone(skillId, root);
          return {
            id: skillId,
            status: staged > 0 ? 'installed' : updated > 0 ? 'updated' : 'unchanged',
            ...(failed.length > 0 ? { error: failed.map((f) => `${f.path}: ${f.error}`).join('; ') } : {}),
          };
        } catch (e) {
          return { id: skillId, status: 'unchanged', error: String(e) };
        }
      });
    }
    const packCommands = Array.isArray(pack.commands) ? pack.commands : [];
    if (packCommands.length > 0) {
      results.commands = installPackCommandsStandalone(root, packCommands);
    }
    if (pack.mcp) {
      const { hasMcpServer, mergeMcpServer, resolveConfigForPlatform, withDispatcherProjectDir } = mcpCatalogModule();
      let mcpCatalog = [];
      try {
        mcpCatalog = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'mcp', 'catalog.json'), 'utf8'));
      } catch {
        mcpCatalog = [];
      }
      const entry = mcpCatalog.find((x) => x.id === pack.mcp);
      if (entry === undefined) {
        throw new Error(`MCP catalog entry not found for id: ${pack.mcp}`);
      }
      const mcpPath = path.join(root, '.mcp.json');
      let existing = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        if (parsed !== null && typeof parsed === 'object') existing = parsed;
      } catch {
        existing = {};
      }
      if (hasMcpServer(existing, pack.mcp)) {
        results.mcp = 'exists';
      } else {
        const platformConfig = resolveConfigForPlatform(entry, process.platform);
        const resolvedConfig = platformConfig.ok ? resolveConfigTokensStandalone(platformConfig.config) : undefined;
        if (!platformConfig.ok) {
          results.mcp = { status: 'skipped', error: platformConfig.error };
        } else if (/<[^<>]*>/.test(JSON.stringify(resolvedConfig))) {
          results.mcp = {
            status: 'skipped',
            error:
              `${pack.mcp} is provided by Trashbyrd's Power Tools — install it separately and add the entry to ` +
              'your own .mcp.json; see .mcp.json.example.',
          };
        } else {
          const finalConfig = withDispatcherProjectDir(pack.mcp, resolveCodexBinaryForInstallStandalone(pack.mcp, resolvedConfig), primaryProjectRoot);
          const merged = mergeMcpServer(existing, pack.mcp, finalConfig);
          fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
          results.mcp = 'installed';
        }
      }
    }

    const { buildAgentMarkdown, agentMarkdownHasTycoonMarker } = packCatalogModule();
    const { setKeywordPattern } = agentConfigModule();
    const agents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
    const agentResults = [];
    let cfg = readKeywordsConfigStandalone(root);
    for (const a of agents) {
      try {
        const agentsDir = path.join(root, '.claude', 'agents');
        const agentPath = path.join(agentsDir, `${a.id}.md`);
        const generated = buildAgentMarkdown(a, pack.id);
        if (!fs.existsSync(agentPath)) {
          fs.mkdirSync(agentsDir, { recursive: true });
          fs.writeFileSync(agentPath, generated);
          agentResults.push({ id: a.id, status: 'created' });
        } else {
          const existingContent = fs.readFileSync(agentPath, 'utf8');
          if (agentMarkdownHasTycoonMarker(existingContent)) {
            if (existingContent === generated) {
              agentResults.push({ id: a.id, status: 'unchanged' });
            } else {
              fs.writeFileSync(agentPath, generated);
              agentResults.push({ id: a.id, status: 'refreshed' });
            }
          } else {
            const backupPath = `${agentPath}.bak`;
            if (!fs.existsSync(backupPath)) {
              fs.writeFileSync(backupPath, existingContent);
            }
            fs.writeFileSync(agentPath, generated);
            agentResults.push({ id: a.id, status: 'replaced-legacy' });
          }
        }
      } catch (e) {
        agentResults.push({ id: a.id, status: 'error', error: String(e) });
      }
      cfg = setKeywordPattern(cfg, a.id, a.keywords);
    }
    results.agents = agentResults;
    const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
    fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
    fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));

    broadcast('message', { type: 'packInstalled', id, ok: true, results });
  } catch (e) {
    broadcast('message', { type: 'packInstalled', id, ok: false, error: String(e) });
  }
}

/**
 * Standalone analog of panel.ts's `_buildDoctrineRoster` (~line 5562-5623):
 * derives the CLAUDE.md "Specialist roster" table rows from the project's
 * ACTUAL `.claude/agents/*.md` files + `agent-keywords.json` routing, using
 * the same compiled pure helpers (agentRoster.js's loadAgentRoster,
 * packCatalog.js's agentMarkdownTier, agentBackend.js's
 * readAgentFrontmatter/parseAgentBackend, delegationDoctrine.js's
 * formatVendorModelLabel). Returns `[]` (triggering
 * renderDelegationDoctrine's hardcoded default) when the agents dir is
 * missing/empty, same as panel.ts.
 */
function buildDoctrineRosterStandalone(root) {
  const agentsDir = path.join(root, '.claude', 'agents');
  const { loadAgentRoster } = agentRosterModule();
  const rosterFiles = loadAgentRoster(agentsDir);
  if (rosterFiles.length === 0) return [];

  const keywordsConfig = readKeywordsConfigStandalone(root);
  const keywordAgents =
    keywordsConfig && typeof keywordsConfig.agents === 'object' && keywordsConfig.agents !== null
      ? keywordsConfig.agents
      : {};
  const EXCLUDED_IDS = new Set(['orchestrator', 'primary-agent']);
  const { agentMarkdownTier } = packCatalogModule();
  const { formatVendorModelLabel } = delegationDoctrineModule();
  const { readAgentFrontmatter, parseAgentBackend } = agentBackendModule();

  const rows = [];
  for (const agent of rosterFiles) {
    if (EXCLUDED_IDS.has(agent.id)) continue;

    let agentText;
    try {
      agentText = fs.readFileSync(path.join(agentsDir, `${agent.id}.md`), 'utf8');
    } catch {
      agentText = undefined;
    }

    let tier;
    try {
      tier = agentText !== undefined ? agentMarkdownTier(agentText) : undefined;
    } catch {
      tier = undefined;
    }
    if (tier === 'lead' || tier === 'reviewer') continue;

    const entry = keywordAgents[agent.id];
    const pattern = entry && typeof entry.pattern === 'string' ? entry.pattern.trim() : '';
    const taskTypes =
      pattern !== ''
        ? pattern.split('|').map((s) => s.trim()).filter(Boolean).join(', ')
        : agent.description ?? 'General tasks';

    let vendorLabel;
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
 * Standalone analog of panel.ts's `_resolveReviewAgentId` (~line 5642-5649).
 * Falls back to `uefn-auditor` only when this project is detected as UEFN
 * (via uefnDetectModule's detectUefnProject), so a non-UEFN project that
 * merely has the UEFN pack installed is not routed to `uefn-auditor` for
 * review.
 */
function resolveReviewAgentIdStandalone(root) {
  const agentsDir = path.join(root, '.claude', 'agents');
  const { loadAgentRoster } = agentRosterModule();
  const rosterFiles = loadAgentRoster(agentsDir);
  const hasId = (id) => rosterFiles.some((a) => a.id === id);
  if (hasId('reviewer')) return 'reviewer';
  if (hasId('uefn-auditor')) {
    const { detectUefnProject } = uefnDetectModule();
    if (detectUefnProject(root).detected) return 'uefn-auditor';
  }
  return undefined;
}

/** Standalone analog of panel.ts's `_installAgentFiles` (~line 5918-5945). */
function installAgentFilesStandalone(root, agentsToInstall) {
  const { buildAgentMarkdown, agentMarkdownTier } = packCatalogModule();
  const { setKeywordPattern } = agentConfigModule();
  let cfg = readKeywordsConfigStandalone(root);
  for (const a of agentsToInstall) {
    const agentPath = path.join(root, '.claude', 'agents', `${a.id}.md`);
    try {
      if (!fs.existsSync(agentPath)) {
        fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
        fs.writeFileSync(agentPath, buildAgentMarkdown(a));
      } else {
        const existing = fs.readFileSync(agentPath, 'utf8');
        let existingTier;
        try {
          existingTier = agentMarkdownTier(existing);
        } catch {
          existingTier = undefined;
        }
        if (existingTier === a.tier) {
          const desired = buildAgentMarkdown(a);
          if (existing !== desired) fs.writeFileSync(agentPath, desired);
        }
        // else: foreign/legacy same-named file — never overwritten.
      }
    } catch {
      /* best-effort per-file; keyword routing still proceeds below */
    }
    cfg = setKeywordPattern(cfg, a.id, a.keywords);
  }
  const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
  fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
  fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
}

/** Standalone analog of panel.ts's `_removeAgentFiles` (~line 5965-5997). */
function removeAgentFilesStandalone(root, agentsToRemove, expectedTier) {
  const { agentMarkdownTier } = packCatalogModule();
  const { removeKeywordPattern } = agentConfigModule();
  for (const a of agentsToRemove) {
    const agentPath = path.join(root, '.claude', 'agents', `${a.id}.md`);
    if (fs.existsSync(agentPath)) {
      let tier;
      try {
        tier = agentMarkdownTier(fs.readFileSync(agentPath, 'utf8'));
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
  let cfg = readKeywordsConfigStandalone(root);
  for (const a of agentsToRemove) cfg = removeKeywordPattern(cfg, a.id);
  const keywordsPath = path.join(root, '.claude', 'tycoon', 'agent-keywords.json');
  try {
    fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
    fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
  } catch {
    /* best-effort: keywords file is non-critical for removal */
  }
}

function installLeadAgentsStandalone(root) {
  installAgentFilesStandalone(root, packCatalogModule().LEAD_AGENTS);
}
function removeLeadAgentsStandalone(root) {
  removeAgentFilesStandalone(root, packCatalogModule().LEAD_AGENTS, 'lead');
}
function installReviewerAgentStandalone(root) {
  installAgentFilesStandalone(root, packCatalogModule().REVIEWER_AGENTS);
}
function removeReviewerAgentStandalone(root) {
  removeAgentFilesStandalone(root, packCatalogModule().REVIEWER_AGENTS, 'reviewer');
}

/** Standalone analog of panel.ts's (unexported) `readProjectPlanEnabled` (default ON). */
function readProjectPlanEnabledStandalone(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'tycoon', 'execution.json'), 'utf8'));
    // Default ON: only an explicit `false` disables Project Plan.
    if (parsed !== null && typeof parsed === 'object') return parsed.projectPlanEnabled !== false;
    return true;
  } catch {
    return true;
  }
}

/** True when execution.json carries an explicit boolean `projectPlanEnabled`. */
function projectPlanFlagIsExplicitStandalone(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'tycoon', 'execution.json'), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && typeof parsed.projectPlanEnabled === 'boolean';
  } catch {
    return false;
  }
}

/**
 * Standalone analog of panel.ts's `_settingsReferencesHook`/
 * `_hooksInstalledForRoot` (~line 4627-4671) — used only to gate the
 * CLAUDE.md refresh SET_PROJECT_PLAN_ENABLED performs, exactly like
 * panel.ts gates it.
 */
function settingsReferencesHookStandalone(settingsPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return false;
  }
  const hooks = parsed && typeof parsed === 'object' ? parsed.hooks : undefined;
  if (hooks === undefined || hooks === null || typeof hooks !== 'object') return false;
  for (const eventKey of Object.keys(hooks)) {
    const entries = hooks[eventKey];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = entry && typeof entry === 'object' ? entry.hooks : undefined;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = h && typeof h === 'object' ? h.command : undefined;
        if (typeof cmd === 'string' && cmd.includes('tycoon-claude-hook.cjs')) return true;
      }
    }
  }
  return false;
}
function hooksInstalledForRootStandalone(root) {
  return (
    settingsReferencesHookStandalone(path.join(root, '.claude', 'settings.local.json')) ||
    settingsReferencesHookStandalone(path.join(root, '.claude', 'settings.json'))
  );
}

/**
 * Standalone analog of panel.ts's `_buildClaudeMdDoctrine` (~line 5664-
 * 5684): full managed CLAUDE.md doctrine (delegation section + code-rules
 * section), splicing into `existingContent`.
 */
function buildClaudeMdDoctrineStandalone(existingContent, mode, reviewEnabled, root, sessionJournalEntries = 0) {
  const { renderDelegationDoctrine, upsertDelegationSection } = delegationDoctrineModule();
  const { renderCodeRules, upsertCodeRulesSection } = codeRulesDoctrineModule();
  const { detectUefnProject } = uefnDetectModule();
  const roster = buildDoctrineRosterStandalone(root);
  const isUefn = detectUefnProject(root).detected;
  const reviewAgentId = resolveReviewAgentIdStandalone(root);
  const projectPlanEnabled = readProjectPlanEnabledStandalone(root);
  const withDelegation = upsertDelegationSection(
    existingContent,
    renderDelegationDoctrine(mode, reviewEnabled, roster, reviewAgentId, sessionJournalEntries, projectPlanEnabled),
  );
  return upsertCodeRulesSection(withDelegation, renderCodeRules(isUefn));
}

/**
 * Standalone analog of the delegation-section-only CLAUDE.md refresh
 * `_handleSetDelegationMode`/`_handleSetReviewEnabled`/
 * `_handleSetSessionJournalEntries` each perform directly (NOT via
 * `_buildClaudeMdDoctrine` — those three handlers upsert ONLY the
 * `<!-- tycoon:delegation -->` section, never the code-rules section; only
 * the SET_PROJECT_PLAN_ENABLED path touches code rules too). Returns a
 * `claudeMdError` string on failure, `undefined` on success — mirrors
 * panel.ts's `claudeMdError` field exactly.
 */
function refreshDelegationSectionStandalone(root, mode, reviewEnabled, sessionJournalEntries) {
  const { renderDelegationDoctrine, upsertDelegationSection } = delegationDoctrineModule();
  try {
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    let existingClaudeMd = null;
    try {
      existingClaudeMd = fs.readFileSync(claudeMdPath, 'utf8');
    } catch {
      existingClaudeMd = null;
    }
    const updated = upsertDelegationSection(
      existingClaudeMd,
      renderDelegationDoctrine(
        mode,
        reviewEnabled,
        buildDoctrineRosterStandalone(root),
        resolveReviewAgentIdStandalone(root),
        sessionJournalEntries,
        readProjectPlanEnabledStandalone(root),
      ),
    );
    fs.writeFileSync(claudeMdPath, updated);
    return undefined;
  } catch (err) {
    return String(err);
  }
}

/**
 * Standalone analog of panel.ts's `_handleGetSettings` payload (~line 6888-
 * 6908 `MSG.SETTINGS`). `delegation_mode`/`reviewEnabled`/
 * `sessionJournalEntries` are read from the SAME `.claude/tycoon/
 * execution.json` the VS Code host reads/writes (via delegationDoctrine.js's
 * `readExecutionConfig`, defaults matching panel.ts's own `?? true`/`?? 0`).
 * `agents` is populated from the project's `.claude/agents/*.md` roster via
 * the same `loadAgentRoster` + `shortFromModelId` + keyword-config lookup
 * panel.ts's `_handleGetSettings` uses. `delegationHealth`/`hookHealth`/
 * `contextBudget`/`foreignManagedBlocks` remain honest "nothing to show"
 * stubs — no per-project hook-diagnostic pass or context-budget scan is
 * wired up in the standalone yet (out of this task's scope).
 */
function buildStandaloneSettingsPayload() {
  let lastActivityAt = null;
  if (primaryProjectRoot) {
    try {
      lastActivityAt = fs.statSync(
        path.join(primaryProjectRoot, '.claude', 'tycoon', 'activity.jsonl'),
      ).mtimeMs;
    } catch {
      lastActivityAt = null;
    }
  }

  let delegation_mode = 'flat';
  let reviewEnabled = true;
  let sessionJournalEntries = 0;
  let agents = [];
  if (primaryProjectRoot) {
    try {
      const { readExecutionConfig } = delegationDoctrineModule();
      const execCfg = readExecutionConfig(path.join(primaryProjectRoot, '.claude'));
      delegation_mode = execCfg.delegation_mode;
      reviewEnabled = execCfg.reviewEnabled ?? true;
      sessionJournalEntries = execCfg.sessionJournalEntries ?? 0;
    } catch (err) {
      console.error('[tycoonagents-standalone] buildStandaloneSettingsPayload: readExecutionConfig failed:', err);
    }
    try {
      const { loadAgentRoster } = agentRosterModule();
      const { shortFromModelId } = agentConfigModule();
      const agentsDir = path.join(primaryProjectRoot, '.claude', 'agents');
      const keywordsConfig = readKeywordsConfigStandalone(primaryProjectRoot);
      const keywordAgents =
        keywordsConfig && typeof keywordsConfig.agents === 'object' && keywordsConfig.agents !== null
          ? keywordsConfig.agents
          : {};
      // p18-t1: route-derived fields, keyed by agent id, from the SAME
      // shared helper panel.ts uses so both hosts agree.
      let agentRoutes = {};
      try {
        const { describeAgentRoutes } = agentSettingsRouteModule();
        agentRoutes = describeAgentRoutes(primaryProjectRoot);
      } catch (err) {
        console.error('[tycoonagents-standalone] buildStandaloneSettingsPayload: describeAgentRoutes failed:', err);
      }
      agents = loadAgentRoster(agentsDir).map((agent) => {
        const entry = keywordAgents[agent.id];
        const keywords = entry && typeof entry.pattern === 'string' ? entry.pattern : '';
        const route = agentRoutes[agent.id];
        return {
          id: agent.id,
          name: agent.name,
          // `model` reflects the RESOLVED route's Claude tier, falling back
          // to the roster's raw frontmatter when describeAgentRoutes didn't
          // see this agent — mirrors panel.ts's _handleGetSettings.
          model: route?.claudeTier ?? shortFromModelId(agent.model) ?? null,
          isOrchestrator: agent.id === 'orchestrator',
          keywords,
          resolvedModel: route?.resolvedModel ?? null,
          vendor: route?.vendor ?? null,
          costModelClass: route?.costModelClass ?? null,
          claudeTier: route?.claudeTier ?? null,
          routeSource: route?.routeSource ?? 'frontmatter',
          handWrittenBackend: route?.handWrittenBackend ?? false,
        };
      });
    } catch (err) {
      console.error('[tycoonagents-standalone] buildStandaloneSettingsPayload: agent roster read failed:', err);
      agents = [];
    }
  }

  return {
    hook: { installed: true, lastActivityAt },
    agents,
    delegation_mode,
    reviewEnabled,
    sessionJournalEntries,
    delegationHealth: {
      directSearches: 0,
      directReads: 0,
      directEdits: 0,
      delegations: 0,
      tokens: 0,
      session: null,
      sessionId: null,
    },
    hookHealth: { healthy: true, issueCount: 0 },
    contextBudget: null,
    foreignManagedBlocks: [],
    harness: buildStandaloneHarnessSettings(),
    routing: buildStandaloneRoutingVisibility(),
  };
}

/**
 * Standalone analog of panel.ts's `_buildRoutingVisibility` (p18-t1): whether
 * the Routing screen should surface itself, and why. Uses the same
 * describeProviderSelection call buildStandaloneHarnessSettings already
 * makes so the two slices never disagree.
 */
function buildStandaloneRoutingVisibility() {
  const cwd = primaryProjectRoot || process.cwd();
  const fallback = { visible: false, reason: 'hidden', useMultipleLlms: false, profileActive: false, routedAgentCount: 0 };
  if (!primaryProjectRoot) return fallback;
  try {
    const { describeRoutingVisibility } = agentSettingsRouteModule();
    return describeRoutingVisibility(cwd, resolveEffectiveHarness(cwd));
  } catch (err) {
    console.error('[tycoonagents-standalone] buildStandaloneRoutingVisibility failed:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * Shared effective-harness resolution for saveRoutingProfile callers
 * (p20-t1) — mirrors panel.ts's _resolveEffectiveHarness. Falls back to
 * 'claude-code' on any error so a save is never blocked by an unrelated
 * failure here.
 */
function resolveEffectiveHarness(cwd) {
  try {
    const { describeProviderSelection } = providerSelectionModule();
    return describeProviderSelection({ cwd }).effective;
  } catch {
    return 'claude-code';
  }
}

/**
 * Standalone analog of panel.ts's _buildHarnessSettings (p13-t7). The
 * standalone process never has a VS Code `tycoonagents.provider` setting,
 * so only TYCOON_PROVIDER (set directly, or by cli.mjs's --provider flag —
 * see parseWatchArgs) and the execution.json `provider` key are in play.
 */
function buildStandaloneHarnessSettings() {
  const { describeProviderSelection } = providerSelectionModule();
  const cwd = primaryProjectRoot || process.cwd();
  const description = describeProviderSelection({ cwd });
  const running = startupProviderId;
  const mismatch = running !== description.effective;
  // p17-t4: same needsDefaultRoute condition as panel.ts's
  // _buildHarnessSettings, computed via the shared routingHostOps helper so
  // both hosts agree. buildRoutingView/computeNeedsDefaultRoute never throw,
  // but primaryProjectRoot can be unset early in startup — guard anyway so
  // a settings poll never fails the whole payload over this.
  let needsDefaultRoute = false;
  try {
    const { buildRoutingView, computeNeedsDefaultRoute } = routingHostOpsModule();
    const view = buildRoutingView({ root: cwd, env: process.env });
    needsDefaultRoute = computeNeedsDefaultRoute(description.effective, view);
  } catch (err) {
    console.error('[tycoonagents-standalone] needsDefaultRoute computation failed:', err instanceof Error ? err.message : err);
  }
  // p23-t11: same codex-only install-state flags as panel.ts's
  // _buildHarnessSettings.
  const codexExtra = description.effective === 'codex'
    ? {
        codexHooksInstalled: detectCodexHooksInstalledStandalone(cwd),
        codexDispatcherInstalled: detectCodexDispatcherInstalledStandalone(),
        ...(_lastCodexHookWarnings && _lastCodexHookWarnings.length > 0
          ? { codexHooksWarning: _lastCodexHookWarnings.join(' ') }
          : {}),
        ...(_lastCodexDispatcherWarnings && _lastCodexDispatcherWarnings.length > 0
          ? { codexDispatcherWarning: _lastCodexDispatcherWarnings.join(' ') }
          : {}),
        ...(_lastCodexAgentsMdWarning !== undefined ? { codexAgentsMdWarning: _lastCodexAgentsMdWarning } : {}),
      }
    : {};
  return {
    ...description,
    running,
    mismatch,
    options: [
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'opencode', label: 'OpenCode (Experimental)' },
      { id: 'codex', label: 'Codex (Experimental)' },
    ],
    // The watcher/provider was resolved once at process startup (see
    // `startupProviderId` and cli.mjs) and never reconstructed mid-process,
    // so any change only takes effect on the next `tycoonagents-standalone`
    // restart — mirrors `mismatch` (recomputed each call from the freshest
    // execution.json) rather than an unconditional true, so a fresh session
    // whose file already matches what's running doesn't show a stale hint.
    requiresRestart: mismatch,
    needsDefaultRoute,
    ...codexExtra,
  };
}

/**
 * Standalone analog of panel.ts's _handleSetDelegationMode (~line 6112).
 * Persists `delegation_mode` into `.claude/tycoon/execution.json`,
 * installs/removes the LEAD_AGENTS `.md` files + keyword routing, and
 * upserts the managed CLAUDE.md `<!-- tycoon:delegation -->` section — same
 * three side effects as the VS Code host, against the same on-disk files.
 * Replies `settingsUpdated` then re-broadcasts fresh `settings`.
 */
function handleSetDelegationModeStandalone(rawMode) {
  const mode = rawMode === 'team_leads' ? 'team_leads' : 'flat';
  const root = primaryProjectRoot;
  if (!root) {
    broadcast('message', {
      type: 'settingsUpdated',
      ok: false,
      id: 'delegation-mode',
      field: 'delegationMode',
      error: 'No project root resolved',
    });
    return;
  }
  try {
    const { writeExecutionConfig, readExecutionConfig } = delegationDoctrineModule();
    writeExecutionConfig(path.join(root, '.claude'), { delegation_mode: mode });
    if (mode === 'team_leads') installLeadAgentsStandalone(root);
    else removeLeadAgentsStandalone(root);

    const execCfg = readExecutionConfig(path.join(root, '.claude'));
    const claudeMdError = refreshDelegationSectionStandalone(
      root,
      mode,
      execCfg.reviewEnabled ?? true,
      execCfg.sessionJournalEntries ?? 0,
    );
    broadcast('message', {
      type: 'settingsUpdated',
      ok: true,
      id: 'delegation-mode',
      field: 'delegationMode',
      delegation_mode: mode,
      ...(claudeMdError !== undefined ? { claudeMdError } : {}),
    });
  } catch (err) {
    broadcast('message', {
      type: 'settingsUpdated',
      ok: false,
      id: 'delegation-mode',
      field: 'delegationMode',
      error: String(err),
    });
    return;
  }
  broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
}

/**
 * Standalone analog of panel.ts's _handleSetReviewEnabled (~line 6196).
 * Persists `reviewEnabled`, installs/removes the REVIEWER_AGENTS `.md`
 * file(s), and upserts the managed CLAUDE.md delegation section using
 * whatever `delegation_mode` is already on disk.
 */
function handleSetReviewEnabledStandalone(enabled) {
  const root = primaryProjectRoot;
  if (!root) {
    broadcast('message', {
      type: 'settingsUpdated',
      ok: false,
      id: 'review-enabled',
      field: 'reviewEnabled',
      error: 'No project root resolved',
    });
    return;
  }
  try {
    const { writeExecutionConfig, readExecutionConfig } = delegationDoctrineModule();
    writeExecutionConfig(path.join(root, '.claude'), { reviewEnabled: enabled });
    if (enabled) installReviewerAgentStandalone(root);
    else removeReviewerAgentStandalone(root);

    const execCfg = readExecutionConfig(path.join(root, '.claude'));
    const claudeMdError = refreshDelegationSectionStandalone(
      root,
      execCfg.delegation_mode,
      enabled,
      execCfg.sessionJournalEntries ?? 0,
    );
    broadcast('message', {
      type: 'settingsUpdated',
      ok: true,
      id: 'review-enabled',
      field: 'reviewEnabled',
      reviewEnabled: enabled,
      ...(claudeMdError !== undefined ? { claudeMdError } : {}),
    });
  } catch (err) {
    broadcast('message', {
      type: 'settingsUpdated',
      ok: false,
      id: 'review-enabled',
      field: 'reviewEnabled',
      error: String(err),
    });
    return;
  }
  broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
}

/**
 * Standalone analog of panel.ts's _handleSetSessionJournalEntries (~line
 * 6282). Clamps to an integer 0-5 (defensive, mirrors panel.ts), persists
 * it, appends `.claude/session-journal.json` to `.gitignore` when enabling
 * into an already-git-tracked project, and upserts the managed CLAUDE.md
 * delegation section.
 */
function handleSetSessionJournalEntriesStandalone(entries) {
  const root = primaryProjectRoot;
  if (!root) {
    broadcast('message', {
      type: 'settingsUpdated',
      ok: false,
      id: 'session-journal-entries',
      field: 'sessionJournalEntries',
      error: 'No project root resolved',
    });
    return;
  }
  const clamped = Math.min(5, Math.max(0, Math.trunc(Number.isFinite(entries) ? entries : 0)));
  try {
    const { writeExecutionConfig, readExecutionConfig } = delegationDoctrineModule();
    writeExecutionConfig(path.join(root, '.claude'), { sessionJournalEntries: clamped });

    if (clamped > 0) {
      const hasGit = fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, '.gitignore'));
      if (hasGit) {
        const gitignorePath = path.join(root, '.gitignore');
        let existing = '';
        try {
          existing = fs.readFileSync(gitignorePath, 'utf8');
        } catch {
          existing = '';
        }
        if (!existing.includes('.claude/session-journal.json')) {
          const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
          fs.writeFileSync(
            gitignorePath,
            `${existing}${sep}# TycoonAgents runtime artifacts\n.claude/session-journal.json\n`,
          );
        }
      }
    }

    const execCfg = readExecutionConfig(path.join(root, '.claude'));
    const claudeMdError = refreshDelegationSectionStandalone(
      root,
      execCfg.delegation_mode,
      execCfg.reviewEnabled ?? true,
      clamped,
    );
    broadcast('message', {
      type: 'settingsUpdated',
      ok: true,
      id: 'session-journal-entries',
      field: 'sessionJournalEntries',
      sessionJournalEntries: clamped,
      ...(claudeMdError !== undefined ? { claudeMdError } : {}),
    });
  } catch (err) {
    broadcast('message', {
      type: 'settingsUpdated',
      ok: false,
      id: 'session-journal-entries',
      field: 'sessionJournalEntries',
      error: String(err),
    });
    return;
  }
  broadcast('message', { type: 'settings', payload: buildStandaloneSettingsPayload() });
}

/**
 * Standalone analog of panel.ts's MSG.SET_PROJECT_PLAN_ENABLED branch
 * (~line 2575): persists `projectPlanEnabled` into the SAME
 * `.claude/tycoon/execution.json` (writeProjectPlanEnabled's
 * read-modify-write merge preserves delegation_mode/reviewEnabled/
 * sessionJournalEntries), auto-installs the project-plan skill when
 * enabling, refreshes the FULL managed CLAUDE.md doctrine (delegation +
 * code-rules sections) when hooks are installed for this root, then reposts
 * fresh PLAN_STATE via postPlanState.
 */
function handleSetProjectPlanEnabledStandalone(enabled) {
  const root = primaryProjectRoot;
  if (!root) {
    broadcast('message', {
      type: 'PLAN_STATE',
      enabled: false,
      plan: null,
      archivedPlans: [],
      planReadable: true,
      hasBackup: false,
    });
    return;
  }

  const configPath = path.join(root, '.claude', 'tycoon', 'execution.json');
  let existing = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') existing = parsed;
  } catch {
    existing = {};
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...existing, projectPlanEnabled: enabled }, null, 2));

  if (enabled === true) {
    try {
      const { failed } = stageSkillTreeStandalone('project-plan', root);
      if (failed.length > 0) {
        console.error(
          '[tycoonagents-standalone] project-plan skill install (via enable toggle) had failures:',
          failed,
        );
      }
    } catch (err) {
      console.error('[tycoonagents-standalone] project-plan skill install (via enable toggle) failed:', err);
    }
  }

  if (hooksInstalledForRootStandalone(root)) {
    try {
      const { readExecutionConfig } = delegationDoctrineModule();
      const { delegation_mode, reviewEnabled, sessionJournalEntries } = readExecutionConfig(path.join(root, '.claude'));
      const claudeMdPath = path.join(root, 'CLAUDE.md');
      let existingClaudeMd = null;
      try {
        existingClaudeMd = fs.readFileSync(claudeMdPath, 'utf8');
      } catch {
        existingClaudeMd = null;
      }
      const updated = buildClaudeMdDoctrineStandalone(
        existingClaudeMd,
        delegation_mode,
        reviewEnabled ?? true,
        root,
        sessionJournalEntries ?? 0,
      );
      if (existingClaudeMd === null || updated !== existingClaudeMd) fs.writeFileSync(claudeMdPath, updated);
    } catch (err) {
      console.error('[tycoonagents-standalone] CLAUDE.md refresh after Project Plan toggle failed:', err);
    }
  }

  postPlanState(root, broadcast);
}

/**
 * Standalone analog of panel.ts's _postOffloadOfferState (~line 8152), as a
 * PURE payload computation (no broadcast) so both the explicit
 * REQUEST_OFFLOAD_OFFER_STATE handler AND buildBootHandshakeMessages()'s
 * per-connection replay compute the identical LIVE payload instead of the
 * replay path hardcoding a stale stub. `dismissed`/`accepted` read from
 * `.claude/tycoon/execution.json`'s `offloadOfferDismissed`/
 * `offloadOfferAccepted` booleans (same file/merge pattern as the Project
 * Plan toggle above); `providerAvailable` is true only when the project's
 * `.mcp.json` has an `mcpServers.codex` entry — fails CLOSED (false) on any
 * missing/unreadable/ambiguous case, same as panel.ts's
 * `offloadProviderAvailable`.
 */
function computeOffloadOfferState(root) {
  if (!root) return { type: 'OFFLOAD_OFFER_STATE', dismissed: false, accepted: false, providerAvailable: false };
  const configPath = path.join(root, '.claude', 'tycoon', 'execution.json');
  let cfg = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') cfg = parsed;
  } catch {
    cfg = {};
  }
  const dismissed = cfg.offloadOfferDismissed === true;
  const accepted = cfg.offloadOfferAccepted === true;

  let providerAvailable = false;
  try {
    const { hasMcpServer } = mcpCatalogModule();
    const mcpPath = path.join(root, '.mcp.json');
    let mcpConfig = {};
    try {
      const parsedMcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (parsedMcp !== null && typeof parsedMcp === 'object') mcpConfig = parsedMcp;
    } catch {
      mcpConfig = {};
    }
    providerAvailable = hasMcpServer(mcpConfig, 'codex');
  } catch {
    providerAvailable = false;
  }

  return { type: 'OFFLOAD_OFFER_STATE', dismissed, accepted, providerAvailable };
}

function handlePostOffloadOfferState() {
  broadcast('message', computeOffloadOfferState(primaryProjectRoot));
}

/**
 * Boot-time theme resolution for the "ready" handshake — mirrors panel.ts's
 * MSG.READY handler (loadLatestTheme + THEME_INITIALIZED/THEME_NONE) but
 * against the standalone's fs-backed ThemeFileStore, which has no
 * "most-recently-used" bookkeeping yet. Picks the first theme
 * listThemesFromStore() returns (display-name sorted — see themeMessages.mjs)
 * when any exist, reusing handleSelectTheme's THEME_INITIALIZED/
 * THEME_GENERATION_ERROR posting so the wire payload shape stays identical
 * to a real SELECT_THEME round trip; posts THEME_NONE with an empty payload
 * (matching panel.ts's `{ type: MSG.THEME_NONE }`) when no theme exists yet.
 *
 * @param {import('./themeFileStoreFs.mjs').ThemeFileStore} store
 * @param {(eventName: string, data: object) => void} broadcastFn
 */
async function handleReadyThemeBoot(store, broadcastFn) {
  const themes = await listThemesFromStore(store);
  if (themes.length === 0) {
    broadcastFn('message', { type: THEME_MSG_WIRE.THEME_NONE, payload: {} });
    return;
  }
  await handleSelectTheme(store, broadcastFn, themes[0].theme_id, {
    appData: themeImageAppData,
    projectRoot: primaryProjectRoot,
  });
}

// ── Static file serving (media/ in place, path-traversal guarded) ──────────
function serveMediaFile(reqPath, res) {
  // reqPath is the URL path AFTER the /media/ prefix has been stripped.
  const decoded = decodeURIComponent(reqPath);
  const resolved = path.resolve(MEDIA_DIR, `.${path.sep}${decoded}`);
  const relative = path.relative(MEDIA_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(resolved),
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ── Theme image static route (pB-t1) ────────────────────────────────────────
// GET /theme-images/<theme_id>/<filename> serves a generated review image
// straight off disk — the standalone analog of the VS Code extension's
// `webview.asWebviewUri()` conversion in panel.ts's _postThemeImageReview()
// (which can't be used here: there is no webview origin to rewrite into).
// Rooted at `themeImagesRootDir` (== the active startServer() call's
// appData.dir — see that function's theme-store wiring), guarded against
// path traversal the same way serveMediaFile() guards /media/<path>.
let themeImagesRootDir;

function serveThemeImageFile(themeId, rawFilename, res) {
  if (!themeImagesRootDir || !/^[a-z0-9_]+$/.test(themeId || '')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const imagesDir = path.join(themeImagesRootDir, ...themeImagesDirectoryPath(themeId).split('/'));
  const decoded = decodeURIComponent(rawFilename);
  const resolved = path.resolve(imagesDir, `.${path.sep}${decoded}`);
  const relative = path.relative(imagesDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(resolved),
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ── Theme export/import routes (pB-t2) ──────────────────────────────────────
// Reuses the SAME vscode-free archive logic the VS Code extension's Export/
// Import commands use (src/extension/themeArchiveOps.ts, moved out of
// themeService.ts for exactly this reuse — see themeArchive.mjs's module
// header) — no duplicated zip code, same 0.0.371 `images/raw/` exclusion,
// same export-readiness (all images approved) gate. `themeStore` is the same
// module-level fs-backed store handleBrowserMessage()/serveThemeImageFile()
// already use (set by startServer() below).

// GET /theme-export/<theme_id> streams a portable .zip download.
async function serveThemeExport(themeId, res) {
  if (!themeStore || !/^[a-z0-9_]+$/.test(themeId || '')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  // Explicit existence check BEFORE calling exportThemeArchiveFromStore:
  // that function (mirroring the VS Code extension's original behavior
  // exactly) checks export-readiness (all images approved) before it ever
  // notices the theme doesn't exist, so a wholly missing theme_id would
  // otherwise surface as a 400 "Approve all theme images..." rather than a
  // 404 - this pre-check keeps the "theme dir doesn't exist -> 404"
  // contract without changing that shared, behavior-identical logic.
  //
  // Checks BOTH the modern per-theme-directory manifest (themes/<id>/
  // manifest.json) and the legacy pre-per-theme-directory flat sidecar
  // (<id>_manifest.json at the store root — see themeFileStore.ts's
  // legacyManifestPath, ~line 117) because exportThemeArchiveFromStore's own
  // legacy-normalize fallback (themeArchiveOps.ts's loadThemeFromStore) can
  // still export a theme that only has the legacy manifest — a dir-only
  // check would wrongly 404 that theme even though the archive op would
  // have handled it.
  let exists;
  try {
    const [hasModern, hasLegacy] = await Promise.all([
      themeStore.exists(themeManifestPath(themeId)),
      themeStore.exists(legacyManifestPath(themeId)),
    ]);
    exists = hasModern || hasLegacy;
  } catch {
    exists = false;
  }
  if (!exists) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  exportThemeArchiveFromStore(themeStore, themeId)
    .then((bytes) => {
      const safeId = themeId.replace(/[^a-z0-9_]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeId}.zip"`,
        'Content-Length': bytes.length,
      });
      res.end(Buffer.from(bytes));
    })
    .catch((err) => {
      const message = String(err?.message ?? err);
      const notFound = /theme not found/i.test(message);
      res.writeHead(notFound ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    });
}

// 100 MB cap on the raw POST /theme-import body (theme archives are small —
// generated art PNGs, not video — this only exists to stop an unbounded
// buffer accumulation from an oversized/malicious upload).
const MAX_THEME_IMPORT_BYTES = 100 * 1024 * 1024;

// POST /theme-import reads the RAW request body as the archive bytes
// themselves — there is no vscode open-file dialog in the standalone, the
// browser client posts the .zip's contents directly as the request body —
// and installs it (never replacing an existing theme; the client is
// expected to re-request with an explicit replace flow in a later task if
// that UX is added).
function handleThemeImport(req, res) {
  if (!themeStore) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Theme store not configured yet.' }));
    return;
  }
  const chunks = [];
  let totalBytes = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_THEME_IMPORT_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({ error: `Import body exceeds the ${MAX_THEME_IMPORT_BYTES}-byte limit.` }),
        () => req.destroy(),
      );
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', (err) => {
    if (aborted) return;
    aborted = true;
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  });
  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    importThemeArchiveToStore(themeStore, new Uint8Array(body), false)
      .then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      });
  });
}

// ── Host page ────────────────────────────────────────────────────────────────
// Standalone analog of src/host/vscode/panel.ts's _getHtmlForWebview(): same
// DOM scaffold (element ids) media/main.js's getElementById calls expect, so
// the unmodified script drives identically outside VS Code. Asset URIs point
// at the /media/* static route (served in place from the repo's media/ dir,
// never copied). theme-builder.js is included AFTER main.js (pD-t1), matching
// panel.ts's load order; main.js does not require it to boot on its own (see
// test/webviewSmoke.test.ts, which boots main.js alone). theme-builder.js's
// own top-level `acquireVsCodeApi()` call (media/theme-builder.js:92) is safe
// here because the shim below returns a singleton on every call — see the
// acquireVsCodeApi() note a few lines down.
//
// acquireVsCodeApi(): the REAL shim (p1-t3) so media/main.js's top-level
// `const vscode = acquireVsCodeApi();` (media/main.js:11) works identically
// to the VS Code webview contract:
//   - postMessage(msg)      -> POST /message (JSON body); network failures
//                              are swallowed + logged, never thrown, so a
//                              transient hiccup can't kill main.js's render
//                              loop (main.js calls postMessage from inside
//                              its rAF loop in several places). TWO types
//                              are special-cased instead of being POSTed
//                              (the server has no /message handler for
//                              either): EXPORT_THEME triggers a browser
//                              download of the pB-t2 GET /theme-export/<id>
//                              route, IMPORT_THEME opens a hidden file input
//                              and POSTs the chosen file's raw bytes to the
//                              pB-t2 POST /theme-import route (pD-t2); both
//                              then synthesize the matching
//                              THEME_EXPORT_RESULT/THEME_IMPORT_RESULT via
//                              deliverSyntheticMessage() below using the
//                              exact same window-'message'-event mechanism
//                              real SSE pushes use, so main.js needs no
//                              changes to react to either.
//   - getState()/setState(s) -> window.localStorage, single JSON key, so
//                              webview state survives a real page reload
//                              exactly like VS Code's webview state does.
//   - inbound server -> browser pushes ride SSE (/events) and are
//     re-dispatched as `window` 'message' events with event.data === the
//     object the server sent — the exact shape media/main.js's
//     `window.addEventListener("message", e => ...)` listener
//     (media/main.js:7175) already expects from the extension host's
//     webview.postMessage(). The server-side broadcast(eventName, data)
//     (see sseClients/broadcast above) MUST use eventName "message" for
//     anything meant to land here — "message" is the default SSE event
//     type EventSource's 'message' listener fires for.
//   - acquireVsCodeApi() may only be called ONCE in a real VS Code webview
//     (a second call throws there); this returns a singleton on every call
//     so main.js's single real call site (media/main.js:11) behaves
//     identically.
// Defined entirely in this host page's inline <script>, BEFORE
// /media/main.js is loaded below — media/main.js itself is never touched.
function buildHostHtml(token) {
  let version = '';
  try {
    const pkgRaw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    version = JSON.parse(pkgRaw).version || '';
  } catch {
    /* version stays empty if package.json can't be read */
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="tycoon-token" content="${token}" />
  <link href="/media/style.css" rel="stylesheet" />
  <title>TycoonAgents (standalone)</title>
  <script>
    // acquireVsCodeApi() shim — see the block comment above buildHostHtml()
    // in standalone/src/server.mjs for the full contract. This is the ONLY
    // place the shim lives; media/main.js is unmodified and unaware it is
    // not running inside a real VS Code webview.
    (function () {
      var STATE_KEY = 'tycoonagents:standalone:webviewState';
      var apiSingleton = null;
      // p49-t0: CSRF token minted server-side per startServer() instance,
      // injected into this page via the <meta name="tycoon-token"> tag
      // above. Sent as the X-Tycoon-Token header on every POST
      // (postToServer below, and the IMPORT_THEME upload further down) and
      // as a ?token= query param on the /events EventSource connection
      // (EventSource cannot set custom headers).
      var TYCOON_TOKEN = (function () {
        var el = document.querySelector('meta[name="tycoon-token"]');
        return el ? el.getAttribute('content') : '';
      })();

      function readState() {
        try {
          var raw = window.localStorage.getItem(STATE_KEY);
          return raw ? JSON.parse(raw) : undefined;
        } catch (err) {
          console.error('[tycoonagents-standalone] getState failed:', err);
          return undefined;
        }
      }

      function writeState(s) {
        try {
          window.localStorage.setItem(STATE_KEY, JSON.stringify(s));
        } catch (err) {
          console.error('[tycoonagents-standalone] setState failed:', err);
        }
        return s;
      }

      function postToServer(message) {
        // Resilient by design: postMessage must never throw synchronously or
        // reject visibly back into main.js's render loop over a transient
        // network error — swallow + log only.
        try {
          fetch('/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Tycoon-Token': TYCOON_TOKEN },
            body: JSON.stringify(message),
          }).catch(function (err) {
            console.error('[tycoonagents-standalone] postMessage: /message request failed:', err);
          });
        } catch (err) {
          console.error('[tycoonagents-standalone] postMessage threw synchronously:', err);
        }
      }

      // Synthesizes an inbound host->webview message the exact same way
      // connectEvents() below turns a real SSE push into one: a window
      // 'message' event whose event.data is { type, payload }, matching what
      // media/main.js's window.addEventListener("message", e => ...)
      // listener (media/main.js:7175) already expects from a real VS Code
      // webview.postMessage(). Used by the EXPORT_THEME/IMPORT_THEME
      // special-cases below to deliver THEME_EXPORT_RESULT/
      // THEME_IMPORT_RESULT without a server round-trip (pD-t2).
      function deliverSyntheticMessage(type, payload) {
        window.dispatchEvent(new MessageEvent('message', { data: { type: type, payload: payload || {} } }));
      }

      // EXPORT_THEME (pD-t2): there is no vscode save-dialog in the
      // standalone, so exporting is a browser download of the pB-t2
      // GET /theme-export/<theme_id> route (which already sets
      // Content-Disposition: attachment). A transient off-DOM <a download>
      // click is the most reliable cross-browser way to start that download
      // without navigating the page away. main.js only needs the
      // THEME_EXPORT_RESULT that follows to re-enable the Export button and
      // show status (media/main.js:7904) - it does not care how the bytes
      // actually reached the browser.
      function triggerThemeExport(themeId) {
        if (!themeId) {
          deliverSyntheticMessage('THEME_EXPORT_RESULT', { theme_id: themeId, error: 'No theme selected to export.' });
          return;
        }
        try {
          var link = document.createElement('a');
          link.href = '/theme-export/' + encodeURIComponent(themeId);
          link.download = themeId + '.zip';
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          deliverSyntheticMessage('THEME_EXPORT_RESULT', { theme_id: themeId, display_name: themeId });
        } catch (err) {
          console.error('[tycoonagents-standalone] EXPORT_THEME failed:', err);
          deliverSyntheticMessage('THEME_EXPORT_RESULT', { theme_id: themeId, error: String((err && err.message) || err) });
        }
      }

      // IMPORT_THEME (pD-t2): there is no vscode open-dialog in the
      // standalone, so a hidden <input type="file"> stands in for it. The
      // chosen file's raw bytes are POSTed as the request body to the pB-t2
      // POST /theme-import route (which expects the RAW archive bytes, not a
      // multipart form - see handleThemeImport above). Cancel detection uses
      // the standard window-'focus'-after-dialog-closes trick (there is no
      // native file-input cancel event): if 'change' has not already fired
      // and settled things shortly after focus returns, we treat it as a
      // cancel - this mirrors what main.js's IMPORT_THEME button expects
      // (payload.cancelled, media/main.js:7942).
      function triggerThemeImport() {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.style.display = 'none';
        var settled = false;
        var focusTimer = null;

        // Detaches the focus-based cancel watcher (listener + its pending
        // grace timer, if any). Called the instant a real file is chosen
        // (synchronously, before the async upload starts) so a slow
        // fetch/unzip can never let the timer fire underneath it; also
        // called on the genuine-cancel and true-cancel paths below.
        function removeFocusWatcher() {
          window.removeEventListener('focus', onFocus);
          if (focusTimer !== null) {
            clearTimeout(focusTimer);
            focusTimer = null;
          }
        }

        function removeInput() {
          if (input.parentNode) input.parentNode.removeChild(input);
        }

        function onFocus() {
          // Give a just-fired 'change' event a chance to settle() first.
          focusTimer = setTimeout(function () {
            focusTimer = null;
            if (settled) return;
            settled = true;
            removeFocusWatcher();
            removeInput();
            deliverSyntheticMessage('THEME_IMPORT_RESULT', { cancelled: true });
          }, 300);
        }

        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (!file) {
            // True dialog cancel: no file was ever selected.
            if (settled) return;
            settled = true;
            removeFocusWatcher();
            removeInput();
            deliverSyntheticMessage('THEME_IMPORT_RESULT', { cancelled: true });
            return;
          }
          // A real file was chosen: settle SYNCHRONOUSLY, before the async
          // upload starts, and detach the focus watcher right away. A real
          // import's fetch (network + server unzip/write) easily exceeds
          // the 300ms cancel grace period; without this the focus timer
          // would fire first, deliver a spurious {cancelled:true}, and the
          // eventual real result would be silently swallowed by an
          // early-return settled guard. The upload's own result is
          // delivered unconditionally below - settled is already true and
          // is not re-checked, so exactly one message goes out per pick.
          settled = true;
          removeFocusWatcher();
          file.arrayBuffer()
            .then(function (buf) {
              return fetch('/theme-import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip', 'X-Tycoon-Token': TYCOON_TOKEN },
                body: buf,
              });
            })
            .then(function (res) {
              return res.json().then(function (data) {
                return { ok: res.ok, data: data };
              });
            })
            .then(function (result) {
              removeInput();
              if (result.ok && !(result.data && result.data.error)) {
                deliverSyntheticMessage('THEME_IMPORT_RESULT', {
                  display_name: result.data && result.data.display_name,
                  replaced: result.data && result.data.replaced,
                });
                // Refresh the theme list through the normal channel so the
                // imported theme appears - the standalone's LIST_THEMES
                // handler broadcasts THEMES_LIST, which main.js already
                // renders (media/main.js's THEMES_LIST listener).
                postToServer({ type: 'LIST_THEMES' });
              } else {
                deliverSyntheticMessage('THEME_IMPORT_RESULT', {
                  error: (result.data && result.data.error) || 'Import failed.',
                });
              }
            })
            .catch(function (err) {
              removeInput();
              console.error('[tycoonagents-standalone] IMPORT_THEME failed:', err);
              deliverSyntheticMessage('THEME_IMPORT_RESULT', { error: String((err && err.message) || err) });
            });
        });

        window.addEventListener('focus', onFocus);
        document.body.appendChild(input);
        input.click();
      }

      // postMessage entry point used by the acquireVsCodeApi() singleton
      // below: EXPORT_THEME/IMPORT_THEME are special-cased into the browser
      // download/file-pick flows above (the server has no /message handler
      // for either - the pB-t2 routes are plain HTTP, not postMessage
      // dispatch); everything else goes to the server exactly as before.
      function dispatchPostMessage(message) {
        if (message && message.type === 'EXPORT_THEME') {
          triggerThemeExport(message.payload && message.payload.theme_id);
          return;
        }
        if (message && message.type === 'IMPORT_THEME') {
          triggerThemeImport();
          return;
        }
        postToServer(message);
      }

      function connectEvents() {
        // Server -> browser pushes ride SSE and are re-dispatched as window
        // 'message' events so media/main.js's existing
        // window.addEventListener("message", e => ...) needs no changes.
        try {
          var es = new EventSource('/events?token=' + encodeURIComponent(TYCOON_TOKEN));
          es.addEventListener('message', function (evt) {
            try {
              var data = JSON.parse(evt.data);
              window.dispatchEvent(new MessageEvent('message', { data: data }));
            } catch (err) {
              console.error('[tycoonagents-standalone] SSE payload parse failed:', err, evt.data);
            }
          });
          es.onerror = function (err) {
            // EventSource auto-reconnects on its own; just log, never throw.
            console.error('[tycoonagents-standalone] SSE connection error (auto-retrying):', err);
          };
        } catch (err) {
          console.error('[tycoonagents-standalone] EventSource unavailable:', err);
        }
      }

      window.acquireVsCodeApi = function () {
        // Singleton: mirrors the real VS Code webview, where a second call
        // throws. main.js only ever calls this once (media/main.js:11), so
        // returning the same instance on any further call is equivalent.
        if (apiSingleton) return apiSingleton;
        apiSingleton = {
          postMessage: dispatchPostMessage,
          getState: readState,
          setState: writeState,
        };
        connectEvents();
        return apiSingleton;
      };
    })();
  </script>
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
      <img class="boot-loader-logo" src="/media/handbook/tycoonagents_logo_sm.png" alt="" width="112" height="112" decoding="async" />
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
      <button class="menu-item" role="menuitem" id="menu-feedback">Feedback</button>
      <button class="menu-item" role="menuitem" id="menu-about">About</button>
      ${version ? `<div class="menu-version" role="presentation">v${version}</div>` : ''}
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
        <div id="metrics-empty">No agents yet &mdash; start a session to see activity.</div>
        <table id="metrics-table" hidden>
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
      </div>
      <!-- Delegation tab (full-width sibling tab panel, promoted out of
           #metrics-body): populated by renderDelegationStats() in
           media/main.js from state.modeStats. Hidden unless it is the
           active tab AND has data (see updateMetricsTabsUI()/
           renderDelegationStats()). -->
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
            <span class="delegation-mode-option-label">Flat — no team leads (recommended for most projects)</span>
            <span class="delegation-mode-option-help">The orchestrator briefs specialist workers directly &mdash; it does the reviewing itself. Lowest coordination cost; best for focused fixes.</span>
          </span>
        </label>
        <label class="delegation-mode-option">
          <input type="radio" name="delegation-mode" id="delegation-mode-team-leads" value="team_leads">
          <span class="delegation-mode-option-body">
            <span class="delegation-mode-option-label">Team leads</span>
            <span class="delegation-mode-option-help">Adds persistent lead agents that manage domain teams (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a coordination hop. Pays off on large builds from design docs &mdash; many features across many files &mdash; where it reduces orchestrator context churn, re-briefing, and mid-build context loss. If you mostly do focused fixes, stay Flat.</span>
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

  <!-- Feedback modal overlay: houses the "Submit feedback" section moved out
       of Settings (see the feedback-section builder in media/main.js).
       Mirrors src/host/vscode/panel.ts's #feedback-modal block exactly (same
       ids/classes) so main.js's unmodified click/render wiring works as-is. -->
  <div id="feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-modal-title" hidden>
    <div id="feedback-backdrop" class="settings-subpage-backdrop"></div>
    <div id="feedback-dialog" class="settings-subpage-dialog">
      <button id="feedback-modal-close" class="settings-subpage-close" aria-label="Close dialog">&times;</button>
      <h2 id="feedback-modal-title" class="settings-subpage-title">Feedback</h2>
      <div id="feedback-modal-body" class="settings-subpage-body"></div>
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
        <button id="tab-theme-picker" class="skill-btn">&larr; Back to themes</button>
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
       Mirrors src/host/vscode/panel.ts's #theme-builder-shell-modal exactly (same ids/classes). -->
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

  <script src="/media/main.js"></script>
  <script src="/media/theme-builder.js"></script>
</body>
</html>`;
}

// ── HTTP server ──────────────────────────────────────────────────────────────
//
// p49-t0 CSRF hardening: the server binds loopback-only (127.0.0.1 by
// default — see HOST above), but a loopback bind alone does not stop any web
// page open in the user's browser from POSTing to it or opening an
// EventSource against it (the browser will happily make loopback requests
// from any origin). checkOriginAndToken() below is the single gate every
// mutating/streaming route runs through BEFORE any side effect:
//   - Origin, when the request carries one, must equal this exact request's
//     own `http://<Host header>` — i.e. the page must actually have been
//     served BY this server, not merely be pointing a fetch/EventSource at
//     it from elsewhere. Requests with no Origin header (same-origin GETs,
//     non-browser callers) are not rejected on this check alone.
//   - `requireToken` routes (every POST, and GET /events) additionally must
//     present the in-memory sessionToken minted in startServer(): header
//     `X-Tycoon-Token` for POST bodies, `?token=` query param for
//     GET /events (EventSource cannot set custom headers).
// Every response — including token-free static GET routes — gets an
// explicit `Access-Control-Allow-Origin` pinned to this request's own origin
// (never `*`) and `X-Content-Type-Options: nosniff`.
// Constant-time token compare: rejects on a length mismatch FIRST (never
// feeds mismatched-length buffers to timingSafeEqual, which throws on
// that), then compares bytes without leaking timing info about how many
// leading bytes matched.
function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkOriginAndToken(req, res, url, { requireToken }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigins.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return false;
    }
    // Echoed only when it matches one of this server's own origins —
    // never a blanket '*' or an unvalidated reflection of the request.
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  if (requireToken) {
    const headerToken = req.headers['x-tycoon-token'];
    const queryToken = url.searchParams.get('token');
    const presented = req.method === 'GET' ? queryToken : headerToken;
    if (!tokensMatch(presented, sessionToken)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return false;
    }
  }

  return true;
}

function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;

  const requireToken = req.method === 'POST' || (req.method === 'GET' && pathname === '/events');
  if (!checkOriginAndToken(req, res, url, { requireToken })) return;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = buildHostHtml(sessionToken);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/media/')) {
    serveMediaFile(pathname.slice('/media/'.length), res);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/theme-images/')) {
    const rest = pathname.slice('/theme-images/'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex === -1) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const themeId = decodeURIComponent(rest.slice(0, slashIndex));
    const filename = rest.slice(slashIndex + 1);
    serveThemeImageFile(themeId, filename, res);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/theme-export/')) {
    const themeId = decodeURIComponent(pathname.slice('/theme-export/'.length));
    serveThemeExport(themeId, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/theme-import') {
    handleThemeImport(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    // Catch this ONE new client up on current state (see
    // registerInitialMessageProvider doc comment above) before any live
    // broadcast() traffic arrives.
    for (const provider of initialMessageProviders) {
      let messages;
      try {
        messages = provider();
      } catch (err) {
        console.error('[tycoonagents-standalone] initial message provider failed:', err);
        continue;
      }
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        if (msg && typeof msg.eventName === 'string') {
          writeSseEvent(res, msg.eventName, msg.data);
        }
      }
    }
    // Theme boot catch-up for THIS client only — see handleReadyThemeBoot's
    // doc comment. Unlike the 'ready' POST case (which broadcasts to every
    // connected client), this targets only the newly-connected `res` so
    // other already-connected tabs never get a redundant re-post. Async
    // (reads manifest/frames off disk via the fs-backed ThemeFileStore), so
    // it cannot be a synchronous initialMessageProviders entry like the
    // ones above — it runs after that loop instead. Guarded against a
    // client that has already disconnected by the time the read resolves,
    // and never throws: any failure (including an empty/missing store)
    // falls back to THEME_NONE, exactly like the 'ready' case.
    let clientClosed = false;
    req.on('close', () => {
      clientClosed = true;
      sseClients.delete(res);
    });
    handleReadyThemeBoot(themeStore, (eventName, data) => {
      if (clientClosed) return;
      writeSseEvent(res, eventName, data);
    }).catch((err) => {
      console.error('[tycoonagents-standalone] /events theme boot failed:', err);
      if (!clientClosed) {
        writeSseEvent(res, 'message', { type: THEME_MSG_WIRE.THEME_NONE, payload: {} });
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/message') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
        return;
      }
      handleBrowserMessage(parsed);
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function createStandaloneServer() {
  return http.createServer(requestListener);
}

// ── Project target resolution (p3-t1) ───────────────────────────────────────
// Replaces vscode.workspace.workspaceFolders: the standalone host is told
// EXPLICITLY which project dir(s) to watch, via (in this precedence order)
// CLI positional args, then TYCOON_STANDALONE_PROJECT_ROOT (comma-separated
// for multiple), then a default. See projectRoots.mjs for the full
// rationale and the pure resolveProjectRoots() this delegates to.

// ── App data + theme image config (pA-t3) ───────────────────────────────────
// Wires appData.mjs (previously unwired — see its module header) into the
// server: resolves the OS-appropriate persistent app-data directory
// (honoring TYCOON_STANDALONE_DATA_DIR) and derives a `themes/` subdirectory
// under it — the root a LATER task's theme storage adapter will read/write
// generated theme manifests/images from/to. This task only resolves and
// exposes that path (via startServer()'s returned `appData`/`themeDataDir`);
// it does not create any theme files itself.
//
// p44-t2: getThemeImageConfig()/GET_THEME_IMAGE_SETTINGS/SAVE_THEME_IMAGE_SETTINGS
// and their appData-persisted provider/model/quality files were removed —
// they existed only to feed the direct-provider image generation retired
// by p43-t1/p44-t2. Generation now routes entirely through the Corsair
// Theme Service via themeGenerationBridge.mjs's wireThemeServiceGeneration
// (installed once at server startup, right after themeServiceHostInstance
// is created) — see that call site and themeGenerationMessages.mjs's
// buildImageOptions() for the new no-provider ThemeImageGenerationOptions
// shape.
/** Thrown when the server cannot bind its port (e.g. EADDRINUSE). Callers
 * should print `.message` and exit non-zero — never let this surface as a
 * raw Node stack trace. */
export class ServerStartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServerStartError';
  }
}

// ── startServer(): the CLI-drivable seam (p4-t1) ────────────────────────────
// Everything main() used to do inline (resolve targets -> create the http
// server -> wire the primary/secondary stateFeeds -> listen), refactored
// into an async function that RETURNS a handle instead of calling
// process.exit()/installing its own signal handlers. main() below is now a
// thin wrapper around it (identical `npm start` behavior: cwd defaults to
// REPO_ROOT, same console output, same print-and-exit(1) on a bad project
// dir). standalone/src/cli.mjs's `watch` command uses this exact same
// function — no reimplementation of main()'s wiring — with ONE required
// difference: it MUST pass `cwd: process.cwd()` (the user's real shell cwd),
// never REPO_ROOT, so a relative `watch ./myproject` resolves against the
// user's actual directory rather than this repo checkout (the p3-t1 review
// footgun this task was flagged to fix).
//
// `cwd` has NO default here (unlike the old resolveTargets(), which
// hardcoded REPO_ROOT) — every caller must be explicit about which cwd this
// call's relative-path resolution and cwd-tier default should use. This
// module's own main() passes REPO_ROOT; cli.mjs's watch command passes
// process.cwd().
/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv] positional project-dir args forwarded to
 *   resolveProjectRoots(). Defaults to `process.argv.slice(2)`.
 * @param {Record<string, string | undefined>} [opts.env] defaults to
 *   `process.env`; forwarded to resolveProjectRoots() and consulted for
 *   TYCOON_STANDALONE_PORT / TYCOON_STANDALONE_HOST, and (pA-t3) for the
 *   appData dir override (TYCOON_STANDALONE_DATA_DIR, via appData.mjs).
 * @param {string} opts.cwd base for relative-path resolution and the
 *   cwd-tier default target (see resolveProjectRoots()). Required — callers
 *   must be explicit (see module header above).
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   url: string,
 *   port: number,
 *   host: string,
 *   primary: object,
 *   secondary: object[],
 *   close: () => Promise<void>,
 *   appData: ReturnType<typeof createDefaultAppData>,
 *   themeDataDir: string,
 * }>}
 * @throws {ProjectRootError} on a missing/invalid project directory (see
 *   resolveProjectRoots()) — thrown synchronously but this is an async
 *   function, so callers see it as a rejection.
 * @throws {ServerStartError} if the requested port is already in use.
 */
export async function startServer({
  argv = process.argv.slice(2),
  env = process.env,
  cwd,
  port = env.TYCOON_STANDALONE_PORT ? Number(env.TYCOON_STANDALONE_PORT) : PORT,
  host = env.TYCOON_STANDALONE_HOST || HOST,
  // Injectable for tests: point the Theme Service host at a fake server
  // (fetch/endpoint/supabaseUrl/supabaseAnonKey) or supply a fully-built
  // fake client directly. Undefined fields fall back to the real
  // production endpoints baked into out/src/core/themeServiceClient.js.
  themeServiceHostOptions = {},
} = {}) {
  const { roots } = resolveProjectRoots({ argv, env, cwd });
  const [primary, ...secondary] = roots;

  // p49-t0: fresh per-instance CSRF token — set here (not at module load) so
  // a second startServer() call in the same process (test harness) never
  // reuses a prior instance's token. In-memory only; never logged/persisted.
  sessionToken = crypto.randomBytes(32).toString('hex');

  // Set here (not just captured in the closure below) so a fresh
  // startServer() call (e.g. a test harness spinning up multiple server
  // instances in the same process) always points RESTORE_PLAN_BACKUP at the
  // CURRENT call's primary root, never a stale prior instance's — same
  // posture as themeStore/themeImagesRootDir below.
  primaryProjectRoot = primary.root;

  // Auto-heal the always-on core skills (tycoon-ready-test, tycoon-diagnose)
  // for every resolved root that already has TycoonAgents hooks installed —
  // standalone analog of panel.ts's _ensureCoreSkillsFresh, run once at
  // server startup instead of "on panel open" (this host has no panel-open
  // event). Same content-diff copy via stageSkillTreeStandalone; ships
  // unconditionally, no project-plan-style opt-in flag. Best-effort: never
  // blocks server startup.
  for (const { root } of roots) {
    try {
      if (!hooksInstalledForRootStandalone(root)) continue;
      for (const skillId of ['tycoon-ready-test', 'tycoon-diagnose']) {
        const { failed } = stageSkillTreeStandalone(skillId, root);
        if (failed.length > 0) {
          console.error(`[tycoonagents-standalone] core skill auto-heal failed for ${skillId} in ${root}:`, failed);
        }
      }
    } catch (err) {
      console.error(`[tycoonagents-standalone] core skill auto-heal failed for ${root}:`, err);
    }
  }

  // Project Plan is ON by default: at startup, for every root with hooks
  // installed (or an explicit flag), content-diff the project-plan skill
  // (restores missing/outdated/edited files) and refresh the managed CLAUDE.md
  // block so the Project Plan routing section appears. Analog of panel.ts's
  // _ensureProjectPlanSkillFresh + _ensureDelegationDoctrineCurrent.
  for (const { root } of roots) {
    try {
      const hooks = hooksInstalledForRootStandalone(root);
      if (!readProjectPlanEnabledStandalone(root)) continue;
      if (!hooks && !projectPlanFlagIsExplicitStandalone(root)) continue;
      const { failed } = stageSkillTreeStandalone('project-plan', root);
      if (failed.length > 0) {
        console.error(`[tycoonagents-standalone] project-plan skill auto-heal failed in ${root}:`, failed);
      }
      if (hooks) {
        const { readExecutionConfig } = delegationDoctrineModule();
        const { delegation_mode, reviewEnabled, sessionJournalEntries } = readExecutionConfig(path.join(root, '.claude'));
        const claudeMdPath = path.join(root, 'CLAUDE.md');
        let existingClaudeMd = null;
        try {
          existingClaudeMd = fs.readFileSync(claudeMdPath, 'utf8');
        } catch {
          existingClaudeMd = null;
        }
        const updated = buildClaudeMdDoctrineStandalone(
          existingClaudeMd,
          delegation_mode,
          reviewEnabled ?? true,
          root,
          sessionJournalEntries ?? 0,
        );
        if (existingClaudeMd === null || updated !== existingClaudeMd) fs.writeFileSync(claudeMdPath, updated);
      }
    } catch (err) {
      console.error(`[tycoonagents-standalone] project-plan auto-heal failed for ${root}:`, err);
    }
  }

  try {
    startupProviderId = resolveProviderId({ env, projectDir: primary.root });
  } catch (err) {
    console.error('[tycoonagents-standalone] resolveProviderId at startup failed, defaulting to claude-code:', err instanceof Error ? err.message : err);
    startupProviderId = 'claude-code';
  }

  const server = createStandaloneServer();

  // App data (pA-t3). Resolved from the SAME `env` this call already
  // threads through (not raw process.env), so tests that pass a fake env
  // (TYCOON_STANDALONE_DATA_DIR) get an isolated, deterministic app-data dir.
  const appData = createDefaultAppData({ env });
  const themeDataDir = path.join(appData.dir, 'themes');
  console.log(`[tycoonagents-standalone] app data dir: ${appData.dir}`);
  console.log(`[tycoonagents-standalone] theme data dir: ${themeDataDir}`);

  // Theme file store (pB-t1) — CRITICAL: rooted at appData.dir, NOT
  // themeDataDir. themeImagesDirectoryPath()/themeManifestPath()/etc. (see
  // themeFileStoreFs.mjs, re-exported from the compiled
  // out/src/extension/themeFileStore.js) already return paths PREFIXED with
  // 'themes/' — rooting the store at themeDataDir (which is itself
  // `${appData.dir}/themes`) would double-nest every theme under
  // themes/themes/<id>/... This module-level `themeStore` var is what
  // handleBrowserMessage() (LIST_THEMES/SELECT_THEME/DELETE_THEME/
  // GET_THEME_IMAGE_REVIEW dispatch) and serveThemeImageFile() (the
  // /theme-images/<id>/<file> static route) both read from — set here so a
  // later startServer() call (e.g. in tests) always points both at the
  // CURRENT call's appData.dir, never a stale prior instance's.
  themeStore = createFsThemeFileStore(appData.dir);
  themeImagesRootDir = appData.dir;
  themeImageAppData = appData;

  // Theme Service host (p44-t1) — standalone analog of panel.ts's
  // this._themeServiceHost. Disposed in close() below (stops the checkout
  // poll and any open Google loopback listener). Set here (not just
  // captured in the closure) so a fresh startServer() call always points
  // dispatch at the CURRENT call's host, same posture as themeStore above.
  themeServiceHostInstance = createThemeServiceHost({
    appDataDir: appData.dir,
    postStatus: (status) => broadcast('message', { type: THEME_SERVICE_STATUS_WIRE, payload: status }),
    clientVersion: readRepoVersion(),
    log: (msg) => console.log(`[tycoonagents-standalone] ${msg}`),
    ...themeServiceHostOptions,
  });
  themeServiceHostInstance.start();

  // p44-t2: install the same two generation seams panel.ts installs right
  // after creating its theme service host (setThemeImageGenerator(
  // createServiceImageGenerator(...)) + setThemePlanRequester(
  // createServicePlanRequester(...))) — see themeGenerationBridge.mjs's
  // wireThemeServiceGeneration(). Runs even when themeServiceHostOptions
  // injects a fake client (tests): wiring must point at whatever client
  // getClient() actually returns, real or fake, so PLAN_THEME/GENERATE_THEME
  // reach it either way.
  wireThemeServiceGeneration(
    themeServiceHostInstance.getClient(),
    {
      begin: () => themeServiceHostInstance.beginAttempt?.(),
      credits: (credits, token) => themeServiceHostInstance.applyCreditsFromAttempt?.(credits, token),
    },
    (boardType) => themeServiceHostInstance.getQuotedAttemptCost?.(boardType),
  );

  // Theme GENERATION bridge wiring (pC-t1 step 2) — configure the REAL
  // themeService.ts generation pipeline (out/src/extension/themeService.js,
  // required lazily by themeGenerationBridge.mjs) to resolve ITS
  // ThemeFileStore to this exact fs-backed `themeStore` instance, so
  // planTheme/generateTheme/retryThemeImage/resliceThemeImageFromRaw/
  // normalizeThemeCharacterAtlas below all read/write the same on-disk
  // layout LIST_THEMES/SELECT_THEME/etc. above already use. Called on every
  // startServer() call (not just once per process) so a second call in the
  // same process — e.g. a test harness spinning up multiple server
  // instances — always points generation at the CURRENT call's store, never
  // a stale prior instance's (same posture as themeStore/themeImagesRootDir
  // above).
  configureThemeFileStore(themeStore);

  // MULTI-DIR SEMANTICS (documented per task brief — do not silently mix
  // projects' sessions into one board): the FIRST resolved target is the
  // PRIMARY root. It alone drives the rendered state board — its stateFeed
  // is wired to broadcast() (SSE -> every connected browser tab) and to
  // registerInitialMessageProvider (late-connecting tab catch-up). Any
  // additional targets are still watched CONCURRENTLY (their stateFeed is
  // created for real, so a bad additional path would still surface via
  // activityWatcher's onError, and file handles/timers are real and are
  // closed cleanly on shutdown) but their computed state is intentionally
  // NOT broadcast to the board — only logged — so multiple projects' agent
  // sessions never get merged into a single, misleading metrics table. A
  // future task could add a project switcher / aggregated view; until then
  // this is the simplest choice that cannot silently corrupt what the board
  // shows.
  const stateFeed = createStateFeed({ projectRoot: primary.root, broadcast });
  const unregisterInitialMessage = registerInitialMessageProvider(() => {
    const msg = stateFeed.getStateMessage();
    return [{ eventName: 'message', data: msg }];
  });
  // Boot-handshake catch-up (see buildBootHandshakeMessages()'s doc comment)
  // — replays checkInstall/getPacks/getEngineStatus/REQUEST_PLAN/
  // REQUEST_OFFLOAD_OFFER_STATE's replies to every new /events connection so
  // the setup overlay dismisses even when the client's own boot POSTs raced
  // ahead of its SSE connection actually registering.
  const unregisterBootHandshake = registerInitialMessageProvider(() => buildBootHandshakeMessages());

  // Seed the bundled default theme into an EMPTY theme store on first run
  // (see seedBundledThemesIntoStore()'s doc comment) so handleReadyThemeBoot
  // has something to pick up instead of falling to THEME_NONE (the
  // blue/green fallback stripe rendering). Never overwrites a user's own
  // theme(s) — only fires when the store currently has zero themes. Awaited
  // (not fire-and-forget) BEFORE the server starts accepting connections
  // below, so no client's boot "ready" message can ever race ahead of the
  // seed and see an empty store.
  await seedBundledThemesIntoStore(themeStore);

  const secondaryFeeds = secondary.map((target) =>
    createStateFeed({
      projectRoot: target.root,
      broadcast: (eventName, data) => {
        // Intentionally NOT forwarded to the SSE board — see the
        // MULTI-DIR SEMANTICS comment above. Logged only, so this
        // additional watch is still observably alive/working.
        console.log(`[tycoonagents-standalone] (secondary: ${target.root}) ${eventName}`, JSON.stringify(data));
      },
    }),
  );

  // Port-in-use (and any other bind error) must surface as a clean,
  // catchable ServerStartError — never an unhandled EADDRINUSE stack trace
  // (task requirement). 'error' is attached before 'listening'/listen() so a
  // synchronous-ish bind failure can't race past it.
  await new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new ServerStartError(
            `TycoonAgents standalone: port ${port} is already in use on ${host}. Set TYCOON_STANDALONE_PORT to ` +
              `a different port, or stop whatever else is using it.`,
          ),
        );
        return;
      }
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  // Real bound port (server.address().port resolves the OS-assigned port
  // when `port` was 0 — used by tests for an ephemeral, collision-free bind;
  // otherwise identical to the requested `port`).
  const boundPort = server.address().port;
  const url = `http://${host}:${boundPort}`;

  // p49-t0 review fix: allowed Origins derived from the REAL bound port,
  // never from a client-controlled request header. Reset on every
  // startServer() call so a second instance in the same process (tests)
  // never validates against a stale prior instance's port.
  allowedOrigins = new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);

  console.log(`[tycoonagents-standalone] serving on ${url}`);
  console.log(`[tycoonagents-standalone] media dir (in place): ${MEDIA_DIR}`);
  console.log(`[tycoonagents-standalone] watching project (primary, drives the board): ${primary.root}`);
  for (const target of secondary) {
    console.log(`[tycoonagents-standalone] watching project (secondary, not shown on board): ${target.root}`);
  }

  let closed = false;
  // Clean shutdown (task requirement): closes every project's
  // activity.jsonl watcher (interval + fs.watch handle — already .unref()'d,
  // but closing explicitly is cleaner on an intentional stop), unregisters
  // this instance's initial-message provider (so a second startServer() call
  // in the same process, e.g. in tests, never leaks a stale provider that
  // would double-catch-up a later /events client), then forcibly terminates
  // any open SSE/keep-alive sockets — http.Server#close() alone only stops
  // ACCEPTING new connections and waits indefinitely for existing ones to
  // end, which would hang forever with a live SSE tab still connected.
  // res.end() first for a graceful SSE close, then
  // server.closeAllConnections() (Node >=18.2) as the belt-and-braces
  // guarantee that server.close()'s callback actually fires.
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    if (themeServiceHostInstance) themeServiceHostInstance.dispose();
    stateFeed.close();
    for (const feed of secondaryFeeds) feed.close();
    unregisterInitialMessage();
    unregisterBootHandshake();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    server,
    url,
    port: boundPort,
    host,
    primary,
    secondary,
    close,
    appData,
    themeDataDir,
    // p49-t0: exposed for tests only (needed to set X-Tycoon-Token /
    // ?token= on requests against this instance); never logged, never
    // written to disk.
    sessionToken,
  };
}

function main() {
  // `npm start` dogfood behavior, UNCHANGED from before this task: cwd
  // defaults to REPO_ROOT (not the shell's literal process.cwd(), which for
  // `npm start` is always standalone/ — see startServer()'s module header
  // above for the full rationale). No browser auto-open here; that is a
  // `watch`-CLI-only behavior (see cli.mjs) so `npm start` dogfooding never
  // unexpectedly pops a browser window.
  startServer({ cwd: REPO_ROOT })
    .then((runtime) => {
      const shutdown = () => {
        runtime.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      if (err instanceof ProjectRootError || err instanceof ServerStartError) {
        console.error(err.message);
        process.exit(1);
        return;
      }
      throw err;
    });
}

// Only auto-start when run directly (`node src/server.mjs`), not when
// imported (e.g. by a future test harness). Compared via pathToFileURL (not
// a raw `file://${argv[1]}` template) so this works on Windows, where
// argv[1] is a drive-letter path (`D:\...`) that doesn't already look like
// a file URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
