"""
UEFN Moderation Pre-Flight Scanner — COLLECTOR
===============================================
Deterministic data-gathering half of an IP / content-policy pre-flight
scanner that mirrors the surfaces Fortnite's island moderation actually
inspects: island name, description, loading-screen/lobby/promo text,
thumbnail image, and the asset/device content itself (asset names and
``.uasset``/package paths are searched literally, so even licensed use of a
recognizable name can trip an automated flag).

THIS MODULE DOES NOT JUDGE ANYTHING. It only collects structured evidence.
A connected LLM (wired up in a later phase, see ``run_moderation_scan``'s
docstring below) is the part that reasons about whether a given asset name,
Verse string, or embedded metadata field is actually a problem — this file
never raises a verdict, only facts. A cheap literal-match "first pass hint"
step also runs on this evidence to help the LLM prioritize what to look at
first, but it deliberately lives OUTSIDE this file (see "No brand/product
wordlists here" below) and is not part of what this module returns.

BONUS beyond what Epic documents: embedded image metadata (PNG text
chunks, JPEG EXIF/IPTC) is not a known Fortnite moderation input as far as
this project is aware, but authorship/copyright strings sometimes leak
into shipped textures (e.g. a thumbnail exported from a tool that stamped
"Copyright <BrandName>" into the PNG), so it's collected here as a bonus
signal.

Design constraints (hard project rules — see CLAUDE.md):
  * STDLIB-ONLY plus ``unreal``. No new third-party dependencies. Pixel /
    perceptual image analysis (PIL, numpy, etc.) is intentionally NOT done;
    ``collect_image_metadata`` only reads embedded TEXT metadata via
    ``struct``/``zlib`` (both stdlib).
  * Must import and run standalone (outside UEFN) for testing — every
    ``unreal`` access is guarded, exactly like ``asset_usage.py`` and
    ``health_scanner.py``.
  * Every collector is wrapped so it NEVER raises out to the caller; on
    failure it returns its "empty"/"unavailable" shape plus a note.

Scan-root resolution
---------------------
REUSES ``health_scanner.py``'s validated, self-healing scan-root chain
rather than inventing a new one (see that module's docstring for the full
"UEFN copies Content/Python into the embedded engine and executes scripts
from there" story — plain ``__file__`` walkup alone is not reliable).
``moderation_scanner.py`` lives in the same ``Content/Python`` directory as
``health_scanner.py``, so calling its ``_get_project_root()`` /
``_resolve_scan_root()`` functions from here resolves identically to
calling them from ``health_scanner.py`` itself — the walkup and validation
gate are anchored on ``health_scanner.py``'s own ``__file__``, not this
module's.

Entry point: ``run_moderation_scan(project_dir=None)`` — see its docstring.
"""

import glob
import hashlib
import json
import os
import re
import struct
import unicodedata
import webbrowser
import zlib

try:
    import unreal
    _HAS_UNREAL = True
except ImportError:
    _HAS_UNREAL = False

try:
    import tkinter as tk
    from tkinter import scrolledtext
    _HAS_TKINTER = True
except ImportError:
    _HAS_TKINTER = False


# ---------------------------------------------------------------------------
# Theme constants (matching launcher / other Power Tools windows)
# ---------------------------------------------------------------------------

_BG = "#D2CEC4"
_SECTION_BG = "#EBE7DD"
_HEADER_FG = "#1A1A1A"
_ACCENT_BLUE = "#F15B29"
_TEXT_FG = "#2B2B2B"
_TEXT_DIM = "#57524C"

# Reuse (do not reinvent) health_scanner's validated scan-root resolution.
# Guarded: health_scanner.py itself guards `import unreal`/`import tkinter`,
# so this import succeeds standalone too. If health_scanner.py is ever
# unavailable/renamed, degrade to None rather than failing module import.
try:
    from health_scanner import _get_project_root, _resolve_scan_root
except Exception:
    _get_project_root = None
    _resolve_scan_root = None


# ---------------------------------------------------------------------------
# Constants — data the (future) LLM judgment pass consumes
# ---------------------------------------------------------------------------

# No franchise/brand/Epic-product wordlists live in this file, BY DESIGN.
# This module is staged into the user's project (Content/Python) and IS
# checked into Unreal Revision Control (the project's ignore rules cover
# *.json/*.md/*.jsonl/*.cjs/*.mjs but NOT *.py) — a Python file full of
# literal franchise names shipped into a Fortnite project would itself be
# an IP-moderation flag risk, tripping the very system it's meant to
# predict. The cheap first-pass literal wordlist matching (an
# authenticity/reward-bait list and a non-exhaustive third-party
# brand/franchise seed list) instead lives server-side in the MCP server
# (`uefn-bridge/uefn-server.ts`, in the `uefn_moderation_scan` tool
# handler), which is part of the extension and is never staged into a
# project. That server computes `first_pass_hints` over the raw surfaces
# this module collects below. Real IP/authenticity judgment (fair use,
# licensed collab, coincidental name, transformative parody, context) is
# still the connected LLM's job either way — the wordlists are only a
# cheap prioritization hint, never a verdict.

# Package-path prefixes considered "official" (engine/Fortnite-owned), used
# only to decide what is NOT flagged as possibly imported/migrated.
_OFFICIAL_PREFIXES = ("/Engine/", "/Script/", "/Fortnite", "/FortniteGame")

# CRITICAL REVIEW FIX: earlier versions of this file unconditionally
# excluded "/Game/" here on the assumption it is always the shipped base
# Fortnite game (observed on one real project: ~214,000 assets under
# "/Game/", e.g. "/Game/Balance/GameplayTags", none of which were the
# user's own island content). That assumption is FALSE in general — five
# sibling Power Tools treat "/Game/" as the PROJECT'S OWN last-resort
# content mount (asset_usage.py:65-86 get_project_prefix(),
# dependency_viewer.py:127-163 _get_project_prefix(), plus asset_sweep.py,
# texture_finder.py, niagara_inspector.py), and standard Unreal convention
# is that "/Game/" is a project's primary content mount. Both layouts are
# real, so "/Game/" can NEVER be unconditionally excluded here. Only
# /Engine/, /Script/, /Fortnite*, and /Temp/ (UEFN's transient/scratch
# mount) are unconditionally engine/non-project content — see
# _resolve_project_mount() and collect_asset_surfaces() below for how
# "/Game/" is instead PARTITIONED (never silently dropped) into
# project_assets (when "/Game/" IS the resolved project mount) or
# shared_game_mount_assets (kept and reported, otherwise).
_ENGINE_EXCLUDE_PREFIXES = _OFFICIAL_PREFIXES + ("/Temp/",)

_VERSE_SKIP_DIRS = {"Saved", "Intermediate", "__pycache__", ".uefn_bridge"}
_IMAGE_EXTS = (".png", ".jpg", ".jpeg")
_AUDIO_EXTS = (".wav", ".ogg", ".mp3", ".flac", ".aiff", ".wma")
_ASSET_HASH_EXTS = (".uasset", ".umap", ".png", ".jpg", ".jpeg")

# ---------------------------------------------------------------------------
# Collection caps — every filesystem walker below runs SYNCHRONOUSLY on the
# editor's main thread (show_moderation_scan) or inside uefn_bridge.py's
# _tick() (MCP path, which the client times out on at 30s). An unbounded
# walk/hash over a large project can freeze the UEFN UI and stall the
# bridge heartbeat. These caps bound worst-case work; whenever one is hit
# the affected collector reports it via `truncated`/`notes` rather than
# silently returning a partial result that looks complete.
# ---------------------------------------------------------------------------

# Max number of individual files (of the collector's matching extension(s))
# a single walker will visit/process before stopping early.
MAX_FILES_WALKED = 4000

# Max number of files hash_assets() will actually hash (tighter than
# MAX_FILES_WALKED — hashing is the most expensive per-file operation here).
MAX_FILES_HASHED = 750

# Files larger than this are skipped by hash_assets() (not hashed at all)
# rather than hashed in full — avoids a single huge package file stalling
# the whole synchronous pass.
MAX_FILE_BYTES_HASHED = 25 * 1024 * 1024  # 25 MB

# Max number of individual entries collect_asset_surfaces() returns in its
# `shared_game_mount_assets` list (the shared/base content mount partition,
# which can be huge — e.g. ~214,000 shipped-game assets under "/Game/" on
# one real project). This caps only the DETAIL list returned to the
# caller — `shared_game_mount_asset_count` and HLOD/external-actor
# detection over this bucket are always computed over the FULL, uncapped
# set (see collect_asset_surfaces()'s docstring), so nothing is missed by
# this cap; only how many raw entries get echoed back is limited.
MAX_SHARED_MOUNT_ASSETS_RETURNED = 500


# ---------------------------------------------------------------------------
# Scan-root helpers
# ---------------------------------------------------------------------------

def _resolve_project_dir():
    """Resolve the live project root, reusing health_scanner's VALIDATED
    scan-root chain. Returns (project_dir, verified, source) — never
    raises.

    ``health_scanner._resolve_scan_root()`` returns a validated
    ``(content_dir, verified, source_label)`` tuple where ``content_dir``
    is the project's ``Content`` directory (see that function's docstring:
    every candidate it tries — ``.uefnproject`` walkup, asset-anchored
    unreal API, default-location guess, legacy ``unreal.Paths`` — resolves
    to a ``Content`` dir, except its own unverified legacy fallback, which
    resolves to the project root directly). This derives ``project_dir``
    as that ``content_dir``'s parent (stripping a trailing ``Content``
    path segment) so the caller gets the project root — matching what the
    four filesystem collectors below expect — while ``verified``/``source``
    still describe the SAME path that's actually being scanned.

    Previously this discarded the validated ``content_dir`` and returned
    the plain, unvalidated ``_get_project_root()`` walkup path instead,
    while still attaching the validated ``verified``/``source`` to that
    different, unverified path. Per health_scanner's own docstring, plain
    ``__file__`` walkup is exactly the unreliable method when the bridge
    runs engine-side (resolves into the Fortnite engine install, not the
    user's project) — so ``verified=True`` could be reported for a scan
    root that was actually wrong, silently emptying every filesystem
    collector while looking like a clean scan.

    Falls back to the naive ``_get_project_root()`` walkup — explicitly
    marked ``verified=False`` — if ``_resolve_scan_root`` is unavailable
    or none of its candidates validate. Falls back further to ``cwd``
    (also ``verified=False``) if ``health_scanner`` itself is
    unavailable."""
    if _resolve_scan_root is not None:
        try:
            content_dir, verified, source = _resolve_scan_root()
        except Exception:
            content_dir, verified, source = None, False, None
        if content_dir:
            normalized = os.path.normpath(content_dir)
            if os.path.basename(normalized) == "Content":
                project_dir = os.path.dirname(normalized)
            else:
                # health_scanner's own unverified legacy fallback resolves
                # straight to the project root (no trailing "Content"
                # segment to strip) — use it as-is.
                project_dir = normalized
            if verified:
                return project_dir, True, source
            return project_dir, False, f"unverified fallback ({source})"

    if _get_project_root is not None:
        try:
            project_dir = _get_project_root()
            return (
                project_dir,
                False,
                "health_scanner._get_project_root (naive walkup, unvalidated — "
                "health_scanner._resolve_scan_root unavailable)",
            )
        except Exception:
            pass
    return os.getcwd(), False, "cwd fallback (health_scanner unavailable)"


# ---------------------------------------------------------------------------
# 1. Asset surfaces (Asset Registry) — THE most important collector: real
#    moderation flags match on these strings even for licensed/legit assets.
# ---------------------------------------------------------------------------

def _resolve_project_mount_prefix(scan_root):
    """SECONDARY, corroborating-only signal for the user's OWN island
    content mount, e.g. "/MyIsland/", derived from the resolved scan
    root's own directory name — never a hardcoded project/franchise name.
    UEFN mounts an island's authored/imported content under
    "/<ProjectName>/", where ``<ProjectName>`` matches the project folder
    on disk (the folder that holds the ``.uefnproject`` file, i.e. exactly
    what ``_resolve_project_dir`` / ``scan_root`` resolves to). Returns
    None if it can't be determined.

    NOT the primary resolution method — see ``_resolve_project_mount()``,
    which prefers the LIVE level-actor/world path (matching
    ``asset_usage.py``'s ``get_project_prefix()`` and
    ``dependency_viewer.py``'s ``_get_project_prefix()``) and only falls
    back to this folder-name heuristic. Callers that need the authoritative
    resolution should call ``_resolve_project_mount()``, not this function
    directly."""
    if not scan_root:
        return None
    try:
        name = os.path.basename(os.path.normpath(scan_root))
    except Exception:
        return None
    if not name:
        return None
    return "/" + name + "/"


def _resolve_project_mount(scan_root):
    """Resolve the user's own project content mount prefix (e.g.
    "/MyIsland/"), used to distinguish the creator's own authored/imported
    content from the shared "/Game/" mount (which may hold shipped
    Fortnite game content, OR may itself BE the project's own mount,
    depending on project layout — see the CRITICAL REVIEW FIX note on
    ``_ENGINE_EXCLUDE_PREFIXES`` above).

    Mirrors the PRIMARY method used by the sibling Power Tools —
    ``asset_usage.py``'s ``get_project_prefix()`` (asset_usage.py:65-86)
    and ``dependency_viewer.py``'s ``_get_project_prefix()``
    (dependency_viewer.py:127-163) — both of which derive the mount from a
    LIVE level actor's path via
    ``unreal.EditorActorSubsystem.get_all_level_actors()``: an island's own
    placed devices/actors live under its own mount, which is the
    authoritative live signal, not a filesystem guess. Strategy order,
    matching those two implementations:

      1. First level actor's ``get_path_name()`` leading mount segment.
      2. The current world's own ``get_path_name()`` leading mount segment
         (used when no actors are placed yet).
      3. SECONDARY, corroborating-only fallback: the on-disk scan_root
         folder name (``_resolve_project_mount_prefix`` above) — used only
         when ``unreal`` isn't importable (standalone/offline run) or
         strategies 1/2 both failed to yield anything. This is never
         treated as an authoritative resolution.

    Returns (mount_prefix, source, confirmed):
      * ``mount_prefix``: "/Name/" string, or None if nothing resolved.
      * ``source``: "level_actor_path" | "world_path" |
        "scan_root_folder_name" | None.
      * ``confirmed``: True only for the two live-editor strategies (1/2)
        — False for the folder-name guess or when unresolved entirely, so
        callers can tell a live-confirmed mount apart from a best-effort
        guess and report that distinction (``project_mount_source`` /
        ``project_mount_confirmed`` in ``collect_asset_surfaces()``'s
        output).

    NEVER hardcodes a project/franchise name. NEVER raises."""
    if _HAS_UNREAL:
        try:
            subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
            actors = subsystem.get_all_level_actors()
            if actors:
                parts = actors[0].get_path_name().split("/")
                if len(parts) >= 2 and parts[1]:
                    return "/" + parts[1] + "/", "level_actor_path", True
        except Exception:
            pass
        try:
            subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
            world = subsystem.get_world()
            if world:
                parts = world.get_path_name().split("/")
                if len(parts) >= 2 and parts[1]:
                    return "/" + parts[1] + "/", "world_path", True
        except Exception:
            pass

    folder_prefix = _resolve_project_mount_prefix(scan_root)
    if folder_prefix:
        return folder_prefix, "scan_root_folder_name", False

    return None, None, False


def collect_asset_surfaces(scan_root=None):
    """Enumerate the FULL Asset Registry and PARTITION it into labelled
    buckets — never silently drop a bucket. Returns:

        {"available": bool,
         "project_assets": [...],                    # under resolved mount
         "shared_game_mount_assets": [...],           # capped detail list
         "shared_game_mount_assets_omitted_count": int,
         "hlod_or_imported": [...],                   # union, both buckets
         "external_actor_or_object": [...],           # union, both buckets
         "total_registry_assets": int,
         "project_asset_count": int,
         "shared_game_mount_asset_count": int,        # uncapped true count
         "excluded_engine_assets": int,
         "project_mount": str|None,
         "project_mount_source": str|None,
         "project_mount_confirmed": bool,
         "notes": [...], "error": str?}

    Never raises; returns available=False if `unreal` isn't importable or
    the registry can't be reached.

    CRITICAL REVIEW FIX — partitioning, not exclusion:
      * The project's own content mount is resolved via
        ``_resolve_project_mount()`` (PRIMARY: live level-actor/world path,
        matching ``asset_usage.py``/``dependency_viewer.py``; SECONDARY:
        on-disk folder-name guess) — never a hardcoded name, and never
        assumed to be "/Game/" or "not /Game/" either way.
      * Every asset under ``_ENGINE_EXCLUDE_PREFIXES`` (/Engine/, /Script/,
        /Fortnite*, /Temp/ — NOT "/Game/", see that constant's docstring)
        is engine/shipped-runtime content and is summarized by count only
        (``excluded_engine_assets``).
      * Every remaining asset is partitioned by whether its package path
        starts with the resolved project mount:
          - under the mount -> ``project_assets`` (uncapped: the Asset
            Registry enumerates in-memory, not via a filesystem walk, so
            this is never subject to MAX_FILES_WALKED).
          - NOT under the mount -> ``shared_game_mount_assets`` (this is
            "/Game/" when "/Game/" isn't the resolved mount, but also
            covers any other non-project, non-engine mount, and covers
            EVERYTHING non-engine when the mount couldn't be resolved at
            all). Kept and returned (capped at
            ``MAX_SHARED_MOUNT_ASSETS_RETURNED`` entries, with an honest
            omitted count) — never discarded outright.
      * If the resolved mount IS "/Game/", "/Game/" assets land in
        ``project_assets`` with no special-casing needed: the partition
        check is just "does package_path start with mount_prefix".
      * HLOD (package path contains "HLOD") and generated External
        Actor/Object detection (``__ExternalActors__``/
        ``__ExternalObjects__``) run over EVERY non-engine asset in BOTH
        buckets before either bucket is capped, so a flagged asset can
        never be missed because of which bucket it landed in.
      * If the mount can't be resolved at all, a prominent note is added
        and ``project_mount_confirmed`` is False — callers must not read
        an empty/small ``project_assets`` as "checked, nothing found" in
        that case, since everything non-engine went to
        ``shared_game_mount_assets`` instead.
    """
    result = {
        "available": _HAS_UNREAL,
        "project_assets": [],
        "shared_game_mount_assets": [],
        "shared_game_mount_assets_omitted_count": 0,
        "hlod_or_imported": [],
        "external_actor_or_object": [],
        "total_registry_assets": 0,
        "project_asset_count": 0,
        "shared_game_mount_asset_count": 0,
        "excluded_engine_assets": 0,
        "project_mount": None,
        "project_mount_source": None,
        "project_mount_confirmed": False,
        "notes": [],
    }
    if not _HAS_UNREAL:
        return result

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    except Exception as e:
        result["available"] = False
        result["error"] = f"asset registry unavailable: {e}"
        return result

    mount_prefix, mount_source, mount_confirmed = _resolve_project_mount(scan_root)
    result["project_mount"] = mount_prefix
    result["project_mount_source"] = mount_source
    result["project_mount_confirmed"] = mount_confirmed
    if not mount_prefix:
        result["notes"].append(
            "PROJECT SCOPE UNCONFIRMED: the project's own content mount "
            "could not be resolved (no live level actors/world, and no "
            "on-disk folder-name fallback either) — every non-engine asset "
            "has been placed in shared_game_mount_assets rather than "
            "project_assets. Do not read an empty/small project_assets as "
            "\"checked, nothing found\" — it means scope could not be "
            "confirmed, not that nothing was found."
        )
    elif not mount_confirmed:
        result["notes"].append(
            f"project mount {mount_prefix!r} resolved only via the on-disk "
            "folder-name heuristic (scan_root_folder_name) — no live level "
            "actors or world were available to confirm it (offline/"
            "standalone run, or an empty level). Treat this mount as a "
            "corroborating guess, not a confirmed fact."
        )

    try:
        all_assets = registry.get_all_assets()
    except Exception as e:
        result["available"] = False
        result["error"] = f"asset registry unavailable: {e}"
        return result

    result["total_registry_assets"] = len(all_assets)
    excluded = 0
    project_count = 0
    shared_count = 0

    for a in all_assets:
        try:
            package_path = str(getattr(a, "package_path", ""))
            package_name = str(getattr(a, "package_name", ""))
            display_name = str(getattr(a, "asset_name", ""))

            if package_path.startswith(_ENGINE_EXCLUDE_PREFIXES):
                excluded += 1
                continue

            asset_class = ""
            try:
                cls_path = getattr(a, "asset_class_path", None)
                if cls_path is not None and hasattr(cls_path, "asset_name"):
                    asset_class = str(cls_path.asset_name)
                else:
                    asset_class = str(getattr(a, "asset_class", ""))
            except Exception:
                asset_class = str(getattr(a, "asset_class", ""))

            object_path = str(
                getattr(a, "object_path", "") or (package_name + "." + display_name)
            )

            entry = {
                "display_name": display_name,
                "object_path": object_path,
                "package_path": package_path,
                "package_name": package_name,
                "asset_class": asset_class,
            }

            # Partition — "/Game/" (or any other non-engine mount) is NEVER
            # dropped, only routed to shared_game_mount_assets when it
            # isn't the resolved project mount (or the mount is unknown).
            is_project_owned = bool(mount_prefix) and package_path.startswith(mount_prefix)
            if is_project_owned:
                result["project_assets"].append(entry)
                project_count += 1
            else:
                shared_count += 1
                if len(result["shared_game_mount_assets"]) < MAX_SHARED_MOUNT_ASSETS_RETURNED:
                    result["shared_game_mount_assets"].append(entry)

            # HLOD / External Actor-Object detection runs over EVERY
            # non-engine asset in BOTH buckets, before either bucket's
            # detail list is capped — a hit is never missed to a cap.
            haystack = (package_path + " " + package_name).upper()
            is_hlod = "HLOD" in haystack
            is_external_actor_or_object = (
                "__EXTERNALACTORS__" in haystack or "__EXTERNALOBJECTS__" in haystack
            )

            if is_hlod or is_project_owned:
                result["hlod_or_imported"].append(entry)
            if is_external_actor_or_object:
                result["external_actor_or_object"].append(entry)
        except Exception:
            continue

    result["excluded_engine_assets"] = excluded
    result["project_asset_count"] = project_count
    result["shared_game_mount_asset_count"] = shared_count
    result["shared_game_mount_assets_omitted_count"] = max(
        0, shared_count - len(result["shared_game_mount_assets"])
    )

    if shared_count:
        result["notes"].append(
            f"{shared_count} asset(s) found on the shared/base content mount "
            f"(commonly \"/Game/\", but any non-project, non-engine mount "
            "counts here) — kept, NOT discarded (see "
            "shared_game_mount_assets). Whether these are shipped/base game "
            "content or the creator's own content depends on project "
            "layout, so this bucket must be reviewed, not ignored."
        )
    if result["shared_game_mount_assets_omitted_count"]:
        result["notes"].append(
            f"shared_game_mount_assets detail list capped at "
            f"{MAX_SHARED_MOUNT_ASSETS_RETURNED} entries — "
            f"{result['shared_game_mount_assets_omitted_count']} more counted "
            "but omitted from the list (see shared_game_mount_asset_count "
            "for the true total; HLOD/external-actor detection above still "
            "covers all of them, uncapped)."
        )

    return result


# ---------------------------------------------------------------------------
# 2. Verse source surfaces — string literals, comments, likely labels
# ---------------------------------------------------------------------------

_BLOCK_COMMENT_RE = re.compile(r"<#.*?#>", re.DOTALL)
_STRING_LITERAL_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')
_LABEL_ASSIGN_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?)\s*$")


def collect_verse_surfaces(project_dir):
    """Walk every *.verse file under project_dir and extract string
    literals, comments (# line, <# block #>), and likely device/actor
    label bindings (`Name := ...`). Returns (surfaces, truncated):
    ``surfaces`` is a list of {file, line, text, kind} dicts, kind in
    ("string_literal", "comment_line", "comment_block", "label_assignment");
    ``truncated`` is True iff MAX_FILES_WALKED was hit and the walk
    stopped early — callers MUST treat a truncated result as partial, not
    complete. Best-effort per file — a single unreadable/unparsable file
    is skipped, never aborts the whole walk."""
    surfaces = []
    truncated = False
    if not project_dir or not os.path.isdir(project_dir):
        return surfaces, truncated

    files_seen = 0
    for dirpath, dirnames, filenames in os.walk(project_dir):
        dirnames[:] = [d for d in dirnames if d not in _VERSE_SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if not fn.endswith(".verse"):
                continue
            if files_seen >= MAX_FILES_WALKED:
                truncated = True
                return surfaces, truncated
            files_seen += 1
            full_path = os.path.join(dirpath, fn)
            try:
                with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except Exception:
                continue

            try:
                # Block comments first (may span multiple lines); mask them
                # out of `text` with spaces (preserving newlines/offsets) so
                # they aren't re-picked-up as strings/line-comments below.
                masked = list(text)
                for m in _BLOCK_COMMENT_RE.finditer(text):
                    start_line = text.count("\n", 0, m.start()) + 1
                    surfaces.append({
                        "file": full_path,
                        "line": start_line,
                        "text": m.group(0)[:500],
                        "kind": "comment_block",
                    })
                    for i in range(m.start(), m.end()):
                        if masked[i] != "\n":
                            masked[i] = " "
                masked_text = "".join(masked)

                for line_no, line in enumerate(masked_text.split("\n"), start=1):
                    if not line.strip():
                        continue

                    # String literals on this line.
                    for sm in _STRING_LITERAL_RE.finditer(line):
                        lit = sm.group(1)
                        if lit:
                            surfaces.append({
                                "file": full_path,
                                "line": line_no,
                                "text": lit[:500],
                                "kind": "string_literal",
                            })

                    # Line comment: find a '#' that isn't inside a string
                    # literal, by scanning the line with strings blanked.
                    stripped = _STRING_LITERAL_RE.sub(lambda mm: '"' + (" " * len(mm.group(1))) + '"', line)
                    hash_idx = stripped.find("#")
                    if hash_idx != -1:
                        comment_text = line[hash_idx:].strip()
                        if comment_text:
                            surfaces.append({
                                "file": full_path,
                                "line": line_no,
                                "text": comment_text[:500],
                                "kind": "comment_line",
                            })
                        code_part = line[:hash_idx]
                    else:
                        code_part = line

                    # Likely label/device binding: `Name := ...`.
                    lm = _LABEL_ASSIGN_RE.match(code_part)
                    if lm:
                        surfaces.append({
                            "file": full_path,
                            "line": line_no,
                            "text": f"{lm.group(1)} := {lm.group(2)}"[:500],
                            "kind": "label_assignment",
                        })
            except Exception:
                continue

    return surfaces, truncated


# ---------------------------------------------------------------------------
# 3. Text metadata — .uefnproject + island metadata/config JSON
# ---------------------------------------------------------------------------

_TEXT_META_KEY_RE = re.compile(r"(name|title|desc|description|tag|label|summary)", re.IGNORECASE)


def _walk_json_text_fields(obj, file_label, key_path, out):
    """Recursively collect string-valued fields whose key looks like a
    display/metadata field (name/title/desc/tag/...). Best-effort; caps
    recursion implicitly via normal JSON depth."""
    try:
        if isinstance(obj, dict):
            for k, v in obj.items():
                new_path = f"{key_path}.{k}" if key_path else str(k)
                if isinstance(v, str) and _TEXT_META_KEY_RE.search(str(k)):
                    if v.strip():
                        out.append({"file": file_label, "key": new_path, "value": v})
                _walk_json_text_fields(v, file_label, new_path, out)
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                _walk_json_text_fields(item, file_label, f"{key_path}[{i}]", out)
    except Exception:
        pass


def collect_text_metadata(project_dir):
    """Read the .uefnproject file and any other top-level/Config island
    metadata JSON, returning the raw text-ish fields found (island name,
    description, title/tag/summary fields, etc.). Returns
    {"files": [...], "fields": [{file, key, value}], "truncated": bool}.
    ``truncated`` is True iff more than MAX_FILES_WALKED candidate files
    were found and the excess was dropped. Never raises — a malformed
    JSON file is skipped, not fatal."""
    result = {"files": [], "fields": [], "truncated": False}
    if not project_dir or not os.path.isdir(project_dir):
        return result

    candidates = []
    try:
        candidates.extend(glob.glob(os.path.join(project_dir, "*.uefnproject")))
        candidates.extend(glob.glob(os.path.join(project_dir, "*.json")))
        candidates.extend(glob.glob(os.path.join(project_dir, "Config", "*.json")))
    except Exception:
        pass

    if len(candidates) > MAX_FILES_WALKED:
        result["truncated"] = True
        candidates = candidates[:MAX_FILES_WALKED]

    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
        except Exception:
            continue
        result["files"].append(path)
        _walk_json_text_fields(data, path, "", result["fields"])

    return result


# ---------------------------------------------------------------------------
# 4. Image metadata — PNG text chunks + JPEG EXIF/IPTC markers (stdlib only)
# ---------------------------------------------------------------------------
#
# Intentionally NOT doing pixel/perceptual analysis (no PIL/numpy — hard
# project rule is stdlib+unreal only). This only reads TEXT that authoring
# tools sometimes embed (Author/Copyright/Title/Description/Software/
# XMP), which occasionally leaks a real brand/copyright string into a
# shipped thumbnail or loading-screen image. Actual pixel-level "is this
# image itself infringing" review is the connected LLM's job (vision, once
# wired in Phase 2) — `image_paths` in the entry point output is the list
# it will need.

def _iter_image_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.lower().endswith(_IMAGE_EXTS):
                yield os.path.join(dirpath, fn)


_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _read_png_text_fields(path):
    fields = {}
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception:
        return fields
    if not data.startswith(_PNG_SIG):
        return fields

    pos = len(_PNG_SIG)
    try:
        while pos + 8 <= len(data):
            length = struct.unpack(">I", data[pos:pos + 4])[0]
            ctype = data[pos + 4:pos + 8].decode("ascii", errors="replace")
            chunk_start = pos + 8
            chunk_end = chunk_start + length
            if chunk_end > len(data):
                break
            chunk_data = data[chunk_start:chunk_end]

            try:
                if ctype == "tEXt":
                    if b"\x00" in chunk_data:
                        kw, txt = chunk_data.split(b"\x00", 1)
                        fields[kw.decode("latin-1", errors="replace")] = txt.decode("latin-1", errors="replace")
                elif ctype == "zTXt":
                    if b"\x00" in chunk_data:
                        kw, rest = chunk_data.split(b"\x00", 1)
                        if rest:
                            comp_txt = rest[1:]  # skip 1-byte compression method
                            try:
                                txt = zlib.decompress(comp_txt).decode("latin-1", errors="replace")
                            except Exception:
                                txt = ""
                            fields[kw.decode("latin-1", errors="replace")] = txt
                elif ctype == "iTXt":
                    parts = chunk_data.split(b"\x00", 4)
                    if len(parts) >= 5:
                        kw, comp_flag, _comp_method, _lang, rest = parts[0], parts[1], parts[2], parts[3], parts[4]
                        # rest may still contain "translated_keyword\x00text"
                        if b"\x00" in rest:
                            _translated, text_part = rest.split(b"\x00", 1)
                        else:
                            text_part = rest
                        if comp_flag == b"\x01":
                            try:
                                text_part = zlib.decompress(text_part)
                            except Exception:
                                text_part = b""
                        fields[kw.decode("utf-8", errors="replace")] = text_part.decode("utf-8", errors="replace")
            except Exception:
                pass

            pos = chunk_end + 4  # skip CRC
            if ctype == "IEND":
                break
    except Exception:
        pass
    return fields


_JPEG_ASCII_RUN_RE = re.compile(rb"[\x20-\x7e]{4,}")

# Common EXIF IFD0 tag IDs that hold ASCII strings.
_EXIF_ASCII_TAGS = {
    0x010E: "ImageDescription",
    0x010F: "Make",
    0x0110: "Model",
    0x0131: "Software",
    0x013B: "Artist",
    0x8298: "Copyright",
}


def _read_exif_ascii_tags(exif_tiff_bytes):
    """Minimal best-effort TIFF/EXIF IFD0 parser for a handful of common
    ASCII tags (Artist/Copyright/Software/etc). Not a general EXIF parser —
    just enough to surface authorship/copyright strings for moderation
    review. Returns {} on anything unexpected."""
    fields = {}
    try:
        if len(exif_tiff_bytes) < 8:
            return fields
        byte_order = exif_tiff_bytes[0:2]
        if byte_order == b"II":
            endian = "<"
        elif byte_order == b"MM":
            endian = ">"
        else:
            return fields
        ifd0_offset = struct.unpack(endian + "I", exif_tiff_bytes[4:8])[0]
        if ifd0_offset + 2 > len(exif_tiff_bytes):
            return fields
        entry_count = struct.unpack(endian + "H", exif_tiff_bytes[ifd0_offset:ifd0_offset + 2])[0]
        entry_base = ifd0_offset + 2
        for i in range(entry_count):
            entry_off = entry_base + i * 12
            if entry_off + 12 > len(exif_tiff_bytes):
                break
            tag, typ, count = struct.unpack(endian + "HHI", exif_tiff_bytes[entry_off:entry_off + 8])
            if tag not in _EXIF_ASCII_TAGS or typ != 2:  # type 2 = ASCII
                continue
            value_field = exif_tiff_bytes[entry_off + 8:entry_off + 12]
            if count <= 4:
                raw = value_field[:count]
            else:
                voff = struct.unpack(endian + "I", value_field)[0]
                raw = exif_tiff_bytes[voff:voff + count]
            text = raw.split(b"\x00", 1)[0].decode("ascii", errors="replace").strip()
            if text:
                fields[_EXIF_ASCII_TAGS[tag]] = text
    except Exception:
        return {}
    return fields


def _read_jpeg_metadata_fields(path):
    fields = {}
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception:
        return fields
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        return fields

    pos = 2
    try:
        while pos + 4 <= len(data):
            if data[pos] != 0xFF:
                pos += 1
                continue
            marker = data[pos + 1]
            if marker in (0xD8, 0xD9):  # SOI/EOI, no length
                pos += 2
                continue
            if 0xD0 <= marker <= 0xD7 or marker == 0x01:
                pos += 2
                continue
            if pos + 4 > len(data):
                break
            seg_len = struct.unpack(">H", data[pos + 2:pos + 4])[0]
            seg_start = pos + 4
            seg_end = pos + 2 + seg_len
            if seg_end > len(data):
                break
            seg_data = data[seg_start:seg_end]

            try:
                if marker == 0xE1:  # APP1 — EXIF or XMP
                    if seg_data.startswith(b"Exif\x00\x00"):
                        exif_tags = _read_exif_ascii_tags(seg_data[6:])
                        fields.update(exif_tags)
                    elif seg_data.startswith(b"http://ns.adobe.com/xap/"):
                        # XMP packet — raw XML; just pull readable text runs.
                        runs = [m.decode("ascii", errors="replace") for m in _JPEG_ASCII_RUN_RE.findall(seg_data)]
                        if runs:
                            fields.setdefault("XMP_text_runs", []).extend(runs[:20])
                elif marker == 0xED:  # APP13 — Photoshop IRB / IPTC-NAA
                    # No full IPTC-NAA record parser (stdlib-only budget) —
                    # best-effort: scrape readable ASCII text runs instead.
                    runs = [m.decode("ascii", errors="replace") for m in _JPEG_ASCII_RUN_RE.findall(seg_data)]
                    if runs:
                        fields.setdefault("IPTC_text_runs", []).extend(runs[:20])
            except Exception:
                pass

            pos = seg_end
            if marker == 0xDA:  # SOS — compressed data follows, stop scanning
                break
    except Exception:
        pass
    return fields


def collect_image_metadata(project_dir):
    """Walk *.png/*.jpg/*.jpeg under project_dir's Content (or project_dir
    itself if no Content dir) and extract embedded text metadata only
    (PNG tEXt/zTXt/iTXt, JPEG EXIF/IPTC) — stdlib-only, no pixel analysis.
    Returns {"images": [{file, fields}], "image_paths": [...],
    "truncated": bool}. ``truncated`` is True iff MAX_FILES_WALKED image
    files were reached and the walk stopped early — the result is then
    partial, not a complete inventory."""
    result = {"images": [], "image_paths": [], "truncated": False}
    if not project_dir or not os.path.isdir(project_dir):
        return result

    root = os.path.join(project_dir, "Content")
    if not os.path.isdir(root):
        root = project_dir

    for path in _iter_image_files(root):
        if len(result["image_paths"]) >= MAX_FILES_WALKED:
            result["truncated"] = True
            break
        result["image_paths"].append(path)
        try:
            if path.lower().endswith(".png"):
                fields = _read_png_text_fields(path)
            else:
                fields = _read_jpeg_metadata_fields(path)
        except Exception:
            fields = {}
        if fields:
            result["images"].append({"file": path, "fields": fields})

    return result


# ---------------------------------------------------------------------------
# 5. Audio surfaces — ownership review candidates
# ---------------------------------------------------------------------------

def collect_audio_surfaces():
    """List audio asset names/paths for ownership review: via the Asset
    Registry if `unreal` is available, else a file walk for common audio
    extensions under the resolved project's Content dir. Returns
    {"available": bool, "source": str, "audio": [...], "truncated": bool}.
    ``truncated`` only applies to the filesystem-walk fallback (the Asset
    Registry path is not capped — the registry enumerates in-memory, not
    via a filesystem walk, so it isn't the freeze risk this caps against).
    Never raises."""
    result = {"available": False, "source": "", "audio": [], "truncated": False}

    if _HAS_UNREAL:
        try:
            registry = unreal.AssetRegistryHelpers.get_asset_registry()
            for class_name, module in (
                ("SoundWave", "/Script/Engine"),
                ("SoundCue", "/Script/Engine"),
                ("SoundClass", "/Script/Engine"),
            ):
                try:
                    assets = registry.get_assets_by_class(unreal.TopLevelAssetPath(module, class_name))
                except Exception:
                    continue
                for a in assets:
                    try:
                        result["audio"].append({
                            "display_name": str(getattr(a, "asset_name", "")),
                            "package_path": str(getattr(a, "package_path", "")),
                            "package_name": str(getattr(a, "package_name", "")),
                            "asset_class": class_name,
                        })
                    except Exception:
                        continue
            result["available"] = True
            result["source"] = "asset_registry"
            return result
        except Exception:
            pass  # fall through to file-walk fallback

    project_dir, _verified, _source = _resolve_project_dir()
    content_dir = os.path.join(project_dir, "Content")
    walk_root = content_dir if os.path.isdir(content_dir) else project_dir
    try:
        outer_break = False
        for dirpath, dirnames, filenames in os.walk(walk_root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fn in filenames:
                if fn.lower().endswith(_AUDIO_EXTS):
                    if len(result["audio"]) >= MAX_FILES_WALKED:
                        result["truncated"] = True
                        outer_break = True
                        break
                    result["audio"].append({
                        "display_name": os.path.splitext(fn)[0],
                        "package_path": os.path.dirname(os.path.join(dirpath, fn)),
                        "package_name": os.path.join(dirpath, fn),
                        "asset_class": "file",
                    })
            if outer_break:
                break
        result["source"] = "filesystem_walk"
    except Exception:
        pass
    return result


# ---------------------------------------------------------------------------
# 5b. Unicode / emoji / decorative-symbol risk detection — BRAND-NEUTRAL,
#     structural (codepoint-range / unicodedata-category based), so it
#     belongs in THIS file rather than server-side. Sourced from a real
#     reproduced Rule 1.7 case: ordinary emoji in metadata triggered a flag,
#     and removing one emoji simply caused a DIFFERENT one to be flagged —
#     i.e. any decorative/pictographic character in submitted text is a
#     documented, reproducible risk surface, independent of any brand list.
# ---------------------------------------------------------------------------

# Common emoji/pictograph Unicode blocks (codepoint ranges), each labelled
# for the reported item's "kind". Deliberately brand/content-agnostic —
# these are BLOCK ranges from the Unicode standard, not a wordlist.
_EMOJI_CODEPOINT_RANGES = (
    (0x1F300, 0x1F5FF, "Miscellaneous Symbols and Pictographs"),
    (0x1F600, 0x1F64F, "Emoticons"),
    (0x1F680, 0x1F6FF, "Transport and Map Symbols"),
    (0x1F700, 0x1F77F, "Alchemical Symbols"),
    (0x1F780, 0x1F7FF, "Geometric Shapes Extended"),
    (0x1F800, 0x1F8FF, "Supplemental Arrows-C"),
    (0x1F900, 0x1F9FF, "Supplemental Symbols and Pictographs"),
    (0x1FA00, 0x1FA6F, "Chess Symbols / Symbols and Pictographs Extended-A"),
    (0x1FA70, 0x1FAFF, "Symbols and Pictographs Extended-A"),
    (0x2600, 0x26FF, "Miscellaneous Symbols"),
    (0x2700, 0x27BF, "Dingbats"),
    (0x2B00, 0x2BFF, "Miscellaneous Symbols and Arrows"),
    (0x1F1E6, 0x1F1FF, "Regional Indicator Symbols (flags)"),
)

# Zero-width joiner (combines emoji into compound glyphs, e.g. family/skin-
# tone sequences) and the two variation selectors (force emoji- vs text-
# style rendering of an otherwise-plain character) — reported as their own
# "kind" since they're invisible/near-invisible in a text editor.
_ZWJ_CODEPOINT = 0x200D
_VARIATION_SELECTOR_CODEPOINTS = (0xFE0F, 0xFE0E)

# unicodedata.category() classes covering symbol characters not already
# caught by the emoji block ranges above: So=Other Symbol (includes
# (TM)/(R)/(C) style marks and many dingbats), Sk=Modifier Symbol,
# Sm=Math Symbol. Non-ASCII punctuation (category starting with "P") is
# handled separately below (styled bullets, box-drawing-adjacent quotes,
# etc. often fall here too).
_SYMBOL_UNICODE_CATEGORIES = {"So", "Sk", "Sm"}

# Cap on how many individual hit *items* are returned in full detail — the
# scanner still counts every hit via total_count even past this cap.
_UNICODE_RISK_ITEM_CAP = 300


def _classify_unicode_char(ch):
    """Return a short human-readable "kind" label if `ch` is an
    emoji/pictograph, ZWJ, variation selector, symbol, or non-ASCII
    punctuation character — else None. Never raises (falls back to None on
    any unicodedata lookup failure)."""
    try:
        cp = ord(ch)
    except Exception:
        return None
    if cp < 128:
        return None  # plain ASCII — not a risk surface here

    if cp == _ZWJ_CODEPOINT:
        return "zero-width joiner"
    if cp in _VARIATION_SELECTOR_CODEPOINTS:
        return "variation selector"

    for start, end, block_label in _EMOJI_CODEPOINT_RANGES:
        if start <= cp <= end:
            return f"emoji ({block_label})"

    try:
        cat = unicodedata.category(ch)
    except Exception:
        return None
    if cat in _SYMBOL_UNICODE_CATEGORIES:
        return f"symbol ({cat})"
    if cat.startswith("P"):
        return f"non-ASCII punctuation ({cat})"
    return None


def collect_unicode_risks(text_metadata, verse_surfaces, asset_surfaces, audio_surfaces):
    """Scan every already-collected TEXT surface — text_metadata field
    values, verse_surfaces string/comment/label text, asset display names,
    and audio display names — for emoji/pictograph, ZWJ, variation
    selector, symbol, and non-ASCII-punctuation characters (see
    ``_classify_unicode_char``). This is a BRAND-NEUTRAL, purely structural
    check (codepoint ranges + ``unicodedata`` categories, no wordlist), and
    is the highest-value new signal in this module: a real reproduced
    Rule 1.7 case found ordinary emoji in metadata triggering a flag, with
    removing one emoji simply causing a DIFFERENT one to flag instead.

    Returns:
        {"available": True, "items": [...] (capped at
        _UNICODE_RISK_ITEM_CAP), "total_count": int (uncapped — every hit,
        even past the cap), "omitted_count": int, "notes": [...]}

    Each item: {"surface": str, "field_or_file": str, "char": str,
    "codepoint": "U+XXXX", "name": str (unicodedata.name, "" if
    unavailable), "kind": str, "context_snippet": str}. Never raises —
    any per-surface failure is skipped, not fatal."""
    result = {"available": True, "items": [], "total_count": 0, "omitted_count": 0, "notes": []}

    def _emit(surface, field_or_file, text):
        if not text:
            return
        try:
            text = str(text)
        except Exception:
            return
        for idx, ch in enumerate(text):
            try:
                kind = _classify_unicode_char(ch)
                if not kind:
                    continue
                result["total_count"] += 1
                if len(result["items"]) >= _UNICODE_RISK_ITEM_CAP:
                    continue
                try:
                    name = unicodedata.name(ch)
                except Exception:
                    name = ""
                start_ctx = max(0, idx - 15)
                end_ctx = min(len(text), idx + 16)
                result["items"].append({
                    "surface": surface,
                    "field_or_file": field_or_file,
                    "char": ch,
                    "codepoint": f"U+{ord(ch):04X}",
                    "name": name,
                    "kind": kind,
                    "context_snippet": text[start_ctx:end_ctx],
                })
            except Exception:
                continue

    try:
        for f in (text_metadata or {}).get("fields") or []:
            _emit("text_metadata", f"{f.get('file', '')} :: {f.get('key', '')}", f.get("value", ""))
    except Exception:
        pass

    try:
        for s in verse_surfaces or []:
            _emit("verse", f"{s.get('file', '')}:{s.get('line', '')}", s.get("text", ""))
    except Exception:
        pass

    try:
        for a in asset_surfaces or []:
            _emit(
                "asset_display_name",
                a.get("object_path") or a.get("package_name", ""),
                a.get("display_name", ""),
            )
    except Exception:
        pass

    try:
        for a in (audio_surfaces or {}).get("audio") or []:
            _emit("audio_display_name", a.get("package_name", ""), a.get("display_name", ""))
    except Exception:
        pass

    result["omitted_count"] = max(0, result["total_count"] - len(result["items"]))
    if result["omitted_count"]:
        result["notes"].append(
            f"{result['omitted_count']} additional Unicode-risk hits omitted from "
            f"`items` (capped at {_UNICODE_RISK_ITEM_CAP}) — see total_count for "
            "the full count."
        )
    return result


# ---------------------------------------------------------------------------
# 5c. Redirectors + soft references — ObjectRedirector assets via the Asset
#     Registry. A real Rule 1.7 case: renaming an imported/flagged asset did
#     NOT clear the flag, because moderation may inspect original import
#     metadata, references to the original package, and derived data. The
#     redirector left behind by a rename is exactly that lingering
#     reference — the community fix is "Fix Up Redirectors" plus auditing
#     remaining soft references to the old package path.
# ---------------------------------------------------------------------------

def collect_redirector_assets(scan_root=None):
    """Enumerate ObjectRedirector assets via the Asset Registry (present
    when content was renamed/moved and redirectors weren't fixed up).
    Scoped to the project's own content mount when it can be determined
    (see ``_resolve_project_mount``), same as ``collect_asset_surfaces``.

    Returns {"available": bool, "redirectors": [{"display_name",
    "package_path", "package_name"}], "notes": [...]}. If `unreal` isn't
    importable or the registry can't be reached, returns available=False
    with an honest note — NEVER implies "no redirectors found" in that
    case. Never raises."""
    result = {"available": _HAS_UNREAL, "redirectors": [], "notes": []}
    if not _HAS_UNREAL:
        result["notes"].append(
            "redirector scan unavailable: `unreal` is not importable (offline/"
            "standalone run) — this is NOT evidence the project has no "
            "redirectors, only that this pass couldn't check."
        )
        return result

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    except Exception as e:
        result["available"] = False
        result["notes"].append(f"asset registry unavailable: {e}")
        return result

    mount_prefix, _mount_source, _mount_confirmed = _resolve_project_mount(scan_root)

    assets = None
    try:
        assets = registry.get_assets_by_class(unreal.TopLevelAssetPath("/Script/CoreUObject", "ObjectRedirector"))
    except Exception:
        try:
            # Older/alternate UEFN Python API signature fallback.
            assets = registry.get_assets_by_class("ObjectRedirector")
        except Exception as e:
            result["available"] = False
            result["notes"].append(f"redirector class query failed: {e}")
            return result

    for a in assets or []:
        try:
            package_path = str(getattr(a, "package_path", ""))
            package_name = str(getattr(a, "package_name", ""))
            if mount_prefix and not package_path.startswith(mount_prefix):
                continue
            result["redirectors"].append({
                "display_name": str(getattr(a, "asset_name", "")),
                "package_path": package_path,
                "package_name": package_name,
            })
        except Exception:
            continue

    result["notes"].append(
        "Redirectors mean deleted/renamed content is still reachable through its "
        "old path — moderation may inspect original import metadata and "
        "references to the original package even after a rename, so renaming a "
        "flagged asset alone does NOT clear the flag. Fix: Content Browser > "
        "right-click the project folder > \"Fix Up Redirectors\" (recursive), "
        "then audit any remaining soft references to the old package path."
    )
    return result


# ---------------------------------------------------------------------------
# 5d. Text metadata field lengths — the text ACTUALLY SUBMITTED through the
#     publishing portal is the authoritative evidence; a local description
#     longer than the live limit means the submitted text was silently
#     truncated/differs from the draft (a documented Rule 1.7 cause). This
#     module does not hardcode a specific character limit (unverified/
#     liable to change) — it only reports lengths for that comparison.
# ---------------------------------------------------------------------------

def collect_text_field_lengths(text_metadata):
    """Report the character length of every field already collected by
    ``collect_text_metadata`` (island name/description/title/tag/summary
    fields, etc). Returns {"fields": [{"file", "key", "length"}], "notes":
    [...]}. Never raises."""
    result = {"fields": [], "notes": []}
    try:
        for f in (text_metadata or {}).get("fields") or []:
            value = f.get("value", "") or ""
            result["fields"].append({
                "file": f.get("file", ""),
                "key": f.get("key", ""),
                "length": len(value),
            })
    except Exception:
        pass
    result["notes"].append(
        "Lengths are of the metadata field VALUES found in local project files — "
        "they may not match what was actually typed/submitted through the "
        "publishing portal, which can silently truncate. Check the text ACTUALLY "
        "SUBMITTED against the CURRENT publishing-portal character limit (not "
        "hardcoded here, since the live limit isn't independently verified and "
        "may change) — a description that reads differently after truncation is "
        "a documented Rule 1.7 cause."
    )
    return result


# ---------------------------------------------------------------------------
# 5e. Image provenance signals — reusing a promotional image from an
#     existing online render (rather than capturing in-editor) is a
#     documented Rule 1.7 cause. This does not judge WHICH tool produced an
#     image (that's the connected LLM's job) — it only surfaces whether
#     authoring-tool/creator/copyright metadata fields are present at all.
# ---------------------------------------------------------------------------

_IMAGE_PROVENANCE_FIELD_NAMES = {"software", "creator", "copyright", "artist", "author"}


def collect_image_provenance(images):
    """Given the ``images`` list already produced by
    ``collect_image_metadata`` (``[{"file", "fields"}, ...]``), flag which
    images carry authoring-tool/creator/copyright metadata fields with a
    non-empty value — a signal (not proof) that the image came from an
    external tool or download rather than an in-editor capture. Returns
    {"images": [{"file", "has_provenance_fields", "fields_present"}],
    "notes": [...]}. Never raises."""
    result = {"images": [], "notes": []}
    try:
        for img in images or []:
            fields = img.get("fields") or {}
            present = []
            try:
                for k, v in fields.items():
                    key_norm = str(k).strip().lower()
                    if key_norm in _IMAGE_PROVENANCE_FIELD_NAMES and str(v).strip():
                        present.append(k)
            except Exception:
                pass
            result["images"].append({
                "file": img.get("file", ""),
                "has_provenance_fields": bool(present),
                "fields_present": present,
            })
    except Exception:
        pass
    result["notes"].append(
        "Presence of authoring-tool/creator/copyright metadata fields is a signal "
        "(not proof) that an image came from an external tool or download rather "
        "than an in-editor capture — reusing promotional images from existing "
        "online renders instead of capturing in-editor is a documented Rule 1.7 "
        "cause. This collector only surfaces the field-presence signal; judging "
        "which tool actually produced the image is the connected LLM's job."
    )
    return result


# ---------------------------------------------------------------------------
# 6. Asset hashing — mechanism for future exact-match against known-IP hashes
# ---------------------------------------------------------------------------

def hash_assets(project_dir):
    """Compute SHA256 of asset/image files under project_dir's Content dir.
    Returns (hashes, truncated): ``hashes`` is {path: sha256_hex}. This is
    only the MECHANISM for a future exact-match check against a known-IP
    hash set (that set is empty for now — no such set is shipped or
    maintained here). Never raises; a single unreadable file is skipped,
    not fatal.

    Capped two ways, either of which sets ``truncated=True``:
      * stops once MAX_FILES_HASHED files have been hashed (the walk
        itself also stops once MAX_FILES_WALKED matching files have been
        visited, hashed or not);
      * any individual file larger than MAX_FILE_BYTES_HASHED is skipped
        (not hashed at all) rather than hashed in full.
    A truncated result is a PARTIAL hash set, never a complete one — the
    caller must not treat missing hashes as "nothing there"."""
    hashes = {}
    truncated = False
    if not project_dir or not os.path.isdir(project_dir):
        return hashes, truncated

    root = os.path.join(project_dir, "Content")
    if not os.path.isdir(root):
        root = project_dir

    files_walked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if not fn.lower().endswith(_ASSET_HASH_EXTS):
                continue

            if len(hashes) >= MAX_FILES_HASHED or files_walked >= MAX_FILES_WALKED:
                truncated = True
                return hashes, truncated
            files_walked += 1

            full_path = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(full_path) > MAX_FILE_BYTES_HASHED:
                    truncated = True
                    continue
                h = hashlib.sha256()
                with open(full_path, "rb") as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b""):
                        h.update(chunk)
                hashes[full_path] = h.hexdigest()
            except Exception:
                continue

    return hashes, truncated


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_moderation_scan(project_dir=None, include_hashes=False):
    """Orchestrate every collector and return one structured dict:

        {
          "generated_ok": bool,
          "scan_root": str,
          "unreal_available": bool,
          "asset_surfaces": [...],          # project_assets (under resolved mount)
          "hlod_or_imported_assets": [...],
          "total_registry_assets": int,
          "excluded_engine_assets": int,
          "project_mount": str|None,
          "project_mount_source": str|None,  # "level_actor_path"|"world_path"|"scan_root_folder_name"|None
          "project_mount_confirmed": bool,
          "project_asset_count": int,
          "shared_game_mount_assets": [...], # PARTITIONED, never dropped — see below
          "shared_game_mount_asset_count": int,
          "verse_surfaces": [...],
          "text_metadata": {...},
          "image_metadata": [...],
          "image_paths": [...],
          "audio_surfaces": {...},
          "asset_hashes": {path: sha256},
          "unicode_risks": {...},           # emoji/decorative-Unicode hits
          "redirectors": {...},             # ObjectRedirector assets
          "external_actor_assets": [...],   # __ExternalActors__/__ExternalObjects__
          "text_field_lengths": {...},      # per-field character lengths
          "image_provenance": {...},        # authoring-tool/creator/copyright signal
          "notes": [...],
          "truncated": bool,
          "truncated_collectors": [str, ...],
        }

    CRITICAL REVIEW FIX (asset scoping — never drop, always partition):
    ``asset_surfaces``/``hlod_or_imported_assets`` cover only the resolved
    PROJECT mount (``project_mount``); everything non-engine that is NOT
    under that mount — commonly "/Game/" when "/Game/" isn't the resolved
    mount, but see ``_ENGINE_EXCLUDE_PREFIXES``'s docstring for why "/Game/"
    is never assumed either way — is kept, not discarded, in
    ``shared_game_mount_assets`` (a capped detail list;
    ``shared_game_mount_asset_count`` is the true, uncapped total). If
    ``project_mount`` is None, project scope could not be confirmed at all
    and EVERY non-engine asset landed in ``shared_game_mount_assets``
    instead of ``asset_surfaces`` — check ``notes`` for the prominent
    "PROJECT SCOPE UNCONFIRMED" marker in that case, and never read a
    short/empty ``asset_surfaces`` as "checked, nothing found" when it's
    present. See ``collect_asset_surfaces()``'s own docstring for the full
    partitioning rule.

    The five keys above (``unicode_risks`` through ``image_provenance``)
    are deterministic, BRAND-NEUTRAL detections derived from a sourced
    report on real Rule 1.7 rejections (see each collector's own
    docstring for the specific documented cause it targets):
    ``collect_unicode_risks``, ``collect_redirector_assets``, the
    External Actor/Object detection inside ``collect_asset_surfaces``,
    ``collect_text_field_lengths``, and ``collect_image_provenance``.

    ``truncated`` (BUG FIX — truncation semantics) is True iff a collector
    whose CONTENT SIGNAL matters got capped: Verse strings, text metadata,
    image metadata, or the audio filesystem-walk fallback. It deliberately
    does NOT flip to True just because asset hashing was capped, since
    hashing is a supplementary future exact-match mechanism, not the
    asset-name/path signal itself (which comes complete from the Asset
    Registry — that enumeration is never capped by MAX_FILES_WALKED).
    ``truncated_collectors`` lists every collector that hit a cap, whether
    or not it flipped ``truncated`` — check it for the full picture. An
    empty or short surface list is NOT proof of "no issues found" when
    ``truncated`` is True (or when the scan root itself was unverified —
    see the "scan root unverified" note below).

    ``include_hashes`` (default False) — asset hashing is the slowest
    collector and the one most likely to need truncation, so it no longer
    runs by default. Pass True to opt in (e.g. from the MCP path, which can
    afford the extra time and wants the future exact-match mechanism).

    Note: this dict deliberately has NO ``first_pass_hints`` key. The
    literal wordlist matching that used to live here now happens
    server-side in the MCP server (see the module docstring above) so this
    staged file never has to contain franchise/brand literals.

    ``project_dir=None`` resolves the live project root via
    ``health_scanner``'s validated scan-root chain (see module docstring).
    Pass an explicit path to scan a different/offline project (also how
    this is unit-tested without a live UEFN session).

    PHASE 2 (MCP wiring) NOTE: this function is the intended handler body —
    ``uefn_bridge.py``'s ``_handle_moderation_scan(params)`` wraps it,
    passing through ``params.get("project_dir")`` and
    ``params.get("include_hashes", False)``. This module never imports/
    touches ``uefn_bridge.py`` — it's designed to be pulled in from there,
    not the reverse. All collectors are side-effect-free (read-only) and
    safe to call from any thread/tick context UEFN's bridge dispatch uses.

    Never raises — every collector is individually guarded and any
    unexpected failure is recorded in ``notes`` rather than propagated.
    """
    notes = []
    truncated = False
    truncated_collectors = []

    if project_dir:
        scan_root = project_dir
    else:
        try:
            scan_root, verified, source = _resolve_project_dir()
            if not verified:
                notes.append(f"scan root unverified (best guess via {source}): {scan_root}")
                notes.append(
                    "SCAN ROOT NOT VERIFIED: the verse/text/image/hash surfaces "
                    "collected below may be INCOMPLETE OR EMPTY because the "
                    "correct project directory could not be confirmed. An "
                    "empty or short result in this scan is NOT evidence of "
                    "\"no issues found\" — it may simply mean the wrong "
                    "directory (or no directory) was scanned."
                )
        except Exception as e:
            scan_root = os.getcwd()
            notes.append(f"scan root resolution failed, falling back to cwd: {e}")

    result = {
        "generated_ok": True,
        "scan_root": scan_root,
        "unreal_available": _HAS_UNREAL,
        "asset_surfaces": [],
        "hlod_or_imported_assets": [],
        "total_registry_assets": 0,
        "excluded_engine_assets": 0,
        "project_mount": None,
        "project_mount_source": None,
        "project_mount_confirmed": False,
        "project_asset_count": 0,
        "shared_game_mount_assets": [],
        "shared_game_mount_asset_count": 0,
        "verse_surfaces": [],
        "text_metadata": {},
        "image_metadata": [],
        "image_paths": [],
        "audio_surfaces": {},
        "asset_hashes": {},
        "unicode_risks": {},
        "redirectors": {},
        "external_actor_assets": [],
        "text_field_lengths": {},
        "image_provenance": {},
        "notes": notes,
        "truncated": truncated,
        "truncated_collectors": truncated_collectors,
    }

    try:
        asset_result = collect_asset_surfaces(scan_root)
        result["asset_surfaces"] = asset_result.get("project_assets", [])
        result["hlod_or_imported_assets"] = asset_result.get("hlod_or_imported", [])
        result["external_actor_assets"] = asset_result.get("external_actor_or_object", [])
        result["total_registry_assets"] = asset_result.get("total_registry_assets", 0)
        result["excluded_engine_assets"] = asset_result.get("excluded_engine_assets", 0)
        result["project_mount"] = asset_result.get("project_mount")
        result["project_mount_source"] = asset_result.get("project_mount_source")
        result["project_mount_confirmed"] = asset_result.get("project_mount_confirmed", False)
        result["project_asset_count"] = asset_result.get("project_asset_count", 0)
        result["shared_game_mount_assets"] = asset_result.get("shared_game_mount_assets", [])
        result["shared_game_mount_asset_count"] = asset_result.get("shared_game_mount_asset_count", 0)
        for n in asset_result.get("notes") or []:
            notes.append(f"asset surfaces: {n}")
        if not asset_result.get("available"):
            notes.append("asset surfaces unavailable (unreal not importable or registry unreachable)")
        if asset_result.get("error"):
            notes.append(f"asset surfaces error: {asset_result['error']}")
    except Exception as e:
        notes.append(f"collect_asset_surfaces failed: {e}")

    try:
        verse_surfaces, verse_truncated = collect_verse_surfaces(scan_root)
        result["verse_surfaces"] = verse_surfaces
        if verse_truncated:
            result["truncated"] = True
            truncated_collectors.append("verse_surfaces")
            notes.append(
                f"Verse surface scan capped at {MAX_FILES_WALKED} files — "
                "results are partial, not a complete inventory."
            )
    except Exception as e:
        notes.append(f"collect_verse_surfaces failed: {e}")

    try:
        text_result = collect_text_metadata(scan_root)
        result["text_metadata"] = text_result
        if text_result.get("truncated"):
            result["truncated"] = True
            truncated_collectors.append("text_metadata")
            notes.append(
                f"Text metadata file candidates capped at {MAX_FILES_WALKED} "
                "— results are partial."
            )
    except Exception as e:
        notes.append(f"collect_text_metadata failed: {e}")

    try:
        image_result = collect_image_metadata(scan_root)
        result["image_metadata"] = image_result.get("images", [])
        result["image_paths"] = image_result.get("image_paths", [])
        if image_result.get("truncated"):
            result["truncated"] = True
            truncated_collectors.append("image_metadata")
            notes.append(
                f"Image metadata scan capped at {MAX_FILES_WALKED} files — "
                "results are partial, not a complete inventory."
            )
    except Exception as e:
        notes.append(f"collect_image_metadata failed: {e}")

    try:
        audio_result = collect_audio_surfaces()
        result["audio_surfaces"] = audio_result
        if audio_result.get("truncated"):
            result["truncated"] = True
            truncated_collectors.append("audio_surfaces")
            notes.append(
                f"Audio surface filesystem walk capped at {MAX_FILES_WALKED} "
                "files — results are partial, not a complete inventory."
            )
    except Exception as e:
        notes.append(f"collect_audio_surfaces failed: {e}")

    # --- Five deterministic, brand-neutral detections (sourced from real
    # Rule 1.7 rejection reports) — each runs over surfaces already
    # collected above, so these MUST come after the asset/verse/text/
    # image/audio blocks. Each is independently guarded; a failure in one
    # never blocks the others or the rest of the scan. ---
    try:
        result["unicode_risks"] = collect_unicode_risks(
            result.get("text_metadata"),
            result.get("verse_surfaces"),
            result.get("asset_surfaces"),
            result.get("audio_surfaces"),
        )
        omitted = result["unicode_risks"].get("omitted_count") or 0
        if omitted:
            notes.append(
                f"Unicode/emoji risk items capped at {_UNICODE_RISK_ITEM_CAP} — "
                f"{omitted} more omitted (see unicode_risks.total_count for the "
                "full count)."
            )
    except Exception as e:
        notes.append(f"collect_unicode_risks failed: {e}")
        result["unicode_risks"] = {
            "available": False, "items": [], "total_count": 0,
            "omitted_count": 0, "notes": [f"collector failed: {e}"],
        }

    try:
        result["redirectors"] = collect_redirector_assets(scan_root)
        if not result["redirectors"].get("available"):
            notes.append(
                "redirectors: unavailable this pass — see redirectors.notes "
                "(NOT evidence of zero redirectors)."
            )
    except Exception as e:
        notes.append(f"collect_redirector_assets failed: {e}")
        result["redirectors"] = {"available": False, "redirectors": [], "notes": [f"collector failed: {e}"]}

    try:
        result["text_field_lengths"] = collect_text_field_lengths(result.get("text_metadata"))
    except Exception as e:
        notes.append(f"collect_text_field_lengths failed: {e}")
        result["text_field_lengths"] = {"fields": [], "notes": [f"collector failed: {e}"]}

    try:
        result["image_provenance"] = collect_image_provenance(result.get("image_metadata"))
    except Exception as e:
        notes.append(f"collect_image_provenance failed: {e}")
        result["image_provenance"] = {"images": [], "notes": [f"collector failed: {e}"]}

    if include_hashes:
        try:
            asset_hashes, hash_truncated = hash_assets(scan_root)
            result["asset_hashes"] = asset_hashes
            if hash_truncated:
                # Deliberately does NOT set result["truncated"] = True (BUG
                # FIX — truncation semantics): hashing is a supplementary
                # future exact-match mechanism, not the asset-name/path
                # signal, which is complete regardless (Asset Registry
                # enumeration above is never capped). Still recorded in
                # truncated_collectors so a caller that cares can see it.
                truncated_collectors.append("asset_hashes")
                notes.append(
                    f"Asset hashing capped at {MAX_FILES_HASHED} files (and/or "
                    f"files over {MAX_FILE_BYTES_HASHED // (1024 * 1024)}MB were "
                    "skipped) — asset NAMES/PATHS above are COMPLETE; only the "
                    "supplementary hash set is partial."
                )
        except Exception as e:
            notes.append(f"hash_assets failed: {e}")
    else:
        notes.append(
            "Asset hashing skipped (include_hashes=False, the default — "
            "hashing is slow and only a supplementary future exact-match "
            "mechanism; pass include_hashes=True to opt in)."
        )

    return result


# ---------------------------------------------------------------------------
# Launcher UI — analysed-report-first viewer (see module docstring: this
# module itself never judges anything; the analysed report is written by a
# connected LLM through uefn_bridge.py's moderation_report_save MCP handler)
# ---------------------------------------------------------------------------

def _moderation_report_path():
    """Path to moderation_report.json, next to THIS script. Matches
    ``uefn_bridge.py``'s own ``_moderation_report_path()`` — both scripts
    live side by side in Content/Python (see module docstring) — but is
    reimplemented locally rather than imported, since this module
    deliberately never imports ``uefn_bridge.py`` (see run_moderation_scan's
    docstring: "designed to be pulled in from there, not the reverse")."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "moderation_report.json")


def _read_moderation_report():
    """Read the analysed moderation_report.json written by the connected
    LLM. Shape: {"generated_at": str, "summary": str, "severity_counts":
    {"BLOCKER": int, "WARN": int, "KNOWN_RISK": int, "INFO": int},
    "report": str}. Returns the parsed dict, or None if the file is
    missing, unreadable, or not a JSON object — never raises. A missing/
    corrupt file simply means "no analysed report yet", not an error."""
    try:
        with open(_moderation_report_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _format_compact_summary(result):
    """Render a compact, COUNTS-ONLY summary of run_moderation_scan()'s
    dict — the "scanned N, excluded M engine assets" honesty line plus one
    count per surface, not a raw dump. Never raises.

    CRITICAL REVIEW FIX: surfaces the project/shared-mount/engine
    PARTITION counts (never just "project assets scanned" on its own,
    which could read as a scoped, complete scan even when a large
    shared-mount bucket was set aside) and puts the unconfirmed-scope note
    front and center — right after the counts, not buried in the notes
    list — whenever the project mount could not be confirmed, so the
    launcher window can never imply a scoped scan happened when it
    didn't."""
    lines = []
    try:
        total_registry = result.get("total_registry_assets", 0)
        excluded = result.get("excluded_engine_assets", 0)
        project_assets = result.get("project_asset_count", len(result.get("asset_surfaces") or []))
        shared_assets = result.get("shared_game_mount_asset_count", 0)
        project_mount = result.get("project_mount")
        mount_source = result.get("project_mount_source")
        mount_confirmed = bool(result.get("project_mount_confirmed"))
        hlod_imported = len(result.get("hlod_or_imported_assets") or [])
        verse_n = len(result.get("verse_surfaces") or [])
        text_meta = result.get("text_metadata") or {}
        text_fields_n = len(text_meta.get("fields") or [])
        images_n = len(result.get("image_metadata") or [])
        total_images = len(result.get("image_paths") or [])
        audio = result.get("audio_surfaces") or {}
        audio_n = len(audio.get("audio") or [])
        hashes_n = len(result.get("asset_hashes") or {})

        unicode_risks = result.get("unicode_risks") or {}
        unicode_total = unicode_risks.get("total_count", 0)
        redirectors = result.get("redirectors") or {}
        redirectors_n = len(redirectors.get("redirectors") or [])
        external_actor_n = len(result.get("external_actor_assets") or [])
        image_prov = result.get("image_provenance") or {}
        prov_flagged_n = sum(
            1 for i in (image_prov.get("images") or []) if i.get("has_provenance_fields")
        )

        # PARTITION counts — reconcile: project + shared + engine == total.
        if project_mount:
            confirmed_label = "confirmed live" if mount_confirmed else "unconfirmed guess"
            lines.append(f"Project content mount: {project_mount!r} ({confirmed_label}, via {mount_source})")
        else:
            lines.append(
                "PROJECT SCOPE UNCONFIRMED — no project content mount could be "
                "resolved. This is NOT a scoped scan: results below may include "
                "shipped/base game content and must be reviewed as such."
            )
        lines.append(
            f"Assets — project: {project_assets}  |  shared/base mount: "
            f"{shared_assets}  |  engine/shipped-runtime: {excluded}  |  "
            f"total registry: {total_registry}"
        )
        if shared_assets and project_mount:
            lines.append(
                f"  NOTE: {shared_assets} asset(s) live on the shared/base "
                "content mount, not the confirmed project mount — kept, see "
                "shared_game_mount_assets. Whether they're the creator's own "
                "content or shipped/base game content depends on project "
                "layout."
            )
        lines.append(f"HLOD / possibly-imported assets: {hlod_imported}")
        lines.append(f"External Actor/Object generated packages: {external_actor_n}")
        lines.append(f"Verse string/comment/label surfaces: {verse_n}")
        lines.append(f"Text metadata fields (island name/description/etc.): {text_fields_n}")
        lines.append(f"Images with embedded text metadata: {images_n} (of {total_images} scanned)")
        lines.append(f"Audio surfaces ({audio.get('source', '?')}): {audio_n}")
        lines.append(f"Asset hashes computed: {hashes_n}")
        lines.append("")
        lines.append(f"Emoji / decorative-Unicode hits: {unicode_total}  <-- actionable")
        lines.append(f"Redirectors (renamed/deleted content still reachable): {redirectors_n}  <-- actionable")
        lines.append(f"Images with authoring-tool/creator/copyright metadata: {prov_flagged_n}")

        truncated = bool(result.get("truncated"))
        truncated_collectors = result.get("truncated_collectors") or []
        if truncated:
            lines.append("")
            lines.append(
                f"TRUNCATED — capped collector(s): {', '.join(truncated_collectors) or '?'}. "
                "See notes below for exactly what was capped."
            )
        elif truncated_collectors:
            # Something was capped (e.g. only asset hashing, when opted
            # in) but nothing signal-critical — say so plainly, without
            # the alarming banner (BUG FIX — truncation semantics).
            lines.append("")
            lines.append(
                f"Note: {', '.join(truncated_collectors)} capped, but asset "
                "names/paths above are COMPLETE — see notes."
            )

        notes = result.get("notes") or []
        if notes:
            lines.append("")
            lines.append(f"Notes ({len(notes)}):")
            for n in notes:
                lines.append("  - " + str(n))
    except Exception as e:
        lines.append(f"(summary formatting error: {e})")
    return "\n".join(lines)


def _format_raw_surfaces(result):
    """Render the FULL raw collected surfaces (each list capped, with an
    omitted-count note) — the detail view behind the "Show raw collected
    surfaces" toggle. Never raises."""
    lines = []
    _cap = 200

    def _add_list(title, items, fmt):
        lines.append(f"{title} ({len(items)}):")
        if not items:
            lines.append("  (none)")
        else:
            for item in items[:_cap]:
                try:
                    lines.append("  " + fmt(item))
                except Exception:
                    lines.append("  " + str(item))
            if len(items) > _cap:
                lines.append(f"  ... {len(items) - _cap} more omitted (showing first {_cap})")
        lines.append("")

    try:
        _add_list(
            "HLOD / possibly-imported assets — HIGHEST-VALUE signal",
            result.get("hlod_or_imported_assets") or [],
            lambda a: f"{a.get('package_path', '')}  [{a.get('display_name', '')}]",
        )
        _add_list(
            "All project asset surfaces",
            result.get("asset_surfaces") or [],
            lambda a: f"{a.get('object_path') or a.get('package_name', '')}",
        )
        _add_list(
            "Verse source surfaces (strings / comments / labels)",
            result.get("verse_surfaces") or [],
            lambda s: f"{s.get('kind', '')}: {s.get('text', '')}  ({s.get('file', '')}:{s.get('line', '')})",
        )

        text_meta = result.get("text_metadata") or {}
        _add_list(
            "Text metadata fields (island name / description / etc.)",
            text_meta.get("fields") or [],
            lambda f: f"{f.get('key', '')} = {f.get('value', '')}  ({f.get('file', '')})",
        )

        _add_list(
            "Images with embedded text metadata (bonus signal)",
            result.get("image_metadata") or [],
            lambda i: f"{i.get('file', '')}: {i.get('fields', {})}",
        )

        audio = result.get("audio_surfaces") or {}
        _add_list(
            f"Audio surfaces (source: {audio.get('source', '?')})",
            audio.get("audio") or [],
            lambda a: f"{a.get('display_name', '')}  ({a.get('package_path', '')})",
        )

        _add_list(
            "Emoji / decorative-Unicode hits — HIGH-VALUE signal",
            (result.get("unicode_risks") or {}).get("items") or [],
            lambda u: (
                f"{u.get('codepoint', '')} {u.get('name', '') or u.get('kind', '')} "
                f"({u.get('kind', '')})  in {u.get('surface', '')} :: "
                f"{u.get('field_or_file', '')}  context: {u.get('context_snippet', '')!r}"
            ),
        )
        _add_list(
            "Redirectors (renamed/deleted content still reachable via old path)",
            (result.get("redirectors") or {}).get("redirectors") or [],
            lambda r: f"{r.get('package_path', '')}  [{r.get('display_name', '')}]",
        )
        _add_list(
            "External Actor / External Object generated packages",
            result.get("external_actor_assets") or [],
            lambda a: f"{a.get('package_path', '')}  [{a.get('display_name', '')}]",
        )
        _add_list(
            "Text metadata field lengths",
            (result.get("text_field_lengths") or {}).get("fields") or [],
            lambda f: f"{f.get('key', '')} = {f.get('length', '')} chars  ({f.get('file', '')})",
        )
        _add_list(
            "Images flagged with authoring-tool/creator/copyright metadata",
            [
                i for i in (result.get("image_provenance") or {}).get("images") or []
                if i.get("has_provenance_fields")
            ],
            lambda i: f"{i.get('file', '')}: fields present = {', '.join(i.get('fields_present') or [])}",
        )
    except Exception as e:
        lines.append(f"(raw surfaces formatting error: {e})")

    return "\n".join(lines)


def show_moderation_scan():
    """Display the IP / Moderation Pre-Flight Scan window.

    Redesigned to be actionable rather than a raw dump:
      1. If an ANALYSED report (moderation_report.json, written by a
         connected LLM through uefn_bridge.py's moderation_report_save MCP
         handler) exists, it is shown FIRST — generated_at, severity
         counts, summary, then the full report text.
      2. If no analysed report exists yet, a bold call-to-action tells the
         user to run the "uefn_moderation_scan" MCP tool from their
         connected AI assistant.
      3. "Copy prompt" puts a ready-to-paste instruction (naming this
         project's path) on the clipboard.
      4. "Refresh" re-reads moderation_report.json and re-renders section
         1/2 in place, so the user can run the tool in their assistant and
         click Refresh without reopening the window.
      5. A compact, counts-only summary of the collected surfaces (see
         ``_format_compact_summary``) is always shown.
      6. The full raw surfaces are collapsed behind a "Show raw collected
         surfaces" toggle, capped with an omitted-count note when expanded.

    This module never judges anything itself (see the module docstring) —
    the analysed report and its severities always come from the connected
    LLM, never from logic in this file. ``run_moderation_scan()`` is called
    with the default ``include_hashes=False`` here (the window doesn't need
    the future exact-match hash mechanism, and skipping it keeps the window
    fast and avoids the hashing truncation cap entirely).
    """
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("moderation_scanner: tkinter is not available.")
        return

    try:
        result = run_moderation_scan()
    except Exception as e:
        result = {
            "scan_root": "?",
            "notes": [f"Moderation scan failed to run: {e}"],
            "truncated": False,
            "truncated_collectors": [],
        }

    scan_root = result.get("scan_root") or "?"

    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's IP / Moderation Pre-Flight Scan")
    root.geometry("900x700")
    root.minsize(600, 440)
    root.configure(bg=_BG)

    header_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    header_frame.pack(fill=tk.X)
    tk.Label(header_frame, text="IP / Moderation Pre-Flight Scan",
             font=("Segoe UI", 15, "bold"), fg=_HEADER_FG, bg=_BG).pack(anchor=tk.W)
    tk.Label(
        header_frame, text=f"Project: {scan_root}",
        font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
    ).pack(anchor=tk.W)

    # --- Analysed report / call-to-action (rebuilt on load and on Refresh) ---
    report_frame = tk.Frame(root, bg=_BG, padx=16, pady=(4, 8))
    report_frame.pack(fill=tk.BOTH, expand=False)

    def _render_report_section():
        for child in report_frame.winfo_children():
            child.destroy()

        report_data = _read_moderation_report()
        if report_data:
            counts = report_data.get("severity_counts") or {}
            tk.Label(
                report_frame,
                text=f"Analysed report — {report_data.get('generated_at', '?')}",
                font=("Segoe UI", 11, "bold"), fg=_HEADER_FG, bg=_BG,
            ).pack(anchor=tk.W)
            tk.Label(
                report_frame,
                text=(
                    f"BLOCKER: {counts.get('BLOCKER', 0)}   "
                    f"WARN: {counts.get('WARN', 0)}   "
                    f"KNOWN_RISK: {counts.get('KNOWN_RISK', 0)}   "
                    f"INFO: {counts.get('INFO', 0)}"
                ),
                font=("Segoe UI", 10, "bold"), fg=_ACCENT_BLUE, bg=_BG,
            ).pack(anchor=tk.W, pady=(2, 0))

            summary = report_data.get("summary") or ""
            if summary:
                tk.Label(
                    report_frame, text=summary, font=("Segoe UI", 9), fg=_TEXT_FG,
                    bg=_BG, justify=tk.LEFT, wraplength=850,
                ).pack(anchor=tk.W, pady=(6, 0))

            report_widget = scrolledtext.ScrolledText(
                report_frame, wrap=tk.WORD, bg=_SECTION_BG, fg=_TEXT_FG,
                insertbackground=_TEXT_FG, relief="flat", font=("Consolas", 9),
                height=12,
            )
            report_widget.pack(fill=tk.BOTH, expand=True, pady=(8, 0))
            report_widget.insert("1.0", report_data.get("report") or "(no report text)")
            report_widget.configure(state=tk.DISABLED)
        else:
            cta = tk.Frame(report_frame, bg=_SECTION_BG, padx=12, pady=10)
            cta.pack(fill=tk.X)
            tk.Label(
                cta, text="No analysed report yet",
                font=("Segoe UI", 13, "bold"), fg=_ACCENT_BLUE, bg=_SECTION_BG,
            ).pack(anchor=tk.W)
            tk.Label(
                cta,
                text=(
                    "Run the “uefn_moderation_scan” MCP tool from your connected AI "
                    "assistant (Claude Code, Cursor, etc.) — the analysed IP / "
                    "authenticity results, grouped by severity, will appear here. "
                    "Click “Copy prompt” below for a ready-to-paste instruction, "
                    "then click “Refresh” once your assistant finishes."
                ),
                font=("Segoe UI", 10, "bold"), fg=_HEADER_FG, bg=_SECTION_BG,
                justify=tk.LEFT, wraplength=850,
            ).pack(anchor=tk.W, pady=(4, 0))

    _render_report_section()

    # --- Action buttons ---
    actions_frame = tk.Frame(root, bg=_BG, padx=16, pady=(0, 8))
    actions_frame.pack(fill=tk.X)

    def _copy_prompt():
        prompt = (
            "Run the uefn_moderation_scan MCP tool for this UEFN project "
            f"(project path: {scan_root}), then review the collected asset, "
            "Verse, text-metadata, image, and audio surfaces and report any "
            "IP-ownership or authenticity risks, grouped by severity "
            "(BLOCKER, WARN, KNOWN_RISK, INFO), with a short summary and "
            "actionable next steps for each finding."
        )
        try:
            root.clipboard_clear()
            root.clipboard_append(prompt)
        except Exception:
            pass

    tk.Button(
        actions_frame, text="Copy prompt", font=("Segoe UI", 9, "bold"),
        bg=_ACCENT_BLUE, fg="#FFFFFF", activebackground="#D24E1F",
        activeforeground="#FFFFFF", relief="flat", padx=10, pady=4,
        command=_copy_prompt,
    ).pack(side=tk.LEFT)

    tk.Button(
        actions_frame, text="Refresh", font=("Segoe UI", 9),
        bg=_SECTION_BG, fg=_TEXT_FG, activebackground=_BG,
        activeforeground=_TEXT_FG, relief="flat", padx=10, pady=4,
        command=_render_report_section,
    ).pack(side=tk.LEFT, padx=(8, 0))

    # --- Compact summary (always shown, counts only — not a dump) ---
    summary_frame = tk.Frame(root, bg=_BG, padx=16, pady=(0, 4))
    summary_frame.pack(fill=tk.X)
    tk.Label(
        summary_frame, text=_format_compact_summary(result),
        font=("Consolas", 9), fg=_TEXT_FG, bg=_BG, justify=tk.LEFT, anchor=tk.W,
    ).pack(anchor=tk.W, fill=tk.X)

    # --- Raw surfaces, collapsed by default ---
    raw_container = tk.Frame(root, bg=_BG, padx=16, pady=4)
    raw_container.pack(fill=tk.BOTH, expand=True)

    raw_text_frame = tk.Frame(raw_container, bg=_BG)
    raw_widget = scrolledtext.ScrolledText(
        raw_text_frame, wrap=tk.WORD, bg=_SECTION_BG, fg=_TEXT_FG,
        insertbackground=_TEXT_FG, relief="flat", font=("Consolas", 9),
    )
    raw_widget.pack(fill=tk.BOTH, expand=True)
    raw_widget.insert("1.0", _format_raw_surfaces(result))
    raw_widget.configure(state=tk.DISABLED)

    _raw_visible = [False]

    def _toggle_raw():
        if _raw_visible[0]:
            raw_text_frame.pack_forget()
            toggle_btn.configure(text="Show raw collected surfaces ▾")
            _raw_visible[0] = False
        else:
            raw_text_frame.pack(fill=tk.BOTH, expand=True, pady=(6, 0))
            toggle_btn.configure(text="Hide raw collected surfaces ▴")
            _raw_visible[0] = True

    toggle_btn = tk.Button(
        raw_container, text="Show raw collected surfaces ▾",
        font=("Segoe UI", 9), bg=_SECTION_BG, fg=_TEXT_FG,
        activebackground=_BG, activeforeground=_TEXT_FG, relief="flat",
        padx=10, pady=4, command=_toggle_raw,
    )
    toggle_btn.pack(anchor=tk.W)

    # Footer
    footer = tk.Frame(root, bg=_SECTION_BG, padx=8, pady=4)
    footer.pack(fill=tk.X, side=tk.BOTTOM)
    social = tk.Label(footer, text="@thetrashbyrd", font=("Segoe UI", 8),
                      fg=_ACCENT_BLUE, bg=_SECTION_BG, cursor="hand2")
    social.pack(side=tk.RIGHT, padx=(0, 4))
    social.bind("<Button-1>", lambda _e: webbrowser.open("https://x.com/thetrashbyrd"))

    # Tick pump (UEFN's embedded Python has no running Tk mainloop).
    _tick_handle = [None]

    def _tick(_dt):
        try:
            if root.winfo_exists():
                root.update()
            else:
                if _tick_handle[0]:
                    unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                    _tick_handle[0] = None
        except tk.TclError:
            if _tick_handle[0]:
                unreal.unregister_slate_post_tick_callback(_tick_handle[0])
                _tick_handle[0] = None
        except Exception:
            pass

    def _on_close():
        if _tick_handle[0]:
            unreal.unregister_slate_post_tick_callback(_tick_handle[0])
            _tick_handle[0] = None
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", _on_close)

    if _HAS_UNREAL:
        _tick_handle[0] = unreal.register_slate_post_tick_callback(_tick)

    root.update()
    if _HAS_UNREAL:
        unreal.log("moderation_scanner: scan window opened.")


if __name__ == "__main__":
    import json as _json
    print(_json.dumps(run_moderation_scan(), indent=2, default=str))
