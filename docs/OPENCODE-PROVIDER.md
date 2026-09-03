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
entrypoint (`ctx => Hooks`) implementing three hooks:

- `event` — the one hook OpenCode delivers `session.*`/`message.*` bus
  events through.
- `tool.execute.before` / `tool.execute.after` — separate top-level hooks
  for tool calls, including `task` (subagent spawns).

### Event mapping (from the plugin's `dispatchEvent`/`toolExecuteBefore`/`toolExecuteAfter`)

| OpenCode signal | HookRecord event | Source |
|---|---|---|
| `event:message.updated`, first root-session (`no parentID`) `role:"user"` message | `UserPromptSubmit` | `handleMessageUpdated`; deduped against a `session.created` for the same session within 1s (`handleSessionCreated`, `makeSubmitDedupe`) |
| `tool.execute.before`, `tool === "task"` | `PreToolUse` with `tool:"Task"`, `workerId` from `args.subagent_type`, `agentDescription` from `args.description`; pushes the active-agent stack | `handleToolExecuteBefore` |
| `tool.execute.before`, any other tool | `PreToolUse <mappedTool>`, attributed to the top of the active-agent stack (`"orchestrator"` if empty); MCP tools resolve `vendor`/`model`/`costModelClass` via `buildMcpBackendRouting`/`lookupMcpBackend` | `handleToolExecuteBefore` |
| `tool.execute.after`, `tool === "task"` | `SubagentStop` with `workerId`, `model` (`providerID/modelID`), `tokens`/`cacheReadTokens` from `client.session.messages`; pops the active-agent stack | `handleToolExecuteAfter`, `fetchSessionTokens` |
| `event:session.idle`, session has no `parentID` | `Stop` | `handleSessionIdle` |
| any handler throwing | `PluginError` (dropped by the mapper, logged once) | `writePluginError` |

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

---

## Registration: `.opencode/plugin/`

Install the plugin by copying or symlinking it (plus its two runtime
dependencies) into the project's `.opencode/plugin/` directory (singular;
verified against OpenCode 1.18.27):

```
<project>/.opencode/plugin/tycoon-opencode-plugin.ts
<project>/.opencode/plugin/agentBackend.js
<project>/.opencode/plugin/modelAliases.js
```

`agentBackend.js` and `modelAliases.js` are the compiled
`src/core/agentBackend.ts` / `src/core/modelAliases.ts` outputs, copied next
to the hook/plugin by `scripts/copy-hook-runtime.mjs` (run after `tsc -p .`
in both `vscode:prepublish` and normal dev builds) so a packaged install
always has a same-directory copy without requiring `out/src/core` on disk.
The plugin loads `agentBackend.js` via
`require(path.join(__dirname, "agentBackend.js"))` and logs a stderr warning
(no crash) if it's missing — MCP backend routing and per-agent
model/vendor resolution are then disabled but activity capture continues.

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
login; TycoonAgents itself never stores or handles credentials. See
`docs/AGENT-BACKENDS.md` for the pricing-key (`costModelClass`) and
`endpointEnv`/`apiKeyEnv` reference.

---

## Roster translator: `scripts/generate-opencode-config.mjs`

Reads `.claude/agents/*.md` and emits one `.opencode/agents/<name>.md` per
source file, so the same agent roster runs under OpenCode
(`npm run opencode:config`, i.e. `node scripts/generate-opencode-config.mjs
[--root <dir>] [--check]`). Never deletes files — a hand-written
`.opencode/agents/*.md` with no `.claude/agents` source is left untouched.

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
- **Subagent task tool:** OpenCode denies the `task` tool inside subagent
  sessions by default, so a subagent spawned under OpenCode cannot itself
  spawn further subagents unless that permission is explicitly granted.
- **Anthropic subscription auth unavailable in OpenCode:** per the probe
  findings, OpenCode supports API key, Bedrock, Vertex, Zen, or Copilot auth
  only — a Claude agent run natively through OpenCode is `costModelClass:
  "metered"`, not the subscription class TycoonAgents assumes for Claude
  Code. The subscription CLI bridges above (`claude-cli`) are the supported
  way to reach a Claude subscription from OpenCode.
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
