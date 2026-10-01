/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Shared driver for the per-bridge smoke tests (plan task p98-t4): spawns a
// real bridge process with process.execPath and speaks newline-delimited
// MCP JSON-RPC over stdio. Every child is tracked and killed in cleanup().

import { spawn, type ChildProcess } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bridge = require("../../../hooks/bridge-result.cjs") as {
  parseBridgeResult: (r: unknown) => Envelope | null;
};

export interface Envelope {
  status: string;
  provider: string;
  model: string;
  summary: string;
  truncated: boolean;
  error?: { kind: string; message: string };
}
export interface CallResult {
  content?: { type?: string; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
export interface Reply {
  result?: CallResult;
  error?: unknown;
}

const live = new Set<ChildProcess>();

/** Kills every bridge process this helper spawned and has not yet seen exit. */
export function cleanupBridges(): void {
  for (const c of live) {
    try { c.stdin?.end(); } catch { /* ignore */ }
    try { c.kill(); } catch { /* ignore */ }
  }
  live.clear();
}

/** Spawns `script`, sends initialize + one tools/call (id 2), resolves with the id-2 reply (null after waitMs), then closes the bridge. */
export function callBridge(
  script: string,
  env: NodeJS.ProcessEnv,
  params: Record<string, unknown>,
  waitMs = 15_000,
): Promise<{ reply: Reply | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    live.add(child);
    let buffer = "";
    let stderr = "";
    let reply: Reply | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(giveUp);
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      live.delete(child);
      resolve({ reply, stderr });
    };
    child.on("error", finish);
    child.stderr.on("data", (c) => { stderr += c; });
    child.stdout.on("data", (c) => {
      buffer += c;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) { reply = msg; finish(); }
        } catch { /* non-JSON line */ }
      }
    });
    child.on("close", finish);
    const giveUp = setTimeout(finish, waitMs);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params }) + "\n");
  });
}

/** Parses the reply's structuredContent with parseBridgeResult and asserts nothing about status; throws if absent. */
export function envelopeOf(reply: Reply | null): Envelope {
  if (!reply || !reply.result) throw new Error("expected a tools/call result, got " + JSON.stringify(reply));
  const env = bridge.parseBridgeResult(reply.result);
  if (!env) throw new Error("expected a bridge envelope in structuredContent, got " + JSON.stringify(reply));
  return env;
}
