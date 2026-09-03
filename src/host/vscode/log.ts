/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from 'vscode';

/**
 * Single shared OutputChannel for TycoonAgents diagnostic logging, lazily
 * created on first use so importing this module never touches vscode's
 * window API before the extension host is ready.
 */
let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('TycoonAgents');
  return channel;
}

/**
 * Register the shared output channel on `context.subscriptions` so it is
 * disposed with the extension. Call once, at the top of `activate()`. Safe
 * to call more than once (a re-activation) — only ever pushes one disposer
 * per constructed channel. `log()` remains safe to call before this runs
 * (or from a bare Node process, e.g. tests) — it lazily creates the channel
 * itself via `getChannel()`.
 */
export function initLog(context: vscode.ExtensionContext): void {
  getChannel();
  context.subscriptions.push({ dispose: () => disposeLog() });
}

/** Dispose the shared output channel, if one was ever created. */
export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}

/** Append a timestamped line to the "TycoonAgents" output channel. */
export function log(msg: string): void {
  getChannel().appendLine(`[${new Date().toISOString()}] ${msg}`);
}
