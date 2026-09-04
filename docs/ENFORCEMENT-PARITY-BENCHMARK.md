# Enforcement Parity Benchmark

Plan task p14-t3. Proves that the OpenCode plugin's ported delegation
enforcement (`hooks/tycoon-opencode-plugin.ts`, backed by the shared
`src/core/delegationEnforcement.ts`) produces the same decisions as the
original `hooks/tycoon-claude-hook.cjs` for the same inputs.

## How to run it

```
npm run test                 # compiles + runs test/delegationEnforcement.test.ts
                              # and test/enforcementParity.test.ts alongside the full suite
node --test out/test/delegationEnforcement.test.js out/test/enforcementParity.test.js
```

`test/delegationEnforcement.test.ts` is unit coverage of every pure export of
`src/core/delegationEnforcement.ts` in isolation. `test/enforcementParity.test.ts`
is the cross-host benchmark described below.

## Fixture roster: `parity-roster-v1`

Each parity test builds a fresh temp project directory containing:

- `.claude/agents/coding-specialist.md` (`description: Implements code, fixes bugs.`)
- `.claude/agents/search-retrieval.md` (`description: Searches and retrieves.`)
- `.claude/agents/uefn-auditor.md` (`description: Reviews changes for correctness.`)
- `.claude/agents/build-lead.md` (`tier: lead`, for the spawn-guard's team_leads exception)
- `.claude/tycoon/agent-keywords.json` with two patterned agents:
  `coding-specialist` (`implement|code|fix|bug`) and `search-retrieval`
  (`search|find|grep|glob`)

Built by `writeFixtureRoster()` in `test/enforcementParity.test.ts:47`. The
Claude hook is driven by spawning `hooks/tycoon-claude-hook.cjs` as a child
process with a JSON payload on stdin (same idiom as
`test/tycoonClaudeHookSpawnGuard.test.ts`); the OpenCode plugin is driven by
transpiling `hooks/tycoon-opencode-plugin.ts` in-memory and calling
`createPlugin(deps)` directly (same idiom as `test/opencodePlugin.test.ts`),
with the real compiled `out/src/core/delegationEnforcement.js` copied next to
it exactly as the installer does. Each scenario that drives both hosts uses
**separate** roster copies for the hook and the plugin sides — both write to
`<root>/.claude/tycoon/activity.jsonl`, so sharing one root would let one
host's record mask the other's.

## Per-rule results

| Rule | Scenario | Claude hook result | OpenCode plugin result | Parity |
| --- | --- | --- | --- | --- |
| 1 | Orchestrator calls Grep directly | `additionalContext` nudge, exact text: *"Grep ran directly on the orchestrator. Searches belong to search-retrieval (Haiku) — cheaper, and the work stays visible in the delegation view."* | Same message logged verbatim on the `PreToolUse` activity record, AND queued into `pendingNudgesBySession` for delivery into the model's own system prompt via `experimental.chat.system.transform` on its next turn (confirmed live — see `docs/opencode-probe-findings.md` "Enforcement mechanisms") | **full** — byte-identical message, both computed by `decideDirectToolCall`; the OpenCode side now reaches the model, not just the activity log |
| 2 | `Task` call, no explicit/resolvable `subagent_type`, description+prompt contain coding keywords | Routes to `coding-specialist` via `routingMethod: "keyword"`, `matchedKeyword: "implement"` | Same `workerId`, `routingMethod`, `matchedKeyword` | **full** — both computed by `matchAgentFromKeywords` over the same `description + " " + prompt` text |
| 3 | A leaf worker (non-empty `agent_id`/pushed active-agent) attempts to spawn | stdout is a single `permissionDecision: "deny"` JSON object with `permissionDecisionReason` = `LEAF_WORKER_DENY_MESSAGE`; **the spawn is structurally blocked** — no normal `PreToolUse`/`Task` record is ever written | `SpawnDenied` activity record logged with `message` = `LEAF_WORKER_DENY_MESSAGE`, then a `BlockingToolCallError(LEAF_WORKER_DENY_MESSAGE)` is thrown from `tool.execute.before` and rethrown by the plugin's wrapper — **the `task` call is aborted and `LEAF_WORKER_DENY_MESSAGE` is surfaced to the model as the tool's error output** (confirmed live against OpenCode 1.18.27 in a real `opencode run` — see `docs/opencode-probe-findings.md` "Enforcement mechanisms") | **full** (as of plan p15-t0) — same message, both hosts now structurally block the spawn instead of only one of them |
| 4 | Specialist finishes → auditor requests changes → fix → re-review approves | No code path exists — `hooks/tycoon-claude-hook.cjs` never calls `startReviewGate`/`advanceReviewGate` (confirmed by grep: zero matches). The single-review-round doctrine lives only in `CLAUDE.md`'s "Review pass" prose, enforced by the orchestrator's own prompt discipline | Live `toolExecuteAfter` wiring reaches `changes_requested` after the first rejection, then `approved` after the fix — exactly 2 `ReviewGate` records | **logged-only** — the "Claude hook" column is the shared state machine (`startReviewGate`/`advanceReviewGate`/`isReviewGateTerminal`) called directly with the same event sequence a compliant orchestrator prompt would produce; it is not driven by any code inside the `.cjs` itself |
| 4b | Two auditor rejections in a row, then a third auditor pass on the same parent session | Same shared state machine reaches `done_after_one_round` after the 2nd rejection and a 3rd `advanceReviewGate` call still resolves to a terminal state | Only 2 `ReviewGate` records are ever written for the parent session — the 3rd `uefn-auditor` `SubagentStop` is a no-op because `isReviewGateTerminal` already reports terminal | **logged-only** — same reasoning as Rule 4; both sides never cycle a third time |

## Distinguishing enforcement-code failure from model non-compliance

This benchmark drives both hosts' enforcement **code** with fixed, literal
inputs (JSON payloads on stdin for the hook; direct `toolExecuteBefore`/
`toolExecuteAfter` calls for the plugin) — there is no LLM in the loop. **A
failure in this benchmark is always an enforcement-code defect**: either
`src/core/delegationEnforcement.ts`'s pure functions disagree with
`hooks/tycoon-claude-hook.cjs`'s inline copies, or one host's wiring calls
those functions with the wrong arguments or drops a decision on the floor.

That is a different failure mode from **model non-compliance** — an agent
that ignores the routing/nudge/deny signal it was given and does the wrong
thing anyway (e.g. an orchestrator that keeps grepping directly after being
nudged, or a worker that tries to spawn a sub-agent despite the doctrine).
Model non-compliance can only be observed in a **live run**, never in this
benchmark:

- The `tycoon-ready-test` skill (`.claude/skills/tycoon-ready-test/SKILL.md`)
  spawns every configured agent in parallel through the real host and checks
  they light up correctly in the delegation visualization.
- The M2/M5 smoke-test sections of `docs/opencode-probe-findings.md` cover
  live OpenCode sessions exercising the same routing/guard paths this
  benchmark only unit-tests.

The mitigation for model non-compliance is doctrine, not code: `AGENTS.md`
(and this project's `CLAUDE.md`) states the delegation rules directly to the
agent so a compliant model follows them even where enforcement is a delivered
nudge rather than a structural block (Rule 1 on both hosts as of plan
p15-t0 — Rule 3 is now a structural block on both hosts too).

## Files

- `test/delegationEnforcement.test.ts` — unit coverage of every pure export
- `test/enforcementParity.test.ts` — the 5 cross-host scenarios (Rule 1, 2,
  3, 4, 4b) described above
