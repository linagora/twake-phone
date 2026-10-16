import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GRANT_HEADER, LiveKitApi, LiveKitConferenceBridge, LiveKitError, PIN_DIGITS, maskNumber, signToken, splitParticipantId, verifyWebhook, type Fetch } from './index.js'

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
    readonly meta: Record<string, string> = {},
    readonly code = 'invalid_argument'
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
    if (r instanceof TwirpFailure) return { ok: false, status: r.status, text: async () => JSON.stringify({ code: r.code, msg: r.message, meta: r.meta }) }
    if (r instanceof Error) return { ok: false, status: 400, text: async () => JSON.stringify({ msg: r.message }) }
    return { ok: true, status: 200, text: async () => JSON.stringify(r ?? {}) }
  }
  return { calls, fetch }
}

const make = (responses?: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof LiveKitConferenceBridge>[0]> = {}) => {
  const lk = fakeLiveKit(responses)
  const bridge = new LiveKitConferenceBridge(
    { url: 'http://lk:7880/', apiKey: 'key', apiSecret: 'secret', dialInNumbers: [{ country: 'FR', e164: '8000' }], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch: lk.fetch, ...extra },
    max => Math.floor(0.123456 * max)
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
      'livekit.SIP/ListSIPInboundTrunk': [{}, { items: [{ sip_trunk_id: 'T1', name: 'twake-meet-in' }] }],
      'livekit.SIP/CreateSIPInboundTrunk': { sip_trunk_id: 'T1' },
      'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R1' }
    })
    const cfg = await bridge.createDialIn({ id: 'abc-defg', tenantId: 't' })
    await bridge.createDialIn({ id: 'zzz', tenantId: 't' })
    expect(cfg).toEqual({ numbers: [{ country: 'FR', e164: '8000' }], meetingCode: 'abc-defg', pin: '1234560000' })
    expect(calls.filter(c => c.path === 'livekit.SIP/CreateSIPInboundTrunk')).toHaveLength(1)
    const rule = calls.find(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')!
    expect(rule.body.dispatch_rule.rule.dispatch_rule_direct).toEqual({ room_name: 'abc-defg', pin: '1234560000' })
    expect(rule.body.dispatch_rule.trunk_ids).toEqual(['T1'])
    expect(rule.body.dispatch_rule.name).toBe('twake-meet-abc-defg')
    expect(rule.auth).toMatch(/^Bearer /)
    // Any called number (only the PBX reaches LiveKit SIP), from the PBX's address only.
    expect(calls.find(c => c.path === 'livekit.SIP/CreateSIPInboundTrunk')!.body.trunk).toEqual({ name: 'twake-meet-in', numbers: [], allowed_addresses: ['192.0.2.30'] })
  })

  it('needs the addresses LiveKit SIP takes calls from: LiveKit refuses an inbound trunk with neither numbers nor addresses (review n°3)', () => {
    for (const inboundAddresses of [[], [' ']]) expect(() => make({}, { inboundAddresses })).toThrow(/addresses it takes calls from/)
  })

  it('draws PINs of PIN_DIGITS digits from a cryptographic generator, unlike one another (review n°2, n°7)', async () => {
    const lk = fakeLiveKit({ 'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'T', name: 'twake-meet-in' }] }, 'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R' } })
    const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch: lk.fetch })
    const pins = new Set<string>()
    for (let i = 0; i < 20; i++) pins.add((await bridge.createDialIn({ id: `m${i}`, tenantId: 't' })).pin!)
    expect(PIN_DIGITS).toBe(10)
    expect([...pins].every(p => /^\d{10}$/.test(p))).toBe(true)
    expect(pins.size).toBe(20)
  })

  it('keeps one trunk of each name, deleting those a second Gateway created at the same time (review n°11)', async () => {
    const { bridge, calls } = make({
      'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'IN1', name: 'twake-meet-in' }, { sip_trunk_id: 'IN2', name: 'twake-meet-in' }, { sip_trunk_id: 'X', name: 'other' }] },
      'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'OUT1', name: 'twake-meet-out' }, { sip_trunk_id: 'OUT2', name: 'twake-meet-out' }] }
    })
    await bridge.ensureTrunks()
    expect(calls.filter(c => c.path === 'livekit.SIP/DeleteSIPTrunk').map(c => c.body.sip_trunk_id).sort()).toEqual(['IN2', 'OUT2'])
    expect(calls.find(c => c.path === 'livekit.SIP/UpdateSIPInboundTrunk')!.body.sip_trunk_id).toBe('IN1')
  })

  it('makes the rule of a room again, with the PIN shown, when LiveKit lost it or its trunk (review n°11)', async () => {
    const lost = make({ 'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'T', name: 'twake-meet-in' }] }, 'livekit.SIP/ListSIPDispatchRule': { items: [] }, 'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R2' } })
    await lost.bridge.ensureDialIn('m', '0123456789')
    expect(lost.calls.find(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')!.body.dispatch_rule).toMatchObject({ name: 'twake-meet-m', trunk_ids: ['T'], rule: { dispatch_rule_direct: { room_name: 'm', pin: '0123456789' } } })
    const stale = make({ 'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'T', name: 'twake-meet-in' }] }, 'livekit.SIP/ListSIPDispatchRule': { items: [{ sip_dispatch_rule_id: 'OLD', name: 'twake-meet-m', trunk_ids: ['GONE'] }] }, 'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R2' } })
    await stale.bridge.ensureDialIn('m', '0123456789')
    expect(stale.calls.find(c => c.path === 'livekit.SIP/DeleteSIPDispatchRule')!.body.sip_dispatch_rule_id).toBe('OLD')
    expect(stale.calls.some(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')).toBe(true)
    const kept = make({ 'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'T', name: 'twake-meet-in' }] }, 'livekit.SIP/ListSIPDispatchRule': { items: [{ sip_dispatch_rule_id: 'R1', name: 'twake-meet-m', trunk_ids: ['T'], rule: { dispatch_rule_direct: { room_name: 'm', pin: '0123456789' } } }] } })
    await kept.bridge.ensureDialIn('m', '0123456789')
    expect(kept.calls.some(c => c.path === 'livekit.SIP/CreateSIPDispatchRule' || c.path === 'livekit.SIP/DeleteSIPDispatchRule')).toBe(false)
  })

  it('writes the inbound trunk again when LiveKit lost it after a first use, and the rule of a room on it (second review n°3)', async () => {
    const { bridge, calls } = make({
      // T1 at first; gone (the check, then the list before writing it again); T2 from then on.
      'livekit.SIP/ListSIPInboundTrunk': [{ items: [{ sip_trunk_id: 'T1', name: 'twake-meet-in' }] }, {}, {}, { items: [{ sip_trunk_id: 'T2', name: 'twake-meet-in' }] }],
      'livekit.SIP/CreateSIPInboundTrunk': { sip_trunk_id: 'T2' },
      'livekit.SIP/ListSIPDispatchRule': { items: [{ sip_dispatch_rule_id: 'R1', name: 'twake-meet-m', trunk_ids: ['T1'], rule: { dispatch_rule_direct: { room_name: 'm', pin: '0123456789' } } }] },
      'livekit.SIP/CreateSIPDispatchRule': { sip_dispatch_rule_id: 'R2' }
    }, { checkTtlMs: 0 })
    await bridge.ensureDialIn('m', '0123456789')
    expect(calls.some(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')).toBe(false)
    // LiveKit's Redis emptied: T1 is gone, the rule kept by the list above still names it.
    await bridge.ensureDialIn('m', '0123456789')
    expect(calls.filter(c => c.path === 'livekit.SIP/CreateSIPInboundTrunk')).toHaveLength(1)
    expect(calls.find(c => c.path === 'livekit.SIP/DeleteSIPDispatchRule')!.body.sip_dispatch_rule_id).toBe('R1')
    expect(calls.find(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')!.body.dispatch_rule).toMatchObject({ trunk_ids: ['T2'], rule: { dispatch_rule_direct: { room_name: 'm', pin: '0123456789' } } })
    // A new room too: on the trunk written again.
    await bridge.createDialIn({ id: 'n', tenantId: 't' })
    expect(calls.filter(c => c.path === 'livekit.SIP/CreateSIPDispatchRule').map(c => c.body.dispatch_rule.trunk_ids)).toEqual([['T2'], ['T2']])
  })

  it('keeps one rule of a room, with the PIN shown: others of the room deleted, on reading it as when it is closed (third review n°5)', async () => {
    const rule = (id: string, pin: string, name = 'twake-meet-m') => ({ sip_dispatch_rule_id: id, name, trunk_ids: ['T'], rule: { dispatch_rule_direct: { room_name: 'm', pin } } })
    const rules = { items: [rule('A', '1111111111'), rule('B', '0123456789'), rule('C', '0123456789'), rule('D', '2222222222'), rule('X', '3333333333', 'twake-meet-other')] }
    const { bridge, calls } = make({ 'livekit.SIP/ListSIPInboundTrunk': { items: [{ sip_trunk_id: 'T', name: 'twake-meet-in' }] }, 'livekit.SIP/ListSIPDispatchRule': rules })
    await bridge.ensureDialIn('m', '0123456789')
    const deleted = () => calls.filter(c => c.path === 'livekit.SIP/DeleteSIPDispatchRule').map(c => c.body.sip_dispatch_rule_id)
    expect(deleted()).toEqual(['A', 'C', 'D'])
    expect(calls.some(c => c.path === 'livekit.SIP/CreateSIPDispatchRule')).toBe(false)
    // Read again at once: LiveKit is not asked again (checkTtlMs, third review n°7).
    const asked = calls.length
    await bridge.ensureDialIn('m', '0123456789')
    expect(calls.length).toBe(asked)
    // The rule a Gateway that lost the race drew goes alone; a closed room loses every rule of its own.
    await bridge.dropDialIn('m', '2222222222')
    expect(deleted().slice(3)).toEqual(['D'])
    await bridge.removeDialIn('m')
    expect(deleted().slice(4)).toEqual(['A', 'B', 'C', 'D'])
    // What a sweep at start reads: the Gateway's rules only, with their room and PIN.
    const all = make({ 'livekit.SIP/ListSIPDispatchRule': { items: [...rules.items, { sip_dispatch_rule_id: 'M', name: 'meet-room', rule: { dispatch_rule_direct: { room_name: 'x', pin: '9' } } }] } })
    expect(await all.bridge.listDialIns()).toEqual([
      { meetingId: 'm', pin: '1111111111' },
      { meetingId: 'm', pin: '0123456789' },
      { meetingId: 'm', pin: '0123456789' },
      { meetingId: 'm', pin: '2222222222' },
      { meetingId: 'other', pin: '3333333333' }
    ])
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
    const bridge = new LiveKitConferenceBridge({ url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [{ country: 'FR', e164: '8000' }], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch: lk.fetch }, max => Math.floor([0.111111, 0.222222][n++ % 2]! * max))
    expect((await bridge.createDialIn({ id: 'm', tenantId: 't' })).pin).toBe('2222220000')
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
    // Its id carries no number (third review 8b, n°2).
    expect(p.id).toMatch(/^room:phone-[0-9a-f]{20}$/)
    expect(p.id).not.toContain('612345678')
  })

  it("writes when the Gateway dials a call, in milliseconds by its own clock, in the call's attributes (third review of the notice, n°2)", async () => {
    const lk = fakeLiveKit({ 'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] } })
    const config = { url: 'http://lk', apiKey: 'k', apiSecret: 's', dialInNumbers: [], inboundAddresses: ['192.0.2.30'], outboundAddress: 'pbx:5060', fetch: lk.fetch }
    const bridge = new LiveKitConferenceBridge(config, max => Math.floor(0.5 * max), () => 1792171400123)
    await bridge.dialParticipant('room', '102', { from: '101' })
    expect(lk.calls.find(c => c.path === 'livekit.SIP/CreateSIPParticipant')!.body.participant_attributes).toEqual({
      'twake.kind': 'phone',
      'twake.number': '102',
      'twake.dialedAt': '1792171400123'
    })
  })

  it('carries the SIP server\'s grant of the call and bounds its length (review n°1, n°5)', async () => {
    const { bridge, calls } = make({ 'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] } }, { maxCallSec: 600 })
    await bridge.dialParticipant('room', '0199000024', { from: '101', grant: '0123456789abcdef0123456789abcdef' })
    const sent = calls.find(c => c.path === 'livekit.SIP/CreateSIPParticipant')!.body
    expect(GRANT_HEADER).toBe('X-Twake-Grant')
    expect(sent).toMatchObject({ headers: { 'X-Twake-Grant': '0123456789abcdef0123456789abcdef' }, max_call_duration: '600s' })
    await expect(bridge.dialParticipant('room', '0199000024', { from: '101', grant: "x'; --" })).rejects.toMatchObject({ statusCode: 400 })
    // Without a word on it, two hours.
    const plain = make({ 'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] } })
    await plain.bridge.dialParticipant('room', '102')
    expect(plain.calls.find(c => c.path === 'livekit.SIP/CreateSIPParticipant')!.body.max_call_duration).toBe('7200s')
  })

  it('writes the outbound trunk again and dials once more when LiveKit no longer knows it (review n°11)', async () => {
    const { bridge, calls } = make({
      'livekit.SIP/ListSIPOutboundTrunk': [{ items: [{ sip_trunk_id: 'O1', name: 'twake-meet-out' }] }, {}],
      'livekit.SIP/CreateSIPOutboundTrunk': { sip_trunk_id: 'O2' },
      'livekit.SIP/CreateSIPParticipant': [new TwirpFailure('requested sip trunk does not exist', 404, {}, 'not_found'), {}]
    })
    await bridge.dialParticipant('room', '102')
    expect(calls.filter(c => c.path === 'livekit.SIP/CreateSIPParticipant').map(c => c.body.sip_trunk_id)).toEqual(['O1', 'O2'])
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
    // LiveKit's own form of a SIP status (review n°19).
    const own = make({ ...out, 'livekit.SIP/CreateSIPParticipant': new TwirpFailure('sip status: 486: Busy Here') })
    await expect(own.bridge.dialParticipant('room', '102')).rejects.toMatchObject({ code: 'DIAL_FAILED', sipStatus: 486, sipReason: 'Busy Here' })
    // Nobody answered before the ringing timeout: no SIP status, LiveKit's "canceled" (review n°4).
    const noAnswer = make({ ...out, 'livekit.SIP/CreateSIPParticipant': new TwirpFailure('sip request timed out', 408, {}, 'canceled') })
    await expect(noAnswer.bridge.dialParticipant('room', '102')).rejects.toMatchObject({ statusCode: 409, code: 'DIAL_FAILED', sipStatus: 480, sipReason: 'No Answer' })
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

  it('ends a room for everyone (DeleteRoom, step 8b), a room LiveKit does not have being no error, any other failure one', async () => {
    const { bridge, calls } = make({})
    await bridge.deleteRoom('twake-call-0123456789abcdef')
    expect(calls[0]).toMatchObject({ path: 'livekit.RoomService/DeleteRoom', body: { room: 'twake-call-0123456789abcdef' } })
    const claims = JSON.parse(Buffer.from(calls[0]!.auth.split('.')[1]!, 'base64url').toString())
    expect(claims.video).toMatchObject({ roomAdmin: true, room: 'twake-call-0123456789abcdef' })
    const gone = make({ 'livekit.RoomService/DeleteRoom': new TwirpFailure('requested room does not exist', 404, {}, 'not_found') })
    await expect(gone.bridge.deleteRoom('r')).resolves.toBeUndefined()
    const down = make({ 'livekit.RoomService/DeleteRoom': new TwirpFailure('internal', 500, {}, 'internal') })
    await expect(down.bridge.deleteRoom('r')).rejects.toBeInstanceOf(LiveKitError)
  })

  it('returns the id LiveKit gave the call (sip_call_id, the From tag of its INVITE: review 8b, n°3), none when LiveKit gives none', async () => {
    const trunk = { 'livekit.SIP/ListSIPOutboundTrunk': { items: [{ sip_trunk_id: 'O', name: 'twake-meet-out' }] } }
    const { bridge } = make({ ...trunk, 'livekit.SIP/CreateSIPParticipant': { participant_id: 'PA_1', sip_call_id: 'SCL_aBc123' } })
    expect(await bridge.dialParticipant('room', '102')).toMatchObject({ number: '102', sipCallId: 'SCL_aBc123' })
    for (const answer of [{}, { sip_call_id: '' }, { sip_call_id: 42 }]) {
      const other = make({ ...trunk, 'livekit.SIP/CreateSIPParticipant': answer })
      expect(await other.bridge.dialParticipant('room', '102')).not.toHaveProperty('sipCallId')
    }
  })

  it('tells whether LiveKit\'s outbound trunk still points at the SIP server, as configured; written again at the next call when not (review 8b, n°3)', async () => {
    const ours = { sip_trunk_id: 'O', name: 'twake-meet-out', address: 'pbx:5060', auth_username: 'livekit' }
    const auth = { outboundAuth: { username: 'livekit', password: 'not-a-real-password' } }
    const intact = make({ 'livekit.SIP/ListSIPOutboundTrunk': { items: [ours] } }, auth)
    expect(await intact.bridge.outboundIntact()).toBe(true)
    // Asked about its own trunk only.
    expect(intact.calls.filter(c => c.path === 'livekit.SIP/ListSIPOutboundTrunk').map(c => c.body)).toEqual([{}, { trunk_ids: ['O'] }])
    for (const changed of [{ ...ours, address: '198.51.100.7:5060' }, { ...ours, auth_username: 'someone-else' }]) {
      const { bridge, calls } = make({ 'livekit.SIP/ListSIPOutboundTrunk': [{ items: [ours] }, { items: [changed] }, { items: [changed] }] }, auth)
      expect(await bridge.outboundIntact()).toBe(false)
      // The next call writes it back over what was found.
      await bridge.dialParticipant('room', '102')
      expect(calls.filter(c => c.path === 'livekit.SIP/UpdateSIPOutboundTrunk').map(c => c.body.replace.address)).toEqual(['pbx:5060', 'pbx:5060'])
    }
    // A trunk LiveKit no longer has sent nothing elsewhere: written again, the call placed.
    const gone = make({ 'livekit.SIP/ListSIPOutboundTrunk': [{ items: [ours] }, {}, {}], 'livekit.SIP/CreateSIPOutboundTrunk': { sip_trunk_id: 'O2' } }, auth)
    expect(await gone.bridge.outboundIntact()).toBe(true)
    await gone.bridge.dialParticipant('room', '102')
    expect(gone.calls.find(c => c.path === 'livekit.SIP/CreateSIPParticipant')?.body.sip_trunk_id).toBe('O2')
  })

  it('lists the number each participant of a room was called at, unmasked, for the Gateway only (review 8b, n°2)', async () => {
    const { bridge, calls } = make(
      {
        'livekit.RoomService/ListParticipants': {
          participants: [
            { identity: 'phone-102-a', attributes: { 'twake.kind': 'phone', 'twake.number': '102', 'sip.callIDFull': 'a1b2@192.0.2.30' } },
            { identity: 'sip-1', attributes: { 'sip.phoneNumber': '+33612345678' } },
            { identity: 'web-1', attributes: {} }
          ]
        }
      },
      { numberPrivacy: 'hide' }
    )
    expect(await bridge.participantCalls('twake-call-0123456789abcdef')).toEqual([
      { id: 'twake-call-0123456789abcdef:phone-102-a', number: '102', callId: 'a1b2@192.0.2.30' },
      { id: 'twake-call-0123456789abcdef:sip-1', number: '+33612345678' },
      { id: 'twake-call-0123456789abcdef:web-1', number: '' }
    ])
    expect(calls[0]).toMatchObject({ path: 'livekit.RoomService/ListParticipants', body: { room: 'twake-call-0123456789abcdef' } })
  })

  it("says when each participant came in, on one clock in milliseconds, and which one is the reader's own call (step 8b)", async () => {
    const list = async (participants: unknown[], you?: string) => {
      const { bridge } = make({ 'livekit.RoomService/ListParticipants': { participants } })
      return (await bridge.listParticipants('twake-call-0123456789abcdef', you ? { you } : {})).map(p => [p.joinedAt, p.you])
    }
    const phone = (number: string, more: Record<string, unknown> = {}, attributes: Record<string, string> = {}) => ({
      identity: `phone-${number}`,
      ...more,
      attributes: { 'twake.kind': 'phone', 'twake.number': number, ...attributes }
    })
    // Every call dialled by the Gateway: its time wins over LiveKit's, whatever LiveKit's precision.
    expect(
      await list(
        [
          phone('101', { joined_at: '1792171400', joined_at_ms: '1792171400250' }, { 'twake.dialedAt': '1792171400100', 'sip.callIDFull': 'a1b2@192.0.2.30' }),
          phone('102', { joined_at: '1792171400' }, { 'twake.dialedAt': '1792171400900', 'sip.callIDFull': 'c3d4@192.0.2.30' })
        ],
        'c3d4@192.0.2.30'
      )
    ).toEqual([
      [1792171400100, undefined],
      [1792171400900, true]
    ])
    // One without it: LiveKit's milliseconds for all (64-bit numbers as strings or numbers), never two clocks in a list.
    expect(
      await list([
        phone('101', { joined_at_ms: '1792171400250' }, { 'twake.dialedAt': '1792171400100' }),
        phone('102', { joined_at_ms: 1792171403999 }),
        { identity: 'web-1', joined_at_ms: '1792171404000', attributes: {} }
      ])
    ).toEqual([
      [1792171400250, undefined],
      [1792171403999, undefined],
      [1792171404000, undefined]
    ])
    // LiveKit's whole seconds only, for one or for all: none (third review of the notice, n°2), nor with zero or nothing.
    expect(await list([phone('101', { joined_at: '1792171400' }), phone('102', { joined_at: '1792171400' })])).toEqual([
      [undefined, undefined],
      [undefined, undefined]
    ])
    expect(await list([phone('101', { joined_at_ms: '1792171400250' }), phone('102', { joined_at: 1792171401 })])).toEqual([
      [undefined, undefined],
      [undefined, undefined]
    ])
    expect(
      await list([
        { identity: 'web-1', attributes: {} },
        { identity: 'web-2', joined_at: '0', joined_at_ms: '0', attributes: { 'twake.dialedAt': 'soon' } }
      ])
    ).toEqual([
      [undefined, undefined],
      [undefined, undefined]
    ])
    expect(await list([phone('101', {}, { 'sip.callIDFull': 'a1b2@192.0.2.30' })], 'other@192.0.2.30')).toEqual([[undefined, undefined]])
  })

  it('tells which of some rooms LiveKit has (ListRooms, step 8b), asking nothing for none', async () => {
    const { bridge, calls } = make({ 'livekit.RoomService/ListRooms': { rooms: [{ name: 'a' }, { name: 'other' }] } })
    expect([...(await bridge.openRooms(['a', 'b']))]).toEqual(['a'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: 'livekit.RoomService/ListRooms', body: { names: ['a', 'b'] } })
    expect((await bridge.openRooms([])).size).toBe(0)
    expect(calls).toHaveLength(1)
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

  it('gives up a request LiveKit does not answer: 10 s by default, the ringing and a minute more for a dial-out (review n°10)', async () => {
    const seen: number[] = []
    const hanging: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen.push(init.signal ? 1 : 0)
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const api = new LiveKitApi('http://lk', 'k', 's', hanging, 30)
    const err = await api.call('livekit.SIP', 'ListSIPInboundTrunk', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LiveKitError)
    expect(err).toMatchObject({ status: 0, twirpCode: 'unavailable', message: expect.stringMatching(/no answer within 30 ms/) })
    expect(seen).toEqual([1])
    // A dial-out's own bound, given with the call.
    const started = Date.now()
    await api.call('livekit.SIP', 'CreateSIPParticipant', {}, { timeoutMs: 80 }).catch(() => undefined)
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    // Unreachable: the same error.
    const down = new LiveKitApi('http://lk', 'k', 's', async () => Promise.reject(new TypeError('fetch failed')))
    await expect(down.call('livekit.SIP', 'ListSIPInboundTrunk', {})).rejects.toMatchObject({ status: 0, twirpCode: 'unavailable' })
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
