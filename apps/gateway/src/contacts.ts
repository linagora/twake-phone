import type { Contact, TenantId } from '@twake/telephony-types'

export const MAX_SEARCH = 50
export const MAX_QUERY = 100
/** Contact ids are the directory's; this bounds what the store keeps and what a URL may carry. */
export const MAX_CONTACT_ID = 256
/** Favourites per user: enough for a phone, and a bound on the directory lookups a page load costs. */
export const MAX_FAVORITES = 100

export interface SearchResult {
  items: Contact[]
  /** More contacts matched than were returned: the user should refine the search. */
  truncated: boolean
}

/**
 * The organisation's directory of people one can call (cahier §7.4.6.2, annuaire). The Gateway asks it for
 * contacts and never caches them: what the directory says is the truth, favourites are only ids.
 */
export interface ContactDirectory {
  /** Whether this directory holds the people of that tenant. Absent: every tenant. */
  servesTenant?(tenantId: TenantId): boolean
  /** Contacts matching the words of `query` (name, number, department...), at most `limit`; an empty query, anyone. */
  search(tenantId: TenantId, query: string, limit: number): Promise<SearchResult>
  /** The contacts with these ids, in the order given; unknown ids are left out. */
  getMany(tenantId: TenantId, ids: string[]): Promise<Contact[]>
  /** Every person of the tenant, for the account synchronisation. Absent: this directory cannot be synchronised. */
  listAll?(tenantId: TenantId): Promise<Contact[]>
  /** What an administrator may see of the source: never a credential. */
  describe?(): DirectorySource
  /** The Matrix user id the directory gives the person, if it gives one (step 11b: the bot's notices in Twake Chat). */
  matrixIdOf?(tenantId: TenantId, userId: string): Promise<string | undefined>
}

/** The directory as shown on the administration screen. */
export interface DirectorySource {
  type: string
  /** Server address without credentials (an LDAP URL, for instance). */
  url?: string
  tenantId?: string
  baseDn?: string
  userFilter?: string
  /** Which attribute carries what, for an LDAP directory. */
  attributes?: Record<string, string>
}

/** A directory held in memory: tests, and a dev Gateway without LDAP. */
export class MemoryContactDirectory implements ContactDirectory {
  constructor(private readonly contacts: Contact[] = []) {}

  async search(_tenantId: TenantId, query: string, limit: number): Promise<SearchResult> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const text = (c: Contact) => [c.displayName, c.email, c.department, c.title, ...c.numbers.map(n => n.number)].filter(Boolean).join(' ').toLowerCase()
    const all = this.contacts.filter(c => words.every(w => text(c).includes(w)))
    return { items: all.slice(0, limit), truncated: all.length > limit }
  }

  async getMany(_tenantId: TenantId, ids: string[]) {
    return ids.flatMap(id => this.contacts.filter(c => c.id === id))
  }

  async listAll() {
    return [...this.contacts]
  }

  describe(): DirectorySource {
    return { type: 'memory' }
  }
}

/** A sliding window per key: `limit` events per `windowMs`. Protects the directory from a keyboard held down. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** True when these `count` events (one by default) are allowed; then all of them count, otherwise none. */
  allow(key: string, count = 1): boolean {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter(h => h > t - this.windowMs)
    if (recent.length + count > this.limit) {
      this.hits.set(key, recent)
      return false
    }
    for (let i = 0; i < count; i++) recent.push(t)
    this.hits.set(key, recent)
    return true
  }
}
