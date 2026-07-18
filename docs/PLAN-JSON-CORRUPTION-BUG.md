# Bug report: corrupt `plan.json` renders a completed task as "active" (retry/skip)

**Component:** TycoonAgents plugin — Project Plan feature
**State file:** `.claude/tycoon/plan.json` (project-local, NOT git-tracked)
**Reader:** `readPlan()` in `src/host/vscode/projectPlan.ts` (~line 226), called
from `_postPlanState()` in `src/host/vscode/panel.ts` (~5396-5406)
**Severity:** Low-impact but confusing; data-integrity + silent-failure class
**Reported by:** user noticed a task card showing "active" with retry/skip
buttons after the whole plan had finished and nothing was running.

---

## Summary

The Project Plan skill (Claude side) writes `plan.json` by making incremental
text edits to the file as tasks progress. One such edit dropped a structural
boundary between two adjacent task objects, producing **invalid JSON**.

The actual consumer of `plan.json` is `readPlan()` in
`src/host/vscode/projectPlan.ts` (~line 226) — **not** the `readJsonSafe()`
helper in the po-20 project's `tycoon-claude-hook.cjs`, which does not render
the plan card and was misidentified in an earlier draft of this report.
`readPlan()` returns `null` only when the file is missing; on empty/malformed
JSON, or on JSON that parses but fails its Zod schema validation, it
**throws** rather than silently returning `null`.

`_postPlanState()` in `src/host/vscode/panel.ts` (~5396-5406) called
`readPlan()` with no surrounding try/catch, so a corrupt `plan.json` threw an
uncaught exception and **no fresh `PLAN_STATE` message was ever posted** to
the webview. The panel simply kept rendering its **last successfully received
frame** — the mid-execution "active" task with Retry/Skip controls — because
nothing told it a new state existed. Nothing was actually running at that
point; the plugin makes zero AI calls of its own, so a frozen "active" card on
screen is not evidence of live work, just a stale render.

Reassuringly, because `readPlan()` threw instead of falling back to some
default/empty object that then got written back to disk, **`plan.json` itself
was never overwritten or touched by the failed read** — no data was
destroyed. The corruption sat inert in the file until the write path (skill
side) next touched it.

So there are really two issues, one on each side of the contract:

1. **Producer (Claude / the skill):** an incremental edit corrupted the JSON.
2. **Consumer (plugin):** `readPlan()` throwing uncaught inside
   `_postPlanState()` meant the corruption surfaced as *silence* (no new
   state posted) rather than an explicit "state file unreadable" signal, so
   the UI degraded to a misleading stale view.

The #2 half is the one worth fixing in the plugin, because #1 (a bad edit) is
always possible with any process that mutates the file textually.

---

## The exact corruption

The `tasks` array contains objects like:

```json
{
  "id": "p4-t2",
  ...
  "status": "done",
  "verifyAttempts": 1,
  "notes": "...Committed 803fb0b."
},
{
  "id": "p4-t3",
  "phaseId": "p4",
  ...
}
```

The bad edit produced this instead — the closing `},` of `p4-t2` **and** the
opening `{ "id": "p4-t3",` of the next task were both missing, fusing the two
objects:

```json
  "notes": "...Committed next."      // <-- no trailing comma, no closing }
  "phaseId": "p4",                   // <-- p4-t3's fields begin with no { and no id
  "title": "Lesson(s): musical chords + drone",
  ...
```

`JSON.parse` fails at that point:

```
SyntaxError: Expected ',' or '}' after property value in JSON at position 17296
```

Note the value at `p4-t2.status` was correctly `"done"` — the plan had truly
completed. The corruption was **positional/structural**, not a wrong status
value. That's why the card was misleading rather than simply "wrong."

---

## Why the panel showed "active" + retry/skip

`readPlan()` in `src/host/vscode/projectPlan.ts` (~line 226) parses the file
and validates it against a Zod schema. On malformed JSON or a schema
violation it **throws** — it does not return `null` or a default object.

`_postPlanState()` in `src/host/vscode/panel.ts` (~5396-5406) called
`readPlan()` directly with no try/catch around it. When the corrupt file made
`readPlan()` throw, the exception propagated out of `_postPlanState()` before
it could post a new `PLAN_STATE` message to the webview. No error was sent to
the UI either — the call simply never completed.

With no fresh `PLAN_STATE` arriving, the webview kept displaying whatever it
had rendered from the **last successful** post — in this case the drone task
(which HAD gone through a retry, `verifyAttempts: 1`) mid-way through
execution, still showing the **active** card with the retry/skip controls
that active/failed tasks get. No error, no "state file corrupt" indicator —
the user just sees a task that looks like it's mid-run when nothing is
running.

---

## Repro

1. Have a valid `plan.json` with a completed plan (all tasks `done`/`skipped`,
   `currentPhaseId` terminal).
2. Corrupt it structurally: delete the `},\n    {\n      "id": "...",` boundary
   between any two adjacent objects in the `tasks` array (leaving both objects'
   fields but removing the separating braces), OR simply remove one closing `}`.
3. Open / refresh the TycoonAgents panel.
4. **Expected:** panel indicates the plan state is unreadable/corrupt, or holds
   the last-known-good state.
5. **Actual:** panel renders a stale/partial view; at least one completed task
   shows as "active" with retry/skip buttons.

---

## Suggested fixes (plugin side)

The producer bug (a bad textual edit) can't be fully prevented from the plugin,
so harden the consumer and the write path:

1. **Surface parse/validation failures instead of letting them throw
   uncaught.** `readPlan()` throwing out of `_postPlanState()` with no
   try/catch is indistinguishable, from the webview's point of view, from
   "nothing changed since last time." Distinguish the cases: return a
   discriminated result (e.g. `{ status: "ok", plan }` vs
   `{ status: "corrupt", error }` vs `{ status: "missing" }`) and have the
   panel show an explicit "plan.json is corrupt — could not parse" state
   (ideally with the parse error / byte offset) rather than a misleading task
   card.

2. **Keep a last-known-good copy.** On every successful parse, cache the parsed
   object (or copy the file to `plan.json.bak`). If a later read fails, render
   the last-known-good state (clearly flagged as stale) instead of defaulting to
   something that looks active.

3. **Validate shape, not just JSON.** Even when JSON parses, check invariants
   before rendering controls: e.g. if `currentPhaseId === "COMPLETE"` /
   `currentTaskId === null`, no task should render as `active`. A task showing
   `active` while the plan is complete is a contradiction the panel could catch
   and downgrade to `done`.

4. **Consider an atomic, whole-object write contract for `plan.json`.** The file
   is currently mutated by incremental text edits (skill side), which is what
   allowed a torn boundary. If the skill always rewrote the *entire* JSON object
   and the plugin only ever read it whole, a partial/torn write is far less
   likely. Documenting "always write the full object" as the contract (the
   skill's own docs say this) plus a post-write `JSON.parse` self-check before
   the write is committed would catch a corrupt write at the source.

5. **Optional: a self-heal / "reset plan state" affordance** in the panel, so a
   user who hits this can recover without hand-editing JSON.

---

## Producer-side note (for the skill / Claude author)

The skill writes `plan.json` via incremental `Edit` (find/replace) operations.
Editing structural JSON boundaries by string replacement is fragile: a
find/replace that spans an object boundary can drop a `}` or a `{`. Safer
options: (a) read → parse → mutate the in-memory object → serialize → write the
whole file (`JSON.stringify(obj, null, 2)`), or (b) after any edit, immediately
`JSON.parse` the file and roll back / re-emit if it no longer parses. This
particular corruption was an edit that removed the `}` + `{ "id": ... }` between
two task objects.

---

## Impact / blast radius

- **Code (`index.html`) was never affected** — the corruption was confined to
  the plan-tracking JSON. All committed work is intact and the app runs
  correctly.
- User-visible symptom only: one completed task mis-rendered as active with
  retry/skip, causing confusion about whether work had failed or was still
  running.
- The retry itself was legitimate: the drone task (`p4-t2`) genuinely failed
  verification once (a stuck-oscillator bug caught in review, fixed, then
  committed clean as `803fb0b`), so `verifyAttempts: 1` is correct data — it
  was the *rendering* of a done task as active that was wrong, not the retry
  count.

---

## Resolution (shipped)

- `readPlan()` was replaced on the hot path by a new `readPlanSafe()` in
  `src/host/vscode/projectPlan.ts` that never throws. It returns a
  discriminated result — `{ status: "ok", plan }`, `{ status: "missing" }`,
  or `{ status: "corrupt", error }` — covering both unparsable JSON and
  Zod schema-invalid content.
- `_postPlanState()` in `src/host/vscode/panel.ts` now calls
  `readPlanSafe()` and, on `"corrupt"`, posts an explicit "plan unreadable"
  state to the webview instead of silently failing to post anything. The
  panel stops rendering the stale mid-execution "active" card and instead
  tells the user the plan file could not be read.
- On every successful read, the host now writes a `plan.json.bak` snapshot
  of the last-known-good plan. The corrupt-state UI offers a "Restore last
  good" action (`RESTORE_PLAN_BACKUP`) that copies `plan.json.bak` back over
  `plan.json` so the user can recover without hand-editing JSON.
- The `project-plan` skill (both `.claude/skills/project-plan/SKILL.md` and
  its shipped mirror `media/skills/project-plan/SKILL.md`, kept
  byte-identical) was hardened with an explicit hard rule: always write
  `plan.json` by serializing the whole plan object and writing the whole
  file, never via incremental/partial text edits, and always re-read +
  `JSON.parse` after writing to confirm validity before continuing. This
  closes the producer-side hole that caused this bug in the first place.
