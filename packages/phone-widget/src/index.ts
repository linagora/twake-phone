import * as interapp from 'cozy-interapp'

/** Intent served by the Phone app: a persistent card shown in a corner while a call rings or runs. */
export const PHONE_WIDGET_ACTION = 'OPEN'
export const PHONE_WIDGET_TYPE = 'io.twake.phone.widget'

export interface PhoneWidgetOptions {
  /** The host app's CozyClient. */
  client: unknown
  /** Where to attach the widget. Defaults to document.body. */
  parent?: HTMLElement
  /** Gap to the corner of the window, in px. */
  offset?: number
}

type IntentsConstructor = new (options: { client: unknown }) => {
  create(action: string, type: string): { start(element: HTMLElement): Promise<unknown> }
}

/**
 * cozy-interapp is CommonJS with `exports.default = Intents`. Depending on the bundler (and on whether this file
 * is treated as strict ESM) the default import is the class, or the whole `module.exports`: accept both.
 */
const resolveIntents = (): IntentsConstructor => {
  const mod = interapp as unknown as Record<string, unknown>
  const candidates = [mod.default, (mod.default as Record<string, unknown> | undefined)?.default, mod.Intents, mod]
  const found = candidates.find(c => typeof c === 'function')
  if (!found) throw new Error('cozy-interapp: Intents class not found')
  return found as IntentsConstructor
}

/**
 * How other code of the host page (PhoneLink) finds the widget without creating a second intent:
 * cozy-interapp's listener throws "Invalid event id" when two intents answer from the same origin, which
 * would kill the widget. A global, keyed by a shared symbol, avoids a dependency between the two packages.
 */
export const PHONE_WIDGET_REGISTRY = Symbol.for('twake.phone.widget')
export const DIAL_MESSAGE = 'twake-phone:dial'

export interface PhoneWidgetHandle {
  /** Asks the widget to place a call. Resolves { handled: false } when it cannot (not ready, refused, timeout). */
  dial(number: string): Promise<{ handled: boolean; error?: string }>
}

const ID = 'twake-phone-widget'

const STYLE = `
#${ID}{position:fixed;right:var(--tpw-offset,16px);bottom:var(--tpw-offset,16px);z-index:2147483000;
  width:0;height:0;overflow:hidden;border-radius:18px;transition:width .15s ease,height .15s ease}
#${ID} iframe{display:block;width:100%;height:100%;border:0;background:transparent}`

/**
 * Keeps the Phone widget alive in the current application, so a call can be answered from there without
 * switching app. The widget is an intent service iframe: Phone owns the softphone and the UI, the host only
 * provides the corner and the microphone permission.
 *
 * Returns a function that removes the widget. Does nothing (and returns a no-op) when the page is itself an
 * iframe or the widget is already mounted. Failure to create the intent (Phone not installed) is silent.
 */
export const mountPhoneWidget = ({ client, parent = document.body, offset = 16 }: PhoneWidgetOptions): (() => void) => {
  if (window.self !== window.top || document.getElementById(ID)) return () => undefined

  const style = document.createElement('style')
  style.textContent = STYLE
  const container = document.createElement('div')
  container.id = ID
  container.style.setProperty('--tpw-offset', `${offset}px`)
  container.setAttribute('role', 'region')
  container.setAttribute('aria-label', 'Phone')

  // cozy-interapp creates the iframe without an `allow` attribute, which would block the microphone for the
  // cross-origin Phone page. The browser reads it when the iframe is inserted, so it has to be there *before*:
  // cozy-interapp inserts it with `container.appendChild(iframe)`, which is intercepted here.
  const ALLOW = 'microphone; autoplay'
  const appendChild = container.appendChild.bind(container)
  container.appendChild = <T extends Node>(node: T): T => {
    if (node instanceof HTMLIFrameElement) node.setAttribute('allow', ALLOW)
    return appendChild(node)
  }
  // Fallback if the host library ever inserts differently.
  const observer = new MutationObserver(records => {
    for (const record of records)
      record.addedNodes.forEach(node => {
        if (node instanceof HTMLIFrameElement && !node.hasAttribute('allow')) node.setAttribute('allow', ALLOW)
      })
  })
  observer.observe(container, { childList: true })

  document.head.appendChild(style)
  parent.appendChild(container)

  const handle: PhoneWidgetHandle = {
    dial: number =>
      new Promise(resolve => {
        const iframe = container.querySelector('iframe')
        if (!iframe?.contentWindow || !iframe.src) return resolve({ handled: false, error: 'widget-not-ready' })
        // A private channel for the answer: nothing is posted on `window`, where cozy-interapp listens.
        const channel = new MessageChannel()
        const timer = setTimeout(() => resolve({ handled: false, error: 'timeout' }), 3000)
        channel.port1.onmessage = event => {
          clearTimeout(timer)
          resolve(event.data as { handled: boolean; error?: string })
        }
        iframe.contentWindow.postMessage({ type: DIAL_MESSAGE, number }, new URL(iframe.src).origin, [channel.port2])
      })
  }
  ;(window as unknown as Record<symbol, unknown>)[PHONE_WIDGET_REGISTRY] = handle

  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    if ((window as unknown as Record<symbol, unknown>)[PHONE_WIDGET_REGISTRY] === handle) delete (window as unknown as Record<symbol, unknown>)[PHONE_WIDGET_REGISTRY]
    observer.disconnect()
    container.remove()
    style.remove()
  }

  // The widget is optional: when it cannot start (Phone not installed, intent refused) it leaves no trace
  // beyond a console message that says why.
  const fail = (error: unknown) => {
    console.warn('[twake-phone-widget] not started:', error)
    remove()
  }

  try {
    const Intents = resolveIntents()
    new Intents({ client })
      .create(PHONE_WIDGET_ACTION, PHONE_WIDGET_TYPE)
      .start(container)
      .catch(error => fail(error))
  } catch (error) {
    fail(error)
  }
  return remove
}
