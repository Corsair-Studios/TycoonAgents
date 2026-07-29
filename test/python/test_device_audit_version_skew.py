"""Tests for uefn_bridge.py's version-skew tolerance around its device_audit
helper imports.

Field failure this guards against (see uefn_bridge.py's device_audit import
block for the full story): a real UEFN log showed

    Failed to start UEFN bridge -- cannot import name '_is_actor_enabled'
    from 'device_audit' (...\\FortniteGame\\Content\\Python\\device_audit.py)

from a STALE engine-side copy of device_audit.py shadowing a newer project
copy on sys.path. Because uefn_bridge.py used to do
`from device_audit import (...)` at module scope, that ONE missing helper
took down the ENTIRE bridge at import time -- no IPC, no heartbeat, no
Power Tools popup, and to the user it looked like the install did nothing.

uefn_bridge.py now resolves each device_audit helper individually via
getattr(module, name, None), logs one startup warning naming every missing
symbol plus the resolved module's __file__, and gates the specific handlers
that need a missing helper (_find_actor_by_label, _handle_list_devices,
_handle_run_audit) behind an explicit _require_device_audit_symbols() check
that raises a RuntimeError naming the symbol -- rather than letting a
None-not-callable TypeError get silently swallowed by a broad
`except Exception: continue` into a falsely-empty "successful" devices list
(this repo has a standing rule against exactly that failure shape).

A SECOND exposure to the same failure was found while writing these tests:
batch_tools.py (a sibling uefn_bridge.py imports unconditionally) does its
OWN hard `from device_audit import _is_device, _safe_label` at module
scope. Popping 'batch_tools' from sys.modules and forcing a fresh import
against the same skewed fake device_audit reproduces that ImportError --
proving it would otherwise still crash the whole bridge, one file deeper,
even with the device_audit block above fixed. uefn_bridge.py now wraps
that one import in try/except ImportError (mirroring the pre-existing
asset_sweep fallback pattern already in this file) and gates
_handle_batch_set/_handle_batch_get accordingly.

These tests reproduce the failure shape with a FAKE device_audit module
missing one symbol, installed in sys.modules before a FRESH import of
uefn_bridge (and its batch_tools sibling), and verify:
  1. uefn_bridge still imports cleanly (no ImportError / crash).
  2. The dependent handlers (list_devices, run_audit) return an explicit
     error naming the missing symbol and the resolved (fake) module path.
  3. batch_set/batch_get -- broken via batch_tools.py's OWN hard import --
     also degrade to an explicit error instead of crashing the module.
  4. An independent handler chain that only needs a helper which IS present
     in the fake (select_actor -> _find_actor_by_label -> _safe_label)
     keeps working normally.
  5. Exactly one startup warning names the missing symbol and module path.
  6. With a COMPLETE device_audit, nothing is flagged missing (baseline).
"""
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
_unreal_mock = stub_unreal()

# Import the REAL device_audit once so its genuine pure helpers (_safe_label
# etc.) can be reused as-is in the fake module below -- only ONE symbol is
# ever actually withheld, matching the real field failure (a single missing
# helper, everything else intact).
import device_audit as _real_device_audit  # noqa: E402

_ALL_HELPER_NAMES = (
    "_is_device",
    "_safe_label",
    "_actor_location_tuple",
    "_xyz_to_luf",
    "_find_overridden_properties",
    "_build_base_property_set",
    "_get_property_names",
)

_MISSING_SYMBOL = "_is_device"  # gates list_devices/run_audit only
_FAKE_DEVICE_AUDIT_PATH = r"C:\FakeStaleEngineCopy\Content\Python\device_audit.py"


def _build_fake_device_audit(missing):
    """A fake device_audit module carrying the REAL implementation of every
    helper except *missing* (or all of them, if *missing* is None) --
    simulating a stale copy that predates a helper the current
    uefn_bridge.py expects."""
    fake = types.ModuleType("device_audit")
    fake.__file__ = _FAKE_DEVICE_AUDIT_PATH
    for name in _ALL_HELPER_NAMES:
        if name == missing:
            continue
        setattr(fake, name, getattr(_real_device_audit, name))
    return fake


class _FakeActor:
    """Minimal actor double -- only what device_audit._safe_label touches."""

    def __init__(self, label):
        self._label = label

    def get_actor_label(self):
        return self._label


def _import_fresh_bridge_with_fake_device_audit(missing):
    """Import a BRAND-NEW uefn_bridge module with sys.modules['device_audit']
    replaced by a fake missing *missing*, then fully restore sys.modules to
    its pre-call snapshot (via mock.patch.dict) so later test modules in the
    same unittest-discover process still see the real device_audit/
    uefn_bridge. The returned module object stays alive via this function's
    return value even after the sys.modules entry is gone.

    Also pops 'batch_tools' so it re-executes fresh against the patched
    device_audit -- batch_tools.py does its own hard `from device_audit
    import _is_device, _safe_label` at module scope, so if this function
    is NOT called before anything else has cached a real 'batch_tools'
    module in this process, a missing _is_device/_safe_label reproduces
    that ImportError for real, exercising uefn_bridge.py's guard around it
    rather than silently reusing an already-cached, unaffected copy."""
    fake_module = _build_fake_device_audit(missing)
    with mock.patch.dict(sys.modules, {"device_audit": fake_module}):
        sys.modules.pop("uefn_bridge", None)
        sys.modules.pop("batch_tools", None)
        import uefn_bridge  # noqa: E402  (fresh exec against the patched device_audit)
    return uefn_bridge, fake_module


class ImportSurvivesMissingHelperTests(unittest.TestCase):
    def test_bridge_imports_cleanly_with_one_helper_missing(self):
        bridge, _fake = _import_fresh_bridge_with_fake_device_audit(_MISSING_SYMBOL)
        self.assertIsNotNone(bridge)
        self.assertIsNone(bridge._is_device)
        self.assertIsNotNone(bridge._safe_label)
        self.assertIn(_MISSING_SYMBOL, bridge._DEVICE_AUDIT_MISSING)


class DependentHandlerErrorsExplicitlyTests(unittest.TestCase):
    def setUp(self):
        self.bridge, self.fake_module = _import_fresh_bridge_with_fake_device_audit(_MISSING_SYMBOL)

    def test_list_devices_raises_explicit_error_naming_symbol_and_path(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.bridge._handle_list_devices({})
        message = str(ctx.exception)
        self.assertIn(_MISSING_SYMBOL, message)
        self.assertIn(_FAKE_DEVICE_AUDIT_PATH, message)

    def test_run_audit_raises_explicit_error_naming_symbol_and_path(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.bridge._handle_run_audit({})
        message = str(ctx.exception)
        self.assertIn(_MISSING_SYMBOL, message)
        self.assertIn(_FAKE_DEVICE_AUDIT_PATH, message)

    def test_dispatch_table_surfaces_the_error_not_a_crash(self):
        """End-to-end through the real dispatch entry the IPC loop uses:
        _METHODS['list_devices'] must raise a clean, named RuntimeError --
        never an unhandled/opaque TypeError -- so _process_command's
        `except Exception as e: error = str(e)` produces a response whose
        error field actually names the missing symbol."""
        handler = self.bridge._METHODS["list_devices"]
        with self.assertRaises(Exception) as ctx:
            handler({})
        self.assertIn(_MISSING_SYMBOL, str(ctx.exception))


class BatchToolsSiblingFailureTests(unittest.TestCase):
    """batch_tools.py's OWN hard `from device_audit import _is_device,
    _safe_label` (module scope) is the SECOND exposure to the same field
    failure -- it sits directly in uefn_bridge.py's import chain, one file
    deeper than the device_audit block this task set out to fix. Missing
    `_is_device` breaks that import too; uefn_bridge.py must degrade only
    batch_set/batch_get, not crash on module load."""

    def setUp(self):
        self.bridge, self.fake_module = _import_fresh_bridge_with_fake_device_audit(_MISSING_SYMBOL)

    def test_batch_tools_failed_to_import_is_visible_on_the_module(self):
        self.assertIsNone(self.bridge.batch_set_property)
        self.assertIsNone(self.bridge.batch_get_property)

    def test_batch_set_raises_explicit_error_not_a_crash(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.bridge._handle_batch_set({"property_name": "x", "value": 1})
        self.assertIn("batch_tools", str(ctx.exception))

    def test_batch_get_raises_explicit_error_not_a_crash(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.bridge._handle_batch_get({"property_name": "x"})
        self.assertIn("batch_tools", str(ctx.exception))

    def test_unrelated_status_handler_still_works_despite_batch_tools_gone(self):
        result = self.bridge._handle_status({})
        self.assertEqual(result["status"], "running")


class IndependentHandlerStillWorksTests(unittest.TestCase):
    """select_actor (via _find_actor_by_label) only needs `_safe_label`,
    which IS present in the fake -- it must keep working even though
    `_is_device` (needed only by list_devices/run_audit) is missing."""

    def setUp(self):
        self.bridge, self.fake_module = _import_fresh_bridge_with_fake_device_audit(_MISSING_SYMBOL)
        self._orig_get_editor_subsystem = _unreal_mock.get_editor_subsystem
        self._fake_actor = _FakeActor("Widget1")
        self._fake_subsystem = mock.MagicMock()
        self._fake_subsystem.get_all_level_actors.return_value = [self._fake_actor]
        _unreal_mock.get_editor_subsystem = mock.MagicMock(return_value=self._fake_subsystem)

    def tearDown(self):
        _unreal_mock.get_editor_subsystem = self._orig_get_editor_subsystem

    def test_status_handler_unaffected_by_missing_device_audit_helper(self):
        result = self.bridge._handle_status({})
        self.assertEqual(result["status"], "running")

    def test_select_actor_still_works_using_only_safe_label(self):
        result = self.bridge._handle_select_actor({"actor_label": "Widget1"})
        self.assertEqual(result, {"selected": True})
        self._fake_subsystem.set_actor_selection_state.assert_called_once_with(
            self._fake_actor, True
        )


class StartupWarningTests(unittest.TestCase):
    def test_logs_exactly_one_device_audit_warning_naming_symbol_and_module_path(self):
        # NOTE: with _is_device missing, batch_tools.py ALSO fails to import
        # (see BatchToolsSiblingFailureTests) and logs its OWN warning that
        # happens to mention "_is_device" too (it's quoting the ImportError
        # text). Filter on the phrase unique to the device_audit resolution
        # block itself ("is missing helper(s):") so this test isolates
        # exactly the ONE warning item 2 of the hardening task requires,
        # not the separate batch_tools fallback warning.
        _unreal_mock.log_warning.reset_mock()
        self.addCleanup(_unreal_mock.log_warning.reset_mock)

        _import_fresh_bridge_with_fake_device_audit(_MISSING_SYMBOL)

        matches = [
            call.args[0]
            for call in _unreal_mock.log_warning.call_args_list
            if call.args and "is missing helper(s):" in str(call.args[0])
            and _MISSING_SYMBOL in str(call.args[0])
        ]
        self.assertEqual(
            len(matches), 1,
            "expected exactly ONE device_audit startup warning naming the "
            "missing symbol, got: " + repr(_unreal_mock.log_warning.call_args_list),
        )
        self.assertIn(_FAKE_DEVICE_AUDIT_PATH, matches[0])


class NoHelpersMissingBaselineTests(unittest.TestCase):
    """Sanity baseline: with a COMPLETE device_audit, nothing is flagged
    missing and the otherwise-gated handlers see no guard error at all --
    proves the guard only fires when something is actually missing."""

    def test_all_symbols_present_no_missing_list_entries(self):
        bridge, _fake = _import_fresh_bridge_with_fake_device_audit(missing=None)
        self.assertEqual(bridge._DEVICE_AUDIT_MISSING, [])
        self.assertIsNotNone(bridge._is_device)
        self.assertIsNone(bridge._require_device_audit_symbols(*_ALL_HELPER_NAMES))
        # batch_tools.py's own device_audit import also succeeds when
        # nothing is missing -- the fallback path is dormant, not load-bearing.
        self.assertIsNotNone(bridge.batch_set_property)
        self.assertIsNotNone(bridge.batch_get_property)


if __name__ == "__main__":
    unittest.main()
