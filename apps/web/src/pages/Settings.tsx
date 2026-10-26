import { RING_TEST_MS } from '@twake/softphone'
import { Alert, Button, Card, CardContent, Stack, TextField, Typography } from '@linagora/twake-mui'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider.js'
import { displayNameFor } from '../auth/oidc.js'
import type { AppConfig } from '../config.js'
import { useGateway } from '../gateway.js'
import { LANGS, type Lang } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { usePhone } from '../softphone.js'
import { EmergencySiteSettings, ForwardingSettings, PresenceSettings } from './CallRulesSettings.js'
import { NotificationSettings } from './NotificationSettings.js'

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
      <TextField
        select
        id={id}
        label={t(LABEL_KEY[key])}
        value={chosen}
        onChange={e => choose(key)(e.target.value)}
        disabled={!list.length && !unplugged}
        fullWidth
        className="u-mb-1"
        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      >
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
      </TextField>
    )
  }
  return (
    <Card component="section" variant="outlined" aria-labelledby="audio" className="u-mb-1">
      <CardContent>
      <Typography variant="h5" component="h2" id="audio" gutterBottom>
        {t('settings.audio')}
      </Typography>
      {!devices.labelled ? (
        <Typography component="p" className="u-mb-1">
          {t('settings.allowMicrophoneHint')}{' '}
          <Button variant="outlined" onClick={() => void allow()}>
            {t('settings.allowMicrophone')}
          </Button>
        </Typography>
      ) : null}
      {select('microphone', 'microphoneId', devices.inputs, 'microphone')}
      {canChooseOutput ? (
        <>
          {select('output', 'outputId', devices.outputs, 'output')}
          {select('ringer', 'ringerId', devices.outputs, 'output')}
        </>
      ) : (
        <Typography variant="body2" color="textSecondary" component="p" className="u-mb-1">
          {t('settings.outputUnsupported')}
        </Typography>
      )}
      <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-mb-1">
        <Button variant="outlined" onClick={() => void ringTest()} disabled={ringing || phone.state === 'off'} aria-busy={ringing}>
          {t('settings.testRing')}
        </Button>
      </Stack>
      {phone.state === 'off' ? (
        <Typography variant="body2" color="textSecondary" component="p">
          {t('settings.audioNeedsPhone')}
        </Typography>
      ) : null}
      {error ? (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      ) : null}
      </CardContent>
    </Card>
  )
}

export const Settings = ({ config }: { config: AppConfig }) => {
  const { t, lang, setLang } = useT()
  const { state } = useAuth()
  const { me, meError } = useGateway()
  const user = state.status === 'signed-in' ? state.user : null
  return (
    <>
      <Typography variant="h4" component="h1" gutterBottom>
        {t('settings.title')}
      </Typography>
      <Card component="section" variant="outlined" aria-labelledby="account" className="u-mb-1">
        <CardContent>
          <Typography variant="h5" component="h2" id="account" gutterBottom>
            {t('settings.account')}
          </Typography>
          <Typography component="p">
            <strong>{displayNameFor(me, user)}</strong>
            <br />
            {typeof user?.profile.email === 'string' ? user.profile.email : null}
            <br />
            {me ? (me.extension ? t('auth.extension', { extension: me.extension }) : t('auth.noExtension')) : null}
          </Typography>
          {meError ? (
            <Alert severity="error" role="alert" className="u-mt-1">
              {meError}
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      {me ? (
        <>
          <PresenceSettings />
          <ForwardingSettings />
          <EmergencySiteSettings />
          <NotificationSettings userId={me.id} />
        </>
      ) : null}
      <Card component="section" variant="outlined" aria-labelledby="language" className="u-mb-1">
        <CardContent>
          <Typography variant="h5" component="h2" id="language" gutterBottom>
            {t('settings.language')}
          </Typography>
          <TextField
            select
            id="lang"
            label={t('settings.languageLabel')}
            value={lang}
            onChange={e => setLang(e.target.value as Lang)}
            fullWidth
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          >
            {LANGS.map(l => (
              <option key={l} value={l}>
                {l === 'fr' ? 'Français' : 'English'}
              </option>
            ))}
          </TextField>
        </CardContent>
      </Card>
      <AudioSettings />
      <Card component="section" variant="outlined" aria-labelledby="gateway" className="u-mb-1">
        <CardContent>
          <Typography variant="h5" component="h2" id="gateway" gutterBottom>
            {t('settings.gateway')}
          </Typography>
          <Typography component="p">
            <code>{config.gatewayUrl}</code>
          </Typography>
        </CardContent>
      </Card>
    </>
  )
}
