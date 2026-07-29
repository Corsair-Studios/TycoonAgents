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
    """
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
        ("Claude Code", "Anthropic", "Auto-configured (.mcp.json)"),
        ("OpenAI Codex CLI", "OpenAI", "MCP via stdio (manual config)"),
        ("Gemini CLI", "Google", "MCP via stdio (manual config)"),
        ("Cursor IDE", "Cursor", "Built-in MCP (manual config)"),
        ("Windsurf", "Codeium", "MCP via config (manual)"),
        ("VS Code Copilot", "GitHub/Microsoft", "MCP via extension (manual)"),
    ]

    ai_list_frame = tk.Frame(ai_frame, bg=_SECTION_BG, padx=4, pady=4)
    ai_list_frame.pack(fill=tk.X, pady=(4, 0))

    ai_tree = ttk.Treeview(
        ai_list_frame, columns=("client", "provider", "notes"), show="headings",
        style="MCP.Treeview", height=min(len(clients), 6),
    )
    ai_tree.heading("client", text="Client")
    ai_tree.heading("provider", text="Provider")
    ai_tree.heading("notes", text="Integration")
    ai_tree.column("client", width=160)
    ai_tree.column("provider", width=140)
    ai_tree.column("notes", width=260)

    for client, provider, notes in clients:
        ai_tree.insert("", tk.END, values=(client, provider, notes))

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

def _launch_tool(action):
    """Launch the tool identified by *action*."""
    if action == "device_audit":
        try:
            import importlib
            import device_audit
            importlib.reload(device_audit)
            device_audit.run_audit()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch device_audit: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Device Audit:\n" + str(e))

    elif action == "material_browser":
        try:
            import importlib
            import material_browser
            importlib.reload(material_browser)
            material_browser.show_material_browser()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch material_browser: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Material Browser:\n" + str(e))

    elif action == "texture_finder":
        try:
            import importlib
            import texture_finder
            importlib.reload(texture_finder)
            texture_finder.show_texture_finder()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch texture_finder: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Texture Finder:\n" + str(e))

    elif action == "niagara_inspector":
        try:
            import importlib
            import niagara_inspector
            importlib.reload(niagara_inspector)
            niagara_inspector.show_niagara_inspector()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch niagara_inspector: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Niagara Inspector:\n" + str(e))

    elif action == "dependency_viewer":
        try:
            import importlib
            import dependency_viewer
            importlib.reload(dependency_viewer)
            dependency_viewer.show_dependency_viewer()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch dependency_viewer: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Dependency Viewer:\n" + str(e))

    elif action == "health_scanner":
        try:
            import importlib
            import health_scanner
            importlib.reload(health_scanner)
            health_scanner.show_health_scanner()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch health_scanner: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Project Health:\n" + str(e))

    elif action == "moderation_scan":
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

    elif action == "level_stats":
        try:
            import importlib
            import level_stats
            importlib.reload(level_stats)
            level_stats.show_level_stats()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch level_stats: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Level Stats:\n" + str(e))

    elif action == "mcp_info":
        _show_mcp_info()

    elif action == "asset_sweep":
        try:
            import importlib
            import asset_sweep
            importlib.reload(asset_sweep)
            asset_sweep.show_asset_sweep()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch asset_sweep: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Dead Asset Sweep:\n" + str(e))

    elif action == "property_inspector":
        try:
            import importlib
            import property_inspector
            importlib.reload(property_inspector)
            property_inspector.show_ui()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch property_inspector: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Property Inspector:\n" + str(e))

    elif action == "build_mode_cleanup":
        try:
            import importlib
            import build_mode_cleanup
            importlib.reload(build_mode_cleanup)
            build_mode_cleanup.show_ui()
        except Exception as e:
            unreal.log_warning("uefn_launcher: Failed to launch build_mode_cleanup: " + str(e))
            if _HAS_TKINTER:
                messagebox.showerror("Error", "Failed to launch Build-Mode Cleanup:\n" + str(e))

    else:
        unreal.log_warning("uefn_launcher: Unknown action: " + str(action))


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
