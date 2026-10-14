/* eslint-disable import/order */
import 'cozy-ui/transpiled/react/stylesheet.css'
import 'cozy-ui/dist/cozy-ui.utils.min.css'
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/plus-jakarta-sans/800.css'
import '@/styles/phone.css'

import React from 'react'
import { createRoot } from 'react-dom/client'
import CozyClient, { CozyProvider } from 'cozy-client'
import flag from 'cozy-flags'
import Intents from 'cozy-interapp'
import { I18n, initTranslation } from 'twake-i18n'

import manifest from '../../../manifest.webapp'

import { toDialTarget } from '@twake/telephony-client'
import { Widget } from '@/components/Widget'
import schema from '@/doctypes'
import { requestDial } from '@/telephony/dialBridge'
import { PhoneProvider } from '@/telephony/PhoneProvider'

const WIDGET_TYPE = 'io.twake.phone.widget'

const makeClient = data =>
  new CozyClient({
    uri: `${window.location.protocol}//${data.domain}`,
    token: data.token,
    appMetadata: { slug: manifest.slug, version: manifest.version },
    schema
  })

const init = async () => {
  const container = document.querySelector('[role=application]')
  const data = JSON.parse(container.dataset.cozy)
  const client = makeClient(data)
  const intentId = new URLSearchParams(window.location.search).get('intent')
  const service = await new Intents({ client }).createService(intentId, window)
  const intent = service.getIntent()

  if (intent.attributes.type === WIDGET_TYPE) {
    // Persistent widget: the host keeps this page mounted; nothing ever terminates the intent.
    // The Gateway URL is a Cozy flag: it must be loaded before the services are created.
    try {
      await flag.initialize(client)
    } catch {
      // without flags the widget reports the Gateway as unavailable
    }
    const lang = data.locale ?? 'en'
    const polyglot = initTranslation(lang, l => require(`@/locales/${l}`))
    document.body.classList.add('ph-widget-body')
    createRoot(container).render(
      <CozyProvider client={client}>
        <I18n lang={lang} polyglot={polyglot}>
          <PhoneProvider>
            <Widget
              onSize={size => service.resizeClient(size)}
              instanceDomain={data.domain}
            />
          </PhoneProvider>
        </I18n>
      </CozyProvider>
    )
    return
  }

  // CALL: validate the number, then ask a Phone window that is already registered to dial it (see dialBridge).
  // Anything that is not a number is refused rather than dialled.
  const { number } = service.getData() || {}
  const target =
    typeof number === 'string' && number.length <= 40
      ? toDialTarget(number)
      : null
  if (!target)
    return service.terminate({ handled: false, reason: 'invalid-number' })
  const result = await requestDial(target)
  service.terminate({ ...result, number: target })
}

document.addEventListener('DOMContentLoaded', init)
