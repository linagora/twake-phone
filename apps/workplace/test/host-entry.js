// "Another Twake app" (Drive, Contacts): what it does to call a number with @twake/phone-link, through a real
// cozy-client and the real cozy-interapp. Bundled by workplace.e2e.mjs.
import CozyClient from 'cozy-client'

import { requestCall } from '../../../packages/phone-link/dist/index.js'

window.callFromHost = async number => {
  const client = new CozyClient({ uri: window.STACK, token: 'host-app-token' })
  client.instanceOptions = { subdomain: 'flat' }
  const opened = []
  const result = await requestCall({ client, number, openPhone: url => opened.push(url) })
  return { ...result, opened }
}
