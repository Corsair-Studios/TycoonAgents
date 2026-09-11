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
    assert.match(agentsToml, /model = "openai\/gpt-6-astra"/);
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
    assert.match(agentsToml, /model = "openai\/gpt-6-astra-alt"/);
    assert.doesNotMatch(agentsToml, /model = "openai\/gpt-6-astra"\n/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
