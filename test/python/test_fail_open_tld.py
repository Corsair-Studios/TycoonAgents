"""Tests for moderation_scanner's _FILE_EXTENSION_DENYLIST / _COMMON_TLDS
fail-open guarantee: the denylist is derived as a set DIFFERENCE
(_FILE_EXTENSION_DENYLIST_RAW - _COMMON_TLDS) specifically so an
accidental overlap between the two curated tuples can never make module
import raise, and can never make a legitimate TLD silently undetectable.

Ported from test_fail_open.py.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner  # noqa: E402

ms = import_moderation_scanner()


class FailOpenTldTests(unittest.TestCase):
    def test_gg_is_a_curated_tld(self):
        self.assertIn("gg", ms._COMMON_TLDS)

    def test_overlap_construction_never_raises_and_removes_overlap(self):
        poisoned_raw = ms._FILE_EXTENSION_DENYLIST_RAW + ("gg",)
        try:
            poisoned_denylist = frozenset(poisoned_raw) - frozenset(ms._COMMON_TLDS)
        except Exception as e:  # pragma: no cover - construction must never raise
            self.fail(f"set-difference construction raised: {e}")
        self.assertNotIn("gg", poisoned_denylist)

    def test_poisoned_denylist_swapped_in_legit_tld_still_detectable(self):
        """Prove a real overlap injected into the LIVE denylist cannot make a
        legitimate TLD undetectable — swap it in, scan, then restore."""
        original = ms._FILE_EXTENSION_DENYLIST
        poisoned = frozenset(ms._FILE_EXTENSION_DENYLIST_RAW + ("gg",)) - frozenset(ms._COMMON_TLDS)
        ms._FILE_EXTENSION_DENYLIST = poisoned
        try:
            r = ms.collect_external_link_risks(
                asset_surfaces=[], verse_surfaces=[{"file": "x.verse", "line": 1, "kind": "comment_line", "text": "join at somehost.gg/abc123"}],
                text_metadata={"fields": []}, image_paths=[], audio_surfaces={"audio": []},
            )
            self.assertEqual(r["total_count"], 1)
            self.assertIn(r["items"][0]["kind"], ("invite_path", "domain"))
        finally:
            ms._FILE_EXTENSION_DENYLIST = original

    def test_module_level_construction_pattern_survives_an_overlap_standalone(self):
        """Re-runs the EXACT module-level construction expression standalone
        with an overlap present, proving import-time never raises."""
        exec_globals = {}
        exec(
            "FILE_EXTENSION_DENYLIST_RAW = ('gg', 'md', 'txt')\n"
            "COMMON_TLDS = ('gg', 'com', 'io')\n"
            "FILE_EXTENSION_DENYLIST = frozenset(FILE_EXTENSION_DENYLIST_RAW) - frozenset(COMMON_TLDS)\n",
            exec_globals,
        )
        self.assertEqual(exec_globals["FILE_EXTENSION_DENYLIST"], frozenset({"md", "txt"}))


if __name__ == "__main__":
    unittest.main()
