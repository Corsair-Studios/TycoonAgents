"""
UEFN Shared Asset-Usage / Orphan Confirmation
=============================================
Authoritative "is this asset truly unreferenced?" check shared by the material,
texture, and Niagara browsers. Uses the Asset Registry REVERSE reference graph
(get_referencers) across ALL asset types, plus a Verse source-text cross-check,
mirroring dependency_viewer.py's proven logic.

WHY THIS EXISTS: walking the currently-loaded level's actors only sees that ONE
level. It is blind to other levels/islands, devices' @editable asset references,
Verse scripts, material-instance parent materials, decals, UI, landscape, and
soft references. Flagging an asset "unused" from a level-walk alone can falsely
mark in-use assets as deletable. This module is the safety net: a candidate is
only confirmed orphaned when NOTHING anywhere references it.

Public API:
    confirm_orphans(candidate_paths, project_only=True, registry=None) -> dict
        {path: reason} for candidates with NO project references (registry
        referencers + Verse source text). Paths ABSENT from the result ARE
        referenced and must NOT be flagged as unused.
    get_referencer_details(pkg, project_only=True, registry=None) -> list[str]
        Project referencer package paths for one asset (for "who uses this").
"""

import os
import unreal

_SKIP_PREFIXES = ("/Engine/", "/Script/")
_VERSE_SKIP = {"Saved", "Intermediate", "__pycache__", ".uefn_bridge"}

# Per-process cache of the concatenated, lowercased Verse source text.
_verse_text_cache = [None]


def _set_dep_option(opts, names, value=True):
    """Set the first attribute name that exists on an options object. Defensive:
    UEFN's AssetRegistryDependencyOptions attribute names vary across builds."""
    for n in names:
        try:
            if hasattr(opts, n):
                setattr(opts, n, value)
                return True
        except Exception:
            pass
    return False


def _make_ref_options():
    """AssetRegistryDependencyOptions with hard+soft package references enabled.
    Works for both get_dependencies and get_referencers. Never crashes."""
    try:
        opts = unreal.AssetRegistryDependencyOptions()
        _set_dep_option(opts, ("include_hard_package_references", "include_hard_package_data"))
        _set_dep_option(opts, ("include_soft_package_references", "include_soft_package_data"))
        return opts
    except Exception as e:
        unreal.log_warning(f"asset_usage: could not configure ref options — {e}")
        try:
            return unreal.AssetRegistryDependencyOptions()
        except Exception:
            return None


def get_project_prefix():
    """Detect the current project's asset prefix (e.g. '/MyProject/'). Generic —
    derived from a level actor or the world path; never hard-codes a project."""
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actors = subsystem.get_all_level_actors()
        if actors:
            parts = actors[0].get_path_name().split("/")
            if len(parts) >= 2 and parts[1]:
                return "/" + parts[1] + "/"
    except Exception:
        pass
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        world = subsystem.get_world()
        if world:
            parts = world.get_path_name().split("/")
            if len(parts) >= 2 and parts[1]:
                return "/" + parts[1] + "/"
    except Exception:
        pass
    return "/Game/"


def _resolve_unreal_project_dir_with_content():
    """
    Best-effort: ask the live UEFN session for the authoritative project
    root via ``unreal.Paths.project_dir()``. This is correct even when this
    script FILE is executing from a copy of the bridge that lives outside
    the project (e.g. the Fortnite game install tree), because it asks
    Unreal for the currently open project rather than deriving a path from
    ``__file__``.

    Returns a normalized full path only if it exists on disk AND contains
    a ``Content`` subdirectory (matching the walkup fallback's contract);
    otherwise returns ``None`` so the caller falls through to the walkup.
    """
    try:
        import unreal
        raw = unreal.Paths.project_dir()
        if not raw:
            return None
        full = os.path.normpath(unreal.Paths.convert_relative_path_to_full(raw))
        if os.path.isdir(full) and os.path.isdir(os.path.join(full, "Content")):
            return full
        return None
    except Exception:
        return None


def load_verse_source_text():
    """Concatenated, lowercased text of every .verse file under the project's
    Content root (walks up from this script to find Content/). Cached per process.
    Used as a belt-and-suspenders check for assets referenced by name in Verse
    code rather than via a serialized hard/soft reference."""
    if _verse_text_cache[0] is not None:
        return _verse_text_cache[0]
    text = ""
    try:
        content_root = _resolve_unreal_project_dir_with_content()
        if not content_root:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            candidate = script_dir
            content_root = None
            for _ in range(10):
                if os.path.isdir(os.path.join(candidate, "Content")):
                    content_root = candidate
                    break
                parent = os.path.dirname(candidate)
                if parent == candidate:
                    break
                candidate = parent
        if content_root:
            chunks = []
            for dirpath, dirnames, filenames in os.walk(content_root):
                dirnames[:] = [d for d in dirnames if d not in _VERSE_SKIP and not d.startswith(".")]
                for fn in filenames:
                    if fn.endswith(".verse"):
                        try:
                            with open(os.path.join(dirpath, fn), "r", encoding="utf-8", errors="replace") as vf:
                                chunks.append(vf.read())
                        except Exception:
                            pass
            text = "\n".join(chunks).lower()
            unreal.log(f"asset_usage: Verse scan — {len(chunks)} .verse file(s)")
    except Exception as ve:
        unreal.log_warning(f"asset_usage: Verse scan failed — {ve}")
    _verse_text_cache[0] = text
    return text


def get_project_referencers(registry, pkg, ref_options, project_prefix, project_only=True):
    """Project-scoped reverse referencers for one package path (excludes self,
    /Engine, /Script). Returns a list of package-path strings."""
    try:
        refs = registry.get_referencers(pkg, ref_options)
    except Exception:
        return []
    if not refs:
        return []
    out = [str(r) for r in refs if not any(str(r).startswith(p) for p in _SKIP_PREFIXES)]
    if project_only and project_prefix:
        out = [r for r in out if r.startswith(project_prefix)]
    return [r for r in out if r != pkg]


def confirm_orphans(candidate_paths, project_only=True, registry=None):
    """Given candidate 'unused' package paths, return {path: reason} ONLY for
    those with no project references anywhere (registry referencers + Verse
    source text). Any candidate that IS referenced is omitted and must be kept."""
    result = {}
    if not candidate_paths:
        return result
    if registry is None:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    ref_options = _make_ref_options()
    project_prefix = get_project_prefix() if project_only else None
    verse_text = load_verse_source_text()
    for pkg in candidate_paths:
        pkg = str(pkg)
        if get_project_referencers(registry, pkg, ref_options, project_prefix, project_only):
            continue  # referenced — not an orphan
        short_name = pkg.rsplit("/", 1)[-1].lower()
        if short_name and verse_text and short_name in verse_text:
            continue  # name appears in Verse source — keep, don't flag
        result[pkg] = "no references found (registry + Verse scan)"
    return result


def get_referencer_details(pkg, project_only=True, registry=None):
    """Convenience: project referencer package paths for one asset."""
    if registry is None:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    ref_options = _make_ref_options()
    project_prefix = get_project_prefix() if project_only else None
    return get_project_referencers(registry, str(pkg), ref_options, project_prefix, project_only)
