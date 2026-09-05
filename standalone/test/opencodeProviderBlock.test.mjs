// TycoonAgents standalone — tests for the opencode.json provider-merge half
// of scripts/generate-opencode-config.mjs (p13-t5).
//
// Exercises: an openai-compatible agent slot plus an openai-compatible
// fallback entry on another agent producing provider entries with
// {env:...} placeholders and both models merged; preservation of
// user-authored opencode.json content and of an unmanaged same-id provider
// (with a warning); removal of a managed entry whose vendor drops out of
// the profile; run-to-run byte-identity; --check drift detection.

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

function mkTempRoot(prefix = 'tycoon-opencode-provider-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(root, filename, frontmatterLines, body) {
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\n${frontmatterLines.join('\n')}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

function writeRouting(root, profile) {
  const dir = path.join(root, '.claude', 'tycoon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routing.json'), JSON.stringify(profile, null, 2), 'utf8');
}

function setupFixtureRoot() {
  const root = mkTempRoot();

  writeAgent(root, 'aaa-local.md', [
    'name: aaa-local',
    'description: Runs against a local Ollama endpoint.',
    'tools: Read',
    'tier: worker',
  ], '# AAA Local\n\nBody.');

  writeAgent(root, 'bbb-cloud.md', [
    'name: bbb-cloud',
    'description: Falls back to a local vendor.',
    'tools: Read',
    'tier: worker',
  ], '# BBB Cloud\n\nBody.');

  fs.writeFileSync(
    path.join(root, 'CLAUDE.md'),
    '# Project Instructions\n\nUse the Task tool to delegate work.\n',
    'utf8',
  );

  writeRouting(root, {
    version: 1,
    agents: {
      'aaa-local': {
        vendor: 'ollama-windows',
        transport: 'openai-compatible',
        model: 'ollama-windows/qwen3.6:latest',
        costModelClass: 'local',
        endpointEnv: 'OLLAMA_BASE_URL',
      },
      'bbb-cloud': {
        vendor: 'anthropic',
        transport: 'claude-native',
        model: 'anthropic/claude-sonnet-4-6',
        costModelClass: 'subscription',
        fallback: [
          {
            vendor: 'ollama-windows',
            transport: 'openai-compatible',
            model: 'ollama-windows/llama3.1:8b',
            costModelClass: 'local',
            endpointEnv: 'OLLAMA_BASE_URL',
            credentialEnv: 'OLLAMA_API_KEY',
          },
        ],
      },
    },
  });

  return root;
}

// p13-t6: the generator ALSO writes a GLOBAL opencode.json (per-user
// OpenCode config dir, normally ~/.config/opencode) carrying the same
// managed provider's `options`. Every invocation here pins
// OPENCODE_CONFIG_DIR to a fresh temp dir so no test ever touches this
// machine's real global OpenCode config.
function mkGlobalConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-opencode-global-'));
}

// Test isolation: the generator also reads localEnvStore (src/core/localEnvStore.ts)
// for endpoint/key placeholder values, which lives under the SAME per-user
// app-data dir as TYCOON_STANDALONE_DATA_DIR (see resolveAppDataDir parity,
// standalone/src/appData.mjs). Without this override the generator falls
// through to the real per-user store (e.g. a populated OLLAMA_BASE_URL /
// OLLAMA_API_KEY on the host machine) and produces {file:<real path>}
// placeholders instead of the expected {env:VAR} ones — pin both dirs to
// fresh temps so no test here can ever reach real machine state.
function runGenerator(root, extraArgs = [], globalConfigDir = mkGlobalConfigDir()) {
  const localEnvStoreDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-opencode-localenv-'));
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_CONFIG_DIR: globalConfigDir, TYCOON_STANDALONE_DATA_DIR: localEnvStoreDataDir },
  });
  result.globalConfigDir = globalConfigDir;
  return result;
}

function scriptExists() {
  return fs.existsSync(SCRIPT_PATH);
}

function readOpencodeJson(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));
}

function readGlobalOpencodeJson(globalConfigDir) {
  return JSON.parse(fs.readFileSync(path.join(globalConfigDir, 'opencode.json'), 'utf8'));
}

test('generate-opencode-config: opencode.json provider merge', { skip: !scriptExists() && 'script not yet present' }, async (t) => {
  await t.test('openai-compatible agent slot + fallback entry produce merged provider with both models', () => {
    const root = setupFixtureRoot();
    const result = runGenerator(root);
    assert.equal(result.status, 0, `generator should exit 0; stderr: ${result.stderr}`);

    const configPath = path.join(root, 'opencode.json');
    assert.ok(fs.existsSync(configPath), 'opencode.json must be created');

    const raw = fs.readFileSync(configPath, 'utf8');
    // Never a literal endpoint/key value — only {env:VAR} placeholders and
    // the fixed $schema URL.
    const withoutSchema = raw.replace('https://opencode.ai/config.json', '');
    assert.ok(!/https?:\/\//.test(withoutSchema), 'opencode.json must never contain a literal URL besides $schema');

    const config = readOpencodeJson(root);
    assert.equal(config['$schema'], 'https://opencode.ai/config.json');
    const provider = config.provider['ollama-windows'];
    assert.ok(provider, 'ollama-windows provider entry must exist');
    assert.equal(provider.npm, '@ai-sdk/openai-compatible');
    assert.equal(provider.name, 'ollama-windows');
    assert.equal(provider.tycoonManaged, true);
    // p13-t6: the PROJECT file carries no `options` at all — endpoint/key
    // config lives only in the global file (see below).
    assert.equal(provider.options, undefined, 'project opencode.json must never carry an `options` block');
    assert.ok(provider.models['qwen3.6:latest'], 'primary slot model must be present');
    assert.ok(provider.models['llama3.1:8b'], 'fallback-chain model must be present');
    assert.equal(provider.models['qwen3.6:latest'].name, 'qwen3.6:latest');

    // No provider entry for the claude-native vendor.
    assert.ok(!config.provider.anthropic, 'claude-native slots must not get a provider entry');

    // GLOBAL file: same managed entry, but WITH options as {env:...}
    // placeholders (no local store value written in this fixture).
    const globalConfig = readGlobalOpencodeJson(result.globalConfigDir);
    const globalProvider = globalConfig.provider['ollama-windows'];
    assert.ok(globalProvider, 'global opencode.json must carry the same provider id');
    assert.equal(globalProvider.options.baseURL, '{env:OLLAMA_BASE_URL}');
    assert.equal(globalProvider.options.apiKey, '{env:OLLAMA_API_KEY}');
    assert.deepEqual(globalProvider.models, provider.models);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(result.globalConfigDir, { recursive: true, force: true });
  });

  await t.test('preserves existing opencode.json content and an unmanaged same-id provider, with a warning', () => {
    const root = setupFixtureRoot();
    fs.writeFileSync(
      path.join(root, 'opencode.json'),
      JSON.stringify({
        '$schema': 'https://opencode.ai/config.json',
        theme: 'my-custom-theme',
        provider: {
          'ollama-windows': { npm: 'hand-authored-package', name: 'ollama-windows', options: {}, models: {} },
        },
      }, null, 2),
      'utf8',
    );

    const result = runGenerator(root);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /ollama-windows.*without a tycoonManaged marker/i);

    const config = readOpencodeJson(root);
    assert.equal(config.theme, 'my-custom-theme', 'unrelated top-level user content must be preserved');
    assert.equal(config.provider['ollama-windows'].npm, 'hand-authored-package', 'unmanaged same-id provider must be left untouched');

    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('a managed vendor entry is removed once it drops out of the profile', () => {
    const root = setupFixtureRoot();
    const globalConfigDir = mkGlobalConfigDir();
    const first = runGenerator(root, [], globalConfigDir);
    assert.equal(first.status, 0);
    assert.ok(readOpencodeJson(root).provider['ollama-windows']);
    assert.ok(readGlobalOpencodeJson(globalConfigDir).provider['ollama-windows']);

    // Remove the openai-compatible slot and its fallback from the profile.
    writeRouting(root, {
      version: 1,
      agents: {
        'bbb-cloud': {
          vendor: 'anthropic',
          transport: 'claude-native',
          model: 'anthropic/claude-sonnet-4-6',
          costModelClass: 'subscription',
        },
      },
    });

    const second = runGenerator(root, [], globalConfigDir);
    assert.equal(second.status, 0, `second run should exit 0; stderr: ${second.stderr}`);
    const config = readOpencodeJson(root);
    assert.ok(!config.provider || !config.provider['ollama-windows'], 'managed entry must be removed when its vendor disappears');
    const globalConfig = readGlobalOpencodeJson(globalConfigDir);
    assert.ok(!globalConfig.provider || !globalConfig.provider['ollama-windows'], 'global managed entry must also be removed');

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalConfigDir, { recursive: true, force: true });
  });

  await t.test('two runs produce a byte-identical opencode.json (project and global)', () => {
    const root = setupFixtureRoot();
    const globalConfigDir = mkGlobalConfigDir();
    const first = runGenerator(root, [], globalConfigDir);
    assert.equal(first.status, 0);
    const before = fs.readFileSync(path.join(root, 'opencode.json'), 'utf8');
    const globalBefore = fs.readFileSync(path.join(globalConfigDir, 'opencode.json'), 'utf8');

    const second = runGenerator(root, [], globalConfigDir);
    assert.equal(second.status, 0);
    const after = fs.readFileSync(path.join(root, 'opencode.json'), 'utf8');
    const globalAfter = fs.readFileSync(path.join(globalConfigDir, 'opencode.json'), 'utf8');

    assert.equal(after, before, 'project opencode.json must be byte-identical across runs');
    assert.equal(globalAfter, globalBefore, 'global opencode.json must be byte-identical across runs');

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalConfigDir, { recursive: true, force: true });
  });

  await t.test('--check detects drift in opencode.json', () => {
    const root = setupFixtureRoot();
    const globalConfigDir = mkGlobalConfigDir();
    const gen = runGenerator(root, [], globalConfigDir);
    assert.equal(gen.status, 0);

    const check1 = runGenerator(root, ['--check'], globalConfigDir);
    assert.equal(check1.status, 0, `--check should be 0 when up to date; stderr: ${check1.stderr}`);

    // Introduce drift: add a second model to the profile for the same vendor.
    writeRouting(root, {
      version: 1,
      agents: {
        'aaa-local': {
          vendor: 'ollama-windows',
          transport: 'openai-compatible',
          model: 'ollama-windows/qwen3.6:latest',
          costModelClass: 'local',
          endpointEnv: 'OLLAMA_BASE_URL',
        },
        'bbb-cloud': {
          vendor: 'ollama-windows',
          transport: 'openai-compatible',
          model: 'ollama-windows/mistral-nemo:latest',
          costModelClass: 'local',
          endpointEnv: 'OLLAMA_BASE_URL',
        },
      },
    });

    const check2 = runGenerator(root, ['--check'], globalConfigDir);
    assert.equal(check2.status, 1, '--check must report drift after the profile changes');
    assert.match(check2.stdout + check2.stderr, /opencode\.json/);
    fs.rmSync(globalConfigDir, { recursive: true, force: true });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
