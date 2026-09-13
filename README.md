# TycoonAgents™

**TycoonAgents™ is an AI build harness first, and a visualization second.** It's built to make the most of your tokens: instead of running everything on one expensive model, it routes work to a fleet of sub-agents — each on the model that fits the job — so your project gets built in the most cost-effective way possible. A heavyweight model coordinates and makes the calls; cheaper, faster models pick up the work they're suited for.

Sitting on top of that harness is a live, game-style visualization of your agent fleet — but the harness is the point.

> **Status:** Working prerelease — not a design sketch. TycoonAgents ships as a real VS Code extension (.vsix) with a small early user base: mandatory delegation, the live visualization, custom themes, an in-panel handbook, and everything else described below runs today. It's still prerelease software — expect rough edges and breaking changes between versions. See [docs/DESIGN.md](docs/DESIGN.md) for the full product & architecture design.

**Three ways to run it:**
- **VS Code extension with Claude Code** — install the extension and open the panel (see Setup below).
- **Standalone product** — `node standalone/src/cli.mjs watch .`, no VS Code required; see [`standalone/README.md`](standalone/README.md).
- **OpenCode as the provider** — `--provider opencode`; see "Using OpenCode as the provider" below and [`docs/OPENCODE-PROVIDER.md`](docs/OPENCODE-PROVIDER.md).

## Mandatory delegation & orchestration

TycoonAgents installs a **delegation doctrine** into your project's `CLAUDE.md` and a roster of specialist sub-agents into `.claude/agents/`. The rule it establishes is simple: **the orchestrator coordinates work — it does not do the work.** Implementation, searching, and exploration are all delegated via the Task tool to the specialist best suited to each job. Doing that work directly on the orchestrator's model costs roughly **5× more per token when the orchestrator is Opus** — more in practice, since the orchestrator re-reads its large context every turn (less if you've configured a cheaper orchestrator model) and hides the work from the visualization.

The roster the extension seeds (all model tiers are configurable):

| Agent | Model | Handles |
| --- | --- | --- |
| **orchestrator** | Opus or higher (recommended) | Coordinates and delegates; never implements directly |
| **search-retrieval** | Haiku | File/code search, grep/glob, lookups — the cheapest tier |
| **coding-specialist** | Sonnet | Implementation, edits, bug fixes, refactoring |
| **testing-specialist** | Sonnet | Tests, specs, coverage |
| **ux-ui-designer** | Sonnet | Webview scene, layout, CSS, animation |
| **vscode-integration** | Sonnet | Extension API, webview, panel, lifecycle |
| **workspace-monitor** | Sonnet | Agent lifecycle / hook-record mapping |
| **uefn-auditor** | Sonnet | Reviews UEFN Verse for correctness, deprecations, and API compliance against the locally installed Verse/Fortnite/Unreal digests — does not author features |
| **verse-expert** | Sonnet | Writes and refactors UEFN Verse device scripts and island gameplay, using the UEFN Bridge for live-editor control |
| **Fallback agent** | Haiku | Catch-all for work no specialist keyword matched — a signal to refine routing, not a design goal |

The doctrine also builds in **verification discipline**: a "completed" notification is not proof, so the orchestrator reads changed files on disk before trusting a result, keeps concurrent workers on disjoint files, and treats workers as leaves that do the work themselves rather than re-delegating.

## Token savings you can see

Because searches run on Haiku and implementation on Sonnet instead of everything on the orchestrator's (recommended: Opus or higher) model, most of your work runs on models that are **several times cheaper** — Haiku is about **5× cheaper than Opus** per token. The metrics panel makes that concrete, without pretending to be a billing statement:

- **Per-agent "vs. orch." badge** — each delegated agent shows how much cheaper (or pricier) its model is than the orchestrator's, e.g. *"5× cheaper."*
- **Cost-share bar** — each agent's row fills in proportion to its estimated share of the run's blended cost, so you can see at a glance where the spend went.
- **Session headline** — *"Delegating this work avoided ~N% of the cost of running it all on the orchestrator."* Shown only when delegation was actually cheaper.

**When savings aren't shown.** The counterfactual, billed, and estimated-avoided figures only appear when every delegated worker in the run shares one vendor with a shipped price table and reported real token usage. In mixed-vendor setups — say a Codex, Gemini, or Kimi reviewer alongside Claude workers — or when a worker returns no usage at all, the panel shows *"Savings not shown: <reason>"* instead; per-agent token and call counts still display. Separately, because TycoonAgents delegation spawns Claude Code subagents, VS Code's own Agent map also lists them — the two views agree only in a pure Claude setup, since foreign-harness workers never appear in the Agent map.

**Concurrent spawns of the same specialist.** When more than one instance of a specialist is live at once, the metrics table tracks each spawn separately: the row picks up a **"×N"** badge and an extra character appears on the scene for as long as more than one instance is running. The active row shows the spawn's task description under the agent name, matching the label used in the VS Code Agent map. An **"(inferred)"** marker next to the name means the spawn used a built-in subagent type rather than an explicit agent name, so the role shown was guessed from keywords in the brief — treat it as a cue to tighten keyword routing or name the agent directly.

Figures are **dimensionless ratios** from measured tokens × approximate per-model rates — not a billed dollar amount, and not applicable to subscription plans (which bill by plan, not per token). The point is the *ratio*: the same work on a bigger model would cost multiples more.

## Project plan

Turn a design doc into an **approvable plan** and let the fleet execute it. The Project Plan feature decomposes a spec into an ordered set of **phases**, each holding **tasks** with concrete acceptance criteria, then works through them one task at a time — delegating each to the right specialist, verifying the result against its own criteria, and **stopping at every phase gate for your approval** before moving on.

It's **zero-runtime-AI**: all the reasoning happens in Claude Code; the extension only reads and displays `.claude/tycoon/plan.json` and lets you approve, retry, or skip tasks from the panel. It's **on by default** for new installs and toggleable in Settings.

## Self-contained & hook-driven

The shipped extension makes **zero runtime AI calls of its own.** Everything you see is built from Claude Code **hooks** that record when agents are dispatched, work, and finish — the visualization and metrics are a normalized view of those records, nothing more. (Image generation for themes is an *authoring-time* convenience only; see below.)

## Setup

Install the extension and open the TycoonAgents panel. First run (or the **Repair** button) sets everything up in your project:

- writes the delegation doctrine into `CLAUDE.md` (in a managed, auto-healing block),
- seeds the specialist agent roster into `.claude/agents/`,
- merges the tracking hooks into `.claude/settings.json`,
- enables the Project Plan by default.

Everything it writes is marker-scoped and reversible, and it never stamps your own generated code.

## What's shipped

- **Bundled theme.** "Survivors vs Zombies" ships inside the VSIX and seeds automatically on first run, so a fresh install has a playable stage without any API keys.
- **More themes to download.** Additional themes are published as `.zip` archives. The themes repo is private while the project is in prerelease, so get the `.zip` directly from the maintainer, then import it from the Theme Picker's **Import .zip**. The extension never fetches themes over the network.
- **In-panel handbook.** A 13-chapter user handbook ships in the VSIX, opened from the book icon in the panel.
- **Submit Feedback.** An in-panel two-step form shows the exact JSON payload before anything is sent; local paths and API keys are stripped from it first. If the panel won't open, there's a fallback web form at [feedback.corsairstudios.com](https://feedback.corsairstudios.com).
- **Delegation & Metrics tabs.** Live panel views of what got delegated to which agent and the resulting token-cost breakdown (see "Token savings you can see" below).
- **UEFN pack.** Skills that understand Verse syntax and write Verse code, project/LSP checks, and the `uefn-auditor`/`verse-expert` agents. Pair it with Trashbyrd's UEFN Power Tools MCP for live access to an open UEFN level.
- **Verse analyzer.** Audits UEFN Verse source against the locally installed Verse/Fortnite/Unreal API digests, flagging calls to deprecated or nonexistent APIs.
- **UEFN moderation pre-flight scan.** Collects the asset names, paths, and metadata Fortnite's island moderation actually inspects, then has your connected AI assistant judge them against Epic's IP and authenticity rules before you submit.
- **Ready test & diagnose, by default.** The `tycoon-ready-test` skill (spawns every configured agent in parallel and verifies they light up in the visualization) and `tycoon-diagnose` skill (AI-reasoned audit of this project's own delegation/routing config) both ship in the VSIX and land in `.claude/skills/` on every Install/Repair — no separate opt-in.

## The layer on top: the tycoon visualization

The fun part — a game-style scene that makes agent activity readable at a glance:

- **Live per-agent metrics** — who's active, work completed, token cost, tasks finished, response rate, MCP usage.
- **Build & defend** — agents build objects across your site and defend the base from incoming attacks.
- **Achievements, badges & rebirths** — earn badges for milestones; rebirth for compounding bonuses (and the whole fleet dances for three seconds when you do).

## Custom themes

The scene is **user-authored data** — you can generate your own theme (characters, objects, enemies, expressions, badges, decor, and an environment) from text prompts.

1. **Open the Theme Builder** from the Themes panel.
2. **Choose an image provider, key, and model.** Pick `openai` (GPT Image) or `gemini` (Nano Banana), paste your API key, and pick a model — it defaults to **Latest (recommended)** and offers older/cheaper tiers (e.g. *GPT Image 1 Mini*, *Gemini Flash-Lite*) if you'd rather save cost.
3. **Fill the generate form** — theme name, creative direction, and an environment description, plus per-slot editors for the characters (16), objects (21), enemies (4), expressions (8), badges (25), and decor (9).
4. **Generate and review.** Each sprite board is generated in turn; a review list lets you rename items, edit descriptions and creative direction, and **accept or retry** each board (including the isometric stage/background) until it's right.
5. **Use it.** Themes are stored in the extension's global storage and loaded into the live scene at runtime; you can **export a theme as a `.zip`** and import it elsewhere.

Prefer to author outside VS Code? There's a **standalone theme host** in [`standalone/`](standalone/) that drives the same generation pipeline in a browser tab — `npm start` for a dev server, or `node src/cli.mjs watch <project-path>`.

> Image generation happens **only at authoring time** and uses your own API key. The shipped plugin still makes zero runtime AI calls — themes are just data.

## Multi-LLM

A provider abstraction so agent activity can come from Claude Code, other agent harnesses, or local/API models.

### Using OpenCode as the provider

TycoonAgents can read activity from [OpenCode](https://opencode.ai) instead of Claude Code, via the same provider abstraction. This depends on the `.claude/agents/*.md` agent roster existing first — it is not committed (`.claude/` is gitignored); seed it via the VS Code panel's Install/Repair hooks, or `node standalone/src/cli.mjs install-hook <dir>` / `seed-agents <dir>` on OpenCode-only setups — see "Prerequisite: the agent roster" in [`docs/OPENCODE-PROVIDER.md`](docs/OPENCODE-PROVIDER.md).

1. **Build** — from the repo root:

  ```sh
  npm install && npm run build
  ```

  This compiles the TypeScript sources and copies the hook runtime files the OpenCode plugin needs.

2. **Select the provider** — VS Code setting `tycoonagents.provider: "opencode"`, or the `TYCOON_PROVIDER=opencode` environment variable (which always overrides the setting), or `--provider opencode` in the standalone host.
3. **Generate the roster** — `npm run opencode:config` writes an OpenCode-flavored agent config from the same specialist roster the VS Code extension seeds.
4. **Register the plugin** — copy `hooks/tycoon-opencode-plugin.ts`, `hooks/agentBackend.js`, `hooks/modelAliases.js`, `hooks/delegationEnforcement.js`, and `hooks/fallbackChain.js` into your project's `.opencode/plugin/` directory (OpenCode loads `.ts` plugins from there); the standalone host can do this for you — see [`standalone/README.md`](standalone/README.md#opencode-plugin-registration).
5. **Run a session** in OpenCode as usual — the plugin appends hook records to the same activity log the Claude Code hook writes to. On a headless or remote machine, set `TYCOON_STANDALONE_NO_OPEN=1` so the standalone does not try to launch a browser.
6. **What the panel shows** — the same live agent visualization and metrics, sourced from OpenCode's events instead of Claude Code's.

### Codex host (Experimental)

TycoonAgents can also read activity from [Codex CLI](https://github.com/openai/codex) via the same provider abstraction, alongside Claude Code and OpenCode. Codex support is Experimental.

- **Selection** — precedence highest to lowest: `TYCOON_PROVIDER=codex` environment variable, then the VS Code setting `tycoonagents.provider: "codex"`, then the `provider` key in `<projectDir>/.claude/tycoon/execution.json`, then the `claude-code` default (see `src/core/providerSelection.ts:13-18`). `--provider codex` in the standalone host maps to the same setting-level slot.
- **Per-agent attribution** — Codex has no per-agent hook payload the way Claude Code's hooks or OpenCode's plugin events do. Attribution is reconstructed from two sources instead: the `notify` command TycoonAgents registers in `CODEX_HOME/config.toml` (see `src/providers/codex/installCodexHooks.ts`), and Codex's own rollout/session metadata, which are cross-referenced to map a spawn back to the agent that made it.
- **Known tradeoff** — because attribution is reconstructed rather than pushed live per turn, a sub-agent mid a multi-turn exchange shows as *stopped* and then *reopened* between turns in the panel, instead of staying continuously "running" the way a Claude Code or OpenCode sub-agent does. This is a limitation of what Codex currently exposes, not a bug in the mapping.
- **Platforms** — the Codex binary is discovered on Windows, macOS, and Linux via PATH, the npm global install location, `~/.codex/bin`, Homebrew (`/opt/homebrew/bin` or `/usr/local/bin`, macOS only), and the bundled binary inside the OpenAI ChatGPT VS Code extension; set `CODEX_BINARY_PATH` to override discovery outright. `CODEX_HOME` (default `~/.codex`, using `USERPROFILE` on Windows) overrides where rollout/session files and `config.toml` are read from.

### Codex CLI 0.154 and later (Experimental)

codex-cli 0.154 removed the `mcp-server` stdio command that TycoonAgents' Codex MCP entry
previously launched directly. The Codex MCP entry now runs `node hooks/codex-mcp-launcher.cjs`,
which discovers the Codex binary at runtime — checking, in order, the `CODEX_CLI_PATH` override,
the project's `node_modules`, `PATH`, the npm global install location, Homebrew, `~/.codex/bin`,
`~/.local/bin`, and finally the newest OpenAI VS Code extension bundle. It prefers a discovered
binary that still exposes `mcp-server`, and otherwise falls back to
`hooks/codex-app-server-mcp.cjs`, a shim over Codex's `app-server` protocol that exposes the same
`codex` and `codex-reply` tools. The project pins `@openai/codex` `0.153.0` as a devDependency for
this reason. The fallback shim is Experimental.

### Routing walkthrough

1. In **Settings**, use **"Which tool runs your agents?"** to pick the harness (Claude Code or OpenCode).
2. Open the **Routing** view from the panel menu.
3. Fill in the **orchestrator** slot at the top the same way as any agent row below.
4. For a per-agent model, pick **Vendor** then choose a preset from the **Model** dropdown.
5. For a local or VM-hosted OpenAI-compatible server, pick **Custom endpoint…** as the vendor: give it a **Provider name** (e.g. `ollama-windows`), the **Model** id exactly as your endpoint serves it, and **Cost class** `local`. Set the **Endpoint URL env** and **API key env** fields to environment variable *names* only, then click **Set value…** next to each to store the actual URL/key — both are saved under the TycoonAgents per-user app-data folder, never in the project, and each shows a dot reading "stored locally" once set. **Clear stored value** removes one.
6. Expand **"Fallback chain (N)"** and **"+ Add fallback"** to add ordered fallback slots (e.g. `opencode/big-pickle`, then a subscription-backed slot).
7. **Save** writes the resolved slots to `routing.json`, applies managed `backend:` blocks to agent files, and adds a secret-free provider entry to `opencode.json` plus your user-level OpenCode config (file references only) — any slot about to change shows a "will be written to routing.json" marker first.
8. **Clear profile** removes the routing profile and its generated blocks but keeps everything you stored via Set value….
9. Each agent row shows its **"model from …"** source line, a **"ran on fallback"** chip when it last ran on a fallback entry, and the view's **Totals** block rolls up per-vendor and per-cost-class counts.

### Default fallback

The **Routing** view has a **Default fallback** picker at the top. It fires
for any agent once that agent's own fallback chain is exhausted, or
immediately when the agent has none, whenever the agent runs out of tokens
(usage limit, 401/429, quota) or is unreachable (connection refused, missing
endpoint). Each agent's **"Fallback chain (N)"** section shows the default
as a final amber **"(fb)"** row with a **"Use default fallback for this
agent"** checkbox, checked by default; unchecking it makes that agent fail
after its own chain instead. The default never falls back to itself, never
repeats an agent already tried in the chain, and total chain depth stays at
most 3. Fallback targets must be dispatchable in the current harness — the
existing amber warning flags one that isn't.

### Copy and paste agent settings

Each agent card's footer has **Copy settings** and **Paste settings**.
**Copy** captures that card's routing setup — vendor, model, cost class,
transport and MCP server, endpoint and credential environment variable
names, fallback chain, and the default-fallback switch — but never the
agent's id, display name, keywords, or any secret value. **Paste** applies
it to another card and shows a one-step "Pasted from <agent> · Undo"
banner; nothing is written until **Save**. Useful for repeating a
VM-hosted or local-model setup across agents.

See [`docs/ROUTING-PROFILE.md`](docs/ROUTING-PROFILE.md) for the full `routing.json` schema.

See [`docs/OPENCODE-PROVIDER.md`](docs/OPENCODE-PROVIDER.md) for the full IPC contract and mapping details. Note: Anthropic/OpenAI models used through OpenCode are billed per API token, not through a Claude/Codex subscription — subscription access reaches OpenCode only via the vendor CLIs (see `docs/OPENCODE-PROVIDER.md`).

## UEFN pack

TycoonAgents ships a UEFN pack: skills that understand Verse syntax and write Verse code, project/LSP checks, and the `uefn-auditor` and `verse-expert` agents. For live access to an open UEFN level, pair it with Trashbyrd's UEFN Power Tools MCP (install separately; the panel can register it) — see [`docs/POWER-TOOLS-COEXISTENCE.md`](docs/POWER-TOOLS-COEXISTENCE.md) for details for maintainers.

## Project layout
- [`docs/DESIGN.md`](docs/DESIGN.md) — product & architecture design (start here).
- [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) — layered attribution policy (significant files only, harness footprint, panel UI credit).

## Attribution
Authored by **TycoonAgents** — https://x.com/thetrashbyrd
The main repository and the themes repository are both currently private, and there's no public releases page or Marketplace listing yet; get the VSIX and any additional theme archives directly from the maintainer.

Attribution is intentionally light (see [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md)): a short, removable header on *significant* files only, a one-line footprint in the managed block of `CLAUDE.md` / agent files, and a clickable credit in the panel UI — TycoonAgents never stamps the user's own generated code.

## License
Free to use and share, including the bundled theme artwork — but not to be sold, repackaged into a paid product, or redistributed commercially, without the maintainer's express written approval. See [LICENSE](LICENSE) for the full terms.

TycoonAgents™ is a trademark of Corsair Studios LLC. Licensed under the Functional Source License 1.1 (ALv2 future license); see LICENSE.

## Thanks
Thanks to **IndieDevDan** for his tutorials.
