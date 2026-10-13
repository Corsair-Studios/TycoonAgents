#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Claude-frontmatter generator (companion to scripts/generate-opencode-config.mjs,
// p12-t4): writes/refreshes each .claude/agents/<id>.md's `backend:` block
// (and top-level `model:`) from the routing profile (.claude/tycoon/routing.json,
// src/core/routingProfile.js) so the profile is the single source of truth
// for both the OpenCode generator and Claude Code's own hook/panel, which
// read frontmatter via parseAgentBackend() (src/core/agentBackend.js).
//
// Usage: node scripts/apply-routing-profile.mjs [--root <dir>] [--check]
//   --root   project root to read/write (default: process.cwd())
//   --relay  Claude Code harness: a normal agent whose slot names a bridged
//            non-Anthropic provider becomes a managed relay to that provider
//            (src/core/agentRelay.ts); without it, and for any agent whose slot
//            is Anthropic again, a relayed file is reverted exactly.
//   --check  write nothing; print files that would change and exit 1,
//            or exit 0 if generated output already matches on disk.
//
// Behavior:
// - For each agent in profile.agents with a matching .claude/agents/<id>.md,
//   replace or insert the `backend:` block inside that file's YAML
//   frontmatter (fields from routingSlotToBackend(resolveAgentSlot(...))),
//   preserving every other frontmatter key and the body byte-for-byte. Also
//   set the top-level `model:` key when the slot model is a bare alias or
//   'provider/model' string (an existing top-level `model:` with any other
//   value is left as-is).
// - A `# managed-by: tycoon-routing` comment line is emitted as the first
//   line of the backend block so a later run can find/replace it.
// - Data-loss guard: when a managed block is about to overwrite an existing
//   `backend:` block that has NO managed-by marker (i.e. hand-written, such
//   as the multi-llm reviewer agents' vendor/mcpServer/tools wiring), the
//   original block's raw lines are snapshotted into
//   <root>/.claude/tycoon/routing.backup.json, keyed by agent id, alongside
//   a sha256 of the file at snapshot time. A backup entry, once recorded for
//   an agent id, is never overwritten by a later apply (a later apply only
//   ever sees the now-managed block, so there is nothing hand-written left
//   to snapshot) — this is what makes "apply twice then unapply" still
//   restore the original. On unapply (an agent dropped from the profile, or
//   the whole profile cleared), the managed block is replaced with the
//   backed-up original lines when a backup entry exists for that id, or
//   stripped outright (today's behavior) when it does not. Backup entries
//   are never deleted by this script; restoring an already-hand-written
//   block from the backup makes the file byte-identical to before the
//   overwrite, so a subsequent apply sees the same hand-written block again
//   and treats it as already backed up (a no-op). This keeps `--check` and
//   full regeneration deterministic: routing.backup.json's own diff is
//   included in `--check`'s change set like routing.resolved.json's.
// - Agents in the profile with no matching .md file are warned and skipped
//   (this script never creates agent files).
// - Files with no YAML frontmatter block at all are reported and left
//   untouched.
// - The orchestrator slot (resolveOrchestratorSlot) is applied to whichever
//   agent file's frontmatter has role: orchestrator or tier: orchestrator,
//   if any such file exists.
// - Fallback chains (RoutingSlot.fallback) are never written into
//   frontmatter (see PRD p15 — fallback execution is a later milestone).
//   Instead this script writes <root>/.claude/tycoon/routing.resolved.json:
//     { agents: { <id>: { backend: Backend, fallback?: Backend[] } }, orchestrator?: {...} }
//   for the hook to consume once fallback execution lands. This file is
//   included in --check's diff set.
// - Deterministic: no timestamps, no non-deterministic ordering. Two runs
//   against the same source tree produce byte-identical output (idempotent).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve compiled core modules relative to the script's own location, not
// --root, so tests can point --root at an unrelated temp fixture while
// still using the real repo's compiled core modules.
const REPO_ROOT = path.resolve(__dirname, "..");

function loadCoreModules() {
  const agentBackendPath = path.join(REPO_ROOT, "out", "src", "core", "agentBackend.js");
  const routingProfilePath = path.join(REPO_ROOT, "out", "src", "core", "routingProfile.js");
  const { readAgentFrontmatter } = require(agentBackendPath);
  const agentRelay = require(path.join(REPO_ROOT, "out", "src", "core", "agentRelay.js"));
  const {
    loadRoutingProfile,
    resolveAgentSlot,
    resolveOrchestratorSlot,
    routingSlotToBackend,
    hasHandWrittenBackendBlock,
  } = require(routingProfilePath);
  return {
    readAgentFrontmatter,
    loadRoutingProfile,
    resolveAgentSlot,
    resolveOrchestratorSlot,
    routingSlotToBackend,
    hasHandWrittenBackendBlock,
    agentRelay,
  };
}

function parseArgs(argv) {
  let root = process.cwd();
  let check = false;
  let relay = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      root = argv[++i];
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--relay") {
      relay = true;
    }
  }
  return { root, check, relay };
}

// Render a Backend object as an indented YAML block (2-space indent),
// matching packCatalog.ts's renderBackendBlock field order exactly, with
// the managed-by marker as the first line inside the block.
function renderBackendBlockLines(backend) {
  const lines = ["backend:", "  # managed-by: tycoon-routing"];
  lines.push(`  vendor: ${backend.vendor}`);
  lines.push(`  transport: ${backend.transport}`);
  if (backend.mcpServer) lines.push(`  mcpServer: ${backend.mcpServer}`);
  if (backend.tools && backend.tools.length > 0) lines.push(`  tools: [${backend.tools.join(", ")}]`);
  lines.push(`  model: ${backend.model}`);
  lines.push(`  costModelClass: ${backend.costModelClass}`);
  if (backend.endpointEnv) lines.push(`  endpointEnv: ${backend.endpointEnv}`);
  if (backend.apiKeyEnv) lines.push(`  apiKeyEnv: ${backend.apiKeyEnv}`);
  return lines;
}

// Detect if a slot's resolved model string is a bare alias (no '/') or an
// already-qualified 'provider/model' string — both are written to the
// top-level `model:` key. Any other existing top-level model value is left
// untouched.
// The top-level `model:` is the Claude Code subagent's own model: it must be
// a Claude alias or claude-* id. A foreign-vendor slot's model belongs only
// in the backend block, so it never reaches the top-level key (Claude Code
// would send it to Anthropic and 404). Returns undefined (leave as is) then.
const CLAUDE_TOP_LEVEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable", "inherit", "opusplan"]);
function slotTopLevelModel(slot) {
  if (!slot || typeof slot.model !== "string" || slot.model === "") return undefined;
  if (slot.vendor && slot.vendor !== "anthropic") return undefined;
  const bare = slot.model.replace(/^anthropic\//, "").trim().replace(/^["']|["']$/g, "");
  const core = bare.replace(/\[1m\]$/i, "");
  if (CLAUDE_TOP_LEVEL_ALIASES.has(core) || /^claude-/.test(core)) return bare;
  return undefined;
}

// Split raw file text into { hasFrontmatter, fmLines, bodyText, eol,
// trailingNewline }. Only a leading `---\n...\n---` block counts as
// frontmatter, matching agentBackend.ts's readAgentFrontmatter regex.
function splitFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { hasFrontmatter: false };
  }
  const fmBlock = match[1];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Split on any EOL style and strip a trailing \r explicitly so downstream
  // per-line regexes (which use `.` and thus would otherwise capture a
  // trailing \r into a matched value, or fail `!/^\s/.test(line)` style
  // checks) behave identically regardless of the source file's line-ending
  // convention (Windows-authored CRLF included).
  const fmLines = fmBlock.split(/\r?\n/).map((line) => line.replace(/\r$/, ""));
  const rest = text.slice(match[0].length);
  return { hasFrontmatter: true, fmLines, rest, eol };
}

// Given the raw frontmatter lines (flat key: value, with a possible nested
// `backend:` block), return { lines, orchestratorFlag } with:
//  - the `backend:` block replaced (or inserted at the end) using
//    newBackendLines
//  - `model:` replaced with newTopModel when provided (existing key), or
//    inserted (new key) if it wasn't already present and newTopModel is set
//  - every other line preserved verbatim, in original order
function rewriteFrontmatterLines(fmLines, newBackendLines, newTopModel) {
  const out = [];
  let i = 0;
  let sawBackend = false;
  let sawModel = false;
  while (i < fmLines.length) {
    const line = fmLines[i].replace(/\r$/, "");
    const topMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (topMatch && !/^\s/.test(line) && topMatch[1] === "backend") {
      sawBackend = true;
      out.push(...newBackendLines);
      // Skip the old block's indented children.
      let j = i + 1;
      while (j < fmLines.length && /^\s+\S/.test(fmLines[j])) j++;
      i = j;
      continue;
    }
    if (topMatch && !/^\s/.test(line) && topMatch[1] === "model") {
      sawModel = true;
      if (newTopModel !== undefined) {
        out.push(`model: ${newTopModel}`);
      } else {
        out.push(line);
      }
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  if (!sawModel && newTopModel !== undefined) {
    // Insert model: right after name/description if present, else at top.
    let insertAt = 0;
    for (let k = 0; k < out.length; k++) {
      if (/^(name|description):/.test(out[k])) insertAt = k + 1;
    }
    out.splice(insertAt, 0, `model: ${newTopModel}`);
  }
  if (!sawBackend) {
    out.push(...newBackendLines);
  }
  return out;
}

const RELAY_NOTICE_PREFIX = "TYCOON-RELAY-NOTICE:";
const MANAGED_MARKER = "# managed-by: tycoon-routing";
const BACKUP_FILENAME = path.join(".claude", "tycoon", "routing.backup.json");

// Locate ANY top-level `backend:` block (managed or hand-written). Returns
// { start, end } (end exclusive) or undefined if there is no backend block.
// Used to snapshot a hand-written block before it gets overwritten by a
// managed one, so unapply can restore it later (see saveBackupEntry /
// restoreOrStripManagedBackendBlock below).
function findAnyBackendBlockRange(fmLines) {
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i].replace(/\r$/, "");
    const topMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (topMatch && !/^\s/.test(line) && topMatch[1] === "backend") {
      let j = i + 1;
      while (j < fmLines.length && /^\s+\S/.test(fmLines[j])) j++;
      return { start: i, end: j };
    }
  }
  return undefined;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Load <root>/.claude/tycoon/routing.backup.json (shape:
// { agents: { <id>: { lines: string[], hash: string } } }), or an empty doc
// if the file is missing/unreadable/malformed.
function loadBackupDoc(root) {
  const backupPath = path.join(root, BACKUP_FILENAME);
  try {
    const raw = fs.readFileSync(backupPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object") {
      return parsed;
    }
  } catch {
    // missing or invalid — start fresh.
  }
  return { agents: {} };
}

function writeBackupDoc(root, doc) {
  const backupPath = path.join(root, BACKUP_FILENAME);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const sortedAgents = {};
  for (const id of Object.keys(doc.agents).sort()) sortedAgents[id] = doc.agents[id];
  fs.writeFileSync(backupPath, JSON.stringify({ agents: sortedAgents }, null, 2) + "\n", "utf8");
}

// Before overwriting a file's backend block with a managed one, snapshot the
// CURRENT block into backupDoc.agents[agentId] — but only if it is a
// hand-written block (no managed-by marker as its first child line) AND no
// backup entry already exists for this agent id. This is what makes the
// backup survive repeated applies: once an entry is recorded, a later apply
// (which only ever sees the now-managed block) never overwrites it.
function findTopLevelModelLine(fmLines) {
  for (const rawLine of fmLines) {
    const line = rawLine.replace(/\r$/, "");
    const m = line.match(/^(model):\s*(.*)$/);
    if (m && !/^\s/.test(line)) return line;
  }
  return undefined;
}

function snapshotHandWrittenBlockIfAny(backupDoc, agentId, rawFileText, fmLines) {
  const range = findAnyBackendBlockRange(fmLines);
  if (!range) return;
  const firstChild = range.start + 1 < range.end ? fmLines[range.start + 1].replace(/\r$/, "").trim() : undefined;
  if (firstChild === MANAGED_MARKER) return; // already managed — nothing hand-written to save.
  if (backupDoc.agents[agentId]) return; // already have a snapshot for this agent.
  const lines = fmLines.slice(range.start, range.end).map((l) => l.replace(/\r$/, ""));
  // Also snapshot the top-level `model:` line (or its absence) as it stood
  // right before this same apply may rewrite it (routingSlotToBackend's
  // slotTopLevelModel path) — otherwise unapply would restore the backend:
  // block but leave a stale rewritten top-level model behind.
  const topModelLine = findTopLevelModelLine(fmLines);
  backupDoc.agents[agentId] = { lines, hash: sha256(rawFileText), topModelLine: topModelLine ?? null };
}

// Strip a managed `backend:` block from raw file text on unapply. If
// backupDoc holds a snapshot for agentId, the original hand-written block
// (and the original top-level `model:` line, restored/removed to match) is
// restored in its place instead of being removed outright. Returns undefined
// if there is nothing to do (no frontmatter, or no managed block present).
function restoreOrStripManagedBackendBlock(raw, backupDoc, agentId) {
  const split = splitFrontmatter(raw);
  if (!split.hasFrontmatter) return undefined;
  const range = findManagedBackendBlockRange(split.fmLines);
  if (!range) return undefined;
  const backupEntry = agentId ? backupDoc.agents[agentId] : undefined;
  const replacement = backupEntry ? backupEntry.lines : [];
  const fmLines = [...split.fmLines.slice(0, range.start), ...replacement, ...split.fmLines.slice(range.end)];
  if (backupEntry) {
    const currentModelIdx = fmLines.findIndex((l) => /^model:\s*.*$/.test(l.replace(/\r$/, "")) && !/^\s/.test(l));
    if (backupEntry.topModelLine) {
      if (currentModelIdx >= 0) {
        fmLines[currentModelIdx] = backupEntry.topModelLine;
      } else {
        fmLines.push(backupEntry.topModelLine);
      }
    } else if (currentModelIdx >= 0) {
      fmLines.splice(currentModelIdx, 1);
    }
  }
  const newFmLines = fmLines;
  return `---${split.eol}${newFmLines.join(split.eol)}${split.eol}---${split.eol}${split.rest}`;
}

// Find a top-level `backend:` block whose FIRST indented child line is the
// managed-by marker. Returns { start, end } (end exclusive) covering the
// `backend:` line itself through its last indented child line, or undefined
// if there is no backend block, or it exists but was hand-written (no
// marker) — that block must never be touched.
function findManagedBackendBlockRange(fmLines) {
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i].replace(/\r$/, "");
    const topMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (topMatch && !/^\s/.test(line) && topMatch[1] === "backend") {
      let j = i + 1;
      while (j < fmLines.length && /^\s+\S/.test(fmLines[j])) j++;
      const firstChild = i + 1 < j ? fmLines[i + 1].replace(/\r$/, "").trim() : undefined;
      if (firstChild === MANAGED_MARKER) {
        return { start: i, end: j };
      }
      return undefined;
    }
  }
  return undefined;
}

// hasHandWrittenBackendBlock (raw file text -> boolean) is loaded from
// out/src/core/routingProfile.js via loadCoreModules() — this script must
// not keep its own duplicate of that detection.

// Determine if the given frontmatter lines mark this agent as the
// orchestrator (role: orchestrator or tier: orchestrator, flat key match).
function isOrchestratorFrontmatter(fmLines) {
  for (const rawLine of fmLines) {
    const line = rawLine.replace(/\r$/, "");
    const m = line.match(/^(role|tier):\s*(.*)$/);
    if (m) {
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (value === "orchestrator") return true;
    }
  }
  return false;
}

// ---- relay helpers ---------------------------------------------------------
// Notices (a backup was made, markers are missing, a model was replaced) are
// printed as `TYCOON-RELAY-NOTICE: <text>` lines after a real write so the
// host can show them; pre-revert text of an edited relay goes to
// <id>.md.relay-backup before the file is restored.
const relayNotices = [];
const relayBackups = []; // { filePath, content }

function splitBom(text) {
  return text.charCodeAt(0) === 0xfeff ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

// The agent's catalog default model (REGISTER in out/.../packCatalog.js), "sonnet" when unavailable.
let catalogModels;
function relayFallbackModel(agentId) {
  if (!catalogModels) {
    catalogModels = new Map();
    try {
      const cat = require(path.join(REPO_ROOT, "out", "src", "host", "vscode", "packCatalog.js"));
      for (const list of [cat.REGULAR_AGENTS, cat.LEAD_AGENTS, cat.REVIEWER_AGENTS, cat.FOREIGN_LLM_AGENTS]) {
        for (const a of Array.isArray(list) ? list : []) if (a && typeof a.id === "string" && typeof a.model === "string") catalogModels.set(a.id, a.model);
      }
    } catch {
      // fail open: "sonnet" below
    }
  }
  return catalogModels.get(agentId) ?? "sonnet";
}

// Reconcile one agent file's relay state; BOM-safe (the BOM is stripped from the returned text).
function reconcileRelayFile(filePath, agentId, bom, text, want) {
  const r = require(path.join(REPO_ROOT, "out", "src", "core", "agentRelay.js")).reconcileRelayDetailed(bom + text, want, { agentId, fallbackModel: relayFallbackModel(agentId) });
  for (const n of r.notices) if (!relayNotices.includes(n)) relayNotices.push(n);
  if (r.backup !== undefined && !relayBackups.some((b) => b.filePath === filePath + ".relay-backup")) {
    relayBackups.push({ filePath: filePath + ".relay-backup", content: r.backup });
  }
  return splitBom(r.content).text;
}

// True when raw agent file text declares role/tier orchestrator.
function isOrchestratorFile(rawText) {
  const split = splitFrontmatter(rawText);
  return split.hasFrontmatter && isOrchestratorFrontmatter(split.fmLines);
}

function main() {
  const { root, check, relay: relayEnabled } = parseArgs(process.argv.slice(2));
  const core = loadCoreModules();
  const { loadRoutingProfile, resolveAgentSlot, resolveOrchestratorSlot, routingSlotToBackend, hasHandWrittenBackendBlock, agentRelay } = core;

  const { profile, path: profilePath, errors } = loadRoutingProfile(root);

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(err);
    }
    process.exit(2);
  }

  const agentsDir = path.join(root, ".claude", "agents");
  const wouldChange = [];
  const writes = []; // { filePath, content }
  const warnings = [];
  const untouched = []; // files with no frontmatter block
  const deletes = []; // filePath list for pure removals (e.g. routing.resolved.json when no profile)

  if (!profile) {
    // No routing.json present at all: unapply — restore each file's
    // original hand-written backend block from routing.backup.json if one
    // was ever recorded for that agent id, else strip the managed block
    // outright (today's behavior), and remove routing.resolved.json
    // entirely.
    const backupDocNoProfile = loadBackupDoc(root);
    let agentFilesNoProfile = [];
    try {
      agentFilesNoProfile = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    } catch {
      agentFilesNoProfile = [];
    }
    for (const file of agentFilesNoProfile) {
      const filePath = path.join(agentsDir, file);
      const agentId = file.replace(/\.md$/, "");
      const { bom, text: rawFile } = splitBom(fs.readFileSync(filePath, "utf8"));
      const raw = reconcileRelayFile(filePath, agentId, bom, rawFile, null);
      const stripped = restoreOrStripManagedBackendBlock(raw, backupDocNoProfile, agentId) ?? raw;
      if (stripped !== rawFile) {
        wouldChange.push(filePath);
        writes.push({ filePath, content: bom + stripped });
      }
    }
    const resolvedOutPath = path.join(root, ".claude", "tycoon", "routing.resolved.json");
    if (fs.existsSync(resolvedOutPath)) {
      wouldChange.push(resolvedOutPath);
      deletes.push(resolvedOutPath);
    }

    if (check) {
      if (wouldChange.length > 0) {
        for (const f of wouldChange) console.log(f);
        process.exit(1);
      }
      console.log("No routing.json present; nothing to apply.");
      process.exit(0);
    }

    for (const { filePath, content } of writes) {
      fs.writeFileSync(filePath, content, "utf8");
    }
    for (const f of deletes) {
      try {
        fs.unlinkSync(f);
      } catch {
        // already gone — fine.
      }
    }
    process.exit(0);
  }

  let agentFiles = [];
  try {
    agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    agentFiles = [];
  }

  // Build id -> filename map.
  const idToFile = new Map();
  for (const file of agentFiles) {
    const id = file.replace(/\.md$/, "");
    idToFile.set(id, file);
  }

  const resolvedAgents = {};
  const backupDoc = loadBackupDoc(root);
  let backupDocChanged = false;

  // Pre-scan for the orchestrator's own agent id (if any) so `defaults`
  // expansion below never double-processes it — the orchestrator slot is
  // resolved and written separately below via resolveOrchestratorSlot,
  // which already merges `defaults` unconditionally (matching
  // resolveOrchestratorSlot's existing contract; the hand-written-backend
  // exclusion only applies to resolveAgentSlot per p17-t1).
  let orchestratorIdPre;
  for (const file of agentFiles) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(agentsDir, file), "utf8");
    } catch {
      continue;
    }
    const split = splitFrontmatter(raw);
    if (!split.hasFrontmatter) continue;
    if (isOrchestratorFrontmatter(split.fmLines)) {
      orchestratorIdPre = file.replace(/\.md$/, "");
      break;
    }
  }

  // Agents to process: every explicit `agents[id]` entry, plus — when
  // `profile.defaults.model` is set — every other agent file whose
  // frontmatter has NO hand-written `backend:` block (a managed block, or no
  // block at all, both count as eligible). This is the "route the whole
  // roster with one edit" expansion (p17-t1 decision 2026-09-05).
  const agentIdsToProcess = new Set(Object.keys(profile.agents));
  const defaultsHasModel = !!(profile.defaults && typeof profile.defaults.model === "string" && profile.defaults.model !== "");
  if (defaultsHasModel) {
    for (const id of idToFile.keys()) {
      if (agentIdsToProcess.has(id) || id === orchestratorIdPre) continue;
      const file = idToFile.get(id);
      let raw;
      try {
        raw = fs.readFileSync(path.join(agentsDir, file), "utf8");
      } catch {
        continue;
      }
      const split = splitFrontmatter(raw);
      if (!split.hasFrontmatter) continue;
      if (hasHandWrittenBackendBlock(raw)) continue;
      agentIdsToProcess.add(id);
    }
  }

  for (const agentId of agentIdsToProcess) {
    const file = idToFile.get(agentId);
    if (!file) {
      warnings.push(`agent "${agentId}" is in routing.json but no .claude/agents/${agentId}.md file exists; skipped`);
      continue;
    }
    const isExplicitAgent = Object.prototype.hasOwnProperty.call(profile.agents, agentId);
    const filePath = path.join(agentsDir, file);
    const { bom, text: rawFile } = splitBom(fs.readFileSync(filePath, "utf8"));
    const slot0 = resolveAgentSlot(profile, agentId, { hasHandWrittenBackend: hasHandWrittenBackendBlock(rawFile) });
    // Relay state first: a relayed file whose slot is no longer a bridged
    // foreign provider (or when relays are off) is restored exactly before the
    // normal backend/model rewrite below runs on the original text.
    // Only a provider named on the agent's OWN slot makes it a relay: a foreign vendor that comes
    // only from the shared `defaults` slot never converts every agent.
    const ownSlot = profile.agents[agentId];
    const ownVendor = !!ownSlot && typeof ownSlot.vendor === "string" && ownSlot.vendor !== "";
    const relayTarget = relayEnabled && slot0 && ownVendor && !isOrchestratorFile(rawFile)
      ? agentRelay.relayTargetFor(agentId, routingSlotToBackend(slot0))
      : null;
    const raw = agentRelay.agentMarkdownIsRelayManaged(rawFile) && !relayTarget
      ? reconcileRelayFile(filePath, agentId, bom, rawFile, null)
      : rawFile;
    const split = splitFrontmatter(raw);
    if (!split.hasFrontmatter) {
      if (isExplicitAgent) untouched.push(filePath);
      continue;
    }
    const slot = slot0;
    if (!slot) {
      if (raw !== rawFile) {
        wouldChange.push(filePath);
        writes.push({ filePath, content: bom + raw });
      }
      continue;
    }
    const backend = routingSlotToBackend(slot);
    const bridgeAgentAlready = hasHandWrittenBackendBlock(rawFile) || !!backupDoc.agents[agentId];
    const backupCountBefore = Object.keys(backupDoc.agents).length;
    snapshotHandWrittenBlockIfAny(backupDoc, agentId, raw, split.fmLines);
    if (Object.keys(backupDoc.agents).length !== backupCountBefore) backupDocChanged = true;
    const newBackendLines = renderBackendBlockLines(backend);
    const topModel = slotTopLevelModel(slot);
    const newFmLines = rewriteFrontmatterLines(split.fmLines, newBackendLines, topModel);
    const rewritten = `---${split.eol}${newFmLines.join(split.eol)}${split.eol}---${split.eol}${split.rest}`;
    const newContent = relayTarget
      ? reconcileRelayFile(filePath, agentId, bom, rewritten, { target: relayTarget, skipConversion: bridgeAgentAlready })
      : rewritten;
    if (newContent !== rawFile) {
      wouldChange.push(filePath);
      writes.push({ filePath, content: bom + newContent });
    }

    const fallbackBackends = Array.isArray(slot.fallback)
      ? slot.fallback.map((fb) => routingSlotToBackend(fb))
      : undefined;
    const resolvedEntry = fallbackBackends && fallbackBackends.length > 0
      ? { backend, fallback: fallbackBackends }
      : { backend };
    // p31-t1: only emitted when explicitly false — absence means "default
    // true" for every consumer (dispatcher, Claude hook), so an unset slot
    // produces byte-identical output to before this field existed.
    if (slot.useDefaultFallback === false) resolvedEntry.useDefaultFallback = false;
    resolvedAgents[agentId] = resolvedEntry;
  }

  // Orchestrator slot: find the agent file whose frontmatter declares
  // role/tier orchestrator, if any.
  let resolvedOrchestrator;
  let orchestratorFileResolved;
  const orchestratorSlot = resolveOrchestratorSlot(profile);
  if (orchestratorSlot) {
    let orchestratorFile;
    for (const file of agentFiles) {
      const filePath = path.join(agentsDir, file);
      const raw = fs.readFileSync(filePath, "utf8");
      const split = splitFrontmatter(raw);
      if (!split.hasFrontmatter) continue;
      if (isOrchestratorFrontmatter(split.fmLines)) {
        orchestratorFile = { file, filePath, raw, split };
        break;
      }
    }
    const backend = routingSlotToBackend(orchestratorSlot);
    const fallbackBackends = Array.isArray(orchestratorSlot.fallback)
      ? orchestratorSlot.fallback.map((fb) => routingSlotToBackend(fb))
      : undefined;
    resolvedOrchestrator = fallbackBackends && fallbackBackends.length > 0
      ? { backend, fallback: fallbackBackends }
      : { backend };

    if (orchestratorFile) {
      orchestratorFileResolved = orchestratorFile.filePath;
      const orchestratorId = orchestratorFile.file.replace(/\.md$/, "");
      const backupCountBeforeOrch = Object.keys(backupDoc.agents).length;
      snapshotHandWrittenBlockIfAny(backupDoc, orchestratorId, orchestratorFile.raw, orchestratorFile.split.fmLines);
      if (Object.keys(backupDoc.agents).length !== backupCountBeforeOrch) backupDocChanged = true;
      const newBackendLines = renderBackendBlockLines(backend);
      const topModel = slotTopLevelModel(orchestratorSlot);
      const newFmLines = rewriteFrontmatterLines(orchestratorFile.split.fmLines, newBackendLines, topModel);
      const newContent = `---${orchestratorFile.split.eol}${newFmLines.join(orchestratorFile.split.eol)}${orchestratorFile.split.eol}---${orchestratorFile.split.eol}${orchestratorFile.split.rest}`;
      if (newContent !== orchestratorFile.raw && !writes.some((w) => w.filePath === orchestratorFile.filePath)) {
        wouldChange.push(orchestratorFile.filePath);
        writes.push({ filePath: orchestratorFile.filePath, content: newContent });
      }
    } else {
      warnings.push("routing.json declares an orchestrator slot but no .claude/agents/*.md file has role/tier: orchestrator; skipped");
    }
  }

  // Unapply pass: any agent file that was NOT written this run (i.e. its id
  // is not in the profile, and it isn't the resolved orchestrator's file)
  // may still carry a managed backend block from an earlier apply — strip
  // it. A hand-written backend block (no managed-by marker) is left alone.
  const activePaths = new Set();
  for (const agentId of agentIdsToProcess) {
    const file = idToFile.get(agentId);
    if (file) activePaths.add(path.join(agentsDir, file));
  }
  if (orchestratorSlot && orchestratorFileResolved) {
    activePaths.add(orchestratorFileResolved);
  }
  for (const file of agentFiles) {
    const filePath = path.join(agentsDir, file);
    if (activePaths.has(filePath)) continue;
    let bom;
    let raw;
    try {
      ({ bom, text: raw } = splitBom(fs.readFileSync(filePath, "utf8")));
    } catch {
      continue;
    }
    const droppedId = file.replace(/\.md$/, "");
    const unrelayed = reconcileRelayFile(filePath, droppedId, bom, raw, null);
    const stripped = restoreOrStripManagedBackendBlock(unrelayed, backupDoc, droppedId) ?? unrelayed;
    if (stripped !== raw) {
      wouldChange.push(filePath);
      writes.push({ filePath, content: bom + stripped });
    }
  }

  // routing.resolved.json — deterministic key order (agents sorted, then orchestrator).
  const resolvedOutPath = path.join(root, ".claude", "tycoon", "routing.resolved.json");
  const sortedAgents = {};
  for (const id of Object.keys(resolvedAgents).sort()) {
    sortedAgents[id] = resolvedAgents[id];
  }
  const resolvedDoc = { agents: sortedAgents };
  if (resolvedOrchestrator) resolvedDoc.orchestrator = resolvedOrchestrator;
  // Top-level defaultFallback: converted through the same
  // routingSlotToBackend used for every agent/orchestrator backend, so
  // hooks/tycoon-claude-hook.cjs and hooks/tycoon-dispatcher-mcp.cjs (both
  // of which read resolvedRouting.defaultFallback as a Backend-shaped
  // object) see it in real runs, not just hand-written test fixtures.
  // Omitted entirely when the source routing.json has no defaultFallback.
  if (profile.defaultFallback) {
    resolvedDoc.defaultFallback = routingSlotToBackend(profile.defaultFallback);
  }
  const resolvedJson = JSON.stringify(resolvedDoc, null, 2) + "\n";
  let existingResolvedJson;
  try {
    existingResolvedJson = fs.readFileSync(resolvedOutPath, "utf8");
  } catch {
    existingResolvedJson = undefined;
  }
  if (existingResolvedJson !== resolvedJson) {
    wouldChange.push(resolvedOutPath);
  }

  const backupOutPath = path.join(root, BACKUP_FILENAME);
  if (backupDocChanged) {
    wouldChange.push(backupOutPath);
  }

  for (const w of warnings) {
    console.warn(w);
  }
  for (const u of untouched) {
    console.warn(`${u}: no YAML frontmatter block found; left untouched`);
  }

  if (check) {
    if (wouldChange.length > 0) {
      for (const f of wouldChange) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  }

  for (const { filePath, content } of relayBackups) {
    fs.writeFileSync(filePath, content, "utf8");
  }
  for (const { filePath, content } of writes) {
    fs.writeFileSync(filePath, content, "utf8");
  }
  for (const n of relayNotices) console.log(`${RELAY_NOTICE_PREFIX} ${n}`);
  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  fs.writeFileSync(resolvedOutPath, resolvedJson, "utf8");
  if (backupDocChanged) {
    writeBackupDoc(root, backupDoc);
  }

  process.exit(0);
}

main();
