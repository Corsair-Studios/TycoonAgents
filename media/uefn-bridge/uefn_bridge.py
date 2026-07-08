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

# Reuse device_audit helpers — do NOT duplicate that logic.
from device_audit import (
    _is_device,
    _safe_label,
    _actor_location_tuple,
    _find_overridden_properties,
    _build_base_property_set,
    _get_property_names,
)
from batch_tools import batch_set_property, batch_get_property
from texture_finder import find_texture_usage, find_texture_summary, list_textures_on_actor
from material_browser import browse_materials, find_unused_materials
from niagara_inspector import browse_niagara, find_niagara_usage
from dependency_viewer import scan_dependencies
from health_scanner import scan_health
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

def _get_bridge_dir():
    """Return the bridge IPC directory, creating it if necessary.

    Honors the ``UEFN_BRIDGE_DIR`` environment variable so this in-editor
    bridge and the MCP wrapper can agree on a custom location; otherwise falls
    back to ``<temp>/uefn_bridge``. The temp default is machine-agnostic: both
    sides resolve the same per-machine temp path independently, so no
    configuration is needed for the common case. To use a custom dir, set
    UEFN_BRIDGE_DIR for BOTH the UEFN process and the MCP wrapper.
    """
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
    _write_json(os.path.join(_bridge_dir, "heartbeat.json"), heartbeat)


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
            changed = _find_overridden_properties(actor, base_props)
            devices.append({
                "label": label,
                "class": actor.get_class().get_name(),
                "location": {"x": loc[0], "y": loc[1], "z": loc[2]},
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
    # Import device_audit's run logic directly
    import device_audit

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
                changed = _find_overridden_properties(actor, base_props)
                devices.append({
                    "label": label,
                    "class": class_name,
                    "location": {"x": loc[0], "y": loc[1], "z": loc[2]},
                    "changed_property_count": len(changed),
                    "changed_properties": changed,
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


def _handle_asset_sweep(params):
    if sweep_dead_assets is None:
        return {"error": "asset_sweep is not available in this build of the UEFN bridge"}
    project_only = params.get("project_only", True)
    return sweep_dead_assets(project_only=project_only)


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
    "asset_sweep": _handle_asset_sweep,
}


# ---------------------------------------------------------------------------
# Command processing
# ---------------------------------------------------------------------------

def _process_command():
    """Check for command.json, execute it, and write the response."""
    global _bridge_dir, _bridge_token, _warned_bad_token

    cmd_path = os.path.join(_bridge_dir, "command.json")
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
    response_path = os.path.join(_bridge_dir, "response_" + cmd_id + ".json")
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
        + os.path.join(_bridge_dir, "command.json")
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
        _write_json(os.path.join(_bridge_dir, "heartbeat.json"), stopped)

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
