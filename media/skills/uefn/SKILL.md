---
name: uefn
description: Unreal Editor for Fortnite + Verse device scripting and live-edit workflows.
---

# UEFN

Guidance for building UEFN islands and Verse device scripts. Pairs with the
**UEFN Bridge (Trashbyrd's Power Tools)** MCP for live-editor control
(`uefn_*` tools: read/set actor properties, run audits, browse materials and
textures, inspect the level).

## Relationship to Power Tools

TycoonAgents does not install, stage, bundle, or download the UEFN live-editor
bridge. The bridge (the Power Tools MCP server, key `powertools` or `uefn-bridge`, and its in-editor Python
counterpart) is **Trashbyrd's Power Tools**, a separate third-party project
the user installs and configures themselves — see the `uefn-bridge` entry in
the MCP catalog (`media/mcp/catalog.json`) and `.mcp.json.example` at the repo
root for the exact `mcpServers` shape, or Power Tools' own INSTALL.md
(https://github.com/Corsair-Studios/trashbyrds-uefn-power-tools). This skill
covers Verse/device authoring conventions and how the agents use the bridge's
`uefn_*` tools once it's connected; it assumes Power Tools is already set up.

## Setup & prerequisites

Full bridge install steps, requirements, and troubleshooting live in the
**uefn-bridge** skill — see that skill's `Requirements` and `Installation`
sections. Without the bridge connected, this skill still covers Verse/device
authoring.

## Agents & digest auto-detection

Installing the UEFN pack creates two agents:

- **verse-expert** — authors and refactors Verse device scripts and island
  gameplay.
- **uefn-auditor** — reviews and validates Verse for correctness, deprecations,
  and API compliance (it does not author features).

Both agents **auto-detect the current API**. Before writing or auditing, they
recursively search the UEFN data root (`%LOCALAPPDATA%\UnrealEditorFortnite`)
and the open project for the digest files `Verse.digest.verse`,
`Fortnite.digest.verse`, and `UnrealEngine.digest.verse`. When multiple copies
exist, the **most recently modified** one wins — that reflects the latest
installed Verse/Fortnite/Unreal API — and the agents treat those digests as the
authoritative surface for available classes, devices, and APIs. UEFN project
presence is confirmed via `.verse` files, a `.uproject`, or a `Content/Verse/`
directory.

## Common-errors pre-flight reference

`verse-common-errors.md` in this skill folder is a last resort: consult it
only after the Verse LSP / bridge diagnostics have failed to resolve an
error, because reading it costs a large number of tokens. It documents the
non-existent APIs and idioms LLMs commonly hallucinate into Verse, the
highest-value compile-error rules (`set` for mutation, `<suspends>`, failure
contexts, effect specifiers, options), and a reminder that the digest files
always override memorized signatures.

Source: Trashbyrd's Power Tools (the Python bridge + `uefn-server.ts` wrapper).
