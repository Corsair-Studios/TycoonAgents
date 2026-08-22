> **Note:** This is the copy-of-record for TycoonAgents. Implementation
> lives in `media/uefn-bridge/uefn_bridge.py`, `media/uefn-bridge/tag_inspect.py`,
> `media/uefn-bridge/uefn_launcher.py`, and `uefn-bridge/uefn-server.ts` in
> this repo. The standalone Power Tools repo (`Corsair-Studios/trashbyrds-uefn-power-tools`)
> is now an independent, public repo and the single source of truth for
> Power Tools — it publishes its own releases and must not be treated as
> generated from this repo; see the `standalone-powertools-repo` memory
> note for background on the prior sync relationship. The
> body below is the original spec text, unmodified except for this note;
> its own "Section 3" still describes the standalone repo's path layout
> (`python/uefn_bridge.py`, `uefn-server.ts` at repo root) — read it as
> historical context for that repo, not as this repo's layout.

---

# Verse Tag Inspector — Implementation Spec

Status: proposed, not yet implemented. This document is self-contained — no
external conversation history is assumed.

## 1. Problem statement

Verse gameplay tags applied to a placed actor in UEFN live on a
`VerseTagMarkup` **component**, not as a direct property of the actor. The
bridge's existing `uefn_get_property` tool does a flat, single-hop read —
`python/uefn_bridge.py`, `_handle_get_property` — which calls
`actor.get_editor_property(property_name)` directly on the actor object. It
has no component-traversal step, so any attempt to read Verse tags through it
(whether via `const_tags`, `editor_only_instance_tags`, or a literal
`"VerseTagMarkup"` property name) either returns an empty tag container or a
"property not found" error, even when the actor visibly has tags applied in
the editor.

**Field case (motivation):** during a spawn-system audit on a customer
project, `uefn_get_property`/`uefn_batch_get` were used to check whether ~200
`Device_CharacterSpawner_C` actors carried their expected gameplay tags. Every
query against `const_tags`/`editor_only_instance_tags` came back with an empty
`GameplayTagContainer`, for every actor. This was reported and accepted as
"the level has no tags applied" — a false negative. The actors were correctly
tagged the whole time; the tags simply live on `VerseTagMarkup`, which this
bridge cannot see. The false negative sent the debugging effort in the wrong
direction for an entire investigation before a screenshot of the editor UI
proved the tags were present. This tool exists to prevent that class of
mistake happening again, for this project or any other.

## 2. Feature

New MCP tool: **`uefn_tag_inspect`**. New launcher window: **"Verse Tag
Inspector"**.

**Input:**
- `label_pattern` (string) — substring or wildcard filter over actor labels
  (e.g. `"SGMarker"`, `"R4_P1*"`).

**Output (JSON):** a list of entries, one per matching actor:
```json
{
  "label": "R1_P1 - SGMarker Rand 1",
  "has_verse_tag_component": true,
  "tags": [
    { "name": "t_area_hoth", "parent_chain": ["t_area", "tag"] },
    { "name": "t_phase_01", "parent_chain": ["t_phase", "tag"] },
    { "name": "t_room_01", "parent_chain": ["t_rooms", "tag"] },
    { "name": "t_sg_random_guard_marker", "parent_chain": ["t_sg_spawn_marker", "t_sg_spawn_system", "tag"] }
  ]
}
```
Actors matching `label_pattern` with `has_verse_tag_component: false` (or a
component present but zero tags) must be **listed first, flagged, not
silently omitted** — omission is exactly the failure mode this tool exists to
prevent.

The launcher window renders the same JSON human-readably (actor label, its
tags, each tag's parent chain as a breadcrumb), mirroring the existing
"IP / Moderation Scan" window's presentation style.

## 3. Architecture map of the existing extension

(Repo-relative paths below were re-confirmed against this repo's actual
layout — note the earlier working draft of this spec assumed a
`media/uefn-bridge/` path prefix from a different shipped-copy layout; **this
repo keeps the bridge and launcher directly under top-level `python/`, and the
MCP server is `uefn-server.ts` at repo root, not `.mjs` under `media/`.**
Adjust further if a future repo reorganizes again.)

- **Editor-side Python — `python/uefn_bridge.py`:** tool dispatch is a flat
  dict, `_METHODS` (~line 1645), mapping method-name strings to handler
  functions. Extension precedent already exists in this file: sibling modules
  such as `device_audit.py` and `batch_tools.py` are imported defensively
  (guarded imports, so a missing/broken sibling module doesn't crash the
  whole bridge) and their functions are wired in as `_METHODS` entries. This
  is the pattern to follow for `tag_inspect.py`.
- **Report/window pattern — file-drop:** `moderation_scanner.py` writes
  `moderation_report.json` next to the running script (with a fallback
  location in the bridge's IPC temp dir). `python/uefn_launcher.py` declares
  the "IP / Moderation Scan" window (label string at line 214) which reads
  that JSON file back and renders it. There is no live in-process
  window-update path — it is a write-then-poll-and-render file handoff.
- **MCP tool declaration — `uefn-server.ts` (repo root):** tool names,
  descriptions, and input schemas are declared here (see the
  `"uefn_moderation_scan"` tool block, and the `"moderation_scan"` /
  `"moderation_report_save"` / `"moderation_report_read"` bridge-method
  references) before a Python-side handler is reachable by an MCP client. A
  new `_METHODS` entry in `uefn_bridge.py` alone is **not** visible to any MCP
  client until `uefn-server.ts` also declares the tool.

## 4. Implementation plan

New sibling module: `python/tag_inspect.py`.

1. **Actor enumeration.** Reuse the bridge's existing actor-enumeration
   helpers (see `_find_actor_by_label` / the all-actors helper already used
   by `_handle_get_property` and `_handle_list_devices` in `uefn_bridge.py`)
   filtered by `label_pattern`.
2. **Live tag read (UNVERIFIED — first implementation step).** The exact
   Unreal Python component class name and its tag-list property name are not
   yet confirmed. Before writing the real handler, run a one-line editor
   Python probe against a known-tagged actor to discover them:
   ```python
   actor = <fetch known actor, e.g. via unreal.EditorLevelLibrary or the
            bridge's existing actor lookup>
   for c in actor.get_components_by_class(unreal.ActorComponent):
       print(c.get_class().get_name())
   ```
   Then, once the Verse-tag component class is identified in that printout,
   list ITS editor properties the same way to find the tag-container property
   name. Do not guess `"VerseTagMarkup"` or `"Tags"` as literal property
   strings without this probe — both have already failed as bare
   `get_editor_property` targets in the existing bridge, precisely because
   they are not actor-level properties.
3. **Parent-chain resolution — MUST be project-agnostic.** Do not hardcode
   any filename (no `illest_global_tags.verse`-style assumption) or any tag
   prefix (no hardcoded `t_` assumption). Instead:
   - Scan `*.verse` files under the target UEFN project's content root.
   - Apply the regex `^(\w+)\s*:=\s*class\((\w+)\)` to every line to build a
     raw child→parent map across all class declarations found.
   - Keep only entries whose ancestry chain (walking parent→parent) resolves
     to the literal base identifier `tag` — this is what makes an entry a
     genuine Verse gameplay-tag class rather than an unrelated `class(...)`
     declaration. This derives the valid-tag set purely from the project's
     own declarations; it makes no assumption about naming conventions,
     prefixes, or which file(s) declare tags.
4. **Wiring.** One import line + one `_METHODS` entry in `uefn_bridge.py`
   (mirror the `batch_tools` import-and-wire pattern exactly). Declare
   `uefn_tag_inspect` in `uefn-server.ts` (mirror the `uefn_moderation_scan`
   tool block). Add a launcher window entry in `uefn_launcher.py` mirroring
   the "IP / Moderation Scan" pattern, reading a new `tag_inspect_report.json`
   written next to the script by the new handler.

## 5. Offline fallback mode (v2, optional — proven in the field)

With UEFN closed, every placed actor is stored as an individual OFPA file
under the target project's `Content\__ExternalActors__\` tree. This mode was
field-validated on a real project:

1. Locate an actor's file by searching all `.uasset` files under
   `__ExternalActors__` for the actor's label string (a plain substring
   search across the binary files works — actor labels and Verse tag FNames
   are stored as readable ASCII inside the package).
2. Extract printable ASCII runs (regex `[\x20-\x7E]{4,}`, i.e. classic
   `strings`-utility behavior) from the file.
3. Intersect the extracted strings with the project-agnostic tag-class set
   built in step 4.3 above (never a hardcoded prefix).

Field validation: this method recovered a marker actor's exact four
editor-visible tags (`t_area_hoth`, `t_phase_01`, `t_room_01`,
`t_sg_random_guard_marker`) with zero false positives or omissions, matching
what the UEFN editor UI showed for that same actor. At ~46,000 actor files in
one real project, a full-project string search completed in under two
minutes using a simple per-file `Select-String`-equivalent scan — no
UE-specific asset parser was needed for label/tag extraction, only plain text
search.

## 6. Acceptance criteria

1. The component/property-name probe (step 4.2) is run and its findings are
   written into this doc or a follow-up note — the real names, not assumed
   ones.
2. Live `uefn_tag_inspect` on a known tagged actor returns exactly that
   actor's editor-visible tags (no more, no fewer).
3. Actors matching `label_pattern` with no `VerseTagMarkup` component (or a
   component with zero tags) are flagged in the output, never silently
   dropped from the result set.
4. Returned parent chains match the target project's own Verse tag class
   declarations (verified by cross-checking a few tags by hand against the
   `.verse` source).
5. `uefn_tag_inspect` appears as a callable tool in an MCP client only after
   both `uefn-server.ts` is updated and the MCP server process is restarted —
   a Python-side-only change is not sufficient.
6. The "Verse Tag Inspector" window renders the report file correctly.
7. The tool works unmodified on a UEFN project other than the one it was
   developed against — no hardcoded tag-declaration filename and no
   hardcoded tag-name prefix anywhere in `tag_inspect.py`.

## 7. Live probe findings (recorded per acceptance criterion 1)

> **FIELD-CONFIRMED, live editor run.** This section records the real
> component/property-name probe (step 4.2 / acceptance criterion 1)
> against a live UEFN editor, so the findings are written down rather than
> assumed.

- **Tag-bearing component class:** `VerseTagMarkupComponent` — confirmed on
  a live editor run. (Note this is the `...Component`-suffixed class name,
  not the `VerseTagMarkup` name assumed elsewhere in this document.)
- **Tag-container property name:** still **UNRESOLVED** as of that run —
  not yet identified by name; `tag_inspect.py`'s `_find_tag_component` /
  `_extract_tags_from_component` fall back to a structural scan (any
  component property whose value looks like a `GameplayTagContainer`, see
  `_looks_like_tag_container`) rather than a hardcoded property name for
  exactly this reason.
- **Test actor:** `R1_P1 - SGMarker Rand 1`, whose four expected tags are
  `t_area_hoth`, `t_phase_01`, `t_room_01`, `t_sg_random_guard_marker` —
  the same four tags recorded in Section 5's offline-fallback field
  validation.
- **Verse tag classes parsed:** 629 tag classes parsed successfully from
  the target project's own `*.verse` source via the Section 4.3 class-map
  and parent-chain resolution.
