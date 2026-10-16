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

const setup = async ({ fail, grants = true, dialOutLimiter }: { fail?: { status: number; body: unknown }; grants?: boolean; dialOutLimiter?: RateLimiter } = {}) => {
  const calls: string[] = []
  const rules = new Set<string>()
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/twirp/', '')
    calls.push(`${path} ${init.body}`)
    if (fail && path === 'livekit.SIP/CreateSIPParticipant') return { ok: false, status: fail.status, text: async () => JSON.stringify(fail.body) }
    if (path === 'livekit.SIP/CreateSIPDispatchRule') rules.add(JSON.parse(init.body ?? '{}').dispatch_rule.name)
    const out: Record<string, unknown> = {
      'livekit.SIP/CreateSIPInboundTrunk': { sip_trunk_id: 'T' },
      'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R' },
      'livekit.SIP/ListSIPDispatchRule': { items: [...rules].map(name => ({ sip_dispatch_rule_id: 'R', name, trunk_ids: ['T'] })) },
      'livekit.SIP/CreateSIPOutboundTrunk': { sip_trunk_id: 'O' },
      'livekit.RoomService/ListParticipants': { participants: [{ identity: 'web1', name: 'Bob' }] }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out[path] ?? {}) }
  }
  const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch }, max => Math.floor(max / 2))
  const bus = new EventBus()
  // Alice holds an extension (a room calls at her name); Bob does not.
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101' })
  const granted: { extension: string; number: string; token: string; revoked: boolean }[] = []
  const app = await buildApp(providerOf(grants ? granted : undefined), {
    bus,
    store,
    ...(dialOutLimiter ? { dialOutLimiter } : {}),
    conference: { bridge: t => (t === 'off' ? undefined : bridge), accessNumber: '8000', webhookKey: 'k', webhookSecret: 's' }
  })
  const as = (user: string, tenant = 'dev') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
  /** Alice's room, named by the Gateway. */
  const open = async (user = 'alice') => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as(user), payload: {} })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().meetingId as string
  }
  return { app, calls, bus, as, open, granted, rules }
}
const sentOf = (calls: string[], path: string) => calls.filter(c => c.startsWith(path)).map(c => JSON.parse(c.split(' ').slice(1).join(' ')))

describe('conference endpoints', () => {
  it('names a room itself and returns the dial-in info with a PIN; the owner reopens it with the same PIN', async () => {
    const { app, as, calls } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: {} })
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
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: {} })).json().meetingId).not.toBe(meetingId)
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
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice', 'off'), payload: {} })).statusCode).toBe(501)
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
