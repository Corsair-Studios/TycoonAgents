"""
UEFN Verse Snippets
====================
Searchable reference of common Verse code patterns for UEFN.
Runs inside UEFN's embedded Python 3.11 (requires unreal module).

Usage:
    from verse_snippets import show_verse_snippets
    show_verse_snippets()
"""

import os
import subprocess
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
# Clipboard — Tk's clipboard API (clipboard_clear/clipboard_append/
# clipboard_get/selection_own/selection_handle) is FORBIDDEN in this file.
# Tk's clipboard needs this window to own the system CLIPBOARD selection and
# then service selection-request events from ITS OWN Tk event loop, but this
# window is pumped by UEFN's register_slate_post_tick_callback instead of
# mainloop(), so nothing can service that request — Tcl/Tk aborts the whole
# host process (crash: ucrtbase -> python311 -> _tkinter -> tcl86t (x5) ->
# tk86t -> user32 ... Abort signal received). Use the helper below instead.
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


_SNIPPETS = [
    # Basics
    {"category": "Basics",  "title": "Print to log",         "code": 'Print("Hello from Verse")'},
    {"category": "Basics",  "title": "Variable declaration",  "code": "MyVar : int = 42"},
    {"category": "Basics",  "title": "Mutable variable",      "code": "var MyVar : int = 0"},
    {"category": "Basics",  "title": "If expression",         "code": "if (MyVar > 0):\n    Print(\"Positive\")"},
    {"category": "Basics",  "title": "For loop",              "code": "for (I := 0..9):\n    Print(\"{I}\")"},
    {"category": "Basics",  "title": "Loop (infinite)",       "code": "loop:\n    Sleep(1.0)\n    Print(\"tick\")"},
    {"category": "Basics",  "title": "Option type check",     "code": "if (Val := MaybeVal?):\n    Print(\"has value\")"},
    {"category": "Basics",  "title": "String interpolation",  "code": 'Print("{MyVar} items")'},
    # Async
    {"category": "Async",   "title": "Spawn async task",     "code": "spawn { MyAsyncFunc() }"},
    {"category": "Async",   "title": "Sleep",                "code": "Sleep(2.0)  # seconds"},
    {"category": "Async",   "title": "Race two events",      "code": "race:\n    block { EventA.Await() }\n    block { EventB.Await() }"},
    {"category": "Async",   "title": "Sync two tasks",       "code": "sync:\n    block { TaskA() }\n    block { TaskB() }"},
    {"category": "Async",   "title": "Await an event",       "code": "MyEvent.Await()"},
    {"category": "Async",   "title": "Branch tasks",         "code": "branch:\n    block { LongTask() }"},
    # Devices
    {"category": "Devices", "title": "Get device reference", "code": "@editable\nMyDevice : trigger_device = trigger_device{}"},
    {"category": "Devices", "title": "Subscribe to trigger", "code": "MyDevice.TriggeredEvent.Subscribe(OnTriggered)"},
    {"category": "Devices", "title": "Eliminate player",     "code": "if (Fort := fortnight_game[GetPlayspace()]):\n    Fort.EliminatePlayer(Player)"},
    {"category": "Devices", "title": "Timer device start",   "code": "MyTimer.Start()"},
    {"category": "Devices", "title": "Timer device stop",    "code": "MyTimer.Stop()"},
    {"category": "Devices", "title": "Score manager add",    "code": "MyScoreManager.AddScore(Player, 100)"},
    # Players
    {"category": "Players", "title": "Get all players",      "code": "Players := GetPlayspace().GetPlayers()"},
    {"category": "Players", "title": "Iterate players",      "code": "for (P : GetPlayspace().GetPlayers()):\n    Print(\"{P}\")"},
    {"category": "Players", "title": "Player agent cast",    "code": "if (Agent := Player?):\n    Print(\"got agent\")"},
    {"category": "Players", "title": "On player spawned",    "code": "GetPlayspace().PlayerAddedEvent.Subscribe(OnPlayerAdded)"},
    {"category": "Players", "title": "On player removed",    "code": "GetPlayspace().PlayerRemovedEvent.Subscribe(OnPlayerRemoved)"},
    {"category": "Players", "title": "Teleport player",      "code": "Player.TeleportTo(TargetTransform)"},
    # Math / Util
    {"category": "Math",    "title": "Abs value",            "code": "Abs(-5)  # returns 5"},
    {"category": "Math",    "title": "Clamp",                "code": "Clamp(Value, Min, Max)"},
    {"category": "Math",    "title": "Random int",           "code": "GetRandomInt(0, 10)"},
    {"category": "Math",    "title": "Vector addition",      "code": "V := vector3{X:=1.0, Y:=0.0, Z:=0.0}\nV2 := V + vector3{X:=0.0, Y:=1.0, Z:=0.0}"},
    {"category": "Math",    "title": "Distance between vecs","code": "Dist := Distance(V1, V2)"},
    {"category": "Math",    "title": "Lerp float",           "code": "Lerp(A, B, T)  # T in 0.0..1.0"},
    # Classes
    {"category": "Classes", "title": "Define a class",       "code": "my_class := class:\n    MyField : int = 0\n    MyMethod() : void =\n        Print(\"hello\")"},
    {"category": "Classes", "title": "Inherit a class",      "code": "my_child := class(my_parent):\n    override MyMethod() : void =\n        Print(\"overridden\")"},
    {"category": "Classes", "title": "Interface",            "code": "my_interface := interface:\n    DoThing() : void"},
    {"category": "Classes", "title": "Struct",               "code": "my_struct := struct:\n    X : float = 0.0\n    Y : float = 0.0"},
    # Events
    {"category": "Events",  "title": "Create an event",      "code": "MyEvent : event() = event(){}"},
    {"category": "Events",  "title": "Signal an event",      "code": "MyEvent.Signal()"},
    {"category": "Events",  "title": "Subscribe handler",    "code": "MyEvent.Subscribe(OnMyEvent)"},
    {"category": "Events",  "title": "Listenable pattern",   "code": "OnMyEvent(Sender : agent) : void =\n    Print(\"event received\")"},
]


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

def show_verse_snippets():
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("verse_snippets: tkinter is not available.")
        return

    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Verse Snippets")
    root.geometry("860x600")
    root.minsize(640, 420)
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
    style.configure("VS.Treeview",
        background=_SECTION_BG, foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG, rowheight=22, font=("Segoe UI", 9))
    style.configure("VS.Treeview.Heading",
        background=_BG, foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"), relief="flat")
    style.map("VS.Treeview",
              background=[("selected", _ACCENT_BLUE)],
              foreground=[("selected", "#FFFFFF")])
    style.configure("Accent.TButton",
        background=_ACCENT_BLUE, foreground="#1A1A1A",
        font=("Segoe UI", 10, "bold"), padding=(12, 5), relief="flat")
    style.map("Accent.TButton", background=[("active", "#D24E1F")])

    # --- Header ---
    header_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    header_frame.pack(fill=tk.X)

    tk.Label(header_frame, text="Verse Snippets",
             font=("Segoe UI", 15, "bold"), fg=_HEADER_FG, bg=_BG).pack(anchor=tk.W)
    tk.Label(header_frame,
             text="Common Verse patterns for UEFN. Click a snippet to copy it.",
             font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG).pack(anchor=tk.W)

    # --- Filter row ---
    filter_frame = tk.Frame(root, bg=_BG, padx=16, pady=4)
    filter_frame.pack(fill=tk.X)

    tk.Label(filter_frame, text="Filter:", font=("Segoe UI", 9),
             fg=_TEXT_DIM, bg=_BG).pack(side=tk.LEFT, padx=(0, 4))

    filter_var = tk.StringVar()
    filter_entry = tk.Entry(filter_frame, textvariable=filter_var,
                            font=("Segoe UI", 10), bg=_SECTION_BG, fg=_TEXT_FG,
                            insertbackground=_TEXT_FG, relief="flat", width=28)
    filter_entry.pack(side=tk.LEFT, padx=(0, 8))

    categories = ["All"] + sorted(set(s["category"] for s in _SNIPPETS))
    cat_var = tk.StringVar(value="All")
    cat_combo = ttk.Combobox(filter_frame, textvariable=cat_var,
                             values=categories, state="readonly", width=16)
    cat_combo.pack(side=tk.LEFT, padx=(0, 8))

    count_label = tk.Label(filter_frame, text=f"{len(_SNIPPETS)} snippets",
                           font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG)
    count_label.pack(side=tk.LEFT)

    # --- Body: two-pane split ---
    body_frame = tk.Frame(root, bg=_BG, padx=16, pady=4)
    body_frame.pack(fill=tk.BOTH, expand=True)

    # Left pane — snippet list
    left_frame = tk.Frame(body_frame, bg=_BG, width=300)
    left_frame.pack(side=tk.LEFT, fill=tk.BOTH)
    left_frame.pack_propagate(False)

    list_vsb = ttk.Scrollbar(left_frame, orient=tk.VERTICAL)
    list_vsb.pack(side=tk.RIGHT, fill=tk.Y)

    list_tree = ttk.Treeview(left_frame, show="tree", style="VS.Treeview",
                             yscrollcommand=list_vsb.set, selectmode="browse")
    list_vsb.config(command=list_tree.yview)
    list_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

    # Tag for category headers
    list_tree.tag_configure("category", foreground=_ACCENT_BLUE,
                             font=("Segoe UI", 9, "bold"))
    list_tree.tag_configure("snippet", foreground=_TEXT_FG,
                             font=("Segoe UI", 9))

    # Right pane
    right_frame = tk.Frame(body_frame, bg=_SECTION_BG, padx=12, pady=8)
    right_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(12, 0))

    snippet_title_label = tk.Label(right_frame, text="Select a snippet",
                                   font=("Segoe UI", 10, "bold"),
                                   fg=_HEADER_FG, bg=_SECTION_BG, anchor="w")
    snippet_title_label.pack(fill=tk.X, pady=(0, 6))

    code_text = tk.Text(right_frame,
                        font=("Consolas", 10), bg=_SECTION_BG, fg=_TEXT_FG,
                        insertbackground=_TEXT_FG, relief="flat",
                        state="disabled", wrap="none",
                        highlightthickness=0, borderwidth=0)
    code_text.pack(fill=tk.BOTH, expand=True)

    copy_btn = ttk.Button(right_frame, text="Copy to Clipboard", style="Accent.TButton")
    copy_btn.pack(pady=(8, 0), anchor="w")

    # --- Footer ---
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM)

    total_label = tk.Label(footer_frame, text=f"{len(_SNIPPETS)} snippets total",
                           font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_SECTION_BG)
    total_label.pack(side=tk.LEFT)

    social = tk.Label(footer_frame, text="@thetrashbyrd",
                      font=("Segoe UI", 8), fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2")
    social.pack(side=tk.RIGHT, padx=(8, 4))
    social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    bov = tk.Label(footer_frame, text="Book of Verse \u2197",
                   font=("Segoe UI", 8), fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2")
    bov.pack(side=tk.RIGHT, padx=(0, 4))
    bov.bind("<Button-1>", lambda _e: webbrowser.open("https://verselang.github.io/book/"))

    # --- State ---
    _current_code = [""]

    # --- Populate list ---
    def _populate_list():
        for item in list_tree.get_children():
            list_tree.delete(item)

        q = filter_var.get().strip().lower()
        cat_filter = cat_var.get()

        filtered = [
            s for s in _SNIPPETS
            if (cat_filter == "All" or s["category"] == cat_filter)
            and (not q or q in s["title"].lower() or q in s["code"].lower())
        ]

        count_label.config(text=f"{len(filtered)} snippet{'s' if len(filtered) != 1 else ''}")

        # Group by category
        by_cat: dict[str, list] = {}
        for s in filtered:
            by_cat.setdefault(s["category"], []).append(s)

        for cat in sorted(by_cat.keys()):
            cat_id = list_tree.insert("", tk.END, text=f"  {cat}",
                                      tags=("category",), open=True)
            for s in by_cat[cat]:
                list_tree.insert(cat_id, tk.END,
                                 text=f"  {s['title']}",
                                 values=(s["code"], s["title"]),
                                 tags=("snippet",))

    # --- Selection handler ---
    def _on_select(_event=None):
        sel = list_tree.selection()
        if not sel:
            return
        item = sel[0]
        tags = list_tree.item(item, "tags")
        if "category" in tags:
            return
        vals = list_tree.item(item, "values")
        if not vals:
            return
        code, title = vals[0], vals[1]
        _current_code[0] = code

        snippet_title_label.config(text=title)
        code_text.config(state="normal")
        code_text.delete("1.0", tk.END)
        code_text.insert("1.0", code)
        code_text.config(state="disabled")

    list_tree.bind("<<TreeviewSelect>>", _on_select)

    # --- Copy handler ---
    def _copy():
        code = _current_code[0]
        if not code:
            return
        if _copy_text_to_system_clipboard(code):
            copy_btn.configure(text="Copied!")
            root.after(1500, lambda: copy_btn.configure(text="Copy to Clipboard"))
        else:
            # No-clipboard-API fallback: the code is already shown in
            # code_text — just select all of it (tag ops work even while
            # disabled) and point the user at Ctrl+C. Zero clipboard calls.
            code_text.tag_add("sel", "1.0", "end")
            code_text.focus_set()
            copy_btn.configure(text="Selected — press Ctrl+C")
            root.after(2500, lambda: copy_btn.configure(text="Copy to Clipboard"))

    copy_btn.configure(command=_copy)

    # --- Filter bindings ---
    filter_var.trace_add("write", lambda *_: _populate_list())
    filter_entry.bind("<KeyRelease>", lambda _e: _populate_list())
    cat_combo.bind("<<ComboboxSelected>>", lambda *_: _populate_list())

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

    _populate_list()
    root.update()

    if _HAS_UNREAL:
        unreal.log("verse_snippets: Verse Snippets window opened.")
