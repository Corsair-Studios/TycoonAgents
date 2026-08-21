"""
UEFN Reference Finder
======================
Find all project assets that reference a given asset (referencers),
or all assets that a given asset depends on (dependencies).
Runs inside UEFN's embedded Python 3.11 (requires unreal module).

Usage:
    from reference_finder import show_reference_finder
    show_reference_finder()
"""

import os
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

_BG         = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG  = "#1A1A1A"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG    = "#2B2B2B"
_TEXT_DIM   = "#57524C"


# ---------------------------------------------------------------------------
# Core query function
# ---------------------------------------------------------------------------

def find_references(query: str, mode: str = "referencers") -> dict:
    """
    Find asset references using the Unreal Asset Registry.

    Parameters
    ----------
    query : str
        Asset name (partial ok) or full package path like /MyProject/Foo/Bar
    mode : str
        "referencers" — find who uses this asset
        "dependencies" — find what this asset uses

    Returns
    -------
    dict with keys:
        "targets"  : list of matched target asset dicts (name, class, path)
        "results"  : list of referencing/dependency asset dicts (name, class, path)
        "error"    : str or None
    """
    if not _HAS_UNREAL:
        return {"targets": [], "results": [], "error": "unreal module not available"}

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()

        # --- Step 1: find the target asset(s) ---
        query = query.strip()
        if not query:
            return {"targets": [], "results": [], "error": "No query entered"}

        # Build filter — support full path or name search
        if query.startswith("/"):
            # Treat as exact package path
            ar_filter = unreal.ARFilter(
                package_names=[unreal.Name(query)],
                include_only_on_disk_assets=False,
            )
            matched = registry.get_assets(ar_filter)
        else:
            # ARFilter has no asset_names param — scan project assets and filter by name
            q_lower = query.lower()
            ar_filter = unreal.ARFilter(
                package_paths=[unreal.Name("/")],
                recursive_paths=True,
                include_only_on_disk_assets=False,
            )
            all_assets = registry.get_assets(ar_filter)
            matched = [a for a in all_assets if q_lower in str(a.asset_name).lower()]

        if not matched:
            return {"targets": [], "results": [], "error": f"No asset found matching '{query}'"}

        targets = [
            {
                "name": str(a.asset_name),
                "class": str(a.asset_class_path.asset_name) if hasattr(a, "asset_class_path") else str(getattr(a, "asset_class", "Unknown")),
                "path": str(a.package_name),
            }
            for a in matched
        ]

        # --- Step 2: get referencers or dependencies for each target ---
        # Use defensive attribute setting — attribute names vary across UE versions.
        # (Direct assignment without hasattr guards caused the include_hard_package_data
        # AttributeError crash in an older UEFN build.)
        dep_options = unreal.AssetRegistryDependencyOptions()
        for _attr in ("include_soft_package_references", "include_soft_package_data"):
            try:
                if hasattr(dep_options, _attr):
                    setattr(dep_options, _attr, True)
                    break
            except Exception:
                pass
        for _attr in ("include_hard_package_references", "include_hard_package_data"):
            try:
                if hasattr(dep_options, _attr):
                    setattr(dep_options, _attr, True)
                    break
            except Exception:
                pass
        for _attr in ("include_searchable_names",):
            try:
                if hasattr(dep_options, _attr):
                    setattr(dep_options, _attr, False)
            except Exception:
                pass
        for _attr in ("include_soft_management_references",):
            try:
                if hasattr(dep_options, _attr):
                    setattr(dep_options, _attr, False)
            except Exception:
                pass
        for _attr in ("include_hard_management_references",):
            try:
                if hasattr(dep_options, _attr):
                    setattr(dep_options, _attr, False)
            except Exception:
                pass

        seen = set()
        results = []
        for target in targets:
            pkg = target["path"]
            if mode == "referencers":
                refs = registry.get_referencers(pkg, dep_options)
            else:
                refs = registry.get_dependencies(pkg, dep_options)

            for ref_pkg in refs:
                ref_str = str(ref_pkg)
                if ref_str in seen:
                    continue
                seen.add(ref_str)

                # Look up asset info for this package
                ref_filter = unreal.ARFilter(
                    package_names=[unreal.Name(ref_str)],
                    include_only_on_disk_assets=False,
                )
                ref_assets = registry.get_assets(ref_filter)
                if ref_assets:
                    a = ref_assets[0]
                    asset_class = str(a.asset_class_path.asset_name) if hasattr(a, "asset_class_path") else str(getattr(a, "asset_class", "Unknown"))
                    results.append({
                        "name": str(a.asset_name),
                        "class": asset_class,
                        "path": ref_str,
                    })
                else:
                    # Package exists in registry but no asset data — include path only
                    pkg_name = ref_str.split("/")[-1]
                    results.append({
                        "name": pkg_name,
                        "class": "—",
                        "path": ref_str,
                    })

        results.sort(key=lambda r: r["path"])
        return {"targets": targets, "results": results, "error": None}

    except Exception as e:
        return {"targets": [], "results": [], "error": str(e)}


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

def show_reference_finder():
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("reference_finder: tkinter is not available.")
        return

    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Reference Finder")
    root.geometry("900x560")
    root.minsize(700, 400)
    root.configure(bg=_BG)

    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", background=_BG, foreground=_TEXT_FG)
    style.configure("TFrame", background=_BG)
    style.configure("TScrollbar", background=_SECTION_BG, troughcolor=_BG, borderwidth=0)
    style.configure("TCombobox", fieldbackground=_SECTION_BG, background=_SECTION_BG,
                    foreground=_TEXT_FG)
    style.map("TCombobox", fieldbackground=[("readonly", _SECTION_BG)],
              foreground=[("readonly", _TEXT_FG)])
    style.configure("RF.Treeview",
        background=_SECTION_BG, foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG, rowheight=22, font=("Consolas", 9))
    style.configure("RF.Treeview.Heading",
        background=_BG, foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"), relief="flat")
    style.map("RF.Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])
    style.configure("Accent.TButton",
        background=_ACCENT_BLUE, foreground="#1A1A1A",
        font=("Segoe UI", 10, "bold"), padding=(12, 5), relief="flat")
    style.map("Accent.TButton", background=[("active", "#D24E1F")])

    # Header
    header_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    header_frame.pack(fill=tk.X)

    tk.Label(header_frame, text="Reference Finder",
             font=("Segoe UI", 15, "bold"), fg=_HEADER_FG, bg=_BG).pack(anchor=tk.W)
    tk.Label(header_frame,
             text="Find which assets reference a given asset, or what an asset depends on.",
             font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG).pack(anchor=tk.W)

    # Search row
    search_frame = tk.Frame(root, bg=_BG, padx=16, pady=4)
    search_frame.pack(fill=tk.X)

    tk.Label(search_frame, text="Asset:", font=("Segoe UI", 9),
             fg=_TEXT_DIM, bg=_BG).pack(side=tk.LEFT, padx=(0, 6))

    query_var = tk.StringVar(master=root)
    query_entry = tk.Entry(search_frame, textvariable=query_var,
                           font=("Segoe UI", 10), bg=_SECTION_BG, fg=_TEXT_FG,
                           insertbackground=_TEXT_FG, relief="flat", width=36)
    query_entry.pack(side=tk.LEFT, padx=(0, 8))

    mode_var = tk.StringVar(value="referencers")
    mode_combo = ttk.Combobox(search_frame, textvariable=mode_var,
                              values=["referencers", "dependencies"],
                              state="readonly", width=14)
    mode_combo.pack(side=tk.LEFT, padx=(0, 8))

    find_btn = ttk.Button(search_frame, text="Find", style="Accent.TButton")
    find_btn.pack(side=tk.LEFT)

    # Status bar (between search and tree)
    status_var = tk.StringVar(value="Enter an asset name or path and click Find.")
    status_label = tk.Label(root, textvariable=status_var,
                            font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
                            anchor="w", padx=16, pady=4)
    status_label.pack(fill=tk.X)

    # Tree area with scrollbars
    tree_frame = tk.Frame(root, bg=_BG, padx=16, pady=0)
    tree_frame.pack(fill=tk.BOTH, expand=True)

    vsb = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL)
    vsb.pack(side=tk.RIGHT, fill=tk.Y)
    hsb = ttk.Scrollbar(tree_frame, orient=tk.HORIZONTAL)
    hsb.pack(side=tk.BOTTOM, fill=tk.X)

    tree = ttk.Treeview(tree_frame,
                        columns=("type", "name", "path"),
                        show="headings", style="RF.Treeview",
                        yscrollcommand=vsb.set, xscrollcommand=hsb.set)
    vsb.config(command=tree.yview)
    hsb.config(command=tree.xview)

    tree.heading("type", text="Type")
    tree.heading("name", text="Asset Name")
    tree.heading("path", text="Package Path")
    tree.column("type", width=160, minwidth=80, stretch=False)
    tree.column("name", width=220, minwidth=100, stretch=False)
    tree.column("path", width=480, minwidth=200, stretch=True)
    tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

    # Footer
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM)

    result_count_label = tk.Label(footer_frame, text="",
                                  font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_SECTION_BG)
    result_count_label.pack(side=tk.LEFT)

    social = tk.Label(footer_frame, text="@thetrashbyrd",
                      font=("Segoe UI", 8), fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2")
    social.pack(side=tk.RIGHT, padx=(0, 4))
    social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # Find logic
    def _on_find(*_args):
        query = query_var.get().strip()
        if not query:
            status_var.set("Enter an asset name or path and click Find.")
            return

        find_btn.configure(state="disabled", text="Searching...")
        status_var.set(f"Searching for '{query}'...")
        root.update_idletasks()

        for row in tree.get_children():
            tree.delete(row)
        result_count_label.config(text="")

        data = find_references(query, mode=mode_var.get())

        if data["error"]:
            status_var.set(f"Error: {data['error']}")
            find_btn.configure(state="normal", text="Find")
            return

        for r in data["results"]:
            tree.insert("", tk.END, values=(r["class"], r["name"], r["path"]))

        n = len(data["results"])
        target_names = ", ".join(t["name"] for t in data["targets"])
        mode_label = "referencer(s)" if mode_var.get() == "referencers" else "dependenc(ies)"
        status_var.set(f"{n} {mode_label} found for: {target_names}")
        result_count_label.config(text=f"{n} results")
        find_btn.configure(state="normal", text="Find")

    find_btn.configure(command=_on_find)
    query_entry.bind("<Return>", _on_find)

    # Tick pump
    _tick_handle = [None]

    def _tick(_dt):
        try:
            if root.winfo_exists():
                root.update()
            else:
                if _tick_handle[0]:
                    unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                    _tick_handle[0] = None
        except tk.TclError:
            if _tick_handle[0]:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None
        except Exception:
            pass

    def _on_close():
        if _tick_handle[0]:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    if _HAS_UNREAL:
        _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)

    root.update()

    if _HAS_UNREAL:
        unreal.log("reference_finder: Reference Finder window opened.")
