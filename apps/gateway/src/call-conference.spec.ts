import { createHash } from 'node:crypto'
import { LiveKitConferenceBridge, signToken, type Fetch } from '@twake/conference-livekit'
import type { CallParties, CallWithOperator, ProviderFactory, RoomCallGrant, TelephonyProvider } from '@twake/telephony-provider-sdk'
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
 * when it is read. Second review 8b, n°1: `failTaken`, the grant of the call that fails (`failFor`) was taken by
 * LiveKit's own call (`own`, which failed: the SIP server has it no more) or by another one, still in progress
 * (`another`: replayed and answered, then the Gateway's call refused 486 by whoever replayed it), or by LiveKit's own
 * still ringing at the SIP server (`ringing`: given up at LiveKit's ringing delay, 480, its 487s on their way; third
 * review 8b, n°1); `takenFails` and `miFails`, the grant then cannot be read, or the SIP server's MI cannot end a
 * call (third review 8b, n°4); `untakenFor`, LiveKit placed
 * that call but no call took its grant; `trunkMovesAt`, the trunk sends elsewhere once that number is called. The
 * fake SIP server withdraws a grant only if no call took it, and ends only a call it has (`ended`). Each participant
 * has the Call-ID of its call (`sip.callIDFull`); the room's call to the group 600 is answered by Carol (104), whom
 * the SIP server tells of it (second review 8b, n°4). Dave (105) holds an extension and is in none.
 */
const setup = async ({ failFor, failTaken, divertFor, untakenFor, leaveFor, trunkAt = 'pbx:5060', trunkMovesAt, dialOutLimiter, conferenceCaps, ownerCheckMs, takenFails, miFails, vanish, failStatus, slowFor, endsWhileRinging, meet, noDialogFor, divertInMeet, callerOf, visioGraceMs, preset }: { preset?: (store: MemoryStore) => Promise<void>; visioGraceMs?: number; callerOf?: string; divertInMeet?: string; meet?: { createRoom(email: string, options?: { accessLevel?: string }): Promise<unknown>; findRoom(email: string, by: unknown): Promise<unknown> }; noDialogFor?: string; endsWhileRinging?: boolean; vanish?: { id: string; after: number }; failStatus?: { code: string; status: number; reason: string }; slowFor?: string; takenFails?: boolean; miFails?: boolean; failFor?: string; failTaken?: 'own' | 'another' | 'ringing'; divertFor?: string; untakenFor?: string; leaveFor?: string; trunkAt?: string; trunkMovesAt?: string; dialOutLimiter?: RateLimiter; conferenceCaps?: { perPerson?: number }; ownerCheckMs?: number } = {}) => {
  const grants: (RoomCallGrant & { token: string; revoked: boolean; taken?: { tag: string; callId: string } })[] = []
  const ended: string[] = []
  let reads = 0
  const dialogOf = new Map<string, string>()
  const isDiverted = (body: { sip_call_to?: string; room_name?: string }) => body.sip_call_to === divertFor || (body.sip_call_to === divertInMeet && !/^twake-call-/.test(body.room_name ?? ''))
  let opReads = 0
  // `endsWhileRinging`: the original call is over from the moment the callback starts to ring (its correspondent took the callback).
  let ringing = false
  // The calls the SIP server has (in progress).
  const alive = new Map<string, 'answered' | 'ringing'>([['diverted@192.0.2.66', 'answered'], ['op', 'answered']])
  let trunk = trunkAt
  const parties: Record<string, CallParties | CallWithOperator | 'external' | 'broken'> = {
    c1: { callId: 'c1', caller: '101', callerTag: 'a-tag', callee: '102', calleeTag: 'b-tag' },
    c2: { callId: 'c2', caller: '102', callerTag: 'b-tag', callee: '101', calleeTag: 'a-tag' },
    odd: { callId: 'odd call', caller: '101', callerTag: 'a-tag', callee: '102', calleeTag: 'b-tag' },
    ext: 'external',
    // With the operator (step 8c): the number a room calls again; one of Bob's call, which Alice's id names to no one.
    op: { callId: 'op', extension: '101', number: '+33612345678' },
    opbob: { callId: 'opbob', extension: '102', number: '+33612345678' },
    broken: 'broken',
    bob: { callId: 'bob', caller: '102', callerTag: 'x', callee: '103', calleeTag: 'y' }
  }
  const events: { extension: string; event: TelephonyEvent }[] = [
    ...['c1', 'c2', 'ext', 'op', 'opbob', 'ringing', 'odd', 'broken'].map(id => ({ extension: '101', event: { type: 'call.connected' as const, timestamp: new Date().toISOString(), payload: { call: call(id) } } })),
    { extension: '102', event: { type: 'call.connected', timestamp: new Date().toISOString(), payload: { call: call('bob') } } },
    { extension: '104', event: { type: 'call.connected', timestamp: new Date().toISOString(), payload: { call: call('grp@192.0.2.30') } } }
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
        // The dialog of a call a room placed to an extension, as the SIP server holds it (step 8d).
        roomCallParties: async (id: string) => {
          const callee = dialogOf.get(id)
          return callee && callee !== noDialogFor && /^[0-9]{2,6}$/.test(callee) ? { callId: id, caller: callerOf ?? '101', callerTag: id.split('@')[0]!, callee, calleeTag: `t-${callee}` } : undefined
        },
        grantRoomCall: async (g: RoomCallGrant) => {
          const kept: (typeof grants)[number] = { ...g, token: String(grants.length).padStart(32, 'c'), revoked: false }
          grants.push(kept)
          return {
            token: kept.token,
            revoke: async () => void (kept.revoked ||= !kept.taken),
            taken: async () => {
              if (takenFails) throw new Error('database unavailable')
              return kept.revoked ? undefined : kept.taken
            }
          }
        },
        callBetweenExtensions: async (id: string) => {
          // `vanish`: the call is over (the far end hung up) from its `after`th reading on.
          if (vanish?.id === id && ++reads > vanish.after) return undefined
          if (id === 'op') opReads++
          if (id === 'op' && ringing) return undefined
          const p = parties[id]
          if (p === 'broken') throw Object.assign(new Error('The SIP server did not say where the call is'), { statusCode: 503, code: 'SIP_SERVER_UNAVAILABLE' })
          return p
        },
        endRoomCall: async (id: string) => {
          if (miFails) throw Object.assign(new Error('OpenSIPS did not answer'), { code: 'ETIMEDOUT' })
          const state = alive.get(id)
          if (!state) return undefined
          alive.delete(id)
          ended.push(id)
          return state
        },
        close: async () => {}
      }) as unknown as TelephonyProvider
  }
  const lk: string[] = []
  const rooms = new Map<string, { identity: string; attributes: Record<string, string> }[]>()
  let calls = 0
  const joinsLater: { identity: string; attributes: Record<string, string> }[] = []
  // What the bridge draws (identities): each its own.
  let drawn = 0
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/twirp/', '')
    const body = JSON.parse(init.body ?? '{}')
    lk.push(`${path} ${JSON.stringify(body)}`)
    if (path === 'livekit.SIP/CreateSIPParticipant') {
      // A call takes a while to be answered: another request meanwhile is served.
      if (endsWhileRinging && body.sip_call_to === slowFor) ringing = true
      await new Promise(r => setTimeout(r, body.sip_call_to === slowFor ? 400 : 10))
      if (body.sip_call_to === trunkMovesAt) trunk = '198.51.100.7:5060'
      const sipCallId = `SCL_${++calls}`
      const grant = grants.find(g => g.token === body.headers?.['X-Twake-Grant'])
      if (body.sip_call_to === failFor && grant && failTaken) grant.taken = failTaken === 'another' ? { tag: 'SCL_someone-else', callId: 'diverted@192.0.2.66' } : { tag: sipCallId, callId: `${sipCallId}@192.0.2.30` }
      if (body.sip_call_to === failFor && failTaken === 'another') alive.set('diverted@192.0.2.66', 'answered')
      if (body.sip_call_to === failFor && failTaken === 'ringing') {
        alive.set(`${sipCallId}@192.0.2.30`, 'ringing')
        return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'canceled', msg: 'sip status: 480: Temporarily Unavailable', meta: { sip_status_code: '480', sip_status: 'Temporarily Unavailable' } }) }
      }
      if (body.sip_call_to === failFor) return { ok: false, status: 400, text: async () => JSON.stringify({ code: failStatus?.code ?? 'unavailable', msg: `sip status: ${failStatus?.status ?? 486}: ${failStatus?.reason ?? 'Busy Here'}`, meta: { sip_status_code: String(failStatus?.status ?? 486), sip_status: failStatus?.reason ?? 'Busy Here' } }) }
      // The SIP server takes the grant with the call that carries it: LiveKit's own, or another one.
      if (grant && body.sip_call_to !== untakenFor) grant.taken = isDiverted(body) ? { tag: 'SCL_someone-else', callId: 'diverted@192.0.2.66' } : { tag: sipCallId, callId: `${sipCallId}@192.0.2.30` }
      if (!isDiverted(body) && body.sip_call_to !== untakenFor) alive.set(`${sipCallId}@192.0.2.30`, 'answered')
      const room = rooms.get(body.room_name) ?? []
      const callIdFull = body.sip_call_to === '600' ? 'grp@192.0.2.30' : `${sipCallId}@192.0.2.30`
      dialogOf.set(callIdFull, body.sip_call_to)
      if (body.sip_call_to !== leaveFor) room.push({ identity: body.participant_identity, attributes: { ...body.participant_attributes, 'sip.callIDFull': callIdFull } })
      rooms.set(body.room_name, room)
      return { ok: true, status: 200, text: async () => JSON.stringify({ participant_identity: body.participant_identity, room_name: body.room_name, sip_call_id: sipCallId }) }
    }
    if (path === 'livekit.RoomService/DeleteRoom') rooms.delete(body.room)
    if (path === 'livekit.RoomService/RemoveParticipant') rooms.set(body.room, (rooms.get(body.room) ?? []).filter(p => p.identity !== body.identity))
    // Someone who comes in just after this read (`joinsLater`), seen by the next one.
    if (path === 'livekit.RoomService/ListParticipants' && joinsLater.length) {
      const now = [...(rooms.get(body.room) ?? [])]
      rooms.get(body.room)?.push(...joinsLater.splice(0))
      return { ok: true, status: 200, text: async () => JSON.stringify({ participants: now }) }
    }
    const out: Record<string, unknown> = {
      'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out', address: trunk }] },
      'livekit.RoomService/ListRooms': { rooms: [...rooms.keys()].filter(r => (body.names ?? []).includes(r)).map(name => ({ name })) },
      'livekit.RoomService/ListParticipants': { participants: rooms.get(body.room) ?? [] }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out[path] ?? {}) }
  }
  const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch }, max => (drawn += 7919) % max)
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'bob', extension: '102' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'carol', extension: '104' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'dave', extension: '105' })
  await preset?.(store)
  const registry = new ProviderRegistry([{ tenantId: 'dev', type: 'fake', config: {} }], [factory])
  const options = {
    store,
    ...(dialOutLimiter ? { dialOutLimiter } : {}),
    ...(conferenceCaps ? { conferenceCaps } : {}),
    ...(ownerCheckMs ? { conferenceOwnerCheckMs: ownerCheckMs } : {}),
    ...(visioGraceMs !== undefined ? { visioGraceMs } : {}),
    conference: { bridge: () => bridge, accessNumber: '8000', webhookKey: 'k', webhookSecret: 's', ...(meet ? { meet: meet as never } : {}) }
  }
  const app = await buildApp(registry, options)
  // Another Gateway on the same database, the same SIP server and the same LiveKit (or this one started again): nothing in memory is shared.
  const another = () => buildApp(registry, options)
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
  return { app, another, parties, opReads: () => opReads, as, conference, grants, ended, lk, dialled, rooms, store, webhook, joinsLater }
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

  it("makes a conference of a call with the operator (step 8c): the room calls the person's window (join), then the same number again, through a grant of its own and no Replaces; the original call is kept until the person confirms", async () => {
    const s = await setup()
    const { conference, grants, dialled, store, app, as } = s
    const res = await conference('op')
    expect(res.statusCode, res.body).toBe(201)
    const { meetingId, participants, awaiting, hangUp } = res.json()
    // The original call stays: the person confirms they hear their correspondent in the room first (ADR 0025).
    expect(awaiting).toBe('+33612345678')
    expect(hangUp).toBeUndefined()
    expect(s.ended).toEqual([])
    expect(participants.map((p: { number: string }) => p.number)).toEqual(['101', '+33612345678'])
    // The number as the SIP server wrote it down, at the person's name, the room named: the grant any call to the
    // public network of the person's rooms has (POST /conferences/:id/participants), none of a Replaces.
    expect(grants.map(({ extension, number, join, replaces, room }) => ({ extension, number, join, replaces, room }))).toEqual([
      { extension: '101', number: '101', join: JOIN, replaces: undefined, room: meetingId },
      { extension: '101', number: '+33612345678', join: undefined, replaces: undefined, room: meetingId }
    ])
    expect(dialled().map(d => [d.sip_call_to, d.sip_number])).toEqual([['101', '101'], ['+33612345678', '101']])
    expect((await store.getConference(meetingId))?.ownerUserId).toBe('alice')
    // A call with two extensions waits for nobody: the Replaces ends it.
    expect((await conference('c1')).json()).not.toHaveProperty('awaiting')
    // Whoever the number is, the room is read as any other of the person's: numbers outside the tenant masked to the others.
    expect((await app.inject({ method: 'GET', url: `/api/v1/conferences/${meetingId}`, headers: as('alice') })).statusCode).toBe(200)
  })

  const post = (s: Awaited<ReturnType<typeof setup>>, id: string, what: 'confirm' | 'cancel', user = 'alice', app = s.app) =>
    app.inject({ method: 'POST', url: `/api/v1/conferences/${id}/${what}`, headers: s.as(user) })

  it("keeps the call with the operator until the person confirms; confirming ends it at the SIP server (by the Call-ID the room recorded), is replayable and the owner's; a room that waits for nothing is refused", async () => {
    const s = await setup()
    const { meetingId } = (await s.conference('op')).json()
    expect((await s.store.getConference(meetingId))?.originCall).toBe('op')
    expect((await post(s, meetingId, 'confirm', 'bob')).statusCode).toBe(403)
    expect(s.ended).toEqual([])
    expect((await post(s, meetingId, 'confirm')).statusCode).toBe(204)
    expect(s.ended).toEqual(['op'])
    // Replayed: nothing more to end, still a success (the call is over, the SIP server has no such dialog).
    const again = await post(s, meetingId, 'confirm')
    expect(again.statusCode, again.body).toBe(204)
    // The room of a call between two extensions (8b) waits for nothing: neither is accepted.
    const t = await setup()
    const plain = (await t.conference('c1')).json().meetingId as string
    for (const what of ['confirm', 'cancel'] as const) {
      const res = await post(t, plain, what)
      expect(res.statusCode, what).toBe(409)
      expect(res.json().code).toBe('CONFERENCE_NOT_AWAITING')
    }
    expect(t.ended).toEqual([])
    expect(t.rooms.has(plain)).toBe(true)
  })

  it('writes nothing when a confirmation cannot be carried out (the call is not the person\'s, the SIP server does not answer): the person can still give up', async () => {
    for (const [now, status] of [['external', 400], ['broken', 503], [{ callId: 'op', extension: '102', number: '+33612345678' }, 400]] as const) {
      const s = await setup()
      const { meetingId } = (await s.conference('op')).json()
      s.parties.op = now
      expect((await post(s, meetingId, 'confirm')).statusCode, JSON.stringify(now)).toBe(status)
      expect((await s.store.getConference(meetingId))?.decision).toBeUndefined()
      expect(s.ended).toEqual([])
      // Giving up still works: the room goes, the call was never touched.
      expect((await post(s, meetingId, 'cancel')).statusCode).toBe(204)
      expect(s.rooms.has(meetingId)).toBe(false)
    }
  })

  it('keeps the conference when the correspondent takes the callback while it rings (the original call over meanwhile): the call is not read during the ringing, and nothing fails', async () => {
    // The callback rings 400 ms; the original call is over from its start: a read during the ringing would see it.
    const s = await setup({ endsWhileRinging: true, slowFor: '+33612345678' })
    const res = await s.conference('op')
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().awaiting).toBe('+33612345678')
    // Read at the start and just before the callback, never again meanwhile.
    expect(s.opReads()).toBe(2)
    expect(s.rooms.has(res.json().meetingId)).toBe(true)
    expect((await post(s, res.json().meetingId, 'confirm')).statusCode).toBe(204)
    expect(s.ended).toEqual([])
  })

  it('is a success to confirm once the correspondent hung up the original call after the callback was answered (before the confirmation): nothing to end', async () => {
    const s = await setup({ vanish: { id: 'op', after: 2 } })
    const res = await s.conference('op')
    expect(res.statusCode, res.body).toBe(201)
    const done = await post(s, res.json().meetingId, 'confirm')
    expect(done.statusCode, done.body).toBe(204)
    expect(s.ended).toEqual([])
    expect(s.rooms.has(res.json().meetingId)).toBe(true)
  })

  it('does not call the correspondent back when the original call is over just before the room would (read once more before), and calls nothing', async () => {
    const before = await setup({ vanish: { id: 'op', after: 1 } })
    const res = await before.conference('op')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().code).toBe('CALL_NOT_ANSWERED')
    expect(before.dialled().map(d => d.sip_call_to)).toEqual(['101'])
    expect(before.rooms.size).toBe(0)
    expect(await before.store.countConferences('dev')).toBe(0)
  })

  it('has confirming and giving up exclude each other, whichever comes first and from whichever Gateway, each replayable', async () => {
    // Confirmed first, on another Gateway: giving up is refused (the original call is gone), the room stays.
    const s = await setup()
    const { meetingId } = (await s.conference('op')).json()
    const elsewhere = await s.another()
    expect((await post(s, meetingId, 'confirm', 'alice', elsewhere)).statusCode).toBe(204)
    expect(s.ended).toEqual(['op'])
    const refused = await post(s, meetingId, 'cancel')
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('CONFERENCE_CONFIRMED')
    expect(s.rooms.has(meetingId)).toBe(true)
    expect((await post(s, meetingId, 'confirm')).statusCode).toBe(204)
    // Given up first: the room is gone, the call untouched, confirming finds nothing.
    const t = await setup()
    const room = (await t.conference('op')).json().meetingId as string
    expect((await post(t, room, 'cancel')).statusCode).toBe(204)
    expect(t.rooms.has(room)).toBe(false)
    expect(await t.store.getConference(room)).toBeNull()
    expect(t.ended).toEqual([])
    expect((await post(t, room, 'confirm')).statusCode).toBe(404)
    // Both decided at the same instant, on two Gateways: one wins, the other is told, never both.
    const u = await setup()
    const racing = (await u.conference('op')).json().meetingId as string
    const other = await u.another()
    const [a, b] = await Promise.all([post(u, racing, 'confirm', 'alice', other), post(u, racing, 'cancel')])
    expect([a.statusCode, b.statusCode].filter(c => c === 204)).toHaveLength(1)
    expect([a.statusCode, b.statusCode].filter(c => c === 409 || c === 404)).toHaveLength(1)
    expect(u.ended.length + (u.rooms.has(racing) ? 0 : 1)).toBe(1)
  })

  it('says the SIP code of a callback the operator, the rights or the caps refuse (403 limit, 480 no answer), and leaves nothing', async () => {
    for (const failStatus of [{ code: 'permission_denied', status: 403, reason: 'Forbidden' }, { code: 'canceled', status: 480, reason: 'Temporarily Unavailable' }]) {
      const s = await setup({ failFor: '+33612345678', failStatus })
      const res = await s.conference('op')
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ code: 'DIAL_FAILED', sipStatus: failStatus.status })
      expect(s.ended).toEqual([])
      expect(s.rooms.size).toBe(0)
      expect(await s.store.countConferences('dev')).toBe(0)
    }
  })

  it("leaves the call with the operator as it was when the number does not answer, is refused or is another's call: the room ends, nothing stays", async () => {
    const { conference, grants, rooms, store, lk } = await setup({ failFor: '+33612345678' })
    const res = await conference('op')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DIAL_FAILED', sipStatus: 486 })
    expect(res.json()).not.toHaveProperty('awaiting')
    expect(grants.map(g => g.revoked)).toEqual([false, true])
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toHaveLength(1)
    expect(rooms.size).toBe(0)
    expect(await store.countConferences('dev')).toBe(0)
    // A call of Bob's with the operator is not Alice's: not found, then not answered when the extension is not hers.
    const other = await conference('opbob')
    expect(other.statusCode).toBe(409)
    expect(other.json().code).toBe('CALL_NOT_ANSWERED')
  })

  it('counts the two calls of the room of a call with the operator among the person’s dial-outs, like any other', async () => {
    const { conference, grants } = await setup({ dialOutLimiter: new RateLimiter(1, 60_000) })
    expect((await conference('op')).statusCode).toBe(429)
    expect(grants).toEqual([])
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

  it("ends the conference whose call failed after another call took its grant (second review 8b, n°1): that call ended at the SIP server, the room gone, the administrators told", async () => {
    // The reviewer's: someone replays the grant from their room, then refuses the Gateway's own call (486).
    const { conference, grants, ended, rooms, store } = await setup({ failFor: '102', failTaken: 'another' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json().code).toBe('CALL_DIVERTED')
    expect(ended).toEqual(['diverted@192.0.2.66'])
    // Read before anything erased it: the grant taken stays.
    expect(grants.map(g => g.revoked)).toEqual([false, false])
    expect(rooms.size).toBe(0)
    expect(await store.countConferences('dev')).toBe(0)
    expect((await store.listAlerts('dev', { limit: 10 })).map(a => [a.alert.param, a.alert.extension, a.alert.number])).toEqual([['call-diverted', '101', '102']])
    // Again: the same answer, one alert that counts both (third review 8b, n°1: the store's, as for all alerts).
    const again = await conference('c2')
    expect(again.json().code, again.body).toBe('CALL_DIVERTED')
    expect(ended).toEqual(['diverted@192.0.2.66', 'diverted@192.0.2.66'])
    expect((await store.listAlerts('dev', { limit: 10 })).map(a => a.count)).toEqual([2])
    // A third participant likewise.
    const later = await setup({ failFor: '104', failTaken: 'another' })
    const room = (await later.conference('c1')).json().meetingId
    const dial = await later.app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: later.as('alice'), payload: { number: '104' } })
    expect(dial.statusCode, dial.body).toBe(502)
    expect(dial.json().code).toBe('CALL_DIVERTED')
    expect(later.ended).toEqual(['diverted@192.0.2.66'])
    expect((await later.store.listAlerts('dev', { limit: 10 })).map(a => a.alert.param)).toEqual(['call-diverted'])
  })

  it("says DIAL_FAILED when the call that took the grant was LiveKit's own, which failed (second review 8b, n°1): the SIP server has it no more, nobody is told", async () => {
    const { conference, ended, store } = await setup({ failFor: '102', failTaken: 'own' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DIAL_FAILED', sipStatus: 486 })
    expect(ended).toEqual([])
    expect(await store.listAlerts('dev', { limit: 10 })).toEqual([])
  })

  it("says DIAL_FAILED when nobody answered: LiveKit's own call, still ringing at the SIP server, is ended quietly (third review 8b, n°1), for the call in the place of the other's as for a third participant", async () => {
    const { conference, ended, store } = await setup({ failFor: '102', failTaken: 'ringing' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DIAL_FAILED', sipStatus: 480 })
    expect(ended).toEqual(['SCL_2@192.0.2.30'])
    expect(await store.listAlerts('dev', { limit: 10 })).toEqual([])
    const later = await setup({ failFor: '104', failTaken: 'ringing' })
    const room = (await later.conference('c1')).json().meetingId
    const dial = await later.app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: later.as('alice'), payload: { number: '104' } })
    expect(dial.statusCode, dial.body).toBe(409)
    expect(dial.json()).toMatchObject({ code: 'DIAL_FAILED', sipStatus: 480 })
    expect(later.ended).toEqual(['SCL_3@192.0.2.30'])
    expect(await later.store.listAlerts('dev', { limit: 10 })).toEqual([])
  })

  it('tells the administrators when the grant cannot be read after a failure, and leaves a failure a failure when the SIP server cannot end the call that took it (third review 8b, n°4)', async () => {
    const unread = await setup({ failFor: '102', failTaken: 'another', takenFails: true })
    expect((await unread.conference('c1')).json().code).toBe('CALL_DIVERTED')
    expect((await unread.store.listAlerts('dev', { limit: 10 })).map(a => a.alert.param)).toEqual(['call-diverted'])
    const noMi = await setup({ failFor: '102', failTaken: 'ringing', miFails: true })
    const failed = await noMi.conference('c1')
    expect(failed.statusCode, failed.body).toBe(409)
    expect(failed.json().code).toBe('DIAL_FAILED')
    expect(await noMi.store.listAlerts('dev', { limit: 10 })).toEqual([])
    // After a success, another call that took the grant is told all the same.
    const divertedNoMi = await setup({ divertFor: '102', miFails: true })
    expect((await divertedNoMi.conference('c1')).json().code).toBe('CALL_DIVERTED')
    expect((await divertedNoMi.store.listAlerts('dev', { limit: 10 })).map(a => a.alert.param)).toEqual(['call-diverted'])
  })

  it('withdraws the grant no call took though LiveKit placed its call (second review 8b, n°1): diverted, nothing left to replay', async () => {
    const { conference, grants, store } = await setup({ untakenFor: '102' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json().code).toBe('CALL_DIVERTED')
    expect(grants.map(g => g.revoked)).toEqual([false, true])
    expect((await store.listAlerts('dev', { limit: 10 })).map(a => a.alert.param)).toEqual(['call-diverted'])
  })

  it("reads LiveKit's trunk again before the second grant (second review 8b, n°1): moved meanwhile, the other party is not called", async () => {
    const { conference, grants, store, rooms } = await setup({ trunkMovesAt: '101' })
    const res = await conference('c1')
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json().code).toBe('CALL_DIVERTED')
    expect(grants.map(g => g.number)).toEqual(['101'])
    expect(rooms.size).toBe(0)
    expect(await store.countConferences('dev')).toBe(0)
    expect((await store.listAlerts('dev', { limit: 10 })).map(a => a.alert.param)).toEqual(['trunk-changed'])
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

  it("lets whoever the room's call reached through a group read who is in it (second review 8b, n°4), nobody it did not reach; a group's number is nobody from outside", async () => {
    const { conference, app, as, webhook, lk, store, rooms } = await setup()
    const room = (await conference('c1')).json().meetingId
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '600' } })).statusCode).toBe(201)
    // Carol answered the group's call: the SIP server told her of it.
    const read = await app.inject({ method: 'GET', url: `/api/v1/conferences/${room}`, headers: as('carol') })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().participants.map((p: { number: string }) => p.number)).toEqual(['101', '102', '600'])
    expect((await app.inject({ method: 'GET', url: `/api/v1/conferences/${room}`, headers: as('dave') })).statusCode).toBe(403)
    // Alice leaves: Carol is of the tenant, the room goes on.
    rooms.set(room, rooms.get(room)!.filter(p => p.attributes['twake.number'] !== '101'))
    await webhook({ event: 'participant_left', room: { name: room }, participant: { identity: 'phone-101-x', attributes: { 'twake.number': '101' } } })
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toEqual([])
    expect(await store.getConference(room)).not.toBeNull()
  })

  it("shows the number of someone from outside whole to the room's owner only, masked to the others in it (second review 8b, n°6)", async () => {
    const { conference, app, as, joinsLater, rooms } = await setup()
    const room = (await conference('c1')).json().meetingId
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '0199000024' } })).statusCode).toBe(201)
    // Read with the Call-ID of one's own call in it (X-Twake-Call): that participant only is marked, numbers masked as before.
    const bobs = rooms.get(room)!.find(p => p.attributes['twake.number'] === '102')!.attributes['sip.callIDFull']!
    const marks = async (headers: Record<string, string | string[]>, meetingId = room) =>
      (await app.inject({ method: 'GET', url: `/api/v1/conferences/${meetingId}`, headers: { ...as('bob'), ...headers } })).json().participants.map((p: { number?: string; you?: boolean }) => `${p.number} ${p.you ?? false}`)
    expect(await marks({ 'x-twake-call': bobs })).toEqual(['101 false', '102 true', '019*****24 false'])
    // A Call-ID of no participant of it, one too long, or two given at once: nobody marked.
    const none = ['101 false', '102 false', '019*****24 false']
    expect(await marks({ 'x-twake-call': 'elsewhere@192.0.2.30' })).toEqual(none)
    expect(await marks({ 'x-twake-call': `${bobs}${'x'.repeat(257)}` })).toEqual(none)
    expect(await marks({ 'x-twake-call': [bobs, 'other@192.0.2.30'] })).toEqual(none)
    // Two given at once as Node hands them over (joined in one string, third review of the notice, n°4).
    expect(await marks({ 'x-twake-call': `${bobs}, other@192.0.2.30` })).toEqual(none)
    // Not in the URL: a query string marks nothing.
    expect((await app.inject({ method: 'GET', url: `/api/v1/conferences/${room}?call=${encodeURIComponent(bobs)}`, headers: as('bob') })).body).not.toContain('"you"')
    const read = async (user: string) => (await app.inject({ method: 'GET', url: `/api/v1/conferences/${room}`, headers: as(user) })).body
    const numbers = async (user: string) => JSON.parse(await read(user)).participants.map((p: { number: string }) => p.number)
    expect(await numbers('alice')).toEqual(['101', '102', '0199000024'])
    expect(await numbers('bob')).toEqual(['101', '102', '019*****24'])
    expect(await read('bob')).not.toContain('"you"')
    // Nowhere in what Bob reads, its ids included (third review 8b, n°2).
    expect(await read('bob')).not.toContain('99000024')
    // Someone come in between the two reads of LiveKit, not proved of the tenant: masked too.
    joinsLater.push({ identity: 'phone-0123456789abcdef0123', attributes: { 'twake.kind': 'phone', 'twake.number': '0199000077', 'sip.callIDFull': 'late@192.0.2.30' } })
    expect(await numbers('bob')).toEqual(['101', '102', '019*****24', '019*****77'])
  })

  it('ends the room its owner left with someone from outside in it without waiting for LiveKit to say so (second review 8b, n°3)', async () => {
    const { conference, app, as, rooms, lk, store } = await setup({ ownerCheckMs: 20 })
    const room = (await conference('c1')).json().meetingId
    const leaves = (number: string) => rooms.set(room, rooms.get(room)!.filter(p => p.attributes['twake.number'] !== number))
    // Alice gone, Bob alone in it: it goes on.
    leaves('101')
    await new Promise(r => setTimeout(r, 120))
    expect(await store.getConference(room)).not.toBeNull()
    // With someone of the public network in it, no webhook: it ends.
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${room}/participants`, headers: as('alice'), payload: { number: '0199000024' } })).statusCode).toBe(201)
    await new Promise(r => setTimeout(r, 120))
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toEqual([`livekit.RoomService/DeleteRoom {"room":"${room}"}`])
    expect(await store.getConference(room)).toBeNull()
  })

  it("lets LiveKit end a call's room (webhook room_finished: its record goes), and ends the room its owner left with someone from outside in it (review 8b, n°7, n°12)", async () => {
    const { conference, store, webhook, lk, app, as, rooms } = await setup()
    const leaves = (room: string, number: string) => rooms.set(room, rooms.get(room)!.filter(p => p.attributes['twake.number'] !== number))
    const first = (await conference('c1')).json().meetingId
    expect((await webhook({ event: 'room_finished', room: { name: first } })).statusCode).toBe(204)
    expect(await store.getConference(first)).toBeNull()
    // Alice leaves a conference of extensions only: it goes on.
    const second = (await conference('c2')).json().meetingId
    leaves(second, '101')
    expect((await webhook({ event: 'participant_left', room: { name: second }, participant: { identity: 'phone-101-x', attributes: { 'twake.number': '101' } } })).statusCode).toBe(204)
    expect(await store.getConference(second)).not.toBeNull()
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toEqual([])
    // With a number of the public network in it: the room ends when she leaves, not when someone else does.
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${second}/participants`, headers: as('alice'), payload: { number: '0199000024' } })).statusCode).toBe(201)
    await webhook({ event: 'participant_left', room: { name: second }, participant: { identity: 'phone-102-x', attributes: { 'twake.number': '102' } } })
    expect(await store.getConference(second)).not.toBeNull()
    // Her departure said while she is still in it (a webhook played again, another call of the room to her extension):
    // LiveKit is read again, nothing ends (third review 8b, n°6).
    const third = (await conference('c1')).json().meetingId
    expect((await app.inject({ method: 'POST', url: `/api/v1/conferences/${third}/participants`, headers: as('alice'), payload: { number: '0199000025' } })).statusCode).toBe(201)
    await webhook({ event: 'participant_left', room: { name: third }, participant: { identity: 'phone-101-x', attributes: { 'twake.number': '101' } } })
    expect(await store.getConference(third)).not.toBeNull()
    await webhook({ event: 'participant_left', room: { name: second }, participant: { identity: 'phone-101-x', attributes: { 'twake.number': '101' } } })
    expect(lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom'))).toEqual([`livekit.RoomService/DeleteRoom {"room":"${second}"}`])
    expect(await store.getConference(second)).toBeNull()
  })
})

describe("a conference goes to Meet's room (POST /conferences/:id/visio, step 8d)", () => {
  const MEET = { id: 'fe15dd04-262c-48d6-83de-d82ab167deb3', slug: 'abc-defg-hij', name: 'abc-defg-hij', url: 'https://meet.example/abc-defg-hij', accessLevel: 'restricted' }
  const withMeet = (over: { fail?: boolean } = {}) => {
    const asked: { email: string; accessLevel?: string }[] = []
    return {
      asked,
      meet: {
        createRoom: async (email: string, options: { accessLevel?: string } = {}) => (asked.push({ email, ...options }), over.fail ? Promise.reject(new Error('open')) : MEET),
        findRoom: async () => MEET
      }
    }
  }
  type S = Awaited<ReturnType<typeof setup>>
  /** Alice, Bob (102), Carol (104) and a number of the public network in one conference. */
  const crowd = async (s: S, { withNumber = true } = {}) => {
    const made = (await s.conference('c1')).json().meetingId as string
    const add = (number: string) => s.app.inject({ method: 'POST', url: `/api/v1/conferences/${made}/participants`, headers: s.as('alice'), payload: { number } })
    expect((await add('104')).statusCode).toBe(201)
    if (withNumber) expect((await add('+33612345678')).statusCode).toBe(201)
    return made
  }
  const visio = (s: S, id: string, user = 'alice') => s.app.inject({ method: 'POST', url: `/api/v1/conferences/${id}/visio`, headers: s.as(user) })
  const state = (s: S, id: string, user = 'alice') => s.app.inject({ method: 'GET', url: `/api/v1/conferences/${id}/visio`, headers: s.as(user) })
  const leave = (s: S, id: string) => s.app.inject({ method: 'POST', url: `/api/v1/conferences/${id}/visio/leave`, headers: s.as('alice') })
  /** The passage once its calls are made (the POST answers before). */
  const settled = async (s: S, id: string) => {
    for (let i = 0; i < 100; i++) {
      const res = await state(s, id)
      if (res.statusCode === 200 && res.json().state !== 'running') return res.json()
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error('the passage never ended')
  }
  const removed = (s: S) => s.lk.filter(l => l.startsWith('livekit.RoomService/RemoveParticipant'))
  const statuses = (v: { people: { number: string; status: string }[] }) => Object.fromEntries(v.people.map(p => [p.number, p.status]))

  it("answers at once with Meet's restricted room, then calls everyone again from it (Replaces for phones, a new call for a number); the old calls and the person's own stay until they say so; a second ask is the same passage, never a second room", async () => {
    const { meet, asked } = withMeet()
    const s = await setup({ meet })
    const made = await crowd(s)
    expect((await s.app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: s.as('alice') })).json().conference).toEqual({ dialIn: true, dialOut: true, visio: true })
    const before = s.grants.length
    const res = await visio(s, made)
    expect(res.statusCode, res.body).toBe(202)
    expect(res.json()).toMatchObject({ meetingId: MEET.id, slug: MEET.slug, url: MEET.url, state: 'running' })
    // No PIN, no number to dial in: the room of the passage shows nothing of Meet's telephony.
    expect(res.json()).not.toHaveProperty('dialIn')
    expect(asked).toEqual([{ email: 'alice@twake.local', accessLevel: 'restricted' }])
    // A second ask while it runs, and after: the same passage, one room of Meet only.
    expect((await visio(s, made)).json().meetingId).toBe(MEET.id)
    const done = await settled(s, made)
    expect((await visio(s, made)).json().meetingId).toBe(MEET.id)
    expect(asked).toHaveLength(1)
    expect(done.state).toBe('done')
    expect(statuses(done)).toEqual({ '102': 'swapped', '104': 'swapped', '+33612345678': 'called' })
    const g = s.grants.slice(before).map(({ extension, number, replaces, room, join }) => ({ extension, number, replaces, room, join }))
    expect(g.map(x => x.number)).toEqual(['102', '104', '+33612345678'])
    for (const x of g) expect([x.extension, x.room, x.join]).toEqual(['101', undefined, undefined])
    expect(g[0]!.replaces).toMatch(/^SCL_\d+@192\.0\.2\.30;to-tag=t-102;from-tag=SCL_\d+$/)
    expect(g[2]!.replaces).toBeUndefined()
    expect(s.rooms.get(MEET.id)?.map(p => p.attributes['twake.number']).sort()).toEqual(['+33612345678', '102', '104'])
    // The number is called again: its old call and the person's own stay.
    expect(removed(s)).toHaveLength(0)
    expect(s.rooms.get(made)).toHaveLength(4)
    expect((await s.store.getConference(MEET.id))?.ownerUserId).toBe('alice')
    // Only the owner reads it.
    expect((await state(s, made, 'bob')).statusCode).toBe(403)
    const left = await leave(s, made)
    expect(left.json()).toEqual({ left: true, remaining: [] })
    expect(await s.store.getConference(made)).toBeNull()
    expect((await leave(s, made)).statusCode).toBe(204)
  })

  it("ends the person's own call at once when everyone is called again in the place of their call", async () => {
    const { meet } = withMeet()
    const s = await setup({ meet })
    const made = await crowd(s, { withNumber: false })
    expect((await visio(s, made)).statusCode).toBe(202)
    expect(statuses(await settled(s, made))).toEqual({ '102': 'swapped', '104': 'swapped' })
    expect(removed(s)).toHaveLength(1)
    expect(s.lk.some(l => l.includes('MoveParticipant'))).toBe(false)
  })

  it("never leaves anyone alone: whoever cannot be called again stays in the old room with the person's own call, which « leave » keeps and names; the number that could be called ends", async () => {
    const { meet } = withMeet()
    const s = await setup({ meet, noDialogFor: '102' })
    const made = await crowd(s)
    expect((await visio(s, made)).statusCode).toBe(202)
    const done = await settled(s, made)
    expect(statuses(done)).toEqual({ '102': 'failed', '104': 'swapped', '+33612345678': 'called' })
    const left = await leave(s, made)
    expect(left.statusCode).toBe(200)
    expect(left.json()).toEqual({ left: false, remaining: ['102'] })
    // Alice's own call is still there, with Bob's: the old room is not ended, nobody is left alone in it.
    expect(s.rooms.get(made)?.map(p => p.attributes['twake.number']).sort()).toEqual(['101', '102'])
    expect(await s.store.getConference(made)).not.toBeNull()
    // Nobody is added to a room that is going to Meet.
    const add = await s.app.inject({ method: 'POST', url: `/api/v1/conferences/${made}/participants`, headers: s.as('alice'), payload: { number: '105' } })
    expect(add.statusCode).toBe(409)
    expect(add.json().code).toBe('VISIO_IN_PROGRESS')
    // The person removes the one left (the list's button), and then it ends.
    const bob = s.rooms.get(made)!.find(p => p.attributes['twake.number'] === '102')!
    s.rooms.set(made, s.rooms.get(made)!.filter(p => p !== bob))
    expect((await leave(s, made)).json()).toEqual({ left: true, remaining: [] })
  })

  it("does not call again someone who left or was removed meanwhile (the old room is read again just before each call), nor a group or a short number (a failure said, they stay), nor a call placed for someone else", async () => {
    const { meet } = withMeet()
    // 102 is called slowly (400 ms): meanwhile 104 is removed from the old room.
    const s = await setup({ meet })
    const made = (await s.conference('c1')).json().meetingId as string
    for (const number of ['104', '600']) expect((await s.app.inject({ method: 'POST', url: `/api/v1/conferences/${made}/participants`, headers: s.as('alice'), payload: { number } })).statusCode).toBe(201)
    const room = s.rooms.get(made)!
    const carol = room.find(p => p.attributes['twake.number'] === '104')!
    const before = s.grants.length
    expect((await visio(s, made)).statusCode).toBe(202)
    // 104 goes right away, before its turn comes.
    s.rooms.set(made, s.rooms.get(made)!.filter(p => p !== carol))
    const done = await settled(s, made)
    expect(statuses(done)).toEqual({ '102': 'swapped', '104': 'gone', '600': 'failed' })
    expect(done.people.find((p: { number: string }) => p.number === '600').reason).toBe('unsupported')
    expect(s.grants.slice(before).map(g => g.number)).toEqual(['102'])
    // A call that is not placed at this person's name is never replaced.
    const t = await setup({ meet, callerOf: '104' })
    const other = await crowd(t, { withNumber: false })
    const mark = t.grants.length
    expect((await visio(t, other)).statusCode).toBe(202)
    expect(statuses(await settled(t, other))).toEqual({ '102': 'failed', '104': 'failed' })
    expect(t.grants.slice(mark)).toHaveLength(0)
  })

  it("stops at a diverted call: the rest is not called, who was called again by a new call is let go (their old call never ended), the record of Meet's room stays so the person can end it", async () => {
    const { meet } = withMeet()
    const s = await setup({ meet, divertInMeet: '104' })
    const made = await crowd(s)
    expect((await visio(s, made)).statusCode).toBe(202)
    const done = await settled(s, made)
    expect(done.state).toBe('halted')
    expect(statuses(done)).toEqual({ '102': 'swapped', '104': 'failed', '+33612345678': 'failed' })
    expect(done.people.map((p: { reason?: string }) => p.reason)).toEqual([undefined, 'diverted', 'halted'])
    expect(await s.store.getConference(MEET.id)).not.toBeNull()
    expect(await s.store.getConference(made)).not.toBeNull()
    // The old room is as it was, the person can leave it or end it: what stays is named.
    expect((await leave(s, made)).json().remaining).toEqual(expect.arrayContaining(['104']))
  })

  it('is the owner\'s, for the room of a call only, needs Meet, waits for a call with the operator to be settled, and never uses a room of Meet that is another\'s', async () => {
    const none = await setup()
    const unavailable = await visio(none, await crowd(none))
    expect(unavailable.statusCode).toBe(501)
    expect(unavailable.json().code).toBe('VISIO_UNAVAILABLE')
    const { meet } = withMeet()
    const s = await setup({ meet })
    const made = await crowd(s)
    expect((await visio(s, made, 'bob')).statusCode).toBe(403)
    expect((await visio(s, made, 'carol')).statusCode).toBe(403)
    expect((await state(s, made)).statusCode).toBe(404)
    await s.store.claimConference({ tenantId: 'dev', meetingId: MEET.id, ownerUserId: 'alice', createdAt: new Date().toISOString() })
    expect((await visio(s, MEET.id)).statusCode).toBe(400)
    const t = await setup({ meet })
    const op = (await t.conference('op')).json().meetingId as string
    const waiting = await visio(t, op)
    expect(waiting.statusCode).toBe(409)
    expect(waiting.json().code).toBe('CONFERENCE_AWAITING')
    // The room of Meet was claimed by someone else already: refused, nothing is called, no passage kept.
    const u = await setup({ meet, preset: async store => void (await store.claimConference({ tenantId: 'dev', meetingId: MEET.id, ownerUserId: 'bob', createdAt: new Date().toISOString() })) })
    const room = await crowd(u)
    const before = u.grants.length
    expect((await visio(u, room)).statusCode).toBe(502)
    expect(u.grants).toHaveLength(before)
    expect(await u.store.getVisio(room)).toBeNull()
  })

  it('opens nothing when Meet gives no room: the old room is as it was', async () => {
    const down = await setup({ meet: withMeet({ fail: true }).meet })
    const made = await crowd(down)
    const before = down.grants.length
    expect((await visio(down, made)).statusCode).toBe(502)
    expect(down.grants).toHaveLength(before)
    expect(removed(down)).toHaveLength(0)
    expect(await down.store.getVisio(made)).toBeNull()
  })

  it('goes on after the Gateway that began it (the record, not a process, holds the passage): a second Gateway asked for the same passage finishes it; a call it left half made is not made again', async () => {
    const { meet } = withMeet()
    const s = await setup({ meet })
    const made = await crowd(s, { withNumber: false })
    // A passage begun elsewhere and left: one person being called (no process of ours runs it), one still to call.
    const people = s.rooms.get(made)!.filter(p => p.attributes['twake.number'] !== '101').map(p => ({ key: `${made}:${p.identity}`, number: p.attributes['twake.number']!, kind: 'extension' as const }))
    await s.store.claimConference({ tenantId: 'dev', meetingId: MEET.id, ownerUserId: 'alice', createdAt: new Date().toISOString() })
    await s.store.claimVisio({ oldRoom: made, meetRoom: MEET.id, tenantId: 'dev', ownerUserId: 'alice', slug: MEET.slug, url: MEET.url, state: 'running', createdAt: new Date().toISOString() }, people)
    expect(await s.store.moveVisioPerson(made, people[0]!.key, 'pending', 'calling')).toBe(true)
    const before = s.grants.length
    expect((await visio(s, made)).statusCode).toBe(202)
    const done = await settled(s, made)
    expect(Object.values(statuses(done)).sort()).toEqual(['failed', 'swapped'])
    expect(done.people.find((p: { key?: string; reason?: string }) => p.reason)?.reason).toBe('interrupted')
    expect(s.grants.length - before).toBe(1)
  })

  it("ends Meet's room when nobody of the organisation nor a browser is left in it and a number from outside is (after the grace), and forgets its record when LiveKit has no more of it", async () => {
    const { meet } = withMeet()
    const s = await setup({ meet, visioGraceMs: 0 })
    const made = await crowd(s)
    expect((await visio(s, made)).statusCode).toBe(202)
    await settled(s, made)
    const hook = (event: string, number: string) => s.webhook({ event, room: { name: MEET.id }, participant: { identity: `phone-${number}`, attributes: { 'twake.number': number } } })
    // The phones left, the number from outside stays: nobody to answer for its call, the room ends.
    s.rooms.set(MEET.id, s.rooms.get(MEET.id)!.filter(p => p.attributes['twake.number'] === '+33612345678'))
    expect((await hook('participant_left', '102')).statusCode).toBe(204)
    expect(s.lk.some(l => l.startsWith(`livekit.RoomService/DeleteRoom {"room":"${MEET.id}"}`))).toBe(true)
    expect(await s.store.getConference(MEET.id)).toBeNull()
    // A room of Meet LiveKit no longer has (more than a minute after): its record no longer counts among the person's rooms.
    const t = await setup({ meet, conferenceCaps: { perPerson: 3 } })
    const room = await crowd(t, { withNumber: false })
    expect((await visio(t, room)).statusCode).toBe(202)
    await settled(t, room)
    await t.store.claimConference({ tenantId: 'dev', meetingId: 'twake-call-00000000000000aa', ownerUserId: 'alice', createdAt: new Date(Date.now() - 3_600_000).toISOString() })
    t.rooms.delete(MEET.id)
    const visios = await t.store.listVisios('dev', 'alice')
    // The passage is old: made again, an hour ago, as it was.
    await t.store.deleteVisio(room)
    await t.store.claimVisio({ ...visios[0]!, createdAt: new Date(Date.now() - 3_600_000).toISOString(), state: 'done' }, [])
    const again = await t.conference('c2')
    expect(again.statusCode, again.body).toBe(201)
    expect(await t.store.getConference(MEET.id)).toBeNull()
  })
})
