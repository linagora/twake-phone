import { act, render, screen } from '@testing-library/react'
import React from 'react'
import AppLike from 'test/AppLike'

import { PhoneProvider, usePhone } from '@/telephony/PhoneProvider'
import { CAPABILITIES, makeFakeServices } from '@/telephony/fakeServices'

const Probe = () => {
  const { calls, status } = usePhone()
  return (
    <div>
      {status}:{calls.map(c => `${c.direction}/${c.state}`).join(',')}
    </div>
  )
}

const setup = async () => {
  const handlers = {}
  const services = makeFakeServices({
    ...CAPABILITIES,
    media: { browserAudio: true }
  })
  services.createSoftphone = h => {
    Object.assign(handlers, h)
    return { start: jest.fn(async () => {}), stop: jest.fn() }
  }
  render(
    <AppLike>
      <PhoneProvider services={services}>
        <Probe />
      </PhoneProvider>
    </AppLike>
  )
  await screen.findByText(/^ready:/)
  return handlers
}

const softCall = remoteNumber => ({
  id: 'x',
  direction: 'inbound',
  state: 'ringing',
  remoteNumber,
  answer: jest.fn()
})

const Dialer = () => {
  const { actions } = usePhone()
  return <button onClick={() => actions.dial('102')}>dial</button>
}

describe('PhoneProvider', () => {
  it('ignores, without answering, a call from the own extension that this window did not place', async () => {
    const handlers = await setup()
    const call = softCall('101') // fake `me` has extension 101
    await act(async () => handlers.onIncoming(call))
    expect(call.answer).not.toHaveBeenCalled()
    expect(screen.getByText('ready:')).toBeInTheDocument()
  })

  it('answers the click-to-call leg of a call it placed, and shows the dialled party as an outgoing call', async () => {
    const handlers = {}
    const services = makeFakeServices({
      ...CAPABILITIES,
      media: { browserAudio: true }
    })
    services.createSoftphone = h => {
      Object.assign(handlers, h)
      return { start: jest.fn(async () => {}), stop: jest.fn() }
    }
    render(
      <AppLike>
        <PhoneProvider services={services}>
          <Probe />
          <Dialer />
        </PhoneProvider>
      </AppLike>
    )
    await screen.findByText(/^ready:/)
    await act(async () => screen.getByText('dial').click())
    const leg = softCall('101')
    await act(async () => handlers.onIncoming(leg))
    expect(leg.answer).toHaveBeenCalled()
    expect(screen.getByText('ready:outbound/ringing')).toBeInTheDocument()
  })

  it('does not answer a call from someone else', async () => {
    const handlers = await setup()
    const call = softCall('102')
    await act(async () => handlers.onIncoming(call))
    expect(call.answer).not.toHaveBeenCalled()
    expect(screen.getByText('ready:inbound/ringing')).toBeInTheDocument()
  })

  it('moves a finished call to the history', async () => {
    const handlers = await setup()
    const call = softCall('102')
    await act(async () => handlers.onIncoming(call))
    await act(async () => handlers.onCallChange({ ...call, state: 'ended' }))
    expect(screen.getByText('ready:')).toBeInTheDocument()
  })
})
