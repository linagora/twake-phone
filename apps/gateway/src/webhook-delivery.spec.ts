import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { DeliveryError, WEBHOOK_PORTS, addressAllowed, denyNetworks, hostAllowed, newWebhookSecret, parseNetworks, parsePorts, parseTenantNetworks, parseWebhookDomains, parseWebhookUrl, postWebhook, signWebhook, verifyWebhookSignature } from './webhook-delivery.js'

describe('webhook signature', () => {
  const secret = newWebhookSecret()
  const body = JSON.stringify({ id: 'evt_1', type: 'call.missed' })

  it('signs the timestamp and the exact body, as a subscriber checks it', () => {
    const header = signWebhook(secret, 1_760_000_000, body)
    expect(header).toMatch(/^t=1760000000,v1=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature(secret, header, body, 1_760_000_010)).toBe(true)
    // Another body, another secret, an old delivery, nothing at all: refused.
    expect(verifyWebhookSignature(secret, header, `${body} `, 1_760_000_010)).toBe(false)
    expect(verifyWebhookSignature(newWebhookSecret(), header, body, 1_760_000_010)).toBe(false)
    expect(verifyWebhookSignature(secret, header, body, 1_760_000_000 + 301)).toBe(false)
    expect(verifyWebhookSignature(secret, undefined, body)).toBe(false)
    expect(verifyWebhookSignature(secret, 't=1760000000,v1=00', body, 1_760_000_000)).toBe(false)
  })

  it('signs with the secret before a new one too, for a day: either secret checks the delivery', () => {
    const [current, previous] = [newWebhookSecret(), newWebhookSecret()]
    const header = signWebhook([current, previous], 1_760_000_000, body)
    expect(header).toMatch(/^t=1760000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature(current, header, body, 1_760_000_000)).toBe(true)
    expect(verifyWebhookSignature(previous, header, body, 1_760_000_000)).toBe(true)
    expect(verifyWebhookSignature(newWebhookSecret(), header, body, 1_760_000_000)).toBe(false)
    // A header without its timestamp, or with nothing but it: refused.
    expect(verifyWebhookSignature(current, header.replace('t=1760000000,', ''), body, 1_760_000_000)).toBe(false)
    expect(verifyWebhookSignature(current, 't=1760000000', body, 1_760_000_000)).toBe(false)
    expect(verifyWebhookSignature(current, '', body, 1_760_000_000)).toBe(false)
  })

  it('draws a new secret of 256 bits each time', () => {
    const a = newWebhookSecret()
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(newWebhookSecret()).not.toBe(a)
  })
})

describe('allowed domains', () => {
  it('keeps host names and *. entries in lower case, each once, and refuses anything else', () => {
    expect(parseWebhookDomains({ domains: ['CRM.Example.org', '*.hooks.example.net', 'crm.example.org', '192.0.2.10', 'crm.example.org.'] })).toEqual(['crm.example.org', '*.hooks.example.net', '192.0.2.10'])
    for (const bad of ['localhost', 'intranet', '*', '*.org.', 'http://crm.example.org', 'crm.example.org/path', 'a..b.example', '-a.example.org', '::1', 'crm example.org', 42])
      expect(() => parseWebhookDomains({ domains: [bad] }), String(bad)).toThrow(expect.objectContaining({ code: 'WEBHOOK_DOMAINS' }))
    expect(() => parseWebhookDomains({ domains: Array.from({ length: 51 }, (_, i) => `d${i}.example.org`) })).toThrow(expect.objectContaining({ code: 'WEBHOOK_DOMAINS' }))
    expect(() => parseWebhookDomains({})).toThrow(expect.objectContaining({ code: 'WEBHOOK_DOMAINS' }))
  })

  it('matches a host exactly, or any subdomain of a *. entry (never the domain itself, nor a look-alike)', () => {
    const domains = ['crm.example.org', '*.hooks.example.net']
    expect(hostAllowed('crm.example.org', domains)).toBe(true)
    expect(hostAllowed('eu.hooks.example.net', domains)).toBe(true)
    expect(hostAllowed('a.eu.hooks.example.net', domains)).toBe(true)
    expect(hostAllowed('hooks.example.net', domains)).toBe(false)
    expect(hostAllowed('evilhooks.example.net', domains)).toBe(false)
    expect(hostAllowed('crm.example.org.evil.example', domains)).toBe(false)
    expect(hostAllowed('other.example.org', domains)).toBe(false)
  })
})

describe('the address of a subscription', () => {
  const domains = ['crm.example.org', '*.hooks.example.net', '192.0.2.10']

  it('is an https address of an allowed domain, kept as written by the URL standard', () => {
    expect(parseWebhookUrl('https://CRM.example.org/twakephone?x=1', domains)).toBe('https://crm.example.org/twakephone?x=1')
    expect(parseWebhookUrl('https://eu.hooks.example.net:8443/in', domains, { ports: [443, 8443] })).toBe('https://eu.hooks.example.net:8443/in')
    expect(parseWebhookUrl('https://crm.example.org:443/in', domains)).toBe('https://crm.example.org/in')
    expect(parseWebhookUrl('https://192.0.2.10/in', domains)).toBe('https://192.0.2.10/in')
  })

  it('refuses http (unless the operator allows it), credentials, a fragment and any other host', () => {
    const code = (url: unknown, policy = {}) => {
      try {
        parseWebhookUrl(url, domains, policy)
        return 'ok'
      } catch (err) {
        return (err as { code?: string }).code
      }
    }
    expect(code('http://crm.example.org/in')).toBe('WEBHOOK_URL_SCHEME')
    expect(code('http://crm.example.org/in', { allowHttp: true })).toBe('ok')
    expect(code('ftp://crm.example.org/in', { allowHttp: true })).toBe('WEBHOOK_URL_SCHEME')
    expect(code('https://user:pass@crm.example.org/in')).toBe('WEBHOOK_URL')
    expect(code('https://crm.example.org/in#x')).toBe('WEBHOOK_URL')
    expect(code('https://other.example.org/in')).toBe('WEBHOOK_DOMAIN')
    expect(code('https://hooks.example.net/in')).toBe('WEBHOOK_DOMAIN')
    expect(code('https://[::1]/in')).toBe('WEBHOOK_DOMAIN')
    expect(code('https://127.0.0.1/in')).toBe('WEBHOOK_DOMAIN')
    expect(code('not an address')).toBe('WEBHOOK_URL')
    expect(code(`https://crm.example.org/${'a'.repeat(2050)}`)).toBe('WEBHOOK_URL')
    expect(code(undefined)).toBe('WEBHOOK_URL')
  })

  it('names one of the ports allowed: 443 and 80 unless the operator lists others, never 0 (review 10a, second, n°3)', () => {
    const code = (url: string, policy = {}) => {
      try {
        parseWebhookUrl(url, domains, policy)
        return 'ok'
      } catch (err) {
        return (err as { code?: string }).code
      }
    }
    expect(WEBHOOK_PORTS).toEqual([443, 80])
    expect(code('https://crm.example.org/in')).toBe('ok')
    expect(code('http://crm.example.org/in', { allowHttp: true })).toBe('ok')
    expect(code('http://crm.example.org:80/in', { allowHttp: true })).toBe('ok')
    for (const port of [22, 6379, 8080, 8443, 0]) expect(code(`https://crm.example.org:${port}/in`), String(port)).toBe('WEBHOOK_URL_PORT')
    expect(code('https://crm.example.org:8443/in', { ports: [8443] })).toBe('ok')
    expect(code('https://crm.example.org/in', { ports: [8443] })).toBe('WEBHOOK_URL_PORT')
    expect(code('https://crm.example.org:0/in', { ports: [0, 443] })).toBe('WEBHOOK_URL_PORT')
    expect(parsePorts(undefined)).toEqual([443, 80])
    expect(parsePorts(' 443, 8443 ')).toEqual([443, 8443])
    for (const bad of ['0', '65536', 'http', '443;80', '-1']) expect(() => parsePorts(bad), bad).toThrow(/WEBHOOK_PORTS/)
  })
})

describe('the addresses a delivery may reach', () => {
  it('refuses this host, the private, link-local, shared, documentation, multicast and reserved ranges', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1', '224.0.0.1', '255.255.255.255'])
      expect(addressAllowed(a), a).toBe(false)
    for (const a of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '2002:7f00:1::1'])
      expect(addressAllowed(a), a).toBe(false)
    // The deprecated IPv4-compatible forms (::/96, whichever IPv4 address they carry, public too) and the 6bone.
    for (const a of ['::7f00:1', '::127.0.0.1', '::a9fe:a9fe', '::169.254.169.254', '::8.8.8.8', '::0.0.0.1', '3ffe::1', '3ffe:ffff::1'])
      expect(addressAllowed(a), a).toBe(false)
    expect(addressAllowed('not-an-ip')).toBe(false)
  })

  it('lets the public addresses through, IPv4 written in IPv6 too', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2a00:1450:4007:80e::200e', '::ffff:8.8.8.8']) expect(addressAllowed(a), a).toBe(true)
  })

  it('lets through the networks the operator opens, and only those', () => {
    const open = parseNetworks('10.20.0.0/16, 127.0.0.1, fd00:1::/64')
    expect(addressAllowed('10.20.3.4', open)).toBe(true)
    expect(addressAllowed('10.21.3.4', open)).toBe(false)
    expect(addressAllowed('127.0.0.1', open)).toBe(true)
    expect(addressAllowed('127.0.0.2', open)).toBe(false)
    expect(addressAllowed('::ffff:127.0.0.1', open)).toBe(true)
    expect(addressAllowed('fd00:1::5', open)).toBe(true)
    expect(addressAllowed('fd00:2::5', open)).toBe(false)
    expect(() => parseNetworks('10.0.0.0/33')).toThrow(/WEBHOOK_PRIVATE_NETWORKS/)
    expect(() => parseNetworks('crm.example.org')).toThrow(/WEBHOOK_PRIVATE_NETWORKS/)
    expect(addressAllowed('10.0.0.1', parseNetworks(''))).toBe(false)
  })

  it('opens networks to one organisation each, a bare list to the default one (review 10a, second, n°3)', () => {
    const open = parseTenantNetworks('acme=10.20.0.0/16,fd00:1::/64; beta=192.0.2.10 ;acme=10.30.0.1', 'default')
    expect([...open.keys()]).toEqual(['acme', 'beta'])
    expect(addressAllowed('10.20.3.4', open.get('acme'))).toBe(true)
    expect(addressAllowed('10.30.0.1', open.get('acme'))).toBe(true)
    expect(addressAllowed('192.0.2.10', open.get('acme'))).toBe(false)
    expect(addressAllowed('10.20.3.4', open.get('beta'))).toBe(false)
    expect(addressAllowed('10.20.3.4', open.get('gamma'))).toBe(false)
    expect([...parseTenantNetworks('10.20.0.0/16', 'default').keys()]).toEqual(['default'])
    expect(parseTenantNetworks(undefined, 'default').size).toBe(0)
    expect(() => parseTenantNetworks('acme=crm.example.org', 'default')).toThrow(/WEBHOOK_PRIVATE_NETWORKS/)
    expect(() => parseTenantNetworks('a cme=10.0.0.0/8', 'default')).toThrow(/WEBHOOK_PRIVATE_NETWORKS/)
  })

  it('never reaches what the operator closes, nor the addresses of this host, even inside what it opened', () => {
    const open = parseNetworks('192.0.2.0/24, 2001:db8::/32')
    const deny = denyNetworks('192.0.2.7, 2001:db8:1::/48', { eth0: [{ address: '192.0.2.50' }, { address: 'fe80::1%eth0' }], lo: [{ address: '127.0.0.1', internal: true }], down: undefined })
    expect(addressAllowed('192.0.2.8', open, deny)).toBe(true)
    expect(addressAllowed('2001:db8:2::1', open, deny)).toBe(true)
    for (const a of ['192.0.2.7', '::ffff:192.0.2.7', '192.0.2.50', '2001:db8:1::9', 'fe80::1']) expect(addressAllowed(a, open, deny), a).toBe(false)
    // The loopback is refused as any special range, unless opened (a receiver on a development machine).
    expect(addressAllowed('127.0.0.1', undefined, deny)).toBe(false)
    expect(addressAllowed('127.0.0.1', parseNetworks('127.0.0.0/8'), deny)).toBe(true)
    expect(() => denyNetworks('crm.example.org')).toThrow(/WEBHOOK_DENY_NETWORKS/)
  })
})

describe('postWebhook', () => {
  let server: Server | undefined
  afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())))
  /** A subscriber on the loopback that answers as `handle` says, and what it was sent. */
  const listen = (handle: (res: import('node:http').ServerResponse) => void) =>
    new Promise<{ url: string; got: { headers: Record<string, unknown>; body: string }[] }>(resolve => {
      const got: { headers: Record<string, unknown>; body: string }[] = []
      server = createServer((req, res) => {
        let body = ''
        req.on('data', c => (body += c))
        req.on('end', () => {
          got.push({ headers: req.headers, body })
          handle(res)
        })
      })
      server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/hook`, got }))
    })
  const reason = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (err: unknown) => (err instanceof DeliveryError ? err.reason : String(err))
    )

  it('posts the body with its headers and says the status of the answer', async () => {
    const { url, got } = await listen(res => res.writeHead(204).end())
    expect(await postWebhook(url, '{"a":1}', { 'content-type': 'application/json', 'x-test': 'yes' }, { open: parseNetworks('127.0.0.0/8') })).toEqual({ status: 204 })
    expect(got).toHaveLength(1)
    expect(got[0]!.body).toBe('{"a":1}')
    expect(got[0]!.headers['x-test']).toBe('yes')
    expect(got[0]!.headers['content-length']).toBe('7')
  })

  it('never reaches this host unless the operator opens it: a literal address, or a name that resolves to it', async () => {
    const { url, got } = await listen(res => res.writeHead(204).end())
    expect(await reason(postWebhook(url, '{}', {}))).toBe('destination-refused')
    const named = url.replace('127.0.0.1', 'crm.example.org')
    // A name whose addresses are all private, or one of them (a public one first does not help).
    expect(await reason(postWebhook(named, '{}', {}, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }))).toBe('destination-refused')
    expect(await reason(postWebhook(named, '{}', {}, { resolve: async () => [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }] }))).toBe('destination-refused')
    expect(await reason(postWebhook(named, '{}', {}, { resolve: async () => [{ address: '::ffff:127.0.0.1', family: 6 }] }))).toBe('destination-refused')
    expect(await reason(postWebhook(named, '{}', {}, { resolve: async () => [] }))).toBe('dns')
    expect(await reason(postWebhook(named, '{}', {}, { resolve: async () => Promise.reject(new Error('NXDOMAIN')) }))).toBe('dns')
    expect(got).toHaveLength(0)
    // Opened: the name resolved here is where the connection goes.
    expect(await postWebhook(named, '{}', {}, { open: parseNetworks('127.0.0.1'), resolve: async () => [{ address: '127.0.0.1', family: 4 }] })).toEqual({ status: 204 })
    expect(got).toHaveLength(1)
  })

  it('follows no redirect, bounds the wait, and takes a 2xx as delivered however long or slow its body', async () => {
    const open = parseNetworks('127.0.0.0/8')
    let answer: (res: import('node:http').ServerResponse) => void = res => res.writeHead(302, { location: 'http://169.254.169.254/' }).end()
    const { url } = await listen(res => answer(res))
    expect(await reason(postWebhook(url, '{}', {}, { open }))).toBe('redirect')
    answer = () => undefined
    expect(await reason(postWebhook(url, '{}', {}, { open, timeoutMs: 200 }))).toBe('timeout')
    // A status at once, then a body that never ends: delivered, without waiting for it (review 10a, n°9).
    answer = res => {
      res.writeHead(200)
      res.write('x'.repeat(1_000_000))
    }
    const started = Date.now()
    expect(await postWebhook(url, '{}', {}, { open, timeoutMs: 2_000 })).toEqual({ status: 200 })
    expect(Date.now() - started).toBeLessThan(1_000)
    answer = res => res.writeHead(500).end('oops')
    expect(await postWebhook(url, '{}', {}, { open })).toEqual({ status: 500 })
  })

  it('resolves the name once per delivery, connects to what it checked, and bounds the resolution and connection', async () => {
    const { url, got } = await listen(res => res.writeHead(204).end())
    const named = url.replace('127.0.0.1', 'crm.example.org')
    // A name that answers a public address and then this host's (rebinding): asked once, refused on what it said.
    let asked = 0
    const rebinding = async () => (asked++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.215.14', family: 4 }])
    expect(await postWebhook(named, '{}', {}, { open: parseNetworks('127.0.0.1'), resolve: rebinding })).toEqual({ status: 204 })
    expect(asked).toBe(1)
    expect(got).toHaveLength(1)
    // A DNS server that never answers: given up at the connection's bound, well before the answer's, and told
    // `dns` (the name was never resolved), not `timeout` (review 10a, second, n°20).
    const started = Date.now()
    expect(await reason(postWebhook(named, '{}', {}, { timeoutMs: 5_000, connectTimeoutMs: 150, resolve: () => new Promise(() => undefined) }))).toBe('dns')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('reaches an https subscriber by its name (SNI), checks its certificate against that name', async () => {
    // A certificate made for this test, never kept: crm.example.org, signed by itself.
    const dir = mkdtempSync(join(tmpdir(), 'webhook-tls-'))
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=crm.example.org', '-addext', 'subjectAltName=DNS:crm.example.org', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
      const [key, cert] = [readFileSync(join(dir, 'key.pem')), readFileSync(join(dir, 'cert.pem'))]
      const names: (string | false | null)[] = []
      const tls = createHttpsServer({ key, cert }, (req, res) => {
        names.push((req.socket as TLSSocket).servername)
        req.resume()
        req.on('end', () => res.writeHead(204).end())
      })
      server = tls
      await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', () => resolve()))
      const port = (tls.address() as AddressInfo).port
      const opts = { open: parseNetworks('127.0.0.1'), resolve: async () => [{ address: '127.0.0.1', family: 4 }] }
      expect(await postWebhook(`https://crm.example.org:${port}/hook`, '{}', {}, { ...opts, ca: cert })).toEqual({ status: 204 })
      expect(names).toEqual(['crm.example.org'])
      // Another name on the same address, or a certificate nobody vouches for: no delivery.
      expect(await reason(postWebhook(`https://other.example.org:${port}/hook`, '{}', {}, { ...opts, ca: cert }))).toBe('tls')
      expect(await reason(postWebhook(`https://crm.example.org:${port}/hook`, '{}', {}, opts))).toBe('tls')
      expect(names).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says a connection refused as such', async () => {
    const { url } = await listen(res => res.end())
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
    expect(await reason(postWebhook(url, '{}', {}, { open: parseNetworks('127.0.0.0/8') }))).toBe('connection')
  })
})
