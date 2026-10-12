// Windows resolves a bare command name against the child's cwd before PATH, so a project
// directory can plant explorer.exe / rundll32.exe / cmd.exe. Resolve system executables
// absolutely instead. Returns the bare name unchanged on other platforms or when absent.
import fs from 'node:fs';
import path from 'node:path';

export function winSystemExe(name, { inWindowsDir = false, platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return name;
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const full = inWindowsDir ? path.join(root, name) : path.join(root, 'System32', name);
  try {
    return exists(full) ? full : name;
  } catch {
    return name;
  }
}
