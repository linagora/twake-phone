import { RING_TEST_MS } from '@twake/softphone'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider.js'
import { displayNameFor } from '../auth/oidc.js'
import type { AppConfig } from '../config.js'
import { useGateway } from '../gateway.js'
import { LANGS, type Lang } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { usePhone } from '../softphone.js'

type Device = { id: string; label: string }
type Devices = { inputs: Device[]; outputs: Device[]; labelled: boolean }
type DeviceKey = 'microphoneId' | 'outputId' | 'ringerId'

const LABEL_KEY = { microphoneId: 'settings.microphone', outputId: 'settings.output', ringerId: 'settings.ringer' } as const

const canChooseOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/**
 * The browser's audio devices. Before the microphone was allowed, browsers list one nameless device per kind, or
 * none with an id at all: nothing to choose from, the person is told why and offered to allow it.
 */
const enumerate = async (): Promise<Devices> => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], labelled: false }
  const all = await navigator.mediaDevices.enumerateDevices()
  const of = (kind: MediaDeviceKind) => all.filter(d => d.kind === kind && d.deviceId).map(d => ({ id: d.deviceId, label: d.label }))
  const inputs = of('audioinput')
  const outputs = of('audiooutput')
  return { inputs, outputs, labelled: all.some(d => d.kind === 'audioinput' && d.label) }
}

/**
 * Microphone, output and ringtone device. Kept in this browser (not on the server: a headset belongs to a desk,
 * not to a person), applied to the call in progress at once, and refreshed when a device is plugged or unplugged.
 */
const AudioSettings = () => {
  const { t } = useT()
  const phone = usePhone()
  const [devices, setDevices] = useState<Devices>({ inputs: [], outputs: [], labelled: true })
  const [ringing, setRinging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    enumerate()
      .then(d => !cancelled && setDevices(d))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [phone.devicesVersion])
  const allow = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => track.stop())
      setError(null)
      setDevices(await enumerate())
    } catch (err) {
      setError(t(err instanceof Error && err.name === 'NotAllowedError' ? 'settings.microphoneRefused' : 'settings.microphoneError'))
    }
  }
  const choose = (key: DeviceKey) => (id: string) => {
    const next = { ...phone.devices }
    delete next[key]
    phone.setDevices(id ? { ...next, [key]: id } : next)
  }
  const ringTest = async () => {
    setRinging(true)
    try {
      await phone.ringTest()
      await new Promise(r => setTimeout(r, RING_TEST_MS))
    } finally {
      setRinging(false)
    }
  }
  const label = (d: Device, kind: 'microphone' | 'output', index: number) => d.label || t(kind === 'microphone' ? 'settings.unnamedMicrophone' : 'settings.unnamedOutput', { n: index + 1 })
  const select = (id: string, key: DeviceKey, list: Device[], kind: 'microphone' | 'output') => {
    const chosen = phone.devices[key] ?? ''
    // A chosen device the browser does not list right now (a headset unplugged): the choice stays, and says so.
    const unplugged = chosen && !list.some(d => d.id === chosen)
    return (
      <div className="field">
        <label htmlFor={id}>{t(LABEL_KEY[key])}</label>
        <select id={id} value={chosen} onChange={e => choose(key)(e.target.value)} disabled={!list.length && !unplugged}>
          <option value="">{t('settings.defaultDevice')}</option>
          {unplugged ? (
            <option value={chosen} disabled>
              {t('settings.unpluggedDevice')}
            </option>
          ) : null}
          {list.map((d, i) => (
            <option key={d.id} value={d.id}>
              {label(d, kind, i)}
            </option>
          ))}
        </select>
      </div>
    )
  }
  return (
    <section className="card" aria-labelledby="audio">
      <h2 id="audio">{t('settings.audio')}</h2>
      {!devices.labelled ? (
        <p>
          {t('settings.allowMicrophoneHint')}{' '}
          <button type="button" className="btn" onClick={() => void allow()}>
            {t('settings.allowMicrophone')}
          </button>
        </p>
      ) : null}
      {select('microphone', 'microphoneId', devices.inputs, 'microphone')}
      {canChooseOutput ? (
        <>
          {select('output', 'outputId', devices.outputs, 'output')}
          {select('ringer', 'ringerId', devices.outputs, 'output')}
        </>
      ) : (
        <p className="badge">{t('settings.outputUnsupported')}</p>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={() => void ringTest()} disabled={ringing || phone.state === 'off'} aria-busy={ringing}>
          {t('settings.testRing')}
        </button>
      </div>
      {phone.state === 'off' ? <p className="badge">{t('settings.audioNeedsPhone')}</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export const Settings = ({ config }: { config: AppConfig }) => {
  const { t, lang, setLang } = useT()
  const { state } = useAuth()
  const { me, meError } = useGateway()
  const user = state.status === 'signed-in' ? state.user : null
  return (
    <>
      <h1>{t('settings.title')}</h1>
      <section className="card" aria-labelledby="account">
        <h2 id="account">{t('settings.account')}</h2>
        <p>
          <strong>{displayNameFor(me, user)}</strong>
          <br />
          {typeof user?.profile.email === 'string' ? user.profile.email : null}
          <br />
          {me ? (me.extension ? t('auth.extension', { extension: me.extension }) : t('auth.noExtension')) : null}
        </p>
        {meError ? (
          <p className="alert alert-error" role="alert">
            {meError}
          </p>
        ) : null}
      </section>
      <section className="card" aria-labelledby="language">
        <h2 id="language">{t('settings.language')}</h2>
        <div className="field">
          <label htmlFor="lang">{t('settings.languageLabel')}</label>
          <select id="lang" value={lang} onChange={e => setLang(e.target.value as Lang)}>
            {LANGS.map(l => (
              <option key={l} value={l}>
                {l === 'fr' ? 'Français' : 'English'}
              </option>
            ))}
          </select>
        </div>
      </section>
      <AudioSettings />
      <section className="card" aria-labelledby="gateway">
        <h2 id="gateway">{t('settings.gateway')}</h2>
        <p>
          <code>{config.gatewayUrl}</code>
        </p>
      </section>
    </>
  )
}
