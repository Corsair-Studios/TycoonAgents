"""
Property Inspector
===================
READ-ONLY discovery tool. Dumps the editor properties of selected actor(s)
and their components so the Details-panel DISPLAY name (e.g. "Register with
Structural Grid") can be resolved to its INTERNAL Python property name (what
``set_editor_property()`` needs) and to whether it lives on the actor itself
or on one of its components.

This tool performs NO mutations. It exists purely so a later bulk-uncheck
tool does not have to guess internal property names.

Usage:  Launched from the Power Tools launcher ("Property Inspector" card),
or headless via:
    import importlib, property_inspector; importlib.reload(property_inspector)
    result = property_inspector.run()
"""

import os
import json
import tempfile
import traceback

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
# Config
# ---------------------------------------------------------------------------

_DEFAULT_KEYWORDS = (
    "structural",
    "grid",
    "build",
    "overlap",
    "collision",
    "nav",
    "attach",
)

_VALUE_MAX_LEN = 200

# Dark theme colors (matches the rest of the Power Tools suite).
_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_BLUE = "#F15B29"
_ACCENT_GREEN = "#2F8F3E"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"
_ENTRY_BG = "#FBFAF6"
_ENTRY_FG = "#1A1A1A"


# ---------------------------------------------------------------------------
# IPC / report dir
# ---------------------------------------------------------------------------

def _get_bridge_dir():
    """Return the bridge IPC directory path (same one the bridge/launcher use)."""
    return os.path.join(tempfile.gettempdir(), "uefn_bridge")


def _report_path():
    return os.path.join(_get_bridge_dir(), "property_inspection.json")


# ---------------------------------------------------------------------------
# Property enumeration (mirrors device_audit._get_property_names)
# ---------------------------------------------------------------------------

def _get_property_names(obj):
    """
    Return a list of editor-gettable property names for *obj* by inspecting
    ``dir(obj)``. Filters private/dunder names and callables. Does not try
    to read the values here — callers should guard each get individually.
    """
    names = []
    for name in dir(obj):
        if name.startswith("_"):
            continue
        try:
            attr = getattr(obj, name)
        except Exception:
            continue
        if callable(attr):
            continue
        names.append(name)
    return names


def _truncate(text, max_len=_VALUE_MAX_LEN):
    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


def _is_overridden(obj, name):
    """Best-effort override check; returns False if not supported."""
    try:
        checker = getattr(obj, "is_editor_property_overridden", None)
        if checker is None:
            return False
        return bool(checker(name))
    except Exception:
        return False


def _dump_properties(obj, owner_label):
    """
    Dump every editor-gettable property of *obj* into a list of dicts:
    {internal_name, value, type, owner, overridden}.
    Every ``get_editor_property`` call is individually guarded; a property
    that raises is silently skipped (it is not editor-exposed).
    """
    rows = []
    for name in _get_property_names(obj):
        try:
            value = obj.get_editor_property(name)
        except Exception:
            # Not an editor-gettable property (plain Python attr/method leak,
            # or an engine-internal that raises) — skip it.
            continue

        try:
            value_repr = _truncate(repr(value))
        except Exception:
            value_repr = "<unrepresentable>"

        try:
            type_name = type(value).__name__
        except Exception:
            type_name = "<unknown>"

        rows.append({
            "internal_name": name,
            "value": value_repr,
            "type": type_name,
            "owner": owner_label,
            "overridden": _is_overridden(obj, name),
        })
    return rows


def _dump_actor(actor):
    """Dump properties for *actor* itself and all of its components."""
    rows = []

    try:
        owner_label = actor.get_class().get_name()
    except Exception:
        owner_label = "<actor>"

    rows.extend(_dump_properties(actor, owner_label))

    try:
        components = actor.get_components_by_class(unreal.ActorComponent)
    except Exception:
        components = []

    for comp in components:
        try:
            comp_class_name = comp.get_class().get_name()
        except Exception:
            comp_class_name = "<component>"
        comp_owner_label = "Component: " + comp_class_name
        rows.extend(_dump_properties(comp, comp_owner_label))

    return rows


def _actor_label(actor):
    try:
        return actor.get_actor_label()
    except Exception:
        pass
    try:
        return actor.get_name()
    except Exception:
        return "<unknown actor>"


# ---------------------------------------------------------------------------
# Headless core
# ---------------------------------------------------------------------------

def run(keywords=None):
    """
    Dump editor properties of the currently selected actor(s) (and their
    components) to find internal property names. Fully read-only.

    Returns a dict:
        {status, actor_count, matches, all_count, report_path}
    On failure or "nothing selected", status explains why and matches/
    all_properties are empty lists.
    """
    if keywords is None:
        keywords = list(_DEFAULT_KEYWORDS)
    keywords_lower = [k.lower() for k in keywords]

    if not _HAS_UNREAL:
        result = {
            "status": "error: 'unreal' module not available (must run inside UEFN)",
            "actor_count": 0,
            "matches": [],
            "all_properties": [],
            "all_count": 0,
            "report_path": "",
        }
        print("property_inspector: " + result["status"])
        return result

    try:
        return _run_inner(keywords_lower)
    except Exception:
        tb = traceback.format_exc()
        try:
            unreal.log_error("property_inspector: Unhandled exception in run():\n" + tb)
        except Exception:
            pass
        print("property_inspector: unhandled exception:\n" + tb)
        return {
            "status": "error: unhandled exception (see log)",
            "actor_count": 0,
            "matches": [],
            "all_properties": [],
            "all_count": 0,
            "report_path": "",
        }


def _run_inner(keywords_lower):
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception as e:
        status = "error: get_editor_subsystem raised: " + str(e)
        print("property_inspector: " + status)
        return {"status": status, "actor_count": 0, "matches": [], "all_properties": [], "all_count": 0, "report_path": ""}

    if subsystem is None:
        status = "error: could not get EditorActorSubsystem"
        print("property_inspector: " + status)
        return {"status": status, "actor_count": 0, "matches": [], "all_properties": [], "all_count": 0, "report_path": ""}

    try:
        selected = subsystem.get_selected_level_actors()
    except Exception as e:
        status = "error: get_selected_level_actors raised: " + str(e)
        print("property_inspector: " + status)
        return {"status": status, "actor_count": 0, "matches": [], "all_properties": [], "all_count": 0, "report_path": ""}

    if not selected:
        status = "no actor selected — select a prefab in the Outliner and try again"
        print("property_inspector: " + status)
        return {"status": status, "actor_count": 0, "matches": [], "all_properties": [], "all_count": 0, "report_path": ""}

    all_properties = []
    actors_info = []
    for actor in selected:
        try:
            label = _actor_label(actor)
            actors_info.append(label)
            all_properties.extend(_dump_actor(actor))
        except Exception:
            unreal.log_warning(
                "property_inspector: failed to dump actor "
                + str(_actor_label(actor)) + ":\n" + traceback.format_exc()
            )
            continue

    matches = [
        p for p in all_properties
        if any(kw in p["internal_name"].lower() for kw in keywords_lower)
    ]

    report_dir = _get_bridge_dir()
    try:
        os.makedirs(report_dir, exist_ok=True)
    except Exception:
        pass

    report = {
        "actors": actors_info,
        "keywords": keywords_lower,
        "matches": matches,
        "all_properties": all_properties,
        "match_count": len(matches),
        "all_count": len(all_properties),
    }

    path = _report_path()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
    except Exception as e:
        unreal.log_warning("property_inspector: failed to write report file: " + str(e))
        path = ""

    # Compact text table of matches to the Output Log.
    print("=" * 72)
    print("  PROPERTY INSPECTOR")
    print("=" * 72)
    print("  Actors: " + ", ".join(actors_info))
    print("  Keyword matches ({}) — internal_name = value  [owner]".format(len(matches)))
    print("-" * 72)
    for p in matches:
        print("    {} = {}  [{}]{}".format(
            p["internal_name"], p["value"], p["owner"],
            "  (overridden)" if p["overridden"] else "",
        ))
    if not matches:
        print("    (no properties matched the keywords: " + ", ".join(keywords_lower) + ")")
    print("-" * 72)
    print("  Full dump ({} properties) written to: {}".format(len(all_properties), path or "<write failed>"))
    print("=" * 72)

    status = "ok"
    return {
        "status": status,
        "actor_count": len(actors_info),
        "matches": matches,
        "all_properties": all_properties,
        "all_count": len(all_properties),
        "report_path": path,
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_ui():
    """
    Run the read-only inspection and, if Tkinter is available, open a search
    window over the results. Falls back to console-only output (via run())
    if Tkinter or unreal is unavailable — never raises.
    """
    try:
        result = run()
    except Exception:
        print("property_inspector: run() failed:\n" + traceback.format_exc())
        return

    if not _HAS_TKINTER:
        print("property_inspector: tkinter unavailable — see Output Log / report file above.")
        return

    try:
        _show_window(result)
    except Exception:
        print("property_inspector: failed to open UI window:\n" + traceback.format_exc())


def _show_window(result):
    root = tk.Tk()
    root.title("Trashbyrd's Property Inspector")
    root.geometry("900x600")
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
        fieldbackground=_SECTION_BG, borderwidth=0, rowheight=20,
        font=("Consolas", 9),
    )
    style.configure(
        "Treeview.Heading",
        background=_SECTION_BG, foreground=_HEADER_FG,
        borderwidth=0, font=("Segoe UI", 9, "bold"), relief="flat",
    )
    style.map("Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    # -- Top bar --
    top_frame = tk.Frame(root, bg=_BG, padx=12, pady=8)
    top_frame.pack(fill=tk.X)

    tk.Label(
        top_frame, text="Property Inspector",
        font=("Segoe UI", 16, "bold"), fg=_ACCENT_BLUE, bg=_BG,
    ).pack(side=tk.LEFT)

    refresh_button = tk.Button(
        top_frame, text="⟳ Refresh selection",
        bg=_ENTRY_BG, fg=_ENTRY_FG, activebackground=_SECTION_BG, activeforeground=_HEADER_FG,
        relief=tk.FLAT, font=("Segoe UI", 9), padx=8,
    )
    refresh_button.pack(side=tk.LEFT, padx=(12, 0))

    stats_label = tk.Label(
        top_frame, text="", font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
    )
    stats_label.pack(side=tk.RIGHT)

    # -- Report path (selectable) --
    if result.get("report_path"):
        path_frame = tk.Frame(root, bg=_BG, padx=12)
        path_frame.pack(fill=tk.X, pady=(0, 6))
        tk.Label(path_frame, text="Report:", font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG).pack(side=tk.LEFT)
        path_entry = tk.Entry(
            path_frame, font=("Consolas", 8), fg=_ACCENT_GREEN, bg=_BG,
            relief=tk.FLAT, readonlybackground=_BG, borderwidth=0,
        )
        path_entry.insert(0, result["report_path"])
        path_entry.configure(state="readonly")
        path_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(4, 0))

    # -- Search bar --
    search_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=6)
    search_frame.pack(fill=tk.X, padx=8, pady=(0, 4))

    tk.Label(search_frame, text="Search:", font=("Segoe UI", 10), fg=_TEXT_FG, bg=_SECTION_BG).pack(side=tk.LEFT)
    search_var = tk.StringVar()
    search_entry = tk.Entry(
        search_frame, textvariable=search_var, font=("Segoe UI", 10),
        bg=_ENTRY_BG, fg=_ENTRY_FG, insertbackground=_ENTRY_FG, relief=tk.FLAT,
    )
    search_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(6, 0))

    # -- Results tree --
    tree_frame = tk.Frame(root, bg=_SECTION_BG)
    tree_frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=(0, 8))

    columns = ("name", "value", "type", "owner", "overridden")
    tree = ttk.Treeview(tree_frame, columns=columns, show="headings", height=20)
    tree.heading("name", text="Internal Name")
    tree.heading("value", text="Value")
    tree.heading("type", text="Type")
    tree.heading("owner", text="Owner")
    tree.heading("overridden", text="Overridden")
    tree.column("name", width=220)
    tree.column("value", width=260)
    tree.column("type", width=100)
    tree.column("owner", width=200)
    tree.column("overridden", width=80, anchor=tk.CENTER)

    scroll = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, command=tree.yview)
    tree.configure(yscrollcommand=scroll.set)
    tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    scroll.pack(side=tk.RIGHT, fill=tk.Y)

    # Mutable container so the refresh closures below can swap in fresh data
    # without needing `nonlocal` on plain locals.
    state = {"props": [], "match_keys": set()}

    def _populate(filter_text=""):
        for _row in tree.get_children():
            tree.delete(_row)
        filter_text = filter_text.lower().strip()
        for p in state["props"]:
            haystack = "{} {} {} {}".format(
                p["internal_name"], p["value"], p["type"], p["owner"]
            ).lower()
            if filter_text and filter_text not in haystack:
                continue
            is_match = (p["internal_name"], p["owner"]) in state["match_keys"]
            tree.insert(
                "", tk.END,
                values=(
                    p["internal_name"], p["value"], p["type"], p["owner"],
                    "yes" if p["overridden"] else "",
                ),
                tags=("match",) if is_match else (),
            )

    tree.tag_configure("match", foreground=_ACCENT_GREEN)

    def _rebuild_from_result(res):
        # matches first, then the rest of all_properties (excluding duplicates
        # already present in matches) — same dedup/ordering as before.
        combined = list(res.get("matches", []))
        keys = {(p["internal_name"], p["owner"]) for p in res.get("matches", [])}
        for p in res.get("all_properties", []):
            key = (p["internal_name"], p["owner"])
            if key not in keys:
                combined.append(p)
                keys.add(key)

        state["props"] = combined
        state["match_keys"] = keys

        stats_text = "Actors: {}  |  Properties: {}  |  {}".format(
            res.get("actor_count", 0), res.get("all_count", 0), res.get("status", ""),
        )
        stats_label.config(text=stats_text)

        _populate(search_var.get())

    def _on_refresh():
        try:
            fresh_result = run()
        except Exception:
            print("property_inspector: refresh failed:\n" + traceback.format_exc())
            fresh_result = {
                "status": "error: refresh failed (see Output Log)",
                "actor_count": 0,
                "all_count": 0,
                "matches": [],
                "all_properties": [],
            }
        try:
            _rebuild_from_result(fresh_result)
        except Exception:
            print("property_inspector: rebuild after refresh failed:\n" + traceback.format_exc())

    refresh_button.config(command=_on_refresh)

    def _on_search(*_args):
        _populate(search_entry.get())

    search_entry.bind("<KeyRelease>", _on_search)
    search_var.trace_add("write", _on_search)
    # -- Tick pump so the window stays responsive inside UEFN's editor loop --
    _tick_handle = [None]

    def _tick_pump(_delta_time):
        try:
            root.update()
        except tk.TclError:
            # window was destroyed — stop pumping
            if _tick_handle[0] is not None and _HAS_UNREAL:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None
        except Exception:
            # never let a transient per-tick update error kill the pump
            pass

    def _on_close():
        if _tick_handle[0] is not None and _HAS_UNREAL:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    # Register the pump and force an initial render of the fully-built window
    # BEFORE the first populate, so an error while filling the tree can never
    # leave the window blank (mirrors material_browser.py's proven order).
    if _HAS_UNREAL:
        _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick_pump)
    try:
        root.update_idletasks()
        root.update()
    except Exception:
        pass

    # Initial fill — wrapped so any failure shows an empty (but fully drawn)
    # window plus a traceback in the Output Log, instead of a blank window.
    try:
        _rebuild_from_result(result)
    except Exception:
        print("property_inspector: initial populate failed:\n" + traceback.format_exc())


# ---------------------------------------------------------------------------
# No auto-run on import — launched via the launcher or called explicitly.
# ---------------------------------------------------------------------------
