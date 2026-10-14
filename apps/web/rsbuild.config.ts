import { defineConfig, type MetaOptions } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'

/**
 * Content Security Policy of the built page: tokens live in sessionStorage, so no script but ours may run. The Gateway
 * and the identity provider are only known at runtime (config.json), hence the broad connect-src; the server that
 * serves the app (apps/web/server) sends the tight one, with those two origins and frame-ancestors, as a header.
 * This one is the fallback of a static host that sets no header. Dev builds skip it: rsbuild injects styles inline.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The SIP WebSocket's origin is runtime configuration, hence `wss:` here; the server's header narrows it to CONNECT_SRC.
  // A local Gateway without TLS is reached over http and its event stream over ws (browsers do not take one for the other).
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ')

export default defineConfig(({ env }) => ({
  plugins: [pluginReact()],
  html: {
    title: 'TwakePhone',
    template: './index.html',
    meta: (env === 'production' ? { 'Content-Security-Policy': { 'http-equiv': 'Content-Security-Policy', content: CSP } } : {}) as MetaOptions
  },
  source: { entry: { index: './src/main.tsx' } },
  // Runtime configuration (gateway URL, OIDC) is public/config.json, copied to dist with the rest of public/.
  server: { port: 4173, historyApiFallback: true },
  dev: { writeToDisk: false }
}))
