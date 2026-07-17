# TycoonAgents — Standalone Host

A VS Code-independent way to run the TycoonAgents live agent visualization.
It watches the same Claude Code hook data the VS Code extension watches
(`.claude/tycoon/` in a project directory) and serves the **same, unmodified**
`media/main.js` webview in a browser tab instead of a VS Code panel.

This is an independent build target from the VS Code extension: it does not
ship in the extension's `.vsix` (excluded via the repo's `.vscodeignore`) and
running it never builds, packages, or otherwise touches the extension.

## Prerequisites

- Node.js `>=18` (see `engines.node` in `standalone/package.json`).
- The repo's TypeScript sources compiled once, from the **repo root**:

  ```sh
  npx tsc -p .
  ```

  Why: the standalone does not fork or reimplement the extension's pure
  state logic (`computeStateFromRecords`, `mapHookRecord`, etc. in
  `src/core/state.ts` / `src/providers/claude-code/mapHookRecord.ts`). It
  `require()`s the **compiled** output of those files from `out/src/...` at
  runtime (see `src/sharedLogic.mjs`) so both hosts stay byte-for-byte
  behaviorally identical. `out/` is gitignored, so this step is required
  after every fresh clone and after pulling changes to `src/core/state.ts`
  or `src/providers/claude-code/mapHookRecord.ts`. If `out/` is missing or
  stale, the standalone fails fast with an actionable error telling you to
  run this command — it does not silently serve wrong data.

## How to run

From `standalone/`:

```sh
npm install      # no-op today; standalone ships zero dependencies
npm test         # optional: run the standalone's own test suite

# Register the Claude Code hook in a project (idempotent — safe to re-run)
node src/cli.mjs install-hook <path-to-project>

# Start the server and open it in your browser
node src/cli.mjs watch <path-to-project>
```

Or, once published, via the `bin` entry:

```sh
npx tycoonagents-standalone install-hook <path-to-project>
npx tycoonagents-standalone watch <path-to-project>
```

`watch` accepts additional directories (`watch <dir1> <dir2> ...`) — see
**Multi-directory watching** below. Pass `--no-open` (or set
`TYCOON_STANDALONE_NO_OPEN=1`) to suppress the automatic browser launch,
e.g. for a headless/CI/SSH environment.

`npm start` (i.e. `node src/server.mjs`) is the plain dev/dogfood entry
point: it starts the server against the repo root itself without the CLI's
argument parsing or browser auto-open.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `TYCOON_STANDALONE_PORT` | HTTP port the server binds to. | `4173` |
| `TYCOON_STANDALONE_HOST` | HTTP host/interface the server binds to. | `127.0.0.1` |
| `TYCOON_STANDALONE_PROJECT_ROOT` | Comma-separated project director(y/ies) to watch, used when no CLI directory argument is given. | current working directory |
| `TYCOON_STANDALONE_DATA_DIR` | Overrides the OS-default app-data directory (`appData.mjs`). | per-OS (see below) |
| `TYCOON_STANDALONE_NO_OPEN` | Set to `1` to suppress the `watch` command's automatic browser launch. | unset (browser opens) |

`TYCOON_STANDALONE_DATA_DIR`'s per-OS default (when unset): `%APPDATA%\TycoonAgents`
on Windows, `~/Library/Application Support/TycoonAgents` on macOS, and
`$XDG_DATA_HOME/tycoonagents` (else `~/.local/share/tycoonagents`) elsewhere.

Precedence for project targets: explicit CLI directory argument(s) > `TYCOON_STANDALONE_PROJECT_ROOT` > current working directory. See `src/projectRoots.mjs`.

## Architecture

```
Claude Code hook  ->  .claude/tycoon/*.json(l)  ->  file watcher (activityWatcher.mjs)
                                                          |
                                                          v
                                        shared pure logic (sharedLogic.mjs, requires
                                        the repo's COMPILED out/src/core/state.js —
                                        the same code the VS Code panel uses)
                                                          |
                                                          v
                                              stateFeed.mjs computes state
                                                          |
                                                          v
                                          server.mjs broadcasts over SSE (/events)
                                                          |
                                                          v
                              browser: acquireVsCodeApi() shim (postMessage -> POST
                              /message, SSE -> window 'message', getState/setState
                              -> localStorage) feeding the UNMODIFIED media/main.js
```

`media/main.js` and `media/style.css` are served **in place** straight from
the repo's `media/` directory — never copied or forked — so the standalone
and the VS Code extension always render identically.

## MVP scope — what this is, and what it explicitly is NOT

Done:
- `install-hook` / `watch` CLI, SSE-driven live state updates, browser
  auto-open, multi-directory watch, per-OS app-data path resolution
  (`appData.mjs`).

Deliberately deferred / not done — do not assume these work:

- **No Electron wrapper.** A native-feeling desktop app (no browser tab,
  own window/tray icon) was scoped for this phase and explicitly skipped:
  it would be the only new dependency this project would add, which
  conflicts with the project's no-new-dependencies rule. The npx/browser
  flow above is the full MVP. This is an optional, un-scheduled future
  addition, not a known bug.
- **`time-adjustments.json` is not applied.** The VS Code panel applies
  saved per-agent `activeMs` corrections from
  `.claude/tycoon/time-adjustments.json` before rendering metrics. The
  standalone's state feed does not read or apply this file yet, so a
  project with saved time adjustments will show slightly different
  (uncorrected) active times here than in the VS Code panel.
- **`appData.mjs` is unwired.** The per-OS app-data directory module exists
  and is unit-tested, but nothing in `server.mjs`/`stateFeed.mjs` calls it
  yet — there is currently no durable host-side state persisted by the
  standalone (equivalent to the VS Code extension's `globalStorage`).
- **Multi-directory watching is primary-only.** When `watch` is given more
  than one directory, only the *first* drives the rendered board (its state
  is broadcast to the browser). Additional directories are watched for real
  (their file watchers run and errors surface) but their computed state is
  only logged, never merged into the board — this is intentional, to avoid
  silently mixing two projects' agent sessions into one misleading table.

## Running the tests

```sh
cd standalone
npm test
```

Runs the standalone's own suite (`node --test "test/**/*.test.mjs"`) —
independent of, and not run by, the root repo's `npm test`.

## Relationship to the VS Code extension

- The standalone is excluded from the packaged `.vsix` (`standalone/**` in
  the repo's `.vscodeignore`) — it never ships to VS Code Marketplace users.
- Running the standalone (`npm start`, `node src/cli.mjs watch ...`) never
  invokes the extension's esbuild bundling or `vsce package` steps.
- Building/packaging the extension (`npm run package` at the repo root)
  never builds, requires, or includes anything under `standalone/`.
- The one deliberate coupling between the two build targets is the shared
  compiled `out/src/core/state.js` / `out/src/providers/claude-code/mapHookRecord.js`
  logic described above — reused in place rather than forked, so both hosts
  can never drift apart in how they interpret hook data.
