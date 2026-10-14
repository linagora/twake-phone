// Serves the built app: static files, SPA fallback, the runtime config.json, and the security headers of policy.mjs.
// No dependency: this is what runs in the app's container, and what the browser e2e runs against.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { contentSecurityPolicy, securityHeaders } from './policy.mjs'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

/**
 * `dir`: the build; `config`: what config.json says; `policy`: frameAncestors, connectSrc, hstsMaxAge.
 * Resolves with the origin and a stop function once listening.
 */
export const serveApp = ({ dir, port, host = '127.0.0.1', config, policy = {} }) => {
  const root = resolve(dir)
  const csp = contentSecurityPolicy({ gatewayUrl: config.gatewayUrl, oidcAuthority: config.oidc.authority, ...policy })
  const headers = securityHeaders({ csp, ...policy })
  const configBody = JSON.stringify(config)
  return new Promise((done, fail) => {
    const server = createServer(async (req, res) => {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        return res.end()
      }
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/config.json') {
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
        return res.end(req.method === 'HEAD' ? undefined : configBody)
      }
      let file = resolve(root, '.' + normalize(decodeURIComponent(url.pathname)))
      // Never outside the build, whatever the path says.
      if (file !== root && !file.startsWith(root + sep)) file = join(root, 'index.html')
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
      } catch {
        file = join(root, 'index.html')
      }
      try {
        const body = await readFile(file)
        const type = TYPES[extname(file)] ?? 'application/octet-stream'
        // Hashed assets live under /static/ and never change; the page and anything else may change at each deploy.
        const cache = file.startsWith(join(root, 'static') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache'
        res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'content-length': body.length })
        res.end(req.method === 'HEAD' ? undefined : body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    })
    server.on('error', fail)
    server.listen(port, host, () => {
      const address = server.address()
      const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
      done({ origin: `http://${shown}:${address.port}`, csp, stop: () => new Promise(r => server.close(r)) })
    })
  })
}
