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
  /** Who holds which extension in these tests. */
  const holderOf = async (extension: string) => ({ '102': 'bob', '103': 'carol', '104': 'dave' })[extension]

  it('reads the forwards of an extension of its tenant, and none when it has no row', async () => {
    const db = recorder([{ forward_always: null, forward_busy: '103', forward_noanswer: '104', noanswer_delay: 15 }])
    expect(await new CallRules({ pool: db.pool, tenantId: 'A' }).getForwarding('102')).toEqual({ busy: '103', noAnswer: { target: '104', delaySec: 15 } })
    expect(db.queries[0]!.text).toMatch(/WHERE extension = \$1 AND tenant_id = \$2$/)
    expect(db.queries[0]!.values).toEqual(['102', 'A'])
    expect(await new CallRules({ pool: recorder().pool }).getForwarding('102')).toEqual({})
  })

  it('upserts the forwards with who holds the extension and each target, then removes the row if it says nothing any more', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool, tenantId: 'A', holderOf })
    await rules.setForwarding('102', { always: '103', noAnswer: { target: '104', delaySec: 5 } }, 'bob')
    expect(db.queries[0]!.text).toMatch(/^INSERT INTO call_rules .* ON CONFLICT \(extension\) DO UPDATE/)
    // Another holder's "do not disturb" is not kept with the extension.
    expect(db.queries[0]!.text).toContain('dnd = call_rules.dnd AND call_rules.holder = EXCLUDED.holder')
    expect(db.queries[0]!.values).toEqual(['102', 'A', 'bob', '103', 'carol', null, null, '104', 'dave', 5])
    // Its own row only: another tenant's 102 is not its to remove.
    expect(db.queries[1]).toMatchObject({ text: expect.stringMatching(/^DELETE FROM call_rules WHERE extension = \$1 AND tenant_id = \$2 AND NOT dnd/), values: ['102', 'A'] })
    await rules.setForwarding('102', { busy: '199' }, 'bob')
    // Nobody holds 199: an empty holder, which no mapping matches.
    expect(db.queries[2]!.values).toEqual(['102', 'A', 'bob', null, null, '199', '', null, null, 20])
  })

  it('refuses what is not an extension, and a delay out of bounds, before any query', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool })
    await expect(rules.setForwarding("102' OR 1=1", {}, 'bob')).rejects.toMatchObject({ statusCode: 400 })
    await expect(rules.setForwarding('102', { always: 'sip:103@elsewhere' }, 'bob')).rejects.toMatchObject({ statusCode: 400, message: /forward target/ })
    await expect(rules.setForwarding('102', { busy: '' }, 'bob')).rejects.toMatchObject({ statusCode: 400 })
    for (const delaySec of [1, 4, 121, 5.5]) await expect(rules.setForwarding('102', { noAnswer: { target: '103', delaySec } }, 'bob')).rejects.toMatchObject({ statusCode: 400, message: /delay/ })
    await expect(rules.getForwarding('')).rejects.toMatchObject({ statusCode: 400 })
    expect(db.queries).toEqual([])
  })

  it('writes a "do not disturb" with its end, message and holder, and lifts it with null', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool, tenantId: 'A' })
    await rules.setDnd('102', { until: '2026-10-15T16:00:00.000Z', message: 'En réunion' }, 'bob')
    expect(db.queries[0]!.values).toEqual(['102', 'A', 'bob', true, '2026-10-15T16:00:00.000Z', 'En réunion'])
    // Another holder's forwards are not kept with the extension.
    expect(db.queries[0]!.text).toContain('forward_always = CASE WHEN call_rules.holder = EXCLUDED.holder THEN call_rules.forward_always END')
    await rules.setDnd('102', {}, 'bob')
    expect(db.queries[2]!.values).toEqual(['102', 'A', 'bob', true, null, ''])
    await rules.setDnd('102', null, 'bob')
    expect(db.queries[4]!.values).toEqual(['102', 'A', 'bob', false, null, ''])
    expect(db.queries[5]!.text).toMatch(/^DELETE FROM call_rules/)
  })

  it('refuses a message that would not fit in one SIP header line, and a date that is not one', async () => {
    const db = recorder()
    const rules = new CallRules({ pool: db.pool })
    for (const message of ['two\r\nlines', 'tab\there', 'x'.repeat(DND_MESSAGE_MAX + 1)]) await expect(rules.setDnd('102', { message }, 'bob')).rejects.toMatchObject({ statusCode: 400 })
    await expect(rules.setDnd('102', { until: 'tomorrow' }, 'bob')).rejects.toMatchObject({ statusCode: 400 })
    expect(db.queries).toEqual([])
    await rules.setDnd('102', { message: 'x'.repeat(DND_MESSAGE_MAX) }, 'bob')
    expect(db.queries).toHaveLength(2)
  })

  it("lifts the \"do not disturb\" of every extension of its tenant but those kept, and drops the rows left empty", async () => {
    const db = recorder()
    await new CallRules({ pool: db.pool, tenantId: 'A' }).clearDndExcept(['102'])
    expect(db.queries[0]).toMatchObject({ text: expect.stringMatching(/^UPDATE call_rules SET dnd = false.* WHERE tenant_id = \$1 AND dnd AND \(NOT \(extension = ANY\(\$2\)\) OR dnd_until <= now\(\)\)/), values: ['A', ['102']] })
    expect(db.queries[1]).toMatchObject({ text: expect.stringMatching(/^DELETE FROM call_rules WHERE tenant_id = \$1 AND NOT dnd AND/), values: ['A'] })
  })

  it('drops, in its tenant only, the rules of an extension that changed holder and the forwards to one', async () => {
    const db = recorder()
    await new CallRules({ pool: db.pool, tenantId: 'A' }).reconcile([{ extension: '101', userId: 'alice' }, { extension: '102', userId: 'bob' }])
    expect(db.queries).toHaveLength(5)
    for (const q of db.queries) expect(q.text).toContain('tenant_id = $1')
    // With the rows of no tenant: written before the holders were (an older schema), nobody's any more.
    expect(db.queries[0]).toMatchObject({ text: expect.stringMatching(/^DELETE FROM call_rules WHERE \(tenant_id = \$1 AND NOT EXISTS .*m\.extension = call_rules\.extension AND m\.holder = call_rules\.holder\)\) OR tenant_id = ''$/), values: ['A', ['101', '102'], ['alice', 'bob']] })
    expect(db.queries.slice(1, 4).map(q => q.text.match(/^UPDATE call_rules SET (\w+) = NULL, (\w+) = NULL/)?.slice(1))).toEqual([
      ['forward_always', 'forward_always_holder'],
      ['forward_busy', 'forward_busy_holder'],
      ['forward_noanswer', 'forward_noanswer_holder']
    ])
    expect(db.queries[4]!.text).toMatch(/^DELETE FROM call_rules WHERE tenant_id = \$1 AND NOT dnd/)
  })

  it('waits for the schema before each query', async () => {
    const order: string[] = []
    const rules = new CallRules({ pool: { query: async () => void order.push('query') }, ready: async () => void order.push('ready') })
    expect(await rules.getForwarding('102')).toEqual({})
    expect(order).toEqual(['ready', 'query'])
  })
})
