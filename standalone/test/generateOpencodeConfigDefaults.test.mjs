// TycoonAgents standalone — tests for plan task p17-t2's `defaults` support
// in scripts/generate-opencode-config.mjs: --check/write resolve `defaults`
// into every eligible agent (recorded in
// .opencode/tycoon-routing.generated.json), a managed provider is
// registered once from defaults when it is a custom openai-compatible
// vendor, and hand-written-backend agents (MCP reviewers etc.) are left
// untouched by defaults alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'generate-opencode-config.mjs');

function mkTempRoot(prefix = 'tycoon-opencode-config-defaults-test-') {
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

// Isolate the global opencode.json this script writes to — never touch the
// real per-user OpenCode config dir.
function run(args, extraEnv) {
  const globalConfigDir = mkTempRoot('tycoon-opencode-global-config-');
  return {
    globalConfigDir,
    result: spawnSync('node', [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_CONFIG_DIR: globalConfigDir, ...extraEnv },
    }),
  };
}

function setupFixtureRoot() {
  const root = mkTempRoot();

  // eligible: no backend block
  writeAgent(root, 'eligible-agent.md', [
    'name: eligible-agent',
    'description: No backend block; should inherit defaults.',
    'tier: worker',
  ], '# Eligible Agent\n\nBody text.');

  // ineligible: hand-written backend block (custom vendor/mcp)
  writeAgent(root, 'mcp-reviewer.md', [
    'name: mcp-reviewer',
    'description: Hand-written MCP backend.',
    'tier: worker',
    'backend:',
    '  vendor: openai',
    '  transport: mcp',
    '  mcpServer: codex',
    '  model: openai/gpt-5.4-mini',
    '  costModelClass: subscription',
  ], '# MCP Reviewer\n\nBody text.');

  writeRoutingProfile(root, {
    version: 1,
    agents: {},
    defaults: {
      vendor: 'moonshot',
      transport: 'openai-compatible',
      model: 'moonshot/kimi-k2',
      costModelClass: 'local',
      endpointEnv: 'KIMI_ENDPOINT_URL',
      credentialEnv: 'KIMI_API_KEY',
    },
  });

  return root;
}

test('generate-opencode-config --check reports pending changes when defaults cover an eligible agent', () => {
  const root = setupFixtureRoot();
  const { result } = run(['--root', root, '--check']);
  assert.equal(result.status, 1, `expected exit 1; stdout=${result.stdout} stderr=${result.stderr}`);
});

test('generate-opencode-config write: eligible agent resolves defaults.model into tycoon-routing.generated.json', () => {
  const root = setupFixtureRoot();
  const { result } = run(['--root', root]);
  assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout} stderr=${result.stderr}`);

  const generatedPath = path.join(root, '.opencode', 'tycoon-routing.generated.json');
  assert.ok(fs.existsSync(generatedPath), 'tycoon-routing.generated.json should be written');
  const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
  assert.equal(
    generated.agents?.['eligible-agent']?.model,
    'moonshot/kimi-k2',
    `expected eligible-agent to resolve defaults.model, got: ${JSON.stringify(generated)}`
  );
});

test('generate-opencode-config write: eligible agent .opencode/agents/*.md gets the defaults-resolved model', () => {
  const root = setupFixtureRoot();
  const { result } = run(['--root', root]);
  assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout} stderr=${result.stderr}`);

  const destPath = path.join(root, '.opencode', 'agents', 'eligible-agent.md');
  assert.ok(fs.existsSync(destPath));
  const content = fs.readFileSync(destPath, 'utf8');
  assert.match(content, /model:\s*moonshot\/kimi-k2/);
});

test('generate-opencode-config write: hand-written-backend agent keeps its own model, not defaults', () => {
  const root = setupFixtureRoot();
  const { result } = run(['--root', root]);
  assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout} stderr=${result.stderr}`);

  const generatedPath = path.join(root, '.opencode', 'tycoon-routing.generated.json');
  const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
  assert.notEqual(
    generated.agents?.['mcp-reviewer']?.model,
    'moonshot/kimi-k2',
    'a hand-written-backend agent must not be overridden by defaults'
  );

  const destPath = path.join(root, '.opencode', 'agents', 'mcp-reviewer.md');
  const content = fs.readFileSync(destPath, 'utf8');
  assert.match(content, /model:\s*openai\/gpt-5\.4-mini/);
});

test('generate-opencode-config write: registers exactly one managed provider entry for the custom defaults vendor', () => {
  const root = setupFixtureRoot();
  const { result, globalConfigDir } = run(['--root', root]);
  assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout} stderr=${result.stderr}`);

  const projectConfigPath = path.join(root, 'opencode.json');
  assert.ok(fs.existsSync(projectConfigPath), 'project opencode.json should be written for the moonshot vendor');
  const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
  assert.ok(projectConfig.provider?.moonshot?.tycoonManaged === true);
  assert.equal(Object.keys(projectConfig.provider).length, 1, 'exactly one managed provider entry should be registered from defaults');

  const globalConfigPath = path.join(globalConfigDir, 'opencode.json');
  assert.ok(fs.existsSync(globalConfigPath), 'global opencode.json should carry the options for the moonshot vendor');
  const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
  assert.equal(globalConfig.provider?.moonshot?.options?.baseURL, '{env:KIMI_ENDPOINT_URL}');
  assert.equal(globalConfig.provider?.moonshot?.options?.apiKey, '{env:KIMI_API_KEY}');
});
