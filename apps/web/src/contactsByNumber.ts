import { useEffect, useState } from 'react'
import { toDialTarget, type Contact, type TelephonyClient } from '@twake/telephony-client'
import { useGateway } from './gateway.js'
import { workplaceContactOf, workplaceContacts } from './workplaceContacts.js'

/**
 * The Gateway allows 30 directory searches every 10 s per person, all screens together: the lookups of names take at
 * most this many of them per window, the rest stays for what the person types.
 */
export const LOOKUP_BUDGET = 10
const WINDOW_MS = 10_000
/** As many answers as the Gateway gives at once: a short extension matches the end of many numbers. */
const LIMIT = 50

/** The number as the directory search finds it: an extension as it is, else its last nine digits (0… and +33… alike). */
const queryOf = (number: string) => {
  const digits = number.replace(/\D/g, '')
  return digits.length > 9 ? digits.slice(-9) : digits
}

// One answer per number for the session; one that failed, was cut short or not asked (budget spent) is asked again
// another time. ponytail: no expiry, a reload refreshes.
const found = new Map<string, Promise<Contact | null>>()
let spent: number[] = []

const ask = async (client: Pick<TelephonyClient, 'searchDirectory'>, number: string, key: string): Promise<Contact | null> => {
  const page = await client.searchDirectory(queryOf(number), LIMIT)
  const owners = page.items.filter(c => c.numbers.some(n => toDialTarget(n.number) === key))
  // A number several people share (a desk, a service line) names nobody; a cut answer may have missed its owner.
  if (owners.length === 0 && page.truncated) throw new Error('truncated')
  return owners.length === 1 ? owners[0]! : null
}

/** The one person of the directory whose number this is, exactly (not merely containing it), or null. */
export const contactOfNumber = (client: Pick<TelephonyClient, 'searchDirectory'>, number: string, now = Date.now()): Promise<Contact | null> => {
  const key = toDialTarget(number)
  if (!key || number === 'anonymous') return Promise.resolve(null)
  let answer = found.get(key)
  if (!answer) {
    spent = spent.filter(at => now - at < WINDOW_MS)
    if (spent.length >= LOOKUP_BUDGET) return Promise.resolve(null)
    spent.push(now)
    answer = ask(client, number, key)
    answer.catch(() => found.delete(key))
    found.set(key, answer)
  }
  return answer.catch(() => null)
}

/** For tests: forget what was found and asked. */
export const forgetContactsByNumber = () => {
  found.clear()
  spent = []
}

/** The people behind the numbers shown, as they are found (a number nobody, or several people, have: undefined). */
export const useContactsByNumber = (numbers: readonly string[]) => {
  const { client, me } = useGateway()
  const [contacts, setContacts] = useState<ReadonlyMap<string, Contact>>(new Map())
  const noDirectory = me?.features?.directory === false
  // Each number once, however it is written; the first shown first.
  const seen = new Set<string>()
  const wanted = numbers
    .filter(n => {
      const key = n === 'anonymous' ? null : toDialTarget(n)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join('\n')
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    for (const number of wanted.split('\n'))
      // The directory first; a number it does not name, by the person's own contacts in Twake Workplace (framed only).
      void (noDirectory ? Promise.resolve(null) : contactOfNumber(client, number))
        .then(async c => c ?? workplaceContactOf(await workplaceContacts(), number))
        .then(c => {
          if (c && !cancelled) setContacts(m => (m.get(toDialTarget(number)!) === c ? m : new Map(m).set(toDialTarget(number)!, c)))
        })
    return () => {
      cancelled = true
    }
  }, [client, wanted, noDirectory])
  // ponytail: a lookup by the number as it is dialled, so 0… and +33… find the same person.
  return { get: (number: string) => (number === 'anonymous' ? undefined : contacts.get(toDialTarget(number) ?? '')) }
}
