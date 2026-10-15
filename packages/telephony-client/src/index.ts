import type { Call, Capabilities, ConferenceParticipant, Contact, DialInConfiguration, MediaSession, Presence, PresenceStatus, TelephonyEvent } from '@twake/telephony-types'

export type { Contact, ContactNumber } from '@twake/telephony-types'

import { backoffDelay } from './backoff.js'

/** How long a stream the Gateway did not acknowledge must stay open to count as established. */
const ESTABLISHED_AFTER_MS = 2_000

export { formatNumber, toDialTarget, toE164 } from './phoneNumber.js'
export { backoffDelay } from './backoff.js'

export interface TelephonyClientOptions {
  baseUrl: string
  getToken: () => Promise<string>
  /** URL of the user's Cozy instance. Sent with a Cozy token so the Gateway can ask that instance who it belongs to. */
  getInstance?: () => string
}

export interface HistoryItem {
  id: string
  direction: 'inbound' | 'outbound'
  remoteNumber: string
  startedAt: string
  endedAt?: string
  durationSec: number
  state: string
  answered: boolean
  missed: boolean
}

export interface HistoryFilter {
  direction?: 'inbound' | 'outbound'
  status?: 'missed' | 'declined' | 'answered' | 'failed'
  number?: string
  from?: string
  to?: string
  limit?: number
  before?: string
}

export interface Conference {
  /** Identifier used by every conference call (the Meet room id, which is also its LiveKit room name). */
  meetingId: string
  /** Last part of the Meet link. */
  slug?: string
  url?: string
  dialIn: DialInConfiguration
  participants?: ConferenceParticipant[]
}

export interface SyncReport {
  startedAt: string
  finishedAt: string
  durationMs: number
  seen: number
  withExtension: number
  created: number
  updated: number
  unchanged: number
  removed: number
  conflicts: { userId: string; extension: string; heldBy: string }[]
  error?: string
}

export interface DirectoryAdmin {
  source: { type: string; url?: string; tenantId?: string; baseDn?: string; userFilter?: string; attributes?: Record<string, string> }
  sync: { available: boolean; running: boolean; intervalMs?: number; last?: SyncReport }
}

/** Extracts the Meet room id from a pasted link or code (abc-defg-hij). */
export const parseMeetingId = (input: string): string | null => {
  const raw = input.trim()
  if (!raw) return null
  let candidate = raw
  try {
    const url = new URL(raw)
    candidate = url.pathname.split('/').filter(Boolean).pop() ?? ''
  } catch {}
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(candidate) ? candidate : null
}

export class TelephonyClient {
  constructor(private readonly options: TelephonyClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.options.baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.options.getToken()}`,
        ...(this.options.getInstance ? { 'x-cozy-instance': this.options.getInstance() } : {}),
        ...init.headers
      }
    })
    if (!res.ok) throw Object.assign(new Error(`Gateway ${res.status} on ${path}`), { status: res.status })
    if (res.status === 204) {
      // Drain the empty body: a response left unread shows up as an aborted request in the browser.
      await res.text()
      return undefined as T
    }
    return (await res.json()) as T
  }

  getMe() {
    return this.request<{ id: string; displayName: string; extension?: string; features?: { directory?: boolean; admin?: boolean } }>('/me')
  }

  /** The directory source and its synchronisation, for administrators (403 otherwise; 501 without a directory). */
  getDirectoryAdmin() {
    return this.request<DirectoryAdmin>('/admin/directory')
  }

  /** Starts copying the directory's accounts into the user ↔ extension mappings (409: already running); follow it with getDirectoryAdmin. */
  syncDirectory() {
    return this.request<DirectoryAdmin['sync']>('/admin/directory/sync', { method: 'POST' })
  }

  getMediaSession() {
    return this.request<MediaSession>('/me/media-session')
  }

  hangup(callId: string) {
    return this.action(callId, 'hangup')
  }

  hold(callId: string) {
    return this.action(callId, 'hold')
  }

  resume(callId: string) {
    return this.action(callId, 'resume')
  }

  private async action(callId: string, name: string) {
    await this.request<void>(`/calls/${callId}/${name}`, { method: 'POST' })
  }

  async getHistory(filter: HistoryFilter = {}) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params.set(k, String(v))
    const qs = params.toString()
    return this.request<{ items: HistoryItem[]; next?: string }>(`/calls/history${qs ? `?${qs}` : ''}`)
  }

  getCapabilities() {
    return this.request<Capabilities>('/capabilities')
  }

  /** People matching the words of `q` in the organisation's directory (`truncated`: refine the search). 501: no directory. */
  searchDirectory(q: string, limit = 20) {
    return this.request<{ items: Contact[]; truncated: boolean }>(`/directory?${new URLSearchParams({ q, limit: String(limit) })}`)
  }

  getContact(id: string) {
    return this.request<Contact>(`/directory/${encodeURIComponent(id)}`)
  }

  getFavorites() {
    return this.request<{ items: Contact[] }>('/me/favorites')
  }

  async addFavorite(id: string) {
    await this.request<void>(`/me/favorites/${encodeURIComponent(id)}`, { method: 'PUT' })
  }

  async removeFavorite(id: string) {
    await this.request<void>(`/me/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  getPresence() {
    return this.request<Presence>('/me/presence')
  }

  /** The presence of everyone in the organisation, by extension; `realtime` false: the platform does not tell it. */
  getPresences() {
    return this.request<{ realtime: boolean; items: { extension: string; userId: string; presence: Presence }[] }>('/presence')
  }

  setPresence(status: PresenceStatus) {
    return this.request<Presence>('/me/presence', { method: 'PUT', body: JSON.stringify({ status }) })
  }

  originate(target: string, idempotencyKey: string) {
    return this.request<Call>('/calls', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ target })
    })
  }

  /** Opens the phone panel of a Meet room the user can access, given the slug of its link. */
  openConference(slug: string) {
    return this.request<Conference>('/conferences', { method: 'POST', body: JSON.stringify({ slug }) })
  }

  /** Creates a new Meet room owned by the user and opens its phone panel. */
  createConference() {
    return this.request<Conference>('/conferences', { method: 'POST', body: JSON.stringify({ create: true }) })
  }

  getConference(meetingId: string) {
    return this.request<Conference>(`/conferences/${encodeURIComponent(meetingId)}`)
  }

  closeConference(meetingId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}`, { method: 'DELETE' })
  }

  /** Dial-out: makes the phone ring and joins the room when answered. */
  inviteByPhone(meetingId: string, number: string) {
    return this.request<ConferenceParticipant>(`/conferences/${encodeURIComponent(meetingId)}/participants`, { method: 'POST', body: JSON.stringify({ number }) })
  }

  removeParticipant(meetingId: string, participantId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}`, { method: 'DELETE' })
  }

  muteParticipant(meetingId: string, participantId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}/mute`, { method: 'POST' })
  }

  /**
   * Opens the event stream and keeps it open (exponential backoff + jitter). A browser cannot send headers on a
   * WebSocket, so each attempt first trades the credentials for a single-use ticket over an authenticated call.
   * `onOpen` runs each time the stream is established, the first time and after each reconnection: what was told
   * while it was closed is lost, so that is when to read the state again. Established means the Gateway accepted
   * the session (its first message, `stream.ready`) or kept it open for a while: a socket it closes right after
   * the upgrade (its directory or database down) is a failed attempt, and the next one waits longer. `onClose`
   * runs when an established stream closes. Returns a function that stops it.
   */
  connect(onEvent: (event: TelephonyEvent) => void, { onOpen, onClose }: { onOpen?: () => void; onClose?: () => void } = {}): () => void {
    let stopped = false
    let attempt = 0
    let ws: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settle: ReturnType<typeof setTimeout> | undefined
    let established = false
    const establish = () => {
      clearTimeout(settle)
      if (established || stopped) return
      established = true
      attempt = 0
      onOpen?.()
    }

    const open = async () => {
      if (stopped) return
      try {
        const { ticket } = await this.request<{ ticket: string }>('/ws-ticket', { method: 'POST' })
        const url = new URL(`${this.options.baseUrl}/api/v1/ws`)
        url.protocol = url.protocol.replace('http', 'ws')
        url.searchParams.set('ticket', ticket)
        ws = new WebSocket(url)
      } catch {
        return retry()
      }
      established = false
      // A Gateway that does not say `stream.ready` (an older one): open for a while is accepted.
      ws.onopen = () => {
        settle = setTimeout(establish, ESTABLISHED_AFTER_MS)
      }
      ws.onmessage = e => {
        establish()
        const message = JSON.parse(String(e.data)) as TelephonyEvent | { type: 'stream.ready' }
        if (message.type !== 'stream.ready') onEvent(message)
      }
      ws.onclose = () => {
        clearTimeout(settle)
        if (established && !stopped) onClose?.()
        established = false
        retry()
      }
    }
    const retry = () => {
      if (stopped) return
      timer = setTimeout(open, backoffDelay(attempt++))
    }

    void open()
    return () => {
      stopped = true
      clearTimeout(timer)
      clearTimeout(settle)
      ws?.close()
    }
  }
}
