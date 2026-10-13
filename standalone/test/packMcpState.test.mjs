// Standalone getPacks / getMcp payloads: a server listed only in the project's .mcp.json
// (Claude Code harness) is "pending", not installed, and its pack is not fully installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Keep off the real ~/.claude.json and the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-claude-cfg-'));
process.env.TYCOON_CLAUDE_BIN = 'none';

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-packmcp-'));
}

async function collectSseEvent(reader, matchType, maxChunks = 80) {
  let buffer = '';
  for (let i = 0; i < maxChunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += Buffer.from(value).toString('utf8');
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      try {
        const parsed = JSON.parse(dataLine.slice(5).trim());
        if (parsed && parsed.type === matchType) return parsed;
      } catch {
        /* not json */
      }
    }
  }
  throw new Error(`no ${matchType} event`);
}

async function post(runtime, type) {
  const res = await fetch(`${runtime.url}/message`, {
    method: 'POST',
    headers: { 'X-Tycoon-Token': runtime.sessionToken },
    body: JSON.stringify({ type }),
  });
  assert.equal(res.status, 202);
}

test('Playwright pack with playwright only in .mcp.json: mcpState pending, not installed, pack not fully installed; MCP tab pending', async () => {
  const projectRoot = mkTemp();
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'node', args: [] } } }));
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'media', 'packs', 'catalog.json'), 'utf8'));
  const pack = catalog.find((p) => p.mcp === 'playwright');
  assert.ok(pack, 'a catalog pack bundles the playwright server');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: path.join(mkTemp(), 'appdata') },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();

    const packsP = collectSseEvent(reader, 'packs');
    await post(runtime, 'getPacks');
    const packs = await packsP;
    const row = packs.packs.find((p) => p.id === pack.id);
    assert.equal(row.mcpId, 'playwright');
    assert.equal(row.mcpState, 'pending');
    assert.equal(row.has.mcp, true);
    assert.equal(row.installed.mcp, false, 'pending is not installed');
    const fully = Object.keys(row.has).every((k) => !row.has[k] || row.installed[k]);
    assert.equal(fully, false, 'pack must not count as fully installed');
    for (const p of packs.packs.filter((x) => !x.has.mcp)) {
      assert.equal('mcpState' in p, false, `${p.id} has no mcp so no mcpState`);
      assert.equal('mcpId' in p, false);
    }

    const mcpP = collectSseEvent(reader, 'mcp');
    await post(runtime, 'getMcp');
    const mcp = await mcpP;
    const server = mcp.servers.find((s) => s.id === 'playwright');
    assert.equal(server.installed, false);
    assert.equal(server.pending, true);
  } finally {
    controller.abort();
    await runtime.close();
  }
});

test('no .mcp.json and no local scope: playwright pack reports mcpState absent', async () => {
  const projectRoot = mkTemp();
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'media', 'packs', 'catalog.json'), 'utf8'));
  const pack = catalog.find((p) => p.mcp === 'playwright');
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: path.join(mkTemp(), 'appdata') },
    cwd: projectRoot,
  });
  const controller = new AbortController();
  try {
    const eventsRes = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = eventsRes.body.getReader();
    const packsP = collectSseEvent(reader, 'packs');
    await post(runtime, 'getPacks');
    const row = (await packsP).packs.find((p) => p.id === pack.id);
    assert.equal(row.mcpState, 'absent');
    assert.equal(row.installed.mcp, false);
  } finally {
    controller.abort();
    await runtime.close();
  }
});
