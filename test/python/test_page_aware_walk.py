"""Tests for the page-aware walk in tag_inspect.inspect_tags() /
_inspect_tags_live() (media/uefn-bridge/tag_inspect.py, p3-t5).

Background: p3-t4 added max_results/offset as PAYLOAD pagination -- it
sliced the RESULT of a walk that had already examined every matched actor
(up to _MAX_ACTORS_EXAMINED=5000). Live measurement against a real
44,753-actor project showed that walk costs ~25.1s FIXED (verse scan +
tag-class discovery + label-matching every actor) plus ~198ms MARGINAL per
actor actually put through the component/property reflection (measured
from a 392-match scan totaling 102.6s) -- so a full uncapped walk is
roughly 2.5 HOURS in one call, and even the pre-existing 5000-actor cap is
~17 minutes, both already hopeless against uefn-server.ts's 180s budget.
p3-t5 inverts this: when max_results/offset is passed, ONLY the actors in
the requested page window are put through the expensive reflection walk
at all -- actors outside the window are never probed in that call. This
file pins that property directly (full-sweep-probes-everyone-exactly-once,
plus out-of-window actors never touched within one call) and confirms the
unparameterized path is untouched.

Mocking approach: full integration through tag_inspect.inspect_tags(),
same harness style as test_tag_inspect.py's ActorLevelTagSourceMergeTests
/ DeepProbeTriggerTests (monkeypatch tag_inspect.unreal/_HAS_UNREAL/
report_path/_get_bridge_dir, point get_all_level_actors() at fake actors).
Fakes track every get_components_by_class() / get_editor_property() probe
call so a test can assert exactly which actors were reflected over in a
given call -- the property that makes a page cheap. project_dir is left
unresolved (no .verse files, no __ExternalActors__ tree) so phase-1/
offline-scan costs stay at their real-world floor and do not interfere
with the walk-selection logic under test; test_tag_inspect.py's own
ActorLevelTagSourceMergeTests/DeepProbeTriggerTests already cover the
verse-tag-decoding content, so this file does not duplicate that -- it
tests WHICH actors get walked, not what gets decoded from them.
"""
import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path  # noqa: E402

ensure_bridge_on_path()
import tag_inspect  # noqa: E402


class _ProbeTrackingActor:
    """Minimal fake actor whose get_components_by_class() and
    get_editor_property("tags") calls are recorded on a shared list
    passed in by the test, so a test can assert exactly which actors
    were reflected over within one inspect_tags() call -- the property
    that makes a page window cheap (out-of-window actors are never
    probed at all, not merely "probed and discarded")."""

    def __init__(self, label, probed_log):
        self._label = label
        self._probed_log = probed_log

    def get_actor_label(self):
        return self._label

    def get_name(self):
        return self._label

    def get_components_by_class(self, _cls):
        # Called by _find_tag_component -- the actual expensive-phase
        # entry point. No components means has_verse_tag_component:False,
        # but the CALL ITSELF is what this test tracks (that call is what
        # ~198ms/actor in the live measurement represents).
        self._probed_log.append(self._label)
        return []

    def get_editor_property(self, name):
        if name == "tags":
            return []
        raise AttributeError(name)


class _PageAwareWalkTestBase(unittest.TestCase):
    """Shared faked-unreal integration harness, matching
    test_tag_inspect.py's ActorLevelTagSourceMergeTests/
    DeepProbeTriggerTests setUp/tearDown exactly (duplicated per this
    file's file-ownership boundary: test_tag_inspect.py is not editable
    by this task)."""

    def setUp(self):
        self._had_unreal_attr = hasattr(tag_inspect, "unreal")
        self._orig_unreal = getattr(tag_inspect, "unreal", None)
        self._orig_has_unreal = tag_inspect._HAS_UNREAL
        self._orig_report_path = tag_inspect.report_path
        self._orig_get_bridge_dir = tag_inspect._get_bridge_dir

        self._scratch = tempfile.mkdtemp(prefix="tag_inspect_page_walk_test_")
        primary = os.path.join(self._scratch, "primary", "tag_inspect_report.json")
        fallback_dir = os.path.join(self._scratch, "fallback")
        os.makedirs(fallback_dir, exist_ok=True)
        tag_inspect.report_path = lambda: primary
        tag_inspect._get_bridge_dir = lambda: fallback_dir

        self._actors = []
        subsystem = types.SimpleNamespace(get_all_level_actors=lambda: self._actors)
        tag_inspect.unreal = types.SimpleNamespace(
            ActorComponent=object(),
            EditorActorSubsystem=object(),
            ScopedSlowTask=lambda total, desc: tag_inspect._NullSlowTask(),
            get_editor_subsystem=lambda cls: subsystem,
            log_warning=lambda *a, **k: None,
            log_error=lambda *a, **k: None,
        )
        tag_inspect._HAS_UNREAL = True

        # No .verse source and no __ExternalActors__ tree resolvable --
        # keeps phase-1/offline-scan noise out of the walk-selection
        # assertions under test. An empty existing temp dir as
        # project_dir satisfies _resolve_verse_dir's isdir check but
        # contains no *.verse files and no __ExternalActors__ subtree.
        self._empty_project_dir = tempfile.mkdtemp(prefix="tag_inspect_empty_project_")

    def tearDown(self):
        if self._had_unreal_attr:
            tag_inspect.unreal = self._orig_unreal
        else:
            del tag_inspect.unreal
        tag_inspect._HAS_UNREAL = self._orig_has_unreal
        tag_inspect.report_path = self._orig_report_path
        tag_inspect._get_bridge_dir = self._orig_get_bridge_dir

    def _make_actors(self, n, probed_log):
        # Deliberately shuffled insertion order (matches
        # test_batch_cursor_pagination.py's _make_actors technique) so a
        # test relying on raw get_all_level_actors() order instead of the
        # label sort would fail -- proving the sort is what makes paging
        # sound.
        actors = [
            _ProbeTrackingActor("Marker{0:03d}".format(i), probed_log)
            for i in range(n)
        ]
        shuffled = actors[::2] + actors[1::2]
        self._actors = shuffled
        return {a.get_actor_label() for a in actors}


# ---------------------------------------------------------------------------
# Load-bearing: out-of-window actors are never probed within one call, and
# a full page-by-page sweep probes every matched actor exactly once.
# ---------------------------------------------------------------------------

class FullSweepProbesEveryActorExactlyOnceTests(_PageAwareWalkTestBase):
    def test_out_of_window_actors_never_probed_in_a_single_call(self):
        probed_log = []
        self._make_actors(23, probed_log)

        result = tag_inspect.inspect_tags(
            label_pattern="Marker*", project_dir=self._empty_project_dir,
            max_results=5, offset=10,
        )

        # Only the 5 actors in the [10,15) window (by label sort order)
        # were ever handed to get_components_by_class -- the expensive
        # reflection entry point this test tracks.
        expected_window = ["Marker{0:03d}".format(i) for i in range(10, 15)]
        self.assertEqual(sorted(probed_log), expected_window)
        self.assertEqual(len(probed_log), 5)
        returned_labels = [a["label"] for a in result["actors"]]
        self.assertEqual(sorted(returned_labels), expected_window)
        self.assertEqual(result["matched"], 23)
        self.assertEqual(result["offset"], 10)
        self.assertEqual(result["returned"], 5)
        self.assertEqual(result["next_offset"], 15)

    def test_full_sweep_across_pages_covers_every_matched_actor_exactly_once(self):
        probed_log = []
        expected_labels = self._make_actors(37, probed_log)

        page_size = 10
        offset = 0
        seen_labels = []
        pages_fetched = 0

        while True:
            result = tag_inspect.inspect_tags(
                label_pattern="Marker*", project_dir=self._empty_project_dir,
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
            self.assertLessEqual(pages_fetched, 10)  # sanity bound

        self.assertEqual(len(seen_labels), 37)
        self.assertEqual(set(seen_labels), expected_labels)
        self.assertEqual(len(seen_labels), len(set(seen_labels)))  # no duplicates
        self.assertEqual(pages_fetched, 4)  # ceil(37/10)

        # Every actor was probed (reflected over) exactly once across the
        # WHOLE sweep, even though each individual call only probed its
        # own page -- this is the cost-avoidance property itself, not
        # just the response shape.
        self.assertEqual(sorted(probed_log), sorted(expected_labels))
        self.assertEqual(len(probed_log), len(set(probed_log)))

    def test_ordering_stable_across_repeated_page_calls(self):
        probed_log = []
        self._make_actors(20, probed_log)

        first = tag_inspect.inspect_tags(
            label_pattern="Marker*", project_dir=self._empty_project_dir,
            max_results=6, offset=0,
        )
        second = tag_inspect.inspect_tags(
            label_pattern="Marker*", project_dir=self._empty_project_dir,
            max_results=6, offset=0,
        )

        first_labels = [a["label"] for a in first["actors"]]
        second_labels = [a["label"] for a in second["actors"]]
        self.assertEqual(first_labels, second_labels)
        self.assertEqual(first_labels, sorted(first_labels))


# ---------------------------------------------------------------------------
# Unparameterized calls stay byte-identical to pre-p3-t5 behavior: the
# _MAX_ACTORS_EXAMINED walk cap applies, every matched actor gets probed
# (no page window), no pagination keys leak in.
# ---------------------------------------------------------------------------

class UnparameterizedBehaviorUnchangedTests(_PageAwareWalkTestBase):
    def test_no_pagination_params_probes_every_matched_actor(self):
        probed_log = []
        expected_labels = self._make_actors(15, probed_log)

        result = tag_inspect.inspect_tags(
            label_pattern="Marker*", project_dir=self._empty_project_dir,
        )

        self.assertEqual(sorted(probed_log), sorted(expected_labels))
        self.assertEqual(len(result["actors"]), 15)
        self.assertEqual(result["scan_stats"]["actors_matched"], 15)
        self.assertEqual(result["scan_stats"]["actors_examined"], 15)
        self.assertFalse(result["scan_stats"]["actors_examined_capped"])
        self.assertFalse(result["truncated"])
        self.assertEqual(result["truncation_reasons"], [])
        # No pagination keys leak into the default (opt-out) path.
        self.assertNotIn("matched", result)
        self.assertNotIn("offset", result)
        self.assertNotIn("next_offset", result)
        self.assertNotIn("returned", result)

    def test_walk_cap_still_applies_when_unparameterized(self):
        # Exercise the walk-cap branch directly at a small scale by
        # temporarily lowering _MAX_ACTORS_EXAMINED -- proves the cap
        # branch (not the paging branch) still fires, and its
        # truncated/truncation_reasons/actors_examined_capped reporting
        # is exactly as before this task.
        probed_log = []
        self._make_actors(10, probed_log)
        orig_cap = tag_inspect._MAX_ACTORS_EXAMINED
        tag_inspect._MAX_ACTORS_EXAMINED = 4
        try:
            result = tag_inspect.inspect_tags(
                label_pattern="Marker*", project_dir=self._empty_project_dir,
            )
        finally:
            tag_inspect._MAX_ACTORS_EXAMINED = orig_cap

        self.assertEqual(len(probed_log), 4)
        self.assertEqual(len(result["actors"]), 4)
        self.assertTrue(result["truncated"])
        self.assertTrue(result["scan_stats"]["actors_examined_capped"])
        self.assertEqual(result["scan_stats"]["actors_matched"], 10)
        self.assertEqual(result["scan_stats"]["actors_examined"], 4)
        self.assertTrue(any("actor-scan cap" in r for r in result["truncation_reasons"]))


# ---------------------------------------------------------------------------
# scan_stats honesty while paging: actors_matched is always the true full
# total; actors_examined reflects only the current page's probes.
# ---------------------------------------------------------------------------

class ScanStatsHonestyWhilePagingTests(_PageAwareWalkTestBase):
    def test_actors_matched_is_true_total_actors_examined_is_page_only(self):
        probed_log = []
        self._make_actors(30, probed_log)

        result = tag_inspect.inspect_tags(
            label_pattern="Marker*", project_dir=self._empty_project_dir,
            max_results=8, offset=16,
        )

        self.assertEqual(result["scan_stats"]["actors_matched"], 30)
        self.assertEqual(result["scan_stats"]["actors_examined"], 8)
        self.assertEqual(result["matched"], 30)
        self.assertEqual(result["returned"], 8)
        self.assertFalse(result["scan_stats"]["actors_examined_capped"])

    def test_walk_cap_does_not_apply_within_a_page_window_larger_than_cap(self):
        # _MAX_ACTORS_EXAMINED lowered below the page size -- proves the
        # walk cap is skipped entirely while paging (the page window is
        # the bound instead), not silently re-applied inside the window.
        probed_log = []
        self._make_actors(12, probed_log)
        orig_cap = tag_inspect._MAX_ACTORS_EXAMINED
        tag_inspect._MAX_ACTORS_EXAMINED = 3
        try:
            result = tag_inspect.inspect_tags(
                label_pattern="Marker*", project_dir=self._empty_project_dir,
                max_results=10, offset=0,
            )
        finally:
            tag_inspect._MAX_ACTORS_EXAMINED = orig_cap

        self.assertEqual(len(probed_log), 10)
        self.assertEqual(len(result["actors"]), 10)
        self.assertFalse(result["scan_stats"]["actors_examined_capped"])


if __name__ == "__main__":
    unittest.main()
