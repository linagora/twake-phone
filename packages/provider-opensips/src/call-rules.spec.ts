import { describe, expect, it } from 'vitest'
import { CALL_RULES_SCHEMA, CallRules, DND_MESSAGE_MAX } from './call-rules.js'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL } from './subscriber.js'

/** A pool that records what it is asked and answers `rows` to the SELECTs. */
const recorder = (rows: unknown[] = []) => {
  const queries: { text: string; values?: unknown[] }[] = []
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim(), values })
      return { rows: text.startsWith('SELECT') ? rows : [] }
    }
  }
  return { queries, pool }
}

describe('CALL_RULES_SCHEMA', () => {
  it('is created at each start of the Gateway and by the file of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(CALL_RULES_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS call_rules')
  })
})

describe('CallRules', () => {
  it('reads the forwards of an extension, and none when it has no row', async () => {
    const db = recorder([{ forward_always: null, forward_busy: '103', forward_noanswer: '104', noanswer_delay: 15 }])
    expect(await new CallRules({ pool: db.pool }).getForwarding('102')).toEqual({ busy: '103', noAnswer: { target: '104', delaySec: 15 } })
    expect(db.queries[0]!.values).toEqual(['102'])
    expect(await new CallRules({ pool: recorder().pool }).getForwarding('102')).toEqual({})
  })

  it('upserts the forwards, then removes the row if it says nothing any more', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool })
    await rules.setForwarding('102', { always: '103', noAnswer: { target: '104', delaySec: 3 } })
    expect(db.queries[0]!.text).toMatch(/^INSERT INTO call_rules .* ON CONFLICT \(extension\) DO UPDATE/)
    expect(db.queries[0]!.values).toEqual(['102', '103', null, '104', 3])
    expect(db.queries[1]!.text).toMatch(/^DELETE FROM call_rules WHERE extension = \$1 AND NOT dnd/)
    await rules.setForwarding('102', {})
    expect(db.queries[2]!.values).toEqual(['102', null, null, null, 20])
  })

  it('refuses what is not an extension, and a delay out of bounds, before any query', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool })
    await expect(rules.setForwarding("102' OR 1=1", {})).rejects.toMatchObject({ statusCode: 400 })
    await expect(rules.setForwarding('102', { always: 'sip:103@elsewhere' })).rejects.toMatchObject({ statusCode: 400, message: /forward target/ })
    await expect(rules.setForwarding('102', { busy: '' })).rejects.toMatchObject({ statusCode: 400 })
    for (const delaySec of [1, 121, 2.5]) await expect(rules.setForwarding('102', { noAnswer: { target: '103', delaySec } })).rejects.toMatchObject({ statusCode: 400, message: /delay/ })
    await expect(rules.getForwarding('')).rejects.toMatchObject({ statusCode: 400 })
    expect(db.queries).toEqual([])
  })

  it('writes a "do not disturb" with its end and message, and lifts it with null', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool })
    await rules.setDnd('102', { until: '2026-10-15T16:00:00.000Z', message: 'En réunion' })
    expect(db.queries[0]!.values).toEqual(['102', true, '2026-10-15T16:00:00.000Z', 'En réunion'])
    await rules.setDnd('102', {})
    expect(db.queries[2]!.values).toEqual(['102', true, null, ''])
    await rules.setDnd('102', null)
    expect(db.queries[4]!.values).toEqual(['102', false, null, ''])
    expect(db.queries[5]!.text).toMatch(/^DELETE FROM call_rules/)
  })

  it('refuses a message that would not fit in one SIP header line, and a date that is not one', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool })
    for (const message of ['two\r\nlines', 'tab\there', 'x'.repeat(DND_MESSAGE_MAX + 1)]) await expect(rules.setDnd('102', { message })).rejects.toMatchObject({ statusCode: 400 })
    await expect(rules.setDnd('102', { until: 'tomorrow' })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.queries).toEqual([])
    await rules.setDnd('102', { message: 'x'.repeat(DND_MESSAGE_MAX) })
    expect(db.queries).toHaveLength(2)
  })

  it('lifts the "do not disturb" of every extension but those kept, and drops the rows left empty', async () => {
    const db = recorder()
    await new CallRules({ pool: db.pool }).clearDndExcept(['102'])
    expect(db.queries[0]).toMatchObject({ text: expect.stringMatching(/^UPDATE call_rules SET dnd = false.*NOT \(extension = ANY\(\$1\)\)/), values: [['102']] })
    expect(db.queries[1]!.text).toMatch(/^DELETE FROM call_rules WHERE NOT dnd AND/)
  })

  it('waits for the schema before each query', async () => {
    const order: string[] = []
    const rules = new CallRules({ pool: { query: async () => void order.push('query') }, ready: async () => void order.push('ready') })
    expect(await rules.getForwarding('102')).toEqual({})
    expect(order).toEqual(['ready', 'query'])
  })
})
