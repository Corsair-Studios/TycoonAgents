---
name: project-plan
description: Decompose a design doc into an approvable plan of phases and tasks, then execute it with human gate checkpoints.
---

# Project Plan

Turn a design doc into a **plan** — an ordered list of phases, each holding a set of tasks — then work through it one task at a time, delegating to the right agent, checking each task's own acceptance criteria, and stopping at the end of every phase for human approval. The TycoonAgents extension makes zero AI calls of its own; it only reads and displays the plan file this skill writes, and lets the human set approve/retry/skip overrides that this skill reads back. All the thinking happens here, inside Claude Code.

## Precondition

Only run this workflow when the user has explicitly turned on the optional **Project Plan** feature (via the TycoonAgents panel, or by asking you to plan/execute a project directly). If the feature is off and the user hasn't asked for it by name, do not create or modify `.claude/tycoon/plan.json` — treat this skill as inactive.

## Inputs

Prefer a design doc produced by the `design-doc` skill's templates — a GDD, PRD, or milestone-plan markdown/`.docx` under `./design-docs/`. If no design doc exists yet, ask whether to generate one first (invoke the `design-doc` skill) or proceed from a plain description the user gives you directly. Read the source doc in full before decomposing it — do not plan from a summary you already hold in context.

## The plan file

State lives at `.claude/tycoon/plan.json`, created if missing and re-read at the start of every invocation. Shape:

```json
{
  "version": 1,
  "title": "string",
  "phases": [
    { "id": "string", "num": 1, "name": "string", "goal": "string", "gate": "pending", "taskIds": ["string"] }
  ],
  "tasks": [
    {
      "id": "string",
      "phaseId": "string",
      "title": "string",
      "detail": "string",
      "agents": ["string"],
      "acceptanceCriteria": ["string"],
      "dependsOn": ["string"],
      "status": "pending",
      "verifyAttempts": 0
    }
  ],
  "currentPhaseId": "string",
  "currentTaskId": "string"
}
```

`phase.gate` is one of `pending` / `approved`. `task.status` is one of `pending` / `active` / `verifying` / `done` / `needs_fix` / `skipped`. The panel writes `gate` and `status` overrides; this skill writes everything else. Never hand-wave a field — write the whole object shape on every save, even if a value hasn't changed.

**Hard rule — whole-file writes only.** ALWAYS write `.claude/tycoon/plan.json` by serializing the entire plan object in memory and writing the whole file with the Write tool. NEVER use incremental or partial text edits on `plan.json` — no Edit tool, no sed-style boundary edits, no hand-splicing a single field in place. A single dropped `},` / `{` boundary between two adjacent objects in the `tasks` array is enough to corrupt the JSON and freeze the panel on stale state (it will keep rendering the last frame it successfully read, including a finished task that still shows "active" with retry/skip controls). After every write, re-read the file and `JSON.parse` it to confirm it is valid before continuing; if the parse fails, rewrite the whole file again from the in-memory plan object — do not attempt to patch the broken text.

## 1. Decompose

1. Read the source design doc end to end.
2. Split the work into an ordered sequence of **phases** — each phase is a coherent slice with a clear `goal` a human can sanity-check at a glance (e.g. "Core data model", "Panel UI", "Hook wiring"). Number them from 1.
3. Under each phase, list **tasks**. Every task needs:
   - `title` — short, action-oriented.
   - `detail` — enough context that a cold agent could pick it up without re-reading the whole design doc.
   - `agents` — one or more suggested roles drawn from the project's delegation roster (e.g. `coding-specialist`, `testing-specialist`, `ux-ui-designer`, `vscode-integration`, `workspace-monitor`, `search-retrieval`). Pick by task shape, not by habit.
   - `acceptanceCriteria` — a list of concrete, checkable statements. Avoid vague criteria like "works well"; prefer things you can verify by reading a file, running a command, or observing behavior.
   - `dependsOn` — ids of tasks that must be `done` first, including cross-phase dependencies.
4. Assign every task a stable `id` (e.g. `p1-t1`) and every phase a stable `id` (e.g. `p1`). Set every phase's `gate` to `"pending"` and every task's `status` to `"pending"`, `verifyAttempts` to `0`.
5. Write the full plan to `.claude/tycoon/plan.json`. Set `currentPhaseId` to the first phase and `currentTaskId` to null.
6. Show the user a short summary of the phases (names + goals) and ask them to confirm before execution begins, unless they already asked you to start executing immediately.

### Mapping a milestone-plan design doc to plan.json

When the source doc is the `design-doc` skill's milestone-plan template, decomposition is a direct translation, not a fresh judgment call:

| milestone-plan.md section | plan.json |
|---|---|
| Milestone (heading) | a phase (`name` = milestone title, `num` = order) |
| Goal | `phase.goal` |
| each Deliverable (one bullet) | one task (`title` = deliverable, `detail` = its description) |
| Acceptance Criteria | the owning task's `acceptanceCriteria[]` (split into discrete checkable items) |
| Sequencing Notes | `task.dependsOn[]` (reference task ids) |
| Risks | a note on the affected task(s) — `task.notes`; mark `task.status` `"blocked"` if a risk is a hard blocker |

Each Deliverable becomes at least one discrete task with its own acceptance criteria — don't lump multiple deliverables into one task. When the source is a GDD/PRD instead (no milestone breakdown), derive phases from its "Milestones & Scope" / "Core Features" sections using this same mapping.

## 2. Execute loop

Repeat until no runnable task remains:

1. Re-read `.claude/tycoon/plan.json` from disk — the panel may have applied an override since your last write.
2. Pick the next **runnable** task: `status` is `pending`, every id in `dependsOn` is `done` (or `skipped`), and its phase is the current phase (or an earlier phase whose gate is not yet `approved` — never skip ahead of an unapproved phase). If none is runnable but tasks remain `needs_fix`, surface those to the user instead of stalling silently.
3. Set the task's `status` to `"active"`, save the plan, and set `currentTaskId`.
4. Delegate the work via the Task tool to the agent(s) named in `agents`, briefing them with the task's `detail` and `acceptanceCriteria` verbatim so they know exactly what "done" means.
5. When the agent reports back, set `status` to `"verifying"`, save, then check the result against every item in `acceptanceCriteria` yourself (read the changed files, run a build/test command, whatever the criteria call for — do not just trust the agent's summary).
6. If all criteria pass: set `status` to `"done"`, save, move on.
7. If any criterion fails: increment `verifyAttempts`. If `verifyAttempts <= 2`, set `status` back to `"pending"` (or `"active"` if retrying immediately) and re-delegate with the specific gap called out. If `verifyAttempts > 2`, set `status` to `"needs_fix"`, save, and move to the next runnable task rather than looping forever — surface the stuck task in your next message to the user.
8. Save `.claude/tycoon/plan.json` after every single status transition, not just at the end of the loop, so the panel's visualization stays live. Every save is a full-object rewrite per the hard rule above — never an incremental edit.

## 3. Phase gate

When every task in the current phase is `done` or `skipped`:

1. Stop executing — do not touch the next phase's tasks.
2. Tell the user the phase is complete and is awaiting approval, naming the phase and summarizing what shipped.
3. The user approves through the TycoonAgents panel, which sets that phase's `gate` to `"approved"` in `plan.json`. Re-read the file to detect this — poll only when the user tells you to resume, not on a timer.
4. Once `gate` is `"approved"`, advance `currentPhaseId` to the next phase and resume the execute loop.

## 4. Per-task overrides

Before picking a task in the execute loop, honor any override already present in `plan.json` that the panel wrote since your last save:

- A task moved to `"skipped"` — leave it as-is, treat it as satisfied for `dependsOn` purposes, do not re-run it.
- A task moved to `"pending"` from `"needs_fix"` or `"done"` (a manual retry request) — treat it as runnable again; reset `verifyAttempts` to `0` only if the user's note indicates a fresh attempt, otherwise continue the count.
- A task or phase field you don't recognize — leave it untouched rather than overwriting it; only the panel and this skill should be writing this file, so an unfamiliar field likely means the schema moved forward and you should adapt rather than clobber.

## 5. Resume

On every invocation of this skill, first check whether `.claude/tycoon/plan.json` exists:

- If it doesn't, and the user is asking to plan a project, start at **Decompose**.
- If it does, re-read it in full and resume from wherever `currentPhaseId` / `currentTaskId` and the task statuses indicate — do not re-decompose an existing plan unless the user explicitly asks to re-plan. Report the current state (phase, task, gate) back to the user before resuming the execute loop, so they know where things stand.

## Notes

- This skill is content and process only — it never edits extension TypeScript, hooks, settings, or `media/main.js`. It only reads design docs and reads/writes `.claude/tycoon/plan.json`.
- Keep phases small enough that a human can review the diff of a completed phase before approving the next one.
- Acceptance criteria are the contract between this skill and the delegated agents — write them as if a stranger will judge the work by them alone, because in the verify step, you will.
