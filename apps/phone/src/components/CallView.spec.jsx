import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import AppLike from 'test/AppLike'

import { createMockClient } from 'cozy-client'

import { CallView, IncomingOverlay } from '@/components/CallView'
import { CAPABILITIES } from '@/telephony/fakeServices'

const client = createMockClient({
  queries: {
    'io.cozy.contacts/allContacts': {
      doctype: 'io.cozy.contacts',
      data: [
        {
          _id: 'a',
          _type: 'io.cozy.contacts',
          displayName: 'Camille Martin',
          company: 'Acme Logistique',
          jobTitle: 'Buyer',
          phone: [{ number: '06 12 34 56 78' }]
        }
      ]
    }
  }
})
const actions = () => ({
  hangup: jest.fn(),
  hold: jest.fn(),
  resume: jest.fn(),
  mute: jest.fn(),
  dtmf: jest.fn(),
  answer: jest.fn(),
  reject: jest.fn(),
  answerHolding: jest.fn()
})
const connected = {
  id: 'c1',
  direction: 'outbound',
  state: 'connected',
  remoteNumber: '+33612345678',
  connectedAt: Date.now() - 254000
}
const view = (props, caps = CAPABILITIES) => {
  const a = actions()
  render(
    <AppLike client={client}>
      <CallView
        call={connected}
        capabilities={caps}
        actions={a}
        onBack={() => {}}
        {...props}
      />
    </AppLike>
  )
  return a
}

describe('CallView', () => {
  it('shows who is calling, the contact card and the running timer', () => {
    view()
    expect(
      screen.getByRole('heading', { name: 'Camille Martin' })
    ).toBeInTheDocument()
    expect(screen.getByText('Acme Logistique')).toBeInTheDocument()
    expect(screen.getByText('Buyer')).toBeInTheDocument()
    expect(screen.getByText(/In call · 04:1\d/)).toBeInTheDocument()
  })

  it('shows hold and transfer when the provider supports them, but no browser-audio controls', () => {
    view()
    expect(screen.getByText('Hold')).toBeInTheDocument()
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    expect(screen.queryByText('Mute')).toBe(null)
    expect(screen.queryByText('Keypad')).toBe(null)
  })

  it('offers mute and keypad with browser audio', () => {
    view({}, { ...CAPABILITIES, media: { browserAudio: true } })
    expect(screen.getByText('Mute')).toBeInTheDocument()
    expect(screen.getByText('Keypad')).toBeInTheDocument()
  })

  it('hides transfer and hold when capabilities say so', () => {
    view(
      {},
      {
        ...CAPABILITIES,
        calling: { ...CAPABILITIES.calling, transfer: false, hold: false }
      }
    )
    expect(screen.queryByText('Transfer')).toBe(null)
    expect(screen.queryByText('Hold')).toBe(null)
  })

  it('hangs up and holds', () => {
    const a = view()
    fireEvent.click(screen.getByText('Hold'))
    fireEvent.click(screen.getByText('Hang up'))
    expect(a.hold).toHaveBeenCalledWith('c1')
    expect(a.hangup).toHaveBeenCalledWith('c1')
  })

  it('offers to hold the current call and answer a second one', () => {
    const a = view({
      second: {
        id: 'c2',
        direction: 'inbound',
        state: 'ringing',
        remoteNumber: '231'
      }
    })
    fireEvent.click(screen.getByText('Hold current & answer'))
    expect(a.answerHolding).toHaveBeenCalledWith('c2', 'c1')
  })
})

describe('IncomingOverlay', () => {
  const incoming = {
    id: 'i1',
    direction: 'inbound',
    state: 'ringing',
    remoteNumber: '+33612345678'
  }

  it('shows the contact and lets the user answer or decline with browser audio', () => {
    const a = actions()
    render(
      <AppLike client={client}>
        <IncomingOverlay
          call={incoming}
          capabilities={{ ...CAPABILITIES, media: { browserAudio: true } }}
          actions={a}
        />
      </AppLike>
    )
    expect(
      screen.getByRole('heading', { name: 'Camille Martin' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('Answer'))
    fireEvent.click(screen.getByText('Decline'))
    expect(a.answer).toHaveBeenCalledWith('i1')
    expect(a.reject).toHaveBeenCalledWith('i1')
  })

  it('does not offer to answer when the page cannot', () => {
    render(
      <AppLike client={client}>
        <IncomingOverlay
          call={incoming}
          capabilities={CAPABILITIES}
          actions={actions()}
        />
      </AppLike>
    )
    expect(screen.queryByText('Answer')).toBe(null)
    expect(screen.getByText('Decline')).toBeInTheDocument()
  })
})
