import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { OperatorError } from '@twake/telephony-provider-sdk'
import { startFakeOvh, type FakeOvh } from '../test/fake-ovh.mjs'
import { OVH_ENDPOINTS, OvhClient, ovhSignature } from './client.js'

const fakes: FakeOvh[] = []
const fake = async (options: Parameters<typeof startFakeOvh>[0] = {}) => {
  const f = await startFakeOvh({ accounts: { 'ab12345-ovh-1': { lines: { '0033972000001': {} } } }, ...options })
  fakes.push(f)
  return f
}
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})
const clientOf = (f: FakeOvh, over: Partial<ConstructorParameters<typeof OvhClient>[0]> = {}) => new OvhClient({ ...f.credentials, endpoint: f.url, ...over })
const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    return err as OperatorError
  }
  throw new Error('expected a failure')
}

describe('the client of the OVHcloud API', () => {
  it('signs as the documentation says: $1$ and the SHA-1 of secret+consumer+method+URL+body+timestamp', () => {
    // Computed apart (hashlib.sha1 over the same string), not with the code under test.
    expect(ovhSignature('EXEMPLE-secret', 'EXEMPLE-consumer', 'GET', 'https://eu.api.ovh.com/1.0/telephony', '', 1_700_000_000)).toBe('$1$e72814883d248f84bd296e52b25dd43ffe9d1b1d')
    expect(OVH_ENDPOINTS['ovh-eu']).toBe('https://eu.api.ovh.com/1.0')
    expect(new OvhClient({ applicationKey: 'a', applicationSecret: 's', consumerKey: 'c' }).base).toBe('https://eu.api.ovh.com/1.0')
    expect(new OvhClient({ applicationKey: 'a', applicationSecret: 's', consumerKey: 'c', endpoint: 'ovh-ca' }).base).toBe('https://ca.api.ovh.com/1.0')
    expect(() => new OvhClient({ applicationKey: 'a', applicationSecret: 's', consumerKey: 'c', endpoint: 'eu' })).toThrow(/endpoint/)
    expect(() => new OvhClient({ applicationKey: 'a', applicationSecret: '', consumerKey: 'c' })).toThrow(/applicationSecret is required/)
  })

  it('has its requests checked by the fake, query string and body signed, dated by OVH clock (read once on /auth/time)', async () => {
    const f = await fake({ clockOffsetSec: 500 })
    const client = clientOf(f)
    expect(await client.request('GET', '/telephony')).toEqual(['ab12345-ovh-1'])
    await client.request('GET', '/telephony/ab12345-ovh-1/service/0033972000001/voiceConsumption', { query: { 'creationDatetime.from': '2026-10-17T08:00:00.000Z', 'creationDatetime.to': '2026-10-17T10:00:00.000Z' } })
    await client.request('PUT', '/telephony/ab12345-ovh-1/line/0033972000001/options', { body: { forwardBackup: false } })
    expect(f.requests.map(r => [r.method, r.path, r.status, r.signed])).toEqual([
      ['GET', '/auth/time', 200, false],
      ['GET', '/telephony', 200, true],
      ['GET', '/telephony/ab12345-ovh-1/service/0033972000001/voiceConsumption', 200, true],
      ['PUT', '/telephony/ab12345-ovh-1/line/0033972000001/options', 200, true]
    ])
    expect(f.requests[2]!.query).toEqual({ 'creationDatetime.from': '2026-10-17T08:00:00.000Z', 'creationDatetime.to': '2026-10-17T10:00:00.000Z' })
  })

  it('reads OVH clock again when OVH says a request is out of time, once, then tries the request again', async () => {
    const f = await fake()
    const client = clientOf(f)
    await client.request('GET', '/telephony')
    // This clock drifts by ten minutes from OVH's (or OVH's from it).
    f.state.clockOffsetSec = 600
    expect(await client.request('GET', '/telephony')).toEqual(['ab12345-ovh-1'])
    expect(f.requests.map(r => [r.path, r.status])).toEqual([
      ['/auth/time', 200],
      ['/telephony', 200],
      ['/telephony', 400],
      ['/auth/time', 200],
      ['/telephony', 200]
    ])
  })

  it('says how it failed without a key: refused keys, a call not granted to the consumer key, nothing there, a refusal, an API down', async () => {
    const f = await fake({ rules: [{ method: 'GET', path: '/telephony' }] })
    const secretsIn = (err: Error) => [f.credentials.applicationSecret, f.credentials.consumerKey, 'wrong-secret'].filter(s => err.message.includes(s))
    const wrongSecret = await failure(clientOf(f, { applicationSecret: 'wrong-secret' }).request('GET', '/telephony'))
    expect([wrongSecret.code, secretsIn(wrongSecret)]).toEqual(['unauthorized', []])
    const unknownKey = await failure(clientOf(f, { consumerKey: 'not-this-one' }).request('GET', '/telephony'))
    expect(unknownKey.code).toBe('unauthorized')
    // The consumer key may read the accounts only: the lines are not granted to it.
    const notGranted = await failure(clientOf(f).request('GET', '/telephony/ab12345-ovh-1/line'))
    expect([notGranted.code, notGranted.message]).toEqual(['forbidden', 'OVH GET /telephony/ab12345-ovh-1/line: 403 NOT_GRANTED_CALL This call has not been granted'])
    f.state.rules = [{ method: 'GET', path: '/telephony/*' }, { method: 'PUT', path: '/telephony/*' }]
    expect((await failure(clientOf(f).request('GET', '/telephony/nobody/line'))).code).toBe('not-found')
    const refused = await failure(clientOf(f).request('PUT', '/telephony/ab12345-ovh-1/line/0033972000001/options', { body: { forwardBackupNumber: '+33612345678' } }))
    expect([refused.code, refused.statusCode]).toEqual(['refused', 502])
    f.state.down = true
    expect((await failure(clientOf(f).request('GET', '/telephony/ab12345-ovh-1/line'))).code).toBe('unreachable')
    for (const err of [wrongSecret, unknownKey, notGranted, refused]) expect(err).toBeInstanceOf(OperatorError)
  })

  it('gives up on an API that does not answer in time, or cannot be reached', async () => {
    const silent = createServer(() => undefined)
    await new Promise<void>(r => silent.listen(0, '127.0.0.1', r))
    const { port } = silent.address() as { port: number }
    try {
      const slow = await failure(new OvhClient({ applicationKey: 'a', applicationSecret: 's', consumerKey: 'c', endpoint: `http://127.0.0.1:${port}/1.0`, timeoutMs: 200 }).request('GET', '/telephony'))
      expect([slow.code, slow.message]).toEqual(['unreachable', 'OVH GET /auth/time: no answer in time'])
    } finally {
      silent.closeAllConnections()
      await new Promise(r => silent.close(r))
    }
    const closed = await failure(new OvhClient({ applicationKey: 'a', applicationSecret: 's', consumerKey: 'c', endpoint: `http://127.0.0.1:${port}/1.0` }).request('GET', '/telephony'))
    expect([closed.code, closed.message]).toEqual(['unreachable', 'OVH GET /auth/time: not reached'])
  })
})
