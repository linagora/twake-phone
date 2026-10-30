import type { MouseEvent, ReactNode } from 'react'
import { generateWebLink, useClient } from 'cozy-client'
import * as interapp from 'cozy-interapp'
import { toDialTarget } from '@twake/telephony-client'

/** Intent served by the Phone app: place a call to a number. */
export const CALL_ACTION = 'CALL'
export const CALL_TYPE = 'io.twake.phone.number'

// Same symbol as @twake/phone-widget: the widget mounted in this page, if any.
const PHONE_WIDGET_REGISTRY = Symbol.for('twake.phone.widget')
interface WidgetHandle {
  dial(number: string): Promise<{ handled: boolean; error?: string }>
}

export type CallResult =
  | { handled: true; via: 'widget' | 'phone' | 'app' }
  | { handled: false; reason: 'invalid-number' | 'phone-unavailable' }

export type IntentsConstructor = new (options: { client: unknown }) => {
  create(action: string, type: string, data: object): { start(element: HTMLElement): Promise<unknown> }
}

// cozy-interapp is CommonJS: the class is on `default` or on the module itself depending on the bundler.
const resolveIntents = (): IntentsConstructor => {
  const mod = interapp as unknown as Record<string, unknown>
  const found = [mod.default, (mod.default as Record<string, unknown> | undefined)?.default, mod.Intents, mod].find(c => typeof c === 'function')
  if (!found) throw new Error('cozy-interapp: Intents class not found')
  return found as IntentsConstructor
}

interface CozyClientLike {
  getStackClient(): { uri: string }
  getInstanceOptions(): { subdomain?: string }
}

export interface RequestCallOptions {
  client: unknown
  number: string
  /** Override of the cozy-interapp class (tests). */
  Intents?: IntentsConstructor
  /**
   * Opens the Phone app when no Phone window took the number; false when it could not (a blocked popup). Defaults to a
   * new tab, cut from this page (no opener).
   */
  openPhone?: (url: string) => boolean | void
  /** How long the intent may take before the app is opened instead (a service that never answers). */
  intentTimeoutMs?: number
}

const openTab = (url: string): boolean => {
  // Not 'noopener': window.open would then return null whether or not it opened, and a blocked tab would read as handled.
  const tab = window.open(url, '_blank')
  if (!tab) return false
  tab.opener = null
  return true
}

/**
 * The Twake Workplace app of Twake Phone, opened on the dialer with the number (ADR 0032): its frame loads TwakePhone at
 * `/?dial=` (ADR 0031), which fills the dialer and waits for the person to press Call.
 */
export const phoneAppUrl = (client: CozyClientLike, target: string): string =>
  generateWebLink({
    cozyUrl: client.getStackClient().uri,
    slug: 'phone',
    subDomainType: client.getInstanceOptions().subdomain,
    pathname: '/',
    hash: `/bridge/?dial=${encodeURIComponent(target)}`
  })

/**
 * Asks Twake Phone to call `number`, without changing application when a Phone window is already open
 * (the Phone app, or the widget mounted in this page). When none is, opens the Phone app, which dials on load.
 *
 * The number is validated and normalised first: text that is not a phone number is never dialled.
 */
export const requestCall = async ({ client, number, Intents: IntentsOverride, openPhone = openTab, intentTimeoutMs = 5_000 }: RequestCallOptions): Promise<CallResult> => {
  const target = toDialTarget(number)
  if (!target) return { handled: false, reason: 'invalid-number' }

  // The widget of this page already is a registered Phone window: talk to it directly. A second intent in the
  // same page would make cozy-interapp's listener throw and take the widget down with it.
  const widget = (window as unknown as Record<symbol, WidgetHandle | undefined>)[PHONE_WIDGET_REGISTRY]
  if (widget) {
    const outcome = await widget.dial(target).catch(() => ({ handled: false }))
    if (outcome.handled) return { handled: true, via: 'widget' }
    return openApp(client as CozyClientLike, target, openPhone)
  }

  // The intent iframe only relays the request: it lives, invisible, for the time of the exchange.
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  container.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none'
  document.body.appendChild(container)
  let answer: { handled?: boolean } | undefined
  try {
    const Intents = IntentsOverride ?? resolveIntents()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>(resolve => (timer = setTimeout(() => resolve(undefined), intentTimeoutMs)))
    answer = (await Promise.race([new Intents({ client }).create(CALL_ACTION, CALL_TYPE, { number: target }).start(container), late]).finally(() => clearTimeout(timer))) as { handled?: boolean } | undefined
  } catch {
    answer = undefined // Phone not installed or intent refused: fall through to the app
  } finally {
    container.remove()
  }
  if (answer?.handled) return { handled: true, via: 'phone' }
  return openApp(client as CozyClientLike, target, openPhone)
}

const openApp = (client: CozyClientLike, target: string, openPhone: (url: string) => boolean | void): CallResult => {
  try {
    if (openPhone(phoneAppUrl(client, target)) === false) return { handled: false, reason: 'phone-unavailable' }
    return { handled: true, via: 'app' }
  } catch {
    return { handled: false, reason: 'phone-unavailable' }
  }
}

export interface PhoneLinkProps {
  /** The phone number, in any usual format. Must be an explicit phone field, never guessed from free text. */
  number: string
  children?: ReactNode
  onResult?: (result: CallResult) => void
  className?: string
}

/**
 * A phone number that calls when clicked. Without JavaScript, or when the number is not valid, it degrades
 * to a standard tel: link or plain text instead of doing something surprising.
 */
export const PhoneLink = ({ number, children, onResult, className }: PhoneLinkProps) => {
  const client = useClient()
  const target = toDialTarget(number)
  if (!target) return <span className={className}>{children ?? number}</span>

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    void requestCall({ client, number: target }).then(onResult)
  }
  return (
    <a className={className} href={`tel:${target}`} onClick={onClick}>
      {children ?? number}
    </a>
  )
}
