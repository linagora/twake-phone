import { createHash } from 'node:crypto'
import { LiveKitConferenceBridge, signToken, type Fetch } from '@twake/conference-livekit'
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
 * `ext`, with the operator; `ringing`, not answered; `odd`, between two extensions with a Call-ID a Replaces header
 * cannot carry; `broken`, one the SIP server cannot say anything of. Bob (102) is in `bob`, of his own. Carol (104)
 * holds an extension and is in none. The fake LiveKit has the room's participants as it called them, each call with
 * its id (`SCL_n`), which the fake SIP server keeps with the grant the call took, as OpenSIPS does (review 8b, n°3);
 * `divertFor`: the grant of the call to that number is taken by another call (replayed from someone else's room);
 * `trunkAt`: where LiveKit's outbound trunk sends the calls; `leaveFor`: that number's participant has left the room
 * when it is read.
 */
const setup = async ({ failFor, divertFor, leaveFor, trunkAt = 'pbx:5060', dialOutLimiter, conferenceCaps }: { failFor?: string; divertFor?: string; leaveFor?: string; trunkAt?: string; dialOutLimiter?: RateLimiter; conferenceCaps?: { perPerson?: number } } = {}) => {
  const grants: (RoomCallGrant & { token: string; revoked: boolean; taken?: { tag: string; callId: string } })[] = []
  const ended: string[] = []
  const parties: Record<string, CallParties | 'external' | 'broken'> = {
    c1: { callId: 'c1', caller: '101', callerTag: 'a-tag', callee: '102', calleeTag: 'b-tag' },
    c2: { callId: 'c2', caller: '102', callerTag: 'b-tag', callee: '101', calleeTag: 'a-tag' },
    odd: { callId: 'odd call', caller: '101', callerTag: 'a-tag', callee: '102', calleeTag: 'b-tag' },
    ext: 'external',
    broken: 'broken',
    bob: { callId: 'bob', caller: '102', callerTag: 'x', callee: '103', calleeTag: 'y' }
  }
  const events: { extension: string; event: TelephonyEvent }[] = [
    ...['c1', 'c2', 'ext', 'ringing', 'odd', 'broken'].map(id => ({ extension: '101', event: { type: 'call.connected' as const, timestamp: new Date().toISOString(), payload: { call: call(id) } } })),
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
          const kept: (typeof grants)[number] = { ...g, token: String(grants.length).padStart(32, 'c'), revoked: false }
          grants.push(kept)
          return { token: kept.token, revoke: async () => void (kept.revoked = true), taken: async () => kept.taken }
        },
        callBetweenExtensions: async (id: string) => {
          const p = parties[id]
          if (p === 'broken') throw Object.assign(new Error('The SIP server did not say where the call is'), { statusCode: 503, code: 'SIP_SERVER_UNAVAILABLE' })
          return p
        },
        endRoomCall: async (id: string) => void ended.push(id),
        close: async () => {}
      }) as unknown as TelephonyProvider
  }
  const lk: string[] = []
  const rooms = new Map<string, { identity: string; attributes: Record<string, string> }[]>()
  let calls = 0
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/twirp/', '')
    const body = JSON.parse(init.body ?? '{}')
    lk.push(`${path} ${JSON.stringify(body)}`)
    if (path === 'livekit.SIP/CreateSIPParticipant') {
      // A call takes a while to be answered: another request meanwhile is served.
      await new Promise(r => setTimeout(r, 10))
      if (body.sip_call_to === failFor) return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'unavailable', msg: 'sip status: 486: Busy Here', meta: { sip_status_code: '486', sip_status: 'Busy Here' } }) }
      const sipCallId = `SCL_${++calls}`
      // The SIP server takes the grant with the call that carries it: LiveKit's own, or another one.
      const grant = grants.find(g => g.token === body.headers?.['X-Twake-Grant'])
      if (grant) grant.taken = body.sip_call_to === divertFor ? { tag: 'SCL_someone-else', callId: 'diverted@192.0.2.66' } : { tag: sipCallId, callId: `${sipCallId}@192.0.2.30` }
      const room = rooms.get(body.room_name) ?? []
      if (body.sip_call_to !== leaveFor) room.push({ identity: body.participant_identity, attributes: body.participant_attributes })
      rooms.set(body.room_name, room)
      return { ok: true, status: 200, text: async () => JSON.stringify({ participant_identity: body.participant_identity, room_name: body.room_name, sip_call_id: sipCallId }) }
    }
    if (path === 'livekit.RoomService/DeleteRoom') rooms.delete(body.room)
    const out: Record<string, unknown> = {
      'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out', address: trunkAt }] },
      'livekit.RoomService/ListRooms': { rooms: [...rooms.keys()].filter(r => (body.names ?? []).includes(r)).map(name => ({ name })) },
      'livekit.RoomService/ListParticipants': { participants: rooms.get(body.room) ?? [] }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out[path] ?? {}) }
  }
  const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch }, max => Math.floor(max / 3))
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'bob', extension: '102' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'carol', extension: '104' })
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
  /** A LiveKit webhook, signed as LiveKit signs them. */
  const webhook = (payload: unknown) => {
    const body = JSON.stringify(payload)
    const token = signToken('k', 's', { sha256: createHash('sha256').update(body).digest('base64') })
    return app.inject({ method: 'POST', url: '/api/v1/webhooks/livekit', headers: { 'content-type': 'application/webhook+json', authorization: token }, payload: body })
  }
  return { app, as, conference, grants, ended, lk, dialled, rooms, store, webhook }
}

describe('a call becomes a conference (POST /calls/:id/conference, step 8b)', () => {
  it("has the room call the person's window (join), then the other party in the place of the call (Replaces, the tags as OpenSIPS holds them), both at the person's name through a grant each", async () => {
    const { conference, grants, dialled, store, app, as, lk, rooms } = await setup()
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(201)
    const { meetingId, participants } = res.json()
    expect(meetingId).toMatch(/^twake-call-[0-9a-f]{16}$/)
    expect(participants.map((p: { number: string }) => p.number)).toEqual(['101', '102'])
    // Alice first (her window draws the token), then Bob, his own tag (the callee's) as the To tag; each grant names
    // the room, which the SIP server names to the phone it calls (review 8b, n°2).
    expect(grants.map(({ extension, number, join, replaces, room }) => ({ extension, number, join, replaces, room }))).toEqual([
      { extension: '101', number: '101', join: JOIN, replaces: undefined, room: meetingId },
      { extension: '101', number: '102', join: undefined, replaces: 'c1;to-tag=b-tag;from-tag=a-tag', room: meetingId }
    ])
    // Never the id of LiveKit's calls.
    expect(res.body).not.toContain('SCL_')
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
    // Bob is in it: he reads who is there (review 8b, n°2), and does nothing else. Carol is not: nothing at all.
    const bobReads = await app.inject({ method: 'GET', url: `/api/v1/conferences/${meetingId}`, headers: as('bob') })
    expect(bobReads.statusCode, bobReads.body).toBe(200)
    expect(bobReads.json().participants.map((p: { number: string }) => p.number)).toEqual(['101', '102'])
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${meetingId}/participants`, headers: as('bob'), payload: { number: '104' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/conferences/${meetingId}`, headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/v1/conferences/${meetingId}`, headers: as('carol') })).statusCode).toBe(403)
    // The third participant: through a grant that names the room too.
    const third = await app.inject({ method: 'POST', url: `/api/v1/conferences/${meetingId}/participants`, headers: as('alice'), payload: { number: '104' } })
    expect(third.statusCode, third.body).toBe(201)
    expect(third.body).not.toContain('SCL_')
    expect(grants[2]).toMatchObject({ extension: '101', number: '104', room: meetingId })
    expect((await app.inject({ method: 'GET', url: `/api/v1/conferences/${meetingId}`, headers: as('carol') })).statusCode).toBe(200)
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
      ['ringing', 'alice', { join: JOIN }, 409, 'CALL_NOT_ANSWERED'],
      // A dialog a Replaces header cannot name, said before anything begins (review 8b, n°15).
      ['odd', 'alice', { join: JOIN }, 409, 'CONFERENCE_UNSUPPORTED'],
      // The SIP server that does not answer is not "no such call" (review 8b, n°10).
      ['broken', 'alice', { join: JOIN }, 503, 'SIP_SERVER_UNAVAILABLE']
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
    // A conference is two calls of a room (review 8b, n°16): counted before any room is.
    const limited = await setup({ dialOutLimiter: new RateLimiter(3, 60_000) })
    expect((await limited.conference('c1')).statusCode).toBe(201)
    expect((await limited.conference('c2')).json().code).toBe('DIAL_OUT_LIMIT')
    expect(limited.grants).toHaveLength(2)
    const one = await setup({ dialOutLimiter: new RateLimiter(1, 60_000) })
    expect((await one.conference('c1')).json().code).toBe('DIAL_OUT_LIMIT')
    expect(await one.store.countConferences('dev')).toBe(0)
    expect(one.grants).toEqual([])
  })

  it("ends the conference whose call took another's grant (review 8b, n°3): the call that took it ended at the SIP server, the room gone, the administrators told", async () => {
    const { conference, grants, ended, rooms, store } = await setup({ divertFor: '102' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json().code).toBe('CALL_DIVERTED')
    expect(ended).toEqual(['diverted@192.0.2.66'])
    expect(grants).toHaveLength(2)
    expect(rooms.size).toBe(0)
    expect(await store.countConferences('dev')).toBe(0)
    const alerts = { items: await store.listAlerts('dev', { limit: 10 }) }
    expect(alerts.items.map(a => [a.alert.kind, a.alert.param, a.alert.extension, a.alert.number])).toEqual([['meet', 'call-diverted', '101', '102']])
    // A third participant likewise: removed from the room, its call ended, told; the conference goes on.
    const later = await setup({ divertFor: '104' })
    const room = (await later.conference('c1')).json().meetingId
    const dial = await later.app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: later.as('alice'), payload: { number: '104' } })
    expect(dial.statusCode, dial.body).toBe(502)
    expect(dial.json().code).toBe('CALL_DIVERTED')
    expect(later.ended).toEqual(['diverted@192.0.2.66'])
    expect(later.lk.filter(l => l.startsWith('livekit.RoomService/RemoveParticipant')).map(l => JSON.parse(l.slice(l.indexOf(' ') + 1)).room)).toEqual([room])
    expect(await later.store.getConference(room)).not.toBeNull()
  })

  it("places no call when LiveKit's trunk sends them elsewhere than the SIP server (review 8b, n°3): told, written back", async () => {
    const { conference, grants, store, lk } = await setup({ trunkAt: '198.51.100.7:5060' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json().code).toBe('CALL_DIVERTED')
    expect(grants).toEqual([])
    expect(await store.countConferences('dev')).toBe(0)
    expect((await store.listAlerts('dev', { limit: 10 })).map(a => a.alert.param)).toEqual(['trunk-changed'])
    // Written back over the one found at the next call.
    await conference('c1')
    expect(lk.filter(l => l.startsWith('livekit.SIP/UpdateSIPOutboundTrunk')).length).toBeGreaterThanOrEqual(2)
  })

  it('makes one conference at a time of a call (review 8b, n°6): the second asked meanwhile is CONFERENCE_IN_PROGRESS', async () => {
    const { conference, grants } = await setup()
    const [a, b] = await Promise.all([conference('c1'), conference('c1')])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
    expect([a, b].find(r => r.statusCode === 409)!.json().code).toBe('CONFERENCE_IN_PROGRESS')
    expect(grants).toHaveLength(2)
    // Over, the call (become a conference) can be asked again: the SIP server says what it is then.
    expect((await conference('c1')).statusCode).toBe(201)
  })

  it('takes nobody else over when the person left the room before (review 8b, n°8): CONFERENCE_ABANDONED, the room ended', async () => {
    const { conference, grants, rooms, store } = await setup({ leaveFor: '101' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().code).toBe('CONFERENCE_ABANDONED')
    expect(grants.map(g => g.number)).toEqual(['101'])
    expect(rooms.size).toBe(0)
    expect(await store.countConferences('dev')).toBe(0)
  })

  it("lets LiveKit end a call's room (webhook room_finished: its record goes), and ends the room its owner left with someone from outside in it (review 8b, n°7, n°12)", async () => {
    const { conference, store, webhook, lk, app, as } = await setup()
    const first = (await conference('c1')).json().meetingId
    expect((await webhook({ event: 'room_finished', room: { name: first } })).statusCode).toBe(204)
    expect(await store.getConference(first)).toBeNull()
    // Alice leaves a conference of extensions only: it goes on.
    const second = (await conference('c2')).json().meetingId
    expect((await webhook({ event: 'participant_left', room: { name: second }, participant: { identity: 'phone-101-x', attributes: { 'twake.number': '101' } } })).statusCode).toBe(204)
    expect(await store.getConference(second)).not.toBeNull()
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toEqual([])
    // With a number of the public network in it: the room ends when she leaves, not when someone else does.
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${second}/participants`, headers: as('alice'), payload: { number: '0199000024' } })).statusCode).toBe(201)
    await webhook({ event: 'participant_left', room: { name: second }, participant: { identity: 'phone-102-x', attributes: { 'twake.number': '102' } } })
    expect(await store.getConference(second)).not.toBeNull()
    await webhook({ event: 'participant_left', room: { name: second }, participant: { identity: 'phone-101-x', attributes: { 'twake.number': '101' } } })
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toEqual([`livekit.RoomService/DeleteRoom {"room":"${second}"}`])
    expect(await store.getConference(second)).toBeNull()
  })
})
