"""
UEFN Keyboard Shortcuts Reference
===================================
Searchable keyboard shortcut reference for Unreal Editor for Fortnite.
Runs inside UEFN's embedded Python 3.11 (unreal module optional).

Usage:
    from keyboard_shortcuts import show_keyboard_shortcuts
    show_keyboard_shortcuts()
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
# Theme constants
# ---------------------------------------------------------------------------

_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"


# ---------------------------------------------------------------------------
# Shortcuts data
# ---------------------------------------------------------------------------

_SHORTCUTS = [
    # Camera / Navigation
    {"category": "Camera",      "keys": "RMB + W A S D",        "action": "Fly camera (hold RMB to enable)"},
    {"category": "Camera",      "keys": "RMB + Q / E",           "action": "Fly camera down / up"},
    {"category": "Camera",      "keys": "RMB + Scroll",          "action": "Change fly speed"},
    {"category": "Camera",      "keys": "Alt + LMB drag",        "action": "Orbit around pivot"},
    {"category": "Camera",      "keys": "Alt + RMB drag",        "action": "Zoom (dolly)"},
    {"category": "Camera",      "keys": "Alt + MMB drag",        "action": "Pan camera"},
    {"category": "Camera",      "keys": "Scroll wheel",          "action": "Zoom in / out"},
    {"category": "Camera",      "keys": "F",                     "action": "Focus viewport on selection"},
    {"category": "Camera",      "keys": "G",                     "action": "Toggle game view (hide editor UI)"},
    {"category": "Camera",      "keys": "1 / 2 / 3 / 4",        "action": "Perspective / Top / Front / Side view"},

    # Selection
    {"category": "Selection",   "keys": "Q",                     "action": "Select mode"},
    {"category": "Selection",   "keys": "Click",                 "action": "Select actor"},
    {"category": "Selection",   "keys": "Ctrl + Click",          "action": "Add / remove actor from selection"},
    {"category": "Selection",   "keys": "Ctrl + A",              "action": "Select all actors"},
    {"category": "Selection",   "keys": "Escape",                "action": "Deselect all"},
    {"category": "Selection",   "keys": "Shift + Click (box)",   "action": "Box select — add to selection"},
    {"category": "Selection",   "keys": "Ctrl + Shift + Click",  "action": "Remove actor from selection"},

    # Transform
    {"category": "Transform",   "keys": "W",                     "action": "Move tool (translate)"},
    {"category": "Transform",   "keys": "E",                     "action": "Rotate tool"},
    {"category": "Transform",   "keys": "R",                     "action": "Scale tool"},
    {"category": "Transform",   "keys": "Spacebar",              "action": "Cycle Move / Rotate / Scale"},
    {"category": "Transform",   "keys": "End",                   "action": "Snap selected actor to floor"},
    {"category": "Transform",   "keys": "Alt + drag",            "action": "Duplicate actor while moving"},
    {"category": "Transform",   "keys": "[ / ]",                 "action": "Decrease / increase snap grid size"},

    # Editing
    {"category": "Editing",     "keys": "Ctrl + Z",              "action": "Undo"},
    {"category": "Editing",     "keys": "Ctrl + Y",              "action": "Redo"},
    {"category": "Editing",     "keys": "Ctrl + C",              "action": "Copy selected actors"},
    {"category": "Editing",     "keys": "Ctrl + V",              "action": "Paste actors"},
    {"category": "Editing",     "keys": "Ctrl + D",              "action": "Duplicate selected actors in place"},
    {"category": "Editing",     "keys": "Delete",                "action": "Delete selected actors"},
    {"category": "Editing",     "keys": "F2",                    "action": "Rename selected actor"},
    {"category": "Editing",     "keys": "Ctrl + G",              "action": "Group selected actors"},
    {"category": "Editing",     "keys": "Shift + G",             "action": "Ungroup"},
    {"category": "Editing",     "keys": "Ctrl + S",              "action": "Save level"},
    {"category": "Editing",     "keys": "Ctrl + Shift + S",      "action": "Save all"},

    # Viewport
    {"category": "Viewport",    "keys": "F11",                   "action": "Toggle immersive (fullscreen) viewport"},
    {"category": "Viewport",    "keys": "H",                     "action": "Toggle actor visibility in viewport"},
    {"category": "Viewport",    "keys": "Ctrl + Shift + H",      "action": "Hide selected actors"},
    {"category": "Viewport",    "keys": "V",                     "action": "Toggle vertex snapping"},
    {"category": "Viewport",    "keys": "T",                     "action": "Toggle actor icons in viewport"},
    {"category": "Viewport",    "keys": "P",                     "action": "Toggle AI path visibility"},

    # Content Browser
    {"category": "Content Browser", "keys": "Ctrl + Space",      "action": "Open / focus Content Browser"},
    {"category": "Content Browser", "keys": "Ctrl + F",          "action": "Search in Content Browser"},
    {"category": "Content Browser", "keys": "Delete",            "action": "Delete selected asset (with confirmation)"},

    # Play & Test
    {"category": "Play & Test", "keys": "Alt + P",               "action": "Launch island / play in editor"},
    {"category": "Play & Test", "keys": "Esc",                   "action": "Stop play session"},

    # Outliner
    {"category": "Outliner",    "keys": "Ctrl + Click",          "action": "Multi-select in Outliner"},
    {"category": "Outliner",    "keys": "Ctrl + F",              "action": "Search Outliner"},
    {"category": "Outliner",    "keys": "F",                     "action": "Focus viewport on actor selected in Outliner"},
]

_TOTAL = len(_SHORTCUTS)


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------

def show_keyboard_shortcuts():
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("keyboard_shortcuts: tkinter is not available.")
        return

    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Keyboard Shortcuts")
    root.geometry("780x580")
    root.minsize(600, 400)
    root.configure(bg=_BG)

    # Style
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", background=_BG, foreground=_TEXT_FG)
    style.configure("TFrame", background=_BG)
    style.configure("TScrollbar", background=_SECTION_BG, troughcolor=_BG, borderwidth=0)
    style.configure("TCombobox", fieldbackground=_SECTION_BG, background=_SECTION_BG,
                    foreground=_TEXT_FG)
    style.map("TCombobox", fieldbackground=[("readonly", _SECTION_BG)],
              foreground=[("readonly", _TEXT_FG)])
    style.configure("KS.Treeview",
        background=_SECTION_BG, foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG, rowheight=22, font=("Segoe UI", 9))
    style.configure("KS.Treeview.Heading",
        background=_BG, foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"), relief="flat")
    style.map("KS.Treeview", background=[("selected", "#F6D9C9")])

    # Header
    header_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    header_frame.pack(fill=tk.X)

    tk.Label(header_frame, text="Keyboard Shortcuts",
             font=("Segoe UI", 15, "bold"), fg=_HEADER_FG, bg=_BG).pack(anchor=tk.W)
    tk.Label(header_frame, text="Unreal Editor for Fortnite — common shortcuts and hotkeys.",
             font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG).pack(anchor=tk.W)

    # Filter row
    filter_frame = tk.Frame(root, bg=_BG, padx=16, pady=4)
    filter_frame.pack(fill=tk.X)

    tk.Label(filter_frame, text="Filter:", font=("Segoe UI", 9),
             fg=_TEXT_DIM, bg=_BG).pack(side=tk.LEFT, padx=(0, 4))

    filter_var = tk.StringVar()
    filter_entry = tk.Entry(filter_frame, textvariable=filter_var, width=30,
                            bg=_SECTION_BG, fg=_TEXT_FG, insertbackground=_TEXT_FG,
                            relief="flat", font=("Segoe UI", 9))
    filter_entry.pack(side=tk.LEFT, padx=(0, 12), ipady=3)

    tk.Label(filter_frame, text="Category:", font=("Segoe UI", 9),
             fg=_TEXT_DIM, bg=_BG).pack(side=tk.LEFT, padx=(0, 4))

    categories = ["All"] + sorted(set(s["category"] for s in _SHORTCUTS),
                                   key=lambda c: ["Camera", "Selection", "Transform",
                                                   "Editing", "Viewport", "Content Browser",
                                                   "Play & Test", "Outliner"].index(c)
                                   if c in ["Camera", "Selection", "Transform", "Editing",
                                             "Viewport", "Content Browser", "Play & Test",
                                             "Outliner"] else 99)
    cat_var = tk.StringVar(value="All")
    cat_combo = ttk.Combobox(filter_frame, textvariable=cat_var, values=categories,
                              width=18, state="readonly", font=("Segoe UI", 9))
    cat_combo.pack(side=tk.LEFT, padx=(0, 12))

    count_label = tk.Label(filter_frame, text="", font=("Segoe UI", 9),
                            fg=_TEXT_DIM, bg=_BG)
    count_label.pack(side=tk.LEFT)

    # Treeview
    tree_frame = tk.Frame(root, bg=_BG, padx=16, pady=4)
    tree_frame.pack(fill=tk.BOTH, expand=True)

    tree_scroll = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, style="TScrollbar")
    tree_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    tree = ttk.Treeview(tree_frame,
                        columns=("category", "keys", "action"),
                        show="headings",
                        style="KS.Treeview",
                        yscrollcommand=tree_scroll.set)
    tree.heading("category", text="Category")
    tree.heading("keys", text="Keys")
    tree.heading("action", text="Action")
    tree.column("category", width=140, stretch=False)
    tree.column("keys", width=200, stretch=False)
    tree.column("action", width=400, stretch=True)
    tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    tree_scroll.config(command=tree.yview)

    # Filtering
    def _apply_filter(*_args):
        text = filter_var.get().lower().strip()
        cat = cat_var.get()
        tree.delete(*tree.get_children())
        count = 0
        for s in _SHORTCUTS:
            if cat != "All" and s["category"] != cat:
                continue
            if text and text not in s["keys"].lower() and text not in s["action"].lower():
                continue
            tree.insert("", tk.END, values=(s["category"], s["keys"], s["action"]))
            count += 1
        count_label.config(text=f"{count} of {_TOTAL} shortcuts")

    filter_var.trace_add("write", _apply_filter)
    cat_combo.bind("<<ComboboxSelected>>", _apply_filter)

    # Footer
    footer = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=4)
    footer.pack(fill=tk.X, side=tk.BOTTOM)

    tk.Label(footer, text=f"{_TOTAL} shortcuts",
             font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_SECTION_BG).pack(side=tk.LEFT)

    social = tk.Label(footer, text="@thetrashbyrd", font=("Segoe UI", 8),
                      fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2")
    social.pack(side=tk.RIGHT, padx=(0, 4))
    social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

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

    # Initial population
    _apply_filter()

    root.update()
    if _HAS_UNREAL:
        unreal.log("keyboard_shortcuts: window opened.")
