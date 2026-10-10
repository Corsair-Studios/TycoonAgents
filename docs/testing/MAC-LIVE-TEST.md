# macOS Live Test Checklist

A fresh-install checklist for running TycoonAgents on a clean Mac (for example a rented cloud Mac over remote desktop) with no prior `~/.claude`, `~/.codex`, or API keys. Work top to bottom. Record Pass/Fail and notes in each step's result line.

Tester: ______  Mac model / macOS version: ______  Chip (arm64 / x86_64): ______  Date: ______

## 0. Prerequisites

1. Install Node.js 20 or newer (Homebrew `brew install node`, or the nodejs.org installer). In Terminal run `node -v` and `which node`. Expected: version 20+, a path such as `/opt/homebrew/bin/node` or `/usr/local/bin/node`. Result: [ ] Pass [ ] Fail  Notes: ______
2. Install VS Code. Open it, then run "Shell Command: Install 'code' command in PATH" from the Command Palette. In Terminal run `code --version`. Expected: a version prints. Result: [ ] Pass [ ] Fail
3. Install the Claude Code CLI (`npm install -g @anthropic-ai/claude-code` or the native installer). Run `which claude` and `claude --version`, then run `claude` once and complete login. Expected: version prints, login succeeds, the prompt opens. Result: [ ] Pass [ ] Fail
4. Install the OpenAI Codex extension in VS Code (and/or the Codex CLI). Sign in with ChatGPT. Run `which codex` and `codex --version` if the CLI is installed; otherwise note that the binary is only inside `~/.vscode/extensions/openai.chatgpt-*`. Expected: signed in; a version prints or the extension bundle exists. Result: [ ] Pass [ ] Fail  Where is the codex binary: ______
5. Install the local TycoonAgents VSIX: `code --install-extension <path-to>/tycoonagents-<version>.vsix`, then reload VS Code. Expected: the TycoonAgents panel is available. Result: [ ] Pass [ ] Fail
6. Open an empty test folder in VS Code (`mkdir ~/tycoon-test && code ~/tycoon-test`). Confirm it has no `.claude` or `.codex` directory. Result: [ ] Pass [ ] Fail

## A. Claude-only harness

1. Open the TycoonAgents panel. Expected: first-run setup appears. Result: [ ] Pass [ ] Fail
2. Choose the Claude harness and complete setup. Expected: agent files appear under `.claude/agents/` and the project CLAUDE.md gets the managed delegation block. Check with `ls .claude/agents`. Result: [ ] Pass [ ] Fail
3. Run the hooks install from the panel. Expected: `.claude/settings.json` (or the settings location the panel reports) lists the tycoon hook commands, each pointing at an absolute `node` path and an existing script. Verify each path exists with `ls`. Result: [ ] Pass [ ] Fail
4. Open the panel Hook Health view. Expected: all hooks report healthy, none report "node not found". Result: [ ] Pass [ ] Fail
5. In the Claude Code panel or terminal, run `claude` in the folder and ask: "Use the coding specialist to create hello.txt containing the word hello." Expected: the orchestrator delegates through the Task tool. Result: [ ] Pass [ ] Fail
6. Watch the stage. Expected: the coding specialist appears and animates while working, then returns to idle. Result: [ ] Pass [ ] Fail
7. Open metrics. Expected: a row for the specialist with token counts, and the correct model label. Result: [ ] Pass [ ] Fail
8. Confirm `hello.txt` exists with the expected content. Result: [ ] Pass [ ] Fail

## B. Codex harness

1. In the panel, switch the harness to Codex. Expected: no errors; the Experimental label is shown. Result: [ ] Pass [ ] Fail
2. Run the Codex hooks install. Expected: `~/.codex/config.toml` contains a tycoon section with a hook command whose first element is an absolute node path (not the VS Code binary) and whose second is an existing script path. Run `grep -n -i tycoon ~/.codex/config.toml` and verify with `ls`. Result: [ ] Pass [ ] Fail
3. Run the dispatcher install. Expected: an `mcp_servers` tycoon dispatcher entry appears in `config.toml` with node path, script path, and its env var list. `AGENTS.md` in the project contains the managed block. Result: [ ] Pass [ ] Fail
4. Open Hook Health. Expected: Codex hooks and dispatcher healthy. Result: [ ] Pass [ ] Fail
5. Start a Codex session in the folder (extension chat or `codex`) and ask for a delegated task: "Delegate to the coding specialist: create notes.txt containing the word notes." Expected: the dispatcher tool is called and the stage shows the worker. Result: [ ] Pass [ ] Fail
6. Confirm the worker edited the file on disk (`cat notes.txt`). This exercises the macOS sandbox for a builder worker. Expected: file exists inside the project folder. Result: [ ] Pass [ ] Fail
7. Check metrics for the worker row. Result: [ ] Pass [ ] Fail
8. Uninstall the Codex integration from the panel. Expected: `grep -n -i tycoon ~/.codex/config.toml` returns nothing, no orphan hook script copies remain, the `AGENTS.md` managed block is gone, and the rest of `config.toml` is unchanged and still valid TOML. Result: [ ] Pass [ ] Fail

## C. Cross-vendor checks

1. Claude harness plus Codex reviewer: reinstall Claude hooks, enable the codex-reviewer specialist in the panel, and ask the orchestrator for a second-opinion review of `hello.txt`. Expected: the review is delegated to codex-reviewer and a reply returns; the stage and metrics show the foreign worker. Result: [ ] Pass [ ] Fail
2. Codex harness plus Claude worker: reinstall Codex integration, enable claude-worker, and ask Codex to delegate a small task to it. Expected: the dispatcher launches the `claude` CLI and the answer returns. Result: [ ] Pass [ ] Fail

## D. macOS risk probes

The code finds binaries at runtime in this order. Node (written into config at install time): `TYCOON_NODE_PATH` override, then the running binary if it is genuinely node, then a PATH scan, then the bare name `node` (`src/providers/codex/resolveNodeBinary.ts`). Codex (`hooks/codex-mcp-launcher.cjs`, `src/providers/codex/codexDiscovery.ts`): an override, PATH, npm global prefix, Homebrew `/opt/homebrew/bin` and `/usr/local/bin`, then the binary bundled in `~/.vscode/extensions/openai.chatgpt-*/bin/darwin-arm64` (or `darwin-x86_64`). Claude (`hooks/claude-cli-mcp.cjs`, `hooks/dispatcherAdapters.cjs`): `CLAUDE_CLI_BIN` override, PATH, `~/.local/bin/claude`, `/usr/local/bin/claude`.

1. Dock vs terminal PATH. Quit VS Code fully (Cmd+Q). Launch from the Dock or Spotlight, open the test folder, and run Hook Health plus the install steps from A.3 and B.2. Record the node path written. Then quit, run `code ~/tycoon-test` from Terminal, and repeat. Expected: both launches write a working absolute node path; Dock launches get a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so a Homebrew node may be missed and `node` written bare. Compare the two and note any difference. Result: [ ] Pass [ ] Fail  Dock node path: ______  Terminal node path: ______
2. Bare `node` at hook time. If the written command is the bare name `node`, trigger a Claude session and a Codex turn from the Dock-launched VS Code and check Hook Health. Expected: hooks still run; if they report "node not found", note it and retry after setting `TYCOON_NODE_PATH=/opt/homebrew/bin/node` and reinstalling. Result: [ ] Pass [ ] Fail
3. Homebrew locations. Install node and the Codex CLI via Homebrew where possible, then confirm `ls /opt/homebrew/bin/node /opt/homebrew/bin/codex` (Apple Silicon) or `/usr/local/bin` (Intel). Rerun the dispatcher from a Dock-launched VS Code. Expected: codex is found through the Homebrew locations. Result: [ ] Pass [ ] Fail
4. Claude binary location. Run `which claude`. If it is under `/opt/homebrew/bin` or an npm prefix other than `/usr/local/bin`, launch from the Dock and run a claude-worker task from the Codex harness. Expected: found via PATH or set `CLAUDE_CLI_BIN` and note that discovery failed without it. Result: [ ] Pass [ ] Fail  Path of claude: ______
5. Codex macOS sandbox. In the Codex harness, delegate three worker tasks: (a) write a file inside the project, (b) run `npm -v` or `node -v` from the worker, (c) write a file outside the project (for example `~/outside.txt`). Expected: (a) and (b) succeed; (c) is blocked by the seatbelt sandbox with a clear error rather than a hang. Note any "sandbox unavailable" message. Result: [ ] Pass [ ] Fail  Notes: ______
6. Hook command assumptions. Open `~/.codex/config.toml` and `.claude/settings.json` and read the hook commands. Expected: no `.cmd`, `.bat`, `powershell`, `cmd.exe`, backslash paths, or `%VAR%` references. Result: [ ] Pass [ ] Fail
7. Path case sensitivity. Check the volume type with `diskutil info / | grep -i "file system"` (default is case-insensitive APFS). In the test folder, create `Notes.txt` and ask a worker to read `notes.txt`; also open the folder once with different casing than on disk (`code ~/Tycoon-Test`). Expected: no duplicate agents, plan, or settings entries and no failed path comparison. Result: [ ] Pass [ ] Fail
8. Standalone data location. If the standalone server is used, confirm its data lives under `~/Library/Application Support/TycoonAgents`. Result: [ ] Pass [ ] Fail [ ] Not tested
9. Gatekeeper and permissions. Note any macOS prompts (Gatekeeper, Files and Folders, Accessibility, network) triggered by the extension or the Codex binary, and whether a worker stalled waiting on one. Notes: ______

## What to send back

1. Screenshots: the panel stage during delegation (A.6, B.5), the metrics view, and Hook Health from a Dock launch and a terminal launch.
2. The tycoon sections of `~/.codex/config.toml` before uninstall and the output of `grep -n -i tycoon ~/.codex/config.toml` after uninstall.
3. The hook entries from `.claude/settings.json`.
4. The output of `uname -m`, `sw_vers`, `node -v`, `which node claude codex`.
5. The exact text of any error shown in the panel, the VS Code Output channel for TycoonAgents, or a worker result, plus which step it occurred on.
6. This completed checklist with Pass/Fail marked.
