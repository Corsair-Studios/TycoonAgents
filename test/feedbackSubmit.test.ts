/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_ENDPOINT,
  buildFeedbackPayload,
  postFeedback,
  type FeedbackFetch,
  type FeedbackPayloadContext,
  type FeedbackSubmitInput,
} from "../src/host/vscode/feedbackSubmit";
import { MSG_SCHEMAS } from "../src/host/vscode/messages";

/*
 * Coverage for the "Submit Feedback" pipeline's vscode-free core
 * (src/host/vscode/feedbackSubmit.ts) — see docs/FEEDBACK-PIPELINE-SPEC.md.
 * panel.ts's _handleSubmitFeedback/_handleConfirmFeedbackSend glue (the
 * preview-then-send ticket store, clipboard fallback, webview messaging)
 * imports `vscode` at module scope (panel.ts:7 `import * as vscode from
 * "vscode"`), so — same constraint documented in
 * test/uefnModerationExternalLink.test.ts / test/uefnVerseCheck.test.ts —
 * it cannot be imported headlessly in this suite. Item 5 (byte-identity)
 * below is therefore verified at the pure-helper seam only: that
 * `JSON.stringify(payload, null, 2)` is a deterministic function of the
 * payload object, and that `postFeedback` transmits the exact `bodyString`
 * it is handed without ever re-deriving or mutating it. panel.ts's own
 * doc comments (panel.ts:476-481, :7753-7755) describe the ticket-store
 * `Map<ticketId, bodyString>` that reuses this same string for both the
 * FEEDBACK_PREVIEW payload and the later POST body — that specific
 * plumbing is out of reach for a headless unit test and was inspected by
 * reading panel.ts directly rather than exercised here.
 */

// A real backslash character built without a literal backslash in source,
// so no accidental escape-sequence interpretation (e.g. "\t") can quietly
// turn these Windows-path fixtures into something that no longer resembles
// a path.
const BSLASH = String.fromCharCode(92);

function ctx(overrides: Partial<FeedbackPayloadContext> = {}): FeedbackPayloadContext {
  return {
    roots: {},
    extensionVersion: "0.0.510",
    platform: "win32",
    hostAppName: "Visual Studio Code",
    ...overrides,
  };
}

function input(overrides: Partial<FeedbackSubmitInput> = {}): FeedbackSubmitInput {
  return {
    category: "bug",
    userDescription: "The build never finishes.",
    ...overrides,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// 1. buildFeedbackPayload — shape
// ---------------------------------------------------------------------------

test("buildFeedbackPayload: schemaVersion is 1", () => {
  const payload = buildFeedbackPayload(input(), ctx());
  assert.equal(payload.schemaVersion, 1);
});

test("buildFeedbackPayload: ticketId is UUID-shaped when not injected", () => {
  const payload = buildFeedbackPayload(input(), ctx());
  assert.match(payload.ticketId, UUID_RE);
});

test("buildFeedbackPayload: createdAt is a valid ISO-8601 timestamp when not injected", () => {
  const payload = buildFeedbackPayload(input(), ctx());
  assert.ok(!Number.isNaN(Date.parse(payload.createdAt)), "createdAt must parse as a date");
  assert.equal(payload.createdAt, new Date(payload.createdAt).toISOString());
});

test("buildFeedbackPayload: category/platform/hostAppName/extensionVersion are carried through", () => {
  const payload = buildFeedbackPayload(
    input({ category: "idea" }),
    ctx({ platform: "darwin", hostAppName: "Cursor", extensionVersion: "1.2.3" })
  );
  assert.equal(payload.category, "idea");
  assert.equal(payload.platform, "darwin");
  assert.equal(payload.hostAppName, "Cursor");
  assert.equal(payload.extensionVersion, "1.2.3");
});

test("buildFeedbackPayload: extensionVersion falls back to 'unknown' when ctx.extensionVersion is null", () => {
  const payload = buildFeedbackPayload(input(), ctx({ extensionVersion: null }));
  assert.equal(payload.extensionVersion, "unknown");
});

test("buildFeedbackPayload: contact is omitted when absent, empty, or whitespace-only", () => {
  assert.equal("contact" in buildFeedbackPayload(input(), ctx()), false);
  assert.equal("contact" in buildFeedbackPayload(input({ contact: "" }), ctx()), false);
  assert.equal("contact" in buildFeedbackPayload(input({ contact: "   " }), ctx()), false);
});

test("buildFeedbackPayload: contact is present when a non-empty value is supplied", () => {
  const payload = buildFeedbackPayload(input({ contact: "me@example.com" }), ctx());
  assert.equal(payload.contact, "me@example.com");
});

test("buildFeedbackPayload: diagnosticMarkdown is omitted when not supplied", () => {
  const payload = buildFeedbackPayload(input(), ctx());
  assert.equal("diagnosticMarkdown" in payload, false);
});

test("buildFeedbackPayload: diagnosticMarkdown is present verbatim when supplied", () => {
  const payload = buildFeedbackPayload(input({ diagnosticMarkdown: "## Environment\n\n- ok" }), ctx());
  assert.equal(payload.diagnosticMarkdown, "## Environment\n\n- ok");
});

test("buildFeedbackPayload: the honeypot field 'website' is never present on the payload", () => {
  // FeedbackSubmitInput has no `website` field at all, but simulate a
  // malformed/malicious caller passing one through anyway (e.g. a stale
  // client, or hand-crafted IPC message) to prove buildFeedbackPayload
  // constructs the payload field-by-field rather than spreading input.
  const dirtyInput = { ...input(), website: "http://spam.example" } as FeedbackSubmitInput;
  const payload = buildFeedbackPayload(dirtyInput, ctx());
  assert.equal("website" in payload, false);
  assert.ok(!JSON.stringify(payload).includes("website"));
});

// ---------------------------------------------------------------------------
// 2. Privacy — sanitize() must scrub userDescription and contact
// ---------------------------------------------------------------------------

test("buildFeedbackPayload: strips a Windows absolute path from userDescription, leaves an ordinary URL intact", () => {
  const winPath = `C:${BSLASH}Users${BSLASH}victim${BSLASH}secret-notes.txt`;
  const url = "https://example.com/path/to/page";
  const payload = buildFeedbackPayload(
    input({ userDescription: `Crashed while reading ${winPath} — see ${url} for the repro steps.` }),
    ctx()
  );
  assert.ok(!payload.userDescription.includes(winPath), "raw Windows path must not survive sanitize");
  assert.ok(!payload.userDescription.includes("victim"), "path segment must not leak either");
  assert.ok(payload.userDescription.includes(url), "an ordinary URL must survive unchanged");
});

test("buildFeedbackPayload: strips a Unix absolute path from userDescription", () => {
  const unixPath = "/home/victim/.ssh/id_rsa";
  const payload = buildFeedbackPayload(
    input({ userDescription: `The tool read ${unixPath} by mistake.` }),
    ctx()
  );
  assert.ok(!payload.userDescription.includes(unixPath), "raw Unix path must not survive sanitize");
});

test("buildFeedbackPayload: strips a fake sk- style secret key from userDescription", () => {
  const fakeKey = "sk-abcdefghij1234567890";
  const payload = buildFeedbackPayload(
    input({ userDescription: `My key ${fakeKey} stopped working.` }),
    ctx()
  );
  assert.ok(!payload.userDescription.includes(fakeKey), "raw secret key must not survive sanitize");
});

test("buildFeedbackPayload: strips a Windows absolute path from contact", () => {
  const winPath = `C:${BSLASH}Users${BSLASH}victim${BSLASH}AppData${BSLASH}notes.txt`;
  const payload = buildFeedbackPayload(input({ contact: `reach me — logs at ${winPath}` }), ctx());
  assert.ok(payload.contact !== undefined);
  assert.ok(!(payload.contact as string).includes(winPath), "raw Windows path in contact must not survive sanitize");
});

test("buildFeedbackPayload: strips a Unix absolute path and a fake sk- key from contact, together", () => {
  const unixPath = "/etc/secrets/token";
  const fakeKey = "sk-zzzzzzzzzzzzzzzzzzzz";
  const payload = buildFeedbackPayload(
    input({ contact: `see ${unixPath} and key ${fakeKey}` }),
    ctx()
  );
  assert.ok(payload.contact !== undefined);
  assert.ok(!(payload.contact as string).includes(unixPath));
  assert.ok(!(payload.contact as string).includes(fakeKey));
});

// ---------------------------------------------------------------------------
// 3. postFeedback
// ---------------------------------------------------------------------------

test("postFeedback: resolves ok:true on a 2xx response", async () => {
  const fetchImpl: FeedbackFetch = async () => ({ ok: true, status: 200 });
  const result = await postFeedback('{"a":1}', FEEDBACK_ENDPOINT, fetchImpl, 1000);
  assert.deepEqual(result, { ok: true });
});

test("postFeedback: resolves ok:false with the status code on a non-2xx response", async () => {
  const fetchImpl: FeedbackFetch = async () => ({ ok: false, status: 500 });
  const result = await postFeedback('{"a":1}', FEEDBACK_ENDPOINT, fetchImpl, 1000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /500/);
});

test("postFeedback: resolves ok:false (never throws) when fetch rejects", async () => {
  const fetchImpl: FeedbackFetch = async () => {
    throw new Error("network down");
  };
  const result = await postFeedback('{"a":1}', FEEDBACK_ENDPOINT, fetchImpl, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.error, "network down");
});

test("postFeedback: resolves ok:false (never throws) when fetchImpl throws synchronously", async () => {
  const fetchImpl = (() => {
    throw new Error("synchronous boom");
  }) as unknown as FeedbackFetch;
  const result = await postFeedback('{"a":1}', FEEDBACK_ENDPOINT, fetchImpl, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.error, "synchronous boom");
});

test("postFeedback: resolves ok:false on timeout by aborting via the passed AbortSignal", async () => {
  // A fetch stub that never resolves on its own — it only settles when the
  // AbortSignal postFeedback wires up actually fires, proving the
  // AbortController/timeout path (not just a slow-but-eventually-ok fetch)
  // is what produces the timeout result. timeoutMs is kept small so the
  // test stays fast.
  const fetchImpl: FeedbackFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const start = Date.now();
  const result = await postFeedback('{"a":1}', FEEDBACK_ENDPOINT, fetchImpl, 30);
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.error, "submission timed out");
  assert.ok(elapsed < 2000, `expected the abort to fire quickly, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// 4. zod schema validation — SUBMIT_FEEDBACK
// ---------------------------------------------------------------------------

test("SUBMIT_FEEDBACK schema: rejects an empty userDescription", () => {
  const result = MSG_SCHEMAS.SUBMIT_FEEDBACK.safeParse({
    category: "bug",
    userDescription: "",
    includeDiagnostics: false,
  });
  assert.equal(result.success, false);
});

test("SUBMIT_FEEDBACK schema: rejects a userDescription over 4000 characters", () => {
  const result = MSG_SCHEMAS.SUBMIT_FEEDBACK.safeParse({
    category: "bug",
    userDescription: "x".repeat(4001),
    includeDiagnostics: false,
  });
  assert.equal(result.success, false);
});

test("SUBMIT_FEEDBACK schema: accepts a userDescription at exactly the 4000 char limit", () => {
  const result = MSG_SCHEMAS.SUBMIT_FEEDBACK.safeParse({
    category: "bug",
    userDescription: "x".repeat(4000),
    includeDiagnostics: false,
  });
  assert.equal(result.success, true);
});

test("SUBMIT_FEEDBACK schema: rejects a category outside the enum", () => {
  const result = MSG_SCHEMAS.SUBMIT_FEEDBACK.safeParse({
    category: "complaint",
    userDescription: "hello",
    includeDiagnostics: false,
  });
  assert.equal(result.success, false);
});

test("SUBMIT_FEEDBACK schema: rejects contact over 500 characters", () => {
  const result = MSG_SCHEMAS.SUBMIT_FEEDBACK.safeParse({
    category: "bug",
    userDescription: "hello",
    includeDiagnostics: false,
    contact: "x".repeat(501),
  });
  assert.equal(result.success, false);
});

test("SUBMIT_FEEDBACK schema: accepts a valid minimal payload", () => {
  const result = MSG_SCHEMAS.SUBMIT_FEEDBACK.safeParse({
    category: "question",
    userDescription: "How do I reset badges?",
    includeDiagnostics: true,
  });
  assert.equal(result.success, true);
});

test("CONFIRM_FEEDBACK_SEND schema: valid payload passes, missing ticketId fails", () => {
  assert.equal(MSG_SCHEMAS.CONFIRM_FEEDBACK_SEND.safeParse({ ticketId: "abc-123" }).success, true);
  assert.equal(MSG_SCHEMAS.CONFIRM_FEEDBACK_SEND.safeParse({}).success, false);
});

// ---------------------------------------------------------------------------
// 5. Byte-identity invariant (verified at the pure-helper seam — see file
//    header comment for why panel.ts's own ticket-store Map is out of
//    reach for a headless test).
// ---------------------------------------------------------------------------

test("byte-identity: JSON.stringify(payload, null, 2) is a pure, deterministic function of the payload", () => {
  const payload = buildFeedbackPayload(input(), ctx({ ticketId: "fixed-ticket-id", createdAt: "2026-07-31T00:00:00.000Z" }));
  const previewString = JSON.stringify(payload, null, 2);
  const postString = JSON.stringify(payload, null, 2);
  assert.equal(previewString, postString, "re-serializing the same payload object must be byte-identical");
});

test("byte-identity: postFeedback transmits bodyString to fetch unchanged", async () => {
  const payload = buildFeedbackPayload(input(), ctx({ ticketId: "fixed-ticket-id", createdAt: "2026-07-31T00:00:00.000Z" }));
  const bodyString = JSON.stringify(payload, null, 2);
  let capturedBody: string | undefined;
  const fetchImpl: FeedbackFetch = async (_url, init) => {
    capturedBody = init.body;
    return { ok: true, status: 200 };
  };
  await postFeedback(bodyString, FEEDBACK_ENDPOINT, fetchImpl, 1000);
  assert.equal(capturedBody, bodyString, "the exact string built for the preview must be the exact string POSTed");
});
