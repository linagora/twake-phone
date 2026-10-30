import { useEffect } from 'react'

import { DIAL_CHANNEL } from '@/dialRelay'

/**
 * The calls of this Twake Phone window, for the widget of the other apps (ADR 0034): its frame tells them
 * (`twakephone.calls`), this window says them on the channel of its origin, and carries the widget's orders (answer,
 * decline, hang up) to its frame. The frame stays the only phone: the widget is a remote control.
 */
export const CALLS_MESSAGE = 'twakephone.calls'
export const COMMAND_MESSAGE = 'twakephone.command'
const ACTIONS = ['answer', 'reject', 'hangup']

// The channel is the origin's: any page of the shell's origin (the shell, its intent pages) is trusted alike; the frame
// takes orders from its parent only, and the host apps never see the channel (another origin).
export const useCallsRelay = ({ enabled, frameOrigin }) => {
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return undefined
    const me = crypto.randomUUID()
    const channel = new BroadcastChannel(DIAL_CHANNEL)
    const frame = () => document.getElementById('embeddedApp')?.contentWindow
    let calls = []
    const say = () => channel.postMessage({ type: 'calls', window: me, calls })
    const onFrame = event => {
      if (event.source !== frame() || event.origin !== frameOrigin || event.data?.type !== CALLS_MESSAGE || !Array.isArray(event.data.calls)) return
      calls = event.data.calls
      say()
    }
    channel.onmessage = ({ data }) => {
      if (data?.type === 'calls-request') return say()
      if (data?.type !== 'command' || data.window !== me || typeof data.callId !== 'string' || !ACTIONS.includes(data.action)) return
      frame()?.postMessage({ type: COMMAND_MESSAGE, callId: data.callId, action: data.action }, frameOrigin)
    }
    // A window that goes away takes its calls with it: the widget forgets them; back from the cache, it says them again.
    // While it has calls, it says them every 10 s: the widget forgets a window it no longer hears (a tab killed).
    const leave = () => channel.postMessage({ type: 'calls', window: me, calls: [] })
    const beat = setInterval(() => calls.length && say(), 10_000)
    window.addEventListener('message', onFrame)
    window.addEventListener('pagehide', leave)
    window.addEventListener('pageshow', say)
    return () => {
      leave()
      clearInterval(beat)
      window.removeEventListener('message', onFrame)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('pageshow', say)
      channel.close()
    }
  }, [enabled, frameOrigin])
}
