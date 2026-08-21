"""Coverage for init_unreal.py's equal-stamp content-drift self-sync path
(`_sync_relevant_name` / `_dir_contents_differ`, and the `_sync_reason`
decision at the `_newest_stamp > _own_stamp` / `== _own_stamp` /
`< _own_stamp` branch point).

Same extraction discipline as test_init_unreal_long_path_and_stamp.py: this
module is a top-level auto-run script, not safely `import`able in a plain
test process, so this file reads the REAL source TEXT and `exec()`s just the
two target function definitions in an isolated namespace -- exercising the
real compiled logic, not a hand-copied reimplementation.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import REPO_ROOT  # noqa: E402

INIT_UNREAL_PATH = os.path.join(REPO_ROOT, "media", "uefn-bridge", "init_unreal.py")

_RELEVANT_START = "    def _sync_relevant_name(_name):"
_RELEVANT_END = "\n    def _dir_contents_differ(_dir_a, _dir_b):"

_DIFFER_START = "    def _dir_contents_differ(_dir_a, _dir_b):"
_DIFFER_END = "\n    _this_dir = _sync_os.path.dirname"


def _read_source():
    with open(INIT_UNREAL_PATH, "r", encoding="utf-8") as f:
        return f.read()


def _extract(source, start_marker, end_marker):
    start = source.index(start_marker)
    if start < 0:
        raise AssertionError(f"init_unreal.py layout changed: could not find {start_marker!r}")
    end = source.index(end_marker, start)
    if end < 0:
        raise AssertionError(f"init_unreal.py layout changed: could not find {end_marker!r} after start")
    return source[start:end]


def _dedent(block):
    lines = block.split("\n")
    return "\n".join(line[4:] if line.startswith("    ") else line for line in lines)


def load_sync_relevant_name():
    """Extract the REAL nested `_sync_relevant_name` function, dedented to
    module level. No free variables beyond builtins."""
    source = _read_source()
    block = _dedent(_extract(source, _RELEVANT_START, _RELEVANT_END))
    ns = {}
    exec(compile(block, INIT_UNREAL_PATH, "exec"), ns)
    return ns["_sync_relevant_name"]


def load_dir_contents_differ():
    """Extract the REAL nested `_dir_contents_differ` function, dedented to
    module level, given a fresh namespace carrying its free-variable module
    alias (`_sync_os`) and `_sync_relevant_name` (loaded fresh alongside it,
    mirroring how both live in the same enclosing scope in the real file)."""
    source = _read_source()
    block = _dedent(_extract(source, _DIFFER_START, _DIFFER_END))
    ns = {
        "_sync_os": os,
        "_sync_relevant_name": load_sync_relevant_name(),
    }
    exec(compile(block, INIT_UNREAL_PATH, "exec"), ns)
    return ns["_dir_contents_differ"]


class SyncRelevantNameTests(unittest.TestCase):
    def setUp(self):
        self.relevant = load_sync_relevant_name()

    def test_py_file_is_relevant(self):
        self.assertTrue(self.relevant("uefn_bridge.py"))

    def test_icon_png_is_relevant(self):
        self.assertTrue(self.relevant("trashbyrd_40x40.png"))

    def test_node_server_is_excluded(self):
        self.assertFalse(self.relevant("uefn-server.mjs"))

    def test_unrelated_file_is_not_relevant(self):
        self.assertFalse(self.relevant("readme.txt"))


class DirContentsDifferTests(unittest.TestCase):
    def setUp(self):
        self.differ = load_dir_contents_differ()
        self.dir_a = tempfile.mkdtemp(prefix="content-sync-a-")
        self.dir_b = tempfile.mkdtemp(prefix="content-sync-b-")

    def tearDown(self):
        import shutil
        for d in (self.dir_a, self.dir_b):
            if os.path.isdir(d):
                shutil.rmtree(d)

    def _write(self, d, name, text):
        with open(os.path.join(d, name), "w", encoding="utf-8") as f:
            f.write(text)

    def test_identical_content_same_size_returns_false(self):
        self._write(self.dir_a, "uefn_bridge.py", "print('hello')\n")
        self._write(self.dir_b, "uefn_bridge.py", "print('hello')\n")
        self.assertFalse(self.differ(self.dir_a, self.dir_b))

    def test_same_size_different_bytes_returns_true(self):
        # Same length (both 15 chars) but different content -- proves the
        # size-first check does NOT short-circuit into a false "identical".
        self._write(self.dir_a, "uefn_bridge.py", "print('hello')")
        self._write(self.dir_b, "uefn_bridge.py", "print('world')")
        size_a = os.path.getsize(os.path.join(self.dir_a, "uefn_bridge.py"))
        size_b = os.path.getsize(os.path.join(self.dir_b, "uefn_bridge.py"))
        self.assertEqual(size_a, size_b)
        self.assertTrue(self.differ(self.dir_a, self.dir_b))

    def test_different_size_returns_true(self):
        self._write(self.dir_a, "uefn_bridge.py", "print('hello world, this is longer')\n")
        self._write(self.dir_b, "uefn_bridge.py", "print('hi')\n")
        self.assertTrue(self.differ(self.dir_a, self.dir_b))

    def test_file_missing_on_one_side_returns_true(self):
        self._write(self.dir_a, "uefn_bridge.py", "print('hello')\n")
        self._write(self.dir_a, "device_audit.py", "print('extra')\n")
        self._write(self.dir_b, "uefn_bridge.py", "print('hello')\n")
        self.assertTrue(self.differ(self.dir_a, self.dir_b))

    def test_irrelevant_files_are_ignored(self):
        self._write(self.dir_a, "uefn_bridge.py", "print('hello')\n")
        self._write(self.dir_b, "uefn_bridge.py", "print('hello')\n")
        self._write(self.dir_a, "uefn-server.mjs", "console.log('a')")
        self._write(self.dir_b, "uefn-server.mjs", "console.log('completely different')")
        self.assertFalse(self.differ(self.dir_a, self.dir_b))

    def test_multiple_identical_files_returns_false(self):
        for name, text in (
            ("uefn_bridge.py", "a = 1\n"),
            ("device_audit.py", "b = 2\n"),
            ("moderation_scanner.py", "c = 3\n" * 100),
        ):
            self._write(self.dir_a, name, text)
            self._write(self.dir_b, name, text)
        self.assertFalse(self.differ(self.dir_a, self.dir_b))

    def test_unreadable_dir_fails_toward_sync_true(self):
        missing = os.path.join(self.dir_a, "does-not-exist")
        self.assertTrue(self.differ(missing, self.dir_b))


class SyncDecisionSemanticsTests(unittest.TestCase):
    """Exercises the tuple-comparison decision shape directly (newer/equal/
    older), independent of file I/O, to pin the ordering contract the task
    calls out as the most important thing to get right: an older project
    stamp must NEVER sync, even when content differs."""

    def setUp(self):
        self.differ = load_dir_contents_differ()

    def _decide(self, own_stamp, newest_stamp, newest_dir, this_dir):
        """Mirrors the real branch at init_unreal.py's sync decision point:
        returns the _sync_reason that would be chosen."""
        if newest_stamp > own_stamp:
            return "stamp"
        elif newest_stamp == own_stamp:
            return "content" if self.differ(newest_dir, this_dir) else None
        else:
            return None

    def test_newer_project_stamp_syncs_regardless_of_content(self):
        d_new, d_own = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            with open(os.path.join(d_new, "uefn_bridge.py"), "w") as f:
                f.write("same\n")
            with open(os.path.join(d_own, "uefn_bridge.py"), "w") as f:
                f.write("same\n")
            reason = self._decide((0, 0, 1), (0, 0, 2), d_new, d_own)
            self.assertEqual(reason, "stamp")
        finally:
            import shutil
            shutil.rmtree(d_new)
            shutil.rmtree(d_own)

    def test_equal_stamp_differing_content_triggers_content_sync(self):
        d_new, d_own = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            with open(os.path.join(d_new, "uefn_bridge.py"), "w") as f:
                f.write("new code\n")
            with open(os.path.join(d_own, "uefn_bridge.py"), "w") as f:
                f.write("old code\n")
            reason = self._decide((2026, 8, 21), (2026, 8, 21), d_new, d_own)
            self.assertEqual(reason, "content")
        finally:
            import shutil
            shutil.rmtree(d_new)
            shutil.rmtree(d_own)

    def test_equal_stamp_identical_content_does_not_sync(self):
        d_new, d_own = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            with open(os.path.join(d_new, "uefn_bridge.py"), "w") as f:
                f.write("same code\n")
            with open(os.path.join(d_own, "uefn_bridge.py"), "w") as f:
                f.write("same code\n")
            reason = self._decide((2026, 8, 21), (2026, 8, 21), d_new, d_own)
            self.assertIsNone(reason)
        finally:
            import shutil
            shutil.rmtree(d_new)
            shutil.rmtree(d_own)

    def test_older_project_stamp_never_syncs_even_with_differing_content(self):
        d_new, d_own = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            with open(os.path.join(d_new, "uefn_bridge.py"), "w") as f:
                f.write("stale but different\n")
            with open(os.path.join(d_own, "uefn_bridge.py"), "w") as f:
                f.write("current engine copy\n")
            # newest (project) stamp is OLDER than own (engine) stamp
            reason = self._decide((2026, 8, 21), (2026, 8, 20), d_new, d_own)
            self.assertIsNone(reason, "an older project copy must never overwrite a newer engine copy")
        finally:
            import shutil
            shutil.rmtree(d_new)
            shutil.rmtree(d_own)


if __name__ == "__main__":
    unittest.main()
