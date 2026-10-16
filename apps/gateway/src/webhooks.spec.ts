import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { encrypt } from './crypto.js'
import { MemoryStore } from './store/memory.js'
import { PgStore } from './store/pg.js'
import type { Store, WebhookSubscriptionRecord } from './store/types.js'
import { DeliveryError, verifyWebhookSignature } from './webhook-delivery.js'
import type { PublishedWebhookEvent } from './webhook-events.js'
import { WebhookHub, parseSubscription, retryDelayMs, type WebhookHubOptions } from './webhooks.js'

const key = randomBytes(32)
const SECRET = 'whsec_test-secret'
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async <T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 3000): Promise<T> => {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

const subscription = (over: Partial<WebhookSubscriptionRecord> = {}): WebhookSubscriptionRecord => ({
  tenantId: 'acme',
  id: 'wh_00000000000000a1',
  url: 'https://crm.example.org/in',
  events: ['call.missed'],
  enabled: true,
  secretEnc: encrypt(SECRET, key),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over
})

const missed = (id = 'evt_00000000000000000000000000000001'): Extract<PublishedWebhookEvent, { call: unknown }> => ({
  id,
  type: 'call.missed',
  occurred_at: '2026-10-16T10:00:00.000Z',
  tenant: 'acme',
  call: { id: 'c1', direction: 'inbound', from: '101', to: '102', user: 'jdupont', extension: '102', duration_sec: 0, outcome: 'missed', source: ['opensips'] }
})

/** What a subscriber got: each request's url, headers and body. */
type Got = { url: string; headers: Record<string, string>; body: string }

const hubs: WebhookHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop()
})
const hubOn = (store: Store, answer: (got: Got, n: number) => Promise<number> | number, over: Partial<WebhookHubOptions> = {}) => {
  const got: Got[] = []
  const hub = new WebhookHub({
    store,
    key,
    pollMs: 20,
    retryBaseMs: 30,
    logger: quiet,
    post: async (url, body, headers) => {
      const g = { url, headers, body }
      got.push(g)
      return { status: await answer(g, got.length) }
    },
    ...over
  })
  hubs.push(hub)
  return { hub, got }
}

describe('retries', () => {
  it('wait twice as long each time from 30 s, 8 times (about two hours in all), spread by up to 10 %', () => {
    const waits = Array.from({ length: 8 }, (_, i) => retryDelayMs(i + 1, 30_000, 0))
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_840_000])
    expect(waits.reduce((a, b) => a + b, 0) / 60_000).toBeCloseTo(127.5)
    expect(retryDelayMs(1, 30_000, 1)).toBe(33_000)
  })
})

describe('a subscription as written', () => {
  const domains = ['crm.example.org']
  it('takes the events TwakePhone emits, each once in the order of the model, and a one-line description', () => {
    expect(parseSubscription({ url: 'https://crm.example.org/in', events: ['call.missed', 'call.ringing', 'call.missed'], description: ' CRM ' }, domains, {})).toEqual({ url: 'https://crm.example.org/in', events: ['call.ringing', 'call.missed'], description: 'CRM' })
    expect(parseSubscription({ url: 'https://crm.example.org/in', events: ['trunk.degraded'], enabled: false }, domains, {})).toEqual({ url: 'https://crm.example.org/in', events: ['trunk.degraded'], enabled: false })
  })
  it('refuses no event, an unknown one, one kept for later, and a description of several lines', () => {
    const code = (body: unknown) => {
      try {
        parseSubscription(body, domains, {})
        return 'ok'
      } catch (err) {
        return (err as { code?: string }).code
      }
    }
    expect(code({ url: 'https://crm.example.org/in', events: [] })).toBe('WEBHOOK_EVENTS')
    expect(code({ url: 'https://crm.example.org/in', events: ['call.everything'] })).toBe('WEBHOOK_EVENTS')
    expect(code({ url: 'https://crm.example.org/in', events: ['voicemail.created'] })).toBe('WEBHOOK_EVENTS')
    expect(code({ url: 'https://crm.example.org/in', events: ['webhook.test'] })).toBe('WEBHOOK_EVENTS')
    expect(code({ url: 'https://crm.example.org/in', events: ['call.missed'], description: 'a\nb' })).toBe('WEBHOOK_DESCRIPTION')
    expect(code({ url: 'https://crm.example.org/in', events: ['call.missed'], enabled: 'yes' })).toBe('WEBHOOK_INVALID')
    expect(code({ url: 'https://other.example.org/in', events: ['call.missed'] })).toBe('WEBHOOK_DOMAIN')
    expect(code(null)).toBe('WEBHOOK_INVALID')
  })
})

describe('the webhook hub', () => {
  const setup = async (over: Partial<WebhookSubscriptionRecord> = {}) => {
    const store = new MemoryStore()
    await store.setWebhookDomains('acme', ['crm.example.org'])
    await store.addWebhookSubscription(subscription(over), 20)
    return store
  }

  it('delivers an event signed on the exact body, with its id as the idempotency key, to the subscriptions that take it', async () => {
    const store = await setup()
    await store.addWebhookSubscription(subscription({ id: 'wh_00000000000000a2', events: ['call.ringing'] }), 20)
    const { hub, got } = hubOn(store, () => 204)
    hub.start()
    expect(await hub.publish('acme', missed())).toBe(1)
    await until('the delivery', () => got.length === 1)
    const g = got[0]!
    expect(g.url).toBe('https://crm.example.org/in')
    expect(JSON.parse(g.body)).toEqual(missed())
    expect(verifyWebhookSignature(SECRET, g.headers['x-twakephone-signature'], g.body)).toBe(true)
    expect(g.headers).toMatchObject({ 'content-type': 'application/json', 'x-twakephone-event': 'call.missed', 'x-twakephone-event-id': missed().id, 'idempotency-key': missed().id })
    expect(g.headers['x-twakephone-delivery']).toMatch(/^dlv_[0-9a-f]{32}$/)
    const d = await until('delivered', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'delivered'))
    expect([d.attempts, d.lastStatus]).toEqual([1, 204])
    // Nobody takes it: nothing written. The same event again: not queued again.
    expect(await hub.publish('acme', { ...missed('evt_00000000000000000000000000000002'), type: 'call.ended' })).toBe(0)
    expect(await hub.publish('acme', missed())).toBe(0)
    await sleep(80)
    expect(got).toHaveLength(1)
  })

  it('retries what is not answered 2xx, 8 times at most, then fails it', async () => {
    const store = await setup()
    const { hub, got } = hubOn(store, () => 503)
    hub.start()
    await hub.publish('acme', missed())
    const d = await until('failed', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'failed'), 30_000)
    expect([d.attempts, d.lastStatus, d.lastError]).toEqual([9, 503, 'http'])
    expect(got).toHaveLength(9)
    // The same body and the same event id at each attempt: a subscriber ignores the repeats.
    expect(new Set(got.map(g => g.body)).size).toBe(1)
    expect(new Set(got.map(g => g.headers['idempotency-key'])).size).toBe(1)
  }, 40_000)

  it('delivers once the subscriber answers again, and says the failures meanwhile', async () => {
    const store = await setup()
    const { hub } = hubOn(store, (_g, n) => (n < 3 ? 500 : 200))
    hub.start()
    await hub.publish('acme', missed())
    const d = await until('delivered', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'delivered'))
    expect([d.attempts, d.lastStatus, d.lastError]).toEqual([3, 200, undefined])
  })

  it('refuses for good, without a request, a domain no longer allowed and an address the network keeps out', async () => {
    const store = await setup()
    const { hub, got } = hubOn(store, () => 204)
    await store.setWebhookDomains('acme', ['other.example.org'])
    hub.start()
    await hub.publish('acme', missed())
    let d = await until('failed', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'failed'))
    expect([d.attempts, d.lastError]).toEqual([1, 'domain-not-allowed'])
    expect(got).toHaveLength(0)
    await hub.stop()

    const refusing = hubOn(store, () => {
      throw new DeliveryError('destination-refused', 'private')
    })
    await store.setWebhookDomains('acme', ['crm.example.org'])
    refusing.hub.start()
    await refusing.hub.publish('acme', missed('evt_00000000000000000000000000000003'))
    d = await until('failed', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'failed' && x.eventId.endsWith('3')))
    expect([d.attempts, d.lastError]).toEqual([1, 'destination-refused'])
  })

  it('retries a timeout or a refused connection, which pass', async () => {
    const store = await setup()
    const { hub } = hubOn(store, (_g, n) => {
      if (n === 1) throw new DeliveryError('timeout', 'slow')
      if (n === 2) throw new DeliveryError('connection', 'down')
      return 202
    })
    hub.start()
    await hub.publish('acme', missed())
    const d = await until('delivered', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'delivered'))
    expect([d.attempts, d.lastStatus]).toEqual([3, 202])
  })

  it('takes a delivery back when the Gateway that held it stopped before its outcome (the end of its lease)', async () => {
    const store = await setup()
    // This one takes it and answers nothing (stopped mid-request): it stops looking at the queue meanwhile.
    let release: (status: number) => void = () => undefined
    const first = hubOn(store, () => new Promise<number>(r => (release = r)), { leaseMs: 150 })
    first.hub.start()
    await first.hub.publish('acme', missed())
    await until('taken', () => first.got.length === 1)
    const stopping = first.hub.stop()
    // Another Gateway: nothing to take while the lease holds, then the delivery.
    const second = hubOn(store, () => 204, { leaseMs: 150 })
    second.hub.start()
    await sleep(60)
    expect(second.got).toHaveLength(0)
    await until('taken again', () => second.got.length === 1)
    const d = await until('delivered', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'delivered'))
    expect([d.attempts, d.lastStatus]).toEqual([2, 204])
    // The first one's answer, come too late, changes nothing: its claim is no longer the delivery's.
    release(500)
    await stopping
    const after = (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1'))[0]
    expect([after?.status, after?.attempts, after?.lastStatus]).toEqual(['delivered', 2, 204])
  })

  it('sends a test to one subscription whatever events it takes, and hears a subscription made since', async () => {
    const store = await setup({ events: ['trunk.degraded'] })
    const { hub, got } = hubOn(store, () => 204)
    hub.start()
    const delivery = await hub.test('acme', 'wh_00000000000000a1')
    expect(delivery?.eventType).toBe('webhook.test')
    await until('the test', () => got.length === 1)
    expect(JSON.parse(got[0]!.body)).toMatchObject({ type: 'webhook.test', tenant: 'acme', subscription: 'wh_00000000000000a1' })
    expect(await hub.test('other', 'wh_00000000000000a1')).toBeNull()
    // What the tenant's subscriptions take was read: a new one is heard once the hub is told (or after a few seconds).
    expect(await hub.publish('acme', missed())).toBe(0)
    await store.addWebhookSubscription(subscription({ id: 'wh_00000000000000a3' }), 20)
    expect(await hub.publish('acme', missed())).toBe(0)
    hub.forget('acme')
    expect(await hub.publish('acme', missed())).toBe(1)
  })

  it('sends nothing a subscription disabled was owed', async () => {
    const store = await setup()
    const { hub, got } = hubOn(store, () => 204)
    await hub.publish('acme', missed())
    await store.updateWebhookSubscription(subscription({ enabled: false }))
    hub.start()
    await sleep(100)
    expect(got).toHaveLength(0)
  })
})

if (process.env.TEST_DATABASE_URL) {
  describe('the webhook hub on PostgreSQL, two Gateways', () => {
    it('delivers each event once, shared between them (SKIP LOCKED), whichever queued it', async () => {
      // A database of its own: these workers claim what is due in any tenant, and the store contract (run at the same
      // time against TEST_DATABASE_URL) empties its tables between its tests.
      const base = new URL(process.env.TEST_DATABASE_URL!)
      const name = `${decodeURIComponent(base.pathname.slice(1)) || 'postgres'}_webhooks_spec`
      const server = new pg.Pool({ connectionString: base.toString(), max: 1 })
      await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await server.query(`CREATE DATABASE "${name}"`)
      const own = new URL(base.toString())
      own.pathname = `/${name}`
      const a = new PgStore(own.toString())
      const b = new PgStore(own.toString())
      await a.migrate()
      const tenant = `two-${Date.now()}`
      try {
        await a.setWebhookDomains(tenant, ['crm.example.org'])
        await a.addWebhookSubscription(subscription({ tenantId: tenant, id: `wh_${randomBytes(8).toString('hex')}` }), 20)
        const seen: string[] = []
        const answer = async (g: Got) => {
          seen.push(JSON.parse(g.body).id as string)
          await sleep(5)
          return 204
        }
        const one = hubOn(a, answer, { concurrency: 4 })
        const two = hubOn(b, answer, { concurrency: 4 })
        one.hub.start()
        two.hub.start()
        const ids = Array.from({ length: 40 }, (_, i) => `evt_${String(i).padStart(32, '0')}`)
        // Each event heard by both Gateways (both subscribe to OpenSIPS): queued once.
        await Promise.all(ids.flatMap(id => [one.hub.publish(tenant, { ...missed(id), tenant }), two.hub.publish(tenant, { ...missed(id), tenant })]))
        await until('all delivered', () => seen.length >= ids.length, 10_000)
        await sleep(200)
        expect(seen.sort()).toEqual(ids)
        expect(one.got.length).toBeGreaterThan(0)
        expect(two.got.length).toBeGreaterThan(0)
      } finally {
        for (const h of hubs.splice(0)) await h.stop()
        await a.close()
        await b.close()
        await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        await server.end()
      }
    }, 20_000)
  })
}
