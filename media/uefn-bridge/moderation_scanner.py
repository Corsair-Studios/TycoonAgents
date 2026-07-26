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
import subprocess
import tempfile
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


# ---------------------------------------------------------------------------
# Clipboard — Tk's clipboard API is FORBIDDEN in this file. Do not reintroduce
# clipboard_clear() / clipboard_append() / clipboard_get() / selection_own() /
# selection_handle() on any widget here.
#
# WHY: Tk's clipboard requires the window to take ownership of the system
# CLIPBOARD selection and then service selection-request events from ITS OWN
# Tk event loop. Every Power Tools window (this one included) is pumped by
# UEFN's register_slate_post_tick_callback tick pump instead of running
# mainloop(), so there is no owning event loop able to service a selection
# request. That leaves Tcl/Tk unable to hand off the clipboard and it aborts
# the whole host process (real crash stack: ucrtbase -> python311 ->
# _tkinter -> tcl86t (x5) -> tk86t -> user32 ... Abort signal received) --
# i.e. clicking "Copy prompt" used to crash UEFN itself, not just this
# window. Use `_copy_text_to_system_clipboard` (subprocess, no Tk clipboard
# involvement) and `_show_copy_fallback_dialog` (no clipboard API at all)
# below instead.
# ---------------------------------------------------------------------------

def _copy_text_to_system_clipboard(text):
    """Best-effort OS clipboard copy that never touches Tk's clipboard API.

    Pipes `text` to the Windows `clip` console utility via subprocess; `clip`
    owns and services the clipboard itself in its own separate process, so
    this has nothing to do with Tk/Tcl and cannot reproduce the abort
    described above. `startupinfo`/`CREATE_NO_WINDOW` keep the console
    window hidden so nothing flashes over the editor.

    Returns True on success, False if unavailable/failed (non-Windows, no
    `clip` on PATH, timeout, etc.) — callers MUST have a no-clipboard
    fallback for the False case (see `_show_copy_fallback_dialog`). Never
    raises.
    """
    if os.name != "nt":
        return False
    try:
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE
        proc = subprocess.run(
            ["clip"],
            input=text.encode("utf-16-le"),
            startupinfo=startupinfo,
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=5,
        )
        return proc.returncode == 0
    except Exception:
        return False


def _show_copy_fallback_dialog(root, text, title="Copy this text"):
    """No-clipboard-API fallback: a small Toplevel showing `text` pre-selected
    in a ScrolledText widget so the user can press Ctrl+C themselves. Uses
    zero Tk clipboard calls (no clipboard_get/selection_own either), so it
    cannot reproduce the crash described above — it always works.
    """
    dlg = tk.Toplevel(root)
    dlg.title(title)
    dlg.configure(bg=_BG)
    dlg.geometry("640x360")
    tk.Label(
        dlg,
        text=(
            "Clipboard copy is unavailable here — the text below is "
            "pre-selected. Click inside it and press Ctrl+C to copy."
        ),
        font=("Segoe UI", 9, "bold"), fg=_HEADER_FG, bg=_BG,
        wraplength=610, justify=tk.LEFT,
    ).pack(fill=tk.X, padx=12, pady=(12, 6))

    box = scrolledtext.ScrolledText(
        dlg, wrap=tk.WORD, bg=_SECTION_BG, fg=_TEXT_FG,
        insertbackground=_TEXT_FG, relief="flat", font=("Consolas", 9),
    )
    box.pack(fill=tk.BOTH, expand=True, padx=12, pady=(0, 12))
    box.insert("1.0", text)
    box.tag_add("sel", "1.0", "end")
    box.focus_set()

    tk.Button(
        dlg, text="Close", font=("Segoe UI", 9), bg=_SECTION_BG, fg=_TEXT_FG,
        relief="flat", padx=10, pady=4, command=dlg.destroy,
    ).pack(pady=(0, 12))


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


# Cheap structural proxy for "UI icon/QR-code-shaped image": small AND
# roughly square. Not itself a finding — only a suspect-selection signal for
# extract_asset_thumbnails() (see run_moderation_scan).
_UI_TEXTURE_SUSPECT_MAX_DIM = 512
_UI_TEXTURE_SUSPECT_LIST_CAP = 200


def _extract_import_source_info(asset_data):
    """Best-effort read of the ``AssetImportData`` Asset Registry tag —
    available WITHOUT loading the asset via
    ``unreal.AssetData.get_tag_value("AssetImportData")`` (same
    ``get_tag_value`` API the sibling ``asset_sweep.py`` already uses for
    ``DiskSize``/``SizeX``/``SizeY``). UE stores this as a JSON array of
    import records (one per source file an asset was (re-)imported from);
    this returns only the FIRST record's ``RelativeFilename``/``FileMD5``/
    ``Timestamp`` — the original import source is what matters for
    provenance, not later re-imports.

    Returns ``(source_path, file_md5, timestamp)`` — any element may be
    None. All three are None if the asset was never imported (engine-
    generated or created directly in-editor) or the tag can't be read/
    parsed. Never raises."""
    try:
        raw = asset_data.get_tag_value("AssetImportData")
    except Exception:
        return None, None, None
    if not raw:
        return None, None, None
    try:
        records = json.loads(raw)
    except Exception:
        return None, None, None
    if not isinstance(records, list) or not records:
        return None, None, None
    try:
        first = records[0] or {}
        source_path = (first.get("RelativeFilename") or "").strip() or None
        file_md5 = (first.get("FileMD5") or "").strip() or None
        timestamp = (first.get("Timestamp") or "").strip() or None
        return source_path, file_md5, timestamp
    except Exception:
        return None, None, None


def collect_asset_surfaces(scan_root=None):
    """Enumerate the FULL Asset Registry and PARTITION it into labelled
    buckets — never silently drop a bucket. Returns:

        {"available": bool,
         "project_assets": [...],                    # under resolved mount
         "shared_game_mount_assets": [...],           # capped detail list
         "shared_game_mount_assets_omitted_count": int,
         "hlod_or_imported": [...],                   # union, both buckets
         "external_actor_or_object": [...],           # union, both buckets
         "hlod_generated_count": int,                 # exact, uncapped, HLOD only
         "import_source_records": [...],              # uncapped raw AssetImportData
         "small_square_ui_texture_entries": [...],    # thumbnail-suspect signal
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
        # Raw AssetImportData extraction, uncapped, computed over EVERY
        # non-engine asset in BOTH buckets (same "before either bucket is
        # capped" guarantee as HLOD/external-actor detection below) — see
        # collect_import_provenance(), which classifies these. Only
        # populated for assets that actually carry import data (most
        # engine-authored/Blueprint/material assets won't).
        "import_source_records": [],
        # Exact, uncapped count of assets whose package path contains
        # "HLOD" — auto-generated per streaming cell. Reported separately
        # from hlod_or_imported (which also includes ordinary project
        # assets) so a caller can always see the true HLOD volume even
        # though HLOD entries are deprioritized in transport sampling (see
        # run_moderation_scan's max_items handling).
        "hlod_generated_count": 0,
        # Small (<= _UI_TEXTURE_SUSPECT_MAX_DIM) roughly-square Texture2D
        # assets — a cheap structural proxy for "UI icon/QR-code-shaped
        # image" used only to seed extract_asset_thumbnails()'s suspect
        # list. Defensively capped at 200 internally (thumbnail extraction
        # itself is separately hard-capped much lower); this is a signal
        # source, not a reported finding on its own.
        "small_square_ui_texture_entries": [],
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
            if is_hlod:
                result["hlod_generated_count"] += 1

            if is_hlod or is_project_owned:
                result["hlod_or_imported"].append(entry)
            if is_external_actor_or_object:
                result["external_actor_or_object"].append(entry)

            # Raw AssetImportData extraction — uncapped, same "before either
            # bucket is capped" guarantee as HLOD/external-actor above (see
            # collect_import_provenance, which classifies these records).
            if _HAS_UNREAL:
                try:
                    src_path, file_md5, timestamp = _extract_import_source_info(a)
                except Exception:
                    src_path = file_md5 = timestamp = None
                if src_path:
                    result["import_source_records"].append({
                        "object_path": object_path,
                        "display_name": display_name,
                        "package_name": package_name,
                        "source_path": src_path,
                        "file_md5": file_md5 or "",
                        "timestamp": timestamp or "",
                    })

                # Small/roughly-square Texture2D suspect signal (feeds
                # extract_asset_thumbnails' suspect list only) — cheap tag
                # reads restricted to Texture2D-classed assets so this
                # doesn't add per-asset cost across the other ~48k entries.
                if asset_class == "Texture2D" and len(result["small_square_ui_texture_entries"]) < _UI_TEXTURE_SUSPECT_LIST_CAP:
                    try:
                        size_x = a.get_tag_value("SizeX")
                        size_y = a.get_tag_value("SizeY")
                        if size_x and size_y:
                            sx, sy = int(size_x), int(size_y)
                            if (
                                sx <= _UI_TEXTURE_SUSPECT_MAX_DIM
                                and sy <= _UI_TEXTURE_SUSPECT_MAX_DIM
                                and abs(sx - sy) <= max(4, int(0.1 * max(sx, sy)))
                            ):
                                result["small_square_ui_texture_entries"].append(entry)
                    except Exception:
                        pass
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


_FIELD_NAME_ARRAY_INDEX_RE = re.compile(r"\[\d+\]$")


def _simplify_field_name(key_path):
    """Collapse a JSON key path like ``"a.b[0].description"`` down to just
    its last segment (``"description"``) for by-field-name tallying in
    ``collect_unicode_risks`` — this is the granularity that matches how
    moderation actually reports a violation (e.g. "the description"), not
    the full nested key path. Falls back to the original path if it can't
    be simplified. Never raises."""
    if not key_path:
        return key_path
    try:
        last = str(key_path).rsplit(".", 1)[-1]
        last = _FIELD_NAME_ARRAY_INDEX_RE.sub("", last)
        return last or str(key_path)
    except Exception:
        return key_path


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

    A single aggregate count is not actionable on its own — Fortnite's
    TEXT-METADATA moderation review stage only reads island name/
    description/etc, not Verse source code, asset names, or audio names,
    so hits buried in thousands of Verse strings are far lower priority
    than the handful (if any) sitting in the island description. Callers
    (see ``_format_compact_summary``) should lead with the metadata
    breakdown, not the raw total.

    Returns:
        {"available": True, "items": [...] (capped at
        _UNICODE_RISK_ITEM_CAP), "total_count": int (uncapped — every hit,
        even past the cap), "omitted_count": int,
        "by_surface": {surface: {"count": int, "fields": {field_name:
        int}}}, "notes": [...]}

    ``by_surface`` tallies EVERY hit (never capped by
    _UNICODE_RISK_ITEM_CAP — it always reconciles with ``total_count``),
    keyed by the same ``surface`` label used on each item
    ("text_metadata" | "verse" | "asset_display_name" |
    "audio_display_name"). Only the "text_metadata" bucket additionally
    carries a ``"fields"`` sub-tally keyed by simplified field name (e.g.
    "description", "island_name") — the other surfaces don't have a
    field-name concept, so they report ``count`` only. This is purely
    additive: ``items``/``total_count``/``omitted_count`` are unchanged so
    nothing downstream breaks.

    Each item: {"surface": str, "field_or_file": str, "char": str,
    "codepoint": "U+XXXX", "name": str (unicodedata.name, "" if
    unavailable), "kind": str, "context_snippet": str}. Never raises —
    any per-surface failure is skipped, not fatal."""
    result = {
        "available": True, "items": [], "total_count": 0, "omitted_count": 0,
        "by_surface": {}, "notes": [],
    }

    def _emit(surface, field_or_file, text, field_name=None):
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

                bucket = result["by_surface"].setdefault(surface, {"count": 0})
                bucket["count"] += 1
                if field_name:
                    fields_bucket = bucket.setdefault("fields", {})
                    fields_bucket[field_name] = fields_bucket.get(field_name, 0) + 1

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
            key_path = f.get("key", "")
            _emit(
                "text_metadata", f"{f.get('file', '')} :: {key_path}", f.get("value", ""),
                field_name=_simplify_field_name(key_path),
            )
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
# 5f. External link / scannable-code risk detection — Rule 1.12 "Keep It on
#     the Island" ("do not include external links anywhere on your island").
#     A real island was REJECTED under this rule for a QR-code image asset
#     whose name literally embedded a chat-platform name plus "_QR" (see
#     ``_EXTERNAL_LINK_QR_TOKEN_RE`` below); this module's other detectors
#     were built around Rule 1.7 (IP) / 1.13 (authenticity) and had ZERO
#     Rule 1.12 coverage before this collector, so that scan reported 0
#     BLOCKER and never surfaced it.
#
#     PURELY STRUCTURAL / BRAND-NEUTRAL, same hard rule as the rest of this
#     module (see "No brand/product wordlists here" above): no platform or
#     brand names, only regex shapes. The domain-shape detector uses an
#     ALLOWLIST of common, generic top-level-domain strings (not a blacklist
#     of code/asset suffixes) deliberately — the space of code-ish suffixes
#     that could collide with a bare "label.tld" shape is unbounded (class
#     names, component suffixes, etc.), but real TLDs are a small, known,
#     brand-neutral set, so allowlisting them is what actually keeps this
#     detector quiet on ordinary UEFN asset names.
# ---------------------------------------------------------------------------

# Common, generic top-level-domain strings (structural allowlist, not brand
# names — ".com"/".io"/".gg" etc. are TLD shapes, not platform identifiers).
# Deliberately conservative: this is what keeps "Foo.Foo" / "BP_Thing.BP_
# Thing_C" / "Material.Instance" (UE's own "Package.AssetName" object-path
# convention) from ever matching — none of those trailing segments happen to
# be a real TLD.
_COMMON_TLDS = (
    "com", "net", "org", "io", "co", "gg", "me", "xyz", "biz", "info",
    "link", "live", "site", "online", "click", "top", "work", "mobi",
    "asia", "tel", "pro", "name", "fm", "ly", "sh", "ws", "cc", "to",
    "tv", "us", "uk", "ca", "de", "fr", "ru", "cn", "jp", "app", "dev",
)

_DOMAIN_LABEL_RE_PART = r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
_DOMAIN_TLD_ALTERNATION = "|".join(_COMMON_TLDS)

_EXTERNAL_LINK_URL_RE = re.compile(r'\bhttps?://[^\s"\'<>)]{3,300}', re.IGNORECASE)
_EXTERNAL_LINK_WWW_RE = re.compile(
    rf"\bwww\.{_DOMAIN_LABEL_RE_PART}(?:\.{_DOMAIN_LABEL_RE_PART})+(?:/[^\s\"'<>)]{{0,120}})?",
    re.IGNORECASE,
)
# "label.tld[/path]" — TLD restricted to the allowlist above, and NOT
# immediately followed by more label characters (so "co" can't match as a
# prefix of "community"/"commercial", etc.).
_EXTERNAL_LINK_DOMAIN_RE = re.compile(
    rf"\b(?:{_DOMAIN_LABEL_RE_PART}\.)+(?:{_DOMAIN_TLD_ALTERNATION})"
    rf"(?![a-zA-Z0-9-])(?:/[^\s\"'<>)]{{0,120}})?",
    re.IGNORECASE,
)
# Short-link / invite shapes: literal "/invite/"|"/i/" path segments, or a
# host+TLD immediately followed by a slug path.
#
# BUG FIX (false BLOCKER — review finding): this used to accept ANY 2-4
# letter suffix before "/slug" instead of the curated _COMMON_TLDS
# allowlist, so ordinary strings like "readme.md/section1" or
# "logo.png/v2" matched as invite_path — and the TS-side guidance treats
# invite_path as BLOCKER-tier. A false blocker is worse than a missed
# detection: it trains the creator to distrust every correct finding this
# tool produces. Now reuses the SAME curated TLD allowlist as the domain
# rule below (deliberately narrower, per that same reasoning — a missed
# short-link is still recoverable via the server-side platform wordlist
# and the import_provenance signal; a false blocker is not).
_EXTERNAL_LINK_INVITE_KEYWORD_RE = re.compile(
    r'(?<![A-Za-z0-9_])/(?:invite|i)/[A-Za-z0-9_-]{2,40}', re.IGNORECASE
)
_EXTERNAL_LINK_SHORT_HOST_SLUG_RE = re.compile(
    rf"\b{_DOMAIN_LABEL_RE_PART}\.(?:{_DOMAIN_TLD_ALTERNATION})/[A-Za-z0-9_-]{{2,24}}\b",
    re.IGNORECASE,
)
# Belt-and-suspenders safety net (review finding): explicit denylist of
# common file/code extensions, checked post-match against BOTH the domain
# and short-host/slug matches below. _COMMON_TLDS is already curated to
# contain none of these, so this should never actually trigger today — it
# exists so a future edit that broadens _COMMON_TLDS without checking for
# extension overlap fails safe (skips the match) instead of silently
# reintroducing false blockers.
#
# FAIL-OPEN BY CONSTRUCTION (not an assert — review finding): the raw list
# has _COMMON_TLDS subtracted out via a set difference, computed once at
# import time, rather than asserted disjoint. An `assert` here would (1)
# vanish entirely under `python -O`, silently dropping the guarantee, and
# (2) if it ever DID fire, raise at MODULE IMPORT time — taking down this
# whole scanner (and every tool that imports it) over one regex, exactly
# the "tool fails to launch" failure mode a prior release already shipped
# a fix for (the tkinter "bad screen distance" crash). A degraded detector
# is acceptable in a pre-submission safety tool; a tool that won't launch
# is not. The subtraction means a future accidental overlap can never make
# a legitimate TLD undetectable (it's removed from the denylist, not left
# to crash on) AND can never raise on import.
_FILE_EXTENSION_DENYLIST_RAW = (
    "md", "txt", "json", "xml", "yaml", "yml", "png", "jpg", "jpeg",
    "gif", "bmp", "svg", "ico", "uasset", "umap", "verse", "py", "js",
    "ts", "cs", "cpp", "h", "hpp", "lua", "ini", "cfg", "log", "dll",
    "exe", "pak", "bin", "dat", "ttf", "otf", "fbx", "obj", "mat",
    "anim", "blend", "uproject", "uplugin", "wav", "ogg", "mp3", "flac",
    "aiff", "wma", "zip", "rar", "csv", "pdf", "doc", "docx",
)
_FILE_EXTENSION_DENYLIST = frozenset(_FILE_EXTENSION_DENYLIST_RAW) - frozenset(_COMMON_TLDS)


def _domain_match_tld(matched_text):
    """Extract the bare TLD-looking segment from a domain/short-host-slug
    regex match (the alpha run right after the LAST '.' and before any
    '/' or end) for the _FILE_EXTENSION_DENYLIST safety check. Never
    raises; returns "" on any failure."""
    try:
        head = matched_text.split("/", 1)[0]
        return head.rsplit(".", 1)[-1].lower()
    except Exception:
        return ""
# "qr" as a whole word/delimiter-bounded segment — the negative lookaround
# treats any non-alnum (including "_"/"-") as a boundary, so a name like
# "<platform>_QR" or "QR_code" matches but "SQRT"/"QRcode" (mid-word) do not.
_EXTERNAL_LINK_QR_TOKEN_RE = re.compile(r'(?<![A-Za-z0-9])QR(?![A-Za-z0-9])', re.IGNORECASE)
_EXTERNAL_LINK_SCAN_ME_RE = re.compile(r'\bscan\s*me\b', re.IGNORECASE)
# "@handle" — only ever scanned against text_metadata/verse text (see
# collect_external_link_risks below), never asset paths, which routinely
# contain "@" in unrelated engine-generated tokens.
_EXTERNAL_LINK_HANDLE_RE = re.compile(r'(?<![A-Za-z0-9_])@[A-Za-z][A-Za-z0-9_]{1,31}\b')


def _scan_text_for_external_link_risks(text, emit, allow_domain_like=True):
    """Scan a single string for url/www/invite_path/domain/scannable_code
    shapes and call ``emit(matched_text, kind)`` for each hit. Never raises.

    url/www/invite_path/domain overlap heavily — a URL like
    "https://example.com/x" also satisfies the bare domain shape, and a
    "hostname.gg/abc123" invite-shaped link also satisfies it once "gg" is
    on the TLD allowlist. Candidates are collected with a priority (url strongest,
    domain weakest) and only the highest-priority, non-overlapping match per
    span is kept, so the same offending text is never reported twice under
    different kinds. scannable_code_token is an independent signal category
    and is always checked regardless of overlap with the link-shaped group.

    ``allow_domain_like=False`` skips invite_path/domain detection entirely
    — used for UE's own "PackagePath.AssetName" object-path strings, which
    structurally look exactly like a bare domain (see the "5f." section
    docstring above) and would otherwise be the dominant false-positive
    source. url/www/scannable_code_token are still checked on that surface
    since those shapes don't collide with UE's path convention.
    """
    if not text:
        return
    try:
        text = str(text)
    except Exception:
        return
    try:
        candidates = []
        for m in _EXTERNAL_LINK_URL_RE.finditer(text):
            candidates.append((m.start(), m.end(), "url", m.group(0), 0))
        for m in _EXTERNAL_LINK_WWW_RE.finditer(text):
            candidates.append((m.start(), m.end(), "www", m.group(0), 1))
        if allow_domain_like:
            for m in _EXTERNAL_LINK_INVITE_KEYWORD_RE.finditer(text):
                candidates.append((m.start(), m.end(), "invite_path", m.group(0), 2))
            for m in _EXTERNAL_LINK_SHORT_HOST_SLUG_RE.finditer(text):
                if _domain_match_tld(m.group(0)) in _FILE_EXTENSION_DENYLIST:
                    continue
                candidates.append((m.start(), m.end(), "invite_path", m.group(0), 2))
            for m in _EXTERNAL_LINK_DOMAIN_RE.finditer(text):
                if _domain_match_tld(m.group(0)) in _FILE_EXTENSION_DENYLIST:
                    continue
                candidates.append((m.start(), m.end(), "domain", m.group(0), 3))
        candidates.sort(key=lambda c: (c[4], -(c[1] - c[0]), c[0]))
        accepted = []
        for s, e, kind, txt, _priority in candidates:
            if any(not (e <= a_s or s >= a_e) for a_s, a_e, _k, _t in accepted):
                continue
            accepted.append((s, e, kind, txt))
        for _s, _e, kind, txt in accepted:
            emit(txt, kind)

        for m in _EXTERNAL_LINK_QR_TOKEN_RE.finditer(text):
            emit(m.group(0), "scannable_code_token")
        for m in _EXTERNAL_LINK_SCAN_ME_RE.finditer(text):
            emit(m.group(0), "scannable_code_token")
    except Exception:
        pass


def collect_external_link_risks(asset_surfaces, verse_surfaces, text_metadata, image_paths, audio_surfaces):
    """Scan every already-collected TEXT surface — asset display names and
    package/object paths (``asset_surfaces``, from ``collect_asset_surfaces``'s
    ``project_assets``), Verse string/comment/label text (``verse_surfaces``),
    text metadata field values (``text_metadata``, from
    ``collect_text_metadata``), image file names (``image_paths``, from
    ``collect_image_metadata``), and audio display names (``audio_surfaces``,
    from ``collect_audio_surfaces``) — for Rule 1.12 "Keep It on the Island"
    (external link) risk shapes: bare URLs, "www." hosts, bare domain-shaped
    tokens, short-link/invite paths, "QR"/"scan me" scannable-code tokens,
    and "@handle" tokens (the last only in text_metadata/verse text — see
    ``_EXTERNAL_LINK_HANDLE_RE``'s comment). Does NOT re-walk the
    filesystem; every surface here is reused from collectors that already
    ran earlier in ``run_moderation_scan``.

    Returns:
        {"total_count": int (exact, NEVER capped/sampled — see
         run_moderation_scan's max_items handling, which explicitly exempts
         this collector's items the same way it already exempts
         text_metadata.fields and redirectors.redirectors),
         "items": [{"surface": "asset_name"|"asset_path"|"verse"|
                     "text_metadata"|"image_filename"|"audio_name",
                    "location": str, "text": str (truncated to 300 chars),
                    "kind": "url"|"www"|"domain"|"invite_path"|
                            "scannable_code_token"|"handle"}, ...],
         "by_surface": {surface: count, ...},
         "note": str}

    ``note`` is an unconditional, honest vision caveat (see below) — never
    omitted, and never implied-clean by an empty ``items`` list. Never
    raises; any per-surface failure is skipped, not fatal.
    """
    result = {"total_count": 0, "items": [], "by_surface": {}, "note": ""}

    def _emit(surface, location, text, kind):
        try:
            result["total_count"] += 1
            result["by_surface"][surface] = result["by_surface"].get(surface, 0) + 1
            result["items"].append({
                "surface": surface,
                "location": str(location)[:500],
                "text": str(text)[:300],
                "kind": kind,
            })
        except Exception:
            pass

    try:
        for a in asset_surfaces or []:
            path = a.get("object_path") or a.get("package_name", "")
            _scan_text_for_external_link_risks(
                a.get("display_name", ""),
                lambda t, k, _loc=path: _emit("asset_name", _loc, t, k),
                allow_domain_like=True,
            )
            # object_path/package_path is UE's own "Package.AssetName"
            # convention — structurally a false-positive magnet for
            # domain/invite_path shapes (see the "5f." section docstring),
            # so those two kinds are skipped here; url/www/QR are still safe.
            _scan_text_for_external_link_risks(
                path,
                lambda t, k, _loc=path: _emit("asset_path", _loc, t, k),
                allow_domain_like=False,
            )
    except Exception:
        pass

    try:
        for s in verse_surfaces or []:
            loc = f"{s.get('file', '')}:{s.get('line', '')}"
            text = s.get("text", "")
            _scan_text_for_external_link_risks(
                text, lambda t, k, _loc=loc: _emit("verse", _loc, t, k), allow_domain_like=True,
            )
            for m in _EXTERNAL_LINK_HANDLE_RE.finditer(str(text or "")):
                _emit("verse", loc, m.group(0), "handle")
    except Exception:
        pass

    try:
        for f in (text_metadata or {}).get("fields") or []:
            loc = f"{f.get('file', '')} :: {f.get('key', '')}"
            value = f.get("value", "")
            _scan_text_for_external_link_risks(
                value, lambda t, k, _loc=loc: _emit("text_metadata", _loc, t, k), allow_domain_like=True,
            )
            for m in _EXTERNAL_LINK_HANDLE_RE.finditer(str(value or "")):
                _emit("text_metadata", loc, m.group(0), "handle")
    except Exception:
        pass

    try:
        for p in image_paths or []:
            fn = os.path.basename(str(p))
            _scan_text_for_external_link_risks(
                fn, lambda t, k, _loc=p: _emit("image_filename", _loc, t, k), allow_domain_like=True,
            )
    except Exception:
        pass

    try:
        for a in (audio_surfaces or {}).get("audio") or []:
            loc = a.get("package_name") or a.get("package_path", "")
            _scan_text_for_external_link_risks(
                a.get("display_name", ""),
                lambda t, k, _loc=loc: _emit("audio_name", _loc, t, k),
                allow_domain_like=True,
            )
    except Exception:
        pass

    result["note"] = (
        "This scanner is stdlib-only and still cannot decode an arbitrary "
        "image's PIXELS at scale — it cannot read a QR code or URL baked "
        "into a large scene texture or billboard, only filenames and "
        "embedded text metadata (see collect_image_metadata). For the "
        "SUSPECT assets identified elsewhere in this scan (import_provenance "
        "external_user_dir/outside_project hits, this collector's own hits, "
        "and small square UI-shaped textures), run_moderation_scan now also "
        "extracts each one's embedded editor thumbnail JPEG (see "
        "extract_asset_thumbnails) and adds it to image_paths — the "
        "connected assistant's VISION can inspect those directly. That "
        "coverage is narrow and targeted (hard-capped, never a full-registry "
        "walk), so an EMPTY items list here is STILL NOT proof the island "
        "has no external links (Rule 1.12 'Keep It on the Island') — only "
        "that none were found in the surfaces this scan can read as text, "
        "plus whatever the extracted suspect thumbnails show visually."
    )
    return result


# ---------------------------------------------------------------------------
# 5g. Import provenance — Rule 1.7/1.12's strongest predictor: an asset
#     IMPORTED FROM OUTSIDE the project tree, especially a user-profile
#     Downloads/Desktop/Temp folder. The real case this was built from: a
#     QR-code image asset whose AssetImportData recorded a source path many
#     directories above the project, ending in a Downloads folder — this
#     module previously never looked at import provenance at all.
#
#     PURELY STRUCTURAL / BRAND-NEUTRAL: classification below is regex/
#     substring shape matching on the RECORDED SOURCE PATH (a user-profile
#     folder segment, or "how far outside the project tree the path
#     reaches") — never a brand/platform name.
# ---------------------------------------------------------------------------

_IMPORT_SOURCE_USER_DIR_MARKERS = ("/downloads/", "/desktop/", "/temp/", "/tmp/", "appdata")
# A relative RelativeFilename path (as recorded by UE, e.g. "../../Content/
# Textures/Foo.png") that climbs this many "../" levels or more almost
# certainly started somewhere far outside the project tree entirely — a
# shallow climb is a normal project-relative import.
_IMPORT_SOURCE_DEEP_CLIMB_THRESHOLD = 3


def _classify_import_source_path(source_path, project_dir):
    """Brand-neutral, structural classification of a single asset's
    recorded import source path (``AssetImportData``'s ``RelativeFilename``,
    which is typically relative to the imported .uasset's own location on
    disk and can walk many directories upward via ``../`` segments — the
    real example this was built from: a path ending in
    ``.../Users/<name>/Downloads/<name>.png``).

    Returns one of:
      * "external_user_dir" — TOP PRIORITY: a user-profile download/
        desktop/temp/appdata folder segment appears anywhere in the path.
        Checked FIRST, before any project-tree resolution, since this is
        the single strongest predictor regardless of anything else.
      * "outside_project" — an absolute path that does not resolve inside
        ``project_dir``, or a relative path climbing
        ``_IMPORT_SOURCE_DEEP_CLIMB_THRESHOLD`` or more ``../`` levels.
      * "in_project" — resolves inside ``project_dir``, or a shallow
        relative climb.
      * "unknown" — no source path given at all (engine-generated asset or
        one created directly in-editor, never imported from a file).

    Never raises."""
    if not source_path:
        return "unknown"
    try:
        p = str(source_path).replace("\\", "/")
        p_lower = p.lower()
        for marker in _IMPORT_SOURCE_USER_DIR_MARKERS:
            if marker in p_lower:
                return "external_user_dir"

        if os.path.isabs(p):
            if project_dir:
                try:
                    proj_norm = os.path.normpath(str(project_dir)).replace("\\", "/").lower()
                    abs_norm = os.path.normpath(p).replace("\\", "/").lower()
                    if abs_norm.startswith(proj_norm):
                        return "in_project"
                except Exception:
                    pass
            return "outside_project"

        up_count = p.split("/").count("..")
        return "outside_project" if up_count >= _IMPORT_SOURCE_DEEP_CLIMB_THRESHOLD else "in_project"
    except Exception:
        return "unknown"


def collect_import_provenance(import_source_records, project_dir, total_non_engine_assets=None):
    """Classify the raw ``AssetImportData`` records already extracted by
    ``collect_asset_surfaces`` (its uncapped ``import_source_records`` —
    every non-engine asset in BOTH the project and shared-mount buckets
    that actually carried import data, gathered before either bucket's
    detail list was capped, mirroring the existing HLOD/external-actor
    pattern). Does not touch ``unreal`` itself — pure classification over
    already-collected data, same house style as ``collect_unicode_risks``/
    ``collect_external_link_risks``.

    Returns:
        {"total_imported_assets": int (count of records classified, i.e.
         assets that had ANY import data — NOT the full registry count),
         "items": [{"object_path", "display_name", "source_path",
                    "classification": "external_user_dir"|"outside_project",
                    "file_md5", "timestamp"}, ...]  # external_user_dir /
                    outside_project ONLY — NEVER capped or sampled (see
                    run_moderation_scan's max_items handling, which
                    explicitly exempts this the same way it already exempts
                    text_metadata.fields/redirectors.redirectors/
                    external_link_risks.items),
         "by_classification": {"external_user_dir": int, "outside_project":
                    int, "in_project": int, "unknown": int (only present
                    when total_non_engine_assets is given — see below)},
         "note": str}

    ``in_project``/``unknown`` classifications are counted in
    ``by_classification`` only — never listed individually in ``items``,
    since they're low-interest (in_project) or not evidence of anything
    (unknown just means no import data). ``total_non_engine_assets``, when
    given, lets ``unknown`` be computed honestly as "every non-engine asset
    that did NOT appear in import_source_records at all" rather than being
    silently omitted from the tally.

    Never raises; any per-record failure is skipped, not fatal."""
    result = {"total_imported_assets": 0, "items": [], "by_classification": {}, "note": ""}
    try:
        for rec in import_source_records or []:
            try:
                src = rec.get("source_path", "")
                classification = _classify_import_source_path(src, project_dir)
                result["total_imported_assets"] += 1
                result["by_classification"][classification] = (
                    result["by_classification"].get(classification, 0) + 1
                )
                if classification in ("external_user_dir", "outside_project"):
                    result["items"].append({
                        "object_path": rec.get("object_path", ""),
                        "display_name": rec.get("display_name", ""),
                        "source_path": src,
                        "classification": classification,
                        "file_md5": rec.get("file_md5", ""),
                        "timestamp": rec.get("timestamp", ""),
                    })
            except Exception:
                continue
    except Exception:
        pass

    if total_non_engine_assets is not None:
        try:
            unknown = max(0, int(total_non_engine_assets) - result["total_imported_assets"])
            if unknown:
                result["by_classification"]["unknown"] = unknown
        except Exception:
            pass

    result["note"] = (
        "An asset imported from OUTSIDE the project tree — especially a "
        "user-profile Downloads/Desktop/Temp/AppData folder — is the "
        "strongest available predictor of both Rule 1.7 (IP) and Rule 1.12 "
        "(external link) risk this scanner has: the real case this "
        "detector was built from was a QR-code image imported straight "
        "from a Downloads folder. source_path values below may contain the "
        "creator's OWN OS username — this is the creator's own machine and "
        "this report goes to their own connected assistant, so it is kept "
        "as-is, not redacted. Only external_user_dir/outside_project hits "
        "are listed individually in items (NEVER capped or sampled); "
        "in_project/unknown assets are counted only, see by_classification."
    )
    return result


# ---------------------------------------------------------------------------
# 5h. Embedded thumbnail extraction — closes the "cannot decode pixels"
#     vision gap for a SMALL, TARGETED suspect set (never a full-registry
#     walk). UE stores a JPEG-encoded editor thumbnail inside every
#     .uasset's binary payload; this reads it with plain byte-span search
#     (stdlib only, no Pillow, no actual JPEG decoding) so the connected
#     LLM's own vision can inspect the extracted image directly.
# ---------------------------------------------------------------------------

_JPEG_SOI = b"\xff\xd8\xff"
_JPEG_EOI = b"\xff\xd9"
_THUMBNAIL_MIN_BYTES = 1024               # 1 KB — smaller is not a real thumbnail
_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024    # 2 MB — larger is implausible for a thumbnail
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_.-]")

# BUG FIX (unbounded per-file read): extract_asset_thumbnails' suspects
# include import_provenance hits, which can be ANY asset class — an
# imported mesh/audio/video asset can be very large, and a naive whole-file
# read could spike memory inside the editor process even though the number
# of ATTEMPTS is already hard-capped at max_thumbnails. Two bounds fix this:
_THUMBNAIL_SOURCE_MAX_FILE_BYTES = 200 * 1024 * 1024
# ^ Hard ceiling — a suspect .uasset larger than this is skipped ENTIRELY
# (no read at all, not even the bounded tail window below); counted via
# "skipped_too_large" so the omission is visible, never silent.
_THUMBNAIL_TAIL_WINDOW_BYTES = 8 * 1024 * 1024
# ^ The ONLY window actually read from disk for files at or under the hard
# ceiling: UE appends the embedded editor thumbnail near the END of a
# .uasset's binary payload (see _extract_last_jpeg_span), so seeking to the
# tail and reading only this window is sufficient — it's 4x
# _THUMBNAIL_MAX_BYTES (the largest a real thumbnail is expected to be), so
# a genuine trailing thumbnail is never truncated by this window.


def _extract_last_jpeg_span(data):
    """Find the LAST embedded JPEG (SOI ``\\xff\\xd8\\xff`` ... EOI
    ``\\xff\\xd9``) byte span in ``data``. UE appends the editor thumbnail
    near the end of a .uasset's binary payload, and a .uasset can
    coincidentally contain earlier JPEG-marker-shaped byte runs inside
    compressed texture/mesh data, so searching from the END for the last
    EOI, then the last SOI before it, is the reliable way to land on the
    actual thumbnail rather than a false byte-run elsewhere in the file.

    stdlib-only — does not decode or validate the JPEG beyond finding its
    markers and a plausible size. Returns the raw byte span, or None if no
    span was found or its size fails the sanity check (too small to be a
    real thumbnail, or implausibly large). Never raises."""
    try:
        eoi = data.rfind(_JPEG_EOI)
        if eoi == -1:
            return None
        soi = data.rfind(_JPEG_SOI, 0, eoi)
        if soi == -1:
            return None
        span = data[soi:eoi + 2]
        if len(span) < _THUMBNAIL_MIN_BYTES or len(span) > _THUMBNAIL_MAX_BYTES:
            return None
        return span
    except Exception:
        return None


def _package_name_to_uasset_path(package_name, project_dir, mount_prefix):
    """Best-effort mapping of a UE package name (e.g.
    ``"/MyIsland/UI/ScoreBoard/some_asset"``) to its .uasset file on disk,
    using the same mount-prefix-to-``Content/`` convention every other
    filesystem collector in this module assumes. Returns None if inputs are
    missing or the mapping fails. Never raises — callers must still check
    the result exists on disk (a package can be a redirector, memory-only,
    or simply moved)."""
    if not package_name or not project_dir:
        return None
    try:
        rel = str(package_name)
        if mount_prefix and rel.startswith(mount_prefix):
            rel = rel[len(mount_prefix):]
        else:
            rel = rel.lstrip("/")
        rel = rel.replace("/", os.sep)
        return os.path.join(str(project_dir), "Content", rel + ".uasset")
    except Exception:
        return None


def extract_asset_thumbnails(suspect_entries, out_dir, max_thumbnails=40,
                              project_dir=None, mount_prefix=None):
    """Given ``suspect_entries`` (asset-surface-shaped dicts with at least
    ``object_path``/``package_name``/``display_name``), resolve each one's
    .uasset on disk and extract its embedded editor JPEG thumbnail (see
    ``_extract_last_jpeg_span``) into ``out_dir``. Callers pass ONLY their
    highest-suspicion subset — ``import_provenance``'s external_user_dir/
    outside_project hits, ``external_link_risks`` hits, and small
    roughly-square UI-shaped textures (see
    ``collect_asset_surfaces``'s ``small_square_ui_texture_entries``) — this
    function itself does no registry walking and is HARD-CAPPED at
    ``max_thumbnails`` (default 40): it must never process the full
    registry.

    ``project_dir``/``mount_prefix`` default to the live-resolved scan root
    and project mount (via ``_resolve_project_dir``/``_resolve_project_mount``)
    when not given, so this also works called standalone.

    BOUNDED READ (BUG FIX — unbounded per-file read): suspects can be ANY
    asset class, including an imported mesh/audio/video asset that happens
    to be very large, so this never reads a whole file into memory. A file
    over ``_THUMBNAIL_SOURCE_MAX_FILE_BYTES`` (200 MB) is skipped entirely
    (counted via ``skipped_too_large``, never silently); otherwise only the
    last ``_THUMBNAIL_TAIL_WINDOW_BYTES`` (8 MB) of the file is read via a
    seek-from-end, since UE appends the embedded thumbnail near the file's
    end and 8 MB comfortably exceeds any real thumbnail's max plausible
    size (``_THUMBNAIL_MAX_BYTES``, 2 MB).

    Returns {"written_paths": [...], "attempted": int, "extracted": int,
    "skipped_not_found": int, "skipped_too_large": int, "skipped_no_jpeg":
    int, "suspects_not_extracted": int, "notes": [...]}. Never raises — a
    single unreadable/unresolvable/oversized/undersized asset is skipped,
    not fatal."""
    result = {
        "written_paths": [], "attempted": 0, "extracted": 0,
        "skipped_not_found": 0, "skipped_too_large": 0, "skipped_no_jpeg": 0,
        "suspects_not_extracted": 0, "notes": [],
    }
    entries = list(suspect_entries or [])
    if len(entries) > max_thumbnails:
        result["suspects_not_extracted"] = len(entries) - max_thumbnails
        entries = entries[:max_thumbnails]

    if project_dir is None or mount_prefix is None:
        try:
            resolved_dir, _verified, _source = _resolve_project_dir()
        except Exception:
            resolved_dir = None
        try:
            resolved_mount, _msource, _mconfirmed = _resolve_project_mount(project_dir or resolved_dir)
        except Exception:
            resolved_mount = None
        project_dir = project_dir or resolved_dir
        mount_prefix = mount_prefix or resolved_mount

    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:
        result["notes"].append(f"could not create thumbnail output dir: {e}")
        return result

    for entry in entries:
        result["attempted"] += 1
        try:
            package_name = entry.get("package_name") or (entry.get("object_path", "") or "").split(".")[0]
        except Exception:
            package_name = None
        uasset_path = _package_name_to_uasset_path(package_name, project_dir, mount_prefix)
        if not uasset_path or not os.path.isfile(uasset_path):
            result["skipped_not_found"] += 1
            continue
        try:
            file_size = os.path.getsize(uasset_path)
        except Exception:
            result["skipped_not_found"] += 1
            continue
        if file_size > _THUMBNAIL_SOURCE_MAX_FILE_BYTES:
            result["skipped_too_large"] += 1
            continue
        try:
            with open(uasset_path, "rb") as f:
                if file_size > _THUMBNAIL_TAIL_WINDOW_BYTES:
                    # Bounded tail read only — never the whole file (see
                    # _THUMBNAIL_TAIL_WINDOW_BYTES's docstring above).
                    f.seek(-_THUMBNAIL_TAIL_WINDOW_BYTES, os.SEEK_END)
                data = f.read()
        except Exception:
            result["skipped_not_found"] += 1
            continue
        span = _extract_last_jpeg_span(data)
        if not span:
            result["skipped_no_jpeg"] += 1
            continue
        try:
            safe_name = _SAFE_FILENAME_RE.sub("_", entry.get("display_name") or os.path.basename(uasset_path))
            out_path = os.path.join(out_dir, f"{safe_name}_thumb.jpg")
            with open(out_path, "wb") as wf:
                wf.write(span)
            result["written_paths"].append(out_path)
            result["extracted"] += 1
        except Exception:
            continue

    note = (
        f"Extracted {result['extracted']} of {result['attempted']} attempted "
        f"suspect thumbnail(s) ({result['skipped_not_found']} asset file not "
        f"found/unreadable on disk, {result['skipped_too_large']} skipped for "
        f"exceeding the {_THUMBNAIL_SOURCE_MAX_FILE_BYTES // (1024 * 1024)}MB "
        f"size ceiling, {result['skipped_no_jpeg']} had no valid-sized "
        "embedded JPEG in the read window)."
    )
    if result["suspects_not_extracted"]:
        note += (
            f" {result['suspects_not_extracted']} additional suspect(s) were "
            f"NOT attempted (hard-capped at {max_thumbnails})."
        )
    result["notes"].append(note)
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

def _is_hlod_or_external_entry(entry):
    """True if an asset entry (from ``collect_asset_surfaces()``) is a HLOD
    or generated External Actor/Object package — both AUTO-GENERATED per
    streaming cell, not human-authored/imported content. Used only to
    DEMOTE such entries to the back of a ``max_items`` transport cap (see
    ``_asset_cap_priority_tier``/``_cap_items_with_priority`` below); it
    never filters/drops anything on its own.

    BUG FIX (priority inversion): earlier versions of this module
    PRIORITIZED these entries INTO the sample. On a real 48,412-asset
    project only ~200 items survived the cap and exactly ONE name was
    legible, because HLOD proxies are bulk engine-generated noise per
    streaming cell that crowded out every human-made asset name. HLOD/
    external-actor entries are now DEMOTED to last — see
    ``_asset_cap_priority_tier``."""
    try:
        haystack = (
            str(entry.get("package_path", "")) + " " + str(entry.get("package_name", ""))
        ).upper()
    except Exception:
        return False
    return (
        "HLOD" in haystack
        or "__EXTERNALACTORS__" in haystack
        or "__EXTERNALOBJECTS__" in haystack
    )


def _make_asset_cap_priority_tier_fn(import_risk_object_paths, external_link_asset_locations):
    """Build a ``priority_key`` function (lower tier number = kept FIRST
    under a ``max_items`` cap) for asset-surface entries, replacing the
    old binary "HLOD first" priority with a 4-tier "human-authored/
    imported first, engine-generated last" ordering:

      0 = ``import_provenance`` hit (external_user_dir/outside_project) —
          the strongest signal this scanner has, always first.
      1 = ``external_link_risks`` hit on this same asset.
      2 = ordinary project-mount asset with no auto-generated marker.
      3 = DEMOTED — auto-generated HLOD proxy or External Actor/Object
          package (see ``_is_hlod_or_external_entry``'s docstring for why).

    ``import_risk_object_paths``/``external_link_asset_locations`` are sets
    of ``object_path`` strings built from ``result["import_provenance"]
    ["items"]``/``result["external_link_risks"]["items"]`` — both already
    computed earlier in ``run_moderation_scan`` by the time this runs.
    Never raises (falls back to tier 2 on any lookup failure)."""
    def _tier(entry):
        try:
            obj_path = entry.get("object_path") or entry.get("package_name", "")
        except Exception:
            return 2
        try:
            if obj_path in import_risk_object_paths:
                return 0
            if obj_path in external_link_asset_locations:
                return 1
            if _is_hlod_or_external_entry(entry):
                return 3
        except Exception:
            return 2
        return 2
    return _tier


def _cap_items_with_priority(items, max_items, is_priority=None, priority_key=None):
    """Bound a list to at most ``max_items`` entries for MCP transport,
    honestly — never a silent drop.

    Returns ``(capped_list, kept_count, omitted_count, full_count)``.

    When ``max_items`` is None or the list already fits, the list is
    returned unchanged (``omitted_count`` 0). Otherwise:
      * ``priority_key(item)`` (preferred when given) — a function
        returning an int TIER, lower = kept first. Items are stably sorted
        by tier (``sorted()`` is stable, so original relative order is
        preserved within each tier) before slicing — supports more than
        two priority levels (see ``_make_asset_cap_priority_tier_fn``).
      * ``is_priority(item)`` — legacy binary form: entries it accepts move
        to the front via a stable partition. Ignored if ``priority_key`` is
        also given.
      * Neither — entries are kept in their existing order (a plain
        positional sample).

    Never raises — on any error, degrades to returning the input
    unchanged rather than losing data."""
    try:
        items = list(items or [])
    except Exception:
        return items, 0, 0, 0
    full_count = len(items)
    if max_items is None or full_count <= max_items:
        return items, full_count, 0, full_count
    if priority_key is not None:
        try:
            ordered = sorted(items, key=priority_key)
        except Exception:
            ordered = items
    elif is_priority is not None:
        try:
            priority = [it for it in items if is_priority(it)]
            rest = [it for it in items if not is_priority(it)]
            ordered = priority + rest
        except Exception:
            ordered = items
    else:
        ordered = items
    capped = ordered[:max_items]
    return capped, len(capped), full_count - len(capped), full_count


def run_moderation_scan(project_dir=None, include_hashes=False, max_items=None):
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
          "external_link_risks": {...},     # Rule 1.12 "Keep It on the Island" hits
          "import_provenance": {...},       # AssetImportData source-path risk (1.7/1.12)
          "hlod_generated_count": int,      # exact, uncapped HLOD-only count
          "extracted_thumbnails": {...},    # embedded-JPEG extraction for suspect assets
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

    ``external_link_risks`` is a SIXTH, separately-motivated deterministic
    BRAND-NEUTRAL detection covering Rule 1.12 "Keep It on the Island" (no
    external links anywhere on the island) rather than Rule 1.7 — a real
    island was rejected under 1.12 for a QR-code image asset whose name
    literally embedded a chat-platform name plus "_QR", which this module's
    other detectors had zero coverage for. See
    ``collect_external_link_risks``'s own docstring,
    including its unconditional "cannot decode image pixels" vision caveat
    (``external_link_risks["note"]``) — an empty ``items`` list there is
    NEVER evidence of "no external links found".

    ``import_provenance`` is a SEVENTH detection, and the single strongest
    predictor either rule has: WHERE an asset was imported FROM (its
    ``AssetImportData`` source path), not just what it's named. The exact
    real asset that motivated ``external_link_risks`` also had a recorded
    import source path many directories above the project, ending in a
    user-profile Downloads folder — see ``collect_import_provenance``'s own
    docstring. ``hlod_generated_count`` is the exact, uncapped count of
    auto-generated HLOD proxy assets (see ``_is_hlod_or_external_entry``'s
    docstring for why these are deprioritized, not hidden, in transport
    sampling below). ``extracted_thumbnails`` records the outcome of
    extracting embedded editor JPEG thumbnails (see
    ``extract_asset_thumbnails``) for the highest-suspicion assets —
    ``import_provenance``/``external_link_risks`` hits plus small square
    UI-shaped textures — and the extracted file paths are also appended
    into this dict's own ``image_paths`` so a connected LLM's vision can
    inspect them directly; this is a narrow, hard-capped addition, not a
    claim that every image on the island has now been visually reviewed.

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

    ``max_items`` (default None) — bounds every returned LIST to at most
    this many entries, for transport over the MCP bridge (a full sweep on
    a large project can produce a result whose serialized JSON is tens of
    MB, which drops the stdio connection — see uefn_bridge.py's
    ``_handle_moderation_scan``, the only caller that passes a non-None
    value; ``show_moderation_scan()``'s in-process launcher path always
    calls this with ``max_items=None`` and is completely unaffected).
    When set, capping is HONEST per this module's existing doctrine: every
    top-level COUNT (``total_registry_assets``, ``project_asset_count``,
    ``shared_game_mount_asset_count``, ``unicode_risks.total_count``, etc.)
    stays exact and uncapped — only list bodies are sampled, and each
    capped list gets a matching ``<key>_omitted_count`` field (or, for
    nested dicts, ``items_omitted_count``/``audio_omitted_count``)
    recording exactly how many entries were left out. Capping also
    PRIORITIZES which entries survive, via ``_cap_items_with_priority``:
      * ``unicode_risks.items`` — ``text_metadata`` surface hits first
        (those are what Fortnite's moderation metadata stage actually
        reads), then every other surface.
      * ``asset_surfaces`` / ``hlod_or_imported_assets`` — a 4-TIER
        priority (BUG FIX — priority inversion, see
        ``_is_hlod_or_external_entry``'s docstring): (0) ``import_provenance``
        hits, (1) ``external_link_risks`` hits, (2) ordinary project assets
        with no auto-generated marker, (3) DEMOTED — HLOD proxies and
        External Actor/Object packages. The OLD behavior put HLOD first,
        which is exactly backwards: HLOD is engine-generated bulk noise per
        streaming cell, and on the real 48,412-asset project that motivated
        this fix, only ~200 items survived the old cap and exactly ONE name
        was legible — every human-authored asset had been crowded out.
      * ``shared_game_mount_assets`` — SCOPED BEHIND project_assets (BUG
        FIX — sampling scope, per the user's explicit "scan only what I
        control" request): its effective budget is
        ``max(0, max_items - <asset_surfaces entries actually kept>)``, so
        the shared/base mount only spends whatever sample budget the
        project's own assets didn't use. Capped against its TRUE total
        (``shared_game_mount_asset_count``) either way — the reconciliation
        total (project + shared + engine == total_registry_assets) still
        balances; only which BODIES are returned changes.
      * ``external_actor_assets`` uses the SAME 4-tier priority as
        ``asset_surfaces``/``hlod_or_imported_assets`` above (it's still an
        asset-surface-shaped list, just pre-filtered to External Actor/
        Object packages). ``verse_surfaces``, ``image_metadata``,
        ``audio_surfaces.audio`` are plain positional samples; the count is
        what matters there, not which entries. ``image_paths`` prioritizes
        newly-extracted suspect thumbnails (see below) so a cap can't drop
        the very images added to close the vision gap.
      * ``text_metadata.fields``, ``redirectors.redirectors``,
        ``external_link_risks.items``, and ``import_provenance.items`` are
        NEVER capped — all four are typically tiny (2, 5, a small handful,
        and dozens at most, respectively — import_provenance's items are
        already filtered down to just external_user_dir/outside_project
        hits before this point) and are the most directly actionable
        evidence, so sampling any of them away would hide exactly what a
        human/LLM needs to act on. Only ~200 of 48,412 assets survived
        sampling on the real project that motivated these fixes, so any of
        these being sampled would have missed the offending asset entirely
        — every hit must reach the assistant.
    When any list is actually sampled this way, ``result["truncated"]``
    is set True, ``"sampled_for_transport"`` is added to
    ``truncated_collectors``, and a prominent note is added stating the
    payload was sampled for transport and that the counts remain
    authoritative — callers must report counts confidently and never
    imply every listed item was seen.

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
    passing through ``params.get("project_dir")``,
    ``params.get("include_hashes", False)``, and a sane default
    ``max_items`` (200, overridable via ``params.get("max_items")``) so the
    MCP path never returns an untransportable multi-ten-MB payload. This
    module never imports/touches ``uefn_bridge.py`` — it's designed to be
    pulled in from there, not the reverse. All collectors are side-effect-
    free (read-only) and safe to call from any thread/tick context UEFN's
    bridge dispatch uses.

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
        "shared_game_mount_assets_omitted_count": 0,
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
        "external_link_risks": {},
        "import_provenance": {},
        "hlod_generated_count": 0,
        "extracted_thumbnails": {},
        "notes": notes,
        "truncated": truncated,
        "truncated_collectors": truncated_collectors,
    }

    asset_result = {}
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
        result["shared_game_mount_assets_omitted_count"] = asset_result.get(
            "shared_game_mount_assets_omitted_count", 0
        )
        result["hlod_generated_count"] = asset_result.get("hlod_generated_count", 0)
        if result["hlod_generated_count"]:
            notes.append(
                f"{result['hlod_generated_count']} HLOD proxy asset(s) detected — "
                "these are AUTO-GENERATED per streaming cell, so a large count is "
                "EXPECTED and is NOT itself a finding. They are deprioritized "
                "(not hidden — see hlod_generated_count for the exact, uncapped "
                "count) in any max_items transport sampling below, since bulk "
                "engine-generated entries would otherwise crowd out human-"
                "authored/imported assets in a capped sample."
            )
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

    # SCOPE CAVEAT (unconditional — real user misread this, see
    # _format_compact_summary's matching caveat): every text-metadata
    # finding above (text_metadata, unicode_risks.by_surface["text_metadata"],
    # text_field_lengths) covers ONLY text stored in the PROJECT FILES on
    # disk. The island title/description/loading-screen text a creator
    # enters through the publishing portal at submission time is NOT
    # present in the project on disk and is therefore NOT visible to this
    # scan at all — it must be checked separately. An absence of findings
    # in project-file text metadata is NOT evidence that the submitted
    # text is clean.
    notes.append(
        "SCOPE: text-metadata findings above cover only text stored in the "
        "PROJECT FILES on disk. The island title/description/loading-screen "
        "text submitted through the publishing portal is entered separately "
        "and is NOT visible to this scan — check it separately. An absence "
        "of findings here is NOT evidence that the submitted text is clean."
    )

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

    try:
        result["external_link_risks"] = collect_external_link_risks(
            result.get("asset_surfaces"),
            result.get("verse_surfaces"),
            result.get("text_metadata"),
            result.get("image_paths"),
            result.get("audio_surfaces"),
        )
        _link_hits = result["external_link_risks"].get("total_count") or 0
        if _link_hits:
            notes.append(
                f"RULE 1.12 'KEEP IT ON THE ISLAND': {_link_hits} external-link/"
                "scannable-code risk hit(s) found — see external_link_risks "
                "(never sampled/capped, see max_items handling above)."
            )
        else:
            notes.append(
                "external_link_risks: no structural hits found in the scanned "
                "surfaces — see external_link_risks.note: this scanner cannot "
                "decode image pixels, so a QR code or URL embedded in a "
                "texture with an innocuous filename is invisible to it. A "
                "zero here is NOT proof the island has no external links."
            )
    except Exception as e:
        notes.append(f"collect_external_link_risks failed: {e}")
        result["external_link_risks"] = {
            "total_count": 0, "items": [], "by_surface": {},
            "note": f"collector failed: {e}",
        }

    try:
        result["import_provenance"] = collect_import_provenance(
            asset_result.get("import_source_records"),
            scan_root,
            total_non_engine_assets=(
                asset_result.get("project_asset_count", 0)
                + asset_result.get("shared_game_mount_asset_count", 0)
            ),
        )
        _import_risk_hits = len(result["import_provenance"].get("items") or [])
        if _import_risk_hits:
            notes.append(
                f"IMPORT PROVENANCE: {_import_risk_hits} asset(s) imported from "
                "OUTSIDE the project tree (see import_provenance.items, never "
                "sampled/capped) — the strongest available predictor of Rule "
                "1.7/1.12 risk this scanner has."
            )
    except Exception as e:
        notes.append(f"collect_import_provenance failed: {e}")
        result["import_provenance"] = {
            "total_imported_assets": 0, "items": [], "by_classification": {},
            "note": f"collector failed: {e}",
        }

    # Embedded-thumbnail extraction — narrow, hard-capped suspect set only
    # (import_provenance/external_link_risks hits + small square UI-shaped
    # textures), never a full-registry walk. See extract_asset_thumbnails.
    try:
        _suspect_entries = []
        _suspect_seen_keys = set()

        def _add_suspect(entry_like):
            try:
                key = (
                    entry_like.get("object_path")
                    or entry_like.get("package_name")
                    or entry_like.get("location")
                )
            except Exception:
                key = None
            if not key or key in _suspect_seen_keys:
                return
            _suspect_seen_keys.add(key)
            _suspect_entries.append(entry_like)

        for _it in result["import_provenance"].get("items") or []:
            _add_suspect(_it)
        for _it in result["external_link_risks"].get("items") or []:
            if _it.get("surface") in ("asset_name", "asset_path"):
                _loc = _it.get("location", "")
                _add_suspect({"object_path": _loc, "package_name": _loc, "display_name": _loc})
        for _it in asset_result.get("small_square_ui_texture_entries") or []:
            _add_suspect(_it)

        _thumb_out_dir = os.path.join(os.path.dirname(_moderation_report_path()), "moderation_thumbnails")
        result["extracted_thumbnails"] = extract_asset_thumbnails(
            _suspect_entries, _thumb_out_dir, max_thumbnails=40,
            project_dir=scan_root, mount_prefix=asset_result.get("project_mount"),
        )
        _new_thumb_paths = result["extracted_thumbnails"].get("written_paths") or []
        if _new_thumb_paths:
            result["image_paths"] = list(result.get("image_paths") or []) + _new_thumb_paths
            notes.append(
                f"Extracted {len(_new_thumb_paths)} embedded thumbnail(s) from "
                "suspect assets into image_paths for visual inspection — see "
                "extracted_thumbnails."
            )
    except Exception as e:
        notes.append(f"extract_asset_thumbnails failed: {e}")
        result["extracted_thumbnails"] = {"written_paths": [], "notes": [f"failed: {e}"]}

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

    # -----------------------------------------------------------------
    # Transport bounding (MCP path only — max_items is None on the
    # in-process launcher path, so this whole block is a no-op there).
    # See run_moderation_scan()'s docstring for the full priority rules.
    # Every top-level COUNT above is already exact and uncapped; only
    # list BODIES are sampled here, each with an honest *_omitted_count.
    # -----------------------------------------------------------------
    if max_items is not None:
        sample_notes = []

        def _apply_cap(key, is_priority=None, priority_key=None, true_total=None):
            capped, kept, omitted, full = _cap_items_with_priority(
                result.get(key), max_items, is_priority, priority_key
            )
            result[key] = capped
            base_full = true_total if true_total is not None else full
            true_omitted = max(0, base_full - kept)
            result[f"{key}_omitted_count"] = true_omitted
            if true_omitted:
                sample_notes.append(
                    f"{key}: {kept} of {base_full} returned (max_items="
                    f"{max_items}); see {key}_omitted_count for what was "
                    "sampled away."
                )
            return kept

        # 4-tier priority (BUG FIX — priority inversion, see
        # _is_hlod_or_external_entry's docstring): import_provenance hits,
        # then external_link_risks hits, then ordinary project assets,
        # HLOD/External-Actor entries demoted to last.
        _import_risk_object_paths = {
            it.get("object_path", "") for it in (result.get("import_provenance") or {}).get("items") or []
        }
        _external_link_asset_locations = {
            it.get("location", "") for it in (result.get("external_link_risks") or {}).get("items") or []
            if it.get("surface") in ("asset_name", "asset_path")
        }
        _asset_tier_fn = _make_asset_cap_priority_tier_fn(
            _import_risk_object_paths, _external_link_asset_locations
        )

        _kept_project_assets = _apply_cap("asset_surfaces", priority_key=_asset_tier_fn)
        _apply_cap("hlod_or_imported_assets", priority_key=_asset_tier_fn)
        _apply_cap("external_actor_assets", priority_key=_asset_tier_fn)

        # SCOPE FIX: shared/base-mount assets only get whatever sample
        # budget the project's own assets (asset_surfaces) didn't use — the
        # user explicitly asked to scan what they control first. Counts
        # still reconcile against the TRUE total either way.
        _shared_budget = max(0, max_items - _kept_project_assets)
        _shared_capped, _shared_kept, _shared_omitted_ignored, _shared_full = _cap_items_with_priority(
            result.get("shared_game_mount_assets"), _shared_budget, priority_key=_asset_tier_fn,
        )
        result["shared_game_mount_assets"] = _shared_capped
        _shared_true_total = result.get("shared_game_mount_asset_count", _shared_full)
        _shared_true_omitted = max(0, _shared_true_total - _shared_kept)
        result["shared_game_mount_assets_omitted_count"] = _shared_true_omitted
        if _shared_true_omitted:
            sample_notes.append(
                f"shared_game_mount_assets: {_shared_kept} of {_shared_true_total} "
                f"returned (max_items={max_items}, budget shared with — and spent "
                "AFTER — project assets: project's own content is prioritized "
                "first); see shared_game_mount_assets_omitted_count."
            )

        _apply_cap("verse_surfaces")
        _apply_cap("image_metadata")

        # image_paths — prioritize the just-extracted suspect thumbnails
        # (see extract_asset_thumbnails above) so a transport cap can never
        # silently drop the very images added to close the vision gap.
        _extracted_thumb_paths = set(
            (result.get("extracted_thumbnails") or {}).get("written_paths") or []
        )
        _apply_cap(
            "image_paths",
            priority_key=(lambda p: 0 if p in _extracted_thumb_paths else 1) if _extracted_thumb_paths else None,
        )

        # audio_surfaces / unicode_risks are nested dicts — cap their inner
        # list field directly rather than the whole dict.
        audio = result.get("audio_surfaces")
        if isinstance(audio, dict) and isinstance(audio.get("audio"), list):
            capped, kept, omitted, full = _cap_items_with_priority(audio["audio"], max_items)
            audio["audio"] = capped
            audio["audio_omitted_count"] = omitted
            if omitted:
                sample_notes.append(
                    f"audio_surfaces.audio: {kept} of {full} returned "
                    f"(max_items={max_items}); see audio_surfaces."
                    "audio_omitted_count."
                )

        unicode_risks = result.get("unicode_risks")
        if isinstance(unicode_risks, dict) and isinstance(unicode_risks.get("items"), list):
            capped, kept, omitted, full = _cap_items_with_priority(
                unicode_risks["items"], max_items,
                is_priority=lambda it: (it or {}).get("surface") == "text_metadata",
            )
            unicode_risks["items"] = capped
            # unicode_risks["total_count"] (set by collect_unicode_risks) is
            # already the true, uncapped total — use it as the basis rather
            # than `full` (which is only the count AFTER that collector's
            # own _UNICODE_RISK_ITEM_CAP already ran).
            prior_total = unicode_risks.get("total_count", full)
            transport_omitted = max(0, prior_total - kept)
            unicode_risks["items_omitted_count"] = transport_omitted
            if transport_omitted:
                sample_notes.append(
                    f"unicode_risks.items: {kept} of {prior_total} returned "
                    f"(max_items={max_items}, text_metadata hits prioritized "
                    "first); see unicode_risks.total_count / "
                    "unicode_risks.items_omitted_count."
                )

        # text_metadata.fields, redirectors.redirectors,
        # external_link_risks.items, and import_provenance.items are
        # deliberately NEVER capped here — all four are typically tiny and
        # are the single most directly actionable evidence (the actual
        # island name/description text, proof that renamed/deleted content
        # is still reachable, Rule 1.12 "Keep It on the Island" hits like a
        # QR-code asset name, and Rule 1.7/1.12's single strongest
        # predictor — an asset imported from outside the project tree) —
        # sampling any of them away would hide exactly what a human/LLM
        # needs to act on. See run_moderation_scan's docstring: only ~200 of
        # 48,412 assets survived sampling on the real project that
        # motivated these fixes, so a sampled list would have missed the
        # offending asset entirely.

        if sample_notes:
            result["truncated"] = True
            if "sampled_for_transport" not in truncated_collectors:
                truncated_collectors.append("sampled_for_transport")
            notes.append(
                f"PAYLOAD SAMPLED FOR MCP TRANSPORT (max_items={max_items}): "
                "the lists below are representative SAMPLES bounded for "
                "bridge transport, not complete inventories. Every "
                "top-level COUNT (total_registry_assets, "
                "project_asset_count, shared_game_mount_asset_count, "
                "unicode_risks.total_count, etc.) remains EXACT and "
                "uncapped — report counts and scale judgments from those "
                "counts with full confidence, but never imply every listed "
                "item was individually seen."
            )
            notes.extend(sample_notes)

    return result


# ---------------------------------------------------------------------------
# Launcher UI — analysed-report-first viewer (see module docstring: this
# module itself never judges anything; the analysed report is written by a
# connected LLM through uefn_bridge.py's moderation_report_save MCP handler)
# ---------------------------------------------------------------------------

def _moderation_report_path():
    """Path to moderation_report.json, next to THIS script (the PRIMARY
    location). Matches ``uefn_bridge.py``'s own ``_moderation_report_path()``
    — both scripts live side by side in Content/Python (see module
    docstring) — but is reimplemented locally rather than imported, since
    this module deliberately never imports ``uefn_bridge.py`` (see
    run_moderation_scan's docstring: "designed to be pulled in from there,
    not the reverse"). This path can sit under a permission-protected
    engine-install path that ``init_unreal.py`` self-syncs these scripts
    into — see ``_bridge_ipc_dir()``'s docstring for the FALLBACK location
    ``_handle_moderation_report_save`` also writes to for exactly that
    reason."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "moderation_report.json")


def _bridge_ipc_dir():
    """The bridge IPC temp directory — the FALLBACK location a report can
    land in when the primary (``_moderation_report_path()``) is
    unwritable. Mirrors ``uefn_bridge.py``'s ``_get_bridge_dir()``
    derivation EXACTLY (env var override, else ``<temp>/uefn_bridge``) —
    reimplemented locally for the same "never imports uefn_bridge.py"
    reason as ``_moderation_report_path()`` above. A divergent derivation
    here would recreate the exact silent-failure class of bug this dual-
    location read was added to fix (reader looking in a different place
    than the writer actually wrote). Deliberately does NOT create the
    directory (unlike ``_get_bridge_dir()``) — this is a READ-side helper,
    and creating a directory has no purpose when there is nothing to read
    from it. Never raises."""
    try:
        return os.environ.get("UEFN_BRIDGE_DIR") or os.path.join(
            tempfile.gettempdir(), "uefn_bridge"
        )
    except Exception:
        return os.path.join(tempfile.gettempdir(), "uefn_bridge")


def _moderation_report_locations():
    """Every location ``_read_moderation_report()`` checks, as
    ``[(label, path), ...]`` — deduplicated (primary and fallback can
    coincide if ``UEFN_BRIDGE_DIR`` happens to equal this script's own
    directory). Exposed separately from ``_read_moderation_report()`` so
    the launcher window's "no report yet" state can show the user exactly
    where this scan looked, rather than a dead-end message — the whole
    point of this diagnosability pass. Never raises."""
    try:
        primary = _moderation_report_path()
        fallback = os.path.join(_bridge_ipc_dir(), "moderation_report.json")
        locations = [("primary — next to this script", primary)]
        if fallback != primary:
            locations.append(("fallback — bridge IPC temp dir", fallback))
        return locations
    except Exception:
        return []


def _read_moderation_report():
    """Read the analysed moderation_report.json written by the connected
    LLM. Shape: {"generated_at": str, "summary": str, "severity_counts":
    {"BLOCKER": int, "WARN": int, "KNOWN_RISK": int, "INFO": int},
    "report": str}.

    DUAL-LOCATION READ (matches ``_handle_moderation_report_save``'s dual-
    location WRITE in ``uefn_bridge.py``): checks BOTH
    ``_moderation_report_path()`` (primary) and ``_bridge_ipc_dir()``'s
    ``moderation_report.json`` (fallback) and returns whichever exists,
    PARSES as valid JSON, and has the NEWEST mtime. A file that exists but
    fails to parse does NOT shadow a valid file at the other location —
    candidates are tried newest-mtime-first and a parse failure falls
    through to the next one, rather than returning nothing. This closes a
    real silent-failure bug: a report that only made it to the fallback
    location (because the primary sat under a permission-protected engine-
    install path) was previously invisible to this reader forever, through
    repeated Refresh clicks.

    Returns the parsed dict — with ``_source_path``/``_source_label``/
    ``_source_mtime`` injected for the window to display where the report
    came from — or None if no location has a valid, parsable report. Never
    raises. A missing/corrupt-everywhere result simply means "no analysed
    report yet", not an error; callers should show
    ``_moderation_report_locations()`` in that case (see
    ``show_moderation_scan``'s report section) rather than a dead end."""
    candidates = []
    try:
        for label, path in _moderation_report_locations():
            try:
                mtime = os.path.getmtime(path)
            except Exception:
                continue
            candidates.append((mtime, label, path))
    except Exception:
        return None

    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0], reverse=True)

    for mtime, label, path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            # Exists but unparseable — fall through to the next candidate
            # rather than shadowing a potentially-valid one elsewhere.
            continue
        if isinstance(data, dict):
            data = dict(data)
            data["_source_path"] = path
            data["_source_label"] = label
            data["_source_mtime"] = mtime
            return data

    return None


def _moderation_allowlist_path():
    """Path to moderation_allowlist.json, next to THIS script — same
    directory-relative pattern as ``_moderation_report_path()`` above. A
    per-project, per-user runtime artifact (the creator's own declared
    "licensed IP" list), never staged/shipped — see the .gitignore /
    .vscodeignore entries alongside moderation_report.json."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "moderation_allowlist.json")


def _read_moderation_allowlist():
    """Read the per-project Licensed IP allowlist previously saved via the
    scan window's "Licensed IP" field. Shape on disk:
    {"licensed_ip": ["...", "..."]}. Returns a list of non-empty, trimmed
    strings (possibly empty) — NEVER raises. A missing, unreadable, or
    corrupt file is treated as "no saved value yet" (empty list), exactly
    like ``_read_moderation_report``'s handling of its own file."""
    try:
        with open(_moderation_allowlist_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            values = data.get("licensed_ip")
            if isinstance(values, list):
                return [str(v).strip() for v in values if str(v).strip()]
    except Exception:
        pass
    return []


def _write_moderation_allowlist(licensed_ip_list):
    """Persist `licensed_ip_list` (already parsed/trimmed strings) to
    moderation_allowlist.json next to this script. Best-effort convenience
    save — NEVER raises; any failure (permissions, disk, etc.) is silently
    swallowed rather than surfaced, since this window has no modal-dialog
    mechanism to report it (see the tick-pump/no-mainloop constraint
    documented above the clipboard helpers)."""
    try:
        with open(_moderation_allowlist_path(), "w", encoding="utf-8") as f:
            json.dump({"licensed_ip": licensed_ip_list}, f, indent=2)
    except Exception:
        pass


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
        unicode_by_surface = unicode_risks.get("by_surface") or {}
        redirectors = result.get("redirectors") or {}
        redirectors_n = len(redirectors.get("redirectors") or [])
        external_actor_n = len(result.get("external_actor_assets") or [])
        image_prov = result.get("image_provenance") or {}
        prov_flagged_n = sum(
            1 for i in (image_prov.get("images") or []) if i.get("has_provenance_fields")
        )
        link_risks = result.get("external_link_risks") or {}
        link_risks_n = link_risks.get("total_count", len(link_risks.get("items") or []))
        import_prov = result.get("import_provenance") or {}
        import_risk_n = len(import_prov.get("items") or [])
        hlod_generated_n = result.get("hlod_generated_count", 0)
        thumbs = result.get("extracted_thumbnails") or {}
        thumbs_extracted_n = thumbs.get("extracted", 0)

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
        lines.append(
            f"  of which {hlod_generated_n} are auto-generated HLOD proxies "
            "(expected to be large — NOT itself a finding; deprioritized, "
            "never hidden, in any transport-sampled list)."
        )
        lines.append(f"External Actor/Object generated packages: {external_actor_n}")
        if import_risk_n:
            lines.append(
                f"Import provenance — imported from OUTSIDE the project tree: "
                f"{import_risk_n}  <-- STRONGEST SIGNAL, uncapped (see "
                "import_provenance)"
            )
        else:
            lines.append(
                "Import provenance — imported from OUTSIDE the project tree: "
                "0 found (see import_provenance.note)."
            )
        if thumbs_extracted_n:
            lines.append(
                f"Suspect-asset embedded thumbnails extracted for vision review: "
                f"{thumbs_extracted_n} (appended to image_paths; see "
                "extracted_thumbnails)"
            )
        lines.append(f"Verse string/comment/label surfaces: {verse_n}")
        lines.append(f"Text metadata fields (island name/description/etc.): {text_fields_n}")
        lines.append(f"Images with embedded text metadata: {images_n} (of {total_images} scanned)")
        lines.append(f"Audio surfaces ({audio.get('source', '?')}): {audio_n}")
        lines.append(f"Asset hashes computed: {hashes_n}")
        lines.append("")
        # BY-SURFACE BREAKDOWN — a single aggregate count buries the handful
        # of hits that actually matter: Fortnite's TEXT-METADATA moderation
        # review stage only reads island name/description/etc, never Verse
        # source, asset names, or audio names, so metadata hits are led
        # with and flagged highest priority; a large Verse/asset/audio
        # count is real but lower priority for that specific review stage.
        _meta_bucket = unicode_by_surface.get("text_metadata") or {}
        _meta_count = _meta_bucket.get("count", 0)
        _meta_fields = _meta_bucket.get("fields") or {}
        _other_buckets = sorted(
            (
                (surface, bucket) for surface, bucket in unicode_by_surface.items()
                if surface != "text_metadata" and bucket.get("count")
            ),
            key=lambda kv: -kv[1].get("count", 0),
        )
        _other_total = sum(bucket.get("count", 0) for _s, bucket in _other_buckets)
        _surface_labels = {
            "verse": "Verse strings/comments/labels",
            "asset_display_name": "asset display names",
            "audio_display_name": "audio display names",
        }

        # SCOPE CAVEAT (matches the note run_moderation_scan always adds):
        # "island metadata" here means only text_metadata FOUND IN THE
        # PROJECT FILES on disk — never the island title/description/
        # loading-screen text a creator submits through the publishing
        # portal, which is entered separately and this scan cannot see at
        # all. A real user misread "none in island metadata" as "my
        # submitted description is clean" — it isn't evidence either way.
        # Made most prominent when the metadata count is ZERO, since
        # that's the case most likely to be misread as an all-clear.
        _scope_caveat_prominent = (
            "  SCOPE: 'island metadata' = text found in the PROJECT FILES "
            "only. The title/description/loading-screen text you submit "
            "through the publishing portal is entered separately and is "
            "NOT visible to this scan — a zero here is NOT proof the "
            "submitted text is clean. Check it separately."
        )
        _scope_caveat_plain = (
            "  (SCOPE: covers project-file text metadata only — the "
            "publishing-portal title/description/loading-screen text is "
            "separate and not scanned here.)"
        )

        if _meta_count:
            _fields_str = ", ".join(
                f"{name}: {count}"
                for name, count in sorted(_meta_fields.items(), key=lambda kv: -kv[1])
            )
            lines.append(
                f"Emoji / decorative-Unicode: {_meta_count} in island metadata "
                f"({_fields_str})  <-- HIGHEST PRIORITY"
            )
            lines.append(_scope_caveat_plain)
        elif _other_total:
            lines.append(
                f"Emoji / decorative-Unicode: none in island metadata; "
                f"{_other_total} in other surfaces — lower priority for the "
                "metadata review stage"
            )
            lines.append(_scope_caveat_prominent)
        else:
            lines.append("Emoji / decorative-Unicode: none found.")
            lines.append(_scope_caveat_prominent)

        if _other_buckets:
            _parts = ", ".join(
                f"{_surface_labels.get(surface, surface)}: {bucket.get('count', 0)}"
                for surface, bucket in _other_buckets
            )
            lines.append(f"  Other surfaces (lower priority): {_parts}")

        if unicode_total != _meta_count + _other_total:
            # Defensive only — should always reconcile; a mismatch would
            # mean a surface wasn't tallied into by_surface, a bug in
            # collect_unicode_risks rather than a formatting choice.
            lines.append(
                f"  (unreconciled: total_count={unicode_total}, "
                f"by_surface sum={_meta_count + _other_total} — see raw "
                "unicode_risks data)"
            )

        lines.append(f"Redirectors (renamed/deleted content still reachable): {redirectors_n}  <-- actionable")
        lines.append(f"Images with authoring-tool/creator/copyright metadata: {prov_flagged_n}")
        if link_risks_n:
            lines.append(
                f"External link / scannable-code risks (Rule 1.12 'Keep It on "
                f"the Island'): {link_risks_n}  <-- CHECK THIS, uncapped"
            )
        else:
            lines.append(
                "External link / scannable-code risks (Rule 1.12 'Keep It on "
                "the Island'): 0 found — NOT proof-of-clean, see note below "
                "(this scan cannot read QR codes/URLs baked into texture "
                "pixels)."
            )

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
        link_risks = result.get("external_link_risks") or {}
        _add_list(
            "External link / scannable-code risks (Rule 1.12 'Keep It on the "
            "Island') — HIGH-VALUE signal, never capped/sampled",
            link_risks.get("items") or [],
            lambda r: (
                f"[{r.get('kind', '')}] {r.get('text', '')!r}  in {r.get('surface', '')} "
                f":: {r.get('location', '')}"
            ),
        )
        if link_risks.get("note"):
            lines.append(f"  Note: {link_risks['note']}")
            lines.append("")

        import_prov = result.get("import_provenance") or {}
        _add_list(
            "Import provenance — imported from OUTSIDE the project tree "
            "(Rule 1.7/1.12 strongest signal) — never capped/sampled",
            import_prov.get("items") or [],
            lambda r: (
                f"[{r.get('classification', '')}] {r.get('source_path', '')}  "
                f"-> {r.get('object_path', '')}  [{r.get('display_name', '')}]"
            ),
        )
        if import_prov.get("note"):
            lines.append(f"  Note: {import_prov['note']}")
            lines.append("")

        thumbs = result.get("extracted_thumbnails") or {}
        _add_list(
            "Extracted suspect-asset thumbnails (embedded editor JPEG, for "
            "vision review — also appended to image_paths)",
            thumbs.get("written_paths") or [],
            lambda p: str(p),
        )
        for n in thumbs.get("notes") or []:
            lines.append(f"  Note: {n}")
        if thumbs.get("notes"):
            lines.append("")
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
    root.minsize(760, 480)
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
    report_frame = tk.Frame(root, bg=_BG, padx=16)
    report_frame.pack(fill=tk.BOTH, expand=False, pady=(4, 8))

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

            # Subtle source caption (diagnosability) — where this report was
            # actually read from, since it can be the primary OR fallback
            # location (see _read_moderation_report's docstring). Small,
            # dim, never a redesign of the existing layout.
            _source_label = report_data.get("_source_label")
            if _source_label:
                tk.Label(
                    report_frame,
                    text=f"(read from {_source_label}: {report_data.get('_source_path', '?')})",
                    font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG,
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

            # Diagnosability (this follow-up's whole point): show exactly
            # where this window looked, so a report stuck at an unwritable
            # primary location — previously an invisible dead end through
            # repeated Refresh clicks — is something the user can act on.
            _locations = _moderation_report_locations()
            if _locations:
                _locations_text = "\n".join(
                    f"  • {label}: {path}" for label, path in _locations
                )
                tk.Label(
                    cta,
                    text="Checked locations (none had a valid report):\n" + _locations_text,
                    font=("Consolas", 8), fg=_TEXT_DIM, bg=_SECTION_BG,
                    justify=tk.LEFT, wraplength=850,
                ).pack(anchor=tk.W, pady=(8, 0))

    _render_report_section()

    # --- Action buttons ---
    actions_frame = tk.Frame(root, bg=_BG, padx=16)
    actions_frame.pack(fill=tk.X, pady=(0, 8))

    def _current_allowlist_for_prompt():
        """Values to feed into the copied prompt right now: the entry's
        LIVE text (so Copy works even if the user hasn't blurred/saved
        yet). No placeholder/suggestion exists any more — the field starts
        empty unless a value was previously saved for this project, so
        anything present here is a real, user-declared value."""
        raw = allowlist_var.get()
        return [p.strip() for p in raw.split(",") if p.strip()]

    def _copy_prompt():
        licensed = _current_allowlist_for_prompt()
        if licensed:
            licensed_line = (
                "Licensed IP: " + ", ".join(licensed) + " — pass these as "
                "the tool's `allowlist` parameter so matching assets/text "
                "are grouped as \"expected licensed\" rather than "
                "\"investigate\"."
            )
        else:
            licensed_line = (
                "Licensed IP (edit or delete this line): <franchises you "
                "are licensed for> — pass as the tool's `allowlist` "
                "parameter."
            )
        prompt = (
            "Run the uefn_moderation_scan MCP tool for this UEFN project "
            f"(project path: {scan_root}), then review the collected asset, "
            "Verse, text-metadata, image, and audio surfaces — prioritize "
            "import_provenance (never sampled/capped — an asset imported "
            "from OUTSIDE the project, especially a Downloads/Desktop/Temp "
            "folder, is the single strongest predictor this scan has; treat "
            "any item as a likely BLOCKER), external_link_risks (Rule 1.12 "
            "'Keep It on the Island' — never sampled/capped; treat any hit, "
            "especially kind=scannable_code_token or url, as a likely "
            "BLOCKER, and read its `note` field even when empty since this "
            "scan cannot decode most images' pixels), extracted_thumbnails "
            "(embedded editor thumbnails pulled for the highest-suspicion "
            "assets — actually LOOK at these images if any were extracted), "
            "unicode_risks (especially by_surface.text_metadata's per-field "
            "counts), hlod_or_imported_assets (note hlod_generated_count is "
            "usually large and NOT itself a finding — the auto-generated "
            "HLOD entries are deprioritized in the list, not hidden), "
            "external_actor_assets, redirectors, and image_provenance as the "
            "highest-value evidence — and report any IP-ownership, "
            "authenticity, or external-link risks, grouped by severity "
            "(BLOCKER, WARN, KNOWN_RISK, INFO), with a short summary and "
            "actionable next steps for each finding.\n"
            f"{licensed_line}\n"
            "Finally, call uefn_moderation_report with the full report "
            "text, a one-line summary, and per-severity counts (BLOCKER, "
            "WARN, KNOWN_RISK, INFO) — this is what makes the results "
            "appear in this window (click Refresh once it's done)."
        )
        # See the module-level comment above _copy_text_to_system_clipboard:
        # Tk's own clipboard API must never be called from this window.
        if _copy_text_to_system_clipboard(prompt):
            copy_btn.configure(text="Copied!")
            root.after(1500, lambda: copy_btn.configure(text="Copy prompt"))
        else:
            _show_copy_fallback_dialog(root, prompt, title="Copy prompt")

    copy_btn = tk.Button(
        actions_frame, text="Copy prompt", font=("Segoe UI", 9, "bold"),
        bg=_ACCENT_BLUE, fg="#FFFFFF", activebackground="#D24E1F",
        activeforeground="#FFFFFF", relief="flat", padx=10, pady=4,
        command=_copy_prompt,
    )
    copy_btn.pack(side=tk.LEFT)

    tk.Button(
        actions_frame, text="Refresh", font=("Segoe UI", 9),
        bg=_SECTION_BG, fg=_TEXT_FG, activebackground=_BG,
        activeforeground=_TEXT_FG, relief="flat", padx=10, pady=4,
        command=_render_report_section,
    ).pack(side=tk.LEFT, padx=(8, 0))

    # --- Licensed IP (optional) — feeds the MCP tool's `allowlist` param ---
    allowlist_frame = tk.Frame(root, bg=_BG, padx=16)
    allowlist_frame.pack(fill=tk.X, pady=(0, 8))
    tk.Label(
        allowlist_frame, text="Licensed IP (optional):",
        font=("Segoe UI", 9, "bold"), fg=_HEADER_FG, bg=_BG,
    ).pack(anchor=tk.W)

    allowlist_entry_row = tk.Frame(allowlist_frame, bg=_BG)
    allowlist_entry_row.pack(fill=tk.X, pady=(2, 0))

    allowlist_var = tk.StringVar()
    allowlist_entry = tk.Entry(
        allowlist_entry_row, textvariable=allowlist_var, font=("Segoe UI", 9),
        bg=_SECTION_BG, fg=_TEXT_FG, insertbackground=_TEXT_FG, relief="flat",
    )
    allowlist_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=3)

    tk.Label(
        allowlist_entry_row,
        text=(
            "  franchises you are licensed to use — comma separated; "
            "leave blank if none"
        ),
        font=("Segoe UI", 8), fg=_TEXT_DIM, bg=_BG,
    ).pack(side=tk.LEFT)

    # NO pre-seed suggestion here, deliberately. This used to pre-fill from
    # the project's own resolved content mount name, but a project's
    # folder/mount name is not evidence of a license — pre-filling it reads
    # as a claim (a real reviewer saw the pre-filled value and mistook it
    # for a hardcoded example or a brand "detection", which is exactly the
    # wrong impression). A WRONG allowlist entry is actively harmful: it
    # groups assets as "expected licensed" that the creator may not
    # actually be licensed for. An EMPTY field is the safe default —
    # everything simply gets reported — so only a previously-SAVED value
    # (this project's own moderation_allowlist.json beside the bridge)
    # ever pre-fills this field. Do not re-add a mount-derived suggestion.
    _saved_allowlist = _read_moderation_allowlist()
    if _saved_allowlist:
        allowlist_var.set(", ".join(_saved_allowlist))

    def _save_allowlist_field(_event=None):
        raw = allowlist_var.get()
        _write_moderation_allowlist([p.strip() for p in raw.split(",") if p.strip()])

    allowlist_entry.bind("<FocusOut>", _save_allowlist_field)
    allowlist_entry.bind("<Return>", _save_allowlist_field)

    # --- Compact summary (always shown, counts only — not a dump) ---
    # BUG FIX: this used to be a plain tk.Label with no wraplength. A Label
    # never wraps or scrolls on its own — a line longer than the window's
    # current width is simply CLIPPED at the window edge with no
    # indication anything was cut off. The NOTES lines (the honest
    # caveats about caps/scope, e.g. "...omitted from the shared_game_mou")
    # are exactly the long prose lines that got clipped, hiding the
    # caveats they exist to surface. A ScrolledText with wrap=tk.WORD
    # wraps every line instead — nothing is silently cut off — and its own
    # scrollbar keeps the section from forcing the window to grow
    # unbounded when there are many notes.
    summary_frame = tk.Frame(root, bg=_BG, padx=16)
    summary_frame.pack(fill=tk.X, pady=(0, 4))
    _summary_text = _format_compact_summary(result)
    _summary_height = max(6, min(_summary_text.count("\n") + 1, 18))
    summary_widget = scrolledtext.ScrolledText(
        summary_frame, wrap=tk.WORD, bg=_BG, fg=_TEXT_FG,
        insertbackground=_TEXT_FG, relief="flat", font=("Consolas", 9),
        height=_summary_height, borderwidth=0, highlightthickness=0,
    )
    summary_widget.pack(fill=tk.BOTH, expand=True)
    summary_widget.insert("1.0", _summary_text)
    summary_widget.configure(state=tk.DISABLED)

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
