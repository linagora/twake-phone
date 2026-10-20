import { EXTENSION_FORMAT, isReservedNumber, type CallFlow, type CallFlowKind } from '@twake/telephony-types'
import type { CallFlowRecord } from './store/types.js'

// What an administrator may set as a call flow (step 11c-2, ADR 0028): a sequential group, a queue or a voice menu. The
// checks are made here, before any write: nothing unchecked reaches the store, Wazo or OpenSIPS.

/** Most members of a sequential group or a queue. */
export const FLOW_MEMBERS_MAX = 12
export const FLOW_NAME_MAX = 64
/** Seconds each member rings, and a caller waits at most in a queue. */
export const FLOW_RING = { min: 5, max: 60, default: 15 }
export const FLOW_WAIT = { min: 15, max: 600, default: 120 }
/** The digits of a menu: at most one choice each. */
export const MENU_DIGITS = /^[0-9]$/
/** A sound of the telephony server: what reaches its dialplan as a word. */
export const SOUND = /^[A-Za-z0-9_/-]{1,64}$/
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const CONTROL = /[\u0000-\u001f\u007f]/
const KINDS: CallFlowKind[] = ['sequential', 'queue', 'menu']

const refused = (code: string, message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode, code })

/** What the checks ask of the rest of the Gateway. */
export interface FlowChecks {
  /** Whether the number is an extension someone of the organisation holds. */
  isExtension(extension: string): Promise<boolean>
  /** The numbers a flow may not take: the organisation's ring groups, the access number of the meeting rooms. */
  taken(number: string): Promise<boolean>
  /** The other flows of the organisation, by number. */
  flows: ReadonlyMap<string, CallFlowRecord>
}

const integerIn = (value: unknown, range: { min: number; max: number; default: number }, code: string, what: string): number => {
  if (value === undefined || value === null || value === '') return range.default
  const n = typeof value === 'string' && /^[0-9]{1,4}$/.test(value) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < range.min || n > range.max) throw refused(code, `${what} must be ${range.min} to ${range.max} seconds`)
  return n
}

/**
 * Validates a call flow an administrator sets and returns the record to keep. `keep`: the members the flow already has (a
 * vacant extension stays a member until an administrator takes it out, as in a ring group). A 400 or 409 with a `code`
 * the app turns into words.
 */
export const parseCallFlow = async (tenantId: string, number: string, body: unknown, checks: FlowChecks, mode: 'create' | 'replace', keep: readonly string[] = []): Promise<CallFlowRecord> => {
  if (!EXTENSION_FORMAT.test(number)) throw refused('FLOW_NUMBER', 'invalid number: 2 to 6 digits, the first not 0')
  if (isReservedNumber(number)) throw refused('FLOW_NUMBER_RESERVED', `${number} is an emergency number or another short number of the French plan: calls to it go to the operator`)
  if ((await checks.isExtension(number)) || (await checks.taken(number))) throw refused('FLOW_NUMBER_TAKEN', `${number} is already a number of the organisation`, 409)
  if (mode === 'create' && checks.flows.has(number)) throw refused('FLOW_EXISTS', `a flow of the organisation already has the number ${number}`, 409)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refused('FLOW_INVALID', 'invalid flow')
  const b = body as { name?: unknown; kind?: unknown; members?: unknown; ringSec?: unknown; waitSec?: unknown; choices?: unknown; greeting?: unknown }
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > FLOW_NAME_MAX || CONTROL.test(name)) throw refused('FLOW_NAME', `the name must be one line of 1 to ${FLOW_NAME_MAX} characters`)
  if (typeof b.kind !== 'string' || !KINDS.includes(b.kind as CallFlowKind)) throw refused('FLOW_KIND', `the kind is one of ${KINDS.join(', ')}`)
  const kind = b.kind as CallFlowKind
  if (kind === 'menu') {
    if (!b.choices || typeof b.choices !== 'object' || Array.isArray(b.choices)) throw refused('FLOW_CHOICES', 'a menu needs choices: a digit and the number it leads to')
    const choices: Record<string, string> = {}
    for (const [digit, raw] of Object.entries(b.choices as Record<string, unknown>)) {
      if (!MENU_DIGITS.test(digit)) throw refused('FLOW_CHOICES', 'a choice is a digit from 0 to 9')
      const target = typeof raw === 'string' ? raw.replace(/\s/g, '') : ''
      if (target === number) throw refused('FLOW_CHOICE_TARGET', 'a menu cannot lead to itself')
      const other = checks.flows.get(target)
      // An extension of the organisation, or a sequential group or a queue of it (a menu in a menu waits for a use that asks).
      if (other ? other.kind === 'menu' : !(EXTENSION_FORMAT.test(target) && (await checks.isExtension(target)))) throw refused('FLOW_CHOICE_TARGET', `${target.slice(0, 64)}: a choice leads to an extension, a sequential group or a queue of your organisation`)
      choices[digit] = target
    }
    if (Object.keys(choices).length === 0) throw refused('FLOW_CHOICES', 'a menu needs choices: a digit and the number it leads to')
    if (b.greeting !== undefined && b.greeting !== null && b.greeting !== '' && (typeof b.greeting !== 'string' || !SOUND.test(b.greeting))) throw refused('FLOW_GREETING', 'the greeting is the name of a sound of the telephony server (letters, digits, "-", "_" and "/")')
    const greeting = typeof b.greeting === 'string' && b.greeting ? b.greeting : undefined
    return { tenantId, number, name, kind, members: [], choices: Object.fromEntries(Object.entries(choices).sort(([x], [y]) => (x < y ? -1 : 1))), ...(greeting ? { greeting } : {}) }
  }
  if (!Array.isArray(b.members)) throw refused('FLOW_MEMBERS', 'members must be a list of extensions')
  const members: string[] = []
  for (const value of b.members) {
    if (typeof value !== 'string') throw refused('FLOW_MEMBER_NOT_EXTENSION', 'only an extension of your organisation can be a member')
    const m = value.replace(/\s/g, '')
    if (m && !members.includes(m)) members.push(m)
    // One too many is enough to refuse: a huge list costs no lookup.
    if (members.length > FLOW_MEMBERS_MAX) break
  }
  if (members.length === 0 || members.length > FLOW_MEMBERS_MAX) throw refused('FLOW_MEMBERS', `a ${kind === 'queue' ? 'queue' : 'group'} has 1 to ${FLOW_MEMBERS_MAX} members`)
  for (const m of members) {
    if (!/^[0-9]{1,40}$/.test(m) || !(keep.includes(m) || (await checks.isExtension(m)))) throw refused('FLOW_MEMBER_NOT_EXTENSION', `${m.slice(0, 64)}: only an extension of your organisation can be a member`)
  }
  const ringSec = integerIn(b.ringSec, FLOW_RING, 'FLOW_RING', 'the ringing time of a member')
  if (kind === 'sequential' && b.waitSec !== undefined && b.waitSec !== null && b.waitSec !== '') throw refused('FLOW_WAIT', 'a sequential group has no waiting time: its members ring once')
  const waitSec = kind === 'queue' ? integerIn(b.waitSec, FLOW_WAIT, 'FLOW_WAIT', 'the waiting time of a caller') : undefined
  return { tenantId, number, name, kind, members, ringSec, ...(waitSec !== undefined ? { waitSec } : {}), choices: {} }
}

/** The menus of the organisation that lead to `number`: what stops a flow from going while they do. */
export const menusLeadingTo = (flows: Iterable<CallFlowRecord>, number: string) => [...flows].filter(f => f.kind === 'menu' && Object.values(f.choices).includes(number)).map(f => f.number)

/** The record as the administrators read it: whether anyone holds each member, and whether Wazo runs it now. */
export const publicFlow = (f: CallFlowRecord, held: ReadonlySet<string>, running: ReadonlySet<string> | undefined): CallFlow => ({
  number: f.number,
  name: f.name,
  kind: f.kind,
  ...(f.kind !== 'menu' ? { members: f.members, ringSec: f.ringSec ?? FLOW_RING.default, vacant: f.members.filter(m => !held.has(m)) } : {}),
  ...(f.kind === 'queue' ? { waitSec: f.waitSec ?? FLOW_WAIT.default } : {}),
  ...(f.kind === 'menu' ? { choices: f.choices, ...(f.greeting ? { greeting: f.greeting } : {}) } : {}),
  ...(running ? { ready: running.has(f.number) } : {})
})
