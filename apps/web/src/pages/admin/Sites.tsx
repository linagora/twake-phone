import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AdminUser, EmergencySite, Trunk } from '@twake/telephony-client'
import { CheckGroup, ConfirmDelete, NoteLine, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { SITE_FIELDS, checkSite, emptySite, refusalStatus, siteForm, siteRefusal, type Problems, type SiteField, type SiteForm } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/**
 * The sites (step 6c, ADR 0024): where the organisation's people are for the emergency services. A site has an address,
 * a trunk and the number of that trunk its people present when they call an emergency number, and those people (one
 * site each).
 */
export const Sites = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const [sites, setSites] = useState<EmergencySite[] | null>(null)
  const [trunks, setTrunks] = useState<Trunk[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<SiteForm>(() => emptySite())
  const [editing, setEditing] = useState<EmergencySite | null>(null)
  const [problems, setProblems] = useState<Problems<SiteField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)

  const load = useCallback(() => {
    Promise.all([client.listSites(), client.listTrunks(), client.listAdminUsers()]).then(
      ([s, tr, u]) => {
        setSites(s.items)
        setTrunks(tr.items)
        setUsers(u.items)
        // A new site is on the first trunk, unless another one is chosen.
        setForm(f => (f.trunkId || !tr.items[0] ? f : { ...f, trunkId: tr.items[0].id }))
      },
      (err: unknown) => {
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: t('admin.loadError') })
      }
    )
  }, [client, t])
  useEffect(load, [load])

  const set = <K extends keyof SiteForm>(key: K) => (value: SiteForm[K]) => setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptySite(trunks[0]?.id ?? ''))
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkSite(form, { isNew: !editing, trunks, others: sites ?? [] })
    setProblems(checked.problems)
    if (!checked.site) {
      focusLater(SITE_FIELDS, checked.problems, 'site')
      return
    }
    setBusy(true)
    try {
      const saved = await client.setSite(checked.site)
      setNote({ kind: 'ok', text: t('admin.site.saved', { id: saved.id }) })
      reset()
      load()
    } catch (err) {
      const refusal = siteRefusal(err)
      // Gone meanwhile (another administrator removed it): the list shown is read again.
      if (refusalStatus(err) === 404) load()
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(SITE_FIELDS, next, 'site')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (site: EmergencySite) => {
    setNote(null)
    setProblems({})
    setEditing(site)
    setForm(siteForm(site))
    setTimeout(() => document.getElementById('site-name')?.focus(), 0)
  }

  const remove = async (site: EmergencySite) => {
    setNote(null)
    setBusy(true)
    try {
      await client.deleteSite(site.id)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({ kind: 'ok', text: t('admin.site.deleted', { id: site.id }), focus: true })
      if (editing?.id === site.id) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(siteRefusal(err).problem)!, focus: true })
    } finally {
      setBusy(false)
      load()
    }
  }

  if (unavailable)
    return (
      <Section id="sites" title={t('admin.nav.sites')}>
        <p className="alert">{t('admin.trunk.unavailable')}</p>
      </Section>
    )

  const field = (key: SiteField) => say(problems[key])
  const count = Object.keys(problems).length
  const trunkName = (id: string) => {
    const trunk = trunks.find(x => x.id === id)
    return trunk?.name ? `${trunk.name} (${id})` : id
  }
  const person = (userId: string) => {
    const u = users.find(x => x.userId === userId)
    return u ? t('admin.site.person', { name: u.displayName ?? u.userId, extension: u.extension }) : userId
  }
  return (
    <>
      <Section id="sites" title={t('admin.nav.sites')}>
        <p>{t('admin.site.help')}</p>
        {sites === null ? null : sites.length ? (
          <ul className="list admin-list" aria-label={t('admin.site.list')}>
            {sites.map(site => (
              <li key={site.id}>
                <div>
                  <h3>{site.name}</h3>
                  <dl className="facts facts-compact">
                    <div>
                      <dt>{t('admin.site.id')}</dt>
                      <dd>{site.id}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.site.address')}</dt>
                      <dd>{site.address}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.site.trunkId')}</dt>
                      <dd>{trunkName(site.trunkId)}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.site.number')}</dt>
                      <dd>{site.number}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.site.members')}</dt>
                      <dd>{t('admin.site.membersCount', { count: site.members.length })}</dd>
                    </div>
                  </dl>
                </div>
                <div className="actions actions-end">
                  <button type="button" className="btn" onClick={() => edit(site)} disabled={busy} aria-label={t('admin.site.edit', { id: site.id })}>
                    {t('admin.edit')}
                  </button>
                  <ConfirmDelete label={t('admin.site.delete', { id: site.id })} question={t('admin.site.deleteConfirm', { id: site.id })} onConfirm={() => void remove(site)} disabled={busy} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('admin.site.none')}</p>
        )}
      </Section>
      <Section id="site-form" title={editing ? t('admin.site.edit', { id: editing.id }) : t('admin.site.new')}>
        {sites !== null && !trunks.length ? (
          <p className="alert">{t('admin.site.noTrunk')}</p>
        ) : (
          <form onSubmit={e => void save(e)} noValidate aria-labelledby="site-form">
            <ProblemSummary count={count} />
            <TextField id="site-id" label={t('admin.site.id')} hint={t('admin.slugHint')} value={form.id} onChange={set('id')} error={field('id')} required disabled={busy || !!editing} maxLength={32} />
            <TextField id="site-name" label={t('admin.site.name')} value={form.name} onChange={set('name')} error={field('name')} required disabled={busy} maxLength={64} />
            <TextField id="site-address" label={t('admin.site.address')} hint={t('admin.site.addressHint')} autoComplete="street-address" value={form.address} onChange={set('address')} error={field('address')} required disabled={busy} maxLength={200} />
            <SelectField id="site-trunkId" label={t('admin.site.trunkId')} value={form.trunkId} onChange={set('trunkId')} options={trunks.map(x => ({ value: x.id, label: trunkName(x.id) }))} error={field('trunkId')} disabled={busy} />
            <TextField id="site-number" label={t('admin.site.number')} hint={t('admin.site.numberHint')} type="tel" inputMode="tel" value={form.number} onChange={set('number')} error={field('number')} required disabled={busy} maxLength={24} />
            {users.length ? (
              <CheckGroup id="site-members" legend={t('admin.site.members')} hint={t('admin.site.membersHint')} values={users.map(u => u.userId)} chosen={form.members} label={person} onChange={set('members')} error={field('members')} disabled={busy} />
            ) : (
              <p className="muted">{t('admin.site.noUsers')}</p>
            )}
            <div className="actions actions-start">
              <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
                {t('admin.site.save')}
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
