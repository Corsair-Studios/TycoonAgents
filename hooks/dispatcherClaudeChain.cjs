"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan p99-t2: in-process provider fallback for the Claude Code host.
 *
 * On the Claude host a foreign agent is a Sonnet subagent bound to one MCP
 * bridge, and no hook can re-run it on another provider (p97 spike). When the
 * agent instead calls the dispatcher's `delegate` tool, the whole provider
 * chain runs inside that one tool call: each step is driven in code (the
 * step's configured bridge via dispatcherBridgeClient.cjs, or a vendor
 * adapter when the step has no bridge), the shared bridge-result envelope is
 * parsed, and the next routing-chain step runs on provider_error / timeout /
 * empty. The first ok envelope is returned; an exhausted chain returns a
 * structured provider_error listing every attempt - never anything an agent
 * could read as an approval.
 *
 * Chain rules come from fallbackChain.js (resolveNextFallback): explicit
 * chain first, then defaultFallback unless the slot opted out, default never
 * equal to an attempted slot. This module adds the depth cap (at most
 * MAX_FALLBACK_DEPTH fallback calls after the primary) and a self-loop guard
 * for explicit chain entries identical to an already-attempted slot.
 *
 * Attribution: only the provider that ACTUALLY answered is attributed. A
 * fallback answer writes a Task-shaped PreToolUse (fallbackOf/fallbackDepth/
 * fallbackIsDefault + the answering vendor/model/costModelClass) and its
 * SubagentStop; every failed step writes a FallbackTriggered record. The
 * returned envelope carries `attempts`, which tells hooks/tycoon-claude-hook.cjs
 * the fallback already happened in-process (it then injects no re-dispatch).
 */

const fs = require("fs");
const crypto = require("crypto");

const bridgeResult = require("./bridge-result.cjs");
const bridgeClient = require("./dispatcherBridgeClient.cjs");
const dispatcherAdapters = require("./dispatcherAdapters.cjs");

/** Mirrors MAX_FALLBACK_DEPTH in src/core/fallbackChain.ts / routingProfile.ts. */
const MAX_FALLBACK_DEPTH = 3;
const CONTEXT_TAIL_BYTES = 256 * 1024;

function slotKey(slot) {
  return [slot.vendor || "", slot.model || "", slot.transport || "", slot.mcpServer || ""].join("|");
}

function slotLabel(slot) {
  const who = slot.vendor || slot.mcpServer || "unknown";
  return slot.model ? `${who}/${slot.model}` : who;
}

/** Minimal parse of the `backend:` block of an agent .md (agentBackend.js is a build artifact, so not required here). */
function parseBackendFromAgentFile(agentFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(agentFilePath, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  } catch {
    return undefined;
  }
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const block = fm[1].match(/^backend:\s*\n((?:[ \t]+.+\n?)+)/m);
  if (!block) return undefined;
  const out = {};
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] === "tools") {
      const list = value.match(/^\[(.*)\]$/);
      out.tools = list ? list[1].split(",").map((s) => s.trim()).filter(Boolean) : value ? [value] : [];
    } else if (value) {
      out[m[1]] = value;
    }
  }
  return out;
}

/** Newest non-fallback spawn record for workerId in activity.jsonl -> { sessionId?, parentId? } (best effort). */
function findSpawnContext(activityFile, workerId) {
  const ctx = {};
  if (process.env.TYCOON_SESSION_ID) ctx.sessionId = process.env.TYCOON_SESSION_ID;
  try {
    const stat = fs.statSync(activityFile);
    const start = Math.max(0, stat.size - CONTEXT_TAIL_BYTES);
    const fd = fs.openSync(activityFile, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        let rec;
        try { rec = JSON.parse(lines[i]); } catch { continue; }
        if (rec && rec.workerId === workerId && (rec.tool === "Agent" || rec.tool === "Task") && rec.event === "PreToolUse" && rec.fallbackOf === undefined) {
          if (ctx.sessionId === undefined && typeof rec.sessionId === "string") ctx.sessionId = rec.sessionId;
          if (typeof rec.parentId === "string") ctx.parentId = rec.parentId;
          break;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* best effort: records are written without a session id */ }
  return ctx;
}

function modelArgFor(slot) {
  if (slot.transport === "openai-compatible") return slot.model;
  if (slot.mcpServer === "claude-cli" && slot.model) return slot.model.replace(/^anthropic\//i, "");
  return undefined;
}

/** Runs one chain step. Always resolves to a normalized attempt (see dispatcherBridgeClient.normalizeAttempt). */
async function runStep(slot, ctx) {
  const info = { provider: slot.vendor || slot.mcpServer || "", model: slot.model || "" };
  const childEnv = { TYCOON_DISPATCH_DEPTH: "1" };

  if (slot.mcpServer) {
    const toolName = (Array.isArray(slot.tools) && slot.tools[0]) || bridgeClient.defaultToolForServer(slot.mcpServer);
    if (!toolName) {
      return bridgeClient.normalizeAttempt(
        { error: `No tool configured for MCP server "${slot.mcpServer}" (set backend.tools).`, kind: "not_configured" },
        info,
      );
    }
    const toolArgs = { prompt: ctx.task };
    const model = modelArgFor(slot);
    if (model) toolArgs.model = model;
    const call = await bridgeClient.callBridgeTool({
      projectDir: ctx.projectDir,
      serverName: slot.mcpServer,
      toolName,
      toolArgs,
      timeoutMs: ctx.stepTimeoutMs,
      env: childEnv,
    });
    return bridgeClient.normalizeAttempt(call, info);
  }

  // No bridge named: fall back to the vendor adapter (claude -p for anthropic, HTTP for openai-compatible/local).
  const { fn } = dispatcherAdapters.resolveAdapter(slot.vendor);
  const prev = process.env.TYCOON_DISPATCH_DEPTH;
  process.env.TYCOON_DISPATCH_DEPTH = "1";
  let res;
  try {
    res = await fn(ctx.task, { vendor: slot.vendor, model: slot.model, workerId: ctx.workerId });
  } catch (err) {
    res = { error: err && err.message ? err.message : String(err) };
  } finally {
    if (prev === undefined) delete process.env.TYCOON_DISPATCH_DEPTH;
    else process.env.TYCOON_DISPATCH_DEPTH = prev;
  }
  if (res.error) {
    return { status: "provider_error", provider: info.provider, model: info.model, summary: "", error: { kind: bridgeResult.classifyProviderError(res.error), message: String(res.error).slice(0, 500) } };
  }
  if (!res.text || res.text.trim() === "") {
    return { status: "empty", provider: info.provider, model: info.model, summary: "", error: { kind: "empty", message: "Provider returned empty output" } };
  }
  const out = { status: "ok", provider: info.provider, model: info.model, summary: res.text };
  if (res.usage) out.usage = res.usage;
  return out;
}

function attemptEntry(slot, attempt, depth, isDefault) {
  const e = {
    provider: slot.vendor || slot.mcpServer || "",
    model: slot.model || "",
    status: attempt.status,
    depth,
  };
  if (slot.mcpServer) e.mcpServer = slot.mcpServer;
  if (attempt.error && attempt.error.kind) e.kind = attempt.error.kind;
  if (isDefault) e.isDefault = true;
  return e;
}

function describeAttempts(attempts) {
  return attempts
    .map((a, i) => `${i + 1}) ${a.provider}${a.model ? "/" + a.model : ""}: ${a.status}${a.kind ? "/" + a.kind : ""}`)
    .join("; ");
}

/**
 * ctx: { projectDir, activityFile, workerId, task, description?, primary, chain,
 *        defaultFallback?, useDefaultFallback?, fallbackChain (module|null),
 *        costModelClassOf?(slot), stepTimeoutMs? }
 * Returns an MCP CallToolResult (envelope in structuredContent + text header).
 */
async function runProviderChain(ctx) {
  const append = (rec) => {
    try { fs.appendFileSync(ctx.activityFile, JSON.stringify(rec) + "\n", "utf8"); } catch { /* telemetry never breaks a dispatch */ }
  };
  const spawnCtx = findSpawnContext(ctx.activityFile, ctx.workerId);
  const withCtx = (rec) => {
    if (spawnCtx.sessionId) rec.sessionId = spawnCtx.sessionId;
    return rec;
  };
  const fb = ctx.fallbackChain;
  const chain = Array.isArray(ctx.chain) ? ctx.chain : [];

  const attempts = [];
  const attempted = new Set();
  let slot = ctx.primary;
  let depth = 0;
  let isDefault = false;
  let resolverIndex = 0;

  const pickNext = (failedSlot) => {
    if (!fb || typeof fb.resolveNextFallback !== "function") return null;
    for (;;) {
      if (depth >= MAX_FALLBACK_DEPTH) return null;
      const res = fb.resolveNextFallback({
        slotId: ctx.workerId,
        chain,
        attemptsSoFar: resolverIndex,
        defaultFallback: ctx.defaultFallback,
        useDefaultFallback: ctx.useDefaultFallback,
        failingSlot: { vendor: failedSlot.vendor, model: failedSlot.model, transport: failedSlot.transport },
      });
      resolverIndex += 1;
      if (res.exhausted || !res.slot) return null;
      if (attempted.has(slotKey(res.slot))) {
        attempts.push({ provider: res.slot.vendor || res.slot.mcpServer || "", model: res.slot.model || "", status: "skipped", kind: "self_loop", depth: depth + 1 });
        continue;
      }
      return res;
    }
  };

  for (;;) {
    attempted.add(slotKey(slot));
    const attempt = await runStep(slot, ctx);
    attempts.push(attemptEntry(slot, attempt, depth, isDefault));

    if (attempt.status === "ok") {
      if (depth > 0) {
        const spawnId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `spawn-${Date.now()}`;
        const tokens =
          attempt.usage && (typeof attempt.usage.input_tokens === "number" || typeof attempt.usage.output_tokens === "number")
            ? (attempt.usage.input_tokens || 0) + (attempt.usage.output_tokens || 0)
            : undefined;
        const pre = withCtx({
          event: "PreToolUse",
          tool: "Task",
          workerId: ctx.workerId,
          model: slot.model,
          vendor: slot.vendor,
          fallbackOf: ctx.workerId,
          fallbackDepth: depth,
          fallbackIsDefault: isDefault,
          spawnId,
          source: "dispatcher",
          at: Date.now(),
        });
        const cmc = (ctx.costModelClassOf && ctx.costModelClassOf(slot)) || slot.costModelClass;
        if (cmc) pre.costModelClass = cmc;
        if (ctx.description) pre.description = ctx.description;
        if (spawnCtx.parentId) pre.parentId = spawnCtx.parentId;
        append(pre);
        const stop = withCtx({
          event: "SubagentStop",
          workerId: ctx.workerId,
          fallbackOf: ctx.workerId,
          fallbackDepth: depth,
          fallbackIsDefault: isDefault,
          spawnId,
          usageReported: typeof tokens === "number",
          source: "dispatcher",
          at: Date.now(),
        });
        if (typeof tokens === "number") stop.tokens = tokens;
        append(stop);
      }
      const extra = {
        tycoonDispatcher: 1,
        attempts,
        answeredBy: { provider: slot.vendor || slot.mcpServer || "", model: slot.model || "", depth, isDefault },
      };
      if (depth > 0) {
        extra.fellBackFrom = slotLabel(ctx.primary);
        extra.fallbackDepth = depth;
      }
      if (attempt.usage) extra.usage = attempt.usage;
      return bridgeResult.formatBridgeResult({
        status: "ok",
        provider: attempt.provider,
        model: attempt.model,
        text: attempt.summary,
        extra,
      });
    }

    const next = pickNext(slot);
    const reason = `${attempt.status}${attempt.error && attempt.error.kind ? "/" + attempt.error.kind : ""}: ${attempt.error ? attempt.error.message : ""}`.slice(0, 300);
    const trig = withCtx({
      event: "FallbackTriggered",
      workerId: ctx.workerId,
      slotId: ctx.workerId,
      failedModel: slot.model,
      fallbackIsDefault: !!(next && next.isDefault === true),
      reason,
      bridgeStatus: attempt.status,
      source: "dispatcher",
      at: Date.now(),
    });
    if (next && next.slot.model) trig.nextModel = next.slot.model;
    if (attempt.error && attempt.error.kind) trig.bridgeErrorKind = attempt.error.kind;
    append(trig);

    if (!next) break;
    slot = next.slot;
    isDefault = next.isDefault === true;
    depth += 1;
  }

  const failed = attempts.filter((a) => a.status !== "skipped");
  const message =
    failed.length > 1 || attempts.length > failed.length
      ? `delegate: every provider in the chain for ${ctx.workerId} failed (${describeAttempts(attempts)}). This is not a review result; report the provider failure.`
      : `delegate: ${ctx.workerId} failed on ${slotLabel(ctx.primary)} (${describeAttempts(attempts)}) and no fallback provider is configured. This is not a review result; report the provider failure.`;
  const last = failed[failed.length - 1];
  append(
    withCtx({
      event: "ProviderError",
      reason: "dispatch-failed",
      workerId: ctx.workerId,
      model: slot.model,
      vendor: slot.vendor,
      message: message.slice(0, 500),
      source: "dispatcher",
      at: Date.now(),
    }),
  );
  return bridgeResult.formatBridgeResult({
    status: "provider_error",
    provider: "tycoon-dispatcher",
    model: "",
    text: message,
    error: { kind: failed.length > 1 ? "chain_exhausted" : (last && last.kind) || "provider_error", message },
    extra: { tycoonDispatcher: 1, attempts, exhausted: true },
  });
}

module.exports = {
  MAX_FALLBACK_DEPTH,
  parseBackendFromAgentFile,
  findSpawnContext,
  runProviderChain,
};
