"""
init_unreal.py — Auto-runs when UEFN opens the project.

1. Starts the UEFN bridge (file-based IPC) so the MCP server can connect.
2. Registers "Trashbyrd's Power Tools" and "Device Audit" entries in Tools menu.
"""

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
