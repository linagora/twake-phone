import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Call, TelephonyEvent } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { decrypt } from './crypto.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { DEFAULT_PUSH_SERVICES, PUSH_SUBSCRIPTIONS_MAX, WebPush, hostAllowed, parsePushServices, parseVapidSubject } from './push.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { startPushService } from '../test/push-service.mjs'

const KEY = Buffer.alloc(32, 7)
const SUBJECT = 'mailto:admin@example.test'
type PushService = Awaited<ReturnType<typeof startPushService>>

const until = async (what: string, fn: () => boolean | Promise<boolean>, timeout = 5_000) => {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

let service: PushService
beforeAll(async () => {
  service = await startPushService()
})
afterAll(async () => service.stop())

/** A WebPush that takes the test service's endpoints (HTTPS on the loopback, with its own certificate). */
const make = (store = new MemoryStore(), more: Partial<ConstructorParameters<typeof WebPush>[0]> = {}) =>
  new WebPush({ store, key: KEY, subject: SUBJECT, allowEndpoint: url => url.origin === service.origin, agent: service.agent, ...more })

describe('push services and VAPID subject', () => {
  it('allows the browsers\' push services by default, and only the hosts listed in PUSH_SERVICES otherwise', () => {
    expect(DEFAULT_PUSH_SERVICES.every(p => !p.includes('/'))).toBe(true)
    expect(hostAllowed('fcm.googleapis.com', DEFAULT_PUSH_SERVICES)).toBe(true)
    expect(hostAllowed('wns2-par02p.notify.windows.com', DEFAULT_PUSH_SERVICES)).toBe(true)
    expect(hostAllowed('web.push.apple.com', DEFAULT_PUSH_SERVICES)).toBe(true)
    expect(hostAllowed('notify.windows.com', DEFAULT_PUSH_SERVICES)).toBe(false)
    expect(hostAllowed('evilnotify.windows.com', DEFAULT_PUSH_SERVICES)).toBe(false)
    expect(hostAllowed('fcm.googleapis.com.example.test', DEFAULT_PUSH_SERVICES)).toBe(false)
    expect(parsePushServices(undefined)).toEqual(DEFAULT_PUSH_SERVICES)
    expect(parsePushServices(' push.example.test, *.Push.Example.org ')).toEqual(['push.example.test', '*.push.example.org'])
    for (const bad of ['https://push.example.test', 'push', '*', 'push.example.test/x', '10.0.0.1:443']) expect(() => parsePushServices(bad)).toThrow(/PUSH_SERVICES/)
    expect(parseVapidSubject('https://phone.example.test')).toBe('https://phone.example.test')
    expect(parseVapidSubject('mailto:admin@example.test')).toBe('mailto:admin@example.test')
    for (const bad of ['http://phone.example.test', 'admin@example.test', '']) expect(() => parseVapidSubject(bad)).toThrow(/VAPID_SUBJECT/)
  })
})

describe('WebPush', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } }

  it('takes a subscription of an allowed push service over HTTPS, with a P-256 key and a 16-byte secret', () => {
    const push = new WebPush({ store: new MemoryStore(), key: KEY, subject: SUBJECT })
    expect(push.parseSubscription({ ...sub, expirationTime: null })).toEqual({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    const refused = (body: unknown) => {
      try {
        push.parseSubscription(body)
      } catch (err) {
        return (err as { code?: string }).code
      }
      return 'accepted'
    }
    // Anything else than the push services is never sent to (no request to an address a browser chose).
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/abc', 'https://127.0.0.1/push', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'https://metadata.google.internal/x']) expect(refused({ ...sub, endpoint }), endpoint).toBe('PUSH_SERVICE')
    for (const body of [null, {}, { ...sub, endpoint: 42 }, { ...sub, endpoint: 'not a url' }, { ...sub, endpoint: `https://fcm.googleapis.com/${'x'.repeat(1024)}` }]) expect(refused(body)).toBe('PUSH_SUBSCRIPTION')
    for (const keys of [{}, { ...sub.keys, p256dh: Buffer.alloc(65, 1).toString('base64url') }, { ...sub.keys, p256dh: 'not base64!' }, { ...sub.keys, auth: Buffer.alloc(15).toString('base64url') }]) expect(refused({ ...sub, keys })).toBe('PUSH_SUBSCRIPTION')
  })

  it('makes its VAPID keys once and keeps them encrypted; uses the keys given as they are; none without either', async () => {
    const store = new MemoryStore()
    const first = await make(store).vapidKeys()
    expect(first!.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    const kept = (await store.getVapidKeys())!
    expect(kept.publicKey).toBe(first!.publicKey)
    expect(kept.privateKeyEnc).not.toContain(first!.privateKey)
    expect(decrypt(kept.privateKeyEnc, KEY)).toBe(first!.privateKey)
    // Another instance (or a restart) on the same database: the same keys, the subscriptions still valid.
    expect(await make(store).vapidKeys()).toEqual(first)
    const given = { publicKey: 'BPub', privateKey: 'priv' }
    expect(await make(new MemoryStore(), { vapid: given, key: undefined }).publicKey()).toBe('BPub')
    expect(await new WebPush({ store: new MemoryStore(), subject: SUBJECT }).publicKey()).toBeNull()
  })

  it('sends each browser of the person the message encrypted for it alone (aes128gcm), signed (VAPID), urgent, for as long as asked', async () => {
    const store = new MemoryStore()
    const push = make(store)
    const [one, two, other] = [service.subscribe(), service.subscribe(), service.subscribe()]
    await push.subscribe('A', 'jean', push.parseSubscription(one))
    await push.subscribe('A', 'jean', push.parseSubscription(two))
    await push.subscribe('A', 'paul', push.parseSubscription(other))
    const message = { type: 'call' as const, callId: 'c1', number: '101', name: 'Alice Martin', until: 1_792_000_000_000 }
    expect(await push.notify('A', 'jean', message, 25)).toEqual({ sent: 2, gone: [] })
    for (const s of [one, two]) {
      const got = await service.next(s.id)
      expect(got.error).toBeUndefined()
      expect(got.data).toEqual(message)
      expect(got.headers).toMatchObject({ ttl: '25', urgency: 'high', topic: 'call', 'content-encoding': 'aes128gcm' })
      expect(got.vapid).toMatchObject({ publicKey: await push.publicKey(), claims: { sub: SUBJECT, aud: service.origin } })
    }
    expect(service.messages.filter(m => m.id === other.id)).toEqual([])
  })

  it('removes a subscription its push service says is gone (410, 404), and keeps one that failed otherwise', async () => {
    const store = new MemoryStore()
    const errors: object[] = []
    const push = make(store, { logger: { warn: () => undefined, error: o => void errors.push(o) } })
    const [kept, dropped] = [service.subscribe(), service.subscribe()]
    await push.subscribe('A', 'jean', push.parseSubscription(kept))
    await push.subscribe('A', 'jean', push.parseSubscription(dropped))
    service.gone(dropped.id)
    expect(await push.notify('A', 'jean', { type: 'missed', callId: 'c2', number: '101' }, 60)).toEqual({ sent: 1, gone: [{ tenantId: 'A', userId: 'jean' }] })
    expect((await store.listPushSubscriptions('A', 'jean')).map(s => s.endpoint)).toEqual([kept.endpoint])
    // A push service that cannot be reached: said in the log (its host, never the endpoint), the subscription kept.
    await store.savePushSubscription({ tenantId: 'A', userId: 'jean', endpoint: 'https://127.0.0.1:1/push/x', p256dh: kept.keys.p256dh, auth: kept.keys.auth, createdAt: new Date().toISOString() })
    expect(await push.notify('A', 'jean', { type: 'missed', callId: 'c3', number: '101' }, 60)).toMatchObject({ sent: 1, gone: [] })
    expect(errors).toEqual([expect.objectContaining({ service: '127.0.0.1' })])
    expect(JSON.stringify(errors)).not.toContain('/push/')
    expect(await store.listPushSubscriptions('A', 'jean')).toHaveLength(2)
  })

  it(`keeps at most ${PUSH_SUBSCRIPTIONS_MAX} browsers per person: the oldest goes`, async () => {
    const store = new MemoryStore()
    const push = make(store)
    const subs = Array.from({ length: PUSH_SUBSCRIPTIONS_MAX + 1 }, () => service.subscribe())
    for (const s of subs) {
      await push.subscribe('A', 'jean', push.parseSubscription(s))
      await new Promise(r => setTimeout(r, 2))
    }
    expect((await store.listPushSubscriptions('A', 'jean')).map(s => s.endpoint)).toEqual(subs.slice(1).map(s => s.endpoint))
  })
})

describe('/me/push-subscriptions and the calls woken for', () => {
  const call = (id: string, remoteNumber: string, state: Call['state'] = 'ringing'): Call => ({ id, direction: 'inbound', state, localNumber: '102', remoteNumber, startedAt: new Date().toISOString() })
  /** A provider that can hold calls for someone without a window, and hands the Gateway the events it is given. */
  const holding = (push = true) => {
    const wakeable: string[] = []
    const queue: RoutedEvent[] = []
    let wakeUp: (() => void) | undefined
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ push }),
      getPresence: async () => ({ status: 'available', source: 'telephony' }),
      setPresence: async () => undefined,
      listGroups: async () => [{ number: '200', name: 'Accueil', members: ['101', '102'] }],
      setWakeable: async (holders: { extension: string; userId: string }[]) => void wakeable.push(holders.map(h => `${h.extension}=${h.userId}`).join(',')),
      subscribe: async function* () {
        for (;;) {
          while (queue.length) yield queue.shift()!
          await new Promise<void>(r => (wakeUp = r))
        }
      },
      close: async () => wakeUp?.()
    }
    // Tenant B has a provider of its own, that tells nothing.
    const factory: ProviderFactory<unknown> = { type: 'holding', create: (_config, context) => (context?.tenantId === 'B' ? { ...provider, setWakeable: async () => undefined, subscribe: async function* () {} } : provider) as unknown as TelephonyProvider }
    const emit = (extension: string, event: TelephonyEvent) => {
      queue.push({ extension, event })
      wakeUp?.()
    }
    return { factory, wakeable, emit }
  }
  const setup = async ({ push = true, withPush = true } = {}) => {
    process.env.AUTH_MODE = 'dev'
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101', displayName: 'Alice Martin' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '102', displayName: 'Jean Dupont' })
    await store.upsertMapping({ tenantId: 'B', userId: 'carol', extension: '102' })
    const rec = holding(push)
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'holding', config: {} }, { tenantId: 'B', type: 'holding', config: {} }], [rec.factory])
    const webPush = make(store)
    const bus = new EventBus()
    const app = await buildApp(registry, { store, bus, directory: new StoreDirectory(store), tickets: new TicketStore(), ...(withPush ? { push: webPush } : {}) })
    registry.startAll()
    const as = (user: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
    return { app, as, store, rec, bus, webPush }
  }

  it('gives the key to subscribe with, keeps the browser for the person, and tells the provider who can be woken', async () => {
    const { app, as, store, rec, webPush } = await setup()
    // At its start: nobody yet.
    await until('the first restore', () => rec.wakeable.length >= 1)
    expect(rec.wakeable).toEqual([''])
    const state = await app.inject({ url: '/api/v1/me/push-subscriptions', headers: as('jean') })
    expect(state.json()).toEqual({ available: true, publicKey: await webPush.publicKey(), subscriptions: 0 })
    const browser = service.subscribe()
    const res = await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions', headers: as('jean'), payload: browser })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ available: true, subscriptions: 1 })
    expect(rec.wakeable.at(-1)).toBe('102=jean')
    // Tenant B's 102 (Carol) is not Jean: nothing of tenant A shows there.
    expect((await app.inject({ url: '/api/v1/me/push-subscriptions', headers: as('carol', 'B') })).json()).toMatchObject({ subscriptions: 0 })
    expect(await store.listPushUsers('B')).toEqual([])
    // Someone else cannot remove it; Jean can, and nobody can be woken any more.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/push-subscriptions', headers: as('alice'), payload: { endpoint: browser.endpoint } })).statusCode).toBe(204)
    expect(await store.listPushUsers('A')).toEqual(['jean'])
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/push-subscriptions', headers: as('jean'), payload: { endpoint: browser.endpoint } })).statusCode).toBe(204)
    expect(await store.listPushUsers('A')).toEqual([])
    expect(rec.wakeable.at(-1)).toBe('')
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/push-subscriptions', headers: as('jean'), payload: {} })).statusCode).toBe(400)
    // A push service that is not allowed, or bad keys: refused with a code.
    const refused = await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions', headers: as('jean'), payload: { ...browser, endpoint: 'https://push.example.test/x' } })
    expect([refused.statusCode, refused.json().code]).toEqual([400, 'PUSH_SERVICE'])
    await app.close()
  })

  it('says notifications are not available without push on the Gateway or the provider, or without an extension', async () => {
    for (const opts of [{ withPush: false }, { push: false }]) {
      const { app, as } = await setup(opts)
      expect((await app.inject({ url: '/api/v1/me/push-subscriptions', headers: as('jean') })).json()).toEqual({ available: false, subscriptions: 0 })
      expect((await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions', headers: as('jean'), payload: service.subscribe() })).statusCode).toBe(501)
      await app.close()
    }
    const { app, as } = await setup()
    expect((await app.inject({ url: '/api/v1/me/push-subscriptions', headers: as('nobody') })).json()).toMatchObject({ available: false })
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions', headers: as('nobody'), payload: service.subscribe() })).statusCode).toBe(404)
    await app.close()
  })

  it('wakes the browsers of the person a call is held for, with the caller\'s directory name; a missed call follows if nobody answered', async () => {
    const { app, as, rec, bus } = await setup()
    const browser = service.subscribe()
    await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions', headers: as('jean'), payload: browser })
    const published: string[] = []
    bus.subscribe('A', 'jean', e => void published.push(e.type))
    const sent = Date.now()
    rec.emit('102', { type: 'call.wake', timestamp: new Date().toISOString(), payload: { call: call('w1', '101'), waitSec: 30 } })
    const wake = await service.next(browser.id)
    expect(wake.data).toEqual({ type: 'call', callId: 'w1', number: '101', name: 'Alice Martin', until: expect.any(Number) })
    expect(wake.data.until).toBeGreaterThanOrEqual(sent + 30_000)
    expect(wake.headers.ttl).toBe('30')
    // The wake is the push's alone: not an event of the app.
    expect(published).toEqual([])
    // Nobody woke in time: the call ends missed, and the notification says so.
    rec.emit('102', { type: 'call.ended', timestamp: new Date().toISOString(), payload: { call: call('w1', '101', 'missed') } })
    const missed = await service.next(browser.id)
    expect(missed.data).toEqual({ type: 'missed', callId: 'w1', number: '101', name: 'Alice Martin' })
    expect(Number(missed.headers.ttl)).toBeGreaterThan(3600)
    // A call woken for and answered: nothing more.
    rec.emit('102', { type: 'call.wake', timestamp: new Date().toISOString(), payload: { call: call('w2', '101'), waitSec: 20 } })
    await service.next(browser.id, m => m.data?.callId === 'w2')
    rec.emit('102', { type: 'call.ended', timestamp: new Date().toISOString(), payload: { call: call('w2', '101', 'ended') } })
    // A group's: its name with the caller's.
    rec.emit('102', { type: 'call.wake', timestamp: new Date().toISOString(), payload: { call: call('w3', '101'), waitSec: 30, group: '200' } })
    const group = await service.next(browser.id, m => m.data?.callId === 'w3')
    expect(group.data).toMatchObject({ group: { number: '200', name: 'Accueil' }, name: 'Alice Martin' })
    expect(service.messages.filter(m => m.id === browser.id).map(m => `${m.data.type}:${m.data.callId}`)).toEqual(['call:w1', 'missed:w1', 'call:w2', 'call:w3'])
    await app.close()
  })

  it('forgets a browser its push service says is gone, and tells the provider at once', async () => {
    const { app, as, store, rec } = await setup()
    const browser = service.subscribe()
    await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions', headers: as('jean'), payload: browser })
    expect(rec.wakeable.at(-1)).toBe('102=jean')
    service.gone(browser.id)
    rec.emit('102', { type: 'call.wake', timestamp: new Date().toISOString(), payload: { call: call('w9', '101'), waitSec: 30 } })
    await until('the subscription removed', async () => (await store.listPushUsers('A')).length === 0)
    await until('the provider told', () => rec.wakeable.at(-1) === '')
    await app.close()
  })
})
