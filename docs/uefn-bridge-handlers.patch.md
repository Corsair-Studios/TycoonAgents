# UEFN Bridge — `list_assets` + `inspect_asset` commands (hand-off patch)

Target project: Trashbyrd's Power Tools (`uefn_bridge.py` + `uefn-server.ts` MCP wrapper).

This doc covers two read-only bridge handlers added to `uefn_bridge.py`, for
upstream hand-off.

---

# Part 1 — `list_assets`

## 1.1 Rationale

`list_assets`: generic read-only content-browser enumeration via the asset
registry. Use case: external dashboards need to enumerate project content
folders (e.g. weapon item definitions) to map editor asset ids to external
data; the existing commands are level-actor- or asset-class-scoped and can't
list an arbitrary path.

## 1.2 Handler source

Added to `uefn_bridge.py` immediately after `_handle_asset_sweep` (around
line 527 in the current file):

```python
def _handle_list_assets(params):
    """List assets under a content-browser path via the Asset Registry.

    Read-only: uses ``get_assets_by_path`` to enumerate AssetData metadata
    only — never loads assets, so this is safe on large projects.
    """
    path = params.get("path")
    if not path:
        raise ValueError("Missing required param: path")

    recursive = params.get("recursive", True)
    class_filter = params.get("class_filter")
    limit = params.get("limit", 500)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 500
    limit = max(1, min(limit, 2000))

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    except Exception as e:
        raise RuntimeError(f"list_assets: could not get AssetRegistry: {e}") from e

    try:
        found = registry.get_assets_by_path(path, recursive=recursive)
    except Exception as e:
        raise RuntimeError(f"list_assets: get_assets_by_path failed for '{path}': {e}") from e

    class_filter_lower = class_filter.lower() if class_filter else None

    assets = []
    total_found = 0
    for asset_data in found:
        try:
            try:
                class_name = str(asset_data.asset_class_path.asset_name)
            except AttributeError:
                class_name = str(asset_data.asset_class)

            if class_filter_lower and class_filter_lower not in class_name.lower():
                continue

            total_found += 1
            if len(assets) < limit:
                assets.append({
                    "name": str(asset_data.asset_name),
                    "class": class_name,
                    "package_path": str(asset_data.package_name),
                })
        except Exception:
            continue

    return {
        "path": path,
        "recursive": recursive,
        "total_found": total_found,
        "truncated": total_found > len(assets),
        "assets": assets,
    }
```

## 1.3 `_METHODS` registration

One line added to the dispatch table:

```python
    "list_assets": _handle_list_assets,
```

## 1.4 MCP-server side (`uefn-server.ts`) — action needed by maintainer

The bridge itself is just IPC; the MCP tool surface is defined in the
wrapper. Add a matching `uefn_list_assets` tool definition alongside the
existing `uefn_asset_sweep` / `uefn_list_devices` tools:

- **Tool name:** `uefn_list_assets`
- **Description:** "List assets under a content-browser path via the Unreal
  Asset Registry (read-only, metadata only — no asset loads)."
- **Params:**
  - `path` (string, required) — content path, e.g. `/Game/Athena/Items` or
    `/StarWars/...`
  - `recursive` (boolean, optional, default `true`)
  - `class_filter` (string, optional) — case-insensitive substring filter on
    the asset's class name
  - `limit` (integer, optional, default `500`, max `2000`)
- Wire it to send `{"method": "list_assets", "params": {...}}` over the
  existing command.json/response_*.json IPC channel, same pattern as
  `uefn_asset_sweep`.

## 1.5 Example request / response

Request (`command.json`):

```json
{
  "id": "abc123",
  "token": "<session token>",
  "method": "list_assets",
  "params": {
    "path": "/Game/Athena/Items",
    "recursive": true,
    "class_filter": "weapon",
    "limit": 500
  }
}
```

Response (`response_abc123.json`):

```json
{
  "id": "abc123",
  "result": {
    "path": "/Game/Athena/Items",
    "recursive": true,
    "total_found": 42,
    "truncated": false,
    "assets": [
      {
        "name": "WID_Blaster_Rifle_Common",
        "class": "WeaponItemDefinition",
        "package_path": "/Game/Athena/Items/Weapons/WID_Blaster_Rifle_Common"
      }
    ]
  },
  "error": null,
  "timestamp": "2026-07-22T10:15:00.000000"
}
```

## 1.6 Compatibility & safety notes

- **`asset_class` vs `asset_class_path`:** UE5 deprecated `AssetData.asset_class`
  (a plain string) in favor of `asset_class_path` (a `TopLevelAssetPath`
  struct whose `.asset_name` field holds the class name string). The handler
  tries `asset_class_path.asset_name` first and falls back to `asset_class`
  on `AttributeError`, so it works across both old and new engine/editor
  builds without a version check.
- **Read-only / registry-metadata-only:** `get_assets_by_path` returns
  `AssetData` entries sourced from the Asset Registry cache — it does not
  call `load_asset` or touch the asset on disk. Safe to run against large
  projects with no risk of triggering asset loads or edits.
- Per-asset extraction is wrapped in its own `try/except Exception: continue`
  so one malformed/unusual `AssetData` entry cannot abort the whole listing.

---

# Part 2 — `inspect_asset`

## 2.1 Rationale

`inspect_asset`: **EXPERIMENTAL** probe of whether opaque asset types (e.g.
NPC Character Definitions) expose readable editor-property values to editor
Python, even though those types are closed off from Verse and from asset
export. Several UEFN asset classes (NPC Character Definitions in particular)
have no supported Verse-side read path and cannot be exported/inspected
through normal content-browser tooling — but editor Python's reflection
(`get_editor_property` / `dir()`) is untested against them. This handler
loads a single asset by path and walks its exposed editor properties via
best-effort reflection, so an external dashboard can find out — asset by
asset — whether that data is actually reachable this way, without writing
custom Python per asset type.

This is explicitly a probing/diagnostic tool, not a stable data-extraction
API: property availability and shape depend entirely on what the underlying
UClass chooses to expose to Python, which is undocumented and may vary by
asset type or engine version.

## 2.2 Handler source

Added to `uefn_bridge.py` immediately after `_handle_list_assets` (around
line 589 in the current file). Three pieces: two helpers (`_inspect_value`,
`_editor_property_names`) and the handler itself (`_handle_inspect_asset`).

```python
def _inspect_value(value, depth, max_depth):
    """Best-effort JSON-safe rendering of a reflected property value."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    # Unreal Name/Text/enums stringify usefully.
    type_name = type(value).__name__
    if depth >= max_depth:
        return f"<{type_name}>"
    try:
        if isinstance(value, unreal.Array):
            return [_inspect_value(v, depth + 1, max_depth) for v in list(value)[:32]]
    except Exception:
        pass
    # Structs / objects: try to expand their editor properties one level.
    try:
        if isinstance(value, unreal.StructBase):
            out = {"__struct": type_name}
            for prop in _editor_property_names(value):
                try:
                    out[prop] = _inspect_value(
                        value.get_editor_property(prop), depth + 1, max_depth
                    )
                except Exception as e:
                    out[prop] = f"<unreadable: {e.__class__.__name__}>"
            return out
    except Exception:
        pass
    try:
        if isinstance(value, unreal.Object):
            # Reference another object by path rather than expanding it.
            return {"__object": type_name, "path": value.get_path_name()}
    except Exception:
        pass
    try:
        return str(value)
    except Exception:
        return f"<{type_name}>"


def _editor_property_names(obj):
    """Enumerate candidate editor-property names for a UObject/struct.

    The Python API has no official 'list all properties' call, so probe the
    class's exposed attributes and keep those get_editor_property accepts.
    """
    names = []
    seen = set()
    for attr in dir(obj):
        if attr.startswith("_") or attr in seen:
            continue
        seen.add(attr)
        try:
            obj.get_editor_property(attr)
            names.append(attr)
        except Exception:
            continue
        if len(names) >= 200:
            break
    return names


def _handle_inspect_asset(params):
    """EXPERIMENTAL: load an asset and reflect its editor properties.

    Purpose: probe whether opaque asset types (e.g. NPC Character
    Definitions) expose readable property values to editor Python even
    though they are closed to Verse and export. Read-only — loads the asset
    into memory but never modifies or saves anything.

    params:
      asset_path (required): full object or package path, e.g.
        '/StarWars/NPCCharDef_Anakin' or
        '/StarWars/NPCCharDef_Anakin.NPCCharDef_Anakin'
      max_depth (optional, default 2, cap 4): struct expansion depth.
    """
    asset_path = params.get("asset_path")
    if not asset_path:
        raise ValueError("Missing required param: asset_path")

    max_depth = params.get("max_depth", 2)
    try:
        max_depth = int(max_depth)
    except (TypeError, ValueError):
        max_depth = 2
    max_depth = max(1, min(max_depth, 4))

    load_error = None
    asset = None
    try:
        asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    except Exception as e:
        load_error = f"{e.__class__.__name__}: {e}"

    if asset is None and load_error is None:
        load_error = "load_asset returned None (asset missing or class blocked)"

    if asset is None:
        # Also report whether the registry can at least see it, to
        # distinguish 'wrong path' from 'load blocked'.
        registry_sees_it = False
        try:
            registry = unreal.AssetRegistryHelpers.get_asset_registry()
            ad = registry.get_asset_by_object_path(asset_path)
            registry_sees_it = bool(ad and ad.is_valid())
        except Exception:
            pass
        return {
            "asset_path": asset_path,
            "loaded": False,
            "load_error": load_error,
            "registry_sees_asset": registry_sees_it,
        }

    cls = asset.get_class()
    prop_names = _editor_property_names(asset)
    properties = {}
    unreadable = []
    for name in prop_names:
        try:
            properties[name] = _inspect_value(
                asset.get_editor_property(name), 0, max_depth
            )
        except Exception as e:
            unreadable.append({"name": name, "error": e.__class__.__name__})

    return {
        "asset_path": asset_path,
        "loaded": True,
        "class": str(cls.get_name()) if cls else None,
        "property_count": len(properties),
        "properties": properties,
        "unreadable": unreadable,
    }
```

## 2.3 `_METHODS` registration

One line added to the dispatch table:

```python
    "inspect_asset": _handle_inspect_asset,
```

## 2.4 Params

| Param | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `asset_path` | string | yes | — | Full object or package path, e.g. `/StarWars/NPCCharDef_Anakin` or `/StarWars/NPCCharDef_Anakin.NPCCharDef_Anakin`. |
| `max_depth` | integer | no | `2` | Struct/array expansion depth. Clamped to `[1, 4]`; non-numeric input falls back to the default rather than erroring. |

## 2.5 Response shapes

**Asset failed to load** (wrong path, or the class blocks Python loading):

```json
{
  "asset_path": "string",
  "loaded": false,
  "load_error": "string or null",
  "registry_sees_asset": true
}
```

`registry_sees_asset` disambiguates *why* `loaded` is `false`:
- `registry_sees_asset: true` + a `load_error` → the Asset Registry knows
  about the asset (path is correct) but `load_asset` itself failed or
  returned `None` — likely a class-level Python load block.
- `registry_sees_asset: false` → the path itself is probably wrong (registry
  has no record of it), independent of any load blocking.

**Asset loaded successfully:**

```json
{
  "asset_path": "string",
  "loaded": true,
  "class": "string or null",
  "property_count": 0,
  "properties": { "PropName": "<JSON-safe reflected value>" },
  "unreadable": [ { "name": "PropName", "error": "ExceptionClassName" } ]
}
```

`properties` values are produced by `_inspect_value`: primitives pass
through as-is; `unreal.Array` becomes a JSON array (capped at 32 elements);
`unreal.StructBase` expands one level per remaining depth into
`{"__struct": "TypeName", ...fields}`; `unreal.Object` references are
reported by path rather than expanded (`{"__object": "TypeName", "path":
"..."}`), to avoid following object graphs; anything else that fails all of
the above falls back to `str(value)`, or `"<TypeName>"` if even `str()`
fails. `unreadable` collects properties whose `get_editor_property` call
raised, without aborting the rest of the walk.

## 2.6 Read-only guarantee

`inspect_asset` calls `unreal.EditorAssetLibrary.load_asset` to bring the
asset into memory and `get_editor_property` to read values off it. It never
calls any setter, never calls `save_asset` / `save_loaded_asset`, and never
mutates the loaded object. Loading an asset into memory is the only editor
side effect (same as opening it in the content browser) — nothing on disk
changes, and nothing about the asset's saved state is altered.

## 2.7 Suggested MCP-side tool spec (`uefn-server.ts`)

Mirroring `uefn_list_assets`:

- **Tool name:** `uefn_inspect_asset`
- **Description:** "EXPERIMENTAL: load a single asset by path and reflect
  its editor-property values via Python (read-only — loads but never saves
  or modifies). Use to probe whether an opaque asset type exposes data to
  editor Python that isn't otherwise reachable from Verse or export."
- **Params:**
  - `asset_path` (string, required) — full object or package path.
  - `max_depth` (integer, optional, default `2`, max `4`) — struct/array
    expansion depth.
- Wire it to send `{"method": "inspect_asset", "params": {...}}` over the
  existing command.json/response_*.json IPC channel, same pattern as
  `uefn_list_assets`.
- Recommend flagging this tool as experimental/unstable in its MCP
  description, since output shape depends on undocumented per-class Python
  exposure and may vary across asset types or engine versions.

## 2.8 Example request / response

Request (`command.json`):

```json
{
  "id": "def456",
  "token": "<session token>",
  "method": "inspect_asset",
  "params": {
    "asset_path": "/StarWars/NPCCharDef_Anakin",
    "max_depth": 2
  }
}
```

Response (`response_def456.json`) — successful load:

```json
{
  "id": "def456",
  "result": {
    "asset_path": "/StarWars/NPCCharDef_Anakin",
    "loaded": true,
    "class": "NPCCharacterDefinition",
    "property_count": 18,
    "properties": {
      "DisplayName": "Anakin Skywalker",
      "MaxHealth": 100.0,
      "WeaponLoadout": {
        "__struct": "NPCWeaponLoadoutData",
        "PrimaryWeapon": { "__object": "WeaponItemDefinition", "path": "/StarWars/Weapons/WID_Lightsaber.WID_Lightsaber" }
      }
    },
    "unreadable": [
      { "name": "InternalRuntimeState", "error": "RuntimeError" }
    ]
  },
  "error": null,
  "timestamp": "2026-07-22T10:20:00.000000"
}
```

Response — load blocked / not found:

```json
{
  "id": "def456",
  "result": {
    "asset_path": "/StarWars/NPCCharDef_Missing",
    "loaded": false,
    "load_error": "load_asset returned None (asset missing or class blocked)",
    "registry_sees_asset": false
  },
  "error": null,
  "timestamp": "2026-07-22T10:21:00.000000"
}
```

## 2.9 Compatibility & safety notes

- **No official "list all properties" API:** the Python `unreal` module has
  no supported call to enumerate a UObject's exposed editor properties.
  `_editor_property_names` works around this by probing `dir(obj)` and
  keeping only attribute names that `get_editor_property` accepts — an
  approximation, not a guaranteed-complete property list, capped at 200
  names to bound worst-case cost on classes with very large `dir()` output.
- **Depth-limited recursion:** `_inspect_value` only expands `StructBase`
  and `Array` values, stops at `max_depth`, and truncates arrays to 32
  elements — this bounds both response size and recursion depth against
  self-referential or deeply nested struct graphs.
- **Object references are not followed:** `unreal.Object` values are
  reported as `{"__object": ..., "path": ...}` rather than expanded, so
  `inspect_asset` cannot be used to transitively walk an entire asset graph
  in one call (call it again per referenced path if needed).
- **Every property read is individually guarded:** a single property that
  raises on `get_editor_property` is recorded in `unreadable` and does not
  abort the rest of the inspection.
- **Experimental status is intentional:** this handler exists to answer an
  open question (does Python reflection see data Verse/export cannot) on a
  per-asset-type basis, not to guarantee a stable schema. Treat its output
  as diagnostic, and expect to special-case or extend it once the answer is
  known for the asset types that matter.
