"""
Trashbyrd's Power Tools — Dead Asset Sweep
==========================================
Project-wide unused-asset report across ALL asset types discoverable via the
Asset Registry.  Runs inside UEFN's embedded Python 3.11 (requires the
``unreal`` module).

IMPORTANT DISCLAIMER: "No references found" means the Asset Registry reverse-
reference graph and a Verse source-text cross-check found zero references.
It does NOT mean the asset is safe to delete.  Dynamic string-path runtime
loads (e.g. ``LoadObject<T>(nullptr, TEXT("..."))`` or Verse ``LoadAsset``)
are invisible to this scan.  ALWAYS verify before deleting any asset.

Public API:
    sweep_dead_assets(project_only=True) -> dict
        Full scan result (structured dict).
    show_asset_sweep()
        Open the Tkinter report window.
"""

import os
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

# Re-use the PROVEN orphan-detection core — do NOT reinvent.
from asset_usage import confirm_orphans, get_project_prefix


# ---------------------------------------------------------------------------
# Theme constants (matching project palette)
# ---------------------------------------------------------------------------

_BG           = "#D2CEC4"
_SECTION_BG   = "#EBE7DD"
_HEADER_FG    = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE  = "#F15B29"
_ACCENT_RED   = "#C0392B"
_TEXT_FG      = "#2B2B2B"
_TEXT_DIM     = "#57524C"
_ENTRY_BG     = "#FBFAF6"
_ENTRY_FG     = "#1A1A1A"

# UI state for the tick pump
_tick_handle = [None]

# Cached scan result reused by the live filter / sort
_last_sweep_result = [None]

# ---------------------------------------------------------------------------
# Asset classes to enumerate — add more as UEFN exposes them
# ---------------------------------------------------------------------------

_ASSET_CLASSES = [
    ("StaticMesh",               "/Script/Engine"),
    ("SkeletalMesh",             "/Script/Engine"),
    ("Material",                 "/Script/Engine"),
    ("MaterialInstanceConstant", "/Script/Engine"),
    ("Texture2D",                "/Script/Engine"),
    ("NiagaraSystem",            "/Script/Niagara"),
    ("NiagaraEmitter",           "/Script/Niagara"),
    ("SoundWave",                "/Script/Engine"),
    ("SoundCue",                 "/Script/Engine"),
    ("Blueprint",                "/Script/Engine"),
    ("AnimSequence",             "/Script/Engine"),
    ("AnimBlueprint",            "/Script/Engine"),
    ("PhysicsAsset",             "/Script/Engine"),
    ("ParticleSystem",           "/Script/Engine"),
    ("DataTable",                "/Script/Engine"),
    ("CurveFloat",               "/Script/Engine"),
    ("CurveVector",              "/Script/Engine"),
    ("MediaTexture",             "/Script/MediaAssets"),
    ("FileMediaSource",          "/Script/MediaAssets"),
]

_SKIP_PREFIXES = ("/Engine/", "/Script/")


# ---------------------------------------------------------------------------
# Size estimation helper
# ---------------------------------------------------------------------------

def _estimate_size_bytes(asset_data):
    """
    Try to get an estimated on-disk size for an AssetData entry.

    Attempts AssetRegistry tag "DiskSize" first (available on many asset types
    in UE5+).  Falls back to zero if unavailable — callers should treat 0 as
    "size unknown".
    """
    try:
        tag_val = asset_data.get_tag_value("DiskSize")
        if tag_val and str(tag_val).lstrip("-").isdigit():
            v = int(tag_val)
            return max(0, v)
    except Exception:
        pass
    # Fallback: try SizeX*SizeY*4 heuristic for Texture2D
    try:
        cls = _asset_type_label(asset_data.asset_class_path).lower()
        if "texture2d" in cls:
            sx = asset_data.get_tag_value("SizeX")
            sy = asset_data.get_tag_value("SizeY")
            if sx and sy:
                return int(sx) * int(sy) * 4
    except Exception:
        pass
    return 0


def _fmt_size(size_bytes):
    """Human-readable byte size string."""
    if size_bytes <= 0:
        return "?"
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    if size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.2f} MB"
    return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def _asset_type_label(class_path):
    """Infer a short human-readable type label from an AssetClassPath.

    In UEFN, ``str(TopLevelAssetPath)`` can yield a struct repr like
    ``<Struct 'TopLevelAssetPath' (0x...)>`` instead of a
    ``/Script/Module.ClassName`` string, so prefer the ``.asset_name`` field
    (the class name, e.g. "StaticMesh") when it is present.
    """
    try:
        asset_name = getattr(class_path, "asset_name", None)
        if asset_name is not None:
            an = str(asset_name)
            if an and "Struct" not in an:
                return an
    except Exception:
        pass
    s = str(class_path)
    # Take just the class name part after the last '.'
    if "." in s:
        return s.split(".")[-1]
    return s


# ---------------------------------------------------------------------------
# Core scan function
# ---------------------------------------------------------------------------

def sweep_dead_assets(project_only=True):
    """
    Enumerate all project assets across all known asset types, then route
    every candidate through ``asset_usage.confirm_orphans()`` — the proven
    reverse-reference-graph + Verse source-text cross-check.

    Parameters
    ----------
    project_only : bool
        When True (default) restrict the scan to project-prefixed paths.

    Returns
    -------
    dict::
        {
            "total_scanned":       int,
            "orphan_count":        int,
            "total_size_bytes":    int,   # sum of est. sizes for orphans
            "by_type": {
                "<AssetType>": [
                    {
                        "name":       str,
                        "path":       str,
                        "size_bytes": int,
                        "size_label": str,
                        "reason":     str,
                    },
                    ...
                ],
                ...
            },
        }
    """
    if not _HAS_UNREAL:
        return {
            "error": "unreal module not available",
            "total_scanned": 0,
            "orphan_count": 0,
            "total_size_bytes": 0,
            "by_type": {},
        }

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    except Exception as e:
        return {
            "error": f"Could not get AssetRegistry: {e}",
            "total_scanned": 0,
            "orphan_count": 0,
            "total_size_bytes": 0,
            "by_type": {},
        }

    try:
        project_prefix = get_project_prefix() if project_only else None
    except Exception as e:
        unreal.log_warning(f"asset_sweep: get_project_prefix failed — {e}; using /Game/")
        project_prefix = "/Game/"

    unreal.log(
        f"asset_sweep: Starting Dead Asset Sweep "
        f"(project_only={project_only}, prefix={project_prefix})"
    )

    # ------------------------------------------------------------------
    # Step 1 — collect all candidates across all asset types
    # ------------------------------------------------------------------
    # pkg_path -> {"name": str, "type": str, "size_bytes": int}
    candidates = {}

    for cls_name, module in _ASSET_CLASSES:
        try:
            class_path = unreal.TopLevelAssetPath(module, cls_name)
            assets = registry.get_assets_by_class(class_path)
        except Exception as e:
            unreal.log_warning(f"asset_sweep: Could not fetch {cls_name} — {e}")
            continue

        for asset_data in assets:
            try:
                pkg = str(asset_data.package_name)
                if any(pkg.startswith(p) for p in _SKIP_PREFIXES):
                    continue
                if project_only and project_prefix and not pkg.startswith(project_prefix):
                    continue
                if pkg not in candidates:
                    size_b = _estimate_size_bytes(asset_data)
                    candidates[pkg] = {
                        "name": str(asset_data.asset_name),
                        "type": _asset_type_label(asset_data.asset_class_path),
                        "size_bytes": size_b,
                    }
            except Exception:
                continue

    total_scanned = len(candidates)
    unreal.log(f"asset_sweep: {total_scanned} candidate asset(s) collected — running orphan check…")

    # ------------------------------------------------------------------
    # Step 2 — route ALL candidates through confirm_orphans()
    # ------------------------------------------------------------------
    try:
        orphan_map = confirm_orphans(
            list(candidates.keys()),
            project_only=project_only,
            registry=registry,
        )
    except Exception as e:
        unreal.log_warning(f"asset_sweep: confirm_orphans raised — {e}")
        orphan_map = {}

    unreal.log(f"asset_sweep: {len(orphan_map)} confirmed orphan(s) out of {total_scanned} scanned.")

    # ------------------------------------------------------------------
    # Step 3 — group confirmed orphans by type and tally size
    # ------------------------------------------------------------------
    by_type = {}
    total_size_bytes = 0

    for pkg, reason in orphan_map.items():
        info = candidates.get(pkg, {})
        asset_type = info.get("type", "Unknown")
        name = info.get("name", pkg.rsplit("/", 1)[-1])
        size_b = info.get("size_bytes", 0)
        total_size_bytes += size_b

        entry = {
            "name":       name,
            "path":       pkg,
            "type":       asset_type,
            "size_bytes": size_b,
            "size_label": _fmt_size(size_b),
            "reason":     reason,
        }
        by_type.setdefault(asset_type, []).append(entry)

    # Sort each group by size descending (largest first)
    for group in by_type.values():
        group.sort(key=lambda e: e["size_bytes"], reverse=True)

    return {
        "total_scanned":    total_scanned,
        "orphan_count":     len(orphan_map),
        "total_size_bytes": total_size_bytes,
        "by_type":          by_type,
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_asset_sweep():
    """
    Open the Dead Asset Sweep report window.

    Layout:
    - Header with disclaimer
    - Filter bar (search + type dropdown)
    - Treeview grouped by asset type (Asset | Path | Est. Size | Refs)
    - Status bar with totals
    - Footer with @thetrashbyrd link

    Safety labels:
    - "No references found — verify before deleting."
    - Disclaimer note about dynamic string-path runtime loads.
    """
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("asset_sweep: tkinter is not available in this environment.")
        return

    # ------------------------------------------------------------------
    # Root window — use Toplevel if a root already exists (e.g. launcher)
    # ------------------------------------------------------------------
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Dead Asset Sweep")
    root.configure(bg=_BG)
    root.geometry("1100x700")
    root.minsize(800, 480)

    # Logo (optional — keep reference to prevent GC)
    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path = os.path.join(_script_dir, "trashbyrd_40x40.png")
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

    style.configure("Header.TLabel",  background=_BG, foreground=_HEADER_FG,
                    font=("Segoe UI", 13, "bold"))
    style.configure("Warn.TLabel",    background=_BG, foreground="#9A5D00",
                    font=("Segoe UI", 8))
    style.configure("Dark.TLabel",    background=_BG, foreground=_TEXT_FG,
                    font=("Segoe UI", 10))
    style.configure("Status.TLabel",  background=_SECTION_BG, foreground=_TEXT_DIM,
                    font=("Segoe UI", 9), padding=(8, 4))
    style.configure("Accent.TButton", background=_ACCENT_BLUE, foreground="#1A1A1A",
                    font=("Segoe UI", 10, "bold"), padding=(14, 6), relief="flat")
    style.map("Accent.TButton", background=[("active", "#D24E1F")])

    style.configure("Sweep.Treeview",
                    background=_SECTION_BG, foreground=_TEXT_FG,
                    fieldbackground=_SECTION_BG, rowheight=22,
                    font=("Consolas", 9))
    style.configure("Sweep.Treeview.Heading",
                    background=_BG, foreground=_HEADER_FG,
                    font=("Segoe UI", 9, "bold"), relief="flat")
    style.map("Sweep.Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    style.configure("Dark.TCombobox",
                    fieldbackground=_ENTRY_BG, background=_ENTRY_BG,
                    foreground=_ENTRY_FG, selectbackground="#F6D9C9",
                    selectforeground="#1A1A1A", arrowcolor=_ACCENT_BLUE)
    style.map("Dark.TCombobox",
              fieldbackground=[("readonly", _ENTRY_BG)],
              foreground=[("readonly", _ENTRY_FG)],
              selectbackground=[("readonly", "#F6D9C9")],
              selectforeground=[("readonly", "#1A1A1A")])
    root.option_add("*TCombobox*Listbox.background",       _ENTRY_BG)
    root.option_add("*TCombobox*Listbox.foreground",       _ENTRY_FG)
    root.option_add("*TCombobox*Listbox.selectBackground", "#F6D9C9")
    root.option_add("*TCombobox*Listbox.selectForeground", "#1A1A1A")

    # ------------------------------------------------------------------
    # Header area
    # ------------------------------------------------------------------
    header_frame = ttk.Frame(root, style="Dark.TFrame", padding=(12, 10))
    header_frame.pack(fill="x", side="top")

    if _logo_img:
        logo_lbl = tk.Label(header_frame, image=_logo_img, bg=_BG, cursor="hand2")
        logo_lbl._img_ref = _logo_img
        logo_lbl.pack(side="left", padx=(0, 10))
        logo_lbl.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    ttk.Label(header_frame, text="Dead Asset Sweep", style="Header.TLabel").pack(
        side="left", padx=(0, 20)
    )

    refresh_btn = ttk.Button(header_frame, text="Scan Now", style="Accent.TButton")
    refresh_btn.pack(side="right")

    # ------------------------------------------------------------------
    # Disclaimer banner
    # ------------------------------------------------------------------
    warn_frame = tk.Frame(root, bg="#F6E7DB", padx=12, pady=6)
    warn_frame.pack(fill="x")

    tk.Label(
        warn_frame,
        text=(
            "⚠️  No references found — verify before deleting.  "
            "Cannot detect purely dynamic string-path runtime loads "
            "(e.g. LoadObject / Verse LoadAsset with computed paths)."
        ),
        font=("Segoe UI", 8),
        fg="#9A5D00",
        bg="#F6E7DB",
        anchor="w",
        justify="left",
    ).pack(fill="x")

    # ------------------------------------------------------------------
    # Filter bar
    # ------------------------------------------------------------------
    filter_frame = ttk.Frame(root, style="Dark.TFrame", padding=(12, 6))
    filter_frame.pack(fill="x")

    ttk.Label(filter_frame, text="Filter:", style="Dark.TLabel").pack(side="left", padx=(0, 4))

    filter_var = tk.StringVar()
    filter_entry = tk.Entry(
        filter_frame, textvariable=filter_var,
        bg=_ENTRY_BG, fg=_ENTRY_FG, insertbackground=_ENTRY_FG,
        relief="flat", font=("Consolas", 10), width=30,
    )
    filter_entry.pack(side="left", padx=(0, 12), ipady=4)

    ttk.Label(filter_frame, text="Type:", style="Dark.TLabel").pack(side="left", padx=(0, 4))

    type_var = tk.StringVar(value="All")
    type_combo = ttk.Combobox(
        filter_frame, textvariable=type_var,
        values=["All"],  # populated after first scan
        state="readonly", width=26,
        style="Dark.TCombobox", font=("Segoe UI", 10),
    )
    type_combo.pack(side="left", padx=(0, 12))

    # ------------------------------------------------------------------
    # Footer
    # ------------------------------------------------------------------
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill="x", side="bottom")

    social_label = tk.Label(
        footer_frame, text="by @thetrashbyrd",
        font=("Segoe UI", 8), fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2",
    )
    social_label.pack(side="right")
    social_label.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    total_size_var = tk.StringVar(value="")
    tk.Label(
        footer_frame, textvariable=total_size_var,
        font=("Segoe UI", 8, "bold"), fg=_ACCENT_GREEN, bg=_SECTION_BG,
    ).pack(side="left", padx=(0, 16))

    # ------------------------------------------------------------------
    # Status bar (above footer)
    # ------------------------------------------------------------------
    status_var = tk.StringVar(value="Click 'Scan Now' to begin.")
    status_bar = ttk.Label(root, textvariable=status_var, style="Status.TLabel", anchor="w")
    status_bar.pack(fill="x", side="bottom")

    # ------------------------------------------------------------------
    # Treeview (columns: name, path, size, type)
    # ------------------------------------------------------------------
    tree_frame = ttk.Frame(root, style="Section.TFrame")
    tree_frame.pack(fill="both", expand=True, padx=10, pady=(4, 0))

    columns = ("path_col", "size_col", "type_col")
    tree = ttk.Treeview(
        tree_frame, columns=columns,
        show="tree headings",
        selectmode="browse",
        style="Sweep.Treeview",
    )

    tree.heading("#0",        text="Asset Name")
    tree.heading("path_col",  text="Package Path")
    tree.heading("size_col",  text="Est. Size")
    tree.heading("type_col",  text="Type")

    tree.column("#0",       width=240, minwidth=120, stretch=True)
    tree.column("path_col", width=420, minwidth=200, stretch=True)
    tree.column("size_col", width=90,  minwidth=60,  stretch=False, anchor="e")
    tree.column("type_col", width=200, minwidth=80,  stretch=False)

    tree.tag_configure("group",       foreground=_ACCENT_BLUE,  font=("Segoe UI", 9, "bold"),
                       background=_SECTION_BG)
    tree.tag_configure("orphan",      foreground=_ACCENT_RED,   font=("Consolas", 9))
    tree.tag_configure("no_size",     foreground=_TEXT_DIM,     font=("Consolas", 9, "italic"))

    vsb = ttk.Scrollbar(tree_frame, orient="vertical",   command=tree.yview)
    hsb = ttk.Scrollbar(tree_frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

    vsb.pack(side="right",  fill="y")
    hsb.pack(side="bottom", fill="x")
    tree.pack(fill="both", expand=True)

    # Double-click to copy path
    def _on_double_click(_event):
        item = tree.focus()
        if not item:
            return
        values = tree.item(item, "values")
        if values and len(values) >= 1 and values[0]:
            try:
                root.clipboard_clear()
                root.clipboard_append(values[0])
                status_var.set(f"Copied to clipboard: {values[0]}")
                if _HAS_UNREAL:
                    unreal.log(f"asset_sweep: Copied to clipboard — {values[0]}")
            except Exception:
                pass

    tree.bind("<Double-1>", _on_double_click)

    # ------------------------------------------------------------------
    # Populate tree from cached scan result
    # ------------------------------------------------------------------
    def _populate_tree(result):
        """Clear and repopulate the treeview from a sweep result dict."""
        for row in tree.get_children():
            tree.delete(row)

        if not result or result.get("orphan_count", 0) == 0:
            return

        query = filter_var.get().strip().lower()
        type_filter = type_var.get()

        by_type = result.get("by_type", {})
        shown_count = 0

        for asset_type in sorted(by_type.keys()):
            if type_filter not in ("All", asset_type):
                continue
            entries = by_type[asset_type]

            # Filter entries
            filtered = []
            for e in entries:
                if query and query not in e["name"].lower() and query not in e["path"].lower():
                    continue
                filtered.append(e)

            if not filtered:
                continue

            group_size = sum(e["size_bytes"] for e in filtered)
            group_label = (
                f"{asset_type}  ({len(filtered)} asset{'s' if len(filtered) != 1 else ''}"
                f"  ~{_fmt_size(group_size)})"
            )
            group_iid = tree.insert(
                "", "end",
                text=group_label,
                values=("", "", asset_type),
                tags=("group",),
            )

            for e in filtered:
                tag = "orphan" if e["size_bytes"] > 0 else "no_size"
                tree.insert(
                    group_iid, "end",
                    text=e["name"],
                    values=(e["path"], e["size_label"], e["type"]),
                    tags=(tag,),
                )
                shown_count += 1

            tree.item(group_iid, open=True)

        total_scanned = result.get("total_scanned", 0)
        total_orphans = result.get("orphan_count", 0)
        total_size    = result.get("total_size_bytes", 0)

        status_var.set(
            f"Showing {shown_count} asset(s) with no references "
            f"(out of {total_scanned} scanned)."
        )
        total_size_var.set(
            f"Est. reclaimable: {_fmt_size(total_size)}  |  "
            f"{total_orphans} unreferenced / {total_scanned} total"
        )

    # ------------------------------------------------------------------
    # Scan callback
    # ------------------------------------------------------------------
    def _on_scan():
        refresh_btn.configure(text="Scanning…", state="disabled")
        status_var.set("Scanning Asset Registry… (this may take a moment)")
        total_size_var.set("")
        root.update_idletasks()

        try:
            result = sweep_dead_assets(project_only=True)
            _last_sweep_result[0] = result

            error = result.get("error")
            if error:
                status_var.set(f"Error during scan: {error}")
                if _HAS_UNREAL:
                    unreal.log_warning(f"asset_sweep: scan error — {error}")
                return

            # Refresh type dropdown
            types = sorted(result.get("by_type", {}).keys())
            type_combo["values"] = ["All"] + types
            if type_var.get() not in (["All"] + types):
                type_var.set("All")

            _populate_tree(result)

        except Exception as e:
            err_msg = f"Error during scan: {e}"
            status_var.set(err_msg)
            if _HAS_UNREAL:
                unreal.log_warning(f"asset_sweep: {err_msg}\n{traceback.format_exc()}")
        finally:
            try:
                refresh_btn.configure(text="Scan Now", state="normal")
            except Exception:
                pass

    refresh_btn.configure(command=_on_scan)

    # Live filter
    def _on_filter_change(*_args):
        if _last_sweep_result[0] is not None:
            _populate_tree(_last_sweep_result[0])

    filter_var.trace_add("write", _on_filter_change)
    type_combo.bind("<<ComboboxSelected>>", lambda _e: _on_filter_change())

    # ------------------------------------------------------------------
    # Tick pump — drive tkinter from the Unreal event loop
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
        try:
            _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)
        except Exception as e:
            unreal.log_warning(f"asset_sweep: Could not register tick callback — {e}")

    if _HAS_UNREAL:
        unreal.log("asset_sweep: Dead Asset Sweep window opened.")
