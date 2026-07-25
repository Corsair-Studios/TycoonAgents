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

# A package path that starts with "/Game/" is a classic tell of an asset
# migrated from a standalone Unreal project via the Migrate tool (which
# always targets /Game/), rather than authored natively under this island's
# own "/<ProjectName>/" mount — worth a second look for import provenance.
_MIGRATED_PREFIX = "/Game/"

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

def collect_asset_surfaces():
    """Enumerate every project asset via the Asset Registry. Returns
    {"available": bool, "assets": [...], "hlod_or_imported": [...],
    "error": str?}. Never raises; returns available=False if `unreal` isn't
    importable or the registry can't be reached."""
    result = {"available": _HAS_UNREAL, "assets": [], "hlod_or_imported": []}
    if not _HAS_UNREAL:
        return result

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        all_assets = registry.get_all_assets()
    except Exception as e:
        result["available"] = False
        result["error"] = f"asset registry unavailable: {e}"
        return result

    for a in all_assets:
        try:
            package_path = str(getattr(a, "package_path", ""))
            package_name = str(getattr(a, "package_name", ""))
            display_name = str(getattr(a, "asset_name", ""))

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
            result["assets"].append(entry)

            haystack = (package_path + " " + package_name).upper()
            is_hlod = "HLOD" in haystack
            is_official = package_path.startswith(_OFFICIAL_PREFIXES)
            looks_migrated = package_path.startswith(_MIGRATED_PREFIX) and not is_official

            if is_hlod or looks_migrated:
                result["hlod_or_imported"].append(entry)
        except Exception:
            continue

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

def run_moderation_scan(project_dir=None):
    """Orchestrate every collector and return one structured dict:

        {
          "generated_ok": bool,
          "scan_root": str,
          "unreal_available": bool,
          "asset_surfaces": [...],
          "hlod_or_imported_assets": [...],
          "verse_surfaces": [...],
          "text_metadata": {...},
          "image_metadata": [...],
          "image_paths": [...],
          "audio_surfaces": {...},
          "asset_hashes": {path: sha256},
          "notes": [...],
          "truncated": bool,
        }

    ``truncated`` is True iff ANY collector below hit its collection cap
    (see MAX_FILES_WALKED / MAX_FILES_HASHED / MAX_FILE_BYTES_HASHED) —
    when True, one or more of the surface lists above is a PARTIAL result,
    and ``notes`` names exactly which collector(s) were capped and at what
    limit. An empty or short surface list is NOT proof of "no issues
    found" when ``truncated`` is True (or when the scan root itself was
    unverified — see the "scan root unverified" note below).

    Note: this dict deliberately has NO ``first_pass_hints`` key. The
    literal wordlist matching that used to live here now happens
    server-side in the MCP server (see the module docstring above) so this
    staged file never has to contain franchise/brand literals.

    ``project_dir=None`` resolves the live project root via
    ``health_scanner``'s validated scan-root chain (see module docstring).
    Pass an explicit path to scan a different/offline project (also how
    this is unit-tested without a live UEFN session).

    PHASE 2 (MCP wiring) NOTE: this function is the intended handler body —
    register it the same way ``uefn_bridge.py`` wraps ``scan_health()`` in
    ``_handle_health_scan(params)`` (a thin ``def _handle_moderation_scan
    (params): return run_moderation_scan(params.get("project_dir"))``
    wrapper is all that's needed). This module never imports/touches
    ``uefn_bridge.py`` — it's designed to be pulled in from there, not the
    reverse. All collectors are side-effect-free (read-only) and safe to
    call from any thread/tick context UEFN's bridge dispatch uses.

    Never raises — every collector is individually guarded and any
    unexpected failure is recorded in ``notes`` rather than propagated.
    """
    notes = []
    truncated = False

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
        "verse_surfaces": [],
        "text_metadata": {},
        "image_metadata": [],
        "image_paths": [],
        "audio_surfaces": {},
        "asset_hashes": {},
        "notes": notes,
        "truncated": truncated,
    }

    try:
        asset_result = collect_asset_surfaces()
        result["asset_surfaces"] = asset_result.get("assets", [])
        result["hlod_or_imported_assets"] = asset_result.get("hlod_or_imported", [])
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
            notes.append(
                f"Audio surface filesystem walk capped at {MAX_FILES_WALKED} "
                "files — results are partial, not a complete inventory."
            )
    except Exception as e:
        notes.append(f"collect_audio_surfaces failed: {e}")

    try:
        asset_hashes, hash_truncated = hash_assets(scan_root)
        result["asset_hashes"] = asset_hashes
        if hash_truncated:
            result["truncated"] = True
            notes.append(
                f"Asset hashing capped at {MAX_FILES_HASHED} files (and/or "
                f"files over {MAX_FILE_BYTES_HASHED // (1024 * 1024)}MB were "
                "skipped) — results are partial, not a complete hash set."
            )
    except Exception as e:
        notes.append(f"hash_assets failed: {e}")

    return result


# ---------------------------------------------------------------------------
# Launcher UI — raw-surfaces viewer (no LLM judgment; see module docstring)
# ---------------------------------------------------------------------------

def _format_scan_report(result):
    """Render run_moderation_scan()'s dict into a plain-text report: counts
    for every collected surface plus the key lists (especially
    ``hlod_or_imported_assets`` and ``asset_surfaces``), capped so a large
    project doesn't produce an unusable wall of text. Never raises — any
    formatting failure is appended as a trailing note instead of
    propagating."""
    lines = []
    _cap = 200

    def _add_list(title, items, fmt):
        lines.append(f"\n{title} ({len(items)}):")
        if not items:
            lines.append("  (none)")
            return
        for item in items[:_cap]:
            try:
                lines.append("  " + fmt(item))
            except Exception:
                lines.append("  " + str(item))
        if len(items) > _cap:
            lines.append(f"  ... and {len(items) - _cap} more")

    try:
        notes = result.get("notes") or []
        truncated = bool(result.get("truncated"))

        # Truncation / unverified-root warnings are the single most
        # important thing in this report — a human skimming past a wall
        # of counts could easily miss a "results are partial" note buried
        # below them. Render them FIRST, before the title/counts, in an
        # unmissable banner.
        if notes or truncated:
            lines.append("!" * 64)
            lines.append("IMPORTANT — READ BEFORE TRUSTING THE COUNTS BELOW")
            lines.append("!" * 64)
            if truncated:
                lines.append("This scan is PARTIAL/TRUNCATED — one or more collectors hit")
                lines.append("a collection cap. See notes below for exactly which.")
            for n in notes:
                lines.append("  - " + str(n))
            lines.append("!" * 64)
            lines.append("")

        lines.append("UEFN IP / Moderation Pre-Flight Scan — raw collected surfaces")
        lines.append("=" * 64)
        lines.append(f"Scan root: {result.get('scan_root', '?')}")
        lines.append(f"Unreal available: {result.get('unreal_available')}")
        lines.append(f"Generated OK: {result.get('generated_ok')}")
        lines.append(f"Truncated (partial results): {truncated}")

        if notes:
            lines.append(f"\nNotes ({len(notes)}):")
            for n in notes:
                lines.append("  - " + str(n))

        _add_list(
            "HLOD / possibly-imported assets — HIGHEST-VALUE signal",
            result.get("hlod_or_imported_assets") or [],
            lambda a: f"{a.get('package_path', '')}  [{a.get('display_name', '')}]",
        )
        _add_list(
            "All asset surfaces",
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
        lines.append(f"\nTotal image files scanned: {len(result.get('image_paths') or [])}")

        audio = result.get("audio_surfaces") or {}
        _add_list(
            f"Audio surfaces (source: {audio.get('source', '?')})",
            audio.get("audio") or [],
            lambda a: f"{a.get('display_name', '')}  ({a.get('package_path', '')})",
        )

        lines.append(f"\nAsset hashes computed: {len(result.get('asset_hashes') or {})}")
    except Exception as e:
        lines.append(f"\n(report formatting error: {e})")

    return "\n".join(lines)


def show_moderation_scan():
    """Run :func:`run_moderation_scan` and display the RAW collected
    surfaces in a scrollable text window.

    This module never judges anything (see the module docstring) and the
    launcher has no LLM, so this is a deliberately degraded, read-only
    preview: counts plus the key lists, especially ``hlod_or_imported_assets``
    and ``asset_surfaces``. The window tells the user to run the
    ``uefn_moderation_scan`` MCP tool from a connected AI assistant (Claude
    Code, Cursor, etc.) for the full analysed report with severities and fix
    suggestions.
    """
    if not _HAS_TKINTER:
        if _HAS_UNREAL:
            unreal.log_error("moderation_scanner: tkinter is not available.")
        return

    try:
        result = run_moderation_scan()
        report_text = _format_scan_report(result)
    except Exception as e:
        report_text = f"Moderation scan failed to run: {e}"

    _master = tk._default_root
    root = tk.Toplevel(_master) if _master is not None else tk.Tk()
    root.title("Trashbyrd's IP / Moderation Pre-Flight Scan")
    root.geometry("880x640")
    root.minsize(560, 400)
    root.configure(bg=_BG)

    header_frame = tk.Frame(root, bg=_BG, padx=16, pady=12)
    header_frame.pack(fill=tk.X)
    tk.Label(header_frame, text="IP / Moderation Pre-Flight Scan",
             font=("Segoe UI", 15, "bold"), fg=_HEADER_FG, bg=_BG).pack(anchor=tk.W)
    tk.Label(
        header_frame,
        text="Raw collected surfaces only — no judgment happens here.",
        font=("Segoe UI", 9), fg=_TEXT_DIM, bg=_BG,
    ).pack(anchor=tk.W)

    tk.Label(
        header_frame,
        text=(
            "For the full analysed report (IP/authenticity findings, severities, and "
            "fix suggestions), run the “uefn_moderation_scan” MCP tool from your "
            "connected AI assistant (Claude Code, Cursor, etc.)."
        ),
        font=("Segoe UI", 9, "bold"), fg=_ACCENT_BLUE, bg=_BG,
        justify=tk.LEFT, wraplength=820,
    ).pack(anchor=tk.W, pady=(6, 0))

    text_frame = tk.Frame(root, bg=_BG, padx=16, pady=8)
    text_frame.pack(fill=tk.BOTH, expand=True)

    text_widget = scrolledtext.ScrolledText(
        text_frame, wrap=tk.WORD, bg=_SECTION_BG, fg=_TEXT_FG,
        insertbackground=_TEXT_FG, relief="flat", font=("Consolas", 9),
    )
    text_widget.pack(fill=tk.BOTH, expand=True)
    text_widget.insert("1.0", report_text)
    text_widget.configure(state=tk.DISABLED)

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
