import type { TenantId, User } from '@twake/telephony-types'
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
