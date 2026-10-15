import { backoffDelay } from '@twake/telephony-client'
import type { Presence } from '@twake/telephony-types'

export interface PresencePage {
  realtime: boolean
  items: { extension: string; presence: Presence }[]
}

export interface PresenceState {
  realtime: boolean
  items: Map<string, Presence>
}

/**
 * The presence of everyone, by extension, as the app keeps it: the Gateway's list, read at start and again each
 * time the event stream (re)opens (what was told while it was closed is lost), and the changes it tells meanwhile.
 * A change heard while a list is on its way wins over that list. A list the Gateway could not give (unreachable,
 * 5xx) is asked again with a backoff.
 */
export class PresenceSync {
  private state: PresenceState = { realtime: false, items: new Map() }
  /** Extensions told since the list on its way was asked for; null when none is. */
  private heard: Set<string> | null = null
  private attempt = 0
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(
    private readonly getPresences: () => Promise<PresencePage>,
    private readonly onChange: (state: PresenceState) => void,
    private readonly delay: (attempt: number) => number = backoffDelay
  ) {}

  /** Reads the list (again). */
  load() {
    if (this.stopped) return
    clearTimeout(this.timer)
    const heard = new Set<string>()
    this.heard = heard
    this.getPresences().then(
      page => {
        // Stopped, or a newer read is on its way: this one is stale.
        if (this.stopped || this.heard !== heard) return
        this.heard = null
        this.attempt = 0
        const items = new Map(page.items.map(i => [i.extension, i.presence] as const))
        for (const extension of heard) {
          const presence = this.state.items.get(extension)
          if (presence) items.set(extension, presence)
        }
        this.set({ realtime: page.realtime, items })
      },
      (err: unknown) => {
        if (this.stopped || this.heard !== heard) return
        // A refusal (no telephony on this platform, signed out) is not asked again; an outage is.
        const status = (err as { status?: unknown } | null)?.status
        if (typeof status === 'number' && status < 500 && status !== 429) {
          this.heard = null
          return
        }
        this.timer = setTimeout(() => this.load(), this.delay(this.attempt++))
      }
    )
  }

  /** A change told by the Gateway; one heard proves it tells them as they come. */
  changed(extension: string, presence: Presence) {
    if (this.stopped) return
    this.heard?.add(extension)
    this.set({ realtime: true, items: new Map(this.state.items).set(extension, presence) })
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
  }

  private set(state: PresenceState) {
    this.state = state
    this.onChange(state)
  }
}
