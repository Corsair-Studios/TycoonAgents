import { test } from "node:test";
import * as assert from "node:assert/strict";
import { providedMcpConfirmDetail, sanitizeProvidedMcpEntry } from "../src/core/providedMcp";

const good = { command: "node", args: ["C:/pt/uefn-server.mjs"], env: { UEFN_BRIDGE_DIR: "C:/tmp/bridge" } };

test("benign Power Tools entry passes unchanged", () => {
  const r = sanitizeProvidedMcpEntry("uefn-bridge", good);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.config, good);
});

test("explicit stdio type is dropped from the registered config", () => {
  const r = sanitizeProvidedMcpEntry("uefn-bridge", { type: "stdio", ...good });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.config, good);
});

test("refusal cases", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["url", { url: "http://x" }, /url/],
    ["url+command", { url: "http://x", command: "node" }, /both/],
    ["type http", { type: "http", command: "node" }, /not stdio/],
    ["headers", { command: "node", headers: { a: "b" } }, /headers/],
    ["cwd", { command: "node", cwd: "/tmp" }, /cwd/],
    ["unknown key", { command: "node", foo: 1 }, /foo/],
    ["no command", { args: [] }, /no command/],
    ["newline", { command: "node", args: ["a\nb"] }, /control/],
    ["control char", { command: "no\u0007de" }, /control/],
    ["NODE_OPTIONS", { command: "node", env: { NODE_OPTIONS: "--require x" } }, /NODE_OPTIONS/],
    ["NODE_PATH", { command: "node", env: { NODE_PATH: "x" } }, /NODE_PATH/],
    ["LD_PRELOAD", { command: "node", env: { LD_PRELOAD: "x" } }, /LD_PRELOAD/],
    ["LD_LIBRARY_PATH", { command: "node", env: { LD_LIBRARY_PATH: "x" } }, /LD_LIBRARY_PATH/],
    ["DYLD_", { command: "node", env: { DYLD_INSERT_LIBRARIES: "x" } }, /DYLD_/],
    ["PYTHONPATH", { command: "node", env: { PYTHONPATH: "x" } }, /PYTHONPATH/],
    ["PYTHONSTARTUP", { command: "node", env: { PYTHONSTARTUP: "x" } }, /PYTHONSTARTUP/],
    ["PATH", { command: "node", env: { Path: "x" } }, /Path/],
    ["COMSPEC", { command: "node", env: { ComSpec: "x" } }, /ComSpec/],
    ["npm_config_", { command: "node", env: { npm_config_prefix: "x" } }, /npm_config_prefix/],
    ["oversize", { command: "node", args: ["x".repeat(2100)] }, /longer/],
    ["not object", "node", /not an object/],
  ];
  for (const [name, entry, re] of bad) {
    const r = sanitizeProvidedMcpEntry("uefn-bridge", entry);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.error, re, name);
  }
});

test("dialog detail contains exactly the registered config JSON", () => {
  const r = sanitizeProvidedMcpEntry("uefn-bridge", { ...good, type: "stdio" });
  assert.ok(r.ok);
  if (r.ok) assert.ok(providedMcpConfirmDetail("uefn-bridge", r.config).includes(JSON.stringify(r.config, null, 2)));
});
