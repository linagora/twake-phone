import { useEffect, useState } from 'react'
import { toDialTarget, type Contact, type TelephonyClient } from '@twake/telephony-client'
import { useGateway } from './gateway.js'

/** At most this many numbers are looked up per screen: the Gateway allows 30 searches every 10 s per person. */
export const MAX_LOOKUPS = 15

/** The number as the directory search finds it: an extension as it is, else its last nine digits (0… and +33… alike). */
const queryOf = (number: string) => {
  const digits = number.replace(/\D/g, '')
  return digits.length > 9 ? digits.slice(-9) : digits
}

// One answer per number for the session, a failed one asked again next time. ponytail: no expiry, a reload refreshes.
const found = new Map<string, Promise<Contact | null>>()

/** The person of the directory whose number this is, exactly (not merely containing it), or null. */
export const contactOfNumber = (client: Pick<TelephonyClient, 'searchDirectory'>, number: string): Promise<Contact | null> => {
  const key = toDialTarget(number)
  if (!key || number === 'anonymous') return Promise.resolve(null)
  let answer = found.get(key)
  if (!answer) {
    answer = client.searchDirectory(queryOf(number), 5).then(page => page.items.find(c => c.numbers.some(n => toDialTarget(n.number) === key)) ?? null)
    answer.catch(() => found.delete(key))
    found.set(key, answer)
  }
  return answer.catch(() => null)
}

/** For tests: forget what was found. */
export const forgetContactsByNumber = () => found.clear()

/** The people behind the numbers shown, as they are found (a number nobody has is simply not in the map). */
export const useContactsByNumber = (numbers: readonly string[]) => {
  const { client, me } = useGateway()
  const [contacts, setContacts] = useState<ReadonlyMap<string, Contact>>(new Map())
  const noDirectory = me?.features?.directory === false
  const wanted = [...new Set(numbers)].slice(0, MAX_LOOKUPS).join('\n')
  useEffect(() => {
    if (noDirectory || !wanted) return
    let cancelled = false
    for (const number of wanted.split('\n'))
      void contactOfNumber(client, number).then(c => {
        if (c && !cancelled) setContacts(m => (m.get(number) === c ? m : new Map(m).set(number, c)))
      })
    return () => {
      cancelled = true
    }
  }, [client, wanted, noDirectory])
  return contacts
}
