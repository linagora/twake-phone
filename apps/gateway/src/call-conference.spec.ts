import { LiveKitConferenceBridge, type Fetch } from '@twake/conference-livekit'
import type { CallParties, ProviderFactory, RoomCallGrant, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Call, TelephonyEvent } from '@twake/telephony-types'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { RateLimiter } from './contacts.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'

process.env.AUTH_MODE = 'dev'

const call = (id: string): Call => ({ id, direction: 'outbound', state: 'connected', remoteNumber: '102' })
const JOIN = '0123456789abcdef'.repeat(2)

/**
 * Alice (101) is in calls the SIP server reports to her: `c1` with Bob (102), which she placed; `c2`, which Bob placed;
 * `ext`, with the operator; `ringing`, not answered. Bob (102) is in `bob`, of his own.
 */
const setup = async ({ failFor, dialOutLimiter, conferenceCaps }: { failFor?: string; dialOutLimiter?: RateLimiter; conferenceCaps?: { perPerson?: number } } = {}) => {
  const grants: (RoomCallGrant & { token: string; revoked: boolean })[] = []
  const parties: Record<string, CallParties | 'external'> = {
    c1: { callId: 'c1', caller: '101', callerTag: 'a-tag', callee: '102', calleeTag: 'b-tag' },
    c2: { callId: 'c2', caller: '102', callerTag: 'b-tag', callee: '101', calleeTag: 'a-tag' },
    ext: 'external',
    bob: { callId: 'bob', caller: '102', callerTag: 'x', callee: '103', calleeTag: 'y' }
  }
  const events: { extension: string; event: TelephonyEvent }[] = [
    ...['c1', 'c2', 'ext', 'ringing'].map(id => ({ extension: '101', event: { type: 'call.connected' as const, timestamp: new Date().toISOString(), payload: { call: call(id) } } })),
    { extension: '102', event: { type: 'call.connected', timestamp: new Date().toISOString(), payload: { call: call('bob') } } }
  ]
  const factory: ProviderFactory<unknown> = {
    type: 'fake',
    create: () =>
      ({
        getStatus: () => 'CONNECTED',
        getCapabilities: async () => ({ conference: { dialIn: false, dialOut: true } }) as never,
        subscribe: async function* () {
          for (const e of events) yield e
        },
        grantRoomCall: async (g: RoomCallGrant) => {
          const kept = { ...g, token: String(grants.length).padStart(32, 'c'), revoked: false }
          grants.push(kept)
          return { token: kept.token, revoke: async () => void (kept.revoked = true) }
        },
        callBetweenExtensions: async (id: string) => parties[id],
        close: async () => {}
      }) as unknown as TelephonyProvider
  }
  const lk: string[] = []
  const rooms = new Set<string>()
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/twirp/', '')
    const body = JSON.parse(init.body ?? '{}')
    lk.push(`${path} ${JSON.stringify(body)}`)
    if (path === 'livekit.SIP/CreateSIPParticipant') {
      if (body.sip_call_to === failFor) return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'unavailable', msg: 'sip status: 486: Busy Here', meta: { sip_status_code: '486', sip_status: 'Busy Here' } }) }
      rooms.add(body.room_name)
    }
    if (path === 'livekit.RoomService/DeleteRoom') rooms.delete(body.room)
    const out: Record<string, unknown> = {
      'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] },
      'livekit.RoomService/ListRooms': { rooms: [...rooms].filter(r => (body.names ?? []).includes(r)).map(name => ({ name })) },
      'livekit.RoomService/ListParticipants': { participants: [{ identity: 'phone-101-x', attributes: { 'twake.kind': 'phone', 'twake.number': '101' } }, { identity: 'phone-102-y', attributes: { 'twake.kind': 'phone', 'twake.number': '102' } }] }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out[path] ?? {}) }
  }
  const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch }, max => Math.floor(max / 3))
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'bob', extension: '102' })
  const registry = new ProviderRegistry([{ tenantId: 'dev', type: 'fake', config: {} }], [factory])
  const app = await buildApp(registry, {
    store,
    ...(dialOutLimiter ? { dialOutLimiter } : {}),
    ...(conferenceCaps ? { conferenceCaps } : {}),
    conference: { bridge: () => bridge, accessNumber: '8000', webhookKey: 'k', webhookSecret: 's' }
  })
  registry.startAll()
  await new Promise(r => setTimeout(r, 50)) // the event pump records whose calls they are
  const as = (user: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'dev' })
  const conference = (id: string, user = 'alice', payload: unknown = { join: JOIN }) => app.inject({ method: 'POST', url: `/api/v1/calls/${id}/conference`, headers: as(user), payload: payload as object })
  const dialled = () => lk.filter(l => l.startsWith('livekit.SIP/CreateSIPParticipant')).map(l => JSON.parse(l.slice(l.indexOf(' ') + 1)))
  return { app, as, conference, grants, lk, dialled, rooms, store }
}

describe('a call becomes a conference (POST /calls/:id/conference, step 8b)', () => {
  it("has the room call the person's window (join), then the other party in the place of the call (Replaces, the tags as OpenSIPS holds them), both at the person's name through a grant each", async () => {
    const { conference, grants, dialled, store, app, as, lk, rooms } = await setup()
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(201)
    const { meetingId, participants } = res.json()
    expect(meetingId).toMatch(/^twake-call-[0-9a-f]{16}$/)
    expect(participants.map((p: { number: string }) => p.number)).toEqual(['101', '102'])
    // Alice first (her window draws the token), then Bob, his own tag (the callee's) as the To tag.
    expect(grants.map(({ extension, number, join, replaces }) => ({ extension, number, join, replaces }))).toEqual([
      { extension: '101', number: '101', join: JOIN, replaces: undefined },
      { extension: '101', number: '102', join: undefined, replaces: 'c1;to-tag=b-tag;from-tag=a-tag' }
    ])
    expect(dialled().map(d => [d.room_name, d.sip_call_to, d.sip_number, d.headers['X-Twake-Grant']])).toEqual([
      [meetingId, '101', '101', grants[0]!.token],
      [meetingId, '102', '101', grants[1]!.token]
    ])
    expect(grants.some(g => g.revoked)).toBe(false)
    // Hers: its participants, no dial-in (nobody dials into it); nobody else's.
    expect((await store.getConference(meetingId))?.ownerUserId).toBe('alice')
    const read = await app.inject({ method: 'GET', url: `/api/v1/conferences/${meetingId}`, headers: as('alice') })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json()).not.toHaveProperty('dialIn')
    expect(read.json().participants).toHaveLength(2)
    expect((await app.inject({ method: 'GET', url: `/api/v1/conferences/${meetingId}`, headers: as('bob') })).statusCode).toBe(403)
    expect(lk.some(l => l.startsWith('livekit.SIP/CreateSIPDispatchRule'))).toBe(false)
    // « Terminer pour tous »: the room ends for everyone, its record goes.
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${meetingId}`, headers: as('alice') })).statusCode).toBe(204)
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toEqual([`livekit.RoomService/DeleteRoom {"room":"${meetingId}"}`])
    expect(rooms.size).toBe(0)
    expect(await store.getConference(meetingId)).toBeNull()
  })

  it('names the dialog as the other party has it when they placed the call', async () => {
    const { conference, grants } = await setup()
    expect((await conference('c2')).statusCode).toBe(201)
    expect(grants[1]).toMatchObject({ number: '102', replaces: 'c2;to-tag=b-tag;from-tag=a-tag' })
  })

  it("refuses what is not the person's call answered between two extensions, a token that is none, and calls nothing then", async () => {
    const { conference, grants, dialled, store } = await setup()
    const cases: [string, string, unknown, number, string?][] = [
      ['bob', 'alice', { join: JOIN }, 404],
      ['nope', 'alice', { join: JOIN }, 404],
      ['c1', 'alice', { join: 'x' }, 400],
      ['c1', 'alice', {}, 400],
      ['ext', 'alice', { join: JOIN }, 409, 'CONFERENCE_EXTERNAL'],
      ['ringing', 'alice', { join: JOIN }, 409, 'CALL_NOT_ANSWERED']
    ]
    for (const [id, user, payload, status, code] of cases) {
      const res = await conference(id, user, payload)
      expect(res.statusCode, `${id} ${JSON.stringify(payload)} ${res.body}`).toBe(status)
      if (code) expect(res.json().code).toBe(code)
    }
    expect(grants).toEqual([])
    expect(dialled()).toEqual([])
    expect(await store.countConferences('dev')).toBe(0)
  })

  it('leaves nothing of a conference whose other party does not come (DIAL_FAILED): the room ends, its grant withdrawn, its record gone', async () => {
    const { conference, grants, lk, rooms, store } = await setup({ failFor: '102' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DIAL_FAILED', sipStatus: 486 })
    expect(grants.map(g => g.revoked)).toEqual([false, true])
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toHaveLength(1)
    expect(rooms.size).toBe(0)
    expect(await store.countConferences('dev')).toBe(0)
  })

  it("closes the person's calls' rooms LiveKit ended before counting theirs, and counts a conference among the calls their rooms place", async () => {
    const { conference, store } = await setup({ conferenceCaps: { perPerson: 1 } })
    // A room of a call of an hour ago, ended since (LiveKit has no such room).
    await store.claimConference({ tenantId: 'dev', meetingId: 'twake-call-00000000000000aa', ownerUserId: 'alice', createdAt: new Date(Date.now() - 3_600_000).toISOString() })
    expect((await conference('c1')).statusCode).toBe(201)
    expect(await store.getConference('twake-call-00000000000000aa')).toBeNull()
    // The one just made is in LiveKit: still hers, so a second one is past her rooms.
    expect((await conference('c2')).json().code).toBe('CONFERENCE_LIMIT')
    const limited = await setup({ dialOutLimiter: new RateLimiter(1, 60_000) })
    expect((await limited.conference('c1')).statusCode).toBe(201)
    expect((await limited.conference('c2')).json().code).toBe('DIAL_OUT_LIMIT')
  })
})
