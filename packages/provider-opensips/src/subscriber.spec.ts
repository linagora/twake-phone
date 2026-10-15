import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, SUBSCRIBER_TABLE_VERSION, SubscriberProvisioner, digestHashes } from './subscriber.js'

describe('SUBSCRIBER_SCHEMA', () => {
  it('is the SQL the Compose stack loads into PostgreSQL at first start (docker/opensips/subscriber.sql)', () => {
    const file = readFileSync(new URL('../../../docker/opensips/subscriber.sql', import.meta.url), 'utf8')
    const statements = (sql: string) => sql.split('\n').filter(l => !l.startsWith('--')).join('\n').trim()
    expect(statements(file)).toBe(statements(SUBSCRIBER_SQL))
  })

  it('adds the caller and callee columns in the file (run once, by the owner), not at each start of the Gateway', () => {
    for (const table of ['acc', 'missed_calls']) {
      for (const column of ['caller', 'callee']) {
        const alter = `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} VARCHAR(64) DEFAULT '' NOT NULL;`
        expect(SUBSCRIBER_SQL).toContain(alter)
        expect(SUBSCRIBER_SCHEMA).not.toContain(alter)
      }
    }
  })
})

describe('digestHashes', () => {
  it('computes the HA1 values auth_db compares against (RFC 7616 A1 = user:realm:password)', () => {
    // md5("101:sip.example.test:s3cret"), checked with `printf '101:sip.example.test:s3cret' | md5sum`.
    const h = digestHashes('101', 'sip.example.test', 's3cret')
    expect(h.ha1).toBe('4c72c8368eb8ec309fc6be33755cdccd')
    expect(h.ha1Sha256).toHaveLength(64)
    expect(h.ha1Sha512t256).toHaveLength(64)
    expect(digestHashes('101', 'other.realm', 's3cret').ha1).not.toBe(h.ha1)
  })
})

describe('SubscriberProvisioner', () => {
  it('writes the hashes, never the secret, and upserts on the account', async () => {
    const queries: { text: string; values?: unknown[] }[] = []
    const p = new SubscriberProvisioner({ pool: { query: async (text, values) => void queries.push({ text, values }) }, realm: 'sip.example.test' })
    await p.setSipSecret('101', 's3cret')
    await p.setSipSecret('101', 'another')
    expect(queries).toHaveLength(2)
    expect(queries[0]!.text).toMatch(/INSERT INTO subscriber/)
    expect(queries[0]!.text).toMatch(/ON CONFLICT \(username, domain\)/)
    expect(queries[0]!.values).toEqual(['101', '', '4c72c8368eb8ec309fc6be33755cdccd', expect.any(String), expect.any(String)])
    expect(JSON.stringify(queries)).not.toContain('s3cret')
  })

  it('refuses an extension that is not a SIP user name', async () => {
    const p = new SubscriberProvisioner({ pool: { query: async () => undefined }, realm: 'r' })
    await expect(p.setSipSecret("101' OR 1=1", 'x')).rejects.toMatchObject({ statusCode: 400 })
    await expect(p.setSipSecret('', 'x')).rejects.toMatchObject({ statusCode: 400 })
  })

  /** A database whose answers the test gives: the columns information_schema lists, the versions OpenSIPS expects. */
  const database = (columns: [string, string][], failAlter = false) => {
    const queries: string[] = []
    const query = async (text: string) => {
      queries.push(text.trim().split('\n')[0]!)
      if (text.includes('information_schema.columns')) return { rows: columns.map(([table_name, column_name]) => ({ table_name, column_name })) }
      if (text.startsWith('SELECT table_name, table_version')) return { rows: [{ table_name: 'subscriber', table_version: 8 }, { table_name: 'acc', table_version: 7 }, { table_name: 'missed_calls', table_version: 5 }] }
      if (failAlter && text.startsWith('ALTER')) throw new Error('must be owner of table acc')
      return { rows: [] }
    }
    let released = 0
    return { queries, pool: { query, connect: async () => ({ query, release: () => void released++ }) }, released: () => released }
  }

  it('alters the acc tables only for a column they lack, waiting 2 s at most for the lock, in one transaction', async () => {
    const all: [string, string][] = [['acc', 'caller'], ['acc', 'callee'], ['missed_calls', 'caller'], ['missed_calls', 'callee']]
    const complete = database(all)
    await new SubscriberProvisioner({ pool: complete.pool, realm: 'r' }).ensureSchema()
    expect(complete.queries.filter(q => /ALTER|BEGIN|lock_timeout/.test(q))).toEqual([])
    const lacking = database(all.slice(0, 3))
    await new SubscriberProvisioner({ pool: lacking.pool, realm: 'r' }).ensureSchema()
    expect(lacking.queries.slice(2, 6)).toEqual(['BEGIN', "SET LOCAL lock_timeout = '2s'", "ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS callee VARCHAR(64) DEFAULT '' NOT NULL;", 'COMMIT'])
    expect(lacking.released()).toBe(1)
  })

  it('still provisions the secrets when a missing column cannot be added (a table of another owner), and says so', async () => {
    const db = database([], true)
    const warnings: string[] = []
    const p = new SubscriberProvisioner({ pool: db.pool, realm: 'r', logger: { warn: m => warnings.push(m) } })
    await p.ensureSchema()
    expect(db.queries).toContain('ROLLBACK')
    expect(db.released()).toBe(1)
    expect(warnings).toEqual([expect.stringMatching(/could not add acc\.caller, acc\.callee, missed_calls\.caller, missed_calls\.callee \(must be owner of table acc\)/)])
  })

  it('needs a realm and a database', () => {
    expect(() => new SubscriberProvisioner({ pool: { query: async () => undefined }, realm: '' })).toThrow(/realm/)
    expect(() => new SubscriberProvisioner({ realm: 'r' })).toThrow(/database/)
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the schema OpenSIPS expects, and the row it reads.
if (process.env.TEST_DATABASE_URL) {
  describe('SubscriberProvisioner on PostgreSQL', () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
    afterAll(() => pool.end())

    it('creates the subscriber and version tables and keeps one row per extension', async () => {
      await pool.query('DROP TABLE IF EXISTS subscriber; DROP TABLE IF EXISTS version;')
      const p = new SubscriberProvisioner({ pool, realm: 'sip.example.test' })
      await p.ensureSchema()
      await p.ensureSchema() // idempotent
      await p.setSipSecret('101', 'first')
      await p.setSipSecret('101', 'second')
      await p.setSipSecret('102', 'other')
      const { rows } = await pool.query('SELECT username, domain, password, ha1 FROM subscriber ORDER BY username')
      expect(rows).toEqual([
        { username: '101', domain: '', password: '', ha1: digestHashes('101', 'sip.example.test', 'second').ha1 },
        { username: '102', domain: '', password: '', ha1: digestHashes('102', 'sip.example.test', 'other').ha1 }
      ])
      const version = await pool.query("SELECT table_version FROM version WHERE table_name = 'subscriber'")
      expect(version.rows[0]).toEqual({ table_version: SUBSCRIBER_TABLE_VERSION })
      await p.removeSipSecret('101')
      expect((await pool.query('SELECT username FROM subscriber')).rows).toEqual([{ username: '102' }])
    })

    it('adds caller and callee to an acc table OpenSIPS created without them', async () => {
      await pool.query('DROP TABLE IF EXISTS acc; CREATE TABLE acc (id SERIAL PRIMARY KEY NOT NULL, callid VARCHAR(64) DEFAULT \'\' NOT NULL, time TIMESTAMP WITHOUT TIME ZONE NOT NULL)')
      await new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).ensureSchema()
      const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'acc' AND column_name IN ('caller', 'callee') ORDER BY column_name")
      expect(rows.map(r => r.column_name)).toEqual(['callee', 'caller'])
      // Recreated whole by the next ensureSchema.
      await pool.query('DROP TABLE acc')
    })
  })

  // The call rules OpenSIPS reads (ADR 0013): here, not in call-rules.spec.ts, so that no other file creates the
  // schema at the same time (two concurrent CREATE TABLE IF NOT EXISTS can collide in PostgreSQL).
  describe('CallRules on PostgreSQL', () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
    afterAll(() => pool.end())
    /** The test of route[load_rules] (opensips.cfg.tpl): is the "do not disturb" of `extension` in force now? */
    const active = async (extension: string) =>
      (await pool.query("SELECT CASE WHEN dnd AND (dnd_until IS NULL OR dnd_until > now()) THEN 1 ELSE 0 END AS active FROM call_rules WHERE extension = $1", [extension])).rows[0]?.active ?? null

    it('keeps one row per extension while it holds a rule, none after', async () => {
      await pool.query('DROP TABLE IF EXISTS call_rules')
      const provisioner = new SubscriberProvisioner({ pool, realm: 'sip.example.test' })
      await provisioner.ensureSchema()
      const rules = provisioner.callRules()
      await rules.setForwarding('101', { always: '103' }, 'alice')
      await rules.setForwarding('101', { busy: '104', noAnswer: { target: '105', delaySec: 8 } }, 'alice')
      expect(await rules.getForwarding('101')).toEqual({ busy: '104', noAnswer: { target: '105', delaySec: 8 } })
      await rules.setDnd('101', { message: 'En réunion' }, 'alice')
      await rules.setForwarding('101', {}, 'alice')
      // The "do not disturb" still holds the row; lifting it removes it.
      expect((await pool.query('SELECT extension, dnd, dnd_message FROM call_rules')).rows).toEqual([{ extension: '101', dnd: true, dnd_message: 'En réunion' }])
      await rules.setDnd('101', null, 'alice')
      expect((await pool.query('SELECT extension FROM call_rules')).rows).toEqual([])
    })

    it('holds a "do not disturb" until its date on the database clock, and lifts those no one holds', async () => {
      const rules = new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).callRules()
      await rules.setDnd('101', { until: new Date(Date.now() + 3_600_000).toISOString() }, 'alice')
      await rules.setDnd('102', { until: new Date(Date.now() - 1_000).toISOString() }, 'bob')
      await rules.setDnd('103', {}, 'carol')
      await rules.setForwarding('104', { always: '101' }, 'dave')
      expect([await active('101'), await active('102'), await active('103'), await active('104')]).toEqual([1, 0, 1, 0])
      // 102's is past its end: lifted even if kept.
      await rules.clearDndExcept(['102', '103'])
      expect((await pool.query('SELECT extension, dnd FROM call_rules ORDER BY extension')).rows).toEqual([
        { extension: '103', dnd: true },
        { extension: '104', dnd: false }
      ])
      await rules.clearDndExcept([])
      await rules.setForwarding('104', {}, 'dave')
      expect((await pool.query('SELECT extension FROM call_rules')).rows).toEqual([])
    })

    it('makes the rules follow the person: a new holder inherits nothing, a forward to an extension that changed holder goes', async () => {
      const holders: Record<string, string> = { '101': 'alice', '102': 'bob', '103': 'carol' }
      const rules = new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).callRules({ tenantId: 'A', holderOf: async e => holders[e] })
      const other = new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).callRules({ tenantId: 'B' })
      await rules.setForwarding('101', { always: '103', busy: '102' }, 'alice')
      await rules.setDnd('101', { message: 'En congé' }, 'alice')
      await rules.setDnd('102', { message: 'En réunion' }, 'bob')
      await rules.setForwarding('103', { noAnswer: { target: '102', delaySec: 10 } }, 'carol')
      await other.setDnd('201', { message: 'Autre organisation' }, 'zoe')
      // 102 goes to dave, 103 to nobody: 102's row goes with Bob's "do not disturb", Alice's busy forward to 102
      // and her immediate one to 103 go; 103's own row goes.
      await rules.reconcile([{ extension: '101', userId: 'alice' }, { extension: '102', userId: 'dave' }])
      expect((await pool.query('SELECT extension, tenant_id, holder, forward_always, forward_busy, forward_noanswer, dnd, dnd_message FROM call_rules ORDER BY extension')).rows).toEqual([
        { extension: '101', tenant_id: 'A', holder: 'alice', forward_always: null, forward_busy: null, forward_noanswer: null, dnd: true, dnd_message: 'En congé' },
        { extension: '201', tenant_id: 'B', holder: 'zoe', forward_always: null, forward_busy: null, forward_noanswer: null, dnd: true, dnd_message: 'Autre organisation' }
      ])
      // Another tenant's start lifts only its own.
      await other.clearDndExcept([])
      expect((await pool.query('SELECT extension FROM call_rules ORDER BY extension')).rows).toEqual([{ extension: '101' }])
      // A new holder writing a rule before any reconcile does not take over the previous one's.
      await rules.setForwarding('101', { busy: '102' }, 'erin')
      expect((await pool.query('SELECT holder, dnd, dnd_message, forward_busy FROM call_rules')).rows).toEqual([{ holder: 'erin', dnd: false, dnd_message: '', forward_busy: '102' }])
      await rules.setDnd('101', {}, 'frank')
      expect((await pool.query('SELECT holder, dnd, forward_busy FROM call_rules')).rows).toEqual([{ holder: 'frank', dnd: true, forward_busy: null }])
      await rules.reconcile([])
      expect((await pool.query('SELECT extension FROM call_rules')).rows).toEqual([])
    })
  })
}
