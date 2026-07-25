"""
UEFN Niagara Inspector
=======================
Browse all project Niagara systems, inspect their texture/material/emitter
dependencies, and find which level actors use them.  Runs inside UEFN's
embedded Python 3.11 (requires the ``unreal`` module).

Provides four interfaces:
  1. **_get_project_prefix()**     — detect the content prefix for this project
  2. **browse_niagara()**          — Asset Registry scan; returns structured dict
  3. **find_niagara_usage()**      — map Niagara systems to the actors that use them
  4. **show_niagara_inspector()**  — Tkinter UI with treeview and live filter

Usage:
    from niagara_inspector import browse_niagara, find_niagara_usage
    from niagara_inspector import show_niagara_inspector
"""

import os
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
# Theme constants (matching launcher / batch_tools / material_browser palette)
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

# Cached scan results reused by the live filter (avoids re-scanning on keystrokes)
_last_browse_result = [None]
_last_usage_result  = [None]


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
                unreal.log(f"niagara_inspector: Detected project prefix from actor path: {prefix}")
                return prefix
    except Exception as e:
        unreal.log_warning(f"niagara_inspector: Actor path detection failed — {e}")

    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        world = subsystem.get_world()
        if world:
            world_path = world.get_path_name()
            unreal.log(f"niagara_inspector: World path = {world_path}")
            parts = world_path.split("/")
            if len(parts) >= 2 and parts[1]:
                prefix = "/" + parts[1] + "/"
                unreal.log(f"niagara_inspector: Detected project prefix from world: {prefix}")
                return prefix
    except Exception as e:
        unreal.log_warning(f"niagara_inspector: World path detection failed — {e}")

    unreal.log_warning("niagara_inspector: Could not detect project prefix, defaulting to /Game/")
    return "/Game/"


# ---------------------------------------------------------------------------
# Internal registry helpers
# ---------------------------------------------------------------------------

_SKIP_PREFIXES = ("/Engine/", "/Script/")


def _get_asset_registry():
    return unreal.AssetRegistryHelpers.get_asset_registry()


def _class_path(engine_class_name, module="/Script/Engine"):
    return unreal.TopLevelAssetPath(module, engine_class_name)


def _niagara_class_path(class_name):
    return unreal.TopLevelAssetPath("/Script/Niagara", class_name)


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
        unreal.log_warning(f"niagara_inspector: Could not configure dep options — {e}. Using defaults.")
        try:
            return unreal.AssetRegistryDependencyOptions()
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Core browse function
# ---------------------------------------------------------------------------

def browse_niagara(project_only=True):
    """
    Scan the Asset Registry for all NiagaraSystem assets and collect their
    texture, material, and emitter dependencies via ``get_dependencies()``.

    Parameters
    ----------
    project_only : bool
        When *True* (default) only assets under the project prefix are included.
        When *False* assets under ``/Engine/`` and ``/Script/`` are excluded but
        all other content roots are included.

    Returns
    -------
    dict
        ``total_systems`` — total number of Niagara systems found

        ``systems`` — list of system dicts, sorted alphabetically by name.
        Each dict has:

        * ``name``            — asset name (str)
        * ``path``            — package path (str)
        * ``texture_count``   — number of Texture2D dependencies
        * ``material_count``  — number of Material/MIC dependencies
        * ``total_dep_count`` — total dependency count (all categories)
        * ``textures``        — list of ``{"name": str, "path": str}`` dicts
        * ``materials``       — list of ``{"name": str, "path": str}`` dicts
    """
    registry = _get_asset_registry()
    dep_options = _make_dep_options()

    # ------------------------------------------------------------------
    # Build lookup maps for Texture2D and Material/MIC package names
    # ------------------------------------------------------------------
    unreal.log("niagara_inspector: Fetching Texture2D assets from registry...")
    try:
        all_textures = registry.get_assets_by_class(_class_path("Texture2D"))
    except Exception as e:
        unreal.log_error(f"niagara_inspector: Failed to get Texture2D assets — {e}")
        all_textures = []

    texture_lookup = {}
    for asset_data in all_textures:
        pkg  = str(asset_data.package_name)
        name = str(asset_data.asset_name)
        texture_lookup[pkg] = name

    unreal.log(f"niagara_inspector: {len(texture_lookup)} Texture2D assets indexed")

    unreal.log("niagara_inspector: Fetching Material and MIC assets from registry...")
    material_lookup = {}
    for cls_name in ("Material", "MaterialInstanceConstant"):
        try:
            assets = registry.get_assets_by_class(_class_path(cls_name))
            for a in assets:
                material_lookup[str(a.package_name)] = str(a.asset_name)
        except Exception as e:
            unreal.log_warning(f"niagara_inspector: Could not fetch {cls_name} assets — {e}")

    unreal.log(f"niagara_inspector: {len(material_lookup)} Material/MIC assets indexed")

    # ------------------------------------------------------------------
    # Build a set of all NiagaraEmitter package names for dep matching
    # ------------------------------------------------------------------
    unreal.log("niagara_inspector: Fetching NiagaraEmitter assets from registry...")
    emitter_lookup = {}
    try:
        all_emitters = registry.get_assets_by_class(_niagara_class_path("NiagaraEmitter"))
        for a in all_emitters:
            emitter_lookup[str(a.package_name)] = str(a.asset_name)
    except Exception as e:
        unreal.log_warning(f"niagara_inspector: Could not fetch NiagaraEmitter assets — {e}")

    unreal.log(f"niagara_inspector: {len(emitter_lookup)} NiagaraEmitter assets indexed")

    # ------------------------------------------------------------------
    # Gather NiagaraSystem assets
    # ------------------------------------------------------------------
    if project_only:
        project_prefix = _get_project_prefix()
        unreal.log(f"niagara_inspector: Project-only mode — filtering to {project_prefix}")

    try:
        all_systems = registry.get_assets_by_class(_niagara_class_path("NiagaraSystem"))
    except Exception as e:
        unreal.log_error(f"niagara_inspector: Failed to get NiagaraSystem assets — {e}")
        all_systems = []

    if project_only:
        system_assets = [a for a in all_systems if str(a.package_name).startswith(project_prefix)]
    else:
        system_assets = [
            a for a in all_systems
            if not any(str(a.package_name).startswith(p) for p in _SKIP_PREFIXES)
        ]

    unreal.log(
        f"niagara_inspector: {len(system_assets)} NiagaraSystem asset(s) "
        f"(of {len(all_systems)} total)"
    )

    # ------------------------------------------------------------------
    # Walk each Niagara system, categorise dependencies
    # ------------------------------------------------------------------
    results = []
    for idx, asset_data in enumerate(system_assets):
        if idx > 0 and idx % 50 == 0:
            unreal.log(
                f"niagara_inspector: Progress — {idx}/{len(system_assets)} systems processed..."
            )

        pkg_name  = str(asset_data.package_name)
        asset_nm  = str(asset_data.asset_name)

        textures  = []
        materials = []

        try:
            deps = registry.get_dependencies(pkg_name, dep_options)
            if deps:
                for dep in deps:
                    dep_str = str(dep)

                    if dep_str in texture_lookup:
                        textures.append({
                            "name": texture_lookup[dep_str],
                            "path": dep_str,
                        })
                    elif dep_str in material_lookup:
                        materials.append({
                            "name": material_lookup[dep_str],
                            "path": dep_str,
                        })
                    # emitters and other /Script/ engine modules are intentionally
                    # not surfaced as child rows to keep the tree readable
        except Exception as e:
            unreal.log_warning(
                f"niagara_inspector: get_dependencies failed for {pkg_name} — {e}"
            )

        total_dep_count = len(textures) + len(materials)

        results.append({
            "name":            asset_nm,
            "path":            pkg_name,
            "texture_count":   len(textures),
            "material_count":  len(materials),
            "total_dep_count": total_dep_count,
            "textures":        textures,
            "materials":       materials,
        })

    # Sort alphabetically by name
    results.sort(key=lambda s: s["name"].lower())

    unreal.log(
        f"niagara_inspector: Scan complete — {len(results)} systems, "
        f"{sum(s['texture_count'] for s in results)} texture refs, "
        f"{sum(s['material_count'] for s in results)} material refs"
    )

    return {
        "total_systems": len(results),
        "systems": results,
    }


# ---------------------------------------------------------------------------
# Actor-usage detection
# ---------------------------------------------------------------------------

def find_niagara_usage():
    """
    Walk all level actors and determine which Niagara systems each actor uses.

    The function first attempts to retrieve the Niagara asset directly from the
    ``NiagaraComponent`` attached to each actor.  If that fails it falls back to
    scanning the actor's package dependencies via the Asset Registry.

    Returns
    -------
    dict
        ``used_by_actors`` — dict mapping normalised NiagaraSystem package path
        (str) to a list of actor label strings that reference it.

        ``unused`` — list of NiagaraSystem package paths (str) not referenced by
        any actor in the current level.

        ``total_actors_with_niagara`` — number of actors that have at least one
        NiagaraComponent.

        ``total_systems_used`` — number of unique Niagara systems referenced.

        ``total_systems_unused`` — number of project Niagara systems with no
        actor reference.
    """
    registry = _get_asset_registry()
    dep_options = _make_dep_options()

    # Build the full set of project Niagara system package paths for "unused" calc
    project_prefix = _get_project_prefix()
    try:
        all_systems = registry.get_assets_by_class(
            unreal.TopLevelAssetPath("/Script/Niagara", "NiagaraSystem")
        )
        project_system_paths = {
            str(a.package_name)
            for a in all_systems
            if str(a.package_name).startswith(project_prefix)
        }
    except Exception as e:
        unreal.log_warning(f"niagara_inspector: Could not build system path set — {e}")
        project_system_paths = set()

    unreal.log(
        f"niagara_inspector: {len(project_system_paths)} project NiagaraSystems "
        f"(under {project_prefix})"
    )

    # used_by_actors: niagara_pkg_path -> list of actor labels
    used_by_actors = {}
    actors_with_niagara = 0

    has_niagara_component = hasattr(unreal, "NiagaraComponent")

    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actors = subsystem.get_all_level_actors()
    except Exception as e:
        unreal.log_error(f"niagara_inspector: Could not get level actors — {e}")
        actors = []

    unreal.log(f"niagara_inspector: Walking {len(actors)} level actors for Niagara usage...")

    for actor in actors:
        try:
            actor_label = actor.get_actor_label()
        except Exception:
            continue

        found_via_component = False

        # -- Strategy 1: direct NiagaraComponent asset lookup --
        if has_niagara_component:
            try:
                comp = actor.get_component_by_class(unreal.NiagaraComponent)
                if comp is not None:
                    ns_path = None

                    # Try get_asset() first (used by some UEFN builds)
                    try:
                        ns_asset = comp.get_asset()
                        if ns_asset is not None:
                            raw = ns_asset.get_path_name()
                            dot = raw.rfind(".")
                            ns_path = raw[:dot] if dot != -1 else raw
                    except Exception:
                        pass

                    # Try editor property "Asset" as fallback
                    if ns_path is None:
                        try:
                            ns_asset = comp.get_editor_property("Asset")
                            if ns_asset is not None:
                                raw = ns_asset.get_path_name()
                                dot = raw.rfind(".")
                                ns_path = raw[:dot] if dot != -1 else raw
                        except Exception:
                            pass

                    if ns_path is not None:
                        if ns_path not in used_by_actors:
                            used_by_actors[ns_path] = []
                        if actor_label not in used_by_actors[ns_path]:
                            used_by_actors[ns_path].append(actor_label)
                        found_via_component = True
                        actors_with_niagara += 1
            except Exception:
                pass

        # -- Strategy 2: dependency-based fallback --
        if not found_via_component:
            try:
                actor_pkg = actor.get_path_name()
                dot = actor_pkg.rfind(".")
                if dot != -1:
                    actor_pkg = actor_pkg[:dot]
                # Strip subobject suffix (e.g. :PersistentLevel.ActorName)
                colon = actor_pkg.find(":")
                if colon != -1:
                    actor_pkg = actor_pkg[:colon]

                deps = registry.get_dependencies(actor_pkg, dep_options)
                if deps:
                    for dep in deps:
                        dep_str = str(dep)
                        if dep_str in project_system_paths:
                            if dep_str not in used_by_actors:
                                used_by_actors[dep_str] = []
                            if actor_label not in used_by_actors[dep_str]:
                                used_by_actors[dep_str].append(actor_label)
            except Exception:
                pass

    candidate_unused = sorted(
        p for p in project_system_paths if p not in used_by_actors
    )

    # A Niagara system absent from the CURRENT level is only a *candidate* for
    # being unused. Confirm against the Asset Registry reverse-reference graph
    # (all asset types, all levels) + Verse source text before flagging it, so
    # we never tell a developer an in-use asset is safe to delete.
    referenced_elsewhere = {}
    try:
        import asset_usage
        confirmed = asset_usage.confirm_orphans(candidate_unused, project_only=True)
    except Exception as e:
        unreal.log_warning(
            f"niagara_inspector: orphan confirmation unavailable ({e}); "
            f"falling back to level-only result (may over-report unused)."
        )
        confirmed = {pkg: "level-only (registry check unavailable)" for pkg in candidate_unused}

    unused_paths = []
    for pkg in candidate_unused:
        if pkg in confirmed:
            unused_paths.append(pkg)
        else:
            # Referenced somewhere outside this level — NOT unused.
            try:
                referenced_elsewhere[pkg] = asset_usage.get_referencer_details(pkg, project_only=True)
            except Exception:
                referenced_elsewhere[pkg] = []

    unreal.log(
        f"niagara_inspector: Usage scan complete — "
        f"{len(used_by_actors)} systems used "
        f"({len(referenced_elsewhere)} referenced outside the level), "
        f"{len(unused_paths)} confirmed unused, "
        f"{actors_with_niagara} actors have NiagaraComponent"
    )

    return {
        "used_by_actors":            used_by_actors,
        "unused":                    unused_paths,
        "referenced_elsewhere":      referenced_elsewhere,
        "orphan_reasons":            confirmed,
        "total_actors_with_niagara": actors_with_niagara,
        "total_systems_used":        len(used_by_actors),
        "total_systems_unused":      len(unused_paths),
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_niagara_inspector():
    """
    Open the Niagara Inspector UI window.

    Features
    --------
    - Filter entry for real-time name substring filtering (no re-scan)
    - "Show Unused Only" checkbox — filters to systems with no actor reference
    - Refresh button — re-runs :func:`browse_niagara` and
      :func:`find_niagara_usage`
    - Hierarchical treeview (2 levels):
        Level 1 — NiagaraSystem (Name | Type | Dep Count | Path)
                  name shows actor count, e.g. ``NS_Lava_Burst  (3 actor(s))``
        Level 2 — Dependencies: textures (dimmed), materials (blue), actors (green)
    - Double-click a row to copy its path to the clipboard
    - Status bar: "Showing X of Y systems (Z unused)"
    - Tkinter event pump via ``unreal.register_slate_post_tick_callback``
    """
    if not _HAS_TKINTER:
        unreal.log_error("niagara_inspector: tkinter is not available in this environment.")
        return

    # ------------------------------------------------------------------
    # Root window
    # ------------------------------------------------------------------
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Niagara Inspector")
    root.configure(bg=_BG)
    root.geometry("1200x700")

    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path = os.path.join(_script_dir, "trashbyrd_40x40.png")
        if os.path.isfile(_logo_path):
            _logo_img = tk.PhotoImage(file=_logo_path, master=root)
    except Exception:
        pass
    root.minsize(800, 400)

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
    # Top bar: title + controls
    # ------------------------------------------------------------------
    top_frame = ttk.Frame(root, style="Dark.TFrame", padding=(12, 10))
    top_frame.pack(fill="x", side="top")

    ttk.Label(top_frame, text="Trashbyrd's Niagara Inspector", style="Header.TLabel").pack(
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

    _show_unused_state = [False]  # plain Python mutable — avoids tk.IntVar desync in UEFN
    unused_only_check = tk.Checkbutton(
        top_frame,
        text="Show Unused Only",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_BG,
        selectcolor=_ENTRY_BG,
        activebackground=_BG,
        activeforeground=_TEXT_FG,
    )
    unused_only_check.pack(side="left", padx=(0, 14))

    refresh_btn = ttk.Button(top_frame, text="Refresh", style="Action.TButton")
    refresh_btn.pack(side="left")

    # ------------------------------------------------------------------
    # Main treeview — 2 levels: system > dependencies / actors
    # Columns: Name (#0 tree) | Type | Count | Path
    # ------------------------------------------------------------------
    tree_frame = ttk.Frame(root, style="Section.TFrame")
    tree_frame.pack(fill="both", expand=True, padx=10, pady=(4, 0))

    columns = ("type_col", "count_col", "path_col")
    tree = ttk.Treeview(tree_frame, columns=columns, show="tree headings", selectmode="browse")

    tree.heading("#0",        text="Name")
    tree.heading("type_col",  text="Type")
    tree.heading("count_col", text="Count")
    tree.heading("path_col",  text="Path")

    tree.column("#0",        width=340, minwidth=180, stretch=True)
    tree.column("type_col",  width=200, minwidth=80,  stretch=False)
    tree.column("count_col", width=64,  minwidth=48,  stretch=False)
    tree.column("path_col",  width=540, minwidth=200, stretch=True)

    # Row tags
    tree.tag_configure("system",   foreground=_TEXT_FG,      font=("Consolas", 9))
    tree.tag_configure("unused",   foreground="#C0392B",      font=("Consolas", 9, "bold"))
    tree.tag_configure("texture",  foreground=_TEXT_DIM,      font=("Consolas", 9))
    tree.tag_configure("material", foreground=_ACCENT_BLUE,   font=("Consolas", 9))
    tree.tag_configure("actor",    foreground=_ACCENT_GREEN,  font=("Consolas", 9))

    vsb = ttk.Scrollbar(tree_frame, orient="vertical",   command=tree.yview)
    hsb = ttk.Scrollbar(tree_frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

    vsb.pack(side="right",  fill="y")
    hsb.pack(side="bottom", fill="x")
    tree.pack(fill="both", expand=True)

    # ------------------------------------------------------------------
    # Status bar + footer
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
    count_label.pack(side=tk.LEFT)

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
        footer_logo.pack(side=tk.RIGHT, padx=(4, 0))
        footer_logo.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    status_var = tk.StringVar(value="Click Refresh to load Niagara systems.")
    status_bar = ttk.Label(root, textvariable=status_var, style="Status.TLabel", anchor="w")
    status_bar.pack(fill="x", side="bottom")

    # ------------------------------------------------------------------
    # Populate treeview from cached results + current filter state
    # ------------------------------------------------------------------
    def _apply_filter():
        """Re-populate the treeview from cached results applying current filters."""
        browse_result = _last_browse_result[0]
        usage_result  = _last_usage_result[0]

        if browse_result is None:
            return

        for row in tree.get_children():
            tree.delete(row)

        filter_text     = filter_entry.get().strip().lower()
        show_unused_only = _show_unused_state[0]

        # Build unused-path set for tag/filter lookup
        unused_paths = set()
        if usage_result is not None:
            unused_paths = set(usage_result["unused"])

        shown     = 0
        total     = browse_result["total_systems"]

        for sys_info in browse_result["systems"]:
            name = sys_info["name"]
            path = sys_info["path"]

            # Apply name / path filter
            if filter_text and filter_text not in name.lower() and filter_text not in path.lower():
                continue

            # Apply unused-only filter
            is_unused = path in unused_paths
            if show_unused_only and not is_unused:
                continue

            # Determine actor list for this system
            actor_list = []
            if usage_result is not None:
                actor_list = usage_result.get("used_by_actors", {}).get(path, [])

            tag = "unused" if is_unused else "system"
            dep_count = sys_info["total_dep_count"]

            display_name = (
                f"{name}  ({len(actor_list)} actor(s))"
                if actor_list
                else name
            )

            sys_id = tree.insert(
                "", "end",
                text=display_name,
                values=("NiagaraSystem", str(dep_count), path),
                tags=(tag,),
                open=False,
            )

            # Level 2: texture children
            for tex in sys_info["textures"]:
                tree.insert(
                    sys_id, "end",
                    text=tex["name"],
                    values=("Texture", "", tex["path"]),
                    tags=("texture",),
                )

            # Level 2: material children
            for mat in sys_info["materials"]:
                tree.insert(
                    sys_id, "end",
                    text=mat["name"],
                    values=("Material", "", mat["path"]),
                    tags=("material",),
                )

            # Level 2: actors using this system
            for actor_label in actor_list:
                tree.insert(
                    sys_id, "end",
                    text=actor_label,
                    values=("Actor", "", ""),
                    tags=("actor",),
                )

            shown += 1

        unused_count = len(unused_paths) if usage_result is not None else 0
        used_count   = total - unused_count if usage_result is not None else shown
        count_label_var.set(f"{used_count} used  |  {unused_count} unused")
        status_var.set(
            f"Showing {shown} of {total} systems  ({unused_count} unused)"
        )

    # ------------------------------------------------------------------
    # Refresh — re-scan registry and level actors
    # ------------------------------------------------------------------
    def _on_refresh():
        refresh_btn.configure(text="Scanning...", state="disabled")
        status_var.set("Scanning Asset Registry for Niagara systems...")
        root.update_idletasks()

        try:
            browse_result = browse_niagara(project_only=True)
            _last_browse_result[0] = browse_result

            status_var.set("Checking level actors for Niagara usage...")
            root.update_idletasks()
            usage_result = find_niagara_usage()
            _last_usage_result[0] = usage_result

            _apply_filter()
        except Exception as e:
            unreal.log_error(
                f"niagara_inspector UI: refresh failed — {traceback.format_exc()}"
            )
            status_var.set(f"Error during scan: {e}")
        finally:
            refresh_btn.configure(text="Refresh", state="normal")

    refresh_btn.configure(command=_on_refresh)

    # ------------------------------------------------------------------
    # Live filter — re-apply without re-scanning
    # ------------------------------------------------------------------
    filter_entry.bind("<KeyRelease>", lambda _e: _apply_filter())

    # Unused-only checkbox also re-applies filter immediately
    def _on_unused_toggle():
        _show_unused_state[0] = not _show_unused_state[0]
        _apply_filter()
    unused_only_check.config(command=_on_unused_toggle)

    # ------------------------------------------------------------------
    # Double-click — copy path to clipboard
    # ------------------------------------------------------------------
    def _on_double_click(_event):
        item = tree.focus()
        if not item:
            return
        values = tree.item(item, "values")
        if not values or len(values) < 3:
            return
        path = values[2]  # "Path" column (index 2)
        if not path:
            return
        if _copy_text_to_system_clipboard(path):
            status_var.set(f"Copied to clipboard: {path}")
            unreal.log(f"niagara_inspector: Copied to clipboard — {path}")
        else:
            _show_copy_fallback_popup(root, path, title="Copy asset path")

    tree.bind("<Double-1>", _on_double_click)

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

    # Auto-load on open
    _on_refresh()
    root.update()  # force initial render with stats populated

    unreal.log(
        "niagara_inspector: UI opened. Use show_niagara_inspector() to reopen if closed."
    )
