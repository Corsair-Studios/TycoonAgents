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

## Requirements

**In-editor Power Tools** (the launcher window inside UEFN itself):
- UEFN installed, with the project open
- The **Python Editor Script Plugin** enabled — the in-editor tools run on UEFN's own embedded Python interpreter, so no separate system Python install is needed for them

**MCP tools** (agent access via the `uefn_*` tools), additionally:
- Node.js v18+ on PATH — the MCP client launches the bridge's server (`uefn-server.js`) via `node`

**`uefn_verse_check`** (headless Verse compiler diagnostics), additionally:
- System Python 3 on PATH (`python`, `python3`, or `py`) — the server runs the analyzer script with it
- Epic's Verse VS Code extension installed in any supported VS Code-family IDE (it bundles `verse-lsp.exe`, the actual analyzer engine)
- The project opened at least once in UEFN, so the Verse project cache the analyzer reads exists

No VS Code-family IDE available? Download Epic's Verse extension's `.vsix` directly from the VS Code Marketplace website, extract it (a `.vsix` is a zip archive), and set the `VERSE_LSP_PATH` environment variable to the `verse-lsp.exe` inside the extracted folder.

## Installation (run this if the bridge is not set up)

The runtime has no dependency on the TycoonAgents extension: a standalone copy of `uefn-server.mjs` — no `node_modules`, no extension present — has been verified to return the full MCP handshake and complete a live `uefn_status` round trip, including from a project path containing spaces. The extension is a convenience for staging files and writing `.mcp.json` automatically; it is not a requirement. Pick whichever path below matches your setup — **neither is "the" canonical path**.

### Step 1 — Check if already installed

Run `uefn_status`. If it succeeds, the bridge is already installed and connected — skip everything below. If it fails, or `Content/Python/uefn_bridge.py` does not exist in the project, install using one of the two paths below.

If `.mcp.json` (workspace root) already has an `mcpServers.uefn` entry but `uefn_status` still fails, check for a legacy misconfiguration first: if that entry contains an `env.UEFN_BRIDGE_DIR` key, remove the entire `env` block (it directed the MCP server to a directory the Python bridge never writes, breaking IPC), save, and restart the Claude Code session before retrying.

### Prerequisites (both paths)

- **Node.js 18+** on PATH — verified working on Node 22; the bundled server contains no syntax requiring a version newer than that, so 18 is the honest floor, not an aspirational one (this repo's `package.json` declares only a `vscode` engine, no Node floor of its own — the claim here is independently verified, not read off that file).
- **UEFN running with the project open** — the in-editor Python tools only start when UEFN loads the project.
- **The Python Editor Script Plugin enabled** in UEFN (`Edit -> Plugins`, search "Python Editor Script Plugin", enable, restart UEFN if prompted).

`uefn_verse_check` alone needs more than this: a system Python 3 on PATH plus `verse_lsp_check.py` and Epic's Verse VS Code extension (which bundles the actual `verse-lsp.exe` analyzer engine) — see **Requirements** above for the full detail and the `VERSE_LSP_PATH` fallback. None of the other 29 tools need any of that. If `verse_lsp_check.py` isn't staged at one of its usual lookup locations, point the server at it directly with the `VERSE_CHECK_SCRIPT` environment variable; the tool fails honestly (`script_not_found`) and names every location it tried when the script can't be found.

### Path A — With the TycoonAgents extension

#### Step A2 — Locate the TycoonAgents extension

Glob for the installed extension folder. Check in order:

- `~/.vscode/extensions/*tycoonagents*/`
- `~/.vscode-insiders/extensions/*tycoonagents*/`
- `~/.cursor/extensions/*tycoonagents*/`

Pick the folder with the highest version number if multiple are found. Verify it contains both:
- `media/uefn-bridge/` directory
- `out/mcp/uefn-server.js`

#### Step A3 — Find the UEFN project's Python directory

Use this precedence (mirrors the installer logic):

1. If `<workspace>/Python/` exists — use it (workspace root is already a plugin content dir).
2. Else if `<workspace>/Plugins/<any>/Content/` exists and contains `.verse` files — use `<workspace>/Plugins/<plugin>/Content/Python/`.
3. Else if `<workspace>/Content/` exists — use `<workspace>/Content/Python/`.
4. Otherwise create `<workspace>/Content/Python/`.

#### Step A4 — Copy the bridge files

Copy **every** Python file from `<extensionFolder>/media/uefn-bridge/` into the Python directory determined above, plus the icon `trashbyrd_40x40.png`. Do **not** copy `uefn-server.mjs` — that is the bundled MCP server (launched by Node via `.mcp.json`), not a UEFN Python tool.

This mirrors the extension's own installer, which stages the whole `media/uefn-bridge/` directory (minus the server bundle) into `Content/Python`, so the manual copy stays correct as tools are added or removed rather than drifting from a hardcoded list.

Only overwrite a file if its content differs from the source (preserves user edits).

#### Step A5 — Merge the `uefn` entry into `.mcp.json`

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

### Path B — Standalone (no extension)

No step in this path installs, requires, or checks for the TycoonAgents extension.

#### Step B2 — Obtain the bridge files

Get `media/uefn-bridge/` from this repo (clone or download it) or from a release archive that bundles the same directory. You need the whole directory: the Python files (`uefn_bridge.py`, `init_unreal.py`, and the rest), the icon `trashbyrd_40x40.png`, and the bundled server `uefn-server.mjs`.

#### Step B3 — Find the UEFN project's Python directory

Same precedence as Step A3 above:

1. If `<project>/Python/` exists — use it.
2. Else if `<project>/Plugins/<any>/Content/` exists and contains `.verse` files — use `<project>/Plugins/<plugin>/Content/Python/`.
3. Else if `<project>/Content/` exists — use `<project>/Content/Python/`.
4. Otherwise create `<project>/Content/Python/`.

#### Step B4 — Copy the Python files into the project

Copy every `.py` file from `media/uefn-bridge/` (plus `trashbyrd_40x40.png`) into the Python directory from Step B3. Do **not** copy `uefn-server.mjs` there — it stays wherever you keep the bridge files on disk (anywhere is fine; it's launched directly by `node`, not staged into the UEFN project).

#### Step B5 — Point `.mcp.json` at `uefn-server.mjs` directly

Create or merge into `.mcp.json` at your workspace root:

```json
{
  "mcpServers": {
    "uefn": {
      "command": "node",
      "args": ["<pathToBridgeFiles>/uefn-server.mjs"]
    }
  }
}
```

Use the path to wherever you kept `uefn-server.mjs` in Step B2 — this is **not** the extension's `out/mcp/uefn-server.js`; the standalone server bundle is self-contained and does not need the extension's build output. On Windows use forward slashes. Do **not** add an `env` block unless you need a non-default `UEFN_BRIDGE_DIR` — both sides default to `<OS temp dir>/uefn_bridge` automatically.

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

## Routing: our bridge vs. Epic's official UEFN MCP

Two UEFN MCP servers may be installed side by side: ours (`uefn`, this
skill) and Epic's official server (registered as `unreal-engine-mcp`).
They see **different object models** — decide which one to call BEFORE
you call anything, not after a failed probe. The disambiguating question:
**"Is this a Scene Graph entity, or a classic actor?"** In a large
existing project, almost everything is a classic actor.

- **Classic actors in the level → OUR `uefn_*` tools.** Finding actors by
  label or class, reading/setting properties in bulk, locations of many
  actors, tags, moderation, dependencies, textures, materials, Niagara
  usage. Epic's `FindEntities` cannot see classic actors at all — on a
  real 44,753-actor project it returned **0** matches.
- **Scene Graph entities and their components → EPIC's
  `ValkyrieToolset.EntityToolset`** (`CreateEntity`, `AddComponent`,
  `GetComponents`, `GetEntityTransform`, component properties). We have
  no equivalent.
- **Authoring / write operations we do not implement → EPIC.** Placing
  devices and event bindings (`DeviceToolset`), compiling Verse
  (`VerseToolset.BuildAll`), pushing live changes and session control
  (`SessionToolset.PushChanges` / `StartGame` / `StopGame`), viewport
  capture (`EditorAppToolset.CaptureViewport`), and Niagara/UMG/Physics
  authoring.
- **Bulk query at scale → OURS.** Anything over hundreds or thousands of
  actors, anything needing pagination or glob matching. Epic's
  `GetVisibleActors` returns only viewport-visible actors (1,336 of
  44,753 on the real project) as bare `refPath` strings with no labels,
  no locations, and no filtering.

Full measured evidence: [`docs/UEFN-MCP-COMPARISON.md`](../../../docs/UEFN-MCP-COMPARISON.md).

### Operational gotchas when calling Epic's server (measured 2026-08-20)

- `call_tool` takes the **short** tool name (e.g. `FindEntities`) — the
  fully-qualified form (e.g. `ValkyrieToolset.EntityToolset.FindEntities`)
  returns `"Unknown tool"`.
- `describe_toolset`'s parameter is `toolset_name`; getting it wrong
  returns HTTP 200 with `isError` set and a plain-text body, not a
  JSON-RPC error.
- Epic's gateway costs **2 discovery round trips** (`list_toolsets`, then
  `describe_toolset`) before any real call.
- Epic's own docs warn: "MCP tool calls can cause the editor to hitch and
  hang."
- `PushChanges` / `StopGame` need a live session — `GetSessionStatus`
  returned `"Disconnected"` when idle.
- Epic notes coordinate-system translation issues between XYZ and
  Left-Up-Forward.

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
| `uefn_batch_set` | Set a property on a filtered set of actors | `property_name`, `value`, `filter_type` (optional), `filter_value` (optional), `dry_run` (optional) |
| `uefn_batch_get` | Read a property from a filtered set of actors (device-gated — see Filter semantics below) | `property_name`, `filter_type` (optional), `filter_value` (optional), `fields` (optional), `max_results` (optional), `offset` (optional) |
| `uefn_batch_location` | Read label + world (x,y,z) location for every actor matching a filter — NOT device-gated, works on any actor | `filter_type` (optional), `filter_value` (optional), `fields` (optional), `max_results` (optional), `offset` (optional) |
| `uefn_tag_inspect` | Read Verse gameplay tags (and optionally location) from actors' tag components — see tag_inspect specifics below | `label_pattern` (optional), `project_dir` (optional), `fields` (optional), `include_location` (optional), `max_results` (optional), `offset` (optional) |
| `uefn_list_commands` | List every command the bridge's dispatch table supports, with parameters, derived live from the dispatch table — call this FIRST when unsure what the bridge offers | none |
| `uefn_texture_find` | Find texture references in the project | `texture_name`, `match_mode` (optional), `project_only` (optional) |
| `uefn_texture_summary` | Get a grouped texture usage summary | `texture_name`, `match_mode` (optional), `project_only` (optional) |
| `uefn_texture_on_actor` | List textures referenced by an actor | `actor_label` |
| `uefn_material_browse` | Browse project materials | `project_only` (optional) |
| `uefn_material_unused` | Find unused materials in the project | `project_only` (optional) |
| `uefn_niagara_browse` | Browse Niagara particle systems | `project_only` (optional) |
| `uefn_niagara_usage` | Show Niagara particle system usage across the level | none |
| `uefn_dependency_scan` | Scan asset dependencies | `project_only` (optional) |
| `uefn_health_scan` | Run a health scan on the project | none |
| `uefn_asset_sweep` | Sweep and report on project assets | `project_only` (optional) |
| `uefn_list_assets` | List assets under a content-browser path via the Unreal Asset Registry (read-only, metadata only — no asset loads) | `path`, `recursive` (optional), `class_filter` (optional), `limit` (optional) |
| `uefn_inspect_asset` | EXPERIMENTAL: load a single asset by path and reflect its editor-property values via Python (read-only — loads but never saves or modifies) | `asset_path`, `max_depth` (optional) |
| `uefn_moderation_scan` | Collect raw project surfaces (asset/HLOD names, Verse strings, island metadata, image metadata, audio) for an IP/authenticity pre-flight prediction; the calling LLM does the judgment and produces the report | `project_dir` (optional), `allowlist` (optional) |
| `uefn_spawn_actor` | Spawn a new actor from an asset into the open level. Edits the level and supports editor undo (Ctrl+Z) | `asset_path`, `location` (optional), `rotation` (optional), `scale` (optional), `label` (optional) |
| `uefn_duplicate_actor` | Duplicate an existing actor by label, offsetting the copy. Edits the level and supports editor undo (Ctrl+Z) | `actor_label`, `offset` (optional), `new_label` (optional) |
| `uefn_set_transform` | Set an actor's location, rotation, and/or scale by label. Edits the level and supports editor undo (Ctrl+Z) | `actor_label`, `location` (optional), `rotation` (optional), `scale` (optional) — at least one transform component required |

## Filter semantics — read this before using batch_get/batch_set/batch_location

`filter_type: "label"` and `filter_type: "class"` do NOT match the same way, and confusing them silently returns zero matches:

- **`"label"`** is a **case-insensitive `fnmatch` glob**, not a substring match. `filter_value: "SGMarker"` matches an actor labeled EXACTLY `SGMarker` (case-insensitive) and nothing else — an actor labeled `SGMarker_04` will NOT match. Use `filter_value: "*SGMarker*"` to match by substring (on the live 44,753-actor project this session verified against, that glob matched 392 actors where the bare label matched 0).
- **`"class"`** IS a case-insensitive substring match — `filter_value: "marker"` matches any class name containing "marker" anywhere.

When a filter matches zero actors, the response's `status: "zero_match"` `reason` string now proactively teaches this: for a `"label"` filter whose `filter_value` contains no glob wildcard (`*`, `?`, `[`), it appends a suggested `filter_value` with `*` wrapped around your original input.

## Honest-failure contract (batch_get, batch_set, batch_location)

All three return a top-level `status` field — **read it first**, before touching `actors`/`matched`:

- `"ok"` — every matched actor resolved.
- `"zero_match"` — the filter matched no actors at all; `reason` names the filter tried (see glob-teaching above).
- `"property_unresolved"` — actors matched, but `property_name` failed to resolve on every one of them; `reason` names the property, `unresolved_on` lists every matched label.
- `"partial"` — some actors resolved, some didn't; per-actor entries carry an explicit `ok: true/false`, and `unresolved_on` lists the labels that failed with a real `error` string each (never dropped or coerced to null).
- `"error"` — the filter/match step itself raised (distinct from a property failing on already-matched actors).

## `property_name: "location"` in batch_get now works — but not "transform"

`uefn_batch_get` special-cases `property_name` normalized (trimmed, lowercased) to `"location"`: it now routes through the same shared location implementation `uefn_batch_location` uses (`batch_get_location` in `batch_tools.py`), reshaping results into batch_get's `{label, class, ok, value}` shape with `value` as an `(x, y, z)` tuple.

Why this was needed: `get_editor_property()` — what every other `property_name` goes through — **cannot resolve world-space location or transform**, because those are not editor properties; they require the dedicated `actor.get_actor_location()` call. Any OTHER geometry-like `property_name` (e.g. `"transform"`, `"rotation"`, `"scale"`) will still fail with an explicit `status: "property_unresolved"` naming that property — this is not a bug, it means that property genuinely isn't a `get_editor_property()` name.

`"transform"` is deliberately **not** special-cased the way `"location"` is: the underlying location helper only returns position, and synthesizing a fake transform (guessing rotation/scale) would misrepresent the actor. If you need location for non-device actors, prefer `uefn_batch_location` directly — it isn't device-gated.

## Pagination (batch_get, batch_location, tag_inspect)

`max_results` is a **page size, not a ceiling**, and `offset` selects which page. Omitting both returns everything in one call — no silent cap. The response carries the true total `matched`, how many actors this page returned (`returned`), and `next_offset` — present only when another page remains, absent on the final page. Loop calls with `offset=0`, then each response's `next_offset`, until it is absent, to sweep the complete matched set exactly once (holds as long as the level isn't mutated mid-sweep).

Live-measured cost on a real 44,753-actor project (`uefn_tag_inspect`, which pays a ~25.1s FIXED cost per call — verse-file scan + tag-class discovery + label-matching every actor — plus ~198ms MARGINAL cost per actor actually walked): a 392-actor page took ~103s total on the first call; a page-sized-~400 call generally costs roughly 25s fixed + 400×0.198s ≈ 104s. An unpaged, unparameterized `tag_inspect` sweep of a project this size additionally runs the offline `__ExternalActors__` scan (see below), which alone can cost **~30 minutes and 10MB+** of payload — page broad scans; don't run them unparameterized against a large project.

## `uefn_tag_inspect` specifics

- **`fields`** trims each returned actor entry down to only the named keys (`"label"` is always kept regardless, so a trimmed entry is still attributable). Field selection matters more here than on `batch_get`: a real 390-actor tag_inspect response measured 681KB with the full fixed shape (nested `parent_chain` per tag, `component_class`, `extraction_status`, raw `actor_tags`, sometimes `extraction_debug`).
- **`include_location`** (default off) adds `{x, y, z}` (or a `location_error` string) to each actor entry, resolved through the same shared location implementation `uefn_batch_location`/the `"location"` special case above use — no second `get_actor_location()` call site.
- **Paging skips the offline scan.** A paged call (`max_results` and/or `offset` given) SKIPS the offline `__ExternalActors__` `.uasset` scan entirely — this is disclosed at runtime in the response's `discovery.notes`. That offline scan is the PRIMARY tag-discovery source in this module's discovery ladder, so a paged actor's tags can be a strict subset of what an unparameterized call would return for that same actor. If you need offline-augmented tags, make one unparameterized call (no `max_results`/`offset`).

## `uefn_list_commands` — call this first when unsure what's available

Returns every command the bridge's dispatch table currently supports (name, parameters, one-line description, and whether it supports the fields/max_results/offset paging trio) derived LIVE from the dispatch table and each handler's own source/docstring — never a hand-maintained list, so it can't drift. Call this before probing tools blind.

## The bridge source is local and readable

The bridge's Python source lives at `media/uefn-bridge/*.py` in this repo (and is staged into `<project>/Content/Python` on install — see Installation above). When a tool's exact behavior matters and this doc doesn't cover it, READ THE SOURCE rather than probing tools experimentally or searching online — `batch_tools.py` and `tag_inspect.py` in particular carry extensive docstrings on filter semantics, status shapes, and pagination that are authoritative over any paraphrase here.

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
