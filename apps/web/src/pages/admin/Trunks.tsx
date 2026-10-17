import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { TRUNK_CODECS, TRUNK_OUTBOUND_CLASSES, formatNumber, type OperatorFallback, type OperatorLine, type OperatorStatus, type Trunk, type TrunkNumberFormat, type TrunkStatus } from '@twake/telephony-client'
import { TargetList } from '../../admin/TargetList.js'
import { targetLabel, useTargets } from '../../admin/targets.js'
import { CheckBox, CheckGroup, ConfirmDelete, NoteLine, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, useRefresh, type Note } from '../../admin/ui.js'
import { TRUNK_FIELDS, checkTrunk, emptyTrunk, refusalStatus, trunkForm, trunkRefusal, type Problems, type TrunkField, type TrunkForm } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

/**
 * How long after an answer the status of the trunks is read again while this screen is shown (a registration takes a
 * few seconds); never in a hidden tab (useRefresh).
 */
export const STATUS_POLL_MS = 5_000
const FORMATS: TrunkNumberFormat[] = ['e164', 'e164-no-plus', 'international-00', 'national']
const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/** The trunk those without a direct number call through: the one marked, else the first (as the Gateway). */
const defaultOf = (trunks: readonly Trunk[]) => trunks.find(t => t.default) ?? trunks[0]

const TrunkState = ({ status, available }: { status: TrunkStatus | undefined; available: boolean }) => {
  const { t } = useT()
  if (!available || !status) return <p className="badge">{t('admin.trunk.statusUnknown')}</p>
  return (
    <ul className="plain" aria-label={t('admin.trunk.status')}>
      {status.registration ? (
        <li>
          {t('admin.trunk.registration')} : <span className={`state state-${status.registration.state}`}>{t(`admin.trunk.reg.${status.registration.state}` as Key)}</span>
        </li>
      ) : null}
      {status.servers.map(s => (
        <li key={s.address}>
          {t('admin.trunk.server', { address: s.address })} : <span className={`state state-${s.state}`}>{t(`admin.trunk.srv.${s.state}` as Key)}</span>
        </li>
      ))}
    </ul>
  )
}

/** What a fallback at the operator forwards, in words: on unavailability, on no answer after a delay, or nothing. */
const forwardsOf = (fb: OperatorFallback | undefined, t: ReturnType<typeof useT>['t']) => {
  const out: string[] = []
  if (fb?.number && fb.onUnavailable) out.push(t('admin.operator.forwardUnavailable', { number: formatNumber(fb.number) }))
  if (fb?.number && fb.noAnswerAfterSec !== undefined) out.push(t('admin.operator.forwardNoAnswer', { number: formatNumber(fb.number), sec: fb.noAnswerAfterSec }))
  return out.length ? out.join(' ; ') : t('admin.operator.noForward')
}

/** A trunk's lines at the operator (step 10b): the forwards set there and whether they are the ones asked. */
const OperatorLines = ({ lines }: { lines: OperatorLine[] }) => {
  const { t, lang } = useT()
  const at = new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' })
  return (
    <ul className="plain" aria-label={t('admin.operator.lines')}>
      {lines.map(l => (
        <li key={l.line}>
          {t('admin.operator.line', { line: l.line })} : {l.readAt || l.appliedAt ? forwardsOf(l.fallback, t) : t('admin.operator.notRead')}
          {' · '}
          {l.error ? (
            <span className="state state-error">{t(`admin.operator.err.${l.error}` as Key)}</span>
          ) : !l.managed ? (
            <span>{t('admin.operator.notManaged')}</span>
          ) : l.inSync ? (
            <span className="state state-up">{t('admin.operator.inSync')}</span>
          ) : (
            <span>{t('admin.operator.pending')}</span>
          )}
          {l.restoredAt ? <> · {t('admin.operator.restored', { at: at.format(new Date(l.restoredAt)) })}</> : null}
        </li>
      ))}
    </ul>
  )
}

/** The records of calls the operator keeps (step 10b): when last read, and what became of those of the last days. */
const OperatorRecords = ({ status, onSync, busy }: { status: OperatorStatus; onSync: () => void; busy: boolean }) => {
  const { t, lang } = useT()
  const at = new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' })
  const cdrs = status.cdrs
  const stats = cdrs?.stats
  // The share of the calls OVH recorded that the platform had too (FR-D4): its forwards and those not settled yet aside.
  const settled = stats ? stats.total - stats.forwarded - stats.pending : 0
  const rate = stats && settled > 0 ? new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(stats.matched / settled) : '–'
  const rows: [Key, number | string][] = stats
    ? [
        ['admin.operator.statRate', rate],
        ['admin.operator.statTotal', stats.total],
        ['admin.operator.statMatched', stats.matched],
        ['admin.operator.statOrphan', stats.orphan],
        ['admin.operator.statUnmatched', stats.unmatchedInbound + stats.unmatchedOutbound],
        ['admin.operator.statForwarded', stats.forwarded],
        ['admin.operator.statPending', stats.pending]
      ]
    : []
  return (
    <>
      <p>{t('admin.operator.help')}</p>
      <p>
        {cdrs?.readAt ? t('admin.operator.readAt', { at: at.format(new Date(cdrs.readAt)), count: cdrs.read ?? 0 }) : t('admin.operator.notYet')}
        {cdrs?.error ? <> · <span className="state state-error">{t(`admin.operator.err.${cdrs.error}` as Key)}</span></> : null}
      </p>
      {stats ? (
        <dl className="facts facts-compact" aria-label={t('admin.operator.stats', { since: at.format(new Date(cdrs.since)) })}>
          {rows.map(([key, n]) => (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p>
        <button type="button" className="btn" onClick={onSync} disabled={busy} aria-busy={busy}>
          {t('admin.operator.sync')}
        </button>
      </p>
    </>
  )
}

/**
 * The trunks to the operator (step 7, FR-D2; ADR 0016): listed with how they are doing (registration, servers),
 * created, changed and removed. The password is write-only: never shown, kept when left empty, removed on demand.
 */
export const Trunks = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const targets = useTargets(client)
  const [trunks, setTrunks] = useState<Trunk[] | null>(null)
  const [status, setStatus] = useState<{ available: boolean; items: TrunkStatus[] }>({ available: false, items: [] })
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<TrunkForm>(emptyTrunk)
  const [editing, setEditing] = useState<Trunk | null>(null)
  const [problems, setProblems] = useState<Problems<TrunkField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [operator, setOperator] = useState<OperatorStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [operatorNote, setOperatorNote] = useState<Note>(null)

  // Only the answer to the last read is shown: one asked by the button never comes after a later one.
  const asked = useRef(0)
  const readStatus = useCallback(() => {
    const n = ++asked.current
    const show = (s: { available: boolean; items: TrunkStatus[] }) => {
      if (n === asked.current) setStatus(s)
    }
    // Its operator (step 10b) with it: what is set at the lines, what became of the records (read from the Gateway's
    // memory and base, never from the operator).
    const operatorRead = client.getOperatorStatus().then(
      o => {
        if (n === asked.current) setOperator(o)
      },
      () => undefined
    )
    return Promise.all([client.getTrunkStatus().then(show, () => show({ available: false, items: [] })), operatorRead]).then(() => undefined)
  }, [client])
  const load = useCallback(() => {
    client.listTrunks().then(
      r => setTrunks(r.items),
      (err: unknown) => {
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: t('admin.loadError') })
      }
    )
  }, [client, t])
  useEffect(load, [load])
  // The state of the trunks: read at once, then again after each answer while shown.
  useRefresh(readStatus, STATUS_POLL_MS, !unavailable, true)

  const set = <K extends keyof TrunkForm>(key: K) => (value: TrunkForm[K]) => setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptyTrunk())
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkTrunk(form, { ...(editing ? { current: editing } : {}), ids: (trunks ?? []).map(x => x.id) })
    setProblems(checked.problems)
    if (!checked.input) {
      focusLater(TRUNK_FIELDS, checked.problems, 'trunk')
      return
    }
    setBusy(true)
    try {
      const saved = await client.setTrunk(form.id.trim(), checked.input)
      setNote({ kind: 'ok', text: t('admin.trunk.saved', { id: saved.id }) })
      reset()
      load()
      void readStatus()
    } catch (err) {
      const refusal = trunkRefusal(err)
      // Gone meanwhile (another administrator removed it): the list shown is read again.
      if (refusalStatus(err) === 404) load()
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(TRUNK_FIELDS, next, 'trunk')
      }
    } finally {
      setBusy(false)
    }
  }

  const syncOperator = async () => {
    setOperatorNote(null)
    setSyncing(true)
    try {
      ++asked.current
      setOperator(await client.syncOperator())
      setOperatorNote({ kind: 'ok', text: t('admin.operator.synced') })
    } catch (err) {
      setOperatorNote({ kind: 'error', text: say(trunkRefusal(err).problem)! })
    } finally {
      setSyncing(false)
    }
  }

  const edit = (trunk: Trunk) => {
    setNote(null)
    setProblems({})
    setEditing(trunk)
    setForm(trunkForm(trunk))
    // The form is below the list: the focus goes to its first field the administrator can change.
    setTimeout(() => document.getElementById('trunk-name')?.focus(), 0)
  }

  const remove = async (trunk: Trunk) => {
    setNote(null)
    setBusy(true)
    try {
      await client.deleteTrunk(trunk.id)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({ kind: 'ok', text: t('admin.trunk.deleted', { id: trunk.id }), focus: true })
      if (editing?.id === trunk.id) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(trunkRefusal(err).problem)!, focus: true })
    } finally {
      setBusy(false)
      load()
      void readStatus()
    }
  }

  if (unavailable)
    return (
      <Section id="trunks" title={t('admin.nav.trunks')}>
        <p className="alert">{t('admin.trunk.unavailable')}</p>
      </Section>
    )

  const field = (key: TrunkField) => say(problems[key])
  const def = defaultOf(trunks ?? [])
  const isCurrentDefault = !!editing && def?.id === editing.id
  const count = Object.keys(problems).length
  const classLabel = (c: string) => t(`admin.class.${c}` as Key)
  return (
    <>
      <Section id="trunks" title={t('admin.nav.trunks')}>
        <p>{t('admin.trunk.help')}</p>
        {trunks === null ? null : trunks.length ? (
          <ul className="list admin-list" aria-label={t('admin.trunk.list')}>
            {trunks.map(trunk => (
              <li key={trunk.id}>
                <div>
                  <h3>
                    {trunk.name ? `${trunk.name} (${trunk.id})` : trunk.id}
                    {def?.id === trunk.id ? <span className="badge"> · {t('admin.trunk.isDefault')}</span> : null}
                  </h3>
                  <dl className="facts facts-compact">
                    <div>
                      <dt>{t('admin.trunk.auth')}</dt>
                      <dd>{t(trunk.auth === 'register' ? 'admin.trunk.authRegister' : 'admin.trunk.authIp')}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.trunk.domain')}</dt>
                      <dd>{trunk.domain}</dd>
                    </div>
                    {trunk.proxies?.length ? (
                      <div>
                        <dt>{t('admin.trunk.proxies')}</dt>
                        <dd>{trunk.proxies.join(', ')}</dd>
                      </div>
                    ) : null}
                    {trunk.username ? (
                      <div>
                        <dt>{t('admin.trunk.username')}</dt>
                        <dd>{trunk.username}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>{t('admin.trunk.password')}</dt>
                      <dd>{t(trunk.hasPassword ? 'admin.trunk.passwordKept' : 'admin.trunk.passwordNone')}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.trunk.defaultNumber')}</dt>
                      <dd>{trunk.defaultNumber}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.trunk.allowed')}</dt>
                      <dd>
                        {(trunk.allowed ?? []).map(classLabel).join(', ') || t('admin.trunk.allowedDefault')}
                        {trunk.countries?.length ? ` (${trunk.countries.map(c => `+${c}`).join(', ')})` : ''}
                      </dd>
                    </div>
                    {trunk.fallbackTarget ? (
                      <div>
                        <dt>{t('admin.trunk.fallbackTarget')}</dt>
                        <dd>{targetLabel(targets, trunk.fallbackTarget)}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <TrunkState status={status.items.find(s => s.id === trunk.id)} available={status.available} />
                  {operator?.trunks?.find(o => o.id === trunk.id)?.lines.length ? <OperatorLines lines={operator.trunks.find(o => o.id === trunk.id)!.lines} /> : null}
                </div>
                <div className="actions actions-end">
                  <button type="button" className="btn" onClick={() => edit(trunk)} disabled={busy} aria-label={t('admin.trunk.edit', { id: trunk.id })}>
                    {t('admin.edit')}
                  </button>
                  <ConfirmDelete label={t('admin.trunk.delete', { id: trunk.id })} question={t('admin.trunk.deleteConfirm', { id: trunk.id })} onConfirm={() => void remove(trunk)} disabled={busy} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('admin.trunk.none')}</p>
        )}
        <p>
          <button type="button" className="btn" onClick={() => void readStatus()}>
            {t('admin.trunk.refresh')}
          </button>
        </p>
      </Section>
      <Section id="trunk-form" title={editing ? t('admin.trunk.edit', { id: editing.id }) : t('admin.trunk.new')}>
        <form onSubmit={e => void save(e)} noValidate aria-labelledby="trunk-form">
          <ProblemSummary count={count} />
          <TextField id="trunk-id" label={t('admin.trunk.id')} hint={t('admin.slugHint')} value={form.id} onChange={set('id')} error={field('id')} required disabled={busy || !!editing} maxLength={32} />
          <TextField id="trunk-name" label={t('admin.trunk.name')} value={form.name} onChange={set('name')} error={field('name')} disabled={busy} maxLength={64} />
          <fieldset className="field">
            <legend>{t('admin.trunk.auth')}</legend>
            {(['register', 'ip'] as const).map(a => (
              <label key={a} className="check">
                <input type="radio" name="trunk-auth" value={a} checked={form.auth === a} onChange={() => set('auth')(a)} disabled={busy} /> {t(a === 'register' ? 'admin.trunk.authRegister' : 'admin.trunk.authIp')}
              </label>
            ))}
          </fieldset>
          <TextField id="trunk-domain" label={t('admin.trunk.domain')} hint={t('admin.trunk.domainHint')} value={form.domain} onChange={set('domain')} error={field('domain')} required disabled={busy} maxLength={253} />
          <TextField id="trunk-proxies" label={t('admin.trunk.proxies')} hint={t('admin.trunk.proxiesHint')} value={form.proxies} onChange={set('proxies')} error={field('proxies')} disabled={busy} />
          <TextField id="trunk-sources" label={t('admin.trunk.sources')} hint={t('admin.trunk.sourcesHint')} value={form.sources} onChange={set('sources')} error={field('sources')} disabled={busy} />
          <TextField id="trunk-username" label={t('admin.trunk.username')} value={form.username} onChange={set('username')} error={field('username')} required={form.auth === 'register'} disabled={busy} maxLength={64} />
          <TextField
            id="trunk-password"
            type="password"
            autoComplete="new-password"
            label={t('admin.trunk.password')}
            hint={t(editing?.hasPassword ? 'admin.trunk.passwordKeepHint' : 'admin.trunk.passwordHint')}
            value={form.password}
            onChange={set('password')}
            error={field('password')}
            disabled={busy || form.removePassword}
            maxLength={64}
          />
          {editing?.hasPassword ? <CheckBox id="trunk-remove-password" label={t('admin.trunk.removePassword')} checked={form.removePassword} onChange={v => setForm(f => ({ ...f, removePassword: v, ...(v ? { password: '' } : {}) }))} disabled={busy} /> : null}
          <TextField id="trunk-realm" label={t('admin.trunk.realm')} hint={t('admin.trunk.realmHint')} value={form.realm} onChange={set('realm')} error={field('realm')} disabled={busy} maxLength={128} />
          <TextField id="trunk-registrar" label={t('admin.trunk.registrar')} hint={t('admin.trunk.registrarHint')} value={form.registrar} onChange={set('registrar')} error={field('registrar')} disabled={busy || form.auth !== 'register'} />
          <TextField id="trunk-registerExpires" label={t('admin.trunk.registerExpires')} hint={t('admin.trunk.registerExpiresHint')} inputMode="numeric" value={form.registerExpires} onChange={set('registerExpires')} error={field('registerExpires')} disabled={busy || form.auth !== 'register'} maxLength={4} />
          <CheckGroup id="trunk-codecs" legend={t('admin.trunk.codecs')} hint={t('admin.trunk.codecsHint')} values={TRUNK_CODECS} chosen={form.codecs} label={c => c} onChange={set('codecs')} error={field('codecs')} disabled={busy} />
          <SelectField id="trunk-numberFormat" label={t('admin.trunk.numberFormat')} value={form.numberFormat} onChange={v => set('numberFormat')(v as TrunkNumberFormat)} options={FORMATS.map(f => ({ value: f, label: t(`admin.trunk.format.${f}` as Key) }))} disabled={busy} />
          <CheckBox id="trunk-assertIdentity" label={t('admin.trunk.assertIdentity')} checked={form.assertIdentity} onChange={set('assertIdentity')} disabled={busy} />
          <TextField id="trunk-defaultNumber" label={t('admin.trunk.defaultNumber')} hint={t('admin.trunk.defaultNumberHint')} type="tel" inputMode="tel" value={form.defaultNumber} onChange={set('defaultNumber')} error={field('defaultNumber')} required disabled={busy} maxLength={24} />
          <CheckGroup id="trunk-allowed" legend={t('admin.trunk.allowed')} hint={t('admin.trunk.allowedHint')} values={TRUNK_OUTBOUND_CLASSES} chosen={form.allowed} label={classLabel} onChange={set('allowed')} error={field('allowed')} disabled={busy} />
          <TextField id="trunk-countries" label={t('admin.trunk.countries')} hint={t('admin.trunk.countriesHint')} inputMode="numeric" value={form.countries} onChange={set('countries')} error={field('countries')} disabled={busy} />
          <CheckBox
            id="trunk-default"
            label={t('admin.trunk.default')}
            hint={t(isCurrentDefault ? 'admin.trunk.defaultCurrentHint' : 'admin.trunk.defaultHint')}
            checked={form.isDefault || isCurrentDefault}
            onChange={set('isDefault')}
            disabled={busy || isCurrentDefault}
          />
          <TextField id="trunk-fallbackTarget" label={t('admin.trunk.fallbackTarget')} hint={t('admin.trunk.fallbackTargetHint')} inputMode="numeric" value={form.fallbackTarget} onChange={set('fallbackTarget')} error={field('fallbackTarget')} disabled={busy} maxLength={6} list="trunk-targets" />
          <TargetList id="trunk-targets" targets={targets} />
          <fieldset className="field">
            <legend>{t('admin.trunk.operator')}</legend>
            <TextField id="trunk-operatorLines" label={t('admin.trunk.operatorLines')} hint={t('admin.trunk.operatorLinesHint')} value={form.operatorLines} onChange={set('operatorLines')} error={field('operatorLines')} disabled={busy} />
            <CheckBox
              id="trunk-fallbackManaged"
              label={t('admin.trunk.fallbackManaged')}
              hint={t(operator?.configured ? 'admin.trunk.fallbackManagedHint' : 'admin.trunk.fallbackManagedNone')}
              checked={form.fallbackManaged}
              onChange={set('fallbackManaged')}
              // Without an operator the Gateway refuses it; one kept from before can still be let go.
              disabled={busy || (!operator?.configured && !form.fallbackManaged)}
            />
            {form.fallbackManaged ? (
              <>
                <TextField id="trunk-operatorNumber" label={t('admin.trunk.operatorNumber')} hint={t('admin.trunk.operatorNumberHint')} type="tel" inputMode="tel" value={form.operatorNumber} onChange={set('operatorNumber')} error={field('operatorNumber')} disabled={busy} maxLength={24} />
                <CheckBox id="trunk-onUnavailable" label={t('admin.trunk.onUnavailable')} hint={t('admin.trunk.onUnavailableHint')} checked={form.onUnavailable} onChange={set('onUnavailable')} disabled={busy} />
                <CheckBox id="trunk-onNoAnswer" label={t('admin.trunk.onNoAnswer')} checked={form.onNoAnswer} onChange={set('onNoAnswer')} disabled={busy} />
                <TextField id="trunk-noAnswerAfterSec" label={t('admin.trunk.noAnswerAfterSec')} hint={t('admin.trunk.noAnswerAfterSecHint')} inputMode="numeric" value={form.noAnswerAfterSec} onChange={set('noAnswerAfterSec')} error={field('noAnswerAfterSec')} disabled={busy || !form.onNoAnswer} maxLength={3} />
              </>
            ) : null}
          </fieldset>
          <div className="actions actions-start">
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
              {t('admin.trunk.save')}
            </button>
            {editing ? (
              <button type="button" className="btn" onClick={reset} disabled={busy}>
                {t('admin.cancel')}
              </button>
            ) : null}
          </div>
        </form>
        <NoteLine note={note} />
      </Section>
      {operator?.configured ? (
        <Section id="operator" title={t('admin.operator.title')}>
          <OperatorRecords status={operator} onSync={() => void syncOperator()} busy={syncing} />
          <NoteLine note={operatorNote} />
        </Section>
      ) : null}
    </>
  )
}
