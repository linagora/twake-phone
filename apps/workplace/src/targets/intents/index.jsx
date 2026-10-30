import CozyClient from 'cozy-client'
import Intents from 'cozy-interapp'

import { toDialTarget } from '@twake/telephony-client'

import manifest from '../../../manifest.webapp'

import { requestDial } from '@/dialRelay'

/**
 * The CALL intent of @twake/phone-link (ADR 0032): validates the number, hands it to a Twake Phone window the person
 * is looking at, and answers whether one took it. With none, phone-link opens the app on the number.
 */
const init = async () => {
  const container = document.querySelector('[role=application]')
  const data = JSON.parse(container.dataset.cozy)
  const client = new CozyClient({
    uri: `${window.location.protocol}//${data.domain}`,
    token: data.token,
    appMetadata: { slug: manifest.slug, version: manifest.version }
  })
  const service = await new Intents({ client }).createService(new URLSearchParams(window.location.search).get('intent'), window)
  const { number } = service.getData() || {}
  const target = typeof number === 'string' && number.length <= 40 ? toDialTarget(number) : null
  if (!target) return service.terminate({ handled: false, reason: 'invalid-number' })
  const { handled } = await requestDial(target)
  service.terminate({ handled, number: target })
}

document.addEventListener('DOMContentLoaded', () => void init())
