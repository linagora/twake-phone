// Serves the built app: static files, SPA fallback, the runtime config.json, and the security headers of policy.mjs.
// No dependency: this is what runs in the app's container, and what the browser e2e runs against.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { contentSecurityPolicy, securityHeaders } from './policy.mjs'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.map': 'application/json'
}

/**
 * `dir`: the build; `config`: what config.json says; `policy`: frameAncestors, connectSrc, hstsMaxAge.
 * Resolves with the origin and a stop function once listening.
 */
export const serveApp = ({ dir, port, host = '127.0.0.1', config, policy = {} }) => {
  const root = resolve(dir)
  const cspWith = styleNonce => contentSecurityPolicy({ gatewayUrl: config.gatewayUrl, oidcAuthority: config.oidc.authority, ...policy, styleNonce })
  const csp = cspWith()
  const headers = securityHeaders({ csp, ...policy })
  const configBody = JSON.stringify(config)
  const index = join(root, 'index.html')
  const handle = async (req, res) => {
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
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      // "/%" is not a path; it is not a reason to stop serving either.
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('bad request')
    }
    let file = resolve(root, '.' + normalize(pathname))
    // Never outside the build, whatever the path says.
    if (file !== root && !file.startsWith(root + sep)) file = index
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    } catch {
      file = index
    }
    let body
    try {
      body = await readFile(file)
    } catch {
      // A directory without a page, or a file gone between stat and read: the app's own page (SPA fallback).
      if (file === index) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('not found')
      }
      file = index
      body = await readFile(file)
    }
    if (file === index) {
      // The page gets a nonce of its own, in its CSP and in a <meta> the app hands to Emotion for its <style> tags.
      const nonce = randomBytes(16).toString('base64')
      res.setHeader('content-security-policy', cspWith(nonce))
      body = Buffer.from(body.toString('utf8').replace(/<head>/i, `<head><meta name="csp-nonce" content="${nonce}">`))
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream'
    // Hashed assets live under /static/ and never change; the page and anything else may change at each deploy.
    const cache = file.startsWith(join(root, 'static') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache'
    res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  return new Promise((done, fail) => {
    const server = createServer((req, res) => {
      // Whatever a request does, the process stays up: one answer in error, not a dead server.
      handle(req, res).catch(err => {
        console.error('request failed:', err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('server error')
      })
    })
    // Slow clients cannot hold connections forever.
    server.headersTimeout = 15_000
    server.requestTimeout = 30_000
    server.on('error', fail)
    server.listen(port, host, () => {
      const address = server.address()
      const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
      done({ origin: `http://${shown}:${address.port}`, csp, stop: () => new Promise(r => server.close(r)) })
    })
  })
}
