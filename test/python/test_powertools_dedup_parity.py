"""Drift-guard tests for the Power Tools de-duplication batch — PARITY half.

Covers:
  1. Python uefn_bridge._METHODS <-> TS uefn-server.ts registerTool() parity
     (media/uefn-bridge/uefn_bridge.py's _METHODS dict vs
     uefn-bridge/uefn-server.ts's server.registerTool(...) calls).
  2. uefn_launcher._TOOLS card list <-> _TOOL_DISPATCH dict parity
     (media/uefn-bridge/uefn_launcher.py, ~lines 175-248 and ~528-547).
  3. uefn_bridge._SEVERITY_KEYS <-> uefn-server.ts's severity_counts schema
     (uefn_bridge.py ~line 804; uefn-server.ts ~lines 981-987).
  4. build_mode_cleanup._DEVICE_CLASS_HINTS derivation from
     device_audit._DEVICE_CLASS_HINTS minus "BuildingGameplayActor"
     (media/uefn-bridge/build_mode_cleanup.py ~lines 162-172).

See test_powertools_dedup_ipc_and_skip_prefixes.py (same directory) for the
IPC-literal-pinning and _SKIP_PREFIXES-canonicalization half of this batch's
drift-guard coverage.

Discovered while writing this suite (reported, not fixed — implementation
is frozen for this pass): the TS/Python tool parity is NOT the simple
`uefn_<key>` <-> `<key>` 1:1 mapping everywhere. Two additional exceptions
exist beyond the documented `uefn_verse_check` (server-side, no _METHODS
key) — see RENAMED_TOOL_FOR_METHOD and PY_METHODS_WITHOUT_TS_TOOL below for
what they are and why. Both are encoded as NAMED, commented exceptions
(not silently ignored) so a future unrelated method added without its TS
twin still fails this test.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import (  # noqa: E402
    REPO_ROOT,
    ensure_bridge_on_path,
    import_uefn_bridge,
    stub_unreal,
)

TS_SERVER_PATH = os.path.join(REPO_ROOT, "uefn-bridge", "uefn-server.ts")


def _read_ts_source():
    if not os.path.isfile(TS_SERVER_PATH):
        raise RuntimeError(f"expected TS MCP server at {TS_SERVER_PATH!r}, not found")
    with open(TS_SERVER_PATH, "r", encoding="utf-8") as f:
        return f.read()


ensure_bridge_on_path()
stub_unreal()
import_uefn_bridge()

import uefn_bridge  # noqa: E402
import uefn_launcher  # noqa: E402

TS_SOURCE = _read_ts_source()

# Every TS-registered tool name, in source order: `server.registerTool(\n
# "uefn_xxx"`. \s matches the newline+indentation between the paren and the
# quoted literal.
_REGISTER_TOOL_RE = re.compile(r'registerTool\(\s*"(uefn_[A-Za-z0-9_]+)"')
_TS_TOOL_NAMES = _REGISTER_TOOL_RE.findall(TS_SOURCE)

# --- Documented exceptions to the plain `uefn_<key>` <-> `<key>` mapping --

# uefn_verse_check: TS-only, server-side. Spawns verse_lsp_check.py directly
# over LSP/stdio; never goes through uefn_bridge._METHODS/command.json
# dispatch at all (see uefn_launcher._mcp_command_entries()'s own docstring
# for the same documented exception on the launcher-panel side).
TS_ONLY_TOOLS = {"uefn_verse_check"}

# moderation_report_save: the Python _METHODS key is "moderation_report_save",
# but the MCP-facing tool is registered under the friendlier name
# "uefn_moderation_report" (uefn-server.ts ~line 973), not the mechanical
# "uefn_moderation_report_save". Verified below (not just asserted by name)
# that the tool's handler still actually dispatches to
# bridgeTool("moderation_report_save", ...).
RENAMED_TOOL_FOR_METHOD = {"moderation_report_save": "uefn_moderation_report"}

# moderation_report_read: has NO MCP-facing tool at all anywhere in
# uefn-server.ts. uefn_bridge.py's own docstring for
# _handle_moderation_report_read claims it is "used by the MCP side to
# confirm a save landed", but no registerTool/bridgeTool call for this
# method exists in the TS server — it is only reachable in-process, via
# moderation_scanner.py's tkinter window reading the file directly. This
# looks like a real docstring/behavior mismatch (flagged to the
# orchestrator as a finding, not fixed here — implementation is frozen).
# Encoded as a named exception so a FUTURE unrelated method added without a
# TS twin still fails this test.
PY_METHODS_WITHOUT_TS_TOOL = {"moderation_report_read"}


class PythonTsToolParityTests(unittest.TestCase):
    """Guards uefn_bridge._METHODS against uefn-server.ts registerTool calls."""

    def test_ts_source_has_a_sane_number_of_registrations(self):
        # Defensive sanity check on the regex/extraction itself — if this
        # ever drops to near-zero, the parity tests below would pass
        # vacuously (no TS names to compare against) instead of failing.
        self.assertGreater(len(_TS_TOOL_NAMES), 20, _TS_TOOL_NAMES)

    def test_every_methods_key_has_a_ts_registration_or_documented_exception(self):
        missing = []
        for key in uefn_bridge._METHODS:
            if key in PY_METHODS_WITHOUT_TS_TOOL:
                continue
            expected_name = RENAMED_TOOL_FOR_METHOD.get(key, "uefn_" + key)
            if expected_name not in _TS_TOOL_NAMES:
                missing.append((key, expected_name))
        self.assertEqual(
            missing,
            [],
            "Python _METHODS key(s) with no matching TS registerTool: "
            + ", ".join(f"{k!r} (expected {name!r})" for k, name in missing),
        )

    def test_every_ts_tool_has_a_methods_key_or_documented_exception(self):
        rename_targets = set(RENAMED_TOOL_FOR_METHOD.values())
        missing = []
        for name in _TS_TOOL_NAMES:
            if name in TS_ONLY_TOOLS or name in rename_targets:
                continue
            key = name[len("uefn_"):]
            if key not in uefn_bridge._METHODS:
                missing.append(name)
        self.assertEqual(
            missing,
            [],
            "TS registerTool call(s) with no matching uefn_bridge._METHODS key: "
            + ", ".join(missing),
        )

    def test_renamed_tool_still_dispatches_to_its_real_method(self):
        # Confirms RENAMED_TOOL_FOR_METHOD isn't just a name coincidence —
        # the tool's own handler body must actually call
        # bridgeTool("moderation_report_save", ...).
        for method, tool_name in RENAMED_TOOL_FOR_METHOD.items():
            idx = TS_SOURCE.find(f'"{tool_name}"')
            self.assertNotEqual(idx, -1, f"{tool_name!r} registration not found")
            next_register = TS_SOURCE.find("server.registerTool(", idx + 1)
            window_end = next_register if next_register != -1 else idx + 6000
            window = TS_SOURCE[idx:window_end]
            self.assertIn(
                f'"{method}"',
                window,
                f"{tool_name!r} does not appear to dispatch to bridgeTool({method!r}, ...)",
            )

    def test_documented_exceptions_are_still_accurate(self):
        # If any of these stop being true, the exception lists above are
        # stale and must be revisited alongside the parity assertions.
        self.assertNotIn("verse_check", uefn_bridge._METHODS)
        self.assertIn("uefn_verse_check", _TS_TOOL_NAMES)

        self.assertIn("moderation_report_read", uefn_bridge._METHODS)
        self.assertNotIn("uefn_moderation_report_read", _TS_TOOL_NAMES)

        self.assertIn("moderation_report_save", uefn_bridge._METHODS)
        self.assertNotIn("uefn_moderation_report_save", _TS_TOOL_NAMES)
        self.assertIn("uefn_moderation_report", _TS_TOOL_NAMES)

    def test_unmapped_new_method_would_fail_the_test(self):
        # Meta-guard: prove the parity test actually catches a real drift
        # case, using a fake key that is neither in _METHODS-for-real nor
        # in any exception list.
        fake_key = "__drift_guard_fake_method__"
        self.assertNotIn(fake_key, uefn_bridge._METHODS)
        snapshot = dict(uefn_bridge._METHODS)
        uefn_bridge._METHODS[fake_key] = lambda *a, **k: None
        try:
            expected_name = RENAMED_TOOL_FOR_METHOD.get(fake_key, "uefn_" + fake_key)
            self.assertNotIn(expected_name, _TS_TOOL_NAMES)
        finally:
            uefn_bridge._METHODS.clear()
            uefn_bridge._METHODS.update(snapshot)


class LauncherCardDispatchParityTests(unittest.TestCase):
    """Guards uefn_launcher._TOOLS (card list) against _TOOL_DISPATCH (the
    action -> launch-callable dict) — media/uefn-bridge/uefn_launcher.py."""

    def test_every_tool_action_has_a_dispatch_entry(self):
        missing = [
            t["action"] for t in uefn_launcher._TOOLS
            if t["action"] not in uefn_launcher._TOOL_DISPATCH
        ]
        self.assertEqual(missing, [], f"_TOOLS action(s) with no _TOOL_DISPATCH entry: {missing}")

    def test_every_dispatch_entry_has_a_tool_card(self):
        card_actions = {t["action"] for t in uefn_launcher._TOOLS}
        missing = [a for a in uefn_launcher._TOOL_DISPATCH if a not in card_actions]
        self.assertEqual(missing, [], f"_TOOL_DISPATCH action(s) with no _TOOLS card: {missing}")

    def test_no_duplicate_actions_in_tools(self):
        actions = [t["action"] for t in uefn_launcher._TOOLS]
        self.assertEqual(len(actions), len(set(actions)), actions)

    def test_dispatch_entries_are_callable(self):
        for action, handler in uefn_launcher._TOOL_DISPATCH.items():
            with self.subTest(action=action):
                self.assertTrue(callable(handler))


class SeverityMirrorTests(unittest.TestCase):
    """Guards uefn_bridge._SEVERITY_KEYS against uefn-server.ts's
    severity_counts z.object({...}) schema (uefn-server.ts ~lines 981-987)."""

    _SEVERITY_BLOCK_RE = re.compile(r"severity_counts:\s*z\s*\.object\(\{([\s\S]*?)\}\)")

    def test_severity_keys_canonical_value(self):
        self.assertEqual(uefn_bridge._SEVERITY_KEYS, ("BLOCKER", "WARN", "KNOWN_RISK", "INFO"))

    def test_severity_keys_all_appear_in_ts_schema_block(self):
        m = self._SEVERITY_BLOCK_RE.search(TS_SOURCE)
        self.assertIsNotNone(
            m, "could not locate the severity_counts z.object({...}) schema block in uefn-server.ts"
        )
        block = m.group(1)
        missing = [
            key for key in uefn_bridge._SEVERITY_KEYS
            if not re.search(r"\b" + re.escape(key) + r"\b\s*:", block)
        ]
        self.assertEqual(missing, [], f"severity key(s) missing from TS severity_counts schema: {missing}")


class HintsDerivationTests(unittest.TestCase):
    """Guards build_mode_cleanup._DEVICE_CLASS_HINTS's derivation from
    device_audit._DEVICE_CLASS_HINTS (media/uefn-bridge/build_mode_cleanup.py
    ~lines 162-172; media/uefn-bridge/device_audit.py ~line 36)."""

    def setUp(self):
        ensure_bridge_on_path()
        stub_unreal()

    def test_build_mode_cleanup_hints_equal_device_audit_minus_buildinggameplayactor(self):
        import device_audit
        import build_mode_cleanup

        expected = tuple(h for h in device_audit._DEVICE_CLASS_HINTS if h != "BuildingGameplayActor")
        self.assertEqual(build_mode_cleanup._DEVICE_CLASS_HINTS, expected)

    def test_buildinggameplayactor_dropped_other_hints_kept(self):
        import device_audit
        import build_mode_cleanup

        self.assertNotIn("BuildingGameplayActor", build_mode_cleanup._DEVICE_CLASS_HINTS)
        self.assertIn("BuildingGameplayActor", device_audit._DEVICE_CLASS_HINTS)
        for hint in ("Device", "FortCreativeDevice", "CreativeDevice"):
            self.assertIn(hint, build_mode_cleanup._DEVICE_CLASS_HINTS)

    def test_fallback_matches_literal_when_device_audit_unimportable(self):
        class _BlockDeviceAudit:
            def find_spec(self, name, path, target=None):
                if name == "device_audit":
                    raise ImportError("blocked for drift-guard test")
                return None

        saved_modules = {
            name: sys.modules.pop(name, None) for name in ("build_mode_cleanup", "device_audit")
        }
        saved_meta_path = list(sys.meta_path)
        sys.meta_path.insert(0, _BlockDeviceAudit())
        try:
            import build_mode_cleanup as fresh_bmc

            self.assertEqual(
                fresh_bmc._DEVICE_CLASS_HINTS,
                ("Device", "FortCreativeDevice", "CreativeDevice"),
            )
        finally:
            sys.meta_path[:] = saved_meta_path
            for name, mod in saved_modules.items():
                sys.modules.pop(name, None)
                if mod is not None:
                    sys.modules[name] = mod


if __name__ == "__main__":
    unittest.main()
