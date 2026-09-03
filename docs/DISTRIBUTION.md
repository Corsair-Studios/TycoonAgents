# TycoonAgents — Distribution, Packaging & Install Requirements

> Hard requirements for install robustness across machines. The installer + doctor command MUST satisfy ALL of them. (The provider/host already exist; the *installer* is future work — this doc is its spec.)

## 1. Licensing
- The entire suite is free for personal use under a custom license (not OSI-approved; see `LICENSE`) — no commercial sale, bundling, or redistribution without permission. This includes the bundled **UEFN Power Tools** (clean IP, written post-employment).

## 2. Repository structure (independent Power Tools repo, single source of truth)
- **UEFN Power Tools is an independent, public repo** (`github.com/Corsair-Studios/trashbyrds-uefn-power-tools`) — the single source of truth, publishing its own GitHub Releases via its own build pipeline. TycoonAgents does not bundle it and never downloads it: Power Tools is not bundled, not downloaded — a third-party MCP the user installs themselves per its own `INSTALL.md` (see `docs/POWER-TOOLS-COEXISTENCE.md`).
- General rule: **anything that must exist in 2+ places is generated/published from one source**, never edited by hand in both (cf. the build-time codegen used for the verse agent templates).

## 3. Ship the plugin, not the framework
- The published VS Code extension (VSIX) contains ONLY the runtime plugin. Exclude build/dev tooling, generators, tests, design docs, and the meta-framework that builds it. Enforced via **`.vscodeignore`** (vsce uses `.vscodeignore`, not `.gitignore`); maintain exclude-by-default and verify each release's contents. (See DESIGN section 13.)

## 3a. VSIX output location
- `npm run package` builds the VSIX into `dist/` (via `vsce package -o dist/`), never at the repo root. `dist/` is excluded by both `.gitignore` and `.vscodeignore`. Release artifacts are never committed — `npm run release` uploads the built VSIX as a GitHub Release asset (`gh release create`).

## 4. Install robustness checklist
Each item answers a real failure:
- **Doctor / verify command (first-class).** Prints the *actual resolved paths* the system loads from — never assume. (Hooks can load from an unexpected dir — e.g. a Fortnite install's Content/Python — so never assume.)
- **No machine- or version-specific absolute paths in config.** Resolve at runtime / validate; **self-heal stale or versioned paths** on activation. (A hook command baked an absolute node path that broke on other machines; `.mcp.json` pinned a versioned extension path VS Code deletes on upgrade.)
- **Cross-platform from day one.** The shell tool is **PowerShell on Windows**, Bash elsewhere — emit BOTH matchers. Handle path/shell differences explicitly.
- **Loud failures, never silent.** Post-install validation checks every precondition (scripts present, config valid JSON, paths resolve, hooks registered for the right events/matchers) and **surfaces exactly what is missing** with a visible message. (Silent failures can leave a dark panel for days.)
- **Reload awareness.** Config changes take effect on session/editor reload (hooks load at session start; some runtimes cache modules at load). The installer must clearly tell the user when a restart is required.

## 5. Install-over-existing must MERGE, not clobber
Concrete failure mode: when a user already has their own `CLAUDE.md`, agent definition files, and `settings.local.json`, installing on top can break the hooks if existing files are not merged correctly.
Requirements:
- **`CLAUDE.md`:** update only a **managed block** delimited by begin/end markers; preserve everything outside it; create the file with the block if absent. Never overwrite the user's content.
- **Settings (`.claude/settings(.local).json`):** **deep-merge** our hooks/keys into existing JSON; **NEVER drop the user's other keys.** On malformed JSON, back up AND attempt repair — do NOT silently reset to `{}` (a naive installer would, losing user settings).
- **Agent files:** add ours **without overwriting** the user's; namespace to avoid collisions.
- **Idempotent:** re-running install/repair must not duplicate hook entries or corrupt files.
- **Doctor / repair command:** detects and **mends** broken, missing, or unmerged hooks, scripts, and dependencies; reports exactly what it changed; **safe to run repeatedly.** This is the single most important install feature — make it real, not an afterthought.

## 6. End-user repo hygiene (mixed teams)
- Many users share a repo with teammates who do NOT use Claude Code. On setup, add per-developer agent artifacts (`.claude/`, `CLAUDE.md`, local settings) to the user's project **`.gitignore`**, and for **UEFN/Fortnite** projects to **`.urcignore`** (Unreal Revision Control; `.NET` globbing; add `CLAUDE.md` + `.claude/**`). (See DESIGN section 13.)

## 7. UEFN integration
- The UEFN **Power Tools** are the suite's UEFN integration: when a creator works in UEFN with an AI agent (via the Power Tools' MCP bridge), that activity drives the TycoonAgents panel. Independently licensed and distributed from its own repo (section 2); not bundled, not downloaded — a third-party MCP the user installs themselves (see `POWER-TOOLS-COEXISTENCE.md`).
