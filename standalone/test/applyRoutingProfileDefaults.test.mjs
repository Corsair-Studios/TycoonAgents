// TycoonAgents standalone — tests for plan task p17-t2's `defaults` support
// in scripts/apply-routing-profile.mjs: managed backend blocks are written
// for defaults-inherited eligible agents; hand-written backend blocks
// (existing-backend.md style) are never overwritten by defaults alone;
// clear/unapply restores/strips managed blocks the same as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAgentBackend, readAgentFrontmatter } from '../../out/src/core/agentBackend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'apply-routing-profile.mjs');

function mkTempRoot(prefix = 'tycoon-apply-routing-defaults-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(root, filename, frontmatterLines, body) {
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\n${frontmatterLines.join('\n')}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

function writeRoutingProfile(root, profileObj) {
  const dir = path.join(root, '.claude', 'tycoon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routing.json'), JSON.stringify(profileObj, null, 2), 'utf8');
}

function run(args) {
  return spawnSync('node', [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

function setupFixtureRoot() {
  const root = mkTempRoot();

  // eligible: no backend block at all
  writeAgent(root, 'eligible-agent.md', [
    'name: eligible-agent',
    'description: No backend block; should inherit defaults.',
    'tier: worker',
  ], '# Eligible Agent\n\nBody text.');

  // ineligible: hand-written backend block, no managed-by marker
  writeAgent(root, 'hand-written-agent.md', [
    'name: hand-written-agent',
    'description: Hand-written backend block.',
    'tier: worker',
    'backend:',
    '  vendor: openai',
    '  transport: mcp',
    '  mcpServer: codex',
    '  model: openai/gpt-5.4-mini',
    '  costModelClass: subscription',
  ], '# Hand Written Agent\n\nBody text.');

  writeRoutingProfile(root, {
    version: 1,
    agents: {},
    defaults: {
      vendor: 'anthropic',
      transport: 'claude-native',
      model: 'anthropic/claude-sonnet-4-6',
      costModelClass: 'subscription',
    },
  });

  return root;
}

test('apply-routing-profile --check reports the eligible agent as changed when defaults are present', () => {
  const root = setupFixtureRoot();
  const result = run(['--root', root, '--check']);
  assert.equal(result.status, 1, `expected exit 1 (changes pending); stdout=${result.stdout} stderr=${result.stderr}`);
  assert.ok(
    result.stdout.includes('eligible-agent.md'),
    `expected eligible-agent.md in --check output, got: ${result.stdout}`
  );
});

test('apply-routing-profile write: eligible agent gets a managed backend block from defaults', () => {
  const root = setupFixtureRoot();
  const result = run(['--root', root]);
  assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout} stderr=${result.stderr}`);

  const content = fs.readFileSync(path.join(root, '.claude', 'agents', 'eligible-agent.md'), 'utf8');
  assert.match(content, /# managed-by: tycoon-routing/);
  const fm = readAgentFrontmatter(content);
  const backend = parseAgentBackend(fm);
  assert.equal(backend.model, 'anthropic/claude-sonnet-4-6');
  assert.equal(backend.vendor, 'anthropic');
});

test('apply-routing-profile write: hand-written backend block is never overwritten by defaults alone', () => {
  const root = setupFixtureRoot();
  const before = fs.readFileSync(path.join(root, '.claude', 'agents', 'hand-written-agent.md'), 'utf8');
  const result = run(['--root', root]);
  assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout} stderr=${result.stderr}`);

  const after = fs.readFileSync(path.join(root, '.claude', 'agents', 'hand-written-agent.md'), 'utf8');
  assert.equal(after, before, 'a hand-written backend block must be left byte-identical when only `defaults` covers the agent');
  assert.doesNotMatch(after, /# managed-by: tycoon-routing/);
});

test('apply-routing-profile: clearing routing.json strips the defaults-derived managed block', () => {
  const root = setupFixtureRoot();
  let result = run(['--root', root]);
  assert.equal(result.status, 0);

  const managedContent = fs.readFileSync(path.join(root, '.claude', 'agents', 'eligible-agent.md'), 'utf8');
  assert.match(managedContent, /# managed-by: tycoon-routing/, 'sanity: block was written before clearing');

  fs.unlinkSync(path.join(root, '.claude', 'tycoon', 'routing.json'));
  result = run(['--root', root]);
  assert.equal(result.status, 0, `expected exit 0 on unapply; stdout=${result.stdout} stderr=${result.stderr}`);

  const cleared = fs.readFileSync(path.join(root, '.claude', 'agents', 'eligible-agent.md'), 'utf8');
  assert.doesNotMatch(cleared, /# managed-by: tycoon-routing/, 'managed block should be stripped once routing.json (and its defaults) is removed');
});
