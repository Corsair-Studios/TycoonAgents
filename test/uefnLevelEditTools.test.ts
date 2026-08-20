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
 * Wiring/registration coverage for the three new UEFN level-editing tools
 * added to uefn-bridge/uefn-server.ts (~lines 784-874):
 * `uefn_spawn_actor`, `uefn_duplicate_actor`, `uefn_set_transform`. The
 * Python-side handlers (_handle_spawn_actor/_handle_duplicate_actor/
 * _handle_set_transform in media/uefn-bridge/uefn_bridge.py) have their own
 * dedicated coverage in test/python/test_uefn_bridge_level_edit.py — this
 * file only proves the TS-side registration and argument plumbing: each
 * tool name is registered exactly once, and its handler forwards the right
 * `bridgeTool(method, params)` call.
 *
 * Same constraint as the sibling uefn-server.ts test files
 * (test/uefnVerseCheck.test.ts, test/uefnModerationExternalLink.test.ts):
 * uefn-server.ts is a standalone MCP server (excluded from the tsc project,
 * bundled by esbuild) whose tail calls
 * `await server.connect(new StdioServerTransport())` at module scope —
 * simply importing/requiring the file would attach real stdio listeners and
 * hang. This file never imports the module at all; it works purely off the
 * REAL source TEXT via anchor-based extraction (same technique as those two
 * sibling files), so no full-file eval, no real McpServer, and no real
 * bridgeTool/callBridge (which would otherwise do real filesystem IPC and
 * poll for up to 30s per call waiting on a bridge that isn't running).
 *
 * For each tool: the exact `server.registerTool("uefn_X", ...)` block is
 * sliced out of the file between two literal anchors, its handler arrow
 * function (`async (args) => bridgeTool(...)`) is extracted the same way
 * uefnVerseCheck.test.ts extracts its handler (indexOf the start, lastIndexOf
 * the closing `);`), and evaluated with `new Function('bridgeTool',
 * 'compact', 'return (' + handlerText + ')')(stubBridgeTool, realCompactFn)`.
 * `compact` itself is also extracted verbatim (guarded against drift) and
 * type-stripped via esbuild so the test exercises the REAL compact()
 * implementation, not a reimplementation.
 */

const SERVER_TS_PATH = join(process.cwd(), 'uefn-bridge', 'uefn-server.ts');

// uefn-server.ts is checked out with CRLF line endings on Windows (git's
// core.autocrlf converts LF-in-repo to CRLF-on-disk); the anchors and
// COMPACT_FN_TEXT below are written with plain \n. Normalize once here so
// anchor/text matching is endianness-of-newline-agnostic and doesn't break
// depending on which platform checked the file out.
function readServerSource(): string {
  return readFileSync(SERVER_TS_PATH, 'utf8').replace(/\r\n/g, '\n');
}

const SPAWN_START = 'server.registerTool(\n  "uefn_spawn_actor",';
const DUPLICATE_START = 'server.registerTool(\n  "uefn_duplicate_actor",';
const SET_TRANSFORM_START = 'server.registerTool(\n  "uefn_set_transform",';
const MODERATION_START = 'server.registerTool(\n  "uefn_moderation_scan",';

const COMPACT_FN_TEXT =
  'function compact(obj: Record<string, unknown>): Record<string, unknown> {\n' +
  '  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));\n' +
  '}';

function requireAnchorOnce(fullSource: string, label: string, needle: string): number {
  const idx = fullSource.indexOf(needle);
  assert.ok(idx > 0, `uefn-server.ts layout changed: could not find "${label}" anchor — update it in this test`);
  const count = fullSource.split(needle).length - 1;
  assert.equal(count, 1, `uefn-server.ts layout changed: "${label}" anchor expected exactly once, found ${count}`);
  return idx;
}

function extractToolBlock(fullSource: string, label: string, startAnchor: string, endAnchor: string): string {
  const startIdx = requireAnchorOnce(fullSource, label, startAnchor);
  const endIdx = fullSource.indexOf(endAnchor, startIdx);
  assert.ok(endIdx > startIdx, `uefn-server.ts layout changed: could not find end anchor for "${label}" block`);
  return fullSource.slice(startIdx, endIdx);
}

function extractHandlerText(block: string, label: string): string {
  const asyncIdx = block.indexOf('async (args) =>');
  assert.ok(asyncIdx > 0, `uefn-server.ts layout changed: could not find handler arrow function in "${label}" block`);
  const lastCloseParenIdx = block.lastIndexOf(');');
  assert.ok(lastCloseParenIdx > asyncIdx, `uefn-server.ts layout changed: could not find closing ");" of "${label}" registerTool call`);
  return block.slice(asyncIdx, lastCloseParenIdx).replace(/\s+$/, '');
}

type BridgeCall = { method: string; params: Record<string, unknown> };

function makeStubBridgeTool(calls: BridgeCall[]): (method: string, params: Record<string, unknown>) => Promise<unknown> {
  return async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { content: [{ type: 'text', text: '{}' }] };
  };
}

function loadRealCompact(): (obj: Record<string, unknown>) => Record<string, unknown> {
  const fullSource = readServerSource();
  assert.ok(
    fullSource.includes(COMPACT_FN_TEXT),
    'compact() source text changed — update COMPACT_FN_TEXT in this test to match uefn-server.ts verbatim'
  );
  const { code } = transformSync(`${COMPACT_FN_TEXT}\nmodule.exports = { compact };`, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
  });
  const mod = { exports: {} as Record<string, unknown> };
  const runModule = new Function('module', 'exports', 'require', code) as (
    module: unknown,
    exports: unknown,
    require: unknown
  ) => void;
  runModule(mod, mod.exports, require);
  return mod.exports.compact as (obj: Record<string, unknown>) => Record<string, unknown>;
}

function loadHandler(
  fullSource: string,
  label: string,
  startAnchor: string,
  endAnchor: string,
  compactFn: (obj: Record<string, unknown>) => Record<string, unknown>,
  calls: BridgeCall[]
): (args: Record<string, unknown>) => Promise<unknown> {
  const block = extractToolBlock(fullSource, label, startAnchor, endAnchor);
  const handlerText = extractHandlerText(block, label);
  const buildHandler = new Function('bridgeTool', 'compact', `return (${handlerText});`) as (
    bridgeTool: unknown,
    compact: unknown
  ) => (args: Record<string, unknown>) => Promise<unknown>;
  return buildHandler(makeStubBridgeTool(calls), compactFn);
}

// ── registration: each tool name appears exactly once ───────────────────────

test('uefn_spawn_actor, uefn_duplicate_actor, uefn_set_transform are each registered exactly once', () => {
  const fullSource = readServerSource();
  // requireAnchorOnce asserts idx > 0 (found) AND exactly one occurrence —
  // calling it for all three anchors is itself the "registered exactly
  // once each" assertion.
  requireAnchorOnce(fullSource, 'uefn_spawn_actor', SPAWN_START);
  requireAnchorOnce(fullSource, 'uefn_duplicate_actor', DUPLICATE_START);
  requireAnchorOnce(fullSource, 'uefn_set_transform', SET_TRANSFORM_START);
});

// ── uefn_spawn_actor ─────────────────────────────────────────────────────────

test('uefn_spawn_actor handler calls bridgeTool("spawn_actor", ...) with all params passed through', async () => {
  const fullSource = readServerSource();
  const compactFn = loadRealCompact();
  const calls: BridgeCall[] = [];
  const handler = loadHandler(fullSource, 'uefn_spawn_actor', SPAWN_START, DUPLICATE_START, compactFn, calls);

  const args = {
    asset_path: '/Game/Meshes/SM_Rock',
    location: { x: 1, y: 2, z: 3 },
    rotation: { pitch: 4, yaw: 5, roll: 6 },
    scale: { x: 7, y: 8, z: 9 },
    label: 'MyRock',
  };
  await handler(args);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'spawn_actor');
  assert.deepEqual(calls[0].params, args);
});

test('uefn_spawn_actor handler strips undefined optional fields (only asset_path given)', async () => {
  const fullSource = readServerSource();
  const compactFn = loadRealCompact();
  const calls: BridgeCall[] = [];
  const handler = loadHandler(fullSource, 'uefn_spawn_actor', SPAWN_START, DUPLICATE_START, compactFn, calls);

  await handler({ asset_path: '/Game/Meshes/SM_Rock', location: undefined, rotation: undefined, scale: undefined, label: undefined });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'spawn_actor');
  assert.deepEqual(calls[0].params, { asset_path: '/Game/Meshes/SM_Rock' });
});

// ── uefn_duplicate_actor ─────────────────────────────────────────────────────

test('uefn_duplicate_actor handler calls bridgeTool("duplicate_actor", ...) with all params passed through', async () => {
  const fullSource = readServerSource();
  const compactFn = loadRealCompact();
  const calls: BridgeCall[] = [];
  const handler = loadHandler(fullSource, 'uefn_duplicate_actor', DUPLICATE_START, SET_TRANSFORM_START, compactFn, calls);

  const args = {
    actor_label: 'Widget1',
    offset: { x: 200, y: 300, z: 0 },
    new_label: 'Widget1_Copy',
  };
  await handler(args);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'duplicate_actor');
  assert.deepEqual(calls[0].params, args);
});

test('uefn_duplicate_actor handler strips undefined optional fields (only actor_label given)', async () => {
  const fullSource = readServerSource();
  const compactFn = loadRealCompact();
  const calls: BridgeCall[] = [];
  const handler = loadHandler(fullSource, 'uefn_duplicate_actor', DUPLICATE_START, SET_TRANSFORM_START, compactFn, calls);

  await handler({ actor_label: 'Widget1', offset: undefined, new_label: undefined });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'duplicate_actor');
  assert.deepEqual(calls[0].params, { actor_label: 'Widget1' });
});

// ── uefn_set_transform ───────────────────────────────────────────────────────

test('uefn_set_transform handler calls bridgeTool("set_transform", ...) with all params passed through', async () => {
  const fullSource = readServerSource();
  const compactFn = loadRealCompact();
  const calls: BridgeCall[] = [];
  const handler = loadHandler(fullSource, 'uefn_set_transform', SET_TRANSFORM_START, MODERATION_START, compactFn, calls);

  const args = {
    actor_label: 'Widget1',
    location: { x: 10, y: 20, z: 30 },
    rotation: { pitch: 1, yaw: 2, roll: 3 },
    scale: { x: 2, y: 2, z: 2 },
  };
  await handler(args);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'set_transform');
  assert.deepEqual(calls[0].params, args);
});

test('uefn_set_transform handler strips undefined optional fields (only actor_label + location given)', async () => {
  const fullSource = readServerSource();
  const compactFn = loadRealCompact();
  const calls: BridgeCall[] = [];
  const handler = loadHandler(fullSource, 'uefn_set_transform', SET_TRANSFORM_START, MODERATION_START, compactFn, calls);

  await handler({ actor_label: 'Widget1', location: { z: 50 }, rotation: undefined, scale: undefined });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'set_transform');
  assert.deepEqual(calls[0].params, { actor_label: 'Widget1', location: { z: 50 } });
});
