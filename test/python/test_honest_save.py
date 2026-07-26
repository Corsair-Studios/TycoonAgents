"""Tests for uefn_bridge.py's _write_json_checked and
_handle_moderation_report_save — the "honest save" fix. Before this fix, a
swallowed write exception was still reported as saved:True, leaving a
creator staring at "No analysed report yet" with zero error surfaced
anywhere but the Unreal log.

Ported from verify_moderation_save.py's cases 0-4 (case 0 reproduces the
ORIGINAL bug against a faithful copy of the old swallow-exception code, to
document what "honest" is being verified against — it does not call
production code).
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_uefn_bridge  # noqa: E402

bridge = import_uefn_bridge()


def _reset_dirs():
    scratch = tempfile.mkdtemp(prefix="modreport_test_")
    primary_dir = os.path.join(scratch, "primary")
    fallback_dir = os.path.join(scratch, "fallback")
    os.makedirs(primary_dir)
    os.makedirs(fallback_dir)
    return scratch, primary_dir, fallback_dir


class OriginalBugReproductionTests(unittest.TestCase):
    """Documents the bug being fixed: a faithful copy of the OLD
    (pre-fix) _write_json — swallow-exception, no verification — reports
    saved:True even when nothing was written. This does not exercise
    production code; it is the baseline the fix is verified against."""

    def test_old_style_write_lies_about_success(self):
        scratch, primary_dir, _fallback_dir = _reset_dirs()
        try:
            bad_dir = os.path.join(primary_dir, "does_not_exist_and_cannot_be_created")

            def old_write_json(filepath, data):
                tmp_path = filepath + ".tmp"
                try:
                    with open(tmp_path, "w", encoding="utf-8") as f:
                        json.dump(data, f, indent=2, ensure_ascii=False)
                    os.replace(tmp_path, filepath)
                except Exception:
                    pass  # the bug: silently swallowed

            def old_handle_save(path):
                old_write_json(path, {"x": 1})
                return {"saved": True, "path": path}  # always True, unconditionally

            target = os.path.join(bad_dir, "moderation_report.json")
            result = old_handle_save(target)
            self.assertTrue(result["saved"])
            self.assertFalse(os.path.exists(target))
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


class WriteJsonCheckedTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp(prefix="write_json_checked_test_")

    def tearDown(self):
        shutil.rmtree(self.scratch, ignore_errors=True)

    def test_successful_write_verified_by_reread(self):
        path = os.path.join(self.scratch, "out.json")
        ok, err = bridge._write_json_checked(path, {"a": 1})
        self.assertTrue(ok)
        self.assertIsNone(err)
        with open(path, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"a": 1})

    def test_unwritable_directory_returns_false_with_error(self):
        bad_path = os.path.join(self.scratch, "does_not_exist", "sub", "out.json")
        _real_makedirs = os.makedirs

        def blocked_makedirs(path, exist_ok=False):
            raise PermissionError("simulated: read-only")

        os.makedirs = blocked_makedirs
        try:
            ok, err = bridge._write_json_checked(bad_path, {"a": 1})
        finally:
            os.makedirs = _real_makedirs
        self.assertFalse(ok)
        self.assertTrue(err)


class HandleModerationReportSaveTests(unittest.TestCase):
    def setUp(self):
        self.scratch, self.primary_dir, self.fallback_dir = _reset_dirs()
        self._orig_report_path = bridge._moderation_report_path
        self._orig_bridge_dir = bridge._get_bridge_dir
        bridge._moderation_report_path = lambda: os.path.join(self.primary_dir, "moderation_report.json")
        bridge._get_bridge_dir = lambda: self.fallback_dir

    def tearDown(self):
        bridge._moderation_report_path = self._orig_report_path
        bridge._get_bridge_dir = self._orig_bridge_dir
        shutil.rmtree(self.scratch, ignore_errors=True)

    def test_happy_path_both_locations_written(self):
        result = bridge._handle_moderation_report_save(
            {"report": "Everything looks clean.", "summary": "0 findings", "severity_counts": {}}
        )
        self.assertTrue(result["saved"])
        self.assertEqual(len(result["paths_written"]), 2)
        self.assertEqual(len(result["paths_failed"]), 0)
        self.assertTrue(os.path.exists(os.path.join(self.primary_dir, "moderation_report.json")))
        self.assertTrue(os.path.exists(os.path.join(self.fallback_dir, "moderation_report.json")))

    def test_primary_unwritable_falls_back_saved_true(self):
        broken_primary_dir = os.path.join(self.primary_dir, "protected_engine_copy")
        bridge._moderation_report_path = lambda: os.path.join(broken_primary_dir, "moderation_report.json")
        _real_makedirs = os.makedirs

        def makedirs_block_primary(path, exist_ok=False):
            if os.path.normcase(os.path.normpath(path)) == os.path.normcase(os.path.normpath(broken_primary_dir)):
                raise PermissionError("simulated: engine-install dir is read-only")
            return _real_makedirs(path, exist_ok=exist_ok)

        os.makedirs = makedirs_block_primary
        try:
            result = bridge._handle_moderation_report_save(
                {"report": "Report body 2.", "summary": "1 WARN", "severity_counts": {"WARN": 1}}
            )
        finally:
            os.makedirs = _real_makedirs

        self.assertTrue(result["saved"])
        self.assertEqual(len(result["paths_written"]), 1)
        self.assertEqual(result["paths_written"][0], os.path.join(self.fallback_dir, "moderation_report.json"))
        self.assertEqual(len(result["paths_failed"]), 1)
        self.assertEqual(result["paths_failed"][0]["path"], os.path.join(broken_primary_dir, "moderation_report.json"))
        self.assertTrue(result["paths_failed"][0]["error"])

    def test_both_locations_unwritable_saved_false_with_both_errors(self):
        """The assertion that proves the original bug is gone: when NEITHER
        location can be written, saved must be False (never a swallowed
        True), and both failures must carry real errors."""
        broken_primary_dir = os.path.join(self.primary_dir, "protected_engine_copy")
        broken_fallback_dir = os.path.join(self.fallback_dir, "protected_temp_copy")
        bridge._moderation_report_path = lambda: os.path.join(broken_primary_dir, "moderation_report.json")
        bridge._get_bridge_dir = lambda: broken_fallback_dir

        blocked = {
            os.path.normcase(os.path.normpath(broken_primary_dir)),
            os.path.normcase(os.path.normpath(broken_fallback_dir)),
        }
        _real_makedirs = os.makedirs

        def makedirs_block_both(path, exist_ok=False):
            if os.path.normcase(os.path.normpath(path)) in blocked:
                raise PermissionError("simulated: location is read-only")
            return _real_makedirs(path, exist_ok=exist_ok)

        os.makedirs = makedirs_block_both
        try:
            result = bridge._handle_moderation_report_save(
                {"report": "Report body 3.", "summary": "both fail", "severity_counts": {}}
            )
        finally:
            os.makedirs = _real_makedirs

        self.assertFalse(result["saved"])
        self.assertEqual(len(result["paths_written"]), 0)
        self.assertEqual(len(result["paths_failed"]), 2)
        self.assertTrue(all(f["error"] for f in result["paths_failed"]))

    def test_round_trip_write_then_read_including_fallback_only(self):
        save = bridge._handle_moderation_report_save(
            {"report": "Round trip report.", "summary": "roundtrip", "severity_counts": {"INFO": 2}}
        )
        self.assertTrue(save["saved"])

        read = bridge._handle_moderation_report_read({})
        self.assertTrue(read["exists"])
        self.assertEqual(read["report"], "Round trip report.")

        # Delete the primary copy so ONLY the fallback exists.
        primary_file = os.path.join(self.primary_dir, "moderation_report.json")
        os.remove(primary_file)
        if os.path.exists(primary_file + ".tmp"):
            os.remove(primary_file + ".tmp")

        read2 = bridge._handle_moderation_report_read({})
        self.assertTrue(read2["exists"])
        self.assertEqual(read2["report"], "Round trip report.")


if __name__ == "__main__":
    unittest.main()
