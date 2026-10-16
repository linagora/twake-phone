import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { answeredElsewhere, assertedIdentity, Softphone, type RingerLike, type SoftCall, type UserAgentLike } from './index.js'

/** The ringtone as the test sees it: whether it rings, where it goes, and whether the browser "blocks" it. */
class FakeRinger implements RingerLike {
  ringing = false
  sink = ''
  blocked = false
  disposed = false
  start = vi.fn(async () => {
    this.ringing = true
    return !this.blocked
  })
  stop = vi.fn(() => {
    this.ringing = false
  })
  setSink = vi.fn(async (id: string) => {
    this.sink = id
  })
  resume = vi.fn(async () => !this.blocked)
  dispose = vi.fn(() => {
    this.disposed = true
  })
}

// A JsSIP stand-in: the UA and its sessions are event emitters the test drives.
class FakeSession extends EventEmitter {
  id = `s${Math.random()}`
  direction: string
  remote_identity = { uri: { user: '102', host: 'sip.test', toString: () => 'sip:102@sip.test' }, display_name: 'Bob' }
  /** JsSIP's refer() returns the subscription to the far end's NOTIFY reports: the fake hands it to the test. */
  referSubscriber?: EventEmitter
  refer = vi.fn((_target: string, _options?: unknown) => {
    this.referSubscriber = new EventEmitter()
    return this.referSubscriber as never
  })
  connection: unknown = undefined
  terminate = vi.fn()
  answer = vi.fn(() => {
    this.connection = fakePc()
    this.emit('peerconnection', { peerconnection: this.connection })
  })
  /** JsSIP answers the `done` callback once the far end accepted the re-INVITE: the fake keeps it for the test. */
  reofferDone?: () => void
  hold = vi.fn((_o?: unknown, done?: () => void) => {
    this.reofferDone = done
    return true
  })
  unhold = vi.fn((_o?: unknown, done?: () => void) => {
    this.reofferDone = done
    return true
  })
  mute = vi.fn(() => this.emit('muted', { audio: true }))
  unmute = vi.fn(() => this.emit('unmuted', { audio: true }))
  sendDTMF = vi.fn()
  constructor(direction: 'incoming' | 'outgoing') {
    super()
    this.direction = direction
    if (direction === 'outgoing') this.connection = fakePc()
  }
}

/** A microphone track as the browser hands it: a device id, an enabled flag, an `ended` event when unplugged. */
const fakeTrack = (deviceId: string) => {
  const listeners: (() => void)[] = []
  return {
    kind: 'audio',
    enabled: true,
    readyState: 'live' as 'live' | 'ended',
    getSettings: () => ({ deviceId }),
    addEventListener: (_name: string, fn: () => void) => listeners.push(fn),
    stop: vi.fn(),
    unplug() {
      this.readyState = 'ended'
      listeners.forEach(fn => fn())
    }
  }
}

const fakePc = (microphone = 'mic-default') => {
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const sender = { track: fakeTrack(microphone) as ReturnType<typeof fakeTrack> | null, replaceTrack: vi.fn(async (t: ReturnType<typeof fakeTrack>) => void (sender.track = t)) }
  return {
    sender,
    addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[name] ??= []).push(fn),
    fire: (name: string, e: unknown) => listeners[name]?.forEach(fn => fn(e)),
    getSenders: () => [sender],
    getStats: async () => [{ type: 'inbound-rtp', kind: 'audio', packetsReceived: 42 }, { type: 'outbound-rtp', kind: 'audio', packetsSent: 7 }]
  }
}

class FakeUa extends EventEmitter implements UserAgentLike {
  registered = false
  start = vi.fn()
  stop = vi.fn()
  unregister = vi.fn(() => {
    // The server's 200 to the REGISTER expires=0, a round trip later.
    setTimeout(() => {
      this.registered = false
      this.emit('unregistered', {})
    }, 5)
  })
  isRegistered = () => this.registered
  lastCall?: FakeSession
  call = vi.fn((_target: string) => {
    const s = new FakeSession('outgoing')
    this.lastCall = s
    this.emit('newRTCSession', { originator: 'local', session: s })
    return s as never
  })
}

const audios: { srcObject: unknown; sinkId: string; play: ReturnType<typeof vi.fn>; setSinkId: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }[] = []
const audio = () => {
  const a = { srcObject: null as unknown, sinkId: '', play: vi.fn(async () => undefined), setSinkId: vi.fn(async (id: string) => void (a.sinkId = id)), remove: vi.fn() }
  audios.push(a)
  return a as unknown as HTMLAudioElement
}

const setup = async (over: Partial<ConstructorParameters<typeof Softphone>[0]> = {}) => {
  const uas: FakeUa[] = []
  const configs: unknown[] = []
  const registration: string[] = []
  const changes: string[] = []
  const incoming: SoftCall[] = []
  const tones: string[] = []
  const blocked: boolean[] = []
  const ringer = new FakeRinger()
  const getSession = vi.fn(async () => ({ type: 'sip-webrtc' as const, websocketUrl: 'wss://sip.test:443/ws', domain: 'sip.test', username: '101', credential: 'pw', iceServers: [{ urls: ['stun:stun.test'] }] }))
  const phone = new Softphone({
    getSession,
    createAudio: audio,
    displayName: 'Alice',
    onRegistration: s => registration.push(s),
    onCallChange: c => changes.push(`${c.direction}:${c.state}${c.remoteHold ? ':remoteHold' : ''}${c.muted ? ':muted' : ''}${c.renegotiating ? ':offer' : ''}`),
    onIncoming: c => incoming.push(c),
    onDtmf: (_c, tone) => tones.push(tone),
    onAudioBlocked: b => blocked.push(b),
    createRinger: () => ringer,
    createSocket: url => ({ url }) as never,
    createUserAgent: config => {
      configs.push(config)
      const ua = new FakeUa()
      uas.push(ua)
      return ua
    },
    ...over
  })
  await phone.start()
  return { phone, uas, configs, registration, changes, incoming, tones, blocked, ringer, getSession, ua: () => uas[uas.length - 1]! }
}

/** The browser's devices, for the calls that switch microphone. */
const withMediaDevices = (listed = ['mic-usb', 'mic-bt']) => {
  const tracks: ReturnType<typeof fakeTrack>[] = []
  // `exact` on a device the browser does not have fails, as in a browser; `audio: true` opens the default one.
  const getUserMedia = vi.fn(async (c: { audio: true | { deviceId: { exact: string } } }) => {
    const wanted = c.audio === true ? undefined : c.audio.deviceId.exact
    if (wanted && !listed.includes(wanted)) throw Object.assign(new Error('no such device'), { name: 'OverconstrainedError' })
    const track = fakeTrack(wanted ?? 'mic-default')
    tracks.push(track)
    return { getAudioTracks: () => [track], getTracks: () => [track] }
  })
  const enumerateDevices = vi.fn(async () => listed.map(id => ({ kind: 'audioinput', deviceId: id, label: id })))
  const listeners: (() => void)[] = []
  const addEventListener = vi.fn((_type: string, fn: () => void) => listeners.push(fn))
  const removeEventListener = vi.fn((_type: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices, addEventListener, removeEventListener } })
  const last = () => tracks[tracks.length - 1]!
  return { getUserMedia, tracks, last, listeners, removeEventListener, plug: () => listeners.forEach(fn => fn()), restore: () => vi.unstubAllGlobals() }
}

/** A page, for the gesture listeners the softphone arms while the browser blocks sound. */
const withDocument = () => {
  const listeners = new Map<string, Set<() => void>>()
  const addEventListener = vi.fn((type: string, fn: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type))!.add(fn))
  const removeEventListener = vi.fn((type: string, fn: () => void) => void listeners.get(type)?.delete(fn))
  vi.stubGlobal('document', { addEventListener, removeEventListener })
  return {
    addEventListener,
    removeEventListener,
    armed: () => [...listeners.entries()].filter(([, fns]) => fns.size).map(([type]) => type),
    // `once` listeners: gone as they fire.
    fire: (type: string) => {
      const fns = [...(listeners.get(type) ?? [])]
      listeners.get(type)?.clear()
      fns.forEach(fn => fn())
    },
    restore: () => vi.unstubAllGlobals()
  }
}

describe('Softphone', () => {
  it('registers as the identity the Gateway gave, with the display name and the secret', async () => {
    const { configs, registration, ua } = await setup()
    expect(configs[0]).toMatchObject({ uri: 'sip:101@sip.test', password: 'pw', display_name: 'Alice', register: true, sockets: { url: 'wss://sip.test:443/ws' } })
    expect(ua().start).toHaveBeenCalled()
    ua().registered = true
    ua().emit('registered', {})
    expect(registration).toEqual(['registered'])
    ua().emit('disconnected', { error: true, reason: 'gone' })
    expect(registration).toEqual(['registered', 'unregistered'])
  })

  it('places a call to the SIP domain and follows it from dialing to connected to ended', async () => {
    const { phone, ua, changes } = await setup()
    const call = await phone.call('102')
    expect(ua().call).toHaveBeenCalledWith('sip:102@sip.test', expect.objectContaining({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [{ urls: ['stun:stun.test'] }] } }))
    expect(call.state).toBe('new')
    expect(call.remoteNumber).toBe('102')
    expect(call.remoteName).toBe('Bob')
    const s = ua().lastCall!
    s.emit('progress', { originator: 'remote' })
    s.emit('accepted', { originator: 'remote' })
    s.emit('confirmed', { originator: 'local' })
    expect(call.state).toBe('connected')
    expect(call.connectedAt).toBeInstanceOf(Date)
    expect(phone.activeCalls()).toHaveLength(1)
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    expect(call.state).toBe('ended')
    expect(call.endReason).toBe('hangup')
    expect(phone.activeCalls()).toHaveLength(0)
    expect(changes).toEqual(['outbound:new', 'outbound:ringing', 'outbound:connected', 'outbound:ended'])
  })

  it('reports why a call did not go through', async () => {
    const { phone, ua } = await setup()
    const busy = await phone.call('102')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Busy' })
    expect(busy.endReason).toBe('busy')
    const nobody = await phone.call('103')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Not Found' })
    expect(nobody.endReason).toBe('unavailable')
    const cancelled = await phone.call('104')
    ua().lastCall!.emit('failed', { originator: 'local', cause: 'Canceled' })
    expect(cancelled.endReason).toBe('cancelled')
    // A 408 is a no answer (JsSIP counts it as unavailable); a 477, nobody there.
    const late = await phone.call('102')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Unavailable', message: { status_code: 408, reason_phrase: 'Request Timeout', getHeader: () => undefined } })
    expect([late.endReason, late.endStatus]).toEqual(['no-answer', 408])
    const dead = await phone.call('102')
    ua().lastCall!.emit('failed', { originator: 'system', cause: 'SIP Failure Code', message: { status_code: 477, reason_phrase: 'Send failed', getHeader: () => undefined } })
    expect([dead.endReason, dead.endStatus]).toEqual(['unavailable', 477])
  })

  it('tells a call refused by a "do not disturb" from a plain 480, with the message the person called left', async () => {
    const { phone, ua } = await setup()
    const response = (reason_phrase: string, headers: Record<string, string> = {}) => ({ status_code: 480, reason_phrase, getHeader: (name: string) => headers[name] })
    const dnd = await phone.call('102')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Unavailable', message: response('Do Not Disturb', { 'Twake-Dnd': '1', 'Twake-Dnd-Message': ' En réunion jusqu’à 16 h ' }) })
    expect([dnd.endReason, dnd.endStatus, dnd.endMessage]).toEqual(['dnd', 480, 'En réunion jusqu’à 16 h'])
    const silent = await phone.call('102')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Unavailable', message: response('Do Not Disturb', { 'Twake-Dnd': '1' }) })
    expect([silent.endReason, silent.endMessage]).toEqual(['dnd', undefined])
    // The header decides, not the reason phrase, which a proxy on the way may rewrite.
    const rewritten = await phone.call('102')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Unavailable', message: response('Temporarily Unavailable', { 'Twake-Dnd': '1' }) })
    expect(rewritten.endReason).toBe('dnd')
    // Nobody there: the usual 480, whatever reason phrase or message it carries.
    const away = await phone.call('103')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Unavailable', message: response('Do Not Disturb', { 'Twake-Dnd-Message': 'x' }) })
    expect([away.endReason, away.endMessage]).toEqual(['unavailable', undefined])
  })

  it('tells a number the SIP server does not put through to the public network, and why', async () => {
    const { phone, ua } = await setup()
    const response = (status_code: number, headers: Record<string, string> = {}) => ({ status_code, reason_phrase: 'x', getHeader: (name: string) => headers[name] })
    for (const [number, status, word, refusal] of [
      ['112', 403, 'emergency', 'emergency'],
      ['0899000000', 403, 'premium', 'premium'],
      ['+442079460123', 403, ' International ', 'international'],
      ['+262262000000', 403, 'overseas', 'overseas'],
      ['063998', 484, 'invalid', 'invalid'],
      ['0639980001', 503, 'no-trunk', 'no-trunk'],
      // Step 6b: the caller's rights profile, a cap reached, a volume threshold crossed.
      ['+442079460124', 403, 'rights', 'rights'],
      ['0199000004', 403, 'limit', 'limit'],
      ['0199000005', 403, 'fraud', 'fraud'],
      // Review 6b, n°2: the rules not read in time (503): its own reason, not "no trunk".
      ['0199000006', 503, 'policy-unavailable', 'policy-unavailable'],
      ['0639980002', 403, 'satellite', 'not-allowed']
    ] as const) {
      const call = await phone.call(number)
      ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Rejected', message: response(status, { 'Twake-Call-Refused': word }) })
      expect([call.endReason, call.endStatus, call.endRefusal], number).toEqual(['refused', status, refusal])
    }
    // Without the header, or with another status, the usual reasons.
    const plain = await phone.call('0639980003')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Rejected', message: response(403) })
    expect([plain.endReason, plain.endRefusal]).toEqual(['rejected', undefined])
    const busy = await phone.call('0639980004')
    ua().lastCall!.emit('failed', { originator: 'remote', cause: 'Busy', message: response(486, { 'Twake-Call-Refused': 'premium' }) })
    expect([busy.endReason, busy.endRefusal]).toEqual(['busy', undefined])
  })

  it('shows who answered a call it placed, as the SIP server asserts it (a member of a ring group), and transfers the call as placed', async () => {
    const { phone, ua } = await setup()
    const call = await phone.call('200')
    const s = ua().lastCall!
    const response = (headers: Record<string, string>) => ({ status_code: 200, getHeader: (name: string) => headers[name] })
    s.emit('accepted', { originator: 'remote', response: response({ 'P-Asserted-Identity': '"Jean Dupont" <sip:102@sip.test>' }) })
    expect([call.remoteNumber, call.remoteName]).toEqual(['102', 'Jean Dupont'])
    expect((call as unknown as { remoteUri: string }).remoteUri).toBe(s.remote_identity.uri.toString())
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    // Nothing asserted, or nothing readable: what the call was placed to stays.
    const plain = await phone.call('103')
    const placed = [plain.remoteNumber, plain.remoteName]
    ua().lastCall!.emit('accepted', { originator: 'remote', response: response({ 'P-Asserted-Identity': '<tel:+33612345678>' }) })
    expect([plain.remoteNumber, plain.remoteName]).toEqual(placed)
  })

  it('tells a ringing call another phone took (CANCEL with Reason cause 200) from one the caller gave up', async () => {
    const { ua, incoming } = await setup()
    const cancel = (reason?: string) => ({ method: 'CANCEL', getHeader: (name: string) => (name === 'Reason' ? reason : undefined) })
    const taken = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: taken })
    taken.emit('failed', { originator: 'remote', cause: 'Canceled', message: cancel('SIP ;cause=200 ;text="Call completed elsewhere"') })
    expect(incoming[0]!.endReason).toBe('answered-elsewhere')
    const given = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: given })
    given.emit('failed', { originator: 'remote', cause: 'Canceled', message: cancel('SIP;cause=487;text="ORIGINATOR_CANCEL"') })
    expect(incoming[1]!.endReason).toBe('cancelled')
  })

  it('refuses a target that is not a dialable string', async () => {
    const { phone } = await setup()
    await expect(phone.call('102; DROP')).rejects.toThrow(/Invalid target/)
  })

  it('hands an incoming call to the app ringing, answers it with audio and attaches the remote track', async () => {
    const { ua, incoming, changes } = await setup()
    const s = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: s })
    expect(incoming).toHaveLength(1)
    const call = incoming[0]!
    expect(call.direction).toBe('inbound')
    expect(call.state).toBe('ringing')
    expect(call.remoteNumber).toBe('102')
    await call.answer()
    expect(s.answer).toHaveBeenCalledWith(expect.objectContaining({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [{ urls: ['stun:stun.test'] }] } }))
    const track = { kind: 'audio' }
    ;(s.connection as ReturnType<typeof fakePc>).fire('track', { track, streams: [{ id: 'remote' }] })
    expect(audios[audios.length - 1]!.srcObject).toEqual({ id: 'remote' })
    s.emit('accepted', { originator: 'local' })
    expect(call.state).toBe('connected')
    expect(changes).toEqual(['inbound:ringing', 'inbound:connected'])
  })

  it('rejects a ringing incoming call with 603 Decline, hangs up an established one with BYE', async () => {
    const { ua, incoming } = await setup()
    const s = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: s })
    await incoming[0]!.reject()
    expect(s.terminate).toHaveBeenCalledWith({ status_code: 603, reason_phrase: 'Decline' })
    // JsSIP reports the refusal; until then the call is still active and a second caller would hear busy.
    s.emit('failed', { originator: 'local', cause: 'Rejected' })
    const s2 = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: s2 })
    s2.emit('accepted', { originator: 'local' })
    await incoming[1]!.hangup()
    expect(s2.terminate).toHaveBeenCalledWith()
  })

  it('holds and resumes when the SIP server confirms, and shows a hold put by the far end', async () => {
    const { phone, ua, changes } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    const held = call.hold()
    expect(s.hold).toHaveBeenCalled()
    s.emit('hold', { originator: 'local' })
    expect(call.state).toBe('held')
    expect(call.renegotiating).toBe(true)
    s.reofferDone!()
    await held
    expect(call.renegotiating).toBe(false)
    const resumed = call.resume()
    s.emit('unhold', { originator: 'local' })
    s.reofferDone!()
    await resumed
    expect(call.state).toBe('connected')
    s.emit('hold', { originator: 'remote' })
    expect(call.remoteHold).toBe(true)
    expect(call.state).toBe('connected')
    s.emit('unhold', { originator: 'remote' })
    expect(call.remoteHold).toBe(false)
    // Each offer of ours is visible while it waits for its answer (the UI greys the button out).
    expect(changes).toEqual(['outbound:new', 'outbound:connected', 'outbound:connected:offer', 'outbound:held:offer', 'outbound:held', 'outbound:held:offer', 'outbound:connected:offer', 'outbound:connected', 'outbound:connected:remoteHold', 'outbound:connected'])
  })

  it('retries a resume that JsSIP refuses while the hold is still unanswered, and gives up when the call ends', async () => {
    const { phone, ua } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    s.unhold.mockImplementationOnce(() => false)
    s.emit('hold', { originator: 'local' })
    const resumed = call.resume()
    await new Promise(r => setTimeout(r, 150))
    expect(s.unhold).toHaveBeenCalledTimes(2)
    s.reofferDone!()
    s.emit('unhold', { originator: 'local' })
    await resumed
    const held = call.hold()
    expect(call.renegotiating).toBe(true)
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    await expect(held).rejects.toThrow('Call ended')
    expect(call.renegotiating).toBe(false)
  })

  it('mutes the microphone, sends tones in the RTP stream by default and reports tones the far end sent by INFO', async () => {
    const { phone, ua, tones } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    call.setMuted(true)
    expect(call.muted).toBe(true)
    call.setMuted(false)
    expect(call.muted).toBe(false)
    call.sendDtmf('5')
    expect(s.sendDTMF).toHaveBeenCalledWith('5', { transportType: 'RFC2833' })
    call.sendDtmf('#', 'INFO')
    expect(s.sendDTMF).toHaveBeenLastCalledWith('#', { transportType: 'INFO' })
    expect(() => call.sendDtmf('x')).toThrow(/Invalid DTMF/)
    s.emit('newDTMF', { originator: 'remote', dtmf: { tone: '7' } })
    s.emit('newDTMF', { originator: 'local', dtmf: { tone: '8' } })
    expect(tones).toEqual(['7'])
    expect(await call.stats()).toEqual({ packetsReceived: 42, packetsSent: 7, microphoneId: 'mic-default' })
  })

  it('places a consultation during a call: the call in progress is held first, a third call is refused', async () => {
    const { phone, ua, changes } = await setup()
    const first = await phone.call('102')
    const s1 = ua().lastCall!
    s1.emit('accepted', { originator: 'remote' })
    const consulting = phone.call('103')
    expect(s1.hold).toHaveBeenCalled()
    expect(ua().call).toHaveBeenCalledTimes(1)
    s1.emit('hold', { originator: 'local' })
    s1.reofferDone!()
    const second = await consulting
    expect(ua().call).toHaveBeenLastCalledWith('sip:103@sip.test', expect.anything())
    expect(first.state).toBe('held')
    expect(second.state).toBe('new')
    expect(second.consultationOf).toBe(first.id)
    expect(first.consultationOf).toBeUndefined()
    expect(phone.activeCalls()).toHaveLength(2)
    await expect(phone.call('104')).rejects.toMatchObject({ code: 'too-many-calls' })
    expect(changes).toEqual(['outbound:new', 'outbound:connected', 'outbound:connected:offer', 'outbound:held:offer', 'outbound:held', 'outbound:new'])
  })

  it('takes the held call back when the consultation is over without a transfer (nobody there, or hung up)', async () => {
    const { phone, ua } = await setup()
    const first = await phone.call('102')
    const s1 = ua().lastCall!
    s1.emit('accepted', { originator: 'remote' })
    const consulting = phone.call('105')
    s1.emit('hold', { originator: 'local' })
    s1.reofferDone!()
    const second = await consulting
    const s2 = ua().lastCall!
    s2.emit('failed', { originator: 'remote', cause: 'Not Found', message: { status_code: 404 } })
    expect(second.endReason).toBe('unavailable')
    // The person who waited is resumed by the softphone itself, no click needed.
    expect(s1.unhold).toHaveBeenCalled()
    s1.emit('unhold', { originator: 'local' })
    s1.reofferDone!()
    await new Promise(r => setTimeout(r, 0))
    expect(first.state).toBe('connected')
    expect(phone.activeCalls()).toEqual([first])
  })

  it('does not take the held call back when a transfer to the consultation is on its way', async () => {
    const { phone, ua } = await setup()
    const first = await phone.call('102')
    const s1 = ua().lastCall!
    s1.emit('accepted', { originator: 'remote' })
    const consulting = phone.call('103')
    s1.emit('hold', { originator: 'local' })
    s1.reofferDone!()
    const second = await consulting
    const s2 = ua().lastCall!
    s2.emit('accepted', { originator: 'remote' })
    const transfer = first.transferTo(second)
    await Promise.resolve()
    expect(first.transferring).toBe(true)
    // The far end of the consultation hangs it up once the replacing call is through.
    s2.emit('ended', { originator: 'remote', cause: 'Terminated' })
    expect(s1.unhold).not.toHaveBeenCalled()
    s1.referSubscriber!.emit('accepted', { status_line: { status_code: '200', reason_phrase: 'OK' } })
    await transfer
    expect(s1.terminate).toHaveBeenCalledWith()
    expect(s1.unhold).not.toHaveBeenCalled()
  })

  it('transfers blind: holds, refers, ends the call as transferred once the far end got through', async () => {
    const { phone, ua } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    const transfer = call.transfer('103')
    await Promise.resolve()
    s.emit('hold', { originator: 'local' })
    s.reofferDone!()
    await Promise.resolve()
    await Promise.resolve()
    expect(s.refer).toHaveBeenCalledWith('sip:103@sip.test', {})
    expect(call.transferring).toBe(true)
    s.referSubscriber!.emit('accepted', { status_line: { status_code: '200', reason_phrase: 'OK' } })
    await transfer
    expect(s.terminate).toHaveBeenCalledWith()
    s.emit('ended', { originator: 'local', cause: 'Terminated' })
    expect(call.endReason).toBe('transferred')
  })

  it('resumes the call and says why when the transfer target does not answer', async () => {
    const { phone, ua } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    const transfer = call.transfer('105')
    await Promise.resolve()
    s.emit('hold', { originator: 'local' })
    s.reofferDone!()
    await Promise.resolve()
    await Promise.resolve()
    s.referSubscriber!.emit('failed', { status_line: { status_code: '404', reason_phrase: 'Not Found' } })
    await new Promise(r => setTimeout(r, 0))
    expect(s.unhold).toHaveBeenCalled()
    s.emit('unhold', { originator: 'local' })
    s.reofferDone!()
    await expect(transfer).rejects.toMatchObject({ code: 'transfer-failed', status: 404, reason: 'unavailable', message: 'Transfer failed: 404 Not Found' })
    expect(call.state).toBe('connected')
    expect(s.terminate).not.toHaveBeenCalled()
    expect(call.transferring).toBe(false)
  })

  it('resumes the call when the SIP server refuses the REFER, or when nothing is reported in time', async () => {
    vi.useFakeTimers()
    try {
      const { phone, ua } = await setup()
      const call = await phone.call('102')
      const s = ua().lastCall!
      s.emit('accepted', { originator: 'remote' })
      const refused = call.transfer('103')
      await Promise.resolve()
      s.emit('hold', { originator: 'local' })
      s.reofferDone!()
      await Promise.resolve()
      await Promise.resolve()
      s.referSubscriber!.emit('requestFailed', { response: { status_code: 403, reason_phrase: 'Forbidden' }, cause: 'Rejected' })
      await Promise.resolve()
      s.emit('unhold', { originator: 'local' })
      s.reofferDone!()
      await expect(refused).rejects.toMatchObject({ code: 'transfer-refused', status: 403, reason: 'rejected' })
      expect(call.state).toBe('connected')
      // A call with the public network: the SIP server says it transfers none (step 6a), the app says so.
      const external = call.transfer('105')
      await Promise.resolve()
      s.emit('hold', { originator: 'local' })
      s.reofferDone!()
      await Promise.resolve()
      await Promise.resolve()
      s.referSubscriber!.emit('requestFailed', { response: { status_code: 403, reason_phrase: 'Transfer Not Allowed', getHeader: (name: string) => (name === 'Twake-Call-Refused' ? 'transfer-external' : undefined) }, cause: 'Rejected' })
      await Promise.resolve()
      s.emit('unhold', { originator: 'local' })
      s.reofferDone!()
      await expect(external).rejects.toMatchObject({ code: 'transfer-external', status: 403 })
      expect(call.state).toBe('connected')
      const silent = call.transfer('104')
      await Promise.resolve()
      s.emit('hold', { originator: 'local' })
      s.reofferDone!()
      await Promise.resolve()
      await Promise.resolve()
      expect(call.transferring).toBe(true)
      // The far end rings the target on and on, or never sends the final report: the person gets the call back.
      await vi.advanceTimersByTimeAsync(30_000)
      s.emit('unhold', { originator: 'local' })
      s.reofferDone!()
      await expect(silent).rejects.toMatchObject({ code: 'transfer-no-answer', reason: 'no-answer' })
      expect(call.transferring).toBe(false)
      expect(s.terminate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a transfer the far end hung up on before reporting, as a failure', async () => {
    const { phone, ua } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    const transfer = call.transfer('103')
    await Promise.resolve()
    s.emit('hold', { originator: 'local' })
    s.reofferDone!()
    await Promise.resolve()
    await Promise.resolve()
    expect(call.transferring).toBe(true)
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    await expect(transfer).rejects.toMatchObject({ code: 'call-ended' })
    expect(call.transferring).toBe(false)
    expect(call.endReason).toBe('hangup')
  })

  it('transfers attended: refers the held call to the consultation with Replaces, then ends it', async () => {
    const { phone, ua } = await setup()
    const first = await phone.call('102')
    const s1 = ua().lastCall!
    s1.emit('accepted', { originator: 'remote' })
    const consulting = phone.call('103')
    s1.emit('hold', { originator: 'local' })
    s1.reofferDone!()
    const second = await consulting
    const s2 = ua().lastCall!
    s2.remote_identity = { uri: { user: '103', host: 'sip.test', toString: () => 'sip:103@sip.test' }, display_name: '' }
    s2.emit('accepted', { originator: 'remote' })
    await expect(first.transferTo(first)).rejects.toMatchObject({ code: 'transfer-self' })
    const transfer = first.transferTo(second)
    await Promise.resolve()
    // Refer-To is the consultation's far end (not the transferred call's), with the consultation's dialog to replace.
    expect(s1.refer).toHaveBeenCalledWith('sip:103@sip.test', { replaces: s2 })
    expect(s1.refer).not.toHaveBeenCalledWith('sip:102@sip.test', expect.anything())
    s1.referSubscriber!.emit('accepted', { status_line: { status_code: '200', reason_phrase: 'OK' } })
    await transfer
    expect(s1.terminate).toHaveBeenCalledWith()
    // The consultation is ended by its far end once the replacing call is through (JsSIP does it, RFC 3891).
    expect(s2.terminate).not.toHaveBeenCalled()
  })

  it('takes the held call back when an attended transfer fails after the consultation is gone', async () => {
    const { phone, ua } = await setup()
    const first = await phone.call('102')
    const s1 = ua().lastCall!
    s1.emit('accepted', { originator: 'remote' })
    const consulting = phone.call('103')
    s1.emit('hold', { originator: 'local' })
    s1.reofferDone!()
    const second = await consulting
    const s2 = ua().lastCall!
    s2.emit('accepted', { originator: 'remote' })
    const transfer = first.transferTo(second)
    await Promise.resolve()
    // The colleague hung up the consultation just before: the replacing INVITE gets 481, reported by NOTIFY.
    s2.emit('ended', { originator: 'remote', cause: 'Terminated' })
    s1.referSubscriber!.emit('failed', { status_line: { status_code: '481', reason_phrase: 'Call/Transaction Does Not Exist' } })
    await Promise.resolve()
    expect(s1.unhold).toHaveBeenCalled()
    s1.emit('unhold', { originator: 'local' })
    s1.reofferDone!()
    await expect(transfer).rejects.toMatchObject({ code: 'transfer-failed', status: 481, reason: 'failed' })
    expect(first.state).toBe('connected')
    expect(s1.terminate).not.toHaveBeenCalled()
  })

  it('follows a transfer asked by the far end (REFER) and takes an INVITE with Replaces as the new far end', async () => {
    const { phone, ua, incoming, changes } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    // REFER from 102: we call whom it names; JsSIP builds that session and announces it as ours.
    const accept = vi.fn((_init: unknown, options: { mediaConstraints: unknown; extraHeaders?: string[] }) => {
      expect(options.mediaConstraints).toEqual({ audio: true, video: false })
      expect(options.extraHeaders).toEqual(['Referred-By: <sip:102@sip.test>'])
      ua().emit('newRTCSession', { originator: 'local', session: new FakeSession('outgoing') })
    })
    const referTo = (user: string, host = 'sip.test') => ({ refer_to: { uri: { user, host } }, getHeader: (name: string) => (name === 'Referred-By' ? '<sip:102@sip.test>' : undefined) })
    // Only a dialable target of our own domain is followed: a REFER cannot make this phone call anywhere else.
    const reject = vi.fn()
    s.emit('refer', { request: referTo('103', 'elsewhere.example'), accept, reject })
    s.emit('refer', { request: referTo('+33 1 02', 'sip.test'), accept, reject })
    s.emit('refer', { request: {}, accept, reject })
    expect(reject).toHaveBeenCalledTimes(3)
    expect(accept).not.toHaveBeenCalled()
    s.emit('refer', { request: referTo('103'), accept, reject })
    // Accepted once our microphone is open (JsSIP has already said 202).
    await new Promise(r => setTimeout(r, 0))
    expect(accept).toHaveBeenCalled()
    expect(phone.activeCalls()).toHaveLength(2)
    // The call JsSIP placed for the REFER is announced like one of ours, before anything happens to it.
    expect(changes).toContain('outbound:new')
    expect(phone.activeCalls()[1]?.consultationOf).toBeUndefined()
    expect(incoming).toHaveLength(0)
    // A third call is one too many: the REFER is refused (reported 603 to the far end).
    s.emit('refer', { request: referTo('104'), accept, reject })
    expect(reject).toHaveBeenCalledTimes(4)
    // INVITE with Replaces for our first call: answered at once, no ringing, and it says whom it replaced.
    const replacing = new FakeSession('incoming')
    s.emit('replaces', { request: {}, accept: (init: (s: unknown) => void) => { init(replacing); ua().emit('newRTCSession', { originator: 'remote', session: replacing }) }, reject: vi.fn() })
    await new Promise(r => setTimeout(r, 5))
    expect(replacing.answer).toHaveBeenCalled()
    expect(incoming).toHaveLength(0)
    const replacer = phone.activeCalls().find(c => c.replacedCallId === call.id)
    expect(replacer?.direction).toBe('inbound')
    expect(changes).toContain('inbound:ringing')
  })

  it('rings while a call rings in, with the chosen output, and stops when it is answered or gone', async () => {
    const { phone, ua, ringer, incoming } = await setup({ devices: { outputId: 'speaker', ringerId: 'bell' } })
    const s = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: s })
    await Promise.resolve()
    expect(ringer.ringing).toBe(true)
    expect(ringer.sink).toBe('bell')
    await incoming[0]!.answer()
    s.emit('accepted', { originator: 'local' })
    expect(ringer.ringing).toBe(false)
    // The voice goes to the chosen output, the ringtone to its own.
    expect(audios[audios.length - 1]!.sinkId).toBe('speaker')
    const s2 = new FakeSession('incoming')
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    ua().emit('newRTCSession', { originator: 'remote', session: s2 })
    expect(ringer.ringing).toBe(true)
    // Answered in another window: the SIP server cancels this one.
    s2.emit('failed', { originator: 'remote', cause: 'Canceled' })
    expect(ringer.ringing).toBe(false)
    expect(incoming[1]!.endReason).toBe('cancelled')
    await phone.stop()
    expect(ringer.disposed).toBe(true)
  })

  it("names each call by its INVITE's Call-ID as well (sipCallId: what the SIP server and the Gateway call it, step 8b), not by JsSIP's id", async () => {
    const { phone, ua } = await setup()
    ua().call.mockImplementationOnce((_target: string) => {
      const s = new FakeSession('outgoing')
      ua().lastCall = s
      ua().emit('newRTCSession', { originator: 'local', session: s, request: { call_id: 'out-1@192.0.2.1' } })
      return s as never
    })
    const placed = await phone.call('102')
    expect(placed.sipCallId).toBe('out-1@192.0.2.1')
    expect(placed.id).not.toBe(placed.sipCallId)
    ua().lastCall!.emit('ended', { originator: 'remote', cause: 'Terminated' })
    const s = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: s, request: { call_id: 'in-1@192.0.2.2', getHeader: () => undefined } })
    expect(phone.activeCalls()[0]!.sipCallId).toBe('in-1@192.0.2.2')
  })

  it('answers the room of the conference it asked for (step 8b), in this window only, keeps the call quiet meanwhile, and ends it as a conference once its far end moved', async () => {
    const { phone, ua, ringer, incoming } = await setup()
    const its = audios.length
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    expect(() => phone.expectConference('nope')).toThrow(expect.objectContaining({ code: 'not-established' }))
    const token = phone.expectConference(call.id)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    const invite = (headers: Record<string, string | undefined>) => {
      const session = new FakeSession('incoming')
      ua().emit('newRTCSession', { originator: 'remote', session, request: { getHeader: (name: string) => headers[name] } })
      return session
    }
    // Another token, or one without the room's word: no such call (481, never a refusal that would end the others).
    for (const headers of [{ 'Twake-Join': 'f'.repeat(32), 'Twake-Room': 'conference' }, { 'Twake-Join': token }, { 'Twake-Join': token, 'Twake-Room': 'meet' }]) {
      const other = invite(headers)
      expect(other.terminate, JSON.stringify(headers)).toHaveBeenCalledWith({ status_code: 481, reason_phrase: 'Call Does Not Exist' })
    }
    const room = invite({ 'Twake-Join': token, 'Twake-Room': 'conference' })
    expect(room.terminate).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 5))
    expect(room.answer).toHaveBeenCalled()
    expect(ringer.start).not.toHaveBeenCalled()
    expect(incoming).toHaveLength(0)
    const joined = phone.activeCalls().find(c => c.conferenceOf === call.id)!
    expect(joined.room).toBe('conference')
    // Through: the call goes quiet (our microphone and its far end's voice), the room carries both now.
    room.emit('accepted', { originator: 'local' })
    expect(s.mute).toHaveBeenCalledWith({ audio: true })
    expect((audios[its] as unknown as { muted?: boolean }).muted).toBe(true)
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    expect(call.endReason).toBe('conference')
    // Used: the token answers nothing more.
    expect(invite({ 'Twake-Join': token, 'Twake-Room': 'conference' }).terminate).toHaveBeenCalledWith({ status_code: 481, reason_phrase: 'Call Does Not Exist' })
    expect(joined.state).toBe('connected')
  })

  it('takes the call back as it was when the room of the conference ends before its far end moved, or forgets it when asked (step 8b)', async () => {
    const { phone, ua } = await setup()
    const its = audios.length
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    const room = new FakeSession('incoming')
    const token = phone.expectConference(call.id)
    ua().emit('newRTCSession', { originator: 'remote', session: room, request: { getHeader: (name: string) => ({ 'Twake-Join': token, 'Twake-Room': 'conference' })[name] } })
    room.emit('accepted', { originator: 'local' })
    expect(call.muted).toBe(true)
    room.emit('ended', { originator: 'remote', cause: 'Terminated' })
    expect(s.unmute).toHaveBeenCalledWith({ audio: true })
    expect(call.muted).toBe(false)
    expect((audios[its] as unknown as { muted?: boolean }).muted).toBe(false)
    // Asked again, then given up (the Gateway said no): its room's call is not answered.
    const again = phone.expectConference(call.id)
    phone.cancelConference()
    const late = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: late, request: { getHeader: (name: string) => ({ 'Twake-Join': again, 'Twake-Room': 'conference' })[name] } })
    expect(late.terminate).toHaveBeenCalledWith({ status_code: 481, reason_phrase: 'Call Does Not Exist' })
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    expect(call.endReason).toBe('hangup')
  })

  it("ends our call as a conference when the room of the far end's conference takes its place (Replaces, step 8b)", async () => {
    const { phone, ua } = await setup()
    const call = await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    const replacing = new FakeSession('incoming')
    const request = { getHeader: (name: string) => (name === 'Twake-Room' ? 'conference' : undefined) }
    s.emit('replaces', { request, accept: (init: (s: unknown) => void) => { init(replacing); ua().emit('newRTCSession', { originator: 'remote', session: replacing, request }) }, reject: vi.fn() })
    await new Promise(r => setTimeout(r, 5))
    expect(replacing.answer).toHaveBeenCalled()
    const room = phone.activeCalls().find(c => c.replacedCallId === call.id)!
    expect(room.room).toBe('conference')
    replacing.emit('accepted', { originator: 'local' })
    // JsSIP ends the call it replaced once the new one is confirmed.
    s.emit('ended', { originator: 'local', cause: 'Terminated' })
    expect(call.endReason).toBe('conference')
  })

  it('neither holds nor transfers a call a room places, nor calls anyone during it (step 8b)', async () => {
    const { phone, ua, incoming } = await setup()
    const s = new FakeSession('incoming')
    ua().emit('newRTCSession', { originator: 'remote', session: s, request: { getHeader: (name: string) => (name === 'Twake-Room' ? 'meet' : undefined) } })
    const call = incoming[0]!
    expect(call.room).toBe('meet')
    await call.answer()
    s.emit('accepted', { originator: 'local' })
    await expect(call.hold()).rejects.toMatchObject({ code: 'room-call' })
    await expect(call.transfer('103')).rejects.toMatchObject({ code: 'room-call' })
    await expect(phone.call('103')).rejects.toMatchObject({ code: 'room-call' })
    expect(() => phone.expectConference(call.id)).toThrow(expect.objectContaining({ code: 'room-call' }))
    expect(s.hold).not.toHaveBeenCalled()
    expect(s.refer).not.toHaveBeenCalled()
    // A plain call says no room.
    const plain = new FakeSession('incoming')
    s.emit('ended', { originator: 'remote', cause: 'Terminated' })
    ua().emit('newRTCSession', { originator: 'remote', session: plain, request: { getHeader: () => undefined } })
    expect(incoming[1]!.room).toBeUndefined()
  })

  it('does not ring for an INVITE with Replaces, answered at once', async () => {
    const { phone, ua, ringer } = await setup()
    await phone.call('102')
    const s = ua().lastCall!
    s.emit('accepted', { originator: 'remote' })
    const replacing = new FakeSession('incoming')
    s.emit('replaces', { request: {}, accept: (init: (s: unknown) => void) => { init(replacing); ua().emit('newRTCSession', { originator: 'remote', session: replacing }) }, reject: vi.fn() })
    expect(ringer.start).not.toHaveBeenCalled()
    // The answer comes a tick later: it belongs to this test, not to the next one.
    await new Promise(r => setTimeout(r, 5))
    expect(replacing.answer).toHaveBeenCalled()
  })

  it('says when the browser blocks sound until a gesture, and plays once the app says the person clicked', async () => {
    const { phone, ua, ringer, blocked } = await setup()
    ringer.blocked = true
    ua().emit('newRTCSession', { originator: 'remote', session: new FakeSession('incoming') })
    await Promise.resolve()
    await Promise.resolve()
    expect(blocked).toEqual([true])
    expect(phone.soundBlocked).toBe(true)
    expect(await phone.unblockAudio()).toBe(false)
    ringer.blocked = false
    expect(await phone.unblockAudio()).toBe(true)
    expect(blocked).toEqual([true, false])
    // A test ring from the settings screen reports the same way.
    expect(await phone.ringTest(1)).toBe(true)
  })

  it('uses the chosen microphone for calls, switches it during a call and comes back from an unplugged headset', async () => {
    const media = withMediaDevices()
    try {
      const { phone, ua } = await setup({ devices: { microphoneId: 'mic-usb' } })
      await phone.call('102')
      // The softphone opened the chosen microphone itself and handed its stream to JsSIP.
      expect(media.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-usb' } } })
      expect(ua().call).toHaveBeenCalledWith('sip:102@sip.test', expect.objectContaining({ mediaStream: expect.objectContaining({ getAudioTracks: expect.any(Function) }), mediaConstraints: { audio: true, video: false } }))
      const s = ua().lastCall!
      const pc = s.connection as ReturnType<typeof fakePc>
      const first = media.last()
      pc.sender.track = first
      s.emit('accepted', { originator: 'remote' })
      // The same microphone again: nothing to reopen.
      await phone.setDevices({ microphoneId: 'mic-usb', outputId: 'speaker' })
      expect(media.getUserMedia).toHaveBeenCalledTimes(1)
      // The person picks another microphone in the settings: the call goes on with it, no renegotiation.
      await phone.setDevices({ microphoneId: 'mic-bt', outputId: 'speaker' })
      expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-bt' } } })
      expect(pc.sender.replaceTrack).toHaveBeenCalled()
      expect(pc.sender.track.getSettings().deviceId).toBe('mic-bt')
      expect(first.stop).toHaveBeenCalled()
      expect(audios[audios.length - 1]!.sinkId).toBe('speaker')
      // Muted calls stay muted on the new microphone.
      phone.activeCalls()[0]!.setMuted(true)
      const current = pc.sender.track
      current.unplug()
      await new Promise(r => setTimeout(r, 0))
      expect(media.getUserMedia).toHaveBeenCalledTimes(3)
      expect(pc.sender.track).not.toBe(current)
      expect(pc.sender.track.enabled).toBe(false)
      expect(current.stop).toHaveBeenCalled()
      expect(phone.audioDevices).toEqual({ microphoneId: 'mic-bt', outputId: 'speaker' })
      // A chosen microphone the browser no longer has: the default one instead of a failed call.
      await phone.setDevices({ microphoneId: 'mic-gone' })
      expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: true })
      expect(pc.sender.track.getSettings().deviceId).toBe('mic-default')
      // The call over, the microphone the softphone opened is let go (JsSIP only stops what it opened itself).
      const final = pc.sender.track
      s.emit('ended', { originator: 'remote', cause: 'Terminated' })
      expect(final.stop).toHaveBeenCalled()
      expect(media.tracks.every(t => t.stop.mock.calls.length > 0)).toBe(true)
      await phone.call('103')
      expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: true })
      expect(ua().call).toHaveBeenLastCalledWith('sip:103@sip.test', expect.objectContaining({ mediaStream: expect.anything() }))
    } finally {
      media.restore()
    }
  })

  it('answers with the chosen microphone and stops it with the call', async () => {
    const media = withMediaDevices()
    try {
      const { ua, incoming } = await setup({ devices: { microphoneId: 'mic-bt' } })
      const s = new FakeSession('incoming')
      ua().emit('newRTCSession', { originator: 'remote', session: s })
      await incoming[0]!.answer()
      expect(media.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-bt' } } })
      expect(s.answer).toHaveBeenCalledWith(expect.objectContaining({ mediaStream: expect.anything(), mediaConstraints: { audio: true, video: false } }))
      s.emit('accepted', { originator: 'local' })
      s.emit('ended', { originator: 'remote', cause: 'Terminated' })
      expect(media.last().stop).toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('switches microphones one after the other: no live track is left behind', async () => {
    const media = withMediaDevices(['mic-usb', 'mic-bt', 'mic-x'])
    try {
      const { phone, ua } = await setup()
      await phone.call('102')
      const s = ua().lastCall!
      const pc = s.connection as ReturnType<typeof fakePc>
      pc.sender.track = media.last()
      s.emit('accepted', { originator: 'remote' })
      // Three choices in a row, none awaited: the settings screen, a device change and a headset gone at once.
      await Promise.all([phone.setDevices({ microphoneId: 'mic-usb' }), phone.setDevices({ microphoneId: 'mic-bt' }), phone.setDevices({ microphoneId: 'mic-x' })])
      const live = media.tracks.filter(t => !t.stop.mock.calls.length)
      expect(live).toEqual([pc.sender.track])
      expect(pc.sender.track.getSettings().deviceId).toBe('mic-x')
    } finally {
      media.restore()
    }
  })

  it('takes the chosen microphone up again when it is plugged back, and leaves a default one alone', async () => {
    const media = withMediaDevices(['mic-usb'])
    try {
      const { phone, ua } = await setup()
      await phone.call('102')
      const s = ua().lastCall!
      const pc = s.connection as ReturnType<typeof fakePc>
      pc.sender.track = media.last()
      s.emit('accepted', { originator: 'remote' })
      expect(media.listeners).toHaveLength(1)
      // No choice: a device plugged in changes nothing for the call.
      media.plug()
      await new Promise(r => setTimeout(r, 0))
      expect(media.getUserMedia).toHaveBeenCalledTimes(1)
      // The chosen headset was away when the call started (default microphone); it comes back: the call takes it.
      await phone.setDevices({ microphoneId: 'mic-usb' })
      expect(pc.sender.track.getSettings().deviceId).toBe('mic-usb')
      pc.sender.track = fakeTrack('mic-default')
      media.plug()
      await new Promise(r => setTimeout(r, 0))
      expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-usb' } } })
      expect(pc.sender.track.getSettings().deviceId).toBe('mic-usb')
      await phone.stop()
      expect(media.listeners).toHaveLength(0)
    } finally {
      media.restore()
    }
  })

  it('waits for the next click or key while sound is blocked, and again when that gesture did not unblock it', async () => {
    const page = withDocument()
    try {
      const { phone, ua, ringer, blocked } = await setup()
      ringer.blocked = true
      ua().emit('newRTCSession', { originator: 'remote', session: new FakeSession('incoming') })
      await Promise.resolve()
      await Promise.resolve()
      expect(phone.soundBlocked).toBe(true)
      expect(page.armed().sort()).toEqual(['click', 'keydown'])
      // A click the browser did not count as a gesture: still blocked, the next one is waited for again.
      page.fire('click')
      await new Promise(r => setTimeout(r, 0))
      expect(phone.soundBlocked).toBe(true)
      expect(page.armed().sort()).toEqual(['click', 'keydown'])
      ringer.blocked = false
      page.fire('keydown')
      await new Promise(r => setTimeout(r, 0))
      expect(phone.soundBlocked).toBe(false)
      expect(page.armed()).toEqual([])
      expect(blocked).toEqual([true, false])
    } finally {
      page.restore()
    }
  })

  it('does not take a playback cut short by the end of a call for a blocked sound', async () => {
    const { phone, ua, blocked } = await setup()
    await phone.call('102')
    const s = ua().lastCall!
    const pc = s.connection as ReturnType<typeof fakePc>
    const element = audios[audios.length - 1]!
    element.play.mockRejectedValueOnce(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
    pc.fire('track', { streams: [{}], track: {} })
    await new Promise(r => setTimeout(r, 0))
    expect(blocked).toEqual([])
    element.play.mockRejectedValueOnce(Object.assign(new Error('gesture'), { name: 'NotAllowedError' }))
    pc.fire('track', { streams: [{}], track: {} })
    await new Promise(r => setTimeout(r, 0))
    expect(blocked).toEqual([true])
    expect(phone.soundBlocked).toBe(true)
  })

  it('refuses tones outside a call', async () => {
    const { phone } = await setup()
    const call = await phone.call('102')
    expect(() => call.sendDtmf('1')).toThrow(/No call in progress/)
  })

  it('comes back with a fresh media session when the registration is refused', async () => {
    vi.useFakeTimers()
    try {
      const { ua, uas, getSession, registration } = await setup()
      ua().emit('registered', {})
      ua().emit('registrationFailed', { cause: 'Rejected', response: { status_code: 403 } })
      expect(registration).toEqual(['registered', 'failed'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(uas).toHaveLength(2)
      expect(getSession).toHaveBeenCalledTimes(2)
      expect(uas[0]!.stop).toHaveBeenCalled()
      expect(uas[1]!.start).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('registers the same Contact and instance after a restart: the new registration replaces the one left on a dead connection', async () => {
    vi.useFakeTimers()
    try {
      const { ua, uas, configs } = await setup()
      ua().emit('registered', {})
      // A REGISTER lost with its connection (the WebSocket cut while it was sent): a restart.
      ua().emit('registrationFailed', { cause: 'Connection Error' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(uas).toHaveLength(2)
      const [first, second] = configs as { contact_uri?: string; instance_id?: string }[]
      expect(first!.contact_uri).toMatch(/^sip:[a-z0-9]{8,}@[a-z0-9]{8,}\.invalid;transport=ws$/)
      expect(first!.instance_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(second!.contact_uri).toBe(first!.contact_uri)
      expect(second!.instance_id).toBe(first!.instance_id)
      // Another softphone (another window): its own.
      const other = await setup()
      expect((other.configs[0] as { contact_uri?: string }).contact_uri).not.toBe(first!.contact_uri)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart on a first failure to reach the server (JsSIP retries the socket itself)', async () => {
    vi.useFakeTimers()
    try {
      const { ua, uas } = await setup()
      ua().emit('registrationFailed', { cause: 'Connection Error' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(uas).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops cleanly: hangs up what is in progress, unregisters and waits for the server before stopping the user agent', async () => {
    const { phone, ua } = await setup()
    ua().registered = true
    await phone.call('102')
    const s = ua().lastCall!
    const stopped = phone.stop()
    expect(s.terminate).toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 0))
    expect(ua().unregister).toHaveBeenCalled()
    expect(ua().stop).not.toHaveBeenCalled()
    await stopped
    expect(ua().registered).toBe(false)
    expect(ua().stop).toHaveBeenCalled()
    await expect(phone.call('103')).rejects.toMatchObject({ code: 'not-started' })
  })
})

describe('assertedIdentity and answeredElsewhere', () => {
  it('reads the number and the quoted name of a SIP identity, and nothing else', () => {
    expect(assertedIdentity('"Jean Dupont" <sip:102@sip.test>')).toEqual({ number: '102', name: 'Jean Dupont' })
    expect(assertedIdentity('<sip:102@sip.test;transport=ws>;party=called')).toEqual({ number: '102', name: '' })
    expect(assertedIdentity('Jean <sip:102@sip.test>')).toBeUndefined()
    expect(assertedIdentity('"A \\"B" <sip:102@sip.test>')).toBeUndefined()
    expect(assertedIdentity('<sip:10 2@sip.test>')).toBeUndefined()
    expect(assertedIdentity(undefined)).toBeUndefined()
  })

  it('reads the cause of a Reason header as RFC 3326 writes it, spaces or not', () => {
    expect(answeredElsewhere('SIP ;cause=200 ;text="Call completed elsewhere"')).toBe(true)
    expect(answeredElsewhere('SIP;cause=200')).toBe(true)
    expect(answeredElsewhere('SIP;text="x";cause=200')).toBe(true)
    expect(answeredElsewhere('SIP;cause=2000')).toBe(false)
    expect(answeredElsewhere('Q.850;cause=200')).toBe(false)
    expect(answeredElsewhere(undefined)).toBe(false)
  })
})
