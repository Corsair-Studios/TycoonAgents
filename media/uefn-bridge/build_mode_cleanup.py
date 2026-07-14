"""
Build-Mode Cleanup
====================
WRITE tool. Bulk-sets a small set of actor-level "build mode" properties
to a per-property Off/On target across ALL level actors (not just the
current selection) — e.g. "Register with Structural Grid", "Forcibly
Structurally Supported", "Structurally Support Overlapping Actors". Each
property can independently be left untouched ("leave"), forced to its Off
value, or forced to its On value. These are the internal property names
discovered via property_inspector.py on BP_Blockout_Floor actors.

Safety model:
  - run(apply=False) is a STRICTLY read-only dry run: it never calls
    set_editor_property, only get_editor_property. Use it to preview the
    blast radius before touching anything.
  - run(apply=True) performs the writes inside ONE undoable editor
    transaction (unreal.ScopedEditorTransaction) and calls actor.modify()
    before each write so the change is undoable (Ctrl+Z) and the owning
    package is marked dirty for save. If ScopedEditorTransaction is not
    available in this UEFN build, it falls back to writing without a
    transaction (still safe/undoable per-actor via modify(), just not
    grouped as one undo step) and notes the fallback in the report.

Usage:  Launched from the Power Tools launcher ("Build-Mode Cleanup" card),
or headless via:
    import importlib, build_mode_cleanup; importlib.reload(build_mode_cleanup)
    report = build_mode_cleanup.run(apply=False)   # dry run
    report = build_mode_cleanup.run(apply=True)    # actually writes
"""

import traceback

try:
    import unreal
    _HAS_UNREAL = True
except ImportError:
    _HAS_UNREAL = False

try:
    import tkinter as tk
    from tkinter import ttk, messagebox
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Config — EASILY EXTENDED: add more actor-level properties here. Each entry
# carries its OWN off/on values, so plain booleans (off=False, on=True) and
# future non-boolean/enum properties (e.g. off=<EnumA>, on=<EnumB>) can both
# be supported without changing the run()/UI logic — just append a dict.
# ---------------------------------------------------------------------------

_BUILD_MODE_PROPS = [
    {"name": "register_with_structural_grid", "label": "Register with Structural Grid", "off": False, "on": True},
    {"name": "forcibly_structurally_supported", "label": "Forcibly Structurally Supported", "off": False, "on": True},
    {"name": "structurally_support_overlapping_actors", "label": "Structurally Support Overlapping Actors", "off": False, "on": True},
    {"name": "play_bounce",            "label": "Play Bounce",             "off": False, "on": True},
    {"name": "propagate_bounce",       "label": "Propagate Bounce",        "off": False, "on": True},
    {"name": "is_player_buildable",    "label": "Is Player Buildable",     "off": False, "on": True},
    {"name": "player_placed",          "label": "Player Placed",           "off": False, "on": True},
    {"name": "allow_interact",         "label": "Allow Interact",          "off": False, "on": True},
    {"name": "allow_weak_spots",       "label": "Allow Weak Spots",        "off": False, "on": True},
    {"name": "force_damage_ping",      "label": "Force Damage Ping",       "off": False, "on": True},
    {"name": "apply_impulse_on_damge", "label": "Apply Impulse On Damage", "off": False, "on": True},
    {"name": "show_damage_cracks",     "label": "Show Damage Cracks",      "off": False, "on": True},
    {"name": "can_be_damaged",         "label": "Can Be Damaged",          "off": False, "on": True},
]

# Valid per-property states. "leave" (the default) means the property is
# skipped entirely for every actor: no get_editor_property read, no
# set_editor_property write, no diff/count of any kind.
_STATE_LEAVE = "leave"
_STATE_OFF = "off"
_STATE_ON = "on"

# How often (in actors scanned) to invoke progress_cb / pump the UI.
_PROGRESS_EVERY = 2000

# Teenage-Engineering light palette (matches the rest of the Power Tools
# suite — copied verbatim from property_inspector.py, plus an accent red
# for the destructive Apply action).
_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_BLUE = "#F15B29"
_ACCENT_GREEN = "#2F8F3E"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"
_ENTRY_BG = "#FBFAF6"
_ENTRY_FG = "#1A1A1A"
_ACCENT_RED = "#C0392B"


def _default_states():
    """All properties default to 'leave' — a bare run() call is a harmless
    no-op scan (headless-safe)."""
    return {entry["name"]: _STATE_LEAVE for entry in _BUILD_MODE_PROPS}


def _empty_report(status, states=None):
    states = states or _default_states()
    return {
        "status": status,
        "actors_scanned": 0,
        "actors_with_props": 0,
        "actors_changed": 0,
        "per_property": {
            entry["name"]: {"state": states.get(entry["name"], _STATE_LEAVE), "have": 0, "changed": 0}
            for entry in _BUILD_MODE_PROPS
        },
        "per_class": {},
        "total_changes": 0,
        "applied": False,
        "transaction_used": False,
        "notes": [],
    }


def _safe_class_name(actor):
    try:
        return actor.get_class().get_name()
    except Exception:
        return "<unknown>"


# ---------------------------------------------------------------------------
# Headless core
# ---------------------------------------------------------------------------

def run(apply=False, progress_cb=None, states=None):
    """
    Scan (and, if apply=True, mutate) every level actor's build-mode
    properties. Never raises — always returns a report dict, even on
    failure (see _empty_report's "status" field for the reason).

    states is a dict {property_name: "off"|"leave"|"on"}. A property left
    at (or defaulted to) "leave" is skipped ENTIRELY for every actor: no
    get_editor_property read, no set_editor_property write, no diff/count.
    "off"/"on" select that property config entry's "off"/"on" value as the
    target; actors whose current value differs are counted (dry run) or
    written (apply). If states is omitted or None, every property defaults
    to "leave", so a bare run() call is a harmless no-op scan — matches
    the existing headless-safe behavior of this module.

    apply=False (default) is STRICTLY read-only: no set_editor_property
    calls are made, only get_editor_property, and only for non-"leave"
    properties.

    apply=True wraps all writes in one undoable transaction (when
    ScopedEditorTransaction is available) and calls actor.modify() before
    each write.

    progress_cb, if given, is called as progress_cb(scanned, total) every
    ~2000 actors so a caller (e.g. the Tk UI) can pump its event loop and
    show progress. Defaults to None so run() stays headless-importable.

    Returns:
        {status, actors_scanned, actors_with_props, actors_changed,
         per_property: {prop: {state, have, changed}},
         per_class: {class: change_count},
         total_changes, applied, transaction_used, notes}
    """
    if states is None:
        states = _default_states()

    if not _HAS_UNREAL:
        result = _empty_report("error: 'unreal' module not available (must run inside UEFN)", states)
        print("build_mode_cleanup: " + result["status"])
        return result

    try:
        return _run_inner(apply, progress_cb, states)
    except Exception:
        tb = traceback.format_exc()
        try:
            unreal.log_error("build_mode_cleanup: Unhandled exception in run():\n" + tb)
        except Exception:
            pass
        print("build_mode_cleanup: unhandled exception:\n" + tb)
        result = _empty_report("error: unhandled exception (see log)", states)
        result["applied"] = bool(apply)
        return result


def _run_inner(apply, progress_cb, states):
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception as e:
        status = "error: get_editor_subsystem raised: " + str(e)
        print("build_mode_cleanup: " + status)
        return _empty_report(status, states)

    if subsystem is None:
        status = "error: could not get EditorActorSubsystem"
        print("build_mode_cleanup: " + status)
        return _empty_report(status, states)

    try:
        actors = subsystem.get_all_level_actors()
    except Exception as e:
        status = "error: get_all_level_actors raised: " + str(e)
        print("build_mode_cleanup: " + status)
        return _empty_report(status, states)

    if actors is None:
        actors = []
    try:
        total_actors = len(actors)
    except Exception:
        total_actors = 0

    # Entries whose state != "leave" — these are the ONLY ones ever read or
    # written. "leave" entries are fully skipped below (no get, no set).
    active_entries = [
        entry for entry in _BUILD_MODE_PROPS
        if states.get(entry["name"], _STATE_LEAVE) != _STATE_LEAVE
    ]

    per_property = {
        entry["name"]: {"state": states.get(entry["name"], _STATE_LEAVE), "have": 0, "changed": 0}
        for entry in _BUILD_MODE_PROPS
    }
    per_class = {}
    notes = []
    counters = {"actors_scanned": 0, "actors_with_props": 0, "actors_changed": 0, "total_changes": 0}

    def _scan(do_write):
        for actor in actors:
            counters["actors_scanned"] += 1
            actor_had_prop = False
            actor_changes = 0

            for entry in active_entries:
                prop = entry["name"]
                state = states.get(prop, _STATE_LEAVE)
                target = entry["on"] if state == _STATE_ON else entry["off"]

                try:
                    value = actor.get_editor_property(prop)
                except Exception:
                    # Actor doesn't expose this property — skip (expected
                    # for the vast majority of the ~44,700 actors).
                    continue

                actor_had_prop = True
                per_property[prop]["have"] += 1

                if value == target:
                    continue  # already at the target — nothing to do

                if not do_write:
                    per_property[prop]["changed"] += 1
                    actor_changes += 1
                    continue

                try:
                    actor.modify()
                except Exception:
                    # modify() failing shouldn't block the write attempt,
                    # but it does mean this change may not be undoable.
                    pass
                try:
                    actor.set_editor_property(prop, target)
                except Exception:
                    # Write failed — don't count it as changed.
                    continue

                per_property[prop]["changed"] += 1
                actor_changes += 1

            if actor_had_prop:
                counters["actors_with_props"] += 1
            if actor_changes > 0:
                counters["actors_changed"] += 1
                counters["total_changes"] += actor_changes
                cls = _safe_class_name(actor)
                per_class[cls] = per_class.get(cls, 0) + actor_changes

            if progress_cb is not None and counters["actors_scanned"] % _PROGRESS_EVERY == 0:
                try:
                    progress_cb(counters["actors_scanned"], total_actors)
                except Exception:
                    pass

    transaction_used = False

    if not apply:
        _scan(do_write=False)
    else:
        has_txn_ctor = False
        try:
            has_txn_ctor = hasattr(unreal, "ScopedEditorTransaction")
        except Exception:
            has_txn_ctor = False

        if has_txn_ctor:
            try:
                with unreal.ScopedEditorTransaction("Update build-mode properties"):
                    _scan(do_write=True)
                transaction_used = True
            except Exception:
                tb = traceback.format_exc()
                notes.append("ScopedEditorTransaction failed; writes were NOT retried without it: " + tb)
                try:
                    unreal.log_warning("build_mode_cleanup: transaction failed:\n" + tb)
                except Exception:
                    pass
        else:
            notes.append("unreal.ScopedEditorTransaction unavailable — wrote without a grouped undo transaction.")
            _scan(do_write=True)

    if progress_cb is not None:
        try:
            progress_cb(counters["actors_scanned"], total_actors)
        except Exception:
            pass

    print(
        "build_mode_cleanup: scanned {} actors, {} had target props, "
        "{} changes across {} actors (apply={}, transaction={})".format(
            counters["actors_scanned"], counters["actors_with_props"],
            counters["total_changes"], counters["actors_changed"],
            apply, transaction_used,
        )
    )

    return {
        "status": "ok",
        "actors_scanned": counters["actors_scanned"],
        "actors_with_props": counters["actors_with_props"],
        "actors_changed": counters["actors_changed"],
        "per_property": per_property,
        "per_class": per_class,
        "total_changes": counters["total_changes"],
        "applied": bool(apply),
        "transaction_used": transaction_used,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_ui():
    """
    Open the Build-Mode Cleanup window. Never raises — falls back to a
    console message if Tkinter is unavailable.
    """
    if not _HAS_TKINTER:
        print("build_mode_cleanup: tkinter unavailable — use run(apply=False)/run(apply=True) headlessly.")
        return
    try:
        _show_window()
    except Exception:
        print("build_mode_cleanup: failed to open UI window:\n" + traceback.format_exc())


def _show_window():
    root = tk.Tk()
    root.title("Build-Mode Cleanup")
    root.geometry("760x780")
    root.configure(bg=_BG)
    root.attributes("-topmost", True)

    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", background=_BG, foreground=_TEXT_FG, font=("Segoe UI", 9))
    style.configure("TFrame", background=_BG)
    style.configure("TScrollbar", background=_SECTION_BG, troughcolor=_BG, borderwidth=0)
    style.configure(
        "Treeview",
        background=_SECTION_BG, foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG, borderwidth=0, rowheight=22,
        font=("Consolas", 9),
    )
    style.configure(
        "Treeview.Heading",
        background=_SECTION_BG, foreground=_HEADER_FG,
        borderwidth=0, font=("Segoe UI", 9, "bold"), relief="flat",
    )
    style.map("Treeview", background=[("selected", "#F6D9C9")])

    # -- Header --
    top_frame = tk.Frame(root, bg=_BG, padx=12, pady=8)
    top_frame.pack(fill=tk.X)

    tk.Label(
        top_frame, text="Build-Mode Cleanup",
        font=("Segoe UI", 16, "bold"), fg=_ACCENT_BLUE, bg=_BG,
    ).pack(anchor=tk.W)

    desc_text = (
        "Choose Off / Leave as is / On for each property below, then scan or apply "
        "across ALL level actors. Properties left as 'Leave as is' are never read or "
        "written.\nDry Run is read-only. Apply writes in one undoable action (Ctrl+Z to undo)."
    )
    tk.Label(
        top_frame, text=desc_text, font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
        justify=tk.LEFT, wraplength=720,
    ).pack(anchor=tk.W, pady=(4, 0))

    # -- Property controls --
    # 13 property rows no longer fit comfortably in a fixed-height window,
    # so the rows live in a scrollable Canvas (fixed viewport height) while
    # the "Set all" row and the rest of the window stay put — this keeps
    # every row reachable (mouse-wheel or scrollbar) regardless of screen
    # size, without growing the window past what a typical display can show.
    controls_frame = tk.Frame(root, bg=_SECTION_BG, padx=12, pady=8)
    controls_frame.pack(fill=tk.X, padx=12, pady=(4, 4))

    tk.Label(
        controls_frame, text="PROPERTY CONTROLS",
        font=("Segoe UI", 10, "bold"), fg=_HEADER_FG, bg=_SECTION_BG,
    ).pack(anchor=tk.W, pady=(0, 4))

    rows_viewport = tk.Frame(controls_frame, bg=_SECTION_BG)
    rows_viewport.pack(fill=tk.X)

    rows_canvas = tk.Canvas(
        rows_viewport, bg=_SECTION_BG, height=260, highlightthickness=0, bd=0,
    )
    rows_scroll = ttk.Scrollbar(rows_viewport, orient=tk.VERTICAL, command=rows_canvas.yview)
    rows_canvas.configure(yscrollcommand=rows_scroll.set)
    rows_canvas.pack(side=tk.LEFT, fill=tk.X, expand=True)
    rows_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    rows_inner = tk.Frame(rows_canvas, bg=_SECTION_BG)
    rows_window = rows_canvas.create_window((0, 0), window=rows_inner, anchor="nw")

    def _on_rows_inner_configure(_event):
        try:
            rows_canvas.configure(scrollregion=rows_canvas.bbox("all"))
        except Exception:
            pass

    def _on_rows_canvas_configure(event):
        try:
            rows_canvas.itemconfig(rows_window, width=event.width)
        except Exception:
            pass

    def _on_rows_mousewheel(event):
        try:
            rows_canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        except Exception:
            pass

    rows_inner.bind("<Configure>", _on_rows_inner_configure)
    rows_canvas.bind("<Configure>", _on_rows_canvas_configure)
    rows_canvas.bind("<Enter>", lambda _e: rows_canvas.bind_all("<MouseWheel>", _on_rows_mousewheel))
    rows_canvas.bind("<Leave>", lambda _e: rows_canvas.unbind_all("<MouseWheel>"))

    property_vars = {}
    for entry in _BUILD_MODE_PROPS:
        prop_name = entry["name"]
        var = tk.StringVar(value=_STATE_LEAVE)
        property_vars[prop_name] = var

        row = tk.Frame(rows_inner, bg=_SECTION_BG)
        row.pack(fill=tk.X, pady=2)

        tk.Label(
            row, text=entry["label"], font=("Segoe UI", 9), fg=_TEXT_FG, bg=_SECTION_BG,
            width=38, anchor=tk.W,
        ).pack(side=tk.LEFT)

        # indicatoron=False turns each Radiobutton into a plain labeled
        # toggle button with NO indicator dot — the three dots all looked
        # "filled" against the light TE theme, making it unclear which
        # option was actually active. The shared var/value wiring below is
        # unchanged; only the rendering style changes to a segmented-button
        # look. selectcolor is set to match each button's own selected chip
        # color so Tk's built-in indicatoron=False selected-bg doesn't
        # flash a mismatched color before the emphasis trace repaints it.
        rb_off = tk.Radiobutton(
            row, text="Off", variable=var, value=_STATE_OFF,
            indicatoron=False, bg=_SECTION_BG, fg=_TEXT_FG,
            selectcolor=_ACCENT_RED, activebackground=_SECTION_BG,
            activeforeground=_TEXT_FG, font=("Segoe UI", 9),
            borderwidth=1, padx=8, pady=2,
        )
        rb_off.pack(side=tk.LEFT, padx=(4, 0))

        rb_leave = tk.Radiobutton(
            row, text="Leave as is", variable=var, value=_STATE_LEAVE,
            indicatoron=False, bg=_SECTION_BG, fg=_TEXT_FG,
            selectcolor=_TEXT_DIM, activebackground=_SECTION_BG,
            activeforeground=_TEXT_FG, font=("Segoe UI", 9),
            borderwidth=1, padx=8, pady=2,
        )
        rb_leave.pack(side=tk.LEFT, padx=(4, 0))

        rb_on = tk.Radiobutton(
            row, text="On", variable=var, value=_STATE_ON,
            indicatoron=False, bg=_SECTION_BG, fg=_TEXT_FG,
            selectcolor=_ACCENT_GREEN, activebackground=_SECTION_BG,
            activeforeground=_TEXT_FG, font=("Segoe UI", 9),
            borderwidth=1, padx=8, pady=2,
        )
        rb_on.pack(side=tk.LEFT, padx=(4, 0))

        # Segmented-button emphasis: paint whichever of the three buttons
        # matches the var's current value as a solid colored CHIP (light
        # text, sunken relief, bold), and the other two as plain cream
        # buttons (dark text, raised relief, normal weight). Driven by a
        # trace on the SHARED var (not a button command=) so it updates on
        # both a direct click AND a Set-All button press — the var-wiring
        # itself is untouched, this only observes it.
        def _make_emphasis(v=var, off_btn=rb_off, leave_btn=rb_leave, on_btn=rb_on):
            bold_font = ("Segoe UI", 9, "bold")
            normal_font = ("Segoe UI", 9)
            chip_fg = "#FBFAF6"
            unselected_bg = _SECTION_BG

            def _style(btn, color, selected):
                if selected:
                    btn.config(
                        bg=color, fg=chip_fg, activebackground=color,
                        activeforeground=chip_fg, relief=tk.SUNKEN,
                        font=bold_font,
                    )
                else:
                    btn.config(
                        bg=unselected_bg, fg=_TEXT_FG, activebackground=unselected_bg,
                        activeforeground=_TEXT_FG, relief=tk.RAISED,
                        font=normal_font,
                    )

            def _emphasize(*_args):
                try:
                    state = v.get()
                    _style(off_btn, _ACCENT_RED, state == _STATE_OFF)
                    _style(leave_btn, _TEXT_DIM, state == _STATE_LEAVE)
                    _style(on_btn, _ACCENT_GREEN, state == _STATE_ON)
                except Exception:
                    pass
            return _emphasize

        _emphasize_selected = _make_emphasis()
        try:
            var.trace_add("write", _emphasize_selected)
        except Exception:
            try:
                var.trace("w", lambda *_a, _cb=_emphasize_selected: _cb())
            except Exception:
                pass
        _emphasize_selected()

    master_row = tk.Frame(controls_frame, bg=_SECTION_BG)
    master_row.pack(fill=tk.X, pady=(6, 0))

    tk.Label(
        master_row, text="Set all:", font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_SECTION_BG,
    ).pack(side=tk.LEFT)

    def _make_set_all(state):
        def _handler():
            for var in property_vars.values():
                var.set(state)
            # Force an immediate repaint — this window runs on a manual
            # UEFN slate tick pump (root.update()), not a normal mainloop,
            # so a burst of var.set() calls can sit unpainted until the
            # next tick. Nudge it now so all 13 radios visibly move.
            try:
                root.update_idletasks()
            except Exception:
                pass
        return _handler

    tk.Button(
        master_row, text="Off", command=_make_set_all(_STATE_OFF),
        bg=_ENTRY_BG, fg=_ACCENT_RED, activebackground=_SECTION_BG, activeforeground=_ACCENT_RED,
        relief=tk.FLAT, font=("Segoe UI", 9, "bold"), padx=8, pady=2,
    ).pack(side=tk.LEFT, padx=(6, 0))

    tk.Button(
        master_row, text="Leave", command=_make_set_all(_STATE_LEAVE),
        bg=_ENTRY_BG, fg=_TEXT_DIM, activebackground=_SECTION_BG, activeforeground=_TEXT_DIM,
        relief=tk.FLAT, font=("Segoe UI", 9, "bold"), padx=8, pady=2,
    ).pack(side=tk.LEFT, padx=(4, 0))

    tk.Button(
        master_row, text="On", command=_make_set_all(_STATE_ON),
        bg=_ENTRY_BG, fg=_ACCENT_GREEN, activebackground=_SECTION_BG, activeforeground=_ACCENT_GREEN,
        relief=tk.FLAT, font=("Segoe UI", 9, "bold"), padx=8, pady=2,
    ).pack(side=tk.LEFT, padx=(4, 0))

    # -- Buttons --
    button_frame = tk.Frame(root, bg=_BG, padx=12, pady=4)
    button_frame.pack(fill=tk.X)

    dry_run_button = tk.Button(
        button_frame, text="Dry Run (scan)",
        bg=_ENTRY_BG, fg=_ENTRY_FG, activebackground=_SECTION_BG, activeforeground=_HEADER_FG,
        relief=tk.FLAT, font=("Segoe UI", 10, "bold"), padx=10, pady=4,
    )
    dry_run_button.pack(side=tk.LEFT)

    apply_button = tk.Button(
        button_frame, text="Apply",
        bg=_ACCENT_RED, fg="#FBFAF6", activebackground="#A93226", activeforeground="#FBFAF6",
        relief=tk.FLAT, font=("Segoe UI", 10, "bold"), padx=10, pady=4,
    )
    apply_button.pack(side=tk.LEFT, padx=(8, 0))

    progress_label = tk.Label(
        button_frame, text="", font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
    )
    progress_label.pack(side=tk.RIGHT)

    # -- Results tree --
    tree_frame = tk.Frame(root, bg=_SECTION_BG)
    tree_frame.pack(fill=tk.BOTH, expand=True, padx=12, pady=(8, 4))

    columns = ("property", "state", "have", "changed")
    tree = ttk.Treeview(tree_frame, columns=columns, show="headings", height=8)
    tree.heading("property", text="Property")
    tree.heading("state", text="State")
    tree.heading("have", text="Actors With Prop")
    tree.heading("changed", text="Would Change")
    tree.column("property", width=300)
    tree.column("state", width=90, anchor=tk.CENTER)
    tree.column("have", width=140, anchor=tk.CENTER)
    tree.column("changed", width=140, anchor=tk.CENTER)

    scroll = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, command=tree.yview)
    tree.configure(yscrollcommand=scroll.set)
    tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    scroll.pack(side=tk.RIGHT, fill=tk.Y)

    # -- Summary / status --
    summary_label = tk.Label(
        root, text="No scan run yet.", font=("Segoe UI", 10), fg=_TEXT_FG, bg=_BG,
        anchor=tk.W, justify=tk.LEFT,
    )
    summary_label.pack(fill=tk.X, padx=12, pady=(0, 2))

    status_label = tk.Label(
        root, text="Ready.", font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
        anchor=tk.W, justify=tk.LEFT, wraplength=720,
    )
    status_label.pack(fill=tk.X, padx=12, pady=(0, 8))

    def _populate_tree(per_property):
        for row in tree.get_children():
            tree.delete(row)
        for entry in _BUILD_MODE_PROPS:
            prop_name = entry["name"]
            counts = per_property.get(prop_name, {"state": _STATE_LEAVE, "have": 0, "changed": 0})
            tree.insert(
                "", tk.END,
                values=(entry["label"], counts.get("state", _STATE_LEAVE), counts.get("have", 0), counts.get("changed", 0)),
            )

    def _read_states():
        return {name: var.get() for name, var in property_vars.items()}

    def _make_progress_cb():
        def _cb(scanned, total):
            try:
                progress_label.config(text="Scanning {}/{}...".format(scanned, total))
                root.update()
            except Exception:
                pass
        return _cb

    def _on_dry_run():
        dry_run_button.config(state=tk.DISABLED)
        apply_button.config(state=tk.DISABLED)
        status_label.config(text="Scanning...", fg=_TEXT_DIM)
        try:
            root.update()
        except Exception:
            pass
        try:
            states = _read_states()
            tree.heading("changed", text="Would Change")
            result = run(apply=False, progress_cb=_make_progress_cb(), states=states)
            progress_label.config(text="")
            if result.get("status") != "ok":
                status_label.config(text="Dry run failed: " + str(result.get("status")), fg=_ACCENT_RED)
            else:
                _populate_tree(result.get("per_property", {}))
                try:
                    root.update_idletasks()
                except Exception:
                    pass
                classes = result.get("per_class", {})
                summary_label.config(
                    text="Scanned {} actors; {} would change across {} classes. "
                    "(Properties left as 'Leave as is' are not read or counted.)".format(
                        result.get("actors_scanned", 0),
                        result.get("total_changes", 0),
                        len(classes),
                    )
                )
                status_label.config(text="Dry run complete (read-only — nothing was written).", fg=_ACCENT_GREEN)
        except Exception:
            tb = traceback.format_exc()
            print("build_mode_cleanup: dry run handler failed:\n" + tb)
            status_label.config(text="Dry run failed — see Output Log.", fg=_ACCENT_RED)
        finally:
            dry_run_button.config(state=tk.NORMAL)
            apply_button.config(state=tk.NORMAL)

    def _on_apply():
        dry_run_button.config(state=tk.DISABLED)
        apply_button.config(state=tk.DISABLED)
        try:
            states = _read_states()
            active_names = [name for name, state in states.items() if state != _STATE_LEAVE]
            if not active_names:
                messagebox.showinfo(
                    "Build-Mode Cleanup",
                    "Nothing selected — every property is 'Leave as is'.",
                )
                status_label.config(text="Nothing selected — choose Off or On for at least one property.", fg=_TEXT_DIM)
                return

            status_label.config(text="Scanning before apply...", fg=_TEXT_DIM)
            try:
                root.update()
            except Exception:
                pass

            precheck = run(apply=False, progress_cb=_make_progress_cb(), states=states)
            progress_label.config(text="")
            if precheck.get("status") != "ok":
                status_label.config(text="Pre-apply scan failed: " + str(precheck.get("status")), fg=_ACCENT_RED)
                return

            total_changes = precheck.get("total_changes", 0)
            actors_changed = precheck.get("actors_changed", 0)
            if total_changes == 0:
                tree.heading("changed", text="Would Change")
                _populate_tree(precheck.get("per_property", {}))
                try:
                    root.update_idletasks()
                except Exception:
                    pass
                summary_label.config(text="Nothing to change — selected properties already match their target.")
                status_label.config(text="No apply needed.", fg=_ACCENT_GREEN)
                return

            proceed = messagebox.askyesno(
                "Apply build-mode cleanup",
                "This will change {} propert{} across {} actors ({} total value changes) "
                "in one undoable action. Properties left as 'Leave as is' will not be touched. "
                "Proceed?".format(
                    len(active_names), "y" if len(active_names) == 1 else "ies",
                    actors_changed, total_changes,
                ),
            )
            if not proceed:
                status_label.config(text="Apply cancelled.", fg=_TEXT_DIM)
                return

            status_label.config(text="Applying...", fg=_TEXT_DIM)
            try:
                root.update()
            except Exception:
                pass

            result = run(apply=True, progress_cb=_make_progress_cb(), states=states)
            progress_label.config(text="")
            if result.get("status") != "ok":
                status_label.config(text="Apply failed: " + str(result.get("status")), fg=_ACCENT_RED)
                return

            tree.heading("changed", text="Changed")
            _populate_tree(result.get("per_property", {}))
            try:
                root.update_idletasks()
            except Exception:
                pass
            classes = result.get("per_class", {})
            summary_label.config(
                text="Scanned {} actors; {} changed across {} classes.".format(
                    result.get("actors_scanned", 0),
                    result.get("total_changes", 0),
                    len(classes),
                )
            )
            notes = result.get("notes") or []
            note_suffix = (" " + " ".join(notes)) if notes else ""
            status_label.config(
                text="Applied {} changes; Ctrl+Z to undo.{}".format(
                    result.get("total_changes", 0), note_suffix,
                ),
                fg=_ACCENT_GREEN,
            )
        except Exception:
            tb = traceback.format_exc()
            print("build_mode_cleanup: apply handler failed:\n" + tb)
            status_label.config(text="Apply failed — see Output Log.", fg=_ACCENT_RED)
        finally:
            dry_run_button.config(state=tk.NORMAL)
            apply_button.config(state=tk.NORMAL)

    dry_run_button.config(command=_on_dry_run)
    apply_button.config(command=_on_apply)

    # -- Tick pump so the window stays responsive inside UEFN's editor loop --
    _tick_handle = [None]

    def _tick_pump(_delta_time):
        try:
            root.update()
        except tk.TclError:
            if _tick_handle[0] is not None and _HAS_UNREAL:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None
        except Exception:
            pass

    def _on_close():
        if _tick_handle[0] is not None and _HAS_UNREAL:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        try:
            rows_canvas.unbind_all("<MouseWheel>")
        except Exception:
            pass
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    # Register the pump and force an initial render of the fully-built
    # window BEFORE any populate, so an error can never leave a blank
    # window (mirrors property_inspector.py's proven order).
    if _HAS_UNREAL:
        _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick_pump)
    try:
        root.update_idletasks()
        root.update()
    except Exception:
        pass

    # Initial state — an empty tree with placeholder rows, no scan run yet
    # (scanning ~44,700 actors is not something to do implicitly on open).
    try:
        _populate_tree({
            entry["name"]: {"state": _STATE_LEAVE, "have": 0, "changed": 0}
            for entry in _BUILD_MODE_PROPS
        })
    except Exception:
        print("build_mode_cleanup: initial populate failed:\n" + traceback.format_exc())


# ---------------------------------------------------------------------------
# No auto-run on import — launched via the launcher or called explicitly.
# ---------------------------------------------------------------------------
