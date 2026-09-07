# Coding standards by path

These are starting defaults, not fixed law — tune the path patterns and
standards below to fit this project's actual layout and conventions.

| Area | Path patterns | Standards |
| --- | --- | --- |
| Gameplay / systems logic | `src/game/**`, `src/systems/**` | No hardcoded tuning values — read them from data/config; keep simulation logic deterministic and covered by tests. |
| UI / HUD | `src/ui/**`, `**/*.tsx`, `**/*.css` | Keep layout, state, and styling changes reviewable together; prefer the UI/design specialist for canvas, animation, and CSS work. |
| Networking / multiplayer | `src/net/**`, `src/server/**` | Validate all client input server-side; never trust client-reported state; keep message schemas versioned. |
| Assets / data | `assets/**`, `data/**`, `**/*.json` | No secrets or absolute filesystem paths baked into shipped data; keep generated assets reproducible from their source config. |
| Config / build | `*.config.*`, `package.json`, `tsconfig*.json` | No secrets or machine-specific absolute paths; changes here should not silently alter another area's behavior. |
| Tests | `test/**`, `**/*.spec.*`, `**/*.test.*` | Tests cover the stated acceptance criteria, stay deterministic (no real timers/network), and are verified by someone other than the author of the change under test. |
| Engine scripts (GDScript / C# / Verse / Python) | `**/*.gd`, `**/*.cs`, `**/*.verse`, `**/*.py` | Keep editor-bridge imports side-effect-free; match the host engine's idioms rather than porting patterns from another language verbatim. |

## UEFN/Verse variant

On a detected UEFN/Verse project, the table drops the web/TS-only
"Gameplay / systems logic" row (the `src/game` glob) and the "UI / HUD" row
(the `.tsx`/`.css` globs) — neither applies to a Verse-device project — and
swaps the "Config / build" row's web-specific patterns (`package.json`,
`tsconfig*.json`) for UEFN project files:

| Area | Path patterns | Standards |
| --- | --- | --- |
| Networking / multiplayer | `src/net/**`, `src/server/**` | Validate all client input server-side; never trust client-reported state; keep message schemas versioned. |
| Assets / data | `assets/**`, `data/**`, `**/*.json` | No secrets or absolute filesystem paths baked into shipped data; keep generated assets reproducible from their source config. |
| Config / build | `*.config.*`, `*.uefnproject`, `*.uproject` | No secrets or machine-specific absolute paths; changes here should not silently alter another area's behavior. |
| Tests | `test/**`, `**/*.spec.*`, `**/*.test.*` | Tests cover the stated acceptance criteria, stay deterministic (no real timers/network), and are verified by someone other than the author of the change under test. |
| Engine scripts (GDScript / C# / Verse / Python) | `**/*.gd`, `**/*.cs`, `**/*.verse`, `**/*.py` | Keep editor-bridge imports side-effect-free; match the host engine's idioms rather than porting patterns from another language verbatim. |
