import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import AppLike from 'test/AppLike'

import { createMockClient } from 'cozy-client'

import { RecentsList } from '@/components/RecentsList'
import { PhoneProvider } from '@/telephony/PhoneProvider'
import { makeFakeServices } from '@/telephony/fakeServices'

const client = createMockClient({
  queries: {
    'io.cozy.contacts/allContacts': {
      doctype: 'io.cozy.contacts',
      data: [
        {
          _id: 'a',
          _type: 'io.cozy.contacts',
          displayName: 'Camille Martin',
          phone: [{ number: '06 12 34 56 78', type: 'cell' }]
        }
      ]
    }
  }
})
const now = Date.now()
const iso = ms => new Date(ms).toISOString()

describe('RecentsList', () => {
  const history = [
    {
      id: '1',
      direction: 'inbound',
      remoteNumber: '+33612345678',
      startedAt: iso(now),
      durationSec: 252,
      missed: false,
      answered: true
    },
    {
      id: '2',
      direction: 'inbound',
      remoteNumber: '+33671842209',
      startedAt: iso(now - 1000),
      durationSec: 0,
      missed: true,
      answered: false
    },
    {
      id: '3',
      direction: 'outbound',
      remoteNumber: '102',
      startedAt: iso(now - 2000),
      durationSec: 63,
      missed: false,
      answered: true
    }
  ]

  const setup = onRecall =>
    render(
      <AppLike client={client}>
        <PhoneProvider services={makeFakeServices(undefined, history)}>
          <RecentsList onRecall={onRecall} />
        </PhoneProvider>
      </AppLike>
    )

  it('lists calls read from the Gateway, with the contact name, kind and duration', async () => {
    setup(jest.fn())
    expect(await screen.findAllByTestId('recent-call')).toHaveLength(3)
    expect(screen.getByText('Camille Martin')).toBeInTheDocument()
    expect(screen.getByText('Mobile · 4 min 12')).toBeInTheDocument()
  })

  it('filters missed calls and searches', async () => {
    setup(jest.fn())
    await screen.findAllByTestId('recent-call')
    fireEvent.click(screen.getByRole('button', { name: 'Missed' }))
    expect(screen.getAllByTestId('recent-call')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'camille' }
    })
    expect(screen.getAllByTestId('recent-call')).toHaveLength(1)
  })

  it('calls back in one tap', async () => {
    const onRecall = jest.fn()
    setup(onRecall)
    fireEvent.click(await screen.findByLabelText('Call back 102'))
    expect(onRecall).toHaveBeenCalledWith('102')
  })
})
