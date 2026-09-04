// TycoonAgents standalone — core agent roster seeder (p16-t3).
//
// `.claude/` is gitignored and the core roster (`.claude/agents/*.md` +
// `.claude/tycoon/agent-keywords.json`) is otherwise only ever written by
// the VS Code panel (src/host/vscode/panel.ts `_installWorkerAgents` /
// `_installReviewerAgent`, built from src/host/vscode/packCatalog.ts). An
// OpenCode-only user who never opens the VS Code panel gets none of it, so
// scripts/apply-routing-profile.mjs and scripts/generate-opencode-config.mjs
// have nothing to route.
//
// This module reuses (never forks) the compiled `out/src/host/vscode/`
// catalog/generator logic via createRequire — the exact same pattern
// sharedLogic.mjs and installHook.mjs already use for state.js/
// hookInstall.js. One fix to packCatalog.ts's roster or
// agentKeywordDefaults.ts's defaults reaches both hosts automatically.
//
// Agent set matched (fresh, non-UEFN, direct-delegation-mode VS Code
// install — see panel.ts `_handleInstallHooks` ~5837-5852):
//   - `workerAgentsForProject(false)` -> search-retrieval, primary-agent,
//     coding-specialist, ux-ui-designer (the UEFN branch additionally
//     withholds coding-specialist/ux-ui-designer; a fresh non-UEFN direct
//     install is the closest single default to mirror here).
//   - `REVIEWER_AGENTS` -> reviewer (installed by default; `reviewEnabled`
//     defaults to true on a fresh install, and the standalone path has no
//     panel toggle to read, so it is always seeded).
//   - `LEAD_AGENTS` (build-lead, quality-lead) and `FOREIGN_LLM_AGENTS`
//     (codex-reviewer, gemini-reviewer, kimi-reviewer, claude-worker) are
//     NOT seeded: panel.ts only installs LEAD_AGENTS when the user has
//     explicitly picked `team_leads` mode (not the default), and never
//     writes FOREIGN_LLM_AGENTS `.md` files from any install path at all —
//     they exist only as `DEFAULT_AGENT_KEYWORDS` entries, installed on
//     disk solely via the opt-in foreign-LLM/pack UI flow this standalone
//     CLI has no equivalent of. Seeding either set here would create files
//     the VS Code panel itself would never have written for the same
//     "fresh install" scenario.
//   - `orchestrator` (in `REGULAR_AGENTS` but never in
//     `workerAgentsForProject`'s output) is likewise not seeded — no
//     install path writes it either.
//
// Node built-ins only — standalone/package.json ships zero dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACK_CATALOG_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'packCatalog.js');
const AGENT_KEYWORD_DEFAULTS_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'agentKeywordDefaults.js');

const require = createRequire(import.meta.url);

/** Thrown for any fatal, user-actionable seeding failure. */
export class SeedAgentsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedAgentsError';
  }
}

function requireCompiled(absPath, friendlyLabel) {
  if (!fs.existsSync(absPath)) {
    throw new SeedAgentsError(
      `TycoonAgents: ${friendlyLabel} not found at "${absPath}". The compiled \`out/\` directory is ` +
        'missing or stale — run `npx tsc -p .` from the repo root first, then retry.',
    );
  }
  return require(absPath);
}

/**
 * The roster this seeder writes, in write order. Pure — reads only the
 * compiled catalog, never touches fs. Exported for tests.
 * @returns {Array<object>} PackAgent-shaped objects (id/name/model/role/keywords/tier?).
 */
export function agentsToSeed() {
  const catalog = requireCompiled(PACK_CATALOG_JS, 'out/src/host/vscode/packCatalog.js');
  const workers = catalog.workerAgentsForProject(false);
  return [...workers, ...catalog.REVIEWER_AGENTS];
}

/**
 * Idempotently seed `.claude/agents/<id>.md` for the roster above, and
 * `.claude/tycoon/agent-keywords.json` if it's missing entirely.
 *
 * - An existing `.claude/agents/<id>.md` is NEVER overwritten, regardless
 *   of its content (unlike the VS Code panel's `_installWorkerAgents`,
 *   which is also create-if-absent for workers, but `_installAgentFiles`
 *   refreshes a recognized reviewer file in place — this seeder always
 *   takes the simpler, strictly-additive "never touch what's there" rule
 *   for both, since there is no on-disk fingerprint to trust yet on a
 *   first standalone-only install).
 * - `.claude/tycoon/agent-keywords.json` is written ONLY when absent —
 *   seeded via the compiled `seedMissingAgentKeywords`/`DEFAULT_AGENT_KEYWORDS`
 *   (agentKeywordDefaults.ts), not a duplicated keyword map, for the ids in
 *   {@link agentsToSeed}. An existing file (even an empty `{}`) is left
 *   completely untouched — resyncing an existing project's keyword file is
 *   out of scope for a first-install seeder.
 *
 * @param {string} targetDir project directory to seed into.
 * @returns {{ agentsDir: string, keywordsPath: string, seededAgents: string[],
 *   skippedAgents: string[], seededKeywords: boolean }}
 * @throws {SeedAgentsError} on a missing/non-directory target, or a missing/
 *   stale `out/` build.
 */
export function seedAgents(targetDir) {
  const absTarget = path.resolve(String(targetDir ?? ''));

  let targetStat;
  try {
    targetStat = fs.statSync(absTarget);
  } catch {
    throw new SeedAgentsError(`TycoonAgents: seed-agents target directory not found: "${absTarget}"`);
  }
  if (!targetStat.isDirectory()) {
    throw new SeedAgentsError(`TycoonAgents: seed-agents target is not a directory: "${absTarget}"`);
  }

  const catalog = requireCompiled(PACK_CATALOG_JS, 'out/src/host/vscode/packCatalog.js');
  const agents = agentsToSeed();
  const reviewerIds = new Set(catalog.REVIEWER_AGENTS.map((a) => a.id));

  const agentsDir = path.join(absTarget, '.claude', 'agents');
  const seededAgents = [];
  const skippedAgents = [];
  for (const a of agents) {
    const agentPath = path.join(agentsDir, `${a.id}.md`);
    if (fs.existsSync(agentPath)) {
      skippedAgents.push(a.id);
      continue;
    }
    fs.mkdirSync(agentsDir, { recursive: true });
    // Match panel.ts byte-for-byte: workers get packId "worker"
    // (_installWorkerAgents, panel.ts:6102); REVIEWER_AGENTS get no packId
    // at all (_installAgentFiles -> buildAgentMarkdown(a), panel.ts:5937) —
    // passing "worker" for reviewer.md would add a spurious tycoon_pack line.
    const packId = reviewerIds.has(a.id) ? undefined : 'worker';
    fs.writeFileSync(agentPath, catalog.buildAgentMarkdown(a, packId), 'utf8');
    seededAgents.push(a.id);
  }

  const keywordsPath = path.join(absTarget, '.claude', 'tycoon', 'agent-keywords.json');
  let seededKeywords = false;
  if (!fs.existsSync(keywordsPath)) {
    const { seedMissingAgentKeywords } = requireCompiled(
      AGENT_KEYWORD_DEFAULTS_JS,
      'out/src/host/vscode/agentKeywordDefaults.js',
    );
    const ids = agents.map((a) => a.id);
    const { config } = seedMissingAgentKeywords({}, ids);
    fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
    fs.writeFileSync(keywordsPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    seededKeywords = true;
  }

  return { agentsDir, keywordsPath, seededAgents, skippedAgents, seededKeywords };
}
