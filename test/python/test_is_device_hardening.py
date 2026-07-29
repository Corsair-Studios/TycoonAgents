"""Tests for device_audit.py's ``_is_device`` hardened class-hierarchy walk
(~lines 178-208), fixed alongside build_mode_cleanup.py's twin of the same
helper.

Field failure this guards against: ``actor.get_class()``,
``current.get_name()``, and ``current.get_super_class()`` can each raise on
certain Blueprint-backed classes in a real UEFN level. Before the fix, a
raise anywhere in the walk propagated out of ``_is_device`` uncaught; a
caller that doesn't independently guard the call (see
test_list_devices_two_phase.py for uefn_bridge.py's own defense-in-depth
wrapper around this same call) would crash outright. After the fix, ANY
raise in get_class/get_name/get_super_class means "couldn't determine" and
``_is_device`` returns False — never lets the exception escape.

These tests call ``device_audit._is_device`` directly with minimal actor/
class doubles that raise at a specific point in the walk, plus a baseline
proving the walk still correctly finds a hint further up the hierarchy when
nothing raises.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
stub_unreal()

import device_audit  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _RaisingGetName:
    """A class double whose get_name() always raises -- models a Blueprint
    class object that can't even report its own name."""

    def get_name(self):
        raise RuntimeError("get_name exploded")

    def get_super_class(self):
        raise AssertionError("get_super_class should never be reached — get_name already raised")


class _RaisingGetClassActor:
    """An actor double whose get_class() itself raises."""

    def get_class(self):
        raise RuntimeError("get_class exploded")


class _FakeClass:
    """Minimal unreal-class double (same shape as the one used in
    test_device_audit_cdo_diff.py): get_name() + get_super_class()."""

    def __init__(self, name, super_class=None, raise_on_super=False):
        self._name = name
        self._super = super_class
        self._raise_on_super = raise_on_super

    def get_name(self):
        return self._name

    def get_super_class(self):
        if self._raise_on_super:
            raise RuntimeError("get_super_class exploded")
        return self._super


class _FakeActor:
    def __init__(self, cls):
        self._cls = cls

    def get_class(self):
        return self._cls


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class IsDeviceHardeningTests(unittest.TestCase):
    def test_get_class_raises_returns_false_not_propagated(self):
        actor = _RaisingGetClassActor()
        self.assertFalse(device_audit._is_device(actor))

    def test_first_get_name_raises_returns_false_not_propagated(self):
        actor = _FakeActor(_RaisingGetName())
        self.assertFalse(device_audit._is_device(actor))

    def test_get_super_class_raises_mid_walk_returns_false_not_propagated(self):
        # Top class has a non-matching name, so the walk must proceed to
        # get_super_class() -- which is the call that raises here.
        cls = _FakeClass("BP_SomeActor", raise_on_super=True)
        actor = _FakeActor(cls)
        self.assertFalse(device_audit._is_device(actor))

    def test_normal_hierarchy_walk_to_parent_containing_device_still_true(self):
        # Baseline: nothing raises, and the hint ("Device") only appears on
        # the PARENT class, two levels up from the actor's own class --
        # proving the walk still climbs the hierarchy correctly and isn't
        # short-circuited by the hardening.
        grandparent = _FakeClass("AFortCreativeDeviceBase")  # contains "Device" hint
        parent = _FakeClass("BP_WidgetDeviceParent", super_class=grandparent)
        leaf = _FakeClass("BP_WidgetDevice_C", super_class=parent)
        actor = _FakeActor(leaf)
        self.assertTrue(device_audit._is_device(actor))

    def test_no_hint_anywhere_and_no_raise_returns_false(self):
        # Sanity baseline in the other direction: a clean, fully-walkable
        # hierarchy with no device hint anywhere returns False, not because
        # of the hardening but because it's genuinely not a device.
        root = _FakeClass("AActor", super_class=None)
        leaf = _FakeClass("BP_PlainActor_C", super_class=root)
        actor = _FakeActor(leaf)
        self.assertFalse(device_audit._is_device(actor))


if __name__ == "__main__":
    unittest.main()
