/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Claude subscription under OpenCode (decision 2026-10-06).
//
// When OpenCode is the harness, Claude models default to the Anthropic API
// key path (OpenCode's own `anthropic` provider, env name ANTHROPIC_API_KEY,
// metered). Routing through the user's Claude subscription via the `claude -p`
// CLI bridge (claude-cli MCP server, "subscription" cost class on an
// anthropic slot) is an explicit, per-user opt-in.
//
// Existing configs: a slot that ALREADY uses the route (a hand-written or
// pack-installed `claude-worker` backend, or a saved routing slot) is treated
// as an explicit choice — it keeps working and shows the note, but the opt-in
// flag is what unlocks picking the route for any NEW slot.
//
// No `vscode` import: shared by both hosts (flag lives in the per-user app-data
// dir, next to the secrets store).
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { resolveStoreDir, type ResolveStoreDirOptions } from "./localEnvStore";

export const CLAUDE_SUBSCRIPTION_NOTE =
  "Uses your own Claude Code CLI login. Anthropic's terms for third-party harnesses have changed several times; check them before relying on this.";

/** Env var NAME OpenCode's anthropic provider reads for the default API-key route (never a value). */
export const OPENCODE_ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

const OPT_IN_FILE = "opencode-claude-subscription-optin";

export interface ClaudeRouteSlotLike {
  vendor?: string;
  transport?: string;
  mcpServer?: string;
  costModelClass?: string;
}

/**
 * True when the slot/backend reaches Claude through the user's subscription
 * (the claude-cli bridge, or an anthropic mcp slot billed as subscription).
 */
export function usesClaudeSubscriptionRoute(slot: ClaudeRouteSlotLike | null | undefined): boolean {
  if (!slot) return false;
  const vendor = String(slot.vendor ?? "").toLowerCase();
  if (vendor !== "anthropic") return false;
  if (slot.mcpServer === "claude-cli") return true;
  return slot.transport === "mcp" && slot.costModelClass === "subscription";
}

export interface ClaudeSubscriptionState {
  /** The slot uses the subscription route AND the harness is OpenCode (note applies). */
  showNote: boolean;
  /** Whether choosing/keeping the route is permitted: opted in, or the slot already uses it. */
  allowed: boolean;
}

export function claudeSubscriptionState(input: {
  harness: string;
  slot: ClaudeRouteSlotLike | null | undefined;
  optIn: boolean;
}): ClaudeSubscriptionState {
  if ((input.harness || "").toLowerCase() !== "opencode") return { showNote: false, allowed: true };
  const used = usesClaudeSubscriptionRoute(input.slot);
  return { showNote: used, allowed: input.optIn || used };
}

function optInPath(opts: ResolveStoreDirOptions): string {
  return path.join(path.dirname(resolveStoreDir(opts)), OPT_IN_FILE);
}

/** Per-user opt-in flag; default false, and false on any read error. */
export function readClaudeSubscriptionOptIn(opts: ResolveStoreDirOptions = {}): boolean {
  try {
    return fs.existsSync(optInPath(opts));
  } catch {
    return false;
  }
}

export function writeClaudeSubscriptionOptIn(value: boolean, opts: ResolveStoreDirOptions = {}): void {
  const file = optInPath(opts);
  if (value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "1\n", "utf8");
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

export const CLAUDE_SUBSCRIPTION_SETTING_LABEL = "Allow Claude subscription via the claude CLI under OpenCode";

/** Message used wherever the opt-in blocks the route (pack install, runtime, save, dispatcher). */
export function claudeSubscriptionBlockedMessage(what: string): string {
  return `${what} needs the '${CLAUDE_SUBSCRIPTION_SETTING_LABEL}' setting (off by default; Claude uses an Anthropic API key, ${OPENCODE_ANTHROPIC_API_KEY_ENV}, under OpenCode). Enable it in Settings to use your Claude subscription.`;
}

/**
 * Pack install / heal: skip an agent whose backend is the Claude subscription
 * route when the harness is OpenCode and the user has not opted in.
 */
export function shouldSkipPackAgentForClaudeSubscription(
  harness: string,
  optIn: boolean,
  backend: ClaudeRouteSlotLike | null | undefined,
): boolean {
  return (harness || "").toLowerCase() === "opencode" && !optIn && usesClaudeSubscriptionRoute(backend);
}
