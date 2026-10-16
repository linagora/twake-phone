import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelephonyClient } from './index.js'

describe('getCallConference (step 8b)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends the Call-ID of the reader's own call in a header, never in the URL that proxies log", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify({ meetingId: 'twake-call-0123456789abcdef', participants: [] }), { status: 200 })
    })
    const client = new TelephonyClient({ baseUrl: 'https://gw.example.test', getToken: async () => 'token' })
    await client.getCallConference('twake-call-0123456789abcdef', { call: 'a1b2@192.0.2.30' })
    await client.getCallConference('twake-call-0123456789abcdef')
    expect(seen.map(s => s.url)).toEqual(['https://gw.example.test/api/v1/conferences/twake-call-0123456789abcdef', 'https://gw.example.test/api/v1/conferences/twake-call-0123456789abcdef'])
    expect(seen.map(s => s.headers['x-twake-call'])).toEqual(['a1b2@192.0.2.30', undefined])
  })
})
