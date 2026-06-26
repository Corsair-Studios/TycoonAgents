import * as vscode from 'vscode';
import type { ThemeManifest, AgentConfig, RivalConfig } from '../shared/types';
import { expandThemePrompt, buildCharacterAtlasPrompt, buildEnvironmentPrompt } from './translator';
import { generateThemeImage } from './imageClient';
import { sliceAndNormalizeAtlas } from './slicer';

export async function listThemes(
  globalStorageUri: vscode.Uri,
): Promise<Array<{ theme_id: string; display_name: string }>> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(globalStorageUri);
    const results: Array<{ theme_id: string; display_name: string }> = [];
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.File || !name.endsWith('_manifest.json')) continue;
      const theme_id = name.replace(/_manifest\.json$/, '');
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(globalStorageUri, name),
        );
        const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<ThemeManifest>;
        results.push({ theme_id, display_name: manifest.display_name ?? theme_id });
      } catch {
        // skip unreadable/invalid manifests
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function loadTheme(
  globalStorageUri: vscode.Uri,
  themeId: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  try {
    const manifestBytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(globalStorageUri, `${themeId}_manifest.json`),
    );
    const framesBytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(globalStorageUri, `${themeId}_frames.json`),
    );
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as ThemeManifest;
    const frames = JSON.parse(Buffer.from(framesBytes).toString('utf8')) as Record<string, string[]>;
    return { manifest, frames };
  } catch {
    return undefined;
  }
}

export async function generateTheme(
  globalStorageUri: vscode.Uri,
  prompt: string,
  onProgress: (message: string) => void,
  isCancelled?: () => boolean,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> }> {
  onProgress('Expanding theme concept...');
  const { systemPrompt, suggestedManifest } = await expandThemePrompt(prompt);

  const displayName = suggestedManifest.display_name ?? prompt;
  const theme_id = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const sidecarFilename = `${theme_id}_frames.json`;

  const agentEntries = (suggestedManifest.roster_agents ?? []).map((a) => ({
    key: `agent_${a.slot_id}`,
    name: a.name,
    kind: 'agent' as const,
    original: a,
  }));
  const rivalEntries = (suggestedManifest.roster_rivals ?? []).map((r) => ({
    key: r.rival_id,
    name: r.name,
    kind: 'rival' as const,
    original: r,
  }));
  const workList = [...agentEntries, ...rivalEntries];

  const frames: Record<string, string[]> = {};
  const updatedAgents: AgentConfig[] = [];
  const updatedRivals: RivalConfig[] = [];

  for (let i = 0; i < workList.length; i++) {
    if (isCancelled?.()) {
      throw new Error('Generation cancelled by user');
    }

    const entry = workList[i];
    onProgress(`${entry.name} (${i + 1}/${workList.length})`);

    const charPrompt = buildCharacterAtlasPrompt(systemPrompt, entry.name, displayName);
    const buf = await generateThemeImage(charPrompt);
    const pkg = await sliceAndNormalizeAtlas(buf, suggestedManifest);

    frames[entry.key] = pkg.slots.map((s) => s.data);

    const atlasRef = `${sidecarFilename}#${entry.key}`;
    if (entry.kind === 'agent') {
      updatedAgents.push({ ...entry.original, atlas_asset: atlasRef });
    } else {
      updatedRivals.push({ ...entry.original, atlas_asset: atlasRef });
    }

    if (i < workList.length - 1) {
      await new Promise<void>((r) => setTimeout(r, 1500));
    }
  }

  // Environment background
  if (!isCancelled?.()) {
    onProgress('Environment background');
    try {
      const envBuf = await generateThemeImage(buildEnvironmentPrompt(systemPrompt, displayName));
      const envDataUri = 'data:image/png;base64,' + envBuf.toString('base64');
      frames['environment_background'] = [envDataUri];
      if (suggestedManifest.viewport) {
        suggestedManifest.viewport.background_asset = `${sidecarFilename}#environment_background`;
      }
    } catch (envErr) {
      console.warn('TycoonAgents: Environment background generation failed (non-fatal):', envErr);
    }
  }

  const manifest: ThemeManifest = {
    manifest_version: '1.0.0',
    theme_id,
    display_name: displayName,
    author: 'TycoonAgents Factory',
    viewport: suggestedManifest.viewport ?? {
      native_width: 1280,
      native_height: 720,
      background_asset: 'background.png',
      walkable_nav_polygon: [
        [0.50, 0.15], [0.88, 0.38], [0.88, 0.82],
        [0.50, 0.95], [0.12, 0.82], [0.12, 0.38],
      ],
    },
    roster_agents: updatedAgents,
    roster_rivals: updatedRivals,
    buildable_objects: [],
    badges: [],
  };

  await vscode.workspace.fs.createDirectory(globalStorageUri);

  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(globalStorageUri, `${theme_id}_manifest.json`),
    Buffer.from(JSON.stringify(manifest, null, 2)),
  );

  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(globalStorageUri, sidecarFilename),
    Buffer.from(JSON.stringify(frames, null, 2)),
  );

  return { manifest, frames };
}
