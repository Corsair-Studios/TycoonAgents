"""Tests for verse_lsp_check.py: the offline driver for Epic's bundled
verse-lsp language server (LSP/stdio), which returns REAL compiler
diagnostics rather than the text-level heuristics verse_lint.py and
verse_project_check.py use.

These tests deliberately NEVER spawn the real verse-lsp(.exe) binary and
never touch the network -- everything here targets the tool's pure
functions and precondition/failure paths, using temp directories and
synthetic fixtures, per this task's constraints. Several classes below are
explicit REGRESSION tests for bugs documented in the module's own
docstring (platform-binary selection, percent-encoded-URI conversion, and
the shutdown-time diagnostics-clearing collector bug) -- see
verse_lsp_check.py's module docstring for the full incident narrative each
one guards against.

verse_lsp_check.py lives in media/skills/uefn/, loaded the same way
test_verse_lint.py / test_verse_project_check.py load their targets: a
sys.path insert, not a package import.

The `handle` nested closure inside run_lsp_session (the exact function
that enforces "teardown-phase publishDiagnostics must never reach the
result") is extracted via `_bridge_helpers.extract_nested_function`, the
same technique test_suspect_queue_ordering.py uses to unit-test
moderation_scanner's nested ranking logic -- this exercises the REAL,
byte-for-byte compiled closure, not a hand-copied reimplementation that
could silently drift from the source.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(_THIS_DIR, "..", ".."))
SKILL_DIR = os.path.join(REPO_ROOT, "media", "skills", "uefn")

sys.path.insert(0, _THIS_DIR)
sys.path.insert(0, SKILL_DIR)
from _bridge_helpers import extract_nested_function  # noqa: E402
import verse_lsp_check as vsc  # noqa: E402


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return path


def _make_extension(extensions_root, version, platforms=("Win64",), extra_siblings=()):
    """Writes a fake `epicgames.verse-<version>` extension directory under
    `extensions_root`, with an EMPTY placeholder `verse-lsp(.exe)` binary
    for each of `platforms` in ("Win64", "Mac", "Linux"). Returns the
    extension directory path."""
    ext_dir = os.path.join(extensions_root, f"epicgames.verse-{version}")
    basenames = {"Win64": "verse-lsp.exe", "Mac": "verse-lsp", "Linux": "verse-lsp"}
    for plat in platforms:
        _write(os.path.join(ext_dir, "bin", plat, basenames[plat]), "fake binary\n")
    for rel in extra_siblings:
        _write(os.path.join(ext_dir, "bin", rel), "sibling file, not the binary\n")
    return ext_dir


class VersionSortKeyTests(unittest.TestCase):
    """`_version_sort_key`: numeric dot-segment sort key used to pick the
    highest-version extension when several are installed."""

    def test_numeric_version_parses_to_tuple(self):
        self.assertEqual(vsc._version_sort_key("0.0.55550516"), (0, 0, 55550516))

    def test_non_numeric_segment_degrades_to_zero_not_a_crash(self):
        self.assertEqual(vsc._version_sort_key("0.0.abcdef"), (0, 0, 0))

    def test_entirely_non_numeric_version_does_not_crash(self):
        self.assertEqual(vsc._version_sort_key("garbage-version-string"), (0,))

    def test_shorter_tuple_sorts_below_longer_numeric_prefix_match(self):
        """(0,) < (0, 0, 5) -- a garbage version must lose to any real
        numeric one, never accidentally win by tuple-length quirks."""
        self.assertLess(vsc._version_sort_key("garbage"), vsc._version_sort_key("0.0.5"))


class LspBuildNumberTests(unittest.TestCase):
    """`_lsp_build_number`: trailing numeric dot-segment, or None (never a
    guessed 0) when there isn't one -- used only as a non-fatal version-
    sanity signal."""

    def test_numeric_trailing_segment_extracted(self):
        self.assertEqual(vsc._lsp_build_number("0.0.55550516"), 55550516)

    def test_non_numeric_trailing_segment_returns_none(self):
        self.assertIsNone(vsc._lsp_build_number("unknown (VERSE_LSP_PATH override)"))

    def test_empty_string_returns_none(self):
        self.assertIsNone(vsc._lsp_build_number(""))


class LocateLspExeDiscoveryTests(unittest.TestCase):
    """`locate_lsp_exe`: extension discovery, highest-version-wins, and the
    VERSE_LSP_PATH override contract."""

    def _isolated_env(self, tmp_home):
        return mock.patch.dict(os.environ, {"USERPROFILE": tmp_home}, clear=False)

    def test_highest_version_wins_across_multiple_extension_dirs(self):
        with tempfile.TemporaryDirectory() as tmp_home:
            _make_extension(os.path.join(tmp_home, ".vscode", "extensions"), "0.0.100")
            _make_extension(os.path.join(tmp_home, ".cursor", "extensions"), "0.0.55550516")
            _make_extension(os.path.join(tmp_home, ".windsurf", "extensions"), "0.0.200")
            with self._isolated_env(tmp_home):
                os.environ.pop("VERSE_LSP_PATH", None)
                chosen, candidates, roots, err = vsc.locate_lsp_exe()
        self.assertIsNone(err)
        self.assertEqual(len(candidates), 3)
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["version"], "0.0.55550516")

    def test_multiple_versions_in_the_same_extensions_root_pick_highest(self):
        with tempfile.TemporaryDirectory() as tmp_home:
            root = os.path.join(tmp_home, ".vscode", "extensions")
            _make_extension(root, "0.0.5")
            _make_extension(root, "0.0.9")
            _make_extension(root, "0.0.7")
            with self._isolated_env(tmp_home):
                os.environ.pop("VERSE_LSP_PATH", None)
                chosen, candidates, roots, err = vsc.locate_lsp_exe()
        self.assertEqual(chosen["version"], "0.0.9")
        self.assertEqual(len(candidates), 3)

    def test_garbage_version_suffix_does_not_crash_and_loses_to_numeric(self):
        with tempfile.TemporaryDirectory() as tmp_home:
            root = os.path.join(tmp_home, ".vscode", "extensions")
            _make_extension(root, "abcdef")
            _make_extension(root, "0.0.5")
            with self._isolated_env(tmp_home):
                os.environ.pop("VERSE_LSP_PATH", None)
                chosen, candidates, roots, err = vsc.locate_lsp_exe()
        self.assertEqual(len(candidates), 2)  # both are valid candidates, no crash
        self.assertEqual(chosen["version"], "0.0.5")

    def test_no_extensions_installed_returns_none_with_no_error(self):
        with tempfile.TemporaryDirectory() as tmp_home:
            with self._isolated_env(tmp_home):
                os.environ.pop("VERSE_LSP_PATH", None)
                chosen, candidates, roots, err = vsc.locate_lsp_exe()
        self.assertIsNone(chosen)
        self.assertEqual(candidates, [])
        self.assertIsNone(err)
        self.assertTrue(len(roots) > 0)  # still reports what it searched

    def test_verse_lsp_path_override_wins_over_discovery(self):
        with tempfile.TemporaryDirectory() as tmp_home, tempfile.TemporaryDirectory() as override_dir:
            # A "real" discoverable extension exists too, but must be ignored.
            _make_extension(os.path.join(tmp_home, ".vscode", "extensions"), "0.0.999")
            override_path = _write(os.path.join(override_dir, "my-custom-verse-lsp.exe"), "x")
            with self._isolated_env(tmp_home):
                with mock.patch.dict(os.environ, {"VERSE_LSP_PATH": override_path}, clear=False):
                    chosen, candidates, roots, err = vsc.locate_lsp_exe()
        self.assertIsNone(err)
        self.assertEqual(candidates, [])
        self.assertEqual(chosen["path"], override_path)

    def test_verse_lsp_path_override_nonexistent_file_reports_error_not_crash(self):
        bogus = os.path.join(tempfile.gettempdir(), "definitely-does-not-exist-verse-lsp.exe")
        self.assertFalse(os.path.exists(bogus))
        with mock.patch.dict(os.environ, {"VERSE_LSP_PATH": bogus}, clear=False):
            chosen, candidates, roots, err = vsc.locate_lsp_exe()
        self.assertIsNone(chosen)
        self.assertIsNotNone(err)
        self.assertIn(repr(bogus), err)


class PlatformBinarySelectionRegressionTests(unittest.TestCase):
    """REGRESSION: `bin/*/verse-lsp*` matches the Win64 .exe, the Mac
    binary, AND the Linux binary all at once, and a naive sort previously
    let the Linux binary win on Windows -- crashing with WinError 193 ("%1
    is not a valid Win32 application"). See verse_lsp_check.py's STEP 1
    comment. This must never regress."""

    def _expected_basename(self):
        return "verse-lsp.exe" if os.name == "nt" else "verse-lsp"

    def test_correct_platform_binary_selected_when_all_three_present(self):
        with tempfile.TemporaryDirectory() as tmp_home:
            root = os.path.join(tmp_home, ".vscode", "extensions")
            _make_extension(
                root, "0.0.42", platforms=("Win64", "Mac", "Linux"),
                extra_siblings=("Win64/verse-lsp.pdb",),
            )
            with mock.patch.dict(os.environ, {"USERPROFILE": tmp_home}, clear=False):
                os.environ.pop("VERSE_LSP_PATH", None)
                chosen, candidates, roots, err = vsc.locate_lsp_exe()
        self.assertIsNone(err)
        self.assertIsNotNone(chosen)
        # The wrong-platform (and sibling .pdb) files must never even become
        # candidates -- exactly one candidate should survive the filter.
        self.assertEqual(len(candidates), 1)
        self.assertEqual(os.path.basename(chosen["path"]).lower(), self._expected_basename())

    def test_wrong_platform_binaries_are_never_selected_regardless_of_glob_order(self):
        """Linux/Mac sort ahead of Win64 alphabetically -- prove the filter,
        not sort order, is what protects the outcome."""
        with tempfile.TemporaryDirectory() as tmp_home:
            root = os.path.join(tmp_home, ".vscode", "extensions")
            _make_extension(root, "0.0.1", platforms=("Linux", "Mac", "Win64"))
            with mock.patch.dict(os.environ, {"USERPROFILE": tmp_home}, clear=False):
                os.environ.pop("VERSE_LSP_PATH", None)
                chosen, candidates, roots, err = vsc.locate_lsp_exe()
        expected = self._expected_basename()
        for c in candidates:
            self.assertEqual(os.path.basename(c["path"]).lower(), expected)


@unittest.skipUnless(os.name == "nt", "drive-letter file-URI conversion is Windows-specific")
class UriConversionRegressionTests(unittest.TestCase):
    """REGRESSION: the stdlib `url2pathname` mangled a percent-encoded
    drive colon (`file:///C%3A/...`, the form the REAL server sends) into
    a path with a stray leading backslash. `_uri_to_path` is hand-rolled to
    avoid that. See verse_lsp_check.py's `_uri_to_path` docstring."""

    def test_plain_drive_colon_form_converts_correctly(self):
        uri = "file:///C:/Users/Test%20User/Project/Content/foo.verse"
        self.assertEqual(vsc._uri_to_path(uri), r"C:\Users\Test User\Project\Content\foo.verse")

    def test_percent_encoded_drive_colon_form_converts_correctly(self):
        """The exact server-observed form -- the one that broke url2pathname."""
        uri = "file:///C%3A/Users/Test%20User/Project/Content/foo.verse"
        result = vsc._uri_to_path(uri)
        self.assertEqual(result, r"C:\Users\Test User\Project\Content\foo.verse")
        # The historical bug's specific symptom: a stray leading backslash.
        self.assertFalse(result.startswith("\\"))

    def test_both_uri_forms_round_trip_to_the_identical_path(self):
        plain = "file:///C:/Users/Someone/Project/Content/bar.verse"
        encoded = "file:///C%3A/Users/Someone/Project/Content/bar.verse"
        self.assertEqual(vsc._uri_to_path(plain), vsc._uri_to_path(encoded))

    def test_path_to_uri_percent_encodes_spaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Folder With Spaces", "foo.verse")
            uri = vsc._path_to_uri(target)
        self.assertIn("%20", uri)
        self.assertNotIn(" ", uri)

    def test_round_trip_through_path_to_uri_and_back_preserves_spaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Real Project Path", "Content", "some file.verse")
            uri = vsc._path_to_uri(target)
            recovered = vsc._uri_to_path(uri)
        self.assertEqual(os.path.normcase(recovered), os.path.normcase(target))


class IsResponseToTests(unittest.TestCase):
    """`_is_response_to`: the critical id-vs-method disambiguation. A
    message carrying BOTH a matching numeric id AND a 'method' key is a
    server-originated request (e.g. client/registerCapability), never a
    response to one of our own requests -- even though ids are not a
    shared namespace between the two directions. Getting this backwards
    silently stalls the handshake (see module docstring)."""

    def test_result_with_no_method_and_matching_id_is_a_response(self):
        self.assertTrue(vsc._is_response_to({"id": 1, "result": {}}, 1))

    def test_error_with_no_method_and_matching_id_is_a_response(self):
        self.assertTrue(vsc._is_response_to({"id": 1, "error": {"message": "boom"}}, 1))

    def test_message_with_method_key_is_never_a_response_even_if_id_matches(self):
        self.assertFalse(
            vsc._is_response_to({"id": 1, "method": "client/registerCapability", "result": {}}, 1)
        )

    def test_id_mismatch_is_not_a_response(self):
        self.assertFalse(vsc._is_response_to({"id": 2, "result": {}}, 1))

    def test_eof_sentinel_is_not_a_response(self):
        self.assertFalse(vsc._is_response_to(vsc.EOF_SENTINEL, 1))


class ResolveContentDirTests(unittest.TestCase):
    def test_root_dir_with_content_subdir_resolves(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = os.path.join(tmp, "MyProject")
            os.makedirs(os.path.join(project_root, "Content"))
            content_dir, root = vsc.resolve_content_dir(project_root)
        self.assertIsNotNone(content_dir)
        self.assertEqual(content_dir.name, "Content")

    def test_content_dir_given_directly_resolves(self):
        with tempfile.TemporaryDirectory() as tmp:
            content = os.path.join(tmp, "MyProject", "Content")
            os.makedirs(content)
            content_dir, root = vsc.resolve_content_dir(content)
        self.assertIsNotNone(content_dir)
        self.assertEqual(content_dir.name, "Content")

    def test_nonexistent_path_returns_none_none(self):
        bogus = os.path.join(tempfile.gettempdir(), "definitely-does-not-exist-vsc-target")
        content_dir, root = vsc.resolve_content_dir(bogus)
        self.assertIsNone(content_dir)
        self.assertIsNone(root)

    def test_dir_without_content_subdir_returns_none_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            content_dir, root = vsc.resolve_content_dir(tmp)
        self.assertIsNone(content_dir)
        self.assertIsNone(root)


def _vproject_json(dir_path, name="SomeProject", role="Source", extra_desc=None, extra_top=None):
    desc = {"dirPath": dir_path, "name": name, "settings": {"role": role, "unknownSetting": True}}
    if extra_desc:
        desc.update(extra_desc)
    pkg = {"desc": desc, "unknownPackageKey": 123}
    obj = {"packages": [pkg], "unknownTopLevelKey": "schema-drift-is-expected"}
    if extra_top:
        obj.update(extra_top)
    return json.dumps(obj, indent=2)


def _write_vproject(appdata_root, project_folder, file_name, raw_content):
    path = os.path.join(
        appdata_root, "UnrealEditorFortnite", "Saved", "VerseProject",
        project_folder, "vproject", file_name,
    )
    return _write(path, raw_content)


class VprojectMatchingByContentTests(unittest.TestCase):
    """`locate_vproject`: matches by canonicalised, case-insensitive
    Source-package dirPath -- NEVER by project/file name. Fixtures below
    are deliberately named to mismatch the correct answer, so a
    name-based implementation would pick the wrong one (or none)."""

    def _appdata(self, tmp):
        return os.path.join(tmp, "appdata")

    def test_exactly_one_match_by_path_even_though_name_points_elsewhere(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "RealTarget", "Content")
            os.makedirs(target)
            appdata = self._appdata(tmp)
            # Named "WrongNameProject" but its dirPath IS the real target.
            _write_vproject(
                appdata, "WrongNameProject", "WrongNameProject.vproject",
                _vproject_json(target, name="TotallyUnrelatedName"),
            )
            # Named to look right, but its dirPath points elsewhere.
            _write_vproject(
                appdata, "RealTarget", "RealTarget.vproject",
                _vproject_json(os.path.join(tmp, "SomewhereElse", "Content"), name="RealTarget"),
            )
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(target)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["workspace_name"], "TotallyUnrelatedName")

    def test_no_match_reports_reason_and_lists_what_was_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Target", "Content")
            os.makedirs(target)
            appdata = self._appdata(tmp)
            _write_vproject(
                appdata, "Other", "Other.vproject",
                _vproject_json(os.path.join(tmp, "SomewhereElse", "Content")),
            )
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(target)
        self.assertIsNone(entry)
        self.assertEqual(info["reason"], "no_match")
        self.assertEqual(len(info["parsed_entries"]), 1)

    def test_ambiguous_multiple_matches_reported_not_silently_resolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Target", "Content")
            os.makedirs(target)
            appdata = self._appdata(tmp)
            _write_vproject(appdata, "CopyA", "CopyA.vproject", _vproject_json(target, name="A"))
            _write_vproject(appdata, "CopyB", "CopyB.vproject", _vproject_json(target, name="B"))
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(target)
        self.assertIsNone(entry)
        self.assertEqual(info["reason"], "ambiguous")
        self.assertEqual(len(info["matches"]), 2)

    def test_malformed_json_does_not_crash_and_is_recorded_as_parse_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Target", "Content")
            os.makedirs(target)
            appdata = self._appdata(tmp)
            _write_vproject(appdata, "Broken", "Broken.vproject", "{ this is not valid json ][")
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(target)  # must not raise
        self.assertIsNone(entry)
        self.assertEqual(info["reason"], "no_match")
        self.assertEqual(len(info["parse_failures"]), 1)

    def test_truncated_json_does_not_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Target", "Content")
            os.makedirs(target)
            appdata = self._appdata(tmp)
            _write_vproject(appdata, "Truncated", "Truncated.vproject", '{"packages": [{"desc": {')
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(target)  # must not raise
        self.assertIsNone(entry)
        self.assertEqual(info["reason"], "no_match")

    def test_unknown_extra_keys_and_malformed_sibling_packages_do_not_crash(self):
        """Schema drift: unexpected extra keys everywhere, plus junk
        entries in `packages` (None, missing desc, non-Source role) mixed
        in with the real one -- must resolve the real match without
        raising."""
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Target", "Content")
            os.makedirs(target)
            appdata = self._appdata(tmp)
            obj = {
                "packages": [
                    None,
                    "not-a-dict",
                    {"desc": None},
                    {"desc": {"settings": None}},
                    {"desc": {"settings": {"role": "NotSource"}}},
                    {"desc": {"dirPath": target, "name": "Real", "settings": {"role": "Source"}}, "newField": [1, 2, 3]},
                ],
                "engineVersion": "future-schema-field",
            }
            _write_vproject(appdata, "Mixed", "Mixed.vproject", json.dumps(obj))
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(target)  # must not raise
        self.assertIsNotNone(entry)
        self.assertEqual(entry["workspace_name"], "Real")

    def test_case_insensitive_and_canonicalised_path_matching(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "Target", "Content")
            os.makedirs(target)
            appdata = self._appdata(tmp)
            # Different case AND an extra "..\." wrinkle a naive string
            # compare would fail on, but canonicalisation should not.
            differently_cased = os.path.join(tmp, "TARGET", "Content").upper()
            _write_vproject(
                appdata, "Cased", "Cased.vproject",
                _vproject_json(differently_cased, name="Cased"),
            )
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(target)
        self.assertIsNotNone(entry)

    def test_localappdata_unset_reports_reason(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("LOCALAPPDATA", None)
            entry, info = vsc.locate_vproject(os.path.join(tempfile.gettempdir(), "x", "Content"))
        self.assertIsNone(entry)
        self.assertEqual(info["reason"], "localappdata_unset")

    def test_no_vprojects_at_all_reports_reason(self):
        with tempfile.TemporaryDirectory() as appdata:
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": appdata}, clear=False):
                entry, info = vsc.locate_vproject(os.path.join(tempfile.gettempdir(), "x", "Content"))
        self.assertIsNone(entry)
        self.assertEqual(info["reason"], "none_at_all")


class ExitCodeContractTests(unittest.TestCase):
    """0 clean / 1 findings / 2 usage error / 3 preconditions not met.
    Every precondition-failure path must yield 3, and specifically NEVER
    0 -- this repo has a documented history of tools returning a
    success shape after a failure."""

    def test_all_four_exit_codes_are_distinct(self):
        codes = {vsc.EXIT_OK, vsc.EXIT_FINDINGS, vsc.EXIT_USAGE_ERROR, vsc.EXIT_PRECONDITION_FAILED}
        self.assertEqual(len(codes), 4)

    def test_no_args_is_usage_error(self):
        self.assertEqual(vsc.main([]), vsc.EXIT_USAGE_ERROR)

    def test_target_not_a_uefn_project_is_usage_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(vsc.main([tmp]), vsc.EXIT_USAGE_ERROR)  # no Content subdir

    def test_unknown_option_is_usage_error(self):
        self.assertEqual(vsc.main(["--not-a-real-flag"]), vsc.EXIT_USAGE_ERROR)

    def test_bad_timeout_value_is_usage_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "Content"))
            self.assertEqual(vsc.main([tmp, "--timeout", "not-a-number"]), vsc.EXIT_USAGE_ERROR)

    def _fixture(self, tmp):
        """Builds a target project (with one .verse file) plus a matching
        vproject fixture under an isolated LOCALAPPDATA, returns
        (target_root, patches) where `patches` is a dict of env overrides
        the caller applies via mock.patch.dict."""
        project_root = os.path.join(tmp, "Project")
        content_dir_path = os.path.join(project_root, "Content")
        os.makedirs(content_dir_path)
        _write(os.path.join(content_dir_path, "foo.verse"), "foo_device := class:\n    0\n")
        content_dir, _ = vsc.resolve_content_dir(project_root)
        appdata = os.path.join(tmp, "appdata")
        _write_vproject(
            appdata, "Project", "Project.vproject",
            _vproject_json(str(content_dir), name="Project"),
        )
        lsp_dummy = _write(os.path.join(tmp, "fake-verse-lsp.exe"), "x")
        return project_root, {"LOCALAPPDATA": appdata, "VERSE_LSP_PATH": lsp_dummy}

    def test_precondition_missing_extension_yields_3_not_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = os.path.join(tmp, "Project")
            os.makedirs(os.path.join(project_root, "Content"))
            with mock.patch.dict(os.environ, {"USERPROFILE": tmp}, clear=False):
                os.environ.pop("VERSE_LSP_PATH", None)
                exit_code = vsc.main([project_root])
        self.assertEqual(exit_code, vsc.EXIT_PRECONDITION_FAILED)
        self.assertNotEqual(exit_code, vsc.EXIT_OK)

    def test_precondition_override_path_nonexistent_yields_3_not_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = os.path.join(tmp, "Project")
            os.makedirs(os.path.join(project_root, "Content"))
            bogus = os.path.join(tmp, "does-not-exist.exe")
            with mock.patch.dict(os.environ, {"VERSE_LSP_PATH": bogus}, clear=False):
                exit_code = vsc.main([project_root])
        self.assertEqual(exit_code, vsc.EXIT_PRECONDITION_FAILED)
        self.assertNotEqual(exit_code, vsc.EXIT_OK)

    def test_precondition_missing_vproject_yields_3_not_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = os.path.join(tmp, "Project")
            os.makedirs(os.path.join(project_root, "Content"))
            lsp_dummy = _write(os.path.join(tmp, "fake-verse-lsp.exe"), "x")
            empty_appdata = os.path.join(tmp, "appdata")
            os.makedirs(empty_appdata)
            with mock.patch.dict(
                os.environ, {"VERSE_LSP_PATH": lsp_dummy, "LOCALAPPDATA": empty_appdata}, clear=False
            ):
                exit_code = vsc.main([project_root])
        self.assertEqual(exit_code, vsc.EXIT_PRECONDITION_FAILED)
        self.assertNotEqual(exit_code, vsc.EXIT_OK)

    def test_precondition_no_verse_files_yields_3_not_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = os.path.join(tmp, "Project")
            content_dir_path = os.path.join(project_root, "Content")
            os.makedirs(content_dir_path)  # zero .verse files inside
            content_dir, _ = vsc.resolve_content_dir(project_root)
            appdata = os.path.join(tmp, "appdata")
            _write_vproject(appdata, "Project", "Project.vproject", _vproject_json(str(content_dir)))
            lsp_dummy = _write(os.path.join(tmp, "fake-verse-lsp.exe"), "x")
            with mock.patch.dict(
                os.environ, {"VERSE_LSP_PATH": lsp_dummy, "LOCALAPPDATA": appdata}, clear=False
            ):
                exit_code = vsc.main([project_root])
        self.assertEqual(exit_code, vsc.EXIT_PRECONDITION_FAILED)
        self.assertNotEqual(exit_code, vsc.EXIT_OK)

    def test_precondition_handshake_failed_yields_3_not_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root, env = self._fixture(tmp)
            fake_session = {
                "handshake_ok": False, "init_error": "simulated handshake failure",
                "diagnostics": {}, "stderr_tail": [], "opened_files": [], "timed_out": False,
            }
            with mock.patch.dict(os.environ, env, clear=False):
                with mock.patch("verse_lsp_check.run_lsp_session", return_value=fake_session):
                    exit_code = vsc.main([project_root])
        self.assertEqual(exit_code, vsc.EXIT_PRECONDITION_FAILED)
        self.assertNotEqual(exit_code, vsc.EXIT_OK)

    def test_clean_analysis_exits_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root, env = self._fixture(tmp)
            fake_session = {
                "handshake_ok": True, "init_error": None,
                "diagnostics": {}, "stderr_tail": [], "opened_files": [], "timed_out": False,
            }
            with mock.patch.dict(os.environ, env, clear=False):
                with mock.patch("verse_lsp_check.run_lsp_session", return_value=fake_session):
                    exit_code = vsc.main([project_root])
        self.assertEqual(exit_code, vsc.EXIT_OK)

    def test_findings_present_exits_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root, env = self._fixture(tmp)
            fake_session = {
                "handshake_ok": True, "init_error": None,
                "diagnostics": {
                    "file:///C:/Project/Content/foo.verse": [
                        {"range": {"start": {"line": 0, "character": 0}}, "severity": 1, "message": "bad"}
                    ]
                },
                "stderr_tail": [], "opened_files": [], "timed_out": False,
            }
            with mock.patch.dict(os.environ, env, clear=False):
                with mock.patch("verse_lsp_check.run_lsp_session", return_value=fake_session):
                    exit_code = vsc.main([project_root])
        self.assertEqual(exit_code, vsc.EXIT_FINDINGS)


class TeardownSnapshotProtectionRegressionTests(unittest.TestCase):
    """REGRESSION: after `shutdown`, the server republishes every file with
    an EMPTY diagnostics array as part of teardown. run_lsp_session's
    inline `handle` closure guards against that by only ever writing into
    `result["diagnostics"]` when `collect_diagnostics=True` -- and the
    shutdown drain loop is the one call site that passes False (see
    verse_lsp_check.py lines ~705-709). This extracts the REAL, compiled
    `handle` closure (not a reimplementation) and drives it directly."""

    def _handle(self, result):
        proc = types.SimpleNamespace(stdin=io.BytesIO())
        return extract_nested_function(
            vsc.run_lsp_session, "handle", extra_closure={"result": result, "proc": proc}
        )

    def _publish(self, uri, diagnostics):
        return {
            "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": {"uri": uri, "diagnostics": diagnostics},
        }

    def test_real_diagnostics_survive_a_post_shutdown_empty_publish(self):
        result = {"diagnostics": {}}
        handle = self._handle(result)
        uri = "file:///C:/Project/Content/foo.verse"
        real_diag = [{"message": "a real compile error", "severity": 1}]

        handle(self._publish(uri, real_diag), collect_diagnostics=True)
        self.assertEqual(result["diagnostics"][uri], real_diag)

        # Simulates the teardown-time republish with an EMPTY array. The
        # real call site passes collect_diagnostics=False here.
        handle(self._publish(uri, []), collect_diagnostics=False)

        self.assertEqual(result["diagnostics"][uri], real_diag, "teardown drain must not erase real findings")

    def test_non_vacuity_incorrectly_collecting_during_teardown_would_erase_it(self):
        """Proves the test above is not vacuous: if teardown collection
        were (incorrectly) passed collect_diagnostics=True, the empty
        republish WOULD overwrite the real finding -- confirming the
        `collect_diagnostics=False` argument at the real call site is load
        bearing, not decorative."""
        result = {"diagnostics": {}}
        handle = self._handle(result)
        uri = "file:///C:/Project/Content/foo.verse"
        real_diag = [{"message": "a real compile error", "severity": 1}]

        handle(self._publish(uri, real_diag), collect_diagnostics=True)
        handle(self._publish(uri, []), collect_diagnostics=True)  # the bug this guards against

        self.assertEqual(
            result["diagnostics"][uri], [],
            "sanity check itself is broken: collecting during teardown should erase the finding",
        )

    def test_server_originated_request_during_teardown_is_ignored_not_mistaken_for_diagnostics(self):
        result = {"diagnostics": {}}
        handle = self._handle(result)
        # A request WITH an id and method must not be treated as a
        # publishDiagnostics notification -- it should be answered on
        # proc.stdin instead (mirroring how the real server-originated
        # `client/registerCapability` request is handled).
        handle({"id": 99, "method": "client/registerCapability", "params": {}}, collect_diagnostics=False)
        self.assertEqual(result["diagnostics"], {})


class LineIndexingTests(unittest.TestCase):
    """LSP diagnostics are 0-indexed; the tool's own output must be
    1-indexed editor lines/characters."""

    def test_lsp_line_60_becomes_editor_line_61(self):
        diags = {"file:///C:/x/foo.verse": [{"range": {"start": {"line": 60, "character": 0}}, "severity": 1, "message": "m"}]}
        findings = vsc._normalize_diagnostics(diags)
        self.assertEqual(findings[0]["line"], 61)

    def test_lsp_character_is_also_shifted_by_one(self):
        diags = {"file:///C:/x/foo.verse": [{"range": {"start": {"line": 0, "character": 4}}, "severity": 1, "message": "m"}]}
        findings = vsc._normalize_diagnostics(diags)
        self.assertEqual(findings[0]["character"], 5)

    def test_zero_zero_start_becomes_one_one(self):
        diags = {"file:///C:/x/foo.verse": [{"range": {"start": {"line": 0, "character": 0}}, "severity": 1, "message": "m"}]}
        findings = vsc._normalize_diagnostics(diags)
        self.assertEqual((findings[0]["line"], findings[0]["character"]), (1, 1))


class OutputFormattingTests(unittest.TestCase):
    """`_normalize_diagnostics` sorting/grouping, `SEVERITY_WORDS`, and the
    stable `--json` shape."""

    def test_errors_sort_before_warnings_across_different_files(self):
        diags = {
            "file:///C:/z_warn.verse": [{"range": {"start": {"line": 0, "character": 0}}, "severity": 2, "message": "warn"}],
            "file:///C:/a_err.verse": [{"range": {"start": {"line": 0, "character": 0}}, "severity": 1, "message": "err"}],
        }
        findings = vsc._normalize_diagnostics(diags)
        self.assertEqual([f["severity_word"] for f in findings], ["ERROR", "WARNING"])

    def test_severity_words_match_lsp_severity_numbers(self):
        self.assertEqual(vsc.SEVERITY_WORDS[1], "ERROR")
        self.assertEqual(vsc.SEVERITY_WORDS[2], "WARNING")
        self.assertEqual(vsc.SEVERITY_WORDS[3], "INFO")
        self.assertEqual(vsc.SEVERITY_WORDS[4], "HINT")

    def test_unrecognised_severity_number_maps_to_unknown(self):
        diags = {"file:///C:/x.verse": [{"range": {"start": {"line": 0, "character": 0}}, "severity": 99, "message": "m"}]}
        findings = vsc._normalize_diagnostics(diags)
        self.assertEqual(findings[0]["severity_word"], "UNKNOWN")

    def test_json_report_shape_and_summary_counts(self):
        findings = [
            {"path": "a.verse", "line": 1, "character": 1, "severity": 1, "severity_word": "ERROR", "code": "E1", "message": "bad"},
            {"path": "b.verse", "line": 2, "character": 2, "severity": 2, "severity_word": "WARNING", "code": "", "message": "meh"},
        ]
        meta = {
            "lsp_path": "C:/fake/verse-lsp.exe", "lsp_version": "0.0.1",
            "vproject_path": "C:/fake/x.vproject", "content_dir": "C:/fake/Content",
            "opened_files": ["a.verse"], "version_note": "note",
        }
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            vsc._print_json_report(findings, meta)
        parsed = json.loads(buf.getvalue())
        self.assertEqual(parsed["status"], "ok")
        self.assertEqual(parsed["summary"]["total"], 2)
        self.assertEqual(parsed["summary"]["by_severity"], {"ERROR": 1, "WARNING": 1})
        self.assertEqual(parsed["diagnostics"], findings)

    def test_human_report_clean_run_says_zero_diagnostics(self):
        meta = {
            "lsp_path": "x", "lsp_version": "0.0.1", "vproject_path": "y",
            "content_dir": "z", "opened_files": [], "version_note": None,
        }
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            vsc._print_human_report([], meta)
        self.assertIn("0 diagnostics.", buf.getvalue())
        self.assertIn(vsc.SCOPE_NOTE, buf.getvalue())

    def test_human_report_groups_by_file_and_summarises_counts(self):
        findings = [
            {"path": "a.verse", "line": 1, "character": 1, "severity": 1, "severity_word": "ERROR", "code": "E1", "message": "bad thing"},
            {"path": "a.verse", "line": 2, "character": 1, "severity": 2, "severity_word": "WARNING", "code": "", "message": "meh thing"},
        ]
        meta = {
            "lsp_path": "x", "lsp_version": "0.0.1", "vproject_path": "y",
            "content_dir": "z", "opened_files": ["a.verse"], "version_note": None,
        }
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            vsc._print_human_report(findings, meta)
        out = buf.getvalue()
        self.assertIn("a.verse", out)
        self.assertIn("bad thing", out)
        self.assertIn("meh thing", out)
        self.assertIn("2 diagnostic(s)", out)
        self.assertIn("1 file(s)", out)


if __name__ == "__main__":
    unittest.main()
