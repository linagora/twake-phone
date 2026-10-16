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

const setup = async (
  opts: { secretsKey?: boolean; answer?: (n: number) => number; hold?: Promise<void>; sendsPerMinute?: number; tenantSendsPerMinute?: number; maxPending?: number; presenceSettleMs?: number; trunkWatchMs?: number } = {}
) => {
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
      ...(opts.maxPending ? { maxPending: opts.maxPending } : {}),
      post: async (url, body, headers) => {
        got.push({ url, headers, body })
        await opts.hold
        return { status: opts.answer ? opts.answer(got.length) : 204 }
      }
    },
    ...(opts.sendsPerMinute ? { webhookSendsPerMinute: opts.sendsPerMinute } : {}),
    ...(opts.tenantSendsPerMinute ? { webhookTenantSendsPerMinute: opts.tenantSendsPerMinute } : {}),
    webhookPresenceSettleMs: opts.presenceSettleMs ?? 0,
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
      ['POST', '/api/v1/webhooks/wh_0000000000000001/resume'],
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

  it('let the administrators find the alerts of the webhooks by their kind (review 10a, second, n°4)', async () => {
    const { app, store } = await setup()
    await store.addAlert({ tenantId: 'A', at: new Date().toISOString(), alert: { kind: 'webhook', param: 'disabled', scope: 'tenant', value: 9 } })
    await store.addAlert({ tenantId: 'A', at: new Date().toISOString(), alert: { kind: 'limit', param: 'concurrent', scope: 'tenant', value: 3 } })
    const res = await app.inject({ url: '/api/v1/admin/alerts?kind=webhook', headers: root })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((a: { kind: string; param: string }) => [a.kind, a.param])).toEqual([['webhook', 'disabled']])
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
    // Ports 443 and 80 only (the operator lists others): no scanner of the ports of an address of their choice.
    for (const url of ['https://crm.example.org:8080/in', 'https://crm.example.org:22/in', 'https://crm.example.org:0/in']) expect((await create({ url, events: ['call.missed'] })).json(), url).toMatchObject({ code: 'WEBHOOK_URL_PORT' })
    expect((await create({ url: 'https://crm.example.org/in', events: ['voicemail.created'] })).json()).toMatchObject({ code: 'WEBHOOK_EVENTS' })

    const res = await create({ url: 'https://crm.example.org:443/in', events: ['call.missed', 'call.ringing'], description: 'CRM' })
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
    // Renewed without grace (a secret that leaked): the one it replaced no longer signs at all.
    const revoked = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/secret?grace=0`, headers: root })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json()).not.toHaveProperty('previousSecretUntil')
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).json()).not.toHaveProperty('previousSecretUntil')
    const lastTest = (await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })).json()
    const signed = await until('the test after', () => got.find(g => JSON.parse(g.body).id === lastTest.eventId))
    expect(signed.headers['x-twakephone-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature(revoked.json().secret, signed.headers['x-twakephone-signature'], signed.body)).toBe(true)
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/secret?grace=1`, headers: root })).json().code).toBe('WEBHOOK_QUERY')
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${made.id}`, headers: root })).statusCode).toBe(204)
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/v1/webhooks/not-an-id', headers: root })).statusCode).toBe(404)
  })

  it('resume a paused subscription without closing what it waits to send, and a test lifts its pause (review 10a, second, n°10)', async () => {
    const { app, store, got } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const made = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['call.missed'] }) })).json()
    const later = new Date(Date.now() + 3_600_000).toISOString()
    await store.pauseWebhookSubscription('A', made.id, later)
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).json().pausedUntil).toBe(later)
    // A test: sent now, the pause lifted.
    await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })
    await until('the test', () => got.length === 1)
    expect((await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).json()).not.toHaveProperty('pausedUntil')
    // Resumed: no pause, its failures forgotten.
    await store.pauseWebhookSubscription('A', made.id, later)
    const resumed = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/resume`, headers: root })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json()).toMatchObject({ id: made.id, enabled: true })
    expect(resumed.json()).not.toHaveProperty('pausedUntil')
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/resume`, headers: as('root', 'B') })).statusCode).toBe(404)
  })

  it('refuse a test or a replay to a subscription with too many waiting, count what it did not queue and alert (review 10a, second, n°11 and 12)', async () => {
    let answer: () => void = () => undefined
    const hold = new Promise<void>(r => (answer = r))
    const { app, got, push } = await setup({ maxPending: 1, hold })
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const made = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['call.missed'] }) })).json()
    const first = (await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })).json()
    await until('sent, not answered', () => got.length === 1)
    const more = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/test`, headers: root })
    expect([more.statusCode, more.json().code]).toEqual([409, 'WEBHOOK_BACKLOG'])
    // Missed calls meanwhile: recorded failed, counted, the administrators alerted (and the alert found by its kind).
    const call = { id: 'c-backlog@192.0.2.10', direction: 'inbound' as const, remoteNumber: '101', startedAt: '2026-10-16T10:00:00.000Z' }
    push('102', { type: 'call.ended', timestamp: '2026-10-16T10:00:05.000Z', payload: { call: { ...call, state: 'missed', endedAt: '2026-10-16T10:00:05.000Z' } } })
    const listed = await until('counted', async () => {
      const w = (await app.inject({ url: `/api/v1/webhooks/${made.id}`, headers: root })).json()
      return w.backlog ? w : undefined
    })
    expect(listed).toMatchObject({ backlog: 1, backlogAt: expect.any(String) })
    const alerts = await until('alerted', async () => {
      const r = (await app.inject({ url: '/api/v1/admin/alerts?kind=webhook', headers: root })).json()
      return r.items?.length ? r.items : undefined
    })
    expect(alerts.map((a: { kind: string; param: string }) => [a.kind, a.param])).toEqual([['webhook', 'backlog']])
    answer()
    await until('delivered', async () => (await app.inject({ url: `/api/v1/webhooks/${made.id}/deliveries?status=delivered`, headers: root })).json().items.length === 1)
    // A replay is held to the cap as well; the test is now over, so it is replayed.
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${made.id}/deliveries/${first.id}/replay`, headers: root })).statusCode).toBe(202)
  })

  it('limit the tests and replays of an organisation all together, however many subscriptions (review 10a, second, n°11)', async () => {
    const { app } = await setup({ tenantSendsPerMinute: 2 })
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: `https://crm.example.org/${i}`, events: ['call.missed'] }) })).json().id)
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${ids[0]}/test`, headers: root })).statusCode).toBe(202)
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${ids[1]}/test`, headers: root })).statusCode).toBe(202)
    const third = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${ids[2]}/test`, headers: root })
    expect([third.statusCode, third.json().code]).toEqual([429, 'WEBHOOK_RATE'])
    // Deleted and made again: counted the same.
    await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${ids[0]}`, headers: root })
    const again = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/0', events: ['call.missed'] }) })).json()
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${again.id}/test`, headers: root })).statusCode).toBe(429)
    // Another organisation has its own.
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: as('root', 'B'), ...json({ domains: ['crm.example.org'] }) })
    const theirs = (await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: as('root', 'B'), ...json({ url: 'https://crm.example.org/b', events: ['call.missed'] }) })).json()
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${theirs.id}/test`, headers: as('root', 'B') })).statusCode).toBe(202)
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

  it('a presence that settles: a status kept less than the settling time is not told (review 10a, second, n°19)', async () => {
    const { app, got, push } = await setup({ presenceSettleMs: 80 })
    await app.inject({ method: 'PUT', url: '/api/v1/webhooks/domains', headers: root, ...json({ domains: ['crm.example.org'] }) })
    await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: root, ...json({ url: 'https://crm.example.org/in', events: ['presence.changed'] }) })
    const presence = (p: Presence): TelephonyEvent => ({ type: 'presence.changed', timestamp: at, payload: { userId: '', presence: p } })
    // A short call: busy, then available again, within the settling time.
    push('102', presence({ status: 'busy', source: 'telephony' }))
    push('102', presence({ status: 'available', source: 'telephony' }))
    push('101', presence({ status: 'dnd', source: 'user' }))
    await until('the settled ones', () => got.length === 2)
    const told = got.map(g => JSON.parse(g.body).presence as { user: string; status: string }).sort((a, b) => a.user.localeCompare(b.user))
    expect(told.map(p => [p.user, p.status])).toEqual([
      ['amartin', 'dnd'],
      ['jdupont', 'available']
    ])
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
