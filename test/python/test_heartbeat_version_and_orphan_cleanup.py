"""Tests for two small uefn_bridge.py additions that ship alongside the
per-command inbox (bridge_paths.COMMAND_PREFIX, see
test_command_inbox_polling.py):

  1. ``_write_heartbeat`` now stamps a ``bridge_version`` field into
     heartbeat.json (sourced from ``bridge_version.BRIDGE_VERSION``) so a TS
     client can tell whether this bridge is new enough to poll per-command
     inbox files before ever writing one (see
     uefn-bridge/uefn-server.ts's isBridgeInboxCapable /
     MIN_INBOX_BRIDGE_VERSION, covered on the TS side in
     test/uefnBridgeInboxCapability.test.ts).
  2. ``_cleanup_orphan_responses`` deletes response_*.json files older than
     10 minutes (a response nobody ever came back to claim, e.g. because the
     TS caller crashed or timed out) and leaves fresh ones alone; runs
     every 20th poll (see _tick), never raises even on a missing/unreadable
     bridge dir.

Both patch the module-level ``bridge._bridge_dir`` global directly (see
test_command_inbox_polling.py's docstring for why: this code path reads/
writes that global, not a per-call `_get_bridge_dir()` lookup).
"""
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, import_uefn_bridge, stub_unreal  # noqa: E402

ensure_bridge_on_path()
_unreal = stub_unreal()
bridge = import_uefn_bridge()

import bridge_version  # noqa: E402


class _ScratchBridgeDirTestBase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp(prefix="uefn_bridge_heartbeat_test_")
        self._orig_bridge_dir = bridge._bridge_dir
        bridge._bridge_dir = self.scratch
        # _write_heartbeat reads
        # unreal.EditorLevelLibrary.get_editor_world().get_name() -- a bare
        # MagicMock chain returns another MagicMock, which is NOT JSON
        # serializable and makes the heartbeat write silently fail deep
        # inside _write_json's own try/except (never raised, just logged).
        # Give it a real string so heartbeat.json actually lands on disk.
        self._orig_editor_level_library = _unreal.EditorLevelLibrary
        _unreal.EditorLevelLibrary = MagicMock()
        _unreal.EditorLevelLibrary.get_editor_world.return_value.get_name.return_value = "TestLevel"

    def tearDown(self):
        bridge._bridge_dir = self._orig_bridge_dir
        _unreal.EditorLevelLibrary = self._orig_editor_level_library
        try:
            for name in os.listdir(self.scratch):
                os.remove(os.path.join(self.scratch, name))
            os.rmdir(self.scratch)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 1. Heartbeat carries bridge_version
# ---------------------------------------------------------------------------

class HeartbeatBridgeVersionTests(_ScratchBridgeDirTestBase):
    def test_heartbeat_payload_bridge_version_matches_bridge_version_module(self):
        bridge._write_heartbeat()

        heartbeat_path = os.path.join(self.scratch, bridge._HEARTBEAT_FILENAME)
        self.assertTrue(os.path.exists(heartbeat_path), "heartbeat.json was not written")
        with open(heartbeat_path, "r", encoding="utf-8") as f:
            heartbeat = json.load(f)

        self.assertIn("bridge_version", heartbeat)
        self.assertEqual(heartbeat["bridge_version"], bridge.BRIDGE_VERSION)
        # bridge.BRIDGE_VERSION itself is sourced from bridge_version.py
        # (import-guarded -- see uefn_bridge.py's `try: from bridge_version
        # import BRIDGE_VERSION` block); confirm it actually reflects the
        # real module, not a stale/unrelated fallback value.
        self.assertEqual(bridge.BRIDGE_VERSION, bridge_version.BRIDGE_VERSION)

    def test_heartbeat_still_has_the_pre_existing_fields(self):
        # Additive-only check: bridge_version must not have displaced any
        # field a TS client already relies on.
        bridge._write_heartbeat()
        with open(os.path.join(self.scratch, bridge._HEARTBEAT_FILENAME), "r", encoding="utf-8") as f:
            heartbeat = json.load(f)
        for field in ("status", "timestamp", "level_name", "actor_count", "token"):
            self.assertIn(field, heartbeat)


# ---------------------------------------------------------------------------
# 2. Orphan response cleanup
# ---------------------------------------------------------------------------

class OrphanResponseCleanupTests(_ScratchBridgeDirTestBase):
    def _touch_response(self, cmd_id, age_seconds):
        path = os.path.join(self.scratch, bridge._RESPONSE_PREFIX + cmd_id + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"id": cmd_id}, f)
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_old_response_deleted_fresh_response_kept(self):
        old_path = self._touch_response("stale", age_seconds=700)   # > 10 min
        fresh_path = self._touch_response("fresh", age_seconds=5)   # well under 10 min

        bridge._cleanup_orphan_responses()

        self.assertFalse(os.path.exists(old_path), "response older than 10 minutes was not deleted")
        self.assertTrue(os.path.exists(fresh_path), "fresh response was deleted")

    def test_response_just_under_the_threshold_is_kept(self):
        # 599s (< the 600s / 10-minute cutoff) must survive.
        boundary_path = self._touch_response("boundary", age_seconds=599)
        bridge._cleanup_orphan_responses()
        self.assertTrue(os.path.exists(boundary_path))

    def test_non_response_files_are_never_touched(self):
        other_path = os.path.join(self.scratch, "command_untouched.json")
        with open(other_path, "w", encoding="utf-8") as f:
            json.dump({}, f)
        stamp = time.time() - 700
        os.utime(other_path, (stamp, stamp))

        bridge._cleanup_orphan_responses()

        self.assertTrue(os.path.exists(other_path), "cleanup must only ever touch response_*.json files")

    def test_missing_bridge_dir_does_not_raise(self):
        bridge._bridge_dir = os.path.join(self.scratch, "this_subdir_does_not_exist")
        bridge._cleanup_orphan_responses()  # must not raise

    def test_empty_bridge_dir_does_not_raise(self):
        bridge._cleanup_orphan_responses()  # scratch dir exists but is empty


if __name__ == "__main__":
    unittest.main()
