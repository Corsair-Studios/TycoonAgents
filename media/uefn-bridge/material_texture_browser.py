"""
UEFN Material & Texture Browser
================================
Consolidated launcher window for the Material Browser and Texture Explorer
tools. Both are views onto the SAME relationship graph — materials list the
textures they depend on, textures list the materials/MICs/Niagara systems
that reference them — so instead of two separate windows this hosts both
views as tabs in one ``ttk.Notebook``, sharing one tick-pump, one close
handler, and one status bar.

Runs inside UEFN's embedded Python 3.11 (requires the ``unreal`` module).

This module owns NO scanning/browsing logic of its own — it composes the
embeddable halves already extracted for exactly this purpose:
    material_browser.build_material_view(parent, status_callback=None)
    texture_finder.build_texture_view(parent, status_callback=None)
Neither creates a window, calls ``mainloop()``, or registers a tick
callback; this module is the "future host window" both of their docstrings
already describe.

Tab construction is LAZY: each tab's view (and the Asset Registry scan it
triggers) is built only the first time that tab is selected, not both up
front, since either scan can be slow on a large project. The initially
visible tab (Materials) is built immediately on open.

Usage:
    from material_texture_browser import show_material_texture_browser
    show_material_texture_browser()
"""

import os
import unreal

try:
    import tkinter as tk
    from tkinter import ttk, messagebox
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Theme constants (matching launcher / material_browser / texture_finder palette)
# ---------------------------------------------------------------------------

_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"

# UI state for the tick pump — module-level like material_browser.py /
# texture_finder.py's own _tick_handle, so a stray leftover from a previous
# open can't be confused with this window's handle.
_tick_handle = [None]


# ---------------------------------------------------------------------------
# Tab keys — used consistently for the notebook index <-> handle/status maps
# below. "materials" is index 0 (the tab visible on open), "textures" is 1.
# ---------------------------------------------------------------------------

_TAB_KEYS = ("materials", "textures")


def show_material_texture_browser():
    """
    Open the combined Material & Texture Browser window.

    Composes material_browser.build_material_view() and
    texture_finder.build_texture_view() as two tabs of a single
    ttk.Notebook, mirroring the window lifecycle every sibling Power Tools
    window uses (own Toplevel/Tk root, one Slate tick-pump, one
    WM_DELETE_WINDOW handler — never mainloop()).

    - Each tab is built (and its scan triggered) only the first time it is
      selected — see the module docstring. Re-selecting an already-built
      tab does not rescan or rebuild it.
    - A single status bar at the bottom shows whichever tab is currently
      active's status text, fed via that view's ``status_callback`` — the
      text itself is never reworded, only relayed.
    - A single Refresh button re-runs the ACTIVE tab's ``.refresh()``; it
      never touches a tab that has not been built yet.
    """
    if not _HAS_TKINTER:
        unreal.log_error("material_texture_browser: tkinter is not available in this environment.")
        return

    # ------------------------------------------------------------------
    # Defensive import of the two sibling view modules — reloaded fresh so
    # in-editor edits to either one are picked up on the next launch
    # without restarting UEFN, mirroring uefn_launcher._launch_reloaded.
    # ModuleNotFoundError gets its own actionable message (mirroring
    # uefn_launcher._launch_moderation_scan's ModuleNotFoundError branch)
    # since either sibling can be legitimately absent from an
    # older/partial project sync.
    # ------------------------------------------------------------------
    try:
        import importlib
        import material_browser
        import texture_finder
        importlib.reload(material_browser)
        importlib.reload(texture_finder)
    except ModuleNotFoundError as e:
        msg = (
            "material_browser.py and/or texture_finder.py is missing from "
            "your project's Content/Python/ folder.\n\n"
            "Re-run the /uefn-bridge install to sync all tool files."
        )
        unreal.log_warning(f"material_texture_browser: {e} — {msg}")
        messagebox.showerror("Missing Module", msg)
        return
    except Exception as e:
        unreal.log_warning(f"material_texture_browser: Failed to import view modules — {e}")
        messagebox.showerror(
            "Error", "Failed to launch Material & Texture Browser:\n" + str(e)
        )
        return

    # ------------------------------------------------------------------
    # Root window — same construction as show_material_browser() /
    # show_texture_finder(): reuse the existing default Tk root as a
    # Toplevel when one exists (so multiple Power Tools windows can be
    # open at once), otherwise create a fresh Tk root.
    # ------------------------------------------------------------------
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Material & Texture Browser")
    root.configure(bg=_BG)
    root.geometry("1200x700")
    root.minsize(800, 400)

    # Logo/icon — loaded the same defensive way as the sibling windows
    # (missing file/PhotoImage failure is silently skipped, never fatal).
    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path = os.path.join(_script_dir, "trashbyrd_40x40.png")
        if os.path.isfile(_logo_path):
            _logo_img = tk.PhotoImage(file=_logo_path, master=root)
            root.iconphoto(False, _logo_img)
    except Exception:
        pass

    # ------------------------------------------------------------------
    # Style — same "clam" theme base the sibling windows configure; the
    # per-widget style names below live entirely inside
    # build_material_view()/build_texture_view() (each configures its own
    # ttk.Style on the resolved root), so nothing more is needed here
    # beyond the Notebook's own style.
    # ------------------------------------------------------------------
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass
    style.configure("MTB.TFrame", background=_BG)
    style.configure("MTB.TNotebook", background=_BG, borderwidth=0)
    style.configure(
        "MTB.TNotebook.Tab",
        background=_SECTION_BG,
        foreground=_TEXT_FG,
        font=("Segoe UI", 10, "bold"),
        padding=(14, 6),
    )
    style.map(
        "MTB.TNotebook.Tab",
        background=[("selected", _ACCENT_BLUE)],
        foreground=[("selected", "#FFFFFF")],
    )
    style.configure(
        "MTB.Status.TLabel",
        background=_SECTION_BG,
        foreground=_TEXT_DIM,
        font=("Segoe UI", 9),
        padding=(8, 4),
    )
    style.configure(
        "MTB.Refresh.TButton",
        background=_ACCENT_BLUE,
        foreground="#1A1A1A",
        font=("Segoe UI", 9, "bold"),
        padding=(10, 4),
        relief="flat",
    )
    style.map("MTB.Refresh.TButton", background=[("active", "#D24E1F")])

    # ------------------------------------------------------------------
    # Top bar: title + a single Refresh affordance for the active tab
    # ------------------------------------------------------------------
    top_bar = ttk.Frame(root, padding=(12, 8), style="MTB.TFrame")
    top_bar.pack(fill="x", side="top")

    tk.Label(
        top_bar, text="Material & Texture Browser",
        font=("Segoe UI", 13, "bold"), fg=_HEADER_FG, bg=_BG,
    ).pack(side="left")

    refresh_btn = ttk.Button(top_bar, text="Refresh", style="MTB.Refresh.TButton")
    refresh_btn.pack(side="right")

    # ------------------------------------------------------------------
    # Notebook — two static tab Frames added up front; each tab's actual
    # content (and Asset Registry scan) is built LAZILY the first time
    # that tab is selected, not here.
    # ------------------------------------------------------------------
    notebook = ttk.Notebook(root, style="MTB.TNotebook")
    notebook.pack(fill="both", expand=True, padx=10, pady=(0, 4))

    materials_frame = ttk.Frame(notebook)
    textures_frame = ttk.Frame(notebook)
    notebook.add(materials_frame, text="Materials")
    notebook.add(textures_frame, text="Textures")

    _tab_frames = {"materials": materials_frame, "textures": textures_frame}
    _tab_handles = {"materials": None, "textures": None}
    _tab_status_text = {"materials": "", "textures": ""}
    _active_tab = ["materials"]  # mutable cell — the initially visible tab

    # ------------------------------------------------------------------
    # Shared status bar — the ONE place either view's status text is
    # rendered. Each tab's view is built with status_callback set to a
    # per-tab closure below, so it never packs its own status bar (see
    # build_material_view / build_texture_view docstrings), avoiding
    # competing status lines.
    # ------------------------------------------------------------------
    status_var = tk.StringVar(value="Loading materials...")
    status_bar = ttk.Label(root, textvariable=status_var, style="MTB.Status.TLabel", anchor="w")
    status_bar.pack(fill="x", side="bottom")

    def _make_status_callback(tab_key):
        def _cb(text):
            _tab_status_text[tab_key] = text
            if _active_tab[0] == tab_key:
                status_var.set(text)
        return _cb

    def _build_tab(tab_key):
        """Build (once) and return the handle for *tab_key*'s view. A
        second call for an already-built tab is a no-op that just returns
        the existing handle — this is what makes tab construction lazy:
        selecting a tab for the first time triggers its scan, reselecting
        it later does not repeat the build or the scan."""
        existing = _tab_handles[tab_key]
        if existing is not None:
            return existing
        status_callback = _make_status_callback(tab_key)
        if tab_key == "materials":
            handle = material_browser.build_material_view(
                _tab_frames[tab_key], status_callback=status_callback
            )
        else:
            handle = texture_finder.build_texture_view(
                _tab_frames[tab_key], status_callback=status_callback
            )
        _tab_handles[tab_key] = handle
        # Auto-load on first build, mirroring both standalone windows'
        # auto-refresh-on-open behavior (show_material_browser /
        # show_texture_finder both call handle.refresh() immediately).
        handle.refresh()
        return handle

    def _on_tab_changed(_event):
        try:
            idx = notebook.index(notebook.select())
        except Exception:
            return
        tab_key = _TAB_KEYS[idx] if 0 <= idx < len(_TAB_KEYS) else _TAB_KEYS[0]
        _active_tab[0] = tab_key
        _build_tab(tab_key)
        status_var.set(_tab_status_text[tab_key])

    notebook.bind("<<NotebookTabChanged>>", _on_tab_changed)

    def _on_refresh():
        """Refresh the ACTIVE tab only. A tab that has not been built yet
        has no handle to refresh — selecting it (via _on_tab_changed)
        already builds and auto-loads it, so there is nothing to do."""
        handle = _tab_handles[_active_tab[0]]
        if handle is not None:
            handle.refresh()

    refresh_btn.configure(command=_on_refresh)

    # ------------------------------------------------------------------
    # Build the initially-visible tab (Materials) immediately — the
    # <<NotebookTabChanged>> event does not fire for the tab that is
    # already selected when the notebook is first created, so this is
    # the only place the first tab's lazy build is triggered from.
    # ------------------------------------------------------------------
    _build_tab("materials")
    status_var.set(_tab_status_text["materials"])

    # ------------------------------------------------------------------
    # ONE tick pump, ONE close handler for the whole window — sibling
    # tools each own their own pump only because each is a fully separate
    # window; here the two tabs share this single window's pump/handler,
    # exactly per the consolidation goal (never register two pumps, never
    # leak one on close).
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
    _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)

    root.update()  # force initial render with the Materials tab's stats populated

    unreal.log(
        "material_texture_browser: UI opened. Use show_material_texture_browser() "
        "to reopen if closed."
    )
