import { describe, expect, it } from 'vitest'
import { MeetApi, MeetError } from './meet-api.js'
import type { Fetch } from './livekit-api.js'

const room = (slug: string, id = `id-${slug}`) => ({ id, slug, name: slug, url: `https://meet/${slug}`, access_level: 'trusted', telephony: { enabled: true, phone_number: '8000', pin_code: '1234567890', default_country: 'FR' } })

const setup = (handlers: Record<string, (body: any, auth?: string) => { status?: number; json: unknown }>) => {
  const calls: { path: string; auth?: string; body: any; headers: Record<string, string> }[] = []
  let clock = 0
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/external-api/v1.0', '') + new URL(url).search
    // Like the real fetch: a GET with a body is a TypeError.
    if (init.method === 'GET' && init.body !== undefined) throw new TypeError('Request with GET/HEAD method cannot have body.')
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, auth: init.headers.authorization, body, headers: init.headers })
    const h = handlers[`${init.method} ${path}`]
    if (!h) return { ok: false, status: 404, text: async () => '{}' }
    const r = h(body, init.headers.authorization)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.json) }
  }
  const api = new MeetApi({ url: 'http://meet:8000/', clientId: 'cid', clientSecret: 'sec', fetch, now: () => clock })
  return { api, calls, tick: (ms: number) => (clock += ms) }
}

const token = { 'POST /application/token/': () => ({ json: { access_token: 'T1', expires_in: 3600 } }) }

describe('MeetApi', () => {
  it('asks for a token scoped to the user email, and says it came through HTTPS', async () => {
    const { api, calls } = setup({ ...token, 'POST /rooms/': () => ({ json: room('abc-defg-hij') }) })
    const r = await api.createRoom('User1@Twake.local')
    expect(calls[0]!.body).toEqual({ client_id: 'cid', client_secret: 'sec', grant_type: 'client_credentials', scope: 'User1@Twake.local' })
    expect(calls[0]!.headers['x-forwarded-proto']).toBe('https')
    expect(calls[1]!.auth).toBe('Bearer T1')
    expect(r).toMatchObject({ id: 'id-abc-defg-hij', slug: 'abc-defg-hij', telephony: { phoneNumber: '8000', pinCode: '1234567890', defaultCountry: 'FR' } })
  })

  it('caches tokens per user until shortly before they expire', async () => {
    const { api, calls, tick } = setup({ ...token, 'POST /rooms/': () => ({ json: room('a') }) })
    await api.createRoom('a@x.fr')
    await api.createRoom('A@x.fr')
    await api.createRoom('b@x.fr')
    expect(calls.filter(c => c.path === '/application/token/')).toHaveLength(2)
    tick(3_541_000)
    await api.createRoom('a@x.fr')
    expect(calls.filter(c => c.path === '/application/token/')).toHaveLength(3)
  })

  it('replaces a token Meet rejects, once', async () => {
    let n = 0
    const { api, calls } = setup({
      'POST /application/token/': () => ({ json: { access_token: `T${++n}`, expires_in: 3600 } }),
      'POST /rooms/': (_b, auth) => (auth === 'Bearer T1' ? { status: 401, json: {} } : { json: room('a') })
    })
    expect((await api.createRoom('a@x.fr')).slug).toBe('a')
    expect(calls.filter(c => c.path === '/application/token/')).toHaveLength(2)
  })

  it('finds a room by slug or id across pages, and only among the rooms of that user', async () => {
    const { api } = setup({
      ...token,
      'GET /rooms/?page=1': () => ({ json: { results: [room('one')], next: 'p2' } }),
      'GET /rooms/?page=2': () => ({ json: { results: [room('two')], next: null } })
    })
    expect((await api.findRoom('a@x.fr', { slug: 'two' }))?.id).toBe('id-two')
    expect((await api.findRoom('a@x.fr', { id: 'id-one' }))?.slug).toBe('one')
    expect(await api.findRoom('a@x.fr', { slug: 'secret-room' })).toBeNull()
  })

  it('fails with the status when Meet refuses the application', async () => {
    const { api } = setup({ 'POST /application/token/': () => ({ status: 403, json: {} }) })
    await expect(api.createRoom('a@other.com')).rejects.toMatchObject({ status: 403 })
    await expect(api.createRoom('a@other.com')).rejects.toBeInstanceOf(MeetError)
  })
})
