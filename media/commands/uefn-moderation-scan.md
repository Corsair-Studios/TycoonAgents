---
description: Scan the current UEFN project for IP/moderation risk (Rule 1.7 / 1.13) before publishing, and post the report into the Power Tools "IP / Moderation Scan" window.
argument-hint: [licensed-franchise ...]
---

Scan this UEFN project for Fortnite/UEFN island-moderation risk before publishing.

**Requires the UEFN Bridge (Trashbyrd's Power Tools) MCP server to be connected — server id `uefn-bridge`.** `uefn_moderation_scan` and `uefn_moderation_report` live on `uefn-bridge`, not on Epic's official `unreal-engine-mcp` server; moderation always routes to `uefn-bridge`, never to Epic's server. If the tool call below fails or the tool isn't found, run `/mcp` to check which MCP servers are loaded — the bridge needs its Python side running and the server connected before this command works.

## Steps

1. Call the `uefn_moderation_scan` MCP tool for the current project. If franchises or brands were named as arguments to this command ($ARGUMENTS), pass them as the tool's `allowlist` parameter — this only changes how licensed-IP hits are categorized in the report, it does not exempt them from being reported.
2. Analyse everything the tool returns exactly as directed by the tool's OWN description — that description is the full rubric (Epic's documented review-pipeline order, BLOCKER / WARN / KNOWN-RISK / INFO severities, the twelve documented Rule 1.7 failure modes, and allowlist semantics). It is the single source of truth for how to judge the results; do not improvise a different rubric here, and do not assume this file repeats it verbatim.
3. Give extra weight to the highest-value evidence the tool calls out explicitly:
   - `unicode_risks` — emoji and other decorative Unicode across metadata, Verse strings, and asset names; a reproduced real-world Rule 1.7 trigger, and the cheapest first thing to strip out and retest.
   - `hlod_or_imported_assets` and `external_actor_assets` — generated HLOD / external-actor packages have triggered sanctions even on accounts holding an active, valid brand tag for the licensed IP involved.
   - `redirectors` — deleted or renamed content that stays reachable through an ObjectRedirector; renaming or deleting alone does not clear a match.
   - `image_provenance` — embedded authoring-tool, creator, or copyright metadata suggesting a promotional image is a downloaded render rather than an original in-editor capture.
4. Write the findings as a report grouped by severity, following the report format and KNOWN-RISK guidance in the tool's description exactly — including its guidance that licensed IP surfacing alone (with nothing else found) is a documented false-positive pattern in Epic's automated matcher, never something the creator did wrong.
5. Finish by calling the `uefn_moderation_report` MCP tool with the finished report text, a one-line summary/verdict, and a count of findings per severity. This is what makes the results render inside the UEFN editor's "IP / Moderation Scan" window instead of staying only in this chat — do not skip it.

Arguments: $ARGUMENTS (optional, space- or comma-separated franchises/brands the creator is licensed to use — passed through as the scan's `allowlist`).
