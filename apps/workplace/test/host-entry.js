// "Another Twake app" (Drive, Contacts): what it does to call a number with @twake/phone-link, through a real
// cozy-client and the real cozy-interapp. Bundled by workplace.e2e.mjs.
import CozyClient from 'cozy-client'

import { requestCall } from '../../../packages/phone-link/dist/index.js'
import { mountPhoneWidget } from '../../../packages/phone-widget/dist/index.js'

window.callFromHost = async number => {
  const client = new CozyClient({ uri: window.STACK, token: 'host-app-token' })
  client.instanceOptions = { subdomain: 'flat' }
  const opened = []
  const result = await requestCall({ client, number, openPhone: url => opened.push(url) })
  return { ...result, opened }
}

// A click, as a person makes it: the real path, with the browser's own new tab (no override).
document.addEventListener('click', event => {
  if (event.target?.id !== 'call') return
  const client = new CozyClient({ uri: window.STACK, token: 'host-app-token' })
  client.instanceOptions = { subdomain: 'flat' }
  void requestCall({ client, number: event.target.dataset.number }).then(result => (window.lastResult = result))
})

// The widget of Twake Phone in this app's corner (ADR 0034), as an app mounts it.
window.mountWidget = () => {
  const client = new CozyClient({ uri: window.STACK, token: 'host-app-token' })
  client.instanceOptions = { subdomain: 'flat' }
  window.unmountWidget = mountPhoneWidget({ client })
}
