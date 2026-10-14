import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import AppLike from 'test/AppLike'

import { createMockClient } from 'cozy-client'

import { Dialer, toDialTarget } from '@/components/Views/Dialer'
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
          company: 'Acme Logistique',
          phone: [{ number: '06 12 48 90 17' }]
        }
      ]
    }
  }
})

const renderDialer = services =>
  render(
    <AppLike client={client}>
      <PhoneProvider services={services}>
        <Dialer />
      </PhoneProvider>
    </AppLike>
  )

const press = digits =>
  digits.split('').forEach(d => fireEvent.click(screen.getByLabelText(d)))
const ready = () =>
  waitFor(() => expect(screen.getByLabelText('Call').disabled).toBe(true))

describe('toDialTarget', () => {
  it('keeps internal extensions and normalises external numbers', () => {
    expect(toDialTarget('102')).toBe('102')
    expect(toDialTarget('0612345678')).toBe('+33612345678')
    expect(toDialTarget('0328001234x')).toBe(null)
  })
})

describe('Dialer', () => {
  it('starts a call through the Gateway with the normalised target', async () => {
    const services = makeFakeServices()
    renderDialer(services)
    await ready()

    press('102')
    await waitFor(() =>
      expect(screen.getByLabelText('Call').disabled).toBe(false)
    )
    await act(async () => fireEvent.click(screen.getByLabelText('Call')))

    expect(services.gateway.originate).toHaveBeenCalledWith(
      '102',
      expect.any(String)
    )
  })

  it('shows the number as it is typed, grouped, and the matching contact', async () => {
    renderDialer(makeFakeServices())
    await ready()

    press('061248')

    expect(screen.getByText('06 12 48')).toBeInTheDocument()
    expect(screen.getByTestId('suggestion')).toHaveTextContent('Camille Martin')
    expect(screen.getByTestId('suggestion')).toHaveTextContent(
      'Acme Logistique'
    )
  })

  it('erases the last digit', async () => {
    renderDialer(makeFakeServices())
    await ready()
    press('102')
    fireEvent.click(screen.getByLabelText('Erase'))
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('accepts digits typed on the physical keyboard', async () => {
    renderDialer(makeFakeServices())
    await ready()
    fireEvent.keyDown(window, { key: '1' })
    fireEvent.keyDown(window, { key: '0' })
    fireEvent.keyDown(window, { key: '3' })
    expect(screen.getByText('103')).toBeInTheDocument()
  })

  it('rejects a number that is not valid', async () => {
    const services = makeFakeServices()
    renderDialer(services)
    await ready()
    press('0*')
    await waitFor(() =>
      expect(screen.getByLabelText('Call').disabled).toBe(false)
    )
    fireEvent.click(screen.getByLabelText('Call'))

    expect(
      await screen.findByText('This is not a valid phone number')
    ).toBeInTheDocument()
    expect(services.gateway.originate).not.toHaveBeenCalled()
  })

  it('switches presence to do-not-disturb through the Gateway', async () => {
    const services = makeFakeServices()
    renderDialer(services)

    fireEvent.click(await screen.findByRole('button', { name: /Available/ }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Do not disturb' })
    )

    await waitFor(() =>
      expect(services.gateway.setPresence).toHaveBeenCalledWith('dnd')
    )
  })
})
