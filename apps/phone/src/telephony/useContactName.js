import { useQuery } from 'cozy-client'

import { buildContactsQuery } from '@/queries/queries'
import { findContactByNumber, findContactByPrefix } from '@/telephony/contacts'

/** Contact owning `number` (exact match), or null: the UI then shows the number itself. */
export const useContact = number => {
  const { definition, options } = buildContactsQuery()
  const { data } = useQuery(definition, options)
  return number ? findContactByNumber(data, number) : null
}

/** Contact whose number starts with what the user has typed (for the dialer suggestion). */
export const useContactSuggestion = typed => {
  const { definition, options } = buildContactsQuery()
  const { data } = useQuery(definition, options)
  return findContactByPrefix(data, typed)
}

export const useContactName = number => useContact(number)?.displayName ?? null
