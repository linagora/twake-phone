/** Single-consumer async queue used to expose push-style events as an AsyncIterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: ((r: IteratorResult<T>) => void) | undefined
  private closed = false
  private dropping = false

  /**
   * At most `max` items wait for the consumer: past that (a consumer stuck on a slow database), an item is
   * dropped, and `onDrop` is told once per overflow with the number dropped so far. The `droppable` ones go first
   * (a presence, which the next one replaces): the oldest waiting one makes room for a new item that is not; only
   * when none waits is the new item itself dropped.
   */
  constructor(
    private readonly max = 10_000,
    private readonly onDrop?: (dropped: number) => void,
    private readonly droppable: (item: T) => boolean = () => true
  ) {}

  /** Items dropped since the queue was created. */
  dropped = 0

  push(item: T) {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: item, done: false })
      return
    }
    if (this.items.length >= this.max) {
      this.dropped++
      if (!this.dropping) this.onDrop?.(this.dropped)
      this.dropping = true
      const victim = this.droppable(item) ? -1 : this.items.findIndex(this.droppable)
      if (victim < 0) return
      this.items.splice(victim, 1)
    }
    this.items.push(item)
  }

  close() {
    this.closed = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) {
          // Room again: the next overflow is told.
          if (this.items.length < this.max / 2) this.dropping = false
          return Promise.resolve({ value: item, done: false })
        }
        this.dropping = false
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => {
          this.waiter = resolve
        })
      }
    }
  }
}
