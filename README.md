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

**When the ratio isn't shown.** The relative-cost line only appears when every delegated worker in the run shares one vendor with a shipped price table and reported real token usage. In mixed-vendor setups — say a Codex, Gemini, or Kimi reviewer alongside Claude workers — or when a worker returns no usage at all, the panel shows *"Relative cost not shown: <reason>"* instead; per-agent token and call counts still display. Separately, because TycoonAgents delegation spawns Claude Code subagents, VS Code's own Agent map also lists them — the two views agree only in a pure Claude setup, since foreign-harness workers never appear in the Agent map.

**What the Tokens column counts.** The Tokens column is billed context tokens summed over every turn — input, output, and cache writes — with cache reads shown separately since they aren't billed at the same rate. Harnesses that don't report usage (Codex today) show *"n/a"* and are left out of the total.

**Concurrent spawns of the same specialist.** When more than one instance of a specialist is live at once, the metrics table tracks each spawn separately: the row picks up a **"×N"** badge and an extra character appears on the scene for as long as more than one instance is running. The active row shows the spawn's task description under the agent name, matching the label used in the VS Code Agent map. An **"(inferred)"** marker next to the name means the spawn used a built-in subagent type rather than an explicit agent name, so the role shown was guessed from keywords in the brief — treat it as a cue to tighten keyword routing or name the agent directly.

Figures are **dimensionless ratios** from measured tokens × approximate per-model rates — the price table only drives these relative "N× cheaper" badges, and no dollar amount is ever shown, since that would misrepresent subscription plans (which bill by plan, not per token). The point is the *ratio*: the same work on a bigger model would cost multiples more.

## Project plan

Turn a design doc into an **approvable plan** and let the fleet execute it. The Project Plan feature decomposes a spec into an ordered set of **phases**, each holding **tasks** with concrete acceptance criteria, then works through them one task at a time — delegating each to the right specialist, verifying the result against its own criteria, and **stopping at every phase gate for your approval** before moving on.

All the reasoning happens in Claude Code; the extension only reads and displays `.claude/tycoon/plan.json` and lets you approve, retry, or skip tasks from the panel (see "Self-contained & hook-driven" below for the zero-runtime-AI claim this rests on). It's **on by default** for new installs and toggleable in Settings.

## Self-contained & hook-driven

The shipped extension makes **zero runtime AI calls of its own.** Everything you see is built from **hooks** that record when agents are dispatched, work, and finish, captured by whichever harness is installed (Claude Code, OpenCode (Experimental), or Codex (Experimental)). The visualization and metrics are a normalized view of those records, nothing more. (Image generation for themes is an *authoring-time* convenience only; see below.)

## Setup

Install the extension and open the TycoonAgents panel. First run (or the **Repair** button) sets everything up in your project:

- writes the delegation doctrine into `CLAUDE.md` (in a managed, auto-healing block),
- seeds the specialist agent roster into `.claude/agents/`,
- merges the tracking hooks into `.claude/settings.json`,
- enables the Project Plan by default.

Everything it writes is marker-scoped and reversible, and it never stamps your own generated code.

## What's shipped

- **Bundled theme.** "Survivors vs Zombies" ships inside the VSIX and seeds automatically on first run, so a fresh install has a playable stage out of the box.
- **Theme Builder.** The primary path on the Themes page — generate a custom theme (characters, objects, enemies, expressions, badges, decor, and an environment) from text prompts through the Corsair Theme Service. Opening it prompts you to sign in, then spends credits per generation attempt (see "Sign-in and credits" below).
- **Import .zip.** The free, offline path, and always available: additional themes are published as `.zip` archives. The themes repo is private while the project is in prerelease, so get the `.zip` directly from the maintainer, then import it from the Theme Picker's **Import .zip**. The extension never fetches themes over the network.
- **In-panel handbook.** A 13-chapter user handbook ships in the VSIX, opened from the book icon in the panel.
- **Submit Feedback.** An in-panel two-step form shows the exact JSON payload before anything is sent; local paths and API keys are stripped from it first. If the panel won't open, there's a fallback web form at [feedback.corsairstudios.com](https://feedback.corsairstudios.com).
- **Delegation & Metrics tabs.** Live panel views of what got delegated to which agent and the resulting token-cost breakdown (see "Token savings you can see" below).
- **UEFN pack.** See "UEFN pack" below.
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

1. **Open the Theme Builder** from the Themes panel — it's the primary path for creating a theme.
2. **Choose a model.** Pick a generation model — it defaults to **Latest (recommended)** and offers older/cheaper tiers if you'd rather save cost. Generation runs through the Corsair Theme Service using credits (see "Sign-in and credits" below).
3. **Fill the generate form** — theme name, creative direction, and an environment description, plus per-slot editors for the characters (16), objects (21), enemies (4), expressions (8), badges (25), and decor (9).
4. **Generate and review.** Each sprite board is generated in turn; a review list lets you rename items, edit descriptions and creative direction, and **accept or retry** each board (including the isometric stage/background) until it's right.
5. **Use it.** Themes are stored in the extension's global storage and loaded into the live scene at runtime; you can **export a theme as a `.zip`** and import it elsewhere.

Character boards get a walk pose guide (two-legged or four-legged, chosen per character with the Body control) attached by the service as a reference image so row 1 walk frames stay consistent, at no extra credit cost.

Changing the creative direction after descriptions already exist marks them stale; use **Re-derive descriptions** to regenerate the text before generating or retrying images. See the [GitHub releases page](https://github.com/Corsair-Studios/TycoonAgents/releases) for what changed in recent versions.

Prefer to author outside VS Code? There's a **standalone theme host** in [`standalone/`](standalone/) that drives the same generation pipeline in a browser tab — `npm start` for a dev server, or `node src/cli.mjs watch <project-path>`.

> Image generation happens **only at authoring time**, through the Corsair Theme Service (see "Self-contained & hook-driven" above) — themes are just data.

### Prompt tips

- State the **subject** plainly first (what the character/object/enemy is), then style — the model reads left to right.
- Pin down an **art style** (e.g. "flat vector," "painterly pixel art," "clean cel-shaded") and repeat it across boards so the whole theme reads as one set.
- Name an explicit **palette** (2-4 colors) rather than leaving color to chance — it's the fastest way to keep sprites from clashing.
- Favor a strong, readable **silhouette** — sprites render small on the stage, so shape and contrast matter more than fine detail.
- Lock a consistent **camera/side view** (e.g. "3/4 side view, facing right") across every character and enemy board so the set feels like one game.
- Say what to **avoid**: no embedded text, no logos or watermarks, no background scenery, and no more than one character per cell.
- Keep descriptions **short and concrete** — a cluttered prompt usually produces a cluttered sprite.
- Every generation attempt is billed, including retries, so refine the creative direction and description before regenerating rather than retrying repeatedly on the same prompt.

### Sign-in and credits

Opening the Theme Builder for the first time asks you to sign in — by an emailed magic link, or with Google. In the standalone host, Google completes through a local browser callback; if that callback can't reach your browser session, a paste-the-code fallback finishes sign-in instead. Sign-in settings (the Supabase project and public key) are fetched from the Theme Service at runtime, so pointing the advanced endpoint override at a different Theme Service also selects the matching sign-in project.

Credits are what generation costs: every generation attempt spends credits, including retries, and the panel shows the cost before each attempt so you're never guessing. Attempts cost 2 credits for object, expression, and achievement boards and 3 credits for character, rival, and environment boards; a typical 23-board theme runs about 95 credits, a careful run about 55, and heavy retries up to about 170 — output quality tracks prompt quality, so a clear, specific prompt (see "Prompt tips" above) usually costs less than a vague one you keep retrying.

You can optionally enter a referral code the first time you sign in on a device, or it can arrive automatically via a partner link. A referral code never changes prices or credits — the only thing it can add is an optional one-time welcome bonus of extra credits on your first purchase, if the partner offers one — and it only applies to new accounts.

**Buy credits** opens Stripe Checkout in your browser; your balance updates when you return to the panel. Three packs are available: Starter (45 credits, $4.99), Theme (100 credits including 10 bonus, $9.99), and Bundle (205 credits including 25 bonus, $19.99), with the bigger packs showing their bonus as a percentage. Failed generations caused by provider or network errors, and generations the provider refuses on content-policy grounds, are refunded automatically; prompts blocked by content screening or a locked account are not charged at all. Credits are never refunded for images you generated successfully but don't like, so spend a retry rather than expecting a refund on a result that just missed the mark. Re-slicing an existing image is always free, no matter how many times you do it.

Generation prompts are assembled by the Corsair Theme Service from your theme description, creative direction, and per-character fields — you don't hand-write the prompt sent to the model. The extension shows a preview of the assembled prompt before you generate, and notes if the service used a newer template than the one the preview was built from.

None of this touches the free path: uploading or hand-making a theme (**Import .zip**) stays free and fully offline, with no account and no network call. The extension makes network calls only for Theme service sign-in, generation, and credit checkout (all Corsair-hosted), feedback submission, and the opt-in team readiness reachability probe; the agent harnesses (Claude Code, OpenCode, Codex) make their own separate calls.

The advanced setting `tycoonagents.themeService.endpoint` (VS Code) or the `THEME_SERVICE_ENDPOINT` environment variable (standalone) points the client at a different `https` Theme Service URL for testing, and is normally left empty.

### Acceptable use

- Prompts and reference images are screened automatically before generation runs, and a blocked prompt spends no credits.
- A generation the model refuses on content-policy grounds is refunded, but it still counts as a strike.
- Three strikes within 24 hours lock the account, disabling both generation and purchases.
- Locked accounts can request an unlock through **Submit Feedback**; the full wording lives in [`docs/theme-credits-terms-draft.md`](docs/theme-credits-terms-draft.md).

## Team setup (share your configuration with teammates)

Copying an install to a teammate's machine doesn't work: your agent roster lives at absolute paths, your API keys and CLI sessions are yours alone, and vendor CLIs (Claude, Codex, OpenCode) are discovered per machine — none of that travels. Instead, the Settings panel's **Team setup** section exports the *shape* of your setup, not the machine it runs on.

**Export team setup** writes `.claude/tycoon-team.json` at the project's `.claude` folder — the roster, per-agent routing (vendor/model plus fallback chains), the *names* of the env vars each slot needs (never values), which skills and MCP servers are enabled, the delegation mode and parallel limit, an optional plan pointer, and which harness (Claude Code, Codex, or OpenCode) the orchestrator was recorded running on. It's path-free and secret-free by construction — validation rejects anything that looks like an absolute path or a secret — so it's safe to commit. Your API keys, CLI sessions, themes, and the rest of the local `tycoon` runtime folder never leave the machine.

A teammate who clones the project and opens TycoonAgents sees a **"Team setup changed. Apply?"** drift notice the next time Settings opens. The roster is authoritative and routing is only a reference: **Apply** installs the agents, keywords, skills, delegation mode, and hooks every time, with project-relative commands (never absolute paths) so they work regardless of where the project lives on disk; the originator's vendor and model choices are used only to seed routing on a fresh clone, or when the local `routing.json` is unreadable — after that, each teammate's own routing is kept as-is, so remapping an agent to a vendor you actually have sticks across future Applies. MCP installation is skipped during Apply — it always needs your own confirmation — and any roster id Apply doesn't recognize is reported rather than guessed at. When only routing changed (the roster didn't), the drift notice instead reads **"Team routing changed (reference only)"** and prompts nothing to apply.

**Check readiness** then tells the teammate what's actually usable on their machine, computed from their own local routing: per agent, a line reading **"team: vendor/model · you: vendor/model"** with a **"differs"** chip when your routing diverges from the team's, plus whether it resolves ready (its primary vendor/model works), on a fallback, "will use default fallback" when nothing in the agent's chain is installed but a default fallback is set up, or not ready — and which env vars by name are still unset; a summary line ("N of M agents ready"); and a harness line confirming whether the recorded harness is installed here, or which ones are. Checking **"Probe reachability (may use vendor quota)"** adds a live reachability check for the resolved agents — off by default since it can spend vendor quota. From there it's mechanical: set the env vars readiness names, install whichever harness it flags missing, and re-check.

## Multi-LLM

A provider abstraction so agent activity can come from Claude Code, other agent harnesses, or local/API models.

### Using OpenCode as the provider

TycoonAgents can read activity from [OpenCode](https://opencode.ai) instead of Claude Code, via the same provider abstraction. This depends on the `.claude/agents/*.md` agent roster existing first — it is not committed (`.claude/` is gitignored); seed it via the VS Code panel's Install/Repair hooks, or `node standalone/src/cli.mjs install-hook <dir>` / `seed-agents <dir>` on OpenCode-only setups — see "Prerequisite: the agent roster" in [`docs/OPENCODE-PROVIDER.md`](docs/OPENCODE-PROVIDER.md).

Building from source and registering the OpenCode plugin are covered in [`docs/BUILDING.md`](docs/BUILDING.md). Select the provider via the VS Code setting `tycoonagents.provider: "opencode"`, the `TYCOON_PROVIDER=opencode` environment variable, or `--provider opencode` in the standalone host; the panel then shows the same live visualization and metrics, sourced from OpenCode's events instead of Claude Code's.

### Codex host (Experimental)

TycoonAgents can also read activity from [Codex CLI](https://github.com/openai/codex) via the same provider abstraction, alongside Claude Code and OpenCode. Codex support is Experimental — select it via `TYCOON_PROVIDER=codex`, the VS Code setting `tycoonagents.provider: "codex"`, or `--provider codex` in the standalone host. See [`docs/codex-host.md`](docs/codex-host.md) for provider-selection precedence, per-agent attribution reconstruction, the known "stopped/reopened" display tradeoff, and binary-discovery paths.

Codex CLI 0.154 removed the `mcp-server` command TycoonAgents previously launched directly; a runtime shim now discovers the Codex binary and falls back to an `app-server`-based adapter when needed. See [`docs/codex-host.md`](docs/codex-host.md) for the launcher internals and discovery order.

The `codex-reviewer` agent defaults to `gpt-5.6-sol`, the cheapest model a ChatGPT-account login accepts; `gpt-6-astra` is available as a higher tier. On first use, Claude Code asks once to approve the project's Codex MCP server — run `claude mcp list` to see or approve it.

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
The main repository and the themes repository are both currently private, and there's no Marketplace listing yet. Install from the VSIX attached to each [GitHub release](https://github.com/Corsair-Studios/TycoonAgents/releases); get any additional theme archives directly from the maintainer.

Attribution is intentionally light (see [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md)): a short, removable header on *significant* files only, a one-line footprint in the managed block of `CLAUDE.md` / agent files, and a clickable credit in the panel UI — TycoonAgents never stamps the user's own generated code.

## License
Free to use and share, including the bundled theme artwork — but not to be sold, repackaged into a paid product, or redistributed commercially, without the maintainer's express written approval. See [LICENSE](LICENSE) for the full terms.

TycoonAgents™ is a trademark of Corsair Studios LLC. Licensed under the Functional Source License 1.1 (ALv2 future license); see LICENSE.

## Thanks
Thanks to **IndieDevDan** for his tutorials.
