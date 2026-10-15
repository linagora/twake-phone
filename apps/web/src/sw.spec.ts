import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// public/sw.js run as a browser runs it, in a scope of its own: `self` with its registration and clients, here fakes.
type Handler = (event: Record<string, unknown>) => void
const load = (language = 'fr-FR', windows: { url: string; focused?: boolean; messages?: unknown[] }[] = []) => {
  const handlers = new Map<string, Handler>()
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const opened: string[] = []
  const self: Record<string, unknown> = {
    navigator: { language },
    location: { origin: 'https://phone.example.test' },
    addEventListener: (type: string, h: Handler) => void handlers.set(type, h),
    skipWaiting: () => undefined,
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: {
      claim: async () => undefined,
      matchAll: async () =>
        windows.map(w => ({
          url: w.url,
          focus: async () => void (w.focused = true),
          postMessage: (m: unknown) => void (w.messages ??= []).push(m)
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
  const click = (url: string) => {
    let closed = false
    return fire('notificationclick', { notification: { data: { url }, close: () => void (closed = true) } }).then(() => closed)
  }
  return { shown, opened, push, click, windows }
}

describe('the service worker (public/sw.js)', () => {
  it('shows a call with the caller\'s directory name, once per call, until the person acts', async () => {
    const sw = load()
    await sw.push({ type: 'call', callId: 'c1', number: '101', name: 'Alice Martin', until: 0 })
    expect(sw.shown).toEqual([{ title: 'Appel de Alice Martin (101)', options: { body: 'Cliquez pour répondre dans TwakePhone.', tag: 'call-c1', renotify: true, requireInteraction: true, data: { url: '/?call=c1' } } }])
    // A group's, in English; a caller without a name shows its number.
    const en = load('en-GB')
    await en.push({ type: 'call', callId: 'c2', number: '104', group: { number: '200', name: 'Accueil' }, until: 0 })
    expect(en.shown[0]!.title).toBe('Call from 104 for Accueil (200)')
  })

  it('turns the notification of a call nobody answered into that of a missed call', async () => {
    const sw = load()
    await sw.push({ type: 'missed', callId: 'c1', number: '101', name: 'Alice Martin' })
    expect(sw.shown).toEqual([{ title: 'Appel manqué de Alice Martin (101)', options: { body: 'TwakePhone', tag: 'call-c1', data: { url: '/recents' } } }])
  })

  it('shows something for any push (the browsers require it), and no more than one short line of what it says', async () => {
    const sw = load()
    await sw.push(undefined)
    await sw.push('{"type":"other"}')
    await sw.push({ type: 'call', callId: 'c3', number: '101', name: `Alice\nX-Evil ${'x'.repeat(200)}`, until: 0 })
    expect(sw.shown.slice(0, 2).map(s => s.title)).toEqual(['TwakePhone', 'TwakePhone'])
    expect(sw.shown[2]!.title).not.toContain('\n')
    expect(sw.shown[2]!.title.length).toBeLessThan(100)
  })

  it('opens the app on the call, or brings forward the window already open and tells it which call', async () => {
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
  })
})
