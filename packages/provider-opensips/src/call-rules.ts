import type { ForwardingRules } from '@twake/telephony-types'
import type { Queryable } from './subscriber.js'

// Everything about the `call_rules` table lives here (step 4b, ADR 0013): the Gateway writes what a person chose
// (forwards, "do not disturb"), opensips.cfg.tpl reads it at each INVITE (sqlops) and routes the call accordingly.

/**
 * One row per extension. A forward target is an extension; `noanswer_delay` is in seconds of ringing; the "do not
 * disturb" holds while `dnd` is set and `dnd_until` (absent: until told otherwise) is in the future, on the
 * database's clock: OpenSIPS compares it with `now()` itself, so it ends at its date even if the Gateway is down.
 */
export const CALL_RULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS call_rules (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    forward_always VARCHAR(64),
    forward_busy VARCHAR(64),
    forward_noanswer VARCHAR(64),
    noanswer_delay INTEGER DEFAULT 20 NOT NULL,
    dnd BOOLEAN DEFAULT false NOT NULL,
    dnd_until TIMESTAMP WITH TIME ZONE,
    dnd_message VARCHAR(140) DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/** A SIP user part, as `subscriber` holds it: what OpenSIPS may put in its query, and nothing else. */
const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/
/** Seconds of ringing before a call goes to the no-answer target: the bounds the Gateway enforces too. */
export const NOANSWER_DELAY = { min: 2, max: 120 } as const
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
}

/** Reads and writes the `call_rules` rows of the extensions; the Gateway checked the targets are its own. */
export class CallRules {
  constructor(private readonly opts: CallRulesOptions) {}

  private async query<T>(text: string, values: unknown[]): Promise<T[]> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as { rows?: T[] } | undefined
    return res?.rows ?? []
  }

  async getForwarding(extension: string): Promise<ForwardingRules> {
    const [row] = await this.query<Row>('SELECT forward_always, forward_busy, forward_noanswer, noanswer_delay FROM call_rules WHERE extension = $1', [checkExtension(extension, 'extension')])
    if (!row) return {}
    return {
      ...(row.forward_always ? { always: row.forward_always } : {}),
      ...(row.forward_busy ? { busy: row.forward_busy } : {}),
      ...(row.forward_noanswer ? { noAnswer: { target: row.forward_noanswer, delaySec: row.noanswer_delay } } : {})
    }
  }

  async setForwarding(extension: string, rules: ForwardingRules) {
    checkExtension(extension, 'extension')
    for (const target of [rules.always, rules.busy, rules.noAnswer?.target]) if (target !== undefined) checkExtension(target, 'forward target')
    const delay = rules.noAnswer?.delaySec ?? 20
    if (!Number.isInteger(delay) || delay < NOANSWER_DELAY.min || delay > NOANSWER_DELAY.max) throw invalid(`no-answer delay must be ${NOANSWER_DELAY.min} to ${NOANSWER_DELAY.max} seconds`)
    await this.query(
      `INSERT INTO call_rules (extension, forward_always, forward_busy, forward_noanswer, noanswer_delay) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (extension) DO UPDATE SET forward_always = EXCLUDED.forward_always, forward_busy = EXCLUDED.forward_busy,
         forward_noanswer = EXCLUDED.forward_noanswer, noanswer_delay = EXCLUDED.noanswer_delay, updated_at = now()`,
      [extension, rules.always ?? null, rules.busy ?? null, rules.noAnswer?.target ?? null, delay]
    )
    await this.prune(extension)
  }

  /** Sets (or, with null, lifts) the "do not disturb" of an extension. */
  async setDnd(extension: string, dnd: DndRule | null) {
    checkExtension(extension, 'extension')
    const message = dnd?.message ?? ''
    // The message ends up in a SIP header: one line of text, bounded.
    if (/[\u0000-\u001f\u007f]/.test(message) || message.length > DND_MESSAGE_MAX) throw invalid(`the message must be one line of at most ${DND_MESSAGE_MAX} characters`)
    if (dnd?.until !== undefined && Number.isNaN(Date.parse(dnd.until))) throw invalid('invalid end date')
    await this.query(
      `INSERT INTO call_rules (extension, dnd, dnd_until, dnd_message) VALUES ($1, $2, $3, $4)
       ON CONFLICT (extension) DO UPDATE SET dnd = EXCLUDED.dnd, dnd_until = EXCLUDED.dnd_until, dnd_message = EXCLUDED.dnd_message, updated_at = now()`,
      [extension, !!dnd, dnd?.until ?? null, message]
    )
    await this.prune(extension)
  }

  /** Lifts every "do not disturb" but those of `keep`: what the Gateway no longer holds for anyone (a restart, an extension given to someone else). */
  async clearDndExcept(keep: string[]) {
    await this.query("UPDATE call_rules SET dnd = false, dnd_until = NULL, dnd_message = '', updated_at = now() WHERE dnd AND NOT (extension = ANY($1))", [keep])
    await this.query('DELETE FROM call_rules WHERE NOT dnd AND forward_always IS NULL AND forward_busy IS NULL AND forward_noanswer IS NULL', [])
  }

  /** A row that says nothing any more is removed: OpenSIPS finds no rule, as for an extension that never had one. */
  private async prune(extension: string) {
    await this.query('DELETE FROM call_rules WHERE extension = $1 AND NOT dnd AND forward_always IS NULL AND forward_busy IS NULL AND forward_noanswer IS NULL', [extension])
  }
}
