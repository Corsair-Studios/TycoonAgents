// TycoonAgents standalone — Roster drift + readiness routing-override
// integration test (p52-t3). Exercises GET_TEAM_SETUP_DRIFT and
// CHECK_TEAM_READINESS through server.mjs end to end (startServer() + POST
// /message + SSE /events), following the harness pattern in
// standalone/test/teamSetupApply.test.mjs and the fixture pattern in
// standalone/test/teamSetupExport.test.mjs. Requires the compiled
// out/src/host/vscode/teamSetupHost.js (run `npx tsc -p .` first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mkTempAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-drift-'));
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

function addSearchRetrievalAgent(root) {
  const agentsDir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'search-retrieval.md'),
    '---\nname: Search Retrieval\n---\n\n# Search Retrieval\n\n## Role\nFinds things.\n',
    'utf8',
  );
}

function writeRouting(root, agents, defaultFallback) {
  const dir = path.join(root, '.claude', 'tycoon');
  fs.mkdirSync(dir, { recursive: true });
  const payload = { version: 1, agents };
  if (defaultFallback) payload.defaultFallback = defaultFallback;
  fs.writeFileSync(path.join(dir, 'routing.json'), JSON.stringify(payload, null, 2), 'utf8');
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

function assertNoAbsolutePaths(payload, roots) {
  const text = JSON.stringify(payload);
  for (const root of roots) {
    assert.ok(!text.includes(root), `payload leaked absolute path ${root}: ${text}`);
  }
}

test('roster drift + readiness routing override, through startServer', async (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-drift-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-drift-b-'));
  try {
    seedFixtureProject(rootA);

    await t.test('1) fresh clone: drift true before apply, false after apply', async () => {
      await withSseServer(rootA, async ({ post, nextOfType }) => {
        await post({ type: 'EXPORT_TEAM_SETUP' });
        const exported = await nextOfType('TEAM_SETUP_EXPORTED');
        assert.equal(exported.payload.ok, true, `export failed: ${exported.payload.error}`);
      });

      fs.mkdirSync(path.join(rootB, '.claude'), { recursive: true });
      fs.copyFileSync(
        path.join(rootA, '.claude', 'tycoon-team.json'),
        path.join(rootB, '.claude', 'tycoon-team.json'),
      );

      await withSseServer(rootB, async ({ post, nextOfType }) => {
        await post({ type: 'GET_TEAM_SETUP_DRIFT' });
        const before = await nextOfType('TEAM_SETUP_DRIFT');
        assert.equal(before.payload.hasManifest, true);
        assert.equal(before.payload.rosterChanged, true, 'no applied stamp yet => rosterChanged true');
        assert.equal(before.payload.drift, true);
        assertNoAbsolutePaths(before.payload, [rootA, rootB]);

        await post({ type: 'APPLY_TEAM_SETUP' });
        const applied = await nextOfType('TEAM_SETUP_APPLIED');
        assert.equal(applied.payload.ok, true, `apply failed: ${applied.payload.error}`);
        assertNoAbsolutePaths(applied.payload, [rootA, rootB]);

        await post({ type: 'GET_TEAM_SETUP_DRIFT' });
        const after = await nextOfType('TEAM_SETUP_DRIFT');
        assert.equal(after.payload.rosterChanged, false);
        assert.equal(after.payload.routingChanged, false);
        assert.equal(after.payload.drift, false);
      });
    });

    await t.test('2) re-export after only a routing.json model change: roster unchanged, routing informational', async () => {
      writeRouting(rootA, { 'coding-specialist': { vendor: 'codex', model: 'gpt-5' } });
      await withSseServer(rootA, async ({ post, nextOfType }) => {
        await post({ type: 'EXPORT_TEAM_SETUP' });
        const exported = await nextOfType('TEAM_SETUP_EXPORTED');
        assert.equal(exported.payload.ok, true, `export failed: ${exported.payload.error}`);
      });

      fs.copyFileSync(
        path.join(rootA, '.claude', 'tycoon-team.json'),
        path.join(rootB, '.claude', 'tycoon-team.json'),
      );

      await withSseServer(rootB, async ({ post, nextOfType }) => {
        await post({ type: 'GET_TEAM_SETUP_DRIFT' });
        const drift = await nextOfType('TEAM_SETUP_DRIFT');
        assert.equal(drift.payload.rosterChanged, false, 'same roster as the already-applied stamp');
        assert.equal(drift.payload.routingChanged, true, 'exportedAt moved while roster hash held');
        // getTeamSetupDriftHost defines drift = rosterChanged || routingChanged
        // (src/host/vscode/teamSetupHost.ts), so an informational routing
        // change still flips the combined `drift` flag.
        assert.equal(drift.payload.drift, true);
        assertNoAbsolutePaths(drift.payload, [rootA, rootB]);
      });
    });

    await t.test('3) adding a roster agent flips rosterChanged/drift true', async () => {
      addSearchRetrievalAgent(rootA);
      await withSseServer(rootA, async ({ post, nextOfType }) => {
        await post({ type: 'EXPORT_TEAM_SETUP' });
        const exported = await nextOfType('TEAM_SETUP_EXPORTED');
        assert.equal(exported.payload.ok, true, `export failed: ${exported.payload.error}`);
      });

      fs.copyFileSync(
        path.join(rootA, '.claude', 'tycoon-team.json'),
        path.join(rootB, '.claude', 'tycoon-team.json'),
      );

      await withSseServer(rootB, async ({ post, nextOfType }) => {
        await post({ type: 'GET_TEAM_SETUP_DRIFT' });
        const drift = await nextOfType('TEAM_SETUP_DRIFT');
        assert.equal(drift.payload.rosterChanged, true);
        assert.equal(drift.payload.drift, true);
        assertNoAbsolutePaths(drift.payload, [rootA, rootB]);

        // Apply the new roster on B so scenario 4 starts from a clean,
        // fully-applied state (search-retrieval agent file now present).
        await post({ type: 'APPLY_TEAM_SETUP' });
        const applied = await nextOfType('TEAM_SETUP_APPLIED');
        assert.equal(applied.payload.ok, true, `apply failed: ${applied.payload.error}`);
        assert.ok(fs.existsSync(path.join(rootB, '.claude', 'agents', 'search-retrieval.md')));
      });
    });

    await t.test('4) local routing.json edit on B: routingMatches false, second apply keeps local routing byte-identical', async () => {
      writeRouting(rootB, { 'coding-specialist': { vendor: 'local-vendor', model: 'local-model' } });
      const routingPath = path.join(rootB, '.claude', 'tycoon', 'routing.json');
      const routingBefore = fs.readFileSync(routingPath, 'utf8');

      await withSseServer(rootB, async ({ post, nextOfType }) => {
        await post({ type: 'CHECK_TEAM_READINESS' });
        const report = await nextOfType('TEAM_READINESS_REPORT');
        assert.equal(report.payload.ok, true, `readiness failed: ${report.payload.error}`);
        const coding = report.payload.report.agents.find((a) => a.id === 'coding-specialist');
        assert.ok(coding, 'coding-specialist must appear in the readiness report');
        assert.equal(coding.routingMatches, false);
        assert.deepEqual(coding.local, { vendor: 'local-vendor', model: 'local-model' });
        assert.equal(coding.team.vendor, 'codex');
        assert.equal(coding.team.model, 'gpt-5');
        assertNoAbsolutePaths(report.payload, [rootA, rootB]);

        // Re-apply an unchanged manifest: routing.json must be untouched.
        await post({ type: 'APPLY_TEAM_SETUP' });
        const applied = await nextOfType('TEAM_SETUP_APPLIED');
        assert.equal(applied.payload.ok, true, `apply failed: ${applied.payload.error}`);
      });

      const routingAfter = fs.readFileSync(routingPath, 'utf8');
      assert.equal(routingAfter, routingBefore, 'applyTeamSetupHost must never touch local routing.json');
    });
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});
