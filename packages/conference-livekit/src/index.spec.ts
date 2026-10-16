import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LiveKitConferenceBridge, maskNumber, signToken, splitParticipantId, verifyWebhook, type Fetch } from './index.js'

interface Call {
  path: string
  body: any
  auth: string
}
/** A Twirp error LiveKit answers with (its HTTP status, code, message and metadata). */
class TwirpFailure extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly meta: Record<string, string> = {}
  ) {
    super(message)
  }
}
const fakeLiveKit = (responses: Record<string, unknown> = {}) => {
  const calls: Call[] = []
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/twirp/', '')
    calls.push({ path, body: JSON.parse(init.body ?? 'null'), auth: init.headers.authorization! })
    let r = responses[path]
    // A list of answers: one per call, the last one kept.
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0]
    if (r instanceof TwirpFailure) return { ok: false, status: r.status, text: async () => JSON.stringify({ code: 'invalid_argument', msg: r.message, meta: r.meta }) }
    if (r instanceof Error) return { ok: false, status: 400, text: async () => JSON.stringify({ msg: r.message }) }
    return { ok: true, status: 200, text: async () => JSON.stringify(r ?? {}) }
  }
  return { calls, fetch }
}

const make = (responses?: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof LiveKitConferenceBridge>[0]> = {}) => {
  const lk = fakeLiveKit(responses)
  const bridge = new LiveKitConferenceBridge(
    { url: 'http://lk:7880/', apiKey: 'key', apiSecret: 'secret', dialInNumbers: [{ country: 'FR', e164: '8000' }], outboundAddress: 'pbx:5060', fetch: lk.fetch, ...extra },
    () => 0.123456
  )
  return { bridge, calls: lk.calls }
}

describe('tokens', () => {
  it('signs a verifiable HS256 token carrying the SIP admin grants', () => {
    const t = signToken('key', 'secret', { sip: { admin: true } })
    const [h, p, s] = t.split('.')
    expect(createHmac('sha256', 'secret').update(`${h}.${p}`).digest('base64url')).toBe(s)
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toMatchObject({ iss: 'key', sip: { admin: true } })
  })

  it('verifies a webhook only with the right secret and body hash', () => {
    const body = '{"event":"participant_joined"}'
    const token = signToken('key', 'secret', { sha256: createHash('sha256').update(body).digest('base64') })
    expect(verifyWebhook('key', 'secret', token, body)).toBe(true)
    expect(verifyWebhook('key', 'secret', token, body + ' ')).toBe(false)
    expect(verifyWebhook('key', 'other', token, body)).toBe(false)
    expect(verifyWebhook('key', 'secret', undefined, body)).toBe(false)
  })
})

describe('dial-in', () => {
  it('creates the inbound trunk once and a PIN-protected direct dispatch rule per meeting', async () => {
    const { bridge, calls } = make({
      'livekit.SIP/ListSIPInboundTrunk': {},
      'livekit.SIP/CreateSIPInboundTrunk': { sip_trunk_id: 'T1' },
      'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R1' }
    })
    const cfg = await bridge.createDialIn({ id: 'abc-defg', tenantId: 't' })
    await bridge.createDialIn({ id: 'zzz', tenantId: 't' })
    expect(cfg).toEqual({ numbers: [{ country: 'FR', e164: '8000' }], meetingCode: 'abc-defg', pin: '123456' })
    expect(calls.filter(c => c.path === 'livekit.SIP/CreateSIPInboundTrunk')).toHaveLength(1)
    const rule = calls.find(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')!
    expect(rule.body.dispatch_rule.rule.dispatch_rule_direct).toEqual({ room_name: 'abc-defg', pin: '123456' })
    expect(rule.body.dispatch_rule.trunk_ids).toEqual(['T1'])
    expect(rule.body.dispatch_rule.name).toBe('twake-meet-abc-defg')
    expect(rule.auth).toMatch(/^Bearer /)
    // Any called number (only the PBX reaches LiveKit SIP), from the PBX's address only.
    expect(calls.find(c => c.path === 'livekit.SIP/CreateSIPInboundTrunk')!.body.trunk).toEqual({ name: 'twake-meet-in', numbers: [], allowed_addresses: [] })
  })

  it('lets only the PBX call: the inbound trunk takes its addresses, written again over the one found', async () => {
    const { bridge, calls } = make({ 'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'EXIST', name: 'twake-meet-in' }] } }, { inboundAddresses: ['192.0.2.30'] })
    await bridge.ensureTrunks()
    expect(calls.find(c => c.path === 'livekit.SIP/UpdateSIPInboundTrunk')!.body).toEqual({ sip_trunk_id: 'EXIST', replace: { name: 'twake-meet-in', numbers: [], allowed_addresses: ['192.0.2.30'] } })
    expect(calls.some(c => c.path === 'livekit.SIP/CreateSIPInboundTrunk')).toBe(false)
  })

  it('draws another PIN when one is taken by another room', async () => {
    let n = 0
    const lk = fakeLiveKit({
      'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'T', name: 'twake-meet-in' }] },
      'livekit.SIP/CreateSIPDispatchRule': [new TwirpFailure('Dispatch rule for the same trunk, inbound number, number, and PIN combination already exists'), { sip_dispatch_rule_id: 'R2' }]
    })
    const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], outboundAddress: 'pbx:5060', fetch: lk.fetch }, () => [0.111111, 0.222222][n++ % 2]!)
    expect((await bridge.createDialIn({ id: 'm', tenantId: 't' })).pin).toBe('222222')
    expect(lk.calls.filter(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')).toHaveLength(2)
  })

  it('reuses an existing trunk and replaces the rule when dial-in is created again', async () => {
    const { bridge, calls } = make({
      'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'EXIST', name: 'twake-meet-in' }] },
      'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R1' }
    })
    await bridge.createDialIn({ id: 'm', tenantId: 't' })
    await bridge.createDialIn({ id: 'm', tenantId: 't' })
    expect(calls.some(c => c.path === 'livekit.SIP/CreateSIPInboundTrunk')).toBe(false)
    expect(calls.filter(c => c.path === 'livekit.SIP/DeleteSIPDispatchRule')).toHaveLength(1)
  })

  it('removes the rule it knows, or finds it by name after a restart', async () => {
    const { bridge, calls } = make({
      'livekit.SIP/ListSIPDispatchRule': { items: [{ sip_dispatch_rule_id: 'R9', name: 'twake-meet-m' }] }
    })
    await bridge.removeDialIn('m')
    expect(calls.at(-1)).toMatchObject({ path: 'livekit.SIP/DeleteSIPDispatchRule', body: { sip_dispatch_rule_id: 'R9' } })
  })

  it('refuses when no dial-in number is configured', async () => {
    const { bridge } = make({}, { dialInNumbers: [] })
    await expect(bridge.createDialIn({ id: 'm', tenantId: 't' })).rejects.toMatchObject({ statusCode: 501 })
  })
})

describe('dial-out and moderation', () => {
  it('dials through the outbound trunk and returns a phone participant', async () => {
    const { bridge, calls } = make({ 'livekit.SIP/ListSIPOutboundTrunk': {}, 'livekit.SIP/CreateSIPOutboundTrunk': { sip_trunk_id: 'O1' } }, { outboundAuth: { username: 'livekit', password: 'not-a-real-password' } })
    const p = await bridge.dialParticipant('room', '+33612345678', { from: '101' })
    const call = calls.find(c => c.path === 'livekit.SIP/CreateSIPParticipant')!
    // At the name of whoever asked (their extension in the From), waited for until answered.
    expect(call.body).toMatchObject({ sip_trunk_id: 'O1', sip_call_to: '+33612345678', sip_number: '101', room_name: 'room', wait_until_answered: true, ringing_timeout: '30s' })
    // The PBX's challenge is answered with its credentials.
    expect(calls.find(c => c.path === 'livekit.SIP/CreateSIPOutboundTrunk')!.body.trunk).toMatchObject({ address: 'pbx:5060', transport: 'SIP_TRANSPORT_UDP', auth_username: 'livekit', auth_password: 'not-a-real-password' })
    expect(p).toMatchObject({ meetingId: 'room', kind: 'phone', number: '+33612345678', muted: false })
    expect(p.id.startsWith('room:phone-33612345678-')).toBe(true)
  })

  it('writes the outbound trunk found again: the PBX may have moved or changed its credentials', async () => {
    const { bridge, calls } = make({
      'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'OLD', name: 'twake-meet-out', address: 'old-pbx:5060' }] }
    })
    await bridge.dialParticipant('room', '+33612345678')
    expect(calls.find(c => c.path === 'livekit.SIP/UpdateSIPOutboundTrunk')?.body).toMatchObject({ sip_trunk_id: 'OLD', replace: { name: 'twake-meet-out', address: 'pbx:5060' } })
    expect(calls.some(c => c.path === 'livekit.SIP/CreateSIPOutboundTrunk')).toBe(false)
    expect(calls.find(c => c.path === 'livekit.SIP/CreateSIPParticipant')?.body.sip_trunk_id).toBe('OLD')
  })

  it('tells the SIP status of a dial-out that did not go through', async () => {
    const out = { 'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] } }
    const meta = make({ ...out, 'livekit.SIP/CreateSIPParticipant': new TwirpFailure('sip status 403: Destination Not Allowed', 403, { sip_status_code: '403', sip_status: 'Destination Not Allowed' }) })
    await expect(meta.bridge.dialParticipant('room', '0899000000', { from: '101' })).rejects.toMatchObject({ statusCode: 409, code: 'DIAL_FAILED', sipStatus: 403, sipReason: 'Destination Not Allowed' })
    // Without metadata, from the message.
    const msg = make({ ...out, 'livekit.SIP/CreateSIPParticipant': new TwirpFailure('sip status 486: Busy Here') })
    await expect(msg.bridge.dialParticipant('room', '102')).rejects.toMatchObject({ code: 'DIAL_FAILED', sipStatus: 486, sipReason: 'Busy Here' })
    // Any other failure stays LiveKit's.
    const other = make({ ...out, 'livekit.SIP/CreateSIPParticipant': new TwirpFailure('room not found', 404) })
    await expect(other.bridge.dialParticipant('room', '102')).rejects.toThrow(/room not found/)
  })

  it('rejects a caller that is no extension', async () => {
    const { bridge } = make()
    await expect(bridge.dialParticipant('room', '102', { from: "101'; --" })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects numbers that are not dialable', async () => {
    const { bridge } = make()
    await expect(bridge.dialParticipant('room', 'abc; DROP')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('masks or hides numbers according to the tenant privacy setting', async () => {
    const mask = make({ 'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] } }, { numberPrivacy: 'mask' })
    const hidden = make({ 'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] } }, { numberPrivacy: 'hide' })
    expect((await mask.bridge.dialParticipant('r', '+33612345678')).number).toBe(maskNumber('+33612345678'))
    const h = await hidden.bridge.dialParticipant('r', '+33612345678')
    expect(h.number).toBeUndefined()
    expect(h.displayName).toBe('Phone')
    const sent = hidden.calls.find(c => c.path === 'livekit.SIP/CreateSIPParticipant')!.body
    expect(sent.participant_name).toBe('Phone')
  })

  it('disconnects and mutes by room-scoped participant id', async () => {
    const { bridge, calls } = make({
      'livekit.RoomService/GetParticipant': { tracks: [{ sid: 'TR1', type: 'AUDIO', muted: false }, { sid: 'TR2', type: 'VIDEO' }] }
    })
    await bridge.disconnectParticipant('room:bob')
    await bridge.muteParticipant('room:bob')
    expect(calls[0]).toMatchObject({ path: 'livekit.RoomService/RemoveParticipant', body: { room: 'room', identity: 'bob' } })
    const mutes = calls.filter(c => c.path === 'livekit.RoomService/MutePublishedTrack')
    expect(mutes).toHaveLength(1)
    expect(mutes[0]!.body).toMatchObject({ track_sid: 'TR1', muted: true })
    expect(splitParticipantId('a:b:c')).toEqual({ room: 'a:b', identity: 'c' })
    expect(() => splitParticipantId('nocolon')).toThrow()
  })

  it('scopes the token of room calls to that room', async () => {
    const { bridge, calls } = make({})
    await bridge.disconnectParticipant('room:bob')
    const claims = JSON.parse(Buffer.from(calls[0]!.auth.split('.')[1]!, 'base64url').toString())
    expect(claims.video).toMatchObject({ roomAdmin: true, room: 'room' })
  })

  it('surfaces LiveKit errors with their message', async () => {
    const { bridge } = make({ 'livekit.RoomService/RemoveParticipant': new Error('participant not found') })
    await expect(bridge.disconnectParticipant('r:x')).rejects.toThrow(/participant not found/)
  })
})

describe('events', () => {
  it('maps participant webhooks to conference events and ignores others', () => {
    const { bridge } = make()
    const joined = bridge.fromWebhook({ event: 'participant_joined', room: { name: 'room' }, participant: { identity: 'sip_1', name: 'Alice', kind: 3, attributes: { 'sip.phoneNumber': '+33611111111' } } })
    expect(joined).toMatchObject({ type: 'conference.participant.joined', payload: { participant: { kind: 'phone', number: '+33611111111', meetingId: 'room' } } })
    const left = bridge.fromWebhook({ event: 'participant_left', room: { name: 'room' }, participant: { identity: 'web1', name: 'Bob' } })
    expect(left?.payload.participant.kind).toBe('web')
    expect(bridge.fromWebhook({ event: 'room_started', room: { name: 'room' } })).toBeUndefined()
  })
})
