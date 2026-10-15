import { describe, expect, it } from 'vitest'
import { chosenStatus, DEFAULT_DELAY_SEC, formFromRules, fromLocalInput, refusalKey, rulesFromForm, toLocalInput } from './callRules.js'
import en from './i18n/en.json'
import fr from './i18n/fr.json'

describe('forwarding form', () => {
  it('shows the rules in fields, and an empty field for each case without forward', () => {
    expect(formFromRules({})).toEqual({ always: '', busy: '', noAnswer: '', delaySec: String(DEFAULT_DELAY_SEC) })
    expect(formFromRules({ busy: '103', noAnswer: { target: '104', delaySec: 8 } })).toEqual({ always: '', busy: '103', noAnswer: '104', delaySec: '8' })
  })

  it('turns the fields back into rules, spaces removed, the empty ones left out', () => {
    expect(rulesFromForm({ always: ' 1 03 ', busy: '', noAnswer: '   ', delaySec: '5' })).toEqual({ always: '103' })
    expect(rulesFromForm({ always: '', busy: '104', noAnswer: '105', delaySec: '12' })).toEqual({ busy: '104', noAnswer: { target: '105', delaySec: 12 } })
    // An emptied delay takes the default; one out of bounds goes as typed, for the Gateway to refuse it in words.
    expect(rulesFromForm({ always: '', busy: '', noAnswer: '105', delaySec: '' }).noAnswer).toEqual({ target: '105', delaySec: DEFAULT_DELAY_SEC })
    expect(rulesFromForm({ always: '', busy: '', noAnswer: '105', delaySec: '500' }).noAnswer).toEqual({ target: '105', delaySec: 500 })
  })
})

describe('refusalKey', () => {
  it('puts each reason the Gateway gives into words, in both languages', () => {
    for (const code of ['FORWARD_SELF', 'FORWARD_NOT_EXTENSION', 'FORWARD_DELAY', 'PRESENCE_UNTIL', 'PRESENCE_MESSAGE']) {
      const key = refusalKey({ status: 400, code })
      expect(key, code).toBeDefined()
      expect((fr as Record<string, string>)[key!], code).toBeTruthy()
      expect((en as Record<string, string>)[key!], code).toBeTruthy()
    }
    expect(refusalKey({ status: 400, code: 'SOMETHING_ELSE' })).toBeUndefined()
    expect(refusalKey(new Error('offline'))).toBeUndefined()
    expect(refusalKey(null)).toBeUndefined()
  })
})

describe('end date of a presence', () => {
  it('goes from an instant to the field and back, to the minute, in the browser time zone', () => {
    const iso = '2026-10-15T14:30:00.000Z'
    const local = toLocalInput(iso)
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(fromLocalInput(local)).toBe(iso)
    expect(fromLocalInput(toLocalInput('2026-10-15T14:30:59.999Z'))).toBe(iso)
  })

  it('means no end when the field or the instant is empty or not a date', () => {
    expect(toLocalInput(undefined)).toBe('')
    expect(toLocalInput('soon')).toBe('')
    expect(fromLocalInput('')).toBeUndefined()
    expect(fromLocalInput('2026-13-45T99:99')).toBeUndefined()
  })

  it('shows the status chosen, available when none was or it is not one a person chooses', () => {
    expect(chosenStatus({ status: 'dnd', since: '2026-10-15T08:00:00.000Z' })).toBe('dnd')
    expect(chosenStatus({ status: 'busy', since: '2026-10-15T08:00:00.000Z' })).toBe('available')
    expect(chosenStatus(undefined)).toBe('available')
  })
})
