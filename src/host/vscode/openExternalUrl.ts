import * as vscode from "vscode";
import { spawn } from "node:child_process";

export type OpenExternalLogger = (message: string) => void;

/**
 * Opens `url` in the user's default browser, choosing between
 * `vscode.env.openExternal` and a detached platform-opener spawn depending
 * on whether VS Code's URI parser round-trips the URL byte-identically.
 *
 * p67-t3: `vscode.Uri.parse(url, true).toString(true)` re-encodes the query
 * and fragment components. For URLs whose fragment/query carry raw data
 * meant to survive untouched (Stripe Checkout's `#fidk...` fragment, the
 * Supabase OAuth authorize URL's query params), that re-encoding can change
 * bytes — Chrome then reports "This link is incomplete" or an auth
 * handshake fails. We parse strictly, compare the round-trip, and only hand
 * the URL to `vscode.env.openExternal` when it comes back unchanged;
 * otherwise we open it via a detached platform-opener spawn (mirrors
 * standalone/src/themeServiceHost.mjs's openExternalUrl), which never passes
 * the URL through a shell string, so no escaping is needed.
 *
 * Only the chosen path is logged, never the URL itself (it can carry a PKCE
 * code_challenge or a Stripe checkout fragment).
 */
export async function openExternalUrl(url: string, log?: OpenExternalLogger): Promise<boolean> {
  // Review fix: never spawn/open anything but http(s) — reject javascript:,
  // file:, or other schemes before either branch runs.
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    log?.("openExternalUrl: rejected scheme (unparseable URL)");
    return false;
  }
  if (scheme !== "https:" && scheme !== "http:") {
    log?.("openExternalUrl: rejected scheme");
    return false;
  }

  let identical = false;
  try {
    identical = vscode.Uri.parse(url, true).toString(true) === url;
  } catch {
    identical = false;
  }

  if (identical) {
    try {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
      log?.(`openExternalUrl: opened via vscode.env.openExternal result=${opened}`);
      return opened;
    } catch (err) {
      log?.(`openExternalUrl: vscode.env.openExternal threw, falling back to platform opener: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to the platform opener below.
    }
  } else {
    log?.("openExternalUrl: URI round-trip changed the URL, using platform opener fallback");
  }

  const opened = await openViaPlatformOpener(url);
  log?.(`openExternalUrl: platform opener spawn result=${opened}`);
  return opened;
}

function openViaPlatformOpener(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      let child;
      if (process.platform === "win32") {
        // rundll32 url.dll,FileProtocolHandler <url> — unlike `cmd /c start`,
        // this never passes the URL through cmd.exe's shell parser, so `&`,
        // `%`, and `#` in a fragment/query survive intact instead of
        // splitting the command or triggering env-var expansion.
        child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" });
      } else if (process.platform === "darwin") {
        child = spawn("open", [url], { detached: true, stdio: "ignore" });
      } else {
        child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      }
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.once("error", () => {
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}
