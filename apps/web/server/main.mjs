// Entry point of the app's container: serves dist/ with the config and policy read from the environment.
import { fileURLToPath } from 'node:url'
import { settingsFromEnv } from './policy.mjs'
import { serveApp } from './serve.mjs'

const { config, policy, port, host } = settingsFromEnv(process.env)
const { origin, csp } = await serveApp({ dir: fileURLToPath(new URL('../dist/', import.meta.url)), port, host, config, policy })
console.log(`TwakePhone web app on ${origin} (gateway ${config.gatewayUrl}, identity provider ${config.oidc.authority})`)
console.log(`Content-Security-Policy: ${csp}`)
