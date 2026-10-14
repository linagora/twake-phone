import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import AppLike from 'test/AppLike'

import { createMockClient } from 'cozy-client'

import { Widget } from '@/components/Widget'
import { PhoneProvider } from '@/telephony/PhoneProvider'
import { CAPABILITIES, makeFakeServices } from '@/telephony/fakeServices'

global.ResizeObserver = class {
  observe() {}
  disconnect() {}
}

const client = createMockClient({
  queries: {
    'io.cozy.contacts/allContacts': {
      doctype: 'io.cozy.contacts',
      data: [
        {
          _id: 'a',
          _type: 'io.cozy.contacts',
          displayName: 'Camille Martin',
          phone: [{ number: '06 12 34 56 78' }]
        }
      ]
    }
  }
})
const ev = (state, direction = 'inbound') => ({
  type: 'call.ringing',
  timestamp: 'T',
  payload: { call: { id: 'x', direction, state, remoteNumber: '+33612345678' } }
})

const setup = async (
  caps = { ...CAPABILITIES, media: { browserAudio: true } }
) => {
  const services = makeFakeServices(caps)
  const sizes = []
  render(
    <AppLike client={client}>
      <PhoneProvider services={services}>
        <Widget onSize={s => sizes.push(s)} />
      </PhoneProvider>
    </AppLike>
  )
  await act(async () => {})
  return { services, sizes }
}

describe('Widget', () => {
  it('asks the host for no room while there is nothing to show', async () => {
    const { sizes } = await setup()
    expect(sizes.at(-1)).toEqual({ width: 0, height: 0 })
  })

  it('shows an incoming call with the contact and lets the user decline', async () => {
    // without browser audio the widget cannot answer, but the card must still appear and offer to decline
    const { services } = await setup({ ...CAPABILITIES })
    await act(async () => services.emit(ev('ringing')))
    expect(screen.getByText('Camille Martin')).toBeInTheDocument()
    expect(screen.getByLabelText('Decline')).toBeInTheDocument()
    expect(screen.queryByLabelText('Answer')).toBe(null)
    fireEvent.click(screen.getByLabelText('Decline'))
    expect(services.gateway.hangup).toHaveBeenCalledWith('x')
  })

  it('shows the running call with hold and hang up, and asks for room', async () => {
    // call state comes from the Gateway events when the page has no browser audio
    const { services, sizes } = await setup({ ...CAPABILITIES })
    await act(async () =>
      services.emit({ ...ev('connected', 'outbound'), type: 'call.connected' })
    )
    expect(screen.getByTestId('widget-call')).toBeInTheDocument()
    expect(screen.getByLabelText('Hang up')).toBeInTheDocument()
    expect(screen.getByLabelText('Hold')).toBeInTheDocument()
    expect(sizes.at(-1).width).toBe(360)
  })
})
