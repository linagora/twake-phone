import type { ForwardingRules } from '@twake/telephony-types'
import type { Queryable } from './subscriber.js'

// Everything about the `call_rules` table lives here (step 4b, ADR 0013): the Gateway writes what a person chose
// (forwards, "do not disturb"), opensips.cfg.tpl reads it at each INVITE (sqlops) and routes the call accordingly.

/**
 * One row per extension. A forward target is an extension; `noanswer_delay` is in seconds of ringing; the "do not
 * disturb" holds while `dnd` is set and `dnd_until` (absent: until told otherwise) is in the future, on the
 * database's clock: OpenSIPS compares it with `now()` itself, so it ends at its date even if the Gateway is down.
 * The rules are a person's, not an extension's: `holder` is who held the extension when they were written, each
 * `*_holder` who held the target, and `tenant_id` whose extensions these are. OpenSIPS reads none of them: the
 * Gateway drops a row, or a forward, as soon as that holder changes (`CallRules.reconcile`).
 */
export const CALL_RULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS call_rules (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    holder TEXT NOT NULL,
    forward_always VARCHAR(64),
    forward_always_holder TEXT,
    forward_busy VARCHAR(64),
    forward_busy_holder TEXT,
    forward_noanswer VARCHAR(64),
    forward_noanswer_holder TEXT,
    noanswer_delay INTEGER DEFAULT 20 NOT NULL,
    dnd BOOLEAN DEFAULT false NOT NULL,
    dnd_until TIMESTAMP WITH TIME ZONE,
    dnd_message VARCHAR(140) DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/** A SIP user part, as `subscriber` holds it: what OpenSIPS may put in its query, and nothing else. */
const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/
/**
 * Seconds of ringing before a call goes to the no-answer target: the bounds the Gateway enforces too. OpenSIPS's
 * timer is the transaction's, armed at the first ringing: the forward comes about that long after, a second or two
 * later at times, hence at least 5 seconds.
 */
export const NOANSWER_DELAY = { min: 5, max: 120 } as const
/** Longest "do not disturb" message, in characters; it travels in a SIP header to the caller. */
export const DND_MESSAGE_MAX = 140

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 })
const checkExtension = (value: string, what: string) => {
  if (!SIP_USER.test(value)) throw invalid(`${what} is not a valid extension`)
  return value
}

/** What a "do not disturb" written in `call_rules` says: until when (absent: no end), and the message for callers. */
export interface DndRule {
  until?: string
  message?: string
}

/** Who holds an extension now: a user id of the tenant. */
export interface ExtensionHolder {
  extension: string
  userId: string
}

interface Row {
  forward_always: string | null
  forward_busy: string | null
  forward_noanswer: string | null
  noanswer_delay: number
}

export interface CallRulesOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider (the table may not exist yet on a fresh database). */
  ready?: () => Promise<void>
  /** The tenant whose extensions these are: every row it writes carries it, and it clears or reconciles only those. */
  tenantId?: string
  /** Who holds an extension now (the Gateway's mappings); absent or unknown: nobody, and a forward there is dropped at the next reconcile. */
  holderOf?: (extension: string) => Promise<string | undefined>
}

const FORWARDS = ['forward_always', 'forward_busy', 'forward_noanswer'] as const

/** Reads and writes the `call_rules` rows of the extensions; the Gateway checked the targets are its own. */
export class CallRules {
  private readonly tenantId: string

  constructor(private readonly opts: CallRulesOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async query<T>(text: string, values: unknown[]): Promise<T[]> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as { rows?: T[] } | undefined
    return res?.rows ?? []
  }

  private async holderOf(extension: string) {
    return (await this.opts.holderOf?.(extension)) ?? ''
  }

  async getForwarding(extension: string): Promise<ForwardingRules> {
    const [row] = await this.query<Row>('SELECT forward_always, forward_busy, forward_noanswer, noanswer_delay FROM call_rules WHERE extension = $1 AND tenant_id = $2', [checkExtension(extension, 'extension'), this.tenantId])
    if (!row) return {}
    return {
      ...(row.forward_always ? { always: row.forward_always } : {}),
      ...(row.forward_busy ? { busy: row.forward_busy } : {}),
      ...(row.forward_noanswer ? { noAnswer: { target: row.forward_noanswer, delaySec: row.noanswer_delay } } : {})
    }
  }

  /** Replaces the forwards of `extension`, held by `holder`; each target is written with who holds it now. */
  async setForwarding(extension: string, rules: ForwardingRules, holder: string) {
    checkExtension(extension, 'extension')
    const targets = [rules.always, rules.busy, rules.noAnswer?.target]
    for (const target of targets) if (target !== undefined) checkExtension(target, 'forward target')
    const delay = rules.noAnswer?.delaySec ?? 20
    if (!Number.isInteger(delay) || delay < NOANSWER_DELAY.min || delay > NOANSWER_DELAY.max) throw invalid(`no-answer delay must be ${NOANSWER_DELAY.min} to ${NOANSWER_DELAY.max} seconds`)
    const holders = await Promise.all(targets.map(t => (t === undefined ? null : this.holderOf(t))))
    await this.query(
      `INSERT INTO call_rules (extension, tenant_id, holder, forward_always, forward_always_holder, forward_busy, forward_busy_holder, forward_noanswer, forward_noanswer_holder, noanswer_delay)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (extension) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, holder = EXCLUDED.holder,
         forward_always = EXCLUDED.forward_always, forward_always_holder = EXCLUDED.forward_always_holder,
         forward_busy = EXCLUDED.forward_busy, forward_busy_holder = EXCLUDED.forward_busy_holder,
         forward_noanswer = EXCLUDED.forward_noanswer, forward_noanswer_holder = EXCLUDED.forward_noanswer_holder,
         noanswer_delay = EXCLUDED.noanswer_delay, updated_at = now(),
         -- Another holder's "do not disturb" is not inherited with the extension.
         dnd = call_rules.dnd AND call_rules.holder = EXCLUDED.holder,
         dnd_until = CASE WHEN call_rules.holder = EXCLUDED.holder THEN call_rules.dnd_until END,
         dnd_message = CASE WHEN call_rules.holder = EXCLUDED.holder THEN call_rules.dnd_message ELSE '' END`,
      [extension, this.tenantId, holder, rules.always ?? null, holders[0], rules.busy ?? null, holders[1], rules.noAnswer?.target ?? null, holders[2], delay]
    )
    await this.prune(extension)
  }

  /** Sets (or, with null, lifts) the "do not disturb" of an extension, held by `holder`. */
  async setDnd(extension: string, dnd: DndRule | null, holder: string) {
    checkExtension(extension, 'extension')
    const message = dnd?.message ?? ''
    // The message ends up in a SIP header: one line of text, bounded.
    if (/[\u0000-\u001f\u007f]/.test(message) || message.length > DND_MESSAGE_MAX) throw invalid(`the message must be one line of at most ${DND_MESSAGE_MAX} characters`)
    if (dnd?.until !== undefined && Number.isNaN(Date.parse(dnd.until))) throw invalid('invalid end date')
    await this.query(
      `INSERT INTO call_rules (extension, tenant_id, holder, dnd, dnd_until, dnd_message) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (extension) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, holder = EXCLUDED.holder, dnd = EXCLUDED.dnd,
         dnd_until = EXCLUDED.dnd_until, dnd_message = EXCLUDED.dnd_message, updated_at = now(),
         -- Another holder's forwards are not inherited with the extension.
         ${FORWARDS.flatMap(c => [c, `${c}_holder`]).map(c => `${c} = CASE WHEN call_rules.holder = EXCLUDED.holder THEN call_rules.${c} END`).join(', ')}`,
      [extension, this.tenantId, holder, !!dnd, dnd?.until ?? null, message]
    )
    await this.prune(extension)
  }

  /**
   * Lifts every "do not disturb" of the tenant but those of `keep`: what the Gateway no longer holds for anyone (a
   * restart, an extension given to someone else), and those past their end. Those of other tenants are theirs.
   */
  async clearDndExcept(keep: string[]) {
    await this.query(
      "UPDATE call_rules SET dnd = false, dnd_until = NULL, dnd_message = '', updated_at = now() WHERE tenant_id = $1 AND dnd AND (NOT (extension = ANY($2)) OR dnd_until <= now())",
      [this.tenantId, keep]
    )
    await this.query('DELETE FROM call_rules WHERE tenant_id = $1 AND NOT dnd AND forward_always IS NULL AND forward_busy IS NULL AND forward_noanswer IS NULL', [this.tenantId])
  }

  /**
   * The rules follow the person, not the extension: given who holds each extension of the tenant now, removes the
   * rows of an extension that changed holder (or that nobody holds), and the forwards to an extension that did.
   */
  async reconcile(holders: ExtensionHolder[]) {
    const extensions = holders.map(h => h.extension)
    const users = holders.map(h => h.userId)
    const held = (column: string, holderColumn: string) => `EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS m(extension, holder) WHERE m.extension = call_rules.${column} AND m.holder = call_rules.${holderColumn})`
    await this.query(`DELETE FROM call_rules WHERE tenant_id = $1 AND NOT ${held('extension', 'holder')}`, [this.tenantId, extensions, users])
    for (const column of FORWARDS) {
      await this.query(
        `UPDATE call_rules SET ${column} = NULL, ${column}_holder = NULL, updated_at = now() WHERE tenant_id = $1 AND ${column} IS NOT NULL AND NOT ${held(column, `${column}_holder`)}`,
        [this.tenantId, extensions, users]
      )
    }
    await this.query('DELETE FROM call_rules WHERE tenant_id = $1 AND NOT dnd AND forward_always IS NULL AND forward_busy IS NULL AND forward_noanswer IS NULL', [this.tenantId])
  }

  /** A row that says nothing any more is removed: OpenSIPS finds no rule, as for an extension that never had one. */
  private async prune(extension: string) {
    await this.query('DELETE FROM call_rules WHERE extension = $1 AND NOT dnd AND forward_always IS NULL AND forward_busy IS NULL AND forward_noanswer IS NULL', [extension])
  }
}
