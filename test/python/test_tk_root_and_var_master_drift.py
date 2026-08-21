"""Drift guard for the tk._default_root class of bug fixed in device_audit.py
(commit 31287c0) and then found and fixed in seven sibling tools:
property_inspector.py, batch_tools.py, tips_viewer.py, asset_sweep.py,
moderation_scanner.py, reference_finder.py, verse_snippets.py.

Background: a window built with an unconditional ``root = tk.Tk()`` while
another Tk interpreter is already alive (e.g. uefn_launcher.py's window, or
a previously-opened tool window) creates a SECOND Tk interpreter.
``tk._default_root`` stays pinned to whichever root was created FIRST, so
any ``tk.StringVar()``/``IntVar()``/``BooleanVar()``/``DoubleVar()``
constructed with no explicit ``master=`` silently binds to that stale first
interpreter instead of the new window's own. The Entry widget still shows
typed text (it has its own buffer independent of the variable), but
``var.get()`` always returns the type's zero value and ``trace_add``
callbacks never fire — silent, not loud, because an empty filter query
conventionally means "show everything".

The fix in every affected tool is the sibling pattern already used by
health_scanner.py, material_browser.py, niagara_inspector.py, etc.:

    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()

...for the root, and an explicit ``master=<root-var-name>`` on every Tk
variable bound to a widget owned by that root.

This test does not construct real Tk widgets (no display needed, and
several of these modules import `unreal` at module scope); it source-scans
every .py file directly under media/uefn-bridge/ so it catches regressions
in files with no other test coverage, and so it also catches the bug being
reintroduced in a NEW tool nobody wrote a dedicated test for. Two patterns
are flagged:

1. An unconditional ``tk.Tk()`` root assignment with no preceding
   ``tk._default_root`` guard in the same function.
2. A Tk variable constructor (``tk.StringVar``/``IntVar``/``BooleanVar``/
   ``DoubleVar``, bare or ``tkinter.`` qualified) called with no arguments
   at all -- which can never carry an explicit master.

uefn_launcher.py, init_unreal.py, and build_mode_cleanup.py are excluded
deliberately (see inline comments below); device_audit.py already carries
its own dedicated fix + regression test
(test_device_audit_search_filter.py) and is included here anyway as a
belt-and-suspenders re-check since it lives in the same scanned directory.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import BRIDGE_DIR  # noqa: E402

# Files with deliberately different Tk lifecycle rules -- see CLAUDE.md /
# task brief for why each is exempt:
#   - uefn_launcher.py: multiple tk.Tk() roots are intentional (comment at
#     uefn_launcher.py:1744 explains why); it owns and drives its own
#     top-level interpreters rather than joining a shared one.
#   - init_unreal.py: not a Tk UI tool.
#   - build_mode_cleanup.py: unconditional tk.Tk() root, and its one Tk
#     variable (StringVar(value=_STATE_LEAVE), line ~563) passes a value
#     argument rather than being a bare zero-argument construction, so the
#     specific pattern this guard flags does not occur there.
_EXEMPT_FILES = {
    "uefn_launcher.py",
    "init_unreal.py",
    "build_mode_cleanup.py",
}

_TK_VAR_TYPES = ("StringVar", "IntVar", "BooleanVar", "DoubleVar")

# A bare, no-argument Tk variable constructor: tk.StringVar() / StringVar()
# / tkinter.IntVar(), etc. Deliberately does NOT match calls that pass any
# argument (e.g. master=root, value=...) -- those are fine regardless of
# argument order or keyword name, since the point of this guard is only to
# catch the zero-argument form that can never carry a master.
_BARE_VAR_RE = re.compile(
    r"(?:^|[^.\w])(?:tk\.|tkinter\.)?(" + "|".join(_TK_VAR_TYPES) + r")\(\s*\)"
)

# An unconditional root = tk.Tk() / tkinter.Tk() assignment.
_TK_ROOT_ASSIGN_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<var>\w+)\s*=\s*(?:tk\.|tkinter\.)Tk\(\s*\)\s*$"
)

# Any reference to tk._default_root -- if present anywhere earlier in the
# same function body, we treat the root assignment as guarded (covers both
# the ternary form used by most tools and the if/else form used by
# tips_viewer.py).
_DEFAULT_ROOT_REF_RE = re.compile(r"tk\._default_root|tkinter\._default_root")


def _target_files():
    files = []
    for name in sorted(os.listdir(BRIDGE_DIR)):
        if not name.endswith(".py"):
            continue
        if name in _EXEMPT_FILES:
            continue
        files.append(os.path.join(BRIDGE_DIR, name))
    return files


def _uses_tkinter(lines):
    return any(
        re.search(r"^\s*(import\s+tkinter|from\s+tkinter\b|import\s+tkinter\s+as\s+tk)", ln)
        for ln in lines
    )


def _strip_comment(line):
    """Strip a trailing '# ...' comment for scanning purposes. Not a full
    Python tokenizer (a '#' inside a string literal would be mis-handled),
    but every real match this guard cares about (tk.Tk()/tk.StringVar()
    calls) is code, not string contents, and this repo's docstrings/
    comments are exactly where the pattern text otherwise shows up in
    prose (e.g. device_audit.py's own explanatory comment)."""
    idx = line.find("#")
    return line if idx == -1 else line[:idx]


class NoUnconditionalTkRootTests(unittest.TestCase):
    """Every tk.Tk() root assignment in a scanned file must be preceded,
    somewhere earlier in the same file, by a tk._default_root guard --
    i.e. the file must use the Toplevel-if-a-root-exists pattern rather
    than blindly creating a second interpreter."""

    def test_no_unconditional_tk_tk_without_default_root_guard(self):
        failures = []
        for path in _target_files():
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if not _uses_tkinter(lines):
                continue

            guard_seen = False
            for i, line in enumerate(lines, start=1):
                code = _strip_comment(line)
                if _DEFAULT_ROOT_REF_RE.search(code):
                    guard_seen = True
                m = _TK_ROOT_ASSIGN_RE.match(code.rstrip("\n"))
                if m and not guard_seen:
                    failures.append(
                        f"{os.path.basename(path)}:{i}: unconditional "
                        f"`{m.group('var')} = tk.Tk()` with no prior "
                        f"`tk._default_root` guard in this file -- a second "
                        f"Tk interpreter will be created when a root already "
                        f"exists (e.g. uefn_launcher.py's window, or another "
                        f"tool window still open), silently breaking any "
                        f"unmastered Tk variable bound to it. Use "
                        f"`_master = tk._default_root; root = "
                        f"tk.Toplevel(_master) if _master is not None else "
                        f"tk.Tk()` -- see device_audit.py for the full "
                        f"explanation."
                    )

            self.assertEqual(
                [f for f in failures if f.startswith(os.path.basename(path) + ":")],
                [],
                "\n".join(f for f in failures if f.startswith(os.path.basename(path) + ":")),
            )


class NoUnmasteredTkVariableTests(unittest.TestCase):
    """Every tk.StringVar()/IntVar()/BooleanVar()/DoubleVar() construction
    in a scanned file must pass at least one argument (in practice,
    master=<root>) -- a bare zero-argument call binds to whatever
    tk._default_root happens to be at call time, which silently breaks the
    variable when that is not the window's own root."""

    def test_no_bare_tk_variable_constructors(self):
        for path in _target_files():
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if not _uses_tkinter(lines):
                continue

            file_failures = []
            for i, line in enumerate(lines, start=1):
                code = _strip_comment(line)
                for m in _BARE_VAR_RE.finditer(code):
                    file_failures.append(
                        f"{os.path.basename(path)}:{i}: "
                        f"`{m.group(1)}()` constructed with no arguments -- "
                        f"pass an explicit master, e.g. "
                        f"`{m.group(1)}(master=root)` (using this window's "
                        f"actual root/Toplevel variable name), or it will "
                        f"silently bind to a stale tk._default_root instead "
                        f"of the window that owns its widget. See "
                        f"device_audit.py for the full explanation."
                    )

            self.assertEqual(file_failures, [], "\n".join(file_failures))


class ExemptionSanityTests(unittest.TestCase):
    """Guards the exemption list itself from silently growing stale: each
    named exemption must still exist on disk, and this test file's
    understanding of *why* each is exempt must still hold for
    build_mode_cleanup.py (no Tk variables at all)."""

    def test_exempt_files_still_exist(self):
        for name in _EXEMPT_FILES:
            path = os.path.join(BRIDGE_DIR, name)
            self.assertTrue(
                os.path.isfile(path),
                f"exempt file {name!r} no longer exists at {path!r} -- "
                f"remove it from _EXEMPT_FILES in this test",
            )

    def test_build_mode_cleanup_still_has_no_bare_tk_variables(self):
        """build_mode_cleanup.py is exempt from NoUnmasteredTkVariableTests
        on the assumption none of its Tk variables are BARE (zero-argument)
        constructions -- it does declare one Tk variable
        (`tk.StringVar(value=_STATE_LEAVE)` at line 563) but that call
        passes a value argument, so it falls outside the pattern this guard
        flags. If a future edit adds a genuinely bare constructor here, the
        real NoUnmasteredTkVariableTests guard above only skips this file
        because of _EXEMPT_FILES -- so re-check that exemption too, not
        just this sanity check."""
        path = os.path.join(BRIDGE_DIR, "build_mode_cleanup.py")
        if not os.path.isfile(path):
            self.skipTest("build_mode_cleanup.py not present")
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        found = [
            f"line {i}: {line.strip()}"
            for i, line in enumerate(lines, start=1)
            for m in _BARE_VAR_RE.finditer(_strip_comment(line))
        ]
        self.assertEqual(
            found, [],
            "build_mode_cleanup.py now declares a BARE Tk variable:\n"
            + "\n".join(found)
            + "\n-- it is exempt from NoUnmasteredTkVariableTests; remove "
            "the exemption in this test's _EXEMPT_FILES and let the real "
            "guard tests cover it.",
        )


if __name__ == "__main__":
    unittest.main()
