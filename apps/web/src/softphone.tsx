import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Softphone, type AudioDevices, type SoftCall } from '@twake/softphone'
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
  /** Unregisters and stops the softphone, before the page leaves (sign-out): the SIP server forgets this window. */
  shutdown(): Promise<void>
  /** The person's devices, kept in this browser; applied to the calls in progress at once. */
  devices: AudioDevices
  setDevices(devices: AudioDevices): void
  /** Bumped when the browser's devices change (a headset plugged in): lists are read again. */
  devicesVersion: number
  /** The browser blocks sound until the person clicks or types on the page. */
  soundBlocked: boolean
  unblockAudio(): Promise<boolean>
  /** Rings for a moment, so the person hears where the ringtone goes. */
  ringTest(): Promise<boolean>
  /** This platform's rooms can call (a call can become a conference, step 8b). */
  conferenceAvailable: boolean
  /**
   * « Ajouter un participant » (step 8b): the call becomes a conference in a room of its own, then the room calls
   * `number`. Resolves once that number answered; the conference stays whatever becomes of that call.
   */
  addParticipant(call: SoftCall, number: string): Promise<void>
  /** The room of a conference this window made calls `number` (the third participant, or one more). */
  inviteToConference(meetingId: string, number: string): Promise<void>
  /** The room of each conference this window made, by the call that became it. */
  rooms: Record<string, string>
  /**
   * The participants each conference this window made began with, by room: the ids of the two parties of the call
   * that became it (POST /calls/:id/conference). Whoever came in later is news to this window.
   */
  parties: Record<string, string[]>
  /** The numbers each room is calling now, by room. */
  inviting: Record<string, string[]>
}

const DEVICES_KEY = 'twakephone.audio'

const readDevices = (): AudioDevices => {
  try {
    const raw = localStorage.getItem(DEVICES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const d = parsed as Record<string, unknown>
    const pick = (k: string) => (typeof d[k] === 'string' && d[k] ? { [k]: d[k] } : {})
    return { ...pick('microphoneId'), ...pick('outputId'), ...pick('ringerId') }
  } catch {
    return {}
  }
}

const storeDevices = (devices: AudioDevices) => {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify(devices))
  } catch {
    // private mode: the choice lasts for the page
  }
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
  const audioHost = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PhoneState>('off')
  const [detail, setDetail] = useState<string | null>(null)
  const [calls, setCalls] = useState<SoftCall[]>([])
  const [lastEnded, setLastEnded] = useState<SoftCall | null>(null)
  const [tones, setTones] = useState<Record<string, string>>({})
  const [devices, setDevicesState] = useState<AudioDevices>(readDevices)
  const [devicesVersion, setDevicesVersion] = useState(0)
  const [soundBlocked, setSoundBlocked] = useState(false)
  const [conferenceAvailable, setConferenceAvailable] = useState(false)
  const [rooms, setRooms] = useState<Record<string, string>>({})
  const [parties, setParties] = useState<Record<string, string[]>>({})
  const [inviting, setInviting] = useState<Record<string, string[]>>({})
  const phone = useRef<Softphone | null>(null)
  const devicesRef = useRef(devices)
  // eslint-disable-next-line react-hooks/refs -- the latest value, read by an effect without restarting it
  devicesRef.current = devices
  const extension = me?.extension
  // The name goes in the From header at registration; a change (directory synchronisation) applies at the next
  // start, never by restarting the softphone in the middle of a call.
  const nameRef = useRef(displayName)
  // eslint-disable-next-line react-hooks/refs -- the latest value, read by an effect without restarting it
  nameRef.current = displayName

  useEffect(() => {
    if (!extension || !audioHost.current) {
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
      audioContainer: audioHost.current,
      displayName: nameRef.current,
      devices: devicesRef.current,
      onAudioBlocked: blocked => !cancelled && setSoundBlocked(blocked),
      onDevicesChange: () => !cancelled && setDevicesVersion(v => v + 1),
      onRegistration: (s, why) => {
        if (cancelled) return
        setState(s)
        setDetail(why ?? null)
      },
      onCallChange: call => {
        if (cancelled) return
        setCalls(softphone.activeCalls())
        // The conference this window made is over for it: its room is no longer this window's to show.
        if (call.state === 'ended' && call.conferenceOf)
          setRooms(r => {
            const { [call.conferenceOf!]: _, ...rest } = r
            return rest
          })
        if (call.state === 'ended') {
          // A completed transfer ends two calls at once: what the person is told is that the transfer happened.
          setLastEnded(prev => (prev?.endReason === 'transferred' && call.endReason === 'hangup' && prev.endedAt && Date.now() - prev.endedAt.getTime() < LAST_ENDED_MS ? prev : call))
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
    // Whether a call can become a conference: the rooms of this platform call (step 8b).
    client
      .getCapabilities()
      .then(caps => !cancelled && setConferenceAvailable(caps.conference?.dialOut === true))
      .catch(() => undefined)
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
      setSoundBlocked(false)
      setRooms({})
      setInviting({})
      setConferenceAvailable(false)
    }
  }, [client, extension])

  const inviteToConference = useCallback(
    async (meetingId: string, number: string) => {
      setInviting(i => ({ ...i, [meetingId]: [...(i[meetingId] ?? []), number] }))
      try {
        await client.inviteByPhone(meetingId, number)
      } finally {
        setInviting(i => {
          const left = (i[meetingId] ?? []).filter(n => n !== number)
          const { [meetingId]: _, ...rest } = i
          return left.length ? { ...rest, [meetingId]: left } : rest
        })
      }
    },
    [client]
  )

  const addParticipant = useCallback(
    async (call: SoftCall, number: string) => {
      const softphone = phone.current
      if (!softphone) throw new Error('Softphone not started')
      // The token of the room's call to this window, then the Gateway makes the conference (both of us in it): the
      // call as the SIP server names it (its Call-ID), not as this window tells its calls apart.
      const join = softphone.expectConference(call.id)
      let meetingId: string
      try {
        if (!call.sipCallId) throw new Error('No Call-ID for this call')
        const made = await client.makeConference(call.sipCallId, join)
        meetingId = made.meetingId
        setParties(p => ({ ...p, [made.meetingId]: made.participants.map(participant => participant.id) }))
      } catch (err) {
        // Not waited for any more, and its room's call hung up if it was answered (the Gateway stopped between the two
        // calls of the room, third review 8b, n°5): our call is back as it was.
        softphone.cancelConference(join)
        // Ended meanwhile (the room's call refused 481, second review 8b, n°9): the error does not say it goes on.
        if (err && typeof err === 'object' && call.state === 'ended') Object.assign(err, { callOver: true })
        throw err
      }
      setRooms(r => ({ ...r, [call.id]: meetingId }))
      // The person left the room meanwhile (hung up while it began): nobody else is called at their name (review 8b, n°8).
      if (!softphone.conferenceCall(call.id)) return
      // The conference is there: what fails now is the call to the third participant only (review 8b, n°4).
      try {
        await inviteToConference(meetingId, number)
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { conferenceMade: true })
      }
    },
    [client, inviteToConference]
  )

  const call = useCallback(async (target: string) => {
    if (!phone.current) throw new Error('Softphone not started')
    const c = await phone.current.call(target)
    setCalls(phone.current.activeCalls())
    setLastEnded(null)
    return c
  }, [])

  const shutdown = useCallback(async () => {
    const softphone = phone.current
    phone.current = null
    if (!softphone) return
    await softphone.stop().catch(() => undefined)
    setCalls([])
    setState('off')
  }, [])

  const setDevices = useCallback((d: AudioDevices) => {
    setDevicesState(d)
    storeDevices(d)
    void phone.current?.setDevices(d)
  }, [])
  const unblockAudio = useCallback(async () => (phone.current ? phone.current.unblockAudio() : true), [])
  const ringTest = useCallback(async () => (phone.current ? phone.current.ringTest() : false), [])

  const value = useMemo<Phone>(
    () => ({ state, detail, calls, lastEnded, tones, call, shutdown, devices, setDevices, devicesVersion, soundBlocked, unblockAudio, ringTest, conferenceAvailable, addParticipant, inviteToConference, rooms, parties, inviting }),
    [state, detail, calls, lastEnded, tones, call, shutdown, devices, setDevices, devicesVersion, soundBlocked, unblockAudio, ringTest, conferenceAvailable, addParticipant, inviteToConference, rooms, parties, inviting]
  )
  // What a test can read from outside: never actions, only counters (packets, calls, tones).
  useEffect(() => {
    window.twakephone = {
      state,
      calls: calls.map(c => ({ id: c.id, sipCallId: c.sipCallId, direction: c.direction, state: c.state, remoteNumber: c.remoteNumber, remoteHold: c.remoteHold, muted: c.muted, renegotiating: c.renegotiating, transferring: c.transferring, conferencing: c.conferencing, ...(c.replacedCallId ? { replacedCallId: c.replacedCallId } : {}), ...(c.consultationOf ? { consultationOf: c.consultationOf } : {}), ...(c.room ? { room: c.room } : {}), ...(c.conferenceOf ? { conferenceOf: c.conferenceOf } : {}), ...(c.conferenceRoom ? { conferenceRoom: c.conferenceRoom } : {}) })),
      lastEnded: lastEnded ? { id: lastEnded.id, remoteNumber: lastEnded.remoteNumber, endReason: lastEnded.endReason, endStatus: lastEnded.endStatus, ...(lastEnded.endMessage ? { endMessage: lastEnded.endMessage } : {}), ...(lastEnded.endRefusal ? { endRefusal: lastEnded.endRefusal } : {}) } : null,
      tones,
      devices,
      soundBlocked,
      stats: () => Promise.all(calls.map(c => c.stats()))
    }
  }, [state, calls, lastEnded, tones, devices, soundBlocked])

  return (
    <PhoneContext.Provider value={value}>
      {/* The far ends' voices, one audio element per call. Hidden: the call panel is the control. */}
      <div ref={audioHost} hidden data-testid="remote-audio-host" />
      {children}
    </PhoneContext.Provider>
  )
}

export const usePhone = (): Phone => {
  const ctx = useContext(PhoneContext)
  if (!ctx) throw new Error('usePhone outside SoftphoneProvider')
  return ctx
}
