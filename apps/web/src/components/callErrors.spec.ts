import { CallError } from '@twake/softphone'
import { describe, expect, it } from 'vitest'
import { describeConferenceError } from './callErrors.js'

// The key and its parameters, as the person would read them once translated.
const t = (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key)
const gateway = (code: string) => Object.assign(new Error(code), { code })

describe('describeConferenceError', () => {
  it('tells a conference that did not begin from a third participant who could not be reached once it had (review 8b, n°4)', () => {
    expect(describeConferenceError(gateway('DIAL_FAILED'), t, { making: true, who: '103' })).toBe('conference.errorNotStarted')
    // Its call ended meanwhile (481, second review 8b, n°9): not « the call goes on ».
    expect(describeConferenceError(Object.assign(gateway('DIAL_FAILED'), { callOver: true }), t, { making: true, who: '103' })).toBe('conference.errorCallOver')
    // The conference was made, the call to the third participant failed: that call's error, the conference goes on.
    const third = Object.assign(gateway('DIAL_FAILED'), { conferenceMade: true })
    expect(describeConferenceError(third, t, { making: true, who: '103' })).toBe('conference.errorDialFailed {"who":"103"}')
    expect(describeConferenceError(gateway('DIAL_FAILED'), t, { who: '103' })).toBe('conference.errorDialFailed {"who":"103"}')
  })

  it('says why the Gateway did not make it (review 8b, n°3, n°6, n°8, n°10, n°15)', () => {
    expect(describeConferenceError(gateway('CALL_DIVERTED'), t)).toBe('conference.errorUnavailable')
    expect(describeConferenceError(gateway('SIP_SERVER_UNAVAILABLE'), t)).toBe('conference.errorUnavailable')
    expect(describeConferenceError(gateway('CONFERENCE_IN_PROGRESS'), t)).toBe('conference.errorInProgress')
    expect(describeConferenceError(gateway('CONFERENCE_ABANDONED'), t)).toBe('conference.errorAbandoned')
    expect(describeConferenceError(gateway('CONFERENCE_UNSUPPORTED'), t)).toBe('conference.errorUnsupported')
    expect(describeConferenceError(gateway('CONFERENCE_CONFIRMED'), t)).toBe('conference.errorConfirmed')
    expect(describeConferenceError(gateway('CONFERENCE_CANCELLED'), t)).toBe('conference.errorCancelled')
  })

  it('says why the window did not ask for it: a call on hold, a conference already being made (review 8b, n°1, n°6)', () => {
    expect(describeConferenceError(new CallError('call-held', 'held'), t)).toBe('conference.errorHeld {"status":""}')
    expect(describeConferenceError(new CallError('conference-pending', 'pending'), t)).toBe('conference.errorInProgress {"status":""}')
  })
})
