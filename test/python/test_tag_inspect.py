"""Tests for tag_inspect.py: the Verse Tag Inspector module.

See media/uefn-bridge/tag_inspect.py's module docstring for the WHY (the
flat uefn_get_property reader can't see Verse tags because they live on a
component, not the actor -- ~200 correctly-tagged actors were once reported
as "no tags applied" because of this, sending an investigation in the wrong
direction for a full session).

This file covers ONLY the "PURE / unreal-free functions" section (see the
banner comment in tag_inspect.py) plus inspect_tags()'s documented
unreal-absent fallback shape. The live editor path (_inspect_tags_live,
_find_tag_component, etc.) touches `unreal` directly and cannot be
exercised without a running UEFN session -- covering the pure logic
thoroughly is what stands in for that, per this module's own docstring.

Loaded the same way every other bridge-module test loads its target: put
media/uefn-bridge on sys.path via _bridge_helpers.ensure_bridge_on_path(),
then `import tag_inspect` directly (not a package import).

unreal-absence caveat: by the time `unittest discover` reaches this file,
several earlier test modules in the same process have already called
_bridge_helpers.stub_unreal() at module-import time and never undone it, so
sys.modules["unreal"] is commonly already a MagicMock before this file's
top-level `import tag_inspect` runs. For most tests here that's harmless --
none of the PURE functions under test touch `unreal` or the module's
_HAS_UNREAL flag at all. But InspectTagsUnrealAbsentTests specifically
exercises the "unreal is genuinely unavailable" branch, so it pops
sys.modules entries for unreal/tag_inspect/device_audit/property_inspector
first and does a brand-new import, then restores prior state -- same
technique as test_bridge_sys_path_shield.py's
_fresh_import_with_decoy_path_entry.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path  # noqa: E402

ensure_bridge_on_path()
import tag_inspect  # noqa: E402


# ---------------------------------------------------------------------------
# resolve_parent_chain -- the spec's own worked examples must reproduce
# exactly.
# ---------------------------------------------------------------------------

class ResolveParentChainTests(unittest.TestCase):
    def test_two_level_chain_matches_spec_example(self):
        class_map = {
            "t_area_hoth": "t_area",
            "t_area": "tag",
        }
        chain = tag_inspect.resolve_parent_chain("t_area_hoth", class_map)
        self.assertEqual(chain, ["t_area", "tag"])

    def test_three_level_chain_matches_spec_example(self):
        class_map = {
            "t_sg_random_guard_marker": "t_sg_spawn_marker",
            "t_sg_spawn_marker": "t_sg_spawn_system",
            "t_sg_spawn_system": "tag",
        }
        chain = tag_inspect.resolve_parent_chain("t_sg_random_guard_marker", class_map)
        self.assertEqual(chain, ["t_sg_spawn_marker", "t_sg_spawn_system", "tag"])

    def test_unknown_parent_returns_none(self):
        class_map = {"orphan": "not_declared_anywhere"}
        self.assertIsNone(tag_inspect.resolve_parent_chain("orphan", class_map))

    def test_class_with_no_entry_returns_none(self):
        self.assertIsNone(tag_inspect.resolve_parent_chain("never_declared", {}))


# ---------------------------------------------------------------------------
# build_tag_class_set -- project-agnosticism is the point (spec acceptance
# criterion 7): no filename or naming-prefix assumption baked in.
# ---------------------------------------------------------------------------

class BuildTagClassSetTests(unittest.TestCase):
    def test_chain_not_terminating_at_tag_is_excluded(self):
        class_map = {"my_device": "creative_device"}
        tag_classes = tag_inspect.build_tag_class_set(class_map)
        self.assertNotIn("my_device", tag_classes)

    def test_chain_terminating_at_tag_is_included(self):
        class_map = {
            "t_area_hoth": "t_area",
            "t_area": "tag",
            "my_device": "creative_device",
        }
        tag_classes = tag_inspect.build_tag_class_set(class_map)
        self.assertIn("t_area_hoth", tag_classes)
        self.assertEqual(tag_classes["t_area_hoth"], ["t_area", "tag"])
        self.assertIn("t_area", tag_classes)
        self.assertEqual(tag_classes["t_area"], ["tag"])
        self.assertNotIn("my_device", tag_classes)

    def test_tag_names_with_no_t_prefix_are_recognized(self):
        """No naming-prefix assumption is baked in: a project that names its
        gameplay tags with an entirely different convention must be
        recognized purely from its class(...) ancestry."""
        class_map = {
            "zone_alpha": "zone_base",
            "zone_base": "tag",
        }
        tag_classes = tag_inspect.build_tag_class_set(class_map)
        self.assertIn("zone_alpha", tag_classes)
        self.assertEqual(tag_classes["zone_alpha"], ["zone_base", "tag"])
        self.assertIn("zone_base", tag_classes)
        self.assertEqual(tag_classes["zone_base"], ["tag"])


# ---------------------------------------------------------------------------
# Cycle safety -- a malformed project must not hang or crash the editor.
# ---------------------------------------------------------------------------

class CycleSafetyTests(unittest.TestCase):
    def test_two_class_cycle_terminates_without_raising(self):
        class_map = {"a": "b", "b": "a"}
        try:
            result = tag_inspect.resolve_parent_chain("a", class_map)
        except Exception as e:  # pragma: no cover - failure path
            self.fail(f"resolve_parent_chain raised on a cycle: {e!r}")
        self.assertIsNone(result)

    def test_self_referential_class_terminates(self):
        class_map = {"a": "a"}
        try:
            result = tag_inspect.resolve_parent_chain("a", class_map)
        except Exception as e:  # pragma: no cover - failure path
            self.fail(f"resolve_parent_chain raised on self-reference: {e!r}")
        self.assertIsNone(result)

    def test_build_tag_class_set_survives_cyclic_map_without_raising(self):
        class_map = {"a": "b", "b": "a", "clean_child": "clean_parent", "clean_parent": "tag"}
        try:
            tag_classes = tag_inspect.build_tag_class_set(class_map)
        except Exception as e:  # pragma: no cover - failure path
            self.fail(f"build_tag_class_set raised on a cyclic map: {e!r}")
        self.assertNotIn("a", tag_classes)
        self.assertNotIn("b", tag_classes)
        self.assertIn("clean_child", tag_classes)


# ---------------------------------------------------------------------------
# extract_class_declarations / build_class_map
# ---------------------------------------------------------------------------

class ExtractClassDeclarationsTests(unittest.TestCase):
    def test_realistic_multiline_snippet(self):
        text = (
            "t_area_hoth := class(t_area):\n"
            "    # a comment inside the class body\n"
            "    Foo():void=\n"
            "        0\n"
            "\n"
            "# t_disabled_experiment := class(tag)\n"
            "t_area := class(tag):\n"
            "    var X : int = 0\n"
            "\n"
            "SomeFunction(x : int):void=\n"
            "    0\n"
        )
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(
            declarations,
            {"t_area_hoth": "t_area", "t_area": "tag"},
        )
        self.assertNotIn("t_disabled_experiment", declarations)

    def test_whitespace_variations_around_walrus_and_class(self):
        tight = "t_area_hoth:=class(t_area)\n"
        spaced = "t_area_hoth   :=   class(t_area)\n"
        self.assertEqual(tag_inspect.extract_class_declarations(tight), {"t_area_hoth": "t_area"})
        self.assertEqual(tag_inspect.extract_class_declarations(spaced), {"t_area_hoth": "t_area"})

    def test_commented_out_line_not_matched(self):
        text = "# t_area_hoth := class(t_area)\n"
        self.assertEqual(tag_inspect.extract_class_declarations(text), {})

    def test_unrelated_syntax_not_matched(self):
        text = (
            "t_area_hoth := struct(t_area)\n"  # struct, not class
            "Foo(x : int):void=\n"             # ordinary function
            "    class_thing := 5\n"           # 'class' appears but not as class(
        )
        self.assertEqual(tag_inspect.extract_class_declarations(text), {})

    def test_empty_and_none_text_never_raise(self):
        self.assertEqual(tag_inspect.extract_class_declarations(""), {})
        self.assertEqual(tag_inspect.extract_class_declarations(None), {})

    def test_later_line_wins_for_duplicate_child_name(self):
        text = "dup := class(first_parent)\ndup := class(second_parent)\n"
        self.assertEqual(tag_inspect.extract_class_declarations(text), {"dup": "second_parent"})


class BuildClassMapTests(unittest.TestCase):
    def test_merges_across_files_later_file_wins(self):
        file_a = "t_area := class(tag)\n"
        file_b = "t_area_hoth := class(t_area)\n"
        file_c = "t_area := class(some_other_base)\n"  # later file overrides file_a
        class_map = tag_inspect.build_class_map([file_a, file_b, file_c])
        self.assertEqual(class_map["t_area_hoth"], "t_area")
        self.assertEqual(class_map["t_area"], "some_other_base")


# ---------------------------------------------------------------------------
# Indented declarations -- the leading-\s* widening of _CLASS_DECL_RE. Tag
# classes are very commonly declared inside an indented Verse `module`
# block; before the widening those lines were silently skipped (see
# extract_class_declarations' own docstring for the field history).
# ---------------------------------------------------------------------------

class IndentedDeclarationsTests(unittest.TestCase):
    def test_indented_declarations_inside_module_block_are_collected(self):
        text = (
            "game_tags := module:\n"
            "    t_area := class(tag){}\n"
            "    t_area_hoth := class(t_area){}\n"
        )
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(
            declarations,
            {"t_area": "tag", "t_area_hoth": "t_area"},
        )
        class_map = tag_inspect.build_class_map([text])
        chain = tag_inspect.resolve_parent_chain("t_area_hoth", class_map)
        self.assertEqual(chain, ["t_area", "tag"])

    def test_mixed_tab_and_space_indentation_both_collected(self):
        text = (
            "game_tags := module:\n"
            "\tt_area := class(tag){}\n"
            "    t_area_hoth := class(t_area){}\n"
        )
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(
            declarations,
            {"t_area": "tag", "t_area_hoth": "t_area"},
        )


# ---------------------------------------------------------------------------
# <# ... #> Verse block-comment masking -- landing in parallel with this
# test file. A declaration-shaped line sitting inside a block comment must
# NOT be treated as a real declaration; the leading-\s* widening above
# newly extends the false-positive risk to INDENTED such lines too (see
# extract_class_declarations' "KNOWN, PRE-EXISTING, NOT-FIXED-HERE GAP"
# docstring paragraph -- this group is the coverage that paragraph calls
# for once the masking lands).
# ---------------------------------------------------------------------------

class BlockCommentMaskingTests(unittest.TestCase):
    def test_declaration_inside_multiline_block_comment_not_collected(self):
        text = (
            "<#\n"
            "t_disabled := class(tag)\n"
            "#>\n"
            "t_area := class(tag)\n"
        )
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(declarations, {"t_area": "tag"})
        self.assertNotIn("t_disabled", declarations)

    def test_declaration_inside_single_line_block_comment_not_collected(self):
        text = "<# t_disabled := class(tag) #>\nt_area := class(tag)\n"
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(declarations, {"t_area": "tag"})
        self.assertNotIn("t_disabled", declarations)

    def test_real_code_after_block_comment_closes_same_line_is_collected(self):
        text = "<# comment #> t_area := class(tag)\n"
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(declarations, {"t_area": "tag"})

    def test_indented_declaration_inside_block_comment_not_collected(self):
        """The case the leading-\\s* widening made newly reachable: an
        indented declaration-shaped line inside a block comment, nested
        inside a `module` block."""
        text = (
            "game_tags := module:\n"
            "    <#\n"
            "    t_disabled := class(tag)\n"
            "    #>\n"
            "    t_area := class(tag)\n"
        )
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(declarations, {"t_area": "tag"})
        self.assertNotIn("t_disabled", declarations)


# ---------------------------------------------------------------------------
# # line comments -- must never be collected regardless of indentation or
# whether a space follows the '#'. Already covered at zero indentation by
# ExtractClassDeclarationsTests.test_commented_out_line_not_matched; this
# group is the fuller indentation x spacing matrix.
# ---------------------------------------------------------------------------

class LineCommentTests(unittest.TestCase):
    def test_zero_indent_hash_with_space_not_collected(self):
        text = "# t_area := class(tag)\n"
        self.assertEqual(tag_inspect.extract_class_declarations(text), {})

    def test_zero_indent_hash_without_space_not_collected(self):
        text = "#t_area := class(tag)\n"
        self.assertEqual(tag_inspect.extract_class_declarations(text), {})

    def test_indented_hash_with_space_not_collected(self):
        text = "    # t_area := class(tag)\n"
        self.assertEqual(tag_inspect.extract_class_declarations(text), {})

    def test_indented_hash_without_space_not_collected(self):
        text = "    #t_area := class(tag)\n"
        self.assertEqual(tag_inspect.extract_class_declarations(text), {})


# ---------------------------------------------------------------------------
# Regression guard -- a plain, non-indented declaration set must produce
# the exact same declarations / tag-class set / parent chains as before
# both changes landed. The widening and the masking must only WIDEN what
# is reachable, never alter existing column-0 behavior.
# ---------------------------------------------------------------------------

class RegressionGuardTests(unittest.TestCase):
    def test_plain_nonindented_declarations_unaffected_by_widening(self):
        text = (
            "t_area := class(tag)\n"
            "t_area_hoth := class(t_area)\n"
            "t_sg_spawn_system := class(tag)\n"
            "t_sg_spawn_marker := class(t_sg_spawn_system)\n"
            "my_device := class(creative_device)\n"
        )
        declarations = tag_inspect.extract_class_declarations(text)
        self.assertEqual(
            declarations,
            {
                "t_area": "tag",
                "t_area_hoth": "t_area",
                "t_sg_spawn_system": "tag",
                "t_sg_spawn_marker": "t_sg_spawn_system",
                "my_device": "creative_device",
            },
        )
        class_map = tag_inspect.build_class_map([text])
        tag_classes = tag_inspect.build_tag_class_set(class_map)
        self.assertEqual(
            tag_classes,
            {
                "t_area": ["tag"],
                "t_area_hoth": ["t_area", "tag"],
                "t_sg_spawn_system": ["tag"],
                "t_sg_spawn_marker": ["t_sg_spawn_system", "tag"],
            },
        )
        self.assertNotIn("my_device", tag_classes)


# ---------------------------------------------------------------------------
# match_label
# ---------------------------------------------------------------------------

class MatchLabelTests(unittest.TestCase):
    def test_substring_match_is_case_insensitive(self):
        self.assertTrue(tag_inspect.match_label("R1_P1 - SGMarker Rand 1", "SGMarker"))
        self.assertTrue(tag_inspect.match_label("r1_p1 - sgmarker rand 1", "SGMARKER"))

    def test_substring_no_match(self):
        self.assertFalse(tag_inspect.match_label("R1_P1 - SGMarker Rand 1", "NotPresent"))

    def test_wildcard_pattern_matches(self):
        self.assertTrue(tag_inspect.match_label("R4_P1_SomethingElse", "R4_P1*"))
        self.assertFalse(tag_inspect.match_label("R5_P1_SomethingElse", "R4_P1*"))

    def test_wildcard_is_case_insensitive(self):
        self.assertTrue(tag_inspect.match_label("r4_p1_something", "R4_P1*"))

    def test_empty_or_none_pattern_matches_everything(self):
        self.assertTrue(tag_inspect.match_label("anything at all", ""))
        self.assertTrue(tag_inspect.match_label("anything at all", None))
        self.assertTrue(tag_inspect.match_label("", None))


# ---------------------------------------------------------------------------
# sort_actors_flagged_first -- the core safety property this tool exists
# for: flagged (untagged/no-component) actors must never be buried, and no
# actor may ever be dropped.
# ---------------------------------------------------------------------------

class SortActorsFlaggedFirstTests(unittest.TestCase):
    def test_flagged_actors_sort_before_tagged_actors_stably_no_drops(self):
        actors = [
            {"label": "A_tagged", "has_verse_tag_component": True, "tags": ["t1"]},
            {"label": "B_no_component", "has_verse_tag_component": False, "tags": []},
            {"label": "C_empty_tags", "has_verse_tag_component": True, "tags": []},
            {"label": "D_tagged", "has_verse_tag_component": True, "tags": ["t2"]},
            {"label": "E_no_component", "has_verse_tag_component": False, "tags": []},
            {"label": "F_tagged", "has_verse_tag_component": True, "tags": ["t3", "t4"]},
        ]
        result = tag_inspect.sort_actors_flagged_first(actors)

        # No actor dropped.
        self.assertEqual(len(result), len(actors))
        self.assertEqual(
            {a["label"] for a in result},
            {a["label"] for a in actors},
        )

        labels = [a["label"] for a in result]
        # Both flagged kinds (no component, empty tags) sort before every
        # tagged actor.
        self.assertEqual(labels, [
            "B_no_component", "C_empty_tags", "E_no_component",
            "A_tagged", "D_tagged", "F_tagged",
        ])

    def test_all_flagged_preserved(self):
        actors = [
            {"label": "X", "has_verse_tag_component": False, "tags": []},
            {"label": "Y", "has_verse_tag_component": True, "tags": []},
        ]
        result = tag_inspect.sort_actors_flagged_first(actors)
        self.assertEqual([a["label"] for a in result], ["X", "Y"])

    def test_all_tagged_preserved_in_original_order(self):
        actors = [
            {"label": "X", "has_verse_tag_component": True, "tags": ["a"]},
            {"label": "Y", "has_verse_tag_component": True, "tags": ["b"]},
        ]
        result = tag_inspect.sort_actors_flagged_first(actors)
        self.assertEqual([a["label"] for a in result], ["X", "Y"])

    def test_empty_list_returns_empty_list(self):
        self.assertEqual(tag_inspect.sort_actors_flagged_first([]), [])


# ---------------------------------------------------------------------------
# normalize_tag_name -- documented best-effort behavior only. The exact
# live string form of a Verse tag value coming out of a real
# GameplayTagContainer is explicitly UNVERIFIED without a live UEFN editor
# session (see the module docstring and normalize_tag_name's own
# docstring) -- do not assert on any input shape beyond what the docstring
# itself claims.
# ---------------------------------------------------------------------------

class NormalizeTagNameTests(unittest.TestCase):
    def test_plain_name_passes_through(self):
        self.assertEqual(tag_inspect.normalize_tag_name("t_area_hoth"), "t_area_hoth")

    def test_strips_repr_style_wrapper(self):
        self.assertEqual(tag_inspect.normalize_tag_name("GameplayTag'TagName'"), "TagName")

    def test_dotted_value_keeps_final_segment(self):
        self.assertEqual(tag_inspect.normalize_tag_name("Verse.t_area_hoth"), "t_area_hoth")

    def test_wrapper_then_dotted_applies_both_rules_in_order(self):
        self.assertEqual(
            tag_inspect.normalize_tag_name("GameplayTag'Verse.t_area_hoth'"),
            "t_area_hoth",
        )

    def test_none_returns_empty_string(self):
        self.assertEqual(tag_inspect.normalize_tag_name(None), "")

    def test_whitespace_is_stripped(self):
        self.assertEqual(tag_inspect.normalize_tag_name("  t_area_hoth  "), "t_area_hoth")


# ---------------------------------------------------------------------------
# inspect_tags with `unreal` genuinely absent -- must return the documented
# 4-key shape with an explanatory discovery.notes, never a silent/clean
# "found nothing" result (see docs/PATH-DISCOVERY.md: this repo has a
# documented history of tools swallowing failures and returning
# success-looking empty shapes).
# ---------------------------------------------------------------------------

_SIBLING_MODULE_NAMES = ("tag_inspect", "unreal", "device_audit", "property_inspector", "bridge_paths")


class _FreshTagInspectWithoutUnreal:
    """Pops unreal/tag_inspect/its guarded siblings from sys.modules, does a
    brand-new `import tag_inspect` (so the module's own `try: import
    unreal` genuinely fails rather than reusing an already-stubbed
    MagicMock some earlier test file in this same `unittest discover`
    process left behind), and restores prior sys.modules state on exit --
    same technique as test_bridge_sys_path_shield.py's
    _fresh_import_with_decoy_path_entry."""

    def __enter__(self):
        self._saved = {name: sys.modules.pop(name, None) for name in _SIBLING_MODULE_NAMES}
        import tag_inspect as fresh_mod  # noqa: E402  (fresh exec)
        self.module = fresh_mod
        return fresh_mod

    def __exit__(self, exc_type, exc, tb):
        sys.modules.pop("tag_inspect", None)
        for name, mod in self._saved.items():
            if mod is not None:
                sys.modules[name] = mod
            else:
                sys.modules.pop(name, None)
        return False


class InspectTagsUnrealAbsentTests(unittest.TestCase):
    def test_returns_documented_shape_with_explanatory_notes_not_empty_success(self):
        with _FreshTagInspectWithoutUnreal() as fresh:
            self.assertFalse(
                fresh._HAS_UNREAL,
                "test setup failed to simulate unreal's genuine absence -- "
                "an earlier test file's stubbed sys.modules['unreal'] leaked in",
            )
            scratch = tempfile.mkdtemp(prefix="tag_inspect_report_test_")
            primary = os.path.join(scratch, "primary", "tag_inspect_report.json")
            fallback_dir = os.path.join(scratch, "fallback")
            os.makedirs(fallback_dir, exist_ok=True)
            orig_report_path = fresh.report_path
            orig_get_bridge_dir = fresh._get_bridge_dir
            fresh.report_path = lambda: primary
            fresh._get_bridge_dir = lambda: fallback_dir
            try:
                result = fresh.inspect_tags(label_pattern="SGMarker*")
            finally:
                fresh.report_path = orig_report_path
                fresh._get_bridge_dir = orig_get_bridge_dir

        self.assertEqual(
            set(result.keys()),
            {"discovery", "verse_dir", "tag_class_count", "actors"},
        )
        self.assertEqual(result["actors"], [])
        self.assertEqual(result["tag_class_count"], 0)
        self.assertIsNone(result["verse_dir"])

        discovery = result["discovery"]
        self.assertIsNone(discovery["component_class"])
        self.assertIsNone(discovery["tag_property"])
        # Must NOT be a silent/blank notes string -- the whole point is that
        # this is distinguishable from "scanned and found zero tagged
        # actors".
        self.assertTrue(discovery["notes"])
        notes_lower = discovery["notes"].lower()
        self.assertIn("unreal", notes_lower)
        self.assertIn("not available", notes_lower)


if __name__ == "__main__":
    unittest.main()
