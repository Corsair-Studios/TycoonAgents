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
