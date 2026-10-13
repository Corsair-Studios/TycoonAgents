# TycoonAgents ↔ UEFN Power Tools coexistence

> **The one-sentence rule:** Trashbyrd's UEFN Power Tools (`github.com/Corsair-Studios/trashbyrds-uefn-power-tools`) is a separately installed third-party MCP server — TycoonAgents never downloads, installs, stages, deletes, or rewrites it or its files.

## What TycoonAgents' UEFN pack contains

TycoonAgents ships a UEFN *pack* that is entirely independent of Power Tools:

- `media/skills/uefn` — Verse syntax/authoring skill, plus `verse_lsp_check.py` and `verse_project_check.py`, which read `VERSE_LSP_PATH` and `UEFN_VERSE_PROJECT_DIR`.
- `media/skills/uefn-bridge` — a reference skill documenting the Power Tools tool catalog (`uefn_status`, `uefn_list_devices`, `uefn_get_property`, `uefn_set_property`, `uefn_select_actor`, `uefn_run_audit`, `uefn_get_level_info`). It is documentation only; it does not install or run anything.
- Agents `uefn-auditor` and `verse-expert`, which use the skill above and (for `verse-expert`) call the Power Tools MCP tools once the user has wired them up.
- A `thirdParty` entry with id `uefn-bridge` in `media/mcp/catalog.json` (`providedBy: "power-tools"`), carrying a `<POWER_TOOLS_DIR>` placeholder that is never installed as-is.

The server key is `powertools`, as in Power Tools' own `INSTALL.md`. TycoonAgents also recognises `uefn-bridge` (the catalog id, and the key older setups used) everywhere it checks status, and Claude names the tools `mcp__<key>__<tool>` for whichever key is registered, so the skills and agents refer to the bare `uefn_*` tool names.

## What TycoonAgents will never do

- Download, install, stage, or update Power Tools or any of its files.
- Delete, "heal", or rewrite Power Tools files (the old `powerToolsInstall.ts`, `legacyBridgeCleanup.ts`, and `mcpHeal.ts` modules that did this have been removed).
- Write to or rewrite the user's `.mcp.json`, or register the `<POWER_TOOLS_DIR>` placeholder entry. The user installs Power Tools, then clicks Enable MCP, which shows the exact command and, on confirm, registers it at Claude local scope (see below).
- Write to UEFN's `Content/` tree or invoke Python inside a UEFN/Fortnite install.

## How a user wires up the MCP

1. Install Power Tools yourself, following its own `INSTALL.md` at `github.com/Corsair-Studios/trashbyrds-uefn-power-tools`.
2. In the TycoonAgents MCP tab (or the UEFN pack row in Packs), click **Enable MCP** on UEFN Bridge. TycoonAgents looks for the server entry in this order:
   - A `powertools` or `uefn-bridge` entry (only one whose args launch a `uefn-server.mjs` counts; any other server using those names is ignored and never removed) in the project's `.mcp.json`: that entry is sanitized (stdio `command`, `args`, `env` only), shown in a modal with its exact JSON, and on confirm registered at Claude local scope under its original key.
   - Otherwise a Power Tools folder, found by the `tycoonagents.powerTools.dir` setting, then the `TYCOON_POWER_TOOLS_DIR` environment variable, then a content-based search of the folders next to your workspace (siblings of the workspace folder and of its parent) and then your home folder. A folder qualifies only if it holds `uefn-server.mjs` plus an `INSTALL.md` or `README.md` carrying the Power Tools repository URL. Nothing at or under an open workspace folder is ever used (compared by real path), and a `package.json` version is never used for ranking: folders next to the workspace come before the home folder, and within one location the most recently modified `uefn-server.mjs` wins. When more than one is found the dialog lists every path and says which one is used and why. TycoonAgents builds `{"command": "<absolute node path>", "args": ["<folder>/uefn-server.mjs"]}` with no `env` (as `INSTALL.md` specifies), shows that exact JSON, and on confirm registers it at Claude local scope as `powertools`.
   - If neither exists, the panel says no Power Tools folder was found, lists where it looked, and links the repository.
3. The entry only counts as enabled once it is registered at local scope; a `.mcp.json`-only entry stays "not enabled" in the Claude VS Code extension until Enable MCP registers it. Start a new chat afterwards.

Anyone who prefers to edit `.mcp.json` by hand can copy the `powertools` entry from this repo's `.mcp.json.example`, replace `<POWER_TOOLS_DIR>` with the full path (forward slashes, even on Windows) to the unzipped Power Tools release, and then click Enable MCP to register it.

The standalone server has no confirm dialog, so it only reports the state and points to the VS Code panel for Enable MCP.

## Env-var ownership

| Variable | Owner | Purpose |
| --- | --- | --- |
| `VERSE_LSP_PATH` | TycoonAgents | Path to the Verse language server binary, used by `verse_lsp_check.py`. |
| `UEFN_VERSE_PROJECT_DIR` | TycoonAgents | UEFN's `VerseProject` data root (digests, `.vproject` files), used by `verse_project_check.py`. |
| `UEFN_BRIDGE_DIR` | Power Tools | The bridge IPC directory shared by its MCP server and its in-UEFN Python bridge. |
| `VERSE_LSP_CHECK_SCRIPT` | Power Tools | Path to Power Tools' own Verse LSP check script, used by its `uefn_verse_check` tool. |

Setting a variable from the wrong owner's list will not do anything useful — each side only reads its own.

## Enforcement

This isolation is enforced by `test/powerToolsIsolation.test.ts`.
