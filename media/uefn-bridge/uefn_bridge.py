"""
UEFN Bridge — File-based IPC for MCP Server
=============================================
Runs inside UEFN's embedded Python 3.11. Provides file-based IPC so an
external MCP server can send commands and receive responses.

Polls a ``command.json`` file for incoming requests, executes them using
the ``unreal`` API, and writes results to ``response_{id}.json``.  Also
emits a ``heartbeat.json`` every ~5 seconds, which carries a per-session
token that command.json must echo back (cheap partial isolation against a
stale/unrelated MCP server writing into a shared temp dir — not full auth;
see the ``_bridge_token`` comment below).

IPC directory: ``.uefn_bridge/`` (next to this script)

Usage:
    import importlib, uefn_bridge; importlib.reload(uefn_bridge)
"""

import sys as _sys
_old_module = _sys.modules.get(__name__)
_old_tick_handle = getattr(_old_module, '_tick_handle', None) if _old_module is not None else None
del _sys

import unreal
import json
import os
import datetime
import traceback
import time
import secrets
import contextlib

# sys.path self-consistency shield: guarantee every sibling import below
# (device_audit, batch_tools, texture_finder, ...) resolves from THIS
# file's own directory, never a differently-versioned copy that happens to
# sit earlier on sys.path (e.g. an engine-side FortniteGame/Content/Python
# shadowing a project copy, or vice versa). Mixed-version sibling imports
# have crashed the bridge in the field: a stale bridge here paired with a
# newer device_audit.py (or the reverse) resolving from elsewhere is
# exactly what took the whole bridge down with no IPC, no heartbeat, and no
# Power Tools popup. Idempotent (removes any existing entry before
# reinserting at index 0, so re-running/re-importing this module never
# duplicates the path) and wrapped so it can never break module import.
try:
    import os as _shield_os
    import sys as _shield_sys
    _bridge_own_dir = _shield_os.path.dirname(_shield_os.path.abspath(__file__))
    if _bridge_own_dir in _shield_sys.path:
        _shield_sys.path.remove(_bridge_own_dir)
    _shield_sys.path.insert(0, _bridge_own_dir)
    del _shield_os, _shield_sys, _bridge_own_dir
except Exception:
    pass

# Reuse device_audit helpers — do NOT duplicate that logic.
#
# Resolved via getattr() rather than `from device_audit import (...)`: a
# version-skewed staging (e.g. a stale engine-side copy of device_audit.py
# shadowing a newer project copy on sys.path, or vice versa) can be missing
# a symbol this file expects. A plain from-import dies at MODULE IMPORT
# TIME on the FIRST missing name — which is exactly what happened in the
# field: one missing helper in a stale device_audit.py took down the ENTIRE
# bridge (no IPC, no heartbeat, no Power Tools popup). Resolving per-symbol
# instead means a missing helper disables only the handler(s) that actually
# need it — see _require_device_audit_symbols() and its call sites in
# _find_actor_by_label, _handle_list_devices, and _handle_run_audit below.
import device_audit

# Each helper resolved individually (not via globals()[name] = ...) so every
# name below is a real, statically-visible module-level assignment — plain
# and IDE/linter-friendly, at the cost of one explicit line per helper.
_is_device = getattr(device_audit, "_is_device", None)
_safe_label = getattr(device_audit, "_safe_label", None)
_actor_location_tuple = getattr(device_audit, "_actor_location_tuple", None)
_xyz_to_luf = getattr(device_audit, "_xyz_to_luf", None)
_find_overridden_properties = getattr(device_audit, "_find_overridden_properties", None)
_build_base_property_set = getattr(device_audit, "_build_base_property_set", None)
_get_property_names = getattr(device_audit, "_get_property_names", None)

# Optional — deliberately NOT added to _DEVICE_AUDIT_MISSING/the required-
# symbols list below. A device_audit.py old enough to lack CDO diffing
# still has every OTHER helper (this is additive, not a breaking rename),
# so run_audit must keep working via _find_overridden_properties' own
# no-CDO fallback rather than being gated on this one extra symbol.
_get_class_default_object = getattr(device_audit, "_get_class_default_object", None)

# Names not found on the resolved device_audit module — consulted by
# _require_device_audit_symbols() at handler call time.
_DEVICE_AUDIT_MISSING = [
    _name
    for _name, _value in (
        ("_is_device", _is_device),
        ("_safe_label", _safe_label),
        ("_actor_location_tuple", _actor_location_tuple),
        ("_xyz_to_luf", _xyz_to_luf),
        ("_find_overridden_properties", _find_overridden_properties),
        ("_build_base_property_set", _build_base_property_set),
        ("_get_property_names", _get_property_names),
    )
    if _value is None
]

if _DEVICE_AUDIT_MISSING:
    # ONE clear warning at startup naming every missing symbol and the
    # resolved module path — that path is the smoking gun for diagnosing a
    # shadowed/stale copy (see init_unreal.py's self-sync for why more than
    # one copy of these files can exist on a machine).
    try:
        unreal.log_warning(
            "uefn_bridge: device_audit (resolved from "
            + str(getattr(device_audit, "__file__", "<unknown path>"))
            + ") is missing helper(s): " + ", ".join(_DEVICE_AUDIT_MISSING)
            + ". This usually means a version-skewed/stale copy is shadowing "
            "the current one on sys.path. Tool(s) that depend on the missing "
            "helper(s) will return an explicit error naming them instead of "
            "silently degrading; the rest of the bridge (status, heartbeat, "
            "get_property/set_property/select_actor when unaffected, and "
            "every non-device-audit tool) is unaffected."
        )
    except Exception:
        pass


def _require_device_audit_symbols(*names):
    """Return ``None`` if every name in *names* resolved to a real
    device_audit helper; otherwise return an explicit error string naming
    the missing symbol(s) and the resolved device_audit module path.

    Call this at the TOP of any handler that uses a device_audit helper,
    before doing any work, and raise/return based on its result rather than
    let a missing helper (``None``) get called and its resulting TypeError
    silently swallowed by a broad ``except Exception`` lower in the handler
    — which would otherwise turn "helper missing" into a falsely-empty-but-
    "successful" result. This repo has a standing rule against exactly that
    failure shape.
    """
    missing = [name for name in names if name in _DEVICE_AUDIT_MISSING]
    if not missing:
        return None
    return (
        "device_audit (resolved from "
        + str(getattr(device_audit, "__file__", "<unknown path>"))
        + ") is missing required helper(s): " + ", ".join(missing)
    )


try:
    from batch_tools import batch_set_property, batch_get_property
except ImportError as _bt_exc:
    # batch_tools.py does its OWN hard `from device_audit import _is_device,
    # _safe_label` at module scope — the identical version-skew exposure
    # this file just hardened against, one layer deeper. If either symbol
    # is missing from the resolved device_audit, that import raises here
    # and would otherwise crash this entire module's import (the field
    # failure this whole change exists to prevent — see the device_audit
    # block above). Degrade only the two tools that need it instead.
    unreal.log_warning(
        f"uefn_bridge: batch_tools unavailable ({_bt_exc}) — most likely the "
        "same device_audit version skew described above. batch_set/"
        "batch_get will return an explicit error naming this; the rest of "
        "the bridge is unaffected."
    )
    batch_set_property = None
    batch_get_property = None
from texture_finder import find_texture_usage, find_texture_summary, list_textures_on_actor
from material_browser import browse_materials, find_unused_materials
from niagara_inspector import browse_niagara, find_niagara_usage
from dependency_viewer import scan_dependencies
from health_scanner import scan_health
from moderation_scanner import run_moderation_scan
try:
    from asset_sweep import sweep_dead_assets
except ImportError:
    # Defensive: asset_sweep ships with this bridge, but if it (or its
    # asset_usage dependency) ever fails to import, degrade the
    # uefn_asset_sweep MCP tool to an explicit "unavailable" response
    # rather than crashing the whole bridge on import.
    sweep_dead_assets = None


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_POLL_INTERVAL = 0.5       # seconds between command.json checks
_HEARTBEAT_INTERVAL = 5.0  # seconds between heartbeat writes

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_tick_handle = None        # slate tick callback handle
_bridge_dir = None         # resolved IPC directory path
_last_poll_time = 0.0      # monotonic time of last command poll
_last_heartbeat_time = 0.0 # monotonic time of last heartbeat write

# Session token — a cheap partial mitigation against a stale/unrelated MCP
# server (e.g. from a previous session, or another user on a shared temp
# dir) sending commands into this bridge instance. NOT full auth: the temp
# dir is still world-readable on shared machines, so this only rejects
# *unintentional* cross-session command delivery, not a determined local
# attacker. Regenerated every start_bridge() call and published via
# heartbeat.json so the MCP server can pick it up before its first command.
_bridge_token = None
_warned_bad_token = False  # log a rejected-command warning once, not per-poll


# ---------------------------------------------------------------------------
# IPC directory setup
# ---------------------------------------------------------------------------

# Centralized in bridge_paths.py (side-effect-free — see its module
# docstring for why property_inspector.py and moderation_scanner.py used to
# reimplement this derivation locally instead of importing THIS module:
# uefn_bridge.py auto-starts the bridge's tick/poll loop on import, so
# importing it just to reuse one function would start a second bridge
# instance). ImportError-guarded: an old engine-side sibling set missing
# bridge_paths.py (version skew — see the sys.path shield comment above)
# falls back to the literal derivation this replaced, unchanged.
try:
    import bridge_paths as _bridge_paths
except ImportError:
    _bridge_paths = None

# IPC filenames — sourced from bridge_paths when available so this module
# and every sibling agree on one literal; falls back to the same literals
# this always used when bridge_paths isn't importable (see above).
if _bridge_paths is not None:
    _HEARTBEAT_FILENAME = _bridge_paths.HEARTBEAT_FILENAME
    _COMMAND_FILENAME = _bridge_paths.COMMAND_FILENAME
    _RESPONSE_PREFIX = _bridge_paths.RESPONSE_PREFIX
else:
    _HEARTBEAT_FILENAME = "heartbeat.json"
    _COMMAND_FILENAME = "command.json"
    _RESPONSE_PREFIX = "response_"


def _get_bridge_dir():
    """Return the bridge IPC directory, creating it if necessary.

    Honors the ``UEFN_BRIDGE_DIR`` environment variable so this in-editor
    bridge and the MCP wrapper can agree on a custom location; otherwise falls
    back to ``<temp>/uefn_bridge``. The temp default is machine-agnostic: both
    sides resolve the same per-machine temp path independently, so no
    configuration is needed for the common case. To use a custom dir, set
    UEFN_BRIDGE_DIR for BOTH the UEFN process and the MCP wrapper.
    """
    if _bridge_paths is not None:
        return _bridge_paths.bridge_ipc_dir(create=True)
    import tempfile
    bridge_dir = os.environ.get("UEFN_BRIDGE_DIR") or os.path.join(
        tempfile.gettempdir(), "uefn_bridge"
    )
    os.makedirs(bridge_dir, exist_ok=True)
    return bridge_dir


# ---------------------------------------------------------------------------
# Atomic file writing
# ---------------------------------------------------------------------------

def _write_json(filepath, data):
    """Write *data* as JSON to *filepath* atomically via a .tmp rename."""
    tmp_path = filepath + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, filepath)
    except Exception:
        unreal.log_warning(
            "uefn_bridge: Failed to write " + filepath + "\n"
            + traceback.format_exc()
        )
        # Clean up temp file if rename failed
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _read_json(filepath):
    """Read and parse a JSON file.  Returns None on any failure."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json_checked(filepath, data):
    """Write *data* as JSON to *filepath* atomically, and VERIFY it landed.

    Unlike ``_write_json`` (used for best-effort IPC responses/heartbeats,
    where swallow-and-continue is the deliberate behaviour), this helper is
    for callers where a swallowed failure that still reports success would
    be worse than raising — e.g. the moderation report save path, which has
    silently "succeeded" while writing nothing at least once before.

    Returns ``(True, None)`` only after the file has been re-read back as
    valid JSON. Returns ``(False, "<error>")`` on any failure. Never raises.
    """
    tmp_path = filepath + ".tmp"
    try:
        dirpath = os.path.dirname(filepath)
        if dirpath:
            os.makedirs(dirpath, exist_ok=True)
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, filepath)
    except Exception as e:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return False, "{}: {}".format(type(e).__name__, e)

    if not os.path.exists(filepath):
        return False, "write reported success but file does not exist afterward"
    verify = _read_json(filepath)
    if verify is None:
        return False, "write reported success but file did not re-read as valid JSON"
    return True, None


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------

def _write_heartbeat():
    """Write heartbeat.json with current status."""
    global _bridge_dir, _bridge_token
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actor_count = len(subsystem.get_all_level_actors()) if subsystem else 0
    except Exception:
        actor_count = 0

    try:
        level_name = unreal.EditorLevelLibrary.get_editor_world().get_name()
    except Exception:
        level_name = "<unknown>"

    heartbeat = {
        "status": "running",
        "timestamp": datetime.datetime.now().isoformat(),
        "level_name": level_name,
        "actor_count": actor_count,
        # Session token — see _bridge_token comment. Absent on older bridge
        # builds; the MCP server treats a missing field as "no token support"
        # and falls back to tokenless commands.
        "token": _bridge_token,
    }
    _write_json(os.path.join(_bridge_dir, _HEARTBEAT_FILENAME), heartbeat)


# ---------------------------------------------------------------------------
# Command dispatch
# ---------------------------------------------------------------------------

def _get_subsystem():
    """Get EditorActorSubsystem or raise."""
    subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    if subsystem is None:
        raise RuntimeError("Could not get EditorActorSubsystem")
    return subsystem


def _get_all_actors():
    """Return all level actors via EditorActorSubsystem."""
    return _get_subsystem().get_all_level_actors()


def _find_actor_by_label(label):
    """Find an actor by its display label.  Raises if not found."""
    missing = _require_device_audit_symbols("_safe_label")
    if missing:
        raise RuntimeError("find_actor_by_label unavailable: " + missing)
    actors = _get_all_actors()
    for actor in actors:
        if _safe_label(actor) == label:
            return actor
    raise ValueError("Actor not found with label: " + str(label))


# --- Method handlers ---

def _handle_status(params):
    """Return bridge and level status."""
    try:
        level_name = unreal.EditorLevelLibrary.get_editor_world().get_name()
    except Exception:
        level_name = "<unknown>"

    try:
        actors = _get_all_actors()
        actor_count = len(actors)
    except Exception as e:
        unreal.log_warning(f"uefn_bridge: status: could not get actors: {e}")
        actor_count = -1
    return {
        "status": "running",
        "level_name": level_name,
        "actor_count": actor_count,
    }


def _handle_list_devices(params):
    """List all Creative devices in the level (reuses device_audit logic)."""
    missing = _require_device_audit_symbols(
        "_is_device", "_safe_label", "_actor_location_tuple",
        "_xyz_to_luf", "_find_overridden_properties", "_build_base_property_set",
    )
    if missing:
        raise RuntimeError("list_devices unavailable: " + missing)
    try:
        all_actors = _get_all_actors()
    except Exception as e:
        raise RuntimeError(f"list_devices: could not get level actors: {e}") from e
    try:
        base_props = _build_base_property_set(all_actors)
    except Exception as e:
        unreal.log_warning(f"uefn_bridge: list_devices: _build_base_property_set raised: {e} — continuing without base props")
        base_props = frozenset()

    devices = []
    for actor in all_actors:
        try:
            if not _is_device(actor):
                continue
            label = _safe_label(actor)
            loc = _actor_location_tuple(actor)
            luf = _xyz_to_luf(*loc)
            changed = _find_overridden_properties(actor, base_props)
            devices.append({
                "label": label,
                "class": actor.get_class().get_name(),
                # Traditional XYZ — unchanged, byte-identical to before this
                # field existed. Use with /UnrealEngine.com and
                # /Fortnite.com module transforms.
                "location": {"x": loc[0], "y": loc[1], "z": loc[2]},
                # UEFN 36.00+ Left-Up-Forward — matches the editor Details
                # panel and /Verse.org module transforms. See
                # device_audit._xyz_to_luf's docstring for the source.
                "location_luf": {"left": luf[0], "up": luf[1], "forward": luf[2]},
                "changed_property_count": len(changed),
                "changed_properties": changed,
            })
        except Exception:
            continue

    return {
        "devices": devices,
        "total_devices": len(devices),
        "total_actors": len(all_actors),
    }


def _handle_get_property(params):
    """Get a single property value from an actor."""
    actor_label = params.get("actor_label")
    property_name = params.get("property_name")
    if not actor_label or not property_name:
        raise ValueError("Missing required params: actor_label, property_name")

    actor = _find_actor_by_label(actor_label)
    try:
        value = actor.get_editor_property(property_name)
    except Exception as e:
        raise ValueError(
            f"Failed to read property '{property_name}' on '{actor_label}': {e}"
        ) from e

    try:
        is_overridden = actor.is_editor_property_overridden(property_name)
    except Exception:
        is_overridden = None

    return {
        "value": str(value),
        "is_overridden": is_overridden,
    }


def _handle_set_property(params):
    """Set a property on an actor, with type coercion from JSON string."""
    actor_label = params.get("actor_label")
    property_name = params.get("property_name")
    new_value = params.get("value")
    if not actor_label or not property_name:
        raise ValueError("Missing required params: actor_label, property_name")
    if new_value is None:
        raise ValueError("Missing required param: value")

    actor = _find_actor_by_label(actor_label)

    # Detect the current property type and coerce the incoming value
    try:
        current = actor.get_editor_property(property_name)
    except Exception:
        # Property may not exist yet or be write-only; try setting as-is
        current = None

    coerced = _coerce_value(new_value, current)
    actor.set_editor_property(property_name, coerced)

    return {"success": True}


def _coerce_value(new_value, current_value):
    """
    Coerce *new_value* (which may be a string from JSON) to match the type
    of *current_value*.  If *current_value* is None, return *new_value* as-is.
    """
    if current_value is None:
        return new_value

    target_type = type(current_value)

    # If the new value is already the correct type, return it directly
    if isinstance(new_value, target_type):
        return new_value

    # Boolean — handle string "true"/"false" and numeric 0/1
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


def _handle_select_actor(params):
    """Select an actor in the UEFN viewport by label."""
    actor_label = params.get("actor_label")
    if not actor_label:
        raise ValueError("Missing required param: actor_label")

    actor = _find_actor_by_label(actor_label)
    subsystem = _get_subsystem()
    try:
        subsystem.select_nothing()
        subsystem.set_actor_selection_state(actor, True)
    except Exception as e:
        raise RuntimeError(
            f"Editor selection failed for '{actor_label}': {e}"
        ) from e

    return {"selected": True}


def _handle_run_audit(params):
    """Run the full device audit and return the report as JSON."""
    missing = _require_device_audit_symbols(
        "_is_device", "_safe_label", "_actor_location_tuple",
        "_xyz_to_luf", "_find_overridden_properties", "_build_base_property_set",
    )
    if missing:
        raise RuntimeError("run_audit unavailable: " + missing)

    try:
        all_actors = _get_all_actors()
    except Exception as e:
        raise RuntimeError(f"run_audit: could not get level actors: {e}") from e
    total = len(all_actors)
    try:
        base_props = _build_base_property_set(all_actors)
    except Exception as e:
        unreal.log_warning(f"uefn_bridge: run_audit: _build_base_property_set raised: {e} — continuing without base props")
        base_props = frozenset()

    devices = []
    non_device_counts = {}

    for actor in all_actors:
        try:
            class_name = actor.get_class().get_name()
            if _is_device(actor):
                label = _safe_label(actor)
                loc = _actor_location_tuple(actor)
                luf = _xyz_to_luf(*loc)
                changed = _find_overridden_properties(actor, base_props)
                # Per-property "overridden" is True / False / "unknown" (see
                # device_audit._find_overridden_properties). Tally here so
                # callers can spot hand-tuned devices without walking every
                # property themselves.
                overridden_count = sum(
                    1 for v in changed.values() if v.get("overridden") is True
                )
                unknown_count = sum(
                    1 for v in changed.values() if v.get("overridden") == "unknown"
                )
                # Resolved independently of _find_overridden_properties'
                # internal CDO lookup (which is per-class-cached, so this is
                # a cheap cache hit, not a second real resolution) because a
                # fully-stock device has an EMPTY changed dict — there would
                # be no property entry left to infer this from otherwise.
                if _get_class_default_object is not None:
                    try:
                        defaults_resolved = _get_class_default_object(actor.get_class()) is not None
                    except Exception:
                        defaults_resolved = False
                else:
                    defaults_resolved = False
                devices.append({
                    "label": label,
                    "class": class_name,
                    # Traditional XYZ — unchanged, byte-identical to before
                    # this field existed. Use with /UnrealEngine.com and
                    # /Fortnite.com module transforms.
                    "location": {"x": loc[0], "y": loc[1], "z": loc[2]},
                    # UEFN 36.00+ Left-Up-Forward — matches the editor
                    # Details panel and /Verse.org module transforms. See
                    # device_audit._xyz_to_luf's docstring for the source.
                    "location_luf": {"left": luf[0], "up": luf[1], "forward": luf[2]},
                    "changed_property_count": len(changed),
                    "changed_properties": changed,
                    "overridden_count": overridden_count,
                    "unknown_count": unknown_count,
                    "defaults_resolved": defaults_resolved,
                })
            else:
                non_device_counts[class_name] = non_device_counts.get(class_name, 0) + 1
        except Exception:
            continue

    report = {
        "audit_timestamp": datetime.datetime.now().isoformat(),
        "total_actors": total,
        "total_devices": len(devices),
        "total_non_devices": total - len(devices),
        "devices": devices,
        "non_device_summary": [
            {"class": cls, "count": cnt}
            for cls, cnt in sorted(non_device_counts.items(), key=lambda kv: -kv[1])
        ],
    }
    return report


def _handle_get_level_info(params):
    """Return level metadata: name, actor count, device count, non-device breakdown."""
    try:
        all_actors = _get_all_actors()
    except Exception as e:
        raise RuntimeError(f"get_level_info: could not get level actors: {e}") from e
    device_count = 0
    non_device_counts = {}

    for actor in all_actors:
        try:
            if _is_device(actor):
                device_count += 1
            else:
                class_name = actor.get_class().get_name()
                non_device_counts[class_name] = non_device_counts.get(class_name, 0) + 1
        except Exception:
            continue

    try:
        level_name = unreal.EditorLevelLibrary.get_editor_world().get_name()
    except Exception:
        level_name = "<unknown>"

    return {
        "level_name": level_name,
        "total_actors": len(all_actors),
        "device_count": device_count,
        "non_device_classes": [
            {"class": cls, "count": cnt}
            for cls, cnt in sorted(non_device_counts.items(), key=lambda kv: -kv[1])
        ],
    }


def _handle_batch_set(params):
    """Batch set a property on multiple actors."""
    if batch_set_property is None:
        raise RuntimeError(
            "batch_set unavailable: batch_tools failed to import, most likely "
            "the same device_audit version skew reported at startup"
        )
    filter_type = params.get("filter_type", "all_devices")
    filter_value = params.get("filter_value", "")
    property_name = params.get("property_name")
    value = params.get("value")
    dry_run = params.get("dry_run", False)
    if not property_name:
        raise ValueError("Missing required param: property_name")
    if value is None:
        raise ValueError("Missing required param: value")
    return batch_set_property(filter_type, filter_value, property_name, value, dry_run=dry_run)


def _handle_batch_get(params):
    """Batch read a property from multiple actors."""
    if batch_get_property is None:
        raise RuntimeError(
            "batch_get unavailable: batch_tools failed to import, most likely "
            "the same device_audit version skew reported at startup"
        )
    filter_type = params.get("filter_type", "all_devices")
    filter_value = params.get("filter_value", "")
    property_name = params.get("property_name")
    if not property_name:
        raise ValueError("Missing required param: property_name")
    return batch_get_property(filter_type, filter_value, property_name)


def _handle_texture_find(params):
    texture_name = params.get("texture_name")
    if not texture_name:
        raise ValueError("Missing required param: texture_name")
    match_mode = params.get("match_mode", "substring")
    project_only = params.get("project_only", True)
    return find_texture_usage(texture_name, match_mode=match_mode, project_only=project_only)

def _handle_texture_summary(params):
    texture_name = params.get("texture_name")
    if not texture_name:
        raise ValueError("Missing required param: texture_name")
    match_mode = params.get("match_mode", "substring")
    project_only = params.get("project_only", True)
    return find_texture_summary(texture_name, match_mode=match_mode, project_only=project_only)

def _handle_texture_on_actor(params):
    actor_label = params.get("actor_label")
    if not actor_label:
        raise ValueError("Missing required param: actor_label")
    return list_textures_on_actor(actor_label)


def _handle_material_browse(params):
    project_only = params.get("project_only", True)
    return browse_materials(project_only=project_only)

def _handle_material_unused(params):
    project_only = params.get("project_only", True)
    return find_unused_materials(project_only=project_only)


def _handle_niagara_browse(params):
    project_only = params.get("project_only", True)
    return browse_niagara(project_only=project_only)

def _handle_niagara_usage(params):
    return find_niagara_usage()

def _handle_dependency_scan(params):
    project_only = params.get("project_only", True)
    return scan_dependencies(project_only=project_only)


def _handle_health_scan(params):
    return scan_health()


# Default per-list cap applied ONLY on the MCP path (see
# _handle_moderation_scan below). A full registry sweep on a large project
# (e.g. 1.2M+ assets) serializes to tens of MB, which drops the bridge's
# stdio connection before the response is fully written — this bounds the
# transported payload while keeping every top-level count exact/uncapped.
# The in-process launcher path (moderation_scanner.show_moderation_scan)
# calls run_moderation_scan() directly with max_items=None and is
# unaffected.
_MODERATION_SCAN_DEFAULT_MAX_ITEMS = 200


def _handle_moderation_scan(params):
    max_items = params.get("max_items", _MODERATION_SCAN_DEFAULT_MAX_ITEMS)
    if max_items is not None:
        try:
            max_items = int(max_items)
        except (TypeError, ValueError):
            max_items = _MODERATION_SCAN_DEFAULT_MAX_ITEMS
    return run_moderation_scan(
        params.get("project_dir"),
        include_hashes=bool(params.get("include_hashes", False)),
        max_items=max_items,
    )


# Cap on stored report text so a runaway/malicious payload can't bloat
# moderation_report.json without bound. Well above any realistic analysed
# report length.
_MODERATION_REPORT_MAX_CHARS = 200000

# Mirrored in uefn-server.ts's `moderation_report_save` inputSchema
# (severity_counts: {BLOCKER, WARN, KNOWN_RISK, INFO}) — keep both in sync;
# a drift-guard test pins them (added separately from this change).
_SEVERITY_KEYS = ("BLOCKER", "WARN", "KNOWN_RISK", "INFO")


def _moderation_report_path():
    """Path to moderation_report.json, next to this script (uefn_bridge.py)."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "moderation_report.json")


def _coerce_severity_counts(raw):
    """Best-effort coercion of a client-supplied severity_counts dict.

    Never raises: unknown/missing/non-numeric entries default to 0, and
    unexpected shapes (non-dict) collapse to the all-zero default.
    """
    counts = {key: 0 for key in _SEVERITY_KEYS}
    if not isinstance(raw, dict):
        return counts
    for key in _SEVERITY_KEYS:
        value = raw.get(key)
        try:
            counts[key] = int(value)
        except (TypeError, ValueError):
            counts[key] = 0
    return counts


def _read_moderation_report():
    """Underlying read primitive for moderation_report.json.

    Checks both the primary (next to this script) and fallback (bridge IPC
    temp dir) locations written by ``_handle_moderation_report_save`` and
    returns whichever exists with the newest mtime, parsed as JSON. Shared
    by ``_handle_moderation_report_read`` (the read tool exposed to callers)
    and by ``_handle_moderation_report_save``, which reads back through this
    same primitive to verify its own write — see the save handler for why.

    Returns ``(data, error)``: ``data`` is the parsed report dict, or
    ``None`` if nothing could be read. ``error`` is ``None`` when neither
    location exists at all (a legitimate "nothing saved yet"), or a
    human-readable reason when a file exists but could not be parsed.
    """
    candidates = []
    for path in (_moderation_report_path(), os.path.join(_get_bridge_dir(), "moderation_report.json")):
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        candidates.append((mtime, path))

    if not candidates:
        return None, None

    candidates.sort(key=lambda pair: pair[0], reverse=True)

    last_error = None
    for _mtime, path in candidates:
        data = _read_json(path)
        if data is not None:
            return data, None
        last_error = "{} exists but could not be parsed".format(path)

    return None, last_error or "moderation_report.json exists but could not be parsed"


def _handle_moderation_report_save(params):
    """Save the connected LLM's finished moderation-analysis report.

    Writes moderation_report.json to TWO locations: next to this script
    (primary — where the UEFN launcher normally reads it from) and under
    the bridge IPC temp dir from ``_get_bridge_dir()`` (fallback — always
    writable by this process, unlike the primary location, which can sit
    under a permission-protected engine-install path that ``init_unreal.py``
    self-syncs these scripts into). Both writes are verified by re-reading
    the file back as JSON; a swallowed exception must never be reported as
    a successful save here — that previously left creators staring at "No
    analysed report yet" with zero error surfaced anywhere but the Unreal
    log. Defensive by design: never raises — a malformed request from the
    MCP side should never take down the bridge or the tick loop — but
    ``saved`` now reflects an actually-verified write, not just the absence
    of an exception.

    Self-verifying choke point: after writing, this handler reads the report
    back through the SAME primitive (``_read_moderation_report``) that the
    read tool uses and checks the content round-tripped, so every caller —
    our MCP server, other MCP clients (e.g. Codex against the standalone
    Power Tools), future callers — gets a save that is proven, not merely
    attempted, before success is reported.
    """
    try:
        report = params.get("report")
        if not isinstance(report, str) or not report.strip():
            return {"saved": False, "error": "Missing or empty required param: report"}

        truncated = False
        if len(report) > _MODERATION_REPORT_MAX_CHARS:
            report = report[:_MODERATION_REPORT_MAX_CHARS]
            truncated = True
            report += "\n\n[...truncated: report exceeded {} characters...]".format(
                _MODERATION_REPORT_MAX_CHARS
            )

        summary = params.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            summary = "(no summary provided)"
        summary = summary.strip()
        if len(summary) > 500:
            summary = summary[:500] + "..."

        severity_counts = _coerce_severity_counts(params.get("severity_counts"))

        generated_at = time.strftime("%Y-%m-%d %H:%M:%S")

        payload = {
            "generated_at": generated_at,
            "summary": summary,
            "severity_counts": severity_counts,
            "report": report,
        }
        if truncated:
            payload["truncated"] = True

        primary_path = _moderation_report_path()
        fallback_path = os.path.join(_get_bridge_dir(), "moderation_report.json")

        paths_written = []
        paths_failed = []
        seen = set()
        for candidate in (primary_path, fallback_path):
            if candidate in seen:
                continue
            seen.add(candidate)
            ok, error = _write_json_checked(candidate, payload)
            if ok:
                paths_written.append(candidate)
            else:
                paths_failed.append({"path": candidate, "error": error})

        saved = len(paths_written) > 0

        if not saved:
            unreal.log_warning(
                "uefn_bridge: moderation_report_save failed at ALL locations:\n"
                + "\n".join(
                    "{}: {}".format(f["path"], f["error"]) for f in paths_failed
                )
            )
        elif paths_failed:
            # Partial failure: at least one location is verified good, so the
            # creator's report is not lost, but log the failed location so a
            # broken primary path doesn't go unnoticed forever.
            unreal.log_warning(
                "uefn_bridge: moderation_report_save partially failed:\n"
                + "\n".join(
                    "{}: {}".format(f["path"], f["error"]) for f in paths_failed
                )
            )

        # Round-trip verification: re-read what was just written through the
        # same primitive the read tool uses, and confirm the content actually
        # matches (not just "some file exists somewhere"). A save that wrote
        # bytes but can't be read back correctly is not a save — surface it
        # loudly rather than claiming success.
        if saved:
            read_back, read_error = _read_moderation_report()
            verify_error = None
            if read_back is None:
                verify_error = "round-trip read-back failed: {}".format(
                    read_error or "file missing"
                )
            else:
                read_back_report = read_back.get("report")
                mismatch = read_back.get("generated_at") != generated_at or (
                    len(read_back_report) if isinstance(read_back_report, str) else -1
                ) != len(report)
                if mismatch:
                    verify_error = (
                        "round-trip read-back content mismatch (expected "
                        "generated_at={!r} report_len={}, got generated_at={!r} "
                        "report_len={})".format(
                            generated_at,
                            len(report),
                            read_back.get("generated_at"),
                            len(read_back_report) if isinstance(read_back_report, str) else None,
                        )
                    )

            if verify_error is not None:
                # Distinct from the "failed at ALL locations" / "partially
                # failed" warnings above: the write(s) to paths_written
                # actually succeeded here, verification is what disagreed.
                # Log and report that distinction explicitly — a bare
                # "failed" would be indistinguishable from a total write
                # failure and would mislead a diagnosing caller.
                unreal.log_warning(
                    "uefn_bridge: moderation_report_save wrote to {} but "
                    "FAILED round-trip verification: {}".format(
                        ", ".join(paths_written), verify_error
                    )
                )
                # saved/verified are False (the save is not trustworthy) but
                # paths_written stays truthful to what's actually on disk —
                # the write happened, only verification disagreed, and
                # hiding that from the caller would misdescribe disk state.
                return {
                    "saved": False,
                    "verified": False,
                    "paths_written": paths_written,
                    "paths_failed": paths_failed,
                    "generated_at": generated_at,
                    "error": "moderation_report_save: wrote to {} but {}".format(
                        ", ".join(paths_written), verify_error
                    ),
                }

        return {
            "saved": saved,
            "verified": saved,
            "paths_written": paths_written,
            "paths_failed": paths_failed,
            "generated_at": generated_at,
        }
    except Exception as e:
        unreal.log_warning(
            "uefn_bridge: moderation_report_save failed:\n" + traceback.format_exc()
        )
        return {"saved": False, "verified": False, "paths_written": [], "paths_failed": [{"path": None, "error": str(e)}], "error": str(e)}


def _handle_moderation_report_read(params):
    """Read back the stored moderation_report.json, if any.

    Used by the UEFN launcher window to display the report. Delegates to
    ``_read_moderation_report``, the shared read primitive: checks both the
    primary (next to this script) and fallback (bridge IPC temp dir)
    locations and returns whichever exists with the newest mtime, so a
    report that only made it to the fallback (because the primary location
    was unwritable) is still readable. ``_handle_moderation_report_save``
    now performs its own read-back through that same primitive to verify a
    save landed — this method remains the underlying primitive and stays
    available as the read tool for any caller (including future ones) that
    wants to fetch the stored report directly. Returns {"exists": False}
    rather than raising when neither location is present or parsable.
    """
    try:
        data, error = _read_moderation_report()
        if data is None:
            if error:
                return {"exists": False, "error": error}
            return {"exists": False}
        data = dict(data)
        data["exists"] = True
        return data
    except Exception as e:
        unreal.log_warning(
            "uefn_bridge: moderation_report_read failed:\n" + traceback.format_exc()
        )
        return {"exists": False, "error": str(e)}


def _handle_asset_sweep(params):
    if sweep_dead_assets is None:
        return {"error": "asset_sweep is not available in this build of the UEFN bridge"}
    project_only = params.get("project_only", True)
    return sweep_dead_assets(project_only=project_only)


def _handle_list_assets(params):
    """List assets under a content-browser path via the Asset Registry.

    Read-only: uses ``get_assets_by_path`` to enumerate AssetData metadata
    only — never loads assets, so this is safe on large projects.
    """
    path = params.get("path")
    if not path:
        raise ValueError("Missing required param: path")

    recursive = params.get("recursive", True)
    class_filter = params.get("class_filter")
    limit = params.get("limit", 500)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 500
    limit = max(1, min(limit, 2000))

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    except Exception as e:
        raise RuntimeError(f"list_assets: could not get AssetRegistry: {e}") from e

    try:
        found = registry.get_assets_by_path(path, recursive=recursive)
    except Exception as e:
        raise RuntimeError(f"list_assets: get_assets_by_path failed for '{path}': {e}") from e

    class_filter_lower = class_filter.lower() if class_filter else None

    assets = []
    total_found = 0
    for asset_data in found:
        try:
            try:
                class_name = str(asset_data.asset_class_path.asset_name)
            except AttributeError:
                class_name = str(asset_data.asset_class)

            if class_filter_lower and class_filter_lower not in class_name.lower():
                continue

            total_found += 1
            if len(assets) < limit:
                assets.append({
                    "name": str(asset_data.asset_name),
                    "class": class_name,
                    "package_path": str(asset_data.package_name),
                })
        except Exception:
            continue

    return {
        "path": path,
        "recursive": recursive,
        "total_found": total_found,
        "truncated": total_found > len(assets),
        "assets": assets,
    }


def _inspect_value(value, depth, max_depth):
    """Best-effort JSON-safe rendering of a reflected property value."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    # Unreal Name/Text/enums stringify usefully.
    type_name = type(value).__name__
    if depth >= max_depth:
        return f"<{type_name}>"
    try:
        if isinstance(value, unreal.Array):
            return [_inspect_value(v, depth + 1, max_depth) for v in list(value)[:32]]
    except Exception:
        pass
    # Structs / objects: try to expand their editor properties one level.
    try:
        if isinstance(value, unreal.StructBase):
            out = {"__struct": type_name}
            for prop in _editor_property_names(value):
                try:
                    out[prop] = _inspect_value(
                        value.get_editor_property(prop), depth + 1, max_depth
                    )
                except Exception as e:
                    out[prop] = f"<unreadable: {e.__class__.__name__}>"
            return out
    except Exception:
        pass
    try:
        if isinstance(value, unreal.Object):
            # Reference another object by path rather than expanding it.
            return {"__object": type_name, "path": value.get_path_name()}
    except Exception:
        pass
    try:
        return str(value)
    except Exception:
        return f"<{type_name}>"


def _editor_property_names(obj):
    """Enumerate candidate editor-property names for a UObject/struct.

    The Python API has no official 'list all properties' call, so probe the
    class's exposed attributes and keep those get_editor_property accepts.
    """
    names = []
    seen = set()
    for attr in dir(obj):
        if attr.startswith("_") or attr in seen:
            continue
        seen.add(attr)
        try:
            obj.get_editor_property(attr)
            names.append(attr)
        except Exception:
            continue
        if len(names) >= 200:
            break
    return names


def _handle_inspect_asset(params):
    """EXPERIMENTAL: load an asset and reflect its editor properties.

    Purpose: probe whether opaque asset types (e.g. NPC Character
    Definitions) expose readable property values to editor Python even
    though they are closed to Verse and export. Read-only — loads the asset
    into memory but never modifies or saves anything.

    params:
      asset_path (required): full object or package path, e.g.
        '/YourProject/NPCCharDef_Example' or
        '/YourProject/NPCCharDef_Example.NPCCharDef_Example'
      max_depth (optional, default 2, cap 4): struct expansion depth.
    """
    asset_path = params.get("asset_path")
    if not asset_path:
        raise ValueError("Missing required param: asset_path")

    max_depth = params.get("max_depth", 2)
    try:
        max_depth = int(max_depth)
    except (TypeError, ValueError):
        max_depth = 2
    max_depth = max(1, min(max_depth, 4))

    load_error = None
    asset = None
    try:
        asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    except Exception as e:
        load_error = f"{e.__class__.__name__}: {e}"

    if asset is None and load_error is None:
        load_error = "load_asset returned None (asset missing or class blocked)"

    if asset is None:
        # Also report whether the registry can at least see it, to
        # distinguish 'wrong path' from 'load blocked'.
        registry_sees_it = False
        try:
            registry = unreal.AssetRegistryHelpers.get_asset_registry()
            ad = registry.get_asset_by_object_path(asset_path)
            registry_sees_it = bool(ad and ad.is_valid())
        except Exception:
            pass
        return {
            "asset_path": asset_path,
            "loaded": False,
            "load_error": load_error,
            "registry_sees_asset": registry_sees_it,
        }

    cls = asset.get_class()
    prop_names = _editor_property_names(asset)
    properties = {}
    unreadable = []
    for name in prop_names:
        try:
            properties[name] = _inspect_value(
                asset.get_editor_property(name), 0, max_depth
            )
        except Exception as e:
            unreadable.append({"name": name, "error": e.__class__.__name__})

    return {
        "asset_path": asset_path,
        "loaded": True,
        "class": str(cls.get_name()) if cls else None,
        "property_count": len(properties),
        "properties": properties,
        "unreadable": unreadable,
    }


# ---------------------------------------------------------------------------
# Level editing: spawn / duplicate / set_transform
# ---------------------------------------------------------------------------
#
# Unlike every read-only/property handler above, these three mutate the open
# level. Each wraps its edit in unreal.ScopedEditorTransaction (see
# _scoped_transaction) so the change lands as a single Ctrl+Z step for the
# user — falling back to a no-op context manager if that symbol isn't
# exposed in this build, since undo support is a nicety and never a reason
# to fail a level edit. The unreal API surface used here
# (EditorActorSubsystem.spawn_actor_from_object / .duplicate_actor,
# EditorAssetLibrary.does_asset_exist, EditorLevelLibrary's legacy spawn)
# varies across engine builds; every symbol is resolved via getattr() at
# call time so a missing one disables only the ONE handler that needs it,
# same shape as _require_device_audit_symbols above — never the whole
# bridge.


def _scoped_transaction(name):
    """Best-effort unreal.ScopedEditorTransaction for *name*. Falls back to
    a no-op context manager if the symbol is missing or construction fails
    in this build — undo support is a nicety, never a reason to fail an
    edit."""
    cls = getattr(unreal, "ScopedEditorTransaction", None)
    if cls is None:
        return contextlib.nullcontext()
    try:
        return cls(name)
    except Exception:
        return contextlib.nullcontext()


def _spawn_via_editor_actor_subsystem(asset, location, rotation):
    """Try spawning through the modern EditorActorSubsystem. Returns the new
    actor, or None if the subsystem/method isn't available in this build."""
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception:
        subsystem = None
    spawn_fn = getattr(subsystem, "spawn_actor_from_object", None) if subsystem is not None else None
    if spawn_fn is None:
        return None
    return spawn_fn(asset, location, rotation)


def _spawn_via_editor_level_library(asset, location, rotation):
    """Fallback spawn path for builds where EditorActorSubsystem lacks
    spawn_actor_from_object. Returns the new actor, or None if
    EditorLevelLibrary.spawn_actor_from_object isn't available either."""
    legacy = getattr(unreal, "EditorLevelLibrary", None)
    spawn_fn = getattr(legacy, "spawn_actor_from_object", None) if legacy is not None else None
    if spawn_fn is None:
        return None
    return spawn_fn(asset, location, rotation)


def _handle_spawn_actor(params):
    """Spawn a new actor from an asset into the open level."""
    asset_path = params.get("asset_path")
    if not asset_path:
        raise ValueError("Missing required param: asset_path")

    does_asset_exist = getattr(unreal.EditorAssetLibrary, "does_asset_exist", None)
    if does_asset_exist is None:
        raise RuntimeError(
            "spawn_actor unavailable: unreal.EditorAssetLibrary.does_asset_exist is not "
            "exposed in this build of the UEFN bridge"
        )
    if not does_asset_exist(asset_path):
        raise ValueError(
            f"spawn_actor: no asset exists at '{asset_path}'. Verify the exact "
            "content-browser path — try uefn_list_assets on the containing folder, "
            "or uefn_inspect_asset on a candidate path, to find a valid one before retrying."
        )

    try:
        asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    except Exception as e:
        raise RuntimeError(f"spawn_actor: load_asset failed for '{asset_path}': {e}") from e
    if asset is None:
        raise RuntimeError(f"spawn_actor: load_asset returned None for '{asset_path}'")

    loc = params.get("location") or {}
    rot = params.get("rotation") or {}
    scale = params.get("scale") or {}
    location = unreal.Vector(
        float(loc.get("x", 0.0)), float(loc.get("y", 0.0)), float(loc.get("z", 0.0))
    )
    rotation = unreal.Rotator(
        roll=float(rot.get("roll", 0.0)), pitch=float(rot.get("pitch", 0.0)), yaw=float(rot.get("yaw", 0.0))
    )

    with _scoped_transaction("TycoonAgents: Spawn Actor"):
        actor = _spawn_via_editor_actor_subsystem(asset, location, rotation)
        if actor is None:
            actor = _spawn_via_editor_level_library(asset, location, rotation)
        if actor is None:
            raise RuntimeError(
                "spawn_actor unavailable: neither EditorActorSubsystem.spawn_actor_from_object "
                "nor the legacy EditorLevelLibrary.spawn_actor_from_object is exposed in this "
                "build of the UEFN bridge"
            )

        try:
            actor.set_actor_scale3d(unreal.Vector(
                float(scale.get("x", 1.0)), float(scale.get("y", 1.0)), float(scale.get("z", 1.0))
            ))
        except Exception as e:
            unreal.log_warning(f"uefn_bridge: spawn_actor: could not set scale on '{asset_path}': {e}")

        label = params.get("label")
        if label:
            try:
                actor.set_actor_label(label)
            except Exception as e:
                unreal.log_warning(f"uefn_bridge: spawn_actor: could not set label '{label}': {e}")

    try:
        final_label = actor.get_actor_label()
    except Exception:
        final_label = label or asset_path

    final_location = actor.get_actor_location()
    return {
        "success": True,
        "label": final_label,
        "class": actor.get_class().get_name(),
        "location": {
            "x": round(final_location.x, 3),
            "y": round(final_location.y, 3),
            "z": round(final_location.z, 3),
        },
    }


def _handle_duplicate_actor(params):
    """Duplicate an existing actor by label, offsetting the copy so it's
    visibly distinct from the source."""
    actor_label = params.get("actor_label")
    if not actor_label:
        raise ValueError("Missing required param: actor_label")

    source = _find_actor_by_label(actor_label)

    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception:
        subsystem = None
    dup_fn = getattr(subsystem, "duplicate_actor", None) if subsystem is not None else None
    if dup_fn is None:
        raise RuntimeError(
            "duplicate_actor unavailable: EditorActorSubsystem.duplicate_actor is not "
            "exposed in this build of the UEFN bridge"
        )

    offset = params.get("offset") or {}
    offset_x = float(offset.get("x", 100.0))
    offset_y = float(offset.get("y", 100.0))
    offset_z = float(offset.get("z", 0.0))
    source_location = source.get_actor_location()
    new_label = params.get("new_label")

    with _scoped_transaction("TycoonAgents: Duplicate Actor"):
        try:
            new_actor = dup_fn(source)
        except Exception as e:
            raise RuntimeError(f"duplicate_actor: duplicate_actor failed for '{actor_label}': {e}") from e
        if new_actor is None:
            raise RuntimeError(f"duplicate_actor: duplicate_actor returned None for '{actor_label}'")

        new_location = unreal.Vector(
            source_location.x + offset_x,
            source_location.y + offset_y,
            source_location.z + offset_z,
        )
        try:
            new_actor.set_actor_location(new_location, False, True)
        except Exception as e:
            unreal.log_warning(f"uefn_bridge: duplicate_actor: could not offset copy of '{actor_label}': {e}")

        if new_label:
            try:
                new_actor.set_actor_label(new_label)
            except Exception as e:
                unreal.log_warning(f"uefn_bridge: duplicate_actor: could not set label '{new_label}': {e}")

    try:
        final_label = new_actor.get_actor_label()
    except Exception:
        final_label = new_label or actor_label

    final_location = new_actor.get_actor_location()
    return {
        "success": True,
        "label": final_label,
        "source_label": actor_label,
        "location": {
            "x": round(final_location.x, 3),
            "y": round(final_location.y, 3),
            "z": round(final_location.z, 3),
        },
    }


def _handle_set_transform(params):
    """Set location/rotation/scale on an actor by label. Only the
    components provided are changed; at least one must be given."""
    actor_label = params.get("actor_label")
    if not actor_label:
        raise ValueError("Missing required param: actor_label")

    location = params.get("location")
    rotation = params.get("rotation")
    scale = params.get("scale")
    if location is None and rotation is None and scale is None:
        raise ValueError("set_transform: provide at least one of location, rotation, scale")

    actor = _find_actor_by_label(actor_label)

    def _snapshot():
        try:
            loc = actor.get_actor_location()
            rot = actor.get_actor_rotation()
            scl = actor.get_actor_scale3d()
        except Exception as e:
            raise RuntimeError(
                f"set_transform: could not read current transform of '{actor_label}': {e}"
            ) from e
        return {
            "location": {"x": round(loc.x, 3), "y": round(loc.y, 3), "z": round(loc.z, 3)},
            "rotation": {"pitch": round(rot.pitch, 3), "yaw": round(rot.yaw, 3), "roll": round(rot.roll, 3)},
            "scale": {"x": round(scl.x, 3), "y": round(scl.y, 3), "z": round(scl.z, 3)},
        }

    before = _snapshot()

    with _scoped_transaction("TycoonAgents: Set Transform"):
        if location is not None:
            cur = actor.get_actor_location()
            new_loc = unreal.Vector(
                float(location.get("x", cur.x)),
                float(location.get("y", cur.y)),
                float(location.get("z", cur.z)),
            )
            try:
                actor.set_actor_location(new_loc, False, True)
            except Exception as e:
                raise RuntimeError(f"set_transform: set_actor_location failed for '{actor_label}': {e}") from e

        if rotation is not None:
            cur = actor.get_actor_rotation()
            new_rot = unreal.Rotator(
                roll=float(rotation.get("roll", cur.roll)),
                pitch=float(rotation.get("pitch", cur.pitch)),
                yaw=float(rotation.get("yaw", cur.yaw)),
            )
            try:
                actor.set_actor_rotation(new_rot, False)
            except Exception as e:
                raise RuntimeError(f"set_transform: set_actor_rotation failed for '{actor_label}': {e}") from e

        if scale is not None:
            cur = actor.get_actor_scale3d()
            new_scale = unreal.Vector(
                float(scale.get("x", cur.x)),
                float(scale.get("y", cur.y)),
                float(scale.get("z", cur.z)),
            )
            try:
                actor.set_actor_scale3d(new_scale)
            except Exception as e:
                raise RuntimeError(f"set_transform: set_actor_scale3d failed for '{actor_label}': {e}") from e

    after = _snapshot()

    return {
        "success": True,
        "label": actor_label,
        "before": before,
        "after": after,
    }


# Method dispatch table
_METHODS = {
    "status": _handle_status,
    "list_devices": _handle_list_devices,
    "get_property": _handle_get_property,
    "set_property": _handle_set_property,
    "select_actor": _handle_select_actor,
    "run_audit": _handle_run_audit,
    "get_level_info": _handle_get_level_info,
    "batch_set": _handle_batch_set,
    "batch_get": _handle_batch_get,
    "texture_find": _handle_texture_find,
    "texture_summary": _handle_texture_summary,
    "texture_on_actor": _handle_texture_on_actor,
    "material_browse": _handle_material_browse,
    "material_unused": _handle_material_unused,
    "niagara_browse": _handle_niagara_browse,
    "niagara_usage": _handle_niagara_usage,
    "dependency_scan": _handle_dependency_scan,
    "health_scan": _handle_health_scan,
    "moderation_scan": _handle_moderation_scan,
    "moderation_report_save": _handle_moderation_report_save,
    "moderation_report_read": _handle_moderation_report_read,
    "asset_sweep": _handle_asset_sweep,
    "list_assets": _handle_list_assets,
    "inspect_asset": _handle_inspect_asset,
    "spawn_actor": _handle_spawn_actor,
    "duplicate_actor": _handle_duplicate_actor,
    "set_transform": _handle_set_transform,
}


# ---------------------------------------------------------------------------
# Command processing
# ---------------------------------------------------------------------------

def _process_command():
    """Check for command.json, execute it, and write the response."""
    global _bridge_dir, _bridge_token, _warned_bad_token

    cmd_path = os.path.join(_bridge_dir, _COMMAND_FILENAME)
    if not os.path.exists(cmd_path):
        return

    # Read the command
    cmd = _read_json(cmd_path)

    # Delete immediately to avoid re-processing
    try:
        os.remove(cmd_path)
    except OSError:
        pass

    if cmd is None:
        unreal.log_warning("uefn_bridge: Could not parse command.json")
        return

    # Session-token check (see _bridge_token comment for threat model).
    # Reject any command whose token doesn't match ours. Ignore it entirely
    # (no response written — the sender either isn't ours or is a
    # pre-token MCP server that hasn't been upgraded) but log once so a
    # persistent mismatch is discoverable without spamming the log per poll.
    if cmd.get("token") != _bridge_token:
        if not _warned_bad_token:
            _warned_bad_token = True
            unreal.log_warning(
                "uefn_bridge: Rejected command.json with missing/mismatched "
                "session token (further mismatches will not be logged)."
            )
        return

    cmd_id = cmd.get("id", "unknown")
    method = cmd.get("method", "")
    params = cmd.get("params", {})

    unreal.log("uefn_bridge: Received command: " + method + " (id=" + cmd_id + ")")

    # Execute
    result = None
    error = None
    try:
        handler = _METHODS.get(method)
        if handler is None:
            raise ValueError("Unknown method: " + method)
        result = handler(params)
    except Exception as e:
        error = str(e)
        unreal.log_warning(
            "uefn_bridge: Error handling " + method + ": " + traceback.format_exc()
        )

    # Write response
    response = {
        "id": cmd_id,
        "result": result,
        "error": error,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    response_path = os.path.join(_bridge_dir, _RESPONSE_PREFIX + cmd_id + ".json")
    _write_json(response_path, response)

    unreal.log("uefn_bridge: Response written for " + cmd_id)


# ---------------------------------------------------------------------------
# Tick callback
# ---------------------------------------------------------------------------

def _tick(delta_time):
    """Slate post-tick callback.  Polls for commands and writes heartbeats."""
    global _last_poll_time, _last_heartbeat_time

    now = time.monotonic()

    # Poll for commands at _POLL_INTERVAL
    if now - _last_poll_time >= _POLL_INTERVAL:
        _last_poll_time = now
        try:
            _process_command()
        except Exception:
            unreal.log_warning(
                "uefn_bridge: Tick error in _process_command:\n"
                + traceback.format_exc()
            )

    # Write heartbeat at _HEARTBEAT_INTERVAL
    if now - _last_heartbeat_time >= _HEARTBEAT_INTERVAL:
        _last_heartbeat_time = now
        try:
            _write_heartbeat()
        except Exception:
            unreal.log_warning(
                "uefn_bridge: Tick error in _write_heartbeat:\n"
                + traceback.format_exc()
            )


# ---------------------------------------------------------------------------
# Start / Stop
# ---------------------------------------------------------------------------

def start_bridge():
    """Register the tick callback and begin listening for commands."""
    global _tick_handle, _bridge_dir, _last_poll_time, _last_heartbeat_time
    global _bridge_token, _warned_bad_token

    if _tick_handle is not None:
        unreal.log("uefn_bridge: Bridge already running.")
        return

    _bridge_dir = _get_bridge_dir()
    _bridge_token = secrets.token_hex(16)
    _warned_bad_token = False
    _last_poll_time = time.monotonic()
    _last_heartbeat_time = 0.0  # write heartbeat immediately on start

    _tick_handle = unreal.register_slate_post_tick_callback(_tick)

    unreal.log("uefn_bridge: Bridge started.  IPC dir: " + _bridge_dir)
    unreal.log(
        "uefn_bridge: Listening for commands in "
        + os.path.join(_bridge_dir, _COMMAND_FILENAME)
    )


def stop_bridge():
    """Unregister the tick callback and stop listening."""
    global _tick_handle, _bridge_dir

    if _tick_handle is None:
        unreal.log("uefn_bridge: Bridge is not running.")
        return

    unreal.unregister_slate_post_tick_callback(_tick_handle)
    _tick_handle = None

    # Write a final "stopped" heartbeat
    if _bridge_dir is not None:
        stopped = {
            "status": "stopped",
            "timestamp": datetime.datetime.now().isoformat(),
        }
        _write_json(os.path.join(_bridge_dir, _HEARTBEAT_FILENAME), stopped)

    unreal.log("uefn_bridge: Bridge stopped.")


# ---------------------------------------------------------------------------
# Auto-start on import
# ---------------------------------------------------------------------------

# Unregister any orphaned tick from a previous module load before starting fresh.
if _old_tick_handle is not None:
    try:
        unreal.unregister_slate_post_tick_callback(_old_tick_handle)
    except Exception:
        pass
del _old_tick_handle

start_bridge()
