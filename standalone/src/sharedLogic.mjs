// TycoonAgents standalone — bridge into the compiled `src/` core logic.
//
// This is the ONLY place standalone/ reaches into `out/` (the tsc-compiled
// CommonJS output of the repo's `src/`, per tsconfig.json's
// `outDir: "out"` / `module: "CommonJS"`). We do NOT fork or reimplement any
// of this logic — computeStateFromRecords, applyEvent, initialWorldState,
// computeDelegationModeStats and mapHookRecord are the exact functions the
// VS Code panel (src/host/vscode/panel.ts) uses to turn a HookRecord[] read
// from .claude/tycoon/activity.jsonl into a MetricsWorldState. Reusing them
// via createRequire keeps standalone byte-for-byte behaviorally identical to
// the VS Code host without touching a single file under src/ or media/.
//
// Verified vscode-free (safe to require outside a VS Code extension host):
//   - src/core/state.ts            (no imports beyond ./events, mapHookRecord, hookRecord)
//   - src/providers/claude-code/mapHookRecord.ts
//   - src/providers/claude-code/hookRecord.ts (types only)
//   - src/providers/claude-code/agentRoster.ts (node fs/path only — not used here yet)
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
const MAP_HOOK_RECORD_JS = path.join(REPO_ROOT, 'out', 'src', 'providers', 'claude-code', 'mapHookRecord.js');

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

let _mapHookRecordModule;
function mapHookRecordModule() {
  if (!_mapHookRecordModule) {
    _mapHookRecordModule = requireCompiled(
      MAP_HOOK_RECORD_JS,
      'out/src/providers/claude-code/mapHookRecord.js',
    );
  }
  return _mapHookRecordModule;
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
    mapHookRecordModule().mapHookRecord,
    'mapHookRecord',
    'out/src/providers/claude-code/mapHookRecord.js',
  );
  return fn(record);
}
