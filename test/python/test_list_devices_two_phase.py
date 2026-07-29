"""Tests for uefn_bridge.py's ``_handle_list_devices`` two-phase per-actor
handling (~lines 436-550), which replaced a single try/except that would
silently drop a level's worth of devices if `device_audit._is_device`
raised on any one actor's class.

Phase 1 (device check): a raise means "couldn't determine" -- the actor is
counted in the response's ``skipped_actors`` field and logged via
``unreal.log_warning`` ONCE per distinct failing class (not once per actor),
never silently dropped and never crashing the whole call.

Phase 2 (enrichment): a device that PASSED the phase-1 check always appears
in the result, even if resolving one of its fields (location, changed
properties, ...) raises -- the failure is folded into an ``"error"`` string
on that device entry instead of excluding the device (no success-shaped
failures: a device silently vanishing from the list because ONE field
couldn't resolve would be worse than including it with a visible error).

These tests monkeypatch the device_audit helpers bound onto the uefn_bridge
module (``_is_device``, ``_safe_label``, ``_actor_location_tuple``,
``_xyz_to_luf``, ``_find_overridden_properties``, ``_build_base_property_-
set``) directly -- uefn_bridge.py resolves these once at import time via
getattr(device_audit, name, None) (see its device_audit-import block), and
`_handle_list_devices` looks them up as module globals at call time, so
patching the bound attributes on the already-imported module exercises the
real handler logic without needing a full realistic device_audit class-
hierarchy walk for every fake actor.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, import_uefn_bridge, stub_unreal  # noqa: E402

ensure_bridge_on_path()
_unreal = stub_unreal()
bridge = import_uefn_bridge()


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeCls:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name


class _FakeActor:
    """Minimal actor double carrying only the flags each fake helper below
    inspects to decide whether to raise."""

    def __init__(self, cls_name, label="Widget", boom_check=False, boom_location=False):
        self._cls = _FakeCls(cls_name)
        self.label = label
        self.boom_check = boom_check
        self.boom_location = boom_location

    def get_class(self):
        return self._cls


def _fake_is_device_factory():
    def fake_is_device(actor):
        if getattr(actor, "boom_check", False):
            raise RuntimeError("device-check exploded")
        return True
    return fake_is_device


def _fake_safe_label(actor):
    return actor.label


def _fake_actor_location_tuple(actor):
    if getattr(actor, "boom_location", False):
        raise RuntimeError("location getter exploded")
    return (1.0, 2.0, 3.0)


def _fake_xyz_to_luf(x, y, z):
    return (x, y, z)


def _fake_find_overridden_properties(actor, base_props):
    return []


def _fake_build_base_property_set(all_actors):
    return frozenset()


# ---------------------------------------------------------------------------
# Test base: patches every device_audit-derived helper bound on the bridge
# module, restores the originals on tearDown.
# ---------------------------------------------------------------------------

class _ListDevicesTestBase(unittest.TestCase):
    _PATCHED_NAMES = (
        "_is_device",
        "_safe_label",
        "_actor_location_tuple",
        "_xyz_to_luf",
        "_find_overridden_properties",
        "_build_base_property_set",
    )

    def setUp(self):
        self._originals = {name: getattr(bridge, name) for name in self._PATCHED_NAMES}
        setattr(bridge, "_is_device", _fake_is_device_factory())
        setattr(bridge, "_safe_label", _fake_safe_label)
        setattr(bridge, "_actor_location_tuple", _fake_actor_location_tuple)
        setattr(bridge, "_xyz_to_luf", _fake_xyz_to_luf)
        setattr(bridge, "_find_overridden_properties", _fake_find_overridden_properties)
        setattr(bridge, "_build_base_property_set", _fake_build_base_property_set)

        self._orig_get_editor_subsystem = _unreal.get_editor_subsystem
        _unreal.log_warning.reset_mock()

    def tearDown(self):
        for name, value in self._originals.items():
            setattr(bridge, name, value)
        _unreal.get_editor_subsystem = self._orig_get_editor_subsystem
        _unreal.log_warning.reset_mock()

    def _set_actors(self, actors):
        from unittest.mock import MagicMock
        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(return_value=list(actors))
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)


# ---------------------------------------------------------------------------
# (a) device-check failure -> excluded + counted + logged once per class
# ---------------------------------------------------------------------------

class DeviceCheckFailureTests(_ListDevicesTestBase):
    def test_two_same_class_failures_excluded_counted_and_logged_once(self):
        actor1 = _FakeActor("FailingClass", label="A1", boom_check=True)
        actor2 = _FakeActor("FailingClass", label="A2", boom_check=True)
        self._set_actors([actor1, actor2])

        result = bridge._handle_list_devices({})

        self.assertEqual(result["devices"], [])
        self.assertEqual(result["skipped_actors"], 2)
        self.assertEqual(result["total_actors"], 2)

        matches = [
            call.args[0]
            for call in _unreal.log_warning.call_args_list
            if call.args and "FailingClass" in str(call.args[0])
            and "device check failed" in str(call.args[0])
        ]
        self.assertEqual(
            len(matches), 1,
            "expected exactly ONE log_warning for two same-class check "
            "failures, got: " + repr(_unreal.log_warning.call_args_list),
        )

    def test_different_failing_classes_each_log_once(self):
        actor1 = _FakeActor("ClassA", boom_check=True)
        actor2 = _FakeActor("ClassB", boom_check=True)
        self._set_actors([actor1, actor2])

        result = bridge._handle_list_devices({})

        self.assertEqual(result["skipped_actors"], 2)
        warnings = [str(call.args[0]) for call in _unreal.log_warning.call_args_list if call.args]
        self.assertTrue(any("ClassA" in w for w in warnings))
        self.assertTrue(any("ClassB" in w for w in warnings))


# ---------------------------------------------------------------------------
# (b)/(c) enrichment failure -> still included with error; clean unaffected
# ---------------------------------------------------------------------------

class EnrichmentTests(_ListDevicesTestBase):
    def test_location_getter_failure_still_included_with_error_field(self):
        actor = _FakeActor("DeviceB", label="Loc1", boom_location=True)
        self._set_actors([actor])

        result = bridge._handle_list_devices({})

        self.assertEqual(result["skipped_actors"], 0)
        self.assertEqual(len(result["devices"]), 1)
        device = result["devices"][0]
        self.assertIn("error", device)
        self.assertIn("location", device["error"])
        # Other fields resolved fine and must still be present.
        self.assertEqual(device["label"], "Loc1")
        self.assertEqual(device["class"], "DeviceB")
        self.assertEqual(device["changed_property_count"], 0)
        # The field that actually failed must be absent, not a bogus value.
        self.assertNotIn("location", device)
        self.assertNotIn("location_luf", device)

    def test_clean_device_has_no_error_field_and_all_fields_present(self):
        actor = _FakeActor("DeviceA", label="Clean1")
        self._set_actors([actor])

        result = bridge._handle_list_devices({})

        self.assertEqual(len(result["devices"]), 1)
        device = result["devices"][0]
        self.assertNotIn("error", device)
        self.assertEqual(device["label"], "Clean1")
        self.assertEqual(device["class"], "DeviceA")
        self.assertEqual(device["location"], {"x": 1.0, "y": 2.0, "z": 3.0})
        self.assertEqual(device["location_luf"], {"left": 1.0, "up": 2.0, "forward": 3.0})
        self.assertEqual(device["changed_property_count"], 0)


# ---------------------------------------------------------------------------
# (d) skipped_actors stays 0 when every actor's device CHECK succeeded, even
#     if some of them hit an enrichment-phase error afterward.
# ---------------------------------------------------------------------------

class SkippedActorsHonestScopeTests(_ListDevicesTestBase):
    def test_skipped_actors_zero_when_all_checks_clean(self):
        clean = _FakeActor("DeviceA", label="Clean1")
        enrichment_error = _FakeActor("DeviceB", label="Loc1", boom_location=True)
        self._set_actors([clean, enrichment_error])

        result = bridge._handle_list_devices({})

        # Both actors passed the device CHECK -> both are devices -> both
        # counted in the results, neither in skipped_actors, even though
        # one of them carries an "error" field from phase 2.
        self.assertEqual(result["skipped_actors"], 0)
        self.assertEqual(len(result["devices"]), 2)
        self.assertEqual(result["total_devices"], 2)


if __name__ == "__main__":
    unittest.main()
