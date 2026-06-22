# Backlog

Exploratory and future ideas not yet committed to the design. Items here are candidates — some may prove infeasible. When an item is adopted it graduates into [DESIGN.md](DESIGN.md) (or a roadmap phase) and is removed from this list.

## Verse Blueprint Viewer (UEFN)
**Status:** exploratory · feasibility unconfirmed · complex

A tab in the §12 menu hub that renders Verse files from UEFN as a **node graph** — nodes for code constructs connected by edges showing how parts relate, in the spirit of Unreal Engine Blueprints.

**Why it fits**
- Pairs with the UEFN Power Tools component and lives naturally as a tab in the menu hub.
- A graphical view of Verse could make UEFN logic far easier to read and reason about.

**Hard parts / open questions**
- **Parsing Verse.** Needs a Verse parser/AST. Verse is niche — a mature tree-sitter grammar may not exist. Feasibility hinges here.
- **What the nodes/edges mean.** Verse is *textual*, so this is a *derived* visualization (e.g. call graph, dependency graph, or control/data flow) — not a round-trippable visual editor like native Blueprints. Decide which relationship the graph shows.
- **Rendering.** A node-graph UI (a graph-layout library in the DOM overlay), or reuse [Graphify](https://github.com/safishamsi/graphify)'s graph output if it can ingest Verse.

**Possible staged approach**
1. *Achievable first step:* a read-only **call/dependency graph** of a Verse file or module, powered by an existing graph backend (Graphify-style), rendered in a hub tab.
2. *Ambitious version:* a richer blueprint-style node layout that groups constructs into visual nodes.

**Related:** §12 menu hub · UEFN Power Tools · §11 Skills (Verse tooling) · Graphify.
