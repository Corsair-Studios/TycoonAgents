// TycoonAgents standalone — Claude Code hook installer (p3-t3).
//
// Registers the TycoonAgents hook (hooks/tycoon-claude-hook.cjs, at the repo
// root) into a target project's Claude Code settings so the standalone host
// receives the same UserPromptSubmit/PreToolUse/SubagentStop/Stop/
// TaskCompleted events the VS Code extension does.
//
// This intentionally MIRRORS src/host/vscode/hookInstall.ts's settings shape
// and idempotency approach (same event/matcher slots, same "does an entry
// already reference our hook by command substring" detection, same
// leave-existing-entry-in-place behavior) WITHOUT importing that file —
// hookInstall.ts is TypeScript, built as part of the VS Code extension, and
// off-limits to edit for this task; duplicating the small, stable slot list
// here keeps `standalone/` a fully independent build target (see
// package.json description) with zero coupling to the extension's build.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * The Claude Code hook events + matchers TycoonAgents wires up. Kept in sync
 * BY HAND with TYCOON_HOOK_SLOTS in src/host/vscode/hookInstall.ts (small,
 * stable list — see module header for why this isn't a shared import).
 * @type {ReadonlyArray<{event: string, matcher: string}>}
 */
export const TYCOON_HOOK_SLOTS = [
  { event: 'UserPromptSubmit', matcher: '' },
  { event: 'PreToolUse', matcher: 'Task|Agent|Skill' },
  { event: 'PreToolUse', matcher: 'Read|Write|Edit|Grep|Glob|Bash' },
  { event: 'PreToolUse', matcher: 'mcp__' },
  { event: 'SubagentStop', matcher: '' },
  { event: 'Stop', matcher: '' },
  { event: 'TaskCompleted', matcher: '' },
];

/** Substring every generated hook command contains; also how an existing
 * entry is recognized as "already ours" regardless of exact path/quoting. */
const HOOK_MARKER = 'tycoon-claude-hook.cjs';

/**
 * Pure merge of the TycoonAgents hook into an existing Claude Code settings
 * object. Adds our hook for each event/matcher in TYCOON_HOOK_SLOTS without
 * dropping unrelated keys/hooks and without duplicating an entry that
 * already references our hook (matched by {@link HOOK_MARKER} substring, so
 * re-running after the hook script path changes still recognizes the old
 * entry rather than adding a second one — same behavior as hookInstall.ts).
 * No fs usage, so this is trivially unit-testable.
 *
 * @param {Record<string, unknown>} existing parsed settings object (or {}).
 * @param {string} hookCommand the command string to install, e.g.
 *   `node "/abs/path/to/tycoon-claude-hook.cjs"`.
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 *   `changed` is false when every slot already referenced our hook, i.e. a
 *   no-op re-run.
 */
export function mergeHookIntoSettings(existing, hookCommand) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const result = { ...base };
  const srcHooks =
    base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks) ? base.hooks : {};
  const hooks = {};
  let changed = false;

  for (const event of Object.keys(srcHooks)) {
    const arr = srcHooks[event];
    hooks[event] = Array.isArray(arr) ? arr.slice() : [];
  }

  for (const slot of TYCOON_HOOK_SLOTS) {
    const list = hooks[slot.event] ?? (hooks[slot.event] = []);
    const matching = list.find(
      (e) => e !== null && typeof e === 'object' && e.matcher === slot.matcher,
    );
    const referencesOurHook =
      matching !== undefined &&
      Array.isArray(matching.hooks) &&
      matching.hooks.some(
        (h) =>
          h !== null &&
          typeof h === 'object' &&
          typeof h.command === 'string' &&
          h.command.includes(HOOK_MARKER),
      );
    if (referencesOurHook) {
      continue;
    }
    list.push({
      matcher: slot.matcher,
      hooks: [{ type: 'command', command: hookCommand }],
    });
    changed = true;
  }

  result.hooks = hooks;
  return { settings: result, changed };
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
