"""Tests for device_audit._xyz_to_luf — the pure XYZ -> LUF (Left-Up-Forward)
position converter added to make the UEFN bridge's actor coordinates
unambiguous.

Background: a creator reported the same actor reading
(-339924, 5848, -8044) in the UEFN editor's Details panel but
x:-8044, y:339924, z:5848 from uefn_list_devices. That is not a bridge
bug — as of UEFN 36.00 the editor Details panel and /Verse.org module
transforms switched to the LUF coordinate system (Left=-Y, Up=Z,
Forward=X), while /UnrealEngine.com and /Fortnite.com module transforms
still use traditional XYZ. See:
https://dev.epicgames.com/documentation/fortnite/leftupforward-coordinate-system-in-unreal-editor-for-fortnite

This test module only exercises the pure ``_xyz_to_luf(x, y, z)`` helper,
which does no UE API calls itself — but ``device_audit.py`` does an
UNGUARDED ``import unreal`` at module scope, so the ``unreal`` stub must
still be installed before importing it (mirrors ``import_uefn_bridge``'s
approach in ``_bridge_helpers.py``).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
stub_unreal()
from device_audit import _xyz_to_luf  # noqa: E402


class XyzToLufTests(unittest.TestCase):
    def test_creator_reported_regression_sample(self):
        # UE XYZ (x=-8044, y=339924, z=5848) -> Details panel LUF reading
        # (-339924, 5848, -8044), exactly as the creator reported.
        self.assertEqual(_xyz_to_luf(-8044, 339924, 5848), (-339924, 5848, -8044))

    def test_all_zero(self):
        self.assertEqual(_xyz_to_luf(0, 0, 0), (0, 0, 0))

    def test_positive_components(self):
        # Left = -Y, Up = Z, Forward = X
        self.assertEqual(_xyz_to_luf(100, 200, 300), (-200, 300, 100))

    def test_negative_components(self):
        self.assertEqual(_xyz_to_luf(-100, -200, -300), (200, -300, -100))

    def test_mixed_sign_components(self):
        self.assertEqual(_xyz_to_luf(-5, 10, -15), (-10, -15, -5))

    def test_only_y_flips_sign_others_pass_through(self):
        left, up, forward = _xyz_to_luf(7, 42, 9)
        self.assertEqual(left, -42)
        self.assertEqual(up, 9)
        self.assertEqual(forward, 7)

    def test_is_its_own_inverse_under_the_documented_reverse_mapping(self):
        # Epic's reverse mapping (LUF -> XYZ) is X=Forward, Y=-Left, Z=Up.
        # Applying that reverse mapping to _xyz_to_luf's own output must
        # recover the original XYZ triple exactly, proving the two mappings
        # are consistent inverses of each other (not just individually
        # plausible).
        original = (-8044, 339924, 5848)
        left, up, forward = _xyz_to_luf(*original)
        recovered = (forward, -left, up)
        self.assertEqual(recovered, original)

    def test_float_inputs_preserved(self):
        self.assertEqual(_xyz_to_luf(1.5, -2.25, 3.75), (2.25, 3.75, 1.5))


if __name__ == "__main__":
    unittest.main()
