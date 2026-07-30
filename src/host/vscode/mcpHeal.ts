/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Auto-heal a STALE UEFN MCP server path in the project's `.mcp.json`. Real
 * bug hit in the field: `.mcp.json` registers the UEFN bridge server with a
 * VERSION-STAMPED ABSOLUTE PATH into the *installed* extension (e.g.
 * `.../.vscode/extensions/tycoonagents.tycoonagents-0.0.424/
 * media/uefn-bridge/uefn-server.mjs`). Every extension update deletes that
 * versioned folder, so the MCP server then fails to start and the user's AI
 * assistant silently loses every `uefn_*` tool with no obvious error —
 * breaking on EVERY update for EVERY user.
 *
 * Extracted out of `panel.ts` (formerly `TycoonPanel._autoHealMcpServerPathIfStale`,
 * a per-panel-open auto-heal) so it can ALSO run once at extension
 * `activate()` — a CLI-only user (Claude Code driving `uefn_*` tools without
 * ever opening the TycoonAgents webview panel) previously never got this
 * heal at all, since it only ran from panel construction. The function needs
 * only a project root and the running extension's `extensionUri` — no panel
 * state — so it lives here as a standalone, panel-independent module both
 * `panel.ts` and `extension.ts` can call.
 *
 * Location: `path.join(root, ".mcp.json")` — the SAME resolution every other
 * `.mcp.json` reader/writer in `panel.ts` uses (`_handleInstallMcp`,
 * `_handleRemoveMcp`, `_handleCheckInstall`, `_readMcpConfig` call sites).
 * Deliberately NOT the UEFN "effective root" redirect used for the Python
 * bridge under `<effRoot>/Content/Python` — `.mcp.json` itself always lives
 * at the plain project root Claude Code loads it from.
 *
 * Recognizes both key names this product has written for the UEFN server
 * over time (`uefn-bridge`, current; `uefn`, legacy). For each recognized
 * entry, locates the `args` element whose filename is `uefn-server.mjs` or
 * `uefn-server.js` — an entry with no such arg is left untouched entirely
 * (not this product's UEFN server entry). An entry's path is STALE when
 * EITHER:
 *   (a) the file it points at no longer exists on disk, OR
 *   (b) the path sits inside *some* `tycoonagents` extension directory that
 *       is not the CURRENTLY RUNNING one (`extensionUri.fsPath`) — a
 *       version-stamped path from an older/uninstalled extension folder.
 * A path that exists on disk and sits outside any tycoonagents extension
 * folder is left alone — the user may have deliberately pointed it at a
 * custom build.
 *
 * On a stale hit, rewrites the arg to
 * `<current extension dir>/media/uefn-bridge/uefn-server.mjs` (forward
 * slashes, matching this file's other path-normalization call sites in
 * progressScope.ts / themeArchive.ts) — but only after confirming that file
 * actually exists, so a corrupted/incomplete extension install can never
 * write a second broken path. Also drops `env.UEFN_BRIDGE_DIR` from a
 * rewritten entry (documented as breaking the file-IPC default — both sides
 * must default to `<OS temp>/uefn_bridge`), removing the whole `env` block
 * only once it becomes empty, and forces `command` to `"node"` on a
 * rewritten entry (the only command that can run the shipped `.mjs`). Every
 * other key — other MCP servers, unrelated entry fields — is left alone; the
 * file is rewritten as 2-space JSON, UTF-8, no BOM, trailing newline. Shows
 * one toast on an actual change (MCP servers only load at session start, so
 * a restart note matters). Wrapped in try/catch — must never throw or block
 * panel load / extension activation.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export function healMcpServerPathIfStale(root: string, extensionUri: vscode.Uri): void {
  try {
    if (root === "") return;
    const mcpPath = path.join(root, ".mcp.json");
    if (!fs.existsSync(mcpPath)) return; // opt-in only -- never create .mcp.json

    let raw: string;
    try {
      raw = fs.readFileSync(mcpPath, "utf8");
    } catch {
      return;
    }
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(withoutBom);
      if (json === null || typeof json !== "object" || Array.isArray(json)) return;
      parsed = json as Record<string, unknown>;
    } catch {
      return; // never clobber a file we can't parse
    }

    const servers = parsed["mcpServers"];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return;
    const serverMap = servers as Record<string, unknown>;

    const isUefnServerFile = (p: unknown): boolean => {
      if (typeof p !== "string") return false;
      const segments = p.split(/[\\/]/);
      const last = segments[segments.length - 1] ?? "";
      return /^uefn-server\.(mjs|js)$/i.test(last);
    };

    type Candidate = { entry: Record<string, unknown>; args: unknown[]; argIdx: number };
    const candidates: Candidate[] = [];
    for (const key of ["uefn-bridge", "uefn"]) {
      const rawEntry = serverMap[key];
      if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Record<string, unknown>;
      const args = entry["args"];
      if (!Array.isArray(args)) continue;
      const argIdx = args.findIndex(isUefnServerFile);
      if (argIdx === -1) continue;
      candidates.push({ entry, args, argIdx });
    }
    if (candidates.length === 0) return; // don't invent an entry that isn't there

    const currentServerPath = path.join(extensionUri.fsPath, "media", "uefn-bridge", "uefn-server.mjs");
    if (!fs.existsSync(currentServerPath)) return; // can't heal onto a file that isn't shipped

    const currentServerPathNormalized = currentServerPath.replace(/\\/g, "/");
    const currentExtDirNormalized = extensionUri.fsPath.replace(/\\/g, "/").toLowerCase();

    const isStale = (argPath: string): boolean => {
      if (!fs.existsSync(argPath)) return true;
      const argNormalized = argPath.replace(/\\/g, "/").toLowerCase();
      const inSomeTycoonagentsExtDir = argNormalized.includes("tycoonagents");
      const inCurrentExtDir = argNormalized.startsWith(currentExtDirNormalized);
      return inSomeTycoonagentsExtDir && !inCurrentExtDir;
    };

    let changed = false;
    for (const { entry, args, argIdx } of candidates) {
      const argPath = args[argIdx];
      if (typeof argPath !== "string" || !isStale(argPath)) continue;

      args[argIdx] = currentServerPathNormalized;
      changed = true;

      const env = entry["env"];
      if (env !== null && typeof env === "object" && !Array.isArray(env)) {
        const envMap = env as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(envMap, "UEFN_BRIDGE_DIR")) {
          delete envMap["UEFN_BRIDGE_DIR"];
          if (Object.keys(envMap).length === 0) delete entry["env"];
        }
      }

      if (entry["command"] !== "node") entry["command"] = "node";
    }

    if (!changed) return;

    fs.writeFileSync(mcpPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    void vscode.window.showInformationMessage(
      "TycoonAgents: updated the UEFN MCP server path in .mcp.json — restart your AI assistant session to load it."
    );
  } catch (e) {
    console.warn("TycoonAgents: healMcpServerPathIfStale failed:", e);
  }
}
