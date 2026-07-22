"""
init_unreal.py — Auto-runs when UEFN opens the project.

0. Self-syncs this bridge copy from the newest project copy on disk (see
   below) so a stale engine-side copy can't survive.
1. Starts the UEFN bridge (file-based IPC) so the MCP server can connect.
2. Registers "Trashbyrd's Power Tools" and "Device Audit" entries in Tools menu.
"""

# ── 0. Self-sync from the newest project copy (BEFORE any bridge import) ───
# WHY THIS EXISTS: UEFN executes the bridge from an ENGINE-SIDE copy
# (...\FortniteGame\Content\Python\) that does NOT reliably pick up a newer
# copy the extension re-staged into the user's project Content\Python —
# confirmed stale on a real machine even after a full PC reboot. The engine
# dir IS writable by the bridge itself (tools already write logs there), so
# on every load we check whether a newer project copy exists on disk and, if
# so, copy it over ourselves — self-healing with no manual "reinstall" step.
#
# WHY REGISTRY-FREE: this runs at plugin-load time, before UEFN's Asset
# Registry is guaranteed ready, so we can't ask Unreal where the project
# lives (the asset-anchored trick health_scanner/asset_usage use later, once
# the registry is up). Instead we glob the well-known default install
# locations directly.
#
# WHY BEFORE ANY OTHER IMPORT: everything below this block — uefn_bridge,
# menu wiring, uefn_launcher on demand — must load the FRESHLY COPIED code
# in THIS SAME editor session. If sync ran after other bridge modules had
# already imported, Python's sys.modules cache would keep serving the stale
# versions for the rest of the session regardless of what's now on disk.
#
# WHY "NEWEST" WINS: the bridge is project-agnostic — the same engine-side
# copy serves whichever UEFN project happens to be open — so if more than
# one project on this machine carries the bridge, the newest stamp is the
# most recent extension install/update and is what should be running.
try:
    import glob as _sync_glob
    import os as _sync_os
    import re as _sync_re
    import shutil as _sync_shutil

    def _read_stamp(_dir):
        """Parse BRIDGE_VERSION = "X.Y.Z" out of <_dir>/bridge_version.py via
        regex on the raw file text — never imported: an import would poison
        sys.modules with a copy we might be about to overwrite or discard,
        and would require the dir to already be on sys.path. Returns a
        comparable (int, int, int) tuple; any failure (file missing, bad
        format, non-numeric parts) yields (0, 0, 0) — oldest possible, so an
        unparseable candidate never wins over a real stamp.
        """
        try:
            with open(
                _sync_os.path.join(_dir, "bridge_version.py"), "r", encoding="utf-8"
            ) as _f:
                _text = _f.read()
            _m = _sync_re.search(
                r'BRIDGE_VERSION\s*=\s*["\']([0-9]+)\.([0-9]+)\.([0-9]+)["\']',
                _text,
            )
            return tuple(int(_g) for _g in _m.groups()) if _m else (0, 0, 0)
        except Exception:
            return (0, 0, 0)

    _this_dir = _sync_os.path.dirname(_sync_os.path.abspath(__file__))
    _own_stamp = _read_stamp(_this_dir)

    # Candidate project Python dirs: default Documents location, and the
    # OneDrive-redirected variant (OneDrive*, since the folder name varies
    # per tenant, e.g. "OneDrive - Company" or "OneDrive"). A candidate only
    # counts if its project dir (3 levels up from .../Content/Python) holds
    # a *.uefnproject — otherwise we'd copy from any folder that merely
    # happens to be named right — and if it actually ships a stamp file.
    _home = _sync_os.path.expanduser("~")
    _patterns = [
        _sync_os.path.join(
            _home, "Documents", "Fortnite Projects", "*", "Content", "Python"
        ),
        _sync_os.path.join(
            _home, "OneDrive*", "Documents", "Fortnite Projects", "*", "Content", "Python"
        ),
    ]
    _candidates = []
    for _pattern in _patterns:
        for _py_dir in _sync_glob.glob(_pattern):
            try:
                _project_dir = _sync_os.path.dirname(_sync_os.path.dirname(_py_dir))
                if not _sync_glob.glob(
                    _sync_os.path.join(_project_dir, "*.uefnproject")
                ):
                    continue
                if not _sync_os.path.isfile(
                    _sync_os.path.join(_py_dir, "bridge_version.py")
                ):
                    continue
                _candidates.append((_read_stamp(_py_dir), _py_dir))
            except Exception:
                continue

    _sync_msg = "Trashbyrd: bridge self-sync — no project copy found, staying on v{}.{}.{}".format(
        *_own_stamp
    )
    if _candidates:
        _candidates.sort(key=lambda _c: _c[0])
        _newest_stamp, _newest_dir = _candidates[-1]
        if _newest_stamp > _own_stamp:
            _copied, _failed = 0, 0
            for _name in _sync_os.listdir(_newest_dir):
                if _name == "uefn-server.mjs":
                    continue
                if not (_name.endswith(".py") or _name == "trashbyrd_40x40.png"):
                    continue
                try:
                    _src = _sync_os.path.join(_newest_dir, _name)
                    if _sync_os.path.isfile(_src):
                        _sync_shutil.copyfile(_src, _sync_os.path.join(_this_dir, _name))
                        _copied += 1
                except Exception:
                    _failed += 1
            _sync_msg = (
                "Trashbyrd: bridge self-sync — updated v{}.{}.{} -> v{}.{}.{} "
                "({} copied, {} failed) from {}"
            ).format(*(_own_stamp + _newest_stamp + (_copied, _failed, _newest_dir)))
        else:
            _sync_msg = (
                "Trashbyrd: bridge self-sync — v{}.{}.{} already current "
                "(newest project copy v{}.{}.{})"
            ).format(*(_own_stamp + _newest_stamp))

    print(_sync_msg)
    try:
        import unreal as _sync_unreal
        _sync_unreal.log(_sync_msg)
    except Exception:
        pass
except Exception as _sync_exc:
    try:
        print(f"Trashbyrd: bridge self-sync failed, startup continues unaffected — {_sync_exc}")
    except Exception:
        pass
    try:
        import unreal as _sync_unreal_fail
        _sync_unreal_fail.log_warning(
            f"Trashbyrd: bridge self-sync failed, startup continues unaffected — {_sync_exc}"
        )
    except Exception:
        pass

import unreal

# ── 1. Auto-start the UEFN bridge ──────────────────────────────────
# CRITICAL: This block is fully isolated.  Menu registration (section 2)
# and the deferred prompt (section 3) run AFTER this block — any failure
# in those sections cannot affect bridge startup.
try:
    import importlib
    import importlib.util
    import os as _os

    _bridge_path = _os.path.join(
        _os.path.dirname(_os.path.abspath(__file__)), "uefn_bridge.py"
    )
    _spec = importlib.util.spec_from_file_location("uefn_bridge", _bridge_path)
    uefn_bridge = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(uefn_bridge)

    # Register in sys.modules so other tools can `import uefn_bridge`
    import sys as _sys
    _sys.modules["uefn_bridge"] = uefn_bridge
    del _os, _spec, _sys

    # Explicitly call start_bridge() to guarantee the tick callback is
    # registered even on reload scenarios where auto-start at module
    # bottom may have already fired with a stale handle.
    try:
        uefn_bridge.start_bridge()
    except Exception as _sb_exc:
        unreal.log_warning(
            f"Trashbyrd: start_bridge() raised — {_sb_exc}"
        )

    unreal.log("Trashbyrd: bridge started")
except Exception as exc:
    unreal.log_warning(
        f"Trashbyrd: Failed to start UEFN bridge — {exc}"
    )

# Always-visible hint — appears in Output Log regardless of menus or prompts
unreal.log(
    "Trashbyrd's Power Tools ready — type  import pt  in the Python console to open the launcher"
)

# ── 2. Register menu entries (best-effort, works in stock Unreal Editor) ───
# UEFN does not support adding Tools menu items via the Python ToolMenus API;
# the code below is silently a no-op in UEFN. A fallback auto-shows the
# launcher once at startup when menu registration is unavailable or the Tools
# menu cannot be found (see section 3 below).
_menu_registered = False
try:
    menus = unreal.ToolMenus.get()
    tools_menu = menus.find_menu("LevelEditor.MainMenu.Tools")

    if tools_menu:
        # --- Trashbyrd's Power Tools ---
        launcher_entry = unreal.ToolMenuEntry(
            name="TrashbyrdsPowerTools",
            type=unreal.MultiBlockType.MENU_ENTRY,
        )
        launcher_entry.set_label("Trashbyrd's Power Tools")
        launcher_entry.set_tool_tip(
            "Open Trashbyrd's Power Tools hub"
        )
        launcher_entry.set_string_command(
            type=unreal.ToolMenuStringCommandType.PYTHON,
            custom_type="",
            string=(
                "import importlib; import uefn_launcher; "
                "importlib.reload(uefn_launcher); uefn_launcher.show_launcher()"
            ),
        )
        tools_menu.add_menu_entry("PythonTools", launcher_entry)

        # --- Device Audit (quick access) ---
        audit_entry = unreal.ToolMenuEntry(
            name="DeviceAudit",
            type=unreal.MultiBlockType.MENU_ENTRY,
        )
        audit_entry.set_label("Device Audit")
        audit_entry.set_tool_tip(
            "Scan all actors and report device status, changed properties"
        )
        audit_entry.set_string_command(
            type=unreal.ToolMenuStringCommandType.PYTHON,
            custom_type="",
            string=(
                "import importlib; import device_audit; "
                "importlib.reload(device_audit); device_audit.run_audit()"
            ),
        )
        tools_menu.add_menu_entry("PythonTools", audit_entry)

        menus.refresh_all_widgets()
        unreal.log("Trashbyrd: Launcher and Device Audit added to Tools menu")
        _menu_registered = True
    else:
        unreal.log_warning(
            "Trashbyrd: Could not find Tools menu — "
            "menu entries not registered (expected in UEFN)"
        )
except Exception as exc:
    unreal.log_warning(
        f"Trashbyrd: Menu registration failed — {exc}"
    )

# ── 3. Deferred opt-in prompt ~5 s after editor load ────────────────────────
# Always scheduled — the Tools menu is not extensible in UEFN so the menu
# entries registered above (if any) are effectively a no-op there. Rather than
# building the Tkinter window at startup (which stresses the system), we wait
# ~5 seconds for the editor to finish loading and then show a YES/NO dialog.
# The user can opt in to open the launcher. Everything is guarded so neither
# the dialog nor the launcher can break bridge startup.
if True:  # always run regardless of _menu_registered (menu is no-op in UEFN)
    import time as _time

    _prompt_start = _time.monotonic()
    _prompt_fired = False
    _prompt_tick_handle = None

    def _prompt_tick(_delta_time):
        global _prompt_fired, _prompt_tick_handle
        if _prompt_fired:
            return
        try:
            if _time.monotonic() - _prompt_start < 5.0:
                return
        except Exception:
            return

        # Unregister ourselves immediately (one-shot)
        _prompt_fired = True
        try:
            unreal.unregister_slate_post_tick_callback(_prompt_tick_handle)
        except Exception:
            pass

        # Show the opt-in dialog
        # Priority 1: Tkinter yes/no dialog (proven to work in UEFN)
        _wants_launcher = False
        _dialog_shown = False
        try:
            import tkinter as _tk
            from tkinter import messagebox as _msgbox
            _dlg_root = _tk.Tk()
            _dlg_root.withdraw()
            _dlg_root.attributes("-topmost", True)
            _wants_launcher = _msgbox.askyesno(
                "Trashbyrd's Power Tools",
                "Launch Trashbyrd's Power Tools?",
                parent=_dlg_root,
            )
            _dlg_root.destroy()
            _dialog_shown = True
        except Exception as _tke:
            unreal.log(
                f"Trashbyrd: Tkinter dialog unavailable ({_tke}), trying EditorDialog"
            )

        if _dialog_shown:
            if _wants_launcher:
                try:
                    import importlib as _importlib
                    import uefn_launcher as _uefn_launcher
                    _importlib.reload(_uefn_launcher)
                    _uefn_launcher.show_launcher()
                    unreal.log("Trashbyrd: Launcher opened by user request")
                except Exception as _le:
                    unreal.log_warning(
                        f"Trashbyrd: Could not open launcher — {_le}"
                    )
        else:
            # Priority 2: EditorDialog fallback (works in stock Unreal Editor)
            try:
                result = unreal.EditorDialog.show_message(
                    "Trashbyrd's Power Tools",
                    "Launch Trashbyrd's Power Tools?",
                    unreal.AppMsgType.YES_NO,
                    unreal.AppReturnType.NO,
                )
                if result == unreal.AppReturnType.YES:
                    try:
                        import importlib as _importlib
                        import uefn_launcher as _uefn_launcher
                        _importlib.reload(_uefn_launcher)
                        _uefn_launcher.show_launcher()
                        unreal.log("Trashbyrd: Launcher opened by user request")
                    except Exception as _le:
                        unreal.log_warning(
                            f"Trashbyrd: Could not open launcher — {_le}"
                        )
            except Exception:
                # Priority 3: last resort — log instructions
                unreal.log(
                    "Trashbyrd's Power Tools ready — type  import pt  in the Python console to open the launcher"
                )

    try:
        _prompt_tick_handle = unreal.register_slate_post_tick_callback(_prompt_tick)
        unreal.log("Trashbyrd: Startup prompt scheduled (fires ~5 s after load)")
    except Exception as _exc:
        unreal.log_warning(
            f"Trashbyrd: Could not schedule startup prompt — {_exc}"
        )
