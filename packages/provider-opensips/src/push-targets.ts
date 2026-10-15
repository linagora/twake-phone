import type { Queryable } from './subscriber.js'

// Everything about the `push_targets` table lives here (step 5, ADR 0015): the Gateway writes the extensions whose
// holder has a browser subscribed to notifications; opensips.cfg.tpl reads it when a call finds no window of the
// extension it reaches, and then holds the call while the Gateway wakes that browser.

/**
 * One row per extension that can be woken. `holder` is the person it was written for and `tenant_id` whose
 * extension it is: OpenSIPS reads neither (one tenant per database), the Gateway drops a row as soon as its holder no
 * longer holds the extension, and only ever touches its own tenant's rows.
 */
export const PUSH_TARGETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_targets (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    holder TEXT DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/** A SIP user part, as `subscriber` holds it: what OpenSIPS may put in its queries, and nothing else. */
const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/

export interface PushTargetsOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider (the table may not exist yet on a fresh database). */
  ready?: () => Promise<void>
  /** The tenant whose extensions these are. */
  tenantId?: string
}

/** Reads and writes the tenant's rows of `push_targets`. */
export class PushTargets {
  private readonly tenantId: string

  constructor(private readonly opts: PushTargetsOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async query<T>(text: string, values: unknown[]): Promise<T[]> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as { rows?: T[] } | undefined
    return res?.rows ?? []
  }

  /** The extensions of the tenant that can be woken, with their holder, by extension. */
  async list(): Promise<{ extension: string; userId: string }[]> {
    const rows = await this.query<{ extension: string; holder: string }>('SELECT extension, holder FROM push_targets WHERE tenant_id = $1 ORDER BY extension', [this.tenantId])
    return rows.map(r => ({ extension: r.extension, userId: r.holder }))
  }

  /**
   * Exactly these extensions of the tenant can be woken, each for its holder: the others go. An extension that is
   * not a SIP user name is left out (it could not be called anyway). A row another tenant wrote stays theirs.
   */
  async set(targets: { extension: string; userId: string }[]) {
    const wanted = new Map<string, string>()
    for (const t of targets) if (SIP_USER.test(t.extension) && t.userId) wanted.set(t.extension, t.userId)
    const extensions = [...wanted.keys()]
    const holders = [...wanted.values()]
    await this.query('DELETE FROM push_targets p WHERE p.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS w(extension, holder) WHERE w.extension = p.extension AND w.holder = p.holder)', [this.tenantId, extensions, holders])
    if (!extensions.length) return
    await this.query(
      `INSERT INTO push_targets (extension, tenant_id, holder) SELECT extension, $1, holder FROM unnest($2::text[], $3::text[]) AS w(extension, holder)
       ON CONFLICT (extension) DO UPDATE SET holder = EXCLUDED.holder, updated_at = now() WHERE push_targets.tenant_id = EXCLUDED.tenant_id`,
      [this.tenantId, extensions, holders]
    )
  }

  /** Given who holds each extension of the tenant now, removes the rows whose holder no longer holds it. */
  async reconcile(holders: { extension: string; userId: string }[]) {
    await this.query('DELETE FROM push_targets p WHERE p.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS m(extension, holder) WHERE m.extension = p.extension AND m.holder = p.holder)', [
      this.tenantId,
      holders.map(h => h.extension),
      holders.map(h => h.userId)
    ])
  }
}
