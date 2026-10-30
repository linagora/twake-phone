// End to end: TwakePhone in Twake Workplace (ADR 0032), without a Twake stack. A fake cozy-stack serves the built Cozy
// app (apps/workplace) and the few endpoints it calls (flags, intents); TwakePhone (apps/web) is served by its own
// production server, framed by it; the OpenID provider and the Gateway run in this process. Another app ("Drive") calls
// a number with the real @twake/phone-link and cozy-interapp.
// Run: yarn build (root), then in apps/workplace: yarn build && yarn e2e
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { buildApp } from '../../gateway/dist/app.js'
import { JwtAuthenticator } from '../../gateway/dist/auth.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { MemoryStore } from '../../gateway/dist/store/memory.js'
import { startOidcMock } from '../../web/test/oidc-mock.mjs'
import { serveApp } from '../../web/server/serve.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const buildDir = join(here, '../build')
// The bundle of the other app's page: under node_modules, out of the lint and of Git.
const HOST_BUNDLE = join(here, '../node_modules/.cache/twakephone-e2e-host.js')
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' }
const AUDIENCE = 'twakephone-gateway'

const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), err => { console.log(`FAIL ${name}`); throw err })
const expectEqual = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
/** Waits until `check` holds (read again every 100 ms), or fails naming `what`. */
const until = async (check, what, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return
  throw new Error(`${what}: not within ${ms} ms`)
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const readBody = req => new Promise(resolve => {
  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', () => resolve(body))
})
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/vnd.api+json' })
  res.end(JSON.stringify(body))
}

// Ports first: the provider needs the app's origin, the app the provider's and the Gateway's.
const free = async () => {
  const s = createServer()
  const origin = await listen(s)
  await new Promise(r => s.close(r))
  return Number(new URL(origin).port)
}
const [WEB_PORT, OIDC_PORT, GATEWAY_PORT] = [await free(), await free(), await free()]
const webOrigin = `http://127.0.0.1:${WEB_PORT}`
const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`

const intents = new Map()
let stackOrigin = ''
let hostOrigin = ''

// The stack of the instance: the Cozy app (its page and its /intents page, as the stack fills them), the flag that
// names TwakePhone, and the intents another app creates (CORS: that app is on another origin).
const stack = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  // The stack answers the apps of the instance with their credentials (cozy-client sends them).
  if (req.headers.origin) {
    res.setHeader('access-control-allow-origin', req.headers.origin)
    res.setHeader('access-control-allow-credentials', 'true')
  }
  res.setHeader('access-control-allow-headers', 'authorization, content-type, accept')
  if (req.method === 'OPTIONS') return res.end()
  if (path === '/settings/flags') return json(res, { data: { attributes: { 'phone.embedded-app-url': `${webOrigin}/` } } })
  if (path === '/intents' && req.method === 'POST') {
    const { action, type, data } = JSON.parse(await readBody(req)).data.attributes
    const id = randomUUID().replaceAll('-', '')
    const doc = { id, type: 'io.cozy.intents', attributes: { action, type, data, client: hostOrigin, services: [{ slug: 'phone', href: `${stackOrigin}/intents?intent=${id}` }] } }
    intents.set(id, doc)
    return json(res, { data: doc })
  }
  const intent = /^\/intents\/([0-9a-f]+)$/.exec(path)
  if (intent) return intents.has(intent[1]) ? json(res, { data: intents.get(intent[1]) }) : json(res, {}, 404)
  const file = path === '/' ? 'index.html' : path === '/intents' ? 'intents/index.html' : path.slice(1)
  try {
    let body = await readFile(join(buildDir, file))
    if (file.endsWith('.html')) {
      // The stack writes the instance's flags in the page, as it does for every app.
      const data = { token: 'phone-app-token', domain: new URL(stackOrigin).host, locale: 'fr', app: { slug: 'phone', name: 'Phone' }, flags: { 'phone.embedded-app-url': `${webOrigin}/` } }
      body = String(body)
        .replace('{{.CozyData}}', JSON.stringify(data).replaceAll('"', '&quot;'))
        .replace('{{.Locale}}', 'fr')
        .replace('{{.Domain}}', new URL(stackOrigin).host)
        .replace(/\{\{\.[A-Za-z]+\}\}/g, '')
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // What the Twake bar asks the stack (apps, settings, banners): nothing here, the bar shows without it.
    json(res, { errors: [{ status: '404' }] }, 404)
  }
})
stackOrigin = await listen(stack)

// Another app of the instance: a page that calls a number with phone-link.
await build({
  entryPoints: [join(here, 'host-entry.js')],
  bundle: true,
  format: 'iife',
  outfile: HOST_BUNDLE,
  nodePaths: [join(here, '../node_modules')],
  define: { 'process.env': '{"NODE_ENV":"production"}', global: 'window' },
  logLevel: 'error'
})
const host = createServer(async (req, res) => {
  if (req.url === '/host.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    return res.end(await readFile(HOST_BUNDLE))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><title>Drive</title><h1>Drive</h1><button id="call" data-number="06 12 34 56 07">06 12 34 56 07</button><script>window.STACK = ${JSON.stringify(stackOrigin)}</script><script src="/host.js"></script>`)
})
hostOrigin = await listen(host)

process.env.LOG_LEVEL ??= 'warn'
process.env.CORS_ORIGINS = webOrigin
const oidc = await startOidcMock({ port: OIDC_PORT, appOrigin: webOrigin, audience: AUDIENCE })
const auth = new JwtAuthenticator({ jwksUrl: oidc.jwksUrl, issuer: oidc.issuer, audience: AUDIENCE, defaultTenant: 'e2e' })
const gateway = await buildApp(new ProviderRegistry([], []), { auth, store: new MemoryStore() })
await gateway.listen({ host: '127.0.0.1', port: GATEWAY_PORT })
// TwakePhone lets the Workplace app frame it, and nobody else.
const web = await serveApp({
  dir: join(here, '../../web/dist'),
  port: WEB_PORT,
  config: { gatewayUrl, oidc: { authority: oidc.issuer, clientId: 'twakephone-web', resource: 'https://gateway.twakephone.test' } },
  policy: { frameAncestors: [stackOrigin] }
})

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) })
const context = await browser.newContext({ locale: 'fr-FR' })
await context.route(/fonts\.g(static|oogleapis)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
const workplace = await context.newPage()
workplace.on('pageerror', err => console.log('page error:', err.message))
const phoneFrame = () => workplace.frameLocator('#embeddedApp')
let failed = false
try {
  await step('Twake Workplace shows TwakePhone in the frame of its Phone app, under the Twake bar', async () => {
    await workplace.goto(`${stackOrigin}/`)
    await workplace.waitForFunction(origin => document.getElementById('embeddedApp')?.src.startsWith(origin), webOrigin)
    expectEqual(await workplace.locator('#embeddedApp').getAttribute('allow'), 'microphone; autoplay; clipboard-write', 'what the frame may use')
    await phoneFrame().getByRole('button', { name: 'Se connecter' }).waitFor()
  })
  await step('framed, TwakePhone signs in in a popup (the identity provider is not framed), and the frame is signed in', async () => {
    const popupComing = workplace.waitForEvent('popup')
    await phoneFrame().getByRole('button', { name: 'Se connecter' }).click()
    const popup = await popupComing
    await popup.waitForURL(`${oidc.issuer}/**`)
    await popup.locator('input[name=login]').fill('amartin')
    await popup.locator('input[name=password]').fill('whatever')
    await popup.getByRole('button', { name: 'Sign-in' }).click()
    await popup.getByRole('button', { name: 'Continue' }).click()
    await popup.waitForEvent('close')
    await phoneFrame().getByTestId('who').getByText('Alice Martin').waitFor()
  })
  await step('a Workplace link to a number opens the dialer of the frame on it (ADR 0031: filled, not dialled)', async () => {
    // Opened as a link opens it: a new page load (a change of the hash alone would not reload the app).
    await workplace.goto('about:blank')
    await workplace.goto(`${stackOrigin}/#/bridge/?dial=${encodeURIComponent('06 12 34 56 02')}`)
    await workplace.waitForFunction(origin => document.getElementById('embeddedApp')?.src.startsWith(`${origin}/?dial=`), webOrigin)
    await phoneFrame().getByTestId('who').getByText('Alice Martin').waitFor()
    expectEqual(await phoneFrame().getByLabel('Numéro à appeler').inputValue(), '+33612345602', 'number in the framed dialer')
  })
  const drive = await context.newPage()
  drive.on('pageerror', err => console.log('drive page error:', err.message))
  drive.on('console', m => process.env.DEBUG_E2E && console.log('drive console:', m.type(), m.text()))
  drive.on('request', r => process.env.DEBUG_E2E && console.log('drive request:', r.method(), r.url()))
  await drive.goto(`${hostOrigin}/`)
  await drive.waitForFunction(() => typeof window.callFromHost === 'function')
  await step('another app calls a number: the CALL intent hands it to the Twake Phone window on screen, without a new tab, and nothing is dialled', async () => {
    const calls = []
    const onRequest = req => (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/calls') ? calls.push(req.url()) : undefined)
    workplace.on('request', onRequest)
    const result = await drive.evaluate(() => window.callFromHost('06 12 34 56 09'))
    expectEqual(result.handled, true, 'handled')
    expectEqual(result.via, 'phone', 'handled by')
    expectEqual(result.opened.length, 0, 'tabs opened')
    await until(async () => (await phoneFrame().getByLabel('Numéro à appeler').inputValue()) === '+33612345609', 'number in the framed dialer')
    workplace.off('request', onRequest)
    expectEqual(calls.length, 0, 'calls placed')
  })
  await step('a Twake Phone window whose frame is not signed in does not swallow the number: the app is opened on it', async () => {
    await workplace.close()
    // A new tab of the Workplace app: its frame's session is the tab's (sessionStorage), so it is not signed in.
    const fresh = await context.newPage()
    await fresh.goto(`${stackOrigin}/`)
    await fresh.frameLocator('#embeddedApp').getByRole('button', { name: 'Se connecter' }).waitFor()
    const result = await drive.evaluate(() => window.callFromHost('06 12 34 56 08'))
    expectEqual(result.via, 'app', 'handled by')
    expectEqual(result.opened.length, 1, 'tabs opened')
    if (!result.opened[0].endsWith(`#/bridge/?dial=${encodeURIComponent('+33612345608')}`)) throw new Error(`opened ${result.opened[0]}`)
    await fresh.close()
  })
  await step('with no Twake Phone window, a click in the other app opens Twake Phone in a new tab on the number', async () => {
    const tabComing = context.waitForEvent('page')
    await drive.getByRole('button', { name: '06 12 34 56 07' }).click()
    const tab = await tabComing.catch(async err => {
      throw new Error(`no tab (${err.message}); the click gave ${JSON.stringify(await drive.evaluate(() => window.lastResult))}`)
    })
    // The instance's Phone app (<instance>-phone.<domain>; on an IP, the stack's own origin, as here).
    await tab.waitForURL(url => url.hash.startsWith('#/bridge/?dial='))
    if (!tab.url().endsWith(`#/bridge/?dial=${encodeURIComponent('+33612345607')}`)) throw new Error(`opened ${tab.url()}`)
    expectEqual(JSON.stringify(await drive.evaluate(() => window.lastResult)), JSON.stringify({ handled: true, via: 'app' }), 'result')
    expectEqual(await tab.evaluate(() => window.opener), null, 'the tab is cut from the page that opened it')
    await tab.close()
  })
  await step('text that is not a number is never handed to anyone', async () => {
    const result = await drive.evaluate(() => window.callFromHost('appelle-moi'))
    expectEqual(result.handled, false, 'handled')
    expectEqual(result.reason, 'invalid-number', 'reason')
    expectEqual(result.opened.length, 0, 'tabs opened')
  })
} catch (err) {
  failed = true
  console.error(err)
  if (!workplace.isClosed()) await workplace.screenshot({ path: join(here, '../e2e-failure.png') }).catch(() => {})
} finally {
  await browser.close()
  await web.stop()
  await gateway.close()
  await oidc.stop()
  stack.close()
  host.close()
}
process.exit(failed ? 1 : 0)
