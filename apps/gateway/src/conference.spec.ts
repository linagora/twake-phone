import { createHash } from 'node:crypto'
import { LiveKitConferenceBridge, signToken, type Fetch } from '@twake/conference-livekit'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import type { TelephonyEvent } from '@twake/telephony-types'

process.env.AUTH_MODE = 'dev'

const setup = async () => {
  const calls: string[] = []
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/twirp/', '')
    calls.push(`${path} ${init.body}`)
    const out: Record<string, unknown> = {
      'livekit.SIP/CreateSIPInboundTrunk': { sip_trunk_id: 'T' },
      'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R' },
      'livekit.SIP/CreateSIPOutboundTrunk': { sip_trunk_id: 'O' },
      'livekit.RoomService/ListParticipants': { participants: [{ identity: 'web1', name: 'Bob' }] }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out[path] ?? {}) }
  }
  const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], outboundAddress: 'pbx:5060', fetch }, () => 0.5)
  const bus = new EventBus()
  const app = await buildApp(new ProviderRegistry([{ tenantId: 'dev', type: 'none', config: {} }], [{ type: 'none', create: () => ({ getStatus: () => 'CONNECTED', getCapabilities: async () => ({ conference: { dialIn: false, dialOut: false } }) as any, subscribe: async function* () {}, close: async () => {} }) as any }]), {
    bus,
    store: new MemoryStore(),
    conference: { bridge: t => (t === 'off' ? undefined : bridge), webhookKey: 'k', webhookSecret: 's' }
  })
  const as = (user: string, tenant = 'dev') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
  return { app, calls, bus, as }
}

describe('conference endpoints', () => {
  it('lets a user claim a room and returns the dial-in info with a PIN', async () => {
    const { app, as } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: 'abc-defg-hij' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ meetingId: 'abc-defg-hij', dialIn: { numbers: [{ country: 'FR', e164: '8000' }], meetingCode: 'abc-defg-hij', pin: '500000' } })
    // Claiming again returns the same PIN instead of rotating it.
    const again = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: 'abc-defg-hij' } })
    expect(again.json().dialIn.pin).toBe('500000')
  })

  it('validates meeting ids', async () => {
    const { app, as } = await setup()
    for (const meetingId of ['', 'a', '../x', 'a b c', 'x'.repeat(80)]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId } })
      expect(res.statusCode, meetingId).toBe(400)
    }
  })

  it('refuses a room claimed by someone else and hides it from other tenants', async () => {
    const { app, as } = await setup()
    await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: 'room-1' } })
    const steal = await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('bob'), payload: { meetingId: 'room-1' } })
    expect(steal.statusCode).toBe(409)
    expect((await app.inject({ url: '/api/v1/conferences/room-1', headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/conferences/room-1', headers: as('eve', 'other') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences/room-1/participants', headers: as('bob'), payload: { number: '+33612345678' } })).statusCode).toBe(403)
  })

  it('lists participants, dials out, mutes and removes only inside the room', async () => {
    const { app, as, calls } = await setup()
    await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: 'room-1' } })
    const room = await app.inject({ url: '/api/v1/conferences/room-1', headers: as('alice') })
    expect(room.json().participants).toMatchObject([{ id: 'room-1:web1', kind: 'web' }])

    const dial = await app.inject({ method: 'POST', url: '/api/v1/conferences/room-1/participants', headers: as('alice'), payload: { number: '+33612345678' } })
    expect(dial.statusCode).toBe(202)
    expect(dial.json()).toMatchObject({ kind: 'phone', number: '+33612345678' })

    expect((await app.inject({ method: 'DELETE', url: '/api/v1/conferences/room-1/participants/room-1:web1', headers: as('alice') })).statusCode).toBe(204)
    expect(calls.some(c => c.startsWith('livekit.RoomService/RemoveParticipant') && c.includes('"room":"room-1"'))).toBe(true)
    // A participant of another room cannot be reached through this room.
    const foreign = await app.inject({ method: 'DELETE', url: '/api/v1/conferences/room-1/participants/room-2:web1', headers: as('alice') })
    expect(foreign.statusCode).toBe(400)
    const muteForeign = await app.inject({ method: 'POST', url: '/api/v1/conferences/room-1/participants/room-2:web1/mute', headers: as('alice') })
    expect(muteForeign.statusCode).toBe(400)
  })

  it('removes the dial-in when the meeting is deleted', async () => {
    const { app, as, calls } = await setup()
    await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: 'room-1' } })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/conferences/room-1', headers: as('alice') })).statusCode).toBe(204)
    expect(calls.some(c => c.startsWith('livekit.SIP/DeleteSIPDispatchRule'))).toBe(true)
    expect((await app.inject({ url: '/api/v1/conferences/room-1', headers: as('alice') })).statusCode).toBe(404)
  })

  it('answers 501 when no bridge is configured for the tenant, and reports it in capabilities', async () => {
    const { app, as } = await setup()
    expect((await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice', 'off'), payload: { meetingId: 'room-1' } })).statusCode).toBe(501)
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
    const { app, as, bus } = await setup()
    await app.inject({ method: 'POST', url: '/api/v1/conferences', headers: as('alice'), payload: { meetingId: 'room-1' } })
    const alice: TelephonyEvent[] = []
    const bob: TelephonyEvent[] = []
    bus.subscribe('dev', 'alice', e => alice.push(e))
    bus.subscribe('dev', 'bob', e => bob.push(e))
    const body = JSON.stringify({ event: 'participant_joined', room: { name: 'room-1' }, participant: { identity: 'sip_1', name: 'Phone', kind: 3, attributes: { 'sip.phoneNumber': '+33611111111' } } })
    const token = signToken('k', 's', { sha256: createHash('sha256').update(body).digest('base64') })
    expect((await post(app, body, token)).statusCode).toBe(204)
    expect(alice).toHaveLength(1)
    expect(alice[0]).toMatchObject({ type: 'conference.participant.joined', payload: { participant: { kind: 'phone', meetingId: 'room-1' } } })
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
    const fetch: Fetch = async (url, init) => {
      lkCalls.push(new URL(url).pathname.replace('/twirp/', ''))
      return { ok: true, status: 200, text: async () => JSON.stringify(new URL(url).pathname.endsWith('ListParticipants') ? { participants: [] } : {}) }
    }
    const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], outboundAddress: 'pbx:5060', fetch })
    const app = await buildApp(new ProviderRegistry([{ tenantId: 'dev', type: 'none', config: {} }], [{ type: 'none', create: () => ({ getStatus: () => 'CONNECTED', getCapabilities: async () => ({}) as any, subscribe: async function* () {}, close: async () => {} }) as any }]), {
      bus: new EventBus(),
      store: new MemoryStore(),
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
    expect(ok.statusCode).toBe(202)
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
