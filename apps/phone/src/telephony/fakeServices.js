// Test double of the services injected into PhoneProvider (no network, no SIP stack).
export const CAPABILITIES = {
  calling: {
    outbound: true,
    inbound: true,
    answer: false,
    hangup: true,
    hold: true,
    transfer: true,
    dtmf: true
  },
  media: { browserAudio: false },
  presence: {
    read: true,
    write: true,
    realtime: true,
    statuses: ['available', 'busy', 'away', 'dnd', 'offline']
  },
  history: false,
  conference: { dialIn: false, dialOut: false }
}

export const makeFakeServices = (capabilities = CAPABILITIES, history = []) => {
  const listeners = []
  const gateway = {
    getCapabilities: jest.fn(async () => capabilities),
    getPresence: jest.fn(async () => ({
      status: 'available',
      source: 'telephony'
    })),
    getHistory: jest.fn(async () => ({ items: history })),
    getMe: jest.fn(async () => ({ id: 'user1', extension: '101' })),
    setPresence: jest.fn(async status => ({ status, source: 'user' })),
    originate: jest.fn(async target => ({
      id: 'c1',
      direction: 'outbound',
      state: 'new',
      remoteNumber: target
    })),
    hangup: jest.fn(async () => {}),
    hold: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    openConference: jest.fn(async slug => ({
      meetingId: `id-${slug}`,
      slug,
      url: `https://meet.twake.local/${slug}`,
      dialIn: {
        numbers: [{ country: 'FR', e164: '8000' }],
        meetingCode: slug,
        pin: '123456'
      }
    })),
    createConference: jest.fn(async () => ({
      meetingId: 'id-new-room',
      slug: 'new-room',
      url: 'https://meet.twake.local/new-room',
      dialIn: {
        numbers: [{ country: 'FR', e164: '8000' }],
        meetingCode: 'new-room',
        pin: '654321'
      }
    })),
    getConference: jest.fn(async meetingId => ({
      meetingId,
      dialIn: { numbers: [], meetingCode: meetingId },
      participants: [
        {
          id: `${meetingId.replace(/^id-/, '')}:web1`,
          meetingId,
          kind: 'web',
          displayName: 'Bob',
          muted: false
        }
      ]
    })),
    closeConference: jest.fn(async () => {}),
    inviteByPhone: jest.fn(async () => ({})),
    removeParticipant: jest.fn(async () => {}),
    muteParticipant: jest.fn(async () => {}),
    connect: jest.fn(onEvent => {
      listeners.push(onEvent)
      return () => {}
    })
  }
  return { gateway, emit: event => listeners.forEach(l => l(event)) }
}
