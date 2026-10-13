// Standalone parity for the superseded-default keyword migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateSupersededKeywordsForRootStandalone } from '../src/server.mjs';

const OLD = 'verse|uefn|fortnite|verse-audit|verse-review|verse-lint';

function mk(pattern, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-supersede-'));
  fs.mkdirSync(path.join(root, '.claude', 'tycoon'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'tycoon', 'agent-keywords.json'), JSON.stringify({ agents: { 'uefn-auditor': { pattern } } }));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'uefn-auditor.md'), `---\nmodel: sonnet\n---\n## Keywords (for task routing)\n${body}\n`);
  return root;
}
const read = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'tycoon', 'agent-keywords.json'), 'utf8')).agents['uefn-auditor'].pattern;

test('exact old uefn-auditor default is migrated in config and agent file', () => {
  const root = mk(OLD, OLD);
  const r = migrateSupersededKeywordsForRootStandalone(root);
  assert.equal(r.configChanged, true);
  assert.deepEqual(r.bodies, ['uefn-auditor']);
  assert.equal(read(root), 'auditor|lint|deprecation|deprecated|compliance');
  assert.match(fs.readFileSync(path.join(root, '.claude', 'agents', 'uefn-auditor.md'), 'utf8'), /\nauditor\|lint\|deprecation\|deprecated\|compliance\n/);
});

test('edited uefn-auditor values are untouched', () => {
  const root = mk(OLD + '|mine', OLD + '|mine');
  const r = migrateSupersededKeywordsForRootStandalone(root);
  assert.equal(r.configChanged, false);
  assert.deepEqual(r.bodies, []);
  assert.equal(read(root), OLD + '|mine');
});
