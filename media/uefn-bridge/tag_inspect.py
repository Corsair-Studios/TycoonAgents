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
# Live (unreal-dependent) helpers
# ---------------------------------------------------------------------------

_VERSE_SCAN_SKIP = frozenset({"Saved", "Intermediate", "__pycache__", ".uefn_bridge"})
_MAX_VERSE_FILES = 4000


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


def _find_verse_files(verse_dir):
    """Walk *verse_dir* for *.verse files, skipping the same generated-file
    dirs as device_audit.py/moderation_scanner.py. Capped at
    _MAX_VERSE_FILES; returns (paths, truncated)."""
    paths = []
    truncated = False
    try:
        for dirpath, dirnames, filenames in os.walk(verse_dir):
            dirnames[:] = [
                d for d in dirnames
                if d not in _VERSE_SCAN_SKIP and not d.startswith(".")
            ]
            for fn in filenames:
                if not fn.endswith(".verse"):
                    continue
                if len(paths) >= _MAX_VERSE_FILES:
                    truncated = True
                    return paths, truncated
                paths.append(os.path.join(dirpath, fn))
    except Exception:
        pass
    return paths, truncated


def _read_verse_file_texts(paths):
    texts = []
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                texts.append(f.read())
        except Exception:
            continue
    return texts


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
    ``.gameplay_tags``-bearing container object and a plain list/tuple."""
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
    try:
        for t in container:
            yield t
    except TypeError:
        return


_MAX_DIAGNOSTIC_PROPERTIES = 40
_DIAGNOSTIC_VALUE_MAX_LEN = 80


def _truncate_diag(text):
    """Hard-truncate *text* to _DIAGNOSTIC_VALUE_MAX_LEN characters (never a
    full dump into the discovery report -- a component can carry large
    struct/array reprs). Never raises."""
    try:
        text = text if isinstance(text, str) else str(text)
    except Exception:
        return "<unrepresentable>"
    if len(text) > _DIAGNOSTIC_VALUE_MAX_LEN:
        return text[: _DIAGNOSTIC_VALUE_MAX_LEN - 3] + "..."
    return text


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


def _extract_tags_from_component(comp, known_tag_names=None):
    """Scan *comp*'s editor properties (via ``_get_component_property_names``,
    the pooled multi-source enumerator) to find the tag-container property
    and extract normalized tag names from it.

    Two independent detection signals are tried, in order of confidence:
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
    ``{"properties": [{"name", "type", "value_repr"}, ...], "capped": bool}``
    covering EVERY property this scan saw on *comp* (capped at
    ``_MAX_DIAGNOSTIC_PROPERTIES``, each value_repr hard-truncated to
    ``_DIAGNOSTIC_VALUE_MAX_LEN`` chars) -- populated UNCONDITIONALLY, not
    only on failure, so a caller can always surface it. This is what turns
    a dead ``tag_property: null`` into an actionable report (see module
    docstring's field case and ``inspect_tags``'s discovery contract)."""
    known_tag_names = known_tag_names or ()
    diagnostic_props = []
    capped = False
    content_hit_name = None
    shape_candidates = []  # [(name, value), ...]

    for name in _get_component_property_names(comp):
        try:
            value = comp.get_editor_property(name)
        except Exception:
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

    diagnostics = {"properties": diagnostic_props, "capped": capped}

    winner_name = None
    winner_value = None
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
            except Exception:
                winner_value = None
    elif shape_candidates:
        if len(shape_candidates) == 1:
            winner_name, winner_value = shape_candidates[0]
        else:
            tag_named = [c for c in shape_candidates if "tag" in c[0].lower()]
            winner_name, winner_value = tag_named[0] if tag_named else shape_candidates[0]

    if winner_name is None:
        return None, [], diagnostics

    names = []
    for raw in _iter_tag_container_values(winner_value):
        try:
            names.append(normalize_tag_name(str(raw)))
        except Exception:
            continue
    if not names and winner_value is not None and winner_name == content_hit_name:
        # Content-hit-but-non-iterable case (e.g. a single-tag string
        # field) -- treat the value itself as one raw tag rather than
        # reporting zero tags for a property we're confident is the
        # right one.
        try:
            names = [normalize_tag_name(str(winner_value))]
        except Exception:
            names = []

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
      2. Any component exposing a property whose value looks like a
         GameplayTagContainer (see ``_looks_like_tag_container``) or whose
         value contains a known tag name (see ``_value_contains_known_tag``).
    Returns ``(component, class_name, tag_property_name, [raw_tag_name,...],
    diagnostics)`` — component is None (has_verse_tag_component: False
    case) only if neither preference found anything on this actor."""
    try:
        components = actor.get_components_by_class(unreal.ActorComponent)
    except Exception:
        components = []

    candidates = []
    for comp in components:
        try:
            class_name = comp.get_class().get_name()
        except Exception:
            class_name = "<component>"
        candidates.append((comp, class_name))

    for comp, class_name in candidates:
        if "versetag" in class_name.lower():
            prop_name, names, diagnostics = _extract_tags_from_component(comp, known_tag_names)
            return comp, class_name, prop_name, names, diagnostics

    for comp, class_name in candidates:
        prop_name, names, diagnostics = _extract_tags_from_component(comp, known_tag_names)
        if prop_name is not None:
            return comp, class_name, prop_name, names, diagnostics

    return None, None, None, [], {"properties": [], "capped": False}


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


def _inspect_tags_live(label_pattern, project_dir):
    """The live (unreal-dependent) inspection path. Only called when
    ``_HAS_UNREAL`` is True; every editor call is individually guarded."""
    discovery = {
        "component_class": None,
        "tag_property": None,
        "component_properties": [],
        "component_properties_capped": False,
        "notes": "",
    }
    notes_parts = []

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
        }

    # Resolve verse_dir / tag_classes FIRST, independent of actor scanning,
    # so the project's own discovered Verse tag class names (e.g.
    # "t_area_hoth") are available as the CONTENT-based detection signal
    # (see _value_contains_known_tag) while scanning each candidate
    # component's properties below — grounded in real project data rather
    # than a generic shape/name guess.
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
    if verse_dir:
        file_paths, truncated = _find_verse_files(verse_dir)
        texts = _read_verse_file_texts(file_paths)
        class_map = build_class_map(texts)
        tag_classes = build_tag_class_set(class_map)
        notes_parts.append(
            "verse_dir resolved via {} ({} *.verse file(s) scanned{}, {} "
            "tag class(es) found).".format(
                verse_source, len(file_paths),
                " — TRUNCATED at the file-count cap" if truncated else "",
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

    label_of = _safe_label_fn if _safe_label_fn is not None else _fallback_label

    matched = []
    for actor in all_actors:
        try:
            label = label_of(actor)
        except Exception:
            continue
        if match_label(label, label_pattern):
            matched.append((label, actor))

    raw_records = []
    first_component_diagnostics = None
    for label, actor in matched:
        try:
            comp, comp_class, tag_prop, raw_names, diagnostics = _find_tag_component(
                actor, known_tag_names
            )
        except Exception:
            comp, comp_class, tag_prop, raw_names = None, None, None, []
            diagnostics = {"properties": [], "capped": False}
        if comp is not None and discovery["component_class"] is None:
            discovery["component_class"] = comp_class
            discovery["tag_property"] = tag_prop
            first_component_diagnostics = diagnostics
        raw_records.append({
            "label": label,
            "has_verse_tag_component": comp is not None,
            "component_class": comp_class,
            "raw_tag_names": raw_names,
        })

    found_count = sum(1 for r in raw_records if r["has_verse_tag_component"])
    if discovery["component_class"] is not None and discovery["tag_property"] is not None:
        notes_parts.append(
            "discovered tag component class {!r}, tag-container property "
            "{!r} (found on {} of {} matching actor(s)).".format(
                discovery["component_class"], discovery["tag_property"],
                found_count, len(raw_records),
            )
        )
    elif discovery["component_class"] is not None:
        # Component found, but no property on it matched a tag-container
        # shape or content — the exact false-negative field case this
        # module exists to eliminate (component_class discovered,
        # tag_property stayed null even though the actor was demonstrably
        # tagged). Surface EVERY property this scan actually saw on that
        # component so the NEXT run needs no separate probe — a dead null
        # is never returned without the evidence behind it.
        if first_component_diagnostics is not None:
            discovery["component_properties"] = first_component_diagnostics["properties"]
            discovery["component_properties_capped"] = first_component_diagnostics["capped"]
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
            "no Verse-tag-bearing component found on any of the {} matching "
            "actor(s) — looked for a component class name containing "
            "'VerseTag', and for any component exposing a GameplayTag"
            "Container-like property.".format(len(raw_records))
        )
    else:
        notes_parts.append("no actors matched label_pattern={!r}.".format(label_pattern))

    actors_out = []
    for rec in raw_records:
        tags_out = []
        for raw_name in rec["raw_tag_names"]:
            chain = tag_classes.get(raw_name)
            tags_out.append({
                "name": raw_name,
                "parent_chain": list(chain) if chain else [],
            })
        actors_out.append({
            "label": rec["label"],
            "has_verse_tag_component": rec["has_verse_tag_component"],
            "component_class": rec["component_class"],
            "tags": tags_out,
        })

    actors_out = sort_actors_flagged_first(actors_out)
    discovery["notes"] = " ".join(notes_parts)

    return {
        "discovery": discovery,
        "verse_dir": verse_dir,
        "tag_class_count": len(tag_classes),
        "actors": actors_out,
    }


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

def inspect_tags(label_pattern=None, project_dir=None):
    """Enumerate level actors (optionally filtered by *label_pattern* —
    plain substring or "*"-wildcard, case-insensitive; see ``match_label``)
    and report their Verse gameplay tags, discovering the tag-bearing
    component class and its tag-container property NAME AT RUNTIME rather
    than assuming one (see module docstring for why).

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
                      "tags": [{"name": str, "parent_chain": [str, ...]}]}]}

    ``discovery.component_properties`` is populated ONLY in the specific
    failure case that matters most: a tag-bearing component WAS found
    (``component_class`` is set) but no property on it could be identified
    as the tag container (``tag_property`` stayed ``None``). It lists
    every editor-gettable property this scan actually saw on that
    component — name, Python type name, and a value repr hard-truncated to
    80 chars — capped at 40 entries (``component_properties_capped`` flags
    truncation). This turns a dead ``tag_property: null`` into an
    actionable report: the next probe of that project needs no separate
    run, because what was actually seen on the component is right here.

    Actors with ``has_verse_tag_component: False`` OR an empty ``tags``
    list are sorted FIRST in ``actors`` (see ``sort_actors_flagged_first``)
    — never silently omitted; this is the failure mode described in the
    module docstring's field case. Every actor matching *label_pattern* is
    always present in the result.

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
        result = _inspect_tags_live(label_pattern, project_dir)
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
        }

    write_report(result)
    return result


# ---------------------------------------------------------------------------
# No auto-run on import — invoked by uefn_bridge.py's _METHODS wiring or
# called directly.
# ---------------------------------------------------------------------------
