---
name: uefn
description: Unreal Editor for Fortnite + Verse device scripting and live-edit workflows.
---

# UEFN

Guidance for building UEFN islands and Verse device scripts. Pairs with the
**UEFN Bridge (Trashbyrd's Power Tools)** MCP for live-editor control
(`uefn_*` tools: read/set actor properties, run audits, browse materials and
textures, inspect the level).

## Setup & prerequisites

Live-editor control needs all of the following. Without the bridge, this skill
still covers Verse/device authoring.

1. **Node.js on your PATH** — the bridge MCP server runs via `node`. (Same
   requirement as any npx-based MCP server.)
2. **Install the UEFN Bridge MCP** from the catalog's **MCP** tab. It's bundled
   with this extension and resolves its own path automatically on install —
   nothing to download or configure.
3. **Install + start the Python bridge inside UEFN** — copy Trashbyrd's Power
   Tools' `uefn_bridge.py` into your UEFN project's `Content/Python/` and start
   it from the in-editor Python console (it runs *inside* the UEFN process, so
   this is a one-time step per UEFN project — it can't be auto-installed for you).
4. **They connect automatically.** The MCP server and the in-editor bridge meet
   over a shared temp directory (`<temp>/uefn_bridge`), which each machine
   resolves locally — no path configuration. For a custom directory, set
   `UEFN_BRIDGE_DIR` for **both** the UEFN process and the MCP server.

Source: Trashbyrd's Power Tools (the Python bridge + `uefn-server.ts` wrapper).
