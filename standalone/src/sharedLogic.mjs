// TycoonAgents standalone — bridge into the compiled `src/` core logic.
//
// This is the ONLY place standalone/ reaches into `out/` (the tsc-compiled
// CommonJS output of the repo's `src/`, per tsconfig.json's
// `outDir: "out"` / `module: "CommonJS"`). We do NOT fork or reimplement any
// of this logic — computeStateFromRecords, applyEvent, initialWorldState and
// computeDelegationModeStats are the exact functions the VS Code panel
// (src/host/vscode/panel.ts) uses to turn a HookRecord[] read from
// .claude/tycoon/activity.jsonl into a MetricsWorldState. Reusing them via
// createRequire keeps standalone byte-for-byte behaviorally identical to the
// VS Code host without touching a single file under src/ or media/.
//
// As of p4-t3, sharedLogic also loads out/src/providers/claude-code/index.js
// for its module-load side effect: it registers the claude-code mapper into
// src/core/mappingRegistry.ts (registerMapper(DEFAULT_PROVIDER_ID, ...)).
// state.js's computeStateFromRecords dispatches per-record via
// mapRecord()/mappingRegistry, so loading the real registration path here
// (rather than relying on mappingRegistry's lazy claude-code fallback) means
// the standalone registers providers the exact same way a future provider
// (e.g. OpenCode in M2) will — no separate standalone-only registration path
// to keep in sync. We no longer require mapHookRecord.js directly; nothing
// in standalone/ calls mapHookRecord() itself, and index.js re-exports it.
//
// Verified vscode-free (safe to require outside a VS Code extension host):
//   - src/core/state.ts            (no imports beyond ./events, mappingRegistry, hookRecord)
//   - src/core/mappingRegistry.ts  (no imports beyond ./events types)
//   - src/providers/claude-code/index.ts (registers mapper; re-exports mapHookRecord)
//   - src/providers/claude-code/mapHookRecord.ts
//   - src/providers/claude-code/hookRecord.ts (types only)
//   - src/providers/claude-code/agentRoster.ts (node fs/path only — not used here yet)
//   - src/host/vscode/hookInstall.ts (imports only node `fs`/`path` — its only
//     "vscode" mention is a code comment). mergeTycoonHooks/TYCOON_HOOK_SLOTS
//     are reused in place here, not forked — see standalone/installHook.mjs.
//
// LAZY by design: the compiled modules are only require()'d the first time
// one of the exported functions below is actually CALLED, not at import
// time. That means `import ... from './sharedLogic.mjs'` (or a transitive
// import via stateFeed.mjs/server.mjs) never throws just because `out/`
// hasn't been built yet — e.g. a future test harness that imports
// server.mjs's `createStandaloneServer` to test static file serving, without
// ever touching state-feed logic, is unaffected. The actionable "run `npx
// tsc -p .`" error only fires when this bridge is genuinely needed and
// missing.
//
// Node built-ins only — standalone/package.json ships zero dependencies.
// createRequire is a Node builtin; no bundler/loader dependency is added.

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root -> out/src/core/state.js
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'state.js');
const MAPPING_REGISTRY_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'mappingRegistry.js');
const CLAUDE_CODE_PROVIDER_JS = path.join(REPO_ROOT, 'out', 'src', 'providers', 'claude-code', 'index.js');
const REGISTER_ALL_MAPPERS_JS = path.join(REPO_ROOT, 'out', 'src', 'providers', 'registerAllMappers.js');
const HOOK_INSTALL_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'hookInstall.js');
const PROVIDER_SELECTION_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'providerSelection.js');
const FEEDBACK_SUBMIT_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'feedbackSubmit.js');

const require = createRequire(import.meta.url);

function requireCompiled(absPath, friendlyLabel) {
  if (!fs.existsSync(absPath)) {
    throw new Error(
      `[tycoonagents-standalone] sharedLogic: ${friendlyLabel} not found at ${absPath}. ` +
        'The compiled `out/` directory is missing or stale — run `npx tsc -p .` from the repo root first, ' +
        'then restart the standalone server.',
    );
  }
  return require(absPath);
}

let _stateModule;
function stateModule() {
  if (!_stateModule) _stateModule = requireCompiled(STATE_JS, 'out/src/core/state.js');
  return _stateModule;
}

let _mappingRegistryModule;
function mappingRegistryModule() {
  if (!_mappingRegistryModule) {
    _mappingRegistryModule = requireCompiled(MAPPING_REGISTRY_JS, 'out/src/core/mappingRegistry.js');
  }
  return _mappingRegistryModule;
}

let _claudeCodeProviderModule;
function claudeCodeProviderModule() {
  if (!_claudeCodeProviderModule) {
    // Loading this module registers the claude-code mapper into
    // mappingRegistry as a side effect (see module header above).
    _claudeCodeProviderModule = requireCompiled(
      CLAUDE_CODE_PROVIDER_JS,
      'out/src/providers/claude-code/index.js',
    );
  }
  return _claudeCodeProviderModule;
}

let _registerAllMappersModule;
function registerAllMappersModule() {
  if (!_registerAllMappersModule) {
    // Loading this module registers BOTH the claude-code and opencode
    // mappers into mappingRegistry as a side effect (see module header in
    // out/src/providers/registerAllMappers.js / its src/ source). Records
    // from either provider can coexist in one activity.jsonl, so both
    // mappers must be known regardless of which provider the standalone
    // was started with (`--provider`) — that flag only selects which
    // Provider tails the file, not which record shapes are understood.
    _registerAllMappersModule = requireCompiled(
      REGISTER_ALL_MAPPERS_JS,
      'out/src/providers/registerAllMappers.js',
    );
  }
  return _registerAllMappersModule;
}

let _hookInstallModule;
function hookInstallModule() {
  if (!_hookInstallModule) {
    _hookInstallModule = requireCompiled(HOOK_INSTALL_JS, 'out/src/host/vscode/hookInstall.js');
  }
  return _hookInstallModule;
}

let _providerSelectionModule;
function providerSelectionModule() {
  if (!_providerSelectionModule) {
    _providerSelectionModule = requireCompiled(PROVIDER_SELECTION_JS, 'out/src/core/providerSelection.js');
  }
  return _providerSelectionModule;
}

let _feedbackSubmitModule;
function feedbackSubmitModule() {
  if (!_feedbackSubmitModule) {
    _feedbackSubmitModule = requireCompiled(FEEDBACK_SUBMIT_JS, 'out/src/host/vscode/feedbackSubmit.js');
  }
  return _feedbackSubmitModule;
}

function assertFn(fn, name, sourceLabel) {
  if (typeof fn !== 'function') {
    throw new Error(
      `[tycoonagents-standalone] sharedLogic: expected "${name}" to be exported as a function from ` +
        `${sourceLabel} but it was not — the compiled output may be stale or the source export was renamed. ` +
        'Run `npx tsc -p .` from the repo root and verify the export still exists.',
    );
  }
  return fn;
}

/** @type {(records: object[], filterSessionId?: string) => import('../../src/core/state').MetricsWorldState} */
export function computeStateFromRecords(records, filterSessionId) {
  // Ensure every provider's mapper is registered via the real provider
  // modules (loading them also triggers mappingRegistry.js's fail-fast
  // checks). Both are required regardless of the selected --provider since
  // activity.jsonl can carry records from more than one provider.
  registerAllMappersModule();
  claudeCodeProviderModule();
  const fn = assertFn(stateModule().computeStateFromRecords, 'computeStateFromRecords', 'out/src/core/state.js');
  return fn(records, filterSessionId);
}

/** @type {() => import('../../src/core/state').MetricsWorldState} */
export function initialWorldState(limits) {
  const fn = assertFn(stateModule().initialWorldState, 'initialWorldState', 'out/src/core/state.js');
  return fn(limits);
}

/** @type {(state: object, event: object) => object} */
export function applyEvent(state, event) {
  const fn = assertFn(stateModule().applyEvent, 'applyEvent', 'out/src/core/state.js');
  return fn(state, event);
}

/** @type {(agentMetrics: object[]) => object[]} */
export function computeDelegationModeStats(agentMetrics) {
  const fn = assertFn(
    stateModule().computeDelegationModeStats,
    'computeDelegationModeStats',
    'out/src/core/state.js',
  );
  return fn(agentMetrics);
}

/** @type {(record: object) => object[]} */
export function mapHookRecord(record) {
  const fn = assertFn(
    claudeCodeProviderModule().mapHookRecord,
    'mapHookRecord',
    'out/src/providers/claude-code/index.js',
  );
  return fn(record);
}

/** Register a mapper for a provider id — reused for M2 providers (e.g.
 * OpenCode) that need to register into the same shared mappingRegistry.
 * @type {(providerId: string, fn: (record: unknown) => object[]) => void} */
export function registerMapper(providerId, fn) {
  const registerFn = assertFn(mappingRegistryModule().registerMapper, 'registerMapper', 'out/src/core/mappingRegistry.js');
  return registerFn(providerId, fn);
}

/** True if a mapper is currently registered for providerId.
 * @type {(providerId: string) => boolean} */
export function hasMapper(providerId) {
  const fn = assertFn(mappingRegistryModule().hasMapper, 'hasMapper', 'out/src/core/mappingRegistry.js');
  return fn(providerId);
}

/** Pure merge of the TycoonAgents hook into an existing Claude Code settings
 * object — the exact function `src/host/vscode/hookInstall.ts` exports,
 * required lazily from its compiled output.
 * @type {(existing: Record<string, unknown>, hookCommand: string) => Record<string, unknown>} */
export function mergeTycoonHooks(existing, hookCommand) {
  const fn = assertFn(
    hookInstallModule().mergeTycoonHooks,
    'mergeTycoonHooks',
    'out/src/host/vscode/hookInstall.js',
  );
  return fn(existing, hookCommand);
}

/** Resolves which provider id (`'claude-code'` | `'opencode'`) the standalone
 * should use, per src/core/providerSelection.ts's precedence: TYCOON_PROVIDER
 * env > `settingValue` (unused by the standalone — it has no VS Code
 * setting) > the `provider` key in `<projectDir>/.claude/tycoon/execution.json`
 * > `'claude-code'`. Throws (naming the valid ids) on an unrecognized id.
 * @type {(options: { settingValue?: string, env?: Record<string, string | undefined>, projectDir: string }) => string} */
export function resolveProviderId(options) {
  const fn = assertFn(
    providerSelectionModule().resolveProviderId,
    'resolveProviderId',
    'out/src/core/providerSelection.js',
  );
  return fn(options);
}

/** The Claude Code hook events + matchers TycoonAgents wires up, read lazily
 * from the compiled `hookInstall.js`'s `TYCOON_HOOK_SLOTS` — call this rather
 * than caching the array yourself so a stale/missing `out/` still surfaces
 * the actionable "run `npx tsc -p .`" error at first real use.
 * @returns {ReadonlyArray<{event: string, matcher: string}>} */
export function getTycoonHookSlots() {
  const slots = hookInstallModule().TYCOON_HOOK_SLOTS;
  if (!Array.isArray(slots)) {
    throw new Error(
      '[tycoonagents-standalone] sharedLogic: expected "TYCOON_HOOK_SLOTS" to be exported as an array from ' +
        'out/src/host/vscode/hookInstall.js but it was not — the compiled output may be stale or the source ' +
        'export was renamed. Run `npx tsc -p .` from the repo root and verify the export still exists.',
    );
  }
  return slots;
}

/** Canonical feedback-submit endpoint (spec-baked, same hostname the VS Code
 * host uses) — read lazily from the compiled feedbackSubmit.js so it can
 * never drift from panel.ts's constant.
 * @type {() => string} */
export function getFeedbackEndpoint() {
  const url = feedbackSubmitModule().FEEDBACK_ENDPOINT;
  if (typeof url !== 'string' || url === '') {
    throw new Error(
      '[tycoonagents-standalone] sharedLogic: expected "FEEDBACK_ENDPOINT" to be exported as a non-empty ' +
        'string from out/src/host/vscode/feedbackSubmit.js. Run `npx tsc -p .` and verify the export still exists.',
    );
  }
  return url;
}

/** Fallback web form shown to the user when a feedback submission fails. */
export function getFeedbackFallbackFormUrl() {
  const url = feedbackSubmitModule().FALLBACK_FORM_URL;
  if (typeof url !== 'string' || url === '') {
    throw new Error(
      '[tycoonagents-standalone] sharedLogic: expected "FALLBACK_FORM_URL" to be exported as a non-empty ' +
        'string from out/src/host/vscode/feedbackSubmit.js. Run `npx tsc -p .` and verify the export still exists.',
    );
  }
  return url;
}

/** Builds the exact v1 feedback payload object (schemaVersion, ticketId,
 * createdAt, category, sanitized userDescription/contact, ...) — the same
 * function panel.ts's `_handleSubmitFeedback` calls.
 * @type {(input: object, ctx: object) => object} */
export function buildFeedbackPayload(input, ctx) {
  const fn = assertFn(
    feedbackSubmitModule().buildFeedbackPayload,
    'buildFeedbackPayload',
    'out/src/host/vscode/feedbackSubmit.js',
  );
  return fn(input, ctx);
}

/** Builds the auto-recorded feedback context (host/harness/routing/agents —
 * spec addendum 2026-09-06). Never throws; on internal failure returns a
 * partial object plus `contextErrors`. Same function panel.ts's
 * `_handleSubmitFeedback` calls, so both hosts record identically-shaped
 * context.
 * @type {(root: string, opts: object) => object} */
export function buildFeedbackContext(root, opts) {
  const fn = assertFn(
    feedbackSubmitModule().buildFeedbackContext,
    'buildFeedbackContext',
    'out/src/host/vscode/feedbackSubmit.js',
  );
  return fn(root, opts);
}

/** POSTs `bodyString` to `endpoint` via `fetchImpl`, aborting after
 * `timeoutMs`. Never throws — resolves `{ ok, error? }`. Same function
 * panel.ts's `_handleConfirmFeedbackSend` calls.
 * @type {(bodyString: string, endpoint: string, fetchImpl: Function, timeoutMs?: number) => Promise<{ok: boolean, error?: string}>} */
export function postFeedback(bodyString, endpoint, fetchImpl, timeoutMs) {
  const fn = assertFn(feedbackSubmitModule().postFeedback, 'postFeedback', 'out/src/host/vscode/feedbackSubmit.js');
  return fn(bodyString, endpoint, fetchImpl, timeoutMs);
}
