import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { useClient } from 'cozy-client'

import { useDialRequests } from '@/telephony/dialBridge'
import { mergeHistory, seenKey, toHistoryEntry } from '@/telephony/history'
import { createServices } from '@/telephony/services'

const PhoneContext = createContext(null)

export const usePhone = () => useContext(PhoneContext)

const FINISHED = ['ended', 'failed']
// How long after dialling an incoming call from the own extension is taken for the click-to-call leg.
const SELF_CALL_WINDOW_MS = 20_000

const fromSoft = (call, overrides) => ({
  id: call.id,
  direction: call.direction,
  remoteNumber: call.remoteNumber,
  state: call.state,
  ...overrides?.get(call.id)
})

/** Merges a call update, stamping when it started, connected and ended. */
const merge = (previous, update, now) => {
  const call = { startedAt: now, ...previous, ...update }
  if (update.state === 'connected' && !call.connectedAt) call.connectedAt = now
  if (FINISHED.includes(update.state) && !call.endedAt) call.endedAt = now
  return call
}

/**
 * Owns the connection to the Telephony Gateway: capabilities, presence, calls and,
 * when the provider offers browser audio, the softphone (media plane).
 * Call control always goes through the Gateway; the browser only carries audio.
 * `services` is injectable for tests.
 */
export const PhoneProvider = ({ services: injected, children }) => {
  const client = useClient()
  const domain = client?.getStackClient?.().uri ?? 'local'
  const audioRef = useRef(null)
  const softCalls = useRef(new Map())
  const recorded = useRef(new Set())
  const historyReload = useRef(false)
  // Click-to-call: the PBX first rings the user's own extension. Only the window that placed the call
  // answers that leg; every other window of the same person ignores it. The leg then stands for the
  // dialled party.
  const dialled = useRef(null)
  const conferenceListeners = useRef(new Set())
  const overrides = useRef(new Map())
  const ignored = useRef(new Set())
  const [state, setState] = useState({
    status: 'connecting',
    capabilities: null,
    presence: null,
    me: null,
    registration: 'unregistered',
    calls: [],
    history: [],
    seenAt: Number(localStorage.getItem(seenKey(domain)) ?? 0),
    error: null
  })
  const servicesRef = useRef(null)

  const patch = useCallback(p => setState(s => ({ ...s, ...p })), [])
  const refreshHistory = useCallback(async () => {
    try {
      const { items } = await servicesRef.current.gateway.getHistory({
        limit: 50
      })
      setState(s => ({ ...s, history: mergeHistory(s.history, items) }))
    } catch {
      // the list keeps what it has; the next call retries
    }
  }, [])
  const upsertCall = useCallback(
    update =>
      setState(s => {
        const now = Date.now()
        const known = s.calls.some(c => c.id === update.id)
        const calls = known
          ? s.calls.map(c => (c.id === update.id ? merge(c, update, now) : c))
          : [...s.calls, merge(undefined, update, now)]
        const finished = calls.find(
          c => c.id === update.id && FINISHED.includes(c.state)
        )
        if (!finished || recorded.current.has(finished.id))
          return { ...s, calls }
        recorded.current.add(finished.id)
        // Shown at once; the Gateway's own record replaces it when read back.
        const history = mergeHistory([toHistoryEntry(finished)], s.history)
        historyReload.current = true
        return { ...s, calls: calls.filter(c => c.id !== finished.id), history }
      }),
    [domain]
  )

  useEffect(() => {
    let stopEvents = () => {}
    let softphone
    let cancelled = false

    const run = async () => {
      // A copy: the ref below must not alias the injected prop.
      const services = injected
        ? { ...injected }
        : createServices({ client, remoteAudio: audioRef.current })
      servicesRef.current = services
      const { gateway } = services
      try {
        const [capabilities, presence, me] = await Promise.all([
          gateway.getCapabilities(),
          gateway.getPresence(),
          gateway.getMe()
        ])
        if (cancelled) return
        patch({ capabilities, presence, me, status: 'ready' })
        refreshHistory()

        const browserAudio = capabilities.media.browserAudio
        stopEvents = gateway.connect(event => {
          if (event.type === 'presence.changed')
            patch({ presence: event.payload.presence })
          else if (event.type.startsWith('conference.'))
            conferenceListeners.current.forEach(listener => listener(event))
          // Without browser audio the Gateway is the only source of call state.
          else if (!browserAudio && event.payload?.call)
            upsertCall(event.payload.call)
        })

        if (browserAudio) {
          softphone = services.createSoftphone({
            onRegistration: registration => patch({ registration }),
            onIncoming: call => {
              const own = me?.extension && call.remoteNumber === me.extension
              const mine =
                dialled.current &&
                Date.now() - dialled.current.at < SELF_CALL_WINDOW_MS
              if (own && !mine) {
                ignored.current.add(call.id)
                return
              }
              softCalls.current.set(call.id, call)
              if (own) {
                overrides.current.set(call.id, {
                  remoteNumber: dialled.current.target,
                  direction: 'outbound'
                })
                dialled.current = null
              }
              upsertCall(fromSoft(call, overrides.current))
              if (own) call.answer()
            },
            onCallChange: call => {
              if (!ignored.current.has(call.id))
                upsertCall(fromSoft(call, overrides.current))
            }
          })
          services.softphone = softphone
          await softphone.start()
        }
      } catch (error) {
        if (!cancelled) patch({ status: 'error', error: error.message })
      }
    }
    run()

    return () => {
      cancelled = true
      stopEvents()
      softphone?.stop()
    }
  }, [client, injected, patch, upsertCall])

  // The actions read state through refs and stable callbacks, so the dependencies listed are the ones that matter;
  // the compiler cannot prove it, hence the explicit opt-out of its memoization check.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const actions = useMemo(() => {
    // Both read refs only, so they are the same for the life of the memo.
    const gateway = () => servicesRef.current.gateway
    const soft = id => softCalls.current.get(id)
    return {
      async dial(target) {
        dialled.current = { target, at: Date.now() }
        const call = await gateway().originate(target, crypto.randomUUID())
        // In softphone mode the visible call is the browser leg created by the PBX.
        if (!state.capabilities?.media.browserAudio) upsertCall(call)
      },
      answer: id => soft(id)?.answer(),
      /** Second call while talking: park the current call, then answer. */
      async answerHolding(id, currentId) {
        await actions.hold(currentId)
        await soft(id)?.answer()
      },
      reject: id => (soft(id) ? soft(id).reject() : gateway().hangup(id)),
      hangup: id => (soft(id) ? soft(id).hangup() : gateway().hangup(id)),
      hold: id => (soft(id) ? soft(id).hold() : gateway().hold(id)),
      resume: id => (soft(id) ? soft(id).resume() : gateway().resume(id)),
      mute: (id, muted) => soft(id)?.setMuted(muted),
      dtmf: (id, tone) => soft(id)?.sendDtmf(tone),
      /** Phone access to Meet rooms. Calls go to the Gateway; events arrive on the same stream as calls. */
      conference: {
        open: slug => gateway().openConference(slug),
        create: () => gateway().createConference(),
        get: meetingId => gateway().getConference(meetingId),
        close: meetingId => gateway().closeConference(meetingId),
        invite: (meetingId, number) =>
          gateway().inviteByPhone(meetingId, number),
        remove: (meetingId, participantId) =>
          gateway().removeParticipant(meetingId, participantId),
        mute: (meetingId, participantId) =>
          gateway().muteParticipant(meetingId, participantId),
        subscribe(listener) {
          conferenceListeners.current.add(listener)
          return () => conferenceListeners.current.delete(listener)
        }
      },
      async setPresence(status) {
        patch({ presence: await gateway().setPresence(status) })
      },
      markRecentsSeen() {
        const seenAt = Date.now()
        try {
          localStorage.setItem(seenKey(domain), String(seenAt))
        } catch {
          // not persisted: the badge reappears on next load
        }
        patch({ seenAt })
      }
    }
  }, [state.capabilities, patch, upsertCall, domain])

  // Ready to place a call on behalf of another page: connected, and registered when audio is in the browser.
  const canDial =
    state.status === 'ready' &&
    (!state.capabilities?.media.browserAudio ||
      state.registration === 'registered')
  useDialRequests({ enabled: canDial, dial: actions.dial })

  const missedCount = state.history.filter(
    h => h.missed && Date.parse(h.startedAt) > state.seenAt
  ).length
  // The Gateway records a call a moment after it ends: read the list back once it has.
  const finishedCount = state.history.length
  useEffect(() => {
    if (!historyReload.current) return
    historyReload.current = false
    const id = setTimeout(refreshHistory, 1200)
    return () => clearTimeout(id)
  }, [finishedCount, refreshHistory])

  const value = useMemo(
    () => ({ ...state, missedCount, actions }),
    [state, missedCount, actions]
  )

  return (
    <PhoneContext.Provider value={value}>
      <audio ref={audioRef} autoPlay />
      {children}
    </PhoneContext.Provider>
  )
}
