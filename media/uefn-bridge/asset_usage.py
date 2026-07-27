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

import glob
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
    SECONDARY fallback only (see load_verse_source_text): ask the live UEFN
    session for ``unreal.Paths.project_dir()``.

    DEMOTED from primary (was preferred in 0.0.418): in UEFN this API
    resolves to the EMBEDDED ENGINE's project — FortniteGame in the game
    install tree — NOT the user's island project, which is only a mounted
    plugin. Trusting it unconditionally scanned the game install and
    reported every real user asset as a ghost. So the result is now
    validated: only accepted if it exists on disk, contains a ``Content``
    subdirectory (matching the walkup fallback's contract), AND contains a
    ``*.uefnproject`` file (FortniteGame has a ``.uproject`` and never a
    ``.uefnproject``).

    Returns a normalized full path, or ``None`` so the caller falls through
    to the legacy walkup.
    """
    try:
        import unreal
        raw = unreal.Paths.project_dir()
        if not raw:
            return None
        full = os.path.normpath(unreal.Paths.convert_relative_path_to_full(raw))
        if not (os.path.isdir(full) and os.path.isdir(os.path.join(full, "Content"))):
            return None
        if not any(entry.endswith(".uefnproject") for entry in os.listdir(full)):
            return None
        return full
    except Exception:
        return None


def _walkup_project_root():
    """
    Candidate 1 (kept from 0.0.424): filesystem walkup anchored at
    ``__file__`` to the first ancestor containing a ``*.uefnproject`` file
    — the staged bridge scripts always live under that project's
    ``Content/Python/``, so this is authoritative regardless of what
    UEFN's embedded engine has open. Returns ``None`` if no
    ``.uefnproject`` is found within the bounded walkup.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidate = script_dir
    for _ in range(10):
        try:
            entries = os.listdir(candidate)
        except Exception:
            entries = []
        if any(entry.endswith(".uefnproject") for entry in entries):
            return candidate
        parent = os.path.dirname(candidate)
        if parent == candidate:
            break
        candidate = parent
    return None


def _get_island_sample_packages(project_prefix, limit=25):
    """
    Enumerate up to ``limit`` package names under ``project_prefix`` from
    the Asset Registry — used both as validation-gate samples and as the
    source packages for the asset-anchored candidate. Returns ``[]`` on any
    failure or when the prefix is unavailable; callers must treat that as
    "no samples available", not an error.
    """
    if not project_prefix:
        return []
    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        assets = registry.get_assets_by_path(project_prefix, recursive=True)
        return [str(a.package_name) for a in assets[:limit]]
    except Exception:
        return []


def _derive_content_root_from_asset_path(pkg, disk_path):
    """
    Given an island package path like ``/YourProject/Props/Anim/X`` and
    its real on-disk file (e.g.
    ``.../YourProject/Content/Props/Anim/X.uasset``), strip the
    package-relative tail to recover ``.../YourProject/Content``. Returns
    ``None`` if ``disk_path`` doesn't end with the expected tail.
    """
    if not pkg or not disk_path:
        return None
    parts = pkg.strip("/").split("/")
    if len(parts) < 2:
        return None
    rel_parts = parts[1:]  # drop the island-name segment
    ext = os.path.splitext(disk_path)[1] or ".uasset"
    tail = "/".join(rel_parts) + ext
    norm_disk = disk_path.replace("\\", "/")
    if not norm_disk.lower().endswith(tail.lower()):
        return None
    content_root = norm_disk[: -len(tail)].rstrip("/")
    return os.path.normpath(content_root) if content_root else None


def _resolve_project_root_via_asset_anchor(sample_pkgs):
    """
    Candidate 2 (NEW) — authoritative when running engine-side. Because
    UEFN copies the project's Content/Python into the embedded FortniteGame
    install and executes scripts FROM THERE, ``__file__`` anchoring can
    resolve into the install tree instead of the user's real project. This
    candidate instead asks Unreal directly where ONE island asset actually
    lives on disk and derives the project root from that real path.

    Tries, per sample package: (a)
    ``unreal.PackageName.long_package_name_to_filename``, then (b)
    ``unreal.load_asset``/``EditorAssetLibrary.load_asset`` +
    ``unreal.SystemLibrary.get_system_path`` — every API guarded with
    hasattr/getattr. Returns ``None`` if nothing resolves.
    """
    if not sample_pkgs:
        return None
    for pkg in sample_pkgs[:5]:
        pkg = str(pkg)
        disk_path = None

        try:
            package_name_cls = getattr(unreal, "PackageName", None)
            fn = getattr(package_name_cls, "long_package_name_to_filename", None)
            if fn is not None:
                disk_path = fn(pkg, ".uasset")
        except Exception:
            disk_path = None

        if not disk_path:
            try:
                asset = None
                loader = getattr(unreal, "load_asset", None)
                if loader is not None:
                    asset = loader(pkg)
                if asset is None:
                    eal = getattr(unreal, "EditorAssetLibrary", None)
                    if eal is not None and hasattr(eal, "load_asset"):
                        asset = eal.load_asset(pkg)
                if asset is not None:
                    sysapi = getattr(unreal, "SystemLibrary", None)
                    if sysapi is not None and hasattr(sysapi, "get_system_path"):
                        disk_path = sysapi.get_system_path(asset)
            except Exception:
                disk_path = None

        if not disk_path:
            continue

        try:
            if hasattr(unreal, "Paths"):
                disk_path = unreal.Paths.convert_relative_path_to_full(disk_path)
        except Exception:
            pass

        content_root = _derive_content_root_from_asset_path(pkg, disk_path)
        if content_root:
            project_root = os.path.dirname(content_root)
            if os.path.isdir(project_root):
                return project_root
    return None


def _default_location_project_roots(project_prefix):
    """
    Candidate 3 (NEW) — probe conventional UEFN project locations for a
    project named after the island prefix (``/YourProject/`` -> ``YourProject``):
    ``~/Documents/Fortnite Projects/<Name>``,
    ``~/OneDrive/Documents/Fortnite Projects/<Name>``, and any
    ``~/OneDrive*/Documents/Fortnite Projects/<Name>`` match (OneDrive can
    redirect Documents under a tenant-specific folder name). Only ever a
    starting guess — the validation gate still decides the winner.
    """
    if not project_prefix:
        return []
    project_name = project_prefix.strip("/")
    if not project_name:
        return []

    home = os.path.expanduser("~")
    probes = [
        os.path.join(home, "Documents", "Fortnite Projects", project_name),
        os.path.join(home, "OneDrive", "Documents", "Fortnite Projects", project_name),
    ]
    try:
        probes.extend(glob.glob(os.path.join(home, "OneDrive*", "Documents", "Fortnite Projects", project_name)))
    except Exception:
        pass

    results = []
    seen = set()
    for proj_dir in probes:
        norm = os.path.normpath(proj_dir)
        if norm in seen or not os.path.isdir(norm):
            continue
        seen.add(norm)
        try:
            has_uefnproject = any(entry.endswith(".uefnproject") for entry in os.listdir(norm))
        except Exception:
            has_uefnproject = False
        if has_uefnproject and os.path.isdir(os.path.join(norm, "Content")):
            results.append(norm)
    return results


def _validate_project_root(project_root, project_prefix, sample_pkgs):
    """
    VALIDATION GATE applied uniformly to every candidate. Stats up to 25
    island-prefix registry assets against ``<project_root>/Content``:
    passes as soon as one resolves to a real ``.uasset``/``.umap`` on disk
    (a wrong tree — e.g. the FortniteGame install — will match zero of
    them). Falls back to a lighter ``.uefnproject``-presence check on
    ``project_root`` itself when no registry samples are available.
    """
    if not project_root or not os.path.isdir(project_root):
        return False

    if sample_pkgs and project_prefix:
        content_dir = os.path.join(project_root, "Content")
        for pkg in sample_pkgs[:25]:
            pkg = str(pkg)
            if not pkg.startswith(project_prefix):
                continue
            relative = pkg[len(project_prefix):]
            if not relative:
                continue
            base_path = os.path.join(content_dir, *relative.split("/"))
            if os.path.isfile(base_path + ".uasset") or os.path.isfile(base_path + ".umap"):
                return True
        return False

    try:
        return any(entry.endswith(".uefnproject") for entry in os.listdir(project_root))
    except Exception:
        return False


def load_verse_source_text():
    """Concatenated, lowercased text of every .verse file under the project's
    root (walks the whole project, not just Content/, so devices/plugins are
    covered too). Cached per process. Used as a belt-and-suspenders check for
    assets referenced by name in Verse code rather than via a serialized
    hard/soft reference.

    ENGINE-COPY EXECUTION MODE: UEFN copies the project's Content/Python into
    the embedded engine install (.../FortniteGame/Content/Python/) and
    EXECUTES scripts from there, so plain __file__-anchored walkup alone is
    not reliably sufficient (see _resolve_unreal_project_dir_with_content).
    Every candidate below — including the walkup — is validated against real
    registry assets on disk before being trusted; if NONE validates, the
    Verse cross-reference check is simply treated as unavailable (empty
    text) rather than falling back to a legacy filesystem guess that could
    walk the install tree.
    """
    if _verse_text_cache[0] is not None:
        return _verse_text_cache[0]
    text = ""
    try:
        project_prefix = get_project_prefix()
        sample_pkgs = _get_island_sample_packages(project_prefix)

        candidates = []

        walkup = _walkup_project_root()
        if walkup:
            candidates.append(walkup)

        anchored = _resolve_project_root_via_asset_anchor(sample_pkgs)
        if anchored:
            candidates.append(anchored)

        candidates.extend(_default_location_project_roots(project_prefix))

        unreal_root = _resolve_unreal_project_dir_with_content()
        if unreal_root:
            candidates.append(unreal_root)

        content_root = None
        for cand in candidates:
            if _validate_project_root(cand, project_prefix, sample_pkgs):
                content_root = cand
                break

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
        else:
            unreal.log_warning(
                "asset_usage: Verse scan root could not be verified — "
                "Verse cross-reference check unavailable this run."
            )
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
