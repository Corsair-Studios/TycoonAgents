#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * ---------------------------------------------------------------------------
 * One-shot smoke test for the xAI Grok bridge: spawns the real
 * hooks/openai-compatible-mcp.cjs MCP stdio server, sends it a tiny
 * tools/call against the cheap grok-build-0.1 model, and prints ONLY the
 * model's reply and token usage. Never prints, logs, or echoes XAI_API_KEY —
 * the key is read from the environment and handed to the child process via
 * its env, never passed as a CLI argument (which would be visible in a
 * process list) and never written to stdout/stderr by this script.
 *
 * Usage (bash/zsh):
 *   XAI_API_KEY=... node scripts/smoke-test-grok-bridge.mjs
 *   XAI_API_KEY=... node scripts/smoke-test-grok-bridge.mjs "your prompt here"
 *
 * Usage (PowerShell): the key is always read from the environment (never
 * from an argument), so if XAI_API_KEY is already set as a user/session env
 * var, just run:
 *   npm run smoke-test:grok
 * Otherwise, set it for the current session first:
 *   $env:XAI_API_KEY = "..."
 *   npm run smoke-test:grok
 *
 * This makes a REAL network call to https://api.x.ai/v1 and spends a small
 * amount of real xAI credit (grok-build-0.1 is the cheap tier, $1 in / $2
 * out per MTok) — run it deliberately, not from an automated test suite.
 * ---------------------------------------------------------------------------
 */

"use strict";

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.join(__dirname, "..", "hooks", "openai-compatible-mcp.cjs");

const MODEL = "xai/grok-build-0.1";
const DEFAULT_PROMPT = "Reply with exactly one short sentence confirming you received this message.";

function main() {
  if (!process.env.XAI_API_KEY) {
    console.error("XAI_API_KEY is not set in the environment. Set it, then re-run:\n  XAI_API_KEY=... node scripts/smoke-test-grok-bridge.mjs");
    process.exitCode = 1;
    return;
  }
  const prompt = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT;

  const child = spawn(process.execPath, [HOOK_PATH], {
    env: process.env, // XAI_API_KEY passes through env only, never as an argv entry
    stdio: ["pipe", "pipe", "inherit"],
  });

  let buffer = "";
  let nextId = 1;
  let settled = false;

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.error("Timed out waiting for the bridge after 30s.");
    child.kill();
    process.exitCode = 1;
  }, 30000);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      handleLine(line);
    }
  });

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a JSON-RPC/NDJSON line — ignore per the server's own contract
    }
    if (msg.id === 1 && msg.result) {
      // initialize -> initialized -> tools/call
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: (nextId = 2),
        method: "tools/call",
        params: { name: "chat", arguments: { model: MODEL, prompt } },
      });
      return;
    }
    if (msg.id === 2) {
      clearTimeout(timeout);
      settled = true;
      const result = msg.result;
      if (result && result.isError) {
        console.error("Bridge returned an error:", result.content && result.content[0] && result.content[0].text);
        process.exitCode = 1;
      } else if (result && result.content && result.content[0]) {
        console.log("Model reply:\n" + result.content[0].text);
        const usage = result.structuredContent && result.structuredContent.usage;
        if (usage) {
          console.log(`\nToken usage: input=${usage.input_tokens} output=${usage.output_tokens}`);
        } else {
          console.log("\nToken usage: not reported by the endpoint.");
        }
      } else {
        console.error("Unexpected response shape:", JSON.stringify(result));
        process.exitCode = 1;
      }
      child.kill();
      return;
    }
    // any other line (e.g. the belt-and-suspenders trailing usage NDJSON line) is ignored here
  }

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
}

main();
