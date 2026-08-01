# TycoonAgents — Attribution Policy

How TycoonAgents credits itself: minimally, where it helps, and never by cluttering a user's code. Four layers.

## 1. Own-repo source files — significant/entry files only
- A short header is OPTIONAL and applied only to **significant or entry-point** files (e.g. the extension entry point, the core/provider public modules, the hook script) — NOT every file.
- `LICENSE` is the baseline attribution: it states the terms TycoonAgents (code and bundled theme art) is made available under, so per-file headers add little beyond it.
- Header format when used — keep it to three lines; do not expand into a license block:

```
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */
```
For hash-comment languages (Python/PowerShell/shell), use the same three lines prefixed with `#`.

## 2. Harness footprint in a user's project — one line, in our managed block
- When TycoonAgents writes/manages files in a user's project — `CLAUDE.md` and the agent definition files it generates — it includes ONE short attribution line, inside its **managed block** (begin/end markers), framed as context:
  `This project uses the TycoonAgents harness — https://x.com/thetrashbyrd`
- It lives inside the managed markers only (updates in place; never clobbers user content; see `DISTRIBUTION.md` section 5).
- NOTE: these files are typically gitignored / `.urcignore`d for mixed teams (DESIGN section 13), so this credit is seen mainly by the local Claude-using developer — it is a footprint marker, not a reach mechanism.

## 3. NEVER stamp the user's generated code
- TycoonAgents does NOT inject attribution into code the user's agents write in the user's project. That is their code. If ever offered, it must be an OPT-IN setting, OFF by default.

## 4. Primary visible credit — where reach actually happens
- A small clickable **"powered by TycoonAgents · @thetrashbyrd"** in the panel UI (links to https://x.com/thetrashbyrd).
- The README, the VS Code Marketplace listing, and `LICENSE`.
- This is the credit teammates, repo browsers, and prospective users actually see.

## TODO
- Releases URL: `https://github.com/Corsair-Studios/TycoonAgents/releases`.
