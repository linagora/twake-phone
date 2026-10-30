import * as Comlink from 'comlink'
import { useEffect, useState } from 'react'
import { toDialTarget, type Contact, type ContactNumber } from '@twake/telephony-client'
import { isFramed } from './embedded.js'

/**
 * The person's own contacts in Twake Workplace (`io.cozy.contacts`), when TwakePhone is framed by its Workplace app
 * (ADR 0032): the app hands them over its bridge (`cozy-external-bridge-container`, `getContacts`). They name the
 * numbers the organisation's directory does not know. The Gateway never sees them: they stay in this page.
 */

/** A contact as Twake Workplace stores it: the fields read here, all optional. */
export interface WorkplaceContact {
  _id?: string
  displayName?: string
  fullname?: string
  company?: string
  phone?: { number?: string; type?: string }[]
  email?: { address?: string; primary?: boolean }[]
}

/** The id of a Workplace contact in the app: never a directory id, so no screen links it to a directory card. */
const PREFIX = 'workplace:'
export const isWorkplaceContact = (contact: Pick<Contact, 'id'>) => contact.id.startsWith(PREFIX)

const kindOf = (type?: string): ContactNumber['type'] => (type === 'cell' || type === 'mobile' ? 'mobile' : 'work')

/** The contact as the app shows a person, or null when it has no name or no number. */
export const toContact = (c: WorkplaceContact): Contact | null => {
  const displayName = (c.displayName ?? c.fullname ?? '').trim()
  const numbers = (c.phone ?? []).flatMap(p => (typeof p.number === 'string' && p.number ? [{ type: kindOf(p.type), number: p.number }] : []))
  if (!displayName || !numbers.length) return null
  const email = c.email?.find(e => e.primary)?.address ?? c.email?.[0]?.address
  return { id: `${PREFIX}${c._id ?? displayName}`, displayName, numbers, ...(c.company ? { department: c.company } : {}), ...(email ? { email } : {}) }
}

/** The one contact whose number this is (compared as dialled: 0… and +33… alike), or null for nobody or several. */
export const workplaceContactOf = (contacts: readonly Contact[], number: string): Contact | null => {
  const key = toDialTarget(number)
  if (!key) return null
  const owners = contacts.filter(c => c.numbers.some(n => toDialTarget(n.number) === key))
  return owners.length === 1 ? owners[0]! : null
}

/** The origin of the parent page, as the Workplace app's bridge answers it (`requestParentOrigin`), or undefined. */
const parentOrigin = (timeoutMs: number) =>
  new Promise<string | undefined>(resolve => {
    const onMessage = (event: MessageEvent) => {
      if (event.data !== 'answerParentOrigin' || event.source !== window.parent || !event.origin) return
      done(event.origin)
    }
    const done = (origin?: string) => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(origin)
    }
    window.addEventListener('message', onMessage)
    const timer = setTimeout(done, timeoutMs)
    window.parent.postMessage('requestParentOrigin', '*')
  })

let loaded: Promise<Contact[]> | null = null

/**
 * The person's Workplace contacts, asked once per page; none outside a frame, from a parent without the bridge, or
 * when it does not answer in time (an empty list: the directory still names who it knows).
 */
export const workplaceContacts = (timeoutMs = 3_000): Promise<Contact[]> =>
  (loaded ??= (async () => {
    if (!isFramed()) return []
    const origin = await parentOrigin(1_000)
    if (!origin) return []
    const bridge = Comlink.wrap<{ getContacts(): Promise<WorkplaceContact[]> }>(Comlink.windowEndpoint(window.parent, self, origin))
    const list = await Promise.race([bridge.getContacts(), new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs))]).catch(() => null)
    return Array.isArray(list) ? list.flatMap(c => toContact(c) ?? []) : []
  })())

/** For tests: forget the contacts asked. */
export const forgetWorkplaceContacts = () => {
  loaded = null
}

/** The person's Workplace contacts for a screen: empty until they come (and outside a frame). */
export const useWorkplaceContacts = (): readonly Contact[] => {
  const [list, setList] = useState<readonly Contact[]>([])
  useEffect(() => {
    let cancelled = false
    void workplaceContacts().then(found => {
      if (!cancelled && found.length) setList(found)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return list
}

/** The call with the name of the Workplace contact whose number it is, when the SIP server gave it none. */
export const namedByWorkplace = <T extends { remoteNumber: string; remoteName?: string }>(call: T, contacts: readonly Contact[]): T => {
  if (call.remoteName || !contacts.length) return call
  const contact = workplaceContactOf(contacts, call.remoteNumber)
  return contact ? { ...call, remoteName: contact.displayName } : call
}
