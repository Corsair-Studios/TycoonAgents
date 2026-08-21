"""Coverage for init_unreal.py's `_classify_long_path_error` and
`_read_stamp` helpers (the self-sync long-path hardening in this batch).

`init_unreal.py` is a top-level auto-run script (executes self-sync file
operations against the real filesystem at import time, and unconditionally
registers UEFN Tools-menu entries) -- it is NOT safely `import`able in a
plain test process the way `moderation_scanner`/`uefn_bridge` are (see
_bridge_helpers.py's docstring). Instead this module reads the REAL source
TEXT and `exec()`s just the two target function definitions in an isolated
namespace -- the same "exercise the real compiled/parsed logic, not a
hand-copied reimplementation" principle test/uefnBridgeInboxCapability.test.ts
uses on the TypeScript side via anchor-extraction + esbuild, applied here with
Python's own `exec()`.
"""
import os
import re
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import REPO_ROOT  # noqa: E402

INIT_UNREAL_PATH = os.path.join(REPO_ROOT, "media", "uefn-bridge", "init_unreal.py")

_CLASSIFY_START = "def _classify_long_path_error(_exc, _paths=()):"
_CLASSIFY_END = "\ntry:\n    import glob as _sync_glob"

_READ_STAMP_START = "    def _read_stamp(_dir):"
_READ_STAMP_END = "\n    _this_dir = _sync_os.path.dirname"


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


def load_classify_long_path_error():
    """Extract and exec the REAL, module-level `_classify_long_path_error`
    function body verbatim (it has zero external dependencies, so no
    supporting globals are required)."""
    source = _read_source()
    text = _extract(source, _CLASSIFY_START, _CLASSIFY_END)
    ns = {}
    exec(compile(text, INIT_UNREAL_PATH, "exec"), ns)
    return ns["_classify_long_path_error"]


def load_read_stamp():
    """Extract the REAL nested `_read_stamp` function (indented 4 spaces
    inside init_unreal.py's outer `try:` block), dedent it to module level,
    and exec it in a fresh namespace carrying its two free-variable module
    aliases (`_sync_os`, `_sync_re`) plus a fresh `_stamp_read_warned` flag
    -- giving each caller its own isolated copy of the "warn once per
    session" module-level flag, matching this test's per-test isolation
    need (the task's "reset module flag in setUp" -- achieved here by never
    sharing state across calls in the first place, since each call builds a
    brand new namespace). `print` is intercepted so the warning call can be
    counted without depending on stdout capture.
    """
    source = _read_source()
    block = _extract(source, _READ_STAMP_START, _READ_STAMP_END)
    lines = block.split("\n")
    dedented = "\n".join(line[4:] if line.startswith("    ") else line for line in lines)

    warn_calls = []

    def fake_print(*args, **kwargs):
        warn_calls.append(" ".join(str(a) for a in args))

    ns = {
        "_sync_os": os,
        "_sync_re": re,
        "_stamp_read_warned": False,
        "print": fake_print,
    }
    exec(compile(dedented, INIT_UNREAL_PATH, "exec"), ns)
    return ns["_read_stamp"], warn_calls


class ClassifyLongPathErrorTests(unittest.TestCase):
    def setUp(self):
        self.classify = load_classify_long_path_error()

    def test_true_case_261_char_path_is_flagged(self):
        long_path = "a" * 261
        self.assertEqual(len(long_path), 261)
        err = OSError("boom")
        result = self.classify(err, (long_path,))
        self.assertEqual(result, long_path)

    def test_true_case_winerror_206_with_a_candidate_path(self):
        err = OSError("boom")
        err.winerror = 206  # ERROR_FILENAME_EXCED_RANGE
        result = self.classify(err, ("C:\\short\\path.py",))
        self.assertEqual(result, "C:\\short\\path.py")

    def test_true_case_winerror_3_with_a_candidate_path(self):
        err = OSError("boom")
        err.winerror = 3  # ERROR_PATH_NOT_FOUND, also raised for over-length paths
        result = self.classify(err, ("C:\\short\\other.py",))
        self.assertEqual(result, "C:\\short\\other.py")

    def test_false_case_short_path_generic_oserror_returns_none(self):
        err = OSError("just a normal missing-file error")
        result = self.classify(err, ("C:\\short\\path.py",))
        self.assertIsNone(result)

    def test_never_raises_on_a_completely_empty_call(self):
        self.assertIsNone(self.classify(OSError("x")))


class ReadStampTests(unittest.TestCase):
    def test_oserror_returns_zero_tuple_and_warns_exactly_once_across_two_calls(self):
        read_stamp, warn_calls = load_read_stamp()  # fresh namespace -- flag starts False
        missing_dir = tempfile.mkdtemp(prefix="read-stamp-missing-")
        shutil.rmtree(missing_dir)  # now open() on <dir>/bridge_version.py raises a genuine OSError
        try:
            first = read_stamp(missing_dir)
            self.assertEqual(first, (0, 0, 0))
            self.assertEqual(len(warn_calls), 1, "first OSError must log exactly one warning")

            second = read_stamp(missing_dir)
            self.assertEqual(second, (0, 0, 0))
            self.assertEqual(len(warn_calls), 1, "a second OSError in the same session must NOT warn again")
        finally:
            if os.path.isdir(missing_dir):
                shutil.rmtree(missing_dir)

    def test_parse_failure_missing_bridge_version_line_stays_silent(self):
        read_stamp, warn_calls = load_read_stamp()
        d = tempfile.mkdtemp(prefix="read-stamp-parsefail-")
        try:
            with open(os.path.join(d, "bridge_version.py"), "w", encoding="utf-8") as f:
                f.write("# no BRIDGE_VERSION assignment in this file\n")
            result = read_stamp(d)
            self.assertEqual(result, (0, 0, 0))
            self.assertEqual(len(warn_calls), 0, "a missing/malformed BRIDGE_VERSION line is expected, not an OSError -- must stay silent")
        finally:
            shutil.rmtree(d)

    def test_valid_stamp_parses_and_never_warns(self):
        read_stamp, warn_calls = load_read_stamp()
        d = tempfile.mkdtemp(prefix="read-stamp-valid-")
        try:
            with open(os.path.join(d, "bridge_version.py"), "w", encoding="utf-8") as f:
                f.write('BRIDGE_VERSION = "1.2.3"\n')
            result = read_stamp(d)
            self.assertEqual(result, (1, 2, 3))
            self.assertEqual(len(warn_calls), 0)
        finally:
            shutil.rmtree(d)

    def test_date_version_with_same_day_suffix_parses_ignoring_suffix(self):
        """"2026.8.21-b" (the same-day release-letter suffix
        computeDateVersion() in scripts/sync-powertools.mjs appends) must
        parse to (2026, 8, 21), NOT fall back to (0, 0, 0) -- an unparseable
        suffixed stamp would be treated as the oldest possible version and
        get silently overwritten by an actually-older bridge copy."""
        read_stamp, warn_calls = load_read_stamp()
        d = tempfile.mkdtemp(prefix="read-stamp-suffixed-")
        try:
            with open(os.path.join(d, "bridge_version.py"), "w", encoding="utf-8") as f:
                f.write('BRIDGE_VERSION = "2026.8.21-b"\n')
            result = read_stamp(d)
            self.assertEqual(result, (2026, 8, 21))
            self.assertEqual(len(warn_calls), 0)
        finally:
            shutil.rmtree(d)

    def test_date_version_without_suffix_parses_the_same_as_with_suffix(self):
        """Bare "2026.8.21" and suffixed "2026.8.21-b" must parse to the
        identical tuple -- the suffix carries no comparison weight."""
        read_stamp_bare, _ = load_read_stamp()
        read_stamp_suffixed, _ = load_read_stamp()
        d = tempfile.mkdtemp(prefix="read-stamp-suffix-parity-")
        try:
            bare_path = os.path.join(d, "bare")
            suffixed_path = os.path.join(d, "suffixed")
            os.makedirs(bare_path)
            os.makedirs(suffixed_path)
            with open(os.path.join(bare_path, "bridge_version.py"), "w", encoding="utf-8") as f:
                f.write('BRIDGE_VERSION = "2026.8.21"\n')
            with open(os.path.join(suffixed_path, "bridge_version.py"), "w", encoding="utf-8") as f:
                f.write('BRIDGE_VERSION = "2026.8.21-b"\n')
            self.assertEqual(read_stamp_bare(bare_path), read_stamp_suffixed(suffixed_path))
            self.assertEqual(read_stamp_bare(bare_path), (2026, 8, 21))
        finally:
            shutil.rmtree(d)

    def test_suffixed_date_version_compares_newer_than_old_semver_stamp(self):
        """A suffixed date stamp must still win the tuple comparison used at
        init_unreal.py's self-sync decision point (~line 247,
        `_newest_stamp > _own_stamp`) against an old three-part semver
        stamp like "0.0.562" -- proving the suffix doesn't demote it back to
        (0, 0, 0) in practice, not just in isolation."""
        read_stamp, _ = load_read_stamp()
        d = tempfile.mkdtemp(prefix="read-stamp-ordering-")
        try:
            with open(os.path.join(d, "bridge_version.py"), "w", encoding="utf-8") as f:
                f.write('BRIDGE_VERSION = "2026.8.21-b"\n')
            new_stamp = read_stamp(d)
            old_stamp = (0, 0, 562)
            self.assertGreater(new_stamp, old_stamp)
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
