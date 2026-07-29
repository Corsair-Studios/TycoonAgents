"""Tests for uefn_bridge.py's per-command inbox polling
(``_list_pending_command_files`` / ``_process_command_file`` /
``_process_command``, ~lines 1680-1808), the fix for the command.json
clobber race: a second writer's rename-over-command.json could land in the
up-to-500ms window before the bridge read and deleted the first writer's
still-unread command, producing an intermittent 30s timeout.

Covers:
  1. ``_list_pending_command_files`` returns the legacy ``command.json``
     (if present) together with every ``command_<id>.json`` inbox file
     (bridge_paths.COMMAND_PREFIX), sorted oldest-first by mtime, and
     includes all of them -- not just the legacy file or just one inbox
     file.
  2. ``_process_command`` (the real per-tick entry point) processes EVERY
     currently-pending file in one call: each gets a response_<id>.json
     written and its own command file deleted.
  3. New-Python-reads-legacy compatibility guarantee: with ONLY the legacy
     command.json present (no command_*.json at all -- simulating an
     un-upgraded TS client), the bridge behaves exactly as it always did.

Uses a scratch temp dir substituted for the module's real ``_bridge_dir``
global (uefn_bridge.py reads/writes that global directly in this code path,
not via a per-call `_get_bridge_dir()` lookup, so the global itself must be
patched -- see _bridge_helpers.py convention notes in sibling test files for
why other handlers patch `_get_bridge_dir` instead).
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


class _CommandInboxTestBase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp(prefix="uefn_bridge_inbox_test_")
        self._orig_bridge_dir = bridge._bridge_dir
        bridge._bridge_dir = self.scratch
        # A real, fresh token so commands written with it are accepted by
        # _process_command_file's token check.
        self._orig_token = bridge._bridge_token
        bridge._bridge_token = "test-token"
        self._orig_warned_bad_token = bridge._warned_bad_token
        bridge._warned_bad_token = False
        # _handle_status (the handler these tests dispatch through) reads
        # unreal.EditorLevelLibrary.get_editor_world().get_name() -- a bare
        # MagicMock chain returns another MagicMock, which is NOT JSON
        # serializable and makes the response write silently fail deep
        # inside _write_json's own try/except (never raised, just logged).
        # Give it a real string so the response actually lands on disk.
        self._orig_editor_level_library = _unreal.EditorLevelLibrary
        _unreal.EditorLevelLibrary = MagicMock()
        _unreal.EditorLevelLibrary.get_editor_world.return_value.get_name.return_value = "TestLevel"

    def tearDown(self):
        bridge._bridge_dir = self._orig_bridge_dir
        bridge._bridge_token = self._orig_token
        bridge._warned_bad_token = self._orig_warned_bad_token
        _unreal.EditorLevelLibrary = self._orig_editor_level_library
        try:
            for name in os.listdir(self.scratch):
                os.remove(os.path.join(self.scratch, name))
            os.rmdir(self.scratch)
        except OSError:
            pass

    def _write_file(self, name, payload, mtime_offset=0.0):
        path = os.path.join(self.scratch, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        if mtime_offset:
            now = time.time()
            os.utime(path, (now + mtime_offset, now + mtime_offset))
        return path

    def _command_payload(self, cmd_id, method="status", params=None):
        return {
            "id": cmd_id,
            "method": method,
            "params": params or {},
            "token": bridge._bridge_token,
        }


# ---------------------------------------------------------------------------
# 1. _list_pending_command_files: oldest-first, includes legacy + all inbox
# ---------------------------------------------------------------------------

class ListPendingCommandFilesTests(_CommandInboxTestBase):
    def test_returns_legacy_and_all_inbox_files_oldest_first(self):
        # Staggered mtimes, written in a deliberately SHUFFLED order so the
        # result can only be correct if the function actually sorts by
        # mtime rather than by os.listdir()'s incidental ordering.
        bbb_path = self._write_file("command_bbb.json", self._command_payload("bbb"), mtime_offset=-20)
        legacy_path = self._write_file(bridge._COMMAND_FILENAME, self._command_payload("legacy"), mtime_offset=-30)
        aaa_path = self._write_file("command_aaa.json", self._command_payload("aaa"), mtime_offset=-10)

        pending = bridge._list_pending_command_files()

        self.assertEqual(pending, [legacy_path, bbb_path, aaa_path])

    def test_missing_dir_returns_empty_list_not_an_error(self):
        bridge._bridge_dir = os.path.join(self.scratch, "does_not_exist_at_all")
        self.assertEqual(bridge._list_pending_command_files(), [])

    def test_only_legacy_present_returns_just_that_one(self):
        legacy_path = self._write_file(bridge._COMMAND_FILENAME, self._command_payload("legacy"))
        self.assertEqual(bridge._list_pending_command_files(), [legacy_path])


# ---------------------------------------------------------------------------
# 2. _process_command processes every pending file in one call
# ---------------------------------------------------------------------------

class ProcessCommandBatchTests(_CommandInboxTestBase):
    def test_all_three_files_processed_in_one_tick(self):
        self._write_file(bridge._COMMAND_FILENAME, self._command_payload("legacy"), mtime_offset=-30)
        self._write_file("command_bbb.json", self._command_payload("bbb"), mtime_offset=-20)
        self._write_file("command_aaa.json", self._command_payload("aaa"), mtime_offset=-10)

        bridge._process_command()

        remaining = os.listdir(self.scratch)
        # Every command file must be gone (read-then-delete-then-execute).
        self.assertFalse(any(n == bridge._COMMAND_FILENAME or n.startswith("command_") for n in remaining))
        # Every command must have gotten its own response written.
        for cmd_id in ("legacy", "bbb", "aaa"):
            response_name = bridge._RESPONSE_PREFIX + cmd_id + ".json"
            self.assertIn(response_name, remaining, f"missing response for {cmd_id}: {remaining}")
            with open(os.path.join(self.scratch, response_name), "r", encoding="utf-8") as f:
                response = json.load(f)
            self.assertEqual(response["id"], cmd_id)
            self.assertIsNone(response["error"])
            self.assertEqual(response["result"]["status"], "running")


# ---------------------------------------------------------------------------
# 3. Legacy-alone still works unmodified (new-Python-reads-legacy guarantee)
# ---------------------------------------------------------------------------

class LegacyOnlyStillWorksTests(_CommandInboxTestBase):
    def test_legacy_command_json_alone_processed_and_deleted(self):
        legacy_path = self._write_file(bridge._COMMAND_FILENAME, self._command_payload("only-legacy"))

        bridge._process_command()

        self.assertFalse(os.path.exists(legacy_path))
        response_path = os.path.join(self.scratch, bridge._RESPONSE_PREFIX + "only-legacy.json")
        self.assertTrue(os.path.exists(response_path))
        with open(response_path, "r", encoding="utf-8") as f:
            response = json.load(f)
        self.assertIsNone(response["error"])
        self.assertEqual(response["result"]["status"], "running")

    def test_no_pending_files_is_a_silent_no_op(self):
        # Nothing written at all -- must not raise.
        bridge._process_command()
        self.assertEqual(os.listdir(self.scratch), [])


if __name__ == "__main__":
    unittest.main()
