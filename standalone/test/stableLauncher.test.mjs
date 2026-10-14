// Standalone parity for the stable launcher folder: the standalone server registers local-scope MCP
// entries and the Codex dispatcher against the same per-user folder as the VS Code extension (never
// its own hooks/ folder), migrates versioned entries into it, and shares the never-downgrade stamp.
// The folder is <home>/.tycoonagents/bin; no environment variable moves it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stableMod = require(path.join(REPO_ROOT, 'out', 'src', 'core', 'stableBridgeDir.js'));
const syncMod = require(path.join(REPO_ROOT, 'out', 'src', 'core', 'claudeLocalMcpSync.js'));
const localMod = require(path.join(REPO_ROOT, 'out', 'src', 'core', 'claudeLocalMcp.js'));

const fwd = (p) => p.split(path.sep).join('/');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('standalone server wires local-scope ops and the Codex dispatcher to the stable launcher, never to its own hooks folder', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'standalone', 'src', 'server.mjs'), 'utf8');
  assert.doesNotMatch(src, /createLocalMcpOps\(/);
  assert.match(src, /stableLocalMcp\(\)/);
  assert.match(src, /installStableBridges\(path\.join\(REPO_ROOT, 'hooks'\), \{ fromActivation: true \}\)/);
  assert.match(src, /serverScriptPath: codexDispatcherScriptPath\(\)/);
  assert.match(src, /repointed\.missing/);
});

test('standalone install copies this repo\'s hooks into the shared folder and never downgrades a newer editor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-stable-'));
  try {
    const stable = fwd(path.join(dir, '.tycoonagents', 'bin'));
    const hooks = path.join(REPO_ROOT, 'hooks');
    const first = stableMod.installStableBridges(hooks, { homedir: dir, version: '5.0.0' });
    assert.notEqual(first.status, 'error', first.errors.join(';'));
    assert.equal(syncMod.stableLocalMcp({ homedir: dir }).ops.hooksDir, stable);
    assert.equal(sha(path.join(stable, 'codex-mcp-launcher.cjs')), sha(path.join(hooks, 'codex-mcp-launcher.cjs')));
    fs.writeFileSync(path.join(stable, 'codex-mcp-launcher.cjs'), '// newer editor\n');
    const old = stableMod.installStableBridges(hooks, { homedir: dir, version: '4.9.9' });
    assert.equal(old.status, 'newer');
    assert.equal(fs.readFileSync(path.join(stable, 'codex-mcp-launcher.cjs'), 'utf8'), '// newer editor\n');
    // Without an injected home or activation nothing is ever written.
    assert.equal(stableMod.installStableBridges(hooks, { version: '5.0.0' }).status, 'skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone startup migration moves a versioned entry to the stable folder once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-mig-'));
  try {
    const cfgDir = path.join(dir, 'cfg');
    fs.mkdirSync(cfgDir);
    const root = path.join(dir, 'proj');
    fs.mkdirSync(root);
    const stable = fwd(path.join(dir, 'home', '.tycoonagents', 'bin'));
    const o = { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir }, homedir: path.join(dir, 'home'), binary: null, verifyDelayMs: 0 };
    const r = stableMod.installStableBridges(path.join(REPO_ROOT, 'hooks'), { homedir: o.homedir, version: '5.0.0' });
    assert.notEqual(r.status, 'error', r.errors.join(';'));
    const old = { command: 'node', args: [fwd(path.join(dir, 'extensions', 'tycoonagents.tycoonagents-0.0.1', 'hooks', 'codex-mcp-launcher.cjs'))] };
    assert.equal((await localMod.registerLocalMcpServer(root, 'codex', old, o)).ok, true);
    const ops = syncMod.stableLocalMcp(o).ops;
    const res = await syncMod.repointLocalMcpEntries(root, ops.hooksDir, ['codex'], o);
    assert.deepEqual(res, { repointed: ['codex'], errors: [], missing: [] });
    assert.equal(localMod.readLocalMcpServers(root, o).codex.args[0], `${stable}/codex-mcp-launcher.cjs`);
    assert.deepEqual(await syncMod.repointLocalMcpEntries(root, ops.hooksDir, ['codex'], o), { repointed: [], errors: [], missing: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
