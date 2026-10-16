import type { Call, TelephonyEvent } from '@twake/telephony-types'
import type { HistoryEntry } from './store/types.js'

/** History entry for a call that just finished, or null for any other event. */
export const historyEntryFor = (tenantId: string, userId: string, event: TelephonyEvent): HistoryEntry | null => {
  if (event.type !== 'call.ended' && event.type !== 'call.failed') return null
  const call: Call = event.payload.call
  if (!call.remoteNumber) return null
  const startedAt = call.startedAt ?? event.timestamp
  const endedAt = call.endedAt ?? event.timestamp
  const answered = Boolean(call.connectedAt)
  const durationSec = answered ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(call.connectedAt!)) / 1000)) : 0
  return { tenantId, userId, callId: call.id, direction: call.direction, remoteNumber: call.remoteNumber, startedAt, endedAt, durationSec, state: call.state, answered, ...(call.conference ? { conference: true } : {}) }
}
