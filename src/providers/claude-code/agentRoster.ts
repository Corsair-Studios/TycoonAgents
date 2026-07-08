/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";

/** A single installed agent, parsed from a .claude/agents/<id>.md file. */
export interface RosterAgent {
  /** Agent id derived from the file name (e.g. "coding-specialist"). */
  id: string;
  /** Display name from the first `# Heading`, falling back to a title-cased id. */
  name: string;
  /** Model id from YAML frontmatter (`model:`), if present. */
  model?: string;
  /** One-line role description (first non-empty line under `## Role`), if present. */
  description?: string;
}

/** Title-case a kebab/snake id for use as a fallback display name. */
function titleCase(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse a single agent markdown file's content into roster fields.
 * Pure: no filesystem access. `id` is supplied by the caller (from the file name).
 */
export function parseAgentMarkdown(id: string, content: string): RosterAgent {
  let model: string | undefined;
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const modelMatch = fmMatch[1].match(/^model:\s*(.+)$/m);
    if (modelMatch) model = modelMatch[1].trim();
  }

  // Display name: first markdown H1 heading, else title-cased id.
  const headingMatch = content.match(/^#\s+(.+)$/m);
  const name = headingMatch ? headingMatch[1].trim() : titleCase(id);

  // Description: first non-empty line beneath a "## Role" section.
  let description: string | undefined;
  const roleMatch = content.match(/^##\s+Role\s*\n+([^\n]+)/m);
  if (roleMatch) description = roleMatch[1].trim();

  return { id, name, model, description };
}

/**
 * Read every `<id>.md` in the agents directory and parse it into a RosterAgent.
 * Returns [] if the directory is missing/unreadable. The orchestrator is sorted
 * first; remaining agents follow alphabetically by display name.
 */
export function loadAgentRoster(agentsDir: string): RosterAgent[] {
  let files: string[];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const agents: RosterAgent[] = [];
  for (const file of files) {
    const id = file.replace(/\.md$/, "");
    let content = "";
    try {
      content = fs.readFileSync(path.join(agentsDir, file), "utf8");
    } catch {
      continue;
    }
    agents.push(parseAgentMarkdown(id, content));
  }

  agents.sort((a, b) => {
    if (a.id === "orchestrator") return -1;
    if (b.id === "orchestrator") return 1;
    return a.name.localeCompare(b.name);
  });
  return agents;
}
