import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

// Loads the pure helper directly from its media source part (not the
// concatenated media/main.js bundle) via the part file's Node-only
// `module.exports` branch — see media/src/main/005-agent-accent.js.
// Path resolution mirrors test/webviewSmoke.test.ts: `npm test` runs from
// the repo root, so resolve relative to process.cwd(), not this compiled
// out/test/*.js file's own location.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { agentAccent } = require(join(process.cwd(), 'media', 'src', 'main', '005-agent-accent.js'));

test('agentAccent: fallback beats foreign', () => {
  assert.equal(
    agentAccent({ vendor: 'openai', fallbackOf: 'coding-specialist', harness: 'claude-code' }),
    'fallback',
  );
});

test('agentAccent: anthropic under claude-code is native', () => {
  assert.equal(agentAccent({ vendor: 'anthropic', harness: 'claude-code' }), 'native');
});

test('agentAccent: openai under claude-code is foreign', () => {
  assert.equal(agentAccent({ vendor: 'openai', harness: 'claude-code' }), 'foreign');
});

test('agentAccent: openai under codex is native', () => {
  assert.equal(agentAccent({ vendor: 'openai', harness: 'codex' }), 'native');
});

test('agentAccent: anthropic under codex is foreign', () => {
  assert.equal(agentAccent({ vendor: 'anthropic', harness: 'codex' }), 'foreign');
});

test('agentAccent: any vendor under opencode is foreign', () => {
  assert.equal(agentAccent({ vendor: 'anthropic', harness: 'opencode' }), 'foreign');
  assert.equal(agentAccent({ vendor: 'google', harness: 'opencode' }), 'foreign');
});

test('agentAccent: undefined vendor is native (never guess)', () => {
  assert.equal(agentAccent({ harness: 'claude-code' }), 'native');
  assert.equal(agentAccent({ vendor: undefined, harness: 'codex' }), 'native');
});

test('agentAccent: empty-string fallbackOf does not count as fallback', () => {
  assert.equal(agentAccent({ vendor: 'anthropic', fallbackOf: '', harness: 'claude-code' }), 'native');
});
