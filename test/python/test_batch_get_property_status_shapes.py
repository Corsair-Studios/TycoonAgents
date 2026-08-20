"""Tests for batch_tools.batch_get_property()'s reworked ``status`` field
(media/uefn-bridge/batch_tools.py, lines 205-333).

Background: before this rework, a filter matching zero actors and a filter
matching actors but with an unresolvable property_name (e.g. "location",
which is a world-space getter, never an editor property) both returned the
same empty/success-looking {"matched": 0 or N, "actors": [...]} shape. A
developer's agent hit this on a real property lookup, inferred "the filter
syntax must be wrong" from the zero-actors-shaped response, and burned many
calls chasing the wrong cause before giving up. The fix adds a top-level
``status`` field with five distinct values (error, zero_match,
property_unresolved, partial, ok) so the failure mode is named, not
inferred. These tests pin that five-way shape and specifically assert the
zero_match and property_unresolved shapes are structurally distinguishable
from each other -- that distinction is the entire point of the fix.

Mocking approach mirrors test_list_devices_two_phase.py: stub the `unreal`
module via `_bridge_helpers.stub_unreal()`, then point
`unreal.get_editor_subsystem` at a MagicMock subsystem whose
`get_all_level_actors()` returns a list of minimal actor doubles.
batch_tools.py imports `_is_device`/`_safe_label` directly from
device_audit at module scope (unlike uefn_bridge.py's lazy getattr
resolution), so the actor doubles must satisfy the REAL `_is_device` class-
hierarchy walk (get_class().get_name() must contain one of
device_audit._DEVICE_CLASS_HINTS, e.g. "Device") and the REAL `_safe_label`
(get_actor_label()) rather than being patched out.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
_unreal = stub_unreal()

import batch_tools  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeCls:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name

    def get_super_class(self):
        return None


class _FakeVector:
    """Minimal stand-in for unreal.Vector -- _actor_location_tuple
    (device_audit.py:211-219) only reads .x/.y/.z off whatever
    get_actor_location() returns, then rounds each to 2 decimals."""

    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z


class _FakeActor:
    """Minimal actor double that satisfies the REAL _is_device/_safe_label
    walk (class name carries a device hint, get_actor_label() returns the
    label) plus get_editor_property(name) for the property lookup itself.

    props: {property_name: value} for names that resolve successfully.
    Any property_name not in props raises, modeling get_editor_property()
    failing to resolve (e.g. "location", which is never an editor
    property).

    location: optional (x, y, z) tuple. When given, get_actor_location()
    returns a _FakeVector carrying it, satisfying the REAL
    _actor_location_tuple (batch_tools.py imports it at module scope, so it
    is never monkeypatched here -- unlike test_list_devices_two_phase.py's
    approach). When omitted, get_actor_location() raises, modeling an actor
    whose world location genuinely cannot be read."""

    def __init__(self, label, cls_name="BP_WidgetDevice_C", props=None, location=None):
        self._cls = _FakeCls(cls_name)
        self._label = label
        self._props = props or {}
        self._location = location

    def get_class(self):
        return self._cls

    def get_actor_label(self):
        return self._label

    def get_editor_property(self, name):
        if name not in self._props:
            raise RuntimeError(
                "get_editor_property({0!r}) is not a recognized editor "
                "property on this actor".format(name)
            )
        return self._props[name]

    def get_actor_location(self):
        if self._location is None:
            raise RuntimeError(
                "get_actor_location() failed: no transform component "
                "available on this actor"
            )
        x, y, z = self._location
        return _FakeVector(x, y, z)


class BatchGetPropertyStatusShapeTests(unittest.TestCase):
    def setUp(self):
        self._orig_get_editor_subsystem = _unreal.get_editor_subsystem

    def tearDown(self):
        _unreal.get_editor_subsystem = self._orig_get_editor_subsystem

    def _set_actors(self, actors):
        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(return_value=list(actors))
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)

    # -----------------------------------------------------------------
    # 1. Zero-match: names the filter criteria that were tried
    # -----------------------------------------------------------------

    def test_zero_match_names_filter_criteria(self):
        self._set_actors([])  # no actors in the level at all

        result = batch_tools.batch_get_property("label", "NoSuchWidget*", "MaxHealth")

        self.assertEqual(result["status"], "zero_match")
        self.assertEqual(result["filter_type"], "label")
        self.assertEqual(result["filter_value"], "NoSuchWidget*")
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["actors"], [])

    # -----------------------------------------------------------------
    # 2. Property unresolved on every matched actor -- and structurally
    #    distinguishable from the zero-match shape above.
    # -----------------------------------------------------------------

    def test_property_unresolved_names_property_and_actors(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100})
        a2 = _FakeActor("Widget2", props={"MaxHealth": 200})
        self._set_actors([a1, a2])

        result = batch_tools.batch_get_property("label", "Widget*", "TotallyBogusProp")

        self.assertEqual(result["status"], "property_unresolved")
        self.assertEqual(result["property_name"], "TotallyBogusProp")
        self.assertEqual(result["matched"], 2)
        self.assertEqual(sorted(result["unresolved_on"]), ["Widget1", "Widget2"])
        for entry in result["actors"]:
            self.assertFalse(entry["ok"])
            self.assertTrue(entry.get("error"))

    def test_property_unresolved_shape_differs_structurally_from_zero_match(self):
        # Same filter matches actors this time; property is unresolvable
        # on all of them. This is the exact regression scenario: before
        # the fix, this returned the SAME empty-looking shape as a filter
        # matching nothing.
        self._set_actors([])
        zero_match = batch_tools.batch_get_property("label", "Widget*", "MaxHealth")

        a1 = _FakeActor("Widget1", props={"MaxHealth": 100})
        self._set_actors([a1])
        unresolved = batch_tools.batch_get_property("label", "Widget*", "location")

        # The statuses themselves must differ.
        self.assertNotEqual(zero_match["status"], unresolved["status"])
        self.assertEqual(zero_match["status"], "zero_match")
        self.assertEqual(unresolved["status"], "property_unresolved")

        # matched: 0 vs >0 -- no longer collapsible into the same reading.
        self.assertEqual(zero_match["matched"], 0)
        self.assertGreater(unresolved["matched"], 0)

        # unresolved_on: absent on zero_match, present (and non-empty) on
        # property_unresolved -- a caller can key off field presence alone.
        self.assertNotIn("unresolved_on", zero_match)
        self.assertIn("unresolved_on", unresolved)
        self.assertTrue(unresolved["unresolved_on"])

        # property_name: absent on zero_match (nothing was ever attempted),
        # present on property_unresolved (naming exactly what failed).
        self.assertNotIn("property_name", zero_match)
        self.assertEqual(unresolved["property_name"], "location")

    # -----------------------------------------------------------------
    # 3. Partial failure: some resolve, some don't
    # -----------------------------------------------------------------

    def test_partial_failure_keeps_both_resolved_and_unresolved_entries(self):
        resolves = _FakeActor("Good1", props={"MaxHealth": 100})
        fails = _FakeActor("Bad1", props={})  # MaxHealth not in props -> raises
        self._set_actors([resolves, fails])

        result = batch_tools.batch_get_property("label", "*", "MaxHealth")

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["property_name"], "MaxHealth")
        self.assertEqual(result["matched"], 2)
        self.assertEqual(result["unresolved_on"], ["Bad1"])

        self.assertEqual(len(result["actors"]), 2)
        by_label = {entry["label"]: entry for entry in result["actors"]}

        good_entry = by_label["Good1"]
        self.assertTrue(good_entry["ok"])
        self.assertNotIn("error", good_entry)

        bad_entry = by_label["Bad1"]
        self.assertFalse(bad_entry["ok"])
        self.assertIsInstance(bad_entry["error"], str)
        self.assertTrue(bad_entry["error"])  # non-empty, explicit marker
        self.assertIsNotNone(bad_entry["error"])  # never coerced to None

    # -----------------------------------------------------------------
    # 4. property_name="location": p2-t2 has landed -- it now routes
    #    through batch_get_location/_actor_location_tuple instead of
    #    get_editor_property(). An actor with a readable transform now
    #    resolves to "ok" with real coordinates; an actor whose location
    #    genuinely cannot be read still surfaces explicitly (never a bare
    #    empty success) via property_unresolved/partial with an error.
    # -----------------------------------------------------------------

    def test_location_property_name_resolves_ok_with_real_coordinates(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100}, location=(100.0, 200.0, 300.0))
        self._set_actors([a1])

        result = batch_tools.batch_get_property("all_devices", "", "location")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matched"], 1)
        entry = result["actors"][0]
        self.assertTrue(entry["ok"])
        self.assertEqual(entry["value"], (100.0, 200.0, 300.0))

    def test_location_property_name_still_explicit_when_unresolvable(self):
        # No location= given -> get_actor_location() raises, modeling an
        # actor whose world transform genuinely cannot be read. This is
        # the honest-failure contract that must survive the p2-t2 routing
        # change: a location that can't resolve must never look like a
        # bare empty success.
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100})  # no location
        self._set_actors([a1])

        result = batch_tools.batch_get_property("all_devices", "", "location")

        self.assertIn(result["status"], ("property_unresolved", "partial"))
        self.assertNotEqual(result["status"], "ok")
        self.assertIn("Widget1", result["unresolved_on"])
        self.assertGreater(result["matched"], 0)
        entry = result["actors"][0]
        self.assertFalse(entry["ok"])
        self.assertTrue(entry.get("error"))

    # -----------------------------------------------------------------
    # 5. "ok" path: legacy "value" key preserved per actor entry
    # -----------------------------------------------------------------

    def test_ok_path_preserves_legacy_value_key_for_backward_compat(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100})
        a2 = _FakeActor("Widget2", props={"MaxHealth": 250})
        self._set_actors([a1, a2])

        result = batch_tools.batch_get_property("label", "Widget*", "MaxHealth")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matched"], 2)
        self.assertNotIn("unresolved_on", result)
        for entry in result["actors"]:
            self.assertTrue(entry["ok"])
            self.assertIn("value", entry)  # legacy key, existing callers depend on it
            self.assertEqual(entry["value"], str(entry["value"]))


class BatchGetLocationCoordinateTests(unittest.TestCase):
    """Tests for the dedicated batch_get_location() entry point
    (batch_tools.py:392-524) and its parity with
    batch_get_property(property_name="location") (batch_tools.py:278-305)."""

    def setUp(self):
        self._orig_get_editor_subsystem = _unreal.get_editor_subsystem

    def tearDown(self):
        _unreal.get_editor_subsystem = self._orig_get_editor_subsystem

    def _set_actors(self, actors):
        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(return_value=list(actors))
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)

    def test_batch_get_location_returns_real_coordinates(self):
        a1 = _FakeActor("Marker1", location=(10.5, -20.25, 30.0))
        self._set_actors([a1])

        result = batch_tools.batch_get_location("all_devices", "")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matched"], 1)
        entry = result["actors"][0]
        self.assertTrue(entry["ok"])
        self.assertEqual(entry["label"], "Marker1")
        self.assertEqual(entry["location"], {"x": 10.5, "y": -20.25, "z": 30.0})

    def test_batch_get_location_resolves_non_device_actor(self):
        # Class name deliberately carries none of device_audit's
        # _DEVICE_CLASS_HINTS ("Device", "FortCreativeDevice",
        # "CreativeDevice", "BuildingGameplayActor") -- this actor fails
        # the REAL _is_device walk. batch_get_location must still resolve
        # its location because it calls _match_actors with
        # require_device=False (batch_tools.py:448); this is the entire
        # point of the require_device=False path from the SGMarker
        # incident.
        marker = _FakeActor("SGMarker1", cls_name="SGMarker_C", location=(1.0, 2.0, 3.0))
        self.assertFalse(batch_tools._is_device(marker))  # sanity: genuinely non-device
        self._set_actors([marker])

        result = batch_tools.batch_get_location("all_devices", "")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matched"], 1)
        entry = result["actors"][0]
        self.assertTrue(entry["ok"])
        self.assertEqual(entry["location"], {"x": 1.0, "y": 2.0, "z": 3.0})

    def test_batch_get_location_zero_match_vs_unresolvable_still_distinguishable(self):
        # Honest-failure contract must hold on the location path too.
        self._set_actors([])
        zero_match = batch_tools.batch_get_location("label", "NoSuchMarker*")
        self.assertEqual(zero_match["status"], "zero_match")
        self.assertEqual(zero_match["matched"], 0)
        self.assertNotIn("unresolved_on", zero_match)

        broken = _FakeActor("Broken1")  # no location -> get_actor_location() raises
        self._set_actors([broken])
        unresolved = batch_tools.batch_get_location("all_devices", "")
        self.assertEqual(unresolved["status"], "property_unresolved")
        self.assertEqual(unresolved["matched"], 1)
        self.assertIn("Broken1", unresolved["unresolved_on"])
        entry = unresolved["actors"][0]
        self.assertFalse(entry["ok"])
        self.assertTrue(entry.get("error"))

        self.assertNotEqual(zero_match["status"], unresolved["status"])

    def test_both_entry_points_return_identical_coordinates_for_same_filter(self):
        marker = _FakeActor("SGMarker1", cls_name="SGMarker_C", location=(42.0, -7.5, 100.25))
        self._set_actors([marker])
        direct = batch_tools.batch_get_location("label", "SGMarker*")

        self._set_actors([marker])
        via_property = batch_tools.batch_get_property("label", "SGMarker*", "location")

        self.assertEqual(direct["status"], via_property["status"])
        self.assertEqual(direct["matched"], via_property["matched"])

        direct_loc = direct["actors"][0]["location"]
        direct_coords = (direct_loc["x"], direct_loc["y"], direct_loc["z"])
        # batch_get_property reshapes location dict -> "value" 3-tuple; that
        # reshaping is the only shape difference between the two entry
        # points -- the coordinate DATA itself must match exactly.
        property_coords = via_property["actors"][0]["value"]
        self.assertEqual(direct_coords, property_coords)
        self.assertEqual(direct_coords, (42.0, -7.5, 100.25))

    def test_location_property_name_is_case_insensitive(self):
        a1 = _FakeActor("Widget1", location=(5.0, 6.0, 7.0))

        for variant in ("Location", "LOCATION", " location ", "LoCaTiOn"):
            self._set_actors([a1])
            result = batch_tools.batch_get_property("all_devices", "", variant)
            self.assertEqual(result["status"], "ok", "variant={0!r}".format(variant))
            self.assertEqual(result["actors"][0]["value"], (5.0, 6.0, 7.0))

    def test_transform_property_name_is_not_special_cased(self):
        # "transform" must NOT route through batch_get_location -- it falls
        # through to plain get_editor_property() like any other property,
        # per batch_get_property's own docstring (batch_tools.py:271-276).
        a1 = _FakeActor("Widget1", props={}, location=(1.0, 1.0, 1.0))  # no "transform" key
        self._set_actors([a1])

        result = batch_tools.batch_get_property("all_devices", "", "transform")

        self.assertIn(result["status"], ("property_unresolved", "partial"))
        self.assertEqual(result["property_name"], "transform")
        entry = result["actors"][0]
        self.assertFalse(entry["ok"])
        # If it had been silently routed through batch_get_location, value
        # would be a 3-tuple of coordinates instead of the get_editor_-
        # property error string shape.
        self.assertNotIsInstance(entry["value"], tuple)

    def test_non_location_property_still_routes_through_get_editor_property(self):
        # Guard against the "location" special case swallowing everything.
        a1 = _FakeActor("Widget1", props={"MaxHealth": 999}, location=(1.0, 2.0, 3.0))
        self._set_actors([a1])

        result = batch_tools.batch_get_property("all_devices", "", "MaxHealth")

        self.assertEqual(result["status"], "ok")
        entry = result["actors"][0]
        self.assertEqual(entry["value"], "999")  # get_editor_property path stringifies
        self.assertNotIsInstance(entry["value"], tuple)


if __name__ == "__main__":
    unittest.main()
