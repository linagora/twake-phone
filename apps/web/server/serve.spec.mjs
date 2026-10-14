import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveApp } from './serve.mjs'

describe('serveApp', () => {
  let web
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twakephone-web-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>TwakePhone</title>')
    await mkdir(join(dir, 'static'))
    await writeFile(join(dir, 'static', 'app.abc123.js'), 'console.log(1)')
    await writeFile(join(dir, 'public.json'), '{"dev":true}')
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
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('<!doctype html><title>TwakePhone</title>')))
    expect(await head.text()).toBe('')
  })
})
