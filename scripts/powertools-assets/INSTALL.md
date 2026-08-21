# Install

## System requirements

- **UEFN** (Unreal Editor for Fortnite) installed, with your project open.
- The **Python Editor Script Plugin** enabled in UEFN (`Edit -> Plugins`, search "Python Editor Script Plugin", enable it, restart UEFN if prompted).
- **Node.js 18+** on the machine running the MCP server.
- An MCP-capable client (e.g. Claude Code) to talk to the server.

Before you enable Python, read **Use at your own risk** in [README.md](README.md#use-at-your-own-risk) — Python is known to crash UEFN, including during project sync.

## 1. Install the Python bridge into your UEFN project

Copy the **contents** of this repo's `python/` folder into your UEFN project's `Content/Python/` directory.

`Content/Python` lives inside the folder that holds your project's `.uefnproject` file — that's your UEFN project root. If a `Python` folder doesn't already exist under `Content`, create it:

```
<your-uefn-project>/Content/Python/
```

After copying, `<your-uefn-project>/Content/Python/` should contain `init_unreal.py` alongside the rest of the files from this repo's `python/` folder.

- Start the Python bridge by opening UEFN's Python console once your project is open and running `import init_unreal` — see **Starting the bridge** below.
- If UEFN prompts you to enable the Python Editor Script Plugin, accept it and restart UEFN.
- Once the bridge is started, run `import pt` in the same console to open the Power Tools window.

### Starting the bridge

Open UEFN's Python console (Output Log panel → console dropdown → **Python**) and run:

```python
import init_unreal
```

That starts the bridge, launcher, and Tools-menu entries in one call. Follow it with `import pt` to open the Power Tools window.

**Symptom if you skip this step:** no Power Tools launcher window, no Tools-menu entries, and the MCP server reports the bridge unreachable.

Run `import init_unreal` once per UEFN session — after each restart of UEFN, repeat the step.

### A tool seems to be running an old version

UEFN can load Python from two places: your project's `Content/Python/` (where you just copied files) and an engine-side copy inside your Fortnite installation, at `FortniteGame/Content/Python/` under wherever your Epic Games Launcher installed Fortnite. That parent location varies by machine and by Launcher settings, so no single real path is given here.

`init_unreal.py` syncs the newest project copy over the engine copy automatically when the bridge starts, comparing the `BRIDGE_VERSION` stamp in `bridge_version.py`. If that stamp already matches on both sides, the sync can skip copying even when the file contents underneath differ — so the engine copy can end up running stale code behind a version number that looks current.

**Symptom:** a bug you know was fixed is still happening, or a feature you just added isn't there, even though the project copy on disk is correct.

**Check which version is loaded:** the Power Tools launcher window footer (`import pt`) shows the bridge version currently running.

**Manual fix:** copy this repo's `python/` files into the engine-side `FortniteGame/Content/Python/` directory as well as the project copy, delete any `__pycache__` folder in both locations, and restart UEFN.

## 2. Run the MCP server

If you downloaded a release, you already have everything you need: the zip includes `uefn-server.mjs` at its root, a self-contained bundle with no dependencies to install. Run it directly:

```bash
node uefn-server.mjs
```

Point your MCP client's configuration at that same `node uefn-server.mjs` command — see **Connecting an AI client** below.

**If you cloned the source repo instead** (to fork or modify Power Tools), run the TypeScript source directly instead of the bundled `.mjs`:

```bash
npm install
npm start
```

`npm start` runs `tsx uefn-server.ts`. Point your MCP client's configuration at that command (or at `npx tsx <path-to-your-clone>/uefn-server.ts`) instead of the `node uefn-server.mjs` form.

## 3. How it connects

The MCP server and the in-UEFN Python bridge communicate through file-based IPC in the OS temp directory — no network port, no additional UEFN plugin. Keep UEFN open with your project loaded whenever you want live queries or edits to reach the editor; if UEFN isn't running (or the bridge hasn't started), the MCP server will report the bridge as unreachable.

## 4. Connecting an AI client

The MCP server (`uefn-server.mjs`) speaks plain stdio MCP, so any MCP-capable client can launch it the same way: a `command` plus `args` that run the server, with an optional `env` block for the [environment overrides](#environment-overrides) below. Each client stores that config in its own file, using its own key name — the subsections below give the current (2026-08-05, web-verified) format for each.

The examples below show the entry point as `uefn-server.mjs` — that's what you have if you downloaded a release, which is the normal case. **If you cloned the source repo instead** and are running the TypeScript source directly (`npm start`), swap the command in every example below for:

```json
"command": "npx",
"args": ["tsx", "C:\\path\\to\\trashbyrds-power-tools\\uefn-server.ts"]
```

If you're using the in-UEFN launcher window (`import pt` → MCP Bridge info), its **Copy config for selected client** button fills in the real, discovered path and command for your install automatically — you don't need to hand-edit the placeholder paths below.

### Claude Code

File: `.mcp.json` at your project root, key `mcpServers`.

```json
{
  "mcpServers": {
    "uefn": {
      "command": "node",
      "args": ["C:\\path\\to\\trashbyrds-power-tools\\uefn-server.mjs"],
      "env": {
        "UEFN_BRIDGE_DIR": "C:\\path\\to\\bridge-dir"
      }
    }
  }
}
```

You add this file by hand. `env` is optional — omit `UEFN_BRIDGE_DIR` to use the default per-machine temp directory.

### Gemini CLI

File: `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project-local), key `mcpServers`. Same entry shape as Claude Code above. `env` values support `$VAR_NAME` expansion, so you can point them at variables already set in your shell.

### Codex CLI

File: `~/.codex/config.toml`, table `[mcp_servers.uefn]`.

```toml
[mcp_servers.uefn]
command = "node"
args = ["C:\\path\\to\\trashbyrds-power-tools\\uefn-server.mjs"]

[mcp_servers.uefn.env]
UEFN_BRIDGE_DIR = "C:\\path\\to\\bridge-dir"
```

Codex CLI documents environment variables for a stdio MCP server via a `[mcp_servers.<name>.env]` sub-table, as shown above. Omit the `[mcp_servers.uefn.env]` sub-table entirely if you don't need a non-default `UEFN_BRIDGE_DIR` (it defaults to a per-machine temp directory).

**Sandbox gotcha:** Codex CLI's default `sandbox_mode = "read-only"` auto-denies every MCP tool call in `codex exec` — instantly, regardless of any `tool_timeout_sec` setting, with a `"user cancelled MCP tool call"` message that reads like a person rejected it rather than the sandbox blocking it. The server itself is unaffected (a run with the sandbox opened, or an interactive session where you can approve the call, completed a live round trip against a real project). Use an interactive Codex session where you can approve the tool call, or run with the sandbox opened, so your first `uefn_*` call doesn't fail on a misleading message.

### Cursor

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), key `mcpServers`. Same entry shape as Claude Code above, `env` object included normally.

### Windsurf

File: `%USERPROFILE%\.codeium\windsurf\mcp_config.json` on Windows (`~/.codeium/windsurf/mcp_config.json` on macOS/Linux), key `mcpServers`. Same entry shape as Claude Code above. Windsurf supports `${env:VAR_NAME}` interpolation inside values. On Windows, a leading `~` in a path is **not** auto-expanded by Windsurf — use `%USERPROFILE%` or a full path instead.

### Antigravity IDE

File: global `~/.gemini/config/mcp_config.json` or workspace `.agents/mcp_config.json`, key `mcpServers`. Same entry shape as Claude Code above. In the UI: agent side panel menu → **MCP Servers** → **Manage MCP Servers** → **View raw config**.

### VS Code Copilot (agent mode)

File: `.vscode/mcp.json` in your workspace. Uses `servers` (**not** `mcpServers`), and each entry needs `"type": "stdio"`:

```json
{
  "servers": {
    "uefn": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\trashbyrds-power-tools\\uefn-server.mjs"],
      "env": {
        "UEFN_BRIDGE_DIR": "C:\\path\\to\\bridge-dir"
      }
    }
  }
}
```

Requires GitHub Copilot's agent mode to be enabled in VS Code.

### Environment overrides

These are the client-neutral way to point the bridge and its tools at a non-default location — set them in the shell/process that launches the MCP server (or, where a client's `env` block is supported, there):

| Variable | What it points to |
| --- | --- |
| `UEFN_BRIDGE_DIR` | The bridge IPC directory the MCP server and the in-UEFN Python bridge use to hand off work. Defaults to a per-machine temp directory if unset. |
| `UEFN_VERSE_PROJECT_DIR` | UEFN's `VerseProject` data root — where digests and `.vproject` files live. |
| `VERSE_LSP_PATH` | The Verse language server binary, used by tools that run compiler diagnostics. |
| `VERSE_LSP_CHECK_SCRIPT` | Where `verse_lsp_check.py` itself lives (see below) — a different thing from `VERSE_LSP_PATH`, which is the analyzer binary the script locates internally. |

### The `uefn_verse_check` tool needs `verse_lsp_check.py`

`uefn_verse_check` doesn't talk to the in-UEFN Python bridge like the other tools — it runs `verse_lsp_check.py` directly as a local subprocess, which drives Epic's bundled Verse language server headless. That means it needs the script to be present on disk, separately from everything else this repo installs.

This repo ships that script at `skills/uefn/verse_lsp_check.py`. Point the server at it with the `VERSE_LSP_CHECK_SCRIPT` environment variable:

```json
"env": {
  "VERSE_LSP_CHECK_SCRIPT": "C:\\path\\to\\trashbyrds-power-tools\\skills\\uefn\\verse_lsp_check.py"
}
```

Add that to whichever client config you're already using from **Connecting an AI client** above (alongside `UEFN_BRIDGE_DIR` if you're setting that too). Without it, `uefn_verse_check` fails with an honest error listing every location it tried — set the variable to the path above and it resolves.

## 5. Epic's official UEFN MCP server

Epic ships its own official UEFN MCP server. Enable it in UEFN via **Project Settings → Python Editor Scripting** and **Project Settings → UEFN MCP Toolsets**; once enabled it binds `http://127.0.0.1:8000/mcp` by default. You can install and run both Epic's server and Power Tools at the same time — that's the intended configuration, not a conflict. See Epic's own documentation for what its server covers: https://dev.epicgames.com/documentation/fortnite/uefn-mcp

Power Tools (this server) focuses on bulk queries over a project's actors, plus moderation, dependency, texture, material, and Niagara-usage scanning.

## Updating

Download the latest release and re-copy the contents of `python/` into `<your-uefn-project>/Content/Python/`, then restart UEFN (or reload the bridge module from the Python console) to pick up changes. If you cloned the source repo, `git pull` instead. If a tool still behaves like the old version afterward, see [A tool seems to be running an old version](#a-tool-seems-to-be-running-an-old-version) — the engine-side copy may need updating too.
