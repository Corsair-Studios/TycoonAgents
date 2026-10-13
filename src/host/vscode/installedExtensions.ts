import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MCP_BRIDGE_HOOK_FILES, RUNTIME_HOOK_FILES } from "./hookInstall";

/**
 * Discovery of REAL installed TycoonAgents extensions on disk, outside any
 * project (docs/PATH-DISCOVERY.md). Evidence from a project (stamps, copies) is
 * never trusted; only these folders are. Ladder: TYCOON_EXTENSION_DIRS override
 * (path-delimited extension folders or extension roots) wins and is used with
 * the running extension; otherwise the running extension's parent dir plus the
 * known editor extension roots under the home dir. Candidates are accepted by
 * CONTENT (package.json name/publisher + a hooks dir), never by folder name.
 */
const ROOT_DIR_NAMES = [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf", ".antigravity", ".positron", ".vscodium", ".trae", ".kiro"];

export interface InstalledExtension {
  dir: string;
  version: string;
}

function readOwnPackage(dir: string): InstalledExtension | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg?.name !== "tycoonagents" || pkg?.publisher !== "tycoonagents" || typeof pkg.version !== "string") return null;
    if (!fs.existsSync(path.join(dir, "hooks"))) return null;
    return { dir, version: pkg.version };
  } catch {
    return null;
  }
}

function childDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Installed TycoonAgents extensions other than `selfDir`, de-duplicated. Never throws. */
export function discoverSiblingExtensions(selfDir: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): InstalledExtension[] {
  const roots: string[] = [];
  const direct: string[] = [];
  const override = env["TYCOON_EXTENSION_DIRS"];
  if (override && override.trim() !== "") {
    for (const p of override.split(path.delimiter).map((x) => x.trim()).filter(Boolean)) {
      direct.push(p);
      roots.push(p);
    }
  } else {
    roots.push(path.dirname(selfDir));
    for (const n of ROOT_DIR_NAMES) roots.push(path.join(home, n, "extensions"));
  }
  const seen = new Set<string>([path.resolve(selfDir).toLowerCase()]);
  const out: InstalledExtension[] = [];
  for (const cand of [...direct, ...roots.flatMap(childDirs)]) {
    const key = path.resolve(cand).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ext = readOwnPackage(cand);
    if (ext) out.push(ext);
  }
  return out;
}

/** The shipped copy of a hook file inside one extension folder (the installer's own sources). */
export function extensionHookSource(extDir: string, fileName: string): string | undefined {
  for (const p of [path.join(extDir, "hooks", fileName), path.join(extDir, "out", "src", "core", fileName)]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function sameBytes(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * True when the project's existing hook copies (at least one) are byte-identical,
 * file by file, to ONE installed extension NEWER than `selfVersion`: a newer
 * editor produced them, so this older install must not overwrite them.
 */
export function copiesFromNewerInstall(root: string, selfVersion: string | null, siblings: InstalledExtension[]): boolean {
  if (selfVersion === null) return false;
  const groups: Array<[string, ReadonlyArray<string>]> = [
    [path.join(root, ".claude", "tycoon"), RUNTIME_HOOK_FILES],
    [path.join(root, ".claude", "hooks"), MCP_BRIDGE_HOOK_FILES],
  ];
  for (const ext of siblings) {
    if (compareVersions(ext.version, selfVersion) <= 0) continue;
    let any = false;
    let all = true;
    for (const [dir, files] of groups) {
      for (const f of files) {
        const dest = path.join(dir, f);
        if (!fs.existsSync(dest)) continue;
        const src = extensionHookSource(ext.dir, f);
        if (src && sameBytes(src, dest)) any = true;
        else {
          all = false;
          break;
        }
      }
    }
    if (any && all) return true;
  }
  return false;
}
