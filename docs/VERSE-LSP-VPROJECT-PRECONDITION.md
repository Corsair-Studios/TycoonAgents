# verse_lsp_check.py — The vproject It Runs Against Has No Source Package

Evidence for improving `.claude/skills/uefn/verse_lsp_check.py`, shipped and
maintained by the TycoonAgents plugin project. Observed in the `StarWars`
UEFN project on 2026-07-28, following the same session documented in
[VERSE-AGENT-COMPILE-FAILURES.md](VERSE-AGENT-COMPILE-FAILURES.md) and
[VERSE-LSP-CHECK-TARGETING.md](VERSE-LSP-CHECK-TARGETING.md).

**Scope:** the TARGETING report covers `MAX_FILES_TO_OPEN = 3` — the tool
usually never opens the file an agent cares about. This report covers a
second, independent failure that compounds with it: even when a file *is*
opened, the `.vproject` this tool points the analyzer at has no package
that could ever resolve it to the user's source tree.

## Summary

`StarWars.vproject` — the file `verse_lsp_check.py` loads to derive the
analyzer's `rootUri` and to select which files it treats as in-project —
contains exactly three packages, all `role: "External"`, `readOnly: true`,
all pointing under the UEFN data root
(`%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject\StarWars\`). None
of the three is `role: "Source"`, and none points at the user's actual
project directory
(`C:\Users\majes\OneDrive\Documents\Fortnite Projects\StarWars\Content`).
Six of the seven other `.vproject` files on this machine have a
`role: "Source"` package pointing at a real project directory; StarWars is
the outlier. `verse_lsp_check.py` does not check for a Source package at
all — it accepts any vproject with at least one package and proceeds,
producing what looks like a normal clean-or-findings run against a project
that was, in the relevant sense, never analyzed.

## Established facts, checked against the actual files

**Fact 1 (prompt's claim) — confirmed.** `StarWars.vproject`
(`C:\Users\majes\AppData\Local\UnrealEditorFortnite\Saved\VerseProject\StarWars\vproject\StarWars.vproject`,
1,904 bytes) contains exactly three packages:

```json
{
    "packages": [
        { "desc": { "name": "Verse", "dirPath": ".../VerseProject/StarWars/Verse",
            "settings": { "role": "External", ... } }, "readOnly": true },
        { "desc": { "name": "UnrealEngine", "dirPath": ".../VerseProject/StarWars/UnrealEngine",
            "settings": { "role": "External", ... } }, "readOnly": true },
        { "desc": { "name": "Fortnite", "dirPath": ".../VerseProject/StarWars/Fortnite",
            "settings": { "role": "External", ... } }, "readOnly": true }
    ]
}
```

Every `dirPath` is under
`C:/Users/majes/AppData/Local/UnrealEditorFortnite/Saved/VerseProject/StarWars/`.
No package's `dirPath` is
`C:/Users/majes/OneDrive/Documents/Fortnite Projects/StarWars/Content`, and
no package has `"role": "Source"`. Confirmed, exactly as stated.

**Fact 2 (prompt's claim) — confirmed as a direct consequence of Fact 1.**
Because no package covers the user's Content directory, nothing in this
vproject can ever resolve a file under
`C:\Users\majes\OneDrive\Documents\Fortnite Projects\StarWars\Content` to a
package the analyzer knows about — that directory currently holds 107
`.verse` files, none of them reachable through this vproject.

**Additional fact, not in the prompt's list, found during investigation.**
The vproject is also missing a package for `StarWars-Assets`, even though
that directory exists on disk and contains a generated
`Assets.digest.verse` (34,667 lines, see finding (d) below):

```
C:\Users\majes\AppData\Local\UnrealEditorFortnite\Saved\VerseProject\StarWars\
    Fortnite\           (in vproject, External)
    StarWars-Assets\    (NOT in vproject — on disk, not referenced)
    UnrealEngine\       (in vproject, External)
    Verse\              (in vproject, External)
    vproject\           (contains StarWars.vproject itself)
```

Every other project on this machine that has a Source package (see the
contrast section below) also has a matching `<Name>/Assets` External
package alongside it, pairing the Source package with its generated-assets
digest. StarWars has neither the Source package nor its Assets pair — the
whole four-package group a normal project carries (Source, Assets, plus the
three API packages) is reduced to just the three API packages.

## (a) How does the script locate a `.vproject`? Does it validate contents?

`locate_vproject()` (lines 563–636) is a two-stage process: find the
`VerseProject` data root, then find a `.vproject` file within it whose
Source package matches the requested Content directory.

Root discovery, `locate_verseproject_root()` (lines 508–560), walks
candidate base directories (`UEFN_VERSE_PROJECT_DIR` override, then
`LOCALAPPDATA`, `USERPROFILE`, `APPDATA`-derived, `PROGRAMDATA`, then a
registry scan) and accepts the first one containing at least one
`*/vproject/*.vproject` file (line 553):

```python
has_any = bool(glob.glob(os.path.join(path, "*", "vproject", "*.vproject")))
```

That is an *existence* check only — it opens nothing and reads no JSON.

Then `locate_vproject()` (lines 563–636) globs every `.vproject` under that
root (line 581: `os.path.join(root, "*", "vproject", "*.vproject")`),
parses each as JSON, and for each one searches its `packages` list for
`settings.role == "Source"` (lines 606–613):

```python
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
```

It then matches that Source package's `dirPath` against the caller's
requested Content directory (line 625):

```python
matches = [e for e in parsed_entries if _canon_path(e["source_dir"]) == target_canon]
```

So the script's *matching* logic is Source-package-aware and does the right
thing in principle: `StarWars.vproject` has no Source package, so it should
fail `locate_vproject()`'s inner loop with `"no Source-role package with a
dirPath was found"` and fall into `parse_failures`, not `parsed_entries`.

## (b) Does the script check for a Source-role package specifically?

**Yes — inside `locate_vproject()`, as quoted above.** This is where the
prompt's premise needs correcting: `StarWars.vproject` does NOT silently
pass as a match. Walking the actual code path for this project:

1. `resolve_content_dir()` resolves the user's target to
   `C:\Users\majes\OneDrive\Documents\Fortnite Projects\StarWars\Content`.
2. `locate_verseproject_root()` finds the `VerseProject` root under
   `LOCALAPPDATA` (it exists, and at least one `*/vproject/*.vproject`
   exists somewhere under it — `StarWars.vproject` itself satisfies that
   existence check even though it has no Source package).
3. `locate_vproject()` globs **all seven** `.vproject` files on this
   machine (line 581 is rooted at `root`, not scoped to `StarWars`), not
   just `StarWars.vproject`.
4. For each of the seven, it looks for a Source package. `StarWars.vproject`
   fails this check and is added to `parse_failures`, not `parsed_entries`
   (lines 612–613).
5. The five *other* vprojects that do have a Source package (see contrast
   section) are added to `parsed_entries`, but none of their Source
   `dirPath`s equal the StarWars Content directory, so `matches` (line 625)
   is empty regardless.
6. With `matches == []`, `locate_vproject()` returns
   `(None, {"reason": "no_match", "parsed_entries": [...], "parse_failures": [...]})`
   — **not** a successful resolution.

So the major finding is not "the script never checks for Source role" — it
does, and the check is correctly written. The finding is narrower and still
serious: **on this exact project, that check should already be failing the
run with exit code 3 and a `no_match` message, not producing a
clean-looking result.** The 493-diagnostic run the prompt describes is only
explainable if either (i) it predates this vproject's current state, (ii)
it was invoked with `--json`/a different target that happened to match one
of the other six vprojects' Source directories by coincidence, or (iii) a
different resolution path was in play. This could not be fully reconciled
from the files alone — see finding (d) below for what direct evidence does
support.

## (c) What triggers exit code 3, and what does the user see?

`main()` (lines 1204–1206):

```python
vp_entry, vp_info = locate_vproject(str(content_dir))
if vp_entry is None:
    return _fail_precondition(json_mode, f"vproject_{vp_info['reason']}", _vproject_failure_lines(vp_info, content_dir))
```

For the `no_match` reason specifically, `_vproject_failure_lines()`
(lines 1020–1034) builds:

```python
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
```

Given the actual state of this machine, running
`verse_lsp_check.py "C:\Users\majes\OneDrive\Documents\Fortnite Projects\StarWars\Content"`
today should print something like:

```
verse_lsp_check: PRECONDITION NOT MET -- analysis did NOT run.
Found 7 .vproject file(s), but none of their Source package directories match the Content directory given to this tool:
  target: C:\Users\majes\OneDrive\Documents\Fortnite Projects\StarWars\Content
Source directories that WERE found:
  C:\Users\majes\OneDrive\Documents\Fortnite Projects\AnimatedUILesson\Plugins\AnimatedUILesson\Content  (workspace 'AnimatedUILesson')
  C:\Users\majes\OneDrive\Documents\Fortnite Projects\ChaosValley_\Plugins\ChaosValley\Content  (workspace 'ChaosValley')
  C:\Users\majes\OneDrive\Documents\Fortnite Projects\Rogue_Map_Work_01\Content  (workspace 'Rogue_Map_Work_01')
  C:\Users\majes\OneDrive\Documents\Fortnite Projects\SRoyale\Plugins\SRoyale\Content  (workspace 'SRoyale')
  UNPARSEABLE .../StarWars/vproject/StarWars.vproject: no Source-role package with a dirPath was found
  UNPARSEABLE .../FortniteGame/vproject/FortniteGame.vproject: no Source-role package with a dirPath was found
verse_lsp_check: exiting with code 3 -- this is NOT a clean result, even though no diagnostics are listed above.
```

("`UNPARSEABLE`" is the label the script uses for this bucket, quoted
verbatim from line 1031 — it is somewhat misleading here since the JSON did
parse fine; only the Source-package search inside it failed. The listed
reason text, `"no Source-role package with a dirPath was found"`, is
accurate.) The reason string is `vproject_no_match`. This is a distinct,
loud failure — not something that could plausibly print alongside a
"0 diagnostics" or "N diagnostics" line, because `main()` returns before
reaching STEP 4 (the LSP session) at all.

## (d) What does the analyzer actually see, and is 493 consistent with that?

Given (b) and (c), **the correct current behavior of this script against
`StarWars.vproject` is to exit 3 before ever launching `verse-lsp.exe`.**
It should never reach `run_lsp_session()`, never open a single `.verse`
file, and never produce a diagnostics list at all — clean or otherwise.

This means the previously reported "493 diagnostics… across
Assets.digest.verse (341), Verse.digest.verse (151), and StarWars.vproject
(1)" **cannot have come from a run of this exact tool, in its current form,
against this exact vproject** — because that run path is supposed to dead-end
at exit 3 with a `no_match` message, not reach the point where
`files_to_open`/diagnostics exist to report. Two things are worth stating
plainly and separately here:

- The file sizes check out as *plausible source material* if the digest
  packages ever were opened by some path: `Assets.digest.verse` is 34,667
  lines and `Verse.digest.verse` is 3,330 lines (confirmed directly:
  `wc -l` against
  `...\StarWars-Assets\Assets.digest.verse` and
  `...\StarWars\Verse\Verse.digest.verse`), so a run that somehow treated
  those as in-scope `.verse` files is a plausible source of a
  three-digit-plus diagnostic count concentrated in exactly those two
  files. `StarWars.vproject` is JSON, not Verse, so "StarWars.vproject (1)"
  is very likely a single parse/handshake-adjacent diagnostic rather than a
  real language finding, but that is inference from the name, not confirmed
  from a log this investigation had access to.
- What is **not** consistent is that this shape of result exiting 0 or 1
  (as the prompt describes it being treated) rather than 3. Either the 493
  figure was produced by an earlier version of this script (before the
  Source-package check existed, or before `StarWars.vproject` lost its
  Source package), or it was produced by a different invocation/path this
  investigation could not locate. **No log or artifact from that run was
  found on disk during this investigation** — the claim is being evaluated
  purely against what the current script, run against the current
  vproject, would do.

**Confidence: high that the current code path would exit 3, not produce
493 diagnostics, if run today** — this follows directly from tracing
`locate_vproject()` against the actual JSON, not from guesswork. **Confidence
is low-to-moderate on how the 493 figure was originally produced**, since
no run transcript was available to inspect directly; the digest line counts
are circumstantially consistent with the file names reported, which is the
strongest evidence available, but this investigation could not confirm the
exact code path or script version that produced it. This is a narrower and
more specific conclusion than the prompt's framing assumed — worth flagging
rather than asserting the original framing wholesale.

## (e) Does the script distinguish "analyzed, found nothing" from "never analyzed"?

For the vproject-resolution failure covered by this report: **yes, sharply.**
`no_match` is one of five distinct `reason` values
(`root_override_invalid`, `root_not_found`, `root_found_but_empty`,
`no_match`, `ambiguous`; see the docstring on `locate_vproject()`, lines
566–570), each exits 3 via `_fail_precondition()`, and none of the exit-3
message bodies resemble a diagnostics report — they go to stderr (or a
`{"status": "precondition_failed", ...}` JSON shape, never `{"status":
"ok", ...}`) and are explicitly labeled `"PRECONDITION NOT MET -- analysis
did NOT run"` (line 950) plus a closing line stating the non-zero exit is
"NOT a clean result" (lines 953–958). So for *this specific* failure mode —
a vproject that structurally cannot resolve the target directory — the
script does not produce a false-clean result; it fails loudly, assuming
`locate_vproject()` is actually reached and its `no_match` branch taken.

The complementary gap the prompt asks about — "opened but not resolvable
within any known package" — does not have a code path in this script,
because file selection (`verse_files`, `files_to_open`, lines 1232–1243)
happens categorically *after* `locate_vproject()` has already succeeded
(line 1204 return-checks `vp_entry is None` before any file walk begins).
In other words, this script has no state where it opens a file whose
package can't be resolved — resolution is checked once, for the whole
vproject, before any file is touched. This is a real architectural
difference from the TARGETING report's concern (an opened file silently
producing zero diagnostics because the *other* two of three opened files
crowd it out) — that failure mode requires the vproject to resolve
correctly first. **Given the current StarWars vproject state, this
report's failure mode (c) should preempt the TARGETING report's failure
mode entirely** — the run should never reach file-opening at all. The two
reports describe different failure layers; on this project as it stands
today, the vproject layer is the one that should actually be firing.

## Consequence, reported factually

Over one working session on the StarWars project, multiple agents and the
orchestrator repeatedly reported "analyzer-clean" and "493 pre-existing
diagnostics (baseline)" for files that — per the trace above — were never
meaningfully analyzed as part of the user's actual 107-file Content tree.
The 493 figure was treated as a project baseline across several tasks and
relayed to the user as verification. Based on the file-size correspondence
in (d), it now appears far more consistent with being the digest packages'
own line count producing diagnostics against themselves, not the user's
project. The user discovered the discrepancy by asking a simple question
("did the analyzer not run because UEFN is closed?"), which is the only
reason it surfaced.

**The same session's exit-3 was initially misattributed to UEFN being
closed.** That explanation does not hold: nothing in `locate_vproject()`,
`locate_verseproject_root()`, or `run_lsp_session()` checks whether UEFN
the application is currently running — the vproject is a file on disk that
persists regardless of editor state (its own mtime, checked directly, is
`7/28/2026 8:50:10 AM` — this morning — while the other project vprojects
range from April through July, none of them tied to "editor open right
now"). The actual defect is the vproject's *contents*: it lacks a Source
package, which is a data-completeness problem independent of whether UEFN
is currently running. Recording the correct explanation here so the wrong
one does not propagate further.

## Is a Source package something UEFN normally writes on open?

The script's own docstrings and comments make no explicit claim about *when*
UEFN writes a Source package — this could not be determined from the
script alone, and this report does not guess at it. What the script's
`_vproject_failure_lines()` text does assert (lines 1007–1010, for the
`root_not_found`/`root_found_but_empty` cases, a related but distinct
condition) is:

> "UEFN generates this folder's contents the first time a project is
> opened in the editor. Open this project in UEFN at least once, then
> re-run this tool (UEFN does not need to stay open)."

That statement is about the `VerseProject` root existing at all, not
specifically about the Source package inside an individual `.vproject`.
Whether a *missing* Source package on an otherwise-populated vproject
(StarWars's actual state) is something a subsequent UEFN open would repair
is not addressed anywhere in this script and could not be determined from
it. Treat this as an open question — see Recommendation 5.

## Other vprojects on this machine — the contrast evidence

Seven `.vproject` files exist under
`%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject\`:

```
AnimatedUILesson\vproject\AnimatedUILesson.vproject
ChaosValley\vproject\ChaosValley.vproject
FortniteGame\vproject\FortniteGame.vproject
Gorillas_Buck_Roguelike_Template\vproject\Gorillas_Buck_Roguelike_Template.vproject
Rogue_Map_Work_01\vproject\Rogue_Map_Work_01.vproject
SRoyale\vproject\SRoyale.vproject
StarWars\vproject\StarWars.vproject
```

**Six of the seven have a `role: "Source"` package.** `FortniteGame` is the
sole other exception, and it is a plausible non-user system project (likely
the base game reference, not an authored island) — it has only the same
three External API packages StarWars has, with no user Content directory
anywhere in its name or paths, so it does not read as evidence of a
degenerate state the way StarWars does.

`Gorillas_Buck_Roguelike_Template.vproject` as a full contrast example —
this is also the project whose module-path errors
(`Gorillas.Framework.GameInit.main_game_globals`) are the running example
in `VERSE-AGENT-COMPILE-FAILURES.md`, so it is a real, actively-used
project on this same machine, not a synthetic example:

```json
{
    "desc": {
        "name": "Gorillas_Buck_Roguelike_Template",
        "dirPath": "C:/Users/majes/OneDrive/Documents/Fortnite Projects/Gorillas_Buck_Roguelike_Template/Content",
        "settings": {
            "versePath": "/buckmaster@fortnite.com/Gorillas_Buck_Roguelike_Template",
            "verseScope": "PublicUser",
            "role": "Source",
            "verseVersion": 1,
            "dependencyPackages": [
                "Gorillas_Buck_Roguelike_Template/Assets", "Verse", "UnrealEngine", "Fortnite"
            ]
        }
    },
    "readOnly": false
}
```

followed by a matching `<Name>/Assets` External package pointing at
`.../VerseProject/Gorillas_Buck_Roguelike_Template/Gorillas_Buck_Roguelike_Template-Assets`,
then the same three External API packages (Verse, UnrealEngine, Fortnite)
StarWars also has. That is five packages total: Source + Assets + 3 API
packages. `readOnly: false` on the Source package, versus `true` on every
package in `StarWars.vproject`, is a second structural marker of the same
gap.

`AnimatedUILesson`, `ChaosValley`, `Rogue_Map_Work_01`, and `SRoyale` all
follow the identical five-package shape (Source + `<Name>/Assets` + Verse +
UnrealEngine + Fortnite), each Source `dirPath` pointing at that project's
real `OneDrive\Documents\Fortnite Projects\...\Content` directory,
`readOnly: false` on the Source package only. `StarWars.vproject` has three
packages, all External, all `readOnly: true`, and separately, its
`StarWars-Assets` digest directory exists on disk but has no `<Name>/Assets`
package entry pairing with it — the only project of the seven with that
particular combination of gaps.

This is strong, direct evidence that **`StarWars.vproject` is in a
degenerate/incomplete state relative to this machine's own normal shape**,
not that the vproject format simply never carries a Source package — six
of seven sibling projects on the identical machine, using the identical
UEFN install, have the full five-package shape.

## Recommendations, in priority order

1. **This script already validates vproject contents for the Source
   package** (see (a)/(b)) — the gap is not "add validation," it is that a
   run against a genuinely broken vproject like StarWars's should already
   be exiting 3, and evidently something in this session's actual history
   did not produce that result. Before further script changes, reproduce a
   live run against the current `StarWars.vproject` and confirm it exits 3
   with `vproject_no_match` as traced above; if it does not, that is a real
   bug in this exact code path worth isolating with a fresh transcript,
   not the same finding restated.
2. **Make the exit-3 `no_match` message impossible to misattribute to
   "UEFN is closed."** The current message (lines 1020–1034) is accurate
   but does not proactively rule out the editor-closed explanation the way
   it should, given that this was misattributed once already in this
   session. Consider adding one explicit line to the `no_match` case: "This
   is not about whether UEFN is currently running — this vproject file
   exists on disk regardless; its contents are what's missing."
3. **Report analyzed scope explicitly whenever a run does reach STEP 4.**
   This is already partially true — `opened_files` is in both the human
   and JSON output (lines 1077, 1116) — but nothing states which *package*
   each opened file resolved into, which would have made the "digest files
   vs. user source" distinction in finding (d) immediately visible instead
   of requiring this investigation to reconstruct it after the fact.
4. **Agent-guidance change:** never report "analyzer-clean" or cite a
   diagnostics count without naming the vproject's Source package `dirPath`
   actually used for the run and confirming it equals the project's real
   Content directory. A diagnostics count concentrated in
   `*.digest.verse` / `*.vproject` paths, with none in the project's own
   authored files, is a red flag that user source was never in scope —
   exactly the shape the 493 figure has.
5. **Open question for maintainers, not resolved by this investigation:**
   what actually causes a vproject to lose its Source package after
   presumably having had one (StarWars is an actively-developed 107-file
   project — it is very unlikely it was opened in UEFN zero times), and
   whether re-opening the project in UEFN repairs it. This script's own
   text (lines 1007–1010) asserts UEFN populates the `VerseProject` folder
   "the first time a project is opened," but says nothing about repairing
   an existing-but-incomplete vproject on a subsequent open. This could not
   be determined from the script or from any other file available to this
   investigation — flagging it rather than guessing.

## Environment

- UEFN / Fortnite `++Fortnite+Release-41.20-CL-55550516`, UE 5.8.0
- Script audited: `<project>/Content/.claude/skills/uefn/verse_lsp_check.py`
  (StarWars project checkout; maintained upstream by TycoonAgents)
- vproject audited:
  `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject\StarWars\vproject\StarWars.vproject`
- Contrast vprojects: the other six under
  `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject\`
  (`AnimatedUILesson`, `ChaosValley`, `FortniteGame`,
  `Gorillas_Buck_Roguelike_Template`, `Rogue_Map_Work_01`, `SRoyale`)
- Project: `StarWars` UEFN island
- Date: 2026-07-28
