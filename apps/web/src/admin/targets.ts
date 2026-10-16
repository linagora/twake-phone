import { useEffect, useState } from 'react'
import type { AdminUser, RingGroup, TelephonyClient } from '@twake/telephony-client'

/** Where a direct number or a fallback may ring: the extensions people hold and the ring groups (for a list to pick from). */
export interface Targets {
  users: AdminUser[]
  groups: RingGroup[]
}

/** The people who hold an extension and the ring groups, read once; a platform without groups has none (501). */
export const useTargets = (client: TelephonyClient): Targets => {
  const [targets, setTargets] = useState<Targets>({ users: [], groups: [] })
  useEffect(() => {
    let live = true
    void Promise.all([client.listAdminUsers().then(r => r.items, () => []), client.listGroups().then(r => r.items, () => [])]).then(([users, groups]) => {
      if (live) setTargets({ users, groups })
    })
    return () => {
      live = false
    }
  }, [client])
  return targets
}

/** The label of an extension or a group number, with whom it rings when known. */
export const targetLabel = (targets: Targets, number: string) => {
  const user = targets.users.find(u => u.extension === number)
  if (user) return `${number} (${user.displayName ?? user.userId})`
  const group = targets.groups.find(g => g.number === number)
  return group ? `${number} (${group.name})` : number
}
