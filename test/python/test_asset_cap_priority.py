"""Tests for moderation_scanner._make_asset_cap_priority_tier_fn and
_cap_items_with_priority — the priority-inversion fix. The OLD behavior
prioritized HLOD/External-Actor entries INTO a max_items sample; on a real
48,412-asset project only ~200 items survived and exactly ONE human-authored
name was legible. The fix demotes HLOD/external-actor entries to tier 3
(last) and promotes import-provenance/external-link hits to tiers 0/1.

Ported from test_followup.py's TASK 2/TASK 3 and test_review_fixes.py's
FINDING 2.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner  # noqa: E402

ms = import_moderation_scanner()


class PriorityInversionTests(unittest.TestCase):
    """The core regression: an import-risk asset placed LAST in the raw
    collection order must still survive a small cap AHEAD of thousands of
    HLOD entries, because priority (not position) decides what's kept."""

    def test_imported_asset_survives_cap_over_10000_hlod_entries(self):
        hlod_entries = [
            {"object_path": f"/MyIsland/HLOD/HLOD_Cell_{i}.HLOD_Cell_{i}",
             "package_path": f"/MyIsland/HLOD/HLOD_Cell_{i}", "package_name": f"/MyIsland/HLOD/HLOD_Cell_{i}",
             "display_name": f"HLOD_Cell_{i}"}
            for i in range(10000)
        ]
        imported_asset = {
            "object_path": "/MyIsland/UI/ScoreBoard/qr_asset.qr_asset",
            "package_path": "/MyIsland/UI/ScoreBoard", "package_name": "/MyIsland/UI/ScoreBoard/qr_asset",
            "display_name": "qr_asset",
        }
        all_entries = hlod_entries + [imported_asset]  # imported LAST on purpose

        tier_fn = ms._make_asset_cap_priority_tier_fn({imported_asset["object_path"]}, set())
        capped, kept, omitted, full = ms._cap_items_with_priority(all_entries, 200, priority_key=tier_fn)

        self.assertIn(imported_asset, capped)
        self.assertEqual(capped[0]["object_path"], imported_asset["object_path"])
        self.assertEqual(full, 10001)
        self.assertEqual(kept, 200)

    def test_external_link_hit_survives_shared_mount_cap(self):
        shared_items = [
            {"object_path": f"/Game/Bar{i}", "package_path": f"/Game/Bar{i}", "package_name": f"/Game/Bar{i}"}
            for i in range(300)
        ]
        import_hit = {"object_path": "/Game/ImportedSuspect", "package_path": "/Game/ImportedSuspect", "package_name": "/Game/ImportedSuspect"}
        shared_items_with_hit = shared_items + [import_hit]  # placed at the END

        tier_fn = ms._make_asset_cap_priority_tier_fn({import_hit["object_path"]}, set())
        capped, kept, omitted, full = ms._cap_items_with_priority(shared_items_with_hit, 50, priority_key=tier_fn)

        self.assertIn(import_hit, capped)
        self.assertEqual(capped[0]["object_path"], import_hit["object_path"])

    def test_hlod_and_external_actor_demoted_to_tier_3(self):
        tier_fn = ms._make_asset_cap_priority_tier_fn(set(), set())
        hlod_entry = {"object_path": "/Game/HLOD/Cell_1", "package_path": "/Game/HLOD/Cell_1", "package_name": "/Game/HLOD/Cell_1"}
        external_actor_entry = {"object_path": "/Game/__ExternalActors__/Foo", "package_path": "/Game/__ExternalActors__/Foo", "package_name": "/Game/__ExternalActors__/Foo"}
        ordinary_entry = {"object_path": "/Game/BP_Thing", "package_path": "/Game/BP_Thing", "package_name": "/Game/BP_Thing"}
        self.assertEqual(tier_fn(hlod_entry), 3)
        self.assertEqual(tier_fn(external_actor_entry), 3)
        self.assertEqual(tier_fn(ordinary_entry), 2)

    def test_import_risk_tier_0_outranks_external_link_tier_1(self):
        entry = {"object_path": "/Game/Both", "package_path": "/Game/Both", "package_name": "/Game/Both"}
        tier_fn = ms._make_asset_cap_priority_tier_fn({entry["object_path"]}, {entry["object_path"]})
        self.assertEqual(tier_fn(entry), 0)


class SharedMountBudgetScopingTests(unittest.TestCase):
    """Shared/base-mount assets only get whatever sample budget the
    project's own assets didn't use — computed as leftover, not an equal
    split."""

    def test_shared_budget_is_leftover_after_project_assets(self):
        project_items = [{"object_path": f"/MyIsland/Foo{i}"} for i in range(150)]
        shared_items = [{"object_path": f"/Game/Bar{i}"} for i in range(300)]
        capped_p, kept_p, _, _ = ms._cap_items_with_priority(project_items, 200)
        remaining = max(0, 200 - kept_p)
        capped_s, kept_s, _, _ = ms._cap_items_with_priority(shared_items, remaining)
        self.assertEqual(kept_p, 150)
        self.assertEqual(remaining, 50)
        self.assertEqual(kept_s, 50)


class CapItemsWithPriorityBasicsTests(unittest.TestCase):
    def test_list_within_cap_returned_unchanged(self):
        items = [{"object_path": f"/a/{i}"} for i in range(5)]
        capped, kept, omitted, full = ms._cap_items_with_priority(items, 200)
        self.assertEqual(capped, items)
        self.assertEqual(omitted, 0)
        self.assertEqual(kept, 5)
        self.assertEqual(full, 5)

    def test_none_max_items_returns_unchanged(self):
        items = [{"object_path": f"/a/{i}"} for i in range(500)]
        capped, kept, omitted, full = ms._cap_items_with_priority(items, None)
        self.assertEqual(capped, items)

    def test_positional_sample_without_priority_key(self):
        items = [{"object_path": f"/a/{i}"} for i in range(10)]
        capped, kept, omitted, full = ms._cap_items_with_priority(items, 3)
        self.assertEqual(kept, 3)
        self.assertEqual(omitted, 7)
        self.assertEqual(full, 10)
        self.assertEqual([c["object_path"] for c in capped], ["/a/0", "/a/1", "/a/2"])


if __name__ == "__main__":
    unittest.main()
