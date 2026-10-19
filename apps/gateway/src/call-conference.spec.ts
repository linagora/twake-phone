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
const setup = async ({ failFor, failTaken, divertFor, untakenFor, leaveFor, trunkAt = 'pbx:5060', trunkMovesAt, dialOutLimiter, conferenceCaps, ownerCheckMs, takenFails, miFails, vanish, failStatus, slowFor, originWatchMs, confirmWaitMs }: { vanish?: { id: string; after: number }; failStatus?: { code: string; status: number; reason: string }; slowFor?: string; originWatchMs?: number; confirmWaitMs?: number; takenFails?: boolean; miFails?: boolean; failFor?: string; failTaken?: 'own' | 'another' | 'ringing'; divertFor?: string; untakenFor?: string; leaveFor?: string; trunkAt?: string; trunkMovesAt?: string; dialOutLimiter?: RateLimiter; conferenceCaps?: { perPerson?: number }; ownerCheckMs?: number } = {}) => {
  const grants: (RoomCallGrant & { token: string; revoked: boolean; taken?: { tag: string; callId: string } })[] = []
  const ended: string[] = []
  let reads = 0
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
      if (grant && body.sip_call_to !== untakenFor) grant.taken = body.sip_call_to === divertFor ? { tag: 'SCL_someone-else', callId: 'diverted@192.0.2.66' } : { tag: sipCallId, callId: `${sipCallId}@192.0.2.30` }
      if (body.sip_call_to !== divertFor && body.sip_call_to !== untakenFor) alive.set(`${sipCallId}@192.0.2.30`, 'answered')
      const room = rooms.get(body.room_name) ?? []
      const callIdFull = body.sip_call_to === '600' ? 'grp@192.0.2.30' : `${sipCallId}@192.0.2.30`
      if (body.sip_call_to !== leaveFor) room.push({ identity: body.participant_identity, attributes: { ...body.participant_attributes, 'sip.callIDFull': callIdFull } })
      rooms.set(body.room_name, room)
      return { ok: true, status: 200, text: async () => JSON.stringify({ participant_identity: body.participant_identity, room_name: body.room_name, sip_call_id: sipCallId }) }
    }
    if (path === 'livekit.RoomService/DeleteRoom') rooms.delete(body.room)
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
  const registry = new ProviderRegistry([{ tenantId: 'dev', type: 'fake', config: {} }], [factory])
  const app = await buildApp(registry, {
    store,
    ...(dialOutLimiter ? { dialOutLimiter } : {}),
    ...(conferenceCaps ? { conferenceCaps } : {}),
    ...(ownerCheckMs ? { conferenceOwnerCheckMs: ownerCheckMs } : {}),
    ...(originWatchMs ? { originWatchMs } : {}),
    ...(confirmWaitMs ? { confirmWaitMs } : {}),
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
  return { app, as, conference, grants, ended, lk, dialled, rooms, store, webhook, joinsLater }
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

  it("makes a conference of a call with the operator (step 8c): the room calls the person's window (join), then the same number again, through a grant of its own and no Replaces; the window ends the call", async () => {
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

  it('keeps the call with the operator until the person confirms, then has the SIP server end it (never the window alone); a correspondent gone from the room, or no one waiting, ends nothing', async () => {
    const s = await setup()
    const made = (await s.conference('op')).json()
    // Nobody but the owner confirms.
    expect((await s.app.inject({ method: 'POST', url: `/api/v1/conferences/${made.meetingId}/confirm`, headers: s.as('bob') })).statusCode).toBe(403)
    expect(s.ended).toEqual([])
    const ok = await s.app.inject({ method: 'POST', url: `/api/v1/conferences/${made.meetingId}/confirm`, headers: s.as('alice') })
    expect(ok.statusCode, ok.body).toBe(204)
    expect(s.ended).toEqual(['op'])
    // Said once: nothing waits any more.
    expect((await s.app.inject({ method: 'POST', url: `/api/v1/conferences/${made.meetingId}/confirm`, headers: s.as('alice') })).json().code).toBe('CONFERENCE_NOT_AWAITING')
    // The correspondent left the room meanwhile (hung up, or the mailbox did): the room ends, the original call is not touched.
    const t = await setup()
    const second = (await t.conference('op')).json().meetingId as string
    t.rooms.set(second, t.rooms.get(second)!.filter(p => p.attributes['twake.number'] !== '+33612345678'))
    const gone = await t.app.inject({ method: 'POST', url: `/api/v1/conferences/${second}/confirm`, headers: t.as('alice') })
    expect(gone.statusCode).toBe(409)
    expect(gone.json().code).toBe('CALL_NOT_ANSWERED')
    expect(t.ended).toEqual([])
    expect(t.rooms.has(second)).toBe(false)
    expect(await t.store.getConference(second)).toBeNull()
  })

  it("gives the original call back (the room ended, the call untouched) when the person gives up, or says nothing within the time (the window is gone)", async () => {
    const s = await setup({ confirmWaitMs: 150 })
    const { meetingId } = (await s.conference('op')).json()
    await new Promise(r => setTimeout(r, 400))
    expect(s.rooms.has(meetingId)).toBe(false)
    expect(await s.store.getConference(meetingId)).toBeNull()
    expect(s.ended).toEqual([])
    expect((await s.app.inject({ method: 'POST', url: `/api/v1/conferences/${meetingId}/confirm`, headers: s.as('alice') })).statusCode).toBe(404)
    // Given up: « Annuler » is the room's end (DELETE), nothing waits after it, the call is not ended.
    const t = await setup()
    const made = (await t.conference('op')).json().meetingId as string
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/conferences/${made}`, headers: t.as('alice') })).statusCode).toBe(204)
    expect(t.ended).toEqual([])
    expect(t.rooms.has(made)).toBe(false)
  })

  it("does not call the correspondent back when the original call ended before the room could (read again just before), and ends the room if it ends while the callback rings", async () => {
    const before = await setup({ vanish: { id: 'op', after: 1 } })
    const res = await before.conference('op')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().code).toBe('CALL_NOT_ANSWERED')
    expect(before.dialled().map(d => d.sip_call_to)).toEqual(['101'])
    expect(before.rooms.size).toBe(0)
    expect(await before.store.countConferences('dev')).toBe(0)
    // While it rings (the call takes 400 ms here, read every 50): the room is ended, which cancels the ringing call.
    const during = await setup({ vanish: { id: 'op', after: 2 }, slowFor: '+33612345678', originWatchMs: 50 })
    const rung = await during.conference('op')
    expect(rung.statusCode, rung.body).toBe(409)
    expect(rung.json().code).toBe('CALL_NOT_ANSWERED')
    expect(during.lk.filter(l => l.startsWith('livekit.RoomService/DeleteRoom')).length).toBeGreaterThanOrEqual(1)
    expect(during.rooms.size).toBe(0)
    expect(await during.store.countConferences('dev')).toBe(0)
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
