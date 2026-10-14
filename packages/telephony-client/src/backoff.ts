/** Exponential backoff with full jitter (cahier §74). */
export const backoffDelay = (attempt: number, baseMs = 500, maxMs = 30_000, random = Math.random) =>
  Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt))
