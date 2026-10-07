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

/** Roster display name shown on the metrics row (search-retrieval drops its " Agent" suffix). */
export function rosterDisplayName(agent: RosterAgent): string {
  return agent.id === "search-retrieval" ? agent.name.replace(/ Agent$/, "") : agent.name;
}

/**
 * Events a host ingests to seed the installed-agent roster: one
 * WorkerRegistered per agent file, then RosterSeeded. Shared by the standalone
 * server so it stamps the same names/models the VS Code host does.
 */
export function buildRosterSeedEvents(agentsDir: string, at: number = Date.now()): any[] {
  return rosterSeedEvents(loadAgentRoster(agentsDir), at);
}

/** Same as buildRosterSeedEvents but from an already-loaded roster (no fs access). */
export function rosterSeedEvents(roster: RosterAgent[], at: number): any[] {
  const events: any[] = roster.map((agent) => ({
    type: "WorkerRegistered",
    at,
    workerId: agent.id,
    name: rosterDisplayName(agent),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.description !== undefined ? { description: agent.description } : {}),
  }));
  events.push({ type: "RosterSeeded", at });
  return events;
}

/**
 * Pure counterpart of panel.ts's _stampRosterModels: overwrite each metric's
 * `model` with the roster value (keeping the hook-observed one on
 * `observedModel`); the orchestrator keeps its observed `model` and gets the
 * roster value on `rosterModel`.
 */
export function stampRosterModels(state: any, roster: Map<string, string>): any {
  if (state === null || typeof state !== "object" || !Array.isArray(state.agentMetrics)) {
    return state;
  }
  return {
    ...state,
    agentMetrics: state.agentMetrics.map((m: any) => {
      if (m === null || typeof m !== "object" || typeof m.id !== "string") return m;
      const rm = roster.get(m.id);
      const observed = typeof m.model === "string" && m.model.trim() !== "" ? m.model : undefined;
      if (!rm && observed === undefined) return m;
      if (m.id === "orchestrator") {
        return {
          ...m,
          ...(rm ? { rosterModel: rm } : {}),
          ...(observed !== undefined ? { observedModel: observed } : {}),
        };
      }
      return {
        ...m,
        ...(rm ? { model: rm } : {}),
        ...(observed !== undefined ? { observedModel: observed } : {}),
      };
    }),
  };
}

/** Agent id -> frontmatter model for every roster file that declares one. */
export function loadRosterModelMap(agentsDir: string): Map<string, string> {
  return rosterModelMap(loadAgentRoster(agentsDir));
}

/** Agent id -> model map from an already-loaded roster (no fs access). */
export function rosterModelMap(roster: RosterAgent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of roster) {
    if (agent.model) map.set(agent.id, agent.model);
  }
  return map;
}
