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

/**
 * The one contact whose number this is (compared as dialled: 0… and +33… alike), or null for nobody or several. Full
 * numbers only: a contact saved with a short number (1234) would otherwise name every internal call from that extension.
 */
export const workplaceContactOf = (contacts: readonly Contact[], number: string): Contact | null => {
  const key = toDialTarget(number)
  if (!key?.startsWith('+')) return null
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

/**
 * The bridge's channel to the parent: comlink's window endpoint, but hearing only the parent, from its origin (the
 * popup of the sign-in, or any other window, cannot answer in its place).
 */
const parentEndpoint = (origin: string): Comlink.Endpoint => {
  const wrapped = new Map<EventListenerOrEventListenerObject, EventListener>()
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) => window.parent.postMessage(message, origin, transfer),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const only: EventListener = event => {
        const e = event as MessageEvent
        if (e.source !== window.parent || e.origin !== origin) return
        if (typeof listener === 'function') listener(e)
        else listener.handleEvent(e)
      }
      wrapped.set(listener, only)
      window.addEventListener(type, only)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const only = wrapped.get(listener)
      if (only) window.removeEventListener(type, only)
      wrapped.delete(listener)
    }
  }
}

const ask = async (timeoutMs: number): Promise<Contact[] | null> => {
  const origin = await parentOrigin(1_000)
  if (!origin) return null
  const bridge = Comlink.wrap<{ getContacts(): Promise<WorkplaceContact[]> }>(parentEndpoint(origin))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), timeoutMs)))
    const list = await Promise.race([bridge.getContacts(), late]).catch(() => null)
    return Array.isArray(list) ? list.flatMap(c => toContact(c) ?? []) : null
  } finally {
    clearTimeout(timer)
    bridge[Comlink.releaseProxy]()
  }
}

let loaded: Promise<Contact[]> | null = null

/**
 * The person's Workplace contacts, asked once per page; none outside a frame. A parent that did not answer in time is
 * asked again by the next screen that needs them (an empty list meanwhile: the directory still names who it knows).
 */
export const workplaceContacts = (timeoutMs = 3_000): Promise<Contact[]> => {
  if (!isFramed()) return Promise.resolve([])
  loaded ??= ask(timeoutMs).then(list => {
    if (!list) loaded = null
    return list ?? []
  })
  return loaded
}

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

/**
 * The name to show for a call: the one the SIP server gave, else the Workplace contact whose number it is. Read at
 * render time: a call is a live object of the softphone (its methods, its changing state), never copied to add a name.
 */
export const nameOf = (call: { remoteNumber: string; remoteName?: string }, contacts: readonly Contact[]): string | undefined => {
  if (call.remoteName && call.remoteName.toLowerCase() !== 'anonymous') return call.remoteName
  return workplaceContactOf(contacts, call.remoteNumber)?.displayName
}
