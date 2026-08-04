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
    ``discovery`` block instead of being assumed.
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
    """Editor-gettable property names of *obj*, via property_inspector's
    dir()-based enumerator when importable, else a local fallback
    reproducing the same logic (filters private/dunder names and
    callables)."""
    if _pi_get_property_names is not None:
        try:
            return _pi_get_property_names(obj)
        except Exception:
            pass
    names = []
    for name in dir(obj):
        if name.startswith("_"):
            continue
        try:
            attr = getattr(obj, name)
        except Exception:
            continue
        if callable(attr):
            continue
        names.append(name)
    return names


def _looks_like_tag_container(value):
    """Best-effort structural check: does *value* look like a
    GameplayTagContainer-ish object? True if it exposes ``.gameplay_tags``,
    or is itself a list/tuple (the plain-list fallback the spec calls
    out)."""
    if value is None:
        return False
    if hasattr(value, "gameplay_tags"):
        return True
    if isinstance(value, (list, tuple)):
        return True
    return False


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


def _extract_tags_from_component(comp):
    """Scan *comp*'s editor properties for the first one whose value looks
    like a GameplayTagContainer (see ``_looks_like_tag_container``), and
    extract normalized tag names from it. Returns
    ``(tag_property_name_or_None, [raw_tag_name, ...])``."""
    for name in _get_component_property_names(comp):
        try:
            value = comp.get_editor_property(name)
        except Exception:
            continue
        if _looks_like_tag_container(value):
            names = []
            for raw in _iter_tag_container_values(value):
                try:
                    names.append(normalize_tag_name(str(raw)))
                except Exception:
                    continue
            return name, names
    return None, []


def _find_tag_component(actor):
    """Locate the Verse-tag-bearing component on *actor*, generically —
    the class/property names are NEVER hardcoded (see module docstring).
    Preference order:
      1. A component whose class name contains "VerseTag" (case-
         insensitive).
      2. Any component exposing a property whose value looks like a
         GameplayTagContainer (see ``_looks_like_tag_container``).
    Returns ``(component, class_name, tag_property_name, [raw_tag_name,...])``
    — component is None (has_verse_tag_component: False case) only if
    neither preference found anything on this actor."""
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
            prop_name, names = _extract_tags_from_component(comp)
            return comp, class_name, prop_name, names

    for comp, class_name in candidates:
        prop_name, names = _extract_tags_from_component(comp)
        if prop_name is not None:
            return comp, class_name, prop_name, names

    return None, None, None, []


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
    discovery = {"component_class": None, "tag_property": None, "notes": ""}
    notes_parts = []

    try:
        all_actors = _get_all_actors()
    except Exception as e:
        return {
            "discovery": {
                "component_class": None,
                "tag_property": None,
                "notes": "actor enumeration failed: " + str(e),
            },
            "verse_dir": None,
            "tag_class_count": 0,
            "actors": [],
        }

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
    for label, actor in matched:
        try:
            comp, comp_class, tag_prop, raw_names = _find_tag_component(actor)
        except Exception:
            comp, comp_class, tag_prop, raw_names = None, None, None, []
        if comp is not None and discovery["component_class"] is None:
            discovery["component_class"] = comp_class
            discovery["tag_property"] = tag_prop
        raw_records.append({
            "label": label,
            "has_verse_tag_component": comp is not None,
            "component_class": comp_class,
            "raw_tag_names": raw_names,
        })

    found_count = sum(1 for r in raw_records if r["has_verse_tag_component"])
    if discovery["component_class"] is not None:
        notes_parts.append(
            "discovered tag component class {!r}, tag-container property "
            "{!r} (found on {} of {} matching actor(s)).".format(
                discovery["component_class"], discovery["tag_property"],
                found_count, len(raw_records),
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
                        "notes": str},
         "verse_dir": str|None,
         "tag_class_count": int,
         "actors": [{"label": str, "has_verse_tag_component": bool,
                      "component_class": str|None,
                      "tags": [{"name": str, "parent_chain": [str, ...]}]}]}

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
    empty/success-looking result (see docs/PATH-DISCOVERY.md).

    Never raises: with ``unreal`` unavailable, or on any unhandled
    exception during the live path, this returns the same 4-key shape with
    an explanatory ``discovery.notes`` string instead of crashing or
    returning a misleadingly "clean" empty result. Also writes the result
    to tag_inspect_report.json (see ``write_report``/``report_path``) as a
    side effect, in every case."""
    if not _HAS_UNREAL:
        result = {
            "discovery": {
                "component_class": None,
                "tag_property": None,
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
