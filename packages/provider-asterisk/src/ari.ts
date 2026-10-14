// Minimal ARI client. ARI is an implementation detail of this package.

export interface AriConfig {
  url: string
  user: string
  password: string
  app: string
}

export interface AriChannel {
  id: string
  name: string
  state: string
  caller: { name: string; number: string }
  connected: { name: string; number: string }
  dialplan: { context: string; exten: string }
}

export interface AriEvent {
  type: string
  channel?: AriChannel
  /** Dial events: the calling channel (their `channel` field is absent). */
  caller?: AriChannel
  peer?: AriChannel
  args?: string[]
  cause?: number
  cause_txt?: string
  dialstatus?: string
  device_state?: { name: string; state: string }
  [key: string]: unknown
}

const backoff = (attempt: number) => Math.floor(Math.random() * Math.min(30_000, 500 * 2 ** attempt))

export class AriClient {
  constructor(private readonly config: AriConfig) {}

  private auth() {
    return 'Basic ' + Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64')
  }

  async request<T = unknown>(method: string, path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.config.url}/ari${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    const res = await fetch(url, { method, headers: { authorization: this.auth() } })
    if (!res.ok) throw Object.assign(new Error(`ARI ${method} ${path} -> ${res.status}`), { statusCode: res.status })
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  /**
   * Subscribes to every event of the application (subscribeAll) so calls that never
   * enter Stasis, e.g. plain dialplan calls, are visible too. Reconnects with backoff.
   */
  events(handlers: { onEvent(e: AriEvent): void; onUp(): void; onDown(): void }): () => void {
    let stopped = false
    let attempt = 0
    let ws: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const open = () => {
      if (stopped) return
      const url = new URL(`${this.config.url.replace(/^http/, 'ws')}/ari/events`)
      url.searchParams.set('app', this.config.app)
      url.searchParams.set('subscribeAll', 'true')
      url.searchParams.set('api_key', `${this.config.user}:${this.config.password}`)
      const socket = new WebSocket(url)
      ws = socket
      let lost = false
      // A failed attempt may emit "error" without any "close" (and a silent PBX emits neither):
      // every way a connection ends funnels here, once, and schedules exactly one retry.
      const onLost = () => {
        if (lost) return
        lost = true
        clearTimeout(connectTimer)
        handlers.onDown()
        if (!stopped) timer = setTimeout(open, backoff(attempt++))
      }
      const connectTimer = setTimeout(() => {
        onLost()
        try {
          socket.close()
        } catch {
          // already closed
        }
      }, 10_000)
      socket.onopen = () => {
        clearTimeout(connectTimer)
        attempt = 0
        handlers.onUp()
      }
      socket.onmessage = e => {
        try {
          handlers.onEvent(JSON.parse(String(e.data)) as AriEvent)
        } catch {
          // a malformed event must not kill the stream
        }
      }
      socket.onclose = onLost
      socket.onerror = onLost
    }
    open()
    return () => {
      stopped = true
      clearTimeout(timer)
      ws?.close()
    }
  }
}
