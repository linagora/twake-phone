import { backoffDelay } from '@twake/telephony-client'
import type { Presence } from '@twake/telephony-types'
import { Reloader } from './reload.js'

export interface PresencePage {
  realtime: boolean
  items: { extension: string; presence: Presence }[]
}

export interface PresenceState {
  realtime: boolean
  items: Map<string, Presence>
}

/**
 * The presence of everyone, by extension, as the app keeps it: the Gateway's list, read each time the event stream
 * is established (what was told while it was closed is lost), and the changes it tells meanwhile. A change heard
 * while a list is on its way wins over that list. One read at a time (see Reloader): a list the Gateway could not
 * give (unreachable, 5xx) is asked again with a backoff.
 */
export class PresenceSync {
  private state: PresenceState = { realtime: false, items: new Map() }
  /** Extensions told since the list on its way was asked for; null when none is. */
  private heard: Set<string> | null = null
  private stopped = false
  private readonly reloader: Reloader<PresencePage>

  constructor(
    getPresences: () => Promise<PresencePage>,
    private readonly onChange: (state: PresenceState) => void,
    delay: (attempt: number) => number = backoffDelay
  ) {
    this.reloader = new Reloader(
      () => {
        this.heard = new Set()
        return getPresences()
      },
      page => {
        const heard = this.heard ?? new Set<string>()
        this.heard = null
        const items = new Map(page.items.map(i => [i.extension, i.presence] as const))
        for (const extension of heard) {
          const presence = this.state.items.get(extension)
          if (presence) items.set(extension, presence)
        }
        this.set({ realtime: page.realtime, items })
      },
      () => {
        this.heard = null
      },
      delay
    )
  }

  /** Reads the list (again). */
  load() {
    this.reloader.request()
  }

  /** A change told by the Gateway; one heard proves it tells them as they come. */
  changed(extension: string, presence: Presence) {
    if (this.stopped) return
    this.heard?.add(extension)
    this.set({ realtime: true, items: new Map(this.state.items).set(extension, presence) })
  }

  stop() {
    this.stopped = true
    this.reloader.stop()
  }

  private set(state: PresenceState) {
    this.state = state
    this.onChange(state)
  }
}
