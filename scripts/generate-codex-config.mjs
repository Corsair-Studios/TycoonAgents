#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Plan p23-t3: Codex-specific roster config generation.
//
// Reads the same .claude/agents/*.md roster used by
// scripts/generate-opencode-config.mjs and produces two Codex-facing
// outputs, deterministic and idempotent:
//
//   1. AGENTS.md's `<!-- TYCOON-CODEX-MANAGED:START -->` / `...:END` block —
//      instructions for a Codex orchestrator: it is the orchestrator; for
//      each roster specialist it must call the `tycoon` MCP server's
//      `delegate` tool ({specialist, task, description}) instead of
//      spawning native agents for non-OpenAI vendors; OpenAI-vendor
//      specialists (vendor: openai) may run natively; explicit names beat
//      keywords; workers are leaves and must not delegate; the orchestrator
//      never edits/greps directly. This is a NEW block, placed after the
//      existing `<!-- TYCOON-MANAGED:END -->` marker
//      scripts/generate-opencode-config.mjs owns — that block, and
//      everything else in AGENTS.md, is left byte-for-byte untouched.
//
//   2. `.claude/tycoon/codex-agents.toml.generated` — a Codex `[agents]`
//      config fragment (NOT written into CODEX_HOME by this script; an
//      installer consumes it separately). Contains `max_depth = 1` and one
//      `[agents.<id>]` table per roster specialist with a `description`,
//      and `model` only when the agent's vendor is openai (else a comment
//      noting it is dispatched via `tycoon` delegate instead). A header
//      comment states these keys are MUST-VERIFY against codex-cli 0.153.0
//      (--strict-config rejects unknown keys) before an installer applies
//      this fragment for real.
//
// Roster / routing model mirrors generate-opencode-config.mjs: agent id
// comes from frontmatter `name`, else the filename stem; vendor comes from
// `backend.vendor` when present, else `anthropic` (project default);
// .claude/tycoon/routing.json is NOT consulted here (routing.json chooses
// per-run *models*, not the Codex-vs-dispatch shape this generator emits,
// which is fixed by vendor).
//
// Usage: node scripts/generate-codex-config.mjs [--root <dir>] [--check]
//   --root   project root to read/write (default: process.cwd())
//   --check  write nothing; exit 1 and print paths that would change,
//            exit 0 if generated output already matches on disk.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CODEX_START_MARKER = "<!-- TYCOON-CODEX-MANAGED:START -->";
const CODEX_END_MARKER = "<!-- TYCOON-CODEX-MANAGED:END -->";
const OPENCODE_END_MARKER = "<!-- TYCOON-MANAGED:END -->";

function parseArgs(argv) {
  let root = process.cwd();
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") root = argv[++i];
    else if (arg === "--check") check = true;
  }
  return { root: path.resolve(root), check };
}

function stripFrontmatter(mdText) {
  const fmMatch = mdText.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (!fmMatch) return mdText;
  return mdText.slice(fmMatch[0].length);
}

// Minimal, self-contained frontmatter reader — mirrors
// src/core/agentBackend.ts's top-level-scalar behavior closely enough for
// this generator's needs (name, description, backend.vendor, backend.model)
// without depending on the compiled out/ tree, so this script also works in
// a checkout that hasn't run `npm run build` yet.
function readFrontmatter(mdText) {
  const fm = {};
  const match = mdText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return fm;
  const lines = match[1].split("\n");
  let backend = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]/.test(line)) {
      if (backend) {
        const m = line.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
        if (m) backend[m[1]] = m[2].trim();
      }
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === "backend" && value === "") {
      backend = {};
      fm.backend = backend;
    } else {
      fm[key] = value.replace(/^['"]|['"]$/g, "");
      backend = null;
    }
  }
  return fm;
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
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i < lines.length && isHeading(lines[i])) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !isHeading(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length > 0) {
      const collapsed = para.join(" ").replace(/\s+/g, " ").trim();
      if (collapsed) return truncateAtWordBoundary(collapsed, 200);
    }
  }
  return agentName;
}

function loadRoutingOverrides(routingPath) {
  if (!routingPath || !fs.existsSync(routingPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(routingPath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object"
      ? parsed.agents
      : {};
  } catch {
    return {};
  }
}

function loadAgentKeywords(root) {
  const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
  if (!fs.existsSync(keywordsPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(keywordsPath, "utf8"));
    return parsed && parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {};
  } catch {
    return {};
  }
}

/**
 * Read the roster from `<projectDir>/.claude/agents/*.md` (or `rosterDir`
 * when given) and return one entry per agent, sorted by id for determinism.
 * routingPath (default `<projectDir>/.claude/tycoon/routing.json`), when
 * present, overrides an entry's `model` for the toml fragment — see the
 * module header.
 */
function loadRoster({ projectDir, rosterDir, routingPath }) {
  const agentsDir = rosterDir || path.join(projectDir, ".claude", "agents");
  const resolvedRoutingPath =
    routingPath !== undefined ? routingPath : path.join(projectDir, ".claude", "tycoon", "routing.json");
  const routingOverrides = loadRoutingOverrides(resolvedRoutingPath);
  const keywords = loadAgentKeywords(projectDir);

  if (!fs.existsSync(agentsDir)) return [];

  const files = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const roster = [];
  for (const file of files) {
    const mdText = fs.readFileSync(path.join(agentsDir, file), "utf8");
    const frontmatter = readFrontmatter(mdText);
    const body = stripFrontmatter(mdText);

    const id = frontmatter.name || path.basename(file, ".md");
    const vendor = (frontmatter.backend && frontmatter.backend.vendor) || "anthropic";
    let model = (frontmatter.backend && frontmatter.backend.model) || frontmatter.model || undefined;
    if (Object.prototype.hasOwnProperty.call(routingOverrides, id) && routingOverrides[id]) {
      const override = routingOverrides[id];
      if (typeof override.model === "string" && override.model !== "") model = override.model;
    }
    const description =
      frontmatter.description && frontmatter.description !== "" ? frontmatter.description : deriveDescription({ agentName: id, body });
    const pattern = keywords[id] && typeof keywords[id].pattern === "string" ? keywords[id].pattern : undefined;

    roster.push({ id, vendor, model, description, pattern });
  }
  return roster;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

/** Build the `.claude/tycoon/codex-agents.toml.generated` fragment content. */
function buildAgentsToml(specialists) {
  const lines = [
    "# TycoonAgents: generated Codex [agents] config fragment (plan p23-t3).",
    "# Generated by scripts/generate-codex-config.mjs -- do not hand-edit.",
    "#",
    "# MUST-VERIFY: these keys (max_depth, max_concurrent_threads_per_session,",
    "# and per-role [agents.<id>] tables) are inferred from codex-cli config",
    "# struct strings, not a confirmed schema -- docs/codex-harness-findings.md",
    "# ~55-65. codex-cli 0.153.0's --strict-config rejects unknown keys, so an",
    "# installer must probe (e.g. `codex --strict-config` against this fragment",
    "# in isolation) before merging it into a real CODEX_HOME/config.toml. This",
    "# file is NOT written into CODEX_HOME by this script.",
    "",
    "[agents]",
    "max_depth = 1",
    "",
  ];

  for (const spec of specialists) {
    lines.push(`[agents.${spec.id}]`);
    lines.push(`description = ${tomlString(spec.description)}`);
    if (spec.vendor === "openai" && spec.model) {
      lines.push(`model = ${tomlString(spec.model)}`);
    } else {
      lines.push("# dispatched via tycoon delegate");
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

/** Build the AGENTS.md Codex-managed block body (without the surrounding markers). */
function buildAgentsMdCodexBlock(specialists) {
  const rows = specialists
    .map((s) => {
      const keywordPart = s.pattern ? s.pattern : "(fallback only)";
      const vendorPart = s.vendor === "openai" ? "openai (native)" : `${s.vendor} (delegate)`;
      return `| ${s.id} | ${s.description} | ${keywordPart} | ${vendorPart} |`;
    })
    .join("\n");

  return `
## Codex orchestrator routing (generated)

You are the Codex orchestrator for this project. You coordinate work; you do
not do it yourself. For every task, route it to a TycoonAgents specialist —
never edit, grep, or explore the codebase directly.

### Routing rule

1. An explicit specialist name in the request always wins.
2. Otherwise match the task text against each specialist's keywords below.
3. If nothing matches, use the roster's fallback agent
   (.claude/tycoon/agent-keywords.json's \`fallback_agent\`).

### How to dispatch

- **Non-OpenAI-vendor specialists** (every row below marked "delegate"): call
  the \`tycoon\` MCP server's \`delegate\` tool with
  \`{ specialist: "<id>", task: "<task text>", description: "<one-line summary>" }\`.
  Do NOT spawn a native Codex agent for these — they run on a different
  vendor's model via the dispatcher bridge. When a plan gate has been
  approved or rejected since your last \`delegate\` call, its update is
  prefixed onto that call's result text — read it before acting on the
  result.
- **OpenAI-vendor specialists** (marked "native"): may run as a native Codex
  agent instead of going through \`delegate\`.

### Roster

| id | role | keywords | vendor |
| --- | --- | --- | --- |
${rows}

### Leaf-worker rule

Every specialist you dispatch to, whether via \`delegate\` or natively, is a
leaf: it does the assigned work itself and must never call \`delegate\` or
spawn another agent. If a specialist's output tries to delegate further,
that is a violation of its brief, not a valid step.
`;
}

export function upsertCodexBlock(existingAgentsMd, blockBody) {
  const managedBlock = `${CODEX_START_MARKER}\n${blockBody.replace(/^\n+/, "").replace(/\s+$/, "")}\n${CODEX_END_MARKER}`;

  // Collapse EVERY existing START/END marker pair (not just the first) into
  // the single freshly-generated block, at the position of the first pair.
  // A duplicated marker pair can arise from a hand edit or a merge; without
  // this, the naive indexOf/indexOf below would only replace the first pair
  // and leave a second, now-orphaned Codex block sitting untouched in
  // `after`. Only the pair regions themselves are removed — any hand-written
  // text sitting between two stale pairs, or anywhere else outside a
  // managed block, is never touched: AGENTS.md content outside the managed
  // block is off limits regardless of how many stale pairs surround it.
  // Matches non-greedily and globally so N pairs collapse to exactly 1.
  const pairRe = new RegExp(
    `${escapeRegExp(CODEX_START_MARKER)}[\\s\\S]*?${escapeRegExp(CODEX_END_MARKER)}`,
    "g"
  );
  const pairMatches = [...existingAgentsMd.matchAll(pairRe)];
  if (pairMatches.length > 0) {
    let result = "";
    let cursor = 0;
    let inserted = false;
    for (const m of pairMatches) {
      result += existingAgentsMd.slice(cursor, m.index);
      if (!inserted) {
        result += managedBlock;
        inserted = true;
      }
      cursor = m.index + m[0].length;
    }
    result += existingAgentsMd.slice(cursor);
    return result;
  }

  const startIdx = existingAgentsMd.indexOf(CODEX_START_MARKER);
  const endIdx = existingAgentsMd.indexOf(CODEX_END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingAgentsMd.slice(0, startIdx);
    const after = existingAgentsMd.slice(endIdx + CODEX_END_MARKER.length);
    return before + managedBlock + after;
  }

  // No existing Codex block: insert right after the opencode-managed block's
  // end marker when present (never touching that block's own content);
  // otherwise append to the end of the file.
  const opencodeEndIdx = existingAgentsMd.indexOf(OPENCODE_END_MARKER);
  if (opencodeEndIdx !== -1) {
    const insertAt = opencodeEndIdx + OPENCODE_END_MARKER.length;
    const before = existingAgentsMd.slice(0, insertAt);
    const after = existingAgentsMd.slice(insertAt);
    return before + "\n\n" + managedBlock + after;
  }

  const sep = existingAgentsMd === "" ? "" : existingAgentsMd.endsWith("\n") ? "\n" : "\n\n";
  return existingAgentsMd + sep + managedBlock + "\n";
}

/**
 * Pure entry point: given a project dir (and optional roster/routing
 * overrides), returns the generated AGENTS.md Codex block body (without
 * markers), the full toml fragment text, and the resolved roster. Does not
 * touch disk.
 */
export function generateCodexConfig({ projectDir, rosterDir, routingPath }) {
  const specialists = loadRoster({ projectDir, rosterDir, routingPath });
  const agentsMdBlock = buildAgentsMdCodexBlock(specialists);
  const agentsToml = buildAgentsToml(specialists);
  return { agentsMdBlock, agentsToml, specialists };
}

function main() {
  const { root, check } = parseArgs(process.argv.slice(2));
  const { agentsMdBlock, agentsToml } = generateCodexConfig({ projectDir: root });

  const agentsMdPath = path.join(root, "AGENTS.md");
  const existing = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, "utf8") : "";
  const newAgentsMd = upsertCodexBlock(existing, agentsMdBlock);

  const tomlPath = path.join(root, ".claude", "tycoon", "codex-agents.toml.generated");
  const existingToml = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : null;

  const writes = [
    { destPath: agentsMdPath, content: newAgentsMd, prev: existing },
    { destPath: tomlPath, content: agentsToml, prev: existingToml },
  ];

  const changed = [];
  for (const w of writes) {
    if (w.prev !== w.content) {
      changed.push(w.destPath);
      if (!check) {
        fs.mkdirSync(path.dirname(w.destPath), { recursive: true });
        fs.writeFileSync(w.destPath, w.content, "utf8");
      }
    }
  }

  if (check) {
    for (const p of changed) console.log(path.relative(root, p));
    process.exit(changed.length > 0 ? 1 : 0);
  } else {
    for (const p of changed) console.log(`wrote ${path.relative(root, p)}`);
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
