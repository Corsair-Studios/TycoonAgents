// TycoonAgents standalone — Apply Team Setup integration test (p49-t2).
//
// Exercises handleApplyTeamSetupStandalone (standalone/src/teamSetupMessages.mjs)
// through server.mjs's APPLY_TEAM_SETUP case end to end: startServer() + POST
// /message + SSE /events, following the pattern in
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-apply-'));
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

test('APPLY_TEAM_SETUP through startServer: export then apply on root B, SSE TEAM_SETUP_APPLIED ok:true, steps shape, skipped steps carry detail', async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-apply-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-apply-b-'));
  try {
    seedFixtureProject(rootA);

    // Export from root A via its own server instance, then copy the manifest
    // into an otherwise-empty root B.
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
    assert.ok(!fs.existsSync(path.join(rootB, '.claude', 'agents')));

    await withSseServer(rootB, async ({ post, nextOfType }) => {
      await post({ type: 'APPLY_TEAM_SETUP' });
      const applied = await nextOfType('TEAM_SETUP_APPLIED');
      assert.equal(applied.payload.ok, true, `apply failed: ${applied.payload.error}`);
      assert.equal(typeof applied.payload.changed, 'boolean');
      assert.ok(Array.isArray(applied.payload.steps));
      assert.ok(applied.payload.steps.length > 0);
      for (const step of applied.payload.steps) {
        assert.equal(typeof step.name, 'string');
        assert.ok(['done', 'skipped', 'failed'].includes(step.status));
        if (step.status === 'skipped') {
          assert.equal(typeof step.detail, 'string');
          assert.ok(step.detail.length > 0, `skipped step "${step.name}" must carry a detail string`);
        }
      }
      assert.ok(Array.isArray(applied.payload.missingAgents));

      assert.ok(fs.existsSync(path.join(rootB, '.claude', 'agents', 'coding-specialist.md')));
    });
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});
