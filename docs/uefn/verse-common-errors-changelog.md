# Verse Common Errors — Changelog

Maintainer-only version history moved out of media/skills/uefn/verse-common-errors.md.
Verbatim content below (originally the file's leading HTML comment block, lines 1-109).

```
<!-- version: 4.7.0 -->
<!-- changelog: 4.7.0 documents `verse_lsp_check.py`, a categorical upgrade
     over the two existing deterministic tools: it drives Epic's OWN bundled
     Verse language server (verse-lsp.exe, shipped with the epicgames.verse
     VS Code extension) standalone over LSP/stdio and returns the SAME
     diagnostics the editor draws as red squiggles — with no UEFN running and
     no compile, therefore no editor-crash risk. Verified on a live 108-file
     project: 500 diagnostics across 5 files, including a real 3506 Unknown
     identifier with a "Did you mean <FullyQualified.Path>" suggestion. Adds
     a new "Primary analyzer: verse_lsp_check.py" section documenting the
     tool contract, exit codes (0/1/2/3, matching the existing convention),
     the tiered PRIMARY/FALLBACK gate (fall back to verse_lint.py and
     verse_project_check.py only when verse_lsp_check.py exits 3, and say so
     explicitly), the baseline/delta discipline for pre-existing diagnostics
     on a real project, and the two hard preconditions (the epicgames.verse
     extension must be installed; a .vproject must exist, which UEFN
     generates on first open — a project never opened in UEFN has none).
     Records the load-bearing technical fact that cost six configurations to
     find: `rootUri` passed to the language server must be the vproject
     FOLDER — the UEFN project root, the Content directory, and the digest
     root all produce zero diagnostics. CORRECTS rules 20 and 21: both
     previously stated that the Epic-symbol half of their failure class was
     undetectable by any static tool in this pack, because verse_lint.py and
     verse_project_check.py genuinely can't read the digest. That limitation
     is now OBSOLETE — verse_lsp_check.py drives the actual compiler
     front end, so it catches BOTH halves (project symbols AND Epic/engine
     symbols) for the failure modes described in rules 20 and 21. The prior
     "still not lint-detectable" language is corrected in place, with this
     entry as the record of what changed and when; the 4.6.0 verse_lint.py/
     verse_project_check.py material is left intact as still-accurate
     FALLBACK-tier documentation, not deleted.
     4.6.0 adds a sibling section to "Deterministic lint:
     verse_lint.py" documenting the new project-symbol resolver,
     `verse_project_check.py` (media/skills/uefn/verse_project_check.py):
     what its three checks (A/B/C) cover, usage, exit codes (same contract
     as verse_lint.py: 0/1/2/3, 3 never a pass), and its limits (Epic/engine
     types out of scope, no type inference, single-line declarations only,
     Check B suppressed for any class it could not fully enumerate). This
     closes a structural blind spot neither verse_lint.py (single-file text
     shapes) nor the uefn-auditor (Epic digest only) could ever cover: a
     project's OWN types. Corrects rules 20 and 21, which previously stated
     their failure class was NOT lint-detectable — that is now only half
     true. Rule 21's exact failure mode (a symbol found in the digest but
     unreachable because the owning module was never imported) has a
     project-symbol counterpart that verse_project_check.py's Check A does
     detect: a project-declared type referenced from a file that cannot see
     it (different module, no covering `using`, not fully qualified). Rule
     20's directory-depth module-path mechanism is likewise now mechanically
     checked for project symbols (the tool derives each file's module path
     from its directory and walks relative `using` values the same way).
     What remains genuinely undetectable by any static tool, for both
     rules, is anything involving an EPIC/engine symbol — the digest is not
     machine-readable by this resolver, so that half of each rule's
     "not lint-detectable" statement still stands. Both rules gained a
     pointer to the new section rather than restating its content. Purely
     additive/corrective: no other rule text changed.
     4.5.0 adds new rule 24 (which `SpatialMath` module you import
     decides your coordinate system: `/Verse.org` transforms are LUF,
     `/UnrealEngine.com` and `/Fortnite.com` transforms are traditional XYZ,
     and the two are opposite-handed so a rotation conversion is not a
     component swap). Sourced from Epic's "Left-Up-Forward Coordinate System
     in Unreal Editor for Fortnite" doc page, cited by title and URL, with a
     real field-confirmed worked example (the same actor's transform read in
     both systems, matching the documented mapping exactly). Cross-links
     rule 23 for disambiguating the two modules' identically-named types
     rather than repeating that mechanism. Added to the Quick Reference
     index under Import / Using Errors. Purely additive: no existing rule
     text changed.
     4.4.0 confirms rules 20 and 21 against the Book of Verse, "Modules and
     Paths" chapter (https://verselang.github.io/book/16_modules/), fetched directly
     this pass — both move from unverified/observed-only to CONFIRMED and are removed
     from the Uncertain section. Rule 20 gained the chapter's actual mechanism (relative
     paths resolve per-file against the current module's location) plus a documented
     remedy (absolute `/`-leading paths resolve from the global registry regardless of
     file location). Rule 21 gained the chapter's confirmation that importing exposes a
     module's public members, plus the same-module exception (files in the same module
     see each other without imports) that explains why the error is intermittent. Added
     new rule 23 (disambiguating a name two imported modules both define, via the
     `(/Module/Path:)Symbol(...)` qualified-call form) from the same chapter, sourced
     from a real field debugging cost. All three citations use verbatim quotes supplied
     by the coordinator after fetching the chapter directly; nothing was invented beyond
     that material.
     4.3.0 closes the PROCESS gap that let 4.1.0's wrong rule 22 ship: the
     prime directive covered API existence (digest files) but never said language
     SEMANTICS (what `?`, effect specifiers, and failure contexts MEAN) require the
     Book of Verse instead — a digest grep proves a symbol exists, not what it means.
     Added an explicit API-existence-vs-language-semantics split under the prime
     directive; added a "How to add a rule to this file" section requiring every rule
     to cite its Book of Verse section or Epic doc page, reusing the existing
     Uncertain/observed-only convention for anything that can't cite one; added a
     confirmed Book of Verse Functions-chapter citation to rule 22 (named-parameter
     call syntax) rather than only self-correcting its prior content; marked rules 20
     and 21 (module-path depth, digest-existence-vs-using-visibility) as unverified
     against the Book of Verse's Modules and Paths chapter — they remain single-project
     observations, not confirmed language rules, and are now listed under Uncertain.
     4.2.0 CORRECTS rule 22. The 4.1.0 statement of this rule was WRONG and
     could break working code: it claimed a `?`-prefixed parameter NAME always means
     optional, so `option{...}` should never be used with it. That is false — `?` on a
     NAME marks a named parameter (`?Name := Value` call syntax); optionality comes from
     the parameter's declared TYPE starting with `?`, independently of the name prefix.
     A parameter like `?Rotation:?rotation` combines both, and `option{Value}` there is
     CORRECT, not a double-wrap. Anyone who read 4.1.0's rule 22 should treat it as
     superseded by this version. See docs/VERSE-AGENT-COMPILE-FAILURES.md for the
     correction record (append at end of that file).
     4.1.0 (superseded content) added rules 20-22 (module-path depth,
     digest-verified-but-missing-using, the now-corrected optional-parameter rule), a
     compile-failure stakes warning, and the verse_lint.py pointer — sourced from
     docs/VERSE-AGENT-COMPILE-FAILURES.md (11 real errors, one UEFN project,
     2026-07-27). -->
```
