"""
UEFN Texture Explorer
======================
Browse and search all Texture2D assets in the Asset Registry, with a reverse
reference map showing which Materials, MICs, and Niagara systems use each
texture.  Runs inside UEFN's embedded Python 3.11 (requires ``unreal`` module).

Provides four interfaces:
  1. **find_texture_usage()**   — Asset Registry scan using get_dependencies(),
                                  returns structured dict (texture-centric)
  2. **find_texture_summary()** — compact grouped summary + unreal.log report
  3. **list_textures_on_actor()** — reverse lookup: all textures on one actor
                                    (level scan — kept as-is)
  4. **browse_textures()**      — scan all project Texture2D assets and build a
                                  reverse reference map (used by the Explorer UI)
  5. **show_texture_finder()** — Tkinter UI: browsable Texture Explorer with
                                  live filter, orphan detection, and refresh

Usage:
    from texture_finder import find_texture_usage, find_texture_summary
    from texture_finder import list_textures_on_actor, browse_textures
    from texture_finder import show_texture_finder
"""

import os
import unreal
import traceback
import webbrowser
from fnmatch import fnmatch

try:
    import tkinter as tk
    from tkinter import ttk
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Theme constants (matching launcher/batch_tools palette)
# ---------------------------------------------------------------------------

_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"
_ENTRY_BG = "#FBFAF6"
_ENTRY_FG = "#1A1A1A"

# UI state for the tick pump
_tick_handle = [None]

# Cached scan results for the UI (avoids re-scanning on column sort, etc.)
_last_scan_result = [None]


# ---------------------------------------------------------------------------
# Internal helpers — shared by both Asset Registry scan and actor scan
# ---------------------------------------------------------------------------

def _texture_matches(path_or_name, query, match_mode):
    """
    Return True if *path_or_name* matches *query* according to *match_mode*.

    match_mode:
        "substring" — case-insensitive contains (default)
        "exact"     — full path string equality (case-insensitive)
        "glob"      — fnmatch pattern applied to the full path
    """
    if not path_or_name:
        return False

    target_lower = path_or_name.lower()
    query_lower = query.lower()

    if match_mode == "exact":
        return target_lower == query_lower
    elif match_mode == "glob":
        return fnmatch(target_lower, query_lower)
    else:  # substring (default)
        return query_lower in target_lower


def _safe_label(actor):
    """Return the actor's display label, falling back to class name."""
    try:
        return actor.get_actor_label()
    except Exception:
        try:
            return actor.get_class().get_name()
        except Exception:
            return "<unknown>"


# ---------------------------------------------------------------------------
# Actor-scan helpers — kept for list_textures_on_actor()
# ---------------------------------------------------------------------------

def _get_all_actors():
    """Return all level actors via EditorActorSubsystem."""
    subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    if subsystem is None:
        raise RuntimeError("Could not get EditorActorSubsystem")
    return subsystem.get_all_level_actors()


def _iter_material_textures(material):
    """
    Yield (param_name, texture_path) tuples for all texture parameters
    on *material*.  Returns an empty iterator if material is None or has no
    texture parameters.
    """
    if material is None:
        return

    try:
        params = material.get_editor_property("TextureParameterValues")
    except Exception:
        return

    if not params:
        return

    for param in params:
        try:
            param_name = str(param.parameter_info.name)
            texture = param.parameter_value
            if texture is None:
                texture_path = ""
            else:
                try:
                    texture_path = texture.get_path_name()
                except Exception:
                    texture_path = str(texture)
            yield param_name, texture_path
        except Exception:
            continue


def _get_component_materials(component):
    """
    Yield (slot_index, material) pairs for all material slots on *component*.
    Silently skips slots where get_material() fails.
    """
    try:
        num = component.get_num_materials()
    except Exception:
        return

    for i in range(num):
        try:
            mat = component.get_material(i)
            if mat is not None:
                yield i, mat
        except Exception:
            continue


# ---------------------------------------------------------------------------
# Asset Registry helpers
# ---------------------------------------------------------------------------

def _get_project_prefix():
    """
    Detect the current UEFN project's asset prefix (e.g. "/MyProject/").

    Uses multiple strategies and logs the result for debugging.
    """
    # Strategy 1: Level actors have paths like /MyProject/IslandLake.IslandLake:PersistentLevel.Actor
    # Extract the root from the first actor's full path
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actors = subsystem.get_all_level_actors()
        if actors:
            path = actors[0].get_path_name()  # e.g. /MyProject/IslandLake.IslandLake:PersistentLevel.SomeActor
            parts = path.split('/')
            if len(parts) >= 2 and parts[1]:
                prefix = '/' + parts[1] + '/'
                unreal.log(f"texture_finder: Detected project prefix from actor path: {prefix}")
                return prefix
    except Exception as e:
        unreal.log_warning(f"texture_finder: Actor path detection failed — {e}")

    # Strategy 2: Use the world path directly
    try:
        subsystem2 = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        world = subsystem2.get_world()
        if world:
            world_path = world.get_path_name()
            unreal.log(f"texture_finder: World path = {world_path}")
            parts = world_path.split('/')
            if len(parts) >= 2 and parts[1]:
                prefix = '/' + parts[1] + '/'
                unreal.log(f"texture_finder: Detected project prefix from world: {prefix}")
                return prefix
    except Exception as e:
        unreal.log_warning(f"texture_finder: World path detection failed — {e}")

    # Last resort
    unreal.log_warning("texture_finder: Could not detect project prefix, defaulting to /Game/")
    return "/Game/"


def _get_asset_registry():
    """Return the asset registry instance."""
    return unreal.AssetRegistryHelpers.get_asset_registry()


def _asset_class_path(engine_class_name, module="/Script/Engine"):
    """Return a TopLevelAssetPath for a given class name and module."""
    return unreal.TopLevelAssetPath(module, engine_class_name)


# ---------------------------------------------------------------------------
# Defensive AssetRegistryDependencyOptions helper (mirrors dependency_viewer)
# ---------------------------------------------------------------------------

def _set_dep_option(opts, names, value=True):
    """Try to set a boolean attribute on an AssetRegistryDependencyOptions object,
    working through the supplied name list (most-preferred first).
    Returns True if at least one name was accepted; False if none matched."""
    for n in names:
        try:
            if hasattr(opts, n):
                setattr(opts, n, value)
                return True
        except Exception:
            pass
    return False


def _make_dep_options():
    """Build an AssetRegistryDependencyOptions with hard+soft package references
    enabled defensively.  Falls back to default options so the scan never crashes."""
    try:
        opts = unreal.AssetRegistryDependencyOptions()
        _set_dep_option(opts, ("include_hard_package_references", "include_hard_package_data"))
        _set_dep_option(opts, ("include_soft_package_references", "include_soft_package_data"))
        return opts
    except Exception as e:
        unreal.log_warning(f"texture_finder: Could not configure dep options — {e}. Using defaults.")
        try:
            return unreal.AssetRegistryDependencyOptions()
        except Exception:
            return None


def _asset_type_label(class_path_str):
    """
    Infer a human-readable asset type from a class path string.
    Returns "Material", "MaterialInstanceConstant", or "NiagaraSystem".
    """
    s = str(class_path_str).lower()
    if "materialinstanceconstant" in s:
        return "MaterialInstanceConstant"
    if "niagara" in s:
        return "NiagaraSystem"
    return "Material"


# ---------------------------------------------------------------------------
# Core scan function — get_dependencies() approach with Niagara support
# ---------------------------------------------------------------------------

def find_texture_usage(texture_name, match_mode="substring", project_only=True):
    """
    Use the Asset Registry to find all materials and Niagara systems that
    reference *texture_name* via ``get_dependencies()``.

    Algorithm
    ---------
    1. Fetch all Texture2D assets; filter by *texture_name* / *match_mode*.
    2. Build a set of matched texture package names for O(1) lookup.
    3. Fetch Material + MaterialInstanceConstant + NiagaraSystem assets.
    4. For each asset call ``registry.get_dependencies()`` and check whether
       any dependency is in the matched texture set.
    5. Record matches.

    Note: ``Name`` objects returned by the registry do NOT have string methods.
    Every use of ``.asset_name``, ``.package_name``, and dependency items is
    wrapped with ``str()`` before string operations.

    Parameters
    ----------
    texture_name : str
        Texture name or path fragment to search for.
    match_mode : str
        "substring" (default) — case-insensitive contains
        "exact"               — full path equality (case-insensitive)
        "glob"                — fnmatch pattern

    Returns
    -------
    dict with keys:
        query, match_mode, total_textures_scanned, total_assets_checked,
        textures (list), unique_textures (int), unique_references (int)

    Each texture entry has:
        texture_path (str), texture_name (str), references (list)

    Each reference entry has:
        asset_name (str), asset_path (str), asset_type (str)
        asset_type is one of "Material", "MaterialInstanceConstant",
        "NiagaraSystem"
    """
    registry = _get_asset_registry()
    dep_options = _make_dep_options()

    # -----------------------------------------------------------------------
    # Step 1 — collect all Texture2D assets, filter by query (project only)
    # -----------------------------------------------------------------------
    unreal.log("texture_finder: Fetching Texture2D assets from registry...")
    try:
        all_textures = registry.get_assets_by_class(
            _asset_class_path("Texture2D")
        )
    except Exception as e:
        unreal.log_error(f"texture_finder: Failed to get Texture2D assets — {e}")
        all_textures = []

    total_textures_scanned = len(all_textures)
    unreal.log(
        f"texture_finder: {total_textures_scanned} Texture2D assets in registry "
        f"— filtering for '{texture_name}' [{match_mode}]"
    )

    # matched_texture_info: package_name_str -> {"texture_name": str}
    # Skip pure engine internals (/Engine/, /Script/) but include all game
    # content — the user's search query is the real filter.
    _SKIP_PREFIXES = ("/Engine/", "/Script/")
    matched_texture_info = {}
    for asset_data in all_textures:
        pkg_name = str(asset_data.package_name)   # Name -> str
        if any(pkg_name.startswith(p) for p in _SKIP_PREFIXES):
            continue
        asset_nm = str(asset_data.asset_name)      # Name -> str
        if (_texture_matches(pkg_name, texture_name, match_mode)
                or _texture_matches(asset_nm, texture_name, match_mode)):
            matched_texture_info[pkg_name] = {"texture_name": asset_nm}

    unreal.log(f"texture_finder: {len(matched_texture_info)} texture(s) matched query")

    if not matched_texture_info:
        return {
            "query": texture_name,
            "match_mode": match_mode,
            "total_textures_scanned": total_textures_scanned,
            "total_assets_checked": 0,
            "textures": [],
            "unique_textures": 0,
            "unique_references": 0,
        }

    # Build a fast-lookup set of matched package names
    matched_pkg_set = set(matched_texture_info.keys())

    # -----------------------------------------------------------------------
    # Step 2 — gather candidate asset classes: Material, MIC, NiagaraSystem
    # -----------------------------------------------------------------------
    if project_only:
        project_prefix = _get_project_prefix()
        unreal.log(f"texture_finder: Project-only mode — filtering to {project_prefix}")

    candidate_assets = []

    for cls_name in ("Material", "MaterialInstanceConstant"):
        try:
            assets = registry.get_assets_by_class(_asset_class_path(cls_name))
            if project_only:
                filtered = [a for a in assets
                            if str(a.package_name).startswith(project_prefix)]
            else:
                filtered = [a for a in assets
                            if not any(str(a.package_name).startswith(p) for p in _SKIP_PREFIXES)]
            candidate_assets.extend(filtered)
            unreal.log(f"texture_finder: {len(filtered)} {cls_name} asset(s) (of {len(assets)} total)")
        except Exception as e:
            unreal.log_warning(f"texture_finder: Could not fetch {cls_name} assets — {e}")

    try:
        niagara_assets = registry.get_assets_by_class(
            _asset_class_path("NiagaraSystem", "/Script/Niagara")
        )
        if project_only:
            filtered_niagara = [a for a in niagara_assets
                                if str(a.package_name).startswith(project_prefix)]
        else:
            filtered_niagara = [a for a in niagara_assets
                                if not any(str(a.package_name).startswith(p) for p in _SKIP_PREFIXES)]
        candidate_assets.extend(filtered_niagara)
        unreal.log(f"texture_finder: {len(filtered_niagara)} NiagaraSystem asset(s) (of {len(niagara_assets)} total)")
    except Exception as e:
        unreal.log_warning(f"texture_finder: Could not fetch NiagaraSystem assets — {e}")

    unreal.log(f"texture_finder: {len(candidate_assets)} total candidate asset(s) to check")

    # -----------------------------------------------------------------------
    # Step 3 — for each candidate, call get_dependencies() and check set
    # -----------------------------------------------------------------------
    # texture_map: tex_pkg_str -> {"texture_name": str, "references": {ref_path -> entry}}
    texture_map = {
        pkg: {"texture_name": info["texture_name"], "references": {}}
        for pkg, info in matched_texture_info.items()
    }

    total_assets_checked = 0
    unique_references_set = set()

    for idx, asset_data in enumerate(candidate_assets):
        if idx > 0 and idx % 500 == 0:
            unreal.log(f"texture_finder: Progress — {idx}/{len(candidate_assets)} assets checked...")

        asset_pkg = str(asset_data.package_name)   # Name -> str
        asset_nm  = str(asset_data.asset_name)      # Name -> str
        asset_type = _asset_type_label(asset_data.asset_class_path)
        total_assets_checked += 1

        try:
            deps = registry.get_dependencies(asset_pkg, dep_options)
        except Exception:
            continue

        if deps is None:
            continue

        for dep in deps:
            dep_str = str(dep)   # Name -> str
            if dep_str in matched_pkg_set:
                # This asset depends on one of our matched textures
                tex_entry = texture_map[dep_str]
                if asset_pkg not in tex_entry["references"]:
                    tex_entry["references"][asset_pkg] = {
                        "asset_name": asset_nm,
                        "asset_path": asset_pkg,
                        "asset_type": asset_type,
                    }
                    unique_references_set.add(asset_pkg)

    # -----------------------------------------------------------------------
    # Step 4 — build output structure
    # -----------------------------------------------------------------------
    textures = []
    for tex_pkg, tex_info in texture_map.items():
        references = list(tex_info["references"].values())
        if not references:
            continue  # skip textures with no project references
        textures.append({
            "texture_path": tex_pkg,
            "texture_name": tex_info["texture_name"],
            "references": references,
        })

    unreal.log(
        f"texture_finder: Complete — {total_textures_scanned} textures scanned, "
        f"{total_assets_checked} assets checked, "
        f"{len(textures)} unique texture(s) matched, "
        f"{len(unique_references_set)} unique reference(s)"
    )

    return {
        "query": texture_name,
        "match_mode": match_mode,
        "total_textures_scanned": total_textures_scanned,
        "total_assets_checked": total_assets_checked,
        "textures": textures,
        "unique_textures": len(textures),
        "unique_references": len(unique_references_set),
    }


# ---------------------------------------------------------------------------
# Summary function
# ---------------------------------------------------------------------------

def find_texture_summary(texture_name, match_mode="substring", project_only=True):
    """
    Compact grouped summary of texture usage, logged to unreal.log.

    Groups matches by texture path, then by referencing asset.

    Returns
    -------
    dict with keys:
        query, match_mode, total_textures_scanned, total_assets_checked,
        unique_textures, unique_references, textures
    """
    result = find_texture_usage(texture_name, match_mode, project_only=project_only)

    unreal.log("=" * 70)
    unreal.log(f"TEXTURE FINDER REPORT — query='{texture_name}'  mode={match_mode}")
    unreal.log(f"  Textures scanned:   {result['total_textures_scanned']}")
    unreal.log(f"  Assets checked:     {result['total_assets_checked']}")
    unreal.log(f"  Unique textures:    {result['unique_textures']}")
    unreal.log(f"  Unique references:  {result['unique_references']}")
    unreal.log("-" * 70)

    if not result["textures"]:
        unreal.log("  No matches found.")
    else:
        for tex_entry in result["textures"]:
            unreal.log(f"TEXTURE: {tex_entry['texture_path']}")
            for ref_entry in tex_entry["references"]:
                unreal.log(
                    f"  [{ref_entry['asset_type']}] {ref_entry['asset_name']}"
                    f"  |  {ref_entry['asset_path']}"
                )
            unreal.log("")

    unreal.log("=" * 70)

    return {
        "query": texture_name,
        "match_mode": match_mode,
        "total_textures_scanned": result["total_textures_scanned"],
        "total_assets_checked": result["total_assets_checked"],
        "unique_textures": result["unique_textures"],
        "unique_references": result["unique_references"],
        "textures": result["textures"],
    }


# ---------------------------------------------------------------------------
# Reverse lookup — actor-centric, kept from original implementation
# ---------------------------------------------------------------------------

def list_textures_on_actor(actor_label):
    """
    Find an actor by label and list ALL texture parameters across all its materials.

    Parameters
    ----------
    actor_label : str
        The display label of the actor as shown in the UEFN Outliner.

    Returns
    -------
    dict with keys:
        actor_label, actor_class, found (bool),
        textures (list of dicts: component_class, material_name, material_path,
                  param_name, texture_path)
    """
    component_classes = [unreal.StaticMeshComponent]
    try:
        component_classes.append(unreal.SkeletalMeshComponent)
    except AttributeError:
        pass

    try:
        all_actors = _get_all_actors()
    except Exception as e:
        unreal.log_error(f"texture_finder: Failed to get actors — {e}")
        return {"actor_label": actor_label, "actor_class": "", "found": False, "textures": []}

    target = None
    for actor in all_actors:
        try:
            if _safe_label(actor).lower() == actor_label.lower():
                target = actor
                break
        except Exception:
            continue

    if target is None:
        unreal.log(f"texture_finder: Actor not found: '{actor_label}'")
        return {"actor_label": actor_label, "actor_class": "", "found": False, "textures": []}

    try:
        actor_class = target.get_class().get_name()
    except Exception:
        actor_class = "<unknown>"

    textures = []

    for comp_class in component_classes:
        try:
            component = target.get_component_by_class(comp_class)
        except Exception:
            continue

        if component is None:
            continue

        comp_class_name = comp_class.__name__

        for _slot, material in _get_component_materials(component):
            try:
                mat_path = material.get_path_name()
            except Exception:
                mat_path = ""

            try:
                mat_name = material.get_full_name()
            except Exception:
                mat_name = mat_path

            for param_name, texture_path in _iter_material_textures(material):
                textures.append({
                    "component_class": comp_class_name,
                    "material_name": mat_name,
                    "material_path": mat_path,
                    "param_name": param_name,
                    "texture_path": texture_path,
                })

    unreal.log(f"texture_finder: '{actor_label}' ({actor_class}) — {len(textures)} texture parameter(s)")
    for t in textures:
        unreal.log(f"  [{t['component_class']}] {t['material_name']}  |  {t['param_name']} = {t['texture_path']}")

    return {
        "actor_label": actor_label,
        "actor_class": actor_class,
        "found": True,
        "textures": textures,
    }


# ---------------------------------------------------------------------------
# Browse function — full reverse-reference map (used by Explorer UI)
# ---------------------------------------------------------------------------

def browse_textures(project_only=True):
    """
    Scan all Texture2D assets and build a reverse reference map: for each
    texture, which Materials / MICs / NiagaraSystems reference it.

    Algorithm
    ---------
    1. Fetch all Texture2D assets from the registry.
    2. Filter: if *project_only*, keep only those under the detected project
       prefix; otherwise skip /Engine/ and /Script/ prefixes.
    3. Fetch all Material, MaterialInstanceConstant, and NiagaraSystem assets
       (same scope filter), call ``get_dependencies()`` on each, and build a
       reverse map: texture_pkg -> list of referencing asset dicts.
    4. Return every texture (including orphans with ref_count=0), sorted by name.

    Returns
    -------
    dict with keys:
        total_textures (int)       — number of textures found after scope filter
        total_assets_checked (int) — candidate assets examined
        textures (list)            — sorted by name; each entry:
            {
                "name": str,
                "path": str,
                "ref_count": int,
                "references": [{"name": str, "path": str, "type": str}, ...]
            }
    """
    registry = _get_asset_registry()
    dep_options = _make_dep_options()
    _SKIP_PREFIXES = ("/Engine/", "/Script/")

    # -----------------------------------------------------------------------
    # Step 1 — collect all Texture2D assets, apply scope filter
    # -----------------------------------------------------------------------
    unreal.log("texture_explorer: Fetching Texture2D assets from registry...")
    try:
        all_textures = registry.get_assets_by_class(_asset_class_path("Texture2D"))
    except Exception as e:
        unreal.log_error(f"texture_explorer: Failed to get Texture2D assets — {e}")
        all_textures = []

    if project_only:
        project_prefix = _get_project_prefix()
        unreal.log(f"texture_explorer: Project-only mode — prefix {project_prefix}")
        tex_list = [a for a in all_textures
                    if str(a.package_name).startswith(project_prefix)]
    else:
        tex_list = [a for a in all_textures
                    if not any(str(a.package_name).startswith(p) for p in _SKIP_PREFIXES)]

    unreal.log(f"texture_explorer: {len(tex_list)} Texture2D asset(s) in scope (of {len(all_textures)} total)")

    # tex_map: pkg_str -> {"name": str, "path": str, "references": {ref_pkg: entry}}
    tex_map = {}
    tex_pkg_set = set()
    for asset_data in tex_list:
        pkg = str(asset_data.package_name)
        tex_map[pkg] = {
            "name": str(asset_data.asset_name),
            "path": pkg,
            "references": {},
        }
        tex_pkg_set.add(pkg)

    # -----------------------------------------------------------------------
    # Step 2 — gather candidate asset classes and apply scope filter
    # -----------------------------------------------------------------------
    candidate_assets = []
    for cls_name in ("Material", "MaterialInstanceConstant"):
        try:
            assets = registry.get_assets_by_class(_asset_class_path(cls_name))
            if project_only:
                filtered = [a for a in assets
                            if str(a.package_name).startswith(project_prefix)]
            else:
                filtered = [a for a in assets
                            if not any(str(a.package_name).startswith(p) for p in _SKIP_PREFIXES)]
            candidate_assets.extend(filtered)
            unreal.log(f"texture_explorer: {len(filtered)} {cls_name} asset(s) in scope")
        except Exception as e:
            unreal.log_warning(f"texture_explorer: Could not fetch {cls_name} assets — {e}")

    try:
        niagara_assets = registry.get_assets_by_class(
            _asset_class_path("NiagaraSystem", "/Script/Niagara")
        )
        if project_only:
            filtered_n = [a for a in niagara_assets
                          if str(a.package_name).startswith(project_prefix)]
        else:
            filtered_n = [a for a in niagara_assets
                          if not any(str(a.package_name).startswith(p) for p in _SKIP_PREFIXES)]
        candidate_assets.extend(filtered_n)
        unreal.log(f"texture_explorer: {len(filtered_n)} NiagaraSystem asset(s) in scope")
    except Exception as e:
        unreal.log_warning(f"texture_explorer: Could not fetch NiagaraSystem assets — {e}")

    unreal.log(f"texture_explorer: {len(candidate_assets)} total candidate asset(s) to check")

    # -----------------------------------------------------------------------
    # Step 3 — build reverse reference map via get_dependencies()
    # -----------------------------------------------------------------------
    total_assets_checked = 0
    for idx, asset_data in enumerate(candidate_assets):
        if idx > 0 and idx % 500 == 0:
            unreal.log(f"texture_explorer: Progress — {idx}/{len(candidate_assets)} assets checked...")

        asset_pkg  = str(asset_data.package_name)
        asset_name = str(asset_data.asset_name)
        asset_type = _asset_type_label(asset_data.asset_class_path)
        total_assets_checked += 1

        try:
            deps = registry.get_dependencies(asset_pkg, dep_options)
        except Exception:
            continue

        if deps is None:
            continue

        for dep in deps:
            dep_str = str(dep)
            if dep_str in tex_pkg_set:
                tex_refs = tex_map[dep_str]["references"]
                if asset_pkg not in tex_refs:
                    tex_refs[asset_pkg] = {
                        "name": asset_name,
                        "path": asset_pkg,
                        "type": asset_type,
                    }

    # -----------------------------------------------------------------------
    # Step 4 — build output list, sorted by texture name
    # -----------------------------------------------------------------------
    # The forward-dependency scan above only sees Material/MIC/Niagara users.
    # A texture with zero such references is merely a *candidate* orphan — it
    # could still be used by other asset types, UI, landscape, devices, Verse,
    # or soft references. Confirm those candidates against the Asset Registry
    # reverse-reference graph + Verse source text before reporting any as
    # orphaned, so we never tell a developer an in-use texture is safe to delete.
    candidate_orphans = [pkg for pkg, info in tex_map.items() if not info["references"]]
    referenced_elsewhere = {}
    try:
        import asset_usage
        confirmed = asset_usage.confirm_orphans(candidate_orphans, project_only=project_only)
    except Exception as e:
        unreal.log_warning(
            f"texture_explorer: orphan confirmation unavailable ({e}); "
            f"falling back to forward-dependency result (may over-report orphans)."
        )
        confirmed = {pkg: "forward-deps-only (registry check unavailable)" for pkg in candidate_orphans}

    textures = []
    for pkg, info in tex_map.items():
        refs = list(info["references"].values())
        ref_count = len(refs)
        # If a candidate orphan was NOT confirmed, it is referenced elsewhere —
        # surface a non-zero ref_count so the UI does not mark it as an orphan.
        if ref_count == 0 and pkg not in confirmed:
            try:
                others = asset_usage.get_referencer_details(pkg, project_only=project_only)
            except Exception:
                others = []
            referenced_elsewhere[pkg] = others
            ref_count = len(others) if others else 1
        textures.append({
            "name": info["name"],
            "path": info["path"],
            "ref_count": ref_count,
            "references": refs,
            "referenced_elsewhere": pkg in referenced_elsewhere,
        })
    textures.sort(key=lambda t: t["name"].lower())

    n_referenced = sum(1 for t in textures if t["ref_count"] > 0)
    n_orphaned   = len(textures) - n_referenced
    unreal.log(
        f"texture_explorer: Complete — {len(textures)} textures "
        f"({n_referenced} referenced [{len(referenced_elsewhere)} only outside "
        f"the forward-dep graph], {n_orphaned} confirmed orphaned), "
        f"{total_assets_checked} assets checked"
    )

    return {
        "total_textures": len(textures),
        "total_assets_checked": total_assets_checked,
        "textures": textures,
        "referenced_elsewhere": referenced_elsewhere,
        "orphan_reasons": confirmed,
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_texture_finder():
    """
    Open the Texture Explorer UI window.

    The window auto-loads all project textures on open and provides:
      - Live filter entry (no re-scan needed)
      - Project Only checkbox (default checked; scope change triggers re-scan)
      - Refresh button to re-scan the Asset Registry
      - Hierarchical results treeview:
          Level 1: Texture name with ref count (blue = referenced, red = orphan)
          Level 2: Referencing asset (green = Material/MIC, purple = NiagaraSystem)
      - Column headers: Name | Type | Refs | Path
      - Footer: referenced/orphaned counts | @thetrashbyrd link
      - Status bar: showing X of Y textures, assets checked
      - Tkinter event pump via unreal.register_slate_post_tick_callback
    """
    if not _HAS_TKINTER:
        unreal.log_error("texture_explorer: tkinter is not available in this environment.")
        return

    # ------------------------------------------------------------------
    # Root window
    # ------------------------------------------------------------------
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Texture Explorer")
    root.configure(bg=_BG)
    root.geometry("1100x640")
    root.minsize(800, 400)

    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path = os.path.join(_script_dir, "trashbyrd_40x40.png")
        if os.path.isfile(_logo_path):
            _logo_img = tk.PhotoImage(file=_logo_path, master=root)
    except Exception:
        pass

    # ------------------------------------------------------------------
    # Style
    # ------------------------------------------------------------------
    style = ttk.Style(root)
    style.theme_use("clam")

    style.configure("Dark.TFrame", background=_BG)
    style.configure("Section.TFrame", background=_SECTION_BG)

    style.configure(
        "Dark.TLabel",
        background=_BG,
        foreground=_TEXT_FG,
        font=("Segoe UI", 10),
    )
    style.configure(
        "Header.TLabel",
        background=_BG,
        foreground=_HEADER_FG,
        font=("Segoe UI", 13, "bold"),
    )
    style.configure(
        "Status.TLabel",
        background=_SECTION_BG,
        foreground=_TEXT_DIM,
        font=("Segoe UI", 9),
        padding=(8, 4),
    )
    style.configure(
        "Search.TButton",
        background=_ACCENT_BLUE,
        foreground="#1A1A1A",
        font=("Segoe UI", 10, "bold"),
        padding=(14, 6),
        relief="flat",
    )
    style.map("Search.TButton", background=[("active", "#D24E1F")])

    style.configure(
        "Treeview",
        background=_SECTION_BG,
        foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG,
        rowheight=22,
        font=("Consolas", 9),
    )
    style.configure(
        "Treeview.Heading",
        background=_BG,
        foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"),
        relief="flat",
    )
    style.map("Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    style.configure(
        "Dark.TCombobox",
        fieldbackground=_ENTRY_BG,
        background=_ENTRY_BG,
        foreground=_ENTRY_FG,
        selectbackground="#F6D9C9",
        selectforeground="#1A1A1A",
        arrowcolor=_ACCENT_BLUE,
    )
    style.map(
        "Dark.TCombobox",
        fieldbackground=[("readonly", _ENTRY_BG)],
        foreground=[("readonly", _ENTRY_FG)],
        selectbackground=[("readonly", "#F6D9C9")],
        selectforeground=[("readonly", "#1A1A1A")],
    )
    # Force the dropdown listbox colors (tk, not ttk)
    root.option_add("*TCombobox*Listbox.background", _ENTRY_BG)
    root.option_add("*TCombobox*Listbox.foreground", _ENTRY_FG)
    root.option_add("*TCombobox*Listbox.selectBackground", "#F6D9C9")
    root.option_add("*TCombobox*Listbox.selectForeground", "#1A1A1A")

    # ------------------------------------------------------------------
    # Top bar: Filter | Project Only checkbox | Refresh button
    # ------------------------------------------------------------------
    search_frame = ttk.Frame(root, style="Dark.TFrame", padding=(12, 10))
    search_frame.pack(fill="x", side="top")

    ttk.Label(search_frame, text="Trashbyrd's Texture Explorer", style="Header.TLabel").pack(
        side="left", padx=(0, 20)
    )

    ttk.Label(search_frame, text="Filter:", style="Dark.TLabel").pack(
        side="left", padx=(0, 6)
    )

    filter_entry = tk.Entry(
        search_frame,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief="flat",
        font=("Consolas", 10),
        width=36,
    )
    filter_entry.pack(side="left", padx=(0, 14), ipady=4)

    _project_only_state = [True]  # plain Python mutable — avoids tk.IntVar desync in UEFN
    project_only_check = tk.Checkbutton(
        search_frame,
        text="Project Only",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_BG,
        selectcolor=_ENTRY_BG,
        activebackground=_BG,
        activeforeground=_TEXT_FG,
    )
    project_only_check.select()  # default checked
    project_only_check.pack(side="left", padx=(0, 10))

    refresh_btn = ttk.Button(search_frame, text="Refresh", style="Search.TButton")
    refresh_btn.pack(side="left")

    # ------------------------------------------------------------------
    # Results treeview (two-level: Texture > Referencing asset)
    # Columns: Name (#0 tree) | Type | Refs | Path
    # ------------------------------------------------------------------
    tree_frame = ttk.Frame(root, style="Section.TFrame")
    tree_frame.pack(fill="both", expand=True, padx=10, pady=(4, 0))

    columns = ("type_col", "refs_col", "path_col")
    tree = ttk.Treeview(tree_frame, columns=columns, show="tree headings", selectmode="browse")

    tree.heading("#0",       text="Name")
    tree.heading("type_col", text="Type")
    tree.heading("refs_col", text="Refs")
    tree.heading("path_col", text="Path")

    tree.column("#0",       width=340, minwidth=200, stretch=True)
    tree.column("type_col", width=180, minwidth=80,  stretch=False)
    tree.column("refs_col", width=60,  minwidth=40,  stretch=False)
    tree.column("path_col", width=480, minwidth=200, stretch=True)

    # Row tags: level-1 texture rows
    tree.tag_configure("texture", foreground=_ACCENT_BLUE, font=("Consolas", 9, "bold"))
    tree.tag_configure("orphan",  foreground="#C0392B",    font=("Consolas", 9, "bold"))
    # Level-2 referencing asset rows
    tree.tag_configure("material", foreground=_ACCENT_GREEN, font=("Consolas", 9))
    tree.tag_configure("niagara",  foreground="#8E44AD",     font=("Consolas", 9))

    vsb = ttk.Scrollbar(tree_frame, orient="vertical",   command=tree.yview)
    hsb = ttk.Scrollbar(tree_frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

    vsb.pack(side="right",  fill="y")
    hsb.pack(side="bottom", fill="x")
    tree.pack(fill="both", expand=True)

    # ------------------------------------------------------------------
    # Footer
    # ------------------------------------------------------------------
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM)

    count_label_var = tk.StringVar(value="")
    count_label = tk.Label(
        footer_frame,
        textvariable=count_label_var,
        font=("Segoe UI", 8),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    )
    count_label.pack(side=tk.LEFT)

    social_label = tk.Label(
        footer_frame,
        text="@thetrashbyrd",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_SECTION_BG,
        cursor="hand2",
    )
    social_label.pack(side=tk.RIGHT)
    social_label.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    if _logo_img:
        footer_logo = tk.Label(footer_frame, image=_logo_img, bg=_SECTION_BG, cursor="hand2")
        footer_logo._img_ref = _logo_img
        footer_logo.pack(side=tk.RIGHT, padx=(4, 0))
        footer_logo.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # ------------------------------------------------------------------
    # Status bar (above footer)
    # ------------------------------------------------------------------
    status_var = tk.StringVar(value="Loading textures...")
    status_bar = ttk.Label(root, textvariable=status_var, style="Status.TLabel", anchor="w")
    status_bar.pack(fill="x", side="bottom", padx=0)

    # ------------------------------------------------------------------
    # Browse cache and filter logic
    # ------------------------------------------------------------------
    _browse_cache = [None]  # stores last browse_textures() result

    def _apply_filter():
        """Filter cached results by filter_entry text and repopulate tree."""
        result = _browse_cache[0]
        if result is None:
            return
        query = filter_entry.get().strip().lower()
        textures = result["textures"]
        if query:
            textures = [
                t for t in textures
                if query in t["name"].lower() or query in t["path"].lower()
            ]

        for row in tree.get_children():
            tree.delete(row)

        n_referenced = 0
        n_orphaned = 0
        for tex in textures:
            ref_count = tex["ref_count"]
            tag = "orphan" if ref_count == 0 else "texture"
            if ref_count == 0:
                n_orphaned += 1
            else:
                n_referenced += 1
            tex_id = tree.insert(
                "", "end",
                text=tex["name"],
                values=("Texture2D", ref_count, tex["path"]),
                tags=(tag,),
                open=False,
            )
            for ref in tex["references"]:
                ref_type = ref["type"]
                ref_tag = "niagara" if "niagara" in ref_type.lower() else "material"
                tree.insert(
                    tex_id, "end",
                    text=ref["name"],
                    values=(ref_type, "", ref["path"]),
                    tags=(ref_tag,),
                )

        total   = result["total_textures"]
        shown   = len(textures)
        checked = result["total_assets_checked"]
        status_var.set(f"Showing {shown} of {total} textures  [checked {checked} assets]")
        count_label_var.set(f"{n_referenced} referenced | {n_orphaned} orphaned")

    def _on_refresh():
        """Re-scan the Asset Registry and refresh the view."""
        refresh_btn.configure(text="Scanning...", state="disabled")
        status_var.set("Scanning Asset Registry...")
        root.update_idletasks()
        try:
            result = browse_textures(project_only=_project_only_state[0])
            _browse_cache[0] = result
            _apply_filter()
        except Exception as e:
            unreal.log_error(f"texture_explorer UI: scan failed — {traceback.format_exc()}")
            status_var.set(f"Error during scan: {e}")
        finally:
            refresh_btn.configure(text="Refresh", state="normal")

    def _on_project_only_toggle():
        _project_only_state[0] = not _project_only_state[0]
        _on_refresh()

    project_only_check.config(command=_on_project_only_toggle)
    refresh_btn.configure(command=_on_refresh)

    # Live filter on keystroke — no re-scan, just re-filter cached data
    filter_entry.bind("<KeyRelease>", lambda _e: _apply_filter())

    # Double-click → copy path to clipboard
    def _on_double_click(_event):
        item = tree.focus()
        if not item:
            return
        values = tree.item(item, "values")
        if not values or len(values) < 3:
            return
        asset_path = values[2]  # "Path" column (index 2: type, refs, path)
        if not asset_path:
            return
        root.clipboard_clear()
        root.clipboard_append(asset_path)
        status_var.set(f"Copied to clipboard: {asset_path}")
        unreal.log(f"texture_explorer: Copied to clipboard — {asset_path}")

    tree.bind("<Double-1>", _on_double_click)

    # ------------------------------------------------------------------
    # Tick callback for tkinter event pump
    # ------------------------------------------------------------------
    def _tick(_delta):
        try:
            if root.winfo_exists():
                root.update()
            else:
                _cleanup()
        except tk.TclError:
            _cleanup()
        except Exception:
            pass

    def _cleanup():
        if _tick_handle[0] is not None:
            try:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            except Exception:
                pass
            _tick_handle[0] = None

    def _on_close():
        _cleanup()
        try:
            root.destroy()
        except Exception:
            pass

    root.protocol("WM_DELETE_WINDOW", _on_close)

    _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)

    # Auto-load all textures on open
    _on_refresh()
    root.update()  # force initial render with stats populated

    unreal.log("texture_explorer: UI opened. Use show_texture_finder() to reopen if closed.")
