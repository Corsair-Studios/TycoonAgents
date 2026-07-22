---
name: uefn-bridge
description: >
  UEFN MCP live-editor bridge — install/setup, tools (uefn_status, uefn_list_devices,
  uefn_get_property, uefn_set_property, uefn_select_actor, uefn_run_audit,
  uefn_get_level_info), prerequisites, architecture, and usage examples. Use when
  inspecting or manipulating a UEFN level via Claude Code agents, or when asked to
  set up uefn, install uefn bridge, or configure the UEFN pipeline.
---

# UEFN MCP Server (Live Editor Bridge)

This project includes a Python bridge that connects Claude Code agents to the live UEFN editor session. When UEFN is running with the project open, agents can query and manipulate the level in real-time.

## Installation (run this if the bridge is not set up)

If the UEFN chip in the TycoonAgents panel is gray, or if `uefn_status` fails, follow these steps to self-install the bridge.

### Step 1 — Check if already installed

Check two conditions:

1. Does `.mcp.json` (workspace root) contain an `mcpServers.uefn` entry?
2. Does `Content/Python/uefn_bridge.py` exist in the project?

If both are present, check for a legacy misconfiguration: if the `mcpServers.uefn` entry contains an `env.UEFN_BRIDGE_DIR` key, remove that `env` block entirely (it directed the MCP server to a directory the Python bridge never writes, breaking IPC). Save the file and restart the Claude Code session. Then skip to **After install** below.

If both are present and no `env.UEFN_BRIDGE_DIR` key exists, skip to **After install** below.

### Step 2 — Locate the TycoonAgents extension

Glob for the installed extension folder. Check in order:

- `~/.vscode/extensions/*tycoonagents*/`
- `~/.vscode-insiders/extensions/*tycoonagents*/`
- `~/.cursor/extensions/*tycoonagents*/`

Pick the folder with the highest version number if multiple are found. Verify it contains both:
- `media/uefn-bridge/` directory
- `out/mcp/uefn-server.js`

If neither location has the extension, tell the user to install TycoonAgents from the VS Code Marketplace first.

### Step 3 — Find the UEFN project's Python directory

Use this precedence (mirrors the installer logic):

1. If `<workspace>/Python/` exists — use it (workspace root is already a plugin content dir).
2. Else if `<workspace>/Plugins/<any>/Content/` exists and contains `.verse` files — use `<workspace>/Plugins/<plugin>/Content/Python/`.
3. Else if `<workspace>/Content/` exists — use `<workspace>/Content/Python/`.
4. Otherwise create `<workspace>/Content/Python/`.

### Step 4 — Copy the bridge files

Copy **every** Python file from `<extensionFolder>/media/uefn-bridge/` into the Python directory determined above, plus the icon `trashbyrd_40x40.png`. Do **not** copy `uefn-server.mjs` — that is the bundled MCP server (launched by Node via `.mcp.json`), not a UEFN Python tool.

This mirrors the extension's own installer, which stages the whole `media/uefn-bridge/` directory (minus the server bundle) into `Content/Python`, so the manual copy stays correct as tools are added or removed rather than drifting from a hardcoded list.

Only overwrite a file if its content differs from the source (preserves user edits).

### Step 5 — Merge the `uefn` entry into `.mcp.json`

If `.mcp.json` already exists, merge — do not overwrite other server entries. The exact JSON shape:

```json
{
  "mcpServers": {
    "uefn": {
      "command": "node",
      "args": ["<absolutePath>/out/mcp/uefn-server.js"]
    }
  }
}
```

Use an absolute path for `args`. On Windows use forward slashes. Do **not** add an `env` block — the MCP server and Python bridge both default to `<OS temp dir>/uefn_bridge` automatically.

### After install

**IMPORTANT — always tell the user this in chat after installing:**

> **Restart the Claude Code session** to load the new MCP server.
>
> UEFN only runs the Python tools at project load. Since your level is probably already open, **close and reopen the project in UEFN** (or restart UEFN); the bridge auto-starts and UEFN asks whether to launch **Trashbyrd's Power Tools**. Make sure the **Python Editor Script Plugin** is enabled. Then run `uefn_status` here to verify.
>
> **Quick launch:** in UEFN's Python console, type `import pt` to open Trashbyrd's Power Tools.

---

## Prerequisites

- UEFN must be running with the connected project open
- The bridge auto-starts via `init_unreal.py` on project load
- Verify connectivity by calling `uefn_status` first

## How It Works

- `Content/Python/init_unreal.py` auto-starts the bridge when UEFN opens the project
- `Content/Python/uefn_bridge.py` runs a tick-pumped IPC listener inside UEFN
- Claude Code's MCP server (`uefn`) communicates via file-based IPC in the OS temp directory (`uefn_bridge/`)

## Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `uefn_status` | Check if bridge is connected, get level info | none |
| `uefn_list_devices` | List all Fortnite Creative devices with properties | none |
| `uefn_get_property` | Read a specific property from a device/actor | `actor_label`, `property_name` |
| `uefn_set_property` | Set a property on a device/actor | `actor_label`, `property_name`, `value` |
| `uefn_select_actor` | Select a device/actor in the UEFN viewport | `actor_label` |
| `uefn_run_audit` | Run full device audit, return JSON results | none |
| `uefn_get_level_info` | Get level metadata (actor counts, device types) | none |

## Usage Examples

Agents can use these tools to:
- **Inspect levels**: "What devices are in the level?" → `uefn_list_devices`
- **Check editable values**: "What properties are overridden on the Game Manager?" → `uefn_get_property`
- **Modify devices**: "Set the Elimination Manager score to 50" → `uefn_set_property`
- **Navigate**: "Select the Storm Controller in the viewport" → `uefn_select_actor`
- **Audit**: "Run a full audit and report optimization opportunities" → `uefn_run_audit`

## Architecture

```
UEFN Python (uefn_bridge.py)  ←→  File IPC  ←→  MCP Server (uefn-server.ts)  ←→  Claude Code Agents
```

- **UEFN side**: `uefn_bridge.py` runs on a tick callback, polls `command.json`, writes `response_{id}.json`
- **MCP side**: `src/mcp/uefn-server.ts` writes commands, reads responses, exposes tools via stdio
- **IPC directory**: OS temp directory (`uefn_bridge/`) — the Python bridge always uses `tempfile.gettempdir()/uefn_bridge`
- **Heartbeat**: Bridge writes `heartbeat.json` every 5s so MCP server can detect connectivity

## Important Notes

- Always call `uefn_status` before other tools to verify the bridge is connected
- `actor_label` parameters match the display label shown in UEFN's Outliner panel
- `uefn_set_property` auto-coerces string values to the correct type (bool/int/float)
- The bridge only works when UEFN is open and the connected project is loaded
