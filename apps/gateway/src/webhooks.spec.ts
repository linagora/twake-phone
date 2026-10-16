import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encrypt } from './crypto.js'
import { MemoryStore } from './store/memory.js'
import { PgStore } from './store/pg.js'
import { BlockList } from 'node:net'
import { WEBHOOK_STATE_ROLE, type Store, type WebhookDeliveryRecord, type WebhookSubscriptionRecord } from './store/types.js'
import { DeliveryError, verifyWebhookSignature, type PostOptions } from './webhook-delivery.js'
import { presenceEvent, type PublishedWebhookEvent } from './webhook-events.js'
import { WebhookHub, parseSubscription, pauseMs, retryDelayMs, secretContext, type WebhookHubOptions } from './webhooks.js'

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

const subscription = (over: Partial<WebhookSubscriptionRecord> = {}): WebhookSubscriptionRecord => {
  const tenantId = over.tenantId ?? 'acme'
  const id = over.id ?? 'wh_00000000000000a1'
  return {
    tenantId,
    id,
    url: 'https://crm.example.org/in',
    events: ['call.missed'],
    enabled: true,
    secretEnc: encrypt(SECRET, key, secretContext(tenantId, id)),
    failures: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  }
}

const missed = (id = 'evt_00000000000000000000000000000001'): Extract<PublishedWebhookEvent, { call: unknown }> => ({
  id,
  type: 'call.missed',
  occurred_at: '2026-10-16T10:00:00.000Z',
  tenant: 'acme',
  call: { id: 'c1', direction: 'inbound', from: '101', to: '102', user: 'jdupont', extension: '102', duration_sec: 0, outcome: 'missed', source: ['opensips'] }
})

/** What a subscriber got: each request's url, headers and body, and what the hub asked of the request. */
type Got = { url: string; headers: Record<string, string>; body: string; opts: PostOptions }

/** A promise the test settles when it wants (a subscriber that answers when told). */
const gate = () => {
  let open: () => void = () => undefined
  const opened = new Promise<void>(r => (open = r))
  return { opened, open }
}

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
    pauseBaseMs: 5,
    stateLeaseMs: 300,
    logger: quiet,
    post: async (url, body, headers, opts) => {
      const g = { url, headers, body, opts }
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
  it('pause a subscription failing 5 times in a row 30 s, twice as long each failure after, an hour at most', () => {
    expect([5, 6, 7, 11, 12, 40].map(f => pauseMs(f))).toEqual([30_000, 60_000, 120_000, 1_920_000, 3_600_000, 3_600_000])
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
    expect((await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).map(x => x.status)).toEqual(['delivered'])
    expect(got).toHaveLength(1)
    // The request bounded to 5 s by default: a subscriber slower than that fails (and is paused by its breaker).
    expect(got[0]!.opts.timeoutMs).toBe(5_000)
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

  it('retries a timeout or a refused connection, which pass, the log saying `unreachable` and the server why', async () => {
    const store = await setup()
    const reasons: string[] = []
    const logger = { ...quiet, warn: (o: { reason?: string }) => void (o.reason && reasons.push(o.reason)) }
    const errors: (string | undefined)[] = []
    const { hub } = hubOn(
      store,
      async (_g, n) => {
        errors.push((await store.listWebhookDeliveries('acme', 'wh_00000000000000a1'))[0]?.lastError)
        if (n === 1) throw new DeliveryError('timeout', 'slow')
        if (n === 2) throw new DeliveryError('connection', 'down')
        if (n === 3) throw new DeliveryError('dns', 'no such host')
        if (n === 4) throw new DeliveryError('tls', 'bad certificate')
        return 202
      },
      { logger }
    )
    hub.start()
    await hub.publish('acme', missed())
    const d = await until('delivered', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'delivered'))
    expect([d.attempts, d.lastStatus]).toEqual([5, 202])
    // What an administrator reads: one category, no oracle of what listens where; the details in the server's log.
    expect(errors).toEqual([undefined, 'unreachable', 'unreachable', 'unreachable', 'unreachable'])
    expect(reasons).toEqual(['timeout', 'connection', 'dns', 'tls'])
  })

  it('opens the networks the operator opened to an organisation to its deliveries only', async () => {
    const store = await setup()
    await store.setWebhookDomains('other', ['crm.example.net'])
    await store.addWebhookSubscription(subscription({ tenantId: 'other', id: 'wh_00000000000000b1', url: 'https://crm.example.net/in' }), 20)
    const acme = new BlockList()
    acme.addSubnet('10.20.0.0', 16, 'ipv4')
    const { hub, got } = hubOn(store, () => 204, { open: new Map([['acme', acme]]) })
    hub.start()
    await hub.publish('acme', missed())
    await hub.publish('other', { ...missed(), tenant: 'other' })
    await until('both delivered', () => got.length === 2)
    const opened = (host: string) => got.find(g => g.url.includes(host))!.opts.open
    expect(opened('example.org')?.check('10.20.0.5', 'ipv4')).toBe(true)
    expect(opened('example.net')).toBeUndefined()
  })

  it('takes a delivery back when the Gateway that held it stopped before its outcome (the end of its lease)', async () => {
    const store = await setup()
    const LEASE = 400
    // This one takes it and answers nothing (stopped mid-request): it stops looking at the queue meanwhile.
    let release: (status: number) => void = () => undefined
    const first = hubOn(store, () => new Promise<number>(r => (release = r)), { leaseMs: LEASE })
    first.hub.start()
    await first.hub.publish('acme', missed())
    await until('taken', () => first.got.length === 1)
    const takenAt = Date.parse((await store.listWebhookDeliveries('acme', 'wh_00000000000000a1'))[0]!.lastAttemptAt!)
    const stopping = first.hub.stop()
    // Another Gateway: nothing to take while the lease holds (however slow this machine), then the delivery.
    const second = hubOn(store, () => 204, { leaseMs: LEASE })
    second.hub.start()
    await until('taken again', () => second.got.length === 1)
    const retakenAt = Date.parse((await store.listWebhookDeliveries('acme', 'wh_00000000000000a1'))[0]!.lastAttemptAt!)
    expect(retakenAt - takenAt).toBeGreaterThanOrEqual(LEASE)
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
    const delivery = (await hub.test('acme', 'wh_00000000000000a1')) as WebhookDeliveryRecord
    expect(delivery.eventType).toBe('webhook.test')
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

  it('fails a redirect for good, and retries an error it cannot classify instead of leaving it to its lease', async () => {
    const store = await setup()
    const { hub } = hubOn(store, (_g, n) => {
      if (n === 1) throw new DeliveryError('redirect', 'moved')
      if (n === 2) throw new Error('something nobody foresaw')
      return 204
    })
    hub.start()
    await hub.publish('acme', missed())
    let d = await until('failed', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'failed'))
    expect([d.attempts, d.lastError]).toEqual([1, 'redirect'])
    await hub.publish('acme', missed('evt_00000000000000000000000000000004'))
    d = await until('delivered', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).find(x => x.status === 'delivered'))
    expect([d.attempts, d.lastStatus]).toEqual([2, 204])
  })

  it('signs with the secret it replaced as well while that one is still accepted', async () => {
    const store = await setup()
    const NEW = 'whsec_the-new-one'
    const { hub, got } = hubOn(store, () => 204)
    await store.renewWebhookSecret('acme', 'wh_00000000000000a1', encrypt(NEW, key, secretContext('acme', 'wh_00000000000000a1')), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())
    hub.start()
    await hub.publish('acme', missed())
    await until('the delivery', () => got.length === 1)
    const header = got[0]!.headers['x-twakephone-signature']!
    expect(header.match(/v1=/g)).toHaveLength(2)
    expect(verifyWebhookSignature(NEW, header, got[0]!.body)).toBe(true)
    expect(verifyWebhookSignature(SECRET, header, got[0]!.body)).toBe(true)
    expect(verifyWebhookSignature('whsec_another', header, got[0]!.body)).toBe(false)
    // A secret copied from another subscription does not decrypt there (bound to its own): refused, never sent.
    await store.addWebhookSubscription(subscription({ id: 'wh_00000000000000a9', secretEnc: subscription().secretEnc }), 20)
    await hub.publish('acme', missed('evt_00000000000000000000000000000005'))
    const d = await until('refused', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a9')).find(x => x.status === 'failed'))
    expect(d.lastError).toBe('secret-unreadable')
  })

  it('never lets a subscriber that never answers delay another tenant: its share of what is sent at once, then paused', async () => {
    const store = await setup()
    // Acme's five subscriptions point to a host that drops the packets: each attempt waits for its timeout.
    for (let i = 2; i <= 5; i++) await store.addWebhookSubscription(subscription({ id: `wh_00000000000000a${i}` }), 20)
    await store.setWebhookDomains('other', ['crm.example.net'])
    await store.addWebhookSubscription(subscription({ tenantId: 'other', id: 'wh_00000000000000b1', url: 'https://crm.example.net/in' }), 20)
    let inFlight = 0
    let most = 0
    // Acme's attempts time out when the test says (after the other tenant was delivered).
    const timeouts = gate()
    const { hub, got } = hubOn(
      store,
      async g => {
        if (g.url.includes('example.net')) return 204
        most = Math.max(most, ++inFlight)
        await timeouts.opened
        inFlight--
        throw new DeliveryError('timeout', 'no answer')
      },
      { concurrency: 6, perSubscription: 2, perTenant: 4 }
    )
    hub.start()
    for (let i = 10; i < 40; i++) await hub.publish('acme', missed(`evt_${String(i).padStart(32, '0')}`))
    await until('acme holding what it may', () => inFlight >= 4)
    await hub.publish('other', { ...missed('evt_000000000000000000000000000000ff'), tenant: 'other' })
    // Delivered while every place acme may hold is still held: it waited for none of them.
    await until('the other tenant delivered', () => got.some(g => g.url.includes('example.net')))
    expect(inFlight).toBe(4)
    timeouts.open()
    // Five failures in a row: the subscription is paused, its deliveries wait.
    const paused = await until('paused', async () => (await store.listWebhookSubscriptions('acme')).find(w => w.pausedUntil && w.failures >= 5), 10_000)
    expect(Date.parse(paused.pausedUntil!)).toBeGreaterThan(Date.now() - 1000)
    // Acme never had more than its share in flight (4 of the 6), whatever it had queued (150 deliveries).
    expect(most).toBe(4)
  }, 20_000)

  it('disables a subscription that failed for long enough, and alerts the administrators once', async () => {
    const store = await setup()
    const { hub } = hubOn(store, () => 500, { disableAfterMs: 0 })
    hub.start()
    for (let i = 50; i < 56; i++) await hub.publish('acme', missed(`evt_${String(i).padStart(32, '0')}`))
    const w = await until('disabled', async () => (await store.listWebhookSubscriptions('acme')).find(x => !x.enabled), 10_000)
    expect(w.disabledReason).toBe('failing')
    await until('its pending ones failed', async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1', { status: 'pending' })).length === 0)
    const alerts = await store.listAlerts('acme')
    expect(alerts.map(a => [a.alert.kind, a.alert.param, a.count])).toEqual([['webhook', 'disabled', 1]])
    // Nothing queued for it any more.
    hub.forget('acme')
    expect(await hub.publish('acme', missed('evt_000000000000000000000000000000ee'))).toBe(0)
  }, 20_000)

  it('dates the queue on the store clock, whatever its own', async () => {
    // A database an hour ahead of this Gateway: what it queues is due on the database's clock.
    const store = new MemoryStore(() => Date.now() + 3_600_000)
    await store.setWebhookDomains('acme', ['crm.example.org'])
    await store.addWebhookSubscription(subscription(), 20)
    const { hub, got } = hubOn(store, () => 204)
    hub.start()
    await until('the lease taken', () => hub.leading)
    await hub.publish('acme', missed())
    await until('the delivery', () => got.length === 1)
    const [d] = await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')
    expect(Math.abs(Date.parse(d!.createdAt) - (Date.now() + 3_600_000))).toBeLessThan(5_000)
    expect(Math.abs(hub.clock() - (Date.now() + 3_600_000))).toBeLessThan(1_000)
  })

  it('tells a presence once though two Gateways hear it, and never the state before after the state since (review 10a, n°2)', async () => {
    const store = await setup({ events: ['presence.changed'] })
    const first = hubOn(store, () => 204)
    const second = hubOn(store, () => 204)
    first.hub.start()
    await until('the first one tells the changes', () => first.hub.leading)
    second.hub.start()
    await second.hub.renewLease()
    expect(second.hub.leading).toBe(false)
    const change = (hub: WebhookHub, status: 'busy' | 'available') => hub.publishChange('acme', 'presence:jdupont', status, ['presence.changed'], (_p, at) => presenceEvent('acme', 'jdupont', '102', status, at))
    // The first Gateway hears busy then available; the second, later, the same two.
    expect(await change(first.hub, 'busy')).toBe(1)
    expect(await change(first.hub, 'available')).toBe(1)
    expect(await change(second.hub, 'busy')).toBeNull()
    expect(await change(second.hub, 'available')).toBeNull()
    await until('both delivered', () => first.got.length + second.got.length === 2)
    await sleep(100)
    const told = [...first.got, ...second.got].map(g => JSON.parse(g.body) as { presence: { status: string }; occurred_at: string }).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    expect(told.map(e => e.presence.status)).toEqual(['busy', 'available'])
    // The first one stops and gives its lease back: the second tells the changes from its next renewal, never one
    // older than the last told.
    await first.hub.stop()
    await second.hub.renewLease()
    expect(second.hub.leading).toBe(true)
    await until(
      'the second one tells',
      async () => {
        await second.hub.renewLease()
        return second.hub.leading
      },
      3_000
    )
    expect(await change(second.hub, 'available')).toBe(0)
    expect(await change(second.hub, 'busy')).toBe(1)
  })

  it('never lets two tenants whose subscribers answer 204 slowly delay a third, at the default settings (review 10a, second, n°2)', async () => {
    const store = new MemoryStore()
    // Two tenants of 20 subscriptions each, whose subscribers answer 204 in 9 s (here: when the test says).
    const slow = ['slow1', 'slow2']
    for (const tenantId of [...slow, 'third']) await store.setWebhookDomains(tenantId, ['crm.example.org'])
    for (const tenantId of slow) for (let i = 0; i < 20; i++) await store.addWebhookSubscription(subscription({ tenantId, id: `wh_${tenantId === 'slow1' ? 'a' : 'b'}${String(i).padStart(15, '0')}` }), 20)
    await store.addWebhookSubscription(subscription({ tenantId: 'third', id: 'wh_c000000000000000' }), 20)
    const answers = gate()
    const held = new Map<string, number>()
    const delivered: string[] = []
    const hub = new WebhookHub({
      store,
      key,
      logger: quiet,
      post: async (_url, body) => {
        const tenant = (JSON.parse(body) as { tenant: string }).tenant
        if (tenant === 'third') {
          delivered.push(tenant)
          return { status: 204 }
        }
        held.set(tenant, (held.get(tenant) ?? 0) + 1)
        await answers.opened
        return { status: 204 }
      }
    })
    hubs.push(hub)
    hub.start()
    // Each of the slow tenants has an event for each of its subscriptions, then more (a busy call centre).
    for (const tenantId of slow) for (let i = 0; i < 3; i++) await hub.publish(tenantId, { ...missed(`evt_${tenantId === 'slow1' ? 'a' : 'b'}${String(i).padStart(31, '0')}`), tenant: tenantId })
    await until('the slow tenants holding what they may', () => (held.get('slow1') ?? 0) + (held.get('slow2') ?? 0) >= 2 * hub.perTenant)
    // A quarter of the Gateway each (4 of 16), whatever they have queued: the rest is free for the others.
    expect(hub.perTenant).toBe(4)
    expect([held.get('slow1'), held.get('slow2')]).toEqual([4, 4])
    await hub.publish('third', { ...missed('evt_c0000000000000000000000000000001'), tenant: 'third' })
    await until('the third tenant delivered while the slow ones still hold their places', () => delivered.length === 1)
    expect([held.get('slow1'), held.get('slow2')]).toEqual([4, 4])
    answers.open()
  })

  it('lifts the pause of a subscription it sends a test to, and resumes one without closing what it waits to send', async () => {
    const store = await setup()
    const { hub, got } = hubOn(store, () => 204)
    hub.start()
    const later = new Date(Date.now() + 3_600_000).toISOString()
    await store.pauseWebhookSubscription('acme', 'wh_00000000000000a1', later)
    await hub.publish('acme', missed())
    // A test lifts the pause: it and what waited go now, not in an hour.
    await hub.test('acme', 'wh_00000000000000a1')
    await until('both delivered', () => got.length === 2)
    expect((await store.getWebhookSubscription('acme', 'wh_00000000000000a1'))?.pausedUntil).toBeUndefined()
    // Paused again and failing: resumed, its failures forgotten, what waits sent.
    await store.pauseWebhookSubscription('acme', 'wh_00000000000000a1', later)
    await hub.publish('acme', missed('evt_00000000000000000000000000000006'))
    expect(await hub.resume('acme', 'wh_00000000000000a1')).toBe(true)
    expect(await hub.resume('other', 'wh_00000000000000a1')).toBe(false)
    await until('sent once resumed', () => got.length === 3)
  })

  it('alerts the administrators when a subscription has too many waiting, once, and counts what it did not queue', async () => {
    const store = await setup()
    const answers = gate()
    const { hub } = hubOn(store, async () => (await answers.opened, 204), { maxPending: 2 })
    hub.start()
    for (let i = 60; i < 66; i++) await hub.publish('acme', missed(`evt_${String(i).padStart(32, '0')}`))
    const alerts = await until('alerted', async () => {
      const list = await store.listAlerts('acme')
      return list.length ? list : undefined
    })
    expect(alerts.map(a => [a.alert.kind, a.alert.param, a.count])).toEqual([['webhook', 'backlog', 1]])
    const w = await store.getWebhookSubscription('acme', 'wh_00000000000000a1')
    expect(w?.backlog).toBe(4)
    answers.open()
  })

  it('fails what was abandoned by a Gateway that stopped on its last attempt, apart from the claims', async () => {
    const store = await setup()
    const { hub } = hubOn(store, () => 204, { maxAttempts: 1 })
    await store.enqueueWebhookEvent('acme', 'evt_x', 'call.missed', '{}', undefined)
    const [d] = await store.claimWebhookDeliveries(1, { perSubscription: 2, perTenant: 4, maxAttempts: 1, leaseMs: 0 })
    expect(d?.attempts).toBe(1)
    expect(await hub.sweep()).toBe(1)
    const [after] = await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')
    expect([after?.status, after?.lastError]).toEqual(['failed', 'abandoned'])
  })

  it('drops what it cannot queue soon enough rather than piling it up, and says so', async () => {
    const store = await setup()
    const warned: string[] = []
    const enqueue = store.enqueueWebhookEvent.bind(store)
    const slowDb = gate()
    store.enqueueWebhookEvent = async (...args) => (await slowDb.opened, enqueue(...args))
    const { hub } = hubOn(store, () => 204, { publishConcurrency: 1, publishQueue: 2, logger: { ...quiet, warn: (_o, msg) => void warned.push(msg ?? '') } })
    const all = [10, 11, 12, 13].map(i => hub.publish('acme', missed(`evt_${String(i).padStart(32, '0')}`)))
    // The fourth: one being queued, two waiting; dropped at once.
    expect(await all[3]).toBe(0)
    expect(warned).toEqual(['webhook events dropped: too many waiting to be queued'])
    slowDb.open()
    expect(await Promise.all(all.slice(0, 3))).toEqual([1, 1, 1])
  })

  it('takes no lease back after it stopped, however late the renewal under way ends (review 10a, second, n°6)', async () => {
    const store = await setup()
    const clock = store.clock.bind(store)
    const slowClock = gate()
    let reads = 0
    store.clock = async () => {
      if (++reads > 1) await slowClock.opened
      return clock()
    }
    let leads = 0
    const { hub } = hubOn(store, () => 204, { stateLeaseMs: 60_000 })
    hub.onLead(() => void leads++)
    await hub.renewLease()
    expect([hub.leading, leads]).toEqual([true, 1])
    // A renewal waits on a slow database; the hub stops meanwhile.
    hub.start()
    const renewal = hub.renewLease()
    const stopping = hub.stop()
    slowClock.open()
    await Promise.all([renewal, stopping])
    expect(hub.leading).toBe(false)
    expect(leads).toBe(1)
    // The lease was given back after the renewal ended: another Gateway takes it at once.
    expect(await store.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_next', 60_000)).toBe(true)
    // One renewal at a time: asked twice, run once.
    const once = new WebhookHub({ store, key, logger: quiet })
    let taken = 0
    const take = store.takeWebhookLease.bind(store)
    store.takeWebhookLease = (...args) => (taken++, take(...args))
    once.start()
    await Promise.all([once.renewLease(), once.renewLease()])
    expect(taken).toBe(1)
    await once.stop()
  })

  it('gives the lease to a Gateway that hears its events, and tells again what it knows once it hears them again (review 10a, second, n°8)', async () => {
    const store = await setup({ events: ['presence.changed'] })
    let deafHears = false
    const deaf = hubOn(store, () => 204, { healthy: () => deafHears, stateLeaseMs: 60_000 })
    const ok = hubOn(store, () => 204, { stateLeaseMs: 60_000 })
    let told = 0
    deaf.hub.onLead(() => void told++)
    // Alone, the one that does not hear takes the lease (better than nobody)...
    await deaf.hub.renewLease()
    expect(deaf.hub.leading).toBe(true)
    // ...and gives it to one that hears at its next renewal.
    await ok.hub.renewLease()
    await deaf.hub.renewLease()
    expect([deaf.hub.leading, ok.hub.leading]).toEqual([false, true])
    await ok.hub.stop()
    await deaf.hub.renewLease()
    expect(deaf.hub.leading).toBe(true)
    expect(told).toBe(2)
    // It hears again: what it knows is told again (its events lost meanwhile).
    deafHears = true
    await deaf.hub.renewLease()
    await until('told again', () => told === 3)
  })

  it('tells the changes of a lease that changed hands between two of them, with a second Gateway whose clock lags (review 10a, second, n°14)', async () => {
    const store = await setup({ events: ['presence.changed'] })
    const first = hubOn(store, () => 204)
    // Its clock a minute behind the store's: the changes it tells are dated by the store, after the first one's.
    const second = hubOn(store, () => 204, { now: () => Date.now() - 60_000 })
    const change = (hub: WebhookHub, status: 'busy' | 'available' | 'away') => hub.publishChange('acme', 'presence:jdupont', status, ['presence.changed'], (_p, at) => presenceEvent('acme', 'jdupont', '102', status, at))
    await first.hub.renewLease()
    await second.hub.renewLease()
    expect(await change(first.hub, 'busy')).toBe(1)
    expect(await change(second.hub, 'available')).toBeNull()
    await first.hub.stop()
    await second.hub.renewLease()
    expect(second.hub.leading).toBe(true)
    expect(await change(second.hub, 'available')).toBe(1)
    expect(await change(first.hub, 'away')).toBeNull()
    expect(await change(second.hub, 'away')).toBe(1)
    const log = (await store.listWebhookDeliveries('acme', 'wh_00000000000000a1')).reverse().map(d => JSON.parse(d.body) as { presence: { status: string }; occurred_at: string })
    expect(log.map(e => e.presence.status)).toEqual(['busy', 'available', 'away'])
    // Dated in the order they were told, whatever the second one's clock.
    expect(log.map(e => e.occurred_at)).toEqual(log.map(e => e.occurred_at).sort())
  })
})

if (process.env.TEST_DATABASE_URL) {
  describe('the webhook hub on PostgreSQL, two Gateways', () => {
    // A database of its own: these workers claim what is due in any tenant, and the store contract (run at the same
    // time against TEST_DATABASE_URL) empties its tables between its tests.
    const base = new URL(process.env.TEST_DATABASE_URL!)
    const name = `${decodeURIComponent(base.pathname.slice(1)) || 'postgres'}_webhooks_spec`
    const own = new URL(base.toString())
    own.pathname = `/${name}`
    let server: pg.Pool
    const stores: PgStore[] = []
    const store = () => {
      const s = new PgStore(own.toString())
      stores.push(s)
      return s
    }
    beforeAll(async () => {
      server = new pg.Pool({ connectionString: base.toString(), max: 1 })
      await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await server.query(`CREATE DATABASE "${name}"`)
      await store().migrate()
    })
    afterAll(async () => {
      for (const h of hubs.splice(0)) await h.stop()
      for (const s of stores.splice(0)) await s.close()
      // Not WITH (FORCE): the backends of the pools just closed may not have exited yet, and killing them sends a
      // FATAL to sockets this process still reads. Retried until they are gone; the next run drops it anyway.
      for (let i = 0; i < 50; i++) {
        try {
          await server.query(`DROP DATABASE IF EXISTS "${name}"`)
          break
        } catch {
          await sleep(100)
        }
      }
      await server.end()
    })

    it('delivers each event once, shared between them (SKIP LOCKED), whichever queued it', async () => {
      const [a, b] = [store(), store()]
      const tenant = `two-${Date.now()}`
      await a.setWebhookDomains(tenant, ['crm.example.org'])
      const sub = `wh_${randomBytes(8).toString('hex')}`
      await a.addWebhookSubscription(subscription({ tenantId: tenant, id: sub }), 20)
      const seen: string[] = []
      const answer = async (g: Got) => {
        seen.push(JSON.parse(g.body).id as string)
        await sleep(5)
        return 204
      }
      const one = hubOn(a, answer, { concurrency: 4, perSubscription: 8 })
      const two = hubOn(b, answer, { concurrency: 4, perSubscription: 8 })
      one.hub.start()
      two.hub.start()
      const ids = Array.from({ length: 40 }, (_, i) => `evt_${String(i).padStart(32, '0')}`)
      // Each event heard by both Gateways (both subscribe to OpenSIPS): queued once.
      await Promise.all(ids.flatMap(id => [one.hub.publish(tenant, { ...missed(id), tenant }), two.hub.publish(tenant, { ...missed(id), tenant })]))
      // All delivered in the store: none can be sent again (each held until its lease, a minute, and done since).
      await until('all delivered', async () => (await a.listWebhookDeliveries(tenant, sub, { limit: 200, status: 'delivered' })).length === ids.length, 10_000)
      expect(seen.sort()).toEqual(ids)
      expect(one.got.length).toBeGreaterThan(0)
      expect(two.got.length).toBeGreaterThan(0)
      for (const h of [one.hub, two.hub]) await h.stop()
    }, 20_000)

    it('tells a presence two Gateways hear once, in its order, the second one hearing it later (review 10a, n°2)', async () => {
      const [a, b] = [store(), store()]
      const tenant = `presence-${Date.now()}`
      await a.setWebhookDomains(tenant, ['crm.example.org'])
      await a.addWebhookSubscription(subscription({ tenantId: tenant, id: `wh_${randomBytes(8).toString('hex')}`, events: ['presence.changed'] }), 20)
      const one = hubOn(a, () => 204)
      const two = hubOn(b, () => 204)
      // The lease of the test before lapses first (its Gateways stopped).
      await until('the first one tells', async () => {
        await one.hub.renewLease()
        return one.hub.leading
      })
      await two.hub.renewLease()
      expect([one.hub.leading, two.hub.leading]).toEqual([true, false])
      one.hub.start()
      two.hub.start()
      const change = (hub: WebhookHub, status: 'busy' | 'available') => hub.publishChange(tenant, 'presence:jdupont', status, ['presence.changed'], (_p, at) => presenceEvent(tenant, 'jdupont', '102', status, at))
      // Interleaved as the reviewer heard them: the first Gateway busy, available; the second busy, available, after.
      const queued = [await change(one.hub, 'busy'), await change(two.hub, 'busy'), await change(one.hub, 'available'), await change(two.hub, 'busy'), await change(two.hub, 'available')]
      expect(queued).toEqual([1, null, 1, null, null])
      await until('both delivered', () => one.got.length + two.got.length === 2)
      await sleep(200)
      const told = [...one.got, ...two.got].map(g => JSON.parse(g.body) as { presence: { status: string }; occurred_at: string }).sort((x, y) => x.occurred_at.localeCompare(y.occurred_at))
      expect(told.map(e => e.presence.status)).toEqual(['busy', 'available'])
      for (const h of [one.hub, two.hub]) await h.stop()
    }, 20_000)

    it('tells the changes in order across a lease changing hands, the second Gateway\u2019s clock lagging (review 10a, second, n°14)', async () => {
      const [a, b] = [store(), store()]
      const tenant = `handoff-${Date.now()}`
      const sub = `wh_${randomBytes(8).toString('hex')}`
      await a.setWebhookDomains(tenant, ['crm.example.org'])
      await a.addWebhookSubscription(subscription({ tenantId: tenant, id: sub, events: ['presence.changed'] }), 20)
      const one = hubOn(a, () => 204)
      const two = hubOn(b, () => 204, { now: () => Date.now() - 60_000 })
      await until('the first one tells', async () => {
        await one.hub.renewLease()
        return one.hub.leading
      })
      await two.hub.renewLease()
      const change = (hub: WebhookHub, status: 'busy' | 'available' | 'away') => hub.publishChange(tenant, 'presence:jdupont', status, ['presence.changed'], (_p, at) => presenceEvent(tenant, 'jdupont', '102', status, at))
      expect(await change(one.hub, 'busy')).toBe(1)
      await one.hub.stop()
      await two.hub.renewLease()
      expect(two.hub.leading).toBe(true)
      expect(await change(two.hub, 'available')).toBe(1)
      expect(await change(two.hub, 'away')).toBe(1)
      const log = (await a.listWebhookDeliveries(tenant, sub)).reverse().map(d => JSON.parse(d.body) as { presence: { status: string }; occurred_at: string })
      expect(log.map(e => e.presence.status)).toEqual(['busy', 'available', 'away'])
      expect(log.map(e => e.occurred_at)).toEqual(log.map(e => e.occurred_at).sort())
      await two.hub.stop()
    }, 20_000)
  })
}
