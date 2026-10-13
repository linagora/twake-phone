import {
  formatDuration,
  formatTimer,
  formatWhen,
  initials,
  avatarColors
} from './format'

describe('format', () => {
  it('formats durations and the call timer', () => {
    expect(formatDuration(252)).toBe('4 min 12')
    expect(formatDuration(63)).toBe('1 min 03')
    expect(formatDuration(38)).toBe('38 s')
    expect(formatDuration(0)).toBe('')
    expect(formatTimer(254000)).toBe('04:14')
    expect(formatTimer(3723000)).toBe('1:02:03')
  })

  it('shows the time today, "yesterday", then the weekday', () => {
    const now = new Date('2026-10-05T12:00:00').getTime()
    expect(formatWhen(new Date('2026-10-05T10:42:00').getTime(), { now })).toBe(
      '10:42'
    )
    expect(
      formatWhen(new Date('2026-10-04T10:42:00').getTime(), {
        now,
        yesterday: 'Hier'
      })
    ).toBe('Hier')
    expect(
      formatWhen(new Date('2026-10-01T10:42:00').getTime(), { now, lang: 'fr' })
    ).toMatch(/jeu/i)
  })

  it('derives initials and colours', () => {
    expect(initials('Camille Martin')).toBe('CM')
    expect(initials('+33 6 71 84 22 09')).toBe('+33')
    expect(initials('104')).toBe('#')
    expect(avatarColors('x', false)).toEqual(['#EEF0F6', '#4F566B'])
    expect(avatarColors('Camille', true)).toEqual(avatarColors('Camille', true))
  })
})
