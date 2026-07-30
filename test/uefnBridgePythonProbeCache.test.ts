/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

/*
 * Coverage for uefn-bridge/uefn-server.ts's process-wide Python interpreter
 * probe cache (~lines 1258-1310): `locatePythonInterpreter`,
 * `invalidateCachedPythonInterpreter`, the `cachedPythonInterpreter` /
 * `failedPythonCandidates` module state.
 *
 * Same constraint and extraction technique as the sibling
 * test/uefnBridgeInboxCapability.test.ts: uefn-server.ts is a standalone MCP
 * server whose tail calls `server.connect(new StdioServerTransport())` at
 * module scope, so it can't be `require`d directly under `node --test`
 * without hanging. This file extracts the REAL source text for the state
 * declarations + both functions via anchors, wraps them in a factory that
 * takes `execFileAsync` as a parameter (the file's real free variable this
 * block closes over — see uefn-server.ts:1134's
 * `const execFileAsync = promisify(execFile);`), and evaluates it with
 * esbuild's programmatic transform + `new Function(...)`. Each test calls
 * the factory fresh, giving each test its own isolated
 * `cachedPythonInterpreter`/`failedPythonCandidates` closure state rather
 * than sharing the real process-wide singletons across tests.
 */

const SERVER_TS_PATH = join(process.cwd(), 'uefn-bridge', 'uefn-server.ts');

const STATE_START = 'let cachedPythonInterpreter: { cmd: string; version: string } | null = null;';
const BLOCK_END_ANCHOR = 'function normalizeForMatch(p: string): string {';

function requireAnchorOnce(fullSource: string, label: string, needle: string): number {
  const idx = fullSource.indexOf(needle);
  assert.ok(idx > 0, `uefn-server.ts layout changed: could not find "${label}" anchor — update it in this test`);
  const count = fullSource.split(needle).length - 1;
  assert.equal(count, 1, `uefn-server.ts layout changed: "${label}" anchor expected exactly once, found ${count}`);
  return idx;
}

function readServerSource(): string {
  return readFileSync(SERVER_TS_PATH, 'utf8');
}

type ExecFileAsync = (cmd: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string }>;
type ProbeCacheModule = {
  locatePythonInterpreter: () => Promise<{ chosen: { cmd: string; version: string } | null; tried: string[] }>;
  invalidateCachedPythonInterpreter: () => void;
  __getCached: () => { cmd: string; version: string } | null;
  __getFailed: () => string[];
};

function loadFreshProbeCacheModule(execFileAsync: ExecFileAsync): ProbeCacheModule {
  const fullSource = readServerSource();
  const startIdx = requireAnchorOnce(fullSource, 'STATE_START', STATE_START);
  const endIdx = requireAnchorOnce(fullSource, 'BLOCK_END_ANCHOR', BLOCK_END_ANCHOR);
  assert.ok(endIdx > startIdx, 'end anchor found before start anchor — uefn-server.ts layout changed');
  const blockText = fullSource.slice(startIdx, endIdx);

  const src =
    `function makeModule(execFileAsync) {\n` +
    `${blockText}\n` +
    `  return {\n` +
    `    locatePythonInterpreter,\n` +
    `    invalidateCachedPythonInterpreter,\n` +
    `    __getCached: function () { return cachedPythonInterpreter; },\n` +
    `    __getFailed: function () { return Array.from(failedPythonCandidates); },\n` +
    `  };\n` +
    `}\n` +
    `module.exports = { makeModule };`;

  const { code } = transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' });

  const mod = { exports: {} as Record<string, unknown> };
  const runModule = new Function('module', 'exports', 'require', code) as (
    module: unknown,
    exports: unknown,
    require: unknown
  ) => void;
  runModule(mod, mod.exports, require);

  const makeModule = mod.exports.makeModule as (execFileAsync: ExecFileAsync) => ProbeCacheModule;
  return makeModule(execFileAsync);
}

/** Records every (cmd, args, opts) call so tests can assert exact probe counts. */
function makeCountingExecFileAsync(
  behavior: (cmd: string) => 'succeed' | 'fail'
): { fn: ExecFileAsync; calls: string[] } {
  const calls: string[] = [];
  const fn: ExecFileAsync = async (cmd: string) => {
    calls.push(cmd);
    if (behavior(cmd) === 'succeed') {
      return { stdout: `Python 3.11.0 (${cmd})`, stderr: '' };
    }
    throw new Error(`${cmd}: not found`);
  };
  return { fn, calls };
}

// ── first successful candidate cached — second call performs zero probes ──

test('locatePythonInterpreter: caches the first successful candidate; a second call probes nothing', async () => {
  const { fn, calls } = makeCountingExecFileAsync((cmd) => (cmd === 'python' ? 'succeed' : 'fail'));
  const mod = loadFreshProbeCacheModule(fn);

  const first = await mod.locatePythonInterpreter();
  assert.equal(first.chosen?.cmd, 'python');
  assert.deepEqual(calls, ['python']);

  const second = await mod.locatePythonInterpreter();
  assert.equal(second.chosen?.cmd, 'python');
  assert.deepEqual(second.tried, [], 'a cached hit must report zero freshly-tried candidates');
  assert.deepEqual(calls, ['python'], 'second call must not probe again at all');
});

// ── failed candidates are never re-probed ──

test('locatePythonInterpreter: a candidate that already failed this run is never probed again', async () => {
  const { fn, calls } = makeCountingExecFileAsync(() => 'fail');
  const mod = loadFreshProbeCacheModule(fn);

  const first = await mod.locatePythonInterpreter();
  assert.equal(first.chosen, null);
  assert.deepEqual(calls, ['python', 'python3', 'py']);
  assert.deepEqual(mod.__getFailed().sort(), ['py', 'python', 'python3']);

  const second = await mod.locatePythonInterpreter();
  assert.equal(second.chosen, null);
  assert.deepEqual(second.tried, [], 'every candidate is already known-bad, so nothing should be (re-)tried');
  assert.deepEqual(calls, ['python', 'python3', 'py'], 'no candidate may be probed a second time');
});

// ── invalidate → exactly one re-probe ──

test('invalidateCachedPythonInterpreter: forces exactly one re-probe on the next call, skipping the now-stale candidate', async () => {
  let pythonAllowed = true;
  const { fn, calls } = makeCountingExecFileAsync((cmd) => {
    if (cmd === 'python') return pythonAllowed ? 'succeed' : 'fail';
    if (cmd === 'python3') return 'succeed';
    return 'fail';
  });
  const mod = loadFreshProbeCacheModule(fn);

  const first = await mod.locatePythonInterpreter();
  assert.equal(first.chosen?.cmd, 'python');
  assert.deepEqual(calls, ['python']);

  // The cached interpreter stops working mid-session (uninstalled, Store
  // stub, etc.) -- invalidate it. Real invocation is now disallowed too, so
  // if the fix in uefn-server.ts regressed to re-trying 'python' first, this
  // would surface as a second 'python' probe with no successful resolution.
  pythonAllowed = false;
  mod.invalidateCachedPythonInterpreter();
  assert.equal(mod.__getCached(), null);
  assert.ok(mod.__getFailed().includes('python'), 'the stale candidate must be folded into the known-failed set');

  const second = await mod.locatePythonInterpreter();
  assert.equal(second.chosen?.cmd, 'python3', 'the re-probe must skip the now-known-bad "python" and land on the next candidate');
  assert.deepEqual(calls, ['python', 'python3'], 'exactly one new probe ("python3") after invalidation — "python" itself must not be re-tried');
});
