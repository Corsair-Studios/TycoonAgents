"""
UEFN Batch Operations
======================
Batch property read/write for Fortnite Creative devices.
Runs inside UEFN's embedded Python 3.11 (requires ``unreal`` module).

Provides two interfaces:
  1. **Programmatic / MCP-callable** — ``batch_set_property()`` and
     ``batch_get_property()`` work without tkinter.
  2. **Tkinter UI** — ``show_batch_ui()`` opens an interactive window.

Usage:
    from batch_tools import batch_set_property, batch_get_property, show_batch_ui
"""

import unreal
import os
import traceback
import webbrowser
from fnmatch import fnmatch

from device_audit import _is_device, _safe_label

try:
    import tkinter as tk
    from tkinter import ttk
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Theme constants (matching launcher palette)
# ---------------------------------------------------------------------------

_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"
_ENTRY_BG = "#FBFAF6"
_ENTRY_FG = "#1A1A1A"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_all_actors():
    """Return all level actors via EditorActorSubsystem."""
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception as e:
        raise RuntimeError(f"get_editor_subsystem raised: {e}") from e
    if subsystem is None:
        raise RuntimeError("Could not get EditorActorSubsystem")
    try:
        return subsystem.get_all_level_actors()
    except Exception as e:
        raise RuntimeError(f"get_all_level_actors raised: {e}") from e


def _coerce_value(new_value, current_value):
    """
    Coerce *new_value* (which may be a string from JSON) to match the type
    of *current_value*.  If *current_value* is None, return *new_value* as-is.
    """
    if current_value is None:
        return new_value

    target_type = type(current_value)

    # Already the correct type
    if isinstance(new_value, target_type):
        return new_value

    # Boolean -- handle string "true"/"false" and numeric 0/1
    if target_type is bool:
        if isinstance(new_value, str):
            return new_value.lower() in ("true", "1", "yes")
        return bool(new_value)

    # Integer
    if target_type is int:
        return int(float(new_value))

    # Float
    if target_type is float:
        return float(new_value)

    # String
    if target_type is str:
        return str(new_value)

    # Fallback: return as-is and let unreal handle it
    return new_value


def _match_actors(filter_type, filter_value):
    """
    Return a list of (actor, label, class_name) tuples matching the filter.

    filter_type: "class" | "label" | "all_devices"
    filter_value: pattern string (ignored for "all_devices")
    """
    all_actors = _get_all_actors()
    matched = []

    for actor in all_actors:
        try:
            if not _is_device(actor):
                continue

            label = _safe_label(actor)
            class_name = actor.get_class().get_name()

            if filter_type == "all_devices":
                matched.append((actor, label, class_name))

            elif filter_type == "class":
                # Case-insensitive substring match
                if filter_value.lower() in class_name.lower():
                    matched.append((actor, label, class_name))

            elif filter_type == "label":
                # Case-insensitive fnmatch glob
                if fnmatch(label.lower(), filter_value.lower()):
                    matched.append((actor, label, class_name))

        except Exception:
            continue

    return matched


# ---------------------------------------------------------------------------
# Core functions (MCP-callable, no tkinter dependency)
# ---------------------------------------------------------------------------

def batch_set_property(filter_type, filter_value, property_name, value, dry_run=False):
    """
    Set a property on multiple actors matching a filter.

    Args:
        filter_type: "class" | "label" | "all_devices"
        filter_value: class name pattern, label glob pattern, or "" for all_devices
        property_name: UE property name to set
        value: value to set (string, will be coerced)
        dry_run: if True, just report what would change without modifying

    Returns:
        dict with:
          - matched: int (number of actors matched)
          - modified: int (number actually changed, 0 if dry_run)
          - actors: list of {label, class, old_value, new_value}
    """
    try:
        matched_actors = _match_actors(filter_type, filter_value)
    except Exception as e:
        unreal.log_warning(f"batch_tools: batch_set_property failed to get actors: {e}")
        return {"matched": 0, "modified": 0, "actors": [], "error": str(e)}
    results = []
    modified_count = 0

    for actor, label, class_name in matched_actors:
        try:
            # Read current value
            try:
                current = actor.get_editor_property(property_name)
                old_value_str = str(current)
            except Exception:
                current = None
                old_value_str = "<unreadable>"

            coerced = _coerce_value(value, current)
            new_value_str = str(coerced)

            if not dry_run:
                actor.set_editor_property(property_name, coerced)
                modified_count += 1

            results.append({
                "label": label,
                "class": class_name,
                "old_value": old_value_str,
                "new_value": new_value_str,
            })
        except Exception as e:
            results.append({
                "label": label,
                "class": class_name,
                "old_value": "<error>",
                "new_value": "<error: " + str(e) + ">",
            })

    return {
        "matched": len(matched_actors),
        "modified": modified_count,
        "actors": results,
    }


def batch_get_property(filter_type, filter_value, property_name):
    """
    Read a property from multiple actors matching a filter.

    Args:
        filter_type: "class" | "label" | "all_devices"
        filter_value: class name pattern, label glob pattern, or "" for all_devices
        property_name: UE property name to read

    Returns:
        dict with:
          - matched: int
          - actors: list of {label, class, value}
    """
    try:
        matched_actors = _match_actors(filter_type, filter_value)
    except Exception as e:
        unreal.log_warning(f"batch_tools: batch_get_property failed to get actors: {e}")
        return {"matched": 0, "actors": [], "error": str(e)}
    results = []

    for actor, label, class_name in matched_actors:
        try:
            val = actor.get_editor_property(property_name)
            results.append({
                "label": label,
                "class": class_name,
                "value": str(val),
            })
        except Exception as e:
            results.append({
                "label": label,
                "class": class_name,
                "value": "<error: " + str(e) + ">",
            })

    return {
        "matched": len(matched_actors),
        "actors": results,
    }


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_batch_ui():
    """Create and display the batch operations UI window."""
    if not _HAS_TKINTER:
        unreal.log_error("batch_tools: tkinter is not available.")
        return

    root = tk.Tk()
    root.title("Trashbyrd's Batch Operations")
    root.geometry("700x560")
    root.configure(bg=_BG)
    root.resizable(True, True)

    # ==================================================================
    # Style configuration
    # ==================================================================
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(
        "Treeview",
        background=_SECTION_BG,
        foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG,
        font=("Segoe UI", 9),
        rowheight=22,
    )
    style.configure(
        "Treeview.Heading",
        background=_BG,
        foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"),
    )
    style.map("Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    # Combobox styling for dark theme
    style.configure(
        "Dark.TCombobox",
        fieldbackground=_ENTRY_BG,
        background=_ENTRY_BG,
        foreground=_ENTRY_FG,
        selectbackground="#F6D9C9",
        selectforeground="#1A1A1A",
        arrowcolor=_ACCENT_BLUE,
    )
    style.map(
        "Dark.TCombobox",
        fieldbackground=[("readonly", _ENTRY_BG)],
        foreground=[("readonly", _ENTRY_FG)],
        selectbackground=[("readonly", "#F6D9C9")],
        selectforeground=[("readonly", "#1A1A1A")],
    )
    root.option_add("*TCombobox*Listbox.background", _ENTRY_BG)
    root.option_add("*TCombobox*Listbox.foreground", _ENTRY_FG)
    root.option_add("*TCombobox*Listbox.selectBackground", "#F6D9C9")
    root.option_add("*TCombobox*Listbox.selectForeground", "#1A1A1A")

    # ==================================================================
    # Filter section
    # ==================================================================
    filter_frame = tk.Frame(root, bg=_SECTION_BG, padx=12, pady=10)
    filter_frame.pack(fill=tk.X, padx=10, pady=(10, 4))

    tk.Label(
        filter_frame,
        text="Filter",
        font=("Segoe UI", 11, "bold"),
        fg=_HEADER_FG,
        bg=_SECTION_BG,
    ).grid(row=0, column=0, columnspan=5, sticky=tk.W, pady=(0, 6))

    tk.Label(
        filter_frame,
        text="Type:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=1, column=0, sticky=tk.W, padx=(0, 6))

    filter_type_var = tk.StringVar(value="all_devices")
    filter_type_combo = ttk.Combobox(
        filter_frame,
        textvariable=filter_type_var,
        values=["all_devices", "class", "label"],
        state="readonly",
        width=14,
        style="Dark.TCombobox",
        font=("Segoe UI", 9),
    )
    filter_type_combo.grid(row=1, column=1, padx=(0, 10))

    tk.Label(
        filter_frame,
        text="Value:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=1, column=2, sticky=tk.W, padx=(0, 6))

    filter_value_var = tk.StringVar()
    filter_value_entry = tk.Entry(
        filter_frame,
        textvariable=filter_value_var,
        width=24,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief=tk.FLAT,
        font=("Segoe UI", 9),
    )
    filter_value_entry.grid(row=1, column=3, padx=(0, 10))

    tk.Label(
        filter_frame,
        text="Property:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=2, column=0, sticky=tk.W, padx=(0, 6), pady=(6, 0))

    property_name_var = tk.StringVar()
    property_entry = tk.Entry(
        filter_frame,
        textvariable=property_name_var,
        width=24,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief=tk.FLAT,
        font=("Segoe UI", 9),
    )
    property_entry.grid(row=2, column=1, columnspan=2, sticky=tk.W, pady=(6, 0))

    preview_btn = tk.Button(
        filter_frame,
        text="Preview",
        font=("Segoe UI", 9, "bold"),
        bg=_ACCENT_BLUE,
        fg="#1A1A1A",
        activebackground="#D24E1F",
        activeforeground="#1A1A1A",
        relief=tk.FLAT,
        padx=14,
        pady=2,
        cursor="hand2",
    )
    preview_btn.grid(row=1, column=4, padx=(4, 0))

    # ==================================================================
    # Preview table
    # ==================================================================
    preview_frame = tk.Frame(root, bg=_SECTION_BG)
    preview_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=4)

    tk.Label(
        preview_frame,
        text="Matched Actors",
        font=("Segoe UI", 10, "bold"),
        fg=_HEADER_FG,
        bg=_SECTION_BG,
        anchor=tk.W,
        padx=6,
        pady=4,
    ).pack(fill=tk.X)

    preview_columns = ("Label", "Class", "Value")
    preview_tree = ttk.Treeview(
        preview_frame,
        columns=preview_columns,
        show="headings",
        height=10,
    )

    preview_tree.heading("Label", text="Label", anchor=tk.W)
    preview_tree.heading("Class", text="Class", anchor=tk.W)
    preview_tree.heading("Value", text="Current Value", anchor=tk.W)

    preview_tree.column("Label", width=220)
    preview_tree.column("Class", width=240)
    preview_tree.column("Value", width=200)

    preview_scroll = ttk.Scrollbar(
        preview_frame, orient=tk.VERTICAL, command=preview_tree.yview
    )
    preview_tree.configure(yscrollcommand=preview_scroll.set)

    preview_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    preview_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    # ==================================================================
    # Action section
    # ==================================================================
    action_frame = tk.Frame(root, bg=_SECTION_BG, padx=12, pady=10)
    action_frame.pack(fill=tk.X, padx=10, pady=4)

    tk.Label(
        action_frame,
        text="Set Value:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=0, column=0, sticky=tk.W, padx=(0, 6))

    set_value_var = tk.StringVar()
    set_value_entry = tk.Entry(
        action_frame,
        textvariable=set_value_var,
        width=24,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief=tk.FLAT,
        font=("Segoe UI", 9),
    )
    set_value_entry.grid(row=0, column=1, padx=(0, 10))

    _dry_run_state = [True]  # plain Python mutable — avoids tk.BooleanVar desync in UEFN
    dry_run_check = tk.Checkbutton(
        action_frame,
        text="Dry Run",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
        selectcolor=_ENTRY_BG,
        activebackground=_SECTION_BG,
        activeforeground=_TEXT_FG,
    )
    dry_run_check.select()  # start checked since default is True
    dry_run_check.grid(row=0, column=2, padx=(0, 10))

    def _on_dry_run_toggle():
        _dry_run_state[0] = not _dry_run_state[0]
    dry_run_check.config(command=_on_dry_run_toggle)

    apply_btn = tk.Button(
        action_frame,
        text="Apply",
        font=("Segoe UI", 9, "bold"),
        bg=_ACCENT_GREEN,
        fg="#1A1A1A",
        activebackground="#256E30",
        activeforeground="#1A1A1A",
        relief=tk.FLAT,
        padx=14,
        pady=2,
        cursor="hand2",
    )
    apply_btn.grid(row=0, column=3, padx=(4, 0))

    # ==================================================================
    # Results area
    # ==================================================================
    results_frame = tk.Frame(root, bg=_BG, padx=12, pady=6)
    results_frame.pack(fill=tk.X, padx=10, pady=(0, 10))

    results_label = tk.Label(
        results_frame,
        text="",
        font=("Segoe UI", 9),
        fg=_ACCENT_GREEN,
        bg=_BG,
        anchor=tk.W,
    )
    results_label.pack(fill=tk.X)

    # Footer with social link
    footer_frame = tk.Frame(root, bg=_BG)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM, padx=10, pady=(0, 6))
    count_label_var = tk.StringVar(value="")
    count_label = tk.Label(
        footer_frame,
        textvariable=count_label_var,
        font=("Segoe UI", 8),
        fg=_TEXT_FG,
        bg=_BG,
    )
    count_label.pack(side=tk.LEFT)
    social_label = tk.Label(
        footer_frame,
        text="by @thetrashbyrd",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_BG,
        cursor="hand2",
    )
    social_label.pack(side=tk.RIGHT)
    social_label.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # ==================================================================
    # Button handlers
    # ==================================================================
    def _do_preview():
        """Run preview: show matched actors and their current property values."""
        preview_tree.delete(*preview_tree.get_children())
        results_label.config(text="")

        ft = filter_type_combo.get()
        fv = filter_value_entry.get().strip()
        prop = property_entry.get().strip()

        unreal.log(f"batch_tools: Preview — filter_type={ft!r}, filter_value={fv!r}, property={prop!r}")

        if ft in ("class", "label") and not fv:
            results_label.config(text="Enter a filter value.", fg="#C0392B")
            return

        try:
            matched = _match_actors(ft, fv)
        except Exception as e:
            results_label.config(text="Error: " + str(e), fg="#C0392B")
            return

        for actor, label, class_name in matched:
            value_str = ""
            if prop:
                try:
                    val = actor.get_editor_property(prop)
                    value_str = str(val)
                except Exception as e:
                    value_str = "<error: " + str(e) + ">"

            preview_tree.insert("", tk.END, values=(label, class_name, value_str))

        results_label.config(
            text="Matched {count} actor(s).".format(count=len(matched)),
            fg=_ACCENT_BLUE,
        )
        count_label_var.set(f"{len(matched)} matched")

    def _do_apply():
        """Run batch set operation."""
        ft = filter_type_combo.get()
        fv = filter_value_entry.get().strip()
        prop = property_entry.get().strip()
        val = set_value_entry.get()
        dry = _dry_run_state[0]

        unreal.log(f"batch_tools: Apply — filter_type={ft!r}, filter_value={fv!r}, property={prop!r}, value={val!r}, dry_run={dry}")

        if not prop:
            results_label.config(text="Enter a property name.", fg="#C0392B")
            return

        if ft in ("class", "label") and not fv:
            results_label.config(text="Enter a filter value.", fg="#C0392B")
            return

        try:
            result = batch_set_property(ft, fv, prop, val, dry_run=dry)
        except Exception as e:
            results_label.config(text="Error: " + str(e), fg="#C0392B")
            return

        # Update the preview table with results
        preview_tree.delete(*preview_tree.get_children())
        for entry in result["actors"]:
            display_val = entry["old_value"] + " -> " + entry["new_value"]
            preview_tree.insert(
                "", tk.END,
                values=(entry["label"], entry["class"], display_val),
            )

        if dry:
            msg = "Dry run: {matched} matched, would modify {matched} actor(s).".format(
                matched=result["matched"],
            )
            results_label.config(text=msg, fg=_ACCENT_BLUE)
        else:
            msg = "Modified {modified} of {matched} actor(s).".format(
                modified=result["modified"],
                matched=result["matched"],
            )
            results_label.config(text=msg, fg=_ACCENT_GREEN)
        count_label_var.set(f"{result['matched']} matched | {result['modified']} modified")

    preview_btn.config(command=_do_preview)
    apply_btn.config(command=_do_apply)

    # ==================================================================
    # Tick callback -- pump tkinter from the Unreal event loop
    # ==================================================================
    _tick_handle = [None]

    def _tick_pump(delta_time):
        try:
            root.update()
        except tk.TclError:
            # Window was closed -- unregister the tick callback
            if _tick_handle[0] is not None:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None

    _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick_pump)

    # Clean close via the X button
    def _on_close():
        if _tick_handle[0] is not None:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    unreal.log("batch_tools: Batch Operations window opened.")
