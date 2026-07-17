"""
UEFN Level Stats
================
Shows an overview of actors, devices, and class distribution in the current level.
Runs inside UEFN's embedded Python 3.11 (requires unreal module).

Usage:
    from level_stats import show_level_stats
    show_level_stats()
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

_BG          = "#D2CEC4"
_SECTION_BG  = "#EBE7DD"
_HEADER_FG   = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG     = "#2B2B2B"
_TEXT_DIM    = "#57524C"


# ---------------------------------------------------------------------------
# Data query
# ---------------------------------------------------------------------------

def _empty_stats():
    return {
        "total": 0, "devices": 0, "static_meshes": 0, "unique_classes": 0,
        "lights": 0, "hidden": 0, "niagara": 0, "volumes": 0,
        "class_counts": {},
    }


def _gather_stats():
    if not _HAS_UNREAL:
        return _empty_stats()

    # Strategy 1: EditorActorSubsystem (preferred — always present in UEFN)
    actors = None
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actors = subsystem.get_all_level_actors()
    except Exception as e:
        unreal.log_warning(f"level_stats: EditorActorSubsystem failed — {e}; trying EditorLevelLibrary")

    # Strategy 2: EditorLevelLibrary (older UE / fallback)
    if actors is None:
        try:
            actors = unreal.EditorLevelLibrary.get_all_level_actors()
        except Exception as e:
            unreal.log_warning(f"level_stats: EditorLevelLibrary failed — {e}")
            return _empty_stats()

    if actors is None:
        return _empty_stats()

    class_counts = {}
    devices = 0
    static_meshes = 0
    lights = 0
    hidden = 0
    niagara = 0
    audio = 0
    volumes = 0

    for actor in actors:
        try:
            cls_name = actor.get_class().get_name()
        except Exception:
            cls_name = "Unknown"

        class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
        cls_lower = cls_name.lower()

        if any(k in cls_lower for k in ("device", "manager", "controller")):
            devices += 1
        if "staticmesh" in cls_lower:
            static_meshes += 1
        if "light" in cls_lower:
            lights += 1
        if "niagara" in cls_lower or "particle" in cls_lower:
            niagara += 1
        if "sound" in cls_lower or "audio" in cls_lower:
            audio += 1
        if "volume" in cls_lower:
            volumes += 1

        try:
            if actor.is_hidden_ed():
                hidden += 1
        except Exception:
            pass

    return {
        "total": len(actors),
        "devices": devices,
        "static_meshes": static_meshes,
        "unique_classes": len(class_counts),
        "lights": lights,
        "hidden": hidden,
        "niagara": niagara,
        "volumes": volumes,
        "class_counts": class_counts,
    }


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

def show_level_stats():
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("level_stats: tkinter is not available.")
        return

    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Level Stats")
    root.geometry("700x600")
    root.minsize(560, 440)
    root.configure(bg=_BG)

    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", background=_BG, foreground=_TEXT_FG)
    style.configure("TFrame", background=_BG)
    style.configure("TScrollbar", background=_SECTION_BG, troughcolor=_BG, borderwidth=0)
    style.configure("LS.Treeview",
        background=_SECTION_BG, foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG, rowheight=22, font=("Consolas", 9))
    style.configure("LS.Treeview.Heading",
        background=_BG, foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"), relief="flat")
    style.map("LS.Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])
    style.configure("Accent.TButton",
        background=_ACCENT_BLUE, foreground="#1A1A1A",
        font=("Segoe UI", 10, "bold"), padding=(12, 5), relief="flat")
    style.map("Accent.TButton", background=[("active", "#D24E1F")])

    # --- Header ---
    header_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    header_frame.pack(fill=tk.X)

    tk.Label(header_frame, text="Level Stats",
             font=("Segoe UI", 15, "bold"), fg=_HEADER_FG, bg=_BG).pack(anchor=tk.W)
    tk.Label(header_frame,
             text="Overview of actors, devices, and class distribution in the current level.",
             font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG).pack(anchor=tk.W)

    # --- Refresh button ---
    btn_frame = tk.Frame(root, bg=_BG, padx=16, pady=0)
    btn_frame.pack(fill=tk.X)
    refresh_btn = ttk.Button(btn_frame, text="Refresh", style="Accent.TButton")
    refresh_btn.pack(side=tk.LEFT)

    # --- Summary cards ---
    cards_outer = tk.Frame(root, bg=_BG, padx=16, pady=8)
    cards_outer.pack(fill=tk.X)

    cards_frame = tk.Frame(cards_outer, bg=_SECTION_BG, padx=12, pady=8)
    cards_frame.pack(fill=tk.X)

    # Row 0: Total Actors, Fortnite Devices, Static Meshes, Unique Classes
    row0_data = [
        ("0", "Total Actors"),
        ("0", "Fortnite Devices"),
        ("0", "Static Meshes"),
        ("0", "Unique Classes"),
    ]
    card_num_labels = []
    for i, (num, desc) in enumerate(row0_data):
        card = tk.Frame(cards_frame, bg=_SECTION_BG, padx=16, pady=4)
        card.grid(row=0, column=i, sticky="ew", padx=(0, 8))
        cards_frame.columnconfigure(i, weight=1)
        num_lbl = tk.Label(card, text=num,
                           font=("Segoe UI", 20, "bold"), fg=_ACCENT_BLUE, bg=_SECTION_BG)
        num_lbl.pack(anchor=tk.W)
        tk.Label(card, text=desc,
                 font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_SECTION_BG).pack(anchor=tk.W)
        card_num_labels.append(num_lbl)

    # Separator between rows
    sep = tk.Frame(cards_frame, bg="#B8B2A4", height=1)
    sep.grid(row=1, column=0, columnspan=4, sticky="ew", pady=(6, 2))

    # Row 1: Volumes, Lights, Hidden, Niagara
    row1_data = [
        ("0", "Volumes"),
        ("0", "Lights"),
        ("0", "Hidden Actors"),
        ("0", "Niagara Emitters"),
    ]
    for i, (num, desc) in enumerate(row1_data):
        card = tk.Frame(cards_frame, bg=_SECTION_BG, padx=16, pady=4)
        card.grid(row=2, column=i, sticky="ew", padx=(0, 8))
        font_size = ("Segoe UI", 20, "bold")
        num_lbl = tk.Label(card, text=num,
                           font=font_size, fg=_ACCENT_GREEN, bg=_SECTION_BG)
        num_lbl.pack(anchor=tk.W)
        tk.Label(card, text=desc,
                 font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_SECTION_BG).pack(anchor=tk.W)
        card_num_labels.append(num_lbl)

    # --- Class breakdown section ---
    breakdown_frame = tk.Frame(root, bg=_BG, padx=16, pady=4)
    breakdown_frame.pack(fill=tk.BOTH, expand=True)

    tk.Label(breakdown_frame, text="Class Breakdown",
             font=("Segoe UI", 10, "bold"), fg=_HEADER_FG, bg=_BG).pack(anchor=tk.W, pady=(4, 2))

    tree_frame = tk.Frame(breakdown_frame, bg=_BG)
    tree_frame.pack(fill=tk.BOTH, expand=True)

    vsb = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL)
    vsb.pack(side=tk.RIGHT, fill=tk.Y)

    tree = ttk.Treeview(tree_frame,
                        columns=("class_name", "count", "pct", "bar"),
                        show="headings", style="LS.Treeview",
                        yscrollcommand=vsb.set)
    vsb.config(command=tree.yview)

    tree.heading("class_name", text="Class Name")
    tree.heading("count", text="Count")
    tree.heading("pct", text="%")
    tree.heading("bar", text="")
    tree.column("class_name", width=240, minwidth=120, stretch=True)
    tree.column("count", width=70, minwidth=50, stretch=False, anchor=tk.E)
    tree.column("pct", width=55, minwidth=40, stretch=False, anchor=tk.E)
    tree.column("bar", width=130, minwidth=60, stretch=True)
    tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

    # --- Footer ---
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM)

    actor_count_label = tk.Label(footer_frame, text="",
                                 font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_SECTION_BG)
    actor_count_label.pack(side=tk.LEFT)

    social = tk.Label(footer_frame, text="@thetrashbyrd",
                      font=("Segoe UI", 8), fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2")
    social.pack(side=tk.RIGHT, padx=(0, 4))
    social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # --- Status bar (above footer, packed bottom after footer so it sits above it) ---
    status_var = tk.StringVar(value="Click Refresh to load level stats.")
    status_bar = tk.Label(root, textvariable=status_var,
                          font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_SECTION_BG,
                          anchor="w", padx=8, pady=3)
    status_bar.pack(fill=tk.X, side=tk.BOTTOM)

    # --- Refresh logic ---
    def _refresh():
        refresh_btn.configure(state="disabled", text="Refreshing...")
        status_var.set("Scanning level actors...")
        root.update_idletasks()

        for row in tree.get_children():
            tree.delete(row)

        try:
            stats = _gather_stats()
            card_num_labels[0].config(text=str(stats["total"]))
            card_num_labels[1].config(text=str(stats["devices"]))
            card_num_labels[2].config(text=str(stats["static_meshes"]))
            card_num_labels[3].config(text=str(stats["unique_classes"]))
            card_num_labels[4].config(text=str(stats["volumes"]))
            card_num_labels[5].config(text=str(stats["lights"]))
            card_num_labels[6].config(text=str(stats["hidden"]))
            card_num_labels[7].config(text=str(stats["niagara"]))

            total = stats["total"] or 1
            max_count = max(stats["class_counts"].values(), default=1)
            BAR_WIDTH = 12
            for cls_name, count in sorted(stats["class_counts"].items(), key=lambda x: -x[1]):
                pct = count / total * 100
                filled = round(count / max_count * BAR_WIDTH)
                bar = "█" * filled + "░" * (BAR_WIDTH - filled)
                tree.insert("", tk.END, values=(cls_name, count, f"{pct:.1f}%", bar))

            actor_count_label.config(text=f"{stats['total']} actors")
            status_var.set(f"{stats['total']} actors  |  {stats['unique_classes']} unique classes")
        except Exception as e:
            if _HAS_UNREAL:
                import traceback
                unreal.log_error(f"level_stats: refresh failed — {traceback.format_exc()}")
            status_var.set(f"Error during scan: {e}")
        finally:
            refresh_btn.configure(state="normal", text="Refresh")

    refresh_btn.configure(command=_refresh)

    # --- Tick pump ---
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

    # Auto-load on open
    _refresh()

    root.update()

    if _HAS_UNREAL:
        unreal.log("level_stats: Level Stats window opened.")
