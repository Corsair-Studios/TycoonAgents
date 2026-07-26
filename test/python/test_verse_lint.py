"""Tests for verse_lint.py: the deterministic check for unguarded
`set Map[Key] = Value` subscript writes (missing the Verse 'decides'
failure context).

Ground truth for every trap below is the REAL 1,204-line file that
originally failed to compile with:

    "This invocation calls a function that has the 'decides' effect,
    which is not allowed by its context"

(illest_global_ui_manager.verse, 11 map-write sites, all now correct).
Each trap test reproduces one exact shape from that file.

verse_lint.py lives in media/skills/uefn/ (installs next to
verse-common-errors.md), NOT in media/uefn-bridge/, so it is loaded via
its own sys.path insert rather than _bridge_helpers' bridge-dir helpers.
"""
import os
import sys
import unittest

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(_THIS_DIR, "..", ".."))
SKILL_DIR = os.path.join(REPO_ROOT, "media", "skills", "uefn")

sys.path.insert(0, SKILL_DIR)
import verse_lint  # noqa: E402


def _lines(*lines):
    return "\n".join(lines)


class TruePositiveTests(unittest.TestCase):
    def test_bare_unguarded_write_is_flagged(self):
        src = _lines(
            "Foo<public>(Player:player):void=",
            "    set PlayerInitialized[Player] = true",
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["line"], 2)
        self.assertEqual(findings[0]["target"], "PlayerInitialized")

    def test_non_vacuity_disabling_detection_makes_this_fail(self):
        """Proves the true-positive test above actually exercises the
        write-detection regex, not a vacuously-passing assertion: swap in
        a pattern that can never match, confirm zero findings result
        (i.e. the test WOULD fail), then restore the real detector."""
        src = _lines(
            "Foo<public>(Player:player):void=",
            "    set PlayerInitialized[Player] = true",
        )
        original = verse_lint._WRITE_RE
        try:
            verse_lint._WRITE_RE = verse_lint.re.compile(r"THIS_CAN_NEVER_MATCH_ANYTHING")
            neutered_findings = verse_lint.lint_verse_source(src, "x.verse")
            self.assertEqual(
                len(neutered_findings), 0,
                "sanity check itself is broken: neutering detection should "
                "silence the true positive",
            )
        finally:
            verse_lint._WRITE_RE = original
        # Detection restored -- the real true-positive test must pass again.
        restored_findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(restored_findings), 1)


class CorrectIdiomTests(unittest.TestCase):
    def test_bare_if_colon_idiom_is_not_flagged(self):
        """The universal correct idiom from the real file."""
        src = _lines(
            "Foo<public>(Player:player):void=",
            "    if:",
            "        set PlayerInitialized[Player] = true",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_multiple_writes_under_one_if_block_all_pass(self):
        src = _lines(
            "Foo<public>(Player:player):void=",
            "    if:",
            "        set PlayerCurrencyWidgets[Player] = WidgetMap",
            "        set PlayerCanvases[Player] = CurrencyCanvas",
            "        set PlayerInitialized[Player] = true",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_decides_function_permits_bare_write(self):
        src = _lines(
            "Foo<public><decides>(Player:player):void=",
            "    set PlayerInitialized[Player] = true",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])


class OptionBraceTests(unittest.TestCase):
    """Review-gate finding 1: `option{}` only permitted when the line
    LITERALLY starts with `option`, missing the documented assignment
    form (verse-common-errors.md:466,493) and flagging a correctly-guarded
    write as unguarded."""

    def test_option_assignment_form_from_docs_is_not_flagged(self):
        """The reviewer's exact repro shape."""
        src = _lines(
            "Foo<public>():void=",
            "    Result : ?logic = option{",
            "        set Map[Key] = true",
            "        true",
            "    }",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_option_bare_form_is_not_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            "    option{",
            "        set Map[Key] = true",
            "    }",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_option_nested_inside_non_permitting_else_still_permits(self):
        src = _lines(
            "Foo<public>():void=",
            "    if (Cond):",
            "        DoA()",
            "    else:",
            "        Result : ?logic = option{",
            "            set Map[Key] = true",
            "            true",
            "        }",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_option_single_line_closed_form_is_not_flagged(self):
        """Review-gate finding 3: `option{ ... }` opened AND closed on one
        physical line was still flagged, because `_is_inline_guarded` only
        recognized same-line `if(`/`for(`, never `option{`."""
        src = _lines(
            "Foo<public>():void=",
            "    option{ set Map[Key] = true }",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_option_single_line_identifier_suffix_negatives_do_not_permit(self):
        for prefix in ("my_option{", "options{"):
            with self.subTest(prefix=prefix):
                src = _lines(
                    "Foo<public>():void=",
                    f"    {prefix} set Map[Key] = true }}",
                )
                findings = verse_lint.lint_verse_source(src, "x.verse")
                self.assertEqual(len(findings), 1)

    def test_option_identifier_suffix_negatives_do_not_permit(self):
        """`my_option{` and `options{` must NOT be treated as the `option`
        keyword -- only the bare keyword counts."""
        for prefix in ("my_option{", "options{"):
            with self.subTest(prefix=prefix):
                src = _lines(
                    "Foo<public>():void=",
                    f"    Result := {prefix}",
                    "        set Map[Key] = true",
                    "    }",
                )
                findings = verse_lint.lint_verse_source(src, "x.verse")
                self.assertEqual(len(findings), 1)


class TrapTests(unittest.TestCase):
    """Every trap is a real shape from illest_global_ui_manager.verse.
    Each MUST NOT be flagged."""

    def test_trap1_write_inlined_in_if_condition(self):
        src = _lines(
            "SetUIHidden<public>(Player:player,Hidden:logic):void=",
            "    if (set UIHidden[Player] = Hidden) {}",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap2_method_call_brackets_not_a_subscript_write(self):
        src = _lines(
            "CleanupRoomRewardCounterWidget<private>(TargetPlayer:player):void=",
            "    if:",
            "        PlayerCurrencyWidgets = PlayerCurrencyWidgets.RemoveByKey[TargetPlayer]",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap3_commented_out_map_write(self):
        src = _lines(
            "Foo<public>():void=",
            "    # if:",
            "    #     set PlayerDebugCanvases[Player] = DebugCanvas",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap4_read_via_walrus_looks_similar_but_is_not_a_write(self):
        src = _lines(
            "Foo<public>():void=",
            "    if (CurrencyWidget := WidgetMap[Currency]):",
            "        DoSomething()",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap5_find_returning_int_outside_failure_context(self):
        src = _lines(
            "Foo<public>():void=",
            "    Index := SomeArray.Find[TargetValue]",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap6_multiline_wrapped_subscript_is_a_documented_blind_spot(self):
        """Single-line-only detector: a write whose subscript/'=' wraps to
        the next physical line is silently NOT flagged. This is a known,
        documented limitation (see module docstring), not a bug -- the
        test locks in the current (silent) behavior so a future change
        that starts flagging it is a deliberate, visible decision."""
        src = _lines(
            "Foo<public>():void=",
            "    set SomeReallyLongMapNameHere[",
            "        Key",
            "    ] = Value",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])


class MixedGuardedUnguardedTests(unittest.TestCase):
    def test_only_unguarded_writes_in_a_mixed_file_are_flagged(self):
        src = _lines(
            "Foo<public>(Player:player):void=",              # 1
            "    if:",                                        # 2
            "        set Guarded1[Player] = true",             # 3 (guarded)
            "    set Unguarded1[Player] = true",                # 4 (unguarded)
            "    if (Cond := Guarded1[Player]):",               # 5
            "        set Guarded2[Player] = Cond",              # 6 (guarded)
            "    set Unguarded2[Player] = false",                # 7 (unguarded)
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        flagged_lines = sorted(f["line"] for f in findings)
        self.assertEqual(flagged_lines, [4, 7])
        flagged_targets = sorted(f["target"] for f in findings)
        self.assertEqual(flagged_targets, ["Unguarded1", "Unguarded2"])


class GroundTruthFileTests(unittest.TestCase):
    """If the real ground-truth file is present on this machine (it is a
    creator project outside the repo, so CI/other machines won't have it),
    prove it produces zero findings -- all 11 sites there are correct."""

    GROUND_TRUTH_PATH = os.path.join(
        os.path.expanduser("~"), "OneDrive", "Documents", "Fortnite Projects",
        "StarWars", "Content", "Gorillas", "Framework", "GameSystems",
        "illest_global_ui_manager.verse",
    )

    def test_real_file_has_zero_findings_if_present(self):
        if not os.path.isfile(self.GROUND_TRUTH_PATH):
            self.skipTest("ground-truth file not present on this machine")
        findings, scanned, skipped = verse_lint.lint_path(self.GROUND_TRUTH_PATH)
        self.assertEqual(
            findings, [],
            f"expected 0 findings against known-correct file, got: {findings}",
        )
        self.assertEqual(scanned, 1)
        self.assertEqual(skipped, [])


class CliTests(unittest.TestCase):
    def test_main_returns_nonzero_when_findings_exist(self, ):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.verse")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("Foo<public>():void=\n    set Bad[Key] = 1\n")
            self.assertEqual(verse_lint.main([path]), 1)

    def test_main_returns_zero_when_clean(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "good.verse")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("Foo<public>():void=\n    if:\n        set Ok[Key] = 1\n")
            self.assertEqual(verse_lint.main([path]), 0)

    def test_main_no_args_exits_2(self):
        self.assertEqual(verse_lint.main([]), 2)


class IncompleteScanTests(unittest.TestCase):
    """Review-gate finding 2: an unreadable file (or a target that matched
    zero .verse files) must never present as a clean exit-0 result."""

    def test_unreadable_file_yields_incomplete_exit_and_visible_message(self):
        import builtins
        import contextlib
        import io
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "broken.verse")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("Foo<public>():void=\n    if:\n        set Ok[Key] = 1\n")

            real_open = builtins.open

            def failing_open(file, *args, **kwargs):
                if os.fspath(file) == path:
                    raise OSError("simulated unreadable file")
                return real_open(file, *args, **kwargs)

            buf = io.StringIO()
            with mock.patch("builtins.open", side_effect=failing_open):
                with contextlib.redirect_stdout(buf):
                    exit_code = verse_lint.main([path])

        self.assertEqual(exit_code, verse_lint.EXIT_INCOMPLETE_SCAN)
        self.assertNotEqual(exit_code, verse_lint.EXIT_FINDINGS)
        output = buf.getvalue()
        self.assertIn("SKIPPED", output)
        self.assertIn("simulated unreadable file", output)
        self.assertIn("INCOMPLETE SCAN", output)

    def test_directory_with_no_verse_files_is_incomplete_not_clean(self):
        import contextlib
        import io
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                exit_code = verse_lint.main([tmp])

        self.assertEqual(exit_code, verse_lint.EXIT_INCOMPLETE_SCAN)
        self.assertIn("INCOMPLETE SCAN", buf.getvalue())

    def test_exit_codes_are_all_distinct(self):
        codes = {
            verse_lint.EXIT_OK,
            verse_lint.EXIT_FINDINGS,
            verse_lint.EXIT_USAGE_ERROR,
            verse_lint.EXIT_INCOMPLETE_SCAN,
        }
        self.assertEqual(len(codes), 4)


if __name__ == "__main__":
    unittest.main()
