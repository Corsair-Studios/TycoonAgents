"""Tests for the class-default-object (CDO) diffing capability added to
device_audit.py, plus the derived counts uefn_bridge.py's _handle_run_audit
computes from it.

Covers (media/uefn-bridge/device_audit.py):
  - _get_class_default_object (~lines 82-137): getattr-guarded
    unreal.get_default_object, per-class-name cache (_CDO_CACHE), one-time
    process-wide warning when the symbol itself is missing
    (_CDO_UNAVAILABLE_LOGGED via the "<symbol-missing>" sentinel).
  - _truncate_report_value (~lines 140-151): 120-char cap.
  - _find_overridden_properties (~lines 273-386): real == comparison per
    property when a CDO is available (differing -> real default_value +
    overridden=True, equal -> omitted, comparison-raises -> "unknown");
    falls back to actor.is_editor_property_overridden with default_value
    None + default_unavailable_reason when no CDO is available.

And (media/uefn-bridge/uefn_bridge.py, ~lines 560-593):
  - _handle_run_audit's per-device overridden_count / unknown_count /
    defaults_resolved fields, derived from the changed-properties dict
    above.

THE CORE REGRESSION THIS FILE GUARDS: property comparison must use Python
`==` on the raw values returned by get_editor_property()/
cdo.get_editor_property() -- NEVER str()/repr() of those values. Unreal
struct values commonly repr() with an embedded (unstable) memory address,
e.g. "<Struct 'Vector3f' (0x...)>" -- a str/repr-based comparison would
misclassify every struct-valued property as "overridden" on every run, even
when nothing changed. StructReprTrapTests exercises exactly this shape in
both directions.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal, import_uefn_bridge  # noqa: E402

ensure_bridge_on_path()
_unreal = stub_unreal()

import device_audit  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeClass:
    """Minimal unreal-class double: get_name() (the CDO cache key and
    _is_device's hint-matching target) + get_super_class() (the hierarchy
    walk _is_device performs)."""

    def __init__(self, name, super_class=None):
        self._name = name
        self._super = super_class

    def get_name(self):
        return self._name

    def get_super_class(self):
        return self._super


class _RaisesOnEq:
    """A property value whose __eq__ raises -- models an exotic Unreal type
    that can't be compared. Must classify "unknown", NEVER True (a
    comparison failure masquerading as a real override is the exact bug
    this repo's rule forbids)."""

    def __eq__(self, other):
        raise RuntimeError("comparison not supported for this type")

    def __repr__(self):
        return "<RaisesOnEq>"


class _StructLike:
    """Models an Unreal struct value: repr() bakes in a fake memory address
    (like real struct reprs, e.g. "<Struct 'Vector3f' (0x...)>") that is
    DELIBERATELY independent of value equality -- proving the comparison
    never falls back to str()/repr() of the value."""

    def __init__(self, addr, value):
        self._addr = addr
        self.value = value

    def __repr__(self):
        return "<Struct 'Vector3f' (0x{:x})>".format(self._addr)

    __str__ = __repr__

    def __eq__(self, other):
        return self.value == other.value


class _FakeCDO:
    def __init__(self, props):
        self._props = dict(props)

    def get_editor_property(self, name):
        return self._props[name]


class _FakeVector:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = x
        self.y = y
        self.z = z


class _FakeActor:
    """Minimal actor double for _find_overridden_properties: real
    (non-callable) instance attributes so dir()-based _get_property_names
    finds them, plus a separate get_editor_property() lookup -- mirroring
    the real unreal actor API where dir() enumeration and
    get_editor_property() reads are independent paths. None of the prop
    values used in this file are callable, so none get filtered out by
    _get_property_names' `if callable(attr): continue` guard.

    Also implements get_actor_label()/get_actor_location() -- NOT touched
    by _find_overridden_properties/_get_class_default_object directly, but
    required by _safe_label()/_actor_location_tuple(), which
    uefn_bridge._handle_run_audit calls on every actor before it ever
    reaches the CDO-diffing logic under test here."""

    def __init__(self, cls, props, overridden_flags=None, label="FakeDevice"):
        self._cls = cls
        self._props = dict(props)
        self._overridden_flags = dict(overridden_flags or {})
        self._label = label
        self._location = _FakeVector(0.0, 0.0, 0.0)
        for name, value in props.items():
            setattr(self, name, value)

    def get_class(self):
        return self._cls

    def get_editor_property(self, name):
        return self._props[name]

    def is_editor_property_overridden(self, name):
        return self._overridden_flags.get(name, False)

    def get_actor_label(self):
        return self._label

    def get_actor_location(self):
        return self._location


def _reset_caches():
    device_audit._CDO_CACHE.clear()
    device_audit._CDO_UNAVAILABLE_LOGGED.clear()


class _CDOTestCase(unittest.TestCase):
    """Snapshots/restores the shared `unreal` mock's get_default_object and
    log_warning attributes around each test (the mock is shared process-wide
    across every test_*.py module in this suite), and resets device_audit's
    module-level CDO caches so tests don't leak into each other."""

    def setUp(self):
        _reset_caches()
        self._saved_get_default_object = _unreal.get_default_object
        self._saved_log_warning = _unreal.log_warning
        self._saved_log = _unreal.log
        _unreal.log_warning = MagicMock()
        _unreal.log = MagicMock()

    def tearDown(self):
        _unreal.get_default_object = self._saved_get_default_object
        _unreal.log_warning = self._saved_log_warning
        _unreal.log = self._saved_log
        _reset_caches()


# ---------------------------------------------------------------------------
# 1. CDO happy path
# ---------------------------------------------------------------------------

class CDOHappyPathTests(_CDOTestCase):
    def test_differing_equal_and_raising_properties_classified_correctly(self):
        cls = _FakeClass("Device_Test_C")
        cdo = _FakeCDO({
            "PropA": "default_a",
            "PropB": "same_value",
            "PropC": _RaisesOnEq(),
        })
        actor = _FakeActor(cls, {
            "PropA": "changed_a",
            "PropB": "same_value",
            "PropC": _RaisesOnEq(),
        })
        _unreal.get_default_object = MagicMock(return_value=cdo)

        changed = device_audit._find_overridden_properties(actor)

        self.assertIn("PropA", changed)
        self.assertEqual(changed["PropA"]["overridden"], True)
        self.assertEqual(changed["PropA"]["default_value"], "default_a")
        self.assertEqual(changed["PropA"]["actor_value"], "changed_a")

        self.assertNotIn("PropB", changed, "equal property must be omitted, not reported")

        self.assertIn("PropC", changed)
        self.assertEqual(changed["PropC"]["overridden"], "unknown")

    def test_handle_run_audit_counts_and_defaults_resolved(self):
        bridge = import_uefn_bridge()
        cls = _FakeClass("Device_Test_C")
        cdo = _FakeCDO({
            "PropA": "default_a",
            "PropB": "same_value",
            "PropC": _RaisesOnEq(),
        })
        actor = _FakeActor(cls, {
            "PropA": "changed_a",
            "PropB": "same_value",
            "PropC": _RaisesOnEq(),
        })
        _unreal.get_default_object = MagicMock(return_value=cdo)

        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(return_value=[actor])
        saved_subsystem_getter = _unreal.get_editor_subsystem
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)
        try:
            report = bridge._handle_run_audit({})
        finally:
            _unreal.get_editor_subsystem = saved_subsystem_getter

        self.assertEqual(report["total_devices"], 1)
        device = report["devices"][0]
        self.assertEqual(device["overridden_count"], 1)  # PropA only
        self.assertEqual(device["unknown_count"], 1)      # PropC only
        self.assertTrue(device["defaults_resolved"])


# ---------------------------------------------------------------------------
# 2. Struct-repr trap (core regression guard)
# ---------------------------------------------------------------------------

class StructReprTrapTests(_CDOTestCase):
    def test_different_repr_same_value_classified_equal_and_omitted(self):
        cls = _FakeClass("Device_Struct_C")
        actor_value = _StructLike(0x1111AAAA, 5)
        default_value = _StructLike(0x2222BBBB, 5)  # different "address", same value
        self.assertNotEqual(repr(actor_value), repr(default_value))

        cdo = _FakeCDO({"StructProp": default_value})
        actor = _FakeActor(cls, {"StructProp": actor_value})
        _unreal.get_default_object = MagicMock(return_value=cdo)

        changed = device_audit._find_overridden_properties(actor)

        self.assertNotIn(
            "StructProp", changed,
            "structs with different repr() but equal __eq__ must be treated "
            "as EQUAL -- proves the comparison never uses str()/repr()",
        )

    def test_same_repr_different_value_classified_overridden(self):
        cls = _FakeClass("Device_Struct_C")
        actor_value = _StructLike(0x1111AAAA, 5)
        default_value = _StructLike(0x1111AAAA, 6)  # same "address", different value
        self.assertEqual(repr(actor_value), repr(default_value))

        cdo = _FakeCDO({"StructProp": default_value})
        actor = _FakeActor(cls, {"StructProp": actor_value})
        _unreal.get_default_object = MagicMock(return_value=cdo)

        changed = device_audit._find_overridden_properties(actor)

        self.assertIn(
            "StructProp", changed,
            "structs with identical repr() but unequal __eq__ must be "
            "treated as OVERRIDDEN -- proves the comparison never uses "
            "str()/repr() (which would have wrongly called this equal)",
        )
        self.assertEqual(changed["StructProp"]["overridden"], True)


# ---------------------------------------------------------------------------
# 3. Truncation
# ---------------------------------------------------------------------------

class TruncationTests(_CDOTestCase):
    def test_default_value_over_120_chars_truncated_in_report(self):
        cls = _FakeClass("Device_Long_C")
        long_default = "d" * 200
        cdo = _FakeCDO({"LongProp": long_default})
        actor = _FakeActor(cls, {"LongProp": "x" * 200})  # differs -> overridden
        _unreal.get_default_object = MagicMock(return_value=cdo)

        changed = device_audit._find_overridden_properties(actor)

        reported = changed["LongProp"]["default_value"]
        self.assertEqual(len(reported), device_audit._REPORT_VALUE_MAX_LEN + 3)
        self.assertTrue(reported.endswith("..."))
        self.assertEqual(reported[:-3], long_default[:device_audit._REPORT_VALUE_MAX_LEN])


# ---------------------------------------------------------------------------
# 4. CDO cache
#
# _get_class_default_object keys _CDO_CACHE/_CDO_UNAVAILABLE_LOGGED on
# cls.get_path_name() when available -- NOT the bare get_name() short name
# -- specifically so two distinct classes that happen to share a short name
# can't collide and silently swap cached CDOs. get_name() is used as the
# cache key only as a fallback when get_path_name is absent or itself
# fails. _FakeClass (above) never defines get_path_name at all, so tests
# that use a bare _FakeClass exercise the FALLBACK branch; tests below that
# need the primary path-keyed branch attach a get_path_name attribute
# directly onto the instance (a plain instance-attribute callable, not a
# real bound method -- calling it as cls.get_path_name() invokes it with no
# implicit self, which is exactly what's wanted here).
# ---------------------------------------------------------------------------

class CDOCacheTests(_CDOTestCase):
    def test_fallback_branch_same_short_name_twice_hits_get_default_object_once_when_get_path_name_absent(self):
        # Two DISTINCT class-object instances sharing the same NAME, neither
        # exposing get_path_name -- exercises the FALLBACK cache-key branch
        # (bare get_name()), not the primary path-keyed branch.
        cls_a = _FakeClass("Device_Cached_C")
        cls_b = _FakeClass("Device_Cached_C")
        self.assertFalse(hasattr(cls_a, "get_path_name"))
        cdo = _FakeCDO({})
        get_default_object_mock = MagicMock(return_value=cdo)
        _unreal.get_default_object = get_default_object_mock

        first = device_audit._get_class_default_object(cls_a)
        second = device_audit._get_class_default_object(cls_b)

        self.assertIs(first, cdo)
        self.assertIs(second, cdo)
        get_default_object_mock.assert_called_once()

    def test_collision_guard_same_short_name_different_path_name_each_gets_own_cdo(self):
        """THE POINT of keying on get_path_name(): two distinct classes that
        share a short get_name() but have DIFFERENT get_path_name() results
        must each resolve and cache their OWN CDO -- no cross-
        contamination, and no dedup across them (two real
        get_default_object calls)."""
        cls_a = _FakeClass("Device_Dup_C")
        cls_a.get_path_name = MagicMock(return_value="/Game/A/Device_Dup_C")
        cls_b = _FakeClass("Device_Dup_C")  # same short name as cls_a
        cls_b.get_path_name = MagicMock(return_value="/Game/B/Device_Dup_C")
        self.assertEqual(cls_a.get_name(), cls_b.get_name())
        self.assertNotEqual(cls_a.get_path_name(), cls_b.get_path_name())

        cdo_a = _FakeCDO({"marker": "a"})
        cdo_b = _FakeCDO({"marker": "b"})

        def _dispatch(cls):
            return cdo_a if cls is cls_a else cdo_b

        get_default_object_mock = MagicMock(side_effect=_dispatch)
        _unreal.get_default_object = get_default_object_mock

        result_a = device_audit._get_class_default_object(cls_a)
        result_b = device_audit._get_class_default_object(cls_b)

        self.assertIs(result_a, cdo_a)
        self.assertIs(result_b, cdo_b)
        self.assertIsNot(result_a, result_b)
        self.assertEqual(get_default_object_mock.call_count, 2)

    def test_path_name_cache_hit_same_class_resolved_twice_hits_get_default_object_once(self):
        cls = _FakeClass("Device_Path_C")
        cls.get_path_name = MagicMock(return_value="/Game/Path/Device_Path_C")
        cdo = _FakeCDO({})
        get_default_object_mock = MagicMock(return_value=cdo)
        _unreal.get_default_object = get_default_object_mock

        first = device_audit._get_class_default_object(cls)
        second = device_audit._get_class_default_object(cls)

        self.assertIs(first, cdo)
        self.assertIs(second, cdo)
        get_default_object_mock.assert_called_once()

    def test_get_path_name_raises_falls_back_without_wrong_cdo_reuse(self):
        """cls_a's get_path_name() raises -- it must fall back to its bare
        short name as the cache key rather than propagating the exception
        or caching under a bogus/shared key. cls_b shares cls_a's short
        name but has a WORKING, distinct get_path_name(), so it must still
        resolve and cache under its own path key -- proving cls_a's
        raise-and-fallback never lets cls_b (or vice versa) reuse the
        wrong class's cached CDO."""
        cls_a = _FakeClass("Device_Dup2_C")
        cls_a.get_path_name = MagicMock(side_effect=RuntimeError("path resolution failed"))
        cls_b = _FakeClass("Device_Dup2_C")  # same short name as cls_a
        cls_b.get_path_name = MagicMock(return_value="/Game/B/Device_Dup2_C")

        cdo_a = _FakeCDO({"marker": "a"})
        cdo_b = _FakeCDO({"marker": "b"})

        def _dispatch(cls):
            return cdo_a if cls is cls_a else cdo_b

        get_default_object_mock = MagicMock(side_effect=_dispatch)
        _unreal.get_default_object = get_default_object_mock

        result_a = device_audit._get_class_default_object(cls_a)
        result_b = device_audit._get_class_default_object(cls_b)

        self.assertIs(result_a, cdo_a)
        self.assertIs(result_b, cdo_b)
        self.assertIsNot(result_a, result_b)
        self.assertEqual(
            get_default_object_mock.call_count, 2,
            "cls_b must have triggered its own real resolution, not reused "
            "a cache entry left behind by cls_a's raise-and-fallback",
        )
        # Document exactly which keys ended up in the cache: cls_a fell
        # back to its bare short name, cls_b used its real path name -- two
        # DIFFERENT keys, which is why no collision occurred here.
        self.assertEqual(device_audit._CDO_CACHE.get("Device_Dup2_C"), cdo_a)
        self.assertEqual(device_audit._CDO_CACHE.get("/Game/B/Device_Dup2_C"), cdo_b)


# ---------------------------------------------------------------------------
# 5. Degradation: unreal.get_default_object missing entirely
# ---------------------------------------------------------------------------

class DegradationTests(_CDOTestCase):
    def setUp(self):
        super().setUp()
        # Simulate the symbol not existing on this UEFN build's `unreal`
        # module: getattr(unreal, "get_default_object", None) returns None
        # whether the attribute is truly absent or explicitly set to None --
        # both read identically to the code under test.
        _unreal.get_default_object = None

    def test_defaults_unresolved_but_old_override_detection_still_runs(self):
        cls = _FakeClass("Device_Legacy_C")
        actor = _FakeActor(
            cls,
            {"PropX": "changed_value"},
            overridden_flags={"PropX": True},
        )

        changed = device_audit._find_overridden_properties(actor)

        self.assertIn("PropX", changed)
        self.assertEqual(changed["PropX"]["overridden"], True)
        self.assertIsNone(changed["PropX"]["default_value"])
        reason = changed["PropX"].get("default_unavailable_reason")
        self.assertTrue(
            reason,
            "default_unavailable_reason must be present and non-empty so "
            "None can't be mistaken for 'compared and found no difference'",
        )
        self.assertEqual(changed["PropX"]["actor_value"], "changed_value")

    def test_non_overridden_property_still_omitted_in_fallback(self):
        cls = _FakeClass("Device_Legacy_C")
        actor = _FakeActor(
            cls,
            {"PropY": "stock_value"},
            overridden_flags={"PropY": False},
        )

        changed = device_audit._find_overridden_properties(actor)

        self.assertNotIn("PropY", changed)

    def test_nothing_raises_and_handle_run_audit_reports_defaults_unresolved(self):
        bridge = import_uefn_bridge()
        cls = _FakeClass("Device_Legacy_C")
        actor = _FakeActor(
            cls,
            {"PropX": "changed_value"},
            overridden_flags={"PropX": True},
        )
        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(return_value=[actor])
        saved_subsystem_getter = _unreal.get_editor_subsystem
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)
        try:
            report = bridge._handle_run_audit({})  # must not raise
        finally:
            _unreal.get_editor_subsystem = saved_subsystem_getter

        device = report["devices"][0]
        self.assertFalse(device["defaults_resolved"])
        self.assertEqual(device["overridden_count"], 1)
        self.assertEqual(device["unknown_count"], 0)
        # The report must be unambiguous that overrides exist -- an empty-
        # looking result here would be indistinguishable from "no overrides
        # found", which this whole feature exists to prevent.
        self.assertEqual(device["changed_property_count"], 1)
        self.assertIn("PropX", device["changed_properties"])


# ---------------------------------------------------------------------------
# 6. One-time warning
# ---------------------------------------------------------------------------

class OneTimeWarningTests(_CDOTestCase):
    def test_unavailable_symbol_logged_once_across_multiple_resolutions(self):
        _unreal.get_default_object = None

        cls_a = _FakeClass("Device_WarnA_C")
        cls_b = _FakeClass("Device_WarnB_C")

        device_audit._get_class_default_object(cls_a)
        device_audit._get_class_default_object(cls_a)
        device_audit._get_class_default_object(cls_b)

        self.assertEqual(
            _unreal.log_warning.call_count, 1,
            "the missing-symbol warning is documented as logged exactly "
            "once for the whole process (see the '<symbol-missing>' "
            "sentinel in _CDO_UNAVAILABLE_LOGGED), not once per class",
        )

    def test_symbol_present_but_raising_for_one_class_logged_once(self):
        def _raise(_cls):
            raise RuntimeError("resolution failed for this class")

        get_default_object_mock = MagicMock(side_effect=_raise)
        _unreal.get_default_object = get_default_object_mock
        cls = _FakeClass("Device_Raises_C")

        first = device_audit._get_class_default_object(cls)
        second = device_audit._get_class_default_object(cls)

        self.assertIsNone(first)
        self.assertIsNone(second)
        # Cached after the first (failed) resolution -- the second call
        # never re-invokes get_default_object at all.
        get_default_object_mock.assert_called_once()
        warnings = [
            call.args[0] for call in _unreal.log_warning.call_args_list
            if call.args
        ]
        matching = [w for w in warnings if "Device_Raises_C" in str(w)]
        self.assertEqual(len(matching), 1)


if __name__ == "__main__":
    unittest.main()
