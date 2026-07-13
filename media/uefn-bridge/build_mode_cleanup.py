"""
Build-Mode Cleanup
====================
WRITE tool. Bulk-sets a small set of actor-level "build mode" boolean
properties to False across ALL level actors (not just the current
selection) — e.g. "Register with Structural Grid", "Forcibly Structurally
Supported", "Structurally Support Overlapping Actors". These are the
internal property names discovered via property_inspector.py on
BP_Blockout_Floor actors.

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
# Config — EASILY EXTENDED: add more actor-level bool property names here.
# Every entry is set to _TARGET_VALUE (False) wherever it is found.
# ---------------------------------------------------------------------------

_BUILD_MODE_PROPS = [
    "register_with_structural_grid",
    "forcibly_structurally_supported",
    "structurally_support_overlapping_actors",
]
_TARGET_VALUE = False

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


def _empty_report(status):
    return {
        "status": status,
        "actors_scanned": 0,
        "actors_with_props": 0,
        "actors_changed": 0,
        "per_property": {p: {"have": 0, "changed": 0} for p in _BUILD_MODE_PROPS},
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

def run(apply=False, progress_cb=None):
    """
    Scan (and, if apply=True, mutate) every level actor's build-mode
    properties. Never raises — always returns a report dict, even on
    failure (see _empty_report's "status" field for the reason).

    apply=False (default) is STRICTLY read-only: no set_editor_property
    calls are made, only get_editor_property.

    apply=True wraps all writes in one undoable transaction (when
    ScopedEditorTransaction is available) and calls actor.modify() before
    each write.

    progress_cb, if given, is called as progress_cb(scanned, total) every
    ~2000 actors so a caller (e.g. the Tk UI) can pump its event loop and
    show progress. Defaults to None so run() stays headless-importable.

    Returns:
        {status, actors_scanned, actors_with_props, actors_changed,
         per_property: {prop: {have, changed}}, per_class: {class: change_count},
         total_changes, applied, transaction_used, notes}
    """
    if not _HAS_UNREAL:
        result = _empty_report("error: 'unreal' module not available (must run inside UEFN)")
        print("build_mode_cleanup: " + result["status"])
        return result

    try:
        return _run_inner(apply, progress_cb)
    except Exception:
        tb = traceback.format_exc()
        try:
            unreal.log_error("build_mode_cleanup: Unhandled exception in run():\n" + tb)
        except Exception:
            pass
        print("build_mode_cleanup: unhandled exception:\n" + tb)
        result = _empty_report("error: unhandled exception (see log)")
        result["applied"] = bool(apply)
        return result


def _run_inner(apply, progress_cb):
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception as e:
        status = "error: get_editor_subsystem raised: " + str(e)
        print("build_mode_cleanup: " + status)
        return _empty_report(status)

    if subsystem is None:
        status = "error: could not get EditorActorSubsystem"
        print("build_mode_cleanup: " + status)
        return _empty_report(status)

    try:
        actors = subsystem.get_all_level_actors()
    except Exception as e:
        status = "error: get_all_level_actors raised: " + str(e)
        print("build_mode_cleanup: " + status)
        return _empty_report(status)

    if actors is None:
        actors = []
    try:
        total_actors = len(actors)
    except Exception:
        total_actors = 0

    per_property = {p: {"have": 0, "changed": 0} for p in _BUILD_MODE_PROPS}
    per_class = {}
    notes = []
    counters = {"actors_scanned": 0, "actors_with_props": 0, "actors_changed": 0, "total_changes": 0}

    def _scan(do_write):
        for actor in actors:
            counters["actors_scanned"] += 1
            actor_had_prop = False
            actor_changes = 0

            for prop in _BUILD_MODE_PROPS:
                try:
                    value = actor.get_editor_property(prop)
                except Exception:
                    # Actor doesn't expose this property — skip (expected
                    # for the vast majority of the ~44,700 actors).
                    continue

                actor_had_prop = True
                per_property[prop]["have"] += 1

                if value == _TARGET_VALUE:
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
                    actor.set_editor_property(prop, _TARGET_VALUE)
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
                with unreal.ScopedEditorTransaction("Disable build-mode properties"):
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
    root.geometry("760x520")
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
        "Sets these build-mode properties to False on ALL level actors: "
        + ", ".join(_BUILD_MODE_PROPS)
        + ".\nDry Run is read-only. Apply writes in one undoable action (Ctrl+Z to undo)."
    )
    tk.Label(
        top_frame, text=desc_text, font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
        justify=tk.LEFT, wraplength=720,
    ).pack(anchor=tk.W, pady=(4, 0))

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
        button_frame, text="Apply (set False)",
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

    columns = ("property", "have", "changed")
    tree = ttk.Treeview(tree_frame, columns=columns, show="headings", height=8)
    tree.heading("property", text="Property")
    tree.heading("have", text="Actors With Prop")
    tree.heading("changed", text="Currently On / Would Change")
    tree.column("property", width=340)
    tree.column("have", width=150, anchor=tk.CENTER)
    tree.column("changed", width=200, anchor=tk.CENTER)

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
        for prop in _BUILD_MODE_PROPS:
            counts = per_property.get(prop, {"have": 0, "changed": 0})
            tree.insert("", tk.END, values=(prop, counts.get("have", 0), counts.get("changed", 0)))

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
            result = run(apply=False, progress_cb=_make_progress_cb())
            progress_label.config(text="")
            if result.get("status") != "ok":
                status_label.config(text="Dry run failed: " + str(result.get("status")), fg=_ACCENT_RED)
            else:
                _populate_tree(result.get("per_property", {}))
                classes = result.get("per_class", {})
                summary_label.config(
                    text="Scanned {} actors; {} would change across {} classes.".format(
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
        status_label.config(text="Scanning before apply...", fg=_TEXT_DIM)
        try:
            root.update()
        except Exception:
            pass
        try:
            precheck = run(apply=False, progress_cb=_make_progress_cb())
            progress_label.config(text="")
            if precheck.get("status") != "ok":
                status_label.config(text="Pre-apply scan failed: " + str(precheck.get("status")), fg=_ACCENT_RED)
                return

            total_changes = precheck.get("total_changes", 0)
            actors_changed = precheck.get("actors_changed", 0)
            if total_changes == 0:
                _populate_tree(precheck.get("per_property", {}))
                summary_label.config(text="Nothing to change — all target properties are already False.")
                status_label.config(text="No apply needed.", fg=_ACCENT_GREEN)
                return

            proceed = messagebox.askyesno(
                "Apply build-mode cleanup",
                "This will set {} to False on {} properties across {} actors "
                "(one undoable action). Proceed?".format(
                    ", ".join(_BUILD_MODE_PROPS), total_changes, actors_changed,
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

            result = run(apply=True, progress_cb=_make_progress_cb())
            progress_label.config(text="")
            if result.get("status") != "ok":
                status_label.config(text="Apply failed: " + str(result.get("status")), fg=_ACCENT_RED)
                return

            _populate_tree(result.get("per_property", {}))
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
                text="Applied: {} changes. Undo with Ctrl+Z in the editor.{}".format(
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
        _populate_tree({p: {"have": 0, "changed": 0} for p in _BUILD_MODE_PROPS})
    except Exception:
        print("build_mode_cleanup: initial populate failed:\n" + traceback.format_exc())


# ---------------------------------------------------------------------------
# No auto-run on import — launched via the launcher or called explicitly.
# ---------------------------------------------------------------------------
