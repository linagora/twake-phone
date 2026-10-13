import { formatNumber, toDialTarget } from '@twake/telephony-client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useI18n } from 'twake-i18n'

import { Avatar } from '@/components/Avatar'
import { Backspace, Phone } from '@/components/Icons'
import { PresencePicker } from '@/components/PresencePicker'
import { RecentsList } from '@/components/RecentsList'
import { usePhone } from '@/telephony/PhoneProvider'
import { useContactSuggestion } from '@/telephony/useContactName'

const KEYS = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', '']
]
const TYPED = /^[0-9+*#]$/

export { toDialTarget }

export const Dialer = () => {
  const { t } = useI18n()
  const { status, me, actions, capabilities, registration } = usePhone()
  const [number, setNumber] = useState('')
  const [error, setError] = useState(null)
  const [calling, setCalling] = useState(false)
  const suggestion = useContactSuggestion(number)
  const [params, setParams] = useSearchParams()

  const dial = useCallback(
    async raw => {
      const target = toDialTarget(raw.trim())
      if (!target) return setError(t('dialer.invalid'))
      setError(null)
      setCalling(true)
      try {
        await actions.dial(target)
        setNumber('')
      } catch (e) {
        setError(e.message)
      } finally {
        setCalling(false)
      }
    },
    [actions, t]
  )
  // With audio in the browser, the own softphone must be registered: it answers the first leg of the call.
  const ready =
    status === 'ready' &&
    (!capabilities?.media.browserAudio || registration === 'registered')
  const canCall = number.length > 0 && ready && !calling

  // Opened by a "call this number" link with no Phone window around: dial it as soon as the page is ready.
  const requested = useRef(params.get('dial'))
  useEffect(() => {
    const wanted = requested.current
    if (!wanted || !ready) return
    requested.current = null
    setParams({}, { replace: true })
    if (toDialTarget(wanted)) dial(wanted)
    else setError(t('dialer.invalid'))
  }, [ready, dial, setParams, t])

  // The keypad is also driven from the physical keyboard and by pasting.
  useEffect(() => {
    const onKey = e => {
      if (
        e.target.closest?.('input, textarea, select') ||
        e.metaKey ||
        e.ctrlKey
      )
        return
      if (TYPED.test(e.key)) setNumber(n => n + e.key)
      else if (e.key === 'Backspace') setNumber(n => n.slice(0, -1))
      else if (e.key === 'Enter' && canCall) dial(number)
    }
    const onPaste = e => {
      if (e.target.closest?.('input, textarea')) return
      const pasted = (e.clipboardData?.getData('text') ?? '').replace(
        /[^0-9+*#]/g,
        ''
      )
      if (pasted) setNumber(n => n + pasted)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [canCall, dial, number])

  return (
    <>
      <div className="ph-mhead">
        <PresencePicker variant="pill" />
        <div className="ph-avatar is-me">
          {(me?.displayName ?? '?').slice(0, 2).toUpperCase()}
        </div>
      </div>
      <section className="ph-panel ph-pad" aria-label={t('nav.dialer')}>
        <div className="ph-display">
          <div
            className={`ph-number ${number ? '' : 'is-empty'}`}
            aria-live="polite"
          >
            {number ? formatNumber(number, 'FR') : t('dialer.placeholder')}
          </div>
          {number && (
            <button
              type="button"
              className="ph-icon-btn ph-erase"
              aria-label={t('dialer.erase')}
              onClick={() => setNumber(n => n.slice(0, -1))}
            >
              <Backspace />
            </button>
          )}
        </div>
        {suggestion && (
          <div className="ph-chip" data-testid="suggestion">
            <Avatar label={suggestion.displayName} known />
            <div>
              <b>{suggestion.displayName}</b>
              {suggestion.company && (
                <span className="muted"> · {suggestion.company}</span>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="ph-error" role="alert">
            {error}
          </div>
        )}
        <div className="ph-keys">
          {KEYS.map(([digit, letters]) => (
            <button
              key={digit}
              type="button"
              className="ph-key"
              aria-label={digit}
              onClick={() => setNumber(n => n + digit)}
            >
              <span className="d">{digit}</span>
              <span className="l">{letters}</span>
            </button>
          ))}
        </div>
        <div className="ph-callrow">
          <button
            type="button"
            className="ph-call"
            aria-label={t('dialer.call')}
            disabled={!canCall}
            onClick={() => dial(number)}
          >
            <Phone size={30} />
          </button>
        </div>
      </section>
      <section
        className="ph-panel ph-recents is-pad-sibling"
        aria-label={t('recents.title')}
      >
        <RecentsList limit={6} onRecall={dial} />
      </section>
    </>
  )
}
