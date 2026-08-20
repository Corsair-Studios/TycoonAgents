"""Tests for cursor pagination in batch_tools.batch_get_property() /
batch_get_location() (media/uefn-bridge/batch_tools.py, _apply_pagination
~line 297 and _match_actors' ordering sort ~line 144).

Background (p3-t3, corrects p3-t1): p3-t1 added a hard max_results CEILING
that truncated the walk and reported the remainder as permanently missing
-- rejected because an audit tool needs FULL COVERAGE of every matched
actor (the reference project has 44,753), and truncation answers a
different question than the one asked. This rework makes max_results a
PAGE SIZE paired with a new offset parameter: a caller loops from offset=0
until the response's "next_offset" is absent, and the union of every
page's "actors" must equal the full matched set exactly once each -- no
gaps, no duplicates. That property depends entirely on _match_actors()
returning actors in the SAME order across separate calls (it now sorts by
(label, class_name) for exactly this reason); these tests pin both the
pagination slicing itself and, as the load-bearing case, the full-sweep
round-trip over a matched set larger than one page.

Mocking approach mirrors test_batch_get_property_status_shapes.py: stub
`unreal` via `_bridge_helpers.stub_unreal()`, point
`unreal.get_editor_subsystem` at a MagicMock subsystem whose
`get_all_level_actors()` returns actor doubles satisfying the REAL
`_is_device`/`_safe_label` (batch_tools imports both at module scope, so
they are never patched out).
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


class _FakeCls:
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name

    def get_super_class(self):
        return None


class _FakeActor:
    """Minimal actor double satisfying the REAL _is_device/_safe_label walk
    (class name carries a device hint, get_actor_label() returns the
    label) plus get_editor_property(name) for property lookups."""

    def __init__(self, label, cls_name="BP_WidgetDevice_C", props=None):
        self._cls = _FakeCls(cls_name)
        self._label = label
        self._props = props or {}

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


def _make_actors(n):
    """n actors labeled Widget000..Widget(n-1), each with MaxHealth=100,
    in a DELIBERATELY SHUFFLED insertion order -- so a test relying on
    get_all_level_actors()'s raw order (instead of _match_actors' sort)
    would fail, proving the sort is what makes pagination sound."""
    actors = [
        _FakeActor("Widget{0:03d}".format(i), props={"MaxHealth": 100})
        for i in range(n)
    ]
    # Reverse every other pair to break any accidental insertion-order match.
    shuffled = actors[::2] + actors[1::2]
    return shuffled, {a.get_actor_label() for a in actors}


class BatchCursorPaginationTests(unittest.TestCase):
    def setUp(self):
        self._orig_get_editor_subsystem = _unreal.get_editor_subsystem

    def tearDown(self):
        _unreal.get_editor_subsystem = self._orig_get_editor_subsystem

    def _set_actors(self, actors):
        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(return_value=list(actors))
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)

    # -----------------------------------------------------------------
    # Load-bearing: full sweep across many pages == full matched set,
    # exactly once each, no gaps, no duplicates.
    # -----------------------------------------------------------------

    def test_full_sweep_across_pages_covers_every_actor_exactly_once(self):
        shuffled, expected_labels = _make_actors(37)
        self._set_actors(shuffled)

        page_size = 10
        offset = 0
        seen_labels = []
        pages_fetched = 0

        while True:
            result = batch_tools.batch_get_property(
                "label", "Widget*", "MaxHealth",
                max_results=page_size, offset=offset,
            )
            pages_fetched += 1
            self.assertEqual(result["matched"], 37)
            self.assertEqual(result["offset"], offset)
            for entry in result["actors"]:
                seen_labels.append(entry["label"])

            next_offset = result.get("next_offset")
            if next_offset is None:
                break
            offset = next_offset
            self.assertLessEqual(pages_fetched, 10)  # sanity bound, avoid infinite loop on a bug

        self.assertEqual(len(seen_labels), 37)
        self.assertEqual(set(seen_labels), expected_labels)
        self.assertEqual(len(seen_labels), len(set(seen_labels)))  # no duplicates
        self.assertEqual(pages_fetched, 4)  # ceil(37/10)

    # -----------------------------------------------------------------
    # No parameters -> everything, unchanged shape, no ceiling.
    # -----------------------------------------------------------------

    def test_no_parameters_returns_every_matched_actor_with_no_new_keys(self):
        shuffled, expected_labels = _make_actors(25)
        self._set_actors(shuffled)

        result = batch_tools.batch_get_property("label", "Widget*", "MaxHealth")

        self.assertEqual(result["matched"], 25)
        self.assertEqual(len(result["actors"]), 25)
        self.assertEqual({e["label"] for e in result["actors"]}, expected_labels)
        # No pagination keys leak into the default (opt-out) path.
        self.assertNotIn("offset", result)
        self.assertNotIn("next_offset", result)
        self.assertNotIn("returned", result)
        self.assertNotIn("truncated", result)

    # -----------------------------------------------------------------
    # Page size larger than the matched count -> one page, next_offset absent.
    # -----------------------------------------------------------------

    def test_page_size_larger_than_matched_count_yields_single_final_page(self):
        shuffled, expected_labels = _make_actors(5)
        self._set_actors(shuffled)

        result = batch_tools.batch_get_property(
            "label", "Widget*", "MaxHealth", max_results=1000, offset=0,
        )

        self.assertEqual(result["matched"], 5)
        self.assertEqual(result["offset"], 0)
        self.assertEqual(result["returned"], 5)
        self.assertNotIn("next_offset", result)
        self.assertEqual({e["label"] for e in result["actors"]}, expected_labels)

    # -----------------------------------------------------------------
    # Deterministic ordering across repeated calls.
    # -----------------------------------------------------------------

    def test_matched_ordering_is_identical_across_repeated_calls(self):
        shuffled, _ = _make_actors(20)
        self._set_actors(shuffled)

        first = batch_tools.batch_get_property(
            "label", "Widget*", "MaxHealth", max_results=6, offset=0,
        )
        second = batch_tools.batch_get_property(
            "label", "Widget*", "MaxHealth", max_results=6, offset=0,
        )

        first_labels = [e["label"] for e in first["actors"]]
        second_labels = [e["label"] for e in second["actors"]]
        self.assertEqual(first_labels, second_labels)
        # And it's actually sorted -- the documented ordering mechanism.
        self.assertEqual(first_labels, sorted(first_labels))

    # -----------------------------------------------------------------
    # Same guarantees on batch_get_location (the location special-case
    # path, and the function pagination was requested on directly).
    # -----------------------------------------------------------------

    def test_batch_get_location_full_sweep_covers_every_actor_exactly_once(self):
        actors = [
            _FakeActor("Marker{0:03d}".format(i), cls_name="SGMarker")
            for i in range(23)
        ]
        shuffled = actors[::2] + actors[1::2]
        for a in shuffled:
            a.get_actor_location = MagicMock(
                return_value=type("V", (), {"x": 1.0, "y": 2.0, "z": 3.0})()
            )
        self._set_actors(shuffled)

        offset = 0
        seen = []
        while True:
            result = batch_tools.batch_get_location(
                "label", "Marker*", max_results=7, offset=offset,
            )
            self.assertEqual(result["matched"], 23)
            for entry in result["actors"]:
                seen.append(entry["label"])
            next_offset = result.get("next_offset")
            if next_offset is None:
                break
            offset = next_offset

        self.assertEqual(len(seen), 23)
        self.assertEqual(len(set(seen)), 23)


if __name__ == "__main__":
    unittest.main()
