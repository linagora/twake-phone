// Stand-in for a host app (Drive): a CozyClient-like object over a fake stack, the widget library and PhoneLink's core.
import { requestCall } from '../../../packages/phone-link/dist/index.js'
import { mountPhoneWidget } from '../../../packages/phone-widget/dist/index.js'

const fetchJSON = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/vnd.api+json',
      accept: 'application/vnd.api+json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`stack ${res.status} on ${path}`)
  return res.json()
}
const client = {
  stackClient: { fetchJSON },
  getStackClient: () => ({ uri: window.__phoneOrigin }),
  getInstanceOptions: () => ({ subdomain: 'flat' })
}

if (!location.search.includes('nowidget'))
  window.__mounted = mountPhoneWidget({ client })
// What a click on <PhoneLink number="…"> does.
window.__call = number =>
  requestCall({
    client,
    number,
    openPhone: url => {
      window.__opened = url
    }
  })
