import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { DidRange, Trunk } from '@twake/telephony-client'
import { TargetList } from '../../admin/TargetList.js'
import { targetLabel, useTargets } from '../../admin/targets.js'
import { ConfirmDelete, NoteLine, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { DID_FIELDS, checkDid, didForm, didRefusal, emptyDid, type DidField, type DidForm, type Problems } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/**
 * The direct numbers (step 7, FR-D2): one number or a range of them, the trunk they come in by, and where their calls
 * ring (an extension or a group, or the extension the last digits name), with a fallback of their own if wanted.
 */
export const Numbers = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const targets = useTargets(client)
  const [dids, setDids] = useState<DidRange[] | null>(null)
  const [trunks, setTrunks] = useState<Trunk[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<DidForm>(() => emptyDid())
  const [editing, setEditing] = useState<DidRange | null>(null)
  const [problems, setProblems] = useState<Problems<DidField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)

  const load = useCallback(() => {
    Promise.all([client.listDids(), client.listTrunks()]).then(
      ([d, tr]) => {
        setDids(d.items)
        setTrunks(tr.items)
        // A new range comes in by the first trunk, unless another one is chosen.
        setForm(f => (f.trunkId || !tr.items[0] ? f : { ...f, trunkId: tr.items[0].id }))
      },
      (err: unknown) => {
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: t('admin.loadError') })
      }
    )
  }, [client, t])
  useEffect(load, [load])

  const set = <K extends keyof DidForm>(key: K) => (value: DidForm[K]) => setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptyDid(trunks[0]?.id ?? ''))
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkDid(form, { isNew: !editing, trunks, others: dids ?? [] })
    setProblems(checked.problems)
    if (!checked.range) {
      focusLater(DID_FIELDS, checked.problems, 'did')
      return
    }
    setBusy(true)
    try {
      const saved = await client.setDid(checked.range)
      setNote({ kind: 'ok', text: t('admin.did.saved', { id: saved.id }) })
      reset()
      load()
    } catch (err) {
      const refusal = didRefusal(err)
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(DID_FIELDS, next, 'did')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (range: DidRange) => {
    setNote(null)
    setProblems({})
    setEditing(range)
    setForm(didForm(range))
    setTimeout(() => document.getElementById('did-trunkId')?.focus(), 0)
  }

  const remove = async (range: DidRange) => {
    setNote(null)
    setBusy(true)
    try {
      await client.deleteDid(range.id)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({ kind: 'ok', text: t('admin.did.deleted', { id: range.id }), focus: true })
      if (editing?.id === range.id) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(didRefusal(err).problem)!, focus: true })
    } finally {
      setBusy(false)
      load()
    }
  }

  if (unavailable)
    return (
      <Section id="numbers" title={t('admin.nav.numbers')}>
        <p className="alert">{t('admin.trunk.unavailable')}</p>
      </Section>
    )

  const field = (key: DidField) => say(problems[key])
  const count = Object.keys(problems).length
  const numbers = (r: DidRange) => (r.first === r.last ? r.first : t('admin.did.range', { first: r.first, last: r.last }))
  const trunkName = (id: string) => {
    const trunk = trunks.find(x => x.id === id)
    return trunk?.name ? `${trunk.name} (${id})` : id
  }
  return (
    <>
      <Section id="numbers" title={t('admin.nav.numbers')}>
        <p>{t('admin.did.help')}</p>
        {dids === null ? null : dids.length ? (
          <ul className="list admin-list" aria-label={t('admin.did.list')}>
            {dids.map(range => (
              <li key={range.id}>
                <div>
                  <h3>{numbers(range)}</h3>
                  <dl className="facts facts-compact">
                    <div>
                      <dt>{t('admin.did.id')}</dt>
                      <dd>{range.id}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.did.trunkId')}</dt>
                      <dd>{trunkName(range.trunkId)}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.did.rings')}</dt>
                      <dd>{range.suffixDigits ? t('admin.did.ringsSuffix', { digits: range.suffixDigits }) : targetLabel(targets, range.target ?? '')}</dd>
                    </div>
                    {range.fallbackTarget ? (
                      <div>
                        <dt>{t('admin.did.fallbackTarget')}</dt>
                        <dd>{targetLabel(targets, range.fallbackTarget)}</dd>
                      </div>
                    ) : null}
                  </dl>
                </div>
                <div className="actions actions-end">
                  <button type="button" className="btn" onClick={() => edit(range)} disabled={busy} aria-label={t('admin.did.edit', { id: range.id })}>
                    {t('admin.edit')}
                  </button>
                  <ConfirmDelete label={t('admin.did.delete', { id: range.id })} question={t('admin.did.deleteConfirm', { id: range.id })} onConfirm={() => void remove(range)} disabled={busy} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('admin.did.none')}</p>
        )}
      </Section>
      <Section id="did-form" title={editing ? t('admin.did.edit', { id: editing.id }) : t('admin.did.new')}>
        {dids !== null && !trunks.length ? (
          <p className="alert">{t('admin.did.noTrunk')}</p>
        ) : (
          <form onSubmit={e => void save(e)} noValidate aria-labelledby="did-form">
            <ProblemSummary count={count} />
            <TextField id="did-id" label={t('admin.did.id')} hint={t('admin.slugHint')} value={form.id} onChange={set('id')} error={field('id')} required disabled={busy || !!editing} maxLength={32} />
            <SelectField id="did-trunkId" label={t('admin.did.trunkId')} value={form.trunkId} onChange={set('trunkId')} options={trunks.map(x => ({ value: x.id, label: trunkName(x.id) }))} error={field('trunkId')} disabled={busy} />
            <TextField id="did-first" label={t('admin.did.first')} hint={t('admin.did.firstHint')} type="tel" inputMode="tel" value={form.first} onChange={set('first')} error={field('first')} required disabled={busy} maxLength={24} />
            <TextField id="did-last" label={t('admin.did.last')} hint={t('admin.did.lastHint')} type="tel" inputMode="tel" value={form.last} onChange={set('last')} error={field('last')} disabled={busy} maxLength={24} />
            <fieldset className="field">
              <legend>{t('admin.did.rings')}</legend>
              {(['target', 'suffix'] as const).map(m => (
                <label key={m} className="check">
                  <input type="radio" name="did-mode" value={m} checked={form.mode === m} onChange={() => set('mode')(m)} disabled={busy} /> {t(m === 'target' ? 'admin.did.modeTarget' : 'admin.did.modeSuffix')}
                </label>
              ))}
            </fieldset>
            {form.mode === 'target' ? (
              <TextField id="did-target" label={t('admin.did.target')} hint={t('admin.did.targetHint')} inputMode="numeric" value={form.target} onChange={set('target')} error={field('target')} required disabled={busy} maxLength={6} list="did-targets" />
            ) : (
              <TextField id="did-suffixDigits" label={t('admin.did.suffixDigits')} hint={t('admin.did.suffixDigitsHint')} inputMode="numeric" value={form.suffixDigits} onChange={set('suffixDigits')} error={field('suffixDigits')} required disabled={busy} maxLength={1} />
            )}
            <TextField id="did-fallbackTarget" label={t('admin.did.fallbackTarget')} hint={t('admin.did.fallbackTargetHint')} inputMode="numeric" value={form.fallbackTarget} onChange={set('fallbackTarget')} error={field('fallbackTarget')} disabled={busy} maxLength={6} list="did-targets" />
            <TargetList id="did-targets" targets={targets} />
            <div className="actions actions-start">
              <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
                {t('admin.did.save')}
              </button>
              {editing ? (
                <button type="button" className="btn" onClick={reset} disabled={busy}>
                  {t('admin.cancel')}
                </button>
              ) : null}
            </div>
          </form>
        )}
        <NoteLine note={note} />
      </Section>
    </>
  )
}
