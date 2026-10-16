import { createHash } from 'node:crypto'
import { LiveKitConferenceBridge, signToken, type Fetch } from '@twake/conference-livekit'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { RateLimiter } from './contacts.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import type { TelephonyEvent } from '@twake/telephony-types'

process.env.AUTH_MODE = 'dev'

/** A provider that serves the tenant `dev`; with `grants`, it lets rooms call (grantRoomCall) and records each grant. */
const providerOf = (grants?: { extension: string; number: string; token: string; revoked: boolean }[]) =>
  new ProviderRegistry([{ tenantId: 'dev', type: 'none', config: {} }], [
    {
      type: 'none',
      create: () =>
        ({
          getStatus: () => 'CONNECTED',
          getCapabilities: async () => ({ conference: { dialIn: false, dialOut: false } }),
          subscribe: async function* () {},
          close: async () => {},
          ...(grants
            ? {
                grantRoomCall: async ({ extension, number }: { extension: string; number: string }) => {
                  const g = { extension, number, token: String(grants.length).padStart(32, 'a'), revoked: false }
                  grants.push(g)
                  return { token: g.token, revoke: async () => void (g.revoked = true) }
                }
              }
            : {})
        }) as any
    }
  ])

/** The dispatch rules a fake LiveKit holds (shared by two Gateways in a test): created, listed with their PIN, deleted. */
const fakeRules = () => {
  const rules = new Map<string, { name: string; pin: string; trunk: string }>()
  let next = 0
  return {
    rules,
    add: (name: string, pin: string, trunk = 'T') => {
      const id = `R${++next}`
      rules.set(id, { name, pin, trunk })
      return id
    },
    /** The PINs of the rules of a room. */
    of: (room: string) => [...rules.values()].filter(r => r.name === `twake-meet-${room}`).map(r => r.pin)
  }
}

const setup = async ({
  fail,
  grants = true,
  dialOutLimiter,
  conferenceLimiter,
  conferenceReadLimiter,
  conferenceCaps,
  lk = fakeRules(),
  store = new MemoryStore(),
  random = (max: number) => Math.floor(max / 2)
}: {
  fail?: { status: number; body: unknown }
  grants?: boolean
  dialOutLimiter?: RateLimiter
  conferenceLimiter?: RateLimiter
  conferenceReadLimiter?: RateLimiter
  conferenceCaps?: { perPerson?: number; perTenant?: number }
  lk?: ReturnType<typeof fakeRules>
  store?: MemoryStore
  random?: (max: number) => number
} = {}) => {
  const calls: string[] = []
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/twirp/', '')
    calls.push(`${path} ${init.body}`)
    if (fail && path === 'livekit.SIP/CreateSIPParticipant') return { ok: false, status: fail.status, text: async () => JSON.stringify(fail.body) }
    const body = JSON.parse(init.body ?? '{}')
    let created: string | undefined
    if (path === 'livekit.SIP/CreateSIPDispatchRule') created = lk.add(body.dispatch_rule.name, body.dispatch_rule.rule.dispatch_rule_direct.pin, body.dispatch_rule.trunk_ids[0])
    if (path === 'livekit.SIP/DeleteSIPDispatchRule') lk.rules.delete(body.sip_dispatch_rule_id)
    const out: Record<string, unknown> = {
      'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'T', name: 'twake-meet-in' }] },
      'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: created },
      'livekit.SIP/ListSIPDispatchRule': {
        items: [...lk.rules].map(([id, r]) => ({ sip_dispatch_rule_id: id, name: r.name, trunk_ids: [r.trunk], rule: { dispatch_rule_direct: { room_name: r.name.slice(11), pin: r.pin } } }))
      },
      'livekit.SIP/CreateSIPOutboundTrunk': { sip_trunk_id: 'O' },
      'livekit.RoomService/ListParticipants': { participants: [{ identity: 'web1', name: 'Bob' }] }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out[path] ?? {}) }
  }
  const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch }, random)
  const bus = new EventBus()
  // Alice holds an extension (a room calls at her name); Bob does not.
  await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101' })
  const granted: { extension: string; number: string; token: string; revoked: boolean }[] = []
  const app = await buildApp(providerOf(grants ? granted : undefined), {
    bus,
    store,
    ...(dialOutLimiter ? { dialOutLimiter } : {}),
    ...(conferenceLimiter ? { conferenceLimiter } : {}),
    ...(conferenceReadLimiter ? { conferenceReadLimiter } : {}),
    ...(conferenceCaps ? { conferenceCaps } : {}),
    conference: { bridge: t => (t === 'off' ? undefined : bridge), accessNumber: '8000', webhookKey: 'k', webhookSecret: 's' }
  })
  const as = (user: string, tenant = 'dev') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
  /** Alice's room, named by the Gateway. */
  const open = async (user = 'alice') => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as(user), payload: { create: true } })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().meetingId as string
  }
  return { app, calls, bus, as, open, granted, lk, store, bridge }
}
const sentOf = (calls: string[], path: string) => calls.filter(c => c.startsWith(path)).map(c => JSON.parse(c.split(' ').slice(1).join(' ')))

describe('conference endpoints', () => {
  it('names a room itself and returns the dial-in info with a PIN; the owner reopens it with the same PIN', async () => {
    const { app, as, calls } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { create: true } })
    expect(res.statusCode).toBe(201)
    const { meetingId } = res.json()
    expect(meetingId).toMatch(/^twake-[0-9a-f]{16}$/)
    expect(res.json()).toEqual({ meetingId, dialIn: { numbers: [{ country: 'FR', e164: '8000' }], meetingCode: meetingId, pin: '5000000000' } })
    // Reopened, the same PIN instead of another one; its rule made again if LiveKit lost it.
    const again = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId } })
    expect(again.statusCode).toBe(201)
    expect(again.json().dialIn.pin).toBe('5000000000')
    expect(sentOf(calls, 'livekit.SIP/CreateSIPDispatchRule')).toHaveLength(1)
    // A second room has a name of its own.
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { create: true } })).json().meetingId).not.toBe(meetingId)
  })

  it('opens a new room only when asked (create), past the rooms a person may open 429; reopening one is no new room (second review n°4)', async () => {
    const { app, as, calls, open } = await setup({ conferenceLimiter: new RateLimiter(2, 60_000) })
    for (const payload of [{}, { slug: 'abc-defg-hij' }, { create: 'yes' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(calls.some(c => c.startsWith('livekit.SIP/CreateSIPDispatchRule'))).toBe(false)
    const room = await open()
    await open()
    const third = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { create: true } })
    expect(`${third.statusCode} ${third.json().code}`).toBe('429 CONFERENCE_LIMIT')
    expect(sentOf(calls, 'livekit.SIP/CreateSIPDispatchRule')).toHaveLength(2)
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: room } })).statusCode).toBe(201)
    // Each person their own count.
    await open('bob')
  })

  it('draws again the PIN of a room opened before the PINs had PIN_DIGITS digits, its old rule removed (second review n°6)', async () => {
    const { app, as, calls, store, lk } = await setup()
    const room = 'twake-0123456789abcdef'
    await store.claimConference({ tenantId: 'dev', meetingId: room, ownerUserId: 'alice', createdAt: '2026-10-01T00:00:00.000Z' })
    await store.setConferencePin(room, '123456')
    lk.add(`twake-meet-${room}`, '123456')
    const res = await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('alice') })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().dialIn.pin).toMatch(/^\d{10}$/)
    expect((await store.getConference(room))?.pin).toBe(res.json().dialIn.pin)
    expect(sentOf(calls, 'livekit.SIP/DeleteSIPDispatchRule')).toHaveLength(1)
    expect(sentOf(calls, 'livekit.SIP/CreateSIPDispatchRule').map(r => r.dispatch_rule.rule.dispatch_rule_direct.pin)).toEqual([res.json().dialIn.pin])
    // Reopened, the PIN drawn again is kept.
    const again = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: room } })
    expect(again.json().dialIn.pin).toBe(res.json().dialIn.pin)
    expect(sentOf(calls, 'livekit.SIP/CreateSIPDispatchRule')).toHaveLength(1)
  })

  it('reads of a room at once, on one Gateway or two, leave it one rule and show one PIN; a rule with another PIN is replaced (third review n°5)', async () => {
    const room = 'twake-0123456789abcdef'
    const lk = fakeRules()
    const store = new MemoryStore()
    let a = 0
    let b = 0
    const one = await setup({ lk, store, random: max => (1_000_000_000 + ++a) % max })
    const two = await setup({ lk, store, random: max => (2_000_000_000 + ++b) % max })
    await store.claimConference({ tenantId: 'dev', meetingId: room, ownerUserId: 'alice', createdAt: '2026-10-01T00:00:00.000Z' })
    await store.setConferencePin(room, '123456')
    lk.add(`twake-meet-${room}`, '123456')
    const read = (app: typeof one.app) => app.inject({ url: `/api/v1/conferences/${room}`, headers: one.as('alice') })
    const reads = await Promise.all([read(one.app), read(one.app), read(two.app), read(one.app), read(two.app), read(two.app)])
    expect(reads.map(r => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200])
    const shown = new Set(reads.map(r => r.json().dialIn.pin))
    expect(shown.size).toBe(1)
    const [pin] = [...shown]
    expect(pin).toMatch(/^\d{10}$/)
    expect((await store.getConference(room))?.pin).toBe(pin)
    expect(lk.of(room)).toEqual([pin])
    // One draw at a time per room on a Gateway.
    expect(sentOf(one.calls, 'livekit.SIP/CreateSIPDispatchRule').length + sentOf(two.calls, 'livekit.SIP/CreateSIPDispatchRule').length).toBeLessThanOrEqual(2)
    // The rule LiveKit has with another PIN than the one shown (left by a race, made by hand) is replaced at the next check.
    const fresh = await setup({ lk, store })
    for (const id of [...lk.rules.keys()]) lk.rules.delete(id)
    lk.add(`twake-meet-${room}`, '9999999999')
    expect((await read(fresh.app)).json().dialIn.pin).toBe(pin)
    expect(lk.of(room)).toEqual([pin])
    // Closed, the room loses every rule of its own.
    lk.add(`twake-meet-${room}`, '8888888888')
    expect((await fresh.app.inject({ method: 'DELETE', url: `/api/v1/conferences/${room}`, headers: one.as('alice') })).statusCode).toBe(204)
    expect(lk.of(room)).toEqual([])
  })

  it('reads a room again without asking LiveKit each time, at most 60 a minute per person (third review n°6, n°7)', async () => {
    const { app, as, calls, open } = await setup({ conferenceReadLimiter: new RateLimiter(3, 60_000) })
    const room = await open()
    const listed = () => calls.filter(c => c.startsWith('livekit.SIP/List')).length
    const before = listed()
    for (let i = 0; i < 3; i++) expect((await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('alice') })).statusCode).toBe(200)
    expect(listed()).toBe(before)
    const late = await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('alice') })
    expect(`${late.statusCode} ${late.json().code}`).toBe('429 CONFERENCE_READ_LIMIT')
    // Each person their own count.
    expect((await app.inject({ url: `/api/v1/conferences/${await open('bob')}`, headers: as('bob') })).statusCode).toBe(200)
  })

  it('bounds the rooms open at once, per person and per tenant, in the database (third review n°6)', async () => {
    const { app, as, open } = await setup({ conferenceCaps: { perPerson: 2, perTenant: 3 } })
    const create = (user: string) => app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as(user), payload: { create: true } })
    const first = await open()
    await open()
    expect(`${(await create('alice')).statusCode} ${(await create('alice')).json().code}`).toBe('429 CONFERENCE_LIMIT')
    await open('bob')
    expect((await create('carol')).statusCode).toBe(429)
    // A room closed makes room for another.
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${first}`, headers: as('alice') })).statusCode).toBe(204)
    await open('carol')
  })

  it('without Meet, serves no room it did not name (claimed by its name before), except to close it (second review n°6)', async () => {
    const { app, as, calls, store } = await setup()
    const room = 'abc-defg-hij'
    await store.claimConference({ tenantId: 'dev', meetingId: room, ownerUserId: 'alice', createdAt: '2026-10-01T00:00:00.000Z' })
    await store.setConferencePin(room, '1234567890')
    expect((await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('alice') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: room } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '103' } })).statusCode).toBe(404)
    expect(calls.some(c => c.startsWith('livekit.SIP/CreateSIPParticipant') || c.startsWith('livekit.SIP/CreateSIPDispatchRule'))).toBe(false)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${room}`, headers: as('alice') })).statusCode).toBe(204)
    expect(await store.getConference(room)).toBeNull()
  })

  it('never takes over a LiveKit room it did not name: a meeting id nobody opened here is not found (review n°6)', async () => {
    const { app, as, calls } = await setup()
    for (const meetingId of ['abc-defg-hij', 'fe15dd04-262c-48d6-83de-d82ab167deb3']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId } })
      expect(res.statusCode, meetingId).toBe(404)
    }
    expect(calls.some(c => c.startsWith('livekit.SIP/CreateSIPDispatchRule'))).toBe(false)
  })

  it('validates meeting ids', async () => {
    const { app, as } = await setup()
    for (const meetingId of ['', 'a', '../x', 'a b c', 'x'.repeat(80)]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId } })
      expect(res.statusCode, meetingId).toBe(400)
    }
  })

  it('refuses a room claimed by someone else and hides it from other tenants', async () => {
    const { app, as, open } = await setup()
    const room = await open()
    const steal = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('bob'), payload: { meetingId: room } })
    expect(steal.statusCode).toBe(409)
    expect((await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('eve', 'other') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('eve', 'other'), payload: { meetingId: room } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('bob'), payload: { number: '+33612345678' } })).statusCode).toBe(403)
  })

  it('lists participants, dials out, mutes and removes only inside the room', async () => {
    const { app, as, calls, open } = await setup()
    const room = await open()
    const read = await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('alice') })
    expect(read.json().participants).toMatchObject([{ id: `${room}:web1`, kind: 'web' }])

    const dial = await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '+33612345678' } })
    expect(dial.statusCode).toBe(201)
    expect(dial.json()).toMatchObject({ kind: 'phone', number: '+33612345678' })
    // At her name: her extension is the From the SIP server reads, and the call is waited for.
    expect(sentOf(calls, 'livekit.SIP/CreateSIPParticipant')[0]).toMatchObject({ sip_call_to: '+33612345678', sip_number: '101', room_name: room, wait_until_answered: true })

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${room}/participants/${room}:web1`, headers: as('alice') })).statusCode).toBe(204)
    expect(calls.some(c => c.startsWith('livekit.RoomService/RemoveParticipant') && c.includes(`"room":"${room}"`))).toBe(true)
    // A participant of another room cannot be reached through this room.
    const foreign = await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${room}/participants/room-2:web1`, headers: as('alice') })
    expect(foreign.statusCode).toBe(400)
    const muteForeign = await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants/room-2:web1/mute`, headers: as('alice') })
    expect(muteForeign.statusCode).toBe(400)
  })

  it('has the SIP server grant each call of a room, for her extension and that number, before LiveKit is asked; withdrawn when the call fails (review n°1)', async () => {
    const { app, as, calls, open, granted } = await setup()
    const room = await open()
    const dial = await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: ' 0199000024 ' } })
    expect(dial.statusCode).toBe(201)
    expect(granted).toEqual([{ extension: '101', number: '0199000024', token: granted[0]!.token, revoked: false }])
    expect(sentOf(calls, 'livekit.SIP/CreateSIPParticipant')[0]).toMatchObject({ sip_call_to: '0199000024', sip_number: '101', headers: { 'X-Twake-Grant': granted[0]!.token } })
    // A number that is none: neither granted nor asked for.
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: 'abc; DROP' } })).statusCode).toBe(400)
    expect(granted).toHaveLength(1)
    const failing = await setup({ fail: { status: 403, body: { code: 'permission_denied', msg: 'sip status 403: Not Granted', meta: { sip_status_code: '403', sip_status: 'Not Granted' } } } })
    const other = await failing.open()
    await failing.app.inject({ method: 'POST', url: `/api/v1/conferences/${other}/participants`, headers: as('alice'), payload: { number: '103' } })
    expect(failing.granted.map(g => g.revoked)).toEqual([true])
  })

  it('places no call of a room when the SIP server cannot grant it (501)', async () => {
    const { app, as, calls, open } = await setup({ grants: false })
    const room = await open()
    const dial = await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '103' } })
    expect(dial.statusCode).toBe(501)
    expect(calls.some(c => c.startsWith('livekit.SIP/CreateSIPParticipant'))).toBe(false)
  })

  it('bounds the calls a person\'s rooms place: 429 past the limit, nothing granted nor asked (review n°13)', async () => {
    const { app, as, calls, open, granted } = await setup({ dialOutLimiter: new RateLimiter(2, 60_000) })
    const room = await open()
    const codes: number[] = []
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '103' } })).statusCode)
    expect(codes).toEqual([201, 201, 429])
    expect(granted).toHaveLength(2)
    expect(sentOf(calls, 'livekit.SIP/CreateSIPParticipant')).toHaveLength(2)
  })

  it('refuses a dial-out to an owner without an extension', async () => {
    const { app, as, calls, open } = await setup()
    const room = await open('bob')
    const dial = await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('bob'), payload: { number: '+33612345678' } })
    expect(dial.statusCode).toBe(403)
    expect(dial.json().code).toBe('NO_EXTENSION')
    expect(calls.some(c => c.startsWith('livekit.SIP/CreateSIPParticipant'))).toBe(false)
  })

  it('says why a dial-out did not go through, with the SIP status', async () => {
    const { app, as, open } = await setup({ fail: { status: 403, body: { code: 'permission_denied', msg: 'sip status 403: Destination Not Allowed', meta: { sip_status_code: '403', sip_status: 'Destination Not Allowed' } } } })
    const room = await open()
    const dial = await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '0899000000' } })
    expect(dial.statusCode).toBe(409)
    expect(dial.json()).toMatchObject({ code: 'DIAL_FAILED', sipStatus: 403, sipReason: 'Destination Not Allowed' })
  })

  it('answers 409 DIAL_FAILED 480 when nobody answered in time, and 502 without LiveKit\'s words when LiveKit refuses the Gateway (review n°4)', async () => {
    const noAnswer = await setup({ fail: { status: 408, body: { code: 'canceled', msg: 'sip request timed out' } } })
    const room = await noAnswer.open()
    const dial = await noAnswer.app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: noAnswer.as('alice'), payload: { number: '103' } })
    expect(`${dial.statusCode} ${dial.json().code} ${dial.json().sipStatus}`).toBe('409 DIAL_FAILED 480')
    const refused = await setup({ fail: { status: 401, body: { code: 'unauthenticated', msg: 'invalid token: signature is invalid' } } })
    const other = await refused.open()
    const res = await refused.app.inject({ method: 'POST', url: `/api/v1/conferences/${other}/participants`, headers: refused.as('alice'), payload: { number: '103' } })
    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('CONFERENCE_UNAVAILABLE')
    expect(res.body).not.toMatch(/LiveKit|signature|token/i)
  })

  it('removes the dial-in when the meeting is deleted', async () => {
    const { app, as, calls, open } = await setup()
    const room = await open()
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${room}`, headers: as('alice') })).statusCode).toBe(204)
    expect(calls.some(c => c.startsWith('livekit.SIP/DeleteSIPDispatchRule'))).toBe(true)
    expect((await app.inject({ url: `/api/v1/conferences/${room}`, headers: as('alice') })).statusCode).toBe(404)
  })

  it('answers 501 when no bridge is configured for the tenant, and reports it in capabilities', async () => {
    const { app, as } = await setup()
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice', 'off'), payload: { create: true } })).statusCode).toBe(501)
    const caps = await app.inject({ url: '/api/v1/capabilities', headers: as('alice') })
    expect(caps.json().conference).toEqual({ dialIn: true, dialOut: true })
  })
})

describe('livekit webhook', () => {
  const post = (app: Awaited<ReturnType<typeof setup>>['app'], body: string, token?: string) =>
    app.inject({ method: 'POST', url: '/api/v1/webhooks/livekit', headers: { 'content-type': 'application/webhook+json', ...(token ? { authorization: token } : {}) }, payload: body })

  it('rejects unsigned or tampered webhooks', async () => {
    const { app } = await setup()
    const body = JSON.stringify({ event: 'participant_joined', room: { name: 'room-1' }, participant: { identity: 'x' } })
    expect((await post(app, body)).statusCode).toBe(401)
    const token = signToken('k', 's', { sha256: createHash('sha256').update(body).digest('base64') })
    expect((await post(app, body + ' ', token)).statusCode).toBe(401)
  })

  it('forwards participant events to the owner only', async () => {
    const { app, bus, open } = await setup()
    const room = await open()
    const alice: TelephonyEvent[] = []
    const bob: TelephonyEvent[] = []
    bus.subscribe('dev', 'alice', e => alice.push(e))
    bus.subscribe('dev', 'bob', e => bob.push(e))
    const body = JSON.stringify({ event: 'participant_joined', room: { name: room }, participant: { identity: 'sip_1', name: 'Phone', kind: 3, attributes: { 'sip.phoneNumber': '+33611111111' } } })
    const token = signToken('k', 's', { sha256: createHash('sha256').update(body).digest('base64') })
    expect((await post(app, body, token)).statusCode).toBe(204)
    expect(alice).toHaveLength(1)
    expect(alice[0]).toMatchObject({ type: 'conference.participant.joined', payload: { participant: { kind: 'phone', meetingId: room } } })
    expect(bob).toEqual([])
  })
})

describe('conference endpoints with Meet', () => {
  const meetRoom = { id: 'fe15dd04-262c-48d6-83de-d82ab167deb3', slug: 'abc-defg-hij', name: 'abc-defg-hij', url: 'https://meet.twake.local/abc-defg-hij', telephony: { enabled: true, phoneNumber: '8000', pinCode: '5188455902', defaultCountry: 'FR' } }

  const setupMeet = async () => {
    const base = await setup()
    const access = new Map<string, boolean>([['alice@twake.local', true]])
    const asked: string[] = []
    const meet = {
      createRoom: async (email: string) => (asked.push(`create ${email}`), meetRoom),
      findRoom: async (email: string, by: { slug?: string; id?: string }) => {
        asked.push(`find ${email} ${by.slug ?? by.id}`)
        const known = by.slug === meetRoom.slug || by.id === meetRoom.id
        return known && access.get(email) ? meetRoom : null
      }
    }
    const lkCalls: string[] = []
    const fetch: Fetch = async url => {
      lkCalls.push(new URL(url).pathname.replace('/twirp/', ''))
      return { ok: true, status: 200, text: async () => JSON.stringify(new URL(url).pathname.endsWith('ListParticipants') ? { participants: [] } : {}) }
    }
    const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch })
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101' })
    const app = await buildApp(providerOf([]), {
      bus: new EventBus(),
      store,
      conference: { bridge: () => bridge, meet: meet as any, webhookKey: 'k', webhookSecret: 's' }
    })
    return { ...base, app, access, asked, lkCalls }
  }
  const alice = { 'x-dev-user': 'alice', 'x-dev-tenant': 'dev' }

  it('adopts an existing Meet room by slug and shows Meet’s number and PIN, without touching LiveKit rules', async () => {
    const { app, lkCalls } = await setupMeet()
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: alice, payload: { slug: 'abc-defg-hij' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ meetingId: meetRoom.id, slug: 'abc-defg-hij', url: meetRoom.url, dialIn: { numbers: [{ country: 'FR', e164: '8000' }], meetingCode: 'abc-defg-hij', pin: '5188455902' } })
    expect(lkCalls.filter(c => c.includes('DispatchRule'))).toEqual([])
  })

  it('creates a new Meet room for the user when asked', async () => {
    const { app, asked } = await setupMeet()
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: alice, payload: { create: true } })
    expect(res.statusCode).toBe(201)
    expect(res.json().slug).toBe('abc-defg-hij')
    expect(asked).toContain('create alice@twake.local')
  })

  it('answers 404 for a room Meet does not show to that user, and never adopts it', async () => {
    const { app } = await setupMeet()
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: { 'x-dev-user': 'mallory', 'x-dev-tenant': 'dev' }, payload: { slug: 'abc-defg-hij' } })
    expect(res.statusCode).toBe(404)
    expect((await app.inject({ url: `/api/v1/conferences/${meetRoom.id}`, headers: { 'x-dev-user': 'mallory', 'x-dev-tenant': 'dev' } })).statusCode).toBe(404)
  })

  it('stops serving a room when Meet revokes the access of its owner', async () => {
    const { app, access } = await setupMeet()
    await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: alice, payload: { slug: 'abc-defg-hij' } })
    expect((await app.inject({ url: `/api/v1/conferences/${meetRoom.id}`, headers: alice })).statusCode).toBe(200)
    access.set('alice@twake.local', false)
    expect((await app.inject({ url: `/api/v1/conferences/${meetRoom.id}`, headers: alice })).statusCode).toBe(404)
    const dial = await app.inject({ method: 'POST', url: `/api/v1/conferences/${meetRoom.id}/participants`, headers: alice, payload: { number: '+33612345678' } })
    expect(dial.statusCode).toBe(404)
  })

  it('dials out into the LiveKit room named by the Meet room id', async () => {
    const { app, lkCalls } = await setupMeet()
    await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: alice, payload: { slug: 'abc-defg-hij' } })
    const dial = await app.inject({ method: 'POST', url: `/api/v1/conferences/${meetRoom.id}/participants`, headers: alice, payload: { number: 'not a number' } })
    expect(dial.statusCode).toBe(400)
    const ok = await app.inject({ method: 'POST', url: `/api/v1/conferences/${meetRoom.id}/participants`, headers: alice, payload: { number: '+33612345678' } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().meetingId).toBe(meetRoom.id)
    expect(lkCalls).toContain('livekit.SIP/CreateSIPParticipant')
  })

  it('leaves Meet’s dial-in rules alone when the panel is closed', async () => {
    const { app, lkCalls } = await setupMeet()
    await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: alice, payload: { slug: 'abc-defg-hij' } })
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${meetRoom.id}`, headers: alice })).statusCode).toBe(204)
    expect(lkCalls.some(c => c.includes('DeleteSIPDispatchRule'))).toBe(false)
  })
})
