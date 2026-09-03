"""Shared test helpers for the UEFN skill Python test suite.

NOT a test module itself (no ``Test*`` classes, ``unittest discover`` skips
it because it doesn't match the ``test_*.py`` pattern) — imported by the
``test_*.py`` modules living alongside it in ``test/python/``.

TycoonAgents no longer bundles or installs Power Tools (media/uefn-bridge/
was removed; it's a separate third-party product), so this file carries
only the generic bytecode-introspection helper below, used by
test_verse_lsp_check.py. It previously also held bridge-dir path helpers
(``ensure_bridge_on_path``, ``stub_unreal``, ``import_moderation_scanner``,
``import_uefn_bridge``) for tests that targeted media/uefn-bridge modules;
those tests were deleted along with the bridge directory, so those helpers
were removed too.
"""
import types


def extract_nested_function(outer_func, name, extra_closure=None):
    """Pull a REAL nested ``def name(...): ...`` out of ``outer_func``'s
    already-compiled bytecode and rebuild it as a standalone, directly
    callable function — without modifying, reimplementing, or even
    re-parsing ``outer_func``'s source.

    Nested `def` statements compile to a `types.CodeType` stored in the
    *enclosing* function's `__code__.co_consts`, findable by `co_name`.
    Rebuilding a `types.FunctionType` from that exact code object means the
    test calls the real, byte-for-byte compiled logic — not a hand-copied
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
