import { describe, expect, it } from 'vitest'
import { OpensipsProvider } from './index.js'

const user = { id: 'alice', tenantId: 't', displayName: 'Alice', extension: '101' }
const browser = { id: 'b', type: 'browser' as const, label: 'Browser' }

describe('OpensipsProvider', () => {
  const make = () => new OpensipsProvider({ websocketUrl: 'wss://sip.example.test:443', domain: 'sip.example.test', sipSecretFor: async ext => `secret-${ext}` })

  it('hands the browser where to register and as whom, with the per-user secret', async () => {
    const session = await make().getSession(user, browser)
    expect(session).toEqual({ type: 'sip-webrtc', websocketUrl: 'wss://sip.example.test:443', domain: 'sip.example.test', username: '101', credential: 'secret-101', iceServers: [] })
  })

  it('gives no session to a user without extension, nor to a non-browser endpoint', async () => {
    await expect(make().getSession({ ...user, extension: undefined }, browser)).rejects.toMatchObject({ statusCode: 404 })
    expect(await make().getSession(user, { ...browser, type: 'desk-phone' })).toEqual({ type: 'external' })
  })

  it('says the browser does the calling and the Gateway cannot originate yet', async () => {
    const caps = await make().getCapabilities()
    expect(caps.media.browserAudio).toBe(true)
    expect(caps.calling.outbound).toBe(false)
    await expect(make().originate({ user, target: '102' })).rejects.toMatchObject({ statusCode: 501 })
  })

  it('refuses a configuration without a WebSocket URL or domain', () => {
    expect(() => new OpensipsProvider({ websocketUrl: 'http://x', domain: 'd', sipSecretFor: async () => '' })).toThrow(/ws:\/\//)
    expect(() => new OpensipsProvider({ websocketUrl: 'ws://x', domain: '', sipSecretFor: async () => '' })).toThrow(/domain/)
  })

  it('keeps the presence a user sets, per tenant', async () => {
    const p = make()
    await p.setPresence(user, { status: 'dnd', source: 'user' })
    expect((await p.getPresence(user)).status).toBe('dnd')
    expect((await p.getPresence({ ...user, tenantId: 'other' })).status).toBe('available')
  })

  it('has no events yet: the stream ends at once', async () => {
    const events = []
    for await (const e of make().subscribe()) events.push(e)
    expect(events).toEqual([])
  })
})
