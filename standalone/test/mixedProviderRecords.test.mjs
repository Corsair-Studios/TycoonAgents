// TycoonAgents standalone — regression test for the bug where
// `node standalone/src/cli.mjs watch . --provider opencode` dropped
// provider:"opencode" records with:
//   mappingRegistry: no mapper registered for provider "opencode".
//   Registered: claude-code
//
// Root cause: sharedLogic.mjs only ever required
// out/src/providers/claude-code/index.js, so the opencode mapper (registered
// as a module-load side effect of src/providers/opencode/index.ts) was never
// loaded — regardless of which --provider the standalone was started with,
// since a single activity.jsonl can carry records from BOTH providers. Fixed
// by having sharedLogic.mjs also require the shared
// out/src/providers/registerAllMappers.js (src/providers/registerAllMappers.ts),
// which imports both provider index modules together.
//
// Plain ESM, node --test, node:assert/strict — matches
// mappingRegistryDrift.test.mjs. Requires `npx tsc -p .` to have been run
// first (same precondition as the other sharedLogic-backed tests here).

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('computeStateFromRecords maps both claude-code and opencode records from one mixed activity log', async () => {
  const sharedLogic = await import('../src/sharedLogic.mjs');

  const claudeCodeRecord = {
    event: 'UserPromptSubmit',
    sessionId: 'sess-cc-1',
    at: 1000,
    prompt: 'hello from claude-code',
  };

  // Real shape written by hooks/tycoon-opencode-plugin.ts: a HookRecord plus
  // provider:"opencode" (see src/providers/opencode/mapOpenCodeRecord.ts).
  const openCodeRecord = {
    event: 'UserPromptSubmit',
    provider: 'opencode',
    sessionId: 'sess-oc-1',
    at: 2000,
    prompt: 'hello from opencode',
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let state;
  try {
    state = sharedLogic.computeStateFromRecords([claudeCodeRecord, openCodeRecord]);
  } finally {
    console.warn = originalWarn;
  }

  const droppedOpencode = warnings.some((w) => w.includes('unknown provider "opencode"'));
  assert.equal(
    droppedOpencode,
    false,
    `expected no "unknown provider \\"opencode\\"" warning, got: ${JSON.stringify(warnings)}`,
  );

  assert.equal(sharedLogic.hasMapper('opencode'), true, 'hasMapper("opencode") should be true after computeStateFromRecords runs');
  assert.equal(sharedLogic.hasMapper('claude-code'), true, 'hasMapper("claude-code") should still be true');

  // If the opencode record had been dropped (unmapped), state.lastActivityAt
  // would stop at the claude-code record's timestamp (1000) instead of
  // advancing to the opencode record's later timestamp (2000).
  assert.equal(
    state.lastActivityAt,
    2000,
    'lastActivityAt should reflect the later opencode record, proving it was applied, not dropped',
  );
});
