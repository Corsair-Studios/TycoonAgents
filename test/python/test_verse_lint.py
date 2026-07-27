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


class WalrusComparisonTests(unittest.TestCase):
    """Category A: a bare comparison bound with `:=` outside a failure
    context (error 3512). Ground truth is
    docs/VERSE-AGENT-COMPILE-FAILURES.md, category 2."""

    def test_bare_ge_comparison_bound_with_walrus_is_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            "    HasCooledDown := (Now - LastPlayedTime) >= CooldownSeconds",
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["category"], "unguarded-comparison-walrus")
        self.assertEqual(findings[0]["target"], "HasCooledDown")
        self.assertEqual(findings[0]["line"], 2)

    def test_bare_eq_comparison_bound_with_walrus_is_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            "    IsFirstTrigger := LastPlayedTime = 0.0",
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["target"], "IsFirstTrigger")

    def test_documented_right_idiom_is_not_flagged(self):
        """The exact RIGHT rewrite from the incident report."""
        src = _lines(
            "Foo<public>():void=",
            "    var MayPlay : logic = false",
            "    if (LastPlayedTime <= 0.0):",
            "        set MayPlay = true",
            "    else if ((Now - LastPlayedTime) >= CooldownSeconds):",
            "        set MayPlay = true",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_decides_function_permits_walrus_comparison(self):
        src = _lines(
            "Foo<public><decides>():void=",
            "    HasCooledDown := (Now - LastPlayedTime) >= CooldownSeconds",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_if_colon_block_permits_walrus_comparison(self):
        src = _lines(
            "Foo<public>():void=",
            "    if:",
            "        HasCooledDown := (Now - LastPlayedTime) >= CooldownSeconds",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_walrus_inside_if_condition_is_not_flagged(self):
        """Trap: `:=` inside an `if (...)` condition is already a failure
        context and must NOT fire."""
        src = _lines(
            "Foo<public>():void=",
            "    if (HasCooledDown := (Now - LastPlayedTime) >= CooldownSeconds):",
            "        DoSomething()",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_effect_specifiers_not_mistaken_for_comparisons(self):
        """Trap: `<suspends>`/`<decides>` effect specifiers must not be
        mistaken for `<`/`>` comparisons, and must not corrupt a genuine,
        comparison-free walrus binding on the next line."""
        src = _lines(
            "Foo<public><suspends><decides>(X:int):void=",
            "    Y := X",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_generic_angle_brackets_not_mistaken_for_comparisons(self):
        """Trap: tight, unspaced `<T>` generic instantiation must not be
        mistaken for a comparison."""
        src = _lines(
            "Foo<public>():void=",
            "    X := Array<int>{}",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_comparison_in_comment_is_not_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            "    X := 5  # was: X := A >= B",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_comparison_in_string_is_not_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            '    X := "A >= B"',
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_named_call_argument_walrus_is_not_flagged(self):
        """A `:=` nested inside a call's parens (a named argument, same
        syntax Category B's `?Name := ...` uses) is a different question
        than a top-level variable binding -- skipped, not guessed at."""
        src = _lines(
            "Foo<public>():void=",
            "    Bar(X := A > B)",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_non_vacuity_disabling_comparison_regex_makes_this_fail(self):
        """Proves the true-positive test above actually exercises
        `_COMPARISON_RE`, not a vacuously-passing assertion."""
        src = _lines(
            "Foo<public>():void=",
            "    HasCooledDown := (Now - LastPlayedTime) >= CooldownSeconds",
        )
        original = verse_lint._COMPARISON_RE
        try:
            verse_lint._COMPARISON_RE = verse_lint.re.compile(r"THIS_CAN_NEVER_MATCH_ANYTHING")
            neutered_findings = verse_lint.lint_verse_source(src, "x.verse")
            self.assertEqual(
                len(neutered_findings), 0,
                "sanity check itself is broken: neutering detection should "
                "silence the true positive",
            )
        finally:
            verse_lint._COMPARISON_RE = original
        restored_findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(restored_findings), 1)


class WalrusComparisonNestingSymmetryTests(unittest.TestCase):
    """Review-gate finding: `_nesting_depth_before` (walrus LHS) tracked
    parens AND braces, but `_has_top_level_comparison` (walrus RHS) only
    tracked parens -- so a comparison nested inside `{}` on the
    right-hand side (a struct/array/map literal) was misattributed to the
    OUTER binding instead of being skipped as ambiguous/nested, same as
    the LHS side already does. Fixed by making both depth checks
    brace-aware. Repro is the reviewer's exact `my_struct{...}` shape."""

    def test_comparison_nested_in_struct_literal_is_not_attributed_to_outer_binding(self):
        src = _lines(
            "Foo<public>():void=",
            "    S := my_struct{Field := 5, Other := X >= 3}",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_comparison_nested_in_map_literal_is_not_attributed_to_outer_binding(self):
        src = _lines(
            "Foo<public>():void=",
            '    Counts := map{"a" => X > 5, "b" => 2}',
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_comparison_nested_in_array_literal_is_not_attributed_to_outer_binding(self):
        src = _lines(
            "Foo<public>():void=",
            "    Values := array{A > B, 3}",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_genuine_top_level_comparison_still_flags_after_brace_fix(self):
        """Confirms the brace-awareness fix narrows, not removes,
        detection: a comparison with no brace nesting at all must still
        be flagged."""
        src = _lines(
            "Foo<public>():void=",
            "    HasCooledDown := (Now - LastPlayedTime) >= CooldownSeconds",
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["target"], "HasCooledDown")


class DoubleWrappedOptionalTests(unittest.TestCase):
    """Category B: `?Name := option{...}` double-wraps an already-optional
    call argument (error 3509). Ground truth is
    docs/VERSE-AGENT-COMPILE-FAILURES.md, category 5."""

    def test_double_wrapped_optional_argument_is_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            "    EmperorSpawner.SpawnAt(Pos, ?Rotation := option{FacingRotation})",
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["category"], "double-wrapped-optional")
        self.assertEqual(findings[0]["target"], "Rotation")
        self.assertEqual(findings[0]["line"], 2)

    def test_correct_unwrapped_optional_argument_is_not_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            "    EmperorSpawner.SpawnAt(Pos, ?Rotation := FacingRotation)",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_multiline_option_guard_idiom_not_mistaken_for_double_wrap(self):
        """The unrelated multi-line `option{` GUARD idiom (no `?Name :=`
        prefix) must never be mistaken for a double-wrapped argument."""
        src = _lines(
            "Foo<public>():void=",
            "    Result : ?logic = option{",
            "        set Map[Key] = true",
            "        true",
            "    }",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_trap_double_wrap_in_comment_is_not_flagged(self):
        src = _lines(
            "Foo<public>():void=",
            "    # EmperorSpawner.SpawnAt(Pos, ?Rotation := option{FacingRotation})",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_double_wrap_fires_regardless_of_failure_context(self):
        """Category B is a pure textual pattern, independent of the
        block-level failure-context stack categories 1 and 2 share."""
        src = _lines(
            "Foo<public>():void=",
            "    if:",
            "        EmperorSpawner.SpawnAt(Pos, ?Rotation := option{FacingRotation})",
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["category"], "double-wrapped-optional")


class RealWorldFalsePositiveRegressionTests(unittest.TestCase):
    """Found by running the new categories against the real, currently-
    compiling StarWars project tree (the acceptance test that matters
    most per the task brief) -- both are PRE-EXISTING gaps in category 1's
    block-stack, newly exposed by scanning a much wider real tree than the
    single ground-truth file the original rule was validated against."""

    def test_else_if_colon_is_recognized_as_permitting(self):
        """illest_safe_zone_tracking.verse:191-197 -- `else if:` was only
        matched as keyword 'else' (non-permitting) because keyword
        extraction stopped at the first token; 'if' was never seen."""
        src = _lines(
            "SetStoredOverlapCount<private>(Player : player, Count : int) : void =",
            "    if (Count <= 0):",
            "        ClearStoredOverlapCount(Player)",
            "    else if:",
            "        set SafeZoneOverlapCountByPlayer[Player] = Count",
            "    then:",
            "        false",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_brace_bodied_decides_function_header_is_recognized(self):
        """illest_player_persistence_manager.verse:281-297 -- a
        `<decides>` function using brace-body style (`...:void = {`
        instead of bare-`=`/colon-indented style) was pushed as a
        non-permitting frame because only the bare-`=`-ending header shape
        was recognized as a function header."""
        src = _lines(
            "PersistCurrency<public>(CurrencyKey:string, Amount:int)<transacts><decides>:void = {",
            "    if:",
            "        OldStats := GetStats()",
            "    then:",
            "        var NewCurrencies : [string]int = OldStats",
            "        set NewCurrencies[CurrencyKey] = Amount",
            "}",
        )
        self.assertEqual(verse_lint.lint_verse_source(src, "x.verse"), [])

    def test_brace_bodied_non_decides_function_still_flags(self):
        """Same brace-body header shape WITHOUT <decides> must still flag
        an unguarded write -- the fix only widens which headers are
        recognized, it does not blanket-permit every brace-bodied
        function."""
        src = _lines(
            "Foo<public>(X:int):void = {",
            "    set Bad[X] = true",
            "}",
        )
        findings = verse_lint.lint_verse_source(src, "x.verse")
        self.assertEqual(len(findings), 1)


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
