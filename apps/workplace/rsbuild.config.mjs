import { fileURLToPath } from 'node:url'
import { defineConfig, mergeRsbuildConfig } from '@rsbuild/core'
import { getRsbuildConfig } from 'rsbuild-config-cozy-app'

// The number check of TwakePhone (toDialTarget) comes from the monorepo, built first (`yarn build` at the root):
// this app keeps its own lockfile like any Cozy app, so it takes the package's built output by alias.
const pkg = name => fileURLToPath(new URL(`../../packages/${name}/dist/index.js`, import.meta.url))

export default defineConfig(
  mergeRsbuildConfig(getRsbuildConfig({ title: 'Twake Phone', hasIntents: true }), {
    resolve: { alias: { '@twake/telephony-client': pkg('telephony-client') } }
  })
)
