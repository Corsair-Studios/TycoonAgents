// TycoonAgents standalone — tests for scripts/apply-routing-profile.mjs (p12-t4).
//
// Exercises: backend block written/refreshed correctly (parsed back via
// out/src/core/agentBackend.js parseAgentBackend), body preserved
// byte-for-byte, other frontmatter keys preserved, idempotent second run,
// --check semantics, invalid profile -> exit 2 no writes, missing agent
// warned (not created).

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

function mkTempRoot(prefix = 'tycoon-apply-routing-test-') {
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

  // (a) agent with an existing backend block
  writeAgent(root, 'existing-backend.md', [
    'name: existing-backend',
    'description: Has a backend block already.',
    'model: sonnet',
    'backend:',
    '  vendor: anthropic',
    '  transport: claude-native',
    '  model: anthropic/claude-sonnet-4-6',
    '  costModelClass: subscription',
  ], '# Existing Backend\n\nSome body text.\nSecond line.');

  // (b) agent without a backend block
  writeAgent(root, 'no-backend.md', [
    'name: no-backend',
    'description: No backend block yet.',
    'model: haiku',
    'tier: worker',
  ], '# No Backend\n\nBody for this one.');

  // (c) orchestrator agent
  writeAgent(root, 'orchestrator.md', [
    'name: orchestrator',
    'description: The orchestrator.',
    'model: opus',
    'role: orchestrator',
  ], '# Orchestrator\n\nOrchestrator body.');

  writeRoutingProfile(root, {
    version: 1,
    orchestrator: {
      vendor: 'opencode',
      transport: 'openai-compatible',
      model: 'opencode/big-pickle',
      costModelClass: 'local',
      endpointEnv: 'OPENCODE_ENDPOINT_URL',
    },
    agents: {
      'existing-backend': {
        vendor: 'moonshot',
        transport: 'openai-compatible',
        model: 'moonshot/kimi-k2',
        costModelClass: 'local',
        endpointEnv: 'KIMI_ENDPOINT_URL',
        credentialEnv: 'KIMI_API_KEY',
      },
      'no-backend': {
        vendor: 'anthropic',
        transport: 'claude-native',
        model: 'sonnet',
        costModelClass: 'subscription',
      },
      'ghost-agent': {
        vendor: 'anthropic',
        transport: 'claude-native',
        model: 'haiku',
        costModelClass: 'metered',
      },
    },
  });

  return root;
}

test('writes backend block for agent without one; body & other keys preserved', () => {
  const root = setupFixtureRoot();
  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);

  const filePath = path.join(root, '.claude', 'agents', 'no-backend.md');
  const content = fs.readFileSync(filePath, 'utf8');
  assert.match(content, /# No Backend\n\nBody for this one.\n$/);
  assert.match(content, /tier: worker/);

  const fm = readAgentFrontmatter(content);
  const backend = parseAgentBackend(fm);
  assert.equal(backend.vendor, 'anthropic');
  assert.equal(backend.transport, 'claude-native');
  assert.equal(backend.costModelClass, 'subscription');
});

test('replaces an existing backend block, preserving unrelated frontmatter keys and body byte-for-byte', () => {
  const root = setupFixtureRoot();
  const filePath = path.join(root, '.claude', 'agents', 'existing-backend.md');
  const before = fs.readFileSync(filePath, 'utf8');
  const bodyBefore = before.split(/\n---\n/).slice(1).join('\n---\n');

  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);

  const after = fs.readFileSync(filePath, 'utf8');
  const bodyAfter = after.split(/\n---\n/).slice(1).join('\n---\n');
  assert.equal(bodyAfter, bodyBefore, 'body must be preserved byte-for-byte');
  assert.match(after, /description: Has a backend block already\./);

  const fm = readAgentFrontmatter(after);
  const backend = parseAgentBackend(fm);
  assert.equal(backend.vendor, 'moonshot');
  assert.equal(backend.transport, 'openai-compatible');
  assert.equal(backend.model, 'moonshot/kimi-k2');
  assert.equal(backend.costModelClass, 'local');
  assert.equal(backend.endpointEnv, 'KIMI_ENDPOINT_URL');
  assert.equal(backend.apiKeyEnv, 'KIMI_API_KEY');
  assert.match(after, /# managed-by: tycoon-routing/);

  // The original hand-written backend block (existing-backend.md's fixture
  // has one, with no managed-by marker) must be snapshotted before being
  // overwritten, so a later unapply can restore it.
  const backupDoc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'tycoon', 'routing.backup.json'), 'utf8'));
  assert.ok(backupDoc.agents['existing-backend'], 'backup entry recorded for existing-backend');
  assert.ok(Array.isArray(backupDoc.agents['existing-backend'].lines));
  assert.match(backupDoc.agents['existing-backend'].lines.join('\n'), /model: anthropic\/claude-sonnet-4-6/);
  assert.doesNotMatch(backupDoc.agents['existing-backend'].lines.join('\n'), /managed-by: tycoon-routing/);
});

test('apply over a hand-written block, then unapply, restores the original bytes exactly', () => {
  const root = setupFixtureRoot();
  const filePath = path.join(root, '.claude', 'agents', 'existing-backend.md');
  const before = fs.readFileSync(filePath, 'utf8');

  const applied = run(['--root', root]);
  assert.equal(applied.status, 0, applied.stderr);
  const afterApply = fs.readFileSync(filePath, 'utf8');
  assert.notEqual(afterApply, before, 'apply should have changed the file');

  fs.unlinkSync(path.join(root, '.claude', 'tycoon', 'routing.json'));
  const cleared = run(['--root', root]);
  assert.equal(cleared.status, 0, cleared.stderr);

  const restored = fs.readFileSync(filePath, 'utf8');
  assert.equal(restored, before, 'unapply must restore the original hand-written block byte-for-byte');
});

test('apply twice then unapply still restores the original (backup not overwritten by the managed block)', () => {
  const root = setupFixtureRoot();
  const filePath = path.join(root, '.claude', 'agents', 'existing-backend.md');
  const before = fs.readFileSync(filePath, 'utf8');

  const first = run(['--root', root]);
  assert.equal(first.status, 0, first.stderr);
  const second = run(['--root', root]);
  assert.equal(second.status, 0, second.stderr);

  fs.unlinkSync(path.join(root, '.claude', 'tycoon', 'routing.json'));
  const cleared = run(['--root', root]);
  assert.equal(cleared.status, 0, cleared.stderr);

  const restored = fs.readFileSync(filePath, 'utf8');
  assert.equal(restored, before, 'two applies then an unapply must still restore the pre-apply original');
});

test('agent without a prior backend block: unapply leaves no block', () => {
  const root = setupFixtureRoot();
  const applied = run(['--root', root]);
  assert.equal(applied.status, 0, applied.stderr);
  const filePath = path.join(root, '.claude', 'agents', 'no-backend.md');
  const afterApply = fs.readFileSync(filePath, 'utf8');
  assert.match(afterApply, /managed-by: tycoon-routing/);

  fs.unlinkSync(path.join(root, '.claude', 'tycoon', 'routing.json'));
  const cleared = run(['--root', root]);
  assert.equal(cleared.status, 0, cleared.stderr);

  const afterClear = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(afterClear, /backend:/, 'no backend block at all, since none existed before apply');
});

test('applies orchestrator slot to the role: orchestrator agent file', () => {
  const root = setupFixtureRoot();
  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);

  const filePath = path.join(root, '.claude', 'agents', 'orchestrator.md');
  const content = fs.readFileSync(filePath, 'utf8');
  const fm = readAgentFrontmatter(content);
  const backend = parseAgentBackend(fm);
  assert.equal(backend.vendor, 'opencode');
  assert.equal(backend.transport, 'openai-compatible');
  assert.equal(backend.model, 'opencode/big-pickle');
  assert.equal(backend.endpointEnv, 'OPENCODE_ENDPOINT_URL');
});

test('writes routing.resolved.json with agents and orchestrator', () => {
  const root = setupFixtureRoot();
  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);

  const resolvedPath = path.join(root, '.claude', 'tycoon', 'routing.resolved.json');
  const doc = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  assert.ok(doc.agents['existing-backend']);
  assert.ok(doc.agents['no-backend']);
  assert.equal(doc.agents['existing-backend'].backend.vendor, 'moonshot');
  assert.ok(doc.orchestrator);
  assert.equal(doc.orchestrator.backend.vendor, 'opencode');
  assert.equal(doc.agents['ghost-agent'], undefined);
});

test('ghost agent in profile with no matching file is warned, not created', () => {
  const root = setupFixtureRoot();
  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ghost-agent/);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'agents', 'ghost-agent.md')), false);
});

test('file with no frontmatter block is reported and left untouched', () => {
  const root = setupFixtureRoot();
  const dir = path.join(root, '.claude', 'agents');
  const noFmPath = path.join(dir, 'no-backend.md'); // temporarily overwrite with no-frontmatter content
  const plainContent = '# Plain\n\nNo frontmatter at all.\n';
  fs.writeFileSync(noFmPath, plainContent, 'utf8');

  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no YAML frontmatter block found/);
  assert.equal(fs.readFileSync(noFmPath, 'utf8'), plainContent);
});

test('second run is idempotent (no diffs after first run)', () => {
  const root = setupFixtureRoot();
  const first = run(['--root', root]);
  assert.equal(first.status, 0, first.stderr);

  const before = {};
  for (const f of ['existing-backend.md', 'no-backend.md', 'orchestrator.md']) {
    before[f] = fs.readFileSync(path.join(root, '.claude', 'agents', f), 'utf8');
  }
  const resolvedBefore = fs.readFileSync(path.join(root, '.claude', 'tycoon', 'routing.resolved.json'), 'utf8');

  const second = run(['--root', root]);
  assert.equal(second.status, 0, second.stderr);

  for (const f of Object.keys(before)) {
    const after = fs.readFileSync(path.join(root, '.claude', 'agents', f), 'utf8');
    assert.equal(after, before[f], `${f} must be unchanged on second run`);
  }
  const resolvedAfter = fs.readFileSync(path.join(root, '.claude', 'tycoon', 'routing.resolved.json'), 'utf8');
  assert.equal(resolvedAfter, resolvedBefore);

  // --check should now report no changes.
  const checkResult = run(['--root', root, '--check']);
  assert.equal(checkResult.status, 0, checkResult.stdout + checkResult.stderr);
});

test('--check reports files that would change and exits 1 without writing', () => {
  const root = setupFixtureRoot();
  const filePath = path.join(root, '.claude', 'agents', 'no-backend.md');
  const before = fs.readFileSync(filePath, 'utf8');

  const result = run(['--root', root, '--check']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-backend\.md/);

  const after = fs.readFileSync(filePath, 'utf8');
  assert.equal(after, before, '--check must not write');
  assert.equal(fs.existsSync(path.join(root, '.claude', 'tycoon', 'routing.resolved.json')), false);
});

test('invalid routing.json: exits 2, prints errors, writes nothing', () => {
  const root = mkTempRoot();
  writeAgent(root, 'some-agent.md', ['name: some-agent', 'model: sonnet'], '# Some Agent\n\nBody.');
  const dir = path.join(root, '.claude', 'tycoon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routing.json'), JSON.stringify({
    version: 1,
    agents: {
      'some-agent': { transport: 'ssh' },
    },
  }), 'utf8');

  const before = fs.readFileSync(path.join(root, '.claude', 'agents', 'some-agent.md'), 'utf8');
  const result = run(['--root', root]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /transport/);

  const after = fs.readFileSync(path.join(root, '.claude', 'agents', 'some-agent.md'), 'utf8');
  assert.equal(after, before);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'tycoon', 'routing.resolved.json')), false);
});

test('CRLF agent file: backend block round-trips, parses correctly, keeps CRLF, idempotent', () => {
  const root = mkTempRoot();
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const crlfContent = [
    '---',
    'name: crlf-agent',
    'description: A CRLF-authored agent file.',
    'model: sonnet',
    'tier: worker',
    '---',
    '',
    '# CRLF Agent',
    '',
    'Body text.',
    'Second line.',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'crlf-agent.md'), crlfContent, 'utf8');

  writeRoutingProfile(root, {
    version: 1,
    agents: {
      'crlf-agent': {
        vendor: 'anthropic',
        transport: 'claude-native',
        model: 'sonnet',
        costModelClass: 'subscription',
      },
    },
  });

  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);

  const filePath = path.join(dir, 'crlf-agent.md');
  const after = fs.readFileSync(filePath, 'utf8');

  // Every line ending stays CRLF; no bare LF was introduced.
  assert.equal(/(?<!\r)\n/.test(after), false, 'no bare LF should appear in a CRLF file');
  assert.match(after, /description: A CRLF-authored agent file\.\r\n/);
  assert.match(after, /# CRLF Agent\r\n\r\nBody text\.\r\nSecond line\.\r\n$/);

  const fm = readAgentFrontmatter(after);
  const backend = parseAgentBackend(fm);
  assert.equal(backend.vendor, 'anthropic');
  assert.equal(backend.transport, 'claude-native');
  assert.equal(backend.model, 'sonnet');
  assert.equal(backend.costModelClass, 'subscription');

  // Idempotent: a second run produces byte-identical output.
  const second = run(['--root', root]);
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = fs.readFileSync(filePath, 'utf8');
  assert.equal(afterSecond, after, 'second run must be byte-identical (idempotent)');
});

test('CRLF file with a hand-written backend block: unapply restores exact CRLF bytes', () => {
  const root = mkTempRoot();
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const crlfContent = [
    '---',
    'name: crlf-handwritten',
    'description: A CRLF agent with its own backend block.',
    'backend:',
    '  vendor: anthropic',
    '  transport: claude-native',
    '  model: opus',
    '  costModelClass: metered',
    '---',
    '',
    '# CRLF Handwritten',
    '',
    'Body text.',
    '',
  ].join('\r\n');
  const filePath = path.join(dir, 'crlf-handwritten.md');
  fs.writeFileSync(filePath, crlfContent, 'utf8');
  const before = fs.readFileSync(filePath, 'utf8');

  writeRoutingProfile(root, {
    version: 1,
    agents: {
      'crlf-handwritten': { vendor: 'moonshot', transport: 'openai-compatible', model: 'moonshot/kimi-k2', costModelClass: 'local' },
    },
  });

  const applied = run(['--root', root]);
  assert.equal(applied.status, 0, applied.stderr);
  const afterApply = fs.readFileSync(filePath, 'utf8');
  assert.match(afterApply, /managed-by: tycoon-routing/);
  assert.equal(/(?<!\r)\n/.test(afterApply), false, 'no bare LF introduced by apply');

  fs.unlinkSync(path.join(root, '.claude', 'tycoon', 'routing.json'));
  const cleared = run(['--root', root]);
  assert.equal(cleared.status, 0, cleared.stderr);
  const restored = fs.readFileSync(filePath, 'utf8');
  assert.equal(restored, before, 'CRLF original restored byte-for-byte');
  assert.equal(/(?<!\r)\n/.test(restored), false, 'no bare LF introduced by unapply');
});

test('removing an agent from the profile strips only that agent\'s managed backend block, keeps the other', () => {
  const root = setupFixtureRoot();
  const first = run(['--root', root]);
  assert.equal(first.status, 0, first.stderr);

  // Rewrite routing.json without 'existing-backend' (drop it from the profile).
  writeRoutingProfile(root, {
    version: 1,
    orchestrator: {
      vendor: 'opencode',
      transport: 'openai-compatible',
      model: 'opencode/big-pickle',
      costModelClass: 'local',
      endpointEnv: 'OPENCODE_ENDPOINT_URL',
    },
    agents: {
      'no-backend': {
        vendor: 'anthropic',
        transport: 'claude-native',
        model: 'sonnet',
        costModelClass: 'subscription',
      },
    },
  });

  const second = run(['--root', root]);
  assert.equal(second.status, 0, second.stderr);

  // existing-backend.md had a HAND-WRITTEN backend block before the first
  // apply, so dropping it from the profile must restore that original block
  // (from routing.backup.json) rather than leaving no block at all.
  const removedContent = fs.readFileSync(path.join(root, '.claude', 'agents', 'existing-backend.md'), 'utf8');
  assert.doesNotMatch(removedContent, /managed-by: tycoon-routing/);
  assert.match(removedContent, /backend:/, 'original hand-written backend block restored for the dropped agent');
  assert.match(removedContent, /model: anthropic\/claude-sonnet-4-6/, 'restored block matches the pre-apply original, not the managed one');
  assert.match(removedContent, /description: Has a backend block already\./, 'other frontmatter keys preserved');
  assert.match(removedContent, /# Existing Backend\n\nSome body text\.\nSecond line\.\n$/, 'body preserved byte-for-byte');

  const keptContent = fs.readFileSync(path.join(root, '.claude', 'agents', 'no-backend.md'), 'utf8');
  assert.match(keptContent, /managed-by: tycoon-routing/, 'kept agent still carries its managed block');

  const resolvedPath = path.join(root, '.claude', 'tycoon', 'routing.resolved.json');
  const doc = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  assert.equal(doc.agents['existing-backend'], undefined);
  assert.ok(doc.agents['no-backend']);
});

test('clearing the profile (no routing.json) removes all managed blocks, leaves unmanaged backend blocks untouched, and restores byte-identical content', () => {
  const root = mkTempRoot();

  // Agent with a HAND-WRITTEN backend block (no managed-by marker) — must
  // never be touched by unapply.
  const handWrittenLines = [
    'name: hand-written',
    'description: Has a hand-authored backend block.',
    'backend:',
    '  vendor: anthropic',
    '  transport: claude-native',
    '  model: opus',
    '  costModelClass: metered',
  ];
  writeAgent(root, 'hand-written.md', handWrittenLines, '# Hand Written\n\nBody.');
  const handWrittenBefore = fs.readFileSync(path.join(root, '.claude', 'agents', 'hand-written.md'), 'utf8');

  // Agent starting with NO backend block; fixture snapshot for comparison
  // after apply -> clear round trip.
  writeAgent(root, 'plain.md', ['name: plain', 'description: No backend yet.', 'model: sonnet', 'tier: worker'], '# Plain\n\nBody text.\nSecond line.');
  const plainBefore = fs.readFileSync(path.join(root, '.claude', 'agents', 'plain.md'), 'utf8');

  writeRoutingProfile(root, {
    version: 1,
    agents: {
      plain: { vendor: 'anthropic', transport: 'claude-native', model: 'sonnet', costModelClass: 'subscription' },
    },
  });

  const applied = run(['--root', root]);
  assert.equal(applied.status, 0, applied.stderr);
  const plainApplied = fs.readFileSync(path.join(root, '.claude', 'agents', 'plain.md'), 'utf8');
  assert.match(plainApplied, /managed-by: tycoon-routing/);

  // hand-written.md was never targeted by the profile, so it should be
  // untouched by the apply run itself.
  assert.equal(fs.readFileSync(path.join(root, '.claude', 'agents', 'hand-written.md'), 'utf8'), handWrittenBefore);

  // Now clear the profile.
  fs.unlinkSync(path.join(root, '.claude', 'tycoon', 'routing.json'));
  const cleared = run(['--root', root]);
  assert.equal(cleared.status, 0, cleared.stderr);

  const plainAfterClear = fs.readFileSync(path.join(root, '.claude', 'agents', 'plain.md'), 'utf8');
  assert.equal(plainAfterClear, plainBefore, 'plain.md must be byte-identical to its pre-apply fixture after clear');

  const handWrittenAfterClear = fs.readFileSync(path.join(root, '.claude', 'agents', 'hand-written.md'), 'utf8');
  assert.equal(handWrittenAfterClear, handWrittenBefore, 'a hand-written backend block (no marker) must never be touched');
  assert.match(handWrittenAfterClear, /model: opus/);

  assert.equal(fs.existsSync(path.join(root, '.claude', 'tycoon', 'routing.resolved.json')), false, 'routing.resolved.json must be removed on clear');
});

test('no routing.json present: exits 0, writes nothing', () => {
  const root = mkTempRoot();
  writeAgent(root, 'some-agent.md', ['name: some-agent', 'model: sonnet'], '# Some Agent\n\nBody.');
  const before = fs.readFileSync(path.join(root, '.claude', 'agents', 'some-agent.md'), 'utf8');

  const result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(path.join(root, '.claude', 'agents', 'some-agent.md'), 'utf8');
  assert.equal(after, before);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'tycoon', 'routing.resolved.json')), false);
});
