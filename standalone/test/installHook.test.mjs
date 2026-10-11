// TycoonAgents standalone — unit tests for installHook.mjs (p3-t3).
//
// Covers: fresh install, idempotency (exactly one entry per slot on a
// second run), non-destructive merge with unrelated existing settings,
// corrupt settings.local.json producing a clean error without touching the
// user's file, and the pure merge function's changed=false on a no-op pass.
//
// Everything runs against temp dirs created with fs.mkdtempSync — never the
// real ~/.claude or this repo's own .claude/settings*.json.
//
// Node built-ins only (node:test, node:assert, node:fs, node:os, node:path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installHook,
  installOpenCodePlugin,
  OPENCODE_PLUGIN_FILES,
  mergeHookIntoSettings,
  defaultHookScriptPath,
  refreshRuntimeHookCopies,
  installMcpBridgeHooks,
  installMcpBridgeHooksForConfig,
  ensureCommonJsMarker,
  healInstalledHookCopies,
  InstallHookError,
  TYCOON_HOOK_SLOTS,
} from '../src/installHook.mjs';

function mkTempDir(prefix = 'tycoon-standalone-installhook-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

/** Counts how many hook command entries across the whole settings object
 * equal `hookCommand` exactly — used to prove idempotency isn't just "the
 * file didn't crash" but "there really is only one entry per slot". */
function countHookCommand(settings, hookCommand) {
  let count = 0;
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== 'object') return count;
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = entry && entry.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (h && h.command === hookCommand) count++;
      }
    }
  }
  return count;
}

test('defaultHookScriptPath: resolves to the repo hooks/tycoon-claude-hook.cjs and it exists', () => {
  const p = defaultHookScriptPath();
  assert.ok(path.isAbsolute(p), 'must be an absolute path');
  assert.ok(p.endsWith('tycoon-claude-hook.cjs'));
  assert.ok(fs.existsSync(p), `expected hook script to exist at ${p}`);
});

test('installHook: fresh install into a project with no settings.local.json creates the entry', () => {
  const dir = mkTempDir();
  try {
    const result = installHook(dir);
    assert.equal(result.changed, true);
    assert.ok(fs.existsSync(result.settingsPath));
    const settings = readSettings(result.settingsPath);
    assert.equal(countHookCommand(settings, result.hookCommand), TYCOON_HOOK_SLOTS.length);
    // Sanity: it references the real repo hook script, not a copy.
    assert.match(result.hookCommand, /tycoon-claude-hook\.cjs/);
    assert.ok(fs.existsSync(defaultHookScriptPath()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installHook: idempotent — running twice yields exactly one entry per slot, no error', () => {
  const dir = mkTempDir();
  try {
    const first = installHook(dir);
    assert.equal(first.changed, true);

    const second = installHook(dir);
    assert.equal(second.changed, false, 'second run should be a no-op');
    assert.equal(second.settingsPath, first.settingsPath);

    const settings = readSettings(second.settingsPath);
    assert.equal(
      countHookCommand(settings, second.hookCommand),
      TYCOON_HOOK_SLOTS.length,
      'must be exactly one entry per hook slot after two installs, not two',
    );

    // Run a third time for good measure.
    const third = installHook(dir);
    assert.equal(third.changed, false);
    const settings3 = readSettings(third.settingsPath);
    assert.equal(countHookCommand(settings3, third.hookCommand), TYCOON_HOOK_SLOTS.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installHook: preserves unrelated existing keys and unrelated hooks in settings.local.json', () => {
  const dir = mkTempDir();
  try {
    const claudeDir = path.join(dir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const preexisting = {
      someUnrelatedTopLevelKey: 'keep-me',
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'node "some-other-tool.cjs"' }],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(preexisting, null, 2), 'utf8');

    const result = installHook(dir);
    assert.equal(result.changed, true);

    const settings = readSettings(result.settingsPath);
    assert.equal(settings.someUnrelatedTopLevelKey, 'keep-me');
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });

    // The unrelated Stop hook is still there alongside ours. Note: a
    // pre-existing entry that shares our matcher but does NOT yet reference
    // our hook gets a SEPARATE sibling entry with the same matcher (mirrors
    // hookInstall.ts's mergeTycoonHooks exactly — it never merges into an
    // existing non-ours entry, it appends), so we scan every entry for that
    // matcher rather than assuming a single one.
    const stopEntries = settings.hooks.Stop.filter((e) => e.matcher === '');
    const commands = stopEntries.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(commands.includes('node "some-other-tool.cjs"'), 'unrelated hook must survive');
    assert.ok(
      commands.some((c) => c.includes('tycoon-claude-hook.cjs')),
      'our hook must be added',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installHook: corrupt settings.local.json throws a clear error and does NOT modify the file', () => {
  const dir = mkTempDir();
  try {
    const claudeDir = path.join(dir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const corrupt = '{ "hooks": { this is not valid JSON';
    fs.writeFileSync(settingsPath, corrupt, 'utf8');

    assert.throws(
      () => installHook(dir),
      (err) => {
        assert.ok(err instanceof InstallHookError, 'must throw InstallHookError');
        assert.match(err.message, /not valid JSON|not a JSON object/i);
        assert.ok(err.message.includes(settingsPath), 'message should name the offending file');
        return true;
      },
    );

    // The user's corrupt file must be left byte-for-byte untouched.
    const after = fs.readFileSync(settingsPath, 'utf8');
    assert.equal(after, corrupt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installHook: settings.local.json that parses but is not a JSON object (e.g. an array) throws cleanly', () => {
  const dir = mkTempDir();
  try {
    const claudeDir = path.join(dir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const original = '[1, 2, 3]';
    fs.writeFileSync(settingsPath, original, 'utf8');

    assert.throws(() => installHook(dir), InstallHookError);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installHook: nonexistent target directory throws InstallHookError naming the path', () => {
  const missing = path.join(os.tmpdir(), 'tycoon-standalone-installhook-missing-' + Date.now());
  assert.throws(
    () => installHook(missing),
    (err) => {
      assert.ok(err instanceof InstallHookError);
      assert.ok(err.message.includes(missing));
      return true;
    },
  );
});

test('installHook: a file instead of a directory throws InstallHookError', () => {
  const dir = mkTempDir();
  const filePath = path.join(dir, 'not-a-directory.txt');
  fs.writeFileSync(filePath, 'hello', 'utf8');
  try {
    assert.throws(() => installHook(filePath), InstallHookError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure mergeHookIntoSettings — no fs at all.
// ---------------------------------------------------------------------------

// Note: the command string here MUST include the literal marker
// "tycoon-claude-hook.cjs" (same as production hookCommand values) since
// that substring is exactly what mergeHookIntoSettings uses to recognize an
// existing entry as "already ours" — see HOOK_MARKER in installHook.mjs.

test('mergeHookIntoSettings: fresh {} produces one entry per slot and changed=true', () => {
  const hookCommand = 'node "/abs/tycoon-claude-hook.cjs"';
  const { settings, changed } = mergeHookIntoSettings({}, hookCommand);
  assert.equal(changed, true);
  assert.equal(countHookCommand(settings, hookCommand), TYCOON_HOOK_SLOTS.length);
});

test('mergeHookIntoSettings: applying twice in a row — second call is changed=false and identical output', () => {
  const hookCommand = 'node "/abs/tycoon-claude-hook.cjs"';
  const first = mergeHookIntoSettings({}, hookCommand);
  assert.equal(first.changed, true);

  const second = mergeHookIntoSettings(first.settings, hookCommand);
  assert.equal(second.changed, false, 'merging an already-merged settings object must be a no-op');
  assert.deepEqual(second.settings, first.settings);
});

// ---------------------------------------------------------------------------
// installOpenCodePlugin — separate opt-in, .opencode/plugin/ only (p7-t2).
// ---------------------------------------------------------------------------

test('OPENCODE_PLUGIN_FILES includes fallbackChain.js (required by the Claude/OpenCode fallback branches)', () => {
  assert.ok(
    OPENCODE_PLUGIN_FILES.includes('fallbackChain.js'),
    'fallbackChain.js must be copied — it is lazy-required at runtime by ' +
      'tycoon-claude-hook.cjs\'s PostToolUse/Task fallback branch and by tycoon-opencode-plugin.ts',
  );
});

test('installOpenCodePlugin: copies the three plugin files into .opencode/plugin/', () => {
  const dir = mkTempDir();
  try {
    const result = installOpenCodePlugin(dir);
    assert.equal(result.changed, true);
    assert.deepEqual([...result.copied].sort(), [...OPENCODE_PLUGIN_FILES].sort());
    assert.deepEqual(result.skipped, []);
    const pluginDir = path.join(dir, '.opencode', 'plugin');
    assert.equal(result.pluginDir, pluginDir);
    for (const file of OPENCODE_PLUGIN_FILES) {
      assert.ok(fs.existsSync(path.join(pluginDir, file)), `expected ${file} to be copied`);
    }
    // .claude/ must be untouched by this opt-in.
    assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installOpenCodePlugin: rerun is a no-op (changed=false, all files skipped, no error)', () => {
  const dir = mkTempDir();
  try {
    const first = installOpenCodePlugin(dir);
    assert.equal(first.changed, true);

    const second = installOpenCodePlugin(dir);
    assert.equal(second.changed, false);
    assert.deepEqual(second.copied, []);
    assert.deepEqual([...second.skipped].sort(), [...OPENCODE_PLUGIN_FILES].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installOpenCodePlugin: without being called, nothing is written under .opencode/ by installHook', () => {
  const dir = mkTempDir();
  try {
    installHook(dir);
    assert.equal(fs.existsSync(path.join(dir, '.opencode')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installOpenCodePlugin: a differing destination file throws without --force and is left untouched', () => {
  const dir = mkTempDir();
  try {
    const pluginDir = path.join(dir, '.opencode', 'plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const destPath = path.join(pluginDir, 'modelAliases.js');
    fs.writeFileSync(destPath, '// not the real file', 'utf8');

    assert.throws(() => installOpenCodePlugin(dir), InstallHookError);
    assert.equal(fs.readFileSync(destPath, 'utf8'), '// not the real file');

    // --force overwrites it.
    const result = installOpenCodePlugin(dir, { force: true });
    assert.equal(result.changed, true);
    assert.ok(result.copied.includes('modelAliases.js'));
    assert.notEqual(fs.readFileSync(destPath, 'utf8'), '// not the real file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installOpenCodePlugin: missing source file in hooks/ yields an explicit error naming copy-hook-runtime.mjs', () => {
  const dir = mkTempDir();
  const hooksBackupDir = path.resolve(path.dirname(defaultHookScriptPath()));
  const victim = path.join(hooksBackupDir, 'modelAliases.js');
  const backupPath = victim + '.installhook-test-backup';
  const hadVictim = fs.existsSync(victim);
  try {
    if (hadVictim) {
      fs.renameSync(victim, backupPath);
    }
    assert.throws(
      () => installOpenCodePlugin(dir),
      (err) => {
        assert.ok(err instanceof InstallHookError);
        assert.match(err.message, /modelAliases\.js/);
        assert.match(err.message, /copy-hook-runtime\.mjs/);
        return true;
      },
    );
  } finally {
    if (hadVictim && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, victim);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- refreshRuntimeHookCopies (2026-09-06 stale-copy bug fix) --------------

test('refreshRuntimeHookCopies: a stale live copy of the hook (e.g. left by a prior VS Code install) is replaced', () => {
  const dir = mkTempDir();
  try {
    const tycoonDir = path.join(dir, '.claude', 'tycoon');
    fs.mkdirSync(tycoonDir, { recursive: true });
    const destPath = path.join(tycoonDir, 'tycoon-claude-hook.cjs');
    fs.writeFileSync(destPath, '// stale content from an old build\n');

    const refreshed = refreshRuntimeHookCopies(dir);

    assert.deepEqual(refreshed, ['tycoon-claude-hook.cjs']);
    const realHookSrc = fs.readFileSync(defaultHookScriptPath(), 'utf8');
    assert.equal(fs.readFileSync(destPath, 'utf8'), realHookSrc);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshRuntimeHookCopies: an already-identical live copy is left alone (mtime unchanged)', () => {
  const dir = mkTempDir();
  try {
    const tycoonDir = path.join(dir, '.claude', 'tycoon');
    fs.mkdirSync(tycoonDir, { recursive: true });
    const destPath = path.join(tycoonDir, 'tycoon-claude-hook.cjs');
    fs.copyFileSync(defaultHookScriptPath(), destPath);
    const mtimeBefore = fs.statSync(destPath).mtimeMs;

    const refreshed = refreshRuntimeHookCopies(dir);

    assert.deepEqual(refreshed, [], 'identical file must not be reported as refreshed');
    assert.equal(fs.statSync(destPath).mtimeMs, mtimeBefore, 'identical file must not be rewritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshRuntimeHookCopies: a project with no .claude/tycoon runtime copy at all creates nothing', () => {
  const dir = mkTempDir();
  try {
    const refreshed = refreshRuntimeHookCopies(dir);
    assert.deepEqual(refreshed, []);
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'tycoon', 'tycoon-claude-hook.cjs')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installHook: refreshes a stale live hook copy even when registration is already up to date (no changes)', () => {
  const dir = mkTempDir();
  try {
    const tycoonDir = path.join(dir, '.claude', 'tycoon');
    fs.mkdirSync(tycoonDir, { recursive: true });
    fs.writeFileSync(path.join(tycoonDir, 'tycoon-claude-hook.cjs'), '// stale\n');

    // Pre-register the hook command pointing at the repo's real hook script,
    // so the SECOND install() call below is a pure no-op on registration —
    // isolating that the stale-copy refresh does not depend on `changed`.
    const first = installHook(dir);
    assert.equal(first.changed, true);

    const second = installHook(dir);
    assert.equal(second.changed, false, 'registration should already be a no-op on the second call');
    // The stale copy was written to .claude/tycoon before either call and
    // is unrelated to the settings.local.json command (which points at the
    // repo's absolute hooks/ path) — it must still be refreshed regardless.
    const hookContent = fs.readFileSync(path.join(tycoonDir, 'tycoon-claude-hook.cjs'), 'utf8');
    assert.equal(hookContent, fs.readFileSync(defaultHookScriptPath(), 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeHookIntoSettings: does not mutate the input object', () => {
  const input = { hooks: { Stop: [{ matcher: '', hooks: [] }] } };
  const snapshot = JSON.parse(JSON.stringify(input));
  mergeHookIntoSettings(input, 'node "/abs/tycoon-claude-hook.cjs"');
  assert.deepEqual(input, snapshot, 'input settings object must not be mutated');
});

// Core skills ship by default (2026-09-06 decision): install-hook stages
// tycoon-ready-test and tycoon-diagnose into .claude/skills/<id>,
// byte-identical to media/skills/<id>, with no opt-in flag required.
const REPO_ROOT = path.resolve(path.dirname(defaultHookScriptPath()), '..');
const CORE_SKILL_IDS = ['tycoon-ready-test', 'tycoon-diagnose'];

test('installHook: stages both core skills byte-identically and reports them in skillsStaged', () => {
  const dir = mkTempDir();
  try {
    const result = installHook(dir);
    assert.deepEqual([...result.skillsStaged].sort(), [...CORE_SKILL_IDS].sort());

    for (const skillId of CORE_SKILL_IDS) {
      const srcDir = path.join(REPO_ROOT, 'media', 'skills', skillId);
      const destDir = path.join(dir, '.claude', 'skills', skillId);
      const shippedFiles = fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile());
      assert.ok(shippedFiles.length > 0, `sanity: media/skills/${skillId} must have at least one file`);
      for (const entry of shippedFiles) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        assert.ok(fs.existsSync(destPath), `${skillId}/${entry.name} must be staged`);
        assert.ok(
          fs.readFileSync(srcPath).equals(fs.readFileSync(destPath)),
          `${skillId}/${entry.name} must match shipped content byte-for-byte`,
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installHook: second call reports no core skills staged (already current)', () => {
  const dir = mkTempDir();
  try {
    installHook(dir);
    const second = installHook(dir);
    assert.deepEqual(second.skillsStaged, [], 'idempotent re-run should stage nothing new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- installMcpBridgeHooks (p99-t2 review: standalone parity with panel.ts) --

test('installMcpBridgeHooks: copies every MCP_BRIDGE_HOOK_FILES entry into .claude/hooks/, then is idempotent', () => {
  const dir = mkTempDir();
  try {
    const first = installMcpBridgeHooks(dir);
    for (const f of ['tycoon-dispatcher-mcp.cjs', 'dispatcherClaudeChain.cjs', 'dispatcherBridgeClient.cjs', 'codex-mcp-launcher.cjs', 'gemini-mcp-wrapper.cjs', 'bridge-result.cjs', 'fallbackChain.js']) {
      assert.ok(fs.existsSync(path.join(dir, '.claude', 'hooks', f)), `${f} must be installed`);
      assert.ok(first.created.includes(f));
    }
    const second = installMcpBridgeHooks(dir);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.refreshed, []);
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'bridge-result.cjs'), 'stale');
    assert.deepEqual(installMcpBridgeHooks(dir).refreshed, ['bridge-result.cjs']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- CommonJS marker: copied .js modules must load in "type":"module" projects --

test('installMcpBridgeHooks: in a "type":"module" project the copied dispatcher starts and answers MCP initialize', async () => {
  const { spawn } = await import('node:child_process');
  const dir = mkTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'esm-proj', type: 'module' }));
    installMcpBridgeHooks(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hooksDir, 'package.json'), 'utf8')), { type: 'commonjs' });
    const probe = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(hooksDir, 'tycoon-dispatcher-mcp.cjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      let finished = false;
      const done = (v) => { if (finished) return; finished = true; clearTimeout(timer); child.once('close', () => resolve(v)); try { child.kill(); } catch { resolve(v); } };
      const timer = setTimeout(() => done({ out, err, timedOut: true }), 15000);
      child.stdout.on('data', (c) => { out += c; if (out.includes('\n')) done({ out, err }); });
      child.stderr.on('data', (c) => { err += c; });
      child.on('exit', () => { if (!finished) { finished = true; clearTimeout(timer); resolve({ out, err }); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    });
    assert.ok(!/exports is not defined/.test(probe.err), probe.err);
    assert.equal(JSON.parse(probe.out.split('\n')[0]).id, 1, `no initialize reply; stderr: ${probe.err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCommonJsMarker: creates, is idempotent, adds type only when absent, never overrides an explicit type', () => {
  const dir = mkTempDir();
  try {
    assert.equal(ensureCommonJsMarker(dir), 'created');
    assert.equal(ensureCommonJsMarker(dir), 'unchanged');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'keep' }));
    assert.equal(ensureCommonJsMarker(dir), 'updated');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), { name: 'keep', type: 'commonjs' });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    assert.equal(ensureCommonJsMarker(dir), 'unchanged');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).type, 'module');
    fs.writeFileSync(path.join(dir, 'package.json'), '{not json');
    assert.equal(ensureCommonJsMarker(dir), 'skipped');
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), '{not json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healInstalledHookCopies: older install (stale copies, no marker, type:module project) is healed; non-installed files are not added; dispatcher answers initialize', async () => {
  const { spawn } = await import('node:child_process');
  const dir = mkTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'esm-proj', type: 'module' }));
    installMcpBridgeHooks(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    fs.rmSync(path.join(hooksDir, 'package.json'));
    // Simulate an older install: stale content, and a bridge file never installed.
    fs.writeFileSync(path.join(hooksDir, 'gemini-mcp-wrapper.cjs'), 'stale');
    fs.rmSync(path.join(hooksDir, 'codex-app-server-mcp.cjs'));
    const warnings = [];
    const res = healInstalledHookCopies(dir, { warn: (m) => warnings.push(m) });
    assert.deepEqual(res.bridgeRefreshed, ['gemini-mcp-wrapper.cjs']);
    assert.ok(!fs.existsSync(path.join(hooksDir, 'codex-app-server-mcp.cjs')), 'must not add a missing file');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hooksDir, 'package.json'), 'utf8')), { type: 'commonjs' });
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'tycoon')), 'no tycoon dir created');
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(hooksDir, 'tycoon-dispatcher-mcp.cjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let buf = '';
      let finished = false;
      const done = () => { if (finished) return; finished = true; clearTimeout(timer); child.once('close', () => resolve(buf)); try { child.kill(); } catch { resolve(buf); } };
      const timer = setTimeout(done, 15000);
      child.stdout.on('data', (c) => { buf += c; if (buf.includes('\n')) done(); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    });
    assert.equal(JSON.parse(out.split('\n')[0]).id, 1);
    // Explicit module marker is left alone and warned about.
    fs.writeFileSync(path.join(hooksDir, 'package.json'), JSON.stringify({ type: 'module' }));
    healInstalledHookCopies(dir, { warn: (m) => warnings.push(m) });
    assert.equal(JSON.parse(fs.readFileSync(path.join(hooksDir, 'package.json'), 'utf8')).type, 'module');
    assert.ok(warnings.some((m) => /type":"module/.test(m)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healInstalledHookCopies: rewrites versioned extension paths in .mcp.json to the project copy, only for our bridge files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-sa-mcpheal-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-sa-mcpsrc-'));
  try {
    for (const f of ['gemini-mcp-wrapper.cjs', 'claude-cli-mcp.cjs', 'openai-compatible-mcp.cjs']) fs.writeFileSync(path.join(src, f), '// ' + f);
    const mine = { command: 'node', args: ['/opt/other/hooks/gemini-mcp-wrapper.cjs'] };
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        gemini: { command: 'node', args: ['C:/Users/u/.vscode/extensions/tycoonagents.tycoonagents-0.0.685/hooks/gemini-mcp-wrapper.cjs'] },
        'claude-cli': { command: 'node', args: ['C:\\Users\\u\\.vscode\\extensions\\tycoonagents.tycoonagents-0.0.685\\hooks\\claude-cli-mcp.cjs'] },
        'openai-compatible': { command: 'node', args: ['/home/u/.vscode/extensions/tycoonagents.tycoonagents-0.0.600/hooks/openai-compatible-mcp.cjs'] },
        mine,
      },
    }, null, 2));
    healInstalledHookCopies(dir, { hooksSourceDir: src, warn: () => {} });
    const out = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    assert.deepEqual(out.mcpServers.gemini.args, ['.claude/hooks/gemini-mcp-wrapper.cjs']);
    assert.deepEqual(out.mcpServers['claude-cli'].args, ['.claude/hooks/claude-cli-mcp.cjs']);
    assert.deepEqual(out.mcpServers['openai-compatible'].args, ['.claude/hooks/openai-compatible-mcp.cjs']);
    assert.deepEqual(out.mcpServers.mine, mine);
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'hooks', 'gemini-mcp-wrapper.cjs')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('installMcpBridgeHooksForConfig: no .claude/hooks reference copies nothing; gemini copies the wrapper plus bridge-result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-sa-cfgcopy-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-sa-cfgsrc-'));
  try {
    for (const f of ['gemini-mcp-wrapper.cjs', 'bridge-result.cjs', 'claude-cli-mcp.cjs']) fs.writeFileSync(path.join(src, f), '// ' + f);
    assert.deepEqual(installMcpBridgeHooksForConfig(dir, { command: 'npx', args: ['-y', 'some-server'] }, { hooksSourceDir: src }), []);
    assert.ok(!fs.existsSync(path.join(dir, '.claude')));
    const copied = installMcpBridgeHooksForConfig(dir, { command: 'node', args: ['.claude/hooks/gemini-mcp-wrapper.cjs'] }, { hooksSourceDir: src });
    assert.deepEqual(copied.sort(), ['bridge-result.cjs', 'gemini-mcp-wrapper.cjs']);
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'hooks', 'claude-cli-mcp.cjs')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('installHook: POSIX writes an absolute quoted node path; win32 keeps bare node', () => {
  const dir = mkTempDir();
  const dir2 = mkTempDir();
  try {
    const r = installHook(dir, { platform: 'darwin', resolveNode: () => '/opt/homebrew/bin/node' });
    assert.equal(r.hookCommand, `"/opt/homebrew/bin/node" ${posixQuote(defaultHookScriptPath())}`);
    assert.equal(countHookCommand(readSettings(r.settingsPath), r.hookCommand), TYCOON_HOOK_SLOTS.length);
    const w = installHook(dir2, { platform: 'win32', resolveNode: () => '/opt/homebrew/bin/node' });
    assert.equal(w.hookCommand, `node "${defaultHookScriptPath()}"`);
    const bare = installHook(mkTempDir(), { platform: 'linux', resolveNode: () => 'node' });
    assert.equal(bare.hookCommand, `node ${posixQuote(defaultHookScriptPath())}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('installHook: re-run rewrites an existing bare-node Tycoon command to the absolute node form (POSIX), keeps a valid absolute node', () => {
  const dir = mkTempDir();
  try {
    const script = defaultHookScriptPath();
    const bareCmd = `node ${posixQuote(script)}`;
    const sp = path.join(dir, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(mergeHookIntoSettings({}, bareCmd).settings));
    const r = installHook(dir, { platform: 'darwin', resolveNode: () => '/opt/homebrew/bin/node', fileExists: () => true });
    assert.equal(r.changed, true);
    const abs = `"/opt/homebrew/bin/node" ${posixQuote(script)}`;
    assert.equal(countHookCommand(readSettings(sp), abs), TYCOON_HOOK_SLOTS.length);
    assert.equal(countHookCommand(readSettings(sp), bareCmd), 0);
    // A different valid node from discovery does not ping-pong.
    const again = installHook(dir, { platform: 'darwin', resolveNode: () => '/usr/local/bin/node', fileExists: () => true });
    assert.equal(again.changed, false);
    assert.equal(countHookCommand(readSettings(sp), abs), TYCOON_HOOK_SLOTS.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** POSIX token quoting as hookInstall.ts does it (a Windows test host has backslashes in the script path). */
function posixQuote(token) {
  return /[$`"\\]/.test(token) ? `'${token.replace(/'/g, "'\\''")}'` : `"${token}"`;
}
