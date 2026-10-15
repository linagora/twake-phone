import { EXTENSION_FORMAT, isReservedNumber, type TenantId, type User } from '@twake/telephony-types'
import type { Store } from './store/types.js'

/** Twake user <-> telephony identity mapping (cahier §34). */
export interface UserDirectory {
  forUser(tenantId: TenantId, userId: string, displayName?: string): Promise<User>
  userIdForExtension(tenantId: TenantId, extension: string): Promise<string | undefined>
}

/** Directory backed by the store: the mapping is per tenant, an unknown user simply has no extension. */
export class StoreDirectory implements UserDirectory {
  constructor(private readonly store: Store) {}

  async forUser(tenantId: TenantId, userId: string, displayName?: string): Promise<User> {
    const m = await this.store.getMappingByUser(tenantId, userId)
    return { id: userId, tenantId, displayName: m?.displayName ?? displayName ?? userId, ...(m ? { extension: m.extension } : {}) }
  }

  async userIdForExtension(tenantId: TenantId, extension: string) {
    return (await this.store.getMappingByExtension(tenantId, extension))?.userId
  }
}

/** Parses "user1:101,user2:102" (dev bootstrap). */
export const parseUserMap = (spec = ''): { userId: string; extension: string }[] =>
  spec
    .split(',')
    .filter(Boolean)
    .flatMap(pair => {
      const [userId, extension] = pair.split(':')
      return userId && extension ? [{ userId, extension }] : []
    })

/**
 * Seeds the mappings of DEV_USER_MAP (USER_EXTENSIONS of the pilot kit) where none exists: what an administrator or the
 * directory wrote since is never undone. An emergency number (or another short number of the French plan) is nobody's
 * extension: dialled, it goes to the operator (ADR 0016); such an entry is left out, and `warn` says so.
 */
export const seedUserMap = async (store: Store, tenantId: TenantId, spec: string | undefined, warn: (message: string) => void) => {
  for (const m of parseUserMap(spec)) {
    if (isReservedNumber(m.extension)) {
      warn(`${m.userId}:${m.extension} left out: ${m.extension} is an emergency number or another short number of the French plan, which goes to the operator when dialled; give another extension`)
      continue
    }
    if (!EXTENSION_FORMAT.test(m.extension)) {
      warn(`${m.userId}:${m.extension} left out: an extension is 2 to 6 digits, the first not 0 (anything else, dialled, is taken for a public number)`)
      continue
    }
    if (!(await store.getMappingByUser(tenantId, m.userId))) await store.upsertMapping({ tenantId, ...m })
  }
}

/**
 * The extensions and ring groups of a tenant that are emergency numbers or other short numbers of the French plan
 * (kept from before step 6a): dialled, they go to the operator, never to whoever has them. Said at each start, to be
 * changed.
 */
export const reservedInUse = async (store: Store, tenantId: TenantId, groups: Iterable<string>): Promise<string[]> => [
  ...(await store.listMappings(tenantId)).filter(m => isReservedNumber(m.extension)).map(m => `extension ${m.extension} (${m.userId})`),
  ...[...groups].filter(isReservedNumber).map(g => `ring group ${g}`)
]
