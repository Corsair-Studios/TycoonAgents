# Contributing to TycoonAgents

Thanks for your interest. TycoonAgents is source-available under the Functional Source License 1.1 (FSL-1.1-ALv2); see [LICENSE](LICENSE). Pull requests are welcome under those license terms: by submitting one you agree your contribution is provided under the same license.

## Development setup

Requirements: Node.js 20 or newer and npm.

```
npm ci
npm test
```

Useful checks before opening a pull request:

- `npm test` compiles with `tsc` and runs the root suite.
- `npm run lint` runs ESLint.
- `npm run check:webview` verifies that `media/main.js` matches its sources in `media/src/main/` and passes the webview checks. After editing a file in `media/src/main/`, run `npm run build:webview` to regenerate `media/main.js`.
- `npm run check:paths` fails if a shipped file contains an absolute filesystem path.
- `npm run test:standalone` runs the standalone host tests.

## Tests

Tests use the Node built-in runner (`node:test`) with `node:assert`. Keep them deterministic: no real timers and no network access.

Test fakes for external tools are Node scripts behind `.cmd` shims. Never add compiled binaries or `.exe` fakes; they are blocked by Windows application-control policies and flood security alerts.

## Pull requests

- Keep changes focused; avoid unrelated refactors.
- Match the surrounding code style and naming.
- Add or update tests for behavior changes.
- Describe what changed and why, and how you verified it.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
