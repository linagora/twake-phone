import { Client, escapeFilter, type Entry } from 'ldapts'
import type { Contact, ContactNumber, TenantId } from '@twake/telephony-types'
import type { ContactDirectory } from './contacts.js'

/** Which LDAP attributes carry what. Defaults fit inetOrgPerson; a beneficiary's schema is mapped from the environment. */
export interface LdapAttributes {
  id: string
  name: string
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
  bindDn?: string
  bindPassword?: string
  baseDn: string
  /** Filter every entry must match, on top of the search words. */
  userFilter: string
  attributes: LdapAttributes
  connectTimeoutMs?: number
  rejectUnauthorized?: boolean
}

export const DEFAULT_ATTRIBUTES: LdapAttributes = { id: 'uid', name: 'cn', email: 'mail', phone: 'telephoneNumber', mobile: 'mobile', extension: '', department: 'ou', title: 'title' }

const first = (v: Entry[string] | undefined): string | undefined => {
  if (v === undefined) return undefined
  const one = Array.isArray(v) ? v[0] : v
  if (one === undefined) return undefined
  const s = Buffer.isBuffer(one) ? one.toString('utf8') : String(one)
  return s.trim() || undefined
}

const all = (v: Entry[string] | undefined): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(x => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)).trim()).filter(Boolean))

/** One LDAP entry as a Contact. Exported for tests. */
export const contactOf = (entry: Entry, a: LdapAttributes): Contact | null => {
  const id = first(entry[a.id])
  const displayName = first(entry[a.name])
  if (!id || !displayName) return null
  const numbers: ContactNumber[] = []
  if (a.extension) for (const number of all(entry[a.extension])) numbers.push({ type: 'extension', number })
  for (const number of all(entry[a.phone])) numbers.push({ type: 'work', number })
  for (const number of all(entry[a.mobile])) numbers.push({ type: 'mobile', number })
  const email = first(entry[a.email])
  const department = first(entry[a.department])
  const title = first(entry[a.title])
  return { id, displayName, numbers, ...(email ? { email } : {}), ...(department ? { department } : {}), ...(title ? { title } : {}) }
}

/** The filter for a free-text query: every word must appear in one of the searchable attributes. Exported for tests. */
export const searchFilter = (query: string, a: LdapAttributes, userFilter: string): string => {
  const fields = [a.name, 'sn', 'givenName', a.email, a.phone, a.mobile, a.extension, a.department].filter(Boolean)
  const words = query.split(/\s+/).filter(Boolean)
  const perWord = words.map(w => `(|${[...new Set(fields)].map(f => escapeFilter`(${f}=*${w}*)`).join('')})`)
  return `(&${userFilter}${perWord.join('')})`
}

/** Looks people up in an LDAP directory. One deployment-wide directory for now: the tenant is accepted and ignored. */
export class LdapDirectory implements ContactDirectory {
  constructor(private readonly config: LdapDirectoryConfig) {}

  private attributes() {
    const a = this.config.attributes
    return [...new Set([a.id, a.name, 'sn', 'givenName', a.email, a.phone, a.mobile, a.extension, a.department, a.title].filter(Boolean))]
  }

  /** One bound connection per request: simple, and immune to a connection the server dropped meanwhile. */
  private async query(filter: string, sizeLimit: number): Promise<Contact[]> {
    const client = new Client({
      url: this.config.url,
      connectTimeout: this.config.connectTimeoutMs ?? 5000,
      ...(this.config.rejectUnauthorized === false ? { tlsOptions: { rejectUnauthorized: false } } : {})
    })
    try {
      if (this.config.bindDn) await client.bind(this.config.bindDn, this.config.bindPassword ?? '')
      const { searchEntries } = await client.search(this.config.baseDn, { scope: 'sub', filter, attributes: this.attributes(), sizeLimit, timeLimit: 10 })
      return searchEntries.map(e => contactOf(e, this.config.attributes)).filter((c): c is Contact => c !== null)
    } finally {
      await client.unbind().catch(() => undefined)
    }
  }

  async search(_tenantId: TenantId, query: string, limit: number) {
    if (!query.trim()) return []
    const found = await this.query(searchFilter(query, this.config.attributes, this.config.userFilter), limit)
    return found.sort((x, y) => x.displayName.localeCompare(y.displayName)).slice(0, limit)
  }

  async getMany(_tenantId: TenantId, ids: string[]) {
    if (ids.length === 0) return []
    const a = this.config.attributes
    const byId = `(|${ids.map(id => escapeFilter`(${a.id}=${id})`).join('')})`
    const found = await this.query(`(&${this.config.userFilter}${byId})`, ids.length)
    const index = new Map(found.map(c => [c.id, c]))
    return ids.flatMap(id => index.get(id) ?? [])
  }
}

/**
 * LDAP_URL enables the directory. LDAP_BIND_DN and LDAP_BIND_PASSWORD (an account allowed to read people), LDAP_BASE_DN,
 * LDAP_USER_FILTER (default: inetOrgPerson entries), LDAP_ATTR_* to map the schema (ID, NAME, EMAIL, PHONE, MOBILE,
 * EXTENSION, DEPARTMENT, TITLE), LDAP_TLS_REJECT_UNAUTHORIZED=0 for a self-signed certificate on a dev box only.
 */
export const ldapDirectoryFromEnv = (env: NodeJS.ProcessEnv): LdapDirectory | undefined => {
  if (!env.LDAP_URL) return undefined
  if (!env.LDAP_BASE_DN) throw new Error('LDAP_BASE_DN is required with LDAP_URL')
  const attr = (name: keyof LdapAttributes) => env[`LDAP_ATTR_${name.toUpperCase()}`] ?? DEFAULT_ATTRIBUTES[name]
  return new LdapDirectory({
    url: env.LDAP_URL,
    ...(env.LDAP_BIND_DN ? { bindDn: env.LDAP_BIND_DN, bindPassword: env.LDAP_BIND_PASSWORD ?? '' } : {}),
    baseDn: env.LDAP_BASE_DN,
    userFilter: env.LDAP_USER_FILTER ?? '(objectClass=inetOrgPerson)',
    attributes: { id: attr('id'), name: attr('name'), email: attr('email'), phone: attr('phone'), mobile: attr('mobile'), extension: attr('extension'), department: attr('department'), title: attr('title') },
    ...(env.LDAP_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : {})
  })
}
