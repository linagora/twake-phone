// Dev/test harness: the softphone core + Gateway client, without any Cozy dependency.
import { Softphone, type SoftCall } from '../src/index.js'
import { TelephonyClient } from '../../telephony-client/src/index.js'

const params = new URLSearchParams(location.search)
const user = params.get('user') ?? 'user1'
const gateway = params.get('gw') ?? 'http://127.0.0.1:8080'
const log = (m: string) => {
  document.getElementById('log')!.textContent += m + '\n'
}

const client = new TelephonyClient({ baseUrl: gateway, getToken: async () => `dev:${user}` })
const calls = new Map<string, SoftCall>()
const states: string[] = []
let registered = false
let pendingClickToCall = false

const phone = new Softphone({
  getSession: async () => {
    const s = await client.getMediaSession()
    if (s.type !== 'sip-webrtc') throw new Error('no browser audio for this user')
    return s
  },
  remoteAudio: document.getElementById('remote') as HTMLAudioElement,
  onRegistration: s => {
    registered = s === 'registered'
    log(`registration ${s}`)
  },
  onIncoming: call => {
    calls.set(call.id, call)
    log(`incoming from ${call.remoteNumber}`)
    // Click-to-call rings the user's own phone first: that leg is answered automatically.
    if (pendingClickToCall && call.remoteNumber === myExtension) {
      pendingClickToCall = false
      void call.answer()
    }
  },
  onCallChange: call => {
    states.push(`${call.direction}:${call.state}`)
    log(`call ${call.id.slice(0, 6)} ${call.state}`)
  }
})

let myExtension = ''
const w = window as unknown as Record<string, unknown>
w.__phone = {
  async start() {
    myExtension = ((await client.getMediaSession()) as { username: string }).username
    await phone.start()
  },
  isRegistered: () => registered,
  states: () => states,
  async call(target: string) {
    const c = await phone.call(target)
    calls.set(c.id, c)
  },
  async clickToCall(target: string) {
    pendingClickToCall = true
    return client.originate(target, crypto.randomUUID())
  },
  active: () => [...calls.values()].filter(c => c.state !== 'ended').map(c => ({ id: c.id, state: c.state, direction: c.direction, remote: c.remoteNumber })),
  find: (state: string) => [...calls.values()].find(c => c.state === state),
  async answer() {
    await [...calls.values()].find(c => c.direction === 'inbound' && c.state === 'ringing')?.answer()
  },
  async hangup() {
    for (const c of calls.values()) if (c.state !== 'ended') await c.hangup()
  },
  async hold() {
    await [...calls.values()].find(c => c.state === 'connected')?.hold()
  },
  async resume() {
    await [...calls.values()].find(c => c.state === 'held')?.resume()
  },
  async stats() {
    const c = [...calls.values()].find(x => x.state === 'connected' || x.state === 'held')
    return c ? c.stats() : { packetsReceived: 0, packetsSent: 0 }
  }
}
