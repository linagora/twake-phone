import { Button, Chip, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { FRAUD_PARAMS, OUTBOUND_CAPS, TRUNK_OUTBOUND_CLASSES, type AdminAlert, type AdminUser, type AlertFilter } from '@twake/telephony-client'
import { CheckBox, NoteLine, Section, SelectField, useLatest, useProblem, useRefresh, type Note } from '../../admin/ui.js'
import { refusalCode, refusalOf, refusalStatus } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

const KINDS: NonNullable<AlertFilter['kind']>[] = ['fraud-warning', 'fraud-critical', 'limit', 'rights', 'emergency', 'meet', 'webhook', 'operator', 'voicemail']
const PARAMS = [
  ...FRAUD_PARAMS,
  ...OUTBOUND_CAPS,
  ...TRUNK_OUTBOUND_CLASSES,
  'premium',
  'burst',
  'pin-tries',
  'meet-calls',
  'call-diverted',
  'trunk-changed',
  'disabled',
  'unauthorized',
  'forbidden',
  'reconciliation',
  'removal-changed',
  'removal-gone',
  'removal-late',
  'sync-failing',
  'flows-failing',
  'sync-fenced',
  'boxes-refused',
  'hidden-calls',
  'hidden-hour',
  'hidden-all',
  'calls-all',
  'held-back',
  'held-back-remove'
]
const PAGE = 25
/** How long after an answer the first page is read again while shown: a repeat counted meanwhile is seen (review 7 n°2). */
export const ALERTS_REFRESH_MS = 30_000
const ALL = ''
/** What the screen shows first: the alerts not yet looked at. */
const INITIAL = { kind: ALL, param: ALL, state: 'open' }

/**
 * What an alert's `param` names, in words: a threshold, a cap, a class of numbers, a burst of emergency calls, the
 * tries of a room's PIN by phone, the calls to the rooms at the same time, or a room's call that did not go where the
 * Gateway sent it (review 8b, n°3: its grant taken by another call, or LiveKit's trunk pointed elsewhere), or a webhook
 * subscription disabled after a day of failed deliveries (review 10a, n°1) or with too many waiting (second review, n°12),
 * or the operator of the trunks refusing its keys or reconciling too few calls (review 10b, n°12), or a removal of a
 * forward there left as changed, let go, or late, or the mailboxes not synchronised
 * with the voicemail server for a while, some it keeps refusing, or the callers with no
 * number at the cap of a mailbox, or the transcription of the messages or the bot's notices failing (step 11b).
 */
const paramKey = (alert: Pick<AdminAlert, 'kind' | 'param'>): Key | undefined => {
  if ((FRAUD_PARAMS as readonly string[]).includes(alert.param)) return `admin.fraud.${alert.param}` as Key
  if ((OUTBOUND_CAPS as readonly string[]).includes(alert.param)) return `admin.cap.${alert.param}` as Key
  if (alert.param === 'burst') return 'admin.alert.burst'
  if (alert.param === 'pin-tries') return 'admin.alert.pinTries'
  if (alert.param === 'meet-calls') return 'admin.alert.meetCalls'
  if (alert.param === 'call-diverted') return 'admin.alert.callDiverted'
  if (alert.param === 'trunk-changed') return 'admin.alert.trunkChanged'
  if (alert.param === 'disabled') return 'admin.alert.webhookDisabled'
  if (alert.param === 'backlog') return 'admin.alert.webhookBacklog'
  // The operator of the trunks (review 10b, n°12): its keys refused round after round, too few records reconciled.
  if (alert.param === 'unauthorized') return 'admin.alert.operatorUnauthorized'
  if (alert.param === 'forbidden') return 'admin.alert.operatorForbidden'
  if (alert.param === 'reconciliation') return 'admin.alert.operatorReconciliation'
  // A removal of a forward at the operator (third review 10b, n°2 and n°4): changed there since, the line unknown, late.
  if (alert.param === 'removal-changed') return 'admin.alert.operatorRemovalChanged'
  if (alert.param === 'removal-gone') return 'admin.alert.operatorRemovalGone'
  if (alert.param === 'removal-late') return 'admin.alert.operatorRemovalLate'
  // The mailboxes not synchronised for a while, or their writes refused by the SIP server's database (its fence), some
  // the voicemail server keeps refusing; a cap of the calls to the mailboxes reached: by the callers with no number at
  // a mailbox or at all of them, or by all callers.
  if (alert.param === 'sync-failing') return 'admin.alert.voicemailSyncFailing'
  if (alert.param === 'flows-failing') return 'admin.alert.voicemailFlowsFailing'
  if (alert.param === 'sync-fenced') return 'admin.alert.voicemailSyncFenced'
  if (alert.param === 'boxes-refused') return 'admin.alert.voicemailBoxesRefused'
  if (alert.param === 'hidden-calls') return 'admin.alert.voicemailHiddenCalls'
  if (alert.param === 'hidden-hour') return 'admin.alert.voicemailHiddenHour'
  if (alert.param === 'hidden-all') return 'admin.alert.voicemailHiddenAll'
  if (alert.param === 'calls-all') return 'admin.alert.voicemailCallsAll'
  // Too many mailboxes set aside or removed at once: held back until an administrator confirms.
  if (alert.param === 'held-back') return 'admin.alert.voicemailHeldBack'
  if (alert.param === 'held-back-remove') return 'admin.alert.voicemailHeldBackRemove'
  // The transcription of the messages and the bot's notices (step 11b): too many waiting, a service that keeps failing.
  if (alert.param === 'transcription-busy') return 'admin.alert.voicemailTranscriptionBusy'
  if (alert.param === 'transcription-failed') return 'admin.alert.voicemailTranscriptionFailed'
  if (alert.param === 'notice-failed') return 'admin.alert.voicemailNoticeFailed'
  // Messages and notices that wait for too long, people the bot has no account of, notices left in Chat without a bot.
  if (alert.param === 'transcription-backlog') return 'admin.alert.voicemailTranscriptionBacklog'
  if (alert.param === 'notice-no-account') return 'admin.alert.voicemailNoticeNoAccount'
  if (alert.param === 'notice-not-withdrawn') return 'admin.alert.voicemailNoticeNotWithdrawn'
  // The reconciliation of the mailboxes: mailboxes read empty or too many messages gone at once (nothing erased), a mailbox it cannot read.
  if (alert.param === 'transcription-held') return 'admin.alert.voicemailTranscriptionHeld'
  if (alert.param === 'transcription-unreadable') return 'admin.alert.voicemailTranscriptionUnreadable'
  if ((TRUNK_OUTBOUND_CLASSES as readonly string[]).includes(alert.param) || alert.param === 'premium') return `admin.class.${alert.param}` as Key
  return undefined
}

/**
 * The alerts the SIP server raised (step 7, FR-D6): the latest repeated first, a page at a time, of one kind, one
 * cause or one state if asked; each one acknowledged once looked at (a repeat afterwards opens a new one).
 */
export const Alerts = () => {
  const { t, lang } = useT()
  const say = useProblem()
  const { client } = useGateway()
  const [filter, setFilter] = useState<{
    kind: string
    param: string
    state: string
  }>(INITIAL)
  const [shown, setShown] = useState(filter)
  const [items, setItems] = useState<AdminAlert[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const firstNew = useRef<HTMLTableRowElement | null>(null)
  // The row to take the focus once shown: given once, when asked (a new page), never again as the rows change
  // (review 7 ter, n°7). An object, so that the same index asked again is asked.
  const [focusAt, setFocusAt] = useState<{ at: number } | null>(null)
  // More than the first page shown: not read again on its own (the rows would move under the reader).
  const [extended, setExtended] = useState(false)
  // Read again on its own unless asked not to (RGAA 13.8, review 7 bis n°5).
  const [auto, setAuto] = useState(true)
  const words = useLatest(say)
  // Each read is numbered: only the answer of the last one asked is shown, a page, a filter or a read of the screen
  // answered late never replaces what was asked after it (review 7 bis, n°4).
  const reads = useRef(0)
  // A read, a page or an acknowledgement asked by the administrator going on: the screen reads nothing on its own.
  const asked = useRef(0)
  // The list and its buttons: while the focus is there, nothing moves under it.
  const list = useRef<HTMLDivElement | null>(null)

  const query = useCallback(
    (f: typeof filter, before?: string): AlertFilter => ({
      limit: PAGE,
      ...(f.kind ? { kind: f.kind as AlertFilter['kind'] } : {}),
      ...(f.param ? { param: f.param } : {}),
      ...(f.state ? { state: f.state as AlertFilter['state'] } : {}),
      ...(before ? { before } : {})
    }),
    []
  )
  // The first page of `f`. It depends on nothing the language changes: a change of language reads nothing again, and
  // never puts back the first filter while the lists show another one (review 7 n°13).
  const read = useCallback(
    (f: typeof filter, onItsOwn = false) => {
      const mine = ++reads.current
      return client.listAlerts(query(f)).then(
        r => {
          if (mine !== reads.current) return
          // Read on its own, and the focus went into the list meanwhile: nothing moves under it (review 7 ter, n°8).
          if (onItsOwn && list.current?.contains(document.activeElement)) return
          setItems(r.items)
          setNext(r.next)
          setShown(f)
          setExtended(false)
        },
        (err: unknown) => {
          if (mine === reads.current)
            setNote({
              kind: 'error',
              text: words.current(refusalOf(err, () => undefined).problem)!
            })
        }
      )
    },
    [client, query, words]
  )
  useEffect(() => {
    void read(INITIAL)
  }, [read])
  const again = () => read(shown)
  /** What the administrator asked: the screen reads nothing on its own meanwhile, and its answer comes first. */
  const asking = <T,>(run: () => Promise<T>) => {
    asked.current++
    setBusy(true)
    return run().finally(() => {
      asked.current--
      setBusy(false)
    })
  }
  // On its own: not while something asked goes on, nor while the focus is in the list (a row, its button), which
  // would move or go under it (review 7 bis, n°5).
  const onItsOwn = () => (asked.current > 0 || list.current?.contains(document.activeElement) ? Promise.resolve() : read(shown, true))
  useRefresh(onItsOwn, ALERTS_REFRESH_MS, auto && items !== null && !extended)
  useEffect(() => {
    client.listAdminUsers().then(
      r => setUsers(r.items),
      () => setUsers([])
    )
  }, [client])
  useEffect(() => {
    if (focusAt !== null) firstNew.current?.focus()
  }, [focusAt])

  const apply = (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    void asking(() => read(filter))
  }

  const refresh = () => {
    setNote(null)
    void asking(again)
  }

  const more = () => {
    if (!next || !items) return
    const from = items.length
    const mine = ++reads.current
    void asking(() =>
      client.listAlerts(query(shown, next)).then(
        r => {
          // Another read asked since (a filter, the first page again): this page is not of what is shown.
          if (mine !== reads.current) return
          setItems(list => [...(list ?? []), ...r.items])
          setNext(r.next)
          setExtended(true)
          // The focus goes to the first alert of the new page (the button may disappear with the last one).
          setFocusAt({ at: from })
        },
        (err: unknown) => {
          if (mine === reads.current)
            setNote({
              kind: 'error',
              text: say(refusalOf(err, () => undefined).problem)!
            })
        }
      )
    )
  }

  const acknowledge = (alert: AdminAlert) => {
    setNote(null)
    return asking(() => acknowledging(alert))
  }
  const acknowledging = async (alert: AdminAlert) => {
    // A read of the screen going on was asked before: its answer would put the row back.
    reads.current++
    try {
      // As it was seen, its last time and how many times: refused when it repeated since (the repeat is shown, to be
      // looked at first), even within the same millisecond (review 7 bis, n°3).
      const done = await client.acknowledgeAlert(alert.id, alert.lastAt, alert.count)
      setItems(list => (list ?? []).flatMap(a => (a.id !== alert.id ? [a] : shown.state === 'open' ? [] : [done])))
      // The row may go, its button with it: the focus goes to what is said.
      setNote({ kind: 'ok', text: t('admin.alert.acknowledged'), focus: true })
    } catch (err) {
      const changed = refusalCode(err) === 'ALERT_CHANGED'
      // Gone: removed after its retention (or never this organisation's), not a platform that cannot.
      const gone = refusalStatus(err) === 404
      if (changed || gone) await read(shown)
      setNote({
        kind: 'error',
        text: gone ? t('admin.alert.gone') : say(refusalOf(err, () => undefined).problem)!,
        focus: true
      })
    }
  }

  const when = new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', {
    dateStyle: 'short',
    timeStyle: 'medium'
  })
  const who = (a: AdminAlert) => {
    if (!a.extension) return a.scope === 'tenant' ? t('admin.alert.tenant') : '—'
    const user = users.find(u => u.extension === a.extension)
    return user ? `${a.extension} (${user.displayName ?? user.userId})` : a.extension
  }
  const byName = (id: string | undefined) => {
    const user = id ? users.find(u => u.userId === id) : undefined
    return user?.displayName ?? id ?? '—'
  }
  const cause = (a: AdminAlert) => {
    const key = paramKey(a)
    const name = key ? t(key) : a.param
    const scope = a.kind === 'limit' && a.scope ? ` (${t(a.scope === 'tenant' ? 'admin.alert.scopeTenant' : 'admin.alert.scopeUser')})` : ''
    // A value with no threshold said as it is (the minutes a synchronisation fails, the mailboxes refused).
    const value = a.value === undefined ? '' : a.threshold !== undefined ? ` : ${t('admin.alert.valueOf', { value: a.value, threshold: a.threshold })}` : ` : ${a.value}`
    // A set-aside held back: the new holders left without a mailbox meanwhile, and the voicemail off for everyone.
    const held = `${a.waiting ? ` ; ${t('admin.alert.voicemailWaiting', { waiting: a.waiting })}` : ''}${a.noneReached ? ` ; ${t('admin.alert.voicemailOff')}` : ''}`
    return `${name}${scope}${value}${held}`
  }
  const opt = (value: string, label: string) => ({ value, label })
  return (
    <Section id="alerts" title={t('admin.nav.alerts')}>
      <Typography component="p" gutterBottom>
        {t('admin.alert.help')}
      </Typography>
      <form onSubmit={apply}>
        <SelectField
          id="alerts-state"
          label={t('admin.alert.state')}
          value={filter.state}
          onChange={v => setFilter(f => ({ ...f, state: v }))}
          options={[opt('open', t('admin.alert.stateOpen')), opt('acknowledged', t('admin.alert.stateAcknowledged')), opt(ALL, t('admin.alert.all'))]}
        />
        <SelectField
          id="alerts-kind"
          label={t('admin.alert.kind')}
          value={filter.kind}
          onChange={v => setFilter(f => ({ ...f, kind: v }))}
          options={[opt(ALL, t('admin.alert.all')), ...KINDS.map(k => opt(k, t(`admin.alert.kind.${k}` as Key)))]}
        />
        <SelectField
          id="alerts-param"
          label={t('admin.alert.param')}
          value={filter.param}
          onChange={v => setFilter(f => ({ ...f, param: v }))}
          options={[opt(ALL, t('admin.alert.all')), ...PARAMS.map(p => opt(p, t(paramKey({ kind: 'limit', param: p })!)))]}
        />
        <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
          <Button type="submit" variant="outlined" disabled={busy}>
            {t('admin.alert.filter')}
          </Button>
        </Stack>
      </form>
      {items === null ? null : items.length ? (
        <TableContainer role="region" tabIndex={0} aria-label={t('admin.alert.list')} ref={list}>
          <Table size="small">
            <caption className="u-visuallyhidden">{t('admin.alert.list')}</caption>
            <TableHead>
              <TableRow>
                <TableCell component="th" scope="col">
                  {t('admin.alert.when')}
                </TableCell>
                <TableCell component="th" scope="col">
                  {t('admin.alert.kind')}
                </TableCell>
                <TableCell component="th" scope="col">
                  {t('admin.alert.param')}
                </TableCell>
                <TableCell component="th" scope="col">
                  {t('admin.alert.who')}
                </TableCell>
                <TableCell component="th" scope="col">
                  {t('admin.alert.number')}
                </TableCell>
                <TableCell component="th" scope="col">
                  {t('admin.alert.count')}
                </TableCell>
                <TableCell component="th" scope="col">
                  {t('admin.alert.state')}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((a, i) => (
                <TableRow key={a.id} ref={i === focusAt?.at ? firstNew : undefined} tabIndex={i === focusAt?.at ? -1 : undefined}>
                  <TableCell>
                    <time dateTime={a.lastAt}>{when.format(new Date(a.lastAt))}</time>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={a.kind === 'fraud-critical' ? 'error' : a.kind === 'fraud-warning' ? 'warning' : 'default'}
                      label={t(`admin.alert.kind.${a.kind}` as Key)}
                    />
                  </TableCell>
                  <TableCell>{cause(a)}</TableCell>
                  <TableCell>{who(a)}</TableCell>
                  <TableCell>{a.number ?? '—'}</TableCell>
                  <TableCell>
                    {a.count > 1
                      ? t('admin.alert.repeated', {
                          count: a.count,
                          first: when.format(new Date(a.at))
                        })
                      : '1'}
                  </TableCell>
                  <TableCell>
                    {a.acknowledgedAt ? (
                      t('admin.alert.acknowledgedBy', {
                        date: when.format(new Date(a.acknowledgedAt)),
                        by: byName(a.acknowledgedBy)
                      })
                    ) : (
                      <Button
                        variant="outlined"
                        onClick={() => void acknowledge(a)}
                        disabled={busy}
                        aria-label={t('admin.alert.acknowledgeOf', {
                          cause: cause(a),
                          when: when.format(new Date(a.lastAt))
                        })}
                      >
                        {t('admin.alert.acknowledge')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography component="p" variant="body2" color="textSecondary">
          {t('admin.alert.none')}
        </Typography>
      )}
      <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-mb-1">
        {next ? (
          <Button variant="outlined" onClick={more} disabled={busy}>
            {t('admin.alert.more')}
          </Button>
        ) : null}
        <Button variant="outlined" onClick={refresh} disabled={busy}>
          {t('admin.alert.refresh')}
        </Button>
      </Stack>
      <CheckBox id="alerts-auto" label={t('admin.alert.auto', { seconds: ALERTS_REFRESH_MS / 1000 })} hint={t('admin.alert.autoHint')} checked={auto} onChange={setAuto} />
      <NoteLine note={note} />
    </Section>
  )
}
