"""
UEFN Device & Asset Audit Script
=================================
Runs inside UEFN's Python console (unreal module required).

Scans all actors in the current level, identifies Fortnite Creative devices,
maps connected assets between devices, shows HUD layer assignments, tallies
non-device actors by class, and produces a JSON report, a human-readable
Output Log summary, and an in-editor tkinter report window.

Usage:  Execute from UEFN's Python console or Output Log:
    import importlib, device_audit; importlib.reload(device_audit)
"""

import unreal
import json
import os
import datetime
import traceback
import re
import webbrowser

try:
    import tkinter as tk
    from tkinter import ttk
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Keywords that identify a Fortnite Creative device class.
_DEVICE_CLASS_HINTS = (
    "Device",
    "FortCreativeDevice",
    "CreativeDevice",
    "BuildingGameplayActor",  # some older devices
)

# Properties to skip when diffing (engine internals, always-overridden noise, etc.)
_SKIP_PROPERTIES = frozenset({
    "RootComponent",
    "BlueprintCreatedComponents",
    "InstanceComponents",
    "AttachParent",
    "AttachSocketName",
    "AttachChildren",
    "Tags",
    "bNetLoadOnClient",
    "bNetUseOwnerRelevancy",
    "NetDriverName",
    "NetDormancy",
    "SpawnCollisionHandlingMethod",
    "AutoReceiveInput",
    "InputPriority",
    # Common engine-level properties that are always "overridden" but uninteresting
    "actor_guid",
    "actor_instance_guid",
    "root_component",
    "always_relevant",
    "base_loc_to_pivot_offset",
    "centroid_offset",
})


def _is_device(actor):
    """Return True if *actor* looks like a Creative device."""
    cls = actor.get_class()
    class_name = cls.get_name()

    # Walk the class hierarchy looking for device-like names.
    current = cls
    while current is not None:
        name = current.get_name()
        for hint in _DEVICE_CLASS_HINTS:
            if hint in name:
                return True
        current = current.get_super_class()

    return False


def _actor_location_tuple(actor):
    """Return (x, y, z) for the actor's world location.

    This is the traditional Unreal XYZ triple, unchanged by UEFN's LUF
    editor display (see ``_xyz_to_luf`` below) — every existing consumer of
    this function keeps reading raw XYZ exactly as before.
    """
    loc = actor.get_actor_location()
    return (round(loc.x, 2), round(loc.y, 2), round(loc.z, 2))


def _xyz_to_luf(x, y, z):
    """
    Convert a traditional Unreal XYZ position triple to UEFN's LUF
    (Left-Up-Forward) triple.

    As of UEFN 36.00, the editor uses the LUF coordinate system for the
    Details panel and all ``/Verse.org`` module transforms:
        Left    = -Y
        Up      =  Z
        Forward =  X
    ``/UnrealEngine.com`` and ``/Fortnite.com`` module transforms still use
    the traditional XYZ system — do NOT feed an LUF value into code that
    expects XYZ, or vice versa; the mixup silently mis-places the actor.

    Source: Epic's "Left-Up-Forward Coordinate System in Unreal Editor for
    Fortnite":
    https://dev.epicgames.com/documentation/fortnite/leftupforward-coordinate-system-in-unreal-editor-for-fortnite
    Epic also supplies ``FromVector3``/``FromTransform`` conversion helpers
    for the reverse direction.

    This is a pure, POSITION-ONLY conversion. LUF is right-handed while
    XYZ is left-handed, so rotation is NOT a simple component swap like
    this — do not reuse this function for rotations; use Epic's
    ``FromRotation`` helper instead (see ``get_actor_rotation()`` callers).

    Returns (left, up, forward).
    """
    return (-y, z, x)


def _get_property_names(actor, exclude=None):
    """
    Return a list of property names for *actor* by inspecting ``dir(actor)``.
    Filters out private/dunder names, callable attributes (methods), and
    names in ``_SKIP_PROPERTIES``.

    If *exclude* is provided (a frozenset of names), those names are also
    skipped.  This is used to strip base-class engine properties so that
    only device-specific properties remain.
    """
    names = []
    for name in dir(actor):
        if name.startswith("_"):
            continue
        if name in _SKIP_PROPERTIES:
            continue
        if exclude is not None and name in exclude:
            continue
        try:
            attr = getattr(actor, name)
        except Exception:
            continue
        if callable(attr):
            continue
        names.append(name)
    return names


def _build_base_property_set(all_actors):
    """
    Build a frozenset of property names that belong to the engine base classes.

    Finds the first non-device actor in *all_actors* (e.g. a StaticMeshActor,
    light, volume, etc.) and collects its property names.  Any property that
    exists on such a generic actor is considered an engine-level base property
    and can be excluded when auditing device-specific overrides.

    Only needs to be called once per audit run.
    """
    for actor in all_actors:
        try:
            if not _is_device(actor):
                names = _get_property_names(actor)
                if names:
                    unreal.log(
                        f"device_audit: Built base property set from "
                        f"{actor.get_class().get_name()} ({len(names)} props)"
                    )
                    return frozenset(names)
        except Exception:
            continue

    # Fallback: no non-device actor found — return empty set so nothing is
    # excluded and the audit still works (just noisier).
    unreal.log_warning(
        "device_audit: Could not find a non-device actor to build "
        "base property set — all properties will be checked."
    )
    return frozenset()


def _find_overridden_properties(actor, base_props=None):
    """
    Identify properties on *actor* that have been modified from their defaults.

    Uses ``actor.is_editor_property_overridden(name)`` to detect overrides and
    ``actor.get_editor_property(name)`` to read the current value.  The actual
    default value is not available (CDO comparison does not work in UEFN), so
    the default column is shown as a placeholder.

    If *base_props* is provided (a frozenset), those property names are
    excluded so that only device-specific properties are checked.

    Returns a dict of ``{name: {"actor_value": str, "default_value": str}}``.
    """
    changed = {}
    prop_names = _get_property_names(actor, exclude=base_props)

    for name in prop_names:
        try:
            if not actor.is_editor_property_overridden(name):
                continue
        except Exception:
            continue

        try:
            value = actor.get_editor_property(name)
            actor_str = str(value)
        except Exception:
            actor_str = "<unreadable>"

        changed[name] = {
            "actor_value": actor_str,
            "default_value": "\u2014",  # em-dash placeholder (CDO not available)
        }

    return changed



# ---------------------------------------------------------------------------
# UE class name → Verse-style type name conversion
# ---------------------------------------------------------------------------

def _ue_class_to_verse_keys(class_name):
    """
    Generate Verse-style type name variants from a UE class name.

    Examples:
        Device_HUDMessage_C       → hud_message, hud_message_device, hudmessage
        Device_TeamSettings_V2_C  → team_settings_v2, team_settings_v2_device, teamsettings_v2
        CreativeProp_C            → prop, creative_prop, creativeprop
        FortCreativeDeviceMutatorZone_C → mutator_zone, mutator_zone_device
    """
    name = class_name

    # 1. Strip common suffixes
    for suffix in ('_Blueprint_C', '_C'):
        if name.endswith(suffix):
            name = name[:-len(suffix)]
            break

    # 2. Strip common prefixes (order matters — longest first)
    stripped_name = name
    for prefix in ('FortCreativeDevice', 'FortCreative', 'CreativeDevice', 'Creative', 'Device_', 'Fort_', 'BP_'):
        if prefix.endswith('_'):
            # Prefix with underscore — match case-sensitively with trailing _
            if name.startswith(prefix):
                stripped_name = name[len(prefix):]
                break
        else:
            # Prefix without underscore — match at start
            if name.startswith(prefix):
                stripped_name = name[len(prefix):]
                # Remove leading underscore if present
                if stripped_name.startswith('_'):
                    stripped_name = stripped_name[1:]
                break

    keys = set()

    for variant in (stripped_name, name):
        # 3. Convert PascalCase to snake_case
        # Handle consecutive caps: "HUDMessage" → "HUD_Message"
        s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', variant)
        # Handle camelCase boundary: "hudMessage" → "hud_Message"
        s = re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', s)
        snake = s.lower()

        # Normalise multiple/leading/trailing underscores
        snake = re.sub(r'_+', '_', snake).strip('_')

        if snake:
            keys.add(snake)

            # 4. Variant with _device suffix
            if not snake.endswith('_device'):
                keys.add(snake + '_device')

            # Also add a no-underscore variant (e.g. hudmessage)
            flat = snake.replace('_', '')
            if flat and flat != snake:
                keys.add(flat)

    # For stripped variant only, also add with "creative_" prefix
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', stripped_name)
    s = re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', s)
    base_snake = re.sub(r'_+', '_', s.lower()).strip('_')
    if base_snake:
        # Add creative_ prefixed variant for types like CreativeProp → creative_prop
        creative_key = 'creative_' + base_snake
        if creative_key != base_snake:
            keys.add(creative_key)

    return list(keys)


# ---------------------------------------------------------------------------
# Verse file parsing — discover device connections from source code
# ---------------------------------------------------------------------------

_VERSE_SCAN_SKIP = frozenset({"Saved", "Intermediate", "__pycache__", ".uefn_bridge"})


def _find_verse_dir():
    """
    Locate the directory tree containing .verse files.

    Search strategy (in order, returns the first hit):
    1. Content/ parent of the script's Python/ folder (original logic).
    2. Any sibling directories under the same Content/ parent.
    3. Plugin Content dirs: walk up until a Plugins/ folder is found, then
       scan each Plugins/<plugin>/Content subtree (one level deep).
    4. Project root one level above Plugins/.

    Directories named Saved, Intermediate, __pycache__, or .uefn_bridge are
    skipped to avoid scanning large generated-file trees.

    Returns the directory path where .verse files were found, or None.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))

    def _has_verse(directory):
        """Return True if *directory* contains at least one .verse file (any depth, capped)."""
        try:
            for root_dir, dirs, files in os.walk(directory):
                # Prune skip dirs in-place
                dirs[:] = [d for d in dirs if d not in _VERSE_SCAN_SKIP]
                # Depth cap: stop if we are too deep (>4 levels below directory)
                rel = os.path.relpath(root_dir, directory)
                depth = 0 if rel == '.' else rel.count(os.sep) + 1
                if depth > 4:
                    dirs[:] = []
                    continue
                for fname in files:
                    if fname.endswith('.verse'):
                        return True
        except Exception:
            pass
        return False

    # --- Strategy 1: Content/ parent (original) ---
    content_dir = os.path.dirname(script_dir)
    if os.path.isdir(content_dir) and _has_verse(content_dir):
        return content_dir

    # --- Strategy 2: Sibling Content dirs ---
    parent_of_content = os.path.dirname(content_dir)
    if os.path.isdir(parent_of_content):
        try:
            for sibling in os.listdir(parent_of_content):
                sib_path = os.path.join(parent_of_content, sibling)
                if os.path.isdir(sib_path) and sibling not in _VERSE_SCAN_SKIP:
                    if _has_verse(sib_path):
                        return sib_path
        except Exception:
            pass

    # --- Strategy 3 & 4: Walk up looking for Plugins/ directory ---
    cursor = script_dir
    for _ in range(10):  # cap the walk
        plugins_dir = os.path.join(cursor, "Plugins")
        if os.path.isdir(plugins_dir):
            # Scan each Plugins/<plugin>/Content subtree
            try:
                for plugin_name in os.listdir(plugins_dir):
                    if plugin_name in _VERSE_SCAN_SKIP:
                        continue
                    plugin_content = os.path.join(plugins_dir, plugin_name, "Content")
                    if os.path.isdir(plugin_content) and _has_verse(plugin_content):
                        return plugin_content
            except Exception:
                pass
            # Also check the project root itself (one level above Plugins/)
            if _has_verse(cursor):
                return cursor
            break
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent

    unreal.log_warning(
        f"device_audit: _find_verse_dir: no .verse files found "
        f"(searched from {script_dir})"
    )
    return None


def _parse_verse_files(verse_dir):
    """
    Parse all .verse files under *verse_dir* to extract:
    - Class definitions with their @editable fields
    - Subscribe calls (event wiring between devices)

    Returns a dict keyed by class name (lowercase):
    {
        "countdown_timer_device": {
            "file": "countdown_timer_device.verse",
            "editables": [{"name": "TeamDevices", "type": "example_team", "is_array": True}, ...],
            "subscribes": [{"source": "Timer", "event": "SuccessEvent", "handler": "OnTimerDone"}, ...],
        },
        ...
    }
    """
    # Regex patterns
    # Class declaration: name := class(parent):
    re_class = re.compile(
        r'^(\w+)\s*:=\s*class\s*\(([^)]+)\)\s*:', re.MULTILINE
    )
    # @editable field — broadened to handle composite/generic types:
    #   - Attribute blocks:  @editable { ToolTip := "..." }
    #   - var prefix:        @editable var Foo : type = default
    #   - @editable on its own line with field declaration on next line
    #   - Spaces around colon, optional `?` (optional type), `[]` (array type)
    #   - Generic / composite types:  array(t), map(k,v), t<u>, `[]` suffix
    #   - Leading `?` optional marker before OR after colon
    #   - Optional `= <default>` initialiser
    #   Groups:
    #     GROUP 1: field name  (always \w+)
    #     GROUP 2: optional marker `?` (may be empty)
    #     GROUP 3: full type expression (captures bare word, array(...),
    #              map(...), generics with <>, [] suffix — everything up to
    #              `=`, `\n`, or end of statement)
    #     GROUP 4: first \w+ token within the type (base type name, for
    #              backward-compat with existing editable dict key "type")
    re_editable = re.compile(
        r'@editable'                        # decorator
        r'(?:'
          r'\s*\{[^}]*\}'                   # optional attribute block  { ... }
        r')?'
        r'[ \t]*'
        r'(?:var[ \t]+)?'                   # optional `var` keyword
        r'(?:\w+[ \t]*:=[ \t]*[^\n]*\n[ \t]*)?'  # optional intervening assignment line
        r'(\w+)'                            # GROUP 1: field name
        r'[ \t]*:[ \t]*'                    # colon (spaces allowed)
        r'(\??)'                            # GROUP 2: optional marker
        r'((?:\[\])?'                       # GROUP 3: full type expression
          r'(?:\w+)'                        #   mandatory first token
          r'(?:'                            #   optional trailer:
            r'\s*[<([][^)\]>]*[)\]>]'       #     generic <>, (), []  (one level)
          r')?'
          r'(?:\[\])?'                      #   optional [] suffix (array)
        r')',
        re.MULTILINE,
    )
    # Helper to extract the first \w+ token from a full type expression
    _re_first_word = re.compile(r'\w+')
    # Subscribe call: Source.Event.Subscribe(Handler)
    re_subscribe = re.compile(
        r'(\w+)\.(\w+)\s*\.\s*Subscribe\s*\(\s*(\w+(?:\.\w+)?)\s*\)'
    )

    classes = {}
    verse_file_count = 0
    total_editables = 0

    for root_dir, dirs, files in os.walk(verse_dir):
        # Prune skip dirs in-place to avoid scanning huge generated trees
        dirs[:] = [d for d in dirs if d not in _VERSE_SCAN_SKIP]
        for fname in files:
            if not fname.endswith('.verse'):
                continue
            verse_file_count += 1
            fpath = os.path.join(root_dir, fname)
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception:
                continue

            # Find class declarations
            class_matches = list(re_class.finditer(content))
            if not class_matches:
                continue

            for cm in class_matches:
                class_name = cm.group(1).lower()
                parent_class = cm.group(2).strip().lower()
                class_start = cm.start()

                # Find the end of this class (next class declaration or EOF)
                # Simple heuristic: next top-level identifier := class(
                next_class = None
                for other in class_matches:
                    if other.start() > class_start:
                        next_class = other.start()
                        break
                class_body = content[class_start:next_class] if next_class else content[class_start:]

                # Extract @editable fields
                editables = []
                for em in re_editable.finditer(class_body):
                    field_name = em.group(1)
                    is_optional = em.group(2) == '?'
                    full_type = em.group(3) or ""
                    # is_array: full type starts/ends with [] or contains array(
                    is_array = (
                        full_type.startswith('[]')
                        or full_type.endswith('[]')
                        or full_type.lower().startswith('array(')
                    )
                    # base type: first \w+ token in the full type expression
                    _m = _re_first_word.search(full_type)
                    field_type = _m.group(0).lower() if _m else full_type.lower()
                    editables.append({
                        "name": field_name,
                        "type": field_type,
                        "full_type": full_type,   # keep full composite for diagnostics
                        "is_array": is_array,
                        "is_optional": is_optional,
                    })
                    total_editables += 1

                # Extract Subscribe calls
                subscribes = []
                for sm in re_subscribe.finditer(class_body):
                    subscribes.append({
                        "source": sm.group(1),
                        "event": sm.group(2),
                        "handler": sm.group(3),
                    })

                classes[class_name] = {
                    "file": fname,
                    "parent": parent_class,
                    "editables": editables,
                    "subscribes": subscribes,
                }

    # Emit diagnostic summary to Output Log
    diag_msg = (
        f"device_audit: Verse scan: {verse_file_count} .verse files, "
        f"{len(classes)} classes, {total_editables} @editable fields"
        + (f" (dir: {verse_dir})" if verse_file_count == 0 else "")
    )
    unreal.log(diag_msg)

    # Attach diagnostics to the returned dict so callers / UI can surface them
    classes["__verse_scan_stats__"] = {
        "_is_meta": True,
        "verse_file_count": verse_file_count,
        "class_count": len(classes),  # computed before this entry is added
        "editable_count": total_editables,
        "verse_dir": verse_dir,
    }

    return classes


def _fmt_vec(v, prec=1):
    """Format an unreal Vector as 'x, y, z' at the given precision; defensive."""
    try:
        return f"{v.x:.{prec}f}, {v.y:.{prec}f}, {v.z:.{prec}f}"
    except Exception:
        return str(v)


def _collect_device_details(actor):
    """Gather per-device facts that ARE readable via stable actor methods
    (transform, placement, hierarchy, tags, components). Fortnite Creative
    gameplay options and event bindings are NOT reachable from Python, so they
    are deliberately omitted. Returns an ordered list of
    (section, field, value, note) tuples. Every unreal.* access is guarded so a
    single failure never blanks the panel."""
    rows = []
    if actor is None:
        return rows

    # --- Identity ---
    try:
        rows.append(("Identity", "Class", actor.get_class().get_name(), ""))
    except Exception:
        pass

    # --- Transform ---
    # Location is shown in BOTH conventions, clearly labelled, so it can
    # never be mistaken for the other: XYZ (traditional, used by
    # /UnrealEngine.com and /Fortnite.com module transforms) and LUF
    # (Left-Up-Forward, what the UEFN 36.00+ Details panel and /Verse.org
    # actually display). See _xyz_to_luf's docstring for the source.
    try:
        loc = actor.get_actor_location()
        rows.append(("Transform", "Location (XYZ)", _fmt_vec(loc),
                     "/UnrealEngine.com, /Fortnite.com"))
        lx, ly, lz = _xyz_to_luf(loc.x, loc.y, loc.z)
        rows.append(("Transform", "Location (LUF)",
                     f"{lx:.1f}, {ly:.1f}, {lz:.1f}",
                     "Details panel, /Verse.org (36.00+)"))
    except Exception:
        pass
    try:
        r = actor.get_actor_rotation()
        rows.append(("Transform", "Rotation (XYZ only)",
                     f"P {r.pitch:.1f}  Y {r.yaw:.1f}  R {r.roll:.1f}",
                     "NOT LUF — convert with Epic's FromRotation"))
    except Exception:
        pass
    try:
        rows.append(("Transform", "Scale", _fmt_vec(actor.get_actor_scale3d(), 2), ""))
    except Exception:
        pass

    # --- Placement (outliner folder / layer) ---
    try:
        fp = actor.get_folder_path()
        fp = str(fp) if fp else ""
        if fp and fp.lower() != "none":
            rows.append(("Placement", "Folder", fp, ""))
    except Exception:
        pass

    # --- Hierarchy (real, readable attachment relationships) ---
    try:
        parent = actor.get_attach_parent_actor()
        if parent is not None:
            rows.append(("Hierarchy", "Attached to",
                         _safe_label(parent), parent.get_class().get_name()))
    except Exception:
        pass
    try:
        children = actor.get_attached_actors()
        if children:
            for ch in children:
                try:
                    rows.append(("Hierarchy", "Child",
                                 _safe_label(ch), ch.get_class().get_name()))
                except Exception:
                    continue
    except Exception:
        pass

    # --- Tags ---
    try:
        for t in actor.tags:
            ts = str(t)
            if ts:
                rows.append(("Tags", ts, "", ""))
    except Exception:
        pass

    # --- Visual (mesh + materials on the device's static-mesh components) ---
    try:
        comps = actor.get_components_by_class(unreal.StaticMeshComponent)
        seen_mesh = set()
        for comp in comps:
            try:
                mesh = comp.get_editor_property("static_mesh")
            except Exception:
                mesh = None
            if mesh is not None:
                mname = mesh.get_name()
                if mname not in seen_mesh:
                    seen_mesh.add(mname)
                    rows.append(("Visual", "Mesh", mname, ""))
            try:
                n = comp.get_num_materials()
                for i in range(n):
                    mat = comp.get_material(i)
                    if mat is not None:
                        rows.append(("Visual", f"Material[{i}]", mat.get_name(), ""))
            except Exception:
                continue
    except Exception:
        pass

    return rows


def _build_verse_connections(device_label, device_class, verse_data, device_labels_by_type, device_layers_by_label=None, source_actor=None):
    """
    Build connection list for a device using parsed Verse data.

    *device_class* is the actor's class name (e.g. "VerseDevice_C" or
    "Device_TeamSettings_V2_C").
    *device_label* is the actor's display label (e.g. "countdown timer device").
    *verse_data* is the output of _parse_verse_files().
    *device_labels_by_type* maps lowercased type hints to lists of device labels.

    Returns a list of dicts:
    {"property": str, "target_label": str, "target_class": str, "is_device": bool, "conn_type": str}
    """
    connections = []

    # Try to match device to a Verse class by label or class name.
    # Strategy 1: direct label key
    label_key = device_label.lower().replace(' ', '_').replace('-', '_')
    verse_class = verse_data.get(label_key)

    # Strategy 2: label + common suffixes
    if not verse_class:
        for suffix in ('_device', '_manager', '_instance', ''):
            candidate = label_key + suffix
            if candidate in verse_data:
                verse_class = verse_data[candidate]
                break

    # Strategy 3: label prefix match against verse class names
    if not verse_class:
        for vclass_name, vclass_data in verse_data.items():
            if vclass_name.startswith('__'):  # skip meta entries
                continue
            if label_key.startswith(vclass_name.replace('_device', '').replace('_manager', '')):
                verse_class = vclass_data
                break

    # Strategy 4 (FIX): map UE class name → Verse-style keys via
    # _ue_class_to_verse_keys and match against verse_data.
    # This is the critical fix for "45 classes parsed, 0 connections":
    # label-based matching misses devices whose Verse class name derives
    # from the UE class (e.g. Device_CountdownTimer_C → countdown_timer_device).
    if not verse_class and device_class:
        for vkey in _ue_class_to_verse_keys(device_class):
            if vkey in verse_data:
                verse_class = verse_data[vkey]
                unreal.log(
                    f"device_audit: {device_label}: matched Verse class via "
                    f"UE class key '{vkey}' (from {device_class})"
                )
                break

    if not verse_class:
        return connections

    # Build connections from @editable fields
    for ed in verse_class.get("editables", []):
        field_name = ed["name"]
        field_type = ed["type"]

        # Try to resolve the actual connected actor via get_editor_property.
        # On failure, also try common UEFN name manglings (snake_case <-> PascalCase).
        resolved_actor = None
        resolved_label = None
        resolved_class = None
        if source_actor is not None:
            # Build a prioritised list of candidate property name variants to try
            def _name_variants(name):
                """Yield the exact name plus common snake↔Pascal manglings."""
                yield name
                # snake_case → PascalCase
                pascal = ''.join(w.capitalize() for w in name.split('_'))
                if pascal != name:
                    yield pascal
                # PascalCase → snake_case
                s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', name)
                s = re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', s)
                snake = re.sub(r'_+', '_', s.lower()).strip('_')
                if snake != name:
                    yield snake
                # Also try with 'b' prefix stripped / added (bEnabled → Enabled)
                if name.startswith('b') and len(name) > 1 and name[1].isupper():
                    yield name[1:]
                else:
                    yield 'b' + name[0].upper() + name[1:]

            for candidate_name in _name_variants(field_name):
                try:
                    ref = source_actor.get_editor_property(candidate_name)
                    if ref is not None and hasattr(ref, 'get_actor_label'):
                        resolved_actor = ref
                        resolved_label = _safe_label(ref)
                        resolved_class = ref.get_class().get_name()
                        break
                except Exception:
                    continue

        if resolved_label:
            # Successfully resolved — show the actual connected device
            conn_type = "editable"
            if ed["is_array"]:
                conn_type = "editable[]"
            if ed["is_optional"]:
                conn_type = "editable?"
            layer = (device_layers_by_label or {}).get(resolved_label, "")
            # If layer not found in lookup, try getting it directly from resolved actor
            if not layer and resolved_actor is not None:
                layer = _get_hud_layer(resolved_actor)
            connections.append({
                "property": field_name,
                "target_label": resolved_label,
                "target_class": resolved_class,
                "is_device": True,
                "conn_type": conn_type,
                "target_hud_layer": layer,
            })
        elif ed["is_array"] and source_actor is not None:
            # For arrays, get_editor_property might return a list
            try:
                refs = source_actor.get_editor_property(field_name)
                if refs is not None and hasattr(refs, '__iter__'):
                    for ref in refs:
                        if ref is not None and hasattr(ref, 'get_actor_label'):
                            rlabel = _safe_label(ref)
                            rclass = ref.get_class().get_name()
                            layer = (device_layers_by_label or {}).get(rlabel, "")
                            if not layer:
                                layer = _get_hud_layer(ref)
                            connections.append({
                                "property": field_name,
                                "target_label": rlabel,
                                "target_class": rclass,
                                "is_device": True,
                                "conn_type": "editable[]",
                                "target_hud_layer": layer,
                            })
                    # If we got any from the array, continue to next editable
                    if any(c["property"] == field_name for c in connections):
                        continue
            except Exception:
                pass
            # Fall through to type-based matching if array resolution failed
            matching_devices = device_labels_by_type.get(field_type, [])
            if matching_devices:
                for target_label, target_class in matching_devices:
                    conn_type = "editable[]"
                    connections.append({
                        "property": field_name,
                        "target_label": target_label,
                        "target_class": target_class,
                        "is_device": True,
                        "conn_type": conn_type,
                        "target_hud_layer": (device_layers_by_label or {}).get(target_label, ""),
                    })
            else:
                if any(hint in field_type for hint in ('device', 'manager', 'spawner',
                        'trigger', 'hud', 'volume', 'prop', 'camera', 'player',
                        'team', 'selector', 'sequence', 'channel', 'timer',
                        'audio', 'vfx', 'creative', 'canvas')):
                    connections.append({
                        "property": field_name,
                        "target_label": f"({field_type})",
                        "target_class": "\u2014",
                        "is_device": False,
                        "conn_type": "editable (unresolved)",
                        "target_hud_layer": "",
                    })
        else:
            # No source_actor or resolution failed — fall back to type-based matching
            matching_devices = device_labels_by_type.get(field_type, [])
            if matching_devices:
                for target_label, target_class in matching_devices:
                    conn_type = "editable"
                    if ed["is_array"]:
                        conn_type = "editable[]"
                    if ed["is_optional"]:
                        conn_type = "editable?"
                    connections.append({
                        "property": field_name,
                        "target_label": target_label,
                        "target_class": target_class,
                        "is_device": True,
                        "conn_type": conn_type,
                        "target_hud_layer": (device_layers_by_label or {}).get(target_label, ""),
                    })
            else:
                # Only show unresolved if the type looks like a device reference
                if any(hint in field_type for hint in ('device', 'manager', 'spawner',
                        'trigger', 'hud', 'volume', 'prop', 'camera', 'player',
                        'team', 'selector', 'sequence', 'channel', 'timer',
                        'audio', 'vfx', 'creative', 'canvas')):
                    connections.append({
                        "property": field_name,
                        "target_label": f"({field_type})",
                        "target_class": "\u2014",
                        "is_device": False,
                        "conn_type": "editable (unresolved)",
                        "target_hud_layer": "",
                    })

    # Log resolution results for debugging
    resolved_count = sum(1 for c in connections if c["is_device"])
    unresolved_count = sum(1 for c in connections if c["conn_type"] == "editable (unresolved)")
    if connections:
        unreal.log(f"device_audit: {device_label}: {resolved_count} resolved, {unresolved_count} unresolved connections")

    # Build connections from Subscribe calls
    for sub in verse_class.get("subscribes", []):
        source = sub["source"]
        event = sub["event"]
        # The source field name should match an @editable field
        connections.append({
            "property": f"{source}.{event}",
            "target_label": f"\u2192 {sub['handler']}",
            "target_class": "event subscription",
            "is_device": False,
            "conn_type": "subscribe",
            "target_hud_layer": "",
        })

    return connections


# Property names that indicate a HUD/UI layer setting on Creative devices
_HUD_LAYER_PROPS = ("Layer", "UILayer", "HUDLayer", "ZOrder", "layer", "ui_layer", "hud_layer", "z_order")

def _get_hud_layer(actor):
    """
    Return the HUD layer value for a device, or empty string if not a HUD device.
    Checks common layer property names used by Creative HUD devices.
    """
    for prop_name in _HUD_LAYER_PROPS:
        try:
            value = actor.get_editor_property(prop_name)
            if value is not None:
                return str(value)
        except Exception:
            continue
    return ""


def _safe_label(actor):
    """Return the actor's display label, falling back to its name."""
    try:
        return actor.get_actor_label()
    except Exception:
        pass
    try:
        return actor.get_name()
    except Exception:
        return "<unknown>"


# ---------------------------------------------------------------------------
# Tkinter report window
# ---------------------------------------------------------------------------

# Dark theme colors
_BG = "#D2CEC4"
_TEXT = "#2B2B2B"
_ACCENT = "#F15B29"
_SECTION_BG = "#EBE7DD"
_HEADER_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_BLUE = "#F15B29"
_TEXT_DIM = "#57524C"
_ENTRY_BG = "#FBFAF6"
_ENTRY_FG = "#1A1A1A"


def _treeview_sort_column(tree, col, reverse, numeric_cols=None):
    """
    Sort *tree* by column *col*.

    *reverse* toggles ascending/descending.  *numeric_cols* is a set of
    column identifiers that should be compared numerically (int/float)
    rather than alphabetically.

    After sorting, the heading text is updated with a directional arrow
    and the command is rebound to toggle the sort direction on next click.
    """
    if numeric_cols is None:
        numeric_cols = set()

    # Gather (sort_key, item_id) pairs
    data = []
    for iid in tree.get_children(""):
        raw = tree.set(iid, col)
        if col in numeric_cols:
            try:
                key = float(raw)
            except (ValueError, TypeError):
                key = 0
        else:
            key = str(raw).lower()
        data.append((key, iid))

    data.sort(key=lambda t: t[0], reverse=reverse)

    for position, (_, iid) in enumerate(data):
        tree.move(iid, "", position)

    # Update heading text with sort arrow, stripping any previous arrow
    base_text = col.rstrip(" \u25b2\u25bc")
    # Also strip arrows from any previous heading that had one
    for c in tree["columns"]:
        old = tree.heading(c, "text")
        tree.heading(c, text=old.replace(" \u25b2", "").replace(" \u25bc", ""))

    arrow = " \u25bc" if reverse else " \u25b2"
    tree.heading(col, text=base_text + arrow)

    # Rebind to toggle direction
    tree.heading(
        col,
        command=lambda: _treeview_sort_column(tree, col, not reverse, numeric_cols),
    )


def _show_report_window(report, devices_with_actors, base_props=None, all_device_actors=None, verse_data=None, device_labels_by_type=None):
    """
    Create a tkinter window displaying the audit results.

    *devices_with_actors* is a list of device dicts that each contain an
    ``"actor"`` key holding the live unreal actor reference (for editor
    selection on double-click).
    """
    if not _HAS_TKINTER:
        unreal.log_warning(
            "device_audit: tkinter is not available — "
            "skipping report window (see Output Log for results)."
        )
        return

    root = tk.Tk()
    root.title("Trashbyrd's Device Audit")
    root.geometry("1000x700")
    root.configure(bg=_BG)
    root.attributes("-topmost", True)

    _logo_img = None
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        _logo_path = os.path.join(_script_dir, "trashbyrd_40x40.png")
        if os.path.isfile(_logo_path):
            _logo_img = tk.PhotoImage(file=_logo_path, master=root)
    except Exception:
        pass

    # -- ttk dark-theme styling --
    style = ttk.Style(root)
    style.theme_use("clam")

    # General frame/label defaults
    style.configure(".", background=_BG, foreground=_TEXT, font=("Segoe UI", 9))
    style.configure("TFrame", background=_BG)
    style.configure("TLabel", background=_BG, foreground=_TEXT)
    style.configure("TScrollbar", background=_SECTION_BG, troughcolor=_BG, borderwidth=0)

    style.configure(
        "Treeview",
        background=_SECTION_BG,
        foreground=_TEXT,
        fieldbackground=_SECTION_BG,
        borderwidth=0,
        rowheight=22,
        font=("Consolas", 9),
    )
    style.configure(
        "Treeview.Heading",
        background=_HEADER_BG,
        foreground=_HEADER_FG,
        borderwidth=0,
        font=("Segoe UI", 9, "bold"),
        relief="flat",
    )
    style.map("Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    # -- Actor lookup for double-click selection --
    actor_map = {}  # treeview item id -> unreal actor

    # ================================================================
    # Top section — summary bar
    # ================================================================
    top_frame = tk.Frame(root, bg=_BG, padx=12, pady=8)
    top_frame.pack(fill=tk.X)

    tk.Label(
        top_frame,
        text="UEFN Device Audit",
        font=("Segoe UI", 16, "bold"),
        fg=_ACCENT,
        bg=_BG,
    ).pack(side=tk.LEFT)

    stats_text = (
        f"Total Actors: {report['total_actors']}  |  "
        f"Devices: {report['total_devices']}  |  "
        f"Non-Device: {report['total_non_devices']}  |  "
        f"{report['audit_timestamp']}"
    )
    tk.Label(
        top_frame,
        text=stats_text,
        font=("Segoe UI", 10),
        fg=_TEXT,
        bg=_BG,
    ).pack(side=tk.RIGHT)

    # ================================================================
    # Middle section — Devices table with search
    # ================================================================
    mid_frame = tk.Frame(root, bg=_SECTION_BG)
    mid_frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=(4, 2))

    # Header row with label and search bar
    header_frame = tk.Frame(mid_frame, bg=_SECTION_BG)
    header_frame.pack(fill=tk.X)

    devices_label = tk.Label(
        header_frame,
        text=f"Devices ({report['total_devices']})",
        font=("Segoe UI", 11, "bold"),
        fg=_HEADER_FG,
        bg=_SECTION_BG,
        anchor=tk.W,
        padx=6,
        pady=4,
    )
    devices_label.pack(side=tk.LEFT)

    search_var = tk.StringVar()
    search_entry = tk.Entry(
        header_frame,
        textvariable=search_var,
        font=("Segoe UI", 10),
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief=tk.FLAT,
        width=30,
    )
    search_entry.pack(side=tk.RIGHT, padx=6, pady=4)

    tk.Label(
        header_frame,
        text="Search:",
        font=("Segoe UI", 10),
        fg=_TEXT,
        bg=_SECTION_BG,
    ).pack(side=tk.RIGHT)

    dev_all_columns = ("_idx", "#", "Label", "Class", "Location", "Layer")
    dev_display_columns = ("#", "Label", "Class", "Location", "Layer")
    dev_tree = ttk.Treeview(
        mid_frame, columns=dev_all_columns, displaycolumns=dev_display_columns,
        show="headings", height=12,
    )

    dev_numeric_cols = {"#"}

    dev_tree.heading("#", text="#", anchor=tk.CENTER,
                     command=lambda: _treeview_sort_column(dev_tree, "#", False, dev_numeric_cols))
    dev_tree.heading("Label", text="Label", anchor=tk.W,
                     command=lambda: _treeview_sort_column(dev_tree, "Label", False, dev_numeric_cols))
    dev_tree.heading("Class", text="Class", anchor=tk.W,
                     command=lambda: _treeview_sort_column(dev_tree, "Class", False, dev_numeric_cols))
    dev_tree.heading("Location", text="Location", anchor=tk.W,
                     command=lambda: _treeview_sort_column(dev_tree, "Location", False, dev_numeric_cols))
    dev_tree.heading("Layer", text="Layer", anchor=tk.CENTER,
                     command=lambda: _treeview_sort_column(dev_tree, "Layer", False, dev_numeric_cols))

    dev_tree.column("_idx", width=0, stretch=False)
    dev_tree.column("#", width=40, stretch=False, anchor=tk.CENTER)
    dev_tree.column("Label", width=260)
    dev_tree.column("Class", width=280)
    dev_tree.column("Location", width=220)
    dev_tree.column("Layer", width=80, stretch=False, anchor=tk.CENTER)

    dev_scroll = ttk.Scrollbar(mid_frame, orient=tk.VERTICAL, command=dev_tree.yview)
    dev_tree.configure(yscrollcommand=dev_scroll.set)

    dev_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    dev_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    # Populate the devices table
    for i, dev in enumerate(devices_with_actors, 1):
        loc = dev["location"]
        loc_str = f"{loc['x']}, {loc['y']}, {loc['z']}"
        iid = dev_tree.insert(
            "",
            tk.END,
            values=(i - 1, i, dev["label"], dev["class"], loc_str,
                    dev.get("hud_layer", "")),
        )
        if dev.get("actor") is not None:
            actor_map[iid] = dev["actor"]

    # Store all iids for search filtering (must be before trace_add)
    all_device_iids = list(dev_tree.get_children())

    # -- Search/filter handler --
    def _on_search_changed(*_args):
        query = search_var.get().lower().strip()
        for iid in all_device_iids:
            idx = int(dev_tree.set(iid, "_idx"))
            if idx < 0 or idx >= len(devices_with_actors):
                continue
            dev = devices_with_actors[idx]
            text = f"{dev['label']} {dev['class']} {dev.get('hud_layer', '')}".lower()
            if query == "" or query in text:
                try:
                    dev_tree.reattach(iid, "", tk.END)
                except tk.TclError:
                    pass
            else:
                try:
                    dev_tree.detach(iid)
                except tk.TclError:
                    pass
        visible = len(dev_tree.get_children())
        if query:
            devices_label.config(text=f"Devices ({visible}/{report['total_devices']})")
        else:
            devices_label.config(text=f"Devices ({report['total_devices']})")

    search_var.trace_add("write", _on_search_changed)
    search_entry.bind("<KeyRelease>", lambda _e: _on_search_changed())

    # ================================================================
    # Bottom section — Verse-parsed device connections
    # ================================================================
    bottom_frame = tk.Frame(root, bg=_SECTION_BG)
    bottom_frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=(2, 8))

    detail_label = tk.Label(
        bottom_frame,
        text="Device Details \u2014 select a device above",
        font=("Segoe UI", 11, "bold"),
        fg=_HEADER_FG,
        bg=_SECTION_BG,
        anchor=tk.W,
        padx=6,
        pady=4,
    )
    detail_label.pack(fill=tk.X)

    detail_columns = ("value", "note")
    detail_tree = ttk.Treeview(
        bottom_frame, columns=detail_columns, show="tree headings", height=8,
    )

    detail_tree.heading("#0", text="Field")
    detail_tree.heading("value", text="Value")
    detail_tree.heading("note", text="Notes")

    detail_tree.column("#0", width=240, stretch=False)
    detail_tree.column("value", width=440, stretch=True)
    detail_tree.column("note", width=220, stretch=False)

    # Grouped-tree row styles (reuse the file's existing palette).
    detail_tree.tag_configure("section", foreground=_HEADER_FG, font=("Segoe UI", 9, "bold"))
    detail_tree.tag_configure("detail", foreground=_TEXT)
    detail_tree.tag_configure("conn", foreground="#227A32")
    detail_tree.tag_configure("info", foreground=_TEXT_DIM)
    # Legacy tags retained for any lingering references.
    detail_tree.tag_configure("actor_ref", foreground="#227A32")
    detail_tree.tag_configure("asset_ref", foreground="#A8431A")

    detail_scroll = ttk.Scrollbar(bottom_frame, orient=tk.VERTICAL, command=detail_tree.yview)
    detail_tree.configure(yscrollcommand=detail_scroll.set)

    detail_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    detail_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    # -- Selection handler: show Verse-parsed connections for selected device --
    def _on_device_select(_event):
        selection = dev_tree.selection()
        if not selection:
            return
        detail_tree.delete(*detail_tree.get_children())

        item = selection[0]
        idx = int(dev_tree.set(item, "_idx"))
        if idx < 0 or idx >= len(devices_with_actors):
            return

        dev = devices_with_actors[idx]
        detail_label.config(text=f"Device Details \u2014 {dev['label']}")
        actor = dev.get("actor")
        row_count = 0

        # Section parent nodes are created on demand and kept open.
        _section_nodes = {}

        def _section(name):
            if name not in _section_nodes:
                _section_nodes[name] = detail_tree.insert(
                    "", tk.END, text=name, values=("", ""),
                    tags=("section",), open=True,
                )
            return _section_nodes[name]

        # 1) Readable facts via stable actor methods (transform, hierarchy, etc.)
        try:
            for section, field, value, note in _collect_device_details(actor):
                detail_tree.insert(
                    _section(section), tk.END, text=field,
                    values=(value, note), tags=("detail",),
                )
                row_count += 1
        except Exception as e:
            unreal.log_warning(f"device_audit: detail collection failed \u2014 {e}")

        # 2) Verse @editable connections (only meaningful for custom Verse devices)
        verse_conns = []
        if verse_data and device_labels_by_type:
            try:
                _layers_lookup = {
                    d["label"]: d.get("hud_layer", "") for d in devices_with_actors
                }
                verse_conns = _build_verse_connections(
                    dev["label"], dev["class"], verse_data, device_labels_by_type,
                    device_layers_by_label=_layers_lookup,
                    source_actor=actor,
                )
            except Exception as e:
                unreal.log_warning(f"device_audit: verse connection build failed \u2014 {e}")

        if verse_conns:
            vc_node = _section("Verse Connections")
            verse_conns.sort(key=lambda c: (
                not c["is_device"],
                c["conn_type"] == "subscribe",
                c["target_label"],
            ))
            for conn in verse_conns:
                note = "  \u00b7  ".join(
                    p for p in (conn["target_class"], conn["conn_type"],
                                conn.get("target_hud_layer", ""))
                    if p and p != "\u2014"
                )
                detail_tree.insert(
                    vc_node, tk.END, text=conn["property"],
                    values=(conn["target_label"], note), tags=("conn",),
                )
                row_count += 1

        # 3) Honest note for stock devices that have no Verse wiring.
        if not verse_conns:
            note_node = _section("Creative Options")
            detail_tree.insert(
                note_node, tk.END, text="Not introspectable",
                values=("Enable state & event bindings are stored in UEFN's "
                        "internal Creative container and are not exposed to "
                        "Python.", ""),
                tags=("info",),
            )

        if row_count == 0 and actor is None:
            detail_tree.insert(
                "", tk.END, text="(no actor)",
                values=("Device actor reference unavailable.", ""),
                tags=("info",),
            )

        conn_count_var.set(f"{row_count} detail row(s)")

    dev_tree.bind("<<TreeviewSelect>>", _on_device_select)

    # -- Double-click handler: select actor in UEFN editor --
    def _on_device_double_click(_event):
        selection = dev_tree.selection()
        if not selection:
            return
        item = selection[0]
        actor = actor_map.get(item)
        if actor is not None:
            try:
                subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
                subsystem.select_nothing()
                subsystem.set_actor_selection_state(actor, True)
                unreal.log(f"device_audit: Selected actor in editor.")
            except Exception as e:
                unreal.log_warning(f"device_audit: Could not select actor: {e}")

    dev_tree.bind("<Double-1>", _on_device_double_click)

    # -- Double-click handler on connections detail table: select target device --
    def _on_detail_double_click(_event):
        selection = detail_tree.selection()
        if not selection:
            return
        item = selection[0]
        # In the grouped Device Details tree, a Verse-connection row's target
        # device label lives in the "value" column (only "conn" rows are devices).
        if "conn" not in detail_tree.item(item, "tags"):
            return
        target_label = detail_tree.set(item, "value")
        # Find the device in the top table by label
        for dev_iid in all_device_iids:
            idx = int(dev_tree.set(dev_iid, "_idx"))
            if 0 <= idx < len(devices_with_actors):
                dev = devices_with_actors[idx]
                if dev["label"] == target_label:
                    # Select in editor
                    actor = dev.get("actor")
                    if actor is not None:
                        try:
                            subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
                            subsystem.select_nothing()
                            subsystem.set_actor_selection_state(actor, True)
                            unreal.log(f"device_audit: Selected '{target_label}' in editor.")
                        except Exception as e:
                            unreal.log_warning(f"device_audit: Could not select actor: {e}")
                    # Also select in dev_tree and scroll to it
                    dev_tree.selection_set(dev_iid)
                    dev_tree.see(dev_iid)
                    break

    detail_tree.bind("<Double-1>", _on_detail_double_click)

    # Footer with connection count (left) and social link (right)
    footer_frame = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=2)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM)

    conn_count_var = tk.StringVar(value="")
    conn_count_label = tk.Label(
        footer_frame,
        textvariable=conn_count_var,
        font=("Segoe UI", 8),
        fg=_TEXT,
        bg=_SECTION_BG,
    )
    conn_count_label.pack(side=tk.LEFT)

    social_label = tk.Label(
        footer_frame,
        text="by @thetrashbyrd",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_SECTION_BG,
        cursor="hand2",
    )
    social_label.pack(side=tk.RIGHT)
    social_label.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    if _logo_img:
        footer_logo = tk.Label(footer_frame, image=_logo_img, bg=_SECTION_BG, cursor="hand2")
        footer_logo._img_ref = _logo_img
        footer_logo.pack(side=tk.RIGHT, padx=(4, 0))
        footer_logo.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # ================================================================
    # Tick callback — pump tkinter from the Unreal event loop
    # ================================================================
    _tick_handle = [None]  # mutable container for the callback handle

    def _tick_pump(delta_time):
        try:
            root.update()
        except tk.TclError:
            # Window was closed — unregister the tick callback
            if _tick_handle[0] is not None:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None

    _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick_pump)

    # Also unregister cleanly if the user closes via the X button
    def _on_close():
        if _tick_handle[0] is not None:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)


# ---------------------------------------------------------------------------
# Main audit
# ---------------------------------------------------------------------------

def run_audit():
    """Execute the full device/asset audit and produce reports."""
    try:
        _run_audit_inner()
    except Exception:
        unreal.log_error(
            "device_audit: Unhandled exception in run_audit:\n"
            + traceback.format_exc()
        )


def _run_audit_inner():
    """Inner implementation — called by run_audit() with top-level error handling."""

    # ------------------------------------------------------------------
    # 1. Obtain all actors via the editor subsystem
    # ------------------------------------------------------------------
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception as e:
        unreal.log_error(f"device_audit: get_editor_subsystem raised: {e}")
        return
    if subsystem is None:
        unreal.log_error("device_audit: Could not get EditorActorSubsystem.")
        return

    try:
        all_actors = subsystem.get_all_level_actors()
    except Exception as e:
        unreal.log_error(f"device_audit: get_all_level_actors raised: {e}")
        return
    total = len(all_actors)
    unreal.log(f"device_audit: Found {total} actor(s) in the level.")

    if total == 0:
        unreal.log_warning("device_audit: Level is empty — nothing to audit.")
        return

    # ------------------------------------------------------------------
    # 2. Build base property set (once) to exclude engine-level props
    # ------------------------------------------------------------------
    base_props = _build_base_property_set(all_actors)

    # ------------------------------------------------------------------
    # 3. Classify actors with progress feedback
    # ------------------------------------------------------------------
    devices = []
    non_device_counts = {}  # class_name -> count

    for idx, actor in enumerate(all_actors):
        if idx > 0 and idx % 500 == 0:
            unreal.log(f"device_audit: Processing actor {idx}/{total}...")

        try:
            class_name = actor.get_class().get_name()

            if _is_device(actor):
                # ---- Device processing ----
                label = _safe_label(actor)
                location = _actor_location_tuple(actor)
                hud_layer = _get_hud_layer(actor)

                devices.append({
                    "label": label,
                    "class": class_name,
                    "location": {"x": location[0], "y": location[1], "z": location[2]},
                    "hud_layer": hud_layer,
                    "actor": actor,  # live reference for editor selection
                })
            else:
                # ---- Non-device tally ----
                non_device_counts[class_name] = non_device_counts.get(class_name, 0) + 1
        except Exception:
            unreal.log_warning(
                f"device_audit: Failed to process actor {idx}: {traceback.format_exc()}"
            )
            continue

    # ------------------------------------------------------------------
    # 4. Build the report (exclude live actor refs from serializable copy)
    # ------------------------------------------------------------------
    # Build device actor set for connection detection (used in UI on-demand)
    all_device_actors = set()
    for dev in devices:
        actor = dev.get("actor")
        if actor is not None:
            all_device_actors.add(actor)

    # Parse Verse files for connection data
    verse_dir = _find_verse_dir()
    verse_data = {}
    if verse_dir:
        try:
            verse_data = _parse_verse_files(verse_dir)
            # _parse_verse_files emits its own diagnostic log; subtract the meta entry
            real_class_count = sum(1 for k in verse_data if not k.startswith('__'))
            unreal.log(
                f"device_audit: Verse parse complete — "
                f"{real_class_count} classes from {verse_dir}"
            )
        except Exception as e:
            unreal.log_warning(f"device_audit: Verse parsing failed: {e}")
    else:
        unreal.log_warning(
            "device_audit: No .verse files found — "
            "connections panel will show scan diagnostics."
        )

    # Build type->device lookup for connection matching
    # Maps lowercased type hints to [(label, class_name), ...]
    device_labels_by_type = {}
    for dev in devices:
        label = dev["label"]
        class_name = dev["class"]
        # Add multiple keys for matching flexibility
        label_key = label.lower().replace(' ', '_').replace('-', '_')
        for key in (label_key, class_name.lower()):
            device_labels_by_type.setdefault(key, []).append((label, class_name))
        # Also add without common prefixes/suffixes
        for prefix in ('device_', 'fort_', 'bp_'):
            if class_name.lower().startswith(prefix):
                short = class_name.lower()[len(prefix):]
                device_labels_by_type.setdefault(short, []).append((label, class_name))
        # Also add the label as a type key (for Verse devices whose class is VerseDevice_C)
        device_labels_by_type.setdefault(label_key, []).append((label, class_name))
        # Add Verse-style type name variants (e.g. Device_HUDMessage_C → hud_message_device)
        for verse_key in _ue_class_to_verse_keys(class_name):
            device_labels_by_type.setdefault(verse_key, []).append((label, class_name))

    serializable_devices = []
    for dev in devices:
        d = {k: v for k, v in dev.items() if k != "actor"}
        serializable_devices.append(d)

    report = {
        "audit_timestamp": datetime.datetime.now().isoformat(),
        "total_actors": total,
        "total_devices": len(devices),
        "total_non_devices": total - len(devices),
        "devices": serializable_devices,
        "non_device_summary": [
            {"class": cls, "count": cnt}
            for cls, cnt in sorted(non_device_counts.items(), key=lambda kv: -kv[1])
        ],
    }

    # ------------------------------------------------------------------
    # 5. Save JSON report
    # ------------------------------------------------------------------
    output_dir = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(output_dir, exist_ok=True)

    timestamp_slug = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = os.path.join(output_dir, f"device_audit_{timestamp_slug}.json")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    unreal.log(f"device_audit: JSON report saved to {json_path}")

    # ------------------------------------------------------------------
    # 5b. Open tkinter report window
    # ------------------------------------------------------------------
    _show_report_window(report, devices, base_props, all_device_actors, verse_data, device_labels_by_type)

    # ------------------------------------------------------------------
    # 6. Human-readable summary to the Output Log
    # ------------------------------------------------------------------
    unreal.log("=" * 72)
    unreal.log("  DEVICE & ASSET AUDIT SUMMARY")
    unreal.log("=" * 72)
    unreal.log(f"  Total actors in level : {total}")
    unreal.log(f"  Devices               : {len(devices)}")
    unreal.log(f"  Non-device actors     : {total - len(devices)}")
    unreal.log("-" * 72)

    if devices:
        unreal.log("  DEVICES:")
        for i, dev in enumerate(devices, 1):
            loc = dev["location"]
            layer_str = f"  [Layer: {dev['hud_layer']}]" if dev.get("hud_layer") else ""
            unreal.log(
                f"    {i:>3}. {dev['label']}"
                f"  ({dev['class']})"
                f"  @ ({loc['x']}, {loc['y']}, {loc['z']}){layer_str}"
            )

        unreal.log("-" * 72)

    if non_device_counts:
        unreal.log("  NON-DEVICE ACTORS (by class, top 20):")
        for entry in report["non_device_summary"][:20]:
            unreal.log(f"    {entry['count']:>5}x  {entry['class']}")
        if len(report["non_device_summary"]) > 20:
            remaining = sum(
                e["count"] for e in report["non_device_summary"][20:]
            )
            unreal.log(
                f"    ... and {len(report['non_device_summary']) - 20} more "
                f"classes ({remaining} actors)"
            )
        unreal.log("-" * 72)

    unreal.log(f"  JSON report : {json_path}")
    unreal.log(f"  Report window opened" if _HAS_TKINTER else "  (tkinter unavailable — no report window)")
    unreal.log("=" * 72)


# ---------------------------------------------------------------------------
# Auto-run when executed / imported
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    run_audit()
# NOTE: No longer auto-runs on import. Use the launcher or call run_audit() directly.
