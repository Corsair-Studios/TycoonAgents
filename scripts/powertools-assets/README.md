# Trashbyrd's UEFN Power Tools

An MCP server and in-editor Python bridge for live, chat-driven inspection and editing of a UEFN project — devices, assets, materials, Niagara systems, Verse, and classic actors at scale.

![Trashbyrd's Power Tools panel running inside UEFN, showing the device audit and asset browser tools](docs/trashbyrds_power_tools_panel.png)

> **Not affiliated with Epic Games.** Power Tools is an independent, community-built project. It is not endorsed by, supported by, or affiliated with Epic Games in any way. Fortnite and UEFN are trademarks of Epic Games, Inc.

## Use at your own risk

**Python is known to destabilize UEFN.** Running Python in UEFN's embedded console — whether Power Tools is doing anything or not — has been associated with crashes, including crashes during project **sync**. This is not hypothetical; it has happened.

**Recommendation: turn Python off before you sync.** Disable the Python Editor Script Plugin (`Edit -> Plugins`) or otherwise stop the bridge before syncing a project, then re-enable it afterward if you want the bridge running again.

Power Tools is MIT licensed and provided AS IS. Using it means accepting that the author takes no responsibility for UEFN crashes, corrupted or lost project data, or anything else Python does to your project while the bridge is running.

## What it is

Power Tools bridges an AI chat client (or your own scripts) to a **live** UEFN session. A small Python bridge runs inside UEFN's embedded Python console; a Node/TypeScript MCP server on your machine talks to that bridge over local file-based IPC — no network port, no extra UEFN plugin beyond enabling the built-in Python Editor Script Plugin. Anything the bridge can see in the open project becomes queryable, and in places editable, from your chat client while UEFN stays open with your project loaded.

The MCP server registers 30 `uefn_*` tools. Run the server and list its tools from your client for the current, authoritative list — the groupings below describe what they're for, not the exact names.

## Runs alongside Epic's official UEFN MCP server

Epic now ships its own UEFN MCP server. It is a good tool, and it does exactly what it claims — this section is not a knock on it. The reason to also run Power Tools is that **the two servers see different object models**.

Epic's server exposes 210 tools across 17 toolsets, reached through a 3-tool gateway (`list_toolsets`, `describe_toolset`, `call_tool`). Its entity tools — creating, editing, and querying objects — operate over UEFN's **Scene Graph**. That's the right layer for a lot of authoring work, and Epic's server is the one to reach for when you're placing devices, creating Scene Graph entities, compiling Verse, or driving a live session.

But most of what's actually sitting in a real UEFN level is **classic actors**, not Scene Graph entities, and Epic's entity tools cannot see classic actors at all. Measured on a real 44,753-actor UEFN project:

- Epic's `FindEntities` with no filter returned only **25** Scene Graph entities, out of 44,753 actors in the level.
- Epic's `GetVisibleActors` returned **1,336** actors — viewport-visible only, as bare reference-path strings with no names, no locations, nothing you can act on directly.
- Calling `GetEntityTransform` on a classic-actor reference path fails outright: Epic's tools simply don't recognize it as a valid entity.

A request as simple as "find all `SGMarker` actors and report their locations" is **unanswerable through Epic's MCP** on a project like that. It's a normal query for Power Tools' `uefn_batch_get`, which searches across all 44,753 actors with glob-pattern matching and pagination.

Installing both servers together is the intended setup, not a conflict — see [INSTALL.md](INSTALL.md#5-epics-official-uefn-mcp-server) for how to enable Epic's server alongside this one, and which to reach for depending on what you're doing.

## Why use this

- **Bulk queries over classic actors.** `uefn_batch_get` (plus `uefn_batch_set` and `uefn_batch_location`) answers questions across the whole level — glob-matched, paginated — that Epic's entity tools structurally cannot answer, because classic actors sit outside the Scene Graph.
- **Moderation and IP pre-flight scanning.** Sweep a project for content that risks a moderation rejection before you submit, something neither server did until Power Tools added it.
- **Dependency, asset, texture, and material sweeps.** Trace what depends on what, find unused materials, locate every actor using a given texture.
- **Tag inspection.** Look up gameplay tags across actors.
- **Offline scanning.** Some scans read UEFN's `__ExternalActors__` files directly off disk and work even when UEFN isn't running.

What Power Tools does **not** do, and Epic's server does: authoring and write operations like `PlaceDevice`, `CreateEntity`, `AddComponent`, Verse `BuildAll` compilation, and live session control (`PushChanges`, start/stop). For that side of the workflow, use Epic's server.

## What's in the box

### MCP tools (30)

- **Status and level info** — `uefn_status`, `uefn_list_commands`, `uefn_get_level_info`.
- **Device inspection** — `uefn_list_devices`.
- **Property get/set, single and bulk** — `uefn_get_property`, `uefn_set_property`, `uefn_batch_get`, `uefn_batch_set`, `uefn_batch_location`.
- **Actor operations** — `uefn_select_actor`, `uefn_spawn_actor`, `uefn_duplicate_actor`, `uefn_set_transform`.
- **Tags** — `uefn_tag_inspect`.
- **Audits and health** — `uefn_run_audit`, `uefn_health_scan`.
- **Moderation / IP risk** — `uefn_moderation_scan`, `uefn_moderation_report`.
- **Dependencies** — `uefn_dependency_scan`.
- **Assets** — `uefn_asset_sweep`, `uefn_inspect_asset`, `uefn_list_assets`.
- **Materials** — `uefn_material_browse`, `uefn_material_unused`.
- **Textures** — `uefn_texture_find`, `uefn_texture_on_actor`, `uefn_texture_summary`.
- **Niagara (particle systems)** — `uefn_niagara_browse`, `uefn_niagara_usage`.
- **Verse** — `uefn_verse_check` (static diagnostics via the Verse language server).

### In-UEFN Tkinter panel

Beyond the MCP tools, the bridge ships a graphical panel that runs inside UEFN itself (`import pt` from the Python console) with its own set of inspection tools, including Device Audit, Dependency Viewer, Verse Tag Inspector, Material Browser, Texture Finder, Niagara Inspector, Health Scanner, Moderation Scanner, and Property Inspector.

## Architecture

```
MCP client (e.g. Claude Code)
      |
MCP server (uefn-server.mjs, runs on Node)
      |
file-based IPC (OS temp dir)
      |
Python bridge (python/, runs inside UEFN's embedded Python console)
```

The MCP server and the in-editor Python bridge are two separate processes handing off work through files on disk. UEFN must stay open with your project loaded for live queries and edits to work. A downloaded release runs with `node uefn-server.mjs` and no build step; a source clone instead runs the TypeScript entry point (`uefn-server.ts`) via `tsx`.

## Install

See [INSTALL.md](INSTALL.md) for full setup steps, including how to connect the MCP server to your AI client of choice (Claude Code, Gemini CLI, Codex CLI, Cursor, Windsurf, Antigravity IDE, or VS Code Copilot).

One gotcha worth knowing up front: on current UEFN builds, Python's lifecycle is dynamic and the bridge's `init_unreal.py` may not auto-start when UEFN loads your project. If you open the Python console and don't see a Power Tools launcher window, run:

```python
import init_unreal
```

That starts the bridge for the current session. See [INSTALL.md](INSTALL.md#workaround-bridge-doesnt-auto-start-dynamic-python-lifecycle) for details.

## License

MIT. Copyright (c) 2026 Trashbyrd (https://x.com/thetrashbyrd).
