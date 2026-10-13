/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Keeping local-scope MCP registrations current (host-agnostic, no `vscode`):
//   - repointLocalMcpEntries: an extension update moves the versioned install
//     folder; entries the user already registered at local scope are repointed
//     to the current one, never downgraded and never across install kinds.
// Nothing is ever registered from what a repository contains: a server reaches
// local scope only through an explicit click in the UI. Only entries whose
// command is recognisably ours are ever touched.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { MCP_BRIDGE_HOOK_FILES, resolveHookInterpreter } from "../host/vscode/hookInstall";
import { isNewerExtensionPath } from "../providers/codex/installCodexHooks";
import {
  installedBridgeScript,
  readLocalMcpServers,
  registerLocalMcpServer,
} from "./claudeLocalMcp";
import type { LocalMcpOptions } from "./claudeLocalMcp";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const HOOK_ARG_RE = /(?:^|\/)hooks\/([^/]+)$/;

function sameFile(a: string, b: string, platform: NodeJS.Platform): boolean {
  const n = (s: string): string => (platform === "win32" ? s.replace(/\\/g, "/").toLowerCase() : s.replace(/\\/g, "/"));
  return n(a) === n(b);
}

/** True when a local-scope entry is one TycoonAgents registered: a node launcher running one of our bridge scripts. */
export function isOurLocalEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  for (const k of Object.keys(entry)) if (k !== "command" && k !== "args" && k !== "env" && k !== "type") return false;
  if (typeof entry.command !== "string" || !/^node(\.exe)?$/i.test(path.basename(entry.command.replace(/\\/g, "/")))) return false;
  const first = Array.isArray(entry.args) ? entry.args[0] : undefined;
  if (typeof first !== "string") return false;
  const m = HOOK_ARG_RE.exec(first.replace(/\\/g, "/"));
  return !!m && (MCP_BRIDGE_HOOK_FILES as ReadonlyArray<string>).includes(m[1]);
}

/**
 * Which kind of install a bridge script path belongs to. A VS Code window and the
 * standalone server each own only their own kind; neither rewrites the other's.
 */
export type InstallKind = "vscode-extension" | "project" | "standalone";

export function installKindOf(scriptPath: string): InstallKind {
  const p = scriptPath.replace(/\\/g, "/");
  if (/\/tycoonagents\.tycoonagents-\d/i.test(p)) return "vscode-extension";
  if (/(?:^|\/)\.claude\/hooks\//.test(p)) return "project";
  return "standalone";
}

export interface RepointResult {
  repointed: string[];
  errors: string[];
}

/**
 * Repoint our local-scope entries (ids in `ourIds`) at `hooksDir`. An entry already
 * there, one that points at a NEWER extension version (another window owns it), and
 * anything not recognisably ours are left alone. Other args and env are preserved.
 */
export async function repointLocalMcpEntries(root: string, hooksDir: string, ourIds: Iterable<string>, o: LocalMcpOptions = {}): Promise<RepointResult> {
  const result: RepointResult = { repointed: [], errors: [] };
  const platform = o.platform ?? process.platform;
  const isFile = o.isFile ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const local = readLocalMcpServers(root, o);
  for (const id of ourIds) {
    const entry = local[id];
    if (!isOurLocalEntry(entry)) continue;
    const cfg = entry as Record<string, unknown>;
    const args = cfg.args as unknown[];
    const oldScript = args[0] as string;
    const file = HOOK_ARG_RE.exec(oldScript.replace(/\\/g, "/"))![1];
    const newScript = installedBridgeScript(hooksDir, file);
    if (!isFile(newScript)) {
      result.errors.push(`${id}: ${file} is missing from this install; entry left as is.`);
      continue;
    }
    if (!sameFile(oldScript, newScript, platform)) {
      // Only the same kind of install is ever rewritten: a VS Code window never
      // touches a standalone or project path and vice versa.
      const kind = installKindOf(oldScript);
      if (kind !== installKindOf(newScript) || kind === "project") continue;
      // Never downgrade: a newer extension version belongs to another window. Standalone
      // roots carry no version, so one is repointed only once its script is gone.
      if (kind === "vscode-extension" && isNewerExtensionPath(oldScript, newScript) && isFile(oldScript)) continue;
      if (kind === "standalone" && isFile(oldScript)) continue;
    }
    let command = cfg.command as string;
    const abs = path.isAbsolute(command) || command.startsWith("/");
    if (abs && !isFile(command)) command = resolveHookInterpreter({ platform }).interpreter;
    if (sameFile(oldScript, newScript, platform) && command === cfg.command) continue;
    const next: Record<string, unknown> = { ...cfg, command, args: [newScript, ...args.slice(1)] };
    const r = await registerLocalMcpServer(root, id, next, o);
    if (r.ok) result.repointed.push(id);
    else result.errors.push(`${id}: ${r.error ?? "could not update"}`);
  }
  return result;
}
