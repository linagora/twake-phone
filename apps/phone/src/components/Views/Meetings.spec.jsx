import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import AppLike from 'test/AppLike'

import { createMockClient } from 'cozy-client'

import { Meetings } from '@/components/Views/Meetings'
import { PhoneProvider } from '@/telephony/PhoneProvider'
import { CAPABILITIES, makeFakeServices } from '@/telephony/fakeServices'

const client = createMockClient({})

const setup = async () => {
  const services = makeFakeServices({
    ...CAPABILITIES,
    conference: { dialIn: true, dialOut: true }
  })
  render(
    <AppLike client={client}>
      <PhoneProvider services={services}>
        <Meetings />
      </PhoneProvider>
    </AppLike>
  )
  await waitFor(() => expect(services.gateway.getMe).toHaveBeenCalled())
  return services
}

const enable = async (value = 'https://meet.twake.local/abc-defg-hij') => {
  fireEvent.change(screen.getByLabelText('Meet link or code'), {
    target: { value }
  })
  fireEvent.click(screen.getByText('Enable phone access'))
}

describe('Meetings', () => {
  it('rejects an input that is not a room', async () => {
    const { gateway } = await setup()
    await enable('not a room')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a Meet link or room code'
    )
    expect(gateway.createConference).not.toHaveBeenCalled()
  })

  it('enables phone access from a Meet link and shows the number and PIN', async () => {
    const { gateway } = await setup()
    await enable()
    expect(await screen.findByText('123456')).toBeTruthy()
    expect(screen.getByText('8000')).toBeTruthy()
    expect(gateway.openConference).toHaveBeenCalledWith('abc-defg-hij')
    expect(
      screen.getByText('https://meet.twake.local/abc-defg-hij')
    ).toBeTruthy()
    expect(await screen.findByText('Bob')).toBeTruthy()
  })

  it('calls a number into the room, normalised, and clears the field', async () => {
    const { gateway } = await setup()
    await enable('abc-defg-hij')
    await screen.findByText('Bob')
    const field = screen.getByLabelText('Number to call')
    fireEvent.change(field, { target: { value: '06 12 34 56 78' } })
    fireEvent.click(screen.getByText('Call'))
    await waitFor(() =>
      expect(gateway.inviteByPhone).toHaveBeenCalledWith(
        'id-abc-defg-hij',
        '+33612345678'
      )
    )
    await waitFor(() => expect(field.value).toBe(''))
  })

  it('refuses an invalid number without calling the Gateway', async () => {
    const { gateway } = await setup()
    await enable('abc-defg-hij')
    await screen.findByText('Bob')
    fireEvent.change(screen.getByLabelText('Number to call'), {
      target: { value: '12ab' }
    })
    fireEvent.click(screen.getByText('Call'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'valid phone number'
    )
    expect(gateway.inviteByPhone).not.toHaveBeenCalled()
  })

  it('mutes and removes a participant, and refreshes on conference events', async () => {
    const { gateway, emit } = await setup()
    await enable('abc-defg-hij')
    await screen.findByText('Bob')
    fireEvent.click(screen.getByText('Mute'))
    await waitFor(() =>
      expect(gateway.muteParticipant).toHaveBeenCalledWith(
        'id-abc-defg-hij',
        'abc-defg-hij:web1'
      )
    )
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() =>
      expect(gateway.removeParticipant).toHaveBeenCalledWith(
        'id-abc-defg-hij',
        'abc-defg-hij:web1'
      )
    )
    const before = gateway.getConference.mock.calls.length
    act(() =>
      emit({
        type: 'conference.participant.joined',
        payload: { participant: { meetingId: 'id-abc-defg-hij' } }
      })
    )
    await waitFor(() =>
      expect(gateway.getConference.mock.calls.length).toBeGreaterThan(before)
    )
  })

  it('creates a new Meet room', async () => {
    const { gateway } = await setup()
    fireEvent.click(screen.getByText('Create a new Meet room'))
    expect(await screen.findByText('654321')).toBeTruthy()
    expect(gateway.createConference).toHaveBeenCalled()
  })

  it('says so when Meet does not show the room', async () => {
    const { gateway } = await setup()
    gateway.openConference.mockRejectedValueOnce(
      new Error('Gateway 404 on /conferences')
    )
    await enable('abc-defg-hij')
    expect(await screen.findByRole('alert')).toHaveTextContent('Room not found')
  })

  it('tells the user when the room belongs to someone else', async () => {
    const { gateway } = await setup()
    gateway.openConference.mockRejectedValueOnce(
      new Error('Gateway 409 on /conferences')
    )
    await enable('abc-defg-hij')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'already managed by someone else'
    )
  })

  it('turns phone access off', async () => {
    const { gateway } = await setup()
    await enable('abc-defg-hij')
    await screen.findByText('Bob')
    fireEvent.click(screen.getByText('Turn off phone access'))
    await waitFor(() =>
      expect(gateway.closeConference).toHaveBeenCalledWith('id-abc-defg-hij')
    )
    expect(await screen.findByText('Enable phone access')).toBeTruthy()
  })
})
