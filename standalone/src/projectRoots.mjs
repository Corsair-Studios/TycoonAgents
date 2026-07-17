// TycoonAgents standalone — project target resolution (p3-t1).
//
// Replaces vscode.workspace.workspaceFolders for the standalone host: lets
// the CLI target one or more project directories to watch, chosen
// EXPLICITLY, instead of relying on ambient environment state.
//
// PRECEDENCE (hard requirement — see task brief): explicit CLI arg(s) > env
// var > cwd default. This is a hard-won lesson from this exact repo: a past
// bug (see project memory "Project root must be workspace-first") let a
// process-wide CLAUDE_PROJECT_DIR env var silently win over an explicit
// workspace folder, leaking every project's tycoon data into one directory.
// The fix there was "explicit wins over ambient env"; this module encodes
// the same rule for the standalone CLI so it can never regress the same way
// here — CLI args, when present, are used VERBATIM and the env var is never
// consulted at all (not merged, not consulted as a fallback per-arg).
//
// This function is intentionally pure (no process.exit, no console output,
// no reading process.env/process.argv/process.cwd() directly) so it is
// trivially unit-testable — see test/projectRoots.test.mjs. Callers (i.e.
// server.mjs) pass argv/env/cwd in explicitly and are responsible for
// turning a thrown ProjectRootError into a clean CLI error + process.exit(1).
//
// Node built-ins only — standalone/package.json ships zero dependencies.

import fs from 'node:fs';
import path from 'node:path';

/** Thrown for a fatal, user-actionable bad target (missing dir / not a
 * directory). Callers should print `.message` and exit non-zero — never let
 * this surface as an unhandled stack trace. */
export class ProjectRootError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectRootError';
  }
}

/**
 * @typedef {object} ResolvedProjectRoot
 * @property {string} root absolute path to the project directory.
 * @property {string} tycoonDir absolute path to `<root>/.claude/tycoon`
 *   (derived, not validated to exist — see hasTycoonDir).
 * @property {boolean} hasTycoonDir whether `.claude/tycoon` currently exists
 *   under `root`. `false` is VALID, not an error: a project that hasn't run
 *   the Claude Code hook yet has no tycoon dir, and activityWatcher.mjs
 *   already tolerates and picks it up once it's created (see its dirWatch
 *   retry-arm behavior). Only a missing/non-directory `root` is fatal.
 */

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv] positional CLI arguments (already stripped
 *   of `node`/script path — pass `process.argv.slice(2)`), each expected to
 *   be a filesystem path to a project directory. Entries starting with `-`
 *   are treated as flags and ignored here (reserved for future CLI options;
 *   this module only resolves paths). Multiple positional args means
 *   "watch all of these" — see server.mjs for how the first is used as the
 *   primary (state-board-driving) root and the rest are watched alongside.
 * @param {Record<string, string | undefined>} [opts.env] environment
 *   variables to read (pass `process.env`, or a fake object in tests).
 *   Falls back to `TYCOON_STANDALONE_PROJECT_ROOT`, kept as the escape hatch
 *   used by existing tests/tooling; a comma-separated value selects
 *   multiple roots the same way multiple CLI args would.
 * @param {string} [opts.cwd] used both as the final-tier default target and
 *   as the base for resolving any relative path from argv/env into an
 *   absolute one (pass `process.cwd()`).
 * @returns {{ source: 'argv' | 'env' | 'cwd', roots: ResolvedProjectRoot[] }}
 * @throws {ProjectRootError} if any resolved target does not exist, or
 *   exists but is not a directory. The message names the offending path and
 *   what was expected so it is safe to print directly to the user — never
 *   a raw stack trace.
 */
export function resolveProjectRoots({ argv = [], env = {}, cwd = process.cwd() } = {}) {
  const cliArgs = (Array.isArray(argv) ? argv : []).filter(
    (a) => typeof a === 'string' && a.trim() !== '' && !a.startsWith('-'),
  );

  /** @type {'argv' | 'env' | 'cwd'} */
  let source;
  /** @type {string[]} */
  let rawTargets;

  if (cliArgs.length > 0) {
    // Explicit CLI arg(s) ALWAYS win — the env var is not even consulted.
    // This is the crux of the precedence rule: an ambient env var must never
    // silently override something the caller typed on the command line.
    source = 'argv';
    rawTargets = cliArgs;
  } else if (typeof env.TYCOON_STANDALONE_PROJECT_ROOT === 'string' && env.TYCOON_STANDALONE_PROJECT_ROOT.trim() !== '') {
    source = 'env';
    rawTargets = env.TYCOON_STANDALONE_PROJECT_ROOT.split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  } else {
    source = 'cwd';
    rawTargets = [cwd];
  }

  const roots = rawTargets.map((raw) => resolveOne(raw, cwd));
  return { source, roots };
}

/** @returns {ResolvedProjectRoot} */
function resolveOne(raw, cwd) {
  const absolute = path.resolve(cwd, raw);

  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new ProjectRootError(
      `TycoonAgents standalone: project directory not found: "${absolute}"` +
        (raw !== absolute ? ` (resolved from "${raw}")` : '') +
        `. Expected an existing directory (it may not have .claude/tycoon yet — that's fine, but the directory itself must exist).`,
    );
  }
  if (!stat.isDirectory()) {
    throw new ProjectRootError(
      `TycoonAgents standalone: project path is not a directory: "${absolute}"` +
        (raw !== absolute ? ` (resolved from "${raw}")` : '') +
        `. Expected a directory, found a file.`,
    );
  }

  const tycoonDir = path.join(absolute, '.claude', 'tycoon');
  return { root: absolute, tycoonDir, hasTycoonDir: fs.existsSync(tycoonDir) };
}
