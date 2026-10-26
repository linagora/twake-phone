import { Telephone } from '@linagora/twake-icons'
import { Alert, Avatar, List, ListItem, ListItemAvatar, ListItemButton, ListItemText, SvgIcon, ToggleButton, ToggleButtonGroup, Typography, useAlert } from '@linagora/twake-mui'
import { useEffect, useState } from 'react'
import { formatNumber, type HistoryItem } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { Reloader } from '../reload.js'
import { ContactAvatar } from '../components/ContactList.js'
import { CopyAction, OpenCardAction } from '../components/RowActions.js'
import { useContactsByNumber } from '../contactsByNumber.js'
import { HoverActions } from '../ds/HoverActions/HoverActions.js'
import { useCallNumber } from '../useCallNumber.js'

/** How long the history waits for the event stream before it is read without it. */
const WITHOUT_STREAM_MS = 3_000

/**
 * Missed (the phone rang, nobody took it), declined (the user refused it), a conference (step 8b), a call a mailbox
 * took for the caller (step 11a), or simply in or out.
 */
const recentLabel = (it: HistoryItem, t: (key: Key) => string) =>
  it.missed
    ? t('recents.missed')
    : it.voicemail && it.direction === 'outbound'
      ? t('recents.voicemail')
    : it.direction === 'inbound' && it.state === 'rejected'
      ? t('recents.declined')
      : it.conference
        ? t('recents.conference')
        : it.direction === 'inbound'
          ? t('recents.inbound')
          : t('recents.outbound')

/** The day a call belongs to, as a list of calls on a phone says it: today, yesterday, then the date. */
export const dayLabel = (iso: string, now: Date, lang: string, t: (key: Key) => string) => {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(new Date(iso))) / 86_400_000)
  return days === 0 ? t('recents.today') : days === 1 ? t('recents.yesterday') : new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(new Date(iso))
}

/** The calls, newest first, in runs of the same day (the list is already in that order). */
export const byDay = <I extends { startedAt: string }>(items: readonly I[], label: (iso: string) => string) => {
  const groups: { label: string; items: I[] }[] = []
  for (const it of items) {
    const l = label(it.startedAt)
    if (groups.at(-1)?.label === l) groups.at(-1)!.items.push(it)
    else groups.push({ label: l, items: [it] })
  }
  return groups
}

export const Recents = () => {
  const { t, lang } = useT()
  const { client, me, onEvent, onConnected } = useGateway()
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [error, setError] = useState(false)
  const [filter, setFilter] = useState<'all' | 'missed'>('all')
  const { showAlert } = useAlert()
  const { call, can } = useCallNumber(text => text && showAlert({ message: text, severity: 'error' }))
  const contacts = useContactsByNumber(items?.map(it => it.remoteNumber) ?? [])
  // Read when the event stream is established (at once when it already is: the ends told while it was closed were
  // not heard), each time one of the user's calls ends (the Gateway records it before telling), and after a few
  // seconds without a stream (the history reads without it). One read at a time; an outage is tried again.
  useEffect(() => {
    const reloader = new Reloader(
      () => client.getHistory({ limit: 50 }),
      page => {
        setItems(page.items)
        setError(false)
      },
      () => setError(true)
    )
    const fallback = setTimeout(() => reloader.request(), WITHOUT_STREAM_MS)
    const stopConnected = onConnected(() => {
      clearTimeout(fallback)
      reloader.request()
    })
    const stopEvents = onEvent(event => {
      if (event.type === 'call.ended' || event.type === 'call.failed') reloader.request()
    })
    return () => {
      clearTimeout(fallback)
      reloader.stop()
      stopConnected()
      stopEvents()
    }
  }, [client, onEvent, onConnected])

  const heading = (
    <Typography variant="h4" component="h1" gutterBottom>
      {t('recents.title')}
    </Typography>
  )
  if (error)
    return (
      <>
        {heading}
        <Alert severity="error" role="alert">
          {t('recents.error')}
        </Alert>
      </>
    )
  if (!items) return heading
  const when = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
  const hour = new Intl.DateTimeFormat(lang, { timeStyle: 'short' })
  const now = new Date()
  const shown = filter === 'missed' ? items.filter(it => it.missed) : items
  return (
    <>
      {heading}
      {items.length ? (
        <ToggleButtonGroup exclusive size="small" value={filter} onChange={(_, v: 'all' | 'missed' | null) => v && setFilter(v)} aria-label={t('recents.filter')} className="u-mb-1">
          <ToggleButton value="all">{t('recents.all')}</ToggleButton>
          <ToggleButton value="missed">{t('recents.missedFilter')}</ToggleButton>
        </ToggleButtonGroup>
      ) : null}
      {shown.length === 0 ? (
        <Typography component="p" color="textSecondary">
          {t(items.length ? 'recents.noMissed' : 'recents.empty')}
        </Typography>
      ) : (
        byDay(shown, iso => dayLabel(iso, now, lang, t)).map((group, g) => (
          <section key={group.label} aria-labelledby={`recents-day-${g}`}>
            <Typography variant="subtitle2" component="h2" color="textSecondary" id={`recents-day-${g}`} className="u-mt-1">
              {group.label}
            </Typography>
            <List data-testid="recents">
              {group.items.map(it => {
                // One's own conference: the room called oneself in it (its number is one's own).
                const mine = it.conference && it.remoteNumber === me?.extension
                const hidden = it.remoteNumber === 'anonymous'
                const contact = mine || hidden ? undefined : contacts.get(it.remoteNumber)
                const number = mine ? t('recents.conferenceMine') : hidden ? t('call.hiddenNumber') : formatNumber(it.remoteNumber)
                const who = contact ? `${contact.displayName} (${number})` : number
                const label = recentLabel(it, t)
                const callable = !mine && can(it.remoteNumber)
                const content = (
                  <>
                    <ListItemAvatar>
                      {contact ? (
                        <ContactAvatar contact={contact} />
                      ) : (
                        <Avatar aria-hidden="true">
                          <SvgIcon component={Telephone} inheritViewBox />
                        </Avatar>
                      )}
                    </ListItemAvatar>
                    <ListItemText
                      primary={contact ? <strong>{contact.displayName}</strong> : <strong data-testid="recent-number">{number}</strong>}
                      secondary={
                        <>
                          {contact ? (
                            <>
                              <span data-testid="recent-number">{number}</span> ·{' '}
                            </>
                          ) : null}
                          <Typography data-testid="recent-label" variant="body2" component="span" color={it.missed ? 'error' : 'textSecondary'} className={it.missed ? 'u-fw-bold' : undefined}>
                            {label}
                          </Typography>
                          {/* Step 10b: a call the operator recorded, reconciled with ours, or that reached only it (the platform out). */}
                          {it.sources?.includes('opensips') === false ? ` · ${t('recents.operatorOnly')}` : it.sources && it.sources.length > 1 ? ` · ${t('recents.reconciled')}` : null}
                          {/* Forwarded there to the fallback number (second review 10b, n°4): missed here, taken there perhaps. */}
                          {it.forwardedToFallback ? ` · ${t('recents.forwardedToFallback')}` : null}
                        </>
                      }
                    />
                    <Typography variant="body2" color="textSecondary" component="time" dateTime={it.startedAt} className="u-ml-1">
                      {hour.format(new Date(it.startedAt))}
                    </Typography>
                  </>
                )
                const actions = [contact ? <OpenCardAction key="card" id={contact.id} label={t('actions.openCard', { name: contact.displayName })} /> : null, !mine && !hidden ? <CopyAction key="copy" number={it.remoteNumber} label={t('actions.copyNumberWhen', { number, when: when.format(new Date(it.startedAt)) })} /> : null].filter(Boolean)
                return (
                  <ListItem key={it.id} divider disablePadding={callable} secondaryAction={actions.length ? <HoverActions>{actions}</HoverActions> : undefined}>
                    {callable ? (
                      // The row calls back, as on a phone; its name says who, what and when (the visible text says it in parts).
                      <ListItemButton onClick={() => void call(it.remoteNumber)} aria-label={t('recents.callBack', { who, what: label, when: when.format(new Date(it.startedAt)) })}>
                        {content}
                      </ListItemButton>
                    ) : (
                      content
                    )}
                  </ListItem>
                )
              })}
            </List>
          </section>
        ))
      )}
    </>
  )
}
