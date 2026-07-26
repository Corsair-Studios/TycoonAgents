"""Shared test helpers for the UEFN bridge Python test suite.

NOT a test module itself (no ``Test*`` classes, ``unittest discover`` skips
it because it doesn't match the ``test_*.py`` pattern) — imported by the
``test_*.py`` modules living alongside it in ``test/python/``.

This directory is intentionally OUTSIDE ``media/uefn-bridge/`` — every
``.py`` in that directory is staged into a user's UEFN project by
``init_unreal.py`` and the extension's staging code, so a test file placed
there would ship into creators' projects. ``test/`` is excluded from the
VSIX via ``.vscodeignore`` (``test/**``).

No hardcoded machine paths anywhere here: every path is derived relative to
this file's own location (``__file__``), so the suite runs unmodified on
any checkout.
"""
import os
import sys
import types
from unittest.mock import MagicMock

# <repo>/media/uefn-bridge, derived from this file's location:
# <repo>/test/python/_bridge_helpers.py -> up two -> <repo> -> media/uefn-bridge
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(_THIS_DIR, "..", ".."))
BRIDGE_DIR = os.path.join(REPO_ROOT, "media", "uefn-bridge")


def ensure_bridge_on_path():
    """Put media/uefn-bridge on sys.path (once) so `import moderation_scanner`
    / `import uefn_bridge` resolve the same way the staged copies do inside
    a UEFN project — these modules are never packaged/importable any other
    way."""
    if not os.path.isdir(BRIDGE_DIR):
        raise RuntimeError(f"expected bridge dir at {BRIDGE_DIR!r}, not found")
    if BRIDGE_DIR not in sys.path:
        sys.path.insert(0, BRIDGE_DIR)


def stub_unreal():
    """Install a MagicMock ``unreal`` module in sys.modules if one isn't
    already there, so `import unreal` (unguarded in uefn_bridge.py, and in
    some of its sibling imports) resolves outside the real UEFN-embedded
    interpreter. Idempotent — safe to call from every test module's
    setUp/setUpModule. Returns the (possibly pre-existing) mock so a test
    can assert against calls made on it (e.g. `unreal.log_warning`)."""
    existing = sys.modules.get("unreal")
    if isinstance(existing, MagicMock):
        return existing
    mock = MagicMock(name="unreal")
    sys.modules["unreal"] = mock
    return mock


def import_moderation_scanner():
    """Import (or return the already-imported) moderation_scanner module.
    Guards its own `import unreal` with try/except ImportError, so no stub
    is required — but stubbing first is harmless if a caller already did."""
    ensure_bridge_on_path()
    import moderation_scanner  # noqa: E402
    return moderation_scanner


def import_uefn_bridge():
    """Import (or return the already-imported) uefn_bridge module. Unlike
    moderation_scanner, this module does an UNGUARDED `import unreal` (and
    pulls in several sibling modules that also touch `unreal`), so the stub
    MUST be installed first."""
    ensure_bridge_on_path()
    stub_unreal()
    import uefn_bridge  # noqa: E402
    return uefn_bridge


def extract_nested_function(outer_func, name, extra_closure=None):
    """Pull a REAL nested ``def name(...): ...`` out of ``outer_func``'s
    already-compiled bytecode and rebuild it as a standalone, directly
    callable function — without modifying, reimplementing, or even
    re-parsing ``outer_func``'s source.

    Why this exists: moderation_scanner.run_moderation_scan's suspect-queue
    ranking block (the fix for the "discord_QR sorted last, human had to
    recover it manually" regression) is implemented as several nested
    functions closed over local state inside run_moderation_scan itself —
    it is not, and per this task's constraints must not become, a
    module-level export. This is the standard trick for unit-testing such
    a closure without touching the implementation file: nested `def`
    statements compile to a `types.CodeType` stored in the *enclosing*
    function's `__code__.co_consts`, findable by `co_name`. Rebuilding a
    `types.FunctionType` from that exact code object means the test calls
    the real, byte-for-byte compiled logic — not a hand-copied
    reimplementation that could silently drift from the source.

    ``extra_closure`` supplies values for any free variables the nested
    function closes over (e.g. a sibling nested function it calls, or a
    shared mutable dict/list from the enclosing scope) as {name: value};
    each is wrapped in a real ``types.CellType`` so mutations are visible
    through the same object the caller holds.
    """
    code = None
    for const in outer_func.__code__.co_consts:
        if isinstance(const, types.CodeType) and const.co_name == name:
            code = const
            break
    if code is None:
        raise LookupError(f"no nested function named {name!r} found inside {outer_func!r}")

    extra_closure = extra_closure or {}
    closure_cells = []
    for freevar in code.co_freevars:
        if freevar not in extra_closure:
            raise LookupError(
                f"{name!r} closes over {freevar!r}, but no value was supplied "
                f"in extra_closure (supplied: {sorted(extra_closure)})"
            )
        closure_cells.append(types.CellType(extra_closure[freevar]))

    return types.FunctionType(code, outer_func.__globals__, name, closure=tuple(closure_cells))
