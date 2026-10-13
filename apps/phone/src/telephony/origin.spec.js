import { isSameInstanceOrigin } from './origin'

describe('isSameInstanceOrigin', () => {
  it('accepts the apps of the same instance, flat or nested naming', () => {
    expect(
      isSameInstanceOrigin(
        'https://user1-drive.twake.local',
        'user1.twake.local'
      )
    ).toBe(true)
    expect(
      isSameInstanceOrigin(
        'https://user1-mail.twake.local',
        'user1.twake.local'
      )
    ).toBe(true)
    expect(
      isSameInstanceOrigin(
        'https://drive.user1.twake.local',
        'user1.twake.local'
      )
    ).toBe(true)
    expect(
      isSameInstanceOrigin('https://user1.twake.local', 'user1.twake.local')
    ).toBe(true)
  })

  it('refuses another instance, another domain, lookalikes and garbage', () => {
    expect(
      isSameInstanceOrigin(
        'https://user2-drive.twake.local',
        'user1.twake.local'
      )
    ).toBe(false)
    expect(
      isSameInstanceOrigin('https://user1-drive.evil.com', 'user1.twake.local')
    ).toBe(false)
    expect(
      isSameInstanceOrigin(
        'https://user1-drive.twake.local.evil.com',
        'user1.twake.local'
      )
    ).toBe(false)
    expect(
      isSameInstanceOrigin(
        'https://evil-user1-drive.twake.local',
        'user1.twake.local'
      )
    ).toBe(false)
    expect(isSameInstanceOrigin('null', 'user1.twake.local')).toBe(false)
  })

  it('ignores ports (dev setups)', () => {
    expect(
      isSameInstanceOrigin('http://127.0.0.1:5000', '127.0.0.1:6000')
    ).toBe(true)
  })
})
