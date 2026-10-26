import { Alert, Button, Card, CardContent, Chip, FormHelperText, List, ListItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField as MuiTextField, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { WEBHOOK_EVENT_TYPES, type WebhookDelivery, type WebhookSubscription } from '@twake/telephony-client'
import { CheckBox, CheckGroup, ConfirmDelete, FieldError, NoteLine, ProblemSummary, Section, TextField, useFocusLater, useLatest, useProblem, type Note } from '../../admin/ui.js'
import { WEBHOOK_FIELDS, checkWebhook, checkWebhookDomains, emptyWebhook, refusalOf, refusalStatus, webhookRefusal, type Problem, type Problems, type WebhookField, type WebhookForm } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

const PAGE = 20
const FAILURES = ['http', 'unreachable', 'timeout', 'connection', 'dns', 'tls', 'redirect', 'destination-refused', 'domain-not-allowed', 'secret-unreadable', 'disabled', 'backlog', 'abandoned']

/** A secret just made: shown this once, for the subscription it signs. */
type Secret = {
  subscription: string
  url: string
  value: string
  previousUntil?: string
} | null

/**
 * The webhooks of the organisation (step 10a, ADR 0020): the domains they may be sent to, the subscriptions (an
 * address, the events it takes), the secret that signs them shown once when made or renewed, a test, and the log of
 * each one's deliveries with a replay. Administrators only; checked here as the Gateway checks it, each problem next
 * to its field, the focus on the first one.
 */
export const Webhooks = () => {
  const { t, lang } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const words = useLatest(say)
  const [unavailable, setUnavailable] = useState(false)
  const [domains, setDomains] = useState<string[] | null>(null)
  const [domainsText, setDomainsText] = useState('')
  const [domainsProblem, setDomainsProblem] = useState<Problem | undefined>()
  const [domainsNote, setDomainsNote] = useState<Note>(null)
  const [items, setItems] = useState<WebhookSubscription[] | null>(null)
  const [form, setForm] = useState<WebhookForm>(emptyWebhook)
  const [editing, setEditing] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problems<WebhookField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [secret, setSecret] = useState<Secret>(null)
  const [copied, setCopied] = useState(false)
  const secretRef = useRef<HTMLInputElement>(null)
  // The subscription whose log is shown, its deliveries and the next page.
  const [logOf, setLogOf] = useState<WebhookSubscription | null>(null)
  const [log, setLog] = useState<WebhookDelivery[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [logNote, setLogNote] = useState<Note>(null)
  const logHeading = useRef<HTMLHeadingElement>(null)

  const failed = useCallback(
    (err: unknown) => {
      // 501: no SECRETS_KEY on this platform, no webhooks.
      if (refusalStatus(err) === 501) setUnavailable(true)
      return words.current(refusalOf(err, () => undefined).problem)!
    },
    [words]
  )
  const load = useCallback(() => {
    client.getWebhookDomains().then(
      r => {
        setDomains(r.domains)
        setDomainsText(r.domains.join('\n'))
      },
      (err: unknown) => setDomainsNote({ kind: 'error', text: failed(err) })
    )
    client.listWebhooks().then(
      r => setItems(r.items),
      (err: unknown) => setNote({ kind: 'error', text: failed(err) })
    )
  }, [client, failed])
  useEffect(load, [load])
  useEffect(() => {
    if (secret) secretRef.current?.focus()
  }, [secret])

  const saveDomains = async (e: FormEvent) => {
    e.preventDefault()
    setDomainsNote(null)
    const checked = checkWebhookDomains(domainsText)
    setDomainsProblem(checked.problem)
    if (!checked.domains) {
      document.getElementById('webhook-domains')?.focus()
      return
    }
    setBusy(true)
    try {
      const saved = await client.setWebhookDomains(checked.domains)
      setDomains(saved.domains)
      setDomainsText(saved.domains.join('\n'))
      setDomainsNote({
        kind: 'ok',
        text: t('admin.webhooks.domainsSaved', { count: saved.domains.length })
      })
      // What can be delivered may have changed.
      client.listWebhooks().then(
        r => setItems(r.items),
        () => undefined
      )
    } catch (err) {
      setDomainsNote({ kind: 'error', text: failed(err) })
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setEditing(null)
    setForm(emptyWebhook())
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkWebhook(form, domains ?? [])
    setProblems(checked.problems)
    if (!checked.webhook) {
      focusLater(WEBHOOK_FIELDS, checked.problems, 'webhook')
      return
    }
    setBusy(true)
    try {
      if (editing) {
        await client.updateWebhook(editing, checked.webhook)
        setNote({ kind: 'ok', text: t('admin.webhooks.saved') })
      } else {
        const made = await client.createWebhook(checked.webhook)
        setCopied(false)
        setSecret({ subscription: made.id, url: made.url, value: made.secret })
        setNote({ kind: 'ok', text: t('admin.webhooks.created') })
      }
      reset()
      load()
    } catch (err) {
      const refusal = webhookRefusal(err)
      if (refusalStatus(err) === 404) load()
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const nextProblems = { [refusal.field]: refusal.problem }
        setProblems(nextProblems)
        focusLater(WEBHOOK_FIELDS, nextProblems, 'webhook')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (w: WebhookSubscription) => {
    setNote(null)
    setProblems({})
    setEditing(w.id)
    setForm({
      url: w.url,
      events: w.events,
      description: w.description ?? '',
      enabled: w.enabled
    })
    setTimeout(() => document.getElementById('webhook-url')?.focus(), 0)
  }

  /** Something asked of one subscription: what is said goes where the focus can go (its row may change). */
  const act = async (run: () => Promise<unknown>) => {
    setNote(null)
    setBusy(true)
    try {
      await run()
    } catch (err) {
      if (refusalStatus(err) === 404) load()
      setNote({
        kind: 'error',
        text: say(refusalOf(err, () => undefined).problem)!,
        focus: true
      })
    } finally {
      setBusy(false)
    }
  }
  const test = (w: WebhookSubscription) =>
    act(async () => {
      await client.testWebhook(w.id)
      setNote({
        kind: 'ok',
        text: t('admin.webhooks.testSent', { url: w.url }),
        focus: true
      })
      if (logOf?.id === w.id) void readLog(w)
    })
  const renew = (w: WebhookSubscription, revoke = false) =>
    act(async () => {
      const r = await (revoke ? client.renewWebhookSecret(w.id, { revoke: true }) : client.renewWebhookSecret(w.id))
      setCopied(false)
      setSecret({
        subscription: w.id,
        url: w.url,
        value: r.secret,
        previousUntil: r.previousSecretUntil
      })
      load()
    })
  const resume = (w: WebhookSubscription) =>
    act(async () => {
      await client.resumeWebhook(w.id)
      setNote({
        kind: 'ok',
        text: t('admin.webhooks.resumed', { url: w.url }),
        focus: true
      })
      load()
    })
  const remove = (w: WebhookSubscription) =>
    act(async () => {
      await client.deleteWebhook(w.id)
      setNote({
        kind: 'ok',
        text: t('admin.webhooks.deleted', { url: w.url }),
        focus: true
      })
      if (editing === w.id) reset()
      if (logOf?.id === w.id) setLogOf(null)
      if (secret?.subscription === w.id) setSecret(null)
      load()
    })

  const copy = async () => {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret.value)
      setCopied(true)
    } catch {
      // No clipboard (an insecure page, a refusal): the field is selected, to copy by hand.
      secretRef.current?.select()
    }
  }

  const readLog = (w: WebhookSubscription, before?: string) =>
    client
      .listWebhookDeliveries(w.id, {
        limit: PAGE,
        ...(before ? { before } : {})
      })
      .then(
        r => {
          setLog(list => (before ? [...(list ?? []), ...r.items] : r.items))
          setNext(r.next)
        },
        (err: unknown) => setLogNote({ kind: 'error', text: failed(err) })
      )
  const showLog = (w: WebhookSubscription) => {
    setLogNote(null)
    setLogOf(w)
    setLog(null)
    setNext(undefined)
    void readLog(w).then(() => logHeading.current?.focus())
  }
  const replay = (d: WebhookDelivery) => {
    if (!logOf) return
    setLogNote(null)
    setBusy(true)
    client
      .replayWebhookDelivery(logOf.id, d.id)
      .then(
        () => {
          setLogNote({
            kind: 'ok',
            text: t('admin.webhooks.replayed'),
            focus: true
          })
          return readLog(logOf)
        },
        (err: unknown) =>
          setLogNote({
            kind: 'error',
            text: say(refusalOf(err, () => undefined).problem)!,
            focus: true
          })
      )
      .finally(() => setBusy(false))
  }

  const when = new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', {
    dateStyle: 'short',
    timeStyle: 'medium'
  })
  const eventName = (type: string) => t(`admin.webhooks.event.${type}` as Key)
  const outcome = (d: WebhookDelivery) => {
    const parts: string[] = []
    if (d.lastStatus !== undefined) parts.push(t('admin.webhooks.httpStatus', { status: d.lastStatus }))
    if (d.lastError && d.lastError !== 'http') parts.push(FAILURES.includes(d.lastError) ? t(`admin.webhooks.failure.${d.lastError}` as Key) : d.lastError)
    if (d.status === 'pending' && d.nextAttemptAt && d.attempts > 0)
      parts.push(
        t('admin.webhooks.nextAttempt', {
          date: when.format(new Date(d.nextAttemptAt))
        })
      )
    return parts.join(' · ') || '—'
  }

  if (unavailable)
    return (
      <Section id="webhooks" title={t('admin.webhooks')}>
        <Alert severity="warning">{t('admin.webhooks.unavailable')}</Alert>
      </Section>
    )
  const count = Object.keys(problems).length
  return (
    <>
      <Section id="webhooks" title={t('admin.webhooks')}>
        <Typography component="p" gutterBottom>
          {t('admin.webhooks.help')}
        </Typography>
        <form onSubmit={e => void saveDomains(e)} noValidate aria-labelledby="webhooks-domains-title">
          <Typography variant="h6" component="h3" id="webhooks-domains-title" gutterBottom>
            {t('admin.webhooks.domains')}
          </Typography>
          <div className="u-mb-1">
            <MuiTextField
              id="webhook-domains"
              label={t('admin.webhooks.domainsLabel')}
              multiline
              rows={4}
              fullWidth
              value={domainsText}
              onChange={e => setDomainsText(e.target.value)}
              disabled={busy || domains === null}
              error={Boolean(domainsProblem)}
              slotProps={{
                htmlInput: {
                  spellCheck: false,
                  'aria-invalid': domainsProblem ? true : undefined,
                  'aria-describedby': ['webhook-domains-hint', domainsProblem ? 'webhook-domains-error' : ''].filter(Boolean).join(' ')
                }
              }}
            />
            <FormHelperText id="webhook-domains-hint" component="span">
              {t('admin.webhooks.domainsHint')}
            </FormHelperText>
            <FieldError id="webhook-domains" error={say(domainsProblem)} />
          </div>
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-mb-1">
            <Button type="submit" variant="outlined" disabled={busy || domains === null}>
              {t('admin.webhooks.domainsSave')}
            </Button>
          </Stack>
        </form>
        <NoteLine note={domainsNote} />
      </Section>

      {secret ? (
        <Section id="webhook-secret" title={t('admin.webhooks.secret')}>
          <Alert severity="warning" className="u-mb-1">
            {t('admin.webhooks.secretOnce', { url: secret.url })}
          </Alert>
          {secret.previousUntil ? (
            <Typography component="p" gutterBottom>
              {t('admin.webhooks.secretGrace', {
                date: when.format(new Date(secret.previousUntil))
              })}
            </Typography>
          ) : null}
          <div className="u-mb-1">
            <MuiTextField
              id="webhook-secret-value"
              label={t('admin.webhooks.secretLabel')}
              fullWidth
              value={secret.value}
              inputRef={secretRef}
              onFocus={e => (e.target as HTMLInputElement).select()}
              slotProps={{
                htmlInput: {
                  readOnly: true,
                  'aria-describedby': 'webhook-secret-hint'
                }
              }}
            />
            <FormHelperText id="webhook-secret-hint" component="span">
              {t('admin.webhooks.secretHint')}
            </FormHelperText>
          </div>
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-mb-1">
            <Button variant="outlined" onClick={() => void copy()}>
              {t('admin.webhooks.secretCopy')}
            </Button>
            <Button onClick={() => setSecret(null)}>{t('admin.webhooks.secretDone')}</Button>
          </Stack>
          <Typography component="p" variant="body2" color="textSecondary" role="status">
            {copied ? t('admin.webhooks.secretCopied') : ''}
          </Typography>
        </Section>
      ) : null}

      <Section id="webhook-list" title={t('admin.webhooks.list')}>
        {items === null ? null : items.length ? (
          <List disablePadding data-testid="admin-list" aria-label={t('admin.webhooks.list')}>
            {items.map(w => (
              <ListItem key={w.id} divider disableGutters className="u-flex-wrap">
                <div className="u-flex-grow-1">
                  <strong>{w.url}</strong>
                  {w.description ? ` (${w.description})` : ''}
                  {t('admin.webhooks.itemEvents', {
                    events: w.events.map(eventName).join(', ')
                  })}{' '}
                  {!w.enabled ? (
                    <Chip component="span" size="small" variant="outlined" color="error" label={t(w.disabledReason === 'failing' ? 'admin.webhooks.disabledFailing' : 'admin.webhooks.disabled')} />
                  ) : !w.deliverable ? (
                    <Chip component="span" size="small" variant="outlined" color="error" label={t('admin.webhooks.notDeliverable')} />
                  ) : w.pausedUntil ? (
                    <Chip
                      component="span"
                      size="small"
                      variant="outlined"
                      color="error"
                      label={t('admin.webhooks.paused', {
                        count: w.failures ?? 0,
                        date: when.format(new Date(w.pausedUntil))
                      })}
                    />
                  ) : w.failures ? (
                    <Chip component="span" size="small" variant="outlined" color="error" label={t('admin.webhooks.failing', { count: w.failures })} />
                  ) : null}
                  {w.backlog ? (
                    <Chip
                      component="span"
                      size="small"
                      variant="outlined"
                      color="error"
                      label={t('admin.webhooks.backlog', {
                        count: w.backlog,
                        date: w.backlogAt ? when.format(new Date(w.backlogAt)) : '—'
                      })}
                    />
                  ) : null}
                  {w.previousSecretUntil ? (
                    <Typography component="span" variant="body2" color="textSecondary">
                      {' '}
                      {t('admin.webhooks.previousSecret', {
                        date: when.format(new Date(w.previousSecretUntil))
                      })}
                    </Typography>
                  ) : null}
                </div>
                <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
                  <Button variant="outlined" onClick={() => edit(w)} disabled={busy} aria-label={t('admin.webhooks.editOf', { url: w.url })}>
                    {t('admin.webhooks.edit')}
                  </Button>
                  <Button variant="outlined" onClick={() => void test(w)} disabled={busy || !w.enabled} aria-label={t('admin.webhooks.testOf', { url: w.url })}>
                    {t('admin.webhooks.test')}
                  </Button>
                  <Button variant="outlined" onClick={() => showLog(w)} disabled={busy} aria-label={t('admin.webhooks.logOf', { url: w.url })}>
                    {t('admin.webhooks.log')}
                  </Button>
                  {w.enabled && (w.pausedUntil || w.failures || w.backlog) ? (
                    <Button variant="outlined" onClick={() => void resume(w)} disabled={busy} aria-label={t('admin.webhooks.resumeOf', { url: w.url })}>
                      {t('admin.webhooks.resume')}
                    </Button>
                  ) : null}
                  <ConfirmDelete action="admin.webhooks.renew" tone="plain" yes="admin.webhooks.renewYes" label={t('admin.webhooks.renewOf', { url: w.url })} question={t('admin.webhooks.renewConfirm', { url: w.url })} onConfirm={() => void renew(w)} disabled={busy} />
                  <ConfirmDelete action="admin.webhooks.revoke" yes="admin.webhooks.revokeYes" label={t('admin.webhooks.revokeOf', { url: w.url })} question={t('admin.webhooks.revokeConfirm', { url: w.url })} onConfirm={() => void renew(w, true)} disabled={busy} />
                  <ConfirmDelete label={t('admin.webhooks.deleteOf', { url: w.url })} question={t('admin.webhooks.deleteConfirm', { url: w.url })} onConfirm={() => void remove(w)} disabled={busy} />
                </Stack>
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography component="p" variant="body2" color="textSecondary">
            {t('admin.webhooks.none')}
          </Typography>
        )}
        <NoteLine note={note} />
      </Section>

      <Section id="webhook-form" title={editing ? t('admin.webhooks.editTitle') : t('admin.webhooks.new')}>
        <form onSubmit={e => void save(e)} noValidate aria-labelledby="webhook-form">
          <ProblemSummary count={count} />
          <TextField id="webhook-url" label={t('admin.webhooks.url')} hint={t('admin.webhooks.urlHint')} value={form.url} onChange={v => setForm(f => ({ ...f, url: v }))} error={say(problems.url)} required disabled={busy} maxLength={2048} placeholder="https://crm.example.org/twakephone" />
          <CheckGroup id="webhook-events" legend={t('admin.webhooks.events')} values={WEBHOOK_EVENT_TYPES} chosen={form.events} label={eventName} onChange={events => setForm(f => ({ ...f, events }))} error={say(problems.events)} disabled={busy} />
          <TextField id="webhook-description" label={t('admin.webhooks.description')} value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} error={say(problems.description)} disabled={busy} maxLength={200} />
          <CheckBox id="webhook-enabled" label={t('admin.webhooks.enabled')} hint={t('admin.webhooks.enabledHint')} checked={form.enabled} onChange={enabled => setForm(f => ({ ...f, enabled }))} disabled={busy} />
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {t('admin.webhooks.save')}
            </Button>
            {editing ? (
              <Button variant="outlined" onClick={reset} disabled={busy}>
                {t('admin.webhooks.cancel')}
              </Button>
            ) : null}
          </Stack>
        </form>
      </Section>

      {logOf ? (
        <Card component="section" variant="outlined" aria-labelledby="webhook-log" className="u-mb-1">
          <CardContent>
            <Typography variant="h5" component="h2" id="webhook-log" ref={logHeading} tabIndex={-1} gutterBottom>
              {t('admin.webhooks.logTitle', { url: logOf.url })}
            </Typography>
            {log === null ? null : log.length ? (
              <TableContainer role="region" tabIndex={0} aria-label={t('admin.webhooks.logTitle', { url: logOf.url })}>
                <Table size="small">
                  <caption className="u-visuallyhidden">{t('admin.webhooks.logTitle', { url: logOf.url })}</caption>
                  <TableHead>
                    <TableRow>
                      <TableCell scope="col">{t('admin.webhooks.logWhen')}</TableCell>
                      <TableCell scope="col">{t('admin.webhooks.logEvent')}</TableCell>
                      <TableCell scope="col">{t('admin.webhooks.logStatus')}</TableCell>
                      <TableCell scope="col">{t('admin.webhooks.logAttempts')}</TableCell>
                      <TableCell scope="col">{t('admin.webhooks.logOutcome')}</TableCell>
                      <TableCell scope="col">{t('admin.webhooks.logAction')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {log.map(d => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <time dateTime={d.createdAt}>{when.format(new Date(d.createdAt))}</time>
                        </TableCell>
                        <TableCell>
                          {eventName(d.eventType)}{' '}
                          <Typography component="span" variant="body2" color="textSecondary">
                            {d.eventId}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip component="span" size="small" variant="outlined" color={d.status === 'failed' ? 'error' : d.status === 'delivered' ? 'success' : 'default'} label={t(`admin.webhooks.status.${d.status}` as Key)} />
                        </TableCell>
                        <TableCell>{d.attempts}</TableCell>
                        <TableCell>{outcome(d)}</TableCell>
                        <TableCell>
                          {d.status === 'pending' ? (
                            '—'
                          ) : (
                            <Button
                              variant="outlined"
                              onClick={() => replay(d)}
                              disabled={busy}
                              aria-label={t('admin.webhooks.replayOf', {
                                event: eventName(d.eventType),
                                date: when.format(new Date(d.createdAt))
                              })}
                            >
                              {t('admin.webhooks.replay')}
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
                {t('admin.webhooks.logNone')}
              </Typography>
            )}
            <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-mt-1 u-mb-1">
              {next ? (
                <Button variant="outlined" onClick={() => void readLog(logOf, next)} disabled={busy}>
                  {t('admin.webhooks.logMore')}
                </Button>
              ) : null}
              <Button variant="outlined" onClick={() => void readLog(logOf)} disabled={busy}>
                {t('admin.webhooks.logRefresh')}
              </Button>
            </Stack>
            <NoteLine note={logNote} />
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
