// TycoonAgents standalone — Team Readiness + Drift integration test (p50-t3).
//
// Exercises CHECK_TEAM_READINESS -> TEAM_READINESS_REPORT and
// GET_TEAM_SETUP_DRIFT -> TEAM_SETUP_DRIFT through server.mjs end to end:
// startServer() + POST /message + SSE /events, following the pattern in
// standalone/test/teamSetupExport.test.mjs and
// standalone/test/teamSetupApply.test.mjs. Requires the compiled
// out/src/host/vscode/teamSetupHost.js (run `npx tsc -p .` first).
//
// NOTE (missing seam): handleCheckTeamReadinessStandalone
// (standalone/src/teamSetupMessages.mjs) hardcodes its execSeam to
// child_process's execFileSync and accepts no injected override, so this
// file cannot force a specific codex/claude-CLI availability outcome through
// the server the way test/teamReadinessHost.test.ts can via
// buildTeamReadinessHost's execSeam option. This test therefore only
// asserts the TEAM_READINESS_REPORT payload shape and that hostKind
// 'standalone' is actually in effect (an anthropic agent's readiness must
// not short-circuit to "always available" the way it does under hostKind
// 'vscode') — it does not assert a specific ready/not_ready outcome for the
// real machine's claude CLI, since that depends on what's actually on PATH
// in CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mkTempAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-readiness-'));
}

function seedFixtureProject(root) {
  const agentsDir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'coding-specialist.md'),
    '---\nname: Coding Specialist\n---\n\n# Coding Specialist\n\n## Role\nImplements things.\n',
    'utf8',
  );
}

async function withSseServer(projectRoot, fn) {
  const appDataDir = mkTempAppData();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const res = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = res.body.getReader();
    let buffer = '';
    async function nextOfType(matchType, maxChunks = 100) {
      for (let i = 0; i < maxChunks; i++) {
        let sepIndex;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) {
            const data = JSON.parse(dataLine.slice('data: '.length));
            if (data.type === matchType) return data;
          }
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString('utf8');
      }
      throw new Error(`no matching "${matchType}" event within ${maxChunks} reads`);
    }
    await reader.read(); // initial boot handshake chunk

    async function post(body) {
      return fetch(`${runtime.url}/message`, {
        method: 'POST',
        headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    return await fn({ runtime, post, nextOfType });
  } finally {
    controller.abort();
    await runtime.close();
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
}

test('GET_TEAM_SETUP_DRIFT through startServer: no manifest -> hasManifest false; after export, no stamp -> drift true', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-readiness-drift-'));
  try {
    seedFixtureProject(projectRoot);

    await withSseServer(projectRoot, async ({ post, nextOfType }) => {
      await post({ type: 'GET_TEAM_SETUP_DRIFT' });
      const before = await nextOfType('TEAM_SETUP_DRIFT');
      assert.equal(before.payload.hasManifest, false);
      assert.equal(before.payload.drift, false);

      await post({ type: 'EXPORT_TEAM_SETUP' });
      const exported = await nextOfType('TEAM_SETUP_EXPORTED');
      assert.equal(exported.payload.ok, true, `export failed: ${exported.payload.error}`);

      await post({ type: 'GET_TEAM_SETUP_DRIFT' });
      const after = await nextOfType('TEAM_SETUP_DRIFT');
      assert.equal(after.payload.hasManifest, true);
      assert.equal(after.payload.drift, true);
      assert.equal(typeof after.payload.manifestExportedAt, 'string');
      assert.equal(after.payload.appliedExportedAt, undefined);
    });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('CHECK_TEAM_READINESS through startServer: SSE TEAM_READINESS_REPORT payload shape, no manifest -> ok:false', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-readiness-check-'));
  try {
    seedFixtureProject(projectRoot);

    await withSseServer(projectRoot, async ({ post, nextOfType }) => {
      // No manifest exported yet -> ok:false, no crash.
      await post({ type: 'CHECK_TEAM_READINESS' });
      const noManifest = await nextOfType('TEAM_READINESS_REPORT');
      assert.equal(noManifest.payload.ok, false);
      assert.equal(typeof noManifest.payload.error, 'string');

      await post({ type: 'EXPORT_TEAM_SETUP' });
      const exported = await nextOfType('TEAM_SETUP_EXPORTED');
      assert.equal(exported.payload.ok, true, `export failed: ${exported.payload.error}`);

      await post({ type: 'CHECK_TEAM_READINESS' });
      const report = await nextOfType('TEAM_READINESS_REPORT');
      assert.equal(report.payload.ok, true, report.payload.error);
      assert.ok(report.payload.report, 'report must carry a structured report object');
      assert.equal(typeof report.payload.report.summary.text, 'string');
      assert.ok(Array.isArray(report.payload.report.agents));
      assert.ok(report.payload.report.agents.length > 0);
      for (const agent of report.payload.report.agents) {
        assert.equal(typeof agent.id, 'string');
        assert.ok(['ready', 'fallback', 'not_ready'].includes(agent.status));
        assert.ok(Array.isArray(agent.missingEnv));
      }
      assert.equal(typeof report.payload.text, 'string');

      // No absolute path substring of the temp project root leaks into the
      // serialized payload — same no-path-leak contract as
      // sanitizeDetailPaths enforces in src/host/vscode/teamSetupHost.ts.
      const payloadText = JSON.stringify(report.payload);
      assert.ok(!payloadText.includes(projectRoot), 'readiness payload must not contain the project absolute root path');
    });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
