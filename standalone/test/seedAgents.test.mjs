// TycoonAgents standalone — unit tests for seedAgents.mjs (p16-t3).
//
// Covers: install-hook seeds the core roster + agent-keywords.json, second
// run is a no-op (idempotent, preserves a user-edited file byte-for-byte),
// --no-agents skips seeding entirely, seed-agents subcommand runs seeding
// only, seeded files are valid frontmatter parseable by
// out/src/core/agentBackend.js, and the seeded roster feeds
// scripts/generate-opencode-config.mjs end-to-end (proving the routing
// generators' flow works from a fresh dir).
//
// Requires `out/` (npx tsc -p . from the repo root) — same precondition as
// installHook.test.mjs / sharedLogic.mjs's other consumers.
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path,
// node:child_process, node:url).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { seedAgents, agentsToSeed, SeedAgentsError } from '../src/seedAgents.mjs';
import { runCli } from '../src/cli.mjs';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(__dirname, '..', 'src', 'cli.mjs');
const GEN_OPENCODE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-opencode-config.mjs');
const AGENT_BACKEND_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'agentBackend.js');

function mkTempDir(prefix = 'tycoon-standalone-seedagents-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function agentFiles(dir) {
  const agentsDir = path.join(dir, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
}

const EXPECTED_IDS = agentsToSeed().map((a) => a.id).sort();

test('seedAgents: fresh dir seeds one .md per roster agent + agent-keywords.json, valid frontmatter', () => {
  const dir = mkTempDir();
  const result = seedAgents(dir);

  assert.deepEqual(result.seededAgents.slice().sort(), EXPECTED_IDS);
  assert.deepEqual(result.skippedAgents, []);
  assert.equal(result.seededKeywords, true);
  assert.equal(agentFiles(dir).length, EXPECTED_IDS.length);

  const { readAgentFrontmatter } = require(AGENT_BACKEND_JS);
  for (const id of EXPECTED_IDS) {
    const content = fs.readFileSync(path.join(dir, '.claude', 'agents', `${id}.md`), 'utf8');
    const fm = readAgentFrontmatter(content);
    assert.equal(fm.name, id, `frontmatter name must equal agent id for ${id}`);
    assert.ok(typeof fm.description === 'string' && fm.description.length > 0, `description present for ${id}`);
  }

  const keywords = JSON.parse(fs.readFileSync(result.keywordsPath, 'utf8'));
  for (const id of EXPECTED_IDS) {
    assert.ok(keywords.agents && keywords.agents[id], `agent-keywords.json has an entry for ${id}`);
  }
});

test('seedAgents: reviewer.md has no tycoon_pack line; worker files carry tycoon_pack: worker', () => {
  const dir = mkTempDir();
  seedAgents(dir);

  const reviewerContent = fs.readFileSync(path.join(dir, '.claude', 'agents', 'reviewer.md'), 'utf8');
  assert.ok(!/^tycoon_pack:/m.test(reviewerContent), 'reviewer.md must not carry a tycoon_pack line (matches panel.ts buildAgentMarkdown(a) with no packId)');

  const workerIds = EXPECTED_IDS.filter((id) => id !== 'reviewer');
  for (const id of workerIds) {
    const content = fs.readFileSync(path.join(dir, '.claude', 'agents', `${id}.md`), 'utf8');
    assert.ok(/^tycoon_pack: worker$/m.test(content), `${id}.md must carry tycoon_pack: worker`);
  }
});

test('seedAgents: second run is a no-op and preserves a user-edited file byte-for-byte', () => {
  const dir = mkTempDir();
  seedAgents(dir);

  const editedPath = path.join(dir, '.claude', 'agents', `${EXPECTED_IDS[0]}.md`);
  const edited = fs.readFileSync(editedPath, 'utf8') + '\n<!-- user edit -->\n';
  fs.writeFileSync(editedPath, edited, 'utf8');
  const keywordsBefore = fs.readFileSync(path.join(dir, '.claude', 'tycoon', 'agent-keywords.json'), 'utf8');

  const second = seedAgents(dir);

  assert.deepEqual(second.seededAgents, []);
  assert.deepEqual(second.skippedAgents.slice().sort(), EXPECTED_IDS);
  assert.equal(second.seededKeywords, false);
  assert.equal(fs.readFileSync(editedPath, 'utf8'), edited, 'user-edited agent file must be byte-for-byte preserved');
  assert.equal(
    fs.readFileSync(path.join(dir, '.claude', 'tycoon', 'agent-keywords.json'), 'utf8'),
    keywordsBefore,
    'existing agent-keywords.json must be left untouched',
  );
});

test('seedAgents: throws SeedAgentsError for a missing target directory', () => {
  assert.throws(() => seedAgents(path.join(os.tmpdir(), 'tycoon-nonexistent-' + Date.now())), SeedAgentsError);
});

test('install-hook via runCli seeds the roster by default; --no-agents skips it', async () => {
  const dir1 = mkTempDir();
  const code1 = await runCli(['install-hook', dir1]);
  assert.equal(code1, 0);
  assert.equal(agentFiles(dir1).length, EXPECTED_IDS.length);
  assert.ok(fs.existsSync(path.join(dir1, '.claude', 'tycoon', 'agent-keywords.json')));

  const dir2 = mkTempDir();
  const code2 = await runCli(['install-hook', dir2, '--no-agents']);
  assert.equal(code2, 0);
  assert.deepEqual(agentFiles(dir2), []);
  assert.ok(!fs.existsSync(path.join(dir2, '.claude', 'tycoon', 'agent-keywords.json')));
  // The hook itself must still be installed even with --no-agents.
  assert.ok(fs.existsSync(path.join(dir2, '.claude', 'settings.local.json')));
});

test('install-hook --opencode also seeds the roster by default', async () => {
  const dir = mkTempDir();
  const code = await runCli(['install-hook', dir, '--opencode']);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(dir, '.opencode', 'plugin')), 'opencode plugin installed');
  assert.equal(agentFiles(dir).length, EXPECTED_IDS.length, 'agent roster seeded alongside the opencode plugin');
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'tycoon', 'agent-keywords.json')));
});

test('seed-agents subcommand runs only the seeding (no settings.local.json)', async () => {
  const dir = mkTempDir();
  const code = await runCli(['seed-agents', dir]);
  assert.equal(code, 0);
  assert.equal(agentFiles(dir).length, EXPECTED_IDS.length);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'settings.local.json')), 'seed-agents must not touch hook settings');
});

test('seeded roster feeds scripts/generate-opencode-config.mjs into .opencode/agents', async () => {
  const dir = mkTempDir();
  const code = await runCli(['seed-agents', dir]);
  assert.equal(code, 0);

  // Test isolation: pin OPENCODE_CONFIG_DIR and the localEnvStore app-data
  // dir (TYCOON_STANDALONE_DATA_DIR) to fresh temp dirs so this never
  // touches the machine's real global OpenCode config or secret store.
  const globalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-seed-opencode-global-'));
  const localEnvStoreDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-seed-opencode-localenv-'));
  const result = spawnSync(process.execPath, [GEN_OPENCODE_SCRIPT, '--root', dir], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_CONFIG_DIR: globalConfigDir, TYCOON_STANDALONE_DATA_DIR: localEnvStoreDataDir },
  });
  assert.equal(result.status, 0, `generate-opencode-config.mjs failed: ${result.stderr}`);

  const opencodeAgentsDir = path.join(dir, '.opencode', 'agents');
  assert.ok(fs.existsSync(opencodeAgentsDir), '.opencode/agents must be created');
  const generated = fs.readdirSync(opencodeAgentsDir).filter((f) => f.endsWith('.md'));
  assert.ok(generated.length >= EXPECTED_IDS.length, 'one .opencode/agents entry per seeded agent');
  for (const id of EXPECTED_IDS) {
    assert.ok(generated.includes(`${id}.md`), `.opencode/agents/${id}.md generated`);
  }
});

