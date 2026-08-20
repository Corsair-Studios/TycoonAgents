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
import glob
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

# Cache of resolved class-default-objects, keyed by class name — see
# _get_class_default_object below.
_CDO_CACHE = {}

# Class path names (or the sentinel "<symbol-missing>", or a class's bare
# name as a last-resort dedup key when get_path_name() itself is
# unavailable) for which a CDO resolution failure has already been logged,
# so a level with thousands of actors of an unsupported class logs the
# warning once, not once per actor.
_CDO_UNAVAILABLE_LOGGED = set()

# Max characters kept for a stringified property value in the JSON report
# (mirrors property_inspector.py's _VALUE_MAX_LEN convention).
_REPORT_VALUE_MAX_LEN = 120


def _get_class_default_object(cls):
    """
    Return the class-default-object (CDO) for *cls*, or ``None`` if
    ``unreal.get_default_object`` is unavailable on this build or the call
    raises.

    Field-proven (live UEFN probe): ``unreal.get_default_object(cls)``
    successfully returned a CDO for 579/579 level classes seen, including
    all 42 device classes, with 100% of properties readable via
    ``cdo.get_editor_property(name)`` afterward. Still guarded end-to-end —
    an older/unusual UEFN build is not something this repo controls — so a
    missing or failing CDO degrades ONLY the default-value diffing feature;
    it must never raise out of an audit.

    Cached per class, keyed on the class's full ``get_path_name()`` when
    available — NOT the bare ``get_name()`` short name. Two distinct
    classes can share a short name (e.g. two Verse devices named
    identically in different modules); a name-only key would let the
    second lookup silently return the FIRST class's cached CDO, producing
    wrong-default comparisons (false "overridden" / false "equal").
    ``get_path_name()`` is this codebase's established disambiguation
    pattern for exactly this (asset_usage.py, texture_finder.py,
    moderation_scanner.py), so it is tried first and, when it resolves,
    makes same-name collisions impossible. Only when ``get_path_name``
    itself is unavailable/fails on this build does this fall back to the
    bare short name — a real (if rarer) residual collision risk versus no
    caching at all, but still far better than re-resolving the CDO once
    per ACTOR instead of once per CLASS on levels with thousands of
    actors.
    """
    try:
        class_label = cls.get_name()
    except Exception:
        class_label = "<unknown class>"

    get_path_name = getattr(cls, "get_path_name", None)
    cache_key = None
    if get_path_name is not None:
        try:
            cache_key = get_path_name()
        except Exception:
            cache_key = None  # resolution itself failed — fall through
    if cache_key is None:
        # get_path_name unavailable or failed — fall back to the bare
        # short name (see docstring for the residual collision caveat).
        cache_key = class_label

    if cache_key in _CDO_CACHE:
        return _CDO_CACHE[cache_key]

    get_default_object = getattr(unreal, "get_default_object", None)
    if get_default_object is None:
        # One-time note, not per-actor spam: log this exactly once for the
        # whole process, the first time it's discovered.
        if "<symbol-missing>" not in _CDO_UNAVAILABLE_LOGGED:
            _CDO_UNAVAILABLE_LOGGED.add("<symbol-missing>")
            unreal.log_warning(
                "device_audit: unreal.get_default_object is not available in "
                "this UEFN build — default-value diffing is disabled for "
                "this audit; changed properties will still be reported, "
                "just without their real default values."
            )
        _CDO_CACHE[cache_key] = None
        return None

    try:
        cdo = get_default_object(cls)
    except Exception as e:
        if cache_key not in _CDO_UNAVAILABLE_LOGGED:
            _CDO_UNAVAILABLE_LOGGED.add(cache_key)
            unreal.log_warning(
                f"device_audit: get_default_object({class_label}) raised: {e} "
                "— default-value diffing disabled for this class only."
            )
        cdo = None

    _CDO_CACHE[cache_key] = cdo
    return cdo


def _truncate_report_value(value):
    """Stringify *value* for the JSON report, truncated to
    ``_REPORT_VALUE_MAX_LEN`` chars so one pathological property (e.g. a
    huge array) can't blow up the report. Mirrors property_inspector.py's
    ``_truncate`` convention."""
    try:
        s = str(value)
    except Exception:
        return "<unrepresentable>"
    if len(s) > _REPORT_VALUE_MAX_LEN:
        return s[:_REPORT_VALUE_MAX_LEN] + "..."
    return s


def _is_device(actor):
    """Return True if *actor* looks like a Creative device.

    Hardened per-call (mirrors build_mode_cleanup.py's ``_is_device`` twin —
    the two must stay in lockstep): ``get_class()``/``get_name()``/
    ``get_super_class()`` can raise on some Blueprint classes. A walk
    failure means "couldn't determine" — return False rather than let the
    exception propagate and silently vanish the actor from callers that
    don't guard this call themselves.
    """
    try:
        cls = actor.get_class()
    except Exception:
        return False

    # Walk the class hierarchy looking for device-like names.
    current = cls
    while current is not None:
        try:
            name = current.get_name()
        except Exception:
            break
        for hint in _DEVICE_CLASS_HINTS:
            if hint in name:
                return True
        try:
            current = current.get_super_class()
        except Exception:
            break

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
    Identify properties on *actor* that differ from their class defaults.

    Real class-default-object (CDO) diffing: resolves the actor's CDO via
    ``_get_class_default_object`` and, for each enumerated property, reads
    BOTH the instance value and the CDO value, comparing with Python ``==``.
    Struct-valued properties stringify with memory addresses (e.g.
    ``<Struct 'Vector3f' (0x...)>``), so ``==`` on the raw returned values \u2014
    never str()/repr() forms \u2014 is the only correct comparison (unreal
    structs implement value equality; field-proven against a live UEFN
    level: an Item Spawner instance showed 11/124 properties differing,
    113 equal, 0 unreadable). If ``==`` itself raises for some exotic
    property type, that property is classified ``"unknown"`` \u2014 NEVER
    ``True`` (differing) \u2014 a comparison failure must never masquerade as a
    real override.

    If the CDO cannot be resolved at all (older UEFN build, or resolution
    itself failed), falls back to ``actor.is_editor_property_overridden``
    to detect overrides \u2014 same detection as before this upgrade \u2014 but the
    default is reported as an explicit ``None`` with a
    ``default_unavailable_reason``, never a silent placeholder that could
    be mistaken for real data.

    If *base_props* is provided (a frozenset), those property names are
    excluded so that only device-specific properties are checked.

    Returns a dict of ``{name: {"actor_value": str, "default_value": str or
    None, "overridden": True | False | "unknown", ...}}`` containing only
    properties that differ from their default or could not be conclusively
    compared \u2014 properties confirmed equal to their default are omitted, so
    ``len(result)`` still means "changed (or uncertain) property count", as
    it always has.
    """
    changed = {}
    prop_names = _get_property_names(actor, exclude=base_props)

    try:
        cdo = _get_class_default_object(actor.get_class())
    except Exception:
        cdo = None

    if cdo is not None:
        for name in prop_names:
            try:
                actor_value = actor.get_editor_property(name)
                actor_readable = True
            except Exception:
                actor_value = None
                actor_readable = False

            try:
                default_value = cdo.get_editor_property(name)
                default_readable = True
            except Exception:
                default_value = None
                default_readable = False

            if not actor_readable or not default_readable:
                # Can't compare without both sides \u2014 never guess "differing".
                changed[name] = {
                    "actor_value": _truncate_report_value(actor_value) if actor_readable else "<unreadable>",
                    "default_value": None,
                    "default_unavailable_reason": "property unreadable on instance or default object",
                    "overridden": "unknown",
                }
                continue

            try:
                is_equal = bool(actor_value == default_value)
            except Exception:
                # The comparison itself raised (exotic type) \u2014 per the
                # field-proven comparison rule, this is "unknown", never
                # "differing".
                changed[name] = {
                    "actor_value": _truncate_report_value(actor_value),
                    "default_value": _truncate_report_value(default_value),
                    "overridden": "unknown",
                }
                continue

            if is_equal:
                continue  # matches the class default \u2014 not "changed"

            changed[name] = {
                "actor_value": _truncate_report_value(actor_value),
                "default_value": _truncate_report_value(default_value),
                "overridden": True,
            }

        return changed

    # --- No CDO available: fall back to Unreal's own override flag ---
    for name in prop_names:
        try:
            if not actor.is_editor_property_overridden(name):
                continue
        except Exception:
            continue

        try:
            value = actor.get_editor_property(name)
            actor_str = _truncate_report_value(value)
        except Exception:
            actor_str = "<unreadable>"

        changed[name] = {
            "actor_value": actor_str,
            "default_value": None,
            "default_unavailable_reason": "class-default-object unavailable in this UEFN build",
            "overridden": True,
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


def _is_inside_fortnite_install(directory):
    """Return True if *directory* structurally sits inside an Epic/Fortnite
    ENGINE install tree rather than a user project — i.e. one of its path
    segments is "FortniteGame" and a later segment is "Plugins" (the shape
    of .../FortniteGame/Plugins/VerseDevices/ScriptTemplates, Epic's
    template .verse files). Detected structurally so this works regardless
    of install drive/location (per docs/PATH-DISCOVERY.md — never match a
    hardcoded "C:\\Program Files" string). Never raises."""
    try:
        parts = [p for p in os.path.normpath(directory).split(os.sep) if p]
        if "FortniteGame" not in parts:
            return False
        idx = parts.index("FortniteGame")
        return "Plugins" in parts[idx + 1:]
    except Exception:
        return False


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


def _looks_like_real_project(directory):
    """Content-based signal (docs/PATH-DISCOVERY.md sec. 3) that *directory*
    is a genuine UEFN project tree, not merely a folder that happens to
    contain .verse files (e.g. Epic's ScriptTemplates): it must have
    .verse files AND a Content/__ExternalActors__ directory somewhere
    under it (checked at *directory* itself and at its parent, since
    *directory* may already BE the Content dir). Never raises."""
    try:
        if not _has_verse(directory):
            return False
        for base in (directory, os.path.dirname(directory)):
            if os.path.isdir(os.path.join(base, "__ExternalActors__")):
                return True
            if os.path.isdir(os.path.join(base, "Content", "__ExternalActors__")):
                return True
        return False
    except Exception:
        return False


def _registry_fortnite_projects_roots():
    """Read the Windows "Personal" (Documents) known-folder value straight
    from the registry — the authoritative source regardless of
    OneDrive/other redirection schemes (docs/PATH-DISCOVERY.md sec. 4,
    same signal as init_unreal.py's project-root discovery) — and return
    the "Fortnite Projects" directory under it (existence not checked).
    Windows-only and fail-open end-to-end: wrong platform, missing key, or
    any other failure yields an empty list, never an exception. Returns a
    list (0 or 1 entries today) so callers can treat it uniformly with
    other multi-signal root sources per PATH-DISCOVERY.md sec. 2 (multiple
    independent signals, de-duplicated) — shared by
    ``_registry_fortnite_project_candidates`` (rung 3, globs project dirs
    under it) and ``_editor_world_project_dir_candidate`` (the editor-world
    rung, which resolves a specific mount name under it)."""
    roots = []
    try:
        import winreg as _winreg
        with _winreg.OpenKey(
            _winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        ) as _key:
            _personal_raw, _ = _winreg.QueryValueEx(_key, "Personal")
        _personal = os.path.expandvars(_personal_raw)
        if _personal:
            roots.append(os.path.join(_personal, "Fortnite Projects"))
    except Exception:
        pass
    return roots


def _registry_fortnite_project_candidates():
    """Rung 3 of the discovery ladder: glob for "Fortnite Projects\\*" dirs
    under each root from ``_registry_fortnite_projects_roots``. Windows-only
    and fail-open end-to-end: wrong platform, missing key, or any other
    failure yields an empty list, never an exception. Returns a list of
    candidate project directories (existence not yet checked)."""
    candidates = []
    for _root in _registry_fortnite_projects_roots():
        try:
            for _proj_dir in glob.glob(os.path.join(_root, "*")):
                if not os.path.isdir(_proj_dir):
                    continue
                # Prefer the project's Content/ dir (what every other rung
                # returns) when present; otherwise fall back to the
                # project root itself so _has_verse's own depth-capped
                # walk still has a chance to find it.
                _proj_content = os.path.join(_proj_dir, "Content")
                if os.path.isdir(_proj_content):
                    candidates.append(_proj_content)
                else:
                    candidates.append(_proj_dir)
        except Exception:
            pass
    return candidates


def _unreal_project_dir_candidate():
    """A discovery-ladder candidate: ask the embedded ``unreal`` API for
    the live project's directory. MEASURED FINDING (live UEFN session,
    2026-08-19): every ``unreal.Paths`` function — ``project_dir``,
    ``project_content_dir``, ``project_config_dir``, ``project_plugins_dir``,
    and ``get_project_file_path`` — returns a path rooted at
    ``.../FortniteGame/...``, i.e. the ENGINE INSTALL, never the user's
    actual open project (StarWars, DetonationDemo, etc.). In UEFN "the
    project" from the engine's own perspective is always FortniteGame, so
    this rung is STRUCTURALLY INCAPABLE of naming the user's project — it
    is not a bug fixable in place, just a signal that doesn't exist here.
    Kept (rather than removed) because it's harmless, the caller already
    validates its result through ``_is_inside_fortnite_install`` /
    ``_looks_like_real_project`` like every other candidate, and it could
    become useful again if Epic ever changes what Paths reports — nobody
    should re-investigate this without cause. The real open-project signal
    is the editor world's package path — see
    ``_editor_world_project_dir_candidate``, which runs BEFORE this rung.
    Guarded end-to-end: any missing attribute, exception, or non-directory
    result yields None. Never raises."""
    try:
        paths_cls = getattr(unreal, "Paths", None)
        if paths_cls is None:
            return None
        for _method in ("project_content_dir", "project_dir"):
            _fn = getattr(paths_cls, _method, None)
            if _fn is None:
                continue
            try:
                _value = _fn()
            except Exception:
                continue
            if _value and os.path.isdir(_value):
                return os.path.normpath(_value)
    except Exception:
        pass
    return None


# Package-path mount points that name ENGINE content, never a user's UEFN
# project — the editor world's path always starts with one of these when
# no user project is actually open, or when Epic's own content is what's
# loaded. Rejected outright so the editor-world rung below can never
# resolve to an engine tree.
_ENGINE_WORLD_MOUNTS = frozenset({"Game", "Engine", "Temp", "Script", "FortniteGame"})


def _editor_world_mount_name():
    """Return the open UEFN project's package-path MOUNT POINT (e.g.
    ``"StarWars"``), or None. MEASURED FINDING (live UEFN session,
    2026-08-19): the editor world's package path — e.g.
    ``/StarWars/StarWars.StarWars`` when StarWars is the open project — is
    authoritative ground truth for which project is open, unlike
    ``unreal.Paths`` (see ``_unreal_project_dir_candidate``'s docstring),
    because the mount point is the project's own outer package namespace,
    not the engine's. Tries the modern editor subsystem API first, then
    falls back to the legacy ``EditorLevelLibrary``, since which one is
    available varies by UEFN/engine version. Every attribute access is
    guarded individually so a stub/partial ``unreal`` module (as used in
    tests, or an older API surface) degrades to None rather than raising.
    Rejects known-engine mounts (``_ENGINE_WORLD_MOUNTS``) since those name
    engine content, not a user project. Never raises."""
    world = None

    # Preferred: unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).
    try:
        get_subsystem = getattr(unreal, "get_editor_subsystem", None)
        subsystem_cls = getattr(unreal, "UnrealEditorSubsystem", None)
        if get_subsystem is not None and subsystem_cls is not None:
            subsystem = get_subsystem(subsystem_cls)
            get_world = getattr(subsystem, "get_editor_world", None)
            if get_world is not None:
                world = get_world()
    except Exception:
        world = None

    # Fallback: the legacy unreal.EditorLevelLibrary.get_editor_world().
    if world is None:
        try:
            level_lib = getattr(unreal, "EditorLevelLibrary", None)
            get_world = getattr(level_lib, "get_editor_world", None) if level_lib is not None else None
            if get_world is not None:
                world = get_world()
        except Exception:
            world = None

    if world is None:
        return None

    try:
        get_path_name = getattr(world, "get_path_name", None)
        if get_path_name is None:
            return None
        path_name = get_path_name()
        if not path_name:
            return None
        # e.g. "/StarWars/StarWars.StarWars" -> "StarWars"
        segment = path_name.lstrip("/").split("/", 1)[0]
        segment = segment.split(".", 1)[0]
        if not segment or segment in _ENGINE_WORLD_MOUNTS:
            return None
        return segment
    except Exception:
        return None


def _editor_world_project_dir_candidate():
    """The editor-world rung: resolve the open UEFN project's directory
    from the editor world's package-path mount point
    (``_editor_world_mount_name``) — the exact fix for the measured
    regression where StarWars was open but discovery returned
    DetonationDemo's dir because the registry rung (rung 3) picks by
    directory-listing order among several candidate projects. Per
    docs/PATH-DISCOVERY.md sec. 3 (content-based over name-based matching)
    this still isn't a bare name match: the mount name only becomes a
    result once ``<root>/<MountName>`` is confirmed to exist AND is run
    through the same ``_looks_like_real_project`` content check
    (.verse files + Content/__ExternalActors__) every other rung uses, and
    the caller re-validates it again like any other candidate. Does NOT
    assume a single hardcoded parent — it reuses the same candidate roots
    ``_registry_fortnite_project_candidates`` derives from the registry
    "Personal" shell-folder value (``_registry_fortnite_projects_roots``),
    since that is this module's only known way to enumerate "Fortnite
    Projects" parent directories today. Guarded end-to-end: any failure at
    any step (no world, no mount, no matching directory) yields None.
    Never raises."""
    try:
        mount = _editor_world_mount_name()
        if not mount:
            return None
        roots = _registry_fortnite_projects_roots()
        best = None
        for root in roots:
            candidate_root = os.path.join(root, mount)
            if not os.path.isdir(candidate_root):
                continue
            candidate_content = os.path.join(candidate_root, "Content")
            candidate = candidate_content if os.path.isdir(candidate_content) else candidate_root
            if best is None:
                best = candidate
            if _looks_like_real_project(candidate):
                return candidate
        return best
    except Exception:
        return None


def _find_verse_dir():
    """
    Locate the directory tree containing the USER'S UEFN project's .verse
    files — per the discovery ladder in docs/PATH-DISCOVERY.md (this
    function is that document's cited exemplar for this module):

    1. ``UEFN_VERSE_PROJECT_DIR`` env override — always wins. If set but
       does not resolve to a directory with .verse files, that is an
       explicit failure (reported in the final warning), never a silent
       fall-through to guessing.
    2. The OPEN project's directory, resolved from the editor world's
       package-path mount point (e.g. ``/StarWars/StarWars.StarWars`` ->
       ``StarWars``) — see ``_editor_world_project_dir_candidate``. This is
       the fix for the measured regression where StarWars was the open
       project but discovery returned DetonationDemo's Content dir,
       because with 8 candidate projects on disk, later rungs pick by
       directory-listing order, not by what's actually open. Engine mounts
       (``Game``, ``Engine``, ``Temp``, ``Script``, ``FortniteGame``) are
       rejected outright — see ``_ENGINE_WORLD_MOUNTS``.
    3. The live project path from ``unreal.Paths`` (project_content_dir /
       project_dir), validated — rejected if it lies inside a Fortnite
       engine install tree or doesn't look like a real project. MEASURED
       FINDING: in UEFN this always returns the FortniteGame ENGINE
       INSTALL, never the user's actual project — see
       ``_unreal_project_dir_candidate``'s docstring — so this rung exists
       only as a safety net, never as the primary signal.
    4. The Windows registry's "Personal" (Documents) known folder,
       expanded and globbed for "Fortnite Projects\\*" dirs. Windows-only,
       fails open on any other platform or if the key/module is missing.
    5. The original ``__file__``-relative strategies (Content/ parent,
       sibling Content dirs, Plugins/ walk-up) — KEPT, but every candidate
       they produce is now rejected if it sits inside a Fortnite/Epic
       engine install tree (structural check: a "FortniteGame" segment
       followed later by a "Plugins" segment — see
       ``_is_inside_fortnite_install``), so the engine copy can never again
       resolve to Plugins/VerseDevices/ScriptTemplates.

    Across every rung, when multiple candidates survive, the one that
    "looks like a real project" (.verse files AND a
    Content/__ExternalActors__ directory — content-based selection per
    docs/PATH-DISCOVERY.md sec. 3) is preferred over a bare .verse-only
    directory.

    Directories named Saved, Intermediate, __pycache__, or .uefn_bridge are
    skipped to avoid scanning large generated-file trees.

    Returns the directory path where .verse files were found, or None —
    and on total failure, logs a warning listing every location tried and
    naming UEFN_VERSE_PROJECT_DIR as the override (never returns a
    wrong-but-plausible directory).
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    tried = []

    def _record(label, path):
        tried.append(f"{label}={path}" if path else f"{label}=<not found>")

    # --- Rung 1: explicit env override — always wins ---
    env_dir = os.environ.get("UEFN_VERSE_PROJECT_DIR")
    if env_dir:
        _record("UEFN_VERSE_PROJECT_DIR", env_dir)
        if os.path.isdir(env_dir) and _has_verse(env_dir):
            return env_dir
        # Explicit-but-invalid override: fall through so the failure
        # warning below reports it, but do NOT silently keep guessing
        # past it as if it were unset — record it and continue collecting
        # candidates only so the final message is informative.

    candidates = []  # ordered list of (path, is_real_project) survivors

    def _consider(path):
        if not path:
            return
        norm = os.path.normpath(path)
        if _is_inside_fortnite_install(norm):
            return
        if not (os.path.isdir(norm) and _has_verse(norm)):
            return
        for existing, _ in candidates:
            if os.path.normcase(existing) == os.path.normcase(norm):
                return
        candidates.append((norm, _looks_like_real_project(norm)))

    # --- Rung 2: OPEN project dir from the editor world's mount point ---
    world_dir = _editor_world_project_dir_candidate()
    _record("editor world mount project dir", world_dir)
    if world_dir:
        _consider(world_dir)

    # --- Rung 3: live project path from unreal.Paths, validated ---
    unreal_dir = _unreal_project_dir_candidate()
    _record("unreal.Paths project dir", unreal_dir)
    if unreal_dir:
        _consider(unreal_dir)

    # --- Rung 4: registry-derived Documents\Fortnite Projects\* ---
    for reg_candidate in _registry_fortnite_project_candidates():
        _record("registry Fortnite Projects candidate", reg_candidate)
        _consider(reg_candidate)

    # --- Rung 5: original __file__-relative strategies, install-tree-safe ---

    # Strategy 1: Content/ parent (original).
    content_dir = os.path.dirname(script_dir)
    _record("Content/ parent of script dir", content_dir)
    if not _is_inside_fortnite_install(content_dir):
        _consider(content_dir)

    # Strategy 2: sibling Content dirs.
    parent_of_content = os.path.dirname(content_dir)
    if os.path.isdir(parent_of_content):
        try:
            for sibling in os.listdir(parent_of_content):
                sib_path = os.path.join(parent_of_content, sibling)
                if os.path.isdir(sib_path) and sibling not in _VERSE_SCAN_SKIP:
                    if not _is_inside_fortnite_install(sib_path):
                        _consider(sib_path)
        except Exception:
            pass

    # Strategy 3 & 4: walk up looking for a Plugins/ directory.
    cursor = script_dir
    for _ in range(10):  # cap the walk
        plugins_dir = os.path.join(cursor, "Plugins")
        if os.path.isdir(plugins_dir):
            try:
                for plugin_name in os.listdir(plugins_dir):
                    if plugin_name in _VERSE_SCAN_SKIP:
                        continue
                    plugin_content = os.path.join(plugins_dir, plugin_name, "Content")
                    if os.path.isdir(plugin_content) and not _is_inside_fortnite_install(plugin_content):
                        _record("Plugins/<plugin>/Content", plugin_content)
                        _consider(plugin_content)
            except Exception:
                pass
            # Also check the project root itself (one level above Plugins/).
            if not _is_inside_fortnite_install(cursor):
                _record("project root above Plugins/", cursor)
                _consider(cursor)
            break
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent

    if candidates:
        # Prefer a real-project-shaped candidate over a bare .verse dir;
        # otherwise keep first-found (rung/strategy) order.
        for path, is_real in candidates:
            if is_real:
                return path
        return candidates[0][0]

    unreal.log_warning(
        "device_audit: _find_verse_dir: no .verse files found in the "
        "user's project (searched: " + "; ".join(tried) + "). Set "
        "UEFN_VERSE_PROJECT_DIR to the project's Content directory to "
        "override discovery."
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

    # -- Per-device CDO override info, computed once up front so the
    # Devices table's "Tuned" column can show every row's count immediately
    # (not just the selected device) without re-running property diffing on
    # each click. Mirrors uefn_bridge.py's _handle_run_audit computation
    # (overridden_count / unknown_count / defaults_resolved), applied here
    # to the same devices_with_actors list this window already renders.
    # Any single device's diffing failure degrades only that device's row
    # ("?" / empty), never the whole window.
    _tuned_by_idx = []
    for _dev in devices_with_actors:
        _actor = _dev.get("actor")
        if _actor is None:
            _tuned_by_idx.append({
                "changed": {}, "overridden_count": 0, "unknown_count": 0,
                "defaults_resolved": False,
            })
            continue
        try:
            _changed = _find_overridden_properties(_actor, base_props)
        except Exception:
            _changed = {}
        _overridden_count = sum(1 for v in _changed.values() if v.get("overridden") is True)
        _unknown_count = sum(1 for v in _changed.values() if v.get("overridden") == "unknown")
        try:
            _defaults_resolved = _get_class_default_object(_actor.get_class()) is not None
        except Exception:
            _defaults_resolved = False
        _tuned_by_idx.append({
            "changed": _changed,
            "overridden_count": _overridden_count,
            "unknown_count": _unknown_count,
            "defaults_resolved": _defaults_resolved,
        })

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

    dev_all_columns = ("_idx", "#", "Label", "Class", "Tuned", "Location", "Layer")
    dev_display_columns = ("#", "Label", "Class", "Tuned", "Location", "Layer")
    dev_tree = ttk.Treeview(
        mid_frame, columns=dev_all_columns, displaycolumns=dev_display_columns,
        show="headings", height=12,
    )

    dev_numeric_cols = {"#", "Tuned"}

    dev_tree.heading("#", text="#", anchor=tk.CENTER,
                     command=lambda: _treeview_sort_column(dev_tree, "#", False, dev_numeric_cols))
    dev_tree.heading("Label", text="Label", anchor=tk.W,
                     command=lambda: _treeview_sort_column(dev_tree, "Label", False, dev_numeric_cols))
    dev_tree.heading("Class", text="Class", anchor=tk.W,
                     command=lambda: _treeview_sort_column(dev_tree, "Class", False, dev_numeric_cols))
    dev_tree.heading("Tuned", text="Tuned", anchor=tk.CENTER,
                     command=lambda: _treeview_sort_column(dev_tree, "Tuned", False, dev_numeric_cols))
    dev_tree.heading("Location", text="Location", anchor=tk.W,
                     command=lambda: _treeview_sort_column(dev_tree, "Location", False, dev_numeric_cols))
    dev_tree.heading("Layer", text="Layer", anchor=tk.CENTER,
                     command=lambda: _treeview_sort_column(dev_tree, "Layer", False, dev_numeric_cols))

    dev_tree.column("_idx", width=0, stretch=False)
    dev_tree.column("#", width=40, stretch=False, anchor=tk.CENTER)
    dev_tree.column("Label", width=260)
    dev_tree.column("Class", width=240)
    dev_tree.column("Tuned", width=60, stretch=False, anchor=tk.CENTER)
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
        _tuned = _tuned_by_idx[i - 1]
        # An unknown must never read as "untouched" — only show a real
        # count when defaults were actually resolvable for this device.
        tuned_display = str(_tuned["overridden_count"]) if _tuned["defaults_resolved"] else "?"
        iid = dev_tree.insert(
            "",
            tk.END,
            values=(i - 1, i, dev["label"], dev["class"], tuned_display, loc_str,
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
    detail_tree.tag_configure("tuned", foreground=_ACCENT)
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

        # 2b) Tuned Properties — CDO diffing: properties whose value differs
        # from (or couldn't be conclusively compared to) the class default.
        # Precomputed up front in _tuned_by_idx (see top of this function)
        # so this handler never re-runs property diffing on selection.
        tuned = _tuned_by_idx[idx] if 0 <= idx < len(_tuned_by_idx) else None
        if tuned is not None:
            tp_node = _section("Tuned Properties")
            if not tuned["defaults_resolved"]:
                reason = None
                for _v in tuned["changed"].values():
                    _r = _v.get("default_unavailable_reason")
                    if _r:
                        reason = _r
                        break
                if not reason:
                    reason = (
                        "Class-default-object unavailable in this UEFN "
                        "build — property comparisons could not be "
                        "performed for this device's class."
                    )
                detail_tree.insert(
                    tp_node, tk.END, text="Defaults unavailable",
                    values=(reason, ""), tags=("info",),
                )
                row_count += 1
            elif not tuned["changed"]:
                detail_tree.insert(
                    tp_node, tk.END, text="No overrides",
                    values=("No properties differ from class defaults.", ""),
                    tags=("info",),
                )
                row_count += 1
            else:
                for prop_name, entry in sorted(tuned["changed"].items()):
                    if entry.get("overridden") is False:
                        continue  # equal props are already omitted upstream
                    current_val = entry.get("actor_value", "")
                    if entry.get("overridden") == "unknown":
                        default_val = "?"
                    else:
                        default_val = entry.get("default_value")
                        if default_val is None:
                            default_val = "?"
                    detail_tree.insert(
                        tp_node, tk.END, text=prop_name,
                        values=(current_val, default_val), tags=("tuned",),
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
