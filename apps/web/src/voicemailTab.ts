import { useEffect, useState } from 'react'
import type { TelephonyClient } from '@twake/telephony-client'
import type { TelephonyEvent } from '@twake/telephony-types'
import { Reloader } from './reload.js'

const isVoicemailEvent = (event: TelephonyEvent) => event.type === 'voicemail.created' || event.type === 'voicemail.updated' || event.type === 'voicemail.deleted'

/**
 * The tab « Messagerie vocale » (step 11a): whether the platform has a mailbox for this person (capability
 * `voicemail`), and how many of their messages are not listened to. Read at the start and again each time the event
 * stream is established (second review 11a, n°14: a Gateway out a moment at the start no longer hides the tab until the
 * page is reloaded; an outage is tried again with a backoff), the count again at each message left, read or deleted,
 * on whatever screen.
 */
export const useVoicemailTab = (
  client: Pick<TelephonyClient, 'getCapabilities' | 'listVoicemails'>,
  extension: string | undefined,
  onConnected: (listener: () => void) => () => void,
  onEvent: (listener: (event: TelephonyEvent) => void) => () => void
) => {
  const [tab, setTab] = useState({ on: false, unread: 0 })
  useEffect(() => {
    if (!extension) return
    let on = false
    const count = new Reloader(
      () => client.listVoicemails(),
      page => setTab({ on, unread: page.items.filter(i => i.unread).length })
    )
    const caps = new Reloader(
      () => client.getCapabilities(),
      c => {
        on = !!c.voicemail
        setTab(t => ({ on, unread: on ? t.unread : 0 }))
        if (on) count.request()
      }
    )
    caps.request()
    const stopConnected = onConnected(() => caps.request())
    const stopEvents = onEvent(event => {
      if (on && isVoicemailEvent(event)) count.request()
    })
    return () => {
      caps.stop()
      count.stop()
      stopConnected()
      stopEvents()
    }
  }, [client, extension, onConnected, onEvent])
  return extension ? tab : { on: false, unread: 0 }
}
