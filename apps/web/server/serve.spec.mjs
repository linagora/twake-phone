import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveApp } from './serve.mjs'

describe('serveApp', () => {
  let web
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twakephone-web-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html><head><title>TwakePhone</title></head>')
    await mkdir(join(dir, 'static'))
    await writeFile(join(dir, 'static', 'app.abc123.js'), 'console.log(1)')
    await writeFile(join(dir, 'public.json'), '{"dev":true}')
    await writeFile(join(dir, 'sw.js'), 'self.addEventListener("push", () => {})')
    web = await serveApp({ dir, port: 0, config: { gatewayUrl: 'http://127.0.0.1:8080', oidc: { authority: 'http://127.0.0.1:9000', clientId: 'x' } }, policy: { frameAncestors: ['https://chat.example.org'] } })
  })
  afterAll(() => web.stop())
  const get = (path, init) => fetch(`${web.origin}${path}`, init)

  it('serves the page, the assets with their cache policy, and config.json from the configuration', async () => {
    const page = await get('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toContain('TwakePhone')
    const asset = await get('/static/app.abc123.js')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const config = await get('/config.json')
    expect(config.headers.get('cache-control')).toBe('no-store')
    expect((await config.json()).oidc.clientId).toBe('x')
    // The service worker at the root (its scope is the whole app), as a script, never kept stale by a cache.
    const sw = await get('/sw.js')
    expect(sw.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(sw.headers.get('cache-control')).toBe('no-cache')
    expect(sw.headers.get('content-security-policy')).toContain("worker-src 'self'")
    // The dev config of the build never leaks: /config.json is generated, whatever dist holds.
    expect((await (await get('/public.json')).json()).dev).toBe(true)
  })

  it('falls back to the page for app routes, directories and files that are not there', async () => {
    for (const path of ['/directory/jdupont', '/static/', '/static', '/nowhere.png', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/static/../../index.html']) {
      const res = await get(path)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain('TwakePhone')
    }
  })

  it('answers a malformed path with 400, a method it does not serve with 405, and stays up', async () => {
    expect((await get('/%')).status).toBe(400)
    expect((await get('/%E0%A4%A')).status).toBe(400)
    expect((await get('/', { method: 'POST', body: 'x' })).status).toBe(405)
    expect((await get('/')).status).toBe(200)
  })

  it('sends the security headers on every answer, HEAD included', async () => {
    for (const path of ['/', '/config.json', '/%', '/static/app.abc123.js']) {
      const res = await get(path)
      expect(res.headers.get('content-security-policy'), path).toContain('frame-ancestors https://chat.example.org')
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
      expect(res.headers.get('x-frame-options'), path).toBeNull()
    }
    const head = await get('/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(Buffer.byteLength('<!doctype html><head><title>TwakePhone</title></head>'))
    expect(await head.text()).toBe('')
  })

  it('gives each page a nonce of its own for the styles of the design system, in its CSP and its <meta>', async () => {
    const nonceOf = async () => {
      const res = await get('/directory/jdupont')
      const meta = /<meta name="csp-nonce" content="([^"]+)">/.exec(await res.text())?.[1]
      expect(res.headers.get('content-security-policy')).toContain(`'nonce-${meta}'`)
      return meta
    }
    expect(await nonceOf()).not.toBe(await nonceOf())
    expect((await get('/static/app.abc123.js')).headers.get('content-security-policy')).not.toContain("'nonce-")
  })
})
