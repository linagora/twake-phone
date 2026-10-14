import type { Contact, TenantId } from '@twake/telephony-types'

export const MAX_SEARCH = 50
export const MAX_QUERY = 100
export const MAX_CONTACT_ID = 256

/**
 * The organisation's directory of people one can call (cahier §7.4.6.2, annuaire). The Gateway asks it for
 * contacts and never caches them: what the directory says is the truth, favourites are only ids.
 */
export interface ContactDirectory {
  /** Contacts matching the words of `query` (name, number, department...), at most `limit`. */
  search(tenantId: TenantId, query: string, limit: number): Promise<Contact[]>
  /** The contacts with these ids, in the order given; unknown ids are left out. */
  getMany(tenantId: TenantId, ids: string[]): Promise<Contact[]>
}

/** A directory held in memory: tests, and a dev Gateway without LDAP. */
export class MemoryContactDirectory implements ContactDirectory {
  constructor(private readonly contacts: Contact[] = []) {}

  async search(_tenantId: TenantId, query: string, limit: number) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const text = (c: Contact) => [c.displayName, c.email, c.department, c.title, ...c.numbers.map(n => n.number)].filter(Boolean).join(' ').toLowerCase()
    return this.contacts.filter(c => words.every(w => text(c).includes(w))).slice(0, limit)
  }

  async getMany(_tenantId: TenantId, ids: string[]) {
    return ids.flatMap(id => this.contacts.filter(c => c.id === id))
  }
}
