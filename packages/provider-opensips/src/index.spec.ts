import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import type { RoutedEvent } from '@twake/telephony-provider-sdk'
import { AsyncQueue, OpensipsProvider, SUBSCRIBED_EVENTS } from './index.js'
import { fakeOpensips } from '../test/fake-opensips.js'

const user = { id: 'alice', tenantId: 't', displayName: 'Alice', extension: '101' }
const browser = { id: 'b', type: 'browser' as const, label: 'Browser' }
const quiet = { info: () => undefined, warn: () => undefined }

const until = async (what: string, fn: () => boolean, timeout = 3_000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('OpensipsProvider', () => {
  const make = () => new OpensipsProvider({ websocketUrl: 'wss://sip.example.test:443', domain: 'sip.example.test', sipSecretFor: async ext => `secret-${ext}` })
  const cleanups: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c()
  })

  it('hands the browser where to register and as whom, with the per-user secret', async () => {
    const session = await make().getSession(user, browser)
    expect(session).toEqual({ type: 'sip-webrtc', websocketUrl: 'wss://sip.example.test:443', domain: 'sip.example.test', username: '101', credential: 'secret-101', iceServers: [] })
  })

  it('gives no session to a user without extension, nor to a non-browser endpoint', async () => {
    await expect(make().getSession({ ...user, extension: undefined }, browser)).rejects.toMatchObject({ statusCode: 404 })
    expect(await make().getSession(user, { ...browser, type: 'desk-phone' })).toEqual({ type: 'external' })
  })

  it('says the browser does the calling and the Gateway cannot originate', async () => {
    const caps = await make().getCapabilities()
    expect(caps.media.browserAudio).toBe(true)
    expect(caps.calling.outbound).toBe(false)
    expect(caps.presence.realtime).toBe(false)
    expect(caps.history).toBe(false)
    await expect(make().originate({ user, target: '102' })).rejects.toMatchObject({ statusCode: 501 })
  })

  it('refuses a configuration without a WebSocket URL or domain', () => {
    expect(() => new OpensipsProvider({ websocketUrl: 'http://x', domain: 'd', sipSecretFor: async () => '' })).toThrow(/ws:\/\//)
    expect(() => new OpensipsProvider({ websocketUrl: 'ws://x', domain: '', sipSecretFor: async () => '' })).toThrow(/domain/)
  })

  it('without events, a user with an extension is offline (nobody told the Gateway otherwise); one without keeps what they set', async () => {
    const p = make()
    expect((await p.getPresence(user)).status).toBe('offline')
    const noExtension = { ...user, extension: undefined }
    expect((await p.getPresence(noExtension)).status).toBe('available')
    await p.setPresence(noExtension, { status: 'dnd', source: 'user' })
    expect((await p.getPresence(noExtension)).status).toBe('dnd')
    expect((await p.getPresence({ ...noExtension, tenantId: 'other' })).status).toBe('available')
  })

  it('with events: subscribes to OpenSIPS, reads who is registered, and streams presence and calls to the Gateway', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.dump.Domains[0]!.AORs.push({ AOR: '102', Contacts: [{ Contact: 'sip:b@y.invalid', Expires: 3000 }] })
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, logger: quiet })
    cleanups.push(() => p.close())
    const got: RoutedEvent[] = []
    void (async () => {
      for await (const e of p.subscribe()) got.push(e)
    })()
    expect(() => p.subscribe()).toThrow(/one consumer/)
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    expect(sips.subscriptions.map(s => s.event)).toEqual(SUBSCRIBED_EVENTS)
    expect((await p.getCapabilities()).presence.realtime).toBe(true)
    expect((await p.getCapabilities()).history).toBe(true)
    await until('the seeded presence', () => got.length === 1)
    expect(got[0]).toMatchObject({ extension: '102', event: { type: 'presence.changed', payload: { presence: { status: 'available', source: 'telephony' } } } })
    expect((await p.getPresence({ ...user, extension: '102' })).status).toBe('available')
    expect((await p.getPresence(user)).status).toBe('offline')
    sips.push('E_UL_CONTACT_INSERT', { domain: 'location', aor: '101', uri: 'sip:a@x.invalid' })
    sips.push('E_TWAKEPHONE_CALLING', { callid: 'c1', caller: '101', callee: '102' })
    sips.push('E_TWAKEPHONE_RINGING', { callid: 'c1', caller: '101', callee: '102' })
    await until('the call', () => got.length >= 7)
    expect(got.slice(1).map(e => `${e.extension}:${e.event.type}`)).toEqual(['101:presence.changed', '101:call.created', '101:presence.changed', '101:call.ringing', '102:call.ringing', '102:presence.changed'])
    expect([...p.presences().entries()].map(([ext, pr]) => `${ext}:${pr.status}`)).toEqual(['102:busy', '101:busy'])
    // What the user sets shows once the call is over.
    await p.setPresence(user, { status: 'away', source: 'user' })
    expect((await p.getPresence(user)).status).toBe('busy')
    sips.push('E_ACC_CDR', { callid: 'c1', caller: '101', callee: '102', duration: 3, ms_duration: 2500, time: 1792002800, setuptime: 3, created: 1792002797 })
    await until('the end', () => got.some(e => e.event.type === 'call.ended'))
    expect((await p.getPresence(user))).toMatchObject({ status: 'away', source: 'user' })
    await p.close()
    expect(p.getStatus()).toBe('DEGRADED')
    // Unsubscribed on the way out.
    expect(sips.subscriptions).toEqual([])
  })

  it('is DEGRADED once an attempt to reach OpenSIPS failed, and not realtime', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.down = true
    const warnings: string[] = []
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 50 }, logger: { info: () => undefined, warn: m => warnings.push(m) } })
    cleanups.push(() => p.close())
    await until('a failed attempt', () => warnings.some(w => /no reply within 50 ms; retrying/.test(w)))
    expect(sips.state.received).toBeGreaterThan(0)
    expect(p.getStatus()).toBe('DEGRADED')
    expect((await p.getCapabilities()).presence.realtime).toBe(false)
  })

  it('forgets what OpenSIPS told once it stops answering (everyone offline), and reads it again when it is back', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 50 }, logger: quiet })
    cleanups.push(() => p.close())
    const got: string[] = []
    void (async () => {
      for await (const e of p.subscribe()) if (e.event.type === 'presence.changed') got.push(`${e.extension}:${e.event.payload.presence.status}`)
    })()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    sips.push('E_UL_CONTACT_INSERT', { aor: '101', uri: 'sip:a@x.invalid' })
    await until('101 available', () => got.length === 1)
    sips.state.down = true
    await p['events']!['renew']()
    expect(p.getStatus()).toBe('DEGRADED')
    expect((await p.getCapabilities()).presence.realtime).toBe(false)
    await until('101 offline', () => got.length === 2)
    expect(got).toEqual(['101:available', '101:offline'])
    sips.state.down = false
    sips.state.dump.Domains[0]!.AORs.push({ AOR: '101', Contacts: [{ Contact: 'sip:a@x.invalid', Expires: 300 }] })
    await p['events']!['renew']()
    await until('101 available again', () => got.length === 3)
    expect(got[2]).toBe('101:available')
  })

  it('reads OpenSIPS again when it restarted between two renewals, and lets unrefreshed registrations lapse', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, logger: quiet })
    cleanups.push(() => p.close())
    const got: string[] = []
    void (async () => {
      for await (const e of p.subscribe()) if (e.event.type === 'presence.changed') got.push(`${e.extension}:${e.event.payload.presence.status}`)
    })()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    // 102 registered for a moment that is already over (its deletion was lost); 103 for long.
    const now = Math.floor(Date.now() / 1000)
    sips.push('E_UL_CONTACT_INSERT', { aor: '102', uri: 'sip:b@x.invalid', expires: now - 60 })
    sips.push('E_UL_CONTACT_INSERT', { aor: '103', uri: 'sip:c@x.invalid', expires: now + 3600 })
    await until('both available', () => got.length === 2)
    await p['events']!['renew']()
    expect(got.slice(2)).toEqual(['102:offline'])
    // OpenSIPS restarted (registrations in memory: none left) without any renewal failing.
    const reads = sips.requests.filter(r => r.method === 'ul_dump').length
    sips.restart('Wed Oct 14 18:20:00 2026')
    await p['events']!['renew']()
    expect(sips.requests.filter(r => r.method === 'ul_dump').length).toBe(reads + 1)
    expect(got.slice(3)).toEqual(['103:offline'])
  })

  it('tries again to listen when the address is not free yet', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const squatter = dgram.createSocket('udp4')
    await new Promise<void>(r => squatter.bind(0, '127.0.0.1', r))
    const port = squatter.address().port
    const warnings: string[] = []
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, listen: `127.0.0.1:${port}` }, logger: { info: () => undefined, warn: m => warnings.push(m) } })
    cleanups.push(() => p.close())
    await until('the failure', () => warnings.some(w => /not started: .*EADDRINUSE.*retrying in 1 s/.test(w)))
    await new Promise<void>(r => squatter.close(() => r()))
    await until('the subscription', () => p.getStatus() === 'CONNECTED', 5_000)
    expect(sips.subscriptions[0]!.socket).toBe(`udp:127.0.0.1:${port}`)
  })
})

describe('AsyncQueue', () => {
  it('keeps at most its bound waiting, drops the rest and says so once per overflow', async () => {
    const drops: number[] = []
    const q = new AsyncQueue<number>(3, n => drops.push(n))
    for (let i = 0; i < 6; i++) q.push(i)
    expect(q.dropped).toBe(3)
    expect(drops).toEqual([1])
    const it = q[Symbol.asyncIterator]()
    expect([(await it.next()).value, (await it.next()).value, (await it.next()).value]).toEqual([0, 1, 2])
    // Drained: the next overflow is told again.
    for (let i = 0; i < 5; i++) q.push(i)
    expect(drops).toEqual([1, 4])
    q.close()
  })
})
