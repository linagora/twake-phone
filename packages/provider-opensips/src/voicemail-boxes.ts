import type { VoicemailBox } from '@twake/telephony-provider-sdk'
import type { Queryable } from './subscriber.js'

// Everything about the `voicemail_boxes` table lives here (step 11a, ADR 0021): the Gateway writes the mailbox of each
// extension as the voicemail server named it (Wazo's `number@context`); opensips.cfg.tpl reads it with the rules of
// the extension dialled and sends the call nothing else takes there (route[voicemail]).

/**
 * One row per extension with a mailbox. `tenant_id` is whose extension it is: OpenSIPS does not read it (one tenant per
 * database), the Gateway only ever touches its own tenant's rows.
 */
export const VOICEMAIL_BOXES_SCHEMA = `
CREATE TABLE IF NOT EXISTS voicemail_boxes (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    mailbox VARCHAR(128) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/** The extensions OpenSIPS sends to a mailbox: digits (Wazo's mailbox numbers). */
const EXTENSION = /^[0-9]{1,40}$/
/** A mailbox address as OpenSIPS keeps it (its query reads nothing else): the number, `@`, the context. */
export const MAILBOX = /^[0-9]{1,40}@[A-Za-z0-9_-]{1,79}$/

export interface VoicemailBoxesOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider (the table may not exist yet on a fresh database). */
  ready?: () => Promise<void>
  /** The tenant whose extensions these are. */
  tenantId?: string
}

/** Reads and writes the tenant's rows of `voicemail_boxes`. */
export class VoicemailBoxes {
  private readonly tenantId: string

  constructor(private readonly opts: VoicemailBoxesOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async query<T>(text: string, values: unknown[]): Promise<T[]> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as { rows?: T[] } | undefined
    return res?.rows ?? []
  }

  /** The mailboxes of the tenant, by extension. */
  async list(): Promise<VoicemailBox[]> {
    return this.query<VoicemailBox>('SELECT extension, mailbox FROM voicemail_boxes WHERE tenant_id = $1 ORDER BY extension', [this.tenantId])
  }

  /**
   * Exactly these mailboxes for the tenant: the others go. An extension or a mailbox OpenSIPS would not read is left out
   * (said in the returned list of what was not written). A row of another tenant stays theirs; one as wanted already is
   * not written again.
   */
  async set(boxes: VoicemailBox[]): Promise<{ skipped: VoicemailBox[] }> {
    const wanted = new Map<string, string>()
    const skipped: VoicemailBox[] = []
    for (const b of boxes) {
      if (EXTENSION.test(b.extension) && MAILBOX.test(b.mailbox)) wanted.set(b.extension, b.mailbox)
      else skipped.push(b)
    }
    const extensions = [...wanted.keys()]
    const mailboxes = [...wanted.values()]
    await this.query('DELETE FROM voicemail_boxes v WHERE v.tenant_id = $1 AND NOT (v.extension = ANY($2::text[]))', [this.tenantId, extensions])
    if (extensions.length)
      await this.query(
        `INSERT INTO voicemail_boxes (extension, tenant_id, mailbox) SELECT extension, $1, mailbox FROM unnest($2::text[], $3::text[]) AS w(extension, mailbox)
         ON CONFLICT (extension) DO UPDATE SET mailbox = EXCLUDED.mailbox, updated_at = now()
         WHERE voicemail_boxes.tenant_id = EXCLUDED.tenant_id AND voicemail_boxes.mailbox IS DISTINCT FROM EXCLUDED.mailbox`,
        [this.tenantId, extensions, mailboxes]
      )
    return { skipped }
  }
}
