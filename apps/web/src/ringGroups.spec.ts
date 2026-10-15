import { describe, expect, it } from 'vitest'
import { groupRefusalKey, parseMembers } from './ringGroups.js'

describe('ring groups (Administration)', () => {
  it('reads the members as typed, in order, each once', () => {
    expect(parseMembers(' 101, 102 ;103\n101 ')).toEqual(['101', '102', '103'])
    expect(parseMembers('  ')).toEqual([])
  })

  it("puts the Gateway's refusals into words, and nothing else", () => {
    expect(groupRefusalKey(Object.assign(new Error('x'), { code: 'GROUP_NUMBER_TAKEN' }))).toBe('admin.groupNumberTaken')
    expect(groupRefusalKey(Object.assign(new Error('x'), { code: 'GROUP_MEMBER_NOT_EXTENSION' }))).toBe('admin.groupMemberNotExtension')
    // An emergency number (or another short number of the French plan) is no group's number.
    expect(groupRefusalKey(Object.assign(new Error('x'), { code: 'GROUP_NUMBER_RESERVED' }))).toBe('admin.groupNumberReserved')
    // "New group" on a number the organisation has: said so, never replaced.
    expect(groupRefusalKey(Object.assign(new Error('x'), { code: 'GROUP_EXISTS' }))).toBe('admin.groupExists')
    // A directory synchronisation that does not end in time: try again.
    expect(groupRefusalKey(Object.assign(new Error('x'), { code: 'SYNC_RUNNING' }))).toBe('admin.groupSyncRunning')
    expect(groupRefusalKey(Object.assign(new Error('x'), { code: 'FST_ERR_SOMETHING' }))).toBeUndefined()
    expect(groupRefusalKey(new Error('x'))).toBeUndefined()
  })
})
