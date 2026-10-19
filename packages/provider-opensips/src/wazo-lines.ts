import type { Queryable } from './subscriber.js'

// Everything about the `wazo_lines` table lives here (step 11c-1, ADR 0027): the Gateway writes the extensions that
// have a line at Wazo once Wazo has it; opensips.cfg.tpl reads it at each REGISTER (route REGISTER, cached 60 s) and
// registers such an extension at Wazo's Asterisk through mid_registrar. A line follows the extension, not the person:
// nothing here is fenced, a write that comes late leaves a row the next round puts right.

export const WAZO_LINES_SCHEMA = `
CREATE TABLE IF NOT EXISTS wazo_lines (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/** The extensions OpenSIPS registers at Wazo: digits (its query reads nothing else). */
const EXTENSION = /^[0-9]{1,40}$/

export interface WazoLinesOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider (the table may not exist yet on a fresh database). */
  ready?: () => Promise<void>
  /** The tenant whose extensions these are (one per database for OpenSIPS: it does not read it). */
  tenantId?: string
}

type Rows<T> = { rows?: T[] } | undefined

/** Reads and writes the tenant's rows of `wazo_lines`. */
export class WazoLines {
  private readonly tenantId: string

  constructor(private readonly opts: WazoLinesOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async query<T>(text: string, values: unknown[]): Promise<T[]> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as Rows<T>
    return res?.rows ?? []
  }

  /** The extensions of the tenant that have a line, sorted. */
  async list(): Promise<string[]> {
    return (await this.query<{ extension: string }>('SELECT extension FROM wazo_lines WHERE tenant_id = $1 ORDER BY extension', [this.tenantId])).map(r => r.extension)
  }

  /**
   * Exactly these extensions for the tenant: the others go. One OpenSIPS would not read is left out (`skipped`). A row of
   * another tenant stays theirs. One statement, so OpenSIPS never reads half of it.
   */
  async set(extensions: string[]): Promise<{ skipped: string[] }> {
    const wanted = [...new Set(extensions.filter(e => EXTENSION.test(e)))]
    const skipped = [...new Set(extensions.filter(e => !EXTENSION.test(e)))]
    await this.query(
      `WITH gone AS (DELETE FROM wazo_lines WHERE tenant_id = $1 AND NOT (extension = ANY($2::text[])))
       INSERT INTO wazo_lines (extension, tenant_id) SELECT e, $1 FROM unnest($2::text[]) AS e
       ON CONFLICT (extension) DO NOTHING`,
      [this.tenantId, wanted]
    )
    return { skipped }
  }
}
