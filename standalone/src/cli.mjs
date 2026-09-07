#!/usr/bin/env node
// TycoonAgents™ standalone — CLI command dispatch (p3-t3, watch added p4-t1).
//
// Minimal command router: `install-hook <dir>` and `watch <dir> [<dir2> ...]`.
// This file (via the package.json `bin` field) is what `npx
// tycoonagents-standalone` / a global `tycoonagents-standalone` install
// actually runs.
//
// `watch` reuses server.mjs's exported startServer() seam — it does NOT
// reimplement any server/state-feed wiring. The one thing this file owns
// that server.mjs's own `npm start` main() intentionally does NOT do:
// resolving relative project-dir args against the user's REAL shell cwd
// (process.cwd()), not this repo's REPO_ROOT — see runWatchCommand() below
// and server.mjs's startServer() doc comment for the full rationale (this
// was a footgun flagged during p3-t1 review).
//
// Node built-ins only — standalone/package.json ships zero dependencies.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { installHook, installOpenCodePlugin, InstallHookError } from './installHook.mjs';
import { seedAgents, SeedAgentsError } from './seedAgents.mjs';
import { startServer, ServerStartError } from './server.mjs';
import { ProjectRootError } from './projectRoots.mjs';
import { resolveProviderId } from './sharedLogic.mjs';

function printUsage() {
  console.error(
    [
      'Usage: tycoonagents-standalone <command> [args]',
      '',
      'Commands:',
      '  install-hook <dir>          Idempotently register the TycoonAgents Claude',
      '                               Code hook in <dir>/.claude/settings.local.json.',
      '                               --opencode                Instead (separate opt-in),',
      '                               idempotently copy the TycoonAgents OpenCode plugin',
      '                               (tycoon-opencode-plugin.ts, agentBackend.js,',
      '                               modelAliases.js) into <dir>/.opencode/plugin/.',
      '                               Never touches settings.local.json. --force',
      '                               overwrites a destination file that differs from',
      '                               the repo copy (default: refuse and error).',
      '                               --no-agents               Skip seeding the',
      '                               core agent roster (.claude/agents/*.md +',
      '                               .claude/tycoon/agent-keywords.json) that',
      '                               install-hook otherwise seeds by default — see',
      '                               `seed-agents` below.',
      '  seed-agents <dir>           Idempotently seed the core agent roster',
      '                               (search-retrieval, primary-agent,',
      '                               coding-specialist, ux-ui-designer, reviewer)',
      '                               into <dir>/.claude/agents/*.md, and',
      '                               <dir>/.claude/tycoon/agent-keywords.json if',
      '                               missing — the same roster a fresh VS Code',
      '                               install writes in direct-delegation mode.',
      '                               Never overwrites an existing file. Also run',
      '                               automatically by `install-hook` unless',
      '                               --no-agents is passed.',
      '  watch <dir> [<dir2> ...]    Start the live agent visualization server for',
      '                               <dir> (a project containing, or that will',
      '                               contain, .claude/tycoon/) and open it in your',
      '                               default browser. Additional dirs are watched',
      '                               too but only the first drives the board — see',
      '                               server.mjs. Relative paths resolve against',
      '                               your current shell directory.',
      '                               Flags: --no-open (also: env',
      '                               TYCOON_STANDALONE_NO_OPEN=1) suppresses the',
      '                               automatic browser launch. --provider <id>',
      '                               (claude-code|opencode, also: env',
      '                               TYCOON_PROVIDER) selects which harness to',
      '                               read activity from; TYCOON_PROVIDER always',
      '                               overrides this flag.',
    ].join('\n'),
  );
}

/**
 * Pure parse of `watch`'s argv (positional project dirs + the one flag it
 * understands). No I/O, no process/env reads — exported for unit testing
 * (see test/cli.test.mjs).
 *
 * @param {string[]} argv everything after `watch` (i.e. `rest` from runCli's
 *   `[command, ...rest]` destructure).
 * @returns {{ dirs: string[], noOpen: boolean }} `dirs`: positional args, in
 *   order, forwarded verbatim as resolveProjectRoots' argv slot (that
 *   function already ignores anything starting with '-', so stripping flags
 *   here is a documentation/robustness measure, not a behavior change for
 *   dir resolution itself — but it does keep an unrecognized future flag
 *   from ever being misread as "watch a directory literally named
 *   --that-flag").
 */
export function parseWatchArgs(argv) {
  const dirs = [];
  let noOpen = false;
  let provider;
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === '--no-open') {
      noOpen = true;
    } else if (arg === '--provider') {
      provider = list[i + 1];
      i++;
    } else if (typeof arg === 'string' && arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length);
    } else if (typeof arg === 'string' && arg.trim() !== '' && !arg.startsWith('-')) {
      dirs.push(arg);
    }
    // Any other '-'-prefixed token is silently ignored (reserved for future
    // flags), matching resolveProjectRoots' own tolerance of unknown flags.
  }
  return provider === undefined ? { dirs, noOpen } : { dirs, noOpen, provider };
}

/** Whether the browser auto-open should fire, given the parsed `--no-open`
 * flag and env. Pure — takes `env` as a parameter instead of reading
 * `process.env` directly, so it's testable without mutating real env. */
function shouldOpenBrowser({ noOpenFlag, env }) {
  return !noOpenFlag && env.TYCOON_STANDALONE_NO_OPEN !== '1';
}

/**
 * Opens `url` in the OS default browser via the per-platform opener command.
 * Node built-ins only (child_process) — no `open`/`opener` npm package.
 * NON-FATAL by design (task requirement): a headless/CI/SSH environment with
 * no browser/opener command available must never crash `watch` — it just
 * logs and the server keeps running with the URL printed for the user to
 * open manually.
 */
function openInBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === 'win32') {
    // cmd's built-in `start` treats its first quoted argument as the window
    // title, not the target — pass an empty title first so `url` isn't
    // swallowed as one.
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', (err) => {
      console.error(
        `TycoonAgents: could not open a browser automatically (${err.message}). Open ${url} in your browser.`,
      );
    });
    child.unref();
  } catch (err) {
    console.error(
      `TycoonAgents: could not open a browser automatically (${err.message}). Open ${url} in your browser.`,
    );
  }
}

/**
 * Runs the `watch` command: starts the server (via server.mjs's
 * startServer() — no reimplementation), opens/suppresses the browser, then
 * blocks until asked to stop.
 *
 * @param {string[]} rest argv after `watch`.
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env] defaults to
 *   `process.env`; injectable for tests.
 * @param {string} [opts.cwd] defaults to `process.cwd()` — the user's REAL
 *   shell cwd (the p3-t1-review fix this task requires: relative project
 *   dirs must resolve here, never against REPO_ROOT). Injectable for tests.
 * @param {AbortSignal} [opts.signal] when provided, used INSTEAD of real
 *   SIGINT/SIGTERM process signal handlers to trigger shutdown — lets tests
 *   drive a real, listening server and then cleanly stop it without sending
 *   an actual OS signal to the test process.
 * @returns {Promise<number>} process exit code (0 on a clean stop, 1 on a
 *   clean, user-actionable startup failure).
 */
export async function runWatchCommand(rest, { env = process.env, cwd = process.cwd(), signal } = {}) {
  const { dirs, noOpen, provider: providerFlag } = parseWatchArgs(rest);

  // --provider sets TYCOON_PROVIDER before sharedLogic (and, transitively,
  // resolveProviderId) ever loads — but a real TYCOON_PROVIDER already
  // present in `env` wins, matching resolveProviderId's own env-first
  // precedence (src/core/providerSelection.ts).
  if (providerFlag !== undefined && (env.TYCOON_PROVIDER === undefined || env.TYCOON_PROVIDER === '')) {
    env.TYCOON_PROVIDER = providerFlag;
  }

  let resolvedProviderId;
  try {
    resolvedProviderId = resolveProviderId({ env, projectDir: cwd });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let runtime;
  try {
    runtime = await startServer({ argv: dirs, env, cwd });
  } catch (err) {
    if (err instanceof ProjectRootError || err instanceof ServerStartError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  console.log(`TycoonAgents: using provider "${resolvedProviderId}".`);
  console.log(`TycoonAgents: watching. Open ${runtime.url} in your browser.`);
  if (shouldOpenBrowser({ noOpenFlag: noOpen, env })) {
    openInBrowser(runtime.url);
  } else {
    console.log('TycoonAgents: automatic browser launch suppressed.');
  }

  // Block until stopped. Real CLI usage: Ctrl+C (SIGINT) or a SIGTERM from a
  // process manager. Tests: pass `signal` (an AbortController's signal)
  // instead so they can trigger the exact same close() path deterministically
  // without touching real OS signal handlers (which are process-global and
  // would leak across unrelated tests in the same process).
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      runtime.close().then(resolve, resolve);
    };
    if (signal) {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    } else {
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    }
  });

  return 0;
}

/**
 * Prints one line per file `seedAgents` actually wrote, plus a one-line
 * summary — shared by `install-hook`'s auto-seed step and the standalone
 * `seed-agents` command so their output is identical either way.
 * @param {{ agentsDir: string, keywordsPath: string, seededAgents: string[],
 *   skippedAgents: string[], seededKeywords: boolean }} result
 */
function printSeedAgentsResult(result) {
  const { agentsDir, keywordsPath, seededAgents, skippedAgents, seededKeywords } = result;
  for (const id of seededAgents) {
    console.log(`TycoonAgents: seeded ${path.join(agentsDir, `${id}.md`)}`);
  }
  if (seededKeywords) {
    console.log(`TycoonAgents: seeded ${keywordsPath}`);
  }
  console.log(
    `TycoonAgents: agent roster — ${seededAgents.length} seeded, ${skippedAgents.length} already present` +
      (seededKeywords ? ', agent-keywords.json seeded.' : ', agent-keywords.json already present or up to date.'),
  );
}

/**
 * @param {string[]} argv `process.argv.slice(2)`.
 * @returns {Promise<number>} process exit code.
 */
export async function runCli(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case 'install-hook': {
      const flags = rest.filter((a) => typeof a === 'string' && a.startsWith('-'));
      const dir = rest.find((a) => typeof a === 'string' && !a.startsWith('-'));
      if (!dir) {
        console.error('tycoonagents-standalone install-hook: missing <dir> argument.');
        printUsage();
        return 1;
      }

      if (flags.includes('--opencode')) {
        const force = flags.includes('--force');
        try {
          const { pluginDir, changed, copied, skipped } = installOpenCodePlugin(dir, { force });
          console.log(
            changed
              ? `TycoonAgents: OpenCode plugin installed in ${pluginDir} (copied: ${copied.join(', ')}` +
                  (skipped.length > 0 ? `; unchanged: ${skipped.join(', ')})` : ')')
              : `TycoonAgents: OpenCode plugin already installed in ${pluginDir} (no changes).`,
          );
        } catch (err) {
          if (err instanceof InstallHookError) {
            console.error(err.message);
            return 1;
          }
          throw err;
        }

        if (!flags.includes('--no-agents')) {
          try {
            printSeedAgentsResult(seedAgents(dir));
          } catch (err) {
            if (err instanceof SeedAgentsError) {
              console.error(err.message);
              return 1;
            }
            throw err;
          }
        }
        return 0;
      }

      const { settingsPath, changed, refreshed, skillsStaged } = installHook(dir);
      for (const file of refreshed) {
        console.log(`TycoonAgents: refreshed ${file}`);
      }
      for (const skillId of skillsStaged ?? []) {
        console.log(`TycoonAgents: staged skill ${skillId}`);
      }
      console.log(
        changed
          ? `TycoonAgents: hook registered in ${settingsPath}`
          : `TycoonAgents: hook already registered in ${settingsPath} (no changes).`,
      );

      if (!flags.includes('--no-agents')) {
        try {
          printSeedAgentsResult(seedAgents(dir));
        } catch (err) {
          if (err instanceof SeedAgentsError) {
            console.error(err.message);
            return 1;
          }
          throw err;
        }
      }
      return 0;
    }

    case 'seed-agents': {
      const dir = rest.find((a) => typeof a === 'string' && !a.startsWith('-'));
      if (!dir) {
        console.error('tycoonagents-standalone seed-agents: missing <dir> argument.');
        printUsage();
        return 1;
      }
      try {
        printSeedAgentsResult(seedAgents(dir));
      } catch (err) {
        if (err instanceof SeedAgentsError) {
          console.error(err.message);
          return 1;
        }
        throw err;
      }
      return 0;
    }

    case 'watch': {
      return runWatchCommand(rest);
    }

    case undefined:
    case '-h':
    case '--help':
    case 'help': {
      printUsage();
      return command === undefined ? 1 : 0;
    }

    default: {
      console.error(`tycoonagents-standalone: unknown command "${command}".`);
      printUsage();
      return 1;
    }
  }
}

async function main() {
  try {
    const code = await runCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (err) {
    const message =
      err instanceof InstallHookError ||
      err instanceof SeedAgentsError ||
      err instanceof ProjectRootError ||
      err instanceof ServerStartError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

// Only auto-run when invoked directly (`node src/cli.mjs ...`), not when
// imported by tests via `import { runCli } from '../src/cli.mjs'`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
