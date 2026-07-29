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

HOW THE SERVER ACTUALLY BEHAVES (observed, not documented by Epic; treat as
UNSETTLED, not as a guarantee -- see the correction below)
-----------------------------------------------------------------------
- Opening a `.verse` file via `textDocument/didOpen` reliably yields
  `publishDiagnostics` for THAT file. An early single-project spike also
  saw diagnostics come back for a handful of OTHER, unopened files after
  opening just one -- but a later field session on a different (108-file)
  project saw the opposite: files outside the opened set produced NO
  diagnostics entry at all, indistinguishable at the output layer from
  "opened and found clean". That second observation is the one this tool
  now designs around. **Do not assume opening one file analyses the whole
  project.** This tool does not currently know of an explicit LSP request
  that reliably pulls project-wide diagnostics without opening every file
  individually; if Epic's `verse-lsp` exposes one, this tool does not yet
  use it.
- Because whole-project coverage from a single opened file is NOT a safe
  assumption, a caller that needs a SPECIFIC file checked must name it with
  `--target` (see USAGE below) rather than hoping it lands inside the small
  auto-discovery sample this tool opens by default (see
  DEFAULT_MAX_AUTO_OPEN_FILES below). A file that was never opened has
  UNKNOWN status in this tool's report -- never clean status; see the
  "opened_files" / "targets_not_analyzed" reporting described under EXIT
  CODES and USAGE below.
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

OBSERVED: A VALID .vproject CAN LACK A SOURCE PACKAGE
-------------------------------------------------------
Confirmed directly on a real project: a `.vproject` file can be well-formed,
valid JSON and still contain no Source-role package at all -- only
External-role packages (e.g. Verse, UnrealEngine, Fortnite). One project's
`.vproject` was seen in exactly that state (three External packages, no
Source entry), where an earlier copy of the SAME file had five packages
including a Source entry with a real `dirPath`. UEFN is what regenerates a
project's `.vproject` (see EXIT CODES / STEP 2 below: it is written the
first time the project is opened in the editor), so re-opening the project
in UEFN is the known-working way to get the Source package written back.
What specifically causes an already-opened project's `.vproject` to be
rewritten WITHOUT a Source package is not established here -- only the
before/after states on disk were observed, not the trigger. This tool
treats "valid JSON, no Source package" as its own precondition-failure
case, distinct from "the file could not be parsed at all" and from "a
Source package exists but its `dirPath` doesn't match the target" -- see
`locate_vproject` and `_vproject_failure_lines`.

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

ORIGIN CLASSIFICATION
----------------------
Confirmed directly against a real project scan: the user's OWN code was
analyzer-clean, but the run still reported 152 diagnostics -- 151 inside a
`*.digest.verse` file and 1 inside the project's own `.vproject` (a VNI
dependency-cycle error), both of which UEFN itself generates and
regenerates on every open. None of those 152 were creator-actionable, but
nothing in the report said so; a human had to work that out by hand. Every
diagnostic this tool reports now carries an `origin` field so that
judgment happens automatically, every run:
  - "project"        the file resides under the resolved Content directory
                      -- the only origin a creator can act on. Checked
                      FIRST: RESIDENCE WINS over the `.digest.verse` name
                      rule below, per this project's PATH-DISCOVERY
                      doctrine (content-based matching beats name-based
                      matching) -- Epic writes digests into the
                      VerseProject external-package folders, never into
                      the creator's own Content tree.
  - "epic-generated"  for a file OUTSIDE the Content directory: it resides
                      under the VerseProject digest root (this covers the
                      `.vproject` file and any `*.digest.verse`), OR the
                      filename itself ends in `.digest.verse` -- that
                      suffix is definitionally Epic-generated wherever it
                      sits outside the project's own Content tree.
  - "other"           neither of the above -- reported honestly, never
                      guessed into one of the other two buckets.
Classification is by canonicalised path CONTAINMENT (residence) FIRST; the
`.digest.verse` filename rule is a fallback that only applies once Content-
dir residence has already been ruled out. This is purely additive labelling: exit codes are UNCHANGED -- a run
whose diagnostics are 100% Epic-generated still exits 1, because the
analysis genuinely found diagnostics; this tool labels, it does not
suppress. See `_classify_origin`, `_origin_counts`, `_origin_split_line`.

EXIT CODES
----------
    0  analysis ran to completion, zero diagnostics.
    1  analysis ran to completion, one or more diagnostics were found.
    2  usage error -- bad or missing command-line argument.
    3  PRECONDITIONS NOT MET -- the analysis could not run at all (missing
       extension, missing/mismatched .vproject, handshake failure, zero
       files selected to open, etc.). This is DELIBERATELY distinct from
       exit 0: a run that never happened must never be reported as "no
       errors found". See the module's precondition-failure paths; none of
       them print a clean-pass shape.
    4  REQUESTED TARGET NOT ANALYZED -- one or more `--target` file(s) were
       never opened (e.g. the file could not be read once selected). This is
       DELIBERATELY distinct from both exit 0 and exit 1: a file you
       explicitly asked this tool to check, that it did not actually get a
       `textDocument/didOpen` sent for, must never present as either "clean"
       or as ordinary "findings". See "targets_not_analyzed" in the
       human/JSON report.

       NOTE ON WHAT THIS DOES *NOT* COVER, AND WHY (empirically confirmed,
       not assumed): a target that WAS opened but produced zero diagnostics
       is treated as "analyzed and clean", never as exit 4. A live wire
       probe against the real server (open a genuinely clean project file,
       watch traffic for 20s, then trigger shutdown) showed the server
       publishes NO `textDocument/publishDiagnostics` for that file's own
       URI whatsoever -- not live, not even in the post-shutdown empty
       republish that DOES occur for URIs it already had something to say
       about (the .vproject and the two `*.digest.verse` files). A mirror
       probe that opened a synthetic in-memory file containing a real error
       DID get a live `publishDiagnostics` keyed to its own URI. Conclusion:
       the server confirms "I analyzed this and it's dirty" but never
       confirms "I analyzed this and it's clean" -- it is silent either way
       a file is never opened or opened-and-clean. Requiring a
       diagnostics-key hit as proof of analysis would therefore flag every
       genuinely clean `--target` as exit 4: a false-alarm storm exactly as
       destructive as the false-clean this tool exists to prevent. Treating
       a successfully-sent `didOpen` as "analyzed" is the strongest signal
       this server actually exposes.

USAGE
-----
    python verse_lsp_check.py <uefn-project-root-or-its-Content-dir>
        [--json] [--timeout <seconds>] [--target <path-or-glob>]...
        [--max-auto-files <n>]

`<path>` may be either a UEFN project's root directory or that project's
`Content` directory directly -- both are accepted and resolved to the same
place. `--timeout` bounds the whole diagnostic-collection phase (default
120s); it does not need to be exact, since collection also stops early on
an idle window once no new server messages have arrived for a few seconds.

`--target <path-or-glob>` names a specific `.verse` file to guarantee gets
opened and analysed -- repeatable, and each value may be an absolute path,
a path relative to the Content directory, or a glob pattern in either form
(matched with recursive `**` support). Every resolved target is added to
the files this tool opens FIRST and UNCONDITIONALLY, independent of
`os.walk` order and independent of `--max-auto-files`. A `--target` value
that matches no file on disk is a usage error (exit 2) naming the bad
value -- never a silent skip. This exists because, absent a way to name a
file directly, the only way to force a specific file into this tool's
auto-discovered sample was to rename/copy it into a path that happened to
sort early -- a dangerous workaround (a duplicate-class file left live in
the actual Content tree UEFN builds from). `--target` removes the reason
for that workaround to exist.

`--max-auto-files <n>` overrides DEFAULT_MAX_AUTO_OPEN_FILES, the number of
*additional* files this tool opens on its own initiative (beyond whatever
`--target` requested), sampled from the sorted list of `.verse` files under
the content dir. See DEFAULT_MAX_AUTO_OPEN_FILES below for why this is kept
small by default and is never silently raised to "everything". Any run
where the auto-discovery sample was capped short of the full project says
so explicitly in its report -- a capped run must never look like a
complete one.

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
import datetime
import glob
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
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
# A file the caller explicitly named with --target was not analyzed in this
# run (never opened, or opened but the server never published anything for
# it -- not even an empty diagnostics list). Deliberately its own code: this
# must never be conflated with EXIT_OK (which would hide a false-clean) or
# with EXIT_FINDINGS (this is not "diagnostics found", it's "we don't know").
EXIT_TARGET_NOT_ANALYZED = 4

# --------------------------------------------------------------------------
# Tunables.
# --------------------------------------------------------------------------
DEFAULT_TIMEOUT_SECONDS = 120.0
HANDSHAKE_TIMEOUT_CAP = 30.0
IDLE_WINDOW_SECONDS = 5.0
MIN_COLLECT_SECONDS = 2.0
SHUTDOWN_GRACE_SECONDS = 5.0
PROCESS_KILL_GRACE_SECONDS = 5.0

# Default budget for files this tool opens on its OWN initiative (beyond
# whatever --target explicitly requested), purely as cheap sampling -- NOT a
# mechanism this tool relies on for whole-project coverage. See the module
# docstring's "HOW THE SERVER ACTUALLY BEHAVES" section: an early spike saw
# opening one file also surface diagnostics for a few other files, but a
# later field session on a different project saw the opposite (files
# outside the opened set produced no diagnostics entry at all). Kept small
# deliberately: opening files serially over LSP/stdio has a real, linear
# time cost, and 3 is cheap insurance without materially slowing a typical
# run; blindly raising it to "every file" would make a 100+-file project
# slow for a benefit this tool cannot confirm. Overridable per-run via
# --max-auto-files. A caller that needs a SPECIFIC file checked MUST use
# --target -- this budget is not a substitute for that, and any run capped
# by this value says so explicitly in its report (see "capped" in the
# human/JSON output).
DEFAULT_MAX_AUTO_OPEN_FILES = 3

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
    "reflects only the files this tool actually opened in this headless "
    "session (see 'opened' above) -- a file NOT opened has UNKNOWN status, "
    "not clean status, no matter how the report reads. Use --target to "
    "guarantee a specific file is analyzed. Exit code 3 means the analysis "
    "did NOT run at all (missing extension, missing/mismatched .vproject, "
    "handshake failure) and must never be read as a clean pass, even though "
    "the process still exits non-zero. Exit code 4 means a --target file was "
    "not analyzed. See the module docstring for the full list of caveats."
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


def _resolve_targets(raw_targets, content_dir):
    """Resolves `--target` argument value(s) to absolute, existing file
    paths. Each raw value may be an absolute path, a path relative to
    `content_dir`, or a glob pattern (recursive `**` supported) in either
    form.

    Returns (resolved_paths, unmatched):
      - `resolved_paths`: a deduplicated (by canonicalised path),
        order-preserving list of absolute file paths.
      - `unmatched`: a list of (raw_target, resolved_pattern_or_path) pairs
        for every --target value that matched NOTHING on disk. Callers MUST
        treat a non-empty `unmatched` as a usage error and refuse to run --
        a --target that quietly resolves to nothing is exactly the kind of
        silent gap this argument exists to close; it must never be
        swallowed."""
    resolved = []
    seen = set()
    unmatched = []
    for raw in raw_targets:
        pattern = raw if os.path.isabs(raw) else os.path.join(str(content_dir), raw)
        try:
            hits = sorted(glob.glob(pattern, recursive=True))
        except OSError:
            hits = []
        files = [h for h in hits if os.path.isfile(h)]
        if not files:
            unmatched.append((raw, pattern))
            continue
        for h in files:
            abs_h = os.path.abspath(h)
            canon = _canon_path(abs_h)
            if canon in seen:
                continue
            seen.add(canon)
            resolved.append(abs_h)
    return resolved, unmatched


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


def _vproject_package_list(data):
    """Returns `[{"name": ..., "role": ...}]` for every package entry in a
    parsed .vproject JSON payload, regardless of role -- unlike the
    Source-only extraction in `locate_vproject`, this is used solely by the
    passive regression watch (`_update_vproject_watch`) to snapshot the
    FULL package list for later comparison. Defensive like its sibling:
    unknown/missing keys degrade to `None` rather than raising."""
    out = []
    packages = data.get("packages") if isinstance(data, dict) else None
    for pkg in packages or []:
        desc = (pkg or {}).get("desc") if isinstance(pkg, dict) else None
        settings = (desc or {}).get("settings") if isinstance(desc, dict) else None
        name = (desc or {}).get("name") if isinstance(desc, dict) else None
        role = settings.get("role") if isinstance(settings, dict) else None
        out.append({"name": name, "role": role})
    return out


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
    # Separate from `parse_failures` on purpose: this file WAS valid JSON --
    # it is structurally incomplete (no Source-role package), not corrupt.
    # Conflating the two under one label ("UNPARSEABLE") sends a user
    # hunting for JSON corruption that does not exist. See the module
    # docstring's "OBSERVED: A VALID .vproject CAN LACK A SOURCE PACKAGE".
    no_source_entries = []
    # Passive Source-package regression watch (see `_update_vproject_watch`):
    # a full name/role snapshot of every vproject that parses as valid JSON
    # this run, whether or not it has a Source package or matches the
    # target Content dir -- collected here because this is the one place
    # that already parses every candidate .vproject file. IMPORTANT: `root`
    # above is the SHARED UEFN 'VerseProject' cache -- `all_vprojects` can
    # (and on a machine with multiple opened UEFN projects, will) include
    # OTHER projects entirely. This list is therefore raw, whole-cache data,
    # NOT yet scoped to the target project -- `_update_vproject_watch` is
    # responsible for filtering it down to only what THIS run can actually
    # associate with the target Content dir before anything is persisted.
    parsed_snapshots = []

    for vp_path in all_vprojects:
        try:
            with open(vp_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            parse_failures.append({"path": vp_path, "reason": str(exc)})
            continue

        parsed_snapshots.append({"vproject_path": vp_path, "packages": _vproject_package_list(data)})

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
            # The file parsed fine -- this is "valid but incomplete", never
            # "unparseable". UEFN can and does write a .vproject with only
            # External-role packages and no Source package at all; see the
            # module docstring.
            no_source_entries.append({"path": vp_path})
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
            "no_source_entries": no_source_entries,
            "parsed_snapshots": parsed_snapshots,
        }
    if len(matches) > 1:
        return None, {"reason": "ambiguous", "matches": matches, "parsed_snapshots": parsed_snapshots}

    return matches[0], {
        "reason": None,
        "parsed_snapshots": parsed_snapshots,
        # The one candidate this run PROVED belongs to the target project --
        # its Source-package dirPath equals the target Content dir. Read by
        # `_update_vproject_watch` to scope what gets persisted; absent
        # (None) on every failure path, since a match by definition didn't
        # happen there.
        "matched_vproject_path": matches[0]["vproject_path"],
    }


# ==========================================================================
# vproject Source-package regression watch -- passive evidence recorder
# ==========================================================================
#
# WHY THIS EXISTS: UEFN projects' .vproject files have been observed to
# regress from having a Source-role package to External-only, trigger
# unknown (see the module docstring's "VALID BUT INCOMPLETE" case, and
# `locate_vproject`'s `no_source_entries`). That failure is reported loudly
# the moment it happens, but a ONE-OFF report can't show whether it is a
# fluke or a recurring pattern. This module builds that evidence over time,
# per project, with zero effect on the tool's actual analysis: it never
# changes exit codes, diagnostics, or the existing VALID-BUT-INCOMPLETE
# error text -- it only ADDS a regression line/field alongside them.
#
# FAIL-OPEN, ALWAYS: every read/write here is wrapped so a permission
# error, a missing directory, a corrupt/BOM-prefixed file, or any other IO
# problem degrades to a short note string, never an exception -- consistent
# with this project's "an override/probe must never abort discovery"
# doctrine (see the module docstring and docs/PATH-DISCOVERY.md).

VPROJECT_WATCH_MAX_SNAPSHOTS = 20
VPROJECT_WATCH_RELATIVE_PATH = os.path.join(".claude", "tycoon", "vproject-watch.json")


def _vproject_watch_path(project_root) -> str:
    return os.path.join(str(project_root), VPROJECT_WATCH_RELATIVE_PATH)


def _load_vproject_watch(path: str):
    """Best-effort read of the watch file. Returns (snapshots, note):
    `snapshots` is always a list of dicts (empty if the file is missing,
    corrupt, or unreadable); `note` is a short human-readable string when
    something went wrong, else None. Tolerates a UTF-8 BOM (utf-8-sig) and
    starts fresh -- rather than crashing -- on any parse/IO failure.

    Also defends against a structurally-valid-but-malformed file, e.g.
    `{"version": 1, "snapshots": ["x"]}`: a non-dict element would make
    every later `.get(...)` on it raise AttributeError, which -- unguarded
    -- would escape all the way into `main()` and change the tool's exit
    code. Malformed elements are dropped individually (the rest of the
    evidence is kept, not thrown away) and counted into the returned
    note."""
    if not os.path.exists(path):
        return [], None
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            raw = fh.read()
        data = json.loads(raw) if raw.strip() else {}
        snapshots = data.get("snapshots") if isinstance(data, dict) else None
        if not isinstance(snapshots, list):
            return [], f"existing vproject watch file at {path} had no usable 'snapshots' list -- starting fresh."
        clean = [s for s in snapshots if isinstance(s, dict)]
        dropped = len(snapshots) - len(clean)
        note = None
        if dropped:
            entry_word = "entry" if dropped == 1 else "entries"
            note = (
                f"existing vproject watch file at {path} had {dropped} malformed snapshot {entry_word} "
                "(not an object) -- dropped, kept the rest."
            )
        return clean, note
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [], f"existing vproject watch file at {path} could not be read/parsed ({exc}) -- starting fresh."


def _save_vproject_watch(path: str, snapshots) -> "str | None":
    """Atomic write (temp file in the same directory, then `os.replace`),
    capped to the most recent `VPROJECT_WATCH_MAX_SNAPSHOTS` entries.
    Returns None on success, else a short note string -- never raises."""
    try:
        watch_dir = os.path.dirname(path)
        os.makedirs(watch_dir, exist_ok=True)
        payload = {"version": 1, "snapshots": snapshots[-VPROJECT_WATCH_MAX_SNAPSHOTS:]}
        fd, tmp_path = tempfile.mkstemp(dir=watch_dir, prefix=".vproject-watch-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2)
            os.replace(tmp_path, path)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        return None
    except OSError as exc:
        return f"could not write vproject watch file at {path}: {exc}"


def _snapshot_canon_path(entry):
    """Canonicalised `vproject_path` of a snapshot-shaped dict, or None if
    absent/unusable -- centralises the `_canon_path` usage this watch
    relies on for same-file comparison, matching the rest of the module
    (see `_canon_path`, `locate_vproject`'s `target_canon`/`matches`)."""
    vp_path = entry.get("vproject_path") if isinstance(entry, dict) else None
    return _canon_path(vp_path) if vp_path else None


def _update_vproject_watch(project_root, vp_info):
    """Records THIS run's vproject package snapshot(s) and checks for a
    Source-role REGRESSION against this SAME project's own watch history --
    i.e. the current parse has no Source-role package, but the most recent
    PRIOR snapshot recorded for that exact (canonicalised) vproject path
    did.

    CROSS-PROJECT ISOLATION (the reason this function filters before it
    persists anything): `locate_vproject` globs every project cached in
    the SHARED UEFN 'VerseProject' folder, not just this one, so
    `vp_info['parsed_snapshots']` can legitimately contain other, unrelated
    projects' vproject data. Only two kinds of candidate ever get written
    to THIS project's watch file:
      1. `vp_info['matched_vproject_path']`, when present -- set only by
         `locate_vproject`'s success path, where a Source package `dirPath`
         equals this run's target Content dir, so it IS this project's own
         vproject, definitively.
      2. in the no-Source/no-match case, a candidate whose vproject path is
         already present in THIS project's own prior watch history -- that
         history could only have been written by a genuine prior dirPath
         match (case 1 on some earlier run), so a recurring path is still
         this project's, even though its Source package is now missing --
         that IS the regression this watch exists to catch.
    Any other cached project's vproject (a path never previously associated
    with this one) is discarded, never written -- otherwise a machine with
    several cached UEFN projects would burn this project's 20-slot cap on
    unrelated projects within a run or two, evicting exactly the
    Source-bearing evidence this feature exists to preserve. If NOTHING
    this run can be associated with the project, the watch is skipped
    entirely for this run (with a note), never populated with a guess --
    including the very first run, if it has no match and no history yet to
    correlate against; there is nothing dishonest about waiting for real
    evidence of association before writing anything.

    Returns (notes, regression):
      - `notes`: list[str] of short context lines (IO problems, a skip
        reason, or the loud regression line itself) meant to be appended to
        the human/JSON report ALONGSIDE existing output -- never in place
        of it.
      - `regression`: {"detected": False} normally, else a dict with
        detected/last_source_seen/prior_roles/current_roles/
        vproject_mtime_then/vproject_mtime_now for the JSON report's
        `vproject_regression` field.

    Never raises internally; the call site in `main()` additionally wraps
    this whole call in try/except as a second, belt-and-suspenders layer,
    so no future bug here can ever change the tool's exit code."""
    notes = []
    regression = {"detected": False}

    if project_root is None:
        notes.append("vproject watch: skipped -- project root could not be determined.")
        return notes, regression

    all_parsed = (vp_info or {}).get("parsed_snapshots") or []
    if not all_parsed:
        return notes, regression

    # Raw, whole-cache candidates from THIS run, indexed by canonical path
    # -- see the docstring above for why this must be filtered before any
    # of it is associated with (let alone written to) this project.
    by_canon_path = {}
    for p in all_parsed:
        canon = _snapshot_canon_path(p) if isinstance(p, dict) else None
        if canon:
            by_canon_path[canon] = {"vproject_path": p["vproject_path"], "packages": p.get("packages") or []}

    watch_path = _vproject_watch_path(project_root)
    snapshots, load_note = _load_vproject_watch(watch_path)
    if load_note:
        notes.append(f"vproject watch: {load_note}")

    known_paths = {c for c in (_snapshot_canon_path(s) for s in snapshots) if c}

    matched_path = (vp_info or {}).get("matched_vproject_path")
    matched_canon = _canon_path(matched_path) if matched_path else None
    associated_paths = []
    if matched_canon and matched_canon in by_canon_path:
        associated_paths.append(matched_canon)
    for canon in by_canon_path:
        if canon == matched_canon:
            continue
        if canon in known_paths:
            associated_paths.append(canon)

    if not associated_paths:
        notes.append(
            "vproject watch: skipped -- this run's parsed .vproject file(s) could not be associated "
            "with this project (no Source dirPath match, and no prior watch history to correlate a "
            "no-Source candidate against) -- never guessing across the shared VerseProject cache."
        )
        return notes, regression

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    new_entries = []
    for canon in associated_paths:
        cand = by_canon_path[canon]
        vp_path = cand["vproject_path"]
        packages = cand["packages"]
        try:
            mtime_iso = datetime.datetime.fromtimestamp(
                os.path.getmtime(vp_path), tz=datetime.timezone.utc
            ).isoformat()
        except OSError:
            mtime_iso = None

        current_roles = [pkg.get("role") for pkg in packages]
        if "Source" not in current_roles:
            # Most recent PRIOR snapshot for this SAME (canonicalised)
            # vproject path -- snapshots are appended oldest-first, so
            # scan in reverse.
            prior = next((s for s in reversed(snapshots) if _snapshot_canon_path(s) == canon), None)
            if prior is not None:
                prior_roles = [pkg.get("role") for pkg in (prior.get("packages") or [])]
                if "Source" in prior_roles:
                    regression = {
                        "detected": True,
                        "vproject_path": vp_path,
                        "last_source_seen": prior.get("timestamp"),
                        "prior_roles": prior_roles,
                        "current_roles": current_roles,
                        "vproject_mtime_then": prior.get("vproject_mtime"),
                        "vproject_mtime_now": mtime_iso,
                    }
                    notes.append(
                        f"VPROJECT REGRESSION: Source package present at {prior.get('timestamp')} is now "
                        f"missing from {vp_path}. Prior roles: {prior_roles}. Current roles: {current_roles}. "
                        f"vproject mtime then/now: {prior.get('vproject_mtime')}/{mtime_iso}."
                    )

        new_entries.append(
            {
                "timestamp": now_iso,
                "vproject_path": canon,
                "vproject_mtime": mtime_iso,
                "packages": packages,
            }
        )

    save_note = _save_vproject_watch(watch_path, snapshots + new_entries)
    if save_note:
        notes.append(f"vproject watch: {save_note}")

    return notes, regression


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
        "requested_files": list(files_to_open),
        # Populated ONLY as each didOpen is actually sent successfully (see
        # the send loop below) -- NOT aspirationally copied from
        # files_to_open up front. A file that failed to read never reaches
        # this list, even though it was requested; see "unreadable_files".
        "opened_files": [],
        "unreadable_files": [],
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
                # Unreadable file -- record it as such (never silently, and
                # never counted as "opened") and skip it without aborting
                # the rest of the run.
                result["unreadable_files"].append(file_path)
                continue
            _send(proc.stdin, {
                "jsonrpc": "2.0", "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {
                        "uri": _path_to_uri(file_path), "languageId": "verse",
                        "version": 1, "text": text,
                    }
                },
            })
            result["opened_files"].append(file_path)

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


def _fail_precondition(json_mode: bool, reason: str, lines, extra_json=None) -> int:
    if json_mode:
        payload = {"status": "precondition_failed", "reason": reason, "messages": list(lines)}
        if extra_json:
            payload.update(extra_json)
        print(json.dumps(payload, indent=2))
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
        no_source = info.get("no_source_entries") or []
        total = len(info["parsed_entries"]) + len(info["parse_failures"]) + len(no_source)
        lines = [
            f"Found {total} "
            f".vproject file(s), but none of their Source package "
            f"directories match the Content directory given to this tool:",
            f"  target: {content_dir}",
            "Source directories that WERE found:",
        ]
        for entry in info["parsed_entries"]:
            lines.append(f"  {entry['source_dir']}  (workspace {entry['workspace_name']!r})")
        # Three genuinely distinct cases below -- never share one label:
        #   1. UNPARSEABLE: the file could not be read or is not valid JSON.
        #   2. VALID BUT INCOMPLETE: the file parsed fine but has no
        #      Source-role package (see the module docstring's "OBSERVED"
        #      section -- UEFN can write a .vproject in exactly this shape).
        #   3. (handled above, in "Source directories that WERE found") a
        #      Source package exists but its dirPath is not this target --
        #      a real mismatch, reported with the other found entries.
        for fail in info["parse_failures"]:
            lines.append(f"  UNPARSEABLE {fail['path']}: {fail['reason']}")
        for entry in no_source:
            lines.append(
                f"  VALID BUT INCOMPLETE {entry['path']}: parses fine as JSON, but contains "
                "no Source-role package (only External-role packages, or none at all)."
            )
        if not info["parsed_entries"] and not info["parse_failures"] and not no_source:
            lines.append("  (none)")
        if no_source:
            lines.append(
                "UEFN writes a project's Source package into its .vproject when the project is "
                "opened in the editor. If one of the 'VALID BUT INCOMPLETE' project(s) above is "
                "the one you meant to analyse, open it in UEFN once, then re-run this tool."
            )
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


ORIGIN_PROJECT = "project"
ORIGIN_EPIC_GENERATED = "epic-generated"
ORIGIN_OTHER = "other"


def _is_under(path_canon, root_canon) -> bool:
    """True iff `path_canon` is `root_canon` itself or lives somewhere
    beneath it, compared as already-canonicalised (`_canon_path`) strings.
    A missing/empty root never matches anything -- callers pass `None` when
    a root wasn't resolved, and that must yield False, not a crash or a
    false positive."""
    if not path_canon or not root_canon:
        return False
    if path_canon == root_canon:
        return True
    prefix = root_canon if root_canon.endswith(os.sep) else root_canon + os.sep
    return path_canon.startswith(prefix)


def _classify_origin(path: str, content_dir_canon, digest_root_canon) -> str:
    """Classifies a single diagnostic's file by RESIDENCE (canonical path
    containment), per the field evidence that drove this feature: a real
    scan found the user's own code analyzer-clean while ALL of its
    diagnostics sat inside Epic auto-generated files -- digests and the
    project's own `.vproject` -- which are not creator-actionable (UEFN
    regenerates them; editing them is wrong).

    Returns one of:
      - ORIGIN_PROJECT: the file lives under the resolved Content directory
        -- the only origin a creator can actually act on. Checked FIRST,
        ahead of the `.digest.verse` filename rule: RESIDENCE WINS.
        Content/residence-based matching beats name-based matching, per
        this project's PATH-DISCOVERY doctrine (see docs/PATH-DISCOVERY.md,
        "content-based matching over name-based matching wherever
        possible") -- and empirically, Epic writes digest files into the
        VerseProject's external-package folders, never into the creator's
        own Content tree, so a file that genuinely resides under the
        project's Content dir IS the creator's own code, even if it
        happens to be named `*.digest.verse` (e.g. a copy or symlink).
      - ORIGIN_EPIC_GENERATED: for a file OUTSIDE the project Content dir --
        the file lives under the VerseProject digest root (this covers both
        `*.digest.verse` files AND the `.vproject` file itself, since both
        sit under that root), OR the filename ends in `.digest.verse`
        regardless of where (outside Content) it sits.
      - ORIGIN_OTHER: neither of the above. Reported honestly, never
        guessed into one of the other two buckets.

    Residence inside the project Content dir is checked before anything
    else; the `.digest.verse` name rule only applies to files that reside
    OUTSIDE it -- see the module docstring / this feature's task
    description for why that ordering matters."""
    canon = _canon_path(path)
    if _is_under(canon, content_dir_canon):
        return ORIGIN_PROJECT
    if path.lower().endswith(".digest.verse"):
        return ORIGIN_EPIC_GENERATED
    if _is_under(canon, digest_root_canon):
        return ORIGIN_EPIC_GENERATED
    return ORIGIN_OTHER


def _origin_counts(findings):
    counts = {ORIGIN_PROJECT: 0, ORIGIN_EPIC_GENERATED: 0, ORIGIN_OTHER: 0}
    for f in findings:
        counts[f.get("origin", ORIGIN_OTHER)] = counts.get(f.get("origin", ORIGIN_OTHER), 0) + 1
    return counts


def _origin_split_line(counts) -> str:
    return (
        f"{counts.get(ORIGIN_PROJECT, 0)} in project code, "
        f"{counts.get(ORIGIN_EPIC_GENERATED, 0)} in Epic-generated files (digests/vproject -- "
        f"not creator-actionable), {counts.get(ORIGIN_OTHER, 0)} other."
    )


def _normalize_diagnostics(diagnostics_by_uri, content_dir_canon=None, digest_root_canon=None):
    """`content_dir_canon`/`digest_root_canon` should already be
    `_canon_path`-normalised. Both default to None (yielding ORIGIN_OTHER
    for every non-`.digest.verse` file) so pure unit tests that only care
    about line/severity normalisation, not origin, keep working unchanged."""
    findings = []
    for uri, diags in diagnostics_by_uri.items():
        path = _uri_to_path(uri)
        origin = _classify_origin(path, content_dir_canon, digest_root_canon)
        for d in diags:
            rng = (d.get("range") or {}).get("start") or {}
            findings.append(
                {
                    "path": path,
                    "origin": origin,
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

    opened_files = meta.get("opened_files") or []
    total_verse_files = meta.get("total_verse_files")
    if total_verse_files is not None:
        print(
            f"verse_lsp_check: opened {len(opened_files)} of {total_verse_files} total "
            ".verse file(s) under the content dir"
        )
    else:
        print(f"verse_lsp_check: opened {len(opened_files)} file(s) as the analysis anchor")
    print(
        "verse_lsp_check: a file NOT in the 'opened' set has UNKNOWN status in this run "
        "-- its absence below is NOT evidence it is clean."
    )

    target_files = meta.get("target_files")
    if target_files:
        print(f"verse_lsp_check: {len(target_files)} file(s) explicitly requested via --target (guaranteed included):")
        for f in target_files:
            print(f"    {f}")

    unreadable_files = meta.get("unreadable_files")
    if unreadable_files:
        print(f"verse_lsp_check: WARNING -- {len(unreadable_files)} requested file(s) could not be read and were NOT opened:")
        for f in unreadable_files:
            print(f"    {f}")

    if meta.get("capped"):
        print(
            f"verse_lsp_check: NOTE -- auto-discovery sampling capped at {meta.get('max_auto_files')} "
            "file(s) (override with --max-auto-files); this run is a PARTIAL, capped sample of the "
            "project, not a complete scan."
        )

    targets_not_analyzed = meta.get("targets_not_analyzed")
    if targets_not_analyzed:
        print()
        print("verse_lsp_check: *** REQUESTED TARGET(S) NOT ANALYZED (exit code 4) ***")
        for f in targets_not_analyzed:
            print(f"    {f}")
        print(
            "verse_lsp_check: the file(s) above were explicitly requested via --target but did NOT "
            "receive analysis in this run -- this is NOT a clean result and must never be reported "
            "as one."
        )

    if meta.get("version_note"):
        print(f"verse_lsp_check: {meta['version_note']}")

    for note in meta.get("vproject_watch_notes") or []:
        print(f"verse_lsp_check: {note}")

    print()

    if not findings:
        print("verse_lsp_check: 0 diagnostics.")
        print(SCOPE_NOTE)
        return

    # Grouped by origin FIRST (project code ahead of Epic-generated/other),
    # per this feature's task: a creator scanning the report should hit
    # their own actionable diagnostics before wading through hundreds of
    # baseline Epic-generated ones. Within each origin bucket, still grouped
    # by file and sorted alphabetically, same as before this feature.
    by_origin_path = {}
    for f in findings:
        by_origin_path.setdefault(f.get("origin", ORIGIN_OTHER), {}).setdefault(f["path"], []).append(f)

    origin_order = (ORIGIN_PROJECT, ORIGIN_OTHER, ORIGIN_EPIC_GENERATED)
    origin_headers = {
        ORIGIN_PROJECT: "PROJECT CODE (creator-actionable)",
        ORIGIN_OTHER: "OTHER (origin outside the project Content dir and the Epic VerseProject root)",
        ORIGIN_EPIC_GENERATED: "EPIC-GENERATED (digests/vproject -- not creator-actionable; UEFN regenerates these)",
    }
    for origin in origin_order:
        by_path = by_origin_path.get(origin)
        if not by_path:
            continue
        print(f"--- {origin_headers[origin]} ---")
        for path in sorted(by_path):
            print(path)
            for f in by_path[path]:
                code = f"[{f['code']}]" if f["code"] != "" else ""
                print(f"  {path}:{f['line']}:{f['character']} {f['severity_word']} {code} {f['message']}")
            print()

    all_paths = {f["path"] for f in findings}
    counts = {}
    for f in findings:
        counts[f["severity_word"]] = counts.get(f["severity_word"], 0) + 1
    summary = ", ".join(f"{n} {word.lower()}(s)" for word, n in sorted(counts.items()))
    print(f"verse_lsp_check: {len(findings)} diagnostic(s) -- {summary} -- across {len(all_paths)} file(s).")
    print(f"verse_lsp_check: {_origin_split_line(_origin_counts(findings))}")
    print(SCOPE_NOTE)


def _print_json_report(findings, meta):
    counts = {}
    for f in findings:
        counts[f["severity_word"]] = counts.get(f["severity_word"], 0) + 1
    origin_counts = _origin_counts(findings)
    targets_not_analyzed = meta.get("targets_not_analyzed") or []
    # "status" intentionally stays "ok" for a run that completed, whether or
    # not it found diagnostics -- pass/fail lives in the exit code and in
    # `summary`. It is overridden ONLY for the exit-4 condition, which is a
    # fundamentally different kind of result (a requested check that did not
    # happen), never a normal completion.
    status = "target_not_analyzed" if targets_not_analyzed else "ok"
    obj = {
        "status": status,
        "lsp_path": meta["lsp_path"],
        "lsp_version": meta["lsp_version"],
        "vproject_path": meta["vproject_path"],
        "content_dir": meta["content_dir"],
        "opened_files": meta.get("opened_files") or [],
        "total_verse_files": meta.get("total_verse_files"),
        "target_files": meta.get("target_files") or [],
        "unreadable_files": meta.get("unreadable_files") or [],
        "auto_open_capped": bool(meta.get("capped")),
        "max_auto_files": meta.get("max_auto_files"),
        "targets_not_analyzed": targets_not_analyzed,
        "version_note": meta.get("version_note"),
        "vproject_regression": meta.get("vproject_regression") or {"detected": False},
        "diagnostics": findings,
        "summary": {
            "total": len(findings),
            "by_severity": counts,
            "by_origin": origin_counts,
            "origin_line": _origin_split_line(origin_counts),
        },
    }
    print(json.dumps(obj, indent=2))


# ==========================================================================
# CLI
# ==========================================================================

USAGE = (
    "usage: verse_lsp_check.py <uefn-project-root-or-Content-dir> [--json] "
    "[--timeout <seconds>] [--target <path-or-glob>]... [--max-auto-files <n>]\n"
    "  --target may be repeated; each is an absolute path, a path relative "
    "to the Content dir, or a glob. Named targets are always opened, "
    "independent of --max-auto-files.\n"
    "exit codes: 0=clean  1=diagnostics found  2=usage error  "
    "3=PRECONDITIONS NOT MET (analysis did not run -- never a clean pass)  "
    "4=a --target file was not analyzed (never a clean pass or a findings result)"
)


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv

    json_mode = False
    timeout = DEFAULT_TIMEOUT_SECONDS
    max_auto_files = DEFAULT_MAX_AUTO_OPEN_FILES
    raw_targets = []
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
        elif arg == "--target":
            i += 1
            if i >= len(argv):
                print("verse_lsp_check: --target requires a value", file=sys.stderr)
                return EXIT_USAGE_ERROR
            raw_targets.append(argv[i])
        elif arg.startswith("--target="):
            raw_targets.append(arg.split("=", 1)[1])
        elif arg == "--max-auto-files":
            i += 1
            if i >= len(argv):
                print("verse_lsp_check: --max-auto-files requires a value", file=sys.stderr)
                return EXIT_USAGE_ERROR
            try:
                max_auto_files = int(argv[i])
            except ValueError:
                print(f"verse_lsp_check: --max-auto-files value is not an integer: {argv[i]!r}", file=sys.stderr)
                return EXIT_USAGE_ERROR
            if max_auto_files < 0:
                print("verse_lsp_check: --max-auto-files must be >= 0", file=sys.stderr)
                return EXIT_USAGE_ERROR
        elif arg.startswith("--max-auto-files="):
            try:
                max_auto_files = int(arg.split("=", 1)[1])
            except ValueError:
                print(f"verse_lsp_check: --max-auto-files value is not an integer: {arg!r}", file=sys.stderr)
                return EXIT_USAGE_ERROR
            if max_auto_files < 0:
                print("verse_lsp_check: --max-auto-files must be >= 0", file=sys.stderr)
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

    # ---- resolve --target argument(s), if any -------------------------------
    # Deliberately done BEFORE the (slower) LSP/vproject discovery steps: a
    # bad --target value is a usage error and should fail fast, never a
    # silent skip.
    ordered_targets = []
    if raw_targets:
        resolved_targets, unmatched_targets = _resolve_targets(raw_targets, content_dir)
        if unmatched_targets:
            lines = ["The following --target argument(s) matched no file on disk:"]
            for raw, pattern in unmatched_targets:
                lines.append(f"  {raw!r} (resolved against: {pattern})")
            lines.append(
                "--target accepts an absolute path, a path relative to the Content "
                f"directory ({content_dir}), or a glob pattern in either form."
            )
            if json_mode:
                print(json.dumps({"status": "usage_error", "reason": "target_not_found", "messages": lines}, indent=2))
            else:
                print("verse_lsp_check: USAGE ERROR", file=sys.stderr)
                for line in lines:
                    print(line, file=sys.stderr)
            return EXIT_USAGE_ERROR
        seen_target_canon = set()
        for t in resolved_targets:
            c = _canon_path(t)
            if c in seen_target_canon:
                continue
            seen_target_canon.add(c)
            ordered_targets.append(t)

    # ---- STEP 1: locate verse-lsp(.exe) -----------------------------------
    chosen_lsp, all_lsp_candidates, searched_roots, override_error = locate_lsp_exe()
    if chosen_lsp is None:
        return _fail_precondition(
            json_mode, "verse_lsp_not_found",
            _extension_not_found_lines(searched_roots, override_error),
        )

    # ---- STEP 2: locate the matching .vproject -----------------------------
    vp_entry, vp_info = locate_vproject(str(content_dir))
    # Passive, fail-open evidence recorder -- see `_update_vproject_watch`
    # and the block above `locate_vproject`. Runs on EVERY vproject parse
    # this tool does, whether the run then succeeds or fails; never changes
    # the outcome below, only adds context lines/fields alongside it. The
    # try/except here is a SECOND, belt-and-suspenders layer on top of the
    # function's own internal fail-open handling -- this instrumentation
    # must never be able to alter the exit code, no matter what.
    try:
        vproject_watch_notes, vproject_regression = _update_vproject_watch(project_root, vp_info)
    except Exception as exc:
        vproject_watch_notes = [f"vproject watch: internal error ({exc}) -- skipped; did not affect analysis."]
        vproject_regression = {"detected": False}
    if vp_entry is None:
        return _fail_precondition(
            json_mode,
            f"vproject_{vp_info['reason']}",
            _vproject_failure_lines(vp_info, content_dir) + vproject_watch_notes,
            extra_json={"vproject_regression": vproject_regression},
        )

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
    if not verse_files and not ordered_targets:
        return _fail_precondition(
            json_mode, "no_verse_files",
            [
                f"The Content directory {content_dir} contains zero *.verse files, and no "
                "--target was given -- there is nothing to analyse."
            ],
        )

    # Named --target files are added FIRST and UNCONDITIONALLY, independent
    # of os.walk order and independent of --max-auto-files. Auto-discovery
    # (the sorted walk below) then fills in up to `max_auto_files` MORE
    # files as cheap redundant sampling, skipping anything already covered
    # by an explicit target -- see DEFAULT_MAX_AUTO_OPEN_FILES for why that
    # budget is kept small by default.
    target_canon = {_canon_path(t) for t in ordered_targets}
    auto_pool = [f for f in verse_files if _canon_path(f) not in target_canon]
    auto_selected = auto_pool[:max_auto_files] if max_auto_files > 0 else []
    capped = len(auto_pool) > len(auto_selected)
    files_to_open = ordered_targets + auto_selected

    if not files_to_open:
        return _fail_precondition(
            json_mode, "no_files_selected_to_open",
            [
                f"{len(verse_files)} .verse file(s) exist under {content_dir}, but zero were "
                f"selected to open (--max-auto-files is {max_auto_files} and no --target was "
                "given). Pass --target to name specific file(s), or raise --max-auto-files.",
            ],
        )

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

    opened_files = session.get("opened_files") or []
    unreadable_files = session.get("unreadable_files") or []
    findings = _normalize_diagnostics(
        session["diagnostics"],
        _canon_path(content_dir),
        _canon_path(vp_entry["digest_root"]),
    )

    # Cross-check every requested --target against what was ACTUALLY
    # analyzed: it counts as analyzed if `didOpen` was sent successfully
    # (opened_files) OR the server independently published a diagnostics
    # message keyed to it. The OR is deliberate and empirically justified,
    # not the stricter "must have a diagnostics-key hit": a live wire probe
    # against the real server showed it NEVER publishes anything -- not even
    # an empty array -- for a file that is genuinely clean, while it DOES
    # publish live for a file with a real error. Requiring a diagnostics-key
    # hit would therefore flag every clean --target as "not analyzed", a
    # false-alarm storm. See the module docstring's EXIT CODES section
    # (exit 4) for the full evidence. A target in neither set was requested
    # but never even opened (e.g. unreadable), which must never present as
    # clean or as ordinary findings.
    analyzed_canon = {_canon_path(p) for p in opened_files}
    for uri in session["diagnostics"].keys():
        try:
            analyzed_canon.add(_canon_path(_uri_to_path(uri)))
        except Exception:
            pass
    targets_not_analyzed = [t for t in ordered_targets if _canon_path(t) not in analyzed_canon]

    meta = {
        "lsp_path": chosen_lsp["path"],
        "lsp_version": chosen_lsp["version"],
        "vproject_path": vp_entry["vproject_path"],
        "content_dir": str(content_dir),
        "opened_files": opened_files,
        "total_verse_files": len(verse_files),
        "target_files": ordered_targets,
        "unreadable_files": unreadable_files,
        "capped": capped,
        "max_auto_files": max_auto_files,
        "targets_not_analyzed": targets_not_analyzed,
        "version_note": version_note,
        "vproject_watch_notes": vproject_watch_notes,
        "vproject_regression": vproject_regression,
    }

    if json_mode:
        _print_json_report(findings, meta)
    else:
        _print_human_report(findings, meta)

    if session["timed_out"]:
        note = f"verse_lsp_check: NOTE -- hit the {timeout:g}s timeout before an idle window was reached; results above may be incomplete."
        print(note, file=sys.stderr)

    if targets_not_analyzed:
        return EXIT_TARGET_NOT_ANALYZED
    return EXIT_FINDINGS if findings else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
