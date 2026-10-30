import { useEffect } from 'react'

export const DIAL_CHANNEL = 'twake-phone-calls'

/**
 * Lets the CALL intent hand a number to a Twake Phone window the person is looking at (ADR 0032): that window puts it
 * in the dialer of its frame. The intent page has no TwakePhone of its own, and a window in the background would fill
 * a dialer nobody sees: only a visible window takes it; with none, the caller opens the app.
 *
 * Several windows may be visible: exactly one takes a request, the one that gets the Web Lock named after it.
 */
export const useDialRelay = ({ enabled, dial }) => {
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return undefined
    const channel = new BroadcastChannel(DIAL_CHANNEL)
    const handle = data => {
      const ok = dial(data.number)
      channel.postMessage({ type: 'dial-ack', id: data.id, ok })
    }
    channel.onmessage = ({ data }) => {
      if (data?.type !== 'dial' || typeof data.number !== 'string' || typeof data.id !== 'string') return
      if (document.visibilityState !== 'visible') return
      if (!navigator.locks) return void handle(data)
      navigator.locks.request(`twake-phone-dial-${data.id}`, { ifAvailable: true }, lock => {
        if (lock) handle(data)
      })
    }
    return () => channel.close()
  }, [enabled, dial])
}

/**
 * Asks a visible Twake Phone window to take `number`. Resolves { handled: true } once one did, { handled: false } when
 * none answered in time. Short: the caller may still have to open a tab, which the browser allows only shortly after
 * the click.
 */
export const requestDial = (number, { timeoutMs = 400 } = {}) =>
  new Promise(resolve => {
    if (typeof BroadcastChannel === 'undefined') return resolve({ handled: false })
    const channel = new BroadcastChannel(DIAL_CHANNEL)
    const id = crypto.randomUUID()
    const done = result => {
      clearTimeout(timer)
      channel.close()
      resolve(result)
    }
    channel.onmessage = ({ data }) => {
      if (data?.type === 'dial-ack' && data.id === id) done({ handled: Boolean(data.ok) })
    }
    const timer = setTimeout(() => done({ handled: false }), timeoutMs)
    channel.postMessage({ type: 'dial', id, number })
  })
