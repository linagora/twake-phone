import React, { useCallback } from 'react'

import { useExternalBridge } from 'cozy-external-bridge-container'
import flag from 'cozy-flags'
import { useI18n } from 'twake-i18n'

import { useCallsRelay } from '@/callsRelay'
import { useDialRelay } from '@/dialRelay'

/** What TwakePhone (apps/web, src/embedded.ts) reads from its parent: a number to put in its dialer, and its answer. */
const DIAL_MESSAGE = 'twakephone.dial'
const DIAL_ACK = 'twakephone.dial-ack'
/** How long the frame has to answer: a frame not signed in never does, and the number goes to a new tab. */
const ACK_MS = 1_000

/** Posts `number` to the frame and resolves whether it took it (its answer, from its origin, within ACK_MS). */
const postToFrame = (frame, origin, number) =>
  new Promise(resolve => {
    const id = crypto.randomUUID()
    const done = ok => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(ok)
    }
    const onMessage = event => {
      if (event.source === frame && event.origin === origin && event.data?.type === DIAL_ACK && event.data.id === id) done(true)
    }
    window.addEventListener('message', onMessage)
    const timer = setTimeout(() => done(false), ACK_MS)
    frame.postMessage({ type: DIAL_MESSAGE, number, id }, origin)
  })

const Phone = ({ url }) => {
  const { isReady, urlToLoad } = useExternalBridge(url)
  // The CALL intent of another app reaches the dialer of this frame (never dialled: TwakePhone waits for the click).
  const dial = useCallback(
    async number => {
      const frame = document.getElementById('embeddedApp')?.contentWindow
      return frame ? postToFrame(frame, new URL(url).origin, number) : false
    },
    [url]
  )
  useDialRelay({ enabled: isReady, dial })
  useCallsRelay({ enabled: isReady, frameOrigin: new URL(url).origin })

  // The bridge needs the iframe element before it is ready: it is there from the start, without a source.
  return (
    <iframe
      id="embeddedApp"
      title="Twake Phone"
      src={isReady ? urlToLoad : null}
      allow="microphone; autoplay; clipboard-write"
    ></iframe>
  )
}

const App = () => {
  const { t } = useI18n()
  const url = flag('phone.embedded-app-url')
  if (!url) return <p role="alert">{t('notConfigured')}</p>
  return <Phone url={url} />
}

export default App
