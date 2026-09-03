# OpenCode Hook Probe Findings (plan p3-t2)

GO — the plugin hook surface (`tool.execute.before/after`, `event`) delivers everything TycoonAgents needs to map Task-tool spawns, tokens/cost, and turn boundaries to HookRecord events; the one open risk (recursion) is a permission default, not a missing signal.

- OpenCode version: `1.18.27` (from `event:session.created` → `payload.event.properties.info.version`)
- Provider/model: OpenCode Zen, `providerID: "opencode"`, `modelID: "big-pickle"` (every `assistantInfos`/`tool.execute.after` entry)
- Date of run: session titles read `"New session - 2026-09-03T03:27:38.501Z"`
- Plugin location that loaded: `.opencode/plugin/` (singular `plugin`), confirmed by `PROBE_INIT` firing and `.opencode/node_modules/@opencode-ai` present (auto-installed)

## (a) Task-tool payload

`tool.execute.before` for tool `task`:
```json
{"hook":"tool.execute.before","at":1788406063414,"payload":[{"tool":"task","sessionID":"ses_f9ab131faffeHBfizi32Ds7da1","callID":"call_c262d5015ae24e1c8354fe21"},{"args":{"subagent_type":"probe-sub","description":"Probe sub hello","prompt":"The user sent: @probe-sub hello..."}}]}
```
Matching `tool.execute.after`:
```json
{"hook":"tool.execute.after","at":1788406085036,"payload":[{"tool":"task","sessionID":"ses_f9ab131faffeHBfizi32Ds7da1","callID":"call_c262d5015ae24e1c8354fe21","args":{"subagent_type":"probe-sub",...}},{"title":"Probe sub hello","metadata":{"parentSessionId":"ses_f9ab131faffeHBfizi32Ds7da1","sessionId":"ses_f9ab11ec3ffe6teMMEqORyrFMr","model":{"modelID":"big-pickle","providerID":"opencode"},"truncated":false},"output":"<task id=\"ses_f9ab11ec3ffe6teMMEqORyrFMr\" state=\"completed\">...</task>"}]}
```
Field locations:
- Agent name: `payload[1].args.subagent_type` (the `.before` payload)
- Model: `payload[1].metadata.model.{modelID, providerID}` (the `.after` payload)
- Parent session: `payload[1].metadata.parentSessionId` (`.after`)
- Child session: `payload[1].metadata.sessionId` (`.after`)

CallID formats seen (correlate `.before`/`.after` by `payload[0].callID`, matching `payload[0].sessionID` = the *parent* session):
- `call_49c68f5836c14bc099a2d837`, `call_77a6cad3df654c6da9e13365`, `call_c262d5015ae24e1c8354fe21` — `call_…` (native tool-call ids)
- `chatcmpl-tool-aa7cdb649e6a9aa6` — `chatcmpl-tool-…` (OpenAI-compatible chat-completions shim id, seen on one of the four `task` invocations)

## (b) Tokens/cost

One `PROBE_CHILD_USAGE` entry (via `client.session.messages({path:{id}})`), `assistantInfos[0]`:
```json
{"id":"msg_0654ee1a6001upngGU7nzMvcvG","modelID":"big-pickle","providerID":"opencode","tokens":{"total":11781,"input":11667,"output":114,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0,"time":{"created":1788406063526,"completed":1788406068081}}
```
`summedTokens` for the session: `{"input":13106,"output":780,"reasoning":0,"cacheRead":24192,"cacheWrite":0}`.

`event:message.updated` payloads DO carry `tokens`/`cost` directly on `payload.event.properties.info` for assistant messages — no SDK round-trip is strictly required once the message reaches a completed state. Example (mid-run, still zeroed at message start):
```json
{"type":"message.updated","properties":{"sessionID":"ses_f9ab131faffeHBfizi32Ds7da1","info":{"id":"msg_0654ece82001xpzr6W6lOIewS4","role":"assistant","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"modelID":"big-pickle","providerID":"opencode",...}}}}
```
15 of the 24 `message.updated` lines in the log contain a `"tokens"` key; the log does not capture a final assistant `message.updated` with non-zero totals for the same message id as a `PROBE_CHILD_USAGE` entry, so whether the *final* update always carries the settled totals is UNRESOLVED from this run — treat the SDK fetch (`client.session.messages`) as the reliable source and the inline `message.updated` tokens as a possible fast-path to verify later.

`cost: 0` throughout is OpenCode Zen's free-tier model (`big-pickle`), not a missing field — every usage record has a well-formed `cost` key.

## (c) Recursion

Recursion did NOT happen as a genuine nested Task-tool call. Trace:
1. Parent session `ses_f9ab131faffeHBfizi32Ds7da1` spawned child `ses_f9ab11ec3ffe6teMMEqORyrFMr` via `task` (see (a)).
2. `event:session.created` for the child shows OpenCode itself denies the tool:
```json
{"sessionID":"ses_f9ab11ec3ffe6teMMEqORyrFMr","info":{"id":"ses_f9ab11ec3ffe6teMMEqORyrFMr","agent":"probe-sub","parentID":"ses_f9ab131faffeHBfizi32Ds7da1","permission":[{"permission":"todowrite","pattern":"*","action":"deny"},{"permission":"task","pattern":"*","action":"deny"}],...}}
```
   The `probe-sub` agent's session is created with `permission: [{"permission":"task","pattern":"*","action":"deny"}]` — no `tool.execute.before` with `sessionID` equal to this child session ever appears for tool `task` in the log (only `bash`, then `glob`).
3. Inside the child session the model instead ran `bash: opencode task --subagent probe-sub --message "..."` (exit 1, unrecognized command — `opencode` CLI has no `task` subcommand), then `opencode agent --help`, then `glob .claude/agents/*.md` (0 results), and finally replied in prose: *"The `probe-sub` agent is **not operational** in this environment... No Task tool available... No agent definitions exist... No CLI equivalent."*

Verdict: recursion is blocked by OpenCode's own per-session `permission` deny-list for the `task` tool on subagent sessions, not by an absent signal — the plugin can still observe the attempt (`tool.execute.before/after` for `bash`/`glob` on the child sessionID) even when the recursive `task` call itself never fires.

## (d) Prompt-submit signal

`event:session.created` (new user turn / new session):
```json
{"type":"session.created","properties":{"sessionID":"ses_f9ab131faffeHBfizi32Ds7da1","info":{"id":"ses_f9ab131faffeHBfizi32Ds7da1","slug":"stellar-island","version":"1.18.27","directory":"D:\\ACode\\TycoonAgents","title":"New session - 2026-09-03T03:27:38.501Z","agent":"build","model":{"id":"big-pickle","providerID":"opencode"},...}}}
```
For a child/subagent session it additionally carries `parentID` and a descriptive `title` (e.g. `"Probe sub hello (@probe-sub subagent)"`) plus a `permission` array.

First `event:message.updated` with `role:"user"` for that turn:
```json
{"type":"message.updated","properties":{"sessionID":"ses_f9ab131faffeHBfizi32Ds7da1","info":{"id":"msg_0654ece27001G0X7wf9qcCrMc4","role":"user","sessionID":"ses_f9ab131faffeHBfizi32Ds7da1","time":{"created":1788406058535},"agent":"build","model":{"providerID":"opencode","modelID":"big-pickle"}}}}}
```
Recommendation: map `session.created` (no `parentID`) → `SessionStart`; the first `message.updated role:"user"` in that session → `UserPromptSubmit`; `event:session.idle` (`{"type":"session.idle","properties":{"sessionID":...}}`) → `Stop`/`SubagentStop` depending on whether the session has a `parentID`.

## Event catalogue (994 lines)

| hook | count | payload summary |
|---|---|---|
| `event:dispatch` | 506 | wraps every bus event as `{event:{id,type,properties}}`; `type` values below are nested inside this hook, not top-level hooks |
| `event:message.part.delta` | 299 | streaming text/reasoning deltas, `properties.part` fragments |
| `event:plugin.added` | 90 | `{properties:{id}}` — built-in doc/reference plugins registering (e.g. `core/config-reference`) |
| `event:message.updated` | 24 | full message `info` (role, agent, model, cost, tokens, time) |
| `event:session.status` | 14 | `{type:"busy"|"idle", ...}` session busy/idle transitions |
| `event:session.updated` | 11 | session `info` snapshot after mutation |
| `tool.execute.before` | 7 | `[{tool,sessionID,callID},{args}]` pre-execution |
| `event:session.diff` | 7 | working-tree diff snapshot tied to a session |
| `PROBE_INIT` | 7 | plugin-internal: `{note,ctx:[...]}` listing plugin context keys |
| `event:message.part.updated` | 6 | one part (text/reasoning/tool) reaching a stable state |
| `tool.execute.after` | 5 | `[{tool,sessionID,callID,args},{title,metadata,output}]` post-execution |
| `event:catalog.updated` | 4 | `{properties:{}}` — empty, catalog refresh signal only |
| `PROBE_PARENT_USAGE` | 3 | plugin-internal: usage rollup for the parent session |
| `shell.env` | 2 | `[{cwd,sessionID,callID},{env}]` — env exposed to a shell tool call (empty `env:{}` both times) |
| `event:session.idle` | 2 | `{properties:{sessionID}}` — session went idle |
| `event:session.created` | 2 | new-session/new-subagent-session `info` (see (d)) |
| `event:reference.updated` | 2 | `{properties:{}}` — doc reference index refresh |
| `event:integration.updated` | 2 | `{properties:{}}` — integration registry refresh |
| `PROBE_CHILD_USAGE` | 1 | plugin-internal: `client.session.messages` usage rollup for a child session (see (b)) |

Note: the `event` hook's `type` field (message.part.delta, plugin.added, message.part.updated, message.updated, busy/idle status, tool, text, session.status, session.updated, reasoning, session.diff, idle, catalog.updated, agent, session.idle, session.created, reference.updated, integration.updated) is nested one level inside every `event:dispatch`/`event:*` line above, not a separate top-level hook name.

## Findings affecting other phases

(i) **CLAUDE.md doctrine bleeds into OpenCode.** The `probe-sub` child session, blocked from the `task` tool, fell back to reasoning from TycoonAgents' own delegation rules and searched for `.claude/agents/*.md`, then reported itself not operational: *"The `probe-sub` agent is **not operational** in this environment... No Task tool available... No agent definitions exist — `.claude/agents/*.md` returns zero results... No CLI equivalent."* → M3's `AGENTS.md` managed block must explicitly neutralize Claude-Code-specific delegation instructions (no `.claude/agents/` references, no Task-tool assumptions) so OpenCode agents don't reason themselves into a dead end.

(ii) **Model id format differs by context.** Per `standalone/spike/README.md`, OpenCode rejected `anthropic/claude-haiku-4-5` in an agent file and suggested the bare `claude-haiku-4-5`. At runtime, Zen reports `providerID:"opencode"`, `modelID:"big-pickle"` (not the display name) — every `.after`/usage record in the log confirms this. → the M2 translator must emit runtime-accepted bare ids in agent-definition files while expecting/normalizing whatever `providerID`/`modelID` pair the actual provider reports at execution time.

(iii) Anthropic subscription auth is unavailable in OpenCode (per README/docs read for the spike: API key, Bedrock, Vertex, Zen, or Copilot only) → Claude agents run through OpenCode are `costModelClass: "metered"`, not the subscription-covered class TycoonAgents assumes for Claude Code.

(iv) Plugin loads from `.opencode/plugin/` (singular), and OpenCode auto-installed `@opencode-ai/plugin` + `@opencode-ai/sdk` into `.opencode/node_modules` (confirmed: `ls .opencode/node_modules` → `@opencode-ai`).

(v) Plugin context (`PROBE_INIT`) exposes: `ctx:["client","project","worktree","directory","experimental_workspace","serverUrl","$"]` — `serverUrl` and `client` are the two needed for the SDK usage round-trip used in (b).

## Front-end coverage

- Terminal TUI: CONFIRMED — this entire log was captured from a TUI session (`opencode` with no args). Verified again 2026-09-03 with the shipped plugin (see "M2 smoke" below).
- Desktop app: UNRESOLVED — not yet run; no session in the log carries an origin/client marker distinguishing it from the TUI.
- VS Code extension: UNRESOLVED — not yet run; same reasoning.

## Recommended mapping table (M2 plugin)

| OpenCode signal | HookRecord event | Source field |
|---|---|---|
| `event:message.updated`, first `role:"user"` in a session with no `parentID` | `UserPromptSubmit` | `payload.event.properties.info.{id,sessionID,time.created}` |
| `tool.execute.before`, `payload[0].tool === "task"` | `PreToolUse` (Task) with `workerId`/`model`/`vendor` | `payload[1].args.subagent_type` (workerId/agent); model/vendor resolved later from the matching `.after`'s `payload[1].metadata.model.{modelID,providerID}`; correlate via `payload[0].callID` |
| `tool.execute.before`, any other `tool` | `PreToolUse <tool>` | `payload[0].{tool,sessionID,callID}`, `payload[1].args` |
| `tool.execute.after` for `task`, or `event:session.idle` where `sessionID` has a `parentID` | `SubagentStop` with tokens/cacheReadTokens/model | `payload[1].metadata.{parentSessionId,sessionId,model}` (after) plus a `client.session.messages` usage fetch for `tokens.{input,output}`/`cache.read`/`cost` (see (b)) |
| `event:session.idle` where `sessionID` has no `parentID` | `Stop` | `payload.event.properties.sessionID` |

## M2 smoke (2026-09-03)

Setup: OpenCode 1.18.27 terminal TUI, Zen provider model `big-pickle`, project `D:\ACode\TycoonAgents`, shipped plugin staged at `.opencode/plugin/tycoon-opencode-plugin.ts` (+ `agentBackend.js`, `modelAliases.js`); standalone run as `node standalone\src\cli.mjs watch . --provider opencode`; VS Code extension watching the same project concurrently.

User sent `@probe-sub hello`. Observed: `probe-sub` appeared on the standalone board and in the theater/stage view, ran ~80 s, showed 24.3k tokens, and a task was recorded. No MCP calls were made so no MCP metrics were expected.

Raw records written to `.claude/tycoon/activity.jsonl`:
```json
{"event":"UserPromptSubmit","provider":"opencode","at":1788419319025,"sessionId":"ses_f99e6db17ffeKDQJS3wu7FVmG2"}
{"event":"PreToolUse","provider":"opencode","at":1788419335531,"tool":"Task","workerId":"probe-sub","agentDescription":"Probe subagent test","sessionId":"ses_f99e6db17ffeKDQJS3wu7FVmG2","parentId":"ses_f99e6db17ffeKDQJS3wu7FVmG2"}
{"event":"PreToolUse","provider":"opencode","at":1788419360158,"tool":"Read","workerId":"probe-sub","sessionId":"ses_f99e69a8effe2dvfgvuhu0E6lJ"}
{"event":"SubagentStop","provider":"opencode","at":1788419415536,"workerId":"probe-sub","sessionId":"ses_f99e6db17ffeKDQJS3wu7FVmG2","model":"opencode/big-pickle","tokens":12679,"cacheReadTokens":11584}
```

Note tokens 12679 + cacheReadTokens 11584 = 24263, matching the 24.3k shown; duration from Task PreToolUse to SubagentStop = 80.0 s.

Note on numbers: the OpenCode TUI showed 15,414 for the same run. That figure is the parent session's current context size, not usage, and excludes the child session the subagent ran in. TycoonAgents shows the subagent's cumulative usage as reported at SubagentStop (fresh + cache-read tokens), the same accounting used for Claude Code, so the two are not expected to match. The user confirmed the run used OpenCode Zen's free `big-pickle` model.

Defects found and fixed during the smoke (standalone only, all covered by tests in `standalone/test/`): OpenCode mapper was not registered in the standalone (now `src/providers/registerAllMappers.ts`, shared with the VS Code host); boot handshake replies (installState, packs, engineStatus, PLAN_STATE, OFFLOAD_OFFER_STATE, THEME_INITIALIZED/THEME_NONE) were lost to an SSE-connect race and getSettings/getSkills/getMcp were unanswered (now sent on `/events` connect and answered); transient EPERM on `active-agent.json` when the VS Code host writes concurrently (now retried with bounded Atomics.wait backoff, rate-limited logging).

Coverage limits: terminal TUI only; OpenCode desktop app and OpenCode VS Code extension not exercised; the subagent's own Read PreToolUse carried the child sessionId without parentId (observe whether the panel attributes it to `probe-sub` via `workerId` — it did in this run).

Verdict: M2 smoke PASS.

## M5 smoke (2026-09-03, run by agent on user's machine)

Clone path: `D:/ACode/TycoonAgents-smoke` (fresh local clone of HEAD of `main`, commit `beb59b9`).

README steps followed (`README.md` "Using OpenCode as the provider" + `standalone/README.md`):

1. `npm install` — exit 0 (13 vulnerabilities reported by npm audit, unrelated to this smoke; esbuild postinstall-script warning, no action needed).
2. `npm run build` (`tsc -p .` + `copy:hookruntime`) — exit 0, copied `agentBackend.js` and `modelAliases.js` into `hooks/`.
3. `npm run opencode:config` — exit 0, wrote `AGENTS.md`.
4. `node standalone/src/cli.mjs install-hook . --opencode` — exit 0, copied `tycoon-opencode-plugin.ts`, `agentBackend.js`, `modelAliases.js` into `.opencode/plugin/`. `.opencode/agents/` was populated with the full specialist roster (14 files incl. `probe-sub.md`, `orchestrator.md`, etc.) and `AGENTS.md` head showed the managed-block markers (`<!-- TYCOON-MANAGED:START/END -->`) present but empty between them.

Deviations from README:
- `git clone` initially failed with "detected dubious ownership" (Windows/Git ownership check on the source repo's `.git`); required `git config --global --add safe.directory D:/ACode/TycoonAgents/.git` first. Not mentioned in README; environment-specific, not a repo defect.
- Started the standalone with `TYCOON_STANDALONE_NO_OPEN=1` (documented env var, just not called out in the "Using OpenCode as the provider" section) to avoid a browser-launch attempt in a headless shell.

Standalone server: started via `TYCOON_STANDALONE_PORT=4311 TYCOON_STANDALONE_NO_OPEN=1 node standalone/src/cli.mjs watch . --provider opencode`, backgrounded, log at `smoke-standalone.log`. `curl http://127.0.0.1:4311/` returned the host HTML (exit 0). `curl -N http://127.0.0.1:4311/events` streamed `state`, `installState`, `packs`, `engineStatus`, `PLAN_STATE`, `OFFLOAD_OFFER_STATE`, and `THEME_INITIALIZED` (bundled "Survivors vs Zombies" theme already present in app-data theme store) — all as documented.

`opencode run "@probe-sub hello, then stop"` (opencode 1.18.27, model `opencode/big-pickle`) — worked non-interactively with no extra flags needed; exit 0, ~30s. Output: "Probe subagent test — Probe-Sub Agent" then "Probe ran and read `AGENTS.md` successfully. Stopping now."

`grep '"provider":"opencode"' .claude/tycoon/activity.jsonl` — all 5 opencode-tagged lines, verbatim:
```
{"event":"UserPromptSubmit","provider":"opencode","at":1788462086146,"sessionId":"ses_f975a4806ffedly4b5FKh6utPz"}
{"event":"PreToolUse","provider":"opencode","at":1788462095182,"tool":"Task","workerId":"probe-sub","agentDescription":"Probe subagent test","sessionId":"ses_f975a4806ffedly4b5FKh6utPz","parentId":"ses_f975a4806ffedly4b5FKh6utPz"}
{"event":"PreToolUse","provider":"opencode","at":1788462100532,"tool":"Read","workerId":"probe-sub","sessionId":"ses_f975a24aaffeD2mj16uZw9ZTZJ"}
{"event":"SubagentStop","provider":"opencode","at":1788462107495,"workerId":"probe-sub","sessionId":"ses_f975a4806ffedly4b5FKh6utPz","model":"opencode/big-pickle","tokens":5200,"cacheReadTokens":4800}
{"event":"Stop","provider":"opencode","at":1788462113770,"sessionId":"ses_f975a4806ffedly4b5FKh6utPz"}
```

No dedicated `GET /state` REST route exists in `standalone/src/server.mjs` (state is push-only over SSE `/events`), so state was read from the `/events` stream instead: it showed `"workers":{"probe-sub":{"id":"probe-sub","role":"Task","state":"leave"}}` and `probe-sub` present in `agentMetrics` (taskCount:1, tokens:5200, cacheReadTokens:4800, directReads:1) alongside the orchestrator (delegations:1). probe-sub appeared correctly as a worker.

Standalone server killed after the run; port 4311 confirmed free (no LISTENING entry in `netstat -ano`, only stale TIME_WAIT). Clone folder left in place at `D:/ACode/TycoonAgents-smoke`, no push, no commit.

Verdict: M5 smoke PASS. No failing step.
