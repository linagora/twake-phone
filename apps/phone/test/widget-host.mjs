// Reproduces "a call arrives while the user is in another app" without a Twake stack: a host page mounts the
// real widget library; the real cozy-interapp creates the intent and the iframe; the Phone build runs as the
// intent service. Only the stack's intent storage and flags endpoint are faked. Calls go through the real PBX.
// Run: yarn build (root) && npx rsbuild build && node test/widget-host.mjs
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'

import { build } from '../../../node_modules/esbuild/lib/main.js'
import { chromium } from '../../../node_modules/playwright-core/index.mjs'
import { buildApp } from '../../gateway/dist/app.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'

const dir = new URL('.', import.meta.url).pathname
const buildDir = join(dir, '../build/')
const out = process.env.SHOTS ?? '/tmp/phone-shots'
const types = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await build({
  entryPoints: [join(dir, 'widget-host-entry.js')],
  bundle: true,
  format: 'iife',
  outfile: '/tmp/widget-host.js',
  nodePaths: [join(dir, '../node_modules')],
  define: { 'process.env': '{"NODE_ENV":"production"}', global: 'window' },
  logLevel: 'error'
})

const intents = new Map()
let phoneOrigin = ''
let hostOrigin = ''
let gwUrl = ''
const CONTACTS = [
  {
    _id: 'c1',
    _type: 'io.cozy.contacts',
    displayName: 'Camille Martin',
    company: 'Acme',
    phone: [{ number: '105', type: 'work' }]
  }
]

const json = (res, body, status = 200) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/vnd.api+json')
  res.end(JSON.stringify(body))
}
const readBody = req =>
  new Promise(r => {
    let b = ''
    req.on('data', c => (b += c))
    req.on('end', () => r(b))
  })

// "Drive": the host page and its stack's POST /intents.
const host = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/') {
    res.setHeader('content-type', 'text/html')
    return res.end(
      '<!doctype html><title>Host app</title><h1>Pretend this is Drive</h1><script src="/host.js"></script>'
    )
  }
  if (path === '/host.js') {
    res.setHeader('content-type', 'text/javascript')
    return res.end(await readFile('/tmp/widget-host.js'))
  }
  if (path === '/intents' && req.method === 'POST') {
    const attrs = JSON.parse(await readBody(req)).data.attributes
    const id = randomUUID().replaceAll('-', '')
    const doc = {
      id,
      type: 'io.cozy.intents',
      attributes: {
        action: attrs.action,
        type: attrs.type,
        data: attrs.data,
        client: hostOrigin,
        services: [
          { slug: 'phone', href: `${phoneOrigin}/intents?intent=${id}` }
        ]
      }
    }
    intents.set(id, doc)
    return json(res, { data: doc })
  }
  res.statusCode = 404
  res.end('{}')
}).listen(0)

// "Phone" origin: the built app, its /intents service page, and the stack endpoints it calls.
const phone = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  res.setHeader('access-control-allow-origin', '*')
  const m = /^\/intents\/([0-9a-f]+)$/.exec(path)
  if (m)
    return intents.has(m[1])
      ? json(res, { data: intents.get(m[1]) })
      : json(res, {}, 404)
  // The Gateway URL is a Cozy flag (served here); who the user is comes from the context (dev token).
  if (path === '/settings/flags')
    return json(res, { data: { attributes: { 'phone.gateway-url': gwUrl } } })
  if (path === '/data/io.cozy.contacts/_normal_docs')
    return json(res, { total_rows: 1, rows: CONTACTS, next: false })
  try {
    const file =
      path === '/intents'
        ? 'intents/index.html'
        : path === '/'
          ? 'index.html'
          : path.slice(1)
    let body = await readFile(join(buildDir, file))
    if (file.endsWith('.html')) {
      body = String(body)
        .replace(
          '{{.CozyData}}',
          JSON.stringify({
            token: file.startsWith('intents') ? 'widget' : 'x',
            domain: `127.0.0.1:${phone.address().port}`,
            locale: 'fr',
            app: { slug: 'phone', name: 'Phone' }
          }).replaceAll('"', '&quot;')
        )
        .replace('{{.Locale}}', 'fr')
        .replace(/\{\{\.[A-Za-z]+\}\}/g, '')
    }
    res.setHeader(
      'content-type',
      types[extname(file)] ?? 'application/octet-stream'
    )
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('{}')
  }
}).listen(0)
hostOrigin = `http://127.0.0.1:${host.address().port}`
phoneOrigin = `http://127.0.0.1:${phone.address().port}`

process.env.AUTH_MODE = 'dev'
process.env.DEV_USER_MAP = 'test1:104,test2:105'
process.env.CORS_ORIGINS = phoneOrigin
const registry = new ProviderRegistry([
  {
    tenantId: 'dev',
    type: 'asterisk',
    config: {
      ari: {
        url: 'http://127.0.0.1:8088',
        user: 'twake',
        password: 'twake-dev',
        app: `twake-widget-${process.pid}`
      },
      websocketUrl: 'wss://127.0.0.1:8089/ws',
      originateContext: 'twake-ring',
      sipSecretFor: async () => 'dev-sip-secret'
    }
  }
])
const gw = await buildApp(registry)
registry.startAll()
await gw.listen({ port: 0 })
gwUrl = `http://127.0.0.1:${gw.server.address().port}`

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--ignore-certificate-errors',
    '--autoplay-policy=no-user-gesture-required'
  ]
})
let failed = false
try {
  await sleep(1500)
  // test1 is "in another app": only the host page, carrying the widget.
  const ctx1 = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true
  })
  // An embedded page uses the microphone permission of the page that embeds it (the host app), not its own.
  await ctx1.grantPermissions(['microphone'], { origin: hostOrigin })
  const hostPage = await ctx1.newPage()
  const log = []
  hostPage.on(
    'console',
    m =>
      (m.type() === 'error' || m.type() === 'warning') &&
      console.log(`[host ${m.type()}]`, m.text().slice(0, 220))
  )
  hostPage.on('pageerror', e =>
    console.log('[host pageerror]', String(e).slice(0, 300))
  )
  await hostPage.addInitScript(o => {
    window.__phoneOrigin = o
  }, phoneOrigin)
  // The widget iframe belongs to test1: its Phone-origin frames get the dev user from the context.
  await ctx1.addInitScript(o => {
    if (location.origin === o)
      localStorage.setItem('twake-phone:dev-user', 'test1')
  }, phoneOrigin)
  await hostPage.goto(hostOrigin)
  await sleep(3500)

  const iframe = await hostPage.locator('#twake-phone-widget iframe').count()
  console.log(
    'widget iframe present:',
    iframe === 1,
    '| allow =',
    await hostPage
      .locator('#twake-phone-widget iframe')
      .getAttribute('allow')
      .catch(() => null)
  )
  const size0 = await hostPage
    .locator('#twake-phone-widget')
    .evaluate(e => ({ w: e.offsetWidth, h: e.offsetHeight }))
  console.log('container size while idle:', JSON.stringify(size0))

  // test2 calls test1 from the Phone app (a normal Phone window).
  const ctx2 = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true
  })
  await ctx2.grantPermissions(['microphone'], { origin: phoneOrigin })
  const phonePage = await ctx2.newPage()
  phonePage.on(
    'console',
    m =>
      m.type() === 'error' &&
      console.log('[caller console.error]', m.text().slice(0, 160))
  )
  phonePage.on('requestfailed', r =>
    console.log('[caller requestfailed]', r.url().slice(0, 120))
  )
  phonePage.on(
    'response',
    r =>
      r.status() >= 400 &&
      console.log('[caller http', r.status() + ']', r.url().slice(0, 120))
  )
  phonePage.on('pageerror', e =>
    console.log('[caller pageerror]', String(e).slice(0, 200))
  )
  await phonePage.addInitScript(
    ([g, u]) => {
      localStorage.setItem('flag__phone.gateway-url', JSON.stringify(g))
      localStorage.setItem('twake-phone:dev-user', u)
    },
    [gwUrl, 'test2']
  )
  await phonePage.route('**/data/io.cozy.contacts/_normal_docs*', r =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ total_rows: 0, rows: [], next: false })
    })
  )
  await phonePage.goto(`${phoneOrigin}/#/dialer`)
  await sleep(3000)
  await phonePage.keyboard.type('104')
  console.log(
    'caller page text:',
    (await phonePage.evaluate(() => document.body.innerText))
      .replace(/\n+/g, ' | ')
      .slice(0, 200)
  )
  await phonePage.getByRole('button', { name: 'Appeler', exact: true }).click()

  const card = hostPage
    .frameLocator('#twake-phone-widget iframe')
    .getByRole('alertdialog')
  await card.waitFor({ timeout: 15000 })
  const size1 = await hostPage
    .locator('#twake-phone-widget')
    .evaluate(e => ({ w: e.offsetWidth, h: e.offsetHeight }))
  console.log(
    'incoming card shown in the host app; container size:',
    JSON.stringify(size1)
  )
  const frame = hostPage.frames().find(f => f.url().includes('/intents'))
  console.log(
    'in-iframe:',
    JSON.stringify(
      await frame.evaluate(() => {
        const r = document.querySelector('.ph-w-root')
        const c = document.querySelector('.ph-w-card')
        return {
          root: r && r.getBoundingClientRect().toJSON(),
          card: c && c.getBoundingClientRect().toJSON(),
          vw: innerWidth,
          vh: innerHeight,
          bodyH: document.body.getBoundingClientRect().height,
          rootCss: r && getComputedStyle(r).display
        }
      })
    )
  )
  await hostPage.screenshot({ path: `${out}/widget-incoming.png` })

  await hostPage
    .frameLocator('#twake-phone-widget iframe')
    .getByLabel('Répondre')
    .click({ force: true })
  await hostPage
    .frameLocator('#twake-phone-widget iframe')
    .getByTestId('widget-call')
    .waitFor({ timeout: 15000 })
  await sleep(2500)
  await hostPage.screenshot({ path: `${out}/widget-call.png` })
  await phonePage.screenshot({ path: `${out}/widget-caller.png` })
  console.log('call answered from the widget')
  await hostPage
    .frameLocator('#twake-phone-widget iframe')
    .getByLabel('Raccrocher')
    .click()
  await sleep(1500)
  console.log('widget call ended')

  // --- PhoneLink 1: the page has the widget: talk to it directly, never a second intent (it would kill the widget) ---
  const answerCallee = async () =>
    phonePage
      .getByRole('button', { name: 'Répondre' })
      .click({ force: true, timeout: 20000 })
  const hangupCaller = async page => {
    await page.getByText('Raccrocher').first().click({ force: true })
    await sleep(1500)
  }
  const direct = await hostPage.evaluate(() => window.__call('105'))
  console.log(
    'PhoneLink in a page that has the widget ->',
    JSON.stringify(direct)
  )
  if (!(direct.handled && direct.via === 'widget'))
    throw new Error('expected the widget of this page to place the call')
  if (await hostPage.evaluate(() => window.__opened))
    throw new Error('the Phone app must not have been opened')
  if (process.env.DEBUG_REQ) {
    await sleep(4000)
    console.log(
      'widget:',
      JSON.stringify(
        await hostPage
          .frames()
          .find(f => f.url().includes('/intents'))
          .evaluate(() => document.body.innerText)
      )
    )
    console.log(
      'callee:',
      JSON.stringify(
        (await phonePage.evaluate(() => document.body.innerText))
          .replace(/\n+/g, ' | ')
          .slice(0, 200)
      )
    )
  }
  await answerCallee()
  await hostPage
    .frameLocator('#twake-phone-widget iframe')
    .getByTestId('widget-call')
    .waitFor({ timeout: 15000 })
  console.log(
    'click-to-call from the host app: connected, shown in the widget, and the widget survived'
  )
  await sleep(1500)
  await hostPage
    .frameLocator('#twake-phone-widget iframe')
    .getByLabel('Raccrocher')
    .click()
  await sleep(1500)

  // A text that merely looks like a number is refused, nothing is dialled.
  const refused = await hostPage.evaluate(() => window.__call('ref-4821'))
  console.log('PhoneLink on a business reference ->', JSON.stringify(refused))
  if (refused.handled) throw new Error('a reference must never be dialled')

  // --- PhoneLink 2: no widget in the page, but the Phone app is open in the same browser: CALL intent, relayed to it ---
  const ctx3 = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true
  })
  await ctx3.grantPermissions(['microphone'], { origin: hostOrigin })
  await ctx3.grantPermissions(['microphone'], { origin: phoneOrigin })
  const openPhoneApp = async (ctx, url) => {
    const page = await ctx.newPage()
    page.on(
      'console',
      m => m.text().startsWith('PHDBG') && console.log('[app window]', m.text())
    )
    await page.addInitScript(
      ([g, u]) => {
        localStorage.setItem('flag__phone.gateway-url', JSON.stringify(g))
        localStorage.setItem('twake-phone:dev-user', u)
      },
      [gwUrl, 'test1']
    )
    await page.route('**/data/io.cozy.contacts/_normal_docs*', r =>
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ total_rows: 0, rows: [], next: false })
      })
    )
    await page.goto(url)
    return page
  }
  const appWindow = await openPhoneApp(ctx3, `${phoneOrigin}/#/dialer`)
  await sleep(3000)
  const noWidget = await ctx3.newPage()
  noWidget.on(
    'console',
    m =>
      m.text().startsWith('PHDBG') && console.log('[no-widget page]', m.text())
  )
  await noWidget.addInitScript(o => {
    window.__phoneOrigin = o
  }, phoneOrigin)
  await noWidget.goto(`${hostOrigin}/?nowidget=1`)
  const relayed = await noWidget.evaluate(() => window.__call('105'))
  console.log(
    'PhoneLink in a page without the widget, Phone app open elsewhere ->',
    JSON.stringify(relayed)
  )
  if (!(relayed.handled && relayed.via === 'phone'))
    throw new Error(
      'expected the open Phone window to place the call through the CALL intent'
    )
  if (process.env.DEBUG_REQ) {
    await sleep(5000)
    console.log(
      'app window:',
      JSON.stringify(
        (await appWindow.evaluate(() => document.body.innerText))
          .replace(/\n+/g, ' | ')
          .slice(0, 160)
      )
    )
    console.log(
      'callee:',
      JSON.stringify(
        (await phonePage.evaluate(() => document.body.innerText))
          .replace(/\n+/g, ' | ')
          .slice(0, 160)
      )
    )
  }
  await answerCallee()
  await appWindow.getByText('Raccrocher').first().waitFor({ timeout: 15000 })
  console.log('the open Phone app placed the call and shows it')
  await hangupCaller(appWindow)

  // --- PhoneLink 3: no Phone window at all: the app is opened on the dialer and dials by itself ---
  const ctx4 = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true
  })
  await ctx4.grantPermissions(['microphone'], { origin: phoneOrigin })
  const lonely = await ctx4.newPage()
  await lonely.addInitScript(o => {
    window.__phoneOrigin = o
  }, phoneOrigin)
  await lonely.goto(`${hostOrigin}/?nowidget=1`)
  const fallback = await lonely.evaluate(() => window.__call('105'))
  const opened = await lonely.evaluate(() => window.__opened)
  console.log(
    'PhoneLink with no Phone window ->',
    JSON.stringify(fallback),
    '| opens',
    opened
  )
  if (!(fallback.via === 'app' && opened.includes('/dialer?dial=105')))
    throw new Error('expected the Phone app to be opened on the dialer')
  await openPhoneApp(ctx4, opened.replace(/^https?:\/\/[^/]+/, phoneOrigin))
  await phonePage
    .getByRole('button', { name: 'Répondre' })
    .waitFor({ timeout: 20000 })
  console.log('the opened Phone app dialled by itself: the callee rings')
  console.log('WIDGET E2E OK')
  if (process.env.DEBUG_REQ) log.forEach(l => console.log(l))
} catch (e) {
  failed = true
  console.error('FAIL', String(e).slice(0, 400))
} finally {
  await browser.close()
  await gw.close()
  host.close()
  phone.close()
  process.exit(failed ? 1 : 0)
}
