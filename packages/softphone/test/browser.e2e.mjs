// Two real Chrome instances (fake microphone) talk through Gateway + Asterisk.
// Needs: dev PBX started with ASTERISK_EXTERNAL_ADDRESS=127.0.0.1, `yarn build`, harness bundled.
// Run: yarn e2e:browser
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { buildApp } from '../../../apps/gateway/dist/app.js'
import { ProviderRegistry } from '../../../apps/gateway/dist/registry.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const dist = new URL('../harness/dist/', import.meta.url)
const web = createServer(async (req, res) => {
  const file = req.url.startsWith('/main.js') ? 'main.js' : 'index.html'
  res.setHeader('content-type', file.endsWith('js') ? 'text/javascript' : 'text/html')
  res.end(await readFile(new URL(file, dist)))
}).listen(0)
const webPort = web.address().port

process.env.AUTH_MODE = 'dev'
process.env.DEV_USER_MAP = 'test1:104,test2:105'
process.env.CORS_ORIGINS = `http://127.0.0.1:${webPort}`
const registry = new ProviderRegistry([
  {
    tenantId: 'dev',
    type: 'asterisk',
    config: {
      ari: { url: 'http://127.0.0.1:8088', user: 'twake', password: 'twake-dev', app: `twake-browser-${process.pid}` },
      websocketUrl: 'wss://127.0.0.1:8089/ws', originateContext: 'twake-ring',
      sipSecretFor: async () => 'dev-sip-secret'
    }
  }
])
const gw = await buildApp(registry)
registry.startAll()
await gw.listen({ port: 0 })
const gwUrl = `http://127.0.0.1:${gw.server.address().port}`

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required']
})
const pages = {}
const sockets = {}
const open = async user => {
  const ctx = await browser.newContext({ permissions: ['microphone'], ignoreHTTPSErrors: true })
  const page = await ctx.newPage()
  page.on('console', m => process.env.DEBUG_PBX && console.log(`[${user}] console.${m.type()}`, m.text().slice(0, 300)))
  page.on('pageerror', e => console.error(`[${user}] pageerror`, e.message))
  pages[user] = page
  sockets[user] = []
  await page.routeWebSocket(/:8089\/ws/, ws => {
    const server = ws.connectToServer()
    sockets[user].push(ws)
    ws.onMessage(m => server.send(m))
    server.onMessage(m => ws.send(m))
    server.onClose(() => ws.close())
  })
  await page.goto(`http://127.0.0.1:${webPort}/?user=${user}&gw=${encodeURIComponent(gwUrl)}`)
  await page.evaluate(() => window.__phone.start())
  return page
}
const until = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(150)
  }
  assert.fail(`timeout: ${what}`)
}
const p = page => fn => page.evaluate(fn)

try {
  await sleep(1500)
  const [p1, p2] = [await open('test1'), await open('test2')]
  await until(async () => (await p1.evaluate(() => window.__phone.isRegistered())) && (await p2.evaluate(() => window.__phone.isRegistered())), 'both registered')
  console.log('both browsers registered over WSS')
  if (process.env.DEBUG_PBX) console.log((await import('node:child_process')).execSync("docker exec twake-dev-pbx asterisk -C /etc/asterisk/asterisk.conf -rx 'pjsip show contacts'").toString())

  const media = async (page, what) => {
    await until(async () => (await page.evaluate(() => window.__phone.stats())).packetsReceived > 20, `${what}: audio received`, 15000)
    const s = await page.evaluate(() => window.__phone.stats())
    console.log(`  ${what}: rx=${s.packetsReceived} tx=${s.packetsSent}`)
  }

  // The link to the PBX drops (network change, PBX restart): the softphone must come back by itself.
  sockets.test1.forEach(ws => ws.close())
  await until(async () => !(await p1.evaluate(() => window.__phone.isRegistered())), 'registration lost after the socket dropped')
  await until(() => p1.evaluate(() => window.__phone.isRegistered()), 'softphone re-registered by itself', 20000)
  console.log('reconnect after a dropped socket ok')

  // Scenario A: softphone-to-softphone, test1 dials 105 from the browser.
  await p1.evaluate(() => window.__phone.call('105'))
  await until(() => p2.evaluate(() => window.__phone.active().some(c => c.state === 'ringing')), 'test2 rings')
  await p2.evaluate(() => window.__phone.answer())
  await until(() => p1.evaluate(() => window.__phone.active().some(c => c.state === 'connected')), 'test1 connected')
  await media(p1, 'A test1')
  await media(p2, 'A test2')

  await p1.evaluate(() => window.__phone.hold())
  await until(() => p1.evaluate(() => window.__phone.active().some(c => c.state === 'held')), 'test1 held')
  await p1.evaluate(() => window.__phone.resume())
  await until(() => p1.evaluate(() => window.__phone.active().some(c => c.state === 'connected')), 'test1 resumed')
  console.log('A: call + audio + hold/resume ok')
  await p1.evaluate(() => window.__phone.hangup())
  await until(async () => (await p2.evaluate(() => window.__phone.active().length)) === 0, 'test2 call ended')

  // Scenario B: click-to-call through the Gateway (POST /calls), audio through the PBX bridge.
  await p1.evaluate(() => window.__phone.clickToCall('105'))
  await until(() => p2.evaluate(() => window.__phone.active().some(c => c.state === 'ringing')), 'test2 rings (click-to-call)')
  await p2.evaluate(() => window.__phone.answer())
  await media(p1, 'B test1')
  await media(p2, 'B test2')
  console.log('B: click-to-call via Gateway + audio ok')
  await p2.evaluate(() => window.__phone.hangup())
  // let the PBX finish tearing the call down so the next run starts clean
  await until(async () => (await p1.evaluate(() => window.__phone.active().length)) === 0, 'test1 call ended')
  console.log('BROWSER E2E OK')
} catch (error) {
  console.error('FAIL', error)
  for (const [u, pg] of Object.entries(pages)) console.error(`--- ${u} log\n` + (await pg.evaluate(() => document.getElementById('log').textContent).catch(() => '?')))
  process.exitCode = 1
} finally {
  await browser.close()
  await gw.close()
  web.close()
  process.exit(process.exitCode ?? 0)
}
