"""Tests for verse_project_check.py: the deterministic PROJECT-WIDE Verse
symbol resolver (module-tree visibility + explicit-annotation member
checks). See media/skills/uefn/verse_project_check.py's module docstring
for the WHY and the confirmed directory-to-module-path mapping.

Each test builds a small synthetic `.verse` project tree under a temp
directory (never a real project -- see "DO NOT OVERFIT" in the task that
produced this file: no file/class/symbol name here is tuned to any real
project's content) and asserts the checker's behavior against the Book of
Verse rules cited in the module docstring.

verse_project_check.py lives in media/skills/uefn/, loaded the same way
test_verse_lint.py loads verse_lint.py: a sys.path insert, not a package
import.
"""
import os
import shutil
import sys
import tempfile
import unittest

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(_THIS_DIR, "..", ".."))
SKILL_DIR = os.path.join(REPO_ROOT, "media", "skills", "uefn")

sys.path.insert(0, SKILL_DIR)
import verse_project_check as vpc  # noqa: E402


class _TempProject:
    """Context manager: writes {relative_path: content} files under a fresh
    temp directory, yields the root path, cleans up on exit."""

    def __init__(self, files):
        self.files = files
        self.root = None

    def __enter__(self):
        self.root = tempfile.mkdtemp(prefix="vpc_test_")
        for rel_path, content in self.files.items():
            full = os.path.join(self.root, rel_path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write(content)
        return self.root

    def __exit__(self, exc_type, exc, tb):
        shutil.rmtree(self.root, ignore_errors=True)


def _findings_by_category(findings, category):
    return [f for f in findings if f["category"] == category]


class SameModuleVisibilityTests(unittest.TestCase):
    """Book of Verse: 'Files within the same module can see each other's
    definitions without imports.' Two files in the SAME directory must
    never trigger a missing-using finding for each other's types."""

    def test_same_directory_reference_not_flagged(self):
        files = {
            "GameSystems/manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "GameSystems/user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events.Foo()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])


class MissingUsingTests(unittest.TestCase):
    """Rule 21: finding a symbol in the digest (or here, the project) is
    not enough -- a cross-module reference with no resolving `using` and
    no qualification MUST be flagged."""

    def test_cross_module_reference_without_using_is_flagged(self):
        files = {
            "Framework/GameSystems/manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "missing-using")
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["path"].endswith("boss.verse"))

    def test_non_vacuity_disabling_module_check_makes_this_fail(self):
        """Proves the true-positive test above exercises real detection,
        not a vacuously-passing assertion: neuter `_using_covers` to always
        report visible (silencing every missing-using finding), confirm
        the finding disappears, then restore."""
        files = {
            "Framework/GameSystems/manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            original = vpc._using_covers
            try:
                vpc._using_covers = lambda *a, **k: True
                neutered = vpc.check_project_index(project)
                self.assertEqual(
                    _findings_by_category(neutered, "missing-using"), [],
                    "sanity check itself is broken: neutering _using_covers "
                    "should silence the true positive",
                )
            finally:
                vpc._using_covers = original
            restored = vpc.check_project_index(project)
        self.assertEqual(len(_findings_by_category(restored, "missing-using")), 1)

    def test_relative_using_resolved_from_sibling_module_not_flagged(self):
        """Relative `using` resolves by walking up the REFERENCING file's
        own ancestor chain (confirmed Book of Verse mechanism) -- a file in
        Framework/GameSystems/ importing bare `GameConfig` should resolve
        against the sibling module Framework/GameConfig/."""
        files = {
            "Framework/GameConfig/config.verse": (
                "game_config_data<public> := class:\n"
                "    Value<public> : int = 0\n"
            ),
            "Framework/GameSystems/manager.verse": (
                "using { GameConfig }\n"
                "\n"
                "game_event_manager<public> := class:\n"
                "    Cfg : game_config_data\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])

    def test_root_module_type_never_flagged(self):
        """Root-level project types are excluded from Check A entirely --
        the tool stays silent rather than guess at unconfirmed root-scope
        visibility rules (see module docstring SAFETY RULES)."""
        files = {
            "root_helper.verse": (
                "root_helper_type<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "Deep/Nested/dir_file.verse": (
                "deep_device := class:\n"
                "    UseIt(H : root_helper_type):void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])


class NameCollisionTests(unittest.TestCase):
    """Check A must require an unambiguous TYPE POSITION before firing,
    and must hard-suppress whenever the referencing file declares
    anything (method, field, parameter, local binding, type) spelled the
    same as the candidate project type. Found via a real false positive:
    an unrelated project class happened to share a name with a local
    `<private>` method in a different file, called as `Name(...)`, and
    was reported as an invisible type reference."""

    def test_colliding_local_method_not_flagged(self):
        files = {
            "Framework/GameConfig/logger.verse": (
                "log_helper<public> := class(some_base){}\n"
            ),
            "Framework/GameSystems/user.verse": (
                "audio_device := class:\n"
                "    log_helper<private>(Message:string):void=\n"
                "        0\n"
                "    UseIt():void=\n"
                "        log_helper(\"hi\")\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])

    def test_genuine_type_annotation_still_fires_despite_unrelated_collision_elsewhere(self):
        """The suppression is per-FILE, not global -- a colliding local
        name in one file must not silence a genuine cross-module type
        annotation in a DIFFERENT file."""
        files = {
            "Framework/GameConfig/logger.verse": (
                "log_helper<public> := class(some_base){}\n"
            ),
            "Framework/GameSystems/unrelated_user.verse": (
                "audio_device := class:\n"
                "    log_helper<private>(Message:string):void=\n"
                "        0\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt(Logger : log_helper):void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "missing-using")
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["path"].endswith("boss.verse"))

    def test_bare_call_with_no_local_collision_still_not_flagged(self):
        """Even without a local name collision, a bare `Name(...)` call is
        an ordinary function call in Verse (not a constructor -- that's
        `Name{...}`), so it must never count as a type-position
        occurrence."""
        files = {
            "Framework/GameConfig/logger.verse": (
                "log_helper<public> := class(some_base){}\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt():void=\n"
                "        log_helper(\"hi\")\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])

    def test_brace_instantiation_still_fires(self):
        """`Name{...}` IS Verse's archetype/instantiation form, and must
        still count as a type-position occurrence."""
        files = {
            "Framework/GameConfig/logger.verse": (
                "log_helper<public> := class(some_base){}\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt():void=\n"
                "        Instance := log_helper{}\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "missing-using")
        self.assertEqual(len(hits), 1)


class ShadowingTests(unittest.TestCase):
    """Check B: a `:=`-inferred rebinding of a name already explicitly
    typed in an outer scope must FORGET the stale type, not keep checking
    against it. Found via review: `Events := Make()` shadowing a parameter
    `Events : game_event_manager` left the old type in the map, so a later
    `Events.MethodOnTheNewType()` was checked against the wrong class."""

    def test_shadowed_binding_does_not_use_stale_outer_type(self):
        files = {
            "manager.verse": (
                "game_event_manager<public> := class:\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
            "other_manager.verse": (
                "other_manager<public> := class:\n"
                "    Make():other_manager=\n"
                "        other_manager{}\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events := other_manager{}.Make()\n"
                "        Events.RealMethod()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        # `Events` is rebound by an unannotated `:=` (call return), so its
        # new type is UNKNOWN -- Check B must not check `RealMethod()`
        # against the stale `game_event_manager` annotation from the
        # parameter, and must not guess the new type either.
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])


class FullyQualifiedReferenceTests(unittest.TestCase):
    """A fully-qualified dotted reference to a project type needs no
    `using` at all -- must NOT be flagged."""

    def test_dotted_qualified_reference_not_flagged(self):
        files = {
            "Framework/GameSystems/manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt():void=\n"
                "        Instance := Framework.GameSystems.game_event_manager{}\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])

    def test_relative_dotted_qualified_reference_not_flagged(self):
        """A dotted qualifier need not be the FULL absolute module path --
        Verse's relative-path resolution rule applies to any reference, not
        only `using` statements, so a shorter prefix resolved by walking up
        the REFERENCING file's own ancestor chain is equally valid. Found
        via a real false positive against the acceptance-test project:
        `Gorillas/Framework/GameInit/*.verse` referencing
        `Features.UIAnimations.some_type` (a sibling under `Gorillas`) with
        no `using` and no full `Gorillas.Features.UIAnimations...` prefix."""
        files = {
            "Gorillas/Features/UIAnimations/pool.verse": (
                "flyup_widget_pool_manager<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "Gorillas/Framework/GameInit/main_device.verse": (
                "main_device := class:\n"
                "    Pool : Features.UIAnimations.flyup_widget_pool_manager = "
                "Features.UIAnimations.flyup_widget_pool_manager{}\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])

    def test_parenthesized_qualified_reference_not_flagged(self):
        files = {
            "Framework/GameSystems/manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt():void=\n"
                "        Instance := (/Framework/GameSystems:)game_event_manager{}\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])


class PrivateAccessTests(unittest.TestCase):
    """Check C: a <private> member accessed from a file other than the one
    that declared it MUST be flagged."""

    def test_private_member_accessed_from_other_file_is_flagged(self):
        files = {
            "manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Secret<private>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events.Secret()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "private-access")
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["path"].endswith("user.verse"))

    def test_non_vacuity_disabling_private_check_makes_this_fail(self):
        files = {
            "manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Secret<private>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events.Secret()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            memo = {}
            member_set = vpc.resolve_member_set("game_event_manager", project, memo)
            original_access = member_set["Secret"].access
            try:
                member_set["Secret"].access = "public"
                neutered = vpc.check_project_index(project)
                self.assertEqual(
                    _findings_by_category(neutered, "private-access"), [],
                    "sanity check itself is broken: making the member public "
                    "should silence the true positive",
                )
            finally:
                member_set["Secret"].access = original_access
            restored = vpc.check_project_index(project)
        self.assertEqual(len(_findings_by_category(restored, "private-access")), 1)

    def test_private_member_accessed_within_declaring_file_not_flagged(self):
        files = {
            "manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Secret<private>():void=\n"
                "        0\n"
                "    Public<public>():void=\n"
                "        Self.Secret()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "private-access"), [])


class MissingMemberTests(unittest.TestCase):
    """Check B: only fires against an EXPLICITLY-typed project class."""

    def test_missing_member_on_explicitly_typed_param_is_flagged(self):
        files = {
            "manager.verse": (
                "game_event_manager<public> := class:\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events.PlayerEliminatedEvent()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "missing-member")
        self.assertEqual(len(hits), 1)
        self.assertIn("PlayerEliminatedEvent", hits[0]["message"])

    def test_non_vacuity_disabling_member_check_makes_this_fail(self):
        files = {
            "manager.verse": (
                "game_event_manager<public> := class:\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events.PlayerEliminatedEvent()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            original = vpc.resolve_member_set
            try:
                vpc.resolve_member_set = lambda *a, **k: {}  # pretend every class has no members but never "unresolved"
                # With an empty-but-known member set, the access should
                # still be flagged as missing -- so instead neuter by
                # making everything look unresolved (None), which silences
                # Check B/C entirely (the actual "neutering" for this test).
                vpc.resolve_member_set = lambda *a, **k: None
                neutered = vpc.check_project_index(project)
                self.assertEqual(
                    _findings_by_category(neutered, "missing-member"), [],
                    "sanity check itself is broken: an always-None resolver "
                    "should silence the true positive",
                )
            finally:
                vpc.resolve_member_set = original
            restored = vpc.check_project_index(project)
        self.assertEqual(len(_findings_by_category(restored, "missing-member")), 1)

    def test_inferred_binding_never_checked(self):
        """`:=` inference must never be used as a type source for Check B
        -- no finding, even though `Foo()` doesn't exist on the class,
        because we never claim to know `Events`'s type here."""
        files = {
            "manager.verse": (
                "game_event_manager<public> := class:\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    Make():game_event_manager=\n"
                "        game_event_manager{}\n"
                "    UseIt():void=\n"
                "        Events := Make()\n"
                "        Events.Foo()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])


class InheritedMemberTests(unittest.TestCase):
    """A member inherited from a fully-known PROJECT ancestor must NOT be
    flagged as missing."""

    def test_member_inherited_from_project_ancestor_not_flagged(self):
        files = {
            "base.verse": (
                "base_manager<public> := class:\n"
                "    Inherited<public>():void=\n"
                "        0\n"
            ),
            "manager.verse": (
                "game_event_manager<public> := class(base_manager):\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events.Inherited()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])

    def test_unknown_ancestor_suppresses_check_b_entirely(self):
        """A class extending a non-project (e.g. Epic) type must suppress
        Check B for that class -- an inherited member we can't see would
        otherwise look 'missing'."""
        files = {
            "manager.verse": (
                "game_event_manager<public> := class(creative_device):\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        Events.SomeEpicBaseMethod()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])

    def test_resolve_member_set_returns_none_for_unknown_ancestor(self):
        files = {
            "manager.verse": (
                "game_event_manager<public> := class(creative_device):\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            memo = {}
            result = vpc.resolve_member_set("game_event_manager", project, memo)
        self.assertIsNone(result)


class IncompleteEnumerationTests(unittest.TestCase):
    """A class with a MULTI-LINE member header (unparseable by this tool's
    single-line-only regex) must be marked incompletely-enumerated and
    Check B suppressed for it entirely -- otherwise the real,
    multi-line-declared method looks 'missing' on every call site. Found
    via a real false positive against the acceptance-test project
    (`ui_animation_system.AnimateYScale`/`FadeOutWidgets`, both declared
    with the parameter list wrapped across lines). Check A and Check C
    must still function on such a class, since neither depends on a
    complete member list."""

    def test_multiline_header_suppresses_check_b_for_that_class(self):
        files = {
            "manager.verse": (
                "ui_animation_system<public> := class:\n"
                "    AnimateYScale(\n"
                "        HeightStart : float,\n"
                "        HeightEnd : float\n"
                "    ):void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Sys : ui_animation_system):void=\n"
                "        Sys.AnimateYScale()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            self.assertTrue(project.types["ui_animation_system"].incompletely_enumerated)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])

    def test_check_a_still_runs_on_incompletely_enumerated_class(self):
        files = {
            "Framework/GameSystems/manager.verse": (
                "ui_animation_system<public> := class:\n"
                "    AnimateYScale(\n"
                "        HeightStart : float\n"
                "    ):void=\n"
                "        0\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt(Sys : ui_animation_system):void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            self.assertTrue(project.types["ui_animation_system"].incompletely_enumerated)
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "missing-using")
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["path"].endswith("boss.verse"))

    def test_check_c_still_runs_on_incompletely_enumerated_class(self):
        files = {
            "manager.verse": (
                "ui_animation_system<public> := class:\n"
                "    Secret<private>():void=\n"
                "        0\n"
                "    AnimateYScale(\n"
                "        HeightStart : float\n"
                "    ):void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Sys : ui_animation_system):void=\n"
                "        Sys.Secret()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            self.assertTrue(project.types["ui_animation_system"].incompletely_enumerated)
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "private-access")
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["path"].endswith("user.verse"))

    def test_incomplete_ancestor_suppresses_check_b_for_descendant(self):
        """The same suppression must propagate through inheritance: a
        class extending an incompletely-enumerated PROJECT ancestor cannot
        trust its own resolved member set either."""
        files = {
            "base.verse": (
                "base_system<public> := class:\n"
                "    AnimateYScale(\n"
                "        HeightStart : float\n"
                "    ):void=\n"
                "        0\n"
            ),
            "manager.verse": (
                "ui_animation_system<public> := class(base_system):\n"
                "    RealMethod<public>():void=\n"
                "        0\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Sys : ui_animation_system):void=\n"
                "        Sys.AnimateYScale()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])

    def test_var_field_with_specifier_attached_no_space_is_parsed(self):
        """`var<private> Field : T = ...` (specifier attached directly to
        `var`, no separating space) must parse the same as the ordinary
        `var Field<private> : T = ...` form -- real syntax observed in the
        acceptance-test project
        (Gorillas/Framework/Components/beskar_container_component.verse:68),
        previously invisible to the old whitespace-only `var` strip and
        marking the whole class incomplete."""
        files = {
            "manager.verse": (
                "beskar_part_animator<public> := class:\n"
                "    var<private> MovementComp : ?keyframed_movement_component = false\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
        tinfo = project.types["beskar_part_animator"]
        self.assertFalse(tinfo.incompletely_enumerated)
        self.assertIn("MovementComp", tinfo.members)
        self.assertEqual(tinfo.members["MovementComp"].access, "private")
        self.assertEqual(tinfo.members["MovementComp"].kind, "field")

    def test_enum_with_bare_identifiers_is_fully_enumerated(self):
        """A trivial enum body (bare identifiers, one per line, optional
        trailing commas -- the shape confirmed against every enum in the
        real acceptance-test project) must NOT be marked incomplete, and
        Check B must correctly flag a genuinely missing enum value."""
        files = {
            "manager.verse": (
                "rarity_tier<public> := enum:\n"
                "    Common\n"
                "    Rare,\n"
                "    Epic\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Tier : rarity_tier):void=\n"
                "        Tier.NotARealValue()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            self.assertFalse(project.types["rarity_tier"].incompletely_enumerated)
            self.assertEqual(set(project.types["rarity_tier"].members.keys()), {"Common", "Rare", "Epic"})
            findings = vpc.check_project_index(project)
        hits = _findings_by_category(findings, "missing-member")
        self.assertEqual(len(hits), 1)
        self.assertIn("NotARealValue", hits[0]["message"])

    def test_enum_with_unrecognised_line_still_suppresses(self):
        """An enum body line this tool cannot parse as a bare identifier
        must still fall back to the existing incomplete-enumeration
        suppression -- the enum parsing win must not weaken the general
        safety mechanism for constructs that remain unrecognised."""
        files = {
            "manager.verse": (
                "rarity_tier<public> := enum:\n"
                "    Common\n"
                "    Rare(weird_syntax)\n"
                "    Epic\n"
            ),
            "user.verse": (
                "user_device := class:\n"
                "    UseIt(Tier : rarity_tier):void=\n"
                "        Tier.NotARealValue()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            self.assertTrue(project.types["rarity_tier"].incompletely_enumerated)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])

    def test_clean_class_not_marked_incomplete(self):
        files = {
            "manager.verse": (
                "clean_system<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
        self.assertFalse(project.types["clean_system"].incompletely_enumerated)


class AmbiguousTypeNameTests(unittest.TestCase):
    """A type name declared more than once in the project is ambiguous --
    every check must stay silent about it (both directions: as a target of
    Check A, and as a member-owner for Check B/C)."""

    def test_duplicate_type_name_excluded_from_all_checks(self):
        files = {
            "A/manager.verse": (
                "dup_type<public> := class:\n"
                "    OnlyInA<public>():void=\n"
                "        0\n"
            ),
            "B/manager.verse": (
                "dup_type<public> := class:\n"
                "    OnlyInB<public>():void=\n"
                "        0\n"
            ),
            "C/user.verse": (
                "user_device := class:\n"
                "    UseIt(D : dup_type):void=\n"
                "        D.OnlyInA()\n"
            ),
        }
        with _TempProject(files) as root:
            project = vpc.build_project_index(root)
            self.assertIn("dup_type", project.ambiguous_types)
            findings = vpc.check_project_index(project)
        self.assertEqual(_findings_by_category(findings, "missing-using"), [])
        self.assertEqual(_findings_by_category(findings, "missing-member"), [])


class ModulePathTests(unittest.TestCase):
    """Directory-to-module-path mapping: dot-joined relative directory
    from the scan root (confirmed convention, see module docstring)."""

    def test_module_path_is_dot_joined_directory(self):
        with _TempProject({"Gorillas/Framework/GameSystems/manager.verse": "x<public> := class:\n    0\n"}) as root:
            project = vpc.build_project_index(root)
        self.assertEqual(project.files[0].module_path, "Gorillas.Framework.GameSystems")

    def test_root_file_has_empty_module_path(self):
        with _TempProject({"root_file.verse": "x<public> := class:\n    0\n"}) as root:
            project = vpc.build_project_index(root)
        self.assertEqual(project.files[0].module_path, "")


class IncompleteScanTests(unittest.TestCase):
    def test_zero_verse_files_reports_incomplete_via_main(self):
        with tempfile.TemporaryDirectory() as empty_root:
            exit_code = vpc.main([empty_root])
        self.assertEqual(exit_code, vpc.EXIT_INCOMPLETE_SCAN)

    def test_missing_path_is_usage_error(self):
        exit_code = vpc.main([os.path.join(tempfile.gettempdir(), "definitely_does_not_exist_vpc")])
        self.assertEqual(exit_code, vpc.EXIT_USAGE_ERROR)

    def test_no_args_is_usage_error(self):
        self.assertEqual(vpc.main([]), vpc.EXIT_USAGE_ERROR)


class ExitCodeTests(unittest.TestCase):
    def test_clean_project_exits_zero(self):
        files = {
            "manager.verse": "x<public> := class:\n    Foo<public>():void=\n        0\n",
        }
        with _TempProject(files) as root:
            exit_code = vpc.main([root])
        self.assertEqual(exit_code, vpc.EXIT_OK)

    def test_project_with_findings_exits_one(self):
        files = {
            "Framework/GameSystems/manager.verse": (
                "game_event_manager<public> := class:\n"
                "    Foo<public>():void=\n"
                "        0\n"
            ),
            "Features/BossFight/boss.verse": (
                "boss_device := class:\n"
                "    UseIt(Events : game_event_manager):void=\n"
                "        0\n"
            ),
        }
        with _TempProject(files) as root:
            exit_code = vpc.main([root])
        self.assertEqual(exit_code, vpc.EXIT_FINDINGS)


if __name__ == "__main__":
    unittest.main()
