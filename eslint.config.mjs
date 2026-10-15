// The one lint of the monorepo: `yarn lint`, run by CI after `yarn build` (packages read each other through their
// `dist/*.d.ts`, as for `yarn typecheck`). A warning fails it like an error (--max-warnings 0).
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// What the tsconfigs compile is linted with its types (the type-checked rules). The specs outside the web app and
// the storage contract are left out of their tsconfig: they get the rules that need no types.
const typed = ['packages/*/src/**/*.{ts,tsx}', 'apps/gateway/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'apps/web/rsbuild.config.ts']
const outsideTsconfig = ['packages/*/src/**/*.spec.{ts,tsx}', 'apps/gateway/src/**/*.spec.ts', 'apps/gateway/src/store/contract.ts']

export default defineConfig(
  { ignores: ['**/node_modules/', '**/dist/', '**/build/', '**/coverage/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      // A leading `_` names what a signature imposes without being used (a fake in a test, an interface's
      // parameter); `{ [id]: _, ...rest }` drops a key.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }]
    }
  },
  {
    files: typed,
    ignores: outsideTsconfig,
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Off: `async` without `await` keeps a promise-returning contract here (the in-memory Store, the provider's
      // methods), where a throw becomes a rejection; some forty hits, none a bug.
      '@typescript-eslint/require-await': 'off',
      // Passing on a caught error (`unknown`) as it is, is meant; rejecting with something that is not an error, not.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }]
    }
  },
  {
    // Tests fake fetch, pg or JsSIP: `any` is a tool for fakes there, not a typing debt.
    files: ['**/*.spec.{ts,tsx}', '**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },
  {
    // Browser code: the web app, the widget, the link to the app, the softphone and the client (and their jsdom tests).
    files: ['apps/web/src/**', 'packages/{phone-link,phone-widget,softphone,telephony-client}/**'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/phone-link/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // A missing dependency is a stale value: an error, not a warning.
      'react-hooks/exhaustive-deps': 'error',
      // The two rules below serve the React Compiler, which the app does not use.
      // Off: clearing the state at the start of an effect that loads (directory, favourites, capabilities) is the
      // app's pattern; moving it to the handlers would change when the screen empties.
      'react-hooks/set-state-in-effect': 'off',
      // Off: `ref.current = value` during render (the latest value, read by an effect without restarting it) is meant.
      'react-hooks/refs': 'off'
    }
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } }
  },
  {
    // The e2e drive a browser and evaluate functions in its pages and its service worker (evaluate): globals of
    // every side.
    files: ['apps/web/test/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.serviceworker } }
  }
)
