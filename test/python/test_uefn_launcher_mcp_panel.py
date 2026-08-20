"""Drift-guard tests for uefn_launcher._mcp_command_entries()
(media/uefn-bridge/uefn_launcher.py, roughly lines 245-320: the
``_MCP_METHOD_DESCRIPTIONS`` blurb map and the ``_mcp_command_entries()``
function it feeds).

Context: the MCP Bridge Commands info window used to be a hand-maintained
list of tool names that silently drifted out of sync with the real dispatch
table in ``uefn_bridge._METHODS`` every time a tool was added (most recently
the three new level-editing tools: spawn_actor, duplicate_actor,
set_transform). The fix makes ``_METHODS`` the single enumeration source —
``_mcp_command_entries()`` derives ``("uefn_" + key, blurb)`` pairs from it
in insertion order, falling back to ``"(no description)"`` for any key with
no matching entry in ``_MCP_METHOD_DESCRIPTIONS``, then appends one
deliberate non-derived tail entry, ``uefn_verse_check`` (served by the MCP
server directly, never routed through ``_METHODS``).

The whole point of this suite is to guard against the SAME staleness bug
recurring in a different shape: a future method added to ``_METHODS`` with
no matching ``_MCP_METHOD_DESCRIPTIONS`` entry, or a description key that
outlives a renamed/removed method. So the assertions here deliberately
avoid hardcoding a method count or a snapshot list — they assert the
DERIVATION relationship itself (every _METHODS key appears in the output,
every description key exists in _METHODS) so the test itself cannot go
stale the way the old hand-maintained list did.

Both ``uefn_bridge`` (unguarded ``import unreal``) and ``uefn_launcher``
(module-scope ``import unreal``, guarded ``import tkinter``) are imported
here, so ``unreal`` is stubbed via ``_bridge_helpers.stub_unreal()`` before
either import, mirroring test_uefn_bridge_level_edit.py and
test_bridge_sys_path_shield.py. No tkinter window is ever constructed —
``tk.Tk()`` only appears inside ``_show_mcp_info``/``show_launcher``
(uefn_launcher.py lines ~329, ~630), which this suite never calls, so the
module imports and these tests run headless whether or not tkinter is
present in the interpreter running them (``uefn_launcher._HAS_TKINTER``
guards the import itself).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, import_uefn_bridge, stub_unreal  # noqa: E402

ensure_bridge_on_path()
stub_unreal()
import_uefn_bridge()

import uefn_bridge  # noqa: E402
import uefn_launcher  # noqa: E402


class McpCommandEntriesDriftGuardTests(unittest.TestCase):
    """Covers _mcp_command_entries()'s derivation from uefn_bridge._METHODS."""

    def setUp(self):
        # Snapshot everything a test method might mutate so failures/
        # successes never leak state into a later test file in the same
        # `unittest discover` process.
        self._methods_snapshot = dict(uefn_bridge._METHODS)
        self._descriptions_snapshot = dict(uefn_launcher._MCP_METHOD_DESCRIPTIONS)
        self._sys_modules_snapshot = dict(sys.modules)
        self._meta_path_snapshot = list(sys.meta_path)

    def tearDown(self):
        uefn_bridge._METHODS.clear()
        uefn_bridge._METHODS.update(self._methods_snapshot)

        uefn_launcher._MCP_METHOD_DESCRIPTIONS.clear()
        uefn_launcher._MCP_METHOD_DESCRIPTIONS.update(self._descriptions_snapshot)

        sys.meta_path[:] = self._meta_path_snapshot

        for name in list(sys.modules):
            if name not in self._sys_modules_snapshot:
                del sys.modules[name]
        sys.modules.update(self._sys_modules_snapshot)

    # -- 1. entry count -----------------------------------------------

    def test_entry_count_is_methods_plus_one_verse_check_tail(self):
        entries = uefn_launcher._mcp_command_entries()
        self.assertEqual(len(entries), len(uefn_bridge._METHODS) + 1)
        self.assertEqual(entries[-1][0], "uefn_verse_check")

    # -- 2. drift guard: every dispatch key is derived -----------------

    def test_every_methods_key_is_derived_into_entries(self):
        entries = uefn_launcher._mcp_command_entries()
        names = [name for name, _ in entries]
        for key in uefn_bridge._METHODS:
            self.assertIn(
                "uefn_" + key,
                names,
                f"_METHODS key {key!r} did not surface as a tool entry — "
                "the panel would silently omit a real MCP tool",
            )

    # -- 3. reverse drift guard: no stale description keys -------------

    def test_no_stale_or_renamed_description_keys(self):
        for key in uefn_launcher._MCP_METHOD_DESCRIPTIONS:
            self.assertIn(
                key,
                uefn_bridge._METHODS,
                f"_MCP_METHOD_DESCRIPTIONS has a stale/renamed key {key!r} "
                "with no matching uefn_bridge._METHODS entry",
            )

    # -- 4. the three new level-edit tools are real entries ------------

    def test_new_level_edit_tools_have_real_blurbs(self):
        entries = dict(uefn_launcher._mcp_command_entries())
        for tool in ("uefn_spawn_actor", "uefn_duplicate_actor", "uefn_set_transform"):
            self.assertIn(tool, entries)
            self.assertNotEqual(entries[tool], "(no description)")
            self.assertTrue(entries[tool].strip())

    # -- 5. insertion order matches _METHODS ---------------------------

    def test_insertion_order_matches_methods_order(self):
        entries = uefn_launcher._mcp_command_entries()
        derived_names = [name for name, _ in entries[:-1]]  # exclude verse_check tail
        expected = ["uefn_" + key for key in uefn_bridge._METHODS]
        self.assertEqual(derived_names, expected)

    # -- 6. unmapped method still appears, with the placeholder --------

    def test_unmapped_method_gets_placeholder_and_still_lists(self):
        fake_key = "__drift_guard_fake_method__"
        self.assertNotIn(fake_key, uefn_bridge._METHODS)
        self.assertNotIn(fake_key, uefn_launcher._MCP_METHOD_DESCRIPTIONS)

        uefn_bridge._METHODS[fake_key] = lambda *args, **kwargs: None

        entries = dict(uefn_launcher._mcp_command_entries())
        self.assertIn("uefn_" + fake_key, entries)
        self.assertEqual(entries["uefn_" + fake_key], "(no description)")

    # -- 7. no real method renders the "(no description)" placeholder --

    def test_no_real_method_falls_back_to_no_description_placeholder(self):
        # Guards against the exact bug this suite was written to catch: a
        # method landing in _METHODS (uefn_bridge's live dispatch table)
        # with no matching blurb in _MCP_METHOD_DESCRIPTIONS, so the panel
        # silently renders "(no description)" for a real, working tool
        # (most recently list_commands and batch_location). Deliberately
        # excludes the uefn_verse_check tail entry, which is documented as
        # the one non-derived entry and always ships its own real blurb —
        # asserted separately below rather than folded into this loop.
        entries = uefn_launcher._mcp_command_entries()
        undescribed = [name for name, desc in entries if desc == "(no description)"]
        self.assertEqual(
            undescribed,
            [],
            f"method(s) rendering the placeholder in the MCP Bridge Commands "
            f"window: {undescribed} — add a real entry to "
            f"_MCP_METHOD_DESCRIPTIONS for each",
        )

    def test_verse_check_tail_entry_has_its_own_real_description(self):
        entries = dict(uefn_launcher._mcp_command_entries())
        self.assertNotEqual(entries["uefn_verse_check"], "(no description)")
        self.assertTrue(entries["uefn_verse_check"].strip())

    # -- 8. failed uefn_bridge import raises, never returns a fallback -

    def test_raises_when_uefn_bridge_import_fails(self):
        del sys.modules["uefn_bridge"]

        class _BlockUefnBridgeImport:
            """Meta-path finder that fails the import of uefn_bridge only,
            simulating a missing/broken bridge module. Exceptions raised
            from find_spec propagate straight out of the `import`
            statement uncaught by the import system, so this is enough to
            make `import uefn_bridge` inside _mcp_command_entries() raise."""

            def find_spec(self, name, path, target=None):
                if name == "uefn_bridge":
                    raise ImportError("blocked for drift-guard test")
                return None

        sys.meta_path.insert(0, _BlockUefnBridgeImport())

        with self.assertRaises(ImportError):
            uefn_launcher._mcp_command_entries()


if __name__ == "__main__":
    unittest.main()
