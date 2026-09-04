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
//   1. .claude/tycoon/routing.json (the routing profile, see
//      docs/ROUTING-PROFILE.md and src/core/routingProfile.js) — for any
//      agent it covers, resolveAgentSlot(profile, name) wins outright,
//      overriding both opencode-models.json and frontmatter for that agent.
//      A slot with transport: 'mcp' also overrides the MCP preamble source
//      (see below), even if the agent's own frontmatter has no backend
//      block. If routing.json is present but invalid, every error is
//      printed and the script exits 2 without writing anything — it never
//      generates output from a broken profile.
//   2. <root>/.claude/tycoon/opencode-models.json { agentName: 'provider/model' }
//      — DEPRECATED, retained only as a manual escape hatch for agents the
//      routing profile doesn't cover. When opencode-models.json exists and
//      routing.json does not, a one-line deprecation notice is printed
//      suggesting `--migrate-models`, which seeds a routing.json from it
//      (agents map with `model` only) and then continues the run.
//   3. backend.model from the agent's `backend:` frontmatter block, when it
//      already contains a '/' (already provider/model form).
//   4. A bare top-level `model:` alias (opus/sonnet/haiku/fable/...) resolved
//      via modelAliases.resolveModelAlias to a canonical id, emitted as
//      `anthropic/<id>`.
//   5. Otherwise the `model:` field is omitted entirely from the output.
// Note: OpenCode rejects a `model:` whose provider is not configured in that OpenCode install (e.g. openai/... without an OpenAI key); use .claude/tycoon/routing.json (or the deprecated opencode-models.json) to remap such agents to a configured provider.
//
// --- orchestrator mode:primary model (routing.json only) ---
// If routing.json's top-level `orchestrator.model` resolves, it is not
// applied to individual agent files (mode:primary is still driven by each
// agent's own role/tier frontmatter, unchanged) — it is recorded in
// .opencode/tycoon-routing.generated.json's `orchestrator.model` field for
// the OpenCode plugin to consume.
//
// --- fallback chains (recorded, not executed here — see p15) ---
// A routing.json slot's `fallback` array is not executed by this generator
// (fallback *execution* is p15's job). Each covered agent's resolved model
// and fallback chain (as provider/model strings, in order) are written to
// <root>/.opencode/tycoon-routing.generated.json as
// { agents: { <name>: { model, fallback: [...] } }, orchestrator: { model } },
// deterministically, so the OpenCode plugin can read fallback chains later.
// This file participates in --check like every other generated artifact.
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
  const routingProfilePath = path.join(REPO_ROOT, "out", "src", "core", "routingProfile.js");
  const { readAgentFrontmatter, parseAgentBackend } = require(agentBackendPath);
  const { resolveModelAlias } = require(modelAliasesPath);
  const { loadRoutingProfile, resolveAgentSlot, resolveOrchestratorSlot, routingSlotToBackend } = require(routingProfilePath);
  return { readAgentFrontmatter, parseAgentBackend, resolveModelAlias, loadRoutingProfile, resolveAgentSlot, resolveOrchestratorSlot, routingSlotToBackend };
}

// Resolve a RoutingSlot's `model` field (provider/model or bare alias) to
// the same 'provider/model' string form the rest of the generator expects.
function resolveSlotModel(slot, resolveModelAlias) {
  if (!slot || typeof slot.model !== "string" || slot.model === "") return undefined;
  if (slot.model.includes("/")) return slot.model;
  const resolved = resolveModelAlias(slot.model);
  return resolved ? `anthropic/${resolved}` : undefined;
}

// require() shim for an ESM entrypoint.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  let root = process.cwd();
  let check = false;
  let migrateModels = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      root = argv[++i];
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--migrate-models") {
      migrateModels = true;
    }
  }
  return { root: path.resolve(root), check, migrateModels };
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

function resolveModel({ agentName, frontmatter, backend, overrides, resolveModelAlias, slotModel }) {
  if (slotModel) {
    return slotModel;
  }
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

function migrateModelsToRoutingProfile(root, overrides) {
  const routingPath = path.join(root, ".claude", "tycoon", "routing.json");
  const agents = {};
  for (const [name, model] of Object.entries(overrides)) {
    agents[name] = { model };
  }
  const profile = { version: 1, agents };
  fs.mkdirSync(path.dirname(routingPath), { recursive: true });
  fs.writeFileSync(routingPath, JSON.stringify(profile, null, 2) + "\n", "utf8");
  return routingPath;
}

function main() {
  const { root, check, migrateModels } = parseArgs(process.argv.slice(2));
  const {
    readAgentFrontmatter,
    parseAgentBackend,
    resolveModelAlias,
    loadRoutingProfile,
    resolveAgentSlot,
    resolveOrchestratorSlot,
    routingSlotToBackend,
  } = loadCoreModules();

  const agentsDir = path.join(root, ".claude", "agents");
  const outDir = path.join(root, ".opencode", "agents");
  const overrides = loadModelOverrides(root);
  const overridesPath = path.join(root, ".claude", "tycoon", "opencode-models.json");
  const routingJsonPath = path.join(root, ".claude", "tycoon", "routing.json");

  if (migrateModels && !fs.existsSync(routingJsonPath)) {
    const written = migrateModelsToRoutingProfile(root, overrides);
    console.log(`--migrate-models: wrote ${path.relative(root, written)} seeded from ${path.relative(root, overridesPath)}`);
  } else if (fs.existsSync(overridesPath) && !fs.existsSync(routingJsonPath)) {
    console.log(
      "deprecation notice: .claude/tycoon/opencode-models.json is deprecated in favor of .claude/tycoon/routing.json; run with --migrate-models to generate one automatically."
    );
  }

  const { profile: routingProfile, errors: routingErrors } = loadRoutingProfile(root);
  if (routingErrors.length > 0) {
    for (const err of routingErrors) {
      console.error(err);
    }
    process.exit(2);
  }

  const changed = [];
  const writes = [];
  const generatedRouting = { agents: {} };

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

      const slot = resolveAgentSlot(routingProfile, agentName);
      const slotModel = resolveSlotModel(slot, resolveModelAlias);

      const model = resolveModel({ agentName, frontmatter, backend, overrides, resolveModelAlias, slotModel });

      // A routing-profile slot wins over frontmatter's backend for MCP
      // preamble purposes too, so an agent moved to MCP transport purely via
      // routing.json still gets the preamble.
      const effectiveBackend = slot && slot.transport ? routingSlotToBackend(slot) : backend;

      const doc = buildAgentDoc({ agentName, frontmatter, backend: effectiveBackend, model, body });
      const destPath = path.join(outDir, `${agentName}.md`);
      writes.push({ destPath, content: doc });

      if (slot) {
        const entry = {};
        if (slotModel) entry.model = slotModel;
        if (Array.isArray(slot.fallback) && slot.fallback.length > 0) {
          entry.fallback = slot.fallback.map((fb) => resolveSlotModel(fb, resolveModelAlias)).filter(Boolean);
        }
        if (Object.keys(entry).length > 0) {
          generatedRouting.agents[agentName] = entry;
        }
      }
    }
  }

  const orchestratorSlot = resolveOrchestratorSlot(routingProfile);
  if (orchestratorSlot) {
    const orchestratorModel = resolveSlotModel(orchestratorSlot, resolveModelAlias);
    if (orchestratorModel) {
      generatedRouting.orchestrator = { model: orchestratorModel };
    }
  }

  // AGENTS.md
  const agentsMdPath = path.join(root, "AGENTS.md");
  const agentsMdContent = buildAgentsMd(root);
  writes.push({ destPath: agentsMdPath, content: agentsMdContent });

  // tycoon-routing.generated.json: written whenever the routing profile
  // resolved at least one agent/orchestrator entry, for the OpenCode plugin
  // (p15) to read fallback chains from later. Deterministic key ordering
  // via JSON.stringify's insertion order (agents inserted in the same
  // sorted-file-list order as everything else).
  if (Object.keys(generatedRouting.agents).length > 0 || generatedRouting.orchestrator) {
    const generatedRoutingPath = path.join(root, ".opencode", "tycoon-routing.generated.json");
    writes.push({ destPath: generatedRoutingPath, content: JSON.stringify(generatedRouting, null, 2) + "\n" });
  }

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
