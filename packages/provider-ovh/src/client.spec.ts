import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { OperatorError } from '@twake/telephony-provider-sdk'
import { startFakeOvh, type FakeOvh } from '../test/fake-ovh.mjs'
import { OVH_ENDPOINTS, OvhClient, ovhSignature } from './client.js'

const ACCOUNT = 'ab12345-ovh-1'
const OPTIONS = `/telephony/${ACCOUNT}/line/0033972000001/options`
const fakes: FakeOvh[] = []
const fake = async (options: Parameters<typeof startFakeOvh>[0] = {}) => {
  const f = await startFakeOvh({ accounts: { [ACCOUNT]: { lines: { '0033972000001': {} } } }, ...options })
  fakes.push(f)
  return f
}
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})
const clientOf = (f: FakeOvh, over: Partial<ConstructorParameters<typeof OvhClient>[0]> = {}) => new OvhClient({ ...f.credentials, baseUrl: f.url, ...over })
const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    return err as OperatorError
  }
  throw new Error('expected a failure')
}
const KEYS = { applicationKey: 'a', applicationSecret: 's', consumerKey: 'c' }

describe('the client of the OVHcloud API', () => {
  it('signs as the documentation says: $1$ and the SHA-1 of secret+consumer+method+URL+body+timestamp', () => {
    // Computed apart (hashlib.sha1 over the same string), not with the code under test.
    expect(ovhSignature('EXEMPLE-secret', 'EXEMPLE-consumer', 'GET', 'https://eu.api.ovh.com/1.0/telephony', '', 1_700_000_000)).toBe('$1$e72814883d248f84bd296e52b25dd43ffe9d1b1d')
    expect(OVH_ENDPOINTS['ovh-eu']).toBe('https://eu.api.ovh.com/1.0')
    expect(new OvhClient(KEYS).base).toBe('https://eu.api.ovh.com/1.0')
    expect(new OvhClient({ ...KEYS, endpoint: 'ovh-ca' }).base).toBe('https://ca.api.ovh.com/1.0')
    expect(new OvhClient({ ...KEYS, endpoint: 'ovh-us' }).base).toBe('https://api.us.ovhcloud.com/1.0')
    expect(() => new OvhClient({ ...KEYS, applicationSecret: '' })).toThrow(/applicationSecret is required/)
  })

  it('takes the three entry points of OVH only; a URL only for the tests, never http away from the loopback (review 10b, n°11)', () => {
    for (const endpoint of ['eu', 'http://169.254.169.254/latest', 'https://eu.api.ovh.com/1.0']) expect(() => new OvhClient({ ...KEYS, endpoint: endpoint as 'ovh-eu' })).toThrow('OVH endpoint: ovh-eu, ovh-ca or ovh-us')
    for (const baseUrl of ['http://169.254.169.254/latest', 'http://api.example.org/1.0', 'ftp://127.0.0.1/1.0']) expect(() => new OvhClient({ ...KEYS, baseUrl })).toThrow(/baseUrl/)
    expect(new OvhClient({ ...KEYS, baseUrl: 'http://127.0.0.1:8080/1.0' }).base).toBe('http://127.0.0.1:8080/1.0')
    expect(new OvhClient({ ...KEYS, baseUrl: 'https://api.example.org/1.0/' }).base).toBe('https://api.example.org/1.0')
  })

  it('has its requests checked by the fake, query string and body signed, dated by OVH clock (read once on /auth/time)', async () => {
    const f = await fake({ clockOffsetSec: 500 })
    const client = clientOf(f)
    expect(await client.request('GET', OPTIONS)).toMatchObject({ forwardBackup: false })
    await client.request('GET', `/telephony/${ACCOUNT}/service/0033972000001/voiceConsumption`, { query: { 'creationDatetime.from': '2026-10-17T08:00:00.000Z', 'creationDatetime.to': '2026-10-17T10:00:00.000Z' } })
    await client.request('PUT', OPTIONS, { body: { forwardBackup: false } })
    expect(f.requests.map(r => [r.method, r.path, r.status, r.signed])).toEqual([
      ['GET', '/auth/time', 200, false],
      ['GET', OPTIONS, 200, true],
      ['GET', `/telephony/${ACCOUNT}/service/0033972000001/voiceConsumption`, 200, true],
      ['PUT', OPTIONS, 200, true]
    ])
    expect(f.requests[2]!.query).toEqual({ 'creationDatetime.from': '2026-10-17T08:00:00.000Z', 'creationDatetime.to': '2026-10-17T10:00:00.000Z' })
  })

  it('reads OVH clock again when OVH says a request is out of time, once only, then tries the request again once', async () => {
    const f = await fake()
    const client = clientOf(f)
    await client.request('GET', OPTIONS)
    // This clock drifts by ten minutes from OVH's (or OVH's from it).
    f.state.clockOffsetSec = 600
    expect(await client.request('GET', OPTIONS)).toMatchObject({ forwardBackup: false })
    expect(f.requests.map(r => [r.path, r.status])).toEqual([
      ['/auth/time', 200],
      [OPTIONS, 200],
      [OPTIONS, 400],
      ['/auth/time', 200],
      [OPTIONS, 200]
    ])
    // Out of time again after reading OVH's clock (an API that says one time and checks another): refused after one
    // more try, never tried again and again (review 10b, n°15).
    const asked: string[] = []
    const outOfTime = (async (url: string) => {
      const u = url
      asked.push(u.replace(/^.*\/1\.0/, ''))
      if (u.endsWith('/auth/time')) return new Response(String(Math.floor(Date.now() / 1000)))
      return new Response(JSON.stringify({ errorCode: 'QUERY_TIME_OUT', httpCode: '400 Bad Request', message: 'Query out of time' }), { status: 400 })
    }) as typeof fetch
    const refused = await failure(new OvhClient({ ...KEYS, fetch: outOfTime }).request('GET', OPTIONS))
    expect([refused.code, refused.message]).toEqual(['refused', `OVH GET ${OPTIONS}: 400 QUERY_TIME_OUT Query out of time`])
    expect(asked).toEqual(['/auth/time', OPTIONS, '/auth/time', OPTIONS])
  })

  it('reads the clock again for that refusal only, not for another one that names a time (review 10b, n°18)', async () => {
    const f = await fake()
    const client = clientOf(f)
    const refused = await failure(client.request('GET', `/telephony/${ACCOUNT}/service/0033972000001/voiceConsumption`, { query: { 'creationDatetime.from': 'yesterday' } }))
    expect([refused.code, refused.message]).toEqual(['refused', `OVH GET /telephony/${ACCOUNT}/service/0033972000001/voiceConsumption: 400 INVALID_PARAMETER Invalid value for creationDatetime`])
    expect(f.requests.map(r => r.path)).toEqual(['/auth/time', `/telephony/${ACCOUNT}/service/0033972000001/voiceConsumption`])
  })

  it('says how it failed without a key: refused keys, a call not granted to the consumer key, nothing there, a refusal, an API down', async () => {
    const f = await fake()
    const secretsIn = (err: Error) => [f.credentials.applicationKey, f.credentials.applicationSecret, f.credentials.consumerKey, 'wrong-secret', 'not-this-one'].filter(s => err.message.includes(s))
    const wrongSecret = await failure(clientOf(f, { applicationSecret: 'wrong-secret' }).request('GET', OPTIONS))
    expect([wrongSecret.code, secretsIn(wrongSecret)]).toEqual(['unauthorized', []])
    const unknownKey = await failure(clientOf(f, { consumerKey: 'not-this-one' }).request('GET', OPTIONS))
    expect([unknownKey.code, secretsIn(unknownKey)]).toEqual(['unauthorized', []])
    // The consumer key of the pilot kit reads the options of the lines and their records, nothing else.
    const notGranted = await failure(clientOf(f).request('GET', `/telephony/${ACCOUNT}/line`))
    expect([notGranted.code, notGranted.message]).toEqual(['forbidden', `OVH GET /telephony/${ACCOUNT}/line: 403 NOT_GRANTED_CALL This call has not been granted`])
    expect((await failure(clientOf(f).request('PUT', `/telephony/${ACCOUNT}/line/0033972000001`, { body: {} }))).code).toBe('forbidden')
    expect((await failure(clientOf(f).request('GET', `/telephony/${ACCOUNT}/line/0033972000009/options`))).code).toBe('not-found')
    const refused = await failure(clientOf(f).request('PUT', OPTIONS, { body: { forwardBackupNumber: '+33612345678' } }))
    expect([refused.code, refused.statusCode]).toEqual(['refused', 502])
    f.state.down = true
    expect((await failure(clientOf(f).request('GET', OPTIONS))).code).toBe('unreachable')
    for (const err of [wrongSecret, unknownKey, notGranted, refused]) expect(err).toBeInstanceOf(OperatorError)
  })

  it('never follows a redirection, nor takes a 2xx that is no JSON for an empty answer (review 10b, n°6 and n°15)', async () => {
    const f = await fake()
    const elsewhere = await fake()
    f.state.redirect = `${elsewhere.url}${OPTIONS}`
    const redirected = await failure(clientOf(f).request('GET', OPTIONS))
    expect(redirected.code).toBe('unreachable')
    expect(elsewhere.requests).toEqual([])
    f.state.redirect = undefined
    f.state.garbage = '<html><body>Proxy</body></html>'
    const garbage = await failure(clientOf(f).request('GET', OPTIONS))
    expect([garbage.code, garbage.message]).toEqual(['unreachable', `OVH GET ${OPTIONS}: 200 not JSON`])
    // An empty 2xx is no error (a PUT answered with nothing).
    f.state.garbage = ''
    expect(await clientOf(f).request('PUT', OPTIONS, { body: { forwardBackup: false } })).toBeUndefined()
  })

  it('gives up on an API that does not answer in time, cuts its answer, or cannot be reached', async () => {
    const silent = createServer(() => undefined)
    await new Promise<void>(r => silent.listen(0, '127.0.0.1', r))
    const { port } = silent.address() as { port: number }
    try {
      const slow = await failure(new OvhClient({ ...KEYS, baseUrl: `http://127.0.0.1:${port}/1.0`, timeoutMs: 200 }).request('GET', '/telephony'))
      expect([slow.code, slow.message]).toEqual(['unreachable', 'OVH GET /auth/time: no answer in time'])
    } finally {
      silent.closeAllConnections()
      await new Promise(r => silent.close(r))
    }
    const closed = await failure(new OvhClient({ ...KEYS, baseUrl: `http://127.0.0.1:${port}/1.0` }).request('GET', '/telephony'))
    expect([closed.code, closed.message]).toEqual(['unreachable', 'OVH GET /auth/time: not reached'])
    // Its headers, then half the body, then nothing: the time out comes while the body is read.
    const half = createServer((req, res) => {
      if (req.url === '/1.0/auth/time') return res.end(String(Math.floor(Date.now() / 1000)))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"forwardBackup": tr')
    })
    await new Promise<void>(r => half.listen(0, '127.0.0.1', r))
    try {
      const cut = await failure(new OvhClient({ ...KEYS, baseUrl: `http://127.0.0.1:${(half.address() as { port: number }).port}/1.0`, timeoutMs: 300 }).request('GET', '/telephony/x/line/y/options'))
      expect([cut.code, cut.message]).toEqual(['unreachable', 'OVH GET /telephony/x/line/y/options: answer cut'])
    } finally {
      half.closeAllConnections()
      await new Promise(r => half.close(r))
    }
  })
})
