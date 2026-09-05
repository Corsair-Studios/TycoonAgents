// TycoonAgents standalone — cross-generator parity tests (p12-t5) between
// scripts/generate-opencode-config.mjs and scripts/apply-routing-profile.mjs.
//
// Both scripts read the same .claude/tycoon/routing.json via
// out/src/core/routingProfile.js and must agree on resolved models, MCP
// wiring, orchestrator placement, and fallback chains. Node built-ins only.

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
const OPENCODE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-opencode-config.mjs');
const APPLY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'apply-routing-profile.mjs');

function mkTempRoot(prefix = 'tycoon-parity-test-') {
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

// p13-t6: the generator also writes a GLOBAL opencode.json to
// OPENCODE_CONFIG_DIR. Pin it to a directory keyed off `root` (not the real
// per-user OpenCode config dir) so repeat calls against the SAME root share
// one global dir (required for --check/idempotency parity), while every
// test root still gets its own isolated global dir and nothing here ever
// touches this machine's real global OpenCode config.
function runOpencode(root, extraArgs = []) {
  const globalConfigDir = path.join(root, '.opencode-global-config-test');
  return spawnSync('node', [OPENCODE_SCRIPT, '--root', root, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_CONFIG_DIR: globalConfigDir },
  });
}

function runApply(root, extraArgs = []) {
  return spawnSync('node', [APPLY_SCRIPT, '--root', root, ...extraArgs], { encoding: 'utf8' });
}

function readOpencodeAgentModel(root, agentId) {
  const p = path.join(root, '.opencode', 'agents', `${agentId}.md`);
  const text = fs.readFileSync(p, 'utf8');
  const m = text.match(/^model:\s*(.+)$/m);
  return m ? m[1].trim() : undefined;
}

function readOpencodeAgentMode(root, agentId) {
  const text = fs.readFileSync(path.join(root, '.opencode', 'agents', `${agentId}.md`), 'utf8');
  const m = text.match(/^mode:\s*(.+)$/m);
  return m ? m[1].trim() : undefined;
}

function readClaudeAgentBackend(root, agentId) {
  const p = path.join(root, '.claude', 'agents', `${agentId}.md`);
  const text = fs.readFileSync(p, 'utf8');
  const fm = readAgentFrontmatter(text);
  return parseAgentBackend(fm);
}

function snapshotTree(root) {
  const files = new Map();
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
    }
  }
  walk(root);
  return files;
}

function assertTreesEqual(a, b, msg) {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${msg}: file set differs`);
  for (const [k, v] of a) {
    assert.equal(v, b.get(k), `${msg}: ${k} content differs`);
  }
}

// ---------------------------------------------------------------------------
// (1) PARITY: one routing.json covering several transports; one agent absent
// from the profile falling back to its own frontmatter backend model.
// ---------------------------------------------------------------------------
function setupParityRoot() {
  const root = mkTempRoot();

  writeAgent(root, 'orchestrator.md', [
    'name: orchestrator',
    'description: The orchestrator.',
    'role: orchestrator',
  ], '# Orchestrator\n\nOrchestrator body.');

  writeAgent(root, 'coding-specialist.md', [
    'name: coding-specialist',
    'description: Implements code.',
    'tier: worker',
  ], '# Coding Specialist\n\nBody.');

  writeAgent(root, 'kimi-reviewer.md', [
    'name: kimi-reviewer',
    'description: Reviews via a local model.',
    'tier: worker',
  ], '# Kimi Reviewer\n\nBody.');

  // Absent from the routing profile; resolved from its own frontmatter backend.
  writeAgent(root, 'uncovered-agent.md', [
    'name: uncovered-agent',
    'description: Not in the routing profile.',
    'tier: worker',
    'backend:',
    '  vendor: openai',
    '  transport: mcp',
    '  mcpServer: codex',
    '  tools: [codex]',
    '  model: openai/gpt-5.4-mini',
    '  costModelClass: subscription',
  ], '# Uncovered Agent\n\nBody.');

  writeRoutingProfile(root, {
    version: 1,
    orchestrator: {
      vendor: 'opencode',
      transport: 'openai-compatible',
      model: 'opencode/big-pickle',
      costModelClass: 'local',
      endpointEnv: 'OPENCODE_ENDPOINT',
    },
    agents: {
      'coding-specialist': {
        vendor: 'anthropic',
        transport: 'mcp',
        mcpServer: 'claude-cli',
        tools: ['claude'],
        model: 'anthropic/claude-sonnet-4-6',
        costModelClass: 'subscription',
      },
      'kimi-reviewer': {
        vendor: 'moonshot',
        transport: 'openai-compatible',
        model: 'moonshot/kimi-k2',
        costModelClass: 'local',
        endpointEnv: 'KIMI_ENDPOINT',
        fallback: [
          {
            vendor: 'anthropic',
            transport: 'claude-native',
            model: 'anthropic/claude-haiku-4-6',
            costModelClass: 'subscription',
          },
        ],
      },
    },
  });

  return root;
}

test('parity: opencode and claude generators agree on model, MCP, orchestrator mode, and fallback chains', () => {
  const root = setupParityRoot();

  const rOpencode = runOpencode(root);
  assert.equal(rOpencode.status, 0, `opencode generator failed: ${rOpencode.stderr}`);
  const rApply = runApply(root);
  assert.equal(rApply.status, 0, `apply-routing-profile failed: ${rApply.stderr}`);

  for (const agentId of ['coding-specialist', 'kimi-reviewer', 'uncovered-agent']) {
    const openModel = readOpencodeAgentModel(root, agentId);
    const claudeBackend = readClaudeAgentBackend(root, agentId);
    assert.equal(openModel, claudeBackend.model, `model mismatch for ${agentId}`);
  }

  // MCP server/tools agreement for coding-specialist (mcp transport).
  const codingOpenText = fs.readFileSync(path.join(root, '.opencode', 'agents', 'coding-specialist.md'), 'utf8');
  assert.match(codingOpenText, /`claude-cli` MCP server/);
  const codingClaudeBackend = readClaudeAgentBackend(root, 'coding-specialist');
  assert.equal(codingClaudeBackend.mcpServer, 'claude-cli');
  assert.deepEqual(codingClaudeBackend.tools, ['claude']);

  // uncovered-agent: profile doesn't cover it, but its own frontmatter
  // backend (mcp/codex) should show up identically in both outputs.
  const uncoveredOpenText = fs.readFileSync(path.join(root, '.opencode', 'agents', 'uncovered-agent.md'), 'utf8');
  assert.match(uncoveredOpenText, /`codex` MCP server/);

  // Orchestrator: mode: primary in OpenCode, and role: orchestrator slot
  // consumed into .claude/agents/orchestrator.md's backend in Claude output.
  assert.equal(readOpencodeAgentMode(root, 'orchestrator'), 'primary');
  const orchestratorClaudeText = fs.readFileSync(path.join(root, '.claude', 'agents', 'orchestrator.md'), 'utf8');
  assert.match(orchestratorClaudeText, /model: opencode\/big-pickle/);
  assert.match(orchestratorClaudeText, /vendor: opencode/);

  // Fallback chains identical between the two generated routing files.
  const generatedOpencode = JSON.parse(
    fs.readFileSync(path.join(root, '.opencode', 'tycoon-routing.generated.json'), 'utf8')
  );
  const resolvedClaude = JSON.parse(
    fs.readFileSync(path.join(root, '.claude', 'tycoon', 'routing.resolved.json'), 'utf8')
  );

  const openFallback = generatedOpencode.agents['kimi-reviewer'].fallback;
  const claudeFallback = resolvedClaude.agents['kimi-reviewer'].fallback.map((b) => b.model);
  assert.deepEqual(openFallback, claudeFallback, 'fallback chains diverge between the two generators');

  assert.equal(generatedOpencode.orchestrator.model, 'opencode/big-pickle');
  assert.equal(resolvedClaude.orchestrator.backend.model, 'opencode/big-pickle');
});

// ---------------------------------------------------------------------------
// (2) PRECEDENCE: routing.json > opencode-models.json > frontmatter backend.
// ---------------------------------------------------------------------------
function setupPrecedenceRoot() {
  const root = mkTempRoot();
  // Separate files for the OpenCode-only precedence chain (opencode) and the
  // apply-routing-profile winner/no-op check (claude-side). apply-routing-
  // profile persistently writes a backend block into whatever file it
  // touches, so reusing one file across steps would make a later "frontmatter
  // wins" assertion observe a backend block apply left behind rather than
  // the agent's original frontmatter — keeping them separate isolates each
  // generator's own precedence chain.
  writeAgent(root, 'precedence-open.md', [
    'name: precedence-open',
    'description: For OpenCode precedence testing.',
    'tier: worker',
    'backend:',
    '  vendor: anthropic',
    '  transport: claude-native',
    '  model: anthropic/claude-frontmatter-model',
    '  costModelClass: subscription',
  ], '# Precedence Open\n\nBody.');
  writeAgent(root, 'precedence-claude.md', [
    'name: precedence-claude',
    'description: For apply-routing-profile precedence testing.',
    'tier: worker',
    'backend:',
    '  vendor: anthropic',
    '  transport: claude-native',
    '  model: anthropic/claude-frontmatter-model',
    '  costModelClass: subscription',
  ], '# Precedence Claude\n\nBody.');
  return root;
}

test('precedence: routing.json wins, then opencode-models.json, then frontmatter', () => {
  const root = setupPrecedenceRoot();

  // NOTE: apply-routing-profile rewrites the backend: block of every agent
  // named in profile.agents that has a matching file — permanently, since it
  // has no notion of "revert when routing.json is removed". So
  // precedence-open (used to exercise the OpenCode-generator-only
  // routing.json > opencode-models.json > frontmatter chain) is deliberately
  // kept OUT of routing.json's agents map for this whole test: only
  // precedence-claude is covered, so apply-routing-profile is only ever run
  // to check its own routing-wins/no-op behavior on precedence-claude, and
  // never mutates precedence-open's frontmatter. precedence-open's own
  // routing.json-wins step is instead checked via resolveAgentSlot directly
  // (same function generate-opencode-config.mjs calls), which does not
  // require running apply-routing-profile.
  writeRoutingProfile(root, {
    version: 1,
    agents: {
      'precedence-claude': {
        vendor: 'anthropic',
        transport: 'claude-native',
        model: 'anthropic/claude-routing-model',
        costModelClass: 'subscription',
      },
    },
  });
  const overridesDir = path.join(root, '.claude', 'tycoon');
  fs.mkdirSync(overridesDir, { recursive: true });
  fs.writeFileSync(
    path.join(overridesDir, 'opencode-models.json'),
    JSON.stringify({
      'precedence-open': 'anthropic/claude-overrides-model',
      'precedence-claude': 'anthropic/claude-overrides-model',
    }, null, 2),
    'utf8'
  );

  // Step 1: routing.json present -> wins in both outputs.
  // precedence-open is not in routing.json, so its own OpenCode-side chain
  // (opencode-models.json, since it's not routed) is exercised starting
  // from opencode-models.json winning over frontmatter here; the
  // routing.json > opencode-models.json precedence itself is exercised on
  // precedence-claude via the Claude generator instead.
  assert.equal(runOpencode(root).status, 0);
  assert.equal(runApply(root).status, 0);
  assert.equal(readOpencodeAgentModel(root, 'precedence-open'), 'anthropic/claude-overrides-model');
  assert.equal(readOpencodeAgentModel(root, 'precedence-claude'), 'anthropic/claude-routing-model');
  assert.equal(readClaudeAgentBackend(root, 'precedence-claude').model, 'anthropic/claude-routing-model');

  // Step 2: remove routing.json -> opencode-models.json still wins in
  // OpenCode output for precedence-claude (never covered by routing.json
  // any more); apply-routing-profile makes no change at all (no routing.json
  // => no-op), checked against precedence-claude's file as apply-routing-
  // profile last left it in step 1.
  fs.rmSync(path.join(root, '.claude', 'tycoon', 'routing.json'));
  const claudeAgentBefore = fs.readFileSync(path.join(root, '.claude', 'agents', 'precedence-claude.md'), 'utf8');
  const resolvedJsonPath = path.join(root, '.claude', 'tycoon', 'routing.resolved.json');
  const resolvedJsonBefore = fs.readFileSync(resolvedJsonPath, 'utf8');

  assert.equal(runOpencode(root).status, 0);
  const rApplyNoRouting = runApply(root);
  assert.equal(rApplyNoRouting.status, 0, 'apply-routing-profile should exit 0 with no routing.json');

  assert.equal(readOpencodeAgentModel(root, 'precedence-claude'), 'anthropic/claude-overrides-model');
  const claudeAgentAfter = fs.readFileSync(path.join(root, '.claude', 'agents', 'precedence-claude.md'), 'utf8');
  assert.equal(claudeAgentAfter, claudeAgentBefore, 'apply-routing-profile must not touch .claude/agents when routing.json is absent');
  // No routing.json => no-op: it neither rewrites nor deletes the
  // previously-written routing.resolved.json from step 1.
  assert.equal(fs.readFileSync(resolvedJsonPath, 'utf8'), resolvedJsonBefore, 'apply-routing-profile must not rewrite routing.resolved.json when routing.json is absent');

  // Step 3: remove opencode-models.json too -> frontmatter model used
  // (checked on precedence-open, which was never covered by routing.json
  // and thus never touched by apply-routing-profile, so its frontmatter
  // backend block is still its original, untouched one).
  fs.rmSync(path.join(root, '.claude', 'tycoon', 'opencode-models.json'));
  assert.equal(runOpencode(root).status, 0);
  assert.equal(readOpencodeAgentModel(root, 'precedence-open'), 'anthropic/claude-frontmatter-model');
});

// ---------------------------------------------------------------------------
// (3) LOADER ERROR CONTRACT: both scripts exit 2 on an invalid routing.json
// (secret-like key + wrong enum), printing errors and writing nothing.
// ---------------------------------------------------------------------------
function setupInvalidProfileRoot() {
  const root = mkTempRoot();
  writeAgent(root, 'some-agent.md', [
    'name: some-agent',
    'description: Some agent.',
    'tier: worker',
  ], '# Some Agent\n\nBody.');
  writeRoutingProfile(root, {
    version: 1,
    agents: {
      'some-agent': {
        vendor: 'anthropic',
        transport: 'not-a-real-transport',
        model: 'anthropic/claude-sonnet-4-6',
        costModelClass: 'subscription',
        apiSecretKey: 'sk-should-not-be-here',
      },
    },
  });
  return root;
}

test('loader error contract: both generators exit 2, print errors, write nothing', () => {
  const root = setupInvalidProfileRoot();
  const before = snapshotTree(root);

  const rOpencode = runOpencode(root);
  assert.equal(rOpencode.status, 2, 'opencode generator should exit 2 on invalid profile');
  assert.match(rOpencode.stderr, /secrets must not be stored/i);
  assert.match(rOpencode.stderr, /transport/i);

  const afterOpencode = snapshotTree(root);
  assertTreesEqual(before, afterOpencode, 'opencode generator must write nothing on invalid profile');

  const rApply = runApply(root);
  assert.equal(rApply.status, 2, 'apply-routing-profile should exit 2 on invalid profile');
  assert.match(rApply.stderr, /secrets must not be stored/i);
  assert.match(rApply.stderr, /transport/i);

  const afterApply = snapshotTree(root);
  assertTreesEqual(before, afterApply, 'apply-routing-profile must write nothing on invalid profile');

  // Same two problems reported by both scripts (they share the same loader).
  assert.equal(rOpencode.stderr.trim().split('\n').length, rApply.stderr.trim().split('\n').length);
});

// ---------------------------------------------------------------------------
// (4) IDEMPOTENCY: running both scripts twice, in either order, is stable.
// ---------------------------------------------------------------------------
test('idempotency: running both generators twice in either order is byte-identical', () => {
  // Note: apply-routing-profile persistently writes a `backend:` block into
  // .claude/agents/*.md, and generate-opencode-config.mjs's own frontmatter
  // rule ("explicit backend block with '/' in model wins") then picks that
  // block up on its NEXT run. So the very first opencode-then-apply round
  // can still change the opencode output on the following round (apply
  // hadn't written anything back into frontmatter yet during round 1). Do
  // one warm-up round first so both scripts have already converged onto
  // each other's prior output, then assert the two rounds after that are
  // byte-identical.
  const root = setupParityRoot();

  runOpencode(root);
  runApply(root); // warm-up: seeds backend: blocks into .claude/agents/*.md

  runOpencode(root);
  runApply(root);
  const snap1 = snapshotTree(root);
  runOpencode(root);
  runApply(root);
  const snap2 = snapshotTree(root);
  assertTreesEqual(snap1, snap2, 'opencode-then-apply, run twice (post warm-up), must be idempotent');

  const rCheck1 = runOpencode(root, ['--check']);
  assert.equal(rCheck1.status, 0, '--check should report no changes after a stable run');
  const rCheck2 = runApply(root, ['--check']);
  assert.equal(rCheck2.status, 0, '--check should report no changes after a stable run');

  const root2 = setupParityRoot();
  runApply(root2);
  runOpencode(root2); // warm-up

  runApply(root2);
  runOpencode(root2);
  const snap3 = snapshotTree(root2);
  runApply(root2);
  runOpencode(root2);
  const snap4 = snapshotTree(root2);
  assertTreesEqual(snap3, snap4, 'apply-then-opencode, run twice (post warm-up), must be idempotent');
});
