"""Tests for moderation_scanner._moderation_report_locations /
_read_moderation_report — the dual-location read that closes a real
silent-failure bug: a report that only made it to the FALLBACK location
(because the primary sits under a permission-protected engine-install path)
was previously invisible to the reader forever, through repeated Refresh
clicks.

Ported from test_dual_read.py's CASE 1-5 (the tkinter window harness, CASE
6, is a UI smoke check outside this module's scope).
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner  # noqa: E402

ms = import_moderation_scanner()


class DualLocationReadTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="modrep_test_")
        self.primary_dir = os.path.join(self.tmpdir, "primary")
        self.fallback_dir = os.path.join(self.tmpdir, "fallback")
        os.makedirs(self.primary_dir, exist_ok=True)
        os.makedirs(self.fallback_dir, exist_ok=True)
        self.primary_path = os.path.join(self.primary_dir, "moderation_report.json")
        self.fallback_path = os.path.join(self.fallback_dir, "moderation_report.json")

        # Monkeypatch the two path-resolution helpers; restored in tearDown
        # so later test modules (which share this process/module cache) see
        # the real functions again.
        self._orig_report_path = ms._moderation_report_path
        self._orig_ipc_dir = ms._bridge_ipc_dir
        ms._moderation_report_path = lambda: self.primary_path
        ms._bridge_ipc_dir = lambda: self.fallback_dir

    def tearDown(self):
        ms._moderation_report_path = self._orig_report_path
        ms._bridge_ipc_dir = self._orig_ipc_dir
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write(self, path, generated_at, corrupt=False):
        if corrupt:
            with open(path, "w", encoding="utf-8") as f:
                f.write("{not valid json!!")
        else:
            with open(path, "w", encoding="utf-8") as f:
                json.dump({
                    "generated_at": generated_at,
                    "summary": f"summary from {os.path.basename(os.path.dirname(path))}",
                    "severity_counts": {"BLOCKER": 1, "WARN": 0, "KNOWN_RISK": 0, "INFO": 0},
                    "report": f"report body from {path}",
                }, f)

    def test_only_primary_exists(self):
        self._write(self.primary_path, "2026-01-01 00:00:00")
        r = ms._read_moderation_report()
        self.assertIsNotNone(r)
        self.assertEqual(r["_source_path"], self.primary_path)

    def test_only_fallback_exists(self):
        """The originally-broken case: a report that only made it to the
        fallback location was invisible to the reader forever."""
        self._write(self.fallback_path, "2026-01-02 00:00:00")
        r = ms._read_moderation_report()
        self.assertIsNotNone(r)
        self.assertEqual(r["_source_path"], self.fallback_path)

    def test_both_exist_primary_newer_wins(self):
        self._write(self.fallback_path, "older")
        time.sleep(0.05)
        self._write(self.primary_path, "newer")
        os.utime(self.fallback_path, (time.time() - 100, time.time() - 100))
        r = ms._read_moderation_report()
        self.assertEqual(r["_source_path"], self.primary_path)

    def test_both_exist_fallback_newer_wins(self):
        """Reversed ordering from the previous test — proves the winner is
        determined by mtime, not by which location is checked first."""
        self._write(self.primary_path, "older")
        self._write(self.fallback_path, "newer")
        os.utime(self.primary_path, (time.time() - 100, time.time() - 100))
        r = ms._read_moderation_report()
        self.assertEqual(r["_source_path"], self.fallback_path)

    def test_corrupt_newer_primary_falls_through_to_valid_fallback(self):
        """A file that exists but fails to parse must NOT shadow a valid
        file at the other location, even when the corrupt file has the
        newer mtime (the naive "just take newest mtime" approach would
        pick the corrupt one)."""
        self._write(self.primary_path, "corrupt", corrupt=True)
        self._write(self.fallback_path, "2026-01-03 00:00:00")
        os.utime(self.fallback_path, (time.time() - 100, time.time() - 100))
        r = ms._read_moderation_report()
        self.assertIsNotNone(r)
        self.assertEqual(r["_source_path"], self.fallback_path)

    def test_neither_exists_returns_none(self):
        r = ms._read_moderation_report()
        self.assertIsNone(r)
        locations = ms._moderation_report_locations()
        self.assertEqual(len(locations), 2)
        self.assertEqual(locations[0][1], self.primary_path)
        self.assertEqual(locations[1][1], self.fallback_path)


if __name__ == "__main__":
    unittest.main()
