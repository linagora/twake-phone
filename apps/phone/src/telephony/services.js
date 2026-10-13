import { Softphone } from '@twake/softphone'
import { TelephonyClient } from '@twake/telephony-client'

import flag from 'cozy-flags'

// Dev token for a Gateway running in dev auth mode. Deliberately NOT a Cozy flag: cozy-flags keeps flags in
// localStorage, so a flag that was once set on an instance would silently keep sending a dev token (refused with
// a 401) long after it was removed on the server. Only the test harnesses set this key.
const DEV_USER_KEY = 'twake-phone:dev-user'
const readDevUser = () => {
  try {
    // Remnant of the flag this key replaces: never let it linger.
    localStorage.removeItem('flag__phone.dev-user')
    return localStorage.getItem(DEV_USER_KEY)
  } catch {
    return null
  }
}

// Why not send the app's own token to the Gateway? In a browser it is bound to the Twake session
// (`session_id` claim) and cozy-stack only accepts it together with the session cookie, which the Gateway,
// another server, never has: it is refused as an "Invalid JWT token". Instead the app asks the stack for a
// short-lived permission code limited to reading the identity of the instance, which proves who the user is
// without a session and can do nothing else (it cannot read files or contacts).
const CODE_TTL = '10m'
const CODE_REUSE_MS = 8 * 60 * 1000
const IDENTITY_PERMISSION = {
  data: {
    type: 'io.cozy.permissions',
    attributes: {
      permissions: {
        identity: {
          type: 'io.cozy.settings',
          verbs: ['GET'],
          values: ['io.cozy.settings.instance']
        }
      }
    }
  }
}

/** One code per window, renewed before it expires; simultaneous requests share a single creation. */
export const makeIdentityProvider = ({ fetchJSON, now = Date.now }) => {
  let cached = null
  let pending = null
  return async () => {
    if (cached && cached.until > now()) return cached.code
    pending ??= fetchJSON(
      'POST',
      `/permissions?codes=gateway&ttl=${CODE_TTL}`,
      IDENTITY_PERMISSION
    )
      .then(resp => {
        const code = resp?.data?.attributes?.codes?.gateway
        if (!code) throw new Error('The stack did not return an identity code')
        cached = { code, until: now() + CODE_REUSE_MS }
        return code
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}

/**
 * Real services. The Gateway URL comes from a Cozy flag. The credentials are an identity code created by the
 * stack and the instance URL, verified by the Gateway against the instance. A dev token (local key above)
 * replaces them only against a Gateway running in dev auth mode.
 */
export const createServices = ({ client, remoteAudio }) => {
  const stack = client.getStackClient()
  const identity = makeIdentityProvider({
    fetchJSON: (...args) => stack.fetchJSON(...args)
  })
  const gateway = new TelephonyClient({
    baseUrl: flag('phone.gateway-url'),
    getToken: async () => {
      const devUser = readDevUser()
      return devUser ? `dev:${devUser}` : identity()
    },
    getInstance: () => stack.uri
  })
  return {
    gateway,
    createSoftphone: handlers =>
      new Softphone({
        getSession: async () => {
          const session = await gateway.getMediaSession()
          if (session.type !== 'sip-webrtc')
            throw new Error('No browser audio for this user')
          return session
        },
        remoteAudio,
        ...handlers
      })
  }
}
