/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Keeping local-scope MCP registrations current (host-agnostic, no `vscode`):
//   - Entries point at the stable per-user launcher directory (stableBridgeDir.ts),
//     which no extension update moves, so an update never rewrites them.
//   - repointLocalMcpEntries: a ONE-TIME migration of entries that still point into a
//     versioned extension folder (or a vanished standalone folder) to the stable
//     directory. Entries already there are left alone. The rewrite is a single
//     atomic edit of ~/.claude.json that never removes first, is verified after a
//     pause and retried once; an entry that is still missing is reported in
//     `missing` so the host can warn the user.
// Nothing is ever registered from what a repository contains: a server reaches
// local scope only through an explicit click in the UI. Only entries whose
// command is recognisably ours are ever touched.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { MCP_BRIDGE_HOOK_FILES, resolveHookInterpreter } from "../host/vscode/hookInstall";
import {
  createLocalMcpOps,
  installedBridgeScript,
  readLocalMcpServers,
  replaceLocalMcpEntrySafely,
} from "./claudeLocalMcp";
import { isInStableBridgeDir, resolveStableBridgeDir } from "./stableBridgeDir";
import type { LocalMcpOps, LocalMcpOptions } from "./claudeLocalMcp";
import { CODEX_LEGACY_MODELS } from "./agentsUiMode";
import { registrableBridgeServerIds } from "./bridgeSetup";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const HOOK_ARG_RE = /(?:^|\/)hooks\/([^/]+)$/;

function sameFile(a: string, b: string, platform: NodeJS.Platform): boolean {
  const n = (s: string): string => (platform === "win32" ? s.replace(/\\/g, "/").toLowerCase() : s.replace(/\\/g, "/"));
  return n(a) === n(b);
}

/** True when a local-scope entry is one TycoonAgents registered: a node launcher running one of our bridge scripts. */
export function isOurLocalEntry(entry: unknown, o: LocalMcpOptions = {}): boolean {
  if (!isPlainObject(entry)) return false;
  for (const k of Object.keys(entry)) if (k !== "command" && k !== "args" && k !== "env" && k !== "type") return false;
  if (typeof entry.command !== "string" || !/^node(\.exe)?$/i.test(path.basename(entry.command.replace(/\\/g, "/")))) return false;
  const first = Array.isArray(entry.args) ? entry.args[0] : undefined;
  if (typeof first !== "string") return false;
  const norm = first.replace(/\\/g, "/");
  const m = HOOK_ARG_RE.exec(norm) ?? (isInStableBridgeDir(norm, o) ? /\/([^/]+)$/.exec(norm) : null);
  return !!m && (MCP_BRIDGE_HOOK_FILES as ReadonlyArray<string>).includes(m[1]);
}

/**
 * Which kind of install a bridge script path belongs to. A VS Code window and the
 * standalone server each own only their own kind; neither rewrites the other's.
 */
export type InstallKind = "stable" | "vscode-extension" | "project" | "standalone";

export function installKindOf(scriptPath: string, o: LocalMcpOptions = {}): InstallKind {
  const p = scriptPath.replace(/\\/g, "/");
  if (isInStableBridgeDir(p, o)) return "stable";
  if (/\/tycoonagents\.tycoonagents-\d/i.test(p)) return "vscode-extension";
  if (/(?:^|\/)\.claude\/hooks\//.test(p)) return "project";
  return "standalone";
}

/**
 * The catalog args (after the script) a registered entry should carry now, or null
 * to keep its args. Only args that EXACTLY equal the current catalog args with the
 * `model="..."` value swapped for a superseded (legacy) model are refreshed;
 * user-customised args are never touched.
 */
export function refreshedCatalogTail(have: unknown[], catalogArgs: unknown): string[] | null {
  if (!Array.isArray(catalogArgs) || !catalogArgs.every((a) => typeof a === "string")) return null;
  const cur = (catalogArgs as string[]).slice(1);
  const mi = cur.findIndex((a) => /^model="[^"]*"$/.test(a));
  if (mi < 0 || have.length !== cur.length) return null;
  if (have.every((a, i) => a === cur[i])) return null;
  for (const legacy of CODEX_LEGACY_MODELS) {
    const old = cur.slice();
    old[mi] = `model="${legacy}"`;
    if (have.every((a, i) => a === old[i])) return cur;
  }
  return null;
}

export interface RepointResult {
  repointed: string[];
  errors: string[];
  /** Ids whose entry could not be confirmed after the rewrite (neither old nor new is present): warn the user. */
  missing: string[];
}

/**
 * Migrate our local-scope entries (ids in `ourIds`) to `hooksDir`, the stable launcher
 * directory. Entries already in it, project copies and anything not recognisably ours
 * are left alone; versioned-extension entries always move (the stable directory is
 * canonical, so no downgrade concern). Other args and env are preserved.
 */
export async function repointLocalMcpEntries(root: string, hooksDir: string, ourIds: Iterable<string>, o: LocalMcpOptions = {}, defs: Record<string, { config?: unknown }> = {}): Promise<RepointResult> {
  const result: RepointResult = { repointed: [], errors: [], missing: [] };
  const platform = o.platform ?? process.platform;
  const isFile = o.isFile ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const local = readLocalMcpServers(root, o);
  // The id set is the caller's ids, every registrable bridge server (codex-write included) and any
  // registered entry of ours still inside a versioned extension folder, whatever its id.
  const ids = new Set<string>([...ourIds, ...registrableBridgeServerIds()]);
  for (const [id, e] of Object.entries(local)) {
    if (isOurLocalEntry(e, o) && installKindOf((e as { args: string[] }).args[0], o) === "vscode-extension") ids.add(id);
  }
  for (const id of ids) {
    const entry = local[id];
    if (!isOurLocalEntry(entry, o)) continue;
    const cfg = entry as Record<string, unknown>;
    const args = cfg.args as unknown[];
    const oldScript = args[0] as string;
    const file = /([^/\\]+)$/.exec(oldScript)![1];
    const newScript = installedBridgeScript(hooksDir, file);
    if (installKindOf(newScript, o) !== "stable") {
      result.errors.push(`${id}: ${hooksDir} is not the TycoonAgents launcher folder; entry left as is.`);
      continue;
    }
    if (!isFile(newScript)) {
      result.errors.push(`${id}: ${file} is missing from the TycoonAgents launcher folder; entry left as is.`);
      continue;
    }
    if (!sameFile(oldScript, newScript, platform)) {
      const kind = installKindOf(oldScript, o);
      if (kind === "project") continue;
      // A standalone root carries no version: move it only once its script is gone.
      if (kind === "standalone" && isFile(oldScript)) continue;
    }
    let command = cfg.command as string;
    const abs = path.isAbsolute(command) || command.startsWith("/");
    if (abs && !isFile(command)) command = resolveHookInterpreter({ platform }).interpreter;
    // Args exactly equal to a superseded catalog default (`defs`) move to the current catalog args.
    const catCfg = defs[id]?.config;
    const freshTail = refreshedCatalogTail(args.slice(1), isPlainObject(catCfg) ? catCfg.args : undefined);
    if (sameFile(oldScript, newScript, platform) && command === cfg.command && !freshTail) continue;
    const next: Record<string, unknown> = { ...cfg, command, args: [newScript, ...(freshTail ?? args.slice(1))] };
    const r = await replaceLocalMcpEntrySafely(root, id, cfg, next, o);
    if (r.outcome === "replaced") result.repointed.push(id);
    else if (r.outcome === "missing") {
      result.missing.push(id);
      result.errors.push(`${id}: ${r.error ?? "entry is missing after the update"}`);
    } else if (!r.ok) result.errors.push(`${id}: ${r.error ?? "could not update"}`);
  }
  return result;
}

export interface StableLocalMcp {
  ops: LocalMcpOps;
  /** Set when the launcher directory cannot be resolved: registering must not proceed. */
  error?: string;
}

/**
 * Local-scope operations bound to the stable launcher directory (<home>/.tycoonagents/bin).
 * Copying into it is done once at activation / standalone startup (installStableBridges);
 * entries are never registered against the versioned extension folder.
 */
export function stableLocalMcp(o: LocalMcpOptions = {}): StableLocalMcp {
  const r = resolveStableBridgeDir(o);
  if (!r.dir) return { ops: createLocalMcpOps("", o), error: r.error ?? "TycoonAgents could not find its launcher folder." };
  return { ops: createLocalMcpOps(r.dir, o) };
}
