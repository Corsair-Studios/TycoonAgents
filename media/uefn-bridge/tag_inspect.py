"""
Verse Tag Inspector
=====================
Verse gameplay tags applied to a placed actor in UEFN live on a component,
not as a direct property of the actor. The bridge's existing flat
``uefn_get_property`` handler (``_handle_get_property`` in
``uefn_bridge.py``) calls ``actor.get_editor_property(property_name)``
directly on the actor object — it has no component-traversal step, so any
attempt to read Verse tags through it returns an empty container or a
"property not found" error even when the actor visibly has tags applied in
the editor.

**Field case (why this exists):** during a spawn-system audit, ~200 actors
were checked for expected gameplay tags via the flat property reader. Every
query came back with an empty tag container, for every actor. That was
accepted as "the level has no tags applied" — a false negative that sent an
investigation in the wrong direction for a full session. The actors were
correctly tagged the whole time; the tags simply lived on a component this
flat reader cannot see. Silently omitting or under-reporting tagged/
untagged actors is the exact failure mode this module must never reproduce
— see ``inspect_tags``'s docstring and the sort-order requirement below.

Two things this module deliberately does NOT hardcode:
  * The Verse-tag component's class name and its tag-container property
    name — both are discovered at runtime (see ``_find_tag_component``)
    because the obvious literal guesses (e.g. a component class literally
    named "VerseTagMarkup", a property literally named "Tags") have already
    failed as bare ``get_editor_property`` targets in the field. What is
    actually discovered is reported back in ``inspect_tags``'s
    ``discovery`` block instead of being assumed — including, when a
    component IS found but no property on it is identified as the tag
    container, a capped listing of every property this scan actually saw
    on that component (name, type, truncated value repr) via
    ``discovery.component_properties``. A field run once returned a real
    component class (``VerseTagMarkupComponent``) with ``tag_property:
    null`` for a demonstrably-tagged actor and nothing else to go on — see
    ``_extract_tags_from_component``'s content+shape detection and this
    field's own self-diagnosis contract, which exists so that exact
    scenario is never a dead end again.
  * Any tag-declaration filename or tag-name prefix — the set of "real"
    Verse tag classes is derived purely from the target project's own
    ``*.verse`` source (see the "PURE" section below), so this module works
    unmodified on any UEFN project.

Import-safety: every ``unreal``-touching call is guarded so this module
importable (and its pure logic testable) with ``unreal`` absent — see the
guarded-import block below, mirroring ``uefn_bridge.py``'s own sibling-
import pattern (guarded try/except, degrade with an explicit error rather
than crash). No third-party dependencies; standard library only.

Usage:
    import importlib, tag_inspect; importlib.reload(tag_inspect)
    result = tag_inspect.inspect_tags(label_pattern="SGMarker*")
"""

import fnmatch
import glob
import json
import os
import re
import tempfile
import time
import traceback

try:
    import unreal
    _HAS_UNREAL = True
except ImportError:
    _HAS_UNREAL = False

# Reuse device_audit's actor-label helper and its Verse-source-dir discovery
# ladder (_find_verse_dir, the PATH-DISCOVERY exemplar) — do NOT duplicate
# that logic. Guarded exactly like uefn_bridge.py's own "Reuse device_audit
# helpers" block: device_audit.py itself does an unconditional `import
# unreal` at module scope, so importing it here raises ImportError (caught
# below, not any other exception) whenever `unreal` is unavailable — which
# is exactly the standalone/off-editor case this module must degrade
# gracefully for, not crash on.
try:
    import device_audit
except ImportError as _da_exc:
    device_audit = None
    _DEVICE_AUDIT_IMPORT_ERROR = str(_da_exc)
else:
    _DEVICE_AUDIT_IMPORT_ERROR = None

_safe_label_fn = getattr(device_audit, "_safe_label", None) if device_audit is not None else None
_find_verse_dir_fn = getattr(device_audit, "_find_verse_dir", None) if device_audit is not None else None

# Reuse property_inspector's dir()-based editor-property enumerator
# (property_inspector.py:103, `_get_property_names`) to discover a
# component's property names generically, rather than reimplementing it.
# Guarded the same way, with a local fallback in _get_component_property_names
# below if this is ever unavailable (version-skewed sibling set).
try:
    from property_inspector import _get_property_names as _pi_get_property_names
except ImportError:
    _pi_get_property_names = None

# device_audit._get_property_names (device_audit.py:252) is the SAME
# dir()-based enumerator, already proven against 579/579 live classes for
# CDO diffing (see device_audit's own field notes) -- it has only ever been
# called with an ACTOR there. Pooled in here as a second independent source
# and tried against the COMPONENT object instead. Resolved via getattr, not
# a bare `from device_audit import ...`, so one missing/renamed symbol in a
# stale device_audit.py copy degrades this to None rather than failing the
# whole module import.
_da_get_property_names = getattr(device_audit, "_get_property_names", None) if device_audit is not None else None

# Reuse device_audit's world-location reader for the opt-in
# include_location param on inspect_tags -- the SAME seam p2 built for
# batch_get_location/batch_get_property's "location" special case (see
# batch_tools.py:295-333 and device_audit.py:211's _actor_location_tuple
# docstring). Resolved via getattr for the same version-skew-tolerance
# reason as _da_get_property_names above: a missing/renamed symbol in a
# stale device_audit.py copy degrades include_location to an explicit
# per-actor error rather than an ImportError that kills this whole module.
_da_actor_location_tuple = getattr(device_audit, "_actor_location_tuple", None) if device_audit is not None else None

# Reuse batch_tools' cursor-pagination slicer (batch_tools.py:346,
# _apply_pagination) for inspect_tags' own max_results/offset paging
# (p3-t4) rather than reimplementing the same offset/max_results/
# next_offset contract a second time. Guarded exactly like the
# device_audit import above: batch_tools.py does its own unconditional
# `import unreal` at module scope, so importing it here raises ImportError
# whenever `unreal` is unavailable (the standalone/off-editor case this
# module must keep degrading gracefully for, not crash on) -- resolved via
# getattr so a missing/renamed symbol in a stale batch_tools.py copy
# degrades pagination to an explicit error rather than an ImportError that
# kills this whole module.
try:
    import batch_tools
except ImportError as _bt_exc:
    batch_tools = None
    _BATCH_TOOLS_IMPORT_ERROR = str(_bt_exc)
else:
    _BATCH_TOOLS_IMPORT_ERROR = None

_apply_pagination_fn = getattr(batch_tools, "_apply_pagination", None) if batch_tools is not None else None


def _fallback_label(actor):
    """Local last-resort label fallback if device_audit._safe_label is
    unavailable — same get_actor_label()-then-get_name() pattern used
    throughout this sibling set (device_audit.py, property_inspector.py)."""
    try:
        return actor.get_actor_label()
    except Exception:
        pass
    try:
        return actor.get_name()
    except Exception:
        return "<unknown actor>"


# ---------------------------------------------------------------------------
# PURE / unreal-free functions — importable and unit-testable without a live
# editor. Nothing below this banner touches `unreal`, the filesystem beyond
# what is handed to it as plain strings, or any mutable module state.
# ---------------------------------------------------------------------------

def match_label(label, pattern):
    """True if *label* matches *pattern*. Empty/None pattern matches every
    label. A pattern containing "*" is matched via fnmatch (case-
    insensitive wildcard); otherwise *pattern* is a case-insensitive
    substring match."""
    if not pattern:
        return True
    if label is None:
        label = ""
    if "*" in pattern:
        return fnmatch.fnmatch(label.lower(), pattern.lower())
    return pattern.lower() in label.lower()


_CLASS_DECL_RE = re.compile(r"^\s*(\w+)\s*:=\s*class\((\w+)\)")

# Reimplemented locally rather than imported from
# moderation_scanner.collect_verse_surfaces (which already masks Verse
# block comments this same way): that masking is inlined inside a much
# larger method there that ALSO collects string-literal/line-comment/
# label surfaces for moderation reporting — it is not factored into a
# standalone importable helper — and importing the whole moderation_scanner
# module (4000+ lines; pulls in hashlib/zlib/struct/subprocess/webbrowser/
# unicodedata plus its own guarded tkinter import) just to reuse one regex
# would drag in dependencies this module has no other reason to need. This
# mirrors moderation_scanner.py's OWN precedent of reimplementing
# _moderation_report_path locally rather than importing uefn_bridge.py, for
# the identical reason (avoiding an unwanted, heavier dependency) — see
# that function's docstring. The pattern itself is copied verbatim so
# masking BEHAVIOR (including the no-nesting limitation, see
# _mask_block_comments below) matches exactly, not just in spirit.
_BLOCK_COMMENT_RE = re.compile(r"<#.*?#>", re.DOTALL)


def _mask_block_comments(text):
    """Replace every Verse ``<# ... #>`` block comment in *text* with
    spaces, preserving every newline and every other character's offset —
    so line numbers/positions never shift and a per-line regex scan
    (``extract_class_declarations``) can never mistake commented-out
    source for a real declaration. Trailing real code AFTER a block
    comment closes on the same line is left untouched, since masking only
    replaces the matched ``<#...#>`` span itself, not the rest of the
    line.

    Non-greedy (``.*?``) exactly like
    ``moderation_scanner.collect_verse_surfaces``'s own
    ``_BLOCK_COMMENT_RE`` — deliberately matching its behavior rather than
    inventing different semantics: ``<# <# #> #>`` nested block comments
    are NOT specially handled. The first ``<#`` pairs with the FIRST
    ``#>`` encountered, leaving the outer comment's own trailing `` #>``
    as unmasked text on that line. Confirmed empirically (not assumed):
    that stray leading ``#>`` fragment means a genuine declaration placed
    on the SAME line right after it will also fail to be collected (the
    leftover text no longer starts with a word character once leading
    whitespace is skipped) — this is a real, known consequence of not
    handling nesting, not a separately-invented behavior; it matches
    moderation_scanner.py's own identical regex/limitation exactly. A
    declaration on its OWN line after a nested comment fully closes is
    unaffected.
    """
    if not text:
        return text
    masked = list(text)
    for m in _BLOCK_COMMENT_RE.finditer(text):
        for i in range(m.start(), m.end()):
            if masked[i] != "\n":
                masked[i] = " "
    return "".join(masked)


def extract_class_declarations(text):
    r"""Scan *text* (one .verse file's contents) line by line and return a
    ``{child_class_name: parent_class_name}`` dict for every line matching
    ``^\s*(\w+)\s*:=\s*class\((\w+)\)`` — the spec's own
    ``^(\w+)\s*:=\s*class\((\w+)\)`` widened with a leading ``\s*``.
    Verse tag classes are very commonly declared INSIDE a ``module`` block,
    where every line is indented — the un-widened, anchored-at-column-0
    regex silently skipped every such declaration, producing empty parent
    chains with no error surfaced (the exact silent-omission failure class
    this module exists to prevent). Do NOT tighten this back to
    column-0-anchored: that regresses real, common Verse layouts.

    Before the per-line regex runs, ``<# ... #>`` block comments are
    masked out via ``_mask_block_comments`` (see that function for exactly
    what is and isn't handled — multi-line block comments are fully
    masked, a block comment that opens and closes on one line is masked
    leaving any trailing real code on that line intact, and nested block
    comments are NOT specially handled, matching
    ``moderation_scanner.collect_verse_surfaces``'s identical behavior).
    A declaration-shaped line inside a block comment is therefore no
    longer collected as a real declaration — this was a real gap
    (discovered as a side effect of the indentation-tolerance widening
    above: it would have newly caught INDENTED block-commented
    declarations that the original column-0-anchored regex could not),
    now closed.

    Separately, the widening is safe with respect to ``#`` LINE comments:
    a ``#`` line comment (even indented, e.g. ``    # foo := class(tag)``,
    with or without a space after ``#``) still cannot match at any
    indentation — ``\s*`` only consumes whitespace, and ``#`` is neither
    whitespace nor a ``\w`` character, so the mandatory ``(\w+)`` group
    still fails to start regardless of how much leading whitespace
    precedes it. Verified with ``re`` directly, not assumed.

    Applied per line (not multiline/anchored across the whole file, beyond
    the block-comment masking pass, which is inherently multi-line). Later
    lines win over earlier ones for the same child name. Never raises."""
    declarations = {}
    if not text:
        return declarations
    masked_text = _mask_block_comments(text)
    for line in masked_text.splitlines():
        m = _CLASS_DECL_RE.match(line)
        if m:
            declarations[m.group(1)] = m.group(2)
    return declarations


def build_class_map(file_texts):
    """Merge ``extract_class_declarations()`` over an iterable of raw
    .verse file-text strings into one child->parent map spanning every file
    scanned. A later file's declaration overrides an earlier same-named one
    (matches extract_class_declarations' own last-wins rule)."""
    class_map = {}
    for text in file_texts:
        class_map.update(extract_class_declarations(text))
    return class_map


def resolve_parent_chain(class_name, class_map, base="tag"):
    """Walk class_map's parent pointers starting at *class_name* until the
    literal base identifier *base* (``"tag"``) is reached. Returns the
    ordered list of ancestors from *class_name*'s immediate parent down to
    and including *base* (e.g. ``["t_area", "tag"]``), or ``None`` if the
    chain does not terminate at *base* — an undeclared/unknown parent, or a
    cycle. Cycle-guarded via a visited set (plus a defensive hard cap) so a
    malformed project can never hang the caller."""
    chain = []
    visited = set()
    current = class_name
    guard = len(class_map) + 2
    while True:
        parent = class_map.get(current)
        if parent is None:
            return None
        if parent in visited:
            return None
        visited.add(parent)
        chain.append(parent)
        if parent == base:
            return chain
        current = parent
        if len(chain) > guard:
            return None


def build_tag_class_set(class_map, base="tag"):
    """Return ``{class_name: parent_chain}`` for every entry in *class_map*
    whose ancestry (via ``resolve_parent_chain``) terminates at the literal
    base identifier *base*. This — not any filename or naming-prefix
    assumption — is what distinguishes a genuine Verse gameplay-tag class
    from any unrelated ``class(...)`` declaration; the valid-tag set is
    derived purely from the project's own declarations."""
    tag_classes = {}
    for child in class_map:
        chain = resolve_parent_chain(child, class_map, base=base)
        if chain is not None:
            tag_classes[child] = chain
    return tag_classes


_REPR_WRAPPER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*'(.*)'$")


def normalize_tag_name(raw):
    """Normalize a raw tag value's string form into a bare tag name: strips
    a Python-repr-style wrapper some Unreal types produce (e.g.
    ``"GameplayTag'TagName'"`` -> ``"TagName"``), then — if the remaining
    value is dotted — keeps only the final segment as the leaf tag name
    (e.g. ``"Verse.t_area_hoth"`` -> ``"t_area_hoth"``). This is a best-
    effort convention match: the exact live string form a Verse tag
    container's entries repr() to is UNVERIFIED without a live editor (see
    the module docstring), so this stays a separate, testable function
    rather than being inlined into the live discovery path."""
    if raw is None:
        return ""
    text = str(raw).strip()
    m = _REPR_WRAPPER_RE.match(text)
    if m:
        text = m.group(1)
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text


def _project_actor_fields(entry, fields, always_keep=("label",)):
    """
    Return a copy of a per-actor ``inspect_tags`` entry containing only
    the keys named in *fields*, plus everything in *always_keep*
    (identity fields kept regardless, so a field-selected entry can
    still be attributed to an actor). Mirrors batch_tools.py's
    ``_project_fields`` exactly (same contract, same "unknown names are
    silently absent, not an error" posture) -- kept as a separate
    function rather than a cross-module import because tag_inspect.py
    must stay independently importable when batch_tools.py is absent/
    version-skewed (see the module's import-safety docstring banner).
    Called only when *fields* is not None -- the caller (``inspect_tags``)
    never invokes this for the default path, so it can never be the
    source of a default-shape change.
    """
    keep = set(fields) | set(always_keep)
    return {k: v for k, v in entry.items() if k in keep}


def sort_actors_flagged_first(actors):
    """Stable sort: actors with ``has_verse_tag_component`` False, or an
    empty ``tags`` list, sort BEFORE every other actor. This is the
    "never silently omit an untagged/under-tagged actor" requirement —
    flagged actors surface first instead of being buried at the bottom of
    a long list. Relative order within each partition is preserved
    (Python's ``sorted()`` is stable)."""
    def _flagged_last(actor):
        if not actor.get("has_verse_tag_component", False):
            return 0
        if not actor.get("tags"):
            return 0
        return 1
    return sorted(actors, key=_flagged_last)


# ---------------------------------------------------------------------------
# Cursor pagination for inspect_tags (p3-t4) -- max_results as PAGE SIZE,
# offset to select the page, mirroring batch_tools._apply_pagination's
# contract exactly (imported above as _apply_pagination_fn when available).
# ---------------------------------------------------------------------------

def _paginate_actors(actors_out, max_results, offset):
    """
    Stably sort *actors_out* by label, then slice one page via the shared
    batch_tools._apply_pagination (imported as _apply_pagination_fn), or a
    local fallback with the IDENTICAL contract if batch_tools is
    unavailable (stale/version-skewed sibling set -- see the guarded
    import above). Returns (page, page_extra) exactly as
    _apply_pagination does: page_extra is {} (no new keys at all) when
    both max_results and offset are None, so a caller who never opts into
    pagination is byte-identical to before this parameter existed.

    ORDERING -- why sort by label here, SEPARATELY from
    sort_actors_flagged_first: sort_actors_flagged_first (applied earlier,
    unconditionally, in _inspect_tags_live) is a STABLE PARTITION, not a
    full deterministic order -- it only guarantees flagged actors precede
    tagged ones, and preserves each partition's original (actor-walk)
    relative order otherwise. That walk order is NOT guaranteed stable
    across repeated calls (see _match_actors' docstring in batch_tools.py
    for the identical underlying reason: get_all_level_actors() makes no
    cross-call ordering guarantee). Cursor pagination calls this whole
    function fresh for every page request, so without a KEY that depends
    only on each actor's own attributes -- not on iteration order -- a
    later page could silently re-return an actor an earlier page already
    returned, or skip one entirely, exactly as _match_actors' docstring
    describes. Sorting by "label" here is that key: it is applied AFTER
    sort_actors_flagged_first so the existing flagged-first contract
    (asserted by test_tag_inspect.py's SortActorsFlaggedFirstTests) is
    completely undisturbed when pagination is not requested -- this
    function is only ever called when the caller passed max_results and/or
    offset, so the label sort never touches the default (non-paginated)
    response's actor order at all.
    """
    stably_ordered = sorted(actors_out, key=lambda a: a.get("label") or "")
    if _apply_pagination_fn is not None:
        return _apply_pagination_fn(stably_ordered, max_results, offset)

    # Local fallback -- same contract as batch_tools._apply_pagination,
    # kept in exact lockstep with it (see that function's docstring for
    # the authoritative behavior this mirrors: max_results is page size,
    # not a ceiling; offset defaults to 0; out-of-range offset returns an
    # empty page rather than raising).
    total = len(stably_ordered)
    if max_results is None and offset is None:
        return stably_ordered, {}
    effective_offset = offset if offset is not None else 0
    if effective_offset < 0:
        effective_offset = 0
    if max_results is None or max_results <= 0:
        page = stably_ordered[effective_offset:]
        return page, {"offset": effective_offset, "returned": len(page)}
    page = stably_ordered[effective_offset:effective_offset + max_results]
    next_offset = effective_offset + len(page)
    page_extra = {"offset": effective_offset, "returned": len(page)}
    if next_offset < total:
        page_extra["next_offset"] = next_offset
    return page, page_extra


# ---------------------------------------------------------------------------
# Offline __ExternalActors__ scan — the PRIMARY tag-extraction source.
#
# Three consecutive live runs (0.0.534-536) proved the live component read
# is a dead end on real projects: VerseTagMarkupComponent.component_tags
# positively iterates to ZERO on every matched actor, on markers known to
# carry real tags. The only tags ever decoded live came from AActor::Tags
# (the actor-level fallback above), and only on a fraction of actors. The
# field-validated ground truth (docs/VERSE-TAG-INSPECTOR-SPEC.md section 5,
# lines 149-171): UEFN's world-partition actors each live in their OWN
# one-file-per-actor .uasset under the project's Content/__ExternalActors__
# tree, and the exact editor-visible Verse tags are recoverable straight
# from those files' bytes via a plain printable-ASCII-run extraction
# intersected against this project's own known tag-class names — recovered
# 4/4 ground-truth tags, zero false positives, ~46,000 files scanned in
# under 2 minutes. No live editor object state is involved at all, so this
# works even when the live component read is provably blind — which is why
# it runs as the PRIMARY source in inspect_tags() (see the "OFFLINE
# __EXTERNALACTORS__ SCAN"/"SOURCE merge" sections in _inspect_tags_live
# below), not a last-resort fallback.
#
# Headless by design: nothing below touches `unreal` — this section is
# importable and unit-testable without a live editor, mirroring the rest
# of the PURE section above this banner (see module docstring's import-
# safety contract). It is placed here rather than after the "Live" banner
# below purely for grouping (offline == pure); a few helpers it calls
# (`_known_tag_hits`, `_CANCEL_POLL_INTERVAL`) happen to be *defined*
# textually after the Live banner even though they are themselves also
# unreal-free — Python resolves module-level names at call time, not
# def-time, so this ordering is safe.
# ---------------------------------------------------------------------------

_PRINTABLE_RUN_RE = re.compile(r"[\x20-\x7E]{4,}")
_EXTERNAL_ACTORS_DIRNAME = "__ExternalActors__"
_MAX_ROOT_WALKUP = 12
_MAX_ROOT_GLOB_DEPTH = 3

_OFFLINE_UNSAVED_CAVEAT = (
    "The offline __ExternalActors__ scan reads each actor's last-SAVED "
    ".uasset state on disk — any UNSAVED changes made in the editor since "
    "the last save are invisible to it."
)


def _find_uefn_project_root(start_dir):
    """Walk upward from *start_dir* until a directory containing a
    ``*.uefnproject`` file is found (content-based signal, per
    docs/PATH-DISCOVERY.md) — same walkup shape as health_scanner.py's
    ``_get_project_root()``, but returns ``None`` (never a best-guess
    fallback) when nothing is found: callers here must be able to report
    an honest discovery failure with the paths they tried, not silently
    trust a wrong guess. Bounded to ``_MAX_ROOT_WALKUP`` levels so a
    pathological filesystem layout can never hang this. Never raises."""
    if not start_dir:
        return None
    candidate = os.path.normpath(start_dir)
    for _ in range(_MAX_ROOT_WALKUP):
        try:
            entries = os.listdir(candidate)
        except Exception:
            entries = []
        if any(e.endswith(".uefnproject") for e in entries):
            return candidate
        parent = os.path.dirname(candidate)
        if parent == candidate:
            break
        candidate = parent
    return None


def _discover_external_actors_dirs(verse_dir):
    """Discovery ladder (docs/PATH-DISCOVERY.md) for the project's
    __ExternalActors__ tree, most-authoritative signal first:
      1. ``UEFN_VERSE_PROJECT_DIR`` env override, if set — tried verbatim,
         both with and without a ``Content`` segment, before anything
         else.
      2. Walk *verse_dir* up to its ``.uefnproject`` root (see
         ``_find_uefn_project_root``), then probe
         ``<root>/Content/__ExternalActors__``,
         ``<root>/__ExternalActors__``, and a shallow (depth <=
         ``_MAX_ROOT_GLOB_DEPTH``) glob for any ``__ExternalActors__``
         folder under root — covers layouts where Content isn't the
         direct child.

    Returns every candidate probed, de-duplicated and order-preserved,
    whether or not it actually exists — this is exactly what a total
    discovery failure reports back (see ``scan_external_actors``), never a
    silent empty result. Never raises."""
    candidates = []
    env_dir = os.environ.get("UEFN_VERSE_PROJECT_DIR")
    if env_dir:
        candidates.append(os.path.join(env_dir, "Content", _EXTERNAL_ACTORS_DIRNAME))
        candidates.append(os.path.join(env_dir, _EXTERNAL_ACTORS_DIRNAME))

    root = _find_uefn_project_root(verse_dir) if verse_dir else None
    if root:
        candidates.append(os.path.join(root, "Content", _EXTERNAL_ACTORS_DIRNAME))
        candidates.append(os.path.join(root, _EXTERNAL_ACTORS_DIRNAME))
        for depth in range(1, _MAX_ROOT_GLOB_DEPTH + 1):
            pattern = os.path.join(root, *(["*"] * depth), _EXTERNAL_ACTORS_DIRNAME)
            try:
                candidates.extend(glob.glob(pattern))
            except Exception:
                pass

    seen = set()
    deduped = []
    for c in candidates:
        norm = os.path.normpath(c)
        if norm not in seen:
            seen.add(norm)
            deduped.append(norm)
    return deduped


def scan_external_actors(verse_dir, tag_class_set, class_map, label_pattern=None,
                          live_labels=None, progress_cb=None, should_cancel=None):
    r"""Scan the project's __ExternalActors__ tree of one-file-per-actor
    .uasset files for Verse tags, entirely offline — no ``unreal`` import,
    no live object state (see the banner above for why this is the
    PRIMARY tag-extraction source, not a fallback).

    For every ``*.uasset`` under the discovered directory: read the raw
    bytes once, decode latin-1 (never raises — latin-1 maps every byte
    value), and extract printable-ASCII runs (``[\x20-\x7E]{4,}``).
    *label_pattern* gates which files proceed to the expensive tag-name
    work — reusing ``match_label()``'s exact substring/fnmatch semantics,
    applied per extracted run (a file "matches" if ANY of its runs
    matches the pattern) — keeping tag-decoding down to the hundreds of
    matched files instead of every file in the tree. For matched files,
    decoded tag names are the union of: an exact-set intersection between
    the file's extracted runs and *tag_class_set*'s keys, and a
    whole-word regex hit of any known tag name within the joined
    extracted text (via ``_known_tag_hits`` — the same signal the deep
    probe uses). Each hit's parents are resolved via
    ``resolve_parent_chain(name, class_map)``.

    Label attribution: if *live_labels* (exact label strings from a live
    scan) is given, a file is attributed to whichever of those strings
    appears EXACTLY as one of its extracted runs; multiple matches are
    ALL recorded (``actor_entry["ambiguous_labels"]``) rather than
    silently picking one. Otherwise (no *live_labels* — e.g. a headless
    run with no editor), the label is the best-effort pattern-matched
    extracted run itself. Every pattern-matched file becomes its own
    actor entry, even with zero tags decoded — never silently dropped.

    *progress_cb(done, total, path)* and *should_cancel()* are polled
    together every ``_CANCEL_POLL_INTERVAL`` files (same cheap-loop
    cadence as ``_find_verse_files`` — a plain byte-read + regex per
    file, no reflection calls, so per-file polling would be wasted
    overhead). Cancellation stops the walk immediately and returns
    whatever was already decoded, flagged ``cancelled: True`` — never
    discarded.

    Returns:
        ``{"status": "ok"|"error", "external_actors_dir": str|None,
        "dirs_tried": [str, ...], "files_total": int, "files_matched": int,
        "actors": [{"label", "file", "tags": [{"name", "parents",
        "source": "external_actors"}], "ambiguous_labels"?: [str,...]}],
        "cancelled": bool, "error": str|None}``

    On total discovery failure (no __ExternalActors__ directory found by
    any rung of the ladder), ``status`` is ``"error"``, ``actors`` is
    ``[]``, and *error* names every directory tried plus the
    ``UEFN_VERSE_PROJECT_DIR`` override — NEVER a clean/empty success
    shape (see docs/PATH-DISCOVERY.md). Never raises."""
    tag_class_set = tag_class_set or {}
    class_map = class_map or {}
    known_tag_names = list(tag_class_set.keys())
    live_label_set = set(live_labels) if live_labels else None

    dirs_tried = _discover_external_actors_dirs(verse_dir)
    external_actors_dir = next((d for d in dirs_tried if os.path.isdir(d)), None)

    if external_actors_dir is None:
        tried_desc = ", ".join(dirs_tried) if dirs_tried else "<no candidates — verse_dir was not resolved>"
        return {
            "status": "error",
            "external_actors_dir": None,
            "dirs_tried": dirs_tried,
            "files_total": 0,
            "files_matched": 0,
            "actors": [],
            "cancelled": False,
            "error": (
                "could not locate a __ExternalActors__ directory — tried: "
                + tried_desc + ". Set UEFN_VERSE_PROJECT_DIR to the "
                "project's VerseProject data root to override discovery."
            ),
        }

    all_files = []
    try:
        for dirpath, _dirnames, filenames in os.walk(external_actors_dir):
            for fn in filenames:
                if fn.endswith(".uasset"):
                    all_files.append(os.path.join(dirpath, fn))
    except Exception as e:
        return {
            "status": "error",
            "external_actors_dir": external_actors_dir,
            "dirs_tried": dirs_tried,
            "files_total": 0,
            "files_matched": 0,
            "actors": [],
            "cancelled": False,
            "error": "walking {!r} failed: {}".format(external_actors_dir, e),
        }

    files_total = len(all_files)
    files_matched = 0
    actors_out = []
    cancelled = False

    if progress_cb is not None:
        try:
            progress_cb(0, files_total, None)
        except Exception:
            pass

    for idx, fpath in enumerate(all_files):
        if idx > 0 and idx % _CANCEL_POLL_INTERVAL == 0:
            if should_cancel is not None and should_cancel():
                cancelled = True
                break
            if progress_cb is not None:
                try:
                    progress_cb(idx, files_total, fpath)
                except Exception:
                    pass

        try:
            with open(fpath, "rb") as f:
                raw_bytes = f.read()
        except Exception:
            continue

        text = raw_bytes.decode("latin-1", errors="ignore")
        runs = _PRINTABLE_RUN_RE.findall(text)
        if not runs:
            continue
        if not any(match_label(r, label_pattern) for r in runs):
            continue

        files_matched += 1
        run_set = set(runs)
        joined_text = "\n".join(runs)

        hit_names = run_set & set(known_tag_names)
        hit_names |= set(_known_tag_hits(joined_text, known_tag_names))

        tags_out = []
        for name in sorted(hit_names):
            chain = resolve_parent_chain(name, class_map, base="tag")
            tags_out.append({
                "name": name,
                "parents": list(chain) if chain else [],
                "source": "external_actors",
            })

        matched_live_labels = []
        if live_label_set:
            matched_live_labels = sorted(l for l in live_label_set if l in run_set)

        if matched_live_labels:
            label = matched_live_labels[0]
        else:
            label = next((r for r in runs if match_label(r, label_pattern)), runs[0])

        actor_entry = {"label": label, "file": fpath, "tags": tags_out}
        if len(matched_live_labels) > 1:
            actor_entry["ambiguous_labels"] = matched_live_labels
        actors_out.append(actor_entry)

    if progress_cb is not None and not cancelled:
        try:
            progress_cb(files_total, files_total, None)
        except Exception:
            pass

    return {
        "status": "ok",
        "external_actors_dir": external_actors_dir,
        "dirs_tried": dirs_tried,
        "files_total": files_total,
        "files_matched": files_matched,
        "actors": actors_out,
        "cancelled": cancelled,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Live (unreal-dependent) helpers
# ---------------------------------------------------------------------------

_VERSE_SCAN_SKIP = frozenset({"Saved", "Intermediate", "__pycache__", ".uefn_bridge"})
_MAX_VERSE_FILES = 4000

# ---------------------------------------------------------------------------
# Unbounded-scan safety caps.
#
# FIELD INCIDENT this section exists to fix: with an empty label_pattern,
# inspect_tags() walked EVERY level actor and, for every one of them, every
# component, and for every component every discoverable property name via
# get_editor_property — a reflection call. On a large project that is
# potentially millions of synchronous calls on UEFN's main thread with no
# ScopedSlowTask, no cancel, and no cap, so the editor froze solid for
# 15+ minutes with no way out. dependency_viewer.py hit the equivalent
# problem when its own enumeration went from six fixed classes to a full
# path-scoped walk (see its _MAX_ENUMERATED_ASSETS / _make_slow_task /
# _st_call / _NullSlowTask) — this section mirrors that fix rather than
# inventing a new approach.
#
# _MAX_ACTORS_EXAMINED caps how many label-matched actors are actually put
# through the expensive component/property walk. 5000 comfortably covers
# every real project seen so far (the field case that motivated this whole
# module had ~200 tagged actors) while still bounding an empty-pattern scan
# on a huge level to a finite, reportable amount of work.
#
# _MAX_COMPONENTS_PER_ACTOR / _MAX_PROPERTIES_PER_COMPONENT cap the true hot
# loop: per-actor, per-component, per-property reflection calls. 64
# components and 150 properties are both generous versus anything a real
# actor/component has been seen to carry, while turning the worst-case
# per-actor cost from "unbounded" into "at most 64 * 150 = 9600 reflection
# calls" — see _find_tag_component and _extract_tags_from_component.
#
# Every one of these, when hit, sets an explicit truncation/cap flag in the
# result — NEVER a silent cut-off. Silently capping a tag scan would
# recreate the exact false-negative this tool exists to prevent (see the
# module docstring's field case).
# ---------------------------------------------------------------------------
_MAX_ACTORS_EXAMINED = 5000
_MAX_COMPONENTS_PER_ACTOR = 64
_MAX_PROPERTIES_PER_COMPONENT = 150

# How often should_cancel() is polled inside the cheap loops (verse-file
# discovery, actor-label matching). Cheap because each individual iteration
# there is a single label read / filesystem stat, not a reflection call —
# polling every iteration would be wasted work, but a large interval would
# make Cancel feel unresponsive. The expensive actor/component walk below
# polls every single actor instead (see _inspect_tags_live), since caps
# already bound a single actor's worst-case cost to a small, fast unit of
# work (at most 9600 reflection calls, not millions).
_CANCEL_POLL_INTERVAL = 200


class _NullSlowTask:
    """No-op stand-in with the same call surface as unreal.ScopedSlowTask,
    used whenever the real API is unavailable or fails — callers never need
    to branch on which one they have. Copied verbatim from
    dependency_viewer.py's identical helper (see that file's module-level
    ScopedSlowTask comment) rather than reinventing it.

    Also a context manager (``__enter__``/``__exit__``) so it can stand in
    for ``unreal.ScopedSlowTask`` at a ``with`` call site without branching
    — see ``_make_slow_task``'s docstring for why ``destroy()`` was removed
    from this surface entirely rather than kept as another no-op."""

    def make_dialog(self, *_args, **_kwargs):
        pass

    def enter_progress_frame(self, *_args, **_kwargs):
        pass

    def should_cancel(self):
        return False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False


def _st_call(slow_task, method_name, *args, **kwargs):
    """Best-effort call of *method_name* on *slow_task*; swallows all
    errors so a partial/broken ScopedSlowTask implementation can never
    raise into the scan. Mirrors dependency_viewer.py's helper of the same
    name exactly."""
    try:
        fn = getattr(slow_task, method_name, None)
        if fn is None:
            return None
        return fn(*args, **kwargs)
    except Exception:
        return None


def _make_slow_task(total_work, description):
    """Best-effort unreal.ScopedSlowTask factory — returns a context
    manager, either a freshly-constructed (but NOT yet entered)
    ``unreal.ScopedSlowTask`` when the real API is present and construction
    succeeds, or ``_NullSlowTask()`` otherwise. Mirrors dependency_viewer.py's
    helper of the same name exactly.

    CRITICAL: ``unreal.ScopedSlowTask`` has NO ``destroy()`` method — it is
    a context manager (``__enter__`` opens the dialog machinery,
    ``__exit__`` tears it down). A previous version of this module called
    ``_st_call(task, "destroy")`` on every exit path; because ``_st_call``
    swallows exceptions, the missing-attribute failure was silently
    absorbed, so ``__exit__`` never ran, the progress dialog was never
    closed (orphaned on screen after the scan finished), and — since
    ``__enter__`` never ran either — ``enter_progress_frame``/
    ``should_cancel`` operated on a task that was never actually started,
    which is what produced a dialog stuck at 0% with an unresponsive
    Cancel button. Callers MUST consume this return value via a ``with``
    statement (never call ``.destroy()`` on it) so ``__exit__`` is
    guaranteed on every path — normal, cancel, or exception. ``make_dialog``
    is intentionally NOT called here; call it as the first statement inside
    the caller's own ``with`` block instead, once the task is actually
    entered."""
    try:
        cls = getattr(unreal, "ScopedSlowTask", None)
        if cls is not None:
            return cls(total_work, description)
    except Exception as e:
        try:
            unreal.log_warning(
                "tag_inspect: ScopedSlowTask unavailable ({}) — scanning "
                "without a progress dialog.".format(e)
            )
        except Exception:
            pass
    return _NullSlowTask()


def _resolve_verse_dir(project_dir):
    """Resolve the Verse source directory to scan. *project_dir* must
    already be validated as an existing directory by the caller (or None).
    Returns (verse_dir, source_label); verse_dir is None if nothing could
    be resolved. Honors an explicit, valid *project_dir* first; otherwise
    falls back to device_audit._find_verse_dir()'s discovery ladder. NEVER
    hardcodes a filename or project layout."""
    if project_dir:
        return project_dir, "explicit project_dir argument"
    if _find_verse_dir_fn is not None:
        try:
            found = _find_verse_dir_fn()
        except Exception:
            found = None
        if found:
            return found, "device_audit._find_verse_dir() discovery ladder"
    return None, None


def _find_verse_files(verse_dir, should_cancel=None):
    """Walk *verse_dir* for *.verse files, skipping the same generated-file
    dirs as device_audit.py/moderation_scanner.py. Capped at
    _MAX_VERSE_FILES; returns (paths, truncated, truncation_reason,
    cancelled).

    *should_cancel*, if given, is a zero-arg callable (typically
    ``lambda: _st_call(slow_task, "should_cancel")``) polled every
    _CANCEL_POLL_INTERVAL files encountered — cheap enough (a filesystem
    walk, no reflection calls) that polling every single file would be
    wasted work, but frequent enough that Cancel stays responsive on a
    project with a huge Content tree. On cancellation the walk stops
    immediately and whatever paths were already found are returned —
    partial data, never discarded (see module docstring's "never silently
    truncate" contract)."""
    paths = []
    truncated = False
    truncation_reason = None
    cancelled = False
    checked = 0
    try:
        for dirpath, dirnames, filenames in os.walk(verse_dir):
            dirnames[:] = [
                d for d in dirnames
                if d not in _VERSE_SCAN_SKIP and not d.startswith(".")
            ]
            for fn in filenames:
                if not fn.endswith(".verse"):
                    continue
                checked += 1
                if (
                    should_cancel is not None
                    and checked % _CANCEL_POLL_INTERVAL == 0
                    and should_cancel()
                ):
                    cancelled = True
                    truncation_reason = (
                        "cancelled by user during .verse file discovery "
                        "({} file(s) found so far)".format(len(paths))
                    )
                    return paths, truncated, truncation_reason, cancelled
                if len(paths) >= _MAX_VERSE_FILES:
                    truncated = True
                    truncation_reason = (
                        "hit the {}-file cap on .verse files scanned".format(_MAX_VERSE_FILES)
                    )
                    return paths, truncated, truncation_reason, cancelled
                paths.append(os.path.join(dirpath, fn))
    except Exception:
        pass
    return paths, truncated, truncation_reason, cancelled


def _read_verse_file_texts(paths, should_cancel=None):
    """Read every path in *paths* as text. *should_cancel*, if given, is
    polled every _CANCEL_POLL_INTERVAL files (same rationale as
    _find_verse_files). Returns (texts, cancelled) — texts read before
    cancellation are kept, not discarded."""
    texts = []
    cancelled = False
    for idx, p in enumerate(paths):
        if (
            should_cancel is not None
            and idx > 0
            and idx % _CANCEL_POLL_INTERVAL == 0
            and should_cancel()
        ):
            cancelled = True
            break
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                texts.append(f.read())
        except Exception:
            continue
    return texts, cancelled


def _get_component_property_names(obj):
    """Editor-gettable property names of *obj* (a component), pooled from
    every enumeration source available in this sibling set -- union,
    order-preserving, de-duplicated:
      1. device_audit._get_property_names(obj) -- the CDO-diffing
         enumerator, tried here against the COMPONENT rather than the
         actor device_audit itself always calls it with.
      2. property_inspector._get_property_names(obj) -- the Property
         Inspector's own enumerator. Kept as an independent source (not
         "if 1 fails use 2") in case either sibling module exposes a
         property the other's identical dir()-filter happens to miss for
         any reason (e.g. a getattr() that raises differently under one
         call site's object state vs another's).
      3. A local dir()-based LAST-RESORT fallback: same filter (skip
         private/dunder names, skip callables) as both sibling
         enumerators, used only when neither sibling source produced
         anything -- e.g. both are unavailable in a version-skewed sibling
         set, or genuinely raised for every name.
    Any source that raises is skipped individually; this never raises."""
    names = []
    seen = set()

    def _extend(source_names):
        for n in source_names:
            if n not in seen:
                seen.add(n)
                names.append(n)

    if _da_get_property_names is not None:
        try:
            _extend(_da_get_property_names(obj))
        except Exception:
            pass

    if _pi_get_property_names is not None:
        try:
            _extend(_pi_get_property_names(obj))
        except Exception:
            pass

    if not names:
        for name in dir(obj):
            if name.startswith("_"):
                continue
            try:
                attr = getattr(obj, name)
            except Exception:
                continue
            if callable(attr):
                continue
            if name not in seen:
                seen.add(name)
                names.append(name)

    return names


def _component_class_could_carry_tags(class_name):
    """FAST REJECT gate: a single cheap, name-only check — one
    case-insensitive substring test, zero ``get_editor_property`` calls —
    used to decide whether a component is even worth the expensive
    per-property probe in ``_extract_tags_from_component``. This is what
    bounds the true hot loop: without it, EVERY component on EVERY matched
    actor gets fully probed regardless of whether it has anything to do
    with tags (the freeze this module exists to fix).

    Deliberately widens this module's own pre-existing phase-1 "versetag"
    substring heuristic (see ``_find_tag_component``) rather than inventing
    an unrelated new one — the real, field-confirmed component is
    ``VerseTagMarkupComponent``, an Epic-provided class whose name is not
    something a project can rename, so "tag" appearing in a component's
    class name is a safe, cheap, high-recall gate in practice. This is a
    narrowing of the previous "probe literally every component" fallback
    and trades a small amount of recall (a tag container living on a
    component whose class name does not contain "tag" at all would now be
    missed) for making an empty-label-pattern scan on a large level
    tractable at all — see the module's field incident note in
    ``_MAX_ACTORS_EXAMINED``'s comment block."""
    if not class_name:
        return False
    return "tag" in class_name.lower()


def _looks_like_tag_container(value):
    """Best-effort structural check: does *value* look like a
    GameplayTagContainer-ish object? Detected by SHAPE, never by property
    NAME (see module docstring -- literal name guesses like "Tags" have
    already failed as get_editor_property targets in the field):
      * exposes ``.gameplay_tags`` (the FGameplayTagContainer Python
        wrapper's own accessor), or
      * is a plain list/tuple, or
      * is any OTHER non-string, non-mapping iterable. This last branch is
        the fix for a real gap: the UE Python API's ``unreal.Array`` wraps
        a native TArray and supports the same iteration protocol as a
        list, but is NOT itself a subclass of ``list``/``tuple`` -- the
        previous isinstance-only check silently rejected exactly that
        shape, which is a very plausible reason a real, populated tag
        array property was never recognized (component_class discovered,
        tag_property stayed null) against a live UEFN actor."""
    if value is None:
        return False
    if isinstance(value, (str, bytes)):
        return False
    if hasattr(value, "gameplay_tags"):
        return True
    if isinstance(value, (list, tuple)):
        return True
    if isinstance(value, dict):
        return False
    try:
        iter(value)
    except TypeError:
        return False
    return True


def _iter_tag_container_values(container):
    """Yield raw tag values out of *container*, handling both a
    ``.gameplay_tags``-bearing container object and a plain list/tuple.

    Deliberately does NOT swallow a ``TypeError`` raised while iterating
    *container* itself (only the ``.gameplay_tags``-accessor attempt is
    guarded, as a fall-through to the direct-iteration attempt below) --
    letting it propagate is what lets ``_try_iter_tag_container_values``
    distinguish "iterated fine, zero items" from "could not iterate at
    all" instead of both cases masquerading as an empty container. A bare
    ``str``/``bytes`` value is technically iterable character-by-character
    but is never a real tag list, so it is rejected the same way (raises
    ``TypeError``) rather than silently yielding individual characters as
    "tags"."""
    if container is None:
        return
    inner = getattr(container, "gameplay_tags", None)
    if inner is not None:
        try:
            for t in inner:
                yield t
            return
        except TypeError:
            pass
    if isinstance(container, (list, tuple)):
        for t in container:
            yield t
        return
    if isinstance(container, (str, bytes)):
        raise TypeError("string/bytes value is not a tag container")
    for t in container:
        yield t


def _try_iter_tag_container_values(container):
    """Materialize ``_iter_tag_container_values(container)`` into a list,
    distinguishing "iterated fine, zero items" (``iterated_ok=True``,
    ``items=[]``) from "could not iterate at all" (``iterated_ok=False``,
    ``items=[]``). A bare ``try/except`` around just the generator *call*
    cannot make this distinction -- a generator function does not run any
    of its body (and so cannot raise) until its first ``next()`` -- which
    is exactly the bug this wrapper exists to close: a previous version's
    ``except TypeError: return`` inside the generator itself reported
    "could not iterate" as "iterated fine, zero tags", the identical
    false-negative shape this module exists to prevent. Returns
    ``(items, iterated_ok)``; never raises."""
    items = []
    try:
        for value in _iter_tag_container_values(container):
            items.append(value)
        return items, True
    except TypeError:
        return items, False
    except Exception:
        return items, False


_MAX_DIAGNOSTIC_PROPERTIES = 40
_DIAGNOSTIC_VALUE_MAX_LEN = 80
_EXTRACTION_DEBUG_MAX_LEN = 200


def _truncate_diag(text, max_len=_DIAGNOSTIC_VALUE_MAX_LEN):
    """Hard-truncate *text* to *max_len* characters (never a full dump into
    the discovery/extraction-debug report -- a component can carry large
    struct/array reprs). Never raises."""
    try:
        text = text if isinstance(text, str) else str(text)
    except Exception:
        return "<unrepresentable>"
    if len(text) > max_len:
        return text[: max_len - 3] + "..."
    return text


def _safe_str(value):
    """Best-effort ``str(value)``; never raises."""
    try:
        return str(value)
    except Exception:
        return None


def _value_contains_known_tag(value_repr, known_tag_names):
    """True if *value_repr* (a property value's str()/repr() form) contains
    one of *known_tag_names* as a whole-word substring. *known_tag_names*
    is the set of tag class names this SAME project's own Verse source
    actually declared (see ``build_tag_class_set``) -- grounded in real,
    already-discovered project data, not a generic hardcoded prefix or
    property-name guess. This is the strongest available detection signal:
    a property whose printed value literally names a tag this project
    declared almost certainly IS the tag container, regardless of its own
    property name or exact Python type."""
    if not value_repr or not known_tag_names:
        return False
    for tag_name in known_tag_names:
        if tag_name and re.search(r"\b" + re.escape(tag_name) + r"\b", value_repr):
            return True
    return False


_EXPORT_TEXT_TAGNAME_RE = re.compile(r'TagName\s*=\s*"([^"]+)"')


def _decode_winner_tags(winner_value, known_tag_names, refetch_error=None):
    """Multi-strategy decode of raw tag names out of *winner_value* (the
    already-selected tag-container property value), tried in order,
    stopping at the first strategy that positively yields >=1 tag name:

      (a)/(b) Iterate ``.gameplay_tags`` if present, else iterate the value
          directly (``_try_iter_tag_container_values`` — see that
          function's docstring for why it, not a bare ``_iter_tag_container
          _values`` call, is what makes "iterated fine, zero items" a
          distinct outcome from "could not iterate at all").
      (c) ``unreal.StructBase.export_text()`` (guarded — may not exist on
          this value's type at all): parsed both for ``TagName="..."``
          occurrences and, if none matched, for whole-word hits against
          *known_tag_names* within the exported text.
      (d) Whole-word match of *known_tag_names* against the value's own
          repr/str form — the same signal ``_value_contains_known_tag``
          uses for property SELECTION, now applied to VALUE decoding. This
          is what recovers a single-tag plain-string property (the old
          "content-hit-but-non-iterable" special case), and — unlike the
          old special case — applies uniformly whether the winner was
          selected via content match or shape match.

    *refetch_error*, if given, is the exception CLASS NAME from a caller's
    defensive re-fetch of the winner property that raised (see
    ``_extract_tags_from_component``) -- folded into ``debug["note"]`` so
    a ``winner_value is None`` case is traceable to why.

    Returns ``(raw_names, status, debug)`` where *status* is:
      "ok"         -- >=1 tag decoded by some strategy.
      "empty"      -- a strategy POSITIVELY iterated the container and
                       found zero entries (container genuinely empty, not
                       merely unreadable).
      "unreadable" -- no strategy could decode anything; *debug* carries
                       the value's python type name, a repr truncated to
                       ``_EXTRACTION_DEBUG_MAX_LEN`` chars, and (if
                       available) a truncated export_text() snippet, so
                       the NEXT run's report is actionable instead of a
                       dead end (see module docstring's field case).
                       ``winner_value is None`` ALWAYS lands here, never
                       "empty" -- "empty" is reserved for a strategy that
                       POSITIVELY iterated a real container down to zero
                       entries, which cannot happen when there was no
                       value to iterate at all (e.g. a failed defensive
                       re-fetch — see *refetch_error*)."""
    debug = {
        "type_name": type(winner_value).__name__ if winner_value is not None else None,
        "value_repr": _truncate_diag(repr(winner_value), _EXTRACTION_DEBUG_MAX_LEN) if winner_value is not None else None,
    }
    if refetch_error is not None:
        debug["note"] = "defensive re-fetch of the winner property raised {}".format(refetch_error)

    if winner_value is None:
        return [], "unreadable", debug

    items, iterated_ok = _try_iter_tag_container_values(winner_value)
    if iterated_ok:
        names = []
        for raw in items:
            try:
                normalized = normalize_tag_name(str(raw))
            except Exception:
                continue
            if normalized:
                names.append(normalized)
        if names:
            return names, "ok", debug
        if items:
            # Iterated fine and produced entries, but every one normalized
            # to an empty string -- that is an opaque/unreadable entry
            # shape, not a genuinely empty container.
            return [], "unreadable", debug
        return [], "empty", debug

    export_fn = getattr(winner_value, "export_text", None)
    if export_fn is not None:
        try:
            export_text = export_fn()
        except Exception:
            export_text = None
        if export_text:
            debug["export_text"] = _truncate_diag(export_text, _EXTRACTION_DEBUG_MAX_LEN)
            names = [normalize_tag_name(n) for n in _EXPORT_TEXT_TAGNAME_RE.findall(export_text)]
            names = [n for n in names if n]
            if not names and known_tag_names:
                names = [
                    t for t in known_tag_names
                    if t and re.search(r"\b" + re.escape(t) + r"\b", export_text)
                ]
            if names:
                return names, "ok", debug

    if known_tag_names:
        for source in (debug.get("value_repr"), _safe_str(winner_value)):
            if not source:
                continue
            hits = [
                t for t in known_tag_names
                if t and re.search(r"\b" + re.escape(t) + r"\b", source)
            ]
            if hits:
                return hits, "ok", debug

    return [], "unreadable", debug


def _extract_tags_from_component(comp, known_tag_names=None):
    """Scan *comp*'s editor properties (via ``_get_component_property_names``,
    the pooled multi-source enumerator) to find the tag-container property
    and extract normalized tag names from it via ``_decode_winner_tags``.

    Two independent detection signals select the WINNER property, in order
    of confidence:
      1. CONTENT match (``_value_contains_known_tag``) -- the property's
         printed value contains one of *known_tag_names*, this project's
         own discovered Verse tag class names. Strongest signal: grounded
         in real project data, wins immediately when found.
      2. SHAPE match (``_looks_like_tag_container``) -- the value looks
         like a tag container structurally. Property NAME is never the
         deciding factor for either signal; among MULTIPLE shape-only
         candidates (no content match available, e.g. *known_tag_names* is
         empty because verse_dir could not be resolved) a name containing
         "tag" is used only as a last tie-break, never as the sole basis.

    Returns ``(tag_property_name_or_None, [raw_tag_name, ...],
    diagnostics)`` where ``diagnostics`` is
    ``{"properties": [{"name", "type", "value_repr"}, ...], "capped": bool,
    "properties_probed": int, "properties_probe_capped": bool,
    "property_read_errors": [{"name", "exception_class"}, ...],
    "extraction_status": "ok"|"empty"|"unreadable"|None,
    "extraction_debug": {...}|None}``.

    ``properties`` covers EVERY property this scan saw on *comp* (capped at
    ``_MAX_DIAGNOSTIC_PROPERTIES``, each value_repr hard-truncated to
    ``_DIAGNOSTIC_VALUE_MAX_LEN`` chars) -- populated UNCONDITIONALLY, not
    only on failure, so a caller can always surface it. ``property_read_
    errors`` records every ``get_editor_property`` call that raised
    (property name + exception class name) instead of silently skipping it
    (a bare ``except Exception: continue`` previously discarded these).
    This is what turns a dead ``tag_property: null`` into an actionable
    report (see module docstring's field case and ``inspect_tags``'s
    discovery contract).

    ``extraction_status``/``extraction_debug`` are set from
    ``_decode_winner_tags`` once a winner property is identified; both stay
    ``None`` when no property was identified as the tag container at all
    (``tag_property_name_or_None`` is also ``None`` in that case — the
    caller distinguishes "no candidate property" from "candidate property
    found but unreadable").

    ``properties_probe_capped`` is distinct from ``capped``: ``capped``
    means the *diagnostics listing* stopped recording past
    ``_MAX_DIAGNOSTIC_PROPERTIES`` entries (cosmetic — the probe kept
    going), while ``properties_probe_capped`` means the actual
    ``get_editor_property`` reflection-call loop itself stopped after
    ``_MAX_PROPERTIES_PER_COMPONENT`` properties — the real hot-loop cap
    this function exists to enforce (see the field incident described next
    to ``_MAX_PROPERTIES_PER_COMPONENT``'s definition). A component with
    more properties than that cap may have its true tag-container property
    missed; this flag makes that possibility explicit rather than silent."""
    known_tag_names = known_tag_names or ()
    diagnostic_props = []
    capped = False
    probed = 0
    properties_probe_capped = False
    property_read_errors = []
    content_hit_name = None
    shape_candidates = []  # [(name, value), ...]

    for name in _get_component_property_names(comp):
        if probed >= _MAX_PROPERTIES_PER_COMPONENT:
            properties_probe_capped = True
            break
        probed += 1
        try:
            value = comp.get_editor_property(name)
        except Exception as e:
            property_read_errors.append({"name": name, "exception_class": type(e).__name__})
            continue

        try:
            value_repr = repr(value)
        except Exception:
            value_repr = "<unrepresentable>"
        try:
            type_name = type(value).__name__
        except Exception:
            type_name = "<unknown>"

        if len(diagnostic_props) < _MAX_DIAGNOSTIC_PROPERTIES:
            diagnostic_props.append({
                "name": name,
                "type": type_name,
                "value_repr": _truncate_diag(value_repr),
            })
        else:
            capped = True

        if content_hit_name is None and _value_contains_known_tag(value_repr, known_tag_names):
            content_hit_name = name

        if _looks_like_tag_container(value):
            shape_candidates.append((name, value))

    diagnostics = {
        "properties": diagnostic_props,
        "capped": capped,
        "properties_probed": probed,
        "properties_probe_capped": properties_probe_capped,
        "property_read_errors": property_read_errors,
        "extraction_status": None,
        "extraction_debug": None,
    }

    winner_name = None
    winner_value = None
    refetch_error = None
    if content_hit_name is not None:
        winner_name = content_hit_name
        for cand_name, cand_value in shape_candidates:
            if cand_name == content_hit_name:
                winner_value = cand_value
                break
        if winner_value is None:
            # Content matched on a property that didn't also shape-match
            # (e.g. a plain string field) -- still honor the content hit;
            # re-fetch defensively rather than trusting a stale local.
            try:
                winner_value = comp.get_editor_property(content_hit_name)
            except Exception as e:
                property_read_errors.append({"name": content_hit_name, "exception_class": type(e).__name__})
                winner_value = None
                refetch_error = type(e).__name__
    elif shape_candidates:
        if len(shape_candidates) == 1:
            winner_name, winner_value = shape_candidates[0]
        else:
            tag_named = [c for c in shape_candidates if "tag" in c[0].lower()]
            winner_name, winner_value = tag_named[0] if tag_named else shape_candidates[0]

    if winner_name is None:
        return None, [], diagnostics

    names, status, debug = _decode_winner_tags(winner_value, known_tag_names, refetch_error=refetch_error)
    diagnostics["extraction_status"] = status
    if status == "unreadable":
        diagnostics["extraction_debug"] = debug

    return winner_name, names, diagnostics


def _find_tag_component(actor, known_tag_names=None):
    """Locate the Verse-tag-bearing component on *actor*, generically —
    the class/property names are NEVER hardcoded (see module docstring).
    Preference order:
      1. A component whose class name contains "VerseTag" (case-
         insensitive) — e.g. the real, field-confirmed
         ``VerseTagMarkupComponent``. Once such a component is found this
         is returned IMMEDIATELY, whether or not property extraction on it
         succeeds — its ``diagnostics`` are what lets a failed extraction
         on the correct component still be actionable (see
         ``_extract_tags_from_component``), rather than silently falling
         through to a generic component that happens to shape-match.
      2. FAST-REJECT-GATED fallback: any OTHER component whose class name
         cheaply looks tag-related (see
         ``_component_class_could_carry_tags`` — a single substring check,
         zero reflection calls) is fully probed for a property whose value
         looks like a GameplayTagContainer (``_looks_like_tag_container``)
         or contains a known tag name (``_value_contains_known_tag``).
         Components that fail the cheap gate are NEVER probed at all —
         this is what bounds the true hot loop (see
         ``_MAX_ACTORS_EXAMINED``'s comment block for the field incident
         this fixes).

    Also enforces ``_MAX_COMPONENTS_PER_ACTOR``: only the first N
    components returned by the engine are considered at all;
    ``diagnostics["components_examined_capped"]`` reports if this actor had
    more than that.

    Returns ``(component, class_name, tag_property_name, [raw_tag_name,...],
    diagnostics)`` — component is None (has_verse_tag_component: False
    case) when neither preference found anything on this actor.
    ``diagnostics["fast_rejected"]`` is True specifically when phase 2 was
    skipped entirely because no component passed the cheap class-name gate
    — distinct from "phase 2 ran and genuinely found nothing"."""
    try:
        components = list(actor.get_components_by_class(unreal.ActorComponent))
    except Exception:
        components = []

    components_capped = len(components) > _MAX_COMPONENTS_PER_ACTOR
    if components_capped:
        components = components[:_MAX_COMPONENTS_PER_ACTOR]

    candidates = []
    for comp in components:
        try:
            class_name = comp.get_class().get_name()
        except Exception:
            class_name = "<component>"
        candidates.append((comp, class_name))

    base_diag_extra = {
        "components_examined": len(candidates),
        "components_examined_capped": components_capped,
    }

    for comp, class_name in candidates:
        if "versetag" in class_name.lower():
            prop_name, names, diagnostics = _extract_tags_from_component(comp, known_tag_names)
            diagnostics.update(base_diag_extra)
            diagnostics["fast_rejected"] = False
            return comp, class_name, prop_name, names, diagnostics

    # FAST REJECT: cheap, class-name-only gate applied BEFORE any expensive
    # per-property probing — see _component_class_could_carry_tags. An
    # actor whose components all fail this gate never triggers a single
    # get_editor_property call for phase 2.
    tag_hint_candidates = [
        (comp, class_name) for comp, class_name in candidates
        if _component_class_could_carry_tags(class_name)
    ]
    if not tag_hint_candidates:
        diagnostics = {"properties": [], "capped": False, "fast_rejected": True}
        diagnostics.update(base_diag_extra)
        return None, None, None, [], diagnostics

    for comp, class_name in tag_hint_candidates:
        prop_name, names, diagnostics = _extract_tags_from_component(comp, known_tag_names)
        diagnostics.update(base_diag_extra)
        diagnostics["fast_rejected"] = False
        if prop_name is not None:
            return comp, class_name, prop_name, names, diagnostics

    diagnostics = {"properties": [], "capped": False, "fast_rejected": False}
    diagnostics.update(base_diag_extra)
    return None, None, None, [], diagnostics


def _get_all_actors():
    """All level actors via EditorActorSubsystem — reproduces
    uefn_bridge.py's own ``_get_all_actors()`` one-liner locally rather
    than importing uefn_bridge.py, which has a real side effect (auto-
    starts the bridge's tick/poll loop on import — see bridge_paths.py's
    module docstring for why every sibling tool avoids that import)."""
    subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    if subsystem is None:
        raise RuntimeError("could not get EditorActorSubsystem")
    return subsystem.get_all_level_actors()


_DEEP_PROBE_MAX_ACTORS = 3
_DEEP_PROBE_SNIPPET_LEN = 200


def _known_tag_hits(text, known_tag_names):
    """Every entry of *known_tag_names* that whole-word-matches *text* --
    same signal as ``_value_contains_known_tag``, but returning the actual
    list of hits (not just a bool) for deep-probe diagnostics. Never
    raises."""
    if not text or not known_tag_names:
        return []
    hits = []
    for tag_name in known_tag_names:
        if tag_name and re.search(r"\b" + re.escape(tag_name) + r"\b", text):
            hits.append(tag_name)
    return hits


def _describe_value_for_deep_probe(value, known_tag_names):
    """Best-effort ``{"type_name", "value_repr", "export_text",
    "known_tag_hits"}`` description of *value* for deep-probe diagnostics.
    ``"export_text"`` is present only when the value exposes a working
    ``export_text()`` (guarded — may not exist on this type at all).
    ``known_tag_hits`` is computed over the repr + export_text text so a
    hit is found regardless of which representation actually carries it.
    Never raises."""
    info = {
        "type_name": type(value).__name__ if value is not None else None,
        "value_repr": _truncate_diag(repr(value), _DEEP_PROBE_SNIPPET_LEN) if value is not None else None,
    }
    export_text = None
    if value is not None:
        export_fn = getattr(value, "export_text", None)
        if export_fn is not None:
            try:
                export_text = export_fn()
            except Exception:
                export_text = None
    if export_text:
        info["export_text"] = _truncate_diag(export_text, _DEEP_PROBE_SNIPPET_LEN)
    hit_source = " ".join(filter(None, [info.get("value_repr"), info.get("export_text")]))
    info["known_tag_hits"] = _known_tag_hits(hit_source, known_tag_names)
    return info


def _deep_probe_actor_context(actor, component_count):
    """Cheap, guarded, best-effort per-actor context signals for the
    world-streaming/world-partition hypothesis (a user suspected the
    R8-only decode pattern was a streaming effect — only R8's cell fully
    loaded, other rooms' actors enumerate but read hollow). Each signal is
    read in its own try/except, appending ``{"where", "exception_class"}``
    to this context's OWN ``"errors"`` list on failure rather than
    raising — one unavailable signal must never blank the rest. Kept
    separate from the caller's per-property ``finding["errors"]`` list
    (rather than merged into it) so property-probe error counts stay
    exactly what they were before this field existed. A signal this scan
    could not read at all is recorded as the string ``"unavailable"``,
    never silently omitted.

    NOTE: raw package-name inequality is deliberately NOT treated as
    streaming evidence anywhere this context feeds into (see
    ``_compare_deep_probe_contexts``) — in UE5 World Partition, every
    external actor lives in its OWN package (one file per actor) by
    design, so package names differ between ANY two actors regardless of
    streaming state; that signal would always fire and would be
    meaningless. The package name is still recorded here as raw data for
    completeness, just never used as the sole basis for a verdict.

    Returns a context dict: ``{"class_name": {"py_type", "ue_class"},
    "package", "path_name", "data_layers", "component_count", "folder",
    "errors"}``. Never raises."""
    context = {
        "class_name": None,
        "package": "unavailable",
        "path_name": "unavailable",
        "data_layers": "unavailable",
        "component_count": component_count,
        "folder": "unavailable",
        "errors": [],
    }
    errors_out = context["errors"]

    py_type = None
    ue_class = None
    try:
        py_type = type(actor).__name__
    except Exception as e:
        errors_out.append({"where": "context.class_name(py)", "exception_class": type(e).__name__})
    try:
        ue_class = actor.get_class().get_name()
    except Exception as e:
        errors_out.append({"where": "context.class_name(ue)", "exception_class": type(e).__name__})
    context["class_name"] = {"py_type": py_type, "ue_class": ue_class}

    try:
        outer_fn = getattr(actor, "get_outermost", None)
        pkg_fn = getattr(actor, "get_package", None)
        if outer_fn is not None:
            context["package"] = outer_fn().get_name()
        elif pkg_fn is not None:
            context["package"] = pkg_fn().get_name()
    except Exception as e:
        errors_out.append({"where": "context.package", "exception_class": type(e).__name__})

    try:
        path_name_fn = getattr(actor, "get_path_name", None)
        if path_name_fn is not None:
            context["path_name"] = _truncate_diag(path_name_fn(), 200)
    except Exception as e:
        errors_out.append({"where": "context.path_name", "exception_class": type(e).__name__})

    for attempt_name in ("data_layer_assets", "data_layers", "actor_data_layers"):
        try:
            value = actor.get_editor_property(attempt_name)
        except Exception:
            continue
        if value is None:
            continue
        try:
            if hasattr(value, "__iter__") and not isinstance(value, (str, bytes)):
                items = list(value)
            else:
                items = [value]
            context["data_layers"] = [_truncate_diag(repr(item), 100) for item in items]
        except Exception as e:
            errors_out.append({"where": "context.data_layers", "exception_class": type(e).__name__})
            context["data_layers"] = [_truncate_diag(repr(value), 150)]
        break

    try:
        folder_fn = getattr(actor, "get_folder_path", None)
        if folder_fn is not None:
            context["folder"] = str(folder_fn())
    except Exception as e:
        errors_out.append({"where": "context.folder", "exception_class": type(e).__name__})

    return context


def _values_effectively_differ(a, b):
    """True if context-signal values *a*/*b* meaningfully differ.
    ``"unavailable"`` on BOTH sides is NOT a difference — nothing was
    actually compared, so it must never read as streaming evidence."""
    if a == "unavailable" and b == "unavailable":
        return False
    return a != b


def _compare_deep_probe_contexts(contrast_finding, non_decoded_findings):
    """Compare the contrast (decoded-ok) actor's deep-probe context
    against the non-decoded actors' contexts to test the world-streaming/
    world-partition hypothesis, returning a one-line discovery note.

    Deliberately does NOT use raw package-name inequality as evidence —
    see ``_deep_probe_actor_context``'s docstring for why that signal is
    meaningless in World Partition. The verdict rests only on:
      * ``data_layers`` differing between the contrast actor and a
        non-decoded actor,
      * ``folder`` differing (rooms are likely folder-organized, so this
        also surfaces plain room-grouping),
      * a "hollow actor" signal — a non-decoded actor's component_count
        is at most half the contrast actor's, OR most of its tag-
        component properties read empty/None/default where the contrast
        actor's mostly don't (a plausible signature of an actor whose
        streaming cell never fully loaded).
    Never raises."""
    contrast_ctx = contrast_finding.get("context") or {}
    contrast_layers = contrast_ctx.get("data_layers")
    contrast_folder = contrast_ctx.get("folder")
    contrast_comp_count = contrast_ctx.get("component_count")
    contrast_props = (contrast_finding.get("tag_component") or {}).get("properties") or []

    def _looks_empty(prop):
        vr = (prop.get("value_repr") or "").strip()
        return vr in ("", "None", "[]", "()") or vr.lower().startswith("none")

    contrast_empty_ratio = (
        sum(1 for p in contrast_props if _looks_empty(p)) / len(contrast_props)
        if contrast_props else None
    )

    layer_diff_labels = []
    folder_diff_labels = []
    hollow_labels = []

    for f in non_decoded_findings:
        ctx = f.get("context") or {}
        label = f.get("actor_label", "<unlabeled>")

        if _values_effectively_differ(ctx.get("data_layers"), contrast_layers):
            layer_diff_labels.append(label)
        if _values_effectively_differ(ctx.get("folder"), contrast_folder):
            folder_diff_labels.append(label)

        nd_count = ctx.get("component_count")
        is_hollow = False
        if isinstance(nd_count, int) and isinstance(contrast_comp_count, int) and contrast_comp_count > 0:
            if nd_count <= max(1, contrast_comp_count // 2):
                is_hollow = True

        nd_props = (f.get("tag_component") or {}).get("properties") or []
        if not is_hollow and nd_props and contrast_empty_ratio is not None:
            nd_empty_ratio = sum(1 for p in nd_props if _looks_empty(p)) / len(nd_props)
            if nd_empty_ratio >= 0.8 and contrast_empty_ratio < 0.5:
                is_hollow = True

        if is_hollow:
            hollow_labels.append(label)

    diff_bits = []
    if layer_diff_labels:
        diff_bits.append("data_layers differ for " + ", ".join(layer_diff_labels[:5]))
    if folder_diff_labels:
        diff_bits.append("folder differs for " + ", ".join(folder_diff_labels[:5]))
    if hollow_labels:
        diff_bits.append(
            "hollow-actor signal (low component count or mostly-empty "
            "properties vs the contrast actor) for " + ", ".join(sorted(set(hollow_labels))[:5])
        )

    if diff_bits:
        return (
            "context differs between decoded and non-decoded actors "
            "(possible world streaming/partition effect): " + "; ".join(diff_bits) + "."
        )
    return "contexts are identical — streaming is unlikely to explain the difference."


def _deep_probe_actor(label, actor, known_tag_names):
    """Deep-probe ONE matched actor for tag data outside the normal
    extraction path — a last-resort diagnostic triggered only when the
    normal walk found tag components on matched actors but decoded ZERO
    tags from ANY of them, from ANY source (see ``_inspect_tags_live``'s
    deep-probe trigger). Records, bounded by the SAME caps as the normal
    walk (``_MAX_COMPONENTS_PER_ACTOR`` / ``_MAX_PROPERTIES_PER_COMPONENT``
    — no new unbounded reflection loop):
      1. EVERY probed property on the actor's tag component (if any),
         full dump — name/type/repr/export_text/known_tag_hits.
      2. The actor's own ``tags`` property (AActor::Tags), same full
         dump treatment.
      3. Every OTHER component's properties, but only entries that
         POSITIVELY hit a known tag name are kept (unlike 1/2, this is
         not a full dump — otherwise 63 other components * 150
         properties would be reported in full for no diagnostic value).

    A probe read that raises is recorded in the finding's ``errors`` list
    (``{"where", "exception_class"}``) rather than aborting the rest of
    this actor's probe or silently vanishing — one bad property must never
    blank the remaining diagnostics for the same actor.

    Also captures ``"context"`` (see ``_deep_probe_actor_context``) — cheap
    signals (class name, package, path, data layers, component count,
    folder) used to test the world-streaming/world-partition hypothesis
    for why some rooms' actors decode and others don't (see
    ``_compare_deep_probe_contexts``).

    Returns a finding dict:
      {"actor_label": str, "context": {...}, "tag_component":
       {"class_name", "properties": [...]} | None, "actor_tags_property":
       {...} | None, "other_components_hits": [...], "errors": [...]}"""
    finding = {
        "actor_label": label,
        "context": None,
        "tag_component": None,
        "actor_tags_property": None,
        "other_components_hits": [],
        "errors": [],
    }

    try:
        components = list(actor.get_components_by_class(unreal.ActorComponent))
    except Exception as e:
        finding["errors"].append({"where": "get_components_by_class", "exception_class": type(e).__name__})
        components = []
    components = components[:_MAX_COMPONENTS_PER_ACTOR]

    finding["context"] = _deep_probe_actor_context(actor, len(components))

    tag_comp = None
    tag_comp_class = None
    other_comps = []
    for comp in components:
        try:
            class_name = comp.get_class().get_name()
        except Exception as e:
            finding["errors"].append({"where": "component.get_class", "exception_class": type(e).__name__})
            continue
        if tag_comp is None and "versetag" in class_name.lower():
            tag_comp = comp
            tag_comp_class = class_name
        else:
            other_comps.append((comp, class_name))

    if tag_comp is not None:
        properties = []
        probed = 0
        for name in _get_component_property_names(tag_comp):
            if probed >= _MAX_PROPERTIES_PER_COMPONENT:
                break
            probed += 1
            try:
                value = tag_comp.get_editor_property(name)
            except Exception as e:
                finding["errors"].append({
                    "where": "tag_component.{}".format(name),
                    "exception_class": type(e).__name__,
                })
                continue
            desc = _describe_value_for_deep_probe(value, known_tag_names)
            desc["name"] = name
            properties.append(desc)
        finding["tag_component"] = {"class_name": tag_comp_class, "properties": properties}

    try:
        actor_tags_value = actor.get_editor_property("tags")
    except Exception as e:
        finding["errors"].append({"where": "actor.tags", "exception_class": type(e).__name__})
    else:
        finding["actor_tags_property"] = _describe_value_for_deep_probe(actor_tags_value, known_tag_names)

    for comp, class_name in other_comps:
        probed = 0
        for name in _get_component_property_names(comp):
            if probed >= _MAX_PROPERTIES_PER_COMPONENT:
                break
            probed += 1
            try:
                value = comp.get_editor_property(name)
            except Exception as e:
                finding["errors"].append({
                    "where": "{}.{}".format(class_name, name),
                    "exception_class": type(e).__name__,
                })
                continue
            desc = _describe_value_for_deep_probe(value, known_tag_names)
            if desc["known_tag_hits"]:
                finding["other_components_hits"].append({
                    "component_class": class_name,
                    "property": name,
                    "value_repr": desc.get("value_repr"),
                    "export_text": desc.get("export_text"),
                    "known_tag_hits": desc["known_tag_hits"],
                })

    return finding


def _inspect_tags_live(label_pattern, project_dir, include_location=False,
                        max_results=None, offset=None):
    """The live (unreal-dependent) inspection path. Only called when
    ``_HAS_UNREAL`` is True; every editor call is individually guarded.

    *include_location*: when True, each actor entry additionally carries
    "location" ({"x","y","z"}) or "location_error" (str) -- see
    ``inspect_tags``'s docstring for the full contract. Resolved inline
    during the phase-2 walk below, from the SAME ``actor`` object already
    being examined for tags -- no second actor-matching pass.

    *max_results* / *offset* (p3-t5): when EITHER is given, this activates
    the PAGE-AWARE WALK -- only the actors in the requested
    [offset, offset+max_results) window (of the label-matched list,
    stably sorted by label) are put through the expensive phase-2
    component/property reflection walk at all; actors outside the window
    are never probed in this call. See the "Actor-count cap vs.
    PAGE-AWARE WALK" comment block inline below for the full mutual-
    exclusion contract with ``_MAX_ACTORS_EXAMINED``. When both are
    ``None`` (the default), behavior is byte-identical to before this
    parameter pair existed. The returned dict carries an additional
    ``"page_extra"`` key (a dict: ``{"offset", "returned"}`` plus
    ``"next_offset"`` when another page remains) whenever paging was
    requested -- ``inspect_tags`` merges those into the top-level result
    alongside ``"matched"`` (the true full matched-actor total, from
    ``scan_stats["actors_matched"]``, which costs nothing extra since
    phase 1 already computed it).

    Runs in TWO SEQUENTIAL ``with unreal.ScopedSlowTask(...) as task:``
    blocks — phase 1 (verse-file scan + actor-label matching) and phase 2
    (the expensive actor/component walk) — each with its OWN progress
    dialog. This is a deliberate rewrite of a previous single-task version
    that called ``_st_call(slow_task, "destroy")`` on every exit path:
    ``unreal.ScopedSlowTask`` has NO ``destroy()`` method (see
    ``_make_slow_task``'s docstring), so that call always silently no-op'd
    through ``_st_call``'s exception-swallowing, the dialog's ``__exit__``
    never ran, and the task was never ``__enter__``'d either — producing a
    progress dialog stuck at 0% that outlived the scan, with a Cancel
    button wired to a ``should_cancel()`` that likewise never worked. A
    ``with`` block guarantees ``__exit__`` runs on every path out of it —
    normal return, ``break``, or exception — so no manual cleanup call is
    needed or made anywhere in this function.

    should_cancel() is polled regularly in both phases; on cancellation this
    returns the PARTIAL result gathered so far with ``cancelled: True`` —
    never discarded, never presented as complete."""
    discovery = {
        "component_class": None,
        "tag_property": None,
        "component_properties": [],
        "component_properties_capped": False,
        "notes": "",
    }
    notes_parts = []
    truncation_reasons = []
    scan_stats = {
        # actors_matched is ALWAYS the true full total (phase 1 -- the
        # cheap label-match -- runs over every actor every call
        # regardless of paging, so this costs nothing extra and is exact
        # even when only a page of the matched set gets walked below).
        "actors_matched": 0,
        # actors_examined counts ONLY the actors this call actually put
        # through the phase-2 reflection walk. On an unparameterized call
        # that is every matched actor (up to _MAX_ACTORS_EXAMINED). On a
        # PAGED call (max_results/offset given) it is this page's probe
        # count ONLY -- a consumer must never read actors_examined as a
        # full-scan total when paging: cross-check "matched" (or
        # actors_matched here) for the true total, and loop pages until
        # next_offset is absent to have examined every matched actor.
        "actors_examined": 0,
        "actors_examined_capped": False,
        "actors_fast_rejected": 0,
        "actors_full_probed": 0,
        "components_capped_actor_count": 0,
    }

    try:
        all_actors = _get_all_actors()
    except Exception as e:
        return {
            "discovery": {
                "component_class": None,
                "tag_property": None,
                "component_properties": [],
                "component_properties_capped": False,
                "notes": "actor enumeration failed: " + str(e),
            },
            "verse_dir": None,
            "tag_class_count": 0,
            "actors": [],
            "cancelled": False,
            "truncated": False,
            "truncation_reasons": [],
            "scan_stats": scan_stats,
            "offline": None,
        }

    # Resolve verse_dir FIRST (cheap, no dialog needed), independent of
    # actor scanning, so the project's own discovered Verse tag class names
    # (e.g. "t_area_hoth") are available as the CONTENT-based detection
    # signal (see _value_contains_known_tag) while scanning each candidate
    # component's properties in phase 2 below — grounded in real project
    # data rather than a generic shape/name guess.
    if project_dir and not os.path.isdir(project_dir):
        notes_parts.append(
            "explicit project_dir={!r} is not a valid directory — falling "
            "back to the discovery ladder.".format(project_dir)
        )
        project_dir_for_resolve = None
    else:
        project_dir_for_resolve = project_dir

    verse_dir, verse_source = _resolve_verse_dir(project_dir_for_resolve)

    class_map = {}
    tag_classes = {}
    cancelled = False
    matched = []
    matching_cancelled = False

    # ------------------------------------------------------------------
    # Phase 1: .verse file scan + actor-label matching, under one
    # cancellable ScopedSlowTask (2 units of work). Label matching is
    # cheap per-actor (a label read + string compare, no reflection) but
    # is still polled at _CANCEL_POLL_INTERVAL — see the field incident in
    # _MAX_ACTORS_EXAMINED's comment block — so it stays inside this same
    # dialog rather than running unmonitored between the two phases.
    # ------------------------------------------------------------------
    with _make_slow_task(2, "Inspecting Verse tags…") as phase1_task:
        _st_call(phase1_task, "make_dialog", True)

        def _phase1_cancel_requested():
            return bool(_st_call(phase1_task, "should_cancel"))

        _st_call(phase1_task, "enter_progress_frame", 1, "Scanning .verse files…")

        if verse_dir:
            file_paths, files_truncated, files_reason, files_cancelled = _find_verse_files(
                verse_dir, should_cancel=_phase1_cancel_requested
            )
            if files_truncated:
                truncation_reasons.append(files_reason)
            if files_cancelled:
                cancelled = True
                truncation_reasons.append(files_reason)
                texts = []
            else:
                texts, texts_cancelled = _read_verse_file_texts(
                    file_paths, should_cancel=_phase1_cancel_requested
                )
                if texts_cancelled:
                    cancelled = True
                    truncation_reasons.append(
                        "cancelled by user while reading .verse file contents "
                        "({} of {} read)".format(len(texts), len(file_paths))
                    )
            class_map = build_class_map(texts)
            tag_classes = build_tag_class_set(class_map)
            notes_parts.append(
                "verse_dir resolved via {} ({} *.verse file(s) scanned{}, {} "
                "tag class(es) found).".format(
                    verse_source, len(file_paths),
                    " — TRUNCATED at the file-count cap" if files_truncated else "",
                    len(tag_classes),
                )
            )
        elif device_audit is None:
            notes_parts.append(
                "verse_dir could not be resolved — device_audit is unavailable "
                "({}), so the discovery ladder could not run. Tags are "
                "reported by name only, with empty parent_chain (never "
                "silently dropped).".format(_DEVICE_AUDIT_IMPORT_ERROR)
            )
        else:
            notes_parts.append(
                "verse_dir could not be resolved by device_audit._find_verse_dir()'s "
                "discovery ladder — tags are reported by name only, with empty "
                "parent_chain (never silently dropped)."
            )

        known_tag_names = set(tag_classes.keys())

        if not cancelled:
            _st_call(phase1_task, "enter_progress_frame", 1, "Matching actor labels…")

            label_of = _safe_label_fn if _safe_label_fn is not None else _fallback_label

            for idx, actor in enumerate(all_actors):
                if (
                    idx > 0
                    and idx % _CANCEL_POLL_INTERVAL == 0
                    and _phase1_cancel_requested()
                ):
                    matching_cancelled = True
                    truncation_reasons.append(
                        "cancelled by user while matching actor labels "
                        "({}/{} actor(s) checked)".format(idx, len(all_actors))
                    )
                    break
                try:
                    label = label_of(actor)
                except Exception:
                    continue
                if match_label(label, label_pattern):
                    matched.append((label, actor))

            scan_stats["actors_matched"] = len(matched)
            if matching_cancelled:
                cancelled = True
    # phase1_task's __exit__ has run here — dialog closed on every path
    # taken above, including the verse-scan-cancelled and matching-
    # cancelled branches.

    if cancelled and not matched and not matching_cancelled:
        # Cancelled during the .verse file scan itself — never reached
        # label matching at all.
        notes_parts.append(
            "SCAN CANCELLED during the .verse file scan phase — no actors "
            "were examined; 'actors' below is empty. Verse tag-class data "
            "above reflects only what was read before cancellation, not the "
            "whole project."
        )
        discovery["notes"] = " ".join(notes_parts)
        return {
            "discovery": discovery,
            "verse_dir": verse_dir,
            "tag_class_count": len(tag_classes),
            "actors": [],
            "cancelled": True,
            "truncated": bool(truncation_reasons),
            "truncation_reasons": truncation_reasons,
            "scan_stats": scan_stats,
            "offline": None,
        }

    # Computed here (needs only the max_results/offset function params,
    # both already bound) so it can gate the offline scan trigger below,
    # not just the later live-walk/actor-merge logic that already
    # depended on it (p3-t6 — see the offline-scan comment immediately
    # below for why the gate moved this early).
    paging_requested = max_results is not None or offset is not None

    # ------------------------------------------------------------------
    # OFFLINE __EXTERNALACTORS__ SCAN — PRIMARY source, run before the
    # expensive live actor/component walk below (see the banner above
    # scan_external_actors for the field evidence this is grounded in:
    # the live component read has proven blind on real projects, so the
    # offline scan is what actually answers "what tags does this actor
    # carry", not a fallback for when the live read fails). live_labels
    # uses the FULL matched list (not the capped matched_for_walk
    # computed below) so attribution isn't limited by the actor-scan cap.
    # Runs in its own genuine with-block (0.0.534 lesson: real
    # __enter__/__exit__ lifecycle, cancel polled through the live task,
    # never a manual "destroy()" call) — skipped entirely if an earlier
    # phase was already cancelled, so a user's Cancel isn't followed by
    # an unrequested walk of the whole __ExternalActors__ tree.
    #
    # SKIPPED ENTIRELY WHEN PAGING IS REQUESTED (p3-t6): computed early
    # (paging_requested needs only max_results/offset, both function
    # params — no dependency on anything below this point), and checked
    # HERE, at the trigger, not after the fact. p3-t5 already excluded
    # offline_tags_by_label from a paged call's actor merge (see the
    # "SKIPPED WHILE PAGING" comment far below), but that gate ran too
    # late: it only stopped the offline data from being USED, while the
    # ~30-minute scan_external_actors() walk still RAN unconditionally
    # and its full result was still discarded — worst of both worlds,
    # confirmed live against a 44,753-actor project (a paged max_results
    # =400/offset=0 call still paid the full offline-scan cost AND still
    # produced a 15.1 MB payload, 10.2 MB of it the unused top-level
    # "offline" key). Gating the trigger itself means a paged call now
    # skips the scan's cost entirely, not just its output.
    #
    # TRADE-OFF, STATED PLAINLY: the offline scan is the PRIMARY tag
    # source per the banner above — project memory records the live
    # component read as having proven blind on real projects historically,
    # which is why offline-decoded tags are merged into live-matched
    # actors even when the live read already returned "ok" (new tag names
    # get unioned in). Skipping the scan on a paged call therefore means a
    # paged call can return FEWER tags per actor than an unparameterized
    # call would for the same actor, if that actor's tags include ones
    # only the offline .uasset scan would have decoded. Today's live
    # capture showed 216 actors with extraction_status "ok" from the live
    # path alone, so the live read is not uniformly blind on this
    # project — but the offline source may still be additive for some
    # actors, and a paged sweep will not see that addition. This is kept
    # as-is per the user's explicit paging-priority instruction (the
    # ~30-minute/10MB cost is the thing paging exists to avoid), and is
    # disclosed both here in discovery.notes and to the caller via this
    # docstring's paging section.
    # ------------------------------------------------------------------
    offline_result = None
    if not cancelled and not paging_requested:
        with _make_slow_task(
            1, "Scanning __ExternalActors__ for Verse tags (offline)…"
        ) as offline_task:
            _st_call(offline_task, "make_dialog", True)
            _st_call(offline_task, "enter_progress_frame", 1, "Scanning __ExternalActors__…")

            def _offline_cancel_requested():
                return bool(_st_call(offline_task, "should_cancel"))

            def _offline_progress(done, total, path):
                # Zero-cost frames: the ScopedSlowTask above is
                # constructed with a single placeholder work unit (the
                # true file count isn't known until the directory walk
                # completes), so each throttled tick (every
                # _CANCEL_POLL_INTERVAL files — see scan_external_actors)
                # updates only the description text via a 0-work frame,
                # keeping the dialog visibly alive and Cancel responsive
                # without a two-pass file count.
                desc = "Offline scan: {}/{} .uasset file(s){}".format(
                    done, total,
                    " — " + os.path.basename(path) if path else "",
                )
                _st_call(offline_task, "enter_progress_frame", 0, desc)

            offline_result = scan_external_actors(
                verse_dir, tag_classes, class_map,
                label_pattern=label_pattern,
                live_labels=[lbl for lbl, _ in matched],
                progress_cb=_offline_progress,
                should_cancel=_offline_cancel_requested,
            )
        # offline_task's __exit__ has run here regardless of outcome.
    elif paging_requested:
        notes_parts.append(
            "offline __ExternalActors__ .uasset scan SKIPPED because paging "
            "was requested (max_results/offset) — this avoids the scan's "
            "~30-minute / 10MB+ cost on large projects, but means offline-"
            "decoded tags (the PRIMARY source per this module's discovery "
            "ladder) are NOT merged into this page's actors; a paged actor's "
            "tags may be a subset of what an unparameterized call would "
            "return for the same actor. result['offline'] is None on this "
            "call. Make one unparameterized (no max_results/offset) call if "
            "you need the offline-sourced tags."
        )
    else:
        notes_parts.append(
            "offline __ExternalActors__ scan skipped — an earlier phase "
            "was already cancelled."
        )

    # Fold the offline scan's own cancellation into the overall `cancelled`
    # flag -- mirrors matching_cancelled/walk_cancelled's exact pattern
    # elsewhere in this function. Without this fold, a Cancel clicked
    # during the offline scan was silently swallowed: Phase 2's actor/
    # component reflection walk still ran to completion and the top-level
    # report read cancelled=False -- the 0.0.534 "Cancel doesn't cancel"
    # regression class.
    offline_cancelled = bool(offline_result.get("cancelled")) if offline_result else False
    if offline_cancelled:
        cancelled = True
        truncation_reasons.append(
            "cancelled by user during the offline __ExternalActors__ scan "
            "— partial results (if any) are in result['offline']; the live "
            "actor/component walk below was skipped entirely."
        )

    # ------------------------------------------------------------------
    # Actor-count cap vs. PAGE-AWARE WALK (p3-t5) — mutually exclusive
    # bounds on the same expensive phase (component/property reflection),
    # never both applied to the same call:
    #
    #   * Unparameterized call (max_results is None and offset is None):
    #     byte-identical to before this task — _MAX_ACTORS_EXAMINED caps
    #     the walk exactly as it always has, truncated/truncation_reasons
    #     reporting intact. This is a deliberate backward-compatibility
    #     choice: an unparameterized broad scan already exceeds the
    #     180s bridge budget on a large project long before it could ever
    #     reach the 5000-actor cap (measured: 25.1s fixed phase-1 cost +
    #     ~198ms/actor marginal reflection cost on a real 44,753-actor
    #     project — a full uncapped walk is ~2.5 HOURS, and even the
    #     existing 5000-actor cap is ~17 minutes, both already hopeless
    #     against the budget), so changing this path's behavior buys
    #     nothing while risking every existing caller's assumptions.
    #
    #   * Paged call (max_results and/or offset passed): the walk cap
    #     does NOT apply. Instead, the MATCHED list (already known in
    #     full from the cheap phase-1 label-match above, at zero extra
    #     cost) is stably sorted by label — SAME key/order
    #     _paginate_actors uses below for the non-live-walk pagination
    #     path, so a caller mixing paged and unparameterized calls (or
    #     switching page size mid-sweep) never sees an actor skip or
    #     duplicate purely from re-sorting differently — and sliced to
    #     the requested [offset, offset+max_results) window via the SAME
    #     _apply_pagination_fn/local-fallback contract _paginate_actors
    #     uses. Only the actors inside that window are ever handed to
    #     the phase-2 reflection walk below — actors outside the window
    #     are never probed in this call at all, which is exactly where
    #     the measured ~198ms/actor cost is avoided (a ~400-actor page:
    #     25s fixed + 400*0.198 =~ 104s, comfortably inside the 180s
    #     budget; looping pages until next_offset is absent covers every
    #     matched actor across calls with no gap and no duplicate, since
    #     the sort key depends only on each actor's own label — see
    #     _paginate_actors' docstring for the identical ordering-safety
    #     argument). The page window itself is the bound in this mode,
    #     so _MAX_ACTORS_EXAMINED is skipped entirely rather than
    #     additionally clamping an already-small page.
    # ------------------------------------------------------------------
    # paging_requested was already computed above (before the offline-
    # scan trigger, p3-t6) so it could gate that scan too — not
    # recomputed here, just reused.
    page_extra = {}
    if paging_requested:
        matched_sorted = sorted(matched, key=lambda pair: pair[0] or "")
        if _apply_pagination_fn is not None:
            matched_for_walk, page_extra = _apply_pagination_fn(
                matched_sorted, max_results, offset
            )
        else:
            # Local fallback — identical contract to
            # batch_tools._apply_pagination / _paginate_actors' own
            # fallback above (kept in lockstep with both).
            total_matched = len(matched_sorted)
            effective_offset = offset if offset is not None else 0
            if effective_offset < 0:
                effective_offset = 0
            if max_results is None or max_results <= 0:
                matched_for_walk = matched_sorted[effective_offset:]
                page_extra = {
                    "offset": effective_offset,
                    "returned": len(matched_for_walk),
                }
            else:
                matched_for_walk = matched_sorted[
                    effective_offset:effective_offset + max_results
                ]
                next_offset = effective_offset + len(matched_for_walk)
                page_extra = {
                    "offset": effective_offset,
                    "returned": len(matched_for_walk),
                }
                if next_offset < total_matched:
                    page_extra["next_offset"] = next_offset
        notes_parts.append(
            "page-aware walk active: {} of {} matched actor(s) probed "
            "this call (offset={}, next_offset={}) — the "
            "_MAX_ACTORS_EXAMINED walk cap does not apply while paging; "
            "the page window is the bound instead.".format(
                len(matched_for_walk), len(matched_sorted),
                page_extra.get("offset", 0), page_extra.get("next_offset"),
            )
        )
    elif len(matched) > _MAX_ACTORS_EXAMINED:
        scan_stats["actors_examined_capped"] = True
        truncation_reasons.append(
            "{} actor(s) matched label_pattern={!r}, but only the first {} "
            "were examined for tags (hit the actor-scan cap) — the "
            "remaining {} are NOT included in 'actors' below.".format(
                len(matched), label_pattern, _MAX_ACTORS_EXAMINED,
                len(matched) - _MAX_ACTORS_EXAMINED,
            )
        )
        matched_for_walk = matched[:_MAX_ACTORS_EXAMINED]
    else:
        matched_for_walk = matched

    raw_records = []
    first_component_diagnostics = None
    all_property_read_errors = []
    walk_cancelled = False

    # ------------------------------------------------------------------
    # Phase 2: the actor/component reflection walk — the truly expensive
    # part. Its OWN ScopedSlowTask, sized to the actual number of actors
    # about to be examined, gives real per-actor percentage progress
    # (enter_progress_frame(1, ...) per actor) rather than the coarse
    # 2-unit progress phase 1 used. Skipped entirely if matching itself
    # was cancelled, OR if the offline __ExternalActors__ scan (which now
    # runs first — see above) was itself cancelled — matches the
    # pre-existing "no partial actor walk on a partial actor list"
    # contract; a Cancel during the offline scan must not be followed by
    # the live walk running anyway.
    # ------------------------------------------------------------------
    if not matching_cancelled and not offline_cancelled:
        walk_total = len(matched_for_walk) or 1
        with _make_slow_task(
            walk_total, "Scanning {} actor(s) for Verse tags…".format(len(matched_for_walk))
        ) as phase2_task:
            _st_call(phase2_task, "make_dialog", True)

            for idx, (label, actor) in enumerate(matched_for_walk):
                # Cancellation is polled once per actor (not per component/
                # property): caps above already bound a single actor's worst
                # case to _MAX_COMPONENTS_PER_ACTOR * _MAX_PROPERTIES_PER_COMPONENT
                # reflection calls (9600, not millions), so per-actor polling
                # keeps Cancel responsive without adding overhead to the hot
                # loop inside _extract_tags_from_component itself.
                if idx > 0 and bool(_st_call(phase2_task, "should_cancel")):
                    walk_cancelled = True
                    truncation_reasons.append(
                        "cancelled by user during the actor/component walk "
                        "({}/{} matched actor(s) examined)".format(idx, len(matched_for_walk))
                    )
                    break
                _st_call(phase2_task, "enter_progress_frame", 1, label)
                scan_stats["actors_examined"] += 1
                try:
                    comp, comp_class, tag_prop, raw_names, diagnostics = _find_tag_component(
                        actor, known_tag_names
                    )
                except Exception:
                    comp, comp_class, tag_prop, raw_names = None, None, None, []
                    diagnostics = {"properties": [], "capped": False, "fast_rejected": False}
                if diagnostics.get("fast_rejected"):
                    scan_stats["actors_fast_rejected"] += 1
                else:
                    scan_stats["actors_full_probed"] += 1
                if diagnostics.get("components_examined_capped"):
                    scan_stats["components_capped_actor_count"] += 1
                if comp is not None and discovery["component_class"] is None:
                    discovery["component_class"] = comp_class
                    discovery["tag_property"] = tag_prop
                    first_component_diagnostics = diagnostics
                if diagnostics.get("property_read_errors"):
                    all_property_read_errors.extend(diagnostics["property_read_errors"])

                # extraction_status/extraction_debug: NEVER a bare
                # tags:[] without one of "ok"/"empty"/"unreadable" — see
                # module docstring's field case and _decode_winner_tags.
                if comp is None:
                    extraction_status = None
                    extraction_debug = None
                elif tag_prop is None:
                    # Component found, but no property on it could even be
                    # identified as the tag container — opaque, same as a
                    # decode failure on an identified property.
                    extraction_status = "unreadable"
                    extraction_debug = {
                        "type_name": None,
                        "value_repr": None,
                        "note": "no property on this component was identified as the tag container",
                    }
                else:
                    extraction_status = diagnostics.get("extraction_status") or "unreadable"
                    extraction_debug = diagnostics.get("extraction_debug")

                # ACTOR-LEVEL TAG SOURCE: read AActor's own "tags" editor
                # property (a plain Name array, distinct from the
                # VerseTagMarkupComponent's container) for EVERY matched
                # actor, not only ones with a tag component — a real
                # 0.0.534 field run showed component_tags positively
                # iterating to zero on all 389 matched actors while ground
                # truth said several carried tags, so the tags may live on
                # the actor itself instead. One extra get_editor_property
                # call per actor is cheap relative to the component walk
                # already paid for above.
                try:
                    actor_tags_value = actor.get_editor_property("tags")
                except Exception as e:
                    actor_tags_value = None
                    all_property_read_errors.append({
                        "name": "AActor.Tags", "exception_class": type(e).__name__,
                    })
                    actor_tags_raw = []
                else:
                    actor_tags_items, _actor_tags_iterated_ok = _try_iter_tag_container_values(actor_tags_value)
                    actor_tags_raw = []
                    for raw in actor_tags_items:
                        try:
                            normalized = normalize_tag_name(str(raw))
                        except Exception:
                            continue
                        if normalized:
                            actor_tags_raw.append(normalized)
                actor_tags_matched = [t for t in actor_tags_raw if t in known_tag_names]

                # OPT-IN LOCATION: resolved from the SAME actor object
                # already in hand for this walk iteration, via the SAME
                # shared implementation batch_get_location/
                # batch_get_property("location") use (see
                # batch_tools.py:295-333, device_audit.py:211) -- not a
                # second independent get_actor_location() call site. Only
                # attempted when include_location=True, so the default
                # path's per-actor cost (and shape) is unchanged.
                location_value = None
                location_error = None
                if include_location:
                    if _da_actor_location_tuple is None:
                        location_error = "device_audit._actor_location_tuple unavailable"
                    else:
                        try:
                            lx, ly, lz = _da_actor_location_tuple(actor)
                            location_value = {"x": lx, "y": ly, "z": lz}
                        except Exception as e:
                            location_error = str(e)

                raw_records.append({
                    "label": label,
                    "has_verse_tag_component": comp is not None,
                    "component_class": comp_class,
                    "raw_tag_names": raw_names,
                    "extraction_status": extraction_status,
                    "extraction_debug": extraction_debug,
                    "actor_tags_raw": actor_tags_raw,
                    "actor_tags_matched": actor_tags_matched,
                    "location": location_value,
                    "location_error": location_error,
                })
        # phase2_task's __exit__ has run here regardless of how the loop
        # above ended.

    if walk_cancelled:
        cancelled = True

    fast_reject_note = (
        "fast-reject bound: {} of {} examined actor(s) had no candidate "
        "tag-hinting component and skipped the expensive per-property "
        "probe entirely; {} were fully probed.".format(
            scan_stats["actors_fast_rejected"], scan_stats["actors_examined"],
            scan_stats["actors_full_probed"],
        )
    )

    found_count = sum(1 for r in raw_records if r["has_verse_tag_component"])
    status_ok = sum(1 for r in raw_records if r.get("extraction_status") == "ok")
    status_empty = sum(1 for r in raw_records if r.get("extraction_status") == "empty")
    status_unreadable = sum(1 for r in raw_records if r.get("extraction_status") == "unreadable")

    if discovery["component_class"] is not None and discovery["tag_property"] is not None:
        notes_parts.append(
            "discovered tag component class {!r}, tag-container property "
            "{!r} (found on {} of {} matching actor(s)).".format(
                discovery["component_class"], discovery["tag_property"],
                found_count, len(raw_records),
            )
        )
    elif discovery["component_class"] is not None:
        notes_parts.append(
            "component class {!r} was found on {} of {} matching actor(s), "
            "but no property on it matched a tag-container shape (a "
            "'.gameplay_tags' accessor, or a list/tuple/other iterable "
            "value) or contained any of the {} tag class name(s) "
            "discovered from Verse source. See "
            "discovery.component_properties for every property name, "
            "value type, and truncated value repr this scan actually saw "
            "on that component — the component WAS found; only the "
            "tag-container property within it was not identified.".format(
                discovery["component_class"], found_count, len(raw_records),
                len(known_tag_names),
            )
        )
    elif raw_records:
        notes_parts.append(
            "no Verse-tag-bearing component found on any of the {} examined "
            "actor(s) — looked for a component class name containing "
            "'VerseTag', and (for components that cheaply looked "
            "tag-related) any component exposing a GameplayTag"
            "Container-like property.".format(len(raw_records))
        )
    elif not matched:
        notes_parts.append("no actors matched label_pattern={!r}.".format(label_pattern))

    # component_properties diagnostics: populated whenever a component was
    # found and its property probe left evidence, whether the failure mode
    # was "no property identified at all" (tag_property is None) OR
    # "property identified but decode failed/empty" (tag_property found,
    # extraction_status != "ok") — never leave this an empty [] alongside
    # a reported failure (see module docstring's field case).
    if first_component_diagnostics is not None and (
        discovery["tag_property"] is None or status_ok == 0
    ):
        discovery["component_properties"] = first_component_diagnostics.get("properties", [])
        discovery["component_properties_capped"] = first_component_diagnostics.get("capped", False)

    if all_property_read_errors:
        # Deduplicate by (name, exception_class) — the same property can
        # fail identically across many actors on a repeated component type.
        seen_errors = set()
        deduped_errors = []
        for err in all_property_read_errors:
            key = (err.get("name"), err.get("exception_class"))
            if key not in seen_errors:
                seen_errors.add(key)
                deduped_errors.append(err)
        discovery["property_read_errors"] = deduped_errors
        notes_parts.append(
            "{} distinct get_editor_property() failure(s) encountered while "
            "probing components (recorded in discovery.property_read_errors, "
            "not silently skipped).".format(len(deduped_errors))
        )

    if found_count:
        notes_parts.append(
            "{} with tag component: {} decoded, {} confirmed-empty, {} "
            "unreadable{}.".format(
                found_count, status_ok, status_empty, status_unreadable,
                " — extraction debug attached" if status_unreadable else "",
            )
        )

    # ------------------------------------------------------------------
    # ACTOR-LEVEL TAG SOURCE merge: fold any actor_tags_matched hits into
    # each actor's tags list (source="actor_tags", alongside existing
    # component-sourced entries tagged source="component_tags"), and
    # recompute each actor's extraction_status as "ok" whenever ANY
    # source produced tags -- an actor whose component container
    # positively iterated to zero must still read "ok" if its own
    # AActor::Tags array carried a known Verse tag name (see the 0.0.534
    # field case in the actor_tags read comment above, in the walk loop).
    # ------------------------------------------------------------------
    actors_out = []
    actor_tags_rescued = 0
    for rec in raw_records:
        tags_out = []
        seen_names = set()
        for raw_name in rec["raw_tag_names"]:
            chain = tag_classes.get(raw_name)
            tags_out.append({
                "name": raw_name,
                "parent_chain": list(chain) if chain else [],
                "source": "component_tags",
            })
            seen_names.add(raw_name)
        for raw_name in rec.get("actor_tags_matched", []):
            if raw_name in seen_names:
                continue
            chain = tag_classes.get(raw_name)
            tags_out.append({
                "name": raw_name,
                "parent_chain": list(chain) if chain else [],
                "source": "actor_tags",
            })
            seen_names.add(raw_name)

        combined_status = "ok" if tags_out else rec.get("extraction_status")
        if combined_status == "ok" and rec.get("extraction_status") != "ok":
            actor_tags_rescued += 1

        actor_entry = {
            "label": rec["label"],
            "has_verse_tag_component": rec["has_verse_tag_component"],
            "component_class": rec["component_class"],
            "tags": tags_out,
            "extraction_status": combined_status,
            "actor_tags": rec.get("actor_tags_raw", []),
        }
        if combined_status == "unreadable" and rec.get("extraction_debug"):
            actor_entry["extraction_debug"] = rec["extraction_debug"]
        # location/location_error keys are added ONLY when include_location
        # was requested -- never present at all otherwise, so the default
        # (include_location=False) actor shape is byte-identical to before
        # this parameter existed.
        if include_location:
            if rec.get("location") is not None:
                actor_entry["location"] = rec["location"]
            else:
                actor_entry["location_error"] = rec.get("location_error") or "unknown error"
        actors_out.append(actor_entry)

    combined_ok = sum(1 for a in actors_out if a["extraction_status"] == "ok")

    if actor_tags_rescued:
        notes_parts.append(
            "{} actor(s) additionally decoded via the actor's own Tags "
            "property (AActor::Tags), not the tag component — see each "
            "such tag's \"source\": \"actor_tags\" in the report.".format(
                actor_tags_rescued
            )
        )

    # ------------------------------------------------------------------
    # OFFLINE __EXTERNALACTORS__ SOURCE merge: fold offline-decoded tags
    # into every actor whose combined component_tags/actor_tags read was
    # NOT "ok" — mirrors the actor_tags rescue immediately above exactly
    # (dedup by tag name, source marker, status rescued to "ok"). This is
    # the PRIMARY source (see the banner above scan_external_actors), so
    # it is applied even when the live read already succeeded — new,
    # not-yet-seen tag names from the offline source are still merged in
    # (only exact-name duplicates are skipped), never overriding an
    # already-decoded live tag's presence.
    # ------------------------------------------------------------------
    offline_tags_by_label = {}
    if offline_result and offline_result.get("status") == "ok":
        for oa in offline_result.get("actors") or []:
            offline_tags_by_label.setdefault(oa.get("label"), []).extend(oa.get("tags") or [])

    external_actors_rescued = 0
    for actor_entry in actors_out:
        off_tags = offline_tags_by_label.get(actor_entry["label"])
        if not off_tags:
            continue
        was_ok = actor_entry["extraction_status"] == "ok"
        existing_names = {t["name"] for t in actor_entry["tags"]}
        added_any = False
        for t in off_tags:
            name = t.get("name")
            if not name or name in existing_names:
                continue
            actor_entry["tags"].append({
                "name": name,
                "parent_chain": list(t.get("parents") or []),
                "source": "external_actors",
            })
            existing_names.add(name)
            added_any = True
        if added_any:
            actor_entry["extraction_status"] = "ok"
            # An "unreadable" debug snapshot from the dead live read is no
            # longer the honest story once a real source (offline)
            # decoded this actor successfully.
            actor_entry.pop("extraction_debug", None)
            if not was_ok:
                external_actors_rescued += 1

    if external_actors_rescued:
        notes_parts.append(
            "{} actor(s) additionally decoded via the offline "
            "__ExternalActors__ .uasset scan (source \"external_actors\") "
            "— the live editor read stayed empty/unreadable for these; "
            "see result['offline'] for the scan that found them.".format(
                external_actors_rescued
            )
        )
    elif offline_result and offline_result.get("status") == "error":
        notes_parts.append(
            "offline __ExternalActors__ scan FAILED: " + str(offline_result.get("error"))
        )

    notes_parts.append(fast_reject_note)
    if cancelled or truncation_reasons:
        notes_parts.append(
            ("SCAN CANCELLED — " if cancelled else "SCAN TRUNCATED — ")
            + "; ".join(truncation_reasons)
            + " Results below reflect only the actors actually examined; "
              "never treat this as a complete-project result."
        )

    # ------------------------------------------------------------------
    # DEEP-PROBE FALLBACK: last resort when >=1 matched actor HAS a tag
    # component but decoded NOTHING from any source. This fires on BOTH
    # full systematic failure (zero of the componented actors decoded
    # anything — the original 0.0.534 case) AND partial failure (some
    # componented actors decoded fine, others didn't — a real 0.0.535
    # field case: 22 Room-8 markers decoded via actor_tags while 367
    # others across R1-R31 stayed confirmed-empty on both sources, and
    # the old zero-"ok"-actors trigger suppressed the probe entirely,
    # leaving the 367 undiagnosed). "Decoded nothing" is judged from the
    # COMBINED per-actor status (component_tags OR actor_tags), so a
    # rescue via actor_tags correctly removes that actor from the
    # non-decoded pool. Non-decoded actors are preferred for probing;
    # when at least one componented actor DID decode, one such actor is
    # ALSO probed as a labeled contrast sample (total probed actors stays
    # <= _DEEP_PROBE_MAX_ACTORS + 1). Run inside its own small cancellable
    # ScopedSlowTask (same guaranteed-__exit__ with-block lifecycle as
    # phases 1/2 — see _make_slow_task's docstring). Skipped if the scan
    # itself was already cancelled, so a user's Cancel isn't followed by
    # extra unrequested work.
    # ------------------------------------------------------------------
    non_decoded_targets = []
    decoded_targets = []
    for _i, _a in enumerate(actors_out):
        if not _a["has_verse_tag_component"]:
            continue
        _pair = matched_for_walk[_i]
        if _a["extraction_status"] == "ok":
            decoded_targets.append(_pair)
        else:
            non_decoded_targets.append(_pair)

    deep_probe_result = None
    deep_probe_skipped_reason = None
    if external_actors_rescued:
        # The mystery the deep probe exists to investigate — "why does
        # the live read decode nothing" — is already answered once the
        # offline __ExternalActors__ scan rescued >=1 live-empty actor:
        # further probing of the same live-blind read would tell us
        # nothing new.
        deep_probe_skipped_reason = "offline scan resolved the live-empty actors"
        notes_parts.append(
            "DEEP PROBE SKIPPED: " + deep_probe_skipped_reason + " — no "
            "further diagnostic probing needed once a real source (the "
            "offline __ExternalActors__ scan) explained the live-empty "
            "actors."
        )
    elif non_decoded_targets and not cancelled:
        non_decoded_slice = non_decoded_targets[:_DEEP_PROBE_MAX_ACTORS]
        probe_targets = list(non_decoded_slice)
        contrast_added = False
        contrast_label = None
        if decoded_targets:
            probe_targets.append(decoded_targets[0])
            contrast_added = True
            contrast_label = decoded_targets[0][0]

        findings = []
        deep_probe_cancelled = False
        with _make_slow_task(
            len(probe_targets) or 1,
            "Deep-probing {} actor(s) for tag data…".format(len(probe_targets)),
        ) as deep_probe_task:
            _st_call(deep_probe_task, "make_dialog", True)
            for idx, (dp_label, dp_actor) in enumerate(probe_targets):
                if idx > 0 and bool(_st_call(deep_probe_task, "should_cancel")):
                    deep_probe_cancelled = True
                    break
                _st_call(deep_probe_task, "enter_progress_frame", 1, dp_label)
                is_contrast = contrast_added and idx == len(non_decoded_slice)
                try:
                    finding = _deep_probe_actor(dp_label, dp_actor, known_tag_names)
                except Exception as e:
                    finding = {
                        "actor_label": dp_label,
                        "context": None,
                        "tag_component": None,
                        "actor_tags_property": None,
                        "other_components_hits": [],
                        "errors": [{"where": "_deep_probe_actor", "exception_class": type(e).__name__}],
                    }
                finding["role"] = "contrast_decoded" if is_contrast else "non_decoded"
                findings.append(finding)
        # deep_probe_task's __exit__ has run here regardless of how the
        # loop above ended.

        def _finding_has_hits(f):
            if (f.get("actor_tags_property") or {}).get("known_tag_hits"):
                return True
            for prop in (f.get("tag_component") or {}).get("properties", []):
                if prop.get("known_tag_hits"):
                    return True
            return bool(f.get("other_components_hits"))

        any_hits = any(
            _finding_has_hits(f) for f in findings if f.get("role") == "non_decoded"
        )
        deep_probe_result = {
            "probed_labels": [dp_label for dp_label, _ in probe_targets],
            "findings": findings,
            "cancelled": deep_probe_cancelled,
        }

        is_full_failure = len(non_decoded_targets) == found_count
        mode_note = (
            "FULL FAILURE: all {} matched actor(s) with a tag component "
            "decoded no tags from any source, so the first {} were "
            "deep-probed.".format(found_count, len(non_decoded_slice))
            if is_full_failure else
            "PARTIAL: {} of {} matched actor(s) with a tag component "
            "decoded no tags from any source; deep-probed the first {} of "
            "those{}.".format(
                len(non_decoded_targets), found_count, len(non_decoded_slice),
                " plus 1 already-decoded actor ({!r}) included as a "
                "contrast sample".format(contrast_label) if contrast_added else "",
            )
        )
        if any_hits:
            hit_note = (
                "deep probe found known-tag whole-word hit(s) in probed "
                "property data — see report['deep_probe']['findings'] for "
                "exactly where."
            )
        elif contrast_added:
            hit_note = (
                "deep probe found NO known-tag hits on the non-decoded "
                "actor(s) — compare their probed properties against the "
                "included contrast actor ({!r}, which DID decode tags) to "
                "spot where the non-decoded actors' authoring differs. If "
                "nothing differs, the non-decoded actors' tags may be "
                "applied at runtime by Verse — compare the probed actors "
                "against a decoded one.".format(contrast_label)
            )
        else:
            hit_note = (
                "deep probe found NO known-tag hits anywhere probed (the "
                "tag component's own properties, the actor's Tags array, "
                "or any other component) — the non-decoded actors' tags "
                "may be applied at RUNTIME by Verse code and never stored "
                "in editor data at all; an editor-side scan can never see "
                "a purely runtime-applied tag."
            )
        notes_parts.append("DEEP PROBE: " + mode_note + " " + hit_note)

        # Automatic context comparison (world-streaming/world-partition
        # hypothesis): only meaningful when a contrast (decoded-ok) actor
        # was probed alongside non-decoded ones — nothing to compare
        # against otherwise. See _compare_deep_probe_contexts's docstring
        # for exactly which signals feed the verdict (raw package-name
        # inequality is deliberately excluded — see its and
        # _deep_probe_actor_context's docstrings for why).
        if contrast_added:
            contrast_finding = next(
                (f for f in findings if f.get("role") == "contrast_decoded"), None
            )
            non_decoded_findings = [f for f in findings if f.get("role") == "non_decoded"]
            if contrast_finding is not None and non_decoded_findings:
                notes_parts.append(
                    "DEEP PROBE CONTEXT: " +
                    _compare_deep_probe_contexts(contrast_finding, non_decoded_findings)
                )

    # Offline-only actors: a label the __ExternalActors__ scan decoded
    # tags for but that never matched a LIVE actor at all (a headless run
    # with no editor, or a label-form mismatch) — never silently dropped,
    # same never-omit doctrine as every other actor class in this module.
    #
    # SKIPPED WHILE PAGING (p3-t5): offline_tags_by_label comes from
    # scan_external_actors, which is gated only by label_pattern -- it
    # runs in full every call and has no notion of the live walk's page
    # window. Appending these here unconditionally would inject the SAME
    # offline-only entries into EVERY page's actors_out, breaking the
    # "every matched actor exactly once across a paged sweep" property
    # (they are not part of matched_for_walk, so page slicing never
    # touches them). Correctness over completeness-per-call: an
    # unparameterized (non-paged) call still surfaces every offline-only
    # actor exactly as before -- paged callers needing this offline-only
    # set should make one additional unparameterized call for it, noted
    # in discovery.notes below.
    matched_live_labels = {lbl for lbl, _ in matched}
    if paging_requested and offline_tags_by_label:
        offline_only_count = sum(
            1 for label in offline_tags_by_label if label not in matched_live_labels
        )
        if offline_only_count:
            notes_parts.append(
                "{} offline-only actor(s) (found by the __ExternalActors__ "
                "scan but never matched live) were NOT added to 'actors' "
                "on this paged call, to avoid duplicating them across "
                "every page -- make one unparameterized (no max_results/"
                "offset) call to see them.".format(offline_only_count)
            )
    for label, off_tags in ({} if paging_requested else offline_tags_by_label).items():
        if label in matched_live_labels:
            continue
        seen_names = set()
        tags_out = []
        for t in off_tags:
            name = t.get("name")
            if not name or name in seen_names:
                continue
            seen_names.add(name)
            tags_out.append({
                "name": name,
                "parent_chain": list(t.get("parents") or []),
                "source": "external_actors",
            })
        offline_entry = {
            "label": label,
            "has_verse_tag_component": False,
            "component_class": None,
            "tags": tags_out,
            "extraction_status": "ok" if tags_out else "empty",
            "actor_tags": [],
        }
        if include_location:
            # No live actor object exists for an offline-only label (it
            # never matched during the live walk above), so there is
            # nothing to call _actor_location_tuple on -- report that
            # explicitly rather than silently omitting the key other
            # entries carry.
            offline_entry["location_error"] = "no live actor object (offline-only match)"
        actors_out.append(offline_entry)

    # Summary counts: which source produced how many decoded tags —
    # stated out loud rather than left implicit in per-actor "source"
    # fields a reader would have to tally themselves.
    source_counts = {"component_tags": 0, "actor_tags": 0, "external_actors": 0}
    for a in actors_out:
        for t in a.get("tags") or []:
            src = t.get("source")
            if src in source_counts:
                source_counts[src] += 1
    notes_parts.append(
        "tag source split: {} from component_tags, {} from actor_tags, "
        "{} from external_actors.".format(
            source_counts["component_tags"], source_counts["actor_tags"],
            source_counts["external_actors"],
        )
    )

    actors_out = sort_actors_flagged_first(actors_out)
    discovery["notes"] = " ".join(notes_parts)

    result = {
        "discovery": discovery,
        "verse_dir": verse_dir,
        "tag_class_count": len(tag_classes),
        "actors": actors_out,
        "cancelled": cancelled,
        "truncated": bool(truncation_reasons),
        "truncation_reasons": truncation_reasons,
        "scan_stats": scan_stats,
        "offline": offline_result,
    }
    if offline_result is not None:
        result["offline_caveat"] = _OFFLINE_UNSAVED_CAVEAT
    if deep_probe_skipped_reason is not None:
        result["deep_probe_skipped_reason"] = deep_probe_skipped_reason
    if deep_probe_result is not None:
        result["deep_probe"] = deep_probe_result
    if paging_requested:
        result["page_extra"] = page_extra
    return result


# ---------------------------------------------------------------------------
# Report file — dual-location write/verify, mirroring moderation_scanner.py's
# _moderation_report_path()/_bridge_ipc_dir() pattern exactly.
# ---------------------------------------------------------------------------

def _get_bridge_dir():
    """The bridge IPC directory (create=True). Delegates to bridge_paths.py
    when importable; ImportError-guarded fallback reproduces its derivation
    exactly for a version-skewed sibling set missing that file."""
    try:
        import bridge_paths
        return bridge_paths.bridge_ipc_dir(create=True)
    except ImportError:
        pass
    bridge_dir = os.environ.get("UEFN_BRIDGE_DIR") or os.path.join(
        tempfile.gettempdir(), "uefn_bridge"
    )
    os.makedirs(bridge_dir, exist_ok=True)
    return bridge_dir


def report_path():
    """Primary tag_inspect_report.json path, next to this script. Public
    (no leading underscore) so the launcher agent can read it back to
    locate the report file — mirrors moderation_scanner.py's
    _moderation_report_path()."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_inspect_report.json")


def report_locations():
    """[(label, path), ...] — every location a report can land in, primary
    first, deduplicated. Exposed so a "no report yet" UI state can show
    exactly where this scan looked, rather than a dead end — mirrors
    moderation_scanner.py's _moderation_report_locations()."""
    try:
        primary = report_path()
        fallback = os.path.join(_get_bridge_dir(), "tag_inspect_report.json")
        locations = [("primary — next to this script", primary)]
        if fallback != primary:
            locations.append(("fallback — bridge IPC temp dir", fallback))
        return locations
    except Exception:
        return []


def _write_json_checked(filepath, data):
    """Write *data* as JSON to *filepath* atomically via a .tmp rename, and
    VERIFY it landed by reading it back as valid JSON before reporting
    success. Returns (True, None) or (False, "<error>"). Never raises."""
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
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            json.load(f)
    except Exception as e:
        return False, "round-trip read-back failed: {}".format(e)
    return True, None


def write_report(result):
    """Write *result* (an ``inspect_tags()`` return value) to
    tag_inspect_report.json at BOTH ``report_path()`` (primary) and the
    bridge IPC temp dir (fallback) — mirrors moderation_scanner.py's dual-
    location write/verify pattern exactly, since the primary location can
    sit under a permission-protected engine-install path that
    init_unreal.py self-syncs these scripts into. Returns {"saved": bool,
    "paths_written": [...], "paths_failed": [{"path", "error"}, ...]}.
    Never raises."""
    payload = dict(result)
    try:
        payload["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        pass

    try:
        primary = report_path()
    except Exception as e:
        return {"saved": False, "paths_written": [], "paths_failed": [{"path": "<primary>", "error": str(e)}]}

    try:
        fallback = os.path.join(_get_bridge_dir(), "tag_inspect_report.json")
    except Exception:
        fallback = primary

    paths_written = []
    paths_failed = []
    seen = set()
    for candidate in (primary, fallback):
        if candidate in seen:
            continue
        seen.add(candidate)
        ok, error = _write_json_checked(candidate, payload)
        if ok:
            paths_written.append(candidate)
        else:
            paths_failed.append({"path": candidate, "error": error})

    saved = len(paths_written) > 0
    if paths_failed and _HAS_UNREAL:
        try:
            unreal.log_warning(
                "tag_inspect: write_report failed at {} of {} location(s):\n".format(
                    len(paths_failed), len(paths_failed) + len(paths_written)
                )
                + "\n".join("{}: {}".format(f["path"], f["error"]) for f in paths_failed)
            )
        except Exception:
            pass

    return {"saved": saved, "paths_written": paths_written, "paths_failed": paths_failed}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def inspect_tags(label_pattern=None, project_dir=None, fields=None, include_location=False,
                  max_results=None, offset=None):
    """Enumerate level actors (optionally filtered by *label_pattern* —
    plain substring or "*"-wildcard, case-insensitive; see ``match_label``)
    and report their Verse gameplay tags, discovering the tag-bearing
    component class and its tag-container property NAME AT RUNTIME rather
    than assuming one (see module docstring for why).

    *max_results* / *offset* (p3-t5): opt-in cursor pagination, mirroring
    batch_tools.py's ``batch_get_property``/``batch_get_location``
    contract (same ``offset``/``returned``/``next_offset`` shape). Omit
    both (the default) and behavior is byte-identical to before these
    parameters existed -- no new keys appear at all, and the walk is
    bounded exactly as it always was (see ``_MAX_ACTORS_EXAMINED``'s
    comment block). Pass ``max_results`` (and, to select a page beyond
    the first, ``offset``) to activate the PAGE-AWARE WALK instead: this
    is not payload slicing after the fact, it changes WHICH actors get
    examined at all.

    THE WALK ITSELF IS PAGED, NOT JUST THE RESPONSE -- as of p3-t5 this
    replaced the previous design (page over an already-fully-walked
    ``actors`` list). The per-actor component/property reflection walk is
    the expensive part: a live measurement against a real 44,753-actor
    project found a ~25.1s FIXED cost (verse-file scan + tag-class
    discovery + label-matching ALL actors, paid every call regardless of
    how many match) plus ~198ms MARGINAL cost per actor actually put
    through the reflection walk (measured from a 392-match scan totaling
    102.6s). A full uncapped walk of that project would take roughly 2.5
    hours in one call -- hopeless against the 180s budget
    ``uefn-server.ts`` grants this tool -- and even the pre-existing
    5,000-actor ``_MAX_ACTORS_EXAMINED`` cap is ~17 minutes, already
    unreachable in a single call. So when paging is requested,
    ``_inspect_tags_live`` sorts the (cheaply, already fully known)
    matched-actor list by label -- same key ``_paginate_actors`` uses, so
    ordering is identical whichever path a caller takes -- and probes
    ONLY the actors inside [offset, offset+max_results): actors outside
    that window are never put through the reflection walk in this call at
    all, which is exactly where the ~198ms/actor is avoided. A page sized
    ~400 costs roughly 25s fixed + 400*0.198s =~ 104s, comfortably inside
    budget; looping calls with offset=0, then each response's
    ``next_offset``, until it is absent, probes every matched actor
    exactly once across the whole sweep (see
    ``test_page_aware_walk.py``'s full-sweep test for the pinned
    property). ``_MAX_ACTORS_EXAMINED`` and the page window are
    MUTUALLY EXCLUSIVE bounds on the same phase -- the walk cap is
    skipped entirely while paging (the requested page size IS the bound
    for that call), and applied exactly as before when paging is not
    requested; they are never combined.

    A paginated response carries ``"matched"`` (the true FULL matched-
    actor total -- from ``scan_stats.actors_matched``, computed for free
    during the always-runs cheap phase, and exact regardless of paging),
    ``"offset"``, ``"returned"``, and ``"next_offset"`` (present only when
    another page remains). ``scan_stats.actors_examined`` is DIFFERENT
    from ``"matched"`` while paging: it counts only THIS CALL's probed
    actors (this page), never the full-scan total -- see
    ``scan_stats``'s own inline comment in ``_inspect_tags_live`` for the
    exact wording a stats consumer must not misread. ``truncated``/
    ``truncation_reasons``/``cancelled`` continue to describe this call's
    walk (the page, when paging; the capped/uncapped full walk otherwise)
    -- a Cancel during a paged call still returns whatever of that page
    was examined before cancellation, never discarded.

    *fields*: optional list of per-actor keys to return (e.g.
    ``["label", "tags", "location"]``) instead of the full fixed set
    below. ``"label"`` is always kept regardless of whether it is listed,
    so a field-selected entry can still be attributed to an actor.
    Omitted (``None``, the default) returns every field exactly as
    documented below — existing callers see byte-identical output. This
    is the field-selection win this module actually needs: a real-world
    ``tag_inspect`` call on ~390 actors measured 681 KB with the full
    fixed shape (``tags`` carrying a nested ``parent_chain`` per tag,
    plus ``component_class``, ``extraction_status``, the full raw
    ``actor_tags`` list, and sometimes ``extraction_debug``) while the
    caller only wanted ``label`` + ``tags`` + ``location`` — unlike
    batch_get's already-lean ~223-bytes/actor shape, this is where field
    selection pays for itself.

    *include_location*: opt-in bool (default ``False`` — unchanged
    behavior). When ``True``, each actor entry additionally carries
    ``"location"`` (``{"x", "y", "z"}``, resolved via
    ``device_audit._actor_location_tuple`` — the SAME shared seam
    ``batch_get_location``/``batch_get_property``'s "location" special
    case uses, see ``batch_tools.py``'s ``batch_get_location`` docstring;
    no second ``get_actor_location()`` call site was added) or
    ``"location_error"`` (str) if resolution failed for that actor. This
    is fetched from the SAME actor object already in hand during the
    phase-2 walk (no second actor-matching pass, no extra editor
    enumeration) — see ``_inspect_tags_live``'s walk loop. This directly
    answers the incident this task exists to fix: one call returning
    label + tags + location together, through the same location
    implementation p2 built rather than a second independent one. If
    ``device_audit._actor_location_tuple`` is unavailable (stale/
    version-skewed ``device_audit.py`` copy), every actor instead gets
    ``"location_error": "device_audit._actor_location_tuple unavailable"``
    rather than silently omitting location or crashing the whole scan.

    Returns exactly:
        {"discovery": {"component_class": str|None, "tag_property": str|None,
                        "component_properties": [{"name": str, "type": str,
                                                    "value_repr": str}, ...],
                        "component_properties_capped": bool,
                        "notes": str},
         "verse_dir": str|None,
         "tag_class_count": int,
         "actors": [{"label": str, "has_verse_tag_component": bool,
                      "component_class": str|None,
                      "tags": [{"name": str, "parent_chain": [str, ...],
                                 "source": "component_tags"|"actor_tags"}],
                      "actor_tags": [str, ...],
                      "extraction_status": "ok"|"empty"|"unreadable"|None,
                      "extraction_debug": {...} (only when "unreadable"),
                      "location": {"x": float, "y": float, "z": float}
                          (only when include_location=True and resolved),
                      "location_error": str
                          (only when include_location=True and NOT
                          resolved -- location and location_error are
                          mutually exclusive per actor, never both)}],
                     -- when *fields* is given, each entry above is
                     trimmed to {"label"} UNION *fields* instead (see
                     _project_actor_fields; applied after include_location,
                     so fields=["label","tags","location"] is exactly the
                     incident's original ask in one call),
         "deep_probe": {"probed_labels": [str, ...], "findings": [...],
                          "cancelled": bool} (present only when the
                          deep-probe fallback ran — see below)}

    Each ``tags`` entry carries a ``source``: ``"component_tags"`` when
    decoded from the tag component's container (the normal path), or
    ``"actor_tags"`` when decoded instead from the ACTOR's own ``tags``
    editor property (``AActor::Tags``, a plain Name array checked for
    EVERY matched actor regardless of whether it also has a tag
    component) and found to whole-word-match one of this project's known
    Verse tag class names. ``actor_tags`` on the actor entry is the full
    raw list read from that property (informational, independent of
    whether any entry matched a known tag name).

    ``extraction_status`` is ``None`` only when ``has_verse_tag_component``
    is False AND no actor-level tag matched (nothing decoded from any
    source); otherwise it is always one of "ok" (>=1 tag decoded from
    EITHER source), "empty" (the component's container was positively
    iterated and found to have zero entries, and no actor-level tag
    rescued it), or "unreadable" (a tag component was present but no
    strategy could decode any tags from it, and no actor-level tag
    rescued it — see ``_decode_winner_tags``). An actor's ``tags`` list is
    NEVER bare ``[]`` without one of these statuses attached, so an
    "unreadable" read can never be misread as "confirmed no tags" (see
    module docstring's field case). "unreadable" actors additionally
    carry ``extraction_debug`` (python type name, truncated value repr,
    and an export_text() snippet when available) so the report is
    actionable rather than a dead end.

    ``deep_probe`` (top-level, sibling of ``actors``) is present ONLY when
    the deep-probe fallback ran: at least one matched actor with a tag
    component decoded NOTHING from any source. This covers both FULL
    failure (zero of the componented actors decoded anything) and PARTIAL
    failure (some componented actors decoded fine, others didn't — e.g. a
    real field case where 22 of 389 actors decoded via actor_tags while
    367 stayed confirmed-empty on every source) — ``discovery.notes``
    states which mode fired. Non-decoded actors are preferred for
    probing; when at least one componented actor DID decode, ONE such
    actor is also probed as a contrast sample (each finding carries
    ``"role"``: ``"non_decoded"`` or ``"contrast_decoded"``). It
    full-dumps every property on the probed actors' tag components and
    their own ``tags`` property, plus any known-tag hit found on their
    OTHER components — see ``_deep_probe_actor`` — so an extraction
    failure (the container genuinely lives somewhere this scan didn't
    look, or the tags are applied purely at runtime by Verse code and
    never stored in editor data at all) is diagnosable from the report
    itself instead of being a dead end.

    ``discovery.component_properties`` is populated in the failure cases
    that matter most: a tag-bearing component WAS found
    (``component_class`` is set) but either no property on it could be
    identified as the tag container (``tag_property`` stayed ``None``), or
    a property WAS identified yet decoding it never yielded "ok" for any
    examined actor. It lists every editor-gettable property this scan
    actually saw on that
    component — name, Python type name, and a value repr hard-truncated to
    80 chars — capped at 40 entries (``component_properties_capped`` flags
    truncation). This turns a dead ``tag_property: null`` into an
    actionable report: the next probe of that project needs no separate
    run, because what was actually seen on the component is right here.

    Actors with ``has_verse_tag_component: False`` OR an empty ``tags``
    list are sorted FIRST in ``actors`` (see ``sort_actors_flagged_first``)
    — never silently omitted; this is the failure mode described in the
    module docstring's field case. Every actor matching *label_pattern*
    is present in the result UNLESS the actor-scan cap or a user
    cancellation cut the walk short (see the next paragraph) — that is
    always reported explicitly, never silent.

    On the live path (``unreal`` available), the result additionally
    carries: ``"cancelled"`` (bool — the user clicked Cancel on the
    ScopedSlowTask progress dialog; ``"actors"`` is then a PARTIAL list of
    whatever was examined before cancellation, never discarded and never
    presented as complete), ``"truncated"`` (bool — a cap was hit, e.g.
    ``_MAX_ACTORS_EXAMINED``/``_MAX_COMPONENTS_PER_ACTOR``/
    ``_MAX_PROPERTIES_PER_COMPONENT``/``_MAX_VERSE_FILES``), and
    ``"truncation_reasons"`` (list of human-readable strings, one per cap
    or cancellation hit — also folded into ``discovery.notes``) plus
    ``"scan_stats"`` (dict of actor counts: matched, examined, capped,
    fast-rejected vs. fully-probed — see ``_inspect_tags_live``). These
    keys are what turn an empty-label_pattern scan on a huge level from an
    unbounded editor freeze into a bounded, cancellable, honestly-reported
    partial scan (see ``_MAX_ACTORS_EXAMINED``'s comment block for the
    field incident this fixes). Only present on the live path — the
    ``unreal``-unavailable early return below keeps its original 4-key
    shape unchanged.

    *project_dir*, if given, is used as the Verse source directory
    directly (validated as an existing directory); otherwise
    ``device_audit._find_verse_dir()``'s discovery ladder resolves it. If
    it cannot be resolved at all, ``verse_dir`` is None and tags are still
    returned by name with an empty ``parent_chain`` — never a silently
    empty/success-looking result (see docs/PATH-DISCOVERY.md). The tag
    class names this resolves ALSO feed tag-property detection itself: a
    property whose value contains one of the project's own known tag names
    is the strongest signal tried (see ``_value_contains_known_tag``),
    ahead of pure structural shape-matching.

    Never raises: with ``unreal`` unavailable, or on any unhandled
    exception during the live path, this returns the same 5-key discovery
    shape with an explanatory ``discovery.notes`` string instead of
    crashing or returning a misleadingly "clean" empty result. Also writes
    the result to tag_inspect_report.json (see
    ``write_report``/``report_path``) as a side effect, in every case."""
    if not _HAS_UNREAL:
        result = {
            "discovery": {
                "component_class": None,
                "tag_property": None,
                "component_properties": [],
                "component_properties_capped": False,
                "notes": (
                    "'unreal' module not available — this must run inside "
                    "UEFN's embedded Python to enumerate actors/components "
                    "live. This is a non-live/empty result, NOT a scan that "
                    "found zero tagged actors — do not read it that way."
                ),
            },
            "verse_dir": None,
            "tag_class_count": 0,
            "actors": [],
        }
        write_report(result)
        return result

    try:
        result = _inspect_tags_live(
            label_pattern, project_dir, include_location=include_location,
            max_results=max_results, offset=offset,
        )
    except Exception:
        tb = traceback.format_exc()
        try:
            unreal.log_error("tag_inspect: inspect_tags failed:\n" + tb)
        except Exception:
            pass
        last_line = tb.strip().splitlines()[-1] if tb.strip() else "<no traceback>"
        result = {
            "discovery": {
                "component_class": None,
                "tag_property": None,
                "component_properties": [],
                "component_properties_capped": False,
                "notes": "unhandled exception during inspection (see Output Log): " + last_line,
            },
            "verse_dir": None,
            "tag_class_count": 0,
            "actors": [],
            "cancelled": False,
            "truncated": False,
            "truncation_reasons": [],
            "scan_stats": None,
            "offline": None,
        }

    # Pagination is applied BEFORE field selection (mirrors
    # batch_tools.py's ordering: page first, project fields on the page
    # only -- cheaper, and fields is documented as trimming the actors
    # actually RETURNED). Both max_results and offset are None by default
    # -- nothing about the result shape changes for a caller who never
    # opts in. discovery/scan_stats/truncation/cancelled reporting always
    # describe the FULL walk, never just the current page -- see this
    # function's pagination-vs-walk-cap docstring section above.
    #
    # p3-t5: when the live path ran (_inspect_tags_live), it already did
    # the PAGE-AWARE WALK itself -- only the requested page's actors were
    # ever probed, so result["actors"] IS the page already and carries
    # result["page_extra"] (offset/returned/next_offset) plus the true
    # matched total in scan_stats["actors_matched"]. Adopting those here
    # (rather than calling _paginate_actors again) avoids re-sorting/
    # re-slicing an already-small page -- which would silently produce
    # the WRONG page (e.g. offset=400 sliced again from a 400-long list
    # returns nothing). The non-live paths below (unreal unavailable, or
    # an unhandled exception) never call _inspect_tags_live at all --
    # "actors" is always [] there, so _paginate_actors is still used for
    # those to keep their pagination-key shape (matched/offset/returned)
    # consistent with every other bridge tool's contract.
    if "page_extra" in result:
        page_extra = result.pop("page_extra")
        result["matched"] = result.get("scan_stats", {}).get("actors_matched", len(result.get("actors") or []))
        result.update(page_extra)
    elif (max_results is not None or offset is not None) and "actors" in result:
        pre_page_total = len(result["actors"])
        page, page_extra = _paginate_actors(result["actors"], max_results, offset)
        result["actors"] = page
        result["matched"] = pre_page_total
        result.update(page_extra)

    # Field selection is applied LAST, on the fully-built (and, if
    # requested, already-paginated) result, so discovery/scan_stats/
    # truncation reporting is never affected by it -- fields only trims
    # per-actor entries (see _project_actor_fields). fields=None (the
    # default) is a no-op, keeping every existing caller's shape
    # byte-identical. The written report mirrors exactly what is returned
    # (single source of truth, no divergent "full" archive silently kept
    # elsewhere).
    if fields is not None and result.get("actors"):
        result["actors"] = [_project_actor_fields(a, fields) for a in result["actors"]]

    write_report(result)
    return result


# ---------------------------------------------------------------------------
# No auto-run on import — invoked by uefn_bridge.py's _METHODS wiring or
# called directly.
# ---------------------------------------------------------------------------
