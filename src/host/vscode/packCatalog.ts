/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

/** The agent definition embedded in a capability pack. */
export interface PackAgent {
  /** Agent id, used as the `.claude/agents/<id>.md` file name. */
  id: string;
  /** Display name, rendered as the markdown H1 heading. */
  name: string;
  /** Model id written to YAML frontmatter (`model:`). */
  model: string;
  /** One-line role description for the `## Role` section. */
  role: string;
  /** Pipe-delimited task-routing keywords for the `## Keywords` section. */
  keywords: string;
  /**
   * Optional roster tier. Omitted (undefined) for regular worker agents.
   * `"lead"` marks a team-lead coordinator that owns a set of worker
   * agents — installers and the ready-test skill must not treat lead
   * agents the same as regular workers (see `LEAD_AGENTS`).
   */
  tier?: "lead";
}

/**
 * Build the markdown content for a pack's domain agent file
 * (`.claude/agents/<id>.md`). Pure: no fs/vscode access, so this is
 * unit-testable. Output round-trips through `parseAgentMarkdown`.
 * Returns a string ending in a trailing newline.
 *
 * Regular agents (no `tier`) render exactly as before — a `model:`
 * frontmatter line only. Lead agents additionally emit a `tier: lead`
 * frontmatter line so downstream tooling (installers, the ready-test
 * skill) can recognize and skip them.
 */
export function buildAgentMarkdown(agent: {
  id: string;
  name: string;
  model: string;
  role: string;
  keywords: string;
  tier?: "lead";
}): string {
  return (
    "---\n" +
    `model: ${agent.model}\n` +
    (agent.tier ? `tier: ${agent.tier}\n` : "") +
    "---\n" +
    "\n" +
    `# ${agent.name}\n` +
    "\n" +
    "## Role\n" +
    `${agent.role}\n` +
    "\n" +
    "## Keywords (for task routing)\n" +
    `${agent.keywords}\n`
  );
}

/**
 * Read the `tier:` frontmatter value from an agent markdown file's content,
 * if any. Pure (no fs/vscode access), inverse of the `tier` line
 * {@link buildAgentMarkdown} writes. This is the safety predicate used
 * before deleting a `.claude/agents/<id>.md` file when downgrading out of
 * Team Leads mode: only a file whose frontmatter says `tier: lead` is
 * eligible for removal, so a user's own file that happens to share an id
 * like `build-lead.md` (but wasn't written by TycoonAgents) is never
 * deleted.
 */
export function agentMarkdownTier(content: string): string | undefined {
  const lines = content.split(/\r\n|\n/);
  if (lines.length === 0 || lines[0] !== "---") {
    return undefined;
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      break;
    }
    const match = /^\s*tier\s*:\s*(\S+)\s*$/.exec(lines[i]);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * The 8 regular worker agents that make up TycoonAgents' core roster
 * (mirrors the hand-authored `.claude/agents/*.md` files in this repo).
 * Consumers that iterate a catalog for install/discovery should use this
 * list — it deliberately excludes lead agents (see `LEAD_AGENTS`).
 */
export const REGULAR_AGENTS: PackAgent[] = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    model: "opus",
    role:
      "Coordinates work across the specialist agents instead of implementing directly — delegates via the Task tool, briefs sub-agents, and reviews their results. Routing rules live in CLAUDE.md.",
    keywords: "orchestrate|coordinate|delegate|route|plan",
  },
  {
    id: "primary-agent",
    name: "Fallback Agent",
    model: "sonnet",
    role:
      "The catch-all worker that receives tasks when none of the specialist agents' keywords matched. Its presence in the work log is a signal that the orchestrator should refine its keyword routing.",
    keywords: "general|fallback|default|misc|primary|generalist",
  },
  {
    id: "search-retrieval",
    name: "Search & Retrieval Agent",
    model: "haiku",
    role:
      "The fast search and retrieval specialist — uses the Haiku model for token-efficient searching, documentation lookup, and quick reference finding across codebases and documentation.",
    keywords: "search|find|lookup|grep|glob|locate|look|where|explore",
  },
  {
    id: "coding-specialist",
    name: "Coding Specialist",
    model: "sonnet",
    role:
      "Handles core implementation for TycoonAgents — TypeScript in src/core/ (events, state, provider abstraction), src/providers/ (provider adapters), and non-VS-Code logic in src/host/. Writes clean, focused, tested code.",
    keywords: "implement|code|fix|bug|refactor|create",
  },
  {
    id: "testing-specialist",
    name: "Testing Specialist",
    model: "haiku",
    role:
      "Writes and maintains tests for TycoonAgents (the test/ suite, e.g. mapHookRecord.test.ts, providerState.test.ts) and keeps coverage meaningful.",
    keywords: "test|spec|vitest|jest|coverage|unit",
  },
  {
    id: "vscode-integration",
    name: "VS Code Integration",
    model: "sonnet",
    role:
      "Owns VS Code extension specifics for TycoonAgents — activation/lifecycle, the webview panel, message passing, commands, and settings (src/host/vscode/ and the extension manifest in package.json).",
    keywords: "vscode|extension|webview|panel|lifecycle",
  },
  {
    id: "ux-ui-designer",
    name: "UX/UI Designer",
    model: "sonnet",
    role:
      "Designs and implements the visual layer of TycoonAgents' webview — the build-site scene rendered in media/ (main.js canvas renderer, style.css): layout, animation, and how agent activity reads at a glance.",
    keywords: "ux|ui|design|canvas|layout|css|animation",
  },
  {
    id: "workspace-monitor",
    name: "Workspace Monitor",
    model: "haiku",
    role:
      "Owns the agent-activity domain for TycoonAgents: turning Claude Code (and other provider) hook events into normalized agent states the renderer can show. Centered on src/core/events.ts, src/core/state.ts, and src/providers/claude-code/.",
    keywords: "monitor|lifecycle|event|hook|activity|track",
  },
];

/**
 * Team-lead coordinator agents (Phase 1 of hierarchical "team lead mode").
 * Kept in a SEPARATE list from `REGULAR_AGENTS` on purpose: existing
 * install paths that iterate a catalog for regular workers must not pick
 * these up automatically — a lead has to be installed deliberately by a
 * caller that opts into hierarchical delegation. Each entry carries
 * `tier: "lead"`, which `buildAgentMarkdown` renders as a `tier: lead`
 * frontmatter line so the ready-test skill (and any other tooling that
 * scans `.claude/agents/*.md`) can recognize and skip them.
 */
export const LEAD_AGENTS: PackAgent[] = [
  {
    id: "build-lead",
    name: "Build Lead",
    model: "sonnet",
    tier: "lead",
    role:
      "Team lead for implementation work — owns the coding-specialist, ux-ui-designer, and vscode-integration workers. Receives multi-task assignments from the orchestrator, decomposes them, briefs each worker with exact file paths/symbols/success criteria, verifies worker output before reporting, and reports compressed results (under 250 words) upward. Never does implementation itself when a worker fits; never spawns deeper than its own workers.",
    keywords: "lead|team|coordinate|plan|decompose|assign",
  },
  {
    id: "quality-lead",
    name: "Quality Lead",
    model: "sonnet",
    tier: "lead",
    role:
      "Team lead for verification work — owns the testing-specialist and workspace-monitor workers. Decomposes test/verification assignments, briefs workers, cross-checks results against acceptance criteria written in docs/plan/*.md, and reports compressed results upward. Never certifies work produced by its own team without running the checks.",
    keywords: "quality|verify|test plan|acceptance|audit",
  },
];
