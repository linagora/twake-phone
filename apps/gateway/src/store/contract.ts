import { describe, expect, it } from 'vitest'
import type { HistoryEntry, Store } from './types.js'

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
  })
