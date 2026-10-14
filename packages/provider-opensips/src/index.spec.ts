import { afterEach, describe, expect, it } from 'vitest'
import type { RoutedEvent } from '@twake/telephony-provider-sdk'
import { OpensipsProvider, SUBSCRIBED_EVENTS } from './index.js'
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
    await until('the seeded presence', () => got.length === 1)
    expect(got[0]).toMatchObject({ extension: '102', event: { type: 'presence.changed', payload: { presence: { status: 'available', source: 'telephony' } } } })
    expect((await p.getPresence({ ...user, extension: '102' })).status).toBe('available')
    expect((await p.getPresence(user)).status).toBe('offline')
    sips.push('E_UL_CONTACT_INSERT', { domain: 'location', aor: '101', uri: 'sip:a@x.invalid' })
    sips.push('E_TWAKEPHONE_CALLING', { callid: 'c1', caller: '101', callee: '102' })
    await until('the call', () => got.length >= 6)
    expect(got.slice(1).map(e => `${e.extension}:${e.event.type}`)).toEqual(['101:presence.changed', '101:call.created', '102:call.created', '102:presence.changed', '101:presence.changed'])
    expect([...p.presences().entries()].map(([ext, pr]) => `${ext}:${pr.status}`)).toEqual(['102:busy', '101:busy'])
    // What the user sets shows once the call is over.
    await p.setPresence(user, { status: 'away', source: 'user' })
    expect((await p.getPresence(user)).status).toBe('busy')
    sips.push('E_ACC_CDR', { callid: 'c1', caller: '101', callee: '102', duration: 3, time: 1792002800, created: 1792002797 })
    await until('the end', () => got.some(e => e.event.type === 'call.ended'))
    expect((await p.getPresence(user))).toMatchObject({ status: 'away', source: 'user' })
    await p.close()
    expect(p.getStatus()).toBe('DEGRADED')
  })

  it('is DEGRADED while OpenSIPS does not answer its MI', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.down = true
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, logger: quiet })
    cleanups.push(() => p.close())
    await new Promise(r => setTimeout(r, 50))
    expect(p.getStatus()).toBe('DEGRADED')
  })
})
