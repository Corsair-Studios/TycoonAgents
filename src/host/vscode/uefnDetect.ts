/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface UefnProjectDetection {
  detected: boolean;
  signals: string[];
  uefnInstalled: boolean;
  /**
   * Set ONLY when detection could not fully run — an exception escaped every
   * inner guard below (each individual check already has its own try/catch;
   * this is the outer, last-resort guard). Distinguishes "we looked and
   * genuinely found nothing" (this field absent, detected/uefnInstalled just
   * false) from "we couldn't look" (this field present). Never set on the
   * happy path, and additive-only on the return shape so existing callers
   * destructuring {detected, signals, uefnInstalled} are unaffected.
   */
  lookupError?: string;
}

export function detectUefnProject(root: string): UefnProjectDetection {
  try {
    const signals: string[] = [];

    // Check for *.verse files in root or root/src
    const verseDirs = [root, path.join(root, "src")];
    for (const dir of verseDirs) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith(".verse"))) {
          signals.push("verse-files");
          break;
        }
      } catch {
        // directory not readable, skip
      }
    }

    // Check for *.uproject or *.uefnproject file in root
    try {
      if (fs.existsSync(root) && fs.readdirSync(root).some(f => f.endsWith(".uproject") || f.endsWith(".uefnproject"))) {
        signals.push("uproject");
      }
    } catch {
      // directory not readable, skip
    }

    // Check for Content/Verse directory
    const contentVersePath = path.join(root, "Content", "Verse");
    if (fs.existsSync(contentVersePath) && fs.statSync(contentVersePath).isDirectory()) {
      signals.push("content-verse");
    }

    // Check if UEFN is installed.
    // Rung 1: explicit override always wins (points straight at the
    // UnrealEditorFortnite folder, skipping AppData\Local derivation).
    // Rung 2: LOCALAPPDATA, as Windows normally sets it.
    // Rung 3: derive AppData\Local from os.homedir() when LOCALAPPDATA is
    // unset (seen in some shells/CI runners on otherwise-normal machines).
    let uefnInstalled = false;
    const uefnInstallOverride = process.env["UEFN_INSTALL_DIR"];
    if (uefnInstallOverride) {
      try {
        uefnInstalled = fs.existsSync(uefnInstallOverride);
      } catch {
        uefnInstalled = false;
      }
    } else {
      let appDataLocal: string | undefined = process.env["LOCALAPPDATA"];
      if (!appDataLocal) {
        try {
          const home = os.homedir();
          if (home) {
            appDataLocal = path.join(home, "AppData", "Local");
          }
        } catch {
          // os.homedir() can throw in rare sandboxed/CI environments.
        }
      }

      if (appDataLocal) {
        const uefnPath = path.join(appDataLocal, "UnrealEditorFortnite");
        uefnInstalled = fs.existsSync(uefnPath);
      } else {
        // Not "UEFN isn't installed" — we couldn't even look. Keep this
        // distinguishable from a genuine not-found so a silent false never
        // gets read as a real negative result.
        console.error(
          "TycoonAgents: UEFN install detection could not resolve an AppData\\Local root — " +
            "tried env.LOCALAPPDATA and os.homedir()-derived AppData\\Local, both unavailable. " +
            "Set UEFN_INSTALL_DIR to the UnrealEditorFortnite folder to override.",
        );
      }
    }

    return { detected: signals.length > 0, signals, uefnInstalled };
  } catch (err) {
    // Genuinely unexpected — every individual check above already guards its
    // own failure. This is NOT "detected: false" in the ordinary sense (we
    // looked and found nothing); it's "detection itself blew up", which must
    // stay distinguishable from a real negative (see lookupError doc above)
    // rather than silently reporting a clean-looking false.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`TycoonAgents: detectUefnProject could not complete for root "${root}": ${message}`);
    return { detected: false, signals: [], uefnInstalled: false, lookupError: message };
  }
}
