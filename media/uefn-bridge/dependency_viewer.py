"""
UEFN Asset Dependency Viewer
=============================
Visualize dependency chains between project assets — what depends on what,
find orphaned assets, and identify heavy dependency chains.  Runs inside
UEFN's embedded Python 3.11 (requires the ``unreal`` module).

Provides two interfaces:
  1. **scan_dependencies()**      — Asset Registry scan; returns structured dict
  2. **show_dependency_viewer()** — Tkinter UI with hierarchical treeview,
                                    live filter, orphan highlight, sort, and
                                    interactive visual dependency graph

Usage:
    from dependency_viewer import scan_dependencies, show_dependency_viewer
"""

import glob
import os
import math
import subprocess
import unreal
import traceback
import webbrowser

try:
    import tkinter as tk
    from tkinter import ttk
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Theme constants (matching launcher / batch_tools / texture_finder palette)
# ---------------------------------------------------------------------------

_BG           = "#D2CEC4"
_SECTION_BG   = "#EBE7DD"
_HEADER_FG    = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE  = "#F15B29"
_TEXT_FG      = "#2B2B2B"
_TEXT_DIM     = "#57524C"
_ENTRY_BG     = "#FBFAF6"
_ENTRY_FG     = "#1A1A1A"
_GRAPH_BG     = "#E4E0D6"


# ---------------------------------------------------------------------------
# Clipboard — Tk's clipboard API (clipboard_clear/clipboard_append/
# clipboard_get/selection_own/selection_handle) is FORBIDDEN in this file.
# Tk's clipboard needs this window to own the system CLIPBOARD selection and
# then service selection-request events from ITS OWN Tk event loop, but this
# window is pumped by UEFN's register_slate_post_tick_callback instead of
# mainloop(), so nothing can service that request — Tcl/Tk aborts the whole
# host process (crash: ucrtbase -> python311 -> _tkinter -> tcl86t (x5) ->
# tk86t -> user32 ... Abort signal received). Use the helpers below instead.
# ---------------------------------------------------------------------------

def _copy_text_to_system_clipboard(text):
    """Best-effort OS clipboard copy that never touches Tk's clipboard API.
    Pipes `text` to the Windows `clip` utility via subprocess (which owns and
    services the clipboard in its own process). Returns True on success,
    False if unavailable/failed — never raises."""
    if os.name != "nt":
        return False
    try:
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE
        proc = subprocess.run(
            ["clip"], input=text.encode("utf-16-le"),
            startupinfo=startupinfo, creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=5,
        )
        return proc.returncode == 0
    except Exception:
        return False


def _show_copy_fallback_popup(root, text, title="Copy"):
    """No-clipboard-API fallback: a tiny Toplevel with `text` pre-selected in
    a single-line Entry so the user can press Ctrl+C themselves. Zero Tk
    clipboard calls — cannot reproduce the crash described above."""
    dlg = tk.Toplevel(root)
    dlg.title(title)
    dlg.configure(bg=_BG, padx=12, pady=12)
    tk.Label(
        dlg, text=(
            "Clipboard copy is unavailable here — the text below is "
            "pre-selected. Click inside it and press Ctrl+C to copy."
        ),
        font=("Segoe UI", 9, "bold"), fg=_HEADER_FG, bg=_BG,
        wraplength=460, justify=tk.LEFT,
    ).pack(fill=tk.X, pady=(0, 8))
    entry = tk.Entry(dlg, font=("Consolas", 9), width=64)
    entry.insert(0, text)
    entry.pack(fill=tk.X)
    entry.select_range(0, tk.END)
    entry.focus_set()
    tk.Button(
        dlg, text="Close", font=("Segoe UI", 9), bg=_SECTION_BG, fg=_TEXT_FG,
        relief="flat", padx=10, pady=4, command=dlg.destroy,
    ).pack(pady=(8, 0))


# UI state for the tick pump
_tick_handle = [None]

# Cached scan results reused by the live filter / sort (avoids re-scanning)
_last_scan_result = [None]

# Prefixes to always skip
_SKIP_PREFIXES = ("/Engine/", "/Script/")

# Asset classes to scan and their UE module paths
_ASSET_CLASSES = [
    ("Texture2D",                "/Script/Engine"),
    ("Material",                 "/Script/Engine"),
    ("MaterialInstanceConstant", "/Script/Engine"),
    ("NiagaraSystem",            "/Script/Niagara"),
    ("StaticMesh",               "/Script/Engine"),
    ("SkeletalMesh",             "/Script/Engine"),
]

# Node type colours
_NODE_COLORS = {
    "Texture2D":                "#F15B29",
    "Material":                 "#2F8F3E",
    "MaterialInstanceConstant": "#2F8F3E",
    "NiagaraSystem":            "#8E44AD",
    "StaticMesh":               "#B8860B",
    "SkeletalMesh":             "#B8860B",
}
_NODE_DEFAULT_COLOR = "#6B6B6B"

# Max nodes displayed per side in graph (deps / refs)
_MAX_SIDE_NODES = 15


# ---------------------------------------------------------------------------
# Defensive AssetRegistryDependencyOptions helper
# ---------------------------------------------------------------------------

def _set_dep_option(opts, names, value=True):
    """
    Try to set a boolean attribute on an AssetRegistryDependencyOptions object,
    working through the supplied name list (most-preferred first).

    Returns True if at least one name was accepted; False if none matched.
    Either way the scan continues — the object is valid with default flags.
    """
    for n in names:
        try:
            if hasattr(opts, n):
                setattr(opts, n, value)
                return True
        except Exception:
            pass
    return False


def _make_dep_options():
    """
    Build an AssetRegistryDependencyOptions with hard+soft package references
    enabled.  If the attribute names differ between UE versions, fall back
    gracefully to the default options so the scan never crashes.
    """
    try:
        opts = unreal.AssetRegistryDependencyOptions()
        _set_dep_option(opts, ("include_hard_package_references", "include_hard_package_data"))
        _set_dep_option(opts, ("include_soft_package_references", "include_soft_package_data"))
        return opts
    except Exception as e:
        unreal.log_warning(f"dependency_viewer: Could not configure dep options — {e}. Using defaults.")
        try:
            return unreal.AssetRegistryDependencyOptions()
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Project prefix detection
# ---------------------------------------------------------------------------

def _get_project_prefix():
    """
    Detect the current UEFN project's asset prefix (e.g. ``/MyProject/``).

    Strategy 1 — derive the prefix from the first level actor's full path.
    Strategy 2 — fall back to the world's own path.
    Strategy 3 — last-resort default ``/Game/``.
    """
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actors = subsystem.get_all_level_actors()
        if actors:
            path = actors[0].get_path_name()
            parts = path.split("/")
            if len(parts) >= 2 and parts[1]:
                prefix = "/" + parts[1] + "/"
                unreal.log(f"dependency_viewer: Detected project prefix from actor path: {prefix}")
                return prefix
    except Exception as e:
        unreal.log_warning(f"dependency_viewer: Actor path detection (strategy 1) failed — {e}")

    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        world = subsystem.get_world()
        if world:
            world_path = world.get_path_name()
            unreal.log(f"dependency_viewer: World path = {world_path}")
            parts = world_path.split("/")
            if len(parts) >= 2 and parts[1]:
                prefix = "/" + parts[1] + "/"
                unreal.log(f"dependency_viewer: Detected project prefix from world: {prefix}")
                return prefix
    except Exception as e:
        unreal.log_warning(f"dependency_viewer: Actor path detection (strategy 2) failed — {e}")

    unreal.log_warning("dependency_viewer: Could not detect project prefix, defaulting to /Game/")
    return "/Game/"


def _asset_type_label(class_path_str):
    """
    Infer a human-readable asset type label from a class path string.
    """
    s = str(class_path_str).lower()
    if "texture2d" in s:
        return "Texture2D"
    if "materialinstanceconstant" in s:
        return "MaterialInstanceConstant"
    if "material" in s:
        return "Material"
    if "niagara" in s:
        return "NiagaraSystem"
    if "skeletalmesh" in s:
        return "SkeletalMesh"
    if "staticmesh" in s:
        return "StaticMesh"
    # Last resort: take the last segment after '.'
    if "." in s:
        return str(class_path_str).split(".")[-1]
    return str(class_path_str)


def _resolve_unreal_project_dir_with_content():
    """
    SECONDARY fallback only (see the Verse-scan step below): ask the live
    UEFN session for ``unreal.Paths.project_dir()``.

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


# ---------------------------------------------------------------------------
# Verse scan-root resolution chain
#
# ENGINE-COPY EXECUTION MODE: UEFN copies the project's Content/Python into
# the embedded engine install (.../FortniteGame/Content/Python/) and
# EXECUTES scripts from there, so plain __file__-anchored walkup alone is
# not reliably sufficient (see _resolve_unreal_project_dir_with_content
# above). Every candidate tried by scan_dependencies()'s Verse-scan step —
# including the walkup — is validated against real registry assets on disk
# before being trusted; if NONE validates, the Verse cross-reference check
# is treated as unavailable rather than falling back to a legacy filesystem
# guess that could walk the install tree.
# ---------------------------------------------------------------------------

def _walkup_project_root():
    """
    Candidate 1 (kept from 0.0.424): filesystem walkup anchored at
    ``__file__`` to the first ancestor containing a ``*.uefnproject`` file.
    Returns ``None`` if no ``.uefnproject`` is found within the bounded
    walkup.
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


def _derive_content_root_from_asset_path(pkg, disk_path):
    """
    Given an island package path like ``/YourProject/ArudoStuff/Anim/X`` and
    its real on-disk file (e.g.
    ``.../YourProject/Content/ArudoStuff/Anim/X.uasset``), strip the
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
    Candidate 2 (NEW) — authoritative when running engine-side. Asks
    Unreal directly where ONE already-enumerated island asset (reused from
    the class-based scan in scan_dependencies(), NOT a fresh query) lives
    on disk, and derives the project root from that real path — it cannot
    be fooled by where the running .py file happens to be staged.

    Tries, per sample package: (a)
    ``unreal.PackageName.long_package_name_to_filename``, then (b)
    ``unreal.load_asset``/``EditorAssetLibrary.load_asset`` +
    ``unreal.SystemLibrary.get_system_path`` — every API guarded with
    hasattr/getattr. Returns ``None`` if nothing resolves (including when
    ``sample_pkgs`` is empty — nothing has been enumerated yet).
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


# ---------------------------------------------------------------------------
# Core scan function
# ---------------------------------------------------------------------------

def scan_dependencies(project_only=True):
    """
    Scan the Asset Registry to build a full dependency graph for project assets.

    For each asset, ``get_dependencies()`` is called to learn what it depends
    on (outgoing edges).  The reverse map (incoming / referencers) is derived
    from the forward map.

    Asset classes scanned: Texture2D, Material, MaterialInstanceConstant,
    NiagaraSystem, StaticMesh, SkeletalMesh.

    Parameters
    ----------
    project_only : bool
        When True (default) only assets whose package_name starts with the
        detected project prefix are included.

    Returns
    -------
    dict::

        {
            "total_assets": int,
            "assets": [
                {
                    "name":         str,
                    "path":         str,   # package path
                    "type":         str,   # "Texture2D", "Material", …
                    "dep_count":    int,   # outgoing — what this asset uses
                    "ref_count":    int,   # incoming — what uses this asset
                    "dependencies": [{"name": str, "path": str, "type": str}, …],
                    "referencers":  [{"name": str, "path": str, "type": str}, …],
                },
                …
            ],
            "orphan_count": int,
            "orphans":      [str, …],   # package paths of orphaned assets
        }

    The ``assets`` list is sorted by ``ref_count`` descending (most-referenced
    first).
    """
    registry = unreal.AssetRegistryHelpers.get_asset_registry()

    # Fix (a): explicit hard+soft dependency flags so level→asset and
    # material→texture references are both captured.  _make_dep_options()
    # tries the correct UE5 attribute names first, then the old _data names,
    # and falls back to default options if neither exists — scan never crashes.
    dep_options = _make_dep_options()
    # Same options for the reverse-referencer check used later.
    ref_options = _make_dep_options()

    project_prefix = _get_project_prefix() if project_only else None
    unreal.log(
        f"dependency_viewer: Starting scan "
        f"(project_only={project_only}, prefix={project_prefix})"
    )

    # ------------------------------------------------------------------
    # Step 1 — collect all assets of the target classes
    # ------------------------------------------------------------------
    # path_str -> {"name": str, "type": str}
    all_assets_info = {}

    # Fix (b): also enumerate World/Level packages so that actors placed
    # in a level can contribute to the reverse-reference map.
    # We track level packages separately — they are *referencers*, not
    # orphan candidates themselves.
    _level_packages = set()

    scan_classes = list(_ASSET_CLASSES) + [("World", "/Script/Engine")]

    for cls_name, module in scan_classes:
        try:
            class_path = unreal.TopLevelAssetPath(module, cls_name)
            assets = registry.get_assets_by_class(class_path)
        except Exception as e:
            unreal.log_warning(f"dependency_viewer: Could not fetch {cls_name} — {e}")
            continue

        count_before = len(all_assets_info)
        for asset_data in assets:
            pkg = str(asset_data.package_name)   # Name → str
            if any(pkg.startswith(p) for p in _SKIP_PREFIXES):
                continue
            if project_only and not pkg.startswith(project_prefix):
                continue
            if cls_name == "World":
                _level_packages.add(pkg)
                # Register level in the info map so it can appear in
                # reverse_map, but mark it so it won't be an orphan candidate.
                if pkg not in all_assets_info:
                    all_assets_info[pkg] = {
                        "name": str(asset_data.asset_name),
                        "type": "World",
                    }
            else:
                if pkg not in all_assets_info:
                    all_assets_info[pkg] = {
                        "name": str(asset_data.asset_name),
                        "type": _asset_type_label(asset_data.asset_class_path),
                    }

        added = len(all_assets_info) - count_before
        unreal.log(f"dependency_viewer: {added} {cls_name} asset(s) added (total so far: {len(all_assets_info)})")

    # Also do a broad recursive path scan to catch maps the class query may miss.
    if project_only and project_prefix:
        try:
            broad_assets = registry.get_assets_by_path(project_prefix, recursive=True)
            for asset_data in broad_assets:
                pkg = str(asset_data.package_name)
                cls_str = str(asset_data.asset_class_path).lower()
                if "world" in cls_str and pkg not in all_assets_info:
                    _level_packages.add(pkg)
                    all_assets_info[pkg] = {
                        "name": str(asset_data.asset_name),
                        "type": "World",
                    }
        except Exception as e:
            unreal.log_warning(f"dependency_viewer: Broad path scan failed — {e}")

    total = len(all_assets_info)
    unreal.log(f"dependency_viewer: {total} project asset(s) in scope — building dependency graph…")

    # ------------------------------------------------------------------
    # Step 1b — collect Verse source text for cross-reference checking.
    # Location-independent, self-validating scan-root resolution: try the
    # .uefnproject walkup, an unreal-API asset anchor (reusing island
    # packages already enumerated in Step 1 above — all_assets_info — NOT
    # a fresh registry query), default project-location guesses, and the
    # legacy validated unreal.Paths resolver, in that order; each candidate
    # is validated against real registry assets on disk before being
    # trusted (see _validate_project_root and the module-level chain
    # helpers above _resolve_unreal_project_dir_with_content). If NONE
    # validates, the Verse cross-reference check is treated as unavailable
    # rather than falling back to a legacy filesystem guess that could walk
    # the FortniteGame install tree.
    # ------------------------------------------------------------------
    _verse_source_text = ""
    _VERSE_SKIP = {"Saved", "Intermediate", "__pycache__", ".uefn_bridge"}
    try:
        sample_pkgs = list(all_assets_info.keys())

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
            verse_chunks = []
            for dirpath, dirnames, filenames in os.walk(content_root):
                dirnames[:] = [d for d in dirnames if d not in _VERSE_SKIP and not d.startswith(".")]
                for fn in filenames:
                    if fn.endswith(".verse"):
                        try:
                            with open(os.path.join(dirpath, fn), "r", encoding="utf-8", errors="replace") as vf:
                                verse_chunks.append(vf.read())
                        except Exception:
                            pass
            _verse_source_text = "\n".join(verse_chunks)
            unreal.log(f"dependency_viewer: Verse scan — {len(verse_chunks)} .verse file(s) found")
        else:
            unreal.log_warning(
                "dependency_viewer: Verse scan root could not be verified — "
                "Verse cross-reference check unavailable this run."
            )
    except Exception as ve:
        unreal.log_warning(f"dependency_viewer: Verse scan failed — {ve}")

    # ------------------------------------------------------------------
    # Step 2 — for each asset, call get_dependencies() and filter to
    #          project assets only
    # ------------------------------------------------------------------
    # forward_map:  path_str -> [dep_path_str, …]   (what it depends ON)
    # reverse_map:  path_str -> [ref_path_str, …]   (what depends ON it)
    forward_map = {p: [] for p in all_assets_info}
    reverse_map = {p: [] for p in all_assets_info}

    asset_paths = list(all_assets_info.keys())

    for idx, pkg in enumerate(asset_paths):
        if idx > 0 and idx % 100 == 0:
            unreal.log(f"dependency_viewer: Progress — {idx}/{total} assets processed…")

        try:
            deps = registry.get_dependencies(pkg, dep_options)
        except Exception:
            continue

        if deps is None:
            continue

        for dep in deps:
            dep_str = str(dep)   # Name → str
            # Only include deps that are themselves in the project asset set
            if dep_str in all_assets_info:
                forward_map[pkg].append(dep_str)
                reverse_map[dep_str].append(pkg)

    # ------------------------------------------------------------------
    # Step 3 — build the output structure
    # ------------------------------------------------------------------
    assets_list = []
    orphans = []

    # Non-level assets that have zero refs from the reverse map
    orphan_candidates = [
        pkg for pkg, info in all_assets_info.items()
        if len(reverse_map[pkg]) == 0 and pkg not in _level_packages
    ]

    # Fix (c): per-candidate double-check via get_referencers so assets
    # referenced outside the enumerated class set are not falsely flagged.
    confirmed_orphans = set()
    verse_referenced = set()
    for pkg in orphan_candidates:
        # Registry-wide referencer check (any type)
        has_referencer = False
        try:
            refs = registry.get_referencers(pkg, ref_options)
            if refs:
                project_refs = [str(r) for r in refs if not any(str(r).startswith(p) for p in _SKIP_PREFIXES)]
                if project_only:
                    project_refs = [r for r in project_refs if r.startswith(project_prefix)]
                has_referencer = bool(project_refs)
        except Exception:
            pass

        if has_referencer:
            # Update reverse_map so the UI ref count reflects reality
            for r in project_refs:
                if r not in reverse_map[pkg]:
                    reverse_map[pkg].append(r)
            continue

        # Fix (d): Verse cross-reference check
        short_name = pkg.rsplit("/", 1)[-1]   # package basename
        if short_name and _verse_source_text and short_name in _verse_source_text:
            verse_referenced.add(pkg)
            continue

        confirmed_orphans.add(pkg)

    for pkg, info in all_assets_info.items():
        # Levels are never reported as orphan candidates
        if pkg in _level_packages:
            continue

        deps_paths = forward_map[pkg]
        refs_paths = reverse_map[pkg]

        dep_entries = [
            {
                "name": all_assets_info[d]["name"],
                "path": d,
                "type": all_assets_info[d]["type"],
            }
            for d in deps_paths
            if d in all_assets_info
        ]
        ref_entries = [
            {
                "name": all_assets_info[r]["name"] if r in all_assets_info else r.rsplit("/", 1)[-1],
                "path": r,
                "type": all_assets_info[r]["type"] if r in all_assets_info else "Unknown",
            }
            for r in refs_paths
        ]

        ref_count = len(ref_entries)
        # Fix (e): honest label — only mark confirmed orphans
        is_orphan = pkg in confirmed_orphans
        is_verse_ref = pkg in verse_referenced

        assets_list.append({
            "name":         info["name"],
            "path":         pkg,
            "type":         info["type"],
            "dep_count":    len(dep_entries),
            "ref_count":    ref_count,
            "dependencies": dep_entries,
            "referencers":  ref_entries,
            # Extra metadata for the UI
            "orphan_status": (
                "referenced in Verse" if is_verse_ref
                else "no references found (registry + level + Verse scan)" if is_orphan
                else ""
            ),
        })

    orphans = [a["path"] for a in assets_list if a["orphan_status"].startswith("no references")]

    # Sort by ref_count descending (most-referenced first)
    assets_list.sort(key=lambda a: a["ref_count"], reverse=True)

    unreal.log(
        f"dependency_viewer: Scan complete — "
        f"{total} assets, {len(orphans)} confirmed orphans, "
        f"{len(verse_referenced)} Verse-referenced"
    )

    return {
        "total_assets":  total,
        "assets":        assets_list,
        "orphan_count":  len(orphans),
        "orphans":       orphans,
    }


# ---------------------------------------------------------------------------
# Graph drawing helpers
# ---------------------------------------------------------------------------

def _node_color(asset_type):
    return _NODE_COLORS.get(asset_type, _NODE_DEFAULT_COLOR)


def _draw_node(canvas, x, y, name, asset_type, is_center=False, tag=""):
    """Draw a coloured rectangle node with text labels at (x, y).

    Returns (rect_id, name_txt_id, type_txt_id).
    """
    fill   = _node_color(asset_type)
    border = "#1A1A1A" if is_center else "#1A1A1A"
    width  = 3 if is_center else 1

    display = name[:25] + "…" if len(name) > 25 else name

    w, h = 160, 44

    rect = canvas.create_rectangle(
        x - w // 2, y - h // 2, x + w // 2, y + h // 2,
        fill=fill, outline=border, width=width,
        tags=(tag, "node"),
    )
    txt = canvas.create_text(
        x, y - 7,
        text=display,
        fill="#1A1A1A",
        font=("Segoe UI", 8, "bold"),
        tags=(tag, "node"),
    )
    type_txt = canvas.create_text(
        x, y + 9,
        text=asset_type,
        fill="#1A1A1A",
        font=("Segoe UI", 7),
        tags=(tag, "node"),
    )
    return rect, txt, type_txt


def _radial_positions(cx, cy, count, radius, start_angle_deg, spread_deg):
    """Return list of (x, y) positions arranged in an arc."""
    if count == 0:
        return []
    if count == 1:
        mid = math.radians(start_angle_deg)
        return [(cx + radius * math.cos(mid), cy + radius * math.sin(mid))]
    positions = []
    half = spread_deg / 2
    for i in range(count):
        frac = i / (count - 1) if count > 1 else 0.5
        angle_deg = start_angle_deg - half + frac * spread_deg
        angle = math.radians(angle_deg)
        positions.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return positions


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_dependency_viewer():
    """
    Open the Asset Dependency Viewer UI window.

    Layout
    ------
    - Top bar: search filter, type dropdown, "Show Orphans Only" checkbox,
      Refresh button.
    - PanedWindow split (horizontal):
        Left  (~30%) — asset treeview with scrollbars
        Right (~70%) — interactive Canvas dependency graph
    - Status bar: asset counts and orphan count.
    - Footer: @thetrashbyrd link + logo.

    Graph interactions
    ------------------
    - Click asset in treeview  → draw neighbourhood graph
    - Click node in graph      → re-centre graph on that asset + select in list
    - Mouse wheel              → zoom in / out
    - Right-click drag         → pan
    - Hover over node          → tooltip with full path
    """
    if not _HAS_TKINTER:
        unreal.log_error("dependency_viewer: tkinter is not available in this environment.")
        return

    # ------------------------------------------------------------------
    # Root window
    # ------------------------------------------------------------------
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Dependency Viewer")
    root.configure(bg=_BG)
    root.geometry("1400x760")
    root.minsize(1000, 520)

    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path  = os.path.join(_script_dir, "trashbyrd_40x40.png")
        if os.path.isfile(_logo_path):
            _logo_img = tk.PhotoImage(file=_logo_path, master=root)
    except Exception:
        pass

    # ------------------------------------------------------------------
    # Style
    # ------------------------------------------------------------------
    style = ttk.Style(root)
    style.theme_use("clam")

    style.configure("Dark.TFrame",    background=_BG)
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
        "Accent.TButton",
        background=_ACCENT_BLUE,
        foreground="#1A1A1A",
        font=("Segoe UI", 10, "bold"),
        padding=(14, 6),
        relief="flat",
    )
    style.map("Accent.TButton", background=[("active", "#D24E1F")])

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
    root.option_add("*TCombobox*Listbox.background",      _ENTRY_BG)
    root.option_add("*TCombobox*Listbox.foreground",      _ENTRY_FG)
    root.option_add("*TCombobox*Listbox.selectBackground", "#F6D9C9")
    root.option_add("*TCombobox*Listbox.selectForeground", "#1A1A1A")

    # ------------------------------------------------------------------
    # Top bar
    # ------------------------------------------------------------------
    top_frame = ttk.Frame(root, style="Dark.TFrame", padding=(12, 10))
    top_frame.pack(fill="x", side="top")

    ttk.Label(top_frame, text="Asset Dependency Viewer", style="Header.TLabel").pack(
        side="left", padx=(0, 20)
    )

    ttk.Label(top_frame, text="Filter:", style="Dark.TLabel").pack(side="left", padx=(0, 4))

    filter_entry = tk.Entry(
        top_frame,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief="flat",
        font=("Consolas", 10),
        width=28,
    )
    filter_entry.pack(side="left", padx=(0, 10), ipady=4)

    ttk.Label(top_frame, text="Type:", style="Dark.TLabel").pack(side="left", padx=(0, 4))

    type_combo = ttk.Combobox(
        top_frame,
        values=[
            "All",
            "Texture2D",
            "Material",
            "MaterialInstanceConstant",
            "NiagaraSystem",
            "StaticMesh",
            "SkeletalMesh",
        ],
        state="readonly",
        width=24,
        style="Dark.TCombobox",
        font=("Segoe UI", 10),
    )
    type_combo.set("All")
    type_combo.pack(side="left", padx=(0, 14))

    _show_orphans_state = [False]  # plain Python mutable — avoids tk.IntVar desync in UEFN
    orphans_check = tk.Checkbutton(
        top_frame,
        text="Show Orphans Only",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_BG,
        selectcolor=_ENTRY_BG,
        activebackground=_BG,
        activeforeground=_TEXT_FG,
    )
    orphans_check.pack(side="left", padx=(0, 14))

    refresh_btn = ttk.Button(top_frame, text="Refresh", style="Accent.TButton")
    refresh_btn.pack(side="left")

    # ------------------------------------------------------------------
    # Footer
    # ------------------------------------------------------------------
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill="x", side="bottom")

    social_label = tk.Label(
        footer_frame,
        text="by @thetrashbyrd",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_SECTION_BG,
        cursor="hand2",
    )
    social_label.pack(side="right")
    social_label.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    if _logo_img:
        footer_logo = tk.Label(footer_frame, image=_logo_img, bg=_SECTION_BG, cursor="hand2")
        footer_logo._img_ref = _logo_img
        footer_logo.pack(side="right", padx=(4, 0))
        footer_logo.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    count_var = tk.StringVar(value="")
    count_label = tk.Label(
        footer_frame,
        textvariable=count_var,
        font=("Segoe UI", 8),
        fg=_TEXT_DIM,
        bg=_SECTION_BG,
    )
    count_label.pack(side="left")

    # ------------------------------------------------------------------
    # Status bar (above footer)
    # ------------------------------------------------------------------
    status_var = tk.StringVar(value="Click Refresh to scan project assets.")
    status_bar = ttk.Label(root, textvariable=status_var, style="Status.TLabel", anchor="w")
    status_bar.pack(fill="x", side="bottom", padx=0)

    # ------------------------------------------------------------------
    # Main area — PanedWindow (left: list, right: graph)
    # ------------------------------------------------------------------
    paned = tk.PanedWindow(
        root,
        orient=tk.HORIZONTAL,
        bg=_BG,
        sashwidth=6,
        sashrelief="flat",
        sashpad=2,
    )
    paned.pack(fill="both", expand=True, padx=10, pady=(4, 0))

    # ---- Left panel: treeview ----
    left_frame = ttk.Frame(paned, style="Section.TFrame")

    columns = ("type_col", "deps_col", "refs_col", "path_col")
    tree = ttk.Treeview(
        left_frame,
        columns=columns,
        show="tree headings",
        selectmode="browse",
    )

    tree.heading("#0",       text="Name")
    tree.heading("type_col", text="Type")
    tree.heading("deps_col", text="Deps")
    tree.heading("refs_col", text="Refs")
    tree.heading("path_col", text="Path")

    tree.column("#0",       width=200, minwidth=120, stretch=True)
    tree.column("type_col", width=160, minwidth=60,  stretch=False)
    tree.column("deps_col", width=48,  minwidth=36,  stretch=False)
    tree.column("refs_col", width=48,  minwidth=36,  stretch=False)
    tree.column("path_col", width=280, minwidth=120, stretch=True)

    tree.tag_configure("asset",      foreground=_TEXT_FG,     font=("Consolas", 9))
    tree.tag_configure("orphan",     foreground="#C0392B",     font=("Consolas", 9, "bold"))
    tree.tag_configure("dependency", foreground=_TEXT_DIM,     font=("Consolas", 9))
    tree.tag_configure("referencer", foreground=_ACCENT_GREEN, font=("Consolas", 9))

    vsb_tree = ttk.Scrollbar(left_frame, orient="vertical",   command=tree.yview)
    hsb_tree = ttk.Scrollbar(left_frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vsb_tree.set, xscrollcommand=hsb_tree.set)

    vsb_tree.pack(side="right",  fill="y")
    hsb_tree.pack(side="bottom", fill="x")
    tree.pack(fill="both", expand=True)

    paned.add(left_frame, minsize=240, width=380)

    # ---- Right panel: graph canvas ----
    right_frame = ttk.Frame(paned, style="Dark.TFrame")

    graph_label = tk.Label(
        right_frame,
        text="Select an asset to view its dependency graph",
        font=("Segoe UI", 10),
        fg=_TEXT_DIM,
        bg=_GRAPH_BG,
    )
    graph_label.pack(fill="x", pady=(0, 0))

    graph_canvas = tk.Canvas(
        right_frame,
        bg=_GRAPH_BG,
        highlightthickness=0,
    )
    graph_canvas.pack(fill="both", expand=True)

    paned.add(right_frame, minsize=400)

    # ------------------------------------------------------------------
    # Graph state
    # ------------------------------------------------------------------
    # path -> asset dict (populated after each scan)
    _path_to_asset = {}
    # Currently displayed asset path
    _current_graph_path = [None]

    # ------------------------------------------------------------------
    # Tooltip
    # ------------------------------------------------------------------
    _tooltip_win = [None]

    def _show_tooltip(text, x_root, y_root):
        _hide_tooltip()
        tw = tk.Toplevel(root)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f"+{x_root + 14}+{y_root + 14}")
        lbl = tk.Label(
            tw,
            text=text,
            font=("Segoe UI", 8),
            bg="#EBE7DD",
            fg=_ENTRY_FG,
            relief="solid",
            borderwidth=1,
            padx=6,
            pady=3,
            wraplength=500,
            justify="left",
        )
        lbl.pack()
        _tooltip_win[0] = tw

    def _hide_tooltip():
        if _tooltip_win[0] is not None:
            try:
                _tooltip_win[0].destroy()
            except Exception:
                pass
            _tooltip_win[0] = None

    # ------------------------------------------------------------------
    # Graph drawing
    # ------------------------------------------------------------------
    def _draw_graph(asset_path):
        """Clear canvas and draw the dependency neighbourhood for asset_path."""
        _current_graph_path[0] = asset_path
        graph_canvas.delete("all")

        asset = _path_to_asset.get(asset_path)
        if asset is None:
            graph_canvas.create_text(
                400, 300,
                text="Asset not found in scan results.",
                fill=_TEXT_DIM,
                font=("Segoe UI", 10),
            )
            return

        # Update hint label
        graph_label.config(
            text=f"Graph: {asset['name']}  ({asset['type']})   "
                 f"  deps: {asset['dep_count']}   refs: {asset['ref_count']}"
        )

        cw = graph_canvas.winfo_width()  or 800
        ch = graph_canvas.winfo_height() or 500
        cx, cy = cw // 2, ch // 2

        deps = asset["dependencies"][:_MAX_SIDE_NODES]
        refs = asset["referencers"][:_MAX_SIDE_NODES]
        extra_deps = asset["dep_count"]  - len(deps)
        extra_refs = asset["ref_count"]  - len(refs)

        radius = max(180, min(280, max(len(deps), len(refs)) * 36 + 120))

        dep_positions = _radial_positions(cx, cy, len(deps), radius,   0, 140)
        ref_positions = _radial_positions(cx, cy, len(refs), radius, 180, 140)

        # Draw edges first (so they appear under nodes)
        for (dx, dy) in dep_positions:
            graph_canvas.create_line(
                cx, cy, dx, dy,
                fill=_ACCENT_BLUE, width=1,
                arrow=tk.LAST, arrowshape=(10, 12, 4),
                smooth=True,
            )

        for (rx, ry) in ref_positions:
            graph_canvas.create_line(
                rx, ry, cx, cy,
                fill=_ACCENT_GREEN, width=1,
                arrow=tk.LAST, arrowshape=(10, 12, 4),
                smooth=True,
            )

        # Draw dependency nodes
        for idx, (dep, (dx, dy)) in enumerate(zip(deps, dep_positions)):
            tag = f"dep_{idx}"
            _draw_node(graph_canvas, dx, dy, dep["name"], dep["type"], tag=tag)
            _bind_node_events(tag, dep["path"], dep["name"])

        # Draw referencer nodes
        for idx, (ref, (rx, ry)) in enumerate(zip(refs, ref_positions)):
            tag = f"ref_{idx}"
            _draw_node(graph_canvas, rx, ry, ref["name"], ref["type"], tag=tag)
            _bind_node_events(tag, ref["path"], ref["name"])

        # Draw center node last (on top)
        _draw_node(graph_canvas, cx, cy, asset["name"], asset["type"], is_center=True, tag="center")
        _bind_node_events("center", asset_path, asset["name"])

        # Legend
        _draw_legend(graph_canvas)

        # "… and N more" overflow labels
        if extra_deps > 0:
            graph_canvas.create_text(
                cx + radius + 60, cy,
                text=f"… and {extra_deps} more deps",
                fill=_ACCENT_BLUE,
                font=("Segoe UI", 8),
            )
        if extra_refs > 0:
            graph_canvas.create_text(
                cx - radius - 60, cy,
                text=f"… and {extra_refs} more refs",
                fill=_ACCENT_GREEN,
                font=("Segoe UI", 8),
            )

        # Extend scroll region to cover full layout
        sr = max(cw, cx + radius + 200)
        graph_canvas.config(scrollregion=(-sr, -ch, sr * 2, ch * 2))

    def _draw_legend(canvas):
        """Draw a small colour legend in the top-left corner of the canvas."""
        items = [
            ("→ Dependencies", _ACCENT_BLUE),
            ("← Referencers",  _ACCENT_GREEN),
        ]
        x0, y0 = 14, 14
        for i, (label, color) in enumerate(items):
            y = y0 + i * 18
            canvas.create_rectangle(x0, y, x0 + 14, y + 12, fill=color, outline="")
            canvas.create_text(x0 + 20, y + 6, text=label, fill=_TEXT_DIM,
                               font=("Segoe UI", 8), anchor="w")

    def _bind_node_events(tag, path, name):
        """Attach click, hover, leave events to all items with this tag."""
        graph_canvas.tag_bind(tag, "<Button-1>",  lambda e, p=path: _on_graph_node_click(p))
        graph_canvas.tag_bind(tag, "<Enter>",
                               lambda e, p=path: _show_tooltip(p, e.x_root, e.y_root))
        graph_canvas.tag_bind(tag, "<Leave>",     lambda e: _hide_tooltip())

    def _on_graph_node_click(path):
        """Click on a graph node: select it in the treeview and redraw graph."""
        _hide_tooltip()
        # Select in treeview
        for iid in tree.get_children():
            vals = tree.item(iid, "values")
            if vals and len(vals) >= 4 and vals[3] == path:
                tree.selection_set(iid)
                tree.see(iid)
                break
        # Redraw graph centred on clicked node
        _draw_graph(path)

    # ------------------------------------------------------------------
    # Canvas zoom & pan
    # ------------------------------------------------------------------
    _zoom_scale = [1.0]

    def _on_mousewheel(event):
        # Determine scroll direction
        if event.num == 4 or event.delta > 0:
            factor = 1.1
        else:
            factor = 1 / 1.1
        _zoom_scale[0] *= factor
        graph_canvas.scale("all", event.x, event.y, factor, factor)
        graph_canvas.config(scrollregion=graph_canvas.bbox("all"))

    def _on_pan_start(event):
        graph_canvas.scan_mark(event.x, event.y)

    def _on_pan_move(event):
        graph_canvas.scan_dragto(event.x, event.y, gain=1)

    graph_canvas.bind("<MouseWheel>",  _on_mousewheel)   # Windows
    graph_canvas.bind("<Button-4>",    _on_mousewheel)   # Linux scroll up
    graph_canvas.bind("<Button-5>",    _on_mousewheel)   # Linux scroll down
    graph_canvas.bind("<Button-3>",    _on_pan_start)    # Right-click to start pan
    graph_canvas.bind("<B3-Motion>",   _on_pan_move)     # Right-drag to pan
    graph_canvas.bind("<Button-2>",    _on_pan_start)    # Middle-click to start pan
    graph_canvas.bind("<B2-Motion>",   _on_pan_move)     # Middle-drag to pan

    def _on_canvas_resize(event):
        if _current_graph_path[0]:
            _draw_graph(_current_graph_path[0])

    graph_canvas.bind("<Configure>", _on_canvas_resize)

    # ------------------------------------------------------------------
    # Sort state
    # ------------------------------------------------------------------
    _sort_col = ["ref_count"]   # mutable cell: current sort column key
    _sort_rev = [True]          # descending by default

    # ------------------------------------------------------------------
    # Populate treeview from filtered list
    # ------------------------------------------------------------------
    def _populate_tree(assets):
        """Clear and repopulate the treeview with the given asset list."""
        for row in tree.get_children():
            tree.delete(row)

        for a in assets:
            tag = "orphan" if a["ref_count"] == 0 else "asset"
            parent = tree.insert(
                "", "end",
                text=a["name"],
                values=(
                    a["type"],
                    a["dep_count"],
                    a["ref_count"],
                    a["path"],
                ),
                tags=(tag,),
            )
            # Level-2 children: dependencies then referencers
            for dep in a["dependencies"]:
                tree.insert(
                    parent, "end",
                    text=f"→ {dep['name']}",
                    values=(dep["type"], "", "", dep["path"]),
                    tags=("dependency",),
                )
            for ref in a["referencers"]:
                tree.insert(
                    parent, "end",
                    text=f"← {ref['name']}",
                    values=(ref["type"], "", "", ref["path"]),
                    tags=("referencer",),
                )

    def _apply_filters_and_display():
        """Re-filter the cached scan result and repopulate the tree."""
        result = _last_scan_result[0]
        if result is None:
            return

        query        = filter_entry.get().strip().lower()
        type_filter  = type_combo.get()
        orphans_only = _show_orphans_state[0]

        filtered = []
        for a in result["assets"]:
            if orphans_only and a["ref_count"] != 0:
                continue
            if type_filter != "All" and a["type"] != type_filter:
                continue
            if query and query not in a["name"].lower() and query not in a["path"].lower():
                continue
            filtered.append(a)

        # Sort
        col = _sort_col[0]
        rev = _sort_rev[0]
        filtered.sort(key=lambda a: a[col], reverse=rev)

        _populate_tree(filtered)

        orphan_count = result["orphan_count"]
        total        = result["total_assets"]
        shown        = len(filtered)
        status_var.set(f"Showing {shown} of {total} assets ({orphan_count} orphans)")
        count_var.set(f"{orphan_count} orphans | {total} total")

    # ------------------------------------------------------------------
    # Column heading sort
    # ------------------------------------------------------------------
    def _make_sort_command(col_key):
        def _sort():
            if _sort_col[0] == col_key:
                _sort_rev[0] = not _sort_rev[0]
            else:
                _sort_col[0] = col_key
                _sort_rev[0] = True
            _apply_filters_and_display()
        return _sort

    tree.heading("deps_col", text="Deps", command=_make_sort_command("dep_count"))
    tree.heading("refs_col", text="Refs", command=_make_sort_command("ref_count"))

    # ------------------------------------------------------------------
    # Treeview selection → draw graph
    # ------------------------------------------------------------------
    def _on_tree_select(event):
        item = tree.focus()
        if not item:
            return
        # Only react to top-level asset rows (not dep/ref children)
        tags = tree.item(item, "tags")
        if "asset" not in tags and "orphan" not in tags:
            return
        values = tree.item(item, "values")
        if not values or len(values) < 4:
            return
        path = values[3]
        if path and path in _path_to_asset:
            _draw_graph(path)

    tree.bind("<<TreeviewSelect>>", _on_tree_select)

    # ------------------------------------------------------------------
    # Double-click: copy path to clipboard
    # ------------------------------------------------------------------
    def _on_double_click(_event):
        item = tree.focus()
        if not item:
            return
        values = tree.item(item, "values")
        if not values or len(values) < 4:
            return
        path = values[3]
        if not path:
            return
        if _copy_text_to_system_clipboard(path):
            status_var.set(f"Copied to clipboard: {path}")
            unreal.log(f"dependency_viewer: Copied to clipboard — {path}")
        else:
            _show_copy_fallback_popup(root, path, title="Copy asset path")

    tree.bind("<Double-1>", _on_double_click)

    # ------------------------------------------------------------------
    # Refresh
    # ------------------------------------------------------------------
    def _on_refresh():
        refresh_btn.configure(text="Scanning…", state="disabled")
        status_var.set("Scanning Asset Registry…")
        root.update_idletasks()

        try:
            result = scan_dependencies(project_only=True)
            _last_scan_result[0] = result

            # Rebuild path lookup
            _path_to_asset.clear()
            for a in result["assets"]:
                _path_to_asset[a["path"]] = a

            _apply_filters_and_display()

            # If something was previously displayed, redraw it
            if _current_graph_path[0] and _current_graph_path[0] in _path_to_asset:
                _draw_graph(_current_graph_path[0])
            else:
                _current_graph_path[0] = None
                graph_canvas.delete("all")
                graph_label.config(text="Select an asset to view its dependency graph")

        except Exception as e:
            unreal.log_error(f"dependency_viewer UI: scan failed — {traceback.format_exc()}")
            status_var.set(f"Error during scan: {e}")
        finally:
            refresh_btn.configure(text="Refresh", state="normal")

    refresh_btn.configure(command=_on_refresh)

    # Live filter
    filter_entry.bind("<KeyRelease>", lambda _e: _apply_filters_and_display())
    type_combo.bind("<<ComboboxSelected>>", lambda _e: _apply_filters_and_display())
    def _on_orphans_toggle():
        _show_orphans_state[0] = not _show_orphans_state[0]
        _apply_filters_and_display()
    orphans_check.config(command=_on_orphans_toggle)

    # ------------------------------------------------------------------
    # Tick pump
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
        _hide_tooltip()
        _cleanup()
        try:
            root.destroy()
        except Exception:
            pass

    root.protocol("WM_DELETE_WINDOW", _on_close)
    _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)

    # Auto-refresh on open
    _on_refresh()
    root.update()  # force initial render with stats populated

    unreal.log("dependency_viewer: UI opened. Call show_dependency_viewer() to reopen if closed.")
