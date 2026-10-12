/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Automatic "changed since approval" safety. Always on (independent of the
// tycoonagents.mcp.approveButton flag): when a TycoonAgents MCP server that is
// approved in <root>/.claude/settings.local.json has since been modified,
// replaced, or shadowed, its approval is removed and the user is told.
// Only our own ids and only settings.local.json are ever touched. No vscode
// import here so it is unit-testable; the host injects the watcher + notifier.
// ---------------------------------------------------------------------------

import { autoRevokeChangedApprovals, findChangedApprovedIds, tycoonServerDefsFromMedia } from "../../core/mcpApproval";
import type { ApprovalEnv } from "../../core/mcpApproval";
import { isHookWriteActive, onHookWritesIdle } from "../../core/hookWriteGate";

export const GUARD_DEBOUNCE_MS = 400;
/** Delay before a flagged approval is re-checked and only then revoked. */
export const GUARD_RECHECK_MS = 2000;

/** Watched project-relative globs: our hook copies and the MCP config. */
export const GUARD_WATCH_GLOBS: ReadonlyArray<string> = [".claude/hooks/**", ".mcp.json"];

export function revocationMessage(id: string): string {
  return `TycoonAgents removed approval for ${id}: its files changed since approval. Reinstall hooks from TycoonAgents, then approve again in Claude Code.`;
}

/** One check: auto-revoke and notify per revoked id. Never throws. Returns the revoked ids. */
export function runApprovalGuard(root: string, mediaDir: string, env: ApprovalEnv, notify: (message: string) => void): string[] {
  if (!root) return [];
  try {
    const res = autoRevokeChangedApprovals(root, tycoonServerDefsFromMedia(mediaDir), env);
    for (const id of res.ids) notify(revocationMessage(id));
    return res.ids;
  } catch {
    return [];
  }
}

export interface GuardRunOptions {
  recheckMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isBusy?: () => boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Race-safe check. Skips while TycoonAgents is writing hooks (the idle hook
 * re-runs it afterwards), and revokes an id only if it is still modified or
 * foreign after `recheckMs`, so a transient half-copied closure never revokes a
 * healthy approval. Never throws. Returns the revoked ids.
 */
export async function runApprovalGuardDeferred(
  root: string,
  mediaDir: string,
  env: ApprovalEnv,
  notify: (message: string) => void,
  opts: GuardRunOptions = {},
): Promise<string[]> {
  if (!root) return [];
  const sleep = opts.sleep ?? realSleep;
  const busy = opts.isBusy ?? isHookWriteActive;
  try {
    await sleep(0);
    if (busy()) return [];
    const defs = tycoonServerDefsFromMedia(mediaDir);
    const first = findChangedApprovedIds(root, defs, env);
    if (!first.ok || first.ids.length === 0) return [];
    await sleep(opts.recheckMs ?? GUARD_RECHECK_MS);
    if (busy()) return [];
    const res = autoRevokeChangedApprovals(root, defs, env, first.ids);
    for (const id of res.ids) notify(revocationMessage(id));
    return res.ids;
  } catch {
    return [];
  }
}

export interface GuardWatcher {
  dispose(): void;
}
/** Host seam: subscribe to create/change/delete of `glob` under `root`. */
export type WatchFactory = (root: string, glob: string, onEvent: () => void) => GuardWatcher;

/** Debounced watcher over {@link GUARD_WATCH_GLOBS}; one check per burst of events. */
export class McpApprovalWatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly watchers: GuardWatcher[];
  private disposed = false;
  private readonly unsubscribeIdle: () => void;

  constructor(
    root: string,
    watch: WatchFactory,
    private readonly check: () => void,
    private readonly delayMs: number = GUARD_DEBOUNCE_MS,
    private readonly isBusy: () => boolean = isHookWriteActive,
    subscribeIdle: (cb: () => void) => () => void = onHookWritesIdle,
  ) {
    this.watchers = GUARD_WATCH_GLOBS.map((g) => watch(root, g, () => this.schedule()));
    this.unsubscribeIdle = subscribeIdle(() => this.schedule());
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // While hooks are being written the idle subscription reschedules the check.
      if (!this.disposed && !this.isBusy()) this.check();
    }, this.delayMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribeIdle();
    for (const w of this.watchers) w.dispose();
  }
}
