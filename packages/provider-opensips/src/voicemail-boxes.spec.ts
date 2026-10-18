import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, SubscriberProvisioner } from './subscriber.js'
import { MAILBOX, VOICEMAIL_BOXES_SCHEMA, VoicemailBoxes } from './voicemail-boxes.js'

/** A pool that records what it is asked and answers `rows` to the SELECTs. */
const recorder = (rows: unknown[] = []) => {
  const queries: { text: string; values?: unknown[] }[] = []
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim(), values })
      return /^SELECT/.test(text.trim()) ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }
    }
  }
  return { queries, pool }
}

describe('VOICEMAIL_BOXES_SCHEMA', () => {
  it('is created at each start of the Gateway and by the file of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(VOICEMAIL_BOXES_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS voicemail_boxes')
  })

  it('takes the mailboxes as OpenSIPS reads them: a number, @, a context, nothing that could close a quote', () => {
    for (const ok of ['102@ctx-None-internal-210d0144-5d9a-4b3c-9d6b-0f6c9a1d2e3f', '1@default']) expect(MAILBOX.test(ok), ok).toBe(true)
    for (const bad of ['102', '@default', "102@x'y", '102@a b', 'abc@default', `102@${'a'.repeat(80)}`, '102@default\n']) expect(MAILBOX.test(bad), bad).toBe(false)
  })
})

describe('VoicemailBoxes', () => {
  it('lists the mailboxes of its tenant only', async () => {
    const db = recorder([{ extension: '102', mailbox: '102@ctx' }])
    expect(await new VoicemailBoxes({ pool: db.pool, tenantId: 'A' }).list()).toEqual([{ extension: '102', mailbox: '102@ctx' }])
    expect(db.queries[0]).toMatchObject({ text: 'SELECT extension, mailbox FROM voicemail_boxes WHERE tenant_id = $1 ORDER BY extension', values: ['A'] })
  })

  it('writes exactly the mailboxes given, never one OpenSIPS would not read, and says which it left out', async () => {
    const db = recorder()
    let ready = 0
    const { skipped } = await new VoicemailBoxes({ pool: db.pool, tenantId: 'A', ready: async () => void ready++ }).set([
      { extension: '102', mailbox: '102@ctx' },
      { extension: "1' OR '1'='1", mailbox: '1@ctx' },
      { extension: '103', mailbox: "103@x'; DROP TABLE subscriber; --" }
    ])
    expect(ready).toBe(2)
    expect(skipped.map(b => b.extension)).toEqual(["1' OR '1'='1", '103'])
    expect(db.queries.map(q => q.values)).toEqual([
      ['A', ['102']],
      ['A', ['102'], ['102@ctx']]
    ])
    expect(db.queries[0]!.text).toMatch(/^DELETE FROM voicemail_boxes v WHERE v.tenant_id = \$1/)
    // Another tenant's row on the same extension stays theirs; a row already right is not written again.
    expect(db.queries[1]!.text).toContain('WHERE voicemail_boxes.tenant_id = EXCLUDED.tenant_id AND voicemail_boxes.mailbox IS DISTINCT FROM EXCLUDED.mailbox')
    // None: the tenant's rows go, nothing is inserted.
    const none = recorder()
    await new VoicemailBoxes({ pool: none.pool }).set([])
    expect(none.queries).toHaveLength(1)
    expect(none.queries[0]!.values).toEqual(['default', []])
  })

  it('withdraws the mailboxes of some extensions of its tenant only, never one that is no extension (second review 11a, n°3)', async () => {
    const db = recorder()
    await new VoicemailBoxes({ pool: db.pool, tenantId: 'A' }).withdraw(['102', "1' OR '1'='1"])
    expect(db.queries).toEqual([{ text: 'DELETE FROM voicemail_boxes v WHERE v.tenant_id = $1 AND v.extension = ANY($2::text[])', values: ['A', ['102']] }])
    const none = recorder()
    await new VoicemailBoxes({ pool: none.pool, tenantId: 'A' }).withdraw([])
    expect(none.queries).toEqual([])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the SQL itself, and the query of opensips.cfg.tpl on what it writes.
if (process.env.TEST_DATABASE_URL) {
  describe('VoicemailBoxes on PostgreSQL', () => {
    // A schema of its own: subscriber.spec.ts drops and creates the same tables at the same time (in parallel).
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_voicemail_boxes' })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_voicemail_boxes CASCADE')
      await pool.end()
    })
    const ready = async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS spec_voicemail_boxes')
      await new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).ensureSchema()
    }
    beforeAll(ready)

    it('keeps each tenant to its own rows, and gives OpenSIPS the mailbox of the extension dialled', async () => {
      const a = new VoicemailBoxes({ pool, ready, tenantId: 'spec-A' })
      const b = new VoicemailBoxes({ pool, ready, tenantId: 'spec-B' })
      await a.set([
        { extension: '9102', mailbox: '9102@ctx-a' },
        { extension: '9103', mailbox: '9103@ctx-a' }
      ])
      // B cannot take A's extension, nor remove it.
      await b.set([{ extension: '9102', mailbox: '9102@ctx-b' }])
      await b.set([])
      expect(await a.list()).toEqual([
        { extension: '9102', mailbox: '9102@ctx-a' },
        { extension: '9103', mailbox: '9103@ctx-a' }
      ])
      // 9103's holder left: its mailbox goes; 9102's changed.
      await a.set([{ extension: '9102', mailbox: '9102@ctx-c' }])
      expect(await a.list()).toEqual([{ extension: '9102', mailbox: '9102@ctx-c' }])
      // An extension given to someone else: its mailbox withdrawn at once, never another tenant's.
      await b.set([{ extension: '9105', mailbox: '9105@ctx-b' }])
      await a.set([
        { extension: '9102', mailbox: '9102@ctx-c' },
        { extension: '9106', mailbox: '9106@ctx-c' }
      ])
      await a.withdraw(['9102', '9105'])
      expect(await a.list()).toEqual([{ extension: '9106', mailbox: '9106@ctx-c' }])
      expect(await b.list()).toEqual([{ extension: '9105', mailbox: '9105@ctx-b' }])
      await a.set([{ extension: '9102', mailbox: '9102@ctx-c' }])
      // route[rules_next]'s column, as it reads it.
      const read = async (ext: string) => (await pool.query(`SELECT (SELECT v.mailbox FROM voicemail_boxes v WHERE v.extension = '${ext}' AND v.mailbox ~ '^[0-9]{1,40}@[A-Za-z0-9_-]{1,79}$') AS m`)).rows[0].m
      expect(await read('9102')).toBe('9102@ctx-c')
      expect(await read('9103')).toBeNull()
      // A row written by hand that OpenSIPS could not carry in a header is not read.
      await pool.query("INSERT INTO voicemail_boxes (extension, tenant_id, mailbox) VALUES ('9104', 'spec-A', '9104@a b')")
      expect(await read('9104')).toBeNull()
      expect((await pool.query("SELECT to_regclass('voicemail_boxes') IS NULL AS missing")).rows[0].missing).toBe(false)
    })
  })
}
