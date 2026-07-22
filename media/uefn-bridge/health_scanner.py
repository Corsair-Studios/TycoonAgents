"""
UEFN Project Health Scanner
============================
Scans the project's Content directory on disk for common file-health issues:
zero-byte assets, oversized files, invalid filenames, duplicate names,
excessively deep paths, and stale (unmaintained) assets.

Runs inside UEFN's embedded Python 3.11 (requires the ``unreal`` module).

Provides three interfaces:
  1. **_get_project_root()**   — walk up from __file__ to find .uefnproject root
  2. **_get_content_dir()**    — Content/ sibling of the Python/ script dir
  3. **scan_health()**         — disk scan; returns structured results dict
  4. **show_health_scanner()** — Tkinter UI with flat issue list and live filter

Usage:
    from health_scanner import scan_health, show_health_scanner
"""

import os
import re
import subprocess
import traceback
import webbrowser

try:
    import unreal
    _HAS_UNREAL = True
except ImportError:
    _HAS_UNREAL = False

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

# UI state for the tick pump
_tick_handle = [None]

# Cached scan result reused by the live filter
_last_scan_result = [None]


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
    if not _HAS_UNREAL:
        return None
    try:
        opts = unreal.AssetRegistryDependencyOptions()
        _set_dep_option(opts, ("include_hard_package_references", "include_hard_package_data"))
        _set_dep_option(opts, ("include_soft_package_references", "include_soft_package_data"))
        return opts
    except Exception as e:
        unreal.log_warning(f"health_scanner: Could not configure dep options — {e}. Using defaults.")
        try:
            return unreal.AssetRegistryDependencyOptions()
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _get_project_root():
    """
    Walk upward from the script directory until a directory containing a
    ``.uefnproject`` file is found, then return that directory path.

    Falls back to the grandparent of the script dir if not found.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidate = script_dir
    for _ in range(10):
        for entry in os.listdir(candidate):
            if entry.endswith(".uefnproject"):
                return candidate
        parent = os.path.dirname(candidate)
        if parent == candidate:
            break
        candidate = parent
    # Fallback: assume layout is  <root>/Plugins/<plugin>/Content/Python/
    # or simply <root>/Content/Python/; go up two levels from script dir.
    return os.path.dirname(os.path.dirname(script_dir))


def _resolve_unreal_content_dir():
    """
    SECONDARY fallback only (see _get_content_dir): ask the live UEFN
    session for ``unreal.Paths.project_content_dir()``.

    DEMOTED from primary (was preferred in 0.0.418): in UEFN this API
    resolves to the EMBEDDED ENGINE's project — FortniteGame in the game
    install tree (e.g. ``.../Fortnite/FortniteGame/Content``) — NOT the
    user's island project, which is only a mounted plugin. Trusting it
    unconditionally scanned the game install and reported every real user
    asset as a ghost. So the result is now validated: only accepted if the
    resolved project directory itself contains a ``*.uefnproject`` file
    (FortniteGame has a ``.uproject`` and never a ``.uefnproject``).

    Returns a normalized full Content path, or ``None`` if ``unreal`` isn't
    importable, the call fails, the path doesn't exist, or it fails the
    ``.uefnproject`` validation check.
    """
    try:
        import unreal
        raw = unreal.Paths.project_content_dir()
        if not raw:
            return None
        full = os.path.normpath(unreal.Paths.convert_relative_path_to_full(raw))
        if not os.path.isdir(full):
            return None
        project_dir = os.path.dirname(full)
        if not any(entry.endswith(".uefnproject") for entry in os.listdir(project_dir)):
            return None
        return full
    except Exception:
        return None


def _get_content_dir():
    """
    Return the Content directory of the user's UEFN island project.

    PRIMARY: filesystem walkup from this script's ``__file__`` location
    (same bounded pattern as ``_get_project_root()``) to the first ancestor
    directory containing a ``*.uefnproject`` file — the staged bridge
    scripts always live under that project's ``Content/Python/``, so this
    is authoritative regardless of what UEFN's embedded engine has open.

    SECONDARY (only when no ``.uefnproject`` is found by the walkup): the
    live UEFN session's ``unreal.Paths.project_content_dir()``, validated
    against a ``.uefnproject`` file — because in UEFN that API actually
    resolves to the EMBEDDED ENGINE's project (FortniteGame in the game
    install tree), not the user's island project, so an unvalidated result
    would silently scan the wrong tree (0.0.418 regression).

    FINAL: legacy two-dirs-up fallback so this never crashes outside UEFN.

    Layout assumed: ``<project_root>/Content/Python/<this_file>``
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidate = script_dir
    found_root = False
    for _ in range(10):
        try:
            entries = os.listdir(candidate)
        except Exception:
            entries = []
        if any(entry.endswith(".uefnproject") for entry in entries):
            found_root = True
            break
        parent = os.path.dirname(candidate)
        if parent == candidate:
            break
        candidate = parent

    if found_root:
        content_candidate = os.path.join(candidate, "Content")
        if os.path.isdir(content_candidate):
            return content_candidate
        # .uefnproject found but no sibling Content/ — fall through to the
        # legacy fallback below (skip the unreal secondary; we already
        # located the real project root, it just lacks a Content dir).
    else:
        # No .uefnproject found by the walkup — try the validated unreal
        # secondary before the legacy fallback.
        unreal_content_dir = _resolve_unreal_content_dir()
        if unreal_content_dir:
            return unreal_content_dir

    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------------------
# Core health scan
# ---------------------------------------------------------------------------

# Directories to skip entirely (relative basenames)
_SKIP_DIRS = {"Python", ".uefn_bridge"}

# Files older than this many days are considered stale

# Files larger than this many bytes trigger a "Large File" warning
_LARGE_FILE_BYTES = 50 * 1024 * 1024  # 50 MB

# Full path longer than this triggers a "Deep Path" warning
_DEEP_PATH_CHARS = 200

# Extensions considered project assets (used for by_extension summary)
_ASSET_EXTENSIONS = {".uasset", ".verse", ".umap"}


def scan_health():
    """
    Walk the Content directory and check every file for health issues.

    Skips the ``Python/`` sub-folder and any hidden directories (names starting
    with ``.``) so that tool scripts and bridge state files are not flagged.

    Returns
    -------
    dict
        ``project_root``  — str, absolute path to the .uefnproject directory

        ``content_dir``   — str, absolute path scanned

        ``total_files``   — int, number of files examined

        ``total_size_mb`` — float, total size of all scanned files in MB

        ``issues``        — list of issue dicts (see below)

        ``summary``       — aggregated counts (see below)

    Issue dict keys:
        ``severity``   — ``"error"`` | ``"warning"`` | ``"info"``
        ``category``   — human-readable category string
        ``file_name``  — base filename
        ``file_path``  — full absolute path
        ``detail``     — human-readable explanation
        ``size_bytes`` — int file size in bytes

    Summary dict keys:
        ``errors``       — int
        ``warnings``     — int
        ``info``         — int
        ``by_extension`` — dict mapping extension to ``{"count": int, "size_mb": float}``
    """
    project_root = _get_project_root()
    content_dir  = _get_content_dir()

    if _HAS_UNREAL:
        unreal.log(f"health_scanner: project_root = {project_root}")
        unreal.log(f"health_scanner: content_dir  = {content_dir}")

    if not os.path.isdir(content_dir):
        return {
            "project_root": project_root,
            "content_dir":  content_dir,
            "total_files":  0,
            "total_size_mb": 0.0,
            "issues": [],
            "summary": {"errors": 0, "warnings": 0, "info": 0, "by_extension": {}},
        }

    issues        = []
    total_files   = 0
    total_bytes   = 0
    by_extension  = {}

    # First pass: collect all base filenames to detect duplicates
    # Maps lowercase base filename -> list of full paths
    name_index = {}


    # -----------------------------------------------------------------------
    # Walk the content directory
    # -----------------------------------------------------------------------
    for dirpath, dirnames, filenames in os.walk(content_dir):
        # Prune directories in-place so os.walk does not descend into them
        dirnames[:] = [
            d for d in dirnames
            if d not in _SKIP_DIRS and not d.startswith(".")
        ]

        for filename in filenames:
            full_path = os.path.join(dirpath, filename)
            total_files += 1

            if total_files % 200 == 0 and _HAS_UNREAL:
                unreal.log(f"health_scanner: Progress — {total_files} files scanned...")

            # Stat the file once
            try:
                st = os.stat(full_path)
            except OSError:
                continue

            size_bytes = st.st_size
            total_bytes += size_bytes

            ext = os.path.splitext(filename)[1].lower()

            # Accumulate by_extension summary
            if ext not in by_extension:
                by_extension[ext] = {"count": 0, "size_mb": 0.0}
            by_extension[ext]["count"]   += 1
            by_extension[ext]["size_mb"] += size_bytes / (1024 * 1024)

            # Track for duplicate detection
            name_lower = filename.lower()
            if name_lower not in name_index:
                name_index[name_lower] = []
            name_index[name_lower].append(full_path)

            # ------------------------------------------------------------------
            # Check a: Zero-byte files — error
            # ------------------------------------------------------------------
            if size_bytes == 0:
                issues.append({
                    "severity":   "error",
                    "category":   "Zero-byte",
                    "file_name":  filename,
                    "file_path":  full_path,
                    "detail":     "File is empty (0 bytes). May indicate a corrupt or incomplete asset.",
                    "size_bytes": 0,
                })

            # ------------------------------------------------------------------
            # Check b: Large files — warning
            # ------------------------------------------------------------------
            if size_bytes > _LARGE_FILE_BYTES:
                size_mb = size_bytes / (1024 * 1024)
                issues.append({
                    "severity":   "warning",
                    "category":   "Large File",
                    "file_name":  filename,
                    "file_path":  full_path,
                    "detail":     f"{size_mb:.1f} MB — exceeds the 50 MB recommended limit.",
                    "size_bytes": size_bytes,
                })

            # ------------------------------------------------------------------
            # Check c: Invalid filenames — warning
            # Flags: spaces, non-ASCII, double extensions
            # ------------------------------------------------------------------
            base_name = os.path.splitext(filename)[0]
            invalid_reason = None

            if re.search(r'[^a-zA-Z0-9_.\-/\\]', filename):
                invalid_reason = "Contains spaces or non-ASCII / special characters."
            elif len(os.path.splitext(base_name)[1]) > 0:
                invalid_reason = "Double extension detected (e.g. MyAsset.backup.uasset)."

            if invalid_reason:
                issues.append({
                    "severity":   "warning",
                    "category":   "Invalid Name",
                    "file_name":  filename,
                    "file_path":  full_path,
                    "detail":     invalid_reason,
                    "size_bytes": size_bytes,
                })

            # ------------------------------------------------------------------
            # Check e: Deep paths — warning
            # ------------------------------------------------------------------
            if len(full_path) > _DEEP_PATH_CHARS:
                issues.append({
                    "severity":   "warning",
                    "category":   "Deep Path",
                    "file_name":  filename,
                    "file_path":  full_path,
                    "detail":     f"Full path is {len(full_path)} chars (limit {_DEEP_PATH_CHARS}). May cause Windows path issues.",
                    "size_bytes": size_bytes,
                })

    # -----------------------------------------------------------------------
    # Check d: Duplicate filenames — info
    # Report all paths for any filename that appears in more than one folder
    # -----------------------------------------------------------------------
    for name_lower, paths in name_index.items():
        if len(paths) > 1:
            path_list = "; ".join(paths)
            for dup_path in paths:
                issues.append({
                    "severity":   "info",
                    "category":   "Duplicate Name",
                    "file_name":  os.path.basename(dup_path),
                    "file_path":  dup_path,
                    "detail":     f"Same filename found in {len(paths)} locations: {path_list}",
                    "size_bytes": 0,
                })

    # -----------------------------------------------------------------------
    # Check e: Missing asset references — error
    # Scan project materials/Niagara for dependencies that no longer exist
    # in the Asset Registry (removed/renamed by Epic in a Fortnite update).
    # -----------------------------------------------------------------------
    if _HAS_UNREAL:
        try:
            registry = unreal.AssetRegistryHelpers.get_asset_registry()
            # _make_dep_options() tries correct UE5 names first, falls back
            # to default options if no known attribute exists — never crashes.
            dep_options = _make_dep_options()

            # Detect project prefix
            try:
                subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
                actors = subsystem.get_all_level_actors()
                if actors:
                    _parts = actors[0].get_path_name().split("/")
                    project_prefix = "/" + _parts[1] + "/" if len(_parts) >= 2 and _parts[1] else "/Game/"
                else:
                    project_prefix = "/Game/"
            except Exception:
                project_prefix = "/Game/"

            # Build a complete set of ALL known asset package names.
            # Using get_all_assets() covers every type (textures, materials,
            # blueprints, data assets, enums, etc.) so we only flag deps
            # that truly don't exist — not just ones we didn't index.
            unreal.log("health_scanner: Building complete asset index for reference check...")
            all_registry_assets = registry.get_all_assets()
            known_packages = {str(a.package_name) for a in all_registry_assets}
            unreal.log(f"health_scanner: {len(known_packages)} total packages indexed")

            # Scan project materials and Niagara systems for broken deps
            candidate_classes = [
                ("Material", "/Script/Engine"),
                ("MaterialInstanceConstant", "/Script/Engine"),
                ("NiagaraSystem", "/Script/Niagara"),
            ]
            checked = 0
            seen_missing = set()  # deduplicate: same missing asset from multiple referencers
            for cls_name, module in candidate_classes:
                try:
                    assets = registry.get_assets_by_class(
                        unreal.TopLevelAssetPath(module, cls_name)
                    )
                except Exception:
                    continue

                for asset_data in assets:
                    pkg = str(asset_data.package_name)
                    if not pkg.startswith(project_prefix):
                        continue

                    checked += 1
                    try:
                        deps = registry.get_dependencies(pkg, dep_options)
                    except Exception:
                        continue
                    if deps is None:
                        continue

                    for dep in deps:
                        dep_str = str(dep)
                        # Skip engine/script modules — not content assets
                        if dep_str.startswith("/Script/") or dep_str.startswith("/Engine/"):
                            continue
                        # Only flag if truly missing from the entire registry
                        if dep_str not in known_packages and dep_str not in seen_missing:
                            seen_missing.add(dep_str)
                            issues.append({
                                "severity":   "error",
                                "category":   "Missing Reference",
                                "file_name":  dep_str.rsplit("/", 1)[-1] if "/" in dep_str else dep_str,
                                "file_path":  dep_str,
                                "detail":     f"Referenced by {str(asset_data.asset_name)} ({cls_name}) but not found in registry. May have been removed in a Fortnite update.",
                                "size_bytes": 0,
                            })

            unreal.log(f"health_scanner: Checked {checked} project assets, found {len(seen_missing)} missing reference(s)")

        except Exception as e:
            if _HAS_UNREAL:
                unreal.log_warning(f"health_scanner: Missing reference check failed — {e}")

        # -------------------------------------------------------------------
        # Check f: Ghost Assets — error
        # Asset Registry has an entry for a project asset but the actual
        # .uasset file is missing from disk.  These cause
        #   FPackageName: Skipped package … does not exist either on disk
        #   or in iostore
        # errors at load time and are usually caused by a deletion that
        # wasn't synced, or an OneDrive/version-control partial sync.
        # -------------------------------------------------------------------
        try:
            unreal.log("health_scanner: Checking for ghost assets (registry entries with no file on disk)...")
            seen_ghost = set()
            ghost_count = 0
            for asset_data in all_registry_assets:
                pkg = str(asset_data.package_name)
                if not pkg.startswith(project_prefix):
                    continue
                if pkg in seen_ghost:
                    continue

                # Skip Verse virtual packages — compiled symbols under /_Verse/
                # have Asset Registry entries but no .uasset on disk.
                if "/_Verse" in pkg or "\\_Verse" in pkg:
                    continue

                # Skip world partition sub-packages — __ExternalActors__ and
                # __ExternalObjects__ are synthetic packages that don't map to
                # individual .uasset files.
                if "__ExternalActors__" in pkg or "__ExternalObjects__" in pkg:
                    continue

                # Translate the registry path to a disk path and check both
                # .uasset (normal assets) and .umap (level/map files).
                relative = pkg[len(project_prefix):]            # strip mount prefix
                base_path = os.path.join(content_dir, *relative.split("/"))
                if os.path.isfile(base_path + ".uasset") or os.path.isfile(base_path + ".umap"):
                    continue  # exists on disk in some form

                # Neither extension found → ghost asset
                seen_ghost.add(pkg)
                ghost_count += 1
                asset_name = str(asset_data.asset_name)
                disk_path = base_path + ".uasset"   # report the .uasset path for clarity
                issues.append({
                    "severity":   "error",
                    "category":   "Ghost Asset",
                    "file_name":  asset_name,
                    "file_path":  disk_path,
                    "detail":     f"Asset Registry entry exists but file is missing from disk. Referenced as {pkg}",
                    "size_bytes": 0,
                })

            unreal.log(f"health_scanner: Ghost asset check complete — {ghost_count} ghost asset(s) found")

        except Exception as e:
            if _HAS_UNREAL:
                unreal.log_warning(f"health_scanner: Ghost asset check failed — {e}")

    # -----------------------------------------------------------------------
    # Build summary
    # -----------------------------------------------------------------------
    errors   = sum(1 for i in issues if i["severity"] == "error")
    warnings = sum(1 for i in issues if i["severity"] == "warning")
    infos    = sum(1 for i in issues if i["severity"] == "info")

    # Round by_extension size_mb values
    for ext_key in by_extension:
        by_extension[ext_key]["size_mb"] = round(by_extension[ext_key]["size_mb"], 2)

    total_size_mb = round(total_bytes / (1024 * 1024), 2)

    if _HAS_UNREAL:
        unreal.log(
            f"health_scanner: Scan complete — {total_files} files, "
            f"{len(issues)} issues ({errors} errors, {warnings} warnings, {infos} info)"
        )

    return {
        "project_root":  project_root,
        "content_dir":   content_dir,
        "total_files":   total_files,
        "total_size_mb": total_size_mb,
        "issues": issues,
        "summary": {
            "errors":        errors,
            "warnings":      warnings,
            "info":          infos,
            "by_extension":  by_extension,
        },
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_health_scanner():
    """
    Open the Project Health Scanner UI window.

    Features
    --------
    - Filter entry for real-time substring filtering (no re-scan)
    - Severity dropdown (All / Error / Warning / Info)
    - Scan button — re-runs :func:`scan_health`
    - Flat treeview: one row per issue — Severity | Category | File | Detail | Size | Path
    - Double-click opens Explorer with the file selected
    - Status bar with issue counts and file totals
    - Footer: @thetrashbyrd + logo
    - Auto-scan on open
    """
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("health_scanner: tkinter is not available in this environment.")
        return

    # ------------------------------------------------------------------
    # Root window
    # ------------------------------------------------------------------
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Project Health")
    root.configure(bg=_BG)
    root.geometry("1300x720")
    root.minsize(900, 450)

    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path  = os.path.join(_script_dir, "trashbyrd_40x40.png")
        if os.path.isfile(_logo_path):
            _logo_img = tk.PhotoImage(file=_logo_path, master=root)
    except Exception:
        pass

    # ------------------------------------------------------------------
    # Styles
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
        "Action.TButton",
        background=_ACCENT_BLUE,
        foreground="#1A1A1A",
        font=("Segoe UI", 10, "bold"),
        padding=(14, 6),
        relief="flat",
    )
    style.map("Action.TButton", background=[("active", "#D24E1F")])

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
    root.option_add("*TCombobox*Listbox.background",       _ENTRY_BG)
    root.option_add("*TCombobox*Listbox.foreground",       _ENTRY_FG)
    root.option_add("*TCombobox*Listbox.selectBackground", "#F6D9C9")
    root.option_add("*TCombobox*Listbox.selectForeground", "#1A1A1A")

    # ------------------------------------------------------------------
    # Top bar
    # ------------------------------------------------------------------
    top_frame = ttk.Frame(root, style="Dark.TFrame", padding=(12, 10))
    top_frame.pack(fill="x", side="top")

    ttk.Label(top_frame, text="Trashbyrd's Project Health", style="Header.TLabel").pack(
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
    filter_entry.pack(side="left", padx=(0, 14), ipady=4)

    ttk.Label(top_frame, text="Severity:", style="Dark.TLabel").pack(side="left", padx=(0, 4))

    severity_combo = ttk.Combobox(
        top_frame,
        values=["All", "Error", "Warning", "Info"],
        state="readonly",
        width=10,
        style="Dark.TCombobox",
        font=("Segoe UI", 10),
    )
    severity_combo.set("All")
    severity_combo.pack(side="left", padx=(0, 14))

    scan_btn = ttk.Button(top_frame, text="Scan", style="Action.TButton")
    scan_btn.pack(side="left")

    # ------------------------------------------------------------------
    # Main treeview — flat list, one row per issue
    # Columns: Severity | Category | File | Detail | Size | Path
    # ------------------------------------------------------------------
    tree_frame = ttk.Frame(root, style="Section.TFrame")
    tree_frame.pack(fill="both", expand=True, padx=10, pady=(4, 0))

    columns = ("severity_col", "category_col", "file_col", "detail_col", "size_col", "path_col")
    tree = ttk.Treeview(tree_frame, columns=columns, show="headings", selectmode="browse")

    tree.heading("severity_col", text="Severity")
    tree.heading("category_col", text="Category")
    tree.heading("file_col",     text="File")
    tree.heading("detail_col",   text="Detail")
    tree.heading("size_col",     text="Size")
    tree.heading("path_col",     text="Path")

    tree.column("severity_col", width=70,  minwidth=60,  stretch=False)
    tree.column("category_col", width=110, minwidth=80,  stretch=False)
    tree.column("file_col",     width=220, minwidth=120, stretch=False)
    tree.column("detail_col",   width=380, minwidth=160, stretch=True)
    tree.column("size_col",     width=80,  minwidth=60,  stretch=False)
    tree.column("path_col",     width=420, minwidth=180, stretch=True)

    # Severity row tags
    tree.tag_configure("error",   foreground="#C0392B")
    tree.tag_configure("warning", foreground="#9A5D00")
    tree.tag_configure("info",    foreground="#57524C")

    vsb = ttk.Scrollbar(tree_frame, orient="vertical",   command=tree.yview)
    hsb = ttk.Scrollbar(tree_frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

    vsb.pack(side="right",  fill="y")
    hsb.pack(side="bottom", fill="x")
    tree.pack(fill="both", expand=True)

    # ------------------------------------------------------------------
    # Footer and status bar
    # ------------------------------------------------------------------
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill="x", side="bottom")

    count_label_var = tk.StringVar(value="")
    count_label = tk.Label(
        footer_frame,
        textvariable=count_label_var,
        font=("Segoe UI", 8),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    )
    count_label.pack(side="left")

    social_label = tk.Label(
        footer_frame,
        text="@thetrashbyrd",
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

    status_var = tk.StringVar(value="Click Scan to check project health.")
    status_bar = ttk.Label(root, textvariable=status_var, style="Status.TLabel", anchor="w")
    status_bar.pack(fill="x", side="bottom")

    # ------------------------------------------------------------------
    # Populate treeview from cached results + current filter state
    # ------------------------------------------------------------------
    def _apply_filter():
        """Re-populate the treeview from cached results applying current filters."""
        result = _last_scan_result[0]
        if result is None:
            return

        for row in tree.get_children():
            tree.delete(row)

        filter_text     = filter_entry.get().strip().lower()
        severity_filter = severity_combo.get().lower()  # "all", "error", "warning", "info"

        shown = 0
        for issue in result["issues"]:
            sev      = issue["severity"]
            category = issue["category"]
            fname    = issue["file_name"]
            fpath    = issue["file_path"]
            detail   = issue["detail"]
            size_b   = issue["size_bytes"]

            # Severity filter
            if severity_filter != "all" and sev != severity_filter:
                continue

            # Text filter — match against filename, path, category, detail
            if filter_text:
                haystack = (fname + fpath + category + detail).lower()
                if filter_text not in haystack:
                    continue

            # Human-readable size
            if size_b >= 1024 * 1024:
                size_str = f"{size_b / (1024*1024):.1f} MB"
            elif size_b >= 1024:
                size_str = f"{size_b / 1024:.1f} KB"
            elif size_b > 0:
                size_str = f"{size_b} B"
            else:
                size_str = ""

            tree.insert(
                "", "end",
                values=(sev.capitalize(), category, fname, detail, size_str, fpath),
                tags=(sev,),
            )
            shown += 1

        summary  = result["summary"]
        errors   = summary["errors"]
        warnings = summary["warnings"]
        infos    = summary["info"]
        total_f  = result["total_files"]
        total_mb = result["total_size_mb"]

        count_label_var.set(f"{errors} errors  |  {warnings} warnings  |  {infos} info")
        status_var.set(
            f"{shown} issues shown  ({errors} errors, {warnings} warnings, {infos} info)"
            f"  —  {total_f} files scanned ({total_mb} MB)"
        )

    # ------------------------------------------------------------------
    # Scan — run health check and cache results
    # ------------------------------------------------------------------
    def _on_scan():
        scan_btn.configure(text="Scanning...", state="disabled")
        status_var.set("Scanning Content directory...")
        root.update_idletasks()

        try:
            result = scan_health()
            _last_scan_result[0] = result
            _apply_filter()
        except Exception as e:
            if _HAS_UNREAL:
                unreal.log_error(f"health_scanner UI: scan failed — {traceback.format_exc()}")
            status_var.set(f"Error during scan: {e}")
        finally:
            scan_btn.configure(text="Scan", state="normal")

    scan_btn.configure(command=_on_scan)

    # ------------------------------------------------------------------
    # Live filter bindings
    # ------------------------------------------------------------------
    filter_entry.bind("<KeyRelease>", lambda _e: _apply_filter())
    severity_combo.bind("<<ComboboxSelected>>", lambda _e: _apply_filter())

    # ------------------------------------------------------------------
    # Double-click — open Explorer with file selected
    # ------------------------------------------------------------------
    def _on_double_click(_event):
        item = tree.focus()
        if not item:
            return
        values = tree.item(item, "values")
        if not values or len(values) < 6:
            return
        file_path = values[5]  # Path column
        if file_path and os.path.exists(file_path):
            try:
                subprocess.Popen(['explorer', '/select,', os.path.normpath(file_path)])
            except Exception:
                try:
                    os.startfile(os.path.dirname(file_path))
                except Exception:
                    pass

    tree.bind("<Double-1>", _on_double_click)

    # ------------------------------------------------------------------
    # Hover tooltip — shows category explanation
    # ------------------------------------------------------------------
    _CATEGORY_TIPS = {
        "Zero-byte":      "File has 0 bytes — likely corrupted or failed to save.",
        "Large File":     "File exceeds 50 MB — may impact load times and memory.",
        "Invalid Name":   "Filename has spaces, special characters, or double extensions\nthat can cause import or packaging issues.",
        "Deep Path":      "Full file path exceeds 200 characters — Windows may\nfail to read, copy, or version-control this file.",
        "Duplicate Name": "Same filename exists in multiple folders — can cause\nambiguous imports or asset reference conflicts.",
        "Missing Reference": "Asset is referenced by a project material or VFX but\nno longer exists in the registry. Usually caused by\nEpic removing or renaming assets in a Fortnite update.",
        "Ghost Asset": "Asset Registry has an entry for this asset but the .uasset\nfile is missing from disk. Usually caused by a deletion that\nwasn't synced, or an OneDrive/version-control sync failure.",
    }

    _tip_win = [None]

    def _show_tooltip(event):
        item = tree.identify_row(event.y)
        if not item:
            _hide_tooltip()
            return
        values = tree.item(item, "values")
        if not values or len(values) < 2:
            _hide_tooltip()
            return
        category = values[1]  # Category column
        file_path = values[5] if len(values) > 5 else ""  # Path column

        # Show category tip or full path depending on which column is hovered
        col = tree.identify_column(event.x)  # returns "#1", "#2", etc.
        if col == "#6" and file_path:
            tip_text = file_path
        else:
            tip_text = _CATEGORY_TIPS.get(category)

        if not tip_text:
            _hide_tooltip()
            return

        if _tip_win[0]:
            _tip_win[0].destroy()

        tw = tk.Toplevel(root)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f"+{event.x_root + 16}+{event.y_root + 10}")
        tw.configure(bg="#EBE7DD")
        lbl = tk.Label(
            tw, text=tip_text,
            font=("Segoe UI", 9), fg="#1A1A1A", bg="#EBE7DD",
            justify=tk.LEFT, padx=8, pady=4,
            relief=tk.SOLID, borderwidth=1,
        )
        lbl.pack()
        _tip_win[0] = tw

    def _hide_tooltip(*_args):
        if _tip_win[0]:
            _tip_win[0].destroy()
            _tip_win[0] = None

    tree.bind("<Motion>", _show_tooltip)
    tree.bind("<Leave>", _hide_tooltip)

    # ------------------------------------------------------------------
    # Tick pump — pump tkinter events from Unreal's Slate tick
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
                if _HAS_UNREAL:
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

    if _HAS_UNREAL:
        _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)

    # Auto-scan on open
    _on_scan()
    root.update()  # force initial render with stats populated

    if _HAS_UNREAL:
        unreal.log("health_scanner: UI opened. Use show_health_scanner() to reopen if closed.")
