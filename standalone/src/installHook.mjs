// TycoonAgents standalone — Claude Code hook installer (p3-t3).
//
// Registers the TycoonAgents hook (hooks/tycoon-claude-hook.cjs, at the repo
// root) into a target project's Claude Code settings so the standalone host
// receives the same UserPromptSubmit/PreToolUse/SubagentStop/Stop/
// TaskCompleted events the VS Code extension does.
//
// TYCOON_HOOK_SLOTS and the settings-merge algorithm are NOT reimplemented
// here — they're reused in place from src/host/vscode/hookInstall.ts (a
// 100% vscode-free file: `fs`/`path` only) via sharedLogic.mjs's
// createRequire bridge into the compiled `out/src/host/vscode/hookInstall.js`,
// the same pattern sharedLogic.mjs already uses for state.js/mapHookRecord.js.
// That means one settings-merge bug fix on the extension side now reaches
// both hosts automatically instead of needing a hand-sync. See
// PHASE5-SHARED-CORE-PROPOSAL.md Proposal A.
//
// ONE DELIBERATE DIVERGENCE from hookInstall.ts, required by this task's
// brief: the VS Code extension COPIES tycoon-claude-hook.cjs into each
// project's `.claude/tycoon/` and points the hook command at that relative
// copy (so the shipped VSIX is self-contained). The standalone CLI instead
// runs directly out of this repo checkout, so it references the repo's
// `hooks/tycoon-claude-hook.cjs` VERBATIM by absolute path — no copy, no
// fork, always in sync with the one real hook script. That absolute path is
// computed at runtime from import.meta.url (never a string literal), so
// nothing under standalone/ bakes in a machine-specific path — see
// project rule "no absolute paths in artifacts". The resulting settings.json
// written into the TARGET project legitimately contains an absolute path;
// that's runtime output on the user's machine, same as the extension's own
// generated settings, not a tracked file.
//
// Node built-ins only — standalone/package.json ships zero dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTycoonHooks, getTycoonHookSlots, getRuntimeHookFiles, syncRuntimeFile } from './sharedLogic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Lazy read-only array view over `getSlots()`'s result: forwards every
 * property/iteration access to the real array on first touch, then caches.
 * Lets `TYCOON_HOOK_SLOTS` stay a plain importable array (so existing
 * `TYCOON_HOOK_SLOTS.length`/iteration call sites don't change) while still
 * honoring sharedLogic.mjs's "never require `out/` just from importing this
 * module" contract — e.g. `cli.mjs watch` never touches the compiled
 * hookInstall.js. */
function lazyArray(getSlots) {
  let cached;
  const resolve = () => (cached ??= getSlots());
  return new Proxy(/** @type {unknown[]} */ ([]), {
    get(_target, prop, receiver) {
      return Reflect.get(resolve(), prop, receiver);
    },
    has(_target, prop) {
      return Reflect.has(resolve(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(resolve(), prop);
    },
  });
}

/** Thrown for any fatal, user-actionable install failure (bad target dir,
 * missing hook script, corrupt settings file). Callers should print
 * `.message` and exit non-zero — never let this surface as a raw stack
 * trace. */
export class InstallHookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallHookError';
  }
}

/**
 * The Claude Code hook events + matchers TycoonAgents wires up — the exact
 * `TYCOON_HOOK_SLOTS` array from src/host/vscode/hookInstall.ts, reused via
 * sharedLogic.mjs (not a hand-synced copy). Resolved lazily on first access.
 * @type {ReadonlyArray<{event: string, matcher: string}>}
 */
export const TYCOON_HOOK_SLOTS = lazyArray(getTycoonHookSlots);

/**
 * Merges the TycoonAgents hook into an existing Claude Code settings object,
 * via the shared, pure `mergeTycoonHooks` (src/host/vscode/hookInstall.ts,
 * reused through sharedLogic.mjs — see module header). `mergeTycoonHooks`
 * itself returns only the merged settings object (no `changed` flag), so
 * `changed` is computed here by comparing the `hooks` section before/after —
 * structurally equal (same keys, same order, same entries) iff every slot
 * already referenced our hook, i.e. a no-op re-run. The CLI's "hook
 * registered" vs "already registered (no changes)" messaging depends on this
 * being accurate.
 *
 * @param {Record<string, unknown>} existing parsed settings object (or {}).
 * @param {string} hookCommand the command string to install, e.g.
 *   `node "/abs/path/to/tycoon-claude-hook.cjs"`.
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function mergeHookIntoSettings(existing, hookCommand) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const beforeHooksJson = JSON.stringify(base.hooks ?? {});
  const settings = mergeTycoonHooks(base, hookCommand);
  const afterHooksJson = JSON.stringify(settings.hooks ?? {});
  return { settings, changed: beforeHooksJson !== afterHooksJson };
}

/** Absolute path to the repo's real hook script (never copied/forked). */
export function defaultHookScriptPath() {
  return path.resolve(__dirname, '..', '..', 'hooks', 'tycoon-claude-hook.cjs');
}

/** Absolute path to the repo's `hooks/` directory (source of the OpenCode
 * plugin files copied by {@link installOpenCodePlugin}). */
function hooksDir() {
  return path.resolve(__dirname, '..', '..', 'hooks');
}

/** The files copied into a target project's `.opencode/plugin/` directory
 * to register the TycoonAgents OpenCode plugin (p7-t2). These are built by
 * `scripts/copy-hook-runtime.mjs` (agentBackend.js/modelAliases.js) and
 * hand-authored (tycoon-opencode-plugin.ts) — all three live in this repo's
 * `hooks/` alongside tycoon-claude-hook.cjs. */
export const OPENCODE_PLUGIN_FILES = Object.freeze([
  'tycoon-opencode-plugin.ts',
  'agentBackend.js',
  'modelAliases.js',
  'delegationEnforcement.js',
  'fallbackChain.js',
]);

/**
 * Idempotently registers the TycoonAgents OpenCode plugin in `targetDir` by
 * copying {@link OPENCODE_PLUGIN_FILES} from this repo's `hooks/` directory
 * into `<targetDir>/.opencode/plugin/` (singular `plugin/` — OpenCode
 * 1.18.27 loads `.ts` plugins from exactly that directory; this mirrors how
 * the M2 smoke test staged the plugin by hand).
 *
 * This is a SEPARATE opt-in from {@link installHook} (the Claude Code hook
 * installer) — calling this never touches `.claude/settings.local.json`,
 * and calling `installHook` never touches `.opencode/`. The two are
 * independent registrations a project can have either, both, or neither of.
 *
 * @param {string} targetDir project directory to install into.
 * @param {object} [opts]
 * @param {boolean} [opts.force] when true, overwrite a destination file
 *   whose content differs from the source instead of throwing.
 * @returns {{ pluginDir: string, changed: boolean, copied: string[], skipped: string[] }}
 *   `copied`: files actually written this run (fresh or `--force`-overwritten).
 *   `skipped`: files already present and byte-identical to the source (a
 *   pure no-op re-run has every file in `skipped` and `changed: false`).
 * @throws {InstallHookError} on a missing/non-directory target, a missing
 *   source file in `hooks/` (naming `scripts/copy-hook-runtime.mjs` as the
 *   generator for the two `.js` files), or — without `--force` — a
 *   destination file that already exists with DIFFERENT content than the
 *   source (never silently clobbered).
 */
export function installOpenCodePlugin(targetDir, opts = {}) {
  const absTarget = path.resolve(String(targetDir ?? ''));

  let targetStat;
  try {
    targetStat = fs.statSync(absTarget);
  } catch {
    throw new InstallHookError(
      `TycoonAgents: install target directory not found: "${absTarget}"`,
    );
  }
  if (!targetStat.isDirectory()) {
    throw new InstallHookError(
      `TycoonAgents: install target is not a directory: "${absTarget}"`,
    );
  }

  const srcDir = hooksDir();
  const missing = OPENCODE_PLUGIN_FILES.filter((f) => !fs.existsSync(path.join(srcDir, f)));
  if (missing.length > 0) {
    throw new InstallHookError(
      `TycoonAgents: could not install the OpenCode plugin — missing source file(s) in "${srcDir}": ` +
        `${missing.join(', ')}. tycoon-opencode-plugin.ts ships in the repo checkout; agentBackend.js ` +
        `and modelAliases.js are built by \`node scripts/copy-hook-runtime.mjs\` (run \`npx tsc -p .\` ` +
        `first) — run that from the repo root, then retry.`,
    );
  }

  const pluginDir = path.join(absTarget, '.opencode', 'plugin');

  // Pre-flight: with no --force, refuse (without writing anything) if any
  // destination file exists and differs from its source.
  if (!opts.force) {
    for (const file of OPENCODE_PLUGIN_FILES) {
      const destPath = path.join(pluginDir, file);
      if (!fs.existsSync(destPath)) continue;
      const srcBytes = fs.readFileSync(path.join(srcDir, file));
      const destBytes = fs.readFileSync(destPath);
      if (!srcBytes.equals(destBytes)) {
        throw new InstallHookError(
          `TycoonAgents: could not install the OpenCode plugin — "${destPath}" already exists and ` +
            `differs from the repo's copy. Re-run with --force to overwrite it, or remove it first.`,
        );
      }
    }
  }

  fs.mkdirSync(pluginDir, { recursive: true });

  const copied = [];
  const skipped = [];
  for (const file of OPENCODE_PLUGIN_FILES) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(pluginDir, file);
    const srcBytes = fs.readFileSync(srcPath);
    if (fs.existsSync(destPath)) {
      const destBytes = fs.readFileSync(destPath);
      if (srcBytes.equals(destBytes)) {
        skipped.push(file);
        continue;
      }
      // Only reachable with --force (pre-flight above already threw
      // otherwise) — differing content, explicitly permitted to overwrite.
    }
    fs.writeFileSync(destPath, srcBytes);
    copied.push(file);
  }

  return { pluginDir, changed: copied.length > 0, copied, skipped };
}

/** Strips a leading UTF-8 BOM, matching hooks/tycoon-claude-hook.cjs's own
 * tolerant JSON reading so a settings.json saved with a BOM by some editors
 * doesn't misreport as corrupt. */
function stripBom(s) {
  return s.length > 0 && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Refreshes any STALE runtime hook file(s) already sitting in
 * `<targetDir>/.claude/tycoon/` (the bundled hook script + its companions —
 * see {@link RUNTIME_HOOK_FILES's source, `getRuntimeHookFiles`}), by
 * content hash, independent of hook REGISTRATION status.
 *
 * Fixes the 2026-09-06 bug: `install-hook` only ever checked whether the
 * settings.local.json hook COMMAND already referenced *a*
 * tycoon-claude-hook.cjs (by filename substring — see `isOurHookCommand` in
 * hookInstall.ts) and, if so, reported "already registered (no changes)"
 * without ever looking at the CONTENT of a runtime copy such a command
 * might point at — e.g. a `.claude/tycoon/tycoon-claude-hook.cjs` left
 * behind by an earlier VS Code extension install/repair. That copy could
 * go stale relative to the repo's `hooks/tycoon-claude-hook.cjs` and no
 * command run afterward would ever refresh it.
 *
 * This function is deliberately conservative about WHEN it acts: standalone
 * itself never creates a `.claude/tycoon/` runtime copy (it registers the
 * hook command by absolute path straight into this repo's `hooks/`, per
 * the module header above) — so a file here is only ever refreshed if it
 * ALREADY exists (put there by something else, i.e. VS Code). A project
 * with no such copy is left exactly as `installHook` would have left it
 * before this fix: no new files created, no behavior change.
 *
 * @param {string} targetDir project directory to check.
 * @param {object} [opts]
 * @param {string} [opts.hooksSourceDir] override for the source `hooks/`
 *   directory (tests only — production callers use the default, this
 *   repo's own `hooks/`).
 * @returns {string[]} basenames actually overwritten this run (differed by
 *   content from the source). Empty when every existing copy already
 *   matched, or when the project has no runtime copies at all.
 */
export function refreshRuntimeHookCopies(targetDir, opts = {}) {
  const absTarget = path.resolve(String(targetDir ?? ''));
  const tycoonDir = path.join(absTarget, '.claude', 'tycoon');
  const srcDir = opts.hooksSourceDir ?? hooksDir();
  const refreshed = [];
  for (const file of getRuntimeHookFiles()) {
    const destPath = path.join(tycoonDir, file);
    if (!fs.existsSync(destPath)) {
      // No copy here — standalone doesn't create one; nothing to refresh.
      continue;
    }
    const srcPath = path.join(srcDir, file);
    if (!fs.existsSync(srcPath)) {
      // Companion not built/shipped in this checkout — leave the existing
      // copy alone rather than erroring; registration itself still works.
      continue;
    }
    const status = syncRuntimeFile(srcPath, destPath);
    if (status === 'refreshed') {
      refreshed.push(file);
    }
  }
  return refreshed;
}

/**
 * Idempotently registers the TycoonAgents hook in `targetDir`'s Claude Code
 * settings (`.claude/settings.local.json` — the same project-local,
 * uncommitted file hookInstall.ts writes hook registrations into; shared
 * `.claude/settings.json` is left untouched, same as the extension).
 *
 * @param {string} targetDir project directory to install into.
 * @param {object} [opts]
 * @param {string} [opts.hookScriptPath] override for the hook script's
 *   absolute path (tests only — production callers use the default, which
 *   points at this repo's real hooks/tycoon-claude-hook.cjs).
 * @returns {{ settingsPath: string, changed: boolean, hookCommand: string, refreshed: string[] }}
 *   `refreshed`: runtime hook file(s) under `.claude/tycoon/` that were
 *   overwritten because they existed and differed by content from this
 *   repo's `hooks/` — see {@link refreshRuntimeHookCopies}. Independent of
 *   `changed` (registration status): either can be true/non-empty without
 *   the other.
 * @throws {InstallHookError} on a missing/non-directory target, a missing
 *   hook script, or a settings file that exists but fails to parse as a JSON
 *   object. In every throw case the target settings file (if any) is left
 *   completely unmodified.
 */
export function installHook(targetDir, opts = {}) {
  const absTarget = path.resolve(String(targetDir ?? ''));

  let targetStat;
  try {
    targetStat = fs.statSync(absTarget);
  } catch {
    throw new InstallHookError(
      `TycoonAgents: install-hook target directory not found: "${absTarget}"`,
    );
  }
  if (!targetStat.isDirectory()) {
    throw new InstallHookError(
      `TycoonAgents: install-hook target is not a directory: "${absTarget}"`,
    );
  }

  const hookScriptPath = opts.hookScriptPath ?? defaultHookScriptPath();
  if (!fs.existsSync(hookScriptPath)) {
    throw new InstallHookError(
      `TycoonAgents: hook script not found at "${hookScriptPath}" — is the repo checkout intact?`,
    );
  }
  const hookCommand = `node "${hookScriptPath}"`;

  const claudeDir = path.join(absTarget, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  let existing = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const trimmed = stripBom(raw).trim();
    if (trimmed !== '') {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new InstallHookError(
          `TycoonAgents: could not install hook — "${settingsPath}" is not valid JSON (${err.message}). ` +
            `Fix or remove that file, then re-run. It was NOT modified.`,
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new InstallHookError(
          `TycoonAgents: could not install hook — "${settingsPath}" does not contain a JSON object at its top level. ` +
            `Fix or remove that file, then re-run. It was NOT modified.`,
        );
      }
      existing = parsed;
    }
  }

  const { settings: merged, changed } = mergeHookIntoSettings(existing, hookCommand);

  if (changed) {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  const refreshed = refreshRuntimeHookCopies(absTarget);

  return { settingsPath, changed, hookCommand, refreshed };
}
