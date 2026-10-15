// TwakePhone's service worker (step 5, ADR 0015): it only shows the notification of a call the Gateway pushed while
// no window of the app was open, and opens the app on it when clicked. No fetch handler, no cache: the app is served
// as before. What a push carries is the caller's number and directory name, the group dialled, and the call's id.
const TEXT = {
  fr: {
    call: who => `Appel de ${who}`,
    groupCall: (who, group) => `Appel de ${who} pour ${group}`,
    answer: 'Cliquez pour répondre dans TwakePhone.',
    missed: who => `Appel manqué de ${who}`,
    missedBody: 'TwakePhone',
    other: 'TwakePhone',
    otherBody: 'Ouvrez TwakePhone.'
  },
  en: {
    call: who => `Call from ${who}`,
    groupCall: (who, group) => `Call from ${who} for ${group}`,
    answer: 'Click to answer in TwakePhone.',
    missed: who => `Missed call from ${who}`,
    missedBody: 'TwakePhone',
    other: 'TwakePhone',
    otherBody: 'Open TwakePhone.'
  }
}
const text = () => TEXT[String(self.navigator?.language ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en']
/** A short single line: whatever a push says, a notification shows no more. */
const line = (value, max = 64) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const who = (name, number) => (line(name) ? `${line(name)} (${line(number, 32)})` : line(number, 32))

/** The notification of a pushed message: title and options, or null for a message that is not ours. */
const notificationOf = data => {
  const t = text()
  if (!data || typeof data !== 'object' || typeof data.callId !== 'string' || !line(data.number, 32)) return null
  const caller = who(data.name, data.number)
  const group = data.group && typeof data.group === 'object' && line(data.group.number, 32) ? who(data.group.name, data.group.number) : ''
  // One notification per call (its tag): the missed call replaces its ringing.
  const tag = `call-${line(data.callId, 128)}`
  if (data.type === 'call') {
    return {
      title: group ? t.groupCall(caller, group) : t.call(caller),
      options: { body: t.answer, tag, renotify: true, requireInteraction: true, data: { url: `/?call=${encodeURIComponent(line(data.callId, 128))}` } }
    }
  }
  if (data.type === 'missed') return { title: t.missed(caller), options: { body: group || t.missedBody, tag, data: { url: '/recents' } } }
  return null
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    data = null
  }
  // Every push shows something (the browsers require it): a message that is not a call says to open the app.
  const shown = notificationOf(data) ?? { title: text().other, options: { body: text().otherBody, data: { url: '/' } } }
  event.waitUntil(self.registration.showNotification(shown.title, shown.options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin)
  // Only a page of the app, whatever the notification says.
  const target = url.origin === self.location.origin ? url : new URL('/', self.location.origin)
  event.waitUntil(openApp(target))
})

/**
 * A window of the app already open is brought forward and told which call (it signs in if needed: its softphone
 * then registers and the call rings there); otherwise a new one opens on it.
 */
const openApp = async target => {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find(w => new URL(w.url).origin === self.location.origin)
  if (open) {
    await open.focus()
    open.postMessage({ type: 'twakephone.open', path: target.pathname + target.search })
    return
  }
  await self.clients.openWindow(target.href)
}

// Read by the unit tests (apps/web/src/sw.spec.ts), which run this file without a browser.
self.twakephoneSw = { notificationOf, openApp }
