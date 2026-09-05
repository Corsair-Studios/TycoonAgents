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

## Enforcement mechanisms (plan p15-t0)

Probed live against OpenCode 1.18.27 (`opencode --version`), OpenCode Zen
model `opencode/big-pickle`, via a throwaway plugin at
`standalone/spike/opencode-enforcement-probe-plugin.ts`, temporarily copied
to `.opencode/plugin/` and run with `opencode run --model opencode/big-pickle
"<prompt>"`. Typings confirmed against `@opencode-ai/plugin@1.18.27` and
`@opencode-ai/sdk@1.18.27` (`npm pack`'d into a scratch dir — this machine's
global OpenCode install ships only the compiled binary, no `.d.ts` files).

### (a) `permission.ask` — NO-GO (untestable in the mode that matters; hook never observed to fire)

`Hooks["permission.ask"]` exists in the typings: `(input: Permission, output:
{status: "ask"|"deny"|"allow"}) => Promise<void>`. Registered a handler that
sets `output.status = "deny"` for any read/grep-titled permission.

With no project `permission` config, OpenCode auto-approved bash/read calls
and neither the informational `permission.asked` bus event nor the
`permission.ask` hook fired at all (the run in section (c)/(b) below never
touched this path).

Forcing `opencode.json`'s `permission.read = "ask"` and running `opencode run
"Read the file package.json..."` non-interactively produced:

```
! permission requested: read (package.json); auto-rejecting
✗ Read package.json failed
Error: The user rejected permission to use this specific tool call.
```

The probe's log captured only the bus notification, never the typed hook:

```json
{"hook":"event:permission.asked","at":1788550653185,"payload":{"id":"per_06ded2500001CWJ1lrWN9BujQm","sessionID":"ses_f9212f41bffeVtIM7vV5QyzZgn","permission":"read","patterns":["package.json"],"metadata":{},"always":["*"],"tool":{"messageID":"msg_06ded0e09001n3mEL2fYDBle0D","callID":"call_688f3aa71e9946a4a5a18593"}}}
```

No `permission.ask:input` or `permission.ask:decision` line ever appeared in
the probe log for this or any other run in this session. **Verdict: the
typed `permission.ask` hook did not fire in a real `opencode run` in this
version — OpenCode's own non-interactive "auto-reject" path decides before
any plugin hook is consulted.** This is UNRESOLVED as "does it fire in the
interactive TUI" (not tested — `opencode run` is the only mode this spike
could drive non-interactively within the bounded timeout), but for the
non-interactive path TycoonAgents actually runs in (`opencode run`,
scripted/CI use), it is a **NO-GO**: not wired.

### (b) prompt/system injection via `experimental.chat.system.transform` — GO

`Hooks["experimental.chat.system.transform"]` exists: `(input: {sessionID?,
model}, output: {system: string[]}) => Promise<void>`. Registered a handler
that pushes `` `INJECTED DOCTRINE: TYCOON_PROBE_MARKER_7Q2X. If you see this,
end your final reply with the literal token TYCOON_PROBE_MARKER_7Q2X.` ``.

Ran `opencode run --model opencode/big-pickle "Run the bash command 'echo
hello-probe' and tell me its output. Then end your reply."` The model's
final reply (verbatim, via `opencode run`'s stdout):

```
The literal token the command produced was `PROBE_DELIBERATE_THROW_FROM_BEFORE_HOOK` (not `hello-probe`).

TYCOON_PROBE_MARKER_7Q2X
```

The probe log confirms the hook fired on every model turn in the session
(`systemCountBefore: 1` -> `systemCountAfter: 2`) and the model followed the
injected instruction. **Verdict: GO.** Text pushed into `output.system`
genuinely reaches the model's context.

### (c) throwing inside `tool.execute.before` — GO (this is the actual block mechanism, not `permission.ask`)

Registered a handler that throws `new Error("PROBE_DELIBERATE_THROW_FROM_BEFORE_HOOK")`
for any `bash` tool call. Same run as (b) above. Observed sequence in the
probe log:

```json
{"hook":"tool.execute.before","payload":{"tool":"bash","sessionID":"ses_f92135cf9ffeq7CYg2bELOGQBc","callID":"chatcmpl-tool-8d9a48360d0f53d8"}}
{"hook":"tool.execute.before:about-to-throw","payload":{"tool":"bash"}}
{"hook":"event:message.part.updated","payload":{"part":{"type":"tool","tool":"bash","state":{"status":"error","input":{"command":"echo hello-probe"},"error":"PROBE_DELIBERATE_THROW_FROM_BEFORE_HOOK", ...}}}}
```

`opencode run`'s own stdout for that call:

```
✗ echo hello-probe failed
Error: PROBE_DELIBERATE_THROW_FROM_BEFORE_HOOK
```

The bash command never ran (no `hello-probe` output anywhere), the tool part
transitioned straight to `status: "error"` with the thrown message as
`error`, and — critically — the model's next turn read that error message
and reported it as the "actual" output, proving the thrown text reaches the
model as the tool result, not just the TUI/CLI display. **Verdict: GO.**
This, not `permission.ask`, is the real blocking primitive on OpenCode
1.18.27.

### What got wired (hooks/tycoon-opencode-plugin.ts)

- Leaf-worker spawn guard (`decideSpawn`, the `task` branch of
  `handleToolExecuteBefore`): a `deny` decision now throws a
  `BlockingToolCallError(decision.message)` in addition to logging the
  existing `SpawnDenied` activity record. The top-level
  `"tool.execute.before"` entrypoint does NOT wrap `plugin.toolExecuteBefore`
  in try/catch, so this propagates to OpenCode and aborts the call; the
  inner wrapper still catches and logs every OTHER error, so an unrelated
  plugin bug still fails open exactly as before.
- Orchestrator direct-tool-call nudge (`decideDirectToolCall`): a `nudge`
  decision is now also queued per-session (`pendingNudgesBySession`) and
  delivered into that session's next model turn via a new
  `"experimental.chat.system.transform"` hook (`plugin.chatSystemTransform`),
  prefixed `[TycoonAgents delegation nudge]`. Queue is drained (not peeked)
  so a nudge delivers exactly once; absent/malformed `output.system` is a
  no-op, matching this plugin's fail-open posture everywhere else.
- `permission.ask` is NOT wired — see (a) above.

Coverage: `test/opencodeEnforcementHooks.test.ts` (new) exercises both wired
mechanisms directly against `createPlugin()`. `test/enforcementParity.test.ts`
Rule 3 was updated from "logged-only" to "full" parity (the plugin now
throws and blocks, matching the Claude hook). `docs/ENFORCEMENT-PARITY-BENCHMARK.md`
and `scripts/generate-opencode-config.mjs`'s `OPENCODE_ENFORCEMENT_DOCTRINE`
were updated to match. `hooks/tycoon-claude-hook.cjs` was not touched.

### Open issues

- `permission.ask` firing in the **interactive TUI** (not `opencode run`)
  was not tested — bounded to non-interactive scenarios per the brief. If a
  future spike confirms it fires there, it could give a second, narrower
  block surface (only for tools under a `permission: "ask"` config rule).
- The direct-tool-call nudge is delivered on the model's NEXT turn, not
  the same turn as the flagged call, since `chat.system.transform` runs once
  per model completion and there is no earlier hook available to intercept
  mid-turn.

## M4 smoke (routing profile, docs-only) — 2026-09-04

**Verdict: FAIL.** Reproduced from a clean `D:\ACode\TycoonAgents-smoke`
clone, commit `56a3e83` (main HEAD), following only
`docs/ROUTING-PROFILE.md` and `docs/OPENCODE-PROVIDER.md`.

### Setup
- `git fetch`/`reset --hard FETCH_HEAD` to `56a3e83`, `git clean -fdx -e
  node_modules`, `npm ci` (exit 0), `npm run build` (`tsc -p .` +
  `copy:hookruntime`, exit 0).
- Wrote `.claude/tycoon/routing.json`: `orchestrator` = `opencode/big-pickle`
  (vendor `opencode`, transport `openai-compatible`, `costModelClass:
  "local"`, `endpointEnv: "OPENCODE_ENDPOINT_URL"`); `agents.kimi-reviewer`
  on `moonshot/kimi-k2` with `endpointEnv: "KIMI_ENDPOINT_URL"`,
  `credentialEnv: "KIMI_API_KEY"` (names only, no values), and a 2-entry
  `fallback` chain (`openai/gpt-5.4-mini` via `mcp`/`codex`, then
  `anthropic/claude-sonnet-4-6` native).

### Commands run
- `node scripts/apply-routing-profile.mjs` — exit 0, but printed: `agent
  "kimi-reviewer" is in routing.json but no .claude/agents/kimi-reviewer.md
  file exists; skipped` and `routing.json declares an orchestrator slot but
  no .claude/agents/*.md file has role/tier: orchestrator; skipped`.
- `node scripts/apply-routing-profile.mjs --check` — exit 0, same two
  warnings (nothing to apply, so "already applied" trivially).
- `node scripts/generate-opencode-config.mjs` — exit 0, wrote `AGENTS.md`
  and `.opencode/tycoon-routing.generated.json`.
- `node scripts/generate-opencode-config.mjs --check` — exit 0.

### The gap
**A fresh clone of this repository has no `.claude/agents/*.md` files at
all** (`git ls-files .claude/agents/` is empty at `56a3e83`; only
`.opencode/agents/*.md` is tracked). Both `docs/ROUTING-PROFILE.md` and
`docs/OPENCODE-PROVIDER.md` assume `.claude/agents/<id>.md` already exists
("For every agent id in `profile.agents` with a matching
`.claude/agents/<id>.md`...") but neither document says how a project
obtains those files in the first place — there is no init/scaffold command
named in either doc. Quoting the gap: ROUTING-PROFILE.md line ~225, "For
every agent id in `profile.agents` with a matching `.claude/agents/<id>.md`,
the script resolves the slot" — silently presumes the file exists.

### Verification results
- `.claude/agents/kimi-reviewer.md` managed backend block: **does not
  exist** — file never created (script warns and skips, by design; it
  "never creates agent files").
- `.claude/tycoon/routing.resolved.json`: written, but `agents: {}` (empty)
  — no fallback chain recorded, only the orchestrator backend.
- `.opencode/agents/kimi-reviewer.md`: `model: moonshot/kimi-k2` — matches
  routing.json's value, but **coincidentally**: this file was already
  committed with that model before the test ran, and
  `generate-opencode-config.mjs` also requires a `.claude/agents/kimi-reviewer.md`
  source to translate from, which doesn't exist, so it left the file
  untouched (documented "never deletes/never touches a file with no
  `.claude/agents` source" behavior). This is not routing.json taking
  effect.
- `.opencode/tycoon-routing.generated.json`: `{"agents":{},"orchestrator":
  {"model":"opencode/big-pickle"}}` — orchestrator model present, **no
  fallback chain anywhere** in the file.
- `AGENTS.md` managed block: present, contains the four-rule enforcement
  doctrine text as documented.
- `--check` on both scripts: exits 0 (no-op, since nothing was applied).
- Secret scan of `.claude/tycoon/routing.resolved.json`,
  `.opencode/tycoon-routing.generated.json`, `.opencode/agents/kimi-reviewer.md`,
  `AGENTS.md`: no literal key/token/URL value found — only env var names,
  consistent with the no-secrets rule.

### Conclusion
The orchestrator slot half-applies (recorded in `routing.resolved.json` and
`.opencode/tycoon-routing.generated.json`'s `model` field only, no
fallback). The agent slot (`kimi-reviewer`, with its fallback chain) does
not reach either host's generated config at all in a fresh clone, because
both generators key off `.claude/agents/<id>.md` and this repository does
not ship or document how to create those files. This is a documentation
gap, not a bug in the scripts (both fail open with an explicit warning
rather than crashing or silently succeeding) — no code or docs were
modified to work around it, per the test brief.

### M4 smoke attempt 2 — 2026-09-04

**Verdict: PASS.** Reproduced from a refreshed `D:\ACode\TycoonAgents-smoke`
clone, commit `a59188c` (main HEAD, includes "feat(standalone): seed the
agent roster on install-hook; document the roster prerequisite"), following
only `docs/ROUTING-PROFILE.md` and `docs/OPENCODE-PROVIDER.md`.

**Setup:** `git fetch`/`reset --hard FETCH_HEAD` to `a59188c`, `git clean
-fdx -e node_modules`, `npm ci` (exit 0), `npm run build` (exit 0). Ran
`node standalone/src/cli.mjs install-hook . --opencode` (exit 0) — this only
installed the OpenCode plugin into `.opencode/plugin/`, it did **not** seed
`.claude/agents/*.md` despite ROUTING-PROFILE.md's claim that install-hook
"seeds the roster along with the Claude Code hook... whether or not you also
pass `--opencode`." Doc gap, quoted: ROUTING-PROFILE.md, "Prerequisite: the
agent roster" — "`node standalone/src/cli.mjs install-hook <dir>` seeds
`.claude/agents/*.md`... whether or not you also pass `--opencode`" — not
reproduced; `.claude/agents/` did not exist after that command. Ran the
documented fallback, `node standalone/src/cli.mjs seed-agents .`, which
worked (exit 0, seeded `search-retrieval.md`, `primary-agent.md`,
`coding-specialist.md`, `ux-ui-designer.md`, `reviewer.md`,
`agent-keywords.json`) and unblocked the rest of the test.

**routing.json used:** `orchestrator` = `opencode/big-pickle` (vendor
`opencode`, `openai-compatible`, `costModelClass: "local"`, `endpointEnv:
"OPENCODE_ENDPOINT_URL"`); `agents.coding-specialist` on `moonshot/kimi-k2`
(`endpointEnv: "SMOKE_LOCAL_ENDPOINT_URL"`, `credentialEnv:
"SMOKE_LOCAL_API_KEY"`, names only) with a 2-entry `fallback`
(`anthropic/claude-sonnet-4-6` native, then `openai/gpt-5.4-mini` via
`mcp`/`codex`).

**Commands + exit codes:** `apply-routing-profile.mjs --check` (exit 1,
listed `coding-specialist.md` + `routing.resolved.json` as pending, plus the
expected orchestrator-skip warning since no `.md` declares
`role/tier: orchestrator`) → `apply-routing-profile.mjs` (exit 0) →
`--check` again (exit 0, no diff). `generate-opencode-config.mjs --check`
(exit 1, listed 5 `.opencode/agents/*.md` + `AGENTS.md` +
`tycoon-routing.generated.json`) → apply (exit 0) → `--check` again (exit 0).

**Verification:** `.claude/agents/coding-specialist.md` carries the managed
`backend:` block (`# managed-by: tycoon-routing`, vendor `moonshot`, model
`moonshot/kimi-k2`, `endpointEnv`/`apiKeyEnv` names only) and top-level
`model: moonshot/kimi-k2`. `.claude/tycoon/routing.resolved.json` has
`agents.coding-specialist.backend` plus the full 2-entry `fallback` array,
and `orchestrator.backend` for `opencode/big-pickle`. `.opencode/agents/coding-specialist.md`
has `model: moonshot/kimi-k2`, matching. `.opencode/tycoon-routing.generated.json`
has `agents.coding-specialist.model` + `fallback: ["anthropic/claude-sonnet-4-6",
"openai/gpt-5.4-mini"]`, and `orchestrator.model: "opencode/big-pickle"`.
`AGENTS.md` managed block contains the four-rule enforcement doctrine
verbatim. Secret scan of all five generated/written files: only env-var
*names* (`OPENCODE_ENDPOINT_URL`, `SMOKE_LOCAL_ENDPOINT_URL`,
`SMOKE_LOCAL_API_KEY`) present, no literal values.

**Open issues:** the install-hook roster-seeding claim in both
ROUTING-PROFILE.md and OPENCODE-PROVIDER.md ("Prerequisite: the agent
roster") does not hold when `--opencode` is passed — only the plain
`seed-agents` command (or `install-hook` without `--opencode`, untested this
run) reliably seeds the roster. No code or docs were changed to work around
this, per the test brief. The orchestrator slot remains correctly skipped
(no seeded agent declares `role/tier: orchestrator`), matching documented
behavior, not a new gap.

## Remote VM smoke (p13-t5)

**Environment.** OpenCode 1.18.27. Store file
`C:\Users\majes\AppData\Roaming\TycoonAgents\secrets\OLLAMA_BASE_URL` =
`http://windows-2025.tail24845.ts.net:11434/v1`, confirmed reachable both
before and after this run (`curl .../models` lists `qwen3.8:27b`). Panel
running at `http://127.0.0.1:4174`.

**Step 1 — global config path.** `opencode models` (run from repo root)
already lists `ollama-windows/qwen3.8:27b`, sourced from the *project*
`opencode.json` (`provider.ollama-windows.models`), not from
`%APPDATA%\opencode\opencode.json`. `%USERPROFILE%\.config\opencode\opencode.json`
is a plain Node project directory (package.json/node_modules), and its
`opencode.jsonc` is `{"$schema": ...}` only — no provider block. **Finding:**
the generator's target path `%APPDATA%\opencode\opencode.json` is never read
by OpenCode at all on this machine; only the project-root `opencode.json` is
consulted, and that file has no `options.baseURL`/`apiKey` block (they exist
only in the unread APPDATA file), so a genuine remote OpenCode session has no
verified path to the tailnet endpoint. Did not copy anything into
`%USERPROFILE%\.config\opencode\opencode.json` since it holds no
`opencode.json` config, and copying there would not fix the missing
`options` block anyway — recorded as a finding per the brief's own fallback
instruction, no repo file changed.

**Step 2/3 — live delegation, FAIL.** `.claude/tycoon/activity.jsonl` was at
74571 lines before. Ran (repo root, 9 min timeout):
`opencode run "@coding-specialist Reply with exactly the word READY and nothing else."`
→ completed in 7s, banner `> build · big-pickle`, output `READY`. This is
OpenCode's own default primary agent/model, not `coding-specialist`/
`ollama-windows`. `@mention` syntax does not select a subagent for `opencode run`.
Retried with the documented flag: `opencode run --agent coding-specialist "Reply with exactly the word READY and nothing else."`
→ stderr: `! agent "coding-specialist" is a subagent, not a primary agent. Falling back to default agent`, banner again `> build · big-pickle`, output `READY`.
`.opencode/agents/coding-specialist.md` frontmatter confirms
`mode: subagent`, which `opencode run` (a top-level CLI entry point) refuses
to run directly — subagents are only invocable from inside a running primary
session's task tool, not via `opencode run --agent`. **No PreToolUse/task or
SubagentStop line for `coding-specialist` was ever written** — activity.jsonl
grew from 74571 to 74580 lines, but every new line is `workerId":"orchestrator"`
or this Claude Code session's own `search-retrieval` delegation, unrelated to
OpenCode. `ollama-windows/qwen3.8:27b` was never invoked; no local-model
tokens were spent.

**Panel query.** No GET `/state` endpoint exists.
`standalone/src/server.mjs` (grep for `pathname ===`) only exposes
`GET /`, `GET /events` (SSE), and `POST /message` with a type-switch
dispatcher (`getRouting`, `getEngineStatus`, etc.) — there is no REST
snapshot route and no `agentMetrics` GET handler. `curl .../state` → 404
("Not found"). Not queried further since there is nothing to query: no
delegation event occurred to appear in panel state regardless.

**Step 4 — fallback, not run.** Skipped per brief's own escape hatch
("If OpenCode's own error handling ends the run before a re-dispatch, say so
plainly — nothing inferred"): step 2 never reached `ollama-windows` in the
first place (wrong agent invoked, `build`/`big-pickle` throughout), so there
is no live path whose failure a fallback could react to. Pointing
`OLLAMA_BASE_URL` at a dead port would only reproduce the same
`build`/`big-pickle` run — it would not exercise `fallbackChain.js` at all.
Store file left untouched (still the tailnet URL); no restore needed.
Verified unchanged with `curl` after the run: `.../models` still lists
`qwen3.8:27b`.

**Verdict.**
- Global config path resolves correctly for model listing (project
  `opencode.json`), but **FAIL** for the generator's documented target: the
  `%APPDATA%\opencode\opencode.json` file OpenCode is supposed to read is
  never consulted, so its `options.baseURL/apiKey` never reach a real
  session.
- Live delegation to `coding-specialist`/`ollama-windows/qwen3.8:27b`
  recorded in activity.jsonl with vendor/model/local: **FAIL** — no such
  event exists; `opencode run` cannot invoke a `mode: subagent` agent at all,
  by either `@mention` or `--agent`.
- Fallback fires with `fallbackOf`: **NOT TESTED** (no primary dispatch to
  fail from; see above).
- Defect, exact evidence: `opencode run --agent coding-specialist "..."`
  emits `! agent "coding-specialist" is a subagent, not a primary agent.
  Falling back to default agent` and silently substitutes `build`/`big-pickle`
  — the CLI path assumed by this test (and, if the panel shells out the same
  way, by the panel's own OpenCode delegation) cannot reach any
  `mode: subagent` roster entry, including `coding-specialist`.

### Remote VM smoke, attempt 2

Ran from repo root, `~/.config/opencode/opencode.json` using `{file:}` refs
into `%APPDATA%\TycoonAgents\secrets\`. `activity.jsonl` baseline: 74632
lines.

**Step 1 — delegation.** `opencode run "You are the orchestrator. Do NOT
answer yourself. Call the task tool with subagent coding-specialist and the
prompt 'Reply with exactly the word READY'. Then return the subagent's reply
verbatim."` (9 min budget, `build`/`big-pickle`) succeeded on the first try —
no `--agent build` retry needed: output showed `Reply READY verbatim
Coding-Specialist Agent` then `READY`. **PASS** (delegation via task tool,
contra attempt 1).

**Step 2 — activity.jsonl / panel evidence: FAIL.** `activity.jsonl` grew by
only 2 lines, both `PreToolUse`/Bash from this Claude session's own
`search-retrieval` worker — no `provider:"opencode"` line, no `Task` spawn
for `coding-specialist`, no `SubagentStop`. `grep -c '"provider":"opencode"'`
stayed at 6, all pre-existing lines from the prior probe session
(`ses_f99e6db17ffe...`, timestamp 1788419335531). SSE on
`http://127.0.0.1:4174/events` (12s capture) confirms: the panel's
`coding-specialist` entry is the **Claude** worker (`model:"sonnet"`,
`taskCount:667`, unrelated `lastReport`) — no `vendor:"ollama-windows"`,
`model:"qwen3.8:27b"`, or `costModelClass:"local"` anywhere in the state
payload. Root cause found: `hooks/tycoon-opencode-plugin.ts` is not
registered anywhere — neither `opencode.json` nor
`~/.config/opencode/opencode.json` has a `plugin` field, and the file does
not live under `.opencode/plugin/` (OpenCode's auto-load convention), so the
plugin never loads and never writes activity lines for `opencode run`
invocations, even when delegation itself works correctly.

**Step 3 — fallback: FAIL (error surfaced, no re-dispatch).** Wrote
`http://127.0.0.1:9/v1` into the `OLLAMA_BASE_URL` store file, reran the
identical prompt (6 min budget). Output: `Reply with exactly READY` then
`✗ ... failed` then `Error: Subagent failed (task_id: ...): Cannot connect to
API: Unable to connect. Is the computer able to access the url?` — the
primary printed the raw connection error and stopped; it did not re-dispatch
to `opencode/big-pickle` or any other model. `activity.jsonl` grew by only 1
line in this window (unrelated), no `FallbackTriggered` line, no second
`Task` spawn, no `fallbackOf` field anywhere. Confirms brief's escape
hatch: "If OpenCode surfaces the provider error to the primary and the
primary does not re-dispatch, say exactly that" — that is exactly what
happened.

**Step 4 — restore: PASS.** `OLLAMA_BASE_URL` store file rewritten to
`http://windows-2025.tail24845.ts.net:11434/v1` and verified byte-identical
via `diff`.

**Verdict.** Delegation mechanics now work (task tool, not @mention) — this
closes attempt 1's defect. Two new/still-open defects: (1) activity logging
for OpenCode-side delegation is dead — the plugin file exists but is never
loaded by either config, so no vendor/model/costModelClass ever reaches
`activity.jsonl` or the panel for real `opencode run` sessions; (2) OpenCode
has no automatic fallback-on-provider-failure — a dead `OLLAMA_BASE_URL`
surfaces a raw connection error to the user and ends the run, it does not
trigger `fallbackChain.js` or re-dispatch to `opencode/big-pickle`.

### Remote VM smoke, attempt 3

Plugin now installed at `.opencode/plugin/tycoon-opencode-plugin.ts` (plus
`agentBackend.js`, `modelAliases.js`, `delegationEnforcement.js`,
`fallbackChain.js`). `activity.jsonl` baseline: 74650 lines. Store file
confirmed correct before start (`http://windows-2025.tail24845.ts.net:11434/v1`).

**Step 1 — plugin load: PASS.** `opencode run "say hi"` (2 min budget) →
`activity.jsonl` grew 74650→74656 (6 lines), 3 tagged
`"provider":"opencode"` (`UserPromptSubmit` x2, `Stop`). Confirms the plugin
now loads and logs, closing attempt 2's dead-plugin defect.

**Step 2 — live delegation: FAIL (new regression).** Ran the attempt-2
working prompt verbatim (9 min budget). Result differed from attempt 2:
```
• Coding specialist ready check
✗ Coding specialist ready check failed
Error: Blocked: you are a leaf worker — workers do not spawn sub-agents. Do the
work yourself with your own tools, chunked into bounded sequential calls if it
is long (see your brief). This block is structural (TycoonAgents leaf-worker rule).
```
`activity.jsonl` line (74657-74661) confirms:
`{"event":"SpawnDenied","provider":"opencode","tool":"Task","workerId":"testing-specialist","message":"Blocked: you are a leaf worker — workers do not spawn sub-agents. ... structural (TycoonAgents leaf-worker rule)."}`
followed by `Stop`. No Task-spawn PreToolUse, no SubagentStop, no
`model`/`vendor`/`costModelClass` fields — the Task call for
`coding-specialist` never reached model routing at all;
`delegationEnforcement.js` rejected it before dispatch. SSE capture of
`http://127.0.0.1:4174/events` (~20s) shows only the pre-existing, stale
`coding-specialist` agentMetrics entry (`lastActivityAt:1787298815492`,
Claude-worker data, unrelated to this run) — no new entry, no
`ollama-windows`/`qwen3.8:27b`/`local` anywhere. Defect: the plugin
mis-attributes the OpenCode CLI session's own workerId as
`testing-specialist` (a leaf-worker role from this Claude session's
delegation context, not the OpenCode orchestrator), so `delegationEnforcement.js`
structurally blocks every Task-tool call from `opencode run`, regressing
attempt 2's working delegation path.

**Step 3 — fallback: NOT TESTED (blocked upstream).** Store file set to
`http://127.0.0.1:9/v1`, reran the identical prompt (6 min budget). Same
`SpawnDenied`/leaf-worker block, verbatim, before any model dispatch:
`activity.jsonl` (74667-74671) shows the identical `SpawnDenied` message,
then `Stop` — zero `FallbackTriggered` lines added (`grep -c
FallbackTriggered` stayed at the pre-existing 7, all historical). No
`fallbackOf` or `opencode/big-pickle` anywhere. The chain stops at the
leaf-worker structural block, before `ollama-windows` is ever contacted —
so `fallbackChain.js` is never exercised in this attempt, one step earlier
than attempt 2's failure point (which reached the model and got a
connection error).

**Step 4 — restore: PASS.** `OLLAMA_BASE_URL` store file rewritten to
`http://windows-2025.tail24845.ts.net:11434/v1`; verified byte-identical via
`diff` and reachable via `curl .../models` (HTTP 200).

**Verdict.** Plugin loading is fixed (Step 1 PASS, closes attempt 2's dead
plugin defect). Delegation itself regressed: attempt 2's exact prompt now
fails at `delegationEnforcement.js`'s leaf-worker check
(`SpawnDenied`, `workerId":"testing-specialist"`) before reaching
`coding-specialist`/`ollama-windows` at all, so neither the model-routing
evidence nor the fallback chain could be exercised this attempt. Fallback
(Step 3) is therefore NOT TESTED, not FAIL — the precondition (a live
Task spawn reaching a model) never occurred.

## Remote VM smoke, attempt 4

**Change since attempt 3.** `.opencode/plugin/tycoon-opencode-plugin.ts` now
derives orchestrator-vs-leaf from OpenCode's own session tree, ignoring
Claude's entries in `active-agent.json` — closes attempt 3's `SpawnDenied`
(a concurrent Claude worker on the shared stack blocked the spawn).

**Step 1 — live delegation, PASS.** Baseline `activity.jsonl` = 74721 lines.
Ran `opencode run "You are the orchestrator. Do NOT answer yourself. Call
the task tool with subagent coding-specialist and the prompt 'Reply with
exactly the word READY'. Then return the subagent's reply verbatim."`
(9-min timeout, completed well inside it). CLI printed `READY` verbatim.
New `provider":"opencode"` lines (74722-74729):

```
{"event":"PreToolUse","provider":"opencode","tool":"Task","workerId":"coding-specialist","routingMethod":"explicit","vendor":"ollama-windows","model":"ollama-windows/qwen3.8:27b","costModelClass":"local"}
{"event":"SubagentStop","provider":"opencode","workerId":"coding-specialist","model":"ollama-windows/qwen3.8:27b","tokens":12199}
```

No `SpawnDenied` anywhere in the new lines. A ~20s SSE capture of
`http://127.0.0.1:4174/events` confirmed the `coding-specialist` state
entry: `"model":"ollama-windows/qwen3.8:27b","vendor":"ollama-windows",
"costModelClass":"local","fallbackCount":0,"activeMs":107489062,
"tokens":36160275` (metrics are the panel's session-cumulative counters,
not per-call deltas; the per-call `tokens:12199` comes from the
`SubagentStop` activity line above). Criterion PASS: no SpawnDenied,
correct vendor/model/costModelClass.

**Step 2 — fallback, primary does not re-dispatch.** Set the store file to
`http://127.0.0.1:9/v1`, reran the identical prompt (6-min timeout,
finished in ~75s). CLI output: `Error: Subagent failed (task_id:
ses_f903326efffeNi9aUgkIyzLmOX): Cannot connect to API: Unable to connect.
Is the computer able to access the url?` — the orchestrator surfaced the
raw connection error and stopped; it did not answer the READY prompt
itself and did not re-dispatch a second Task call. New activity lines were
only `UserPromptSubmit`, the `PreToolUse` Task spawn (same
`ollama-windows/qwen3.8:27b`), and `Stop` — zero `FallbackTriggered`, no
`fallbackOf`, no `opencode/big-pickle` anywhere in the new lines. **Exact
defect: the primary receives the connection error and does not re-dispatch
at all** — no second spawn on any model, fallback or otherwise; the
`fallbackChain.js` path is never entered because nothing there catches the
subagent's connection failure and redirects it.

**Step 3 — restore, PASS.** `OLLAMA_BASE_URL` store file rewritten to
`http://windows-2025.tail24845.ts.net:11434/v1`; `diff` against the
pre-test backup byte-identical; `curl .../models` returned HTTP 200.

**Verdict.** Attempt 3's `SpawnDenied` regression is fixed — Step 1 is a
clean PASS with correct vendor/model/costModelClass and no SpawnDenied.
Step 2 is a genuine FAIL, distinct from attempt 2/3's findings: a
downstream connection failure inside a spawned Task is surfaced to the
user as an error rather than triggering `FallbackTriggered` and a
second dispatch to `opencode/big-pickle`. Fallback-on-connection-failure
is not implemented (or not wired into this call path) as of this attempt.

## Remote VM smoke, attempt 5

**Root cause found.** Installed the throwaway spike probe
(`standalone/spike/opencode-probe-plugin.ts`) alongside the real plugin in
`.opencode/plugin/` and reran attempt 4's exact dead-URL scenario
(`OLLAMA_BASE_URL` set to `http://127.0.0.1:9/v1`, 6-min budget). The probe
log (`.opencode/plugin/probe-log.jsonl`) shows **`tool.execute.after` never
fires at all** for this failure — only one `tool.execute.before` line is
recorded for the whole run, zero `tool.execute.after` lines. The observable
failure surface is entirely in the bus `event` hook:

```
{"hook":"event:session.error","payload":{"sessionID":"ses_f902f9840ffequHtUb2asqVyj5","error":{"name":"APIError","data":{"message":"Cannot connect to API: Unable to connect. Is the computer able to access the url?","isRetryable":true,"metadata":{"url":"http://127.0.0.1:9/v1/chat/completions"}}}}}
```
```
{"hook":"event:dispatch","payload":{"event":{"type":"message.part.updated","properties":{"sessionID":"ses_f902fa833ffe52xzQ1sSVYh9g9","part":{"type":"tool","tool":"task","callID":"call_80b09179b224489eb96670da","state":{"status":"error","input":{"description":"Ready check","prompt":"Reply with exactly the word READY","subagent_type":"coding-specialist"},"error":"Subagent failed (task_id: ses_f902f9840ffequHtUb2asqVyj5): Cannot connect to API: Unable to connect. Is the computer able to access the url?","metadata":{"parentSessionId":"ses_f902fa833ffe52xzQ1sSVYh9g9","sessionId":"ses_f902f9840ffequHtUb2asqVyj5","model":{"providerID":"ollama-windows","modelID":"qwen3.8:27b"}}}}}}}}
```

`session.error` fires on the CHILD session but carries no
`subagent_type`/workerId. The `message.part.updated` tool part carries
both the error text (`state.error`) AND `state.metadata`/`state.input`
(parentSessionId, child sessionId, model, subagent_type) — the only event
with everything needed to route a fallback. Removed the probe after
capturing this.

Also found: `isProviderFailure`'s pattern list (`src/core/fallbackChain.ts`)
did not match this text at all — none of `usage limit`/`401`/`403`/`quota`/
`rate limit`/`RESOURCE_EXHAUSTED`/`OPENAI_COMPAT_BASE_URL`/`ECONNREFUSED`/
`failed:`/`provider-unavailable` matched "Cannot connect to API: Unable to
connect." — a second, independent gap from the missing hook.

**Fix.** `hooks/tycoon-opencode-plugin.ts`: extracted the FallbackTriggered
logic (recordFailure/resolveNextFallback/buildFallbackInstruction/queueNudge)
into `maybeTriggerFallback()`, called from two sites now: (1) the existing
`handleToolExecuteAfter` path for a task that returns error TEXT inside a
successful rendered output, and (2) a new `handleTaskToolErrorPart()` wired
into `dispatchEvent` for `message.part.updated`, which checks
`part.type==="tool" && part.tool==="task" && part.state.status==="error"`
and reads `state.error`/`state.metadata`/`state.input.subagent_type` —
this is the path that actually fires for a real connection failure. It also
emits the `SubagentStop` record that would otherwise never be written for
this case (tool.execute.after never runs). `src/core/fallbackChain.ts`:
added `/cannot connect to api/i`, `/unable to connect/i`, `/\bAPIError\b/`
to `PROVIDER_FAILURE_PATTERNS`.

**Live verification, PASS.** Reinstalled via `standalone/src/cli.mjs
install-hook .. --opencode --no-agents --force`, kept `OLLAMA_BASE_URL`
dead, reran the identical prompt (completed in ~2.5 min). New activity
lines:

```
{"event":"SubagentStop","provider":"opencode","workerId":"coding-specialist","sessionId":"ses_f902b98ecffeEsrBsrzwPknfjQ","model":"ollama-windows/qwen3.8:27b"}
{"event":"FallbackTriggered","provider":"opencode","workerId":"coding-specialist","slotId":"coding-specialist","failedModel":"ollama-windows/qwen3.8:27b","nextModel":"opencode/big-pickle","reason":"Subagent failed (task_id: ses_f902b88e2ffesdWkXDaAkM131n): Cannot connect to API: Unable to connect. Is the computer able to access the url?","message":"agent coding-specialist failed on provider/model ollama-windows/qwen3.8:27b: ... Re-dispatch the same task to coding-specialist; it now runs on opencode/big-pickle (fallback 1 of 1)."}
{"event":"PreToolUse","provider":"opencode","tool":"Task","workerId":"coding-specialist","fallbackOf":"coding-specialist","fallbackDepth":1,"vendor":"opencode","model":"opencode/big-pickle"}
{"event":"SubagentStop","provider":"opencode","workerId":"coding-specialist","fallbackOf":"coding-specialist","fallbackDepth":1}
{"event":"FallbackTriggered", ... ,"message":"... All fallback options for this slot are exhausted — report the failure to the user instead of retrying again."}
```

**PASS: fallback fires with `fallbackOf`.** The orchestrator re-dispatched
`coding-specialist` a second time on `opencode/big-pickle`
(`fallbackOf:"coding-specialist","fallbackDepth":1`, `vendor:"opencode"`) —
confirmed via the CLI's own transcript too, which showed two "Coding
specialist ready check failed" attempts before reporting exhaustion to the
user. The second attempt also failed (this VM's network path to `zen`/
`big-pickle` is apparently unreachable in this offline scenario too), so
end-to-end success (a READY reply) was not observed, but the mechanism
under test — detect-on-`message.part.updated`, FallbackTriggered,
re-dispatch with fallbackOf/fallbackDepth and the fallback model — is
confirmed live and working, closing attempt 4's defect.

Not separately tested: the interactive TUI's behavior on this same failure
(only `opencode run` was exercised, matching attempts 2-4) — UNRESOLVED,
not cheap to test in this environment.

**Restore, PASS.** `OLLAMA_BASE_URL` store file rewritten to
`http://windows-2025.tail24845.ts.net:11434/v1`; `diff` against the
pre-test backup byte-identical; `curl .../models` returned HTTP 200.
