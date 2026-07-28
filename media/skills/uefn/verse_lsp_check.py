#!/usr/bin/env python3
"""Offline, real-compiler Verse diagnostics via Epic's bundled language
server (verse-lsp), driven headless over LSP/stdio -- no UEFN editor running.

WHY THIS EXISTS
----------------
verse_lint.py and verse_project_check.py (this same directory) are both
TEXT-LEVEL heuristics: they model a handful of known compile-failure shapes
by pattern-matching source. Neither is a compiler, and both say so loudly in
their own docstrings. This tool is different in kind: it drives the ACTUAL
Verse language server that ships inside Epic's official "Verse" VS Code
extension (the same analyzer UEFN itself uses) and reports its REAL
diagnostics. A clean run from THIS tool is a much stronger signal than a
clean run from the text-level lints -- but it still is not proof a UEFN
in-editor build will succeed (see "WHAT THIS DOES NOT GUARANTEE" below).

THE CRITICAL DISCOVERY -- READ BEFORE "SIMPLIFYING" ANYTHING HERE
---------------------------------------------------------------------
`rootUri` (and `rootPath`, and the sole `workspaceFolders` entry) passed to
the server's `initialize` request MUST be the VPROJECT FOLDER -- the
directory that directly contains the project's `<Name>.vproject` file,
i.e. `.../VerseProject/<Name>/vproject`. This was verified empirically: the
UEFN project root, the project's `Content` directory, and the digest root
(`.../VerseProject/<Name>`) were ALL tried and every one of them produced
ZERO diagnostics -- the server initialized fine and reported no problems at
all, silently, which looks exactly like a clean pass and is not one. Only
the vproject folder produces real diagnostics. Do not "simplify" this to a
more intuitive-looking root; it will silently stop working.

HOW THE SERVER ACTUALLY BEHAVES (observed, not documented by Epic)
-----------------------------------------------------------------------
- Opening a SINGLE `.verse` file via `textDocument/didOpen` is enough to
  make the server analyse and `publishDiagnostics` for MANY files across
  the project -- it appears to walk the vproject's whole dependency graph
  once it has any open document to anchor from, not just files reachable
  from the one that was opened. This tool still opens a small handful of
  files (see MAX_FILES_TO_OPEN below) rather than exactly one, purely as
  cheap redundancy -- not because one was ever observed to be insufficient.
- After `shutdown`, the server RE-publishes every previously-diagnosed file
  with an EMPTY `diagnostics` array as part of its teardown. That is a
  cleanup clear, not a real result, and a collector that keeps applying
  every `publishDiagnostics` it sees straight through teardown will let
  those empty republishes silently erase everything it already gathered.
  This tool snapshots results BEFORE sending `shutdown` and never lets the
  post-shutdown drain touch that snapshot again.
- A JSON-RPC message with a "method" key is a server-originated
  request/notification, EVEN IF its numeric "id" happens to collide with an
  id this tool is using for one of its own requests (ids are not a shared
  namespace between the two directions). A message only counts as the
  response to one of OUR requests when it carries no "method" key at all.
  Getting this backwards causes a real request (e.g. the server's own
  `client/registerCapability`) to be mistaken for a response and dropped,
  silently stalling the handshake.

WHAT THIS DOES NOT GUARANTEE
--------------------------------
- A clean run (zero diagnostics) is a strong signal, not a build guarantee.
  It reflects exactly what the language server chose to open and analyse in
  this headless session; it may not exercise every code path a full UEFN
  build does.
- This tool cannot run at all until the project has been opened in UEFN at
  least once (UEFN is what generates the `.vproject` file this tool
  depends on) and until Epic's Verse extension is installed somewhere on
  this machine. Both are checked explicitly and cause exit code 3 (not a
  clean 0) when missing -- see EXIT CODES below.
- A stale copy of the analyzer can produce confidently WRONG diagnostics.
  This tool cross-checks the selected analyzer's version against the
  project's own digest artifacts and emits a NON-FATAL warning on a
  mismatch (see the version-sanity section below); it does not block the
  run on a mismatch, because a warning that might be wrong is still better
  than silently trusting a stale analyzer.

EXIT CODES
----------
    0  analysis ran to completion, zero diagnostics.
    1  analysis ran to completion, one or more diagnostics were found.
    2  usage error -- bad or missing command-line argument.
    3  PRECONDITIONS NOT MET -- the analysis could not run at all (missing
       extension, missing/mismatched .vproject, handshake failure, etc.).
       This is DELIBERATELY distinct from exit 0: a run that never happened
       must never be reported as "no errors found". See the module's
       precondition-failure paths; none of them print a clean-pass shape.

USAGE
-----
    python verse_lsp_check.py <uefn-project-root-or-its-Content-dir>
        [--json] [--timeout <seconds>]

`<path>` may be either a UEFN project's root directory or that project's
`Content` directory directly -- both are accepted and resolved to the same
place. `--timeout` bounds the whole diagnostic-collection phase (default
120s); it does not need to be exact, since collection also stops early on
an idle window once no new server messages have arrived for a few seconds.

An explicit `VERSE_LSP_PATH` environment variable, if set, overrides all
automatic discovery of the verse-lsp binary (see "STEP 1" below). An
explicit `UEFN_VERSE_PROJECT_DIR` environment variable, if set, overrides
all automatic discovery of the `VerseProject` data root -- the directory
that directly contains per-project subfolders, each with a `vproject`
subfolder holding that project's `.vproject` file (see "STEP 2" below).
Both overrides follow the same contract: if set but pointing at something
that doesn't exist, that is a precondition failure naming the bad value,
never a silent fallback to automatic discovery.

Automatic discovery of the `VerseProject` root tries, in order: the
standard `%LOCALAPPDATA%\\UnrealEditorFortnite\\Saved\\VerseProject`
location; fallbacks derived from `USERPROFILE`/`os.path.expanduser("~")` and
`%APPDATA%`/`%PROGRAMDATA%` for machines where `LOCALAPPDATA` is unset or
redirected; and, on Windows, a best-effort (fail-open, never-raising) scan
of the registry under `HKEY_CURRENT_USER` and `HKEY_LOCAL_MACHINE` for an
Epic Games / UEFN install or data path. Every candidate tried is recorded
so a discovery failure can list all of them.

HARD CONSTRAINTS
-----------------
Python 3 standard library ONLY -- no third-party packages. Every filesystem
path used at runtime is derived from environment variables
(USERPROFILE/LOCALAPPDATA/APPDATA/PROGRAMDATA/UEFN_VERSE_PROJECT_DIR), the
Windows registry, or from the user's own on-disk project files; nothing
below is a real username, machine path, or project name -- examples in
this docstring use neutral placeholders (`<Name>`) deliberately.
"""
from __future__ import annotations

import copy
import glob
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

# --------------------------------------------------------------------------
# Exit codes (match the sibling tools' convention in this directory).
# --------------------------------------------------------------------------
EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE_ERROR = 2
EXIT_PRECONDITION_FAILED = 3

# --------------------------------------------------------------------------
# Tunables.
# --------------------------------------------------------------------------
DEFAULT_TIMEOUT_SECONDS = 120.0
HANDSHAKE_TIMEOUT_CAP = 30.0
IDLE_WINDOW_SECONDS = 5.0
MIN_COLLECT_SECONDS = 2.0
SHUTDOWN_GRACE_SECONDS = 5.0
PROCESS_KILL_GRACE_SECONDS = 5.0

# A small handful, not "blindly open everything" -- see the module
# docstring's "HOW THE SERVER ACTUALLY BEHAVES" section. One open file was
# observed sufficient to trigger whole-project analysis; opening a few more
# is cheap redundancy, not a requirement.
MAX_FILES_TO_OPEN = 3

# Every editor/IDE layout this tool knows to search for a copy of Epic's
# "Verse" extension, relative to the current user's home directory.
EXTENSION_DIR_NAMES = (
    ".vscode",
    ".vscode-insiders",
    ".cursor",
    ".antigravity",
    ".vscode-server",
    ".windsurf",
)

SEVERITY_WORDS = {1: "ERROR", 2: "WARNING", 3: "INFO", 4: "HINT"}

SCOPE_NOTE = (
    "verse_lsp_check drives Epic's own verse-lsp analyzer over LSP/stdio and "
    "reports its REAL diagnostics -- it is not a text-level heuristic like "
    "verse_lint.py / verse_project_check.py in this same directory. A clean "
    "(0-diagnostic) run is a strong signal but not a build guarantee: it "
    "reflects only what the analyzer chose to open in this headless session. "
    "Exit code 3 means the analysis did NOT run at all (missing extension, "
    "missing/mismatched .vproject, handshake failure) and must never be read "
    "as a clean pass, even though the process still exits non-zero. See the "
    "module docstring for the full list of caveats."
)

EOF_SENTINEL = object()


# ==========================================================================
# Small helpers
# ==========================================================================


def _home_dir() -> str:
    return os.environ.get("USERPROFILE") or os.path.expanduser("~")


def _canon_path(path_str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(str(path_str))))


def _path_to_uri(path_str) -> str:
    """Percent-encodes correctly (spaces included) via pathlib's own
    RFC-3986 file-URI conversion -- this is the exact mechanism the proven
    spike used; do not hand-roll string concatenation here."""
    return Path(path_str).resolve().as_uri()


def _uri_to_path(uri_str: str) -> str:
    """Inverse of `_path_to_uri`, tolerant of both an unescaped drive-colon
    (`file:///C:/...`, what `_path_to_uri` itself produces) and a
    percent-escaped one (`file:///C%3A/...`, observed directly from the
    real server's `publishDiagnostics` notifications -- Epic's server
    escapes the colon; Python's own `Path.as_uri()` does not).

    Deliberately hand-rolled instead of `urllib.request.url2pathname`:
    that stdlib helper detects a Windows drive letter by regex-matching the
    RAW (still percent-encoded) path *before* unquoting, so it recognises
    `/C:/Users/...` but NOT `/C%3A/Users/...` -- confirmed directly against
    both forms, where the percent-escaped one came back as
    `\\C:\\Users\\...` with a stray leading backslash left over from the
    misdetected UNC-style fallback. Unquoting FIRST and THEN matching the
    drive-letter pattern sidesteps that entirely and handles both forms
    identically.

    Also handles a UNC-style URI, `file://server/share/dir/file.verse`, where
    the host lives in `urlparse`'s `netloc` component, NOT `path`. Reading
    only `parsed.path` (as this function used to) silently drops the server
    name and produces a wrong local path (`\\share\\dir\\file.verse` instead
    of `\\\\server\\share\\dir\\file.verse`). A `file:///C:/...` URI has an
    EMPTY netloc (three slashes -- the third is the start of the path), so
    this reconstruction never fires for the ordinary drive-letter forms
    above; it only fires when a real host is present."""
    parsed = urlparse(uri_str)
    if parsed.scheme != "file":
        return uri_str
    raw = unquote(parsed.path)
    netloc = unquote(parsed.netloc) if parsed.netloc else ""
    if netloc and netloc.lower() != "localhost":
        # `raw` already starts with "/share/..."; prefixing "//" + netloc
        # yields "//server/share/..." which becomes "\\server\share\..."
        # (a proper UNC path) once slashes are normalised below.
        combined = "//" + netloc + raw
        if os.name == "nt":
            combined = combined.replace("/", "\\")
        return combined
    if re.match(r"^/[A-Za-z]:", raw):
        raw = raw[1:]  # strip the leading slash before a drive letter
    if os.name == "nt":
        raw = raw.replace("/", "\\")
    return raw


def _version_sort_key(version_str: str):
    """Numeric, dot-segment sort key, e.g. '0.0.55550516' -> (0, 0,
    55550516). A non-numeric segment degrades to 0 rather than raising --
    version strings are external input (a folder name on disk)."""
    parts = []
    for seg in version_str.split("."):
        digits = re.sub(r"\D", "", seg)
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _lsp_build_number(version_str: str):
    """The trailing dot-segment of a version string, if numeric -- e.g.
    '0.0.55550516' -> 55550516. Returns None if the string doesn't end in a
    numeric segment, which this tool treats as "no signal", never as 0."""
    parts = version_str.split(".")
    if parts and parts[-1].isdigit():
        return int(parts[-1])
    return None


def _find_digest_cl(digest_root: str):
    """Returns (build_number, source_file_path) or (None, None).

    Every `*.digest.verse` file Epic generates carries a header comment of
    the form `# Generated from build: ++Fortnite+Release-XX.YY-CL-NNNNNNNN`.
    That CL (changelist) number was confirmed, directly against a real
    project's generated digest files, to be the SAME number as the trailing
    numeric segment of the installed extension folder's version suffix
    (`epicgames.verse-0.0.NNNNNNNN`) when the analyzer and the project's
    digests came from the same Fortnite build. That correspondence is what
    this function reads back out, for the non-fatal version-sanity warning
    in STEP 3 of the module docstring. If no digest file is found, or none
    parses, this returns (None, None) -- callers must treat that as "no
    signal available", never as "versions match"."""
    pattern = os.path.join(digest_root, "**", "*.digest.verse")
    for path in sorted(glob.glob(pattern, recursive=True)):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                head = fh.read(4096)
        except OSError:
            continue
        m = re.search(r"CL-(\d+)", head)
        if m:
            return int(m.group(1)), path
    return None, None


# ==========================================================================
# STEP 1 -- locate verse-lsp(.exe)
# ==========================================================================


def locate_lsp_exe():
    """Returns (chosen, all_candidates, searched_roots, override_error).

    `chosen` is a dict {'path', 'version', 'extension_dir'} or None.
    `override_error` is set only when VERSE_LSP_PATH was given but invalid
    -- callers must surface that specifically rather than falling through
    to the generic "not found" message, since the user gave an explicit
    (bad) instruction.
    """
    override = os.environ.get("VERSE_LSP_PATH")
    if override:
        if os.path.isfile(override):
            return (
                {"path": override, "version": "unknown (VERSE_LSP_PATH override)", "extension_dir": None},
                [],
                [],
                None,
            )
        return (
            None,
            [],
            [],
            f"VERSE_LSP_PATH is set to {override!r} but no file exists at that path.",
        )

    home = _home_dir()
    searched_roots = [os.path.join(home, name, "extensions") for name in EXTENSION_DIR_NAMES]

    candidates = []
    for root in searched_roots:
        if not os.path.isdir(root):
            continue
        try:
            entries = sorted(os.listdir(root))
        except OSError:
            continue
        for entry in entries:
            if not entry.lower().startswith("epicgames.verse-"):
                continue
            ext_dir = os.path.join(root, entry)
            if not os.path.isdir(ext_dir):
                continue
            version_str = entry[len("epicgames.verse-"):]
            # Glob bin/*/verse-lsp* rather than hardcoding Win64, so a
            # future Mac/Linux layout (bin/Mac/verse-lsp, bin/Linux/verse-lsp)
            # is found rather than silently missed. IMPORTANT: this single
            # glob matches bin/Win64/verse-lsp.exe, bin/Mac/verse-lsp, AND
            # bin/Linux/verse-lsp all at once (a real extension folder ships
            # all three side by side) -- the extension-based filter below is
            # what selects the one binary actually executable on THIS
            # platform. Without it, a wrong-platform binary can sort ahead
            # of the right one and get launched, which fails opaquely
            # (observed on Windows as OSError WinError 193, "%1 is not a
            # valid Win32 application", when the Linux binary was picked).
            expected_basename = "verse-lsp.exe" if os.name == "nt" else "verse-lsp"
            for exe_path in sorted(glob.glob(os.path.join(ext_dir, "bin", "*", "verse-lsp*"))):
                base = os.path.basename(exe_path).lower()
                if base != expected_basename:
                    continue  # wrong platform, or a sibling file like .pdb
                if not os.path.isfile(exe_path):
                    continue
                candidates.append(
                    {
                        "path": exe_path,
                        "version": version_str,
                        "extension_dir": ext_dir,
                        "search_root": root,
                    }
                )

    if not candidates:
        return None, [], searched_roots, None

    candidates.sort(key=lambda c: _version_sort_key(c["version"]), reverse=True)
    return candidates[0], candidates, searched_roots, None


# ==========================================================================
# STEP 2 -- locate the .vproject that matches the target Content directory
# ==========================================================================


def resolve_content_dir(user_path: str):
    """Accepts either a UEFN project root or its Content directory
    directly. Returns (content_dir, project_root) as Path objects, or
    (None, None) if `user_path` doesn't look like either shape."""
    p = Path(user_path)
    if not p.exists():
        return None, None
    p = p.resolve()
    if p.is_dir() and p.name.lower() == "content":
        return p, p.parent
    candidate = p / "Content"
    if candidate.is_dir():
        return candidate, p
    return None, None


def _registry_verseproject_candidates():
    """Best-effort Windows registry scan for an Epic Games / UEFN install or
    data location, under both HKEY_CURRENT_USER and HKEY_LOCAL_MACHINE.
    Epic does not publish a stable schema for these keys, so this probes a
    handful of plausible locations and pulls out any string value whose
    NAME looks like a path (contains "path" or "dir"), treating each as a
    possible base to append `UnrealEditorFortnite\\Saved\\VerseProject` to.

    Deliberately, unconditionally fail-open: `winreg` is imported lazily
    (so this module still imports on non-Windows), the whole function is a
    no-op on non-Windows, and every registry access is wrapped so a missing
    key, a permission error, or any other OSError just yields "no candidate
    from this key" rather than propagating. A registry probe is a nice-to-
    have fallback, never something allowed to abort discovery."""
    if os.name != "nt":
        return []
    try:
        import winreg
    except ImportError:
        return []

    probe_keys = [
        (winreg.HKEY_CURRENT_USER, r"Software\Epic Games\Unreal Engine"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Epic Games\Unreal Engine"),
        (winreg.HKEY_CURRENT_USER, r"Software\Epic Games\EpicGamesLauncher"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Epic Games\EpicGamesLauncher"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Epic Games\EpicGamesLauncher"),
        (winreg.HKEY_CURRENT_USER, r"Software\Epic Games\UnrealEditorFortnite"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Epic Games\UnrealEditorFortnite"),
    ]
    results = []
    for hive, subkey in probe_keys:
        try:
            key = winreg.OpenKey(hive, subkey)
        except OSError:
            continue
        try:
            index = 0
            while True:
                try:
                    name, value, _vtype = winreg.EnumValue(key, index)
                except OSError:
                    break  # no more values (or nothing to enumerate)
                index += 1
                if not isinstance(value, str) or not value:
                    continue
                lowered = name.lower()
                if "path" not in lowered and "dir" not in lowered:
                    continue
                results.append(os.path.join(value, "UnrealEditorFortnite", "Saved", "VerseProject"))
        except OSError:
            pass
        finally:
            try:
                winreg.CloseKey(key)
            except OSError:
                pass
    return results


def _candidate_verseproject_roots():
    """Returns an ordered list of (label, path) candidate `VerseProject`
    data-root directories to search, highest priority first, deduplicated
    by canonicalised path. Every path is derived at runtime from
    environment variables or the registry -- never a hardcoded real path.
    A candidate that can't be read (permission error, etc.) is skipped by
    the caller, never allowed to abort the rest of the search."""
    home = _home_dir()
    local_appdata = os.environ.get("LOCALAPPDATA")
    appdata = os.environ.get("APPDATA")
    userprofile = os.environ.get("USERPROFILE")
    program_data = os.environ.get("PROGRAMDATA")

    raw_candidates = []

    def add(label, base_dir):
        if base_dir:
            raw_candidates.append((label, os.path.join(base_dir, "UnrealEditorFortnite", "Saved", "VerseProject")))

    add("LOCALAPPDATA", local_appdata)
    add("USERPROFILE\\AppData\\Local", userprofile and os.path.join(userprofile, "AppData", "Local"))
    add("~\\AppData\\Local", os.path.join(home, "AppData", "Local"))
    # APPDATA is normally the ROAMING profile (...\AppData\Roaming); derive
    # the sibling Local dir from it for a machine where LOCALAPPDATA itself
    # is unset/redirected but APPDATA still points somewhere useful.
    add("APPDATA-derived Local", appdata and os.path.join(os.path.dirname(appdata), "Local"))
    add("PROGRAMDATA", program_data)

    for reg_path in _registry_verseproject_candidates():
        raw_candidates.append(("registry", reg_path))

    seen = set()
    deduped = []
    for label, path in raw_candidates:
        canon = _canon_path(path)
        if canon in seen:
            continue
        seen.add(canon)
        deduped.append((label, path))
    return deduped


def locate_verseproject_root():
    """Multi-strategy discovery of UEFN's `VerseProject` data root (the
    directory that directly contains per-project subfolders, each holding a
    `vproject` subfolder with that project's `.vproject` file).

    Tries, in order: the `UEFN_VERSE_PROJECT_DIR` env override (wins
    outright if set); then every candidate from `_candidate_verseproject_roots`
    (standard LOCALAPPDATA location, USERPROFILE/home/APPDATA/PROGRAMDATA
    fallbacks, then registry hits), picking the first candidate that both
    exists AND contains at least one `*/vproject/*.vproject` file.

    Returns (root_or_None, tried, override_error, found_but_empty):
      - `root_or_None`: the chosen root directory, or None if nothing usable
        was found.
      - `tried`: ordered list of (label, path) -- EVERY candidate location
        that was checked, for building a precondition-failure message that
        lists them all.
      - `override_error`: set only when UEFN_VERSE_PROJECT_DIR was given but
        does not exist -- callers must surface that specifically rather
        than falling through to the generic "not found" message, matching
        how VERSE_LSP_PATH's override_error is already handled.
      - `found_but_empty`: True when at least one candidate root existed on
        disk but none contained a `*/vproject/*.vproject` file -- a
        distinctly different problem ("UEFN is installed, but no project
        has ever been opened in it") than "no root found at all"."""
    override = os.environ.get("UEFN_VERSE_PROJECT_DIR")
    if override:
        if os.path.isdir(override):
            return override, [("UEFN_VERSE_PROJECT_DIR", override)], None, False
        return (
            None,
            [],
            f"UEFN_VERSE_PROJECT_DIR is set to {override!r} but no directory exists at that path.",
            False,
        )

    tried = _candidate_verseproject_roots()
    found_but_empty = False
    for _label, path in tried:
        try:
            if not os.path.isdir(path):
                continue
        except OSError:
            continue
        try:
            has_any = bool(glob.glob(os.path.join(path, "*", "vproject", "*.vproject")))
        except OSError:
            continue
        if has_any:
            return path, tried, None, False
        found_but_empty = True

    return None, tried, None, found_but_empty


def locate_vproject(content_dir: str):
    """Returns (chosen_entry_or_None, info) where `info` carries everything
    needed to build a precondition-failure message when nothing was chosen:
    info['reason'] in {'root_override_invalid', 'root_not_found',
    'root_found_but_empty', 'no_match', 'ambiguous'} plus supporting lists.
    Matches STRICTLY by canonicalised, case-insensitive Source-package
    `dirPath`, never by project name -- see the module docstring and the
    sibling verse_project_check.py, which documents the same "match by
    content, not name" reasoning."""
    root, tried, override_error, found_but_empty = locate_verseproject_root()
    if override_error:
        return None, {"reason": "root_override_invalid", "override_error": override_error}
    if root is None:
        return None, {
            "reason": "root_found_but_empty" if found_but_empty else "root_not_found",
            "tried": tried,
        }

    pattern = os.path.join(root, "*", "vproject", "*.vproject")
    all_vprojects = sorted(glob.glob(pattern))
    if not all_vprojects:
        # Shouldn't normally happen -- locate_verseproject_root() only
        # returns a root once it has confirmed a match exists -- but guard
        # anyway rather than assume that invariant holds forever.
        return None, {"reason": "root_found_but_empty", "tried": tried, "searched_pattern": pattern}

    target_canon = _canon_path(content_dir)
    parsed_entries = []
    parse_failures = []

    for vp_path in all_vprojects:
        try:
            with open(vp_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            parse_failures.append({"path": vp_path, "reason": str(exc)})
            continue

        # Parse defensively: unknown/missing keys are fine, never crash on
        # schema drift -- only a package whose settings.role == "Source"
        # matters to this tool.
        source_pkg = None
        packages = data.get("packages") if isinstance(data, dict) else None
        for pkg in packages or []:
            desc = (pkg or {}).get("desc") if isinstance(pkg, dict) else None
            settings = (desc or {}).get("settings") if isinstance(desc, dict) else None
            if isinstance(settings, dict) and settings.get("role") == "Source":
                source_pkg = desc
                break
        if not isinstance(source_pkg, dict) or not source_pkg.get("dirPath"):
            parse_failures.append({"path": vp_path, "reason": "no Source-role package with a dirPath was found"})
            continue

        entry = {
            "vproject_path": vp_path,
            "vproject_dir": os.path.dirname(vp_path),
            "digest_root": os.path.dirname(os.path.dirname(vp_path)),
            "source_dir": source_pkg["dirPath"],
            "workspace_name": source_pkg.get("name") or "verse-project",
        }
        parsed_entries.append(entry)

    matches = [e for e in parsed_entries if _canon_path(e["source_dir"]) == target_canon]

    if not matches:
        return None, {
            "reason": "no_match",
            "parsed_entries": parsed_entries,
            "parse_failures": parse_failures,
        }
    if len(matches) > 1:
        return None, {"reason": "ambiguous", "matches": matches}

    return matches[0], {"reason": None}


# ==========================================================================
# STEP 4 -- the LSP session itself
# ==========================================================================


def _build_capabilities() -> dict:
    """Verbatim shape from the proven working spike -- this is what
    actually got a real `initialize` response and real diagnostics; do not
    trim fields speculatively."""
    return {
        "workspace": {
            "applyEdit": True,
            "workspaceEdit": {"documentChanges": True},
            "didChangeConfiguration": {"dynamicRegistration": True},
            "didChangeWatchedFiles": {"dynamicRegistration": True},
            "symbol": {"dynamicRegistration": True},
            "executeCommand": {"dynamicRegistration": True},
            "configuration": True,
            "workspaceFolders": True,
        },
        "textDocument": {
            "synchronization": {
                "dynamicRegistration": True, "willSave": True,
                "willSaveWaitUntil": True, "didSave": True,
            },
            "publishDiagnostics": {
                "relatedInformation": True, "versionSupport": True,
                "tagSupport": {"valueSet": [1, 2]},
            },
            "completion": {"dynamicRegistration": True, "completionItem": {"snippetSupport": True}},
            "hover": {"dynamicRegistration": True, "contentFormat": ["markdown", "plaintext"]},
            "definition": {"dynamicRegistration": True},
            "references": {"dynamicRegistration": True},
            "documentSymbol": {"dynamicRegistration": True},
            "codeAction": {"dynamicRegistration": True},
            "rename": {"dynamicRegistration": True},
        },
        "window": {"workDoneProgress": True},
    }


def _is_response_to(item, req_id) -> bool:
    """JSON-RPC responses never carry a 'method' key. A message WITH
    'method' is always a server-originated request/notification, even if
    its numeric 'id' happens to collide with one of ours -- see the module
    docstring. Getting this backwards silently stalls the handshake."""
    return (
        isinstance(item, dict)
        and item.get("id") == req_id
        and "method" not in item
        and ("result" in item or "error" in item)
    )


def _reader_thread(stdout, msg_queue) -> None:
    try:
        while True:
            headers = {}
            while True:
                raw_line = stdout.readline()
                if raw_line == b"":
                    msg_queue.put(EOF_SENTINEL)
                    return
                line = raw_line.rstrip(b"\r\n")
                if line == b"":
                    break
                if b":" in line:
                    k, _, v = line.partition(b":")
                    headers[k.strip().lower()] = v.strip()
            try:
                length = int(headers.get(b"content-length", b"0"))
            except ValueError:
                continue
            if length <= 0:
                continue
            body = b""
            while len(body) < length:
                chunk = stdout.read(length - len(body))
                if not chunk:
                    break
                body += chunk
            if len(body) < length:
                continue
            try:
                obj = json.loads(body.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            msg_queue.put(obj)
    except Exception:
        msg_queue.put(EOF_SENTINEL)


def _send(stdin, obj) -> None:
    data = json.dumps(obj).encode("utf-8")
    header = f"Content-Length: {len(data)}\r\n\r\n".encode("ascii")
    stdin.write(header + data)
    stdin.flush()


def run_lsp_session(exe_path, vproject_dir, vproject_file, workspace_name, files_to_open, hard_timeout):
    """Runs one full initialize -> didOpen -> collect -> shutdown -> exit
    cycle. Always returns a result dict; never raises to the caller. The
    child process is always killed in a `finally`, so this never hangs."""
    result = {
        "handshake_ok": False,
        "init_error": None,
        "diagnostics": {},  # uri -> list[diagnostic]
        "stderr_tail": [],
        "opened_files": list(files_to_open),
        "timed_out": False,
    }
    stderr_buffer = []
    stderr_lock = threading.Lock()

    def stderr_thread(stderr):
        try:
            for raw in iter(stderr.readline, b""):
                if not raw:
                    break
                text = raw.decode("utf-8", errors="replace").rstrip()
                with stderr_lock:
                    stderr_buffer.append(text)
                    del stderr_buffer[:-200]
        except Exception:
            pass

    try:
        proc = subprocess.Popen(
            [exe_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0,
        )
    except OSError as exc:
        result["init_error"] = f"failed to launch verse-lsp: {type(exc).__name__}: {exc}"
        return result

    msg_q = queue.Queue()
    t_out = threading.Thread(target=_reader_thread, args=(proc.stdout, msg_q), daemon=True)
    t_err = threading.Thread(target=stderr_thread, args=(proc.stderr,), daemon=True)
    t_out.start()
    t_err.start()

    def handle(item, collect_diagnostics: bool) -> None:
        if item is EOF_SENTINEL or not isinstance(item, dict):
            return
        method = item.get("method")
        if method and "id" in item:
            # A server-originated REQUEST (has both method and id) --
            # must be answered or the server may stall waiting on us.
            resp_result = None
            if method == "workspace/configuration":
                n = len(((item.get("params") or {}).get("items")) or [])
                resp_result = [None] * n
            _send(proc.stdin, {"jsonrpc": "2.0", "id": item["id"], "result": resp_result})
            return
        if method == "textDocument/publishDiagnostics" and collect_diagnostics:
            params = item.get("params") or {}
            d_uri = params.get("uri", "<unknown>")
            result["diagnostics"][d_uri] = params.get("diagnostics") or []

    try:
        handshake_timeout = min(HANDSHAKE_TIMEOUT_CAP, max(5.0, hard_timeout))
        vproject_dir_uri = _path_to_uri(vproject_dir)
        init_params = {
            "processId": os.getpid(),
            "rootUri": vproject_dir_uri,
            "rootPath": str(vproject_dir),
            "workspaceFolders": [{"uri": vproject_dir_uri, "name": workspace_name}],
            "capabilities": _build_capabilities(),
            "trace": "off",
        }
        _send(proc.stdin, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": init_params})

        deadline = time.time() + handshake_timeout
        init_response = None
        while time.time() < deadline:
            try:
                item = msg_q.get(timeout=max(0.1, deadline - time.time()))
            except queue.Empty:
                break
            if item is EOF_SENTINEL:
                break
            if _is_response_to(item, 1):
                init_response = item
                break
            handle(item, collect_diagnostics=False)

        if init_response is None:
            result["init_error"] = "handshake failed: no response to 'initialize' before the timeout (or the server's stdout closed)."
            return result
        if "result" not in init_response:
            result["init_error"] = f"handshake failed: server returned an error to 'initialize': {init_response.get('error')}"
            return result
        result["handshake_ok"] = True

        _send(proc.stdin, {"jsonrpc": "2.0", "method": "initialized", "params": {}})

        # Proven-working sequence: tell the server the .vproject exists.
        _send(proc.stdin, {
            "jsonrpc": "2.0",
            "method": "workspace/didChangeWatchedFiles",
            "params": {"changes": [{"uri": _path_to_uri(vproject_file), "type": 1}]},
        })

        # Brief settle before opening files.
        settle_deadline = time.time() + 1.5
        while time.time() < settle_deadline:
            try:
                item = msg_q.get(timeout=max(0.05, settle_deadline - time.time()))
            except queue.Empty:
                continue
            if item is EOF_SENTINEL:
                break
            handle(item, collect_diagnostics=True)

        for file_path in files_to_open:
            try:
                text = Path(file_path).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue  # unreadable file -- skip it, don't abort the run
            _send(proc.stdin, {
                "jsonrpc": "2.0", "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {
                        "uri": _path_to_uri(file_path), "languageId": "verse",
                        "version": 1, "text": text,
                    }
                },
            })

        # Collect until an idle window elapses (no new server message) or
        # the hard timeout is hit, whichever comes first.
        start = time.time()
        last_activity = start
        while True:
            now = time.time()
            elapsed = now - start
            if elapsed >= hard_timeout:
                result["timed_out"] = True
                break
            if elapsed >= MIN_COLLECT_SECONDS and (now - last_activity) >= IDLE_WINDOW_SECONDS:
                break
            try:
                item = msg_q.get(timeout=1.0)
            except queue.Empty:
                continue
            if item is EOF_SENTINEL:
                break
            last_activity = time.time()
            handle(item, collect_diagnostics=True)

        # CRITICAL: snapshot BEFORE shutdown. The server republishes every
        # opened file with an EMPTY diagnostics array as part of teardown --
        # a collector that keeps applying publishDiagnostics through the
        # shutdown drain would let that empty republish erase everything
        # just gathered. See the module docstring.
        snapshot = copy.deepcopy(result["diagnostics"])

        shutdown_id = 2
        _send(proc.stdin, {"jsonrpc": "2.0", "id": shutdown_id, "method": "shutdown", "params": None})
        shutdown_deadline = time.time() + SHUTDOWN_GRACE_SECONDS
        while time.time() < shutdown_deadline:
            try:
                item = msg_q.get(timeout=max(0.1, shutdown_deadline - time.time()))
            except queue.Empty:
                break
            if item is EOF_SENTINEL:
                break
            if _is_response_to(item, shutdown_id):
                break
            # Deliberately collect_diagnostics=False -- teardown-phase
            # publishDiagnostics must never reach the result.
            handle(item, collect_diagnostics=False)

        result["diagnostics"] = snapshot
        _send(proc.stdin, {"jsonrpc": "2.0", "method": "exit"})

    except Exception as exc:
        if result["init_error"] is None:
            result["init_error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=PROCESS_KILL_GRACE_SECONDS)
        except Exception:
            try:
                proc.terminate()
                proc.wait(timeout=PROCESS_KILL_GRACE_SECONDS)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        with stderr_lock:
            result["stderr_tail"] = list(stderr_buffer[-40:])

    return result


# ==========================================================================
# Precondition-failure reporting (STEP 5) -- exit 3, never a clean shape.
# ==========================================================================


def _fail_precondition(json_mode: bool, reason: str, lines) -> int:
    if json_mode:
        print(json.dumps({"status": "precondition_failed", "reason": reason, "messages": list(lines)}, indent=2))
    else:
        print("verse_lsp_check: PRECONDITION NOT MET -- analysis did NOT run.", file=sys.stderr)
        for line in lines:
            print(line, file=sys.stderr)
        print(
            "verse_lsp_check: exiting with code "
            f"{EXIT_PRECONDITION_FAILED} -- this is NOT a clean result, even "
            "though no diagnostics are listed above.",
            file=sys.stderr,
        )
    return EXIT_PRECONDITION_FAILED


def _extension_not_found_lines(searched_roots, override_error):
    if override_error:
        return [override_error, "Unset VERSE_LSP_PATH to fall back to automatic discovery."]
    lines = [
        "Could not find verse-lsp(.exe) anywhere on this machine.",
        "The Verse language server ships inside Epic's official 'Verse' "
        "extension (marketplace publisher 'epicgames', extension name "
        "'Verse'), installed automatically alongside UEFN or manually from "
        "a VS Code-compatible extension gallery.",
        "Searched for a folder matching 'epicgames.verse-*' under:",
    ]
    lines.extend(f"  {root}" for root in searched_roots)
    lines.append(
        "If it is installed somewhere else, set the VERSE_LSP_PATH "
        "environment variable to the exact binary path and re-run."
    )
    return lines


def _vproject_failure_lines(info, content_dir):
    reason = info["reason"]
    if reason == "root_override_invalid":
        return [
            info["override_error"],
            "Unset UEFN_VERSE_PROJECT_DIR to fall back to automatic discovery.",
        ]
    if reason in ("root_not_found", "root_found_but_empty"):
        lines = []
        if reason == "root_found_but_empty":
            lines.append(
                "Found a UEFN 'VerseProject' data folder, but it contains no "
                "'*/vproject/*.vproject' files -- UEFN appears to be "
                "installed on this machine, but no project has been opened "
                "in it yet."
            )
        else:
            lines.append(
                "Could not locate UEFN's saved Verse project state (the "
                "'VerseProject' data folder) anywhere on this machine."
            )
        lines.append("Locations tried, in order:")
        for label, path in info.get("tried") or []:
            lines.append(f"  [{label}] {path}")
        if not info.get("tried"):
            lines.append("  (none -- no candidate base directory could be derived at all)")
        lines.append(
            "UEFN generates this folder's contents the first time a project "
            "is opened in the editor. Open this project in UEFN at least "
            "once, then re-run this tool (UEFN does not need to stay open)."
        )
        lines.append(
            "If UEFN's data lives somewhere nonstandard, set the "
            "UEFN_VERSE_PROJECT_DIR environment variable to the exact "
            "'VerseProject' folder (the directory that directly contains "
            "one subfolder per project, each with its own 'vproject' "
            "subfolder) and re-run."
        )
        return lines
    if reason == "no_match":
        lines = [
            f"Found {len(info['parsed_entries']) + len(info['parse_failures'])} "
            f".vproject file(s), but none of their Source package "
            f"directories match the Content directory given to this tool:",
            f"  target: {content_dir}",
            "Source directories that WERE found:",
        ]
        for entry in info["parsed_entries"]:
            lines.append(f"  {entry['source_dir']}  (workspace {entry['workspace_name']!r})")
        for fail in info["parse_failures"]:
            lines.append(f"  UNPARSEABLE {fail['path']}: {fail['reason']}")
        if not info["parsed_entries"] and not info["parse_failures"]:
            lines.append("  (none)")
        return lines
    if reason == "ambiguous":
        lines = [
            "Multiple .vproject files' Source packages resolve to the SAME "
            f"Content directory ({content_dir}), so the target project is "
            "ambiguous:",
        ]
        for entry in info["matches"]:
            lines.append(f"  {entry['vproject_path']}")
        return lines
    return [f"Unrecognised failure reason: {reason!r}"]


# ==========================================================================
# Output formatting
# ==========================================================================


def _normalize_diagnostics(diagnostics_by_uri):
    findings = []
    for uri, diags in diagnostics_by_uri.items():
        path = _uri_to_path(uri)
        for d in diags:
            rng = (d.get("range") or {}).get("start") or {}
            findings.append(
                {
                    "path": path,
                    "line": int(rng.get("line", 0)) + 1,       # LSP lines are 0-indexed
                    "character": int(rng.get("character", 0)) + 1,
                    "severity": d.get("severity", 1),
                    "severity_word": SEVERITY_WORDS.get(d.get("severity", 1), "UNKNOWN"),
                    "code": d.get("code", ""),
                    "message": d.get("message", ""),
                }
            )
    findings.sort(key=lambda f: (f["severity"], f["path"], f["line"], f["character"]))
    return findings


def _print_human_report(findings, meta):
    print(f"verse_lsp_check: analyzer {meta['lsp_version']} ({meta['lsp_path']})")
    print(f"verse_lsp_check: vproject  {meta['vproject_path']}")
    print(f"verse_lsp_check: content   {meta['content_dir']}")
    print(f"verse_lsp_check: opened {len(meta['opened_files'])} file(s) as the analysis anchor")
    if meta.get("version_note"):
        print(f"verse_lsp_check: {meta['version_note']}")
    print()

    if not findings:
        print("verse_lsp_check: 0 diagnostics.")
        print(SCOPE_NOTE)
        return

    by_path = {}
    for f in findings:
        by_path.setdefault(f["path"], []).append(f)

    for path in sorted(by_path):
        print(path)
        for f in by_path[path]:
            code = f"[{f['code']}]" if f["code"] != "" else ""
            print(f"  {path}:{f['line']}:{f['character']} {f['severity_word']} {code} {f['message']}")
        print()

    counts = {}
    for f in findings:
        counts[f["severity_word"]] = counts.get(f["severity_word"], 0) + 1
    summary = ", ".join(f"{n} {word.lower()}(s)" for word, n in sorted(counts.items()))
    print(f"verse_lsp_check: {len(findings)} diagnostic(s) -- {summary} -- across {len(by_path)} file(s).")
    print(SCOPE_NOTE)


def _print_json_report(findings, meta):
    counts = {}
    for f in findings:
        counts[f["severity_word"]] = counts.get(f["severity_word"], 0) + 1
    obj = {
        "status": "ok",
        "lsp_path": meta["lsp_path"],
        "lsp_version": meta["lsp_version"],
        "vproject_path": meta["vproject_path"],
        "content_dir": meta["content_dir"],
        "opened_files": meta["opened_files"],
        "version_note": meta.get("version_note"),
        "diagnostics": findings,
        "summary": {"total": len(findings), "by_severity": counts},
    }
    print(json.dumps(obj, indent=2))


# ==========================================================================
# CLI
# ==========================================================================

USAGE = (
    "usage: verse_lsp_check.py <uefn-project-root-or-Content-dir> [--json] "
    "[--timeout <seconds>]\n"
    "exit codes: 0=clean  1=diagnostics found  2=usage error  "
    "3=PRECONDITIONS NOT MET (analysis did not run -- never a clean pass)"
)


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv

    json_mode = False
    timeout = DEFAULT_TIMEOUT_SECONDS
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--json":
            json_mode = True
        elif arg == "--timeout":
            i += 1
            if i >= len(argv):
                print("verse_lsp_check: --timeout requires a value", file=sys.stderr)
                return EXIT_USAGE_ERROR
            try:
                timeout = float(argv[i])
            except ValueError:
                print(f"verse_lsp_check: --timeout value is not a number: {argv[i]!r}", file=sys.stderr)
                return EXIT_USAGE_ERROR
        elif arg.startswith("--timeout="):
            try:
                timeout = float(arg.split("=", 1)[1])
            except ValueError:
                print(f"verse_lsp_check: --timeout value is not a number: {arg!r}", file=sys.stderr)
                return EXIT_USAGE_ERROR
        elif arg in ("-h", "--help"):
            # A user who explicitly asked for help got what they asked for
            # -- that is a success, not a usage error. Printed to stdout
            # (not stderr) to match: stderr stays reserved for things that
            # went wrong. Exit 2 is reserved for a genuinely bad/missing
            # argument (see the usage-error branches below and at the
            # bottom of main()).
            print(USAGE)
            print(SCOPE_NOTE)
            return EXIT_OK
        elif arg.startswith("--"):
            print(f"verse_lsp_check: unknown option: {arg}", file=sys.stderr)
            return EXIT_USAGE_ERROR
        else:
            positional.append(arg)
        i += 1

    if len(positional) != 1:
        print(USAGE, file=sys.stderr)
        return EXIT_USAGE_ERROR

    target = positional[0]
    content_dir, project_root = resolve_content_dir(target)
    if content_dir is None:
        print(
            f"verse_lsp_check: {target!r} is not a UEFN project root "
            "(no 'Content' subdirectory) and is not itself a 'Content' "
            "directory.",
            file=sys.stderr,
        )
        return EXIT_USAGE_ERROR

    # ---- STEP 1: locate verse-lsp(.exe) -----------------------------------
    chosen_lsp, all_lsp_candidates, searched_roots, override_error = locate_lsp_exe()
    if chosen_lsp is None:
        return _fail_precondition(
            json_mode, "verse_lsp_not_found",
            _extension_not_found_lines(searched_roots, override_error),
        )

    # ---- STEP 2: locate the matching .vproject -----------------------------
    vp_entry, vp_info = locate_vproject(str(content_dir))
    if vp_entry is None:
        return _fail_precondition(json_mode, f"vproject_{vp_info['reason']}", _vproject_failure_lines(vp_info, content_dir))

    # ---- STEP 3: version sanity (non-fatal) --------------------------------
    version_note = None
    cl_number, cl_source = _find_digest_cl(vp_entry["digest_root"])
    lsp_build = _lsp_build_number(chosen_lsp["version"])
    if cl_number is not None and lsp_build is not None:
        if cl_number != lsp_build:
            version_note = (
                f"WARNING (non-fatal) -- possible version mismatch: selected "
                f"verse-lsp reports build {lsp_build} (version "
                f"{chosen_lsp['version']}), but the project's digest files "
                f"were generated from build CL-{cl_number} ({cl_source}). A "
                "stale analyzer can produce confidently WRONG diagnostics."
            )
        else:
            version_note = f"version check OK -- analyzer build {lsp_build} matches project digest build CL-{cl_number}."
    else:
        version_note = (
            "version check: no signal available (could not find a parsable "
            "'CL-<number>' in a *.digest.verse file under the project's "
            "digest folder, or the analyzer version string had no numeric "
            "build suffix). This is not a failure, just unverified."
        )

    # ---- gather .verse files under the content dir -------------------------
    verse_files = []
    for dirpath, _dirnames, filenames in os.walk(str(content_dir)):
        for name in filenames:
            if name.endswith(".verse"):
                verse_files.append(os.path.join(dirpath, name))
    verse_files.sort()
    if not verse_files:
        return _fail_precondition(
            json_mode, "no_verse_files",
            [f"The Content directory {content_dir} contains zero *.verse files -- there is nothing to analyse."],
        )
    files_to_open = verse_files[:MAX_FILES_TO_OPEN]

    # ---- STEP 4: run the analysis -------------------------------------------
    session = run_lsp_session(
        chosen_lsp["path"], vp_entry["vproject_dir"], vp_entry["vproject_path"],
        vp_entry["workspace_name"], files_to_open, timeout,
    )
    if not session["handshake_ok"]:
        lines = [session["init_error"] or "handshake failed for an unknown reason."]
        if session["stderr_tail"]:
            lines.append("verse-lsp stderr (most recent lines):")
            lines.extend(f"  {line}" for line in session["stderr_tail"])
        else:
            lines.append("verse-lsp produced no stderr output.")
        return _fail_precondition(json_mode, "handshake_failed", lines)

    findings = _normalize_diagnostics(session["diagnostics"])
    meta = {
        "lsp_path": chosen_lsp["path"],
        "lsp_version": chosen_lsp["version"],
        "vproject_path": vp_entry["vproject_path"],
        "content_dir": str(content_dir),
        "opened_files": files_to_open,
        "version_note": version_note,
    }

    if json_mode:
        _print_json_report(findings, meta)
    else:
        _print_human_report(findings, meta)

    if session["timed_out"]:
        note = f"verse_lsp_check: NOTE -- hit the {timeout:g}s timeout before an idle window was reached; results above may be incomplete."
        print(note, file=sys.stderr)

    return EXIT_FINDINGS if findings else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
