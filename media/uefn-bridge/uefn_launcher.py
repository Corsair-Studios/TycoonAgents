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
import subprocess
import webbrowser

try:
    import tkinter as tk
    from tkinter import ttk, messagebox, scrolledtext
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
        "name": "Material & Texture Browser",
        "description": "Browse materials and textures, see cross-references, find unused",
        "action": "material_texture_browser",
    },
    {
        "icon": "\u2728",  # sparkles
        "name": "Niagara Inspector",
        "description": "Browse VFX systems, find dependencies and usage",
        "action": "niagara_inspector",
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


# ---------------------------------------------------------------------------
# Clipboard — Tk's clipboard API is FORBIDDEN in this file. Do not reintroduce
# clipboard_clear() / clipboard_append() / clipboard_get() / selection_own() /
# selection_handle() on any widget here.
#
# WHY: Tk's clipboard requires the window to take ownership of the system
# CLIPBOARD selection and then service selection-request events from ITS OWN
# Tk event loop. Every Power Tools window (this launcher included) is pumped
# by UEFN's register_slate_post_tick_callback tick pump instead of running
# mainloop(), so there is no owning event loop able to service a selection
# request. That leaves Tcl/Tk unable to hand off the clipboard and it aborts
# the whole host process — this is documented and confirmed in
# moderation_scanner.py's identical module-level comment (real crash stack:
# ucrtbase -> python311 -> _tkinter -> tcl86t (x5) -> tk86t -> user32 ...
# Abort signal received), i.e. it used to crash UEFN itself, not just the
# window. Reimplemented locally here (not imported from moderation_scanner.py)
# to avoid pulling that ~4000-line module's heavier imports into this
# launcher, which is loaded very early during UEFN startup — see
# _mcp_command_entries()'s docstring for the same lazy-import reasoning.
# ---------------------------------------------------------------------------

def _copy_text_to_system_clipboard(text):
    """Best-effort OS clipboard copy that never touches Tk's clipboard API.

    Pipes `text` to the Windows `clip` console utility via subprocess; `clip`
    owns and services the clipboard itself in its own separate process, so
    this has nothing to do with Tk/Tcl and cannot reproduce the abort
    described above. `startupinfo`/`CREATE_NO_WINDOW` keep the console
    window hidden so nothing flashes over the editor.

    Returns True on success, False if unavailable/failed (non-Windows, no
    `clip` on PATH, timeout, etc.) — callers MUST have a no-clipboard
    fallback for the False case (see `_show_copy_fallback_dialog`). Never
    raises.
    """
    if os.name != "nt":
        return False
    try:
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE
        proc = subprocess.run(
            ["clip"],
            input=text.encode("utf-16-le"),
            startupinfo=startupinfo,
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=5,
        )
        return proc.returncode == 0
    except Exception:
        return False


def _show_copy_fallback_dialog(root, text, title="Copy this text"):
    """No-clipboard-API fallback: a small Toplevel showing `text` pre-selected
    in a ScrolledText widget so the user can press Ctrl+C themselves. Uses
    zero Tk clipboard calls (no clipboard_get/selection_own either), so it
    cannot reproduce the crash described above.
    """
    dlg = tk.Toplevel(root)
    dlg.title(title)
    dlg.configure(bg=_BG)
    dlg.geometry("640x360")
    tk.Label(
        dlg,
        text=(
            "Clipboard copy is unavailable here — the text below is "
            "pre-selected. Click inside it and press Ctrl+C to copy."
        ),
        font=("Segoe UI", 9, "bold"), fg=_HEADER_FG, bg=_BG,
        wraplength=610, justify=tk.LEFT,
    ).pack(fill=tk.X, padx=12, pady=(12, 6))

    box = scrolledtext.ScrolledText(
        dlg, wrap=tk.WORD, bg=_SECTION_BG, fg=_TEXT_FG,
        insertbackground=_TEXT_FG, relief="flat", font=("Consolas", 9),
    )
    box.pack(fill=tk.BOTH, expand=True, padx=12, pady=(0, 12))
    box.insert("1.0", text)
    box.tag_add("sel", "1.0", "end")
    box.focus_set()

    tk.Button(
        dlg, text="Close", font=("Segoe UI", 9), bg=_SECTION_BG, fg=_TEXT_FG,
        relief="flat", padx=10, pady=4, command=dlg.destroy,
    ).pack(pady=(0, 12))


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


def _classify_tag_actor(actor):
    """Classify *actor* (one entry of an ``inspect_tags()`` ``actors``
    list) into one of:
      "ok"             -- >=1 tag decoded, from EITHER source (checked
                           FIRST, before has_verse_tag_component, because
                           0.0.534's actor-level tag source can decode a
                           tag from AActor::Tags on an actor that has no
                           tag component at all -- see tag_inspect.py's
                           "source": "actor_tags" entries). Shown.
      "no_component"   -- has_verse_tag_component is False and no tag was
                           decoded from any source. Hidden.
      "empty"          -- extraction_status == "empty": a strategy
                           POSITIVELY iterated the tag container and found
                           zero entries, and no actor-level tag rescued
                           it. Confirmed-empty; hidden.
      "unreadable"     -- extraction_status == "unreadable": a tag
                           component was present but no decode strategy
                           could read it, and no actor-level tag rescued
                           it. MUST be shown, flagged -- hiding this would
                           present a failed read as a clean empty result,
                           the exact false negative this tool exists to
                           prevent (see tag_inspect.py's module docstring
                           field case).
      "legacy_empty"   -- a report written before ``extraction_status``
                           existed (the key is absent entirely, not just
                           falsy) with has_verse_tag_component True and an
                           empty ``tags`` list. There is no way to tell a
                           legacy confirmed-empty read from a legacy
                           unreadable one, so this is treated the same as
                           the pre-0.0.534 behavior (hidden) rather than
                           guessing -- re-running the scan against the
                           current tag_inspect.py resolves the ambiguity.
    Never raises."""
    if actor.get("tags"):
        return "ok"
    if not actor.get("has_verse_tag_component"):
        return "no_component"
    if "extraction_status" not in actor:
        return "legacy_empty"
    status = actor.get("extraction_status")
    if status == "unreadable":
        return "unreadable"
    return "empty"


def _render_tag_report(tree, discovery_label, summary_label, data, source_label):
    """Populate *tree*/*discovery_label*/*summary_label* from an
    ``inspect_tags()``-shaped result dict (or ``None``). Clears the tree
    first, so this is safe to call repeatedly (starting view, then again
    after every "Run Scan" click) without leaking stale rows.

    Actors classified "no_component" or "empty" by ``_classify_tag_actor``
    are NOT inserted as rows — a level with tens of thousands of untagged
    actors made the tree unusable and buried the handful of actors that
    actually carried tags. "unreadable" actors ARE inserted (flagged with
    a "(tags unreadable — see debug)" label suffix and their decode debug
    as a child row) even though their ``tags`` list is also empty --
    hiding a failed read next to a confirmed-empty one would recreate the
    exact false negative this tool exists to prevent. Hidden counts are
    never silently lost: the summary line below states the three-way
    split (no component / confirmed-empty / shown, with however many of
    those shown are flagged unreadable). ``actors`` is already sorted
    flagged-first by tag_inspect.sort_actors_flagged_first, so filtering
    it in place (rather than re-partitioning) preserves the original
    relative order of the remaining rows. The ``discovery`` block
    (component class, tag property, notes) is ALWAYS shown, not only on
    error/empty — when a scan finds a component but zero tags, that block
    is the only thing that explains why, and hiding it is what made the
    field failure this tool exists to prevent so hard to diagnose."""
    tree.delete(*tree.get_children())

    if data is None:
        discovery_label.config(text="")
        summary_label.config(text="")
        return

    discovery = data.get("discovery") or {}
    comp_class = discovery.get("component_class")
    tag_prop = discovery.get("tag_property")
    notes = discovery.get("notes") or ""
    discovery_text = "Component class: {}  |  Tag property: {}".format(
        comp_class if comp_class else "<none found>",
        tag_prop if tag_prop else "<none found>",
    )
    if notes:
        discovery_text += "\n" + str(notes)
    discovery_label.config(text=discovery_text)

    actors = list(data.get("actors") or [])
    statuses = {id(a): _classify_tag_actor(a) for a in actors}

    shown = [a for a in actors if statuses[id(a)] in ("ok", "unreadable")]
    no_component_count = sum(1 for a in actors if statuses[id(a)] == "no_component")
    empty_count = sum(1 for a in actors if statuses[id(a)] in ("empty", "legacy_empty"))
    unreadable_count = sum(1 for a in shown if statuses[id(a)] == "unreadable")

    def _insert_actor(actor, unreadable):
        label = actor.get("label", "<unlabeled>")
        display_label = str(label)
        if unreadable:
            display_label += "  (tags unreadable — see debug)"
        tags = actor.get("tags") or []
        node = tree.insert("", tk.END, text=display_label, values=("",))
        for tag in tags:
            name = tag.get("name", "<unnamed>")
            chain = " > ".join(tag.get("parent_chain") or [])
            # source distinguishes the normal tag-component container, the
            # 0.0.535 actor-level AActor::Tags rescue path, and the 0.0.537
            # offline __ExternalActors__ .uasset scan (now the PRIMARY
            # source -- see tag_inspect.py's scan_external_actors) --
            # surfaced here so a decoded tag's true origin is never
            # ambiguous.
            source = tag.get("source")
            if source == "actor_tags":
                chain = (chain + "  " if chain else "") + "[from actor Tags]"
            elif source == "external_actors":
                chain = (chain + "  " if chain else "") + "[from __ExternalActors__ .uasset]"
            tree.insert(node, tk.END, text=str(name), values=(chain,))
        if unreadable:
            debug = actor.get("extraction_debug") or {}
            debug_bits = []
            for key in ("type_name", "value_repr", "export_text", "note"):
                if debug.get(key):
                    debug_bits.append("{}={}".format(key, debug[key]))
            debug_text = "; ".join(debug_bits) if debug_bits else "<no debug captured>"
            tree.insert(node, tk.END, text="<unreadable>", values=(debug_text,))

    for actor in shown:
        _insert_actor(actor, unreadable=(statuses[id(actor)] == "unreadable"))

    deep_probe = data.get("deep_probe")

    # EMPTY-STATE placeholder: a blank tree with no explanation inside it
    # reads as "the panel is broken", not "the scan ran and found nothing
    # to show" -- a real field run had a user re-run the scan twice for
    # exactly that reason. Only inserted when actors WERE matched/examined
    # but every one of them is hidden; a genuinely empty actors list (no
    # actors matched label_pattern) is already explained by discovery.notes
    # above the tree, so this stays specific to the "hidden, not absent"
    # case.
    if not shown and actors:
        reason_bits = []
        if empty_count:
            reason_bits.append(str(empty_count) + " with a confirmed-empty tag container")
        if no_component_count:
            reason_bits.append(str(no_component_count) + " without a tag component")
        reason_text = " and ".join(reason_bits) if reason_bits else "hidden"
        placeholder_text = (
            "No rows: all " + str(len(actors)) + " matched actor(s) are hidden ("
            + reason_text + ") — tags were not found in editor data by the "
            "normal scan. "
            + (
                "See the deep probe rows below for where (if anywhere) tag "
                "data was actually found."
                if deep_probe else
                "Copy the MCP prompt for AI-assisted diagnosis."
            )
        )
        tree.insert("", tk.END, text=placeholder_text, values=("",))

    if deep_probe:
        _render_deep_probe(tree, deep_probe)

    summary_bits = [
        "Showing " + str(len(shown)) + " actor(s)"
        + (
            " (" + str(unreadable_count) + " flagged unreadable — see debug)"
            if unreadable_count else ""
        )
        + " — " + str(no_component_count) + " examined actor(s) without a "
        "tag component and " + str(empty_count) + " with a confirmed-empty "
        "tag container are hidden",
        str(data.get("tag_class_count", 0)) + " tag classes discovered",
    ]
    if deep_probe:
        summary_bits.append(
            "deep probe ran on " + str(len(deep_probe.get("probed_labels") or [])) + " actor(s)"
        )
    dp_skip_reason = data.get("deep_probe_skipped_reason")
    if dp_skip_reason:
        summary_bits.append("deep probe skipped: " + str(dp_skip_reason))
    if data.get("verse_dir"):
        summary_bits.append("verse_dir: " + str(data.get("verse_dir")))

    # Offline __ExternalActors__ scan (0.0.537, now the PRIMARY tag source
    # -- see tag_inspect.py's scan_external_actors) -- reported here
    # whether it succeeded or failed, and never silently: a discovery
    # failure surfaces its error + every directory it tried, out loud
    # (see docs/PATH-DISCOVERY.md), same as every other honest-failure
    # contract in this module.
    src_counts = {"component_tags": 0, "actor_tags": 0, "external_actors": 0}
    for a in actors:
        for t in a.get("tags") or []:
            s = t.get("source")
            if s in src_counts:
                src_counts[s] += 1
    if any(src_counts.values()):
        summary_bits.append(
            "tag sources: {} component, {} actor, {} external_actors".format(
                src_counts["component_tags"], src_counts["actor_tags"], src_counts["external_actors"],
            )
        )

    offline = data.get("offline")
    if offline:
        if offline.get("status") == "ok":
            summary_bits.append(
                "offline __ExternalActors__ scan: {} of {} .uasset file(s) "
                "matched under {}".format(
                    offline.get("files_matched", 0), offline.get("files_total", 0),
                    offline.get("external_actors_dir") or "<unknown>",
                )
            )
        else:
            summary_bits.append(
                "offline __ExternalActors__ scan FAILED: "
                + str(offline.get("error") or "unknown error")
            )

    offline_caveat = data.get("offline_caveat")
    if offline_caveat:
        summary_bits.append(str(offline_caveat))

    summary_bits.append(source_label)
    summary_label.config(text="  |  ".join(summary_bits))


def _render_deep_probe(tree, deep_probe):
    """Render ``report["deep_probe"]`` (see tag_inspect.py's
    ``_deep_probe_actor``) as tree rows: one parent row per probed actor
    label, a ``[context]`` group FIRST (world-streaming/world-partition
    diagnostic signals — class name, package, path, folder, component
    count, data layers), THEN children per property dumped — tag-component
    properties, then the actor's own ``tags`` property, then any other-
    component known-tag hit, then any probe read error — with property
    entries carrying a known-tag hit listed FIRST among themselves so the
    payload that actually answers "where do the tags live" is not buried
    under a full property dump. Guards every ``.get()`` so a missing/
    malformed ``deep_probe`` shape (including a legacy report with no
    ``context`` key, or no ``deep_probe`` key at all — the caller only
    invokes this when the key is present and truthy) can never crash the
    render. Never raises."""
    findings = deep_probe.get("findings") or []
    if not findings:
        return
    # "role" (added alongside the 0.0.536 partial-failure trigger) is
    # missing on reports from before that change -- default to
    # "non_decoded" so an old-shape deep_probe still renders sensibly
    # rather than crashing or mislabeling every row as a contrast sample.
    non_decoded_n = sum(1 for f in findings if f.get("role", "non_decoded") != "contrast_decoded")
    header = tree.insert(
        "", tk.END,
        text="DEEP PROBE — {} non-decoded actor(s) probed (plus {} contrast "
             "sample(s) that DID decode, if any)".format(
                 non_decoded_n, len(findings) - non_decoded_n
             ),
        values=("",),
    )
    for finding in findings:
        label = finding.get("actor_label", "<unlabeled>")
        role_suffix = "  [contrast — decoded ok]" if finding.get("role") == "contrast_decoded" else ""
        actor_node = tree.insert(header, tk.END, text=str(label) + role_suffix, values=("",))

        # CONTEXT rows (world-streaming/world-partition diagnostic signals
        # — see tag_inspect.py's _deep_probe_actor_context) render FIRST,
        # before the property-dump rows below. "context" is absent on a
        # report predating this field, so this whole block is guarded and
        # simply skipped for an old-shape finding.
        context = finding.get("context")
        if context:
            class_name = context.get("class_name") or {}
            context_node = tree.insert(actor_node, tk.END, text="[context]", values=("",))
            for ctx_key, ctx_value in (
                ("class_name", "{} ({})".format(
                    class_name.get("py_type"), class_name.get("ue_class")
                )),
                ("package", context.get("package")),
                ("path_name", context.get("path_name")),
                ("folder", context.get("folder")),
                ("component_count", context.get("component_count")),
                ("data_layers", context.get("data_layers")),
            ):
                tree.insert(context_node, tk.END, text=str(ctx_key), values=(str(ctx_value),))

        rows = []  # [(has_hit, display_text, snippet_text), ...]
        comp = finding.get("tag_component") or {}
        comp_class = comp.get("class_name")
        for prop in comp.get("properties") or []:
            hits = prop.get("known_tag_hits") or []
            name = prop.get("name", "<unnamed>")
            type_name = prop.get("type_name", "<unknown>")
            text = "[component:{}] {} ({})".format(comp_class or "?", name, type_name)
            snippet = prop.get("value_repr") or ""
            if hits:
                snippet += "  HITS: " + ", ".join(hits)
            rows.append((bool(hits), text, snippet))

        actor_tags_prop = finding.get("actor_tags_property")
        if actor_tags_prop:
            hits = actor_tags_prop.get("known_tag_hits") or []
            text = "[actor.tags] ({})".format(actor_tags_prop.get("type_name", "<unknown>"))
            snippet = actor_tags_prop.get("value_repr") or ""
            if hits:
                snippet += "  HITS: " + ", ".join(hits)
            rows.append((bool(hits), text, snippet))

        for hit in finding.get("other_components_hits") or []:
            text = "[component:{}] {}".format(hit.get("component_class", "?"), hit.get("property", "?"))
            snippet = hit.get("value_repr") or ""
            hits = hit.get("known_tag_hits") or []
            if hits:
                snippet += "  HITS: " + ", ".join(hits)
            rows.append((True, text, snippet))

        for err in finding.get("errors") or []:
            rows.append((False, "[error] " + str(err.get("where")), str(err.get("exception_class"))))

        rows.sort(key=lambda r: not r[0])  # known-tag hits first, stable otherwise

        for has_hit, text, snippet in rows:
            display = ("★ " if has_hit else "") + text
            tree.insert(actor_node, tk.END, text=display, values=(snippet,))


def _show_tag_inspect_window(tag_inspect_module):
    """Verse Tag Inspector window.

    ``inspect_tags()`` is pure local Python that runs entirely inside
    UEFN's embedded interpreter and needs no AI round-trip (see
    tag_inspect.py's module docstring) — so this window's PRIMARY
    affordance is "Run Scan": it calls ``tag_inspect_module.inspect_tags``
    directly and renders the result immediately, instead of requiring the
    user to go run an MCP tool from an AI client first. A previously saved
    tag_inspect_report.json, if one exists, is still shown as a starting
    view on open (a convenience only — the window never DEPENDS on that
    file existing). An optional "Copy MCP prompt" button remains for users
    who'd rather have an AI assistant run/interpret the scan.

    ``inspect_tags()`` walks level actors and ``*.verse`` files on the
    calling thread — the UEFN main thread when invoked from here — so it
    can still take real time on a large project. It now wraps both heavy
    phases in a cancellable ``unreal.ScopedSlowTask`` (see
    ``_inspect_tags_live``/``_make_slow_task`` in tag_inspect.py) with
    explicit caps on actors/components/properties examined — a FIELD
    INCIDENT (a user's UEFN froze solid for 15+ minutes with no way out
    after clicking Run Scan with a blank label pattern, which matches
    EVERY actor) is why that dialog, those caps, and the confirmation
    below all exist. The ScopedSlowTask dialog is the PRIMARY in-progress
    UI (it owns the actual Cancel affordance), but this window must never
    itself look idle while a scan runs — see the status text and window
    title changes in ``_run_scan`` below. The Run Scan button is disabled
    (and its label swapped to "Scanning...") for the duration, guarded by
    the ``_scanning`` flag below so a queued repeat click can't re-enter
    it.

    An EMPTY label pattern matches every actor in the level — the exact
    setting that froze the editor in the field incident above. ``_run_scan``
    requires an explicit ``messagebox.askyesno`` confirmation before running
    in that case; a non-empty pattern (which is normally a small, bounded
    subset of actors) runs immediately with no extra prompt. This uses
    ``messagebox`` (already used elsewhere in this file for error dialogs),
    never Tk's own clipboard API — see the module-level clipboard warning
    below for why that specific API is forbidden in a tick-pumped window;
    ``messagebox`` dialogs are unaffected by that restriction.
    """
    if not _HAS_TKINTER:
        return

    win = tk.Tk()
    win.title("Verse Tag Inspector")
    win.geometry("720x640")
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
        text="PRIMARY source: an offline scan of the project's on-disk\n"
             "__ExternalActors__ .uasset files (see the summary line below).\n"
             "The live tag-component / actor-Tags read runs as corroboration —\n"
             "uefn_get_property can't see any of these (flat actor-property read only).",
        font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG, justify=tk.LEFT,
    ).pack(padx=16, pady=(0, 8), anchor=tk.W)

    # ------------------------------------------------------------------
    # Controls: label-pattern filter + Run Scan + Copy MCP prompt
    # ------------------------------------------------------------------
    controls = tk.Frame(win, bg=_BG)
    controls.pack(fill=tk.X, padx=16, pady=(0, 4))

    tk.Label(
        controls, text="Label pattern (blank = all actors):",
        font=("Segoe UI", 9), fg=_TEXT_FG, bg=_BG,
    ).pack(side=tk.LEFT)

    pattern_var = tk.StringVar(master=win, value="")
    pattern_entry = tk.Entry(controls, textvariable=pattern_var, width=22, font=("Segoe UI", 9))
    pattern_entry.pack(side=tk.LEFT, padx=(6, 10))
    # Keep explicit strong references to both widgets on the window itself.
    # FIELD BUG this guards against: a user typed "SGMarker" and Run Scan
    # still matched all 44617 actors (label_pattern=None) because
    # pattern_var.get() returned "" — UEFN's embedded Python has been
    # observed to garbage-collect a StringVar that lives only in this
    # closure. _run_scan / _copy_mcp_prompt below read pattern_entry.get()
    # directly (the Entry's own text) rather than trusting the StringVar.
    win._tag_pattern_var = pattern_var
    win._tag_pattern_entry = pattern_entry

    status_var = tk.StringVar(value="Ready.")
    status_label = tk.Label(
        win, textvariable=status_var, font=("Segoe UI", 9, "italic"),
        fg=_TEXT_DIM, bg=_BG, justify=tk.LEFT, wraplength=680,
    )
    status_label.pack(padx=16, pady=(0, 6), anchor=tk.W)

    discovery_label = tk.Label(
        win, text="", font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG,
        justify=tk.LEFT, wraplength=680,
    )
    discovery_label.pack(padx=16, pady=(0, 6), anchor=tk.W)

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

    # Scrollbars follow the established pattern in dependency_viewer.py
    # (~lines 1413-1419): parented to tree_frame, vertical packed right/
    # fill-y and horizontal bottom/fill-x BEFORE the tree itself claims the
    # remaining space with fill=both/expand=True.
    vsb_tree = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
    hsb_tree = ttk.Scrollbar(tree_frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vsb_tree.set, xscrollcommand=hsb_tree.set)

    vsb_tree.pack(side="right", fill="y")
    hsb_tree.pack(side="bottom", fill="x")
    tree.pack(fill=tk.BOTH, expand=True)

    summary_label = tk.Label(
        win, text="", font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG, justify=tk.LEFT,
        wraplength=680,
    )
    # Bottom status bar: previously had NO wraplength at all (unlike
    # discovery_label/status_label above, which use a static wraplength=680
    # — see those constructors), so a long line (a full verse_dir path, or
    # the three-way hidden-count summary on a big scan) just ran off the
    # visible window instead of wrapping — read by a user as truncated/
    # clipped text. side=BOTTOM + fill=X (instead of the default top-down
    # anchor=W packing) lets the label's own width track the window's
    # actual client width, and the <Configure> binding below keeps
    # wraplength in sync with that width on every resize — mirroring the
    # static-wraplength idiom used elsewhere in this window/dependency_
    # viewer.py, but driven dynamically since this label sits at a fixed
    # edge rather than a fixed size.
    summary_label.pack(side=tk.BOTTOM, fill=tk.X, padx=16, pady=(4, 8))
    summary_label.bind(
        "<Configure>",
        lambda e: summary_label.config(wraplength=max(e.width - 8, 100)),
    )

    # ------------------------------------------------------------------
    # Run Scan — guarded against double-clicks (see docstring above).
    # ------------------------------------------------------------------
    _scanning = [False]

    def _run_scan():
        if _scanning[0]:
            return

        # Read straight from the Entry widget, not the StringVar — see the
        # comment where pattern_entry is created for why. One read, reused
        # for both the empty-pattern confirmation below and the
        # inspect_tags() call further down.
        pattern = pattern_entry.get().strip()

        # FIELD INCIDENT this guards against: an empty label pattern
        # matches EVERY actor in the level — the exact setting that froze
        # a user's UEFN for 15+ minutes with no way to cancel. Even though
        # tag_inspect.py now caps and bounds that walk (see
        # _inspect_tags_live), an unscoped scan is still by far the most
        # expensive thing this window can trigger, so it is never run
        # silently — an explicit confirm is required first.
        if not pattern:
            proceed = messagebox.askyesno(
                "Scan every actor?",
                "The label pattern is blank, which matches EVERY actor in "
                "the level. This can take a long time on a large level.\n\n"
                "The scan is now bounded and cancellable (a progress "
                "dialog with a Cancel button will appear), but it can "
                "still run for a while and results may be truncated on a "
                "very large project.\n\n"
                "Continue scanning every actor?",
                parent=win,
            )
            if not proceed:
                status_var.set("Scan cancelled before starting — enter a label pattern to scope it.")
                return

        _scanning[0] = True
        run_btn.configure(state=tk.DISABLED, text="Scanning...")
        pattern_entry.configure(state=tk.DISABLED)
        try:
            win.title("Verse Tag Inspector — Scanning…")
        except tk.TclError:
            pass
        status_var.set(
            "Scanning — a cancellable progress dialog will appear over "
            "the editor; use its Cancel button to stop early. This window "
            "will stay disabled until the scan finishes or is cancelled."
        )
        try:
            win.update()
        except tk.TclError:
            pass

        try:
            result = tag_inspect_module.inspect_tags(label_pattern=pattern or None)
            _render_tag_report(tree, discovery_label, summary_label, result, "this scan, just now")
            if result.get("cancelled"):
                status_var.set(
                    "Scan CANCELLED — showing the partial results gathered "
                    "before cancellation, not a complete scan. See the "
                    "notes above for exactly where it stopped."
                )
            elif result.get("truncated"):
                status_var.set(
                    "Scan complete, but truncated by a scan cap — see the "
                    "notes above for what was left out."
                )
            else:
                status_var.set("Scan complete.")
        except Exception as e:
            unreal.log_warning("uefn_launcher: tag_inspect scan failed: " + str(e))
            status_var.set("Scan failed: " + str(e))
        finally:
            _scanning[0] = False
            run_btn.configure(state=tk.NORMAL, text="Run Scan")
            pattern_entry.configure(state=tk.NORMAL)
            try:
                win.title("Verse Tag Inspector")
            except tk.TclError:
                pass

    run_btn = tk.Button(
        controls, text="Run Scan", font=("Segoe UI", 9, "bold"),
        bg=_ACCENT_GREEN, fg="#FFFFFF", activebackground="#256F32",
        activeforeground="#FFFFFF", relief="flat", padx=10, pady=4,
        command=_run_scan,
    )
    run_btn.pack(side=tk.LEFT)

    # ------------------------------------------------------------------
    # Copy MCP prompt — convenience only, per FIX 2: the AI path is no
    # longer required to see results, just an alternative way to get them.
    # ------------------------------------------------------------------
    def _copy_mcp_prompt():
        # Same Entry-not-StringVar read as _run_scan (see comment above).
        pattern = pattern_entry.get().strip()
        pattern_desc = "label_pattern=\"{}\"".format(pattern) if pattern else "no label_pattern (all actors)"
        prompt = (
            "Run the uefn_tag_inspect MCP tool with {}. Show me each "
            "actor's tags and parent chains, flag any actor with no tag "
            "component or zero tags, and include the discovery notes "
            "(the component class and tag-container property it found)."
        ).format(pattern_desc)
        if _copy_text_to_system_clipboard(prompt):
            copy_btn.configure(text="Copied!")
            win.after(1500, lambda: copy_btn.configure(text="Copy MCP prompt"))
        else:
            _show_copy_fallback_dialog(win, prompt, title="Copy MCP prompt")

    copy_btn = tk.Button(
        controls, text="Copy MCP prompt", font=("Segoe UI", 9),
        bg=_SECTION_BG, fg=_TEXT_FG, activebackground=_BG,
        activeforeground=_TEXT_FG, relief="flat", padx=10, pady=4,
        command=_copy_mcp_prompt,
    )
    copy_btn.pack(side=tk.LEFT, padx=(8, 0))

    # ------------------------------------------------------------------
    # Starting view — a previously saved report, if any, shown purely as a
    # convenience; never a hard dependency (see docstring above).
    # ------------------------------------------------------------------
    data, error = _read_tag_inspect_report(tag_inspect_module)
    if error is not None:
        status_var.set(
            "Could not read a previously saved report (" + error + "). "
            "Click Run Scan to scan now."
        )
    elif data is None:
        status_var.set("No previously saved report yet. Click Run Scan to scan now.")
    else:
        _render_tag_report(
            tree, discovery_label, summary_label, data,
            "last saved report — click Run Scan to refresh",
        )
        status_var.set("Showing the last saved report. Click Run Scan to refresh.")

    # ------------------------------------------------------------------
    # Tick pump -- pump tkinter from the Unreal event loop, mirroring
    # _show_mcp_info's tick pump exactly. This window creates its own
    # independent tk.Tk() root (like _show_mcp_info, unlike the other
    # sibling tool windows which each own their pump internally), so
    # without this the Entry/Buttons above would never receive events.
    # ------------------------------------------------------------------
    _tag_tick = [None]

    def _tick(_dt):
        try:
            if win.winfo_exists():
                win.update()
            else:
                if _tag_tick[0]:
                    unreal.unregister_slate_post_tick_callback(_tag_tick[0])
                    _tag_tick[0] = None
        except tk.TclError:
            if _tag_tick[0]:
                unreal.unregister_slate_post_tick_callback(_tag_tick[0])
                _tag_tick[0] = None
        except Exception:
            pass

    def _on_close():
        if _tag_tick[0]:
            unreal.unregister_slate_post_tick_callback(_tag_tick[0])
            _tag_tick[0] = None
        win.destroy()

    win.protocol("WM_DELETE_WINDOW", _on_close)
    _tag_tick[0] = unreal.register_slate_post_tick_callback(_tick)


def _launch_tag_inspect():
    """Dedicated (not the generic _launch_reloaded), mirroring
    _launch_moderation_scan's extra ModuleNotFoundError branch: tag_inspect.py
    can be legitimately absent from an older/partial project sync, and that
    gets its own actionable message instead of the generic error. Unlike
    the moderation scan, tag inspection needs no AI round-trip —
    inspect_tags() runs entirely locally and writes its own report as a side
    effect — so this just imports the module and hands it to the render
    window, which calls inspect_tags() directly on "Run Scan" (see
    _show_tag_inspect_window) rather than depending on a report file having
    been produced by an external MCP client first."""
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
    "material_texture_browser": lambda: _launch_reloaded(
        "material_texture_browser", "show_material_texture_browser", "Material & Texture Browser"
    ),
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
