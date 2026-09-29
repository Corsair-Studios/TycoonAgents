// Alias handling in scripts/generate-opencode-config.mjs: OpenCode has no
// model aliases, so every Anthropic alias (bare or "anthropic/<alias>") must
// map to the NEWEST concrete id from modelAliases.LATEST_MODEL_IDS, with the
// provider prefix applied exactly once (never "anthropic/anthropic/...").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LATEST_MODEL_IDS, resolveLatestModelId } from '../../out/src/core/modelAliases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'generate-opencode-config.mjs');

function writeAgent(root, name, lines) {
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n${lines.join('\n')}\n---\n\n# ${name}\n\nBody.\n`, 'utf8');
}

function generate(root) {
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-latest-alias-global-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-latest-alias-data-'));
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_CONFIG_DIR: globalDir, TYCOON_STANDALONE_DATA_DIR: dataDir },
  });
  assert.equal(result.status, 0, `generator should exit 0; stderr: ${result.stderr}`);
}

function modelOf(root, name) {
  const md = fs.readFileSync(path.join(root, '.opencode', 'agents', `${name}.md`), 'utf8');
  const m = /^model:\s*(.+)$/m.exec(md);
  return m ? m[1].trim() : undefined;
}

test('LATEST_MODEL_IDS covers every alias family with a concrete claude id', () => {
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
    assert.ok(LATEST_MODEL_IDS[alias].startsWith(`claude-${alias}-`) && /[0-9]$/.test(LATEST_MODEL_IDS[alias]), alias);
  }
  assert.equal(resolveLatestModelId('sonnet'), LATEST_MODEL_IDS.sonnet);
  assert.equal(resolveLatestModelId('anthropic/sonnet'), LATEST_MODEL_IDS.sonnet);
  assert.equal(resolveLatestModelId('anthropic/claude-opus-9'), undefined);
  assert.equal(resolveLatestModelId('openai/gpt-5'), undefined);
});

test('bare and vendor-qualified aliases resolve to one anthropic/ prefix and the latest id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-latest-alias-'));
  writeAgent(root, 'bare-alias', ['model: sonnet']);
  writeAgent(root, 'prefixed-alias', ['model: anthropic/sonnet']);
  writeAgent(root, 'backend-alias', ['backend:', '  vendor: anthropic', '  transport: claude-native', '  model: anthropic/haiku', '  costModelClass: metered']);
  writeAgent(root, 'pinned-by-user', ['model: anthropic/claude-sonnet-4-6']);
  writeAgent(root, 'other-vendor', ['backend:', '  vendor: openai', '  transport: mcp', '  mcpServer: codex', '  tools: [codex]', '  model: openai/gpt-5', '  costModelClass: subscription']);
  generate(root);

  assert.equal(modelOf(root, 'bare-alias'), `anthropic/${LATEST_MODEL_IDS.sonnet}`);
  assert.equal(modelOf(root, 'prefixed-alias'), `anthropic/${LATEST_MODEL_IDS.sonnet}`);
  assert.equal(modelOf(root, 'backend-alias'), `anthropic/${LATEST_MODEL_IDS.haiku}`);
  assert.equal(modelOf(root, 'pinned-by-user'), 'anthropic/claude-sonnet-4-6', 'an explicit user pin is left untouched');
  assert.equal(modelOf(root, 'other-vendor'), 'openai/gpt-5');
  for (const name of ['bare-alias', 'prefixed-alias', 'backend-alias', 'pinned-by-user', 'other-vendor']) {
    assert.ok(!/anthropic\/anthropic/.test(modelOf(root, name)), `${name} must not double the provider prefix`);
  }
});

test('routing.json alias slots (including fallbacks) resolve to the latest id without doubling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-latest-alias-route-'));
  writeAgent(root, 'routed', ['model: haiku']);
  fs.mkdirSync(path.join(root, '.claude', 'tycoon'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'tycoon', 'routing.json'),
    JSON.stringify({
      version: 1,
      agents: { routed: { model: 'anthropic/sonnet', fallback: [{ vendor: 'anthropic', model: 'opus' }] } },
    }),
    'utf8',
  );
  generate(root);

  assert.equal(modelOf(root, 'routed'), `anthropic/${LATEST_MODEL_IDS.sonnet}`);
  const generated = JSON.parse(fs.readFileSync(path.join(root, '.opencode', 'tycoon-routing.generated.json'), 'utf8'));
  assert.equal(generated.agents.routed.model, `anthropic/${LATEST_MODEL_IDS.sonnet}`);
  assert.deepEqual(generated.agents.routed.fallback, [`anthropic/${LATEST_MODEL_IDS.opus}`]);
});
