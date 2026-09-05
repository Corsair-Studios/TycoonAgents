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
//
// --- opencode.json provider merge (p13-t5) ---
// For every distinct `transport: "openai-compatible"` vendor across the
// resolved slots (per-agent slots, the orchestrator slot, and every entry
// in each slot's `fallback` chain), a provider entry is merged into
// <root>/opencode.json: { provider: { <vendor>: { npm, name, options: {
// baseURL, apiKey? }, models: { <model>: { name } }, tycoonManaged: true } } }.
// `models` accumulates every model routed to that vendor (primary + all
// fallback entries). baseURL/apiKey are ALWAYS `{env:<VAR>}` placeholders —
// never a literal URL or key value — using OpenCode's documented env-var
// substitution syntax.
//
// Verified against OpenCode 1.18.27's published config JSON schema
// (https://opencode.ai/config.json, fetched 2026-09-04) and its config docs
// (https://opencode.ai/docs/config/, fetched 2026-09-04): the schema's
// `provider.<id>` shape accepts `npm` (string), `name` (string), `options`
// (object, with `baseURL`/`apiKey` string fields used by the
// openai-compatible npm package), and `models` (object keyed by model id,
// each allowing at least `name`). The docs state configs are "merged
// together, not replaced" and that "Project config has the highest
// precedence among standard config files — it overrides both global and
// remote configs" (a key present in BOTH is taken from the project file; a
// key present only in global survives). The docs also document a
// `{file:path/to/file}` substitution — "Use {file:path/to/file} to
// substitute the contents of a file", with a worked
// `apiKey: "{file:~/.secrets/openai-key}"` example — alongside the existing
// `{env:VARIABLE_NAME}` form.
//
// p13-t6 DECISION (user, 2026-09-04): an endpoint URL / API key entered in
// the Routing screen is stored per-user, outside any project (see
// src/core/localEnvStore.ts), so git can never see it. Consequently this
// script now writes TWO opencode.json files:
//   1. PROJECT <root>/opencode.json — the managed provider entry carries
//      ONLY `npm`/`name`/`models` (no `options` at all). This file is
//      git-tracked, so it must never carry a path or a literal secret, and
//      per the merge rule above, omitting `options` here means the
//      project file cannot override whatever `options` the global file
//      sets for the same provider id.
//   2. GLOBAL <resolveGlobalOpencodeConfigDir()>/opencode.json (normally
//      ~/.config/opencode/opencode.json, %APPDATA%/opencode/opencode.json
//      on win32, overridable via OPENCODE_CONFIG_DIR — mirrors the
//      discovery ladder in src/providers/opencode/discovery.ts) — the
//      SAME managed provider entry, but WITH `options`: baseURL is
//      `{file:<store path>}` when localEnvStore has a stored value for
//      `endpointEnv`, else `{env:<endpointEnv>}`; apiKey follows the same
//      rule for `credentialEnv`. Never a literal URL or key value.
//
// Merge rules (both files): may already contain user-authored content,
// preserved byte-for-byte outside the provider entries this script owns.
// Each managed entry carries `"tycoonManaged": true` so re-runs replace only
// entries we wrote; an existing same-id provider entry WITHOUT that marker
// is left untouched and a warning is printed. When a previously-managed
// vendor no longer appears in the resolved profile, its entry is removed.
// If a file doesn't exist, it's created with
// `"$schema": "https://opencode.ai/config.json"`. Output uses sorted keys
// for determinism and participates in --check like every other artifact
// (a global-file diff is reported the same way as a project-file diff).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

// Appended after the translated CLAUDE.md content, inside the managed block.
// Written for an OpenCode-native orchestrator model that has no Claude
// backing and no guarantee CLAUDE.md was ever loaded — it must stand alone.
const OPENCODE_ENFORCEMENT_DOCTRINE = `
## OpenCode enforcement doctrine

The \`tycoon-opencode-plugin\` hook enforces four rules at runtime, independent
of whether you (the orchestrator model) recall the delegation rules above.

1. **Direct-tool nudge.** If you call Grep, Glob, Edit, or Write yourself, or
   Read more than 2 files in one turn, the plugin logs a compliance message
   to \`activity.jsonl\`, visible in the delegation panel, AND delivers that
   same message into your own system prompt on your next turn — you will see
   a line starting \`[TycoonAgents delegation nudge]\`. Do not wait for it:
   never make those direct calls in the first place; route them via the task
   tool to the right specialist.
2. **Keyword agent routing.** Agent selection for a task tool call follows
   \`.claude/tycoon/agent-keywords.json\` in this priority order: an explicit
   agent name in your call wins outright; otherwise the task text is matched
   against each agent's keyword list; if nothing matches, route to the
   configured \`fallback_agent\`. Never invent an agent name — pick one that
   exists in \`.opencode/agents/\`.
3. **Single-pass review gate.** After a specialist finishes a task, route the
   diff to \`uefn-auditor\` once. If it requests changes, send them back to the
   original specialist for one fix round, then re-review once. After that one
   round, report the outcome — do not loop further reviews.
4. **Leaf workers never spawn.** Any agent invoked via the task tool is a
   leaf: it must do its assigned work with its own tools and must not call
   the task tool itself. The plugin structurally blocks a leaf's recursive
   task call — the call is aborted and you will see its error output:
   "Blocked: you are a leaf worker — workers do not spawn sub-agents. Do the
   work yourself with your own tools, chunked into bounded sequential calls
   if it is long (see your brief). This block is structural (TycoonAgents
   leaf-worker rule)." If you are a spawned agent and see that message, stop
   trying to delegate and finish the task directly — retrying the task tool
   will fail the same way every time.
`;

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

  if (managedContent !== "" && !managedContent.endsWith("\n")) {
    managedContent += "\n";
  }
  managedContent += OPENCODE_ENFORCEMENT_DOCTRINE;

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

const OPENAI_COMPATIBLE_NPM_PACKAGE = "@ai-sdk/openai-compatible";

// Walk every resolved slot (agent slots, orchestrator slot, and each slot's
// fallback chain, recursively) and collect one entry per distinct
// `transport: "openai-compatible"` vendor. `slot.model` is expected in
// "<vendor>/<modelId>" form (matching the rest of routing.json's
// convention, e.g. "moonshot/kimi-k2"); the vendor prefix is stripped to
// get the bare model id used as the opencode.json models-map key.
function collectOpenAICompatibleVendors(profile) {
  const vendors = new Map();

  function consider(slot) {
    if (!slot) return;

    if (slot.transport === "openai-compatible" && slot.vendor && typeof slot.model === "string" && slot.model !== "") {
      const modelId = slot.model.startsWith(`${slot.vendor}/`)
        ? slot.model.slice(slot.vendor.length + 1)
        : slot.model;

      let entry = vendors.get(slot.vendor);
      if (!entry) {
        entry = { models: new Set(), endpointEnv: undefined, credentialEnv: undefined };
        vendors.set(slot.vendor, entry);
      }
      if (slot.endpointEnv && !entry.endpointEnv) entry.endpointEnv = slot.endpointEnv;
      if (slot.credentialEnv && !entry.credentialEnv) entry.credentialEnv = slot.credentialEnv;
      entry.models.add(modelId);
    }

    // Walk the fallback chain regardless of the parent slot's own
    // transport — a claude-native primary can still fall back to an
    // openai-compatible vendor.
    if (Array.isArray(slot.fallback)) {
      for (const fb of slot.fallback) consider(fb);
    }
  }

  if (profile) {
    for (const agentId of Object.keys(profile.agents || {}).sort()) {
      consider(profile.agents[agentId]);
    }
    if (profile.orchestrator) consider(profile.orchestrator);
  }

  return vendors;
}

// Deterministic JSON serialization: object keys sorted recursively so two
// runs over logically-identical data produce byte-identical output
// regardless of insertion order (arrays keep their order).
function canonicalStringify(value, indent = 0) {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => padInner + canonicalStringify(v, indent + 1));
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  const lines = keys.map((k) => `${padInner}${JSON.stringify(k)}: ${canonicalStringify(value[k], indent + 1)}`);
  return "{\n" + lines.join(",\n") + "\n" + pad + "}";
}

// Build the merged opencode.json content (as a string, or null when nothing
// needs to change and no file needs to be created). Prints a warning to
// stderr for every same-id provider entry that already exists in the file
// without our `tycoonManaged` marker; such entries are left untouched.
function buildOpencodeJson(root, computedVendors) {
  const opencodeJsonPath = path.join(root, "opencode.json");
  let existing = null;
  if (fs.existsSync(opencodeJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(opencodeJsonPath, "utf8"));
    } catch (err) {
      console.error(`opencode.json: failed to parse existing file, leaving it untouched: ${err.message}`);
      return null;
    }
  }

  if (existing === null && computedVendors.size === 0) {
    return null;
  }

  const config = existing && typeof existing === "object" ? { ...existing } : {};
  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }
  const provider = config["provider"] && typeof config["provider"] === "object" ? { ...config["provider"] } : {};

  const computedVendorIds = new Set(computedVendors.keys());

  // Remove managed entries whose vendor no longer appears in the profile.
  for (const key of Object.keys(provider)) {
    if (provider[key] && provider[key]["tycoonManaged"] === true && !computedVendorIds.has(key)) {
      delete provider[key];
    }
  }

  for (const [vendor, entry] of computedVendors) {
    const existingEntry = provider[vendor];
    if (existingEntry && existingEntry["tycoonManaged"] !== true) {
      console.warn(
        `opencode.json: provider "${vendor}" already exists without a tycoonManaged marker; leaving it untouched (routing.json also wants to manage this vendor id).`
      );
      continue;
    }

    const models = {};
    for (const modelId of [...entry.models].sort()) {
      models[modelId] = { name: modelId };
    }

    // PROJECT file: no `options` at all (p13-t6) — endpoint URLs/API keys
    // never land in a git-tracked file. The global file (see
    // buildGlobalOpencodeJson below) carries the `options` for this same
    // provider id.
    provider[vendor] = {
      npm: OPENAI_COMPATIBLE_NPM_PACKAGE,
      name: vendor,
      models,
      tycoonManaged: true,
    };
  }

  if (Object.keys(provider).length > 0) {
    config["provider"] = provider;
  } else {
    delete config["provider"];
  }

  return canonicalStringify(config) + "\n";
}

// ---------------------------------------------------------------------------
// Global opencode.json (p13-t6): the managed provider entry's `options`
// (baseURL/apiKey) live HERE, never in the project file. Resolution order
// per option, matching the localEnvStore contract (src/core/localEnvStore.ts):
// a per-user stored value (entered in the Routing screen) wins as a
// `{file:<store path>}` reference; otherwise falls back to the existing
// `{env:<NAME>}` placeholder.
// ---------------------------------------------------------------------------

/**
 * Resolve the global OpenCode config directory. OPENCODE_CONFIG_DIR always
 * wins (matches src/providers/opencode/discovery.ts's override, and
 * scripts/apply-routing-profile.mjs's convention of accepting the same
 * override names project-wide). Otherwise: ~/.config/opencode on
 * mac/linux, %APPDATA%/opencode on win32 (falling back to ~/.config/opencode
 * if APPDATA is unset) — the documented global location
 * (https://opencode.ai/docs/config/: "Place your global OpenCode config in
 * ~/.config/opencode/opencode.json"). Unlike discovery.ts's
 * candidateConfigDirs(), this does NOT probe <projectDir>/.opencode or
 * require the directory to already exist — a project-local dir is not the
 * GLOBAL config, and this generator must be able to create the global dir
 * on first run.
 */
function resolveGlobalOpencodeConfigDir(env, platform) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "opencode");
  }
  return path.join(home, ".config", "opencode");
}

// Best-effort load of the compiled localEnvStore (src/core/localEnvStore.ts
// -> out/src/core/localEnvStore.js). Fail-open: a missing/unbuilt module
// just means every option falls back to `{env:...}` — this script must
// never crash because the extension hasn't been compiled in this checkout.
function tryLoadLocalEnvStore() {
  const candidate = path.join(REPO_ROOT, "out", "src", "core", "localEnvStore.js");
  try {
    if (fs.existsSync(candidate)) return require(candidate);
  } catch {
    // fall through
  }
  return undefined;
}

function optionValueFor(envName, localEnvStore) {
  if (!envName) return undefined;
  try {
    if (localEnvStore && typeof localEnvStore.hasValue === "function" && localEnvStore.hasValue(envName)) {
      const p = localEnvStore.filePath(envName);
      if (p) return `{file:${p}}`;
    }
  } catch {
    // fail-open to the {env:...} form below
  }
  return `{env:${envName}}`;
}

/**
 * Build the merged GLOBAL opencode.json content (string), or null when
 * nothing needs to change and no file needs to be created. Same
 * tycoonManaged marker/merge/removal rules as buildOpencodeJson(), but
 * writes `options` (baseURL/apiKey) using optionValueFor()'s
 * {file:...}-over-{env:...} rule.
 */
function buildGlobalOpencodeJson(globalConfigPath, computedVendors, localEnvStore) {
  let existing = null;
  if (fs.existsSync(globalConfigPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(globalConfigPath, "utf8"));
    } catch (err) {
      console.error(`${globalConfigPath}: failed to parse existing file, leaving it untouched: ${err.message}`);
      return null;
    }
  }

  if (existing === null && computedVendors.size === 0) {
    return null;
  }

  const config = existing && typeof existing === "object" ? { ...existing } : {};
  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }
  const provider = config["provider"] && typeof config["provider"] === "object" ? { ...config["provider"] } : {};

  const computedVendorIds = new Set(computedVendors.keys());
  for (const key of Object.keys(provider)) {
    if (provider[key] && provider[key]["tycoonManaged"] === true && !computedVendorIds.has(key)) {
      delete provider[key];
    }
  }

  for (const [vendor, entry] of computedVendors) {
    const existingEntry = provider[vendor];
    if (existingEntry && existingEntry["tycoonManaged"] !== true) {
      console.warn(
        `${globalConfigPath}: provider "${vendor}" already exists without a tycoonManaged marker; leaving it untouched (routing.json also wants to manage this vendor id).`
      );
      continue;
    }

    const models = {};
    for (const modelId of [...entry.models].sort()) {
      models[modelId] = { name: modelId };
    }

    const options = {};
    if (entry.endpointEnv) options.baseURL = optionValueFor(entry.endpointEnv, localEnvStore);
    if (entry.credentialEnv) options.apiKey = optionValueFor(entry.credentialEnv, localEnvStore);

    provider[vendor] = {
      npm: OPENAI_COMPATIBLE_NPM_PACKAGE,
      name: vendor,
      options,
      models,
      tycoonManaged: true,
    };
  }

  if (Object.keys(provider).length > 0) {
    config["provider"] = provider;
  } else {
    delete config["provider"];
  }

  return canonicalStringify(config) + "\n";
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

  // opencode.json: merge in a provider entry for every distinct
  // openai-compatible vendor across the resolved profile (agents,
  // orchestrator, fallback chains). See the module header comment above
  // ("opencode.json provider merge (p13-t5)").
  const computedVendors = collectOpenAICompatibleVendors(routingProfile);
  const opencodeJsonContent = buildOpencodeJson(root, computedVendors);
  if (opencodeJsonContent !== null) {
    writes.push({ destPath: path.join(root, "opencode.json"), content: opencodeJsonContent });
  }

  // GLOBAL opencode.json (p13-t6): same computed vendors, but with
  // `options` (baseURL/apiKey), written to the per-user OpenCode config
  // dir rather than the project — see buildGlobalOpencodeJson()'s header.
  const globalConfigDir = resolveGlobalOpencodeConfigDir(process.env, process.platform);
  const globalConfigPath = path.join(globalConfigDir, "opencode.json");
  const localEnvStoreModule = tryLoadLocalEnvStore();
  const globalOpencodeJsonContent = buildGlobalOpencodeJson(globalConfigPath, computedVendors, localEnvStoreModule);
  if (globalOpencodeJsonContent !== null) {
    writes.push({ destPath: globalConfigPath, content: globalOpencodeJsonContent, isGlobal: true });
  }

  const isGlobalPath = new Set();
  for (const { destPath, content, isGlobal } of writes) {
    const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, "utf8") : null;
    if (isGlobal) isGlobalPath.add(destPath);
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
        console.log(isGlobalPath.has(p) ? p : path.relative(root, p));
      }
      process.exit(1);
    }
    process.exit(0);
  } else {
    for (const p of changed) {
      console.log(`wrote ${isGlobalPath.has(p) ? p : path.relative(root, p)}`);
    }
  }
}

main();
