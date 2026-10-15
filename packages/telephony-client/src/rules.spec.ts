import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelephonyClient } from './index.js'

describe('TelephonyClient presence and forwarding', () => {
  afterEach(() => vi.unstubAllGlobals())
  /** A Gateway answering `answer`, recording what it was asked. */
  const gateway = (answer: () => Response) => {
    const asked: { url: string; method?: string; body?: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      asked.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return answer()
    })
    return { asked, client: new TelephonyClient({ baseUrl: 'https://gw.example.test', getToken: async () => 'token' }) }
  }

  it('sends the end and message of a presence, and the forwarding rules as they are', async () => {
    const { asked, client } = gateway(() => new Response('{}', { status: 200 }))
    await client.setPresence('dnd', { until: '2026-10-15T14:00:00.000Z', message: 'En réunion' })
    await client.setPresence('available')
    await client.setForwarding({ busy: '103', noAnswer: { target: '104', delaySec: 10 } })
    await client.getForwarding()
    expect(asked).toEqual([
      { url: 'https://gw.example.test/api/v1/me/presence', method: 'PUT', body: { status: 'dnd', until: '2026-10-15T14:00:00.000Z', message: 'En réunion' } },
      { url: 'https://gw.example.test/api/v1/me/presence', method: 'PUT', body: { status: 'available' } },
      { url: 'https://gw.example.test/api/v1/me/forwarding', method: 'PUT', body: { busy: '103', noAnswer: { target: '104', delaySec: 10 } } },
      { url: 'https://gw.example.test/api/v1/me/forwarding', method: undefined, body: undefined }
    ])
  })

  it('carries the code and the words of a refusal, when the Gateway gives them', async () => {
    let next = () => new Response(JSON.stringify({ statusCode: 400, code: 'FORWARD_SELF', error: 'Bad Request', message: 'always: a forward to your own extension would ring you again' }), { status: 400 })
    const { client } = gateway(() => next())
    await expect(client.setForwarding({ always: '101' })).rejects.toMatchObject({ status: 400, code: 'FORWARD_SELF', detail: 'always: a forward to your own extension would ring you again' })
    next = () => new Response('<html>Bad gateway</html>', { status: 502 })
    const err = await client.getForwarding().catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 502 })
    expect(err).not.toHaveProperty('code')
    expect(err).not.toHaveProperty('detail')
  })
})
