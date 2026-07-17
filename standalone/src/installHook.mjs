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
import { mergeTycoonHooks, getTycoonHookSlots } from './sharedLogic.mjs';

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

/** Strips a leading UTF-8 BOM, matching hooks/tycoon-claude-hook.cjs's own
 * tolerant JSON reading so a settings.json saved with a BOM by some editors
 * doesn't misreport as corrupt. */
function stripBom(s) {
  return s.length > 0 && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
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
 * @returns {{ settingsPath: string, changed: boolean, hookCommand: string }}
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

  return { settingsPath, changed, hookCommand };
}
