import { PIN_DIGITS } from '@twake/conference-livekit'

/** The name the Gateway gives a room without Meet (POST /conferences with `create`). */
export const GATEWAY_ROOM = /^twake-[0-9a-f]{16}$/

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
