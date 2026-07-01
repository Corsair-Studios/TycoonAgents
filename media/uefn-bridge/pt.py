"""
pt — Trashbyrd's Power Tools Quick Launcher
============================================
In UEFN's Python console, type:  import pt

Every import reloads ``uefn_launcher`` so freshly synced tool updates
are picked up immediately, then opens the launcher UI.
"""

import sys

try:
    import importlib

    try:
        import unreal
        _warn = unreal.log_warning
    except ImportError:
        _warn = print

    try:
        if 'uefn_launcher' in sys.modules:
            import importlib
            uefn_launcher = importlib.reload(sys.modules['uefn_launcher'])
        else:
            import uefn_launcher  # type: ignore

        uefn_launcher.show_launcher()
    except Exception as e:
        _warn(f"[pt] Failed to launch Trashbyrd's Power Tools: {e}")

except Exception as e:
    print(f"[pt] Unexpected error: {e}")

finally:
    sys.modules.pop('pt', None)
