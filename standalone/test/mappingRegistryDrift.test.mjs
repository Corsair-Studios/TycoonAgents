// TycoonAgents standalone — drift guard for sharedLogic.mjs's provider
// registration bridge (p4-t3).
//
// WHY THIS EXISTS: sharedLogic.mjs must load the REAL registration path
// (out/src/providers/claude-code/index.js, which calls registerMapper() into
// out/src/core/mappingRegistry.js) rather than relying on mappingRegistry's
// lazy claude-code fallback, or hand-rolling its own provider dispatch. That
// keeps the standalone and the VS Code host registering providers identically
// — a property that matters more once M2 adds a second provider (OpenCode).
// This test fails loudly if either property regresses:
//   1. sharedLogic.mjs resolves mappingRegistry from the repo's compiled
//      out/ tree, not a copy hand-maintained under standalone/.
//   2. after sharedLogic.mjs is used (computeStateFromRecords called once),
//      hasMapper('claude-code') is true — proving the real provider module's
//      registration side effect actually ran.
//   3. standalone/src contains no mapping logic of its own — no hand-rolled
//      PreToolUse/SubagentStop-style event mapping beyond passing records
//      through to the shared bridge.
//
// Plain ESM, node --test, node:assert/strict — matches messageContract.test.mjs
// and stateFeed.test.mjs. Node built-ins only; requires `npx tsc -p .` to have
// been run from the repo root first (same precondition as stateFeed.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_MAPPING_REGISTRY = path.join(REPO_ROOT, 'out', 'src', 'core', 'mappingRegistry.js');
const STANDALONE_SRC = path.join(__dirname, '..', 'src');

test('sharedLogic.mjs resolves mappingRegistry from the repo out/ tree, not a standalone copy', () => {
  const sharedLogicPath = path.join(STANDALONE_SRC, 'sharedLogic.mjs');
  const src = fs.readFileSync(sharedLogicPath, 'utf8');

  assert.match(
    src,
    /['"]out['"],\s*['"]src['"],\s*['"]core['"],\s*['"]mappingRegistry\.js['"]/,
    'sharedLogic.mjs should build a path ending in out/src/core/mappingRegistry.js',
  );

  // No mappingRegistry.js under standalone/ anywhere — it must come from out/.
  const standaloneCopy = path.join(STANDALONE_SRC, 'core', 'mappingRegistry.js');
  assert.equal(
    fs.existsSync(standaloneCopy),
    false,
    'found a standalone-local copy of mappingRegistry.js — standalone must reuse the compiled out/ version, never fork it',
  );

  assert.ok(
    fs.existsSync(OUT_MAPPING_REGISTRY),
    `expected compiled ${OUT_MAPPING_REGISTRY} to exist — run "npx tsc -p ." from the repo root before running this test`,
  );
});

test('after sharedLogic loads, the claude-code mapper is registered via the real provider module', async () => {
  const sharedLogic = await import('../src/sharedLogic.mjs');

  // Calling computeStateFromRecords (even with an empty array) must trigger
  // loading out/src/providers/claude-code/index.js, whose module-load side
  // effect registers the claude-code mapper into mappingRegistry.
  sharedLogic.computeStateFromRecords([]);

  assert.equal(
    sharedLogic.hasMapper('claude-code'),
    true,
    'hasMapper("claude-code") should be true after sharedLogic.computeStateFromRecords runs — ' +
      'the real out/src/providers/claude-code/index.js registration path should have run',
  );
});

test('standalone/src has no hand-rolled record-mapping logic of its own', () => {
  const files = fs.readdirSync(STANDALONE_SRC).filter((f) => f.endsWith('.mjs'));
  const offenders = [];

  for (const file of files) {
    if (file === 'sharedLogic.mjs') continue; // the one file allowed to name these as bridge/doc references
    const full = path.join(STANDALONE_SRC, file);
    const text = fs.readFileSync(full, 'utf8');
    // Look for actual mapping-style logic (a switch/case or if-chain keyed on
    // these event names), not incidental mentions in comments/docs.
    const mappingPattern = /(case\s+['"](PreToolUse|SubagentStop|PostToolUse|Stop)['"]\s*:)|(===\s*['"](PreToolUse|SubagentStop|PostToolUse|Stop)['"]\s*\))/;
    if (mappingPattern.test(text)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `found hand-rolled hook-record mapping logic in standalone/src: ${offenders.join(', ')} — ` +
      'all record->event mapping must flow through sharedLogic.mjs\'s bridge into the compiled out/ mapper, never be reimplemented locally',
  );
});
