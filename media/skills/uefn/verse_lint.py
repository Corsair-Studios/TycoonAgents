#!/usr/bin/env python3
"""Deterministic Verse lint: unguarded map/array subscript writes.

WHY THIS EXISTS
----------------
A real creator's Verse file failed to compile with:

    "This invocation calls a function that has the 'decides' effect, which
    is not allowed by its context"

...twice, both `set Map[Key] = Value` map writes missing a failure context
(see media/skills/uefn/verse-common-errors.md, "#3 Failure contexts"). Two
LLM agents (verse-expert, uefn-auditor) both missed it despite that 1,427
line reference covering the exact rule. That is not an LLM-recall problem,
it is a MECHANICAL one: whether a `set X[K] = V` statement sits inside a
failure context is a structural, indentation-driven fact about the source
text, not something that should depend on a model remembering a doc.

WHAT THIS CHECKS (and ONLY this)
---------------------------------
A write to a map/array subscript — `set <expr>[<key>] = <value>` — that is
not enclosed by anything that permits Verse's `<decides>` effect:
`if:` / `if (...)`, `for`, `option{...}`, or an enclosing function/method
declared `<decides>` in its effect specifiers.

WHAT THIS DOES **NOT** CHECK
------------------------------
This is a narrow, single-purpose structural lint, NOT a Verse parser and
NOT a compiler. A clean run (zero findings) is NOT proof a file compiles.
In particular it does NOT catch:

  - Any other failure-context violation (bare `Array[i]` reads, bare
    `Function[...]` calls, `Mod[...]`, optional unwraps, etc.) — only the
    `set <subscript> = <value>` WRITE shape is modeled.
  - Multi-line statements where the subscript or the `=` wraps onto a
    following physical line (e.g. `set Map[\n    Key\n] = Value`). The
    detector is single-line only; such writes are silently NOT flagged.
  - Effect permission nuances inside concurrency blocks (`spawn:`, `sync:`,
    `race:`, `rush:`, `branch:`) — these are modeled as NON-permitting,
    which matches Verse's actual rules for those blocks, but the modeling
    is heuristic, not a real parse of the concurrency spec.
  - Any Verse error class other than this one (missing `using`, visibility,
    `<suspends>` omission, etc. — see verse-common-errors.md for those).
  - A same-line guard (`if (...)`, `for (...)`, `option{...}`) that wraps
    across multiple physical lines before it closes -- e.g. an `if (`
    opener on one line with the write on the next. The same-line guard
    check (`_is_inline_guarded`) only looks at the physical line
    containing the write itself, so a write guarded this way that isn't
    ALSO covered by the indentation-based block stack (i.e. the opener
    line doesn't end in `:`/`=`/`{`) could be mis-flagged. Not observed
    in real code so far -- every real guard either closes on one line or
    opens an indented block -- but it is a known gap, not a guarantee.

DESIGN BIAS: FALSE NEGATIVES OVER FALSE POSITIVES
----------------------------------------------------
This project already shipped one false-positive regression (a moderation
scanner that cried "BLOCKER" on clean content) and learned the lesson: a
lint that cries wolf gets ignored, and then it is worse than nothing. When
the indentation/paren structure is ambiguous, this lint stays SILENT rather
than guessing. Concretely:
  - `if (set Map[Key] = Value) {}` (write inlined in the `if` CONDITION) is
    a valid failure context and is never flagged.
  - Any construct this module doesn't recognize as a failure context is
    treated as non-permitting ONLY when the write is directly, unambiguously
    inside it with no enclosing if/for/option/<decides> anywhere above it —
    it does not try to guess semantics for constructs it can't parse.

USAGE
-----
    python verse_lint.py <file-or-directory> [<file-or-directory> ...]

Exits non-zero iff any finding was reported. Human-readable output is
`path:line: message`, one finding per line.

Also importable: `lint_verse_source(text, path)` returns a list of finding
dicts (`path`, `line`, `column`, `target`, `key`, `message`) so callers
(including tests) can exercise the real detection logic directly rather
than parsing CLI output.

EXIT CODES
----------
    0  clean -- findings == 0 AND every matched file was read successfully.
    1  findings exist -- the scan completed, at least one is unguarded.
    2  bad usage -- no args, or a given path does not exist.
    3  INCOMPLETE SCAN -- a file matched `*.verse` but could not be read or
       decoded, or zero `*.verse` files were found under the target(s) at
       all. This is DELIBERATELY distinct from exit 1: a run that could not
       check everything must never be indistinguishable from a clean run,
       even when it prints "0 findings" -- that distinction is the whole
       point of this code existing.
"""
from __future__ import annotations

import os
import re
import sys

SCOPE_NOTE = (
    "verse_lint checks ONLY unguarded 'set Map[Key] = Value' subscript "
    "writes missing a failure context. A clean (0-finding) run is NOT a "
    "compile guarantee -- see the module docstring for what it does not "
    "catch."
)

# Keywords whose colon-block body is a failure context (permits the
# `decides` effect for everything directly inside it).
_PERMITTING_KEYWORDS = frozenset({"if", "for", "option"})

# `set <dotted-name>[<key>] =` (not `==`, not `:=`) -- the write shape.
_WRITE_RE = re.compile(
    r"\bset\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\[([^\[\]]*)\]\s*=(?!=)"
)

# A block header that ends in ':' -- `if:`, `if (...):`, `for (...):`,
# `else:`, `then:`, `class:`, etc. Captures the leading keyword, if any.
_COLON_HEADER_KEYWORD_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\b")

# A function/method header: ends in '=' and has a parenthesized param list
# somewhere before it, e.g. `Foo<public><decides>(X:int):void=`.
_FUNCTION_HEADER_RE = re.compile(r"\(.*\)")
_DECIDES_SPECIFIER_RE = re.compile(r"<[^<>]*\bdecides\b[^<>]*>")

# `option{` opening an unclosed brace scope, e.g. the documented idiom
# `Result : ?logic = option{`. Requires a non-identifier char (or start of
# line) immediately before `option` so `my_option{`/`options{` do NOT
# match -- only the bare keyword, optionally followed by whitespace, then
# the trailing unmatched '{'.
_OPTION_BRACE_OPEN_RE = re.compile(r"(?<![A-Za-z0-9_])option\s*\{$")

# Same `option` keyword check, but used mid-line (no trailing '{' in the
# pattern itself -- the caller has already located the '{' character and
# passes everything BEFORE it) to recognise a same-line, already-closed
# `option{ ... }` guard, e.g. `option{ set Map[Key] = true }`.
_OPTION_KEYWORD_BEFORE_BRACE_RE = re.compile(r"(?<![A-Za-z0-9_])option\s*$")


def _mask_strings_and_strip_comment(line: str) -> str:
    """Return `line` with string-literal interiors replaced by 'x' and any
    `#` comment (that is NOT inside a string) truncated. Preserves column
    positions for code outside strings/comments; this is what all pattern
    matching below runs against, so a literal `#`, `[`, `]`, `=`, `(`, `)`
    inside a Verse string can never be mistaken for real syntax."""
    out = []
    in_string = False
    escape = False
    for ch in line:
        if in_string:
            if escape:
                out.append("x")
                escape = False
            elif ch == "\\":
                out.append("x")
                escape = True
            elif ch == '"':
                in_string = False
                out.append('"')
            else:
                out.append("x")
        else:
            if ch == '"':
                in_string = True
                out.append('"')
            elif ch == "#":
                break  # rest of the physical line is a comment
            else:
                out.append(ch)
    return "".join(out)


def _indent_of(line: str) -> int:
    expanded = line.expandtabs(4)
    return len(expanded) - len(expanded.lstrip(" "))


def _is_inline_guarded(masked_line: str, match_start: int) -> bool:
    """True if `match_start` (a `set ...[...] =` write) sits inside a
    same-line guard that has not yet closed by that point -- either an
    unclosed `if (` / `for (` (the write itself is the failure-context
    condition, e.g. `if (set Map[Key] = Value) {}`) or an unclosed
    `option{` (e.g. `option{ set Map[Key] = true }`). Tracks parens and
    braces as two independent stacks (real Verse code nests them cleanly,
    so this heuristic does not need to interleave the two types), each
    keyed by the token immediately preceding the opener, so
    `Foo(Bar(set X[Y] = Z))`-style nesting resolves to whichever opener is
    still unmatched. Operates on `masked_line`, which already has string
    literals masked out, so a `(` / `{` / `option` inside a string can
    never be mistaken for real syntax here."""
    prefix = masked_line[:match_start]
    paren_openers = []
    brace_is_option = []
    for idx, ch in enumerate(prefix):
        if ch == "(":
            word_match = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*$", prefix[:idx])
            paren_openers.append(word_match.group(1) if word_match else None)
        elif ch == ")":
            if paren_openers:
                paren_openers.pop()
        elif ch == "{":
            brace_is_option.append(bool(_OPTION_KEYWORD_BEFORE_BRACE_RE.search(prefix[:idx])))
        elif ch == "}":
            if brace_is_option:
                brace_is_option.pop()
    if any(kw in ("if", "for") for kw in paren_openers):
        return True
    return any(brace_is_option)


def lint_verse_source(text: str, path: str = "<string>") -> list:
    """Scan Verse source `text` for unguarded map/array subscript writes.

    Returns a list of finding dicts: {path, line, column, target, key,
    message}. Pure function, no filesystem access -- `path` is only used
    to label findings.
    """
    findings = []
    # Each stack frame: {"indent": int, "permits": bool}. A write is
    # unguarded iff NO frame currently on the stack permits `decides`.
    stack = []

    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        masked = _mask_strings_and_strip_comment(raw_line)
        stripped = masked.strip()
        if not stripped:
            continue  # blank line / pure comment: does not affect scope

        indent = _indent_of(raw_line)

        # Dedent: pop every frame whose header sits at >= this indent.
        while stack and stack[-1]["indent"] >= indent:
            stack.pop()

        currently_permits = any(frame["permits"] for frame in stack)

        # --- 1. Look for a subscript write on this line -----------------
        for match in _WRITE_RE.finditer(masked):
            if _is_inline_guarded(masked, match.start()):
                continue  # e.g. if (set Map[Key] = Value) {}
            if currently_permits:
                continue
            target, key = match.group(1), match.group(2)
            findings.append(
                {
                    "path": path,
                    "line": line_no,
                    "column": match.start() + 1,
                    "target": target,
                    "key": key,
                    "message": (
                        f"unguarded write `set {target}[{key}] = ...` -- this "
                        "has the 'decides' effect and is not allowed by its "
                        "context (no enclosing if:/if(...)/for/option/"
                        "<decides> function found). See "
                        "verse-common-errors.md, section 3 (Failure contexts)."
                    ),
                }
            )

        # --- 2. Does this line OPEN a new indented scope for later lines?
        if stripped.endswith(":"):
            header = stripped[:-1].strip()
            keyword_match = _COLON_HEADER_KEYWORD_RE.match(header)
            keyword = keyword_match.group(1) if keyword_match else None
            permits = keyword in _PERMITTING_KEYWORDS
            stack.append({"indent": indent, "permits": permits})
        elif stripped.endswith("=") and _FUNCTION_HEADER_RE.search(stripped):
            # Function/method header, e.g. `Foo<decides>(X:int):void=`
            permits = bool(_DECIDES_SPECIFIER_RE.search(stripped))
            stack.append({"indent": indent, "permits": permits})
        elif stripped.endswith("{") and not stripped.endswith("{}"):
            # Unclosed brace block, e.g. a multi-line `option{` (rare in
            # observed real code, which favors colon blocks) -- tracked
            # conservatively via indentation like everything else. Matched
            # anywhere the line ends (e.g. `Result : ?logic = option{`,
            # the documented assignment-form idiom -- see
            # verse-common-errors.md), not only when the line starts with
            # `option`.
            permits = bool(_OPTION_BRACE_OPEN_RE.search(stripped))
            stack.append({"indent": indent, "permits": permits})

    return findings


# Exit codes. FINDINGS and INCOMPLETE_SCAN are deliberately distinct: a
# file that could not be read/decoded (or a target that matched zero
# .verse files) means the run did NOT check everything it was asked to,
# which is a different -- and more urgent -- condition than "everything
# was checked and some of it violates the rule." Collapsing the two into
# one exit code (or worse, into exit 0) is exactly the silent-failure
# pattern this lint exists to catch in the first place; a caller gating
# only on "exit != 0 means findings" must not be able to mistake an
# incomplete scan for a clean one.
EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE_ERROR = 2
EXIT_INCOMPLETE_SCAN = 3


def _iter_verse_files(root: str):
    if os.path.isfile(root):
        if root.endswith(".verse"):
            yield root
        return
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if name.endswith(".verse"):
                yield os.path.join(dirpath, name)


def lint_path(root: str):
    """Lint a single file or every .verse file under a directory.

    Returns (findings, scanned_count, skipped) where:
      - findings: combined finding dicts, sorted by (path, line).
      - scanned_count: number of files actually read and checked.
      - skipped: list of {"path", "reason"} for files that matched
        `*.verse` but could not be read or decoded (strict UTF-8 -- a
        decode error is a real problem worth surfacing, not something to
        paper over with errors="replace").

    Never raises on a per-file read/decode failure; the caller decides
    what an incomplete scan means for its exit code instead of this
    function silently continuing as if nothing happened.
    """
    findings = []
    scanned = 0
    skipped = []
    for file_path in _iter_verse_files(root):
        try:
            with open(file_path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            skipped.append({"path": file_path, "reason": str(exc)})
            continue
        findings.extend(lint_verse_source(text, file_path))
        scanned += 1
    findings.sort(key=lambda f: (f["path"], f["line"]))
    return findings, scanned, skipped


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print("usage: verse_lint.py <file-or-directory> [<file-or-directory> ...]", file=sys.stderr)
        print(
            "exit codes: 0=clean  1=findings exist  2=bad usage / path not "
            "found  3=INCOMPLETE SCAN (a file could not be read, or nothing "
            "matched *.verse) -- code 3 means the result cannot be trusted "
            "as clean, even if it printed '0 findings'.",
            file=sys.stderr,
        )
        print(SCOPE_NOTE, file=sys.stderr)
        return EXIT_USAGE_ERROR

    all_findings = []
    total_scanned = 0
    all_skipped = []
    for target in argv:
        if not os.path.exists(target):
            print(f"verse_lint: path not found: {target}", file=sys.stderr)
            return EXIT_USAGE_ERROR
        findings, scanned, skipped = lint_path(target)
        all_findings.extend(findings)
        total_scanned += scanned
        all_skipped.extend(skipped)

    all_findings.sort(key=lambda f: (f["path"], f["line"]))

    for finding in all_findings:
        print(f"{finding['path']}:{finding['line']}: {finding['message']}")

    if all_findings:
        print(f"\nverse_lint: {len(all_findings)} finding(s).")
    else:
        print("verse_lint: 0 findings.")

    print(f"verse_lint: scanned {total_scanned} file(s) successfully.")

    incomplete = bool(all_skipped) or total_scanned == 0
    if all_skipped:
        print(
            f"verse_lint: WARNING -- {len(all_skipped)} file(s) could NOT be "
            f"scanned:"
        )
        for item in all_skipped:
            print(f"  SKIPPED {item['path']}: {item['reason']}")
    if total_scanned == 0 and not all_skipped:
        print("verse_lint: WARNING -- zero .verse files were found under the given target(s).")

    print(SCOPE_NOTE)

    if incomplete:
        print(
            f"verse_lint: INCOMPLETE SCAN (exit {EXIT_INCOMPLETE_SCAN}) -- "
            "the result above, including any '0 findings' line, is NOT a "
            "clean-pass guarantee."
        )
        return EXIT_INCOMPLETE_SCAN

    return EXIT_FINDINGS if all_findings else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
