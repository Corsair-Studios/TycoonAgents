# TycoonAgents — Standalone Host

A VS Code-independent way to run the TycoonAgents live agent visualization.
It watches the same Claude Code hook data the VS Code extension watches
(`.claude/tycoon/` in a project directory) and serves the **same, unmodified**
`media/main.js` webview in a browser tab instead of a VS Code panel.

This is an independent build target from the VS Code extension: it does not
ship in the extension's `.vsix` (excluded via the repo's `.vscodeignore`) and
running it never builds, packages, or otherwise touches the extension.

## Using the release zip

If you got here via the release zip (`tycoonagents-standalone-<version>.zip`),
skip the build step below — `out/` ships pre-compiled inside the zip. Instead,
run `npm install --omit=dev` once at the zip's root (the theme pipeline needs
`jimp` and `fflate` at server startup). The rest of this file's `npm run
build` and "npm install is a no-op" instructions apply to repo checkouts
only.

## Prerequisites

- Node.js `>=18` (see `engines.node` in `standalone/package.json`).
- The repo's TypeScript sources compiled once, from the **repo root**:

  ```sh
  npm run build
  ```

  This also copies the hook runtime files.

  Why: the standalone does not fork or reimplement the extension's pure
  state logic (`computeStateFromRecords`, `mapHookRecord`, the provider
  mapper registry, etc. in `src/core/state.ts` / `src/core/mappingRegistry.ts`
  / `src/providers/claude-code/index.ts`). It `require()`s the **compiled**
  output of those files from `out/src/...` at runtime (see
  `src/sharedLogic.mjs`) so both hosts stay byte-for-byte behaviorally
  identical. `out/` is gitignored, so this step is required after every
  fresh clone and after pulling changes to `src/core/state.ts`,
  `src/core/mappingRegistry.ts`, or `src/providers/claude-code/index.ts`. If
  `out/` is missing or stale, the standalone fails fast with an actionable
  error telling you to run this command — it does not silently serve wrong
  data.

## How to run

From `standalone/`:

```sh
npm install      # no-op inside a repo checkout only; standalone ships zero dependencies
npm test         # optional: run the standalone's own test suite

# Register the Claude Code hook in a project (idempotent — safe to re-run)
# Also seeds .claude/agents/*.md and .claude/tycoon/agent-keywords.json when
# missing (never overwrites an existing file) — see "Agent roster seeding" below.
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
argument parsing or browser auto-open. `npm start` runs a `prestart` hook
(`npm --prefix .. run build`, i.e. `tsc -p .` from the repo root) first, so
`out/` is always rebuilt before the server starts — `npm start` needs no separate
"Build `out/` first" step.
`node src/cli.mjs watch` / `npx tycoonagents-standalone watch` are separate
Node entry points that do NOT go through npm's `start` lifecycle, so they
still require the manual `npx tsc -p .` step from Prerequisites; if you skip
it, the descriptive "run `npx tsc -p .`" error below still fires as a safety
net on the first theme-generation call.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `TYCOON_STANDALONE_PORT` | HTTP port the server binds to. | `4173` |
| `TYCOON_STANDALONE_HOST` | HTTP host/interface the server binds to. | `127.0.0.1` |
| `TYCOON_STANDALONE_PROJECT_ROOT` | Comma-separated project director(y/ies) to watch, used when no CLI directory argument is given. | current working directory |
| `TYCOON_STANDALONE_DATA_DIR` | Overrides the OS-default app-data directory (`appData.mjs`). | per-OS (see below) |
| `TYCOON_STANDALONE_NO_OPEN` | Set to `1` to suppress the `watch` command's automatic browser launch. | unset (browser opens) |
| — | Theme image generation takes no provider API keys here — sign in from the Theme Builder panel (see "Sign-in and credits" in the main [`README.md`](../README.md#custom-themes)). | — |

`TYCOON_STANDALONE_DATA_DIR`'s per-OS default (when unset): `%APPDATA%\TycoonAgents`
on Windows, `~/Library/Application Support/TycoonAgents` on macOS, and
`$XDG_DATA_HOME/tycoonagents` (else `~/.local/share/tycoonagents`) elsewhere.
`server.mjs` resolves a `themes/` subdirectory under this app-data dir at
startup (`startServer()`'s returned `themeDataDir`) — the root the theme
file store reads/writes generated theme manifests and images from/to (see
"Running the theme host end to end" below).

Precedence for project targets: explicit CLI directory argument(s) > `TYCOON_STANDALONE_PROJECT_ROOT` > current working directory. See `src/projectRoots.mjs`.

## Provider selection

`watch` reads agent activity from Claude Code by default. Pass `--provider <id>` (`claude-code` or `codex`) or set `TYCOON_PROVIDER` (always wins over the flag) to switch:

```sh
node src/cli.mjs watch . --provider codex
```

Passing `--provider` disables the panel's "Which tool runs your agents?" harness dropdown — the flag (or `TYCOON_PROVIDER`, which always wins over it) is the source of truth for a standalone run.

### Routing walkthrough

The standalone panel's Routing view is the same one described in the main [`README.md`](../README.md#routing-walkthrough): pick the harness in Settings (skipped when `--provider` is passed), open Routing, fill in the orchestrator slot, assign per-agent models from presets or a **Custom endpoint…** vendor for a local/VM OpenAI-compatible server (Provider name, Model id as served, Cost class `local`, then **Set value…** on the Endpoint URL env / API key env fields to store the URL and key per-user, outside the project), add a fallback chain via **"+ Add fallback"**, then **Save**. `install-hook` must have already seeded `.claude/agents/*.md` (see "Agent roster seeding" below) before Routing can resolve any agent slot. **Clear profile** reverts the managed files but keeps stored endpoint/key values. See [`docs/ROUTING-PROFILE.md`](../docs/ROUTING-PROFILE.md) for the schema.

## Agent roster seeding

`.claude/agents/*.md` is not committed to the repo (`.claude/` is
gitignored), so a fresh clone has no roster. `install-hook` seeds it by
default, writing `.claude/agents/*.md` and
`.claude/tycoon/agent-keywords.json` whenever they're missing; it never
overwrites a file that already exists. Pass `--no-agents` to skip seeding
(e.g. when you manage the roster yourself), or run the seeding step alone
without touching the hook or plugin:

```sh
node src/cli.mjs seed-agents <path-to-project>
```

`docs/ROUTING-PROFILE.md` depends on this
roster existing before their routing scripts can resolve agent backends.

This seeds only the core worker roster (`search-retrieval`,
`primary-agent`, `coding-specialist`, `ux-ui-designer`) plus a reviewer,
matching a fresh VS Code install. Foreign-LLM reviewers (`codex-reviewer`,
`gemini-reviewer`, `kimi-reviewer`) come from the multi-llm pack, installed
from the panel's Packs view.

## OpenCode

OpenCode support is coming soon. It is not selectable in the standalone app yet.

### Theme image generation — sign-in

Theme image generation takes no provider API key from the
environment or the OS keychain: sign in from the Theme Builder panel (email
magic link or Google) and generate against the Corsair Theme Service using
credits — see "Sign-in and credits" in the main
[`README.md`](../README.md#custom-themes).

## Running the theme host end to end

The Theme Builder (plan a theme, generate its art with an image provider,
review/edit, and export/import) is served from the SAME browser tab as the
live agent visualization — it is not a separate process or port.

1. **Build `out/` first** (see Prerequisites above — the theme-generation
   pipeline is required, not just optional, for this flow):

   ```sh
   npx tsc -p .
   ```

   Without this step the server starts fine, but any theme PLAN/GENERATE
   request fails fast with an actionable "run `npx tsc -p .`" error (see
   `standalone/src/themeGenerationBridge.mjs` / `themeArchive.mjs`).

2. **Start the server**, then sign in from the Theme Builder panel (email
   magic link or Google) — see "Sign-in and credits" in the main
   [`README.md`](../README.md#custom-themes):

   ```sh
   node src/cli.mjs watch <path-to-project>
   ```

3. **Open the browser tab** the CLI auto-launches (or the printed URL if you
   passed `--no-open`), click the **Themes** menu button, then the
   **Theme Builder** tab. From there:
   - **Plan** a theme from a text prompt.
   - **Generate** the plan's art (each board is generated against the
     configured provider — mocked in tests, real network calls here).
   - **Review/Edit** — rename items, edit per-item descriptions, edit the
     whole-theme creative direction, and approve individual boards or
     **Approve All**.
   - **Export** downloads the approved theme as a `.zip` straight to your
     browser's downloads (a `GET /theme-export/<theme_id>` request under the
     hood — see Architecture below); export requires every board to be
     approved first, same as the VS Code extension.
   - **Import .zip** re-uploads a previously exported (or hand-authored)
     theme archive via a file picker, POSTed as raw bytes to
     `POST /theme-import`.

This is the same webview code path as the VS Code extension — `media/main.js`
is served unmodified — so the Theme Builder UI behaves identically in both
hosts; only the API-key source (env vars here vs. VS Code `SecretStorage`)
and the export/import transport (browser download/upload here vs. a native
save/open dialog) differ, both by necessity of running outside VS Code.

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
  (`appData.mjs`, now wired into `server.mjs` at startup — resolves the app
  data dir and a `themeDataDir` under it), and env-var-sourced theme image
  provider/API-key config (`getThemeImageConfig()`).
- **Full theme host** (Phases A-D): a filesystem-backed `ThemeFileStore`
  rooted at `themeDataDir`; the same plan/generate/retry/reslice/normalize
  pipeline the VS Code extension uses, driven via a `createRequire` bridge
  into the compiled `out/src/extension/themeService.js` (no
  reimplementation, no `vscode` import); the review-editor messages (rename,
  per-item description, whole-theme creative direction, approve/approve-all);
  and export/import (`GET /theme-export/<id>`, `POST /theme-import`) — see
  "Running the theme host end to end" above. All served through the
  unmodified `media/main.js` Theme Builder tab.

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
  compiled `out/src/core/state.js` / `out/src/core/mappingRegistry.js` /
  `out/src/providers/claude-code/index.js` logic described above — reused in
  place rather than forked, so both hosts can never drift apart in how they
  interpret hook data.

## Feature parity

Every feature is identical after setup except the rows marked "not yet";
the standalone Codex (Experimental) host differs from the Claude Code
host only in provider/vendor/model labels.

| Feature | VS Code (Claude Code) | Standalone (Claude Code) |
| --- | --- | --- |
| Board/agent metrics | verified 2026-09-03 | verified 2026-09-03 |
| Theater/stage | verified 2026-09-03 | verified 2026-09-03 |
| Themes list + select | verified 2026-09-03 | verified 2026-09-03 |
| Theme Generator | verified 2026-09-03 | verified server-side; visual check pending |
| Theme Review | verified 2026-09-03 | verified server-side; visual check pending |
| Settings dialog | verified 2026-09-03 | verified 2026-09-03 |
| Skills dialog | verified 2026-09-03 | verified 2026-09-03 |
| MCP dialog | verified 2026-09-03 | verified 2026-09-03 |
| Packs | verified 2026-09-03 | not yet (install via VS Code) |
| Project plan panel | verified 2026-09-03 | not yet |
| Delegation panel | verified 2026-09-03 | not yet |
| Feedback | verified 2026-09-03 | verified 2026-09-03 (diagnostics attachment not yet) |
| Handbook | verified 2026-09-03 | verified 2026-09-03 |
| Diagnostics report | verified 2026-09-03 | not yet |

Theme Generator/Review note: `standalone/src/themeMessages.mjs` handles the
messages server-side; rendering fixes landed 2026-09-03 (commit
"fix(theme-stage)"). Open follow-up: emote-marker rendering still needs a
visual check in both standalone hosts.
