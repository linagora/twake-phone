import { fileURLToPath } from 'node:url'
import { defineConfig, mergeRsbuildConfig } from '@rsbuild/core'
import { getRsbuildConfig } from 'rsbuild-config-cozy-app'

const pkg = name =>
  fileURLToPath(new URL(`../../packages/${name}/dist/index.js`, import.meta.url))

const config = getRsbuildConfig({
  title: 'Twake Phone',
  hasIntents: true
})

// The telephony packages live in the monorepo (outside this app, which keeps its own
// lockfile like any Cozy app): consume their built output by alias.
// Build them first with `yarn build` at the repository root.
export default defineConfig(
  mergeRsbuildConfig(config, {
    resolve: {
      alias: {
        '@twake/softphone': pkg('softphone'),
        '@twake/telephony-client': pkg('telephony-client')
      }
    }
  })
)
