import type { RingGroup } from '@twake/telephony-types'
import type { Queryable } from './subscriber.js'

// Everything about the `call_groups` and `display_names` tables lives here (step 4c, ADR 0014): the Gateway writes
// the simultaneous ring groups an administrator sets and the directory name of each extension; opensips.cfg.tpl
// reads them at each INVITE (sqlops), rings every member of a group at once, and shows each party the other's name.

/**
 * One row per group. `number` is what callers dial: never an extension (the Gateway refuses both ways), and an
 * extension of that name would win anyway (the script checks `subscriber` first). `members` are extensions, in the
 * order the administrator gave. `tenant_id` is whose group it is: OpenSIPS does not read it (one tenant per
 * database), the Gateway only lists, writes and reconciles its own.
 */
export const CALL_GROUPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS call_groups (
    number VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    name VARCHAR(64) DEFAULT '' NOT NULL,
    members VARCHAR(64)[] DEFAULT '{}' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/**
 * The directory name of each extension, as the Gateway last synchronised it: OpenSIPS puts it in the From of the
 * calls an extension places (whatever its phone claims) and in the P-Asserted-Identity of the answer it gives.
 */
export const DISPLAY_NAMES_SCHEMA = `
CREATE TABLE IF NOT EXISTS display_names (
    extension VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    display_name VARCHAR(64) DEFAULT '' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/** A SIP user part, as `subscriber` holds it: what OpenSIPS may put in its queries, and nothing else. */
const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/
/** Most members a group rings: as many browser windows each, all in one transaction. */
export const GROUP_MEMBERS_MAX = 20
/** Longest group or display name, in characters. */
export const NAME_MAX = 64

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 })

/**
 * A name as it may travel in a SIP header (a quoted display name): one line, no double quote or backslash (they
 * would end or escape the quoting), spaces folded, at most NAME_MAX characters. Empty when nothing is left.
 */
export const sipDisplayName = (name: string | undefined): string =>
  [...(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\]/g, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, NAME_MAX)
    .join('')
    .trim()

interface GroupRow {
  number: string
  name: string
  members: string[]
}

export interface CallGroupsOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider (the table may not exist yet on a fresh database). */
  ready?: () => Promise<void>
  /** The tenant whose groups these are. */
  tenantId?: string
}

/** Reads and writes the tenant's rows of `call_groups` and `display_names`. */
export class CallGroups {
  private readonly tenantId: string

  constructor(private readonly opts: CallGroupsOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async query<T>(text: string, values: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as { rows?: T[]; rowCount?: number | null } | undefined
    return { rows: res?.rows ?? [], rowCount: res?.rowCount ?? 0 }
  }

  async list(): Promise<RingGroup[]> {
    const { rows } = await this.query<GroupRow>('SELECT number, name, members FROM call_groups WHERE tenant_id = $1 ORDER BY number', [this.tenantId])
    return rows.map(r => ({ number: r.number, name: r.name, members: [...(r.members ?? [])] }))
  }

  /**
   * Creates or replaces a group of the tenant. Checked again here (the Gateway did): a number and members that can
   * be SIP user parts, a name that can be a display name. Another tenant's group of that number is not overwritten.
   */
  async set(group: RingGroup) {
    if (!SIP_USER.test(group.number)) throw invalid('the group number is not a valid number')
    const name = sipDisplayName(group.name)
    if (!name) throw invalid('the group needs a name')
    const members = [...new Set(group.members)]
    if (members.length === 0 || members.length > GROUP_MEMBERS_MAX) throw invalid(`a group has 1 to ${GROUP_MEMBERS_MAX} members`)
    for (const m of members) if (!SIP_USER.test(m)) throw invalid('a member is not a valid extension')
    const { rowCount } = await this.query(
      `INSERT INTO call_groups (number, tenant_id, name, members) VALUES ($1, $2, $3, $4)
       ON CONFLICT (number) DO UPDATE SET name = EXCLUDED.name, members = EXCLUDED.members, updated_at = now()
       WHERE call_groups.tenant_id = EXCLUDED.tenant_id`,
      [group.number, this.tenantId, name, members]
    )
    if (rowCount === 0) throw Object.assign(new Error('this number belongs to another organisation'), { statusCode: 409, code: 'GROUP_NUMBER_TAKEN' })
  }

  async delete(number: string): Promise<boolean> {
    if (!SIP_USER.test(number)) return false
    const { rowCount } = await this.query('DELETE FROM call_groups WHERE number = $1 AND tenant_id = $2', [number, this.tenantId])
    return rowCount > 0
  }

  /**
   * Given who holds each extension of the tenant now (and their name in the directory): the names OpenSIPS shows
   * are replaced by those, and an extension nobody holds leaves every group (a group of nobody stays, and rings
   * nobody, until an administrator changes it). An extension that changed holder stays: a group rings positions
   * (the reception desk, the support line), whoever holds them.
   */
  async reconcile(holders: { extension: string; displayName?: string }[]) {
    const extensions = holders.map(h => h.extension)
    const names = holders.map(h => sipDisplayName(h.displayName))
    await this.query(
      `INSERT INTO display_names (extension, tenant_id, display_name)
       SELECT n.extension, $1, n.display_name FROM unnest($2::text[], $3::text[]) AS n(extension, display_name) WHERE n.display_name <> ''
       ON CONFLICT (extension) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, display_name = EXCLUDED.display_name, updated_at = now()
       WHERE display_names.tenant_id IS DISTINCT FROM EXCLUDED.tenant_id OR display_names.display_name IS DISTINCT FROM EXCLUDED.display_name`,
      [this.tenantId, extensions, names]
    )
    // A row of no tenant, or of an extension the tenant no longer has (or whose holder has no name), is nobody's name.
    await this.query(
      `DELETE FROM display_names WHERE tenant_id = '' OR (tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS n(extension, display_name) WHERE n.extension = display_names.extension AND n.display_name <> ''))`,
      [this.tenantId, extensions, names]
    )
    await this.query(
      `UPDATE call_groups SET members = ARRAY(SELECT m FROM unnest(members) WITH ORDINALITY AS u(m, i) WHERE m = ANY($2::text[]) ORDER BY i), updated_at = now()
       WHERE tenant_id = $1 AND NOT (members <@ $2::varchar[])`,
      [this.tenantId, extensions]
    )
  }
}
