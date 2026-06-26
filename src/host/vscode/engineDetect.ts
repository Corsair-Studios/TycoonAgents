/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";

// Project-aware "setup" detection for non-UEFN game engines. UEFN has its own
// live-heartbeat chip; these engines have no bridge, so the chip reflects
// whether the engine's project is present and whether its pack/skill is set up.

export interface EngineChip {
  id: string;
  label: string;
  state: "ready" | "setup";
  detail: string;
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** List the entries of a directory, or [] on any error. */
function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Detect non-UEFN engine projects under `root`. Returns a chip ONLY for engines
 * whose project is detected; state is "ready" when the engine's pack/skill is
 * installed, else "setup".
 */
export function detectEngineSetups(root: string): EngineChip[] {
  const chips: EngineChip[] = [];
  if (!root) {
    return chips;
  }

  try {
    const entries = listDir(root);
    const hasExt = (ext: string): boolean => entries.some((e) => e.toLowerCase().endsWith(ext));
    const claude = path.join(root, ".claude");

    const push = (id: string, label: string, installed: boolean): void => {
      chips.push({
        id,
        label,
        state: installed ? "ready" : "setup",
        detail: installed
          ? `${label} project detected — pack/skill installed.`
          : `${label} project detected — install the ${label} pack from the catalog to set up its agents.`,
      });
    };

    // Godot
    if (existsSafe(path.join(root, "project.godot"))) {
      const installed =
        existsSafe(path.join(claude, "agents", "godot.md")) ||
        existsSafe(path.join(claude, "skills", "godot"));
      push("godot", "Godot", installed);
    }

    // Unity
    if (
      existsSafe(path.join(root, "ProjectSettings", "ProjectVersion.txt")) ||
      (existsSafe(path.join(root, "ProjectSettings")) && existsSafe(path.join(root, "Assets")))
    ) {
      const installed =
        existsSafe(path.join(claude, "agents", "unity.md")) ||
        existsSafe(path.join(claude, "skills", "unity"));
      push("unity", "Unity", installed);
    }

    // Unreal — *.uproject present, but exclude UEFN projects (Content/Verse or *.verse)
    const isUefn = existsSafe(path.join(root, "Content", "Verse")) || hasExt(".verse");
    if (hasExt(".uproject") && !isUefn) {
      const installed = existsSafe(path.join(claude, "skills", "unreal-engine"));
      push("unreal", "Unreal", installed);
    }

    // Roblox — a .rbxl/.rbxlx place, or a Rojo project file
    const hasRojo =
      existsSafe(path.join(root, "default.project.json")) ||
      entries.some((e) => e.toLowerCase().endsWith(".project.json"));
    if (hasExt(".rbxl") || hasExt(".rbxlx") || hasRojo) {
      const installed =
        existsSafe(path.join(claude, "agents", "roblox.md")) ||
        existsSafe(path.join(claude, "skills", "roblox"));
      push("roblox", "Roblox", installed);
    }
  } catch {
    return [];
  }

  return chips;
}
