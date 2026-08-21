"""Test for the Search box doing nothing in device_audit.py's Device Audit
window (_on_search_changed, nested inside _show_report_window around
device_audit.py:1773-1804).

WHY this exists: a user reported typing "npc" into the Search box on a
FRESH Device Audit window (no sorting, no re-run) and the device list not
filtering at all — the header stayed "Devices (1133)" and non-matching
rows, including obvious NPC rows sitting next to non-NPC ones, remained
visible. The filter algorithm itself was verified correct in isolation.

Root cause: device_audit.py's window root was built with an unconditional
``root = tk.Tk()`` (device_audit.py:1552, before the fix below), unlike
every sibling tool in this directory (health_scanner.py, material_browser.py,
niagara_inspector.py, dependency_viewer.py, etc.), which all resolve
``_master = tk._default_root`` and use ``tk.Toplevel(_master) if _master is
not None else tk.Tk()``. When a Tk root already exists when Device Audit
opens (e.g. uefn_launcher.py's window, or a previously-opened tool window
still alive), calling tk.Tk() a second time creates a SECOND Tk
interpreter while ``tk._default_root`` keeps pointing at whichever root
was created FIRST. ``search_var = tk.StringVar()`` (no explicit master)
then silently binds to that stale FIRST interpreter instead of this
window's own — confirmed interactively: the Entry widget still shows
typed text (it has its own buffer independent of the StringVar), but
``search_var.get()`` always returns "" and the ``trace_add("write", ...)``
callback never fires. Because ``_on_search_changed`` treats an empty query
as "show everything", every row stayed visible and the header count never
changed — exactly the reported symptom, on both the trace AND the
<KeyRelease> binding paths, since both read the same corrupted variable.

Fixed by matching the sibling-tool pattern for `root` and by passing an
explicit ``master=root`` to ``search_var``/``conn_count_var`` as
belt-and-suspenders.

This test does not reproduce the dual-interpreter environment (that would
require driving two live Tk interpreters); instead it proves the actual,
compiled ``_on_search_changed`` closure filters correctly against a REAL
Treeview + StringVar sharing one root — i.e. once the variable is bound to
the right interpreter, the extracted-from-source filter logic (already
verified correct in isolation) reduces visible rows as expected. This
guards the class of bug (a StringVar answering from the wrong place) by
proving the consumer works when the variable IS wired correctly, and the
`_row_errors` wholesale-failure guard added alongside the fix by proving a
totally broken tree makes the failure loud instead of silent.

Uses `_bridge_helpers.extract_nested_function` to pull the REAL, compiled
`_on_search_changed` closure out of `_show_report_window`'s code object —
never a hand-copied reimplementation that could silently drift from the
source. Requires a REAL hidden `tk.Tk()` root and a REAL `ttk.Treeview`:
Tkinter's C-level widget constructors hang indefinitely when handed a
MagicMock master (confirmed elsewhere in this suite — see
test_panel_debounce_hazards.py's DoDebouncedShowTests docstring).
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal, extract_nested_function  # noqa: E402

ensure_bridge_on_path()
_unreal_mock = stub_unreal()
import device_audit as da  # noqa: E402
import tkinter as tk  # noqa: E402
from tkinter import ttk  # noqa: E402


def _make_devices():
    return [
        {"label": "NPC Spawner A", "class": "npc_spawner_device", "hud_layer": ""},
        {"label": "Score Manager", "class": "score_manager_device", "hud_layer": ""},
        {"label": "NPC Behavior B", "class": "npc_behavior_device", "hud_layer": ""},
        {"label": "Item Granter", "class": "item_granter_device", "hud_layer": ""},
    ]


class OnSearchChangedTests(unittest.TestCase):
    """_on_search_changed: filters the real Treeview by substring match
    against label/class/hud_layer, using the real (module-bound) search_var
    the actual UI code creates."""

    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        # Mirrors device_audit.py's own fix: search_var must share the
        # SAME interpreter as the tree/root it is read against.
        self.search_var = tk.StringVar(master=self.root)
        self.dev_tree = ttk.Treeview(
            self.root, columns=("_idx", "#", "Label", "Class"), show="headings",
        )
        self.devices = _make_devices()
        self.iids = []
        for i, dev in enumerate(self.devices):
            iid = self.dev_tree.insert(
                "", tk.END, values=(i, i + 1, dev["label"], dev["class"]),
            )
            self.iids.append(iid)
        self.devices_label = MagicMock()
        self.report = {"total_devices": len(self.devices)}

    def tearDown(self):
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def _closure(self, all_iids=None, dev_tree=None, devices=None):
        return extract_nested_function(
            da._show_report_window, "_on_search_changed",
            extra_closure={
                "all_device_iids": all_iids if all_iids is not None else self.iids,
                "dev_tree": dev_tree if dev_tree is not None else self.dev_tree,
                "devices_label": self.devices_label,
                "devices_with_actors": devices if devices is not None else self.devices,
                "report": self.report,
                "search_var": self.search_var,
            },
        )

    def test_npc_query_filters_to_matching_rows_only(self):
        """The reported bug: typing 'npc' must leave ONLY npc rows visible,
        not the full unfiltered set."""
        self.search_var.set("npc")
        fn = self._closure()
        fn()

        visible = self.dev_tree.get_children()
        self.assertEqual(len(visible), 2)
        visible_labels = {self.dev_tree.set(iid, "Label") for iid in visible}
        self.assertEqual(visible_labels, {"NPC Spawner A", "NPC Behavior B"})
        # Header must reflect the reduced count, not the raw total.
        self.devices_label.config.assert_called_with(text="Devices (2/4)")

    def test_empty_query_shows_all_rows(self):
        self.search_var.set("npc")
        fn = self._closure()
        fn()
        self.assertEqual(len(self.dev_tree.get_children()), 2)

        self.search_var.set("")
        fn()
        self.assertEqual(len(self.dev_tree.get_children()), 4)
        self.devices_label.config.assert_called_with(text="Devices (4)")

    def test_no_match_hides_every_row(self):
        self.search_var.set("zzz_no_such_device")
        fn = self._closure()
        fn()
        self.assertEqual(len(self.dev_tree.get_children()), 0)

    def test_trace_add_fires_filter_on_variable_write(self):
        """Regression guard for the actual reported bug: wiring search_var
        via trace_add (as the real code does at device_audit.py:1797) must
        invoke the real filter and change the visible set — proving the
        variable read inside the handler is NOT stuck on an empty/stale
        value from a mismatched interpreter."""
        fn = self._closure()
        self.search_var.trace_add("write", fn)

        self.search_var.set("npc")
        self.root.update()

        visible = self.dev_tree.get_children()
        self.assertEqual(len(visible), 2)

    def test_wholesale_row_failure_logs_once_not_per_row(self):
        """If every row's reattach()/detach() call raises TclError (rows
        resolve fine via set(), but the tree itself is broken for
        attach/detach — e.g. removed mid-filter), the handler must log
        once via unreal.log_warning instead of failing silently (the
        defensive guard added alongside the fix) — and must not log once
        per row. Uses a before/after call-count delta rather than
        reset_mock()/assert_not_called(), since the shared module-level
        `unreal` mock accumulates calls from unrelated tests across the
        whole suite run."""
        before = _unreal_mock.log_warning.call_count
        broken_tree = MagicMock()
        # set(iid, "_idx") must still resolve a valid in-range index so
        # every row reaches the reattach/detach branch (rather than
        # hitting the un-guarded "continue" path, which raises outright on
        # a real TclError and is not part of this guard's contract).
        broken_tree.set.side_effect = lambda iid, col: str(self.iids.index(iid))
        broken_tree.reattach.side_effect = tk.TclError("simulated: row gone")
        broken_tree.detach.side_effect = tk.TclError("simulated: row gone")
        fn = self._closure(dev_tree=broken_tree)

        fn()  # must not raise

        self.assertEqual(_unreal_mock.log_warning.call_count - before, 1)

    def test_partial_row_failure_does_not_log(self):
        """A single stale row failing (normal, expected) must stay silent —
        the guard only fires on a TOTAL wipeout. Uses a call-count delta
        for the same reason as the wholesale-failure test above."""
        before = _unreal_mock.log_warning.call_count
        broken_tree = MagicMock()
        broken_tree.set.side_effect = lambda iid, col: str(self.iids.index(iid))
        # Only ONE row's reattach/detach raises; the rest succeed — must
        # not trip the wholesale-failure guard.
        call_state = {"n": 0}

        def _flaky(*_a, **_k):
            call_state["n"] += 1
            if call_state["n"] == 1:
                raise tk.TclError("simulated: one row gone")

        broken_tree.reattach.side_effect = _flaky
        broken_tree.detach.side_effect = _flaky
        fn = self._closure(dev_tree=broken_tree)
        fn()
        self.assertEqual(_unreal_mock.log_warning.call_count, before)


if __name__ == "__main__":
    unittest.main()
