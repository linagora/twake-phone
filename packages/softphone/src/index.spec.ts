import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Softphone, type SoftCall, type UserAgentLike } from './index.js'

// A JsSIP stand-in: the UA and its sessions are event emitters the test drives.
class FakeSession extends EventEmitter {
  id = `s${Math.random()}`
  direction: string
  remote_identity = { uri: { user: '102' }, display_name: 'Bob' }
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
  unregister = vi.fn()
  isRegistered = () => this.registered
  lastCall?: FakeSession
  call = vi.fn((_target: string) => {
    const s = new FakeSession('outgoing')
    this.lastCall = s
    this.emit('newRTCSession', { originator: 'local', session: s })
    return s as never
  })
}

const audio = () => ({ srcObject: null as unknown, play: vi.fn(async () => undefined) }) as unknown as HTMLAudioElement

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
    remoteAudio: audio(),
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
    expect(changes).toEqual(['outbound:ringing', 'outbound:connected', 'outbound:ended'])
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
    expect((phone as unknown as { options: { remoteAudio: { srcObject: unknown } } }).options.remoteAudio.srcObject).toEqual({ id: 'remote' })
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
    expect(changes).toEqual(['outbound:connected', 'outbound:connected:offer', 'outbound:held:offer', 'outbound:held', 'outbound:held:offer', 'outbound:connected:offer', 'outbound:connected', 'outbound:connected:remoteHold', 'outbound:connected'])
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

  it('stops cleanly: hangs up what is in progress and stops the user agent', async () => {
    const { phone, ua } = await setup()
    await phone.call('102')
    const s = ua().lastCall!
    await phone.stop()
    expect(s.terminate).toHaveBeenCalled()
    expect(ua().stop).toHaveBeenCalled()
    await expect(phone.call('103')).rejects.toThrow(/not started/)
  })
})
