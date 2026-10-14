# Routing Profile

`.claude/tycoon/routing.json` lets a project declare, per agent, which
vendor/model/transport serves it — one file that the Claude Code
frontmatter generator reads as its highest-priority source. It is entirely optional: a project with no
`routing.json` behaves exactly as it does today.

See `src/core/routingProfile.ts` for the loader/validator implementation.

## Prerequisite: the agent roster

Everything below assumes `.claude/agents/<id>.md` files already exist for
the agents named in `routing.json`. That roster is **not** committed to the
repo (`.claude/` is gitignored) — a fresh clone has none. There are two ways
to create it:

- **VS Code**: open the TycoonAgents panel and run **Install/Repair hooks**;
  it seeds the roster along with the Claude Code hook.
- **Standalone** (no VS Code): from the repo root,
  `node standalone/src/cli.mjs install-hook <dir>` seeds
  `.claude/agents/*.md` and `.claude/tycoon/agent-keywords.json` when
  missing (never overwriting a file that already exists). Pass `--no-agents` to skip roster seeding, or
  run `node standalone/src/cli.mjs seed-agents <dir>` to seed the roster
  only, without touching the hook.

Either path seeds only the core worker roster (`search-retrieval`,
`primary-agent`, `coding-specialist`, `ux-ui-designer`) plus a reviewer,
matching a fresh VS Code install. Foreign-LLM reviewers such as
`codex-reviewer`, `gemini-reviewer`, and `kimi-reviewer` are added
separately from the Agents screen with **Add an agent from another provider**
(works in both VS Code and the standalone panel).

`scripts/apply-routing-profile.mjs` (below) never creates agent files: an
agent id in `routing.json` with no matching `.claude/agents/<id>.md` is
silently skipped with a warning — `agent "<id>" is in routing.json but no
.claude/agents/<id>.md file exists; skipped` — and a declared orchestrator
slot with no `.md` file carrying `role: orchestrator` or
`tier: orchestrator` is skipped the same way: `routing.json declares an
orchestrator slot but no .claude/agents/*.md file has role/tier:
orchestrator; skipped`. Seed the roster first if you see either message.

## File location

`<project>/.claude/tycoon/routing.json`, one per project.

## Top-level shape

```ts
interface RoutingProfile {
  version: 1;
  orchestrator?: RoutingSlot;
  agents: Record<string, RoutingSlot>;
  defaults?: Partial<RoutingSlot>;
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `version` | `1` | required | Only `1` is currently valid. |
| `orchestrator` | `RoutingSlot` | none | Slot for the top-level orchestrator. Merged over `defaults`. |
| `agents` | `Record<string, RoutingSlot>` | `{}` (required key) | Keyed by agent id (matches `.claude/agents/<id>.md`'s filename stem). |
| `defaults` | `Partial<RoutingSlot>` | none | Fields applied to every agent/orchestrator slot before that slot's own fields override them. |

## RoutingSlot fields

```ts
interface RoutingSlot {
  vendor?: string;
  transport?: "claude-native" | "mcp" | "openai-compatible";
  mcpServer?: string;
  tools?: string[];
  model?: string;
  costModelClass?: "metered" | "subscription" | "local";
  endpointEnv?: string;
  credentialEnv?: string;
  fallback?: RoutingSlot[];
}
```

| Field | Type | Default | Example |
| --- | --- | --- | --- |
| `vendor` | `string` | `"anthropic"` (when the slot is converted to a `Backend`) | `"opencode"`, `"anthropic"`, `"moonshot"` |
| `transport` | `"claude-native" \| "mcp" \| "openai-compatible"` | `"claude-native"` | `"mcp"` |
| `mcpServer` | `string` | none | `"codex"` (required when `transport: "mcp"`) |
| `tools` | `string[]` | none | `["mcp__codex__exec"]` |
| `model` | `string` | none | `"anthropic/claude-sonnet-4-6"` or a bare alias like `"sonnet"` |
| `costModelClass` | `"metered" \| "subscription" \| "local"` | `"metered"` | `"subscription"` |
| `endpointEnv` | `string` (env var **name**, never a value) | none | `"KIMI_ENDPOINT_URL"` |
| `credentialEnv` | `string` (env var **name**, never a value) | none | `"KIMI_API_KEY"` |
| `fallback` | `RoutingSlot[]` | none | Ordered chain tried in order if the primary slot fails. Max depth 3. |

### `credentialEnv` replaces `apiKeyEnv`

`src/core/agentBackend.ts`'s `Backend` type uses `apiKeyEnv`. Routing profile
slots use `credentialEnv` instead — same meaning (the *name* of an
environment variable holding a credential, never the value itself), renamed
for clarity now that routing.json also carries `endpointEnv` for the same
slot. `routingSlotToBackend()` maps `credentialEnv → apiKeyEnv` when adapting
a resolved slot into the existing `Backend` shape, so generators built
against `Backend`/`parseAgentBackend()` need no changes.

## The no-secrets rule

No field whose name matches `/key|secret|token|password/i` is permitted
anywhere in routing.json **except** `credentialEnv` and `endpointEnv` — and
those two may only ever hold an environment variable *name*, never a value.
The loader rejects any other matching field with:

> `secrets must not be stored in routing.json; use env var names`

The check matches property names, so a non-secret field containing key, secret, token, or password (for example `tokenBudget`) is also rejected; rename such fields rather than expecting an exemption.

This mirrors the PRD's Non-Functional Requirement that no secret or
credential value is ever stored in project files — only variable names and
booleans.

## Resolution

- `resolveAgentSlot(profile, agentId)` — merges `defaults` then
  `agents[agentId]` (agent-specific fields win). Returns `null` when the
  agent has no entry in `agents` and `defaults.model` is unset — meaning the
  profile has nothing to say about that agent.

### `defaults` precedence and same-vendor inheritance

`defaults` is the lowest-precedence slot: it is merged first, and any field
the agent's own `agents[id]` entry sets overrides the matching `defaults`
field outright — this is a plain shallow field merge, not a deep one, so an
agent entry that sets only `model` still inherits every other unset field
(`vendor`, `transport`, `endpointEnv`, `credentialEnv`, ...) from `defaults`
untouched. That is what makes a "model-only override" work: point one agent
at a different model on the **same** custom endpoint/vendor as the default
by writing an `agents[id]` entry containing nothing but `model`, and its
`endpointEnv`/`credentialEnv` come from `defaults` automatically. Overriding
`vendor` (or `transport`) on the agent entry breaks that inheritance for the
fields it changes, since those usually imply a different endpoint/credential
than the default's.

```json
{
  "version": 1,
  "defaults": {
    "vendor": "opencode",
    "transport": "openai-compatible",
    "model": "custom/team-default-70b",
    "endpointEnv": "TEAM_ENDPOINT_URL",
    "credentialEnv": "TEAM_API_KEY"
  },
  "agents": {
    "coding-specialist": { "model": "custom/team-default-70b-fast" }
  }
}
```

Here `coding-specialist` resolves to `vendor: "opencode"`, `transport:
"openai-compatible"`, `endpointEnv: "TEAM_ENDPOINT_URL"`, and `credentialEnv:
"TEAM_API_KEY"` all inherited from `defaults`, with only `model` swapped for
its own entry. Any agent with no entry in `agents` at all resolves to
`defaults` verbatim (`resolveAgentSlot` returns the merge of `defaults` and
an empty `{}`, provided `defaults.model` is set — see below).
- `resolveOrchestratorSlot(profile)` — merges `defaults` then `orchestrator`.
  Returns `null` when neither is present.
- `routingSlotToBackend(slot)` — adapts a resolved slot to the existing
  `Backend` shape (`src/core/agentBackend.ts`), filling `vendor`,
  `transport`, `model`, and `costModelClass` with the same defaults
  `parseAgentBackend()` uses for an agent with no `backend:` block, so a
  partial slot degrades gracefully.

## Precedence rule (decided)

**`routing.json` always wins.** For any agent it covers, the profile
overrides both:

1. that agent's `.claude/agents/<id>.md` frontmatter `backend:` block, and
2. any entry for that agent in `.claude/tycoon/opencode-models.json`.

An agent's hand-edited frontmatter `backend:` block remains authoritative
**only** for agents absent from the profile (no `routing.json` at all, or an
`agents` map that doesn't mention that agent id). This matches the existing
precedent set by the OpenCode-config generator, where a generated artifact is
never hand-preserved once a higher-priority source exists.

`.claude/tycoon/opencode-models.json` is **deprecated**: with a `routing.json`
present, it is consulted only as a manual escape hatch for agents the profile
doesn't cover (see Migration below). With no `routing.json` present at all,
existing `opencode-models.json` behavior is unchanged — this file is purely
additive.

## Loader contract

`loadRoutingProfile(projectRoot: string): { profile: RoutingProfile | null; path: string; errors: string[] }`

- File absent → `{ profile: null, path, errors: [] }`. Never throws.
- File present and valid → `{ profile, path, errors: [] }`.
- File present and invalid (bad JSON, wrong `version`, malformed `agents`,
  a bad enum value, a disallowed secret-like field name, a `fallback` chain
  deeper than 3) → `{ profile: null, path, errors }`, one message per
  problem, each naming the offending JSON path (e.g.
  `agents.kimi-reviewer.transport: invalid value "ssh" — allowed: claude-native, mcp, openai-compatible`).

## Full example

`kimi-reviewer` below is a foreign-LLM reviewer (see "Prerequisite: the agent
roster" above) — add it from the Agents screen ("Add an agent from another
provider") before this profile can resolve it; the seeded core roster alone
does not include it.

```jsonc
{
  "version": 1,
  "orchestrator": {
    "vendor": "opencode",
    "transport": "openai-compatible",
    "model": "opencode/big-pickle",
    "costModelClass": "local",
    "endpointEnv": "OPENCODE_ENDPOINT_URL"
  },
  "agents": {
    "coding-specialist": {
      "vendor": "anthropic",
      "transport": "claude-native",
      "model": "anthropic/claude-sonnet-4-6",
      "costModelClass": "subscription"
    },
    "kimi-reviewer": {
      "vendor": "moonshot",
      "transport": "openai-compatible",
      "model": "moonshot/kimi-k2",
      "costModelClass": "local",
      "endpointEnv": "KIMI_ENDPOINT_URL",
      "credentialEnv": "KIMI_API_KEY",
      "fallback": [
        {
          "vendor": "openai",
          "transport": "mcp",
          "mcpServer": "codex",
          "tools": ["mcp__codex__exec"],
          "model": "openai/gpt-5.4-mini",
          "costModelClass": "subscription"
        }
      ]
    }
  },
  "defaults": {
    "costModelClass": "metered"
  }
}
```

In this example: the orchestrator runs on a locally-hosted `big-pickle`
model through OpenCode; `coding-specialist` is pinned to the Claude
subscription via the native transport; `kimi-reviewer` runs against a local
OpenAI-compatible endpoint and falls back to Codex (via MCP) if that
endpoint is unavailable. Any agent not listed here (e.g. `search-retrieval`)
falls back to its own frontmatter `backend:` block, since the profile says
nothing about it.

## (Coming Soon) Migration from `opencode-models.json`

> The OpenCode sections of this document (marked "Coming Soon") describe the internal integration; OpenCode is not yet available to users.

`.claude/tycoon/opencode-models.json` lets a project override an
agent's OpenCode model without touching frontmatter. Once a project adopts
`routing.json`:

1. For each agent entry in `opencode-models.json`, add an equivalent
   `RoutingSlot` under `agents.<id>` in `routing.json` (at minimum, carry the
   `model` string over).
2. Once every agent covered by `opencode-models.json` has a corresponding
   `routing.json` entry, `opencode-models.json` can be deleted — routing.json
   supersedes it for those agents.
3. The generator (`scripts/generate-opencode-config.mjs`, p12-t3) checks
   `routing.json` first; `opencode-models.json` is consulted only for agents
   the profile doesn't mention, so a partial migration is safe — nothing
   breaks for agents not yet migrated.

No code change is required to add a newly-released model: set `model` to
any `"provider/model"` string in the relevant slot.

For OpenCode-side generation (`.opencode/tycoon-routing.generated.json`,
`AGENTS.md`), see `docs/OPENCODE-PROVIDER.md` — this document covers the
routing profile schema and the Claude-side application only.

## Applying the profile to Claude Code agents

`scripts/apply-routing-profile.mjs` is the Claude-side counterpart to
`scripts/generate-opencode-config.mjs`: it writes the resolved `backend:`
frontmatter block (and top-level `model:`) into each `.claude/agents/<id>.md`
so the Claude hook and panel — which read frontmatter through
`parseAgentBackend()` (`src/core/agentBackend.ts`) — see the same routing
decisions the OpenCode generator applies.

```
node scripts/apply-routing-profile.mjs [--root <dir>] [--check]
```

For every agent id in `profile.agents` with a matching
`.claude/agents/<id>.md`, the script resolves the slot
(`resolveAgentSlot`/`routingSlotToBackend`) and replaces or inserts that
file's `backend:` block, stamping a `# managed-by: tycoon-routing` marker
line as the block's first line so a later run can find it again. Every other
frontmatter key and the entire body are preserved byte-for-byte. The
top-level `model:` key is also set to the slot's model string (bare alias or
`provider/model`) when the slot names one; an existing `model:` value is
otherwise left untouched.

The orchestrator slot (`resolveOrchestratorSlot`) is applied to whichever
agent file's frontmatter declares `role: orchestrator` or
`tier: orchestrator`, if one exists.

An agent listed in the profile with no corresponding `.md` file is warned
and skipped — this script never creates agent files. A `.md` file with no
YAML frontmatter block at all is reported and left untouched.

Per the precedence rule above, `fallback` chains are not written into
frontmatter (fallback execution is a later milestone, PRD p15). Instead they
are recorded, alongside every resolved primary backend, in
`<root>/.claude/tycoon/routing.resolved.json`:

```jsonc
{
  "agents": { "<id>": { "backend": { /* Backend */ }, "fallback": [ /* Backend[] */ ] } },
  "orchestrator": { "backend": { /* Backend */ } }
}
```

`--check` writes nothing: it prints every `.md` file and
`routing.resolved.json` that would change and exits `1`, or exits `0` when
the profile is already fully applied. With no `routing.json` present, the
script exits `0` and writes nothing. An invalid `routing.json` prints every
validation error and exits `2` without writing anything. The script is
deterministic and idempotent — running it twice against an unchanged profile
produces no further diffs.

## Fallback chains at runtime

A `RoutingSlot.fallback` array (validated to depth `MAX_FALLBACK_DEPTH = 3`
in `src/core/routingProfile.ts`) is not executed by any hook — no hook can
re-run an agent on either host. Instead each host detects a provider
failure, records it, and injects an instruction telling the **orchestrator**
to re-dispatch the same task itself. The shared, host-agnostic pieces live
in `src/core/fallbackChain.ts`:

- `isProviderFailure(text)` — matches `PROVIDER_FAILURE_PATTERNS` (usage
  limit, spend cap, out of credits, 401/403/Unauthorized, quota, rate limit,
  `RESOURCE_EXHAUSTED`, `OPENAI_COMPAT_BASE_URL`, `ECONNREFUSED`, `failed:`,
  `provider-unavailable`, and — added after a live dead-URL smoke test,
  `docs/opencode-probe-findings.md` "Remote VM smoke, attempt 5" —
  `cannot connect to api`, `unable to connect`, `APIError`) against a tool
  result body.
- `resolveNextFallback({ slotId, chain, attemptsSoFar })` — pure lookup of
  the next `RoutingSlot` in the chain, or `{ exhausted: true }` past the end.
- `FallbackState` — per-session, per-slotId attempt counter (`recordFailure`,
  `getNext`, `getRecord`, `endSession`, `clear`), capped at
  `MAX_TRACKED_SESSIONS = 200` sessions with oldest-first eviction.
- `buildFallbackInstruction({ workerId, failedProvider, failedModel, reason, result, chainLength })`
  — the exact text queued to the orchestrator: which agent failed, on what
  model, and either "re-dispatch on `<nextModel>` (fallback N of M)" or
  "all fallback options exhausted — report the failure" once `result.exhausted`.

**Detection → record → instruction → re-dispatch, per host:**

- **Claude Code** (`hooks/tycoon-claude-hook.cjs`, `PostToolUse` branch,
  registered as the `mcp__.*` PostToolUse slot in
  `src/host/vscode/hookInstall.ts`'s `TYCOON_HOOK_SLOTS`): on a `PostToolUse`
  for any `mcp__<server>__<tool>` call whose response text matches
  `isProviderFailure`, the hook reads that agent's fallback chain from
  `.claude/tycoon/routing.resolved.json` (`agents[slotId].fallback`),
  persists the incremented attempt count to
  `.claude/tycoon/fallback-state.json` (keyed by session id, then slot id),
  calls `resolveNextFallback`/`buildFallbackInstruction`, appends a
  `FallbackTriggered` record to the activity log, and returns the
  instruction as `hookSpecificOutput.additionalContext` so it lands in the
  orchestrator's next turn. `fallback-state.json` is evicted on session end
  the same way the rest of that hook's per-session state is (see the hook's
  `Stop` handling).
- **OpenCode** (`hooks/tycoon-opencode-plugin.ts`): detection has TWO
  distinct entry points, because `tool.execute.after` for the `task` tool
  **never fires at all** when a subagent hits a real provider/connection
  failure (confirmed live — `docs/opencode-probe-findings.md` "Remote VM
  smoke, attempt 5"; only one `tool.execute.before` and zero
  `tool.execute.after` lines were recorded for a whole run against a dead
  `OLLAMA_BASE_URL`). Both entry points call the same extracted
  `maybeTriggerFallback()`:
  1. `handleToolExecuteAfter` — for a task that returns error TEXT inside a
     *successful* rendered `<task>` output (the original, pre-attempt-5
     path).
  2. `handleTaskToolErrorPart`, wired into the plugin's bus `event` hook for
     `message.part.updated` — the path that actually fires for a real
     connection failure. It reads a tool part with
     `part.type === "tool" && part.tool === "task" && part.state.status ===
     "error"`, taking the error text from `state.error` and
     `workerId`/model/session ids from `state.input.subagent_type` and
     `state.metadata` (`parentSessionId`, `sessionId`, `model`). This is
     also where the `SubagentStop` record gets written for a failed
     dispatch, since `tool.execute.after` never runs to write it otherwise.

  Either path: `FallbackState.getNext(sessionId, workerId)` on the next
  `Task` re-dispatch returns a non-exhausted entry, the plugin best-effort
  rewrites `input.args.model` to the next chain entry's model (`args.model`
  mutation is **not confirmed** to be observed by OpenCode's own tool
  execution — see `docs/opencode-probe-findings.md`), stamps
  `fallbackOf`/`fallbackDepth` on the pushed active-agent stack entry, and
  separately queues the human-readable instruction text via `queueNudge`,
  delivered into the model's system prompt on its **next** turn through
  `experimental.chat.system.transform` (`chatSystemTransform`) — there is no
  earlier hook this plugin can use to inject mid-turn. `FallbackTriggered`
  is appended to the activity log from whichever of the two paths above
  detected the failure.

  Live-confirmed (attempt 5, `opencode run` only — the interactive TUI was
  not tested, cheap-test criterion not met): with `OLLAMA_BASE_URL` dead,
  the orchestrator DID re-dispatch `coding-specialist` a second time on
  `opencode/big-pickle` with `fallbackOf`/`fallbackDepth:1` after the first
  failure, and correctly reported chain exhaustion after the second
  fallback also failed (this VM's `zen`/`big-pickle` path was also
  unreachable in that offline scenario, so end-to-end success was not
  observed, but the detect → FallbackTriggered → re-dispatch mechanism is
  confirmed working).

**What a user sees in the panel:** the metrics rollup
(`buildMetricsRollup`, `media/main.js:14277`) sums each agent's
`fallbackCount` into a `fallbackCount` total shown alongside the
per-vendor and per-`costModelClass` breakdowns (`byVendor`, `byCostClass`)
and the `local` rows' time-based (`activeMs`, since local agents have no
token cost). A per-agent row that most recently ran on a fallback shows
that agent's live `vendor`/`model` as the fallback entry's own (not the
originally-assigned primary's).

**Two known limitations:**

1. An OpenCode-side `RoutingSlot.fallback` chain entry carries no per-entry
   `costModelClass` in `AgentMetric` — routing.resolved.json only records
   `"provider/model"` strings for chain entries, so a fallback dispatch keeps
   the agent's own originally-declared `costModelClass` as a best-effort
   value rather than the fallback entry's actual one.
2. The OpenCode `args.model` rewrite in `hooks/tycoon-opencode-plugin.ts` is
   best-effort only — it has not been confirmed to change which model
   OpenCode actually calls; the system-prompt nudge via
   `chat.system.transform` is the mechanism actually relied on to get the
   orchestrator to re-dispatch on the intended model.

## Activity record fields

Fallback-related fields on an activity/`AgentMetric` record
(`src/core/state.ts`, `src/providers/claude-code/hookRecord.ts`,
`hooks/tycoon-opencode-plugin.ts`):

- `fallbackOf?: string` — the originally-assigned slot id (agent id) when
  the current dispatch is actually running on a fallback chain entry.
  Present only on a `PreToolUse` Task dispatch / `SubagentStop` for a
  fallback re-dispatch.
- `fallbackDepth?: number` — 1-based index into the fallback chain for this
  dispatch; present iff `fallbackOf` is.
- `fallbackCount: number` — running total of fallback re-dispatches recorded
  for that agent; always present on `AgentMetric` (default `0`) so the panel
  can sum it (`state.ts` bumps it whenever an incoming event carries
  `fallbackOf`).
- `FallbackTriggered` — the event both hosts append when a provider failure
  is detected and a re-dispatch instruction is queued (fields: `workerId`/
  `slotId`, `failedModel`, `nextModel`, `reason`, `at`, optional
  `sessionId`).
- `SpawnDenied` — `hooks/tycoon-opencode-plugin.ts`'s doctrine-driven
  leaf-worker spawn-guard block (thrown as `BlockingToolCallError` from
  `tool.execute.before`, which OpenCode surfaces verbatim to the model as
  the tool's error output — confirmed against OpenCode 1.18.27 per
  `docs/opencode-probe-findings.md`), recorded so a denied spawn shows in
  the panel instead of only aborting silently.
  `src/core/delegationEnforcement.ts` is the shared decision logic behind
  this event on both hosts.
- `ReviewGate` — recorded when the review-pass gate (a specialist's change
  routed to the reviewer agent before being reported done) fires or is
  bypassed.

## Enforcement without Claude

Delegation enforcement (the spawn-guard and review-gate decisions above) is
shared logic in `src/core/delegationEnforcement.ts`, ported into the OpenCode
plugin so a project running entirely on OpenCode-routed agents (no Claude
Code orchestrator at all) still gets the same doctrine enforced. See
`docs/OPENCODE-PROVIDER.md` for how a fully-OpenCode setup is configured, and
`docs/ENFORCEMENT-PARITY-BENCHMARK.md` for the benchmark proving the ported
OpenCode enforcement produces the same decisions as the Claude-hook original.

## Custom OpenAI-compatible endpoints (Ollama, vLLM, LM Studio)

A `transport: "openai-compatible"` slot names a vendor and a fully-qualified
`vendor/model` string (same convention as every other slot), plus
`endpointEnv` (and optionally `credentialEnv`) naming the environment
variables that hold the endpoint URL and API key — never the values
themselves (see "The no-secrets rule" above). **OpenCode only (Coming Soon):**
`scripts/generate-opencode-config.mjs` turns every distinct
openai-compatible vendor across the resolved profile (agent slots, the
orchestrator slot, and every entry in each slot's `fallback` chain) into a
provider entry in `opencode.json`, using OpenCode's own `{env:VAR_NAME}`
config substitution syntax so the literal endpoint/key never lands in a
committed file.

### Worked example: a remote Ollama on a tailnet

`routing.json`:

```jsonc
{
  "version": 1,
  "agents": {
    "coding-specialist": {
      "vendor": "ollama-windows",
      "transport": "openai-compatible",
      "model": "ollama-windows/qwen3.6:latest",
      "costModelClass": "local",
      "endpointEnv": "OLLAMA_BASE_URL"
    }
  }
}
```

Environment variables to export before running OpenCode (placeholder host —
substitute your own tailnet address; OpenCode's OpenAI-compatible provider
requires *some* string for `apiKey` even against a keyless local server, so
export a dummy value if your endpoint doesn't check it):

```sh
export OLLAMA_BASE_URL="http://<host>:11434/v1"
export OLLAMA_API_KEY="unused"   # only if you also set credentialEnv
```

**OpenCode only (Coming Soon):** generated `opencode.json` (via `npm run opencode:config`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama-windows": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ollama-windows",
      "options": {
        "baseURL": "{env:OLLAMA_BASE_URL}"
      },
      "models": {
        "qwen3.6:latest": { "name": "qwen3.6:latest" }
      },
      "tycoonManaged": true
    }
  }
}
```

**OpenCode only (Coming Soon):** only entries carrying `"tycoonManaged": true` are ever replaced or removed
by the generator; a hand-authored `provider.ollama-windows` entry without
that marker is left alone (a warning is printed instead of overwriting it).

### Per-user local values (p13-t6) split the provider entry across TWO files

An endpoint URL or API key entered in the Agents screen (full density) is stored per-user,
outside any project, via `src/core/localEnvStore.ts` (`<per-user app data
dir>/secrets/<NAME>`, mode 0600) — never in `routing.json`, never in
`opencode.json`, never in git. **OpenCode only (Coming Soon):** to keep that guarantee, `scripts/
generate-opencode-config.mjs` writes the managed provider entry into
**two** files:

- **PROJECT** `<root>/opencode.json` (git-tracked): the entry carries only
  `npm`/`name`/`models` — no `options` at all.
- **GLOBAL** `<OpenCode global config dir>/opencode.json` — always
  `~/.config/opencode/opencode.json`, Windows included, overridable via
  `OPENCODE_CONFIG_DIR`. Confirmed empirically against a live OpenCode
  1.18.27 install on Windows (2026-09-04): `opencode debug paths` reports
  `config  C:\Users\<user>\.config\opencode`, and `%APPDATA%\opencode` is
  never read, so the generator never writes to
  `%APPDATA%/opencode/opencode.json`; a
  stale entry left there is migrated (its
  `tycoonManaged` provider entries removed, everything else left intact)
  the next time the generator runs. The SAME managed entry, but with
  `options.baseURL`/`options.apiKey` set to `{file:<store path>}` when a
  value is stored, else the existing `{env:<NAME>}` placeholder.

**OpenCode only (Coming Soon):** this relies on OpenCode's documented config-merge behavior (verified
against the OpenCode 1.18.27 docs, https://opencode.ai/docs/config/,
2026-09-04): config files are "merged together, not replaced", and project
config "overrides both global and remote configs" only for keys it actually
sets. Since the project file never sets `options` for a tycoon-managed
provider, the global file's `options` survive untouched — a fresh checkout
with no global config yet still runs (the provider is simply unconfigured
until the global file exists), and nothing endpoint/key-shaped ever reaches
a commit.

### The Claude Code side is different

`hooks/openai-compatible-mcp.cjs` (the MCP bridge a Claude-side agent calls
into for an openai-compatible backend) reads a single global endpoint —
`OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_API_KEY` — not a per-vendor
variable. To route the *same* slot through the Claude path, set
`endpointEnv: "OPENAI_COMPAT_BASE_URL"` (and `credentialEnv:
"OPENAI_COMPAT_API_KEY"` if needed) instead of a vendor-specific name.
This is a real limitation, not an oversight: Claude Code can reach only one
openai-compatible endpoint at a time this way, while OpenCode's
`opencode.json` supports one provider block per vendor. A profile mixing
both hosts should pick the vendor-specific env names for OpenCode-only
slots and reserve `OPENAI_COMPAT_*` for whichever single slot needs to work
from the Claude side too. As of p13-t6, the hook checks `process.env` FIRST
and falls back to the same per-user `localEnvStore` the Agents screen
writes to, so a value entered there (and not exported as a real env var)
still reaches the Claude path.

## Files written by the routing system

| File | Written by | Read by |
| --- | --- | --- |
| `.claude/tycoon/routing.json` | Hand-authored by the project (or the `project-plan`/routing-setup flow) | `loadRoutingProfile` (`src/core/routingProfile.ts`); both `scripts/apply-routing-profile.mjs` and `scripts/generate-opencode-config.mjs` |
| `.claude/tycoon/routing.resolved.json` | `scripts/apply-routing-profile.mjs` | `hooks/tycoon-claude-hook.cjs` (PreToolUse Task-branch model swap and PostToolUse fallback-chain lookup) |
| `.opencode/tycoon-routing.generated.json` | `scripts/generate-opencode-config.mjs` | `hooks/tycoon-opencode-plugin.ts` and the OpenCode runtime itself |
| `.claude/tycoon/fallback-state.json` | `hooks/tycoon-claude-hook.cjs` (`PostToolUse`) | `hooks/tycoon-claude-hook.cjs` (same hook, next `PostToolUse`/Task dispatch); evicted on session end |
| `.opencode/agents/*.md` | `scripts/generate-opencode-config.mjs` | OpenCode runtime (agent definitions) |
| `AGENTS.md` managed block | `scripts/generate-opencode-config.mjs` (`buildAgentsMd`, enforcement doctrine block) | OpenCode runtime; human readers |
| `.claude/agents/<id>.md` managed `backend:` block | `scripts/apply-routing-profile.mjs` (stamped with `# managed-by: tycoon-routing`) | `parseAgentBackend()` (`src/core/agentBackend.ts`); Claude hook and panel |

`opencode-models.json` is not written by the routing system — see Migration
above; it is a pre-`routing.json` hand-authored escape hatch, read only.

## Clearing a profile removes managed blocks (unapply)

`scripts/apply-routing-profile.mjs` unapplies as well as applies: for any
`.claude/agents/<id>.md` whose id is no longer covered by `routing.json`
(the agent was dropped from `profile.agents`, or `routing.json` itself is
absent), the script strips that file's `backend:` block **only if** it
starts with the `# managed-by: tycoon-routing` marker — a hand-written
`backend:` block with no marker is always left alone. All other frontmatter
keys and the body are restored byte-for-byte (CRLF preserved). When
`routing.json` is absent, `routing.resolved.json` is deleted; otherwise it
is rewritten to contain only the agents still in the profile.
`clearRoutingProfile` (`src/core/routingHostOps.ts`) drives this by deleting
`routing.json` and rerunning both generator scripts, so clearing a profile
from the Agents screen fully reverts the managed frontmatter and the
OpenCode provider config, not just the routing.json file itself.

### Hand-written `backend:` blocks are backed up before being overwritten

If an agent that already has a hand-written `backend:` block (no
`# managed-by: tycoon-routing` marker — e.g. a multi-llm reviewer agent like
`gemini-reviewer.md` with its `vendor`/`mcpServer`/`tools` wiring) is also
targeted by `routing.json`, applying the profile stamps a managed block over
it as usual — but first snapshots the original block's raw lines into
`.claude/tycoon/routing.backup.json`, keyed by agent id, alongside a sha256
of the file at snapshot time. A backup entry is written once per agent id and
never overwritten by a later apply (a later apply only ever finds the
already-managed block, so there's nothing new to snapshot) — so applying
twice and then unapplying still restores the *original* hand-written block,
not an intermediate managed one. On unapply, an agent id with a backup entry
gets its original block restored in place of the managed one; an agent id
with no backup entry (it never had a hand-written block) is stripped as
before. `routing.backup.json` is included in `apply-routing-profile.mjs
--check`'s diff set alongside `routing.resolved.json`.

## One fact, two views: simple vs full density

The Agents screen's simple and full densities edit the same underlying fact —
each agent's effective model — they just present it differently
(`src/core/agentSettingsRoute.ts`).

For each agent, Settings shows the **resolved** route:

- A checked Claude tier radio (`fable`/`opus`/`sonnet`/`haiku`) when the
  agent resolves to a Claude model, whether that came from the agent's own
  frontmatter, the `defaults` slot, or an explicit `routing.json` entry
  (`describeAgentRoutes`, `AgentRouteInfo.claudeTier`).
- `Backend: <vendor> via MCP` for agents with a hand-written `backend:`
  block (`handWrittenBackend: true`) — the MCP-bridged reviewers such as
  `codex-reviewer`, `gemini-reviewer`, and `kimi-reviewer`.
- `Routed to <vendor>/<model>` for any other non-Claude vendor, with an
  "Edit in Routing" link and a "Use Claude tier…" disclosure that exposes
  the tier radios inline.

Clicking a tier radio on a routed agent (`routeSource` "explicit" or
"default", per `overrideAgentToClaudeTier`) writes an explicit
`{ vendor: "anthropic", model: <tier> }` entry for that agent into
`.claude/tycoon/routing.json` via `saveRoutingProfile`, so the click wins
outright over `defaults` or whatever non-Claude route is in
force. Clicking a tier radio on an unrouted agent (`routeSource`
"frontmatter") instead writes the agent's `.claude/agents/<id>.md`
`model:` frontmatter directly, as it always has — `routing.json` is left
untouched.

### Agents screen visibility

The harness dropdown (Claude Code default, Codex (Experimental); OpenCode is listed as "OpenCode (Coming Soon)" and cannot be selected) lives only in
**Settings**; the Agents screen (menu entry "Agents", always visible) does not
have it and instead shows a read-only line — "Runs on Claude Code ·
Change in Settings". The
Settings dropdown's value alone decides Agents' density
(`describeRoutingVisibility`: visible when `routedAgentCount > 0` under
Claude Code) — there is no
separate profile-visibility toggle.

Under the **Claude Code** harness, Agents shows classic cards: name, Claude
tier radios, keyword chips/editor, stats, and Remove, plus a checkbox "Use
another provider for this agent" on each card. The checkbox starts
unchecked for an agent whose `routeSource` is `frontmatter`, and checked
(with its editor expanded) for one that already has an explicit or
default-derived route. Checking it expands that card's routing slot editor
(vendor, custom endpoint with provider name, model, cost class,
endpoint/API key set/unset, fallback) inline, with Save/Revert in the
card's footer; Save writes a sparse entry into `.claude/tycoon/routing.json`
via `saveRoutingProfile`. Unchecking it posts `clearAgentRoute` for that
agent id, which removes it from `routing.json` (preserving `defaults` and
every other agent), reruns apply/unapply so the managed `backend:` block is
stripped, and restores the agent's prior frontmatter or hand-written block.
Agents with a hand-written `backend:` block — the MCP-bridged reviewers
(`codex-reviewer`, `gemini-reviewer`, `kimi-reviewer`) — show the checkbox
checked and locked, labeled "Backend: <vendor> via MCP (hand-written)".

The orchestrator card is read-only under Claude Code in every case: "Session
model: <model> — set with /model in Claude Code. Routing the orchestrator
does not apply under Claude Code." Saving a changed orchestrator
route while the effective harness is `claude` is rejected with an error
message rather than silently dropped.

Unchecking an agent's
checkbox, never deletes `routing.json` beyond the specific agent cleared —
it only changes what's shown or which entries remain.

#### Using another provider for one agent under Claude Code

Checking "Use another provider for this agent" under the Claude Code
harness and clicking Save turns that agent into a relay to the chosen
provider. A Task subagent always runs on Claude, so the agent file itself
forwards the work: Save rewrites `.claude/agents/<id>.md` as follows (the
conversion is `src/core/agentRelay.ts`, applied by
`scripts/apply-routing-profile.mjs --relay`, which `saveRoutingProfile` passes
only when the effective harness is Claude Code).

- Only a provider named on the agent's own card makes it a relay. A foreign
  vendor that comes only from the shared "Default for all agents" slot does
  not convert any agent; the Defaults section says so on Claude Code. An agent
  already relayed reverts if its vendor then comes only from defaults.
- Frontmatter: `model:` becomes the `haiku` wrapper alias, the previous value
  is kept in `tycoon_relay_original_model`, and `tycoon_relay: <server>` names
  the bridge. `name`, `description` and `disallowedTools` are unchanged. A
  `tools:` allowlist gains the relay's MCP tool (and Read, Edit and Write in
  propose mode); the original line is kept in `tycoon_relay_original_tools`.
  `tycoon_relay_hash` lets a revert notice edits to the generated text.
- Body: a generated `## Relay (managed by TycoonAgents)` section (between
  `<!-- tycoon:relay:begin -->` and `<!-- tycoon:relay:end -->`) tells the
  agent to call the provider's MCP tool once (`mcp__tycoon__delegate` when the
  dispatcher is installed, otherwise `mcp__codex__codex`, `mcp__codex-write__codex`,
  `mcp__claude-cli__claude`, `mcp__gemini__ask-gemini` or
  `mcp__openai-compatible__chat`) with the slot's model id, the project
  directory and the task verbatim, and to report the provider's result in the
  project's report format. A generated `### Brief to forward` block (between `<!-- tycoon:relay-brief:begin/end -->`) holds the original minus its `## Working discipline` section. The agent's full original body is kept verbatim under
  `## Original instructions (kept for revert, not forwarded)`, between
  `<!-- tycoon:relay-original:begin -->` and `<!-- tycoon:relay-original:end -->`.
- Propose mode (Codex by default, Gemini, OpenAI-compatible endpoints): the
  registered `codex` server is read-only, so the provider is asked for the exact
  changes (a unified diff, or a file path with its full new content) and the
  relay applies them with Read, Edit and Write exactly as returned, with no
  extra reasoning. If a patch does not apply, the relay reports which file and
  hunk failed.
- Codex write access is opt-in. Ticking "Let Codex edit files in this project
  (workspace-write sandbox)" on the card and saving is the consent: it
  registers a separate local-scope server, `codex-write`, with the same
  launcher but `sandbox_mode="workspace-write"` and `approval_policy="never"`,
  and that agent's relay targets `mcp__codex-write__codex` and lets Codex make
  the edits. Unticking, or reverting the agent, switches back; `codex-write` is
  removed from local scope once no saved slot uses it. The read-only `codex`
  entry is never changed, and no call ever passes sandbox or approval
  arguments.
- Workspace-capable bridge (Claude CLI): the provider makes the edits under the
  server's registered permission mode.
- Switching between foreign providers regenerates only the relay section.
  Setting the slot back to Anthropic, or unchecking "Use another provider"
  and saving, restores the original body, model and `tools:` line exactly and
  removes the markers and keys (a stored model Claude Code would reject is
  replaced by the agent's catalog default, with a notice). A leading BOM is
  kept. If the file was edited after conversion, the edited file is first saved
  as `<id>.md.relay-backup` and the save reports it; if the markers are gone,
  the file is left as it is and the save reports that the agent is still a
  relay.
- Panel heals and resyncs skip a file that carries `tycoon_relay`, so the
  relay survives panel opens until it is reverted.
- The change applies to a new chat. The stage shows the agent in the
  foreign-provider color while its provider call is active, whether the relay
  calls the MCP tool directly or goes through `mcp__tycoon__delegate`.
  Hand-written bridge agents (the reviewers above) and the Codex and OpenCode
  harnesses keep their existing behavior.
