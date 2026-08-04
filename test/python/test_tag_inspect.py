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
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
import tag_inspect  # noqa: E402

# uefn_launcher.py does an UNGUARDED `import unreal` at module scope (unlike
# tag_inspect.py's own guarded import), so it needs the stub in place first
# -- same technique as test_uefn_launcher_mcp_panel.py. This does not affect
# tag_inspect's own already-imported module object above (its _HAS_UNREAL
# flag was already latched at the `import tag_inspect` line before this
# runs), and InspectTagsUnrealAbsentTests below pops sys.modules["unreal"]
# itself before doing its own fresh import, so it is unaffected by this stub
# being installed here regardless of file/test ordering.
stub_unreal()
import uefn_launcher  # noqa: E402


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


# ---------------------------------------------------------------------------
# _try_iter_tag_container_values -- must distinguish "iterated successfully
# with zero items" (iterated_ok=True, items=[]) from "could not iterate at
# all" (iterated_ok=False, items=[]). See _iter_tag_container_values' and
# _try_iter_tag_container_values' own docstrings for the false-negative bug
# this closes: a previous version's bare `except TypeError: return` inside
# the generator itself collapsed both cases into "zero tags".
# ---------------------------------------------------------------------------

class TryIterTagContainerValuesTests(unittest.TestCase):
    def test_list_with_items_iterates_ok(self):
        items, ok = tag_inspect._try_iter_tag_container_values(["t_room_r1", "t_spawn_rand"])
        self.assertTrue(ok)
        self.assertEqual(items, ["t_room_r1", "t_spawn_rand"])

    def test_empty_list_iterates_ok_with_zero_items(self):
        items, ok = tag_inspect._try_iter_tag_container_values([])
        self.assertTrue(ok)
        self.assertEqual(items, [])

    def test_object_with_gameplay_tags_attribute_iterates_ok(self):
        class Container:
            def __init__(self, tags):
                self.gameplay_tags = tags

        items, ok = tag_inspect._try_iter_tag_container_values(Container(["t_room_r1"]))
        self.assertTrue(ok)
        self.assertEqual(items, ["t_room_r1"])

    def test_non_iterable_object_reports_could_not_iterate_not_empty(self):
        class Opaque:
            """No __iter__, no gameplay_tags attribute -- genuinely
            unreadable, must NOT be reported as an empty container."""
            def __repr__(self):
                return "<Opaque object at 0xDEADBEEF>"

        items, ok = tag_inspect._try_iter_tag_container_values(Opaque())
        self.assertFalse(ok, "a non-iterable object must report could-not-iterate, not empty")
        self.assertEqual(items, [])


# ---------------------------------------------------------------------------
# _decode_winner_tags -- multi-strategy decode of the already-selected
# tag-container property value. known_tag_names below mirrors what
# build_tag_class_set() would derive from a real project's own Verse
# source.
# ---------------------------------------------------------------------------

_KNOWN_TAG_NAMES = {"t_room_r1", "t_spawn_rand"}


class DecodeWinnerTagsTests(unittest.TestCase):
    def test_gameplay_tags_list_of_objects_str_gives_tag_names(self):
        class TagValue:
            def __init__(self, name):
                self._name = name

            def __str__(self):
                return self._name

        class Container:
            def __init__(self, tags):
                self.gameplay_tags = tags

        winner = Container([TagValue("GameplayTag't_room_r1'"), TagValue("t_spawn_rand")])
        names, status, debug = tag_inspect._decode_winner_tags(winner, _KNOWN_TAG_NAMES)
        self.assertEqual(status, "ok")
        # normalize_tag_name must have been applied: the repr-style wrapper
        # is stripped.
        self.assertEqual(names, ["t_room_r1", "t_spawn_rand"])

    def test_plain_list_of_strings(self):
        names, status, debug = tag_inspect._decode_winner_tags(
            ["t_room_r1", "t_spawn_rand"], _KNOWN_TAG_NAMES
        )
        self.assertEqual(status, "ok")
        self.assertEqual(names, ["t_room_r1", "t_spawn_rand"])

    def test_export_text_tagname_pattern_is_parsed(self):
        class ExportTextOnly:
            """No iteration, no gameplay_tags -- only export_text()."""
            def export_text(self):
                return '(GameplayTags=((TagName="t_room_r1"),(TagName="t_spawn_rand")))'

        names, status, debug = tag_inspect._decode_winner_tags(ExportTextOnly(), _KNOWN_TAG_NAMES)
        self.assertEqual(status, "ok")
        self.assertEqual(names, ["t_room_r1", "t_spawn_rand"])
        self.assertIn("export_text", debug)

    def test_export_text_without_tagname_pattern_falls_back_to_known_tag_whole_word_match(self):
        class ExportTextOnly:
            def export_text(self):
                return "some exported blob that happens to mention t_room_r1 in free text"

        names, status, debug = tag_inspect._decode_winner_tags(ExportTextOnly(), _KNOWN_TAG_NAMES)
        self.assertEqual(status, "ok")
        self.assertEqual(names, ["t_room_r1"])

    def test_opaque_object_matched_via_known_tag_whole_word_in_repr(self):
        class Opaque:
            """No iteration, no export_text -- only a repr with an
            address-style suffix, like a real unreadable UE wrapper
            object. Whole-word match against known_tag_names is the last
            resort strategy (d)."""
            def __repr__(self):
                return "<VerseTagWrapper t_room_r1 object at 0x0000023B4D8B2340>"

        names, status, debug = tag_inspect._decode_winner_tags(Opaque(), _KNOWN_TAG_NAMES)
        self.assertEqual(status, "ok")
        self.assertEqual(names, ["t_room_r1"])

    def test_fully_opaque_object_with_no_known_tag_hits_yields_no_tags(self):
        class Opaque:
            def __repr__(self):
                return "<Opaque object at 0xDEADBEEF>"

        names, status, debug = tag_inspect._decode_winner_tags(Opaque(), _KNOWN_TAG_NAMES)
        self.assertEqual(status, "unreadable")
        self.assertEqual(names, [])
        self.assertEqual(debug["type_name"], "Opaque")
        self.assertIn("Opaque object at", debug["value_repr"])

    def test_iterated_ok_zero_items_is_empty_not_unreadable(self):
        names, status, debug = tag_inspect._decode_winner_tags([], _KNOWN_TAG_NAMES)
        self.assertEqual(status, "empty")
        self.assertEqual(names, [])

    def test_none_winner_value_is_unreadable_not_empty(self):
        # A None winner_value (e.g. a failed defensive re-fetch in
        # _extract_tags_from_component) must never be reported as "empty"
        # -- "empty" is reserved for a strategy that POSITIVELY iterated a
        # real container down to zero entries, which cannot happen when
        # there was no value to iterate at all.
        names, status, debug = tag_inspect._decode_winner_tags(None, _KNOWN_TAG_NAMES)
        self.assertEqual(status, "unreadable")
        self.assertEqual(names, [])

    def test_none_winner_value_with_refetch_error_notes_exception_class(self):
        names, status, debug = tag_inspect._decode_winner_tags(
            None, _KNOWN_TAG_NAMES, refetch_error="RuntimeError"
        )
        self.assertEqual(status, "unreadable")
        self.assertIn("RuntimeError", debug.get("note", ""))


# ---------------------------------------------------------------------------
# extraction_status through _extract_tags_from_component -- exercised with a
# minimal fake "component" whose get_editor_property() returns crafted
# values (and can raise) so this stays headless / unreal-free.
# ---------------------------------------------------------------------------

class _FakeComponent:
    """Minimal stand-in for a UE component object: dir()-discoverable,
    non-underscore, non-callable instance attributes are its "editor
    properties" (matching _get_component_property_names' dir()-based
    last-resort fallback, which is what actually enumerates it in this
    headless test environment where device_audit/property_inspector's own
    enumerators are unavailable without a real `unreal`). Real values come
    back through get_editor_property(name); a value that is an Exception
    subclass in *properties* is raised instead of returned, exercising the
    property_read_error path."""

    def __init__(self, properties):
        self._properties = properties
        for name in properties:
            setattr(self, name, None)

    def get_editor_property(self, name):
        value = self._properties[name]
        if isinstance(value, type) and issubclass(value, Exception):
            raise value("boom")
        return value


class _FakeClassInfo:
    """Stand-in for comp.get_class() -- only .get_name() is ever called
    on it by the functions under test below."""
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name


class _FakeComponentWithClass(_FakeComponent):
    """_FakeComponent plus a get_class().get_name(), so it can stand in
    for a real UE component in the higher-level walk functions
    (_find_tag_component, _deep_probe_actor) that key off the
    component's class name (e.g. the "versetag" substring check)."""
    def __init__(self, properties, class_name):
        super().__init__(properties)
        self._class_name = class_name

    def get_class(self):
        return _FakeClassInfo(self._class_name)


class _FakeActor:
    """Minimal stand-in for a UE actor object: get_actor_label() (read
    by both device_audit._safe_label and tag_inspect._fallback_label --
    identical get_actor_label()-then-get_name() logic, so this works
    regardless of which one this test run resolves to),
    get_components_by_class() (ignores the class argument, returns
    whatever components this actor was constructed with), and
    get_editor_property("tags") for AActor::Tags. *tags_value* may be an
    Exception subclass to simulate a raising read."""
    def __init__(self, label, components, tags_value):
        self._label = label
        self._components = components
        self._tags_value = tags_value

    def get_actor_label(self):
        return self._label

    def get_name(self):
        return self._label

    def get_components_by_class(self, _cls):
        return list(self._components)

    def get_editor_property(self, name):
        if name == "tags":
            if isinstance(self._tags_value, type) and issubclass(self._tags_value, Exception):
                raise self._tags_value("boom")
            return self._tags_value
        raise AttributeError(name)


class _FakeTree:
    """Records every tree.insert() call without any real Tk widget, so
    uefn_launcher's tree-rendering functions (_render_tag_report,
    _render_deep_probe) -- which only ever call .delete(), .get_children(),
    and .insert(parent, index, text=, values=) on their `tree` argument --
    can be exercised headlessly. Each row is stored with its own
    generated id and its parent's id, so a test can reconstruct parent/
    child structure by id."""
    def __init__(self):
        self.rows = []
        self._next_id = 0

    def get_children(self, *_args):
        return []

    def delete(self, *_args):
        pass

    def insert(self, parent, _index, text="", values=()):
        self._next_id += 1
        node_id = "node{}".format(self._next_id)
        self.rows.append({"id": node_id, "parent": parent, "text": text, "values": values})
        return node_id


class _FakeLabel:
    """Records the last .config(text=...) call -- stands in for the real
    tk.Label discovery_label/summary_label widgets."""
    def __init__(self):
        self.text = None

    def config(self, **kwargs):
        if "text" in kwargs:
            self.text = kwargs["text"]


class ExtractTagsFromComponentTests(unittest.TestCase):
    def test_status_ok_when_tags_decode(self):
        comp = _FakeComponent({"gameplay_tags_container": ["t_room_r1"]})
        prop_name, names, diagnostics = tag_inspect._extract_tags_from_component(comp, _KNOWN_TAG_NAMES)
        self.assertEqual(prop_name, "gameplay_tags_container")
        self.assertEqual(names, ["t_room_r1"])
        self.assertEqual(diagnostics["extraction_status"], "ok")
        self.assertIsNone(diagnostics["extraction_debug"])

    def test_status_empty_when_container_positively_iterates_to_zero(self):
        comp = _FakeComponent({"gameplay_tags_container": []})
        prop_name, names, diagnostics = tag_inspect._extract_tags_from_component(comp, _KNOWN_TAG_NAMES)
        self.assertEqual(prop_name, "gameplay_tags_container")
        self.assertEqual(names, [])
        self.assertEqual(diagnostics["extraction_status"], "empty")
        self.assertIsNone(diagnostics["extraction_debug"])

    def test_status_unreadable_carries_extraction_debug_with_type_and_repr(self):
        class OpaqueTagContainer:
            """Shape-matches (has .gameplay_tags) but that attribute is not
            itself iterable, and neither export_text() nor a known-tag
            repr match can recover anything -- genuinely unreadable."""
            def __init__(self):
                self.gameplay_tags = 5

            def __repr__(self):
                return "<OpaqueTagContainer object at 0xDEADBEEF>"

        comp = _FakeComponent({"weird_tags": OpaqueTagContainer()})
        prop_name, names, diagnostics = tag_inspect._extract_tags_from_component(comp, _KNOWN_TAG_NAMES)
        self.assertEqual(prop_name, "weird_tags")
        self.assertEqual(names, [])
        self.assertEqual(diagnostics["extraction_status"], "unreadable")
        debug = diagnostics["extraction_debug"]
        self.assertIsNotNone(debug)
        self.assertEqual(debug["type_name"], "OpaqueTagContainer")
        self.assertIn("OpaqueTagContainer object at", debug["value_repr"])

    def test_get_editor_property_raising_records_property_read_error_not_silent_skip(self):
        comp = _FakeComponent({
            "boom_prop": RuntimeError,
            "gameplay_tags_container": ["t_room_r1"],
        })
        prop_name, names, diagnostics = tag_inspect._extract_tags_from_component(comp, _KNOWN_TAG_NAMES)
        # The raising property must not abort the scan of the other one.
        self.assertEqual(prop_name, "gameplay_tags_container")
        self.assertEqual(names, ["t_room_r1"])
        errors = diagnostics["property_read_errors"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["name"], "boom_prop")
        self.assertEqual(errors[0]["exception_class"], "RuntimeError")


# ---------------------------------------------------------------------------
# _NullSlowTask -- context-manager protocol, no-op call surface, and no
# destroy() method (see _make_slow_task's docstring for why destroy() was
# removed from this surface entirely rather than kept as another no-op).
# ---------------------------------------------------------------------------

class NullSlowTaskTests(unittest.TestCase):
    def test_context_manager_protocol_works(self):
        with tag_inspect._NullSlowTask() as task:
            self.assertIsInstance(task, tag_inspect._NullSlowTask)

    def test_call_surface_is_callable_and_should_cancel_is_falsy(self):
        task = tag_inspect._NullSlowTask()
        task.enter_progress_frame(1, "doing work")
        task.make_dialog(True)
        self.assertFalse(task.should_cancel())

    def test_no_destroy_attribute_needed(self):
        self.assertFalse(hasattr(tag_inspect._NullSlowTask(), "destroy"))


# ---------------------------------------------------------------------------
# uefn_launcher._classify_tag_actor -- headless-importable (see the module
# top for the stub_unreal() this needed). Classifies one `actors` entry from
# an inspect_tags() result into no_component/empty/unreadable/ok, plus the
# legacy_empty compatibility case for reports written before
# extraction_status existed.
# ---------------------------------------------------------------------------

class ClassifyTagActorTests(unittest.TestCase):
    def test_no_component(self):
        actor = {"has_verse_tag_component": False, "tags": []}
        self.assertEqual(uefn_launcher._classify_tag_actor(actor), "no_component")

    def test_empty_status(self):
        actor = {"has_verse_tag_component": True, "tags": [], "extraction_status": "empty"}
        self.assertEqual(uefn_launcher._classify_tag_actor(actor), "empty")

    def test_unreadable_status(self):
        actor = {"has_verse_tag_component": True, "tags": [], "extraction_status": "unreadable"}
        self.assertEqual(uefn_launcher._classify_tag_actor(actor), "unreadable")

    def test_ok_status_with_tags(self):
        actor = {
            "has_verse_tag_component": True,
            "tags": [{"name": "t_room_r1", "parent_chain": []}],
            "extraction_status": "ok",
        }
        self.assertEqual(uefn_launcher._classify_tag_actor(actor), "ok")

    def test_legacy_report_missing_extraction_status_key_with_empty_tags_is_legacy_empty(self):
        # extraction_status key genuinely absent (not just falsy) -- a
        # report written before 0.0.534.
        actor = {"has_verse_tag_component": True, "tags": []}
        self.assertNotIn("extraction_status", actor)
        self.assertEqual(uefn_launcher._classify_tag_actor(actor), "legacy_empty")

    def test_legacy_report_missing_extraction_status_key_with_tags_is_ok(self):
        actor = {"has_verse_tag_component": True, "tags": [{"name": "t_room_r1", "parent_chain": []}]}
        self.assertNotIn("extraction_status", actor)
        self.assertEqual(uefn_launcher._classify_tag_actor(actor), "ok")

    def test_tags_present_with_no_component_classifies_ok_never_hidden(self):
        """tags presence is now checked BEFORE has_verse_tag_component
        (uefn_launcher.py ~691-694): an actor rescued entirely via
        tag_inspect.py's actor_tags source (AActor::Tags) can have
        has_verse_tag_component False and still carry decoded tags -- it
        must classify "ok", never "no_component" (which would hide it)."""
        actor = {
            "has_verse_tag_component": False,
            "tags": [{"name": "t_room_r1", "parent_chain": ["tag"], "source": "actor_tags"}],
            "extraction_status": "ok",
            "actor_tags": ["t_room_r1"],
        }
        self.assertEqual(uefn_launcher._classify_tag_actor(actor), "ok")

    def test_never_raises_on_a_minimal_actor_dict(self):
        try:
            result = uefn_launcher._classify_tag_actor({})
        except Exception as e:  # pragma: no cover - failure path
            self.fail(f"_classify_tag_actor raised on a minimal dict: {e!r}")
        self.assertEqual(result, "no_component")

    def test_legacy_empty_and_empty_are_both_hidden_ok_and_unreadable_are_shown(self):
        """Mirrors the exact predicate _render_tag_report uses to decide
        which classified actors are inserted into the tree
        (`statuses[id(a)] in ("ok", "unreadable")`) -- legacy_empty and
        empty must both be excluded (hidden) without raising."""
        actors = [
            {"has_verse_tag_component": False, "tags": []},  # no_component
            {"has_verse_tag_component": True, "tags": [], "extraction_status": "empty"},  # empty
            {"has_verse_tag_component": True, "tags": [], "extraction_status": "unreadable"},  # unreadable
            {"has_verse_tag_component": True, "tags": [{"name": "t1", "parent_chain": []}], "extraction_status": "ok"},  # ok
            {"has_verse_tag_component": True, "tags": []},  # legacy_empty
        ]
        statuses = [uefn_launcher._classify_tag_actor(a) for a in actors]
        shown = [s in ("ok", "unreadable") for s in statuses]
        self.assertEqual(
            statuses,
            ["no_component", "empty", "unreadable", "ok", "legacy_empty"],
        )
        self.assertEqual(shown, [False, False, True, True, False])


# ---------------------------------------------------------------------------
# _known_tag_hits -- whole-word semantics: t_room_r1 must NOT hit inside
# t_room_r10 (same \b-anchored regex signal used for property/value
# selection elsewhere in this module).
# ---------------------------------------------------------------------------

class KnownTagHitsTests(unittest.TestCase):
    def test_whole_word_hit(self):
        hits = tag_inspect._known_tag_hits("prefix t_room_r1 suffix", {"t_room_r1"})
        self.assertEqual(hits, ["t_room_r1"])

    def test_no_match_inside_longer_name(self):
        hits = tag_inspect._known_tag_hits("actor has t_room_r10 applied", {"t_room_r1"})
        self.assertEqual(hits, [])

    def test_empty_text_or_known_tag_names_returns_empty_never_raises(self):
        self.assertEqual(tag_inspect._known_tag_hits("", {"t_room_r1"}), [])
        self.assertEqual(tag_inspect._known_tag_hits(None, {"t_room_r1"}), [])
        self.assertEqual(tag_inspect._known_tag_hits("t_room_r1", set()), [])
        self.assertEqual(tag_inspect._known_tag_hits("t_room_r1", None), [])


# ---------------------------------------------------------------------------
# _describe_value_for_deep_probe -- bounded {"type_name", "value_repr",
# "export_text", "known_tag_hits"} snippet.
# ---------------------------------------------------------------------------

class DescribeValueForDeepProbeTests(unittest.TestCase):
    def test_type_name_and_repr_are_truncated(self):
        class Foo:
            def __repr__(self):
                return "x" * 300

        desc = tag_inspect._describe_value_for_deep_probe(Foo(), set())
        self.assertEqual(desc["type_name"], "Foo")
        self.assertLessEqual(len(desc["value_repr"]), tag_inspect._DEEP_PROBE_SNIPPET_LEN)
        self.assertTrue(desc["value_repr"].endswith("..."))

    def test_export_text_included_and_feeds_known_tag_hits(self):
        class WithExportText:
            def __repr__(self):
                return "<WithExportText>"

            def export_text(self):
                return "blob mentioning t_room_r1"

        desc = tag_inspect._describe_value_for_deep_probe(WithExportText(), {"t_room_r1"})
        self.assertEqual(desc["export_text"], "blob mentioning t_room_r1")
        self.assertEqual(desc["known_tag_hits"], ["t_room_r1"])

    def test_export_text_raising_is_swallowed_not_propagated(self):
        """Verified against the actual source (tag_inspect.py
        ~1172-1179), not assumed: _describe_value_for_deep_probe's own
        try/except around export_text() swallows any exception and
        simply omits the "export_text" key -- it is NOT recorded as an
        exception_class anywhere at THIS layer. A raising
        get_editor_property() read one level up, in _deep_probe_actor
        itself, IS recorded in the finding's "errors" list -- see
        DeepProbeActorTests.test_raising_property_is_recorded_as_an_error
        below for that distinct, correctly-recorded case."""
        class RaisesOnExportText:
            def __repr__(self):
                return "<RaisesOnExportText>"

            def export_text(self):
                raise RuntimeError("boom")

        try:
            desc = tag_inspect._describe_value_for_deep_probe(RaisesOnExportText(), set())
        except Exception as e:  # pragma: no cover - failure path
            self.fail(f"_describe_value_for_deep_probe propagated an export_text() exception: {e!r}")
        self.assertNotIn("export_text", desc)

    def test_none_value(self):
        desc = tag_inspect._describe_value_for_deep_probe(None, {"t_room_r1"})
        self.assertIsNone(desc["type_name"])
        self.assertIsNone(desc["value_repr"])
        self.assertEqual(desc["known_tag_hits"], [])


# ---------------------------------------------------------------------------
# _deep_probe_actor -- needs `unreal.ActorComponent` to exist as a module
# attribute (only ever passed through to the fake actor's
# get_components_by_class, never inspected), so tag_inspect.unreal is
# monkeypatched to a minimal types.SimpleNamespace for the duration of each
# test and restored in tearDown. This never touches the shared
# sys.modules["unreal"] stub, so it cannot leak into any other test file.
# ---------------------------------------------------------------------------

class DeepProbeActorTests(unittest.TestCase):
    def setUp(self):
        self._had_unreal_attr = hasattr(tag_inspect, "unreal")
        self._orig_unreal = getattr(tag_inspect, "unreal", None)
        tag_inspect.unreal = types.SimpleNamespace(ActorComponent=object())

    def tearDown(self):
        if self._had_unreal_attr:
            tag_inspect.unreal = self._orig_unreal
        else:
            del tag_inspect.unreal

    def test_findings_shape_mixes_hit_raising_and_opaque_properties(self):
        tag_comp = _FakeComponentWithClass(
            {"prop_hit": "<Wrapper t_room_r1 at 0x1>", "prop_boom": RuntimeError},
            "VerseTagMarkupComponent",
        )
        other_hit = _FakeComponentWithClass({"weird": "mentions t_room_r1 somewhere"}, "SomeOtherComponent")
        other_no_hit = _FakeComponentWithClass({"boring": "nothing interesting"}, "AnotherComponent")
        actor = _FakeActor("Actor1", [tag_comp, other_hit, other_no_hit], ["t_spawn_rand"])

        finding = tag_inspect._deep_probe_actor("Actor1", actor, {"t_room_r1", "t_spawn_rand"})

        self.assertEqual(finding["actor_label"], "Actor1")

        self.assertEqual(finding["tag_component"]["class_name"], "VerseTagMarkupComponent")
        probed_names = {p["name"] for p in finding["tag_component"]["properties"]}
        self.assertEqual(probed_names, {"prop_hit"})  # prop_boom raised, excluded from the dump
        hit_prop = finding["tag_component"]["properties"][0]
        self.assertEqual(hit_prop["known_tag_hits"], ["t_room_r1"])

        self.assertEqual(finding["actor_tags_property"]["known_tag_hits"], ["t_spawn_rand"])

        self.assertEqual(len(finding["other_components_hits"]), 1)
        hit = finding["other_components_hits"][0]
        self.assertEqual(hit["component_class"], "SomeOtherComponent")
        self.assertEqual(hit["property"], "weird")
        self.assertEqual(hit["known_tag_hits"], ["t_room_r1"])

    def test_raising_property_is_recorded_as_an_error(self):
        tag_comp = _FakeComponentWithClass({"prop_boom": RuntimeError}, "VerseTagMarkupComponent")
        actor = _FakeActor("Actor1", [tag_comp], [])
        finding = tag_inspect._deep_probe_actor("Actor1", actor, set())
        errors = finding["errors"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["where"], "tag_component.prop_boom")
        self.assertEqual(errors[0]["exception_class"], "RuntimeError")

    def test_actor_tags_read_error_is_recorded_not_silently_dropped(self):
        tag_comp = _FakeComponentWithClass({}, "VerseTagMarkupComponent")
        actor = _FakeActor("Actor1", [tag_comp], RuntimeError)  # get_editor_property("tags") raises
        finding = tag_inspect._deep_probe_actor("Actor1", actor, set())
        self.assertIsNone(finding["actor_tags_property"])
        self.assertTrue(any(e["where"] == "actor.tags" and e["exception_class"] == "RuntimeError" for e in finding["errors"]))

    def test_max_components_per_actor_cap_is_respected(self):
        """Components beyond _MAX_COMPONENTS_PER_ACTOR are truncated
        BEFORE any per-component probing (tag_inspect.py's
        `components = components[:_MAX_COMPONENTS_PER_ACTOR]`) -- give 3
        components with a known-tag hit only AFTER that boundary and
        confirm none of their hits ever surface."""
        cap = tag_inspect._MAX_COMPONENTS_PER_ACTOR
        tag_comp = _FakeComponentWithClass({}, "VerseTagMarkupComponent")
        filler = [_FakeComponentWithClass({}, "FillerComponent") for _ in range(cap - 1)]
        beyond_cap_hits = [
            _FakeComponentWithClass({"prop": "contains t_room_r1 here"}, "ShouldBeTruncated{}".format(i))
            for i in range(3)
        ]
        components = [tag_comp] + filler + beyond_cap_hits
        actor = _FakeActor("CappedActor", components, [])

        finding = tag_inspect._deep_probe_actor("CappedActor", actor, {"t_room_r1"})

        self.assertEqual(finding["tag_component"]["class_name"], "VerseTagMarkupComponent")
        self.assertEqual(finding["other_components_hits"], [])

    def test_max_properties_per_component_cap_is_respected(self):
        cap = tag_inspect._MAX_PROPERTIES_PER_COMPONENT
        properties = {"prop_{}".format(i): "no hits here" for i in range(cap + 5)}
        tag_comp = _FakeComponentWithClass(properties, "VerseTagMarkupComponent")
        actor = _FakeActor("Actor1", [tag_comp], [])

        finding = tag_inspect._deep_probe_actor("Actor1", actor, set())

        self.assertEqual(len(finding["tag_component"]["properties"]), cap)


# ---------------------------------------------------------------------------
# Actor-Tags decode primitives -- mirrors tag_inspect.py's actor-level tags
# decode glue (roughly lines 1600-1618 inside _inspect_tags_live) by
# chaining the REAL _try_iter_tag_container_values + normalize_tag_name
# primitives -- not a reimplementation of those functions, just the same
# short call sequence the module itself performs, so it is testable without
# mocking `unreal`/actors at all. The full merge/dedup/status-upgrade
# behavior those decoded names feed into is covered end-to-end through a
# real tag_inspect.inspect_tags() call in ActorLevelTagSourceMergeTests
# below.
# ---------------------------------------------------------------------------

class ActorTagsDecodePrimitivesTests(unittest.TestCase):
    @staticmethod
    def _decode_actor_tags(actor_tags_value, known_tag_names):
        items, _iterated_ok = tag_inspect._try_iter_tag_container_values(actor_tags_value)
        raw = []
        for item in items:
            normalized = tag_inspect.normalize_tag_name(str(item))
            if normalized:
                raw.append(normalized)
        matched = [t for t in raw if t in known_tag_names]
        return raw, matched

    def test_wrapped_and_dotted_actor_tag_values_normalize_and_match(self):
        raw, matched = self._decode_actor_tags(
            ["GameplayTag't_room_r1'", "Verse.t_spawn_rand", "totally_unrelated"],
            {"t_room_r1", "t_spawn_rand"},
        )
        self.assertEqual(raw, ["t_room_r1", "t_spawn_rand", "totally_unrelated"])
        self.assertEqual(matched, ["t_room_r1", "t_spawn_rand"])

    def test_no_match_when_no_known_tag_names_present(self):
        raw, matched = self._decode_actor_tags(["random_value"], {"t_room_r1"})
        self.assertEqual(raw, ["random_value"])
        self.assertEqual(matched, [])

    def test_non_iterable_actor_tags_value_yields_no_matches_not_crash(self):
        class Opaque:
            pass

        raw, matched = self._decode_actor_tags(Opaque(), {"t_room_r1"})
        self.assertEqual(raw, [])
        self.assertEqual(matched, [])


# ---------------------------------------------------------------------------
# Actor-level tag source merge -- the inline block inside _inspect_tags_live
# (tag_inspect.py ~1732-1770) that folds actor_tags_matched hits into each
# actor's tags list (source="actor_tags"), dedups against component-sourced
# names, and upgrades extraction_status to "ok" whenever either source
# produced tags. This is inline code inside a large unreal-dependent
# function, not a standalone helper -- the only way to exercise the REAL
# logic (not a hand-copied reimplementation of it) is to drive
# tag_inspect.inspect_tags() itself with a fully faked `unreal`, actor, and
# component. tag_inspect.unreal/_HAS_UNREAL/report_path/_get_bridge_dir are
# monkeypatched and restored per-test; report_path/_get_bridge_dir are
# redirected to a scratch temp dir so this never writes into media/.
# ---------------------------------------------------------------------------

class ActorLevelTagSourceMergeTests(unittest.TestCase):
    def setUp(self):
        self._had_unreal_attr = hasattr(tag_inspect, "unreal")
        self._orig_unreal = getattr(tag_inspect, "unreal", None)
        self._orig_has_unreal = tag_inspect._HAS_UNREAL
        self._orig_report_path = tag_inspect.report_path
        self._orig_get_bridge_dir = tag_inspect._get_bridge_dir

        self._scratch = tempfile.mkdtemp(prefix="tag_inspect_merge_test_")
        primary = os.path.join(self._scratch, "primary", "tag_inspect_report.json")
        fallback_dir = os.path.join(self._scratch, "fallback")
        os.makedirs(fallback_dir, exist_ok=True)
        tag_inspect.report_path = lambda: primary
        tag_inspect._get_bridge_dir = lambda: fallback_dir

        self._actors = []
        subsystem = types.SimpleNamespace(get_all_level_actors=lambda: self._actors)
        tag_inspect.unreal = types.SimpleNamespace(
            ActorComponent=object(),
            EditorActorSubsystem=object(),
            ScopedSlowTask=lambda total, desc: tag_inspect._NullSlowTask(),
            get_editor_subsystem=lambda cls: subsystem,
            log_warning=lambda *a, **k: None,
            log_error=lambda *a, **k: None,
        )
        tag_inspect._HAS_UNREAL = True

    def tearDown(self):
        if self._had_unreal_attr:
            tag_inspect.unreal = self._orig_unreal
        else:
            del tag_inspect.unreal
        tag_inspect._HAS_UNREAL = self._orig_has_unreal
        tag_inspect.report_path = self._orig_report_path
        tag_inspect._get_bridge_dir = self._orig_get_bridge_dir

    @staticmethod
    def _write_verse_dir_with_known_tag(tmp_dir):
        with open(os.path.join(tmp_dir, "tags.verse"), "w", encoding="utf-8") as f:
            f.write("t_room_r1 := class(tag)\n")

    def test_actor_level_tag_rescues_a_confirmed_empty_component_to_ok(self):
        with tempfile.TemporaryDirectory() as verse_dir:
            self._write_verse_dir_with_known_tag(verse_dir)
            comp = _FakeComponentWithClass({"gameplay_tags_container": []}, "VerseTagMarkupComponent")
            actor = _FakeActor("RescuedActor", [comp], ["GameplayTag't_room_r1'"])
            self._actors = [actor]
            result = tag_inspect.inspect_tags(label_pattern=None, project_dir=verse_dir)

        self.assertEqual(len(result["actors"]), 1)
        entry = result["actors"][0]
        self.assertEqual(entry["extraction_status"], "ok")
        self.assertEqual(entry["tags"], [{"name": "t_room_r1", "parent_chain": ["tag"], "source": "actor_tags"}])
        self.assertEqual(entry["actor_tags"], ["t_room_r1"])
        self.assertIn("actor's own Tags property", result["discovery"]["notes"])

    def test_component_and_actor_tags_agreeing_on_same_name_dedup_to_one_entry(self):
        with tempfile.TemporaryDirectory() as verse_dir:
            self._write_verse_dir_with_known_tag(verse_dir)
            comp = _FakeComponentWithClass({"gameplay_tags_container": ["t_room_r1"]}, "VerseTagMarkupComponent")
            actor = _FakeActor("DedupActor", [comp], ["t_room_r1"])
            self._actors = [actor]
            result = tag_inspect.inspect_tags(label_pattern=None, project_dir=verse_dir)

        entry = result["actors"][0]
        self.assertEqual(entry["extraction_status"], "ok")
        self.assertEqual(len(entry["tags"]), 1)
        self.assertEqual(entry["tags"][0]["source"], "component_tags")
        self.assertNotIn("actor's own Tags property", result["discovery"]["notes"])

    def test_actor_tags_not_matching_any_known_tag_name_never_rescues(self):
        with tempfile.TemporaryDirectory() as verse_dir:
            self._write_verse_dir_with_known_tag(verse_dir)
            comp = _FakeComponentWithClass({"gameplay_tags_container": []}, "VerseTagMarkupComponent")
            actor = _FakeActor("UnmatchedActor", [comp], ["totally_unrelated_name"])
            self._actors = [actor]
            result = tag_inspect.inspect_tags(label_pattern=None, project_dir=verse_dir)

        entry = result["actors"][0]
        self.assertEqual(entry["extraction_status"], "empty")
        self.assertEqual(entry["tags"], [])
        self.assertEqual(entry["actor_tags"], ["totally_unrelated_name"])


# ---------------------------------------------------------------------------
# _render_tag_report's empty-state placeholder logic -- exercised headlessly
# via _FakeTree/_FakeLabel (no real Tk widget needed; the function only
# calls .delete()/.get_children()/.insert() and .config(text=...)).
# ---------------------------------------------------------------------------

class RenderTagReportEmptyStatePlaceholderTests(unittest.TestCase):
    def test_placeholder_shown_when_all_matched_actors_are_hidden(self):
        data = {
            "discovery": {"component_class": "VerseTagMarkupComponent", "tag_property": "gameplay_tags_container", "notes": "n/a"},
            "actors": [
                {"label": "A", "has_verse_tag_component": True, "tags": [], "extraction_status": "empty"},
                {"label": "B", "has_verse_tag_component": False, "tags": []},
            ],
            "tag_class_count": 1,
        }
        tree, discovery_label, summary_label = _FakeTree(), _FakeLabel(), _FakeLabel()
        uefn_launcher._render_tag_report(tree, discovery_label, summary_label, data, "test source")

        placeholder_rows = [r for r in tree.rows if "No rows" in r["text"]]
        self.assertEqual(len(placeholder_rows), 1)
        self.assertIn("1 with a confirmed-empty tag container", placeholder_rows[0]["text"])
        self.assertIn("1 without a tag component", placeholder_rows[0]["text"])
        self.assertIn("Copy the MCP prompt", placeholder_rows[0]["text"])

    def test_placeholder_mentions_deep_probe_rows_when_deep_probe_present(self):
        data = {
            "discovery": {"component_class": None, "tag_property": None, "notes": ""},
            "actors": [
                {"label": "A", "has_verse_tag_component": True, "tags": [], "extraction_status": "empty"},
            ],
            "tag_class_count": 0,
            "deep_probe": {"probed_labels": ["A"], "findings": []},
        }
        tree, discovery_label, summary_label = _FakeTree(), _FakeLabel(), _FakeLabel()
        uefn_launcher._render_tag_report(tree, discovery_label, summary_label, data, "test source")

        placeholder_rows = [r for r in tree.rows if "No rows" in r["text"]]
        self.assertEqual(len(placeholder_rows), 1)
        self.assertIn("deep probe rows below", placeholder_rows[0]["text"])

    def test_no_placeholder_when_at_least_one_actor_is_shown(self):
        data = {
            "discovery": {"component_class": None, "tag_property": None, "notes": ""},
            "actors": [
                {"label": "A", "has_verse_tag_component": True, "tags": [{"name": "t1", "parent_chain": []}], "extraction_status": "ok"},
            ],
            "tag_class_count": 1,
        }
        tree, discovery_label, summary_label = _FakeTree(), _FakeLabel(), _FakeLabel()
        uefn_launcher._render_tag_report(tree, discovery_label, summary_label, data, "test source")

        self.assertEqual([r for r in tree.rows if "No rows" in r["text"]], [])

    def test_old_shape_report_without_extraction_status_or_deep_probe_does_not_crash(self):
        """Old-shape reports (no extraction_status key, no source field on
        individual tags, no top-level deep_probe key) must still render
        without raising -- _classify_tag_actor's legacy_empty fallback is
        what makes this safe."""
        data = {
            "discovery": {"component_class": "VerseTagMarkupComponent", "tag_property": "Tags", "notes": ""},
            "actors": [
                {"label": "A", "has_verse_tag_component": True, "tags": [{"name": "t1", "parent_chain": ["tag"]}]},  # legacy ok
                {"label": "B", "has_verse_tag_component": True, "tags": []},  # legacy_empty
                {"label": "C", "has_verse_tag_component": False, "tags": []},  # no_component
            ],
            "tag_class_count": 1,
        }
        tree, discovery_label, summary_label = _FakeTree(), _FakeLabel(), _FakeLabel()
        try:
            uefn_launcher._render_tag_report(tree, discovery_label, summary_label, data, "legacy report")
        except Exception as e:  # pragma: no cover - failure path
            self.fail(f"_render_tag_report raised on an old-shape report: {e!r}")

        shown_top_level_texts = [r["text"] for r in tree.rows if r["parent"] == ""]
        self.assertIn("A", shown_top_level_texts)
        self.assertNotIn("B", shown_top_level_texts)
        self.assertNotIn("C", shown_top_level_texts)


# ---------------------------------------------------------------------------
# _render_deep_probe -- known-tag-hit rows must sort before non-hit rows
# and error rows within each probed actor.
# ---------------------------------------------------------------------------

class RenderDeepProbeTests(unittest.TestCase):
    def test_no_findings_is_a_no_op(self):
        tree = _FakeTree()
        uefn_launcher._render_deep_probe(tree, {"findings": []})
        self.assertEqual(tree.rows, [])

    def test_known_tag_hit_rows_sort_before_non_hit_and_error_rows(self):
        deep_probe = {
            "findings": [{
                "actor_label": "Actor1",
                "tag_component": {
                    "class_name": "VerseTagMarkupComponent",
                    "properties": [
                        {"name": "boring", "type_name": "list", "value_repr": "[]", "known_tag_hits": []},
                        {"name": "hitprop", "type_name": "str", "value_repr": "t_room_r1", "known_tag_hits": ["t_room_r1"]},
                    ],
                },
                "actor_tags_property": {"type_name": "list", "value_repr": "[]", "known_tag_hits": []},
                "other_components_hits": [
                    {"component_class": "Other", "property": "weird", "value_repr": "...", "known_tag_hits": ["t_spawn_rand"]},
                ],
                "errors": [{"where": "tag_component.boom", "exception_class": "RuntimeError"}],
            }],
        }
        tree = _FakeTree()
        uefn_launcher._render_deep_probe(tree, deep_probe)

        header_rows = [r for r in tree.rows if r["parent"] == ""]
        self.assertEqual(len(header_rows), 1)
        self.assertIn("DEEP PROBE", header_rows[0]["text"])

        actor_rows = [r for r in tree.rows if r["parent"] == header_rows[0]["id"]]
        self.assertEqual(len(actor_rows), 1)
        self.assertEqual(actor_rows[0]["text"], "Actor1")

        detail_rows = [r for r in tree.rows if r["parent"] == actor_rows[0]["id"]]
        # 2 tag_component props + 1 actor_tags_property + 1 other-hit + 1 error = 5
        self.assertEqual(len(detail_rows), 5)
        star_flags = [r["text"].startswith("★") for r in detail_rows]
        self.assertEqual(star_flags[:2], [True, True])
        self.assertTrue(all(not f for f in star_flags[2:]))


if __name__ == "__main__":
    unittest.main()
