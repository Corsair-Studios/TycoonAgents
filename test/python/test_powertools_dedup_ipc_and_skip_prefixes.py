"""Drift-guard tests for the Power Tools de-duplication batch — IPC-CONTRACT
and SKIP-PREFIX half.

Covers:
  1. bridge_paths.py's IPC literals (IPC_DIR_NAME, HEARTBEAT_FILENAME,
     COMMAND_FILENAME, RESPONSE_PREFIX) pinned to their exact expected
     values, AND to their appearance in uefn-bridge/uefn-server.ts (so a
     TS-side rename breaks this test too).
  2. The ImportError-guarded `bridge_paths` fallback in uefn_bridge.py,
     property_inspector.py, uefn_launcher.py, and moderation_scanner.py
     proven byte-identical to bridge_paths.bridge_ipc_dir() — not assumed.
  3. asset_usage._SKIP_PREFIXES as the canonical skip-prefix tuple, and
     every sibling consumer (texture_finder, niagara_inspector,
     dependency_viewer, material_browser, asset_sweep) proven identical to
     it under normal import AND under its own ImportError-guarded fallback.

See test_powertools_dedup_parity.py (same directory) for the Python<->TS
tool-parity, launcher-dispatch-parity, severity-mirror, and
hints-derivation half of this batch's drift-guard coverage.

Reimport-gymnastics note (per task instructions): property_inspector.py,
moderation_scanner.py, and uefn_launcher.py all resolve `bridge_paths` via
a CALL-TIME `import bridge_paths` inside their _get_bridge_dir()/
_bridge_ipc_dir() helper function body (not a module-level import) — so
their fallback branch can be exercised by blocking `bridge_paths` for the
duration of one function call, no fresh reimport of the consumer module
required. uefn_bridge.py is the one exception: it resolves `_bridge_paths`
once at MODULE IMPORT time (`import bridge_paths as _bridge_paths` near the
top of the file), so its fallback requires a full fresh reimport with
`bridge_paths` blocked beforehand — see UefnBridgeModuleLevelFallbackTests.
"""
import contextlib
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import (  # noqa: E402
    REPO_ROOT,
    ensure_bridge_on_path,
    import_uefn_bridge,
    stub_unreal,
)

TS_SERVER_PATH = os.path.join(REPO_ROOT, "uefn-bridge", "uefn-server.ts")


def _read_ts_source():
    if not os.path.isfile(TS_SERVER_PATH):
        raise RuntimeError(f"expected TS MCP server at {TS_SERVER_PATH!r}, not found")
    with open(TS_SERVER_PATH, "r", encoding="utf-8") as f:
        return f.read()


ensure_bridge_on_path()
stub_unreal()
import_uefn_bridge()

import bridge_paths  # noqa: E402
import uefn_bridge  # noqa: E402

TS_SOURCE = _read_ts_source()


def _norm(p):
    return os.path.normcase(os.path.normpath(p))


class _BlockModuleImport:
    """Meta-path finder that fails importing exactly one named module,
    simulating a version-skewed sibling set missing it. Mirrors the
    `_BlockUefnBridgeImport` pattern in test_uefn_launcher_mcp_panel.py."""

    def __init__(self, blocked_name):
        self._blocked = blocked_name

    def find_spec(self, name, path, target=None):
        if name == self._blocked:
            raise ImportError(f"blocked for drift-guard test: {self._blocked}")
        return None


@contextlib.contextmanager
def _module_unimportable(blocked_name):
    """Context manager: makes `import <blocked_name>` raise ImportError for
    the duration of the block. Restores sys.modules/sys.meta_path exactly
    on exit, success or failure."""
    saved_module = sys.modules.pop(blocked_name, None)
    saved_meta_path = list(sys.meta_path)
    sys.meta_path.insert(0, _BlockModuleImport(blocked_name))
    try:
        yield
    finally:
        sys.meta_path[:] = saved_meta_path
        sys.modules.pop(blocked_name, None)
        if saved_module is not None:
            sys.modules[blocked_name] = saved_module


def _fresh_import_with_blocked_dependency(module_name, blocked_name):
    """Pop *module_name* (and *blocked_name*) from sys.modules, block
    *blocked_name* for the duration of a fresh `import <module_name>` (so
    its module-level `try: from <blocked_name> import X / except
    ImportError:` fallback branch actually executes), then restore
    sys.modules/sys.meta_path to their prior state. Returns the freshly
    imported module object (still usable after restoration — Python does
    not unload it, only removes it from the cache)."""
    import importlib

    saved_target = sys.modules.pop(module_name, None)
    with _module_unimportable(blocked_name):
        module = importlib.import_module(module_name)
    sys.modules.pop(module_name, None)
    if saved_target is not None:
        sys.modules[module_name] = saved_target
    return module


# ---------------------------------------------------------------------------
# 1. IPC literal pinning
# ---------------------------------------------------------------------------

class BridgePathsLiteralsTests(unittest.TestCase):
    def test_literals_match_exact_expected_values(self):
        self.assertEqual(bridge_paths.IPC_DIR_NAME, "uefn_bridge")
        self.assertEqual(bridge_paths.HEARTBEAT_FILENAME, "heartbeat.json")
        self.assertEqual(bridge_paths.COMMAND_FILENAME, "command.json")
        self.assertEqual(bridge_paths.RESPONSE_PREFIX, "response_")

    def test_ts_source_contains_each_literal(self):
        self.assertIn('"uefn_bridge"', TS_SOURCE, "TS BRIDGE_DIR default dir name literal not found")
        self.assertIn('"heartbeat.json"', TS_SOURCE, "TS HEARTBEAT_PATH filename literal not found")
        self.assertIn('"command.json"', TS_SOURCE, "TS commandPath filename literal not found")
        self.assertIn(
            "response_${id}.json", TS_SOURCE, "TS response file template literal not found"
        )

    def test_uefn_bridge_sources_the_same_literals_under_normal_import(self):
        # uefn_bridge.py resolves these at module-import time from
        # bridge_paths when available — confirm it actually did, not just
        # that both happen to hold equal literals independently.
        self.assertIs(uefn_bridge._bridge_paths, bridge_paths)
        self.assertEqual(uefn_bridge._HEARTBEAT_FILENAME, bridge_paths.HEARTBEAT_FILENAME)
        self.assertEqual(uefn_bridge._COMMAND_FILENAME, bridge_paths.COMMAND_FILENAME)
        self.assertEqual(uefn_bridge._RESPONSE_PREFIX, bridge_paths.RESPONSE_PREFIX)


# ---------------------------------------------------------------------------
# 2. Fallback consistency — call-time importers (property_inspector,
#    moderation_scanner, uefn_launcher)
# ---------------------------------------------------------------------------

class CallTimeFallbackConsistencyTests(unittest.TestCase):
    def setUp(self):
        ensure_bridge_on_path()
        stub_unreal()
        import property_inspector
        import moderation_scanner
        import uefn_launcher

        self.property_inspector = property_inspector
        self.moderation_scanner = moderation_scanner
        self.uefn_launcher = uefn_launcher

    def test_property_inspector_fallback_matches_bridge_paths(self):
        expected = bridge_paths.bridge_ipc_dir(create=True)
        with _module_unimportable("bridge_paths"):
            actual = self.property_inspector._get_bridge_dir()
        self.assertEqual(_norm(actual), _norm(expected))

    def test_moderation_scanner_fallback_matches_bridge_paths(self):
        expected = bridge_paths.bridge_ipc_dir(create=False)
        with _module_unimportable("bridge_paths"):
            actual = self.moderation_scanner._bridge_ipc_dir()
        self.assertEqual(_norm(actual), _norm(expected))

    def test_uefn_launcher_fallback_matches_bridge_paths(self):
        expected = bridge_paths.bridge_ipc_dir(create=True)
        with _module_unimportable("bridge_paths"):
            actual = self.uefn_launcher._get_bridge_dir()
        self.assertEqual(_norm(actual), _norm(expected))

    def test_env_override_honored_identically_across_all_four(self):
        # UEFN_BRIDGE_DIR override must produce the SAME dir for
        # bridge_paths itself and all three fallback branches.
        custom = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__drift_guard_custom_bridge_dir__")
        saved_env = os.environ.get("UEFN_BRIDGE_DIR")
        os.environ["UEFN_BRIDGE_DIR"] = custom
        try:
            expected = bridge_paths.bridge_ipc_dir(create=False)
            self.assertEqual(_norm(expected), _norm(custom))
            with _module_unimportable("bridge_paths"):
                pi_dir = self.property_inspector._get_bridge_dir()
                ms_dir = self.moderation_scanner._bridge_ipc_dir()
                ul_dir = self.uefn_launcher._get_bridge_dir()
            self.assertEqual(_norm(pi_dir), _norm(custom))
            self.assertEqual(_norm(ms_dir), _norm(custom))
            self.assertEqual(_norm(ul_dir), _norm(custom))
        finally:
            if saved_env is None:
                os.environ.pop("UEFN_BRIDGE_DIR", None)
            else:
                os.environ["UEFN_BRIDGE_DIR"] = saved_env
            if os.path.isdir(custom):
                try:
                    os.rmdir(custom)
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# 2b. Fallback consistency — module-import-time importer (uefn_bridge.py)
# ---------------------------------------------------------------------------

class UefnBridgeModuleLevelFallbackTests(unittest.TestCase):
    """uefn_bridge.py resolves `_bridge_paths` once at module-import time
    (`import bridge_paths as _bridge_paths` near the top of the file), so
    exercising its ImportError branch requires a full fresh reimport with
    bridge_paths blocked — unlike the three call-time importers above."""

    def test_fallback_literals_and_dir_when_bridge_paths_unimportable_at_import_time(self):
        expected_dir = bridge_paths.bridge_ipc_dir(create=True)
        fresh = _fresh_import_with_blocked_dependency("uefn_bridge", "bridge_paths")
        try:
            self.assertIsNone(fresh._bridge_paths)
            self.assertEqual(fresh._HEARTBEAT_FILENAME, "heartbeat.json")
            self.assertEqual(fresh._COMMAND_FILENAME, "command.json")
            self.assertEqual(fresh._RESPONSE_PREFIX, "response_")
            actual_dir = fresh._get_bridge_dir()
            self.assertEqual(_norm(actual_dir), _norm(expected_dir))
        finally:
            # fresh._get_bridge_dir() / start_bridge() (run automatically on
            # import) may have registered a tick callback on the mocked
            # `unreal` — harmless (MagicMock, no real loop), nothing to undo.
            pass


# ---------------------------------------------------------------------------
# 3. _SKIP_PREFIXES canonicalization
# ---------------------------------------------------------------------------

class SkipPrefixCanonicalTests(unittest.TestCase):
    CANONICAL = ("/Engine/", "/Script/", "/Temp/")

    def setUp(self):
        ensure_bridge_on_path()
        stub_unreal()

    def test_asset_usage_canonical_value(self):
        import asset_usage

        self.assertEqual(asset_usage._SKIP_PREFIXES, self.CANONICAL)
        self.assertIn("/Temp/", asset_usage._SKIP_PREFIXES)
        self.assertIn("/Engine/", asset_usage._SKIP_PREFIXES)
        self.assertIn("/Script/", asset_usage._SKIP_PREFIXES)

    def test_consumers_use_the_same_tuple_object_under_normal_import(self):
        import asset_usage
        import texture_finder
        import niagara_inspector
        import dependency_viewer
        import material_browser
        import asset_sweep

        for mod in (texture_finder, niagara_inspector, dependency_viewer, material_browser, asset_sweep):
            with self.subTest(module=mod.__name__):
                self.assertIs(
                    mod._SKIP_PREFIXES,
                    asset_usage._SKIP_PREFIXES,
                    f"{mod.__name__}._SKIP_PREFIXES is not the SAME object as "
                    "asset_usage._SKIP_PREFIXES under normal import — expected "
                    "`from asset_usage import _SKIP_PREFIXES`",
                )

    def test_fallback_matches_canonical_when_asset_usage_fully_unimportable(self):
        # texture_finder / niagara_inspector / dependency_viewer /
        # material_browser have no OTHER unguarded top-level dependency on
        # asset_usage, so asset_usage can be blocked entirely for these four.
        for module_name in ("texture_finder", "niagara_inspector", "dependency_viewer", "material_browser"):
            with self.subTest(module=module_name):
                module = _fresh_import_with_blocked_dependency(module_name, "asset_usage")
                self.assertEqual(module._SKIP_PREFIXES, self.CANONICAL)

    def test_asset_sweep_fallback_matches_canonical_when_skip_prefixes_attr_missing(self):
        # asset_sweep.py ALSO does an unguarded
        # `from asset_usage import confirm_orphans, get_project_prefix` at
        # module top (see its docstring near the guarded _SKIP_PREFIXES
        # import) — fully blocking `asset_usage` would crash that unguarded
        # import before ever reaching the guarded _SKIP_PREFIXES try/except,
        # so this simulates the narrower real case the guard actually
        # protects against: asset_usage.py present but missing/renamed the
        # _SKIP_PREFIXES attribute specifically (confirm_orphans /
        # get_project_prefix still resolve fine).
        fake = types.ModuleType("asset_usage")
        fake.confirm_orphans = lambda *a, **k: {}
        fake.get_project_prefix = lambda *a, **k: "/Game/"
        # deliberately no _SKIP_PREFIXES attribute on `fake`

        saved_asset_sweep = sys.modules.pop("asset_sweep", None)
        saved_asset_usage = sys.modules.pop("asset_usage", None)
        sys.modules["asset_usage"] = fake
        try:
            import asset_sweep

            self.assertEqual(asset_sweep._SKIP_PREFIXES, self.CANONICAL)
        finally:
            sys.modules.pop("asset_sweep", None)
            sys.modules.pop("asset_usage", None)
            if saved_asset_sweep is not None:
                sys.modules["asset_sweep"] = saved_asset_sweep
            if saved_asset_usage is not None:
                sys.modules["asset_usage"] = saved_asset_usage


if __name__ == "__main__":
    unittest.main()
