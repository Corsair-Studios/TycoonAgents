# UEFN MCP: Epic's Server vs. Our Bridge

**Snapshot: 2026-08-20.** Measured live against the user's 44,753-actor Star
Wars project, one Epic build, Epic's server registered as
`unreal-engine-mcp` at `http://127.0.0.1:8000/mcp`. This is not a permanent
claim about Epic's roadmap — re-run the comparison against a future build
before trusting it unchanged.

## The one fact that matters

**The two servers see different object models.** Epic's tools are correct —
they do exactly what they claim — but they operate only over **Scene Graph
entities**. Classic actors, which make up the overwhelming majority of a
real UEFN level, are invisible to them.

On the user's project:

- `FindEntities(nameFilter='SGMarker')` returned `[]` in 0.1s.
- `FindEntities(no filter)` returned only **25** Scene Graph entities — in a
  project with **44,753** actors.
- `GetVisibleActors` returned **1,336** actors (viewport-visible only, *not*
  the full level), as bare `refPath` strings with no labels, no locations,
  and no filtering.
- Zero SGMarker matches among those 1,336.
- `GetEntityTransform` on a classic-actor `refPath` fails outright:
  `"is not valid BaseEntity for property Entity"`.
- `GetEntityTransform` on a real Scene Graph entity works and is fast,
  returning full location/rotation/scale.

The developer's original request — "find all SGMarkers and get their
locations" — is **unanswerable through Epic's MCP** on this project. It is
answered by our `uefn_batch_get`, which supports glob matching and
pagination across all 44,753 actors. Neither server replaces the other:
Epic owns Scene Graph entities and authoring; we own bulk queries over
classic actors and offline scanning.

## Epic's gateway shape

Epic does not expose 210 tools directly. It exposes **3**:
`list_toolsets`, `describe_toolset`, `call_tool`. Every real tool hides
behind `call_tool(toolset_name, tool_name, arguments)`, which costs an
agent **2 discovery round trips** (`list_toolsets` then `describe_toolset`)
before it can make a single real call.

`call_tool` takes the **short** tool name (e.g. `FindEntities`) — the
fully-qualified form (e.g. `ValkyrieToolset.EntityToolset.FindEntities`)
returns `"Unknown tool"`.

Epic's `serverInfo` name/title/version are all **empty strings**. Do not
identify their server by name — detect it by protocol conformance instead.

## Toolset inventory: 210 tools across 17 toolsets

| Toolset | Tool count |
| --- | --- |
| NiagaraToolset_System | 46 |
| EditorAppToolset | 37 |
| UMGToolSet | 21 |
| PhysicsAssetToolset | 17 |
| MVVMToolset | 15 |
| EntityToolset | 13 |
| WidgetAnimationToolset | 10 |
| VerseToolset | 10 |
| DeviceToolset | 9 |
| SessionToolset | 8 |
| VerseFieldsToolset | 6 |
| LogsToolset | 4 |
| GameplayTagsToolset | 4 |
| NiagaraToolset_Component | 4 |
| NiagaraToolset_Assets | 3 |
| ValkyriePythonToolset | 2 |
| NiagaraToolset_Info | 1 |
| **Total** | **210** |

### Toolsets relevant to routing decisions

**VerseToolset** — `WriteFile`, `Replace`, `ReadFile`, `Move`, `ListFiles`,
`Grep`, `Delete`, `CreateDirectory`, `Copy`, `BuildAll`.

**EntityToolset** — `SetEntityTransform`, `SetComponentProperty`,
`RemoveComponent`, `ListEntityClasses`, `ListComponentProperties`,
`ListComponentClasses`, `GetEntityTransform`, `GetComponents`,
`GetComponentProperty`, `FindEntities`, `DeleteEntity`, `CreateEntity`,
`AddComponent`. Scoped to Scene Graph entities only — see above.

**DeviceToolset** — `SetDeviceProperty`, `RemoveEventBinding`,
`PlaceDevice`, `ListEventBindings`, `ListDeviceProperties`,
`ListDeviceAssets`, `GetDeviceProperties`, `GetBindingOptions`,
`AddEventBinding`.

**SessionToolset** — `StopSession`, `StopGame`, `StartSession`,
`StartGame`, `PushChanges`, `GetSessionStatus`, `GetGameState`,
`GetClientLogEntries`. `GetSessionStatus` returned `"Disconnected"` in this
snapshot — `PushChanges` and `StopGame` need a live session.

## Capability table: who owns what

| Capability | Epic's MCP | Our uefn-bridge |
| --- | --- | --- |
| Scene Graph entity CRUD (`CreateEntity`, `AddComponent`, `GetComponents`, component properties) | Yes | No — no equivalent |
| Classic actor discovery/read at scale, with glob + pagination | No — invisible to `FindEntities` | Yes — `uefn_batch_get` |
| Device placement, event bindings | Yes (`DeviceToolset`) | Read-only device listing (`uefn_list_devices`) |
| Verse compile (`BuildAll`) and file ops on Verse source | Yes (`VerseToolset`) | Static check only (`uefn_verse_check`) |
| Push live changes / session start-stop | Yes (`SessionToolset`) | No |
| Bulk property get/set across many actors | No | Yes — `uefn_batch_get`, `uefn_batch_set`, `uefn_batch_location` |
| Tag inspection | No | Yes — `uefn_tag_inspect` |
| Moderation / IP-risk scanning | No | Yes — `uefn_moderation_scan`, `uefn_moderation_report` |
| Dependency scanning | No | Yes — `uefn_dependency_scan` |
| Asset / texture / material sweep and browse | No | Yes — `uefn_asset_sweep`, `uefn_inspect_asset`, `uefn_list_assets`, `uefn_material_browse`, `uefn_material_unused`, `uefn_texture_find`, `uefn_texture_on_actor`, `uefn_texture_summary` |
| Niagara usage/browse (read) | Yes, authoring (`NiagaraToolset_*`) | Yes, read-only (`uefn_niagara_browse`, `uefn_niagara_usage`) |
| UMG / Physics Asset / MVVM / Widget Animation authoring | Yes | No |
| Offline `__ExternalActors__` scanning (works without UEFN running) | No | Yes |
| Actor transform get/set, spawn/duplicate/select | Partial (Scene Graph only) | Yes — `uefn_set_transform`, `uefn_spawn_actor`, `uefn_duplicate_actor`, `uefn_select_actor` |
| Health / general audit | No | Yes — `uefn_run_audit`, `uefn_health_scan` |
| Level info, command listing, status | No | Yes — `uefn_get_level_info`, `uefn_list_commands`, `uefn_status`, `uefn_bridge` |

Our full tool set in this comparison: `uefn_status`, `uefn_bridge`,
`uefn_list_commands`, `uefn_get_level_info`, `uefn_list_devices`,
`uefn_get_property`, `uefn_set_property`, `uefn_batch_get`,
`uefn_batch_set`, `uefn_batch_location`, `uefn_select_actor`,
`uefn_spawn_actor`, `uefn_duplicate_actor`, `uefn_set_transform`,
`uefn_tag_inspect`, `uefn_run_audit`, `uefn_health_scan`,
`uefn_moderation_scan`, `uefn_moderation_report`, `uefn_dependency_scan`,
`uefn_asset_sweep`, `uefn_inspect_asset`, `uefn_list_assets`,
`uefn_material_browse`, `uefn_material_unused`, `uefn_texture_find`,
`uefn_texture_on_actor`, `uefn_texture_summary`, `uefn_niagara_browse`,
`uefn_niagara_usage`, `uefn_verse_check` — 31 tools total.

## What Epic covers that we do not

Authoring and write operations: `PlaceDevice` and event bindings,
`CreateEntity`/`AddComponent` on the Scene Graph, `BuildAll` (Verse
compile), `PushChanges` (push live changes), viewport capture, and
Niagara/UMG/Physics-asset authoring. These require a live, connected UEFN
session — ours does not attempt any of it.

## What we cover that Epic does not

Bulk query at scale over classic actors, with pagination and glob
matching — the exact case Epic's `FindEntities` cannot serve. Moderation,
dependency, texture, and material scanning. Offline
`__ExternalActors__` scanning, which works without UEFN even running.

## Other measured facts

- `IsPythonEnabledInUEFN` returned `true`.
- Epic returns the full input schema in its error text on a bad call —
  good agent ergonomics, worth adopting as a pattern in our own error
  messages.
- Epic's docs warn that MCP tool calls "can cause the editor to hitch and
  hang," and note coordinate-system translation issues between XYZ and
  Left-Up-Forward.

## Bottom line

Route classic-actor bulk work to our bridge. Route Scene Graph entity work
and authoring/session control to Epic's server. Neither is a superset of
the other, and both belong installed side by side.
