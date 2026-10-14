import { useEffect } from 'react'

export const DIAL_CHANNEL = 'twake-phone-calls'

/**
 * Lets other pages ask this one to place a call.
 *
 * Why not dial from the intent iframe that receives the CALL request? Placing a call rings the user's own phone
 * first, and a window with a registered softphone must answer that leg: the iframe has none. So the request is
 * relayed to a Phone window that is already registered (the Phone app or a widget), and only that one dials.
 *
 * Several windows may be open: a request is handled by exactly one of them, chosen with a Web Lock named after
 * the request. A first round only involves visible windows, i.e. the page the user is looking at.
 */
export const useDialRequests = ({ enabled, dial }) => {
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return undefined
    const channel = new BroadcastChannel(DIAL_CHANNEL)

    const handle = async data => {
      try {
        await dial(data.number)
        channel.postMessage({ type: 'dial-ack', id: data.id, ok: true })
      } catch (error) {
        channel.postMessage({
          type: 'dial-ack',
          id: data.id,
          ok: false,
          error: error.message
        })
      }
    }

    channel.onmessage = ({ data }) => {
      if (data?.type !== 'dial' || typeof data.number !== 'string') return
      if (data.visibleOnly && document.visibilityState !== 'visible') return
      if (!navigator.locks) return void handle(data)
      navigator.locks.request(
        `twake-phone-dial-${data.id}`,
        { ifAvailable: true },
        lock => {
          if (lock) return handle(data)
        }
      )
    }
    return () => channel.close()
  }, [enabled, dial])
}

/**
 * Asks a Phone window to dial. Resolves { handled: true } once one did, { handled: false } when nobody could
 * (no Phone window is open): the caller then falls back to opening the Phone app.
 */
export const requestDial = (
  number,
  { visibleTimeoutMs = 700, anyTimeoutMs = 1200 } = {}
) =>
  new Promise(resolve => {
    if (typeof BroadcastChannel === 'undefined')
      return resolve({ handled: false })
    const channel = new BroadcastChannel(DIAL_CHANNEL)
    const id = crypto.randomUUID()
    const timers = []
    const done = result => {
      timers.forEach(clearTimeout)
      channel.close()
      resolve(result)
    }
    channel.onmessage = ({ data }) => {
      if (data?.type === 'dial-ack' && data.id === id)
        done({
          handled: Boolean(data.ok),
          ...(data.error ? { error: data.error } : {})
        })
    }
    channel.postMessage({ type: 'dial', id, number, visibleOnly: true })
    timers.push(
      setTimeout(
        () =>
          channel.postMessage({ type: 'dial', id, number, visibleOnly: false }),
        visibleTimeoutMs
      ),
      setTimeout(
        () => done({ handled: false }),
        visibleTimeoutMs + anyTimeoutMs
      )
    )
  })
