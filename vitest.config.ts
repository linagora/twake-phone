import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const phoneModules = (name: string) => fileURLToPath(new URL(`./apps/phone/node_modules/${name}`, import.meta.url))

export default defineConfig({
  // cozy-client and cozy-interapp are peer dependencies installed with the Phone app, not at the root:
  // tests of packages that import them mock them, but the import still has to resolve.
  resolve: { alias: { 'cozy-client': phoneModules('cozy-client'), 'cozy-interapp': phoneModules('cozy-interapp') } },
  test: { env: { LOG_LEVEL: 'silent', AUTH_MODE: 'dev' }, include: ['packages/*/src/**/*.spec.ts', 'apps/gateway/src/**/*.spec.ts', 'apps/web/src/**/*.spec.{ts,tsx}'] }
})
