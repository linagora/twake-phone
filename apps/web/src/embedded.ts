import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SoftCall } from '@twake/softphone'
import { usePhone } from './softphone.js'

/**
 * TwakePhone shown in the frame of its Twake Workplace app (`apps/workplace`, ADR 0032). The identity provider refuses
 * to be framed, so a framed page signs in in a popup; and the Workplace app hands it the numbers to call.
 */
export const isFramed = (win: Window = window): boolean => {
  try {
    return win.self !== win.top
  } catch {
    // A cross-origin top that cannot even be compared: framed.
    return true
  }
}

/** The name of the sign-in popup: the page that comes back from the identity provider in it knows it is that popup. */
export const SIGNIN_POPUP = 'twakephone-signin'

/**
 * What the Workplace app posts to the frame: a number to put in the dialer (ADR 0031: filled, never dialled), and the
 * frame's answer once it took it. A frame that is not signed in yet does not answer: the Workplace app then says it
 * could not, and the number goes to a new tab instead of being lost.
 */
export const DIAL_MESSAGE = 'twakephone.dial'
export const DIAL_ACK = 'twakephone.dial-ack'

/** The `?dial=` path a message from the parent asks for and its id, or null when it is not one (sender, type, shape). */
export const dialRequestOf = (event: Pick<MessageEvent, 'source' | 'data'>, parent: unknown): { path: string; id: string } | null => {
  if (event.source !== parent) return null
  const data = event.data as { type?: unknown; number?: unknown; id?: unknown } | null
  if (data?.type !== DIAL_MESSAGE || typeof data.number !== 'string' || !data.number || data.number.length > 40) return null
  if (typeof data.id !== 'string' || data.id.length > 64) return null
  return { path: `/?dial=${encodeURIComponent(data.number)}`, id: data.id }
}

/** Opens the dialer on the numbers the parent page posts, when framed and signed in, and says it took each one. */
export const ParentDial = () => {
  const navigate = useNavigate()
  useEffect(() => {
    if (!isFramed()) return
    const onMessage = (event: MessageEvent) => {
      const request = dialRequestOf(event, window.parent)
      if (!request) return
      void navigate(request.path)
      window.parent.postMessage({ type: DIAL_ACK, id: request.id }, event.origin)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [navigate])
  return null
}

/** The origin of the parent page, as the Workplace app's bridge answers it (`requestParentOrigin`), or undefined. */
export const parentOrigin = (timeoutMs: number) =>
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
 * What the frame tells its parent of its calls, and what the parent may ask of one (ADR 0034): the Workplace app's
 * widget shows a ringing or running call in the other apps and answers, declines or hangs up there. The frame stays
 * the only phone; it takes these orders from its parent only, at the origin that answered `requestParentOrigin`.
 */
export const CALLS_MESSAGE = 'twakephone.calls'
export const COMMAND_MESSAGE = 'twakephone.command'
export type CallCommand = 'answer' | 'reject' | 'hangup'
export interface CallSummary {
  id: string
  direction: 'inbound' | 'outbound'
  state: 'new' | 'ringing' | 'connected' | 'held'
  remoteNumber: string
  remoteName?: string
}

/** The calls under way, as the parent sees them: no media, no SIP, nothing to act on but their id. */
export const summaryOf = (calls: readonly SoftCall[]): CallSummary[] =>
  calls.flatMap(c =>
    c.state === 'ended'
      ? []
      : [{ id: c.id, direction: c.direction, state: c.state, remoteNumber: c.remoteNumber, ...(c.remoteName && c.remoteName.toLowerCase() !== 'anonymous' ? { remoteName: c.remoteName } : {}) }]
  )

const COMMANDS: readonly CallCommand[] = ['answer', 'reject', 'hangup']

/** The order a message from the parent gives, or null (another sender or origin, another type, an unknown order). */
export const commandOf = (event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: unknown, origin: string): { callId: string; action: CallCommand } | null => {
  if (event.source !== parent || event.origin !== origin) return null
  const data = event.data as { type?: unknown; callId?: unknown; action?: unknown } | null
  if (data?.type !== COMMAND_MESSAGE || typeof data.callId !== 'string' || !COMMANDS.includes(data.action as CallCommand)) return null
  return { callId: data.callId, action: data.action as CallCommand }
}

/** Tells the parent the calls as they change, and carries out its orders on them, when framed. */
export const ParentCalls = () => {
  const { calls } = usePhone()
  const [origin, setOrigin] = useState<string>()
  const current = useRef(calls)
  useEffect(() => {
    current.current = calls
  }, [calls])
  useEffect(() => {
    if (!isFramed()) return
    let cancelled = false
    // The parent's bridge may be late (the shell still starting): asked again, five times at most.
    const ask = async () => {
      for (let tries = 0; tries < 5 && !cancelled; tries++) {
        const found = await parentOrigin(1_000)
        if (found) return !cancelled && setOrigin(found)
      }
    }
    void ask()
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (origin) window.parent.postMessage({ type: CALLS_MESSAGE, calls: summaryOf(calls) }, origin)
  }, [origin, calls])
  useEffect(() => {
    if (!origin) return
    const onMessage = (event: MessageEvent) => {
      const order = commandOf(event, window.parent, origin)
      const call = order && current.current.find(c => c.id === order.callId)
      if (order && call) void call[order.action]().catch(() => undefined)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [origin])
  return null
}
