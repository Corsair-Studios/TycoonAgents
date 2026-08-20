"""Dispatch-level pin for p3-t6: closes the layer-2 gap where Phase 3's
new params (``fields``, ``max_results``, ``offset``, and ``include_location``
on tag_inspect) were added at layer 3 (media/uefn-bridge/batch_tools.py,
tag_inspect.py) but never read or forwarded by layer 2's dispatch handlers
in media/uefn-bridge/uefn_bridge.py (``_handle_batch_get``,
``_handle_batch_location``, ``_handle_tag_inspect``). Every existing Python
test calls the layer-3 functions directly, so the whole suite stayed green
while an MCP caller's params dict-literally could never reach them --
proven live against a 44,753-actor project (see the p3-t6 task description).
This module is the one that would have caught it: it invokes the HANDLERS,
not the module functions, exactly as the real dispatch path
(uefn_bridge.py's command router) does.

Mocking approach: ``_bridge_helpers.import_uefn_bridge()`` stubs `unreal`
and imports uefn_bridge the same way every other dispatch test in this
directory does. ``batch_get_property``/``batch_get_location``/
``inspect_tags`` are bound directly into the uefn_bridge module namespace
via `from batch_tools import ...` / `from tag_inspect import ...`
(uefn_bridge.py ~line 153, ~line 187), so monkeypatching those names ON
THE uefn_bridge MODULE OBJECT intercepts exactly what each handler calls,
without touching unreal or the real (network/editor-dependent) batch_tools/
tag_inspect implementations at all.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_uefn_bridge  # noqa: E402

uefn_bridge = import_uefn_bridge()


class _Recorder:
    """Stand-in for a layer-3 module function: records exactly the
    positional/keyword args it was called with and returns a fixed sentinel
    result, so a test can assert on the call shape without needing any real
    unreal/editor state."""

    def __init__(self, result=None):
        self.calls = []
        self.result = result if result is not None else {"status": "ok"}

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.result


class BatchGetDispatchForwardingTests(unittest.TestCase):
    def setUp(self):
        self._orig = uefn_bridge.batch_get_property
        self.recorder = _Recorder()
        uefn_bridge.batch_get_property = self.recorder

    def tearDown(self):
        uefn_bridge.batch_get_property = self._orig

    def test_new_params_forwarded_when_present(self):
        params = {
            "filter_type": "class",
            "filter_value": "BP_WidgetDevice_C",
            "property_name": "bEnabled",
            "fields": ["label", "value"],
            "max_results": 400,
            "offset": 0,
        }
        uefn_bridge._handle_batch_get(params)
        self.assertEqual(len(self.recorder.calls), 1)
        args, kwargs = self.recorder.calls[0]
        self.assertEqual(args, ("class", "BP_WidgetDevice_C", "bEnabled"))
        self.assertEqual(kwargs, {"fields": ["label", "value"], "max_results": 400, "offset": 0})

    def test_new_params_default_none_when_absent(self):
        params = {
            "filter_type": "class",
            "filter_value": "BP_WidgetDevice_C",
            "property_name": "bEnabled",
        }
        uefn_bridge._handle_batch_get(params)
        args, kwargs = self.recorder.calls[0]
        self.assertEqual(args, ("class", "BP_WidgetDevice_C", "bEnabled"))
        self.assertEqual(kwargs, {"fields": None, "max_results": None, "offset": None})

    def test_old_params_unchanged(self):
        params = {"filter_type": "label", "filter_value": "R4_", "property_name": "Health"}
        uefn_bridge._handle_batch_get(params)
        args, _ = self.recorder.calls[0]
        self.assertEqual(args, ("label", "R4_", "Health"))

    def test_missing_property_name_still_raises(self):
        with self.assertRaises(ValueError):
            uefn_bridge._handle_batch_get({"filter_type": "all_devices", "filter_value": ""})
        self.assertEqual(self.recorder.calls, [])


class BatchLocationDispatchForwardingTests(unittest.TestCase):
    def setUp(self):
        self._orig = uefn_bridge.batch_get_location
        self.recorder = _Recorder()
        uefn_bridge.batch_get_location = self.recorder

    def tearDown(self):
        uefn_bridge.batch_get_location = self._orig

    def test_new_params_forwarded_when_present(self):
        params = {
            "filter_type": "all_devices",
            "filter_value": "",
            "fields": ["label", "location"],
            "max_results": 200,
            "offset": 200,
        }
        uefn_bridge._handle_batch_location(params)
        args, kwargs = self.recorder.calls[0]
        self.assertEqual(args, ("all_devices", ""))
        self.assertEqual(kwargs, {"fields": ["label", "location"], "max_results": 200, "offset": 200})

    def test_new_params_default_none_when_absent(self):
        uefn_bridge._handle_batch_location({"filter_type": "class", "filter_value": "SGMarker"})
        args, kwargs = self.recorder.calls[0]
        self.assertEqual(args, ("class", "SGMarker"))
        self.assertEqual(kwargs, {"fields": None, "max_results": None, "offset": None})

    def test_old_params_unchanged(self):
        uefn_bridge._handle_batch_location({"filter_type": "label", "filter_value": "Spawn"})
        args, _ = self.recorder.calls[0]
        self.assertEqual(args, ("label", "Spawn"))


class TagInspectDispatchForwardingTests(unittest.TestCase):
    def setUp(self):
        self._orig = uefn_bridge.inspect_tags
        self.recorder = _Recorder()
        uefn_bridge.inspect_tags = self.recorder

    def tearDown(self):
        uefn_bridge.inspect_tags = self._orig

    def test_new_params_forwarded_when_present(self):
        params = {
            "label_pattern": "SGMarker*",
            "project_dir": "/some/project",
            "fields": ["label", "tags"],
            "include_location": True,
            "max_results": 400,
            "offset": 0,
        }
        uefn_bridge._handle_tag_inspect(params)
        self.assertEqual(len(self.recorder.calls), 1)
        _, kwargs = self.recorder.calls[0]
        self.assertEqual(
            kwargs,
            {
                "label_pattern": "SGMarker*",
                "project_dir": "/some/project",
                "fields": ["label", "tags"],
                "include_location": True,
                "max_results": 400,
                "offset": 0,
            },
        )

    def test_new_params_default_when_absent(self):
        """include_location must default to False (matching inspect_tags'
        own signature default), not None -- unlike fields/max_results/
        offset, which default to None (feature off)."""
        uefn_bridge._handle_tag_inspect({"label_pattern": None, "project_dir": None})
        _, kwargs = self.recorder.calls[0]
        self.assertEqual(
            kwargs,
            {
                "label_pattern": None,
                "project_dir": None,
                "fields": None,
                "include_location": False,
                "max_results": None,
                "offset": None,
            },
        )

    def test_old_params_unchanged(self):
        uefn_bridge._handle_tag_inspect({"label_pattern": "R4_*", "project_dir": "/proj"})
        _, kwargs = self.recorder.calls[0]
        self.assertEqual(kwargs["label_pattern"], "R4_*")
        self.assertEqual(kwargs["project_dir"], "/proj")

    def test_include_location_explicit_false_forwarded(self):
        uefn_bridge._handle_tag_inspect(
            {"label_pattern": None, "project_dir": None, "include_location": False}
        )
        _, kwargs = self.recorder.calls[0]
        self.assertEqual(kwargs["include_location"], False)


if __name__ == "__main__":
    unittest.main()
