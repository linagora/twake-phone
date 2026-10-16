import { describe, expect, it } from 'vitest'
import { WEBHOOK_STATE_ROLE, type HistoryEntry, type Store, type WebhookSubscriptionRecord } from './types.js'
import { EMPTY_OUTBOUND, outboundVersion } from '../outbound.js'

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  tenantId: 'A', userId: 'alice', callId: 'c1', direction: 'outbound', remoteNumber: '+33612345678',
  startedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:01:00.000Z', durationSec: 60, state: 'ended', answered: true, ...over
})

/** Behaviour every Store must have, in particular the isolation between tenants. */
export const storeContract = (name: string, make: () => Promise<Store>) =>
  describe(`${name} store contract`, () => {
    it('keeps provider configs and upserts per tenant and site', async () => {
      const s = await make()
      await s.upsertProvider({ tenantId: 'A', type: 'opensips', config: { mi: { host: 'x' } } })
      await s.upsertProvider({ tenantId: 'A', type: 'opensips', config: { mi: { host: 'y' } } })
      await s.upsertProvider({ tenantId: 'B', type: 'opensips', config: { mi: { host: 'z' } } })
      const all = await s.listProviders()
      expect(all).toHaveLength(2)
      expect(all.find(p => p.tenantId === 'A')?.config).toEqual({ mi: { host: 'y' } })
      await s.close()
    })

    it('maps users and extensions inside a tenant only', async () => {
      const s = await make()
      await s.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101' })
      await s.upsertMapping({ tenantId: 'B', userId: 'alice', extension: '101' }) // same numbers are fine across tenants
      expect((await s.getMappingByUser('A', 'alice'))?.extension).toBe('101')
      expect((await s.getMappingByExtension('B', '101'))?.tenantId).toBe('B')
      expect(await s.getMappingByUser('C', 'alice')).toBeNull()
      await expect(s.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '101' })).rejects.toThrow()
      await s.close()
    })

    it('lists and deletes mappings per tenant, keeping department, source and sync time', async () => {
      const s = await make()
      await s.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101' })
      await s.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '102', displayName: 'Bob', department: 'Support', source: 'ldap', syncedAt: '2026-10-14T10:00:00.000Z' })
      await s.upsertMapping({ tenantId: 'B', userId: 'carol', extension: '101' })
      const a = await s.listMappings('A')
      expect(a.map(m => m.userId)).toEqual(['alice', 'bob'])
      expect(a[0]?.source ?? 'manual').toBe('manual')
      expect(a[1]).toMatchObject({ extension: '102', displayName: 'Bob', department: 'Support', source: 'ldap', syncedAt: '2026-10-14T10:00:00.000Z' })
      await s.deleteMapping('A', 'alice')
      await s.deleteMapping('A', 'nobody')
      expect((await s.listMappings('A')).map(m => m.userId)).toEqual(['bob'])
      expect(await s.getMappingByUser('A', 'alice')).toBeNull()
      expect((await s.listMappings('B')).map(m => m.userId)).toEqual(['carol'])
      // The extension freed by the delete can be taken by someone else.
      await s.upsertMapping({ tenantId: 'A', userId: 'dave', extension: '101' })
      await s.close()
    })

    it('keeps favourites per tenant and user, in the order they were added, without duplicates', async () => {
      const s = await make()
      await s.addFavorite('A', 'alice', 'jdupont')
      await s.addFavorite('A', 'alice', 'bdurand')
      await s.addFavorite('A', 'alice', 'jdupont')
      await s.addFavorite('A', 'bob', 'jdupont')
      await s.addFavorite('B', 'alice', 'cmartin')
      expect(await s.listFavorites('A', 'alice')).toEqual(['jdupont', 'bdurand'])
      expect(await s.listFavorites('A', 'bob')).toEqual(['jdupont'])
      expect(await s.listFavorites('B', 'alice')).toEqual(['cmartin'])
      expect(await s.listFavorites('C', 'alice')).toEqual([])
      await s.removeFavorite('A', 'alice', 'jdupont')
      await s.removeFavorite('A', 'alice', 'nobody')
      expect(await s.listFavorites('A', 'alice')).toEqual(['bdurand'])
      expect(await s.listFavorites('A', 'bob')).toEqual(['jdupont'])
      await s.close()
    })

    it('never shows the history of another tenant or another user', async () => {
      const s = await make()
      await s.addHistory(entry({ callId: 'a1' }))
      await s.addHistory(entry({ tenantId: 'B', callId: 'b1' }))
      await s.addHistory(entry({ userId: 'bob', callId: 'a2' }))
      expect((await s.listHistory('A', 'alice')).items.map(e => e.callId)).toEqual(['a1'])
      expect((await s.listHistory('B', 'alice')).items.map(e => e.callId)).toEqual(['b1'])
      expect((await s.listHistory('C', 'alice')).items).toEqual([])
      await s.close()
    })

    it('keeps whether a call was a conference\'s (step 8b), and only then says so', async () => {
      const s = await make()
      await s.addHistory(entry({ callId: 'conf', conference: true, direction: 'inbound', remoteNumber: '101' }))
      await s.addHistory(entry({ callId: 'plain', startedAt: '2026-10-05T09:00:00.000Z' }))
      const { items } = await s.listHistory('A', 'alice')
      expect(items.map(e => [e.callId, e.conference])).toEqual([
        ['conf', true],
        ['plain', undefined]
      ])
      await s.close()
    })

    it('is idempotent on the call id', async () => {
      const s = await make()
      await s.addHistory(entry({}))
      await s.addHistory(entry({ durationSec: 999 }))
      const { items } = await s.listHistory('A', 'alice')
      expect(items).toHaveLength(1)
      expect(items[0]!.durationSec).toBe(60)
      await s.close()
    })

    it('does not count an inbound call the user declined as missed, and lists the declined ones apart', async () => {
      const s = await make()
      await s.addHistory(entry({ callId: 'declined', direction: 'inbound', answered: false, durationSec: 0, state: 'rejected', remoteNumber: '102' }))
      await s.addHistory(entry({ callId: 'missed', direction: 'inbound', answered: false, durationSec: 0, state: 'missed', remoteNumber: '103', startedAt: '2026-10-05T11:00:00.000Z' }))
      // Refused by the callee, seen from the caller: not one this user declined.
      await s.addHistory(entry({ callId: 'refused', direction: 'outbound', answered: false, durationSec: 0, state: 'rejected', remoteNumber: '104', startedAt: '2026-10-05T12:00:00.000Z' }))
      expect((await s.listHistory('A', 'alice', { status: 'missed' })).items.map(e => e.callId)).toEqual(['missed'])
      expect((await s.listHistory('A', 'alice', { status: 'declined' })).items.map(e => e.callId)).toEqual(['declined'])
      await s.close()
    })

    it('filters and paginates, newest first', async () => {
      const s = await make()
      await s.addHistory(entry({ callId: '1', startedAt: '2026-10-05T08:00:00.000Z' }))
      await s.addHistory(entry({ callId: '2', direction: 'inbound', answered: false, durationSec: 0, state: 'missed', startedAt: '2026-10-05T09:00:00.000Z', remoteNumber: '102' }))
      await s.addHistory(entry({ callId: '3', direction: 'inbound', startedAt: '2026-10-05T10:00:00.000Z', remoteNumber: '103' }))
      expect((await s.listHistory('A', 'alice')).items.map(e => e.callId)).toEqual(['3', '2', '1'])
      expect((await s.listHistory('A', 'alice', { status: 'missed' })).items.map(e => e.callId)).toEqual(['2'])
      expect((await s.listHistory('A', 'alice', { direction: 'inbound', status: 'answered' })).items.map(e => e.callId)).toEqual(['3'])
      expect((await s.listHistory('A', 'alice', { number: '102' })).items.map(e => e.callId)).toEqual(['2'])
      expect((await s.listHistory('A', 'alice', { number: '%' })).items).toEqual([]) // wildcard is not interpreted
      const first = await s.listHistory('A', 'alice', { limit: 2 })
      expect(first.items.map(e => e.callId)).toEqual(['3', '2'])
      const second = await s.listHistory('A', 'alice', { limit: 2, before: first.next })
      expect(second.items.map(e => e.callId)).toEqual(['1'])
      expect(second.next).toBeUndefined()
      await s.close()
    })

    it('deletes the history of one user only', async () => {
      const s = await make()
      await s.addHistory(entry({ callId: 'a1' }))
      await s.addHistory(entry({ tenantId: 'B', callId: 'b1' }))
      expect(await s.deleteHistory('A', 'alice')).toBe(1)
      expect((await s.listHistory('A', 'alice')).items).toEqual([])
      expect((await s.listHistory('B', 'alice')).items).toHaveLength(1)
      await s.close()
    })

    it('keeps the presence each user chose, per tenant and user, and forgets one whose end has passed', async () => {
      const s = await make()
      const later = new Date(Date.now() + 3_600_000).toISOString()
      const past = new Date(Date.now() - 1_000).toISOString()
      await s.setUserPresence({ tenantId: 'A', userId: 'alice', status: 'dnd', since: '2026-10-15T09:00:00.000Z', until: later, message: 'En réunion' })
      await s.setUserPresence({ tenantId: 'A', userId: 'bob', status: 'away', since: '2026-10-15T09:00:00.000Z' })
      await s.setUserPresence({ tenantId: 'A', userId: 'carol', status: 'dnd', since: '2026-10-15T09:00:00.000Z', until: past })
      await s.setUserPresence({ tenantId: 'B', userId: 'alice', status: 'away', since: '2026-10-15T09:00:00.000Z' })
      expect(await s.getUserPresence('A', 'alice')).toEqual({ tenantId: 'A', userId: 'alice', status: 'dnd', since: '2026-10-15T09:00:00.000Z', until: later, message: 'En réunion' })
      expect(await s.getUserPresence('A', 'carol')).toBeNull()
      expect((await s.listUserPresences('A')).map(p => `${p.userId}:${p.status}`)).toEqual(['alice:dnd', 'bob:away'])
      // A new choice replaces the old one entirely (no end, no message left behind).
      await s.setUserPresence({ tenantId: 'A', userId: 'alice', status: 'away', since: '2026-10-15T10:00:00.000Z' })
      expect(await s.getUserPresence('A', 'alice')).toEqual({ tenantId: 'A', userId: 'alice', status: 'away', since: '2026-10-15T10:00:00.000Z' })
      await s.deleteUserPresence('A', 'alice')
      expect(await s.getUserPresence('A', 'alice')).toBeNull()
      expect((await s.getUserPresence('B', 'alice'))?.status).toBe('away')
      await s.close()
    })

    it('stores SIP secrets per tenant and user', async () => {
      const s = await make()
      await s.setSipSecret('A', 'alice', 'enc1')
      await s.setSipSecret('B', 'alice', 'enc2')
      expect((await s.getSipSecret('A', 'alice'))?.secretEnc).toBe('enc1')
      expect((await s.getSipSecret('B', 'alice'))?.secretEnc).toBe('enc2')
      expect(await s.getSipSecret('C', 'alice')).toBeNull()
      await s.close()
    })

    it('lets the first user claim a meeting and keeps the owner afterwards', async () => {
      const s = await make()
      const base = { meetingId: 'abc-defg', createdAt: '2026-10-05T10:00:00.000Z' }
      const a = await s.claimConference({ ...base, tenantId: 'A', ownerUserId: 'alice' })
      const b = await s.claimConference({ ...base, tenantId: 'B', ownerUserId: 'mallory' })
      expect(a.ownerUserId).toBe('alice')
      expect(b).toMatchObject({ tenantId: 'A', ownerUserId: 'alice' })
      await s.setConferencePin('abc-defg', '123456')
      expect((await s.getConference('abc-defg'))?.pin).toBe('123456')
      await s.setConferencePin('abc-defg', null)
      expect((await s.getConference('abc-defg'))?.pin).toBeUndefined()
      // A PIN replaced only if it is still the one read (third review n°5).
      expect(await s.replaceConferencePin('abc-defg', null, '0123456789')).toBe(true)
      expect(await s.replaceConferencePin('abc-defg', null, '9876543210')).toBe(false)
      expect(await s.replaceConferencePin('abc-defg', '123456', '9876543210')).toBe(false)
      expect((await s.getConference('abc-defg'))?.pin).toBe('0123456789')
      expect(await s.replaceConferencePin('abc-defg', '0123456789', '1111111111')).toBe(true)
      expect((await s.getConference('abc-defg'))?.pin).toBe('1111111111')
      expect(await s.replaceConferencePin('nope', null, '1')).toBe(false)
      // Counted per tenant, and per owner in it.
      await s.claimConference({ meetingId: 'second', createdAt: base.createdAt, tenantId: 'A', ownerUserId: 'bob' })
      await s.claimConference({ meetingId: 'third', createdAt: base.createdAt, tenantId: 'B', ownerUserId: 'alice' })
      expect([await s.countConferences('A'), await s.countConferences('A', 'alice'), await s.countConferences('A', 'carol'), await s.countConferences('B')]).toEqual([2, 1, 0, 1])
      // Listed per owner in their tenant, oldest first (step 8b: the Gateway closes the calls' rooms LiveKit ended).
      await s.claimConference({ meetingId: 'fourth', createdAt: '2026-01-01T00:00:00.000Z', tenantId: 'A', ownerUserId: 'alice' })
      expect((await s.listConferences('A', 'alice')).map(c => c.meetingId)).toEqual(['fourth', 'abc-defg'])
      expect(await s.listConferences('A', 'carol')).toEqual([])
      expect((await s.listConferences('B', 'alice')).map(c => c.meetingId)).toEqual(['third'])
      await s.deleteConference('fourth')
      await s.deleteConference('abc-defg')
      expect(await s.getConference('abc-defg')).toBeNull()
      await s.close()
    })

    it('keeps push subscriptions per tenant and user, one per endpoint: a browser given to someone else moves to them', async () => {
      const s = await make()
      const sub = (tenantId: string, userId: string, endpoint: string, createdAt: string) => ({ tenantId, userId, endpoint, p256dh: 'BKey', auth: 'secret', createdAt })
      expect(await s.savePushSubscription(sub('A', 'jean', 'https://push.example.test/1', '2026-10-15T10:00:00.000Z'))).toEqual({ outcome: 'added' })
      expect(await s.savePushSubscription(sub('A', 'jean', 'https://push.example.test/2', '2026-10-15T09:00:00.000Z'))).toEqual({ outcome: 'added' })
      expect(await s.savePushSubscription(sub('B', 'jean', 'https://push.example.test/3', '2026-10-15T10:00:00.000Z'))).toEqual({ outcome: 'added' })
      expect((await s.listPushSubscriptions('A', 'jean')).map(r => r.endpoint)).toEqual(['https://push.example.test/2', 'https://push.example.test/1'])
      expect(await s.listPushSubscriptions('A', 'jean')).toContainEqual(sub('A', 'jean', 'https://push.example.test/1', '2026-10-15T10:00:00.000Z'))
      expect(await s.listPushUsers('A')).toEqual(['jean'])
      // Known already: nothing written (its date stays).
      expect(await s.savePushSubscription(sub('A', 'jean', 'https://push.example.test/1', '2026-10-15T12:00:00.000Z'))).toEqual({ outcome: 'unchanged' })
      expect((await s.listPushSubscriptions('A', 'jean')).find(r => r.endpoint === 'https://push.example.test/1')?.createdAt).toBe('2026-10-15T10:00:00.000Z')
      // New keys for the same browser.
      expect(await s.savePushSubscription({ ...sub('A', 'jean', 'https://push.example.test/2', '2026-10-15T09:30:00.000Z'), auth: 'other' })).toEqual({ outcome: 'updated' })
      expect((await s.listPushSubscriptions('A', 'jean')).find(r => r.endpoint === 'https://push.example.test/2')?.auth).toBe('other')
      // Another tenant cannot take it: refused, nothing written.
      expect(await s.savePushSubscription(sub('B', 'mallory', 'https://push.example.test/1', '2026-10-15T11:00:00.000Z'))).toEqual({ outcome: 'refused' })
      expect((await s.listPushSubscriptions('A', 'jean')).map(r => r.endpoint)).toContain('https://push.example.test/1')
      expect(await s.listPushUsers('B')).toEqual(['jean'])
      // Another person of the tenant signs in on Jean's browser: it is theirs now.
      expect(await s.savePushSubscription(sub('A', 'paul', 'https://push.example.test/1', '2026-10-15T11:00:00.000Z'))).toEqual({ outcome: 'moved', previousUserId: 'jean' })
      expect((await s.listPushSubscriptions('A', 'jean')).map(r => r.endpoint)).toEqual(['https://push.example.test/2'])
      expect(await s.listPushUsers('A')).toEqual(['jean', 'paul'])
      // Only one's own, inside one's tenant.
      expect(await s.deletePushSubscription('A', 'jean', 'https://push.example.test/1')).toBe(false)
      expect(await s.deletePushSubscription('A', 'jean', 'https://push.example.test/3')).toBe(false)
      expect(await s.deletePushSubscription('A', 'jean', 'https://push.example.test/2')).toBe(true)
      expect(await s.listPushUsers('A')).toEqual(['paul'])
      // Gone at its push service: removed whoever had it.
      expect(await s.deletePushEndpoint('https://push.example.test/3')).toEqual({ tenantId: 'B', userId: 'jean' })
      expect(await s.deletePushEndpoint('https://push.example.test/3')).toBeNull()
      expect(await s.listPushUsers('B')).toEqual([])
      await s.close()
    })

    it('keeps the outbound rules of each tenant whole (step 6b)', async () => {
      const s = await make()
      expect(await s.getOutbound('A')).toBeNull()
      const rules = { tenantId: 'A', policy: { defaultProfile: 'internal', caps: { concurrent: 4 } }, profiles: [{ id: 'internal', allowed: [] }, { id: 'national', allowed: ['fixed' as const], caps: { dailyMinutes: 60 } }], assignments: [{ userId: 'alice', profileId: 'national' }] }
      await s.setOutbound(rules)
      await s.setOutbound({ tenantId: 'B', policy: {}, profiles: [], assignments: [] })
      expect(await s.getOutbound('A')).toEqual(rules)
      await s.setOutbound({ ...rules, assignments: [] })
      expect((await s.getOutbound('A'))?.assignments).toEqual([])
      expect((await s.getOutbound('B'))?.profiles).toEqual([])
      await s.close()
    })

    it('replaces the outbound rules only if they are still the version they were read at, two writers at once included (review 7 bis, n°2)', async () => {
      const s = await make()
      const empty = outboundVersion(EMPTY_OUTBOUND)
      const one = { tenantId: 'C', policy: { caps: { concurrent: 1 } }, profiles: [], assignments: [] }
      const two = { tenantId: 'C', policy: { caps: { concurrent: 2 } }, profiles: [], assignments: [] }
      // Two changes made from the same version (nothing kept yet), at once: one is kept, the other refused.
      const results = await Promise.allSettled([s.setOutbound(one, empty), s.setOutbound(two, empty)])
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409, code: 'OUTBOUND_STALE' } })
      const kept = (await s.getOutbound('C'))!
      const version = outboundVersion(kept)
      // Then from the version kept: twice at once again, one of them.
      const again = await Promise.allSettled([s.setOutbound({ ...one, policy: { caps: { concurrent: 4 } } }, version), s.setOutbound({ ...two, policy: { caps: { concurrent: 5 } } }, version)])
      expect(again.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect(await s.setOutbound(one, 'not-the-version').catch((err: unknown) => err)).toMatchObject({ code: 'OUTBOUND_STALE' })
      // Without a version: replaced, whatever it is.
      await s.setOutbound(one)
      expect((await s.getOutbound('C'))?.policy).toEqual({ caps: { concurrent: 1 } })
      await s.close()
    })

    it('hands the SIP server a change only once checked, in the turn of the rules, and hands back what is kept when it fails (review 7 ter, n°5, 9)', async () => {
      const s = await make()
      const handed: [unknown, boolean][] = []
      const hand = (fail = false) => async (rules: { policy: unknown }, undo: boolean) => {
        handed.push([rules.policy, undo])
        if (fail && !undo) throw new Error('OpenSIPS did not reload')
      }
      const one = { tenantId: 'D', policy: { caps: { concurrent: 1 } }, profiles: [], assignments: [] }
      const two = { tenantId: 'D', policy: { caps: { concurrent: 2 } }, profiles: [], assignments: [] }
      const empty = outboundVersion(EMPTY_OUTBOUND)
      // Two at once from one version: the refused one is never handed.
      const results = await Promise.allSettled([s.setOutbound(one, empty, hand()), s.setOutbound(two, empty, hand())])
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect(handed).toHaveLength(1)
      expect(handed[0]![0]).toEqual((await s.getOutbound('D'))!.policy)
      const kept = (await s.getOutbound('D'))!.policy
      // The SIP server refusing: nothing kept, it gets back what is.
      handed.length = 0
      const refused = await s.setOutbound({ ...one, policy: { caps: { concurrent: 9 } } }, undefined, hand(true)).catch((err: unknown) => err)
      expect(refused).toMatchObject({ message: 'OpenSIPS did not reload' })
      expect(handed).toEqual([
        [{ caps: { concurrent: 9 } }, false],
        [kept, true]
      ])
      expect((await s.getOutbound('D'))!.policy).toEqual(kept)
      // A script (no version) waits for the turn too: a change made meanwhile from what was read before is refused.
      const before = outboundVersion((await s.getOutbound('D'))!)
      let release: () => void = () => undefined
      const slow = async () => new Promise<void>(resolve => (release = resolve))
      const script = s.setOutbound({ ...one, policy: { caps: { concurrent: 7 } } }, undefined, slow)
      await new Promise(resolve => setTimeout(resolve, 50))
      const screen = s.setOutbound({ ...one, policy: { caps: { concurrent: 8 } } }, before)
      await new Promise(resolve => setTimeout(resolve, 50))
      release()
      await script
      expect(await screen.catch((err: unknown) => err)).toMatchObject({ code: 'OUTBOUND_STALE' })
      expect((await s.getOutbound('D'))!.policy).toEqual({ caps: { concurrent: 7 } })
      // What is kept, held: none written meanwhile.
      let seen: unknown
      let hold: () => void = () => undefined
      const held = s.holdOutbound('D', async rules => {
        seen = rules.policy
        await new Promise<void>(resolve => (hold = resolve))
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      let written = false
      const writing = s.setOutbound(one).then(() => (written = true))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(written).toBe(false)
      hold()
      await held
      await writing
      expect(seen).toEqual({ caps: { concurrent: 7 } })
      expect(written).toBe(true)
      await s.close()
    })

    it('keeps one alert while it repeats (count, last time, first and last words), a new one after an hour of silence, per tenant, the latest repeated first (review 6b, n°7; second review, n°8)', async () => {
      const s = await make()
      const alert = { kind: 'limit' as const, param: 'concurrent', scope: 'user' as const, extension: '101', number: '+33199000201' }
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T10:00:00.000Z', alert })
      // The same one 30 and 80 minutes later (each within an hour of the one before): counted in it, its last words kept.
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T10:30:00.000Z', alert: { ...alert, number: '+33199000202' } })
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T11:20:00.000Z', alert })
      await s.addAlert({ tenantId: 'B', at: '2026-10-15T10:31:00.000Z', alert })
      // Another extension, another param, another kind: other alerts.
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T10:40:00.000Z', alert: { ...alert, extension: '102' } })
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T10:41:00.000Z', alert: { ...alert, param: 'dailyMinutes' } })
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T10:42:00.000Z', alert: { kind: 'rights', param: 'international', scope: 'user', extension: '101' } })
      // Past an hour of silence: a new one.
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T12:30:00.000Z', alert })
      const a = await s.listAlerts('A', { limit: 10 })
      // By their last repeat: the one opened first but repeated at 11:20 comes before those of 10:40 to 10:42.
      expect(a.map(r => [r.alert.kind, r.alert.param, r.alert.extension, r.count])).toEqual([
        ['limit', 'concurrent', '101', 1],
        ['limit', 'concurrent', '101', 3],
        ['rights', 'international', '101', 1],
        ['limit', 'dailyMinutes', '101', 1],
        ['limit', 'concurrent', '102', 1]
      ])
      expect(a[1]).toMatchObject({ tenantId: 'A', at: '2026-10-15T10:00:00.000Z', lastAt: '2026-10-15T11:20:00.000Z', count: 3, alert })
      // What the first said is kept (its number), what the last said too.
      const repeated = { ...alert }
      await s.addAlert({ tenantId: 'A', at: '2026-10-15T12:40:00.000Z', alert: { ...repeated, number: '+33199000203', value: 9 } })
      expect((await s.listAlerts('A', { limit: 1 }))[0]).toMatchObject({ count: 2, first: alert, alert: { number: '+33199000203', value: 9 } })
      expect((await s.listAlerts('B'))[0]).toMatchObject({ count: 1, first: alert })
      expect(await s.listAlerts('C')).toEqual([])
      // A page at a time (after the last of the page before: its last repeat and id), of one kind or param.
      const first = await s.listAlerts('A', { limit: 2 })
      expect(first).toHaveLength(2)
      const second = await s.listAlerts('A', { limit: 2, before: { lastAt: first[1]!.lastAt, id: first[1]!.id } })
      expect(second.map(r => r.id)).toEqual(a.slice(2, 4).map(r => r.id))
      expect((await s.listAlerts('A', { kind: 'rights' })).map(r => r.alert.param)).toEqual(['international'])
      expect((await s.listAlerts('A', { param: 'concurrent' })).map(r => r.alert.extension)).toEqual(['101', '101', '102'])
      // Purged from their last repeat on, every tenant's.
      expect(await s.purgeAlerts('2026-10-15T11:00:00.000Z')).toBe(4)
      expect((await s.listAlerts('A')).map(r => r.lastAt)).toEqual(['2026-10-15T12:40:00.000Z', '2026-10-15T11:20:00.000Z'])
      expect(await s.listAlerts('B')).toEqual([])
      await s.close()
    })

    it('acknowledges an alert of the tenant once, by whom and when; a repeat after that opens a new one (step 7)', async () => {
      const s = await make()
      const alert = { kind: 'rights' as const, param: 'international', scope: 'user' as const, extension: '101', number: '+442079460123' }
      await s.addAlert({ tenantId: 'A', at: '2026-10-16T10:00:00.000Z', alert })
      const [seen] = await s.listAlerts('A')
      expect(seen).not.toHaveProperty('acknowledgedAt')
      // Repeated after the administrator saw it: not acknowledged, the repeat stays in view (review 7, n°2).
      await s.addAlert({ tenantId: 'A', at: '2026-10-16T10:05:00.000Z', alert })
      const stale = await s.acknowledgeAlert('A', seen!.id, 'root', '2026-10-16T10:06:00.000Z', seen!.lastAt, seen!.count)
      expect(stale).toMatchObject({ id: seen!.id, count: 2, lastAt: '2026-10-16T10:05:00.000Z' })
      expect(stale).not.toHaveProperty('acknowledgedAt')
      const [open] = await s.listAlerts('A', { state: 'open' })
      // Another tenant, an id of none, an id that is no number: nothing.
      expect(await s.acknowledgeAlert('B', open!.id, 'root', '2026-10-16T10:06:00.000Z', open!.lastAt, open!.count)).toBeNull()
      expect(await s.acknowledgeAlert('A', '999999', 'root', '2026-10-16T10:06:00.000Z', open!.lastAt, open!.count)).toBeNull()
      expect(await s.acknowledgeAlert('A', 'x1', 'root', '2026-10-16T10:06:00.000Z', open!.lastAt, open!.count)).toBeNull()
      expect(await s.acknowledgeAlert('A', open!.id, 'root', '2026-10-16T10:06:00.000Z', open!.lastAt, open!.count)).toMatchObject({ id: open!.id, count: 2, acknowledgedAt: '2026-10-16T10:06:00.000Z', acknowledgedBy: 'root' })
      // Acknowledged again by someone else: the first acknowledgement stays.
      expect(await s.acknowledgeAlert('A', open!.id, 'other', '2026-10-16T10:07:00.000Z', open!.lastAt, open!.count)).toMatchObject({ acknowledgedAt: '2026-10-16T10:06:00.000Z', acknowledgedBy: 'root' })
      // Within the hour, the same alert again: a new one, not counted in the acknowledged one.
      await s.addAlert({ tenantId: 'A', at: '2026-10-16T10:10:00.000Z', alert })
      await s.addAlert({ tenantId: 'A', at: '2026-10-16T10:11:00.000Z', alert })
      const all = await s.listAlerts('A')
      expect(all.map(a => [a.count, a.acknowledgedBy ?? null])).toEqual([
        [2, null],
        [2, 'root']
      ])
      expect((await s.listAlerts('A', { state: 'open' })).map(a => a.id)).toEqual([all[0]!.id])
      expect((await s.listAlerts('A', { state: 'acknowledged' })).map(a => a.id)).toEqual([open!.id])
      expect(await s.listAlerts('B', { state: 'open' })).toEqual([])
      await s.close()
    })

    it('acknowledges an alert only as many times repeated as seen, its last time unchanged by a repeat (review 7 bis, n°3)', async () => {
      const s = await make()
      const alert = { kind: 'limit' as const, param: 'dailyCalls', scope: 'user' as const, extension: '101', number: '+33199000201' }
      await s.addAlert({ tenantId: 'A', at: '2026-10-16T10:00:00.000Z', alert })
      const [seen] = await s.listAlerts('A')
      // Two repeats the screen never showed: one at the same instant, one dated before (the last time stays).
      await s.addAlert({ tenantId: 'A', at: '2026-10-16T10:00:00.000Z', alert })
      await s.addAlert({ tenantId: 'A', at: '2026-10-16T09:59:59.000Z', alert })
      const [now] = await s.listAlerts('A')
      expect(now).toMatchObject({ id: seen!.id, count: 3, lastAt: seen!.lastAt })
      const refused = await s.acknowledgeAlert('A', seen!.id, 'root', '2026-10-16T10:06:00.000Z', seen!.lastAt, seen!.count)
      expect(refused).toMatchObject({ count: 3 })
      expect(refused).not.toHaveProperty('acknowledgedAt')
      expect(await s.acknowledgeAlert('A', now!.id, 'root', '2026-10-16T10:06:00.000Z', now!.lastAt, now!.count)).toMatchObject({ count: 3, acknowledgedBy: 'root' })
      await s.close()
    })

    it('keeps the fallback of a trunk and of a range of direct numbers (step 6b)', async () => {
      const s = await make()
      await s.upsertTrunk({ tenantId: 'A', id: 'main', config: { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100', fallbackTarget: '199' } })
      await s.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101', fallbackTarget: '198' })
      expect(await s.listDids('A')).toEqual([{ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101', fallbackTarget: '198' }])
      expect((await s.listTrunks('A'))[0]!.config.fallbackTarget).toBe('199')
      await s.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
      expect((await s.listDids('A'))[0]).not.toHaveProperty('fallbackTarget')
      await s.close()
    })

    it('keeps the trunks and direct numbers of each tenant, in order, and removes the numbers with their trunk', async () => {
      const s = await make()
      const config = { auth: 'register' as const, domain: 'operator.example', proxies: ['192.0.2.20'], username: '0033199000100', codecs: ['PCMA' as const, 'PCMU' as const], numberFormat: 'e164' as const, defaultNumber: '+33199000100' }
      await s.upsertTrunk({ tenantId: 'A', id: 'main', config, passwordEnc: 'enc1' })
      await s.upsertTrunk({ tenantId: 'A', id: 'backup', config: { ...config, auth: 'ip', sources: ['192.0.2.30'] } })
      await s.upsertTrunk({ tenantId: 'B', id: 'main', config: { ...config, domain: 'other.example' } })
      // Replaced, it keeps its place: the first one serves the callers no direct number names.
      await s.upsertTrunk({ tenantId: 'A', id: 'main', config: { ...config, registerExpires: 900 }, passwordEnc: 'enc2' })
      const a = await s.listTrunks('A')
      expect(a.map(t => t.id)).toEqual(['main', 'backup'])
      expect(a[0]).toEqual({ tenantId: 'A', id: 'main', config: { ...config, registerExpires: 900 }, passwordEnc: 'enc2' })
      expect(a[1]!.passwordEnc).toBeUndefined()
      expect((await s.listTrunks('B'))[0]!.config.domain).toBe('other.example')
      expect(await s.listTrunks('C')).toEqual([])
      // Several at once (the default mark moved from one to the other), each in its place.
      await s.upsertTrunks([
        { tenantId: 'A', id: 'backup', config: { ...config, auth: 'ip', sources: ['192.0.2.30'], default: true } },
        { tenantId: 'A', id: 'main', config: { ...config, registerExpires: 900 }, passwordEnc: 'enc2' }
      ])
      expect((await s.listTrunks('A')).map(t => `${t.id}:${t.config.default ?? false}`)).toEqual(['main:false', 'backup:true'])

      await s.upsertDid({ tenantId: 'A', id: 'sales', trunkId: 'main', first: '+33199000130', last: '+33199000139', suffixDigits: 3 })
      await s.upsertDid({ tenantId: 'A', id: 'reception', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
      await s.upsertDid({ tenantId: 'A', id: 'support', trunkId: 'backup', first: '+33199000200', last: '+33199000200', target: '600' })
      await s.upsertDid({ tenantId: 'B', id: 'reception', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '200' })
      // A trunk of another tenant, or none: refused.
      await expect(s.upsertDid({ tenantId: 'C', id: 'x', trunkId: 'main', first: '+33199000300', last: '+33199000300', target: '1' })).rejects.toThrow()
      await expect(s.upsertDid({ tenantId: 'A', id: 'x', trunkId: 'nope', first: '+33199000300', last: '+33199000300', target: '1' })).rejects.toThrow()
      expect(await s.listDids('A')).toEqual([
        { tenantId: 'A', id: 'reception', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' },
        { tenantId: 'A', id: 'sales', trunkId: 'main', first: '+33199000130', last: '+33199000139', suffixDigits: 3 },
        { tenantId: 'A', id: 'support', trunkId: 'backup', first: '+33199000200', last: '+33199000200', target: '600' }
      ])
      await s.upsertDid({ tenantId: 'A', id: 'reception', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '102' })
      expect((await s.listDids('A'))[0]!.target).toBe('102')
      expect(await s.deleteDid('A', 'sales')).toBe(true)
      expect(await s.deleteDid('A', 'sales')).toBe(false)
      expect(await s.deleteDid('B', 'support')).toBe(false)
      // A trunk goes with its numbers, in its tenant only.
      expect(await s.deleteTrunk('A', 'main')).toBe(true)
      expect(await s.deleteTrunk('A', 'main')).toBe(false)
      expect((await s.listTrunks('A')).map(t => t.id)).toEqual(['backup'])
      expect((await s.listDids('A')).map(d => d.id)).toEqual(['support'])
      expect((await s.listDids('B')).map(d => d.id)).toEqual(['reception'])
      await s.close()
    })

    it('keeps the first VAPID keys it is given', async () => {
      const s = await make()
      expect(await s.getVapidKeys()).toBeNull()
      expect(await s.initVapidKeys({ publicKey: 'pub1', privateKeyEnc: 'enc1' })).toEqual({ publicKey: 'pub1', privateKeyEnc: 'enc1' })
      expect(await s.initVapidKeys({ publicKey: 'pub2', privateKeyEnc: 'enc2' })).toEqual({ publicKey: 'pub1', privateKeyEnc: 'enc1' })
      expect(await s.getVapidKeys()).toEqual({ publicKey: 'pub1', privateKeyEnc: 'enc1' })
      await s.close()
    })

    const subscription = (over: Partial<WebhookSubscriptionRecord>): WebhookSubscriptionRecord => ({
      tenantId: 'A',
      id: 'wh_0000000000000001',
      url: 'https://crm.example.org/in',
      events: ['call.missed'],
      enabled: true,
      secretEnc: 'enc',
      failures: 0,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
      ...over
    })
    /** Caps that leave everything to one claim (the tests of the queue itself). */
    const OPEN = { perSubscription: 100, perTenant: 100, maxAttempts: 9 }
    const t = (sec: number) => new Date(Date.parse('2026-10-16T10:00:00.000Z') + sec * 1000).toISOString()

    it('keeps the webhook subscriptions and allowed domains of each tenant apart, up to a number per tenant', async () => {
      const s = await make()
      expect(await s.addWebhookSubscription(subscription({ description: 'CRM', createdBy: 'alice' }), 2)).toBe(true)
      expect(await s.addWebhookSubscription(subscription({ id: 'wh_0000000000000002', events: ['call.ringing', 'trunk.degraded'], createdAt: '2026-10-16T10:01:00.000Z' }), 2)).toBe(true)
      expect(await s.addWebhookSubscription(subscription({ id: 'wh_0000000000000003' }), 2)).toBe(false)
      expect(await s.addWebhookSubscription(subscription({ tenantId: 'B', id: 'wh_0000000000000004' }), 2)).toBe(true)
      expect((await s.listWebhookSubscriptions('A')).map(w => w.id)).toEqual(['wh_0000000000000001', 'wh_0000000000000002'])
      expect(await s.getWebhookSubscription('A', 'wh_0000000000000001')).toEqual(subscription({ description: 'CRM', createdBy: 'alice' }))
      expect(await s.getWebhookSubscription('B', 'wh_0000000000000001')).toBeNull()
      // What an administrator sets: never the secret (a renewal is its own write).
      expect(await s.updateWebhookSubscription(subscription({ url: 'https://crm.example.org/v2', secretEnc: 'stale', updatedAt: '2026-10-16T11:00:00.000Z' }))).toBe(true)
      const updated = await s.getWebhookSubscription('A', 'wh_0000000000000001')
      expect([updated?.url, updated?.secretEnc, updated?.description, updated?.updatedAt]).toEqual(['https://crm.example.org/v2', 'enc', undefined, '2026-10-16T11:00:00.000Z'])
      expect(await s.updateWebhookSubscription(subscription({ tenantId: 'B' }))).toBe(false)
      expect(await s.deleteWebhookSubscription('B', 'wh_0000000000000001')).toBe(false)
      expect(await s.deleteWebhookSubscription('A', 'wh_0000000000000002')).toBe(true)
      expect((await s.listWebhookSubscriptions('A')).map(w => w.id)).toEqual(['wh_0000000000000001'])
      expect(await s.getWebhookDomains('A')).toEqual([])
      await s.setWebhookDomains('A', ['crm.example.org', '*.hooks.example.net'])
      await s.setWebhookDomains('B', ['b.example.org'])
      expect(await s.getWebhookDomains('A')).toEqual(['crm.example.org', '*.hooks.example.net'])
      await s.setWebhookDomains('A', ['*.hooks.example.net'])
      expect(await s.getWebhookDomains('A')).toEqual(['*.hooks.example.net'])
      expect(await s.getWebhookDomains('B')).toEqual(['b.example.org'])
      await s.close()
    })

    it('renews a secret in one write, the one before kept until a date, and hands both to the claimer meanwhile', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      expect(await s.renewWebhookSecret('B', 'wh_0000000000000001', 'enc2', t(3600), t(0))).toBe(false)
      // Two renewals at once: both written, the second keeps the first as the one before.
      await Promise.all([s.renewWebhookSecret('A', 'wh_0000000000000001', 'enc2', t(3600), t(0)), s.updateWebhookSubscription(subscription({ description: 'CRM', updatedAt: t(0) }))])
      expect(await s.renewWebhookSecret('A', 'wh_0000000000000001', 'enc3', t(3601), t(1))).toBe(true)
      const w = await s.getWebhookSubscription('A', 'wh_0000000000000001')
      expect([w?.secretEnc, w?.secretPrevEnc, w?.secretPrevUntil, w?.description]).toEqual(['enc3', 'enc2', t(3601), 'CRM'])
      await s.enqueueWebhookEvent('A', 'evt_1', 'call.missed', '{}', t(0))
      await s.enqueueWebhookEvent('A', 'evt_2', 'call.missed', '{}', t(0))
      const [first] = await s.claimWebhookDeliveries(t(10), t(70), 1, OPEN)
      expect([first?.secretEnc, first?.secretPrevEnc]).toEqual(['enc3', 'enc2'])
      // Past its date, the one before signs no more.
      const [later] = await s.claimWebhookDeliveries(t(3602), t(3662), 1, OPEN)
      expect([later?.secretEnc, later?.secretPrevEnc]).toEqual(['enc3', undefined])
      await s.close()
    })

    it('queues an event once per subscription that takes it, enabled, whoever queues it again; past the pending cap, recorded failed', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      await s.addWebhookSubscription(subscription({ id: 'wh_0000000000000002', events: ['call.missed', 'call.ended'] }), 20)
      await s.addWebhookSubscription(subscription({ id: 'wh_0000000000000003', events: ['call.ended'] }), 20)
      await s.addWebhookSubscription(subscription({ id: 'wh_0000000000000004', enabled: false }), 20)
      await s.addWebhookSubscription(subscription({ tenantId: 'B', id: 'wh_0000000000000005' }), 20)
      const at = '2026-10-16T10:00:00.000Z'
      expect(await s.enqueueWebhookEvent('A', 'evt_1', 'call.missed', '{"id":"evt_1"}', at)).toBe(2)
      // Heard again (another Gateway, the same event): nothing more.
      expect(await s.enqueueWebhookEvent('A', 'evt_1', 'call.missed', '{"id":"evt_1"}', at)).toBe(0)
      expect(await s.enqueueWebhookEvent('A', 'evt_2', 'presence.changed', '{}', at)).toBe(0)
      const log = await s.listWebhookDeliveries('A', 'wh_0000000000000002')
      expect(log.map(d => [d.eventId, d.eventType, d.status, d.attempts, d.body, d.createdAt, d.nextAttemptAt])).toEqual([['evt_1', 'call.missed', 'pending', 0, '{"id":"evt_1"}', at, at]])
      expect(log[0]!.id).toMatch(/^dlv_[0-9a-f]{32}$/)
      expect(await s.listWebhookDeliveries('A', 'wh_0000000000000003')).toEqual([])
      expect(await s.listWebhookDeliveries('B', 'wh_0000000000000005')).toEqual([])
      // One subscription, whatever it takes (a test); none of another tenant.
      const test = await s.enqueueWebhookDelivery('A', 'wh_0000000000000003', 'evt_t', 'webhook.test', '{}', at)
      expect([test?.subscriptionId, test?.eventType, test?.status]).toEqual(['wh_0000000000000003', 'webhook.test', 'pending'])
      expect(await s.enqueueWebhookDelivery('B', 'wh_0000000000000003', 'evt_u', 'webhook.test', '{}', at)).toBeNull()
      // Two pending at most: wh_1 and wh_2 have one; the second event fills them, the third is recorded failed.
      expect(await s.enqueueWebhookEvent('A', 'evt_3', 'call.missed', '{}', at, { maxPending: 2 })).toBe(2)
      expect(await s.enqueueWebhookEvent('A', 'evt_4', 'call.missed', '{}', at, { maxPending: 2 })).toBe(0)
      const [full] = await s.listWebhookDeliveries('A', 'wh_0000000000000001', { status: 'failed' })
      expect([full?.eventId, full?.lastError, full?.nextAttemptAt]).toEqual(['evt_4', 'backlog', undefined])
      await s.close()
    })

    it('hands each due delivery to one claimer at a time, until its lease ends, and keeps the outcome of the one that holds it', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      await s.enqueueWebhookEvent('A', 'evt_1', 'call.missed', '{"n":1}', t(0))
      await s.enqueueWebhookEvent('A', 'evt_2', 'call.missed', '{"n":2}', t(5))
      expect(await s.claimWebhookDeliveries(t(-1), t(59), 10, OPEN)).toEqual([])
      const [first, ...rest] = await s.claimWebhookDeliveries(t(1), t(61), 10, OPEN)
      expect(rest).toEqual([])
      expect([first?.eventId, first?.attempts, first?.url, first?.secretEnc, first?.secretPrevEnc, first?.lastAttemptAt]).toEqual(['evt_1', 1, 'https://crm.example.org/in', 'enc', undefined, t(1)])
      // Held: not handed again before its lease ends; the other one once due.
      expect((await s.claimWebhookDeliveries(t(10), t(70), 10, OPEN)).map(d => d.eventId)).toEqual(['evt_2'])
      // Failed, due again later, a failure counted for the subscription; an outcome with another claim is ignored.
      expect(await s.completeWebhookDelivery(first!.id, 'not-the-claim', { delivered: true, at: t(2), status: 204 })).toBeNull()
      expect(await s.completeWebhookDelivery(first!.id, first!.claim, { delivered: false, at: t(2), status: 500, error: 'http', retryAt: t(30) })).toEqual({ failures: 1, failingSince: t(2) })
      expect(await s.completeWebhookDelivery(first!.id, first!.claim, { delivered: true, at: t(3), status: 204 })).toBeNull()
      let d = (await s.listWebhookDeliveries('A', 'wh_0000000000000001', { status: 'pending' })).find(x => x.eventId === 'evt_1')
      expect([d?.status, d?.attempts, d?.lastStatus, d?.lastError, d?.nextAttemptAt]).toEqual(['pending', 1, 500, 'http', t(30)])
      const again = await s.claimWebhookDeliveries(t(30), t(90), 10, OPEN)
      expect(again.map(x => [x.eventId, x.attempts])).toEqual([['evt_1', 2]])
      // Delivered: the subscription's failures start afresh.
      expect(await s.completeWebhookDelivery(again[0]!.id, again[0]!.claim, { delivered: true, at: t(31), status: 204 })).toEqual({ failures: 0 })
      d = (await s.listWebhookDeliveries('A', 'wh_0000000000000001', { status: 'delivered' }))[0]
      expect([d?.eventId, d?.status, d?.lastStatus, d?.lastError, d?.deliveredAt, d?.nextAttemptAt]).toEqual(['evt_1', 'delivered', 204, undefined, t(31), undefined])
      // A lease that ended without an outcome (the Gateway stopped): handed again, counted as another attempt.
      const taken = await s.claimWebhookDeliveries(t(71), t(131), 10, OPEN)
      expect(taken.map(x => [x.eventId, x.attempts])).toEqual([['evt_2', 2]])
      // Failed for good: no retry.
      expect(await s.completeWebhookDelivery(taken[0]!.id, taken[0]!.claim, { delivered: false, at: t(72), error: 'timeout' })).toEqual({ failures: 1, failingSince: t(72) })
      d = (await s.listWebhookDeliveries('A', 'wh_0000000000000001', { status: 'failed' }))[0]
      expect([d?.eventId, d?.status, d?.lastError, d?.lastStatus, d?.nextAttemptAt]).toEqual(['evt_2', 'failed', 'timeout', undefined, undefined])
      expect(await s.claimWebhookDeliveries(t(1000), t(1060), 10, OPEN)).toEqual([])
      // One whose last attempt never came back (its lease lapsed, its attempts used): failed, never taken again.
      await s.enqueueWebhookEvent('A', 'evt_3', 'call.missed', '{}', t(1000))
      const [last] = await s.claimWebhookDeliveries(t(1001), t(1061), 10, { ...OPEN, maxAttempts: 1 })
      expect(last?.eventId).toBe('evt_3')
      expect(await s.claimWebhookDeliveries(t(1100), t(1160), 10, { ...OPEN, maxAttempts: 1 })).toEqual([])
      d = (await s.listWebhookDeliveries('A', 'wh_0000000000000001')).find(x => x.eventId === 'evt_3')
      expect([d?.status, d?.lastError, d?.attempts]).toEqual(['failed', 'abandoned', 1])
      await s.close()
    })

    it('shares what is sent at once between tenants and subscriptions: each within its cap, each tenant in turn, whatever the claimers', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      await s.addWebhookSubscription(subscription({ id: 'wh_0000000000000002', events: ['call.ended'] }), 20)
      await s.addWebhookSubscription(subscription({ tenantId: 'B', id: 'wh_0000000000000003' }), 20)
      // Tenant A queued 10 events (5 for each of its subscriptions, in turn) before tenant B queued 2.
      for (let i = 1; i <= 5; i++) {
        await s.enqueueWebhookEvent('A', `evt_m${i}`, 'call.missed', '{}', t(i))
        await s.enqueueWebhookEvent('A', `evt_e${i}`, 'call.ended', '{}', t(i + 0.5))
      }
      for (let i = 1; i <= 2; i++) await s.enqueueWebhookEvent('B', `evt_b${i}`, 'call.missed', '{}', t(10 + i))
      const caps = { perSubscription: 2, perTenant: 3, maxAttempts: 9 }
      const name = (d: { subscriptionId: string; eventId: string }) => `${d.subscriptionId.slice(-1)}:${d.eventId}`
      // Two at a time: A's earliest and B's earliest, not A's two earliest.
      const first = await s.claimWebhookDeliveries(t(20), t(80), 2, caps)
      expect(first.map(name).sort()).toEqual(['1:evt_m1', '3:evt_b1'])
      // Then what is left within the caps: A three at most in all, each of its subscriptions two; B the rest.
      const second = await s.claimWebhookDeliveries(t(20), t(80), 10, caps)
      expect(second.map(name).sort()).toEqual(['1:evt_m2', '2:evt_e1', '3:evt_b2'])
      expect(await s.claimWebhookDeliveries(t(20), t(80), 10, caps)).toEqual([])
      // One of A's done: one more of A (three at most), its earliest due within the caps.
      const done = first.find(d => d.tenantId === 'A')!
      await s.completeWebhookDelivery(done.id, done.claim, { delivered: true, at: t(21), status: 204 })
      expect((await s.claimWebhookDeliveries(t(22), t(82), 10, caps)).map(name)).toEqual(['2:evt_e2'])
      await s.close()
    })

    it('never lets two claimers at once take more than a cap', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      for (let i = 1; i <= 6; i++) await s.enqueueWebhookEvent('A', `evt_${i}`, 'call.missed', '{}', t(i))
      const caps = { perSubscription: 2, perTenant: 8, maxAttempts: 9 }
      const both = await Promise.all([s.claimWebhookDeliveries(t(10), t(70), 10, caps), s.claimWebhookDeliveries(t(10), t(70), 10, caps), s.claimWebhookDeliveries(t(10), t(70), 10, caps)])
      expect(both.flat().map(d => d.eventId).sort()).toEqual(['evt_1', 'evt_2'])
      await s.close()
    })

    it('leaves the deliveries of a paused subscription waiting, and disables one that kept failing', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      await s.addWebhookSubscription(subscription({ tenantId: 'B', id: 'wh_0000000000000002' }), 20)
      await s.enqueueWebhookEvent('A', 'evt_1', 'call.missed', '{}', t(0))
      await s.enqueueWebhookEvent('A', 'evt_2', 'call.missed', '{}', t(0))
      await s.pauseWebhookSubscription('B', 'wh_0000000000000001', t(100))
      expect(await s.getWebhookSubscription('A', 'wh_0000000000000001')).toEqual(subscription({}))
      await s.pauseWebhookSubscription('A', 'wh_0000000000000001', t(100))
      expect((await s.getWebhookSubscription('A', 'wh_0000000000000001'))?.pausedUntil).toBe(t(100))
      expect(await s.claimWebhookDeliveries(t(50), t(110), 10, OPEN)).toEqual([])
      const [one] = await s.claimWebhookDeliveries(t(100), t(160), 1, OPEN)
      // A failure keeps the pause written; a delivery lifts it.
      expect(await s.completeWebhookDelivery(one!.id, one!.claim, { delivered: false, at: t(101), error: 'timeout', retryAt: t(200) })).toEqual({ failures: 1, failingSince: t(101) })
      expect((await s.getWebhookSubscription('A', 'wh_0000000000000001'))?.pausedUntil).toBe(t(100))
      expect(await s.disableFailingWebhookSubscription('B', 'wh_0000000000000001', t(102))).toBe(false)
      expect(await s.disableFailingWebhookSubscription('A', 'wh_0000000000000001', t(102))).toBe(true)
      expect(await s.disableFailingWebhookSubscription('A', 'wh_0000000000000001', t(103))).toBe(false)
      const w = await s.getWebhookSubscription('A', 'wh_0000000000000001')
      expect([w?.enabled, w?.disabledReason, w?.failures, w?.updatedAt]).toEqual([false, 'failing', 1, t(102)])
      expect((await s.listWebhookDeliveries('A', 'wh_0000000000000001', { status: 'pending' })).length).toBe(0)
      expect(await s.claimWebhookDeliveries(t(300), t(360), 10, OPEN)).toEqual([])
      // Enabled again by an administrator: afresh.
      await s.updateWebhookSubscription(subscription({ enabled: true, updatedAt: t(400) }))
      const again = await s.getWebhookSubscription('A', 'wh_0000000000000001')
      expect([again?.enabled, again?.disabledReason, again?.failures, again?.failingSince, again?.pausedUntil]).toEqual([true, undefined, 0, undefined, undefined])
      await s.close()
    })

    it('counts the tests and replays asked of a subscription, whoever asks, a number per window', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      await s.addWebhookSubscription(subscription({ id: 'wh_0000000000000002' }), 20)
      expect(await s.takeWebhookSend('A', 'wh_0000000000000001', t(0), 2, 60_000)).toBe(true)
      expect(await s.takeWebhookSend('A', 'wh_0000000000000001', t(1), 2, 60_000)).toBe(true)
      expect(await s.takeWebhookSend('A', 'wh_0000000000000001', t(2), 2, 60_000)).toBe(false)
      expect(await s.takeWebhookSend('A', 'wh_0000000000000002', t(2), 2, 60_000)).toBe(true)
      expect(await s.takeWebhookSend('B', 'wh_0000000000000002', t(2), 2, 60_000)).toBe(false)
      expect(await s.takeWebhookSend('A', 'wh_0000000000000001', t(60.5), 2, 60_000)).toBe(true)
      await s.close()
    })

    it('replays a delivery that is over, lists the log a page at a time, and purges it once old', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      for (let i = 1; i <= 5; i++) await s.enqueueWebhookEvent('A', `evt_${i}`, 'call.missed', `{"n":${i}}`, t(i))
      const page1 = await s.listWebhookDeliveries('A', 'wh_0000000000000001', { limit: 2 })
      expect(page1.map(d => d.eventId)).toEqual(['evt_5', 'evt_4'])
      const page2 = await s.listWebhookDeliveries('A', 'wh_0000000000000001', { limit: 2, before: { createdAt: page1[1]!.createdAt, id: page1[1]!.id } })
      expect(page2.map(d => d.eventId)).toEqual(['evt_3', 'evt_2'])
      const target = page2[0]!
      expect(await s.replayWebhookDelivery('A', 'wh_0000000000000001', target.id, t(10))).toBe('pending')
      // The three due at t(3) delivered (evt_1 to evt_3); evt_3 replayed.
      const claimed = await s.claimWebhookDeliveries(t(3), t(63), 10, OPEN)
      expect(claimed.map(d => d.eventId).sort()).toEqual(['evt_1', 'evt_2', 'evt_3'])
      for (const c of claimed) await s.completeWebhookDelivery(c.id, c.claim, { delivered: true, at: t(4), status: 200 })
      const replayed = await s.replayWebhookDelivery('A', 'wh_0000000000000001', target.id, t(100))
      expect(replayed !== 'pending' && [replayed?.status, replayed?.attempts, replayed?.nextAttemptAt, replayed?.eventId, replayed?.lastStatus, replayed?.deliveredAt]).toEqual(['pending', 0, t(100), 'evt_3', undefined, undefined])
      expect(await s.replayWebhookDelivery('B', 'wh_0000000000000001', target.id, t(100))).toBeNull()
      expect(await s.replayWebhookDelivery('A', 'wh_0000000000000001', 'dlv_00000000000000000000000000000000', t(100))).toBeNull()
      // Old ones go unless pending: evt_1 and evt_2 (delivered), not evt_3 (replayed) nor those queued since.
      expect(await s.purgeWebhookDeliveries(t(3.5))).toBe(2)
      expect((await s.listWebhookDeliveries('A', 'wh_0000000000000001')).map(d => d.eventId)).toEqual(['evt_5', 'evt_4', 'evt_3'])
      await s.close()
    })

    it('fails the pending deliveries of a subscription disabled, and drops them with a subscription deleted', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({}), 20)
      await s.enqueueWebhookEvent('A', 'evt_1', 'call.missed', '{}', '2026-10-16T10:00:00.000Z')
      await s.updateWebhookSubscription(subscription({ enabled: false }))
      const [d] = await s.listWebhookDeliveries('A', 'wh_0000000000000001')
      expect([d?.status, d?.lastError]).toEqual(['failed', 'disabled'])
      expect(await s.claimWebhookDeliveries('2026-10-16T11:00:00.000Z', '2026-10-16T11:01:00.000Z', 10, OPEN)).toEqual([])
      expect(await s.enqueueWebhookEvent('A', 'evt_2', 'call.missed', '{}', '2026-10-16T10:00:00.000Z')).toBe(0)
      // A delivery queued for it (a replay asked before) is not taken while it is disabled.
      expect(await s.replayWebhookDelivery('A', 'wh_0000000000000001', d!.id, '2026-10-16T10:30:00.000Z')).not.toBeNull()
      expect(await s.claimWebhookDeliveries('2026-10-16T11:00:00.000Z', '2026-10-16T11:01:00.000Z', 10, OPEN)).toEqual([])
      await s.deleteWebhookSubscription('A', 'wh_0000000000000001')
      expect(await s.listWebhookDeliveries('A', 'wh_0000000000000001')).toEqual([])
      await s.close()
    })

    it('erases what was sent about a person and what was told of their presence, not what is still owed nor anyone else', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({ events: ['call.missed', 'presence.changed'] }), 20)
      await s.enqueueWebhookEvent('A', 'evt_1', 'call.missed', '{"user":"jdupont"}', t(0), { subjectUser: 'jdupont' })
      await s.enqueueWebhookEvent('A', 'evt_2', 'call.missed', '{"user":"jdupont"}', t(1), { subjectUser: 'jdupont' })
      await s.enqueueWebhookEvent('A', 'evt_3', 'call.missed', '{"user":"amartin"}', t(2), { subjectUser: 'amartin' })
      const claimed = await s.claimWebhookDeliveries(t(0.5), t(60), 10, OPEN)
      expect(claimed.map(d => d.eventId)).toEqual(['evt_1'])
      await s.completeWebhookDelivery(claimed[0]!.id, claimed[0]!.claim, { delivered: true, at: t(1), status: 204 })
      expect(await s.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_1', 60_000)).toBe(true)
      for (const user of ['jdupont', 'amartin']) await s.setWebhookState({ tenantId: 'A', subject: `presence:${user}`, state: 'busy', at: t(3), holder: 'gw_1' }, () => null)
      expect(await s.eraseWebhookSubject('B', 'jdupont')).toBe(0)
      expect(await s.eraseWebhookSubject('A', 'jdupont')).toBe(1)
      expect((await s.listWebhookDeliveries('A', 'wh_0000000000000001')).map(d => d.eventId)).toEqual(['evt_3', 'evt_2'])
      // Told nothing of jdupont any more: the same status is a change again; amartin's is not.
      expect(await s.setWebhookState({ tenantId: 'A', subject: 'presence:jdupont', state: 'busy', at: t(4), holder: 'gw_1' }, () => null)).toEqual({ previous: undefined, queued: 0 })
      expect(await s.setWebhookState({ tenantId: 'A', subject: 'presence:amartin', state: 'busy', at: t(4), holder: 'gw_1' }, () => null)).toBeNull()
      await s.close()
    })

    it('tells a change of state once, from the holder of the lease only, never one older than what was told, its event queued with it', async () => {
      const s = await make()
      await s.addWebhookSubscription(subscription({ events: ['trunk.degraded', 'presence.changed'] }), 20)
      const at = (sec: number) => new Date(Date.now() + sec * 1000).toISOString()
      const change = (subject: string, state: string, sec: number, holder = 'gw_1') => ({ tenantId: 'A', subject, state, at: at(sec), holder })
      const event = (id: string) => (previous: string | undefined) => ({ id, type: 'trunk.degraded' as const, body: JSON.stringify({ id, previous: previous ?? null }) })
      // Nobody holds the lease: nothing written.
      expect(await s.setWebhookState(change('trunk:main', 'up', 0), event('evt_0'))).toBeNull()
      expect(await s.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_1', 60_000)).toBe(true)
      expect(await s.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_2', 60_000)).toBe(false)
      expect(await s.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_1', 60_000)).toBe(true)
      expect(await s.setWebhookState(change('trunk:main', 'up', 1, 'gw_2'), event('evt_0'))).toBeNull()
      expect(await s.setWebhookState(change('trunk:main', 'up', 1), () => null)).toEqual({ previous: undefined, queued: 0 })
      expect(await s.setWebhookState(change('trunk:main', 'up', 2), event('evt_1'))).toBeNull()
      expect(await s.setWebhookState(change('trunk:main', 'down', 3), event('evt_2'))).toEqual({ previous: 'up', queued: 1 })
      // Older than what was told (a change heard late): refused, whatever it says.
      expect(await s.setWebhookState(change('trunk:main', 'degraded', 2.5), event('evt_3'))).toBeNull()
      expect(await s.setWebhookState(change('trunk:main', 'down', 4), event('evt_4'))).toBeNull()
      expect(await s.setWebhookState({ ...change('trunk:main', 'down', 3), tenantId: 'B' }, event('evt_5'))).toEqual({ previous: undefined, queued: 0 })
      expect(await s.setWebhookState(change('trunk:main', 'degraded', 5), event('evt_6'))).toEqual({ previous: 'down', queued: 1 })
      const log = await s.listWebhookDeliveries('A', 'wh_0000000000000001')
      expect(log.map(d => [d.eventId, d.body])).toEqual([
        ['evt_6', '{"id":"evt_6","previous":"down"}'],
        ['evt_2', '{"id":"evt_2","previous":"up"}']
      ])
      // Two writes of the same change at once: one only finds it new.
      const both = await Promise.all([s.setWebhookState(change('presence:jdupont', 'busy', 6), () => null), s.setWebhookState(change('presence:jdupont', 'busy', 6.02), () => null)])
      expect(both.filter(x => x !== null)).toHaveLength(1)
      // States told long ago go with the purge.
      await s.purgeWebhookDeliveries(at(5.5))
      expect(await s.setWebhookState(change('trunk:main', 'degraded', 7), () => null)).toEqual({ previous: undefined, queued: 0 })
      expect(Math.abs(Date.parse(await s.clock()) - Date.now())).toBeLessThan(60_000)
      await s.close()
    })
  })
