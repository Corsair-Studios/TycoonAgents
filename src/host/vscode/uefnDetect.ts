/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export function detectUefnProject(root: string): { detected: boolean; signals: string[]; uefnInstalled: boolean } {
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

    // Check if UEFN is installed
    const localAppData = process.env["LOCALAPPDATA"];
    let uefnInstalled = false;
    if (localAppData !== undefined) {
      const uefnPath = path.join(localAppData, "UnrealEditorFortnite");
      uefnInstalled = fs.existsSync(uefnPath);
    }

    return { detected: signals.length > 0, signals, uefnInstalled };
  } catch {
    return { detected: false, signals: [], uefnInstalled: false };
  }
}
