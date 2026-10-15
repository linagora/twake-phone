// Notifications of calls while no window of the app is open (step 5, ADR 0015): this browser subscribes to its push
// service with the Gateway's key, and the Gateway keeps the subscription for the person signed in. Asked for in
// Réglages only, never on load; forgotten at sign-out (the next person on this browser does not get them).
import type { PushState } from '@twake/telephony-client'

/** What the app needs of the Gateway client. */
export interface PushGateway {
  getPushSubscriptions(): Promise<PushState>
  addPushSubscription(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<PushState>
  removePushSubscription(endpoint: string): Promise<void>
}

/** What the browser offers (a seam for the tests). */
export interface PushBrowser {
  supported: boolean
  permission(): NotificationPermission
  requestPermission(): Promise<NotificationPermission>
  registration(): Promise<ServiceWorkerRegistration>
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

export const SW_URL = '/sw.js'
/** How long the service worker may take to be ready before the app says it cannot subscribe. */
const READY_MS = 10_000
const MARK = 'twakephone.push.'

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the service worker did not start')), ms)
    promise.then(
      v => (clearTimeout(timer), resolve(v)),
      e => (clearTimeout(timer), reject(e))
    )
  })

export const browserPush = (): PushBrowser => {
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  let storage: Storage | undefined
  try {
    storage = window.localStorage
  } catch {
    storage = undefined
  }
  return {
    supported,
    permission: () => (supported ? Notification.permission : 'denied'),
    requestPermission: () => Notification.requestPermission(),
    registration: () => withTimeout(navigator.serviceWorker.register(SW_URL).then(() => navigator.serviceWorker.ready), READY_MS),
    ...(storage ? { storage } : {})
  }
}

/** The service worker, registered at each start (it shows the notifications; it asks nothing). */
export const registerServiceWorker = () => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.register(SW_URL).catch(() => undefined)
}

const b64url = (buffer: ArrayBuffer | null) => {
  if (!buffer) return ''
  let s = ''
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const bytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, c => c.charCodeAt(0))
}
const json = (sub: PushSubscription) => {
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  return { endpoint: j.endpoint ?? sub.endpoint, keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' } }
}

/** Whether `userId` subscribed this browser (remembered here: the Gateway keeps whose it is, this says who asked). */
const marked = (b: PushBrowser, userId: string, endpoint?: string) => {
  try {
    const v = b.storage?.getItem(MARK + userId)
    return !!v && (endpoint === undefined || v === endpoint)
  } catch {
    return false
  }
}
const mark = (b: PushBrowser, userId: string, endpoint: string | null) => {
  try {
    if (endpoint) b.storage?.setItem(MARK + userId, endpoint)
    else b.storage?.removeItem(MARK + userId)
  } catch {
    // Storage blocked: the subscription holds at the Gateway; this browser just forgets who asked.
  }
}

export type PushStatus = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on'

/** Where notifications stand for this person on this browser. */
export const pushStatus = async (gateway: PushGateway, b: PushBrowser, userId: string): Promise<PushStatus> => {
  if (!b.supported) return 'unsupported'
  const state = await gateway.getPushSubscriptions()
  if (!state.available) return 'unavailable'
  if (b.permission() === 'denied') return 'denied'
  if (b.permission() !== 'granted' || !marked(b, userId)) return 'off'
  const sub = await (await b.registration()).pushManager.getSubscription()
  return sub && marked(b, userId, sub.endpoint) ? 'on' : 'off'
}

/**
 * Asks the browser's permission (the person clicked), subscribes with the Gateway's key (a subscription made with
 * another key is replaced) and hands it to the Gateway. 'denied' when the person or the browser refused.
 */
export const enablePush = async (gateway: PushGateway, b: PushBrowser, userId: string): Promise<PushStatus> => {
  if (!b.supported) return 'unsupported'
  const permission = b.permission() === 'granted' ? 'granted' : await b.requestPermission()
  if (permission !== 'granted') return 'denied'
  const state = await gateway.getPushSubscriptions()
  if (!state.available || !state.publicKey) return 'unavailable'
  const registration = await b.registration()
  let sub = await registration.pushManager.getSubscription()
  if (sub && b64url(sub.options?.applicationServerKey ?? null) !== state.publicKey) {
    await sub.unsubscribe().catch(() => undefined)
    sub = null
  }
  sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(state.publicKey) })
  await gateway.addPushSubscription(json(sub))
  mark(b, userId, sub.endpoint)
  return 'on'
}

/** Forgets this browser's subscription, at the Gateway and at its push service. */
export const disablePush = async (gateway: PushGateway, b: PushBrowser, userId: string): Promise<PushStatus> => {
  if (!b.supported) return 'unsupported'
  mark(b, userId, null)
  const sub = await (await b.registration()).pushManager.getSubscription()
  if (sub) {
    await gateway.removePushSubscription(sub.endpoint)
    await sub.unsubscribe().catch(() => undefined)
  }
  return 'off'
}

/**
 * At each start of a signed-in app: the subscription this person made on this browser is handed to the Gateway
 * again (one it removed, a push service that renewed it). Someone else's is left alone.
 */
export const resyncPush = async (gateway: PushGateway, b: PushBrowser, userId: string) => {
  if (!b.supported || b.permission() !== 'granted' || !marked(b, userId)) return
  const sub = await (await b.registration()).pushManager.getSubscription()
  if (!sub) return mark(b, userId, null)
  if (!marked(b, userId, sub.endpoint)) mark(b, userId, sub.endpoint)
  await gateway.addPushSubscription(json(sub))
}

/** At sign-out: this browser stops receiving the person's calls (bounded: a sign-out never waits long for it). */
export const forgetPushAtSignOut = async (gateway: PushGateway, b: PushBrowser, userId: string, ms = 2_000) => {
  if (!b.supported || !marked(b, userId)) return
  await withTimeout(disablePush(gateway, b, userId), ms).catch(() => undefined)
}

/** The call a notification opened the app on (`/?call=<id>`), if any. */
export const calledFor = (search: string) => {
  const id = new URLSearchParams(search).get('call')
  return id && id.length <= 256 ? id : null
}
