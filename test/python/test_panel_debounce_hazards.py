"""Tests for the tooltip-churn and per-keystroke-rebuild fixes in
health_scanner.py, material_browser.py, and niagara_inspector.py.

WHY this exists: 4e676ed fixed a CONFIRMED UEFN crash caused by
dependency_viewer.py's <Configure> handler doing a full canvas rebuild on
EVERY event with no debounce (dependency_viewer.py:1749-1802). None of
these Power Tools windows run mainloop() — all are pumped by root.update()
inside a register_slate_post_tick_callback callback UEFN invokes on its
MAIN THREAD, so heavy/misbehaving Tk work executed from an event handler
runs synchronously mid-frame inside a callback the host process cannot
defer or skip.

An audit of the other panels found the same event-storm shape in two
places, at higher event frequency than the confirmed crash:

  1. health_scanner.py's tooltip (_show_tooltip, bound to <Motion> which
     fires on every mouse pixel) unconditionally destroyed and recreated a
     tk.Toplevel + tk.Label on every event, even when hovering the exact
     same cell. Fixed with (a) idempotence — skip destroy/recreate when
     the target text is unchanged, just reposition — and (b) a debounced
     appearance via after().

  2. health_scanner.py, material_browser.py, and niagara_inspector.py each
     bind <KeyRelease> on a filter Entry to a handler that deletes every
     tree row and re-inserts on EVERY keystroke, uncapped. Fixed by
     debouncing the rebuild via after() so a burst of keystrokes collapses
     into one rebuild after the user pauses.

Uses `_bridge_helpers.extract_nested_function` to pull the REAL, compiled
closures out of each module's code object and drive them directly against
fake closure cells / MagicMock widgets — never a hand-copied
reimplementation that could silently drift from the source. For
material_browser.py, the filter closures live inside `build_material_view`
(the embeddable half), not `show_material_browser` — extraction targets
the actual enclosing function per module layout.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal, extract_nested_function  # noqa: E402

ensure_bridge_on_path()
stub_unreal()
import health_scanner as hs  # noqa: E402
import material_browser as mb  # noqa: E402
import niagara_inspector as ni  # noqa: E402
import tkinter as tk  # noqa: E402


def _make_widget(exists=True, after_return="after#1"):
    w = MagicMock()
    w.winfo_exists.return_value = exists
    w.after.return_value = after_return
    return w


# ---------------------------------------------------------------------------
# health_scanner.py — tooltip idempotence + debounce (_show_tooltip /
# _do_debounced_show / _hide_tooltip, nested inside show_health_scanner
# around health_scanner.py:1264-1370)
# ---------------------------------------------------------------------------

class ShowTooltipTests(unittest.TestCase):
    def _make_event(self, x=10, y=10, x_root=100, y_root=100):
        ev = MagicMock()
        ev.x, ev.y, ev.x_root, ev.y_root = x, y, x_root, y_root
        return ev

    def _closure(self, tree, root, tip_win, tip_text_shown, tip_after_id,
                 tip_pending_args, do_debounced_show=None, hide_tooltip=None):
        return extract_nested_function(
            hs.show_health_scanner, "_show_tooltip",
            extra_closure={
                "tree": tree,
                "root": root,
                "_CATEGORY_TIPS": {
                    "Zero-byte": "File has 0 bytes — likely corrupted or failed to save.",
                    "Large File": "File exceeds 50 MB — may impact load times and memory.",
                },
                "_tip_win": tip_win,
                "_tip_text_shown": tip_text_shown,
                "_tip_after_id": tip_after_id,
                "_tip_pending_args": tip_pending_args,
                "_do_debounced_show": do_debounced_show or MagicMock(),
                "_hide_tooltip": hide_tooltip or MagicMock(),
            },
        )

    def _tree_for_row(self, category="Zero-byte", col="#2"):
        tree = MagicMock()
        tree.identify_row.return_value = "row1"
        tree.identify_column.return_value = col
        tree.item.return_value = ("values",)
        tree.item.return_value = ("Error", category, "name", "detail", "1 KB", "/path/x.uasset")
        tree.after.return_value = "tipafter#1"
        return tree

    def test_repeated_motion_over_same_row_schedules_debounce_once_then_reposition(self):
        """First Motion schedules a debounced show; once the tip is showing,
        further Motion events over the SAME text must reposition the
        existing Toplevel instead of destroying/recreating or rescheduling."""
        tree = self._tree_for_row()
        root = MagicMock()
        tip_win = [None]
        tip_text_shown = [None]
        tip_after_id = [None]
        tip_pending_args = [None]
        fn = self._closure(tree, root, tip_win, tip_text_shown, tip_after_id, tip_pending_args)

        fn(self._make_event())
        self.assertEqual(tree.after.call_count, 1)
        self.assertEqual(tip_after_id[0], "tipafter#1")

        # Simulate the debounced show having fired: a real Toplevel now
        # "shown" with matching text.
        shown_win = _make_widget(exists=True)
        tip_win[0] = shown_win
        tip_text_shown[0] = "File has 0 bytes — likely corrupted or failed to save."
        tip_after_id[0] = None

        for _ in range(30):
            fn(self._make_event(x_root=101, y_root=101))

        # No new after() scheduled, no destroy — only reposition.
        self.assertEqual(tree.after.call_count, 1)
        shown_win.destroy.assert_not_called()
        self.assertGreaterEqual(shown_win.wm_geometry.call_count, 1)

    def test_burst_of_motion_before_show_cancels_prior_pending_and_schedules_once_per_call(self):
        """Rapid Motion events landing on DIFFERENT rows before the debounce
        elapses (tip not shown yet, or text keeps changing) must cancel the
        previously scheduled after() id each time — proof the debounce is
        real, matching dependency_viewer's precedent."""
        tree = self._tree_for_row(category="Zero-byte")
        root = MagicMock()
        tip_win = [None]
        tip_text_shown = [None]
        tip_after_id = [None]
        tip_pending_args = [None]
        fn = self._closure(tree, root, tip_win, tip_text_shown, tip_after_id, tip_pending_args)

        tips = ["Zero-byte", "Large File", "Zero-byte", "Large File"]
        for i, cat in enumerate(tips):
            tree.item.return_value = ("Error", cat, "n", "d", "1 KB", "/x")
            tree.after.return_value = f"tipafter#{i}"
            fn(self._make_event())

        self.assertEqual(tree.after.call_count, len(tips))
        self.assertEqual(tree.after_cancel.call_count, len(tips) - 1)

    def test_no_row_hides_tooltip(self):
        tree = MagicMock()
        tree.identify_row.return_value = ""
        root = MagicMock()
        tip_win, tip_text_shown, tip_after_id, tip_pending_args = [None], [None], [None], [None]
        hide = MagicMock()
        fn = self._closure(tree, root, tip_win, tip_text_shown, tip_after_id, tip_pending_args,
                            hide_tooltip=hide)
        fn(self._make_event())
        hide.assert_called_once()
        tree.after.assert_not_called()


class DoDebouncedShowTests(unittest.TestCase):
    """These drive the branch that actually constructs a real tk.Toplevel,
    so `root`/`tree` must be REAL Tk widgets, not MagicMocks — Tkinter's
    C-level widget constructors hang indefinitely when handed a mock
    master (confirmed: tk.Toplevel(MagicMock()) blocks forever, never
    raises). A hidden real Tk() root is the correct stand-in here; the
    surrounding scheduling logic (Fix 2's debounce, and the pure branches
    of this function that never reach the constructor) is covered with
    MagicMocks elsewhere in this file exactly like dependency_viewer's
    existing tests do."""

    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()

    def tearDown(self):
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def _closure(self, tree, root, tip_win, tip_text_shown, tip_after_id, tip_pending_args):
        return extract_nested_function(
            hs.show_health_scanner, "_do_debounced_show",
            extra_closure={
                "tree": tree,
                "root": root,
                "_tip_win": tip_win,
                "_tip_text_shown": tip_text_shown,
                "_tip_after_id": tip_after_id,
                "_tip_pending_args": tip_pending_args,
            },
        )

    def test_creates_toplevel_and_records_shown_text(self):
        tip_win, tip_text_shown = [None], [None]
        tip_after_id = ["pending"]
        tip_pending_args = [(100, 100, "hello")]
        fn = self._closure(self.root, self.root, tip_win, tip_text_shown, tip_after_id, tip_pending_args)

        fn()

        self.assertIsNone(tip_after_id[0])
        self.assertEqual(tip_text_shown[0], "hello")
        self.assertIsNotNone(tip_win[0])
        self.assertTrue(tip_win[0].winfo_exists())

    def test_no_pending_args_does_nothing(self):
        tip_win, tip_text_shown = [None], [None]
        tip_after_id = [None]
        tip_pending_args = [None]
        fn = self._closure(self.root, self.root, tip_win, tip_text_shown, tip_after_id, tip_pending_args)
        fn()  # must not raise
        self.assertIsNone(tip_win[0])

    def test_destroyed_tree_does_not_raise(self):
        tree = _make_widget(exists=False)
        tip_win, tip_text_shown = [None], [None]
        tip_after_id = ["pending"]
        tip_pending_args = [(1, 1, "x")]
        fn = self._closure(tree, self.root, tip_win, tip_text_shown, tip_after_id, tip_pending_args)
        fn()  # must not raise
        self.assertIsNone(tip_win[0])

    def test_tclerror_on_winfo_exists_swallowed(self):
        tree = MagicMock()
        tree.winfo_exists.side_effect = tk.TclError("gone")
        tip_win, tip_text_shown = [None], [None]
        tip_after_id = ["pending"]
        tip_pending_args = [(1, 1, "x")]
        fn = self._closure(tree, self.root, tip_win, tip_text_shown, tip_after_id, tip_pending_args)
        fn()  # must not raise


class HideTooltipTests(unittest.TestCase):
    def _closure(self, tree, tip_win, tip_text_shown, tip_after_id, tip_pending_args):
        return extract_nested_function(
            hs.show_health_scanner, "_hide_tooltip",
            extra_closure={
                "tree": tree,
                "_tip_win": tip_win,
                "_tip_text_shown": tip_text_shown,
                "_tip_after_id": tip_after_id,
                "_tip_pending_args": tip_pending_args,
            },
        )

    def test_cancels_pending_and_destroys_shown_window(self):
        tree = _make_widget()
        tip_win = [_make_widget()]
        tip_text_shown = ["hello"]
        tip_after_id = ["pending#1"]
        tip_pending_args = [(1, 1, "hello")]
        fn = self._closure(tree, tip_win, tip_text_shown, tip_after_id, tip_pending_args)

        fn()

        tree.after_cancel.assert_called_once_with("pending#1")
        self.assertIsNone(tip_after_id[0])
        self.assertIsNone(tip_text_shown[0])
        self.assertIsNone(tip_pending_args[0])
        self.assertIsNone(tip_win[0])

    def test_late_hide_against_destroyed_window_does_not_raise(self):
        tree = _make_widget()
        bad_win = MagicMock()
        bad_win.destroy.side_effect = tk.TclError("gone")
        tip_win = [bad_win]
        fn = self._closure(tree, tip_win, [None], [None], [None])
        fn()  # must not raise
        self.assertIsNone(tip_win[0])


# ---------------------------------------------------------------------------
# Filter debounce — shared shape across all three modules
# ---------------------------------------------------------------------------

class HealthScannerFilterDebounceTests(unittest.TestCase):
    def _apply_filter(self, root, filter_after_id, apply_filter_now=None):
        return extract_nested_function(
            hs.show_health_scanner, "_apply_filter",
            extra_closure={
                "root": root,
                "_filter_after_id": filter_after_id,
                "_do_debounced_filter": MagicMock(),
            },
        )

    def test_burst_of_keystrokes_cancels_prior_and_ends_with_one_pending(self):
        root = MagicMock()
        filter_after_id = [None]
        fn = self._apply_filter(root, filter_after_id)

        for i in range(12):
            root.after.return_value = f"filterafter#{i}"
            fn()

        self.assertEqual(root.after.call_count, 12)
        self.assertEqual(root.after_cancel.call_count, 11)
        self.assertEqual(filter_after_id[0], "filterafter#11")
        # debounce delay
        self.assertEqual(root.after.call_args[0][0], 180)

    def test_after_cancel_tclerror_swallowed(self):
        root = MagicMock()
        root.after_cancel.side_effect = tk.TclError("gone")
        filter_after_id = ["stale"]
        fn = self._apply_filter(root, filter_after_id)
        fn()  # must not raise

    def _do_debounced_filter(self, root, filter_after_id, apply_filter_now):
        return extract_nested_function(
            hs.show_health_scanner, "_do_debounced_filter",
            extra_closure={
                "root": root,
                "_filter_after_id": filter_after_id,
                "_apply_filter_now": apply_filter_now,
            },
        )

    def test_debounced_fire_calls_apply_filter_now_exactly_once(self):
        root = _make_widget(exists=True)
        filter_after_id = ["pending"]
        apply_now = MagicMock()
        fn = self._do_debounced_filter(root, filter_after_id, apply_now)

        fn()

        apply_now.assert_called_once()
        self.assertIsNone(filter_after_id[0])

    def test_debounced_fire_against_destroyed_root_skips_rebuild(self):
        root = _make_widget(exists=False)
        filter_after_id = ["pending"]
        apply_now = MagicMock()
        fn = self._do_debounced_filter(root, filter_after_id, apply_now)
        fn()  # must not raise
        apply_now.assert_not_called()

    def test_cleanup_cancels_pending_filter_and_tooltip(self):
        cleanup = extract_nested_function(
            hs.show_health_scanner, "_cleanup",
            extra_closure={
                "_filter_after_id": ["filter#1"],
                "_tip_after_id": ["tip#1"],
                "root": (root := MagicMock()),
                "tree": (tree := MagicMock()),
            },
        )
        cleanup()
        root.after_cancel.assert_called_once_with("filter#1")
        tree.after_cancel.assert_called_once_with("tip#1")


class MaterialBrowserFilterDebounceTests(unittest.TestCase):
    """material_browser's _apply_filter/_do_debounced_filter/_apply_filter_now
    are nested inside build_material_view (the embeddable half), not
    show_material_browser — extract_nested_function only inspects the
    directly-enclosing function's co_consts."""

    def _apply_filter(self, _root, filter_after_id):
        return extract_nested_function(
            mb.build_material_view, "_apply_filter",
            extra_closure={
                "_root": _root,
                "_filter_after_id": filter_after_id,
                "_do_debounced_filter": MagicMock(),
            },
        )

    def test_burst_of_keystrokes_collapses_to_one_pending(self):
        _root = MagicMock()
        filter_after_id = [None]
        fn = self._apply_filter(_root, filter_after_id)

        for i in range(8):
            _root.after.return_value = f"mbafter#{i}"
            fn()

        self.assertEqual(_root.after.call_count, 8)
        self.assertEqual(_root.after_cancel.call_count, 7)
        self.assertEqual(filter_after_id[0], "mbafter#7")

    def test_do_debounced_filter_calls_apply_now_once(self):
        _root = _make_widget(exists=True)
        filter_after_id = ["pending"]
        apply_now = MagicMock()
        fn = extract_nested_function(
            mb.build_material_view, "_do_debounced_filter",
            extra_closure={
                "_root": _root,
                "_filter_after_id": filter_after_id,
                "_apply_filter_now": apply_now,
            },
        )
        fn()
        apply_now.assert_called_once()
        self.assertIsNone(filter_after_id[0])

    def test_cancel_pending_hook_cancels_scheduled_filter(self):
        _root = MagicMock()
        filter_after_id = ["mb#pending"]
        fn = extract_nested_function(
            mb.build_material_view, "_cancel_pending_filter",
            extra_closure={"_root": _root, "_filter_after_id": filter_after_id},
        )
        fn()
        _root.after_cancel.assert_called_once_with("mb#pending")
        self.assertIsNone(filter_after_id[0])

    def test_cancel_pending_hook_swallows_exception(self):
        _root = MagicMock()
        _root.after_cancel.side_effect = tk.TclError("gone")
        filter_after_id = ["mb#pending"]
        fn = extract_nested_function(
            mb.build_material_view, "_cancel_pending_filter",
            extra_closure={"_root": _root, "_filter_after_id": filter_after_id},
        )
        fn()  # must not raise
        self.assertIsNone(filter_after_id[0])


class NiagaraInspectorFilterDebounceTests(unittest.TestCase):
    def _apply_filter(self, root, filter_after_id):
        return extract_nested_function(
            ni.show_niagara_inspector, "_apply_filter",
            extra_closure={
                "root": root,
                "_filter_after_id": filter_after_id,
                "_do_debounced_filter": MagicMock(),
            },
        )

    def test_burst_of_keystrokes_collapses_to_one_pending(self):
        root = MagicMock()
        filter_after_id = [None]
        fn = self._apply_filter(root, filter_after_id)

        for i in range(10):
            root.after.return_value = f"niafter#{i}"
            fn()

        self.assertEqual(root.after.call_count, 10)
        self.assertEqual(root.after_cancel.call_count, 9)
        self.assertEqual(filter_after_id[0], "niafter#9")

    def test_do_debounced_filter_calls_apply_now_once(self):
        root = _make_widget(exists=True)
        filter_after_id = ["pending"]
        apply_now = MagicMock()
        fn = extract_nested_function(
            ni.show_niagara_inspector, "_do_debounced_filter",
            extra_closure={
                "root": root,
                "_filter_after_id": filter_after_id,
                "_apply_filter_now": apply_now,
            },
        )
        fn()
        apply_now.assert_called_once()
        self.assertIsNone(filter_after_id[0])

    def test_do_debounced_filter_destroyed_root_skips(self):
        root = _make_widget(exists=False)
        filter_after_id = ["pending"]
        apply_now = MagicMock()
        fn = extract_nested_function(
            ni.show_niagara_inspector, "_do_debounced_filter",
            extra_closure={
                "root": root,
                "_filter_after_id": filter_after_id,
                "_apply_filter_now": apply_now,
            },
        )
        fn()  # must not raise
        apply_now.assert_not_called()

    def test_cleanup_cancels_pending_filter(self):
        cleanup = extract_nested_function(
            ni.show_niagara_inspector, "_cleanup",
            extra_closure={
                "_filter_after_id": ["ni#pending"],
                "root": (root := MagicMock()),
            },
        )
        cleanup()
        root.after_cancel.assert_called_once_with("ni#pending")


if __name__ == "__main__":
    unittest.main()
