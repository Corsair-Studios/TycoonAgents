# KNOWN BUG: concurrent same-type agents can still be mis-attributed

**Status: PARTIALLY FIXED (2026-08-20).** Three fixes landed in
`hooks/tycoon-claude-hook.cjs` after two independent Codex cross-vendor
reviews found a non-atomic UUID bind that could permanently swap which
worker a tool call (and later, a SubagentStop report) gets credited to. A
third Codex session verified the fixes against its own earlier findings and
returned **PARTIAL** — the individual defects it named are closed, but the
end-to-end property ("concurrent same-type workers are always attributed
correctly") does **not** fully hold. This was also observed live: two
concurrent `general-purpose`/sonnet workers had their SubagentStop reports
swapped (the implementation agent's report filed under `search-retrieval`,
the test writer's under `codex-reviewer`).

The full three-session transcript this doc is drawn from lived at
`.wip/codex-verdict-8dfff87.md`, which is gitignored — this doc exists so
the findings aren't lost.

## What was fixed

All three fixes are in `hooks/tycoon-claude-hook.cjs`.

**Fix 1 — single-lock atomic bind**, `resolveNonSpawnAgent` (~:791-822).
Previously the read (with TTL prune), the bind decision, and the write-back
were split across two separate lock acquisitions — a caller could read,
release the lock, decide, then reacquire to write, leaving a window where
two racing first-sightings could both read the same unbound stack and both
decide to bind to the same entry, with the second write silently clobbering
the first (last-writer-wins). Fix 1 puts read → prune → decide → mutate →
write all inside one `acquireLock`/`finally` block, so a second racing call
blocks on the lock and, once it acquires it, sees the first call's
already-written bind.

**Fix 2 — `popMatchedAgent` takes an instanceId**, `popMatchedAgent`
(~:427-471), called from the SubagentStop path at ~:1016 with
`payload.agent_id`. An exact match on an already-bound `instanceId` is now
checked first, ahead of transcript-keyword matching, `subagentType`
matching, and LIFO stack-top — the only discriminator that is exact rather
than heuristic. SubagentStop records now carry the matched `instanceId`
(~:1027-1034) for auditability, showing the true basis for an attribution
rather than only what the payload offered.

**Fix 3 — `lastSeen` stamped on every resolution**, `resolveAgainstStack`
(~:729, ~:746, ~:755). Every case that resolves to a live stack entry now
stamps `entry.lastSeen = now`. TTL eviction (`pruneStackCore`) uses
`effectiveLastActivity` (~:592-596) — `lastSeen`, falling back to the
original spawn `timestamp` only for entries that predate this fix or have
never had a non-spawn call resolve to them — instead of evicting purely on
spawn time. Evictions log which field decided the eviction
(`ageBasis: "lastSeen"` vs `"timestamp"`, ~:630).

Tests: `test/tycoonClaudeHookAttribution.test.ts` (9 cases) and
`test/tycoonClaudeHookAgentOverride.test.ts` (7 cases). Full suite: 1547
TypeScript tests passing.

## What is still broken

### 1. Case-3 ambiguous bind (the important one)

`resolveAgainstStack` (~:739-745), inside `resolveNonSpawnAgent`. When a
call's `instanceId` isn't bound to any stack entry yet and **more than one**
entry is still unbound — two freshly-spawned same-type siblings whose first
calls both land before either is bound — the function falls back to
stack-top and binds *that* entry to the incoming `instanceId`. The bind is
then permanent and sticky: every later call from that instance resolves
"exactly" via case 1, but to the wrong worker.

Fix 1 serialized the *read/decide/write*, which closes the race where two
callers could clobber each other's write. It does not close the mechanism
that produces a wrong bind in the first place — with the lock held, the two
ambiguous first-sightings now happen one after another instead of at the
same instant, but the second one still sees a stack it cannot correctly
disambiguate. Codex, in the post-fix verification:

> "serialization prevents both calls observing the same unbound snapshot,
> but it does not prove the first ambiguous bind is correct... the permanent
> swap still merely appears resolved"

And on Fix 2 riding on top of a bad case-3 bind:

> exactness "only helps if the bind itself is correct"

A bad case-3 bind is faithfully popped wrong by Fix 2's exact match.

The real difficulty: a single tool-call payload carries no discriminator
that distinguishes two same-type siblings from each other. Closing this
needs a genuine signal Claude Code doesn't currently emit on tool-call
payloads (something narrower than `subagent_type`, ideally as exact as the
UUID Fix 2 already relies on) — not a better heuristic layered on top of
stack position.

### 2. Lock-timeout fallback

`resolveNonSpawnAgent` (~:799-804). If `acquireLock` fails within 5000ms,
the function resolves from a raw, unlocked, **unpruned** read and returns a
result without persisting any bind or `lastSeen` stamp. Codex:

> "inconsistent best-effort attribution, not a correctness-preserving path"

This is a smaller defect than the one Fix 1 closed, but it's new: a worker
whose calls keep losing the lock race never gets its `instanceId` bound or
its `lastSeen` refreshed, so it keeps resolving via heuristics on every
call, and it ages out on its original spawn `timestamp` rather than its
actual last activity.

### 3. Immortal orphans

`effectiveLastActivity` (~:592-596). When an entry's `lastSeen` and
`timestamp` are both non-numeric — malformed or missing — the function
returns `now`. That makes the entry's age always `0`, so it can never
exceed the TTL and is never evicted. This is the exact inverse of the bug
Fix 3 was written to close (a live worker being evicted too early because
its timestamp was stale): a corrupted entry now lives forever instead.

### 4. `workerId` is a type label, not a per-instance key

SubagentStop handling (~:1017): `const workerId = (popped && popped.agentId) || "orchestrator"`.
`agentId` is the agent *type* (`"search-retrieval"`, `"codex-reviewer"`,
etc.), not a per-instance identifier. Even with a perfect UUID bind, two
concurrent same-type workers still coalesce into a single panel row —
whichever one's record lands second overwrites what the row shows for the
first. This is a product decision about what a row in the panel *means*,
not a bug fixable by tightening the bind alone; Fix 2 makes the bind exact
without changing what it's exact *to*.

### 5. Spawn-parent site untouched

The spawn-parent matching block (~:1237-1247, inside the Task/spawn
handling path) only exact-matches an `instanceId` that is **already
bound** — it never performs a bind on the spawn call itself, and never
consults the case-2 "single unbound entry" safe-bind that
`resolveAgainstStack` offers. A worker whose very first tool call is itself
a Task spawn (spawning a grandchild) still falls through to stack-top for
that first call, exactly the same as before any of these fixes.

## How to reproduce

Spawn two concurrent `general-purpose`/sonnet workers (e.g. via the
delegation table's coding-specialist + testing-specialist pairing) so both
land on the active-agent stack unbound at roughly the same time, then let
both make tool calls and stop. This was observed live outside of a
constructed test: two workers' SubagentStop reports were swapped — the
implementation agent's final report was filed under `search-retrieval`,
and the test writer's was filed under `codex-reviewer`.

## Green tests do not mean the property holds

The suite passes (1547/1547) because each fix does exactly what it
individually claims: the lock is atomic on its success path, the exact
match is checked first when an `instanceId` is bound, and `lastSeen`
correctly extends the TTL for entries that have it. None of that is false.
But the end-to-end property this work exists to guarantee — that two
concurrent same-type workers are always attributed to the correct one — is
not implied by any of those individual facts holding, and per gap 1 above,
does not currently hold. Treat this doc, not the test suite's pass/fail
status, as the source of truth on whether concurrent attribution is safe.

## Provenance

Found via two independent Codex cross-vendor review sessions on commit
`8dfff87` (one native `mcp__codex__codex`, one routed via an `AGENT:`
override), corroborated by a live production incident in the same session,
then re-verified by a third Codex session against the landed fixes. Full
transcript: `.wip/codex-verdict-8dfff87.md` (gitignored, not tracked).
