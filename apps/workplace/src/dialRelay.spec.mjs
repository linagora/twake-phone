import { afterEach, describe, expect, it } from 'vitest'

import { DIAL_CHANNEL, requestDial } from './dialRelay.js'

// A Twake Phone window, as the intent page hears it on the channel.
const windows = []
const aWindow = answer => {
  const channel = new BroadcastChannel(DIAL_CHANNEL)
  channel.onmessage = ({ data }) => data?.type === 'dial' && answer(channel, data)
  windows.push(channel)
}
afterEach(() => windows.splice(0).forEach(c => c.close()))

describe('requestDial', () => {
  it('is handled once a window claimed the number and its frame took it', async () => {
    aWindow((channel, { id }) => {
      channel.postMessage({ type: 'dial-claim', id })
      setTimeout(() => channel.postMessage({ type: 'dial-ack', id, ok: true }), 50)
    })
    expect(await requestDial('102', { claimMs: 100, ackMs: 500 })).toEqual({ handled: true })
  })

  it('is not when no window claims it, nor when the one that did never says how it went, nor when its frame could not', async () => {
    expect(await requestDial('102', { claimMs: 50 })).toEqual({ handled: false })
    aWindow((channel, { id }) => channel.postMessage({ type: 'dial-claim', id }))
    expect(await requestDial('102', { claimMs: 50, ackMs: 100 })).toEqual({ handled: false })
    windows.splice(0).forEach(c => c.close())
    aWindow((channel, { id }) => channel.postMessage({ type: 'dial-ack', id, ok: false }))
    expect(await requestDial('102', { claimMs: 50 })).toEqual({ handled: false })
  })

  it('waits past the claim time for a window that claimed it (its frame may be slow)', async () => {
    aWindow((channel, { id }) => {
      channel.postMessage({ type: 'dial-claim', id })
      setTimeout(() => channel.postMessage({ type: 'dial-ack', id, ok: true }), 150)
    })
    expect(await requestDial('102', { claimMs: 50, ackMs: 500 })).toEqual({ handled: true })
  })
})
