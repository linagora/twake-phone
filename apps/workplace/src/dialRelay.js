import { useEffect } from 'react'

export const DIAL_CHANNEL = 'twake-phone-calls'
const CLAIM_MS = 400
const ACK_MS = 2_000
/** Longer than requestDial waits: once it gave up, its id is never asked again. */
const HOLD_MS = CLAIM_MS + ACK_MS + 1_000

/**
 * Lets the CALL intent hand a number to a Twake Phone window the person is looking at (ADR 0032): that window puts it
 * in the dialer of its frame. The intent page has no TwakePhone of its own, and a window in the background would fill
 * a dialer nobody sees: only a visible window takes it; with none, the caller opens the app.
 *
 * Several windows may be visible: the one that gets the Web Lock named after the request takes it, and holds the lock
 * for as long as the request may wait (HOLD_MS), so that a window that hears it late finds it taken. It says so at once
 * (`dial-claim`), then how it went (`dial-ack`). A browser without Web Locks takes nothing (it could not keep it to one
 * window).
 */
export const useDialRelay = ({ enabled, dial }) => {
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined' || !navigator.locks) return undefined
    const channel = new BroadcastChannel(DIAL_CHANNEL)
    channel.onmessage = ({ data }) => {
      if (data?.type !== 'dial' || typeof data.number !== 'string' || typeof data.id !== 'string') return
      if (document.visibilityState !== 'visible') return
      void navigator.locks.request(`twake-phone-dial-${data.id}`, { ifAvailable: true }, async lock => {
        if (!lock) return
        channel.postMessage({ type: 'dial-claim', id: data.id })
        const ok = await dial(data.number).catch(() => false)
        channel.postMessage({ type: 'dial-ack', id: data.id, ok })
        await new Promise(resolve => setTimeout(resolve, HOLD_MS))
      })
    }
    return () => channel.close()
  }, [enabled, dial])
}

/**
 * Asks a visible Twake Phone window to take `number`. Resolves { handled: true } once one did, { handled: false } when
 * none claimed it within `claimMs`, or the one that did could not (its frame not signed in). Short: the caller may still
 * have to open a tab, which the browser allows only shortly after the click.
 */
export const requestDial = (number, { claimMs = CLAIM_MS, ackMs = ACK_MS } = {}) =>
  new Promise(resolve => {
    if (typeof BroadcastChannel === 'undefined') return resolve({ handled: false })
    const channel = new BroadcastChannel(DIAL_CHANNEL)
    const id = crypto.randomUUID()
    let timer
    const done = result => {
      clearTimeout(timer)
      channel.close()
      resolve(result)
    }
    const wait = ms => {
      clearTimeout(timer)
      timer = setTimeout(() => done({ handled: false }), ms)
    }
    channel.onmessage = ({ data }) => {
      if (data?.id !== id) return
      // A window took it: no more "nobody", wait for its frame (a tab opened now would fill a second dialer).
      if (data.type === 'dial-claim') wait(ackMs)
      if (data.type === 'dial-ack') done({ handled: Boolean(data.ok) })
    }
    wait(claimMs)
    channel.postMessage({ type: 'dial', id, number })
  })
