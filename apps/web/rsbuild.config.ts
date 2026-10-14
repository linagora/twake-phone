import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'

export default defineConfig({
  plugins: [pluginReact()],
  html: { title: 'TwakePhone', template: './public/index.html' },
  source: { entry: { index: './src/main.tsx' } },
  // Runtime configuration (gateway URL, OIDC) comes from public/config.json, so one build runs anywhere.
  output: { copy: [{ from: './public/config.json', to: 'config.json', noErrorOnMissing: true }] },
  server: { port: 4173, historyApiFallback: true },
  dev: { writeToDisk: false }
})
