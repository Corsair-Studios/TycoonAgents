import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeVendorBridgeSetups, isRegistrableBridgeServer, bridgeServersForRoutingProfile } from '../src/core/bridgeSetup';

/*
 * describeVendorBridgeSetups feeds the Claude Code slot card status line
 * ("Codex server will be set up when you click Save" / installed / not enabled).
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vbs-'));
}

test('describeVendorBridgeSetups: absent and pending (.mcp.json only) servers are reported per server, by vendor', () => {
  const root = tmpRoot();
  try {
    const env = {} as NodeJS.ProcessEnv;
    const probe = () => ({});
    const none = describeVendorBridgeSetups({ root, harness: 'claude-code', env, probe });
    assert.equal(none.servers.codex, 'absent');
    assert.equal(none.vendors.openai?.server, 'codex');
    assert.equal(none.vendors.openai?.serverState, 'missing');
    assert.equal(none.vendors.google?.server, 'gemini');
    assert.equal(none.vendors.xai?.server, 'openai-compatible');

    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { codex: { command: 'codex', args: ['mcp-server'] } } }));
    const pending = describeVendorBridgeSetups({ root, harness: 'claude-code', env, probe });
    assert.equal(pending.servers.codex, 'pending');
    assert.equal(pending.vendors.openai?.serverState, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('describeVendorBridgeSetups: nothing off the Claude Code harness or without a project root', () => {
  const env = {} as NodeJS.ProcessEnv;
  assert.deepEqual(describeVendorBridgeSetups({ root: tmpRoot(), harness: 'codex', env }), { servers: {}, vendors: {} });
  assert.deepEqual(describeVendorBridgeSetups({ root: '', harness: 'claude-code', env }), { servers: {}, vendors: {} });
});

test('isRegistrableBridgeServer: only the servers Save may register', () => {
  for (const s of ['codex', 'gemini', 'openai-compatible', 'claude-cli']) assert.equal(isRegistrableBridgeServer(s), true, s);
  for (const s of ['playwright', '', undefined, 5]) assert.equal(isRegistrableBridgeServer(s), false, String(s));
});

test('a slot saved as vendor openai + transport mcp + server codex registers codex when it is new or changed', () => {
  const next = { version: 1, agents: { 'coding-specialist': { vendor: 'openai', model: 'openai/gpt-5.6-sol', transport: 'mcp', mcpServer: 'codex' } } };
  const before = { version: 1, agents: { 'coding-specialist': { vendor: 'openai', model: 'openai/gpt-5.6-sol', transport: 'claude-native' } } };
  assert.deepEqual(bridgeServersForRoutingProfile(next, before), ['codex']);
  assert.deepEqual(bridgeServersForRoutingProfile(next, next), []);
});
