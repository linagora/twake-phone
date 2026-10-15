// TwakePhone's service worker (step 5, ADR 0015): it only shows the notifications of a call the Gateway pushed while
// no window of the app could ring, replaces them once the call no longer waits, and opens the app on the call when
// clicked. No fetch handler, no cache: the app is served as before. What a push carries is the caller's number and
// directory name, the group dialled, the call's id and, for a call, until when it waits.
const TEXT = {
  fr: {
    call: who => `Appel de ${who}`,
    groupCall: (who, group) => `Appel de ${who} pour ${group}`,
    answer: 'Cliquez pour répondre dans TwakePhone.',
    missed: who => `Appel manqué de ${who}`,
    missedBody: 'TwakePhone',
    answered: 'Répondu.',
    taken: by => `Pris par ${by}.`,
    over: 'Appel terminé.',
    other: 'TwakePhone',
    otherBody: 'Ouvrez TwakePhone.'
  },
  en: {
    call: who => `Call from ${who}`,
    groupCall: (who, group) => `Call from ${who} for ${group}`,
    answer: 'Click to answer in TwakePhone.',
    missed: who => `Missed call from ${who}`,
    missedBody: 'TwakePhone',
    answered: 'Answered.',
    taken: by => `Taken by ${by}.`,
    over: 'Call over.',
    other: 'TwakePhone',
    otherBody: 'Open TwakePhone.'
  }
}
const text = () => TEXT[String(self.navigator?.language ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en']
/** A short single line: whatever a push says, a notification shows no more. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
const line = (value, max = 64) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const who = (name, number) => (line(name) ? `${line(name)} (${line(number, 32)})` : line(number, 32))
/** How long a window of the app has to say it rings the call itself. */
const ASK_MS = 1_000

/**
 * The notification of a pushed message, `now` being the time on this device: title and options, or null for a message
 * that is not ours. A call shows until its end (`until`, the Gateway's clock) at most: one that arrives after it shows
 * as over, never as a call to answer.
 */
const notificationOf = (data, now = Date.now()) => {
  const t = text()
  if (!data || typeof data !== 'object' || typeof data.callId !== 'string' || !line(data.number, 32)) return null
  const caller = who(data.name, data.number)
  const group = data.group && typeof data.group === 'object' && line(data.group.number, 32) ? who(data.group.name, data.group.number) : ''
  // One notification per call (its tag): what the call became replaces its ringing.
  const callId = line(data.callId, 128)
  const tag = `call-${callId}`
  const title = group ? t.groupCall(caller, group) : t.call(caller)
  // Over: shown quietly, gone once seen (no sound, no need to act). Marked so (`over`): a push of the call itself
  // that comes after it never puts the call to answer back (onPush).
  const over = body => ({ title, options: { body, tag, silent: true, data: { url: '/recents', over: true } } })
  if (data.type === 'call') {
    const until = typeof data.until === 'number' && Number.isFinite(data.until) ? data.until : 0
    if (until && until <= now) return over(t.over)
    return { title, options: { body: t.answer, tag, renotify: true, requireInteraction: true, data: { url: `/?call=${encodeURIComponent(callId)}`, until } } }
  }
  if (data.type === 'missed') return { title: t.missed(caller), options: { body: group || t.missedBody, tag, data: { url: '/recents', over: true } } }
  if (data.type === 'ended') {
    if (data.reason === 'answered') return over(t.answered)
    const by = data.by && typeof data.by === 'object' && line(data.by.number, 32) ? who(data.by.name, data.by.number) : ''
    if (data.reason === 'taken' && by) return over(t.taken(by))
    return over(t.over)
  }
  return null
}

/** The windows of the app this browser shows now. */
const visibleWindows = async () =>
  (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(w => new URL(w.url).origin === self.location.origin && w.visibilityState === 'visible')

/**
 * Whether a window of the app on screen rings this call itself: 'rings' when one is signed in with its softphone
 * registered (then no notification: the page rings), 'soon' when the only ones signed in are not registered yet (a
 * WebSocket on its way back: the call may ring there, or not in time), 'no' otherwise.
 */
const ringsInAWindow = async callId => {
  const windows = await visibleWindows()
  if (!windows.length || typeof MessageChannel === 'undefined') return 'no'
  return new Promise(resolve => {
    let soon = false
    let left = windows.length
    const timer = setTimeout(() => resolve(soon ? 'soon' : 'no'), ASK_MS)
    for (const w of windows) {
      const channel = new MessageChannel()
      channel.port1.onmessage = e => {
        if (e.data?.type !== 'twakephone.here') return
        if (e.data.registered === true) {
          clearTimeout(timer)
          return resolve('rings')
        }
        soon = true
        if (--left === 0) {
          clearTimeout(timer)
          resolve('soon')
        }
      }
      w.postMessage({ type: 'twakephone.ring', callId }, [channel.port2])
    }
  })
}

/**
 * The calls whose end (or miss) was shown since this worker started: a push of the call that comes after it (push
 * services keep no order) shows the end again, never the call to answer. The notification's own mark (`over`) says
 * so too while it is on screen, across a restart of the worker.
 */
const overCalls = new Set()
const OVER_KEPT = 200
const remember = callId => {
  overCalls.add(callId)
  if (overCalls.size > OVER_KEPT) overCalls.delete(overCalls.values().next().value)
}

/** The notifications of calls whose wait is over (their end message never came: a Gateway restarted) go. */
const dropExpired = async (now = Date.now()) => {
  const all = (await self.registration.getNotifications?.()) ?? []
  for (const n of all) if (typeof n.data?.until === 'number' && n.data.until && n.data.until <= now) n.close()
}

const onPush = async data => {
  await dropExpired().catch(() => undefined)
  // Every push shows something (the browsers require it while no window of the site is on screen): a message that
  // is not a call says to open the app.
  let shown = notificationOf(data) ?? { title: text().other, options: { body: text().otherBody, data: { url: '/' } } }
  const callId = typeof data?.callId === 'string' ? line(data.callId, 128) : ''
  if (data?.type === 'call' && shown.options.requireInteraction) {
    // Its end came first: it stays (or shows again, quietly) as over.
    const tagged = (await self.registration.getNotifications?.({ tag: shown.options.tag })) ?? []
    if (tagged.some(n => n.data?.over)) return
    if (overCalls.has(callId)) shown = notificationOf({ ...data, type: 'ended', reason: 'over' })
  }
  if (data?.type === 'call' && shown.options.requireInteraction) {
    const here = await ringsInAWindow(callId).catch(() => 'no')
    if (here === 'rings') return
    // A window on screen on its way back: the call shown quietly, closed once it rings there (`twakephone.ringing`).
    if (here === 'soon') {
      const { renotify, requireInteraction, ...options } = shown.options
      shown = { title: shown.title, options: { ...options, silent: true, data: { ...options.data, quiet: true, callId } } }
    }
  }
  if (data?.type === 'ended' || data?.type === 'missed') remember(callId)
  // The end of a call while a window is on screen: its notification goes, no other comes.
  if (data?.type === 'ended' && (await visibleWindows().catch(() => [])).length) {
    for (const n of (await self.registration.getNotifications?.({ tag: shown.options.tag })) ?? []) n.close()
    return
  }
  await self.registration.showNotification(shown.title, shown.options)
}

/** A page of the app rings these calls itself (JsSIP's ids: the Call-ID, then the From tag): their quiet notifications go. */
const ringingHere = async callIds => {
  for (const n of (await self.registration.getNotifications?.()) ?? []) {
    const callId = n.data?.quiet ? n.data.callId : undefined
    if (typeof callId === 'string' && callId && callIds.some(id => id.startsWith(callId))) n.close()
  }
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

/**
 * The pushes, one after the other. Chromium (and Edge) forget a notification whose display is still under way when
 * its notifications are listed meanwhile (getNotifications drops what is not on screen yet): shown all the same, it
 * could never be closed again. So nothing lists them while one is being shown: a push waits for the previous one.
 */
let inTurn = Promise.resolve()
const oneAtATime = work => (inTurn = inTurn.then(work, work))

self.addEventListener('push', event => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    data = null
  }
  event.waitUntil(oneAtATime(() => onPush(data)))
})

self.addEventListener('message', event => {
  const callIds = event.data?.type === 'twakephone.ringing' && Array.isArray(event.data.callIds) ? event.data.callIds.filter(id => typeof id === 'string').slice(0, 16) : []
  if (callIds.length) event.waitUntil(oneAtATime(() => ringingHere(callIds)))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const data = event.notification.data ?? {}
  // A call whose wait is over is no call to answer any more: its history instead.
  const expired = typeof data.until === 'number' && data.until && data.until <= Date.now()
  const url = new URL(expired ? '/recents' : (data.url ?? '/'), self.location.origin)
  // Only a page of the app, whatever the notification says.
  const target = url.origin === self.location.origin ? url : new URL('/', self.location.origin)
  event.waitUntil(openApp(target))
})

/**
 * A window of the app already open is told which call (it signs in if needed: its softphone then registers and the
 * call rings there), then brought forward; otherwise a new one opens on it.
 */
const openApp = async target => {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find(w => new URL(w.url).origin === self.location.origin)
  if (open) {
    open.postMessage({ type: 'twakephone.open', path: target.pathname + target.search })
    // Told first: a browser may refuse the focus (it allows it for a click on the notification only).
    await open.focus().catch(() => undefined)
    return
  }
  await self.clients.openWindow(target.href)
}

// Read by the unit tests (apps/web/src/sw.spec.ts), which run this file without a browser.
self.twakephoneSw = { notificationOf, openApp }
