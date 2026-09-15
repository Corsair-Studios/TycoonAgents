// TycoonAgents standalone — Export Team Setup integration test (p48-t4).
//
// Exercises standalone/src/teamSetupMessages.mjs's handleExportTeamSetupStandalone
// through server.mjs's EXPORT_TEAM_SETUP case end to end: startServer() + POST
// /message + SSE /events, following the pattern in
// standalone/test/themeServiceStandalone.test.mjs's "through startServer" test.
// Asserts the broadcast TEAM_SETUP_EXPORTED payload and the written
// .claude/tycoon-team.json file. The pure builder/validator (src/core/teamSetup.ts)
// and the vscode-host integration (exportTeamSetup) are covered by
// test/teamSetup.test.ts and test/teamSetupExport.test.ts respectively; this
// file only proves the standalone server wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mkTempAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-'));
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

test('EXPORT_TEAM_SETUP through startServer: SSE TEAM_SETUP_EXPORTED payload ok:true, file written', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-teamsetup-project-'));
  const appDataDir = mkTempAppData();
  seedFixtureProject(projectRoot);

  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const res = await fetch(`${runtime.url}/events`, { signal: controller.signal });
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
    // Wait for the initial boot handshake chunk before posting.
    await reader.read();

    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'EXPORT_TEAM_SETUP' }),
    });

    const exported = await nextOfType('TEAM_SETUP_EXPORTED');
    assert.equal(exported.payload.ok, true, `export failed: ${exported.payload.error}`);
    assert.equal(exported.payload.path, '.claude/tycoon-team.json');

    const manifestPath = path.join(projectRoot, '.claude', 'tycoon-team.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest file must exist on disk');
    const text = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(text);
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.roster.some((r) => r.id === 'coding-specialist'));
  } finally {
    controller.abort();
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
});
