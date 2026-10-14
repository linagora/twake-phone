import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Softphone, type SoftCall, type UserAgentLike } from './index.js'

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

const fakePc = () => {
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  return {
    addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[name] ??= []).push(fn),
    fire: (name: string, e: unknown) => listeners[name]?.forEach(fn => fn(e)),
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

const audios: { srcObject: unknown; play: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }[] = []
const audio = () => {
  const a = { srcObject: null as unknown, play: vi.fn(async () => undefined), remove: vi.fn() }
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
  const getSession = vi.fn(async () => ({ type: 'sip-webrtc' as const, websocketUrl: 'wss://sip.test:443/ws', domain: 'sip.test', username: '101', credential: 'pw', iceServers: [{ urls: ['stun:stun.test'] }] }))
  const phone = new Softphone({
    getSession,
    createAudio: audio,
    displayName: 'Alice',
    onRegistration: s => registration.push(s),
    onCallChange: c => changes.push(`${c.direction}:${c.state}${c.remoteHold ? ':remoteHold' : ''}${c.muted ? ':muted' : ''}${c.renegotiating ? ':offer' : ''}`),
    onIncoming: c => incoming.push(c),
    onDtmf: (_c, tone) => tones.push(tone),
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
  return { phone, uas, configs, registration, changes, incoming, tones, getSession, ua: () => uas[uas.length - 1]! }
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
  })

  it('refuses a target that is not a dialable string', async () => {
    const { phone } = await setup()
    await expect(phone.call('102; DROP')).rejects.toThrow(/Invalid target/)
  })

  it('hands an incoming call to the app ringing, answers it with audio and attaches the remote track', async () => {
    const { phone, ua, incoming, changes } = await setup()
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
    expect(await call.stats()).toEqual({ packetsReceived: 42, packetsSent: 7 })
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
