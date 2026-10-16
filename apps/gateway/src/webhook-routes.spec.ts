import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Presence, TelephonyEvent, TrunkStatus } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { verifyWebhookSignature } from './webhook-delivery.js'

// Documentation domains (RFC 2606) and fictional numbers only.
const policy = { adminRole: 'twakephone-admin', adminUsers: new Set(['A:root', 'B:root']) }
const as = (user: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
const root = as('root')
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

/** A provider whose events the test pushes, and whose trunks it says. */
const pushing = () => {
  const waiters: ((e: RoutedEvent) => void)[] = []
  const pending: RoutedEvent[] = []
  let trunks: TrunkStatus[] = []
  const factory: ProviderFactory<unknown> = {
    type: 'pushing',
    create: () =>
      ({
        getStatus: () => 'CONNECTED',
        getCapabilities: async () => ({ trunks: true }),
        getPresence: async () => ({ status: 'offline', source: 'telephony' }),
        getTrunkStatus: async () => trunks,
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => (pending.length ? Promise.resolve({ value: pending.shift()!, done: false }) : new Promise<IteratorResult<RoutedEvent>>(r => waiters.push(e => r({ value: e, done: false }))))
          })
        }),
        close: async () => {}
      }) as unknown as TelephonyProvider
  }
  const push = (extension: string, event: TelephonyEvent) => {
    const w = waiters.shift()
    if (w) w({ extension, event })
    else pending.push({ extension, event })
  }
  return { factory, push, setTrunks: (t: TrunkStatus[]) => (trunks = t) }
}

type Got = { url: string; headers: Record<string, string>; body: string }
const apps: { close(): Promise<unknown> }[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
})

const setup = async (opts: { secretsKey?: boolean; answer?: (n: number) => number; sendsPerMinute?: number; trunkWatchMs?: number } = {}) => {
  process.env.AUTH_MODE = 'dev'
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'A', userId: 'amartin', extension: '101' })
  await store.upsertMapping({ tenantId: 'A', userId: 'jdupont', extension: '102' })
  const { factory, push, setTrunks } = pushing()
  const registry = new ProviderRegistry([{ tenantId: 'A', type: 'pushing', config: {} }], [factory])
  const got: Got[] = []
  const app = await buildApp(registry, {
    store,
    admin: policy,
    ...(opts.secretsKey === false ? {} : { secretsKey: randomBytes(32) }),
    webhooks: {
      pollMs: 20,
      retryBaseMs: 30,
      post: async (url, body, headers) => {
        got.push({ url, headers, body })
        return { status: opts.answer ? opts.answer(got.length) : 204 }
      }
    },
    ...(opts.sendsPerMinute ? { webhookSendsPerMinute: opts.sendsPerMinute } : {}),
    trunkWatchMs: opts.trunkWatchMs ?? 0,
    trunkWatchConfirm: 1,
    trunkStatusCacheMs: 0
  })
  apps.push(app)
  await app.ready()
  registry.startAll()
  return { app, store, got, push, setTrunks }
}

const json = (payload: unknown) => ({ payload: payload as Record<string, unknown> })

describe('the webhook routes', () => {
  it('are for the administrators of the tenant only', async () => {
    const { app } = await setup()
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/v1/webhooks/domains'],
      ['PUT', '/api/v1/webhooks/domains', { domains: ['crm.example.org'] }],
      ['GET', '/api/v1/webhooks'],
      ['POST', '/api/v1/webhooks', { url: 'https://crm.example.org/in', events: ['call.missed'] }],
      ['GET', '/api/v1/webhooks/wh_0000000000000001'],
      ['PUT', '/api/v1/webhooks/wh_0000000000000001', { url: 'https://crm.example.org/in', events: ['call.missed'] }],
      ['DELETE', '/api/v1/webhooks/wh_0000000000000001'],
      ['POST', '/api/v1/webhooks/wh_0000000000000001/secret'],
      ['POST', '/api/v1/webhooks/wh_0000000000000001/test'],
      ['GET', '/api/v1/webhooks/wh_0000000000000001/deliveries'],
      ['POST', `/api/v1/webhooks/wh_0000000000000001/deliveries/dlv_${'0'.repeat(32)}/replay`]
    ]
    for (const [method, url, payload] of routes) {
      const opts = { method: method as 'GET', url, ...(payload ? json(payload) : {}) }
      expect((await app.inject({ ...opts, headers: as('amartin') })).statusCode, `${method} ${url}`).toBe(403)
      expect((await app.inject({ ...opts, headers: as('root', 'C') })).statusCode, `${method} ${url} other tenant`).toBe(403)
      expect((await app.inject(opts)).statusCode, `${method} ${url} anonymous`).toBe(401)
    }
  })

  it('answer 501 without SECRETS_KEY, which keeps the secrets', async () => {
    const { app } = await setup({ secretsKey: false })
    expect((await app.inject({ url: '/api/v1/webhooks', headers: root })).statusCode).toBe(501)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })).statusCode).toBe(501)
  })

  it('take the domains first, then a subscription to one of them, whose secret is shown once', async () => {
    const { app } = await setup()
    const create = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json(payload) })
    expect((await create({ url: 'https://crm.example.org/in', events: ['call.missed'] })).json()).toMatchObject({ code: 'WEBHOOK_DOMAIN' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['localhost'] }) })).json()).toMatchObject({ code: 'WEBHOOK_DOMAINS' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['CRM.example.org', '*.hooks.example.net'] }) })).json()).toEqual({ domains: ['crm.example.org', '*.hooks.example.net'] })
    expect((await app.inject({ url: '/api/v1/webhooks/domains', headers: root })).json()).toEqual({ domains: ['crm.example.org', '*.hooks.example.net'] })
    expect((await create({ url: 'http://crm.example.org/in', events: ['call.missed'] })).json()).toMatchObject({ code: 'WEBHOOK_URL_SCHEME' })
    expect((await create({ url: 'https://crm.example.org/in', events: ['voicemail.created'] })).json()).toMatchObject({ code: 'WEBHOOK_EVENTS' })

    const res = await create({ url: 'https://crm.example.org/in', events: ['call.missed', 'call.ringing'], description: 'CRM' })
    expect(res.statusCode).toBe(201)
    const made = res.json()
    expect(made).toEqual({ id: expect.stringMatching(/^wh_[0-9a-f]{16}$/), url: 'https://crm.example.org/in', events: ['call.ringing', 'call.missed'], description: 'CRM', enabled: true, deliverable: true, createdAt: expect.any(String), updatedAt: expect.any(String), secret: expect.stringMatching(/^whsec_/) })
    // Never read back: neither in the list nor alone.
    const listed = (await app.inject({ url: '/api/v1/webhooks', headers: root })).json().items
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(made.secret)
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).json()).not.toHaveProperty('secret')
    // Another tenant sees none of it.
    expect((await app.inject({ url: '/api/v1/webhooks', headers: as('root', 'B') })).json().items).toEqual([])
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: as('root', 'B') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${made.id}`, headers: as('root', 'B') })).statusCode).toBe(404)

    // A domain taken away: kept, but said not deliverable.
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['*.hooks.example.net'] }) })
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).json().deliverable).toBe(false)
  })

  it('change, disable, renew the secret of and delete a subscription', async () => {
    const { app, got } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const made = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['call.missed'], description: 'CRM' }) })).json()
    const put = await app.inject({ method: 'PUT', url: `/api/v1/webhooks/${made.id}`, headers: root, ...json({ url: 'https://crm.example.org/v2', events: ['trunk.degraded'], enabled: false }) })
    expect(put.json()).toMatchObject({ url: 'https://crm.example.org/v2', events: ['trunk.degraded'], enabled: false })
    expect(put.json()).not.toHaveProperty('description')
    // Enabled kept unless given.
    expect((await app.inject({ method: 'PUT', url: `/api/v1/webhooks/${made.id}`, headers: root, ...json({ url: 'https://crm.example.org/v2', events: ['trunk.degraded'] }) })).json().enabled).toBe(false)
    const renewed = (await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/secret`, headers: root })).json()
    expect(renewed.secret).toMatch(/^whsec_/)
    expect(renewed.secret).not.toBe(made.secret)
    // The secret it replaced still signs for a day (review 10a, n°6), as the subscription says.
    expect(Date.parse(renewed.previousSecretUntil) - Date.now()).toBeGreaterThan(86_400_000 - 60_000)
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).json().previousSecretUntil).toBe(renewed.previousSecretUntil)
    // Renewed while a change is written: the change never puts the secret back (review 10a, n°5).
    const [, again] = await Promise.all([
      app.inject({ method: 'PUT', url: `/api/v1/webhooks/${made.id}`, headers: root, ...json({ url: 'https://crm.example.org/v3', events: ['trunk.degraded'], enabled: true }) }),
      app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/secret`, headers: root }).then(r => r.json())
    ])
    const test = (await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })).json()
    await until('the test', () => got.find(g => JSON.parse(g.body).id === test.eventId))
    const signature = got.find(g => JSON.parse(g.body).id === test.eventId)!.headers['x-twakephone-signature']
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature(again.secret, signature, got.at(-1)!.body)).toBe(true)
    expect(verifyWebhookSignature(renewed.secret, signature, got.at(-1)!.body)).toBe(true)
    expect(verifyWebhookSignature(made.secret, signature, got.at(-1)!.body)).toBe(false)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${made.id}`, headers: root })).statusCode).toBe(204)
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/v1/webhooks/not-an-id', headers: root })).statusCode).toBe(404)
  })

  it('keep 20 subscriptions at most', async () => {
    const { app } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    for (let i = 0; i < 20; i++) expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: `https://crm.example.org/${i}`, events: ['call.missed'] }) })).statusCode).toBe(201)
    const res = await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/21', events: ['call.missed'] }) })
    expect([res.statusCode, res.json().code]).toEqual([409, 'WEBHOOK_LIMIT'])
  })

  it('send a test, list the deliveries a page at a time, and replay one, within a limit', async () => {
    const { app, got } = await setup({ answer: n => (n === 1 ? 500 : 204), sendsPerMinute: 2 })
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const made = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['trunk.degraded'] }) })).json()
    const test = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })
    expect(test.statusCode).toBe(202)
    expect(test.json()).toMatchObject({ id: expect.stringMatching(/^dlv_/), eventType: 'webhook.test', status: 'pending', attempts: 0 })
    // Answered 500 first, then 204: delivered at the second attempt, signed with the secret shown once.
    const log = () => app.inject({ url: `/api/v1/webhooks/${made.id}/deliveries`, headers: root }).then(r => r.json())
    const delivered = await until('delivered', async () => (await log()).items.find((d: { status: string }) => d.status === 'delivered'))
    expect(delivered).toMatchObject({ attempts: 2, lastStatus: 204 })
    expect(got.map(g => JSON.parse(g.body).id)).toEqual([delivered.eventId, delivered.eventId])
    expect(verifyWebhookSignature(made.secret, got[1]!.headers['x-twakephone-signature'], got[1]!.body)).toBe(true)

    const replay = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/deliveries/${delivered.id}/replay`, headers: root })
    expect([replay.statusCode, replay.json().status, replay.json().attempts]).toEqual([202, 'pending', 0])
    await until('sent again', () => got.length === 3)
    expect(JSON.parse(got[2]!.body).id).toBe(delivered.eventId)
    // The third send of the minute (with a limit of two): refused.
    const more = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })
    expect([more.statusCode, more.json().code]).toEqual([429, 'WEBHOOK_RATE'])

    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}/deliveries?status=lost`, headers: root })).json().code).toBe('WEBHOOK_QUERY')
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}/deliveries?before=x`, headers: root })).json().code).toBe('WEBHOOK_QUERY')
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/deliveries/dlv_${'0'.repeat(32)}/replay`, headers: as('root', 'B') })).statusCode).toBe(404)
  })

  it('send nothing to a disabled subscription, neither a test nor a replay (review 10a, n°10)', async () => {
    const { app, got } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const made = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['call.missed'] }) })).json()
    const sent = (await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })).json()
    await until('delivered', () => got.length === 1)
    await app.inject({ method: 'PUT', url: `/api/v1/webhooks/${made.id}`, headers: root, ...json({ url: 'https://crm.example.org/in', events: ['call.missed'], enabled: false }) })
    for (const url of [`/api/v1/webhooks/${made.id}/test`, `/api/v1/webhooks/${made.id}/deliveries/${sent.id}/replay`]) {
      const res = await app.inject({ method: 'POST', url, headers: root })
      expect([res.statusCode, res.json().code], url).toEqual([409, 'WEBHOOK_DISABLED'])
    }
    await sleep(60)
    expect(got).toHaveLength(1)
  })

  it("never reach another tenant's subscription nor delivery, by its real identifier", async () => {
    const { app, got } = await setup()
    for (const t of ['A', 'B']) await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: as('root', t), ...json({ domains: ['crm.example.org'] }) })
    const theirs = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: as('root', 'B'), ...json({ url: 'https://crm.example.org/b', events: ['call.missed'] }) })).json()
    const delivery = (await app.inject({ method: 'POST', url: `/api/v1/webhooks/${theirs.id}/test`, headers: as('root', 'B') })).json()
    await until('delivered', () => got.length === 1)
    const routes: [string, string, unknown?][] = [
      ['GET', `/api/v1/webhooks/${theirs.id}`],
      ['PUT', `/api/v1/webhooks/${theirs.id}`, { url: 'https://crm.example.org/a', events: ['call.missed'] }],
      ['POST', `/api/v1/webhooks/${theirs.id}/secret`],
      ['POST', `/api/v1/webhooks/${theirs.id}/test`],
      ['GET', `/api/v1/webhooks/${theirs.id}/deliveries`],
      ['POST', `/api/v1/webhooks/${theirs.id}/deliveries/${delivery.id}/replay`],
      ['DELETE', `/api/v1/webhooks/${theirs.id}`]
    ]
    for (const [method, url, payload] of routes) expect((await app.inject({ method: method as 'GET', url, headers: root, ...(payload ? json(payload) : {}) })).statusCode, `${method} ${url}`).toBe(404)
    // Theirs untouched: the same address, the same log, still there.
    expect((await app.inject({ url: `/api/v1/webhooks/${theirs.id}`, headers: as('root', 'B') })).json()).toMatchObject({ url: 'https://crm.example.org/b', enabled: true })
    expect((await app.inject({ url: `/api/v1/webhooks/${theirs.id}/deliveries`, headers: as('root', 'B') })).json().items).toHaveLength(1)
    expect(got).toHaveLength(1)
  })

  it('pages the log with next', async () => {
    const { app } = await setup({ sendsPerMinute: 100 })
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const made = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['call.missed'] }) })).json()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })).json().id)
      await sleep(3)
    }
    const first = (await app.inject({ url: `/api/v1/webhooks/${made.id}/deliveries?limit=3`, headers: root })).json()
    expect(first.items.map((d: { id: string }) => d.id)).toEqual(ids.slice(2).reverse())
    const second = (await app.inject({ url: `/api/v1/webhooks/${made.id}/deliveries?limit=3&before=${first.next}`, headers: root })).json()
    expect(second.items.map((d: { id: string }) => d.id)).toEqual(ids.slice(0, 2).reverse())
    expect(second).not.toHaveProperty('next')
  })
})

describe('the events a subscriber is sent', () => {
  const at = '2026-10-16T10:00:05.000Z'
  const call = { id: 'a84b4c76e66710@192.0.2.10', direction: 'inbound' as const, remoteNumber: '101', startedAt: '2026-10-16T10:00:00.000Z' }

  it("a missed call of a person, signed, from the provider's events", async () => {
    const { app, got, push } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const made = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['call.missed'] }) })).json()
    push('102', { type: 'call.ringing', timestamp: at, payload: { call: { ...call, state: 'ringing' } } })
    push('102', { type: 'call.ended', timestamp: at, payload: { call: { ...call, state: 'missed', endedAt: at } } })
    await until('the missed call', () => got.length === 1)
    await sleep(60)
    expect(got).toHaveLength(1)
    const event = JSON.parse(got[0]!.body)
    expect(event).toMatchObject({ type: 'call.missed', tenant: 'A', call: { id: call.id, direction: 'inbound', from: '101', to: '102', user: 'jdupont', extension: '102', outcome: 'missed', duration_sec: 0 } })
    expect(got[0]!.headers['idempotency-key']).toBe(event.id)
    expect(verifyWebhookSignature(made.secret, got[0]!.headers['x-twakephone-signature'], got[0]!.body)).toBe(true)
    // Jean erases his history: what the subscriber was sent about him goes from the log with it (review 10a, n°12).
    const log = () => app.inject({ url: `/api/v1/webhooks/${made.id}/deliveries`, headers: root }).then(r => r.json().items as unknown[])
    await until('logged as delivered', async () => (await log()).length === 1 && JSON.stringify(await log()).includes('delivered'))
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('amartin') })).statusCode).toBe(200)
    expect(await log()).toHaveLength(1)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jdupont') })).statusCode).toBe(200)
    expect(await log()).toEqual([])
  })

  it('a change of presence, told once (the status only)', async () => {
    const { app, got, push } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['presence.changed'] }) })
    const presence = (p: Presence): TelephonyEvent => ({ type: 'presence.changed', timestamp: at, payload: { userId: '', presence: p } })
    push('102', presence({ status: 'dnd', source: 'user', message: 'En réunion' }))
    push('102', presence({ status: 'dnd', source: 'user', message: 'Toujours en réunion' }))
    push('102', presence({ status: 'available', source: 'user' }))
    await until('two changes', () => got.length === 2)
    await sleep(60)
    expect(got.map(g => JSON.parse(g.body).presence)).toEqual([
      { user: 'jdupont', extension: '102', status: 'dnd' },
      { user: 'jdupont', extension: '102', status: 'available' }
    ])
    expect(got.map(g => g.body).join()).not.toContain('réunion')
  })

  it('a trunk that gets worse, then recovers, from what the SIP server says of it', async () => {
    const { app, got, setTrunks } = await setup({ trunkWatchMs: 20 })
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['trunk.degraded', 'trunk.recovered'] }) })
    setTrunks([{ id: 'tr1', servers: [{ address: '192.0.2.10:5060', state: 'up' }, { address: '192.0.2.11:5060', state: 'up' }] }])
    await sleep(80)
    expect(got).toHaveLength(0)
    setTrunks([{ id: 'tr1', servers: [{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'up' }] }])
    await until('trunk.degraded', () => got.length === 1)
    expect(JSON.parse(got[0]!.body)).toMatchObject({ type: 'trunk.degraded', tenant: 'A', trunk: { id: 'tr1', state: 'degraded', previous: 'up', servers: [{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'up' }] } })
    await sleep(80)
    expect(got).toHaveLength(1)
    setTrunks([{ id: 'tr1', servers: [{ address: '192.0.2.10:5060', state: 'up' }, { address: '192.0.2.11:5060', state: 'up' }] }])
    await until('trunk.recovered', () => got.length === 2)
    expect(JSON.parse(got[1]!.body)).toMatchObject({ type: 'trunk.recovered', tenant: 'A', trunk: { id: 'tr1', state: 'up', previous: 'degraded' } })
  })
})
