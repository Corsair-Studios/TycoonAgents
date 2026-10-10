Status: not yet available to users — OpenCode is shown as Coming Soon in the harness picker.

# OpenCode Provider

The OpenCode provider bridges OpenCode plugin hook events into the same
`NormalizedEvent` stream the Claude Code provider produces. It works by
having an in-process OpenCode plugin (`hooks/tycoon-opencode-plugin.ts`)
append `HookRecord`-shaped JSON lines to a shared `activity.jsonl`, which
`OpenCodeProvider` tails exactly like the Claude Code provider tails its own
file — both mappers are always registered (`src/providers/registerAllMappers.ts`)
so one activity file can carry a mixed stream from both providers at once.

---

## IPC Contract: HookRecord (OpenCode-flavored)

The plugin writes lines that extend the base `HookRecord`
(`src/providers/claude-code/hookRecord.ts`) with a `provider: "opencode"`
discriminator and extra fields (`src/providers/opencode/mapOpenCodeRecord.ts`,
plugin source `hooks/tycoon-opencode-plugin.ts`):

```ts
interface OpenCodeHookRecord {
  event: "UserPromptSubmit" | "PreToolUse" | "SubagentStop" | "Stop" | "PluginError";
  provider: "opencode";
  at: number;
  tool?: string;
  workerId?: string;
  tokens?: number;
  cacheReadTokens?: number;
  model?: string;
  vendor?: string;
  costModelClass?: "metered" | "subscription" | "local";
  agentDescription?: string;
  parentId?: string;
  sessionId?: string;
  error?: string;
}
```

`PluginError` is OpenCode-only — it maps to zero `NormalizedEvent`s and is
logged once per distinct message (`mapOpenCodeRecord.ts`) so a noisy plugin
error can't spam every poll tick. Every other event delegates straight to
`mapHookRecord` (the Claude Code mapper), since the shapes coincide.

---

## Plugin: `hooks/tycoon-opencode-plugin.ts`

A single file with no runtime dependencies beyond Node builtins (mirroring
`tycoon-claude-hook.cjs`'s zero-dep posture). It exports an OpenCode plugin
entrypoint (`ctx => Hooks`) implementing four hooks:

- `event` — the one hook OpenCode delivers `session.*`/`message.*` bus
  events through.
- `tool.execute.before` / `tool.execute.after` — separate top-level hooks
  for tool calls, including `task` (subagent spawns). `tool.execute.before`
  can also **abort** the call: a leaf-worker spawn attempt throws
  `BlockingToolCallError`, which the entrypoint deliberately does not
  catch, so OpenCode aborts the `task` call and surfaces the error message
  to the model (plan p15-t0; see the Enforcement section below).
- `experimental.chat.system.transform` — delivers queued compliance/fallback
  nudges (`pendingNudgesBySession`) into the model's own system prompt on
  its next turn. Absent on older OpenCode builds; OpenCode simply never
  calls a hook key it doesn't support, so no version guard is needed.

### Event mapping (from the plugin's `dispatchEvent`/`toolExecuteBefore`/`toolExecuteAfter`/`chatSystemTransform`)

| OpenCode signal | HookRecord event | Source |
|---|---|---|
| `event:message.updated`, first root-session (`no parentID`) `role:"user"` message | `UserPromptSubmit` | `handleMessageUpdated`; deduped against a `session.created` for the same session within 1s (`handleSessionCreated`, `makeSubmitDedupe`) |
| `tool.execute.before`, `tool === "task"` | `PreToolUse` with `tool:"Task"`, `workerId` from `args.subagent_type` or keyword/fallback routing, `agentDescription` from `args.description`; pushes the active-agent stack; may carry `fallbackOf`/`fallbackDepth` (see Fallback chains) | `handleToolExecuteBefore` |
| `tool.execute.before`, `tool === "task"`, the CALLING session is a known OpenCode child session (has a recorded `parentID` from its own `session.created`) and `decideSpawn` denies | `SpawnDenied` (activity record), then the call is **aborted** via a thrown `BlockingToolCallError` — no `PreToolUse`/`Task` record follows | `handleToolExecuteBefore` |
| `tool.execute.before`, any other tool | `PreToolUse <mappedTool>`, attributed to the OpenCode agent name of the calling session (`"orchestrator"` when that session has no recorded OpenCode parent); MCP tools resolve `vendor`/`model`/`costModelClass` via `buildMcpBackendRouting`/`lookupMcpBackend`; an orchestrator direct-call nudge (Rule 1) is queued via `queueNudge` when `decideDirectToolCall` returns `"nudge"` | `handleToolExecuteBefore` |
| `tool.execute.after`, `tool === "task"` | `SubagentStop` with `workerId`, `model` (`providerID/modelID`), `tokens`/`cacheReadTokens` from `client.session.messages`, `fallbackOf`/`fallbackDepth` when this dispatch was a fallback re-dispatch; pops the active-agent stack | `handleToolExecuteAfter`, `fetchSessionTokens` |
| `tool.execute.after`, `tool === "task"`, rendered output text matches `isProviderFailure` | `FallbackTriggered` (activity record) plus a queued nudge instructing the orchestrator to re-dispatch on the next fallback model | `handleToolExecuteAfter` (p15-t1) |
| `tool.execute.after`, `tool === "task"`, `workerId === "uefn-auditor"` or another specialist, review-gate state tracked per parent session | `ReviewGate` (activity record) with `reviewGateStatus` | `handleToolExecuteAfter` (best-effort heuristic — see Enforcement section, Rule 3) |
| `event:session.idle`, session has no `parentID` | `Stop` | `handleSessionIdle` |
| `experimental.chat.system.transform` call, session has queued nudges | nudge text appended to `output.system` as `[TycoonAgents delegation nudge] ...` (delivered to the model, not logged as its own activity event) | `chatSystemTransform`, `drainNudges` |
| any handler throwing (except a deliberate `BlockingToolCallError`) | `PluginError` (dropped by the mapper, logged once) | `writePluginError` |

Tool-name normalization (`TOOL_NAME_MAP` in the plugin): `read→Read`,
`edit→Edit`, `write→Write`, `bash→Bash`, `grep→Grep`, `glob→Glob`,
`webfetch→WebFetch`; anything else (including `mcp__<server>__<tool>`)
passes through unchanged so MCP backend routing still applies.

**Note on `session.idle` for subagents:** `handleSessionIdle` treats a
`session.idle` on a session that has a recorded `parentID` as a no-op —
the primary `SubagentStop` path is `tool.execute.after` for `task`, above;
the idle check is defensive only.

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `TYCOON_ACTIVITY_DIR` | `<directory>/.claude/tycoon` | Directory for `activity.jsonl` and `active-agent.json`, read by the plugin's `resolveActivityDir` (`hooks/tycoon-opencode-plugin.ts`). Same variable and same file names the Claude Code hook uses, so both providers can share one activity log. |
| `OPENCODE_BIN` | discovered | Explicit path to the `opencode` binary; wins outright over every other discovery rung. Used by `resolveOpenCode()` (`src/providers/opencode/discovery.ts`). |
| `OPENCODE_CONFIG_DIR` | discovered | Explicit path to the OpenCode config directory; same override precedence as `OPENCODE_BIN`. |

`resolveOpenCode()` implements the project's standard discovery ladder
(`docs/PATH-DISCOVERY.md`): explicit env override first; otherwise `opencode`
on `PATH` (platform-appropriate extensions), then
`~/.config/opencode` / `%APPDATA%/opencode` / `%LOCALAPPDATA%/opencode`, then
`<projectDir>/.opencode`. It throws only when neither a bin path nor a config
dir resolves, listing every location tried and naming both override
variables — never a silent empty/success result.

**Note on the real global config path (Windows):** the discovery ladder
above still probes `%APPDATA%/opencode` and `%LOCALAPPDATA%/opencode` as
candidates (harmless — they're additional signals, not the only one), but
the config directory OpenCode 1.18.27 actually reads on Windows is
`~/.config/opencode` (i.e. `%USERPROFILE%\.config\opencode`), confirmed via
`opencode debug paths` and `opencode debug config` on 2026-09-04 — OpenCode
never reads `%APPDATA%\opencode\opencode.json`. `scripts/
generate-opencode-config.mjs`'s `resolveGlobalOpencodeConfigDir()` writes
only to `~/.config/opencode` (after `OPENCODE_CONFIG_DIR`) for this reason;
see `docs/ROUTING-PROFILE.md`'s GLOBAL opencode.json section for the full
migration note.

`isProjectPluginInstalled(projectDir)` (same file) checks for
`.opencode/plugin/tycoon-opencode-plugin.(ts|js)` and is used only to warn
the user that OpenCode activity won't be captured without the plugin
installed — never to silently fall back to `claude-code`.

---

## Provider selection

`resolveProviderId()` (`src/core/providerSelection.ts`) picks `"claude-code"`
or `"opencode"` by this precedence (highest wins):

1. `TYCOON_PROVIDER` environment variable.
2. The `tycoonagents.provider` VS Code setting (only the VS Code host passes
   a `settingValue`; the standalone CLI never does).
3. The `provider` key in `<projectDir>/.claude/tycoon/execution.json`.
4. `"claude-code"` (default).

An invalid provider id from any of these sources throws immediately, naming
the source and the valid ids (`PROVIDER_IDS = ["claude-code", "opencode"]`) —
it never silently falls back.

Standalone usage:

```sh
node standalone/src/cli.mjs watch . --provider opencode
```

### Settings UI (p13-t7)

Both hosts expose a "Which tool runs your agents?" dropdown in Settings
(Claude Code / OpenCode), backed by two more functions in the same module:

- `describeProviderSelection({ settingValue, env, cwd })` — like
  `resolveProviderId`, but also reports which layer decided it
  (`effective`/`source`/`fileValue`), so the UI can disable the dropdown and
  explain why when `TYCOON_PROVIDER` or the VS Code setting already wins.
- `writeProviderSelection(cwd, providerId)` — writes only the `provider` key
  into `.claude/tycoon/execution.json`, preserving every other key.

The VS Code host can apply a change live (disposes the running `Provider`
and constructs the other one via the existing factory against the same
`Runtime`, no reload) — see `src/host/vscode/extension.ts`'s
`trySwapProvider`. The standalone host cannot: its watcher/provider is fixed
at process startup, so a change there always requires a restart. Full wire
contract (the `harness` settings field, `SET_HARNESS` message) is in
`docs/IPC-CONTRACT.md`'s "Harness Selection (p13-t7)" section.

### First run on OpenCode

1. Choose **OpenCode** from the harness dropdown in **Settings** (next to
   an "Open Agents" link) — the Agents screen itself no longer has this
   dropdown; it shows a read-only line, "Runs on Claude Code · Change in
   Settings" (or "Runs on OpenCode · Change in Settings"). Choosing OpenCode
   switches Agents to full density; switching back to Claude Code never
   deletes an existing `routing.json`.
2. Open **Agents** and fill in the **Default for all agents** card: vendor
   and model. If you pick **Custom endpoint**, also enter a provider name
   plus the endpoint URL and API key — those are entered once and stored
   per user under the app-data secrets folder, never written into the
   project.
3. Optionally, click **Override** on individual agent cards in the same
   Agents screen. A model-only override inherits the default's endpoint and
   key automatically, so you only need to name the model.
4. Run the ready test to confirm every agent resolves to a real route.

Mainstream vendors — Anthropic, OpenAI, Google, and OpenCode Zen — use
OpenCode's own `opencode auth login` credentials and need no endpoint or
API key fields here at all. Agents that ship a hand-written `backend:`
block in their frontmatter (the MCP reviewers, e.g. `codex-reviewer`,
`gemini-reviewer`, `kimi-reviewer`) keep that backend regardless of the
default — they were already wired to a specific vendor/transport on
purpose and are not swept into `defaults` resolution.

The Settings screen's harness dropdown (the only place it appears) surfaces a hint — "OpenCode runs
each agent on its routed model. Set a default model your OpenCode install
can reach." with a link straight into Agents — whenever OpenCode is
selected, no `defaults` model is set, and at least one agent is still
running off its own frontmatter alone. Saving a default from the Agents
screen makes the hint disappear on the next Settings refresh.

---

## Prerequisite: the agent roster

Routing and backend resolution below reads `.claude/agents/<id>.md`
frontmatter for every agent — including under OpenCode, where the plugin
reuses the same files (see "Backend routing" below). That roster is **not**
committed (`.claude/` is gitignored), so a fresh clone or a machine that has
only ever run OpenCode has none yet. Create it one of two ways:

- **VS Code**: open the TycoonAgents panel and run **Install/Repair hooks**.
- **Standalone / OpenCode-only**: `node standalone/src/cli.mjs install-hook
  <dir>` (with or without `--opencode`) seeds `.claude/agents/*.md` and
  `.claude/tycoon/agent-keywords.json` when missing, without overwriting
  existing files; pass `--no-agents` to skip seeding, or run
  `node standalone/src/cli.mjs seed-agents <dir>` to seed the roster alone.

Either path seeds only the core worker roster plus a reviewer, matching a
fresh VS Code install. Foreign-LLM reviewers (`codex-reviewer`,
`gemini-reviewer`, `kimi-reviewer`) come from the multi-llm pack, installed
from the panel's Packs view (VS Code or standalone).

Both `scripts/apply-routing-profile.mjs` and the OpenCode plugin's routing
skip any agent id with no roster file rather than failing — see
`docs/ROUTING-PROFILE.md`'s "Prerequisite" section for the exact skip
messages.

## Registration: `.opencode/plugin/`

The OpenCode plugin is installed **only** by the standalone installer
(`standalone/src/installHook.mjs`'s `OPENCODE_PLUGIN_FILES`,
`installOpenCodePlugin()`) — there is no VS Code panel path for this; a VS
Code user installs the OpenCode plugin by running the same standalone
install command as any other user. (`src/host/vscode/panel.ts`'s installer
copies only the Claude Code hook and its runtime deps into
`.claude/tycoon/` — that is a separate, unrelated installation.)

`installOpenCodePlugin()` copies or symlinks the plugin (plus its runtime
dependencies) into the project's `.opencode/plugin/` directory (singular;
verified against OpenCode 1.18.27). `OPENCODE_PLUGIN_FILES` lists:

```
<project>/.opencode/plugin/tycoon-opencode-plugin.ts
<project>/.opencode/plugin/agentBackend.js
<project>/.opencode/plugin/modelAliases.js
<project>/.opencode/plugin/delegationEnforcement.js
<project>/.opencode/plugin/fallbackChain.js
```

`agentBackend.js`, `modelAliases.js`, `delegationEnforcement.js`, and
`fallbackChain.js` are the compiled `src/core/agentBackend.ts` /
`src/core/modelAliases.ts` / `src/core/delegationEnforcement.ts` /
`src/core/fallbackChain.ts` outputs, copied next to the hook/plugin by
`scripts/copy-hook-runtime.mjs` (run after `tsc -p .` in both
`vscode:prepublish` and normal dev builds) so a packaged install always has
a same-directory copy without requiring `out/src/core` on disk. The plugin
loads each via `require(path.join(__dirname, "<file>.js"))` and logs a
stderr warning (no crash) if one is missing:

- `agentBackend.js` missing → MCP backend routing and per-agent
  model/vendor resolution are disabled, activity capture continues.
- `delegationEnforcement.js` missing → direct-tool-call nudges, keyword
  routing fallback, and the leaf-spawn guard are disabled (every decision
  falls back to "allow"), activity capture continues.
- `fallbackChain.js` missing (same lazy-require pattern, see Fallback
  chains below) → provider-failure fallback dispatch is disabled.

`installOpenCodePlugin()` (`standalone/src/installHook.mjs`) refuses to
overwrite a destination file that already exists with different content
unless `--force` is passed — it never silently clobbers a hand-edited copy.

OpenCode auto-installs `@opencode-ai/plugin`'s types for editor support, but
the plugin file itself must not import that package (or any other) at
runtime.

---

## Backend routing (`agentBackend.js` reuse)

The plugin resolves `vendor`/`model`/`costModelClass` for a `task` spawn from
the target agent's own `.claude/agents/<subagent_type>.md` frontmatter
(`readAgentBackendFromFile`), and for `mcp__<server>__<tool>` calls by
scanning every `.claude/agents/*.md` whose `backend.transport` is `mcp` or
`openai-compatible` (`buildMcpBackendRouting`/`lookupMcpBackend`) — the exact
same declarative `backend:` schema and parser
(`src/core/agentBackend.ts`, field reference in `docs/AGENT-BACKENDS.md`)
that `tycoon-claude-hook.cjs` uses, so an agent's routing behaves identically
under either provider.

### Subscription CLI bridges

Two of the roster's MCP servers front a vendor's own subscription CLI rather
than a metered API key: `claude-cli` (`hooks/claude-cli-mcp.cjs`, wraps
`claude -p`) and `openai-compatible` (`hooks/openai-compatible-mcp.cjs`) plus
the `codex` and `gemini` catalog entries
(`media/mcp/catalog.json`). **Caveat:** third-party OAuth against a Claude
subscription is against Anthropic's terms of service — the only supported
surface here is the official `claude` CLI running under the user's own
login; TycoonAgents itself never stores or handles credentials.

**Claude subscription under OpenCode is opt-in (2026-10-06).** Anthropic's
consumer terms target third-party harnesses using subscriptions (OpenCode was
named in 2026 enforcement); the official CLI route is currently allowed but
may tighten. So under OpenCode (Experimental) the Claude default is an API
key, and the `claude-cli` route needs the per-user Settings checkbox "Allow
Claude subscription via the claude CLI under OpenCode" (default off; flag file
`opencode-claude-subscription-optin` in the per-user app-data dir,
`src/core/claudeSubscriptionBridge.ts`). With it off, the slot editor disables
the `mcp` transport and `subscription` cost class for anthropic slots.
**Existing configs** (a `claude-worker` backend, or a saved slot already using
the route) count as an explicit choice: they keep working and display the
note "Uses your own Claude Code CLI login. Anthropic's terms for third-party
harnesses have changed several times; check them before relying on this."
Claude Code and Codex hosts are unaffected. See
`docs/AGENT-BACKENDS.md` for the pricing-key (`costModelClass`) and
`endpointEnv`/`apiKeyEnv` reference.

---

## Enforcement

`hooks/tycoon-opencode-plugin.ts` enforces the same four delegation rules as
`hooks/tycoon-claude-hook.cjs`, backed by the shared, pure decision functions
in `src/core/delegationEnforcement.ts` (`decideDirectToolCall`,
`matchAgentFromKeywords`, `decideSpawn`, `startReviewGate`/
`advanceReviewGate`/`isReviewGateTerminal`). What actually delivers each rule
to a live OpenCode session was probed against OpenCode 1.18.27
(`docs/opencode-probe-findings.md`, "Enforcement mechanisms"):

| Rule | Mechanism in OpenCode 1.18.27 | Parity vs. the Claude hook |
|---|---|---|
| 1. Direct-tool nudge (orchestrator calling Grep/Glob/Edit/Write, or >2 direct Reads/turn) | `experimental.chat.system.transform` — confirmed **GO**: `output.system` pushed here is echoed by the model on its next turn. The plugin queues the message via `queueNudge`/`pendingNudgesBySession` in `handleToolExecuteBefore` and drains it in `chatSystemTransform` | **full** — byte-identical message text, delivered to the model, not just logged |
| 2. Keyword-based agent routing (no/unresolvable `subagent_type` on a `task` call) | Plain in-process function call, no OpenCode-specific mechanism needed — `matchAgentFromKeywords` reads `.claude/tycoon/agent-keywords.json` the same way on both hosts | **full** |
| 3. Single-pass review gate (one `uefn-auditor` review, one fix round, then stop) | **Best-effort**: OpenCode's `task` output is a rendered `<task>` string with no typed verdict field, so `handleToolExecuteAfter` regex-matches it for a rejection marker and drives the same state machine as the doctrine. Logged-only parity vs. the Claude hook, which has no code path for this rule at all (doctrine lives only in `CLAUDE.md` prose) — see `docs/ENFORCEMENT-PARITY-BENCHMARK.md` Rule 4/4b | **logged-only** |
| 4. Leaf workers never spawn | Throwing `BlockingToolCallError` inside `tool.execute.before` — confirmed **GO**: it aborts the `task` call and the thrown message is surfaced to the model as the tool's error output (`hooks/tycoon-opencode-plugin.ts`'s `handleToolExecuteBefore`, rethrown uncaught by the top-level `tool.execute.before` entrypoint) | **full** — both hosts now structurally block the spawn, not just log it |

`permission.ask` was probed and **does not fire** in a real non-interactive
`opencode run` (only the informational `event:"permission.asked"` bus event
does) — it is intentionally not wired into any rule above.

`args.model` rewrite on a fallback re-dispatch (see Fallback chains below)
is **best-effort only**: the probe never confirmed OpenCode observes a hook
mutating `input.args` before executing the tool, so the plugin sets it
anyway (`handleToolExecuteBefore`) but relies on the queued nudge text, not
the mutation, to actually get the orchestrator to re-dispatch on the right
model.

To reproduce or extend the parity results: `docs/ENFORCEMENT-PARITY-BENCHMARK.md`
("How to run it") — `npm run test` runs `test/delegationEnforcement.test.ts`
and `test/enforcementParity.test.ts` alongside the full suite, or run them
directly with `node --test out/test/delegationEnforcement.test.js
out/test/enforcementParity.test.js`.

---

## Fallback chains

When a spawned worker's `task` output matches a provider-failure pattern
(`isProviderFailure` in the shared `fallbackChain` module, loaded lazily from
`fallbackChain.js` next to the plugin), `handleToolExecuteAfter` records the
failure, resolves the next model in that agent's configured fallback chain,
and queues a re-dispatch instruction into the orchestrator's next turn via
the same `chatSystemTransform` nudge path used for Rule 1. The chain itself —
schema, precedence, and how `.claude/tycoon/routing.json` /
`.opencode/tycoon-routing.generated.json` populate it — is documented in
`docs/ROUTING-PROFILE.md`; this section only covers what the OpenCode
provider does with it at runtime.

A `FallbackTriggered` activity line looks like:

```json
{"event":"FallbackTriggered","provider":"opencode","at":1788550700000,"workerId":"coding-specialist","slotId":"coding-specialist","sessionId":"ses_...","failedModel":"anthropic/claude-sonnet-4-6","nextModel":"openai/gpt-5.4-mini","reason":"...provider failure text (truncated to 300 chars)...","message":"...fallback re-dispatch instruction..."}
```

The matching `PreToolUse`/`SubagentStop` pair for the re-dispatched attempt
carries `fallbackOf` (the original agent/slot id) and `fallbackDepth` (1-based
position in the chain) so the delegation panel can show it as a fallback
retry rather than a fresh, unrelated spawn. What the orchestrator itself
sees is only the queued nudge text delivered via
`experimental.chat.system.transform` on its next turn — there is no typed
"fallback happened" signal surfaced to the model beyond that instruction
string.

---

## Roster translator: `scripts/generate-opencode-config.mjs`

Reads `.claude/agents/*.md` and emits one `.opencode/agents/<name>.md` per
source file, so the same agent roster runs under OpenCode
(`npm run opencode:config`, i.e. `node scripts/generate-opencode-config.mjs
[--root <dir>] [--check]`). Never deletes files — a hand-written
`.opencode/agents/*.md` with no `.claude/agents` source is left untouched.
`.opencode/agents/`, `.opencode/tycoon-routing.generated.json`, and
`.opencode/plugin/` are gitignored, per-machine generated output — a fresh
clone has none of them; run this script (or `install-hook --opencode`) to
produce them locally.

- **Mode rule** — `mode: 'primary'` when the source frontmatter has
  `role: orchestrator` or `tier: orchestrator`; `'subagent'` otherwise.
- **Model rule**, in priority order: (1) an override for this agent's name
  in `<root>/.claude/tycoon/opencode-models.json` (`{ agentName:
  "provider/model" }`); (2) `backend.model` from the agent's `backend:`
  frontmatter block when it already contains a `/`; (3) a bare top-level
  `model:` alias resolved via `resolveModelAlias` to `anthropic/<id>`;
  (4) otherwise `model:` is omitted entirely. OpenCode rejects a `model:`
  whose provider isn't configured in that install — remap via
  `opencode-models.json` when an agent's declared vendor isn't set up.
- **Description rule** — always emitted: frontmatter `description` verbatim,
  else derived from the first non-empty, non-heading paragraph after a
  `## Role` heading (or the body's first such paragraph), collapsed and
  truncated to 200 chars at a word boundary; falls back to the agent name.
- `--check` writes nothing and exits 1 listing paths that would change (0 if
  already up to date) — used in CI to catch a stale generated roster.
- **`opencode.json` provider merge** — for every distinct
  `transport: "openai-compatible"` vendor in the resolved routing profile
  (agent slots, orchestrator, and fallback-chain entries), the script merges
  a `provider.<vendor>` entry into `opencode.json` (`npm:
  "@ai-sdk/openai-compatible"`, `options.baseURL`/`options.apiKey` as
  `{env:VAR}` placeholders per OpenCode's documented config substitution,
  `models` keyed by every model routed to that vendor), marked
  `tycoonManaged: true` so re-runs only ever touch entries it owns and never
  a hand-authored provider with the same id. See
  `docs/ROUTING-PROFILE.md`'s "Custom OpenAI-compatible endpoints" section
  for a worked example.

### AGENTS.md managed block

Content outside `<!-- TYCOON-MANAGED:START -->` / `<!-- TYCOON-MANAGED:END
-->` in `AGENTS.md` is preserved byte-for-byte; the script only rewrites
inside the markers, applying a small replacement table (`"Task tool"` →
"task tool (`@agent-name`)", `"subagent_type"` → "agent name"; `"Claude
Code"` is left as-is). If `AGENTS.md` doesn't exist it's created with a `#
AGENTS.md` header plus the managed block; if no `CLAUDE.md` source exists,
the managed block is emitted empty. This matters because OpenCode reads
`AGENTS.md` (not `CLAUDE.md`) as its project rules file. Output is
deterministic — no timestamps, no non-deterministic ordering.

---

## M2 smoke test (probe findings)

`docs/opencode-probe-findings.md`'s "M2 smoke (2026-09-03)" section records
a live run: OpenCode 1.18.27 terminal TUI, Zen provider model `big-pickle`,
plugin staged at `.opencode/plugin/tycoon-opencode-plugin.ts` alongside
`agentBackend.js`/`modelAliases.js`, standalone watching with `--provider
opencode`, VS Code extension watching concurrently. A `@probe-sub hello`
spawn produced a correctly ordered `UserPromptSubmit` →
`PreToolUse(Task)` → `PreToolUse(Read)` → `SubagentStop` sequence with
`tokens: 12679` + `cacheReadTokens: 11584`, matching the panel's displayed
24.3k. Verdict: **PASS**. Coverage limit: terminal TUI only — the OpenCode
desktop app and OpenCode VS Code extension were not exercised.

**Token-accounting caveat:** the OpenCode TUI's own displayed number (15,414
in the smoke run) is the *parent* session's current context size, not
cumulative usage, and excludes the child session the subagent ran in.
TycoonAgents instead shows the subagent's cumulative usage as reported at
`SubagentStop` (fresh + cache-read tokens) — the same accounting used for
Claude Code — so the two numbers are not expected to match; this is not a
bug.

---

## Known limits

- **Front-end coverage:** only the terminal TUI is confirmed. The OpenCode
  desktop app and the OpenCode VS Code extension are UNRESOLVED — neither
  has been run against the plugin.
- **AGENTS.md vs CLAUDE.md:** OpenCode reads `AGENTS.md` as its rules file,
  not `CLAUDE.md`, so the managed block described above is the only path by
  which this project's delegation rules reach an OpenCode session.
- **Unconfigured model providers:** OpenCode rejects a `model:` id whose
  provider isn't configured in that install at runtime — remap the affected
  agent via `.claude/tycoon/opencode-models.json`.
- **Subagent task tool:** as of plan p15-t0 this is a deliberate, structural
  block, not just an OpenCode default — a subagent's `task` call is detected
  and aborted by the plugin itself (`BlockingToolCallError`, see Enforcement
  Rule 4 above), independent of whatever permission OpenCode would otherwise
  apply. Depth (orchestrator vs. leaf) is derived ONLY from OpenCode's own
  session tree — `session.created`'s `parentID`/`agent` fields on the
  CALLING session, tracked in-memory as they arrive — never from the shared
  `active-agent.json` stack, which both this plugin and
  `hooks/tycoon-claude-hook.cjs` write to and which can carry another
  provider's worker; a fix landed after a live run showed a Claude Code
  worker on that shared stack causing an OpenCode root session's own `task`
  call to be misread as nested and denied.
- **Anthropic subscription auth unavailable in OpenCode:** per the probe
  findings, OpenCode supports API key, Bedrock, Vertex, Zen, or Copilot auth
  only — a Claude agent run natively through OpenCode is `costModelClass:
  "metered"`, not the subscription class TycoonAgents assumes for Claude
  Code. **Default (decision 2026-10-06):** under OpenCode, Claude slots use
  the Anthropic API key route (env name `ANTHROPIC_API_KEY`, set via the
  local env store; names only) and the metered cost class. The `claude -p`
  bridge (`claude-cli`) is an explicit per-user opt-in, below.
- **Worker identity:** as with the Claude Code provider, correlation relies
  on `sessionId`/`workerId` fields the plugin observes directly — there is
  no additional identity scheme beyond what OpenCode's own event payloads
  provide.

---

## Tests

`test/opencodePlugin.test.ts` drives the plugin's exported
`createPlugin(deps)` factory directly against literal payloads captured in
`docs/opencode-probe-findings.md`, without going through OpenCode's actual
plugin registration shape.

---

## Version notes

The enforcement mechanisms documented above (`experimental.chat.system.transform`
GO, thrown-error abort GO, `permission.ask` NO-GO) were observed live against
**OpenCode 1.18.27** only (`docs/opencode-probe-findings.md`, "Enforcement
mechanisms"). These are behavioral facts about a specific OpenCode build, not
a documented public contract — **re-probe on every OpenCode upgrade** before
trusting this doc's Enforcement section against a newer version. The
throwaway probe plugin used for the original probe,
`standalone/spike/opencode-enforcement-probe-plugin.ts`, is the starting
point for re-probing: copy it to `.opencode/plugin/`, drive it with
`opencode run`, and diff its findings against this doc.
