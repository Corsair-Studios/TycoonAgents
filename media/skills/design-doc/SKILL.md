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

## Generate workflow

1. Detect game/product (see above).
2. Scan the project — source files, configs, assets, README — to understand what's actually built. Be honest about gaps; note assumptions.
3. Draft markdown following the matching template below; save to `./design-docs/<name>.md`.
4. Run `md2docx` to produce the `.docx`.
5. Tell the user the file is in `./design-docs/` for them to review and edit in Word. They can ask for a re-review once edits are done.

## Review workflow

For each `.docx` in `./design-docs/`:

1. Run `docx2md` and read the output.
2. Summarize what the project is intended to be per the doc.
3. Flag mismatches between the doc's intent and what's actually in the codebase.
4. Recommend which TycoonAgents packs or agents to install to close the gaps.

## GDD template

```markdown
# <Game Title>

## High-Concept Pitch
One or two sentences.

## Genre & Platform

## Core Gameplay Loop
What the player does moment to moment.

## Key Mechanics

## Player Progression & Goals

## World / Setting

## Art & Audio Direction

## Technical
Engine, tools, third-party libraries.

## Scope & Milestones

## Risks & Open Questions
```

## PRD template

```markdown
# <Product Title>

## Problem / Opportunity

## Target Users

## Goals & Success Metrics

## Core Features

## User Flows

## Non-Functional Requirements
Performance, security, accessibility, etc.

## Tech Stack

## Milestones & Scope

## Risks & Open Questions
```

## Notes

- Base everything on the actual codebase, not assumptions about intent.
- Flag gaps and unknowns explicitly rather than filling them with guesses.
- This skill is designed for an **edit → re-review loop**: generate → human edits in Word → re-review to check alignment.
