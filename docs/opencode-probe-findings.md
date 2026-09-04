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
