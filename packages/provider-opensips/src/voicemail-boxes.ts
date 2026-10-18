import type { VoicemailBox, VoicemailBoxesWrite } from '@twake/telephony-provider-sdk'
import type { Queryable } from './subscriber.js'

// Everything about the `voicemail_boxes` table lives here (step 11a, ADR 0022): the Gateway writes the mailbox of each
// extension as the voicemail server named it (Wazo's `number@context`); opensips.cfg.tpl reads it with the rules of
// the extension dialled and sends the call nothing else takes there (route[voicemail]).
//
// Several Gateways write it (fourth review 11a, n°2): any of them withdraws an extension given to someone else, the one
// that holds the lease of the mailboxes writes them all. The database itself keeps a round older than a withdrawal, or
// than another Gateway's lease, from undoing it: each withdrawal leaves its number (`voicemail_withdrawals`), and a
// write says the last one it had seen before it read the holders and the fencing token of its lease
// (`voicemail_writers`). In one transaction, under the lock of the tenant's row there, it is refused when a Gateway
// with a later lease wrote, and leaves out every extension withdrawn since it read the holders.

/**
 * One row per extension with a mailbox. `tenant_id` is whose extension it is: OpenSIPS does not read it (one tenant per
 * database), the Gateway only ever touches its own tenant's rows. `voicemail_writers` and `voicemail_withdrawals` are
 * the Gateway's only (OpenSIPS never reads them).
 */
export const VOICEMAIL_BOXES_SCHEMA = `
CREATE TABLE IF NOT EXISTS voicemail_boxes (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    mailbox VARCHAR(128) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS voicemail_writers (
    tenant_id TEXT PRIMARY KEY NOT NULL,
    fence BIGINT DEFAULT 0 NOT NULL,
    withdrawals BIGINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS voicemail_withdrawals (
    tenant_id TEXT NOT NULL,
    extension VARCHAR(64) NOT NULL,
    seq BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, extension)
);
`

/** The extensions OpenSIPS sends to a mailbox: digits. */
const EXTENSION = /^[0-9]{1,40}$/
/** A mailbox address as OpenSIPS keeps it (its query reads nothing else): the number, `@`, the context. */
export const MAILBOX = /^[0-9]{1,40}@[A-Za-z0-9_-]{1,79}$/

/** A write refused: a Gateway that holds a later lease of the mailboxes wrote them (fourth review 11a, n°2). */
export class VoicemailFenced extends Error {
  readonly code = 'VOICEMAIL_FENCED'
  constructor(
    readonly fence: number,
    readonly written: number
  ) {
    super(`the mailboxes were written under a later lease (${written}) than this Gateway's (${fence}): not written`)
  }
}

export interface VoicemailBoxesOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider (the table may not exist yet on a fresh database). */
  ready?: () => Promise<void>
  /** The tenant whose extensions these are. */
  tenantId?: string
}

type Rows<T> = { rows?: T[] } | undefined

/** Reads and writes the tenant's rows of `voicemail_boxes`. */
export class VoicemailBoxes {
  private readonly tenantId: string

  constructor(private readonly opts: VoicemailBoxesOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async query<T>(text: string, values: unknown[]): Promise<T[]> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as Rows<T>
    return res?.rows ?? []
  }

  /** `run` in one transaction, on a connection of its own, the tenant's row of `voicemail_writers` locked first. */
  private async locked<T>(run: (q: <R>(text: string, values: unknown[]) => Promise<R[]>, row: { fence: number; withdrawals: number }) => Promise<T>): Promise<T> {
    await this.opts.ready?.()
    if (!this.opts.pool.connect) throw new Error('voicemail_boxes: a pool with connections of its own is needed (a transaction)')
    const client = await this.opts.pool.connect()
    const q = async <R>(text: string, values: unknown[]) => ((await client.query(text, values)) as Rows<R>)?.rows ?? []
    try {
      await client.query('BEGIN')
      await q('INSERT INTO voicemail_writers (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [this.tenantId])
      const [row] = await q<{ fence: string; withdrawals: string }>('SELECT fence, withdrawals FROM voicemail_writers WHERE tenant_id = $1 FOR UPDATE', [this.tenantId])
      const out = await run(q, { fence: Number(row?.fence ?? 0), withdrawals: Number(row?.withdrawals ?? 0) })
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  /** The mailboxes of the tenant, by extension. */
  async list(): Promise<VoicemailBox[]> {
    return this.query<VoicemailBox>('SELECT extension, mailbox FROM voicemail_boxes WHERE tenant_id = $1 ORDER BY extension', [this.tenantId])
  }

  /** The number of the last withdrawal of the tenant (0: none yet): read before the holders, given back to `set`. */
  async mark(): Promise<number> {
    const [row] = await this.query<{ withdrawals: string }>('SELECT withdrawals FROM voicemail_writers WHERE tenant_id = $1', [this.tenantId])
    return Number(row?.withdrawals ?? 0)
  }

  /**
   * Exactly these mailboxes for the tenant: the others go. An extension or a mailbox OpenSIPS would not read is left out
   * (`skipped`). A row of another tenant stays theirs; one as wanted already is not written again. With `write.since`
   * (mark() before the holders were read), an extension withdrawn after it is left out too (`withdrawn`): the round
   * that read its holder before is older than the withdrawal. With `write.fence` (the lease's), refused (VoicemailFenced)
   * when a later lease wrote; written, its fence is kept. One transaction: OpenSIPS never reads half of it.
   */
  async set(boxes: VoicemailBox[], write: VoicemailBoxesWrite = {}): Promise<{ skipped: VoicemailBox[]; withdrawn: string[] }> {
    const wanted = new Map<string, string>()
    const skipped: VoicemailBox[] = []
    for (const b of boxes) {
      if (EXTENSION.test(b.extension) && MAILBOX.test(b.mailbox)) wanted.set(b.extension, b.mailbox)
      else skipped.push(b)
    }
    return this.locked(async (q, row) => {
      if (write.fence !== undefined) {
        if (row.fence > write.fence) throw new VoicemailFenced(write.fence, row.fence)
        if (row.fence !== write.fence) await q('UPDATE voicemail_writers SET fence = $2 WHERE tenant_id = $1', [this.tenantId, write.fence])
      }
      const withdrawn: string[] = []
      if (write.since !== undefined) {
        for (const r of await q<{ extension: string }>('SELECT extension FROM voicemail_withdrawals WHERE tenant_id = $1 AND seq > $2 ORDER BY extension', [this.tenantId, write.since]))
          if (wanted.delete(r.extension)) withdrawn.push(r.extension)
        // Those it saw are of no round to come (each reads a mark at least as recent).
        await q('DELETE FROM voicemail_withdrawals WHERE tenant_id = $1 AND seq <= $2', [this.tenantId, write.since])
      }
      const extensions = [...wanted.keys()]
      const mailboxes = [...wanted.values()]
      await q('DELETE FROM voicemail_boxes v WHERE v.tenant_id = $1 AND NOT (v.extension = ANY($2::text[]))', [this.tenantId, extensions])
      if (extensions.length)
        await q(
          `INSERT INTO voicemail_boxes (extension, tenant_id, mailbox) SELECT extension, $1, mailbox FROM unnest($2::text[], $3::text[]) AS w(extension, mailbox)
           ON CONFLICT (extension) DO UPDATE SET mailbox = EXCLUDED.mailbox, updated_at = now()
           WHERE voicemail_boxes.tenant_id = EXCLUDED.tenant_id AND voicemail_boxes.mailbox IS DISTINCT FROM EXCLUDED.mailbox`,
          [this.tenantId, extensions, mailboxes]
        )
      return { skipped, withdrawn }
    })
  }

  /**
   * These extensions of the tenant lose their mailbox, the others keep theirs (second review 11a, n°3), and each keeps
   * the number of this withdrawal for the rounds that read their holder before (`set`'s `since`). Any Gateway withdraws:
   * no fence.
   */
  async withdraw(extensions: string[]): Promise<void> {
    const list = [...new Set(extensions.filter(e => EXTENSION.test(e)))]
    if (!list.length) return
    await this.locked(async (q, row) => {
      const seq = row.withdrawals + 1
      await q('UPDATE voicemail_writers SET withdrawals = $2 WHERE tenant_id = $1', [this.tenantId, seq])
      await q('INSERT INTO voicemail_withdrawals (tenant_id, extension, seq) SELECT $1, e, $3 FROM unnest($2::text[]) AS e ON CONFLICT (tenant_id, extension) DO UPDATE SET seq = EXCLUDED.seq', [this.tenantId, list, seq])
      await q('DELETE FROM voicemail_boxes v WHERE v.tenant_id = $1 AND v.extension = ANY($2::text[])', [this.tenantId, list])
    })
  }
}
