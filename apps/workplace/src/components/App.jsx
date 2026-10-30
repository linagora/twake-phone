import React, { useCallback } from 'react'

import { useExternalBridge } from 'cozy-external-bridge-container'
import flag from 'cozy-flags'
import { useI18n } from 'twake-i18n'

import { useDialRelay } from '@/dialRelay'

/** What TwakePhone (apps/web, src/embedded.ts) reads from its parent: a number to put in its dialer. */
const DIAL_MESSAGE = 'twakephone.dial'

const Phone = ({ url }) => {
  const { isReady, urlToLoad } = useExternalBridge(url)
  // The CALL intent of another app reaches the dialer of this frame (never dialled: TwakePhone waits for the click).
  const dial = useCallback(
    number => {
      const frame = document.getElementById('embeddedApp')?.contentWindow
      if (!frame) return false
      frame.postMessage({ type: DIAL_MESSAGE, number }, new URL(url).origin)
      return true
    },
    [url]
  )
  useDialRelay({ enabled: isReady, dial })

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
