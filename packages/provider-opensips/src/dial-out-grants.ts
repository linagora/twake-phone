import { randomBytes } from 'node:crypto'
import type { Queryable } from './subscriber.js'

// Everything about the `dial_out_grants` table lives here (step 8, ADR 0018): the Gateway writes one row before it
// asks a room to call a number at someone's name; opensips.cfg.tpl (route[meet_source]) takes it, once, when LiveKit
// SIP's INVITE for that call arrives. A call a room places without one is refused: LiveKit SIP's account alone (which
// anyone with an API key of the LiveKit server can read back from its outbound trunk) never makes a call someone's.

/**
 * One row per call a room may place. `token`: what LiveKit SIP carries in the INVITE (X-Twake-Grant), 32 hexadecimal
 * characters drawn by the Gateway; `extension`: whose call it is (the From LiveKit SIP writes); `number`: the number
 * the room calls, as the Gateway gave it to LiveKit (the INVITE's Request-URI); `expires_at`: after which nothing
 * takes it any more. OpenSIPS deletes the row it takes; the Gateway the rows past their time, at each grant.
 */
export const DIAL_OUT_GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS dial_out_grants (
    token VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    extension VARCHAR(64) NOT NULL,
    number VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
`

/** The header LiveKit SIP carries the grant in (CreateSIPParticipant's `headers`), and OpenSIPS reads. */
export const GRANT_HEADER = 'X-Twake-Grant'
/** How long a grant waits for its INVITE by default, in seconds: LiveKit SIP sends it at once, its retry with credentials just after. */
export const GRANT_TTL_SEC = 30

const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/
const NUMBER = /^\+?[0-9*#]{2,20}$/

export interface DialOutGrantsOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider. */
  ready?: () => Promise<void>
  tenantId?: string
  /** Test seam: the token drawn. */
  token?: () => string
}

/** Writes the grants of the calls the rooms of the tenant place. */
export class DialOutGrants {
  private readonly tenantId: string

  constructor(private readonly opts: DialOutGrantsOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  /**
   * A grant for one call of a room: `extension` calls `number`, within `ttlSec` seconds. Returns the token to hand
   * LiveKit SIP. The tenant's grants past their time go first.
   */
  async grant(extension: string, number: string, ttlSec = GRANT_TTL_SEC): Promise<string> {
    if (!SIP_USER.test(extension)) throw Object.assign(new Error('Extension is not a valid SIP user'), { statusCode: 400 })
    if (!NUMBER.test(number)) throw Object.assign(new Error('Invalid phone number'), { statusCode: 400 })
    if (!(Number.isInteger(ttlSec) && ttlSec >= 1 && ttlSec <= 300)) throw new Error('A grant lives 1 to 300 seconds')
    const token = this.opts.token?.() ?? randomBytes(16).toString('hex')
    await this.opts.ready?.()
    await this.opts.pool.query('DELETE FROM dial_out_grants WHERE tenant_id = $1 AND expires_at < now()', [this.tenantId])
    await this.opts.pool.query('INSERT INTO dial_out_grants (token, tenant_id, extension, number, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))', [token, this.tenantId, extension, number, ttlSec])
    return token
  }

  /** Withdraws a grant nobody took (the room's call failed before reaching OpenSIPS). */
  async revoke(token: string) {
    await this.opts.ready?.()
    await this.opts.pool.query('DELETE FROM dial_out_grants WHERE tenant_id = $1 AND token = $2', [this.tenantId, token])
  }
}
