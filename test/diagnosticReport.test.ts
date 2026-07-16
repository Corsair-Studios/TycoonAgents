/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitize,
  buildDiagnosticReport,
  type DiagnosticReportInput,
} from "../src/host/vscode/diagnosticReport";

const FIXED_TIMESTAMP = "2026-07-15T12:00:00.000Z";

function minimalInput(overrides: Partial<DiagnosticReportInput> = {}): DiagnosticReportInput {
  return {
    timestamp: FIXED_TIMESTAMP,
    roots: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sanitize()
// ---------------------------------------------------------------------------

test("sanitize: replaces the project root (either slash style) with ${PROJECT_ROOT}", () => {
  const text = "Found at D:\\ACode\\TycoonAgents\\.claude\\agents\\foo.md and D:/ACode/TycoonAgents/bar.md";
  const out = sanitize(text, { projectRoot: "D:\\ACode\\TycoonAgents" });
  assert.ok(!out.includes("D:\\ACode\\TycoonAgents"), "backslash form must be stripped");
  assert.ok(!out.includes("D:/ACode/TycoonAgents"), "forward-slash form must be stripped");
  assert.ok(out.includes("${PROJECT_ROOT}"), "placeholder must be present");
});

test("sanitize: replaces the home dir with ~ and the extension dir with ${EXTENSION_DIR}", () => {
  const text = "home: C:\\Users\\alice\\file.txt ext: C:\\Users\\alice\\.vscode\\extensions\\tycoonagents-0.0.1";
  const out = sanitize(text, {
    homeDir: "C:\\Users\\alice",
    extensionDir: "C:\\Users\\alice\\.vscode\\extensions\\tycoonagents-0.0.1",
  });
  // The extension dir (more specific/longer) must be folded before the
  // shorter home dir swallows part of it.
  assert.ok(out.includes("${EXTENSION_DIR}"));
  assert.ok(!out.includes("tycoonagents-0.0.1"));
});

test("sanitize: generic fallback strips a leftover absolute path not matching any known root", () => {
  const text = "Unrelated path: C:\\Some\\Other\\Machine\\Specific\\Dir\\notes.txt";
  const out = sanitize(text, { projectRoot: "D:\\ACode\\TycoonAgents" });
  assert.ok(!out.includes("C:\\Some\\Other\\Machine"), "unrelated absolute path must still be redacted");
  assert.ok(out.includes("<path>"));
});

test("sanitize: generic fallback also strips single-segment absolute Unix paths", () => {
  const out = sanitize("Log at /tmp/foo and cache dir /root not under any known root", {});
  assert.ok(!out.includes("/tmp/foo"), "multi-segment single-level path must be redacted");
  assert.ok(!out.includes("/root "), "bare single-segment absolute path must be redacted");
  assert.ok(out.includes("<path>"));
});

test("sanitize: does not redact ordinary prose containing a slash", () => {
  const text = "Configure read/write access and/or permissions.";
  assert.equal(sanitize(text, {}), text, "non-path slash text must be left intact");
});

test("sanitize: skips a degenerate root (bare drive letter) instead of over-redacting", () => {
  const text = "Unrelated mention of C: drive space and C:\\actual\\path\\file.txt";
  const out = sanitize(text, { projectRoot: "C:" });
  // The degenerate root itself must not fold into a pattern that nukes
  // every "C:" occurrence in the text.
  assert.ok(out.includes("C: drive space"), "bare drive-letter root must not over-redact unrelated text");
});

test("sanitize: redacts a fake sk- style token", () => {
  const out = sanitize("api key sk-abcdefghij1234567890 in the log", {});
  assert.ok(!out.includes("sk-abcdefghij1234567890"));
  assert.ok(out.includes("[REDACTED]"));
});

test("sanitize: redacts a fake ghp_ style token", () => {
  const out = sanitize("token ghp_1234567890abcdefghij in the log", {});
  assert.ok(!out.includes("ghp_1234567890abcdefghij"));
  assert.ok(out.includes("[REDACTED]"));
});

test("sanitize: redacts a long hex string", () => {
  const hex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"; // 32 hex chars
  const out = sanitize(`hash=${hex}`, {});
  assert.ok(!out.includes(hex));
  assert.ok(out.includes("[REDACTED]"));
});

test("sanitize: empty/missing text and roots never throw", () => {
  assert.equal(sanitize("", {}), "");
  assert.equal(sanitize("plain text, no paths", {}), "plain text, no paths");
});

// ---------------------------------------------------------------------------
// buildDiagnosticReport()
// ---------------------------------------------------------------------------

test("buildDiagnosticReport: contains every expected section header", () => {
  const report = buildDiagnosticReport(minimalInput());
  assert.ok(report.includes("# TycoonAgents Diagnostic Report"));
  assert.ok(report.includes("## Environment"));
  assert.ok(report.includes("## Hook Health"));
  assert.ok(report.includes("## Delegation & Review"));
  assert.ok(report.includes("## Doctrine Health (CLAUDE.md)"));
  assert.ok(report.includes("## Context Budget"));
  assert.ok(report.includes("## Agent Roster Consistency"));
  assert.ok(report.includes("## Engine & UEFN"));
});

test("buildDiagnosticReport: missing/undefined optional inputs degrade to n/a, never throw", () => {
  assert.doesNotThrow(() => buildDiagnosticReport(minimalInput()));
  const report = buildDiagnosticReport(minimalInput());
  assert.ok(report.includes("n/a"));
});

test("buildDiagnosticReport: null optional fields also degrade gracefully", () => {
  const report = buildDiagnosticReport(
    minimalInput({
      hook: null,
      hookHealth: null,
      delegation: null,
      doctrine: null,
      contextBudget: null,
      roster: null,
      engines: null,
    }),
  );
  assert.ok(report.includes("# TycoonAgents Diagnostic Report"));
});

test("buildDiagnosticReport: injected timestamp appears verbatim in the header", () => {
  const report = buildDiagnosticReport(minimalInput());
  assert.ok(report.includes(FIXED_TIMESTAMP));
});

test("buildDiagnosticReport: the final sanitize pass strips an absolute path embedded in a gathered field", () => {
  const report = buildDiagnosticReport(
    minimalInput({
      roots: { projectRoot: "D:\\ACode\\TycoonAgents" },
      roster: {
        agentIds: ["coding-specialist"],
        keywordIds: ["coding-specialist", "ghost-agent"],
        danglingKeywordRefs: ["ghost-agent"],
        agentsWithNoKeywords: [],
      },
      doctrine: {
        legacyOfficeAgentsBlock: false,
        legacyOfficeAgentsLines: 0,
        foreignManagedBlocks: [],
      },
    }),
  );
  assert.ok(report.includes("ghost-agent"), "dangling reference name itself must still be visible");
  assert.ok(!report.includes("D:\\ACode\\TycoonAgents"), "no raw project-root path may leak into the report");
});

test("buildDiagnosticReport: reports dangling keyword references and keyword-less agents by name", () => {
  const report = buildDiagnosticReport(
    minimalInput({
      roster: {
        agentIds: ["coding-specialist", "silent-agent"],
        keywordIds: ["coding-specialist", "ghost-agent"],
        danglingKeywordRefs: ["ghost-agent"],
        agentsWithNoKeywords: ["silent-agent"],
      },
    }),
  );
  assert.ok(report.includes("ghost-agent"));
  assert.ok(report.includes("silent-agent"));
  assert.ok(report.includes("Dangling keyword references"));
  assert.ok(report.includes("Agents with no keywords"));
});

test("buildDiagnosticReport: hook/delegation/doctrine values render when present", () => {
  const report = buildDiagnosticReport(
    minimalInput({
      hook: { installed: true, lastActivityAt: 1_700_000_000_000 },
      hookHealth: { healthy: false, issueCount: 2 },
      delegation: { mode: "team_leads", reviewEnabled: false },
      doctrine: {
        legacyOfficeAgentsBlock: true,
        legacyOfficeAgentsLines: 12,
        foreignManagedBlocks: [{ namespace: "otheragents", lines: 5 }],
      },
    }),
  );
  assert.ok(report.includes("team_leads"));
  assert.ok(report.includes("disabled"));
  assert.ok(report.includes("2 issue(s) detected"));
  assert.ok(report.includes("present (12 lines)"));
  assert.ok(report.includes("otheragents"));
});
