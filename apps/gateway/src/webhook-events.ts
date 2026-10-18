import { createHash, randomBytes } from 'node:crypto'
import type { Call, PresenceStatus, TelephonyEvent, WebhookCall, WebhookCallOutcome, WebhookEvent } from '@twake/telephony-types'

/**
 * The identifier of an event that several Gateways may hear (each one subscribes to OpenSIPS): the same from all of
 * them, so that it is queued once per subscription (step 10a, ADR 0020). `evt_` and 32 hexadecimal characters.
 */
export const eventId = (...parts: string[]) => `evt_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)}`
/** What the events of the organisation are (a test is an administrator's, for one subscription). */
export type PublishedWebhookEvent = Exclude<WebhookEvent, { type: 'webhook.test' }>

/** An event only this Gateway tells (a test, a presence: each Gateway's tracker dates it on its own). */
export const randomEventId = () => `evt_${randomBytes(16).toString('hex')}`

const outcomeOf = (call: Call): WebhookCallOutcome => {
  if (call.connectedAt) return 'answered'
  if (call.state === 'missed') return 'missed'
  if (call.state === 'rejected') return 'declined'
  if (call.state === 'failed') return 'failed'
  return 'unanswered'
}

/**
 * The call as `userId` (at `extension`) lived it, in the public model: the two parties as numbers (`from`, `to`), the
 * times known so far, and how it ended once it did.
 */
const webhookCall = (userId: string, extension: string, call: Call, ended: boolean): WebhookCall => {
  const inbound = call.direction === 'inbound'
  const durationSec = call.connectedAt && call.endedAt ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.connectedAt)) / 1000)) : 0
  return {
    id: call.id,
    direction: call.direction,
    from: inbound ? call.remoteNumber : extension,
    to: inbound ? extension : call.remoteNumber,
    user: userId,
    extension,
    ...(call.startedAt ? { started_at: call.startedAt } : {}),
    ...(call.connectedAt ? { answered_at: call.connectedAt } : {}),
    ...(ended && call.endedAt ? { ended_at: call.endedAt } : {}),
    ...(ended ? { duration_sec: durationSec, outcome: outcomeOf(call) } : {}),
    ...(call.conference ? { conference: true as const } : {}),
    ...(call.voicemail ? { voicemail: true as const } : {}),
    source: ['opensips']
  }
}

/**
 * What the subscribers hear of a provider's event about `userId` (who holds `extension`): a call that rings, is
 * answered or ends for them (and, ended unanswered on their side without their declining it, a missed call: what
 * their Recents shows as missed); a call of their ring group that rang them and a colleague answered ends for them
 * (`answered_elsewhere`: the `call.ringing` they had is closed); nothing for the rest (a wake, a call taken by a
 * colleague that never rang them, an alert). Each call event once per call, person and type, whichever Gateway
 * tells it (eventId).
 */
export const webhookEventsFor = (tenantId: string, userId: string, extension: string, event: TelephonyEvent): PublishedWebhookEvent[] => {
  const at = event.timestamp
  const base = (type: string, callId: string) => ({ id: eventId(tenantId, type, callId, userId), occurred_at: at, tenant: tenantId })
  switch (event.type) {
    case 'call.ringing': {
      const { call } = event.payload
      return [{ ...base('call.ringing', call.id), type: 'call.ringing', call: webhookCall(userId, extension, call, false) }]
    }
    case 'call.connected': {
      const { call } = event.payload
      return [{ ...base('call.answered', call.id), type: 'call.answered', call: webhookCall(userId, extension, call, false) }]
    }
    case 'call.ended':
    case 'call.failed': {
      const { call } = event.payload
      const ended = webhookCall(userId, extension, call, true)
      const out: PublishedWebhookEvent[] = [{ ...base('call.ended', call.id), type: 'call.ended', call: ended }]
      // As the history counts it (isMissed): inbound, never answered, not declined.
      if (call.direction === 'inbound' && !call.connectedAt && call.state === 'missed') out.push({ ...base('call.missed', call.id), type: 'call.missed', call: ended })
      return out
    }
    case 'call.taken': {
      if (!event.payload.rang) return []
      const { call } = event.payload
      const ended = webhookCall(userId, extension, { ...call, endedAt: call.endedAt ?? at }, true)
      return [{ ...base('call.ended', call.id), type: 'call.ended', call: { ...ended, outcome: 'answered_elsewhere' } }]
    }
    default:
      return []
  }
}

/** A person's presence as the subscribers hear it: the status only (never their message for callers, nor its end). */
export const presenceEvent = (tenantId: string, userId: string, extension: string | undefined, status: PresenceStatus, at: string): PublishedWebhookEvent => ({
  id: randomEventId(),
  type: 'presence.changed',
  occurred_at: at,
  tenant: tenantId,
  presence: { user: userId, ...(extension ? { extension } : {}), status }
})
