// Minimal flat-config ESLint setup for TycoonAgents.
//
// Scope is deliberately narrow: only the TypeScript sources under src/ and
// test/, plus the Node-target build scripts. Everything else is either
// untyped-by-design and covered by its own crash-class checker
// (media/**, see scripts/check-webview.mjs), vendored/generated output
// (out/**), defensive CJS with intentional patterns (hooks/**), or a
// separately-scoped bundle (uefn-bridge/**, tools/design-doc/**).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'media/**',
      'out/**',
      'hooks/**',
      'uefn-bridge/**',
      'tools/design-doc/**',
      'node_modules/**',
      // .claude/ holds installed/generated skill artifacts (bundled .mjs,
      // the hook .cjs), not authored source — same rationale as media/** and
      // out/** above.
      '.claude/**',
      '**/*.vsix',
    ],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // Host/webview message payloads and provider SDK responses are
      // progressively typed; blanket-banning `any` today would just force
      // `as any` casts with no real safety gain until those types firm up.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Underscore-prefixed args/vars are used throughout as an intentional
      // "unused on purpose" marker (callback signatures, destructuring).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Several modules intentionally require() at runtime (optional/lazy
      // deps, VS Code host interop) rather than static-importing.
      '@typescript-eslint/no-require-imports': 'warn',
      // Flags `let x = <init>` where <init> is provably never read on some
      // path (e.g. a try/catch that always reassigns or returns first).
      // Real hits exist in themeService.ts/panel.ts/agentRoster.ts; fixing
      // them means restructuring control flow, not a mechanical edit, so
      // they're surfaced as warnings rather than fixed blind here.
      'no-useless-assignment': 'warn',
      // Flags `throw new Error(...)` inside a catch block that doesn't
      // attach the caught error as `{ cause }`. Legitimate ask, but fixing
      // it touches error-handling semantics across several call sites —
      // left as a warning for a deliberate pass rather than a lint-baseline
      // drive-by.
      'preserve-caught-error': 'warn',
      // Flags `let lastTheme` (main.ts) that's declared but never assigned
      // anywhere in the file — looks like a real latent gap (the cache is
      // always undefined), not lint noise. Left as a warning rather than
      // guessed-at behavior fix.
      'no-unassigned-vars': 'warn',
    },
  },
);
