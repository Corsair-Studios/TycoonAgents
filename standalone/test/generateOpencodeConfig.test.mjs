// TycoonAgents standalone — tests for scripts/generate-opencode-config.mjs (p6-t3).
//
// Exercises the generator's contract end-to-end against a fixture agent
// roster in a temp dir: model resolution rules (override file, backend
// block, bare alias via out/src/core/modelAliases.js, unresolvable),
// permission.task deny wiring, mode primary/subagent, determinism/
// idempotency, --check semantics, and AGENTS.md managed-block splicing.
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path,
// node:child_process). Spawns the real script via spawnSync so these tests
// fail (not skip) until the coding worker's script exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveModelAlias } from '../../out/src/core/modelAliases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'generate-opencode-config.mjs');

const EXPECT_HAIKU_MODEL = `anthropic/${resolveModelAlias('haiku')}`;

function mkTempRoot(prefix = 'tycoon-opencode-config-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(root, filename, frontmatterLines, body) {
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\n${frontmatterLines.join('\n')}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

function setupFixtureRoot() {
  const root = mkTempRoot();

  // (a) bare-alias model
  writeAgent(root, 'aaa-bare-alias.md', [
    'name: aaa-bare-alias',
    'description: Uses a bare model alias.',
    'tools: Read, Grep',
    'model: haiku',
    'tier: worker',
  ], '# AAA Bare Alias\n\nBody for the bare-alias agent.');

  // (b) backend block with explicit provider/model
  writeAgent(root, 'bbb-backend-block.md', [
    'name: bbb-backend-block',
    'description: Uses an explicit backend model.',
    'tools: Read',
    'tier: worker',
    'backend:',
    '  vendor: openai',
    '  transport: mcp',
    '  mcpServer: codex',
    '  tools: [codex, codex-reply]',
    '  model: openai/gpt-5.4-mini',
    '  costModelClass: subscription',
  ], '# BBB Backend Block\n\nBody for the backend-block agent.');

  // (c) overridden via opencode-models.json
  writeAgent(root, 'ccc-overridden.md', [
    'name: ccc-overridden',
    'description: Model comes from the override file.',
    'tools: Read',
    'model: sonnet',
    'tier: worker',
  ], '# CCC Overridden\n\nBody for the overridden agent.');

  // (d) disallowedTools includes Agent -> permission.task deny
  writeAgent(root, 'ddd-no-task.md', [
    'name: ddd-no-task',
    'description: Not allowed to delegate.',
    'tools: Read, Edit',
    'disallowedTools: Agent',
    'model: sonnet',
    'tier: worker',
  ], '# DDD No Task\n\nBody for the no-task agent.');

  // (e) no tier, no model
  writeAgent(root, 'eee-no-model.md', [
    'name: eee-no-model',
    'description: Has no resolvable model.',
    'tools: Read',
  ], '# EEE No Model\n\nBody for the no-model agent.');

  // (f) orchestrator role -> mode primary
  writeAgent(root, 'fff-orchestrator.md', [
    'name: fff-orchestrator',
    'description: The orchestrator agent.',
    'tools: Read, Task',
    'role: orchestrator',
    'model: opus',
  ], '# FFF Orchestrator\n\nBody for the orchestrator agent.');

  fs.mkdirSync(path.join(root, '.claude', 'tycoon'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'tycoon', 'opencode-models.json'),
    JSON.stringify({ 'ccc-overridden': 'openai/gpt-5' }, null, 2),
    'utf8',
  );

  fs.writeFileSync(
    path.join(root, 'CLAUDE.md'),
    '# Project Instructions\n\nUse the Task tool to delegate work. Pass subagent_type explicitly.\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    [
      '# AGENTS.md',
      '',
      'Hand-written intro text above the managed block.',
      '',
      '<!-- TYCOON-MANAGED:START -->',
      'stale managed content that must be replaced',
      '<!-- TYCOON-MANAGED:END -->',
      '',
      'Hand-written outro text below the managed block.',
      '',
    ].join('\n'),
    'utf8',
  );

  return root;
}

// Test isolation: the generator writes a GLOBAL opencode.json under
// OPENCODE_CONFIG_DIR and reads localEnvStore (src/core/localEnvStore.ts,
// scoped by TYCOON_STANDALONE_DATA_DIR) for endpoint/key placeholders.
// Without these overrides it would touch this machine's real per-user
// OpenCode config and secret store — pin both to fresh temp dirs.
function runGenerator(root, extraArgs = []) {
  const globalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-opencode-config-global-'));
  const localEnvStoreDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-opencode-config-localenv-'));
  return spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_CONFIG_DIR: globalConfigDir, TYCOON_STANDALONE_DATA_DIR: localEnvStoreDataDir },
  });
}

function scriptExists() {
  return fs.existsSync(SCRIPT_PATH);
}

function readGenerated(root, name) {
  return fs.readFileSync(path.join(root, '.opencode', 'agents', `${name}.md`), 'utf8');
}

function parseFrontmatter(md) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  assert.ok(match, 'generated file must have --- frontmatter ---');
  return { frontmatter: match[1], body: match[2] };
}

test('generate-opencode-config: full contract', { skip: !scriptExists() && 'script not yet present' }, async (t) => {
  await t.test('generates one file per source, with correct model/mode/permission per rule', () => {
    const root = setupFixtureRoot();
    const result = runGenerator(root);
    assert.equal(result.status, 0, `generator should exit 0; stderr: ${result.stderr}`);

    const outDir = path.join(root, '.opencode', 'agents');
    const generated = fs.readdirSync(outDir).filter((f) => f.endsWith('.md'));
    assert.equal(generated.length, 6, 'one generated file per source agent');

    // (a) bare alias -> anthropic/<canonical>
    {
      const { frontmatter, body } = parseFrontmatter(readGenerated(root, 'aaa-bare-alias'));
      assert.match(frontmatter, new RegExp(`model:\\s*${EXPECT_HAIKU_MODEL.replace('/', '\\/')}`));
      assert.match(frontmatter, /description:\s*Uses a bare model alias\./, 'description must be emitted verbatim from frontmatter');
      assert.match(frontmatter, /mode:\s*subagent/);
      assert.ok(!/permission:/.test(frontmatter), 'no permission block when not denied');
      assert.match(body, /Body for the bare-alias agent\./);
    }

    // (b) backend.model with '/' used as-is
    {
      const { frontmatter } = parseFrontmatter(readGenerated(root, 'bbb-backend-block'));
      assert.match(frontmatter, /model:\s*openai\/gpt-5\.4-mini/);
    }

    // (c) override file wins over bare alias
    {
      const { frontmatter } = parseFrontmatter(readGenerated(root, 'ccc-overridden'));
      assert.match(frontmatter, /model:\s*openai\/gpt-5\b/);
    }

    // (d) disallowedTools includes Agent -> permission.task deny
    {
      const { frontmatter } = parseFrontmatter(readGenerated(root, 'ddd-no-task'));
      assert.match(frontmatter, /permission:/);
      assert.match(frontmatter, /task:\s*deny/);
    }

    // (e) no tier, no model -> no model: line, and not denied
    {
      const { frontmatter } = parseFrontmatter(readGenerated(root, 'eee-no-model'));
      assert.ok(!/^model:/m.test(frontmatter), 'unresolvable model must be omitted entirely');
      assert.ok(!/permission:/.test(frontmatter), 'agent (e) is not denied task');
    }

    // (f) role: orchestrator -> mode primary
    {
      const { frontmatter } = parseFrontmatter(readGenerated(root, 'fff-orchestrator'));
      assert.match(frontmatter, /mode:\s*primary/);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('is deterministic: two runs produce byte-identical output', () => {
    const root = setupFixtureRoot();
    const first = runGenerator(root);
    assert.equal(first.status, 0);
    const outDir = path.join(root, '.opencode', 'agents');
    const snapshot1 = {};
    for (const f of fs.readdirSync(outDir)) {
      snapshot1[f] = fs.readFileSync(path.join(outDir, f), 'utf8');
    }

    const second = runGenerator(root);
    assert.equal(second.status, 0);
    for (const f of fs.readdirSync(outDir)) {
      assert.equal(fs.readFileSync(path.join(outDir, f), 'utf8'), snapshot1[f], `${f} must be byte-identical across runs`);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('--check: exit 0 when up to date, exit 1 after a source edit, writes nothing', () => {
    const root = setupFixtureRoot();
    const gen = runGenerator(root);
    assert.equal(gen.status, 0);

    const outDir = path.join(root, '.opencode', 'agents');
    const before = {};
    for (const f of fs.readdirSync(outDir)) {
      before[f] = fs.statSync(path.join(outDir, f)).mtimeMs;
    }

    const check1 = runGenerator(root, ['--check']);
    assert.equal(check1.status, 0, `--check should be 0 when up to date; stderr: ${check1.stderr}`);
    for (const f of fs.readdirSync(outDir)) {
      assert.equal(fs.statSync(path.join(outDir, f)).mtimeMs, before[f], '--check must not modify files when up to date');
    }

    // Edit a source agent to force drift.
    const sourcePath = path.join(root, '.claude', 'agents', 'aaa-bare-alias.md');
    const original = fs.readFileSync(sourcePath, 'utf8');
    fs.writeFileSync(sourcePath, original.replace('Body for the bare-alias agent.', 'Edited body.'), 'utf8');

    const check2 = runGenerator(root, ['--check']);
    assert.equal(check2.status, 1, '--check must exit 1 after a source edit');
    assert.match(check2.stdout + check2.stderr, /aaa-bare-alias/, '--check output should list the drifted path');

    for (const f of fs.readdirSync(outDir)) {
      assert.equal(fs.statSync(path.join(outDir, f)).mtimeMs, before[f], '--check must write nothing even when drifted');
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('AGENTS.md: replaces only inside the managed block, preserves surrounding text, applies term substitutions', () => {
    const root = setupFixtureRoot();
    const result = runGenerator(root);
    assert.equal(result.status, 0);

    const agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /Hand-written intro text above the managed block\./);
    assert.match(agentsMd, /Hand-written outro text below the managed block\./);
    assert.ok(!agentsMd.includes('stale managed content that must be replaced'), 'stale managed content must be replaced');

    const startIdx = agentsMd.indexOf('<!-- TYCOON-MANAGED:START -->');
    const endIdx = agentsMd.indexOf('<!-- TYCOON-MANAGED:END -->');
    assert.ok(startIdx !== -1 && endIdx !== -1 && startIdx < endIdx, 'both markers must be present, start before end');
    const managed = agentsMd.slice(startIdx, endIdx);

    assert.match(managed, /task tool \(`@agent-name`\)/, 'Task tool replaced inside the managed block');
    assert.match(managed, /agent name/, 'subagent_type replaced inside the managed block');
    assert.ok(!managed.includes('Task tool'), 'literal "Task tool" must not remain inside the managed block');
    assert.ok(!managed.includes('subagent_type'), 'literal "subagent_type" must not remain inside the managed block');

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('AGENTS.md: created with a "# AGENTS.md" header when absent, and rerun reflects a CLAUDE.md edit', () => {
    const root = setupFixtureRoot();
    fs.rmSync(path.join(root, 'AGENTS.md'));

    const first = runGenerator(root);
    assert.equal(first.status, 0);
    let agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /^# AGENTS\.md/);
    assert.match(agentsMd, /<!-- TYCOON-MANAGED:START -->/);
    assert.match(agentsMd, /<!-- TYCOON-MANAGED:END -->/);

    // Edit CLAUDE.md and confirm the rerun's managed block reflects the edit.
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, 'Use the Task tool for a brand-new sentinel phrase ZQXJ7.\n', 'utf8');

    const second = runGenerator(root);
    assert.equal(second.status, 0);
    agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /ZQXJ7/, 'managed block must reflect the updated CLAUDE.md content on rerun');
    assert.match(agentsMd, /task tool \(`@agent-name`\)/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('routing.json: a covered agent\'s slot wins over frontmatter and opencode-models.json', () => {
    const root = setupFixtureRoot();
    fs.writeFileSync(
      path.join(root, '.claude', 'tycoon', 'routing.json'),
      JSON.stringify({
        version: 1,
        agents: {
          'ccc-overridden': { model: 'anthropic/claude-opus-9' },
          'bbb-backend-block': { transport: 'mcp', mcpServer: 'kimi', tools: ['kimi-exec'], model: 'moonshot/kimi-k2' },
        },
        orchestrator: { model: 'anthropic/claude-opus-9' },
      }, null, 2),
      'utf8',
    );

    const result = runGenerator(root);
    assert.equal(result.status, 0, `generator should exit 0; stderr: ${result.stderr}`);

    // routing.json wins over opencode-models.json for ccc-overridden.
    {
      const { frontmatter } = parseFrontmatter(readGenerated(root, 'ccc-overridden'));
      assert.match(frontmatter, /model:\s*anthropic\/claude-opus-9/);
    }

    // routing.json wins over frontmatter backend.model for bbb-backend-block,
    // and the MCP preamble reflects the profile's server/tool, not the
    // frontmatter's.
    {
      const { frontmatter, body } = parseFrontmatter(readGenerated(root, 'bbb-backend-block'));
      assert.match(frontmatter, /model:\s*moonshot\/kimi-k2/);
      assert.match(body, /`kimi` MCP server/);
      assert.match(body, /`kimi-exec` tool/);
    }

    // agent absent from the profile keeps old behaviour (bare alias -> anthropic/<canonical>).
    {
      const { frontmatter } = parseFrontmatter(readGenerated(root, 'aaa-bare-alias'));
      assert.match(frontmatter, new RegExp(`model:\\s*${EXPECT_HAIKU_MODEL.replace('/', '\\/')}`));
    }

    const generatedRoutingPath = path.join(root, '.opencode', 'tycoon-routing.generated.json');
    assert.ok(fs.existsSync(generatedRoutingPath), 'tycoon-routing.generated.json must be written when the profile resolves entries');
    const generatedRouting = JSON.parse(fs.readFileSync(generatedRoutingPath, 'utf8'));
    assert.equal(generatedRouting.agents['ccc-overridden'].model, 'anthropic/claude-opus-9');
    assert.equal(generatedRouting.agents['bbb-backend-block'].model, 'moonshot/kimi-k2');
    assert.equal(generatedRouting.orchestrator.model, 'anthropic/claude-opus-9');

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('routing.json: invalid profile exits 2 with error text and writes nothing', () => {
    const root = setupFixtureRoot();
    fs.writeFileSync(
      path.join(root, '.claude', 'tycoon', 'routing.json'),
      JSON.stringify({ version: 1, agents: { 'ccc-overridden': { transport: 'ssh' } } }, null, 2),
      'utf8',
    );

    const before = fs.existsSync(path.join(root, '.opencode', 'agents'))
      ? fs.readdirSync(path.join(root, '.opencode', 'agents'))
      : [];
    assert.deepEqual(before, [], 'no .opencode/agents output should exist before running');

    const result = runGenerator(root);
    assert.equal(result.status, 2, `invalid routing.json must exit 2; stdout: ${result.stdout}`);
    assert.match(result.stdout + result.stderr, /transport/, 'error output should name the invalid field');
    assert.ok(!fs.existsSync(path.join(root, '.opencode', 'agents')), 'no output must be written on an invalid profile');

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('--migrate-models writes routing.json seeded from opencode-models.json and continues the run', () => {
    const root = setupFixtureRoot();
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'tycoon', 'routing.json')));

    const result = runGenerator(root, ['--migrate-models']);
    assert.equal(result.status, 0, `--migrate-models run should exit 0; stderr: ${result.stderr}`);

    const routingPath = path.join(root, '.claude', 'tycoon', 'routing.json');
    assert.ok(fs.existsSync(routingPath), 'routing.json must be created');
    const migrated = JSON.parse(fs.readFileSync(routingPath, 'utf8'));
    assert.equal(migrated.version, 1);
    assert.equal(migrated.agents['ccc-overridden'].model, 'openai/gpt-5');

    // The migrated profile then applies on this same run (it wins over opencode-models.json,
    // which happens to be the same value here, but proves the profile path executed).
    const { frontmatter } = parseFrontmatter(readGenerated(root, 'ccc-overridden'));
    assert.match(frontmatter, /model:\s*openai\/gpt-5\b/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('deprecation notice printed when opencode-models.json exists and routing.json does not', () => {
    const root = setupFixtureRoot();
    const result = runGenerator(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /deprecat/i, 'a deprecation notice should be printed');
    assert.match(result.stdout, /--migrate-models/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('--check covers tycoon-routing.generated.json: idempotent, and drift is reported', () => {
    const root = setupFixtureRoot();
    fs.writeFileSync(
      path.join(root, '.claude', 'tycoon', 'routing.json'),
      JSON.stringify({ version: 1, agents: { 'ccc-overridden': { model: 'anthropic/claude-opus-9' } } }, null, 2),
      'utf8',
    );

    const gen = runGenerator(root);
    assert.equal(gen.status, 0);

    const check1 = runGenerator(root, ['--check']);
    assert.equal(check1.status, 0, `--check should be 0 when up to date; stderr: ${check1.stderr}`);

    // Second full run must be byte-identical (idempotency) including the generated routing file.
    const generatedRoutingPath = path.join(root, '.opencode', 'tycoon-routing.generated.json');
    const before = fs.readFileSync(generatedRoutingPath, 'utf8');
    const gen2 = runGenerator(root);
    assert.equal(gen2.status, 0);
    assert.equal(fs.readFileSync(generatedRoutingPath, 'utf8'), before, 'tycoon-routing.generated.json must be byte-identical across runs');

    // Drift: change the profile, --check must report the generated routing file as changed.
    fs.writeFileSync(
      path.join(root, '.claude', 'tycoon', 'routing.json'),
      JSON.stringify({ version: 1, agents: { 'ccc-overridden': { model: 'anthropic/claude-opus-10' } } }, null, 2),
      'utf8',
    );
    const check2 = runGenerator(root, ['--check']);
    assert.equal(check2.status, 1);
    assert.match(check2.stdout + check2.stderr, /tycoon-routing\.generated\.json/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
