import CozyClient from 'cozy-client'
import Intents from 'cozy-interapp'

import { toDialTarget } from '@twake/telephony-client'

import manifest from '../../../manifest.webapp'

import '@/styles/widget.css'

import { requestDial } from '@/dialRelay'
import { serveWidget } from '@/widget'

const WIDGET_TYPE = 'io.twake.phone.widget'

/**
 * The CALL intent of @twake/phone-link (ADR 0032): validates the number, hands it to a Twake Phone window the person
 * is looking at, and answers whether one took it. With none, phone-link opens the app on the number.
 */
const serve = async () => {
  const container = document.querySelector('[role=application]')
  const data = JSON.parse(container.dataset.cozy)
  const client = new CozyClient({
    uri: `${window.location.protocol}//${data.domain}`,
    token: data.token,
    appMetadata: { slug: manifest.slug, version: manifest.version }
  })
  const service = await new Intents({ client }).createService(new URLSearchParams(window.location.search).get('intent'), window)
  // The widget of the other apps (ADR 0034): kept open, never terminated.
  if (service.getIntent().attributes.type === WIDGET_TYPE) return serveWidget({ service, root: container, lang: data.locale })
  try {
    const { number } = service.getData() || {}
    const target = typeof number === 'string' && number.length <= 40 ? toDialTarget(number) : null
    if (!target) return service.terminate({ handled: false, reason: 'invalid-number' })
    const { handled } = await requestDial(target)
    service.terminate({ handled, number: target })
  } catch {
    // Whatever failed here, the caller hears "not handled" and opens the app, rather than waiting for good.
    service.terminate({ handled: false })
  }
}

// A service that could not even start leaves the caller to its own timeout (phone-link's).
document.addEventListener('DOMContentLoaded', () => void serve().catch(() => undefined))
