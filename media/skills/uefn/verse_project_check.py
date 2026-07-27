#!/usr/bin/env python3
"""Deterministic PROJECT-WIDE Verse symbol resolver: catches references to a
project's OWN types that no digest file could ever cover.

WHY THIS EXISTS
----------------
verse_lint.py (media/skills/uefn/verse_lint.py) checks single-file TEXT
shapes. The uefn-auditor verifies symbols against Epic's digest files
(Verse.digest.verse / Fortnite.digest.verse / UnrealEngine.digest.verse).
Neither can see a PROJECT'S OWN classes -- a digest only knows Epic's API
surface, and a single-file lint has no view of the module tree. A real
device file failed to compile with errors clustered on
`Events.PlayerEliminatedEvent`, where `game_event_manager` is a project
class -- neither tool could ever have caught that, because the information
needed (does this project class have this member? is it visible from this
file?) lives outside the one file being checked and outside Epic's digest.

This is the tool that supplies that missing project-wide view. See
media/skills/uefn/verse-common-errors.md, rules 20 and 21, which describe
exactly this class of error and are explicitly marked NOT lint-detectable
because they need the project module tree.

GROUND TRUTH -- Book of Verse, "Modules and Paths"
(https://verselang.github.io/book/16_modules/), quoted verbatim:
  - "Imports have file scope -- they only affect the file in which they
    appear."
  - "Relative paths (without leading '/') are resolved relative to the
    current module's location."
  - "Absolute paths (starting with '/') are resolved from the global module
    registry."
  - "When you import a module, all its public members become available in
    your code."
  - "Files within the same module can see each other's definitions without
    imports." -- this is the critical exception that prevents a huge class
    of false positives: two files in the SAME directory never need a
    `using` between them.
  - Disambiguation form: `(/Path/To/Module:)Symbol`

HOW DIRECTORY MAPS TO MODULE PATH (confirmed, not guessed)
------------------------------------------------------------
The Book of Verse chapter describes the MECHANISM (relative-vs-absolute
resolution, file scope, same-module visibility) but not, in so many words,
"a folder is a module." That mapping was confirmed empirically against a
real UEFN project before writing a line of the checker below: the project
shipped a file whose sole job is declaring an explicit module tree --

    RootModule<public> := module:
        SubModule<public> := module:
            LeafModule<public> := module{}

-- which was an EXACT mirror of its own `RootModule/SubModule/LeafModule/`
directory. A class declared in a file under that directory (no explicit
`module` wrapper around the class itself) was referenced elsewhere in the
project via the bare relative name `LeafModule` from sibling directories
and via the fully-qualified `RootModule.SubModule.LeafModule.<Name>` from
unrelated locations -- consistent with the chapter's relative/absolute
split. On that basis this tool treats a file's module path as the
DOT-JOINED DIRECTORY PATH from the scan root, which is the confirmed,
observed convention, not a guess.

What is NOT confirmed and is therefore deliberately NOT modeled: whether an
explicit in-file `module:` block can locally override or nest beyond its
directory's implied path. The observed module-tree-declaration file used
such blocks only to DECLARE the (empty) module tree, never to enclose type
definitions that would need reattributing -- real project code was not
observed declaring a class inside an in-file `module:` wrapper. This tool
does not attempt to track that case; if it occurs, a class's module path
would be computed from its file's directory only, which may be incomplete
but never produces a WRONG-in-the-dangerous-direction answer (see the
safety notes below).

THE THREE CHECKS (and only these three)
------------------------------------------
A. PROJECT TYPE REFERENCED BUT NOT VISIBLE -- a type IS declared somewhere
   in the project, and the referencing file neither (a) shares its module
   (same directory), (b) has a `using` that resolves to that module
   (relative, walked up the referencing file's own ancestor chain per the
   confirmed relative-path rule; or absolute, `/`-leading), nor (c) writes
   a fully-qualified reference to it. High confidence because the symbol's
   existence in the PROJECT is proven, not assumed.
B. MEMBER MISSING ON A KNOWN PROJECT TYPE -- only when a variable's type is
   certain from an EXPLICIT annotation (a parameter, a typed field, or a
   typed binding -- never from `:=` inference or a call return). The
   member must be absent from the type AND from every ancestor whose own
   member set is itself fully known; if any ancestor cannot be resolved
   (an Epic/engine type, or anything this scan cannot see), Check B is
   suppressed for that whole class, because an inherited member would
   otherwise look missing.
C. PRIVATE MEMBER ACCESSED FROM OUTSIDE ITS DECLARING FILE -- same
   explicit-annotation requirement as (B); flags `<private>` members
   reached from a different file than the one that declared them.

SAFETY RULES (read before trusting a finding)
------------------------------------------------
  - Anything involving a NON-project type is completely out of scope. If a
    type is not declared somewhere under the scanned root, this tool says
    nothing about it -- it cannot see Epic's digest and must not guess.
  - Unknown means silent: an unparseable construct, an ambiguous type name
    (declared more than once in the project), or a class whose ancestor
    chain cannot be fully resolved all result in NO finding, never a
    guessed one.
  - No type inference, ever. Only explicit `Name : Type` annotations feed
    Check B/C. A `:=`-inferred binding is never used as a type source.
  - Root-module types (declared directly at the scan root, module path
    "") are EXCLUDED from Check A entirely -- whether Verse treats the
    root as an implicitly-visible scope was not confirmed against the
    Book of Verse chapter, so rather than guess, this tool stays silent
    for that case.
  - Single-line declaration headers only (matches verse_lint.py's own
    documented bias) -- a class/struct/field/method header that wraps
    across physical lines is silently skipped, not guessed at. Critically,
    "skipped" does NOT mean "the rest of that class is trusted as
    complete": a class with ANY unparseable line in its body is marked
    INCOMPLETELY ENUMERATED and Check B (missing-member) is suppressed for
    it entirely -- the same reasoning already applied to an unresolvable
    ancestor now also covers the class's own member list, because an
    unseen member (e.g. one behind a multi-line header) would otherwise
    look "missing" on a class that in fact declares it. A miss (Check A/C
    still run) is an acceptable cost; a false "missing member" on real
    code is not. See `build_project_index` and `resolve_member_set`.
  - Exit codes match verse_lint.py: 0 clean, 1 findings, 2 usage error, 3
    incomplete scan. Exit 3 is never a pass.
  - stdlib only. No `unreal` import. Runs standalone with UEFN closed.

WHAT THIS TOOL DOES **NOT** CATCH
------------------------------------
  - Anything about Epic/engine types (`creative_device`, `player`, digest
    symbols) -- that is the uefn-auditor's job, not this tool's.
  - Multi-line declarations (headers wrapping across lines).
  - Type correctness beyond simple bare-identifier annotations -- `?T`,
    `[]T`, `map(...)`, tuples, and generic instantiations are never used
    as an annotation source for Check B/C (deliberately: too much room to
    guess wrong).
  - Chained member access beyond one hop (`Field.Sub.Method()` checks only
    `Field.Sub`, never re-resolves `Sub`'s own type to check `.Method`).
  - Any effect-system, failure-context, or syntax rule -- see
    verse_lint.py and verse-common-errors.md for those.
  - Whether a project class with NO declared superclass might still
    inherit undocumented universal members from the Verse runtime itself;
    this tool assumes it does not, which is the same assumption the Book
    of Verse chapter gives no reason to doubt but that was not separately,
    independently confirmed.

USAGE
-----
    python verse_project_check.py <project-root-directory>

Also importable: `build_project_index(root)` and
`check_project_index(index)` for callers (including tests) that want the
structured data or finding dicts directly rather than parsing CLI output.
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

# --------------------------------------------------------------------------
# Low-level text helpers (deliberately duplicated from verse_lint.py rather
# than imported -- these two tools have different jobs and must stay able to
# evolve independently; see the module docstring).
# --------------------------------------------------------------------------


def _mask_strings_and_strip_comment(line: str) -> str:
    """Same masking behavior as verse_lint.py's helper: string-literal
    interiors become 'x', a `#` comment (outside a string) truncates the
    rest of the physical line. Keeps column positions stable for everything
    outside strings/comments."""
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
                break
            else:
                out.append(ch)
    return "".join(out)


def _indent_of(line: str) -> int:
    expanded = line.expandtabs(4)
    return len(expanded) - len(expanded.lstrip(" "))


def _split_top_level(text: str, sep: str = ",") -> List[str]:
    """Split `text` on `sep`, but only at paren/brace/bracket depth 0."""
    parts = []
    depth = 0
    current = []
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        if ch == sep and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


_SPEC_RE = re.compile(r"<([A-Za-z_][A-Za-z0-9_]*)>")
_ACCESS_KEYWORDS = frozenset({"public", "private", "internal"})


def _extract_access(specs_text: str) -> str:
    found = set(_SPEC_RE.findall(specs_text or ""))
    hit = found & _ACCESS_KEYWORDS
    if "private" in hit:
        return "private"
    if "public" in hit:
        return "public"
    if "internal" in hit:
        return "internal"
    return "default"


def _is_public(specs_text: str) -> bool:
    return _extract_access(specs_text) == "public"


# --------------------------------------------------------------------------
# Declaration-shape regexes. Single-line headers only (see module docstring
# "SAFETY RULES").
# --------------------------------------------------------------------------

# One level of nested parens inside a parameter list, e.g. the callback-type
# parameter `(Callback:type{_(:enemy_spawned_payload):void}):void=` --
# observed directly in the real acceptance-test project. A flat
# `\([^()]*\)` cannot match that (it has a `(` nested inside the outer
# parens); this bounded, non-recursive approximation matches one level of
# nesting, which is all that was observed. Python's stdlib `re` has no
# general balanced-paren construct (that needs the third-party `regex`
# module, and this tool is stdlib-only), so unbounded nesting is still not
# supported -- a line needing 2+ levels is silently skipped, consistent
# with "unknown means silent" (see module docstring SAFETY RULES).
_PARENS_ONE_LEVEL = r"\((?:[^()]|\([^()]*\))*\)"

# `name<specs> := class(supers): | class<concrete>: | struct: | module{} | ...`
_TYPE_HEADER_RE = re.compile(
    r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
    r"(?P<specs>(?:\s*<[^<>]*>)*)"
    r"\s*:=\s*"
    r"(?P<kind>class|struct|interface|enum|module)\b"
    r"(?:\s*<[^<>]*>)*"
    r"(?:\s*\(\s*(?P<supers>[^()]*)\s*\))?"
    r"\s*(?P<term>:|\{\}|\{)?\s*$"
)

# `name<specs>(params)<effect-specs>:rettype= rest` (method) or
# `name<specs> : rettype = rest` (field). Distinguished by whether the
# optional `params` group is present. Effect specifiers (`<transacts>`,
# `<decides>`, `<suspends>`, ...) routinely appear AFTER the parameter list
# and before the return-type colon (e.g.
# `UseDebug<public>(Key:string)<transacts>:logic=`) -- observed directly in
# the real acceptance-test project, and an earlier version of this regex
# only allowed specifiers immediately after the NAME, which silently
# dropped every such method from the symbol table (a real false-positive
# source: ~150 spurious "missing member" findings against methods that
# plainly exist). `specs` (pre-params, used for the public/private access
# read) and the post-params effect-specifier group are deliberately
# separate captures -- only the former feeds `_extract_access`.
_MEMBER_RE = re.compile(
    r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
    r"(?P<specs>(?:\s*<[^<>]*>)*)"
    r"(?P<params>\s*" + _PARENS_ONE_LEVEL + r")?"
    r"(?:\s*<[^<>]*>)*"
    r"\s*:\s*(?P<rettype>[^=]*)"
    r"(?:=\s*(?P<rest>.*))?$"
)

# Verse EXTENSION METHOD syntax: `(Receiver:type_name).Method<specs>(params)`
# `<effect-specs>:rettype= rest` -- a free function "attached" to an
# existing type via a parenthesized receiver parameter, e.g.
# `(InTimeDate:time_date).ToFloat<public>()<transacts>:float=`. This is a
# DIFFERENT declaration shape from a class body member (see
# verse-common-errors.md rule 11, "Unknown member -- missing using
# statement") and was, before this pattern was added, invisible to this
# tool's symbol table entirely -- a real false-positive source: every
# extension-method call on an explicitly-typed variable looked like a
# missing member. Members found this way are attached to their target
# type's member set once the whole project has been scanned (the target
# type may be declared in a file visited later), see `build_project_index`.
_EXTENSION_METHOD_RE = re.compile(
    r"^\(\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*(?P<type>[A-Za-z_][A-Za-z0-9_]*)\s*\)"
    r"\.(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
    r"(?P<specs>(?:\s*<[^<>]*>)*)"
    r"(?P<params>\s*" + _PARENS_ONE_LEVEL + r")?"
    r"(?:\s*<[^<>]*>)*"
    r"\s*:\s*(?P<rettype>[^=]*)"
    r"(?:=\s*(?P<rest>.*))?$"
)

# One `Name : Type` or `?Name : Type` parameter chunk (used on the text
# INSIDE a method header's parens, already top-level-comma-split).
_PARAM_RE = re.compile(
    r"^\??(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<type>[^=]+?)\s*(?:=.*)?$"
)

# `obj.Member` -- a single member-access hop. Only ever resolved against an
# EXPLICITLY annotated `obj` (see USAGE note in the module docstring).
_USAGE_RE = re.compile(
    r"\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)"
)

_USING_RE = re.compile(r"using\s*\{\s*([^}]*)\s*\}")

# An `enum:` body member -- a BARE identifier, optionally followed by a
# single trailing comma, and nothing else on the line (comments and
# strings are already stripped by `_mask_strings_and_strip_comment` before
# this is tested). Confirmed against the real acceptance-test project: a
# dozen+ enum bodies, all exactly this shape (e.g.
# `rarity_tier<public> := enum:` followed by `Locked`, `Common`, `Rare`,
# one name per line). Deliberately narrow -- ONLY applied when the
# enclosing type's `kind == "enum"` (see `build_project_index`), so it can
# never misclassify a class/struct member line that happens to be a bare
# word (not a realistic Verse member declaration shape anyway, since those
# always carry at least a `:` or `(`).
_ENUM_MEMBER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*,?$")

_BARE_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# `@editable` or `@editable{ToolTip := ...}`, optionally followed on the
# SAME physical line by the field it decorates (e.g.
# `@editable       AllTeamSettingsDevice<public> : team_settings_and_...`
# -- observed directly in the real acceptance-test project, aligned into
# columns). An earlier version of this tool only recognized a bare
# `@editable` consuming the WHOLE line, which silently swallowed every
# same-line-decorated field -- a real false-positive source, since that
# field then never entered the symbol table at all.
_EDITABLE_PREFIX_RE = re.compile(r"^@editable(?:\{[^{}]*\})?\s*")

# `var` keyword prefix, with the boundary check that lets it match `var<...>`
# (specifier attached directly, no space) as well as the ordinary `var Foo`
# (whitespace-separated) form, WITHOUT also matching an identifier that
# merely starts with the letters "var" (e.g. `variable`, `varyingField`) --
# `\b` requires the character right after "var" to be a non-word character,
# which is true for both a space and a literal `<`, but false when "var" is
# immediately followed by another word character.
_VAR_KEYWORD_RE = re.compile(r"^var\b\s*")
# A specifier block attached directly after `var` with no separating space,
# e.g. the `<private>` in `var<private> MovementComp : ...` -- confirmed
# directly against the real acceptance-test project (one live instance, a
# field declaration inside a component class).
_LEADING_SPECS_RE = re.compile(r"^((?:<[^<>]*>)*)\s*")
_LEADING_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*")


def _strip_var_prefix(stripped: str) -> str:
    """Strip a leading `var` keyword, handling BOTH `var Field : T` (space-
    separated, the common form) and `var<private> Field : T` (a specifier
    block attached directly to `var`, no space -- real syntax observed in
    the acceptance-test project, previously invisible to `_MEMBER_RE`
    because the old `re.sub(r"^var\\s+", ...)` strip required at least one
    space after `var` and left the whole line unmatched otherwise). A
    specifier written on `var` itself is semantically the declaration's own
    access specifier -- the same as writing it after the field name -- so
    it is relocated there, which is where `_MEMBER_RE` expects specifiers:
    `var<private> Field : T` and `var Field<private> : T` both normalize to
    `Field<private> : T`. Falls back to the plain space-based strip (or the
    original text) whenever a name can't be found after the specifier, so
    it never produces a WORSE (more silently wrong) result than before --
    just fails closed into the same "unrecognised -> incomplete" path."""
    m = _VAR_KEYWORD_RE.match(stripped)
    if not m:
        return stripped
    rest = stripped[m.end():]
    specs_match = _LEADING_SPECS_RE.match(rest)
    var_specs = specs_match.group(1) if specs_match else ""
    if not var_specs:
        return rest
    rest_after_specs = rest[specs_match.end():]
    name_match = _LEADING_IDENT_RE.match(rest_after_specs)
    if not name_match:
        return rest  # can't safely relocate the specifier -- fail closed
    name = name_match.group(0)
    tail = rest_after_specs[name_match.end():]
    return f"{name}{var_specs}{tail}"


def _is_bare_project_type(raw_type_text: str, project: "ProjectIndex") -> Optional[str]:
    """Returns the type name if `raw_type_text` is a single bare identifier
    that resolves to exactly one (non-ambiguous) project type; else None.
    Never true for `?T`, `[]T`, `map(...)`, tuples, or anything else with
    punctuation -- deliberately conservative, see module docstring."""
    t = (raw_type_text or "").strip()
    if not t or not _BARE_IDENT_RE.match(t):
        return None
    if t in project.ambiguous_types:
        return None
    if t not in project.types:
        return None
    return t


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------


@dataclass
class MemberInfo:
    name: str
    kind: str  # "field" | "method"
    access: str  # "public" | "private" | "internal" | "default"
    line: int
    declaring_file: str
    raw_type: Optional[str] = None  # for fields only; None if not a bare type
    is_editable: bool = False


@dataclass
class TypeInfo:
    name: str
    kind: str  # "class" | "struct" | "interface" | "enum"
    module_path: str
    file: str
    line: int
    is_public: bool
    supers: List[str] = field(default_factory=list)
    members: Dict[str, MemberInfo] = field(default_factory=dict)
    incompletely_enumerated: bool = False


@dataclass
class FileInfo:
    path: str
    module_path: str
    text: str
    lines: List[str]
    using: List[str] = field(default_factory=list)


@dataclass
class ProjectIndex:
    root: str
    files: List[FileInfo] = field(default_factory=list)
    types: Dict[str, TypeInfo] = field(default_factory=dict)
    ambiguous_types: Set[str] = field(default_factory=set)
    skipped: List[dict] = field(default_factory=list)


def _module_path_for_file(root: str, file_path: str) -> str:
    rel_dir = os.path.relpath(os.path.dirname(file_path), root)
    if rel_dir in (".", ""):
        return ""
    parts = [p for p in rel_dir.replace("\\", "/").split("/") if p not in ("", ".")]
    return ".".join(parts)


def _ancestor_chain(module_path: str) -> List[str]:
    """[module_path, ..., parent, ..., ""] -- full path down to the root,
    used to walk a relative `using` up the referencing file's own scope
    chain (see the confirmed relative-path resolution rule)."""
    if module_path == "":
        return [""]
    parts = module_path.split(".")
    return [".".join(parts[:i]) for i in range(len(parts), -1, -1)]


def _iter_verse_files(root: str):
    if os.path.isfile(root):
        if root.endswith(".verse"):
            yield root
        return
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if name.endswith(".verse"):
                yield os.path.join(dirpath, name)


# --------------------------------------------------------------------------
# Pass 1: build the project symbol table
# --------------------------------------------------------------------------


def build_project_index(root: str) -> ProjectIndex:
    project = ProjectIndex(root=root)
    name_seen: Dict[str, int] = {}
    # Extension methods (see _EXTENSION_METHOD_RE) are collected across ALL
    # files first, then attached to their target types once every file has
    # been scanned -- the target type may be declared in a file visited
    # AFTER the one declaring the extension method.
    pending_extensions: List[tuple] = []

    for file_path in sorted(_iter_verse_files(root)):
        try:
            with open(file_path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            project.skipped.append({"path": file_path, "reason": str(exc)})
            continue

        module_path = _module_path_for_file(root, file_path)
        lines = text.splitlines()
        finfo = FileInfo(path=file_path, module_path=module_path, text=text, lines=lines)
        project.files.append(finfo)

        # Stack of {"indent", "kind": "type"|"other", "type_info"}.
        stack: List[dict] = []
        pending_editable = False

        for raw_line in lines:
            masked = _mask_strings_and_strip_comment(raw_line)
            stripped = masked.strip()

            using_match = _USING_RE.search(masked)
            if using_match:
                finfo.using.append(using_match.group(1).strip())

            if not stripped:
                continue

            indent = _indent_of(raw_line)
            while stack and stack[-1]["indent"] >= indent:
                stack.pop()
            current_type = None
            if stack and stack[-1]["kind"] == "type":
                current_type = stack[-1]["type_info"]

            editable_here = False
            if stripped.startswith("@editable"):
                editable_prefix = _EDITABLE_PREFIX_RE.match(stripped)
                remainder = stripped[editable_prefix.end():].strip() if editable_prefix else ""
                if not remainder:
                    pending_editable = True
                    continue
                # Same-line `@editable <field decl>` -- fall through and
                # process `remainder` as the actual declaration below.
                editable_here = True
                stripped = remainder

            extension_match = _EXTENSION_METHOD_RE.match(stripped)
            if extension_match:
                target_type = extension_match.group("type")
                mname = extension_match.group("name")
                minfo = MemberInfo(
                    name=mname,
                    kind="method",
                    access=_extract_access(extension_match.group("specs")),
                    line=0,
                    declaring_file=file_path,
                )
                pending_extensions.append((target_type, minfo))
                rest = (extension_match.group("rest") or "").strip()
                pending_editable = False
                if rest == "" or rest == "{":
                    stack.append({"indent": indent, "kind": "other", "type_info": None})
                continue

            type_header = _TYPE_HEADER_RE.match(stripped)
            if type_header and type_header.group("kind") in ("class", "struct", "interface", "enum"):
                name = type_header.group("name")
                supers_raw = type_header.group("supers") or ""
                supers = [s.strip() for s in _split_top_level(supers_raw, ",") if s.strip()]
                tinfo = TypeInfo(
                    name=name,
                    kind=type_header.group("kind"),
                    module_path=module_path,
                    file=file_path,
                    line=0,  # not used by any check; kept for symmetry with MemberInfo
                    is_public=_is_public(type_header.group("specs")),
                    supers=supers,
                )
                name_seen[name] = name_seen.get(name, 0) + 1
                if name_seen[name] > 1:
                    project.ambiguous_types.add(name)
                if name not in project.types:
                    project.types[name] = tinfo
                stack.append({"indent": indent, "kind": "type", "type_info": tinfo})
                pending_editable = False
                continue

            if type_header and type_header.group("kind") == "module":
                stack.append({"indent": indent, "kind": "other", "type_info": None})
                pending_editable = False
                continue

            if current_type is not None and current_type.kind == "enum":
                enum_match = _ENUM_MEMBER_RE.match(stripped)
                if enum_match:
                    ename = stripped.rstrip(",")
                    current_type.members[ename] = MemberInfo(
                        name=ename,
                        kind="enumerator",
                        access="public",
                        line=0,
                        declaring_file=file_path,
                    )
                elif not using_match:
                    # Same "unrecognised means incomplete" rule as the
                    # general class-member branch below -- an enum body
                    # line that is neither a bare identifier nor a `using`
                    # is something this tool does not understand, so the
                    # enum's member list can no longer be trusted complete.
                    current_type.incompletely_enumerated = True
                pending_editable = False
                continue

            if current_type is not None:
                line_no_var = _strip_var_prefix(stripped)
                member_match = _MEMBER_RE.match(line_no_var)
                pushed = False
                if member_match:
                    mname = member_match.group("name")
                    if member_match.group("params") is not None:
                        current_type.members[mname] = MemberInfo(
                            name=mname,
                            kind="method",
                            access=_extract_access(member_match.group("specs")),
                            line=0,
                            declaring_file=file_path,
                        )
                        rest = (member_match.group("rest") or "").strip()
                        if rest == "" or rest == "{":
                            stack.append({"indent": indent, "kind": "other", "type_info": None})
                            pushed = True
                    else:
                        raw_type = member_match.group("rettype").strip()
                        current_type.members[mname] = MemberInfo(
                            name=mname,
                            kind="field",
                            access=_extract_access(member_match.group("specs")),
                            line=0,
                            declaring_file=file_path,
                            raw_type=raw_type or None,
                            is_editable=pending_editable or editable_here,
                        )
                elif not using_match:
                    # A non-blank, non-comment, non-`using` line sitting
                    # directly inside this class's body that neither regex
                    # could parse -- most commonly the opening (or a
                    # continuation/closing) line of a MULTI-LINE member
                    # header (see module docstring "SAFETY RULES": single-
                    # line headers only). This class's member set can no
                    # longer be trusted as complete, so mark it and
                    # suppress Check B for it entirely in
                    # `resolve_member_set` -- the same reasoning already
                    # applied there to an unresolvable ANCESTOR now also
                    # applies to the class's OWN incompletely-read members:
                    # an unseen member would otherwise look "missing".
                    # Real false positive fixed by this: a real project's
                    # multi-line `AnimateYScale(...)`/`FadeOutWidgets(...)`
                    # methods were invisible to the symbol table and every
                    # call to them was flagged as calling a non-existent
                    # member.
                    current_type.incompletely_enumerated = True
                pending_editable = False
                if pushed:
                    continue

            pending_editable = False
            # Generic block-open tracking so indentation-based scoping stays
            # accurate even outside a type body (nested if/for/functions).
            if stripped.endswith(":"):
                stack.append({"indent": indent, "kind": "other", "type_info": None})
            elif stripped.endswith("{") and not stripped.endswith("{}"):
                stack.append({"indent": indent, "kind": "other", "type_info": None})
            elif stripped.endswith("=") and "(" in stripped:
                stack.append({"indent": indent, "kind": "other", "type_info": None})

    # Attach collected extension methods now that every file's types are
    # known. Skip silently for an unknown or ambiguous target type (SAFETY
    # RULES), and never overwrite a member already declared inside the
    # type's own body (setdefault -- a body-declared member is more
    # specific than a same-named extension method, though real code is not
    # expected to define both).
    for target_type, minfo in pending_extensions:
        if target_type in project.ambiguous_types or target_type not in project.types:
            continue
        project.types[target_type].members.setdefault(minfo.name, minfo)

    return project


# --------------------------------------------------------------------------
# Pass 2, Check B/C support: resolve a class's full member set (own +
# ancestors), or None if any ancestor cannot be fully resolved.
# --------------------------------------------------------------------------


def resolve_member_set(
    type_name: str,
    project: ProjectIndex,
    memo: Dict[str, Optional[Dict[str, MemberInfo]]],
    _visiting: Optional[Set[str]] = None,
) -> Optional[Dict[str, MemberInfo]]:
    if type_name in memo:
        return memo[type_name]
    if type_name in project.ambiguous_types or type_name not in project.types:
        memo[type_name] = None
        return None
    _visiting = _visiting or set()
    if type_name in _visiting:
        memo[type_name] = None  # defensive cycle guard
        return None
    _visiting = _visiting | {type_name}

    tinfo = project.types[type_name]
    if tinfo.incompletely_enumerated:
        # This class has at least one member declaration this tool could
        # not parse (most commonly a multi-line header -- see
        # `build_project_index`). Its OWN member set can't be trusted as
        # complete, so -- exactly like an unresolvable ancestor -- suppress
        # Check B entirely rather than risk flagging a real member as
        # "missing". Check A (type visibility) and Check C (private access)
        # do not depend on a complete member list and are unaffected.
        memo[type_name] = None
        return None
    merged: Dict[str, MemberInfo] = {}
    for super_name in tinfo.supers:
        parent_set = resolve_member_set(super_name, project, memo, _visiting)
        if parent_set is None:
            memo[type_name] = None  # unknown ancestor -> suppress Check B for this class
            return None
        merged.update(parent_set)
    merged.update(tinfo.members)
    memo[type_name] = merged
    return merged


def resolve_member_set_best_effort(
    type_name: str,
    project: ProjectIndex,
    _visiting: Optional[Set[str]] = None,
) -> Dict[str, MemberInfo]:
    """Like `resolve_member_set`, but NEVER collapses to "unknown" (None)
    just because the class or an ancestor is incompletely-enumerated or
    unresolvable -- it merges whatever WAS successfully parsed and silently
    skips whatever wasn't (an ambiguous/unknown/unresolvable super
    contributes nothing rather than aborting the whole result).

    Used ONLY by Check C (private-access): that check only needs the
    access level of a member that WAS successfully parsed, and never has
    to prove a member's ABSENCE the way Check B does -- so a class's own
    parse-incompleteness (which correctly suppresses Check B, see
    `resolve_member_set`) must NOT also suppress Check C. A member found
    here is exactly as trustworthy as one found by the strict resolver;
    this function only widens what counts as "found", never what counts
    as "private"."""
    if type_name in project.ambiguous_types or type_name not in project.types:
        return {}
    _visiting = _visiting or set()
    if type_name in _visiting:
        return {}
    _visiting = _visiting | {type_name}

    tinfo = project.types[type_name]
    merged: Dict[str, MemberInfo] = {}
    for super_name in tinfo.supers:
        merged.update(resolve_member_set_best_effort(super_name, project, _visiting))
    merged.update(tinfo.members)
    return merged


# --------------------------------------------------------------------------
# Pass 2, Check A: project type referenced but not visible.
# --------------------------------------------------------------------------

_WORD_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")


def _using_covers(file_module_path: str, using_list: List[str], target_module_path: str) -> bool:
    if target_module_path == "":
        return True  # never reached (caller excludes root-module targets), kept for safety
    for raw in using_list:
        u = raw.strip()
        if not u:
            continue
        if u.startswith("/"):
            candidate = u[1:].replace("/", ".")
            if candidate == target_module_path or candidate.endswith("." + target_module_path):
                return True
        else:
            u_dotted = u.strip()
            for anc in _ancestor_chain(file_module_path):
                candidate = (anc + "." + u_dotted) if anc else u_dotted
                candidate = candidate.strip(".")
                if candidate == target_module_path:
                    return True
    return False


def _qualified_reference_present(file_module_path: str, text: str, module_path: str, type_name: str) -> bool:
    """True if `text` contains a reference to `type_name` that is already
    qualified enough to resolve without a `using` -- either the Book of
    Verse's parenthesized disambiguation form `(/Path:)Symbol`, or an
    inline DOTTED prefix immediately before the type name (e.g.
    `Features.UIAnimations.flyup_widget_pool_manager`). The dotted case is
    resolved through the SAME relative/absolute rule as a `using` value
    (see `_using_covers`) -- confirmed directly against the real
    acceptance-test project, where a file several directories deep
    referenced a sibling-branch type via a PARTIAL dotted path (e.g.
    `SubModuleA.LeafModule.some_type`, omitting the shared root the two
    files' modules both descend from) with no `using` at all: that only
    resolves because Verse's relative-path rule ("resolved relative to the
    current module's location") applies to ANY reference, not only `using`
    statements -- an earlier version of this function only matched the
    FULL absolute dotted path and produced a false positive here."""
    if module_path == "":
        return False
    slash = module_path.replace(".", "/")
    if ("(/" + slash + ":)") in text or ("(/" + slash + ":") in text:
        return True
    prefix_re = re.compile(
        r"([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\." + re.escape(type_name) + r"\b"
    )
    for m in prefix_re.finditer(text):
        if _using_covers(file_module_path, [m.group(1)], module_path):
            return True
    return False


def _type_position_line_numbers(finfo: "FileInfo", type_name: str) -> List[int]:
    """Line numbers where `type_name` occurs in an UNAMBIGUOUS TYPE
    POSITION: a type annotation (`: TypeName`, with optional `?` / `[]`
    modifiers -- the shared textual shape of a parameter, field, return-
    type, and local-binding annotation alike), a superclass/interface
    position (`class(TypeName, ...)` / `interface(TypeName, ...)`), or an
    instantiation (`TypeName{` -- Verse's struct/class archetype-literal
    form). Deliberately NOT `TypeName(`: that is an ORDINARY FUNCTION CALL
    in Verse, not a constructor, and treating it as an instantiation was
    the exact shape of a real false positive -- a project class name
    collided with an unrelated, unrelated-module `<private>` method of the
    same spelling, called as `Name(...)`, and got reported as an invisible
    type reference. A bare word match with none of these shapes (a local
    method, field, or parameter that merely happens to share the type's
    name) is never returned -- see module docstring bias toward silence."""
    esc = re.escape(type_name)
    annotation_re = re.compile(r":\s*\??(?:\[\])?" + esc + r"\b")
    instantiate_re = re.compile(r"\b" + esc + r"\s*\{")
    super_kw_re = re.compile(r"\b(?:class|interface)\b[^:{}\n]*\(([^()]*)\)")
    hits = []
    for line_no, raw_line in enumerate(finfo.lines, start=1):
        masked = _mask_strings_and_strip_comment(raw_line)
        if annotation_re.search(masked) or instantiate_re.search(masked):
            hits.append(line_no)
            continue
        for sm in super_kw_re.finditer(masked):
            if any(s.strip() == type_name for s in _split_top_level(sm.group(1), ",")):
                hits.append(line_no)
                break
    return hits


_WALRUS_NAME_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*:=")


def _collect_locally_declared_names(finfo: "FileInfo") -> Set[str]:
    """Every name DECLARED anywhere in this file: type names, method
    names, field names, parameter names, `:=`-bound local names, and
    extension-method names. Used as a HARD SUPPRESSION for Check A: if the
    referencing file itself declares anything spelled the same as a
    candidate project type name, a bare-word occurrence of that spelling
    is almost certainly the LOCAL declaration (a method, parameter,
    variable...) rather than a reference to the unrelated project type
    elsewhere in the codebase, so Check A stays silent rather than risk a
    name-collision false positive -- confirmed directly against the real
    acceptance-test project (an unrelated `<private>` method shared a
    spelling with an unconnected project class; without this suppression
    every call to that local method was reported as an invisible type
    reference). This deliberately OVER-collects -- e.g. a call-site named
    argument (`?Name := Value`) also matches the `:=` pattern used here --
    which only makes the suppression MORE conservative, never less
    correct, matching this tool's stated bias toward silence."""
    names: Set[str] = set()
    for raw_line in finfo.lines:
        masked = _mask_strings_and_strip_comment(raw_line)
        stripped = masked.strip()
        if not stripped:
            continue
        for m in _WALRUS_NAME_RE.finditer(masked):
            names.add(m.group(1))
        type_header = _TYPE_HEADER_RE.match(stripped)
        if type_header:
            names.add(type_header.group("name"))
            continue
        ext_match = _EXTENSION_METHOD_RE.match(stripped)
        if ext_match:
            names.add(ext_match.group("name"))
            continue
        line_no_var = _strip_var_prefix(stripped)
        member_match = _MEMBER_RE.match(line_no_var)
        if member_match:
            names.add(member_match.group("name"))
            if member_match.group("params") is not None:
                params_text = member_match.group("params").strip()
                if params_text.startswith("(") and params_text.endswith(")"):
                    params_text = params_text[1:-1]
                for chunk in _split_top_level(params_text, ","):
                    chunk = chunk.strip()
                    if not chunk:
                        continue
                    pm = _PARAM_RE.match(chunk)
                    if pm:
                        names.add(pm.group("name"))
    return names


def check_type_visibility(project: ProjectIndex) -> List[dict]:
    findings = []
    for finfo in project.files:
        tokens = set(_WORD_RE.findall(finfo.text))
        candidates = tokens & set(project.types.keys())
        if not candidates:
            continue
        # Hard suppression (see `_collect_locally_declared_names`): a file
        # that declares ANYTHING spelled like a candidate type name is
        # almost certainly using that spelling locally, not referencing
        # the unrelated project type -- computed once per file, not once
        # per candidate.
        local_names = _collect_locally_declared_names(finfo)
        for type_name in sorted(candidates):
            if type_name in project.ambiguous_types:
                continue
            tinfo = project.types[type_name]
            if tinfo.file == finfo.path:
                continue
            if tinfo.module_path == finfo.module_path:
                continue  # same module -- confirmed visible without imports
            if tinfo.module_path == "":
                continue  # root-module visibility unconfirmed -- stay silent
            if type_name in local_names:
                continue  # this file declares its own thing by this name
            if _using_covers(finfo.module_path, finfo.using, tinfo.module_path):
                continue
            if _qualified_reference_present(finfo.module_path, finfo.text, tinfo.module_path, type_name):
                continue
            # Only report if SOME occurrence sits in an unambiguous TYPE
            # POSITION (annotation, superclass/interface list, or brace
            # instantiation) -- a bare word match alone (e.g. calling an
            # unrelated same-named local method with `Name(...)`) is never
            # enough. See `_type_position_line_numbers`.
            position_lines = _type_position_line_numbers(finfo, type_name)
            if not position_lines:
                continue
            findings.append(
                {
                    "path": finfo.path,
                    "line": position_lines[0],
                    "category": "missing-using",
                    "confidence": "high",
                    "message": (
                        f"[missing-using] '{type_name}' is declared in the project "
                        f"(module '{tinfo.module_path}', {tinfo.file}) but this file "
                        f"(module '{finfo.module_path or '<root>'}') has no `using` "
                        "resolving to that module and does not fully qualify the "
                        "reference. See verse-common-errors.md rule 21."
                    ),
                }
            )
    return findings


# --------------------------------------------------------------------------
# Pass 2, Checks B & C: explicitly-typed member access + private access.
# --------------------------------------------------------------------------


def check_member_access(project: ProjectIndex) -> List[dict]:
    findings_b = []
    findings_c = []
    memo: Dict[str, Optional[Dict[str, MemberInfo]]] = {}

    for finfo in project.files:
        stack: List[dict] = [{"indent": -1, "kind": "file", "type_map": {}}]

        for raw_line in finfo.lines:
            masked = _mask_strings_and_strip_comment(raw_line)
            stripped = masked.strip()
            if not stripped:
                continue
            indent = _indent_of(raw_line)
            while len(stack) > 1 and stack[-1]["indent"] >= indent:
                stack.pop()
            current_map: Dict[str, str] = stack[-1]["type_map"]

            is_using_line = stripped.startswith("using")

            type_header = _TYPE_HEADER_RE.match(stripped)
            if type_header and type_header.group("kind") in ("class", "struct", "interface", "enum"):
                type_name = type_header.group("name")
                new_map = dict(current_map)
                member_set = resolve_member_set(type_name, project, memo)
                if member_set is not None:
                    for mname, minfo in member_set.items():
                        if minfo.kind == "field" and minfo.raw_type:
                            resolved = _is_bare_project_type(minfo.raw_type, project)
                            if resolved:
                                new_map[mname] = resolved
                stack.append({"indent": indent, "kind": "type", "type_map": new_map})
                continue
            if type_header and type_header.group("kind") == "module":
                stack.append({"indent": indent, "kind": "module", "type_map": dict(current_map)})
                continue

            opens_frame = False
            if not is_using_line:
                line_no_var = _strip_var_prefix(stripped)
                member_match = _MEMBER_RE.match(line_no_var)
                if member_match:
                    if member_match.group("params") is not None:
                        param_map = {}
                        params_text = member_match.group("params").strip()
                        if params_text.startswith("(") and params_text.endswith(")"):
                            params_text = params_text[1:-1]
                        for chunk in _split_top_level(params_text, ","):
                            chunk = chunk.strip()
                            if not chunk:
                                continue
                            pm = _PARAM_RE.match(chunk)
                            if not pm:
                                continue
                            resolved = _is_bare_project_type(pm.group("type"), project)
                            if resolved:
                                param_map[pm.group("name")] = resolved
                        rest = (member_match.group("rest") or "").strip()
                        if rest == "" or rest == "{":
                            child_map = dict(current_map)
                            child_map.update(param_map)
                            stack.append({"indent": indent, "kind": "other", "type_map": child_map})
                            opens_frame = True
                    else:
                        resolved = _is_bare_project_type(member_match.group("rettype"), project)
                        rebind_name = member_match.group("name")
                        if resolved:
                            current_map[rebind_name] = resolved
                        else:
                            # A rebinding whose type we could NOT determine
                            # (e.g. `:=` inference with no bare project-
                            # class annotation, or a call return) must
                            # REMOVE any stale entry for this name
                            # inherited from an outer scope -- otherwise a
                            # shadowing rebinding like `Events := Make()`
                            # (shadowing a parameter `Events :
                            # game_event_manager`) leaves the OLD type
                            # sitting in the map, and a later
                            # `Events.MethodOnTheNewType()` gets checked
                            # against the wrong class. This still performs
                            # NO type inference -- it only forgets what is
                            # no longer known, never guesses a new type.
                            current_map.pop(rebind_name, None)

                if not opens_frame:
                    if stripped.endswith(":"):
                        stack.append({"indent": indent, "kind": "other", "type_map": dict(current_map)})
                        opens_frame = True
                    elif stripped.endswith("{") and not stripped.endswith("{}"):
                        stack.append({"indent": indent, "kind": "other", "type_map": dict(current_map)})
                        opens_frame = True

                for usage in _USAGE_RE.finditer(masked):
                    obj_name, member_name = usage.group(1), usage.group(2)
                    type_name = current_map.get(obj_name)
                    if not type_name:
                        continue
                    # Check B (missing-member) needs a PROVABLY COMPLETE
                    # member set -- suppressed (None) if the class itself
                    # is incompletely-enumerated or any ancestor is
                    # unresolvable, per resolve_member_set.
                    member_set = resolve_member_set(type_name, project, memo)
                    if member_set is not None and member_set.get(member_name) is None:
                        findings_b.append(
                            {
                                "path": finfo.path,
                                "line": finfo.lines.index(raw_line) + 1,
                                "category": "missing-member",
                                "confidence": "high",
                                "message": (
                                    f"[missing-member] '{obj_name}' is explicitly typed as "
                                    f"project class '{type_name}', which has no member "
                                    f"'{member_name}' (own + fully-resolved ancestors)."
                                ),
                            }
                        )
                        continue
                    # Check C (private-access) only needs to know the
                    # access level of a member that WAS successfully
                    # parsed -- it never has to prove a member's ABSENCE,
                    # so it is NOT gated on the class (or its ancestors)
                    # being completely enumerated. Uses a best-effort
                    # resolution that merges whatever was parsed rather
                    # than aborting to None on the first unresolvable part.
                    best_effort = resolve_member_set_best_effort(type_name, project)
                    minfo = best_effort.get(member_name)
                    if minfo is None:
                        continue
                    if minfo.access == "private" and minfo.declaring_file != finfo.path:
                        findings_c.append(
                            {
                                "path": finfo.path,
                                "line": finfo.lines.index(raw_line) + 1,
                                "category": "private-access",
                                "confidence": "high",
                                "message": (
                                    f"[private-access] '{obj_name}.{member_name}' accesses a "
                                    f"<private> member of project class '{type_name}' declared "
                                    f"in {minfo.declaring_file}, from a different file."
                                ),
                            }
                        )

        # end line loop

    return findings_b + findings_c


# --------------------------------------------------------------------------
# Orchestration / CLI
# --------------------------------------------------------------------------

SCOPE_NOTE = (
    "verse_project_check analyses ONLY the project's OWN types (declared "
    "under the scanned root) and ONLY three checks: (A) a project type "
    "referenced without a resolving `using`/qualification, (B) a member "
    "access against an EXPLICITLY-typed project class missing that member, "
    "(C) a <private> member accessed from a file other than the one that "
    "declared it. It does not know Epic's digest and says NOTHING about "
    "non-project types. It never performs type inference -- only explicit "
    "`Name : Type` annotations feed checks B/C. See the module docstring "
    "for the full list of what this does not catch."
)

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE_ERROR = 2
EXIT_INCOMPLETE_SCAN = 3


def check_project_index(project: ProjectIndex) -> List[dict]:
    findings = check_type_visibility(project)
    findings.extend(check_member_access(project))
    findings.sort(key=lambda f: (f["path"], f["line"]))
    return findings


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print("usage: verse_project_check.py <project-root-directory>", file=sys.stderr)
        print(
            "exit codes: 0=clean  1=findings exist  2=bad usage / path not "
            "found  3=INCOMPLETE SCAN -- code 3 means the result cannot be "
            "trusted as clean, even if it printed '0 findings'.",
            file=sys.stderr,
        )
        print(SCOPE_NOTE, file=sys.stderr)
        return EXIT_USAGE_ERROR

    root = argv[0]
    if not os.path.exists(root):
        print(f"verse_project_check: path not found: {root}", file=sys.stderr)
        return EXIT_USAGE_ERROR

    project = build_project_index(root)
    findings = check_project_index(project)

    for finding in findings:
        print(f"{finding['path']}:{finding['line']}: {finding['message']}")

    if findings:
        print(f"\nverse_project_check: {len(findings)} finding(s).")
    else:
        print("verse_project_check: 0 findings.")

    print(f"verse_project_check: scanned {len(project.files)} file(s) successfully.")
    print(
        f"verse_project_check: {len(project.types)} unique project type(s) indexed "
        f"({len(project.ambiguous_types)} name(s) declared more than once and "
        "excluded from all checks as ambiguous)."
    )
    incompletely_enumerated = [t for t in project.types.values() if t.incompletely_enumerated]
    if incompletely_enumerated:
        print(
            f"verse_project_check: {len(incompletely_enumerated)} class(es) have at "
            "least one member declaration this tool could not parse (most often a "
            "multi-line header) -- Check B (missing-member) is SUPPRESSED for each "
            "of them; their member lists are known-incomplete, not known-clean:"
        )
        for t in sorted(incompletely_enumerated, key=lambda t: (t.file, t.name)):
            print(f"  INCOMPLETE {t.name} ({t.file})")

    incomplete = bool(project.skipped) or (len(project.files) == 0)
    if project.skipped:
        print(f"verse_project_check: WARNING -- {len(project.skipped)} file(s) could NOT be scanned:")
        for item in project.skipped:
            print(f"  SKIPPED {item['path']}: {item['reason']}")
    if len(project.files) == 0 and not project.skipped:
        print("verse_project_check: WARNING -- zero .verse files were found under the given root.")

    print(SCOPE_NOTE)

    if incomplete:
        print(
            f"verse_project_check: INCOMPLETE SCAN (exit {EXIT_INCOMPLETE_SCAN}) -- "
            "the result above, including any '0 findings' line, is NOT a "
            "clean-pass guarantee."
        )
        return EXIT_INCOMPLETE_SCAN

    return EXIT_FINDINGS if findings else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
