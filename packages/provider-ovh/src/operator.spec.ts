import { afterEach, describe, expect, it } from 'vitest'
import { startFakeOvh, type FakeOvh } from '../test/fake-ovh.mjs'
import { ovhOperatorFromEnv } from './index.js'
import { fromOvhNumber, toOvhNumber } from './numbers.js'
import { OvhOperator } from './operator.js'

const ACCOUNT = 'ab12345-ovh-1'
const LINE = '0033972000001'
const fakes: FakeOvh[] = []
const NOW = Date.parse('2026-10-17T12:00:00.000Z')
const setup = async (lines: Record<string, object> = { [LINE]: {}, '0033972000002': {} }) => {
  const f = await startFakeOvh({ accounts: { [ACCOUNT]: { lines } } })
  fakes.push(f)
  return { f, ovh: new OvhOperator({ ...f.credentials, baseUrl: f.url, billingAccount: ACCOUNT, now: () => NOW }) }
}
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})

describe('OVHcloud as the operator of the trunks', () => {
  it('writes numbers as OVH does (00 and the country code) and reads them back in E.164', () => {
    expect(toOvhNumber('+33612345678')).toBe('0033612345678')
    expect(() => toOvhNumber('0612345678')).toThrow()
    expect(['0033612345678', '0612345678', '+33612345678', '0032 2 555 01 00', 'anonymous', '3179'].map(fromOvhNumber)).toEqual(['+33612345678', '+33612345678', '+33612345678', '+3225550100', 'anonymous', '3179'])
    expect(() => new OvhOperator({ applicationKey: 'a', applicationSecret: 's', consumerKey: 'c', billingAccount: '../me' })).toThrow(/billing account/)
  })

  it('sets the fallback on unavailability and on no answer to one number, reads each forward back, and removes them; nothing else of the line', async () => {
    const { f, ovh } = await setup({ [LINE]: { options: { forwardBusy: true, forwardBusyNumber: '0033100000000', displayNumber: '0033972000001' } } })
    expect(await ovh.getForwards(LINE)).toEqual({})
    await ovh.setFallback(LINE, { number: '+33612345678', onUnavailable: true, noAnswerAfterSec: 150 })
    expect(f.requests.at(-1)!.body).toEqual({ forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033612345678', forwardNoReply: true, forwardNoReplyDelay: 150, forwardNoReplyNature: 'number', forwardNoReplyNumber: '0033612345678' })
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBusy: true, forwardBusyNumber: '0033100000000', displayNumber: '0033972000001' })
    expect(await ovh.getForwards(LINE)).toEqual({ onUnavailable: { nature: 'number', number: '+33612345678' }, onNoAnswer: { nature: 'number', number: '+33612345678', afterSec: 150 } })
    await ovh.setFallback(LINE, { number: '+33612345678', onUnavailable: true })
    expect(await ovh.getForwards(LINE)).toEqual({ onUnavailable: { nature: 'number', number: '+33612345678' } })
    await ovh.setFallback(LINE, { onUnavailable: false })
    expect(f.requests.at(-1)!.body).toEqual({ forwardBackup: false, forwardNoReply: false })
    expect(await ovh.getForwards(LINE)).toEqual({})
    await expect(ovh.setFallback(LINE, { onUnavailable: true })).rejects.toThrow(/number/)
  })

  it('puts forwards back as they were: the voicemail on no answer, a number on unavailability; a forward elsewhere is not written (third review 10b, n°8)', async () => {
    const { f, ovh } = await setup({ [LINE]: { options: { forwardBusy: true, displayNumber: '0033972000001' } } })
    await ovh.setForwards(LINE, { onUnavailable: { nature: 'number', number: '+33612345678' }, onNoAnswer: { nature: 'voicemail', afterSec: 20 } })
    expect(f.requests.at(-1)!.body).toEqual({ forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033612345678', forwardNoReply: true, forwardNoReplyDelay: 20, forwardNoReplyNature: 'voicemail' })
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBusy: true, displayNumber: '0033972000001' })
    expect(await ovh.getForwards(LINE)).toEqual({ onUnavailable: { nature: 'number', number: '+33612345678' }, onNoAnswer: { nature: 'voicemail', afterSec: 20 } })
    await ovh.setForwards(LINE, { onUnavailable: { nature: 'fax' } })
    expect(await ovh.getForwards(LINE)).toEqual({ onUnavailable: { nature: 'fax' } })
    await ovh.setForwards(LINE, {})
    expect(f.requests.at(-1)!.body).toEqual({ forwardBackup: false, forwardNoReply: false })
    expect(await ovh.getForwards(LINE)).toEqual({})
    const puts = f.requests.filter(r => r.method === 'PUT').length
    await expect(ovh.setForwards(LINE, { onNoAnswer: { nature: 'other', afterSec: 20 } })).rejects.toThrow(/other/)
    await expect(ovh.setForwards(LINE, { onUnavailable: { nature: 'number' } })).rejects.toThrow(/no number/)
    expect(f.requests.filter(r => r.method === 'PUT').length).toBe(puts)
  })

  it('reads each forward set in the manager as it is: two numbers, the voicemail, a fax, something unknown (review 10b, n°4 and n°15)', async () => {
    const { ovh } = await setup({
      [LINE]: { options: { forwardBackup: true, forwardBackupNumber: '0033612345678', forwardNoReply: true, forwardNoReplyDelay: 30, forwardNoReplyNumber: '0033698765432' } },
      '0033972000002': { options: { forwardBackup: true, forwardBackupNature: 'voicemail', forwardBackupNumber: '0033612345678', forwardNoReply: true, forwardNoReplyDelay: 150, forwardNoReplyNumber: '0033612345678' } },
      '0033972000003': { options: { forwardBackup: true, forwardBackupNature: 'fax', forwardNoReply: true, forwardNoReplyNature: 'telepathy' } }
    })
    expect(await ovh.getForwards(LINE)).toEqual({ onUnavailable: { nature: 'number', number: '+33612345678' }, onNoAnswer: { nature: 'number', number: '+33698765432', afterSec: 30 } })
    // Its number stays written for the voicemail, but the calls go to the voicemail.
    expect(await ovh.getForwards('0033972000002')).toEqual({ onUnavailable: { nature: 'voicemail' }, onNoAnswer: { nature: 'number', number: '+33612345678', afterSec: 150 } })
    expect(await ovh.getForwards('0033972000003')).toEqual({ onUnavailable: { nature: 'fax' }, onNoAnswer: { nature: 'other', afterSec: 20 } })
  })

  it('has a delay OVH refuses refused, its words in the error (review 10b, n°16)', async () => {
    const { f, ovh } = await setup()
    f.state.acceptDelay = sec => sec <= 120
    await expect(ovh.setFallback(LINE, { number: '+33612345678', onUnavailable: true, noAnswerAfterSec: 150 })).rejects.toMatchObject({ code: 'refused', message: `OVH PUT /telephony/${ACCOUNT}/line/${LINE}/options: 400 INVALID_PARAMETER Invalid value for forwardNoReplyDelay` })
    expect(await ovh.getForwards(LINE)).toEqual({})
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
    // Only the current period is asked away from the turn of the month.
    expect(f.requests.some(r => r.path.endsWith('/previousVoiceConsumption'))).toBe(false)
  })

  it('reads the records of the previous billing period too at the turn of the month, each once (review 10b, n°9)', async () => {
    const { f, ovh } = await setup()
    f.state.monthStart = Date.parse('2026-10-31T23:00:00+01:00')
    const before = f.addConsumption(ACCOUNT, LINE, { calling: '0033612345678', called: '0033972000001', creationDatetime: '2026-10-31T22:00:00+01:00', duration: 42, wayType: 'incoming' })
    const after = f.addConsumption(ACCOUNT, LINE, { calling: '0033612345678', called: '0033972000001', creationDatetime: '2026-11-01T09:00:00+01:00', duration: 7, wayType: 'incoming' })
    expect((await ovh.listCdrIds(LINE, '2026-10-30T12:00:00.000Z', '2026-11-01T12:00:00.000Z')).sort()).toEqual([String(before), String(after)].sort())
    expect(await ovh.getCdr(LINE, String(before))).toMatchObject({ startedAt: '2026-10-31T21:00:00.000Z', durationSec: 42 })
    expect(await ovh.getCdr(LINE, String(after))).toMatchObject({ startedAt: '2026-11-01T08:00:00.000Z', durationSec: 7 })
  })

  it('reads the previous billing period for a day past the first of the month, in UTC: a period that ends later there (ovh-ca) is read whole (second review 10b, n°10)', async () => {
    const { f, ovh } = await setup()
    // The month ends at midnight in Montréal, 05:00 in UTC; the window starts 2 hours into the UTC month.
    f.state.monthStart = Date.parse('2026-11-01T00:00:00-05:00')
    const late = f.addConsumption(ACCOUNT, LINE, { calling: '0033612345678', called: '0033972000001', creationDatetime: '2026-11-01T03:00:00+00:00', duration: 42, wayType: 'incoming' })
    expect(await ovh.listCdrIds(LINE, '2026-11-01T02:00:00.000Z', '2026-11-03T02:00:00.000Z')).toEqual([String(late)])
    // Past the day: the current period only.
    f.requests.length = 0
    await ovh.listCdrIds(LINE, '2026-11-02T00:00:01.000Z', '2026-11-04T00:00:01.000Z')
    expect(f.requests.some(r => r.path.endsWith('/previousVoiceConsumption'))).toBe(false)
  })

  it('keeps a record it cannot read as a call as such: a date without its offset, an unknown way (review 10b, n°19 and n°20)', async () => {
    const { f, ovh } = await setup()
    const local = f.addConsumption(ACCOUNT, LINE, { calling: '0033612345678', called: '0033972000001', creationDatetime: '2026-10-17T10:00:05', duration: 42, wayType: 'incoming' })
    const odd = f.addConsumption(ACCOUNT, LINE, { calling: '0033612345678', called: '0033972000001', creationDatetime: '2026-10-17T10:00:05+02:00', duration: 42, wayType: 'conference' })
    expect(await ovh.getCdr(LINE, String(local))).toEqual({ id: String(local), line: LINE, direction: 'inbound', calling: '', called: '', startedAt: '2026-10-17T12:00:00.000Z', durationSec: 0, invalid: 'creationDatetime without its offset' })
    expect(await ovh.getCdr(LINE, String(odd))).toMatchObject({ invalid: 'wayType conference', calling: '', called: '' })
  })

  it('comes from the environment with its four variables, or not at all, at one of the three entry points (review 10b, n°11 and n°24)', () => {
    const keys = { OVH_APPLICATION_KEY: 'a', OVH_APPLICATION_SECRET: 's', OVH_CONSUMER_KEY: 'c', OVH_BILLING_ACCOUNT: ACCOUNT }
    expect(ovhOperatorFromEnv({})).toBeUndefined()
    expect(() => ovhOperatorFromEnv({ OVH_APPLICATION_KEY: 'a' })).toThrow('OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY, OVH_BILLING_ACCOUNT: required with OVH_APPLICATION_KEY')
    expect(() => ovhOperatorFromEnv({ OVH_ENDPOINT: 'ovh-ca' })).toThrow('OVH_ENDPOINT: given without')
    expect(ovhOperatorFromEnv(keys)?.id).toBe('ovh')
    expect(ovhOperatorFromEnv({ ...keys, OVH_ENDPOINT: 'ovh-us' })?.id).toBe('ovh')
    for (const OVH_ENDPOINT of ['nowhere', 'http://169.254.169.254/latest', 'https://eu.api.ovh.com/1.0']) expect(() => ovhOperatorFromEnv({ ...keys, OVH_ENDPOINT })).toThrow('OVH_ENDPOINT: ovh-eu, ovh-ca or ovh-us')
  })
})
