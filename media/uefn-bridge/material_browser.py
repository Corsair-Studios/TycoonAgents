"""
UEFN Material Browser
======================
Browse all project materials, inspect their texture dependencies, and find
unused materials in the current level.  Runs inside UEFN's embedded
Python 3.11 (requires the ``unreal`` module).

Provides three interfaces:
  1. **browse_materials()**        — Asset Registry scan; returns structured dict
  2. **find_unused_materials()**   — compare registry materials vs level actors
  3. **show_material_browser()**   — Tkinter UI with treeview and live filter

Usage:
    from material_browser import browse_materials, find_unused_materials
    from material_browser import show_material_browser
"""

import os
import unreal
import traceback

try:
    import tkinter as tk
    from tkinter import ttk
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Theme constants (matching launcher / batch_tools / texture_finder palette)
# ---------------------------------------------------------------------------

_BG          = "#D2CEC4"
_SECTION_BG  = "#EBE7DD"
_HEADER_FG   = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG     = "#2B2B2B"
_TEXT_DIM    = "#57524C"
_ENTRY_BG    = "#FBFAF6"
_ENTRY_FG    = "#1A1A1A"

# UI state for the tick pump
_tick_handle = [None]

# Cached scan results reused by the live filter (avoids re-scanning on keystrokes)
_last_browse_result   = [None]
_last_unused_result   = [None]


# ---------------------------------------------------------------------------
# Internal registry helpers
# ---------------------------------------------------------------------------

# Skip-list used for BOTH project_only=True and project_only=False: engine,
# script, and temp content are never real project content. Everything else —
# including plugin/content-pack mounts like /Jethro/ — is project content and
# must be included when project_only=True. Do NOT switch this back to an
# allow-list keyed on a single detected project prefix: that previously
# excluded valid plugin mounts that don't share the primary project prefix.
_SKIP_PREFIXES = ("/Engine/", "/Script/", "/Temp/")


def _get_asset_registry():
    return unreal.AssetRegistryHelpers.get_asset_registry()


def _class_path(engine_class_name, module="/Script/Engine"):
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
        unreal.log_warning(f"material_browser: Could not configure dep options — {e}. Using defaults.")
        try:
            return unreal.AssetRegistryDependencyOptions()
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Core browse function
# ---------------------------------------------------------------------------

def browse_materials(project_only=True):
    """
    Scan the Asset Registry for all Material and MaterialInstanceConstant assets
    and collect their Texture2D dependencies via ``get_dependencies()``.

    Parameters
    ----------
    project_only : bool
        When *True* (default) assets under ``/Engine/``, ``/Script/``, and
        ``/Temp/`` are excluded but every other content root — including
        plugin/content-pack mounts such as ``/Jethro/`` — is included.
        When *False* no filtering is applied at all; every material in the
        registry is returned, engine content included.

    Returns
    -------
    dict
        ``total_materials`` — total number of materials found

        ``materials`` — list of material dicts, sorted alphabetically by name.
        Each dict has:

        * ``name``          — asset name (str)
        * ``path``          — package path (str)
        * ``type``          — ``"Material"`` or ``"MaterialInstanceConstant"``
        * ``texture_count`` — number of Texture2D dependencies
        * ``textures``      — list of ``{"name": str, "path": str}`` dicts
    """
    registry = _get_asset_registry()
    dep_options = _make_dep_options()

    # ------------------------------------------------------------------
    # Build a set of all Texture2D package paths for dependency matching
    # ------------------------------------------------------------------
    unreal.log("material_browser: Fetching Texture2D assets from registry...")
    try:
        all_textures = registry.get_assets_by_class(_class_path("Texture2D"))
    except Exception as e:
        unreal.log_error(f"material_browser: Failed to get Texture2D assets — {e}")
        all_textures = []

    # Map package_name_str -> asset_name_str for quick name lookups
    texture_lookup = {}
    for asset_data in all_textures:
        pkg = str(asset_data.package_name)
        name = str(asset_data.asset_name)
        texture_lookup[pkg] = name

    unreal.log(f"material_browser: {len(texture_lookup)} Texture2D assets indexed")

    # ------------------------------------------------------------------
    # Gather Material + MaterialInstanceConstant assets
    # ------------------------------------------------------------------
    if project_only:
        unreal.log("material_browser: Project-only mode — excluding /Engine/, /Script/, /Temp/")

    material_assets = []
    for cls_name in ("Material", "MaterialInstanceConstant"):
        try:
            assets = registry.get_assets_by_class(_class_path(cls_name))
            if project_only:
                filtered = [
                    a for a in assets
                    if not any(str(a.package_name).startswith(p) for p in _SKIP_PREFIXES)
                ]
            else:
                filtered = list(assets)
            material_assets.extend((cls_name, a) for a in filtered)
            unreal.log(
                f"material_browser: {len(filtered)} {cls_name} asset(s) "
                f"(of {len(assets)} total)"
            )
        except Exception as e:
            unreal.log_warning(f"material_browser: Could not fetch {cls_name} assets — {e}")

    unreal.log(f"material_browser: {len(material_assets)} total material asset(s) to inspect")

    # ------------------------------------------------------------------
    # Walk each material, collect texture dependencies
    # ------------------------------------------------------------------
    results = []
    for idx, (cls_name, asset_data) in enumerate(material_assets):
        if idx > 0 and idx % 100 == 0:
            unreal.log(f"material_browser: Progress — {idx}/{len(material_assets)} materials processed...")

        pkg_name  = str(asset_data.package_name)
        asset_nm  = str(asset_data.asset_name)

        textures = []
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
        except Exception as e:
            unreal.log_warning(f"material_browser: get_dependencies failed for {pkg_name} — {e}")

        results.append({
            "name":          asset_nm,
            "path":          pkg_name,
            "type":          cls_name,
            "texture_count": len(textures),
            "textures":      textures,
        })

    # Sort alphabetically by name
    results.sort(key=lambda m: m["name"].lower())

    unreal.log(
        f"material_browser: Scan complete — {len(results)} materials, "
        f"{sum(m['texture_count'] for m in results)} total texture references"
    )

    return {
        "total_materials": len(results),
        "materials": results,
    }


# ---------------------------------------------------------------------------
# Unused-material detection
# ---------------------------------------------------------------------------

def _normalise(path):
    """Strip the trailing .<AssetName> suffix so that /Project/Mat.Mat matches /Project/Mat."""
    dot_idx = path.rfind(".")
    if dot_idx != -1:
        return path[:dot_idx]
    return path


def find_unused_materials(project_only=True):
    """
    Identify project materials that are not applied to any level actor.

    The function walks every actor in the level, collects every material
    path applied to mesh components, then compares that set against all
    materials returned by :func:`browse_materials`.

    Parameters
    ----------
    project_only : bool
        Passed through to :func:`browse_materials`. When *True*, materials
        under ``/Engine/``, ``/Script/``, and ``/Temp/`` are excluded; every
        other content root (including plugin/content-pack mounts) is
        included. When *False* no filtering is applied.

    Returns
    -------
    dict
        ``used``   — list of material path strings referenced by level actors

        ``unused`` — list of material path strings NOT referenced by any actor

        ``used_by_actors`` — dict mapping normalised material path to list of actor labels

        ``total_level_materials`` — number of unique material paths found on actors

        ``total_project_materials`` — total materials from registry

        ``used_count`` / ``unused_count`` — convenience counts
    """
    # ------------------------------------------------------------------
    # Step 1: collect materials applied to level actors
    # ------------------------------------------------------------------
    # used_by_actors: normalised_mat_path -> list of actor labels
    used_by_actors = {}

    component_classes = [unreal.StaticMeshComponent]
    try:
        component_classes.append(unreal.SkeletalMeshComponent)
    except AttributeError:
        pass

    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actors = subsystem.get_all_level_actors()
    except Exception as e:
        unreal.log_error(f"material_browser: Could not get level actors — {e}")
        actors = []

    unreal.log(f"material_browser: Walking {len(actors)} level actors for applied materials...")

    for actor in actors:
        try:
            actor_label = actor.get_actor_label()
        except Exception:
            continue
        for comp_class in component_classes:
            try:
                component = actor.get_component_by_class(comp_class)
                if component is None:
                    continue
                num = component.get_num_materials()
            except Exception:
                continue
            for i in range(num):
                try:
                    mat = component.get_material(i)
                    if mat is not None:
                        raw_path = mat.get_path_name()
                        norm = _normalise(raw_path)
                        if norm not in used_by_actors:
                            used_by_actors[norm] = []
                        if actor_label not in used_by_actors[norm]:
                            used_by_actors[norm].append(actor_label)
                except Exception:
                    continue

    unreal.log(f"material_browser: {len(used_by_actors)} unique material path(s) applied to level actors")

    # ------------------------------------------------------------------
    # Step 2: compare against registry materials
    # ------------------------------------------------------------------
    browse_result = browse_materials(project_only=project_only)
    all_materials = browse_result["materials"]

    used_list   = []
    candidate_unused = []

    for mat in all_materials:
        if mat["path"] in used_by_actors:
            used_list.append(mat["path"])
        else:
            candidate_unused.append(mat["path"])

    # A material absent from the CURRENT level is only a *candidate* for being
    # unused. Confirm against the Asset Registry reverse-reference graph (all
    # asset types, all levels) + Verse source text before flagging it, so we
    # never tell a developer an in-use asset is safe to delete.
    referenced_elsewhere = {}
    try:
        import asset_usage
        confirmed = asset_usage.confirm_orphans(candidate_unused, project_only=project_only)
    except Exception as e:
        unreal.log_warning(
            f"material_browser: orphan confirmation unavailable ({e}); "
            f"falling back to level-only result (may over-report unused)."
        )
        confirmed = {pkg: "level-only (registry check unavailable)" for pkg in candidate_unused}

    unused_list = []
    for pkg in candidate_unused:
        if pkg in confirmed:
            unused_list.append(pkg)
        else:
            # Referenced somewhere outside this level — NOT unused.
            used_list.append(pkg)
            try:
                referenced_elsewhere[pkg] = asset_usage.get_referencer_details(pkg, project_only=project_only)
            except Exception:
                referenced_elsewhere[pkg] = []

    unreal.log(
        f"material_browser: {len(used_list)} used "
        f"({len(referenced_elsewhere)} referenced outside the level), "
        f"{len(unused_list)} confirmed unused (of {len(all_materials)})"
    )

    return {
        "used":                    used_list,
        "unused":                  unused_list,
        "used_by_actors":          used_by_actors,
        "referenced_elsewhere":    referenced_elsewhere,
        "orphan_reasons":          confirmed,
        "total_level_materials":   len(used_by_actors),
        "total_project_materials": len(all_materials),
        "used_count":              len(used_list),
        "unused_count":            len(unused_list),
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_material_browser():
    """
    Open the Material Browser UI window.

    Features
    --------
    - Filter entry for real-time name substring filtering (no re-scan)
    - "Project Only" checkbox — limits results to the project prefix
    - "Show Unused Only" checkbox — filters to materials with no actor reference
    - Refresh button — re-runs :func:`browse_materials` and optionally
      :func:`find_unused_materials`
    - Hierarchical treeview:
        Level 1 — Material (Name | Type | Texture Count | Path)
        Level 2 — Texture dependency (texture name | "Texture" | "" | path)
    - Double-click a material/texture to select it in the Content Browser
      (actor rows select the actor in the level; clipboard copy is the fallback)
    - Status bar: "Showing X of Y materials (Z unused) [N textures total]"
    - Tkinter event pump via ``unreal.register_slate_post_tick_callback``
    """
    if not _HAS_TKINTER:
        unreal.log_error("material_browser: tkinter is not available in this environment.")
        return

    # ------------------------------------------------------------------
    # Root window
    # ------------------------------------------------------------------
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Material Browser")
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

    style.configure("Dark.TFrame",   background=_BG)
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

    ttk.Label(top_frame, text="Material Browser", style="Header.TLabel").pack(
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
    # Main treeview — 2 levels: material > texture dependency
    # Columns: Name (#0 tree) | Type | Tex Count | Path
    # ------------------------------------------------------------------
    tree_frame = ttk.Frame(root, style="Section.TFrame")
    tree_frame.pack(fill="both", expand=True, padx=10, pady=(4, 0))

    columns = ("type_col", "tex_count_col", "path_col")
    tree = ttk.Treeview(tree_frame, columns=columns, show="tree headings", selectmode="browse")

    tree.heading("#0",           text="Name")
    tree.heading("type_col",     text="Type")
    tree.heading("tex_count_col", text="Textures")
    tree.heading("path_col",     text="Path")

    tree.column("#0",            width=320, minwidth=180, stretch=True)
    tree.column("type_col",      width=200, minwidth=80,  stretch=False)
    tree.column("tex_count_col", width=72,  minwidth=60,  stretch=False)
    tree.column("path_col",      width=540, minwidth=200, stretch=True)

    # Row tags
    tree.tag_configure("material", foreground=_TEXT_FG,     font=("Consolas", 9))
    tree.tag_configure("unused",   foreground="#C0392B",    font=("Consolas", 9, "bold"))
    tree.tag_configure("texture",  foreground=_TEXT_DIM,    font=("Consolas", 9))
    tree.tag_configure("actor",    foreground=_ACCENT_GREEN, font=("Consolas", 9))

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

    status_var = tk.StringVar(value="Click Refresh to load materials.")
    status_bar = ttk.Label(root, textvariable=status_var, style="Status.TLabel", anchor="w")
    status_bar.pack(fill="x", side="bottom")

    # ------------------------------------------------------------------
    # Populate treeview from cached results + current filter state
    # ------------------------------------------------------------------
    def _apply_filter():
        """Re-populate the treeview from cached results applying current filters."""
        browse_result = _last_browse_result[0]
        unused_result = _last_unused_result[0]

        if browse_result is None:
            return

        for row in tree.get_children():
            tree.delete(row)

        filter_text = filter_entry.get().strip().lower()
        show_unused_only = _show_unused_state[0]

        # Build unused-path set for tag lookup
        unused_paths = set()
        if unused_result is not None:
            unused_paths = set(unused_result["unused"])

        shown   = 0
        total   = browse_result["total_materials"]
        total_tex = 0

        for mat in browse_result["materials"]:
            name = mat["name"]
            path = mat["path"]

            # Apply name filter
            if filter_text and filter_text not in name.lower() and filter_text not in path.lower():
                continue

            # Apply unused-only filter
            is_unused = path in unused_paths
            if show_unused_only and not is_unused:
                continue

            tag = "unused" if is_unused else "material"
            tex_count = mat["texture_count"]
            total_tex += tex_count

            # Show actor usage count next to name for used materials
            actor_list = []
            if unused_result and not is_unused:
                actor_list = unused_result.get("used_by_actors", {}).get(path, [])
            display_name = f"{name}  ({len(actor_list)} actor(s))" if actor_list else name

            mat_id = tree.insert(
                "", "end",
                text=display_name,
                values=(mat["type"], str(tex_count), path),
                tags=(tag,),
                open=False,
            )

            for tex in mat["textures"]:
                tree.insert(
                    mat_id, "end",
                    text=tex["name"],
                    values=("Texture", "", tex["path"]),
                    tags=("texture",),
                )

            # Show actors using this material (if any)
            for actor_label in actor_list:
                    tree.insert(
                        mat_id, "end",
                        text=actor_label,
                        values=("Actor", "", ""),
                        tags=("actor",),
                    )

            shown += 1

        unused_count = len(unused_paths) if unused_result else 0
        used_count = len(browse_result["materials"]) - unused_count if unused_result else shown
        count_label_var.set(f"{used_count} used  |  {unused_count} unused")
        status_var.set(
            f"Showing {shown} of {total} materials  "
            f"({unused_count} unused)  "
            f"[{total_tex} texture refs total]"
        )

    # ------------------------------------------------------------------
    # Refresh — re-scan registry
    # ------------------------------------------------------------------
    def _on_refresh():
        refresh_btn.configure(text="Scanning...", state="disabled")
        status_var.set("Scanning Asset Registry...")
        root.update_idletasks()

        try:
            project_only = True
            browse_result = browse_materials(project_only=project_only)
            _last_browse_result[0] = browse_result

            # Also compute unused-material info
            status_var.set("Checking level actors for unused materials...")
            root.update_idletasks()
            unused_result = find_unused_materials(project_only=project_only)
            _last_unused_result[0] = unused_result

            _apply_filter()
        except Exception as e:
            unreal.log_error(f"material_browser UI: refresh failed — {traceback.format_exc()}")
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
    # Double-click — select the asset in the Content Browser.
    # Material/texture rows sync the Content Browser; actor rows select
    # the actor in the level (mirrors the device tool). UEFN's Python
    # bindings vary, so every unreal.* access below is guarded; if the
    # Content Browser API is unavailable we fall back to clipboard copy
    # so a double-click is never a silent no-op.
    # ------------------------------------------------------------------
    def _select_in_content_browser(asset_path):
        """Sync the UEFN Content Browser to the asset at asset_path. Returns True on success."""
        if not asset_path:
            return False
        # Build an object path "/Folder/Pkg.Asset"; sync accepts package or
        # object paths, but the object form is the most reliable.
        last = asset_path.rstrip("/").split("/")[-1]
        obj_path = asset_path if "." in last else f"{asset_path}.{last}"
        try:
            lib = getattr(unreal, "EditorAssetLibrary", None)
            if lib is not None and hasattr(lib, "sync_browser_to_objects"):
                lib.sync_browser_to_objects([obj_path])
                return True
        except Exception as e:
            unreal.log_warning(f"material_browser: sync_browser_to_objects failed — {e}")
        # Fallback: load the asset, then sync to its resolved path.
        try:
            lib = getattr(unreal, "EditorAssetLibrary", None)
            if lib is not None and hasattr(lib, "load_asset") and hasattr(lib, "sync_browser_to_objects"):
                obj = lib.load_asset(asset_path)
                if obj is not None:
                    lib.sync_browser_to_objects([obj.get_path_name()])
                    return True
        except Exception as e:
            unreal.log_warning(f"material_browser: load+sync fallback failed — {e}")
        return False

    def _select_actor_by_label(label):
        """Select a level actor in the outliner by its display label (mirrors device_audit)."""
        if not label:
            return False
        try:
            subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
            actors = subsystem.get_all_level_actors()
            for actor in actors:
                try:
                    if actor.get_actor_label() == label:
                        subsystem.select_nothing()
                        subsystem.set_actor_selection_state(actor, True)
                        return True
                except Exception:
                    continue
        except Exception as e:
            unreal.log_warning(f"material_browser: actor select failed — {e}")
        return False

    def _on_double_click(_event):
        item = tree.focus()
        if not item:
            return
        values = tree.item(item, "values")
        tags = tree.item(item, "tags") or ()
        text = tree.item(item, "text") or ""
        path = values[2] if values and len(values) >= 3 else ""

        # Actor rows carry no path — select the actor in the level instead.
        if "actor" in tags and not path:
            label = text.strip()
            if _select_actor_by_label(label):
                status_var.set(f"Selected actor in level: {label}")
                unreal.log(f"material_browser: Selected actor — {label}")
            else:
                status_var.set(f"Could not find actor in level: {label}")
            return

        if not path:
            return

        # Asset rows (material or texture) — sync the Content Browser.
        if _select_in_content_browser(path):
            status_var.set(f"Selected in Content Browser: {path}")
            unreal.log(f"material_browser: Selected in Content Browser — {path}")
        else:
            # Never a no-op: fall back to the old clipboard behaviour.
            root.clipboard_clear()
            root.clipboard_append(path)
            status_var.set(f"Content Browser API unavailable — copied path to clipboard: {path}")
            unreal.log_warning(f"material_browser: CB sync unavailable, copied to clipboard — {path}")

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

    unreal.log("material_browser: UI opened. Use show_material_browser() to reopen if closed.")
