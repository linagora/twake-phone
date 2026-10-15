import type { Queryable } from './subscriber.js'

// Everything about the `push_targets` table lives here (step 5, ADR 0015): the Gateway writes the extensions whose
// holder has a browser subscribed to notifications; opensips.cfg.tpl reads it when a call finds no window of the
// extension it reaches, and then holds the call while the Gateway wakes that browser.

/**
 * One row per extension that can be woken. `holder` is the person it was written for and `tenant_id` whose
 * extension it is: OpenSIPS reads neither (one tenant per database), the Gateway drops a row as soon as its holder no
 * longer holds the extension, and only ever touches its own tenant's rows. `alive_until`: until when a Gateway hears
 * whom to wake, the life of its subscription to OpenSIPS's events, extended each time it is renewed and the Gateway
 * heard OpenSIPS since (keepAlive), over when the Gateway stops (release). OpenSIPS holds a call only for a row still
 * alive: a Gateway that stopped, or no longer hears OpenSIPS, holds nobody's calls for nothing.
 */
export const PUSH_TARGETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_targets (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    holder TEXT DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    alive_until TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
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
  /**
   * When the rows stop being alive, as the database wrote it (its clock, the one OpenSIPS reads it against); null:
   * not alive. The rows this Gateway wrote last carry exactly this value (release).
   */
  private until: string | null = null

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
   * not a SIP user name is left out (it could not be called anyway). A row another tenant wrote stays theirs; a row
   * that is already as wanted is not written again.
   */
  async set(targets: { extension: string; userId: string }[]) {
    const wanted = new Map<string, string>()
    for (const t of targets) if (SIP_USER.test(t.extension) && t.userId) wanted.set(t.extension, t.userId)
    const extensions = [...wanted.keys()]
    const holders = [...wanted.values()]
    await this.query('DELETE FROM push_targets p WHERE p.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS w(extension, holder) WHERE w.extension = p.extension AND w.holder = p.holder)', [this.tenantId, extensions, holders])
    if (!extensions.length) return
    await this.query(
      `INSERT INTO push_targets (extension, tenant_id, holder, alive_until) SELECT extension, $1, holder, coalesce($4::timestamptz, now()) FROM unnest($2::text[], $3::text[]) AS w(extension, holder)
       ON CONFLICT (extension) DO UPDATE SET holder = EXCLUDED.holder, updated_at = now(), alive_until = EXCLUDED.alive_until
       WHERE push_targets.tenant_id = EXCLUDED.tenant_id AND push_targets.holder IS DISTINCT FROM EXCLUDED.holder`,
      [this.tenantId, extensions, holders, this.until]
    )
  }

  /** One person's row only: `extension` can be woken for them (`on`), or no longer. The other rows are not touched. */
  async setOne(target: { extension: string; userId: string }, on: boolean) {
    if (!SIP_USER.test(target.extension) || !target.userId) return
    if (!on) {
      await this.query('DELETE FROM push_targets WHERE tenant_id = $1 AND extension = $2 AND holder = $3', [this.tenantId, target.extension, target.userId])
      return
    }
    await this.query(
      `INSERT INTO push_targets (extension, tenant_id, holder, alive_until) VALUES ($2, $1, $3, coalesce($4::timestamptz, now()))
       ON CONFLICT (extension) DO UPDATE SET holder = EXCLUDED.holder, updated_at = now(), alive_until = EXCLUDED.alive_until
       WHERE push_targets.tenant_id = EXCLUDED.tenant_id AND push_targets.holder IS DISTINCT FROM EXCLUDED.holder`,
      [this.tenantId, target.extension, target.userId, this.until]
    )
  }

  /**
   * The Gateway hears whom to wake `sec` seconds more (its subscription to the events was renewed, and OpenSIPS heard
   * since): the rows live that long. Never shorter than another Gateway of the tenant made them (one starting while
   * this one stops).
   */
  async keepAlive(sec: number) {
    const [row] = await this.query<{ until: string }>(
      `WITH t AS (SELECT now() + make_interval(secs => $2) AS until),
       u AS (UPDATE push_targets p SET alive_until = t.until FROM t WHERE p.tenant_id = $1 AND p.alive_until < t.until)
       SELECT until::text AS until FROM t`,
      [this.tenantId, sec]
    )
    this.until = row?.until ?? null
  }

  /**
   * The Gateway no longer hears whom to wake (it stops): no call waits for the rows it kept alive any more. Only those
   * whose life is still the one it gave them: a row another Gateway of the tenant kept alive since stays so.
   */
  async release() {
    const until = this.until
    this.until = null
    if (!until) return
    await this.query('UPDATE push_targets SET alive_until = now() WHERE tenant_id = $1 AND alive_until = $2::timestamptz AND alive_until > now()', [this.tenantId, until])
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
