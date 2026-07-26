"""Tests for the suspect-queue ranking logic inside
moderation_scanner.run_moderation_scan — the "discord_QR sorted last, a
human had to recover it manually" regression, and the follow-up
review-finding fix where one collector's duplicate hits (asset_name +
asset_path for the same asset) were double-counting a SINGLE collector's
signal into signal_count=2, enough to outrank a genuinely distinct
import_provenance hit.

This ranking logic is implemented as nested functions/inline code closed
over local state inside run_moderation_scan itself (see that function's
"BUG FIX (coverage regression...)" block comment) — it is deliberately not
a module-level export (task constraint: no implementation changes for
testability). _bridge_helpers.extract_nested_function pulls the REAL
compiled `_entry_key`/`_dedupe_collector_hits`/`_add_collector_hits`
nested functions out of run_moderation_scan's bytecode and rebuilds them
as standalone callables, so these tests exercise the actual shipped logic
byte-for-byte rather than a hand-copied reimplementation that could drift.

The final ranking sort (moderation_scanner.py, run_moderation_scan, around
lines 3179-3183) is three lines of inline code, not itself a nested `def`,
so it cannot be extracted the same way; it is mirrored verbatim below with
a comment pointing at the source. If that literal sort key ever changes
without this test being updated, this file will not automatically catch
the drift — see the KNOWN LIMITATION note in this session's final report.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner, extract_nested_function  # noqa: E402

ms = import_moderation_scanner()


def build_ranker():
    """Rebuild the real _entry_key / _dedupe_collector_hits /
    _add_collector_hits nested functions from run_moderation_scan's
    compiled bytecode, wired to a fresh shared _suspect_records /
    _suspect_order pair, and return (add_collector_hits, suspect_records,
    suspect_order, dedupe_collector_hits)."""
    entry_key = extract_nested_function(ms.run_moderation_scan, "_entry_key")
    dedupe_collector_hits = extract_nested_function(
        ms.run_moderation_scan, "_dedupe_collector_hits", extra_closure={"_entry_key": entry_key}
    )
    suspect_records = {}
    suspect_order = []
    add_collector_hits = extract_nested_function(
        ms.run_moderation_scan, "_add_collector_hits",
        extra_closure={"_suspect_records": suspect_records, "_suspect_order": suspect_order},
    )
    return add_collector_hits, suspect_records, suspect_order, dedupe_collector_hits


def rank(suspect_records, suspect_order):
    """Mirrors moderation_scanner.py's run_moderation_scan, lines ~3179-3183
    verbatim (inline code, not a nested `def`, so it cannot be bytecode-
    extracted the same way as the functions above)."""
    ranked_keys = sorted(
        suspect_order,
        key=lambda k: (-suspect_records[k]["signal_count"], suspect_records[k]["best_tier"]),
    )
    return [suspect_records[k]["entry"] for k in ranked_keys]


class DedupeCollectorHitsTests(unittest.TestCase):
    """Direct test of the real _dedupe_collector_hits nested function: one
    collector emitting TWO raw items for the SAME asset (e.g. asset_name +
    asset_path, both carrying the same object_path) must collapse to ONE
    deduped entry — this is the review-finding fix (a single collector's
    duplicate items must not manufacture signal_count=2)."""

    def test_duplicate_items_for_same_key_collapse_to_one(self):
        _entry_key = extract_nested_function(ms.run_moderation_scan, "_entry_key")
        dedupe = extract_nested_function(
            ms.run_moderation_scan, "_dedupe_collector_hits", extra_closure={"_entry_key": _entry_key}
        )
        items = [
            {"object_path": "/Game/qr_asset", "package_name": "/Game/qr_asset", "display_name": "qr_asset (name)"},
            {"object_path": "/Game/qr_asset", "package_name": "/Game/qr_asset", "display_name": "qr_asset (path)"},
        ]
        deduped = dedupe(items)
        self.assertEqual(len(deduped), 1)
        self.assertIn("/Game/qr_asset", deduped)

    def test_distinct_keys_all_survive(self):
        _entry_key = extract_nested_function(ms.run_moderation_scan, "_entry_key")
        dedupe = extract_nested_function(
            ms.run_moderation_scan, "_dedupe_collector_hits", extra_closure={"_entry_key": _entry_key}
        )
        items = [{"object_path": f"/Game/a{i}"} for i in range(5)]
        deduped = dedupe(items)
        self.assertEqual(len(deduped), 5)


class SuspectQueueRankingTests(unittest.TestCase):
    """The discord_QR regression: a multi-signal asset placed near the END
    of a 2,300-entry filler list must rank FIRST once ranked by
    (signal_count desc, best_tier asc) — position in the raw collection
    order must not matter."""

    def test_multi_signal_asset_sorts_first_despite_being_added_last(self):
        add_hits, records, order, dedupe = build_ranker()

        hlod_like = [
            {"object_path": f"/MyIsland/Filler/Suspect_{i}", "package_name": f"/MyIsland/Filler/Suspect_{i}",
             "display_name": f"Suspect_{i}"}
            for i in range(2300)
        ]
        multi_signal = {
            "object_path": "/MyIsland/UI/ScoreBoard/qr_asset",
            "package_name": "/MyIsland/UI/ScoreBoard/qr_asset",
            "display_name": "qr_asset",
        }

        # tier 0: import_provenance hit
        add_hits(dedupe([multi_signal]), 0)
        # tier 1: external_link_risks hit on the SAME asset (2nd independent
        # collector -> signal_count becomes 2)
        add_hits(dedupe([{"object_path": multi_signal["object_path"], "package_name": multi_signal["object_path"], "display_name": multi_signal["object_path"]}]), 1)
        # tier 2: 2,300 single-signal filler suspects, added LAST
        add_hits(dedupe(hlod_like), 2)

        self.assertEqual(records[multi_signal["object_path"]]["signal_count"], 2)
        ranked = rank(records, order)
        self.assertEqual(len(ranked), 2301)
        self.assertEqual(ranked[0]["object_path"], multi_signal["object_path"])

    def test_single_collectors_duplicate_hits_do_not_outrank_distinct_collector_hit(self):
        """Discriminating case: asset X gets 2 RAW items from the SAME
        collector (asset_name + asset_path, same object_path) -> after
        per-collector dedup that is signal_count=1. Asset Y gets ONE hit
        each from TWO DISTINCT collectors -> signal_count=2. Y must rank
        strictly ahead of X."""
        add_hits, records, order, dedupe = build_ranker()

        asset_x_dupes = [
            {"object_path": "/Game/AssetX", "package_name": "/Game/AssetX", "display_name": "AssetX (name)"},
            {"object_path": "/Game/AssetX", "package_name": "/Game/AssetX", "display_name": "AssetX (path)"},
        ]
        asset_y = {"object_path": "/Game/AssetY", "package_name": "/Game/AssetY", "display_name": "AssetY"}

        # Collector A (tier 1, e.g. external_link_risks) emits BOTH duplicate
        # X items AND one Y item, in the SAME dedup pass (matching how
        # run_moderation_scan builds _link_asset_hits as one combined list).
        add_hits(dedupe(asset_x_dupes + [asset_y]), 1)
        # Collector B (tier 0, e.g. import_provenance) emits Y again.
        add_hits(dedupe([asset_y]), 0)

        self.assertEqual(records["/Game/AssetX"]["signal_count"], 1)
        self.assertEqual(records["/Game/AssetY"]["signal_count"], 2)
        ranked = rank(records, order)
        self.assertEqual(ranked[0]["object_path"], "/Game/AssetY")

    def test_display_name_preferred_from_entry_that_has_one(self):
        """_add_collector_hits keeps whichever entry carries a real
        display_name, so the written thumbnail filename stays readable
        regardless of which collector's entry happened to win the merge."""
        add_hits, records, order, dedupe = build_ranker()
        no_name_entry = {"object_path": "/Game/Asset", "package_name": "/Game/Asset", "display_name": ""}
        named_entry = {"object_path": "/Game/Asset", "package_name": "/Game/Asset", "display_name": "Asset"}

        add_hits(dedupe([no_name_entry]), tier=2)
        add_hits(dedupe([named_entry]), tier=0)

        self.assertEqual(records["/Game/Asset"]["entry"]["display_name"], "Asset")
        self.assertEqual(records["/Game/Asset"]["best_tier"], 0)


if __name__ == "__main__":
    unittest.main()
