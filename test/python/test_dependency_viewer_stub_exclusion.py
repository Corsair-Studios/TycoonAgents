"""Tests for dependency_viewer's OFPA per-actor/per-object stub exclusion —
the fix for the PRIMARY (project_only=True) enumeration exhausting
_MAX_ENUMERATED_ASSETS on One-File-Per-Actor level-placement stubs instead
of reaching a project's real assets.

Measured on a real project (2026-08-20): the scan reported "Showing 24996
of 25000 assets ... TRUNCATED: hit the 25000-asset scan cap" while actual
authored content was only ~1,420 assets — the cap was exhausted by 46,372
__ExternalActors__ + 453 __ExternalObjects__ stub packages (each one
placed-actor instance: ActorGuid/ActorLabel/AttachParent/
bCanEverAffectNavigation plus a reference to the asset it instantiates).

Covers:
  1. _is_per_actor_stub_package() — segment-precision matching: a mid-path
     "/__ExternalActors__/" or "/__ExternalObjects__/" segment excludes;
     a normal project asset does not; a name that merely CONTAINS the
     substring (e.g. "/Game/MyExternalActorsHelper") does NOT exclude,
     because split("/") never produces an "__ExternalActors__" segment
     for it — the regression this file guards against.
  2. _MAX_ENUMERATED_ASSETS is unchanged (still 25000) — the cap stays a
     backstop, not something this fix touches.
  3. scan_dependencies()'s PRIMARY (project_only=True) enumeration loop
     excludes stub packages before they can count against the cap, and
     reports how many it excluded via the "excluded_stub_count" result key
     (never silently — see dependency_viewer.py's excluded_stub_count
     threading through both status lines).
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
stub_unreal()
import dependency_viewer as dv  # noqa: E402


class PerActorStubSegmentMatchingTests(unittest.TestCase):
    """_is_per_actor_stub_package must match __ExternalActors__ /
    __ExternalObjects__ as whole PATH SEGMENTS (split on "/"), never a bare
    substring — these appear MID-path, not as a prefix."""

    def test_mid_path_external_actors_segment_excluded(self):
        pkg = "/StarWars/__ExternalActors__/StarWars/0/03/5WJTPVUXBR8YCFNNZ1DOE0"
        self.assertTrue(dv._is_per_actor_stub_package(pkg))

    def test_mid_path_external_objects_segment_excluded(self):
        pkg = "/StarWars/__ExternalObjects__/StarWars/0/12/ABCDEF1234567890"
        self.assertTrue(dv._is_per_actor_stub_package(pkg))

    def test_normal_project_asset_not_excluded(self):
        pkg = "/StarWars/Blueprints/BP_Blockout_Wall"
        self.assertFalse(dv._is_per_actor_stub_package(pkg))

    def test_substring_only_name_not_excluded_segment_precision_regression(self):
        # Must NOT exclude — "__ExternalActors__" appears only as a
        # substring of the asset NAME, not as its own "/"-delimited
        # segment. A naive `"__ExternalActors__" in pkg` check would wrongly
        # exclude this; split()-based segment matching must not.
        pkg = "/Game/MyExternalActorsHelper"
        self.assertFalse(dv._is_per_actor_stub_package(pkg))

    def test_substring_only_name_variant_external_objects_not_excluded(self):
        pkg = "/Game/Systems/ExternalObjectsManager"
        self.assertFalse(dv._is_per_actor_stub_package(pkg))

    def test_stub_segment_at_start_of_path_also_excluded(self):
        # Segment matching must work regardless of position — not only mid-
        # path. split("/") on a leading segment still yields the exact name.
        pkg = "/__ExternalActors__/Foo/Bar"
        self.assertTrue(dv._is_per_actor_stub_package(pkg))


class CapUnchangedTests(unittest.TestCase):
    def test_max_enumerated_assets_still_25000(self):
        self.assertEqual(dv._MAX_ENUMERATED_ASSETS, 25000)


class ScanDependenciesExclusionIntegrationTests(unittest.TestCase):
    """Exercises the PRIMARY (project_only=True) enumeration loop against a
    fake AssetRegistry so stub exclusion and the excluded_stub_count report
    are proven end-to-end, not just at the helper-function level."""

    def _make_fake_asset(self, pkg, name, cls_path="/Script/Engine.Blueprint"):
        fake = MagicMock()
        fake.package_name = pkg
        fake.asset_name = name
        fake.asset_class_path = cls_path
        return fake

    def _run_scan_with_assets(self, assets, project_prefix="/StarWars"):
        fake_registry = MagicMock()
        fake_registry.get_assets_by_path.return_value = assets
        # Phase 2 (dependency graph) and orphan-confirmation iterate these —
        # keep them concretely empty so a MagicMock's default (non-iterable)
        # auto-attribute never blows up the `for dep in deps` / `for r in
        # refs` loops. Not this test's concern (exclusion happens in Phase 1).
        fake_registry.get_dependencies.return_value = []
        fake_registry.get_referencers.return_value = []

        fake_helpers = MagicMock()
        fake_helpers.get_asset_registry.return_value = fake_registry

        orig_helpers = dv.unreal.AssetRegistryHelpers
        orig_detect = dv._detect_project_scope
        dv.unreal.AssetRegistryHelpers = fake_helpers
        dv._detect_project_scope = lambda: (project_prefix, True, None)
        try:
            return dv.scan_dependencies(project_only=True)
        finally:
            dv.unreal.AssetRegistryHelpers = orig_helpers
            dv._detect_project_scope = orig_detect

    def test_stubs_excluded_from_result_and_counted(self):
        real_assets = [
            self._make_fake_asset(f"/StarWars/Blueprints/BP_Thing_{i}", f"BP_Thing_{i}")
            for i in range(5)
        ]
        stub_assets = [
            self._make_fake_asset(
                f"/StarWars/__ExternalActors__/StarWars/0/{i:02d}/STUB{i}", f"STUB{i}"
            )
            for i in range(50)
        ]
        result = self._run_scan_with_assets(real_assets + stub_assets)

        self.assertFalse(result["scan_failed"])
        self.assertEqual(result["total_assets"], 5)
        self.assertEqual(result["excluded_stub_count"], 50)
        scanned_paths = {a["path"] for a in result["assets"]}
        self.assertTrue(all("__ExternalActors__" not in p for p in scanned_paths))

    def test_zero_excluded_when_no_stubs_present(self):
        real_assets = [
            self._make_fake_asset(f"/StarWars/Meshes/SM_Thing_{i}", f"SM_Thing_{i}")
            for i in range(3)
        ]
        result = self._run_scan_with_assets(real_assets)
        self.assertEqual(result["excluded_stub_count"], 0)

    def test_scan_failed_result_carries_zero_excluded_stub_count(self):
        orig_detect = dv._detect_project_scope
        dv._detect_project_scope = lambda: (None, False, "no confident prefix")
        try:
            result = dv.scan_dependencies(project_only=True)
        finally:
            dv._detect_project_scope = orig_detect
        self.assertTrue(result["scan_failed"])
        self.assertEqual(result["excluded_stub_count"], 0)


if __name__ == "__main__":
    unittest.main()
