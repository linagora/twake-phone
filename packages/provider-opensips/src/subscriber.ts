import { createHash } from 'node:crypto'
import pg from 'pg'
import type { SecretProvisioner } from '@twake/telephony-provider-sdk'

// Everything about OpenSIPS's `subscriber` table (module auth_db) lives here: the Gateway only sees a SecretProvisioner.

/** Table version OpenSIPS 3.6 expects in its `version` table for `subscriber` (scripts/postgres/auth_db-create.sql). */
export const SUBSCRIBER_TABLE_VERSION = 8
/** Same for the `acc` and `missed_calls` tables of the acc module (scripts/postgres/acc-create.sql). */
export const ACC_TABLE_VERSION = 7
export const MISSED_CALLS_TABLE_VERSION = 5

const hex = (algorithm: string, input: string) => createHash(algorithm).update(input).digest('hex')

/**
 * The digest hashes auth_db compares against (RFC 7616): HA1 = H(username:realm:password) for MD5 and SHA-256,
 * SHA-512/256 truncated. The secret itself is never written: a database dump gives no SIP password away.
 */
export const digestHashes = (username: string, realm: string, secret: string) => {
  const a1 = `${username}:${realm}:${secret}`
  return { ha1: hex('md5', a1), ha1Sha256: hex('sha256', a1), ha1Sha512t256: hex('sha512-256', a1) }
}

/**
 * The schema OpenSIPS 3.6 ships for PostgreSQL (`subscriber` of auth_db; `acc` and `missed_calls` of acc, the
 * CDRs, with the caller and callee as dialled as extra columns), plus the rows of the `version` table it checks
 * at startup. Tables created beforehand by OpenSIPS's own scripts lack the extra columns (EXTRA_COLUMNS):
 * `ensureSchema()` adds those that are missing, or every CDR insert would fail.
 */
export const SUBSCRIBER_SCHEMA = `
CREATE TABLE IF NOT EXISTS version (
    table_name VARCHAR(32) NOT NULL,
    table_version INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT version_t_name_idx UNIQUE (table_name)
);
CREATE TABLE IF NOT EXISTS subscriber (
    id SERIAL PRIMARY KEY NOT NULL,
    username VARCHAR(64) DEFAULT '' NOT NULL,
    domain VARCHAR(64) DEFAULT '' NOT NULL,
    password VARCHAR(25) DEFAULT '' NOT NULL,
    ha1 VARCHAR(64) DEFAULT '' NOT NULL,
    ha1_sha256 VARCHAR(64) DEFAULT '' NOT NULL,
    ha1_sha512t256 VARCHAR(64) DEFAULT '' NOT NULL,
    CONSTRAINT subscriber_account_idx UNIQUE (username, domain)
);
CREATE INDEX IF NOT EXISTS subscriber_username_idx ON subscriber (username);
INSERT INTO version (table_name, table_version) VALUES ('subscriber', ${SUBSCRIBER_TABLE_VERSION})
  ON CONFLICT (table_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS acc (
    id SERIAL PRIMARY KEY NOT NULL,
    method VARCHAR(16) DEFAULT '' NOT NULL,
    from_tag VARCHAR(64) DEFAULT '' NOT NULL,
    to_tag VARCHAR(64) DEFAULT '' NOT NULL,
    callid VARCHAR(64) DEFAULT '' NOT NULL,
    sip_code VARCHAR(3) DEFAULT '' NOT NULL,
    sip_reason VARCHAR(32) DEFAULT '' NOT NULL,
    time TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    duration INTEGER DEFAULT 0 NOT NULL,
    ms_duration INTEGER DEFAULT 0 NOT NULL,
    setuptime INTEGER DEFAULT 0 NOT NULL,
    created TIMESTAMP WITHOUT TIME ZONE DEFAULT NULL,
    caller VARCHAR(64) DEFAULT '' NOT NULL,
    callee VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS acc_callid_idx ON acc (callid);
CREATE TABLE IF NOT EXISTS missed_calls (
    id SERIAL PRIMARY KEY NOT NULL,
    method VARCHAR(16) DEFAULT '' NOT NULL,
    from_tag VARCHAR(64) DEFAULT '' NOT NULL,
    to_tag VARCHAR(64) DEFAULT '' NOT NULL,
    callid VARCHAR(64) DEFAULT '' NOT NULL,
    sip_code VARCHAR(3) DEFAULT '' NOT NULL,
    sip_reason VARCHAR(32) DEFAULT '' NOT NULL,
    time TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    setuptime INTEGER DEFAULT 0 NOT NULL,
    created TIMESTAMP WITHOUT TIME ZONE DEFAULT NULL,
    caller VARCHAR(64) DEFAULT '' NOT NULL,
    callee VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS missed_calls_callid_idx ON missed_calls (callid);
INSERT INTO version (table_name, table_version) VALUES ('acc', ${ACC_TABLE_VERSION}), ('missed_calls', ${MISSED_CALLS_TABLE_VERSION})
  ON CONFLICT (table_name) DO NOTHING;
`

/** The columns of `acc` and `missed_calls` that OpenSIPS's own scripts do not create (the acc extras of opensips.cfg.tpl). */
export const EXTRA_COLUMNS = [
  ['acc', 'caller'],
  ['acc', 'callee'],
  ['missed_calls', 'caller'],
  ['missed_calls', 'callee']
] as const

const addColumn = ([table, column]: (typeof EXTRA_COLUMNS)[number]) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} VARCHAR(64) DEFAULT '' NOT NULL;`

/**
 * docker/opensips/subscriber.sql: the schema then the extra columns, plainly (it runs once, when the Compose stack
 * creates the database, as its owner).
 */
export const SUBSCRIBER_SQL = `${SUBSCRIBER_SCHEMA.trimEnd()}\n${EXTRA_COLUMNS.map(addColumn).join('\n')}\n`

/** How long adding a missing column may wait for its lock (an acc table busy with CDR inserts) before giving up. */
const ALTER_LOCK_TIMEOUT = '2s'

/** What the provisioner needs to run queries: a pg Pool, or anything with the same `query` (and `connect`). */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>
  /** A connection of its own, for a transaction (a pg Pool has it). */
  connect?(): Promise<{ query(text: string, values?: unknown[]): Promise<unknown>; release(): void }>
}

export interface SubscriberProvisionerOptions {
  /** The database OpenSIPS's auth_db reads (`db_url` of the module). May be the Gateway's own database. */
  databaseUrl?: string
  /** An existing pool, for tests or to share the Gateway's. Wins over `databaseUrl`. */
  pool?: Queryable
  /** Digest realm, the SIP domain the softphone registers with: the hashes depend on it. */
  realm: string
  /** `domain` column value; empty unless auth_db runs with use_domain=1. */
  domain?: string
  logger?: { warn(message: string): void }
}

/**
 * Keeps one `subscriber` row per extension, with the digest hashes of the secret the Gateway generated.
 * `ensureSchema()` creates the tables when OpenSIPS and the Gateway share a fresh database (dev, CI).
 */
export class SubscriberProvisioner implements SecretProvisioner {
  private readonly pool: Queryable
  private readonly owned: pg.Pool | undefined
  private readonly realm: string
  private readonly domain: string
  private readonly log: { warn(message: string): void }

  constructor(opts: SubscriberProvisionerOptions) {
    if (!opts.realm) throw new Error('SubscriberProvisioner needs the SIP realm')
    if (!opts.pool && !opts.databaseUrl) throw new Error('SubscriberProvisioner needs a database')
    this.owned = opts.pool ? undefined : new pg.Pool({ connectionString: opts.databaseUrl, max: 2 })
    this.pool = opts.pool ?? this.owned!
    this.realm = opts.realm
    this.domain = opts.domain ?? ''
    this.log = opts.logger ?? console
  }

  /**
   * Creates the tables when missing; refuses a table of another version (OpenSIPS owns those rows). Adds the extra
   * columns only where they lack (ALTER TABLE needs to own the table and takes an exclusive lock: not at each
   * start); one that cannot be added is logged, the SIP secrets are still provisioned.
   */
  async ensureSchema() {
    await this.pool.query(SUBSCRIBER_SCHEMA)
    const { rows: present } = (await this.pool.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('acc', 'missed_calls') AND column_name IN ('caller', 'callee')"
    )) as { rows: { table_name: string; column_name: string }[] }
    const missing = EXTRA_COLUMNS.filter(([table, column]) => !present.some(r => r.table_name === table && r.column_name === column))
    if (missing.length) {
      await this.addColumns(missing).catch(err =>
        this.log.warn(`OpenSIPS acc tables: could not add ${missing.map(([t, c]) => `${t}.${c}`).join(', ')} (${err instanceof Error ? err.message : String(err)}); CDRs will not be written until they exist`)
      )
    }
    const { rows } = (await this.pool.query("SELECT table_name, table_version FROM version WHERE table_name IN ('subscriber', 'acc', 'missed_calls')")) as { rows: { table_name: string; table_version: number }[] }
    for (const [table, expected] of [['subscriber', SUBSCRIBER_TABLE_VERSION], ['acc', ACC_TABLE_VERSION], ['missed_calls', MISSED_CALLS_TABLE_VERSION]] as const) {
      const version = rows.find(r => r.table_name === table)?.table_version
      if (version !== expected) throw new Error(`${table} table version ${version} in the database, ${expected} expected`)
    }
  }

  /** In one transaction that waits at most ALTER_LOCK_TIMEOUT for each lock. */
  private async addColumns(columns: readonly (typeof EXTRA_COLUMNS)[number][]) {
    const client = this.pool.connect ? await this.pool.connect() : undefined
    const q = client ?? this.pool
    try {
      await q.query('BEGIN')
      await q.query(`SET LOCAL lock_timeout = '${ALTER_LOCK_TIMEOUT}'`)
      for (const c of columns) await q.query(addColumn(c))
      await q.query('COMMIT')
    } catch (err) {
      await q.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client?.release()
    }
  }

  async setSipSecret(extension: string, secret: string) {
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(extension)) throw Object.assign(new Error('Extension is not a valid SIP user'), { statusCode: 400 })
    const { ha1, ha1Sha256, ha1Sha512t256 } = digestHashes(extension, this.realm, secret)
    await this.pool.query(
      `INSERT INTO subscriber (username, domain, password, ha1, ha1_sha256, ha1_sha512t256) VALUES ($1, $2, '', $3, $4, $5)
       ON CONFLICT (username, domain) DO UPDATE SET ha1 = EXCLUDED.ha1, ha1_sha256 = EXCLUDED.ha1_sha256, ha1_sha512t256 = EXCLUDED.ha1_sha512t256`,
      [extension, this.domain, ha1, ha1Sha256, ha1Sha512t256]
    )
  }

  /** Forgets an extension: its registrations die at their next refresh. */
  async removeSipSecret(extension: string) {
    await this.pool.query('DELETE FROM subscriber WHERE username = $1 AND domain = $2', [extension, this.domain])
  }

  async close() {
    await this.owned?.end()
  }
}
