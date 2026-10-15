import { backoffDelay } from '@twake/telephony-client'

/** A refusal (no telephony on this platform, signed out) is not asked again; an outage (network, 5xx, 429) is. */
export const isOutage = (err: unknown) => {
  const status = (err as { status?: unknown } | null)?.status
  return !(typeof status === 'number' && status < 500 && status !== 429)
}

/**
 * Reads something from the Gateway on demand, one read at a time: asked while one is on its way, it reads once
 * more after it, however many times it was asked (a burst of reconnections or of call ends costs two reads, not
 * one each). A read that fails on an outage is tried again with a backoff; asked meanwhile, it tries at once.
 */
export class Reloader<T> {
  private running = false
  private again = false
  private attempt = 0
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(
    private readonly read: () => Promise<T>,
    private readonly onResult: (value: T) => void,
    private readonly onError: (err: unknown) => void = () => undefined,
    private readonly delay: (attempt: number) => number = backoffDelay
  ) {}

  request() {
    if (this.stopped) return
    if (this.running) {
      this.again = true
      return
    }
    clearTimeout(this.timer)
    this.running = true
    this.read().then(
      value => {
        this.running = false
        if (this.stopped) return
        this.attempt = 0
        this.onResult(value)
        this.next()
      },
      (err: unknown) => {
        this.running = false
        if (this.stopped) return
        this.onError(err)
        if (this.again) return this.next()
        if (isOutage(err)) this.timer = setTimeout(() => this.request(), this.delay(this.attempt++))
      }
    )
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
  }

  private next() {
    if (!this.again) return
    this.again = false
    this.request()
  }
}
