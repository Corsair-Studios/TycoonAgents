/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests scripts/generate-codex-config.mjs (plan p23-t3): generation of the
// AGENTS.md `<!-- TYCOON-CODEX-MANAGED -->` block and the
// .claude/tycoon/codex-agents.toml.generated fragment from a 3-agent roster
// fixture (one openai vendor, one anthropic, one with no vendor block).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_URL = pathToFileURL(join(process.cwd(), "scripts", "generate-codex-config.mjs")).href;

// This test file compiles to CommonJS; go through `new Function` so the
// dynamic `import()` of an ESM .mjs module isn't downleveled to `require`
// (same idiom as test/tycoonDiagnoseReportFormatLint.test.ts).
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string
) => Promise<{
  generateCodexConfig: (opts: { projectDir: string; rosterDir?: string; routingPath?: string }) => {
    agentsMdBlock: string;
    agentsToml: string;
    specialists: Array<{ id: string; vendor: string; model?: string; description: string; pattern?: string }>;
  };
  upsertCodexBlock: (existingAgentsMd: string, blockBody: string) => string;
}>;

function makeRosterFixture(): { projectDir: string; rosterDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "tycoon-codex-config-"));
  const rosterDir = join(projectDir, ".claude", "agents");
  mkdirSync(rosterDir, { recursive: true });

  writeFileSync(
    join(rosterDir, "codex-reviewer.md"),
    `---\nname: codex-reviewer\nmodel: openai/gpt-6-astra\nbackend:\n  vendor: openai\n  transport: mcp\n  model: openai/gpt-6-astra\n---\n\n# Codex Reviewer\n\nRuns an adversarial cross-vendor review via Codex.\n`,
    "utf8"
  );
  writeFileSync(
    join(rosterDir, "coding-specialist.md"),
    `---\nname: coding-specialist\nbackend:\n  vendor: anthropic\n  model: anthropic/sonnet\n---\n\n# Coding Specialist\n\nImplements code changes, fixes bugs, and refactors.\n`,
    "utf8"
  );
  writeFileSync(
    join(rosterDir, "search-retrieval.md"),
    `---\nname: search-retrieval\n---\n\n# Search Retrieval\n\nFinds files and answers where things live in the codebase.\n`,
    "utf8"
  );

  mkdirSync(join(projectDir, ".claude", "tycoon"), { recursive: true });
  writeFileSync(
    join(projectDir, ".claude", "tycoon", "agent-keywords.json"),
    JSON.stringify({
      fallback_agent: "coding-specialist",
      agents: {
        "codex-reviewer": { pattern: "codex|foreign-review" },
        "coding-specialist": { pattern: "implement|code|fix|bug" },
        "search-retrieval": { pattern: "search|find|where" },
      },
    }),
    "utf8"
  );

  return { projectDir, rosterDir };
}

test("resolves a 3-agent roster: openai vendor, anthropic vendor, no-vendor default", async () => {
  const { generateCodexConfig } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const { specialists } = generateCodexConfig({ projectDir });
    assert.equal(specialists.length, 3);
    const byId = new Map(specialists.map((s) => [s.id, s]));
    assert.equal(byId.get("codex-reviewer")?.vendor, "openai");
    assert.equal(byId.get("coding-specialist")?.vendor, "anthropic");
    // No backend block at all -> defaults to anthropic, per module header.
    assert.equal(byId.get("search-retrieval")?.vendor, "anthropic");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("AGENTS.md block: delimiters present exactly once; openai row marked native, others delegate", async () => {
  const { generateCodexConfig } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const { agentsMdBlock } = generateCodexConfig({ projectDir });
    assert.match(agentsMdBlock, /codex-reviewer/);
    assert.match(agentsMdBlock, /openai \(native\)/);
    assert.match(agentsMdBlock, /anthropic \(delegate\)/);
    assert.match(agentsMdBlock, /`delegate` tool/);
    assert.match(agentsMdBlock, /leaf/i);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("TOML fragment: max_depth = 1, one [agents.<id>] per specialist, model only for openai vendor", async () => {
  const { generateCodexConfig } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const { agentsToml } = generateCodexConfig({ projectDir });
    assert.match(agentsToml, /^\[agents\]$/m);
    assert.match(agentsToml, /^max_depth = 1$/m);
    assert.match(agentsToml, /^\[agents\.codex-reviewer\]$/m);
    assert.match(agentsToml, /^\[agents\.coding-specialist\]$/m);
    assert.match(agentsToml, /^\[agents\.search-retrieval\]$/m);
    assert.match(agentsToml, /model = "gpt-6-astra"/);
    // Anthropic and no-vendor specialists never carry a model key.
    const codingBlock = agentsToml.split("[agents.coding-specialist]")[1].split("[agents.")[0];
    assert.doesNotMatch(codingBlock, /^model = /m);
    assert.match(codingBlock, /dispatched via tycoon delegate/);
    // MUST-VERIFY header present.
    assert.match(agentsToml, /MUST-VERIFY/);
    assert.match(agentsToml, /codex-cli 0\.153\.0/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("upsert into AGENTS.md: block delimiters present exactly once and existing TYCOON-MANAGED block untouched byte-for-byte", async () => {
  const { generateCodexConfig, upsertCodexBlock } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const opencodeBlock = `# AGENTS.md\n\n<!-- TYCOON-MANAGED:START -->\nsome opencode-managed content\nunchanged line\n<!-- TYCOON-MANAGED:END -->\n`;

    const { agentsMdBlock } = generateCodexConfig({ projectDir });
    const rebuilt = upsertCodexBlock(opencodeBlock, agentsMdBlock);

    const startCount = (rebuilt.match(/<!-- TYCOON-CODEX-MANAGED:START -->/g) || []).length;
    const endCount = (rebuilt.match(/<!-- TYCOON-CODEX-MANAGED:END -->/g) || []).length;
    assert.equal(startCount, 1);
    assert.equal(endCount, 1);
    assert.ok(rebuilt.includes("<!-- TYCOON-MANAGED:START -->\nsome opencode-managed content\nunchanged line\n<!-- TYCOON-MANAGED:END -->"));

    // Re-running the upsert against its own output replaces only the Codex
    // block; the opencode-managed block and second Codex run stay stable.
    const { agentsMdBlock: secondBlock } = generateCodexConfig({ projectDir });
    const rebuiltAgain = upsertCodexBlock(rebuilt, secondBlock);
    assert.equal(rebuiltAgain, rebuilt);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// Codex-doctrine-gap follow-up: full CLI round-trip (not just the in-memory
// generateCodexConfig/upsertCodexBlock helpers above) — invokes the script
// as a real subprocess the way runCodexConfigGenerator does, against an
// AGENTS.md that already carries hand-written prose plus an OpenCode
// managed block, and checks the .toml fragment never embeds an absolute
// path.
test("CLI round-trip: hand-written AGENTS.md text and the OpenCode block survive byte-for-byte; codex block appears; no absolute paths in the .toml fragment", () => {
  const { projectDir } = makeRosterFixture();
  try {
    const handWrittenIntro = "# AGENTS.md\n\nSome hand-written project notes.\nA second hand-written line.\n\n";
    const opencodeBlock =
      "<!-- TYCOON-MANAGED:START -->\nsome opencode-managed content\nunchanged line\n<!-- TYCOON-MANAGED:END -->\n";
    const handWrittenOutro = "\nMore hand-written notes after the opencode block.\n";
    const agentsMdPath = join(projectDir, "AGENTS.md");
    writeFileSync(agentsMdPath, handWrittenIntro + opencodeBlock + handWrittenOutro, "utf8");

    execFileSync(process.execPath, [join(process.cwd(), "scripts", "generate-codex-config.mjs"), "--root", projectDir], {
      encoding: "utf8",
    });

    const rebuilt = readFileSync(agentsMdPath, "utf8");
    assert.ok(rebuilt.includes(handWrittenIntro), "hand-written intro must survive byte-for-byte");
    assert.ok(rebuilt.includes(opencodeBlock), "OpenCode managed block must survive byte-for-byte");
    assert.ok(rebuilt.includes(handWrittenOutro.trim()), "hand-written outro must survive");
    assert.equal((rebuilt.match(/<!-- TYCOON-CODEX-MANAGED:START -->/g) || []).length, 1);
    assert.equal((rebuilt.match(/<!-- TYCOON-CODEX-MANAGED:END -->/g) || []).length, 1);

    const tomlPath = join(projectDir, ".claude", "tycoon", "codex-agents.toml.generated");
    const toml = readFileSync(tomlPath, "utf8");
    assert.ok(!toml.includes(projectDir), "generated TOML must never embed the absolute project path");
    // Windows drive-letter absolute paths and POSIX-style ones alike.
    assert.doesNotMatch(toml, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(toml, /(?<!\.)\/(?:home|Users|tmp)\//);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("upsert into AGENTS.md: two existing Codex marker pairs collapse into exactly one, not an orphaned second block", async () => {
  const { generateCodexConfig, upsertCodexBlock } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const duplicated =
      "# AGENTS.md\n\n" +
      "<!-- TYCOON-CODEX-MANAGED:START -->\nstale first block\n<!-- TYCOON-CODEX-MANAGED:END -->\n\n" +
      "some hand-written text in between\n\n" +
      "<!-- TYCOON-CODEX-MANAGED:START -->\nstale second block\n<!-- TYCOON-CODEX-MANAGED:END -->\n";

    const { agentsMdBlock } = generateCodexConfig({ projectDir });
    const rebuilt = upsertCodexBlock(duplicated, agentsMdBlock);

    const startCount = (rebuilt.match(/<!-- TYCOON-CODEX-MANAGED:START -->/g) || []).length;
    const endCount = (rebuilt.match(/<!-- TYCOON-CODEX-MANAGED:END -->/g) || []).length;
    assert.equal(startCount, 1, "exactly one Codex start marker after collapse");
    assert.equal(endCount, 1, "exactly one Codex end marker after collapse");
    assert.ok(!rebuilt.includes("stale first block"));
    assert.ok(!rebuilt.includes("stale second block"));
    assert.ok(rebuilt.includes("some hand-written text in between"), "hand-written text sandwiched between the two stale pairs must survive byte-for-byte");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("deterministic and idempotent: two calls over the same fixture produce byte-identical output", async () => {
  const { generateCodexConfig } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const first = generateCodexConfig({ projectDir });
    const second = generateCodexConfig({ projectDir });
    assert.equal(first.agentsMdBlock, second.agentsMdBlock);
    assert.equal(first.agentsToml, second.agentsToml);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("routing.json override: agents.<id>.model replaces the openai specialist's model in the TOML fragment", async () => {
  const { generateCodexConfig } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const routingPath = join(projectDir, ".claude", "tycoon", "routing-override.json");
    writeFileSync(
      routingPath,
      JSON.stringify({ version: 1, agents: { "codex-reviewer": { model: "openai/gpt-6-astra-alt" } } }),
      "utf8"
    );
    const { agentsToml } = generateCodexConfig({ projectDir, routingPath });
    assert.match(agentsToml, /model = "gpt-6-astra-alt"/);
    assert.ok(!agentsToml.includes("openai/"));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("AGENTS.md block carries briefing, narrow-exception, cost, verify and review guidance with no Claude-only terms", async () => {
  const { generateCodexConfig } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const { agentsMdBlock } = generateCodexConfig({ projectDir });
    for (const heading of [
      "### Narrow exceptions: a known-path read, and answering a quick question",
      "### Cost routing",
      "### Writing the brief",
      "### Verify and review",
    ]) {
      assert.ok(agentsMdBlock.includes(heading), `missing ${heading}`);
    }
    assert.match(agentsMdBlock, /Reading three or\s+more files to answer one question is a survey/);
    assert.match(agentsMdBlock, /under 250 words/);
    assert.match(agentsMdBlock, /Proportionality/);
    assert.match(agentsMdBlock, /project-plan/);
    assert.match(agentsMdBlock, /re-read the\s+changed files on disk/);
    assert.match(agentsMdBlock, /one review pass/);
    // existing delegation text is unchanged
    for (const old of [
      "never edit, grep, or explore the codebase directly.",
      "1. An explicit specialist name in the request always wins.",
      "### Leaf-worker rule",
      "Do NOT spawn a native Codex agent for these",
      "that is a violation of its brief, not a valid step.",
    ]) {
      assert.ok(agentsMdBlock.replace(/\s+/g, " ").includes(old.replace(/\s+/g, " ")), `lost: ${old}`);
    }
    for (const forbidden of [/Task tool/i, /subagent_type/i, /\bHaiku\b/i, /\bSonnet\b/i, /\bOpus\b/i, /SubagentStart/i, /visualization/i, /session[- ]journal/i]) {
      assert.doesNotMatch(agentsMdBlock, forbidden);
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("upsertCodexBlock replaces only the managed block and preserves user text", async () => {
  const { generateCodexConfig, upsertCodexBlock } = await dynamicImport(SCRIPT_URL);
  const { projectDir } = makeRosterFixture();
  try {
    const { agentsMdBlock } = generateCodexConfig({ projectDir });
    const existing =
      "# My notes\n\nkeep me\n\n<!-- TYCOON-CODEX-MANAGED:START -->\nold outdated block\n<!-- TYCOON-CODEX-MANAGED:END -->\n\ntrailer text\n";
    const out = upsertCodexBlock(existing, agentsMdBlock);
    assert.ok(out.startsWith("# My notes\n\nkeep me\n\n"));
    assert.ok(out.endsWith("\n\ntrailer text\n"));
    assert.ok(!out.includes("old outdated block"));
    assert.ok(out.includes("### Writing the brief"));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
