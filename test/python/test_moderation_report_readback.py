"""Tests for the moderation-report save round-trip VERIFICATION added on top
of the "honest save" fix (see test_honest_save.py): after
``_handle_moderation_report_save`` writes the file(s), it re-reads through
the shared ``_read_moderation_report`` primitive and confirms the content
actually round-tripped (``generated_at`` + ``len(report)`` match) before
reporting success. A write that lands on disk but can't be read back
correctly (or reads back with different content) must not be reported as a
verified save.

This file extends test_honest_save.py's coverage rather than duplicating
it: that file covers the write/fallback/failure paths of
``_write_json_checked`` and ``_handle_moderation_report_save``'s
paths_written/paths_failed bookkeeping. This file covers the NEW
``_read_moderation_report`` primitive itself and the save handler's
post-write verification step (missing / unparseable / mismatched
read-back), plus the read handler's delegation contract.
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_uefn_bridge  # noqa: E402

bridge = import_uefn_bridge()


def _reset_dirs():
    scratch = tempfile.mkdtemp(prefix="modreport_readback_test_")
    primary_dir = os.path.join(scratch, "primary")
    fallback_dir = os.path.join(scratch, "fallback")
    os.makedirs(primary_dir)
    os.makedirs(fallback_dir)
    return scratch, primary_dir, fallback_dir


class ModerationReportReadbackTests(unittest.TestCase):
    def setUp(self):
        self.scratch, self.primary_dir, self.fallback_dir = _reset_dirs()
        self._orig_report_path = bridge._moderation_report_path
        self._orig_bridge_dir = bridge._get_bridge_dir
        self._orig_read_primitive = bridge._read_moderation_report
        bridge._moderation_report_path = lambda: os.path.join(self.primary_dir, "moderation_report.json")
        bridge._get_bridge_dir = lambda: self.fallback_dir

    def tearDown(self):
        bridge._moderation_report_path = self._orig_report_path
        bridge._get_bridge_dir = self._orig_bridge_dir
        bridge._read_moderation_report = self._orig_read_primitive
        shutil.rmtree(self.scratch, ignore_errors=True)

    def _assert_no_success_shape(self, result):
        """Shared assertion for every failure case: a failed verification
        must never carry verified=True or saved=True (the honest-save
        invariant extended to the round-trip check)."""
        self.assertIsNot(result.get("saved"), True)
        self.assertIsNot(result.get("verified"), True)

    # -- 1. Happy path -----------------------------------------------------

    def test_happy_path_verified_true_and_read_round_trips(self):
        result = bridge._handle_moderation_report_save(
            {"report": "All clear.", "summary": "0 findings", "severity_counts": {"INFO": 1}}
        )
        self.assertTrue(result["saved"])
        self.assertTrue(result["verified"])
        self.assertNotIn("error", result)

        read = bridge._handle_moderation_report_read({})
        self.assertTrue(read["exists"])
        self.assertEqual(read["report"], "All clear.")
        self.assertEqual(read["generated_at"], result["generated_at"])

    # -- 2. Read-back missing ------------------------------------------------

    def test_readback_missing_reports_unverified_failure(self):
        bridge._read_moderation_report = lambda: (None, None)
        result = bridge._handle_moderation_report_save(
            {"report": "Body.", "summary": "s", "severity_counts": {}}
        )
        self._assert_no_success_shape(result)
        self.assertFalse(result["saved"])
        self.assertFalse(result["verified"])
        self.assertIn("error", result)
        self.assertIn("missing", result["error"])
        self.assertIn(self.primary_dir, result["error"])

    # -- 3. Read-back unparseable --------------------------------------------

    def test_readback_unparseable_reports_unverified_failure(self):
        bridge._read_moderation_report = lambda: (None, "moderation_report.json exists but could not be parsed")
        result = bridge._handle_moderation_report_save(
            {"report": "Body.", "summary": "s", "severity_counts": {}}
        )
        self._assert_no_success_shape(result)
        self.assertFalse(result["saved"])
        self.assertFalse(result["verified"])
        self.assertIn("could not be parsed", result["error"])

    # -- 4. Read-back mismatch ------------------------------------------------

    def test_readback_mismatch_reports_unverified_failure(self):
        bridge._read_moderation_report = lambda: (
            {"generated_at": "1999-01-01 00:00:00", "report": "stale different content"},
            None,
        )
        result = bridge._handle_moderation_report_save(
            {"report": "Fresh report body.", "summary": "s", "severity_counts": {}}
        )
        self._assert_no_success_shape(result)
        self.assertFalse(result["saved"])
        self.assertFalse(result["verified"])
        self.assertIn("mismatch", result["error"])

    def test_readback_mismatch_on_length_only_still_flagged(self):
        """generated_at can match while report length still diverges (e.g.
        a torn/partial re-read) -- either mismatch alone must fail. Pin
        bridge.time.strftime so the save handler's generated_at is known
        ahead of time and can be echoed back unchanged by the read-back
        stub, isolating the mismatch to report length only."""
        import time

        fixed_time = time.strftime("%Y-%m-%d %H:%M:%S")
        real_strftime = bridge.time.strftime
        bridge.time.strftime = lambda *a, **k: fixed_time
        bridge._read_moderation_report = lambda: (
            {"generated_at": fixed_time, "report": "short"},
            None,
        )
        try:
            result = bridge._handle_moderation_report_save(
                {"report": "A much longer fresh report body than 'short'.", "summary": "s", "severity_counts": {}}
            )
        finally:
            bridge.time.strftime = real_strftime

        self._assert_no_success_shape(result)
        self.assertFalse(result["saved"])
        self.assertIn("mismatch", result["error"])

    # -- 5. Delegation: read handler mirrors the primitive exactly ----------

    def test_read_handler_delegates_found_case_verbatim(self):
        bridge._read_moderation_report = lambda: (
            {"generated_at": "2026-01-01 00:00:00", "summary": "s", "severity_counts": {}, "report": "Body text."},
            None,
        )
        result = bridge._handle_moderation_report_read({})
        self.assertTrue(result["exists"])
        self.assertEqual(result["report"], "Body text.")
        self.assertEqual(result["generated_at"], "2026-01-01 00:00:00")
        self.assertNotIn("error", result)

    def test_read_handler_delegates_legitimately_absent_case_without_error(self):
        """(None, None) from the primitive means 'nothing saved yet' -- the
        read handler's contract says this is NOT an error case."""
        bridge._read_moderation_report = lambda: (None, None)
        result = bridge._handle_moderation_report_read({})
        self.assertEqual(result, {"exists": False})
        self.assertNotIn("error", result)

    def test_read_handler_delegates_unparseable_case_as_error(self):
        bridge._read_moderation_report = lambda: (None, "some path exists but could not be parsed")
        result = bridge._handle_moderation_report_read({})
        self.assertFalse(result["exists"])
        self.assertEqual(result["error"], "some path exists but could not be parsed")


if __name__ == "__main__":
    unittest.main()
