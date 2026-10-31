import { describe, expect, it } from 'vitest'

import { callToShow, isIncoming } from './callToShow.js'

const call = (id, direction, state) => ({ id, direction, state, remoteNumber: '102' })

describe('callToShow', () => {
  it('shows a call ringing here first, else the call under way, outbound ringing included', () => {
    const windows = new Map([['w1', [call('a', 'outbound', 'connected')]], ['w2', [call('b', 'inbound', 'ringing')]]])
    expect(callToShow(windows)).toMatchObject({ id: 'b', window: 'w2' })
    const out = callToShow(new Map([['w1', [call('c', 'outbound', 'ringing')]]]))
    expect(out).toMatchObject({ id: 'c' })
    expect(isIncoming(out)).toBe(false)
    expect(callToShow(new Map())).toBeNull()
  })
})
