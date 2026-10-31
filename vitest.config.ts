import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const stub = (name: string) => fileURLToPath(new URL(`./packages/phone-link/test/stubs/${name}.ts`, import.meta.url))

export default defineConfig({
  // cozy-client and cozy-interapp are peer dependencies of phone-link and phone-widget, provided by the host
  // Twake Workplace app and not installed in this repository: their tests mock them, but the import still has
  // to resolve, so it is pointed at minimal local stubs.
  resolve: { alias: { 'cozy-client': stub('cozy-client'), 'cozy-interapp': stub('cozy-interapp') } },
  test: {
    env: { LOG_LEVEL: 'silent', AUTH_MODE: 'dev' },
    // twake-mui's build imports its own files without extensions, which Node's ESM loader refuses: Vite resolves them.
    server: { deps: { inline: [/@linagora\/twake-mui/] } },
    include: ['packages/*/src/**/*.spec.ts', 'apps/gateway/src/**/*.spec.ts', 'apps/web/src/**/*.spec.{ts,tsx}', 'apps/web/server/**/*.spec.mjs', 'apps/workplace/src/**/*.spec.mjs']
  }
})
