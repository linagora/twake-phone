import { afterEach, describe, expect, it } from 'vitest'
import { startFakeOvh, type FakeOvh } from '../test/fake-ovh.mjs'
import { ovhOperatorFromEnv } from './index.js'
import { fromOvhNumber, toOvhNumber } from './numbers.js'
import { OvhOperator } from './operator.js'

const ACCOUNT = 'ab12345-ovh-1'
const LINE = '0033972000001'
const fakes: FakeOvh[] = []
const setup = async (lines: Record<string, object> = { [LINE]: {}, '0033972000002': {} }) => {
  const f = await startFakeOvh({ accounts: { [ACCOUNT]: { lines } } })
  fakes.push(f)
  return { f, ovh: new OvhOperator({ ...f.credentials, endpoint: f.url, billingAccount: ACCOUNT }) }
}
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})

describe('OVHcloud as the operator of the trunks', () => {
  it('writes numbers as OVH does (00 and the country code) and reads them back in E.164', () => {
    expect(toOvhNumber('+33612345678')).toBe('0033612345678')
    expect(() => toOvhNumber('0612345678')).toThrow()
    expect(['0033612345678', '0612345678', '+33612345678', '0032 2 555 01 00', 'anonymous', '3179'].map(fromOvhNumber)).toEqual(['+33612345678', '+33612345678', '+33612345678', '+3225550100', 'anonymous', '3179'])
  })

  it('lists the lines of its billing account', async () => {
    const { ovh } = await setup()
    expect(await ovh.listLines()).toEqual([LINE, '0033972000002'])
    expect(() => new OvhOperator({ applicationKey: 'a', applicationSecret: 's', consumerKey: 'c', billingAccount: '../me' })).toThrow(/billing account/)
  })

  it('sets the fallback on unavailability and on no answer to one number, reads it back, and removes it; nothing else of the line', async () => {
    const { f, ovh } = await setup({ [LINE]: { options: { forwardBusy: true, forwardBusyNumber: '0033100000000', displayNumber: '0033972000001' } } })
    expect(await ovh.getFallback(LINE)).toEqual({ onUnavailable: false })
    await ovh.setFallback(LINE, { number: '+33612345678', onUnavailable: true, noAnswerAfterSec: 150 })
    expect(f.requests.at(-1)!.body).toEqual({ forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033612345678', forwardNoReply: true, forwardNoReplyDelay: 150, forwardNoReplyNature: 'number', forwardNoReplyNumber: '0033612345678' })
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBusy: true, forwardBusyNumber: '0033100000000', displayNumber: '0033972000001' })
    expect(await ovh.getFallback(LINE)).toEqual({ number: '+33612345678', onUnavailable: true, noAnswerAfterSec: 150 })
    await ovh.setFallback(LINE, { number: '+33612345678', onUnavailable: true })
    expect(await ovh.getFallback(LINE)).toEqual({ number: '+33612345678', onUnavailable: true })
    await ovh.setFallback(LINE, { onUnavailable: false })
    expect(f.requests.at(-1)!.body).toEqual({ forwardBackup: false, forwardNoReply: false })
    expect(await ovh.getFallback(LINE)).toEqual({ onUnavailable: false })
    await expect(ovh.setFallback(LINE, { onUnavailable: true })).rejects.toThrow(/number/)
  })

  it('reads a fallback set otherwise in the manager as it is: two numbers, or a voicemail, are no number of one fallback', async () => {
    const { ovh } = await setup({
      [LINE]: { options: { forwardBackup: true, forwardBackupNumber: '0033612345678', forwardNoReply: true, forwardNoReplyDelay: 30, forwardNoReplyNumber: '0033698765432' } },
      '0033972000002': { options: { forwardBackup: true, forwardBackupNature: 'voicemail' } }
    })
    expect(await ovh.getFallback(LINE)).toEqual({ onUnavailable: true, noAnswerAfterSec: 30 })
    expect(await ovh.getFallback('0033972000002')).toEqual({ onUnavailable: true })
  })

  it('lists the records of calls of a line over a period, and reads each in E.164, its way, its start and its duration', async () => {
    const { f, ovh } = await setup()
    const inbound = f.addConsumption(ACCOUNT, LINE, { calling: '0033612345678', called: '0033972000001', creationDatetime: '2026-10-17T10:00:05+02:00', duration: 42, wayType: 'incoming' })
    const outbound = f.addConsumption(ACCOUNT, LINE, { calling: '0033972000001', called: '0033198765432', creationDatetime: '2026-10-17T10:30:00+02:00', duration: 0, wayType: 'outgoing' })
    const forward = f.addConsumption(ACCOUNT, LINE, { calling: '0033972000001', called: '0033612345678', creationDatetime: '2026-10-17T11:00:00+02:00', duration: 12, wayType: 'transfer' })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033612345678', called: '0033972000001', creationDatetime: '2026-10-16T10:00:00+02:00', duration: 3, wayType: 'incoming' })
    expect(await ovh.listCdrIds(LINE, '2026-10-17T00:00:00.000Z', '2026-10-17T23:59:59.000Z')).toEqual([inbound, outbound, forward].map(String))
    expect(await ovh.getCdr(LINE, String(inbound))).toEqual({ id: String(inbound), line: LINE, direction: 'inbound', calling: '+33612345678', called: '+33972000001', startedAt: '2026-10-17T08:00:05.000Z', durationSec: 42 })
    expect(await ovh.getCdr(LINE, String(outbound))).toMatchObject({ direction: 'outbound', calling: '+33972000001', called: '+33198765432', durationSec: 0 })
    expect(await ovh.getCdr(LINE, String(forward))).toMatchObject({ direction: 'inbound', forwarded: true })
    expect(await ovh.getCdr(LINE, '1')).toBeUndefined()
  })

  it('comes from the environment with its four variables, or not at all', () => {
    expect(ovhOperatorFromEnv({})).toBeUndefined()
    expect(() => ovhOperatorFromEnv({ OVH_APPLICATION_KEY: 'a' })).toThrow('OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY, OVH_BILLING_ACCOUNT: required with OVH_APPLICATION_KEY')
    expect(ovhOperatorFromEnv({ OVH_APPLICATION_KEY: 'a', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c', OVH_BILLING_ACCOUNT: ACCOUNT })?.id).toBe('ovh')
    expect(() => ovhOperatorFromEnv({ OVH_APPLICATION_KEY: 'a', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c', OVH_BILLING_ACCOUNT: ACCOUNT, OVH_ENDPOINT: 'nowhere' })).toThrow(/endpoint/)
  })
})
