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
 * takes it any more; the Gateway deletes the rows past it at each grant. OpenSIPS does not delete the row it takes
 * (review 8b, n°3): it writes the call that took it, `used_by` (the From tag, which LiveKit SIP makes the id of its
 * call) and `used_call` (its Call-ID), and keeps it 10 minutes; the Gateway reads them back (`taken`) to tell its own
 * call from another that would have replayed the grant.
 * Step 8b (ADR 0019), for the calls of a room that take the place of a call in progress (a conference): `replaces`,
 * the dialog of that call as `number` sees it (`callid;to-tag=…;from-tag=…`), which OpenSIPS writes in a Replaces
 * header of its own (any LiveKit SIP sends is refused); `join_token`, the token OpenSIPS writes in Twake-Join, for the
 * call of the person who made the conference (`number` is their own extension). Either one: the call goes straight
 * to the phones of `number`, without their forwards nor their "do not disturb". `room`: the room of the conference,
 * which OpenSIPS names to the phone it calls (Twake-Conference, review 8b, n°2), with or without the other two.
 */
export const DIAL_OUT_GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS dial_out_grants (
    token VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    extension VARCHAR(64) NOT NULL,
    number VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
ALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS replaces VARCHAR(320);
ALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS join_token VARCHAR(64);
ALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS room VARCHAR(64);
ALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS used_by VARCHAR(64);
ALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS used_call VARCHAR(200);
`

/** The header LiveKit SIP carries the grant in (CreateSIPParticipant's `headers`), and OpenSIPS reads. */
export const GRANT_HEADER = 'X-Twake-Grant'
/** How long a grant waits for its INVITE by default, in seconds: LiveKit SIP sends it at once, its retry with credentials just after. */
export const GRANT_TTL_SEC = 30

const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/
const NUMBER = /^\+?[0-9*#]{2,20}$/
/**
 * A dialog as Replaces names it (RFC 3891): a Call-ID and two tags, of characters a header carries as they are (no
 * space, comma, semicolon, quote or line break: nothing more than that header could be written with it).
 */
export const REPLACES = /^[A-Za-z0-9._~!%*+@:-]{1,200};to-tag=[A-Za-z0-9._~!%*+-]{1,50};from-tag=[A-Za-z0-9._~!%*+-]{1,50}$/
/** The token of the call of the person who made a conference (Twake-Join): 32 hexadecimal characters, drawn by their window. */
export const JOIN_TOKEN = /^[0-9a-f]{32}$/
/** The header that carries it to the person's windows. */
export const JOIN_HEADER = 'Twake-Join'
/** The room of a conference (CALL_ROOM of the Gateway): `twake-call-` and 16 hexadecimal characters. */
export const CONFERENCE_ROOM = /^twake-call-[0-9a-f]{16}$/
/** What OpenSIPS writes of the call that took a grant: a SIP tag and a Call-ID, of the characters route[meet_source] lets in. */
const TAG = /^[A-Za-z0-9._~!%*+-]{1,64}$/
const CALL_ID = /^[A-Za-z0-9._~!%*+@:-]{1,200}$/

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
   * A grant for one call of a room: `extension` calls `number`, within `ttlSec` seconds; `replaces` or `join` (step
   * 8b, see the schema), one of them at most, a join for the person's own extension only. Returns the token to hand
   * LiveKit SIP. The tenant's grants past their time go first.
   */
  async grant(extension: string, number: string, ttlSec = GRANT_TTL_SEC, conference: { replaces?: string; join?: string; room?: string } = {}): Promise<string> {
    if (!SIP_USER.test(extension)) throw Object.assign(new Error('Extension is not a valid SIP user'), { statusCode: 400 })
    if (!NUMBER.test(number)) throw Object.assign(new Error('Invalid phone number'), { statusCode: 400 })
    if (!(Number.isInteger(ttlSec) && ttlSec >= 1 && ttlSec <= 300)) throw new Error('A grant lives 1 to 300 seconds')
    const { replaces, join, room } = conference
    if (replaces !== undefined && join !== undefined) throw new Error('A grant replaces a call or joins its person, not both')
    if (replaces !== undefined && !REPLACES.test(replaces)) throw Object.assign(new Error('Invalid call to replace'), { statusCode: 400 })
    if (join !== undefined && !(JOIN_TOKEN.test(join) && number === extension)) throw Object.assign(new Error('Invalid join'), { statusCode: 400 })
    if (room !== undefined && !CONFERENCE_ROOM.test(room)) throw Object.assign(new Error('Invalid conference room'), { statusCode: 400 })
    const token = this.opts.token?.() ?? randomBytes(16).toString('hex')
    await this.opts.ready?.()
    await this.opts.pool.query('DELETE FROM dial_out_grants WHERE tenant_id = $1 AND expires_at < now()', [this.tenantId])
    if (replaces === undefined && join === undefined && room === undefined)
      await this.opts.pool.query('INSERT INTO dial_out_grants (token, tenant_id, extension, number, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))', [token, this.tenantId, extension, number, ttlSec])
    else
      await this.opts.pool.query('INSERT INTO dial_out_grants (token, tenant_id, extension, number, expires_at, replaces, join_token, room) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, $7, $8)', [
        token,
        this.tenantId,
        extension,
        number,
        ttlSec,
        replaces ?? null,
        join ?? null,
        room ?? null
      ])
    return token
  }

  /**
   * The call that took the grant `token`, as OpenSIPS wrote it (review 8b, n°3): its From tag and Call-ID; undefined
   * while none took it (or it is gone), or for anything else than what route[meet_source] lets in.
   */
  async taken(token: string): Promise<{ tag: string; callId: string } | undefined> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query('SELECT used_by, used_call FROM dial_out_grants WHERE tenant_id = $1 AND token = $2', [this.tenantId, token])) as { rows?: { used_by: string | null; used_call: string | null }[] } | undefined
    const row = res?.rows?.[0]
    if (!row?.used_by || !row.used_call || !TAG.test(row.used_by) || !CALL_ID.test(row.used_call)) return undefined
    return { tag: row.used_by, callId: row.used_call }
  }

  /** Withdraws a grant nobody took (the room's call failed before reaching OpenSIPS). */
  async revoke(token: string) {
    await this.opts.ready?.()
    await this.opts.pool.query('DELETE FROM dial_out_grants WHERE tenant_id = $1 AND token = $2', [this.tenantId, token])
  }
}
