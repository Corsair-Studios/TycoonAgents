"""
UEFN Asset Sweep
================
Find "dead" (unreferenced) assets across the project's content roots.

An asset is reported as dead ONLY when ``asset_usage.confirm_orphans`` finds no
references to it anywhere — the Asset Registry reverse-reference graph across
all asset types PLUS a Verse source-text cross-check. This is the same
authoritative safety net the material / texture / Niagara browsers use, so an
in-use asset is never falsely flagged as deletable.

Scope: every content root EXCEPT engine/system content (``/Engine/``,
``/Script/``, ``/Temp/``). Plugin and content-pack mounts (e.g. ``/Jethro/``)
ARE swept. World/level maps are skipped as candidates — a top-level playable
map legitimately has no referencers and must not be reported as "dead".

Public API:
    sweep_dead_assets(project_only=True) -> dict
        {
          "total_scanned": int,     # candidate assets examined
          "dead_count":    int,
          "dead_assets":   [ {"name", "path", "type", "reason"}, ... ],  # sorted
          "by_type":       { "<AssetType>": <count>, ... },
          "project_only":  bool,
        }
"""

import unreal
import asset_usage

# Engine/system roots are never swept (mirrors material_browser's project
# scope: keep everything except true engine/system content).
_SKIP_PREFIXES = ("/Engine/", "/Script/", "/Temp/")

# Asset classes excluded from candidates: an unreferenced World/map is expected
# (top-level maps have no referencers) and must not be reported as "dead".
_SKIP_CLASSES = frozenset({"World"})


def _get_asset_registry():
    return unreal.AssetRegistryHelpers.get_asset_registry()


def _asset_type(asset_data):
    """Return the asset's class short name across UE Python API variants."""
    try:
        acp = getattr(asset_data, "asset_class_path", None)
        if acp is not None:
            return str(acp.asset_name)
    except Exception:
        pass
    try:
        return str(asset_data.asset_class)
    except Exception:
        return "Unknown"


def _get_all_assets(registry):
    """Every AssetData in the registry, defensive across signature variants."""
    try:
        return registry.get_all_assets(include_only_on_disk_assets=False)
    except TypeError:
        pass
    except Exception as e:
        unreal.log_error(f"asset_sweep: get_all_assets failed — {e}")
        return []
    try:
        return registry.get_all_assets()
    except Exception as e:
        unreal.log_error(f"asset_sweep: get_all_assets failed — {e}")
        return []


def sweep_dead_assets(project_only=True):
    """Report project assets with no references anywhere (see module docstring).

    Parameters
    ----------
    project_only : bool
        Passed through to ``asset_usage.confirm_orphans`` — when True, only
        references from within the detected project prefix count toward keeping
        an asset; when False, any non-engine referencer counts. Candidate
        enumeration always excludes engine/system roots regardless.
    """
    registry = _get_asset_registry()

    unreal.log("asset_sweep: enumerating assets from the Asset Registry...")
    all_assets = _get_all_assets(registry)

    # Build unique candidate package paths (referencers are package-scoped),
    # excluding engine/system roots and World maps.
    candidates = {}  # package_path -> {"name", "type"}
    for asset_data in all_assets:
        pkg = str(asset_data.package_name)
        if any(pkg.startswith(p) for p in _SKIP_PREFIXES):
            continue
        cls = _asset_type(asset_data)
        if cls in _SKIP_CLASSES:
            continue
        if pkg not in candidates:
            candidates[pkg] = {"name": str(asset_data.asset_name), "type": cls}

    candidate_paths = list(candidates.keys())
    unreal.log(
        f"asset_sweep: {len(candidate_paths)} candidate asset(s) to check "
        f"(project_only={project_only})"
    )

    # Authoritative orphan confirmation (registry reverse-refs + Verse scan).
    orphans = asset_usage.confirm_orphans(
        candidate_paths, project_only=project_only, registry=registry
    )

    dead_assets = []
    by_type = {}
    for pkg, reason in orphans.items():
        meta = candidates.get(pkg, {"name": pkg.rsplit("/", 1)[-1], "type": "Unknown"})
        dead_assets.append({
            "name":   meta["name"],
            "path":   pkg,
            "type":   meta["type"],
            "reason": reason,
        })
        by_type[meta["type"]] = by_type.get(meta["type"], 0) + 1

    dead_assets.sort(key=lambda a: (a["type"], a["name"].lower()))

    unreal.log(
        f"asset_sweep: sweep complete — {len(dead_assets)} dead asset(s) "
        f"of {len(candidate_paths)} scanned"
    )

    return {
        "total_scanned": len(candidate_paths),
        "dead_count":    len(dead_assets),
        "dead_assets":   dead_assets,
        "by_type":       by_type,
        "project_only":  bool(project_only),
    }
