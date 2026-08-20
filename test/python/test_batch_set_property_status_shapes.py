"""Tests for batch_tools.batch_set_property()'s ``status`` field
(media/uefn-bridge/batch_tools.py, batch_set_property).

Mirrors test_batch_get_property_status_shapes.py: before this fix,
batch_set_property returned the SAME empty/success-looking
{"matched": 0, "modified": 0, "actors": []} shape whether a filter matched
zero actors or matched actors but set_editor_property() failed on the
property name for every one of them. This is the write-side of the exact
incident that motivated the read-path fix -- a bulk-write caller has no way
to distinguish "your filter syntax is wrong" from "your property name is
wrong" without the top-level ``status`` field. These tests pin the same
five-way status contract (error, zero_match, property_unresolved, partial,
ok) for the SET path and assert zero_match vs property_unresolved are
structurally distinguishable, same as the read-path suite.

Mocking approach reused verbatim from test_batch_get_property_status_shapes.py:
stub the `unreal` module via `_bridge_helpers.stub_unreal()`, then point
`unreal.get_editor_subsystem` at a MagicMock subsystem whose
`get_all_level_actors()` returns fakes satisfying the REAL `_is_device`
class-hierarchy walk and REAL `_safe_label`. `_FakeActor` needs a real
`get_actor_location()` to satisfy `_is_device`'s dependencies indirectly via
`_match_actors(..., require_device=True)` (the default batch_set_property
uses) -- it is not itself called on the set path, but the fake must still
support it for parity with the shared fake class.
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
# Fakes (mirrors test_batch_get_property_status_shapes.py's _FakeCls/_FakeActor)
# ---------------------------------------------------------------------------

class _FakeCls:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name

    def get_super_class(self):
        return None


class _FakeVector:
    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z


class _FakeActor:
    """Minimal actor double satisfying the REAL _is_device/_safe_label walk
    plus get_editor_property/set_editor_property for the property under
    test.

    props: {property_name: value} readable via get_editor_property. Used
    by batch_set_property to read the "current" value before coercing.

    settable: set of property names for which set_editor_property()
    succeeds. Any name not in settable raises on set_editor_property,
    modeling a property that cannot be written (read-only or nonexistent).
    Defaults to "every prop name in props" when not given, so ordinary
    tests need not pass it explicitly.
    """

    def __init__(self, label, cls_name="BP_WidgetDevice_C", props=None, settable=None, location=(0.0, 0.0, 0.0)):
        self._cls = _FakeCls(cls_name)
        self._label = label
        self._props = dict(props or {})
        self._settable = set(props.keys()) if settable is None and props else (settable or set())
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

    def set_editor_property(self, name, value):
        if name not in self._settable:
            raise RuntimeError(
                "set_editor_property({0!r}, ...) failed: property is "
                "read-only or does not exist on this actor".format(name)
            )
        self._props[name] = value

    def get_actor_location(self):
        x, y, z = self._location
        return _FakeVector(x, y, z)


class BatchSetPropertyStatusShapeTests(unittest.TestCase):
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
        self._set_actors([])

        result = batch_tools.batch_set_property("label", "NoSuchWidget*", "MaxHealth", "50")

        self.assertEqual(result["status"], "zero_match")
        self.assertEqual(result["filter_type"], "label")
        self.assertEqual(result["filter_value"], "NoSuchWidget*")
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["actors"], [])
        self.assertEqual(result["modified"], 0)

    # -----------------------------------------------------------------
    # 2. Property unresolved (unsettable) on every matched actor --
    #    structurally distinguishable from zero-match.
    # -----------------------------------------------------------------

    def test_property_unresolved_names_property_and_actors(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100}, settable=set())
        a2 = _FakeActor("Widget2", props={"MaxHealth": 200}, settable=set())
        self._set_actors([a1, a2])

        result = batch_tools.batch_set_property("label", "Widget*", "MaxHealth", "999")

        self.assertEqual(result["status"], "property_unresolved")
        self.assertEqual(result["property_name"], "MaxHealth")
        self.assertEqual(result["matched"], 2)
        self.assertEqual(result["modified"], 0)
        self.assertEqual(sorted(result["unresolved_on"]), ["Widget1", "Widget2"])
        for entry in result["actors"]:
            self.assertFalse(entry["ok"])
            self.assertTrue(entry.get("error"))
            self.assertIsInstance(entry["error"], str)

    def test_property_unresolved_shape_differs_structurally_from_zero_match(self):
        self._set_actors([])
        zero_match = batch_tools.batch_set_property("label", "Widget*", "MaxHealth", "50")

        a1 = _FakeActor("Widget1", props={"MaxHealth": 100}, settable=set())
        self._set_actors([a1])
        unresolved = batch_tools.batch_set_property("label", "Widget*", "MaxHealth", "50")

        self.assertNotEqual(zero_match["status"], unresolved["status"])
        self.assertEqual(zero_match["status"], "zero_match")
        self.assertEqual(unresolved["status"], "property_unresolved")

        self.assertEqual(zero_match["matched"], 0)
        self.assertGreater(unresolved["matched"], 0)

        self.assertNotIn("unresolved_on", zero_match)
        self.assertIn("unresolved_on", unresolved)
        self.assertTrue(unresolved["unresolved_on"])

        self.assertNotIn("property_name", zero_match)
        self.assertEqual(unresolved["property_name"], "MaxHealth")

    # -----------------------------------------------------------------
    # 3. Partial failure: some set, some don't
    # -----------------------------------------------------------------

    def test_partial_failure_keeps_both_succeeded_and_failed_entries(self):
        succeeds = _FakeActor("Good1", props={"MaxHealth": 100}, settable={"MaxHealth"})
        fails = _FakeActor("Bad1", props={"MaxHealth": 50}, settable=set())
        self._set_actors([succeeds, fails])

        result = batch_tools.batch_set_property("label", "*", "MaxHealth", "999")

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["property_name"], "MaxHealth")
        self.assertEqual(result["matched"], 2)
        self.assertEqual(result["modified"], 1)
        self.assertEqual(result["unresolved_on"], ["Bad1"])

        by_label = {entry["label"]: entry for entry in result["actors"]}

        good_entry = by_label["Good1"]
        self.assertTrue(good_entry["ok"])
        self.assertNotIn("error", good_entry)
        self.assertEqual(good_entry["new_value"], "999")

        bad_entry = by_label["Bad1"]
        self.assertFalse(bad_entry["ok"])
        self.assertIsInstance(bad_entry["error"], str)
        self.assertTrue(bad_entry["error"])
        self.assertIsNotNone(bad_entry["error"])

    # -----------------------------------------------------------------
    # 4. "ok" path: all set successfully; legacy old_value/new_value/
    #    modified keys preserved for backward compat.
    # -----------------------------------------------------------------

    def test_ok_path_preserves_legacy_keys_for_backward_compat(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100}, settable={"MaxHealth"})
        a2 = _FakeActor("Widget2", props={"MaxHealth": 250}, settable={"MaxHealth"})
        self._set_actors([a1, a2])

        result = batch_tools.batch_set_property("label", "Widget*", "MaxHealth", "500")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matched"], 2)
        self.assertEqual(result["modified"], 2)
        self.assertNotIn("unresolved_on", result)
        for entry in result["actors"]:
            self.assertTrue(entry["ok"])
            self.assertIn("old_value", entry)
            self.assertIn("new_value", entry)
            self.assertEqual(entry["new_value"], "500")

    def test_dry_run_does_not_modify_but_still_reports_ok(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100}, settable={"MaxHealth"})
        self._set_actors([a1])

        result = batch_tools.batch_set_property("label", "Widget1", "MaxHealth", "500", dry_run=True)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matched"], 1)
        self.assertEqual(result["modified"], 0)
        self.assertEqual(a1._props["MaxHealth"], 100)  # unchanged
        self.assertEqual(result["actors"][0]["new_value"], "500")  # preview only

    # -----------------------------------------------------------------
    # 5. Error: _match_actors itself raises
    # -----------------------------------------------------------------

    def test_match_actors_error_names_the_filter(self):
        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(side_effect=RuntimeError("boom"))
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)

        result = batch_tools.batch_set_property("class", "Widget", "MaxHealth", "1")

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["filter_type"], "class")
        self.assertEqual(result["filter_value"], "Widget")
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["actors"], [])
        self.assertEqual(result["modified"], 0)
        self.assertTrue(result["error"])


if __name__ == "__main__":
    unittest.main()
