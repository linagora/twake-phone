import type { ForwardingRules, PresenceChoice } from '@twake/telephony-client'
import type { Key } from './i18n/index.js'

// What the settings screen turns into requests and back (pure, unit-tested): the forms hold strings, the Gateway wants rules.

/** The forwarding form: one field per case, the extension typed (empty: no forward then), the delay in seconds. */
export interface ForwardingForm {
  always: string
  busy: string
  noAnswer: string
  delaySec: string
}

export const DEFAULT_DELAY_SEC = 20

export const formFromRules = (r: ForwardingRules): ForwardingForm => ({
  always: r.always ?? '',
  busy: r.busy ?? '',
  noAnswer: r.noAnswer?.target ?? '',
  delaySec: String(r.noAnswer?.delaySec ?? DEFAULT_DELAY_SEC)
})

const clean = (v: string) => v.replace(/\s/g, '')

export const rulesFromForm = (f: ForwardingForm): ForwardingRules => {
  const always = clean(f.always)
  const busy = clean(f.busy)
  const noAnswer = clean(f.noAnswer)
  return {
    ...(always ? { always } : {}),
    ...(busy ? { busy } : {}),
    ...(noAnswer ? { noAnswer: { target: noAnswer, delaySec: Number(f.delaySec) || DEFAULT_DELAY_SEC } } : {})
  }
}

/** The Gateway's reasons for refusing rules or a presence (its error `code`), in the person's words. */
const CODE_KEY: Record<string, Key> = {
  FORWARD_SELF: 'settings.forwardSelf',
  FORWARD_NOT_EXTENSION: 'settings.forwardNotExtension',
  FORWARD_DELAY: 'settings.forwardDelayInvalid',
  PRESENCE_UNTIL: 'settings.presenceUntilInvalid',
  PRESENCE_MESSAGE: 'settings.presenceMessageInvalid'
}

export const refusalKey = (err: unknown): Key | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? CODE_KEY[code] : undefined
}

const pad = (n: number) => String(n).padStart(2, '0')

/** An instant as a `datetime-local` input shows it, in the browser's time zone (minutes). */
export const toLocalInput = (iso: string | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** What a `datetime-local` input holds (the browser's time zone), as an instant; empty or invalid: none. */
export const fromLocalInput = (value: string): string | undefined => {
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** The statuses one chooses oneself; busy and offline are the SIP server's to say. */
export const CHOSEN_STATUSES = ['available', 'away', 'dnd'] as const
export type ChosenStatus = (typeof CHOSEN_STATUSES)[number]

export const chosenStatus = (choice: PresenceChoice | undefined): ChosenStatus =>
  choice && (CHOSEN_STATUSES as readonly string[]).includes(choice.status) ? (choice.status as ChosenStatus) : 'available'
