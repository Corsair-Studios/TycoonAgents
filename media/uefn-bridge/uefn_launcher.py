"""
UEFN Launcher Hub
==================
Tkinter-based launcher for all Trashbyrd's Power Tools UEFN Python tools.
Runs inside UEFN's embedded Python 3.11 (requires ``unreal`` module).

Usage:
    from uefn_launcher import show_launcher
    show_launcher()
"""

import unreal
import json
import os
import datetime
import webbrowser

try:
    import tkinter as tk
    from tkinter import ttk, messagebox
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
_CARD_HOVER = "#F15B29"
_CARD_BORDER = "#B8B2A4"

# Bridge version, shown in the launcher footer so users can tell a stale
# cached copy apart from the current one. Sourced from the generated
# bridge_version.py (stamped by scripts/release.mjs on every version bump)
# so this file never needs a hand-edit again.
try:
    from bridge_version import BRIDGE_VERSION
except Exception:
    BRIDGE_VERSION = "unknown"


def _read_bridge_sync_status():
    """Best-effort read of bridge_sync_status.json, written next to this
    script by init_unreal.py's self-sync on every project load. Returns the
    parsed dict, or None on any failure (missing file, bad JSON, wrong
    shape) — never raises.
    """
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _status_path = os.path.join(_script_dir, "bridge_sync_status.json")
        with open(_status_path, "r", encoding="utf-8") as _f:
            return json.load(_f)
    except Exception:
        return None


def _bridge_status_line():
    """Build the footer's bridge-status text.

    - marker present and updated==true -> "Bridge v{to} — updated from
      {from} on load"
    - marker present otherwise -> "Bridge v{version} — up to date"
    - marker missing/unreadable/malformed -> bare "Bridge v{BRIDGE_VERSION}"
      fallback
    """
    try:
        _status = _read_bridge_sync_status()
        if isinstance(_status, dict):
            if _status.get("updated") and _status.get("to") and _status.get("from"):
                return "Bridge v{} — updated from {} on load".format(
                    _status["to"], _status["from"]
                )
            _ver = _status.get("version") or BRIDGE_VERSION
            return "Bridge v{} — up to date".format(_ver)
    except Exception:
        pass
    return "Bridge v" + str(BRIDGE_VERSION)


# ---------------------------------------------------------------------------
# Bridge status helpers
# ---------------------------------------------------------------------------

def _get_bridge_dir():
    """Return the bridge IPC directory, creating it if necessary.

    Honors the ``UEFN_BRIDGE_DIR`` environment variable so this launcher and
    the bridge/MCP wrapper agree on the same location; otherwise falls back
    to ``<temp>/uefn_bridge``. To use a custom dir, set UEFN_BRIDGE_DIR for
    BOTH the UEFN process and the MCP wrapper.

    Delegates to bridge_paths.py (side-effect-free, importable without
    starting a bridge instance — see its module docstring) when available;
    ImportError-guarded fallback below reproduces its derivation exactly
    for a version-skewed sibling set missing that file.
    """
    try:
        import bridge_paths
        return bridge_paths.bridge_ipc_dir(create=True)
    except ImportError:
        pass
    import tempfile
    bridge_dir = os.environ.get("UEFN_BRIDGE_DIR") or os.path.join(
        tempfile.gettempdir(), "uefn_bridge"
    )
    os.makedirs(bridge_dir, exist_ok=True)
    return bridge_dir


def _read_heartbeat():
    """
    Read the bridge heartbeat file and return a status dict.

    Returns:
        dict with keys: connected (bool), status (str), timestamp (str),
        level_name (str), actor_count (int)
    """
    try:
        heartbeat_path = os.path.join(_get_bridge_dir(), "heartbeat.json")
    except Exception as e:
        unreal.log_warning(
            "uefn_launcher: failed to resolve/create bridge dir: " + str(e)
        )
        return {
            "connected": False,
            "status": "bridge dir unavailable",
            "timestamp": "",
            "level_name": "",
            "actor_count": 0,
        }
    try:
        with open(heartbeat_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {
            "connected": False,
            "status": "no heartbeat",
            "timestamp": "",
            "level_name": "",
            "actor_count": 0,
        }

    # Check if heartbeat is recent (within 15 seconds)
    ts_str = data.get("timestamp", "")
    connected = False
    if ts_str and data.get("status") == "running":
        try:
            ts = datetime.datetime.fromisoformat(ts_str)
            age = (datetime.datetime.now() - ts).total_seconds()
            connected = age < 15.0
        except Exception:
            pass

    return {
        "connected": connected,
        "status": data.get("status", "unknown"),
        "timestamp": ts_str,
        "level_name": data.get("level_name", ""),
        "actor_count": data.get("actor_count", 0),
    }


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

_TOOLS = [
    {
        "icon": "\U0001f50d",  # magnifying glass
        "name": "Device Audit",
        "description": "Scan devices, inspect connections, view properties",
        "action": "device_audit",
    },
    {
        "icon": "\U0001f3a8",  # palette
        "name": "Material Browser",
        "description": "Browse materials, view textures, find unused",
        "action": "material_browser",
    },
    {
        "icon": "\u2728",  # sparkles
        "name": "Niagara Inspector",
        "description": "Browse VFX systems, find dependencies and usage",
        "action": "niagara_inspector",
    },
    {
        "icon": "\U0001f5bc",  # framed picture
        "name": "Texture Explorer",
        "description": "Browse textures, find references and orphans",
        "action": "texture_finder",
    },
    {
        "icon": "\U0001f517",  # link
        "name": "Dependency Viewer",
        "description": "Visualize asset dependencies, find orphans",
        "action": "dependency_viewer",
    },
    {
        "icon": "\U0001f3e5",  # hospital
        "name": "Project Health",
        "description": "Scan for problematic files on disk",
        "action": "health_scanner",
    },
    {
        "icon": "\u2696",  # scales of justice
        "name": "IP / Moderation Scan",
        "description": "Scans metadata & assets; AI assistant writes the full report",
        "action": "moderation_scan",
    },
    {
        "icon": "\U0001f3f7",  # label
        "name": "Verse Tag Inspector",
        "description": "Reads Verse gameplay tags from the tag component uefn_get_property can't see",
        "action": "tag_inspect",
    },
    {
        "icon": "\U0001f4ca",  # bar chart
        "name": "Level Stats",
        "description": "Actor counts, class breakdown, device summary",
        "action": "level_stats",
    },
    {
        "icon": "\U0001f916",  # robot
        "name": "MCP Bridge",
        "description": "AI integration commands and compatibility",
        "action": "mcp_info",
    },
    {
        "icon": "\U0001f9f9",  # broom
        "name": "Dead Asset Sweep",
        "description": "Find unreferenced assets, estimate reclaimable disk space",
        "action": "asset_sweep",
    },
    {
        "icon": "\U0001f50e",  # magnifying glass tilted right
        "name": "Property Inspector",
        "description": "Dump a selected actor's properties to find internal names",
        "action": "property_inspector",
    },
    {
        "icon": "\U0001f9f1",  # bricks
        "name": "Build-Mode Cleanup",
        "description": "Clear build-mode flags (structural grid, etc.) on all level actors",
        "action": "build_mode_cleanup",
    },
]


# ---------------------------------------------------------------------------
# MCP Bridge info window
# ---------------------------------------------------------------------------

# Display-only blurbs, keyed by uefn_bridge._METHODS dispatch key (NOT the
# "uefn_" tool name — that prefix is added in _mcp_command_entries()). This
# map is descriptive only; it is never the enumeration source, so a method
# missing here still shows up in the panel (see _mcp_command_entries()).
_MCP_METHOD_DESCRIPTIONS = {
    "status": "Check bridge connectivity",
    "list_devices": "List all Creative devices with properties",
    "get_property": "Read a property from an actor",
    "set_property": "Set a property on an actor",
    "select_actor": "Select an actor in the UEFN viewport",
    "run_audit": "Run full device audit",
    "get_level_info": "Get level metadata",
    "batch_get": "Read a property from filtered actors",
    "batch_set": "Set a property on filtered actors",
    "texture_find": "Find texture references",
    "texture_summary": "Grouped texture usage summary",
    "texture_on_actor": "List all textures on an actor",
    "material_browse": "Browse project materials",
    "material_unused": "Find unused materials",
    "niagara_browse": "Browse Niagara VFX systems",
    "niagara_usage": "Find Niagara usage on actors",
    "dependency_scan": "Scan asset dependency chains",
    "health_scan": "Scan for problematic project files",
    "moderation_scan": "Scan the project for IP/moderation risk signals (assets, HLOD priority, imports)",
    "moderation_report_save": "Save a moderation scan report for the in-editor review panel",
    "moderation_report_read": "Read back a previously saved moderation report",
    "asset_sweep": "Find unreferenced assets across all types",
    "tag_inspect": "Read Verse gameplay tags from actors' tag components, with parent chains",
    "list_assets": "List assets under a content-browser path via the Asset Registry",
    "inspect_asset": "Load a single asset and reflect its editor-property values (experimental, read-only)",
    "spawn_actor": "Spawn an actor from an asset into the level — undoable with Ctrl+Z",
    "duplicate_actor": "Duplicate an actor by label with an offset — undoable with Ctrl+Z",
    "set_transform": "Set an actor's location/rotation/scale by label — undoable with Ctrl+Z",
}


def _mcp_command_entries():
    """Return the ordered (tool_name, description) list shown in the MCP
    Bridge Commands window.

    This is the SINGLE enumeration source — it derives the list dynamically
    from ``uefn_bridge._METHODS`` (the live dispatch table) rather than a
    hand-maintained copy, so the panel can never go stale again. Pure and
    UI-free: safe to call from a test with no tkinter/unreal UI involved.

    ``uefn_bridge`` is imported lazily (inside the function, not at module
    scope) purely as a defensive habit for this launcher module, which is
    imported very early during UEFN startup — importing it lazily means a
    problem loading uefn_bridge only affects this one window instead of the
    whole launcher. uefn_bridge itself does not import uefn_launcher, so
    there is no actual cycle today, but keeping the import lazy costs
    nothing and avoids re-introducing one later.

    Raises on failure (missing module, missing/renamed _METHODS) instead of
    swallowing the error — the caller (_show_mcp_info) is responsible for
    turning that into an explicit on-screen error line. Never falls back to
    a hardcoded list and never returns an empty success-looking result.
    """
    import uefn_bridge

    entries = [
        ("uefn_" + method, _MCP_METHOD_DESCRIPTIONS.get(method, "(no description)"))
        for method in uefn_bridge._METHODS
    ]

    # The one deliberate NON-derived entry: uefn_verse_check is served by the
    # MCP server process directly (verse_lsp_check.py driving Epic's Verse
    # language server headless) — it never goes through uefn_bridge's
    # command.json dispatch, so it cannot appear in _METHODS. It works even
    # when UEFN is closed, unlike every other tool in this list.
    entries.append((
        "uefn_verse_check",
        "Run Epic's Verse language server for compiler diagnostics — works "
        "even when UEFN is closed (served directly by the MCP server, not "
        "the bridge)",
    ))

    return entries


def _show_mcp_info():
    """Open a window showing MCP bridge commands and AI compatibility."""
    if not _HAS_TKINTER:
        return

    win = tk.Tk()
    win.title("Trashbyrd's MCP Bridge")
    win.geometry("620x780")
    win.configure(bg=_BG)

    # Style
    style = ttk.Style(win)
    style.theme_use("clam")
    style.configure(".", background=_BG, foreground=_TEXT_FG)
    style.configure("TFrame", background=_BG)
    style.configure("TScrollbar", background=_SECTION_BG, troughcolor=_BG, borderwidth=0)
    style.configure(
        "MCP.Treeview",
        background=_SECTION_BG, foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG, rowheight=20,
        font=("Consolas", 9),
    )
    style.configure(
        "MCP.Treeview.Heading",
        background=_BG, foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"), relief="flat",
    )
    style.map("MCP.Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    tk.Label(
        win, text="MCP Bridge Commands",
        font=("Segoe UI", 14, "bold"), fg=_HEADER_FG, bg=_BG,
    ).pack(padx=16, pady=(12, 4), anchor=tk.W)

    tk.Label(
        win,
        text="These tools are accessible to AI agents via the MCP server.\n"
             "The bridge runs inside UEFN and communicates via file-based IPC.",
        font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG, justify=tk.LEFT,
    ).pack(padx=16, pady=(0, 8), anchor=tk.W)

    # Derived DYNAMICALLY from uefn_bridge._METHODS — see _mcp_command_entries()
    # docstring. No hardcoded command list here: a stale copy is exactly the
    # bug this indirection exists to prevent. On failure, render an explicit
    # error row naming the module and exception rather than an empty panel
    # or a fallback list (project doctrine: no success-shaped failures).
    try:
        commands = _mcp_command_entries()
    except Exception as e:
        unreal.log_warning("uefn_launcher: _mcp_command_entries failed: " + str(e))
        commands = [("ERROR", "uefn_bridge: " + str(e))]

    cmd_frame = tk.Frame(win, bg=_SECTION_BG, padx=8, pady=4)
    cmd_frame.pack(fill=tk.X, padx=12, pady=4)

    cmd_tree = ttk.Treeview(
        cmd_frame, columns=("cmd", "desc"), show="headings",
        style="MCP.Treeview", height=len(commands),
    )
    cmd_tree.heading("cmd", text="Command")
    cmd_tree.heading("desc", text="Description")
    cmd_tree.column("cmd", width=200)
    cmd_tree.column("desc", width=360)

    for cmd_name, desc in commands:
        cmd_tree.insert("", tk.END, values=(cmd_name, desc))

    cmd_tree.pack(fill=tk.X)

    # Compatible AI section
    ai_frame = tk.Frame(win, bg=_BG, padx=16, pady=8)
    ai_frame.pack(fill=tk.X)

    tk.Label(
        ai_frame, text="Compatible AI Assistants:",
        font=("Segoe UI", 10, "bold"), fg=_HEADER_FG, bg=_BG,
    ).pack(anchor=tk.W)

    clients = [
        ("Claude Code", "Auto-configured (.mcp.json)"),
        ("Codex CLI", "MCP via stdio (manual config)"),
        ("Gemini CLI", "MCP via stdio (manual config)"),
        ("Cursor IDE", "Built-in MCP (manual config)"),
        ("Windsurf", "MCP via config (manual)"),
        ("VS Code Copilot", "MCP via extension (manual)"),
    ]

    ai_list_frame = tk.Frame(ai_frame, bg=_SECTION_BG, padx=4, pady=4)
    ai_list_frame.pack(fill=tk.X, pady=(4, 0))

    ai_tree = ttk.Treeview(
        ai_list_frame, columns=("client", "notes"), show="headings",
        style="MCP.Treeview", height=min(len(clients), 6),
    )
    ai_tree.heading("client", text="Client")
    ai_tree.heading("notes", text="Integration")
    ai_tree.column("client", width=200)
    ai_tree.column("notes", width=360)

    for client, notes in clients:
        ai_tree.insert("", tk.END, values=(client, notes))

    ai_tree.pack(fill=tk.X)

    tk.Label(
        ai_frame,
        text="Any MCP-compatible client using stdio transport should work.",
        font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG,
    ).pack(anchor=tk.W, pady=(4, 0))

    # Footer
    footer = tk.Frame(win, bg=_SECTION_BG, padx=8, pady=2)
    footer.pack(fill=tk.X, side=tk.BOTTOM)
    social = tk.Label(footer, text="@thetrashbyrd", font=("Segoe UI", 8),
                      fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2")
    social.pack(side=tk.RIGHT, padx=(0, 4))
    social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # Tick pump
    _mcp_tick = [None]

    def _tick(_dt):
        try:
            if win.winfo_exists():
                win.update()
            else:
                if _mcp_tick[0]:
                    unreal.unregister_slate_post_tick_callback(_mcp_tick[0])
                    _mcp_tick[0] = None
        except tk.TclError:
            if _mcp_tick[0]:
                unreal.unregister_slate_post_tick_callback(_mcp_tick[0])
                _mcp_tick[0] = None
        except Exception:
            pass

    def _on_close():
        if _mcp_tick[0]:
            unreal.unregister_slate_post_tick_callback(_mcp_tick[0])
            _mcp_tick[0] = None
        win.destroy()

    win.protocol("WM_DELETE_WINDOW", _on_close)
    _mcp_tick[0] = unreal.register_slate_post_tick_callback(_tick)


# ---------------------------------------------------------------------------
# Tool actions
# ---------------------------------------------------------------------------

def _launch_reloaded(module_name, entry_point, friendly_name):
    """Generic launcher shared by every dispatch entry below: import the
    named sibling module fresh, ``importlib.reload`` it (so in-editor edits
    are picked up on the next launch without restarting UEFN), call its
    entry-point function, and surface any failure as both a log warning and
    (if tkinter is available) an error dialog. ``module_name`` is used in
    the log line, ``friendly_name`` in the dialog/log text shown to the
    user — matching the two different strings each hand-written branch of
    the old elif chain used to hardcode per tool."""
    try:
        import importlib
        module = importlib.import_module(module_name)
        importlib.reload(module)
        getattr(module, entry_point)()
    except Exception as e:
        unreal.log_warning("uefn_launcher: Failed to launch " + module_name + ": " + str(e))
        if _HAS_TKINTER:
            messagebox.showerror("Error", "Failed to launch " + friendly_name + ":\n" + str(e))


def _launch_moderation_scan():
    """Dedicated (not the generic _launch_reloaded) because this is the one
    tool with an extra ModuleNotFoundError branch — moderation_scanner.py
    can be legitimately absent from an older/partial project sync, and that
    case gets its own actionable message instead of the generic error."""
    try:
        import importlib
        import moderation_scanner
        importlib.reload(moderation_scanner)
        moderation_scanner.show_moderation_scan()
    except ModuleNotFoundError:
        msg = (
            "moderation_scanner.py is missing from your project's Content/Python/ folder.\n\n"
            "Re-run the /uefn-bridge install to sync all tool files."
        )
        unreal.log_warning("uefn_launcher: moderation_scanner module not found — " + msg)
        if _HAS_TKINTER:
            messagebox.showerror("Missing Module", msg)
    except Exception as e:
        unreal.log_warning("uefn_launcher: Failed to launch moderation_scanner: " + str(e))
        if _HAS_TKINTER:
            messagebox.showerror("Error", "Failed to launch IP / Moderation Scan:\n" + str(e))


def _resolve_tag_inspect_report_path(module):
    """Best-effort resolution of tag_inspect's own report-path helper.

    tag_inspect.py's contract (docs/VERSE-TAG-INSPECTOR-SPEC.md) says it
    "exposes a path helper for reading it back" without this file pinning
    an exact name — probe the documented/likely names defensively instead
    of hardcoding one that might not match its actual API, falling back to
    reconstructing the primary next-to-script path (mirroring
    ``_moderation_report_path`` in uefn_bridge.py) only if no helper is
    found. Never raises.
    """
    for name in ("tag_inspect_report_path", "report_path", "get_report_path"):
        fn = getattr(module, name, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                continue
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_inspect_report.json")


def _read_tag_inspect_report(module):
    """Read back tag_inspect_report.json via the resolved path.

    Returns ``(data, error)``. ``(None, None)`` means the file simply
    doesn't exist yet — the caller shows an actionable "run the scan
    first" message rather than an empty window, never a blank panel that
    looks like a clean/empty result. ``error`` is set only on an actual
    read/parse failure.
    """
    path = _resolve_tag_inspect_report_path(module)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f), None
    except FileNotFoundError:
        return None, None
    except Exception as e:
        return None, str(e)


def _show_tag_inspect_window(tag_inspect_module):
    """Render tag_inspect_report.json human-readably: per actor, its label,
    whether it has a tag component, its tags, and each tag's parent chain
    as a breadcrumb. Actors with no tag component (or a component with
    zero tags) are listed FIRST and flagged with a warning glyph — omission
    is exactly the failure mode this tool exists to prevent, so a missing
    tag must never be buried at the bottom of a long report."""
    if not _HAS_TKINTER:
        return

    data, error = _read_tag_inspect_report(tag_inspect_module)

    win = tk.Tk()
    win.title("Verse Tag Inspector")
    win.geometry("720x560")
    win.configure(bg=_BG)

    style = ttk.Style(win)
    style.theme_use("clam")
    style.configure(".", background=_BG, foreground=_TEXT_FG)
    style.configure("TFrame", background=_BG)
    style.configure(
        "Tag.Treeview",
        background=_SECTION_BG, foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG, rowheight=20,
        font=("Consolas", 9),
    )
    style.configure(
        "Tag.Treeview.Heading",
        background=_BG, foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"), relief="flat",
    )
    style.map("Tag.Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    tk.Label(
        win, text="Verse Tag Inspector",
        font=("Segoe UI", 14, "bold"), fg=_HEADER_FG, bg=_BG,
    ).pack(padx=16, pady=(12, 4), anchor=tk.W)

    tk.Label(
        win,
        text="Reads Verse gameplay tags from the actor's tag COMPONENT —\n"
             "uefn_get_property can't see these (flat actor-property read only).",
        font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG, justify=tk.LEFT,
    ).pack(padx=16, pady=(0, 8), anchor=tk.W)

    if error is not None:
        tk.Label(
            win, text="Failed to read tag_inspect_report.json:\n" + error,
            font=("Segoe UI", 9), fg="#B23B2E", bg=_BG, justify=tk.LEFT, wraplength=680,
        ).pack(padx=16, pady=8, anchor=tk.W)
        return

    if data is None:
        tk.Label(
            win,
            text="No tag_inspect_report.json found yet.\n\n"
                 "Run the scan first — call the uefn_tag_inspect MCP tool "
                 "(or ask your AI assistant to run it), then reopen this "
                 "window.",
            font=("Segoe UI", 10), fg=_TEXT_FG, bg=_BG, justify=tk.LEFT, wraplength=680,
        ).pack(padx=16, pady=24, anchor=tk.W)
        return

    discovery = data.get("discovery") or {}
    if discovery.get("notes"):
        tk.Label(
            win, text=str(discovery.get("notes")),
            font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG, justify=tk.LEFT, wraplength=680,
        ).pack(padx=16, pady=(0, 6), anchor=tk.W)

    tree_frame = tk.Frame(win, bg=_SECTION_BG, padx=8, pady=4)
    tree_frame.pack(fill=tk.BOTH, expand=True, padx=12, pady=4)

    tree = ttk.Treeview(
        tree_frame, columns=("value",), show="tree headings",
        style="Tag.Treeview",
    )
    tree.heading("#0", text="Actor / Tag")
    tree.heading("value", text="Parent chain")
    tree.column("#0", width=320)
    tree.column("value", width=340)

    actors = list(data.get("actors") or [])
    # Flag actors with no tag component or zero tags and list them FIRST —
    # this mirrors the JSON contract's ordering intent so a missing tag is
    # never buried at the bottom of a long report.
    flagged = [a for a in actors if not a.get("has_verse_tag_component") or not a.get("tags")]
    normal = [a for a in actors if a not in flagged]

    def _insert_actor(actor, is_flagged):
        label = actor.get("label", "<unlabeled>")
        has_component = actor.get("has_verse_tag_component")
        tags = actor.get("tags") or []
        summary = ("⚠ " if is_flagged else "") + str(label)
        if not has_component:
            summary += "  (no tag component)"
        elif not tags:
            summary += "  (tag component, zero tags)"
        node = tree.insert("", tk.END, text=summary, values=("",))
        for tag in tags:
            name = tag.get("name", "<unnamed>")
            chain = " > ".join(tag.get("parent_chain") or [])
            tree.insert(node, tk.END, text=str(name), values=(chain,))

    for actor in flagged:
        _insert_actor(actor, True)
    for actor in normal:
        _insert_actor(actor, False)

    tree.pack(fill=tk.BOTH, expand=True)

    summary_bits = [
        str(len(actors)) + " actor(s) scanned",
        str(len(flagged)) + " flagged (no component / zero tags)",
        str(data.get("tag_class_count", 0)) + " tag classes discovered",
    ]
    if data.get("verse_dir"):
        summary_bits.append("verse_dir: " + str(data.get("verse_dir")))
    tk.Label(
        win, text="  |  ".join(summary_bits),
        font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG, justify=tk.LEFT,
    ).pack(padx=16, pady=(4, 8), anchor=tk.W)


def _launch_tag_inspect():
    """Dedicated (not the generic _launch_reloaded), mirroring
    _launch_moderation_scan's extra ModuleNotFoundError branch: tag_inspect.py
    can be legitimately absent from an older/partial project sync, and that
    gets its own actionable message instead of the generic error. Unlike
    the moderation scan, tag inspection needs no AI round-trip —
    inspect_tags() runs entirely locally and writes its own report — so this
    just imports the module and hands it to the render window, which reads
    the report back via tag_inspect's path helper (see
    _resolve_tag_inspect_report_path)."""
    try:
        import importlib
        import tag_inspect
        importlib.reload(tag_inspect)
    except ModuleNotFoundError:
        msg = (
            "tag_inspect.py is missing from your project's Content/Python/ folder.\n\n"
            "Re-run the /uefn-bridge install to sync all tool files."
        )
        unreal.log_warning("uefn_launcher: tag_inspect module not found — " + msg)
        if _HAS_TKINTER:
            messagebox.showerror("Missing Module", msg)
        return
    except Exception as e:
        unreal.log_warning("uefn_launcher: Failed to import tag_inspect: " + str(e))
        if _HAS_TKINTER:
            messagebox.showerror("Error", "Failed to launch Verse Tag Inspector:\n" + str(e))
        return
    _show_tag_inspect_window(tag_inspect)


# Module-level action -> launch-callable dispatch. Keyed by the SAME
# "action" strings used in the _TOOLS card list above, so a test can assert
# parity (every _TOOLS action has a dispatch entry and vice versa) without
# either list going stale relative to the other. "mcp_info" intentionally
# maps directly to _show_mcp_info (no try/except wrapper) — that matches
# the original elif branch exactly, which never wrapped this one call.
_TOOL_DISPATCH = {
    "device_audit": lambda: _launch_reloaded("device_audit", "run_audit", "Device Audit"),
    "material_browser": lambda: _launch_reloaded("material_browser", "show_material_browser", "Material Browser"),
    "texture_finder": lambda: _launch_reloaded("texture_finder", "show_texture_finder", "Texture Finder"),
    "niagara_inspector": lambda: _launch_reloaded("niagara_inspector", "show_niagara_inspector", "Niagara Inspector"),
    "dependency_viewer": lambda: _launch_reloaded("dependency_viewer", "show_dependency_viewer", "Dependency Viewer"),
    "health_scanner": lambda: _launch_reloaded("health_scanner", "show_health_scanner", "Project Health"),
    "moderation_scan": _launch_moderation_scan,
    "tag_inspect": _launch_tag_inspect,
    "level_stats": lambda: _launch_reloaded("level_stats", "show_level_stats", "Level Stats"),
    "mcp_info": _show_mcp_info,
    "asset_sweep": lambda: _launch_reloaded("asset_sweep", "show_asset_sweep", "Dead Asset Sweep"),
    "property_inspector": lambda: _launch_reloaded("property_inspector", "show_ui", "Property Inspector"),
    "build_mode_cleanup": lambda: _launch_reloaded("build_mode_cleanup", "show_ui", "Build-Mode Cleanup"),
}


def _launch_tool(action):
    """Launch the tool identified by *action* via the module-level
    _TOOL_DISPATCH dict above. Behavior is identical to the elif chain this
    replaced: an unknown action logs the same warning and does nothing
    else."""
    handler = _TOOL_DISPATCH.get(action)
    if handler is None:
        unreal.log_warning("uefn_launcher: Unknown action: " + str(action))
        return
    handler()


# ---------------------------------------------------------------------------
# Launcher UI
# ---------------------------------------------------------------------------

def show_launcher():
    """Create and display the launcher hub window."""
    if not _HAS_TKINTER:
        unreal.log_error("uefn_launcher: tkinter is not available.")
        return

    import math
    _rows = math.ceil(len(_TOOLS) / 3)
    # Per-row cost tracks _CARD_MIN_H (below) + its grid pady (6+6) so the
    # window is tall enough to show every row's card at full, unclipped height.
    _win_height = 150 + _rows * 180

    root = tk.Tk()
    root.title("Trashbyrd's Power Tools v" + BRIDGE_VERSION)
    root.geometry("720x{}".format(_win_height))
    root.configure(bg=_BG)
    root.resizable(True, True)

    # ==================================================================
    # Load branding image (trashbyrd_40x40.png next to this script)
    # ==================================================================
    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path = os.path.join(_script_dir, "trashbyrd_40x40.png")
        if os.path.isfile(_logo_path):
            _logo_img = tk.PhotoImage(file=_logo_path, master=root)
    except Exception:
        pass  # image not available — skip silently

    # ==================================================================
    # Title bar area
    # ==================================================================
    title_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    title_frame.pack(fill=tk.X)

    # Logo in title (keep reference on widget to prevent GC)
    if _logo_img:
        title_logo = tk.Label(title_frame, image=_logo_img, bg=_BG, cursor="hand2")
        title_logo._img_ref = _logo_img
        title_logo.pack(side=tk.LEFT, padx=(0, 10))
        title_logo.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    title_label = tk.Label(
        title_frame,
        text="Trashbyrd's Power Tools",
        font=("Segoe UI", 16, "bold"),
        fg=_HEADER_FG,
        bg=_BG,
    )
    title_label.pack(side=tk.LEFT)

    # Bridge status indicator (dot + text)
    status_frame = tk.Frame(title_frame, bg=_BG)
    status_frame.pack(side=tk.RIGHT)

    status_dot = tk.Canvas(status_frame, width=14, height=14, bg=_BG, highlightthickness=0)
    status_dot.pack(side=tk.LEFT, padx=(0, 6))
    _dot_id = status_dot.create_oval(2, 2, 12, 12, fill="gray", outline="")

    status_text = tk.Label(
        status_frame,
        text="Checking...",
        font=("Segoe UI", 9),
        fg=_TEXT_DIM,
        bg=_BG,
    )
    status_text.pack(side=tk.LEFT)

    # ==================================================================
    # Tool cards area
    # ==================================================================
    cards_frame = tk.Frame(root, bg=_BG, padx=16, pady=4)
    cards_frame.pack(fill=tk.BOTH, expand=True)

    # Configure grid for 3-column layout
    cards_frame.columnconfigure(0, weight=1)
    cards_frame.columnconfigure(1, weight=1)
    cards_frame.columnconfigure(2, weight=1)

    # Flat card + offset drop-shadow constants. The shadow frame sits behind
    # the card (bottom-right peek) and only ITS place() offset ever changes;
    # the card's place() geometry is constant, so the tile never moves/resizes.
    _MAX_SHADOW = 4
    _HOVER_SHADOW = 0
    _SHADOW_COLOR = "#9A9182"
    _CARD_MIN_W = 190
    # Tall enough for icon + title + a full 3-line description at the label's
    # font/wraplength below, with no clipping against the fixed card height.
    _CARD_MIN_H = 200

    for idx, tool in enumerate(_TOOLS):
        row = idx // 3
        col = idx % 3

        holder = tk.Frame(cards_frame, bg=_BG, width=_CARD_MIN_W, height=_CARD_MIN_H)
        holder.grid(row=row, column=col, padx=6, pady=6, sticky="nsew")
        holder.grid_propagate(False)
        cards_frame.rowconfigure(row, weight=1)

        # Shadow first (bottom layer), card second (stacked above it).
        shadow = tk.Frame(holder, bg=_SHADOW_COLOR)
        shadow.place(
            x=_MAX_SHADOW, y=_MAX_SHADOW, relwidth=1.0, relheight=1.0,
            width=-_MAX_SHADOW, height=-_MAX_SHADOW,
        )

        card = tk.Frame(
            holder,
            bg=_SECTION_BG,
            padx=12,
            pady=10,
            cursor="hand2",
            highlightbackground=_CARD_BORDER,
            highlightthickness=1,
            relief=tk.FLAT,
            borderwidth=0,
        )
        card.place(
            x=0, y=0, relwidth=1.0, relheight=1.0,
            width=-_MAX_SHADOW, height=-_MAX_SHADOW,
        )
        card.lift()

        icon_label = tk.Label(
            card,
            text=tool["icon"],
            font=("Segoe UI", 22),
            bg=_SECTION_BG,
            fg=_HEADER_FG,
        )
        icon_label.pack(anchor=tk.W, pady=(0, 4))

        name_label = tk.Label(
            card,
            text=tool["name"],
            font=("Segoe UI", 11, "bold"),
            fg=_HEADER_FG,
            bg=_SECTION_BG,
            anchor=tk.W,
        )
        name_label.pack(fill=tk.X)

        desc_label = tk.Label(
            card,
            text=tool["description"],
            font=("Segoe UI", 9),
            fg=_TEXT_DIM,
            bg=_SECTION_BG,
            anchor="nw",
            justify=tk.LEFT,
            wraplength=150,
            # Reserve exactly 3 text lines so every card's description area
            # is the same height regardless of how many lines it actually
            # wraps to -- consistent cards, nothing clipped.
            height=3,
        )
        desc_label.pack(anchor="w", fill=tk.X, pady=(2, 0))

        # Bind press to all widgets in the card (physical-button feel).
        # Only the SHADOW's place offset changes on press/hover/rest — the
        # card itself is never re-placed, so the tile cannot shift.
        action = tool["action"]
        hover_state = [False]

        def _make_press_handler(a, sh, c, i, n, d, hs):
            def _press(_event):
                sh.place_configure(x=0, y=0)
                _launch_tool(a)

                def _restore():
                    if hs[0]:
                        sh.place_configure(x=_HOVER_SHADOW, y=_HOVER_SHADOW)
                        for w in (c, i, n, d):
                            w.configure(bg=_CARD_HOVER)
                    else:
                        sh.place_configure(x=_MAX_SHADOW, y=_MAX_SHADOW)
                        for w in (c, i, n, d):
                            w.configure(bg=_SECTION_BG)

                root.after(1000, _restore)
            return _press

        press_handler = _make_press_handler(
            action, shadow, card, icon_label, name_label, desc_label, hover_state
        )
        card.bind("<ButtonPress-1>", press_handler)
        icon_label.bind("<ButtonPress-1>", press_handler)
        name_label.bind("<ButtonPress-1>", press_handler)
        desc_label.bind("<ButtonPress-1>", press_handler)

        # Hover effects — shadow shrinks (looks slightly pressed); card
        # geometry is untouched, only its (and its labels') bg recolors.
        def _make_enter_handler(sh, c, i, n, d, hs):
            def _enter(_event):
                for w in (c, i, n, d):
                    w.configure(bg=_CARD_HOVER)
                c.configure(highlightbackground=_CARD_HOVER)
                hs[0] = True
                sh.place_configure(x=_HOVER_SHADOW, y=_HOVER_SHADOW)
            return _enter

        def _make_leave_handler(sh, c, i, n, d, hs):
            def _leave(_event):
                for w in (c, i, n, d):
                    w.configure(bg=_SECTION_BG)
                c.configure(highlightbackground=_CARD_BORDER)
                hs[0] = False
                sh.place_configure(x=_MAX_SHADOW, y=_MAX_SHADOW)
            return _leave

        enter_handler = _make_enter_handler(shadow, card, icon_label, name_label, desc_label, hover_state)
        leave_handler = _make_leave_handler(shadow, card, icon_label, name_label, desc_label, hover_state)

        card.bind("<Enter>", enter_handler)
        card.bind("<Leave>", leave_handler)

    # ==================================================================
    # Footer with social link (bottom right)
    # ==================================================================
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM)

    # Version / bridge-sync status label on the left (opposite the
    # @thetrashbyrd link) — shows whether the engine-side copy was just
    # self-synced from a newer project copy on this load.
    footer_version = tk.Label(
        footer_frame,
        text=_bridge_status_line(),
        font=("Segoe UI", 8),
        fg=_TEXT_DIM,
        bg=_SECTION_BG,
    )
    footer_version.pack(side=tk.LEFT, padx=(4, 0))

    # @thetrashbyrd on the right (no logo — already in title bar)
    footer_social = tk.Label(
        footer_frame,
        text="@thetrashbyrd",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_SECTION_BG,
        cursor="hand2",
    )
    footer_social.pack(side=tk.RIGHT, padx=(0, 4))
    footer_social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # ==================================================================
    # Status bar at bottom (above footer)
    # ==================================================================
    statusbar_frame = tk.Frame(root, bg=_SECTION_BG, padx=12, pady=6)
    statusbar_frame.pack(fill=tk.X, side=tk.BOTTOM)

    statusbar_label = tk.Label(
        statusbar_frame,
        text="Bridge: checking...",
        font=("Segoe UI", 8),
        fg=_TEXT_DIM,
        bg=_SECTION_BG,
        anchor=tk.W,
    )
    statusbar_label.pack(fill=tk.X)

    # ==================================================================
    # Periodic bridge status update
    # ==================================================================
    def _update_status():
        hb = _read_heartbeat()
        if hb["connected"]:
            status_dot.itemconfig(_dot_id, fill=_ACCENT_GREEN)
            status_text.config(text="Bridge connected", fg=_ACCENT_GREEN)
            bar_text = (
                "Bridge: connected | Level: {level} | Actors: {actors} | "
                "Last heartbeat: {ts}"
            ).format(
                level=hb["level_name"] or "?",
                actors=hb["actor_count"],
                ts=hb["timestamp"][:19] if hb["timestamp"] else "?",
            )
        else:
            status_dot.itemconfig(_dot_id, fill="#C0392B")
            status_text.config(text="Bridge disconnected", fg="#C0392B")
            bar_text = "Bridge: disconnected"
            if hb["status"] == "stopped":
                bar_text += " (stopped)"
            elif hb["status"] == "no heartbeat":
                bar_text += " (no heartbeat file)"
            elif hb["status"] == "bridge dir unavailable":
                bar_text += " (bridge dir unavailable — see log)"

        statusbar_label.config(text=bar_text)

        # Schedule next check in 5 seconds
        try:
            root.after(5000, _update_status)
        except tk.TclError:
            pass  # window was closed

    # Run initial status check
    _update_status()

    # ==================================================================
    # Tick callback -- pump tkinter from the Unreal event loop
    # ==================================================================
    _tick_handle = [None]

    def _tick_pump(delta_time):
        try:
            root.update()
        except tk.TclError:
            # Window was closed -- unregister the tick callback
            if _tick_handle[0] is not None:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None

    _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick_pump)

    # Clean close via the X button
    def _on_close():
        if _tick_handle[0] is not None:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    unreal.log("uefn_launcher: Launcher window opened.")
