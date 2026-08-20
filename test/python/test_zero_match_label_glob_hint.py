"""Tests for the zero_match glob-hint added to
batch_tools._zero_match_result() (media/uefn-bridge/batch_tools.py, ~177).

Background: a live test against a real 44,753-actor UEFN project showed
filter_type="label", filter_value="SGMarker" returns zero_match, while
filter_value="*SGMarker*" matches 392 actors. Root cause: filter_type
"label" matches via fnmatch glob (batch_tools.py:138), not substring, so a
bare label value only matches an actor whose label is EXACTLY that string.
filter_type "class" IS a substring match (batch_tools.py:133) -- a
different, asymmetric rule for the same-shaped argument.

These tests pin that _zero_match_result's "reason" text:
  1. appends fnmatch-glob guidance, built from the caller's own
     filter_value, when filter_type=="label" and filter_value has no
     fnmatch wildcard character (*, ?, [)
  2. does NOT append that guidance when filter_value already has a
     wildcard (the caller already knows about globs)
  3. does NOT append that guidance for filter_type=="class" (genuinely a
     substring match -- telling that caller to add wildcards is wrong)

Called directly at the unit level (rather than only through
batch_get_property/batch_set_property) since the hint logic lives entirely
inside the shared helper and does not depend on `unreal` state.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
stub_unreal()

import batch_tools  # noqa: E402


class ZeroMatchLabelGlobHintTests(unittest.TestCase):

    def test_bare_label_value_gets_wildcarded_suggestion(self):
        result = batch_tools._zero_match_result("label", "SGMarker", verb="read")

        self.assertEqual(result["status"], "zero_match")
        self.assertIn("fnmatch", result["reason"])
        self.assertIn("glob", result["reason"])
        self.assertIn("*SGMarker*", result["reason"])

    def test_bare_label_value_hint_reads_correctly_for_set_verb(self):
        result = batch_tools._zero_match_result("label", "SGMarker", verb="set")

        self.assertIn("never set", result["reason"])
        self.assertIn("*SGMarker*", result["reason"])

    def test_label_value_with_star_wildcard_gets_no_hint(self):
        result = batch_tools._zero_match_result("label", "*SGMarker*", verb="read")

        self.assertNotIn("fnmatch", result["reason"])
        self.assertNotIn("glob", result["reason"])

    def test_label_value_with_question_wildcard_gets_no_hint(self):
        result = batch_tools._zero_match_result("label", "SGMarker?", verb="read")

        self.assertNotIn("fnmatch", result["reason"])

    def test_label_value_with_bracket_wildcard_gets_no_hint(self):
        result = batch_tools._zero_match_result("label", "SGMarker[0-9]", verb="read")

        self.assertNotIn("fnmatch", result["reason"])

    def test_class_filter_never_gets_glob_hint(self):
        result = batch_tools._zero_match_result("class", "SGMarker", verb="read")

        self.assertNotIn("fnmatch", result["reason"])
        self.assertNotIn("glob", result["reason"])

    def test_all_devices_filter_never_gets_glob_hint(self):
        result = batch_tools._zero_match_result("all_devices", "", verb="read")

        self.assertNotIn("fnmatch", result["reason"])
        self.assertNotIn("glob", result["reason"])

    def test_base_reason_text_still_present_alongside_hint(self):
        # The added hint must not replace the original explanation that the
        # property was never read/set -- it appends to it.
        result = batch_tools._zero_match_result("label", "SGMarker", verb="read")

        self.assertIn("No actors matched", result["reason"])
        self.assertIn("was never read", result["reason"])


if __name__ == "__main__":
    unittest.main()
