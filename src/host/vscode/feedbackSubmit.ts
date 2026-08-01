/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as crypto from "crypto";
import { sanitize, type SanitizeRoots } from "./diagnosticReport";

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
