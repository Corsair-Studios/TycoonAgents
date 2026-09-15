---
name: design-doc
description: Generate a GDD or PRD from the actual codebase, or review an existing .docx design doc against what's built.
---

# Design Doc

Generate a **Game Design Document (GDD)** or **Product Requirements Document (PRD)** from what's actually in the codebase, or review an edited doc and surface mismatches. Output is a Word `.docx` so the human can annotate with comments and track-changes, then hand it back for re-review.

## Game vs. Product detection

Check for engine signals to decide which template to use:

| Signal | Engine |
|--------|--------|
| `.uproject`, `.verse` files, `Content/Verse/` | UEFN / Unreal → **GDD** |
| `project.godot` | Godot → **GDD** |
| `ProjectSettings/`, `Assembly-CSharp` | Unity → **GDD** |
| `.rbxl`, `.rbxlx`, `*.project.json` (Rojo) | Roblox → **GDD** |
| None of the above | → **PRD** |

## The bundled converter

This skill ships with `design-doc-cli.mjs`. Run it with Node from the project root. Requires Node on PATH.

**Generate** — after saving the draft markdown:
```
node .claude/skills/design-doc/design-doc-cli.mjs md2docx ./design-docs/<name>.md ./design-docs/<name>.docx
```

**Review** — read an edited Word doc back as text:
```
node .claude/skills/design-doc/design-doc-cli.mjs docx2md ./design-docs/<name>.docx
```
`docx2md` prints to stdout; read that output directly.

Supported markdown: `#`/`##`/`###` headings, paragraphs, `-`/`*` bullets, `**bold**`.

## Template library

Templates live as separate files in `templates/` next to this skill, not inline here:

| File | Use for |
|------|---------|
| `templates/gdd.md` | Game Design Document — used when engine signals detect a game (see table above). |
| `templates/prd.md` | Product Requirements Document — used when no game-engine signal is found. |
| `templates/adr.md` | Architecture Decision Record — use when the user asks to document a specific technical decision rather than a whole product/game. |
| `templates/milestone-plan.md` | Milestone/delivery plan — use when the user asks for a milestone, sprint, or delivery plan, or when a GDD/PRD's "Scope & Milestones" section needs to be broken out into its own doc. |

Read the appropriate template file(s) before drafting — do not reconstruct the sections from memory. Each template has section headings with brief italic/blockquote guidance for what belongs in that section; replace the guidance with real content drawn from the codebase, and keep the guidance text out of the final draft.

## Generate workflow

1. Detect game/product (see above) to choose `templates/gdd.md` or `templates/prd.md`. If the request is specifically for a milestone plan or an architecture decision, use `templates/milestone-plan.md` or `templates/adr.md` instead (or in addition).
2. Read the chosen template file(s) from `templates/`.
3. Scan the project — source files, configs, assets, README — to understand what's actually built. Be honest about gaps; note assumptions.
4. Draft markdown following the template's section structure; save to `./design-docs/<name>.md`.
5. Run `md2docx` to produce the `.docx`.
6. Tell the user the file is in `./design-docs/` for them to review and edit in Word. They can ask for a re-review once edits are done.

## Review workflow

For each `.docx` in `./design-docs/`:

1. Run `docx2md` and read the output.
2. Summarize what the project is intended to be per the doc.
3. Flag mismatches between the doc's intent and what's actually in the codebase.
4. Recommend which TycoonAgents packs or agents to install to close the gaps.
