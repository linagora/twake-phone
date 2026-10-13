// Runs the built app in Chrome without a Twake stack: static files, a local Gateway,
// stubbed contacts. Takes screenshots to compare with the design.
// Needs the dev PBX (docker/) for real calls. Run: yarn build (repo root) && npx rsbuild build && node test/preview.mjs
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'

import { chromium } from '../../../node_modules/playwright-core/index.mjs'
import { buildApp } from '../../gateway/dist/app.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { MemoryStore } from '../../gateway/dist/store/memory.js'

const out = process.env.SHOTS ?? '/tmp/phone-shots'
mkdirSync(out, { recursive: true })
const build = new URL('../build/', import.meta.url).pathname
const types = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

const cozyData = port =>
  JSON.stringify({
    token: 'x',
    domain: `127.0.0.1:${port}`,
    locale: 'fr',
    app: { slug: 'phone' }
  })
const web = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  try {
    if (path === '/' || path === '/index.html') {
      const html = (await readFile(join(build, 'index.html'), 'utf8'))
        .replace(
          '{{.CozyData}}',
          cozyData(web.address().port).replaceAll('"', '&quot;')
        )
        .replace('{{.Locale}}', 'fr')
        .replace(/\{\{\.[A-Za-z]+\}\}/g, '')
      res.setHeader('content-type', 'text/html')
      return res.end(html)
    }
    res.setHeader(
      'content-type',
      types[extname(path)] ?? 'application/octet-stream'
    )
    res.end(await readFile(join(build, path)))
  } catch {
    res.statusCode = 404
    res.end('{}')
  }
}).listen(0)
const webOrigin = `http://127.0.0.1:${web.address().port}`

process.env.AUTH_MODE = 'dev'
process.env.DEV_USER_MAP = 'test1:104,test2:105'
process.env.CORS_ORIGINS = webOrigin
const registry = new ProviderRegistry([
  {
    tenantId: 'dev',
    type: 'asterisk',
    config: {
      ari: {
        url: 'http://127.0.0.1:8088',
        user: 'twake',
        password: 'twake-dev',
        app: `twake-preview-${process.pid}`
      },
      websocketUrl: 'wss://127.0.0.1:8089/ws',
      originateContext: 'twake-ring',
      sipSecretFor: async () => 'dev-sip-secret'
    }
  }
])
const store = new MemoryStore()
const ago = h => new Date(Date.now() - h * 3600_000).toISOString()
for (const [callId, direction, remoteNumber, hoursAgo, durationSec, missed] of [
  ['h1', 'inbound', '+33612489017', 1, 252, false],
  ['h2', 'inbound', '+33142000000', 2, 0, true],
  ['h3', 'outbound', '105', 3, 63, false],
  ['h4', 'inbound', '+33671842209', 30, 0, true],
  ['h5', 'outbound', '+33472000000', 70, 775, false]
]) {
  await store.addHistory({
    tenantId: 'dev',
    userId: 'test1',
    callId,
    direction,
    remoteNumber,
    startedAt: ago(hoursAgo),
    durationSec,
    state: missed ? 'missed' : 'ended',
    answered: !missed
  })
}
const gw = await buildApp(registry, { store })
registry.startAll()
await gw.listen({ port: 0 })
const gwUrl = `http://127.0.0.1:${gw.server.address().port}`

const CONTACTS = [
  {
    _id: 'c1',
    _type: 'io.cozy.contacts',
    displayName: 'Camille Martin',
    company: 'Acme Logistique',
    jobTitle: 'Responsable achats',
    phone: [{ number: '06 12 48 90 17', type: 'cell' }]
  },
  {
    _id: 'c2',
    _type: 'io.cozy.contacts',
    displayName: 'test2',
    phone: [{ number: '105', type: 'work' }]
  },
  {
    _id: 'c3',
    _type: 'io.cozy.contacts',
    displayName: 'test1',
    phone: [{ number: '104', type: 'work' }]
  }
]

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--ignore-certificate-errors',
    '--autoplay-policy=no-user-gesture-required'
  ]
})
const open = async (user, viewport) => {
  const ctx = await browser.newContext({
    viewport,
    permissions: ['microphone'],
    ignoreHTTPSErrors: true
  })
  const page = await ctx.newPage()
  await page.addInitScript(
    ([gw, u]) => {
      localStorage.setItem('flag__phone.gateway-url', JSON.stringify(gw))
      localStorage.setItem('twake-phone:dev-user', u)
    },
    [gwUrl, user]
  )
  await page.route(
    '**/data/io.cozy.contacts/_normal_docs*',
    r => (
      process.env.DEBUG_REQ && console.log('contacts stub hit'),
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ total_rows: CONTACTS.length, rows: CONTACTS })
      })
    )
  )
  page.on(
    'pageerror',
    e =>
      process.env.DEBUG_SIP &&
      console.log(
        `[${user}] PAGEERROR`,
        String(e && (e.stack || e.message || JSON.stringify(e))).slice(0, 400)
      )
  )
  page.on(
    'console',
    m =>
      process.env.DEBUG_SIP &&
      m.text().startsWith('PH:') &&
      console.log(`[${user}]`, m.text())
  )
  page.on(
    'requestfinished',
    r =>
      process.env.DEBUG_REQ &&
      /contacts|flags|settings/.test(r.url()) &&
      console.log(`[${user}] ${r.method()} ${r.url().slice(0, 110)}`)
  )
  page.on(
    'console',
    m =>
      process.env.DEBUG_SIP &&
      /INVITE|nvitation|reject|Decline|Busy|SIP\/2.0 [3-6]/.test(m.text()) &&
      console.log(
        `[${user}] sip`,
        m
          .text()
          .replace(/^.*\| sip\./, '')
          .slice(0, 160)
          .replace(/\n/g, ' ')
      )
  )
  page.on(
    'console',
    m =>
      process.env.DEBUG_REQ &&
      m.type() === 'error' &&
      console.log(`[${user}] console.error`, m.text().slice(0, 200))
  )
  await page.goto(`${webOrigin}/#/dialer`)
  return page
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` })
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  await sleep(1500)
  const d1 = await open('test1', { width: 1280, height: 800 })
  await sleep(2500)
  await d1.keyboard.type('06124')
  await shot(d1, 'desktop-keypad')
  await d1.keyboard.press('Backspace')
  await d1.keyboard.press('Backspace')
  await d1.keyboard.press('Backspace')
  await d1.keyboard.press('Backspace')
  await d1.keyboard.press('Backspace')

  const m1 = await open('test1', { width: 390, height: 844 })
  await sleep(2500)
  await m1.keyboard.type('0612489017')
  await shot(m1, 'mobile-keypad')
  await m1.goto(`${webOrigin}/#/recents`)
  await sleep(800)
  await shot(m1, 'mobile-recents')
  // one window per extension: a second registration would take the calls over
  await m1.context().close()

  // real call: desktop test1 -> mobile-sized test2
  const d2 = await open('test2', { width: 390, height: 844 })
  await sleep(2500)
  await d1.keyboard.type('105')
  await d1.getByRole('button', { name: 'Appeler', exact: true }).click()
  if (process.env.DEBUG_REQ)
    for (let i = 0; i < 8; i++) {
      await sleep(1000)
      console.log(
        i,
        'd1:',
        (await d1.evaluate(() => document.body.innerText))
          .replace(/\n+/g, ' | ')
          .slice(0, 130),
        '\n   d2:',
        (await d2.evaluate(() => document.body.innerText))
          .replace(/\n+/g, ' | ')
          .slice(0, 130)
      )
    }
  await sleep(2500)
  if (process.env.DEBUG_REQ) {
    console.log('notice d1:', await d1.locator('.ph-notice').allInnerTexts())
    console.log('notice d2:', await d2.locator('.ph-notice').allInnerTexts())
  }
  await shot(d2, 'mobile-incoming')
  await shot(d1, 'desktop-ringing')
  await d2.getByText('Répondre').click()
  await sleep(2500)
  await shot(d1, 'desktop-call')
  await shot(d2, 'mobile-call')
  await d1.getByText('Raccrocher').click()
  await sleep(1500)
  await shot(d1, 'desktop-after')
  console.log('shots in', out)
} catch (e) {
  console.error('FAIL', e)
  process.exitCode = 1
} finally {
  await browser.close()
  await gw.close()
  web.close()
  process.exit(process.exitCode ?? 0)
}
