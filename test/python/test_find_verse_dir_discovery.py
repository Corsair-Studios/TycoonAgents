"""Tests for device_audit.py's _find_verse_dir() discovery ladder
(media/uefn-bridge/device_audit.py, ~lines 514-... — see its docstring).

THE REGRESSION THIS FILE GUARDS: the bridge started running from the
ENGINE copy at
    C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Content\\Python\\
instead of the user's project's <project>\\Content\\Python\\. The old
_find_verse_dir walked up from __file__ with no install-tree awareness, hit
FortniteGame\\Plugins, and returned
Plugins\\VerseDevices\\ScriptTemplates -- 2 of Epic's own template .verse
files -- as if it were the user's project. It did not fail; it SUCCEEDED
ON THE WRONG TREE, which is worse: uefn_tag_inspect reported a plausible
looking "2 .verse file(s) scanned, 0 tag class(es) found" while the real
project's 112 .verse files and __ExternalActors__ tree were never touched.

SECOND REGRESSION THIS FILE GUARDS (2026-08-19, live UEFN session):
StarWars was the open project; _find_verse_dir returned DetonationDemo's
Content dir instead, because with 8 candidate projects under "Fortnite
Projects", the registry rung (then rung 2/3) picked by directory-listing
order -- it had no notion of which project was actually OPEN. Verified in
that same session: every unreal.Paths function (project_dir,
project_content_dir, project_config_dir, get_project_file_path,
project_plugins_dir) returns a path rooted at .../FortniteGame/..., i.e.
the ENGINE INSTALL -- never the user's project -- so that rung never had a
usable signal either. The fix is a new rung that reads the EDITOR WORLD's
package path (e.g. "/StarWars/StarWars.StarWars"), takes its first path
segment as the project's mount point ("StarWars"), and resolves that
specific name to a directory -- ground truth for what's actually open,
not a guess among candidates.

Per docs/PATH-DISCOVERY.md, _find_verse_dir is now a discovery-ladder
exemplar:
  1. UEFN_VERSE_PROJECT_DIR env override -- always wins.
  2. Editor-world mount point -> resolved project dir (the OPEN project,
     ground truth). Engine mounts (Game, Engine, Temp, Script,
     FortniteGame) are rejected. Tries the modern
     unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem) API first,
     falls back to the legacy unreal.EditorLevelLibrary; a stub/partial
     unreal missing both degrades to None, never raises.
  3. unreal.Paths-derived live project dir, validated (rejected if it
     structurally sits inside a Fortnite/Epic install tree, or doesn't
     have .verse files) -- MEASURED to always be the FortniteGame engine
     install in UEFN, so this is a safety net only.
  4. Windows registry "Personal" (Documents) known folder ->
     "Fortnite Projects\\*" glob. Windows-only, fails open.
  5. The original __file__-relative strategies, but every candidate is now
     rejected if it structurally sits inside a Fortnite/Epic install tree
     (a "FortniteGame" path segment followed later by a "Plugins" segment
     -- see _is_inside_fortnite_install).
Across all rungs, a candidate with .verse files AND a
Content/__ExternalActors__ dir (a "real project shape") is preferred over
a bare .verse-only directory.

Test strategy: build small real temp-directory trees (never mock
os.walk/os.listdir) so the ladder's actual filesystem logic runs, and
patch os.path.dirname(os.path.abspath(__file__)) indirectly by monkey
patching device_audit.__file__ to point the "script_dir" at a script
inside our fake tree. UEFN_VERSE_PROJECT_DIR and unreal.Paths are
controlled per-test; the registry rung is controlled by installing/
removing a fake 'winreg' module in sys.modules (device_audit imports it
locally inside the function, guarded by try/except).
"""
import os
import sys
import shutil
import tempfile
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
_unreal = stub_unreal()

import device_audit  # noqa: E402


_MISSING = object()  # sentinel: "this attr was absent from _unreal before setUp touched it"


def _touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("")


def _make_real_project(root, n_verse=2):
    """<root>/Content/Python/device_audit.py (script location),
    <root>/Content/*.verse, <root>/Content/__ExternalActors__/x.uasset."""
    content = os.path.join(root, "Content")
    _touch(os.path.join(content, "Python", "device_audit.py"))
    for i in range(n_verse):
        _touch(os.path.join(content, f"file{i}.verse"))
    _touch(os.path.join(content, "__ExternalActors__", "actor0.uasset"))
    return os.path.join(content, "Python", "device_audit.py")


def _make_fake_install_tree(root):
    """<root>/FortniteGame/Content/Python/device_audit.py (script location)
    and <root>/FortniteGame/Plugins/VerseDevices/ScriptTemplates/*.verse --
    reproduces the exact regression shape."""
    fn_game = os.path.join(root, "FortniteGame")
    script = os.path.join(fn_game, "Content", "Python", "device_audit.py")
    _touch(script)
    templates = os.path.join(fn_game, "Plugins", "VerseDevices", "ScriptTemplates")
    _touch(os.path.join(templates, "Template1.verse"))
    _touch(os.path.join(templates, "Template2.verse"))
    return script


class _BaseCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="find_verse_dir_")
        self._orig_file = device_audit.__file__
        self._had_env = "UEFN_VERSE_PROJECT_DIR" in os.environ
        self._orig_env = os.environ.get("UEFN_VERSE_PROJECT_DIR")
        os.environ.pop("UEFN_VERSE_PROJECT_DIR", None)
        self._orig_winreg = sys.modules.get("winreg")
        # Neutralize the registry rung by default -- this test box may be
        # real Windows with a real signed-in user's real Fortnite Projects
        # folder, which would otherwise leak into every test not
        # specifically exercising the registry rung (per
        # docs/PATH-DISCOVERY.md's testing rule: a test must not pass only
        # because of real data on the developer's machine). Tests that
        # want to exercise the rung install their own fake winreg.
        _noop_winreg = MagicMock(name="winreg")
        _noop_winreg.HKEY_CURRENT_USER = "HKCU"
        _noop_winreg.OpenKey = MagicMock(side_effect=FileNotFoundError("neutralized for test"))
        sys.modules["winreg"] = _noop_winreg
        # Reset unreal.Paths to a bare MagicMock attribute each test so
        # earlier tests' configuration never leaks.
        _unreal.Paths = MagicMock(name="Paths")
        del _unreal.Paths.project_content_dir
        del _unreal.Paths.project_dir
        # Neutralize the editor-world rung by default -- a bare MagicMock
        # auto-vivifies get_editor_subsystem/UnrealEditorSubsystem/
        # EditorLevelLibrary, which would otherwise fabricate a bogus
        # world path name and leak a phantom candidate into every test not
        # specifically exercising this rung. Tests that want the rung
        # configure it explicitly via _configure_editor_world.
        #
        # _unreal is a process-wide singleton shared with every OTHER
        # test_*.py module in this suite (they all stub the same `unreal`
        # entry in sys.modules), so deleting these attrs here must be
        # undone in tearDown -- leaving them deleted would break sibling
        # test files (test_uefn_bridge_level_edit.py,
        # test_list_devices_two_phase.py, etc.) that expect
        # get_editor_subsystem/EditorLevelLibrary to exist as plain
        # auto-vivified MagicMock attributes. Save each attr's prior value
        # (a sentinel when it was already absent) and restore exactly that
        # in tearDown.
        self._orig_world_apis = {}
        for _attr in ("get_editor_subsystem", "UnrealEditorSubsystem", "EditorLevelLibrary"):
            try:
                self._orig_world_apis[_attr] = getattr(_unreal, _attr)
            except AttributeError:
                self._orig_world_apis[_attr] = _MISSING
            try:
                delattr(_unreal, _attr)
            except AttributeError:
                pass

    def _configure_editor_world(self, path_name, via_legacy=False):
        """Wire the stub `unreal` module so `_editor_world_mount_name()`
        sees an editor world whose `get_path_name()` returns *path_name*
        (e.g. "/StarWars/StarWars.StarWars"). By default uses the modern
        `unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)` path;
        pass via_legacy=True to instead wire only
        `unreal.EditorLevelLibrary.get_editor_world()`, leaving the modern
        API absent so the fallback path is what's actually exercised."""
        world = MagicMock(name="EditorWorld")
        world.get_path_name = MagicMock(return_value=path_name)
        if via_legacy:
            level_lib = MagicMock(name="EditorLevelLibrary")
            level_lib.get_editor_world = MagicMock(return_value=world)
            _unreal.EditorLevelLibrary = level_lib
        else:
            subsystem = MagicMock(name="UnrealEditorSubsystem")
            subsystem.get_editor_world = MagicMock(return_value=world)
            _unreal.UnrealEditorSubsystem = MagicMock(name="UnrealEditorSubsystemClass")
            _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)

    def tearDown(self):
        device_audit.__file__ = self._orig_file
        if self._had_env:
            os.environ["UEFN_VERSE_PROJECT_DIR"] = self._orig_env
        else:
            os.environ.pop("UEFN_VERSE_PROJECT_DIR", None)
        if self._orig_winreg is not None:
            sys.modules["winreg"] = self._orig_winreg
        else:
            sys.modules.pop("winreg", None)
        # Restore the shared _unreal singleton's editor-world attrs exactly
        # as setUp found them, so sibling test_*.py modules in the same
        # process (which share this same stubbed `unreal` module) are
        # never left with get_editor_subsystem/EditorLevelLibrary missing.
        for _attr, _orig in self._orig_world_apis.items():
            if _orig is _MISSING:
                try:
                    delattr(_unreal, _attr)
                except AttributeError:
                    pass
            else:
                setattr(_unreal, _attr, _orig)
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _set_script_dir(self, script_path):
        device_audit.__file__ = script_path


class EnvOverrideTests(_BaseCase):
    def test_env_override_wins_over_everything(self):
        real_project = os.path.join(self._tmp, "RealProject")
        script = _make_real_project(real_project)
        self._set_script_dir(script)

        env_target = os.path.join(self._tmp, "EnvProject")
        _touch(os.path.join(env_target, "only.verse"))
        os.environ["UEFN_VERSE_PROJECT_DIR"] = env_target

        result = device_audit._find_verse_dir()
        self.assertEqual(os.path.normpath(result), os.path.normpath(env_target))

    def test_env_override_invalid_falls_through_to_other_rungs(self):
        real_project = os.path.join(self._tmp, "RealProject")
        script = _make_real_project(real_project)
        self._set_script_dir(script)

        os.environ["UEFN_VERSE_PROJECT_DIR"] = os.path.join(self._tmp, "does_not_exist")

        result = device_audit._find_verse_dir()
        self.assertIsNotNone(result)
        self.assertNotEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(self._tmp, "does_not_exist")),
        )


class InstallTreeRejectionTests(_BaseCase):
    def test_engine_copy_inside_fortnitegame_plugins_is_rejected(self):
        """THE ACTUAL REGRESSION: script running from
        .../FortniteGame/Content/Python/device_audit.py must NOT resolve to
        FortniteGame/Plugins/VerseDevices/ScriptTemplates even though that
        dir has .verse files."""
        install_root = os.path.join(self._tmp, "Program Files", "Epic Games", "Fortnite")
        script = _make_fake_install_tree(install_root)
        self._set_script_dir(script)

        result = device_audit._find_verse_dir()
        if result is not None:
            self.assertNotIn("ScriptTemplates", result)
            self.assertFalse(device_audit._is_inside_fortnite_install(result))

    def test_is_inside_fortnite_install_detects_structural_shape(self):
        bad = os.path.join(
            "C:", os.sep, "Program Files", "Epic Games", "Fortnite",
            "FortniteGame", "Plugins", "VerseDevices", "ScriptTemplates",
        )
        self.assertTrue(device_audit._is_inside_fortnite_install(bad))

    def test_is_inside_fortnite_install_false_for_user_project(self):
        good = os.path.join(
            "C:", os.sep, "Users", "someone", "OneDrive", "Documents",
            "Fortnite Projects", "StarWars", "Content",
        )
        self.assertFalse(device_audit._is_inside_fortnite_install(good))

    def test_other_install_drive_still_rejected(self):
        """Must not be a hardcoded 'C:\\Program Files' string match --
        works regardless of install drive/location."""
        install_root = os.path.join(self._tmp, "D_drive_games", "Epic Games", "Fortnite")
        script = _make_fake_install_tree(install_root)
        self._set_script_dir(script)
        result = device_audit._find_verse_dir()
        if result is not None:
            self.assertFalse(device_audit._is_inside_fortnite_install(result))


class RealProjectPreferenceTests(_BaseCase):
    def test_real_project_shape_preferred_over_bare_verse_dir(self):
        """Both a bare .verse-only dir AND a real-project-shaped dir
        (.verse + Content/__ExternalActors__) are reachable via the
        unreal.Paths rung and the __file__ rung respectively; the real
        project must win."""
        bare_dir = os.path.join(self._tmp, "BareVerseOnly")
        _touch(os.path.join(bare_dir, "one.verse"))

        real_project = os.path.join(self._tmp, "RealProject")
        script = _make_real_project(real_project, n_verse=3)
        self._set_script_dir(script)

        _unreal.Paths.project_content_dir = MagicMock(return_value=bare_dir)

        result = device_audit._find_verse_dir()
        self.assertEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(real_project, "Content")),
        )

    def test_looks_like_real_project_true_for_verse_plus_external_actors(self):
        real_project = os.path.join(self._tmp, "RP")
        _make_real_project(real_project)
        self.assertTrue(
            device_audit._looks_like_real_project(os.path.join(real_project, "Content"))
        )

    def test_looks_like_real_project_false_for_verse_only(self):
        bare_dir = os.path.join(self._tmp, "BareOnly")
        _touch(os.path.join(bare_dir, "one.verse"))
        self.assertFalse(device_audit._looks_like_real_project(bare_dir))


class UnrealPathsValidationTests(_BaseCase):
    def test_unreal_paths_pointing_at_install_is_rejected(self):
        """Regression note from the brief: unreal.Paths can return the
        INSTALL directory rather than the live project -- must be
        validated and rejected, not trusted outright."""
        install_root = os.path.join(self._tmp, "Program Files", "Epic Games", "Fortnite")
        _make_fake_install_tree(install_root)
        bad_path = os.path.join(install_root, "FortniteGame", "Plugins", "VerseDevices", "ScriptTemplates")
        _unreal.Paths.project_content_dir = MagicMock(return_value=bad_path)

        # No other rung available -> must not fall back to the bad path.
        other_script = os.path.join(self._tmp, "nowhere", "Content", "Python", "device_audit.py")
        _touch(other_script)
        self._set_script_dir(other_script)

        result = device_audit._find_verse_dir()
        if result is not None:
            self.assertFalse(device_audit._is_inside_fortnite_install(result))

    def test_unreal_paths_valid_project_dir_is_used(self):
        real_project = os.path.join(self._tmp, "LiveProject")
        _make_real_project(real_project)
        _unreal.Paths.project_content_dir = MagicMock(
            return_value=os.path.join(real_project, "Content")
        )
        other_script = os.path.join(self._tmp, "nowhere2", "Content", "Python", "device_audit.py")
        _touch(other_script)
        self._set_script_dir(other_script)

        result = device_audit._find_verse_dir()
        self.assertEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(real_project, "Content")),
        )


class RegistryRungTests(_BaseCase):
    def test_registry_rung_finds_project_under_documents(self):
        fake_docs = os.path.join(self._tmp, "FakeDocuments")
        real_project = os.path.join(fake_docs, "Fortnite Projects", "StarWars")
        _make_real_project(real_project)

        fake_winreg = MagicMock(name="winreg")
        fake_winreg.HKEY_CURRENT_USER = "HKCU"
        fake_key_cm = MagicMock()
        fake_key_cm.__enter__ = MagicMock(return_value=fake_key_cm)
        fake_key_cm.__exit__ = MagicMock(return_value=False)
        fake_winreg.OpenKey = MagicMock(return_value=fake_key_cm)
        fake_winreg.QueryValueEx = MagicMock(return_value=(fake_docs, 1))
        sys.modules["winreg"] = fake_winreg

        other_script = os.path.join(self._tmp, "elsewhere", "Content", "Python", "device_audit.py")
        _touch(other_script)
        self._set_script_dir(other_script)

        result = device_audit._find_verse_dir()
        self.assertEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(real_project, "Content")),
        )

    def test_registry_rung_fails_open_when_winreg_missing(self):
        sys.modules.pop("winreg", None)
        # Simulate ImportError by ensuring no real winreg is importable --
        # on a non-Windows test box this is already the case; on Windows,
        # the stdlib winreg would import for real, so instead verify the
        # candidate-gathering function itself never raises and degrades to
        # [] when OpenKey explodes.
        fake_winreg = MagicMock(name="winreg")
        fake_winreg.HKEY_CURRENT_USER = "HKCU"
        fake_winreg.OpenKey = MagicMock(side_effect=OSError("no such key"))
        sys.modules["winreg"] = fake_winreg

        candidates = device_audit._registry_fortnite_project_candidates()
        self.assertEqual(candidates, [])

    def test_registry_rung_fails_open_on_missing_key_end_to_end(self):
        real_project = os.path.join(self._tmp, "RealProject")
        script = _make_real_project(real_project)
        self._set_script_dir(script)

        fake_winreg = MagicMock(name="winreg")
        fake_winreg.HKEY_CURRENT_USER = "HKCU"
        fake_winreg.OpenKey = MagicMock(side_effect=FileNotFoundError("missing key"))
        sys.modules["winreg"] = fake_winreg

        # Must not raise, and must still resolve via the __file__ rung.
        result = device_audit._find_verse_dir()
        self.assertEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(real_project, "Content")),
        )


def _install_fake_winreg_docs(fake_docs):
    """Install a fake winreg module whose "Personal" value is *fake_docs*,
    the same shape RegistryRungTests uses -- shared here so
    EditorWorldRungTests can put multiple candidate projects under
    <fake_docs>/Fortnite Projects/ and drive the mount-resolution rung's
    root lookup through the same path the registry rung uses."""
    fake_winreg = MagicMock(name="winreg")
    fake_winreg.HKEY_CURRENT_USER = "HKCU"
    fake_key_cm = MagicMock()
    fake_key_cm.__enter__ = MagicMock(return_value=fake_key_cm)
    fake_key_cm.__exit__ = MagicMock(return_value=False)
    fake_winreg.OpenKey = MagicMock(return_value=fake_key_cm)
    fake_winreg.QueryValueEx = MagicMock(return_value=(fake_docs, 1))
    sys.modules["winreg"] = fake_winreg


class EditorWorldRungTests(_BaseCase):
    """Guards the exact regression from the brief: StarWars is the open
    project (per the editor world), but DetonationDemo -- and other
    candidate projects -- exist on disk and would otherwise be picked by
    directory-listing/glob order."""

    def test_open_project_wins_over_alphabetically_earlier_candidates(self):
        fake_docs = os.path.join(self._tmp, "FakeDocuments")
        projects_root = os.path.join(fake_docs, "Fortnite Projects")
        # Alphabetically-first candidates that must NOT be selected.
        _make_real_project(os.path.join(projects_root, "AlphaFirstProject"))
        detonation_demo = os.path.join(projects_root, "DetonationDemo")
        _make_real_project(detonation_demo)
        # The actually-open project, alphabetically LAST.
        star_wars = os.path.join(projects_root, "StarWars")
        _make_real_project(star_wars, n_verse=5)

        _install_fake_winreg_docs(fake_docs)
        self._configure_editor_world("/StarWars/StarWars.StarWars")

        other_script = os.path.join(self._tmp, "elsewhere", "Content", "Python", "device_audit.py")
        _touch(other_script)
        self._set_script_dir(other_script)

        result = device_audit._find_verse_dir()
        self.assertEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(star_wars, "Content")),
        )
        self.assertNotIn("AlphaFirstProject", result)
        self.assertNotIn("DetonationDemo", result)

    def test_open_project_wins_via_legacy_editor_level_library(self):
        fake_docs = os.path.join(self._tmp, "FakeDocuments")
        projects_root = os.path.join(fake_docs, "Fortnite Projects")
        detonation_demo = os.path.join(projects_root, "DetonationDemo")
        _make_real_project(detonation_demo)
        star_wars = os.path.join(projects_root, "StarWars")
        _make_real_project(star_wars)

        _install_fake_winreg_docs(fake_docs)
        self._configure_editor_world("/StarWars/StarWars.StarWars", via_legacy=True)

        other_script = os.path.join(self._tmp, "elsewhere2", "Content", "Python", "device_audit.py")
        _touch(other_script)
        self._set_script_dir(other_script)

        result = device_audit._find_verse_dir()
        self.assertEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(star_wars, "Content")),
        )

    def test_engine_mount_points_are_rejected(self):
        for bad_path_name in ("/Game/Maps/Entry", "/Engine/Transient", "/Script/FortniteGame"):
            with self.subTest(bad_path_name=bad_path_name):
                self._configure_editor_world(bad_path_name)
                self.assertIsNone(device_audit._editor_world_mount_name())
                self.assertIsNone(device_audit._editor_world_project_dir_candidate())

    def test_env_override_still_beats_editor_world_rung(self):
        fake_docs = os.path.join(self._tmp, "FakeDocuments")
        projects_root = os.path.join(fake_docs, "Fortnite Projects")
        star_wars = os.path.join(projects_root, "StarWars")
        _make_real_project(star_wars)
        _install_fake_winreg_docs(fake_docs)
        self._configure_editor_world("/StarWars/StarWars.StarWars")

        env_target = os.path.join(self._tmp, "EnvProject")
        _touch(os.path.join(env_target, "only.verse"))
        os.environ["UEFN_VERSE_PROJECT_DIR"] = env_target

        result = device_audit._find_verse_dir()
        self.assertEqual(os.path.normpath(result), os.path.normpath(env_target))

    def test_stub_unreal_missing_world_apis_falls_through_without_raising(self):
        # setUp already deletes get_editor_subsystem / UnrealEditorSubsystem
        # / EditorLevelLibrary, simulating a stub `unreal` lacking these
        # APIs entirely. Must degrade to None, never raise.
        self.assertIsNone(device_audit._editor_world_mount_name())
        self.assertIsNone(device_audit._editor_world_project_dir_candidate())

        # And end-to-end, _find_verse_dir must still resolve via a later
        # rung rather than blowing up.
        real_project = os.path.join(self._tmp, "RealProject")
        script = _make_real_project(real_project)
        self._set_script_dir(script)
        result = device_audit._find_verse_dir()
        self.assertEqual(
            os.path.normpath(result),
            os.path.normpath(os.path.join(real_project, "Content")),
        )

    def test_world_get_path_name_raising_falls_through_without_raising(self):
        world = MagicMock(name="EditorWorld")
        world.get_path_name = MagicMock(side_effect=RuntimeError("boom"))
        subsystem = MagicMock(name="UnrealEditorSubsystem")
        subsystem.get_editor_world = MagicMock(return_value=world)
        _unreal.UnrealEditorSubsystem = MagicMock(name="UnrealEditorSubsystemClass")
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)

        self.assertIsNone(device_audit._editor_world_mount_name())
        self.assertIsNone(device_audit._editor_world_project_dir_candidate())

    def test_mount_name_with_no_matching_directory_on_disk_yields_none(self):
        fake_docs = os.path.join(self._tmp, "FakeDocuments")
        projects_root = os.path.join(fake_docs, "Fortnite Projects")
        _make_real_project(os.path.join(projects_root, "SomeOtherProject"))
        _install_fake_winreg_docs(fake_docs)
        self._configure_editor_world("/NoSuchProject/NoSuchProject.NoSuchProject")

        self.assertEqual(device_audit._editor_world_mount_name(), "NoSuchProject")
        self.assertIsNone(device_audit._editor_world_project_dir_candidate())


class TotalFailureTests(_BaseCase):
    def test_total_failure_returns_none_and_names_override_var(self):
        empty_dir = os.path.join(self._tmp, "EmptyProjectDir")
        script = os.path.join(empty_dir, "Content", "Python", "device_audit.py")
        _touch(script)
        self._set_script_dir(script)

        _unreal.log_warning.reset_mock()
        result = device_audit._find_verse_dir()
        self.assertIsNone(result)
        self.assertTrue(_unreal.log_warning.called)
        warned_text = " ".join(
            str(call.args[0]) if call.args else ""
            for call in _unreal.log_warning.call_args_list
        )
        self.assertIn("UEFN_VERSE_PROJECT_DIR", warned_text)


if __name__ == "__main__":
    unittest.main()
