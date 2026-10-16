import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { FRAUD_PARAMS, OUTBOUND_CAPS, type FraudRule, type OutboundSettings } from '@twake/telephony-client'
import { CapFields } from '../../admin/CapFields.js'
import { FieldError, NoteLine, useLatest, ProblemSummary, Section, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { LIMITS_FIELDS, capsForm, checkCaps, checkFraud, fraudForm, limitsRefusal, refusalCode, sameValue, type CapForm, type CapsForm, type FraudForm, type FraudParam, type LimitsField, type Problem, type ThresholdForm } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status
type Zone = 'national' | 'international'

interface LimitsForm {
  tenant: CapsForm
  user: CapsForm
  national: FraudForm
  international: FraudForm
}
const limitsForm = (s: OutboundSettings): LimitsForm => ({ tenant: capsForm(s.policy.caps), user: capsForm(s.policy.userCaps), national: fraudForm(s.policy.fraud?.national), international: fraudForm(s.policy.fraud?.international) })

const PARTS = [
  ['tenant', 'admin.limits.tenant'],
  ['user', 'admin.limits.user'],
  ['national', 'admin.fraud.national'],
  ['international', 'admin.fraud.international']
] as const
type Typed = { legend: Key; name: Key } & ({ cap: CapForm } | { threshold: ThresholdForm })
/** The caps and thresholds typed in `typed` that are not those of `read`: where, and what was typed. */
const typedOf = (read: LimitsForm, typed: LimitsForm): Typed[] =>
  PARTS.flatMap(([part, legend]): Typed[] =>
    part === 'tenant' || part === 'user'
      ? OUTBOUND_CAPS.filter(k => !sameValue(read[part][k], typed[part][k])).map(k => ({ legend, name: `admin.cap.${k}` as Key, cap: typed[part][k] }))
      : FRAUD_PARAMS.filter(k => !sameValue(read[part][k], typed[part][k])).map(k => ({ legend, name: `admin.fraud.${k}` as Key, threshold: typed[part][k] }))
  )

/** The problems of one part of the form (`tenant`, `national`…), by cap or threshold. */
const partOf = (problems: Partial<Record<LimitsField, Problem>>, part: string) =>
  Object.fromEntries(
    Object.entries(problems)
      .filter(([k]) => k.startsWith(`${part}-`))
      .map(([k, v]) => [k.slice(part.length + 1), v])
  ) as Partial<Record<string, Problem>>

/** The thresholds of one zone, one row each: the default (said with its values) or set (an empty level: none). */
const FraudFields = ({ zone, form, defaults, problems, onChange, disabled }: { zone: Zone; form: FraudForm; defaults: FraudRule; problems: Partial<Record<string, Problem>>; onChange: (next: FraudForm) => void; disabled?: boolean }) => {
  const { t } = useT()
  const say = useProblem()
  const set = (k: FraudParam, next: Partial<ThresholdForm>) => onChange({ ...form, [k]: { ...form[k], ...next } })
  const level = (v: number | undefined) => (v ? String(v) : t('admin.fraud.noLevel'))
  return (
    <fieldset className="field caps" aria-describedby={`limits-${zone}-hint`}>
      <legend>{t(zone === 'national' ? 'admin.fraud.national' : 'admin.fraud.international')}</legend>
      <span id={`limits-${zone}-hint`} className="badge">
        {t(zone === 'national' ? 'admin.fraud.nationalHint' : 'admin.fraud.internationalHint')}
      </span>
      {FRAUD_PARAMS.map(k => {
        const f = form[k]
        const id = `limits-${zone}-${k}`
        const error = say(problems[k])
        const name = t(`admin.fraud.${k}` as Key)
        const def = defaults[k]
        return (
          <div key={k} className="cap-row">
            <label htmlFor={`${id}-mode`}>{name}</label>
            <select id={`${id}-mode`} value={f.mode} onChange={e => set(k, { mode: e.target.value as ThresholdForm['mode'] })} disabled={disabled}>
              <option value="default">{t('admin.fraud.default', { warning: level(def?.warning), critical: level(def?.critical) })}</option>
              <option value="custom">{t('admin.fraud.custom')}</option>
            </select>
            {f.mode === 'custom' ? (
              <span className="levels">
                <input
                  id={id}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={7}
                  value={f.warning}
                  onChange={e => set(k, { warning: e.target.value })}
                  disabled={disabled}
                  aria-label={t('admin.fraud.warningOf', { name })}
                  placeholder={t('admin.fraud.warning')}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-error` : undefined}
                />
                <input
                  id={`${id}-critical`}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={7}
                  value={f.critical}
                  onChange={e => set(k, { critical: e.target.value })}
                  disabled={disabled}
                  aria-label={t('admin.fraud.criticalOf', { name })}
                  placeholder={t('admin.fraud.critical')}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-error` : undefined}
                />
              </span>
            ) : null}
            <FieldError id={id} error={error} />
          </div>
        )
      })}
    </fieldset>
  )
}

/**
 * The caps of the organisation and of those without a profile, and the volume thresholds that raise an alert or refuse
 * a call (step 7, FR-D6; ADR 0017). Absent: the default, said next to each one.
 */
export const Limits = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const words = useLatest(t)
  const [settings, setSettings] = useState<OutboundSettings | null>(null)
  const [form, setForm] = useState<LimitsForm | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [problems, setProblems] = useState<Partial<Record<LimitsField, Problem>>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)

  const show = useCallback((s: OutboundSettings) => {
    setSettings(s)
    setForm(limitsForm(s))
  }, [])
  const read = useCallback(() => {
    client.getOutbound().then(show, (err: unknown) => {
      if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
      else setNote({ kind: 'error', text: words.current('admin.loadError') })
    })
  }, [client, show, words])
  useEffect(read, [read])
  /** What was typed for a cap, or for a threshold, in words. */
  const capText = (c: CapForm) => (c.mode === 'value' ? c.value : t(c.mode === 'none' ? 'admin.cap.none' : 'admin.limits.typedDefault'))
  const thresholdText = (x: ThresholdForm) => (x.mode === 'custom' ? `${t('admin.fraud.warning')} ${x.warning || '—'}, ${t('admin.fraud.critical')} ${x.critical || '—'}` : t('admin.limits.typedDefault'))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!settings || !form) return
    setNote(null)
    const tenant = checkCaps(form.tenant)
    const user = checkCaps(form.user)
    const national = checkFraud(form.national)
    const international = checkFraud(form.international)
    const found: Partial<Record<LimitsField, Problem>> = {}
    for (const [part, r] of [
      ['tenant', tenant],
      ['user', user],
      ['national', national],
      ['international', international]
    ] as const)
      for (const [k, v] of Object.entries(r.problems)) found[`${part}-${k}` as LimitsField] = v
    setProblems(found)
    if (Object.keys(found).length) {
      focusLater(LIMITS_FIELDS, found, 'limits')
      return
    }
    const { caps: _c, userCaps: _u, fraud: _f, ...rest } = settings.policy
    const policy = {
      ...rest,
      ...(tenant.caps ? { caps: tenant.caps } : {}),
      ...(user.caps ? { userCaps: user.caps } : {}),
      ...(national.rule || international.rule ? { fraud: { ...(national.rule ? { national: national.rule } : {}), ...(international.rule ? { international: international.rule } : {}) } } : {})
    }
    setBusy(true)
    try {
      // With the version read: refused when another administrator changed the setting since (review 7 n°1).
      show(await client.setOutbound({ policy, profiles: settings.profiles, assignments: settings.assignments, version: settings.version }))
      setNote({ kind: 'ok', text: t('admin.limits.saved') })
    } catch (err) {
      // Changed meanwhile: the form shows the setting as it is now (the next save made from it, nothing typed before
      // sent with its version), and says what was typed, to be done again if still wanted (review 7 ter, n°2).
      if (refusalCode(err) === 'OUTBOUND_STALE') {
        setProblems({})
        const typed = typedOf(limitsForm(settings), form)
        read()
        const said = typed.map(x => `${t(x.legend)} : ${t(x.name)} = ${'cap' in x ? capText(x.cap) : thresholdText(x.threshold)}`).join(' ; ')
        setNote({ kind: 'error', text: said ? t('admin.limits.stale', { typed: said }) : say(limitsRefusal(err).problem)! })
        return
      }
      const refusal = limitsRefusal(err)
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(LIMITS_FIELDS, next, 'limits')
      }
    } finally {
      setBusy(false)
    }
  }

  if (unavailable)
    return (
      <Section id="limits" title={t('admin.nav.limits')}>
        <p className="alert">{t('admin.rights.unavailable')}</p>
      </Section>
    )
  if (!settings || !form)
    return (
      <Section id="limits" title={t('admin.nav.limits')}>
        <NoteLine note={note ?? { kind: 'ok', text: t('admin.loading') }} />
      </Section>
    )
  return (
    <Section id="limits" title={t('admin.nav.limits')}>
      <p>{t('admin.limits.help')}</p>
      <form onSubmit={e => void save(e)} noValidate aria-labelledby="limits">
        <ProblemSummary count={Object.keys(problems).length} />
        <CapFields prefix="limits-tenant" legend={t('admin.limits.tenant')} hint={t('admin.limits.tenantHint')} caps={form.tenant} defaults={settings.defaults.caps.tenant} problems={partOf(problems, 'tenant')} onChange={tenant => setForm(f => f && { ...f, tenant })} disabled={busy} />
        <CapFields prefix="limits-user" legend={t('admin.limits.user')} hint={t('admin.limits.userHint')} caps={form.user} defaults={settings.defaults.caps.user} problems={partOf(problems, 'user')} onChange={user => setForm(f => f && { ...f, user })} disabled={busy} />
        <FraudFields zone="national" form={form.national} defaults={settings.defaults.fraud.national} problems={partOf(problems, 'national')} onChange={national => setForm(f => f && { ...f, national })} disabled={busy} />
        <FraudFields zone="international" form={form.international} defaults={settings.defaults.fraud.international} problems={partOf(problems, 'international')} onChange={international => setForm(f => f && { ...f, international })} disabled={busy} />
        <div className="actions actions-start">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {t('admin.limits.save')}
          </button>
        </div>
      </form>
      <NoteLine note={note} />
    </Section>
  )
}
