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
}

/**
 * Build the markdown content for a pack's domain agent file
 * (`.claude/agents/<id>.md`). Pure: no fs/vscode access, so this is
 * unit-testable. Output round-trips through `parseAgentMarkdown`.
 * Returns a string ending in a trailing newline.
 */
export function buildAgentMarkdown(agent: {
  id: string;
  name: string;
  model: string;
  role: string;
  keywords: string;
}): string {
  return (
    "---\n" +
    `model: ${agent.model}\n` +
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
