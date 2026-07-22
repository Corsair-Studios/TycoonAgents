# UEFN Bridge — `list_assets` command (hand-off patch)

Target project: Trashbyrd's Power Tools (`uefn_bridge.py` + `uefn-server.ts` MCP wrapper).

## 1. Rationale

`list_assets`: generic read-only content-browser enumeration via the asset
registry. Use case: external dashboards need to enumerate project content
folders (e.g. weapon item definitions) to map editor asset ids to external
data; the existing commands are level-actor- or asset-class-scoped and can't
list an arbitrary path.

## 2. Handler source

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

## 3. `_METHODS` registration

One line added to the dispatch table:

```python
    "list_assets": _handle_list_assets,
```

## 4. MCP-server side (`uefn-server.ts`) — action needed by maintainer

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

## 5. Example request / response

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

## 6. Compatibility & safety notes

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
