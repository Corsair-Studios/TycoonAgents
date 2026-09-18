/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p64-t2: coverage for resolveThemeServiceEndpoint() (src/core/themeServiceClient.ts:28-73),
// the VS Code host's endpointOverride -> getEffectiveEndpointHost() wiring
// (src/host/vscode/themeServiceHost.ts), and the diagnostic report line that
// only appears when overridden (src/host/vscode/diagnosticReport.ts:309).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveThemeServiceEndpoint,
  THEME_SERVICE_ENDPOINT,
} from "../src/core/themeServiceClient";
import { createThemeServiceHost, type ThemeServiceHostStatus } from "../src/host/vscode/themeServiceHost";
import { buildDiagnosticReport } from "../src/host/vscode/diagnosticReport";
import { createFakeThemeService } from "./helpers/fakeThemeService";
import { createThemeServiceClient, type ThemeServiceTokenStore } from "../src/core/themeServiceClient";

function memoryTokenStore(): ThemeServiceTokenStore {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(token: string) {
      value = token;
    },
    async clear() {
      value = null;
    },
  };
}

// ---------------------------------------------------------------------------
// resolveThemeServiceEndpoint()
// ---------------------------------------------------------------------------

test("resolveThemeServiceEndpoint: undefined falls back to production, overridden false, no warning", () => {
  const res = resolveThemeServiceEndpoint(undefined);
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.equal(res.warning, undefined);
});

test("resolveThemeServiceEndpoint: empty string falls back, overridden false, no warning", () => {
  const res = resolveThemeServiceEndpoint("");
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.equal(res.warning, undefined);
});

test("resolveThemeServiceEndpoint: whitespace-only falls back, overridden false, no warning", () => {
  const res = resolveThemeServiceEndpoint("   \t  ");
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.equal(res.warning, undefined);
});

test("resolveThemeServiceEndpoint: http:// rejected (https-only), falls back with warning", () => {
  const res = resolveThemeServiceEndpoint("http://theme.example.com");
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.ok(res.warning && res.warning.includes("https"), "warning must mention https requirement");
});

test("resolveThemeServiceEndpoint: https:// with trailing slash strips it", () => {
  const res = resolveThemeServiceEndpoint("https://theme.example.com/");
  assert.equal(res.endpoint, "https://theme.example.com");
  assert.equal(res.overridden, true);
  assert.equal(res.warning, undefined);
});

test("resolveThemeServiceEndpoint: https:// with path and trailing slash strips only the trailing slash", () => {
  const res = resolveThemeServiceEndpoint("https://theme.example.com/staging/");
  assert.equal(res.endpoint, "https://theme.example.com/staging");
  assert.equal(res.overridden, true);
  assert.equal(res.warning, undefined);
});

test("resolveThemeServiceEndpoint: https:// with query string rejected, falls back with warning", () => {
  const res = resolveThemeServiceEndpoint("https://theme.example.com/?debug=1");
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.ok(res.warning && res.warning.includes("query"), "warning must mention query/fragment");
});

test("resolveThemeServiceEndpoint: https:// with fragment rejected, falls back with warning", () => {
  const res = resolveThemeServiceEndpoint("https://theme.example.com/#section");
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.ok(res.warning && res.warning.includes("query"), "warning must mention query/fragment");
});

test("resolveThemeServiceEndpoint: https:// with userinfo rejected, falls back with warning", () => {
  const res = resolveThemeServiceEndpoint("https://user:pw@theme.example.com");
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.ok(res.warning && res.warning.includes("userinfo"), "warning must mention userinfo");
});

test("resolveThemeServiceEndpoint: non-string input is treated as empty, falls back, no warning", () => {
  const res = resolveThemeServiceEndpoint(123 as unknown as string);
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.equal(res.warning, undefined);
});

test("resolveThemeServiceEndpoint: garbage/unparseable input falls back with warning", () => {
  const res = resolveThemeServiceEndpoint("not a url at all");
  assert.equal(res.endpoint, THEME_SERVICE_ENDPOINT);
  assert.equal(res.overridden, false);
  assert.ok(res.warning && res.warning.includes("invalid"), "warning must call out the invalid override");
});

// ---------------------------------------------------------------------------
// createThemeServiceHost: endpointOverride -> getEffectiveEndpointHost() /
// getStatusSnapshot().endpointHost
// ---------------------------------------------------------------------------

const SUPABASE_URL = "https://fake-project.supabase.co";

function noopHostDeps() {
  const posted: ThemeServiceHostStatus[] = [];
  return {
    postStatus: (s: ThemeServiceHostStatus) => posted.push(s),
    openExternal: () => {},
    posted,
  };
}

function fakeClient() {
  const fake = createFakeThemeService({ endpoint: "https://theme-service.example", supabaseUrl: SUPABASE_URL });
  return createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore: memoryTokenStore(),
    endpoint: "https://theme-service.example",
    supabaseUrl: SUPABASE_URL,
  });
}

test("themeServiceHost: no endpointOverride -> getEffectiveEndpointHost() is undefined and no client is built here to override", () => {
  const deps = noopHostDeps();
  const host = createThemeServiceHost({
    secrets: {} as any,
    client: fakeClient(),
    postStatus: deps.postStatus,
    openExternal: deps.openExternal,
  });
  assert.equal(host.getEffectiveEndpointHost(), undefined);
  host.dispose();
});

test("themeServiceHost: invalid endpointOverride with an injected client -> getEffectiveEndpointHost() stays undefined (injected client owns its own endpoint)", () => {
  const deps = noopHostDeps();
  const host = createThemeServiceHost({
    secrets: {} as any,
    client: fakeClient(),
    endpointOverride: "https://override.example.com",
    postStatus: deps.postStatus,
    openExternal: deps.openExternal,
  });
  // Per themeServiceHost.ts:169-174, effectiveEndpointHost is only computed
  // when opts.client is NOT supplied — an injected client always wins.
  assert.equal(host.getEffectiveEndpointHost(), undefined);
  host.dispose();
});

test("themeServiceHost: valid https endpointOverride with no injected client -> getEffectiveEndpointHost() returns the host", () => {
  const deps = noopHostDeps();
  const host = createThemeServiceHost({
    secrets: {} as any,
    endpointOverride: "https://override.example.com/",
    postStatus: deps.postStatus,
    openExternal: deps.openExternal,
  });
  assert.equal(host.getEffectiveEndpointHost(), "override.example.com");
  host.dispose();
});

test("themeServiceHost: getStatusSnapshot().endpointHost carries the overridden host", async () => {
  const deps = noopHostDeps();
  const host = createThemeServiceHost({
    secrets: {} as any,
    endpointOverride: "https://override.example.com",
    postStatus: deps.postStatus,
    openExternal: deps.openExternal,
  });
  const snapshot = await host.getStatusSnapshot();
  assert.equal(snapshot.endpointHost, "override.example.com");
  host.dispose();
});

test("themeServiceHost: invalid endpointOverride with no injected client falls back to production, endpointHost undefined on snapshot", async () => {
  const deps = noopHostDeps();
  const host = createThemeServiceHost({
    secrets: {} as any,
    endpointOverride: "not-a-url",
    postStatus: deps.postStatus,
    openExternal: deps.openExternal,
  });
  assert.equal(host.getEffectiveEndpointHost(), undefined);
  const snapshot = await host.getStatusSnapshot();
  assert.equal(snapshot.endpointHost, undefined);
  host.dispose();
});

// ---------------------------------------------------------------------------
// buildDiagnosticReport(): "Theme Service endpoint" line only when overridden
// ---------------------------------------------------------------------------

test("diagnosticReport: 'Theme Service endpoint' line present when themeServiceEndpointHost is set", () => {
  const report = buildDiagnosticReport({
    timestamp: "2026-09-18T00:00:00.000Z",
    roots: {},
    themeServiceEndpointHost: "override.example.com",
  });
  assert.ok(report.includes("Theme Service endpoint"), "line must be present");
  assert.ok(report.includes("override.example.com"), "line must include the host");
});

test("diagnosticReport: 'Theme Service endpoint' line absent when themeServiceEndpointHost is unset", () => {
  const report = buildDiagnosticReport({
    timestamp: "2026-09-18T00:00:00.000Z",
    roots: {},
  });
  assert.ok(!report.includes("Theme Service endpoint"), "line must be absent");
});

test("diagnosticReport: 'Theme Service endpoint' line absent when themeServiceEndpointHost is null", () => {
  const report = buildDiagnosticReport({
    timestamp: "2026-09-18T00:00:00.000Z",
    roots: {},
    themeServiceEndpointHost: null,
  });
  assert.ok(!report.includes("Theme Service endpoint"), "line must be absent");
});
