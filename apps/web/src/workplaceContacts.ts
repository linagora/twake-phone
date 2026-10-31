import * as Comlink from 'comlink'
import { useEffect, useState } from 'react'
import { toDialTarget, type Contact, type ContactNumber } from '@twake/telephony-client'
import { isFramed, parentOrigin } from './embedded.js'

/**
 * The person's own contacts in Twake Workplace (`io.cozy.contacts`), when TwakePhone is framed by its Workplace app
 * (ADR 0032): read through the app's bridge (`cozy-external-bridge-container`, `fetchJSON`, all pages). They name the
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
  return indexOf(contacts).get(key) ?? null
}

/** Each full number to its one contact (null: several share it), built once per list: a render reads it, never scans. */
const indexes = new WeakMap<readonly Contact[], Map<string, Contact | null>>()
const indexOf = (contacts: readonly Contact[]) => {
  let index = indexes.get(contacts)
  if (index) return index
  index = new Map()
  for (const c of contacts)
    for (const key of new Set(c.numbers.map(n => toDialTarget(n.number)))) {
      if (!key?.startsWith('+')) continue
      index.set(key, index.has(key) && index.get(key) !== c ? null : c)
    }
  indexes.set(contacts, index)
  return index
}

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

/** What cozy-stack answers for a page of a doctype's documents (`_normal_docs`). */
interface DocsPage {
  rows?: WorkplaceContact[]
  bookmark?: string
}
const PAGE = 1_000
// ponytail: 20 pages (20 000 contacts) at most; a bigger address book would want a search by number instead.
const MAX_PAGES = 20

/** A page that did not come in time: the list is asked again later. */
const late = <T>(p: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('late')), ms)))]).finally(() => clearTimeout(timer))
}

/**
 * All the contacts, page by page (the bridge's getContacts reads the first 100 only), each page in `pageMs`. No contact
 * at all is no error: cozy-stack answers 404 for a doctype that has no document yet.
 */
export const allContacts = async (bridge: { fetchJSON(r: { method: string; path: string }): Promise<DocsPage> }, pageMs = 5_000) => {
  const all: WorkplaceContact[] = []
  let bookmark: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const path = `/data/io.cozy.contacts/_normal_docs?limit=${PAGE}${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`
    let res: DocsPage
    try {
      res = await late(bridge.fetchJSON({ method: 'GET', path }), pageMs)
    } catch (err) {
      // ponytail: the bridge passes the error's message only (comlink), the stack's 404 is read in it.
      if (page === 0 && /404|not.?found/i.test(String((err as Error)?.message))) return all
      throw err
    }
    const rows = Array.isArray(res?.rows) ? res.rows : []
    all.push(...rows)
    if (rows.length < PAGE || !res.bookmark) break
    bookmark = res.bookmark
  }
  return all
}

/** The contacts; [] for a parent that is no Workplace app (it never answers), null for one that failed this time. */
const ask = async (timeoutMs: number): Promise<Contact[] | null> => {
  const origin = await parentOrigin(1_000)
  if (!origin) return []
  const bridge = Comlink.wrap<{ fetchJSON(r: { method: string; path: string }): Promise<DocsPage> }>(parentEndpoint(origin))
  try {
    const list = await allContacts(bridge, timeoutMs).catch(() => null)
    return list ? list.flatMap(c => toContact(c) ?? []) : null
  } finally {
    bridge[Comlink.releaseProxy]()
  }
}

let loaded: Promise<Contact[]> | null = null

/**
 * The person's Workplace contacts, asked once per page; none outside a frame, nor in a frame that is no Workplace app.
 * A Workplace app that did not answer in time is asked again by the next screen that needs them (an empty list
 * meanwhile: the directory still names who it knows).
 */
export const workplaceContacts = (timeoutMs = 5_000): Promise<Contact[]> => {
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
