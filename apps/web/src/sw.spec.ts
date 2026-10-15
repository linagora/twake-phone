import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// public/sw.js run as a browser runs it, in a scope of its own: `self` with its registration and clients, here fakes.
type Handler = (event: Record<string, unknown>) => void
interface FakeWindow {
  url: string
  visibilityState?: 'visible' | 'hidden'
  /**
   * Answers the worker's question as a window of the app signed in: its softphone registered (it rings the call
   * itself), or on its way (connecting: it may not ring in time).
   */
  answers?: 'registered' | 'connecting'
  /** Refuses to be brought forward (a browser allows it for a click on the notification only). */
  refusesFocus?: boolean
  focused?: boolean
  messages?: unknown[]
}
const load = (language = 'fr-FR', windows: FakeWindow[] = []) => {
  const handlers = new Map<string, Handler>()
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const closed: string[] = []
  const opened: string[] = []
  const notifications: { title: string; tag?: string; data?: Record<string, unknown>; close: () => void }[] = []
  // Shows under way, and the times notifications were listed during one (Chromium then forgets the one being shown).
  const showing = { now: 0, listedDuring: 0 }
  const self: Record<string, unknown> = {
    navigator: { language },
    location: { origin: 'https://phone.example.test' },
    addEventListener: (type: string, h: Handler) => void handlers.set(type, h),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        showing.now++
        await new Promise(r => setTimeout(r, 5))
        showing.now--
        shown.push({ title, options })
        const tag = options.tag as string | undefined
        for (const n of notifications.filter(n => tag && n.tag === tag)) n.close()
        const n = {
          title,
          tag,
          data: options.data as Record<string, unknown>,
          close: () => {
            const i = notifications.indexOf(n)
            if (i >= 0) notifications.splice(i, 1)
            closed.push(title)
          }
        }
        notifications.push(n)
      },
      getNotifications: async (filter?: { tag?: string }) => {
        if (showing.now) showing.listedDuring++
        return notifications.filter(n => !filter?.tag || n.tag === filter.tag)
      }
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () =>
        windows.map(w => ({
          url: w.url,
          visibilityState: w.visibilityState ?? 'hidden',
          focus: async () => {
            if (w.refusesFocus) throw new Error('Not allowed to focus a window.')
            w.focused = true
          },
          postMessage: (m: { type?: string }, ports?: MessagePort[]) => {
            ;(w.messages ??= []).push(m)
            if (m.type === 'twakephone.ring' && w.answers) ports?.[0]?.postMessage({ type: 'twakephone.here', registered: w.answers === 'registered' })
          }
        })),
      openWindow: async (url: string) => void opened.push(url)
    }
  }
  new Function('self', readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'))(self)
  const fire = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> | undefined
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => void (waited = p) })
    await waited
  }
  const push = (data: unknown) => fire('push', { data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } })
  /** A page of the app says its softphone rings these calls (their SIP Call-ID and From tag, as JsSIP names them). */
  const ringing = (callIds: unknown) => fire('message', { data: { type: 'twakephone.ringing', callIds } })
  const click = (url: string, extra: Record<string, unknown> = {}) => {
    let wasClosed = false
    return fire('notificationclick', { notification: { data: { url, ...extra }, close: () => void (wasClosed = true) } }).then(() => wasClosed)
  }
  return { shown, closed, opened, notifications, push, ringing, click, windows, showing }
}
const IN_A_MINUTE = () => Date.now() + 60_000

describe('the service worker (public/sw.js)', () => {
  it('shows a call with the caller\'s directory name, once per call, until the person acts or the call no longer waits', async () => {
    const sw = load()
    const until = IN_A_MINUTE()
    await sw.push({ type: 'call', callId: 'c1', number: '101', name: 'Alice Martin', until })
    expect(sw.shown).toEqual([{ title: 'Appel de Alice Martin (101)', options: { body: 'Cliquez pour répondre dans TwakePhone.', tag: 'call-c1', renotify: true, requireInteraction: true, data: { url: '/?call=c1', until } } }])
    // A group's, in English; a caller without a name shows its number.
    const en = load('en-GB')
    await en.push({ type: 'call', callId: 'c2', number: '104', group: { number: '200', name: 'Accueil' }, until: IN_A_MINUTE() })
    expect(en.shown[0]!.title).toBe('Call from 104 for Accueil (200)')
  })

  it('turns the notification of a call nobody answered into that of a missed call', async () => {
    const sw = load()
    await sw.push({ type: 'missed', callId: 'c1', number: '101', name: 'Alice Martin' })
    expect(sw.shown).toEqual([{ title: 'Appel manqué de Alice Martin (101)', options: { body: 'TwakePhone', tag: 'call-c1', data: { url: '/recents', over: true } } }])
  })

  it('replaces the call, quietly and for good, once it no longer waits: answered, taken by a colleague, over', async () => {
    const sw = load()
    await sw.push({ type: 'call', callId: 'c1', number: '101', name: 'Alice Martin', until: IN_A_MINUTE() })
    await sw.push({ type: 'ended', callId: 'c1', number: '101', name: 'Alice Martin', reason: 'answered' })
    expect(sw.notifications.map(n => n.title)).toEqual(['Appel de Alice Martin (101)'])
    expect(sw.shown[1]).toEqual({ title: 'Appel de Alice Martin (101)', options: { body: 'Répondu.', tag: 'call-c1', silent: true, data: { url: '/recents', over: true } } })
    await sw.push({ type: 'ended', callId: 'c2', number: '104', group: { number: '200', name: 'Accueil' }, reason: 'taken', by: { number: '103', name: 'Bob Durand' } })
    expect(sw.shown[2]!.options.body).toBe('Pris par Bob Durand (103).')
    expect(sw.shown[2]!.options.requireInteraction).toBeUndefined()
    await sw.push({ type: 'ended', callId: 'c3', number: '101', reason: 'over' })
    expect(sw.shown[3]!.options.body).toBe('Appel terminé.')
  })

  it('never shows a call to answer whose wait is over (a late push, a Gateway that restarted and never told its end)', async () => {
    const sw = load()
    await sw.push({ type: 'call', callId: 'late', number: '101', until: Date.now() - 1 })
    expect(sw.shown[0]!.options).toMatchObject({ body: 'Appel terminé.', silent: true })
    expect(sw.shown[0]!.options.requireInteraction).toBeUndefined()
    // Shown while it waited, its end never pushed: the next push drops it.
    const stale = load()
    await stale.push({ type: 'call', callId: 'c1', number: '101', until: Date.now() + 20 })
    await new Promise(r => setTimeout(r, 30))
    await stale.push({ type: 'missed', callId: 'c2', number: '102' })
    expect(stale.notifications.map(n => n.tag)).toEqual(['call-c2'])
    // Clicked once over: the history, not the call.
    expect(await stale.click('/?call=c1', { until: Date.now() - 1 })).toBe(true)
    expect(stale.opened).toEqual(['https://phone.example.test/recents'])
  })

  it('never puts back the call to answer once its end was shown: a push of the call that comes late (push services keep no order)', async () => {
    const sw = load()
    await sw.push({ type: 'ended', callId: 'c1', number: '101', reason: 'over' })
    await sw.push({ type: 'call', callId: 'c1', number: '101', until: IN_A_MINUTE() })
    expect(sw.notifications.map(n => `${n.tag} ${n.data?.over}`)).toEqual(['call-c1 true'])
    expect(sw.shown.map(s => s.options.body)).toEqual(['Appel terminé.'])
    // The end shown while a window was on screen (nothing on screen then): the late call shows as over, quietly.
    const seen = load('fr-FR', [{ url: 'https://phone.example.test/', visibilityState: 'visible' }])
    await seen.push({ type: 'ended', callId: 'c2', number: '101', reason: 'answered' })
    await seen.push({ type: 'call', callId: 'c2', number: '101', until: IN_A_MINUTE() })
    expect(seen.shown.map(s => [s.options.body, s.options.silent])).toEqual([['Appel terminé.', true]])
    // A missed call likewise; another call of the same caller is another call.
    await sw.push({ type: 'missed', callId: 'c3', number: '102' })
    await sw.push({ type: 'call', callId: 'c3', number: '102', until: IN_A_MINUTE() })
    await sw.push({ type: 'call', callId: 'c4', number: '102', until: IN_A_MINUTE() })
    expect(sw.notifications.map(n => n.title)).toEqual(['Appel de 101', 'Appel manqué de 102', 'Appel de 102'])
  })

  it('shows a quiet notification while the window on screen is not registered yet, closed once that window rings the call', async () => {
    const sw = load('fr-FR', [{ url: 'https://phone.example.test/', visibilityState: 'visible', answers: 'connecting' }])
    const until = IN_A_MINUTE()
    await sw.push({ type: 'call', callId: 'c1', number: '101', until })
    expect(sw.shown).toEqual([{ title: 'Appel de 101', options: { body: 'Cliquez pour répondre dans TwakePhone.', tag: 'call-c1', silent: true, data: { url: '/?call=c1', until, quiet: true, callId: 'c1' } } }])
    // Another call rings in that window: nothing closed; this one rings there (its id is the Call-ID then the From tag).
    await sw.ringing(['other-tag'])
    expect(sw.notifications).toHaveLength(1)
    await sw.ringing([42, 'c1abcdef'])
    expect(sw.notifications).toHaveLength(0)
    // A notification of the full kind stays: the window that rings is not the one on screen.
    const full = load()
    await full.push({ type: 'call', callId: 'c1', number: '101', until: IN_A_MINUTE() })
    await full.ringing(['c1abcdef'])
    expect(full.notifications).toHaveLength(1)
  })

  it('shows no call while a window of the app on screen rings it itself; a window that does not (signed out) gets the notification', async () => {
    const ringing = load('fr-FR', [{ url: 'https://phone.example.test/', visibilityState: 'visible', answers: 'registered' }])
    await ringing.push({ type: 'call', callId: 'c1', number: '101', until: IN_A_MINUTE() })
    expect(ringing.shown).toEqual([])
    expect(ringing.windows[0]!.messages).toEqual([{ type: 'twakephone.ring', callId: 'c1' }])
    // Its end then only closes what may be there: nothing new on screen.
    await ringing.push({ type: 'ended', callId: 'c1', number: '101', reason: 'answered' })
    expect(ringing.shown).toEqual([])
    const signedOut = load('fr-FR', [{ url: 'https://phone.example.test/', visibilityState: 'visible' }])
    await signedOut.push({ type: 'call', callId: 'c1', number: '101', until: IN_A_MINUTE() })
    expect(signedOut.shown.map(s => s.options.body)).toEqual(['Cliquez pour répondre dans TwakePhone.'])
    // A window in the background is not asked.
    const hidden = load('fr-FR', [{ url: 'https://phone.example.test/', answers: 'registered' }])
    await hidden.push({ type: 'call', callId: 'c1', number: '101', until: IN_A_MINUTE() })
    expect(hidden.shown).toHaveLength(1)
    expect(hidden.windows[0]!.messages).toBeUndefined()
  })

  it('handles pushes one after the other: never lists the notifications while one is being shown', async () => {
    const sw = load()
    // A call and its end pushed close together: the end waits for the call to be shown, then replaces it.
    await Promise.all([
      sw.push({ type: 'call', callId: 'c1', number: '101', until: IN_A_MINUTE() }),
      sw.push({ type: 'ended', callId: 'c1', number: '101', reason: 'over' }),
      sw.push({ type: 'missed', callId: 'c2', number: '102' })
    ])
    expect(sw.showing.listedDuring).toBe(0)
    expect(sw.shown.map(s => s.options.body)).toEqual(['Cliquez pour répondre dans TwakePhone.', 'Appel terminé.', 'TwakePhone'])
    expect(sw.notifications.map(n => n.tag)).toEqual(['call-c1', 'call-c2'])
    // One that fails does not stop the next.
    const broken = load()
    await Promise.all([broken.push({ type: 'call', callId: 'c1', number: '101', until: IN_A_MINUTE() }), broken.push({ type: 'missed', callId: 'c2', number: '102' })])
    expect(broken.notifications).toHaveLength(2)
  })

  it('shows something for any push (the browsers require it), and no more than one short line of what it says', async () => {
    const sw = load()
    await sw.push(undefined)
    await sw.push('{"type":"other"}')
    await sw.push({ type: 'call', callId: 'c3', number: '101', name: `Alice\nX-Evil ${'x'.repeat(200)}`, until: IN_A_MINUTE() })
    expect(sw.shown.slice(0, 2).map(s => s.title)).toEqual(['TwakePhone', 'TwakePhone'])
    expect(sw.shown[2]!.title).not.toContain('\n')
    expect(sw.shown[2]!.title.length).toBeLessThan(100)
  })

  it('opens the app on the call, or tells the window already open which call and brings it forward', async () => {
    const sw = load()
    expect(await sw.click('/?call=c1')).toBe(true)
    expect(sw.opened).toEqual(['https://phone.example.test/?call=c1'])
    // Never a page elsewhere, whatever the notification says.
    await sw.click('https://evil.example.test/x')
    expect(sw.opened[1]).toBe('https://phone.example.test/')
    const open = load('fr-FR', [{ url: 'https://other.example.test/' }, { url: 'https://phone.example.test/recents' }])
    await open.click('/?call=c1')
    expect(open.opened).toEqual([])
    expect(open.windows[1]).toMatchObject({ focused: true, messages: [{ type: 'twakephone.open', path: '/?call=c1' }] })
    expect(open.windows[0]!.focused).toBeUndefined()
    // A browser that refuses the focus: the window is told all the same.
    const refused = load('fr-FR', [{ url: 'https://phone.example.test/', refusesFocus: true }])
    await refused.click('/?call=c1')
    expect(refused.windows[0]!.messages).toEqual([{ type: 'twakephone.open', path: '/?call=c1' }])
  })
})
