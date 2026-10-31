// The one lint of the monorepo: `yarn lint`. A warning fails it like an error (--max-warnings 0).
// Run it after `yarn build`: the gateway and the packages read each other's sources through their project references,
// but the web app and the specs (tsconfig.eslint.json) read the packages through their built `dist/*.d.ts`.
import { fileURLToPath } from 'node:url'
import { includeIgnoreFile } from '@eslint/compat'
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Linted with their types (the type-checked rules), through the tsconfig that compiles them...
const inPackageTsconfig = ['packages/*/src/**/*.{ts,tsx}', 'apps/gateway/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'apps/web/rsbuild.config.ts']
// ...or, for what no package tsconfig compiles (specs, test helpers, the storage contract), through tsconfig.eslint.json.
const inLintTsconfig = ['packages/*/src/**/*.spec.{ts,tsx}', 'packages/*/test/**/*.ts', 'apps/gateway/src/**/*.spec.ts', 'apps/gateway/src/store/contract.ts']

export default defineConfig(
  // What the repository ignores (.gitignore), ESLint does too: build output, and the agents' worktrees under .claude/.
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // A leading `_` names what a signature imposes without being used (a fake in a test, an interface's
      // parameter); `{ [id]: _, ...rest }` drops a key.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }]
    }
  },
  {
    files: [...inPackageTsconfig, ...inLintTsconfig],
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    rules: {
      // Off: `async` without `await` keeps a promise-returning contract here (the in-memory Store, the provider's
      // methods, the fakes of the tests), where a throw becomes a rejection; dozens of hits, none a bug.
      '@typescript-eslint/require-await': 'off',
      // Passing on a caught error (`unknown`) as it is, is meant; rejecting with something that is not an error, not.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }]
    }
  },
  {
    files: inPackageTsconfig,
    ignores: inLintTsconfig,
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } }
  },
  {
    files: inLintTsconfig,
    languageOptions: { parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: import.meta.dirname } }
  },
  {
    // Tests fake fetch, pg or JsSIP and read the JSON their requests answer (`res.json()` is `any`): `any` is a tool
    // there, checked by the expectations that follow, not a typing debt (about 290 hits of the five rules).
    // The promise rules (floating, misused, thenable) stay on.
    files: ['**/*.spec.{ts,tsx}', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off'
    }
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/phone-link/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    // A missing dependency is a stale value: an error, not a warning.
    rules: { 'react-hooks/exhaustive-deps': 'error' }
  },
  // Globals by where the code runs. They only matter to the .js and .mjs files: on TypeScript, `no-undef` is off
  // (typescript-eslint) and the compiler knows the globals from each tsconfig's `lib` and `types`.
  {
    files: ['*.{js,mjs,ts}', 'apps/gateway/**', 'apps/web/server/**', 'apps/web/test/**', 'packages/*/test/**', '**/*.spec.{ts,tsx,mjs}'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // The e2e also evaluate functions in the app's pages and in its service worker.
    files: ['apps/web/test/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } }
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } }
  },
  {
    // The Twake Workplace app (ADR 0032): plain JavaScript and JSX like the Cozy apps, bundled by rsbuild.
    files: ['apps/workplace/src/**/*.{js,jsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.browser } },
    rules: { 'react-hooks/exhaustive-deps': 'error' }
  },
  {
    files: ['apps/workplace/*.mjs', 'apps/workplace/test/**'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['apps/workplace/test/**'],
    languageOptions: { globals: { ...globals.browser } }
  }
)
