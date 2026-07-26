"""Tests for moderation_scanner._extract_last_jpeg_span and the end-to-end
extract_asset_thumbnails path it feeds — closing the "cannot decode pixels"
vision gap by recovering a .uasset's embedded editor JPEG thumbnail with
stdlib-only byte-span search.

Ported from test_followup.py's TASK 4 and test_review_fixes.py's FINDING 3
(bounded read: hard-ceiling skip + tail-window read).
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner  # noqa: E402

ms = import_moderation_scanner()

FAKE_JPEG_BODY = b"\xff\xd8\xff" + (b"\x00\x01" * 1000) + b"\xff\xd9"  # ~2004 bytes, within [1KB, 2MB]


class ExtractLastJpegSpanTests(unittest.TestCase):
    def test_recovers_trailing_jpeg_past_leading_noise(self):
        noise = os.urandom(500)
        span = ms._extract_last_jpeg_span(noise + FAKE_JPEG_BODY)
        self.assertIsNotNone(span)
        self.assertTrue(span.startswith(b"\xff\xd8\xff"))
        self.assertTrue(span.endswith(b"\xff\xd9"))
        self.assertEqual(span, FAKE_JPEG_BODY)

    def test_rejects_undersized_span(self):
        tiny_jpeg = b"\xff\xd8\xff" + b"\x00" * 10 + b"\xff\xd9"
        self.assertIsNone(ms._extract_last_jpeg_span(os.urandom(500) + tiny_jpeg))

    def test_rejects_oversized_span(self):
        huge_jpeg = b"\xff\xd8\xff" + (b"\x00" * (2 * 1024 * 1024 + 100)) + b"\xff\xd9"
        self.assertIsNone(ms._extract_last_jpeg_span(huge_jpeg))

    def test_no_markers_returns_none(self):
        self.assertIsNone(ms._extract_last_jpeg_span(os.urandom(2000)))

    def test_finds_last_span_not_first(self):
        first_span = b"\xff\xd8\xff" + (b"\x11" * 1200) + b"\xff\xd9"
        second_span = b"\xff\xd8\xff" + (b"\x22" * 1500) + b"\xff\xd9"
        span = ms._extract_last_jpeg_span(first_span + b"junk" + second_span)
        self.assertEqual(span, second_span)


class ExtractAssetThumbnailsEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="jpeg_extract_test_")
        self.project_dir = os.path.join(self.tmpdir, "proj")
        self.content_dir = os.path.join(self.project_dir, "Content", "UI")
        os.makedirs(self.content_dir, exist_ok=True)
        self.out_dir = os.path.join(self.tmpdir, "thumbs_out")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_uasset(self, name, body):
        path = os.path.join(self.content_dir, name)
        with open(path, "wb") as f:
            f.write(body)
        return path

    def test_extracts_real_thumbnail_from_synthetic_uasset(self):
        self._write_uasset("qr_asset.uasset", b"UASSETHEADERJUNK" + os.urandom(200) + FAKE_JPEG_BODY)
        suspects = [{"object_path": "/MyIsland/UI/qr_asset.qr_asset",
                      "package_name": "/MyIsland/UI/qr_asset", "display_name": "qr_asset"}]
        extraction = ms.extract_asset_thumbnails(
            suspects, self.out_dir, max_thumbnails=40,
            project_dir=self.project_dir, mount_prefix="/MyIsland/",
        )
        self.assertEqual(extraction["extracted"], 1)
        self.assertEqual(len(extraction["written_paths"]), 1)
        self.assertTrue(os.path.isfile(extraction["written_paths"][0]))
        with open(extraction["written_paths"][0], "rb") as f:
            self.assertEqual(f.read(), FAKE_JPEG_BODY)

    def test_hard_item_cap_respected(self):
        self._write_uasset("qr_asset.uasset", b"HEADER" + os.urandom(200) + FAKE_JPEG_BODY)
        suspect = {"object_path": "/MyIsland/UI/qr_asset.qr_asset",
                   "package_name": "/MyIsland/UI/qr_asset", "display_name": "qr_asset"}
        many_suspects = [suspect] * 45
        extraction = ms.extract_asset_thumbnails(
            many_suspects, self.out_dir, max_thumbnails=40,
            project_dir=self.project_dir, mount_prefix="/MyIsland/",
        )
        self.assertEqual(extraction["attempted"], 40)
        self.assertEqual(extraction["suspects_not_extracted"], 5)

    def test_oversized_file_skipped_entirely_no_read_attempted(self):
        ceiling = ms._THUMBNAIL_SOURCE_MAX_FILE_BYTES
        path = self._write_uasset("huge_asset.uasset", b"")
        with open(path, "wb") as f:
            f.seek(ceiling + 1024)
            f.write(b"\x00")
        self.assertGreater(os.path.getsize(path), ceiling)

        suspects = [{"object_path": "/MyIsland/UI/huge_asset.huge_asset",
                      "package_name": "/MyIsland/UI/huge_asset", "display_name": "huge_asset"}]
        res = ms.extract_asset_thumbnails(
            suspects, self.out_dir, max_thumbnails=40,
            project_dir=self.project_dir, mount_prefix="/MyIsland/",
        )
        self.assertEqual(res["skipped_too_large"], 1)
        self.assertEqual(res["extracted"], 0)

    def test_thumbnail_beyond_tail_window_but_under_ceiling_still_recovered(self):
        tail_window = ms._THUMBNAIL_TAIL_WINDOW_BYTES
        ceiling = ms._THUMBNAIL_SOURCE_MAX_FILE_BYTES
        path = self._write_uasset("big_ok_asset.uasset", b"")
        with open(path, "wb") as f:
            f.write(os.urandom(tail_window * 2))  # 2x the tail window of noise
            f.write(FAKE_JPEG_BODY)
        total_size = os.path.getsize(path)
        self.assertTrue(tail_window < total_size < ceiling)

        suspects = [{"object_path": "/MyIsland/UI/big_ok_asset.big_ok_asset",
                      "package_name": "/MyIsland/UI/big_ok_asset", "display_name": "big_ok_asset"}]
        res = ms.extract_asset_thumbnails(
            suspects, self.out_dir, max_thumbnails=40,
            project_dir=self.project_dir, mount_prefix="/MyIsland/",
        )
        self.assertEqual(res["extracted"], 1)
        self.assertEqual(res["skipped_too_large"], 0)
        with open(res["written_paths"][0], "rb") as f:
            self.assertEqual(f.read(), FAKE_JPEG_BODY)


if __name__ == "__main__":
    unittest.main()
