import { PIN_DIGITS } from '@twake/conference-livekit'

/** The name the Gateway gives a room without Meet (POST /conferences with `create`). */
export const GATEWAY_ROOM = /^twake-[0-9a-f]{16}$/

/**
 * The name the Gateway gives the room of a call that becomes a conference (step 8b, POST /calls/:id/conference), with
 * or without Meet: never Meet's, never a dispatch rule (nobody dials into it), nobody's but its call's.
 */
export const CALL_ROOM = /^twake-call-[0-9a-f]{16}$/

/**
 * The key and secret that sign LiveKit's webhooks (step 8b). LiveKit signs every one of its `webhook.urls` with one
 * `webhook.api_key` (third review 8b, n°3): when Meet's URL is there too, that key may be Meet's, not the Gateway's.
 * LIVEKIT_WEBHOOK_API_KEY and LIVEKIT_WEBHOOK_API_SECRET (both or neither) give it; else the Gateway's own API key.
 */
export function webhookKeyFromEnv(env: Record<string, string | undefined>): { webhookKey: string; webhookSecret: string } {
  const key = env.LIVEKIT_WEBHOOK_API_KEY
  const secret = env.LIVEKIT_WEBHOOK_API_SECRET
  if (Boolean(key) !== Boolean(secret)) throw new Error('LIVEKIT_WEBHOOK_API_KEY and LIVEKIT_WEBHOOK_API_SECRET go together')
  if (key && secret) return { webhookKey: key, webhookSecret: secret }
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET are needed')
  return { webhookKey: env.LIVEKIT_API_KEY, webhookSecret: env.LIVEKIT_API_SECRET }
}

/** What the sweep needs of the LiveKit bridge: the Gateway's dispatch rules, and deleting those of a room with a PIN. */
export interface SweptBridge {
  listDialIns(): Promise<{ meetingId: string; pin: string }[]>
  dropDialIn(meetingId: string, pin: string): Promise<void>
}

/** What the sweep needs of the store: the room's record, read again before a rule is deleted. */
export interface SweptStore {
  getConference(meetingId: string): Promise<{ pin?: string } | null>
}

/**
 * Without Meet, at start (third review n°4): deletes the dispatch rules the Gateway made that let in no room it serves
 * any more. A rule goes when its room has no record (closed while LiveKit was away), is not named by the Gateway (a
 * room claimed by its name before step 8 named them: never served again, its rule still let callers in with its PIN),
 * has a PIN shorter than PIN_DIGITS (6 digits of Math.random, before the PINs were drawn from crypto) or has another
 * PIN than the one shown (left by two Gateways drawing at once). The room's record is read again just before, so a PIN
 * written meanwhile by another Gateway keeps its rule. A room whose PIN is short gets a new one, and its rule, at the
 * next read (keepDialIn). Returns the rules deleted, as `room PIN-length` (never the PIN itself).
 */
export async function sweepDialIns(bridge: SweptBridge, store: SweptStore): Promise<string[]> {
  const dropped: string[] = []
  const seen = new Set<string>()
  for (const { meetingId, pin } of await bridge.listDialIns()) {
    const key = `${meetingId} ${pin}`
    if (seen.has(key)) continue
    seen.add(key)
    const record = await store.getConference(meetingId)
    if (record && GATEWAY_ROOM.test(meetingId) && pin.length >= PIN_DIGITS && record.pin === pin) continue
    await bridge.dropDialIn(meetingId, pin)
    dropped.push(`${meetingId} ${pin.length}`)
  }
  return dropped
}
