/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Shipped-template hygiene: no product wording in user-facing agent
 * descriptions, read-only discipline for reviewer/search, heal of unedited
 * installs, runtime edit-target resolution in the hook, and the UEFN
 * Auditor title.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentMarkdown,
  resyncAgentDisciplineSection,
  resyncAgentFrontmatterFields,
  WORKING_DISCIPLINE_BODY,
  WORKING_DISCIPLINE_READ_ONLY_BODY,
  REGULAR_AGENTS,
  LEAD_AGENTS,
  REVIEWER_AGENTS,
  FOREIGN_LLM_AGENTS,
  SUPERSEDED_ROLES,
} from "../src/host/vscode/packCatalog";
import { detectUefnProject } from "../src/host/vscode/uefnDetect";
import { resolveEditTargetAgent, decideDirectToolCall } from "../src/core/delegationEnforcement";

const CATALOG = JSON.parse(readFileSync(join(process.cwd(), "media", "packs", "catalog.json"), "utf8")) as Array<Record<string, unknown>>;

function catalogAgents(): Array<{ id: string; name: string; role: string }> {
  const out: Array<{ id: string; name: string; role: string }> = [];
  for (const pack of CATALOG) {
    if (pack.agent) out.push(pack.agent as never);
    if (Array.isArray(pack.agents)) out.push(...(pack.agents as never[]));
  }
  return out;
}

test("shipped agent descriptions carry no TycoonAgents stage/visualization wording", () => {
  const all = [...REGULAR_AGENTS, ...LEAD_AGENTS, ...REVIEWER_AGENTS, ...FOREIGN_LLM_AGENTS, ...catalogAgents()];
  for (const a of all) {
    assert.doesNotMatch(a.role, /at a glance/i, `${a.id} role`);
    assert.doesNotMatch(a.role, /visuali[sz]ation/i, `${a.id} role`);
  }
});

test("reviewer and search-retrieval get the read-only discipline; workers keep the editing one", () => {
  const reviewer = buildAgentMarkdown(REVIEWER_AGENTS[0], "worker");
  const search = buildAgentMarkdown(REGULAR_AGENTS.find((a) => a.id === "search-retrieval")!, "worker");
  const coder = buildAgentMarkdown(REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!, "worker");
  for (const md of [reviewer, search]) {
    assert.ok(md.includes(WORKING_DISCIPLINE_READ_ONLY_BODY));
    assert.ok(!md.includes("files are written"));
    assert.ok(!md.includes("what changed"));
    assert.match(md, /Do NOT edit/);
    assert.match(md, /LEAF/);
    assert.match(md, /Do NOT spawn Task/);
    assert.match(md, /file:line/);
  }
  assert.ok(coder.includes(WORKING_DISCIPLINE_BODY));
  assert.ok(!coder.includes(WORKING_DISCIPLINE_READ_ONLY_BODY));
  assert.match(reviewer, /^disallowedTools: Agent, Edit, Write$/m);
  assert.match(coder, /^disallowedTools: Agent$/m);
});

test("resyncAgentDisciplineSection picks the variant from the file's own frontmatter", () => {
  const search = REGULAR_AGENTS.find((a) => a.id === "search-retrieval")!;
  const oldSearch = buildAgentMarkdown(search, "worker").replace(WORKING_DISCIPLINE_READ_ONLY_BODY, WORKING_DISCIPLINE_BODY);
  const healed = resyncAgentDisciplineSection(oldSearch);
  assert.ok(healed.endsWith(`${WORKING_DISCIPLINE_READ_ONLY_BODY}\n`));
  assert.equal(resyncAgentDisciplineSection(healed), healed);
  const coder = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
  const md = buildAgentMarkdown(coder, "worker");
  assert.equal(resyncAgentDisciplineSection(md), md);
  const oldReviewer = buildAgentMarkdown(REVIEWER_AGENTS[0], "worker").replace(WORKING_DISCIPLINE_READ_ONLY_BODY, WORKING_DISCIPLINE_BODY);
  assert.ok(resyncAgentDisciplineSection(oldReviewer).includes(WORKING_DISCIPLINE_READ_ONLY_BODY));
});

test("heal moves an unedited superseded description to the current one and leaves an edited one alone", () => {
  for (const id of Object.keys(SUPERSEDED_ROLES)) {
    const agent = REGULAR_AGENTS.find((a) => a.id === id)!;
    const current = buildAgentMarkdown(agent, "worker");
    for (const oldRole of SUPERSEDED_ROLES[id]) {
      const old = current.replace(JSON.stringify(agent.role), JSON.stringify(oldRole));
      assert.notEqual(old, current);
      assert.equal(resyncAgentFrontmatterFields(old, agent), current);
    }
    const edited = current.replace(JSON.stringify(agent.role), JSON.stringify("My own words."));
    assert.equal(resyncAgentFrontmatterFields(edited, agent), null);
  }
});

test("heal adds Edit and Write to an untouched reviewer denylist but keeps a customized one", () => {
  const reviewer = REVIEWER_AGENTS[0];
  const current = buildAgentMarkdown(reviewer, "worker");
  const old = current.replace("disallowedTools: Agent, Edit, Write", "disallowedTools: Agent");
  assert.equal(resyncAgentFrontmatterFields(old, reviewer), current);
  const custom = current.replace("disallowedTools: Agent, Edit, Write", "disallowedTools: Agent, Bash");
  assert.equal(resyncAgentFrontmatterFields(custom, reviewer), null);
});

test("uefn-auditor template is titled UEFN Auditor and an unedited old H1 heals", () => {
  const uefn = CATALOG.find((p) => p.id === "uefn")!;
  const aud = (uefn.agents as Array<{ id: string; name: string; model: string; role: string; keywords: string }>).find((a) => a.id === "uefn-auditor")!;
  assert.equal(aud.name, "UEFN Auditor");
  const current = buildAgentMarkdown(aud, "uefn");
  assert.match(current, /^# UEFN Auditor$/m);
  const old = current.replace("# UEFN Auditor", "# Verse Auditor");
  assert.equal(resyncAgentFrontmatterFields(old, aud), current);
  const unmarked = old.replace("tycoon_pack: uefn\n", "");
  assert.equal(resyncAgentFrontmatterFields(unmarked, aud), null);
  const custom = current.replace("# UEFN Auditor", "# My Auditor");
  assert.equal(resyncAgentFrontmatterFields(custom, aud), null);
});

test("bridge bodies treat the dispatcher as optional", () => {
  for (const a of FOREIGN_LLM_AGENTS.filter((x) => x.id.endsWith("reviewer"))) {
    const md = buildAgentMarkdown(a, "multi-llm");
    assert.ok(md.includes("## Calling through the dispatcher (when available)"), a.id);
    assert.ok(!md.includes("(preferred)"), a.id);
    assert.match(md, /usually absent on Claude Code/);
  }
});

test("ready-test SKILL.md copies are identical and point at project hook directories", () => {
  const media = readFileSync(join(process.cwd(), "media", "skills", "tycoon-ready-test", "SKILL.md"), "utf8");
  // .claude/ is gitignored (a developer-local copy); absent on CI checkouts.
  const devPath = join(process.cwd(), ".claude", "skills", "tycoon-ready-test", "SKILL.md");
  if (existsSync(devPath)) assert.equal(readFileSync(devPath, "utf8"), media);
  assert.ok(!media.includes("repo-root `hooks/`"));
  assert.ok(media.includes(".claude/hooks/") && media.includes(".claude/tycoon/"));
});

// ---- edit-target resolution --------------------------------------------------

test("resolveEditTargetAgent ladder: coding-specialist, verse-expert in Verse projects, fallback agent", () => {
  assert.equal(resolveEditTargetAgent({ agentIds: ["coding-specialist", "verse-expert"], hasVerseProject: true }), "coding-specialist");
  assert.equal(resolveEditTargetAgent({ agentIds: ["verse-expert"], hasVerseProject: true }), "verse-expert");
  assert.equal(resolveEditTargetAgent({ agentIds: ["verse-expert"], hasVerseProject: false, fallbackAgent: "wild" }), "wild");
  assert.equal(resolveEditTargetAgent({ agentIds: [], hasVerseProject: false }), "primary-agent");
  assert.match(decideDirectToolCall("Edit", 0, "verse-expert").message ?? "", /\(verse-expert\)/);
  assert.match(decideDirectToolCall("Edit", 0).message ?? "", /\(coding-specialist\)/);
});

function hookEditMessage(setup: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-edit-target-"));
  try {
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
    setup(root);
    const r = spawnSync(process.execPath, [join(process.cwd(), "hooks", "tycoon-claude-hook.cjs")], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {}, session_id: "edit-target" }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const agentFile = (root: string, id: string): void =>
  writeFileSync(join(root, ".claude", "agents", `${id}.md`), `---\nname: ${id}\ndescription: x\nmodel: sonnet\n---\nBody.\n`);

test("hook edit nudge names coding-specialist when installed", () => {
  const msg = hookEditMessage((root) => {
    agentFile(root, "coding-specialist");
    agentFile(root, "verse-expert");
    writeFileSync(join(root, "a.verse"), "");
  });
  assert.match(msg, /\(coding-specialist\)/);
});

test("hook edit nudge names verse-expert for a Verse project without coding-specialist", () => {
  const viaFile = hookEditMessage((root) => {
    agentFile(root, "verse-expert");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "device.verse"), "");
  });
  assert.match(viaFile, /\(verse-expert\)/);
  const viaProject = hookEditMessage((root) => {
    agentFile(root, "verse-expert");
    writeFileSync(join(root, "Island.uefnproject"), "{}");
  });
  assert.match(viaProject, /\(verse-expert\)/);
});

test("hook edit nudge falls back to the configured fallback_agent", () => {
  const configured = hookEditMessage((root) => {
    agentFile(root, "primary-agent");
    writeFileSync(join(root, ".claude", "tycoon", "agent-keywords.json"), JSON.stringify({ fallback_agent: "wildcard", agents: {} }));
  });
  assert.match(configured, /\(wildcard\)/);
  const defaulted = hookEditMessage((root) => agentFile(root, "primary-agent"));
  assert.match(defaulted, /\(primary-agent\)/);
  const noVerseAgent = hookEditMessage((root) => writeFileSync(join(root, "a.verse"), ""));
  assert.match(noVerseAgent, /\(primary-agent\)/);
});

test("hook Verse detection matches detectUefnProject on the same fixtures", () => {
  const cases: Array<[string, (root: string) => void]> = [
    ["root .verse", (r) => writeFileSync(join(r, "a.verse"), "")],
    ["src .verse", (r) => { mkdirSync(join(r, "src")); writeFileSync(join(r, "src", "a.verse"), ""); }],
    ["nested .verse only", (r) => { mkdirSync(join(r, "Plugins", "Content"), { recursive: true }); writeFileSync(join(r, "Plugins", "Content", "a.verse"), ""); }],
    ["root .uproject", (r) => writeFileSync(join(r, "X.uproject"), "{}")],
    ["root .uefnproject", (r) => writeFileSync(join(r, "X.uefnproject"), "{}")],
    ["Content/Verse", (r) => mkdirSync(join(r, "Content", "Verse"), { recursive: true })],
    ["none", () => undefined],
  ];
  for (const [label, make] of cases) {
    let detected = false;
    const msg = hookEditMessage((root) => {
      agentFile(root, "verse-expert");
      make(root);
      detected = detectUefnProject(root).detected;
    });
    assert.match(msg, detected ? /\(verse-expert\)/ : /\(primary-agent\)/, label);
  }
});
