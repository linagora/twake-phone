import { describe, expect, it } from 'vitest'
import { answerRingQueries, calledFor, disablePush, enablePush, forgetPushAtSignOut, pushStatus, resyncPush, ringsHere, type PushBrowser, type PushGateway } from './push.js'

const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url')
const OTHER_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 8)]).toString('base64url')

/** A browser with its push manager, permission and storage, recording what the app does. */
const fakeBrowser = ({ permission = 'default' as NotificationPermission, answer = 'granted' as NotificationPermission, existing = null as null | { key: string; endpoint: string } } = {}) => {
  const log: string[] = []
  const store = new Map<string, string>()
  let current = existing
  let perm = permission
  let n = 0
  const subscription = (s: { key: string; endpoint: string }) => ({
    endpoint: s.endpoint,
    options: { applicationServerKey: Uint8Array.from(Buffer.from(s.key, 'base64url')).buffer },
    toJSON: () => ({ endpoint: s.endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      log.push(`unsubscribe ${s.endpoint}`)
      current = null
      return true
    }
  })
  const browser: PushBrowser = {
    supported: true,
    permission: () => perm,
    requestPermission: async () => {
      log.push('ask')
      perm = answer
      return answer
    },
    registration: async () =>
      ({
        pushManager: {
          getSubscription: async () => (current ? subscription(current) : null),
          subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
            const key = Buffer.from(o.applicationServerKey).toString('base64url')
            log.push(`subscribe ${o.userVisibleOnly} ${key === KEY ? 'KEY' : key}`)
            current = { key, endpoint: `https://push.example.test/${++n}` }
            return subscription(current)
          }
        }
      }) as unknown as ServiceWorkerRegistration,
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: k => void store.delete(k) }
  }
  return { browser, log, store }
}
const fakeGateway = (available = true) => {
  const log: string[] = []
  const gateway: PushGateway = {
    getPushSubscriptions: async () => (available ? { available, publicKey: KEY, subscriptions: 0 } : { available, subscriptions: 0 }),
    addPushSubscription: async s => {
      log.push(`add ${s.endpoint} ${s.keys.p256dh}/${s.keys.auth}`)
      return { available, subscriptions: 1 }
    },
    removePushSubscription: async e => void log.push(`remove ${e}`)
  }
  return { gateway, log }
}

describe('notifications of calls (push.ts)', () => {
  it('asks the permission only when turned on, subscribes with the Gateway\'s key and hands the subscription over', async () => {
    const b = fakeBrowser()
    const g = fakeGateway()
    expect(await pushStatus(g.gateway, b.browser, 'jean')).toBe('off')
    expect(b.log).toEqual([])
    expect(await enablePush(g.gateway, b.browser, 'jean')).toBe('on')
    expect(b.log).toEqual(['ask', 'subscribe true KEY'])
    expect(g.log).toEqual(['add https://push.example.test/1 p/a'])
    expect(await pushStatus(g.gateway, b.browser, 'jean')).toBe('on')
    // Someone else on this browser did not ask for it.
    expect(await pushStatus(g.gateway, b.browser, 'paul')).toBe('off')
  })

  it('says when the person or the browser refused, when the platform offers none, and when the browser cannot', async () => {
    const refused = fakeBrowser({ answer: 'denied' })
    expect(await enablePush(fakeGateway().gateway, refused.browser, 'jean')).toBe('denied')
    expect(await pushStatus(fakeGateway().gateway, refused.browser, 'jean')).toBe('denied')
    expect(await pushStatus(fakeGateway(false).gateway, fakeBrowser().browser, 'jean')).toBe('unavailable')
    expect(await enablePush(fakeGateway(false).gateway, fakeBrowser({ permission: 'granted' }).browser, 'jean')).toBe('unavailable')
    const none = { ...fakeBrowser().browser, supported: false }
    expect(await pushStatus(fakeGateway().gateway, none, 'jean')).toBe('unsupported')
  })

  it('replaces a subscription made with another key (the Gateway\'s changed), and keeps one made with its key', async () => {
    const b = fakeBrowser({ permission: 'granted', existing: { key: OTHER_KEY, endpoint: 'https://push.example.test/old' } })
    const g = fakeGateway()
    await enablePush(g.gateway, b.browser, 'jean')
    expect(b.log).toEqual(['unsubscribe https://push.example.test/old', 'subscribe true KEY'])
    const same = fakeBrowser({ permission: 'granted', existing: { key: KEY, endpoint: 'https://push.example.test/kept' } })
    await enablePush(g.gateway, same.browser, 'jean')
    expect(same.log).toEqual([])
    expect(g.log.at(-1)).toBe('add https://push.example.test/kept p/a')
  })

  it('turns off at the Gateway and at the push service, and at sign-out', async () => {
    const b = fakeBrowser()
    const g = fakeGateway()
    await enablePush(g.gateway, b.browser, 'jean')
    expect(await disablePush(g.gateway, b.browser, 'jean')).toBe('off')
    expect(g.log.at(-1)).toBe('remove https://push.example.test/1')
    expect(b.log.at(-1)).toBe('unsubscribe https://push.example.test/1')
    await enablePush(g.gateway, b.browser, 'jean')
    await forgetPushAtSignOut(g.gateway, b.browser, 'jean')
    expect(g.log.at(-1)).toBe('remove https://push.example.test/2')
    // Nobody subscribed here: a sign-out touches nothing.
    const before = g.log.length
    await forgetPushAtSignOut(g.gateway, b.browser, 'paul')
    expect(g.log).toHaveLength(before)
  })

  it('hands the subscription to the Gateway again at each start, only for the person who made it', async () => {
    const b = fakeBrowser()
    const g = fakeGateway()
    await enablePush(g.gateway, b.browser, 'jean')
    await resyncPush(g.gateway, b.browser, 'jean')
    expect(g.log).toEqual(['add https://push.example.test/1 p/a', 'add https://push.example.test/1 p/a'])
    expect(b.log).toEqual(['ask', 'subscribe true KEY'])
  })

  it('stops, at its push service, a subscription someone else left on this browser (their sign-out never reached it)', async () => {
    const b = fakeBrowser()
    const g = fakeGateway()
    await enablePush(g.gateway, b.browser, 'jean')
    // Paul signs in on the same browser: Jean's calls stop here, Paul gets none of them.
    await resyncPush(g.gateway, b.browser, 'paul')
    expect(b.log.at(-1)).toBe('unsubscribe https://push.example.test/1')
    expect(g.log).toEqual(['add https://push.example.test/1 p/a'])
    expect(await pushStatus(g.gateway, b.browser, 'paul')).toBe('off')
    expect(await pushStatus(g.gateway, b.browser, 'jean')).toBe('off')
    // A subscription nobody here is known to have made goes too.
    const unknown = fakeBrowser({ permission: 'granted', existing: { key: KEY, endpoint: 'https://push.example.test/unknown' } })
    await resyncPush(g.gateway, unknown.browser, 'paul')
    expect(unknown.log).toEqual(['unsubscribe https://push.example.test/unknown'])
  })

  it('makes the subscription anew when the Gateway\'s key changed (its pushes would be refused), and says it is off until then', async () => {
    const b = fakeBrowser()
    const g = fakeGateway()
    await enablePush(g.gateway, b.browser, 'jean')
    // The Gateway now signs with another key (VAPID keys set afterwards, a database restored without them).
    const changed = { ...g.gateway, getPushSubscriptions: async () => ({ available: true, publicKey: OTHER_KEY, subscriptions: 1 }) }
    expect(await pushStatus(changed, b.browser, 'jean')).toBe('off')
    await resyncPush(changed, b.browser, 'jean')
    expect(b.log.slice(2)).toEqual(['unsubscribe https://push.example.test/1', `subscribe true ${OTHER_KEY}`])
    expect(g.log.slice(1)).toEqual(['remove https://push.example.test/1', 'add https://push.example.test/2 p/a'])
    expect(await pushStatus(changed, b.browser, 'jean')).toBe('on')
  })

  it('answers the service worker for a window on screen whose softphone rings the call, not otherwise', () => {
    expect(ringsHere('registered', 'visible')).toBe(true)
    expect(ringsHere('connecting', 'visible')).toBe(true)
    expect(ringsHere('registered', 'hidden')).toBe(false)
    expect(ringsHere('failed', 'visible')).toBe(false)
    expect(ringsHere('off', 'visible')).toBe(false)
    let listener: ((e: MessageEvent) => void) | undefined
    const container = { addEventListener: (_: string, l: EventListener) => void (listener = l as never), removeEventListener: () => void (listener = undefined) }
    let here = true
    const stop = answerRingQueries(container as never, () => here)
    const answers: unknown[] = []
    const ask = (data: unknown) => listener?.({ data, ports: [{ postMessage: (m: unknown) => void answers.push(m) }] } as never)
    ask({ type: 'twakephone.ring', callId: 'c1' })
    ask({ type: 'other' })
    here = false
    ask({ type: 'twakephone.ring', callId: 'c2' })
    expect(answers).toEqual([{ type: 'twakephone.here' }])
    stop()
    expect(listener).toBeUndefined()
  })

  it('reads the call a notification opened the app on', () => {
    expect(calledFor('?call=abc-1')).toBe('abc-1')
    expect(calledFor('?x=1')).toBeNull()
    expect(calledFor(`?call=${'x'.repeat(300)}`)).toBeNull()
  })
})
