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
      await s.upsertProvider({ tenantId: 'A', type: 'asterisk', config: { ari: { url: 'x' } } })
      await s.upsertProvider({ tenantId: 'A', type: 'asterisk', config: { ari: { url: 'y' } } })
      await s.upsertProvider({ tenantId: 'B', type: 'asterisk', config: { ari: { url: 'z' } } })
      const all = await s.listProviders()
      expect(all).toHaveLength(2)
      expect(all.find(p => p.tenantId === 'A')?.config).toEqual({ ari: { url: 'y' } })
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

    it('does not count an inbound call the user declined as missed', async () => {
      const s = await make()
      await s.addHistory(entry({ callId: 'declined', direction: 'inbound', answered: false, durationSec: 0, state: 'rejected', remoteNumber: '102' }))
      await s.addHistory(entry({ callId: 'missed', direction: 'inbound', answered: false, durationSec: 0, state: 'missed', remoteNumber: '103', startedAt: '2026-10-05T11:00:00.000Z' }))
      expect((await s.listHistory('A', 'alice', { status: 'missed' })).items.map(e => e.callId)).toEqual(['missed'])
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
  })
