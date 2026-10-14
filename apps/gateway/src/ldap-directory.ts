import { readFileSync } from 'node:fs'
import { Client, FilterParser, escapeFilter, type Entry } from 'ldapts'
import type { Contact, ContactNumber, TenantId } from '@twake/telephony-types'
import type { ContactDirectory, DirectorySource, SearchResult } from './contacts.js'

/** Which LDAP attributes carry what. Defaults fit inetOrgPerson; a beneficiary's schema is mapped from the environment. */
export interface LdapAttributes {
  id: string
  name: string
  /** Surname and given name, searched by prefix; "" when the schema has none. */
  surname: string
  givenName: string
  email: string
  phone: string
  mobile: string
  /** Internal extension, when the directory has one apart from the public number ("" when it does not). */
  extension: string
  department: string
  title: string
}

export interface LdapDirectoryConfig {
  url: string
  /** The one tenant this directory serves: the Gateway answers 501 to the others. */
  tenantId: string
  bindDn?: string
  bindPassword?: string
  baseDn: string
  /** Filter every entry must match, on top of the search words. */
  userFilter: string
  attributes: LdapAttributes
  connectTimeoutMs?: number
  /** Per-operation timeout: a server that accepts the connection and never answers must not hang the request. */
  operationTimeoutMs?: number
  /** PEM of the CA that signed the server certificate (ldaps), when it is not in the system store. */
  ca?: string
  rejectUnauthorized?: boolean
}

export const DEFAULT_ATTRIBUTES: LdapAttributes = { id: 'uid', name: 'cn', surname: 'sn', givenName: 'givenName', email: 'mail', phone: 'telephoneNumber', mobile: 'mobile', extension: '', department: 'ou', title: 'title' }

/** Search words shorter than this are ignored: a one-letter substring search is an unindexed scan of the directory. */
export const MIN_WORD = 2
export const MAX_WORDS = 5
/** Favourites are resolved in batches, so a long list never becomes one huge filter. */
const BATCH = 50
/** A full listing is paged (RFC 2696): a server's size limit (500 on OpenLDAP by default) must not cut it short. */
const PAGE = 500

const str = (x: string | Buffer) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x))

/** Attribute descriptions are case-insensitive (RFC 4512); servers answer with their own spelling. */
const lowered = (entry: Entry): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'dn' || v === undefined) continue
    out[k.toLowerCase()] = (Array.isArray(v) ? v : [v]).map(x => str(x).trim()).filter(Boolean)
  }
  return out
}

/** One LDAP entry as a Contact. Exported for tests. */
export const contactOf = (entry: Entry, a: LdapAttributes): Contact | null => {
  const e = lowered(entry)
  const first = (attr: string) => (attr ? e[attr.toLowerCase()]?.[0] : undefined)
  const all = (attr: string) => (attr ? (e[attr.toLowerCase()] ?? []) : [])
  const id = first(a.id)
  const displayName = first(a.name)
  if (!id || !displayName) return null
  const numbers: ContactNumber[] = []
  for (const number of all(a.extension)) numbers.push({ type: 'extension', number })
  for (const number of all(a.phone)) numbers.push({ type: 'work', number })
  for (const number of all(a.mobile)) numbers.push({ type: 'mobile', number })
  const email = first(a.email)
  const department = first(a.department)
  const title = first(a.title)
  return { id, displayName, numbers, ...(email ? { email } : {}), ...(department ? { department } : {}), ...(title ? { title } : {}) }
}

/** The words of a query the directory will be asked about: at most MAX_WORDS, each at least MIN_WORD characters. */
export const searchWords = (query: string): string[] => query.split(/\s+/).filter(w => w.length >= MIN_WORD).slice(0, MAX_WORDS)

/** The digits of a word typed as a number, "" when it is not one (letters, or fewer than 3 digits). */
export const digitsOf = (word: string): string => {
  const digits = word.replace(/[\s().+-]/g, '')
  return /^\d{3,}$/.test(digits) ? digits : ''
}

/**
 * The filter for a free-text query: every word must appear in one of the searchable attributes. Names, email,
 * department and id are matched by prefix (what an index can serve); a word typed as a number is matched on the end of
 * the stored numbers, so "+33 1 23 45 67 01", "01 23 45 67 01" and "23456701" all find the same person (the server's
 * telephoneNumber matching ignores spaces and dashes). Exported for tests.
 */
export const searchFilter = (query: string, a: LdapAttributes, userFilter: string): string | null => {
  // "+33 1 23 45 67 01" is one number, not six words.
  const words = digitsOf(query) ? [query] : searchWords(query)
  if (words.length === 0) return null
  const textFields = [...new Set([a.name, a.surname, a.givenName, a.email, a.department, a.id].filter(Boolean))]
  const numberFields = [...new Set([a.phone, a.mobile, a.extension].filter(Boolean))]
  const perWord = words.map(w => {
    const digits = digitsOf(w)
    const clauses = textFields.map(f => escapeFilter`(${f}=${w}*)`)
    if (digits) {
      // A national number starts with a 0 that the stored international form does not have: match on the last digits.
      const tail = digits.length > 8 ? digits.slice(-8) : digits.replace(/^0/, '')
      for (const f of numberFields) clauses.push(escapeFilter`(${f}=*${tail})`)
    }
    return `(|${clauses.join('')})`
  })
  return `(&${userFilter}${perWord.join('')})`
}

/** Looks people up in an LDAP directory. One directory serves one tenant; others get 501 from the Gateway. */
export class LdapDirectory implements ContactDirectory {
  /** The user filter in canonical form (parenthesised), so it can be composed with the search clauses. */
  private readonly userFilter: string

  constructor(private readonly config: LdapDirectoryConfig) {
    // A malformed filter would fail every request later, at the user's expense: refuse it now.
    this.userFilter = FilterParser.parseString(config.userFilter).toString()
  }

  servesTenant(tenantId: TenantId) {
    return tenantId === this.config.tenantId
  }

  private attributes() {
    const a = this.config.attributes
    return [...new Set([a.id, a.name, a.surname, a.givenName, a.email, a.phone, a.mobile, a.extension, a.department, a.title].filter(Boolean))]
  }

  /** The source as the administration screen shows it: the bind password never leaves the configuration. */
  describe(): DirectorySource {
    const url = new URL(this.config.url)
    url.username = ''
    url.password = ''
    const a = this.config.attributes
    return { type: 'ldap', url: url.toString().replace(/\/$/, ''), tenantId: this.config.tenantId, baseDn: this.config.baseDn, userFilter: this.userFilter, attributes: { ...a } }
  }

  /** One bound connection per request: simple, and immune to a connection the server dropped meanwhile. */
  private async query(filter: string, sizeLimit: number, paged = false): Promise<Contact[]> {
    const tls = { ...(this.config.ca ? { ca: this.config.ca } : {}), ...(this.config.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}) }
    const client = new Client({
      url: this.config.url,
      connectTimeout: this.config.connectTimeoutMs ?? 5000,
      timeout: this.config.operationTimeoutMs ?? 10_000,
      ...(Object.keys(tls).length ? { tlsOptions: tls } : {})
    })
    try {
      if (this.config.bindDn) await client.bind(this.config.bindDn, this.config.bindPassword ?? '')
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes: this.attributes(),
        sizeLimit,
        // A full listing may take a while on a large directory; a lookup must not.
        timeLimit: paged ? 120 : 10,
        ...(paged ? { paged: { pageSize: PAGE } } : {})
      })
      return searchEntries.map(e => contactOf(e, this.config.attributes)).filter((c): c is Contact => c !== null)
    } finally {
      await client.unbind().catch(() => undefined)
    }
  }

  async search(_tenantId: TenantId, query: string, limit: number): Promise<SearchResult> {
    const filter = searchFilter(query, this.config.attributes, this.userFilter)
    if (!filter) return { items: [], truncated: false }
    // One more than asked: the server's order is not alphabetical, so a truncated answer is said to be, not sorted into shape.
    const found = await this.query(filter, limit + 1)
    const truncated = found.length > limit
    const items = (truncated ? found.slice(0, limit) : found).sort((x, y) => x.displayName.localeCompare(y.displayName))
    return { items, truncated }
  }

  /** Everyone the user filter admits, in pages. Needs the extension attribute: without it there is nothing to synchronise. */
  async listAll(_tenantId: TenantId): Promise<Contact[]> {
    if (!this.config.attributes.extension) throw new Error('LDAP_ATTR_EXTENSION is not set: nothing says which attribute holds the extension to synchronise')
    return this.query(this.userFilter, 0, true)
  }

  async getMany(_tenantId: TenantId, ids: string[]) {
    const a = this.config.attributes
    const index = new Map<string, Contact>()
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      const byId = `(|${batch.map(id => escapeFilter`(${a.id}=${id})`).join('')})`
      for (const c of await this.query(`(&${this.userFilter}${byId})`, 0)) index.set(c.id, c)
    }
    return ids.flatMap(id => index.get(id) ?? [])
  }
}

/**
 * LDAP_URL enables the directory, for the tenant LDAP_TENANT (default: DEFAULT_TENANT, else "default").
 * LDAP_BIND_DN and LDAP_BIND_PASSWORD (an account allowed to read people), LDAP_BASE_DN, LDAP_USER_FILTER
 * (default: inetOrgPerson entries), LDAP_ATTR_* to map the schema (ID, NAME, SURNAME, GIVENNAME, EMAIL, PHONE, MOBILE,
 * EXTENSION, DEPARTMENT, TITLE; "" disables one), LDAP_TLS_CA_FILE for a private CA, LDAP_TLS_REJECT_UNAUTHORIZED=0
 * only on a dev box. `warn` receives what a production deployment should not do.
 */
export const ldapDirectoryFromEnv = (env: NodeJS.ProcessEnv, warn: (message: string) => void = message => console.warn(message)): LdapDirectory | undefined => {
  if (!env.LDAP_URL) return undefined
  if (!env.LDAP_BASE_DN) throw new Error('LDAP_BASE_DN is required with LDAP_URL')
  const attr = (name: keyof LdapAttributes) => env[`LDAP_ATTR_${name.toUpperCase()}`] ?? DEFAULT_ATTRIBUTES[name]
  const url = new URL(env.LDAP_URL)
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'ldap:' && env.LDAP_BIND_DN && !local) warn('LDAP_URL is ldap:// on a remote host: the bind password travels in clear text; use ldaps://')
  if (env.LDAP_TLS_REJECT_UNAUTHORIZED === '0') warn('LDAP_TLS_REJECT_UNAUTHORIZED=0: the LDAP server certificate is not verified; never in production')
  return new LdapDirectory({
    url: env.LDAP_URL,
    tenantId: env.LDAP_TENANT ?? env.DEFAULT_TENANT ?? 'default',
    ...(env.LDAP_BIND_DN ? { bindDn: env.LDAP_BIND_DN, bindPassword: env.LDAP_BIND_PASSWORD ?? '' } : {}),
    baseDn: env.LDAP_BASE_DN,
    userFilter: env.LDAP_USER_FILTER ?? '(objectClass=inetOrgPerson)',
    attributes: {
      id: attr('id'), name: attr('name'), surname: attr('surname'), givenName: attr('givenName'), email: attr('email'),
      phone: attr('phone'), mobile: attr('mobile'), extension: attr('extension'), department: attr('department'), title: attr('title')
    },
    ...(env.LDAP_TLS_CA_FILE ? { ca: readFileSync(env.LDAP_TLS_CA_FILE, 'utf8') } : {}),
    ...(env.LDAP_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : {})
  })
}
