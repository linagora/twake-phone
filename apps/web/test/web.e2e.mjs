// End to end: a real browser signs in through an OpenID provider, the app shows who the Gateway says you are,
// and signing out brings the sign-in page back. No Docker: the provider, the Gateway and the app run in this process.
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { buildApp } from '../../gateway/dist/app.js'
import { JwtAuthenticator } from '../../gateway/dist/auth.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { startOidcMock } from './oidc-mock.mjs'
import { serveApp } from './static-server.mjs'

const APP_PORT = 4173
const OIDC_PORT = 4400
const GATEWAY_PORT = 4401
const AUDIENCE = 'twakephone-gateway'
const appOrigin = `http://127.0.0.1:${APP_PORT}`

const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), err => { console.log(`FAIL ${name}`); throw err })

process.env.LOG_LEVEL ??= 'warn'
process.env.CORS_ORIGINS = appOrigin
process.env.DEFAULT_TENANT = 'e2e'
process.env.DEV_USER_MAP = 'alice:101'

const oidc = await startOidcMock({ port: OIDC_PORT, appOrigin, audience: AUDIENCE })
const auth = new JwtAuthenticator({ jwksUrl: oidc.jwksUrl, issuer: oidc.issuer, audience: AUDIENCE, defaultTenant: 'e2e' })
const gateway = await buildApp(new ProviderRegistry([]), { auth })
await gateway.listen({ host: '127.0.0.1', port: GATEWAY_PORT })
const web = await serveApp({
  dir: fileURLToPath(new URL('../dist/', import.meta.url)),
  port: APP_PORT,
  config: { gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}`, oidc: { authority: oidc.issuer, clientId: 'twakephone-web', scope: 'openid profile email', resource: 'https://gateway.twakephone.test' } }
})

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) })
const page = await browser.newPage()
page.on('pageerror', err => console.log('page error:', err.message))
page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) console.log(`browser ${msg.type()}:`, msg.text()) })
page.on('requestfailed', req => { if (!/fonts\.g(static|oogleapis)\.com/.test(req.url())) console.log('request failed:', req.method(), req.url(), req.failure()?.errorText) })
let failed = false
try {
  await step('the app sends an anonymous visitor to sign in', async () => {
    await page.goto(`${web.origin}/recents`)
    await page.getByRole('button', { name: /se connecter|sign in/i }).click()
    await page.waitForURL(`${oidc.issuer}/interaction/**`)
  })
  await step('the identity provider authenticates alice and asks for consent', async () => {
    await page.locator('input[name=login]').fill('alice')
    await page.locator('input[name=password]').fill('whatever')
    await page.locator('button[type=submit]').click()
    await page.waitForURL(`${oidc.issuer}/interaction/**`)
    await page.locator('button[type=submit]').click()
    await page.waitForURL(`${appOrigin}/**`)
  })
  await step('the app lands on the page the visitor wanted, as Alice with extension 101', async () => {
    await page.waitForURL(`${appOrigin}/recents`)
    const who = page.getByTestId('who')
    await who.getByText('Alice Martin').waitFor()
    await who.getByText(/Poste 101|Extension 101/).waitFor()
    await page.getByRole('heading', { level: 1, name: /Récents|Recents/ }).waitFor()
  })
  await step('the session survives a reload', async () => {
    await page.reload()
    await page.getByTestId('who').getByText('Alice Martin').waitFor()
  })
  await step('the dialer explains that calling is not configured on this platform', async () => {
    await page.getByRole('link', { name: /Clavier|Dialer/ }).click()
    await page.getByText(/pas encore disponible|not available/).waitFor()
    await page.getByRole('button', { name: '5' }).click()
    await page.getByLabel(/Numéro à appeler|Number to call/).inputValue().then(v => { if (v !== '5') throw new Error(`keypad typed ${JSON.stringify(v)}`) })
  })
  await step('signing out returns to the sign-in page and forgets the session', async () => {
    await page.getByRole('button', { name: /se déconnecter|sign out/i }).click()
    await page.waitForURL(`${oidc.issuer}/session/end**`)
    await page.getByRole('button', { name: /yes, sign me out/i }).click()
    await page.waitForURL(`${appOrigin}/`)
    await page.getByRole('button', { name: /se connecter|sign in/i }).waitFor()
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('oidc.user')))
    if (stored.length) throw new Error(`session still stored: ${stored.join(', ')}`)
  })
} catch (err) {
  failed = true
  console.error(err)
  console.log('page url:', page.url())
  console.log('page text:', (await page.locator('body').innerText().catch(() => '')).slice(0, 800))
  await page.screenshot({ path: fileURLToPath(new URL('../dist/e2e-failure.png', import.meta.url)) }).catch(() => {})
} finally {
  await browser.close()
  await web.stop()
  await gateway.close()
  await oidc.stop()
}
process.exit(failed ? 1 : 0)
