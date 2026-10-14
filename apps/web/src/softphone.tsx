import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Softphone, type SoftCall } from '@twake/softphone'
import { useAuth } from './auth/AuthProvider.js'
import { displayNameFor } from './auth/oidc.js'
import { useGateway } from './gateway.js'

/** 'off': this platform gives the browser no SIP session (no extension, or no SIP server yet). */
export type PhoneState = 'off' | 'connecting' | 'unregistered' | 'registered' | 'failed'

export interface Phone {
  state: PhoneState
  /** Why the registration failed or dropped, as the SIP layer said it (a status code, a reason), for the UI. */
  detail: string | null
  /** Calls not over yet, oldest first. */
  calls: SoftCall[]
  /** The last call that ended, kept a few seconds so the UI can say how it ended. */
  lastEnded: SoftCall | null
  /** Tones the far end sent by SIP INFO, per call id. */
  tones: Record<string, string>
  call(target: string): Promise<SoftCall>
}

const PhoneContext = createContext<Phone | null>(null)

const LAST_ENDED_MS = 6_000

/**
 * The page's softphone: registered on the SIP server as soon as the Gateway hands a media session, for as long as
 * the page lives. Mounted once, above the router, so navigating never drops a call.
 */
export const SoftphoneProvider = ({ children }: { children: ReactNode }) => {
  const { client, me } = useGateway()
  const { state: auth } = useAuth()
  const user = auth.status === 'signed-in' ? auth.user : null
  const displayName = displayNameFor(me, user)
  const audio = useRef<HTMLAudioElement>(null)
  const [state, setState] = useState<PhoneState>('off')
  const [detail, setDetail] = useState<string | null>(null)
  const [calls, setCalls] = useState<SoftCall[]>([])
  const [lastEnded, setLastEnded] = useState<SoftCall | null>(null)
  const [tones, setTones] = useState<Record<string, string>>({})
  const phone = useRef<Softphone | null>(null)
  const extension = me?.extension

  useEffect(() => {
    if (!extension || !audio.current) {
      setState('off')
      return
    }
    let cancelled = false
    let lastEndedTimer: ReturnType<typeof setTimeout> | undefined
    const softphone = new Softphone({
      getSession: async () => {
        const session = await client.getMediaSession()
        if (session.type !== 'sip-webrtc') throw new Error('no browser audio on this platform')
        return session
      },
      remoteAudio: audio.current,
      displayName,
      onRegistration: (s, why) => {
        if (cancelled) return
        setState(s)
        setDetail(why ?? null)
      },
      onCallChange: call => {
        if (cancelled) return
        setCalls(softphone.activeCalls())
        if (call.state === 'ended') {
          setLastEnded(call)
          clearTimeout(lastEndedTimer)
          lastEndedTimer = setTimeout(() => !cancelled && setLastEnded(null), LAST_ENDED_MS)
          setTones(t => {
            const { [call.id]: _, ...rest } = t
            return rest
          })
        }
      },
      onDtmf: (call, tone) => !cancelled && setTones(t => ({ ...t, [call.id]: (t[call.id] ?? '') + tone }))
    })
    phone.current = softphone
    setState('connecting')
    setDetail(null)
    softphone.start().catch((err: unknown) => {
      if (cancelled) return
      // No session for this user (404: no extension mapped, or no SIP server): calling is simply off.
      setState(err instanceof Error && /Gateway 404 /.test(err.message) ? 'off' : 'failed')
      setDetail(err instanceof Error ? err.message : String(err))
    })
    return () => {
      cancelled = true
      clearTimeout(lastEndedTimer)
      phone.current = null
      void softphone.stop()
      setCalls([])
      setState('off')
    }
  }, [client, extension, displayName])

  const call = useCallback(async (target: string) => {
    if (!phone.current) throw new Error('Softphone not started')
    const c = await phone.current.call(target)
    setCalls(phone.current.activeCalls())
    setLastEnded(null)
    return c
  }, [])

  const value = useMemo<Phone>(() => ({ state, detail, calls, lastEnded, tones, call }), [state, detail, calls, lastEnded, tones, call])
  // What a test can read from outside: never actions, only counters (packets, calls, tones).
  useEffect(() => {
    window.twakephone = {
      state,
      calls: calls.map(c => ({ id: c.id, direction: c.direction, state: c.state, remoteNumber: c.remoteNumber, remoteHold: c.remoteHold, muted: c.muted, renegotiating: c.renegotiating })),
      tones,
      stats: () => Promise.all(calls.map(c => c.stats()))
    }
  }, [state, calls, tones])

  return (
    <PhoneContext.Provider value={value}>
      {/* The far end's voice. Hidden: the call panel is the control. */}
      <audio ref={audio} autoPlay data-testid="remote-audio" />
      {children}
    </PhoneContext.Provider>
  )
}

export const usePhone = (): Phone => {
  const ctx = useContext(PhoneContext)
  if (!ctx) throw new Error('usePhone outside SoftphoneProvider')
  return ctx
}
