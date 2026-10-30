import { toDialTarget } from '@twake/telephony-client'

import { DIAL_CHANNEL, requestDial } from '@/dialRelay'

/** What @twake/phone-widget posts to its frame for a number (a MessagePort for the answer). */
const DIAL_MESSAGE = 'twake-phone:dial'
const WIDTH = 360

const TEXT = {
  fr: { region: 'Twake Phone', incoming: 'Appel entrant', connected: 'En communication', held: 'En attente', answer: 'Répondre', reject: 'Refuser', hangup: 'Raccrocher' },
  en: { region: 'Twake Phone', incoming: 'Incoming call', connected: 'In a call', held: 'On hold', answer: 'Answer', reject: 'Decline', hangup: 'Hang up' }
}

/** The call to show: one that rings first, else one under way; with the window that has it. */
export const callToShow = windows => {
  const all = [...windows.entries()].flatMap(([window, calls]) => calls.map(call => ({ ...call, window })))
  return all.find(c => c.direction === 'inbound' && c.state === 'ringing') ?? all.find(c => c.state === 'connected' || c.state === 'held') ?? null
}

/**
 * The widget of the other apps (ADR 0034): a remote control of the Twake Phone window, never a phone of its own (its
 * frame would have no session: the identity provider signs in on a click only). It shows the call that rings or runs
 * there, and sends answer, decline or hang up back to that window; it takes the numbers phone-link hands it like the
 * CALL intent does. The intent stays open as long as the host app.
 */
export const serveWidget = ({ service, root, lang }) => {
  const text = TEXT[lang] ?? TEXT.en
  const windows = new Map()
  const channel = new BroadcastChannel(DIAL_CHANNEL)
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', text.region)
  let shown = null

  const button = (label, tone, action, call) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `tpw-btn ${tone}`
    b.textContent = label
    b.addEventListener('click', () => channel.postMessage({ type: 'command', window: call.window, callId: call.id, action }))
    return b
  }

  const render = () => {
    const call = callToShow(windows)
    const key = call && `${call.window}/${call.id}/${call.state}`
    if (key === shown) return
    shown = key
    root.replaceChildren()
    if (!call) return service.resizeClient({ width: 0, height: 0 })
    const card = document.createElement('div')
    card.className = 'tpw-card'
    if (call.state === 'ringing') card.setAttribute('role', 'alertdialog')
    card.setAttribute('aria-label', call.state === 'ringing' ? text.incoming : text[call.state] ?? text.connected)
    const who = document.createElement('div')
    who.className = 'tpw-who'
    const name = document.createElement('strong')
    name.textContent = call.remoteName ? `${call.remoteName} (${call.remoteNumber})` : call.remoteNumber
    const state = document.createElement('span')
    state.textContent = call.state === 'ringing' ? text.incoming : text[call.state] ?? text.connected
    who.append(name, state)
    const actions = document.createElement('div')
    actions.className = 'tpw-actions'
    if (call.state === 'ringing') actions.append(button(text.reject, 'tpw-danger', 'reject', call), button(text.answer, 'tpw-accept', 'answer', call))
    else actions.append(button(text.hangup, 'tpw-danger', 'hangup', call))
    card.append(who, actions)
    root.append(card)
    service.resizeClient({ width: WIDTH, height: Math.ceil(card.getBoundingClientRect().height) + 16 })
  }

  channel.onmessage = ({ data }) => {
    if (data?.type !== 'calls' || typeof data.window !== 'string' || !Array.isArray(data.calls)) return
    if (data.calls.length) windows.set(data.window, data.calls)
    else windows.delete(data.window)
    render()
  }
  // What the windows open now have (they say it again at each change).
  channel.postMessage({ type: 'calls-request' })

  // phone-link, from the host page: a number for the dialer of a Twake Phone window on screen (ADR 0032).
  window.addEventListener('message', event => {
    const port = event.ports?.[0]
    if (event.source !== window.parent || event.data?.type !== DIAL_MESSAGE || !port) return
    const number = typeof event.data.number === 'string' && event.data.number.length <= 40 ? toDialTarget(event.data.number) : null
    if (!number) return port.postMessage({ handled: false, error: 'invalid-number' })
    void requestDial(number).then(result => port.postMessage(result))
  })
  render()
}
