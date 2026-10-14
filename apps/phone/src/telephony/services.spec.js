import { createServices, makeIdentityProvider } from './services'

jest.mock('cozy-flags', () => jest.fn(() => 'https://telephony.twake.local'))

const codeResponse = code => ({
  data: { attributes: { codes: { gateway: code } } }
})

describe('makeIdentityProvider', () => {
  it('asks the stack for a code limited to the instance identity, with a short life', async () => {
    const fetchJSON = jest.fn(async () => codeResponse('code-1'))
    expect(await makeIdentityProvider({ fetchJSON })()).toBe('code-1')
    const [method, path, body] = fetchJSON.mock.calls[0]
    expect(method).toBe('POST')
    expect(path).toBe('/permissions?codes=gateway&ttl=10m')
    expect(body.data.attributes.permissions.identity).toEqual({
      type: 'io.cozy.settings',
      verbs: ['GET'],
      values: ['io.cozy.settings.instance']
    })
  })

  it('reuses the code until shortly before it expires, then renews it', async () => {
    let t = 0
    const fetchJSON = jest.fn(async () =>
      codeResponse(`code-${fetchJSON.mock.calls.length}`)
    )
    const identity = makeIdentityProvider({ fetchJSON, now: () => t })
    expect(await identity()).toBe('code-1')
    t = 7 * 60 * 1000
    expect(await identity()).toBe('code-1')
    t = 9 * 60 * 1000
    expect(await identity()).toBe('code-2')
  })

  it('creates a single code for simultaneous requests', async () => {
    const fetchJSON = jest.fn(
      () =>
        new Promise(resolve => setTimeout(() => resolve(codeResponse('c')), 10))
    )
    const identity = makeIdentityProvider({ fetchJSON })
    await Promise.all([identity(), identity(), identity()])
    expect(fetchJSON).toHaveBeenCalledTimes(1)
  })

  it('fails clearly, and tries again next time, when the stack gives no code', async () => {
    const fetchJSON = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(codeResponse('ok'))
    const identity = makeIdentityProvider({ fetchJSON })
    await expect(identity()).rejects.toThrow('did not return an identity code')
    expect(await identity()).toBe('ok')
  })
})

describe('createServices', () => {
  afterEach(() => localStorage.clear())
  const stackClient = fetchJSON => ({
    getStackClient: () => ({ uri: 'https://user1.twake.local', fetchJSON })
  })

  it('sends the identity code, never the session token, with the instance URL', async () => {
    const { gateway } = createServices({
      client: stackClient(jest.fn(async () => codeResponse('the-code'))),
      remoteAudio: null
    })
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({})
    }))
    await gateway.getMe()
    const headers = global.fetch.mock.calls[0][1].headers
    expect(headers.authorization).toBe('Bearer the-code')
    expect(headers['x-cozy-instance']).toBe('https://user1.twake.local')
  })

  it('uses a dev token only when the local dev key is set, and clears the old flag remnant', async () => {
    localStorage.setItem('flag__phone.dev-user', '"user1"')
    const fetchJSON = jest.fn(async () => codeResponse('the-code'))
    const { gateway } = createServices({
      client: stackClient(fetchJSON),
      remoteAudio: null
    })
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({})
    }))
    await gateway.getMe()
    expect(global.fetch.mock.calls[0][1].headers.authorization).toBe(
      'Bearer the-code'
    )
    expect(localStorage.getItem('flag__phone.dev-user')).toBeNull()

    localStorage.setItem('twake-phone:dev-user', 'test1')
    await gateway.getMe()
    expect(global.fetch.mock.calls[1][1].headers.authorization).toBe(
      'Bearer dev:test1'
    )
  })
})
