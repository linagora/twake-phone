import type { Fetch } from './livekit-api.js'

/** A Meet room as the external API shows it to an application acting for a user. */
export interface MeetRoom {
  /** UUID; also the name of the room in LiveKit. */
  id: string
  slug: string
  name: string
  url?: string
  accessLevel?: string
  telephony?: { enabled: boolean; phoneNumber?: string; pinCode?: string; defaultCountry?: string }
}

export class MeetError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface MeetApiConfig {
  /** Meet backend reachable by the Gateway, e.g. http://visio-backend:8000 */
  url: string
  clientId: string
  clientSecret: string
  fetch?: Fetch
  now?: () => number
}

interface RawRoom {
  id: string
  slug: string
  name: string
  url?: string
  access_level?: string
  telephony?: { enabled: boolean; phone_number?: string; pin_code?: string; default_country?: string }
}

const toRoom = (r: RawRoom): MeetRoom => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  ...(r.url ? { url: r.url } : {}),
  ...(r.access_level ? { accessLevel: r.access_level } : {}),
  ...(r.telephony
    ? { telephony: { enabled: r.telephony.enabled, ...(r.telephony.phone_number ? { phoneNumber: r.telephony.phone_number } : {}), ...(r.telephony.pin_code ? { pinCode: r.telephony.pin_code } : {}), ...(r.telephony.default_country ? { defaultCountry: r.telephony.default_country } : {}) } }
    : {})
})

/**
 * Client of Meet's external API. The Gateway is a registered Meet application: it asks for a token scoped to a
 * user's email, so Meet itself decides which rooms that user may see. Nothing is trusted from the browser.
 */
export class MeetApi {
  private readonly tokens = new Map<string, { token: string; until: number }>()
  private readonly fetchFn: Fetch
  private readonly now: () => number

  constructor(private readonly config: MeetApiConfig) {
    this.fetchFn = config.fetch ?? ((u, i) => fetch(u, i))
    this.now = config.now ?? Date.now
  }

  private async request<T>(path: string, init: { method: string; token?: string; body?: unknown }): Promise<T> {
    const res = await this.fetchFn(`${this.config.url.replace(/\/$/, '')}/external-api/v1.0${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        // Meet redirects plain HTTP to HTTPS unless a proxy says the client already used it.
        'x-forwarded-proto': 'https',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {})
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })
    const text = await res.text()
    if (!res.ok) throw new MeetError(`Meet ${init.method} ${path} failed (${res.status})`, res.status)
    return (text ? JSON.parse(text) : {}) as T
  }

  /** Token acting for `email`, cached until a minute before it expires. */
  private async tokenFor(email: string): Promise<string> {
    const key = email.toLowerCase()
    const hit = this.tokens.get(key)
    if (hit && hit.until > this.now()) return hit.token
    const res = await this.request<{ access_token: string; expires_in: number }>('/application/token/', {
      method: 'POST',
      body: { client_id: this.config.clientId, client_secret: this.config.clientSecret, grant_type: 'client_credentials', scope: email }
    })
    this.tokens.set(key, { token: res.access_token, until: this.now() + Math.max(0, res.expires_in - 60) * 1000 })
    if (this.tokens.size > 1000) this.tokens.clear()
    return res.access_token
  }

  /** Calls with the user's token; a rejected cached token (restart of Meet, revoked) is replaced once. */
  private async asUser<T>(email: string, run: (token: string) => Promise<T>): Promise<T> {
    try {
      return await run(await this.tokenFor(email))
    } catch (error) {
      if (!(error instanceof MeetError) || error.status !== 401) throw error
      this.tokens.delete(email.toLowerCase())
      return run(await this.tokenFor(email))
    }
  }

  createRoom(email: string, { accessLevel }: { accessLevel?: string } = {}): Promise<MeetRoom> {
    return this.asUser(email, async token => {
      const room = toRoom(await this.request<RawRoom>('/rooms/', { method: 'POST', token, body: accessLevel ? { access_level: accessLevel } : {} }))
      // Asked for a level Meet did not give (a version that ignores it): never a room more open than asked (step 8d, ADR 0026).
      if (accessLevel && room.accessLevel !== accessLevel) throw new MeetError(`Meet made a room of access ${room.accessLevel ?? 'unknown'}, not ${accessLevel}`, 502)
      return room
    })
  }

  /** The room with this slug (or id), only if the user has access to it in Meet. */
  async findRoom(email: string, by: { slug: string } | { id: string }): Promise<MeetRoom | null> {
    const matches = (r: RawRoom) => ('slug' in by ? r.slug === by.slug : r.id === by.id)
    return this.asUser(email, async token => {
      for (let page = 1; page <= 20; page++) {
        const res = await this.request<{ results: RawRoom[]; next: string | null }>(`/rooms/?page=${page}`, { method: 'GET', token })
        const hit = res.results.find(matches)
        if (hit) return toRoom(hit)
        if (!res.next) return null
      }
      return null
    })
  }
}
