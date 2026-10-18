import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, SubscriberProvisioner } from './subscriber.js'
import { MAILBOX, VOICEMAIL_BOXES_SCHEMA, VoicemailBoxes, VoicemailFenced } from './voicemail-boxes.js'

/**
 * A pool that records what it is asked, on its connections too, and answers `rows` to the SELECTs (`writer`: the row of
 * voicemail_writers it locks).
 */
const recorder = (rows: unknown[] = [], writer = { fence: '0', withdrawals: '0' }) => {
  const queries: { text: string; values?: unknown[] }[] = []
  const answer = async (text: string, values?: unknown[]) => {
    queries.push({ text: text.replace(/\s+/g, ' ').trim(), values })
    if (/FROM voicemail_writers/.test(text)) return { rows: [writer], rowCount: 1 }
    return /^SELECT/.test(text.trim()) ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }
  }
  let released = 0
  const pool = { query: answer, connect: async () => ({ query: answer, release: () => void released++ }) }
  return { queries, pool, released: () => released }
}

describe('VOICEMAIL_BOXES_SCHEMA', () => {
  it('is created at each start of the Gateway and by the file of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(VOICEMAIL_BOXES_SCHEMA.trim())
    for (const table of ['voicemail_boxes', 'voicemail_writers', 'voicemail_withdrawals']) expect(SUBSCRIBER_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
  })

  it('takes the mailboxes as OpenSIPS reads them: a number, @, a context, nothing that could close a quote', () => {
    for (const ok of ['102@ctx-None-internal-210d0144-5d9a-4b3c-9d6b-0f6c9a1d2e3f', '1@default', '000112345678901234567890@ctx']) expect(MAILBOX.test(ok), ok).toBe(true)
    for (const bad of ['102', '@default', "102@x'y", '102@a b', 'abc@default', `102@${'a'.repeat(80)}`, '102@default\n']) expect(MAILBOX.test(bad), bad).toBe(false)
  })
})

describe('VoicemailBoxes', () => {
  it('lists the mailboxes of its tenant only', async () => {
    const db = recorder([{ extension: '102', mailbox: '102@ctx' }])
    expect(await new VoicemailBoxes({ pool: db.pool, tenantId: 'A' }).list()).toEqual([{ extension: '102', mailbox: '102@ctx' }])
    expect(db.queries[0]).toMatchObject({ text: 'SELECT extension, mailbox FROM voicemail_boxes WHERE tenant_id = $1 ORDER BY extension', values: ['A'] })
  })

  it('writes exactly the mailboxes given, in one transaction under the lock of the tenant, never one OpenSIPS would not read, and says which it left out', async () => {
    const db = recorder()
    let ready = 0
    const { skipped, withdrawn } = await new VoicemailBoxes({ pool: db.pool, tenantId: 'A', ready: async () => void ready++ }).set([
      { extension: '102', mailbox: '102@ctx' },
      { extension: "1' OR '1'='1", mailbox: '1@ctx' },
      { extension: '103', mailbox: "103@x'; DROP TABLE subscriber; --" }
    ])
    expect(ready).toBe(1)
    expect([skipped.map(b => b.extension), withdrawn]).toEqual([["1' OR '1'='1", '103'], []])
    expect(db.queries.map(q => q.text.split(' ').slice(0, 3).join(' '))).toEqual(['BEGIN', 'INSERT INTO voicemail_writers', 'SELECT fence, withdrawals', 'DELETE FROM voicemail_boxes', 'INSERT INTO voicemail_boxes', 'COMMIT'])
    expect(db.queries[2]!.text).toMatch(/FOR UPDATE$/)
    expect(db.queries[3]).toMatchObject({ values: ['A', ['102']] })
    expect(db.queries[4]).toMatchObject({ values: ['A', ['102'], ['102@ctx']] })
    // Another tenant's row on the same extension stays theirs; a row already right is not written again.
    expect(db.queries[4]!.text).toContain('WHERE voicemail_boxes.tenant_id = EXCLUDED.tenant_id AND voicemail_boxes.mailbox IS DISTINCT FROM EXCLUDED.mailbox')
    expect(db.released()).toBe(1)
    // None: the tenant's rows go, nothing is inserted.
    const none = recorder()
    await new VoicemailBoxes({ pool: none.pool }).set([])
    expect(none.queries.filter(q => q.text.startsWith('INSERT INTO voicemail_boxes'))).toEqual([])
    expect(none.queries.find(q => q.text.startsWith('DELETE FROM voicemail_boxes'))!.values).toEqual(['default', []])
    // Without connections of its own, no transaction: nothing written.
    await expect(new VoicemailBoxes({ pool: { query: none.pool.query } }).set([])).rejects.toThrow(/a transaction/)
  })

  it('withdraws the mailboxes of some extensions of its tenant only, never one that is no extension, numbering the withdrawal (second review 11a, n°3; fourth review n°2)', async () => {
    const db = recorder([], { fence: '0', withdrawals: '6' })
    await new VoicemailBoxes({ pool: db.pool, tenantId: 'A' }).withdraw(['102', "1' OR '1'='1", '102'])
    expect(db.queries.slice(3, 6)).toEqual([
      { text: 'UPDATE voicemail_writers SET withdrawals = $2 WHERE tenant_id = $1', values: ['A', 7] },
      { text: 'INSERT INTO voicemail_withdrawals (tenant_id, extension, seq) SELECT $1, e, $3 FROM unnest($2::text[]) AS e ON CONFLICT (tenant_id, extension) DO UPDATE SET seq = EXCLUDED.seq', values: ['A', ['102'], 7] },
      { text: 'DELETE FROM voicemail_boxes v WHERE v.tenant_id = $1 AND v.extension = ANY($2::text[])', values: ['A', ['102']] }
    ])
    const none = recorder()
    await new VoicemailBoxes({ pool: none.pool, tenantId: 'A' }).withdraw([])
    expect(none.queries).toEqual([])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the SQL itself, and the query of opensips.cfg.tpl on what it writes.
if (process.env.TEST_DATABASE_URL) {
  describe('VoicemailBoxes on PostgreSQL', () => {
    // A schema of its own: subscriber.spec.ts drops and creates the same tables at the same time (in parallel).
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, options: '-c search_path=spec_voicemail_boxes' })
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

    it('never lets a write that read the holders before a withdrawal undo it, whichever Gateway withdrew (fourth review 11a, n°2)', async () => {
      // Two Gateways, each its own pool: A writes the mailboxes, B withdraws 9202 once it gave it to someone else.
      const other = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_voicemail_boxes' })
      try {
        const a = new VoicemailBoxes({ pool, ready, tenantId: 'spec-C' })
        const b = new VoicemailBoxes({ pool: other, ready, tenantId: 'spec-C' })
        await a.set([{ extension: '9201', mailbox: '9201@c' }, { extension: '9202', mailbox: '000100000000000000000001@c' }], { fence: 10, since: await a.mark() })
        // A's round reads the mark, then the holders (Jean at 9202); B withdraws 9202 (Marie has it); A writes what it read.
        const since = await a.mark()
        await b.withdraw(['9202'])
        expect(await b.list()).toEqual([{ extension: '9201', mailbox: '9201@c' }])
        const stale = await a.set([{ extension: '9201', mailbox: '9201@c' }, { extension: '9202', mailbox: '000100000000000000000001@c' }], { fence: 10, since })
        expect(stale.withdrawn).toEqual(['9202'])
        expect(await a.list()).toEqual([{ extension: '9201', mailbox: '9201@c' }])
        // The same round's second write (after the voicemail server's changes), under the same mark: still left out.
        const again = await a.set([{ extension: '9201', mailbox: '9201@c' }, { extension: '9202', mailbox: '000100000000000000000001@c' }], { fence: 10, since })
        expect(again.withdrawn).toEqual(['9202'])
        expect(await a.list()).toEqual([{ extension: '9201', mailbox: '9201@c' }])
        // The next round reads a mark after the withdrawal, and the holders after it: Marie's mailbox at 9202.
        await a.set([{ extension: '9201', mailbox: '9201@c' }, { extension: '9202', mailbox: '000100000000000000000002@c' }], { fence: 10, since: await a.mark() })
        expect(await a.list()).toEqual([{ extension: '9201', mailbox: '9201@c' }, { extension: '9202', mailbox: '000100000000000000000002@c' }])
        // A withdrawal and a write at the same time: whichever goes first, the write that read before never undoes it.
        for (let i = 0; i < 5; i++) {
          const mark = await a.mark()
          await Promise.all([b.withdraw(['9202']), a.set([{ extension: '9202', mailbox: '000100000000000000000002@c' }], { fence: 10, since: mark })])
          expect(await a.list()).toEqual([])
          await a.set([{ extension: '9202', mailbox: '000100000000000000000002@c' }], { fence: 10, since: await a.mark() })
        }
      } finally {
        await other.end()
      }
    })

    it('refuses a write under an older lease than the last one written, and leaves the rows as they were (fourth review 11a, n°2)', async () => {
      const a = new VoicemailBoxes({ pool, ready, tenantId: 'spec-D' })
      await a.set([{ extension: '9301', mailbox: '9301@d' }], { fence: 100 })
      // A later lease writes; the older one's write that comes after is refused, whole.
      await a.set([{ extension: '9302', mailbox: '9302@d' }], { fence: 200 })
      const refused = await a.set([{ extension: '9301', mailbox: '9301@d' }], { fence: 100 }).catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(VoicemailFenced)
      expect(refused).toMatchObject({ code: 'VOICEMAIL_FENCED', fence: 100, written: 200 })
      expect(await a.list()).toEqual([{ extension: '9302', mailbox: '9302@d' }])
      // The same lease writes again; a withdrawal needs none.
      await a.set([{ extension: '9303', mailbox: '9303@d' }], { fence: 200 })
      await a.withdraw(['9303'])
      expect(await a.list()).toEqual([])
    })

    it('writes the whole list or nothing: OpenSIPS never reads it half written', async () => {
      const a = new VoicemailBoxes({ pool, ready, tenantId: 'spec-E' })
      await a.set([{ extension: '9401', mailbox: '9401@e' }])
      // The insert made to fail once the delete is done (a check that refuses 9499): the delete is undone too.
      await pool.query("ALTER TABLE voicemail_boxes ADD CONSTRAINT spec_no_9499 CHECK (extension <> '9499')")
      try {
        await expect(a.set([{ extension: '9402', mailbox: '9402@e' }, { extension: '9499', mailbox: '9499@e' }])).rejects.toThrow(/spec_no_9499/)
        expect(await a.list()).toEqual([{ extension: '9401', mailbox: '9401@e' }])
      } finally {
        await pool.query('ALTER TABLE voicemail_boxes DROP CONSTRAINT spec_no_9499')
      }
    })
  })
}
