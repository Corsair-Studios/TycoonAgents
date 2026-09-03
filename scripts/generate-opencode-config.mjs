#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Roster translator: reads .claude/agents/*.md and emits an equivalent
// OpenCode config so the same agent roster runs under OpenCode as well as
// Claude Code. Plain Node, zero npm deps.
//
// Usage: node scripts/generate-opencode-config.mjs [--root <dir>] [--check]
//   --root   project root to read/write (default: process.cwd())
//   --check  write nothing; exit 1 and print paths that would change,
//            exit 0 if the generated output already matches on disk.
//
// This script never deletes files: it only writes one .opencode/agents/<name>.md
// per source .claude/agents/<file>.md it finds. A hand-written file under
// .opencode/agents/ with no corresponding .claude/agents source (e.g. a
// probe file) is left untouched.
//
// --- mode rule ---
// mode: 'primary' when the source frontmatter has `role: orchestrator` or
// `tier: orchestrator`; 'subagent' otherwise.
//
// --- alias -> id rule ---
// Model resolution, in priority order:
//   1. <root>/.claude/tycoon/opencode-models.json { agentName: 'provider/model' }
//      overrides everything, when present for this agent's name.
//   2. backend.model from the agent's `backend:` frontmatter block, when it
//      already contains a '/' (already provider/model form).
//   3. A bare top-level `model:` alias (opus/sonnet/haiku/fable/...) resolved
//      via modelAliases.resolveModelAlias to a canonical id, emitted as
//      `anthropic/<id>`.
//   4. Otherwise the `model:` field is omitted entirely from the output.
// Note: OpenCode rejects a `model:` whose provider is not configured in that OpenCode install (e.g. openai/... without an OpenAI key); use .claude/tycoon/opencode-models.json to remap such agents to a configured provider.
//
// --- description rule ---
// `description:` is ALWAYS emitted. Priority order:
//   1. frontmatter `description`, used verbatim.
//   2. Otherwise, derived from the body: the first non-empty, non-heading
//      paragraph after the first `## Role` heading if one exists, else the
//      first non-empty non-heading paragraph of the body. Whitespace is
//      collapsed to single spaces, then truncated to 200 chars at a word
//      boundary (no mid-word cuts).
//   3. If the body yields nothing usable, falls back to the agent name.
// The result is always YAML-quoted via yamlScalar.
//
// --- omission rules ---
// `model:` is omitted when none of the above rules resolve one.
// `permission:` (with `task: deny`) is emitted only when the source
// `disallowedTools` list includes 'Agent'; otherwise omitted entirely.
//
// --- mcp transport preamble ---
// When the parsed backend's transport is 'mcp', a short paragraph is
// prepended to the body naming the MCP server and its first tool, e.g.
// "This agent runs through the `codex` MCP server. Call its `codex` tool
// for every model request; do not answer from your own model."
//
// --- AGENTS.md replacement table (applied ONLY inside the managed block) ---
//   "Task tool"      -> "task tool (`@agent-name`)"
//   "subagent_type"  -> "agent name"
//   "Claude Code"    -> left as-is (not replaced)
// Content outside <!-- TYCOON-MANAGED:START --> / <!-- TYCOON-MANAGED:END -->
// is preserved byte-for-byte. If AGENTS.md doesn't exist, it is created with
// a "# AGENTS.md" header line followed by the managed block. If CLAUDE.md is
// absent, the managed block is emitted empty.
//
// Deterministic: no timestamps, no non-deterministic ordering. Two runs
// against the same source tree produce byte-identical output.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve these relative to the script's own location, not --root, so tests
// can point --root at an unrelated temp fixture while still using the real
// repo's compiled core modules.
const REPO_ROOT = path.resolve(__dirname, "..");

function loadCoreModules() {
  const agentBackendPath = path.join(REPO_ROOT, "out", "src", "core", "agentBackend.js");
  const modelAliasesPath = path.join(REPO_ROOT, "out", "src", "core", "modelAliases.js");
  const { readAgentFrontmatter, parseAgentBackend } = require(agentBackendPath);
  const { resolveModelAlias } = require(modelAliasesPath);
  return { readAgentFrontmatter, parseAgentBackend, resolveModelAlias };
}

// require() shim for an ESM entrypoint.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  let root = process.cwd();
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      root = argv[++i];
    } else if (arg === "--check") {
      check = true;
    }
  }
  return { root: path.resolve(root), check };
}

function yamlScalar(value) {
  const s = String(value);
  if (s.includes(":") || s.includes("#")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function stripFrontmatter(mdText) {
  const fmMatch = mdText.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (!fmMatch) return mdText;
  return mdText.slice(fmMatch[0].length);
}

function loadModelOverrides(root) {
  const overridesPath = path.join(root, ".claude", "tycoon", "opencode-models.json");
  if (!fs.existsSync(overridesPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(overridesPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function resolveModel({ agentName, frontmatter, backend, overrides, resolveModelAlias }) {
  if (Object.prototype.hasOwnProperty.call(overrides, agentName)) {
    return overrides[agentName];
  }
  const hasExplicitBackendBlock =
    frontmatter["backend"] !== undefined && frontmatter["backend"] !== null;
  if (hasExplicitBackendBlock && backend && typeof backend.model === "string" && backend.model.includes("/")) {
    return backend.model;
  }
  const rawModel = typeof frontmatter["model"] === "string" ? frontmatter["model"] : undefined;
  if (rawModel) {
    const resolved = resolveModelAlias(rawModel);
    if (resolved) {
      return `anthropic/${resolved}`;
    }
  }
  return undefined;
}

function truncateAtWordBoundary(text, maxLen) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

function deriveDescription({ agentName, body }) {
  const lines = body.split("\n");

  const isHeading = (line) => /^\s*#{1,6}\s/.test(line);

  // Find the search start: right after the first "## Role" heading, if any.
  let startIdx = 0;
  const roleIdx = lines.findIndex((line) => /^##\s+Role\s*$/i.test(line.trim()));
  if (roleIdx !== -1) {
    startIdx = roleIdx + 1;
  }

  // Collect the first paragraph (consecutive non-empty, non-heading lines)
  // starting from startIdx, skipping any leading blank lines.
  let i = startIdx;
  while (i < lines.length && lines[i].trim() === "") i++;
  const paraLines = [];
  while (i < lines.length && lines[i].trim() !== "" && !isHeading(lines[i])) {
    paraLines.push(lines[i]);
    i++;
  }

  let paragraph = paraLines.join(" ").trim();
  if (!paragraph && roleIdx !== -1) {
    // No usable paragraph right after ## Role; fall back to the first
    // non-empty, non-heading paragraph anywhere in the body.
    let j = 0;
    while (j < lines.length) {
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && isHeading(lines[j])) {
        j++;
        continue;
      }
      const fallbackPara = [];
      while (j < lines.length && lines[j].trim() !== "" && !isHeading(lines[j])) {
        fallbackPara.push(lines[j]);
        j++;
      }
      if (fallbackPara.length > 0) {
        paragraph = fallbackPara.join(" ").trim();
        break;
      }
    }
  }

  const collapsed = paragraph.replace(/\s+/g, " ").trim();
  if (!collapsed) return agentName;
  return truncateAtWordBoundary(collapsed, 200);
}

function buildAgentDoc({ agentName, frontmatter, backend, model, body }) {
  const mode =
    frontmatter["role"] === "orchestrator" || frontmatter["tier"] === "orchestrator"
      ? "primary"
      : "subagent";

  const lines = [];
  const description =
    typeof frontmatter["description"] === "string" && frontmatter["description"] !== ""
      ? frontmatter["description"]
      : deriveDescription({ agentName, body });
  lines.push(`description: ${yamlScalar(description)}`);
  lines.push(`mode: ${yamlScalar(mode)}`);
  if (model) {
    lines.push(`model: ${yamlScalar(model)}`);
  }

  const disallowed = frontmatter["disallowedTools"];
  let disallowedList = [];
  if (Array.isArray(disallowed)) {
    disallowedList = disallowed;
  } else if (typeof disallowed === "string") {
    // readAgentFrontmatter's top-level parser leaves bracketed/plain scalars
    // as raw strings (e.g. "[Agent]" or "Agent"), unlike its `backend:`
    // sub-block parser which calls parseScalarOrList. Normalize the same way
    // here: strip brackets/quotes, then split on commas.
    const inner = disallowed.trim().replace(/^\[/, "").replace(/\]$/, "");
    disallowedList = inner
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter((s) => s !== "");
  }
  const denyTask = disallowedList.includes("Agent");
  if (denyTask) {
    lines.push("permission:");
    lines.push("  task: deny");
  }

  let finalBody = body;
  if (backend && backend.transport === "mcp") {
    const server = backend.mcpServer || "unknown";
    const tool = Array.isArray(backend.tools) && backend.tools.length > 0 ? backend.tools[0] : "unknown";
    const preamble = `This agent runs through the \`${server}\` MCP server. Call its \`${tool}\` tool for every model request; do not answer from your own model.\n\n`;
    finalBody = preamble + finalBody.replace(/^\n+/, "");
  }

  let out = "---\n" + lines.join("\n") + "\n---\n";
  // Ensure exactly one blank line, then body, then a single trailing newline.
  const trimmedBody = finalBody.replace(/^\n+/, "").replace(/\s+$/, "");
  out += "\n" + trimmedBody + "\n";
  return out;
}

function buildAgentsMd(root) {
  const claudeMdPath = path.join(root, "CLAUDE.md");
  let claudeContent = "";
  if (fs.existsSync(claudeMdPath)) {
    claudeContent = fs.readFileSync(claudeMdPath, "utf8");
  }

  let managedContent = claudeContent
    .split("Task tool")
    .join("task tool (`@agent-name`)")
    .split("subagent_type")
    .join("agent name");

  const startMarker = "<!-- TYCOON-MANAGED:START -->";
  const endMarker = "<!-- TYCOON-MANAGED:END -->";

  const agentsMdPath = path.join(root, "AGENTS.md");
  let existing = "";
  if (fs.existsSync(agentsMdPath)) {
    existing = fs.readFileSync(agentsMdPath, "utf8");
  }

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  const managedBlock = `${startMarker}\n${managedContent}${managedContent.endsWith("\n") || managedContent === "" ? "" : "\n"}${endMarker}`;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + endMarker.length);
    return before + managedBlock + after;
  }

  // No existing markers: create the file with a header, or append the block
  // to whatever content already exists (preserved byte-for-byte).
  if (existing === "") {
    return "# AGENTS.md\n\n" + managedBlock + "\n";
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + managedBlock + "\n";
}

function main() {
  const { root, check } = parseArgs(process.argv.slice(2));
  const { readAgentFrontmatter, parseAgentBackend, resolveModelAlias } = loadCoreModules();

  const agentsDir = path.join(root, ".claude", "agents");
  const outDir = path.join(root, ".opencode", "agents");
  const overrides = loadModelOverrides(root);

  const changed = [];
  const writes = [];

  if (fs.existsSync(agentsDir)) {
    const files = fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    for (const file of files) {
      const srcPath = path.join(agentsDir, file);
      const mdText = fs.readFileSync(srcPath, "utf8");
      const frontmatter = readAgentFrontmatter(mdText);
      const body = stripFrontmatter(mdText);

      let backend;
      try {
        backend = parseAgentBackend(frontmatter);
      } catch {
        backend = undefined;
      }

      const agentName =
        typeof frontmatter["name"] === "string" && frontmatter["name"]
          ? frontmatter["name"]
          : path.basename(file, ".md");

      const model = resolveModel({ agentName, frontmatter, backend, overrides, resolveModelAlias });

      const doc = buildAgentDoc({ agentName, frontmatter, backend, model, body });
      const destPath = path.join(outDir, `${agentName}.md`);
      writes.push({ destPath, content: doc });
    }
  }

  // AGENTS.md
  const agentsMdPath = path.join(root, "AGENTS.md");
  const agentsMdContent = buildAgentsMd(root);
  writes.push({ destPath: agentsMdPath, content: agentsMdContent });

  for (const { destPath, content } of writes) {
    const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, "utf8") : null;
    if (existing !== content) {
      changed.push(destPath);
      if (!check) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content, "utf8");
      }
    }
  }

  if (check) {
    if (changed.length > 0) {
      for (const p of changed) {
        console.log(path.relative(root, p));
      }
      process.exit(1);
    }
    process.exit(0);
  } else {
    for (const p of changed) {
      console.log(`wrote ${path.relative(root, p)}`);
    }
  }
}

main();
