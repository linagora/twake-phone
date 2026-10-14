const MAX = 50

/** Last read position of the missed-calls badge, kept per instance in this browser. */
export const seenKey = domain => `twake-phone:seen:${domain}`

/** Newest first, one entry per call id, server entries winning over optimistic local ones. */
export const mergeHistory = (local, server) => {
  const seen = new Set()
  return [...server, ...local]
    .filter(e => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, MAX)
}

/** Entry shown immediately when a call finishes, before the Gateway's own record is read back. */
export const toHistoryEntry = call => {
  const answered = Boolean(call.connectedAt)
  return {
    id: call.id,
    direction: call.direction,
    remoteNumber: call.remoteNumber,
    startedAt: new Date(call.startedAt).toISOString(),
    durationSec: answered
      ? Math.max(
          0,
          Math.round(((call.endedAt ?? Date.now()) - call.connectedAt) / 1000)
        )
      : 0,
    missed: call.direction === 'inbound' && !answered,
    answered
  }
}
