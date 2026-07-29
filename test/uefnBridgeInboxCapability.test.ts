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
import { isNumericVersion, isBridgeVersionNewer } from '../src/shared/bridgeVersion';

/*
 * Coverage for uefn-bridge/uefn-server.ts's per-command-inbox capability
 * gate (~lines 40-97, 122-146): MIN_INBOX_BRIDGE_VERSION, the
 * isBridgeInboxCapable() predicate, and the ternary in _callBridgeNow that
 * picks command_{id}.json vs the legacy shared command.json based on it.
 *
 * Same constraint as the sibling uefn-server.ts test files
 * (test/uefnVerseCheck.test.ts, test/uefnLevelEditTools.test.ts):
 * uefn-server.ts is a standalone MCP server (excluded from the tsc project,
 * bundled by esbuild) whose tail calls
 * `await server.connect(new StdioServerTransport())` at module scope —
 * importing/requiring the file directly would attach real stdio listeners
 * and hang. This file works purely off the REAL source TEXT via
 * anchor-based extraction, type-stripped with esbuild's programmatic
 * transform and evaluated with `new Function(...)` — the real production
 * logic, not a reimplementation.
 *
 * isBridgeInboxCapable() itself is evaluated against the REAL
 * isNumericVersion/isBridgeVersionNewer from src/shared/bridgeVersion.ts
 * (imported directly — that module is deliberately free of any vscode/fs
 * dependency and is already covered on its own in
 * test/uefnBridgeVersion*.test.ts-style suites elsewhere), not a
 * reimplementation of the comparison logic.
 */

const SERVER_TS_PATH = join(process.cwd(), 'uefn-bridge', 'uefn-server.ts');

const MIN_VERSION_CONST_LINE = 'const MIN_INBOX_BRIDGE_VERSION = "0.0.499";';
const CAPABLE_FUNC_START = 'function isBridgeInboxCapable(bridgeVersion: string | undefined): boolean {';
const CAPABLE_FUNC_END_ANCHOR = '// Serialize all requests';

const COMMAND_PATH_TERNARY_START = 'const commandPath = isBridgeInboxCapable(bridgeVersion)';
const COMMAND_PATH_TERNARY_END_ANCHOR = 'path.join(BRIDGE_DIR, "command.json");';

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

// ── MIN_INBOX_BRIDGE_VERSION literal ────────────────────────────────────────

test('MIN_INBOX_BRIDGE_VERSION is pinned to "0.0.499" in uefn-server.ts', () => {
  const fullSource = readServerSource();
  requireAnchorOnce(fullSource, 'MIN_VERSION_CONST_LINE', MIN_VERSION_CONST_LINE);
});

// ── isBridgeInboxCapable() extracted and run against the real bridgeVersion helpers ──

function loadIsBridgeInboxCapable(): (bridgeVersion: string | undefined) => boolean {
  const fullSource = readServerSource();

  const funcStartIdx = requireAnchorOnce(fullSource, 'CAPABLE_FUNC_START', CAPABLE_FUNC_START);
  const funcEndAnchorIdx = requireAnchorOnce(fullSource, 'CAPABLE_FUNC_END_ANCHOR', CAPABLE_FUNC_END_ANCHOR);
  assert.ok(funcEndAnchorIdx > funcStartIdx, 'end anchor found before start anchor — uefn-server.ts layout changed');

  const rawBlock = fullSource.slice(funcStartIdx, funcEndAnchorIdx);
  const lastBraceIdx = rawBlock.lastIndexOf('}');
  assert.ok(lastBraceIdx > 0, 'could not find closing "}" of isBridgeInboxCapable — uefn-server.ts layout changed');
  const funcText = rawBlock.slice(0, lastBraceIdx + 1);

  const src = `${MIN_VERSION_CONST_LINE}\n${funcText}\nmodule.exports = { isBridgeInboxCapable, MIN_INBOX_BRIDGE_VERSION };`;
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' });

  const mod = { exports: {} as Record<string, unknown> };
  const runModule = new Function(
    'module',
    'exports',
    'require',
    'isNumericVersion',
    'isBridgeVersionNewer',
    code
  ) as (
    module: unknown,
    exports: unknown,
    require: unknown,
    isNumericVersion: unknown,
    isBridgeVersionNewer: unknown
  ) => void;
  runModule(mod, mod.exports, require, isNumericVersion, isBridgeVersionNewer);

  assert.equal(mod.exports.MIN_INBOX_BRIDGE_VERSION, '0.0.499');
  return mod.exports.isBridgeInboxCapable as (bridgeVersion: string | undefined) => boolean;
}

test('isBridgeInboxCapable: bridge_version "0.0.499" (exact match) is capable', () => {
  const isBridgeInboxCapable = loadIsBridgeInboxCapable();
  assert.equal(isBridgeInboxCapable('0.0.499'), true);
});

test('isBridgeInboxCapable: a newer bridge_version is capable', () => {
  const isBridgeInboxCapable = loadIsBridgeInboxCapable();
  assert.equal(isBridgeInboxCapable('0.0.500'), true);
  assert.equal(isBridgeInboxCapable('0.1.0'), true);
  assert.equal(isBridgeInboxCapable('1.0.0'), true);
});

test('isBridgeInboxCapable: missing bridge_version (undefined) is NOT capable', () => {
  const isBridgeInboxCapable = loadIsBridgeInboxCapable();
  assert.equal(isBridgeInboxCapable(undefined), false);
});

test('isBridgeInboxCapable: an older bridge_version ("0.0.498") is NOT capable', () => {
  const isBridgeInboxCapable = loadIsBridgeInboxCapable();
  assert.equal(isBridgeInboxCapable('0.0.498'), false);
});

test('isBridgeInboxCapable: a non-numeric/corrupt bridge_version is NOT capable, never throws', () => {
  const isBridgeInboxCapable = loadIsBridgeInboxCapable();
  assert.equal(isBridgeInboxCapable('abc'), false);
  assert.equal(isBridgeInboxCapable('0.0.x'), false);
  assert.equal(isBridgeInboxCapable(''), false);
});

// ── command path selection: exclusive branch, never both ────────────────────

function loadComputeCommandPath(): (capable: boolean, bridgeDir: string, id: string) => string {
  const fullSource = readServerSource();

  const startIdx = requireAnchorOnce(fullSource, 'COMMAND_PATH_TERNARY_START', COMMAND_PATH_TERNARY_START);
  const endAnchorIdx = fullSource.indexOf(COMMAND_PATH_TERNARY_END_ANCHOR, startIdx);
  assert.ok(endAnchorIdx > startIdx, 'could not find end of commandPath ternary — uefn-server.ts layout changed');
  const ternaryText = fullSource.slice(startIdx, endAnchorIdx + COMMAND_PATH_TERNARY_END_ANCHOR.length);

  // Wrap the REAL ternary assignment in a tiny function so it can be
  // exercised directly, with `isBridgeInboxCapable`/`path`/`BRIDGE_DIR`/`id`
  // supplied as stand-ins for the enclosing _callBridgeNow's real closure
  // variables — the ternary text itself is untouched.
  const src =
    `function computeCommandPath(isBridgeInboxCapable: (v: string | undefined) => boolean, path: { join: (...p: string[]) => string }, BRIDGE_DIR: string, id: string, bridgeVersion: string | undefined): string {\n` +
    `  ${ternaryText}\n` +
    `  return commandPath;\n` +
    `}\n` +
    `module.exports = { computeCommandPath };`;
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' });

  const mod = { exports: {} as Record<string, unknown> };
  const runModule = new Function('module', 'exports', 'require', code) as (
    module: unknown,
    exports: unknown,
    require: unknown
  ) => void;
  runModule(mod, mod.exports, require);

  const real = mod.exports.computeCommandPath as (
    isBridgeInboxCapable: (v: string | undefined) => boolean,
    path: { join: (...p: string[]) => string },
    BRIDGE_DIR: string,
    id: string,
    bridgeVersion: string | undefined
  ) => string;

  const fakePath = { join: (...parts: string[]) => parts.join('/') };
  return (capable: boolean, bridgeDir: string, id: string) => real(() => capable, fakePath, bridgeDir, id, undefined);
}

test('command path: capable bridge writes command_{id}.json, never command.json', () => {
  const computeCommandPath = loadComputeCommandPath();
  const path = computeCommandPath(true, '/tmp/uefn_bridge', '12345_1');
  assert.equal(path, '/tmp/uefn_bridge/command_12345_1.json');
  assert.notEqual(path, '/tmp/uefn_bridge/command.json');
});

test('command path: non-capable bridge writes legacy command.json, never command_{id}.json', () => {
  const computeCommandPath = loadComputeCommandPath();
  const path = computeCommandPath(false, '/tmp/uefn_bridge', '12345_1');
  assert.equal(path, '/tmp/uefn_bridge/command.json');
  assert.ok(!path.includes('command_12345_1'));
});

test('command path: the two branches are structurally exclusive (single ternary, one path returned)', () => {
  // Not a race condition to reproduce here (this is a pure sync function) —
  // this proves the SOURCE SHAPE is a single ternary assignment (one
  // `commandPath` declaration, one return value), which is what makes "never
  // write both for the same call" true by construction rather than by
  // runtime luck.
  const fullSource = readServerSource();
  const startIdx = requireAnchorOnce(fullSource, 'COMMAND_PATH_TERNARY_START', COMMAND_PATH_TERNARY_START);
  const endAnchorIdx = fullSource.indexOf(COMMAND_PATH_TERNARY_END_ANCHOR, startIdx);
  const ternaryText = fullSource.slice(startIdx, endAnchorIdx + COMMAND_PATH_TERNARY_END_ANCHOR.length);

  const constDeclarations = (ternaryText.match(/const commandPath/g) ?? []).length;
  assert.equal(constDeclarations, 1, 'expected exactly one `const commandPath` declaration');
  const questionMarks = (ternaryText.match(/\?/g) ?? []).length;
  assert.equal(questionMarks, 1, 'expected exactly one ternary `?` — a second one would mean a non-exclusive/branching write path');
});
