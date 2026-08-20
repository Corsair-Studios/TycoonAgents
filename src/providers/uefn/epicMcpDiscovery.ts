/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { URL } from "url";

/**
 * Why this module exists, and why it looks the way it does: see
 * docs/PATH-DISCOVERY.md (the project-wide discovery doctrine) and
 * docs/UEFN-MCP-COMPARISON.md (the measured facts about Epic's server this
 * module's probe encodes). Shaped after src/providers/codex/codexDiscovery.ts
 * — same discovery-ladder discipline (override wins, multiple independent
 * candidates gathered before probing, content-based verification, fail-open
 * at every layer, a failure result that names every location tried) — but
 * this module probes a network endpoint instead of a local binary, so the
 * "content verification" step is an MCP `initialize` handshake rather than
 * a `--version` string match.
 *
 * MEASURED FACTS THIS MODULE DEPENDS ON (docs/UEFN-MCP-COMPARISON.md,
 * "Epic's gateway shape" / "Other measured facts"; protocol details
 * confirmed working in scripts/probe-epic-mcp.mjs, ported here):
 *   - Epic's `serverInfo.name`/`.title`/`.version` are all EMPTY STRINGS.
 *     Identifying the server by name is impossible and must never be
 *     attempted — this module verifies by protocol conformance only: a
 *     JSON-RPC `result` object containing a `capabilities` object.
 *   - The HTTP response Content-Type may be `application/json` OR
 *     `text/event-stream`. For SSE, the body is a sequence of `data: ...`
 *     lines; concatenate their payloads and parse the result as ONE JSON
 *     document.
 *   - Regardless of content-type, the JSON body is PRETTY-PRINTED across
 *     multiple lines — the whole body must be parsed as one JSON value,
 *     never scanned line-by-line for a leading `{`.
 *   - The `Mcp-Session-Id` the server assigns arrives as a RESPONSE HEADER
 *     on `initialize`, not in the JSON body. This module does not need the
 *     session for anything beyond the initialize probe itself, so it reads
 *     the header only to confirm the handshake completed; it never opens a
 *     lasting session.
 *
 * This module does NOT wire into the panel — that is a later task. It only
 * exports discovery + probing so the panel (or anything else) can call in.
 */

/** The env var that always wins, per docs/PATH-DISCOVERY.md's "known override variables" convention. Reuse this exact name; do not invent a competing one. */
const OVERRIDE_ENV_VAR = "UEFN_EPIC_MCP_URL";

/** The documented default endpoint Epic's UEFN MCP server listens on (docs/UEFN-MCP-COMPARISON.md). Final fallback rung of the ladder. */
const DEFAULT_EPIC_MCP_URL = "http://127.0.0.1:8000/mcp";

/** Fail-open, fail-fast: never let a single probe hang the caller (panel load, etc.) waiting on a closed port. */
const PROBE_TIMEOUT_MS = 2_000;

export interface EpicMcpDiscoveryResult {
  /** True only when an `initialize` probe against `url` returned a conforming JSON-RPC result with a `capabilities` object. */
  available: boolean;
  /** The URL that succeeded, or null if none did. */
  url: string | null;
  /** Every URL this discovery attempt probed, in the order tried — always populated, even on success (so callers can see what else was checked). */
  triedUrls: string[];
  /** Present on failure only. Always names UEFN_EPIC_MCP_URL as the override, per docs/PATH-DISCOVERY.md's non-negotiable failure behavior. */
  reason?: string;
}

/**
 * A single MCP `initialize` probe against a candidate URL. Injectable seam:
 * discoverEpicMcp() takes this as a parameter (defaulting to
 * `probeEpicMcpUrl`, the real network implementation) so tests can supply a
 * deterministic stub and never touch a real socket. Must never throw —
 * any failure (connection refused, timeout, malformed body, non-conforming
 * result) resolves to `false`.
 */
export type EpicMcpProbeFn = (url: string, timeoutMs: number) => Promise<boolean>;

/**
 * Extracts the JSON-RPC payload from a raw MCP HTTP response body, honoring
 * both response shapes Epic's server can return (measured in
 * scripts/probe-epic-mcp.mjs, ported verbatim):
 *   - `application/json`: the whole body is one JSON value, PRETTY-PRINTED
 *     across many lines — parse the entire body, never scan line-by-line
 *     for a leading `{`.
 *   - `text/event-stream`: the body is a sequence of `data: ...` lines;
 *     concatenate their payloads and parse the result as one JSON value.
 * Throws on malformed input — callers must catch, per this module's
 * fail-open discipline.
 */
export function extractMcpJsonBody(contentType: string | undefined, rawBody: string): unknown {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();

  if (type === "text/event-stream") {
    const dataLines = rawBody
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) {
      throw new Error("SSE response contained no data: lines");
    }
    return JSON.parse(dataLines.join(""));
  }

  // application/json (or anything else, or unset): parse the whole body at
  // once — it may be pretty-printed across multiple lines.
  return JSON.parse(rawBody);
}

/**
 * True iff `body` is a conforming MCP `initialize` JSON-RPC result: an
 * object with `result.capabilities` present as an object. Deliberately does
 * NOT look at `result.serverInfo.name` — Epic's server returns that as an
 * empty string (docs/UEFN-MCP-COMPARISON.md), so any check keyed on the
 * name would silently misidentify a real Epic server as absent.
 */
export function isConformingInitializeResult(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const result = (body as Record<string, unknown>).result;
  if (result === null || typeof result !== "object") return false;
  const capabilities = (result as Record<string, unknown>).capabilities;
  return capabilities !== null && typeof capabilities === "object";
}

/**
 * Real network implementation of EpicMcpProbeFn: POSTs an MCP `initialize`
 * request to `url` and resolves `true` iff the response is a conforming
 * result (see isConformingInitializeResult). Fails open on every error path
 * — malformed URL, connection refused, timeout, non-2xx status, unparsable
 * body, non-conforming JSON — all resolve `false`, never reject/throw. Uses
 * node:http only (no new dependencies, matching scripts/probe-epic-mcp.mjs
 * and the rest of this project).
 */
export function probeEpicMcpUrl(url: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(false);
      return;
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "epic-mcp-discovery", version: "1.0.0" },
      },
    });

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            if (!res.statusCode || res.statusCode >= 400) {
              resolve(false);
              return;
            }
            const rawBody = Buffer.concat(chunks).toString("utf8");
            if (!rawBody.trim()) {
              resolve(false);
              return;
            }
            const body = extractMcpJsonBody(res.headers["content-type"], rawBody);
            resolve(isConformingInitializeResult(body));
          } catch {
            resolve(false);
          }
        });
      },
    );

    // Fail-open on every transport-level failure: refused connection, DNS
    // failure, reset, etc. — a probe candidate that can't be reached is
    // just "not found", never an uncaught error.
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Tolerantly reads and parses a project's `.mcp.json`. Missing file,
 * unreadable file, or malformed JSON all collapse to `{}` — never throws.
 * Self-contained (no dependency on src/host/vscode/*) so this module stays
 * usable outside a VS Code host, matching src/providers/codex/codexDiscovery.ts's
 * house style of owning its own fs access.
 */
function readMcpConfigTolerant(mcpPath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(mcpPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Scans a parsed `.mcp.json` object for server entries shaped like
 * `{ type: "http", url: "..." }` and returns their URLs, in the object's
 * own key order. Matches by CONFIG SHAPE ONLY, never by key name — per
 * docs/PATH-DISCOVERY.md's content-over-name rule and this task's explicit
 * requirement: the project's real config uses the key `unreal-engine-mcp`,
 * but that is the user's arbitrary naming choice, not a contract another
 * project's `.mcp.json` is bound to follow.
 */
export function findHttpMcpUrls(mcpConfig: Record<string, unknown>): string[] {
  const servers = mcpConfig.mcpServers;
  if (servers === null || typeof servers !== "object") return [];

  const urls: string[] = [];
  for (const entry of Object.values(servers as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type === "http" && typeof record.url === "string" && record.url.length > 0) {
      urls.push(record.url);
    }
  }
  return urls;
}

function addCandidate(list: string[], seen: Set<string>, url: string | undefined | null): void {
  if (!url) return;
  if (seen.has(url)) return;
  seen.add(url);
  list.push(url);
}

/**
 * Discovers whether Epic's UEFN MCP server is available, following
 * docs/PATH-DISCOVERY.md's discovery ladder:
 *   1. UEFN_EPIC_MCP_URL env override — always wins, and is the ONLY
 *      candidate tried when set (matching discoverCodexBinary()'s override
 *      behavior: an explicit override skips every other rung entirely).
 *   2. Every `http`-typed server URL found in the project's `.mcp.json`
 *      (matched by config shape, never by key name), in file order,
 *      de-duplicated.
 *   3. The documented default, http://127.0.0.1:8000/mcp.
 *
 * Each candidate is probed via `probe` (defaulting to the real
 * probeEpicMcpUrl network implementation) with a 2-second timeout. The
 * first candidate whose probe resolves `true` wins. `probe` is an
 * injectable seam specifically so tests can stub deterministic
 * true/false results per URL without opening a real socket.
 *
 * Fails open in every sense: never throws (a thrown probe would be a bug in
 * `probe` itself, not this function — probeEpicMcpUrl never throws), and on
 * total failure returns `{ available: false, url: null, triedUrls: [...],
 * reason: "..." }` naming UEFN_EPIC_MCP_URL as the override — never an
 * empty/clean success shape when nothing was actually found.
 *
 * `projectRoot` defaults to `process.cwd()`; pass it explicitly when the
 * caller already knows the workspace root (e.g. VS Code's
 * workspaceFolders[0].uri.fsPath), since this module has no VS Code
 * dependency of its own.
 */
export async function discoverEpicMcp(
  projectRoot: string = process.cwd(),
  probe: EpicMcpProbeFn = probeEpicMcpUrl,
): Promise<EpicMcpDiscoveryResult> {
  const triedUrls: string[] = [];

  const override = process.env[OVERRIDE_ENV_VAR];
  if (override) {
    triedUrls.push(override);
    const ok = await probe(override, PROBE_TIMEOUT_MS);
    if (ok) {
      return { available: true, url: override, triedUrls };
    }
    return {
      available: false,
      url: null,
      triedUrls,
      reason:
        `${OVERRIDE_ENV_VAR} is set to "${override}", but an MCP initialize probe against it did not return a ` +
        `conforming result within ${PROBE_TIMEOUT_MS}ms. Verify the URL and that Epic's UEFN MCP server is running there.`,
    };
  }

  const candidates: string[] = [];
  const seen = new Set<string>();

  let mcpPath = "";
  try {
    mcpPath = path.join(projectRoot, ".mcp.json");
  } catch {
    // Malformed projectRoot — fall through with no .mcp.json candidates;
    // the default-URL rung below still runs.
    mcpPath = "";
  }
  if (mcpPath) {
    const mcpConfig = readMcpConfigTolerant(mcpPath);
    for (const url of findHttpMcpUrls(mcpConfig)) {
      addCandidate(candidates, seen, url);
    }
  }

  addCandidate(candidates, seen, DEFAULT_EPIC_MCP_URL);

  for (const url of candidates) {
    triedUrls.push(url);
    const ok = await probe(url, PROBE_TIMEOUT_MS);
    if (ok) {
      return { available: true, url, triedUrls };
    }
  }

  const triedList = triedUrls.map((u) => `  - ${u}`).join("\n");
  return {
    available: false,
    url: null,
    triedUrls,
    reason:
      `Could not reach Epic's UEFN MCP server. Tried:\n${triedList}\n\n` +
      `Set the ${OVERRIDE_ENV_VAR} environment variable to override discovery.`,
  };
}
