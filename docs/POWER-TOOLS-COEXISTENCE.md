# TycoonAgents ↔ UEFN Power Tools coexistence

> **The one-sentence rule:** Trashbyrd's UEFN Power Tools (`github.com/Corsair-Studios/trashbyrds-uefn-power-tools`) is a separately installed third-party MCP server — TycoonAgents never downloads, installs, stages, deletes, or rewrites it or its files.

## What TycoonAgents' UEFN pack contains

TycoonAgents ships a UEFN *pack* that is entirely independent of Power Tools:

- `media/skills/uefn` — Verse syntax/authoring skill, plus `verse_lsp_check.py` and `verse_project_check.py`, which read `VERSE_LSP_PATH` and `UEFN_VERSE_PROJECT_DIR`.
- `media/skills/uefn-bridge` — a reference skill documenting the Power Tools tool catalog (`uefn_status`, `uefn_list_devices`, `uefn_get_property`, `uefn_set_property`, `uefn_select_actor`, `uefn_run_audit`, `uefn_get_level_info`). It is documentation only; it does not install or run anything.
- Agents `uefn-auditor` and `verse-expert`, which use the skill above and (for `verse-expert`) call the Power Tools MCP tools once the user has wired them up.
- A `thirdParty` entry for `uefn-bridge` in `media/mcp/catalog.json`, carrying a `<POWER_TOOLS_DIR>` placeholder for the user to fill in.

## What TycoonAgents will never do

- Download, install, stage, or update Power Tools or any of its files.
- Delete, "heal", or rewrite Power Tools files (the old `powerToolsInstall.ts`, `legacyBridgeCleanup.ts`, and `mcpHeal.ts` modules that did this have been removed).
- Write to or rewrite the user's `.mcp.json` `uefn-bridge` entry — one-click install of `thirdParty` catalog entries is refused with a message pointing at manual setup.
- Write to UEFN's `Content/` tree or invoke Python inside a UEFN/Fortnite install.

## How a user wires up the MCP

1. Install Power Tools yourself, following its own `INSTALL.md` at `github.com/Corsair-Studios/trashbyrds-uefn-power-tools`.
2. Copy the `uefn-bridge` entry out of this repo's `.mcp.json.example` into your own (gitignored) `.mcp.json`.
3. Fill in `<POWER_TOOLS_DIR>` with the full path (forward slashes, even on Windows) to where you unzipped the Power Tools release — the entrypoint is `node <POWER_TOOLS_DIR>/uefn-server.mjs`.
4. Set any env vars Power Tools' own `INSTALL.md` calls for (see the ownership table below).

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
