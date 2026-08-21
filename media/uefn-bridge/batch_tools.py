"""
UEFN Batch Operations
======================
Batch property read/write for Fortnite Creative devices.
Runs inside UEFN's embedded Python 3.11 (requires ``unreal`` module).

Provides two interfaces:
  1. **Programmatic / MCP-callable** — ``batch_set_property()`` and
     ``batch_get_property()`` work without tkinter.
  2. **Tkinter UI** — ``show_batch_ui()`` opens an interactive window.

Usage:
    from batch_tools import batch_set_property, batch_get_property, show_batch_ui
"""

import unreal
import os
import traceback
import webbrowser
from fnmatch import fnmatch

from device_audit import _is_device, _safe_label, _actor_location_tuple

try:
    import tkinter as tk
    from tkinter import ttk
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Theme constants (matching launcher palette)
# ---------------------------------------------------------------------------

_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_GREEN = "#2F8F3E"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"
_ENTRY_BG = "#FBFAF6"
_ENTRY_FG = "#1A1A1A"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_all_actors():
    """Return all level actors via EditorActorSubsystem."""
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception as e:
        raise RuntimeError(f"get_editor_subsystem raised: {e}") from e
    if subsystem is None:
        raise RuntimeError("Could not get EditorActorSubsystem")
    try:
        return subsystem.get_all_level_actors()
    except Exception as e:
        raise RuntimeError(f"get_all_level_actors raised: {e}") from e


def _coerce_value(new_value, current_value):
    """
    Coerce *new_value* (which may be a string from JSON) to match the type
    of *current_value*.  If *current_value* is None, return *new_value* as-is.
    """
    if current_value is None:
        return new_value

    target_type = type(current_value)

    # Already the correct type
    if isinstance(new_value, target_type):
        return new_value

    # Boolean -- handle string "true"/"false" and numeric 0/1
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


def _match_actors(filter_type, filter_value, require_device=True):
    """
    Return a list of (actor, label, class_name) tuples matching the filter,
    sorted into a STABLE, deterministic order.

    filter_type: "class" | "label" | "all_devices"
    filter_value: pattern string (ignored for "all_devices")
    require_device: when True (default — unchanged behavior for existing
        callers batch_set_property/batch_get_property), actors are first
        gated through device_audit._is_device, so only Creative devices are
        ever considered. Pass False to match ANY actor in the level,
        device or not — this is what batch_get_location (below) uses, so
        filter syntax ("class"/"label"/"all_devices") stays identical for
        device and non-device actors alike. NOTE: "all_devices" as a
        filter_type name is a historical misnomer when require_device is
        False — it still means "match everything", just not device-only.

    ORDERING (why this exists / pagination correctness):
    get_all_level_actors() makes no ordering guarantee across separate
    calls -- UEFN backs it with an engine-side container whose iteration
    order is not part of any documented contract. Cursor pagination
    (offset/max_results in batch_get_property/batch_get_location below)
    depends on calling _match_actors() again for EACH page and slicing a
    different [offset:offset+max_results] window each time -- if two calls
    could return the matched set in a different order, a later page could
    silently re-return an actor an earlier page already returned (a
    duplicate) or skip one entirely (a gap), and the caller would have no
    way to detect either failure from the response shape alone. Sorting
    matched results by (label, class_name) before returning -- a key that
    depends only on the actor's own attributes, not on iteration order or
    object identity -- makes the sequence stable across repeated calls in
    the SAME session, which is what makes offset-based slicing sound.

    What this does NOT guarantee: if an actor is added to or removed from
    the level between two paginated calls (e.g. another user's concurrent
    edit, or a script mutating the level mid-sweep), the matched set itself
    changes, and offsets computed against the old set no longer line up
    against the new one -- a page boundary can shift, causing a duplicate
    or a gap at that boundary. This sort makes ordering deterministic for a
    STABLE level; it cannot make pagination atomic against concurrent
    mutation, since there is no engine-side snapshot/cursor primitive this
    module has access to. Two actors that happen to share both label and
    class_name (e.g. two unlabeled default-named actors of the same type)
    are not given a further tiebreaker -- this is a known residual
    instability for that specific collision, accepted because Python's
    sort is stable and such actors are interchangeable for any filter that
    matched both of them identically.
    """
    all_actors = _get_all_actors()
    matched = []

    for actor in all_actors:
        try:
            if require_device and not _is_device(actor):
                continue

            label = _safe_label(actor)
            class_name = actor.get_class().get_name()

            if filter_type == "all_devices":
                matched.append((actor, label, class_name))

            elif filter_type == "class":
                # Case-insensitive substring match
                if filter_value.lower() in class_name.lower():
                    matched.append((actor, label, class_name))

            elif filter_type == "label":
                # Case-insensitive fnmatch glob
                if fnmatch(label.lower(), filter_value.lower()):
                    matched.append((actor, label, class_name))

        except Exception:
            continue

    # Stable sort by (label, class_name) -- see ORDERING above. This is
    # the sole mechanism guaranteeing repeated calls slice the same
    # sequence, which cursor pagination requires to avoid gaps/duplicates.
    matched.sort(key=lambda entry: (entry[1], entry[2]))
    return matched


# ---------------------------------------------------------------------------
# Shared status-shape helpers
# ---------------------------------------------------------------------------
#
# batch_get_property, batch_get_location, and batch_set_property all share
# the same top-level ``status`` contract (error / zero_match /
# property_unresolved / partial / ok) -- see batch_get_property's docstring
# below for the authoritative description of each status and its keys. The
# three functions differ only in HOW a per-actor entry is built (a read
# resolves a value; a write mutates one) and in the operation-specific noun
# used in "reason"/"unresolved_on" prose (e.g. "read" vs "set"). The
# skeleton -- which status applies given (matched_count, failed_count), and
# which keys wrap the per-actor list -- is identical across all three, so it
# is factored here rather than re-derived three times.

def _match_error_result(filter_type, filter_value, error):
    """status == "error": _match_actors() itself raised."""
    return {
        "status": "error",
        "reason": "_match_actors raised while resolving filter_type={0!r} filter_value={1!r}".format(
            filter_type, filter_value
        ),
        "filter_type": filter_type,
        "filter_value": filter_value,
        "error": str(error),
        "matched": 0,
        "actors": [],
    }


_FNMATCH_WILDCARD_CHARS = ("*", "?", "[")


def _zero_match_result(filter_type, filter_value, verb="read"):
    """status == "zero_match": the filter matched no actors at all."""
    reason = (
        "No actors matched filter_type={0!r} filter_value={1!r}. "
        "The property was never {2} -- this is not a property-resolution "
        "failure.".format(filter_type, filter_value, verb)
    )

    # label filters are fnmatch globs (see _match_actors), not substring
    # matches -- a bare value like "SGMarker" only matches an actor whose
    # label is EXACTLY "sgmarker". Teach the caller the fix using their own
    # input rather than a generic example. Does not apply to "class", which
    # is genuinely a substring match.
    if (
        filter_type == "label"
        and isinstance(filter_value, str)
        and not any(ch in filter_value for ch in _FNMATCH_WILDCARD_CHARS)
    ):
        reason += (
            " label filters are fnmatch glob patterns, not substrings -- "
            "try filter_value={0!r}.".format("*{0}*".format(filter_value))
        )

    return {
        "status": "zero_match",
        "reason": reason,
        "filter_type": filter_type,
        "filter_value": filter_value,
        "matched": 0,
        "actors": [],
    }


def _resolved_status_result(
    property_name, matched_count, unresolved_on, results,
    unresolved_reason, partial_reason, cap_extra=None,
):
    """
    Build the status result once per-actor entries are known, choosing
    between "ok" / "property_unresolved" / "partial" from how many of
    matched_count are in unresolved_on. Shared by batch_get_property,
    batch_get_location (matched, no property_name -- pass None), and
    batch_set_property.

    unresolved_reason / partial_reason are the exact "reason" strings for
    those two statuses -- each caller supplies its own operation-specific
    wording (read vs write, "location" having no property_name) so this
    helper reproduces every existing caller's text byte-for-byte rather
    than guessing at a generic phrasing that could drift from what tests
    (or downstream agents) already depend on.

    cap_extra: optional dict of additive keys (from _apply_pagination) --
    "offset", "returned", and, only when another page remains,
    "next_offset". Merged into every status branch identically, since a
    caller paging through 6000 matches 2000 at a time can land on "ok" on
    one page (all 2000 RETURNED entries on that page resolved) just as
    easily as "partial" on another -- pagination and per-entry resolution
    are independent facts and both must be visible together rather than
    one silently overwriting the other.
    """
    base_extra = {}
    if property_name is not None:
        base_extra["property_name"] = property_name
    if cap_extra:
        base_extra.update(cap_extra)

    if not unresolved_on:
        result = {"status": "ok", "matched": matched_count, "actors": results}
        result.update(base_extra)
        return result

    if len(unresolved_on) == matched_count:
        result = {
            "status": "property_unresolved",
            "reason": unresolved_reason,
            "matched": matched_count,
            "unresolved_on": unresolved_on,
            "actors": results,
        }
        result.update(base_extra)
        return result

    result = {
        "status": "partial",
        "reason": partial_reason,
        "matched": matched_count,
        "unresolved_on": unresolved_on,
        "actors": results,
    }
    result.update(base_extra)
    return result


# ---------------------------------------------------------------------------
# Cursor pagination (opt-in via max_results + offset) + field selection
# (opt-in via fields)
# ---------------------------------------------------------------------------
#
# CORRECTION (p3-t3, reverses p3-t1): p3-t1 shipped max_results as a hard
# CEILING -- it truncated the walk and reported the rest as missing,
# telling the caller to narrow its filter to see them. That was rejected:
# for an audit tool the requirement is FULL COVERAGE of every matched
# actor (measured up to 44,753 in the reference project), and truncation
# answers a different, unasked question ("here's SOME of it") instead of
# the one that matters ("here's ALL of it, safely"). Silently dropping
# rows an agent never explicitly asked to skip is exactly the kind of
# quiet failure this codebase's discovery/honesty doctrine forbids.
#
# The actual constraint was never the 180s bridge timeout (already raised
# for these commands in uefn-server.ts) -- it's PAYLOAD SIZE: one
# response_{id}.json the calling agent must load whole into context. A
# 392-actor location result measured 87,453 bytes (~223 bytes/actor), so
# an unpaginated 44,753-actor sweep would approach ~10 MB, and
# moderation_scanner.py's own comments note tens-of-MB payloads drop the
# stdio connection. Pagination answers full coverage in bounded pieces
# instead of truncating the question away.
#
# max_results is now PAGE SIZE, not a ceiling: omit it (None/0/negative)
# and the FULL matched set is walked and returned in one response, exactly
# as it was before max_results existed at all -- there is no default cap
# left underneath. Pass it and it bounds ONE page; pair it with offset to
# select which page. Every paginated response additionally carries
# "matched" (true total), "offset" (page requested), "returned" (how many
# actually came back on this page), and "next_offset" (the offset to
# request next, or None/absent once the caller has reached the final
# page) -- an agent loops from offset=0 until next_offset is None/absent
# and has then covered the whole matched set, deterministically, PROVIDED
# _match_actors' ordering guarantee holds (see that function's docstring).


def _apply_pagination(matched_actors, max_results, offset):
    """
    Slice *matched_actors* into one page. Returns (actors_for_walk,
    page_extra) where page_extra is a dict of additive result keys ready
    to merge into _resolved_status_result's output.

    Backward compatibility / no-parameters case: when BOTH max_results and
    offset are absent (None), returns the ENTIRE matched_actors list and
    an EMPTY page_extra dict ({}) -- not merely "not truncated" but no new
    keys at all -- so a caller who never opts into pagination sees a
    byte-identical response shape to before pagination existed. This is
    the "no silent ceiling" requirement: full coverage is the default.

    offset defaults to 0 when max_results is given but offset is not
    (first page). offset past the end of matched_actors returns an empty
    page with next_offset absent (nothing left) rather than raising --
    consistent with this module's "never crash on caller input" posture.
    max_results <= 0 is treated as "no page limit" for that call, i.e.
    behaves like the no-parameters case but still echoes offset/returned/
    next_offset because the caller explicitly opted in by passing
    max_results.

    Slices the WALK itself (before the per-actor loop runs), not a
    post-hoc drop after resolving every property -- so a page never pays
    the cost of actors outside it.
    """
    total = len(matched_actors)

    if max_results is None and offset is None:
        return matched_actors, {}

    effective_offset = offset if offset is not None else 0
    if effective_offset < 0:
        effective_offset = 0

    if max_results is None or max_results <= 0:
        page = matched_actors[effective_offset:]
        page_extra = {
            "offset": effective_offset,
            "returned": len(page),
        }
        return page, page_extra

    page = matched_actors[effective_offset:effective_offset + max_results]
    next_offset = effective_offset + len(page)
    page_extra = {
        "offset": effective_offset,
        "returned": len(page),
    }
    if next_offset < total:
        page_extra["next_offset"] = next_offset
    return page, page_extra


def _project_fields(entry, fields, always_keep=("label",)):
    """
    Return a copy of per-actor *entry* containing only the keys named in
    *fields*, plus everything in *always_keep* (identity fields kept
    regardless, so a field-selected entry can still be attributed to an
    actor). fields=None (the default everywhere this is called) returns
    *entry* completely unchanged -- this is what keeps every existing
    caller's shape byte-identical when the new parameter is omitted.
    Unknown field names in *fields* are silently absent from the output
    (not an error) -- the same "never crash on a caller's field typo"
    posture as the rest of this module's caller-facing surface.
    """
    if fields is None:
        return entry
    keep = set(fields) | set(always_keep)
    return {k: v for k, v in entry.items() if k in keep}


# ---------------------------------------------------------------------------
# Core functions (MCP-callable, no tkinter dependency)
# ---------------------------------------------------------------------------

def batch_set_property(filter_type, filter_value, property_name, value, dry_run=False):
    """
    Set a property on multiple actors matching a filter.

    Args:
        filter_type: "class" | "label" | "all_devices"
        filter_value: class name pattern, label glob pattern, or "" for all_devices
        property_name: UE property name to set
        value: value to set (string, will be coerced)
        dry_run: if True, just report what would change without modifying

    Returns:
        dict. ``status`` is the top-level field a caller MUST check first --
        it follows the SAME contract as batch_get_property (see that
        function's docstring for the authoritative description). The
        write-path adaptation of each status:

          - status == "error"
                _match_actors() itself raised. Keys: status, reason,
                filter_type, filter_value, error, matched=0, actors=[].

          - status == "zero_match"
                The filter matched no actors -- nothing was ever set. Keys:
                status, reason, filter_type, filter_value, matched=0,
                actors=[]. This is the exact case that used to be
                indistinguishable from "property_unresolved" below: both
                collapsed into an empty-looking {"matched": 0, "actors": []}.

          - status == "property_unresolved"
                Actors matched, but set_editor_property(property_name, ...)
                failed on EVERY one of them (e.g. a read-only or
                nonexistent property name). Keys: status, reason,
                property_name, matched, actors (all ok=False with an
                explicit, non-empty error string each), unresolved_on (==
                every matched label). Same status STRING as the read path
                for consistency -- an agent that has learned to check for
                "property_unresolved" on batch_get_property does not need a
                second vocabulary for batch_set_property -- but "reason"
                and the per-actor error text describe a SET failure, not a
                read failure.

          - status == "partial"
                Some actors were set successfully, some were not. Per-actor
                entries carry an explicit ok: True/False marker -- failed
                entries are never dropped or coerced to None/empty. Keys:
                status, reason, property_name, matched, actors,
                unresolved_on (labels that failed).

          - status == "ok"
                Every matched actor was set successfully (or would be, in
                dry_run mode -- dry_run never causes a "set" to be
                attempted, so it cannot itself produce a failure status).
                Keys: status, matched, actors.

        Per-actor entry shape ({label, class, ok, ...}): a write succeeds
        or fails per actor rather than resolving a value, so the READ
        path's "value" key (what get_editor_property returned) is not the
        natural fit here. Instead each entry carries "old_value" and
        "new_value" (both stringified) -- this is the pre-existing shape
        legacy callers of batch_set_property already read via
        result["actors"][i]["old_value"/"new_value"], so it is kept
        additively rather than replaced. On failure, "new_value" keeps its
        legacy "<error: ...>" string form AND a new explicit "error" key is
        added carrying the same message as a plain string (never coerced
        to None), matching the read path's failure-entry contract of
        always exposing a real "error" key callers can test for
        independent of parsing "new_value" text.

        modified: int -- retained additively (legacy key: number of actors
        actually changed, 0 if dry_run or if every set failed).

        Backward compatibility: matched, actors[].label/class/old_value/
        new_value, and modified are unchanged in name and meaning from the
        pre-fix shape, so existing callers reading only those keys keep
        working -- status/reason/property_name/unresolved_on/actors[].ok/
        actors[].error are additive.
    """
    try:
        matched_actors = _match_actors(filter_type, filter_value)
    except Exception as e:
        unreal.log_warning(f"batch_tools: batch_set_property failed to get actors: {e}")
        result = _match_error_result(filter_type, filter_value, e)
        result["modified"] = 0
        return result

    if not matched_actors:
        result = _zero_match_result(filter_type, filter_value, verb="set")
        result["modified"] = 0
        return result

    results = []
    unresolved_on = []
    modified_count = 0

    for actor, label, class_name in matched_actors:
        try:
            # Read current value
            try:
                current = actor.get_editor_property(property_name)
                old_value_str = str(current)
            except Exception:
                current = None
                old_value_str = "<unreadable>"

            coerced = _coerce_value(value, current)
            new_value_str = str(coerced)

            if not dry_run:
                actor.set_editor_property(property_name, coerced)
                modified_count += 1

            results.append({
                "label": label,
                "class": class_name,
                "ok": True,
                "old_value": old_value_str,
                "new_value": new_value_str,
            })
        except Exception as e:
            unresolved_on.append(label)
            results.append({
                "label": label,
                "class": class_name,
                "ok": False,
                "old_value": "<error>",
                "new_value": "<error: " + str(e) + ">",
                "error": str(e),
            })

    matched_count = len(matched_actors)
    unresolved_reason = (
        "property_name={0!r} could not be set via set_editor_property() "
        "on any of the {1} matched actor(s). It may not be an editor property "
        "at all, or it may be read-only.".format(property_name, matched_count)
    )
    partial_reason = (
        "property_name={0!r} was set on {1} of {2} matched actor(s); see "
        "unresolved_on and per-actor 'ok' flags for which failed.".format(
            property_name, matched_count - len(unresolved_on), matched_count
        )
    )
    result = _resolved_status_result(
        property_name, matched_count, unresolved_on, results,
        unresolved_reason, partial_reason,
    )
    result["modified"] = modified_count
    return result


def batch_get_property(filter_type, filter_value, property_name, fields=None, max_results=None, offset=None):
    """
    Read a property from multiple actors matching a filter.

    Args:
        filter_type: "class" | "label" | "all_devices"
        filter_value: class name pattern, label glob pattern, or "" for all_devices
        property_name: UE property name to read
        fields: optional list of per-actor keys to return (e.g.
            ["label", "value"]) instead of the full {label, class, ok,
            value[, error]} set. "label" is always kept regardless of
            whether it is listed, so a field-selected entry can still be
            attributed to an actor. Omitted (None, the default) returns
            every field exactly as before -- existing callers see
            byte-identical output. Unknown names are silently ignored,
            not an error. batch_get's shape is already lean (~223
            bytes/actor measured on a 392-actor real query) so this
            mainly pays off when combined with pagination, or when a
            caller wants ONLY value for a huge match set.
        max_results: optional PAGE SIZE -- when given, bounds how many
            matched actors this ONE call walks and returns (the walk
            itself is sliced, not a post-hoc drop -- actors outside the
            page are never even touched). Omitted (None, the default,
            together with offset also omitted) returns EVERY matched
            actor in one response, exactly as before pagination existed
            -- there is no default cap underneath. Pair with offset to
            select which page; see "Cursor pagination" below.
        offset: optional zero-based index into the matched (sorted, see
            _match_actors) set selecting where this page starts.
            Defaults to 0 when max_results is given but offset is not.
            Omitted together with max_results, the full set is returned.

    Cursor pagination: when max_results and/or offset are passed, the
    result additionally carries "offset" (page requested), "returned"
    (how many actors came back on this page), and "next_offset" (present
    only when another page remains -- absent/None on the final page). A
    caller sweeps the full matched set by looping with offset=0,
    max_results=N, then re-calling with offset=result["next_offset"]
    until "next_offset" is absent -- the union of every page's "actors"
    is then the complete matched set, exactly once each, PROVIDED the
    level is not mutated between calls (see _match_actors' ORDERING
    docstring for the exact guarantee and its limits).

    Returns:
        dict. ``status`` is the top-level field a caller MUST check first —
        it disambiguates the failure modes that used to collapse into the
        same empty-looking {"matched": 0, "actors": []} shape:

          - status == "error"
                _match_actors() itself raised. Keys: status, reason,
                filter_type, filter_value, error, matched=0, actors=[].

          - status == "zero_match"
                The filter matched no actors at all -- nothing was ever
                read. Keys: status, reason, filter_type, filter_value,
                matched=0, actors=[].

          - status == "property_unresolved"
                Actors matched, but property_name failed to resolve via
                get_editor_property() on EVERY matched actor (e.g. a world
                property like "location" that is never an editor property).
                Keys: status, reason, property_name, matched, actors
                (per-actor entries all carrying ok=False + error), and
                unresolved_on: the list of actor labels it failed on
                (== every matched label in this case).

          - status == "partial"
                Some actors resolved, some did not. Per-actor entries carry
                an explicit ok: True/False marker -- failed entries are
                never dropped or coerced to null. Keys: status, reason,
                property_name, matched, actors, unresolved_on (labels that
                failed).

          - status == "ok"
                Every matched actor resolved property_name. Keys: status,
                matched, actors -- unchanged from the legacy shape, so
                existing callers reading {"matched", "actors"} keep working.
                Each actor entry also now carries ok: True and the legacy
                "value" key, for backward compatibility.

    SPECIAL CASE -- property_name == "location" (case-insensitive: "Location",
    "LOCATION", etc. all normalize to the same path): world-space location is
    never a get_editor_property() name (that is the exact incident this task
    fixes), so this delegates to batch_get_location(filter_type, filter_value)
    -- the SAME helper p2-t1's dedicated uefn_batch_get_location command uses
    -- and reshapes its "location" entries into this function's {label, class,
    ok, value} per-actor shape. "value" holds the location as a 3-tuple
    (x, y, z) -- the natural shape for a coordinate, consistent with how
    other property values are strings but this one is structured data callers
    will want to unpack directly. The status contract (error / zero_match /
    property_unresolved / partial / ok) and unresolved_on carry through
    unchanged from batch_get_location. "transform" (rotation/scale) is NOT
    special-cased: _actor_location_tuple only returns position, and faking a
    transform shape from position-only data would misrepresent the actor's
    orientation/scale, so "transform" continues to route through
    get_editor_property() like any other property_name (it will typically
    fail there for the same reason "location" used to).
    """
    normalized_property_name = property_name.strip().lower() if isinstance(property_name, str) else property_name
    if normalized_property_name == "location":
        location_result = batch_get_location(filter_type, filter_value, max_results=max_results, offset=offset)
        reshaped_actors = []
        for entry in location_result.get("actors", []):
            if entry.get("ok"):
                loc = entry["location"]
                coords = (loc["x"], loc["y"], loc["z"])
                reshaped_actors.append({
                    "label": entry["label"],
                    "class": entry["class"],
                    "ok": True,
                    "value": coords,
                })
            else:
                reshaped_actors.append({
                    "label": entry["label"],
                    "class": entry["class"],
                    "ok": False,
                    "value": "<error: " + entry.get("error", "unknown") + ">",
                    "error": entry.get("error", "unknown"),
                })

        reshaped = dict(location_result)
        reshaped["actors"] = [_project_fields(e, fields) for e in reshaped_actors]
        if "property_name" not in reshaped and reshaped["status"] not in ("error", "zero_match"):
            reshaped["property_name"] = property_name
        return reshaped

    try:
        matched_actors = _match_actors(filter_type, filter_value)
    except Exception as e:
        unreal.log_warning(f"batch_tools: batch_get_property failed to get actors: {e}")
        return _match_error_result(filter_type, filter_value, e)

    if not matched_actors:
        return _zero_match_result(filter_type, filter_value, verb="read")

    actors_for_walk, cap_extra = _apply_pagination(matched_actors, max_results, offset)

    results = []
    unresolved_on = []

    for actor, label, class_name in actors_for_walk:
        try:
            val = actor.get_editor_property(property_name)
            results.append({
                "label": label,
                "class": class_name,
                "ok": True,
                "value": str(val),
            })
        except Exception as e:
            unresolved_on.append(label)
            results.append({
                "label": label,
                "class": class_name,
                "ok": False,
                "value": "<error: " + str(e) + ">",
                "error": str(e),
            })

    matched_count = len(matched_actors)
    returned_count = len(actors_for_walk)
    unresolved_reason = (
        "property_name={0!r} could not be resolved via get_editor_property() "
        "on any of the {1} matched actor(s). It may not be an editor property "
        "at all (e.g. world-space transform values require a dedicated getter, "
        "not get_editor_property).".format(property_name, returned_count)
    )
    partial_reason = (
        "property_name={0!r} resolved on {1} of {2} matched actor(s); see "
        "unresolved_on and per-actor 'ok' flags for which failed.".format(
            property_name, returned_count - len(unresolved_on), returned_count
        )
    )
    result = _resolved_status_result(
        property_name, matched_count, unresolved_on, results,
        unresolved_reason, partial_reason, cap_extra=cap_extra,
    )
    result["actors"] = [_project_fields(e, fields) for e in result["actors"]]
    return result


def batch_get_location(filter_type, filter_value, fields=None, max_results=None, offset=None):
    """
    Read the world location of EVERY actor matching a filter — device or
    not. This is the fix for the incident where a developer needed
    locations for arbitrary (non-device) actors like SGMarker and had no
    single-call path: uefn_tag_inspect returns labels/tags with no
    coordinates, and batch_get_property(property_name="location") can never
    work because "location" is not a get_editor_property() name — world
    transform requires actor.get_actor_location(), which is exactly what
    device_audit._actor_location_tuple wraps.

    SHARED-HELPER SEAM for p2-t2: this function IS the seam. p2-t2 special-
    cases property_name == "location" inside batch_get_property() by
    calling batch_get_location(filter_type, filter_value) and adapting its
    "actors" entries into batch_get_property's {label, class, ok, value}
    per-actor shape (value = str((x, y, z)) or similar) — do NOT have
    p2-t2 re-call _actor_location_tuple() or re-implement the filter loop
    below; call this function and reshape its result instead.

    Args:
        filter_type: "class" | "label" | "all_devices" (matches ANY actor
            when require_device=False is used internally — "all_devices"
            is a historical name, see _match_actors' docstring)
        filter_value: class name pattern, label glob pattern, or "" for
            "all_devices"
        fields: optional list of per-actor keys to return -- see
            batch_get_property's docstring (same _project_fields helper,
            same "label" always kept, same "omitted == unchanged shape"
            contract).
        max_results: optional PAGE SIZE; offset: optional page start --
            see batch_get_property's docstring (same _apply_pagination
            helper, same additive offset/returned/next_offset keys, same
            "omitted == full matched set, unchanged shape" contract).

    Returns:
        dict following the SAME status contract as batch_get_property()
        above (status field MUST be checked first):

          - status == "error": _match_actors() itself raised. Keys:
                status, reason, filter_type, filter_value, error,
                matched=0, actors=[].
          - status == "zero_match": the filter matched no actors at all.
                Keys: status, reason, filter_type, filter_value,
                matched=0, actors=[].
          - status == "property_unresolved": actors matched, but
                get_actor_location() failed on EVERY one of them. Keys:
                status, reason, matched, actors (all ok=False with an
                explicit error string each), unresolved_on (== every
                matched label).
          - status == "partial": some actors resolved, some did not.
                Keys: status, reason, matched, actors, unresolved_on.
          - status == "ok": every matched actor resolved a location. Keys:
                status, matched, actors.

        Each actor entry always carries {label, class, ok, location} on
        success (location = {"x", "y", "z"}, the same shape
        _handle_list_devices already emits — labels are included
        alongside coordinates on purpose: the incident was someone wanting
        BOTH together in one call, and a location-only response would have
        forced a second call just to correlate coordinates back to which
        marker they belonged to) or {label, class, ok=False, error} on
        failure — a broken actor is never silently dropped from the list.
    """
    try:
        matched_actors = _match_actors(filter_type, filter_value, require_device=False)
    except Exception as e:
        unreal.log_warning(f"batch_tools: batch_get_location failed to get actors: {e}")
        return _match_error_result(filter_type, filter_value, e)

    if not matched_actors:
        return _zero_match_result(filter_type, filter_value, verb="read")

    actors_for_walk, cap_extra = _apply_pagination(matched_actors, max_results, offset)

    results = []
    unresolved_on = []

    for actor, label, class_name in actors_for_walk:
        try:
            x, y, z = _actor_location_tuple(actor)
            results.append({
                "label": label,
                "class": class_name,
                "ok": True,
                "location": {"x": x, "y": y, "z": z},
            })
        except Exception as e:
            unresolved_on.append(label)
            results.append({
                "label": label,
                "class": class_name,
                "ok": False,
                "error": str(e),
            })

    matched_count = len(matched_actors)
    returned_count = len(actors_for_walk)
    unresolved_reason = (
        "get_actor_location() could not be resolved on any of the "
        "{0} matched actor(s).".format(returned_count)
    )
    partial_reason = (
        "Location resolved on {0} of {1} matched actor(s); see "
        "unresolved_on and per-actor 'ok' flags for which failed.".format(
            returned_count - len(unresolved_on), returned_count
        )
    )
    result = _resolved_status_result(
        None, matched_count, unresolved_on, results,
        unresolved_reason, partial_reason, cap_extra=cap_extra,
    )
    result["actors"] = [_project_fields(e, fields) for e in result["actors"]]
    return result


# ---------------------------------------------------------------------------
# Tkinter UI
# ---------------------------------------------------------------------------

def show_batch_ui():
    """Create and display the batch operations UI window."""
    if not _HAS_TKINTER:
        unreal.log_error("batch_tools: tkinter is not available.")
        return

    # Join an existing Tk interpreter if one is already live, else create one.
    # An unconditional tk.Tk() here would leave tk._default_root pinned to
    # a different root, breaking unmastered Tk variables — see device_audit.py.
    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's Batch Operations")
    root.geometry("700x560")
    root.configure(bg=_BG)
    root.resizable(True, True)

    # ==================================================================
    # Style configuration
    # ==================================================================
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(
        "Treeview",
        background=_SECTION_BG,
        foreground=_TEXT_FG,
        fieldbackground=_SECTION_BG,
        font=("Segoe UI", 9),
        rowheight=22,
    )
    style.configure(
        "Treeview.Heading",
        background=_BG,
        foreground=_HEADER_FG,
        font=("Segoe UI", 9, "bold"),
    )
    style.map("Treeview", background=[("selected", _ACCENT_BLUE)], foreground=[("selected", "#FFFFFF")])

    # Combobox styling for dark theme
    style.configure(
        "Dark.TCombobox",
        fieldbackground=_ENTRY_BG,
        background=_ENTRY_BG,
        foreground=_ENTRY_FG,
        selectbackground="#F6D9C9",
        selectforeground="#1A1A1A",
        arrowcolor=_ACCENT_BLUE,
    )
    style.map(
        "Dark.TCombobox",
        fieldbackground=[("readonly", _ENTRY_BG)],
        foreground=[("readonly", _ENTRY_FG)],
        selectbackground=[("readonly", "#F6D9C9")],
        selectforeground=[("readonly", "#1A1A1A")],
    )
    root.option_add("*TCombobox*Listbox.background", _ENTRY_BG)
    root.option_add("*TCombobox*Listbox.foreground", _ENTRY_FG)
    root.option_add("*TCombobox*Listbox.selectBackground", "#F6D9C9")
    root.option_add("*TCombobox*Listbox.selectForeground", "#1A1A1A")

    # ==================================================================
    # Filter section
    # ==================================================================
    filter_frame = tk.Frame(root, bg=_SECTION_BG, padx=12, pady=10)
    filter_frame.pack(fill=tk.X, padx=10, pady=(10, 4))

    tk.Label(
        filter_frame,
        text="Filter",
        font=("Segoe UI", 11, "bold"),
        fg=_HEADER_FG,
        bg=_SECTION_BG,
    ).grid(row=0, column=0, columnspan=5, sticky=tk.W, pady=(0, 6))

    tk.Label(
        filter_frame,
        text="Type:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=1, column=0, sticky=tk.W, padx=(0, 6))

    filter_type_var = tk.StringVar(value="all_devices")
    filter_type_combo = ttk.Combobox(
        filter_frame,
        textvariable=filter_type_var,
        values=["all_devices", "class", "label"],
        state="readonly",
        width=14,
        style="Dark.TCombobox",
        font=("Segoe UI", 9),
    )
    filter_type_combo.grid(row=1, column=1, padx=(0, 10))

    tk.Label(
        filter_frame,
        text="Value:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=1, column=2, sticky=tk.W, padx=(0, 6))

    filter_value_var = tk.StringVar(master=root)
    filter_value_entry = tk.Entry(
        filter_frame,
        textvariable=filter_value_var,
        width=24,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief=tk.FLAT,
        font=("Segoe UI", 9),
    )
    filter_value_entry.grid(row=1, column=3, padx=(0, 10))

    tk.Label(
        filter_frame,
        text="Property:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=2, column=0, sticky=tk.W, padx=(0, 6), pady=(6, 0))

    property_name_var = tk.StringVar(master=root)
    property_entry = tk.Entry(
        filter_frame,
        textvariable=property_name_var,
        width=24,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief=tk.FLAT,
        font=("Segoe UI", 9),
    )
    property_entry.grid(row=2, column=1, columnspan=2, sticky=tk.W, pady=(6, 0))

    preview_btn = tk.Button(
        filter_frame,
        text="Preview",
        font=("Segoe UI", 9, "bold"),
        bg=_ACCENT_BLUE,
        fg="#1A1A1A",
        activebackground="#D24E1F",
        activeforeground="#1A1A1A",
        relief=tk.FLAT,
        padx=14,
        pady=2,
        cursor="hand2",
    )
    preview_btn.grid(row=1, column=4, padx=(4, 0))

    # ==================================================================
    # Preview table
    # ==================================================================
    preview_frame = tk.Frame(root, bg=_SECTION_BG)
    preview_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=4)

    tk.Label(
        preview_frame,
        text="Matched Actors",
        font=("Segoe UI", 10, "bold"),
        fg=_HEADER_FG,
        bg=_SECTION_BG,
        anchor=tk.W,
        padx=6,
        pady=4,
    ).pack(fill=tk.X)

    preview_columns = ("Label", "Class", "Value")
    preview_tree = ttk.Treeview(
        preview_frame,
        columns=preview_columns,
        show="headings",
        height=10,
    )

    preview_tree.heading("Label", text="Label", anchor=tk.W)
    preview_tree.heading("Class", text="Class", anchor=tk.W)
    preview_tree.heading("Value", text="Current Value", anchor=tk.W)

    preview_tree.column("Label", width=220)
    preview_tree.column("Class", width=240)
    preview_tree.column("Value", width=200)

    preview_scroll = ttk.Scrollbar(
        preview_frame, orient=tk.VERTICAL, command=preview_tree.yview
    )
    preview_tree.configure(yscrollcommand=preview_scroll.set)

    preview_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    preview_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    # ==================================================================
    # Action section
    # ==================================================================
    action_frame = tk.Frame(root, bg=_SECTION_BG, padx=12, pady=10)
    action_frame.pack(fill=tk.X, padx=10, pady=4)

    tk.Label(
        action_frame,
        text="Set Value:",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
    ).grid(row=0, column=0, sticky=tk.W, padx=(0, 6))

    set_value_var = tk.StringVar(master=root)
    set_value_entry = tk.Entry(
        action_frame,
        textvariable=set_value_var,
        width=24,
        bg=_ENTRY_BG,
        fg=_ENTRY_FG,
        insertbackground=_ENTRY_FG,
        relief=tk.FLAT,
        font=("Segoe UI", 9),
    )
    set_value_entry.grid(row=0, column=1, padx=(0, 10))

    _dry_run_state = [True]  # plain Python mutable — avoids tk.BooleanVar desync in UEFN
    dry_run_check = tk.Checkbutton(
        action_frame,
        text="Dry Run",
        font=("Segoe UI", 9),
        fg=_TEXT_FG,
        bg=_SECTION_BG,
        selectcolor=_ENTRY_BG,
        activebackground=_SECTION_BG,
        activeforeground=_TEXT_FG,
    )
    dry_run_check.select()  # start checked since default is True
    dry_run_check.grid(row=0, column=2, padx=(0, 10))

    def _on_dry_run_toggle():
        _dry_run_state[0] = not _dry_run_state[0]
    dry_run_check.config(command=_on_dry_run_toggle)

    apply_btn = tk.Button(
        action_frame,
        text="Apply",
        font=("Segoe UI", 9, "bold"),
        bg=_ACCENT_GREEN,
        fg="#1A1A1A",
        activebackground="#256E30",
        activeforeground="#1A1A1A",
        relief=tk.FLAT,
        padx=14,
        pady=2,
        cursor="hand2",
    )
    apply_btn.grid(row=0, column=3, padx=(4, 0))

    # ==================================================================
    # Results area
    # ==================================================================
    results_frame = tk.Frame(root, bg=_BG, padx=12, pady=6)
    results_frame.pack(fill=tk.X, padx=10, pady=(0, 10))

    results_label = tk.Label(
        results_frame,
        text="",
        font=("Segoe UI", 9),
        fg=_ACCENT_GREEN,
        bg=_BG,
        anchor=tk.W,
    )
    results_label.pack(fill=tk.X)

    # Footer with social link
    footer_frame = tk.Frame(root, bg=_BG)
    footer_frame.pack(fill=tk.X, side=tk.BOTTOM, padx=10, pady=(0, 6))
    count_label_var = tk.StringVar(value="")
    count_label = tk.Label(
        footer_frame,
        textvariable=count_label_var,
        font=("Segoe UI", 8),
        fg=_TEXT_FG,
        bg=_BG,
    )
    count_label.pack(side=tk.LEFT)
    social_label = tk.Label(
        footer_frame,
        text="by @thetrashbyrd",
        font=("Segoe UI", 8),
        fg=_ACCENT_BLUE,
        bg=_BG,
        cursor="hand2",
    )
    social_label.pack(side=tk.RIGHT)
    social_label.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # ==================================================================
    # Button handlers
    # ==================================================================
    def _do_preview():
        """Run preview: show matched actors and their current property values."""
        preview_tree.delete(*preview_tree.get_children())
        results_label.config(text="")

        ft = filter_type_combo.get()
        fv = filter_value_entry.get().strip()
        prop = property_entry.get().strip()

        unreal.log(f"batch_tools: Preview — filter_type={ft!r}, filter_value={fv!r}, property={prop!r}")

        if ft in ("class", "label") and not fv:
            results_label.config(text="Enter a filter value.", fg="#C0392B")
            return

        try:
            matched = _match_actors(ft, fv)
        except Exception as e:
            results_label.config(text="Error: " + str(e), fg="#C0392B")
            return

        for actor, label, class_name in matched:
            value_str = ""
            if prop:
                try:
                    val = actor.get_editor_property(prop)
                    value_str = str(val)
                except Exception as e:
                    value_str = "<error: " + str(e) + ">"

            preview_tree.insert("", tk.END, values=(label, class_name, value_str))

        results_label.config(
            text="Matched {count} actor(s).".format(count=len(matched)),
            fg=_ACCENT_BLUE,
        )
        count_label_var.set(f"{len(matched)} matched")

    def _do_apply():
        """Run batch set operation."""
        ft = filter_type_combo.get()
        fv = filter_value_entry.get().strip()
        prop = property_entry.get().strip()
        val = set_value_entry.get()
        dry = _dry_run_state[0]

        unreal.log(f"batch_tools: Apply — filter_type={ft!r}, filter_value={fv!r}, property={prop!r}, value={val!r}, dry_run={dry}")

        if not prop:
            results_label.config(text="Enter a property name.", fg="#C0392B")
            return

        if ft in ("class", "label") and not fv:
            results_label.config(text="Enter a filter value.", fg="#C0392B")
            return

        try:
            result = batch_set_property(ft, fv, prop, val, dry_run=dry)
        except Exception as e:
            results_label.config(text="Error: " + str(e), fg="#C0392B")
            return

        # Update the preview table with results
        preview_tree.delete(*preview_tree.get_children())
        for entry in result["actors"]:
            display_val = entry["old_value"] + " -> " + entry["new_value"]
            preview_tree.insert(
                "", tk.END,
                values=(entry["label"], entry["class"], display_val),
            )

        if dry:
            msg = "Dry run: {matched} matched, would modify {matched} actor(s).".format(
                matched=result["matched"],
            )
            results_label.config(text=msg, fg=_ACCENT_BLUE)
        else:
            msg = "Modified {modified} of {matched} actor(s).".format(
                modified=result["modified"],
                matched=result["matched"],
            )
            results_label.config(text=msg, fg=_ACCENT_GREEN)
        count_label_var.set(f"{result['matched']} matched | {result['modified']} modified")

    preview_btn.config(command=_do_preview)
    apply_btn.config(command=_do_apply)

    # ==================================================================
    # Tick callback -- pump tkinter from the Unreal event loop
    # ==================================================================
    _tick_handle = [None]

    def _tick_pump(delta_time):
        try:
            root.update()
        except tk.TclError:
            # Window was closed -- unregister the tick callback
            if _tick_handle[0] is not None:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None

    _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick_pump)

    # Clean close via the X button
    def _on_close():
        if _tick_handle[0] is not None:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    unreal.log("batch_tools: Batch Operations window opened.")
