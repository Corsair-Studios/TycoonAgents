"""Tests for the thumbnail PIXEL REVIEW SCOPE fix in moderation_scanner —
user directive: "We should only be scanning the pixels of thumbnails or
images that the project has uploaded — never the ones coming from
Fortnite, Unreal, or anything built into the engine."

Field evidence from a real scan showed 1,948 of 2,098 thumbnail suspects
were reported "unreviewed" purely because of the item cap, even though all
of those suspects lived on Epic-owned shared mounts (never the creator's
own upload) — the same crowding-out failure mode as the earlier HLOD bug,
one layer down (see _is_hlod_or_external_entry's docstring).

Covers two units:
  * ``_is_thumbnail_suspect_project_owned`` (module-level, directly
    callable) — the per-entry classification used to scope the queue.
  * ``run_moderation_scan``'s nested ``_filter_project_owned_suspects``
    closure, which applies that classification to the actual suspect
    lists before they enter the ranked queue — pulled out of the real
    compiled bytecode via ``_bridge_helpers.extract_nested_function``,
    matching the existing pattern in test_suspect_queue_ordering.py, so
    these tests exercise the real shipped logic rather than a
    hand-copied reimplementation that could drift.
  * ``collect_import_provenance``'s pass-through of the ``is_project_owned``
    tag onto its ``items`` output, which the queue filter above depends on.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner, extract_nested_function  # noqa: E402

ms = import_moderation_scanner()


class IsThumbnailSuspectProjectOwnedTests(unittest.TestCase):
    """Direct tests of the module-level classification helper."""

    def test_explicit_is_project_owned_true_wins_regardless_of_package_path(self):
        entry = {"object_path": "/Game/x", "package_path": "/Game/x", "is_project_owned": True}
        self.assertTrue(ms._is_thumbnail_suspect_project_owned(entry, "/MyIsland/"))

    def test_explicit_is_project_owned_false_excludes(self):
        entry = {"object_path": "/MyIsland/x", "package_path": "/MyIsland/x", "is_project_owned": False}
        self.assertFalse(ms._is_thumbnail_suspect_project_owned(entry, "/MyIsland/"))

    def test_package_path_under_mount_is_project_owned(self):
        entry = {"object_path": "/MyIsland/UI/x", "package_path": "/MyIsland/UI/x"}
        self.assertTrue(ms._is_thumbnail_suspect_project_owned(entry, "/MyIsland/"))

    def test_package_path_outside_mount_is_not_project_owned(self):
        entry = {"object_path": "/Game/UI/x", "package_path": "/Game/UI/x"}
        self.assertFalse(ms._is_thumbnail_suspect_project_owned(entry, "/MyIsland/"))

    def test_no_signal_at_all_fails_toward_reviewing(self):
        """An entry with neither an is_project_owned tag nor a package_path
        (e.g. an external_link_risks asset hit, which only carries a
        free-text 'location') must be treated as in-scope by default."""
        entry = {"object_path": "some free-text location"}
        self.assertTrue(ms._is_thumbnail_suspect_project_owned(entry, "/MyIsland/"))

    def test_unresolved_mount_prefix_fails_toward_reviewing(self):
        """package_path present but mount_prefix is None (unresolved) —
        cannot classify, so it must stay in scope, not be excluded."""
        entry = {"object_path": "/Game/x", "package_path": "/Game/x"}
        self.assertTrue(ms._is_thumbnail_suspect_project_owned(entry, None))


def build_filter(mount_scope_confident, project_mount="/MyIsland/"):
    """Rebuild the REAL _filter_project_owned_suspects nested closure (and
    the _entry_key it depends on) from run_moderation_scan's compiled
    bytecode, wired to a fresh excluded-keys set — mirrors
    test_suspect_queue_ordering.py's build_ranker() pattern. Returns
    (filter_fn, excluded_keys_set)."""
    entry_key = extract_nested_function(ms.run_moderation_scan, "_entry_key")
    excluded_keys = set()
    asset_result = {"project_mount": project_mount}
    filter_fn = extract_nested_function(
        ms.run_moderation_scan, "_filter_project_owned_suspects",
        extra_closure={
            "_mount_scope_confident": mount_scope_confident,
            "asset_result": asset_result,
            "_epic_mount_excluded_keys": excluded_keys,
            "_entry_key": entry_key,
        },
    )
    return filter_fn, excluded_keys


class FilterProjectOwnedSuspectsTests(unittest.TestCase):
    """The real suspect-queue filter closure, confident-mount case: Epic-
    owned/shared-mount entries must be dropped from the queue AND counted
    in the exclusion set; project-mount entries must survive untouched."""

    def test_epic_mount_suspects_excluded_and_counted(self):
        filter_fn, excluded = build_filter(mount_scope_confident=True)
        entries = [
            {"object_path": "/MyIsland/Tex/keep_me", "package_path": "/MyIsland/Tex/keep_me"},
            {"object_path": "/Game/Tex/epic_owned", "package_path": "/Game/Tex/epic_owned"},
        ]
        kept = filter_fn(entries)
        self.assertEqual(kept, [entries[0]])
        self.assertEqual(excluded, {"/Game/Tex/epic_owned"})

    def test_import_provenance_shaped_entries_use_is_project_owned_tag(self):
        """import_provenance items carry no package_path — only the
        is_project_owned tag propagated from collect_asset_surfaces."""
        filter_fn, excluded = build_filter(mount_scope_confident=True)
        entries = [
            {"object_path": "/MyIsland/Import/x", "is_project_owned": True},
            {"object_path": "/Game/Import/y", "is_project_owned": False},
        ]
        kept = filter_fn(entries)
        self.assertEqual(kept, [entries[0]])
        self.assertEqual(excluded, {"/Game/Import/y"})

    def test_all_project_mount_suspects_survive_uncapped_by_this_filter(self):
        filter_fn, excluded = build_filter(mount_scope_confident=True)
        entries = [
            {"object_path": f"/MyIsland/Tex/{i}", "package_path": f"/MyIsland/Tex/{i}"}
            for i in range(25)
        ]
        kept = filter_fn(entries)
        self.assertEqual(len(kept), 25)
        self.assertEqual(excluded, set())

    def test_ambiguous_mount_scope_keeps_everything_in_scope(self):
        """mount_scope_confident=False (unresolved, or only a folder-name
        guess) must fail toward reviewing — NOTHING is excluded, even
        entries that would classify as shared/Epic-owned if the mount were
        trusted."""
        filter_fn, excluded = build_filter(mount_scope_confident=False)
        entries = [
            {"object_path": "/MyIsland/Tex/a", "package_path": "/MyIsland/Tex/a"},
            {"object_path": "/Game/Tex/b", "package_path": "/Game/Tex/b"},
            {"object_path": "/Game/Import/c", "is_project_owned": False},
        ]
        kept = filter_fn(entries)
        self.assertEqual(kept, entries)
        self.assertEqual(excluded, set())

    def test_empty_input_returns_empty_list(self):
        filter_fn, excluded = build_filter(mount_scope_confident=True)
        self.assertEqual(filter_fn([]), [])
        self.assertEqual(filter_fn(None), [])
        self.assertEqual(excluded, set())


class CollectImportProvenanceProjectOwnedTagTests(unittest.TestCase):
    """collect_import_provenance must pass the is_project_owned tag from
    each raw import_source_record straight through onto the matching
    items entry, so the thumbnail-suspect filter above can use it."""

    def test_project_owned_flag_propagates_true(self):
        records = [{
            "object_path": "/MyIsland/UI/qr_asset.qr_asset",
            "display_name": "qr_asset",
            "package_name": "/MyIsland/UI/qr_asset",
            "source_path": "../../../../../../Users/someuser/Downloads/qr_asset.png",
            "file_md5": "abc", "timestamp": "1",
            "is_project_owned": True,
        }]
        prov = ms.collect_import_provenance(records, project_dir=r"D:\MyIsland")
        self.assertEqual(len(prov["items"]), 1)
        self.assertTrue(prov["items"][0]["is_project_owned"])

    def test_project_owned_flag_propagates_false(self):
        records = [{
            "object_path": "/Game/UI/epic_asset.epic_asset",
            "display_name": "epic_asset",
            "package_name": "/Game/UI/epic_asset",
            "source_path": "../../../../../../Users/someuser/Downloads/epic_asset.png",
            "file_md5": "abc", "timestamp": "1",
            "is_project_owned": False,
        }]
        prov = ms.collect_import_provenance(records, project_dir=r"D:\MyIsland")
        self.assertEqual(len(prov["items"]), 1)
        self.assertFalse(prov["items"][0]["is_project_owned"])

    def test_missing_flag_defaults_true_fail_toward_reviewing(self):
        """A record with no is_project_owned key at all (e.g. an older
        caller/fixture) must default to True — ambiguous must never mean
        silently excluded."""
        records = [{
            "object_path": "/MyIsland/UI/qr_asset.qr_asset",
            "display_name": "qr_asset",
            "package_name": "/MyIsland/UI/qr_asset",
            "source_path": "../../../../../../Users/someuser/Downloads/qr_asset.png",
            "file_md5": "abc", "timestamp": "1",
        }]
        prov = ms.collect_import_provenance(records, project_dir=r"D:\MyIsland")
        self.assertEqual(len(prov["items"]), 1)
        self.assertTrue(prov["items"][0]["is_project_owned"])


if __name__ == "__main__":
    unittest.main()
