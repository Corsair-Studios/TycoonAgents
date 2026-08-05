# Install

## System requirements

- **UEFN** (Unreal Editor for Fortnite) installed, with your project open.
- The **Python Editor Script Plugin** enabled in UEFN (`Edit -> Plugins`, search "Python Editor Script Plugin", enable it, restart UEFN if prompted).
- **Node.js 18+** on the machine running the MCP server.
- An MCP-capable client (e.g. Claude Code) to talk to the server.

## 1. Install the Python bridge into your UEFN project

Copy the **contents** of this repo's `python/` folder into your UEFN project's `Content/Python/` directory.

`Content/Python` lives inside the folder that holds your project's `.uefnproject` file — that's your UEFN project root. If a `Python` folder doesn't already exist under `Content`, create it:

```
<your-uefn-project>/Content/Python/
```

After copying, `<your-uefn-project>/Content/Python/` should contain `init_unreal.py` alongside the rest of the files from this repo's `python/` folder.

- `init_unreal.py` auto-starts the Python bridge when UEFN loads the project — no manual step needed on subsequent launches.
- If UEFN prompts you to enable the Python Editor Script Plugin, accept it and restart UEFN.
- Once loaded, open UEFN's Python console and run `import pt` to open the Power Tools window.

## 2. Run the MCP server

From this repo:

```bash
npm install
npm start
```

`npm start` runs `tsx uefn-server.ts`. Point your MCP client's configuration at that command (or at `npx tsx <path-to-this-repo>/uefn-server.ts`) so it launches the server as an MCP tool provider.

Once it's running, connect it to your AI client of choice — see **Connecting an AI client** below.

## 3. How it connects

The MCP server and the in-UEFN Python bridge communicate through file-based IPC in the OS temp directory — no network port, no additional UEFN plugin. Keep UEFN open with your project loaded whenever you want live queries or edits to reach the editor; if UEFN isn't running (or the bridge hasn't started), the MCP server will report the bridge as unreachable.

## 4. Connecting an AI client

The MCP server (`uefn-server.ts`) speaks plain stdio MCP, so any MCP-capable client can launch it the same way: a `command` plus `args` that run the server, with an optional `env` block for the [environment overrides](#environment-overrides) below. Each client stores that config in its own file, using its own key name — the subsections below give the current (2026-08-05, web-verified) format for each.

The examples show the entry point as `uefn-server.mjs` — that's what you'll have if you're using a pre-built/staged copy of the bridge (for example, the one the TycoonAgents VS Code extension stages automatically, or a `python/`-launcher install that ships one). If you're running **this** repo's TypeScript source directly (`npm start`), swap the command in every example below for:

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

The TycoonAgents VS Code extension writes this file automatically for its own bridge; standalone Power Tools users add it by hand. `env` is optional — omit `UEFN_BRIDGE_DIR` to use the default per-machine temp directory.

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

## Updating

Pull the latest version of this repo and re-copy the contents of `python/` into `<your-uefn-project>/Content/Python/`, then restart UEFN (or reload the bridge module from the Python console) to pick up changes.
