import { describe, expect, it } from 'vitest'
import { chosenStatus, DEFAULT_DELAY_SEC, delayValid, formFromRules, fromLocalInput, refusalKey, rulesFromForm, statusOptions, timedStatus, toLocalInput } from './callRules.js'
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
    // An emptied delay takes the default; any other goes as typed, never replaced silently.
    expect(rulesFromForm({ always: '', busy: '', noAnswer: '105', delaySec: '' }).noAnswer).toEqual({ target: '105', delaySec: DEFAULT_DELAY_SEC })
    expect(rulesFromForm({ always: '', busy: '', noAnswer: '105', delaySec: '500' }).noAnswer).toEqual({ target: '105', delaySec: 500 })
  })

  it('refuses before sending a delay the Gateway would not take, when there is a no-answer forward', () => {
    const form = (delaySec: string, noAnswer = '105') => ({ always: '', busy: '', noAnswer, delaySec })
    for (const ok of ['', '5', '20', '120', ' 30 ']) expect(delayValid(form(ok)), ok).toBe(true)
    for (const bad of ['4', '2', '121', '7.5', 'abc', '1e3x', '-10']) expect(delayValid(form(bad)), bad).toBe(false)
    // Without a no-answer forward the delay says nothing.
    expect(delayValid(form('abc', ' '))).toBe(true)
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

  it('shows the status chosen as it is, available when none was, and offers it back so a save keeps it', () => {
    expect(chosenStatus({ status: 'dnd', since: '2026-10-15T08:00:00.000Z' })).toBe('dnd')
    // Set through the API: shown, not turned into "available" (a save would overwrite it).
    expect(chosenStatus({ status: 'busy', since: '2026-10-15T08:00:00.000Z' })).toBe('busy')
    expect(chosenStatus(undefined)).toBe('available')
    expect(statusOptions('dnd')).toEqual(['available', 'away', 'dnd'])
    expect(statusOptions('busy')).toEqual(['available', 'away', 'dnd', 'busy'])
    expect(['available', 'away', 'dnd', 'busy', 'offline'].map(s => timedStatus(s as never))).toEqual([false, true, true, false, false])
  })
})
