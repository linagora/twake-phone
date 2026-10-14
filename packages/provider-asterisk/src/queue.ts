/** Single-consumer async queue used to expose push-style events as an AsyncIterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: ((r: IteratorResult<T>) => void) | undefined
  private closed = false

  push(item: T) {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: item, done: false })
    } else this.items.push(item)
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
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => {
          this.waiter = resolve
        })
      }
    }
  }
}
