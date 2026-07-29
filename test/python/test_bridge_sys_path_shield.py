"""Tests for uefn_bridge.py's sys.path self-consistency shield.

See the try/except block near the top of media/uefn-bridge/uefn_bridge.py
(right before the device_audit import) — before any sibling import runs
(device_audit, batch_tools, texture_finder, ...), the module inserts its
OWN directory at sys.path[0]. This kills the engine-copy-shadowing class of
bug: a stale bridge file paired with a newer/older sibling module resolving
from a DIFFERENT, earlier sys.path entry (e.g. an engine-side
FortniteGame\\Content\\Python copy shadowing a project copy, or the
reverse) is exactly what took the whole bridge down in the field (see
test_device_audit_version_skew.py's docstring for the ImportError that
prompted the getattr()-based device_audit resolution this shield
complements).

These tests exercise the REAL shield code by importing a BRAND NEW
uefn_bridge module (sys.modules popped first) with a decoy directory
planted ahead of the real bridge dir on sys.path, and checking the
resulting sys.path state captured immediately after import completes.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import BRIDGE_DIR, ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
stub_unreal()

# Every module the shield must protect the resolution of -- popped from
# sys.modules before each fresh import so `import uefn_bridge` (and its
# sibling imports) actually re-execute against the current sys.path rather
# than reusing an already-cached module object from an earlier test file in
# the same `unittest discover` process.
_SIBLING_MODULE_NAMES = (
    "uefn_bridge",
    "device_audit",
    "batch_tools",
    "texture_finder",
    "material_browser",
    "niagara_inspector",
    "dependency_viewer",
    "health_scanner",
    "moderation_scanner",
)


def _norm(p):
    return os.path.normcase(os.path.normpath(p))


def _fresh_import_with_decoy_path_entry():
    """Plant a fresh temp "decoy" directory at sys.path[0] (standing in for
    a differently-versioned engine/project copy resolving first), pop every
    sibling module so the import actually re-executes, import a BRAND NEW
    uefn_bridge, and return (module, decoy_dir, sys.path snapshot taken
    immediately after import). sys.path and sys.modules are restored to
    their pre-call state in `finally` -- the snapshot is captured INSIDE
    the try block, before restoration, so the caller can inspect exactly
    what the shield left behind without leaking that state into later
    tests."""
    decoy_dir = tempfile.mkdtemp(prefix="uefn_bridge_shield_decoy_")
    saved_modules = {name: sys.modules.pop(name, None) for name in _SIBLING_MODULE_NAMES}
    saved_path = list(sys.path)
    try:
        sys.path.insert(0, decoy_dir)
        import uefn_bridge  # noqa: E402  (fresh exec, shield runs for real)
        path_after_import = list(sys.path)
        return uefn_bridge, decoy_dir, path_after_import
    finally:
        sys.path[:] = saved_path
        for name, mod in saved_modules.items():
            sys.modules.pop(name, None)
            if mod is not None:
                sys.modules[name] = mod


class SysPathShieldTests(unittest.TestCase):
    def test_shield_pulls_the_bridges_own_dir_to_index_0_ahead_of_a_decoy(self):
        _bridge, decoy_dir, path_after = _fresh_import_with_decoy_path_entry()
        try:
            self.assertEqual(
                _norm(path_after[0]), _norm(BRIDGE_DIR),
                "the bridge's own directory must win index 0 even though a "
                "decoy dir was prepended before import",
            )
            self.assertNotEqual(_norm(path_after[0]), _norm(decoy_dir))
        finally:
            os.rmdir(decoy_dir)

    def test_shield_never_leaves_a_duplicate_sys_path_entry(self):
        _bridge, decoy_dir, path_after = _fresh_import_with_decoy_path_entry()
        try:
            occurrences = sum(1 for p in path_after if _norm(p) == _norm(BRIDGE_DIR))
            self.assertEqual(
                occurrences, 1,
                f"expected exactly one BRIDGE_DIR entry on sys.path, found {occurrences}: {path_after}",
            )
        finally:
            os.rmdir(decoy_dir)

    def test_shield_is_idempotent_across_repeated_fresh_imports(self):
        """Re-running the shield (simulating the module's own documented
        `importlib.reload(uefn_bridge)` re-entry point, or simply being
        imported fresh again in a later test) must never accumulate
        duplicate sys.path entries or lose the bridge's own dir from
        index 0."""
        _bridge1, decoy1, path1 = _fresh_import_with_decoy_path_entry()
        _bridge2, decoy2, path2 = _fresh_import_with_decoy_path_entry()
        try:
            self.assertEqual(_norm(path1[0]), _norm(BRIDGE_DIR))
            self.assertEqual(_norm(path2[0]), _norm(BRIDGE_DIR))
            self.assertEqual(sum(1 for p in path2 if _norm(p) == _norm(BRIDGE_DIR)), 1)
        finally:
            os.rmdir(decoy1)
            os.rmdir(decoy2)

    def test_device_audit_still_resolves_from_the_bridges_own_dir_not_the_decoy(self):
        """End-to-end: the shield's actual purpose is that sibling imports
        below it resolve from the same directory as uefn_bridge.py itself.
        Confirm device_audit's __file__ lives under BRIDGE_DIR, never the
        decoy (which holds no python files at all -- if resolution somehow
        preferred it, this would raise ImportError instead)."""
        bridge, decoy_dir, _path_after = _fresh_import_with_decoy_path_entry()
        try:
            self.assertTrue(
                _norm(bridge.device_audit.__file__).startswith(_norm(BRIDGE_DIR)),
                f"device_audit resolved from {bridge.device_audit.__file__!r}, expected under {BRIDGE_DIR!r}",
            )
        finally:
            os.rmdir(decoy_dir)


if __name__ == "__main__":
    unittest.main()
