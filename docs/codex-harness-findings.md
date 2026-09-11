# Codex CLI hook harness — spike findings (p22-t2)

codex-cli **0.153.0** (VS Code ChatGPT extension bundle, `openai.chatgpt-26.901.22334-win32-x64`).
Update to 0.153.4 is available but was not installed for this spike. Full detail, commands, and
raw output live in `test/fixtures/codex-hooks/` (README there has commands/redaction notes).

## Supported events (per binary's own strings/schema, not confirmed to actually fire)

`codex features list` reports `hooks: stable, true` and `multi_agent: stable, true`. The binary's
embedded `HookEventName`/`HookEventsToml` enum names, and `--strict-config`-accepted TOML keys,
are: `session_start`, `session_end`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`,
`permission_request`, `pre_compact`, `post_compact`, `subagent_start`, `subagent_stop`, `stop`,
`interrupt`. This is a 1:1 name match with every event TycoonAgents' Claude-hook set uses, plus
`permission_request`/`pre_compact`/`post_compact`/`interrupt` which Claude Code hooks don't have.

Config shape (accepted by `--strict-config`, not confirmed functional — see below):
```toml
[[hooks.session_start]]
matcher = "*"
hooks = [{ type = "command", command = ["node", "record.js", "session_start"], timeout_sec = 20 }]
```

## Critical finding: hooks never actually fired

Across 5 `codex exec --json` runs — PascalCase and snake_case event keys, with/without
`--strict-config`, with/without `-c features.hooks=true` / `--enable hooks`, and with
`--dangerously-bypass-hook-trust` — **no hook command ever executed** (the recorder script never
wrote its output file) and **no `HookStarted`/`HookCompleted` item ever appeared** in the `--json`
stream. The bypass-trust flag visibly took effect (it prints a warning item), but hooks still did
not run. Working hypothesis: hook activation requires a persisted trust record (`HookStateToml
{enabled, trusted_hash}`) normally written by an interactive session accepting a hook-trust
prompt, which `--dangerously-bypass-hook-trust` may not fully substitute for in `exec` mode. Not
confirmed — no `codex trust`-equivalent subcommand was found in `--help` output, and reverse
engineering further (app-server RPC inspection) was out of this spike's time budget.

**No fixture files exist per event** because no event fired. This itself is the deliverable
finding, per the task's own fallback instructions ("if hooks never fire ... record exactly what
was tried"). `test/fixtures/codex-hooks/` holds the config tried, the recorder script, and one
representative run's stderr + JSON stream showing the bypass-trust warning firing with no
follow-on hook events.

`multi_agent` was also enabled and probed once; the plain prompt used did not trigger a
`CollabAgentSpawnBegin`/`CollabAgentSpawnEnd` in the event stream either (a prompt engineered to
force a subagent spawn was not attempted given the time budget and the prior hook failures).

## Parity gaps vs. TycoonAgents' Claude hooks (assessed from schema, since no live payload was captured)

- **UserPromptSubmit context injection**: `user_prompt_submit` exists as an event name, but with
  no confirmed live payload we cannot say whether its hook output can inject additional context
  back into the turn (Claude's `additionalContext` mechanism) or is fire-and-forget. Binary
  strings show an `additionalContextLimit` field on hook config, suggesting some context-injection
  budget exists, but the actual injection contract is unverified.
- **Task attribution by description prefix**: Claude Code's `SubagentStart`/`Stop` hook payload
  carries the task description TycoonAgents parses for agent-name prefixes. Codex's `subagent`
  concept is `CollabAgent*` (spawn/interaction/waiting/close/resume) with fields like
  `sender_thread_id`, `receiver_thread_id`, `receiver_agents`, `agent_nickname`, `agent_role` —
  structurally different (thread/agent-id based, not description-string based). No live payload
  captured to confirm whether a "description" field exists at all.
- **Nested-delegation blocking**: no evidence found of a codex-native mechanism to prevent a
  spawned agent from itself spawning further agents. `max_concurrent_threads_per_session` and
  `max_depth` config keys exist in the binary's config struct strings, which look like the
  relevant control point, but were not exercised.

## Update (retry pass): `notify` fires, `hooks` confirmed still silent

A follow-up pass captured one real, verified payload via the top-level `notify` config key
(not a `hooks.*` event) — see `test/fixtures/codex-hooks/notify-agent-turn-complete.jsonl`:
```json
{"type":"agent-turn-complete","thread-id":"...","turn-id":"...","cwd":"...","client":"codex_exec",
 "input-messages":["..."],"last-assistant-message":"..."}
```
Working config: `notify = ["node", "<abs path>/notify.js"]` in the **user-level**
(`CODEX_HOME/config.toml`), NOT in the project's `.codex/config.toml` — the binary explicitly
rejects `notify` there ("Ignored unsupported project-local config keys ...: notify"). `notify` is
a single fire on turn completion, not the per-lifecycle-event hook system, and carries no
tool-call, subagent, or session-boundary detail — it is not a substitute for the requested
PreToolUse/PostToolUse/SubagentStart/Stop hooks.

`hooks` was retried with the project explicitly marked trusted (`[projects.'<path>']
trust_level = "trusted"` in the isolated `CODEX_HOME/config.toml`, format copied from the real
`~/.codex/config.toml`, which itself has no hook-related keys) and with `[hooks.*]` moved into
the project-scoped `.codex/config.toml` (accepted there without a rejection warning, unlike
`notify`). Hooks still never executed — no `raw-hooks.jsonl` output, no `HookStarted`/
`HookCompleted` items. `state_5.sqlite` in the real `~/.codex` was `strings`-scanned and contains
no hook-trust table. `codex app-server --help` shows a JSON-RPC daemon exists that could be
driven manually (initialize → thread → turn → read notifications) as a further avenue, but this
was not exercised in this pass — time budget did not allow it.

The native session rollout for the notify-producing run was captured (redacted) as
`rollout-agent-turn-01a083bf.jsonl`; its item/event type vocabulary is: `session_meta`,
`turn_context`, `response_item` (message/input_text/output_text/Text), `event_msg`
(UserMessage/AgentMessage/task_started/task_complete/token_count), `token_usage_record`,
`world_state`. No hook-related item types appear.

**Live finding (2026-09-08, codex-cli 0.153.0):** the binary DOES parse project-scoped
`.codex/hooks.json` — it errored with `unknown field `_tycoonManaged`, expected `description` or
`hooks` at line 2 column 18` against our old marker field, confirming the top-level schema is
exactly `{ description?: string, hooks: {...} }`. Parsing is confirmed; whether hooks actually
fire from a schema-valid hooks.json is still untested. `installCodexHooks.ts` now writes only
`description`/`hooks` at the top level, using a known `description` string as the ownership
marker instead of a field the parser rejects.

## app-server JSON-RPC evaluation (p23-t4)

Driven live (not just from `--help`) via `codex app-server` over stdio, using an isolated
`CODEX_HOME` seeded only with a copy of `~/.codex/auth.json` (deleted after the run). Codex-cli
0.153.0 also ships `codex app-server generate-json-schema --out <dir>`, which dumps the full
JSON-RPC protocol (622 definitions) without needing to drive a live process — this was the
primary source for the method/notification inventory below; the live run then confirmed which of
those actually fire and in what order.

**Methods (from `ClientRequest.json`, 99 total; relevant subset):** `initialize`, `thread/start`,
`thread/resume`, `thread/fork`, `thread/archive`, `turn/start`, `turn/interrupt`, `turn/steer`,
`command/exec*`, `mcpServer/tool/call`, `fs/*`. Full list saved to
`test/fixtures/codex-hooks/app-server/client_request_methods.txt`.

**Notifications observed live (subset of 75 in `ServerNotification.json`):** `thread/started`,
`thread/status/changed`, `turn/started`, `turn/completed`, `item/started`, `item/completed`,
`item/agentMessage/delta`, `thread/tokenUsage/updated` (per-turn token breakdown, real time),
`account/rateLimits/updated`, `mcpServer/startupStatus/updated`, `item/commandExecution/requestApproval`,
`serverRequest/resolved`, `thread/archived`. Full list in `server_notification_methods.txt`.

**Sub-agent spawn confirmed live.** Asking one turn to "spawn two parallel sub-agents, each
reading one file" produced `item/started` events of `type: "subAgentActivity"` carrying
`agentThreadId` (the child's own thread id, distinct from the parent `threadId` in the envelope)
and `agentPath` (e.g. `/root/read_a`), followed by full `thread/started`/`turn/started`/`item/*`/
`turn/completed` sequences scoped to that child `threadId`, interleaved with the parent's own
`item/started` of `type: "collabAgentToolCall"` (`tool: "wait"`) while it waited on the children.
Each child thread hit `item/commandExecution/requestApproval` (approval was never granted in this
spike, so children ended `interrupted` — command output itself was not captured, but the
spawn/parent-link/lifecycle shape was). Schema search also surfaced `parentThreadId`,
`SubagentStart`/`SubagentStop`, and `SubAgentActivityKind` types confirming this is a first-class
concept, not incidental.

**Fixtures (redacted, home path → `<HOME>`, no tokens):**
`test/fixtures/codex-hooks/app-server/session-with-subagents.redacted.json` (110-entry raw
send/recv/stderr log: init → thread/start → 2 turns, second turn spawning two sub-agents),
`session-input-type-error.redacted.json` (first attempt, `input_text` rejected — correct variant
is `text`), `client_request_methods.txt`, `server_notification_methods.txt`, `help.txt`.

**Fidelity vs. notify+rollout:** materially higher. notify+rollout gives coarse turn-boundary
events plus a post-hoc JSONL dump; app-server gives real-time per-item streaming (including
token-by-token `agentMessage/delta`), per-turn token usage, per-sub-agent thread ids with a
parent link, and structured approval-request events for exec/file-change/MCP-tool actions — none
of which notify+rollout exposes without re-parsing the rollout file after the fact.

**Recommendation: complement, not supersede, for now.** app-server requires the host to own a
long-lived child process per session (spawn, stdio pump, JSON-RPC id/response bookkeeping,
reconnect-on-crash), track thread/turn state machines, and handle the approval-request
round-trip (a `CodexProvider` using it would need to answer `item/commandExecution/requestApproval`
itself or forward it to the user) — real implementation cost against notify+rollout's "just
tail a file." Given p23-p27 is still gated on the M0 spike and Codex hosts are labeled
Experimental, recommend keeping notify+rollout as the default ingestion path and treating
app-server as an optional higher-fidelity mode (sub-agent tree, live token usage) for a later
phase once the approval/process-ownership work is budgeted — not a p23-p27 blocker.

## Open issues

- `app-server` JSON-RPC (stdio) was evaluated live in p23-t4 (see "## app-server JSON-RPC
  evaluation (p23-t4)" above); recommendation is complement, not supersede, notify+rollout.
- Root cause of hooks not firing is unconfirmed — needs either an interactive trust-acceptance
  session (not scriptable in this exec-only spike) or codex source/support docs.
- No live hook payload was captured, so field-level parity (event schema, ids) is inferred from
  binary strings only, not empirical JSON.
- `multi_agent` spawn was not forced to completion; no `CollabAgent*` payload captured either.
- Recommend a follow-up spike using the interactive TUI (not `exec`) to get past whatever trust
  gate is blocking hook execution, if this path is still wanted.

## Manual live run (p22-t7)

The fixture-driven suite (`test/threeHarnessRegression.test.ts`) covers provider switching,
concurrent two-provider ingestion into one `activity.jsonl`, a fixture simulation of the
ready-test skill's per-agent WorkerSpawned/WorkerStopped check under a codex-tagged roster, and
a ledger check that a codex-reviewer `WorkerSpawned` with `costModelClass: "subscription"` lands
in the subscription cost class. None of this exercises a live Codex binary or an interactive
host, so it does NOT satisfy "ready test passes under Codex on the maintainer machine with a
recorded result" — that step is **not done** and must be run manually:

1. Set the provider to codex for the project: `TYCOON_PROVIDER=codex` in the environment, or
   write `{"provider":"codex"}` into `.claude/tycoon/execution.json` (see
   `src/core/providerSelection.ts`'s precedence).
2. Confirm the codex hook is installed for the project (`hooks/tycoon-codex-hook.cjs` wired into
   `~/.codex/config.toml` / project `.codex/config.toml` — see `installCodexHooks.test.ts` for
   the expected config shape). A live Codex binary reachable per the discovery ladder in
   `docs/PATH-DISCOVERY.md` is required.
3. Open the TycoonAgents panel in VS Code with the codex provider active, then in a live Codex
   session say "ready test" (or run the `tycoon-ready-test` skill) so it spawns every non-lead
   `.claude/agents/*.md` agent in parallel via Codex's Task-equivalent mechanism.
4. Confirm in the panel/visualization that every spawned agent lights up and completes (a
   WorkerSpawned/WorkerStopped pair per agent, same shape asserted by this suite's
   ready-test-sim fixture test, but now sourced from real codex hook writes to
   `.claude/tycoon/activity.jsonl` instead of synthetic records).
5. Record the result here (date, agent count, pass/fail per agent) once run.

### Live run result — 2026-09-08

**Setup.** Provider set via `"provider": "codex"` in `.claude/tycoon/execution.json`. A managed
`notify` entry is present at the top level of `<HOME>/.codex/config.toml` (`notify = ["node",
"<repo>\\hooks\\tycoon-codex-hook.cjs"]`). The project `.codex/hooks.json` contains only
`{description, hooks}` at the top level, with 12 event keys (`session_start`, `session_end`,
`user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `permission_request`, `pre_compact`,
`post_compact`, `subagent_start`, `subagent_stop`, `stop`, `interrupt`) — an earlier
`_tycoonManaged` marker key was rejected by codex-cli 0.153.0 with `unknown field
`_tycoonManaged`, expected `description` or `hooks``. Host: the VS Code Extension Development
Host running this working tree — the installed 0.0.598 build hangs on the unknown `codex`
provider id; this tree fixes that via the panel/extension fallback + warning.

**Run.** Codex was driven via the bundled binary with `-m gpt-6-astra`. Prompt 1 summarized
`package.json`. Prompt 2 asked it to spawn parallel sub-agents; Codex spawned three native
sub-agents, which it named `search_retrieval_1`..`3` (picked up from the `search-retrieval` roster
name in `AGENTS.md`/`.claude/agents`).

**Activity ledger.** `.claude/tycoon/activity.jsonl` shows only `notify`-sourced records for this
run: filtering `provider: "codex"` and excluding `sessionId: "smoke-thread"` gives 11 records, all
`UserPromptSubmit` (5) / `Stop` (6) pairs, across 5 distinct session ids — one parent thread
`01a08436-0127-7e42-9ddd-3fa757a819ed` and three child thread ids (`01a08437-3da8-...`,
`01a08437-5f13-...`, `01a08437-7951-...`), each with one UserPromptSubmit/Stop turn. (A second
`01a08436-91a2-...` id also appears with a lone UserPromptSubmit/Stop pair, likely prompt 1's turn
before the parent id above; no matching rollout file was found for it under the sessions dir
checked.) Zero `pre_tool_use`/`post_tool_use`/`subagent_start`/`subagent_stop` records exist for
provider `codex` — the schema-valid `hooks.json` parses without warnings but its hooks still do
not execute, consistent with the "Critical finding" section above.

**Rollout files.** Under `<HOME>/.codex/sessions/2026/09/08/`, one rollout file per thread exists
for this run (e.g. `rollout-2026-09-08T20-28-47-01a08436-0127-....jsonl` for the parent,
`rollout-2026-09-08T20-30-07-01a08437-3da8-....jsonl` for a child). The parent's `session_meta`
payload has `"thread_source":"user"` and no parent/fork fields. A child's `session_meta` payload
carries: `"parent_thread_id":"01a08436-0127-7e42-9ddd-3fa757a819ed"`,
`"forked_from_id":"01a08436-0127-7e42-9ddd-3fa757a819ed"`, `"thread_source":"subagent"`,
`"agent_nickname":"Hegel"`, `"agent_path":"/root/search_retrieval_1"`, and
`"source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a08436-0127-7e42-9ddd-3fa757a819ed","depth":1,"agent_path":"/root/search_retrieval_1","agent_nickname":"Hegel","agent_role":null}}}`
— exact key names as they appear in the file.

**Gap.** `hooks/tycoon-codex-hook.cjs`'s `mapNotifyPayload` (lines 315-323) builds each record from
only `payload["thread-id"]`/`payload.thread_id`; no parent/fork/subagent linkage field is read
from or present in the notify payload itself, so today's ledger records cannot distinguish a
child-agent turn from a top-level one.

**Proposed: rollout-enriched notify attribution.** On each notify, resolve
`CODEX_HOME/sessions/**/rollout-*<thread-id>*.jsonl`, read its first `session_meta` line, and when
`thread_source` is `"subagent"` emit `WorkerSpawned`/`WorkerStopped` attributed to the specialist
derived from `agent_path`/`agent_nickname`, with `parentId` set to `parent_thread_id`; otherwise
treat the thread as the orchestrator session. This gives per-agent visualization without hooks
ever needing to fire.

**p22-t7 criterion 2 status.** The live ready-test analogue described above RAN on the maintainer
machine on 2026-09-08, with sessions visible end-to-end in the activity ledger and rollout files;
per-agent attribution in the panel is NOT yet achieved pending the rollout-enriched notify work
above. Panel observation: Panel observation: not captured at the time; see the 2026-09-10 observation under the dispatch runs.

### Live run 2 — 2026-09-08, rollout-enriched attribution (p22-t10)

**Setup.** Same as run 1 above (provider `codex` via `.claude/tycoon/execution.json`, managed
`notify` entry in `<HOME>/.codex/config.toml`, project `.codex/hooks.json` unchanged), plus
`hooks/tycoon-codex-hook.cjs` now reads rollout `session_meta` via `hooks/codexRollout.cjs` to
enrich each notify-derived record with parent/subagent attribution. Same two prompts as run 1
(prompt 1 summarized `package.json`; prompt 2 asked Codex to spawn parallel sub-agents).

**Activity ledger.** `.claude/tycoon/activity.jsonl` shows 11 `provider: "codex"` records for this
run, within the last hour: two parent-turn `UserPromptSubmit`/`Stop` pairs — session
`01a0845c-80ab-7990-ab36-4dd1d164d3b8` (prompt 1) and `01a0845c-4da5-73c1-86af-cf38f47a8e86`
(prompt 2) — plus, under the second parent, three child threads
(`01a0845c-f3a7-7570-a120-cdcc8184e82f`, `01a0845d-13d3-7352-82cf-e463ae458930`,
`01a0845d-2b07-7a03-aba9-58664b7b251d`), each producing one `PreToolUse` record shaped as a
`Task` tool call with `workerId: "search-retrieval"` and `parentId: "01a0845c-4da5-..."`,
followed by a `SubagentStop`, at roughly 04:11:43, 04:11:50, and 04:12:00 UTC respectively. The
parent's final `Stop` for the second prompt followed at 04:12:08 UTC.

**Parent id confirmation.** Codex used a distinct top-level thread id per prompt (two parent-like
ids, one per prompt), not one shared parent. The three children's `parent_thread_id` points at
`01a0845c-4da5-73c1-86af-cf38f47a8e86` (prompt 2's thread), not at `01a0845c-80ab-...` (prompt
1's thread) — confirmed both from each child record's `parentId` field in the ledger and from the
rollout filenames under `<HOME>/.codex/sessions/2026/09/08/`, where rollout files exist only for
`01a0845c-4da5-...` and the three child ids; no rollout file exists for `01a0845c-80ab-...`'s
children because prompt 1 spawned none.

**Conclusion.** Per-agent attribution works via `notify` + rollout `session_meta` enrichment
without any `.codex/hooks.json` hook ever firing (still zero `pre_tool_use`/`post_tool_use`/
`subagent_start`/`subagent_stop` records from the hooks path, consistent with run 1's finding).
p22-t7 criterion 2 is satisfied with a recorded result. Panel observation: Panel observation: not captured at the time; see the 2026-09-10 observation under the dispatch runs.


### Live dispatch run — 2026-09-09 (p23-t6)

**Setup.** codex-cli 0.153.4 (per user report — the OpenAI VS Code extension bundle updated
overnight and discovery re-resolved the path). `<HOME>/.codex/config.toml` carries both the
managed `notify` block and a `[mcp_servers.tycoon]` dispatcher entry (`command` = node.exe,
`args` = `<PROJECT>/hooks/tycoon-dispatcher-mcp.cjs`, `env.TYCOON_CODEX_DISPATCHER_CONFIGURED =
"1"`). AGENTS.md carries the `TYCOON-CODEX-MANAGED` block. Provider `codex`, run from the
Extension Development Host panel.

**Dispatch.** Codex called `tycoon.delegate` for `kimi-reviewer` with a well-formed
`{specialist, description, task}` payload — the observed `agentDescription` was "Summarize
src/core/provider.ts in one sentence" (a one-line task description, not a multi-paragraph task
body). Activity records at 21:27:34 UTC (confirmed against the `at` epoch, `1788989254227`):

```
PreToolUse tool Task workerId kimi-reviewer vendor moonshot model moonshot/kimi-k2
  costModelClass metered sessionId "dispatcher" (no parentId)
ProviderError reason dispatch-failed workerId kimi-reviewer model moonshot/kimi-k2
  vendor moonshot message "OPENAI_COMPAT_BASE_URL is not set." sessionId "dispatcher"
```

Codex reported the failure to the user verbatim; no silent model substitution occurred.

**coding-specialist prompt 1 (Anthropic via `claude -p`).** Codex called `tycoon.delegate` for
`coding-specialist`, but no dispatcher record was written to `activity.jsonl` for that call — cause
unknown for this first run. The second run below (p23-t9/p23-t10 rerun) reproduced the same
delegate call with records present, so the missing-record behavior did not recur.

**Gaps found → registered as plan task p23-t9.**
- `sessionId`/`parentId` show as `"dispatcher"`/absent because the MCP server env sets no
  `TYCOON_CODEX_THREAD_ID`; fix is to resolve the newest user-thread rollout for the project
  cwd instead.
- `costModelClass` is `"metered"` for a local model (kimi-k2 runs locally per the roster);
  fix is to derive `costModelClass` from the agent file's declared backend rather than a
  vendor default.
- `OPENAI_COMPAT_BASE_URL` (and related `OPENAI_COMPAT_*` vars) must already be present in
  the environment Codex itself is launched from — the dispatcher does not yet read the app's
  local env value store (`hooks/localEnvStore.js`). Candidate follow-up, not yet scheduled.

**Panel observation.** Panel observation (2026-09-10, installed test2 VSIX): the Agent Harness select shows "Codex (Experimental)" with the footnote "Applies immediately. Codex hosting is experimental and not yet thoroughly tested."; the rows "Codex hooks: installed [Uninstall]" and "Dispatcher: installed [Uninstall]" render under it; Hook Health reports hooks installed and healthy.

#### Rerun after p23-t9/p23-t10 (same day, ~22:36 UTC)

Verified against `.claude/tycoon/activity.jsonl` (provider `codex`, records at 22:36:51.468–
22:37:16.842 UTC, epochs 1788993411468–1788993436842).

Both delegate calls now carry `sessionId` and `parentId` equal to the live Codex user thread
(`01a08850-2eea-75e2-a72d-028eb26cdc58`), resolved from the newest user-thread rollout for the
project cwd (`hooks/codexRollout.cjs` `findNewestUserThreadForCwd`), instead of `"dispatcher"`.

**coding-specialist.** `PreToolUse` vendor `anthropic`, `costModelClass` `subscription`, followed
by `ProviderError` `dispatch-failed` `"claude CLI exited 1"`. Root cause found by reproduction
outside Codex: `hooks/dispatcherAdapters.cjs` hardcoded `--max-turns 1`, so any task needing a tool
round trip ended with `terminal_reason: max_turns` and `is_error`, exit 1; env stripping and
permission mode were ruled out. Fixed: `CLAUDE_CLI_MAX_TURNS` with a default of 30, and errors now
include redacted argv, the stderr tail, and the CLI's parsed errors. Not yet re-verified live.

**kimi-reviewer.** `PreToolUse` vendor `moonshot`, `costModelClass` `local` (was `metered`),
followed by `ProviderError` `"OPENAI_COMPAT_BASE_URL is not set in the Codex process environment
or the TycoonAgents local env store."` — the env-store lookup (p23-t10) is active; the value
simply is not saved yet. Next step for the maintainer: save the kimi base URL and key on the
Routing screen, then rerun.

**Panel observation.** Panel observation (2026-09-10, installed test2 VSIX): the Agent Harness select shows "Codex (Experimental)" with the footnote "Applies immediately. Codex hosting is experimental and not yet thoroughly tested."; the rows "Codex hooks: installed [Uninstall]" and "Dispatcher: installed [Uninstall]" render under it; Hook Health reports hooks installed and healthy.

**Note.** The maintainer decided to validate via an installed test VSIX
(`dist/tycoonagents-0.0.598-codex-test.vsix`, rollback artifact
`dist/rollback-tycoonagents-0.0.598.vsix`) rather than the Extension Development Host.

#### Rerun 3 — installed test VSIX, first successful cross-vendor delegation

Verified against `.claude/tycoon/activity.jsonl` (provider `codex`, thread
`01a089a0-3492-72c2-a9bc-adb9e26198e3`, ~04:44–04:46 UTC 2026-09-10).

**Host.** The maintainer installed the test build
`dist/tycoonagents-0.0.598-codex-test.vsix`, replacing 0.0.598 in the main VS Code window (no
Extension Development Host used). One popup — "invalid provider id codex … Valid provider ids
are: claude-code, opencode" — appeared once from the old build before the reload took effect;
not reproduced after.

**coding-specialist.** `PreToolUse` vendor `anthropic`, `costModelClass` `subscription`,
`sessionId`/`parentId` both equal to the Codex thread id, at 04:44:14 UTC, followed by
`SubagentStop` at 04:44:23 UTC with `tokens: 543`. Codex received a two-sentence summary of
`src/core/provider.ts`. Root-cause fix that enabled this: `CLAUDE_CLI_MAX_TURNS` default raised
to 30 (was hardcoded `--max-turns 1`).

**kimi-reviewer.** `PreToolUse` vendor `moonshot`, `costModelClass` `local`, followed by
`ProviderError` `"OPENAI_COMPAT_BASE_URL is not set in the Codex process environment or the
TycoonAgents local env store."` at 04:45:57 UTC — expected until the maintainer saves the
endpoint on the Routing screen.

**Panel observation.** Panel observation (2026-09-10, installed test2 VSIX): the Agent Harness select shows "Codex (Experimental)" with the footnote "Applies immediately. Codex hosting is experimental and not yet thoroughly tested."; the rows "Codex hooks: installed [Uninstall]" and "Dispatcher: installed [Uninstall]" render under it; Hook Health reports hooks installed and healthy.

**Follow-up registered.** The extension bundle does not include the Codex hook/dispatcher
installers because no panel code calls them yet (verified by VSIX inspection); the hooks present
on the maintainer's machine were installed from the repo checkout, not the packaged extension.

Phase p23 closed 2026-09-10; the Experimental label is retained by user decision until field-tested.


### Known related issue: ClaudeCodeProvider has the same unfiltered-drain shape

`src/providers/claude-code/claudeCodeProvider.ts`'s `drain()` (~line 47) calls `mapHookRecord`
on every parsed line unconditionally, with no check of the record's own `provider` field at all
(unlike the post-fix `OpenCodeProvider`/`CodexProvider`, which now skip lines whose provider tag
doesn't match `this.id`). In a three-way concurrent run sharing one `activity.jsonl`,
`ClaudeCodeProvider` would still re-map opencode/codex records that use overlapping event names
(e.g. `SubagentStop`), double-emitting them. Not fixed here — `claudeCodeProvider.ts` is outside
this task's owned files — but flagged as an open issue for a follow-up task.

## app-server evaluation (2026-09-11)

**Task p28-t3. Recommendation: GO**, conditional on writing a stdio MCP shim; no code changed in this task.

**Binary probed.** `<extensions-dir>\openai.chatgpt-26.908.31748-win32-x64\bin\windows-x86_64\codex.exe`,
version `0.154.0-alpha.6.1`. `codex.exe app-server --help` confirms `mcp-server` is gone from this
binary's command tree; `app-server` (marked `[experimental]`) is the only agent-loop entry point,
with subcommands `daemon`, `proxy`, `generate-ts`, `generate-json-schema` and transport flags
(`--listen stdio://` default, also `unix://`/`ws://`).

**Protocol shape (from an earlier same-session spike under the scratchpad's `app-server-spike/`,
reused here rather than re-spending quota on a fresh model turn).** JSON-RPC 2.0 over stdio.
Full method/schema lists were captured via `app-server generate-json-schema` and a redacted
two-turn probe transcript, now committed at
`test/fixtures/codex-hooks/app-server/` (`client_request_methods.txt`,
`server_notification_methods.txt`, `help.txt`, two redacted session logs). Lifecycle observed:
client sends `initialize`, then `thread/start` (returns a thread id), then one `turn/start` per
prompt (`turn/steer` and `turn/interrupt` exist for mid-turn control). Server streams
`item/started` → `item/agentMessage/delta` (repeated) → `item/completed`, then `turn/completed`
carries the final assembled message and token usage; `thread/archive` closes the thread. This
covers the three capabilities the shim needs: start-with-prompt (`thread/start` + `turn/start`),
stream events, and a final message (`turn/completed`'s payload plus the last `item/completed`
of kind `agent_message`).

**Session/rollout identity.** The probed run's rollout file
(`app-server-spike/codex_home/archived_sessions/rollout-…-01a084f1-….jsonl`) has the same
`session_meta` shape `hooks/codexRollout.cjs` already parses: `session_id`, `cwd`, `originator`,
`cli_version`, `model_provider`, `source`. `codexRollout.cjs`'s `resolveSessionMeta` reads only
the rollout's first line and matches on `cwd`/thread id — nothing there is `mcp-server`-specific,
so app-server rollouts satisfy it unchanged. One gap: the probed thread ended up under
`codex_home/archived_sessions/`, and `codex_home/sessions/2026/…` held no files for that run —
worth confirming in the shim's own test that live (non-archived) threads land under
`CODEX_HOME/sessions` where `listRolloutFilesNewestFirst` looks, before relying on it.

**Shim design sketch (no code written).** A small Node stdio MCP server, drop-in replacement for
the current `hooks/codex-mcp-launcher.cjs` (0.153 `mcp-server`), exposing the same two tools the
`codex`/`codex-reviewer` MCP config already declares — `codex` (start) and `codex-reply`
(continue) — with unchanged input/output schemas. Internally it spawns
`codex.exe app-server --stdio` as a child process, sends `initialize` once, and on each `codex`
tool call issues `thread/start` + `turn/start`, buffers `item/*`/`turn/completed` notifications
keyed by request id, and resolves the tool call with the assembled final message; `codex-reply`
reuses the existing thread id and issues another `turn/start`. `.claude/agents/codex-reviewer.md`
and `.mcp.json`'s server name/tool names stay untouched — only the launcher script's transport
changes. `hooks/tycoon-codex-hook.cjs` and `codexRollout.cjs` need no change per the identity
check above, but should be exercised against a live app-server run once the shim exists, since
this task only confirms schema compatibility from a prior fixture, not a fresh end-to-end hook
firing.

**Effort estimate.** Shim: ~1 day (process lifecycle, id correlation, error/approval-request
passthrough for `item/commandExecution/requestApproval` which the current MCP flow doesn't need
to handle). Test coverage against the new fixtures: ~0.5 day. Risk: `app-server` is itself
labeled `[experimental]` by OpenAI, so its wire format can still change before GA; the shim
should pin against 0.154 and re-probe on version bumps. Secondary risk: approval-request
notifications (`item/commandExecution/requestApproval`, `ApplyPatchApprovalParams`) have no
analog in the 0.153 `mcp-server` flow and need an explicit auto-approve or reject policy in the
shim or turns will hang.

**Open issues.** Confirm rollout files for a *live* (non-archived) app-server thread land under
`CODEX_HOME/sessions` rather than only `archived_sessions`. Decide the shim's default policy for
`item/commandExecution/requestApproval` before wiring it into `.mcp.json`.

**Update (p30-t1).** The shim sketched above was implemented as `hooks/codex-app-server-mcp.cjs`.
The decline decision (fall back to the shim only when no `mcp-server`-capable binary is found) is still unverified against a live app-server run.

### Live smoke test through the launcher (2026-09-11)

Claude Code was the harness; `.mcp.json`'s `codex` entry ran `node hooks/codex-mcp-launcher.cjs`, which selected the pinned `@openai/codex` 0.153.0 (the OpenAI extension bundle had auto-updated to 0.154.0-alpha, which lacks `mcp-server`). `codex-reviewer` spawned as a subagent made one `mcp__codex__codex` call on `gpt-5` (low reasoning) reviewing `hooks/codexRouting.cjs`; the call returned in about 30 seconds with a threadId and a coherent answer; `activity.jsonl` recorded the codex-reviewer spawn, stop, and the `mcp__codex` tool use attributed to it (attribution under Claude Code confirmed).

Two observations: (1) the activity record labeled the `mcp__codex` call's model as `gpt-6-astra` although the server ran `gpt-5`, so the hook's model label for MCP-backed reviewer calls does not follow the agent file's `backend.model` — fix tracked separately; (2) Codex flagged that the vendor gate in `hooks/codexRouting.cjs` (~309-331) fails open when `vendorOf` returns no metadata; this is by design per the file's header comment (only known non-OpenAI vendors are denied) but has no dedicated test.

Note that app-server-spawned threads have not yet been exercised live; the shim fallback was verified only with `initialize`/`tools-list` against 0.154.

## Gate events per harness (2026-09-11)

Plan p29-t3: surface unseen `gate-events.jsonl` entries (plan gate approvals/rejections) to the
orchestrating model under each harness, mirroring `tycoon-claude-hook.cjs`'s
`additionalContext` injection. Reader/formatter logic is now shared in `hooks/gateEvents.cjs`
(ported from the Claude hook, which is left unchanged); each harness tracks its own cursor file
so none of the three consume another's events from the same `gate-events.jsonl`.

- **Claude Code.** Existing channel: the hook's `additionalContext`, cursor
  `gate-events.cursor`. Unchanged by this task.
- **OpenCode.** Channel: `experimental.chat.system.transform`'s `output.system` array — the same
  mechanism already used for the delegation-nudge queue, confirmed live to reach the model's
  system prompt on its next turn. Wired only for the calling session's own **root** session (no
  `parentID`), so a worker session's turn doesn't also re-surface the same events; the shared
  cursor already guarantees each event is delivered at most once regardless. Cursor
  `gate-events.opencode.cursor`.
- **Codex.** No native injection channel: `tycoon-codex-hook.cjs` runs from Codex's `notify`
  (fire-and-forget, no return value Codex reads back) and the earlier hook-firing spike in this
  file found hook commands never execute at all under 0.153 without an interactively-accepted
  trust record — there is nothing here to hang gate-event text off of. The one channel that does
  reach the Codex orchestrator's context is the `delegate` tool's own result text
  (`hooks/tycoon-dispatcher-mcp.cjs`): unseen gate events are now prefixed onto that text (cursor
  `gate-events.codex.cursor`) so the orchestrator sees them the next time it dispatches a
  specialist. Gap: a Codex orchestrator that goes a long stretch without calling `delegate` sees
  no gate updates at all until its next dispatch — there is no push channel to close that gap
  short of the still-unverified `app-server` transport explored above. `AGENTS.md`'s generated
  Codex-managed block (`scripts/generate-codex-config.mjs`) now tells the orchestrator gate
  updates arrive prefixed on `delegate` results.
