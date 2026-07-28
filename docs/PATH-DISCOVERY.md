# Path & Environment Discovery

## Why this exists

TycoonAgents is open source. It installs on machines nobody on this team
will ever see — unknown usernames, drive letters, IDE choices, and folder
layouts. A tool that finds "the project" or "the UEFN install" by guessing
one path only works on the machine it was written on.

This document expands the core rule stated in `CLAUDE.md`:

> Any shipped tool must DISCOVER locations at runtime; it must never assume
> one machine's username, drive, IDE, install location, or folder layout.

**What prompted this.** A shipped tool's project-matching logic was
genuinely path-independent — it parsed each `.vproject` file and matched
its declared source `dirPath` against the target, so it never cared where
projects physically lived. But the same tool located UEFN's data root with
a single hardcoded guess (`%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject`),
no fallback, no override. It passed a 7-project test only because all 7
projects happened to live under the same parent folder on the developer's
machine — the test looked broad and proved nothing about portability.

## The discovery ladder

Apply these in order. Each rung only runs if the one above it didn't
resolve the location.

1. **Explicit environment-variable override — always wins.**
   If the user (or CI) sets an override variable, use it verbatim and skip
   every other rung. This is the escape hatch for the layouts no probe can
   anticipate.

2. **Multiple independent signals, tried in order and de-duplicated.**
   Never rely on a single guess. Gather candidates from several unrelated
   sources (default folder name, environment variables the OS sets,
   registry/known-folder lookups, etc.), append each new one to a
   de-duplicated list, and only then start checking candidates. Any one
   signal finding the real location is enough.

3. **Content-based matching over name-based matching, wherever possible.**
   Prefer parsing a file and comparing something it declares (a manifest's
   recorded source path, a project ID) over matching by folder name or
   position. Name-based matching breaks the moment a folder is renamed,
   relocated, or duplicated; content-based matching keeps working.

4. **Platform-appropriate probes, always fail-open.**
   Where a platform offers an authoritative answer (e.g. the Windows
   registry's "Personal" known-folder key), use it — but wrap it so a
   missing key, wrong OS, or any exception is a silent no-op, never a
   crash. A probe that isn't applicable on this platform must behave
   exactly like a probe that found nothing.

## Failure behavior (non-negotiable)

When every rung of the ladder comes up empty, the tool must **exit with an
explicit error** that:

- Lists every location it tried (so the user can see what was checked).
- Names the override variable and shows how to set it.

It must **never** return a clean, empty, or success-shaped result when
discovery actually failed. This repo has a documented history of tools
swallowing failures and returning success shapes that looked like "nothing
to do" instead of "I couldn't find it" — that failure mode is worse than a
crash because it hides the problem from whoever is debugging it.

## Testing rule

**A portability test that exercises many projects on one machine proves
almost nothing.** It only proves those projects share a parent folder on
that one machine — the exact condition that made the original bug invisible
in testing.

A real portability test must:

- Neutralize every discovery avenue with temp directories and explicit
  environment overrides — no rung of the ladder should be able to fall
  through to a real, machine-specific path.
- Be hermetic: it must pass on a bare CI box with no IDE installed and no
  UEFN installed.

If a test only passes because the developer's machine happens to have real
project data sitting in the expected place, the test is vacuous — rewrite
it before trusting it.

## The exemplar

`media/uefn-bridge/init_unreal.py`, project-root discovery (~lines
79-132), already implements this correctly. It gathers candidate
"Fortnite Projects" roots from five independent signals before ever
touching the filesystem for real:

1. The expanduser home + plain `Documents\Fortnite Projects` path.
2. The literal `OneDrive\Documents\Fortnite Projects` variant.
3. Wildcarded OneDrive tenant-branded folder names (`OneDrive - *`).
4. OneDrive environment variables Windows sets for the signed-in account
   (`OneDrive`, `OneDriveConsumer`, `OneDriveCommercial`).
5. The authoritative Windows "Personal" known-folder value read straight
   from the registry — guarded end-to-end so it's a no-op on any other
   platform or if the key is missing/odd.

Each candidate is only accepted once its project directory actually holds
a `*.uefnproject` file (content-based confirmation, not a name match), and
candidates are de-duplicated before use. New discovery logic should follow
this shape, not a single hardcoded guess.

## Known override variables

Reuse these; do not invent a competing name for the same concept.

| Variable | What it points to |
| --- | --- |
| `VERSE_LSP_PATH` | The Verse language server binary. |
| `UEFN_VERSE_PROJECT_DIR` | UEFN's `VerseProject` data root — where digests and `.vproject` files live. |
| `UEFN_BRIDGE_DIR` | The bridge IPC directory. |
| `UEFN_INSTALL_DIR` | The `UnrealEditorFortnite` editor-install folder itself (skips `LOCALAPPDATA`/`AppData\Local` derivation in `uefnDetect.ts`). |
| `FORTNITE_INSTALL_DIR` | The Fortnite game install root (parent of `FortniteGame\Content\...`), used by `panel.ts`'s Python-bridge staging discovery. |

## On mechanical enforcement

The repo already gates packaging with
`scripts/check-no-absolute-paths.mjs` (wired into `vscode:prepublish`),
which scans shipped files for machine-specific path literals (drive
letters, `/Users/`, `/home/<name>/`, etc.). That check is precise because
it flags a narrow, unambiguous pattern — a literal absolute path baked
into a shipped artifact.

The failure mode this document addresses is different and does not reduce
to a simple pattern: "found the location with one guess and no fallback,"
"an `except: pass` masks a real discovery failure as success," and "a test
only passes because of data on the developer's machine" are all judgment
calls that require reading what the code is doing, not matching a regex.
A heuristic broad enough to catch these would also flag legitimate single
env-var reads, intentional single-probe helpers, and unrelated
`except Exception` blocks — this repo has twice shipped detectors whose
false positives were worse than the gap they closed (see git history for
the retracted Verse optional-parameter lint). No mechanical check is
proposed here; this document and the `CLAUDE.md` rule are the guardrail
until someone can define one that is genuinely low-false-positive.
