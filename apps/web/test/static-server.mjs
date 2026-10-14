// Serves the built app (SPA fallback) and a generated config.json: what a reverse proxy does in production.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' }

export const serveApp = ({ dir, port, config }) =>
  new Promise(resolve => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/config.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        return res.end(JSON.stringify(config))
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
      let file = join(dir, rel)
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
      } catch {
        file = join(dir, 'index.html')
      }
      try {
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    })
    server.listen(port, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${port}`, stop: () => new Promise(r => server.close(r)) }))
  })
