"""Tests for the debounced graph-canvas resize redraw in dependency_viewer.py
(_on_canvas_resize / _do_debounced_redraw, nested inside
show_dependency_viewer around dependency_viewer.py:1766-1802).

WHY this exists: dependency_viewer's graph canvas previously redrew on
EVERY <Configure> event with no debounce and no size-delta check — a
classic Tk resize storm during a drag-resize. This window does not run
mainloop(); it is pumped by root.update() inside a
register_slate_post_tick_callback callback UEFN invokes on its MAIN
THREAD (dependency_viewer.py:1965-1988), the same pattern documented at
dependency_viewer.py:50-59 as having previously escalated a Tk misstep
into aborting the whole host process (commit 947f34b, 0.0.452). A user
reported UEFN crashing while resizing a Power Tools panel; this is the
most plausible, least-guarded path, not a confirmed root cause — these
tests verify the MITIGATION (debounce + no-op filtering + safe late
firing + cleanup cancellation), not that they fix that specific crash.

Uses `_bridge_helpers.extract_nested_function` to pull the REAL, compiled
`_on_canvas_resize` / `_do_debounced_redraw` / `_cleanup` closures out of
`show_dependency_viewer`'s code object and drive them directly against
fake closure cells — never a hand-copied reimplementation that could
silently drift from the source.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock, call

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal, extract_nested_function  # noqa: E402

ensure_bridge_on_path()
stub_unreal()
import dependency_viewer as dv  # noqa: E402
import tkinter as tk  # noqa: E402


def _make_canvas(width=800, height=500, exists=True):
    """A MagicMock standing in for graph_canvas, wired with the handful of
    Tk methods the resize-debounce closures actually call."""
    canvas = MagicMock(name="graph_canvas")
    canvas.winfo_width.return_value = width
    canvas.winfo_height.return_value = height
    canvas.winfo_exists.return_value = exists
    canvas.after.return_value = "after#1"
    return canvas


class OnCanvasResizeTests(unittest.TestCase):
    """_on_canvas_resize: schedules a debounced redraw, but only on an
    actual size change, and cancels any previously scheduled one first."""

    def _closure(self, canvas, current_graph_path, last_drawn_size, resize_after_id,
                 do_debounced_redraw=None):
        return extract_nested_function(
            dv.show_dependency_viewer, "_on_canvas_resize",
            extra_closure={
                "graph_canvas": canvas,
                "_current_graph_path": current_graph_path,
                "_last_drawn_size": last_drawn_size,
                "_resize_after_id": resize_after_id,
                "_do_debounced_redraw": do_debounced_redraw or MagicMock(),
            },
        )

    def test_no_graph_loaded_does_nothing(self):
        canvas = _make_canvas()
        fn = self._closure(canvas, [None], [None, None], [None])
        fn(MagicMock())
        canvas.after.assert_not_called()

    def test_same_size_event_schedules_no_redraw(self):
        canvas = _make_canvas(width=800, height=500)
        fn = self._closure(canvas, ["/Game/Foo"], [800, 500], [None])
        fn(MagicMock())
        canvas.after.assert_not_called()

    def test_repeated_same_size_events_schedule_nothing(self):
        canvas = _make_canvas(width=800, height=500)
        fn = self._closure(canvas, ["/Game/Foo"], [800, 500], [None])
        for _ in range(20):
            fn(MagicMock())
        canvas.after.assert_not_called()

    def test_size_change_schedules_exactly_one_redraw(self):
        canvas = _make_canvas(width=810, height=500)
        resize_after_id = [None]
        fn = self._closure(canvas, ["/Game/Foo"], [800, 500], resize_after_id)
        fn(MagicMock())
        canvas.after.assert_called_once()
        args, _kwargs = canvas.after.call_args
        self.assertEqual(args[0], 120)  # debounce delay in ms
        self.assertEqual(resize_after_id[0], "after#1")

    def test_burst_of_differing_sizes_cancels_prior_and_schedules_once_per_call(self):
        """A rapid burst of DIFFERING sizes (a real drag) must cancel the
        previously scheduled callback each time rather than stacking up
        redraws — asserting after_cancel is used is the signal a debounce
        is actually happening, not just a naive re-schedule."""
        canvas = _make_canvas(width=800, height=500)
        resize_after_id = [None]
        fn = self._closure(canvas, ["/Game/Foo"], [700, 400], resize_after_id)

        sizes = [(750, 420), (780, 450), (800, 480), (820, 500)]
        for i, (w, h) in enumerate(sizes):
            canvas.winfo_width.return_value = w
            canvas.winfo_height.return_value = h
            canvas.after.return_value = f"after#{i}"
            fn(MagicMock())

        self.assertEqual(canvas.after.call_count, len(sizes))
        # after_cancel called once per event after the first (prior pending id cancelled).
        self.assertEqual(canvas.after_cancel.call_count, len(sizes) - 1)
        self.assertEqual(resize_after_id[0], f"after#{len(sizes) - 1}")

    def test_after_cancel_raising_tclerror_is_swallowed(self):
        """Cancelling an already-fired after() id raises tk.TclError in
        real Tk — must not propagate."""
        canvas = _make_canvas(width=800, height=500)
        canvas.after_cancel.side_effect = tk.TclError("invalid command name")
        resize_after_id = ["stale-id"]
        fn = self._closure(canvas, ["/Game/Foo"], [700, 400], resize_after_id)
        fn(MagicMock())  # must not raise
        canvas.after.assert_called_once()


class DoDebouncedRedrawTests(unittest.TestCase):
    def _closure(self, canvas, current_graph_path, last_drawn_size, resize_after_id, draw_graph):
        return extract_nested_function(
            dv.show_dependency_viewer, "_do_debounced_redraw",
            extra_closure={
                "graph_canvas": canvas,
                "_current_graph_path": current_graph_path,
                "_last_drawn_size": last_drawn_size,
                "_resize_after_id": resize_after_id,
                "_draw_graph": draw_graph,
            },
        )

    def test_fires_redraw_and_updates_last_drawn_size(self):
        canvas = _make_canvas(width=900, height=600, exists=True)
        draw_graph = MagicMock()
        resize_after_id = ["pending"]
        last_drawn_size = [800, 500]
        fn = self._closure(canvas, ["/Game/Foo"], last_drawn_size, resize_after_id, draw_graph)

        fn()

        draw_graph.assert_called_once_with("/Game/Foo")
        self.assertEqual(last_drawn_size, [900, 600])
        self.assertIsNone(resize_after_id[0])

    def test_destroyed_widget_does_not_raise_and_skips_redraw(self):
        """By the time the debounce elapses the window may already be
        closed — winfo_exists() False must short-circuit safely, matching
        the tick pump's own guard idiom (dependency_viewer.py:1972-1980)."""
        canvas = _make_canvas(exists=False)
        draw_graph = MagicMock()
        fn = self._closure(canvas, ["/Game/Foo"], [1, 1], ["pending"], draw_graph)

        fn()  # must not raise

        draw_graph.assert_not_called()

    def test_tclerror_during_late_redraw_is_swallowed(self):
        """Widget reports it exists but has actually been torn down mid-
        teardown race — winfo_width() raising TclError must not propagate."""
        canvas = _make_canvas(exists=True)
        canvas.winfo_width.side_effect = tk.TclError("invalid command name")
        draw_graph = MagicMock()
        fn = self._closure(canvas, ["/Game/Foo"], [1, 1], ["pending"], draw_graph)

        fn()  # must not raise

        draw_graph.assert_not_called()


class CleanupCancelsPendingResizeTests(unittest.TestCase):
    """_cleanup (dependency_viewer.py ~2030-2044) must cancel any pending
    debounced redraw so a scheduled callback cannot fire against a
    destroyed canvas after the window closes.

    _cleanup's only closure freevars are graph_canvas/_resize_after_id;
    _tick_handle is the MODULE-level mutable cell (dependency_viewer.py:109)
    it reads via __globals__, so it's patched on the module directly rather
    than injected as a closure cell, and restored after each test to avoid
    leaking state into other test modules that import dv."""

    def _cleanup(self, canvas, resize_after_id):
        return extract_nested_function(
            dv.show_dependency_viewer, "_cleanup",
            extra_closure={
                "graph_canvas": canvas,
                "_resize_after_id": resize_after_id,
            },
        )

    def setUp(self):
        self._orig_tick_handle = dv._tick_handle
        dv._tick_handle = [None]

    def tearDown(self):
        dv._tick_handle = self._orig_tick_handle

    def test_pending_redraw_is_cancelled(self):
        canvas = _make_canvas()
        resize_after_id = ["after#7"]
        cleanup = self._cleanup(canvas, resize_after_id)

        cleanup()

        canvas.after_cancel.assert_called_once_with("after#7")
        self.assertIsNone(resize_after_id[0])

    def test_no_pending_redraw_does_not_call_after_cancel(self):
        canvas = _make_canvas()
        resize_after_id = [None]
        cleanup = self._cleanup(canvas, resize_after_id)

        cleanup()

        canvas.after_cancel.assert_not_called()

    def test_after_cancel_exception_during_cleanup_is_swallowed(self):
        canvas = _make_canvas()
        canvas.after_cancel.side_effect = tk.TclError("invalid command name")
        resize_after_id = ["after#stale"]
        cleanup = self._cleanup(canvas, resize_after_id)

        cleanup()  # must not raise

        self.assertIsNone(resize_after_id[0])


if __name__ == "__main__":
    unittest.main()
