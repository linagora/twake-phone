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
