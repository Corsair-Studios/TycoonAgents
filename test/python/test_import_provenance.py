"""Tests for moderation_scanner._classify_import_source_path — Rule 1.7/1.12's
strongest predictor: an asset's recorded AssetImportData source path.

Ported from test_followup.py's TASK 1.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner  # noqa: E402

ms = import_moderation_scanner()


class ClassifyImportSourcePathTests(unittest.TestCase):
    def test_downloads_folder_classifies_external_user_dir(self):
        result = ms._classify_import_source_path(
            "../../../../../../Users/someuser/Downloads/qr_asset.png", project_dir=r"D:\MyIsland",
        )
        self.assertEqual(result, "external_user_dir")

    def test_desktop_folder_classifies_external_user_dir(self):
        result = ms._classify_import_source_path(
            "C:/Users/someuser/Desktop/thing.png", project_dir=r"D:\MyIsland",
        )
        self.assertEqual(result, "external_user_dir")

    def test_in_project_relative_path_classifies_in_project(self):
        result = ms._classify_import_source_path(
            "../Content/SourceArt/SM_Rock_01.fbx", project_dir=r"D:\MyIsland",
        )
        self.assertEqual(result, "in_project")

    def test_deep_relative_climb_classifies_outside_project(self):
        result = ms._classify_import_source_path(
            "../../../../SomewhereElse/asset.fbx", project_dir=r"D:\MyIsland",
        )
        self.assertEqual(result, "outside_project")

    def test_absolute_path_inside_project_dir_classifies_in_project(self):
        result = ms._classify_import_source_path(
            r"D:\MyIsland\Content\Art\thing.fbx", project_dir=r"D:\MyIsland",
        )
        self.assertEqual(result, "in_project")

    def test_absolute_path_outside_project_dir_classifies_outside_project(self):
        result = ms._classify_import_source_path(
            r"C:\SomewhereElse\thing.fbx", project_dir=r"D:\MyIsland",
        )
        self.assertEqual(result, "outside_project")

    def test_missing_source_path_classifies_unknown(self):
        self.assertEqual(ms._classify_import_source_path("", project_dir=r"D:\MyIsland"), "unknown")
        self.assertEqual(ms._classify_import_source_path(None, project_dir=r"D:\MyIsland"), "unknown")


class CollectImportProvenanceTests(unittest.TestCase):
    def test_end_to_end_classification_and_filtering(self):
        records = [
            {
                "object_path": "/MyIsland/UI/ScoreBoard/qr_asset.qr_asset",
                "display_name": "qr_asset",
                "package_name": "/MyIsland/UI/ScoreBoard/qr_asset",
                "source_path": "../../../../../../Users/someuser/Downloads/qr_asset.png",
                "file_md5": "967c99aa66a8e2a0216426f77a7cdd09",
                "timestamp": "1784734051",
            },
            {
                "object_path": "/MyIsland/Meshes/SM_Rock_01.SM_Rock_01",
                "display_name": "SM_Rock_01",
                "package_name": "/MyIsland/Meshes/SM_Rock_01",
                "source_path": "../Content/SourceArt/SM_Rock_01.fbx",
                "file_md5": "abc123",
                "timestamp": "111",
            },
        ]
        prov = ms.collect_import_provenance(records, project_dir=r"D:\MyIsland")
        self.assertEqual(prov["by_classification"].get("external_user_dir"), 1)
        self.assertEqual(prov["by_classification"].get("in_project"), 1)
        # Only external_user_dir/outside_project hits are surfaced in items
        # (see run_moderation_scan's docstring: "already filtered down to
        # just external_user_dir/outside_project hits").
        self.assertEqual(len(prov["items"]), 1)
        self.assertEqual(prov["items"][0]["classification"], "external_user_dir")


if __name__ == "__main__":
    unittest.main()
