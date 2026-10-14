import { createHash } from 'node:crypto'
import pg from 'pg'
import type { SecretProvisioner } from '@twake/telephony-provider-sdk'

// Everything about OpenSIPS's `subscriber` table (module auth_db) lives here: the Gateway only sees a SecretProvisioner.

/** Table version OpenSIPS 3.6 expects in its `version` table for `subscriber` (scripts/postgres/auth_db-create.sql). */
export const SUBSCRIBER_TABLE_VERSION = 8

const hex = (algorithm: string, input: string) => createHash(algorithm).update(input).digest('hex')

/**
 * The digest hashes auth_db compares against (RFC 7616): HA1 = H(username:realm:password) for MD5 and SHA-256,
 * SHA-512/256 truncated. The secret itself is never written: a database dump gives no SIP password away.
 */
export const digestHashes = (username: string, realm: string, secret: string) => {
  const a1 = `${username}:${realm}:${secret}`
  return { ha1: hex('md5', a1), ha1Sha256: hex('sha256', a1), ha1Sha512t256: hex('sha512-256', a1) }
}

/** The schema OpenSIPS 3.6 ships for PostgreSQL, plus the row of the `version` table it checks at startup. */
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
`

/** What the provisioner needs to run queries: a pg Pool, or anything with the same `query`. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>
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

  constructor(opts: SubscriberProvisionerOptions) {
    if (!opts.realm) throw new Error('SubscriberProvisioner needs the SIP realm')
    if (!opts.pool && !opts.databaseUrl) throw new Error('SubscriberProvisioner needs a database')
    this.owned = opts.pool ? undefined : new pg.Pool({ connectionString: opts.databaseUrl, max: 2 })
    this.pool = opts.pool ?? this.owned!
    this.realm = opts.realm
    this.domain = opts.domain ?? ''
  }

  /** Creates the tables when missing; refuses a `subscriber` table of another version (OpenSIPS owns that row). */
  async ensureSchema() {
    await this.pool.query(SUBSCRIBER_SCHEMA)
    const { rows } = (await this.pool.query("SELECT table_version FROM version WHERE table_name = 'subscriber'")) as { rows: { table_version: number }[] }
    const version = rows[0]?.table_version
    if (version !== SUBSCRIBER_TABLE_VERSION) throw new Error(`subscriber table version ${version} in the database, ${SUBSCRIBER_TABLE_VERSION} expected`)
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
