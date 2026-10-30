import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

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

/** What the Workplace app posts to the frame: a number to put in the dialer (ADR 0031: filled, never dialled). */
export const DIAL_MESSAGE = 'twakephone.dial'

/** The `?dial=` path a message from the parent asks for, or null when it is not one (wrong sender, type or shape). */
export const dialPathOf = (event: Pick<MessageEvent, 'source' | 'data'>, parent: unknown): string | null => {
  if (event.source !== parent) return null
  const data = event.data as { type?: unknown; number?: unknown } | null
  if (data?.type !== DIAL_MESSAGE || typeof data.number !== 'string' || !data.number || data.number.length > 40) return null
  return `/?dial=${encodeURIComponent(data.number)}`
}

/** Opens the dialer on the numbers the parent page posts, when framed. TwakePhone validates them (`?dial=`). */
export const ParentDial = () => {
  const navigate = useNavigate()
  useEffect(() => {
    if (!isFramed()) return
    const onMessage = (event: MessageEvent) => {
      const path = dialPathOf(event, window.parent)
      if (path) void navigate(path)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [navigate])
  return null
}
