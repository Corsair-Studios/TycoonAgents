"""
UEFN Bridge — IPC Path Contract
================================
Tiny, side-effect-free module holding the file-based IPC directory contract
shared by ``uefn_bridge.py`` (the in-editor bridge that owns this directory)
and every sibling tool that only needs to read/write into it —
``property_inspector.py``, ``moderation_scanner.py``, ``uefn_launcher.py``.

WHY THIS MODULE EXISTS: those siblings used to reimplement the directory
derivation locally instead of importing ``uefn_bridge.py`` directly, because
importing ``uefn_bridge.py`` has a real side effect — it auto-starts the
bridge's tick/poll loop on import (see its "Auto-start on import" section).
A sibling that only wants the IPC directory path must not accidentally spin
up a second bridge instance just to get it. This module is importable with
zero side effects and stdlib only (no ``unreal`` dependency), so it may also
be imported from MCP-server-side script contexts where ``unreal`` never
exists.

Every value here MUST byte-match the literals ``uefn_bridge.py`` has always
used — this module only centralizes them, it does not change them. If you
ever need to change one, change ``uefn_bridge.py`` first and mirror it here.

Consumers should import this module guarded, e.g.::

    try:
        import bridge_paths
    except ImportError:
        bridge_paths = None

so a version-skewed sibling set (an old engine-side copy missing this new
file — see the "sys.path self-consistency shield" comment in
``uefn_bridge.py`` for why mixed-version sibling copies are a real field
failure mode here, not a hypothetical one) degrades to that file's own
local fallback derivation instead of crashing on import.
"""

import os
import tempfile

# Directory name under the OS temp root, and the env var that overrides the
# whole directory (not just this name) — see bridge_ipc_dir() below.
IPC_DIR_NAME = "uefn_bridge"
_ENV_OVERRIDE = "UEFN_BRIDGE_DIR"

# File names written/read inside the IPC directory by uefn_bridge.py.
HEARTBEAT_FILENAME = "heartbeat.json"
COMMAND_FILENAME = "command.json"
# Per-command inbox filename prefix (0.0.499+): a TS client new enough to see
# a bridge_version-carrying heartbeat.json writes command_<id>.json instead
# of clobbering the single shared COMMAND_FILENAME — fixes the intermittent
# 30s-timeout race where a second writer's rename-over-command.json could
# land in the up-to-500ms window before uefn_bridge.py reads and deletes the
# first writer's still-unread command. uefn_bridge.py polls BOTH this
# pattern and the legacy COMMAND_FILENAME every tick so old-TS+new-Python and
# new-TS+old-Python each behave exactly as they did before this constant
# existed. Do not change COMMAND_FILENAME's meaning or value for this — it
# stays the permanent fallback for any TS client that hasn't seen a
# bridge_version-carrying heartbeat yet.
COMMAND_PREFIX = "command_"  # + <command id> + ".json"
RESPONSE_PREFIX = "response_"  # + <command id> + ".json"


def bridge_ipc_dir(create=True):
    """Return the bridge IPC directory.

    Honors the ``UEFN_BRIDGE_DIR`` environment variable so the in-editor
    bridge, the MCP wrapper, and every sibling tool agree on the same
    location; otherwise falls back to ``<temp>/uefn_bridge``. The temp
    default is machine-agnostic: every side resolves the same per-machine
    temp path independently, so no configuration is needed for the common
    case. To use a custom dir, set UEFN_BRIDGE_DIR for BOTH the UEFN
    process and the MCP wrapper.

    ``create=True`` (the default — what every WRITE-side caller has always
    done: ``uefn_bridge.py``, ``uefn_launcher.py``, ``property_inspector.py``)
    creates the directory if missing, via ``os.makedirs(..., exist_ok=True)``;
    any OSError from a genuinely unwritable temp root propagates to the
    caller exactly as it always has — this centralization changes no
    error-handling behavior at any call site.

    Pass ``create=False`` for a READ-only lookup where creating an empty
    directory would serve no purpose. ``moderation_scanner.py``'s fallback-
    location check is the one existing example: it only reads, and only
    when there's reason to believe something was already written there.
    """
    bridge_dir = os.environ.get(_ENV_OVERRIDE) or os.path.join(
        tempfile.gettempdir(), IPC_DIR_NAME
    )
    if create:
        os.makedirs(bridge_dir, exist_ok=True)
    return bridge_dir
