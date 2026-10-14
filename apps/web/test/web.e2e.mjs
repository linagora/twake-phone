// End to end: a real browser signs in through an OpenID provider, the app shows who the Gateway says you are,
// and signing out brings the sign-in page back. No Docker: the provider, the Gateway and the app run in this process.
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { buildApp } from '../../gateway/dist/app.js'
import { JwtAuthenticator } from '../../gateway/dist/auth.js'
import { DEFAULT_ATTRIBUTES, LdapDirectory } from '../../gateway/dist/ldap-directory.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { BASE_DN, READER_DN, READER_PASSWORD, startLdapMock } from '../../gateway/test/ldap-mock.mjs'
import { startOidcMock } from './oidc-mock.mjs'
import { serveApp } from './static-server.mjs'

const AUDIENCE = 'twakephone-gateway'
const RESOURCE = 'https://gateway.twakephone.test'

/** A free TCP port: the provider needs its issuer URL before it listens, so ports are picked up front. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), err => { console.log(`FAIL ${name}`); throw err })
const expectEqual = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const [APP_PORT, OIDC_PORT, GATEWAY_PORT] = await Promise.all([freePort(), freePort(), freePort()])
const appOrigin = `http://127.0.0.1:${APP_PORT}`

process.env.LOG_LEVEL ??= 'warn'
process.env.CORS_ORIGINS = appOrigin
process.env.DEFAULT_TENANT = 'e2e'
process.env.DEV_USER_MAP = 'alice:101'

const oidc = await startOidcMock({ port: OIDC_PORT, appOrigin, audience: AUDIENCE, resource: RESOURCE })
const ldap = await startLdapMock()
const auth = new JwtAuthenticator({ jwksUrl: oidc.jwksUrl, issuer: oidc.issuer, audience: AUDIENCE, defaultTenant: 'e2e' })
const contacts = new LdapDirectory({ url: ldap.url, tenantId: 'e2e', bindDn: READER_DN, bindPassword: READER_PASSWORD, baseDn: BASE_DN, userFilter: '(objectClass=inetOrgPerson)', attributes: DEFAULT_ATTRIBUTES })
const gateway = await buildApp(new ProviderRegistry([]), { auth, contacts })
await gateway.listen({ host: '127.0.0.1', port: GATEWAY_PORT })
const web = await serveApp({
  dir: fileURLToPath(new URL('../dist/', import.meta.url)),
  port: APP_PORT,
  // No scope here: the app's default (with offline_access, hence a refresh token) is what gets tested.
  config: { gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}`, oidc: { authority: oidc.issuer, clientId: 'twakephone-web', resource: RESOURCE } }
})

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) })
// A French browser: the UI must come up in French, and the language switch is exercised below.
const page = await browser.newPage({ locale: 'fr-FR' })
// The provider's dev pages import a Google font: not on the runner's network, and never a reason to slow the test.
await page.route(/fonts\.g(static|oogleapis)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
const cspViolations = []
page.on('pageerror', err => console.log('page error:', err.message))
page.on('console', msg => {
  if (!['error', 'warning'].includes(msg.type())) return
  if (/Content Security Policy/.test(msg.text())) cspViolations.push(msg.text())
  console.log(`browser ${msg.type()}:`, msg.text())
})
page.on('requestfailed', req => { if (!/fonts\.g(static|oogleapis)\.com/.test(req.url())) console.log('request failed:', req.method(), req.url(), req.failure()?.errorText) })
let failed = false
try {
  await step('the app comes up in French and sends an anonymous visitor to sign in', async () => {
    await page.goto(`${web.origin}/recents`)
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await page.getByRole('button', { name: 'Sign-in' }).waitFor()
    expectEqual(new URL(page.url()).origin, oidc.issuer, 'sign-in page origin')
  })
  await step('the identity provider authenticates alice and asks for consent', async () => {
    await page.locator('input[name=login]').fill('alice')
    await page.locator('input[name=password]').fill('whatever')
    await page.getByRole('button', { name: 'Sign-in' }).click()
    // The consent page is the one with a Continue button: waiting on the URL would match the login page too.
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL(`${appOrigin}/**`)
  })
  await step('the app lands on the page the visitor wanted, as Alice with extension 101', async () => {
    await page.waitForURL(`${appOrigin}/recents`)
    const who = page.getByTestId('who')
    await who.getByText('Alice Martin').waitFor()
    await who.getByText('Poste 101').waitFor()
    await page.getByRole('heading', { level: 1, name: 'Récents' }).waitFor()
    expectEqual(await page.title(), 'Récents – TwakePhone', 'document title')
    expectEqual(await page.evaluate(() => document.documentElement.lang), 'fr', 'html lang')
  })
  await step('the provider issued a JWT access token for the Gateway and a refresh token for silent renewal', async () => {
    const user = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(k => k.startsWith('oidc.user'))
      return key ? JSON.parse(sessionStorage.getItem(key)) : null
    })
    if (!user) throw new Error('no oidc.user entry in sessionStorage')
    expectEqual(user.access_token.split('.').length, 3, 'access token segments')
    const payload = JSON.parse(Buffer.from(user.access_token.split('.')[1], 'base64url').toString())
    expectEqual(payload.aud, AUDIENCE, 'access token audience')
    if (typeof user.refresh_token !== 'string' || !user.refresh_token) throw new Error('no refresh token: offline_access was not granted')
  })
  await step('the session survives a reload', async () => {
    await page.reload()
    await page.getByTestId('who').getByText('Alice Martin').waitFor()
  })
  await step('the dialer explains that calling is not configured on this platform', async () => {
    await page.getByRole('link', { name: 'Clavier' }).click()
    await page.getByText(/pas encore disponible/).waitFor()
    await page.getByRole('button', { name: '5' }).click()
    expectEqual(await page.getByLabel('Numéro à appeler').inputValue(), '5', 'keypad input')
  })
  await step('the directory finds Jean Dupont by "dup", with his number and department', async () => {
    await page.getByRole('link', { name: 'Annuaire' }).click()
    await page.getByText('Aucun favori pour l\'instant').waitFor()
    await page.getByLabel('Rechercher').fill('dup')
    const list = page.locator('ul.contacts')
    await list.getByRole('link', { name: 'Jean Dupont', exact: true }).waitFor()
    await list.getByText(/Support · .*23.45.67.01/).waitFor()
    expectEqual(await list.getByRole('listitem').count(), 1, 'number of results')
    await page.getByLabel('Rechercher').fill('support')
    await list.getByRole('link', { name: 'Bob Durand', exact: true }).waitFor()
    expectEqual(await list.getByRole('listitem').count(), 3, 'number of results for "support"')
    await page.getByLabel('Rechercher').fill('zoe')
    await list.getByRole('link', { name: 'Zoé Lefèvre', exact: true }).waitFor()
    await page.getByLabel('Rechercher').fill('01 23 45 67 01')
    await list.getByRole('link', { name: 'Jean Dupont', exact: true }).waitFor()
    expectEqual(await list.getByRole('listitem').count(), 1, 'number of results by number')
  })
  await step('a favourite survives a reload, because the Gateway keeps it', async () => {
    await page.getByLabel('Rechercher').fill('dup')
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/me/favorites/jdupont'))
    const star = page.getByRole('button', { name: 'Favori : Jean Dupont' })
    expectEqual(await star.getAttribute('aria-pressed'), 'false', 'aria-pressed before')
    await star.click()
    expectEqual((await saved).status(), 204, 'favourite saved by the Gateway')
    await page.locator('button[aria-label="Favori : Jean Dupont"][aria-pressed="true"]:not([disabled])').waitFor()
    await page.reload()
    await page.getByRole('heading', { level: 2, name: 'Favoris' }).waitFor()
    await page.getByRole('link', { name: 'Jean Dupont', exact: true }).waitFor()
    expectEqual(await page.getByRole('button', { name: 'Favori : Jean Dupont' }).getAttribute('aria-pressed'), 'true', 'aria-pressed after reload')
  })
  await step('the contact card lists every number, and Call sends it to the dialer', async () => {
    await page.getByRole('link', { name: 'Jean Dupont', exact: true }).click()
    await page.getByRole('heading', { level: 1, name: 'Jean Dupont' }).waitFor()
    expectEqual(await page.title(), 'Jean Dupont – TwakePhone', 'document title')
    await page.getByText('Technicien · Support').waitFor()
    await page.getByText('Mobile').waitFor()
    await page.getByRole('link', { name: /Appeler le .*6.12.34.56.01/ }).click()
    await page.getByRole('heading', { level: 1, name: 'Clavier' }).waitFor()
    const typed = await page.getByLabel('Numéro à appeler').inputValue()
    expectEqual(typed.replace(/\s/g, ''), '+33612345601', 'number sent to the dialer')
    expectEqual(new URL(page.url()).search, '', 'address bar cleaned')
  })
  await step('removing the favourite empties the list', async () => {
    await page.getByRole('link', { name: 'Annuaire' }).click()
    const removed = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith('/me/favorites/jdupont'))
    await page.getByRole('button', { name: 'Favori : Jean Dupont' }).click()
    expectEqual((await removed).status(), 204, 'favourite removed by the Gateway')
    await page.getByText('Aucun favori pour l\'instant').waitFor()
  })
  await step('switching the language to English changes the UI, the title and the document language', async () => {
    await page.getByRole('link', { name: 'Réglages' }).click()
    await page.getByLabel("Langue de l'interface").selectOption('en')
    await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor()
    expectEqual(await page.title(), 'Settings – TwakePhone', 'document title')
    expectEqual(await page.evaluate(() => document.documentElement.lang), 'en', 'html lang')
  })
  await step('signing out returns to the sign-in page and forgets the session', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL(`${oidc.issuer}/session/end**`)
    await page.getByRole('button', { name: /yes, sign me out/i }).click()
    await page.waitForURL(`${appOrigin}/`)
    await page.getByRole('button', { name: 'Sign in' }).waitFor()
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('oidc.user')))
    if (stored.length) throw new Error(`session still stored: ${stored.join(', ')}`)
  })
  await step('the built app ran under its Content Security Policy without a violation', async () => {
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '')
    if (!/script-src 'self'/.test(csp)) throw new Error(`no CSP in the built page: ${JSON.stringify(csp)}`)
    if (cspViolations.length) throw new Error(`CSP violations:\n${cspViolations.join('\n')}`)
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
  await ldap.stop()
}
process.exit(failed ? 1 : 0)
