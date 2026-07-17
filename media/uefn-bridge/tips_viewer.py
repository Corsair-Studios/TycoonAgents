"""
UEFN Tips & Features Viewer
============================
Static tip browser for UEFN gotchas, less-known features, and workflow tips.
Runs inside UEFN's embedded Python 3.11 (unreal module optional — works standalone too).

Usage:
    from tips_viewer import show_tips_viewer
    show_tips_viewer()
"""

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
# Theme constants (matching project palette)
# ---------------------------------------------------------------------------

_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"
_CARD_HOVER = "#F6E7DB"


# ---------------------------------------------------------------------------
# Tips data
# ---------------------------------------------------------------------------

_TIPS = [
    # Publishing & Validation
    {
        "category": "Publishing",
        "title": "CandidateApiJsonInvalid blocks session start",
        "body": (
            "Valkyrie validates your module's public API against the previously published version. "
            "If assets that were in the last publish are now missing from disk, you'll get "
            "CandidateApiJsonInvalid and cannot start a session or publish. "
            "Fix: restore or recreate the missing assets, then republish."
        ),
    },
    {
        "category": "Publishing",
        "title": "Valkyrie paths differ from Asset Registry paths",
        "body": (
            "Valkyrie uses module-system paths like Packages/Fortress_SharedMaterials/... "
            "The Asset Registry uses /Game/ or /MyProject/ paths. These are incompatible — "
            "you cannot resolve a Valkyrie error by searching the Asset Registry directly."
        ),
    },
    {
        "category": "Publishing",
        "title": "File a DevSupport ticket for persistent Valkyrie errors",
        "body": (
            "If you've restored all missing assets but still get Valkyrie errors, the module "
            "manifest may be out of sync on Epic's side. File a ticket at dev.epicgames.com "
            "with your project name and the full error log."
        ),
    },
    # Asset Management
    {
        "category": "Asset Management",
        "title": "OneDrive 'online-only' files appear missing to UEFN",
        "body": (
            "If your project is in an OneDrive folder, files marked 'online-only' exist in the "
            "cloud but not on disk. UEFN sees them as missing, causing load errors. "
            "Fix: right-click the file or project folder in Explorer → 'Always keep on this device'."
        ),
    },
    {
        "category": "Asset Management",
        "title": "Deleted assets leave stale Asset Registry entries",
        "body": (
            "The Asset Registry is rebuilt from cache on project open. If you delete a .uasset "
            "outside of UEFN (e.g., via Explorer or OneDrive), the registry entry persists until "
            "the next full rebuild. Use Project Health → Ghost Asset check to find these."
        ),
    },
    {
        "category": "Asset Management",
        "title": "/_Verse/ packages have no .uasset on disk",
        "body": (
            "The Asset Registry indexes Verse-compiled types (e.g., $DebugData, achievement_trigger_type) "
            "as packages under /_Verse/. These are compile artifacts — there are no corresponding "
            ".uasset files on disk. Do not treat them as ghost assets."
        ),
    },
    {
        "category": "Asset Management",
        "title": "__ExternalActors__ packages are synthetic",
        "body": (
            "World partition maps generate __ExternalActors__ and __ExternalObjects__ sub-packages "
            "in the Asset Registry. These are synthetic references with no individual .uasset files — "
            "they map to regions within the .umap file itself."
        ),
    },
    # Python Scripting
    {
        "category": "Python Scripting",
        "title": "Use importlib.reload() to avoid restarting UEFN",
        "body": (
            "After editing a Python script, call importlib.reload(module_name) from the Python "
            "console instead of restarting UEFN. This re-executes the module from disk without "
            "losing your editor session. Pattern:\n"
            "  import importlib, my_module\n"
            "  importlib.reload(my_module)\n"
            "  my_module.run()"
        ),
    },
    {
        "category": "Python Scripting",
        "title": "Delete __pycache__ when scripts seem stuck on old versions",
        "body": (
            "Python caches compiled bytecode in a __pycache__ folder. In rare cases these can "
            "become stale and serve old code even after importlib.reload(). "
            "Fix: delete the __pycache__ folder in Content/Python/, then restart UEFN."
        ),
    },
    {
        "category": "Python Scripting",
        "title": "unreal.Paths.project_dir() returns the Fortnite install dir",
        "body": (
            "Never use unreal.Paths.project_dir() to locate your project's Content folder. "
            "It returns a relative path to the Fortnite installation (../../../FortniteGame/), "
            "not your UEFN project root. Instead use:\n"
            "  os.path.dirname(os.path.abspath(__file__))\n"
            "to get the directory containing your script."
        ),
    },
    {
        "category": "Python Scripting",
        "title": "Python runs editor-only — not at gameplay runtime",
        "body": (
            "UEFN Python scripting (added in v40.00) is an editor automation feature only. "
            "Scripts run in the editor process and cannot execute during a play session. "
            "Use Verse for runtime gameplay logic."
        ),
    },
    {
        "category": "Python Scripting",
        "title": "Load errors at startup are not visible to Python tools",
        "body": (
            "Errors like 'FPackageName: Skipped package ... does not exist' fire at the "
            "Package Loader layer (physical file read), before the Asset Registry is queried. "
            "Python tools only access the Asset Registry layer and cannot intercept these errors. "
            "Watch the Output Log on startup for load errors."
        ),
    },
    # Performance
    {
        "category": "Performance",
        "title": "Large files (>50 MB) impact load times and memory",
        "body": (
            "Individual .uasset files over 50 MB can significantly increase load times and editor "
            "memory usage. Common culprits: high-resolution textures, large Niagara caches, and "
            "merged actor meshes. Use Project Health to find oversized files."
        ),
    },
    {
        "category": "Performance",
        "title": "Deep file paths (>200 chars) can cause Windows failures",
        "body": (
            "Windows has a 260-character path limit by default. Files with paths exceeding 200 "
            "characters risk silent failures during copy, version control, or packaging. "
            "Keep folder hierarchies shallow and avoid long asset names."
        ),
    },
    {
        "category": "Performance",
        "title": "Duplicate filenames across folders cause reference ambiguity",
        "body": (
            "If the same filename exists in multiple Content subfolders, asset references can "
            "resolve to the wrong file depending on search order. Use Project Health to detect "
            "duplicate names and consider renaming to make them unique."
        ),
    },
    # Devices
    {
        "category": "Devices",
        "title": "Device Audit shows only non-default property values",
        "body": (
            "The Device Audit tool compares each device's properties against the Class Default "
            "Object (CDO). Only properties that differ from defaults are shown, making it easy "
            "to spot intentional customizations vs. misconfigured devices."
        ),
    },
    {
        "category": "Devices",
        "title": "Missing material/VFX references cause silent load failures",
        "body": (
            "If a material or Niagara system references an asset that no longer exists, UEFN "
            "silently falls back to a default material at load time. The reference error only "
            "appears in the Output Log. Use Material Browser and Niagara Inspector to find "
            "broken references."
        ),
    },
    # MCP / AI Integration
    {
        "category": "MCP / AI",
        "title": "Call uefn_status first to verify bridge connectivity",
        "body": (
            "Before calling any other MCP tool, call uefn_status to confirm the bridge is "
            "connected and UEFN is running with the project open. If the heartbeat is older "
            "than 15 seconds, the bridge has stalled and needs UEFN to be restarted."
        ),
    },
    {
        "category": "MCP / AI",
        "title": "actor_label matches the Outliner display name",
        "body": (
            "MCP tool parameters like actor_label must match the label shown in UEFN's Outliner "
            "panel exactly (case-sensitive). If an actor has been renamed, update your queries "
            "to use the new label."
        ),
    },
]

_TOTAL_TIPS = len(_TIPS)


# ---------------------------------------------------------------------------
# Main widget
# ---------------------------------------------------------------------------

def show_tips_viewer():
    """Create and display the UEFN Tips & Features viewer window."""
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("tips_viewer: tkinter is not available.")
        return

    # Use Toplevel if a root already exists, otherwise create one
    if tk._default_root is not None:
        root = tk.Toplevel(tk._default_root)
    else:
        root = tk.Tk()

    root.title("Trashbyrd's UEFN Tips")
    root.geometry("780x600")
    root.minsize(600, 400)
    root.configure(bg=_BG)

    # -----------------------------------------------------------------------
    # Style
    # -----------------------------------------------------------------------
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", background=_BG, foreground=_TEXT_FG)
    style.configure("TFrame", background=_BG)
    style.configure("TScrollbar", background=_SECTION_BG, troughcolor=_BG, borderwidth=0)
    style.configure("Tips.Treeview", background=_SECTION_BG, foreground=_TEXT_FG,
                    fieldbackground=_SECTION_BG, rowheight=22, font=("Segoe UI", 9))
    style.configure("Tips.Treeview.Heading", background=_BG, foreground=_HEADER_FG,
                    font=("Segoe UI", 9, "bold"), relief="flat")
    style.map("Tips.Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])
    style.configure("TCombobox", fieldbackground=_SECTION_BG, background=_SECTION_BG,
                    foreground=_TEXT_FG)

    # -----------------------------------------------------------------------
    # Top bar — title + subtitle
    # -----------------------------------------------------------------------
    header_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    header_frame.pack(fill=tk.X)

    tk.Label(
        header_frame,
        text="UEFN Tips & Features",
        font=("Segoe UI", 15, "bold"),
        fg=_HEADER_FG,
        bg=_BG,
    ).pack(anchor=tk.W)

    tk.Label(
        header_frame,
        text="Less obvious features, known gotchas, and workflow tips.",
        font=("Segoe UI", 9),
        fg=_TEXT_DIM,
        bg=_BG,
    ).pack(anchor=tk.W)

    # -----------------------------------------------------------------------
    # Filter row
    # -----------------------------------------------------------------------
    filter_frame = tk.Frame(root, bg=_BG, padx=16, pady=3)
    filter_frame.pack(fill=tk.X)

    tk.Label(filter_frame, text="Filter:", font=("Segoe UI", 9),
             fg=_TEXT_DIM, bg=_BG).pack(side=tk.LEFT, padx=(0, 4))

    filter_var = tk.StringVar()
    filter_entry = tk.Entry(
        filter_frame,
        textvariable=filter_var,
        font=("Segoe UI", 9),
        bg=_SECTION_BG,
        fg=_TEXT_FG,
        insertbackground=_TEXT_FG,
        relief="flat",
        width=30,
    )
    filter_entry.pack(side=tk.LEFT, padx=(0, 12))

    tk.Label(filter_frame, text="Category:", font=("Segoe UI", 9),
             fg=_TEXT_DIM, bg=_BG).pack(side=tk.LEFT, padx=(0, 4))

    # Build unique category list (preserve order of first appearance)
    _seen = set()
    _categories = ["All"]
    for tip in _TIPS:
        c = tip["category"]
        if c not in _seen:
            _seen.add(c)
            _categories.append(c)

    cat_var = tk.StringVar(value="All")
    cat_combo = ttk.Combobox(
        filter_frame,
        textvariable=cat_var,
        values=_categories,
        state="readonly",
        width=20,
    )
    cat_combo.pack(side=tk.LEFT, padx=(0, 12))

    count_label = tk.Label(
        filter_frame,
        text=f"{_TOTAL_TIPS} of {_TOTAL_TIPS} tips",
        font=("Segoe UI", 9),
        fg=_TEXT_DIM,
        bg=_BG,
    )
    count_label.pack(side=tk.LEFT)

    # -----------------------------------------------------------------------
    # Tree + scrollbar
    # -----------------------------------------------------------------------
    tree_frame = tk.Frame(root, bg=_BG, padx=16, pady=0)
    tree_frame.pack(fill=tk.BOTH, expand=True)

    tree_scroll = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL)
    tree_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    tree = ttk.Treeview(
        tree_frame,
        columns=("category", "title"),
        show="headings",
        style="Tips.Treeview",
        yscrollcommand=tree_scroll.set,
    )
    tree_scroll.config(command=tree.yview)

    tree.heading("category", text="Category")
    tree.heading("title", text="Title")
    tree.column("category", width=160, stretch=False)
    tree.column("title", width=560, stretch=True)

    tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

    # -----------------------------------------------------------------------
    # Detail panel
    # -----------------------------------------------------------------------
    detail_frame = tk.Frame(root, bg=_BG, padx=16, pady=6)
    detail_frame.pack(fill=tk.X)

    detail_text = tk.Text(
        detail_frame,
        bg=_SECTION_BG,
        fg=_TEXT_FG,
        font=("Segoe UI", 9),
        wrap=tk.WORD,
        relief="flat",
        state="disabled",
        height=6,
        padx=8,
        pady=6,
    )
    detail_text.pack(fill=tk.X)

    # -----------------------------------------------------------------------
    # Footer
    # -----------------------------------------------------------------------
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM)

    footer_count = tk.Label(
        footer_frame,
        text=f"{_TOTAL_TIPS} tips",
        font=("Segoe UI", 8),
        fg=_TEXT_DIM,
        bg=_SECTION_BG,
    )
    footer_count.pack(side=tk.LEFT)

    social = tk.Label(
        footer_frame,
        text="@thetrashbyrd",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_SECTION_BG,
        cursor="hand2",
    )
    social.pack(side=tk.RIGHT, padx=(0, 4))
    social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    hashtag = tk.Label(
        footer_frame,
        text="#uefntips on X →",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_SECTION_BG,
        cursor="hand2",
    )
    hashtag.pack(side=tk.RIGHT, padx=(0, 12))
    hashtag.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/search?q=%23uefntips"))

    # -----------------------------------------------------------------------
    # Filtering logic
    # -----------------------------------------------------------------------
    # Map iid -> tip dict for fast lookup
    _iid_to_tip = {}

    def _populate(tips_subset):
        """Clear tree and insert the given list of tips."""
        for iid in tree.get_children():
            tree.delete(iid)
        _iid_to_tip.clear()
        for tip in tips_subset:
            iid = tree.insert("", tk.END, values=(tip["category"], tip["title"]))
            _iid_to_tip[iid] = tip
        shown = len(tips_subset)
        count_label.config(text=f"{shown} of {_TOTAL_TIPS} tips")
        footer_count.config(text=f"{shown} tips")
        # Clear detail panel when filter changes
        detail_text.config(state="normal")
        detail_text.delete("1.0", tk.END)
        detail_text.config(state="disabled")

    def _apply_filter(*_args):
        text_filter = filter_var.get().lower()
        category_filter = cat_var.get()
        result = []
        for tip in _TIPS:
            if category_filter != "All" and tip["category"] != category_filter:
                continue
            if text_filter and (
                text_filter not in tip["title"].lower()
                and text_filter not in tip["body"].lower()
            ):
                continue
            result.append(tip)
        _populate(result)

    filter_var.trace_add("write", _apply_filter)
    filter_entry.bind("<KeyRelease>", _apply_filter)
    cat_combo.bind("<<ComboboxSelected>>", _apply_filter)

    # -----------------------------------------------------------------------
    # Selection handler — show body in detail panel
    # -----------------------------------------------------------------------
    def _on_select(_event):
        selection = tree.selection()
        if not selection:
            return
        iid = selection[0]
        tip = _iid_to_tip.get(iid)
        if tip is None:
            return
        detail_text.config(state="normal")
        detail_text.delete("1.0", tk.END)
        detail_text.insert(tk.END, tip["body"])
        detail_text.config(state="disabled")

    tree.bind("<<TreeviewSelect>>", _on_select)

    # -----------------------------------------------------------------------
    # Initial population
    # -----------------------------------------------------------------------
    _populate(_TIPS)

    # -----------------------------------------------------------------------
    # Tick pump (Unreal event loop integration)
    # -----------------------------------------------------------------------
    _tick_handle = [None]

    def _cleanup():
        if _tick_handle[0] is not None and _HAS_UNREAL:
            try:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            except Exception:
                pass
            _tick_handle[0] = None

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

    if _HAS_UNREAL:
        _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)

    def _on_close():
        _cleanup()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    if _HAS_UNREAL:
        unreal.log("tips_viewer: Tips & Features window opened.")
