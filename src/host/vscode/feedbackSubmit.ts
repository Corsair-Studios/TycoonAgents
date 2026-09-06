/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sanitize, type SanitizeRoots } from "./diagnosticReport";
import { describeProviderSelection } from "../../core/providerSelection";
import { describeRoutingVisibility, describeAgentRoutes } from "../../core/agentSettingsRoute";
import { buildRoutingView } from "../../core/routingHostOps";
import { loadAgentRoster } from "../../providers/claude-code/agentRoster";

/**
 * "Submit Feedback" pipeline — see docs/FEEDBACK-PIPELINE-SPEC.md (§3
 * payload, §5 extension changes, §7 privacy). This module is deliberately
 * PURE and vscode-free (no `vscode` import, no `Date.now()`/`crypto`
 * defaults baked in without an override hook) so both {@link buildFeedbackPayload}
 * and {@link postFeedback} are unit-testable headlessly. `panel.ts` owns all
 * vscode-facing glue: gathering `diagnosticMarkdown`/`roots`, webview
 * messaging, the byte-identical preview-then-send ticket store, clipboard
 * fallback, and toasts.
 */

// Canonical production endpoint (spec §4, §11). This URL is baked into every
// shipped release; an already-installed extension can never be told to POST
// somewhere else later. That is exactly why it must live on a hostname the
// maintainer controls outright (not a `workers.dev` subdomain) — the
// *destination* behind this URL can be repointed to a different provider or
// backend, or the service retired gracefully, without ever touching
// already-shipped code. Do not change this to a test/staging URL in a commit
// that ships.
export const FEEDBACK_ENDPOINT = "https://feedback.corsairstudios.com/submit";

// Fallback web form (spec §6) — served at GET / by the same Worker that
// accepts POST /submit above. Shown to the user when a submission fails, so
// they have somewhere concrete to go. Same baked-into-shipped-releases
// constraint as FEEDBACK_ENDPOINT: this must stay a hostname the maintainer
// controls outright, since an already-installed extension can never be told
// to point elsewhere later.
export const FALLBACK_FORM_URL = "https://feedback.corsairstudios.com";

export type FeedbackCategory = "bug" | "idea" | "question" | "other";

/** v1 payload schema (spec §3). No `website` field here — that honeypot is form-only, never populated by real UI. */
export interface FeedbackPayloadV1 {
  schemaVersion: 1;
  ticketId: string;
  createdAt: string;
  extensionVersion: string;
  platform: string;
  hostAppName: string;
  category: FeedbackCategory;
  userDescription: string;
  diagnosticMarkdown?: string;
  contact?: string;
  // --- 2026-09-06 additive context fields (routing/harness changed a lot
  // recently — every submission now automatically records which app it
  // came from, the harness, and the full agent roster state). Never
  // secrets: env var NAMES only, never endpoint URLs or keys; no absolute
  // paths (sanitize() already scrubs strings that flow through it, and
  // these fields are built from ids/names/env-var-names only). ---
  host?: "vscode" | "standalone";
  harness?: FeedbackHarnessInfo;
  routing?: FeedbackRoutingInfo;
  agents?: FeedbackAgentInfo[];
  pluginVersion?: string;
  contextErrors?: string[];
}

/** Harness info block (spec addendum 2026-09-06). `running` is the harness
 *  currently driving activity when the host knows it, else null. */
export interface FeedbackHarnessInfo {
  effective: string;
  source: string;
  running?: string | null;
}

export interface FeedbackRoutingDefaults {
  vendor?: string;
  model?: string;
  transport?: string;
  costModelClass?: string;
}

export interface FeedbackRoutingInfo {
  visible: boolean;
  reason: string;
  profileActive: boolean;
  routedAgentCount: number;
  defaults?: FeedbackRoutingDefaults;
}

export interface FeedbackAgentInfo {
  id: string;
  model: string | null;
  vendor: string | null;
  costModelClass: string | null;
  transport?: string | null;
  routeSource: "explicit" | "default" | "frontmatter";
  handWrittenBackend: boolean;
  claudeTier: string | null;
  keywords: string[];
  endpointEnv?: string;
  credentialEnv?: string;
}

/** Output of {@link buildFeedbackContext} — never throws; on any internal
 *  failure the partial object is returned plus `contextErrors`. */
export interface FeedbackContext {
  host: "vscode" | "standalone";
  harness?: FeedbackHarnessInfo;
  routing?: FeedbackRoutingInfo;
  agents?: FeedbackAgentInfo[];
  contextErrors?: string[];
}

/** Raw (pre-sanitize) user-facing input, i.e. the SUBMIT_FEEDBACK message payload plus the already-built diagnostic markdown. */
export interface FeedbackSubmitInput {
  category: FeedbackCategory;
  /** Raw user-typed text — sanitized here, never expected to already be clean. */
  userDescription: string;
  /** Raw user-typed text — sanitized here. Omitted/empty means no contact field on the payload. */
  contact?: string;
  /**
   * Caller-provided output of `buildDiagnosticReport()` (already
   * self-sanitizing — see diagnosticReport.ts) when `includeDiagnostics` was
   * true; omitted entirely when the user unticked "include diagnostics."
   */
  diagnosticMarkdown?: string;
}

/** Environment/identity fields the host already has for the diagnostic-report flow, reused here (spec §3). */
export interface FeedbackPayloadContext {
  roots: SanitizeRoots;
  extensionVersion: string | null;
  platform: string;
  hostAppName: string;
  /** Injectable for tests; defaults to `crypto.randomUUID()`. */
  ticketId?: string;
  /** Injectable for tests; defaults to `new Date().toISOString()`. */
  createdAt?: string;
  /** Output of {@link buildFeedbackContext}, when the caller wants the
   *  auto-recorded host/harness/routing/agents fields spread into the
   *  payload. Omitted entirely (rather than merged) when absent, so older
   *  callers/tests that don't pass it keep producing the original v1
   *  shape. */
  context?: FeedbackContext;
}

/**
 * Read `.claude/tycoon/agent-keywords.json` under `root` and return a map of
 * agentId -> pipe-delimited pattern split into individual keywords. Missing
 * or malformed file degrades to an empty map (never throws) — mirrors
 * standalone/src/server.mjs's readKeywordsConfigStandalone.
 */
function readAgentKeywords(root: string): Record<string, string[]> {
  const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
  const out: Record<string, string[]> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(keywordsPath, "utf8"));
    const agents = parsed && typeof parsed === "object" ? parsed.agents : undefined;
    if (agents && typeof agents === "object") {
      for (const [agentId, cfg] of Object.entries(agents as Record<string, { pattern?: unknown }>)) {
        const pattern = cfg && typeof cfg.pattern === "string" ? cfg.pattern : "";
        out[agentId] = pattern
          .split("|")
          .map((kw) => kw.trim())
          .filter(Boolean);
      }
    }
  } catch {
    /* missing/invalid => empty map */
  }
  return out;
}

/**
 * Build the auto-recorded feedback context (host/harness/routing/agents) —
 * spec addendum 2026-09-06. Every submission now automatically records
 * which app it came from, the harness, and the full agent roster state,
 * because routing/harness changed a lot recently. NEVER includes secrets:
 * only env var NAMES (endpointEnv/credentialEnv), never endpoint URLs or
 * key values; no absolute filesystem paths. This function never throws —
 * any internal failure is caught and reported via `contextErrors` on the
 * partial result instead.
 */
export function buildFeedbackContext(
  root: string,
  opts: { host: "vscode" | "standalone"; effectiveHarness?: string; harnessSource?: string; running?: string | null }
): FeedbackContext {
  const contextErrors: string[] = [];
  const result: FeedbackContext = { host: opts.host };
  const errRoots: SanitizeRoots = { projectRoot: root, homeDir: null, extensionDir: null };
  try {
    errRoots.homeDir = os.homedir();
  } catch {
    /* best-effort */
  }
  const pushError = (stage: string, err: unknown): void => {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "error";
    const message = err instanceof Error ? err.message : String(err);
    contextErrors.push(`${stage}: ${code} ${sanitize(message, errRoots)}`);
  };

  let effectiveHarness = opts.effectiveHarness;
  let harnessSource = opts.harnessSource;
  try {
    if (effectiveHarness === undefined || harnessSource === undefined) {
      const desc = describeProviderSelection({ cwd: root });
      effectiveHarness = effectiveHarness ?? desc.effective;
      harnessSource = harnessSource ?? desc.source;
    }
    result.harness = { effective: effectiveHarness, source: harnessSource, running: opts.running ?? null };
  } catch (err) {
    pushError("harness", err);
  }

  try {
    const visibility = describeRoutingVisibility(root, effectiveHarness ?? "claude-code");
    const view = buildRoutingView({ root, env: process.env });
    const defaults = view.defaults;
    const routing: FeedbackRoutingInfo = {
      visible: visibility.visible,
      reason: visibility.reason,
      profileActive: visibility.profileActive,
      routedAgentCount: visibility.routedAgentCount,
    };
    if (defaults) {
      const d: FeedbackRoutingDefaults = {};
      if (defaults.vendor) d.vendor = defaults.vendor;
      if (defaults.model) d.model = defaults.model;
      if (defaults.transport) d.transport = defaults.transport;
      if (defaults.costModelClass) d.costModelClass = defaults.costModelClass;
      if (Object.keys(d).length > 0) routing.defaults = d;
    }
    result.routing = routing;
  } catch (err) {
    pushError("routing", err);
  }

  try {
    const routes = describeAgentRoutes(root);
    const keywordsMap = readAgentKeywords(root);
    const view = buildRoutingView({ root, env: process.env });
    const backendById = new Map(view.agents.map((a) => [a.id, a.backend]));
    const roster = loadAgentRoster(path.join(root, ".claude", "agents"));
    result.agents = roster.map((agent): FeedbackAgentInfo => {
      const route = routes[agent.id];
      const backend = backendById.get(agent.id);
      const entry: FeedbackAgentInfo = {
        id: agent.id,
        model: route?.resolvedModel ?? null,
        vendor: route?.vendor ?? null,
        costModelClass: route?.costModelClass ?? null,
        transport: backend?.transport ?? null,
        routeSource: route?.routeSource ?? "frontmatter",
        handWrittenBackend: route?.handWrittenBackend ?? false,
        claudeTier: route?.claudeTier ?? null,
        keywords: keywordsMap[agent.id] ?? [],
      };
      if (backend?.endpointEnv) entry.endpointEnv = backend.endpointEnv;
      if (backend?.apiKeyEnv) entry.credentialEnv = backend.apiKeyEnv;
      return entry;
    });
  } catch (err) {
    pushError("agents", err);
  }

  if (contextErrors.length > 0) result.contextErrors = contextErrors;
  return result;
}

/**
 * Build the exact v1 payload object (spec §3) for a feedback submission.
 * `userDescription` and `contact` are passed through {@link sanitize} here —
 * the single point that guarantees no raw filesystem path or obvious secret
 * in either field ever reaches the returned object. `diagnosticMarkdown` is
 * NOT re-sanitized: `buildDiagnosticReport()` already runs its entire output
 * through `sanitize()` as its own final step (diagnosticReport.ts), so
 * double-processing here would be redundant, not safer.
 */
export function buildFeedbackPayload(input: FeedbackSubmitInput, ctx: FeedbackPayloadContext): FeedbackPayloadV1 {
  const sanitizedDescription = sanitize(input.userDescription ?? "", ctx.roots);
  const rawContact = input.contact ?? "";
  const sanitizedContact = rawContact.trim() === "" ? "" : sanitize(rawContact, ctx.roots);

  const payload: FeedbackPayloadV1 = {
    schemaVersion: 1,
    ticketId: ctx.ticketId ?? crypto.randomUUID(),
    createdAt: ctx.createdAt ?? new Date().toISOString(),
    extensionVersion: ctx.extensionVersion ?? "unknown",
    platform: ctx.platform,
    hostAppName: ctx.hostAppName,
    category: input.category,
    userDescription: sanitizedDescription,
  };
  if (input.diagnosticMarkdown) {
    payload.diagnosticMarkdown = input.diagnosticMarkdown;
  }
  if (sanitizedContact !== "") {
    payload.contact = sanitizedContact;
  }
  if (ctx.context) {
    payload.host = ctx.context.host;
    if (ctx.context.harness) payload.harness = ctx.context.harness;
    if (ctx.context.routing) payload.routing = ctx.context.routing;
    if (ctx.context.agents) payload.agents = ctx.context.agents;
    if (ctx.context.contextErrors) payload.contextErrors = ctx.context.contextErrors;
  }
  return payload;
}

/** Minimal shape of the global `fetch` this module actually calls — lets tests inject a stub without pulling in DOM lib fetch typings. */
export type FeedbackFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number }>;

export interface PostFeedbackResult {
  ok: boolean;
  /** Present only when `ok` is false — network error, timeout, or non-2xx status. */
  error?: string;
}

/**
 * POST `bodyString` (the exact retained payload JSON — see panel.ts's
 * ticket store) to `endpoint` as `application/json`, aborting after
 * `timeoutMs` (default 10s per spec §5). Never throws — every failure mode
 * (network error, abort/timeout, non-2xx response) resolves to
 * `{ ok: false, error }` so callers never need a try/catch around this call.
 */
export async function postFeedback(
  bodyString: string,
  endpoint: string,
  fetchImpl: FeedbackFetch,
  timeoutMs = 10000
): Promise<PostFeedbackResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyString,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `submission failed (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: isAbort ? "submission timed out" : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
