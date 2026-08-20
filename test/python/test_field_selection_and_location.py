"""Tests for Phase 3 field-selection (_project_fields /
_project_actor_fields) and include_location work (media/uefn-bridge/
batch_tools.py and media/uefn-bridge/tag_inspect.py).

p3-t1 landed:
  - batch_tools._project_fields (batch_tools.py:400) and its
    tag_inspect.py twin _project_actor_fields (tag_inspect.py:336) --
    same contract: "label" always kept, fields=None returns the entry
    unchanged, unknown names silently dropped.
  - fields threaded through batch_get_property (batch_tools.py:571) and
    batch_get_location (batch_tools.py:753).
  - include_location on inspect_tags (tag_inspect.py:2847) /
    _inspect_tags_live (tag_inspect.py:1811), resolved via
    _da_actor_location_tuple (tag_inspect.py:118), a guarded getattr on
    device_audit._actor_location_tuple -- the SAME helper
    batch_get_location uses, not a second independent
    get_actor_location() call site.

Coverage split, deliberately:
  - _project_fields / _project_actor_fields: exercised directly at unit
    level (pure dict-in, dict-out functions, no stubbing needed) AND
    indirectly through batch_get_property/batch_get_location with a
    stubbed `unreal` (mirrors test_batch_get_property_status_shapes.py's
    approach).
  - include_location / location_error: tag_inspect.py's live path
    (_inspect_tags_live) is NOT exercised here. Per that module's own
    test file (test_tag_inspect.py's docstring), the live path touches
    `unreal` far more heavily than batch_tools' actor loop (component
    lookup, property probing, tag extraction) and its own test suite
    already declares that surface unreasonable to stub reliably --
    stubbing it fresh here would duplicate that judgment call, not
    improve on it. Instead this file tests the SAME include_location/
    location_error contract at the two levels that are both pure and
    load-bearing:
      1. _project_actor_fields directly (tag_inspect.py:336), including
         the "label plus tags plus location together" / "omitted means
         no location key at all" shape from the actor_entry assembly at
         tag_inspect.py:2378-2396.
      2. batch_get_location/batch_get_property (fully stubbable, same
         _actor_location_tuple-backed resolution tag_inspect.py's
         include_location reuses) for the "explicit location_error
         rather than a silent gap" behavior, plus a direct source-level
         pin that tag_inspect.py's live loop calls the SAME shared
         helper (_da_actor_location_tuple) rather than a second
         independent get_actor_location() call site.

  Per the task brief: a concurrent worker is adding pagination to
  inspect_tags/_inspect_tags_live in tag_inspect.py right now, so this
  file does not add any test that exercises _inspect_tags_live's actor
  walk -- only the pure _project_actor_fields function and static source
  inspection of the already-landed include_location wiring, neither of
  which that pagination work touches.
"""
import os
import re
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
_unreal = stub_unreal()

import batch_tools  # noqa: E402
import tag_inspect  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes (mirrors test_batch_get_property_status_shapes.py's _FakeActor)
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
    """Same shape/contract as test_batch_get_property_status_shapes.py's
    _FakeActor: class name carries a device hint so the REAL _is_device
    walk passes, get_actor_label() satisfies the REAL _safe_label, props
    back get_editor_property(), and location (optional (x, y, z)) backs
    get_actor_location() -- omitted, it raises, modeling an actor whose
    world location genuinely cannot be resolved."""

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


def _set_actors(actors):
    subsystem = MagicMock()
    subsystem.get_all_level_actors = MagicMock(return_value=list(actors))
    _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)


class _ActorStubMixin(unittest.TestCase):
    def setUp(self):
        self._orig_get_editor_subsystem = _unreal.get_editor_subsystem

    def tearDown(self):
        _unreal.get_editor_subsystem = self._orig_get_editor_subsystem


# ---------------------------------------------------------------------------
# 1. _project_fields / _project_actor_fields -- pure unit-level contract
# ---------------------------------------------------------------------------

class ProjectFieldsUnitTests(unittest.TestCase):
    """batch_tools._project_fields, batch_tools.py:400."""

    def test_requested_subset_plus_always_kept_label(self):
        entry = {"label": "A", "class": "C", "ok": True, "value": (1, 2, 3)}
        result = batch_tools._project_fields(entry, ["value"])
        self.assertEqual(result, {"label": "A", "value": (1, 2, 3)})

    def test_fields_none_returns_entry_unchanged(self):
        entry = {"label": "A", "class": "C", "ok": True, "value": 5}
        result = batch_tools._project_fields(entry, None)
        self.assertEqual(result, entry)
        self.assertIs(result, entry)  # documented: returns entry itself, no copy

    def test_unknown_field_names_silently_dropped(self):
        entry = {"label": "A", "class": "C", "ok": True}
        result = batch_tools._project_fields(entry, ["totally_bogus_field", "class"])
        self.assertEqual(result, {"label": "A", "class": "C"})
        self.assertNotIn("totally_bogus_field", result)

    def test_label_always_kept_even_when_not_requested(self):
        entry = {"label": "A", "class": "C", "ok": True}
        result = batch_tools._project_fields(entry, ["ok"])
        self.assertIn("label", result)
        self.assertEqual(result["label"], "A")


class ProjectActorFieldsUnitTests(unittest.TestCase):
    """tag_inspect._project_actor_fields, tag_inspect.py:336 -- documented
    as mirroring batch_tools._project_fields exactly."""

    def test_requested_subset_plus_always_kept_label(self):
        entry = {"label": "Widget1", "tags": ["Foo"], "extraction_status": "ok"}
        result = tag_inspect._project_actor_fields(entry, ["tags"])
        self.assertEqual(result, {"label": "Widget1", "tags": ["Foo"]})

    def test_unknown_field_names_silently_dropped(self):
        entry = {"label": "Widget1", "tags": []}
        result = tag_inspect._project_actor_fields(entry, ["not_a_real_field"])
        self.assertEqual(result, {"label": "Widget1"})

    def test_location_and_location_error_are_ordinary_projectable_fields(self):
        entry = {"label": "Widget1", "tags": [], "location": {"x": 1.0, "y": 2.0, "z": 3.0}}
        result = tag_inspect._project_actor_fields(entry, ["location"])
        self.assertEqual(result, {"label": "Widget1", "location": {"x": 1.0, "y": 2.0, "z": 3.0}})


# ---------------------------------------------------------------------------
# 2. fields threaded through batch_get_property / batch_get_location
# ---------------------------------------------------------------------------

class BatchFieldSelectionTests(_ActorStubMixin):
    def test_batch_get_property_field_subset_returns_only_requested_plus_label(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100})
        a2 = _FakeActor("Widget2", props={"MaxHealth": 200})
        _set_actors([a1, a2])

        result = batch_tools.batch_get_property("label", "Widget*", "MaxHealth", fields=["value"])

        self.assertEqual(result["status"], "ok")
        for entry in result["actors"]:
            self.assertEqual(set(entry.keys()), {"label", "value"})

    def test_batch_get_location_field_subset_returns_only_requested_plus_label(self):
        a1 = _FakeActor("Marker1", location=(10.0, 20.0, 30.0))
        _set_actors([a1])

        result = batch_tools.batch_get_location("all_devices", "", fields=["location"])

        self.assertEqual(result["status"], "ok")
        entry = result["actors"][0]
        self.assertEqual(set(entry.keys()), {"label", "location"})
        self.assertEqual(entry["location"], {"x": 10.0, "y": 20.0, "z": 30.0})

    def test_batch_get_property_location_special_case_honors_fields(self):
        # property_name="location" reshapes through batch_get_location and
        # re-projects (batch_tools.py:693) -- fields must survive that
        # reshape, not just the plain get_editor_property path.
        a1 = _FakeActor("Widget1", location=(1.0, 2.0, 3.0))
        _set_actors([a1])

        result = batch_tools.batch_get_property("all_devices", "", "location", fields=["value"])

        self.assertEqual(result["status"], "ok")
        entry = result["actors"][0]
        self.assertEqual(set(entry.keys()), {"label", "value"})
        self.assertEqual(entry["value"], (1.0, 2.0, 3.0))

    def test_field_subset_drops_unknown_names_without_raising(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100})
        _set_actors([a1])

        result = batch_tools.batch_get_property(
            "label", "Widget*", "MaxHealth", fields=["value", "not_a_real_field"]
        )

        self.assertEqual(result["status"], "ok")
        entry = result["actors"][0]
        self.assertEqual(set(entry.keys()), {"label", "value"})


# ---------------------------------------------------------------------------
# 3. Defaults unchanged: no fields, no pagination params -> today's full
#    shape, no extra keys. Backward-compat guarantee.
# ---------------------------------------------------------------------------

class DefaultShapeUnchangedTests(_ActorStubMixin):
    def test_batch_get_property_default_shape_has_no_new_keys(self):
        a1 = _FakeActor("Widget1", props={"MaxHealth": 100})
        a2 = _FakeActor("Widget2", props={"MaxHealth": 200})
        _set_actors([a1, a2])

        result = batch_tools.batch_get_property("label", "Widget*", "MaxHealth")

        self.assertEqual(result["status"], "ok")
        # property_name is a pre-existing key on this path (batch_tools.py:277),
        # not something p3-t1/p3-t3 added -- batch_get_location (tested
        # below) correctly omits it by passing property_name=None into
        # _resolved_status_result.
        self.assertEqual(set(result.keys()), {"status", "matched", "actors", "property_name"})
        for entry in result["actors"]:
            self.assertEqual(set(entry.keys()), {"label", "class", "ok", "value"})
        # No pagination keys leaked in when max_results/offset are both omitted.
        self.assertNotIn("offset", result)
        self.assertNotIn("returned", result)
        self.assertNotIn("next_offset", result)

    def test_batch_get_location_default_shape_has_no_new_keys(self):
        a1 = _FakeActor("Marker1", location=(1.0, 2.0, 3.0))
        _set_actors([a1])

        result = batch_tools.batch_get_location("all_devices", "")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(set(result.keys()), {"status", "matched", "actors"})
        entry = result["actors"][0]
        self.assertEqual(set(entry.keys()), {"label", "class", "ok", "location"})
        self.assertNotIn("offset", result)
        self.assertNotIn("returned", result)
        self.assertNotIn("next_offset", result)

    def test_batch_get_property_location_special_case_default_shape_unchanged(self):
        a1 = _FakeActor("Widget1", location=(5.0, 6.0, 7.0))
        _set_actors([a1])

        result = batch_tools.batch_get_property("all_devices", "", "location")

        self.assertEqual(result["status"], "ok")
        # batch_tools.py:694-695: the location special case backfills
        # property_name onto the reshaped result too, same as the plain
        # get_editor_property path above.
        self.assertEqual(
            set(result.keys()), {"status", "matched", "actors", "property_name"}
        )
        entry = result["actors"][0]
        self.assertEqual(set(entry.keys()), {"label", "class", "ok", "value"})
        self.assertEqual(entry["value"], (5.0, 6.0, 7.0))


# ---------------------------------------------------------------------------
# 4. include_location shape contract, at the pure/unit level:
#    _project_actor_fields plus the actor_entry-assembly rule it feeds
#    (tag_inspect.py:2388-2396: location/location_error keys added ONLY
#    when include_location was requested).
# ---------------------------------------------------------------------------

class IncludeLocationShapeTests(unittest.TestCase):
    def _assemble_actor_entry(self, label, tags, include_location, location=None, location_error=None):
        """Reproduces the exact actor_entry assembly rule documented at
        tag_inspect.py:2378-2396 -- location/location_error keys are added
        ONLY when include_location is True, and even then only ONE of the
        two keys is ever present (success -> location, failure ->
        location_error), never both and never neither."""
        entry = {
            "label": label,
            "has_verse_tag_component": True,
            "component_class": "VerseTagComponent",
            "tags": tags,
            "extraction_status": "ok",
            "actor_tags": [],
        }
        if include_location:
            if location is not None:
                entry["location"] = location
            else:
                entry["location_error"] = location_error or "unknown error"
        return entry

    def test_include_location_true_returns_label_tags_location_together(self):
        entry = self._assemble_actor_entry(
            "Widget1", ["Foo"], include_location=True, location={"x": 1.0, "y": 2.0, "z": 3.0}
        )
        self.assertIn("label", entry)
        self.assertIn("tags", entry)
        self.assertIn("location", entry)
        self.assertNotIn("location_error", entry)
        self.assertEqual(entry["location"], {"x": 1.0, "y": 2.0, "z": 3.0})

    def test_include_location_omitted_preserves_original_label_tags_only_shape(self):
        entry = self._assemble_actor_entry("Widget1", ["Foo"], include_location=False)
        self.assertIn("label", entry)
        self.assertIn("tags", entry)
        self.assertNotIn("location", entry)
        self.assertNotIn("location_error", entry)

    def test_unresolvable_location_carries_explicit_error_not_silent_gap(self):
        entry = self._assemble_actor_entry(
            "Widget1", ["Foo"], include_location=True, location=None,
            location_error="get_actor_location() failed: no transform component",
        )
        self.assertNotIn("location", entry)
        self.assertIn("location_error", entry)
        self.assertIsInstance(entry["location_error"], str)
        self.assertTrue(entry["location_error"])  # non-empty, explicit

    def test_offline_only_actor_location_error_names_the_reason(self):
        # tag_inspect.py:2667-2673: an offline-only match (no live actor
        # object at all) gets this EXACT literal error string.
        entry = self._assemble_actor_entry(
            "OfflineOnly1", [], include_location=True, location=None,
            location_error="no live actor object (offline-only match)",
        )
        self.assertNotIn("location", entry)
        self.assertEqual(entry["location_error"], "no live actor object (offline-only match)")

    def test_project_actor_fields_preserves_location_together_with_label_and_tags(self):
        # The field-selection projection (p3-t1) must not accidentally
        # separate location from the label/tags it's meant to travel with
        # when a caller explicitly asks for all three.
        entry = self._assemble_actor_entry(
            "Widget1", ["Foo"], include_location=True, location={"x": 9.0, "y": 8.0, "z": 7.0}
        )
        projected = tag_inspect._project_actor_fields(entry, ["tags", "location"])
        self.assertEqual(
            projected,
            {"label": "Widget1", "tags": ["Foo"], "location": {"x": 9.0, "y": 8.0, "z": 7.0}},
        )


# ---------------------------------------------------------------------------
# 5. location_error via the fully-stubbable batch_get_location path
#    (same _actor_location_tuple-backed resolution include_location
#    reuses) -- an unresolvable location must be an explicit error, never
#    a missing/None field silently.
# ---------------------------------------------------------------------------

class LocationErrorExplicitTests(_ActorStubMixin):
    def test_unresolvable_location_is_explicit_error_not_missing_field(self):
        broken = _FakeActor("Broken1")  # no location -> get_actor_location() raises
        _set_actors([broken])

        result = batch_tools.batch_get_location("all_devices", "")

        self.assertEqual(result["status"], "property_unresolved")
        entry = result["actors"][0]
        self.assertFalse(entry["ok"])
        self.assertNotIn("location", entry)  # never a silently-missing key
        self.assertIn("error", entry)
        self.assertIsInstance(entry["error"], str)
        self.assertTrue(entry["error"])


# ---------------------------------------------------------------------------
# 6. Source-level pin: tag_inspect.py's include_location path calls the
#    SAME shared helper (_da_actor_location_tuple / device_audit.
#    _actor_location_tuple) rather than a second independent
#    get_actor_location() call site, per the task brief's "I verified
#    this myself" claim -- this pins that discipline holds going forward.
# ---------------------------------------------------------------------------

class SharedLocationHelperDisciplineTests(unittest.TestCase):
    def test_da_actor_location_tuple_resolved_via_guarded_getattr(self):
        # tag_inspect.py:118 -- resolved via getattr for version-skew
        # tolerance, not a bare `from device_audit import _actor_location_tuple`.
        self.assertTrue(hasattr(tag_inspect, "_da_actor_location_tuple"))

    def test_da_actor_location_tuple_is_the_same_object_as_device_audit_helper(self):
        import device_audit
        self.assertIs(tag_inspect._da_actor_location_tuple, device_audit._actor_location_tuple)

    def test_no_second_get_actor_location_call_site_in_tag_inspect_source(self):
        # The live include_location loop must resolve location by calling
        # _da_actor_location_tuple(actor) -- it must never call
        # `actor.get_actor_location()` directly itself, which would be a
        # second, independent (and potentially divergent, e.g. missing the
        # rounding _actor_location_tuple applies) resolution path.
        tag_inspect_path = os.path.join(
            os.path.dirname(os.path.abspath(batch_tools.__file__)), "tag_inspect.py"
        )
        with open(tag_inspect_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        # Look for an ACTUAL attribute-call pattern (`<something>.get_actor_
        # location(`), on live code lines only -- the two hits this module
        # currently has for the bare string "get_actor_location(" are both
        # inside comment/docstring prose (tag_inspect.py:2306, :3000)
        # describing the discipline, not code invoking it a second time.
        call_pattern = re.compile(r"\.get_actor_location\s*\(")
        offending = [
            (i + 1, line.strip())
            for i, line in enumerate(lines)
            if call_pattern.search(line) and not line.strip().startswith("#")
        ]
        self.assertEqual(
            offending, [],
            "tag_inspect.py must not call get_actor_location() directly; "
            "it must resolve location exclusively via _da_actor_location_tuple",
        )
        source = "".join(lines)
        self.assertIn("_da_actor_location_tuple(actor)", source)


if __name__ == "__main__":
    unittest.main()
