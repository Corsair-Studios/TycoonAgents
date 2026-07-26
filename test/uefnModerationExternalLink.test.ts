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
 * Regression coverage for a real, confirmed miss in the UEFN moderation
 * scanner: a user's island was rejected under Rule 1.12 "Keep It on the
 * Island" over an asset named `discord_QR.uasset` (a QR code texture
 * imported from a browser Downloads folder), and the pre-flight scan
 * reported 0 BLOCKER — there was no Rule 1.12 / external-link coverage at
 * all. Separately, `uefn_moderation_report`'s write-confirmation and the
 * `next_required_action` nudge that drives the model to call it were only
 * checked informally; this file locks in the terminal-key contract for
 * `next_required_action` so a future refactor can't silently reorder it
 * (see uefn-bridge/uefn-server.ts line ~478 comment: models act on data
 * returned IN a tool result far more reliably than on schema text, and
 * only if it's the LAST thing read).
 *
 * uefn-bridge/uefn-server.ts is a standalone MCP server bundled by esbuild
 * (see `bundle:uefn` in package.json) — it is NOT part of the tsc project
 * (excluded in tsconfig.json) and none of its logic is exported. Its tail
 * end (`const server = new McpServer(...)` onward) calls
 * `await server.connect(new StdioServerTransport())` at module scope,
 * which would attach real stdio listeners and hang forever if the file
 * were simply required/imported in a test process.
 *
 * So this file reads ONLY the pure, side-effect-free prefix of the source
 * (everything before the `const server = new McpServer(` anchor — plain
 * consts, interfaces, and functions with no top-level execution), appends
 * a synthetic `export {}` for the symbols under test, strips TypeScript
 * types with esbuild's programmatic transform (already a devDependency;
 * same tool the project's own bundle:uefn script uses), and evaluates the
 * resulting CommonJS with `new Function(...)`. This exercises the REAL
 * production source text on every run (no reimplementation to drift out
 * of sync), while never constructing the MCP server or touching stdio.
 */

const SERVER_TS_PATH = join(process.cwd(), 'uefn-bridge', 'uefn-server.ts');
const SETUP_ANCHOR = 'const server = new McpServer(';

interface UefnServerInternals {
  attachModerationHints: (rawPayload: unknown, allowlist: string[] | undefined) => unknown;
  appendModerationNextRequiredAction: (result: unknown) => unknown;
  EXTERNAL_LINK_SEED_TERMS: string[];
  MODERATION_NEXT_REQUIRED_ACTION: string;
}

function loadUefnServerInternals(): UefnServerInternals {
  const fullSource = readFileSync(SERVER_TS_PATH, 'utf8');
  const anchorIndex = fullSource.indexOf(SETUP_ANCHOR);
  assert.ok(
    anchorIndex > 0,
    `uefn-server.ts layout changed: could not find "${SETUP_ANCHOR}" anchor — update SETUP_ANCHOR in this test`
  );
  const pureSection = fullSource.slice(0, anchorIndex);
  const footer =
    '\nexport { attachModerationHints, appendModerationNextRequiredAction, EXTERNAL_LINK_SEED_TERMS, MODERATION_NEXT_REQUIRED_ACTION };\n';

  const { code } = transformSync(pureSection + footer, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
  });

  const mod = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runModule = new Function('module', 'exports', 'require', code) as (
    module: unknown,
    exports: unknown,
    require: unknown
  ) => void;
  runModule(mod, mod.exports, require);
  return mod.exports as unknown as UefnServerInternals;
}

const { attachModerationHints, appendModerationNextRequiredAction, EXTERNAL_LINK_SEED_TERMS, MODERATION_NEXT_REQUIRED_ACTION } =
  loadUefnServerInternals();

function assetSurface(displayName: string, packagePath: string) {
  return {
    package_name: packagePath,
    object_path: `${packagePath}.${displayName}`,
    display_name: displayName,
    package_path: packagePath,
  };
}

type HintsResult = { first_pass_hints: Record<string, unknown> } & Record<string, unknown>;

// ── EXTERNAL_LINK_SEED_TERMS ────────────────────────────────────────────────

test('EXTERNAL_LINK_SEED_TERMS includes the platform-name seed that catches a QR-texture filename', () => {
  assert.ok(Array.isArray(EXTERNAL_LINK_SEED_TERMS));
  assert.ok(EXTERNAL_LINK_SEED_TERMS.includes('discord'));
  assert.ok(EXTERNAL_LINK_SEED_TERMS.includes('qr code'));
});

// ── attachModerationHints: external_link_hits detection ────────────────────

test('a QR-code-style imported asset (the real Rule 1.12 miss) produces non-empty external_link_hits', () => {
  const payload = {
    asset_surfaces: [assetSurface('discord_QR', '/Game/Imported/Textures/discord_QR')],
  };
  const result = attachModerationHints(payload, undefined) as HintsResult;
  const hits = result.first_pass_hints.external_link_hits as unknown[];
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length > 0, 'expected at least one external_link_hits entry for a discord_QR-named asset');
});

test('a clean control payload with no platform/QR terms yields EMPTY external_link_hits', () => {
  const payload = {
    asset_surfaces: [assetSurface('Rock_01', '/Game/Meshes/Environment/Rock_01')],
  };
  const result = attachModerationHints(payload, undefined) as HintsResult;
  const hits = result.first_pass_hints.external_link_hits as unknown[];
  assert.deepEqual(hits, [], 'a clean payload must not trigger the external-link detector — proves it is not always-on');
});

// ── no_other_findings_candidate interaction with external-link findings ────

test('no_other_findings_candidate is false when a licensed-IP asset AND an external-link finding coexist', () => {
  const payload = {
    asset_surfaces: [
      assetSurface('Star Wars AT-AT', '/Game/Imported/StarWars/AT-AT'),
      assetSurface('discord_QR', '/Game/Imported/Textures/discord_QR'),
    ],
  };
  const result = attachModerationHints(payload, ['star wars']) as HintsResult;
  assert.equal(result.first_pass_hints.expected_licensed instanceof Array ? (result.first_pass_hints.expected_licensed as unknown[]).length > 0 : false, true, 'sanity: the star wars asset should have been recognized as expected-licensed');
  assert.equal(result.first_pass_hints.no_other_findings_candidate, false);
});

test('no_other_findings_candidate stays true for a licensed-IP-only payload with no other findings (no regression)', () => {
  const payload = {
    asset_surfaces: [assetSurface('Star Wars AT-AT', '/Game/Imported/StarWars/AT-AT')],
  };
  const result = attachModerationHints(payload, ['star wars']) as HintsResult;
  assert.equal(result.first_pass_hints.no_other_findings_candidate, true);
});

// ── next_required_action: presence + terminal-key ordering ─────────────────

test('next_required_action is present and is the LAST key in the object returned to the model', () => {
  const payload = { asset_surfaces: [assetSurface('Rock_01', '/Game/Meshes/Environment/Rock_01')] };
  const withHints = attachModerationHints(payload, undefined);
  const finalResult = appendModerationNextRequiredAction(withHints) as Record<string, unknown>;

  assert.equal(finalResult.next_required_action, MODERATION_NEXT_REQUIRED_ACTION);

  const keys = Object.keys(finalResult);
  assert.equal(keys[keys.length - 1], 'next_required_action', `expected next_required_action last, got key order: ${keys.join(', ')}`);

  // The model reads the SERIALIZED tool result, not the JS object — assert
  // the literal JSON string also ends with this key, since that's what
  // actually reaches the model (see uefn-bridge/uefn-server.ts `ok()`,
  // which does `JSON.stringify(result)`).
  const serialized = JSON.stringify(finalResult);
  const expectedTail = `"next_required_action":${JSON.stringify(MODERATION_NEXT_REQUIRED_ACTION)}}`;
  assert.ok(
    serialized.endsWith(expectedTail),
    `expected serialized result to end with next_required_action, got tail: ${serialized.slice(-80)}`
  );
});

// ── Defensive reads: fields absent on an older staged Python copy ──────────

test('external_link_risks absent does not throw and does not fabricate the key', () => {
  const payload = { asset_surfaces: [assetSurface('Rock_01', '/Game/Meshes/Environment/Rock_01')] };
  assert.ok(!('external_link_risks' in payload));

  let result: HintsResult | undefined;
  assert.doesNotThrow(() => {
    result = attachModerationHints(payload, undefined) as HintsResult;
  });
  assert.equal(result!.first_pass_hints.external_link_structural_count, 0);
  assert.ok(!('external_link_risks' in result!), 'attachModerationHints must not invent an external_link_risks key that was never in the input');
});

test('import_provenance absent does not throw and does not fabricate the key', () => {
  const payload = { asset_surfaces: [assetSurface('Rock_01', '/Game/Meshes/Environment/Rock_01')] };
  assert.ok(!('import_provenance' in payload));

  let result: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    result = attachModerationHints(payload, undefined) as Record<string, unknown>;
  });
  assert.ok(!('import_provenance' in result!), 'attachModerationHints must not invent an import_provenance key that was never in the input');
});

test('a completely empty payload does not throw through either function', () => {
  assert.doesNotThrow(() => {
    const withHints = attachModerationHints({}, undefined);
    appendModerationNextRequiredAction(withHints);
  });
});
